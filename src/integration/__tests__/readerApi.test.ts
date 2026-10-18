import { strict as assert } from 'node:assert';
import { before, after, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { startTestServer, createTestAdminUser, prisma, config, TestServer } from './helpers/authoringTestApp';
import { installFakeElevenLabsFetch } from './helpers/fakeElevenLabsFetch';
import { saveContentRevision } from '../../lib/textWorkspaces';
import { runGenerateNarrationJob } from '../../lib/textAudioPipeline';
import { setSelection, setTranslations } from '../../lib/textVocabulary';
import { readAudioAssetRange, writeAudioAsset } from '../../lib/audioAssetStorage';
import { decodeWav } from '../../lib/pcmWav';
import { prepareLegacyClips } from './helpers/legacyClips';

// Explicit synthetic ElevenLabs provider mock. No external network or paid calls.
describe('atomic lesson publication and unchanged mobile reader contract', () => {
  let server: TestServer;
  let admin: Awaited<ReturnType<typeof createTestAdminUser>>;
  let learnerToken: string;
  let restore: () => void;
  before(async () => {
    server = await startTestServer(); admin = await createTestAdminUser();
    const learner = await prisma.user.create({ data: { name: 'Reader test', email: `reader-${crypto.randomUUID()}@example.test`, role: 'learner' } });
    learnerToken = jwt.sign({ sub: learner.id }, config.jwtSecret, { expiresIn: '1h' });
    restore = installFakeElevenLabsFetch();
  });
  after(async () => { restore(); await server.close(); await prisma.$disconnect(); });
  async function api(path: string, method = 'GET', body?: unknown, token = admin.token, headers = {}) {
    const response = await fetch(server.baseUrl + '/api' + path, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json().catch(() => null) as any };
  }
  async function generate(lessonId: string, textId: string) {
    const ws = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId } });
    const requested = await api(`/admin/lessons/${lessonId}/texts/${textId}/narration-jobs`, 'POST', { contentRevisionId: ws.currentContentRevisionId }, admin.token, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(requested.status, 202);
    const job = await prisma.audioJob.update({ where: { id: requested.body.job.id }, data: { status: 'RUNNING' } });
    await runGenerateNarrationJob(prisma, job);
    assert.equal((await prisma.audioJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'SUCCEEDED');
    return prisma.textWorkspace.findUniqueOrThrow({ where: { textId } });
  }
  async function fixture(count = 1) {
    const created = await api('/lessons', 'POST', { title: 'Reader fixture', items: Array.from({ length: count }, () => ({ text: 'A cat sees a cat.' })) });
    assert.equal(created.status, 201);
    const lesson = created.body.lesson;
    const texts = [];
    for (const item of lesson.items) {
      const ws = await generate(lesson.id, item.id);
      const cats = await prisma.wordOccurrence.findMany({ where: { alignmentId: ws.currentAlignmentId!, surfaceText: 'cat' }, orderBy: { ordinal: 'asc' } });
      const entries = await setSelection(prisma, { textId: item.id, alignmentId: ws.currentAlignmentId!, changes: cats.map(o => ({ occurrenceId: o.id, selected: true })) });
      for (const [index, entry] of entries.entries()) await setTranslations(prisma, { textId: item.id, entryId: entry.id,
        translations: [{ languageCode: 'hy', translation: index === 0 ? 'կատու' : 'երկրորդ կատու' }] });
      await prepareLegacyClips(prisma, item.id);
      texts.push({ id: item.id as string, ws, cats, entries });
    }
    return { lesson, texts, publish: () => api(`/admin/lessons/${lesson.id}/publish`, 'POST', {}) };
  }
  const countReleases = (ids: string[]) => prisma.textRelease.count({ where: { textId: { in: ids } } });

  it('publishes all ordered texts once under concurrent clicks and preserves historical extracted clips for learners', async () => {
    const f = await fixture(2);
    assert.equal(await prisma.wordClip.count({ where: { textId: { in: f.texts.map(t => t.id) } } }), 4);
    assert.equal((await api(`/admin/lessons/${f.lesson.id}/publish`, 'POST', {}, learnerToken)).status, 403);
    const results = await Promise.all([f.publish(), f.publish(), f.publish()]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 200, 201]);
    const publicationId = results[0].body.publicationId;
    assert.ok(results.every(r => r.body.publicationId === publicationId));
    assert.equal(await prisma.lessonPublication.count({ where: { lessonId: f.lesson.id } }), 1);
    assert.equal(await countReleases(f.texts.map(t => t.id)), 2);
    const list = await api('/learner/lessons', 'GET', undefined, learnerToken);
    assert.equal(list.body.lessons.find((l: any) => l.id === f.lesson.id).publicationId, publicationId);
    const delivered = await api(`/learner/lessons/${f.lesson.id}/manifest`, 'GET', undefined, learnerToken);
    const texts = delivered.body.manifest.texts;
    assert.deepEqual(texts.map((t: any) => t.textId), f.texts.map(t => t.id));
    for (const text of texts) {
      const learning = text.occurrences.filter((o: any) => o.learning);
      assert.equal(learning.length, 2);
      assert.deepEqual(learning.map((o: any) => o.learning.translations[0].translation), ['կատու', 'երկրորդ կատու']);
      const narration = await prisma.audioAsset.findUniqueOrThrow({ where: { id: text.narration.id } });
      const decoded = decodeWav(readAudioAssetRange(narration.storageKey, 0, narration.byteLength)!.buffer);
      for (const o of learning) {
        const asset = await prisma.audioAsset.findUniqueOrThrow({ where: { id: o.learning.clip.id } });
        const clip = decodeWav(readAudioAssetRange(asset.storageKey, 0, asset.byteLength)!.buffer);
        assert.deepEqual(clip.samples, decoded.samples.slice(o.learning.cutStartSample, o.learning.cutEndSample));
      }
    }
    assert.equal(await prisma.audioJob.count({ where: { textId: { in: f.texts.map(t => t.id) } } }), 2, 'publication creates no paid narration or clip jobs');
  });

  it('returns all per-text readiness failures and never publishes a subset or accepts non-Armenian translations', async () => {
    const f = await fixture(2);
    await setTranslations(prisma, { textId: f.texts[0].id, entryId: f.texts[0].entries[0].id, translations: [{ languageCode: 'fr', translation: 'chat' }] });
    await prisma.textAlignment.update({ where: { id: f.texts[1].ws.currentAlignmentId! }, data: { status: 'NEEDS_REVIEW' } });
    const result = await f.publish();
    assert.equal(result.status, 422);
    assert.deepEqual(result.body.texts.map((t: any) => t.textId), f.texts.map(t => t.id));
    assert.ok(result.body.texts[0].readiness.reasonCodes.includes('SELECTED_MISSING_TRANSLATION'));
    assert.ok(result.body.texts[1].readiness.reasonCodes.includes('ALIGNMENT_NEEDS_REVIEW'));
    assert.equal(await countReleases(f.texts.map(t => t.id)), 0);
    assert.equal(await prisma.wordClip.count({ where: { textId: { in: f.texts.map(t => t.id) } } }), 4);
    assert.equal((await api(`/learner/lessons/${f.lesson.id}/manifest`, 'GET', undefined, learnerToken)).status, 404);
  });

  it('rolls back clips and releases if preparation of a later text fails', async () => {
    const f = await fixture(2);
    const narration = await prisma.textNarration.findUniqueOrThrow({ where: { id: f.texts[1].ws.currentNarrationId! } });
    // Hash-valid but undecodable audio tests failure after preflight and first-text extraction.
    const invalid = await writeAudioAsset({ textId: f.texts[1].id, kind: 'NARRATION', bytes: Buffer.from('invalid audio fixture') });
    await prisma.audioAsset.update({ where: { id: narration.assetId }, data: invalid });
    const result = await f.publish();
    assert.equal(result.status, 422);
    assert.equal(result.body.texts[0].textId, f.texts[1].id);
    assert.equal(await countReleases(f.texts.map(t => t.id)), 0);
    assert.equal(await prisma.wordClip.count({ where: { textId: { in: f.texts.map(t => t.id) } } }), 4);
    assert.equal((await prisma.lesson.findUniqueOrThrow({ where: { id: f.lesson.id } })).currentPublicationId, null);
  });

  it('rejects stale narration after a text edit, rejects old selection writes, and regenerates missing or stale clips', async () => {
    const f = await fixture(); const t = f.texts[0];
    await f.publish();
    const oldClip = await prisma.wordClip.findFirstOrThrow({ where: { textId: t.id } });
    await prisma.wordClip.update({ where: { id: oldClip.id }, data: { startSample: oldClip.startSample + 1 } });
    let readiness = await api(`/admin/lessons/${f.lesson.id}/texts/${t.id}/readiness`);
    assert.equal(readiness.body.readiness.selectedMissingClipCount, 1, 'stale clip boundary is not current');
    assert.equal((await f.publish()).status, 422, 'publication never silently repairs or generates word audio');
    await prepareLegacyClips(prisma, t.id);
    const repaired = await f.publish(); assert.equal(repaired.status, 201);
    assert.notEqual((await prisma.wordClip.findUniqueOrThrow({ where: { id: oldClip.id } })).assetId, oldClip.assetId);
    const currentClip = await prisma.wordClip.findUniqueOrThrow({ where: { id: oldClip.id } });
    await prisma.audioAsset.update({ where: { id: currentClip.assetId }, data: { state: 'QUARANTINED' } });
    assert.equal((await api(`/admin/lessons/${f.lesson.id}/texts/${t.id}/readiness`)).body.readiness.selectedMissingClipCount, 1);
    assert.equal((await f.publish()).status, 422);
    await prepareLegacyClips(prisma, t.id);
    assert.equal((await f.publish()).status, 201);
    await saveContentRevision(prisma, { textId: t.id, actorId: admin.user.id, text: 'Changed text.', sourceLanguage: 'en' });
    // Even corrupt stale pointers cannot make an old narration match the new revision.
    await prisma.textWorkspace.update({ where: { textId: t.id }, data: { currentNarrationId: t.ws.currentNarrationId, currentAlignmentId: t.ws.currentAlignmentId } });
    assert.equal((await f.publish()).status, 422);
    readiness = await api(`/admin/lessons/${f.lesson.id}/texts/${t.id}/readiness`);
    assert.equal(readiness.body.readiness.narrationValid, false);
    const ws = await generate(f.lesson.id, t.id);
    assert.notEqual(ws.currentAlignmentId, t.ws.currentAlignmentId);
    assert.equal((await api(`/admin/lessons/${f.lesson.id}/texts/${t.id}/selection`, 'PATCH', { alignmentId: t.ws.currentAlignmentId, changes: [{ occurrenceId: t.cats[0].id, selected: true }] })).status, 404);
    assert.equal((await api(`/admin/lessons/${f.lesson.id}/texts/${t.id}/vocabulary/${t.entries[0].id}`, 'PATCH', { translations: [{ languageCode: 'hy', translation: 'old' }] })).status, 404);
    assert.equal((await f.publish()).status, 201, 'a narrated text with no selected learning words is valid');
  });

  it('invalidates the draft immediately on regeneration while keeping the published session immutable', async () => {
    const f = await fixture(); const t = f.texts[0];
    const first = await f.publish();
    const queued = await api(`/admin/lessons/${f.lesson.id}/texts/${t.id}/narration-jobs`, 'POST', { contentRevisionId: t.ws.currentContentRevisionId }, admin.token, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(queued.status, 202);
    const ws = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId: t.id } });
    assert.equal(ws.currentNarrationId, null); assert.equal(ws.currentAlignmentId, null);
    assert.equal((await f.publish()).status, 422);
    assert.equal((await api(`/learner/publications/${first.body.publicationId}`, 'GET', undefined, learnerToken)).status, 200);
    await runGenerateNarrationJob(prisma, await prisma.audioJob.update({ where: { id: queued.body.job.id }, data: { status: 'RUNNING' } }));
    const second = await f.publish(); assert.equal(second.status, 201);
    assert.notEqual(second.body.publicationId, first.body.publicationId);
  });

  it('preserves unchanged release identity, contextual state and private audio across republishing; unpublish withdraws all versions', async () => {
    const f = await fixture(2);
    const published = await f.publish(); const publicationId = published.body.publicationId;
    const delivered = await api(`/learner/lessons/${f.lesson.id}/manifest`, 'GET', undefined, learnerToken);
    const text = delivered.body.manifest.texts[0];
    const learning = text.occurrences.filter((o: any) => o.learning);
    const audioUrl = `${server.baseUrl}/api/learner/audio-assets/${text.narration.id}/content?publicationId=${publicationId}`;
    assert.equal((await fetch(audioUrl)).status, 401);
    assert.equal((await api(`/admin/audio-assets/${text.narration.id}/content`, 'GET', undefined, learnerToken)).status, 403);
    const audio = await fetch(audioUrl, { headers: { authorization: `Bearer ${learnerToken}`, range: 'bytes=-4' } });
    assert.equal(audio.status, 206); assert.equal((await audio.arrayBuffer()).byteLength, 4);
    const clipUrl = `${server.baseUrl}/api/learner/audio-assets/${learning[0].learning.clip.id}/content?publicationId=${publicationId}`;
    assert.equal((await fetch(clipUrl, { headers: { authorization: `Bearer ${learnerToken}` } })).status, 200);
    assert.equal((await fetch(audioUrl.replace(text.narration.id, 'not-in-release'), { headers: { authorization: `Bearer ${learnerToken}` } })).status, 404);
    const wordState = { publicationId, textReleaseId: text.textReleaseId, occurrenceId: learning[0].id, status: 'LEARNING', clientUpdatedAt: new Date().toISOString() };
    assert.equal((await api('/learner/word-state', 'PUT', wordState, learnerToken)).status, 200);
    assert.equal((await api('/learner/word-state', 'PUT', { ...wordState, status: 'LEARNED', clientUpdatedAt: '2020-01-01T00:00:00.000Z' }, learnerToken)).body.word.status, 'LEARNING');
    assert.equal((await api(`/learner/publications/${publicationId}`)).body.words.length, 0, 'states are user-scoped');
    assert.equal((await api('/learner/word-state', 'PUT', { ...wordState, occurrenceId: text.occurrences.find((o: any) => !o.learning).id }, learnerToken)).status, 404);
    await api('/learner/reader-progress', 'PUT', { publicationId, textReleaseId: text.textReleaseId, lastSample: text.narration.frameCount, completed: true, clientUpdatedAt: new Date().toISOString() }, learnerToken);
    await setTranslations(prisma, { textId: f.texts[1].id, entryId: f.texts[1].entries[0].id, translations: [{ languageCode: 'hy', translation: 'Փոփոխություն' }] });
    const updated = await f.publish();
    assert.notEqual(updated.body.publicationId, publicationId);
    const current = await api(`/learner/lessons/${f.lesson.id}/manifest`, 'GET', undefined, learnerToken);
    assert.equal(current.body.manifest.texts[0].textReleaseId, text.textReleaseId);
    assert.equal((await api('/learner/lessons', 'GET', undefined, learnerToken)).body.lessons.find((l: any) => l.id === f.lesson.id).completedTexts, 1);
    const pinned = await api(`/learner/publications/${publicationId}`, 'GET', undefined, learnerToken);
    assert.equal(pinned.body.manifest.texts[1].occurrences.find((o: any) => o.learning).learning.translations[0].translation, 'կատու');
    await api(`/admin/lessons/${f.lesson.id}/unpublish`, 'POST', {});
    assert.equal((await fetch(audioUrl, { headers: { authorization: `Bearer ${learnerToken}` } })).status, 404);
    assert.equal((await api(`/learner/publications/${publicationId}`, 'GET', undefined, learnerToken)).status, 404);
    assert.equal((await api('/lessons/' + f.lesson.id)).body.lesson.status, 'DRAFT');
  });

  it('retains a late narration as history without attaching it to an edited text', async () => {
    const f = await fixture(); const t = f.texts[0];
    const late = await prisma.audioJob.create({ data: { textId: t.id, kind: 'GENERATE_NARRATION', status: 'RUNNING', actorId: admin.user.id,
      idempotencyKey: crypto.randomUUID(), requestHash: 'test', requestPayload: { contentRevisionId: t.ws.currentContentRevisionId, voiceId: 'synthetic-mock' } } });
    const revised = await saveContentRevision(prisma, { textId: t.id, actorId: admin.user.id, text: 'New words now.', sourceLanguage: 'en' });
    await runGenerateNarrationJob(prisma, late);
    const workspace = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId: t.id } });
    assert.equal(workspace.currentContentRevisionId, revised.revision.id);
    assert.equal(workspace.currentNarrationId, null); assert.equal(workspace.currentAlignmentId, null);
    assert.equal((await prisma.audioJob.findUniqueOrThrow({ where: { id: late.id } })).status, 'SUCCEEDED');
  });

  it('bulk selects all texts of one pinned lesson without adding words from another lesson', async () => {
    const f = await fixture(2), other = await fixture();
    const published = await f.publish(); await other.publish();
    const path = `/learner/publications/${published.body.publicationId}/activate-vocabulary`;
    assert.equal((await api(path, 'POST', { clientUpdatedAt: new Date().toISOString() }, learnerToken)).body.activatedCount, 4);
    const words = (await api('/learner/words', 'GET', undefined, learnerToken)).body.words;
    assert.equal(words.filter((w: any) => w.lessonId === f.lesson.id && w.status === 'LEARNING').length, 4);
    assert.equal(words.filter((w: any) => w.lessonId === other.lesson.id && w.status === 'LEARNING').length, 0);
    assert.equal((await api(path, 'POST', { clientUpdatedAt: '2099-01-01T00:00:00.000Z' }, learnerToken)).status, 400);
  });
});

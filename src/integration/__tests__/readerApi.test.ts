import { strict as assert } from 'node:assert';
import { before, after, describe, it } from 'node:test';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { startTestServer, createTestAdminUser, prisma, config, TestServer } from './helpers/authoringTestApp';
import { installFakeElevenLabsFetch } from './helpers/fakeElevenLabsFetch';
import { saveContentRevision } from '../../lib/textWorkspaces';
import { runGenerateNarrationJob, runExtractClipsJob } from '../../lib/textAudioPipeline';
import { setSelection, setTranslations } from '../../lib/textVocabulary';

// Synthetic provider responses are used only in this disposable-database test suite.
describe('V2 learner publications and occurrence identity', () => {
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
  async function api(path: string, method = 'GET', body?: unknown, token = admin.token) {
    const response = await fetch(server.baseUrl + '/api' + path, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json' }, body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() as any };
  }
  async function job(textId: string, kind: 'GENERATE_NARRATION' | 'EXTRACT_CLIPS', payload: object) {
    return prisma.audioJob.create({ data: { textId, kind, status: 'RUNNING', actorId: admin.user.id,
      idempotencyKey: crypto.randomUUID(), requestHash: 'test', requestPayload: payload } });
  }
  async function fixture() {
    const lesson = await prisma.lesson.create({ data: { title: 'Reader fixture', authorId: admin.user.id,
      items: { create: { text: 'A cat sees a cat.', audioUrl: '', segments: [], order: 0 } } }, include: { items: true } });
    const textId = lesson.items[0].id;
    const revision = await saveContentRevision(prisma, { textId, actorId: admin.user.id, text: lesson.items[0].text, sourceLanguage: 'en' });
    await runGenerateNarrationJob(prisma, await job(textId, 'GENERATE_NARRATION', { contentRevisionId: revision.revision.id, voiceId: 'automated-test-only' }));
    const ws = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId } });
    const cats = await prisma.wordOccurrence.findMany({ where: { alignmentId: ws.currentAlignmentId!, surfaceText: 'cat' }, orderBy: { ordinal: 'asc' } });
    const entries = await setSelection(prisma, { textId, alignmentId: ws.currentAlignmentId!, changes: cats.map(o => ({ occurrenceId: o.id, selected: true })) });
    for (const [index, entry] of entries.entries()) await setTranslations(prisma, { textId, entryId: entry.id,
      translations: [{ languageCode: 'am', translation: index === 0 ? 'կատու' : 'երկրորդ կատու' }] });
    await runExtractClipsJob(prisma, await job(textId, 'EXTRACT_CLIPS', { narrationId: ws.currentNarrationId!, alignmentId: ws.currentAlignmentId!, occurrenceIds: cats.map(o => o.id) }));
    const base = `/admin/lessons/${lesson.id}/texts/${textId}`;
    const approval = { contentRevisionId: revision.revision.id, narrationId: ws.currentNarrationId!, alignmentId: ws.currentAlignmentId! };
    return { lesson, textId, cats, entries, base, approval };
  }

  it('requires explicit publication, isolates occurrences and users, supports private audio and freezes approved translations', async () => {
    const f = await fixture();
    assert.equal((await api(`/learner/lessons/${f.lesson.id}/manifest`, 'GET', undefined, learnerToken)).status, 404);
    assert.equal((await api(`/admin/lessons/${f.lesson.id}/reader-publications`, 'POST', { textReleaseIds: ['missing'] })).status, 422);
    const release = await api(f.base + '/releases', 'POST', f.approval);
    assert.equal(release.status, 201);
    const releaseId = release.body.release.id;
    assert.equal((await api(`/learner/lessons/${f.lesson.id}/manifest`, 'GET', undefined, learnerToken)).status, 404, 'approval is not publication');
    assert.equal((await api(`/admin/lessons/${f.lesson.id}/reader-publications`, 'POST', { textReleaseIds: [releaseId] }, learnerToken)).status, 403);
    const published = await api(`/admin/lessons/${f.lesson.id}/reader-publications`, 'POST', { textReleaseIds: [releaseId] });
    assert.equal(published.status, 201);
    const publicationId = published.body.publicationId;
    assert.equal((await api(`/admin/lessons/${f.lesson.id}/reader-publications`, 'POST', { textReleaseIds: [releaseId] })).body.publicationId, publicationId);
    const delivered = await api(`/learner/lessons/${f.lesson.id}/manifest`, 'GET', undefined, learnerToken);
    assert.equal(delivered.status, 200);
    const text = delivered.body.manifest.texts[0];
    assert.equal(text.occurrences.length, 5);
    const learning = text.occurrences.filter((o: any) => o.learning);
    assert.equal(learning.length, 2);
    assert.notEqual(learning[0].id, learning[1].id);
    assert.deepEqual(learning.map((o: any) => o.learning.translations[0].translation), ['կատու', 'երկրորդ կատու']);
    assert.equal(learning[0].learning.translations[0].languageCode, 'hy');
    const asset = text.narration.id;
    const audioUrl = `${server.baseUrl}/api/learner/audio-assets/${asset}/content?publicationId=${publicationId}`;
    assert.equal((await fetch(audioUrl)).status, 401);
    assert.equal((await api(`/admin/audio-assets/${asset}/content`, 'GET', undefined, learnerToken)).status, 403);
    const audio = await fetch(audioUrl, { headers: { authorization: `Bearer ${learnerToken}`, range: 'bytes=-4' } });
    assert.equal(audio.status, 206); assert.equal((await audio.arrayBuffer()).byteLength, 4);
    assert.equal((await fetch(audioUrl.replace(asset, 'not-in-release'), { headers: { authorization: `Bearer ${learnerToken}` } })).status, 404);
    await setTranslations(prisma, { textId: f.textId, entryId: f.entries[0].id, translations: [{ languageCode: 'hy', translation: 'changed draft' }] });
    const pinned = await api(`/learner/publications/${publicationId}`, 'GET', undefined, learnerToken);
    assert.equal(pinned.body.manifest.texts[0].occurrences.find((o: any) => o.id === learning[0].id).learning.translations[0].translation, 'կատու');
    assert.equal((await api(`/admin/lessons/${f.lesson.id}/reader-publications`, 'POST', { textReleaseIds: [releaseId] })).status, 422);
    const wordState = { publicationId, textReleaseId: releaseId, occurrenceId: learning[0].id, status: 'LEARNING', clientUpdatedAt: new Date().toISOString() };
    assert.equal((await api('/learner/word-state', 'PUT', wordState, learnerToken)).status, 200);
    assert.equal((await api('/learner/word-state', 'PUT', { ...wordState, status: 'LEARNED', clientUpdatedAt: '2020-01-01T00:00:00.000Z' }, learnerToken)).body.word.status, 'LEARNING', 'old retries cannot overwrite a newer choice');
    const state = (await api(`/learner/publications/${publicationId}`, 'GET', undefined, learnerToken)).body.words;
    assert.equal(state.length, 1); assert.equal(state[0].occurrenceId, learning[0].id);
    assert.equal((await api(`/learner/publications/${publicationId}`)).body.words.length, 0, 'states belong to the authenticated user');
    const unselected = text.occurrences.find((o: any) => !o.learning);
    assert.equal((await api('/learner/word-state', 'PUT', { ...wordState, occurrenceId: unselected.id }, learnerToken)).status, 404);
    assert.equal((await api('/learner/reader-progress', 'PUT', { publicationId, textReleaseId: releaseId, lastSample: text.narration.frameCount, completed: true, clientUpdatedAt: new Date().toISOString() }, learnerToken)).status, 200);
    assert.equal((await api('/learner/lessons', 'GET', undefined, learnerToken)).body.lessons.find((l: any) => l.id === f.lesson.id).completedTexts, 1);
    await api(`/admin/lessons/${f.lesson.id}/reader-publications/revoke`, 'POST');
    assert.equal((await fetch(audioUrl, { headers: { authorization: `Bearer ${learnerToken}` } })).status, 404);
    assert.equal((await api(`/learner/publications/${publicationId}`, 'GET', undefined, learnerToken)).status, 404);
  });

  it('rejects quarantined clips and narration from a different revision before approval', async () => {
    const f = await fixture();
    const clip = await prisma.wordClip.findFirstOrThrow({ where: { textId: f.textId } });
    await prisma.audioAsset.update({ where: { id: clip.assetId }, data: { state: 'QUARANTINED' } });
    assert.equal((await api(f.base + '/readiness')).body.readiness.selectedMissingClipCount, 1);
    assert.equal((await api(f.base + '/releases', 'POST', f.approval)).status, 422);
    const revision = await saveContentRevision(prisma, { textId: f.textId, actorId: admin.user.id, text: 'A different text.', sourceLanguage: 'en' });
    await prisma.textWorkspace.update({ where: { textId: f.textId }, data: { currentNarrationId: f.approval.narrationId, currentAlignmentId: f.approval.alignmentId } });
    assert.equal((await api(f.base + '/readiness')).body.readiness.narrationValid, false);
    assert.equal((await api(f.base + '/releases', 'POST', { ...f.approval, contentRevisionId: revision.revision.id })).status, 422);
  });

  it('retains a late narration as history without attaching it to an edited current text', async () => {
    const f = await fixture();
    const late = await job(f.textId, 'GENERATE_NARRATION', { contentRevisionId: f.approval.contentRevisionId, voiceId: 'automated-test-only' });
    const revised = await saveContentRevision(prisma, { textId: f.textId, actorId: admin.user.id, text: 'New words now.', sourceLanguage: 'en' });
    await runGenerateNarrationJob(prisma, late);
    const workspace = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId: f.textId } });
    assert.equal(workspace.currentContentRevisionId, revised.revision.id);
    assert.equal(workspace.currentNarrationId, null); assert.equal(workspace.currentAlignmentId, null);
    assert.equal((await prisma.audioJob.findUniqueOrThrow({ where: { id: late.id } })).status, 'SUCCEEDED');
  });
});

import { strict as assert } from 'node:assert';
import { before, after, describe, it } from 'node:test';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { startTestServer, createTestAdminUser, prisma, config, TestServer } from './helpers/authoringTestApp';
import { installFakeElevenLabsFetch } from './helpers/fakeElevenLabsFetch';
import { runGenerateNarrationJob } from '../../lib/textAudioPipeline';
import { ReaderManifest } from '../../types/reader';
import { indexPublishedVocabulary } from '../../lib/vocabularyLibrary';

describe('shared saved vocabulary recordings', () => {
  let server: TestServer, adminToken: string, learnerToken: string, restore: () => void;
  const namespace = crypto.randomUUID().replace(/-/g, '');
  before(async () => {
    server = await startTestServer(); adminToken = (await createTestAdminUser()).token;
    const learner = await prisma.user.create({ data: { name: 'Library learner', email: `${namespace}@example.test`, role: 'learner' } });
    learnerToken = jwt.sign({ sub: learner.id }, config.jwtSecret, { expiresIn: '1h' });
    restore = installFakeElevenLabsFetch();
  });
  after(async () => { restore(); await server.close(); await prisma.$disconnect(); });
  async function api(path: string, method = 'GET', body?: unknown, token = adminToken, headers = {}) {
    const res = await fetch(server.baseUrl + '/api' + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  }
  async function fixture(suffix: string, translation = 'հոգ տանել', voiceId = 'library-voice-one') {
    const word = `phrase${namespace}${suffix}`;
    const created = await api('/lessons', 'POST', { title: `Vocabulary ${suffix}`, items: [{ text: `We ${word} together.` }] });
    assert.equal(created.status, 201);
    const lessonId = created.body.lesson.id, textId = created.body.lesson.items[0].id;
    const path = `/admin/lessons/${lessonId}/texts/${textId}`;
    const ws = (await api(path)).body.text;
    const requested = await api(path + '/narration-jobs', 'POST', { contentRevisionId: ws.contentRevision.id, voiceProfileId: voiceId }, adminToken, { 'Idempotency-Key': crypto.randomUUID() });
    assert.equal(requested.status, 202);
    await runGenerateNarrationJob(prisma, await prisma.audioJob.update({ where: { id: requested.body.job.id }, data: { status: 'RUNNING' } }));
    const data = (await api(path + '/occurrences')).body;
    const occurrence = data.occurrences.find((o: any) => o.text === word);
    assert.equal((await api(path + '/vocabulary/import', 'POST', { alignmentId: data.alignmentId, expectedDraftVersion: data.draftVersion,
      entries: [{ occurrenceId: occurrence.id, endOccurrenceId: data.occurrences[2].id, translation }] })).status, 200);
    return { lessonId, textId, path, word: `${word} together`, publish: () => api(`/admin/lessons/${lessonId}/publish`, 'POST', {}) };
  }
  async function manifest(lessonId: string) {
    return (await api(`/learner/lessons/${lessonId}/manifest`, 'GET', undefined, learnerToken)).body as { publicationId: string; manifest: ReaderManifest };
  }
  async function detail(word: string) {
    const list = await api(`/admin/vocabulary?q=${encodeURIComponent(word)}`);
    assert.equal(list.status, 200); assert.equal(list.body.total, 1);
    return (await api(`/admin/vocabulary/${list.body.terms[0].id}`)).body;
  }
  const preference = (meaningId: string, voiceId: string, recordingId: string | null, expectedRecordingId: string | null = null) =>
    api(`/admin/vocabulary/meanings/${meaningId}/preference`, 'PUT', { voiceId, recordingId, expectedRecordingId });
  async function learnerClip(lessonId: string) {
    const result = await api('/learner/words', 'GET', undefined, learnerToken);
    return result.body.words.find((word: any) => word.lessonId === lessonId).occurrence.learning.clip;
  }
  async function audio(assetId: string, publicationId: string, token = learnerToken) {
    return fetch(`${server.baseUrl}/api/learner/audio-assets/${assetId}/content?publicationId=${publicationId}`, { headers: { authorization: `Bearer ${token}` } });
  }

  it('indexes repeated publications and backfills by reference without new audio or jobs', async () => {
    const f = await fixture('reuse');
    const first = await f.publish(); assert.equal(first.status, 201);
    const before = await prisma.audioAsset.count({ where: { textId: f.textId } });
    const snapshot = await manifest(f.lessonId);
    const text = snapshot.manifest.texts[0];
    const repeat = await f.publish(); assert.equal(repeat.body.publicationId, first.body.publicationId);
    await prisma.$transaction(tx => indexPublishedVocabulary(tx, f.lessonId, text));
    const library = await detail(f.word);
    assert.equal(library.meanings.length, 1);
    assert.equal(library.meanings[0].recordings.length, 1);
    assert.equal(library.meanings[0].recordings[0].usages.length, 1);
    assert.equal(library.meanings[0].recordings[0].asset.id, text.occurrences.find(o => o.learning)!.learning!.clip.id);
    assert.equal(library.meanings[0].recordings[0].usages[0].current, true);
    assert.equal(await prisma.audioAsset.count({ where: { textId: f.textId } }), before);
    assert.equal(await prisma.audioJob.count({ where: { textId: f.textId } }), 1);
    assert.equal((await api('/admin/vocabulary', 'GET', undefined, learnerToken)).status, 403);
    assert.equal((await api(`/admin/vocabulary/${library.id}`, 'GET', undefined, learnerToken)).status, 403);
    assert.equal((await fetch(server.baseUrl + '/api/admin/vocabulary')).status, 401);
  });

  it('shares a preferred recording across matching lessons while preserving immutable narration, state identity and contextual clips', async () => {
    const a = await fixture('matching'), b = await fixture('matching');
    const c = await fixture('matching'), d = await fixture('matching');
    const results = await Promise.all([a.publish(), b.publish(), c.publish(), d.publish()]);
    assert.ok(results.every(r => r.status === 201), JSON.stringify(results));
    const beforeA = await manifest(a.lessonId), beforeB = await manifest(b.lessonId);
    const library = await detail(a.word), meaning = library.meanings[0];
    assert.equal(meaning.recordings.length, 4);
    const chosen = meaning.recordings.find((r: any) => r.usages.some((u: any) => u.lessonId === a.lessonId));
    const allAssets = await prisma.audioAsset.count();
    assert.equal((await preference(meaning.id, chosen.voiceId, chosen.id)).status, 200);
    assert.equal((await learnerClip(b.lessonId)).id, chosen.asset.id);
    assert.deepEqual(await manifest(b.lessonId), beforeB, 'lesson playback manifest remains unchanged');
    assert.deepEqual(await manifest(a.lessonId), beforeA);
    assert.equal((await audio(chosen.asset.id, beforeB.publicationId)).status, 200);
    assert.equal(await prisma.audioAsset.count(), allAssets, 'preference reuses the same saved file');
    const unrelated = await fixture('unrelated'); await unrelated.publish();
    assert.equal((await audio(chosen.asset.id, (await manifest(unrelated.lessonId)).publicationId)).status, 404);
    assert.equal((await api(`/admin/vocabulary/meanings/${meaning.id}/preference`, 'PUT', { voiceId: chosen.voiceId, recordingId: null, expectedRecordingId: chosen.id }, learnerToken)).status, 403);
    await api(`/admin/lessons/${b.lessonId}/unpublish`, 'POST', {});
    assert.equal((await audio(chosen.asset.id, beforeB.publicationId)).status, 404);
  });

  it('keeps different meanings and voices separate and rejects invalid preferences', async () => {
    const a = await fixture('variants'), b = await fixture('variants', 'խնամել'), c = await fixture('variants', 'հոգ տանել', 'library-voice-two');
    for (const f of [a, b, c]) assert.equal((await f.publish()).status, 201);
    const library = await detail(a.word);
    assert.equal(library.meanings.length, 2);
    const first = library.meanings.find((m: any) => m.translation === 'հոգ տանել');
    const other = library.meanings.find((m: any) => m.translation === 'խնամել');
    const chosen = first.recordings.find((r: any) => r.voiceId === 'library-voice-one');
    const secondVoice = first.recordings.find((r: any) => r.voiceId === 'library-voice-two');
    assert.equal((await preference(first.id, chosen.voiceId, other.recordings[0].id)).status, 422);
    assert.equal((await preference(first.id, chosen.voiceId, secondVoice.id)).status, 422);
    assert.equal((await preference(first.id, chosen.voiceId, chosen.id)).status, 200);
    assert.equal((await learnerClip(c.lessonId)).id, secondVoice.asset.id);
    assert.equal((await learnerClip(b.lessonId)).id, other.recordings[0].asset.id);
    assert.equal((await audio(chosen.asset.id, (await manifest(c.lessonId)).publicationId)).status, 404);
  });

  it('detects concurrent preference changes and falls back if the chosen recording is unavailable', async () => {
    const a = await fixture('fallback'), b = await fixture('fallback');
    await a.publish(); await b.publish();
    const library = await detail(a.word), meaning = library.meanings[0];
    const [first, second] = meaning.recordings;
    const results = await Promise.all([preference(meaning.id, first.voiceId, first.id), preference(meaning.id, second.voiceId, second.id)]);
    assert.deepEqual(results.map(r => r.status).sort(), [200, 409]);
    const current = (await detail(a.word)).meanings[0].preferences[0].recordingId;
    const chosen = meaning.recordings.find((r: any) => r.id === current);
    const target = chosen.usages[0].lessonId === a.lessonId ? b : a;
    const original = (await manifest(target.lessonId)).manifest.texts[0].occurrences.find(o => o.learning)!.learning!.clip;
    await prisma.audioAsset.update({ where: { id: chosen.asset.id }, data: { state: 'QUARANTINED' } });
    assert.equal((await learnerClip(target.lessonId)).id, original.id);
    assert.equal((await preference(meaning.id, chosen.voiceId, chosen.id, current)).status, 422);
    assert.equal((await preference(meaning.id, chosen.voiceId, null, current)).status, 200);
    assert.equal((await detail(a.word)).meanings[0].preferences.length, 0);
  });

  it('keeps historical recordings and their source meaning when a translation is republished', async () => {
    const f = await fixture('history'); await f.publish();
    const old = await manifest(f.lessonId);
    const word = old.manifest.texts[0].occurrences.find(o => o.learning)!;
    await api(f.path + `/vocabulary/${word.learning!.entryId}`, 'PATCH', { translations: [{ languageCode: 'hy', translation: 'փոխված իմաստ' }] });
    assert.equal((await f.publish()).status, 201);
    const library = await detail(f.word);
    assert.equal(library.meanings.length, 2);
    const records = library.meanings.flatMap((m: any) => m.recordings);
    assert.ok(records.every((r: any) => r.asset.id === word.learning!.clip.id), 'translation changes share existing audio');
    assert.deepEqual(records.map((r: any) => r.usages[0].current).sort(), [false, true]);
    assert.deepEqual((await api(`/learner/publications/${old.publicationId}`)).body.manifest, old.manifest);
  });
});

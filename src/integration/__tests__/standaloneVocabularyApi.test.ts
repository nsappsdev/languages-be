import { strict as assert } from 'node:assert';
import { before, after, describe, it } from 'node:test';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { startTestServer, createTestAdminUser, prisma, config, TestServer } from './helpers/authoringTestApp';
import { installFakeElevenLabsFetch } from './helpers/fakeElevenLabsFetch';
import { runGenerateNarrationJob } from '../../lib/textAudioPipeline';
import { runGenerateVocabularyJob } from '../../lib/standaloneVocabulary';
import { ReaderManifest } from '../../types/reader';
import { failExpiredVocabularyJobs } from '../../lib/audioJobs';

describe('standalone vocabulary audio and bulk learner selection', () => {
  let server: TestServer, adminToken: string, learnerToken: string, restore: () => void;
  let providerFetch: typeof fetch;
  const dispatched: string[] = [];
  before(async () => {
    server = await startTestServer(); adminToken = (await createTestAdminUser()).token;
    const learner = await prisma.user.create({ data: { name: 'Standalone learner', email: `${crypto.randomUUID()}@example.test`, role: 'learner' } });
    learnerToken = jwt.sign({ sub: learner.id }, config.jwtSecret, { expiresIn: '1h' });
    restore = installFakeElevenLabsFetch(); providerFetch = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url).includes('api.elevenlabs.io')) dispatched.push(JSON.parse(String(init?.body)).text);
      return providerFetch(url, init);
    };
  });
  after(async () => { restore(); await server.close(); await prisma.$disconnect(); });
  async function api(path: string, method = 'GET', body?: unknown, token = adminToken, headers = {}) {
    const res = await fetch(server.baseUrl + '/api' + path, { method, headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', ...headers },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: res.status, body: await res.json().catch(() => null) as any };
  }
  async function fixture(word = `word${crypto.randomUUID().replace(/-/g, '')}`, translation = 'փորձնական արտահայտություն', voiceId = 'standalone-test-voice') {
    const created = await api('/lessons', 'POST', { title: 'Standalone review', items: [{ text: `We ${word} together. They ${word} together.` }] });
    const lessonId = created.body.lesson.id, textId = created.body.lesson.items[0].id;
    const path = `/admin/lessons/${lessonId}/texts/${textId}`;
    const ws = (await api(path)).body.text;
    const requested = await api(path + '/narration-jobs', 'POST', { contentRevisionId: ws.contentRevision.id, voiceProfileId: voiceId }, adminToken, { 'Idempotency-Key': crypto.randomUUID() });
    await runGenerateNarrationJob(prisma, await prisma.audioJob.update({ where: { id: requested.body.job.id }, data: { status: 'RUNNING' } }));
    const data = (await api(path + '/occurrences')).body;
    const words = data.occurrences as { id: string; text: string }[];
    const entries = words.flatMap((w, i) => w.text === word ? [{ occurrenceId: w.id, endOccurrenceId: words[i + 1].id, translation }] : []);
    assert.equal((await api(path + '/vocabulary/import', 'POST', { alignmentId: data.alignmentId, expectedDraftVersion: data.draftVersion, entries })).status, 200);
    return { lessonId, textId, path, term: `${word} together`, word,
      plan: () => api(path + '/vocabulary/audio-plan'), publish: () => api(`/admin/lessons/${lessonId}/publish`, 'POST', {}) };
  }
  async function request(f: Awaited<ReturnType<typeof fixture>>, key = crypto.randomUUID()) {
    const plan = await f.plan(); assert.equal(plan.status, 200);
    const response = await api(f.path + '/vocabulary/audio-jobs', 'POST', { expectedDraftVersion: plan.body.draftVersion }, adminToken, { 'Idempotency-Key': key });
    assert.equal(response.status, 202, JSON.stringify(response.body));
    return { ...response.body, version: plan.body.draftVersion, key };
  }
  async function run(id: string) {
    await runGenerateVocabularyJob(prisma, await prisma.audioJob.update({ where: { id }, data: { status: 'RUNNING' } }));
    return prisma.audioJob.findUniqueOrThrow({ where: { id } });
  }
  async function manifest(lessonId: string) { return (await api(`/learner/lessons/${lessonId}/manifest`, 'GET', undefined, learnerToken)).body as { publicationId: string; manifest: ReaderManifest }; }

  it('requires explicit preparation, generates each repeated phrase once, and saves independent private audio before publication', async () => {
    const f = await fixture();
    assert.equal((await f.publish()).status, 422);
    assert.equal(await prisma.wordClip.count({ where: { textId: f.textId } }), 0);
    const plan = (await f.plan()).body; assert.equal(plan.generateCount, 1); assert.equal(plan.reuseCount, 0);
    assert.equal((await api(f.path + '/vocabulary/audio-plan', 'GET', undefined, learnerToken)).status, 403);
    const queued = await request(f); const before = dispatched.length;
    assert.equal((await run(queued.job.id)).status, 'SUCCEEDED');
    assert.deepEqual(dispatched.slice(before), [f.term]);
    const bindings = await prisma.textVocabularyEntry.findMany({ where: { textId: f.textId }, include: { recording: { include: { asset: true } } } });
    assert.equal(bindings.length, 2); assert.equal(bindings[0].recordingId, bindings[1].recordingId);
    assert.equal(bindings[0].recording!.standalone, true); assert.equal(bindings[0].recording!.asset.textId, null);
    assert.equal((await api('/admin/vocabulary?q=' + encodeURIComponent(f.term))).body.total, 1);
    const replay = await api(f.path + '/vocabulary/audio-jobs', 'POST', { expectedDraftVersion: queued.version }, adminToken, { 'Idempotency-Key': queued.key });
    assert.equal(replay.body.job.id, queued.job.id); assert.equal(replay.body.replay, true);
    assert.equal((await f.publish()).status, 201);
    const saved = await manifest(f.lessonId), words = saved.manifest.texts[0].occurrences.filter(o => o.learning);
    assert.equal(words.length, 2); assert.ok(words.every(o => o.learning!.clipSource === 'VOCABULARY'));
    assert.equal(words[0].learning!.clip.id, words[1].learning!.clip.id);
    const audio = await fetch(`${server.baseUrl}/api/learner/audio-assets/${words[0].learning!.clip.id}/content?publicationId=${saved.publicationId}`, { headers: { authorization: `Bearer ${learnerToken}` } });
    assert.equal(audio.status, 200); assert.ok((await audio.arrayBuffer()).byteLength > 44);
    assert.equal((await f.publish()).body.replay, true);
    assert.equal(dispatched.length, before + 1, 'publication makes no provider calls');
  });

  it('reuses the same spelling and voice across lessons and translations without another speech request', async () => {
    const first = await fixture(); await run((await request(first)).job.id);
    const second = await fixture(first.word, 'այլ իմաստ');
    const plan = (await second.plan()).body; assert.equal(plan.generateCount, 0); assert.equal(plan.reuseCount, 2);
    const before = dispatched.length, configuredKey = config.elevenLabs.apiKey;
    config.elevenLabs.apiKey = '';
    try { assert.equal((await run((await request(second)).job.id)).status, 'SUCCEEDED'); }
    finally { config.elevenLabs.apiKey = configuredKey; }
    assert.equal(dispatched.length, before);
    const a = await prisma.textVocabularyEntry.findFirstOrThrow({ where: { textId: first.textId }, include: { recording: true } });
    const b = await prisma.textVocabularyEntry.findFirstOrThrow({ where: { textId: second.textId }, include: { recording: true } });
    assert.equal(a.recording!.assetId, b.recording!.assetId); assert.notEqual(a.recording!.meaningId, b.recording!.meaningId);
    const differentVoice = await fixture(first.word, 'այլ իմաստ', 'another-standalone-voice');
    assert.equal((await differentVoice.plan()).body.generateCount, 1);
    await run((await request(differentVoice)).job.id); assert.equal(dispatched.length, before + 2, 'one new narration and one new voice recording');
  });

  it('serializes duplicate generation across different lessons and rejects stale previews', async () => {
    const a = await fixture(), b = await fixture(a.word);
    const first = await request(a), second = await request(b), before = dispatched.length;
    const results = await Promise.all([run(first.job.id), run(second.job.id)]);
    assert.ok(results.some(r => r.status === 'SUCCEEDED'));
    assert.equal(dispatched.length, before + 1, 'only one provider dispatch per spelling and voice');
    for (const [index, result] of results.entries()) if (result.status === 'FAILED') assert.equal((await run((await request(index ? b : a)).job.id)).status, 'SUCCEEDED');
    assert.equal(dispatched.length, before + 1);
    const stale = (await a.plan()).body.draftVersion;
    await prisma.textWorkspace.update({ where: { textId: a.textId }, data: { draftVersion: { increment: 1 } } });
    assert.equal((await api(a.path + '/vocabulary/audio-jobs', 'POST', { expectedDraftVersion: stale }, adminToken, { 'Idempotency-Key': crypto.randomUUID() })).status, 409);
  });

  it('retains generated audio in the library when a draft changes during generation', async () => {
    const f = await fixture(), queued = await request(f);
    const previous = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url).includes('api.elevenlabs.io')) await prisma.textWorkspace.update({ where: { textId: f.textId }, data: { draftVersion: { increment: 1 } } });
      return previous(url, init);
    };
    try { assert.equal((await run(queued.job.id)).status, 'FAILED'); } finally { global.fetch = previous; }
    assert.equal(await prisma.textVocabularyEntry.count({ where: { textId: f.textId, recordingId: { not: null } } }), 0);
    assert.equal((await f.plan()).body.generateCount, 0);
    const before = dispatched.length; assert.equal((await run((await request(f)).job.id)).status, 'SUCCEEDED');
    assert.equal(dispatched.length, before);
  });

  it('blocks a second dispatch after an uncertain provider outcome', async () => {
    const f = await fixture(), queued = await request(f), previous = global.fetch;
    let attempts = 0;
    global.fetch = async (url, init) => {
      if (String(url).includes('api.elevenlabs.io')) { attempts++; throw new Error('Simulated connection lost after dispatch'); }
      return previous(url, init);
    };
    try {
      assert.equal((await run(queued.job.id)).errorCode, 'PROVIDER_UNKNOWN_OUTCOME');
      assert.equal((await run((await request(f)).job.id)).status, 'FAILED');
      assert.equal(attempts, 1);
    } finally { global.fetch = previous; }
  });

  it('allows an explicit retry after a provider-declared safe failure', async () => {
    const f = await fixture(), queued = await request(f), previous = global.fetch;
    global.fetch = async (url, init) => String(url).includes('api.elevenlabs.io') ? new Response('Rate limited', { status: 429 }) : previous(url, init);
    try { const failed = await run(queued.job.id); assert.equal(failed.status, 'FAILED'); assert.equal(failed.retryable, true); }
    finally { global.fetch = previous; }
    const before = dispatched.length;
    assert.equal((await run((await request(f)).job.id)).status, 'SUCCEEDED');
    assert.equal(dispatched.length, before + 1);
  });

  it('surfaces interrupted dispatches without charging again after a worker restart', async () => {
    const f = await fixture(), queued = await request(f);
    await prisma.audioJob.update({ where: { id: queued.job.id }, data: { status: 'RUNNING', leaseUntil: new Date(0) } });
    const term = await prisma.vocabularyTerm.create({ data: { language: 'en', normalizedText: f.term.toLowerCase(), displayText: f.term } });
    const reservation = await prisma.vocabularyAudio.create({ data: { termId: term.id, voiceId: 'standalone-test-voice', model: 'eleven_multilingual_v2', ownerJobId: queued.job.id, status: 'RUNNING' } });
    await failExpiredVocabularyJobs(prisma);
    assert.equal((await prisma.audioJob.findUniqueOrThrow({ where: { id: queued.job.id } })).errorCode, 'PROVIDER_UNKNOWN_OUTCOME');
    assert.equal((await prisma.vocabularyAudio.findUniqueOrThrow({ where: { id: reservation.id } })).retryable, false);
    const before = dispatched.length;
    assert.equal((await run((await request(f)).job.id)).status, 'FAILED');
    assert.equal(dispatched.length, before);
  });

  it('marks all lesson words once, preserves learned words, and allows individual removal afterward', async () => {
    const f = await fixture(); await run((await request(f)).job.id); await f.publish();
    const saved = await manifest(f.lessonId), text = saved.manifest.texts[0], words = text.occurrences.filter(o => o.learning);
    const timestamp = () => new Date().toISOString();
    const activate = () => api(`/learner/publications/${saved.publicationId}/activate-vocabulary`, 'POST', { clientUpdatedAt: timestamp() }, learnerToken);
    const result = await activate(); assert.equal(result.status, 200); assert.equal(result.body.activatedCount, 2);
    assert.equal((await activate()).body.words.length, 2);
    const put = (index: number, status: string) => api('/learner/word-state', 'PUT', { publicationId: saved.publicationId, textReleaseId: text.textReleaseId,
      occurrenceId: words[index].id, status, clientUpdatedAt: timestamp() }, learnerToken);
    await put(0, 'NEW'); await put(1, 'LEARNED');
    const current = await manifest(f.lessonId);
    assert.deepEqual(current.manifest, saved.manifest);
    const states = (await api(`/learner/publications/${saved.publicationId}`, 'GET', undefined, learnerToken)).body.words;
    assert.equal(states.find((w: any) => w.occurrenceId === words[0].id).status, 'NEW');
    assert.equal(states.find((w: any) => w.occurrenceId === words[1].id).status, 'LEARNED');
    const again = await activate();
    assert.equal(again.body.words.find((w: any) => w.occurrenceId === words[0].id).status, 'LEARNING');
    assert.equal(again.body.words.find((w: any) => w.occurrenceId === words[1].id).status, 'LEARNED');
    const library = (await api('/learner/words', 'GET', undefined, learnerToken)).body.words.filter((w: any) => w.lessonId === f.lessonId);
    assert.equal(library.filter((w: any) => w.status === 'LEARNING').length, 1);
    assert.equal((await api(`/learner/publications/${saved.publicationId}`)).body.words.length, 0, 'learner states are private');
    await api(`/admin/lessons/${f.lessonId}/unpublish`, 'POST', {});
    assert.equal((await activate()).status, 404);
  });
});

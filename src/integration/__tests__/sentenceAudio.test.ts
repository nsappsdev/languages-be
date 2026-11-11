import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { startTestServer, createTestAdminUser, prisma, config, TestServer } from './helpers/authoringTestApp';
import { installFakeElevenLabsFetch } from './helpers/fakeElevenLabsFetch';
import { runGenerateNarrationJob } from '../../lib/textAudioPipeline';
import { failExpiredVocabularyJobs } from '../../lib/audioJobs';
import { readAudioAssetRange } from '../../lib/audioAssetStorage';
import { decodeWav } from '../../lib/pcmWav';
import { runGenerateVocabularyJob } from '../../lib/standaloneVocabulary';

describe('sentence generation through authoring API', () => {
  let server: TestServer;
  let token: string;
  let restore: () => void;
  let calls: { text: string; previous_text?: string; next_text?: string }[] = [];
  let failText = '';
  let uncertain = false;
  before(async () => {
    config.elevenLabs.apiKey = 'synthetic-test';
    config.elevenLabs.defaultVoiceId = 'synthetic-test';
    server = await startTestServer();
    token = (await createTestAdminUser()).token;
    restore = installFakeElevenLabsFetch();
    const synthetic = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url).includes('api.elevenlabs.io')) {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        if (body.text === failText) {
          failText = '';
          if (uncertain) throw new Error('Connection lost after dispatch');
          return new Response('{}', { status: 429 });
        }
      }
      return synthetic(url, init);
    };
  });
  after(async () => { restore(); await server.close(); await prisma.$disconnect(); });
  async function api(path: string, method = 'GET', body?: unknown, key = crypto.randomUUID()) {
    const response = await fetch(server.baseUrl + '/api' + path, { method,
      headers: { authorization: `Bearer ${token}`, 'content-type': 'application/json', 'Idempotency-Key': key },
      body: body === undefined ? undefined : JSON.stringify(body) });
    return { status: response.status, body: await response.json() };
  }
  async function create(text: string) {
    const lesson = (await api('/lessons', 'POST', { title: 'Sentence test', items: [{ text }] })).body.lesson;
    const base = `/admin/lessons/${lesson.id}/texts/${lesson.items[0].id}`;
    return { base, lesson, workspace: (await api(base)).body.text };
  }
  async function execute(id: string) {
    const job = await prisma.audioJob.update({ where: { id }, data: { status: 'RUNNING' } });
    await runGenerateNarrationJob(prisma, job);
    return prisma.audioJob.findUniqueOrThrow({ where: { id } });
  }

  it('generates every sentence separately, publishes assembled audio, and regenerates only the chosen sentence', async () => {
    calls = [];
    const { base, lesson, workspace } = await create('She felt overwhelmed. The noise faded. It was quiet.');
    const input = { contentRevisionId: workspace.contentRevision.id };
    const key = crypto.randomUUID();
    const requested = await api(base + '/narration-jobs', 'POST', input, key);
    assert.equal(requested.status, 202);
    assert.equal((await api(base + '/narration-jobs', 'POST', input, key)).body.job.id, requested.body.job.id);
    assert.equal((await execute(requested.body.job.id)).status, 'SUCCEEDED');
    assert.equal(calls.length, 3);
    assert.equal(calls[1].previous_text, 'She felt overwhelmed.');
    assert.equal(calls[1].next_text, 'It was quiet.');
    const first = (await api(base)).body.text;
    assert.equal(first.narration.sentences.length, 3);
    const all = await prisma.audioAsset.findUniqueOrThrow({ where: { id: first.narration.assetId } });
    const samples = [] as number[];
    for (const sentence of first.narration.sentences) {
      const asset = await prisma.audioAsset.findUniqueOrThrow({ where: { id: sentence.assetId } });
      assert.equal(asset.kind, 'SENTENCE');
      samples.push(...decodeWav(readAudioAssetRange(asset.storageKey, 0, asset.byteLength)!.buffer).samples);
    }
    assert.deepEqual(decodeWav(readAudioAssetRange(all.storageKey, 0, all.byteLength)!.buffer).samples, Int16Array.from(samples));
    const published = await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {});
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const immutable = await prisma.lessonPublication.findUniqueOrThrow({ where: { id: published.body.publicationId } });
    assert.equal((immutable.manifest as any).texts[0].narrationSource, 'SENTENCES');
    const occurrences = (await api(base + '/occurrences')).body;
    await api(base + '/vocabulary/import', 'POST', { alignmentId: occurrences.alignmentId, expectedDraftVersion: occurrences.draftVersion,
      entries: [{ occurrenceId: occurrences.occurrences[2].id, translation: 'ճնշված' }] });
    const plan = (await api(base + '/vocabulary/audio-plan')).body;
    const wordJob = (await api(base + '/vocabulary/audio-jobs', 'POST', { expectedDraftVersion: plan.draftVersion })).body.job;
    await runGenerateVocabularyJob(prisma, await prisma.audioJob.update({ where: { id: wordJob.id }, data: { status: 'RUNNING' } }));
    const recording = (await api(base + '/occurrences')).body.occurrences[2].clipAssetId;
    const beforeRegeneration = calls.length;
    const secondJob = await api(base + '/narration-jobs', 'POST', { ...input, regenerateSentenceIndex: 1 });
    assert.equal((await execute(secondJob.body.job.id)).status, 'SUCCEEDED');
    const second = (await api(base)).body.text;
    assert.equal(calls.length, beforeRegeneration + 1);
    assert.equal(calls[calls.length - 1].text, 'The noise faded.');
    assert.equal(first.narration.sentences[0].assetId, second.narration.sentences[0].assetId);
    assert.notEqual(first.narration.sentences[1].assetId, second.narration.sentences[1].assetId);
    assert.equal((await api(base + '/occurrences')).body.occurrences[2].translations[0].translation, 'ճնշված');
    assert.equal((await api(base + '/occurrences')).body.occurrences[2].clipAssetId, recording);
    assert.equal((await api(base + '/readiness')).body.readiness.readyForPublication, true);
    assert.deepEqual(await prisma.lessonPublication.findUniqueOrThrow({ where: { id: immutable.id } }), immutable);
    assert.equal((await api(base + '/narration-jobs', 'POST', { ...input, expectedDraftVersion: workspace.draftVersion })).status, 409);
  });

  it('reuses completed sentences after a rate limit and rejects invalid sentence breaks', async () => {
    calls = [];
    const { base, workspace } = await create('First sentence. Second sentence. Third sentence.');
    const input = { contentRevisionId: workspace.contentRevision.id };
    assert.equal((await api(base + '/narration-jobs', 'POST', { ...input, sentenceEndOffsets: [2] })).status, 422);
    failText = 'Second sentence.';
    const requested = await api(base + '/narration-jobs', 'POST', input);
    const failed = await execute(requested.body.job.id);
    assert.equal(failed.status, 'FAILED');
    assert.equal(failed.retryable, true);
    assert.match(failed.errorMessage!, /Sentence 2/);
    assert.equal((await api(`/admin/audio-jobs/${failed.id}/retry`, 'POST', {})).status, 202);
    assert.equal((await execute(failed.id)).status, 'SUCCEEDED');
    assert.deepEqual(calls.map(call => call.text), ['First sentence.', 'Second sentence.', 'Second sentence.', 'Third sentence.']);
  });

  it('blocks uncertain dispatches until explicit sentence regeneration and expires crashed jobs', async () => {
    calls = [];
    const { base, workspace } = await create('One sentence. Another sentence.');
    const input = { contentRevisionId: workspace.contentRevision.id };
    failText = 'Another sentence.';
    uncertain = true;
    const first = await api(base + '/narration-jobs', 'POST', input);
    assert.equal((await execute(first.body.job.id)).retryable, false);
    const retry = await api(base + '/narration-jobs', 'POST', input);
    assert.equal((await execute(retry.body.job.id)).status, 'FAILED');
    assert.equal(calls.length, 2);
    const regenerate = await api(base + '/narration-jobs', 'POST', { ...input, regenerateSentenceIndex: 1 });
    assert.equal((await execute(regenerate.body.job.id)).status, 'SUCCEEDED');
    assert.equal(calls.length, 3);
    const crash = await api(base + '/narration-jobs', 'POST', input);
    await prisma.audioJob.update({ where: { id: crash.body.job.id }, data: { status: 'RUNNING', leaseUntil: new Date(0) } });
    await failExpiredVocabularyJobs(prisma);
    assert.equal((await prisma.audioJob.findUniqueOrThrow({ where: { id: crash.body.job.id } })).status, 'FAILED');
  });

  it('respects reviewed breaks and rejects a break through a selected phrase before dispatch', async () => {
    calls = [];
    const text = 'She took a deep breath. Then she smiled.';
    const { base, workspace } = await create(text);
    const input = { contentRevisionId: workspace.contentRevision.id, sentenceEndOffsets: [text.length] };
    const first = await api(base + '/narration-jobs', 'POST', input);
    assert.equal((await execute(first.body.job.id)).status, 'SUCCEEDED');
    assert.deepEqual(calls.map(call => call.text), [text]);
    const occurrences = (await api(base + '/occurrences')).body;
    const deep = occurrences.occurrences.find((word: { text: string }) => word.text === 'deep');
    const breath = occurrences.occurrences.find((word: { text: string }) => word.text === 'breath');
    const selected = await api(base + '/selection', 'PATCH', { alignmentId: occurrences.alignmentId,
      changes: [{ occurrenceId: deep.id, endOccurrenceId: breath.id, selected: true }] });
    assert.equal(selected.status, 200);
    const invalid = await api(base + '/narration-jobs', 'POST', { ...input, sentenceEndOffsets: [text.indexOf('breath'), text.length] });
    assert.equal(invalid.status, 422);
    assert.match(invalid.body.message, /learning phrase/);
    assert.equal(calls.length, 1);
  });
});

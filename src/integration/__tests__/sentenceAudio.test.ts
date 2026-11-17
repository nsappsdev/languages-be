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
  let misaligned = '';
  let malformed = '';
  let repairRequests = 0;
  let repairFailure = false;
  let budgetUsed = 100;
  before(async () => {
    config.elevenLabs.apiKey = 'synthetic-test';
    config.elevenLabs.defaultVoiceId = 'synthetic-test';
    server = await startTestServer();
    token = (await createTestAdminUser()).token;
    restore = installFakeElevenLabsFetch();
    const synthetic = global.fetch;
    global.fetch = async (url, init) => {
      if (String(url).endsWith('/user/subscription')) return new Response(JSON.stringify({ character_count: budgetUsed, character_limit: 1000000 }), { status: 200 });
      if (String(url).endsWith('/forced-alignment')) {
        repairRequests++;
        if (repairFailure) throw new Error('Connection lost after alignment dispatch');
        if ((init?.body as FormData).get('text') === misaligned) return new Response('{}', { status: 422 });
      }
      if (String(url).includes('/text-to-speech/')) {
        const body = JSON.parse(String(init?.body));
        calls.push(body);
        if (body.text === failText) {
          failText = '';
          if (uncertain) throw new Error('Connection lost after dispatch');
          return new Response('{}', { status: 429 });
        }
      }
      const response = await synthetic(url, init);
      if (String(url).includes('/text-to-speech/') && JSON.parse(String(init?.body)).text === misaligned) {
        const body = await response.json();
        body.alignment.characters[0] = '#';
        return new Response(JSON.stringify(body), { status: 200 });
      }
      if (String(url).includes('/text-to-speech/') && JSON.parse(String(init?.body)).text === malformed) {
        const body = await response.json();
        body.alignment = { characters: ['A'] };
        return new Response(JSON.stringify(body), { status: 200 });
      }
      return response;
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

  it('selects and imports before audio, generates one sentence first, and preserves translations through a saved split', async () => {
    calls = [];
    const text = 'We look after cats. They look after dogs.';
    const { base, lesson, workspace } = await create(text);
    const source = (await api(base + '/occurrences')).body;
    assert.equal(source.occurrences.length, 8);
    assert.ok(source.occurrences.every((word: any) => word.speechStartSample === null));
    const imported = await api(base + '/vocabulary/import', 'POST', { alignmentId: source.alignmentId, expectedDraftVersion: source.draftVersion,
      entries: [{ occurrenceId: source.occurrences[1].id, endOccurrenceId: source.occurrences[2].id, translation: 'հոգ տանել' }] });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal((await api(base + '/vocabulary/audio-plan')).status, 200);
    const request = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id, sentenceIndex: 1 });
    assert.equal((await execute(request.body.job.id)).status, 'SUCCEEDED');
    assert.deepEqual(calls.map(call => call.text), ['They look after dogs.']);
    const partial = (await api(base)).body.text;
    assert.equal(partial.sentences[0].assetId, null);
    assert.ok(partial.sentences[1].assetId);
    assert.equal((await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {})).status, 422);
    assert.equal((await api(base + '/occurrences')).body.occurrences[1].translations[0].translation, 'հոգ տանել');
    const plan = await api(base + '/sentences', 'PUT', { contentRevisionId: workspace.contentRevision.id,
      expectedDraftVersion: partial.draftVersion, sentenceEndOffsets: [text.length] });
    assert.equal(plan.status, 200);
    const joined = (await api(base)).body.text;
    assert.equal(joined.sentences.length, 1);
    assert.equal(calls.length, 1, 'saving sentence breaks never dispatches speech generation');
    assert.equal((await api(base + '/occurrences')).body.occurrences[1].translations[0].translation, 'հոգ տանել');
    const finish = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id });
    assert.equal((await execute(finish.body.job.id)).status, 'SUCCEEDED');
    assert.equal(calls.at(-1)!.text, text, 'generation uses the saved sentence plan');
    assert.equal(await prisma.audioAsset.count({ where: { textId: lesson.items[0].id, kind: 'NARRATION' } }), 0);
  });

  it('imports more than 500 matching occurrences before any audio exists', async () => {
    const { base, lesson } = await create(Array.from({ length: 501 }, () => 'cat').join(' ') + '.');
    const source = (await api(base + '/occurrences')).body;
    const imported = await api(base + '/vocabulary/import', 'POST', { alignmentId: source.alignmentId, expectedDraftVersion: source.draftVersion,
      entries: source.occurrences.map((word: any) => ({ occurrenceId: word.id, translation: 'կատու' })) });
    assert.equal(imported.status, 200, JSON.stringify(imported.body));
    assert.equal(imported.body.importedCount, 501);
    assert.equal(await prisma.audioJob.count({ where: { textId: lesson.items[0].id } }), 0);
  });

  it('reports the specific sentence with bad timing while keeping the whole text selectable', async () => {
    const { base, lesson, workspace } = await create('A clear sentence. A mismatched sentence.');
    misaligned = 'A mismatched sentence.';
    const request = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id });
    assert.equal((await execute(request.body.job.id)).status, 'SUCCEEDED');
    misaligned = '';
    const current = (await api(base)).body.text;
    assert.ok(current.sentences[1].alignmentIssue);
    assert.ok(!current.sentences[0].alignmentIssue);
    const source = (await api(base + '/occurrences')).body;
    assert.equal(source.occurrences.length, 6);
    assert.equal(source.occurrences[0].mappingStatus, 'MAPPED');
    assert.equal(source.occurrences[4].mappingStatus, 'UNMAPPED');
    assert.equal((await api(base + '/vocabulary/import', 'POST', { alignmentId: source.alignmentId, expectedDraftVersion: source.draftVersion,
      entries: [{ occurrenceId: source.occurrences[4].id, translation: 'անհամապատասխան' }] })).status, 200);
    assert.equal((await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {})).status, 422);
  });

  it('reuses existing audio with rounded end timestamps and publishes without another provider request', async () => {
    calls = [];
    const { base, lesson, workspace } = await create('SPY');
    const input = { contentRevisionId: workspace.contentRevision.id };
    const requested = await api(base + '/narration-jobs', 'POST', input);
    assert.equal((await execute(requested.body.job.id)).status, 'SUCCEEDED');
    assert.equal(calls.length, 1);
    const saved = await prisma.sentenceAudio.findFirstOrThrow({ where: { textId: lesson.items[0].id }, include: { asset: true } });
    const asset = saved.asset!;
    const originalAudio = Buffer.from(readAudioAssetRange(asset.storageKey, 0, asset.byteLength)!.buffer);
    const alignment = saved.rawAlignment as { characters: string[]; character_start_times_seconds: number[]; character_end_times_seconds: number[] };
    alignment.character_end_times_seconds[alignment.characters.length - 1] = (asset.frameCount! + 6) / asset.sampleRate!;
    await prisma.sentenceAudio.update({ where: { id: saved.id }, data: { rawAlignment: alignment } });
    await prisma.audioTiming.deleteMany({ where: { assetId: asset.id } });
    const oldWorkspace = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId: lesson.items[0].id } });
    await prisma.textAlignment.update({ where: { id: oldWorkspace.currentAlignmentId! }, data: { algorithmVersion: 2, status: 'NEEDS_REVIEW' } });
    const cached = (await api(base)).body.text;
    assert.equal(cached.sentences[0].alignmentIssue, undefined);
    const refresh = await api(base + '/narration-jobs', 'POST', input);
    assert.equal((await execute(refresh.body.job.id)).status, 'SUCCEEDED');
    assert.equal(calls.length, 1, 'existing audio is reused, not regenerated');
    const occurrence = (await api(base + '/occurrences')).body.occurrences[0];
    assert.equal(occurrence.speechEndSample, asset.frameCount);
    const after = await prisma.sentenceAudio.findUniqueOrThrow({ where: { id: saved.id } });
    assert.equal(after.assetId, asset.id);
    assert.deepEqual(after.rawAlignment, alignment, 'provider timestamps remain unchanged');
    assert.deepEqual(readAudioAssetRange(asset.storageKey, 0, asset.byteLength)!.buffer, originalAudio);
    const published = await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {});
    assert.equal(published.status, 201, JSON.stringify(published.body));
    assert.equal(calls.length, 1, 'publication also makes no provider request');
  });

  it('automatically repairs malformed new timings once while preserving the generated recording', async () => {
    calls = []; repairRequests = 0;
    malformed = 'Repair this sentence.';
    const { base, lesson, workspace } = await create(malformed);
    const requested = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id });
    assert.equal((await execute(requested.body.job.id)).status, 'SUCCEEDED');
    malformed = '';
    assert.equal(calls.length, 1);
    assert.equal(repairRequests, 1);
    const saved = await prisma.sentenceAudio.findFirstOrThrow({ where: { textId: lesson.items[0].id } });
    assert.deepEqual(saved.rawAlignment, { characters: ['A'] });
    const current = (await api(base)).body.text;
    assert.equal(current.sentences[0].assetId, saved.assetId);
    assert.equal(current.sentences[0].alignmentIssue, undefined);
    assert.equal(current.alignmentSummary.status, 'OK');
    const repair = await api(base + '/timing-repair-jobs', 'POST', { contentRevisionId: current.contentRevision.id, expectedDraftVersion: current.draftVersion });
    assert.equal((await execute(repair.body.job.id)).status, 'SUCCEEDED');
    assert.equal(repairRequests, 1);
    assert.equal(calls.length, 1);
    assert.equal((await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {})).status, 201);
  });

  it('honors the usage ceiling and repairs existing timings without generating missing sentences', async () => {
    calls = []; repairRequests = 0; budgetUsed = 300000;
    malformed = 'Saved audio.';
    const { base, workspace } = await create('Saved audio. Missing audio.');
    const request = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id, sentenceIndex: 0 });
    assert.equal((await execute(request.body.job.id)).status, 'SUCCEEDED');
    malformed = '';
    assert.equal(repairRequests, 0);
    const current = (await api(base)).body.text;
    assert.match(current.sentences[0].repairError, /usage limit/);
    assert.equal(current.sentences[1].assetId, null);
    budgetUsed = 100;
    const key = crypto.randomUUID();
    const input = { contentRevisionId: current.contentRevision.id, expectedDraftVersion: current.draftVersion };
    const repair = await api(base + '/timing-repair-jobs', 'POST', input, key);
    assert.equal((await execute(repair.body.job.id)).status, 'SUCCEEDED');
    assert.equal((await api(base + '/timing-repair-jobs', 'POST', input, key)).body.job.id, repair.body.job.id);
    const after = (await api(base)).body.text;
    assert.equal(after.sentences[0].alignmentIssue, undefined);
    assert.equal(after.sentences[0].assetId, current.sentences[0].assetId);
    assert.equal(after.sentences[1].assetId, null);
    assert.equal(calls.length, 1, 'repair never generates a missing sentence');
    assert.equal(repairRequests, 1);
  });

  it('does not repeat an uncertain alignment request or break the text editor', async () => {
    calls = []; repairRequests = 0; repairFailure = true;
    malformed = 'Keep this audio.';
    const { base, workspace } = await create(malformed);
    const request = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id });
    assert.equal((await execute(request.body.job.id)).status, 'SUCCEEDED');
    malformed = ''; repairFailure = false;
    const current = (await api(base)).body.text;
    assert.equal(current.sentences[0].canRepair, false);
    assert.ok(current.sentences[0].assetId);
    assert.equal((await api(base + '/occurrences')).body.occurrences.length, 3);
    const repair = await api(base + '/timing-repair-jobs', 'POST', { contentRevisionId: current.contentRevision.id, expectedDraftVersion: current.draftVersion });
    assert.equal((await execute(repair.body.job.id)).status, 'SUCCEEDED');
    assert.equal(calls.length, 1);
    assert.equal(repairRequests, 1);
  });

  it('upgrades existing drafts without losing translations, clips or immutable publications', async () => {
    calls = []; repairRequests = 0;
    const { base, lesson, workspace } = await create('Keep my words.');
    const source = (await api(base + '/occurrences')).body;
    await api(base + '/vocabulary/import', 'POST', { alignmentId: source.alignmentId, expectedDraftVersion: source.draftVersion,
      entries: [{ occurrenceId: source.occurrences[2].id, translation: 'բառեր' }] });
    const request = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id });
    await execute(request.body.job.id);
    const plan = (await api(base + '/vocabulary/audio-plan')).body;
    const wordJob = (await api(base + '/vocabulary/audio-jobs', 'POST', { expectedDraftVersion: plan.draftVersion })).body.job;
    await runGenerateVocabularyJob(prisma, await prisma.audioJob.update({ where: { id: wordJob.id }, data: { status: 'RUNNING' } }));
    const published = await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {});
    assert.equal(published.status, 201);
    const immutable = await prisma.lessonPublication.findUniqueOrThrow({ where: { id: published.body.publicationId } });
    const before = (await api(base)).body.text;
    await prisma.textAlignment.update({ where: { id: before.alignmentSummary.id }, data: { algorithmVersion: 2 } });
    assert.equal((await api(base)).body.text.alignmentSummary.id, before.alignmentSummary.id, 'correct older timings retain their identities');
    assert.equal((await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {})).status, 200, 'unchanged publication is reused');
    await prisma.textWorkspace.update({ where: { textId: lesson.items[0].id }, data: { timingValidationKey: null } });
    await prisma.textAlignment.update({ where: { id: before.alignmentSummary.id }, data: { algorithmVersion: 2, status: 'NEEDS_REVIEW' } });
    const after = (await api(base)).body.text;
    assert.equal(after.alignmentSummary.status, 'OK');
    assert.notEqual(after.alignmentSummary.id, before.alignmentSummary.id);
    assert.equal(after.sentences[0].assetId, before.sentences[0].assetId);
    const words = (await api(base + '/occurrences')).body.occurrences;
    assert.equal(words[2].translations[0].translation, 'բառեր');
    assert.equal(words[2].selected, true);
    assert.ok(words[2].clipAssetId);
    assert.equal((await api(base + '/readiness')).body.readiness.readyForPublication, true);
    assert.deepEqual(await prisma.lessonPublication.findUniqueOrThrow({ where: { id: immutable.id } }), immutable);
    assert.equal(calls.length, 1); assert.equal(repairRequests, 0);
    assert.equal((await api(base)).body.text.alignmentSummary.id, after.alignmentSummary.id, 'upgrade runs once');
  });

  it('does not dispatch a repair after the source text changes', async () => {
    calls = []; repairRequests = 0;
    const { base, workspace } = await create('Original audio.');
    await execute((await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id })).body.job.id);
    const current = (await api(base)).body.text;
    const input = { contentRevisionId: current.contentRevision.id, expectedDraftVersion: current.draftVersion };
    assert.equal((await api(base + '/timing-repair-jobs', 'POST', { ...input, expectedDraftVersion: -1 })).status, 400);
    assert.equal((await api(base + '/timing-repair-jobs', 'POST', { ...input, expectedDraftVersion: current.draftVersion - 1 })).status, 409);
    const repair = await api(base + '/timing-repair-jobs', 'POST', input);
    await api(base + '/content-revisions', 'POST', { text: 'Changed source.', sourceLanguage: 'en' });
    assert.equal((await execute(repair.body.job.id)).status, 'FAILED');
    assert.equal(calls.length, 1); assert.equal(repairRequests, 0);
  });

  it('repairs an existing full recording without converting it to sentence generation', async () => {
    calls = []; repairRequests = 0;
    const { base, lesson, workspace } = await create('Legacy audio.');
    const job = await prisma.audioJob.create({ data: { textId: lesson.items[0].id, kind: 'GENERATE_NARRATION', actorId: 'legacy-test',
      idempotencyKey: crypto.randomUUID(), requestHash: crypto.randomUUID(), requestPayload: { contentRevisionId: workspace.contentRevision.id, voiceId: 'synthetic-test' } } });
    assert.equal((await execute(job.id)).status, 'SUCCEEDED');
    const old = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId: lesson.items[0].id } });
    const narration = await prisma.textNarration.findUniqueOrThrow({ where: { id: old.currentNarrationId! } });
    await prisma.textAlignment.update({ where: { id: old.currentAlignmentId! }, data: { algorithmVersion: 1 } });
    await prisma.textNarration.update({ where: { id: narration.id }, data: { rawAlignment: { characters: ['invalid'] } } });
    const current = (await api(base)).body.text;
    assert.equal(current.alignmentSummary.status, 'NEEDS_REVIEW');
    const repair = await api(base + '/timing-repair-jobs', 'POST', { contentRevisionId: current.contentRevision.id, expectedDraftVersion: current.draftVersion });
    assert.equal((await execute(repair.body.job.id)).status, 'SUCCEEDED');
    const after = (await api(base)).body.text;
    assert.equal(after.narration.assetId, narration.assetId);
    assert.equal(after.alignmentSummary.status, 'OK');
    assert.equal(calls.length, 1); assert.equal(repairRequests, 1);
    assert.equal((await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {})).status, 201);
  });

  it('generates every sentence separately, publishes only sentence assets, and regenerates only the chosen sentence', async () => {
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
    assert.equal(first.narration.assetId, null);
    assert.equal(await prisma.audioAsset.count({ where: { textId: lesson.items[0].id, kind: 'NARRATION' } }), 0);
    for (const sentence of first.sentences) {
      const asset = await prisma.audioAsset.findUniqueOrThrow({ where: { id: sentence.assetId } });
      assert.equal(asset.kind, 'SENTENCE');
      assert.equal(sentence.endSample - sentence.startSample, asset.frameCount);
    }
    const published = await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {});
    assert.equal(published.status, 201, JSON.stringify(published.body));
    const immutable = await prisma.lessonPublication.findUniqueOrThrow({ where: { id: published.body.publicationId } });
    assert.equal((immutable.manifest as any).schemaVersion, 3);
    assert.equal((immutable.manifest as any).texts[0].narration.kind, 'sentences');
    assert.deepEqual(new Set(immutable.assetIds), new Set(first.sentences.map((s: { assetId: string }) => s.assetId)));
    const audio = await fetch(`${server.baseUrl}/api/learner/audio-assets/${first.sentences[0].assetId}/content?publicationId=${immutable.id}`, { headers: { authorization: `Bearer ${token}` } });
    assert.equal(audio.status, 200);
    assert.ok((await audio.arrayBuffer()).byteLength > 44);
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
    assert.ok(recording);
    assert.equal((await api(base + '/occurrences')).body.occurrences[2].clipAssetId, null, 'a new alignment must not silently reuse old occurrence clips');
    assert.equal((await api(base + '/readiness')).body.readiness.readyForPublication, false);
    const refreshedPlan = (await api(base + '/vocabulary/audio-plan')).body;
    const refreshedJob = (await api(base + '/vocabulary/audio-jobs', 'POST', { expectedDraftVersion: refreshedPlan.draftVersion })).body.job;
    await runGenerateVocabularyJob(prisma, await prisma.audioJob.update({ where: { id: refreshedJob.id }, data: { status: 'RUNNING' } }));
    assert.equal((await api(base + '/readiness')).body.readiness.readyForPublication, true);
    assert.equal(calls.length, beforeRegeneration + 1, 'extraction makes no provider request');
    assert.deepEqual(await prisma.lessonPublication.findUniqueOrThrow({ where: { id: immutable.id } }), immutable);
    assert.equal((await api(base + '/narration-jobs', 'POST', { ...input, expectedDraftVersion: workspace.draftVersion })).status, 409);
  });

  it('extracts each phrase occurrence from its own sentence without TTS and preserves immutable publications', async () => {
    const { base, lesson, workspace } = await create('Same phrase begins. We hear same phrase.');
    const initial = (await api(base + '/occurrences')).body;
    await api(base + '/vocabulary/import', 'POST', { alignmentId: initial.alignmentId, expectedDraftVersion: initial.draftVersion,
      entries: [0, 5].map(index => ({ occurrenceId: initial.occurrences[index].id, endOccurrenceId: initial.occurrences[index + 1].id, translation: 'նույն արտահայտությունը' })) });
    const pending = (await api(base + '/vocabulary/audio-plan')).body;
    assert.equal(pending.source, 'sentences');
    assert.equal(pending.canPrepare, false);
    assert.equal((await api(base + '/vocabulary/audio-jobs', 'POST', { expectedDraftVersion: pending.draftVersion })).status, 422);
    const narration = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id });
    assert.equal((await execute(narration.body.job.id)).status, 'SUCCEEDED');
    const before = calls.length;
    const plan = (await api(base + '/vocabulary/audio-plan')).body;
    assert.equal(plan.extractCount, 2);
    assert.equal(plan.generateCount, 0);
    const providerKey = config.elevenLabs.apiKey;
    config.elevenLabs.apiKey = '';
    try {
      const queued = await api(base + '/vocabulary/audio-jobs', 'POST', { expectedDraftVersion: plan.draftVersion });
      const job = await prisma.audioJob.update({ where: { id: queued.body.job.id }, data: { status: 'RUNNING' } });
      assert.equal(job.reservedCharacters, 0);
      await runGenerateVocabularyJob(prisma, job);
      assert.equal((await prisma.audioJob.findUniqueOrThrow({ where: { id: job.id } })).status, 'SUCCEEDED');
    } finally { config.elevenLabs.apiKey = providerKey; }
    assert.equal(calls.length, before);
    const clips = await prisma.wordClip.findMany({ where: { textId: lesson.items[0].id }, include: { asset: true } });
    assert.equal(clips.length, 2);
    assert.notEqual(clips[0].assetId, clips[1].assetId, 'repeated phrases retain occurrence-specific recordings');
    const current = (await api(base)).body.text;
    for (const clip of clips) {
      const sentence = current.sentences.find((s: any) => clip.startSample >= s.startSample && clip.endSample <= s.endSample);
      const source = await prisma.audioAsset.findUniqueOrThrow({ where: { id: sentence.assetId } });
      const original = decodeWav(readAudioAssetRange(source.storageKey, 0, source.byteLength)!.buffer);
      const extracted = decodeWav(readAudioAssetRange(clip.asset.storageKey, 0, clip.asset.byteLength)!.buffer);
      assert.deepEqual(extracted.samples, original.samples.slice(clip.startSample - sentence.startSample, clip.endSample - sentence.startSample));
    }
    const ready = (await api(base + '/vocabulary/audio-plan')).body;
    assert.equal(ready.reuseCount, 2);
    assert.equal(ready.extractCount, 0);
    const published = await api(`/admin/lessons/${lesson.id}/publish`, 'POST', {});
    assert.equal(published.status, 201);
    const immutable = await prisma.lessonPublication.findUniqueOrThrow({ where: { id: published.body.publicationId } });
    assert.ok((immutable.manifest as any).texts[0].occurrences.filter((word: any) => word.learning).every((word: any) => !word.learning.clipSource));
    const regenerate = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id, regenerateSentenceIndex: 1 });
    assert.equal((await execute(regenerate.body.job.id)).status, 'SUCCEEDED');
    assert.equal((await api(base + '/vocabulary/audio-plan')).body.extractCount, 2);
    assert.deepEqual(await prisma.lessonPublication.findUniqueOrThrow({ where: { id: immutable.id } }), immutable);
    for (const clip of clips) assert.ok(readAudioAssetRange(clip.asset.storageKey, 0, clip.asset.byteLength));
  });

  it('rejects sentence clip preparation after the draft changes', async () => {
    const { base, lesson, workspace } = await create('A stable sentence.');
    const requested = await api(base + '/narration-jobs', 'POST', { contentRevisionId: workspace.contentRevision.id });
    await execute(requested.body.job.id);
    const source = (await api(base + '/occurrences')).body;
    await api(base + '/vocabulary/import', 'POST', { alignmentId: source.alignmentId, expectedDraftVersion: source.draftVersion,
      entries: [{ occurrenceId: source.occurrences[1].id, translation: 'կայուն' }] });
    const plan = (await api(base + '/vocabulary/audio-plan')).body;
    const queued = (await api(base + '/vocabulary/audio-jobs', 'POST', { expectedDraftVersion: plan.draftVersion })).body.job;
    await prisma.textWorkspace.update({ where: { textId: lesson.items[0].id }, data: { draftVersion: { increment: 1 } } });
    const before = calls.length;
    await runGenerateVocabularyJob(prisma, await prisma.audioJob.update({ where: { id: queued.id }, data: { status: 'RUNNING' } }));
    assert.equal((await prisma.audioJob.findUniqueOrThrow({ where: { id: queued.id } })).status, 'FAILED');
    assert.equal(await prisma.wordClip.count({ where: { textId: lesson.items[0].id } }), 0);
    assert.equal(calls.length, before);
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
    assert.equal((await api(base)).body.text.sentences[1].requiresRegeneration, true);
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

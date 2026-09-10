import { strict as assert } from 'node:assert';
import { after, before, describe, it } from 'node:test';
import { startTestServer, createTestAdminUser, prisma, type TestServer } from './helpers/authoringTestApp';
import { installFakeElevenLabsFetch } from './helpers/fakeElevenLabsFetch';
import { runAudioWorkerOnceForTests } from '../../workers/audioWorker';

describe('text authoring API (generate -> align -> select -> translate -> extract -> readiness -> release)', () => {
  let server: TestServer;
  let token: string;
  let restoreFetch: () => void;

  before(async () => {
    // A previous test run against this same disposable DB may have left
    // never-drained QUEUED jobs behind (e.g. the intentionally-unprocessed
    // conflict-check job below); clear those so FIFO claiming in this run is
    // deterministic. Only ever removes rows still in the QUEUED state.
    await prisma.audioJob.deleteMany({ where: { status: 'QUEUED' } });
    server = await startTestServer();
    const admin = await createTestAdminUser();
    token = admin.token;
    restoreFetch = installFakeElevenLabsFetch();
  });

  after(async () => {
    restoreFetch();
    await server.close();
  });

  async function drainJob(jobId: string) {
    for (let i = 0; i < 25; i += 1) {
      const job = await prisma.audioJob.findUnique({ where: { id: jobId } });
      if (job && job.status !== 'QUEUED' && job.status !== 'RUNNING') {
        return job;
      }
      await runAudioWorkerOnceForTests();
    }
    throw new Error(`Job ${jobId} did not settle after draining the queue`);
  }

  async function api(path: string, init: RequestInit = {}) {
    const res = await fetch(`${server.baseUrl}${path}`, {
      ...init,
      headers: { 'content-type': 'application/json', authorization: `Bearer ${token}`, ...(init.headers ?? {}) },
    });
    const body = await res.json().catch(() => null);
    return { status: res.status, body };
  }

  async function createLessonWithOneItem(title: string, text: string) {
    const created = await api('/api/lessons', {
      method: 'POST',
      body: JSON.stringify({
        title,
        items: [{ text, audioUrl: '', order: 0, segments: [{ text, startMs: 0, endMs: 1000 }] }],
      }),
    });
    assert.equal(created.status, 201);
    return { lessonId: created.body.lesson.id, textId: created.body.lesson.items[0].id };
  }

  it('drives the full authoring workflow for one text and keeps a second text-in-a-different-lesson fully isolated', async () => {
    const textOne = await createLessonWithOneItem('Lesson One', 'The cat sat on the mat with the cat.');
    const textTwo = await createLessonWithOneItem('Lesson Two', 'The cat ran away.');

    for (const { lessonId, textId } of [textOne, textTwo]) {
      const workspace = await api(`/api/admin/lessons/${lessonId}/texts/${textId}`);
      assert.equal(workspace.status, 200);
      assert.equal(workspace.body.text.audioGenerationConfigured, true);
    }

    // --- Save content revision (identical to legacy item text) ---
    const revisionOne = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/content-revisions`, {
      method: 'POST',
      body: JSON.stringify({ text: 'The cat sat on the mat with the cat.', sourceLanguage: 'en' }),
    });
    assert.equal(revisionOne.status, 201);
    const revisionIdOne = revisionOne.body.revision.id;

    const revisionTwo = await api(`/api/admin/lessons/${textTwo.lessonId}/texts/${textTwo.textId}/content-revisions`, {
      method: 'POST',
      body: JSON.stringify({ text: 'The cat ran away.', sourceLanguage: 'en' }),
    });
    assert.equal(revisionTwo.status, 201);
    const revisionIdTwo = revisionTwo.body.revision.id;

    // Saving byte-identical text again is a no-op (200, not a new revision).
    const noOp = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/content-revisions`, {
      method: 'POST',
      body: JSON.stringify({ text: 'The cat sat on the mat with the cat.', sourceLanguage: 'en' }),
    });
    assert.equal(noOp.status, 200);
    assert.equal(noOp.body.revision.id, revisionIdOne);

    // --- Generate narration (mocked provider via injected fetch) ---
    const jobOne = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/narration-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'gen-1' },
      body: JSON.stringify({ contentRevisionId: revisionIdOne }),
    });
    assert.equal(jobOne.status, 202);

    // Replaying the same idempotency key + payload returns the same job, not a second one.
    const jobOneReplay = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/narration-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'gen-1' },
      body: JSON.stringify({ contentRevisionId: revisionIdOne }),
    });
    assert.equal(jobOneReplay.status, 202);
    assert.equal(jobOneReplay.body.job.id, jobOne.body.job.id);
    assert.equal(jobOneReplay.body.replay, true);

    const jobTwo = await api(`/api/admin/lessons/${textTwo.lessonId}/texts/${textTwo.textId}/narration-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'gen-1' },
      body: JSON.stringify({ contentRevisionId: revisionIdTwo }),
    });
    assert.equal(jobTwo.status, 202);

    // Drive the in-process worker synchronously (no real timers/network),
    // draining until each specific job settles regardless of claim order.
    await drainJob(jobOne.body.job.id);
    await drainJob(jobTwo.body.job.id);

    const jobOneStatus = await api(`/api/admin/audio-jobs/${jobOne.body.job.id}`);
    assert.equal(jobOneStatus.body.job.status, 'SUCCEEDED');
    const jobTwoStatus = await api(`/api/admin/audio-jobs/${jobTwo.body.job.id}`);
    assert.equal(jobTwoStatus.body.job.status, 'SUCCEEDED');

    const workspaceOneAfterGen = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}`);
    const narrationIdOne = workspaceOneAfterGen.body.text.narration.id;
    const alignmentIdOne = workspaceOneAfterGen.body.text.alignmentSummary.id;
    assert.equal(workspaceOneAfterGen.body.text.alignmentSummary.status, 'OK');

    // --- Occurrences: repeated word "cat" gets two distinct occurrence ids ---
    const occurrencesOne = await api(
      `/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/occurrences?alignmentId=${alignmentIdOne}`,
    );
    assert.equal(occurrencesOne.status, 200);
    const catOccurrences = occurrencesOne.body.occurrences.filter((o: any) => o.text.toLowerCase() === 'cat');
    assert.equal(catOccurrences.length, 2);
    assert.notEqual(catOccurrences[0].id, catOccurrences[1].id);

    // --- Select only the first "cat" occurrence (most words deliberately excluded) ---
    const selection = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/selection`, {
      method: 'PATCH',
      body: JSON.stringify({ alignmentId: alignmentIdOne, changes: [{ occurrenceId: catOccurrences[0].id, selected: true }] }),
    });
    assert.equal(selection.status, 200);
    const entryId = selection.body.entries[0].id;

    // --- Readiness before translation/clip: selected but incomplete ---
    const readinessBefore = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/readiness`);
    assert.equal(readinessBefore.body.readiness.selectedCount, 1);
    assert.equal(readinessBefore.body.readiness.selectedMissingTranslationCount, 1);
    assert.equal(readinessBefore.body.readiness.selectedMissingClipCount, 1);
    assert.equal(readinessBefore.body.readiness.readyForApproval, false);

    // --- Contextual translation for text one's entry ---
    const translated = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/vocabulary/${entryId}`, {
      method: 'PATCH',
      body: JSON.stringify({ translations: [{ languageCode: 'am', translation: 'կատու' }] }),
    });
    assert.equal(translated.status, 200);

    // --- Extract the clip for the selected occurrence ---
    const clipJob = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/clip-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'clip-1' },
      body: JSON.stringify({ narrationId: narrationIdOne, alignmentId: alignmentIdOne, occurrenceIds: [catOccurrences[0].id] }),
    });
    assert.equal(clipJob.status, 202);
    await drainJob(clipJob.body.job.id);
    const clipJobStatus = await api(`/api/admin/audio-jobs/${clipJob.body.job.id}`);
    assert.equal(clipJobStatus.body.job.status, 'SUCCEEDED');

    // --- Readiness now passes for the one selected+translated+clipped entry ---
    const readinessAfter = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/readiness`);
    assert.equal(readinessAfter.body.readiness.readyForApproval, true);
    assert.deepEqual(readinessAfter.body.readiness.eligibleEntryIds, [entryId]);

    // --- The clip asset streams back real bytes, matching persisted length, with Range support ---
    const clip = await prisma.wordClip.findFirst({ where: { entryId } });
    assert.ok(clip);
    const assetRes = await fetch(`${server.baseUrl}/api/admin/audio-assets/${clip!.assetId}/content`, {
      headers: { authorization: `Bearer ${token}`, range: 'bytes=0-3' },
    });
    assert.equal(assetRes.status, 206);
    const rangeBytes = Buffer.from(await assetRes.arrayBuffer());
    assert.equal(rangeBytes.length, 4);

    // --- Approve the text release ---
    const release = await api(`/api/admin/lessons/${textOne.lessonId}/texts/${textOne.textId}/releases`, {
      method: 'POST',
      body: JSON.stringify({ contentRevisionId: revisionIdOne, narrationId: narrationIdOne, alignmentId: alignmentIdOne }),
    });
    assert.equal(release.status, 201);

    // --- Cross-text isolation: text two never sees text one's entry/translation ---
    const workspaceTwoAfterGen = await api(`/api/admin/lessons/${textTwo.lessonId}/texts/${textTwo.textId}`);
    const alignmentIdTwo = workspaceTwoAfterGen.body.text.alignmentSummary.id;
    const occurrencesTwo = await api(
      `/api/admin/lessons/${textTwo.lessonId}/texts/${textTwo.textId}/occurrences?alignmentId=${alignmentIdTwo}`,
    );
    const catOccurrenceTwo = occurrencesTwo.body.occurrences.find((o: any) => o.text.toLowerCase() === 'cat');
    assert.ok(catOccurrenceTwo);
    assert.equal(catOccurrenceTwo.entryId, null, 'text two must not inherit text one\'s selection for the same spelling');

    const entryCountForTextTwo = await prisma.textVocabularyEntry.count({ where: { textId: textTwo.textId } });
    assert.equal(entryCountForTextTwo, 0);

    // --- Legacy learner-facing lesson reads are untouched by any of this ---
    const legacyLessonOne = await api(`/api/lessons/${textOne.lessonId}`);
    assert.equal(legacyLessonOne.status, 200);
    assert.equal(legacyLessonOne.body.lesson.items[0].text, 'The cat sat on the mat with the cat.');
    assert.ok(Array.isArray(legacyLessonOne.body.lesson.vocabulary));
  });

  it('rejects an idempotency key reused with a different payload as a conflict', async () => {
    const { lessonId, textId } = await createLessonWithOneItem('Conflict Lesson', 'Hello world.');
    const rev = await api(`/api/admin/lessons/${lessonId}/texts/${textId}/content-revisions`, {
      method: 'POST',
      body: JSON.stringify({ text: 'Hello world.', sourceLanguage: 'en' }),
    });

    const first = await api(`/api/admin/lessons/${lessonId}/texts/${textId}/narration-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'dup-key' },
      body: JSON.stringify({ contentRevisionId: rev.body.revision.id }),
    });
    assert.equal(first.status, 202);

    // A different voiceProfileId means a different canonical request payload.
    const conflicting = await api(`/api/admin/lessons/${lessonId}/texts/${textId}/narration-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'dup-key' },
      body: JSON.stringify({ contentRevisionId: rev.body.revision.id, voiceProfileId: 'a-different-voice' }),
    });
    assert.equal(conflicting.status, 409);
  });

  it('refuses to release before readiness (selected entry missing translation/clip)', async () => {
    const { lessonId, textId } = await createLessonWithOneItem('Incomplete Lesson', 'Simple test sentence.');
    const rev = await api(`/api/admin/lessons/${lessonId}/texts/${textId}/content-revisions`, {
      method: 'POST',
      body: JSON.stringify({ text: 'Simple test sentence.', sourceLanguage: 'en' }),
    });
    const job = await api(`/api/admin/lessons/${lessonId}/texts/${textId}/narration-jobs`, {
      method: 'POST',
      headers: { 'Idempotency-Key': 'gen-incomplete' },
      body: JSON.stringify({ contentRevisionId: rev.body.revision.id }),
    });
    await drainJob(job.body.job.id);

    const workspace = await api(`/api/admin/lessons/${lessonId}/texts/${textId}`);
    const alignmentId = workspace.body.text.alignmentSummary.id;
    const narrationId = workspace.body.text.narration.id;

    const occurrences = await api(`/api/admin/lessons/${lessonId}/texts/${textId}/occurrences?alignmentId=${alignmentId}`);
    const first = occurrences.body.occurrences[0];
    await api(`/api/admin/lessons/${lessonId}/texts/${textId}/selection`, {
      method: 'PATCH',
      body: JSON.stringify({ alignmentId, changes: [{ occurrenceId: first.id, selected: true }] }),
    });

    const release = await api(`/api/admin/lessons/${lessonId}/texts/${textId}/releases`, {
      method: 'POST',
      body: JSON.stringify({ contentRevisionId: rev.body.revision.id, narrationId, alignmentId }),
    });
    assert.equal(release.status, 422);
    assert.equal(release.body.readiness.readyForApproval, false);
    assert.ok(job.body.job.id);
  });
});

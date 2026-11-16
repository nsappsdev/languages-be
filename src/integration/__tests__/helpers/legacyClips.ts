import { AudioJob, PrismaClient } from '@prisma/client';
import { lockText } from '../../../lib/authoringTransaction';
import { inspectReaderDraft } from '../../../lib/readerRelease';
import { extractMissingClips } from '../../../lib/lessonPublication';

/** Construct historical extracted clips explicitly to exercise rollout compatibility. */
export async function prepareLegacyClips(prisma: PrismaClient, textId: string) {
  await prisma.$transaction(async tx => {
    await lockText(tx, textId);
    const draft = await inspectReaderDraft(tx, textId);
    await extractMissingClips(tx, draft);
  }, { timeout: 60000 });
}

/** Explicit old queued-job fixture. Current API generation is covered in sentenceAudio.test. */
export async function runLegacyNarrationTestJob(prisma: PrismaClient, job: AudioJob) {
  const { runGenerateNarrationJob } = await import('../../../lib/textAudioPipeline');
  const payload = job.requestPayload as Record<string, any>;
  await runGenerateNarrationJob(prisma, { ...job, requestPayload: { contentRevisionId: payload.contentRevisionId, voiceId: payload.voiceId } });
}

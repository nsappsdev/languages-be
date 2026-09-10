import { prisma } from '../lib/prisma';
import { config } from '../config';
import { claimNextQueuedJob, failJob } from '../lib/audioJobs';
import { runGenerateNarrationJob, runExtractClipsJob } from '../lib/textAudioPipeline';

let timer: ReturnType<typeof setTimeout> | null = null;
let running = false;

async function tick() {
  if (running) return;
  running = true;
  try {
    // Process at most one job per tick so the worker never holds more than
    // one provider/network/file operation open at a time (plan §7: single
    // bounded in-process worker, no request-long generation).
    const job = await claimNextQueuedJob(prisma);
    if (!job) return;
    try {
      if (job.kind === 'GENERATE_NARRATION') {
        await runGenerateNarrationJob(prisma, job);
      } else if (job.kind === 'EXTRACT_CLIPS') {
        await runExtractClipsJob(prisma, job);
      }
    } catch (error) {
      await failJob(prisma, job.id, {
        code: 'WORKER_INTERNAL_ERROR',
        message: error instanceof Error ? error.message : 'Unknown worker error',
        retryable: false,
      });
    }
  } finally {
    running = false;
  }
}

export function startAudioWorker() {
  if (!config.audioWorker.enabled) {
    console.log('Audio worker disabled (set AUDIO_WORKER_ENABLED=true to enable).');
    return;
  }
  if (timer) return;
  timer = setInterval(() => {
    tick().catch((error) => console.error('Audio worker tick failed', error));
  }, config.audioWorker.pollIntervalMs);
  // Node interval keeps the process alive; unref so tests/CLI scripts that
  // import this module don't hang.
  if (typeof timer.unref === 'function') {
    timer.unref();
  }
}

export function stopAudioWorker() {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
}

export async function runAudioWorkerOnceForTests() {
  await tick();
}

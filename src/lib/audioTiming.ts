import { createHash } from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { buildTextAlignment, TextAlignmentResult } from './textOccurrenceAlignment';
import { DecodedWav, encodeWav } from './pcmWav';
import { alignExistingAudio, checkAlignmentBudget, forcedAlignmentCharacters } from './elevenLabsAlignment';

export const TIMING_ALGORITHM_VERSION = 3;
export type TimingDb = PrismaClient | Prisma.TransactionClient;
const json = (value: unknown) => value as Prisma.InputJsonValue;

export async function resolveAudioTiming(db: TimingDb, input: {
  assetId: string; text: string; audio: DecodedWav; alignment: unknown; normalizedAlignment?: unknown;
}, repair?: { jobId: string }) {
  const key = { assetId: input.assetId, textSha256: createHash('sha256').update(input.text).digest('hex'), algorithmVersion: TIMING_ALGORITHM_VERSION };
  const where = { assetId_textSha256_algorithmVersion: key };
  let saved = await db.audioTiming.findUnique({ where });
  if (!saved) {
    let mapping = buildTextAlignment({ text: input.text, alignment: input.alignment, sampleRate: input.audio.sampleRate,
      frameCount: input.audio.frameCount, algorithmVersion: TIMING_ALGORITHM_VERSION });
    if (mapping.status !== 'OK' && input.normalizedAlignment) {
      const alternate = buildTextAlignment({ text: input.text, alignment: input.normalizedAlignment, sampleRate: input.audio.sampleRate,
        frameCount: input.audio.frameCount, algorithmVersion: TIMING_ALGORITHM_VERSION });
      if (alternate.status === 'OK') mapping = alternate;
    }
    saved = await db.audioTiming.upsert({ where, create: { ...key, status: mapping.status, mapping: json(mapping) }, update: {} });
  }
  if (repair && saved.status !== 'OK' && saved.repairStatus === 'NOT_REQUESTED') {
    // Claim before dispatch, even across multiple workers. A crash leaves a durable
    // uncertain attempt; it must never turn into another automatic paid request.
    const claimed = await db.audioTiming.updateMany({ where: { id: saved.id, repairStatus: 'NOT_REQUESTED' },
      data: { repairStatus: 'CHECKING_BUDGET', ownerJobId: repair.jobId } });
    if (claimed.count) {
      try { await checkAlignmentBudget(input.audio.frameCount / input.audio.sampleRate); }
      catch (error) {
        saved = await db.audioTiming.update({ where, data: { repairStatus: 'NOT_REQUESTED', repairError: (error as Error).message } });
        return timingResult(saved);
      }
      await db.audioTiming.update({ where, data: { repairStatus: 'RUNNING', attemptedAt: new Date(), repairError: null } });
      try {
        const response = await alignExistingAudio(encodeWav(input.audio), input.text);
        await db.audioTiming.update({ where, data: { providerAlignment: response === null ? Prisma.JsonNull : json(response) } });
        const alignment = forcedAlignmentCharacters(response);
        const mapping = buildTextAlignment({ text: input.text, alignment, sampleRate: input.audio.sampleRate,
          frameCount: input.audio.frameCount, algorithmVersion: TIMING_ALGORITHM_VERSION });
        saved = await db.audioTiming.update({ where, data: { status: mapping.status, mapping: json(mapping),
          repairStatus: mapping.status === 'OK' ? 'SUCCEEDED' : 'FAILED',
          repairError: mapping.status === 'OK' ? null : 'Timing repair could not reliably match this recording. Review the sentence audio.' } });
      } catch (error) {
        saved = await db.audioTiming.update({ where, data: { repairStatus: 'FAILED', repairError: (error as Error).message } });
      }
    } else saved = await db.audioTiming.findUniqueOrThrow({ where });
  }
  return timingResult(saved);
}

function timingResult(saved: { mapping: Prisma.JsonValue; repairStatus: string; repairError: string | null; status: string }) {
  return { mapping: saved.mapping as unknown as TextAlignmentResult, canRepair: saved.status !== 'OK' && saved.repairStatus === 'NOT_REQUESTED',
    repairStatus: saved.repairStatus, repairError: saved.repairError ?? undefined };
}

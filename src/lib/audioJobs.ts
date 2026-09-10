import crypto from 'crypto';
import { AudioJobKind, Prisma, PrismaClient } from '@prisma/client';

/**
 * Minimal durable job lifecycle backed by the `AudioJob` Postgres table.
 * One bounded in-process worker polls for QUEUED work (see audioWorker.ts);
 * no Redis/queue microservice, per plan §7.
 */

function sortKeysDeep(value: unknown): unknown {
  if (Array.isArray(value)) {
    return value.map(sortKeysDeep);
  }
  if (value && typeof value === 'object') {
    return Object.keys(value as Record<string, unknown>)
      .sort()
      .reduce<Record<string, unknown>>((acc, key) => {
        acc[key] = sortKeysDeep((value as Record<string, unknown>)[key]);
        return acc;
      }, {});
  }
  return value;
}

export function computeRequestHash(payload: unknown): string {
  const canonical = JSON.stringify(sortKeysDeep(payload));
  return crypto.createHash('sha256').update(canonical).digest('hex');
}

export class JobConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JobConflictError';
  }
}

type TxClient = Prisma.TransactionClient | PrismaClient;

export interface CreateOrReplayJobInput {
  textId: string;
  kind: AudioJobKind;
  actorId: string;
  idempotencyKey: string;
  requestPayload: unknown;
  reservedCharacters?: number;
}

/**
 * Same actor/kind/idempotency key + same canonical request payload returns
 * the existing job (replay). Same key + a different payload is a 409
 * conflict rather than silently mutating the original request.
 */
export async function createOrReplayJob(client: TxClient, input: CreateOrReplayJobInput) {
  const requestHash = computeRequestHash(input.requestPayload);
  const existing = await client.audioJob.findUnique({
    where: {
      textId_kind_idempotencyKey: {
        textId: input.textId,
        kind: input.kind,
        idempotencyKey: input.idempotencyKey,
      },
    },
  });
  if (existing) {
    if (existing.requestHash !== requestHash) {
      throw new JobConflictError('Idempotency key reused with a different request payload');
    }
    return { job: existing, replay: true as const };
  }

  try {
    const created = await client.audioJob.create({
      data: {
        textId: input.textId,
        kind: input.kind,
        actorId: input.actorId,
        idempotencyKey: input.idempotencyKey,
        requestHash,
        requestPayload: input.requestPayload as Prisma.InputJsonValue,
        reservedCharacters: input.reservedCharacters ?? 0,
      },
    });
    return { job: created, replay: false as const };
  } catch (error) {
    if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
      const target = error.meta?.target as string[] | string | undefined;
      const targetsIdempotency = Array.isArray(target)
        ? target.includes('idempotencyKey')
        : String(target ?? '').includes('idempotencyKey');
      if (targetsIdempotency) {
        const raced = await client.audioJob.findUnique({
          where: {
            textId_kind_idempotencyKey: {
              textId: input.textId,
              kind: input.kind,
              idempotencyKey: input.idempotencyKey,
            },
          },
        });
        if (raced) {
          if (raced.requestHash !== requestHash) {
            throw new JobConflictError('Idempotency key reused with a different request payload');
          }
          return { job: raced, replay: true as const };
        }
      }
      // Otherwise this is the partial "one active GENERATE_NARRATION per text" index.
      throw new JobConflictError('Another operation of this kind is already active for this text');
    }
    throw error;
  }
}

const LEASE_MS = 2 * 60 * 1000;

/**
 * Claims the oldest QUEUED job using `FOR UPDATE SKIP LOCKED`, so multiple
 * worker processes/replicas never dispatch the same job twice.
 */
export async function claimNextQueuedJob(prisma: PrismaClient) {
  return prisma.$transaction(async (tx) => {
    const rows = await tx.$queryRaw<{ id: string }[]>`
      SELECT id FROM "AudioJob" WHERE status = 'QUEUED' ORDER BY "createdAt" ASC LIMIT 1 FOR UPDATE SKIP LOCKED
    `;
    if (!rows.length) {
      return null;
    }
    const leaseUntil = new Date(Date.now() + LEASE_MS);
    return tx.audioJob.update({
      where: { id: rows[0].id },
      data: { status: 'RUNNING', leaseUntil, attempt: { increment: 1 } },
    });
  });
}

export async function completeJob(
  client: TxClient,
  jobId: string,
  result: { resultAssetId?: string; resultId?: string },
) {
  return client.audioJob.update({
    where: { id: jobId },
    data: {
      status: 'SUCCEEDED',
      resultAssetId: result.resultAssetId,
      resultId: result.resultId,
      leaseUntil: null,
    },
  });
}

export async function failJob(
  client: TxClient,
  jobId: string,
  error: { code: string; message: string; retryable: boolean },
) {
  return client.audioJob.update({
    where: { id: jobId },
    data: {
      status: 'FAILED',
      errorCode: error.code,
      errorMessage: error.message,
      retryable: error.retryable,
      leaseUntil: null,
    },
  });
}

/** Local retry (never re-dispatches a paid provider call by itself). */
export async function requeueJob(prisma: PrismaClient, jobId: string) {
  const job = await prisma.audioJob.findUnique({ where: { id: jobId } });
  if (!job) {
    throw new Error('Job not found');
  }
  if (job.status !== 'FAILED' || !job.retryable) {
    throw new JobConflictError('Job is not in a retryable failed state');
  }
  return prisma.audioJob.update({
    where: { id: jobId },
    data: { status: 'QUEUED', errorCode: null, errorMessage: null },
  });
}

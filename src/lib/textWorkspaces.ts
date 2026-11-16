import crypto from 'crypto';
import { Prisma, PrismaClient } from '@prisma/client';
import { lockText } from './authoringTransaction';
import { ensureTextMap } from './textMap';

export async function ensureWorkspace(prisma: PrismaClient, textId: string) {
  const workspace = await prisma.textWorkspace.findUniqueOrThrow({ where: { textId } });
  if (!workspace.currentContentRevisionId) return workspace;
  const alignment = workspace.currentAlignmentId ? await prisma.textAlignment.findUnique({ where: { id: workspace.currentAlignmentId }, include: { _count: { select: { occurrences: true } } } }) : null;
  if (alignment?.contentRevisionId === workspace.currentContentRevisionId && alignment._count.occurrences) return workspace;
  return prisma.$transaction(async tx => { await lockText(tx, textId); return ensureTextMap(tx, textId); });
}

export class TextWorkspaceError extends Error {
  constructor(public code: string, message: string) { super(message); }
}

export interface SaveContentRevisionParams {
  textId: string;
  actorId: string;
  text: string;
  sourceLanguage: string;
}

// Also used inside lesson creation, so identities and initial text are atomic.
export async function saveContentRevisionInTransaction(tx: Prisma.TransactionClient, params: SaveContentRevisionParams) {
  const workspace = await tx.textWorkspace.upsert({ where: { textId: params.textId }, update: {}, create: { textId: params.textId } });
  const textSha256 = crypto.createHash('sha256').update(params.text, 'utf8').digest('hex');
  const latest = workspace.currentContentRevisionId
    ? await tx.textContentRevision.findUnique({ where: { id: workspace.currentContentRevisionId } }) : null;
  if (latest && latest.textSha256 === textSha256 && latest.sourceLanguage === params.sourceLanguage) {
    return { revision: latest, isNoOp: true, workspace: await ensureTextMap(tx, params.textId) };
  }
  const last = await tx.textContentRevision.findFirst({ where: { textId: params.textId }, orderBy: { sequence: 'desc' } });
  const revision = await tx.textContentRevision.create({ data: {
    textId: params.textId, sequence: (last?.sequence ?? 0) + 1, text: params.text, textSha256,
    sourceLanguage: params.sourceLanguage, authorId: params.actorId,
  } });
  await tx.textWorkspace.update({ where: { textId: params.textId }, data: {
    currentContentRevisionId: revision.id, currentNarrationId: null, currentAlignmentId: null, sentenceEndOffsets: Prisma.DbNull,
    approvedTextReleaseId: null, draftVersion: { increment: 1 },
  } });
  return { revision, isNoOp: false, workspace: await ensureTextMap(tx, params.textId) };
}

export async function saveContentRevision(prisma: PrismaClient, params: SaveContentRevisionParams) {
  return prisma.$transaction(async tx => {
    await lockText(tx, params.textId);
    return saveContentRevisionInTransaction(tx, params);
  });
}

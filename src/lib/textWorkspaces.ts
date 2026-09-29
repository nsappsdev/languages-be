import crypto from 'crypto';
import { PrismaClient } from '@prisma/client';

/**
 * A TextWorkspace is created lazily, on first admin access to a LessonItem's
 * authoring workspace. This is intentionally lazy/additive: existing lessons
 * are never auto-migrated, and no legacy vocabulary table is touched here.
 */
export async function ensureWorkspace(prisma: PrismaClient, textId: string) {
  return prisma.textWorkspace.upsert({
    where: { textId },
    update: {},
    create: { textId },
  });
}

function sha256Hex(text: string): string {
  return crypto.createHash('sha256').update(text, 'utf8').digest('hex');
}

export class TextWorkspaceError extends Error {
  code: string;
  constructor(code: string, message: string) {
    super(message);
    this.name = 'TextWorkspaceError';
    this.code = code;
  }
}

export interface SaveContentRevisionParams {
  textId: string;
  actorId: string;
  text: string;
  sourceLanguage: string;
}

/**
 * Saving a text revision is always a distinct step from generation (plan
 * §8 step 2: no auto-generation on every save). Saving byte-identical text
 * is a no-op that does not create a new immutable revision or invalidate
 * the current narration/alignment.
 */
export async function saveContentRevision(prisma: PrismaClient, params: SaveContentRevisionParams) {
  return prisma.$transaction(async (tx) => {
    const workspace = await tx.textWorkspace.upsert({
      where: { textId: params.textId },
      update: {},
      create: { textId: params.textId },
    });

    const textSha256 = sha256Hex(params.text);
    const latest = workspace.currentContentRevisionId
      ? await tx.textContentRevision.findUnique({ where: { id: workspace.currentContentRevisionId } })
      : null;

    if (latest && latest.textSha256 === textSha256 && latest.sourceLanguage === params.sourceLanguage) {
      return { revision: latest, isNoOp: true, workspace };
    }

    const lastSequenceRow = await tx.textContentRevision.findFirst({
      where: { textId: params.textId },
      orderBy: { sequence: 'desc' },
    });
    const nextSequence = (lastSequenceRow?.sequence ?? 0) + 1;

    const revision = await tx.textContentRevision.create({
      data: {
        textId: params.textId,
        sequence: nextSequence,
        text: params.text,
        textSha256,
        sourceLanguage: params.sourceLanguage,
        authorId: params.actorId,
      },
    });

    const updatedWorkspace = await tx.textWorkspace.update({
      where: { textId: params.textId },
      data: {
        currentContentRevisionId: revision.id,
        // A new content revision invalidates any current narration/alignment
        // pointer; the old narration/alignment rows are retained as history,
        // just no longer "current" (plan §6.1 item 6).
        currentNarrationId: null,
        currentAlignmentId: null,
        approvedTextReleaseId: null,
        draftVersion: { increment: 1 },
      },
    });

    return { revision, isNoOp: false, workspace: updatedWorkspace };
  });
}

import { Prisma } from '@prisma/client';
import { ReaderReleaseError } from './readerRelease';

// Every authoring mutation takes the lesson lock first. Publication sees a
// coherent draft, and concurrent duplicate clicks serialize across processes.
export async function lockLesson(tx: Prisma.TransactionClient, lessonId: string) {
  const rows = await tx.$queryRaw<{ id: string }[]>`SELECT id FROM "Lesson" WHERE id = ${lessonId} AND "archivedAt" IS NULL FOR UPDATE`;
  if (!rows.length) throw new ReaderReleaseError(404, 'Lesson not found');
}

export async function lockText(tx: Prisma.TransactionClient, textId: string) {
  const item = await tx.lessonItem.findUnique({ where: { id: textId }, select: { lessonId: true } });
  if (!item) throw new ReaderReleaseError(404, 'Text not found');
  await lockLesson(tx, item.lessonId);
  const current = await tx.lessonItem.findFirst({ where: { id: textId, archivedAt: null }, select: { id: true } });
  if (!current) throw new ReaderReleaseError(404, 'Text has been removed');
}

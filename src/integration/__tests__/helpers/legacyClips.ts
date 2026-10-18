import { PrismaClient } from '@prisma/client';
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

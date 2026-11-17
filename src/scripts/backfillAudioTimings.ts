import { PrismaClient } from '@prisma/client';
import { refreshDraftTimings } from '../lib/draftTimingRepair';
import { TIMING_ALGORITHM_VERSION } from '../lib/audioTiming';

const prisma = new PrismaClient();
async function main() {
  const apply = process.argv.includes('--apply');
  const textArg = process.argv.find(value => value.startsWith('--text-id='));
  const textId = textArg?.slice('--text-id='.length);
  const drafts = await prisma.textWorkspace.findMany({ where: { archivedAt: null, currentNarrationId: { not: null }, ...(textId ? { textId } : {}) } });
  let repaired = 0, needsReview = 0, skipped = 0;
  for (const draft of drafts) {
    const before = await prisma.textAlignment.findUnique({ where: { id: draft.currentAlignmentId ?? '' } });
    if (before?.algorithmVersion === TIMING_ALGORITHM_VERSION || draft.timingValidationKey === `${TIMING_ALGORITHM_VERSION}:${draft.currentAlignmentId}`) { skipped++; continue; }
    if (!apply) { console.log(JSON.stringify({ textId: draft.textId, action: 'recheck-existing-recordings', providerRequests: 0 })); continue; }
    const after = await refreshDraftTimings(prisma, draft.textId);
    if (after.currentAlignmentId === draft.currentAlignmentId) { skipped++; continue; }
    const alignment = await prisma.textAlignment.findUniqueOrThrow({ where: { id: after.currentAlignmentId! } });
    if (alignment.status === 'OK') repaired++; else needsReview++;
    console.log(JSON.stringify({ textId: draft.textId, status: alignment.status }));
  }
  console.log(JSON.stringify({ apply, examined: drafts.length, repaired, needsReview, skipped, providerRequests: 0 }));
}
main().catch(error => { console.error(error.message); process.exitCode = 1; }).finally(() => prisma.$disconnect());

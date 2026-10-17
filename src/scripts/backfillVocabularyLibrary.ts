import { PrismaClient } from '@prisma/client';
import { indexPublishedVocabulary } from '../lib/vocabularyLibrary';
import { ReaderText } from '../types/reader';

const prisma = new PrismaClient();
async function main() {
  const apply = process.argv.includes('--apply');
  let cursor: string | undefined;
  let indexed = 0, skipped = 0;
  do {
    const releases = await prisma.textRelease.findMany({ orderBy: { id: 'asc' }, take: 100,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}), include: { workspace: { include: { item: { select: { lessonId: true } } } } } });
    if (!releases.length) break;
    for (const release of releases) {
      const text = release.manifestSnapshot as unknown as ReaderText | null;
      if (!text?.textReleaseId || !Array.isArray(text.occurrences)) { skipped++; continue; }
      if (apply) await prisma.$transaction(tx => indexPublishedVocabulary(tx, release.workspace.item.lessonId, text), { timeout: 60000 });
      indexed++;
    }
    cursor = releases[releases.length - 1].id;
  } while (cursor);
  console.log(JSON.stringify({ mode: apply ? 'applied' : 'dry-run', releases: indexed, skippedLegacyReleases: skipped, newAudioFiles: 0, providerRequests: 0 }));
}
main().catch(error => { console.error(error instanceof Error ? error.message : 'Vocabulary backfill failed'); process.exitCode = 1; }).finally(() => prisma.$disconnect());

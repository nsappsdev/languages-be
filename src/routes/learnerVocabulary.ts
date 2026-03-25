import { Router } from 'express';
import { z } from 'zod';
import { prisma } from '../lib/prisma';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';

const router = Router();

const statusSchema = z.object({
  status: z.enum(['NEW', 'REVIEWING', 'MASTERED']),
});

const vocabularyPackSchema = z.object({
  items: z.array(z.string().trim().min(1)).min(1).max(50),
});
const learnerEntryRoutePath = '/me/vocabulary/:entryId([A-Za-z0-9_-]{20,})';

router.get('/me/vocabulary', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
  const learnerEntries = await prisma.learnerVocabulary.findMany({
    where: { userId: req.user.id },
    include: {
      entry: {
        include: { translations: true },
      },
    },
    orderBy: { updatedAt: 'desc' },
  });
  return res.json({ vocabulary: learnerEntries });
});

router.post('/me/vocabulary/pack', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

  const parsed = vocabularyPackSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const normalizedItems = Array.from(
    new Set(
      parsed.data.items
        .map((item) => normalizeVocabularySelection(item))
        .filter((item): item is string => Boolean(item)),
    ),
  );

  if (!normalizedItems.length) {
    return res.status(400).json({ message: 'No valid vocabulary selections found' });
  }

  const existingEntries = await prisma.vocabularyEntry.findMany({
    where: {
      OR: normalizedItems.map((item) => ({
        englishText: {
          equals: item,
          mode: 'insensitive',
        },
      })),
    },
    include: {
      translations: true,
    },
  });

  const existingByText = new Map(
    existingEntries.map((entry) => [entry.englishText.toLowerCase(), entry]),
  );

  const entryIdsBySelection = new Map<string, string>();

  for (const item of normalizedItems) {
    let entry = existingByText.get(item.toLowerCase());

    if (!entry) {
      entry = await prisma.vocabularyEntry.create({
        data: {
          englishText: item,
          kind: 'WORD',
          tags: ['mobile-captured'],
          createdById: req.user.id,
        },
        include: {
          translations: true,
        },
      });
      existingByText.set(entry.englishText.toLowerCase(), entry);
    }

    entryIdsBySelection.set(item, entry.id);
  }

  await Promise.all(
    Array.from(entryIdsBySelection.values()).map((entryId) =>
      prisma.learnerVocabulary.upsert({
        where: {
          userId_entryId: {
            userId: req.user!.id,
            entryId,
          },
        },
        update: {},
        create: {
          userId: req.user!.id,
          entryId,
          status: 'NEW',
        },
      }),
    ),
  );

  const learnerEntries = await prisma.learnerVocabulary.findMany({
    where: {
      userId: req.user.id,
      entryId: {
        in: Array.from(entryIdsBySelection.values()),
      },
    },
    include: {
      entry: {
        include: {
          translations: true,
        },
      },
    },
  });

  const learnerByEntryId = new Map(learnerEntries.map((entry) => [entry.entryId, entry]));
  const orderedVocabulary = normalizedItems
    .map((item) => learnerByEntryId.get(entryIdsBySelection.get(item) ?? ''))
    .filter((item): item is (typeof learnerEntries)[number] => Boolean(item));

  return res.json({
    vocabulary: orderedVocabulary,
    resolved: orderedVocabulary.length,
    received: parsed.data.items.length,
  });
});

router.post(learnerEntryRoutePath, authenticate, async (req: AuthenticatedRequest, res) => {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
  const entry = await prisma.vocabularyEntry.findUnique({ where: { id: req.params.entryId } });
  if (!entry) return res.status(404).json({ message: 'Vocabulary entry not found' });

  const learnerWord = await prisma.learnerVocabulary.upsert({
    where: { userId_entryId: { userId: req.user.id, entryId: entry.id } },
    update: {},
    create: {
      userId: req.user.id,
      entryId: entry.id,
      status: 'NEW',
    },
    include: { entry: { include: { translations: true } } },
  });

  return res.status(201).json({ vocabulary: learnerWord });
});

router.patch(learnerEntryRoutePath, authenticate, async (req: AuthenticatedRequest, res) => {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });
  const parsed = statusSchema.safeParse(req.body);
  if (!parsed.success) {
    return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
  }

  const learnerWord = await prisma.learnerVocabulary.findUnique({
    where: { userId_entryId: { userId: req.user.id, entryId: req.params.entryId } },
  });

  if (!learnerWord) {
    return res.status(404).json({ message: 'Learner vocabulary entry not found' });
  }

  const updated = await prisma.learnerVocabulary.update({
    where: { userId_entryId: { userId: req.user.id, entryId: req.params.entryId } },
    data: { status: parsed.data.status },
    include: { entry: { include: { translations: true } } },
  });

  return res.json({ vocabulary: updated });
});

router.delete(learnerEntryRoutePath, authenticate, async (req: AuthenticatedRequest, res) => {
  if (!req.user) return res.status(401).json({ message: 'Unauthorized' });

  await prisma.learnerVocabulary.deleteMany({
    where: {
      userId: req.user.id,
      entryId: req.params.entryId,
    },
  });

  return res.status(204).send();
});

export { router as learnerVocabularyRouter };

function normalizeVocabularySelection(value: string): string | null {
  const cleaned = value
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/^[^A-Za-z0-9]+|[^A-Za-z0-9]+$/g, '')
    .toLowerCase();

  if (cleaned.length < 2) {
    return null;
  }

  return cleaned;
}

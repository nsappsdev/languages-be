import { Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';

const router = Router();

const SETTINGS_ID = 'global';

const REPETITION_OPTIONS = [3, 5, 20] as const;
const READING_MODE_IDS = ['introduction', 'teaching', 'deep_learning'] as const;

const DEFAULT_READING_MODES = [
  {
    id: 'introduction',
    enabled: true,
    displayName: 'Introduction',
    order: 0,
  },
  {
    id: 'teaching',
    enabled: true,
    displayName: 'Teaching',
    order: 1,
    unknownWordRepetitions: 5,
  },
  {
    id: 'deep_learning',
    enabled: true,
    displayName: 'Deep Learning',
    order: 2,
    unknownWordRepetitions: 5,
    repeatSentenceWhenUnknownCountAtLeast: 2,
    sentenceRepetitions: 2,
  },
] as const;

const MAIN_FONT_OPTIONS = [
  'System',
  'Georgia',
  'Times New Roman',
  'Arial',
  'Helvetica Neue',
  'Courier New',
] as const;

const TRANSLATION_FONT_OPTIONS = [
  'System',
  'Noto Sans Armenian',
  'Noto Serif Armenian',
  'Mshtakan',
  'Arian AMU',
  'Arial AMU',
  'Arial',
  'Georgia',
] as const;

const readingModeSchema = z
  .object({
    id: z.enum(READING_MODE_IDS),
    enabled: z.boolean(),
    displayName: z.string().trim().min(1).max(40),
    order: z.number().int().min(0).max(20),
    unknownWordRepetitions: z.number().int().min(1).max(20).optional(),
    repeatSentenceWhenUnknownCountAtLeast: z.number().int().min(1).max(20).optional(),
    sentenceRepetitions: z.number().int().min(1).max(20).optional(),
  })
  .superRefine((mode, ctx) => {
    if (mode.id === 'introduction' && mode.unknownWordRepetitions !== undefined) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unknownWordRepetitions'],
        message: 'Introduction does not repeat unknown words',
      });
    }

    if ((mode.id === 'teaching' || mode.id === 'deep_learning') && !mode.unknownWordRepetitions) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['unknownWordRepetitions'],
        message: 'This reading mode requires unknownWordRepetitions',
      });
    }

    if (mode.id === 'deep_learning') {
      if (!mode.repeatSentenceWhenUnknownCountAtLeast) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['repeatSentenceWhenUnknownCountAtLeast'],
          message: 'Deep Learning requires an unknown-word sentence threshold',
        });
      }
      if (!mode.sentenceRepetitions) {
        ctx.addIssue({
          code: z.ZodIssueCode.custom,
          path: ['sentenceRepetitions'],
          message: 'Deep Learning requires sentenceRepetitions',
        });
      }
    }
  });

const updateSettingsSchema = z.object({
  readingModes: z.array(readingModeSchema).length(3).optional(),
  mainTextFontFamily: z.enum(MAIN_FONT_OPTIONS).optional(),
  mainTextFontSize: z.number().int().min(12).max(32).optional(),
  translationFontFamily: z.enum(TRANSLATION_FONT_OPTIONS).optional(),
  translationFontSize: z.number().int().min(10).max(24).optional(),
  translationFontMinSize: z.number().int().min(6).max(20).optional(),
  translationFontMaxSize: z.number().int().min(6).max(24).optional(),
  translationLetterSpacingMin: z.number().min(-2).max(4).optional(),
  translationLetterSpacingMax: z.number().min(-2).max(4).optional(),
}).superRefine((settings, ctx) => {
  if (
    settings.translationFontMinSize !== undefined &&
    settings.translationFontMaxSize !== undefined &&
    settings.translationFontMaxSize < settings.translationFontMinSize
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['translationFontMaxSize'],
      message: 'translationFontMaxSize must be greater than or equal to translationFontMinSize',
    });
  }
  if (
    settings.translationLetterSpacingMin !== undefined &&
    settings.translationLetterSpacingMax !== undefined &&
    settings.translationLetterSpacingMax < settings.translationLetterSpacingMin
  ) {
    ctx.addIssue({
      code: z.ZodIssueCode.custom,
      path: ['translationLetterSpacingMax'],
      message: 'translationLetterSpacingMax must be greater than or equal to translationLetterSpacingMin',
    });
  }
  if (!settings.readingModes) return;
  const ids = new Set(settings.readingModes.map((mode) => mode.id));
  for (const id of READING_MODE_IDS) {
    if (!ids.has(id)) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        path: ['readingModes'],
        message: `Missing reading mode: ${id}`,
      });
    }
  }
});


router.get('/settings', authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const settings = await prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, readingModes: DEFAULT_READING_MODES },
      update: {},
    });
    res.json({ settings });
  } catch {
    res.status(500).json({ message: 'Failed to load settings' });
  }
});

router.patch('/settings', authenticate, async (req: AuthenticatedRequest, res) => {
  if (req.user?.role !== 'admin') {
    res.status(403).json({ message: 'Admin access required' });
    return;
  }

  const parsed = updateSettingsSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    return;
  }

  try {
    const settings = await prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID, readingModes: DEFAULT_READING_MODES, ...parsed.data },
      update: parsed.data,
    });
    res.json({ settings });
  } catch {
    res.status(500).json({ message: 'Failed to update settings' });
  }
});

export const SETTINGS_FONT_OPTIONS = {
  mainText: MAIN_FONT_OPTIONS,
  translationText: TRANSLATION_FONT_OPTIONS,
};

export const SETTINGS_REPETITION_OPTIONS = REPETITION_OPTIONS;
export const SETTINGS_READING_MODES = DEFAULT_READING_MODES;

export { router as settingsRouter };

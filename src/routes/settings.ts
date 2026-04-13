import { Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';

const router = Router();

const SETTINGS_ID = 'global';

const REPETITION_OPTIONS = [1, 2, 3, 5, 10] as const;

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
  'Arial',
  'Georgia',
] as const;

const updateSettingsSchema = z.object({
  unknownWordRepetitions: z.number().int().refine((v) => REPETITION_OPTIONS.includes(v as never), {
    message: `unknownWordRepetitions must be one of: ${REPETITION_OPTIONS.join(', ')}`,
  }).optional(),
  mainTextFontFamily: z.enum(MAIN_FONT_OPTIONS).optional(),
  mainTextFontSize: z.number().int().min(12).max(32).optional(),
  translationFontFamily: z.enum(TRANSLATION_FONT_OPTIONS).optional(),
  translationFontSize: z.number().int().min(10).max(24).optional(),
});


router.get('/settings', authenticate, async (req: AuthenticatedRequest, res) => {
  try {
    const settings = await prisma.appSettings.upsert({
      where: { id: SETTINGS_ID },
      create: { id: SETTINGS_ID },
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
      create: { id: SETTINGS_ID, ...parsed.data },
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

export { router as settingsRouter };

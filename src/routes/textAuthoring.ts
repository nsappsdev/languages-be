import { Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { ensureWorkspace, saveContentRevision } from '../lib/textWorkspaces';
import { setSelection, setTranslations } from '../lib/textVocabulary';
import { computeTextReadiness } from '../lib/textReadiness';
import { createOrReplayJob, requeueJob, JobConflictError } from '../lib/audioJobs';
import { TextWorkspaceError } from '../lib/textWorkspaces';

const router = Router();

function requireAdmin(req: AuthenticatedRequest, res: Response): boolean {
  if (!req.user) {
    res.status(401).json({ message: 'Unauthorized' });
    return false;
  }
  if (req.user.role !== 'admin') {
    res.status(403).json({ message: 'Forbidden' });
    return false;
  }
  return true;
}

async function loadTextContext(lessonId: string, textId: string) {
  const item = await prisma.lessonItem.findFirst({ where: { id: textId, lessonId } });
  if (!item) return null;
  const workspace = await ensureWorkspace(prisma, textId);
  return { item, workspace };
}

function errorResponse(res: Response, error: unknown) {
  if (error instanceof TextWorkspaceError) {
    return res.status(404).json({ message: error.message, code: error.code });
  }
  if (error instanceof JobConflictError) {
    return res.status(409).json({ message: error.message });
  }
  console.error('Text authoring route error', error);
  return res.status(500).json({ message: 'Internal error' });
}

router.get(
  '/admin/lessons/:lessonId/texts/:textId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const [contentRevision, narration, alignment] = await Promise.all([
      context.workspace.currentContentRevisionId
        ? prisma.textContentRevision.findUnique({ where: { id: context.workspace.currentContentRevisionId } })
        : null,
      context.workspace.currentNarrationId
        ? prisma.textNarration.findUnique({ where: { id: context.workspace.currentNarrationId } })
        : null,
      context.workspace.currentAlignmentId
        ? prisma.textAlignment.findUnique({ where: { id: context.workspace.currentAlignmentId } })
        : null,
    ]);

    return res.json({
      text: {
        id: context.item.id,
        lessonId: context.item.lessonId,
        draftVersion: context.workspace.draftVersion,
        legacyText: context.item.text,
        contentRevision,
        narration: narration
          ? {
              id: narration.id,
              assetId: narration.assetId,
              provider: narration.provider,
              model: narration.model,
              voiceId: narration.voiceId,
              createdAt: narration.createdAt,
            }
          : null,
        alignmentSummary: alignment ? { id: alignment.id, status: alignment.status } : null,
        approvedTextReleaseId: context.workspace.approvedTextReleaseId,
        audioGenerationConfigured: Boolean(config.elevenLabs.apiKey),
      },
    });
  },
);

const contentRevisionSchema = z.object({
  text: z.string().min(1).max(5000),
  sourceLanguage: z.string().min(2).max(10).default('en'),
});

router.post(
  '/admin/lessons/:lessonId/texts/:textId/content-revisions',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const parsed = contentRevisionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    const result = await saveContentRevision(prisma, {
      textId: context.item.id,
      actorId: req.user!.id,
      text: parsed.data.text,
      sourceLanguage: parsed.data.sourceLanguage,
    });

    return res.status(result.isNoOp ? 200 : 201).json({
      revision: result.revision,
      textVersion: result.workspace.draftVersion,
      invalidation: result.isNoOp ? null : { narration: true, alignment: true, clips: true },
    });
  },
);

const narrationJobSchema = z.object({
  expectedVersion: z.number().int().optional(),
  contentRevisionId: z.string().min(1),
  voiceProfileId: z.string().min(1).optional(),
});

router.post(
  '/admin/lessons/:lessonId/texts/:textId/narration-jobs',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    if (!config.elevenLabs.apiKey || !config.elevenLabs.defaultVoiceId) {
      return res.status(503).json({
        message: 'Narration generation is not configured on this server.',
        code: 'AUDIO_GENERATION_NOT_CONFIGURED',
      });
    }

    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey) {
      return res.status(400).json({ message: 'Idempotency-Key header is required' });
    }

    const parsed = narrationJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    if (context.workspace.currentContentRevisionId !== parsed.data.contentRevisionId) {
      return res.status(409).json({ message: 'contentRevisionId is not the current saved revision for this text' });
    }

    const voiceId = parsed.data.voiceProfileId ?? config.elevenLabs.defaultVoiceId;

    try {
      const { job, replay } = await createOrReplayJob(prisma, {
        textId: context.item.id,
        kind: 'GENERATE_NARRATION',
        actorId: req.user!.id,
        idempotencyKey,
        requestPayload: { contentRevisionId: parsed.data.contentRevisionId, voiceId },
      });
      return res.status(202).json({ job: { id: job.id, status: job.status }, replay });
    } catch (error) {
      return errorResponse(res, error);
    }
  },
);

router.get('/admin/audio-jobs/:jobId', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  const job = await prisma.audioJob.findUnique({ where: { id: req.params.jobId } });
  if (!job) return res.status(404).json({ message: 'Job not found' });
  return res.json({
    job: {
      id: job.id,
      textId: job.textId,
      kind: job.kind,
      status: job.status,
      attempt: job.attempt,
      resultAssetId: job.resultAssetId,
      resultId: job.resultId,
      error: job.errorCode ? { code: job.errorCode, message: job.errorMessage, retryable: job.retryable } : null,
    },
  });
});

router.post('/admin/audio-jobs/:jobId/retry', authenticate, async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const job = await requeueJob(prisma, req.params.jobId);
    return res.status(202).json({ job: { id: job.id, status: job.status } });
  } catch (error) {
    return errorResponse(res, error);
  }
});

router.get(
  '/admin/lessons/:lessonId/texts/:textId/occurrences',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const alignmentId = String(req.query.alignmentId ?? context.workspace.currentAlignmentId ?? '');
    if (!alignmentId) {
      return res.status(404).json({ message: 'No alignment available yet for this text' });
    }
    const alignment = await prisma.textAlignment.findFirst({ where: { id: alignmentId, textId: context.item.id } });
    if (!alignment) return res.status(404).json({ message: 'Alignment not found for this text' });

    const [occurrences, entries] = await Promise.all([
      prisma.wordOccurrence.findMany({ where: { alignmentId }, orderBy: { ordinal: 'asc' } }),
      prisma.textVocabularyEntry.findMany({ where: { alignmentId }, include: { translations: true, wordClips: true } }),
    ]);
    const entryByOccurrence = new Map(entries.map((entry) => [entry.occurrenceId, entry]));

    return res.json({
      alignmentId,
      status: alignment.status,
      sentences: alignment.sentences,
      occurrences: occurrences.map((occurrence) => {
        const entry = entryByOccurrence.get(occurrence.id);
        return {
          id: occurrence.id,
          ordinal: occurrence.ordinal,
          text: occurrence.surfaceText,
          charStart: occurrence.charStart,
          charEnd: occurrence.charEnd,
          sentenceId: occurrence.sentenceId,
          speechStartSample: occurrence.speechStartSample,
          speechEndSample: occurrence.speechEndSample,
          cutStartSample: occurrence.cutStartSample,
          cutEndSample: occurrence.cutEndSample,
          mappingStatus: occurrence.mappingStatus,
          entryId: entry?.id ?? null,
          selected: entry?.selected ?? false,
          translations: entry?.translations ?? [],
          clipAssetId: entry?.wordClips[0]?.assetId ?? null,
        };
      }),
    });
  },
);

const selectionSchema = z.object({
  alignmentId: z.string().min(1),
  changes: z
    .array(z.object({ occurrenceId: z.string().min(1), selected: z.boolean() }))
    .min(1)
    .max(100),
});

router.patch(
  '/admin/lessons/:lessonId/texts/:textId/selection',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const parsed = selectionSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    try {
      const entries = await setSelection(prisma, {
        textId: context.item.id,
        alignmentId: parsed.data.alignmentId,
        changes: parsed.data.changes,
      });
      return res.json({ entries });
    } catch (error) {
      return errorResponse(res, error);
    }
  },
);

const translationsSchema = z.object({
  translations: z
    .array(
      z.object({
        languageCode: z.string().min(2).max(10),
        translation: z.string().min(0).max(2000),
        usageExample: z.string().max(2000).optional(),
      }),
    )
    .max(20),
});

router.patch(
  '/admin/lessons/:lessonId/texts/:textId/vocabulary/:entryId',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const parsed = translationsSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    try {
      const entry = await setTranslations(prisma, {
        entryId: req.params.entryId,
        textId: context.item.id,
        translations: parsed.data.translations,
      });
      return res.json({ entry });
    } catch (error) {
      return errorResponse(res, error);
    }
  },
);

const clipJobSchema = z.object({
  narrationId: z.string().min(1),
  alignmentId: z.string().min(1),
  occurrenceIds: z.array(z.string().min(1)).min(1).max(100),
});

router.post(
  '/admin/lessons/:lessonId/texts/:textId/clip-jobs',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const idempotencyKey = req.header('Idempotency-Key');
    if (!idempotencyKey) {
      return res.status(400).json({ message: 'Idempotency-Key header is required' });
    }

    const parsed = clipJobSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    if (context.workspace.currentNarrationId !== parsed.data.narrationId) {
      return res.status(409).json({ message: 'narrationId is not the current narration for this text' });
    }

    try {
      const { job, replay } = await createOrReplayJob(prisma, {
        textId: context.item.id,
        kind: 'EXTRACT_CLIPS',
        actorId: req.user!.id,
        idempotencyKey,
        requestPayload: {
          narrationId: parsed.data.narrationId,
          alignmentId: parsed.data.alignmentId,
          occurrenceIds: parsed.data.occurrenceIds,
        },
      });
      return res.status(202).json({ job: { id: job.id, status: job.status }, replay });
    } catch (error) {
      return errorResponse(res, error);
    }
  },
);

router.get(
  '/admin/lessons/:lessonId/texts/:textId/readiness',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const narrationStatus = context.workspace.currentNarrationId ? 'READY' : 'MISSING';
    const alignment = context.workspace.currentAlignmentId
      ? await prisma.textAlignment.findUnique({ where: { id: context.workspace.currentAlignmentId } })
      : null;
    const alignmentStatus = alignment ? alignment.status : 'MISSING';

    const entries = context.workspace.currentAlignmentId
      ? await prisma.textVocabularyEntry.findMany({
          where: { alignmentId: context.workspace.currentAlignmentId, archivedAt: null },
          include: { translations: true, wordClips: true },
        })
      : [];

    const readiness = computeTextReadiness({
      narrationStatus,
      alignmentStatus: alignmentStatus as 'OK' | 'NEEDS_REVIEW' | 'MISSING',
      entries: entries.map((entry) => ({
        id: entry.id,
        selected: entry.selected,
        hasNonBlankTranslation: entry.translations.some((t) => t.translation.trim().length > 0),
        hasCurrentClip: entry.wordClips.length > 0,
      })),
    });

    return res.json({ readiness });
  },
);

const releaseSchema = z.object({
  contentRevisionId: z.string().min(1),
  narrationId: z.string().min(1),
  alignmentId: z.string().min(1),
});

router.post(
  '/admin/lessons/:lessonId/texts/:textId/releases',
  authenticate,
  async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const parsed = releaseSchema.safeParse(req.body);
    if (!parsed.success) {
      return res.status(400).json({ message: 'Invalid payload', issues: parsed.error.flatten() });
    }

    if (
      context.workspace.currentContentRevisionId !== parsed.data.contentRevisionId ||
      context.workspace.currentNarrationId !== parsed.data.narrationId ||
      context.workspace.currentAlignmentId !== parsed.data.alignmentId
    ) {
      return res.status(409).json({ message: 'Supplied lineage is not the current draft lineage for this text' });
    }

    const alignment = await prisma.textAlignment.findUnique({ where: { id: parsed.data.alignmentId } });
    const entries = await prisma.textVocabularyEntry.findMany({
      where: { alignmentId: parsed.data.alignmentId, archivedAt: null },
      include: { translations: true, wordClips: true },
    });
    const readiness = computeTextReadiness({
      narrationStatus: 'READY',
      alignmentStatus: (alignment?.status ?? 'MISSING') as 'OK' | 'NEEDS_REVIEW' | 'MISSING',
      entries: entries.map((entry) => ({
        id: entry.id,
        selected: entry.selected,
        hasNonBlankTranslation: entry.translations.some((t) => t.translation.trim().length > 0),
        hasCurrentClip: entry.wordClips.length > 0,
      })),
    });

    if (!readiness.readyForApproval) {
      return res.status(422).json({ message: 'Text is not ready for approval', readiness });
    }

    const release = await prisma.$transaction(async (tx) => {
      const created = await tx.textRelease.create({
        data: {
          textId: context.item.id,
          contentRevisionId: parsed.data.contentRevisionId,
          narrationId: parsed.data.narrationId,
          alignmentId: parsed.data.alignmentId,
          entryIds: readiness.eligibleEntryIds,
          readinessSnapshot: readiness as any,
          authorId: req.user!.id,
        },
      });
      await tx.textWorkspace.update({ where: { textId: context.item.id }, data: { approvedTextReleaseId: created.id } });
      return created;
    });

    return res.status(201).json({ release });
  },
);

export { router as textAuthoringRouter };

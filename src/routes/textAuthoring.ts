import { Response, Router } from 'express';
import { z } from 'zod';
import { authenticate, AuthenticatedRequest } from '../middleware/authenticate';
import { prisma } from '../lib/prisma';
import { config } from '../config';
import { ensureWorkspace, saveContentRevision } from '../lib/textWorkspaces';
import { importVocabulary, setSelection, setTranslations } from '../lib/textVocabulary';
import { Prisma } from '@prisma/client';
import { inspectReaderDraft, ReaderReleaseError } from '../lib/readerRelease';
import { createOrReplayJob, requeueJob, JobConflictError } from '../lib/audioJobs';
import { TextWorkspaceError } from '../lib/textWorkspaces';
import { lockText } from '../lib/authoringTransaction';
import { requestVocabularyAudio, vocabularyAudioPlan } from '../lib/standaloneVocabulary';

const router = Router();
const run = (handler: (req: AuthenticatedRequest, res: Response) => Promise<unknown>) =>
  (req: AuthenticatedRequest, res: Response) => { void handler(req, res).catch(error => errorResponse(res, error)); };

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
  const item = await prisma.lessonItem.findFirst({ where: { id: textId, lessonId, archivedAt: null, lesson: { archivedAt: null } }, select: { id: true, lessonId: true } });
  if (!item) return null;
  const workspace = await ensureWorkspace(prisma, textId);
  return { item, workspace };
}

function errorResponse(res: Response, error: unknown) {
  if (error instanceof ReaderReleaseError) return res.status(error.status).json({ message: error.message, ...error.details });
  if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2034') return res.status(409).json({ message: 'Text changed while saving. Reload and try again.' });
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
  run(async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const [contentRevision, narration, alignment, activeJob, vocabularyJob] = await Promise.all([
      context.workspace.currentContentRevisionId
        ? prisma.textContentRevision.findUnique({ where: { id: context.workspace.currentContentRevisionId } })
        : null,
      context.workspace.currentNarrationId
        ? prisma.textNarration.findUnique({ where: { id: context.workspace.currentNarrationId } })
        : null,
      context.workspace.currentAlignmentId
        ? prisma.textAlignment.findUnique({ where: { id: context.workspace.currentAlignmentId } })
        : null,
      prisma.audioJob.findFirst({ where: { textId: context.item.id, kind: 'GENERATE_NARRATION', status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } }),
      prisma.audioJob.findFirst({ where: { textId: context.item.id, kind: 'GENERATE_VOCABULARY', status: { in: ['QUEUED', 'RUNNING'] } }, select: { id: true } }),
    ]);

    return res.json({
      text: {
        id: context.item.id,
        lessonId: context.item.lessonId,
        draftVersion: context.workspace.draftVersion,
        activeNarrationJobId: activeJob?.id ?? null,
        activeVocabularyJobId: vocabularyJob?.id ?? null,
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
        audioGenerationConfigured: Boolean(config.elevenLabs.apiKey && config.elevenLabs.defaultVoiceId),
      },
    });
  }),
);

const contentRevisionSchema = z.object({
  text: z.string().min(1).max(5000).refine(text => text.trim().length > 0),
  sourceLanguage: z.string().min(2).max(10).default('en'),
});

router.post(
  '/admin/lessons/:lessonId/texts/:textId/content-revisions',
  authenticate,
  run(async (req: AuthenticatedRequest, res) => {
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
  }),
);

const narrationJobSchema = z.object({
  contentRevisionId: z.string().min(1),
  voiceProfileId: z.string().min(1).optional(),
});

router.post(
  '/admin/lessons/:lessonId/texts/:textId/narration-jobs',
  authenticate,
  run(async (req: AuthenticatedRequest, res) => {
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
      const { job, replay } = await prisma.$transaction(async tx => {
        await lockText(tx, context.item.id);
        const workspace = await tx.textWorkspace.findUniqueOrThrow({ where: { textId: context.item.id } });
        if (workspace.currentContentRevisionId !== parsed.data.contentRevisionId)
          throw new ReaderReleaseError(409, 'Text changed. Save again before generating narration.');
        const result = await createOrReplayJob(tx, {
          textId: context.item.id, kind: 'GENERATE_NARRATION', actorId: req.user!.id, idempotencyKey,
          requestPayload: { contentRevisionId: parsed.data.contentRevisionId, voiceId },
        });
        if (!result.replay) await tx.textWorkspace.update({ where: { textId: context.item.id }, data: {
          currentNarrationId: null, currentAlignmentId: null, approvedTextReleaseId: null, draftVersion: { increment: 1 },
        } });
        return result;
      });
      return res.status(202).json({ job: { id: job.id, status: job.status }, replay });
    } catch (error) {
      return errorResponse(res, error);
    }
  }),
);

router.get('/admin/lessons/:lessonId/texts/:textId/vocabulary/audio-plan', authenticate, run(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const context = await loadTextContext(req.params.lessonId, req.params.textId);
  if (!context) return res.status(404).json({ message: 'Text not found' });
  res.setHeader('Cache-Control', 'private, no-store');
  return res.json(await vocabularyAudioPlan(prisma, context.item.id));
}));

router.post('/admin/lessons/:lessonId/texts/:textId/vocabulary/audio-jobs', authenticate, run(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const context = await loadTextContext(req.params.lessonId, req.params.textId);
  if (!context) return res.status(404).json({ message: 'Text not found' });
  const parsed = z.object({ expectedDraftVersion: z.number().int().nonnegative() }).strict().safeParse(req.body);
  const key = req.header('Idempotency-Key');
  if (!parsed.success || !key || key.length > 200) return res.status(400).json({ message: 'Provide the draft version and an Idempotency-Key header.' });
  const { job, replay } = await requestVocabularyAudio(prisma, context.item.id, req.user!.id, key, parsed.data.expectedDraftVersion);
  return res.status(202).json({ job: { id: job.id, status: job.status }, replay });
}));

router.get('/admin/audio-jobs/:jobId', authenticate, run(async (req: AuthenticatedRequest, res) => {
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
}));

router.post('/admin/audio-jobs/:jobId/retry', authenticate, run(async (req: AuthenticatedRequest, res) => {
  if (!requireAdmin(req, res)) return;
  try {
    const job = await requeueJob(prisma, req.params.jobId);
    return res.status(202).json({ job: { id: job.id, status: job.status } });
  } catch (error) {
    return errorResponse(res, error);
  }
}));

router.get(
  '/admin/lessons/:lessonId/texts/:textId/occurrences',
  authenticate,
  run(async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    const alignmentId = String(req.query.alignmentId ?? context.workspace.currentAlignmentId ?? '');
    if (!alignmentId) {
      return res.status(404).json({ message: 'No alignment available yet for this text' });
    }
    const alignment = await prisma.textAlignment.findFirst({ where: { id: alignmentId, textId: context.item.id } });
    if (!alignment) return res.status(404).json({ message: 'Alignment not found for this text' });

    const draft = await inspectReaderDraft(prisma, context.item.id);
    if (alignmentId !== context.workspace.currentAlignmentId) return res.status(409).json({ message: "Text alignment changed. Reload the text." });
    const [occurrences, entries] = await Promise.all([
      prisma.wordOccurrence.findMany({ where: { alignmentId }, orderBy: { ordinal: 'asc' } }),
      prisma.textVocabularyEntry.findMany({ where: { alignmentId }, include: { translations: true, wordClips: true } }),
    ]);
    const entryByOccurrence = new Map(entries.map((entry) => [entry.occurrenceId, entry]));

    return res.json({
      alignmentId,
      draftVersion: draft.workspace.draftVersion,
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
          endOccurrenceId: entry?.endOccurrenceId ?? null,
          selected: entry?.selected ?? false,
          translations: entry?.translations ?? [],
          clipAssetId: entry ? draft.clips.get(entry.id)?.asset.id ?? null : null,
        };
      }),
    });
  }),
);

const selectionSchema = z.object({
  alignmentId: z.string().min(1),
  changes: z
    .array(z.object({ occurrenceId: z.string().min(1), endOccurrenceId: z.string().min(1).nullable().optional(), selected: z.boolean() }))
    .min(1)
    .max(100),
});

router.patch(
  '/admin/lessons/:lessonId/texts/:textId/selection',
  authenticate,
  run(async (req: AuthenticatedRequest, res) => {
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
  }),
);

const importSchema = z.object({
  alignmentId: z.string().min(1),
  expectedDraftVersion: z.number().int().positive(),
  entries: z.array(z.object({
    occurrenceId: z.string().min(1),
    endOccurrenceId: z.string().min(1).nullable().optional(),
    translation: z.string().trim().min(1).max(2000),
  }).strict()).min(1).max(500),
}).strict();

router.post('/admin/lessons/:lessonId/texts/:textId/vocabulary/import', authenticate, run(async (req, res) => {
  if (!requireAdmin(req, res)) return;
  const context = await loadTextContext(req.params.lessonId, req.params.textId);
  if (!context) return res.status(404).json({ message: 'Text not found' });
  const parsed = importSchema.safeParse(req.body);
  if (!parsed.success) return res.status(400).json({ message: 'Invalid import. Supply up to 500 words or phrases with Armenian translations.', issues: parsed.error.flatten() });
  const entries = await importVocabulary(prisma, { textId: context.item.id, ...parsed.data });
  return res.json({ entries, importedCount: entries.length });
}));

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
  run(async (req: AuthenticatedRequest, res) => {
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
  }),
);

router.get(
  '/admin/lessons/:lessonId/texts/:textId/readiness',
  authenticate,
  run(async (req: AuthenticatedRequest, res) => {
    if (!requireAdmin(req, res)) return;
    const context = await loadTextContext(req.params.lessonId, req.params.textId);
    if (!context) return res.status(404).json({ message: 'Text not found' });

    try {
      const { readiness } = await inspectReaderDraft(prisma, context.item.id);
      return res.json({ readiness });
    } catch (error) { return errorResponse(res, error); }
  }),
);

export { router as textAuthoringRouter };

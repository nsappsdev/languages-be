import cors from 'cors';
import express from 'express';
import path from 'path';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { swaggerSpec } from './swagger/swagger';
import { authRouter } from './routes/auth';
import { lessonsRouter } from './routes/lessons';
import { analyticsRouter } from './routes/analytics';
import { learnersRouter } from './routes/learners';
import { progressRouter } from './routes/progress';
import { mediaRouter } from './routes/media';
import { lessonVocabularyRouter } from './routes/lessonVocabulary';
import { settingsRouter } from './routes/settings';
import { appVersionRouter } from './routes/appVersion';
import { textAuthoringRouter } from './routes/textAuthoring';
import { adminAudioAssetsRouter } from './routes/adminAudioAssets';
import { readerRouter } from './routes/reader';

export function createApp() {
  const app = express();

  app.use(express.json({ limit: '5mb' }));
  app.use(
    cors({
      origin: config.allowedOrigins,
      credentials: true,
    }),
  );

  app.get('/health', (_req, res) => {
    res.json({ status: 'ok' });
  });

  app.use('/media', express.static(path.resolve(process.cwd(), 'public')));
  app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
  app.use('/api', authRouter);
  app.use('/api', lessonsRouter);
  app.use('/api', analyticsRouter);
  app.use('/api', learnersRouter);
  app.use('/api', progressRouter);
  app.use('/api', mediaRouter);
  app.use('/api', lessonVocabularyRouter);
  app.use('/api', settingsRouter);
  app.use('/api', appVersionRouter);
  app.use('/api', textAuthoringRouter);
  app.use('/api', adminAudioAssetsRouter);
  app.use('/api', readerRouter);

  return app;
}

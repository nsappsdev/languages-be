import cors from 'cors';
import express from 'express';
import swaggerUi from 'swagger-ui-express';
import { config } from './config';
import { swaggerSpec } from './swagger/swagger';
import { authRouter } from './routes/auth';
import { lessonsRouter } from './routes/lessons';
import { analyticsRouter } from './routes/analytics';
import { vocabularyRouter } from './routes/vocabulary';
import { learnerVocabularyRouter } from './routes/learnerVocabulary';
import { learnersRouter } from './routes/learners';
import { progressRouter } from './routes/progress';

const app = express();

app.use(express.json());
app.use(
  cors({
    origin: config.allowedOrigins,
    credentials: true,
  }),
);

app.get('/health', (_req, res) => {
  res.json({ status: 'ok' });
});

app.use('/docs', swaggerUi.serve, swaggerUi.setup(swaggerSpec));
app.use('/api', authRouter);
app.use('/api', lessonsRouter);
app.use('/api', analyticsRouter);
app.use('/api', vocabularyRouter);
app.use('/api', learnerVocabularyRouter);
app.use('/api', learnersRouter);
app.use('/api', progressRouter);

app.listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port}`);
});

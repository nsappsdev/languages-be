import { createApp } from './app';
import { config } from './config';
import { startAudioWorker } from './workers/audioWorker';

const app = createApp();

app.listen(config.port, () => {
  console.log(`Backend listening on http://localhost:${config.port}`);
});

startAudioWorker();

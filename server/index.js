import http from 'node:http';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import express from 'express';
import { initDb, db } from './db.js';
import { AudioStore } from './audio.js';
import { createHub } from './realtime.js';
import { apiRouter } from './routes.js';
import { dataDir } from './paths.js';
import { WhisperEngine } from './whisper.js';
import { LiveTranscriber } from './live.js';

const here = path.dirname(fileURLToPath(import.meta.url));
const PORT = Number(process.env.PORT || 5050);
const HOST = process.env.HOST || '127.0.0.1';

await initDb();
const audio = new AudioStore(process.env.AUDIO_DIR || path.join(dataDir, 'audio'));

const app = express();
app.disable('x-powered-by');
app.use(express.json({ limit: '1mb' }));

const server = http.createServer(app);
const engine = new WhisperEngine({ dataDir });
let hub;
const live = new LiveTranscriber({ engine, audio, broadcast: (id, msg) => hub.broadcast(id, msg) });
hub = createHub(server, { audio, live, engine });
engine.on('status', (status) => {
  console.log(`Whisper: ${status.state} - ${status.message}`);
  hub.broadcastAll({ type: 'transcriber.status', state: 'engine', engine: status });
});
engine.start();

app.use('/api', apiRouter({ hub, audio, live, engine }));
app.use(express.static(path.join(here, '..', 'public')));
app.get('*', (_req, res) => res.sendFile(path.join(here, '..', 'public', 'index.html')));

server.listen(PORT, HOST, () => {
  console.log(`CourtScribe running at http://${HOST === '0.0.0.0' ? 'localhost' : HOST}:${PORT}  (database: ${db.kind}, data: ${dataDir})`);
});

let stopping = false;
async function shutdown() {
  if (stopping) return;
  stopping = true;
  hub.close();
  engine.stop();
  server.close();
  await db.close().catch(() => {});
  process.exit(0);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

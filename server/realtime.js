// WebSocket hub. Each hearing is a room. One connection per room may hold the
// recorder role and stream audio; everyone in the room receives live partial
// text, committed segments and edits.
//
// Wire protocol
//   client -> server (JSON):  hello, record.start, record.stop, partial, segment, speaker.active
//   client -> server (binary): [float64 LE absolute sample offset][int16 LE PCM ...]
//   server -> client (JSON):  hello.ok, ack, audio.ack, partial, segment.*, speaker.*,
//                             session.updated, presence, heartbeat, error
// Every client message that carries clientId gets an `ack` so the sender can
// drop it from its retry queue. Audio is acknowledged by total samples stored.
import { WebSocketServer } from 'ws';
import * as svc from './transcript.js';

const HEARTBEAT_MS = 10_000;

export function createHub(server, { audio, live, engine }) {
  const wss = new WebSocketServer({ server, path: '/ws', maxPayload: 4 * 1024 * 1024 });
  const rooms = new Map();      // sessionId -> Set<ws>
  const recorders = new Map();  // sessionId -> { ws, clientId }
  const sampleRates = new Map();
  const activeSpeakers = new Map(); // sessionId -> speaker id currently talking (shared by every screen)

  const send = (ws, msg) => {
    if (ws.readyState === ws.OPEN) ws.send(JSON.stringify(msg));
  };

  function broadcast(sessionId, msg, except) {
    const room = rooms.get(sessionId);
    if (!room) return;
    const data = JSON.stringify(msg);
    for (const ws of room) if (ws !== except && ws.readyState === ws.OPEN) ws.send(data);
  }

  function presence(sessionId) {
    const room = rooms.get(sessionId);
    const rec = recorders.get(sessionId);
    return {
      viewers: room ? room.size : 0,
      recorder: Boolean(rec && rec.ws && rec.ws.readyState === rec.ws.OPEN),
    };
  }

  const announce = (sessionId) => broadcast(sessionId, { type: 'presence', ...presence(sessionId) });

  function leave(ws) {
    const id = ws.sessionId;
    if (!id) return;
    rooms.get(id)?.delete(ws);
    if (rooms.get(id)?.size === 0) rooms.delete(id);
    const rec = recorders.get(id);
    if (rec?.ws === ws) {
      // Keep the clientId so the same recorder can reclaim the slot on reconnect.
      rec.ws = null;
      svc.updateSession(id, { audio_samples: audio.samples(id) }).catch(() => {});
    }
    ws.sessionId = null;
    announce(id);
  }

  /** Give this connection the recorder slot unless another live tab holds it. */
  function claimRecorder(ws, sessionId, clientId) {
    const rec = recorders.get(sessionId);
    const holderAlive = rec?.ws && rec.ws !== ws && rec.ws.readyState === rec.ws.OPEN;
    if (holderAlive && rec.clientId !== clientId) return false;
    if (holderAlive && rec.clientId === clientId) rec.ws.terminate(); // stale half-open socket of the same tab
    recorders.set(sessionId, { ws, clientId });
    return true;
  }

  const handlers = {
    async hello(ws, msg) {
      const session = await svc.getSession(msg.sessionId);
      if (ws.sessionId && ws.sessionId !== session.id) leave(ws);
      ws.sessionId = session.id;
      ws.clientId = String(msg.clientId || '').slice(0, 64);
      ws.name = String(msg.name || '').slice(0, 60) || null;
      sampleRates.set(session.id, session.sample_rate);
      if (!rooms.has(session.id)) rooms.set(session.id, new Set());
      rooms.get(session.id).add(ws);

      let role = 'viewer';
      if (msg.role === 'recorder') {
        if (claimRecorder(ws, session.id, ws.clientId)) role = 'recorder';
        else send(ws, { type: 'error', code: 'recorder_busy', message: 'Another device is recording this hearing.' });
      }
      send(ws, {
        type: 'hello.ok', role, session, audioSamples: audio.samples(session.id), transcriber: engine.status,
        activeSpeaker: activeSpeakers.has(session.id) ? activeSpeakers.get(session.id) : undefined,
        ...presence(session.id),
      });
      announce(session.id);
    },

    async 'record.start'(ws, msg) {
      requireRoom(ws);
      if (!claimRecorder(ws, ws.sessionId, ws.clientId)) {
        return send(ws, { type: 'ack', clientId: msg.clientId, ok: false, code: 'recorder_busy', message: 'Another device is recording this hearing.' });
      }
      const session = await svc.updateSession(ws.sessionId, { status: 'recording' });
      let transcription = 'none';
      if (msg.engine === 'whisper' && engine.ready) {
        live.begin(ws.sessionId, { language: String(msg.language || 'en').slice(0, 2), speakerId: msg.speakerId ?? null });
        transcription = 'whisper';
      } else if (msg.engine === 'whisper') {
        transcription = 'unavailable';
      }
      send(ws, { type: 'ack', clientId: msg.clientId, ok: true, audioSamples: audio.samples(ws.sessionId), transcription, transcriber: engine.status });
      broadcast(ws.sessionId, { type: 'session.updated', session });
      announce(ws.sessionId);
    },

    async 'record.stop'(ws, msg) {
      requireRoom(ws);
      const status = msg.close ? 'closed' : 'paused';
      // Release the recorder slot so another device can continue the hearing.
      // Frames this socket sent before the stop were already accepted, since
      // messages on one connection are handled in order.
      if (recorders.get(ws.sessionId)?.ws === ws) recorders.delete(ws.sessionId);
      const session = await svc.updateSession(ws.sessionId, { status, audio_samples: audio.samples(ws.sessionId) });
      live.end(ws.sessionId).catch((err) => console.error('live end:', err.message));
      send(ws, { type: 'ack', clientId: msg.clientId, ok: true });
      broadcast(ws.sessionId, { type: 'session.updated', session, audioSamples: audio.samples(ws.sessionId) });
      announce(ws.sessionId);
    },

    partial(ws, msg) {
      requireRoom(ws);
      broadcast(ws.sessionId, {
        type: 'partial',
        from: ws.clientId,
        text: String(msg.text || '').slice(0, 2000),
        speakerId: msg.speakerId ?? null,
        startMs: msg.startMs ?? null,
      }, ws);
    },

    async segment(ws, msg) {
      requireRoom(ws);
      const { segment, duplicate } = await svc.createSegment(ws.sessionId, {
        client_id: msg.clientId,
        text: msg.text,
        speaker_id: msg.speakerId ?? null,
        start_ms: msg.startMs,
        end_ms: msg.endMs,
        confidence: msg.confidence ?? null,
      }, msg.source === 'manual' ? 'manual' : 'speech');
      send(ws, { type: 'ack', clientId: msg.clientId, ok: true, segment });
      if (!duplicate) broadcast(ws.sessionId, { type: 'segment.created', segment, from: ws.clientId });
    },

    'speaker.active'(ws, msg) {
      requireRoom(ws);
      const id = ws.sessionId;
      const speakerId = msg.speakerId ?? null;
      // Any screen can switch the speaker. The recorder knows the exact audio
      // time; for anyone else, stamp it with how much audio has arrived so far.
      const isRecorder = recorders.get(id)?.ws === ws;
      const atMs = isRecorder && Number.isFinite(msg.atMs)
        ? msg.atMs
        : Math.round((audio.samples(id) / (sampleRates.get(id) || 16000)) * 1000);
      activeSpeakers.set(id, speakerId);
      live.speaker(id, atMs, speakerId);
      if (msg.clientId) send(ws, { type: 'ack', clientId: msg.clientId, ok: true });
      broadcast(id, { type: 'speaker.active', speakerId, from: ws.clientId }, ws);
    },
  };

  async function onAudio(ws, data) {
    const id = ws.sessionId;
    const rec = id && recorders.get(id);
    if (!rec || rec.ws !== ws) return send(ws, { type: 'error', code: 'not_recorder', message: 'This connection is not the recorder.' });
    if (data.length < 8 || (data.length - 8) % 2) return send(ws, { type: 'error', code: 'bad_frame', message: 'Malformed audio frame' });
    const offset = data.readDoubleLE(0);
    const total = await audio.write(id, offset, data.subarray(8), sampleRates.get(id) || 16000);
    send(ws, { type: 'audio.ack', samples: total });
    live.onAudio(id, total);
    const now = Date.now();
    if (!ws.lastProgress || now - ws.lastProgress > 1000) {
      ws.lastProgress = now;
      broadcast(id, { type: 'audio.progress', samples: total }, ws);
    }
  }

  wss.on('connection', (ws) => {
    ws.isAlive = true;
    ws.on('pong', () => { ws.isAlive = true; });
    ws.on('message', async (data, isBinary) => {
      let msg = null;
      try {
        if (isBinary) return await onAudio(ws, data);
        msg = JSON.parse(data.toString());
        const handler = handlers[msg?.type];
        if (!handler) throw new svc.HttpError(400, `Unknown message type: ${msg?.type}`);
        await handler(ws, msg);
      } catch (err) {
        const detail = { code: err.code || 'error', message: err.message, status: err.status || 500 };
        // Reliable messages get a failed ack so the client stops retrying something the server rejects.
        if (msg?.clientId && err.status && err.status < 500) send(ws, { type: 'ack', clientId: msg.clientId, ok: false, ...detail });
        else send(ws, { type: 'error', ...detail });
      }
    });
    ws.on('close', () => leave(ws));
    ws.on('error', () => {});
  });

  // Server-side liveness: protocol ping/pong drops dead TCP connections; the
  // JSON heartbeat lets browsers (which cannot see pings) detect a dead link.
  const timer = setInterval(() => {
    for (const ws of wss.clients) {
      if (!ws.isAlive) { ws.terminate(); continue; }
      ws.isAlive = false;
      ws.ping();
      send(ws, { type: 'heartbeat', t: Date.now() });
    }
  }, HEARTBEAT_MS);
  wss.on('close', () => clearInterval(timer));

  function broadcastAll(msg) {
    for (const id of rooms.keys()) broadcast(id, msg);
  }

  return { broadcast, broadcastAll, presence, close: () => { clearInterval(timer); wss.close(); } };
}

function requireRoom(ws) {
  if (!ws.sessionId) throw new svc.HttpError(400, 'Send hello first');
}

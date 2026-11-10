// REST API. Every mutation is broadcast to the hearing's WebSocket room so
// all open screens stay in sync with the database.
import express from 'express';
import * as svc from './transcript.js';
import { createDemoHearing } from './demo.js';
import { db } from './db.js';

const wrap = (fn) => (req, res, next) => Promise.resolve(fn(req, res, next)).catch(next);

export function apiRouter({ hub, audio, live, engine }) {
  const r = express.Router();
  const editor = (req) => {
    let name = String(req.get('x-editor') || '');
    try { name = decodeURIComponent(name); } catch {}
    return name.trim().slice(0, 60) || null;
  };

  r.get('/health', wrap(async (_req, res) => {
    await db.query('SELECT 1');
    res.json({ ok: true, database: db.kind, transcriber: engine.status });
  }));

  // ---- hearings
  r.get('/sessions', wrap(async (req, res) => {
    const rows = await svc.listSessions(req.query.q);
    res.json(rows.map((s) => ({ ...s, audio_samples: audio.samples(s.id), ...hub.presence(s.id) })));
  }));

  r.post('/sessions', wrap(async (req, res) => {
    res.status(201).json(await svc.createSession(req.body || {}));
  }));

  r.post('/demo', wrap(async (_req, res) => {
    res.status(201).json(await createDemoHearing({ audio }));
  }));

  r.get('/sessions/:id', wrap(async (req, res) => {
    const session = await svc.getSession(req.params.id);
    const [speakers, segments] = await Promise.all([svc.listSpeakers(session.id), svc.listSegments(session.id)]);
    res.json({ session, speakers, segments, audioSamples: audio.samples(session.id), presence: hub.presence(session.id) });
  }));

  r.patch('/sessions/:id', wrap(async (req, res) => {
    const session = await svc.updateSession(req.params.id, pick(req.body, ['case_number', 'title', 'courtroom', 'judge', 'status']));
    hub.broadcast(session.id, { type: 'session.updated', session });
    res.json(session);
  }));

  r.delete('/sessions/:id', wrap(async (req, res) => {
    await svc.deleteSession(req.params.id);
    live.drop(req.params.id);
    await audio.remove(req.params.id);
    hub.broadcast(req.params.id, { type: 'session.deleted', sessionId: req.params.id });
    res.status(204).end();
  }));

  r.post('/sessions/:id/retranscribe', wrap(async (req, res) => {
    const session = await svc.getSession(req.params.id);
    const language = String(req.body?.language || 'en').slice(0, 2);
    res.status(202).json(await live.retranscribe(session.id, { language }));
  }));

  r.get('/sessions/:id/audio', wrap(async (req, res) => {
    const session = await svc.getSession(req.params.id);
    audio.serveWav(req, res, session.id, session.sample_rate);
  }));

  r.get('/sessions/:id/export.txt', wrap(async (req, res) => {
    const session = await svc.getSession(req.params.id);
    const [speakers, segments] = await Promise.all([svc.listSpeakers(session.id), svc.listSegments(session.id)]);
    const names = new Map(speakers.map((s) => [s.id, s.label]));
    const lines = [
      'OFFICIAL TRANSCRIPT OF PROCEEDINGS',
      '',
      `Case No.:   ${session.case_number}`,
      `Matter:     ${session.title}`,
      session.courtroom ? `Courtroom:  ${session.courtroom}` : null,
      session.judge ? `Presiding:  ${session.judge}` : null,
      session.started_at ? `Commenced:  ${new Date(session.started_at).toUTCString()}` : null,
      '',
      '-'.repeat(72),
      '',
    ].filter((l) => l !== null);
    segments.forEach((seg, i) => {
      const who = names.get(seg.speaker_id) || 'UNIDENTIFIED SPEAKER';
      const n = String(i + 1).padStart(4, ' ');
      lines.push(`${n}  [${clock(seg.start_ms)}]  ${who}:  ${seg.text}`);
    });
    lines.push('', '-'.repeat(72), `${segments.length} lines. Generated ${new Date().toUTCString()}.`);
    const file = `transcript-${session.case_number.replace(/[^\w.-]+/g, '_')}.txt`;
    res.set('Content-Disposition', `attachment; filename="${file}"`).type('text/plain').send(lines.join('\r\n'));
  }));

  // ---- speakers
  r.post('/sessions/:id/speakers', wrap(async (req, res) => {
    const speaker = await svc.createSpeaker(req.params.id, req.body || {});
    hub.broadcast(speaker.session_id, { type: 'speaker.upserted', speaker });
    res.status(201).json(speaker);
  }));

  r.patch('/speakers/:id', wrap(async (req, res) => {
    const speaker = await svc.updateSpeaker(req.params.id, req.body || {});
    hub.broadcast(speaker.session_id, { type: 'speaker.upserted', speaker });
    res.json(speaker);
  }));

  r.delete('/speakers/:id', wrap(async (req, res) => {
    const speaker = await svc.deleteSpeaker(req.params.id);
    hub.broadcast(speaker.session_id, { type: 'speaker.deleted', speakerId: speaker.id });
    res.status(204).end();
  }));

  // ---- segments
  r.post('/sessions/:id/segments', wrap(async (req, res) => {
    const { segment, duplicate } = await svc.createSegment(req.params.id, req.body || {}, 'manual');
    if (!duplicate) hub.broadcast(segment.session_id, { type: 'segment.created', segment });
    res.status(duplicate ? 200 : 201).json(segment);
  }));

  r.patch('/segments/:id', wrap(async (req, res) => {
    const segment = await svc.updateSegment(
      req.params.id,
      pick(req.body, ['text', 'speaker_id', 'start_ms', 'end_ms', 'version']),
      editor(req),
    );
    hub.broadcast(segment.session_id, { type: 'segment.updated', segment });
    res.json(segment);
  }));

  r.delete('/segments/:id', wrap(async (req, res) => {
    const { id, session_id } = await svc.deleteSegment(req.params.id);
    hub.broadcast(session_id, { type: 'segment.deleted', segmentId: id });
    res.status(204).end();
  }));

  r.get('/segments/:id/revisions', wrap(async (req, res) => {
    res.json(await svc.listRevisions(req.params.id));
  }));

  // ---- search
  r.get('/search', wrap(async (req, res) => {
    res.json(await svc.search(req.query.q, req.query.session_id));
  }));

  r.use((err, _req, res, _next) => {
    if (!err.status) console.error(err);
    if (err.type === 'entity.parse.failed') return res.status(400).json({ error: 'Invalid JSON' });
    res.status(err.status || 500).json({ error: err.status ? err.message : 'Internal server error', ...(err.extra || {}) });
  });

  return r;
}

function pick(obj = {}, keys) {
  const out = {};
  for (const k of keys) if (obj && k in obj) out[k] = obj[k];
  return out;
}

function clock(ms) {
  const s = Math.floor(ms / 1000);
  return [Math.floor(s / 3600), Math.floor((s % 3600) / 60), s % 60].map((n) => String(n).padStart(2, '0')).join(':');
}

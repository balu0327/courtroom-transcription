// Transcript data access: hearings, speakers, segments and their revisions.
// Shared by the REST API and the WebSocket hub so both paths apply the same rules.
import { db } from './db.js';

export class HttpError extends Error {
  constructor(status, message, extra) {
    super(message);
    this.status = status;
    this.extra = extra;
  }
}

const PALETTE = ['#8b1e2d', '#1f4e8c', '#2f7d4a', '#a8620f', '#6b3fa0', '#0f7c80', '#a3366f', '#4b5563', '#7a6a12'];
export const DEFAULT_SPEAKERS = [
  { label: 'THE COURT', role: 'Judge' },
  { label: 'THE CLERK', role: 'Clerk' },
  { label: 'PROSECUTION', role: 'Prosecution' },
  { label: 'DEFENSE', role: 'Defense' },
  { label: 'THE WITNESS', role: 'Witness' },
];

const SEG = `s.id, s.session_id, s.speaker_id, s.client_id, s.start_ms, s.end_ms, s.text,
  s.source, s.confidence, s.version, s.created_at, s.updated_at,
  (SELECT count(*)::int FROM segment_revisions r WHERE r.segment_id = s.id) AS revision_count`;

const clean = (v, max = 500) => (typeof v === 'string' ? v.trim().slice(0, max) : '');
const isUuid = (v) => typeof v === 'string' && /^[0-9a-f-]{36}$/i.test(v);
const toMs = (v, name) => {
  const n = Number(v);
  if (!Number.isFinite(n) || n < 0) throw new HttpError(400, `${name} must be a non-negative number`);
  return Math.round(n);
};

// ---- hearings -------------------------------------------------------------

export async function listSessions(q) {
  const params = [];
  let where = '';
  if (q) {
    params.push(`%${escapeLike(q)}%`);
    where = `WHERE case_number ILIKE $1 OR title ILIKE $1 OR courtroom ILIKE $1 OR judge ILIKE $1`;
  }
  const { rows } = await db.query(
    `SELECT se.*, (SELECT count(*)::int FROM segments s WHERE s.session_id = se.id) AS segment_count
       FROM sessions se ${where} ORDER BY se.created_at DESC LIMIT 200`,
    params,
  );
  return rows;
}

export async function getSession(id) {
  if (!isUuid(id)) throw new HttpError(404, 'Hearing not found');
  const { rows } = await db.query('SELECT * FROM sessions WHERE id = $1', [id]);
  if (!rows[0]) throw new HttpError(404, 'Hearing not found');
  return rows[0];
}

export async function createSession(body) {
  const caseNumber = clean(body.case_number, 80);
  const title = clean(body.title, 200);
  if (!caseNumber || !title) throw new HttpError(400, 'Case number and title are required');
  const speakers = Array.isArray(body.speakers) && body.speakers.length ? body.speakers : DEFAULT_SPEAKERS;

  return db.tx(async (q) => {
    const { rows } = await q(
      `INSERT INTO sessions (case_number, title, courtroom, judge) VALUES ($1, $2, $3, $4) RETURNING *`,
      [caseNumber, title, clean(body.courtroom, 80) || null, clean(body.judge, 120) || null],
    );
    const session = rows[0];
    let i = 0;
    for (const sp of speakers) {
      const label = clean(sp.label, 60).toUpperCase();
      if (!label) continue;
      await q(
        `INSERT INTO speakers (session_id, label, role, color, position) VALUES ($1, $2, $3, $4, $5)
         ON CONFLICT (session_id, label) DO NOTHING`,
        [session.id, label, clean(sp.role, 40) || 'Other', PALETTE[i % PALETTE.length], i],
      );
      i++;
    }
    return session;
  });
}

export async function updateSession(id, body) {
  await getSession(id);
  const sets = [];
  const params = [id];
  for (const key of ['case_number', 'title', 'courtroom', 'judge']) {
    if (key in body) {
      params.push(clean(body[key], 200) || null);
      sets.push(`${key} = $${params.length}`);
    }
  }
  if ('status' in body) {
    if (!['idle', 'recording', 'paused', 'closed'].includes(body.status)) throw new HttpError(400, 'Invalid status');
    params.push(body.status);
    sets.push(`status = $${params.length}`);
    if (body.status === 'recording') sets.push('started_at = coalesce(started_at, now())');
    if (body.status === 'closed') sets.push('ended_at = now()');
  }
  if ('audio_samples' in body) {
    params.push(Math.max(0, Math.floor(Number(body.audio_samples) || 0)));
    sets.push(`audio_samples = $${params.length}`);
  }
  if (!sets.length) return getSession(id);
  sets.push('updated_at = now()');
  const { rows } = await db.query(`UPDATE sessions SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
  return rows[0];
}

export async function deleteSession(id) {
  await getSession(id);
  await db.query('DELETE FROM sessions WHERE id = $1', [id]);
}

// ---- speakers -------------------------------------------------------------

export async function listSpeakers(sessionId) {
  const { rows } = await db.query(
    'SELECT * FROM speakers WHERE session_id = $1 ORDER BY position, id',
    [sessionId],
  );
  return rows;
}

export async function createSpeaker(sessionId, body) {
  await getSession(sessionId);
  const label = clean(body.label, 60).toUpperCase();
  if (!label) throw new HttpError(400, 'Speaker label is required');
  const { rows: [{ n }] } = await db.query('SELECT count(*)::int AS n FROM speakers WHERE session_id = $1', [sessionId]);
  try {
    const { rows } = await db.query(
      `INSERT INTO speakers (session_id, label, role, color, position) VALUES ($1, $2, $3, $4, $5) RETURNING *`,
      [sessionId, label, clean(body.role, 40) || 'Other', clean(body.color, 9) || PALETTE[n % PALETTE.length], n],
    );
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, `A speaker called ${label} already exists`);
    throw err;
  }
}

export async function updateSpeaker(id, body) {
  const sets = [];
  const params = [Number(id)];
  if ('label' in body) {
    const label = clean(body.label, 60).toUpperCase();
    if (!label) throw new HttpError(400, 'Speaker label is required');
    params.push(label); sets.push(`label = $${params.length}`);
  }
  if ('role' in body) { params.push(clean(body.role, 40) || 'Other'); sets.push(`role = $${params.length}`); }
  if ('color' in body && /^#[0-9a-f]{6}$/i.test(body.color)) { params.push(body.color); sets.push(`color = $${params.length}`); }
  if (!sets.length) throw new HttpError(400, 'Nothing to update');
  try {
    const { rows } = await db.query(`UPDATE speakers SET ${sets.join(', ')} WHERE id = $1 RETURNING *`, params);
    if (!rows[0]) throw new HttpError(404, 'Speaker not found');
    return rows[0];
  } catch (err) {
    if (err.code === '23505') throw new HttpError(409, 'Another speaker already has that label');
    throw err;
  }
}

export async function deleteSpeaker(id) {
  const { rows } = await db.query('DELETE FROM speakers WHERE id = $1 RETURNING *', [Number(id)]);
  if (!rows[0]) throw new HttpError(404, 'Speaker not found');
  return rows[0];
}

async function assertSpeakerInSession(q, speakerId, sessionId) {
  if (speakerId == null) return null;
  const { rows } = await q('SELECT id FROM speakers WHERE id = $1 AND session_id = $2', [Number(speakerId), sessionId]);
  if (!rows[0]) throw new HttpError(400, 'Speaker does not belong to this hearing');
  return rows[0].id;
}

// ---- segments -------------------------------------------------------------

export async function listSegments(sessionId) {
  const { rows } = await db.query(
    `SELECT ${SEG} FROM segments s WHERE s.session_id = $1 ORDER BY s.start_ms, s.id`,
    [sessionId],
  );
  return rows;
}

export async function getSegment(id, q = db.query) {
  const { rows } = await q(`SELECT ${SEG} FROM segments s WHERE s.id = $1`, [Number(id)]);
  if (!rows[0]) throw new HttpError(404, 'Segment not found');
  return rows[0];
}

/** Insert a segment. Returns { segment, duplicate } — duplicate when client_id was seen before. */
export async function createSegment(sessionId, body, source = 'speech') {
  const text = clean(body.text, 10000);
  if (!text) throw new HttpError(400, 'Segment text is required');
  const start = toMs(body.start_ms ?? 0, 'start_ms');
  const end = Math.max(start, toMs(body.end_ms ?? start, 'end_ms'));
  const clientId = isUuid(body.client_id) ? body.client_id : null;

  return db.tx(async (q) => {
    const { rows: [session] } = await q('SELECT id FROM sessions WHERE id = $1', [sessionId]);
    if (!session) throw new HttpError(404, 'Hearing not found');
    const speakerId = await assertSpeakerInSession(q, body.speaker_id ?? null, sessionId);
    const confidence = Number.isFinite(Number(body.confidence)) && body.confidence !== null ? Number(body.confidence) : null;
    const { rows } = await q(
      `INSERT INTO segments (session_id, speaker_id, client_id, start_ms, end_ms, text, source, confidence)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       ON CONFLICT (client_id) DO NOTHING RETURNING id`,
      [sessionId, speakerId, clientId, start, end, text, source, confidence],
    );
    if (rows[0]) return { segment: await getSegment(rows[0].id, q), duplicate: false };
    const { rows: existing } = await q(`SELECT ${SEG} FROM segments s WHERE s.client_id = $1`, [clientId]);
    return { segment: existing[0], duplicate: true };
  });
}

/**
 * Update with optimistic concurrency: the caller sends the version it edited;
 * if someone else saved first, a 409 carries the current segment instead.
 */
export async function updateSegment(id, body, editedBy = null) {
  return db.tx(async (q) => {
    const { rows } = await q('SELECT * FROM segments WHERE id = $1 FOR UPDATE', [Number(id)]);
    const cur = rows[0];
    if (!cur) throw new HttpError(404, 'Segment not found');
    if (body.version != null && Number(body.version) !== cur.version) {
      throw new HttpError(409, 'This line was changed by someone else. Review the latest version.', {
        segment: await getSegment(cur.id, q),
      });
    }

    const next = {
      text: 'text' in body ? clean(body.text, 10000) : cur.text,
      speaker_id: 'speaker_id' in body ? await assertSpeakerInSession(q, body.speaker_id, cur.session_id) : cur.speaker_id,
      start_ms: 'start_ms' in body ? toMs(body.start_ms, 'start_ms') : cur.start_ms,
      end_ms: 'end_ms' in body ? toMs(body.end_ms, 'end_ms') : cur.end_ms,
    };
    if (!next.text) throw new HttpError(400, 'Segment text cannot be empty; delete the line instead');
    if (next.end_ms < next.start_ms) next.end_ms = next.start_ms;

    const unchanged = next.text === cur.text && next.speaker_id === cur.speaker_id
      && next.start_ms === cur.start_ms && next.end_ms === cur.end_ms;
    if (unchanged) return getSegment(cur.id, q);

    await q(
      `INSERT INTO segment_revisions (segment_id, version, text, speaker_id, start_ms, end_ms, edited_by)
       VALUES ($1, $2, $3, $4, $5, $6, $7)`,
      [cur.id, cur.version, cur.text, cur.speaker_id, cur.start_ms, cur.end_ms, editedBy],
    );
    await q(
      `UPDATE segments SET text = $2, speaker_id = $3, start_ms = $4, end_ms = $5,
              version = version + 1, updated_at = now() WHERE id = $1`,
      [cur.id, next.text, next.speaker_id, next.start_ms, next.end_ms],
    );
    return getSegment(cur.id, q);
  });
}

export async function deleteSegment(id) {
  const { rows } = await db.query('DELETE FROM segments WHERE id = $1 RETURNING id, session_id', [Number(id)]);
  if (!rows[0]) throw new HttpError(404, 'Segment not found');
  return rows[0];
}

export async function deleteSegmentsBySource(sessionId, sources) {
  const { rowCount } = await db.query(
    'DELETE FROM segments WHERE session_id = $1 AND source = ANY($2::text[])',
    [sessionId, sources],
  );
  return rowCount;
}

export async function listRevisions(segmentId) {
  const { rows } = await db.query(
    `SELECT r.*, sp.label AS speaker_label FROM segment_revisions r
       LEFT JOIN speakers sp ON sp.id = r.speaker_id
      WHERE r.segment_id = $1 ORDER BY r.version DESC`,
    [Number(segmentId)],
  );
  return rows;
}

// ---- search ---------------------------------------------------------------

export const HL_START = '⟦';
export const HL_STOP = '⟧';

/**
 * Full-text search (stemmed: "objected" finds "objection") combined with a
 * substring match so partial words still hit. Scoped to one hearing when
 * sessionId is given, ranked across all hearings otherwise.
 */
export async function search(query, sessionId) {
  const q = clean(query, 200);
  if (!q) return [];
  const scoped = isUuid(sessionId);
  const params = [q, `%${escapeLike(q)}%`, `StartSel=${HL_START}, StopSel=${HL_STOP}, HighlightAll=true`];
  if (scoped) params.push(sessionId);
  const { rows } = await db.query(
    `SELECT s.id, s.session_id, s.speaker_id, s.start_ms, s.end_ms,
            sp.label AS speaker_label, sp.color AS speaker_color,
            se.case_number, se.title,
            ts_headline('english', s.text, tq, $3) AS headline,
            ts_rank(s.search, tq) + CASE WHEN s.text ILIKE $2 THEN 0.5 ELSE 0 END AS rank
       FROM segments s
       JOIN sessions se ON se.id = s.session_id
       LEFT JOIN speakers sp ON sp.id = s.speaker_id,
       websearch_to_tsquery('english', $1) tq
      WHERE (s.search @@ tq OR s.text ILIKE $2) ${scoped ? 'AND s.session_id = $4' : ''}
      ORDER BY ${scoped ? 's.start_ms, s.id' : 'rank DESC, s.created_at DESC'}
      LIMIT 300`,
    params,
  );
  // ILIKE-only hits get no ts_headline marks; mark the substring ourselves.
  const needle = q.toLowerCase();
  for (const r of rows) {
    if (!r.headline.includes(HL_START)) {
      const at = r.headline.toLowerCase().indexOf(needle);
      if (at >= 0) {
        r.headline = r.headline.slice(0, at) + HL_START + r.headline.slice(at, at + q.length) + HL_STOP + r.headline.slice(at + q.length);
      }
    }
  }
  return rows;
}

function escapeLike(s) {
  return s.replace(/[\\%_]/g, (c) => '\\' + c);
}

// Live Whisper transcription of a recording in progress.
//
// Audio arrives in 250 ms frames. We track loudness in 20 ms windows against
// an adaptive noise floor and cut the stream at natural pauses (or at the
// quietest moment once a chunk reaches 25 s). Each cut chunk is transcribed by
// Whisper with word timestamps, and lines are split wherever the operator
// switched speaker, using the exact time of each word. Between cuts, the
// pending audio is re-transcribed now and then as a live "partial" preview.
import fs from 'node:fs';
import * as svc from './transcript.js';

const RATE = 16000;
const WIN = 320; // 20 ms analysis window
const MIN_PAUSE_MS = 600;
const MIN_VOICED_MS = 700;
const MAX_CHUNK_MS = 25_000;
const PARTIAL_EVERY_MS = 1200;
const CONTEXT_CHARS = 220;
const BASE_PROMPT = 'Transcript of court proceedings.';

export class LiveTranscriber {
  constructor({ engine, audio, broadcast }) {
    this.engine = engine;
    this.audio = audio;
    this.broadcast = broadcast;
    this.sessions = new Map();
    this.busy = new Set(); // hearings being re-transcribed
  }

  active(sessionId) {
    return this.sessions.get(sessionId)?.active === true;
  }

  begin(sessionId, { language = 'en', speakerId = null }) {
    const total = this.audio.samples(sessionId);
    let st = this.sessions.get(sessionId);
    if (st?.active) return st; // reconnect mid-recording: keep going
    st = {
      sessionId,
      file: this.audio.file(sessionId),
      language,
      active: true,
      committed: total,     // first sample not yet sent for final transcription
      analysed: total,      // first sample not yet analysed for loudness
      wins: [],             // { rms } per 20 ms window from `committed`
      noise: 0.004,
      timeline: [{ sample: total, speakerId }],
      context: '',
      lastPartial: 0,
      partialBusy: false,
      chain: Promise.resolve(),
    };
    this.sessions.set(sessionId, st);
    return st;
  }

  speaker(sessionId, atMs, speakerId) {
    const st = this.sessions.get(sessionId);
    if (!st) return;
    const sample = Math.max(0, Math.round((atMs / 1000) * RATE));
    st.timeline.push({ sample, speakerId });
    st.timeline.sort((a, b) => a.sample - b.sample);
  }

  speakerAt(st, sample) {
    let id = st.timeline[0]?.speakerId ?? null;
    for (const t of st.timeline) {
      if (t.sample <= sample) id = t.speakerId; else break;
    }
    return id;
  }

  /** Called after new audio has been stored; `total` is samples on disk. */
  onAudio(sessionId, total) {
    const st = this.sessions.get(sessionId);
    if (!st?.active || total <= st.analysed) return;
    this.analyse(st, total);
    this.decide(st);
  }

  analyse(st, total) {
    const from = st.analysed;
    const n = Math.floor((total - from) / WIN) * WIN;
    if (n <= 0) return;
    const buf = Buffer.alloc(n * 2);
    const fd = fs.openSync(st.file, 'r');
    try { fs.readSync(fd, buf, 0, buf.length, from * 2); } finally { fs.closeSync(fd); }
    for (let w = 0; w < n; w += WIN) {
      let sq = 0;
      for (let i = 0; i < WIN; i++) {
        const v = buf.readInt16LE((w + i) * 2) / 32768;
        sq += v * v;
      }
      const rms = Math.sqrt(sq / WIN);
      // Noise floor falls quickly to quiet moments and creeps up slowly.
      st.noise = rms < st.noise ? st.noise * 0.7 + rms * 0.3 : st.noise * 0.998 + rms * 0.002;
      st.wins.push(rms);
    }
    st.analysed = from + n;
  }

  decide(st) {
    const threshold = Math.min(0.05, Math.max(0.008, st.noise * 3));
    let voiced = 0;
    let trailing = 0;
    for (const rms of st.wins) {
      if (rms >= threshold) { voiced++; trailing = 0; } else trailing++;
    }
    const winMs = (WIN / RATE) * 1000;
    const voicedMs = voiced * winMs;
    const trailingMs = trailing * winMs;
    const pendingMs = ((st.analysed - st.committed) / RATE) * 1000;

    // Long stretch of silence: skip it rather than spend GPU time on it.
    if (voicedMs < 200 && pendingMs > 8000) {
      this.advance(st, st.analysed - RATE / 2);
      return;
    }

    if ((trailingMs >= MIN_PAUSE_MS && voicedMs >= MIN_VOICED_MS) || pendingMs >= MAX_CHUNK_MS) {
      let cut;
      if (pendingMs >= MAX_CHUNK_MS && trailingMs < MIN_PAUSE_MS) {
        // No pause: cut at the quietest window in the last 4 s.
        const look = Math.min(st.wins.length, Math.round(4000 / winMs));
        let best = st.wins.length - 1;
        for (let i = st.wins.length - look; i < st.wins.length; i++) if (st.wins[i] < st.wins[best]) best = i;
        cut = st.committed + best * WIN;
      } else {
        cut = st.analysed - Math.round((trailing * WIN) / 2);
      }
      this.finalChunk(st, st.committed, cut);
      this.advance(st, cut);
      return;
    }

    const now = Date.now();
    if (voicedMs >= 400 && !st.partialBusy && now - st.lastPartial > PARTIAL_EVERY_MS) {
      st.lastPartial = now;
      this.partialChunk(st, st.committed, st.analysed);
    }
  }

  advance(st, sample) {
    const drop = Math.max(0, Math.floor((sample - st.committed) / WIN));
    st.wins.splice(0, drop);
    st.committed = sample;
  }

  prompt(st) {
    return `${BASE_PROMPT} ${st.context}`.trim();
  }

  partialChunk(st, start, end) {
    st.partialBusy = true;
    let text = '';
    this.engine.transcribe({
      file: st.file, start, end, language: st.language, prompt: this.prompt(st), partial: true, key: st.sessionId,
    }, (seg) => { text += (text ? ' ' : '') + seg.text; })
      .then((r) => {
        // Ignore a preview made stale by a final cut while it was running.
        if (r.dropped || !st.active || start !== st.committed || !text) return;
        this.broadcast(st.sessionId, {
          type: 'partial', from: 'whisper', text,
          speakerId: this.speakerAt(st, end), startMs: toMs(start),
        });
      })
      .catch(() => {})
      .finally(() => { st.partialBusy = false; });
  }

  finalChunk(st, start, end) {
    if (end - start < RATE / 4) return st.chain;
    const job = this.engine.transcribe({
      file: st.file, start, end, language: st.language, prompt: this.prompt(st),
    }, (seg) => {
      // Insert in order, one segment at a time.
      st.chain = st.chain.then(() => this.commit(st, seg, start)).catch((err) => console.error('live commit:', err.message));
    }).then(() => st.chain)
      .then(() => this.broadcast(st.sessionId, { type: 'partial', from: 'whisper', text: '' }))
      .catch((err) => {
        console.error('live transcription:', err.message);
        this.broadcast(st.sessionId, { type: 'transcriber.status', state: 'error', message: err.message });
      });
    return job;
  }

  async commit(st, seg, chunkStart) {
    const lines = toLines(seg, chunkStart, (sample) => this.speakerAt(st, sample));
    for (const line of lines) {
      const { segment, duplicate } = await svc.createSegment(st.sessionId, line, 'speech');
      if (!duplicate) this.broadcast(st.sessionId, { type: 'segment.created', segment, from: 'whisper' });
      st.context = `${st.context} ${line.text}`.slice(-CONTEXT_CHARS);
    }
  }

  /** Recording paused or stopped: transcribe whatever is left. */
  async end(sessionId) {
    const st = this.sessions.get(sessionId);
    if (!st?.active) return;
    const total = this.audio.samples(sessionId);
    this.analyse(st, total);
    st.active = false;
    await this.finalChunk(st, st.committed, total);
    this.advance(st, total);
    this.sessions.delete(sessionId);
  }

  drop(sessionId) {
    const st = this.sessions.get(sessionId);
    if (st) st.active = false;
    this.sessions.delete(sessionId);
  }

  /**
   * Re-run a whole recorded hearing through Whisper, replacing machine-made
   * lines (typed lines are kept). Speakers carry over from the old lines that
   * overlap in time. Lines stream to viewers as they are produced.
   */
  async retranscribe(sessionId, { language = 'en' } = {}) {
    if (this.busy.has(sessionId)) throw new svc.HttpError(409, 'This hearing is already being re-transcribed');
    if (this.active(sessionId)) throw new svc.HttpError(409, 'Stop recording before re-transcribing');
    if (!this.engine.ready) throw new svc.HttpError(503, `Whisper is not available: ${this.engine.status.message}`);
    const total = this.audio.samples(sessionId);
    if (total < RATE / 2) throw new svc.HttpError(400, 'No audio to transcribe');

    const old = (await svc.listSegments(sessionId)).filter((s) => s.source !== 'manual');
    const speakerAt = (sample) => {
      const ms = toMs(sample);
      let best = null;
      for (const s of old) {
        if (s.start_ms <= ms + 300 && ms <= s.end_ms + 1500) return s.speaker_id;
        if (s.start_ms <= ms) best = s; // last line that began before this point
      }
      return best && ms - best.end_ms < 4000 ? best.speaker_id : null;
    };

    this.busy.add(sessionId);
    await svc.deleteSegmentsBySource(sessionId, ['speech', 'import']);
    this.broadcast(sessionId, { type: 'transcript.reload' });
    this.broadcast(sessionId, { type: 'transcriber.status', state: 'retranscribing', totalMs: toMs(total) });

    let chain = Promise.resolve();
    let lines = 0;
    this.engine.transcribe({ file: this.audio.file(sessionId), start: 0, end: total, language, prompt: BASE_PROMPT }, (seg) => {
      chain = chain.then(async () => {
        for (const line of toLines(seg, 0, speakerAt)) {
          const { segment } = await svc.createSegment(sessionId, line, 'speech');
          lines++;
          this.broadcast(sessionId, { type: 'segment.created', segment, from: 'whisper' });
          this.broadcast(sessionId, { type: 'transcriber.status', state: 'retranscribing', totalMs: toMs(total), doneMs: line.end_ms });
        }
      });
    })
      .then(() => chain)
      .then(() => this.broadcast(sessionId, { type: 'transcriber.status', state: 'done', lines }))
      .catch((err) => this.broadcast(sessionId, { type: 'transcriber.status', state: 'error', message: err.message }))
      .finally(() => this.busy.delete(sessionId));
    return { started: true, totalMs: toMs(total) };
  }
}

/**
 * Turn one Whisper segment into transcript lines, split wherever the speaker
 * timeline changes between words. Filters likely hallucinations.
 */
export function toLines(seg, chunkStart, speakerAt) {
  const text = (seg.text || '').trim();
  if (!text) return [];
  if (seg.no_speech_prob > 0.6 && seg.avg_logprob < -1) return [];
  const abs = (sec) => chunkStart + Math.round(sec * RATE);
  const words = (seg.words || []).filter((w) => w.word.trim());
  const confidence = Math.exp(seg.avg_logprob ?? 0);

  if (!words.length) {
    const s = abs(seg.start);
    return [{ text, start_ms: toMs(s), end_ms: toMs(abs(seg.end)), speaker_id: speakerAt(s), confidence }];
  }
  const lines = [];
  let cur = null;
  for (const w of words) {
    const s = abs(w.start);
    const speaker = speakerAt(s);
    if (!cur || cur.speaker_id !== speaker) {
      cur = { words: [], speaker_id: speaker, start: s, end: abs(w.end), probs: [] };
      lines.push(cur);
    }
    cur.words.push(w.word);
    cur.probs.push(w.p);
    cur.end = abs(w.end);
  }
  return lines.map((l) => ({
    text: capitalise(l.words.join('').trim()),
    start_ms: toMs(l.start),
    end_ms: toMs(l.end),
    speaker_id: l.speaker_id,
    confidence: l.probs.reduce((a, b) => a + b, 0) / l.probs.length,
  })).filter((l) => l.text);
}

const toMs = (samples) => Math.round((samples / RATE) * 1000);
const capitalise = (s) => s.charAt(0).toUpperCase() + s.slice(1);

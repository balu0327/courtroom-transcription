// Audio storage. Each hearing's audio is one raw 16-bit mono PCM file. Raw
// PCM keeps timing exact (sample N is always at N / sampleRate seconds), so
// transcript timestamps line up with playback, and appending survives crashes.
// It is served as WAV by generating the 44-byte header on the fly.
import fs from 'node:fs';
import path from 'node:path';

const BYTES_PER_SAMPLE = 2;
const MAX_GAP_SECONDS = 600; // refuse to pad more than 10 minutes of silence

export class AudioStore {
  constructor(dir) {
    this.dir = dir;
    fs.mkdirSync(dir, { recursive: true });
    this.lengths = new Map(); // sessionId -> samples written
    this.chains = new Map();  // sessionId -> promise, serialises writes per hearing
  }

  file(sessionId) {
    return path.join(this.dir, `${sessionId}.pcm`);
  }

  samples(sessionId) {
    if (this.lengths.has(sessionId)) return this.lengths.get(sessionId);
    let n = 0;
    try { n = Math.floor(fs.statSync(this.file(sessionId)).size / BYTES_PER_SAMPLE); } catch {}
    this.lengths.set(sessionId, n);
    return n;
  }

  /**
   * Write PCM that starts at absolute sample `offset`. Idempotent: data the
   * server already has (a resend after reconnect) is skipped, overlap is
   * trimmed, and a gap (lost frames) is filled with silence so later audio
   * stays at the right time. Resolves to the total samples stored.
   */
  write(sessionId, offset, pcm, sampleRate) {
    const prev = this.chains.get(sessionId) || Promise.resolve();
    const next = prev.catch(() => {}).then(async () => {
      const have = this.samples(sessionId);
      const count = Math.floor(pcm.length / BYTES_PER_SAMPLE);
      if (!Number.isInteger(offset) || offset < 0) throw new Error('bad audio offset');
      if (offset + count <= have) return have; // duplicate

      let data = pcm.subarray(0, count * BYTES_PER_SAMPLE);
      if (offset < have) {
        data = data.subarray((have - offset) * BYTES_PER_SAMPLE);
      } else if (offset > have) {
        const gap = offset - have;
        if (gap > sampleRate * MAX_GAP_SECONDS) throw new Error('audio gap too large');
        data = Buffer.concat([Buffer.alloc(gap * BYTES_PER_SAMPLE), data]);
      }
      await fs.promises.appendFile(this.file(sessionId), data);
      const total = have + data.length / BYTES_PER_SAMPLE;
      this.lengths.set(sessionId, total);
      return total;
    });
    this.chains.set(sessionId, next);
    return next;
  }

  async remove(sessionId) {
    await (this.chains.get(sessionId) || Promise.resolve()).catch(() => {});
    this.lengths.delete(sessionId);
    this.chains.delete(sessionId);
    await removeWithRetry(this.file(sessionId));
  }

  /** Stream the hearing as WAV, honouring HTTP Range so the player can seek. */
  serveWav(req, res, sessionId, sampleRate) {
    const dataBytes = this.samples(sessionId) * BYTES_PER_SAMPLE;
    if (!dataBytes) return res.status(404).json({ error: 'No audio recorded yet' });

    const header = wavHeader(dataBytes, sampleRate);
    const total = header.length + dataBytes;
    let start = 0;
    let end = total - 1;

    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range || '');
    if (range) {
      if (range[1] === '' && range[2] !== '') {
        start = Math.max(0, total - Number(range[2]));
      } else {
        start = Number(range[1] || 0);
        if (range[2] !== '') end = Math.min(Number(range[2]), total - 1);
      }
      if (start > end || start >= total) {
        res.status(416).set('Content-Range', `bytes */${total}`).end();
        return;
      }
      res.status(206).set('Content-Range', `bytes ${start}-${end}/${total}`);
    }
    res.set({
      'Content-Type': 'audio/wav',
      'Content-Length': String(end - start + 1),
      'Accept-Ranges': 'bytes',
      'Cache-Control': 'no-store',
    });
    if (req.method === 'HEAD') return res.end();

    if (start < header.length) res.write(header.subarray(start, Math.min(header.length, end + 1)));
    if (end < header.length) return res.end();
    const fileStart = Math.max(0, start - header.length);
    const fileEnd = end - header.length;
    fs.createReadStream(this.file(sessionId), { start: fileStart, end: fileEnd })
      .on('error', () => res.destroy())
      .pipe(res);
  }
}

/**
 * On Windows a file cannot be deleted while it is open, e.g. while a player
 * is streaming it or Whisper is reading it. Try now; if it is busy, keep
 * retrying in the background instead of failing the request and leaving an
 * orphaned recording behind.
 */
async function removeWithRetry(file, attempt = 0) {
  try {
    await fs.promises.rm(file, { force: true });
  } catch (err) {
    if (!['EBUSY', 'EPERM', 'EACCES'].includes(err.code) || attempt >= 60) {
      console.error(`Could not delete ${file}: ${err.message}`);
      return;
    }
    if (attempt === 0) console.warn(`${path.basename(file)} is in use; will delete it when released.`);
    setTimeout(() => removeWithRetry(file, attempt + 1), 5000).unref();
  }
}

export function wavHeader(dataBytes, sampleRate, channels = 1) {
  const b = Buffer.alloc(44);
  b.write('RIFF', 0);
  b.writeUInt32LE(36 + dataBytes, 4);
  b.write('WAVE', 8);
  b.write('fmt ', 12);
  b.writeUInt32LE(16, 16);
  b.writeUInt16LE(1, 20); // PCM
  b.writeUInt16LE(channels, 22);
  b.writeUInt32LE(sampleRate, 24);
  b.writeUInt32LE(sampleRate * channels * BYTES_PER_SAMPLE, 28);
  b.writeUInt16LE(channels * BYTES_PER_SAMPLE, 32);
  b.writeUInt16LE(16, 34);
  b.write('data', 36);
  b.writeUInt32LE(dataBytes, 40);
  return b;
}

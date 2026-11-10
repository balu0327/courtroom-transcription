// Runs the Python Whisper worker (transcriber/worker.py) as a child process
// and queues jobs to it. Final jobs run in order; partial (live preview) jobs
// are droppable: a newer partial for the same key replaces an older one.
import { spawn } from 'node:child_process';
import { EventEmitter } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));

function readRange(file, start, end) {
  const buf = Buffer.alloc(Math.max(0, end - start) * 2);
  const fd = fs.openSync(file, 'r');
  try {
    const n = fs.readSync(fd, buf, 0, buf.length, start * 2);
    return buf.subarray(0, n - (n % 2));
  } finally {
    fs.closeSync(fd);
  }
}

export class WhisperEngine extends EventEmitter {
  constructor({ dataDir }) {
    super();
    this.dataDir = dataDir;
    this.status = { state: 'unavailable', message: 'Not started' };
    this.finals = [];
    this.partials = new Map(); // key -> job
    this.current = null;
    this.nextId = 1;
    this.restarts = 0;
  }

  get ready() {
    return this.status.state === 'ready';
  }

  python() {
    const venv = process.env.WHISPER_VENV || path.join(this.dataDir, 'venv');
    const exe = process.platform === 'win32' ? path.join(venv, 'Scripts', 'python.exe') : path.join(venv, 'bin', 'python');
    return fs.existsSync(exe) ? exe : null;
  }

  start() {
    if (process.env.WHISPER === 'off') return this.setStatus({ state: 'unavailable', message: 'Disabled (WHISPER=off)' });
    const py = this.python();
    if (!py) return this.setStatus({ state: 'unavailable', message: 'Not installed. Run: npm run setup:whisper' });

    this.setStatus({ state: 'loading', message: 'Loading Whisper model (first run downloads it)…' });
    const proc = spawn(py, ['-u', path.join(here, '..', 'transcriber', 'worker.py')], {
      env: { ...process.env, WHISPER_MODELS_DIR: process.env.WHISPER_MODELS_DIR || path.join(this.dataDir, 'models'), PYTHONIOENCODING: 'utf-8' },
      stdio: ['pipe', 'pipe', 'pipe'],
      windowsHide: true,
    });
    this.proc = proc;

    readline.createInterface({ input: proc.stdout }).on('line', (line) => {
      let msg;
      try { msg = JSON.parse(line); } catch { return; }
      this.onMessage(msg);
    });
    readline.createInterface({ input: proc.stderr }).on('line', (line) => {
      if (line.startsWith('[whisper]')) console.log(line);
    });
    proc.on('error', (err) => this.setStatus({ state: 'error', message: err.message }));
    proc.on('exit', (code) => {
      if (this.proc !== proc) return;
      this.proc = null;
      const job = this.current;
      this.current = null;
      job?.reject(new Error('Whisper worker stopped'));
      if (this.stopping) return;
      const wasReady = this.status.state === 'ready';
      this.setStatus({ state: 'error', message: this.fatal || `Whisper worker exited (code ${code})` });
      // Restart after a crash mid-session; don't loop on a setup that never loads.
      if (wasReady && this.restarts++ < 5) setTimeout(() => this.start(), 3000);
    });
  }

  onMessage(msg) {
    if (msg.type === 'ready') {
      this.restarts = 0;
      this.setStatus({ state: 'ready', model: msg.model, device: msg.device, compute: msg.compute, message: `${msg.model} on ${msg.device.toUpperCase()}` });
      this.pump();
      return;
    }
    if (msg.type === 'fatal') { this.fatal = msg.message; return; }
    const job = this.current;
    if (!job || msg.id !== job.id) return;
    if (msg.type === 'segment') job.onSegment?.(msg);
    else if (msg.type === 'done' || msg.type === 'error') {
      this.current = null;
      if (msg.type === 'done') job.resolve({ seconds: msg.seconds });
      else job.reject(new Error(msg.message));
      this.pump();
    }
  }

  setStatus(status) {
    this.status = status;
    this.emit('status', status);
  }

  /**
   * Queue a transcription of samples [start, end) of a PCM file.
   * Resolves { seconds } when done, or { dropped: true } if a newer partial
   * with the same key replaced it before it ran.
   */
  transcribe({ file, start, end, language, prompt, partial = false, key }, onSegment) {
    return new Promise((resolve, reject) => {
      if (!this.ready) return reject(new Error(`Whisper is ${this.status.state}: ${this.status.message}`));
      const job = { id: this.nextId++, req: { file, start, end, language, prompt, partial }, onSegment, resolve, reject };
      if (partial) {
        this.partials.get(key)?.resolve({ dropped: true });
        this.partials.set(key, job);
      } else {
        this.finals.push(job);
      }
      this.pump();
    });
  }

  pump() {
    if (this.current || !this.ready || !this.proc) return;
    let job = this.finals.shift();
    if (!job) {
      const first = this.partials.entries().next().value;
      if (!first) return;
      this.partials.delete(first[0]);
      job = first[1];
    }
    this.current = job;
    const { file, start, end, ...opts } = job.req;
    let pcm;
    try {
      pcm = readRange(file, start, end);
    } catch (err) {
      this.current = null;
      job.reject(err);
      return this.pump();
    }
    // Header line, then the raw PCM bytes.
    this.proc.stdin.write(JSON.stringify({ id: job.id, bytes: pcm.length, ...opts }) + '\n');
    this.proc.stdin.write(pcm);
  }

  stop() {
    this.stopping = true;
    this.proc?.kill();
  }
}

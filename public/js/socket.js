// Reconnecting WebSocket client with delivery guarantees.
//
// - Exponential backoff with jitter (0.5 s -> 15 s), immediate retry when the
//   browser reports it is back online.
// - Heartbeat watchdog: the server sends a heartbeat every 10 s; if none
//   arrives for 25 s the link is treated as dead even if TCP has not noticed.
// - Audio frames stay queued until the server acknowledges the samples, and
//   "reliable" messages stay queued until acked by clientId. After a reconnect
//   everything still queued is resent; the server de-duplicates both.
// - "Volatile" messages (live partial text) are dropped while offline.
const HEARTBEAT_TIMEOUT = 25_000;

export class LiveSocket extends EventTarget {
  constructor({ sessionId, clientId, name }) {
    super();
    this.sessionId = sessionId;
    this.clientId = clientId;
    this.name = name;
    this.role = 'viewer';
    this.state = 'idle';
    this.attempt = 0;
    this.audioQueue = [];         // { offset, pcm: Int16Array }
    this.pending = new Map();     // clientId -> { msg, resolve, reject }
    this.lastBeat = Date.now();
    this.closed = false;
    this.connections = 0;

    this.onOnline = () => { if (this.state !== 'open') this.reconnectNow(); };
    this.onOffline = () => this.setState('offline');
    window.addEventListener('online', this.onOnline);
    window.addEventListener('offline', this.onOffline);
    this.watchdog = setInterval(() => {
      if (this.state === 'open' && Date.now() - this.lastBeat > HEARTBEAT_TIMEOUT) this.drop('heartbeat timeout');
    }, 5000);
  }

  connect() {
    if (this.closed) return;
    clearTimeout(this.retryTimer);
    this.setState(this.connections ? 'reconnecting' : 'connecting');
    const ws = new WebSocket(`${location.protocol === 'https:' ? 'wss' : 'ws'}://${location.host}/ws`);
    ws.binaryType = 'arraybuffer';
    this.ws = ws;
    ws.onopen = () => {
      ws.send(JSON.stringify({ type: 'hello', sessionId: this.sessionId, clientId: this.clientId, role: this.role, name: this.name }));
    };
    ws.onmessage = (e) => this.handle(JSON.parse(e.data));
    ws.onclose = () => { if (this.ws === ws) this.onDisconnect(); };
    ws.onerror = () => {};
  }

  handle(msg) {
    this.lastBeat = Date.now();
    switch (msg.type) {
      case 'hello.ok': {
        const reconnected = this.connections > 0;
        this.connections++;
        this.attempt = 0;
        if (msg.role !== this.role && this.role === 'recorder') this.role = msg.role;
        this.setState('open');
        this.flush();
        this.emit('ready', { ...msg, reconnected });
        return;
      }
      case 'audio.ack': {
        while (this.audioQueue.length) {
          const f = this.audioQueue[0];
          if (f.offset + f.pcm.length <= msg.samples) this.audioQueue.shift();
          else break;
        }
        this.emit('queue');
        return;
      }
      case 'ack': {
        const p = this.pending.get(msg.clientId);
        if (p) {
          this.pending.delete(msg.clientId);
          if (msg.ok === false) p.reject(Object.assign(new Error(msg.message || 'Rejected'), { code: msg.code }));
          else p.resolve(msg);
          this.emit('queue');
        }
        return;
      }
      case 'heartbeat':
        return;
      default:
        this.emit('message', msg);
    }
  }

  onDisconnect() {
    if (this.closed) return;
    this.ws = null;
    if (!navigator.onLine) { this.setState('offline'); return; }
    const delay = Math.min(15_000, 500 * 2 ** this.attempt) * (0.5 + Math.random() * 0.5);
    this.attempt++;
    this.retryAt = Date.now() + delay;
    this.setState('reconnecting');
    this.retryTimer = setTimeout(() => this.connect(), delay);
  }

  /** Close the current link (used by the watchdog and the "simulate drop" control). */
  drop(reason = 'manual') {
    const ws = this.ws;
    if (!ws) return;
    this.ws = null;
    ws.onclose = null;
    try { ws.close(4000, reason); } catch {}
    this.onDisconnect();
  }

  reconnectNow() {
    clearTimeout(this.retryTimer);
    this.attempt = 0;
    if (this.ws) this.drop('reconnect');
    clearTimeout(this.retryTimer);
    this.connect();
  }

  flush() {
    if (this.state !== 'open') return;
    for (const f of this.audioQueue) this.ws.send(frame(f.offset, f.pcm));
    for (const { msg } of this.pending.values()) this.ws.send(JSON.stringify(msg));
  }

  sendAudio(offset, pcm) {
    this.audioQueue.push({ offset, pcm });
    if (this.state === 'open') this.ws.send(frame(offset, pcm));
    this.emit('queue');
  }

  /** Delivered at-least-once; resolves with the server's ack. */
  sendReliable(msg) {
    msg.clientId ||= crypto.randomUUID();
    return new Promise((resolve, reject) => {
      this.pending.set(msg.clientId, { msg, resolve, reject });
      if (this.state === 'open') this.ws.send(JSON.stringify(msg));
      this.emit('queue');
    });
  }

  sendVolatile(msg) {
    if (this.state === 'open') this.ws.send(JSON.stringify(msg));
  }

  get queuedAudioMs() {
    return Math.round(this.audioQueue.reduce((n, f) => n + f.pcm.length, 0) / 16);
  }

  get pendingCount() {
    return this.pending.size;
  }

  setState(state) {
    if (this.state === state && state !== 'reconnecting') return;
    this.state = state;
    this.emit('status', { state, attempt: this.attempt, retryAt: this.retryAt });
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }

  close() {
    this.closed = true;
    clearTimeout(this.retryTimer);
    clearInterval(this.watchdog);
    window.removeEventListener('online', this.onOnline);
    window.removeEventListener('offline', this.onOffline);
    if (this.ws) { this.ws.onclose = null; this.ws.close(1000); }
  }
}

function frame(offset, pcm) {
  const buf = new ArrayBuffer(8 + pcm.byteLength);
  new DataView(buf).setFloat64(0, offset, true);
  new Int16Array(buf, 8).set(pcm);
  return buf;
}

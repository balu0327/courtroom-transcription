// Microphone capture + live speech recognition.
//
// Audio: getUserMedia -> AudioWorklet -> 16 kHz Int16 PCM chunks. The running
// sample count is the hearing's master clock: every transcript timestamp is
// expressed in it, so text lines up with the stored recording.
//
// Recognition: the browser's Web Speech API (Chrome, Edge, Safari). It gives
// interim and final text but no timestamps, so an utterance's start is taken
// from the audio clock when its first interim words arrive (minus a latency
// allowance) and its end when the final result arrives. Lines can be re-synced
// against playback in the editor.
export const TARGET_RATE = 16000;
const RECOGNITION_LAG_MS = 900;
const MAX_UTTERANCE_MS = 20_000; // force a line break in long unpunctuated speech

const SpeechRecognition = window.SpeechRecognition || window.webkitSpeechRecognition;
export const speechSupported = Boolean(SpeechRecognition);

export class Recorder extends EventTarget {
  constructor() {
    super();
    this.running = false;
    this.samples = 0;
    this.utterance = null; // { startMs, speakerId }
  }

  get currentMs() {
    return Math.round((this.samples / TARGET_RATE) * 1000);
  }

  /** Start capturing. `startSample` continues an existing recording. */
  async start({ startSample = 0, lang = 'en-US', speakerId = null, transcribe = true }) {
    if (this.running) return;
    this.samples = startSample;
    this.speakerId = speakerId;
    this.lang = lang;

    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: { channelCount: 1, echoCancellation: false, noiseSuppression: true, autoGainControl: true },
    });
    this.ctx = await createContext(this.stream);
    await this.ctx.audioContext.audioWorklet.addModule('/js/pcm-worklet.js');
    this.node = new AudioWorkletNode(this.ctx.audioContext, 'pcm-capture', {
      processorOptions: { targetRate: TARGET_RATE },
    });
    this.node.port.onmessage = (e) => {
      const { pcm, rms } = e.data;
      const offset = this.samples;
      this.samples += pcm.length;
      this.emit('audio', { offset, pcm });
      this.emit('level', { rms });
    };
    this.ctx.source.connect(this.node);
    // Keep the graph pulling without making the mic audible.
    const mute = this.ctx.audioContext.createGain();
    mute.gain.value = 0;
    this.node.connect(mute).connect(this.ctx.audioContext.destination);

    this.running = true;
    if (transcribe && speechSupported) this.startRecognition();
  }


  startRecognition() {
    this.recognitionErrors = 0;
    this.restarts = 0;
    this.spawnRecognition();
  }

  // A fresh SpeechRecognition object per run: restarting an ended instance
  // can throw InvalidStateError in Chrome, which used to kill recognition
  // silently for the rest of the recording.
  spawnRecognition() {
    const rec = new SpeechRecognition();
    rec.lang = this.lang;
    rec.continuous = true;
    rec.interimResults = true;
    rec.maxAlternatives = 1;
    this.recognition = rec;
    this.interim = '';
    this.forcedCut = false;

    rec.onstart = () => {
      this.trace('start');
      this.emit('recognition-state', { state: 'listening', restarts: this.restarts });
    };
    // Lifecycle events tell us how far the recogniser gets: hearing audio at
    // all, detecting sound, detecting speech, then returning results.
    rec.onaudiostart = () => this.trace('audiostart');
    rec.onsoundstart = () => this.trace('soundstart');
    rec.onspeechstart = () => this.trace('speechstart');
    rec.onnomatch = () => this.trace('nomatch');

    rec.onresult = (event) => {
      this.recognitionErrors = 0;
      this.trace('result');
      let interim = '';
      for (let i = event.resultIndex; i < event.results.length; i++) {
        const result = event.results[i];
        const text = result[0].transcript.trim();
        if (!text) continue;
        if (!this.utterance) {
          this.utterance = { startMs: Math.max(0, this.currentMs - RECOGNITION_LAG_MS), speakerId: this.speakerId };
        }
        if (result.isFinal) {
          this.commitUtterance(text, result[0].confidence || null);
        } else {
          interim += (interim ? ' ' : '') + text;
        }
      }
      this.interim = interim;
      this.emit('partial', {
        text: interim,
        startMs: this.utterance?.startMs ?? null,
        speakerId: this.utterance?.speakerId ?? this.speakerId,
      });
      // Continuous talking with no pause can keep one result "interim" for a
      // long time. Cut it: stop() makes Chrome finalise what it has, and onend
      // starts a new run.
      if (this.utterance && !this.forcedCut && this.currentMs - this.utterance.startMs > MAX_UTTERANCE_MS) {
        this.forcedCut = true;
        try { rec.stop(); } catch {}
      }
    };

    rec.onerror = (e) => {
      this.trace(`error: ${e.error}${e.message ? ` (${e.message})` : ''}`);
      if (e.error === 'no-speech' || e.error === 'aborted') return;
      this.recognitionErrors++;
      this.emit('recognition-error', { error: e.error });
    };

    // Chrome ends continuous recognition after silence, after ~60 s, or when
    // stop() is called. Keep any unfinished words, then start a new run for as
    // long as we are recording, backing off if it keeps failing (e.g. offline).
    rec.onend = () => {
      this.trace('end');
      if (this.recognition !== rec) return;
      this.commitInterim();
      this.endWaiter?.();
      if (!this.running) return;
      this.restarts++;
      this.emit('recognition-state', { state: 'restarting', restarts: this.restarts });
      const wait = this.recognitionErrors ? Math.min(10_000, 250 * 2 ** this.recognitionErrors) : 50;
      this.restartTimer = setTimeout(() => {
        if (this.running && this.recognition === rec) this.spawnRecognition();
      }, wait);
    };

    try {
      rec.start();
    } catch (err) {
      this.trace(`start failed: ${err.message}`);
      this.recognitionErrors++;
      this.emit('recognition-error', { error: err.message });
      this.restartTimer = setTimeout(() => {
        if (this.running && this.recognition === rec) this.spawnRecognition();
      }, Math.min(10_000, 500 * 2 ** this.recognitionErrors));
    }
  }

  trace(event) {
    this.emit('recognition-trace', { event, atMs: this.currentMs });
  }

  commitUtterance(text, confidence) {
    const u = this.utterance || { startMs: Math.max(0, this.currentMs - RECOGNITION_LAG_MS), speakerId: this.speakerId };
    this.utterance = null;
    this.interim = '';
    this.emit('final', {
      text: capitalise(text),
      startMs: u.startMs,
      endMs: Math.max(u.startMs, this.currentMs - 250),
      speakerId: u.speakerId,
      confidence,
    });
  }

  /** Save words that were recognised but never finalised, instead of dropping them. */
  commitInterim() {
    if (this.interim) this.commitUtterance(this.interim, null);
    this.utterance = null;
    this.emit('partial', { text: '', startMs: null, speakerId: this.speakerId });
  }

  /** Switch speaker. An utterance in progress is closed out under the previous speaker. */
  setSpeaker(speakerId) {
    if (speakerId === this.speakerId) return;
    this.speakerId = speakerId;
    if (this.running && this.utterance && this.recognition) {
      try { this.recognition.stop(); } catch {} // forces a final result; onend restarts it
    }
  }

  async stop() {
    if (!this.running) return;
    this.running = false;
    clearTimeout(this.restartTimer);
    const rec = this.recognition;
    if (rec) {
      // Ask for the final result of what was being said, and wait briefly for it.
      const ended = new Promise((resolve) => { this.endWaiter = resolve; });
      try { rec.stop(); } catch {}
      await Promise.race([ended, new Promise((r) => setTimeout(r, 1500))]);
      this.endWaiter = null;
      if (this.recognition === rec) this.commitInterim();
      this.recognition = null;
    }
    this.node?.port.postMessage('flush');
    await new Promise((r) => setTimeout(r, 120)); // let the final audio chunk arrive
    this.stream?.getTracks().forEach((t) => t.stop());
    this.node?.disconnect();
    await this.ctx?.audioContext.close().catch(() => {});
    this.node = this.ctx = this.stream = null;
    this.utterance = null;
  }

  emit(type, detail) {
    this.dispatchEvent(new CustomEvent(type, { detail }));
  }
}

// Prefer a 16 kHz context so the browser does high-quality resampling; fall
// back to the device rate (the worklet then decimates) where that is refused.
async function createContext(stream) {
  try {
    const audioContext = new AudioContext({ sampleRate: TARGET_RATE });
    const source = audioContext.createMediaStreamSource(stream);
    return { audioContext, source };
  } catch {
    const audioContext = new AudioContext();
    return { audioContext, source: audioContext.createMediaStreamSource(stream) };
  }
}

function capitalise(s) {
  return s.charAt(0).toUpperCase() + s.slice(1);
}

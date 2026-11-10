// AudioWorklet: converts microphone float samples to 16 kHz 16-bit PCM in
// ~250 ms chunks, plus an RMS level for the meter. If the AudioContext already
// runs at 16 kHz the ratio is 1 and samples pass straight through.
class PcmCapture extends AudioWorkletProcessor {
  constructor(options) {
    super();
    this.targetRate = options.processorOptions.targetRate;
    this.ratio = sampleRate / this.targetRate;
    this.chunk = Math.round(this.targetRate / 4);
    this.buf = new Int16Array(this.chunk);
    this.len = 0;
    this.pos = 0;
    this.sum = 0;
    this.count = 0;
    this.sq = 0;
    this.sqN = 0;
    this.port.onmessage = (e) => { if (e.data === 'flush') this.emit(); };
  }

  emit() {
    if (!this.len) return;
    const pcm = this.buf.slice(0, this.len);
    const rms = Math.sqrt(this.sq / Math.max(1, this.sqN));
    this.port.postMessage({ pcm, rms }, [pcm.buffer]);
    this.len = 0;
    this.sq = 0;
    this.sqN = 0;
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0];
    if (!ch) return true;
    for (let i = 0; i < ch.length; i++) {
      const x = ch[i];
      this.sq += x * x;
      this.sqN++;
      // Box-filter decimation: average the input samples that fall into each output sample.
      this.sum += x;
      this.count++;
      this.pos += 1;
      if (this.pos >= this.ratio) {
        this.pos -= this.ratio;
        const v = Math.max(-1, Math.min(1, this.sum / this.count));
        this.sum = 0;
        this.count = 0;
        this.buf[this.len++] = v < 0 ? v * 0x8000 : v * 0x7fff;
        if (this.len === this.chunk) this.emit();
      }
    }
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);

// Turns the microphone into 16 kHz mono 16-bit samples, one second per message.
// Whisper wants 16 kHz. The context runs at the device's own rate and this resamples from the
// rate it reports. An iPad has been measured reporting 16 kHz while feeding 48 kHz, so the app
// also checks the samples against the clock and sends a corrected ratio here when they disagree.
class PcmCapture extends AudioWorkletProcessor {
  constructor() {
    super();
    this.ratio = sampleRate / 16000;
    this.t = 0;
    this.buf = new Int16Array(16000);
    this.n = 0;
    this.port.onmessage = (e) => {
      if (!(e.data && e.data.ratio > 0)) return;
      // what was gathered at the old ratio goes first, then the ack, so the app knows exactly
      // which samples came before the change
      if (this.n) this.port.postMessage(this.buf.slice(0, this.n));
      this.buf = new Int16Array(16000);
      this.n = 0;
      this.ratio = e.data.ratio;
      this.port.postMessage({ ack: this.ratio });
    };
  }

  process(inputs) {
    const x = inputs[0] && inputs[0][0];
    if (!x) return true;
    while (this.t < x.length) {
      // average the input samples this output sample covers (a box filter), so a 48 kHz
      // microphone does not alias into the band Whisper listens to
      const a = Math.floor(this.t);
      const b = Math.min(x.length, Math.max(a + 1, Math.floor(this.t + this.ratio)));
      let s = 0;
      for (let i = a; i < b; i++) s += x[i];
      const v = s / (b - a);
      this.buf[this.n++] = Math.max(-1, Math.min(1, v)) * 32767;
      if (this.n === this.buf.length) {
        this.port.postMessage(this.buf, [this.buf.buffer]);
        this.buf = new Int16Array(16000);
        this.n = 0;
      }
      this.t += this.ratio;
    }
    this.t -= x.length;
    return true;
  }
}

registerProcessor('pcm-capture', PcmCapture);

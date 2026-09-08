// AudioWorklet: regroups the mic stream into 512-sample chunks (Silero's
// window at 16 kHz) and posts them to the main thread, which forwards to the
// VAD worker. Nothing else happens here.

const CHUNK = 512;

class VADProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.buf = new Float32Array(CHUNK);
    this.ptr = 0;
  }

  process(inputs) {
    const input = inputs[0]?.[0];
    if (!input) return true;
    let i = 0;
    while (i < input.length) {
      const n = Math.min(CHUNK - this.ptr, input.length - i);
      this.buf.set(input.subarray(i, i + n), this.ptr);
      this.ptr += n;
      i += n;
      if (this.ptr === CHUNK) {
        const out = this.buf.slice();
        this.port.postMessage(out, [out.buffer]);
        this.ptr = 0;
      }
    }
    return true;
  }
}

registerProcessor("vad-processor", VADProcessor);

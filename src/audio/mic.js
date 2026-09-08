// Microphone capture at 16 kHz mono. Chunks of 512 samples go to `onChunk`;
// an AnalyserNode gives the input level for the listening glow.

export const INPUT_SAMPLE_RATE = 16000;

export class Mic {
  constructor(onChunk) {
    this.onChunk = onChunk;
    this.ctx = null;
    this.stream = null;
    this.analyser = null;
    this._buf = null;
    this.running = false;
  }

  async start() {
    if (this.running) return;
    this.stream = await navigator.mediaDevices.getUserMedia({
      audio: {
        channelCount: 1,
        echoCancellation: true,
        noiseSuppression: true,
        autoGainControl: true,
        sampleRate: INPUT_SAMPLE_RATE,
      },
      video: false,
    });
    this.ctx = new AudioContext({ sampleRate: INPUT_SAMPLE_RATE });
    await this.ctx.audioWorklet.addModule(new URL("./vad-processor.js", import.meta.url));
    const src = this.ctx.createMediaStreamSource(this.stream);
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 256;
    this._buf = new Uint8Array(this.analyser.frequencyBinCount);
    src.connect(this.analyser);
    const node = new AudioWorkletNode(this.ctx, "vad-processor", {
      numberOfInputs: 1,
      numberOfOutputs: 0,
      channelCount: 1,
      channelCountMode: "explicit",
      channelInterpretation: "discrete",
    });
    node.port.onmessage = ({ data }) => this.onChunk(data);
    src.connect(node);
    this.node = node;
    this.src = src;
    await this.ctx.resume();
    this.running = true;
  }

  /** 0..1-ish RMS of the input right now. */
  level() {
    if (!this.analyser) return 0;
    this.analyser.getByteTimeDomainData(this._buf);
    let sum = 0;
    for (let i = 0; i < this._buf.length; i++) {
      const v = this._buf[i] / 128 - 1;
      sum += v * v;
    }
    return Math.sqrt(sum / this._buf.length);
  }

  async stop() {
    this.running = false;
    try {
      this.src?.disconnect();
      this.node?.disconnect();
      this.stream?.getTracks().forEach((t) => t.stop());
      await this.ctx?.close();
    } catch {
      /* ignore */
    }
    this.ctx = this.stream = this.analyser = this.node = this.src = null;
  }
}

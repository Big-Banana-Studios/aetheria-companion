// Output: a worklet-backed queue at the TTS sample rate, with an AnalyserNode
// on the way out so the sprite's mouth can follow the actual sound.

export class Player {
  /**
   * @param {{sampleRate?: number, onChunkStart?: Function, onChunkEnd?: Function, onDrained?: Function}} o
   */
  constructor({ sampleRate = 24000, onChunkStart, onChunkEnd, onDrained } = {}) {
    this.sampleRate = sampleRate;
    this.onChunkStart = onChunkStart;
    this.onChunkEnd = onChunkEnd;
    this.onDrained = onDrained;
    this.ctx = null;
    this.node = null;
    this.analyser = null;
    this._buf = null;
    this.playing = false;
    this.queued = 0;
  }

  async init() {
    if (this.ctx) return;
    this.ctx = new AudioContext({ sampleRate: this.sampleRate, latencyHint: "interactive" });
    await this.ctx.audioWorklet.addModule(new URL("./play-worklet.js", import.meta.url));
    this.node = new AudioWorkletNode(this.ctx, "queue-player", { numberOfInputs: 0, numberOfOutputs: 1, outputChannelCount: [1] });
    this.analyser = this.ctx.createAnalyser();
    this.analyser.fftSize = 512;
    this.analyser.smoothingTimeConstant = 0.2;
    this._buf = new Uint8Array(this.analyser.fftSize);
    this.node.connect(this.analyser);
    this.analyser.connect(this.ctx.destination);
    this.node.port.onmessage = ({ data }) => {
      switch (data.type) {
        case "chunk_start":
          this.playing = true;
          this.onChunkStart?.(data.id, data.seq);
          break;
        case "chunk_end":
          this.queued = Math.max(0, this.queued - 1);
          this.onChunkEnd?.(data.id, data.seq);
          break;
        case "drained":
          this.playing = false;
          this.onDrained?.();
          break;
        case "stopped":
          this.playing = false;
          this.queued = 0;
          break;
      }
    };
  }

  /** Must be called from a user gesture at least once on mobile. */
  async unlock() {
    await this.init();
    if (this.ctx.state !== "running") await this.ctx.resume();
  }

  /**
   * @param {number} id turn id
   * @param {number} seq order within the turn
   * @param {Float32Array} data samples at this.sampleRate
   */
  enqueue(id, seq, data) {
    if (!this.node) return;
    this.queued++;
    this.node.port.postMessage({ id, seq, data }, [data.buffer]);
  }

  stop() {
    this.node?.port.postMessage("stop");
    this.playing = false;
    this.queued = 0;
  }

  /** RMS of what is coming out of the speaker right now, 0..1. */
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
}

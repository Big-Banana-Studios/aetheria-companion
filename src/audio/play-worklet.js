// AudioWorklet: a queue of Float32 chunks played back to back. Tells the main
// thread when each chunk starts (for sentence nods / latency marks) and when
// the queue drains after having played something.

class QueueProcessor extends AudioWorkletProcessor {
  constructor() {
    super();
    this.queue = []; // {id, seq, data}
    this.offset = 0;
    this.hadData = false;
    this.port.onmessage = ({ data }) => {
      if (data === "stop") {
        this.queue = [];
        this.offset = 0;
        this.hadData = false;
        this.port.postMessage({ type: "stopped" });
      } else if (data && data.data instanceof Float32Array) {
        this.queue.push(data);
        this.hadData = true;
      }
    };
  }

  process(inputs, outputs) {
    const out = outputs[0]?.[0];
    if (!out) return true;
    let i = 0;
    while (i < out.length) {
      const head = this.queue[0];
      if (!head) {
        out.fill(0, i);
        break;
      }
      if (this.offset === 0) this.port.postMessage({ type: "chunk_start", id: head.id, seq: head.seq });
      const n = Math.min(head.data.length - this.offset, out.length - i);
      out.set(head.data.subarray(this.offset, this.offset + n), i);
      this.offset += n;
      i += n;
      if (this.offset >= head.data.length) {
        this.queue.shift();
        this.offset = 0;
        this.port.postMessage({ type: "chunk_end", id: head.id, seq: head.seq });
        if (this.queue.length === 0 && this.hadData) {
          this.hadData = false;
          this.port.postMessage({ type: "drained" });
        }
      }
    }
    return true;
  }
}

registerProcessor("queue-player", QueueProcessor);

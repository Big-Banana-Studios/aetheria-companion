// Drives src/workers/vad.worker.js in Node with a real speech clip and checks
// that it reports one utterance of roughly the right length, that push-to-talk
// works, and that barge-in gating needs a sustained onset.
import { env } from "@huggingface/transformers";

// Node has no AudioContext; jfk.wav is 16 kHz mono 16-bit PCM, so decode it by hand.
async function readWav16k(url) {
  const buf = await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  let off = 12, fmt = null, data = null;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    const len = dv.getUint32(off + 4, true);
    if (id === "fmt ") fmt = { channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === "data") data = new Int16Array(buf, off + 8, len / 2);
    off += 8 + len + (len % 2);
  }
  if (!fmt || !data || fmt.bits !== 16) throw new Error("expected 16-bit wav: " + JSON.stringify(fmt));
  const frames = data.length / fmt.channels;
  const mono = new Float32Array(frames);
  for (let i = 0; i < frames; i++) {
    let v = 0;
    for (let c = 0; c < fmt.channels; c++) v += data[i * fmt.channels + c];
    mono[i] = v / fmt.channels / 32768;
  }
  if (fmt.rate === 16000) return mono;
  const ratio = fmt.rate / 16000;
  const out = new Float32Array(Math.floor(frames / ratio));
  for (let i = 0; i < out.length; i++) {
    const x = i * ratio, j = Math.floor(x), f = x - j;
    out[i] = mono[j] * (1 - f) + (mono[Math.min(j + 1, frames - 1)] || 0) * f;
  }
  return out;
}
env.cacheDir = process.env.HF_CACHE || "C:/Users/jobo1/AppData/Local/Temp/claude/c--Users-jobo1-Desktop-MIRA/3b8b2643-2474-4842-8e31-172398364c9c/scratchpad/hf-cache";
const out = [];
globalThis.self = { postMessage: (m) => out.push(m), onmessage: null };
await import("../src/workers/vad.worker.js");
const send = (m) => self.onmessage({ data: m });
const wait = (ms) => new Promise((r) => setTimeout(r, ms));

send({ type: "load" });
const t0 = Date.now();
while (!out.find((m) => m.type === "ready")) {
  const err = out.find((m) => m.type === "error");
  if (err) { console.error("VAD load error:", err.message); process.exit(1); }
  if (Date.now() - t0 > 120000) { console.error("VAD load timed out"); process.exit(1); }
  await wait(50);
}
console.log("VAD ready");

const speech = await readWav16k("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav");
console.log("clip seconds:", (speech.length / 16000).toFixed(2));
const silence = new Float32Array(16000 * 1.5); // 1.5 s

async function feed(buf) {
  for (let i = 0; i + 512 <= buf.length; i += 512) {
    await send({ type: "audio", buffer: buf.slice(i, i + 512) });
  }
}
function events(from) {
  return out.slice(from).filter((m) => m.type !== "prob" && m.type !== "progress").map((m) => m.type + (m.seconds ? ` ${m.seconds.toFixed(2)}s` : ""));
}

// 1. hands-free: silence, speech, silence
let mark = out.length;
await feed(silence); await feed(speech); await feed(silence);
console.log("hands-free:", events(mark));

// 2. barge-in gating: while "playing", a single loud chunk must not open; the clip must
mark = out.length;
send({ type: "config", config: { playing: true } });
await feed(silence);
await feed(speech.slice(0, 512)); // one chunk of speech only
await feed(silence);
const opened = events(mark).includes("speech_start");
console.log("barge-in on one chunk opened:", opened, "(want false)");
mark = out.length;
await feed(speech); await feed(silence);
console.log("barge-in on full clip:", events(mark));
send({ type: "config", config: { playing: false } });

// 3. push to talk
mark = out.length;
send({ type: "config", config: { mode: "ptt" } });
await feed(speech.slice(0, 16000)); // ignored: not held
send({ type: "ptt_down" });
await feed(speech.slice(0, 16000 * 2));
send({ type: "ptt_up" });
console.log("ptt:", events(mark));
process.exit(0);

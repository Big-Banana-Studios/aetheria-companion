// TTS worker: Kokoro-82M (default) or KittenTTS nano (fallback), one pinned
// voice. Sentences arrive in order and are synthesized in order; a cancel
// throws away everything queued and anything still in flight.
//
// in : {type:'load', engine, device, dtype, voice, speed}
//      {type:'say', id, seq, text} {type:'cancel'} {type:'set_voice', voice} {type:'set_speed', speed}
// out: {type:'progress', ...} {type:'ready', engine, device, dtype, voices}
//      {type:'audio', id, seq, text, audio, sampleRate, ms} {type:'error', message}

import "./ort-paths.js";
import { KokoroTTS } from "kokoro-js";
import { Tensor, RawAudio } from "@huggingface/transformers";

const KOKORO_ID = "onnx-community/Kokoro-82M-v1.0-ONNX";
const KITTEN_ID = "onnx-community/kitten-tts-nano-0.1-ONNX";
const KITTEN_VOICES = {
  "expr-voice-2-f": { name: "Kitten 2 (f)", language: "en-us", gender: "Female" },
  "expr-voice-2-m": { name: "Kitten 2 (m)", language: "en-us", gender: "Male" },
  "expr-voice-3-f": { name: "Kitten 3 (f)", language: "en-us", gender: "Female" },
  "expr-voice-3-m": { name: "Kitten 3 (m)", language: "en-us", gender: "Male" },
  "expr-voice-4-f": { name: "Kitten 4 (f)", language: "en-us", gender: "Female" },
  "expr-voice-4-m": { name: "Kitten 4 (m)", language: "en-us", gender: "Male" },
  "expr-voice-5-f": { name: "Kitten 5 (f)", language: "en-us", gender: "Female" },
  "expr-voice-5-m": { name: "Kitten 5 (m)", language: "en-us", gender: "Male" },
};

/**
 * KittenTTS nano through the Kokoro wrapper: same StyleTTS2 graph, same
 * espeak phonemes, but each voice file is a single style vector rather than
 * Kokoro's per-length table. Experimental - lower quality, near-instant.
 */
class KittenTTS extends KokoroTTS {
  static async from_pretrained(model_id, opts) {
    const base = await KokoroTTS.from_pretrained(model_id, opts);
    return new KittenTTS(base.model, base.tokenizer);
  }
  get voices() {
    return KITTEN_VOICES;
  }
  _validate_voice(voice) {
    if (!KITTEN_VOICES[voice]) throw new Error(`Unknown Kitten voice ${voice}`);
    return "a";
  }
  async generate_from_ids(input_ids, { voice = "expr-voice-2-f", speed = 1 } = {}) {
    const data = await kittenVoice(voice);
    const dim = data.length;
    const inputs = {
      input_ids,
      style: new Tensor("float32", data, [1, dim]),
      speed: new Tensor("float32", [speed], [1]),
    };
    const { waveform } = await this.model(inputs);
    return new RawAudio(waveform.data, 24000);
  }
}

const kittenCache = new Map();
async function kittenVoice(id) {
  if (kittenCache.has(id)) return kittenCache.get(id);
  const url = `https://huggingface.co/${KITTEN_ID}/resolve/main/voices/${id}.bin`;
  let cache = null;
  try {
    cache = await caches.open("companion-voices");
    const hit = await cache.match(url);
    if (hit) {
      const f = new Float32Array(await hit.arrayBuffer());
      kittenCache.set(id, f);
      return f;
    }
  } catch {
    /* no cache api */
  }
  const res = await fetch(url);
  const buf = await res.arrayBuffer();
  if (cache) cache.put(url, new Response(buf.slice(0))).catch(() => {});
  const f = new Float32Array(buf);
  kittenCache.set(id, f);
  return f;
}

let tts = null;
let engine = "kokoro";
let voice = "af_heart";
let speed = 1;
let generation = 0;
const queue = [];
let pumping = false;

const post = (m, t) => self.postMessage(m, t);

async function load({ engine: eng = "kokoro", device = "webgpu", dtype = null, voice: v, speed: s }) {
  engine = eng;
  if (v) voice = v;
  if (s) speed = s;
  const progress_callback = (p) => post({ type: "progress", model: engine, ...p });
  const tryLoad = async (dev, dt) => {
    if (engine === "kitten") {
      tts = await KittenTTS.from_pretrained(KITTEN_ID, { dtype: "q8", device: dev, progress_callback });
      return { device: dev, dtype: "q8" };
    }
    tts = await KokoroTTS.from_pretrained(KOKORO_ID, { dtype: dt, device: dev, progress_callback });
    return { device: dev, dtype: dt };
  };
  // Kokoro on WebGPU needs fp32; on WASM q8 is the sensible size.
  const plan = device === "webgpu" ? [["webgpu", dtype || "fp32"], ["wasm", "q8"]] : [["wasm", dtype || "q8"]];
  let used = null;
  let lastErr = null;
  for (const [dev, dt] of plan) {
    try {
      used = await tryLoad(dev, dt);
      break;
    } catch (e) {
      lastErr = e;
      post({ type: "info", message: `TTS on ${dev}/${dt} failed (${e.message}); trying next` });
    }
  }
  if (!used) {
    post({ type: "error", message: `TTS failed to load: ${lastErr?.message}` });
    return;
  }
  if (!tts.voices[voice]) voice = Object.keys(tts.voices)[0];
  try {
    await tts.generate("Ready.", { voice, speed }); // compile shaders / warm caches
  } catch (e) {
    post({ type: "info", message: `TTS warm-up: ${e.message}` });
  }
  post({ type: "ready", engine, ...used, voices: tts.voices, voice });
}

async function pump() {
  if (pumping) return;
  pumping = true;
  while (queue.length) {
    const job = queue.shift();
    const g = generation;
    const t0 = performance.now();
    try {
      const audio = await tts.generate(job.text, { voice, speed });
      if (g !== generation) continue; // cancelled while synthesizing
      const samples = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
      post(
        { type: "audio", id: job.id, seq: job.seq, text: job.text, audio: samples, sampleRate: audio.sampling_rate, ms: Math.round(performance.now() - t0) },
        [samples.buffer],
      );
    } catch (e) {
      if (g === generation) post({ type: "error", id: job.id, seq: job.seq, message: `TTS: ${e.message}` });
    }
  }
  pumping = false;
}

self.onmessage = async ({ data }) => {
  switch (data.type) {
    case "load":
      await load(data);
      break;
    case "say":
      if (!tts) return;
      queue.push({ id: data.id, seq: data.seq, text: data.text });
      pump();
      break;
    case "cancel":
      generation++;
      queue.length = 0;
      break;
    case "set_voice":
      if (tts?.voices[data.voice]) voice = data.voice;
      break;
    case "set_speed":
      speed = Math.max(0.5, Math.min(2, Number(data.speed) || 1));
      break;
  }
};

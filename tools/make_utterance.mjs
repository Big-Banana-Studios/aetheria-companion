// Synthesize a test utterance for tools/pc_test.mjs with Kokoro, in Node, so
// the test says something a person would say to her rather than a speech.
//
//   node tools/make_utterance.mjs                     # the default line
//   node tools/make_utterance.mjs "Any line you like." am_adam
//
// Writes .test/utterance-16k.wav (16 kHz mono), which the test picks up.
import { KokoroTTS } from "kokoro-js";
import { env } from "@huggingface/transformers";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(fileURLToPath(import.meta.url), "..", "..");
env.cacheDir = process.env.HF_CACHE || join(root, ".test", "hf-cache");
const text = process.argv[2] || "So I just made myself a fresh cup of coffee and I'm stepping out on the porch for a smoke break. It's been a long day, honestly.";
const voice = process.argv[3] || "am_adam";

const tts = await KokoroTTS.from_pretrained("onnx-community/Kokoro-82M-v1.0-ONNX", { dtype: "q8", device: "cpu" });
const audio = await tts.generate(text, { voice });
const src = audio.audio instanceof Float32Array ? audio.audio : new Float32Array(audio.audio);
const ratio = audio.sampling_rate / 16000;
const out = new Float32Array(Math.floor(src.length / ratio));
for (let i = 0; i < out.length; i++) {
  const x = i * ratio;
  const j = Math.floor(x);
  const f = x - j;
  out[i] = src[j] * (1 - f) + (src[Math.min(j + 1, src.length - 1)] || 0) * f;
}
const n = out.length;
const buf = Buffer.alloc(44 + n * 2);
buf.write("RIFF", 0);
buf.writeUInt32LE(36 + n * 2, 4);
buf.write("WAVE", 8);
buf.write("fmt ", 12);
buf.writeUInt32LE(16, 16);
buf.writeUInt16LE(1, 20);
buf.writeUInt16LE(1, 22);
buf.writeUInt32LE(16000, 24);
buf.writeUInt32LE(32000, 28);
buf.writeUInt16LE(2, 32);
buf.writeUInt16LE(16, 34);
buf.write("data", 36);
buf.writeUInt32LE(n * 2, 40);
for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(out[i] * 32767))), 44 + i * 2);
mkdirSync(join(root, ".test"), { recursive: true });
const path = join(root, ".test", "utterance-16k.wav");
writeFileSync(path, buf);
console.log(`wrote ${path}: ${(n / 16000).toFixed(1)} s, "${text}" (${voice})`);

// The PC pipeline test: the whole thing, in your installed Chrome, on your GPU.
//
//   node tools/pc_test.mjs            # full test (downloads ~3.7 GB into .chrome-test-profile the first time)
//   node tools/pc_test.mjs --brain=text
//   node tools/pc_test.mjs --keep     # leave Chrome and the dev server running afterwards
//
// What it does:
//   1. builds a 16 kHz test utterance (a public-domain speech clip) padded with
//      silence, and hands it to Chrome as a FAKE MICROPHONE that loops it;
//   2. starts the Vite dev server;
//   3. opens the app in Chrome (a dedicated profile, so the models stay cached),
//      clicks "Download and start", and reports download progress;
//   4. once she is on the stage, injects the utterance straight into the
//      pipeline (deterministic), and waits for her reply;
//   5. then waits for the looping fake mic to trigger a natural VAD turn;
//   6. prints the transcript, the latency overlay, console errors, and saves
//      shots/pc-test-*.png.
import { spawn } from "node:child_process";
import { existsSync, mkdirSync, writeFileSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { launchChrome, killTree, sleep, waitHttp } from "./cdp.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const brain = args.get("brain") || "gemma";
const keep = args.has("keep");
const devices = args.get("devices"); // e.g. embed_tokens:wasm
const preview = args.has("preview"); // serve the production build (dist/) instead of the dev server
const sampling = args.get("sampling"); // "0" or "1": override the sampling setting for this run
const PORT = 5173;
const DEBUG = 9334;
const profile = join(root, ".chrome-test-profile");
const testDir = join(root, ".test");
mkdirSync(profile, { recursive: true });
mkdirSync(testDir, { recursive: true });
mkdirSync(join(root, "shots"), { recursive: true });

const log = (...a) => console.log(new Date().toISOString().slice(11, 19), ...a);

// ---------------------------------------------------------------- test audio

async function readWav16k(url) {
  const buf = url.startsWith("file:") ? new Uint8Array(readFileSync(fileURLToPath(url))).buffer : await (await fetch(url)).arrayBuffer();
  const dv = new DataView(buf);
  let off = 12;
  let fmt = null;
  let data = null;
  while (off + 8 <= buf.byteLength) {
    const id = String.fromCharCode(dv.getUint8(off), dv.getUint8(off + 1), dv.getUint8(off + 2), dv.getUint8(off + 3));
    const len = dv.getUint32(off + 4, true);
    if (id === "fmt ") fmt = { channels: dv.getUint16(off + 10, true), rate: dv.getUint32(off + 12, true), bits: dv.getUint16(off + 22, true) };
    if (id === "data") data = new Int16Array(buf, off + 8, len / 2);
    off += 8 + len + (len % 2);
  }
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
    const x = i * ratio;
    const j = Math.floor(x);
    const f = x - j;
    out[i] = mono[j] * (1 - f) + (mono[Math.min(j + 1, frames - 1)] || 0) * f;
  }
  return out;
}

function writeWav16k(path, samples) {
  const n = samples.length;
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
  for (let i = 0; i < n; i++) buf.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(samples[i] * 32767))), 44 + i * 2);
  writeFileSync(path, buf);
}

async function prepareAudio() {
  const clipPath = join(testDir, "utterance-16k.wav");
  const micPath = join(testDir, "fake-mic.wav");
  let speech;
  if (existsSync(clipPath)) {
    // tools/make_utterance.mjs wrote a conversational line; use it
    speech = await readWav16k(`file:///${clipPath.replace(/\\/g, "/")}`).catch(() => null);
    if (speech) log(`using .test/utterance-16k.wav (${(speech.length / 16000).toFixed(1)} s)`);
  }
  if (!speech) {
    log("fetching the test clip…");
    speech = await readWav16k("https://huggingface.co/datasets/Xenova/transformers.js-docs/resolve/main/jfk.wav");
    writeWav16k(clipPath, speech);
  }
  // the fake mic loops its file: speech, then 45 s of quiet, so a natural VAD
  // turn happens about once a minute once she is listening
  const pad = new Float32Array(16000 * 45);
  const looped = new Float32Array(16000 + speech.length + pad.length);
  looped.set(speech, 16000);
  writeWav16k(micPath, looped);
  return { speech, micPath };
}

// ---------------------------------------------------------------- run

const win = process.platform === "win32";
let server = null;
let chrome = null;
let cdp = null;
let ok = false;

try {
  const { speech, micPath } = await prepareAudio();
  log(`test utterance ${(speech.length / 16000).toFixed(1)} s; fake mic file ${micPath}`);

  server = spawn(win ? "npx.cmd" : "npx", ["vite", ...(preview ? ["preview"] : []), "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore", shell: win });
  await waitHttp(`http://localhost:${PORT}/`, 300);
  log(`${preview ? "preview (dist/)" : "dev"} server up on http://localhost:${PORT}/`);

  ({ proc: chrome, cdp } = await launchChrome({
    headless: false,
    port: DEBUG,
    args: [
      `--user-data-dir=${profile}`,
      "--use-fake-ui-for-media-stream",
      "--use-fake-device-for-media-stream",
      `--use-file-for-fake-audio-capture=${micPath}`,
      "--autoplay-policy=no-user-gesture-required",
      "--force_high_performance_gpu", // laptops with two GPUs: WebGPU on the discrete one
      "--window-size=520,1040",
    ],
    url: `http://localhost:${PORT}/?debug${devices ? `&devices=${devices}` : ""}${sampling != null ? `&sampling=${sampling}` : ""}`,
  }));
  log("chrome up; page loaded");
  await sleep(1500);

  const gateMsg = async () => cdp.eval(`document.getElementById('gate-msg')?.textContent || ''`);
  log("gate:", await gateMsg());
  const gpuOk = await cdp.eval(`!!(window.__gpu && window.__gpu.ok)`);
  const f16 = await cdp.eval(`!!(window.__gpu && window.__gpu.f16)`);
  const info = await cdp.eval(`(async () => { const a = await navigator.gpu?.requestAdapter(); const i = a?.info || {}; return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' / '); })()`).catch(() => "");
  log(`webgpu ok=${gpuOk} shader-f16=${f16} adapter=${info || "?"}`);
  if (!gpuOk && brain !== "lab") throw new Error("no WebGPU adapter in Chrome: " + (await gateMsg()));

  await cdp.eval(`document.querySelector('input[name=brain][value="${brain}"]').click()`);
  const tClick = Date.now();
  await cdp.eval(`document.getElementById('btn-start').click()`);
  log(`clicked start (brain=${brain}${devices ? `, devices=${devices}` : ""}); downloading / loading…`);

  // progress until the stage shows
  const t0 = Date.now();
  let lastLine = "";
  for (;;) {
    const stageUp = await cdp.eval(`!document.getElementById('stage').hidden`);
    const total = await cdp.eval(`document.getElementById('dl-total')?.textContent || ''`);
    const msg = await gateMsg();
    const line = `${msg} | ${total}`;
    if (line !== lastLine) {
      log(line.slice(0, 160));
      lastLine = line;
    }
    for (const c of cdp.drain()) if (/error|exception/i.test(c)) log("  console:", c.slice(0, 200));
    if (stageUp) break;
    if (/failed|could not|error/i.test(msg) && !/warming|falling back/i.test(msg)) throw new Error(`gate: ${msg}`);
    if (Date.now() - t0 > 40 * 60 * 1000) throw new Error("timed out waiting for the models");
    await sleep(4000);
  }
  log(`stage up after ${((Date.now() - t0) / 1000).toFixed(0)} s`);
  await sleep(2500);
  await cdp.screenshot(join(root, "shots", "pc-test-1-ready.png"));

  // The fake mic has been looping its 57 s file since the click (1 s quiet,
  // 11 s speech, 45 s quiet). Inject only when at least 30 s of quiet remain,
  // so she is not talked over by the loop while she answers.
  const LOOP = 57;
  const phase = () => ((Date.now() - tClick) / 1000) % LOOP;
  while (!(phase() > 13 && phase() < 25)) await sleep(500);

  // deterministic turn: inject the utterance straight into the pipeline
  const b64 = Buffer.from(new Int16Array(Array.from(speech, (v) => Math.max(-32768, Math.min(32767, Math.round(v * 32767))))).buffer).toString("base64");
  await cdp.eval(`(() => {
    const bin = atob(${JSON.stringify(b64)});
    const u8 = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) u8[i] = bin.charCodeAt(i);
    const i16 = new Int16Array(u8.buffer);
    const f32 = Float32Array.from(i16, (v) => v / 32768);
    window.__companion._turn({ audio: f32, seconds: f32.length / 16000 });
    return true;
  })()`);
  log("injected the utterance; waiting for her reply…");
  const reply = await waitForTurn(cdp, 180000);
  log("reply:", JSON.stringify(reply.her));
  log("transcript of user (Moonshine):", JSON.stringify(reply.user));
  log("timings:", reply.debug.replace(/\n/g, " · "));
  await cdp.screenshot(join(root, "shots", "pc-test-2-reply.png"));

  // a text-only turn, to see decode speed without the audio encoder
  while (!(phase() > 13 && phase() < 30)) await sleep(500);
  await cdp.eval(`window.__companion._turn({ text: "Tell me one thing about the rain tonight, in two sentences." })`);
  log("text-only turn; waiting…");
  const textTurn = await waitForTurn(cdp, 120000);
  log("text turn reply:", JSON.stringify(textTurn.her));
  log("timings:", textTurn.debug.replace(/\n/g, " · "));

  // natural turn: the fake mic loops the clip about once a minute
  log("waiting for the fake mic to trigger a natural VAD turn (up to 2 min)…");
  const before = await cdp.eval(`document.querySelectorAll('#lines .line.user').length`);
  const t1 = Date.now();
  let natural = null;
  while (Date.now() - t1 < 150000) {
    const n = await cdp.eval(`document.querySelectorAll('#lines .line.user').length`);
    if (n > before) {
      natural = await waitForTurn(cdp, 180000);
      break;
    }
    await sleep(2000);
  }
  if (natural) {
    log("natural turn reply:", JSON.stringify(natural.her));
    log("timings:", natural.debug.replace(/\n/g, " · "));
  } else log("no natural VAD turn arrived in time (the fake mic may not have looped yet)");
  await cdp.screenshot(join(root, "shots", "pc-test-3-natural.png"));

  // speaking up on her own: both paths, called directly (the real trigger is
  // 45-90 s of quiet, which the looping fake mic never leaves her)
  while (!(phase() > 13 && phase() < 30)) await sleep(500);
  await cdp.eval(`window.__companion._turn({ say: "I have started recognising people by the way they hold their hands.", mood: "thoughtful", silent: true })`);
  log("her own thought, in her voice…");
  const thought = await waitForTurn(cdp, 60000);
  log("thought line:", JSON.stringify(thought.her), thought.state);
  while (!(phase() > 13 && phase() < 30)) await sleep(500);
  await cdp.eval(`window.__companion._initiate()`);
  log("a check-in, hers or the model's…");
  const checkin = await waitForTurn(cdp, 120000);
  log("check-in line:", JSON.stringify(checkin.her), checkin.state);
  log("timings:", checkin.debug.replace(/\n/g, " · "));
  for (const c of cdp.drain()) if (/error|exception|warn/i.test(c)) log("  console:", c.slice(0, 200));
  ok = !!reply.her;
  log(ok ? "PIPELINE OK" : "PIPELINE INCOMPLETE");
} catch (e) {
  log("FAILED:", e.message);
  try {
    if (cdp) {
      await cdp.screenshot(join(root, "shots", "pc-test-failed.png"));
      for (const c of cdp.drain()) log("  console:", c.slice(0, 300));
    }
  } catch {
    /* ignore */
  }
  process.exitCode = 1;
} finally {
  if (keep) {
    log(`left running: http://localhost:${PORT}/  (chrome profile ${profile})`);
    cdp?.close();
    if (chrome) chrome.unref?.();
    if (server) server.unref?.();
  } else {
    cdp?.close();
    killTree(chrome);
    killTree(server);
  }
}

async function waitForTurn(cdp, timeoutMs) {
  const t0 = Date.now();
  let lastHer = "";
  for (;;) {
    const state = await cdp.eval(`document.getElementById('state-chip')?.textContent || ''`);
    const her = await cdp.eval(`(() => { const l = [...document.querySelectorAll('#lines .line.her')]; return l.length ? l[l.length - 1].textContent : ''; })()`);
    const user = await cdp.eval(`(() => { const l = [...document.querySelectorAll('#lines .line.user')]; return l.length ? l[l.length - 1].textContent : ''; })()`);
    const debug = await cdp.eval(`document.getElementById('debug')?.textContent || ''`);
    const toast = await cdp.eval(`(() => { const t = document.getElementById('toast'); return t && !t.hidden ? t.textContent : ''; })()`);
    if (her !== lastHer) {
      log(`  [${state}] ${her.slice(0, 120)}`);
      lastHer = her;
    }
    if (toast) log("  toast:", toast);
    for (const c of cdp.drain()) if (/error|exception/i.test(c)) log("  console:", c.slice(0, 200));
    if (her && state === "idle") return { her, user, debug, state };
    if (state === "error") return { her, user, debug, state };
    if (Date.now() - t0 > timeoutMs) return { her, user, debug, state: `timeout(${state})` };
    await sleep(1000);
  }
}

// The PC pipeline test: the whole thing, in your installed Chrome, on your GPU.
//
//   node tools/pc_test.mjs            # full test (downloads ~3.7 GB into .chrome-test-profile the first time)
//   node tools/pc_test.mjs --brain=text
//   node tools/pc_test.mjs --brain=lab --fakelab     # the lab brain against tools/fake_lab.mjs (npm run test:lab)
//   node tools/pc_test.mjs --brain=local --fakelab   # the same over the "server on this device" brain
//   node tools/pc_test.mjs --keep     # leave Chrome and the dev server running afterwards
//
// With --fakelab the fake endpoint is started here, the chosen brain's
// settings are pointed at it before the page boots, the gate's own probe
// must report OK (that is what picks the model), and after her first reply
// the request the fake lab received is checked: the thinking switch,
// Qwen's /no_think, the key, the model, max_tokens, the persona and its
// framing; and her line on screen must carry no reasoning and no tags.
// A dev server already up on the port is reused (npm run pc leaves one).
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
import { start as startFakeLab } from "./fake_lab.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const args = new Map(process.argv.slice(2).map((a) => a.replace(/^--/, "").split("=")).map(([k, v]) => [k, v ?? true]));
const brain = args.get("brain") || "gemma";
const remote = brain === "lab" || brain === "local";
const keep = args.has("keep");
const devices = args.get("devices"); // e.g. embed_tokens:wasm
const preview = args.has("preview"); // serve the production build (dist/) instead of the dev server
const sampling = args.get("sampling"); // "0" or "1": override the sampling setting for this run
const gpucrash = args.has("gpucrash") && !remote; // kill Chrome's GPU process mid-session and check she recovers
const fakelab = args.has("fakelab"); // point the lab/local brain at tools/fake_lab.mjs, started here
const PORT = Number(args.get("port")) || 5173;
const LAB = Number(args.get("labport")) || 4321;
const DEBUG = 9334;
const FAKE_MODEL = "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL"; // the first, and best-scoring, of the fake lab's list
let failures = 0;
const check = (name, pass, detail = "") => {
  if (pass) log("  ok  ", name);
  else {
    failures++;
    log("  FAIL", name, detail);
  }
};
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
let lab = null;
let ok = false;

try {
  const { speech, micPath } = await prepareAudio();
  log(`test utterance ${(speech.length / 16000).toFixed(1)} s; fake mic file ${micPath}`);

  if (fakelab) {
    lab = await startFakeLab(LAB, "127.0.0.1");
    log(`fake lab on http://127.0.0.1:${LAB}/v1`);
  }
  let up = false;
  try {
    await waitHttp(`http://localhost:${PORT}/`, 2, 100);
    up = true;
    log(`reusing the server already on http://localhost:${PORT}/`);
  } catch {
    /* start one */
  }
  if (!up) {
    server = spawn(win ? "npx.cmd" : "npx", ["vite", ...(preview ? ["preview"] : []), "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore", shell: win });
    await waitHttp(`http://localhost:${PORT}/`, 300);
    log(`${preview ? "preview (dist/)" : "dev"} server up on http://localhost:${PORT}/`);
  }

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
  if (fakelab) {
    // the chosen network brain points at the fake lab, with no model set, so
    // the gate's probe has to pick one; then boot again with those settings
    await cdp.eval(`(() => {
      const s = JSON.parse(localStorage.getItem("companion.settings") || "{}");
      s.brain = ${JSON.stringify(brain)};
      s[${JSON.stringify(brain)}] = { url: "http://127.0.0.1:${LAB}/v1", model: "", apiKey: "k" };
      s.regime = "topic"; // the district follows the conversation's depth tag (a pinned one from an earlier run would not move)
      localStorage.setItem("companion.settings", JSON.stringify(s));
      return "ok";
    })()`);
    await cdp.navigate(`http://localhost:${PORT}/?debug`);
    await sleep(1500);
    log("settings point at the fake lab; page reloaded");
  }

  const gateMsg = async () => cdp.eval(`document.getElementById('gate-msg')?.textContent || ''`);
  log("gate:", await gateMsg());
  const gpuOk = await cdp.eval(`!!(window.__gpu && window.__gpu.ok)`);
  const f16 = await cdp.eval(`!!(window.__gpu && window.__gpu.f16)`);
  const info = await cdp.eval(`(async () => { const a = await navigator.gpu?.requestAdapter(); const i = a?.info || {}; return [i.vendor, i.architecture, i.device, i.description].filter(Boolean).join(' / '); })()`).catch(() => "");
  log(`webgpu ok=${gpuOk} shader-f16=${f16} adapter=${info || "?"}`);
  if (!gpuOk && !remote) throw new Error("no WebGPU adapter in Chrome: " + (await gateMsg()));

  await cdp.eval(`document.querySelector('input[name=brain][value="${brain}"]').click()`);
  if (remote) {
    // the gate shows the endpoint fields for a network brain and probes it
    check("endpoint fields shown for a network brain", !(await cdp.eval(`document.getElementById('conn-fields').hidden`)));
    let result = "";
    for (let i = 0; i < 40; i++) {
      result = await cdp.eval(`document.getElementById('conn-result').textContent`);
      if (/^(OK|Failed)/.test(result)) break;
      await sleep(250);
    }
    log("gate probe:", result);
    if (fakelab) {
      check("the gate's probe reached the fake lab and listed its models", /^OK · \d+ ms · 3 models/.test(result), result);
      check("a model was picked from the list", result.includes(FAKE_MODEL), result);
      check("the pick was saved", (await cdp.eval(`JSON.parse(localStorage.getItem("companion.settings"))[${JSON.stringify(brain)}].model`)) === FAKE_MODEL);
    }
  }
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
  // 11 s speech, 45 s quiet). For the deterministic turns her listening is
  // paused, so the loop cannot start a turn of its own on top of the
  // injected one (it did: the injected reply then queued behind the loop's),
  // and each injection waits until she is idle. Listening is resumed for
  // the natural-turn part below.
  const idle = async () => (await cdp.eval(`document.getElementById('state-chip')?.textContent || ''`)) === "idle";
  const untilIdle = async () => {
    for (let i = 0; i < 240 && !(await idle()); i++) await sleep(500);
  };
  const pause = (on) => cdp.eval(`window.__companion.setPaused(${on}); "ok"`);
  await pause(true);
  await untilIdle();
  const callsBefore = fakelab ? (await (await fetch(`http://127.0.0.1:${LAB}/last`)).json()).calls : 0;

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
  if (fakelab) {
    // what the fake lab was sent, and what reached the screen
    const last = await (await fetch(`http://127.0.0.1:${LAB}/last`)).json();
    const req = last.last || {};
    const lastUser = [...(req.messages || [])].reverse().find((m) => m.role === "user") || {};
    const lastText = typeof lastUser.content === "string" ? lastUser.content : (lastUser.content || []).find((p) => p.type === "text")?.text || "";
    const system = req.messages?.[0]?.role === "system" ? req.messages[0].content : "";
    check("the injected turn made exactly one request", last.calls === callsBefore + 1, `${callsBefore} before, ${last.calls} after`);
    check("thinking switched off (chat_template_kwargs)", req.chat_template_kwargs?.enable_thinking === false, JSON.stringify(req.chat_template_kwargs));
    check("Qwen's /no_think on the last user turn", /\/no_think\s*$/.test(lastText), lastText.slice(-60));
    check("the model picked from /v1/models was used", req.model === FAKE_MODEL, req.model);
    check("the key was sent", last.auth === "Bearer k", String(last.auth));
    check("full replies on a network brain (max_tokens 500)", req.max_tokens === 500, String(req.max_tokens));
    check("the persona is the system prompt", /courier from Paperless/.test(system));
    check("the workbench's length note and the date/model note", /## Length/.test(system) && /## Notes\nToday is/.test(system) && system.includes(FAKE_MODEL));
    check("Moonshine's transcript reached the model", /coffee|smoke|long day/i.test(lastText), lastText.slice(0, 80));
    check("her line carries no reasoning", !/inline reasoning|Let me think/i.test(reply.her), reply.her);
    check("her line carries no tags", !/^\s*\[/.test(reply.her) && !/\[(curious|mid)\]/.test(reply.her), reply.her);
    check("the plumbing she echoed: switch false, tag yes", /Thinking switch false/.test(reply.her) && /No think tag yes/.test(reply.her), reply.her);
    const chip = await cdp.eval(`document.getElementById('regime-chip').textContent + " / regime setting " + JSON.parse(localStorage.getItem("companion.settings")).regime + " / topicRegime " + window.__companion.topicRegime`);
    check("the depth tag moved her to the Undercity", chip.startsWith("GUT"), chip);
  }

  // a text-only turn through the footer's text box (the ⌨ button swaps it
  // in and pauses the mic), to see decode speed without the audio encoder
  await untilIdle();
  await cdp.eval(`document.getElementById('btn-input').click(); "ok"`);
  check("the text box replaced the talk button", (await cdp.eval(`document.getElementById('text-row').hidden === false && document.getElementById('btn-talk').hidden === true && window.__companion.paused === true`)) === true);
  await cdp.eval(`document.getElementById('text-in').value = "Tell me one thing about the rain tonight, in two sentences."; document.getElementById('text-row').requestSubmit(); "ok"`);
  log("text-only turn (typed); waiting…");
  const textTurn = await waitForTurn(cdp, 120000);
  log("text turn reply:", JSON.stringify(textTurn.her));
  log("timings:", textTurn.debug.replace(/\n/g, " · "));
  check("the typed line is in the transcript", /rain tonight/.test(textTurn.user), textTurn.user);
  check("the box was cleared", (await cdp.eval(`document.getElementById('text-in').value`)) === "");
  await cdp.eval(`document.getElementById('btn-input').click(); "ok"`); // back to voice
  check("back to the talk button", (await cdp.eval(`document.getElementById('text-row').hidden === true && document.getElementById('btn-talk').hidden === false`)) === true);
  await pause(true); // the deterministic part goes on with the mic paused

  // natural turn: the fake mic loops the clip about once a minute
  log("waiting for the fake mic to trigger a natural VAD turn (up to 2 min)…");
  await untilIdle();
  await pause(false);
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
  await pause(true);
  await untilIdle();
  await cdp.eval(`window.__companion._turn({ say: "I have started recognising people by the way they hold their hands.", mood: "thoughtful", silent: true })`);
  log("her own thought, in her voice…");
  const thought = await waitForTurn(cdp, 60000);
  log("thought line:", JSON.stringify(thought.her), thought.state);
  await pause(true);
  await untilIdle();
  await cdp.eval(`window.__companion._initiate()`);
  log("a check-in, hers or the model's…");
  const checkin = await waitForTurn(cdp, 120000);
  log("check-in line:", JSON.stringify(checkin.her), checkin.state);
  log("timings:", checkin.debug.replace(/\n/g, " · "));

  if (gpucrash) {
    // The model worker's next generation fails as a lost GPU device (Chrome
    // ignores chrome://gpucrash opened over the protocol, so this is
    // simulated inside the worker). She should rebuild from the cache and
    // answer anyway, with the "bringing her back" toast on the way.
    log("simulating a lost GPU device in the model worker…");
    await cdp.eval(`window.__companion.simulateGpuLoss()`);
    await pause(true);
    await untilIdle();
    const tCrash = Date.now();
    await cdp.eval(`window.__companion._turn({ text: "Still there? Say something." })`);
    log("turn after the loss; waiting (reload + reply)…");
    const after = await waitForTurn(cdp, 240000);
    log(`after-loss reply (${((Date.now() - tCrash) / 1000).toFixed(0)} s):`, JSON.stringify(after.her), after.state);
    for (const c of cdp.drain()) if (/lost|reload|error|exception/i.test(c)) log("  console:", c.slice(0, 200));
    if (!after.her || after.state !== "idle") throw new Error("no reply after the GPU loss");
    log("recovered from the GPU loss");
  }
  for (const c of cdp.drain()) if (/error|exception|warn/i.test(c)) log("  console:", c.slice(0, 200));
  ok = !!reply.her && failures === 0;
  log(ok ? "PIPELINE OK" : failures ? `PIPELINE OK BUT ${failures} CHECK(S) FAILED` : "PIPELINE INCOMPLETE");
  if (!ok) process.exitCode = 1;
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
    log(`left running: http://localhost:${PORT}/  (chrome profile ${profile})${lab ? `, fake lab on :${LAB}` : ""}`);
    cdp?.close();
    if (chrome) chrome.unref?.();
    if (server) server.unref?.();
    lab?.unref?.();
  } else {
    cdp?.close();
    killTree(chrome);
    killTree(server);
    lab?.close();
  }
}

async function waitForTurn(cdp, timeoutMs) {
  const t0 = Date.now();
  let lastHer = "";
  // a NEW line of hers, not one that was already there
  const herBefore = await cdp.eval(`document.querySelectorAll('#lines .line.her').length`);
  for (;;) {
    const herCount = await cdp.eval(`document.querySelectorAll('#lines .line.her').length`);
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
    const fresh = herCount > herBefore;
    if (fresh && her && state === "idle") return { her, user, debug, state };
    if (state === "error") return { her: fresh ? her : "", user, debug, state };
    if (Date.now() - t0 > timeoutMs) return { her: fresh ? her : "", user, debug, state: `timeout(${state})` };
    await sleep(1000);
  }
}

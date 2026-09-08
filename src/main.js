// Entry point: WebGPU check, the download gate, then the stage.

import { loadSettings, saveSettings, resolveRegime, REGIMES } from "./settings.js";
import { DEFAULT_PERSONA } from "./persona.js";
import { SpriteRenderer } from "./sprite/renderer.js";
import { Companion } from "./companion.js";
import { DebugOverlay } from "./debug.js";

const $ = (id) => document.getElementById(id);
const BASE = import.meta.env.BASE_URL || "/";

const settings = loadSettings();
let renderer = null;
let companion = null;
let debug = null;

// Known sizes, so the total bar is honest before every file has reported in.
const EXPECTED_MB = {
  gemma: 3480, // + Moonshine for the transcript strip
  text: 1620,
  lab: 80,
  tts: 330,
  vad: 2.3,
};

// ------------------------------------------------------------------ boot

async function main() {
  bindGate();
  bindSettings();
  bindStage();
  const q0 = new URLSearchParams(location.search);
  if (q0.has("stage")) {
    // scene / gesture preview: no models, no GPU probe
    await loadSprite();
    stagePreview(q0);
    return;
  }
  const gpu = await checkWebGPU();
  const msg = $("gate-msg");
  if (!gpu.ok) {
    msg.textContent = gpu.reason;
    msg.classList.add("error");
    $("btn-start").disabled = settings.brain !== "lab";
  } else {
    msg.textContent = gpu.f16 ? "WebGPU ready (fp16 shaders available)." : "WebGPU ready. No fp16 shaders: the model will use the larger q4 files.";
  }
  window.__gpu = gpu;
  await loadSprite();
  if (q0.has("debug")) settings.debug = true;
  // experiments, this run only: ?sampling=0|1
  if (q0.has("sampling")) Object.defineProperty(settings, "sampling", { value: q0.get("sampling") !== "0", enumerable: false, writable: true });
  // ?devices=embed_tokens:wasm,decoder_model_merged:webgpu (this run only, never saved)
  delete settings.deviceMap;
  if (q0.get("devices")) {
    Object.defineProperty(settings, "deviceMap", {
      value: Object.fromEntries(q0.get("devices").split(",").map((kv) => kv.split(":"))),
      enumerable: false, // JSON.stringify skips it, so it cannot outlive the URL
    });
  }
}

/**
 * `?stage` shows the street and Mira without loading any model, for working
 * on the scene and the gestures. Options: `regime=GUT|HEART|HEAD`,
 * `state=idle|listening|thinking|speaking|idle_long|asleep|error`,
 * `mood=<tag>` (played as a reaction), `gesture=<name>`, `noenter`,
 * `demo` (cycles through states and moods), `scene=0` (plain ground).
 */
function stagePreview(q) {
  $("gate").hidden = true;
  $("stage").hidden = false;
  if (q.get("regime")) settings.regime = q.get("regime");
  if (q.get("scene") === "0") settings.scene = false;
  if (q.get("storm") === "0") settings.storm = false;
  applyRegime();
  renderer.resize();
  renderer.start();
  const state = q.get("state") || "idle";
  renderer.setState(state);
  $("state-chip").textContent = `${state} · preview`;
  if (!q.has("noenter") && state === "idle") renderer.enter();
  if (state === "listening") setTimeout(() => renderer.listenLong(), (renderer.m.states.listening?.long_after ?? 5) * 1000);
  if (q.get("gesture")) setTimeout(() => renderer.gesture(q.get("gesture")), 900);
  if (q.get("travel")) {
    // the conversation changed depth: she walks off to the other district and back in
    const to = q.get("travel");
    setTimeout(() => renderer.travel(to, REGIMES[to]?.colour || "#ff4f8b").then(() => showRegimeChip({ ...REGIMES[to], source: "preview" })), 1200);
  }
  if (q.has("music")) {
    // the ambience needs a gesture: first tap starts it
    import("./audio/music.js").then(({ Music }) => {
      const start = () => {
        const ctx = new AudioContext();
        const m = new Music(ctx);
        m.setVolume((Number(q.get("music")) || 40) / 100);
        m.setRainVolume((Number(q.get("stormvol")) || 50) / 100);
        m.setRegime(renderer.scene.regime);
        renderer.scene.onStrike = (near) => m.thunder(near);
        m.start();
        setInterval(() => m.setRain(renderer.scene.rain), 250);
        window.__music = m;
        $("state-chip").textContent += " · music";
      };
      addEventListener("pointerdown", start, { once: true });
    });
  }
  if (q.has("voice")) {
    // a fake voice, so the mouth, the aura and the sign can be seen responding
    let ph = 0;
    setInterval(() => {
      ph += 0.21;
      const syl = Math.max(0, Math.sin(ph)) ** 2;
      renderer.setMouth(renderer.state === "speaking" ? 0.02 + syl * 0.16 : 0);
    }, 33);
  }
  if (q.get("mood")) setTimeout(() => renderer.react(q.get("mood")), 900);
  if (q.has("demo")) {
    const moods = Object.keys(renderer.moods);
    const states = ["idle", "listening", "thinking", "speaking", "idle_long", "asleep", "error"];
    let i = 0;
    setInterval(() => {
      const st = states[i % states.length];
      renderer.setState(st);
      $("state-chip").textContent = `${st} · demo`;
      if (st === "speaking") renderer.react(moods[i % moods.length]);
      if (st === "listening") setTimeout(() => renderer.listenLong(), 2500);
      i++;
    }, 4500);
    // a fake voice so the mouth and the sign move
    setInterval(() => renderer.setMouth(renderer.state === "speaking" ? 0.02 + Math.random() * 0.12 : 0), 66);
  }
}

async function checkWebGPU() {
  if (!("gpu" in navigator)) return { ok: false, reason: "This browser has no WebGPU. On Android use Chrome 121 or newer; on desktop use Chrome or Edge." };
  try {
    const adapter = await navigator.gpu.requestAdapter();
    if (!adapter) return { ok: false, reason: "WebGPU is present but no adapter was found. Try chrome://flags → 'Unsafe WebGPU', or another browser." };
    const f16 = adapter.features.has("shader-f16");
    return { ok: true, f16, adapter };
  } catch (e) {
    return { ok: false, reason: `WebGPU error: ${e.message}` };
  }
}

async function loadSprite() {
  const dir = `${BASE}assets/sprites/courier/`;
  const manifest = await (await fetch(`${dir}courier.json`)).json();
  const atlas = await loadImage(`${dir}${manifest.meta.atlas}`);
  let mouth = null;
  if (manifest.mouth?.source && manifest.mouth.source !== "procedural") {
    mouth = await loadImage(`${dir}${manifest.mouth.source}`).catch(() => null);
  }
  renderer = new SpriteRenderer($("sprite"), manifest, atlas, { mouth });
  applyRegime();
}

function loadImage(src) {
  return new Promise((resolve, reject) => {
    const img = new Image();
    img.onload = () => resolve(img);
    img.onerror = () => reject(new Error(`could not load ${src}`));
    img.src = src;
  });
}

function applyRegime() {
  const r = resolveRegime(settings, companion?.topicRegime);
  renderer?.setAuraColour(r.colour);
  renderer?.setRegime(r.name);
  renderer?.setSceneEnabled(settings.scene !== false);
  renderer?.setStorm(settings.storm !== false);
  showRegimeChip(r);
}

function showRegimeChip(r) {
  const chip = $("regime-chip");
  chip.textContent = r.name;
  chip.style.color = r.colour;
  chip.style.borderColor = r.colour;
  chip.title = `Aura: ${r.name} (${r.source})`;
  document.documentElement.style.setProperty("--accent", r.colour);
}

// ------------------------------------------------------------------ gate

function bindGate() {
  const radios = document.querySelectorAll('input[name="brain"]');
  radios.forEach((r) => {
    r.checked = r.value === settings.brain;
    r.addEventListener("change", () => {
      settings.brain = r.value;
      $("lab-fields").hidden = settings.brain !== "lab";
      $("btn-start").disabled = !(window.__gpu?.ok || settings.brain === "lab");
      saveSettings(settings);
    });
  });
  $("lab-fields").hidden = settings.brain !== "lab";
  $("lab-url").value = settings.lab.url;
  $("lab-model").value = settings.lab.model;
  $("lab-key").value = settings.lab.apiKey;
  for (const [id, key] of [["lab-url", "url"], ["lab-model", "model"], ["lab-key", "apiKey"]]) {
    $(id).addEventListener("input", (e) => {
      settings.lab[key] = e.target.value.trim();
      saveSettings(settings);
    });
  }
  $("btn-start").addEventListener("click", start);
}

const files = new Map(); // file -> {loaded, total, model, done}

async function start() {
  const btn = $("btn-start");
  btn.disabled = true;
  btn.textContent = "Loading…";
  $("dl").hidden = false;
  saveSettings(settings);

  companion = new Companion({ settings, renderer });
  window.__companion = companion; // for tools/pc_test.mjs and the console
  debug = new DebugOverlay($("debug"), companion.timings);
  debug.show(!!settings.debug);
  companion.addEventListener("progress", (e) => onProgress(e.detail));
  companion.addEventListener("info", (e) => setGateMsg(e.detail));
  companion.addEventListener("error", (e) => {
    setGateMsg(e.detail, true);
    toast(e.detail, true);
    debug?.set("last error", String(e.detail).slice(0, 160)); // stays in the overlay after the toast is gone
    $("last-error").textContent = `Last error: ${e.detail}`; // and in Settings, in full, for a phone
  });
  wireCompanion();

  // Still inside the tap: open the speaker and the mic now, or Android will
  // keep the audio contexts suspended once the download has eaten the gesture.
  let micError = null;
  try {
    await companion.unlockAudio();
  } catch (e) {
    micError = e;
  }

  try {
    await navigator.storage?.persist?.().catch(() => {});
  } catch {
    /* ignore */
  }

  const gpu = window.__gpu || { ok: false };
  const dtype = gpu.f16 ? "q4f16" : "q4";
  const device = gpu.ok ? "webgpu" : "wasm";
  try {
    await companion.boot({ dtype, device });
  } catch (e) {
    setGateMsg(`Could not start: ${e.message}`, true);
    btn.disabled = false;
    btn.textContent = "Try again";
    return;
  }
  setGateMsg("Ready. Opening the mic…");
  try {
    if (micError) throw micError;
    await companion.begin();
  } catch (e) {
    setGateMsg(`Microphone: ${e.message}`, true);
    btn.disabled = false;
    btn.textContent = "Allow the mic and try again";
    return;
  }
  $("gate").hidden = true;
  $("stage").hidden = false;
  renderer.resize();
  renderer.start();
  fillVoices();
  updateStorageInfo();
}

function setGateMsg(text, error = false) {
  const m = $("gate-msg");
  m.textContent = text;
  m.classList.toggle("error", error);
}

function onProgress(p) {
  if (!p.file) return;
  const key = `${p.model}/${p.file}`;
  const f = files.get(key) || { loaded: 0, total: 0, model: p.model, file: p.file, done: false, li: null };
  if (p.status === "progress") {
    f.loaded = p.loaded || 0;
    f.total = p.total || f.total;
  } else if (p.status === "done") {
    f.done = true;
    if (f.total) f.loaded = f.total;
  } else if (p.status === "initiate") {
    f.total = p.total || f.total;
  }
  files.set(key, f);
  renderProgress();
}

function renderProgress() {
  const list = $("dl-list");
  let loaded = 0;
  let total = 0;
  for (const f of files.values()) {
    loaded += f.loaded;
    total += f.total;
    if (!f.li) {
      f.li = document.createElement("li");
      f.li.innerHTML = `<span></span><span></span>`;
      list.appendChild(f.li);
    }
    f.li.classList.toggle("done", f.done);
    f.li.children[0].textContent = `${f.model}: ${f.file}`;
    f.li.children[1].textContent = f.total ? `${mb(f.loaded)} / ${mb(f.total)} MB` : f.done ? "cached" : "…";
  }
  const expected = (EXPECTED_MB[settings.brain] || 0) + EXPECTED_MB.tts + EXPECTED_MB.vad;
  const denom = Math.max(total / 1048576, expected);
  const pct = denom ? Math.min(100, (loaded / 1048576 / denom) * 100) : 0;
  $("dl-bar").style.width = `${pct.toFixed(1)}%`;
  $("dl-total").textContent = `${mb(loaded)} MB of about ${Math.round(denom)} MB · cached files show as 0 / size and finish instantly`;
}

const mb = (b) => (b / 1048576).toFixed(b > 100 * 1048576 ? 0 : 1);

// ------------------------------------------------------------------ stage

const lines = new Map(); // `${id}:${role}` -> element

function wireCompanion() {
  const chip = $("state-chip");
  const talk = $("btn-talk");
  companion.addEventListener("state", (e) => {
    chip.textContent = e.detail;
    talk.classList.toggle("live", e.detail === "listening");
    if (settings.mode === "vad") talk.querySelector(".talk-label").textContent = companion.paused ? "paused" : e.detail === "listening" ? "hearing you" : "listening";
  });
  companion.addEventListener("line", (e) => addOrUpdateLine(e.detail));
  companion.addEventListener("cleared", () => {
    $("lines").innerHTML = "";
    lines.clear();
  });
  companion.addEventListener("toast", (e) => toast(e.detail));
  companion.addEventListener("snapUsed", () => $("cam-wrap").classList.remove("armed"));
  companion.addEventListener("tick", () => debug?.render());
  companion.addEventListener("mode", () => applyModeUI());
  // the conversation moved her to another district: the chip and the accent follow
  companion.addEventListener("regime", (e) => showRegimeChip({ ...REGIMES[e.detail], source: "the conversation" }));
}

function addOrUpdateLine({ id, role, text, pending, streaming, interrupted, image }) {
  const key = `${id}:${role}`;
  let el = lines.get(key);
  if (!el) {
    el = document.createElement("div");
    el.className = `line ${role}`;
    $("lines").appendChild(el);
    lines.set(key, el);
    if (lines.size > 80) {
      const first = lines.keys().next().value;
      lines.get(first)?.remove();
      lines.delete(first);
    }
  }
  if (role === "her") {
    // said (normal) + generated-but-not-yet-said (faint): the line follows her voice
    el.textContent = "";
    const said = document.createElement("span");
    said.textContent = (text || "") + (interrupted ? " —" : "");
    el.appendChild(said);
    if (pending && typeof pending === "string" && pending.trim()) {
      const rest = document.createElement("span");
      rest.className = "unsaid";
      rest.textContent = (text ? " " : "") + pending;
      el.appendChild(rest);
    }
    if (!text && !pending) el.textContent = "…";
  } else {
    el.classList.toggle("pending", !!pending);
    el.textContent = (image ? "📷 " : "") + (text || "") + (interrupted ? " —" : "");
  }
  $("transcript").scrollTop = $("transcript").scrollHeight;
}

function toast(text, error = false) {
  const t = $("toast");
  t.textContent = text;
  t.classList.toggle("error", error);
  t.hidden = false;
  clearTimeout(t._timer);
  t._timer = setTimeout(() => (t.hidden = true), error ? 6000 : 2500);
}

function applyModeUI() {
  const talk = $("btn-talk");
  const ptt = settings.mode === "ptt";
  talk.classList.toggle("ptt", ptt);
  talk.querySelector(".talk-label").textContent = ptt ? "hold to talk" : companion?.paused ? "paused" : "listening";
  talk.title = ptt ? "Hold to talk" : "Tap to pause or resume listening";
}

function bindStage() {
  const talk = $("btn-talk");
  let held = false;
  const down = (e) => {
    e.preventDefault();
    if (!companion) return;
    if (settings.mode === "ptt") {
      held = true;
      talk.classList.add("held");
      talk.setPointerCapture?.(e.pointerId);
      companion.pttDown();
    }
  };
  const up = (e) => {
    if (!companion) return;
    if (settings.mode === "ptt") {
      if (!held) return;
      held = false;
      talk.classList.remove("held");
      companion.pttUp();
    } else {
      // hands-free: a tap pauses/resumes listening; a tap while she talks stops her
      if (companion.state === "speaking" || companion.state === "thinking") companion.interrupt();
      else companion.setPaused(!companion.paused);
      applyModeUI();
    }
  };
  talk.addEventListener("pointerdown", down);
  talk.addEventListener("pointerup", up);
  talk.addEventListener("pointercancel", up);
  talk.addEventListener("contextmenu", (e) => e.preventDefault());

  $("btn-cam").addEventListener("click", async () => {
    try {
      const on = await companion.toggleCamera($("cam"));
      $("cam-wrap").hidden = !on;
      $("btn-cam").classList.toggle("on", on);
      if (on && settings.brain !== "gemma") toast("only the full on-device brain can see; the still will be ignored");
    } catch (e) {
      toast(`camera: ${e.message}`, true);
    }
  });
  $("btn-snap").addEventListener("click", () => {
    if (companion.snap()) $("cam-wrap").classList.add("armed");
  });
  $("cam").addEventListener("click", () => $("btn-snap").click());
  $("btn-debug").addEventListener("click", () => {
    settings.debug = !settings.debug;
    saveSettings(settings);
    debug?.show(settings.debug);
  });
  $("btn-settings").addEventListener("click", () => openSettings());
}

// ------------------------------------------------------------------ settings

function fillVoices() {
  const sel = $("set-voice");
  sel.innerHTML = "";
  const voices = companion?.voices || {};
  for (const [id, v] of Object.entries(voices)) {
    const o = document.createElement("option");
    o.value = id;
    o.textContent = `${v.name} · ${v.gender || ""} ${v.language || ""}${v.overallGrade ? ` · ${v.overallGrade}` : ""}`;
    sel.appendChild(o);
  }
  sel.value = settings.voice;
}

function openSettings() {
  $("set-speed").value = settings.speed;
  $("set-speed-val").textContent = Number(settings.speed).toFixed(2);
  $("set-mode").value = settings.mode;
  $("set-vad").value = settings.sensitivity;
  $("set-vad-val").textContent = settings.sensitivity;
  $("set-barge").checked = !!settings.bargeIn;
  $("set-smoke").checked = !!settings.smokeBreaks;
  $("set-initiate").checked = settings.initiate !== false;
  $("set-music").checked = settings.music !== false;
  $("set-music-vol").value = settings.musicVolume ?? 40;
  $("set-music-vol-val").textContent = settings.musicVolume ?? 40;
  $("set-storm").checked = settings.storm !== false;
  $("set-storm-vol").value = settings.stormVolume ?? 50;
  $("set-storm-vol-val").textContent = settings.stormVolume ?? 50;
  $("set-scene").checked = settings.scene !== false;
  $("set-sampling").checked = !!settings.sampling;
  $("set-length").value = settings.replyLength || "auto";
  $("set-ttsdevice").value = settings.ttsDevice === "cpu" ? "cpu" : "auto";
  $("set-regime").value = settings.regime;
  $("set-stt").value = settings.sttModel || "tiny";
  $("set-persona").value = settings.persona || DEFAULT_PERSONA;
  $("set-lab-url").value = settings.lab.url;
  $("set-lab-model").value = settings.lab.model;
  $("set-lab-key").value = settings.lab.apiKey;
  updateStorageInfo();
  $("settings").showModal();
}

function bindSettings() {
  $("set-voice").addEventListener("change", (e) => {
    companion?.setVoice(e.target.value);
    saveSettings(settings);
  });
  $("set-speed").addEventListener("input", (e) => {
    const v = Number(e.target.value);
    $("set-speed-val").textContent = v.toFixed(2);
    companion?.setSpeed(v);
    settings.speed = v;
    saveSettings(settings);
  });
  $("set-mode").addEventListener("change", (e) => {
    settings.mode = e.target.value;
    saveSettings(settings);
    companion?.applyListeningSettings();
    applyModeUI();
  });
  $("set-vad").addEventListener("input", (e) => {
    settings.sensitivity = Number(e.target.value);
    $("set-vad-val").textContent = settings.sensitivity;
    saveSettings(settings);
    companion?.applyListeningSettings();
  });
  $("set-barge").addEventListener("change", (e) => {
    settings.bargeIn = e.target.checked;
    saveSettings(settings);
  });
  $("set-smoke").addEventListener("change", (e) => {
    settings.smokeBreaks = e.target.checked;
    saveSettings(settings);
  });
  $("set-initiate").addEventListener("change", (e) => {
    settings.initiate = e.target.checked;
    saveSettings(settings);
  });
  $("set-music").addEventListener("change", (e) => {
    settings.music = e.target.checked;
    saveSettings(settings);
    companion?.applyAmbience();
  });
  $("set-music-vol").addEventListener("input", (e) => {
    settings.musicVolume = Number(e.target.value);
    $("set-music-vol-val").textContent = settings.musicVolume;
    saveSettings(settings);
    companion?.applyAmbience();
  });
  $("set-storm").addEventListener("change", (e) => {
    settings.storm = e.target.checked;
    saveSettings(settings);
    if (companion) companion.applyAmbience();
    else renderer?.setStorm(settings.storm);
  });
  $("set-storm-vol").addEventListener("input", (e) => {
    settings.stormVolume = Number(e.target.value);
    $("set-storm-vol-val").textContent = settings.stormVolume;
    saveSettings(settings);
    companion?.applyAmbience();
  });
  $("set-scene").addEventListener("change", (e) => {
    settings.scene = e.target.checked;
    saveSettings(settings);
    renderer?.setSceneEnabled(settings.scene);
  });
  $("set-sampling").addEventListener("change", (e) => {
    settings.sampling = e.target.checked;
    settings.samplingChosen = true;
    saveSettings(settings);
  });
  $("set-length").addEventListener("change", (e) => {
    settings.replyLength = e.target.value;
    saveSettings(settings);
  });
  $("set-ttsdevice").addEventListener("change", (e) => {
    settings.ttsDevice = e.target.value;
    saveSettings(settings);
  });
  $("set-regime").addEventListener("change", (e) => {
    settings.regime = e.target.value;
    saveSettings(settings);
    if (!companion || !REGIMES[settings.regime]) applyRegime(); // "topic"/"reader": nothing to walk to yet
  });
  // Done: if a district was picked, she walks there and takes its register with her
  $("settings").addEventListener("close", () => {
    if (!companion) return;
    if (REGIMES[settings.regime]) companion.moveTo(settings.regime);
    else applyRegime();
  });
  $("set-stt").addEventListener("change", (e) => {
    settings.sttModel = e.target.value;
    saveSettings(settings);
  });
  let personaTimer = 0;
  $("set-persona").addEventListener("input", (e) => {
    const v = e.target.value;
    settings.persona = v.trim() === DEFAULT_PERSONA.trim() ? null : v;
    saveSettings(settings);
    clearTimeout(personaTimer);
    personaTimer = setTimeout(() => companion?.resetContext(), 1200);
  });
  $("btn-persona-reset").addEventListener("click", () => {
    settings.persona = null;
    $("set-persona").value = DEFAULT_PERSONA;
    saveSettings(settings);
    companion?.resetContext();
  });
  $("btn-clear").addEventListener("click", () => {
    companion?.clearMemory();
    toast("memory cleared");
  });
  for (const [id, key] of [["set-lab-url", "url"], ["set-lab-model", "model"], ["set-lab-key", "apiKey"]]) {
    $(id).addEventListener("input", (e) => {
      settings.lab[key] = e.target.value.trim();
      saveSettings(settings);
    });
  }
  $("btn-purge").addEventListener("click", async () => {
    if (!confirm("Delete all downloaded model files from this browser? They will download again next time.")) return;
    for (const name of ["transformers-cache", "kokoro-voices", "companion-voices"]) {
      try {
        await caches.delete(name);
      } catch {
        /* ignore */
      }
    }
    updateStorageInfo();
    toast("models deleted; reload to download again");
  });
}

async function updateStorageInfo() {
  const el = $("storage-info");
  try {
    const est = await navigator.storage.estimate();
    const persisted = await navigator.storage.persisted?.();
    el.textContent = `Using ${(est.usage / 1048576 / 1024).toFixed(2)} GB of ${(est.quota / 1048576 / 1024).toFixed(1)} GB available. ${persisted ? "Storage is persistent." : "Storage is not marked persistent; the browser may evict it under pressure."}`;
  } catch {
    el.textContent = "Storage estimate unavailable.";
  }
}

main().catch((e) => {
  console.error(e);
  setGateMsg(`Failed to start: ${e.message}`, true);
});

// Anything that slips past the handlers above shows up on screen, so a
// phone with no console still tells you what went wrong.
window.addEventListener("error", (e) => {
  const msg = `${e.message} (${(e.filename || "").split("/").pop()}:${e.lineno})`;
  setGateMsg(msg, true);
  if (!$("stage").hidden) toast(msg, true);
  $("last-error").textContent = `Last error: ${msg}`;
});
window.addEventListener("unhandledrejection", (e) => {
  const msg = `unhandled: ${e.reason?.message || e.reason}`;
  setGateMsg(msg, true);
  if (!$("stage").hidden) toast(msg, true);
  $("last-error").textContent = `Last error: ${msg}`;
});

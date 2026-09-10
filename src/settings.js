// Settings, persisted to localStorage as one JSON blob. The endpoints, the
// models and the keys never leave this browser. The lab block is shared
// with the Aetheria Workbench when both apps are served from the same
// origin (GitHub Pages project sites share big-banana-studios.github.io):
// the workbench writes its endpoint into `companion.settings.lab`, and
// `adoptFromWorkbench` reads its settings the other way.

const KEY = "companion.settings";
const WORKBENCH_KEY = "workbench.settings";

export const REGIMES = {
  GUT: {
    name: "GUT",
    colour: "#ff8a3c",
    district: "Undercity",
    register: "the Undercity: the personal and the practical, blunt, more grit and cheek, feelings named plainly and not fussed over",
  },
  HEART: {
    name: "HEART",
    colour: "#ff4f8b",
    district: "Street Market",
    register: "the Street Market: small talk, quick and dry, people close by, easy to laugh at the way things are",
  },
  HEAD: {
    name: "HEAD",
    colour: "#37e6f0",
    district: "The Stack",
    register: "the Stack: the big questions, clear and unhurried, exact words, no consolation, no filler",
  },
};

// The Reader's 27 frequencies, by regime (Aetheria/constants.ts LO_SHU_FREQ_POSITIONS).
const BANDS = [
  ["GUT", 174, 963],
  ["HEART", 1206, 3150],
  ["HEAD", 3504, 6336],
];

/** A phone: shorter replies by default, and the option to keep the GPU for the model. */
export const IS_MOBILE =
  typeof navigator !== "undefined" && (navigator.userAgentData?.mobile === true || /Android|iPhone|iPad|Mobile/i.test(navigator.userAgent));

// The four brains. `gemma` and `text` run in this browser on WebGPU; `lab`
// and `local` are OpenAI-compatible servers reached over HTTP: the lab is
// the box at home (the Olares, LiteLLM), local is a server on this same
// device (the Workbench app's in-app llama.cpp runtime on the phone,
// llama-server / LM Studio / Ollama on a PC). Moonshine transcribes here
// for both; Kokoro still speaks here.
export const REMOTE_BRAINS = ["lab", "local"];
export const isRemote = (brain) => REMOTE_BRAINS.includes(brain);

export const DEFAULTS = {
  replyLength: "auto", // auto (short on phones with an on-device brain, full otherwise) | short | full
  ttsDevice: "auto", // auto (GPU) | gpu | cpu: where the voice runs
  music: true, // the synth bed
  musicVolume: 40, // 0..100
  storm: true, // the storm as a whole (the street stays)
  stormRain: true, // its parts, each its own switch
  stormGusts: true,
  stormLightning: true,
  stormSound: true, // the rain's hiss
  stormThunder: true,
  stormVolume: 50, // 0..100: the storm's sound
  musicTempo: 76, // BPM of the bed
  brain: "gemma", // gemma | text | lab | local
  voice: "af_nicole", // the one that hits for her
  speed: 1.0,
  mode: "vad", // vad | ptt
  input: "voice", // voice (the talk button) | text (a box in the footer; the mic pauses while you type)
  sensitivity: 50, // 0..100
  bargeIn: true,
  smokeBreaks: true,
  initiate: true, // she speaks up when it has been quiet a while
  scene: true, // the rainy street behind her
  sampling: true, // varied replies; greedy decoding made her generic
  regime: "topic", // topic (the conversation's depth) | reader | GUT | HEART | HEAD
  sttModel: "tiny", // tiny | base: Moonshine for the transcript strip
  persona: null, // null = the preset's text (personas/*.md); a string = edited by hand
  personaPreset: "auto", // auto (short on a phone's on-device brain, long on a network brain, standard otherwise) | short | standard | long
  // url: the OpenAI-compatible base, e.g. https://<id>.laresprime.olares.com/v1
  // (a bare host or the full /v1/chat/completions URL, as older builds and the
  // workbench write it, are accepted too; see endpoints()).
  lab: { url: "", model: "", apiKey: "" },
  // a server on this device: the Workbench app's runtime listens on 8080
  local: { url: "http://127.0.0.1:8080/v1", model: "", apiKey: "" },
  thinkSwitch: "auto", // auto | template (chat_template_kwargs only) | tag (/no_think only) | none: how the lab is told not to think
  debug: false,
  ttsEngine: "kokoro", // kokoro | kitten
};

export function loadSettings() {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return structuredClone(DEFAULTS);
    const s = JSON.parse(raw);
    if (s.regime === "auto") s.regime = "topic"; // older builds
    delete s.deviceMap; // an experiment flag that once leaked into storage
    if (s.sampling === false && !s.samplingChosen) s.sampling = true; // the old default, never a choice
    return {
      ...structuredClone(DEFAULTS),
      ...s,
      lab: { ...DEFAULTS.lab, ...(s.lab || {}) },
      local: { ...DEFAULTS.local, ...(s.local || {}) },
    };
  } catch {
    return structuredClone(DEFAULTS);
  }
}

export function saveSettings(s) {
  try {
    localStorage.setItem(KEY, JSON.stringify(s));
  } catch (e) {
    console.warn("settings not saved", e);
  }
}

/**
 * "short" or "full": how much she says per turn. The short default exists
 * to spare a phone's GPU a long generate-and-synthesize burst; on a remote
 * brain the phone only speaks, so she gets the full reply there.
 */
export function replyLength(settings) {
  if (settings.replyLength === "short" || settings.replyLength === "full") return settings.replyLength;
  if (isRemote(settings.brain)) return "full";
  return IS_MOBILE ? "short" : "full";
}

/** The {url, model, apiKey} block a remote brain uses. */
export function connection(settings, brain = settings.brain) {
  return brain === "local" ? settings.local : settings.lab;
}

/**
 * The endpoint as the user typed it, normalised to the URLs the app needs.
 * Accepts a bare host, a base ending in /v1, or the full /v1/chat/completions
 * form. From the workbench's settings.js.
 */
export function endpoints(url) {
  let u = (url || "").trim();
  if (!u) return null;
  if (!/^https?:\/\//i.test(u)) u = "http://" + u;
  u = u.replace(/\/+$/, "");
  u = u.replace(/\/chat\/completions$/i, "").replace(/\/models$/i, "");
  if (!/\/v\d+$/i.test(u)) u += "/v1";
  let host = "";
  try {
    host = new URL(u).hostname;
  } catch {
    return null;
  }
  return { base: u, chat: `${u}/chat/completions`, models: `${u}/models`, http: /^http:\/\//i.test(u), host, loopback: isLoopbackHost(host), lan: isLanHost(host) };
}

export function isLoopbackHost(host) {
  return /^(localhost|127(\.\d{1,3}){3}|\[::1\]|::1|0\.0\.0\.0)$/i.test(host || "");
}

/** A private (RFC 1918 / link-local / .local / .home) address: the LAN. */
export function isLanHost(host) {
  const h = String(host || "").toLowerCase();
  if (isLoopbackHost(h)) return false;
  if (/^10(\.\d{1,3}){3}$/.test(h) || /^192\.168(\.\d{1,3}){2}$/.test(h) || /^172\.(1[6-9]|2\d|3[01])(\.\d{1,3}){2}$/.test(h) || /^169\.254(\.\d{1,3}){2}$/.test(h)) return true;
  return /\.(local|lan|home|internal)$/.test(h) || !h.includes(".");
}

/**
 * Mixed content: an https page cannot call a plain http box on the LAN.
 * Loopback is exempt (the browser treats it as secure), and Chrome lets a
 * private address through when the fetch names it (see lab.js).
 */
export function mixedContent(url) {
  const e = endpoints(url);
  if (!e) return false;
  return typeof location !== "undefined" && location.protocol === "https:" && e.http && !e.loopback;
}

/**
 * The workbench's settings, when it is served from this origin: its lab
 * endpoint if this app has none, and its Mira desk prompt if the user
 * edited it there and left the persona here at the default. Returns what
 * was taken, so the caller can say so.
 */
export function adoptFromWorkbench(s) {
  const took = [];
  try {
    const w = JSON.parse(localStorage.getItem(WORKBENCH_KEY) || "null");
    if (!w) return took;
    if (!s.lab?.url && w.lab?.url) {
      s.lab = { url: w.lab.url, model: w.lab.model || "", apiKey: w.lab.apiKey || "" };
      took.push("lab");
    }
    const prompt = w.desks?.mira?.prompt;
    if (!s.persona && prompt && prompt.trim()) {
      s.persona = prompt;
      s.personaFrom = "workbench";
      took.push("persona");
    }
  } catch {
    /* the workbench is not here */
  }
  return took;
}

/** Silero thresholds from the 0..100 sensitivity slider. */
export function vadThresholds(sensitivity) {
  const s = Math.max(0, Math.min(100, Number(sensitivity) || 50)) / 100;
  const start = 0.55 - 0.35 * s; // 0.55 (deaf-ish) .. 0.20 (keen)
  return {
    start,
    exit: Math.max(0.05, start / 3),
    barge: Math.min(0.92, start + 0.4), // stricter while she is talking
  };
}

/**
 * Which regime she stands in (aura colour, the street). An explicit choice
 * wins; "topic" follows the conversation's depth (`topicRegime`, HEART until
 * the first reply); "reader" follows the Reader's selected frequency if its
 * checkpoint is in this origin's localStorage; otherwise HEART - connection
 * is what a companion is for.
 */
export function resolveRegime(settings, topicRegime = null) {
  if (settings.regime && REGIMES[settings.regime]) {
    return { ...REGIMES[settings.regime], source: "settings" };
  }
  if (settings.regime === "topic" || !settings.regime) {
    const r = REGIMES[topicRegime] || REGIMES.HEART;
    return { ...r, source: topicRegime ? "the conversation" : "default" };
  }
  try {
    const raw = localStorage.getItem("aetheria_checkpoint");
    if (raw) {
      const cp = JSON.parse(raw);
      const f = Number(cp?.selectedFrequency);
      if (Number.isFinite(f)) {
        for (const [name, lo, hi] of BANDS) {
          if (f >= lo - 1 && f <= hi + 1) return { ...REGIMES[name], source: `reader ${f} Hz` };
        }
      }
    }
  } catch {
    /* not our concern */
  }
  return { ...REGIMES.HEART, source: "default" };
}

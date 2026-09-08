// Settings, persisted to localStorage as one JSON blob.

const KEY = "companion.settings";

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

export const DEFAULTS = {
  replyLength: "auto", // auto (short on phones, full on PCs) | short | full
  ttsDevice: "auto", // auto (GPU) | gpu | cpu: where the voice runs
  music: true, // the synth bed
  musicVolume: 40, // 0..100
  storm: true, // the rain, the gusts, the lightning, and their sound (the street stays)
  brain: "gemma", // gemma | text | lab
  voice: "af_nicole", // the one that hits for her
  speed: 1.0,
  mode: "vad", // vad | ptt
  sensitivity: 50, // 0..100
  bargeIn: true,
  smokeBreaks: true,
  initiate: true, // she speaks up when it has been quiet a while
  scene: true, // the rainy street behind her
  sampling: true, // varied replies; greedy decoding made her generic
  regime: "topic", // topic (the conversation's depth) | reader | GUT | HEART | HEAD
  sttModel: "tiny", // tiny | base: Moonshine for the transcript strip
  persona: null, // null = default persona.md
  lab: { url: "", model: "", apiKey: "" },
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
    return { ...structuredClone(DEFAULTS), ...s, lab: { ...DEFAULTS.lab, ...(s.lab || {}) } };
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

/** "short" or "full": how much she says per turn. */
export function replyLength(settings) {
  if (settings.replyLength === "short" || settings.replyLength === "full") return settings.replyLength;
  return IS_MOBILE ? "short" : "full";
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

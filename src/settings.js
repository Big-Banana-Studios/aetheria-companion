// Settings, persisted to localStorage as one JSON blob.

const KEY = "companion.settings";

export const REGIMES = {
  GUT: { name: "GUT", colour: "#ff8a3c", district: "Undercity" },
  HEART: { name: "HEART", colour: "#ff4f8b", district: "Street Market" },
  HEAD: { name: "HEAD", colour: "#37e6f0", district: "The Stack" },
};

// The Reader's 27 frequencies, by regime (Aetheria/constants.ts LO_SHU_FREQ_POSITIONS).
const BANDS = [
  ["GUT", 174, 963],
  ["HEART", 1206, 3150],
  ["HEAD", 3504, 6336],
];

export const DEFAULTS = {
  brain: "gemma", // gemma | text | lab
  voice: "af_heart",
  speed: 1.0,
  mode: "vad", // vad | ptt
  sensitivity: 50, // 0..100
  bargeIn: true,
  smokeBreaks: true,
  scene: true, // the rainy street behind her
  sampling: false,
  regime: "auto", // auto | GUT | HEART | HEAD
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
 * Which regime colours the aura. Explicit choice wins; otherwise follow the
 * Reader's selected frequency if its checkpoint is in this origin's
 * localStorage; otherwise HEART - connection is what a companion is for.
 */
export function resolveRegime(settings) {
  if (settings.regime && settings.regime !== "auto" && REGIMES[settings.regime]) {
    return { ...REGIMES[settings.regime], source: "settings" };
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

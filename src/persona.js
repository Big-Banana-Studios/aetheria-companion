// Mira's persona in three lengths, one file each in personas/: the same
// voice (dark, dry, deadpan; two gears, the flat observation and the
// incredulous run), sized for the brain that reads it. Short fits a phone's
// on-device prompt budget (about 700 tokens with the protocol; the ROG
// Phone's GPU refused a longer one), standard is the text the Workbench's
// Mira desk uses (prompts/mira.md there), long is the full bible for the
// lab's big model. The builder lives in prompt.js so the Node checks can
// import it without Vite.
import { IS_MOBILE, isRemote } from "./settings.js";

const FILES = import.meta.glob("../personas/*.md", { query: "?raw", import: "default", eager: true });
const file = (name) => FILES[Object.keys(FILES).find((k) => k.endsWith(`/${name}.md`))] || "";

export const PERSONAS = {
  short: { name: "Short", about: "about 380 tokens; fits a phone's on-device brain", text: file("mira-short") },
  standard: { name: "Standard", about: "about 630 tokens; the Workbench's Mira desk text", text: file("mira") },
  long: { name: "Long", about: "about 950 tokens; the full bible, for the lab's big model", text: file("mira-long") },
};

export const DEFAULT_PERSONA = PERSONAS.standard.text;

/** Which preset applies: the chosen one, else by brain and device. */
export function personaPreset(settings) {
  const p = settings.personaPreset;
  if (p && PERSONAS[p]) return p;
  if (isRemote(settings.brain)) return "long";
  return IS_MOBILE ? "short" : "standard";
}

/** The persona text in force: one edited by hand, else the preset's. */
export function personaText(settings) {
  return settings.persona || PERSONAS[personaPreset(settings)].text;
}

export { MOODS, DEPTHS, buildSystemPrompt } from "./prompt.js";

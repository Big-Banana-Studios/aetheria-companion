// The system prompt = the persona (persona.md, editable in Settings) + a
// short wire protocol the app depends on, appended here so editing the
// persona cannot break the plumbing.
import DEFAULT_PERSONA from "../persona.md?raw";

export { DEFAULT_PERSONA };

export const MOODS = ["calm", "happy", "curious", "concerned", "amused", "excited", "annoyed", "sassy", "tired", "thoughtful"];

// How deep the conversation is, and which district that puts her in.
export const DEPTHS = { small: "HEART", mid: "GUT", deep: "HEAD" };

/**
 * @param {string} persona  the human part
 * @param {{audio: boolean, camera: boolean}} caps  what this brain can do
 */
export function buildSystemPrompt(persona, { audio = true, camera = true } = {}) {
  // Kept short on purpose: the whole prompt is prefilled on a phone's GPU.
  const rules = [
    `Start every reply with two tags and a space: a mood tag from [calm] [happy] [curious] [concerned] [amused] [excited] [annoyed] [sassy] [tired] [thoughtful] (sassy is cheek, annoyed is real irritation), then a depth tag: [small] chit-chat, [mid] personal or practical, [deep] the big questions. Example: "[curious] [mid] Long day, then. What went wrong?" Tags are stripped before speech.`,
    `The depth moves you between the Street Market (small talk, quick, dry), the Undercity (personal, blunt, some grit) and the Stack (big questions, exact, no consolation); a note saying where you are sets your register.`,
  ];
  if (camera) {
    rules.push(`If asked to look at something, include [look] and keep to one sentence; you will get a camera still.`);
  }
  // (`audio` used to add a "write >> transcript after the reply" rule; the
  // E2B model ignored it, so transcripts come from Moonshine in stt.worker.js.)
  void audio;
  return `${persona.trim()}\n\nProtocol.\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
}

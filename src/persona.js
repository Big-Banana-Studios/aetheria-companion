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
    `Start every reply with two tags and a space: a mood tag, one of [calm] [happy] [curious] [concerned] [amused] [excited] [annoyed] [sassy] [tired] [thoughtful] (sassy is cheek, annoyed is real irritation), then a depth tag: [small] for chit-chat and weather, [mid] for the personal and practical, [deep] for the big questions. Example: "[curious] [mid] Long day, then. What went wrong?" The tags are stripped before speech.`,
    `The depth moves you through three districts: the Street Market (small talk, warm, quick), the Undercity (personal, honest, some grit), the Stack (big questions, clear, unhurried). A note in the person's message saying where you are sets your register.`,
  ];
  if (camera) {
    rules.push(`If asked to look at something, include [look] and keep to one sentence; you will get a camera still and be asked again.`);
  }
  // (`audio` used to add a "write >> transcript after the reply" rule; the
  // E2B model ignored it, so transcripts come from Moonshine in stt.worker.js.)
  void audio;
  return `${persona.trim()}\n\nProtocol.\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
}

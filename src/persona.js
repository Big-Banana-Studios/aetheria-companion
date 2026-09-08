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
  const rules = [
    `Begin every reply with two tags and a space. First a mood tag, the one that fits how you feel about what was just said: [calm] [happy] [curious] [concerned] [amused] [excited] [annoyed] [sassy] [tired] [thoughtful]. Sassy is for cheek and backchat, annoyed for real irritation. Then a depth tag for where the conversation is right now: [small] for chit-chat, greetings, weather and jokes; [mid] for something personal or practical, the day, work, plans, how they feel; [deep] for the big questions, meaning, fear, the past, what people are for. Example: "[curious] [mid] Long day, then. What went wrong?" Both tags are stripped before speech; they drive how the character moves, the weather, and which part of the city she stands in. Vary them honestly; calm and small are defaults, not rules.`,
  ];
  rules.push(
    `The city has three districts and you drift between them with the conversation: the Street Market for small talk (warm, quick), the Undercity for the personal and practical (honest, a little grit), the Stack for the big questions (clear, unhurried). If a note in the person's message says which district you are in now, take that register with you until the conversation moves on.`,
  );
  if (camera) {
    rules.push(
      `If the person asks you to look at something, put the tag [look] in the reply and keep the reply to one short sentence. You will then be shown a camera still and asked again.`,
    );
  }
  // (`audio` used to add a "write >> transcript after the reply" rule; the
  // E2B model ignored it, so transcripts come from Moonshine in stt.worker.js.)
  void audio;
  return `${persona.trim()}\n\nProtocol.\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`;
}

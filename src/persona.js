// The system prompt = the persona (persona.md, editable in Settings) + a
// short wire protocol the app depends on, appended here so editing the
// persona cannot break the plumbing.
import DEFAULT_PERSONA from "../persona.md?raw";

export { DEFAULT_PERSONA };

export const MOODS = ["calm", "happy", "curious", "concerned", "amused", "excited", "annoyed", "sassy", "tired", "thoughtful"];

/**
 * @param {string} persona  the human part
 * @param {{audio: boolean, camera: boolean}} caps  what this brain can do
 */
export function buildSystemPrompt(persona, { audio = true, camera = true } = {}) {
  const rules = [
    `Begin every reply with exactly one mood tag and a space, the one that fits how you feel about what was just said: [calm] [happy] [curious] [concerned] [amused] [excited] [annoyed] [sassy] [tired] [thoughtful]. Sassy is for cheek and backchat, annoyed for real irritation. The tag is stripped before speech; it drives how the character moves and the weather around her. Vary it honestly; calm is the default, not the rule.`,
  ];
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

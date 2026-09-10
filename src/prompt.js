// The system prompt = the persona (personas/*.md, a preset or an edit in Settings) + a
// short wire protocol the app depends on, appended here so editing the
// persona cannot break the plumbing. On a remote brain (the lab, a server
// on this device) it also carries the framing the Aetheria Workbench gives
// her Mira desk: room to talk on a big model, the date, which model is
// answering, and the read-aloud rule. Pure functions only: persona.js adds
// the default text (a Vite import), so this file also runs in Node.

export const MOODS = ["calm", "happy", "curious", "concerned", "amused", "excited", "annoyed", "sassy", "tired", "thoughtful"];

// How deep the conversation is, and which district that puts her in.
export const DEPTHS = { small: "HEART", mid: "GUT", deep: "HEAD" };

/**
 * @param {string} persona  the human part
 * @param {{audio?: boolean, camera?: boolean, remote?: boolean, brain?: string, model?: string, length?: "short"|"full", date?: Date}} o
 *   audio/camera: what this brain can do; remote: the lab or a local server
 *   (text in, text out, framed like the workbench's Mira desk); length: how
 *   much room she has (settings.js replyLength).
 */
export function buildSystemPrompt(persona, { audio = true, camera = true, remote = false, brain = "gemma", model = "", length = "short", date = new Date() } = {}) {
  // Kept short on purpose: on the on-device brain the whole prompt is
  // prefilled on a phone's GPU.
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
  const parts = [`${persona.trim()}\n\nProtocol.\n${rules.map((r, i) => `${i + 1}. ${r}`).join("\n")}`];
  if (remote) {
    // the workbench's Mira desk, word for word where it applies
    parts.push(
      length === "full"
        ? "## Length\nThere is time on this model. When the subject deserves it, take eight to twelve sentences: still plain, still one thought each, still spoken. Short when short is right. Never pad."
        : "## Length\nThree to six sentences, as your persona says. Quips, not speeches.",
    );
    const who = brain === "local" ? `the model running on this device${model ? ` (${model})` : ""}` : `the lab model${model ? ` ${model}` : ""}`;
    parts.push(
      `## Notes\nToday is ${date.toDateString()}. You are answering as ${who}. Their words reach you through a transcriber, so a garbled line is the microphone, not them: say so and ask them to go again. Everything you write is read aloud: no markdown, no lists, no emoji, and nothing in brackets except the two tags at the start.`,
    );
  }
  return parts.join("\n\n");
}

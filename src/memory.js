// Conversation memory: the last N turns, text only, in localStorage.
// No audio is ever stored.

const KEY = "companion.memory";
const MAX_TURNS = 40;

/** @typedef {{role: "user"|"assistant", text: string, t: number, mood?: string, image?: boolean}} Turn */

export class Memory {
  constructor() {
    /** @type {Turn[]} */
    this.turns = [];
    this.load();
  }

  load() {
    try {
      const raw = localStorage.getItem(KEY);
      this.turns = raw ? JSON.parse(raw).filter((t) => t && t.role && typeof t.text === "string") : [];
    } catch {
      this.turns = [];
    }
  }

  save() {
    try {
      if (this.turns.length > MAX_TURNS) this.turns = this.turns.slice(-MAX_TURNS);
      localStorage.setItem(KEY, JSON.stringify(this.turns));
    } catch (e) {
      console.warn("memory not saved", e);
    }
  }

  /** @param {Turn} turn */
  push(turn) {
    this.turns.push({ t: Date.now(), ...turn });
    this.save();
    return this.turns[this.turns.length - 1];
  }

  /** Replace the text of the most recent turn with the given role. */
  amendLast(role, patch) {
    for (let i = this.turns.length - 1; i >= 0; i--) {
      if (this.turns[i].role === role) {
        Object.assign(this.turns[i], patch);
        this.save();
        return this.turns[i];
      }
    }
    return null;
  }

  clear() {
    this.turns = [];
    try {
      localStorage.removeItem(KEY);
    } catch {
      /* ignore */
    }
  }

  /**
   * Chat messages for re-priming a fresh model context (text only). Kept
   * modest: on a phone the whole primer is prefilled on the GPU with the
   * system prompt and the audio, so long turns are clipped.
   */
  asMessages(limit = 8, maxChars = 240) {
    return this.turns
      .slice(-limit)
      .filter((t) => t.text && t.text.trim())
      .map((t) => {
        const text = t.text.length > maxChars ? t.text.slice(0, maxChars).replace(/\s+\S*$/, "") + "…" : t.text;
        return { role: t.role, content: t.role === "user" ? text : `[${t.mood || "calm"}] ${text}` };
      });
  }
}

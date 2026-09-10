// Thinking-mode tokens. Some servers put the reasoning in its own field
// (`reasoning_content`, with llama.cpp's --reasoning-format deepseek); some
// leave `<think>…</think>` inline in the content. This parser takes the
// content stream and splits it, so the rest of the app never sees a think
// tag: reasoning goes to one callback, the visible reply to the other. Mira
// asks the lab not to think at all (she speaks, she does not deliberate),
// but a server that ignores the switch must still never have its thinking
// read aloud. Copied from the workbench's src/think.js.

const OPEN = "<think>";
const CLOSE = "</think>";

export class ThinkParser {
  /**
   * @param {(text: string) => void} onText
   * @param {(text: string) => void} onReasoning
   */
  constructor(onText, onReasoning = () => {}) {
    this.onText = onText;
    this.onReasoning = onReasoning;
    this.buf = "";
    this.inThink = false;
    this.seenAny = false;
  }

  push(chunk) {
    if (!chunk) return;
    this.buf += chunk;
    this._drain(false);
  }

  close() {
    this._drain(true);
    if (this.buf) {
      (this.inThink ? this.onReasoning : this.onText)(this.buf);
      this.buf = "";
    }
  }

  _drain(final) {
    for (;;) {
      if (this.inThink) {
        const i = this.buf.indexOf(CLOSE);
        if (i < 0) {
          // keep a tail that might be the start of the close tag
          const keep = final ? 0 : tailOverlap(this.buf, CLOSE);
          const out = this.buf.slice(0, this.buf.length - keep);
          if (out) this.onReasoning(out);
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        const out = this.buf.slice(0, i);
        if (out) this.onReasoning(out);
        this.buf = this.buf.slice(i + CLOSE.length);
        // a reply that opens with a think block should not start with its newlines
        if (!this.seenAny) this.buf = this.buf.replace(/^\s+/, "");
        this.inThink = false;
      } else {
        const i = this.buf.indexOf(OPEN);
        if (i < 0) {
          const keep = final ? 0 : tailOverlap(this.buf, OPEN);
          const out = this.buf.slice(0, this.buf.length - keep);
          if (out) {
            this.seenAny = true;
            this.onText(out);
          }
          this.buf = this.buf.slice(this.buf.length - keep);
          return;
        }
        const out = this.buf.slice(0, i);
        if (out.trim()) {
          this.seenAny = true;
          this.onText(out);
        }
        this.buf = this.buf.slice(i + OPEN.length);
        this.inThink = true;
      }
    }
  }
}

/** How many trailing chars of `s` could be the beginning of `tag`. */
function tailOverlap(s, tag) {
  const max = Math.min(s.length, tag.length - 1);
  for (let n = max; n > 0; n--) {
    if (tag.startsWith(s.slice(s.length - n))) return n;
  }
  return 0;
}

/** Strip any think block from a finished string (for memory and speech). */
export function stripThink(text) {
  return String(text || "")
    .replace(/<think>[\s\S]*?<\/think>\s*/gi, "")
    .replace(/<think>[\s\S]*$/i, "")
    .trim();
}

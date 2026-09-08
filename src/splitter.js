// A small streaming sentence splitter for the main thread.
//
// Text arrives from the model a few characters at a time. A sentence is
// released as soon as a terminator (. ! ? … or a newline) is followed by
// whitespace or the end of the buffer, unless the sentence is very short (so
// "No." glues to what follows) or the terminator is inside a common
// abbreviation or a decimal number.

const TERMINATORS = ".!?…";
const ABBREV = new Set(["mr", "mrs", "ms", "dr", "st", "vs", "etc", "e.g", "i.e", "no", "jan", "feb", "mar", "apr", "jun", "jul", "aug", "sep", "sept", "oct", "nov", "dec"]);

export class SentenceSplitter {
  /**
   * @param {(sentence: string) => void} onSentence
   * @param {{minChars?: number}} [opts]
   */
  constructor(onSentence, { minChars = 12 } = {}) {
    this.onSentence = onSentence;
    this.minChars = minChars;
    this.buffer = "";
    this.closed = false;
  }

  push(text) {
    if (this.closed || !text) return;
    this.buffer += text;
    this._drain(false);
  }

  /** Release whatever is left, then accept nothing more. */
  close() {
    if (this.closed) return;
    this._drain(true);
    this.closed = true;
  }

  reset() {
    this.buffer = "";
    this.closed = false;
  }

  _drain(final) {
    let start = 0;
    const b = this.buffer;
    for (let i = 0; i < b.length; i++) {
      const c = b[i];
      const isNl = c === "\n";
      if (!isNl && !TERMINATORS.includes(c)) continue;
      // wait to see what follows a terminator (could be more punctuation / a quote)
      if (!isNl) {
        if (i + 1 >= b.length && !final) break;
        const next = b[i + 1];
        if (next != null && !/\s/.test(next) && !/["')\]]/.test(next)) continue; // "3.5", "e.g."
        // swallow trailing quotes/brackets and stacked punctuation
        while (i + 1 < b.length && /["')\]!?.…]/.test(b[i + 1])) i++;
      }
      const candidate = b.slice(start, i + 1).trim();
      if (!candidate) {
        start = i + 1;
        continue;
      }
      if (!isNl && candidate.length < this.minChars && !final) continue;
      const lastWord = candidate.replace(/[.!?…"')\]]+$/, "").split(/\s+/).pop()?.toLowerCase();
      if (!isNl && lastWord && ABBREV.has(lastWord) && !final) continue;
      this.onSentence(candidate);
      start = i + 1;
    }
    this.buffer = b.slice(start);
    if (final && this.buffer.trim()) {
      this.onSentence(this.buffer.trim());
      this.buffer = "";
    }
  }
}

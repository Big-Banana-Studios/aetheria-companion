// Per-turn latency marks and the overlay that shows them.
//
//   vad_end      the user stopped speaking (Silero said so)
//   sent         audio handed to the model worker
//   first_token  first text out of the model
//   first_sent   first complete sentence handed to TTS
//   first_audio  first synthesized chunk back from TTS
//   audible      that chunk actually started playing
//   done         generation finished
//   played       playback finished

export class Timings {
  constructor() {
    this.turns = [];
    this.current = null;
    this.info = {};
  }

  begin(id) {
    this.current = { id, marks: {}, tokens: 0, chars: 0 };
    this.turns.push(this.current);
    if (this.turns.length > 8) this.turns.shift();
    return this.current;
  }

  mark(name, id = null) {
    const t = id == null ? this.current : this.turns.find((x) => x.id === id);
    if (!t || t.marks[name] != null) return;
    t.marks[name] = performance.now();
  }

  count(id, tokens, chars) {
    const t = this.turns.find((x) => x.id === id);
    if (t) {
      t.tokens = tokens;
      t.chars = chars;
    }
  }

  /** ms from vad_end to each mark, for the current turn. */
  summary(t = this.current) {
    if (!t) return {};
    const base = t.marks.vad_end ?? t.marks.sent;
    const out = {};
    for (const k of ["sent", "transcript", "first_token", "first_sent", "first_audio", "audible", "done", "played"]) {
      if (t.marks[k] != null && base != null) out[k] = Math.round(t.marks[k] - base);
    }
    if (t.marks.first_token != null && t.marks.done != null && t.tokens > 1) {
      out.tok_s = +((t.tokens - 1) / ((t.marks.done - t.marks.first_token) / 1000)).toFixed(1);
    }
    return out;
  }
}

export class DebugOverlay {
  constructor(el, timings) {
    this.el = el;
    this.timings = timings;
    this.extra = {};
    this.visible = false;
    this._raf = null;
  }

  show(on) {
    this.visible = on;
    this.el.hidden = !on;
    if (on) this.render();
  }

  set(key, value) {
    this.extra[key] = value;
  }

  render() {
    if (!this.visible) return;
    const s = this.timings.summary();
    const lines = [];
    const info = this.timings.info;
    lines.push(`${info.brain || "-"} ${info.dtype || ""} ${info.device || ""}  tts:${info.tts || "-"}`.trim());
    const cur = this.timings.current;
    if (cur) {
      lines.push(`turn ${cur.id}  tokens ${cur.tokens}`);
      lines.push(
        `vad→sent ${fmt(s.sent)}  →tok ${fmt(s.first_token)}  →sent1 ${fmt(s.first_sent)}`,
      );
      lines.push(`→tts ${fmt(s.first_audio)}  →AUDIBLE ${fmt(s.audible)}  done ${fmt(s.done)}  ${s.tok_s ? s.tok_s + " tok/s" : ""}${s.transcript != null ? `  words ${fmt(s.transcript)}` : ""}`);
    }
    for (const [k, v] of Object.entries(this.extra)) lines.push(`${k}: ${v}`);
    const mem = performance.memory;
    if (mem) lines.push(`js heap ${(mem.usedJSHeapSize / 1048576).toFixed(0)} MB`);
    this.el.textContent = lines.join("\n");
  }
}

function fmt(v) {
  return v == null ? "…" : `${v}ms`;
}

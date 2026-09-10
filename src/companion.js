// The conversation: mic -> VAD -> model -> sentences -> TTS -> speaker, with
// the sprite and the transcript following along. The main thread only does
// audio I/O, the canvas and this orchestration; all model work is in workers.

import { Mic } from "./audio/mic.js";
import { Player } from "./audio/player.js";
import { Music } from "./audio/music.js";
import { SentenceSplitter } from "./splitter.js";
import { Memory } from "./memory.js";
import { Timings } from "./debug.js";
import { buildSystemPrompt, personaText, MOODS, DEPTHS } from "./persona.js";
import { streamChat, explainFetchError, blockedByMixedContent } from "./lab.js";
import { ThinkParser } from "./think.js";
import { vadThresholds, REGIMES, replyLength, isRemote, connection, endpoints } from "./settings.js";
import { pickThought } from "./thoughts.js";

const MOOD_TAG = /^\s*(?:\[([a-z]+)\]\s*)+/i;
const LOOK_TAG = /\[look\]/gi;

export class Companion extends EventTarget {
  /**
   * @param {{settings: object, renderer: import('./sprite/renderer.js').SpriteRenderer}} o
   */
  constructor({ settings, renderer }) {
    super();
    this.settings = settings;
    this.renderer = renderer;
    this.memory = new Memory();
    this.timings = new Timings();
    this.state = "idle";
    this.turnId = 0;
    this.current = null;
    this.ready = { vad: false, tts: false, llm: false };
    this.voices = {};
    this.pendingImage = null;
    this.paused = false;
    this.topicRegime = null; // where the conversation has put her (null = not yet said)
    this.hints = []; // notes for the model with the next turn (a district the user chose, a line she said)
    this.asked = []; // did her last replies end in a question? (the app paces her questions)
    this.idleSince = performance.now();
    this.quietSince = performance.now(); // nobody has said anything since
    this.nextInitiate = 45 + Math.random() * 45; // seconds of quiet before she speaks up
    this.initiations = 0; // unanswered ones in a row
    this.camStream = null;
    this.video = null;
    this.dtype = "q4f16";
    this.device = "webgpu";

    this.mic = new Mic((chunk) => this.vad?.postMessage({ type: "audio", buffer: chunk }, [chunk.buffer]));
    this.player = new Player({
      onChunkStart: (id, seq) => this._onChunkStart(id, seq),
      onChunkEnd: (id) => {
        if (this.current?.id === id) this.current.played++;
      },
      onDrained: () => this._onDrained(),
    });
    this._mouthTimer = 0;
  }

  // ------------------------------------------------------------ lifecycle

  get brain() {
    return this.settings.brain;
  }

  /** The lab or a server on this device: text in over HTTP, Moonshine and Kokoro here. */
  get remote() {
    return isRemote(this.brain);
  }

  systemPrompt() {
    const persona = personaText(this.settings);
    const remote = this.remote;
    return buildSystemPrompt(persona, {
      audio: this.brain === "gemma",
      camera: this.brain === "gemma" || remote, // a still goes to the lab model as an image_url
      remote,
      brain: this.brain,
      model: remote ? connection(this.settings).model : "",
      length: replyLength(this.settings),
    });
  }

  /**
   * Spawn the workers and load everything. Resolves when all three are ready.
   * @param {{dtype: string, device: string}} o
   */
  async boot({ dtype = "q4f16", device = "webgpu" }) {
    this.dtype = dtype;
    this.device = device;
    this.timings.info = this.remote
      ? { brain: this.brain, dtype: connection(this.settings).model || "?", device: endpoints(connection(this.settings).url)?.host || "" }
      : { brain: this.brain, dtype, device };

    this.vad = new Worker(new URL("./workers/vad.worker.js", import.meta.url), { type: "module" });
    this.tts = new Worker(new URL("./workers/tts.worker.js", import.meta.url), { type: "module" });
    this.llm = new Worker(new URL("./workers/llm.worker.js", import.meta.url), { type: "module" });
    this.vad.onmessage = ({ data }) => this._onVad(data);
    this.tts.onmessage = ({ data }) => this._onTts(data);
    this.llm.onmessage = ({ data }) => this._onLlm(data);
    // the full brain hears the audio itself; Moonshine writes the words down beside it
    if (this.brain === "gemma") {
      this.stt = new Worker(new URL("./workers/stt.worker.js", import.meta.url), { type: "module" });
      this.stt.onmessage = ({ data }) => this._onStt(data);
      this.ready.stt = false;
    } else {
      this.ready.stt = true;
    }
    for (const [name, w] of [["vad", this.vad], ["tts", this.tts], ["llm", this.llm], ...(this.stt ? [["stt", this.stt]] : [])]) {
      w.onerror = (e) => {
        const msg = `${name} worker: ${e.message || "failed to load (see the browser console)"}`;
        this._error(msg);
        if (!this.ready[name]) this._readyReject?.(new Error(msg));
      };
    }

    const allReady = new Promise((resolve, reject) => {
      this._readyResolve = resolve;
      this._readyReject = reject;
    });

    this.vad.postMessage({ type: "load" });
    this.tts.postMessage({
      type: "load",
      engine: this.settings.ttsEngine,
      device: this.settings.ttsDevice === "cpu" ? "wasm" : device, // the voice can leave the GPU to the model
      voice: this.settings.voice,
      speed: this.settings.speed,
    });
    this.llm.postMessage({
      type: "load",
      brain: this.remote ? "lab" : this.brain, // the worker only transcribes for a remote brain
      dtype,
      device,
      deviceMap: this.settings.deviceMap || null,
      system: this.systemPrompt(),
      primer: this.memory.asMessages(12),
    });
    this.stt?.postMessage({ type: "load", device, model: this.settings.sttModel || "tiny" });
    await allReady;
  }

  _checkReady() {
    if (this.ready.vad && this.ready.tts && this.ready.llm && this.ready.stt && this._readyResolve) {
      this._readyResolve();
      this._readyResolve = null;
      this.dispatchEvent(new CustomEvent("ready"));
    }
  }

  /**
   * Call inside the user's tap, before the long download: mobile browsers
   * only let an AudioContext run when it was started by a gesture.
   */
  async unlockAudio() {
    await this.player.unlock();
    if (!this.mic.running) await this.mic.start();
    if (!this.music) {
      // the ambience shares the unlocked output context; it does not pass the voice analyser
      this.music = new Music(this.player.ctx);
      this.applyAmbience();
      this.renderer.scene.onStrike = (near) => this.music.thunder(near);
    }
  }

  /** Settings → the synth bed and the rain sound. */
  applyAmbience() {
    const s = this.settings;
    const storm = s.storm !== false;
    this.renderer.setStorm(storm);
    this.renderer.setStormParts({ rain: s.stormRain !== false, gusts: s.stormGusts !== false, lightning: s.stormLightning !== false });
    if (!this.music) return;
    this.music.setEnabled(s.music !== false);
    this.music.setVolume((Number(s.musicVolume) || 0) / 100);
    this.music.setTempo(s.musicTempo || 76);
    this.music.setRainSound(storm && s.stormRain !== false && s.stormSound !== false);
    this.music.setThunder(storm && s.stormLightning !== false && s.stormThunder !== false);
    this.music.setRainVolume((Number(s.stormVolume ?? 50) || 0) / 100);
  }

  /** Everything is loaded: start listening. She runs in. */
  async begin() {
    await this.unlockAudio();
    this.applyListeningSettings();
    this.vad?.postMessage({ type: "reset" });
    this.live = true; // speech is acted on from here; before this the mic only warms the VAD
    this._setState("idle");
    this.music?.setRegime(this.renderer.scene.regime);
    this.music?.start();
    this.renderer.enter();
    this._tick();
  }

  applyListeningSettings() {
    const th = vadThresholds(this.settings.sensitivity);
    this.vad?.postMessage({
      type: "config",
      config: { start: th.start, exit: th.exit, barge: th.barge, mode: this.settings.mode },
    });
    this.dispatchEvent(new CustomEvent("mode", { detail: this.settings.mode }));
  }

  setVoice(voice) {
    this.settings.voice = voice;
    this.tts?.postMessage({ type: "set_voice", voice });
  }

  setSpeed(speed) {
    this.settings.speed = speed;
    this.tts?.postMessage({ type: "set_speed", speed });
  }

  /** Persona changed: the model gets a fresh context primed from memory. */
  resetContext() {
    this.llm?.postMessage({ type: "reset", system: this.systemPrompt(), primer: this.memory.asMessages(12) });
  }

  /**
   * The user chose a district in Settings. She walks there (left for the
   * Undercity, right for the Stack), and the model is told the register to
   * take with the next turn. While a district is pinned in Settings the
   * conversation's own depth tags do not move her.
   */
  moveTo(regime) {
    if (!REGIMES[regime]) return;
    this.hints.push(`(Note: you are in ${REGIMES[regime].register}. Take that register with you.)`);
    if (regime === this.renderer.scene.regime) return;
    this.topicRegime = regime;
    this.dispatchEvent(new CustomEvent("regime", { detail: regime }));
    const cur = this.current;
    const walk = this.renderer.travel(regime, REGIMES[regime].colour);
    walk.then(() => this.music?.setRegime(regime));
    if (cur && !cur.finished) {
      cur.travel = walk.then(() => {
        cur.travel = null;
        for (const m of cur.held.splice(0)) this._enqueue(cur, m);
      });
    }
  }

  clearMemory() {
    this.memory.clear();
    this.topicRegime = null;
    this.llm?.postMessage({ type: "reset", system: this.systemPrompt(), primer: [] });
    this.dispatchEvent(new CustomEvent("cleared"));
  }

  /** Pause/resume listening (hands-free mode). */
  setPaused(p) {
    this.paused = p;
    this.vad?.postMessage({ type: "reset" });
    this.dispatchEvent(new CustomEvent("paused", { detail: p }));
  }

  pttDown() {
    if (this.state === "speaking" || this.state === "thinking") this.interrupt();
    this.vad?.postMessage({ type: "ptt_down" });
  }

  pttUp() {
    this.vad?.postMessage({ type: "ptt_up" });
  }

  /**
   * A typed line: the same turn as speech, minus the transcription. A camera
   * still attached with ◉ rides along. If she is mid-reply she is cut off,
   * as speaking over her would.
   */
  sendText(text) {
    const t = String(text || "").trim();
    if (!t) return false;
    if (this.state === "speaking" || this.state === "thinking") this.interrupt();
    this.initiations = 0; // the user spoke, in writing
    this._turn({ text: t, image: this.pendingImage });
    this.pendingImage = null;
    this.dispatchEvent(new CustomEvent("snapUsed"));
    return true;
  }

  /** Test hook: the model worker's next generation fails as a lost GPU device. */
  simulateGpuLoss() {
    this.llm?.postMessage({ type: "simulate_gpu_loss" });
  }

  /** Stop her mid-sentence. */
  interrupt() {
    if (!this.current || this.current.finished) return;
    this.current.cancelled = true;
    this.current.held.length = 0;
    this.current.controller?.abort();
    this.llm.postMessage({ type: "interrupt" });
    this.tts.postMessage({ type: "cancel" });
    this.player.stop();
    this.renderer.pulse(1.4);
    this.renderer.setState("interrupted", { then: "listening" });
    this.state = "listening";
    this.dispatchEvent(new CustomEvent("state", { detail: "interrupted" }));
  }

  // ------------------------------------------------------------ camera

  async toggleCamera(videoEl) {
    if (this.camStream) {
      this.camStream.getTracks().forEach((t) => t.stop());
      this.camStream = null;
      this.video = null;
      return false;
    }
    this.camStream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "user", width: { ideal: 640 }, height: { ideal: 640 } }, audio: false });
    videoEl.srcObject = this.camStream;
    this.video = videoEl;
    await videoEl.play().catch(() => {});
    return true;
  }

  /** Grab a still; it rides along with the next turn. She leans in to look. */
  snap() {
    const img = this._captureFrame();
    if (!img) return false;
    this.pendingImage = img;
    if (this.state === "idle") this.renderer.gesture("lean");
    this.dispatchEvent(new CustomEvent("toast", { detail: "attached to your next turn" }));
    return true;
  }

  _captureFrame() {
    const v = this.video;
    if (!v || !v.videoWidth) return null;
    const max = 512;
    const k = Math.min(1, max / Math.max(v.videoWidth, v.videoHeight));
    const w = Math.round(v.videoWidth * k);
    const h = Math.round(v.videoHeight * k);
    const c = document.createElement("canvas");
    c.width = w;
    c.height = h;
    const cx = c.getContext("2d");
    cx.translate(w, 0);
    cx.scale(-1, 1); // un-mirror the selfie view
    cx.drawImage(v, 0, 0, w, h);
    const d = cx.getImageData(0, 0, w, h);
    // raw pixels for the on-device model; a JPEG data URL for a lab model
    return { data: d.data, width: w, height: h, dataUrl: this.remote ? c.toDataURL("image/jpeg", 0.8) : null };
  }

  // ------------------------------------------------------------ the turn

  /**
   * One turn. Normally the user's audio (or a typed text / a camera still).
   * `silent` turns come from the app, not the user: nothing is shown or
   * remembered on the user side. `say` skips the model and speaks the given
   * line in her voice (a thought of hers), with `mood` for the gesture.
   */
  _turn({ audio = null, seconds = 0, image = null, text = null, say = null, mood = null, silent = false }) {
    if (this.brain === "gemma" && !audio && !image && !text && !say) return;
    if (audio) this.initiations = 0; // the user spoke: she is not talking to herself
    const id = ++this.turnId;
    this.timings.begin(id);
    this.timings.mark("vad_end");
    const cur = {
      id,
      raw: "",
      fed: 0,
      spoken: "",
      mood: null,
      look: false,
      transcript: null,
      seq: 0,
      sentences: [], // text handed to TTS, by seq
      spokenSeq: -1, // the last sentence whose audio has started
      llmDone: false,
      sent: 0, // sentences handed to TTS
      got: 0, // audio chunks back (or failed)
      played: 0, // chunks played to the end
      held: [], // audio waiting for her to arrive in a new district
      travel: null,
      depth: null,
      tagsDone: false, // the leading tags have been read in full
      cancelled: false,
      finished: false,
      hadImage: !!image,
      hadAudio: !!audio,
      controller: null,
    };
    cur.splitter = new SentenceSplitter((sentence) => this._say(cur, sentence));
    cur.silent = silent;
    this.current = cur;

    if (!silent) {
      const userTurn = this.memory.push({ id, role: "user", text: text || "", audioSeconds: seconds, image: !!image });
      cur.userTurn = userTurn;
      this.dispatchEvent(
        new CustomEvent("line", {
          detail: { id, role: "user", text: text || (audio ? `… ${seconds.toFixed(1)} s` : ""), pending: !!audio && !text, image: !!image },
        }),
      );
    }

    this._setState("thinking");
    if (say) {
      // her own line, in her voice, no model: a thought when it has been quiet
      cur.mood = mood || "thoughtful";
      this.renderer.setMood(cur.mood);
      cur.raw = say;
      cur.spoken = say;
      cur.fed = say.length;
      cur.splitter.push(say);
      this.timings.mark("sent");
      this._onDone({ id, text: say, tokens: 0, interrupted: false });
      // the model did not hear this: it learns of it with the next real turn
      this.hints.push(`(A moment ago you said, unprompted: "${say}")`);
      return;
    }
    if (this.remote) {
      this._labTurn(cur, audio, text, image);
      return;
    }
    if (audio && this.stt) {
      // a copy: the original buffer is about to be handed to the model worker
      const copy = audio.slice();
      this.stt.postMessage({ type: "transcribe", id, audio: copy }, [copy.buffer]);
    }
    // notes for the model ride along with the turn but are neither shown nor remembered
    const hints = this.hints.splice(0);
    const pace = this._questionPacing();
    if (pace) hints.push(pace);
    const modelText = [text, ...hints].filter(Boolean).join("\n") || null;
    const msg = {
      type: "turn",
      id,
      audio,
      image,
      text: modelText,
      sampling: !!this.settings.sampling,
      maxNewTokens: replyLength(this.settings) === "short" ? 110 : 360,
      primer: this.memory.asMessages(12),
    };
    const transfer = [];
    if (audio) transfer.push(audio.buffer);
    if (image) transfer.push(image.data.buffer);
    this.llm.postMessage(msg, transfer);
    this.timings.mark("sent");
  }

  /**
   * A turn on the lab or on a server on this device: Moonshine writes the
   * words down here, the reply streams back over HTTP. The model is told not
   * to think (she speaks, she does not deliberate) and whatever thinking a
   * server sends anyway is split off before it can reach her voice.
   */
  async _labTurn(cur, audio, text, image = null) {
    const conn = connection(this.settings);
    const where = this.brain === "local" ? "Local server" : "Lab";
    try {
      let userText = text || "";
      if (audio) {
        const t = await new Promise((resolve, reject) => {
          cur.transcriptResolve = resolve;
          cur.transcriptReject = reject;
          this.llm.postMessage({ type: "transcribe", id: cur.id, audio }, [audio.buffer]);
        });
        userText = [t, text].filter(Boolean).join("\n");
      }
      if (cur.cancelled) return;
      if (!userText.trim() || /^\[BLANK_AUDIO\]$/i.test(userText.trim())) {
        this._finish(cur, { blank: true });
        return;
      }
      const e = endpoints(conn.url);
      if (!e) throw new Error(this.brain === "local" ? "no server address set (Settings → A server on this device)" : "no endpoint set (Settings → Lab)");
      if (blockedByMixedContent(conn.url)) throw new TypeError("Failed to fetch");
      this.timings.mark("sent");
      // The model sees the transcript, not the audio, so a little more of each
      // remembered turn is affordable here. The user's words are already in
      // memory (the transcript was written there before this point); a silent
      // turn (her own check-in) is not, so its instruction goes on the wire
      // with the hints, which are never shown or remembered either.
      const messages = [{ role: "system", content: this.systemPrompt() }, ...this.memory.asMessages(12, 400)];
      const extra = cur.silent && userText.trim() ? [userText.trim()] : [];
      extra.push(...this.hints.splice(0));
      const pace = this._questionPacing();
      if (pace) extra.push(pace);
      if (extra.length) {
        const last = messages[messages.length - 1];
        if (last.role === "user") last.content += `\n${extra.join("\n")}`;
        else messages.push({ role: "user", content: extra.join("\n") });
      }
      if (image?.dataUrl) {
        // the still rides on the last user turn, OpenAI-style
        const last = messages[messages.length - 1];
        const t = last.role === "user" ? last.content : "(a camera still)";
        if (last.role !== "user") messages.push({ role: "user", content: t });
        messages[messages.length - 1].content = [{ type: "text", text: t }, { type: "image_url", image_url: { url: image.dataUrl } }];
      }
      cur.controller = new AbortController();
      let visible = "";
      const parser = new ThinkParser((piece) => {
        visible += piece;
        this._onToken(cur.id, piece);
      });
      const r = await streamChat({
        chat: e.chat,
        model: conn.model || "default",
        apiKey: conn.apiKey,
        messages,
        signal: cur.controller.signal,
        temperature: this.settings.sampling ? 0.75 : 0.3,
        maxTokens: replyLength(this.settings) === "short" ? 120 : 500,
        thinking: false,
        thinkSwitch: this.settings.thinkSwitch || "auto",
        onDelta: (piece) => parser.push(piece),
      });
      parser.close();
      if (cur.cancelled) return;
      this.lastLab = { ms: r.ms, firstTokenMs: r.firstTokenMs, usage: r.usage, finish: r.finish, reasoning: r.reasoning.length };
      this._onDone({ id: cur.id, text: visible, tokens: r.usage?.completion_tokens ?? r.chunks, interrupted: r.finish === "length" });
    } catch (e) {
      if (cur.cancelled) return;
      this._error(`${where}: ${explainFetchError(e, conn.url)}`);
      this._finish(cur, { error: true });
    }
  }

  /** Model text so far -> what will be spoken (tags stripped, transcript held back). */
  _process(raw) {
    // gpt-oss's thought channel; a lab model's <think> block is split off upstream (think.js)
    let s = raw.replace(/<\|channel>thought[\s\S]*?<channel\|>/g, "");
    // leading mood tag(s)
    const head = s.match(MOOD_TAG);
    if (head) s = s.slice(head[0].length);
    else if (/^\s*\[[^\]]{0,16}$/.test(s)) return { spoken: "", hold: true }; // tag still arriving
    // [look]
    s = s.replace(LOOK_TAG, "");
    // transcript line: everything from a line starting with >> onward
    const tr = s.search(/(^|\n)\s*>>/);
    let transcript = null;
    if (tr >= 0) {
      transcript = s.slice(tr).replace(/^\s*>>\s*/, "").trim();
      s = s.slice(0, tr);
    } else {
      // hold back a trailing line that might become the transcript marker, or a partial tag
      s = s.replace(/\n\s*>?$/, "").replace(/\[[^\]]{0,6}$/, "");
    }
    return { spoken: s, transcript };
  }

  _onToken(id, piece) {
    const cur = this.current;
    if (!cur || cur.id !== id || cur.cancelled) return;
    if (!cur.raw) this.timings.mark("first_token", id);
    cur.raw += piece;
    const head = cur.raw.match(MOOD_TAG);
    if (head && !cur.tagsDone) {
      // The two tags can land in separate pieces ("[curious] " then "[mid] ").
      // Keep reading the head until something that is not a tag follows it,
      // so the depth tag is not lost behind the first complete mood tag.
      const tags = [...head[0].matchAll(/\[([a-z]+)\]/gi)].map((m) => m[1].toLowerCase());
      const mood = tags.find((t) => MOODS.includes(t));
      const depth = tags.find((t) => t in DEPTHS) || null;
      const rest = cur.raw.slice(head[0].length);
      const done = !!rest && !/^\[[^\]]*$/.test(rest);
      if (!cur.mood && (mood || done)) {
        cur.mood = mood || "calm";
        this.renderer.setMood(cur.mood);
        this.music?.setMood(cur.mood);
      }
      if (depth && !cur.depth) {
        cur.depth = depth;
        this._topic(cur, DEPTHS[depth]);
      }
      if (done) cur.tagsDone = true;
    }
    if (LOOK_TAG.test(cur.raw)) cur.look = true;
    LOOK_TAG.lastIndex = 0;
    const { spoken, transcript } = this._process(cur.raw);
    if (transcript != null) cur.transcript = transcript;
    if (spoken.length > cur.fed) {
      cur.splitter.push(spoken.slice(cur.fed));
      cur.fed = spoken.length;
    }
    cur.spoken = spoken;
    this._showHer(cur, true);
  }

  /**
   * Whether a question is welcome this turn. A small model told "about half
   * the time" asks every time, so the app keeps the score: never twice
   * running, and usually not at all.
   */
  _questionPacing() {
    const notes = [];
    const short = replyLength(this.settings) === "short";
    if (short) {
      // a phone: a long burst of GPU work can cost the device, so she quips
      notes.push("(Two or three sentences at most. A quip is fine.)");
    } else if (this.lastReplyWords != null && this.lastReplyWords < 15) {
      // a thin last reply asks for a fuller one this time
      notes.push("(A fuller reply this time: three to five sentences, about the specific thing they said, with a turn of your own in it: an observation, a bit of your past, an opinion.)");
    }
    const last = this.asked[this.asked.length - 1];
    if (last === true) notes.push("(No question this time. Answer, react, or offer a thought of your own.)");
    else {
      const lastTwo = this.asked.slice(-2);
      if (lastTwo.length === 2 && lastTwo.every((a) => a === false) && Math.random() < 0.6) {
        notes.push("(If there is something you want to know, you may end with one short question. One, not two.)");
      } else if (Math.random() < 0.5) notes.push("(No question this time.)");
    }
    return notes.join("\n") || null;
  }

  /**
   * It has been quiet. About half the time she thinks aloud, one of her own
   * thoughts in her voice; otherwise the model is asked for a line of its
   * own, tied to the conversation, with no question in it.
   */
  _initiate() {
    this.initiations++;
    this.nextInitiate = 120 + Math.random() * 120;
    if (Math.random() < 0.5) {
      this._turn({ say: pickThought(), mood: "thoughtful", silent: true });
      return;
    }
    this._turn({
      text: "(It has been quiet a while. Say one or two sentences of your own: a dry observation about the night, the street, or them; or a thought you have been sitting on. Not a comfort. No question.)",
      silent: true,
    });
  }

  /** What she has said so far, and what is generated but not yet spoken. */
  _saidSoFar(cur) {
    return cur.sentences.slice(0, cur.spokenSeq + 1).join(" ");
  }

  _notYetSaid(cur) {
    return [...cur.sentences.slice(cur.spokenSeq + 1), (cur.splitter?.buffer || "").trim()].filter(Boolean).join(" ");
  }

  /** The transcript line follows her VOICE: a sentence appears when its audio starts. */
  _showHer(cur, streaming) {
    this.dispatchEvent(
      new CustomEvent("line", {
        detail: { id: cur.id, role: "her", text: this._saidSoFar(cur), pending: this._notYetSaid(cur), streaming },
      }),
    );
  }

  _say(cur, sentence) {
    if (cur.cancelled) return;
    const text = sentence.replace(/\s+/g, " ").trim();
    if (!text || !/[a-z0-9]/i.test(text)) return;
    if (cur.seq === 0) this.timings.mark("first_sent", cur.id);
    cur.sent++;
    cur.sentences[cur.seq] = text;
    this.tts.postMessage({ type: "say", id: cur.id, seq: cur.seq++, text });
  }

  /**
   * The conversation changed depth. If the district follows the conversation
   * and this is a different one, she walks off towards it, the street
   * changes while she is off screen, she walks back in, and only then does
   * the reply play. Audio synthesized meanwhile is held, not lost.
   */
  _topic(cur, regime) {
    if (this.settings.regime !== "topic" || !REGIMES[regime]) return;
    if (regime === (this.topicRegime || "HEART")) {
      this.topicRegime = regime;
      return;
    }
    this.topicRegime = regime;
    this.dispatchEvent(new CustomEvent("regime", { detail: regime }));
    cur.travel = this.renderer.travel(regime, REGIMES[regime].colour).then(() => {
      cur.travel = null;
      this.music?.setRegime(regime); // the key changes as the street does
      for (const m of cur.held.splice(0)) this._enqueue(cur, m);
    });
  }

  _enqueue(cur, m) {
    if (m.seq === 0) this.timings.mark("first_audio", m.id);
    this.player.enqueue(m.id, m.seq, m.audio);
  }

  /** Everything she was given to say has been said. */
  _allPlayed(cur) {
    return cur.llmDone && cur.got >= cur.sent && cur.played >= cur.got && !cur.held.length && !cur.travel;
  }

  _onDone({ id, text, interrupted, tokens, blank }) {
    const cur = this.current;
    if (!cur || cur.id !== id) return;
    this.timings.mark("done", id);
    this.timings.count(id, tokens || 0, (text || "").length);
    cur.llmDone = true;
    if (!cur.cancelled) {
      // final pass over the complete text (the streaming pass held bits back)
      cur.raw = text || cur.raw;
      const { spoken, transcript } = this._process(cur.raw);
      if (transcript != null) cur.transcript = transcript;
      if (spoken.length > cur.fed) cur.splitter.push(spoken.slice(cur.fed));
      cur.fed = spoken.length;
      cur.spoken = spoken;
      cur.splitter.close();
    }
    // transcript of what the user said (gemma: from the model; others: already set)
    if (cur.hadAudio && cur.transcript != null && cur.transcript !== "") {
      this._setUserText(cur, cur.transcript);
    }
    if (cur.cancelled) {
      // she was cut off: what she actually got out is what is remembered
      const said = this._saidSoFar(cur).trim();
      if (said) this.memory.push({ role: "assistant", text: said + " —", mood: cur.mood || "calm" });
      this.dispatchEvent(new CustomEvent("line", { detail: { id, role: "her", text: said, pending: "", streaming: false, interrupted: true } }));
    } else if (cur.spoken.trim()) {
      this.memory.push({ role: "assistant", text: cur.spoken.trim() + (interrupted ? " —" : ""), mood: cur.mood || "calm" });
      cur.interrupted = !!interrupted;
      if (!cur.silent || cur.raw !== cur.spoken) {
        // did she ask something? and how much did she say? (her own thoughts do not count)
        this.asked.push(/\?["')\]]*\s*$/.test(cur.spoken.trim()));
        if (this.asked.length > 4) this.asked.shift();
        this.lastReplyWords = cur.spoken.trim().split(/\s+/).length;
      }
      this._showHer(cur, false);
    } else if (blank) {
      this.dispatchEvent(new CustomEvent("line", { detail: { id, role: "sys", text: "didn't catch that" } }));
    }
    if (cur.cancelled || cur.sent === 0 || (this._allPlayed(cur) && !this.player.playing)) this._finish(cur, { blank });
    // else: _onDrained finishes the turn once the LAST chunk has played
  }

  _setUserText(cur, text) {
    if (cur.silent) return;
    if (cur.userTurn) this.memory.amendLast("user", { text });
    this.dispatchEvent(new CustomEvent("line", { detail: { id: cur.id, role: "user", text, pending: false } }));
  }

  _finish(cur, { blank = false, error = false } = {}) {
    if (cur.finished) return;
    cur.finished = true;
    this.timings.mark("played", cur.id);
    if (!cur.cancelled && cur.sentences.length) {
      // everything queued has now been played: the whole line is "said"
      cur.spokenSeq = cur.sentences.length - 1;
      this.dispatchEvent(
        new CustomEvent("line", { detail: { id: cur.id, role: "her", text: cur.spoken.trim(), pending: "", streaming: false, interrupted: !!cur.interrupted } }),
      );
    }
    if (this.current === cur) this.current = null;
    if (error) {
      this.renderer.setState("error");
      this.state = "error";
      setTimeout(() => this.state === "error" && this._setState("idle"), 2500);
      return;
    }
    if (!cur.cancelled) this._setState("idle");
    this.renderer.setMood("calm");
    // "[look]": she asked for the camera; give it to her and ask again
    if (cur.look && !cur.cancelled && !cur.hadImage) {
      const img = this._captureFrame();
      if (img) {
        this._turn({ image: img, text: "Here is the camera still you asked for. Say what you see, briefly." });
      } else {
        this.dispatchEvent(new CustomEvent("toast", { detail: "turn the camera on first (the ◉ button)" }));
      }
    }
  }

  // ------------------------------------------------------------ playback

  _onChunkStart(id, seq) {
    const cur = this.current;
    if (!cur || cur.id !== id) return;
    if (seq === 0) this.timings.mark("audible", id);
    if (this.state !== "speaking") this._setState("speaking");
    if (seq === 0) this.renderer.react(cur.mood || "calm"); // the mood's gesture, as her voice starts
    this.renderer.nod();
    this.renderer.pulse(0.8);
    // the words of this sentence appear as she starts to say them
    cur.spokenSeq = Math.max(cur.spokenSeq, seq);
    this._showHer(cur, !cur.llmDone);
  }

  _onDrained() {
    const cur = this.current;
    if (!cur) return;
    // The queue is empty, but a sentence may still be on its way from TTS:
    // finishing here used to drop the end of her reply. Wait for all of it.
    if (this._allPlayed(cur)) this._finish(cur);
    else this._setState("thinking"); // waiting on more audio (or on her walk)
  }

  _tick() {
    const step = () => {
      if (!this.mic.running) return;
      // 30 fps mouth + listening glow
      this.renderer.setMouth(this.player.playing ? this.player.level() : 0);
      this.music?.setRain(this.renderer.scene.rain);
      if (this.state === "listening") this.renderer.setListenLevel(Math.min(1, this.mic.level() * 4));
      // she speaks up herself when it has been quiet, a few times at most
      if (this.live && this.state === "idle" && !this.paused && this.settings.initiate !== false && this.initiations < 3) {
        if ((performance.now() - this.quietSince) / 1000 >= this.nextInitiate) this._initiate();
      }
      // a smoke break after a long quiet spell, and a nap if it goes on; a
      // stroll in progress (the renderer's own quiet-time habit) finishes first
      if (this.state === "idle" && this.settings.smokeBreaks && !this.renderer.strolling) {
        const quiet = (performance.now() - this.idleSince) / 1000;
        const smoke = this.renderer.m.states.idle_long;
        const nap = this.renderer.m.states.asleep;
        if (nap?.clips?.length && quiet > (smoke?.after_seconds || 90) + (nap.after_seconds || 240)) {
          if (this.renderer.state !== "asleep") this.renderer.setState("asleep");
        } else if (smoke?.clips?.length && quiet > (smoke.after_seconds || 90)) {
          if (this.renderer.state !== "idle_long") this.renderer.setState("idle_long");
        }
      }
      this.dispatchEvent(new CustomEvent("tick"));
      setTimeout(step, 33);
    };
    step();
  }

  _setState(name) {
    this.state = name;
    if (name === "idle") this.idleSince = performance.now();
    if (name === "idle" || name === "listening") this.quietSince = performance.now();
    this.renderer.setState(name);
    this.music?.setState(name);
    clearTimeout(this._listenTimer);
    if (name === "listening") {
      const after = (this.renderer.m.states.listening?.long_after ?? 5) * 1000;
      this._listenTimer = setTimeout(() => this.renderer.listenLong(), after);
    }
    this.vad?.postMessage({ type: "config", config: { playing: name === "speaking" || name === "thinking" } });
    this.dispatchEvent(new CustomEvent("state", { detail: name }));
  }

  // ------------------------------------------------------------ worker messages

  _onVad(m) {
    switch (m.type) {
      case "ready":
        this.ready.vad = true;
        this._checkReady();
        break;
      case "progress":
        this.dispatchEvent(new CustomEvent("progress", { detail: m }));
        break;
      case "speech_start":
        if (this.paused || !this.live) return;
        if (this.state === "speaking" || this.state === "thinking") {
          if (!this.settings.bargeIn && this.settings.mode !== "ptt") return;
          this.interrupt();
        } else {
          this._setState("listening");
        }
        break;
      case "speech_end":
        if (this.paused || !this.live) return;
        if (this.state !== "listening") {
          // a barge-in was refused (barge-in off) or listening was paused: ignore
          if (this.state === "speaking" || this.state === "thinking") return;
        }
        this._turn({ audio: m.audio, seconds: m.seconds, image: this.pendingImage });
        this.pendingImage = null;
        this.dispatchEvent(new CustomEvent("snapUsed"));
        break;
      case "speech_cancel":
        if (this.live && this.state === "listening") this._setState("idle");
        break;
      case "prob":
        this.dispatchEvent(new CustomEvent("prob", { detail: m.p }));
        break;
      case "error":
        this._error(m.message);
        if (!this.ready.vad) this._readyReject?.(new Error(m.message));
        break;
    }
  }

  _onTts(m) {
    switch (m.type) {
      case "ready":
        this.ready.tts = true;
        this.voices = m.voices || {};
        this.settings.voice = m.voice || this.settings.voice;
        this.timings.info.tts = `${m.engine} ${m.device}/${m.dtype}`;
        this._checkReady();
        break;
      case "progress":
        this.dispatchEvent(new CustomEvent("progress", { detail: m }));
        break;
      case "info":
        this.dispatchEvent(new CustomEvent("info", { detail: m.message }));
        if (/device was lost/.test(m.message)) this.dispatchEvent(new CustomEvent("toast", { detail: "the GPU reset; reloading her voice…" }));
        break;
      case "audio": {
        const cur = this.current;
        if (!cur || cur.id !== m.id || cur.cancelled) return;
        cur.got++;
        if (cur.travel) cur.held.push(m); // she is still walking to the new district
        else this._enqueue(cur, m);
        break;
      }
      case "error":
        if (m.id != null) {
          const cur = this.current;
          if (cur && cur.id === m.id) {
            cur.got++;
            cur.played++; // nothing to play for this one
            if (this._allPlayed(cur) && !this.player.playing) this._finish(cur);
          }
        }
        this._error(m.message);
        if (!this.ready.tts) this._readyReject?.(new Error(m.message));
        break;
    }
  }

  _onStt(m) {
    switch (m.type) {
      case "ready":
        this.ready.stt = true;
        this._checkReady();
        break;
      case "progress":
        this.dispatchEvent(new CustomEvent("progress", { detail: m }));
        break;
      case "info":
        this.dispatchEvent(new CustomEvent("info", { detail: m.message }));
        break;
      case "transcript": {
        // the turn may already be over; the words still belong to it
        const turn = this.memory.turns.find((t) => t.id === m.id) || (this.current?.id === m.id ? this.current.userTurn : null);
        if (m.text) {
          if (turn) Object.assign(turn, { text: m.text });
          this.memory.save();
          this.dispatchEvent(new CustomEvent("line", { detail: { id: m.id, role: "user", text: m.text, pending: false } }));
        }
        this.timings.mark("transcript", m.id);
        break;
      }
      case "error":
        this._error(m.message);
        if (!this.ready.stt) this._readyReject?.(new Error(m.message));
        break;
    }
  }

  _onLlm(m) {
    switch (m.type) {
      case "ready":
        this.ready.llm = true;
        this.timings.info.dtype = m.dtype;
        this._checkReady();
        break;
      case "progress":
        this.dispatchEvent(new CustomEvent("progress", { detail: m }));
        break;
      case "info":
        this.dispatchEvent(new CustomEvent("info", { detail: m.message }));
        if (/^retrying/.test(m.message)) this.dispatchEvent(new CustomEvent("toast", { detail: "one more try…" }));
        if (/device was lost/.test(m.message)) this.dispatchEvent(new CustomEvent("toast", { detail: "the GPU reset; bringing her back…" }));
        if (/your turn is kept/.test(m.message)) this.dispatchEvent(new CustomEvent("toast", { detail: "still bringing her back; she heard you" }));
        break;
      case "first_token":
        this.timings.mark("first_token", m.id);
        break;
      case "token":
        this._onToken(m.id, m.text);
        break;
      case "transcript": {
        const cur = this.current;
        if (!cur || cur.id !== m.id) return;
        if (cur.transcriptResolve) {
          cur.transcriptResolve(m.text);
          cur.transcriptResolve = null;
        }
        if (m.text) this._setUserText(cur, m.text);
        break;
      }
      case "done":
        this._onDone(m);
        break;
      case "error": {
        const cur = this.current;
        if (cur && (m.id == null || cur.id === m.id)) {
          cur.transcriptReject?.(new Error(m.message));
          if (!cur.cancelled) this._finish(cur, { error: true });
        }
        this._error(m.message);
        // only a load failure aborts the boot; a failed turn is just a failed turn
        if (!this.ready.llm && m.id == null) this._readyReject?.(new Error(m.message));
        break;
      }
    }
  }

  _error(message) {
    console.error(message);
    this.dispatchEvent(new CustomEvent("error", { detail: message }));
  }
}

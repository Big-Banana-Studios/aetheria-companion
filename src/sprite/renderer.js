// Mira on a canvas: a virtual pixel screen (one unit = one source pixel of
// the atlas) that holds the street (src/scene/scene.js), her, the aura, and
// the weather, drawn at that resolution and then scaled by ONE integer to the
// real canvas. Nothing is ever blurred.
//
// She has a base clip per state (courier.json `states`), gestures that play
// over it (`gestures`, keyed by mood in `moods` and by situation here), a
// position along the street for the moves that carry her, a mouth that
// follows the output RMS, a visor "blink", orbiting particles while she
// thinks, her reflection in the wet road, and the aura ported from the game's
// scenes/player/aura.gd.

import { Scene } from "../scene/scene.js";

const FALLBACK_MOODS = {
  calm: { gesture: null, glow: 1.0, breathe: 1.6, rain: 0.5 },
  happy: { gesture: "jump", glow: 1.3, breathe: 2.3, rain: 0.3 },
  curious: { gesture: "lean", glow: 1.1, breathe: 1.9, rain: 0.5 },
  concerned: { gesture: "reach", glow: 0.7, breathe: 1.0, rain: 0.9 },
};

const STATE_GLOW = {
  idle: 0.22,
  idle_long: 0.1,
  asleep: 0.06,
  listening: 0.42,
  thinking: 0.34,
  speaking: 0.4,
  interrupted: 0.5,
  error: 0.04,
};

export class SpriteRenderer {
  /**
   * @param {HTMLCanvasElement} canvas
   * @param {object} manifest courier.json
   * @param {HTMLImageElement|ImageBitmap} atlas courier.png
   * @param {{mouth?: HTMLImageElement|ImageBitmap|null}} [extra]
   */
  constructor(canvas, manifest, atlas, { mouth = null } = {}) {
    this.canvas = canvas;
    this.ctx = canvas.getContext("2d", { alpha: false });
    this.m = manifest;
    this.atlas = atlas;
    this.mouthImg = mouth;
    this.F = manifest.meta.frame;
    this.moods = manifest.moods || FALLBACK_MOODS;
    this.gestures = manifest.gestures || {};

    // virtual screen
    this.vc = document.createElement("canvas");
    this.vctx = this.vc.getContext("2d");
    this.s = 1;
    this.W = 0;
    this.H = 0;
    this.vw = 0;
    this.vh = 0;
    this.groundY = 0;
    this.scene = new Scene();
    this.scene.setMoodTable(this.moods);

    // state, clips, gestures
    this.state = "idle";
    this.clip = null;
    this.clipName = "";
    this.clipT = 0;
    this.fpsOverride = null;
    this.frameSubset = null;
    this.then = null;
    this.seq = null; // active gesture: {steps, i, t, dur, x0}
    this.x = 0; // her offset from the centre of the street, source px
    this.side = 1;
    this.turnAt = 0;
    this.fidgetAt = 0;
    this.smokeIdx = 0;
    this.smokeUntil = 0;
    this.particlesOn = false;

    // looks
    this.mood = "calm";
    this.aura = { rgb: [255, 79, 139], glow: 0.22, target: 0.22 };
    this.pulses = [];
    this.listenLevel = 0;
    this.mouth = 0;
    this.mouthTarget = 0;
    this.voiceRaw = 0;
    this.voiceEnv = 0; // fast attack, slow release: what the aura breathes with
    this._lastVoice = 0;
    this.shake = 0;
    this.nodUntil = 0;
    this.blinkAt = 3;
    this.blinkUntil = 0;
    this.t = 0;
    this._last = 0;
    this._raf = 0;

    this._ro = new ResizeObserver(() => this.resize());
    this._ro.observe(canvas.parentElement || canvas);
    this.resize();
    this.setState("idle");
  }

  // ------------------------------------------------------------ public

  setAuraColour(hex) {
    const n = parseInt(hex.replace("#", ""), 16);
    this.aura.rgb = [(n >> 16) & 255, (n >> 8) & 255, n & 255];
  }

  setRegime(name) {
    this.scene.setRegime(name);
  }

  setSceneEnabled(on) {
    this.scene.enabled = !!on;
  }

  setMood(mood) {
    this.mood = this.moods[mood] ? mood : "calm";
    this.scene.setMood(this.mood);
  }

  /** The mood's gesture, at the moment she starts to speak. */
  react(mood) {
    this.setMood(mood);
    const g = this.moods[this.mood]?.gesture;
    if (g) this.gesture(g);
  }

  /** She runs in from the left and turns to you. */
  enter() {
    this.gesture("enter");
  }

  /**
   * The conversation moved to another district. She walks off the edge
   * towards it (the Undercity is down the street to the left, the Stack up
   * to the right), the street changes while she is out of sight, and she
   * walks back in to the middle. Resolves true when she is there, false if
   * something cut the walk short (the street is then left as it was).
   * @param {"GUT"|"HEART"|"HEAD"} regime
   * @param {string} colour aura colour for that regime
   */
  travel(regime, colour) {
    return new Promise((resolve) => {
      const switchNow = () => {
        this.scene.setRegime(regime);
        this.setAuraColour(colour);
      };
      if (!this.scene.enabled || !this.vw) {
        switchNow();
        resolve(true);
        return;
      }
      const order = { GUT: 0, HEART: 1, HEAD: 2 };
      const dir = Math.sign((order[regime] ?? 1) - (order[this.scene.regime] ?? 1)) || 1;
      const clip = dir > 0 ? "walk_right" : "walk_left";
      const steps = [
        { clip, to: dir > 0 ? "offright" : "offleft" },
        { switch: true },
        { clip, from: dir > 0 ? "offleft" : "offright", to: 0 },
      ];
      this.seq = { name: "travel", steps, i: -1, t: 0, dur: 0, x0: this.x, x1: this.x, side: 0, sticky: true, onSwitch: switchNow, onDone: () => resolve(true), onCancel: () => resolve(false) };
      this._nextStep();
    });
  }

  /** The user has been talking a while: she opens up. */
  listenLong() {
    const st = this.m.states.listening;
    if (this.state === "listening" && st?.long && !this.seq) this.gesture(st.long);
  }

  /** Lightning, now. */
  strike(near = 1) {
    this.scene.strike(near);
  }

  /** 0..1 level of the mic, only used while listening. */
  setListenLevel(v) {
    this.listenLevel = Math.max(0, Math.min(1, v));
    this.scene.setListen(this.listenLevel);
  }

  /** Output RMS 0..~0.4 -> mouth openness and the voice the aura follows. Sampled at 30 fps by the caller. */
  setMouth(rms) {
    this.mouthTarget = Math.max(0, Math.min(1, (rms - 0.015) / 0.16));
    this.voiceRaw = Math.max(0, Math.min(1, (rms - 0.01) / 0.14));
    // a syllable onset throws a ring
    if (this.state === "speaking" && this.voiceRaw > 0.42 && this._lastVoice < 0.2) this.pulse(0.45);
    this._lastVoice = this.voiceRaw;
    this.scene.setVoice(rms);
  }

  nod() {
    this.nodUntil = this.t + 0.16;
  }

  pulse(strength = 1) {
    this.pulses.push({ t0: this.t, life: 0.45, strength });
    if (this.pulses.length > 6) this.pulses.shift();
  }

  /**
   * Play a gesture from the manifest over the current state.
   * @param {string} name
   */
  gesture(name) {
    const steps = this.gestures[name];
    if (!steps || !steps.length) return;
    if (this.seq?.sticky) return; // she is walking to another district; nothing interrupts that but the user
    let side = 0;
    if (steps.some((s) => s.to === "sign" || s.hit === "sign")) {
      // a gesture aimed at a sign: the nearer one, mirrored if it is on her left
      if (this.scene.signStand(1, 1) == null) {
        if (name !== "punch") this.gesture("punch");
        return;
      }
      side = this.x < 0 ? -1 : this.x > 0 ? 1 : Math.random() < 0.5 ? -1 : 1;
    }
    this.seq = { name, steps, i: -1, t: 0, dur: 0, x0: this.x, x1: this.x, side };
    this._nextStep();
  }

  _mirrored(clipName, side) {
    if (side >= 0) return clipName;
    const m = clipName.endsWith("_right") ? clipName.replace(/_right$/, "_left") : clipName.endsWith("_left") ? clipName.replace(/_left$/, "_right") : clipName;
    return this.m.clips[m] ? m : clipName;
  }

  _resolvePos(p, side) {
    if (typeof p === "number") return p;
    if (p === "offleft") return -(this.vw / 2 + this.F * 0.6);
    if (p === "offright") return this.vw / 2 + this.F * 0.6;
    if (p === "sign") {
      // her fist reaches about a third of a frame from her centre on the contact frame
      const at = this.scene.signStand(side || 1, Math.round(this.F * 0.33));
      return at == null ? this.x : at;
    }
    return 0;
  }

  /**
   * @param {"idle"|"idle_long"|"asleep"|"listening"|"thinking"|"speaking"|"interrupted"|"error"} name
   * @param {{then?: string}} [o]  state to fall into when a one-shot clip ends
   */
  setState(name, { then = null } = {}) {
    const st = this.m.states[name] || this.m.states.idle;
    const prev = this.state;
    this.state = name;
    this.scene.setState(name);
    this.then = then ?? st.then ?? null;
    this.fpsOverride = st.fps ?? null;
    this.particlesOn = !!st.particles;
    this.aura.target = STATE_GLOW[name] ?? 0.2;
    // A gesture with a floor (a drag: three puffs at least) survives the
    // turn's own state changes; anything else - listening, a flinch, a nap -
    // takes over at once.
    const step = this.seq?.steps[this.seq.i];
    const turnState = name === "idle" || name === "speaking" || name === "thinking";
    const keep =
      step && turnState && (this.seq.sticky || (step.min != null && this.seq.t < step.min) || (step.until === "turn_end" && name !== "idle"));
    if (keep) return;
    if (this.seq?.sticky) {
      // a walk between districts, cut short: she is back in the middle, the street unchanged
      this.seq.onCancel?.();
      this.x = 0;
    }
    this.seq = null;
    this.frameSubset = null;
    if (name === "idle_long") {
      this.smokeIdx = 0;
      this._play(st.clips[0]);
      this._scheduleSmokeTurn(st);
    } else if (st.clips && st.clips.length) {
      // a nap: lie down facing whichever way, once, and stay there
      this._play(st.clips[Math.floor(Math.random() * st.clips.length)]);
      this.clipT = 0;
    } else if (name === "thinking") {
      this.side = 1;
      this.turnAt = this.t + (st.turn_every || 1.2);
      this.fidgetAt = this.t + (st.fidget_after || 1.8);
      this._play(st.clip);
    } else {
      this._play(st.clip);
    }
    if (name === "idle") this._scheduleFidget(st);
    if (st.strike) this.scene.strike(1);
    // situations: startled awake; a flinch before she goes down
    if (prev === "asleep" && name !== "asleep" && name !== "error") this.gesture("startle");
    else if (st.gesture) this.gesture(st.gesture);
    // back to the middle of the street whenever a new state begins
    if (!this.seq) this.x = Math.round(this.x * 0.5);
  }

  start() {
    if (this._raf) return;
    const loop = (ts) => {
      this._raf = requestAnimationFrame(loop);
      const dt = this._last ? Math.min(0.1, (ts - this._last) / 1000) : 0;
      this._last = ts;
      this.t += dt;
      this._update(dt);
      this._draw();
    };
    this._raf = requestAnimationFrame(loop);
  }

  stop() {
    cancelAnimationFrame(this._raf);
    this._raf = 0;
    this._last = 0;
  }

  resize() {
    const host = this.canvas.parentElement || this.canvas;
    const dpr = Math.max(1, Math.min(4, window.devicePixelRatio || 1));
    const cw = host.clientWidth || 0;
    const ch = host.clientHeight || 0;
    if (cw < 40 || ch < 60) {
      // hidden (the gate is up): nothing sensible to lay out yet
      this.W = this.H = 0;
      this.vw = this.vh = 0;
      return;
    }
    this.W = Math.floor(cw * dpr);
    this.H = Math.floor(ch * dpr);
    this.canvas.width = this.W;
    this.canvas.height = this.H;
    // one integer scale: the street is about 240 source px tall on a phone,
    // so she (144 px) stands 60% of the way up it
    this.s = Math.max(1, Math.floor(Math.min(this.H / 240, this.W / 170)));
    this.vw = Math.ceil(this.W / this.s);
    this.vh = Math.ceil(this.H / this.s);
    this.vc.width = this.vw;
    this.vc.height = this.vh;
    this.groundY = this.vh - Math.max(18, Math.round(this.vh * 0.11));
    this.scene.resize(this.vw, this.vh, this.groundY, this.m.meta.character_height);
    this.ctx.imageSmoothingEnabled = false;
  }

  // ------------------------------------------------------------ internals

  _play(name, { fps = null, frames = null } = {}) {
    const clip = this.m.clips[name];
    if (!clip) return false;
    if (this.clipName !== name || frames) this.clipT = 0;
    this.clip = clip;
    this.clipName = name;
    this.stepFps = fps;
    this.frameSubset = frames;
    return true;
  }

  _baseClip() {
    const st = this.m.states[this.state] || this.m.states.idle;
    if (this.state === "thinking") return this.side > 0 ? "idle_right" : "idle_left";
    if (this.state === "idle_long") return st.clips[this.smokeIdx % st.clips.length];
    return this.clipName && st.clips?.includes(this.clipName) ? this.clipName : st.clip;
  }

  _scheduleSmokeTurn(st) {
    const [lo, hi] = st.turn_every || [8, 20];
    this.smokeUntil = this.t + lo + Math.random() * (hi - lo);
  }

  _scheduleFidget(st) {
    const [lo, hi] = st.fidget_every || [12, 25];
    this.fidgetAt = this.t + lo + Math.random() * (hi - lo);
  }

  _speed(clip) {
    // px/s at which this gait's feet stay on the ground
    const n = clip.frames.length;
    return ((clip.cycle_px || 124) * clip.fps) / n;
  }

  _nextStep() {
    const seq = this.seq;
    if (!seq) return;
    seq.i++;
    if (seq.i >= seq.steps.length) {
      this.seq = null;
      this.frameSubset = null;
      this._play(this._baseClip());
      if (this.state === "idle") this._scheduleFidget(this.m.states.idle);
      if (this.state === "thinking") this.fidgetAt = this.t + 2.5 + Math.random() * 2.5;
      seq.onDone?.();
      return;
    }
    const step = seq.steps[seq.i];
    if (step.switch) {
      // off screen: the street changes, then straight on to the next step
      seq.onSwitch?.();
      this._nextStep();
      return;
    }
    const clipName = this._mirrored(step.clip, seq.side);
    const clip = this.m.clips[clipName];
    if (!clip) {
      this._nextStep();
      return;
    }
    this._play(clipName, { fps: step.fps ?? null, frames: step.frames ?? null });
    seq.t = 0;
    seq.x0 = this.x;
    seq.hitDone = !step.hit;
    const fps = step.fps ?? clip.fps;
    const nFrames = step.frames ? step.frames.length : clip.frames.length;
    if (step.from != null || step.to != null) {
      // travel at the clip's own pace, from where she is (or a named place) to a named place
      const from = step.from != null ? this._resolvePos(step.from, seq.side) : this.x;
      const to = this._resolvePos(step.to ?? 0, seq.side);
      this.x = from;
      seq.x0 = from;
      seq.x1 = to;
      seq.dur = Math.abs(to - from) / this._speed(clip);
    } else {
      seq.x1 = this.x + (step.dx || 0) * (seq.side < 0 ? -1 : 1);
      seq.dur = step.min != null ? step.min : step.dur != null ? step.dur : nFrames / fps;
    }
    seq.until = step.until || null;
    seq.hold = step.hold ?? 0;
    seq.holding = false;
  }

  _frameIndex() {
    const clip = this.clip;
    if (!clip) return null;
    const list = this.frameSubset;
    const n = list ? list.length : clip.frames.length;
    const fps = this.stepFps ?? this.fpsOverride ?? clip.fps;
    const raw = Math.floor(this.clipT * fps);
    let idx;
    if (clip.loop && !list) idx = raw % n;
    else idx = Math.min(n - 1, raw);
    return list ? list[idx] : idx;
  }

  _update(dt) {
    this.clipT += dt;
    this.scene.update(dt);
    const st = this.m.states[this.state] || this.m.states.idle;

    if (this.seq) {
      const seq = this.seq;
      seq.t += dt;
      if (!seq.hitDone && seq.t >= seq.dur * 0.45) {
        // the contact frame of the punch
        seq.hitDone = true;
        this.scene.hitSign(seq.side || 1);
        this.shake = 0.15;
        this.pulse(1.2);
      }
      if (!seq.holding) {
        const k = seq.dur > 0 ? Math.min(1, seq.t / seq.dur) : 1;
        this.x = Math.round(seq.x0 + (seq.x1 - seq.x0) * k);
        const turnGoing = this.state === "speaking" || this.state === "thinking";
        if (seq.t >= seq.dur && seq.until === "turn_end" && turnGoing) {
          // the floor is met, but her turn is not over: keep going
        } else if (seq.t >= seq.dur) {
          if (seq.hold === -1) seq.holding = true; // until the state changes
          else if (seq.hold > 0) {
            seq.holding = true;
            seq.holdUntil = this.t + seq.hold;
          } else this._nextStep();
        }
      } else if (seq.hold !== -1 && this.t >= seq.holdUntil) {
        this._nextStep();
      }
    } else {
      // one-shot base clips fall through to the next state
      if (this.clip && !this.clip.loop && this.then) {
        const fps = this.fpsOverride ?? this.clip.fps;
        if (this.clipT * fps >= this.clip.frames.length) {
          const next = this.then;
          this.then = null;
          this.setState(next);
        }
      }
      if (this.state === "thinking") {
        if (this.t >= this.fidgetAt && st.fidgets?.length) {
          this.gesture(st.fidgets[Math.floor(Math.random() * st.fidgets.length)]);
        } else if (this.t >= this.turnAt) {
          this.side = -this.side;
          this.turnAt = this.t + (st.turn_every || 1.2);
          this._play(this.side > 0 ? "idle_right" : "idle_left");
        }
      }
      if (this.state === "idle" && this.t >= this.fidgetAt && st.fidgets?.length) {
        this.gesture(st.fidgets[Math.floor(Math.random() * st.fidgets.length)]);
      }
      if (this.state === "idle_long" && this.t >= this.smokeUntil) {
        this.smokeIdx = (this.smokeIdx + 1 + Math.floor(Math.random() * (st.clips.length - 1))) % st.clips.length;
        this._play(st.clips[this.smokeIdx]);
        this._scheduleSmokeTurn(st);
      }
    }
    // keep her on the street
    const lim = Math.max(10, this.vw / 2 - 26);
    if (!this.seq || this.seq.steps[this.seq.i]?.from == null) this.x = Math.max(-lim, Math.min(lim, this.x));

    const mood = this.moods[this.mood] || FALLBACK_MOODS.calm;
    const want = this.aura.target * (mood.glow ?? 1) + (this.state === "listening" ? this.listenLevel * 0.5 : 0);
    this.aura.glow += (want - this.aura.glow) * Math.min(1, dt * 6);
    this.mouth += (this.mouthTarget - this.mouth) * Math.min(1, dt * 18);
    const vTarget = this.state === "speaking" ? this.voiceRaw : 0;
    this.voiceEnv += (vTarget - this.voiceEnv) * Math.min(1, dt * (vTarget > this.voiceEnv ? 28 : 5));
    if (this.shake > 0) this.shake -= dt;
    if (this.t >= this.blinkAt) {
      this.blinkUntil = this.t + 0.11;
      this.blinkAt = this.t + 3 + Math.random() * 3;
    }
    this.pulses = this.pulses.filter((p) => this.t - p.t0 < p.life);
  }

  _draw() {
    const v = this.vctx;
    const { F, vw, vh, groundY } = this;
    if (!vw || !vh) {
      this.resize();
      if (!this.vw) return;
    }
    const idx = this._frameIndex();
    if (idx == null) return;
    const clip = this.clip;
    const e = clip.frames[idx];
    const flip = !!clip.flip;

    // vertical nudge: bob, lean-in, nod, thinking lift, sleeping breath
    let oy = 0;
    if (this.state === "idle" || this.state === "speaking") oy += Math.round(Math.sin(this.t * 2.4) * 0.6);
    if (this.state === "asleep") oy += Math.round(Math.sin(this.t * 1.1) * 0.6);
    if (this.state === "listening") oy += 1;
    if (this.state === "thinking") oy -= 1;
    if (this.t < this.nodUntil) oy += 1;

    const dx = Math.round(vw / 2 - F / 2 + this.x);
    const dy = groundY - this.m.meta.feet_y + oy;
    const ref = this.m.clips.idle_down.frames[0];
    const headY = dy + (ref.visor ? ref.visor.y + ref.visor.h / 2 : F * 0.22);
    const cx = dx + F / 2;
    const torsoY = dy + this.m.meta.feet_y - this.m.meta.character_height * 0.42;

    v.imageSmoothingEnabled = false;
    this.scene.drawBack(v);
    this._drawAura(v, cx, torsoY);
    if (this.particlesOn) this._drawParticles(v, cx, headY, true);

    // her reflection in the wet road (look-dev §4), then her
    const drawHer = (ctx, x, y, mirrorY) => {
      ctx.save();
      if (mirrorY) {
        ctx.translate(0, mirrorY * 2);
        ctx.scale(1, -1);
      }
      if (flip) {
        ctx.translate(x + F, y);
        ctx.scale(-1, 1);
        ctx.drawImage(this.atlas, e.x, e.y, F, F, 0, 0, F, F);
      } else {
        ctx.drawImage(this.atlas, e.x, e.y, F, F, x, y, F, F);
      }
      ctx.restore();
    };
    if (this.scene.enabled) {
      v.save();
      v.beginPath();
      v.rect(0, groundY + 5, vw, vh - groundY - 5);
      v.clip();
      v.globalAlpha = 0.18;
      drawHer(v, dx + Math.round(Math.sin(this.t * 2.1) * 1.5), dy - oy, groundY + 2);
      v.restore();
    }
    drawHer(v, dx, dy, 0);

    // mouth, when she is talking and we can see it
    if (e.mouth && this.mouth > 0.06 && (this.state === "speaking" || this.state === "interrupted")) {
      const mx = flip ? F - 1 - e.mouth.x : e.mouth.x;
      this._drawMouth(v, dx + mx, dy + e.mouth.y);
    }
    // visor blink (not while she is asleep or down)
    if (e.visor && this.t < this.blinkUntil && this.state !== "asleep" && this.state !== "error") {
      const vb = e.visor;
      const vx = flip ? F - vb.x - vb.w : vb.x;
      v.fillStyle = "rgba(12, 13, 29, 0.6)";
      v.fillRect(dx + vx, dy + vb.y, vb.w, vb.h);
    }
    if (this.particlesOn) this._drawParticles(v, cx, headY, false);
    this.scene.drawFront(v);

    // to the screen, by one integer (with a pixel of shake when something got hit)
    const c = this.ctx;
    c.imageSmoothingEnabled = false;
    const shaking = this.shake > 0 || this.scene.shake > 0;
    const sx = shaking ? Math.round((Math.random() - 0.5) * 2) * this.s : 0;
    const sy = shaking ? Math.round((Math.random() - 0.5) * 2) * this.s : 0;
    if (shaking) {
      c.fillStyle = "#0c0d1d";
      c.fillRect(0, 0, this.W, this.H);
    }
    c.drawImage(this.vc, sx, sy, vw * this.s, vh * this.s);
  }

  _drawAura(ctx, cx, cy) {
    const F = this.F;
    const [r, g, b] = this.aura.rgb;
    const v = this.voiceEnv; // her voice, 0..1, only while speaking
    const glow = this.aura.glow + v * 0.4;
    if (glow <= 0.005 && !this.pulses.length) return;
    const mood = this.moods[this.mood] || FALLBACK_MOODS.calm;
    const breathe = (1 + Math.sin(this.t * (mood.breathe ?? 1.6)) * 0.03) * (1 + v * 0.07);
    const R = F * 0.62 * breathe * (1 + v * 0.1);
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, R);
    grad.addColorStop(0, `rgba(${r},${g},${b},${(glow * 0.55).toFixed(3)})`);
    grad.addColorStop(0.55, `rgba(${r},${g},${b},${(glow * 0.18).toFixed(3)})`);
    grad.addColorStop(1, `rgba(${r},${g},${b},0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(cx - R, cy - R, R * 2, R * 2);
    // the rings: the readout. They swell and brighten with her voice.
    ctx.lineWidth = v > 0.55 ? 2 : 1;
    for (const [k, a] of [
      [0.33, 0.55],
      [0.46, 0.35],
    ]) {
      ctx.beginPath();
      ctx.ellipse(cx, cy + F * 0.18, F * k * breathe, F * k * 0.42 * breathe, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r},${g},${b},${(a * Math.min(1, glow / 0.3) * (1 + v * 0.8)).toFixed(3)})`;
      ctx.stroke();
    }
    // the radiant band: a soft halo just outside the inner ring that flares with each syllable
    if (v > 0.03) {
      const ry = cy + F * 0.18;
      const rad = F * 0.4 * breathe;
      ctx.save();
      ctx.translate(cx, ry);
      ctx.scale(1, 0.42);
      const halo = ctx.createRadialGradient(0, 0, rad * 0.7, 0, 0, rad * 1.35);
      halo.addColorStop(0, `rgba(${r},${g},${b},0)`);
      halo.addColorStop(0.45, `rgba(${r},${g},${b},${(0.42 * v).toFixed(3)})`);
      halo.addColorStop(1, `rgba(${r},${g},${b},0)`);
      ctx.fillStyle = halo;
      ctx.beginPath();
      ctx.arc(0, 0, rad * 1.35, 0, Math.PI * 2);
      ctx.fill();
      ctx.restore();
    }
    for (const p of this.pulses) {
      const age = (this.t - p.t0) / p.life;
      const rad = F * (0.2 + age * 0.55) * p.strength;
      ctx.beginPath();
      ctx.ellipse(cx, cy + F * 0.18, rad, rad * 0.42, 0, 0, Math.PI * 2);
      ctx.strokeStyle = `rgba(${r},${g},${b},${((1 - age) * 0.8).toFixed(3)})`;
      ctx.lineWidth = Math.max(1, Math.round(2 * (1 - age)));
      ctx.stroke();
    }
    ctx.restore();
  }

  _drawParticles(ctx, cx, cy, behind) {
    const F = this.F;
    const [r, g, b] = this.aura.rgb;
    const n = 7;
    const rx = F * 0.2;
    const ry = F * 0.07;
    for (let i = 0; i < n; i++) {
      const a = this.t * 1.3 + (i * Math.PI * 2) / n;
      const z = Math.sin(a);
      if (behind ? z >= 0 : z < 0) continue;
      const px = cx + Math.cos(a) * rx;
      const py = cy - F * 0.1 + z * ry + Math.sin(this.t * 2 + i);
      const size = z > 0 ? 2 : 1;
      ctx.fillStyle = `rgba(${r},${g},${b},${(0.55 + 0.35 * (z + 1) * 0.5).toFixed(2)})`;
      ctx.fillRect(Math.round(px - size / 2), Math.round(py - size / 2), size, size);
    }
  }

  _drawMouth(ctx, x, y) {
    const box = this.m.mouth.box;
    const open = this.mouth;
    if (this.mouthImg) {
      const k = Math.min(4, Math.round(open * 4));
      ctx.drawImage(this.mouthImg, k * box.w, 0, box.w, box.h, x - Math.floor(box.w / 2), y - Math.floor(box.h / 2), box.w, box.h);
      return;
    }
    const w = Math.round(box.w * (0.3 + 0.2 * open)); // about a third of the first cut: speech, not shouting
    const h = Math.max(1, Math.round(1 + (box.h - 3) * open * 0.35));
    const left = x - Math.floor(w / 2);
    const top = y - 1;
    ctx.fillStyle = this.m.mouth.dark;
    ctx.fillRect(left, top, w, h);
    if (h >= 3) {
      ctx.fillStyle = this.m.mouth.inner;
      ctx.fillRect(left + 1, top + Math.floor(h / 2), w - 2, Math.max(1, h - Math.floor(h / 2) - 1));
    }
    ctx.fillStyle = this.m.mouth.skin;
    ctx.fillRect(left, top, 1, 1);
    ctx.fillRect(left + w - 1, top, 1, 1);
    if (h >= 2) {
      ctx.fillRect(left, top + h - 1, 1, 1);
      ctx.fillRect(left + w - 1, top + h - 1, 1, 1);
    }
  }
}

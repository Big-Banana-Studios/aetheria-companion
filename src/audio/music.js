// Ambience: a generative cyberpunk synth bed and the sound of the rain, made
// entirely with Web Audio nodes so it ships nothing and works offline.
//
//   pad      three voices of detuned saws + a sub-octave triangle, through a
//            low-pass that breathes on a slow LFO; chords change every few bars
//            on a progression per district
//   drone    a sine at the root, a slow tremolo on it
//   plucks   now and then a pentatonic note, short filter envelope, into a
//            dotted-eighth feedback delay: the synthwave echo
//   rain     bandpassed noise whose level follows the storm; a gust is a swell
//   thunder  a low, filtered noise burst on a lightning strike
//   reverb   a convolver on a generated 2.5 s decaying-noise impulse
//
// It ducks under her voice, and further while the mic is listening so the
// phone's own speaker does not talk to the VAD.

const PROGRESSIONS = {
  // midi note numbers; the pad takes them as written, the drone the lowest
  HEART: {
    chords: [
      [45, 48, 52, 55, 59], // Am9
      [41, 45, 48, 52, 57], // Fmaj7 (9)
      [48, 52, 55, 59, 62], // Cmaj9
      [43, 47, 50, 55, 57], // G6/9
    ],
    scale: [45, 48, 50, 52, 55, 57, 60, 62, 64, 67], // A minor pentatonic, two octaves
    cutoff: 900,
    bright: 1.0,
  },
  GUT: {
    chords: [
      [38, 41, 45, 48], // Dm7, low
      [34, 38, 41, 45], // Bbmaj7
      [31, 34, 38, 41], // Gm7
      [33, 37, 40, 43], // A7 (flat-ish)
    ],
    scale: [38, 41, 43, 45, 48, 50, 53, 55, 57, 60], // D minor pentatonic
    cutoff: 520,
    bright: 0.7,
  },
  HEAD: {
    chords: [
      [52, 54, 59, 64, 66], // Esus2 (9)
      [49, 52, 56, 59, 63], // C#m9
      [45, 49, 52, 56, 59], // Amaj7 (9)
      [47, 54, 59, 61, 66], // Bsus (9)
    ],
    scale: [52, 54, 56, 59, 61, 64, 66, 68, 71, 73], // E major pentatonic
    cutoff: 1500,
    bright: 1.35,
  },
};

const MOOD = {
  calm: { pluck: 0.14, cutoff: 0, q: 1.2, lfo: 0.06 },
  happy: { pluck: 0.3, cutoff: 350, q: 1.4, lfo: 0.09 },
  curious: { pluck: 0.22, cutoff: 150, q: 1.6, lfo: 0.08 },
  concerned: { pluck: 0.05, cutoff: -220, q: 1.0, lfo: 0.04 },
  amused: { pluck: 0.26, cutoff: 200, q: 1.5, lfo: 0.09 },
  excited: { pluck: 0.38, cutoff: 450, q: 1.8, lfo: 0.11 },
  annoyed: { pluck: 0.2, cutoff: 60, q: 3.5, lfo: 0.12 },
  sassy: { pluck: 0.28, cutoff: 120, q: 4.0, lfo: 0.12 },
  tired: { pluck: 0.06, cutoff: -260, q: 0.9, lfo: 0.035 },
  thoughtful: { pluck: 0.1, cutoff: -80, q: 1.1, lfo: 0.05 },
};

// how far the bed sits under what matters
const DUCK = { idle: 1.0, idle_long: 1.0, asleep: 0.55, listening: 0.22, thinking: 0.6, speaking: 0.28, interrupted: 0.25, error: 0.5 };

// A4 = 432 Hz: the whole bed is tuned to it, pads, drone and plucks alike.
export const A4 = 432;
const midi = (n) => A4 * Math.pow(2, (n - 69) / 12);

export class Music {
  /** @param {AudioContext} ctx  the output context, already unlocked by a gesture */
  constructor(ctx) {
    this.ctx = ctx;
    this.enabled = true;
    this.rainOn = true;
    this.volume = 0.4;
    this.rainVolume = 0.5; // the storm's own level: rain bed and thunder
    this.duck = 1;
    this.regime = "HEART";
    this.mood = "calm";
    this.rain = 0.7;
    this.bpm = 76;
    this.running = false;
    this.voices = [];
    this.chordIdx = 0;
    this.beat = 0;
    this.nextBeatAt = 0;
    this._timer = 0;

    const c = ctx;
    this.master = c.createGain();
    this.master.gain.value = 0;
    this.master.connect(c.destination);

    // reverb: a generated impulse
    this.reverb = c.createConvolver();
    this.reverb.buffer = this._impulse(2.6, 2.4);
    this.wet = c.createGain();
    this.wet.gain.value = 0.32;
    this.reverb.connect(this.wet);
    this.wet.connect(this.master);

    this.bus = c.createGain(); // everything musical
    this.bus.gain.value = 1;
    this.bus.connect(this.master);
    this.bus.connect(this.reverb);

    // the pad filter: shared, breathing
    this.filter = c.createBiquadFilter();
    this.filter.type = "lowpass";
    this.filter.frequency.value = 900;
    this.filter.Q.value = 1.2;
    this.filter.connect(this.bus);
    this.lfo = c.createOscillator();
    this.lfo.type = "sine";
    this.lfo.frequency.value = 0.06;
    this.lfoGain = c.createGain();
    this.lfoGain.gain.value = 260;
    this.lfo.connect(this.lfoGain);
    this.lfoGain.connect(this.filter.frequency);
    this.lfo.start();

    // the drone
    this.drone = c.createOscillator();
    this.drone.type = "sine";
    this.droneGain = c.createGain();
    this.droneGain.gain.value = 0;
    this.drone.connect(this.droneGain);
    this.droneGain.connect(this.bus);
    this.drone.start();
    this.tremolo = c.createOscillator();
    this.tremolo.frequency.value = 0.45;
    this.tremoloGain = c.createGain();
    this.tremoloGain.gain.value = 0.03;
    this.tremolo.connect(this.tremoloGain);
    this.tremoloGain.connect(this.droneGain.gain);
    this.tremolo.start();

    // the pluck delay: dotted eighth, feeding back
    this.delay = c.createDelay(2);
    this.delay.delayTime.value = (60 / this.bpm) * 0.75;
    this.delayFb = c.createGain();
    this.delayFb.gain.value = 0.38;
    this.delayTone = c.createBiquadFilter();
    this.delayTone.type = "lowpass";
    this.delayTone.frequency.value = 2400;
    this.delay.connect(this.delayTone);
    this.delayTone.connect(this.delayFb);
    this.delayFb.connect(this.delay);
    this.delayWet = c.createGain();
    this.delayWet.gain.value = 0.5;
    this.delayTone.connect(this.delayWet);
    this.delayWet.connect(this.bus);
    this.pluckBus = c.createGain();
    this.pluckBus.gain.value = 0.9;
    this.pluckBus.connect(this.bus);
    this.pluckBus.connect(this.delay);

    // the rain: noise, bandpassed, breathing
    this.noise = c.createBufferSource();
    this.noise.buffer = this._noise(2);
    this.noise.loop = true;
    this.rainBp = c.createBiquadFilter();
    this.rainBp.type = "bandpass";
    this.rainBp.frequency.value = 2600;
    this.rainBp.Q.value = 0.6;
    this.rainGain = c.createGain();
    this.rainGain.gain.value = 0;
    this.noise.connect(this.rainBp);
    this.rainBp.connect(this.rainGain);
    this.rainGain.connect(this.master);
    this.rainGain.connect(this.reverb);
    this.rainLfo = c.createOscillator();
    this.rainLfo.frequency.value = 0.23;
    this.rainLfoGain = c.createGain();
    this.rainLfoGain.gain.value = 0;
    this.rainLfo.connect(this.rainLfoGain);
    this.rainLfoGain.connect(this.rainGain.gain);
    this.rainLfo.start();
    this.noise.start();

    // thunder shares the noise buffer through its own path
    this.thunderLp = c.createBiquadFilter();
    this.thunderLp.type = "lowpass";
    this.thunderLp.frequency.value = 140;
    this.thunderLp.connect(this.master);
    this.thunderLp.connect(this.reverb);
  }

  // ------------------------------------------------------------ control

  start() {
    if (this.running) return;
    this.running = true;
    this.nextBeatAt = this.ctx.currentTime + 0.1;
    this.beat = 0;
    this._applyRegime(true);
    this._timer = setInterval(() => this._tick(), 90);
    this._level();
  }

  stop() {
    this.running = false;
    clearInterval(this._timer);
    this.master.gain.setTargetAtTime(0, this.ctx.currentTime, 0.4);
  }

  setVolume(v) {
    this.volume = Math.max(0, Math.min(1, v));
    this._level();
  }

  setEnabled(on) {
    this.enabled = !!on;
    this._level();
  }

  setRainSound(on) {
    this.rainOn = !!on;
    this._level();
  }

  /** 0..1: how loud the storm is, rain and thunder together (0.5 is the reference level). */
  setRainVolume(v) {
    this.rainVolume = Math.max(0, Math.min(1, v));
    this._level();
  }

  setState(state) {
    this.duck = DUCK[state] ?? 1;
    this._level();
  }

  setMood(m) {
    this.mood = MOOD[m] ? m : "calm";
    this._applyMood();
  }

  setRegime(name) {
    if (!PROGRESSIONS[name] || name === this.regime) return;
    this.regime = name;
    this.chordIdx = 0;
    this._applyRegime(false);
  }

  /** 0..1.6 from the scene: how hard it is raining. */
  setRain(r) {
    this.rain = Math.max(0, Math.min(1.6, r));
    this._level();
  }

  /** A lightning strike: a low rumble, louder when near. */
  thunder(near = 0.5) {
    if (!this.enabled || !this.running) return;
    const c = this.ctx;
    const src = c.createBufferSource();
    src.buffer = this.noise.buffer;
    const g = c.createGain();
    const t = c.currentTime + 0.15 + Math.random() * 0.25 * (1 - near);
    const peak = (0.25 + 0.55 * near) * (this.rainOn ? this.rainVolume * 2 : 0);
    if (peak <= 0.001) return;
    g.gain.setValueAtTime(0, t);
    g.gain.linearRampToValueAtTime(peak, t + 0.12);
    g.gain.exponentialRampToValueAtTime(0.001, t + 1.8 + near * 1.2);
    src.connect(g);
    g.connect(this.thunderLp);
    src.start(t);
    src.stop(t + 3.5);
  }

  // ------------------------------------------------------------ internals

  _level() {
    const now = this.ctx.currentTime;
    const music = this.enabled && this.running ? this.volume * this.duck : 0;
    this.master.gain.setTargetAtTime(Math.min(1, music + 0.0001), now, 0.6);
    // the rain sits on the master too, so it ducks with the music; its own level follows the storm and its slider
    const rain = this.rainOn ? (0.07 + 0.15 * this.rain) * this.rainVolume : 0;
    this.rainGain.gain.setTargetAtTime(rain, now, 1.2);
    this.rainLfoGain.gain.setTargetAtTime(rain * 0.35, now, 1.2);
  }

  _applyMood() {
    const m = MOOD[this.mood];
    const p = PROGRESSIONS[this.regime];
    const now = this.ctx.currentTime;
    this.filter.frequency.setTargetAtTime(Math.max(220, p.cutoff + m.cutoff), now, 2.5);
    this.filter.Q.setTargetAtTime(m.q, now, 1.5);
    this.lfo.frequency.setTargetAtTime(m.lfo, now, 2);
  }

  _applyRegime(immediate) {
    const p = PROGRESSIONS[this.regime];
    this._applyMood();
    this._chord(p.chords[0], immediate ? 0.8 : 3.5);
  }

  _tick() {
    const c = this.ctx;
    const beatLen = 60 / this.bpm;
    while (this.nextBeatAt < c.currentTime + 0.3) {
      this._onBeat(this.nextBeatAt);
      this.nextBeatAt += beatLen;
      this.beat++;
    }
  }

  _onBeat(t) {
    const p = PROGRESSIONS[this.regime];
    const m = MOOD[this.mood];
    if (this.beat % 16 === 0 && this.beat > 0) {
      this.chordIdx = (this.chordIdx + 1) % p.chords.length;
      this._chord(p.chords[this.chordIdx], 3.5, t);
    }
    // plucks: never on the chord change, more on the off-beats
    const offbeat = this.beat % 2 === 1;
    if (this.enabled && this.beat % 16 !== 0 && Math.random() < m.pluck * (offbeat ? 1.2 : 0.7)) {
      const chord = p.chords[this.chordIdx];
      const pool = p.scale.filter((n) => chord.some((cn) => (n - cn) % 12 === 0)).concat(p.scale);
      const note = pool[Math.floor(Math.random() * pool.length)] + (Math.random() < 0.3 ? 12 : 0);
      this._pluck(note, t + (Math.random() < 0.35 ? (60 / this.bpm) * 0.5 : 0));
    }
  }

  _chord(notes, fade, at = null) {
    const c = this.ctx;
    const t = at ?? c.currentTime;
    const bright = PROGRESSIONS[this.regime].bright;
    // old voices out
    for (const v of this.voices) {
      v.gain.gain.cancelScheduledValues(t);
      v.gain.gain.setTargetAtTime(0, t, fade / 3);
      for (const o of v.oscs) o.stop(t + fade * 1.5);
    }
    this.voices = [];
    // new voices in
    for (const n of notes.slice(1)) {
      const g = c.createGain();
      g.gain.setValueAtTime(0.0001, t);
      g.gain.setTargetAtTime(0.055 * bright, t, fade / 2.2);
      g.connect(this.filter);
      const oscs = [];
      for (const cents of [-7, 7]) {
        const o = c.createOscillator();
        o.type = "sawtooth";
        o.frequency.value = midi(n);
        o.detune.value = cents;
        o.connect(g);
        o.start(t);
        oscs.push(o);
      }
      const sub = c.createOscillator();
      sub.type = "triangle";
      sub.frequency.value = midi(n - 12);
      const sg = c.createGain();
      sg.gain.value = 0.5;
      sub.connect(sg);
      sg.connect(g);
      sub.start(t);
      oscs.push(sub);
      this.voices.push({ gain: g, oscs });
    }
    // the drone follows the root
    this.drone.frequency.setTargetAtTime(midi(notes[0] - 12), t, 0.8);
    this.droneGain.gain.setTargetAtTime(0.11, t, 1.5);
  }

  _pluck(note, t) {
    const c = this.ctx;
    const o = c.createOscillator();
    o.type = "triangle";
    o.frequency.value = midi(note);
    const f = c.createBiquadFilter();
    f.type = "lowpass";
    f.frequency.setValueAtTime(3200, t);
    f.frequency.exponentialRampToValueAtTime(500, t + 0.35);
    const g = c.createGain();
    g.gain.setValueAtTime(0.0001, t);
    g.gain.linearRampToValueAtTime(0.16, t + 0.012);
    g.gain.exponentialRampToValueAtTime(0.0001, t + 0.7);
    o.connect(f);
    f.connect(g);
    g.connect(this.pluckBus);
    o.start(t);
    o.stop(t + 0.8);
  }

  _impulse(seconds, decay) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(2, len, c.sampleRate);
    for (let ch = 0; ch < 2; ch++) {
      const d = buf.getChannelData(ch);
      for (let i = 0; i < len; i++) d[i] = (Math.random() * 2 - 1) * Math.pow(1 - i / len, decay);
    }
    return buf;
  }

  _noise(seconds) {
    const c = this.ctx;
    const len = Math.floor(c.sampleRate * seconds);
    const buf = c.createBuffer(1, len, c.sampleRate);
    const d = buf.getChannelData(0);
    let last = 0;
    for (let i = 0; i < len; i++) {
      // a little pink: white noise leaned on its own past
      const w = Math.random() * 2 - 1;
      last = (last + 0.04 * w) / 1.04;
      d[i] = w * 0.6 + last * 3.5 * 0.4;
    }
    return buf;
  }
}

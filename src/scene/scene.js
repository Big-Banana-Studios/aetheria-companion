// The street Mira stands on, at night, in the rain.
//
// A runtime port of the game's title-card city (Paperless/tools/make_skyline.py:
// sky, far/mid/near towers, a separate additive layer of lit windows), its
// rain (shaders/rain.gdshader: three depths, slant 0.26, bright heads), its
// lightning (scenes/ui/title.gd: a double flash that fades), the district
// tint (look-dev §3), sign flicker and puddle reflections (§4), and the
// vignette (shaders/vignette.gdshader). Everything is drawn at the virtual
// pixel resolution and scaled by one integer with the sprite, so it is the
// same pixel art she is.
//
// It adapts: the regime (GUT / HEART / HEAD) picks the palette, the props and
// how much it rains; the hour picks the sky and how many windows are lit; her
// mood picks the storm; her state moves the lamp; her voice pulses the sign.

const SKY_TOP = [8, 9, 18];
const STREAK = [150, 200, 255];

const LOOK = {
  HEART: {
    skyLow: [34, 22, 44],
    tint: [160, 128, 152],
    window: [255, 214, 150],
    neon: [[255, 120, 190], [255, 165, 90], [190, 140, 255]],
    signL: [120, 235, 255],
    signR: [255, 120, 190],
    lamp: [255, 179, 71],
    puddles: 4,
    rainK: 1.0,
    props: "market",
  },
  GUT: {
    skyLow: [16, 24, 40],
    tint: [90, 106, 156],
    window: [210, 175, 125],
    neon: [[150, 255, 120], [255, 165, 90], [120, 235, 255]],
    signL: [150, 255, 120],
    signR: [255, 165, 90],
    lamp: [157, 255, 60],
    puddles: 7,
    rainK: 1.25,
    props: "undercity",
  },
  HEAD: {
    skyLow: [26, 34, 54],
    tint: [159, 180, 204],
    window: [205, 228, 255],
    neon: [[120, 235, 255], [255, 79, 216], [235, 240, 255]],
    signL: [120, 235, 255],
    signR: [255, 79, 216],
    lamp: [55, 230, 240],
    puddles: 2,
    rainK: 0.75,
    props: "stack",
  },
};

// Tower layers, as fractions of the sky height (the game's numbers).
const LAYERS = {
  far: { lo: 0.16, hi: 0.34, fill: [20, 22, 36], lit: 0.05, wide: [14, 34], haze: 0.6 },
  mid: { lo: 0.24, hi: 0.52, fill: [12, 13, 24], lit: 0.1, wide: [22, 52], haze: 0.25 },
  near: { lo: 0.34, hi: 0.72, fill: [3, 3, 7], lit: 0.05, wide: [46, 96], haze: 0.0 },
};

const rgb = (c, a = 1) => `rgba(${c[0]},${c[1]},${c[2]},${a})`;
const mix = (a, b, t) => a.map((v, i) => Math.round(v + (b[i] - v) * t));
const clamp = (v, lo, hi) => Math.max(lo, Math.min(hi, v));

/** Small seeded RNG so a regime always draws the same street. */
function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** Value-noise fBm on a small grid, for the cloud. */
function fbm(n, rand, octaves = [2, 4, 8], weights = [0.6, 0.28, 0.12]) {
  const out = new Float32Array(n * n);
  for (let o = 0; o < octaves.length; o++) {
    const g = octaves[o];
    const grid = new Float32Array((g + 1) * (g + 1));
    for (let i = 0; i < grid.length; i++) grid[i] = rand();
    for (let y = 0; y < n; y++) {
      const fy = (y / n) * g;
      const y0 = Math.floor(fy);
      const ty = fy - y0;
      for (let x = 0; x < n; x++) {
        const fx = (x / n) * g;
        const x0 = Math.floor(fx);
        const tx = fx - x0;
        const s = (t) => t * t * (3 - 2 * t);
        const a = grid[y0 * (g + 1) + x0];
        const b = grid[y0 * (g + 1) + x0 + 1];
        const c = grid[(y0 + 1) * (g + 1) + x0];
        const d = grid[(y0 + 1) * (g + 1) + x0 + 1];
        const v = (a + (b - a) * s(tx)) * (1 - s(ty)) + (c + (d - c) * s(tx)) * s(ty);
        out[y * n + x] += v * weights[o];
      }
    }
  }
  return out;
}

function canvas(w, h) {
  const c = document.createElement("canvas");
  c.width = Math.max(1, w);
  c.height = Math.max(1, h);
  return c;
}

export class Scene {
  constructor() {
    this.vw = 0;
    this.vh = 0;
    this.groundY = 0;
    this.regime = "HEART";
    this.look = LOOK.HEART;
    this.mood = "calm";
    this.moodRain = { calm: 0.5 };
    this.state = "idle";
    this.enabled = true;
    this.t = 0;
    this.hour = -1;
    this.rain = 0.5;
    this.voice = 0;
    this.listen = 0;
    this.lampK = 1;
    this.layers = null;
    this.streaks = [[], [], []];
    this.splashes = [];
    this.ripples = [];
    this.flashT = -1;
    this.flashNear = 0;
    this.nextStrike = 25 + Math.random() * 30;
    this.signs = [];
    this.puddles = [];
    this.lamp = null;
    this.windows = [];
    this.blinkWin = null;
    this.nextBlink = 2;
    this.charH = 144;
    this.sparks = [];
    this.shake = 0;
    this.storm = true; // off: a dry night on the same street
    this.rainOn = true; // the storm's parts
    this.gustsOn = true;
    this.lightningOn = true;
    this.gust = 1; // a downpour now and then
    this.gustUntil = 0;
    this.nextGust = 20 + Math.random() * 40;
    this.onStrike = null; // (near) => void, for the thunder
  }

  // ------------------------------------------------------------ adaptation

  setRegime(name) {
    if (!LOOK[name]) name = "HEART";
    if (name === this.regime && this.layers) return;
    this.regime = name;
    this.look = LOOK[name];
    this._generate();
  }

  setMoodTable(table) {
    this.moodRain = {};
    for (const [k, v] of Object.entries(table || {})) this.moodRain[k] = v.rain ?? 0.5;
  }

  setMood(m) {
    this.mood = m;
  }

  setState(s) {
    this.state = s;
  }

  setVoice(level) {
    this.voice = clamp(level * 3, 0, 1);
  }

  setListen(level) {
    this.listen = clamp(level, 0, 1);
  }

  strike(near = 1) {
    this.flashT = 0;
    this.flashNear = clamp(near, 0, 1);
    this.onStrike?.(this.flashNear);
  }

  /**
   * Where she should stand to hit a sign: `side` +1 is the sign on the right
   * (she stands to its left and punches right), -1 the one on the left.
   * Returns an x offset from the middle of the street, or null.
   * @param {number} reach how far her fist gets from her centre, in px
   */
  signStand(side, reach) {
    if (!this.enabled || this.signs.length < 2) return null;
    const cx = Math.floor(this.vw / 2);
    const s = side > 0 ? this.signs[1] : this.signs[0];
    return side > 0 ? s.x - reach - cx : s.x + s.w + reach - cx;
  }

  /** The blow lands. The sign flares, shakes, tears, and sheds sparks. */
  hitSign(side) {
    const s = side > 0 ? this.signs[1] : this.signs[0];
    if (!s) return;
    s.hit = { t: 0, side };
    s.damagedUntil = this.t + 6;
    const px = side > 0 ? s.x : s.x + s.w;
    const py = s.y + Math.floor(s.h / 2);
    for (let i = 0; i < 10; i++) {
      this.sparks.push({
        x: px,
        y: py + (Math.random() - 0.5) * s.h,
        vx: side * (12 + Math.random() * 55),
        vy: -(15 + Math.random() * 60),
        life: 0.45 + Math.random() * 0.4,
        t: 0,
        white: Math.random() < 0.4,
        colour: s.colour,
      });
    }
    this.shake = 0.16;
  }

  resize(vw, vh, groundY, charH = 144) {
    this.vw = vw;
    this.vh = vh;
    this.groundY = groundY;
    this.charH = charH;
    this._generate();
  }

  // ------------------------------------------------------------ generation

  _hourFactors() {
    const h = new Date().getHours();
    this.hour = h;
    // lit windows: busiest early evening, near-dark at 3 am; the sky follows
    if (h >= 18 && h < 22) return { lit: 1.3, dusk: 0.35 };
    if (h >= 22 || h < 1) return { lit: 1.0, dusk: 0.15 };
    if (h >= 1 && h < 5) return { lit: 0.55, dusk: 0.0 };
    if (h >= 5 && h < 8) return { lit: 0.7, dusk: 0.25 };
    return { lit: 0.8, dusk: 0.45 }; // daytime is a long dusk: the city is always night here
  }

  _generate() {
    // a hidden or absurdly small host (the stage before it is shown) gets nothing
    if (!this.vw || !this.vh || this.vw < 24 || this.groundY < 24) {
      this.layers = null;
      return;
    }
    const { vw, vh, groundY, look } = this;
    const H = groundY;
    const W = vw + 24; // a little wider, so the far layers can drift
    const hf = this._hourFactors();
    const seed = { HEART: 0x5c1, GUT: 0x9a11, HEAD: 0xc170 }[this.regime];
    const rand = rng(seed);
    const k = H / 432; // the game's title runs 432 tall; scale its widths

    // --- sky: gradient + cloud
    const sky = canvas(W, H);
    const sctx = sky.getContext("2d");
    const img = sctx.createImageData(W, H);
    const top = mix(SKY_TOP, look.skyLow, hf.dusk * 0.5);
    const low = mix(look.skyLow, [70, 48, 80], hf.dusk * 0.4);
    const n = 64;
    const cloud = fbm(n, rand);
    for (let y = 0; y < H; y++) {
      const t = Math.pow(y / H, 1.6);
      const fade = Math.max(0, 1 - (y / H) * 1.5);
      for (let x = 0; x < W; x++) {
        const v = cloud[Math.floor((y * n) / H) * n + Math.floor((x * n) / W)];
        const lift = (v - 0.5) * 26 * fade;
        const i = (y * W + x) * 4;
        img.data[i] = clamp(top[0] + (low[0] - top[0]) * t + lift, 0, 255);
        img.data[i + 1] = clamp(top[1] + (low[1] - top[1]) * t + lift, 0, 255);
        img.data[i + 2] = clamp(top[2] + (low[2] - top[2]) * t + lift * 1.2, 0, 255);
        img.data[i + 3] = 255;
      }
    }
    sctx.putImageData(img, 0, 0);

    // --- towers, back to front, each with its own lights
    this.windows = [];
    const layers = { sky };
    for (const name of ["far", "mid", "near"]) {
      const spec = LAYERS[name];
      const solid = canvas(W, H);
      const lit = canvas(W, H);
      const ds = solid.getContext("2d");
      const dl = lit.getContext("2d");
      const wide = [Math.max(6, Math.round(spec.wide[0] * k)), Math.max(10, Math.round(spec.wide[1] * k))];
      let x = -Math.floor(rand() * 30 * k);
      while (x < W) {
        const w = wide[0] + Math.floor(rand() * (wide[1] - wide[0] + 1));
        const h = Math.floor(H * (spec.lo + rand() * (spec.hi - spec.lo)));
        const topY = H - h;
        ds.fillStyle = rgb(spec.fill);
        ds.fillRect(x, topY, w, h);
        ds.fillStyle = rgb(spec.fill.map((c) => Math.min(255, c + 16)));
        ds.fillRect(x, topY, w, 2); // the parapet lip
        this._windows(dl, rand, x, topY, w, h, spec.lit * hf.lit, name, k);
        if (name !== "far" && h > H * 0.55 && rand() < 0.5) {
          const ax = x + 2 + Math.floor(rand() * Math.max(1, w - 4));
          const ah = Math.round((8 + rand() * 18) * k);
          ds.fillStyle = "#000";
          ds.fillRect(ax, topY - ah, 1, ah);
          dl.fillStyle = "rgba(255,70,70,1)";
          dl.fillRect(ax - 1, topY - ah - 1, 2, 2);
        }
        x += w + 1 + Math.floor(rand() * 5);
      }
      if (spec.haze > 0) {
        // Air: distance is lower contrast, not smaller
        ds.globalCompositeOperation = "source-atop";
        ds.fillStyle = rgb(look.skyLow, spec.haze);
        ds.fillRect(0, 0, W, H);
        ds.globalCompositeOperation = "source-over";
      }
      layers[name] = solid;
      layers[name + "Lit"] = lit;
      layers[name + "LitAlpha"] = 1 - spec.haze * 0.75;
    }
    this._props(layers.near.getContext("2d"), layers.nearLit.getContext("2d"), rand, W, H, k);
    this.layers = layers;

    // --- signs: a cool one left, the warm one on the right where she waits, one dim set back.
    // The two near ones hang at her fist height, because she hits them.
    const cx = Math.floor(vw / 2);
    const signH = Math.max(10, Math.round(22 * k));
    const signW = Math.max(18, Math.round(44 * k));
    // Measured on the punch frames: her fist travels at 0.78 of her height.
    const fistY = groundY - Math.round(this.charH * 0.78);
    this.signs = [
      this._sign(rand, Math.round(cx - vw * 0.36 - signW / 2), fistY - Math.round(signH / 2), signW, signH, look.signL, false, 1.0),
      this._sign(rand, Math.round(cx + vw * 0.33 - signW / 2), fistY - Math.round(signH / 2), signW, signH, look.signR, true, 1.0),
      this._sign(rand, Math.round(cx - vw * 0.1), Math.round(groundY - 170 * k), Math.round(signW * 0.6), Math.round(signH * 0.6), look.neon[2], true, 0.45),
    ];
    // --- the lamp post, left of her, and the puddles
    this.lamp = { x: Math.round(cx - vw * 0.22), top: Math.round(groundY - 96 * k), colour: look.lamp };
    this.puddles = [];
    const roadH = vh - groundY;
    for (let i = 0; i < look.puddles; i++) {
      this.puddles.push({
        x: Math.floor(rand() * vw),
        y: groundY + 3 + Math.floor(rand() * Math.max(1, roadH - 6)),
        rx: 4 + Math.floor(rand() * 14),
        ry: 1 + Math.floor(rand() * 3),
        tint: this.signs[i % 2].colour,
      });
    }
    // --- vignette (the game's: inner .22, outer .78, strength .55), round on screen
    const vig = canvas(vw, vh);
    const vimg = vig.getContext("2d").createImageData(vw, vh);
    for (let y = 0; y < vh; y++) {
      for (let x = 0; x < vw; x++) {
        const dx = (x / vw - 0.5);
        const dy = ((y - vh / 2) / vw);
        const r = Math.sqrt(dx * dx + dy * dy) / 0.5;
        const a = clamp((r - 0.22) / (0.78 - 0.22), 0, 1);
        const ss = a * a * (3 - 2 * a);
        const i = (y * vw + x) * 4;
        vimg.data[i + 3] = Math.round(ss * 0.55 * 255);
      }
    }
    vig.getContext("2d").putImageData(vimg, 0, 0);
    this.vignette = vig;
    // --- rain pools
    this._seedRain();
  }

  _windows(dl, rand, x, top, w, h, density, name, k) {
    if (name === "far") return;
    const stepX = Math.max(3, Math.round((name === "mid" ? 6 : 9) * k));
    const stepY = Math.max(4, Math.round((name === "mid" ? 7 : 11) * k));
    const pad = Math.max(1, Math.round(3 * k));
    const cols = [];
    for (let c = x + pad; c < x + w - pad - 1; c += stepX) if (rand() < 0.8) cols.push(c);
    if (!cols.length) return;
    let litRun = 0;
    const H = this.groundY;
    const winW = Math.max(1, stepX - Math.max(1, Math.round(3 * k)));
    const winH = Math.max(1, stepY - Math.max(1, Math.round(4 * k)));
    for (let wy = top + Math.max(3, Math.round(5 * k)); wy < H - 3; wy += stepY) {
      if (litRun <= 0) litRun = (1 + Math.floor(rand() * 3)) * (rand() < density * 3.2 ? 1 : -1);
      const on = litRun > 0;
      litRun -= litRun > 0 ? 1 : -1;
      if (!on) continue;
      if (name === "near" && rand() < 0.1) {
        const col = this.look.neon[Math.floor(rand() * this.look.neon.length)];
        dl.fillStyle = rgb(col, 0.67);
        dl.fillRect(x + pad, wy, w - pad * 2, Math.max(2, stepY - Math.round(6 * k)));
        continue;
      }
      const a = (150 + Math.floor(rand() * 70)) / 255;
      for (const wx of cols) {
        if (rand() < 0.18) continue;
        dl.fillStyle = rgb(this.look.window, a);
        dl.fillRect(wx, wy, winW, winH);
        if (name === "near") this.windows.push({ x: wx, y: wy, w: winW, h: winH });
      }
    }
  }

  /** District dressing on the near masses: pipes, awnings, or glass. */
  _props(ds, dl, rand, W, H, k) {
    const look = this.look;
    if (look.props === "undercity") {
      // pipe runs with brackets, rust and the odd drip mark
      for (const fy of [0.42, 0.58]) {
        const y = Math.round(H - H * fy);
        ds.fillStyle = "rgb(89,40,38)";
        ds.fillRect(0, y, W, 2);
        ds.fillStyle = "rgb(129,85,65)";
        ds.fillRect(0, y, W, 1);
        for (let x = Math.floor(rand() * 12); x < W; x += 14 + Math.floor(rand() * 20)) {
          ds.fillStyle = "rgb(61,48,50)";
          ds.fillRect(x, y - 1, 2, 4);
        }
      }
      // standing water line at the foot of the masses
      ds.fillStyle = "rgba(52,130,194,0.25)";
      ds.fillRect(0, H - 2, W, 2);
    } else if (look.props === "market") {
      // an awning over a doorway and a string of small lamps
      const ay = Math.round(H - 70 * k);
      const ax = Math.round(W * 0.58);
      const aw = Math.round(46 * k);
      for (let i = 0; i < aw; i += 3) {
        ds.fillStyle = i % 6 === 0 ? "rgb(141,15,68)" : "rgb(213,160,85)";
        ds.fillRect(ax + i, ay, 3, 3);
      }
      ds.fillStyle = "rgb(25,23,27)";
      ds.fillRect(ax + 4, ay + 3, aw - 8, Math.round(H - ay - 3)); // the doorway, dark
      for (let x = 6; x < W; x += 9) {
        dl.fillStyle = "rgba(255,179,71,0.9)";
        dl.fillRect(x, Math.round(H - 92 * k), 1, 1);
      }
    } else {
      // glass grid and an overhead walkway with a cold edge
      ds.fillStyle = "rgba(145,218,237,0.10)";
      for (let x = 0; x < W; x += 6) ds.fillRect(x, 0, 1, H);
      for (let y = Math.round(H * 0.3); y < H; y += 8) ds.fillRect(0, y, W, 1);
      const wy = Math.round(H - 104 * k);
      ds.fillStyle = "rgb(30,36,58)";
      ds.fillRect(0, wy, W, 3);
      dl.fillStyle = "rgba(55,230,240,0.8)";
      dl.fillRect(0, wy + 3, W, 1);
    }
  }

  _sign(rand, x, y, w, h, colour, flicker, energy) {
    const face = canvas(w, h);
    const c = face.getContext("2d");
    c.fillStyle = "rgba(6,6,10,0.85)";
    c.fillRect(0, 0, w, h);
    c.fillStyle = rgb(colour, 0.95);
    c.fillRect(0, 0, w, 1);
    c.fillRect(0, h - 1, w, 1);
    c.fillRect(0, 0, 1, h);
    c.fillRect(w - 1, 0, 1, h);
    // glyphs: the language is carried, not read
    let gx = 3;
    while (gx < w - 4) {
      const gw = 2 + Math.floor(rand() * 3);
      const gh = Math.max(3, h - 6);
      const gy = 3 + Math.floor(rand() * Math.max(1, h - 6 - gh + 1));
      c.fillStyle = rgb(colour, 0.9);
      for (let yy = 0; yy < gh; yy++) {
        for (let xx = 0; xx < gw; xx++) if (rand() < 0.55) c.fillRect(gx + xx, gy + yy, 1, 1);
      }
      gx += gw + 2;
    }
    return { x, y, w, h, colour, face, flicker, energy, base: energy, dip: 0, nextDip: 1 + rand() * 3 };
  }

  _seedRain() {
    const area = this.vw * this.vh;
    const per = Math.max(10, Math.round(area / 720));
    for (let i = 0; i < 3; i++) {
      const count = Math.round(per * (0.55 + 0.3 * i));
      const arr = [];
      for (let j = 0; j < count; j++) arr.push(this._drop(i, true));
      this.streaks[i] = arr;
    }
  }

  _drop(layer, anywhere) {
    return {
      x: Math.random() * (this.vw + 40) - 20,
      y: anywhere ? Math.random() * this.vh : -8 - Math.random() * 20,
      len: Math.round(3 + layer * 1.5 + Math.random() * 3),
      v: 120 + layer * 55 + Math.random() * 30,
    };
  }

  // ------------------------------------------------------------ update

  update(dt) {
    this.t += dt;
    if (!this.enabled) return;
    if (new Date().getHours() !== this.hour) this._generate();
    // the storm follows her mood, eases in; now and then a gust becomes a downpour
    this.nextGust -= dt;
    if (this.nextGust <= 0) {
      this.gustUntil = this.t + 8 + Math.random() * 14;
      this.nextGust = 25 + Math.random() * 60;
    }
    const gustWant = this.gustsOn && this.t < this.gustUntil ? 1.7 : 1;
    this.gust += (gustWant - this.gust) * Math.min(1, dt * 0.35);
    const base = this.moodRain[this.mood] ?? 0.75;
    const stateK = { listening: 0.8, asleep: 0.6, error: 1.3, idle_long: 0.95 }[this.state] ?? 1;
    const want = this.storm && this.rainOn ? clamp(base * this.look.rainK * stateK * this.gust, 0.08, 1.6) : 0;
    this.rain += (want - this.rain) * Math.min(1, dt * 0.5);
    // the lamp comes up when she listens
    const lampWant = this.state === "listening" ? 1.35 + this.listen * 0.4 : this.state === "asleep" ? 0.6 : 1;
    this.lampK += (lampWant - this.lampK) * Math.min(1, dt * 3);
    // rain
    for (let i = 0; i < 3; i++) {
      const arr = this.streaks[i];
      const active = Math.round(arr.length * clamp(this.rain, 0, 1.6) / 1.6);
      for (let j = 0; j < arr.length; j++) {
        const d = arr[j];
        if (j >= active) continue;
        d.y += d.v * dt;
        d.x += d.v * 0.18 * dt;
        const floor = i === 2 ? this.vh + 4 : this.groundY + (i === 1 ? 2 : -6);
        if (d.y - d.len > floor) {
          if (i >= 1 && d.x >= 0 && d.x < this.vw && Math.random() < 0.6) this.splashes.push({ x: Math.round(d.x), y: this.groundY, t: 0 });
          Object.assign(d, this._drop(i, false));
        }
        if (d.x > this.vw + 20) d.x -= this.vw + 40;
      }
    }
    for (const s of this.splashes) s.t += dt;
    this.splashes = this.splashes.filter((s) => s.t < 0.14);
    if (this.puddles.length && Math.random() < dt * this.rain * 7) {
      const p = this.puddles[Math.floor(Math.random() * this.puddles.length)];
      this.ripples.push({ x: p.x + Math.round((Math.random() - 0.5) * p.rx), y: p.y, r: 0, t: 0 });
    }
    for (const r of this.ripples) {
      r.t += dt;
      r.r = r.t * 9;
    }
    this.ripples = this.ripples.filter((r) => r.t < 0.7);
    // lightning: rarer when calm, and she can call one down (error)
    if (this.flashT >= 0) {
      this.flashT += dt;
      if (this.flashT > 1.1) this.flashT = -1;
    }
    if (this.storm && this.lightningOn) this.nextStrike -= dt * (0.5 + this.rain);
    if (this.nextStrike <= 0) {
      this.strike(Math.random() * Math.random());
      this.nextStrike = 10 + Math.random() * 30;
    }
    // signs: flicker on the ones that flicker, more when she thinks; the warm one follows her voice;
    // a hit one flares, then sputters for a while
    for (const s of this.signs) {
      const damaged = s.damagedUntil != null && this.t < s.damagedUntil;
      if (s.flicker || damaged) {
        s.nextDip -= dt * (damaged ? 3.5 : this.state === "thinking" ? 2.2 : 1);
        if (s.nextDip <= 0) {
          s.dip = 0.08 + Math.random() * (damaged ? 0.25 : 0.1);
          s.nextDip = (damaged ? 0.3 : 0.9) + Math.random() * 3.2;
        }
      }
      if (s.dip > 0) s.dip -= dt;
      s.energy = s.base * (s.dip > 0 ? 0.35 : 1) * (damaged ? 0.85 : 1);
      if (s.hit) {
        s.hit.t += dt;
        if (s.hit.t < 0.15) s.energy = 1.9;
        else if (s.hit.t < 1.4) s.energy *= 0.3 + Math.random() * 1.3;
        else s.hit = null;
      }
    }
    if (this.signs[1]) this.signs[1].energy *= 1 + this.voice * 0.6;
    // sparks off a hit sign
    for (const p of this.sparks) {
      p.t += dt;
      p.vy += 200 * dt;
      p.x += p.vx * dt;
      p.y += p.vy * dt;
    }
    this.sparks = this.sparks.filter((p) => p.t < p.life && p.y < this.groundY + 6);
    if (this.shake > 0) this.shake -= dt;
    // one window blinks now and then
    this.nextBlink -= dt;
    if (this.nextBlink <= 0 && this.windows.length) {
      this.blinkWin = { w: this.windows[Math.floor(Math.random() * this.windows.length)], t: 0.6 };
      this.nextBlink = 1.5 + Math.random() * 4;
    }
    if (this.blinkWin && (this.blinkWin.t -= dt) <= 0) this.blinkWin = null;
  }

  // ------------------------------------------------------------ drawing

  /** Everything behind her. */
  drawBack(ctx) {
    const { vw, vh, groundY } = this;
    if (!this.enabled || !this.layers) {
      ctx.fillStyle = "#0c0d1d";
      ctx.fillRect(0, 0, vw, vh);
      ctx.fillStyle = "#121427";
      ctx.fillRect(0, Math.max(0, groundY), vw, Math.max(0, vh - groundY));
      return;
    }
    const L = this.layers;
    const driftFar = Math.round(Math.sin(this.t / 26 * Math.PI) * 9);
    const driftMid = Math.round(Math.sin(this.t / 26 * Math.PI + 1) * 5);
    ctx.drawImage(L.sky, -12, 0);
    ctx.drawImage(L.far, -12 + driftFar, 0);
    ctx.drawImage(L.mid, -12 + driftMid, 0);
    ctx.drawImage(L.near, -12, 0);
    // the lights, additively, so a flash lifts the masses and not the windows
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    ctx.globalAlpha = L.midLitAlpha * 0.9;
    ctx.drawImage(L.midLit, -12 + driftMid, 0);
    ctx.globalAlpha = 1;
    ctx.drawImage(L.nearLit, -12, 0);
    ctx.restore();
    if (this.blinkWin) {
      const w = this.blinkWin.w;
      ctx.fillStyle = "rgba(3,3,7,0.9)";
      ctx.fillRect(w.x - 12, w.y, w.w, w.h);
    }
    // signs and their pools; a hit one shakes and tears into slices
    for (const s of this.signs) {
      let ox = 0;
      let oy = 0;
      let tear = 0;
      if (s.hit) {
        const d = Math.max(0, 1 - s.hit.t / 0.9);
        ox = Math.round(Math.sin(s.hit.t * 55) * 3 * d);
        oy = Math.round(Math.cos(s.hit.t * 41) * 2 * d);
        tear = d;
      }
      s.ox = ox;
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(s.x + ox + s.w / 2, s.y + oy + s.h / 2, 1, s.x + ox + s.w / 2, s.y + oy + s.h / 2, s.w * 0.9);
      g.addColorStop(0, rgb(s.colour, Math.min(0.6, 0.28 * s.energy)));
      g.addColorStop(1, rgb(s.colour, 0));
      ctx.fillStyle = g;
      ctx.fillRect(s.x + ox - s.w, s.y + oy - s.w, s.w * 3, s.w * 2 + s.h);
      ctx.restore();
      ctx.globalAlpha = 0.55 + 0.45 * clamp(s.energy, 0, 1);
      if (tear > 0 && Math.random() < 0.75) {
        const slices = 3;
        const sh = Math.ceil(s.h / slices);
        for (let i = 0; i < slices; i++) {
          const off = Math.round((Math.random() - 0.5) * 5 * tear);
          const y0 = i * sh;
          const hh = Math.min(sh, s.h - y0);
          if (hh <= 0) continue;
          ctx.drawImage(s.face, 0, y0, s.w, hh, s.x + ox + off, s.y + oy + y0, s.w, hh);
          if (Math.random() < 0.3) {
            ctx.save();
            ctx.globalCompositeOperation = "lighter";
            ctx.fillStyle = rgb(s.colour, 0.5 * tear);
            ctx.fillRect(s.x + ox + off, s.y + oy + y0, s.w, hh);
            ctx.restore();
          }
        }
      } else {
        ctx.drawImage(s.face, s.x + ox, s.y + oy);
      }
      ctx.globalAlpha = 1;
    }
    // the lamp post and its light
    const lp = this.lamp;
    if (lp) {
      ctx.fillStyle = "rgb(30,36,58)";
      ctx.fillRect(lp.x, lp.top, 1, groundY - lp.top);
      ctx.fillRect(lp.x - 2, lp.top, 5, 2);
      ctx.save();
      ctx.globalCompositeOperation = "lighter";
      const g = ctx.createRadialGradient(lp.x, lp.top + 2, 0, lp.x, lp.top + 2, 36);
      g.addColorStop(0, rgb(lp.colour, 0.55 * this.lampK));
      g.addColorStop(1, rgb(lp.colour, 0));
      ctx.fillStyle = g;
      ctx.fillRect(lp.x - 36, lp.top - 36, 72, 72);
      ctx.restore();
    }
    // pavement and the wet road
    ctx.fillStyle = "rgb(30,32,50)";
    ctx.fillRect(0, groundY, vw, 5);
    ctx.fillStyle = "rgb(48,52,74)";
    ctx.fillRect(0, groundY, vw, 1);
    ctx.fillStyle = "rgb(14,15,28)";
    ctx.fillRect(0, groundY + 5, vw, vh - groundY - 5);
    // pools of light on the ground: the signs' and the lamp's
    ctx.save();
    ctx.globalCompositeOperation = "lighter";
    for (const s of this.signs) {
      const g = ctx.createRadialGradient(s.x + s.w / 2, groundY + 4, 0, s.x + s.w / 2, groundY + 4, s.w * 1.2);
      g.addColorStop(0, rgb(s.colour, 0.16 * s.energy));
      g.addColorStop(1, rgb(s.colour, 0));
      ctx.fillStyle = g;
      ctx.fillRect(s.x - s.w * 1.5, groundY, s.w * 4, vh - groundY);
    }
    if (lp) {
      const g = ctx.createRadialGradient(lp.x, groundY + 3, 0, lp.x, groundY + 3, 30);
      g.addColorStop(0, rgb(lp.colour, 0.22 * this.lampK));
      g.addColorStop(1, rgb(lp.colour, 0));
      ctx.fillStyle = g;
      ctx.fillRect(lp.x - 30, groundY, 60, vh - groundY);
    }
    ctx.restore();
    // puddles, reflections, ripples
    for (const p of this.puddles) {
      ctx.fillStyle = rgb(mix(this.look.skyLow, p.tint, 0.35), 0.5);
      ctx.beginPath();
      ctx.ellipse(p.x, p.y, p.rx, p.ry, 0, 0, Math.PI * 2);
      ctx.fill();
    }
    const wob = Math.round(Math.sin(this.t * 2.1) * 1.5);
    for (const s of this.signs) {
      const rh = Math.min(s.h, vh - groundY - 2);
      ctx.save();
      ctx.globalAlpha = 0.18 * clamp(s.energy, 0, 1);
      ctx.translate(s.x + wob + (s.ox || 0), groundY + 6 + rh);
      ctx.scale(1, -1);
      ctx.drawImage(s.face, 0, 0, s.w, rh, 0, 0, s.w, rh);
      ctx.restore();
    }
    ctx.strokeStyle = "rgba(145,218,237,0.35)";
    ctx.lineWidth = 1;
    for (const r of this.ripples) {
      ctx.globalAlpha = 1 - r.t / 0.7;
      ctx.beginPath();
      ctx.ellipse(r.x, r.y, r.r, r.r * 0.4, 0, 0, Math.PI * 2);
      ctx.stroke();
    }
    ctx.globalAlpha = 1;
  }

  /** Everything in front of her: the weather, the tint, the flash, the edges. */
  drawFront(ctx) {
    const { vw, vh } = this;
    if (!this.enabled || !this.layers) return;
    // rain: three depths, slanted, bright heads leading downward
    for (let i = 0; i < 3; i++) {
      const arr = this.streaks[i];
      const active = Math.round(arr.length * clamp(this.rain, 0, 1.6) / 1.6);
      const a = 0.26 * (0.6 + i * 0.34) * clamp(0.45 + this.rain * 0.6, 0.35, 1.1);
      const tail = rgb(STREAK, a * 0.55);
      const head = rgb(mix(STREAK, [255, 255, 255], 0.35), a);
      for (let j = 0; j < active; j++) {
        const d = arr[j];
        for (let q = 0; q < d.len; q++) {
          const py = Math.round(d.y - q);
          const px = Math.round(d.x - q * 0.26);
          if (py < 0 || py >= vh || px < 0 || px >= vw) continue;
          ctx.fillStyle = q === 0 ? head : tail;
          ctx.fillRect(px, py, 1, 1);
        }
      }
    }
    ctx.fillStyle = rgb(STREAK, 0.6);
    for (const s of this.splashes) {
      const k = s.t < 0.07 ? 1 : 2;
      ctx.fillRect(s.x, s.y - 1, 1, 1);
      ctx.fillRect(s.x - k, s.y - 2, 1, 1);
      ctx.fillRect(s.x + k, s.y - 2, 1, 1);
    }
    // sparks off a punched sign: white first, then the sign's own colour, then gone
    for (const p of this.sparks) {
      const age = p.t / p.life;
      ctx.fillStyle = p.white && age < 0.4 ? `rgba(255,255,255,${(1 - age).toFixed(2)})` : rgb(p.colour, 1 - age);
      ctx.fillRect(Math.round(p.x), Math.round(p.y), 1, 1);
    }
    // the district tint (look-dev §3), over everything, gently
    ctx.save();
    ctx.globalCompositeOperation = "multiply";
    ctx.fillStyle = rgb(this.look.tint, 0.32);
    ctx.fillRect(0, 0, vw, vh);
    ctx.restore();
    // lightning: the title card's double flash
    if (this.flashT >= 0) {
      const peak = 0.06 + 0.2 * this.flashNear;
      const t = this.flashT;
      let a;
      if (t < 0.04) a = peak * (t / 0.04);
      else if (t < 0.13) a = peak * (1 - 0.75 * ((t - 0.04) / 0.09));
      else if (t < 0.18) a = peak * (0.25 + 0.6 * ((t - 0.13) / 0.05));
      else {
        const fade = 0.55 + 0.4 * this.flashNear;
        a = peak * 0.85 * Math.max(0, 1 - (t - 0.18) / fade);
      }
      ctx.fillStyle = `rgba(209,230,255,${a.toFixed(3)})`;
      ctx.fillRect(0, 0, vw, vh);
    }
    if (this.vignette) ctx.drawImage(this.vignette, 0, 0);
  }
}

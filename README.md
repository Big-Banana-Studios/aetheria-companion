# Aetheria Companion · Mira

A voice companion that runs entirely in the phone's browser. You talk; Mira,
the courier from *Paperless*, off duty, listens, thinks, and answers out loud
in one voice. No backend, no keys, works offline after the first load.

- **Brain:** Gemma 4 E2B (`onnx-community/gemma-4-E2B-it-ONNX`, Apache-2.0)
  on WebGPU via Transformers.js. Your recorded utterance goes in as audio; a
  camera still goes in as an image. One model does hearing, seeing and talking.
- **Voice:** Kokoro-82M (`kokoro-js`), one pinned voice (Nicole by default), streamed per sentence.
- **Ears:** Silero VAD, running all the time so you can interrupt her.
- **Face:** the courier's own sprites from the game, on a canvas, with the
  stone aura ported from `aura.gd`.

## Run it

```
npm install
npm run dev          # http://localhost:5173 (also on the LAN with --host)
npm run build        # static site in dist/
```

Deploy: push to `main` and the workflow in `.github/workflows/deploy.yml`
publishes `dist/` to GitHub Pages under `/<repo>/`. The live site is
https://big-banana-studios.github.io/aetheria-companion/ . For a custom
domain set `BASE_PATH=/` (or leave it unset) when building.

The first launch downloads the models into the browser's Cache API. Later
launches read from the cache and need no network. Give the site persistent
storage when Chrome asks, or it may evict the cache when the phone is low on
space.

Nothing is fetched from a CDN: the ONNX Runtime WASM files (about 23 MB)
are copied from `node_modules` into `public/ort/` by `npm install` and
`npm run build` (`tools/copy_ort.mjs`) and every worker is pointed at them
(`src/workers/ort-paths.js`), so the version always matches the bundled
runtime and the whole app is served from one origin.

`npm run check` runs two Node-only checks that need no GPU: the Transformers.js
API and chat-template continuation test, and the VAD worker driven with a real
speech clip (hands-free segmentation, barge-in gating, push-to-talk).

## Browser requirements

| | |
|---|---|
| WebGPU | required for the model. Chrome 121+ on Android, Chrome/Edge on desktop. Safari 18+ with WebGPU on may work; untested. |
| `shader-f16` | used if present (`q4f16` files). Without it the app falls back to `q4` (about 15% larger). |
| RAM | the full brain wants roughly 4 GB free. The ROG Phone's 24 GB is plenty; 8 GB phones should pick the light brain. |
| Storage | see sizes below; Chrome allows a site a large share of free disk. |
| Mic, camera | asked for on start / when you press ◉. Everything stays on the device. |

Kokoro runs on WebGPU in fp32 (its WebGPU path needs fp32) and falls back to
WASM/q8. Silero runs on WASM. Neither needs WebGPU, but the LLM does.

## Model sizes (downloaded once)

| Brain | Files | Size |
|---|---|---|
| **On-device, full** | Gemma 4 E2B q4f16: decoder 1.52 GB, embeddings 1.59 GB, audio encoder 171 MB, vision encoder 99 MB, tokenizer 19 MB; Moonshine-tiny ≈ 80 MB for transcripts | **≈ 3.5 GB** (q4: ≈ 4.0 GB) |
| **On-device, light** | LFM2.5-2.6B q4f16 1.53 GB + Moonshine-tiny ≈ 80 MB | ≈ 1.6 GB |
| **Lab mode** | Moonshine-tiny only | ≈ 80 MB |
| Voice | Kokoro-82M fp32 (WebGPU) 326 MB, or q8 (WASM) 92 MB; each voice ≈ 0.5 MB | ≈ 330 MB |
| Ears | Silero VAD | 2.3 MB |

The brief estimated 2–3 GB for the model; the published q4f16 export is 3.4 GB
because Gemma 4's per-layer embeddings are large even quantized.

## How a turn works

```
mic 16 kHz ─► AudioWorklet (512-sample chunks) ─► VAD worker (Silero)
                                                     │ speech end
                                                     ▼
               model worker (Gemma 4 E2B, WebGPU) ◄── Float32 utterance (+ still)
                 │ token stream
                 ▼
               main thread: strip [mood] tag, split into sentences
                 │ sentence
                 ▼
               TTS worker (Kokoro) ─► Float32 24 kHz ─► AudioWorklet queue ─► speaker
                                                            │ AnalyserNode RMS
                                                            ▼
                                                     sprite mouth + nods + aura pulses
barge-in: VAD fires during playback ─► abort generation, cancel TTS, flush queue, flinch, listen
```

The model's KV cache is carried across turns. Each new turn is rendered as a
hand-built continuation of the chat template (verified token-for-token
against a full render in `tools/smoke_api.mjs`), so only the new audio is
encoded and nothing is re-prefilled. The conversation is also kept as text
(the last 40 turns, in `localStorage`, never audio) and used to re-prime a
fresh context after a reload, a persona change, or when the context passes
about 6 000 tokens.

The transcript strip follows her voice, not the token stream: a sentence
appears the moment its audio starts, the generated-but-unspoken remainder
shows faint, and if you interrupt her the memory keeps only what she
actually got out.

### Latency targets

Goal on the phone: first audio ≤ 1.5 s after you stop talking, with sentence
two synthesizing while sentence one plays. Tap **ms** in the top bar (or open
with `?debug`) for the overlay:

```
vad→sent    audio handed to the model
→tok        first token
→sent1      first full sentence handed to TTS
→tts        first synthesized chunk back
→AUDIBLE    that chunk started playing   ← the number that matters
done        generation finished, tok/s
```

**If the GPU goes away** (Windows resets a GPU that runs a kernel too long,
a driver hiccups, Chrome's GPU process restarts), each worker notices on
its next run, rebuilds its sessions from the browser cache, and retries;
you see "the GPU reset; bringing her back…" and about 20 s of thinking on
a PC. A turn that fails twice for any reason gets the same rebuild.
`npm run test:pc -- --gpucrash` exercises it.

Levers if it is slow: shorter first sentences (the persona already asks for
them), `q4` vs `q4f16`, Kokoro on WASM if the GPU is contended, and the
"creative sampling" toggle off (greedy is a little faster).

Measured on a laptop with an RTX 4090 Laptop GPU (Chrome, dev server, models
cached), full brain, q4f16:

| | first token | first audio | decode |
|---|---|---|---|
| spoken turn (5 s of audio) | 1.2–1.9 s | 2.6–4.0 s | 9–10 tok/s |
| text-only turn | 1.0 s | 2.6 s | 7.6 tok/s |

Load from cache took 28 s; the first download of 3.7 GB took about 2.5 min.
The Moonshine transcript of the user's words landed 0.4–0.9 s after the
utterance ended.

**Laptops with two GPUs:** Chrome will happily run WebGPU on the integrated
one, which was half the speed here. Force the discrete GPU in Windows
Settings → System → Display → Graphics → add Chrome → High performance (the
test scripts pass `--force_high_performance_gpu`). The overlay's adapter
line, or `?debug`, tells you which one you got.

Because the model hears the audio directly, the words you said are
transcribed separately by Moonshine-tiny (a fourth worker, in parallel with
the reply) for the transcript strip and the memory. An earlier version asked
the model to append its own transcript; the E2B model ignored the rule.

### Testing on a PC

```
npm run test:pc      # the whole pipeline in your Chrome, on your GPU, with a fake mic
npm run pc           # open the app in that same Chrome profile with your real mic
```

`test:pc` starts the dev server, opens Chrome with a dedicated profile (so the
models are downloaded once and reused), feeds a public-domain speech clip
through Chrome's fake microphone on a loop, clicks Start, waits through the
download, injects the clip straight into the pipeline, then waits for the
fake mic to trigger a natural voice-activity turn and a text-only turn, and
prints the replies, the transcripts, the latency overlay and any console
errors. `--brain=text|lab` and `--devices=embed_tokens:wasm` (per-session
device experiments) are accepted; `--keep` leaves Chrome and the server up.

## Using it

- **Hands-free** is the default: she listens all the time. Tap the big
  button to pause listening; tap it while she talks to stop her.
- **Push to talk** (Settings → Listening) for noisy rooms: hold the button.
- **Interrupting:** just talk over her. During playback the VAD needs a
  louder, longer onset (about 130 ms above a higher threshold) so her own
  voice through the speaker does not trigger it. If it still does, turn
  "let me interrupt" off, or use push to talk.
- **Camera:** ◉ opens the front camera as a small circle. Tap it (or the
  `look` pill) to attach the current frame to your next turn, or just tell
  her to look: the model replies with a `[look]` tag, the app grabs a still
  and asks again. One still per request; frames are never streamed. Only the
  full brain can see.
- **The district follows the conversation.** Each reply also carries a
  depth tag: `[small]` for chit-chat puts her in the Street Market (HEART),
  `[mid]` for the personal and practical in the Undercity (GUT), `[deep]`
  for the big questions in the Stack (HEAD). When the depth changes she
  walks off the edge towards the new district (the Undercity is down the
  street to the left, the Stack up to the right), the street regenerates
  while she is out of sight, she walks back in to the middle, and only then
  does the reply play; the speech synthesized during the walk is held, not
  lost. Interrupting her mid-walk puts her back in the middle with the
  street unchanged. Picking a district in Settings pins it: when you press
  Done she walks there the same way, and the next turn carries a note
  telling the model which register to take (the Market keeps it light, the
  Undercity gets personal with a little grit, the Stack goes for the big
  questions). Settings can also follow the Aetheria Reader's last frequency
  when the Reader is served from the same origin
  (`aetheria_checkpoint.selectedFrequency` in `localStorage`).
- **Replies with something in them.** The persona asks for three to six
  sentences that meet the concrete thing you said and add something of her
  own, with a worked example (a fresh coffee and a smoke break). Sampling
  is on by default at a moderate temperature (0.75, top-k 50, top-p 0.9);
  greedy decoding kept her generic. If her last reply was under about
  fifteen words, the next turn carries a note asking for a fuller one.
  Measured: to "just made a fresh coffee, stepping out for a smoke, long
  day" she now answers "The first sip warms the cold. Those ten minutes feel
  like they stretch forever. It shows how much the day weighs on you."
- **She asks back, but does not interview.** The app keeps score of whether
  her last reply ended in a question and tells her, turn by turn, whether
  one is welcome: never two running, and usually not; a small model told
  "about half the time" asks every time.
- **She speaks up herself.** After 45–90 s of quiet she says something
  unprompted, then again every 2–4 minutes, and gives up after three with no
  answer. Half the time it is one of the courier's own smoke-break thoughts
  from the game, spoken straight in her voice while she takes a drag (the
  model is told afterwards what she said); otherwise the model is asked for
  a line of its own tied to the conversation, with no question in it. Off
  in Settings if you would rather she waited.
- **Quiet rooms.** The captured utterance is peak-normalized (up to 8×)
  before Gemma and Moonshine hear it, so speech kept low for someone
  sleeping nearby still transcribes. Settings → Transcripts switches to
  Moonshine base, which is more accurate on quiet speech at the cost of a
  bigger download.
- **The street:** she stands on a wet street at night, a runtime port of the
  game's title-card city (`tools/make_skyline.py`): sky and cloud, three
  depths of towers with lit windows drawn additively, neon signs with the
  game's flicker, a lamp post, puddles with reflections, the rain shader's
  three layers with bright heads, the title card's double-flash lightning,
  the district tint and the vignette. It adapts: the **regime** picks the
  palette and props (GUT: pipes and standing water; HEART: an awning and
  string lamps; HEAD: glass grid and a walkway, and it barely rains); the
  **hour** sets the sky and how many windows are lit; her **mood** sets the
  storm; **listening** brings the lamp up; her **voice** pulses the rose
  sign. Switch it off in Settings if you want a plain ground.
- **Moods and gestures:** the model prefixes each reply with one of ten
  tags (`[calm] [happy] [curious] [concerned] [amused] [excited] [annoyed]
  [sassy] [tired] [thoughtful]`); stripped before speech. Each mood sets the
  aura, the rain, and a gesture played as her voice starts: happy jumps,
  excited dashes across and back, annoyed throws a punch, concerned reaches
  out (the resonate pose), curious leans to look, tired kneels, amused
  bounces, thoughtful takes a drag (at least three puffs, and for as long as
  her turn lasts). **Sassy** walks her over to the nearer
  neon sign at her own walking speed, lines her up, and lands the side punch
  on its contact frame: the sign flares, shakes, tears into offset slices,
  sheds sparks, the screen jolts a pixel, and the sign sputters for a few
  seconds after. Then she walks back.
- **The aura and her voice:** while she speaks the rings swell and brighten
  with the output level, a radiant band outside the inner ring flares with
  each syllable, and each syllable onset throws an expanding ring; sentence
  starts still nod her head. Situations have gestures too: she runs in from
  the left when the app starts, opens her arms when you have been talking
  for a while, paces or looks up at the rain while she thinks, glances
  about when idle, flinches when interrupted, is startled awake from a nap,
  and drops after a flinch (with a lightning strike) on a model error. The
  whole table lives in `courier.json` (`moods`, `gestures`, `states`) and
  is edited there, not in code.
- **Smoke breaks and naps:** after 90 s of quiet she sits down for a smoke
  and looks around (all four drawn directions plus mirrors); if the quiet
  goes on another four minutes she lies down and sleeps, facing whichever
  way. Any speech wakes her. Both under one switch in Settings.
- **Home screen:** the page ships a web manifest and icons cut from Mira's
  portrait, so Chrome's "Add to Home screen" gives a full-screen portrait app.
- **Settings:** voice and speed, mic sensitivity, listening mode, barge-in,
  persona editor (the default lives in `persona.md`), aura regime, clear
  memory, delete models.

## Lab mode

Settings → Lab mode (or the third option on the first screen) swaps the
on-device model for `POST <endpoint>` with an OpenAI-style streaming
`chat/completions` body, e.g. the home LiteLLM box fronting gpt-oss-20b.
Moonshine still transcribes locally, Kokoro still speaks locally, the
courier is unchanged.

Two practical notes:
- a page served over **https** (GitHub Pages) cannot call a plain **http**
  LAN endpoint. Either run the app from a local http server on the same
  network (`npm run dev -- --host`, or `python -m http.server` in `dist/`),
  or put LiteLLM behind https.
- LiteLLM must allow the app's origin (CORS). `--cors` or the equivalent
  proxy setting.

## Layout

```
index.html              the three screens (gate, stage, settings)
persona.md              the default system prompt: the courier's voice
src/main.js             boot, WebGPU check, download screen, UI wiring
src/companion.js        the turn: VAD → model → sentences → TTS → speaker
src/workers/vad.worker.js   Silero VAD, speech start/end, push-to-talk, barge-in gating
src/workers/llm.worker.js   Gemma 4 (audio+image, cached KV) · LFM2.5 + Moonshine · Moonshine for lab
src/workers/stt.worker.js   Moonshine-tiny transcripts alongside the full brain
src/workers/tts.worker.js   Kokoro (default) / KittenTTS nano (experimental fallback)
tools/pc_test.mjs       the whole pipeline in Chrome with a fake mic (`npm run test:pc`)
tools/pc.mjs            open the app in that Chrome profile with a real mic (`npm run pc`)
tools/cdp.mjs           the small DevTools-protocol client the tools share
src/audio/              mic capture worklet, playback queue worklet, analysers
src/sprite/renderer.js  Mira: virtual pixel screen, states, gestures, aura, mouth, blink, particles, reflection
src/scene/scene.js      the street: skyline port, rain, lightning, signs, lamp, puddles, tint, vignette
src/splitter.js         streaming sentence splitter
src/settings.js         settings + Reader regime lookup
src/memory.js           last 40 turns as text
src/thoughts.js         the courier's smoke-break thoughts, for when it has been quiet
src/debug.js            timings + overlay
src/lab.js              streaming chat completions client
tools/build_sprites.py  cuts the atlas + manifest from the courier packs (`npm run sprites`)
tools/copy_ort.mjs      copies the ONNX Runtime WASM into public/ort/ (postinstall, prebuild)
tools/smoke_api.mjs     Node check of the Transformers.js APIs and the continuation-turn tokenization
tools/smoke_vad.mjs     Node check of the VAD worker with a real speech clip
public/assets/sprites/courier/   courier.png, courier.json
public/assets/          mira-portrait.png (visor off, background keyed out), icon-192/512.png
public/manifest.webmanifest
```

The sprite atlas is built from two packs beside this folder:
`../top-down-bagless-courier-spritesheet` (idle, walk, resonate, hurt, smoke)
and `../the Courier sleep` (lying down, five directions). See
`SPRITE_GUIDE.md` for the state → clip map and what art is still missing.

`tools/smoke_api.mjs` runs in Node without WebGPU (VAD on CPU, processor
only) and is the quickest way to confirm a Transformers.js upgrade still
speaks the same chat template.

### Working on the scene without a download

Open the app with `?stage` and it skips the models and the GPU probe and
shows the street with Mira on it. Options, combinable:
`regime=GUT|HEART|HEAD`, `state=idle|listening|thinking|speaking|idle_long|asleep|error`,
`mood=<tag>` (played as a reaction), `gesture=<name>`, `noenter`,
`demo` (cycles states and moods on a timer), `scene=0`.

`node tools/screenshots.mjs` (after a build) drives headless Chrome through
the DevTools protocol and writes phone-sized PNGs of a set of those URLs
into `shots/`, several per page at chosen times (`"stage&mood=excited@1150,1500"`),
so a gesture can be checked mid-flight. It is how the scene in this repo was
tuned.

## Credits

Gemma 4 (Google DeepMind, Apache-2.0 via the ONNX community export),
Kokoro-82M (hexgrad, Apache-2.0), Silero VAD (MIT), Moonshine (Useful
Sensors, MIT), LFM2.5 (Liquid AI, LFM open license), Transformers.js
(Hugging Face). Reference architecture: `webml-community/conversational-webgpu`.
Courier art from *Paperless, The Forgotten Courier*. MIT.

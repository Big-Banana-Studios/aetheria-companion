# Aetheria Companion · Mira

A voice companion that runs entirely in the phone's browser. You talk; Mira,
the courier from *Paperless*, off duty, listens, thinks, and answers out loud
in one voice. No backend, no keys, works offline after the first load. Or,
when the box at home is awake, she borrows its brain: the same voice, the
same street, a much bigger model.

- **Brain:** Gemma 4 E2B (`onnx-community/gemma-4-E2B-it-ONNX`, Apache-2.0)
  on WebGPU via Transformers.js. Your recorded utterance goes in as audio; a
  camera still goes in as an image. One model does hearing, seeing and talking.
  Two more brains answer over HTTP, with Moonshine transcribing here: the
  **lab** (the Qwen instance on the Olares, LiteLLM, any OpenAI-compatible
  endpoint) and **a server on this device** (the Aetheria Workbench app's
  llama.cpp runtime on the phone, or llama-server / LM Studio / Ollama on a
  PC). See "The network brains" below.
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

`npm run check` runs three Node-only checks that need no GPU: the Transformers.js
API and chat-template continuation test, the VAD worker driven with a real
speech clip (hands-free segmentation, barge-in gating, push-to-talk), and the
network-brain client against a fake endpoint (endpoint normalisation, the
thinking switch, reasoning stripped before speech; `tools/smoke_lab.mjs`).

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
| **Lab**, or **a server on this device** | Moonshine-tiny only | ≈ 80 MB |
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

**Phones quip.** Android's GPU has a hang watchdog, and a five-sentence
reply with sampling on, synthesized alongside, is a long enough burst to
trip it (seen on the ROG Phone as a lost WebGPU device). So on a phone she
answers in two or three sentences with a hard cap of 110 generated tokens;
on a PC she gets the full three to six. Settings → Reply length overrides
either way, and "Voice runs on: CPU" takes the second-heaviest load off the
phone's GPU if losses continue, at the cost of slower speech.

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

`test:pc` starts the dev server (or reuses one already on the port), opens
Chrome with a dedicated profile (so the models are downloaded once and
reused), feeds a public-domain speech clip through Chrome's fake microphone
on a loop, clicks Start, waits through the download, injects the clip
straight into the pipeline, then waits for the fake mic to trigger a natural
voice-activity turn and a text-only turn, and prints the replies, the
transcripts, the latency overlay and any console errors. `--brain=text|lab|local`
and `--devices=embed_tokens:wasm` (per-session device experiments) are
accepted; `--keep` leaves Chrome and the server up.

```
npm run test:lab     # the lab brain, end to end, against tools/fake_lab.mjs
npm run test:local   # the same over "a server on this device"
```

These start a fake OpenAI-compatible endpoint that behaves like a Qwen behind
llama.cpp with thinking left on (it streams `reasoning_content` and an inline
`<think>` block before the reply), point the brain at it, and check what
arrived on the wire (the thinking switch, `/no_think`, the key, the model
picked from `/v1/models`, the persona and its framing) and what reached the
screen (no reasoning, no tags, the depth tag walked her to the Undercity).
`npm run fakelab` runs the endpoint on its own on `http://127.0.0.1:4321/v1`
for trying the gate by hand.

## Using it

- **Hands-free** is the default: she listens all the time. Tap the big
  button to pause listening; tap it while she talks to stop her.
- **Push to talk** (Settings → Listening) for noisy rooms: hold the button.
- **Typing:** the ⌨ button in the footer swaps the talk button for a text
  box. The mic pauses while the box is up (a phone's keyboard clicks would
  wake the VAD); Enter or ↑ sends, an empty send while she talks stops her,
  and ⌨ again brings the talk button and the listening back. A camera
  still attached with ◉ rides along with a typed line too. Remembered
  across launches.
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
- **Strolls, smoke breaks and naps:** left alone for 35–70 s she paces the
  whole stage, edge to edge at an easy gait, about half the time stopping
  partway for a few puffs facing the way she was going, a look back at you
  or up at the rain at each edge, then back to the middle; no two strolls
  are the same. After 90 s of quiet she sits down for a smoke and looks
  around (all four drawn directions plus mirrors), getting up now and then
  to pace again; if the quiet goes on another four minutes she lies down
  and sleeps, facing whichever way. Any speech wakes her. The smoke break
  and the nap are under one switch in Settings. She stands on the street
  itself, a little past halfway down the road, not on the building line.
- **Ambience.** A generative cyberpunk synth bed, made of Web Audio nodes
  only (nothing to download): three detuned-saw pad voices through a
  breathing low-pass, a sine drone on the root, pentatonic plucks through a
  dotted-eighth feedback delay, under a generated reverb. The chord
  progression and brightness follow the district (the Undercity low and
  dark, the Market warm, the Stack cold and bright) and change as she walks
  in; her mood sets the pluck rate and the filter. It ducks under her voice
  and further while the mic is listening so the phone's speaker does not
  talk to the VAD. The rain has a sound too, filtered noise that follows
  the storm, and lightning brings a low rumble. The bed is tuned to
  A4 = 432 Hz. Settings → Ambience: the synth bed with a volume and a tempo
  (48–120 bpm; the pluck echo follows), and the rain storm with a master
  switch, one switch each for the rain, the gusts, the lightning, the
  rain's sound and the thunder, and its own volume; the street stays either
  way. Preview with `?stage&music=40&stormvol=50&tempo=76` (first tap
  starts it), `?stage&storm=0` for a dry night, `&rain=0`, `&gusts=0`,
  `&lightning=0` for the parts.
- **More rain.** The storm's base density is higher, gusts swell it to a
  downpour for ten to twenty seconds every half minute to minute and a half,
  strikes come every ten to forty seconds, and even the Stack gets wet now.
- **Home screen:** the page ships a web manifest and icons cut from Mira's
  portrait, so Chrome's "Add to Home screen" gives a full-screen portrait app.
- **Settings:** voice and speed, mic sensitivity, listening mode, barge-in,
  the persona (three presets and an editor), aura regime, the network
  brains, clear memory, delete models.
- **The persona, in three lengths.** `personas/mira-short.md`, `mira.md`
  and `mira-long.md` are one voice at three sizes: dark, dry, deadpan, with
  two gears (the flat observation delivered like a weather report, and the
  incredulous run that repeats the absurd thing back until it tips over and
  stops dead), dark philosophical observations, no comfort-speak. No
  comedians are named in the text: describing the mechanics works, naming
  makes a small model do impressions. **Short** (about 380 tokens) fits a
  phone's on-device brain, whose whole prompt must stay under about 700
  tokens (the ROG Phone's GPU refused a longer one). **Standard** (about
  630) is the Workbench's Mira desk text, `prompts/mira.md` there, kept
  identical. **Long** (about 950) is the full bible, with an example of each
  gear and a section on heavy nights, for the lab's big model. Settings →
  Persona length picks one; **Auto** takes short on a phone's on-device
  brain, long on a network brain, standard otherwise. Editing the box makes
  it your own; Reset persona returns to the preset. On a network brain the
  app adds the framing the Workbench desk adds: room to talk, the date,
  which model answers, the read-aloud rule. If you edit her prompt on the
  Workbench (menu → Edit this desk's prompt) and both apps are served from
  the same site, this app takes that edited prompt at boot as long as its
  own persona is still a preset.

## The network brains

Two of the four brains on the first screen answer over HTTP instead of in
the browser. Moonshine still transcribes here, Kokoro still speaks here, the
courier is unchanged; the transcript goes out as an OpenAI-style streaming
`chat/completions` request and the reply streams back. The client is the
Aetheria Workbench's (`src/lab.js`, `src/think.js`), so what works there
works here: paste a base URL (`…/v1`; a bare host or the full
`/v1/chat/completions` form is accepted too), a key, and press **Test
connection**, which hits `/v1/models`, shows the latency, fills the model
list and picks a model if none is set. Endpoint, key and model can be
changed in Settings while she is running; the next turn uses them.

On a network brain the model is told not to think (`chat_template_kwargs:
{enable_thinking: false}` and, for Qwen-named models, `/no_think` on the
last user message; Settings → "How the model is told not to think" if a
server objects), and whatever a server sends anyway, `reasoning_content`
deltas or an inline `<think>` block, is split off before it can reach her
voice. Replies default to the full length here (the short default on phones
exists to spare the phone's GPU, which is idle on these brains), with the
Workbench's note giving her room: eight to twelve sentences when the subject
deserves it. Settings → Reply length overrides it. A camera still goes to
the model as an `image_url` on the last user turn, for endpoints that can see.

### Lab · the Olares, LiteLLM, any endpoint

**The Olares, over https.** The Qwen instance runs as a *llama.cpp Engine
Base* app managed by Model Console. Its URL is in Model Console → Status →
Service status with **Connection source = "Devices on your network"** and
**API format = OpenAI-Compatible**: an https URL of the form
`https://<id>.laresprime.olares.com/v1`. Paste that as the endpoint, any
non-empty key unless you set one, Test, and pick the model name exactly as
Model Console shows it (for example `unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL`).
Off the home network, LarePass VPN on the phone gives the "Remote" source.
Engine flags live in the instance's `ENGINE_ARGS` variable (Settings →
Applications → the app → Manage environment variables); `--jinja` is what
makes the thinking switch work, and `--reasoning-format deepseek` keeps any
reasoning out of the content:

```
--jinja --reasoning-format deepseek -fa on -c 65536
```

**LiteLLM** (on the Olares from Market, which gives it a laresprime https URL
of its own; or on the Khadas) works the same way with its key. It allows
all origins by default; keep `drop_params: false` so `chat_template_kwargs`
goes through. The Workbench README has a `config.yaml` that fronts the
Olares Qwen and the Khadas gpt-oss through one gateway.

**Shared with the Workbench.** Both apps are project sites under
`big-banana-studios.github.io`, one origin, so they share `localStorage`:
the Workbench writes its lab endpoint into this app's settings whenever it
saves, and this app takes the Workbench's endpoint at boot when it has none
of its own. Set the box up once, in either.

### A server on this device

The fourth option: an OpenAI-compatible server on the same device, reached
at `http://127.0.0.1:<port>/v1`. Nothing leaves the device.

- **The phone.** The Aetheria Workbench app's in-app runtime is llama.cpp's
  `llama-server` running inside that app on the phone's GPU, bound to
  127.0.0.1:8080. Start it there (Settings → Native runtime, pick a
  downloaded GGUF), switch to Mira in Chrome, choose this brain, Test. The
  server reflects any origin (CORS is not in the way) and takes no key. If
  Android kills the Workbench in the background while Mira is in front, the
  turn fails with "nothing is listening"; bring the Workbench forward, then
  come back.
- **A PC.** `llama-server -m model.gguf --port 8080 --jinja --reasoning-format deepseek`,
  LM Studio's server with **CORS switched on** in its settings, or Ollama
  with `OLLAMA_ORIGINS=*` (it refuses other origins by default). The
  address field takes any port.

The app is served over https and the server is plain http, and that is
fine for loopback: the browser treats 127.0.0.1 as secure. What Chrome does
ask, once per site, is whether the site may reach devices on your network
(Local Network Access, Chrome 138 and later; the prompt appears under the
address bar the first time you press Test). Allow it. Measured on Chrome
152: with the permission the call goes through; without it the browser
reports only "Failed to fetch", so if Test fails and no prompt appeared,
look for the site's permission in the address-bar controls.

### A plain http box on the LAN

A page served over **https** cannot call a plain **http** endpoint on the
LAN (the Khadas, the 3090 machine) as it is: mixed content. Four ways round:

1. **Use the Olares's https URL**, or put the box behind https (LiteLLM on
   the Olares from Market; Caddy; `tailscale serve --bg 4000`).
2. **Run the app over http on the LAN**: `npm run build`, then `npx serve dist`
   (or `python -m http.server` in `dist/`) and open the printed http address
   on the phone. Same build, no mixed content.
3. **Let Chrome relax it.** In Chrome 138 and later the app names the
   address space on the request (`targetAddressSpace: "local"`), which
   Chrome takes as consent to call a private http address from an https
   page, behind the same local-network permission as above. This follows
   Chrome's Local Network Access design; here only the loopback case could
   be verified, so treat it as "try it, and fall back to 1 or 2".
4. **Install the app** (browser menu → Install) and run it from cache.

The Test button explains which of these applies when a call fails.

## Layout

```
index.html              the three screens (gate, stage, settings)
personas/               the courier's voice at three lengths: mira-short.md (phone), mira.md (= the Workbench's prompts/mira.md), mira-long.md (the lab)
src/persona.js          the presets, and which one is in force
src/prompt.js           the prompt builder: the two-tag protocol, the network-brain framing
src/main.js             boot, WebGPU check, download screen, UI wiring, the endpoint fields
src/companion.js        the turn: VAD → model → sentences → TTS → speaker
src/lab.js              the network brains' client: /v1/models, streaming chat, the thinking switch, Chrome's local-network rules
src/think.js            <think> splitting for streamed text (from the Workbench)
src/workers/vad.worker.js   Silero VAD, speech start/end, push-to-talk, barge-in gating
src/workers/llm.worker.js   Gemma 4 (audio+image, cached KV) · LFM2.5 + Moonshine · Moonshine for the network brains
src/workers/stt.worker.js   Moonshine-tiny transcripts alongside the full brain
src/workers/tts.worker.js   Kokoro (default) / KittenTTS nano (experimental fallback)
tools/pc_test.mjs       the whole pipeline in Chrome with a fake mic (`npm run test:pc`, `test:lab`, `test:local`)
tools/fake_lab.mjs      a fake OpenAI-compatible endpoint that thinks out loud (`npm run fakelab`)
tools/smoke_lab.mjs     Node check of the network-brain client (`npm run check:lab`)
tools/pc.mjs            open the app in that Chrome profile with a real mic (`npm run pc`)
tools/cdp.mjs           the small DevTools-protocol client the tools share
src/audio/              mic capture worklet, playback queue worklet, analysers
src/sprite/renderer.js  Mira: virtual pixel screen, states, gestures, aura, mouth, blink, particles, reflection
src/scene/scene.js      the street: skyline port, rain, lightning, signs, lamp, puddles, tint, vignette
src/splitter.js         streaming sentence splitter
src/settings.js         settings, endpoint normalisation, the Workbench hand-over, Reader regime lookup
src/memory.js           last 40 turns as text
src/thoughts.js         the courier's smoke-break thoughts, for when it has been quiet
src/debug.js            timings + overlay
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

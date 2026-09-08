// Model worker. Three brains:
//
//   gemma  Gemma 4 E2B (ONNX, WebGPU). Audio + optional image go straight in.
//          The KV cache is carried across turns: only the new turn is encoded,
//          so the audio encoder runs once per utterance and nothing is
//          re-prefilled. The transcript of what the user said comes back from
//          the model itself, after the reply (see persona.js protocol).
//   text   Moonshine-tiny transcribes, LFM2.5-2.6B answers. Text only.
//   lab    Moonshine-tiny transcribes here; the HTTP call happens on the
//          main thread (lab.js).
//
// in : {type:'load', brain, dtype, system, primer:[{role,content}]}
//      {type:'turn', id, audio?, image?:{data,width,height}, text?, sampling}
//      {type:'interrupt'} {type:'reset', system, primer} {type:'transcribe', id, audio}
// out: {type:'progress', model, ...} {type:'ready', brain, dtype, device}
//      {type:'token', id, text} {type:'first_token', id} {type:'done', id, text, interrupted, tokens}
//      {type:'transcript', id, text} {type:'error', id?, message} {type:'info', message}

import "./ort-paths.js";
import {
  AutoProcessor,
  Gemma4ForConditionalGeneration,
  AutoTokenizer,
  AutoModelForCausalLM,
  TextStreamer,
  InterruptableStoppingCriteria,
  RawImage,
  Tensor,
  pipeline,
} from "@huggingface/transformers";

const GEMMA_ID = "onnx-community/gemma-4-E2B-it-ONNX";
const LFM_ID = "LiquidAI/LFM2.5-2.6B-ONNX";
const STT_ID = "onnx-community/moonshine-tiny-ONNX";

const MAX_NEW_TOKENS = 360;
const CONTEXT_SOFT_LIMIT = 6000; // tokens; beyond this the cache is rebuilt from text memory

let brain = null;
let dtype = "q4f16";
let device = "webgpu";
let deviceMap = null; // optional per-session override, e.g. {embed_tokens: "wasm"}
let processor = null; // gemma
let model = null; // gemma or lfm
let tokenizer = null; // lfm
let transcriber = null; // moonshine
let system = "";
let primer = [];
let stopping = null;
let busy = false;

// gemma: token ids that match the cache, and the cache itself
let g = { ids: null, cache: null, endedWithEos: true };
// text: plain message list + cache, reference-style
let t = { messages: [], cache: null };

const post = (m, tr) => self.postMessage(m, tr);
const progressFor = (name) => (p) => post({ type: "progress", model: name, ...p });

// ---------------------------------------------------------------- loading

async function load(data) {
  brain = data.brain;
  dtype = data.dtype || "q4f16";
  device = data.device || "webgpu";
  deviceMap = data.deviceMap || null;
  system = data.system || "";
  primer = data.primer || [];
  try {
    if (brain === "gemma") await loadGemma();
    else await loadText(brain === "text");
    post({ type: "ready", brain, dtype, device });
  } catch (e) {
    post({ type: "error", message: `Model failed to load: ${e.message}` });
  }
}

async function loadGemma() {
  processor = await AutoProcessor.from_pretrained(GEMMA_ID, { progress_callback: progressFor("gemma-4-e2b") });
  const attempt = async (dt) => {
    // each ONNX session can run on its own device; the map lets that be tuned
    const dev = deviceMap ? { embed_tokens: "webgpu", audio_encoder: "webgpu", vision_encoder: "webgpu", decoder_model_merged: "webgpu", ...deviceMap } : "webgpu";
    post({ type: "info", message: `loading gemma ${dt} on ${typeof dev === "string" ? dev : JSON.stringify(dev)}` });
    model = await Gemma4ForConditionalGeneration.from_pretrained(GEMMA_ID, {
      dtype: dt,
      device: dev,
      progress_callback: progressFor("gemma-4-e2b"),
    });
    dtype = dt;
  };
  try {
    await attempt(dtype);
  } catch (e) {
    // only a half-precision problem is answered with the q4 files; anything
    // else would just add a second 4 GB download to the same failure
    if (dtype === "q4f16" && /f16|float16|half/i.test(e.message)) {
      post({ type: "info", message: `q4f16 failed (${e.message}); falling back to q4` });
      await attempt("q4");
    } else throw e;
  }
  // Compile shaders on a throwaway prompt so the first real turn is fast.
  post({ type: "info", message: "warming up" });
  const warm = processor.apply_chat_template([{ role: "user", content: [{ type: "text", text: "hi" }] }], {
    add_generation_prompt: true,
    enable_thinking: false,
  });
  const inputs = await processor(warm, null, null, { add_special_tokens: false });
  await model.generate({ ...inputs, max_new_tokens: 1, do_sample: false });
  g = { ids: null, cache: null, endedWithEos: true };
}

async function loadText(withLfm) {
  // Moonshine is small enough to run on WASM when there is no WebGPU (lab mode).
  transcriber = await pipeline("automatic-speech-recognition", STT_ID, {
    device,
    dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : { encoder_model: "fp32", decoder_model_merged: "q8" },
    progress_callback: progressFor("moonshine-tiny"),
  });
  await transcriber(new Float32Array(16000)); // shaders
  if (!withLfm) return;
  tokenizer = await AutoTokenizer.from_pretrained(LFM_ID, { progress_callback: progressFor("lfm2.5-2.6b") });
  const attempt = async (dt) => {
    model = await AutoModelForCausalLM.from_pretrained(LFM_ID, { dtype: dt, device: "webgpu", progress_callback: progressFor("lfm2.5-2.6b") });
    dtype = dt;
  };
  try {
    await attempt(dtype);
  } catch (e) {
    if (dtype === "q4f16" && /f16|float16|half/i.test(e.message)) {
      post({ type: "info", message: `q4f16 failed (${e.message}); falling back to q4` });
      await attempt("q4");
    } else throw e;
  }
  await model.generate({ ...tokenizer("x"), max_new_tokens: 1 });
  resetText();
}

function resetText() {
  t = { messages: [{ role: "system", content: system }, ...primer], cache: null };
}

// ---------------------------------------------------------------- gemma turn

function samplingArgs(sampling) {
  // Greedy is the safest thing a 2B model can do and the most generic.
  // Moderate sampling gives her opinions; the model card's 1.0 / 64 / 0.95
  // is a little wild at this size.
  return sampling
    ? { do_sample: true, temperature: 0.75, top_k: 50, top_p: 0.9, repetition_penalty: 1.05 }
    : { do_sample: false, repetition_penalty: 1.08 };
}

async function gemmaTurn({ id, audio, image, text, sampling }) {
  if (g.ids && g.ids.length > CONTEXT_SOFT_LIMIT) {
    post({ type: "info", message: "context long; re-priming from memory" });
    await disposeCache();
  }
  const parts = [];
  if (image) parts.push({ type: "image" });
  if (audio) parts.push({ type: "audio" });
  if (text) parts.push({ type: "text", text });
  if (!parts.length) throw new Error("empty turn");

  let promptStr;
  if (!g.ids) {
    const messages = [{ role: "system", content: system }, ...primer.slice(-8), { role: "user", content: parts }];
    promptStr = processor.apply_chat_template(messages, { add_generation_prompt: true, enable_thinking: false });
  } else {
    // Continue the cached conversation by hand. Verified against the template:
    // the tokens are identical to a full re-render (tools/smoke_api.mjs).
    const close = g.endedWithEos ? "\n" : "<turn|>\n";
    const body = parts.map((p) => (p.type === "image" ? "<|image|>" : p.type === "audio" ? "<|audio|>" : p.text.trim())).join("");
    promptStr = `${close}<|turn>user\n${body}<turn|>\n<|turn>model\n`;
  }

  const rawImage = image ? new RawImage(image.data, image.width, image.height, 4) : null;
  const inputs = await processor(promptStr, rawImage, audio ?? null, { add_special_tokens: false });

  let input_ids = inputs.input_ids;
  let attention_mask = inputs.attention_mask;
  if (g.ids) {
    const fresh = inputs.input_ids.data;
    const full = new BigInt64Array(g.ids.length + fresh.length);
    full.set(g.ids, 0);
    full.set(fresh, g.ids.length);
    input_ids = new Tensor("int64", full, [1, full.length]);
    attention_mask = new Tensor("int64", new BigInt64Array(full.length).fill(1n), [1, full.length]);
  }
  const promptLen = input_ids.dims[1];

  let tokens = 0;
  let first = true;
  const streamer = new TextStreamer(processor.tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (piece) => {
      if (first) {
        first = false;
        post({ type: "first_token", id });
      }
      post({ type: "token", id, text: piece });
    },
    token_callback_function: () => {
      tokens++;
    },
  });
  stopping = new InterruptableStoppingCriteria();

  const out = await model.generate({
    ...inputs,
    input_ids,
    attention_mask,
    ...(g.cache ? { past_key_values: g.cache } : {}),
    max_new_tokens: MAX_NEW_TOKENS,
    ...samplingArgs(sampling),
    streamer,
    stopping_criteria: stopping,
    return_dict_in_generate: true,
  });

  const seq = out.sequences.data; // BigInt64Array, full sequence
  const last = Number(seq[seq.length - 1]);
  const eos = new Set([1, 106]);
  g = { ids: seq, cache: out.past_key_values, endedWithEos: eos.has(last) };
  const reply = processor.tokenizer.decode(Array.from(seq.slice(promptLen)), { skip_special_tokens: true });
  return { text: reply, tokens, interrupted: stopping.interrupted && !eos.has(last) };
}

async function disposeCache() {
  try {
    await g.cache?.dispose?.();
  } catch {
    /* ignore */
  }
  g = { ids: null, cache: null, endedWithEos: true };
}

// ---------------------------------------------------------------- text turn

async function transcribe(audio) {
  const { text } = await transcriber(audio);
  return (text || "").trim();
}

async function textTurn({ id, audio, text, sampling }) {
  let userText = text || "";
  if (audio) {
    const tr = await transcribe(audio);
    post({ type: "transcript", id, text: tr });
    userText = [tr, text].filter(Boolean).join("\n");
  }
  if (!userText.trim() || ["[BLANK_AUDIO]"].includes(userText.trim())) {
    return { text: "", tokens: 0, interrupted: false, blank: true };
  }
  t.messages.push({ role: "user", content: userText });
  const inputs = tokenizer.apply_chat_template(t.messages, { add_generation_prompt: true, return_dict: true });
  let tokens = 0;
  let first = true;
  const streamer = new TextStreamer(tokenizer, {
    skip_prompt: true,
    skip_special_tokens: true,
    callback_function: (piece) => {
      if (first) {
        first = false;
        post({ type: "first_token", id });
      }
      post({ type: "token", id, text: piece });
    },
    token_callback_function: () => {
      tokens++;
    },
  });
  stopping = new InterruptableStoppingCriteria();
  const out = await model.generate({
    ...inputs,
    ...(t.cache ? { past_key_values: t.cache } : {}),
    max_new_tokens: MAX_NEW_TOKENS,
    ...samplingArgs(sampling),
    streamer,
    stopping_criteria: stopping,
    return_dict_in_generate: true,
  });
  const reply = tokenizer.batch_decode(out.sequences.slice(null, [inputs.input_ids.dims[1], null]), { skip_special_tokens: true })[0];
  t.messages.push({ role: "assistant", content: reply });
  if (stopping.interrupted) {
    // a half-finished answer in the cache is not worth the risk of a mismatch
    t.cache = null;
  } else {
    t.cache = out.past_key_values;
  }
  return { text: reply, tokens, interrupted: stopping.interrupted };
}

// ---------------------------------------------------------------- dispatch

self.onmessage = async ({ data }) => {
  switch (data.type) {
    case "load":
      await load(data);
      return;
    case "interrupt":
      stopping?.interrupt();
      return;
    case "simulate_gpu_loss": // tools/pc_test.mjs --gpucrash
      simulateLoss = true;
      return;
    case "reset":
      system = data.system ?? system;
      primer = data.primer ?? [];
      if (brain === "gemma") await disposeCache();
      else resetText();
      return;
    case "transcribe": {
      try {
        const text = await transcribe(data.audio);
        post({ type: "transcript", id: data.id, text });
      } catch (e) {
        post({ type: "error", id: data.id, message: `Transcription: ${e.message}` });
      }
      return;
    }
    case "turn": {
      if (data.primer) primer = data.primer;
      if (!model && !transcriber) {
        if (reloading) {
          // the sessions are being rebuilt after a lost device: keep the newest turn for when they are back
          pendingTurn = data;
          post({ type: "info", message: "still bringing her back; your turn is kept" });
          return;
        }
        post({ type: "error", id: data.id, message: "the model is still loading" });
        return;
      }
      if (busy) {
        // An interrupted generation is still unwinding; keep only the newest turn.
        pendingTurn = data;
        stopping?.interrupt();
        return;
      }
      await runTurn(data);
      return;
    }
  }
};

let pendingTurn = null;

// What a dead GPU looks like from here. Windows resets a GPU that runs a
// kernel too long, a driver can hiccup, and Chrome's GPU process can restart;
// each leaves every session in this worker dead until it is rebuilt.
const LOST = /device.*lost|lost.*device|DEVICE_LOST|GPUDevice|device is destroyed|Invalid device|GPU process/i;

let reloading = false;

async function reloadAfterLoss() {
  post({ type: "info", message: "the GPU device was lost; reloading the model" });
  reloading = true;
  try {
    await disposeCache();
    t.cache = null;
    model = null;
    if (brain === "gemma") await loadGemma();
    else await loadText(brain === "text");
    post({ type: "info", message: "model reloaded" });
  } finally {
    reloading = false;
  }
}

let simulateLoss = false; // test hook: the next generation throws a device-lost error

async function runTurn(data, attempt = 0) {
  busy = true;
  const t0 = performance.now();
  try {
    if (simulateLoss) {
      simulateLoss = false;
      throw new Error("simulated: GPUDevice lost");
    }
    const r = brain === "gemma" ? await gemmaTurn(data) : await textTurn(data);
    post({ type: "done", id: data.id, ...r, ms: Math.round(performance.now() - t0) });
  } catch (e) {
    console.error(e);
    if (brain === "gemma") await disposeCache();
    else t.cache = null;
    if (attempt < 2 && !stopping?.interrupted) {
      // A GPU run can fail (a lost device, a buffer the driver would not
      // give, a reset). First: try again from a fresh, shorter context. If
      // the error names a lost device, or a second attempt fails too, rebuild
      // the sessions from the cache and try once more before giving up.
      try {
        if (LOST.test(String(e.message)) || attempt === 1) await reloadAfterLoss();
        else post({ type: "info", message: `retrying after: ${e.message}`.slice(0, 200) });
      } catch (e2) {
        post({ type: "error", id: data.id, message: `Generation: ${e.message}; reload failed: ${e2.message}` });
        busy = false;
        return;
      }
      primer = (data.primer || primer).slice(-4);
      busy = false;
      await runTurn(data, attempt + 1);
      return;
    }
    post({ type: "error", id: data.id, message: `Generation: ${e.message}` });
  } finally {
    busy = false;
  }
  if (pendingTurn) {
    const next = pendingTurn;
    pendingTurn = null;
    await runTurn(next);
  }
}

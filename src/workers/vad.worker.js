// VAD worker: Silero VAD on WASM, fed 512-sample chunks at 16 kHz. Decides
// where speech starts and ends, and hands the finished utterance back as one
// Float32Array. Runs all the time, including while she is talking, which is
// what makes barge-in possible.
//
// in : {type:'load'} {type:'config', config} {type:'audio', buffer}
//      {type:'ptt_down'} {type:'ptt_up'} {type:'reset'}
// out: {type:'ready'} {type:'speech_start'} {type:'speech_end', audio, seconds}
//      {type:'speech_cancel'} {type:'prob', p} {type:'error', message}

import "./ort-paths.js";
import { AutoModel, Tensor } from "@huggingface/transformers";

const SR = 16000;
const CHUNK = 512;
const MAX_SEC = 30;

const cfg = {
  start: 0.325, // speech probability that opens an utterance
  exit: 0.11, // below this (while recording) counts as silence
  barge: 0.72, // opening threshold while she is speaking
  bargeChunks: 4, // consecutive loud chunks needed to barge in (~128 ms)
  minSilenceMs: 650, // a breath mid-sentence is ~300-500 ms; a turn's end is longer
  minSpeechMs: 300,
  padMs: 160,
  mode: "vad", // vad | ptt
  playing: false, // she is talking right now
};

let model = null;
let state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
const sr = new Tensor("int64", [BigInt(SR)], []);

const BUFFER = new Float32Array(MAX_SEC * SR);
let ptr = 0;
let recording = false;
let postSpeechSamples = 0;
let prev = []; // recent non-speech chunks, kept for the leading pad
let bargeRun = 0;
let probTick = 0;
let ptt = false;

const post = (m, transfer) => self.postMessage(m, transfer);

async function load() {
  try {
    model = await AutoModel.from_pretrained("onnx-community/silero-vad", {
      config: { model_type: "custom" },
      dtype: "fp32", // device: browser default is WASM; Node falls back to CPU
      progress_callback: (p) => post({ type: "progress", model: "silero-vad", ...p }),
    });
    // warm up
    await model({ input: new Tensor("float32", new Float32Array(CHUNK), [1, CHUNK]), sr, state });
    post({ type: "ready" });
  } catch (e) {
    post({ type: "error", message: `VAD failed to load: ${e.message}` });
  }
}

function resetAll() {
  BUFFER.fill(0, 0, ptr);
  ptr = 0;
  recording = false;
  postSpeechSamples = 0;
  prev = [];
  bargeRun = 0;
  state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
}

function maxPrev() {
  return Math.ceil((cfg.padMs / 1000) * SR / CHUNK) + cfg.bargeChunks;
}

function startRecording() {
  if (recording) return;
  recording = true;
  postSpeechSamples = 0;
  // pull the leading pad (and any barge-in run-up) out of the FIFO
  ptr = 0;
  for (const b of prev) {
    if (ptr + b.length <= BUFFER.length) {
      BUFFER.set(b, ptr);
      ptr += b.length;
    }
  }
  prev = [];
  post({ type: "speech_start" });
}

function dispatch() {
  const trailingKeep = Math.min(postSpeechSamples, Math.round((cfg.padMs / 1000) * SR));
  const end = Math.max(0, ptr - (postSpeechSamples - trailingKeep));
  const seconds = end / SR;
  const wasRecording = recording;
  recording = false;
  postSpeechSamples = 0;
  bargeRun = 0;
  if (!wasRecording || seconds * 1000 < cfg.minSpeechMs) {
    BUFFER.fill(0, 0, ptr);
    ptr = 0;
    post({ type: "speech_cancel" });
    return;
  }
  const audio = BUFFER.slice(0, end);
  BUFFER.fill(0, 0, ptr);
  ptr = 0;
  normalise(audio);
  post({ type: "speech_end", audio, seconds }, [audio.buffer]);
}

/**
 * Quiet speech (someone napping in the next room) reaches the models as a
 * whisper and is transcribed like one. Bring the utterance's peak up to a
 * sensible level, with a cap so noise is not amplified into speech.
 */
function normalise(audio) {
  let peak = 0;
  for (let i = 0; i < audio.length; i++) {
    const v = Math.abs(audio[i]);
    if (v > peak) peak = v;
  }
  if (peak < 0.02 || peak >= 0.6) return;
  const gain = Math.min(8, 0.7 / peak);
  for (let i = 0; i < audio.length; i++) audio[i] *= gain;
}

async function onAudio(buffer) {
  // Always run the model so its recurrent state stays continuous.
  const input = new Tensor("float32", buffer, [1, buffer.length]);
  const { stateN, output } = await model({ input, sr, state });
  state = stateN;
  const p = output.data[0];
  if (++probTick % 4 === 0) post({ type: "prob", p, recording });

  if (cfg.mode === "ptt") {
    if (ptt) append(buffer);
    return;
  }

  const openAt = cfg.playing ? cfg.barge : cfg.start;
  let isSpeech;
  if (recording) {
    isSpeech = p >= cfg.exit;
  } else if (cfg.playing) {
    bargeRun = p > openAt ? bargeRun + 1 : 0;
    isSpeech = bargeRun >= cfg.bargeChunks;
  } else {
    isSpeech = p > openAt;
  }

  if (!recording && !isSpeech) {
    prev.push(buffer);
    while (prev.length > maxPrev()) prev.shift();
    return;
  }

  if (!recording && isSpeech) startRecording();
  append(buffer);

  if (isSpeech) {
    postSpeechSamples = 0;
    return;
  }
  postSpeechSamples += buffer.length;
  if (postSpeechSamples >= (cfg.minSilenceMs / 1000) * SR) dispatch();
}

function append(buffer) {
  const remaining = BUFFER.length - ptr;
  if (buffer.length >= remaining) {
    BUFFER.set(buffer.subarray(0, remaining), ptr);
    ptr += remaining;
    dispatch(); // 30 s hard cap: hand it over and start again
    return;
  }
  BUFFER.set(buffer, ptr);
  ptr += buffer.length;
}

self.onmessage = async ({ data }) => {
  switch (data.type) {
    case "load":
      await load();
      break;
    case "config":
      Object.assign(cfg, data.config);
      if (cfg.mode !== "ptt") ptt = false;
      break;
    case "audio":
      if (model) await onAudio(data.buffer);
      break;
    case "ptt_down":
      ptt = true;
      startRecording();
      break;
    case "ptt_up":
      ptt = false;
      dispatch();
      break;
    case "reset":
      resetAll();
      break;
  }
};

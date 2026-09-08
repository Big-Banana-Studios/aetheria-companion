// Transcript worker: Moonshine-tiny, for the transcript strip and the text
// memory when the full brain is in use. Gemma hears the audio itself; this
// runs alongside it, so the words appear without costing the reply any time.
//
// in : {type:'load', device} {type:'transcribe', id, audio}
// out: {type:'progress', ...} {type:'ready'} {type:'transcript', id, text, ms} {type:'error', id?, message}

import "./ort-paths.js";
import { pipeline } from "@huggingface/transformers";

const STT_IDS = { tiny: "onnx-community/moonshine-tiny-ONNX", base: "onnx-community/moonshine-base-ONNX" };
let transcriber = null;
let chain = Promise.resolve();
let lastLoad = null;
const LOST = /device.*lost|lost.*device|DEVICE_LOST|GPUDevice|device is destroyed|Invalid device|GPU process/i;
const post = (m) => self.postMessage(m);

async function load({ device = "webgpu", model = "tiny" }) {
  lastLoad = { device, model };
  const id = STT_IDS[model] || STT_IDS.tiny;
  try {
    transcriber = await pipeline("automatic-speech-recognition", id, {
      device,
      dtype: device === "webgpu" ? { encoder_model: "fp32", decoder_model_merged: "q4" } : { encoder_model: "fp32", decoder_model_merged: "q8" },
      progress_callback: (p) => post({ type: "progress", model: `moonshine-${model}`, ...p }),
    });
    await transcriber(new Float32Array(16000));
    post({ type: "ready" });
  } catch (e) {
    post({ type: "error", message: `Transcriber failed to load: ${e.message}` });
  }
}

self.onmessage = async ({ data }) => {
  if (data.type === "load") return load(data);
  if (data.type === "transcribe") {
    if (!transcriber) return post({ type: "error", id: data.id, message: "transcriber not loaded" });
    const t0 = performance.now();
    chain = chain.then(async () => {
      try {
        const { text } = await transcriber(data.audio);
        post({ type: "transcript", id: data.id, text: (text || "").trim(), ms: Math.round(performance.now() - t0) });
      } catch (e) {
        if (LOST.test(String(e.message)) && lastLoad) {
          // the GPU went away: rebuild from the cache and transcribe again
          post({ type: "info", message: "the GPU device was lost; reloading the transcriber" });
          try {
            transcriber = null;
            await load(lastLoad);
            const { text } = await transcriber(data.audio);
            post({ type: "transcript", id: data.id, text: (text || "").trim(), ms: Math.round(performance.now() - t0) });
            return;
          } catch (e2) {
            post({ type: "error", id: data.id, message: `Transcription reload failed: ${e2.message}` });
            return;
          }
        }
        post({ type: "error", id: data.id, message: `Transcription: ${e.message}` });
      }
    });
  }
};

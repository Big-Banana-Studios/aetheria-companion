// Point ONNX Runtime at the WASM files we ship, instead of the jsdelivr CDN
// Transformers.js falls back to. Without this, a fresh install needs the CDN
// and "offline after first load" depends on the browser's HTTP cache.
// The files are copied from node_modules by tools/copy_ort.mjs (postinstall
// and prebuild) into public/ort/, so they always match the bundled runtime.
//
// Import this before anything that creates an inference session.

import { env } from "@huggingface/transformers";

const base = (typeof import.meta.env !== "undefined" && import.meta.env.BASE_URL) || "/";
const here = typeof self !== "undefined" && self.location?.href ? self.location.href : "http://localhost/";
const dir = new URL(`${base}ort/`, here).href;

// Same choice Transformers.js makes: Safari gets the plain build, everyone
// else the asyncify build (which is what WebGPU sessions use too).
const isSafari = typeof navigator !== "undefined" && /^((?!chrome|android).)*safari/i.test(navigator.userAgent);
const stem = isSafari ? "ort-wasm-simd-threaded" : "ort-wasm-simd-threaded.asyncify";

// Only in a real browser context (worker or page). Node - the smoke tests -
// keeps its native backend and never touches these paths.
const isWorker = typeof self !== "undefined" && typeof self.importScripts === "function";
const isPage = typeof window !== "undefined";
if ((isWorker || isPage) && env.backends?.onnx?.wasm) {
  env.backends.onnx.wasm.wasmPaths = {
    mjs: `${dir}${stem}.mjs`,
    wasm: `${dir}${stem}.wasm`,
  };
}
env.allowLocalModels = false;

export const ORT_DIR = dir;

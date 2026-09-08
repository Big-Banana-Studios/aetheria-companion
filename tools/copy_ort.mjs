// Copies the ONNX Runtime WASM files the app needs into public/ort/, from the
// exact onnxruntime-web version Transformers.js resolved to. Run by
// `npm install` (postinstall) and `npm run build` (prebuild).
import { copyFileSync, mkdirSync, existsSync, readFileSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
const require = createRequire(join(root, "package.json"));

// Resolve onnxruntime-web the way @huggingface/transformers does, so a nested
// copy under kokoro-js can never be picked by mistake. Packages with strict
// "exports" refuse `pkg/package.json`, so resolve the entry point and walk up.
function packageDir(spec, req) {
  let dir = dirname(req.resolve(spec));
  for (let i = 0; i < 8; i++) {
    const pj = join(dir, "package.json");
    if (existsSync(pj) && JSON.parse(readFileSync(pj, "utf8")).name === spec) return dir;
    dir = dirname(dir);
  }
  throw new Error(`could not locate package dir for ${spec}`);
}
const tjsDir = packageDir("@huggingface/transformers", require);
const tjsRequire = createRequire(join(tjsDir, "package.json"));
const ortDir = packageDir("onnxruntime-web", tjsRequire);
const ortDist = join(ortDir, "dist");
const version = JSON.parse(readFileSync(join(ortDir, "package.json"), "utf8")).version;

const files = [
  "ort-wasm-simd-threaded.asyncify.mjs",
  "ort-wasm-simd-threaded.asyncify.wasm",
  "ort-wasm-simd-threaded.mjs",
  "ort-wasm-simd-threaded.wasm",
];

const out = join(root, "public", "ort");
mkdirSync(out, { recursive: true });
let copied = 0;
for (const f of files) {
  const src = join(ortDist, f);
  if (!existsSync(src)) {
    console.warn(`copy_ort: missing ${src}`);
    continue;
  }
  copyFileSync(src, join(out, f));
  copied++;
}
console.log(`copy_ort: ${copied}/${files.length} files from onnxruntime-web ${version} -> public/ort/`);

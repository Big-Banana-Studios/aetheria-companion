import { defineConfig } from "vite";

// Static build only. `BASE_PATH=/aetheria-companion/ npm run build` for a
// GitHub Pages project site; leave unset for a custom domain or local use.
export default defineConfig({
  base: process.env.BASE_PATH || "/",
  build: {
    target: "esnext",
    chunkSizeWarningLimit: 4000,
    // The two AudioWorklet modules are tiny; inlined as data: URLs they would
    // not load as worklets. Keep every asset as a real file.
    assetsInlineLimit: 0,
  },
  worker: {
    format: "es",
  },
  resolve: {
    // One copy of Transformers.js, shared by `@huggingface/transformers` (v4)
    // and `kokoro-js` (which declares v3 - its API surface still matches).
    dedupe: ["@huggingface/transformers"],
  },
  optimizeDeps: {
    // Transformers.js resolves its WASM relative to import.meta.url, so it
    // must not be pre-bundled. kokoro-js MUST be: its dist imports Node's
    // `path` and `fs/promises`, which only its package.json `browser` field
    // maps away, and the dev server applies that field while pre-bundling.
    exclude: ["@huggingface/transformers"],
    include: ["kokoro-js", "phonemizer"],
  },
  server: {
    port: 5173,
  },
});

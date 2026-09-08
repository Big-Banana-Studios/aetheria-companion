// Talk to Mira on this PC: starts the dev server and opens Chrome with the
// same profile the pipeline test uses (so the models are already cached),
// with your real microphone. Leaves both running.
//
//   node tools/pc.mjs
import { spawn } from "node:child_process";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, waitHttp } from "./cdp.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const PORT = 5173;
const profile = join(root, ".chrome-test-profile");
mkdirSync(profile, { recursive: true });
const win = process.platform === "win32";

let up = false;
try {
  await waitHttp(`http://localhost:${PORT}/`, 2, 100);
  up = true;
} catch {
  /* start it */
}
if (!up) {
  const server = spawn(win ? "npx.cmd" : "npx", ["vite", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore", shell: win, detached: true });
  server.unref();
  await waitHttp(`http://localhost:${PORT}/`, 300);
}
const chrome = findChrome();
if (!chrome) {
  console.error("no Chrome found; open http://localhost:5173/ yourself");
  process.exit(1);
}
const proc = spawn(chrome, [`--user-data-dir=${profile}`, "--no-first-run", "--no-default-browser-check", "--force_high_performance_gpu", "--window-size=520,1040", `http://localhost:${PORT}/?debug`], {
  stdio: "ignore",
  detached: true,
});
proc.unref();
console.log(`Mira is at http://localhost:${PORT}/ in Chrome (profile ${profile}). The dev server keeps running; Ctrl+C here does not stop it.`);

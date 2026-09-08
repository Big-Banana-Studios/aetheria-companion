// Phone-sized screenshots of the stage preview (`?stage`) through headless
// Chrome's DevTools protocol, for checking the street and the gestures
// without a phone or a model download. Run `npm run build` first.
//
//   node tools/screenshots.mjs
//   node tools/screenshots.mjs "stage&noenter&mood=excited@1200,1700" "stage@300,700,1200"
//
// Each argument is a query string; `@ms[,ms...]` takes a shot at each of
// those times after load (default 2500). PNGs go to shots/. Set CHROME to
// the browser executable if it is not in one of the usual places.
import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { findChrome, waitHttp, CDP, sleep } from "./cdp.mjs";

const root = join(fileURLToPath(import.meta.url), "..", "..");
const chromePath = findChrome();
if (!chromePath) {
  console.error("no Chrome/Edge found; set CHROME=<path>");
  process.exit(1);
}

const args = process.argv.slice(2);
const shots = args.length
  ? args
  : [
      "stage&noenter@2500",
      "stage@350,700,1100",
      "stage&noenter&regime=GUT&state=thinking@1200,3400",
      "stage&noenter&regime=HEAD&state=speaking&mood=happy@1250,1500",
      "stage&noenter&state=listening@7000",
      "stage&noenter&state=idle_long@2500",
      "stage&noenter&state=asleep@3000",
      "stage&noenter&mood=excited@1150,1500",
      "stage&noenter&mood=concerned@1600",
      "stage&noenter&mood=annoyed@1250",
      "stage&noenter&mood=tired@1700",
      "stage&noenter&state=error@1400,3000",
    ];

const PORT = 4173;
const DEBUG = 9333;
const win = process.platform === "win32";

const server = spawn(win ? "npx.cmd" : "npx", ["vite", "preview", "--port", String(PORT), "--strictPort"], { cwd: root, stdio: "ignore", shell: win });
const chrome = spawn(
  chromePath,
  ["--headless=new", "--disable-gpu", "--hide-scrollbars", `--remote-debugging-port=${DEBUG}`, "--window-size=412,915", "--force-device-scale-factor=2", "--no-first-run", "about:blank"],
  { stdio: "ignore" },
);

try {
  await waitHttp(`http://localhost:${PORT}/`);
  const targets = await waitHttp(`http://localhost:${DEBUG}/json`);
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Emulation.setDeviceMetricsOverride", { width: 412, height: 915, deviceScaleFactor: 2, mobile: true });
  mkdirSync(join(root, "shots"), { recursive: true });
  for (const spec of shots) {
    const [q, at] = spec.split("@");
    const times = (at || "2500").split(",").map(Number);
    cdp.console.length = 0;
    await cdp.navigate(`http://localhost:${PORT}/?${q}`);
    let elapsed = 0;
    for (const t of times) {
      await sleep(Math.max(0, t - elapsed));
      elapsed = t;
      const { data } = await cdp.send("Page.captureScreenshot", { format: "png" });
      const name = `${q.replace(/[^a-z0-9]+/gi, "_").replace(/^_|_$/g, "") || "stage"}@${t}.png`;
      writeFileSync(join(root, "shots", name), Buffer.from(data, "base64"));
      console.log(`ok   shots/${name}`);
    }
    for (const l of cdp.console.filter((l) => !/adapters|autocomplete|Password field/.test(l)).slice(0, 5)) console.log(`     ${l}`);
  }
  cdp.ws.close();
} catch (e) {
  console.error("screenshots failed:", e.message);
  process.exitCode = 1;
} finally {
  chrome.kill();
  server.kill();
  if (win) {
    spawnSync("taskkill", ["/pid", String(chrome.pid), "/T", "/F"], { stdio: "ignore" });
    spawnSync("taskkill", ["/pid", String(server.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

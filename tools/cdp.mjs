// A very small Chrome DevTools Protocol client on Node's built-in WebSocket,
// shared by tools/screenshots.mjs and tools/pc_test.mjs.
import { spawn } from "node:child_process";
import { existsSync } from "node:fs";

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function findChrome() {
  return (
    process.env.CHROME ||
    [
      "C:/Program Files/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Google/Chrome/Application/chrome.exe",
      "C:/Program Files (x86)/Microsoft/Edge/Application/msedge.exe",
      "/usr/bin/google-chrome",
      "/usr/bin/chromium",
      "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome",
    ].find((p) => existsSync(p))
  );
}

export async function waitHttp(url, tries = 150, every = 200) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await fetch(url);
      if (r.ok) return await r.json().catch(() => true);
    } catch {
      /* not yet */
    }
    await sleep(every);
  }
  throw new Error(`no answer from ${url}`);
}

export class CDP {
  constructor(wsUrl) {
    this.ws = new WebSocket(wsUrl);
    this.id = 0;
    this.pending = new Map();
    this.console = [];
    this.onEvent = null;
    this.ws.onmessage = (ev) => {
      const m = JSON.parse(ev.data);
      if (m.id && this.pending.has(m.id)) {
        const { resolve, reject } = this.pending.get(m.id);
        this.pending.delete(m.id);
        m.error ? reject(new Error(m.error.message)) : resolve(m.result);
        return;
      }
      if (m.method === "Runtime.consoleAPICalled") {
        this.console.push(`${m.params.type}: ${m.params.args.map((a) => a.value ?? a.description ?? "").join(" ")}`);
      } else if (m.method === "Runtime.exceptionThrown") {
        this.console.push(`EXCEPTION: ${m.params.exceptionDetails.exception?.description || m.params.exceptionDetails.text}`);
      } else if (m.method === "Log.entryAdded") {
        const e = m.params.entry;
        if (e.level === "error" || e.level === "warning") this.console.push(`${e.level}: ${e.text}`);
      } else if (m.method === "Page.loadEventFired") {
        this.loaded?.();
      }
      this.onEvent?.(m);
    };
  }
  open() {
    return new Promise((res, rej) => {
      this.ws.onopen = res;
      this.ws.onerror = rej;
    });
  }
  send(method, params = {}) {
    const id = ++this.id;
    this.ws.send(JSON.stringify({ id, method, params }));
    return new Promise((resolve, reject) => this.pending.set(id, { resolve, reject }));
  }
  navigate(url) {
    const loaded = new Promise((r) => (this.loaded = r));
    return this.send("Page.navigate", { url }).then(() => loaded);
  }
  /** Evaluate an expression in the page; returns its value (awaits promises). */
  async eval(expression) {
    const r = await this.send("Runtime.evaluate", { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
    return r.result?.value;
  }
  async screenshot(path) {
    const { data } = await this.send("Page.captureScreenshot", { format: "png" });
    const { writeFileSync } = await import("node:fs");
    writeFileSync(path, Buffer.from(data, "base64"));
  }
  drain() {
    const out = this.console.splice(0);
    return out;
  }
  close() {
    try {
      this.ws.close();
    } catch {
      /* ignore */
    }
  }
}

/** Launch Chrome with remote debugging and return {proc, cdp} attached to its first page. */
export async function launchChrome({ args = [], url = "about:blank", port = 9333, headless = true } = {}) {
  const chromePath = findChrome();
  if (!chromePath) throw new Error("no Chrome/Edge found; set CHROME=<path>");
  const flags = [...(headless ? ["--headless=new", "--disable-gpu"] : []), `--remote-debugging-port=${port}`, "--no-first-run", "--no-default-browser-check", ...args, url];
  const proc = spawn(chromePath, flags, { stdio: "ignore" });
  const targets = await waitHttp(`http://localhost:${port}/json`);
  const page = (Array.isArray(targets) ? targets : []).find((t) => t.type === "page");
  if (!page) throw new Error("no page target");
  const cdp = new CDP(page.webSocketDebuggerUrl);
  await cdp.open();
  await cdp.send("Page.enable");
  await cdp.send("Runtime.enable");
  await cdp.send("Log.enable").catch(() => {});
  return { proc, cdp };
}

export function killTree(proc) {
  if (!proc) return;
  try {
    proc.kill();
  } catch {
    /* ignore */
  }
  if (process.platform === "win32") {
    const { spawnSync } = require("node:child_process");
    spawnSync("taskkill", ["/pid", String(proc.pid), "/T", "/F"], { stdio: "ignore" });
  }
}

// `require` for the one CommonJS call above
import { createRequire } from "node:module";
const require = createRequire(import.meta.url);

// The lab, and a server on this device: any OpenAI-compatible endpoint. The
// Qwen instance on the Olares (a Model Console app with an https laresprime
// URL), LiteLLM, gpt-oss on the Khadas, the Workbench app's llama.cpp
// runtime on this phone, llama-server / LM Studio / Ollama on a PC. Grown
// together with the workbench's src/lab.js: the same SSE parsing, plus the
// model list, a connection test, the thinking switch, per-turn stats, and
// Chrome's rules for reaching a plain-http box from an https page.

import { endpoints } from "./settings.js";

const pageIsHttps = () => typeof location !== "undefined" && location.protocol === "https:";

let support = null;
/**
 * Whether this browser takes fetch's `targetAddressSpace` (Chrome's Local
 * Network Access, 138 and later; Private Network Access before it) and
 * which names it uses: LNA says loopback / local / public, PNA said
 * local / private / public. A bogus value throws only where the option is
 * known, so that is the probe.
 */
export function addressSpaceSupport() {
  if (support) return support;
  if (typeof Request === "undefined") return (support = { supported: false, naming: null });
  try {
    new Request("https://example.invalid/", { targetAddressSpace: "bogus" });
    return (support = { supported: false, naming: null });
  } catch {
    /* the option exists */
  }
  try {
    new Request("https://example.invalid/", { targetAddressSpace: "loopback" });
    return (support = { supported: true, naming: "lna" });
  } catch {
    return (support = { supported: true, naming: "pna" });
  }
}

/**
 * The fetch init for an endpoint. An https page may call plain http on
 * loopback as it is: the browser treats 127.0.0.1 as secure, and Chrome
 * only asks once whether the site may reach devices on the network. A
 * plain http box on the LAN is mixed content unless the fetch names the
 * address space, which Chrome takes as consent to relax that, behind the
 * same permission. Measured on Chrome 152 (tools/fake_lab.mjs, README).
 */
export function fetchInit(url, init = {}) {
  const e = endpoints(url);
  if (!e || !e.http || !pageIsHttps() || e.loopback || !e.lan) return init;
  const s = addressSpaceSupport();
  if (!s.supported) return init;
  return { ...init, targetAddressSpace: s.naming === "lna" ? "local" : "private" };
}

export const labFetch = (url, init) => fetch(url, fetchInit(url, init));

/** True when the browser will refuse the call outright, whatever the user allows. */
export function blockedByMixedContent(url) {
  const e = endpoints(url);
  if (!e || !e.http || !pageIsHttps() || e.loopback) return false;
  return e.lan ? !addressSpaceSupport().supported : true;
}

/** Describe a failed fetch in words a person can act on. */
export function explainFetchError(e, url) {
  const msg = String(e?.message || e);
  const ep = endpoints(url);
  if (e?.name === "AbortError") return "Timed out. The endpoint did not answer in time; is the box awake and on this network?";
  if (/Failed to fetch|NetworkError|Load failed/i.test(msg)) {
    if (blockedByMixedContent(url)) {
      return "The browser blocked the call: this page is served over https and the endpoint is plain http (mixed content). Use the Olares's https URL, put the endpoint behind https, or run the app from a local http server on this network (npm run dev -- --host).";
    }
    if (ep && ep.http && pageIsHttps() && (ep.loopback || ep.lan)) {
      return `Chrome asks once whether this site may reach devices on your network; allow it (the prompt under the address bar) and test again. If it did not ask: nothing is listening at ${ep.base}, or the server does not allow this page's origin (CORS). The Workbench runtime and llama-server allow any origin; LM Studio needs CORS switched on in its server settings; Ollama needs OLLAMA_ORIGINS set.`;
    }
    return "The browser could not reach the endpoint. Either it is down, the URL is wrong, or it does not allow this origin (CORS). LiteLLM needs the app's origin allowed; Model Console instances allow any.";
  }
  return msg;
}

function authHeaders(apiKey) {
  const h = { "Content-Type": "application/json" };
  // Any non-empty key is accepted by an unsecured Model Console instance;
  // an empty one is simply not sent.
  if (apiKey) h.Authorization = `Bearer ${apiKey}`;
  return h;
}

/**
 * GET /v1/models. Returns the ids and how long the round trip took.
 * @param {{models: string, apiKey?: string, timeoutMs?: number}} p
 */
export async function listModels({ models, apiKey, timeoutMs = 5000 }) {
  const ctl = new AbortController();
  const timer = setTimeout(() => ctl.abort(), timeoutMs);
  const t0 = performance.now();
  try {
    const res = await labFetch(models, { headers: authHeaders(apiKey), signal: ctl.signal });
    const ms = Math.round(performance.now() - t0);
    if (!res.ok) {
      const txt = await res.text().catch(() => "");
      throw new Error(`${res.status} ${res.statusText}: ${txt.slice(0, 160)}`);
    }
    const j = await res.json();
    const list = Array.isArray(j.data) ? j.data : Array.isArray(j.models) ? j.models : Array.isArray(j) ? j : [];
    const ids = list.map((m) => (typeof m === "string" ? m : m.id || m.name)).filter(Boolean);
    return { ids, ms };
  } finally {
    clearTimeout(timer);
  }
}

/**
 * The Test connection button: hit /v1/models, report latency and the list.
 * @param {{url: string, apiKey?: string, timeoutMs?: number}} p
 */
export async function testEndpoint({ url, apiKey, timeoutMs = 8000 }) {
  const e = endpoints(url);
  if (!e) return { ok: false, error: "No endpoint set." };
  if (blockedByMixedContent(url)) return { ok: false, error: explainFetchError(new TypeError("Failed to fetch"), url), mixed: true, base: e.base };
  try {
    const { ids, ms } = await listModels({ models: e.models, apiKey, timeoutMs });
    return { ok: true, ms, models: ids, base: e.base };
  } catch (err) {
    return { ok: false, error: explainFetchError(err, url), base: e.base };
  }
}

/**
 * A model from the endpoint's list when none is set: the one already
 * chosen if it is there, else Qwen first, then the largest by the number in
 * its name; never an embedding, speech or reranking model.
 */
export function pickModel(ids, current = "") {
  if (!ids?.length) return current;
  if (current && ids.includes(current)) return current;
  const score = (id) => {
    const s = id.toLowerCase();
    let n = 0;
    if (/qwen3\.8|qwen3_8|qwen-3\.8/.test(s)) n += 100;
    if (/qwen/.test(s)) n += 30;
    if (/vl|vision|omni/.test(s)) n += 15;
    const b = /(\d+(?:\.\d+)?)b\b/.exec(s);
    if (b) n += Math.min(50, Number(b[1]));
    if (/embed|whisper|tts|rerank|kokoro|moonshine/.test(s)) n -= 200;
    return n;
  };
  return [...ids].sort((a, b) => score(b) - score(a))[0];
}

/**
 * Stream a chat completion. Resolves with the full text, the reasoning
 * (from `reasoning_content` deltas; inline <think> is the caller's job, see
 * think.js), the usage block if the server sends one, and timings.
 *
 * @param {{
 *   chat: string, apiKey?: string, model: string, messages: any[], signal: AbortSignal,
 *   onDelta: (text: string) => void, onReasoning?: (text: string) => void,
 *   temperature?: number, maxTokens?: number,
 *   thinking?: boolean|null, thinkSwitch?: "auto"|"template"|"tag"|"none",
 * }} p
 */
export async function streamChat({ chat, apiKey, model, messages, signal, onDelta, onReasoning, temperature = 0.7, maxTokens = 400, thinking = null, thinkSwitch = "auto" }) {
  const body = {
    model,
    messages: withThinkTag(messages, thinking, thinkSwitch, model),
    stream: true,
    stream_options: { include_usage: true },
    temperature,
    max_tokens: maxTokens,
  };
  if (thinking != null && (thinkSwitch === "auto" || thinkSwitch === "template")) {
    // llama.cpp's server (with --jinja) and vLLM read this; LiteLLM passes
    // it through to OpenAI-compatible providers. Qwen's template honours it.
    body.chat_template_kwargs = { enable_thinking: !!thinking };
  }
  const t0 = performance.now();
  const res = await labFetch(chat, { method: "POST", headers: authHeaders(apiKey), body: JSON.stringify(body), signal });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`endpoint ${res.status}: ${txt.slice(0, 300)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let text = "";
  let reasoning = "";
  let usage = null;
  let chunks = 0;
  let firstAt = null;
  let finish = null;
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let nl;
    while ((nl = buf.indexOf("\n")) >= 0) {
      const line = buf.slice(0, nl).trim();
      buf = buf.slice(nl + 1);
      if (!line.startsWith("data:")) continue;
      const data = line.slice(5).trim();
      if (data === "[DONE]") {
        buf = "";
        break;
      }
      let j;
      try {
        j = JSON.parse(data);
      } catch {
        continue; // keep-alive or a partial line
      }
      if (j.usage) usage = j.usage;
      if (j.error) throw new Error(j.error.message || JSON.stringify(j.error));
      const choice = j.choices?.[0];
      if (!choice) continue;
      const d = choice.delta || {};
      if (choice.finish_reason) finish = choice.finish_reason;
      const r = d.reasoning_content ?? d.reasoning ?? null;
      if (r) {
        if (firstAt == null) firstAt = performance.now();
        reasoning += r;
        onReasoning?.(r);
      }
      const c = d.content ?? "";
      if (c) {
        if (firstAt == null) firstAt = performance.now();
        chunks++;
        text += c;
        onDelta(c);
      }
    }
  }
  const t1 = performance.now();
  return { text, reasoning, usage, finish, ms: Math.round(t1 - t0), firstTokenMs: firstAt ? Math.round(firstAt - t0) : null, chunks, decodeMs: firstAt ? Math.round(t1 - firstAt) : null };
}

/**
 * Qwen's soft switch: `/think` or `/no_think` at the end of the last user
 * message. Only for Qwen-named models in `auto`, always in `tag`.
 */
export function withThinkTag(messages, thinking, mode, model) {
  if (thinking == null || mode === "none" || mode === "template") return messages;
  if (mode === "auto" && !/qwen/i.test(model || "")) return messages;
  const out = messages.map((m) => ({ ...m }));
  for (let i = out.length - 1; i >= 0; i--) {
    if (out[i].role !== "user") continue;
    const tag = thinking ? " /think" : " /no_think";
    if (typeof out[i].content === "string") out[i].content = out[i].content.replace(/\s*\/(no_)?think\s*$/i, "") + tag;
    else if (Array.isArray(out[i].content)) {
      const parts = out[i].content.map((p) => ({ ...p }));
      const last = [...parts].reverse().find((p) => p.type === "text");
      if (last) last.text = (last.text || "").replace(/\s*\/(no_)?think\s*$/i, "") + tag;
      else parts.push({ type: "text", text: tag.trim() });
      out[i].content = parts;
    }
    break;
  }
  return out;
}

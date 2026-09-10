// Node-only checks for the network brains (no GPU, no browser, no Olares):
// endpoint normalisation, the think parser across chunk boundaries, the
// prompt framing on a remote brain, and a streamed turn against the fake
// lab: the request carries the thinking switch and Qwen's /no_think, the
// key, the model picked from /v1/models; the reply's reasoning is split
// off before it could be spoken.
//
//   node tools/smoke_lab.mjs

import assert from "node:assert/strict";
import { start } from "./fake_lab.mjs";
import { endpoints, replyLength, isRemote, DEFAULTS, connection } from "../src/settings.js";
import { ThinkParser, stripThink } from "../src/think.js";
import { buildSystemPrompt } from "../src/prompt.js";
import { streamChat, listModels, withThinkTag, pickModel, explainFetchError, addressSpaceSupport, fetchInit } from "../src/lab.js";

let n = 0;
const ok = (name) => console.log(`  ok  ${name}`) || n++;

// ---------------------------------------------------------------- endpoints
{
  const e = endpoints("https://abc.laresprime.olares.com/v1");
  assert.equal(e.chat, "https://abc.laresprime.olares.com/v1/chat/completions");
  assert.equal(e.models, "https://abc.laresprime.olares.com/v1/models");
  assert.equal(e.http, false);
  assert.equal(e.loopback, false);
  assert.equal(e.lan, false);
  ok("an Olares https base URL");
  const k = endpoints("khadas.local:4000");
  assert.equal(k.base, "http://khadas.local:4000/v1");
  assert.equal(k.http, true);
  assert.equal(k.lan, true);
  ok("a bare LAN host gets http:// and /v1");
  const w = endpoints("http://127.0.0.1:8080/v1/chat/completions");
  assert.equal(w.base, "http://127.0.0.1:8080/v1");
  assert.equal(w.loopback, true);
  ok("the full chat URL (what the workbench writes) is accepted");
  assert.equal(endpoints("http://192.168.50.61:4000/v1/").lan, true);
  assert.equal(endpoints("https://api.example.com/v1/").lan, false);
  assert.equal(endpoints(""), null);
  assert.equal(endpoints("   "), null);
  ok("trailing slashes, public hosts, blanks");
  assert.equal(connection({ brain: "lab", lab: { url: "a" }, local: { url: "b" } }).url, "a");
  assert.equal(connection({ brain: "local", lab: { url: "a" }, local: { url: "b" } }).url, "b");
  assert.equal(DEFAULTS.local.url, "http://127.0.0.1:8080/v1");
  ok("connection() picks the block for the brain; the local default is the workbench runtime's port");
}

// ---------------------------------------------------------------- reply length
{
  assert.equal(isRemote("lab") && isRemote("local") && !isRemote("gemma"), true);
  assert.equal(replyLength({ replyLength: "auto", brain: "lab" }), "full");
  assert.equal(replyLength({ replyLength: "auto", brain: "local" }), "full");
  assert.equal(replyLength({ replyLength: "short", brain: "lab" }), "short");
  ok("auto reply length is full on a network brain");
}

// ---------------------------------------------------------------- think parser
{
  let text = "";
  let reasoning = "";
  const p = new ThinkParser((t) => (text += t), (r) => (reasoning += r));
  for (const c of ["<thi", "nk>sec", "ret</th", "ink>\n\n[calm] [small] Hi", " there."]) p.push(c);
  p.close();
  assert.equal(text, "[calm] [small] Hi there.");
  assert.equal(reasoning, "secret");
  ok("a <think> block split across chunks never reaches the text");
  text = "";
  const q = new ThinkParser((t) => (text += t));
  for (const c of ["Hello <", "b> there <t", "hin"]) q.push(c);
  q.close();
  assert.equal(text, "Hello <b> there <thin");
  ok("angle brackets that are not a think tag pass through");
  assert.equal(stripThink("<think>x</think>  [calm] [mid] Yes."), "[calm] [mid] Yes.");
  assert.equal(stripThink("[calm] [mid] Yes. <think>unfinished"), "[calm] [mid] Yes.");
  ok("stripThink");
}

// ---------------------------------------------------------------- prompt framing
{
  const remote = buildSystemPrompt("PERSONA", { remote: true, brain: "lab", model: "qwen-x", length: "full", date: new Date(2026, 8, 9) });
  assert.match(remote, /^PERSONA\n\nProtocol\.\n1\. Start every reply with two tags/);
  assert.match(remote, /## Length\nThere is time on this model.*eight to twelve sentences/);
  assert.match(remote, /## Notes\nToday is Wed Sep 09 2026\. You are answering as the lab model qwen-x\./);
  assert.match(remote, /\[look\]/);
  ok("remote framing: the two-tag protocol, the workbench's length note, the date and the model");
  const short = buildSystemPrompt("PERSONA", { remote: true, brain: "local", model: "m", length: "short" });
  assert.match(short, /## Length\nThree to six sentences/);
  assert.match(short, /the model running on this device \(m\)/);
  ok("short length and the local wording");
  const device = buildSystemPrompt("PERSONA", { audio: true, camera: true });
  assert.doesNotMatch(device, /## Length|## Notes/);
  ok("the on-device prompt stays short");
}

// ---------------------------------------------------------------- the three personas
{
  const { readFileSync } = await import("node:fs");
  const dir = new URL("../personas/", import.meta.url);
  const read = (n) => readFileSync(new URL(n, dir), "utf8");
  const tokens = (s) => Math.round(s.length / 4.2); // a rough count; the phone budget is about 700 with the protocol (about 220)
  const P = { short: read("mira-short.md"), standard: read("mira.md"), long: read("mira-long.md") };
  for (const [name, text] of Object.entries(P)) {
    assert.match(text, /^You are Mira, the courier from Paperless/, name);
    assert.match(text, /Two gears|The two gears/, `${name} has the two gears`);
    assert.match(text, /never two turns running/, `${name} keeps the question rule`);
    assert.match(text, /audio was unclear/, `${name} keeps the audio rule`);
    assert.doesNotMatch(text, /Carlin|Katt|Williams/i, `${name} names no comedians`);
  }
  assert.ok(tokens(P.short) < tokens(P.standard) && tokens(P.standard) < tokens(P.long), "ordered by length");
  assert.ok(tokens(P.short) + 220 <= 700, `short fits the phone budget (${tokens(P.short)} + 220 tokens)`);
  assert.ok(tokens(P.long) >= 800 && tokens(P.long) <= 1200, `long is a bible (${tokens(P.long)} tokens)`);
  ok(`three personas: short ${tokens(P.short)}, standard ${tokens(P.standard)}, long ${tokens(P.long)} tokens (rough)`);
  const wb = readFileSync("C:/Users/jobo1/Desktop/Aetheria workbench/aetheria-workbench/prompts/mira.md", "utf8");
  if (wb === P.standard) ok("the Workbench's prompts/mira.md is the standard text");
  else console.log("  note the Workbench's prompts/mira.md differs from personas/mira.md");
}

// ---------------------------------------------------------------- think tag
{
  const msgs = [{ role: "system", content: "s" }, { role: "user", content: "hi" }, { role: "assistant", content: "yo" }, { role: "user", content: "again /think" }];
  assert.equal(withThinkTag(msgs, false, "auto", "unsloth/Qwen3.8-27B")[3].content, "again /no_think");
  assert.equal(withThinkTag(msgs, false, "auto", "gpt-oss-20b")[3].content, "again /think");
  assert.equal(withThinkTag(msgs, false, "template", "qwen")[3].content, "again /think");
  assert.equal(withThinkTag(msgs, false, "tag", "gpt-oss")[3].content, "again /no_think");
  assert.equal(withThinkTag(msgs, null, "auto", "qwen")[3].content, "again /think");
  const parts = [{ role: "user", content: [{ type: "text", text: "look" }, { type: "image_url", image_url: { url: "data:x" } }] }];
  assert.equal(withThinkTag(parts, false, "auto", "qwen")[0].content[0].text, "look /no_think");
  ok("Qwen's /no_think only where it belongs, on plain and on image turns");
}

// ---------------------------------------------------------------- pick a model
{
  const ids = ["fake-embed", "gemma-3-4b", "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL"];
  assert.equal(pickModel(ids, ""), "unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL");
  assert.equal(pickModel(ids, "gemma-3-4b"), "gemma-3-4b");
  assert.equal(pickModel(["a-embed"], ""), "a-embed");
  ok("pickModel prefers Qwen, never an embedding model, keeps a listed choice");
}

// ---------------------------------------------------------------- errors, address space
{
  assert.match(explainFetchError(Object.assign(new Error("x"), { name: "AbortError" }), "http://a/v1"), /Timed out/);
  assert.match(explainFetchError(new TypeError("Failed to fetch"), "https://a.laresprime.olares.com/v1"), /CORS/);
  assert.equal(explainFetchError(new Error("endpoint 401: no key"), "https://a/v1"), "endpoint 401: no key");
  ok("fetch errors explained");
  const s = addressSpaceSupport();
  assert.equal(s.supported, false); // Node's fetch has no targetAddressSpace
  assert.deepEqual(fetchInit("http://192.168.1.2/v1/models", { a: 1 }), { a: 1 });
  ok("no address-space option outside a browser");
}

// ---------------------------------------------------------------- a live streamed turn
{
  const PORT = 4322;
  const lab = await start(PORT, "127.0.0.1");
  try {
    const e = endpoints(`http://127.0.0.1:${PORT}/v1`);
    const { ids, ms } = await listModels({ models: e.models, apiKey: "k" });
    assert.equal(ids.length, 3);
    assert.ok(ms >= 0);
    ok(`GET /v1/models lists ${ids.length} models`);
    const model = pickModel(ids, "");
    const system = buildSystemPrompt("You are Mira, the courier from Paperless.", { remote: true, brain: "lab", model, length: "full" });
    const messages = [{ role: "system", content: system }, { role: "user", content: "Fresh coffee, stepping out for a smoke." }];
    let text = "";
    let reasoning = "";
    const parser = new ThinkParser((t) => (text += t), (r) => (reasoning += r));
    const r = await streamChat({ chat: e.chat, apiKey: "k", model, messages, signal: new AbortController().signal, onDelta: (c) => parser.push(c), temperature: 0.75, maxTokens: 500, thinking: false, thinkSwitch: "auto" });
    parser.close();
    assert.equal(r.finish, "stop");
    assert.equal(r.usage.completion_tokens, 45);
    assert.equal(r.reasoning, "Let me think about this.");
    assert.match(r.text, /^<think>/);
    assert.match(text, /^\[curious\] \[mid\] Hello from the fake lab\. You said Fresh coffee/);
    assert.equal(reasoning, "inline reasoning that must never be spoken");
    assert.doesNotMatch(text, /inline reasoning|<think>/);
    assert.match(text, /Thinking switch false\. No think tag yes\./);
    assert.match(text, /Persona present\. Length noted\./);
    assert.ok(r.firstTokenMs != null && r.ms >= r.firstTokenMs);
    ok("streamed turn: reasoning_content and <think> split off; the switch, the tag, the persona and the length note arrived");
    const last = await (await fetch(`http://127.0.0.1:${PORT}/last`)).json();
    assert.equal(last.auth, "Bearer k");
    assert.equal(last.last.model, model);
    assert.equal(last.last.max_tokens, 500);
    assert.equal(last.last.chat_template_kwargs.enable_thinking, false);
    assert.equal(last.last.stream, true);
    ok("the wire: key, model, max_tokens, chat_template_kwargs, stream");
  } finally {
    lab.close();
  }
}

console.log(`smoke_lab: ${n} checks passed`);

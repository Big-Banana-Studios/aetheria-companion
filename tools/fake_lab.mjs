// A fake OpenAI-compatible endpoint, for the checks that need no GPU and no
// Olares: GET /v1/models, and a streaming POST /v1/chat/completions that
// behaves like a Qwen behind llama.cpp with thinking left on: it sends
// `reasoning_content` deltas AND an inline <think> block before the reply,
// so the client's stripping is exercised whatever the server does. The reply
// opens with Mira's two tags and reports what it was sent (the thinking
// switch, the /no_think tag, the model, max_tokens), so a test can read the
// plumbing back out of her words. GET /last returns the last request body.
//
//   node tools/fake_lab.mjs [port] [--host 0.0.0.0]     (default 4321, 127.0.0.1)
//
// Grown from the workbench's tools/fake_lab.mjs.

import { createServer } from "node:http";

const argv = process.argv.slice(2);
const PORT = Number(argv.find((a) => /^\d+$/.test(a)) || process.env.FAKE_LAB_PORT || 4321);
const HOST = argv.includes("--host") ? argv[argv.indexOf("--host") + 1] : "127.0.0.1";
const MODELS = ["unsloth/Qwen3.8-27B-GGUF:UD-Q4_K_XL", "fake-vision-vl", "fake-embed"];

function cors(res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Headers", "Content-Type, Authorization");
  res.setHeader("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
  res.setHeader("Access-Control-Allow-Private-Network", "true");
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export function start(port = PORT, host = HOST) {
  const state = { last: null, calls: 0 };
  const server = createServer(async (req, res) => {
    cors(res);
    if (req.method === "OPTIONS") {
      res.writeHead(204);
      return res.end();
    }
    if (req.method === "GET" && req.url.endsWith("/v1/models")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ object: "list", data: MODELS.map((id) => ({ id, object: "model" })) }));
    }
    if (req.method === "GET" && req.url.endsWith("/last")) {
      res.writeHead(200, { "Content-Type": "application/json" });
      return res.end(JSON.stringify({ calls: state.calls, last: state.last, auth: state.auth || null }));
    }
    if (req.method === "POST" && req.url.endsWith("/v1/chat/completions")) {
      let body = "";
      for await (const chunk of req) body += chunk;
      let j = {};
      try {
        j = JSON.parse(body);
      } catch {
        res.writeHead(400);
        return res.end("bad json");
      }
      state.calls++;
      state.last = j;
      state.auth = req.headers.authorization || null;
      const last = j.messages?.[j.messages.length - 1];
      const userText = Array.isArray(last?.content) ? last.content.find((p) => p.type === "text")?.text || "" : String(last?.content || "");
      const thinking = j.chat_template_kwargs?.enable_thinking;
      const noThink = /\/no_think\s*$/.test(userText) ? "yes" : /\/think\s*$/.test(userText) ? "think" : "no";
      const system = j.messages?.[0]?.role === "system" ? j.messages[0].content : "";
      const id = `chatcmpl-${Date.now()}`;
      res.writeHead(200, { "Content-Type": "text/event-stream", "Cache-Control": "no-cache", Connection: "keep-alive" });
      const send = (delta, extra = {}) => res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: j.model, choices: [{ index: 0, delta, finish_reason: null }], ...extra })}\n\n`);
      // what a thinking model does when nobody told it not to
      for (const r of ["Let me ", "think about ", "this."]) {
        send({ reasoning_content: r });
        await sleep(8);
      }
      const said = userText.replace(/\s*\/(no_)?think\s*$/i, "").replace(/\n\(.*$/s, "").slice(0, 50).replace(/["\n]/g, " ").trim();
      const text = `<think>inline reasoning that must never be spoken</think>[curious] [mid] Hello from the fake lab. You said ${said || "nothing"}. Thinking switch ${thinking === undefined ? "unset" : thinking}. No think tag ${noThink}. Model ${j.model}. Max tokens ${j.max_tokens}. Persona ${/courier from Paperless/.test(system) ? "present" : "missing"}. Length ${/## Length/.test(system) ? "noted" : "unset"}.`;
      for (const piece of text.match(/[\s\S]{1,7}/g)) {
        send({ content: piece });
        await sleep(4);
      }
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: j.model, choices: [{ index: 0, delta: {}, finish_reason: "stop" }] })}\n\n`);
      res.write(`data: ${JSON.stringify({ id, object: "chat.completion.chunk", model: j.model, choices: [], usage: { prompt_tokens: 123, completion_tokens: 45, total_tokens: 168 } })}\n\n`);
      res.write("data: [DONE]\n\n");
      return res.end();
    }
    res.writeHead(404);
    res.end("not found");
  });
  return new Promise((resolve) => server.listen(port, host, () => resolve(Object.assign(server, { state }))));
}

const self = process.argv[1]?.replace(/\\/g, "/") || "";
if (self.endsWith("fake_lab.mjs")) {
  start().then(() => console.log(`fake lab on http://${HOST}:${PORT}/v1  (GET /last shows the last request)`));
}

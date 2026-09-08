// Lab mode: the same UI in front of the home LiteLLM box.
// POST /v1/chat/completions with stream:true, parse the SSE deltas.

/**
 * @param {{url: string, model: string, apiKey?: string, messages: any[], signal: AbortSignal,
 *          onDelta: (text: string) => void, sampling?: boolean}} p
 * @returns {Promise<string>} the full reply
 */
export async function streamChat({ url, model, apiKey, messages, signal, onDelta, sampling = false, maxTokens = 400 }) {
  const headers = { "Content-Type": "application/json" };
  if (apiKey) headers.Authorization = `Bearer ${apiKey}`;
  const body = {
    model,
    messages,
    stream: true,
    temperature: sampling ? 0.8 : 0.3,
    max_tokens: maxTokens,
  };
  const res = await fetch(url, { method: "POST", headers, body: JSON.stringify(body), signal });
  if (!res.ok) {
    const txt = await res.text().catch(() => "");
    throw new Error(`lab endpoint ${res.status}: ${txt.slice(0, 200)}`);
  }
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = "";
  let full = "";
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
      if (data === "[DONE]") return full;
      try {
        const j = JSON.parse(data);
        const delta = j.choices?.[0]?.delta?.content ?? "";
        if (delta) {
          full += delta;
          onDelta(delta);
        }
      } catch {
        /* keep-alive or partial line */
      }
    }
  }
  return full;
}

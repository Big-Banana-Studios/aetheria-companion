import { AutoModel, AutoProcessor, Tensor, env } from "@huggingface/transformers";
env.cacheDir = process.env.HF_CACHE || "C:/Users/jobo1/AppData/Local/Temp/claude/c--Users-jobo1-Desktop-MIRA/3b8b2643-2474-4842-8e31-172398364c9c/scratchpad/hf-cache";
const t0 = Date.now();
// 1. Silero VAD with the "custom" model type (as used by the reference demo)
const vad = await AutoModel.from_pretrained("onnx-community/silero-vad", { config: { model_type: "custom" }, dtype: "fp32" });
const sr = new Tensor("int64", [16000n], []);
let state = new Tensor("float32", new Float32Array(2 * 1 * 128), [2, 1, 128]);
const noise = new Float32Array(512).map(() => (Math.random() - 0.5) * 0.01);
const out = await vad({ input: new Tensor("float32", noise, [1, 512]), sr, state });
console.log("VAD ok. output keys:", Object.keys(out), "prob:", out.output.data[0], "stateN dims:", out.stateN.dims, `(${Date.now() - t0} ms)`);

// 2. Gemma 4 processor: chat template + tokenization of a first turn and a continuation turn
const model_id = "onnx-community/gemma-4-E2B-it-ONNX";
const processor = await AutoProcessor.from_pretrained(model_id);
console.log("processor:", processor.constructor.name, "tokenizer:", processor.tokenizer.constructor.name);
console.log("audio_token:", processor.audio_token, "boa:", processor.boa_token, "eoa:", processor.eoa_token, "image:", processor.image_token);
const messages = [
  { role: "system", content: "You are a courier." },
  { role: "user", content: [{ type: "audio" }, { type: "text", text: "Hello there" }] },
];
const prompt = processor.apply_chat_template(messages, { enable_thinking: false, add_generation_prompt: true });
console.log("PROMPT:", JSON.stringify(prompt));
const audio = new Float32Array(16000 * 2).map(() => (Math.random() - 0.5) * 0.1); // 2 s
const inputs = await processor(prompt, null, audio, { add_special_tokens: false });
console.log("input keys:", Object.keys(inputs));
console.log("input_ids dims:", inputs.input_ids.dims, "input_features dims:", inputs.input_features?.dims, "mask dims:", inputs.input_features_mask?.dims);
const ids = inputs.input_ids.tolist()[0];
const tok = processor.tokenizer;
const audioId = tok.encode("<|audio|>", { add_special_tokens: false })[0];
console.log("audio token id:", audioId, "count in ids:", ids.filter((x) => Number(x) === Number(audioId)).length, "computed:", processor._compute_audio_num_tokens(audio.length, 16000));
console.log("first 12 ids:", ids.slice(0, 12).map(Number), "last 8 ids:", ids.slice(-8).map(Number));
console.log("decoded tail:", JSON.stringify(tok.decode(ids.slice(-10), { skip_special_tokens: false })));
// 3. A continuation turn rendered by hand vs. by the template
const full = [...messages, { role: "assistant", content: "Hello." }, { role: "user", content: [{ type: "audio" }] }];
const promptFull = processor.apply_chat_template(full, { enable_thinking: false, add_generation_prompt: true });
const cont = "\n<|turn>user\n<|audio|><turn|>\n<|turn>model\n";
const assistantTurn = "Hello.<turn|>";
console.log("template suffix matches hand-built continuation:", promptFull.endsWith(assistantTurn + cont), JSON.stringify(promptFull.slice(prompt.length)));
// 4. do the EOS ids look right
console.log("eos ids:", JSON.stringify(processor.tokenizer.config?.eos_token), "id of <turn|>:", tok.encode("<turn|>", { add_special_tokens: false })[0], "id of <eos>:", tok.encode("<eos>", { add_special_tokens: false })[0], "decode 50:", JSON.stringify(tok.decode([50], { skip_special_tokens: false })));
// 5. tokenization boundary: does tokenizing the continuation alone equal the tail of the full tokenization?
const idsFull = (await processor(promptFull, null, [audio, audio], { add_special_tokens: false })).input_ids.tolist()[0].map(Number);
const idsCont = (await processor(assistantTurn + cont, null, audio, { add_special_tokens: false })).input_ids.tolist()[0].map(Number);
const idsFirst = ids.map(Number);
const joined = idsFirst.concat(idsCont);
console.log("first+cont length:", joined.length, "full length:", idsFull.length, "identical:", JSON.stringify(joined) === JSON.stringify(idsFull));
if (JSON.stringify(joined) !== JSON.stringify(idsFull)) {
  for (let i = 0; i < Math.max(joined.length, idsFull.length); i++) if (joined[i] !== idsFull[i]) { console.log("first diff at", i, joined.slice(i-3,i+5), idsFull.slice(i-3,i+5)); break; }
}
console.log(`done in ${Date.now() - t0} ms`);

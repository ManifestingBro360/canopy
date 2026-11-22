#!/usr/bin/env node
// Manager adapter: any server that speaks the OpenAI chat-completions format.
// That covers Ollama, vLLM, LM Studio, llama.cpp's server and hosted gateways,
// so open-source models work the same way as hosted ones.
//   rules.json:  "manager": { "cmd": "node /path/to/canopy/managers/openai-compatible.mjs" }
//   CANOPY_MANAGER_URL    base URL, e.g. http://127.0.0.1:11434/v1
//   CANOPY_MANAGER_MODEL  model name, e.g. qwen2.5-coder:32b
//   CANOPY_MANAGER_KEY    bearer key, if the server wants one
import { readDossier, prompt, emit } from './prompt.mjs';

const base = (process.env.CANOPY_MANAGER_URL || '').replace(/\/$/, ''), model = process.env.CANOPY_MANAGER_MODEL;
if (!base || !model) { console.error('set CANOPY_MANAGER_URL and CANOPY_MANAGER_MODEL'); process.exit(1); }
const d = await readDossier();
const headers = { 'content-type': 'application/json' };
if (process.env.CANOPY_MANAGER_KEY) headers.authorization = 'Bearer ' + process.env.CANOPY_MANAGER_KEY;
const res = await fetch(base + '/chat/completions', { method: 'POST', headers,
  body: JSON.stringify({ model, temperature: 0, messages: [{ role: 'user', content: prompt(d) }] }) });
if (!res.ok) { console.error(`the model server answered ${res.status}: ${(await res.text()).slice(0, 300)}`); process.exit(1); }
const j = await res.json();
emit(j.choices && j.choices[0] && j.choices[0].message && j.choices[0].message.content, model);

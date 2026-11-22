#!/usr/bin/env node
// Manager adapter: Codex CLI in non-interactive mode, with whatever sign-in
// `codex` already has on the Canopy host.
//
// CAUTION. Codex cannot be run with its tools switched off. This adapter asks
// for the read-only sandbox and starts it in an empty directory, so it cannot
// write and has no checkout in front of it, but the model can still run
// commands that read what canopyd's account can read. The change under review
// is untrusted text and may try to talk the model into doing so. For
// repositories that take changes from people or agents you do not trust, use
// managers/openai-compatible.mjs (a plain completion, no tools) or
// managers/claude-code.mjs (tools switched off) instead.
//   rules.json:  "manager": { "cmd": "node /path/to/canopy/managers/codex.mjs" }
//   CANOPY_MANAGER_MODEL  optional model name, passed as a config override
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDossier, prompt, emit } from './prompt.mjs';

const d = await readDossier();
const model = process.env.CANOPY_MANAGER_MODEL || '';
// An empty directory: the model is given the diff, not a checkout to act in.
const cwd = mkdtempSync(join(tmpdir(), 'canopy-manager-'));
const args = ['exec', '--skip-git-repo-check', '--sandbox', 'read-only'];
if (model) args.push('-c', `model="${model}"`);
args.push('-');
const r = spawnSync('codex', args, { cwd, input: prompt(d), encoding: 'utf8', maxBuffer: 1 << 26 });
if (r.status !== 0) { console.error((r.stderr || r.stdout || 'codex failed').slice(-600)); process.exit(1); }
emit(r.stdout, 'codex:' + (model || 'default'));

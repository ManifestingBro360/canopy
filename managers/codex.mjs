#!/usr/bin/env node
// Manager adapter: Codex CLI in non-interactive mode, with whatever sign-in
// `codex` already has on the Canopy host.
//
// CAUTION. Codex cannot be run with its tools switched off, and the change
// under review is untrusted text that may try to talk the model into using
// them. Three things contain that:
//   - canopyd runs every manager inside a sandbox that cannot read canopyd's
//     key, tokens or database, the repository's Git directory, or SSH, cloud
//     and GitHub credentials, and cannot reach canopyd (macOS; the Linux
//     profile is written but untested; with neither, there is no such sandbox);
//   - this adapter asks Codex for its own read-only sandbox and starts it in an
//     empty directory;
//   - what the manager writes is never sent back to whoever asked for the
//     landing; only its verdict is.
// What is NOT contained: the model can still read other files canopyd's
// account can read, including Codex's own sign-in. Where canopyd has no
// sandbox, or the repository takes changes from sources you do not trust,
// prefer managers/openai-compatible.mjs (a plain completion, no tools) or
// managers/claude-code.mjs (tools switched off).
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

#!/usr/bin/env node
// Manager adapter: Claude Code in print mode. The model runs with no tools: the
// change under review is untrusted input.
//
// canopyd runs this inside a sandbox that may write only to a throwaway
// directory, so Claude Code is pointed at a fresh settings folder there and
// your own ~/.claude is neither read for settings nor written. That means the
// sign-in kept in your own settings is not used: give canopyd's environment
// ANTHROPIC_API_KEY or CLAUDE_CODE_OAUTH_TOKEN.
//   rules.json:  "manager": { "cmd": "node /path/to/canopy/managers/claude-code.mjs" }
//   CANOPY_MANAGER_MODEL  model alias or full name (default: the CLI's default)
import { spawnSync } from 'node:child_process';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { readDossier, prompt, emit } from './prompt.mjs';

const d = await readDossier();
const model = process.env.CANOPY_MANAGER_MODEL || '';
const args = ['-p', '--output-format', 'json', '--tools', '', '--disallowedTools', 'mcp__*', '--max-turns', '1'];
if (model) args.push('--model', model);
// An empty directory: no project settings, hooks or instruction files of the repository are loaded.
const cwd = mkdtempSync(join(tmpdir(), 'canopy-manager-'));
const r = spawnSync('claude', args, { cwd, env: { ...process.env, CLAUDE_CONFIG_DIR: join(cwd, 'settings') }, input: prompt(d), encoding: 'utf8', maxBuffer: 1 << 26 });
if (r.status !== 0) { console.error((r.stderr || r.stdout || 'claude failed').slice(-600)); process.exit(1); }
let answer = r.stdout;
try { const j = JSON.parse(r.stdout); answer = j.result ?? r.stdout; } catch { /* plain text output */ }
emit(answer, 'claude-code:' + (model || 'default'));

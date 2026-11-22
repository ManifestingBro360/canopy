// Shared helpers for the black-box Canopy test suite. node built-ins only.
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CLI_REAL = path.join(ROOT, 'bin', 'canopy.mjs');
// The suite runs the CLI through a differently named symlink so that a stray `pkill -f canopy.mjs`
// from another session on the same machine does not kill the daemons under test.
const LINKDIR = fs.mkdtempSync(path.join(os.tmpdir(), 'cnp-link-'));
fs.symlinkSync(CLI_REAL, path.join(LINKDIR, 'cp-under-test.mjs'));
export const CLI = path.join(LINKDIR, 'cp-under-test.mjs');

export const GIT_ENV = {
  GIT_AUTHOR_NAME: 'Test', GIT_AUTHOR_EMAIL: 'test@example.com',
  GIT_COMMITTER_NAME: 'Test', GIT_COMMITTER_EMAIL: 'test@example.com',
  GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null',
  GIT_TERMINAL_PROMPT: '0',
};

const madeDirs = [];
process.on('exit', () => {
  if (process.env.CANOPY_KEEP) return;
  for (const d of madeDirs) try { fs.rmSync(d, { recursive: true, force: true }); } catch {}
  try { fs.rmSync(LINKDIR, { recursive: true, force: true }); } catch {}
});
export function tmp(prefix = 'canopy-t-') {
  const d = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), prefix)));
  madeDirs.push(d);
  return d;
}

export function git(cwd, ...args) {
  const r = spawnSync('git', ['-c', 'init.defaultBranch=main', '-c', 'commit.gpgsign=false', ...args],
    { cwd, encoding: 'utf8', env: { ...process.env, ...GIT_ENV } });
  return { code: r.status, out: (r.stdout || '').trim(), err: (r.stderr || '').trim() };
}
export function gitOk(cwd, ...args) {
  const r = git(cwd, ...args);
  if (r.code !== 0) throw new Error(`git ${args.join(' ')} failed in ${cwd}: ${r.err}`);
  return r.out;
}

export function writeFiles(dir, files) {
  for (const [p, content] of Object.entries(files)) {
    const f = path.join(dir, p);
    fs.mkdirSync(path.dirname(f), { recursive: true });
    fs.writeFileSync(f, content);
  }
}

export async function waitFor(fn, { timeout = 5000, step = 25 } = {}) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return { value: v, ms: Date.now() - t0 };
    if (Date.now() - t0 > timeout) return { value: null, ms: Date.now() - t0 };
    await new Promise((r) => setTimeout(r, step));
  }
}
export const toSymlinked = (p) => p.replace(/^\/private(?=\/var\/)/, '');

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Build a repo on branch main with the given files and rules, committed.
export function mkRepo(files, rules, { prefix } = {}) {
  const dir = tmp(prefix);
  gitOk(dir, 'init', '-q', '-b', 'main');
  writeFiles(dir, files);
  if (rules) writeFiles(dir, { '.canopy/rules.json': JSON.stringify(rules, null, 2) });
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-q', '-m', 'initial');
  return dir;
}

export function addWorktree(repo, name) {
  const wt = path.join(path.dirname(repo), `${path.basename(repo)}-${name}`);
  gitOk(repo, 'worktree', 'add', '-q', wt, '-b', name);
  return fs.realpathSync(wt);
}

// ---- daemon ---------------------------------------------------------------
const started = new Set();
process.on('exit', () => { for (const c of started) try { c.kill('SIGKILL'); } catch {} });

export async function startDaemon(repo, port, { home, env = {}, token } = {}) {
  const e = { ...process.env, ...GIT_ENV, CANOPY_PORT: String(port), ...env };
  if (home) e.CANOPY_HOME = home;
  if (token) e.CANOPY_TOKEN = token;
  const child = spawn(process.execPath, [CLI, 'serve'], { cwd: repo, env: e, stdio: ['ignore', 'pipe', 'pipe'] });
  started.add(child);
  let log = '';
  child.stdout.on('data', (d) => { log += d; });
  child.stderr.on('data', (d) => { log += d; });
  const t0 = Date.now();
  const d = {
    child, port, repo, env: e,
    get log() { return log; },
    kill() { try { child.kill('SIGKILL'); } catch {} started.delete(child); },
    startedMs: null,
  };
  for (let i = 0; i < 600; i++) {
    if (/index\s/.test(log) && /key\s/.test(log)) break;
    if (child.exitCode !== null) throw new Error('canopyd exited early: ' + log);
    await sleep(25);
  }
  d.startedMs = Date.now() - t0;
  const m = log.match(/index\s+(\d+) files, (\d+) nodes in (\d+) ms/);
  if (m) d.index = { files: +m[1], nodes: +m[2], ms: +m[3] };
  d.humanToken = () => {
    const h = home || path.join(repo, '.git', 'canopy');
    try { return fs.readFileSync(path.join(h, 'human.token'), 'utf8').trim(); } catch { return null; }
  };
  return d;
}

// ---- HTTP -----------------------------------------------------------------
export const agentFor = () => new http.Agent({ keepAlive: true, maxSockets: 4 });

export function httpJson(port, method, urlPath, body, { agent, headers = {} } = {}) {
  return new Promise((resolve, reject) => {
    const data = body === undefined ? null : JSON.stringify(body);
    const t0 = process.hrtime.bigint();
    const req = http.request({ host: '127.0.0.1', port, method, path: urlPath, agent,
      headers: { ...(data ? { 'content-type': 'application/json', 'content-length': Buffer.byteLength(data) } : {}), ...headers } },
    (res) => {
      let buf = '';
      res.on('data', (c) => { buf += c; });
      res.on('end', () => {
        const ms = Number(process.hrtime.bigint() - t0) / 1e6;
        let json = null; try { json = JSON.parse(buf); } catch {}
        resolve({ status: res.statusCode, json, text: buf, ms });
      });
    });
    req.on('error', reject);
    if (data) req.write(data);
    req.end();
  });
}

export const getState = async (port) => (await httpJson(port, 'GET', '/api/state')).json;

// ---- simulated Claude Code agent -----------------------------------------
export function ctxOf(res) {
  const o = res.json?.hookSpecificOutput;
  return o?.additionalContext || '';
}
export function reasonOf(res) { return res.json?.hookSpecificOutput?.permissionDecisionReason || ''; }
export function denied(res) {
  return res.json?.hookSpecificOutput?.permissionDecision === 'deny';
}

export class Agent {
  constructor(daemon, repo, name, { hookPathOf, agent } = {}) {
    this.d = daemon; this.repo = repo; this.name = name;
    this.wt = addWorktree(repo, name);
    this.sid = `sess-${name}-${Math.random().toString(36).slice(2, 8)}`;
    this.hookPathOf = hookPathOf || ((p) => p);   // transform paths put in payloads
    this.http = agent || agentFor();
    this.log = [];
  }
  abs(p) { return path.join(this.wt, p); }
  async hook(event, extra = {}) {
    const payload = { session_id: this.sid, cwd: this.hookPathOf(this.wt), hook_event_name: event, ...extra };
    const res = await httpJson(this.d.port, 'POST', '/hook', payload, { agent: this.http });
    this.log.push({ event, extra, res });
    return res;
  }
  start() { return this.hook('SessionStart', { source: 'startup' }); }
  end() { return this.hook('SessionEnd'); }
  prompt(text) { return this.hook('UserPromptSubmit', { prompt: text }); }
  read(p) {
    return this.hook('PostToolUse', { tool_name: 'Read',
      tool_input: { file_path: this.hookPathOf(this.abs(p)) }, tool_response: { content: fs.readFileSync(this.abs(p), 'utf8') } });
  }
  // Pre-hook; if denied, the file is NOT changed. Otherwise really edit and post.
  async edit(p, oldS, newS, { allowDeny = false } = {}) {
    const file = this.abs(p);
    const input = { file_path: this.hookPathOf(file), old_string: oldS, new_string: newS };
    const pre = await this.hook('PreToolUse', { tool_name: 'Edit', tool_input: input });
    if (denied(pre)) {
      if (!allowDeny) throw new Error(`unexpected deny on ${p}: ${ctxOf(pre) || pre.text}`);
      return { pre, denied: true, post: null };
    }
    const cur = fs.readFileSync(file, 'utf8');
    if (!cur.includes(oldS)) throw new Error(`edit: old string not found in ${p}`);
    fs.writeFileSync(file, cur.replace(oldS, newS));
    const post = await this.hook('PostToolUse', { tool_name: 'Edit', tool_input: input, tool_response: { success: true } });
    return { pre, post, denied: false };
  }
  async write(p, content, { allowDeny = false } = {}) {
    const file = this.abs(p);
    const input = { file_path: this.hookPathOf(file), content };
    const pre = await this.hook('PreToolUse', { tool_name: 'Write', tool_input: input });
    if (denied(pre)) {
      if (!allowDeny) throw new Error(`unexpected deny on ${p}`);
      return { pre, denied: true, post: null };
    }
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, content);
    const post = await this.hook('PostToolUse', { tool_name: 'Write', tool_input: input, tool_response: { success: true } });
    return { pre, post, denied: false };
  }
  // A shell command: run `effect` (really changes files), then report PostToolUse Bash.
  async bash(command, effect) {
    if (effect) effect(this.wt);
    return this.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command }, tool_response: { stdout: '', stderr: '' } });
  }
  webfetch(url = 'https://example.com/page') {
    return this.hook('PostToolUse', { tool_name: 'WebFetch', tool_input: { url, prompt: 'summarize' }, tool_response: { result: 'page text' } });
  }
  // Retries on index.lock contention (canopyd runs `git status` in agent worktrees; see TEST-REPORT defect D1).
  commit(msg = 'work') {
    for (const args of [['add', '-A'], ['commit', '-q', '--allow-empty', '-m', msg]]) {
      for (let i = 0; ; i++) {
        const r = git(this.wt, ...args);
        if (r.code === 0) break;
        if (i > 30 || !/index\.lock/.test(r.err)) throw new Error(`git ${args[0]} failed: ${r.err}`);
        Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 100);
      }
    }
  }
  revertFile(p) { gitOk(this.wt, 'checkout', 'HEAD', '--', p); }
  land(args = [], opts = {}) { return land(this.wt, this.d.port, args, opts); }
}

// ---- CLI ------------------------------------------------------------------
export function cli(cwd, port, args, { env = {}, input, timeout = 120000 } = {}) {
  const t0 = process.hrtime.bigint();
  const r = spawnSync(process.execPath, [CLI, ...args], { cwd, encoding: 'utf8', timeout, input,
    env: { ...process.env, ...GIT_ENV, CANOPY_PORT: String(port), ...env } });
  const ms = Number(process.hrtime.bigint() - t0) / 1e6;
  let json = null; try { json = JSON.parse(r.stdout); } catch {}
  return { code: r.status, out: r.stdout, err: r.stderr, json, ms };
}
export function land(cwd, port, args = [], opts = {}) {
  return cli(cwd, port, ['land', '--json', ...args], opts);
}

export function pct(arr, p) {
  const s = [...arr].sort((a, b) => a - b);
  return s[Math.min(s.length - 1, Math.floor((p / 100) * s.length))];
}

// Append measured numbers to a JSON-lines file so the report can quote them.
export function recordMetric(name, value) {
  const f = path.join(os.tmpdir(), 'canopy-test-metrics.jsonl');
  fs.appendFileSync(f, JSON.stringify({ name, value, ts: Date.now() }) + '\n');
  console.log(`# METRIC ${name} = ${JSON.stringify(value)}`);
}

// A JS repo whose files all export functions and import one another.
export function genRepo(n, { perDir = 50 } = {}) {
  const dir = tmp('canopy-gen-');
  gitOk(dir, 'init', '-q', '-b', 'main');
  for (let i = 0; i < n; i++) {
    const sub = `mod${Math.floor(i / perDir)}`;
    const dep = i > 0 ? `import { f${i - 1} } from '../mod${Math.floor((i - 1) / perDir)}/m${i - 1}.js';\n` : '';
    const body = `${dep}export function f${i}(x) {\n  const y = x + ${i};\n  return ${i > 0 ? `f${i - 1}(y)` : 'y'} * 2;\n}\nexport function g${i}(a, b) {\n  return a + b + ${i};\n}\n`;
    writeFiles(dir, { [`${sub}/m${i}.js`]: body });
  }
  writeFiles(dir, { '.canopy/rules.json': JSON.stringify({ version: 1, revalidate: 'always', rules: [{ path: '', checks: ['true'] }] }) });
  gitOk(dir, 'add', '-A');
  gitOk(dir, 'commit', '-q', '-m', 'gen');
  return dir;
}

// Standard small JS project used by most scenarios.
// test.js imports every src/*.js and runs each module's exported selfTest() if present.
export const BASE_FILES = {
  'package.json': '{"type":"module"}\n',
  'src/pay.js': "export function charge(amount, currency) {\n  return amount * 100;\n}\nexport function refund(amount) {\n  return charge(amount, 'usd') * -1;\n}\n",
  'src/cart.js': "import { charge } from './pay.js';\nexport function total() {\n  return charge(5, 'usd');\n}\nexport function selfTest() { return total() === 500; }\n",
  'src/util.js': "export function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x));\n}\n",
  'test.js': "import fs from 'node:fs';\nlet bad = 0;\nfor (const f of fs.readdirSync('src').filter((x) => x.endsWith('.js'))) {\n  const m = await import('./src/' + f);\n  if (m.selfTest && m.selfTest() !== true) { console.error('FAIL', f); bad++; }\n}\nprocess.exit(bad ? 1 : 0);\n",
};
export const BASE_RULES = { version: 1, revalidate: 'always', rules: [{ path: '', checks: ['node test.js'] }] };

// Run fn with a fresh repo + daemon on `port`; always kills the daemon.
export async function withDaemon(port, { files = BASE_FILES, rules = BASE_RULES, daemonOpts = {}, repo: given } = {}, fn) {
  const repo = given || mkRepo(files, rules);
  const d = await startDaemon(repo, port, daemonOpts);
  try { return await fn({ d, repo, port }); } finally { d.kill(); }
}

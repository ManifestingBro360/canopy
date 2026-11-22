#!/usr/bin/env node
// canopy — command line for people and agents.
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join, dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const [cmd, ...args] = process.argv.slice(2);
const cwd = process.cwd();
const flag = (name) => { const i = args.indexOf('--' + name); return i < 0 ? null : (args[i + 1] && !args[i + 1].startsWith('--') ? args[i + 1] : true); };
const positional = args.filter((a, i) => !a.startsWith('--') && !(args[i - 1] || '').startsWith('--'));

// Where this repository's state lives. Kept free of the server's imports so every command starts fast.
async function ctx() {
  const { worktreeOf } = await import('../src/git.mjs');
  const wt = worktreeOf(cwd);
  if (!wt) throw new Error('not inside a Git repository: ' + cwd);
  return { ...wt, home: process.env.CANOPY_HOME || join(wt.common, 'canopy') };
}
async function port() {
  if (process.env.CANOPY_PORT) return Number(process.env.CANOPY_PORT);
  const p = await ctx();
  try { return Number(readFileSync(join(p.home, 'port'), 'utf8')); } catch { return 7717; }
}
async function api(method, path, body) {
  const headers = { 'content-type': 'application/json' };
  if (process.env.CANOPY_TOKEN) headers.authorization = 'Bearer ' + process.env.CANOPY_TOKEN;
  let res;
  try { res = await fetch(`http://127.0.0.1:${await port()}${path}`, { method, headers, body: body ? JSON.stringify(body) : undefined }); }
  catch { console.error('canopy: canopyd is not running for this repository. Start it with `canopy serve`.'); process.exit(3); }
  if (res.status === 401) { console.error('canopy: this canopyd requires a token. Set CANOPY_TOKEN to the value it was started with.'); process.exit(3); }
  return res.json();
}
const pct = (x) => Math.round((x || 0) * 100) + '%';
const ago = (ts) => { const s = Math.round((Date.now() - ts) / 1000); return s < 90 ? s + 's' : s < 5400 ? Math.round(s / 60) + 'm' : Math.round(s / 3600) + 'h'; };

function printLanding(r) {
  const rec = r.record || {};
  if (r.status === 'landed') console.log(`LANDED  ${r.commit.slice(0, 10)} on main  (landing ${r.id})`);
  else if (r.status === 'needs-human') console.log(`NEEDS A HUMAN  (landing ${r.id}) - a person approves with: canopy approve ${r.id}`);
  else if (r.status === 'blocked') console.log(`BLOCKED  (landing ${r.id})`);
  else { console.log(r.status ? `${String(r.status).toUpperCase()}  ${r.message || ''}` : `ERROR  ${r.error || 'canopyd gave no answer'}`); return; }
  for (const x of r.reasons || []) console.log('  - ' + x);
  if (rec.write_set) {
    console.log(`  changed: ${rec.write_set.length} symbols/files, ${rec.changed_lines} lines   affects: ${rec.blast}   inspection coverage: ${pct(rec.coverage)}`);
    if (rec.unread && rec.unread.length) console.log('  affected but not read: ' + rec.unread.slice(0, 12).join(', ') + (rec.unread.length > 12 ? ` (+${rec.unread.length - 12} more)` : ''));
    if (rec.stale_assumptions && rec.stale_assumptions.length) console.log('  changed on main since you forked: ' + rec.stale_assumptions.map((s) => `${s.node} [${s.kind}]`).join(', '));
    if (rec.unwitnessed && rec.unwitnessed.length) console.log('  changed with no recorded agent activity: ' + rec.unwitnessed.slice(0, 8).join(', '));
    if (rec.taint && rec.taint.length) console.log('  outside content taken in: ' + rec.taint.join(', '));
    for (const c of rec.checks || []) console.log(`  check ${c.code === 0 ? 'pass' : 'FAIL'}  ${c.cmd}  (${c.ms} ms)`);
    for (const p of rec.perf || []) console.log(`  perf  ${p.ms <= p.max_ms ? 'pass' : 'FAIL'}  ${p.cmd}  ${p.ms} ms / budget ${p.max_ms} ms`);
    if (rec.revalidated) console.log('  ' + rec.revalidated);
  }
  if (r.warning) console.log('  warning: ' + r.warning);
}

// Only the tools Canopy acts on are reported, not every tool call.
const HOOK_EVENTS = { SessionStart: null, UserPromptSubmit: null, PreToolUse: 'Edit|Write|MultiEdit|NotebookEdit',
  PostToolUse: '^(Read|Edit|Write|MultiEdit|NotebookEdit|Grep|Glob|Bash|WebFetch|WebSearch|mcp__.*)$', SessionEnd: null };

const commands = {
  async serve() {
    const { serve } = await import('../src/server.mjs');
    await serve({ cwd, port: Number(flag('port')) || undefined });
  },

  // Wire a repository to Canopy: Claude Code hooks and a starter rules file.
  async init() {
    const p = await ctx();
    const prt = Number(flag('port')) || Number(process.env.CANOPY_PORT) || 7717;
    const sp = join(p.top, '.claude', 'settings.json');
    let settings = {};
    if (existsSync(sp)) { try { settings = JSON.parse(readFileSync(sp, 'utf8')); } catch { console.error(`canopy: ${sp} is not valid JSON; fix it first.`); process.exit(1); } }
    settings.hooks ||= {};
    // Loopback only. If CANOPY_TOKEN is set for both canopyd and the agent, the endpoint requires it.
    const hook = { type: 'http', url: `http://127.0.0.1:${prt}/hook`, timeout: 5, headers: { Authorization: 'Bearer $CANOPY_TOKEN' }, allowedEnvVars: ['CANOPY_TOKEN'] };
    for (const [ev, matcher] of Object.entries(HOOK_EVENTS)) {
      const list = (settings.hooks[ev] ||= []);
      if (list.some((g) => (g.hooks || []).some((h) => h.url === hook.url))) continue;
      list.push(matcher ? { matcher, hooks: [hook] } : { hooks: [hook] });
    }
    mkdirSync(dirname(sp), { recursive: true });
    writeFileSync(sp, JSON.stringify(settings, null, 2) + '\n');
    const rp = join(p.top, '.canopy', 'rules.json');
    if (!existsSync(rp)) {
      mkdirSync(dirname(rp), { recursive: true });
      writeFileSync(rp, JSON.stringify({ version: 1, revalidate: 'always', setup: [], rules: [{ path: '', checks: [], min_coverage: 0 }], protected_globs: [] }, null, 2) + '\n');
    }
    console.log(`wrote ${sp}\nwrote ${rp}\n\nNext:\n  1. Put your test command in .canopy/rules.json under rules[0].checks.\n  2. Commit both files on main.\n  3. Run \`canopy serve\` in this repository and open http://127.0.0.1:${prt}\n  4. Agents work in their own worktrees and run \`canopy land\` when done.`);
  },

  // A generated repository with scripted agents, so the map can be seen working.
  async demo() {
    const { runDemo } = await import('../demo/demo.mjs');
    await runDemo({ port: Number(flag('port')) || 7717, once: !!flag('once'), fast: !!flag('fast') });
  },

  async status() {
    const s = await api('GET', '/api/state');
    console.log(`${s.repo}  ${s.main} @ ${String(s.rev).slice(0, 8)}   ${s.files.length} files`);
    const by = new Map();
    for (const w of s.writes) { const k = `${w.branch} (${w.wt})`; by.set(k, [...(by.get(k) || []), w]); }
    if (!by.size) console.log('nothing in flight');
    for (const [k, ws] of by) {
      console.log(`\n${k}`);
      for (const w of ws.slice(0, 20)) console.log(`  ${w.kind.padEnd(9)} ${w.node}${w.how === 'shell' ? '  (via shell)' : ''}`);
      if (ws.length > 20) console.log(`  ... ${ws.length - 20} more`);
    }
    const open = s.notices.filter((n) => n.open);
    if (open.length) { console.log('\nopen notices'); for (const n of open.slice(0, 10)) console.log(`  [${n.severity}] -> ${n.target}: ${n.body}`); }
  },

  async land() {
    const r = await api('POST', '/api/land', { cwd, intent: typeof flag('task') === 'string' ? flag('task') : undefined });
    if (flag('json')) console.log(JSON.stringify(r, null, 2)); else printLanding(r);
    process.exit(r.status === 'landed' || r.status === 'nothing' ? 0 : r.status === 'needs-human' ? 2 : 1);
  },

  async pending() {
    const list = await api('GET', '/api/pending');
    if (!list.length) return console.log('nothing is waiting for a human');
    for (const l of list) {
      console.log(`${l.id}  ${l.branch}  (${ago(l.ts)} ago)  ${l.intent}`);
      for (const x of l.reasons) console.log('  - ' + x);
      console.log(`  ${l.write_set.length} changed, coverage ${pct(l.coverage)}` + (l.taint.length ? `, outside content: ${l.taint.join(', ')}` : ''));
    }
  },

  async approve() {
    const p = await ctx();
    const id = positional[0];
    if (!id) { console.error('usage: canopy approve <landing-id> [--by name]'); process.exit(1); }
    let token = process.env.CANOPY_HUMAN_TOKEN;
    if (!token) { try { token = readFileSync(join(p.home, 'human.token'), 'utf8').trim(); } catch { /* remote daemon */ } }
    const r = await api('POST', '/api/approve', { id, token, by: flag('by') || process.env.USER || 'human' });
    printLanding(r);
    process.exit(r.status === 'landed' ? 0 : 1);
  },

  async why() {
    const target = positional[0];
    if (!target) { console.error('usage: canopy why <path>[#symbol]'); process.exit(1); }
    const list = await api('GET', '/api/why?target=' + encodeURIComponent(target));
    if (!list.length) return console.log('no landing recorded for ' + target);
    for (const l of list) {
      console.log(`${l.commit.slice(0, 10)}  ${new Date(l.ts).toISOString().slice(0, 16).replace('T', ' ')}  ${l.branch}`);
      console.log(`  intent: ${l.intent}`);
      console.log(`  coverage ${pct(l.coverage)}` + (l.approved_by ? `, approved by ${l.approved_by}` : '') + (l.taint && l.taint.length ? `, outside content: ${l.taint.join(', ')}` : ''));
      for (const c of l.checks) console.log('  ' + c);
      if (l.nodes.length) console.log('  touched: ' + l.nodes.join(', '));
    }
  },

  async wait() {
    const node = positional[0];
    if (!node) { console.error("usage: canopy wait '<path>#<symbol>' [--minutes n]"); process.exit(1); }
    const until = Date.now() + (Number(flag('minutes')) || 10) * 60_000;
    let r = { free: false };
    // Ask in short requests so a long wait cannot hit an HTTP timeout.
    while (!r.free && Date.now() < until) r = await api('GET', `/api/wait?node=${encodeURIComponent(node)}&cwd=${encodeURIComponent(cwd)}&ms=${Math.max(1000, Math.min(60_000, until - Date.now()))}`);
    if (r.free && r.held === false) console.log(`No other branch has an unlanded change to ${node}.`);
    else console.log(r.free ? `${node} is free. Run \`git merge main\` to pick up what landed.` : `${node} is still held after the wait.`);
    process.exit(r.free ? 0 : 1);
  },

  async 'clear-taint'() {
    const p = await ctx();
    let token = process.env.CANOPY_HUMAN_TOKEN;
    if (!token) { try { token = readFileSync(join(p.home, 'human.token'), 'utf8').trim(); } catch { /* remote daemon */ } }
    const r = await api('POST', '/api/clear-taint', { cwd, token });
    console.log(r.status === 'ok' ? 'this worktree is no longer marked as having taken in outside content' : r.message);
  },

  async release() { await api('POST', '/api/release', { cwd }); console.log('released this worktree\'s holds and in-flight record'); },
  async stats() { console.log(JSON.stringify(await api('GET', '/api/stats'), null, 2)); },
  async pubkey() { const p = await ctx(); process.stdout.write(readFileSync(join(p.home, 'pub.pem'), 'utf8')); },

  // Make a bare repository accept `main` only through signed landings.
  async 'protect'() {
    const bare = positional[0] && resolve(positional[0]);
    if (!bare || !existsSync(join(bare, 'hooks'))) { console.error('usage: canopy protect <path-to-bare-repo>   (run in the repository canopyd serves)'); process.exit(1); }
    const p = await ctx();
    const { execFileSync } = await import('node:child_process');
    const { mainRef } = await import('../src/git.mjs');
    const { loadOrCreateKey } = await import('../src/sign.mjs');
    const key = loadOrCreateKey(p.home);
    execFileSync('git', ['-C', bare, 'config', 'canopy.pubkey', Buffer.from(key.pub).toString('base64')]);
    execFileSync('git', ['-C', bare, 'config', 'canopy.main', mainRef(p.top)]);
    const hp = join(bare, 'hooks', 'pre-receive');
    writeFileSync(hp, `#!/bin/sh\nexec node ${JSON.stringify(join(ROOT, 'hooks', 'pre-receive.mjs'))}\n`);
    chmodSync(hp, 0o755);
    console.log(`${bare} now accepts ${mainRef(p.top)} only through landings signed by key ${key.id}`);
  },
};

if (!cmd || !commands[cmd]) {
  console.log(`canopy - coordination and landing for parallel coding agents

  canopy init                  wire this repository (Claude Code hooks, starter rules)
  canopy serve [--port n]      run canopyd and the live map
  canopy demo [--port n]       generated repo with scripted agents, to see it working
  canopy status                who is changing what
  canopy land [--task "..."]   judge this branch and land it on main
  canopy pending               landings waiting for a human
  canopy approve <id>          approve one of them
  canopy why <path>[#symbol]   why this code is the way it is
  canopy wait '<path>#<sym>'   block until another agent's change to it lands
  canopy release               drop this worktree's holds
  canopy clear-taint           (a person) forget that this worktree took in outside content
  canopy protect <bare-repo>   make a canonical repo accept main only via signed landings
  canopy stats | pubkey`);
  process.exit(cmd ? 1 : 0);
}
commands[cmd]().catch((e) => { console.error('canopy: ' + (e.message || e)); process.exit(1); });

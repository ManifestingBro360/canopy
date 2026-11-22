// Regression tests for defects found in review. Each test names the defect it pins.
import { test, before, after } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, readFileSync, realpathSync, symlinkSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join, dirname } from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const CAN = join(dirname(fileURLToPath(import.meta.url)), '..', 'bin', 'canopy.mjs');
const PORT = 7860;
const URL_ = `http://127.0.0.1:${PORT}`;
const env = { ...process.env, CANOPY_PORT: String(PORT), GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' };
delete env.CANOPY_HOME; delete env.CANOPY_TOKEN;
const sh = (cwd, cmd, ...args) => execFileSync(cmd, args, { cwd, env, encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'] }).trim();
const git = (cwd, ...a) => sh(cwd, 'git', ...a);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const post = async (path, body) => (await fetch(URL_ + path, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) })).json();
const get = async (path) => (await fetch(URL_ + path)).json();

let base, repo, daemon, n = 0;
const write = (root, p, s) => { mkdirSync(dirname(join(root, p)), { recursive: true }); writeFileSync(join(root, p), s); };
const commit = (wt, m) => { git(wt, 'add', '-A'); git(wt, 'commit', '-qm', m); };
const RULES = (extra = {}) => JSON.stringify({ version: 1, rules: [{ path: '', checks: ['node test.js'] }, { path: 'secure/', no_tainted: true }], ...extra }) + '\n';

async function start() {
  daemon = spawn('node', [CAN, 'serve'], { cwd: repo, env, stdio: 'ignore' });
  for (let i = 0; i < 100; i++) { try { await get('/api/stats'); return; } catch { await sleep(50); } }
  throw new Error('canopyd did not start');
}
// A fresh agent: its own worktree, branch and session.
function agent(name) {
  const branch = `${name}-${++n}`, wt = join(base, branch);
  git(repo, 'worktree', 'add', '-q', wt, '-b', branch);
  const hook = (ev, tool, input) => post('/hook', { session_id: 's-' + branch, cwd: wt, hook_event_name: ev, tool_name: tool, tool_input: input || {} });
  return {
    wt, branch,
    read: (p, extra = {}) => hook('PostToolUse', 'Read', { file_path: join(wt, p), ...extra }),
    edit: async (p, text) => { write(wt, p, text); return hook('PostToolUse', 'Edit', { file_path: join(wt, p) }); },
    pre: (p, old) => hook('PreToolUse', 'Edit', { file_path: join(wt, p), old_string: old }),
    hook,
    commit: (m = 'work') => commit(wt, m),
    land: () => post('/api/land', { cwd: wt }),
    start: () => hook('SessionStart'),
  };
}
const state = () => get('/api/state');
const denied = (r) => r.hookSpecificOutput && r.hookSpecificOutput.permissionDecision === 'deny';

before(async () => {
  base = realpathSync(mkdtempSync(join(tmpdir(), 'canopy-reg-')));
  repo = join(base, 'repo');
  mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'main');
  write(repo, 'src/pay.js', 'export function charge(amount, currency) {\n  if (!currency) throw new Error("currency");\n  return amount;\n}\nexport function refund(amount) {\n  return -amount;\n}\n');
  write(repo, 'src/checkout.js', "import { charge } from './pay.js';\nexport function checkout(n) {\n  return charge(n, 'usd');\n}\n");
  write(repo, 'src/big.js', Array.from({ length: 2600 }, (_, i) => (i === 0 ? "import { refund } from './pay.js';\nexport function big() {" : i === 2599 ? '  return refund(1);\n}' : `  // line ${i}`)).join('\n') + '\n');
  write(repo, 'secure/keys.js', 'export function rotate() {\n  return 1;\n}\n');
  write(repo, 'docs/notes.md', 'notes\n');
  write(repo, 'test/café.test.js', 'a();\nb();\nc();\n');
  write(repo, 'test.js', "import { readdirSync } from 'node:fs';\nfor (const f of readdirSync('./src')) { const m = await import('./src/' + f); if (m.selfTest) m.selfTest(); }\nconsole.log('ok');\n");
  write(repo, '.canopy/rules.json', RULES());
  commit(repo, 'init');
  await start();
});
after(() => { if (daemon) daemon.kill(); rmSync(base, { recursive: true, force: true }); });

test('a branch is measured against its fork point, not against a main that moved', async () => {
  const A = agent('sig'), B = agent('refund');
  await A.read('src/pay.js'); await A.read('src/checkout.js'); await A.read('src/big.js');
  await A.edit('src/pay.js', readFileSync(join(A.wt, 'src/pay.js'), 'utf8').replace('charge(amount, currency)', 'charge(amount, currency, fee)'));
  A.commit(); assert.equal((await A.land()).status, 'landed');
  await B.edit('src/pay.js', readFileSync(join(B.wt, 'src/pay.js'), 'utf8').replace('return -amount;', 'return 0 - amount;'));
  const mine = (await state()).writes.filter((w) => w.branch === B.branch).map((w) => `${w.node}[${w.kind}]`);
  assert.deepEqual(mine, ['src/pay.js#refund[body]']);
});

test('revalidate "disjoint" still re-runs checks when main changed something the branch calls', async () => {
  write(repo, '.canopy/rules.json', RULES({ revalidate: 'disjoint' }).replace('node test.js', 'sleep 1.2 && node test.js'));
  commit(repo, 'slow checks, disjoint'); await post('/api/refresh', {});
  const A = agent('fee'), B = agent('invoice');
  await A.read('src/pay.js'); await A.read('src/checkout.js'); await A.read('src/big.js');
  await A.edit('src/pay.js', readFileSync(join(A.wt, 'src/pay.js'), 'utf8').replace(/charge\(amount, currency(, fee)?\) \{/, 'charge(amount, currency, fee, tax) {\n  if (tax === undefined) throw new Error("tax");'));
  await A.edit('src/checkout.js', readFileSync(join(A.wt, 'src/checkout.js'), 'utf8').replace("charge(n, 'usd')", "charge(n, 'usd', 0, 0)"));
  await B.edit('src/invoice.js', "import { charge } from './pay.js';\nexport function invoice(n) {\n  return charge(n, 'usd');\n}\nexport function selfTest() {\n  invoice(1);\n}\n");
  A.commit(); B.commit();
  const [ra, rb] = await Promise.all([A.land(), sleep(300).then(() => B.land())]);
  assert.equal(ra.status, 'landed');
  assert.equal(rb.status, 'blocked', 'B calls charge the old way; its checks must run again on the new main');
  assert.equal(sh(repo, 'node', 'test.js'), 'ok', 'main still passes its own check');
  write(repo, '.canopy/rules.json', RULES()); commit(repo, 'fast checks'); await post('/api/refresh', {});
});

test('taint survives a release and a landing', async () => {
  const A = agent('tainted');
  await A.hook('PostToolUse', 'WebFetch', { url: 'https://example.com/x' });
  await A.edit('docs/notes.md', 'notes 2\n'); A.commit();
  assert.equal((await A.land()).status, 'landed');
  await A.edit('secure/keys.js', 'export function rotate() {\n  return 2;\n}\n'); A.commit();
  assert.equal((await A.land()).status, 'needs-human');
  await post('/api/release', { cwd: A.wt });
  await A.edit('secure/keys.js', 'export function rotate() {\n  return 3;\n}\n'); A.commit();
  const r = await A.land();
  assert.equal(r.status, 'needs-human');
  assert.ok(r.record.taint.some((t) => t.startsWith('web:')));
});

test('shrinking a test needs a person whatever the file is called', async () => {
  const A = agent('tests');
  await A.edit('test/café.test.js', 'a();\n'); A.commit();
  const r = await A.land();
  assert.equal(r.status, 'needs-human');
  assert.deepEqual(r.record.test_reductions, ['test/café.test.js']);
});

test('a branch cannot land a broken rules file, and broken rules on main can be repaired', async () => {
  const A = agent('badrules');
  await A.edit('.canopy/rules.json', '{ "rules": [ { "path": "", "min_coverage": "0.8" } ] }\n'); A.commit();
  const r = await A.land();
  assert.equal(r.status, 'blocked');
  assert.match(r.reasons[0], /min_coverage must be a number/);
  // Break main directly, as a person with push rights could.
  const good = readFileSync(join(repo, '.canopy/rules.json'), 'utf8');
  write(repo, '.canopy/rules.json', 'null\n'); commit(repo, 'break rules'); await post('/api/refresh', {});
  const B = agent('other');
  await B.edit('docs/notes.md', 'x\n'); B.commit();
  assert.equal((await B.land()).status, 'blocked');
  const C = agent('repair');
  await C.edit('.canopy/rules.json', good); C.commit();
  const rc = await C.land();
  assert.equal(rc.status, 'needs-human');
  const token = readFileSync(join(repo, '.git', 'canopy', 'human.token'), 'utf8').trim();
  assert.equal((await post('/api/approve', { id: rc.id, token, by: 'tester' })).status, 'landed');
});

test('two lands of the same commit produce one landing', async () => {
  const A = agent('twice');
  await A.edit('docs/notes.md', 'twice\n'); A.commit();
  const before_ = git(repo, 'rev-list', '--count', 'main');
  const rs = await Promise.all([A.land(), A.land()]);
  assert.deepEqual(rs.map((r) => r.status).sort(), ['landed', 'nothing']);
  assert.equal(Number(git(repo, 'rev-list', '--count', 'main')) - Number(before_), 2, 'one merge commit plus the branch commit');
});

test('work merged into main by hand releases its hold', async () => {
  const A = agent('manual'), B = agent('waiter');
  await A.edit('src/checkout.js', readFileSync(join(A.wt, 'src/checkout.js'), 'utf8').replace('export function checkout(n) {', 'export function checkout(n) {\n  // by hand')); A.commit();
  assert.ok(denied(await B.pre('src/checkout.js', 'export function checkout(n) {')), 'held while unlanded');
  git(repo, 'merge', '-q', '--no-ff', A.branch, '-m', 'manual merge'); await post('/api/refresh', {});
  assert.ok(!(await state()).holds.some((h) => h.node === 'src/checkout.js#checkout'));
});

test('a long file read in pieces counts as read', async () => {
  const A = agent('chunks');
  await A.read('src/big.js', { offset: 1, limit: 2000 }); await A.read('src/big.js', { offset: 2001, limit: 2000 }); await A.read('src/pay.js');
  await A.edit('src/pay.js', readFileSync(join(A.wt, 'src/pay.js'), 'utf8').replace(/export function refund\(amount\) \{/, 'export function refund(amount) {\n  // touched'));
  A.commit();
  const r = await A.land();
  assert.ok(!r.record.unread.includes('src/big.js#big'), 'big() was read across two calls');
});

test('a "landed" notice closes once the branch has merged main', async () => {
  const R = agent('reader'), A = agent('mover');
  await R.read('src/pay.js'); await A.read('src/pay.js'); await A.read('src/checkout.js'); await A.read('src/big.js');
  const src = readFileSync(join(A.wt, 'src/pay.js'), 'utf8');
  await A.edit('src/pay.js', src.replace(/export function refund\(([^)]*)\)/, 'export function refund($1, reason)')); A.commit();
  assert.equal((await A.land()).status, 'landed');
  const open = async () => (await state()).notices.filter((x) => x.open && x.kind === 'landed' && x.target === R.branch).length;
  assert.ok(await open() > 0);
  git(R.wt, 'merge', '-q', 'main'); await R.start();
  assert.equal(await open(), 0);
});

test('nothing is recorded for paths outside the repository or inside .git', async () => {
  const A = agent('outside');
  const out = join(base, 'elsewhere'); mkdirSync(out); writeFileSync(join(out, 'secret.js'), 'export function secret() {}\n');
  symlinkSync(out, join(A.wt, 'vendorlink'));
  await A.read('vendorlink/secret.js'); await A.hook('PostToolUse', 'Edit', { file_path: join(A.wt, 'vendorlink/secret.js') });
  await A.read('.git'); await A.hook('PostToolUse', 'Read', { file_path: join(repo, '.git', 'config') });
  const s = await state();
  assert.ok(!s.writes.some((w) => w.branch === A.branch));
  assert.ok(!s.reads.some((r) => r.wt === A.branch));
});

// Found in a trial with real agents: callers who were warned that a function was
// being reshaped on another branch chose, reasonably, to keep coding against
// main. The author of the reshaping was never told new callers existed until
// their own landing was refused. The author is the one who can act.
const ctxOf = (r) => (r.hookSpecificOutput && r.hookSpecificOutput.additionalContext) || '';

test('the author of a breaking change is told when another branch writes a new caller', async () => {
  const A = agent('reshape'), B = agent('caller');
  await A.edit('src/pay.js', readFileSync(join(A.wt, 'src/pay.js'), 'utf8').replace(/export function refund\(([^)]*)\)/, 'export function refund($1, nw7)'));
  await B.edit('src/jobs.js', "import { refund } from './pay.js';\nexport function nightly(n) {\n  return refund(n);\n}\n");
  // Other tests in this file leave notices for the same function; read until ours has come through.
  let told = '';
  for (let i = 0; i < 6 && !/src\/jobs\.js/.test(told); i++) told += ctxOf(await A.read('src/pay.js'));
  assert.match(told, /is writing new code in src\/jobs\.js that uses src\/pay\.js#refund/);
  assert.match(told, /requires a new argument with no default \(.nw7.\)/);
  assert.match(told, /keep the old form working/);
});

test('the author of a breaking change is told when a new caller lands on main', async () => {
  const A = agent('reshape2'), B = agent('caller2');
  await A.edit('src/pay.js', readFileSync(join(A.wt, 'src/pay.js'), 'utf8').replace(/export function refund\(([^)]*)\)/, 'export function refund($1, why)'));
  await B.edit('src/jobs2.js', "import { refund } from './pay.js';\nexport function weekly(n) {\n  return refund(n);\n}\n");
  await A.read('src/pay.js'); // takes the in-flight notice, so the next one is about the landing
  B.commit(); assert.equal((await B.land()).status, 'landed');
  const told = ctxOf(await A.read('src/checkout.js'));
  assert.match(told, /uses src\/pay\.js#refund just landed on main/);
  assert.match(told, /src\/jobs2\.js/);
  assert.match(told, /git merge main/);
});

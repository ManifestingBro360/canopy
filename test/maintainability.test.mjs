// MAINTAINABILITY: dependencies, size, and the README quick-start. Port 7818 (demo) and 7819 (use-on-a-repo flow).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as H from './helpers.mjs';

test('M1 dependency count (package.json)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'package.json'), 'utf8'));
  const n = (o) => Object.keys(o || {}).length;
  const deps = { dependencies: n(pkg.dependencies), devDependencies: n(pkg.devDependencies), optionalDependencies: n(pkg.optionalDependencies), peerDependencies: n(pkg.peerDependencies) };
  H.recordMetric('M1_dependencies', deps);
  assert.equal(Object.values(deps).reduce((a, b) => a + b, 0), 0);
  assert.equal(fs.existsSync(path.join(H.ROOT, 'node_modules')), false, 'no node_modules present');
  assert.equal(fs.existsSync(path.join(H.ROOT, 'package-lock.json')), false);
  // every bare import specifier in source is a node: built-in
  const bare = new Set();
  for (const f of walk(H.ROOT).filter((x) => /\.(mjs|js)$/.test(x) && !x.includes('/test/'))) {
    for (const m of fs.readFileSync(f, 'utf8').matchAll(/(?:from|import\()\s*['"]([^'"./][^'"]*)['"]/g)) if (!/[${}]/.test(m[1])) bare.add(m[1]);
  }
  H.recordMetric('M1_bare_import_specifiers', [...bare].sort());
  assert.deepEqual([...bare].filter((s) => !s.startsWith('node:')), [], 'non-builtin imports present');
});

function walk(dir, out = []) {
  for (const e of fs.readdirSync(dir, { withFileTypes: true })) {
    if (e.name === 'node_modules' || e.name === '.git') continue;
    const p = path.join(dir, e.name);
    if (e.isDirectory()) walk(p, out); else out.push(p);
  }
  return out;
}

test('M2 source size (wc -l) and engine requirements', () => {
  const lines = (f) => fs.readFileSync(f, 'utf8').split('\n').length - (fs.readFileSync(f, 'utf8').endsWith('\n') ? 1 : 0);
  const groups = { 'src/*.mjs': 0, 'bin/*.mjs': 0, 'hooks/*.mjs': 0, 'ui/index.html': 0, 'demo/demo.mjs': 0 };
  const per = {};
  for (const f of walk(H.ROOT)) {
    const rel = path.relative(H.ROOT, f);
    if (/^src\/.*\.mjs$/.test(rel)) { groups['src/*.mjs'] += lines(f); per[rel] = lines(f); }
    else if (/^bin\/.*\.mjs$/.test(rel)) groups['bin/*.mjs'] += lines(f);
    else if (/^hooks\/.*\.mjs$/.test(rel)) groups['hooks/*.mjs'] += lines(f);
    else if (rel === 'ui/index.html') groups['ui/index.html'] += lines(f);
    else if (rel === 'demo/demo.mjs') groups['demo/demo.mjs'] += lines(f);
  }
  const wc = spawnSync('sh', ['-c', "wc -l src/*.mjs bin/*.mjs hooks/*.mjs | tail -1"], { cwd: H.ROOT, encoding: 'utf8' }).stdout.trim();
  const testLines = walk(path.join(H.ROOT, 'test')).filter((f) => f.endsWith('.mjs')).reduce((n, f) => n + lines(f), 0);
  H.recordMetric('M2_lines', { ...groups, per_file: per, wc_src_bin_hooks_total: wc, test_suite_lines: testLines });
  const pkg = JSON.parse(fs.readFileSync(path.join(H.ROOT, 'package.json'), 'utf8'));
  assert.equal(pkg.engines.node, '>=22.13');
  assert.ok(process.versions.node.split('.').map(Number)[0] >= 22);
});

test('M3 README quick-start: `node bin/canopy.mjs demo` serves a page and plays scripted agents against the real gate', { timeout: 120000 }, async () => {
  // README says open http://127.0.0.1:7717; the suite uses --port 7818 (reserved range), the command is otherwise as written.
  const child = spawn(process.execPath, [H.CLI, 'demo', '--port', '7818'], { env: { ...process.env, ...H.GIT_ENV }, stdio: ['ignore', 'pipe', 'pipe'] });
  let log = ''; child.stdout.on('data', (x) => { log += x; }); child.stderr.on('data', (x) => { log += x; });
  try {
    const up = await H.waitFor(async () => { try { return (await H.httpJson(7818, 'GET', '/')).status === 200; } catch { return false; } }, { timeout: 15000 });
    assert.ok(up.value, 'page served at / : ' + log);
    const page = await H.httpJson(7818, 'GET', '/');
    assert.match(page.text, /<html|<!doctype/i);
    H.recordMetric('M3_demo_ready_ms', up.ms);
    const st = await H.waitFor(async () => { const s = (await H.httpJson(7818, 'GET', '/api/state')).json; return s?.landings?.length > 0 ? s : null; }, { timeout: 90000, step: 500 });
    assert.ok(st.value, 'scripted agents produced at least one landing record within 90 s. log: ' + log.slice(-400));
    const s = (await H.httpJson(7818, 'GET', '/api/state')).json;
    H.recordMetric('M3_demo_state', { first_landing_after_ms: st.ms, landings: s.landings.length, statuses: [...new Set(s.landings.map((l) => l.status))], sessions: s.sessions.length, notices: s.notices.length, files: s.files.length });
    H.recordMetric('M3_demo_log_head', log.slice(0, 400));
  } finally { child.kill('SIGKILL'); }
});

test('M4 README "use it on a repository" steps, run as written', { timeout: 120000 }, async () => {
  const notes = {};
  // `canopy` as a bare command
  notes.canopy_on_PATH = spawnSync('sh', ['-c', 'command -v canopy'], { encoding: 'utf8' }).stdout.trim() || 'not found';
  const parent = H.tmp('qs-'); const repo = path.join(parent, 'repo'); fs.mkdirSync(repo); H.gitOk(repo, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(repo, 'package.json'), '{"type":"module"}\n');
  fs.writeFileSync(path.join(repo, 'app.js'), 'export function add(a, b) {\n  return a + b;\n}\n');
  fs.writeFileSync(path.join(repo, 'test.js'), "import { add } from './app.js';\nprocess.exit(add(1, 2) === 3 ? 0 : 1);\n");
  H.gitOk(repo, 'add', '-A'); H.gitOk(repo, 'commit', '-q', '-m', 'init');
  // 1. canopy init  (with CANOPY_PORT set to a test port)
  const init = H.cli(repo, 7819, ['init']);
  assert.equal(init.code, 0, init.err);
  assert.ok(fs.existsSync(path.join(repo, '.claude/settings.json')) && fs.existsSync(path.join(repo, '.canopy/rules.json')));
  const urls = [...fs.readFileSync(path.join(repo, '.claude/settings.json'), 'utf8').matchAll(/"url":\s*"([^"]+)"/g)].map((m) => m[1]);
  notes.init_hook_urls = [...new Set(urls)];
  notes.init_honours_CANOPY_PORT = urls.every((u) => u.includes(':7819/'));
  // 2. "Put your test command in .canopy/rules.json under rules[0].checks. Commit both files on main."
  const rules = JSON.parse(fs.readFileSync(path.join(repo, '.canopy/rules.json'), 'utf8'));
  notes.init_rules_checks_before = rules.rules[0].checks;
  rules.rules[0].checks = ['node test.js'];
  fs.writeFileSync(path.join(repo, '.canopy/rules.json'), JSON.stringify(rules, null, 2));
  H.gitOk(repo, 'add', '-A'); H.gitOk(repo, 'commit', '-q', '-m', 'canopy');
  // 3. canopy serve
  const d = await H.startDaemon(repo, 7819);
  try {
    // 4. git worktree add ../wt-refunds -b feat/refunds
    const wt = path.join(parent, 'wt-refunds');
    H.gitOk(repo, 'worktree', 'add', '-q', wt, '-b', 'feat/refunds');
    fs.writeFileSync(path.join(wt, 'app.js'), 'export function add(a, b) {\n  return a + b + 0;\n}\n');
    H.gitOk(wt, 'commit', '-qam', 'refund tweak');
    // 5. canopy status / canopy land
    const status = H.cli(wt, 7819, ['status']); notes.status_exit = status.code;
    const r = H.land(wt, 7819);
    notes.land = { exit: r.code, status: r.json?.status, reasons: r.json?.reasons, taint: r.json?.record?.taint };
    notes.land_human_readable = H.cli(wt, 7819, ['land']).out.slice(0, 300);
    const pend = H.cli(wt, 7819, ['pending']); notes.pending_exit = pend.code;
    const why = H.cli(wt, 7819, ['why', 'app.js#add']); notes.why_exit = why.code; notes.why_out = why.out.slice(0, 200);
    const rel = H.cli(wt, 7819, ['release']); notes.release_exit = rel.code;
    const stats = H.cli(wt, 7819, ['stats']); notes.stats_exit = stats.code;
    const pk = H.cli(wt, 7819, ['pubkey']); notes.pubkey_exit = pk.code;
    H.recordMetric('M4_quickstart_notes', notes);
    assert.equal(notes.land.status, 'landed');
    // Changed after defect D6 was fixed: the README now gives an install step (`npm link`).
    // This test cannot install globally, so it checks the step is documented instead.
    assert.match(fs.readFileSync(path.join(H.ROOT || path.join(path.dirname(H.CLI), '..'), 'README.md'), 'utf8'), /npm link/, 'README gives an install step for the bare `canopy` command');
  } finally { d.kill(); }
});

test('M5 one process, one data file', async () => {
  const repo = H.mkRepo(H.BASE_FILES, H.BASE_RULES);
  await H.withDaemon(7819, { repo }, async ({ d }) => {
    const A = new H.Agent(d, repo, 'a'); await A.start(); await A.read('src/pay.js');
    const kids = spawnSync('pgrep', ['-P', String(d.child.pid)], { encoding: 'utf8' }).stdout.trim().split('\n').filter(Boolean);
    const home = path.join(repo, '.git', 'canopy');
    const files = fs.readdirSync(home);
    H.recordMetric('M5_process_and_files', { child_processes_of_daemon_at_idle: kids.length, state_dir_files: files, sqlite_main_files: files.filter((f) => /\.db$/.test(f)), stderr_warnings: /warning/i.test(d.log) });
    assert.equal(kids.length, 0);
    assert.equal(files.filter((f) => /\.db$/.test(f)).length, 1);
  });
});

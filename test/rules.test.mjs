// Remaining documented rule keys: min_coverage, max_changed_lines, protected, protected_globs, perf, setup, no_unwitnessed. Port 7823.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './helpers.mjs';

const PORT = 7823;
const FILES = {
  'package.json': '{"type":"module"}\n',
  'src/core.js': 'export function core(x) {\n  return x + 1;\n}\n',
  'src/user1.js': "import { core } from './core.js';\nexport function u1() {\n  return core(1);\n}\n",
  'src/user2.js': "import { core } from './core.js';\nexport function u2() {\n  return core(2);\n}\n",
  'src/auth/login.js': 'export function login() {\n  return true;\n}\n',
  'infra/deploy.sh': 'echo deploy\n',
  'src/big/big.js': 'export function big() {\n  return 1;\n}\n',
};
const rules = (extra = {}) => ({ version: 1, revalidate: 'always', rules: [{ path: '', checks: ['true'] }, { path: 'src/', min_coverage: 0.8 }, { path: 'src/auth/', protected: true }, { path: 'src/big/', max_changed_lines: 10 }], protected_globs: ['infra/**'], ...extra });
const go = (r, fn) => H.withDaemon(PORT, { files: FILES, rules: r }, async (ctx) => {
  const A = new H.Agent(ctx.d, ctx.repo, 'a'); await A.start(); await fn(A, ctx); A.commit('x');
  const res = A.land(); return { res, status: res.json?.status, reasons: (res.json?.reasons || []).join(' | '), rec: res.json?.record };
});

test('R1 min_coverage: unread dependents -> needs a person; reading them first -> lands', async () => {
  const bad = await go(rules(), async (A) => { await A.read('src/core.js'); await A.edit('src/core.js', 'export function core(x) {', 'export function core(x, y = 0) {'); });
  assert.equal(bad.status, 'needs-human'); assert.match(bad.reasons, /coverage/);
  H.recordMetric('R1_unread_case', { coverage: bad.rec?.coverage, unread: bad.rec?.unread, reasons: bad.reasons });
  const good = await go(rules(), async (A) => { for (const f of ['src/core.js', 'src/user1.js', 'src/user2.js']) await A.read(f); await A.edit('src/core.js', 'export function core(x) {', 'export function core(x, y = 0) {'); });
  H.recordMetric('R1_read_case', { status: good.status, coverage: good.rec?.coverage, reasons: good.reasons });
  assert.equal(good.status, 'landed', good.reasons);
});

test('R2 max_changed_lines: over the limit needs a person; under lands', async () => {
  const big = await go(rules(), async (A) => { await A.write('src/big/big.js', 'export function big() {\n' + Array.from({ length: 30 }, (_, i) => `  const v${i} = ${i};`).join('\n') + '\n  return 1;\n}\n'); });
  assert.equal(big.status, 'needs-human'); assert.match(big.reasons, /changed lines|exceeds/);
  const small = await go(rules(), async (A) => { await A.read('src/big/big.js'); await A.edit('src/big/big.js', 'return 1;', 'return 2;'); });
  assert.equal(small.status, 'landed', small.reasons);
});

test('R3 protected section and protected_globs: any change needs a person', async () => {
  const a = await go(rules(), async (A) => { await A.read('src/auth/login.js'); await A.edit('src/auth/login.js', 'return true;', 'return false;'); });
  assert.equal(a.status, 'needs-human'); assert.match(a.reasons, /protected/);
  const b = await go(rules(), async (A) => { await A.write('infra/deploy.sh', 'echo deploy2\n'); });
  assert.equal(b.status, 'needs-human'); assert.match(b.reasons, /infra\/deploy\.sh/);
});

test('R4 perf budget: a command over its time budget does not land silently', async () => {
  const r = rules(); r.rules[0].perf = [{ cmd: 'sleep 0.5', max_ms: 100 }];
  const x = await go(r, async (A) => { await A.read('src/big/big.js'); await A.edit('src/big/big.js', 'return 1;', 'return 2;'); });
  H.recordMetric('R4_perf_over_budget', { status: x.status, reasons: x.reasons, perf: x.rec?.perf });
  assert.notEqual(x.status, 'landed');
  const ok = rules(); ok.rules[0].perf = [{ cmd: 'true', max_ms: 2000 }];
  const y = await go(ok, async (A) => { await A.read('src/big/big.js'); await A.edit('src/big/big.js', 'return 1;', 'return 2;'); });
  assert.equal(y.status, 'landed', y.reasons);
});

test('R5 setup commands run before checks (and a failing setup blocks)', async () => {
  // Changed after the sandbox was tightened (defect D3): setup and checks can write only inside
  // their checkout, so the marker lives there and the check itself proves setup ran first.
  const r = rules({ setup: ['echo setup >> setup-marker'] }); r.rules[0].checks = ['test -s setup-marker'];
  const x = await go(r, async (A) => { await A.read('src/big/big.js'); await A.edit('src/big/big.js', 'return 1;', 'return 2;'); });
  assert.equal(x.status, 'landed', x.reasons + ' ' + (x.res.out || '').slice(0, 200));
  const f = rules({ setup: ['exit 3'] });
  const y = await go(f, async (A) => { await A.read('src/big/big.js'); await A.edit('src/big/big.js', 'return 1;', 'return 2;'); });
  assert.equal(y.status, 'blocked', y.reasons);
});

test('R6 no_unwitnessed: a file changed with no recorded agent activity needs a person', async () => {
  const r = rules(); r.rules[0].no_unwitnessed = true;
  const x = await go(r, async (A) => { fs.writeFileSync(A.abs('src/big/big.js'), 'export function big() {\n  return 9;\n}\n'); });
  assert.equal(x.status, 'needs-human'); assert.match(x.reasons, /no recorded agent activity/);
});

test('R7 rules are inherited and only tighten: a deeper rule cannot loosen a parent rule', async () => {
  const r = { version: 1, rules: [{ path: '', checks: ['exit 1'] }, { path: 'src/big/', checks: ['true'], max_changed_lines: 1000 }] };
  const x = await go(r, async (A) => { await A.read('src/big/big.js'); await A.edit('src/big/big.js', 'return 1;', 'return 2;'); });
  assert.equal(x.status, 'blocked', 'parent check still applies: ' + x.reasons);
});

test('R8 malformed rules.json on main blocks landing instead of landing unchecked', async () => {
  const repo = H.mkRepo(FILES, null);
  fs.mkdirSync(path.join(repo, '.canopy')); fs.writeFileSync(path.join(repo, '.canopy/rules.json'), '{ not json');
  H.gitOk(repo, 'add', '-A'); H.gitOk(repo, 'commit', '-qm', 'bad rules');
  await H.withDaemon(PORT, { repo }, async ({ d }) => {
    const A = new H.Agent(d, repo, 'a'); await A.start(); await A.edit('src/big/big.js', 'return 1;', 'return 2;'); A.commit('x');
    const r = A.land(); H.recordMetric('R8_malformed_rules', { code: r.code, status: r.json?.status, reasons: r.json?.reasons });
    assert.notEqual(r.json?.status, 'landed');
  });
});

test('R9 repo with NO .canopy/rules.json: what does landing do?', async () => {
  const repo = H.mkRepo(FILES, null);
  await H.withDaemon(PORT, { repo }, async ({ d }) => {
    const A = new H.Agent(d, repo, 'a'); await A.start(); await A.edit('src/big/big.js', 'return 1;', 'return 2;'); A.commit('x');
    const r = A.land(); H.recordMetric('R9_no_rules_file', { code: r.code, status: r.json?.status, reasons: r.json?.reasons });
    assert.ok(['landed', 'blocked', 'needs-human'].includes(r.json?.status), r.out + r.err);
  });
});

test('R10 a rule path that is a string prefix but not a directory prefix (`src/core` vs src/core.js) -- does it apply?', async () => {
  const r = { version: 1, rules: [{ path: '', checks: ['true'] }, { path: 'src/core', protected: true }] };
  const x = await go(r, async (A) => { await A.read('src/core.js'); await A.edit('src/core.js', 'return x + 1;', 'return x + 2;'); });
  H.recordMetric('R10_string_prefix_rule', { status: x.status, reasons: x.reasons });
  // Changed after defect D5: the README was ambiguous and now says a rule path is a folder or an
  // exact file, not a text prefix. `src/core` covers the folder src/core/, not the file src/core.js.
  assert.equal(x.status, 'landed', 'a rule path is a folder or an exact file, not a text prefix');
});

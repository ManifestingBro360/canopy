// CONTEXT pillar. Port 7813.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';

const PORT = 7813;
const FILES = {
  ...H.BASE_FILES,
  'src/payments/ledger.js': 'export function post(entry) {\n  return entry.amount;\n}\nexport function void_(entry) {\n  return -entry.amount;\n}\n',
  'src/auth/login.js': 'export function login(u) {\n  return u.length > 0;\n}\n',
};
const RULES = {
  version: 1, revalidate: 'always',
  rules: [
    { path: '', checks: ['node test.js'], max_changed_lines: 800 },
    { path: 'src/payments/', min_coverage: 0.8, no_tainted: true, perf: [{ cmd: 'true', max_ms: 200 }] },
    { path: 'src/auth/', protected: true },
  ],
  protected_globs: ['infra/**'],
};

test('C1 `canopy why path#symbol` returns the intent and the checks of the landing that changed it', () =>
  H.withDaemon(PORT, { files: FILES, rules: RULES }, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'); await A.start();
    await A.read('src/payments/ledger.js');
    await A.edit('src/payments/ledger.js', 'return entry.amount;', 'return Math.round(entry.amount * 100) / 100;');
    A.commit('round amounts');
    const land = A.land(['--task', 'Round ledger amounts to cents because floats drifted']);
    assert.equal(land.json?.status, 'landed', land.out + land.err);
    const w = H.cli(repo, PORT, ['why', 'src/payments/ledger.js#post']);
    assert.equal(w.code, 0, w.err);
    assert.match(w.out, /Round ledger amounts to cents because floats drifted/, 'intent');
    assert.match(w.out, /node test\.js/, 'check command');
    assert.match(w.out, /pass/i, 'check result');
    assert.match(w.out, new RegExp(land.json.commit.slice(0, 8)), 'landing commit');
    H.recordMetric('C1_why_output_chars', w.out.length);
    // a different symbol that was NOT changed returns nothing about this landing
    const other = H.cli(repo, PORT, ['why', 'src/payments/ledger.js#void_']);
    assert.equal(/Round ledger/.test(other.out), false, 'unchanged symbol is not attributed to that landing');
    // file-level and API forms
    const f = H.cli(repo, PORT, ['why', 'src/payments/ledger.js']);
    assert.match(f.out, /Round ledger/);
    const api = await H.httpJson(PORT, 'GET', '/api/why?target=' + encodeURIComponent('src/payments/ledger.js#post'));
    assert.equal(api.status, 200);
    assert.match(api.text, /Round ledger amounts/);
  }));

test('C1b `why` orders two landings on the same symbol and names both intents', () =>
  H.withDaemon(PORT, { files: FILES, rules: RULES }, async ({ d, repo }) => {
    for (const [n, from, to, intent] of [['one', 'return entry.amount;', 'return entry.amount + 0;', 'first intent'], ['two', 'return entry.amount + 0;', 'return entry.amount + 0.0;', 'second intent']]) {
      const A = new H.Agent(d, repo, n); await A.start(); await A.read('src/payments/ledger.js');
      // second agent branches from the updated main
      await A.edit('src/payments/ledger.js', from, to); A.commit(n);
      const r = A.land(['--task', intent]); assert.equal(r.json?.status, 'landed', r.out + r.err);
    }
    const w = H.cli(repo, PORT, ['why', 'src/payments/ledger.js#post']);
    assert.match(w.out, /first intent/); assert.match(w.out, /second intent/);
    assert.ok(w.out.indexOf('second intent') < w.out.indexOf('first intent'), 'newest first');
  }));

test('C2 context handed to an agent on its first read in a section is small and contains that section\'s rules', () =>
  H.withDaemon(PORT, { files: FILES, rules: RULES }, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'); await A.start();
    const sizes = {};
    const first = await A.read('src/payments/ledger.js');
    const c1 = H.ctxOf(first); sizes.payments_first_read = c1.length;
    assert.match(c1, /checks: node test\.js/);
    assert.match(c1, /read at least 80%/);
    assert.match(c1, /outside content/);
    assert.match(c1, /performance budgets/);
    assert.match(c1, /at most 800 changed lines/);
    const again = await A.read('src/payments/ledger.js'); sizes.payments_second_read = H.ctxOf(again).length;
    assert.equal(H.ctxOf(again), '', 'not repeated on later reads');
    const auth = await A.read('src/auth/login.js'); sizes.auth_first_read = H.ctxOf(auth).length;
    assert.match(H.ctxOf(auth), /protected \(a human must approve/);
    const ui = await A.read('src/util.js'); sizes.src_first_read = H.ctxOf(ui).length;
    const repoChars = Object.values(FILES).reduce((n, s) => n + s.length, 0);
    sizes.whole_repo_chars = repoChars;
    H.recordMetric('C2_context_sizes_chars', sizes);
    for (const k of ['payments_first_read', 'auth_first_read', 'src_first_read']) assert.ok(sizes[k] < 1000, `${k} = ${sizes[k]}`);
  }));

test('C3 after 12 landings in a section, first-read context still small (recent history, not whole history)', () =>
  H.withDaemon(PORT, { files: FILES, rules: { ...RULES, rules: [{ path: '', checks: ['true'] }] } }, async ({ d, repo }) => {
    let src = FILES['src/payments/ledger.js'];
    for (let i = 0; i < 12; i++) {
      const A = new H.Agent(d, repo, 'h' + i); await A.start(); await A.read('src/payments/ledger.js');
      const from = i === 0 ? 'return entry.amount;' : `return entry.amount + ${i - 1};`;
      await A.edit('src/payments/ledger.js', from, `return entry.amount + ${i};`); A.commit('c' + i);
      const r = A.land(['--task', `change number ${i} with a deliberately descriptive intent sentence`]);
      assert.equal(r.json?.status, 'landed', r.out + r.err);
    }
    const B = new H.Agent(d, repo, 'late'); await B.start();
    const ctx = H.ctxOf(await B.read('src/payments/ledger.js'));
    H.recordMetric('C3_first_read_chars_after_12_landings', ctx.length);
    H.recordMetric('C3_first_read_text', ctx.slice(0, 700));
    const intents = (ctx.match(/change number \d+/g) || []).length;
    H.recordMetric('C3_history_entries_in_context', intents);
    assert.ok(ctx.length < 2500, `context is ${ctx.length} chars`);
  }));

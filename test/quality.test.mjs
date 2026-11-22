// QUALITY pillar: collision handling while working, and the landing gate.
// Port 7810 (one port for this file; tests run one after another).
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import * as H from './helpers.mjs';

const PORT = 7810;
const SIG_OLD = 'charge(amount, currency) {\n  return amount * 100;';
const SIG_NEW = 'charge(amount, currency, fee) {\n  return amount * 100 + fee;';

test('Q1 two agents editing the same function: second is denied once, then allowed with a warning', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await A.read('src/pay.js'); await B.read('src/pay.js');
    const a = await A.edit('src/pay.js', 'return amount * 100;', 'return amount * 100 + 1;');
    assert.equal(a.denied, false, 'first editor must not be denied');
    const b1 = await B.edit('src/pay.js', 'return amount * 100;', 'return amount * 100 + 2;', { allowDeny: true });
    assert.equal(b1.denied, true, 'second editor is denied on first attempt');
    assert.match(H.reasonOf(b1.pre), /charge/);
    assert.match(H.reasonOf(b1.pre), /«a»|\ba\b/, 'denial names the other branch');
    assert.equal(fs.readFileSync(B.abs('src/pay.js'), 'utf8').includes('+ 2'), false);
    const b2 = await B.edit('src/pay.js', 'return amount * 100;', 'return amount * 100 + 2;', { allowDeny: true });
    assert.equal(b2.denied, false, 'identical retry is allowed');
    assert.match(H.ctxOf(b2.pre), /warning/i, 'retry carries a warning');
    // a third attempt on the same function is not denied again
    const b3 = await B.edit('src/pay.js', '+ 2;', '+ 3;', { allowDeny: true });
    assert.equal(b3.denied, false, 'denied only once');
  }));

test('Q2 signature change reaches a reader in its next hook response', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await B.read('src/cart.js'); await B.read('src/pay.js');
    await A.read('src/pay.js');
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW);
    const next = await B.read('src/util.js'); // any later hook
    const ctx = H.ctxOf(next);
    assert.match(ctx, /\[high\]/);
    assert.match(ctx, /charge/);
    assert.match(ctx, /signature/);
    assert.match(ctx, /charge\(amount, currency, fee\)/, 'new signature shown');
    H.recordMetric('Q2_notice_chars', ctx.length);
    // A itself gets no notice about its own change
    const aNext = await A.read('src/util.js');
    assert.equal(/\[high\].*charge/.test(H.ctxOf(aNext)), false);
  }));

test('Q3 new code that calls a function whose signature is changing in flight gets a notice', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await A.read('src/pay.js');
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW);
    // B never read pay.js; it writes brand-new code that calls charge(...)
    const w = await B.write('src/invoice.js', "import { charge } from './pay.js';\nexport function invoice() { return charge(2, 'usd'); }\n");
    let ctx = H.ctxOf(w.post);
    if (!/charge/.test(ctx)) ctx = H.ctxOf(await B.read('src/util.js'));
    assert.match(ctx, /charge/);
    assert.match(ctx, /signature/);
    assert.match(ctx, /reference|calling|writing/i);
    const st = await H.getState(PORT);
    assert.ok(st.notices.some((n) => n.severity === 'high' && /charge/.test(n.node)), 'a high notice exists');
  }));

test('Q4 clean text merge, broken behaviour: blocked at landing; main never contains a failing state', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    // A: changes signature (fee required) and fixes the callers it can see.
    await A.read('src/pay.js'); await A.read('src/cart.js');
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW);
    await A.edit('src/cart.js', "charge(5, 'usd')", "charge(5, 'usd', 0)");
    A.commit('charge takes a fee');
    // B (started before, unaware): adds a new module that calls the old form, with its own self test.
    await B.write('src/invoice.js', "import { charge } from './pay.js';\nexport function invoice() { return charge(2, 'usd'); }\nexport function selfTest() { return invoice() === 200; }\n");
    B.commit('invoice');
    // each branch passes alone
    // each branch's own tests pass in isolation
    for (const x of [A, B]) assert.equal(spawnSync(process.execPath, ['test.js'], { cwd: x.wt }).status, 0, `${x.name} passes alone`);
    const ra = A.land(['--task', 'fee']);
    assert.equal(ra.json?.status, 'landed', ra.out + ra.err);
    const rb = B.land(['--task', 'invoice']);
    assert.notEqual(rb.json?.status, 'landed', 'B must not land onto A');
    assert.equal(rb.code, 1, 'exit 1 = blocked');
    assert.equal(rb.json.status, 'blocked');
    assert.match(rb.json.reasons.join(' '), /check/i);
    H.recordMetric('Q4_blocked_reason', rb.json.reasons.join(' ').slice(0, 200));
    // main: every first-parent commit passes the test suite
    const commits = H.gitOk(repo, 'rev-list', '--first-parent', 'main').split('\n');
    assert.equal(commits.length, 2, 'main has initial + A only');
    for (const c of commits) {
      const dir = H.tmp('chk-');
      H.gitOk(repo, 'worktree', 'add', '-q', '--detach', dir + '/w', c);
      const run = spawnSync(process.execPath, ['test.js'], { cwd: dir + '/w' });
      assert.equal(run.status, 0, `main commit ${c.slice(0, 8)} fails its own tests`);
    }
  }));

test('Q5a reverting an in-flight change (via edit hook) retracts the notice', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await B.read('src/cart.js'); await B.read('src/pay.js');
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW);
    assert.match(H.ctxOf(await B.read('src/util.js')), /charge/);
    let st = await H.getState(PORT);
    assert.ok(st.notices.some((n) => n.open), 'notice is open');
    await A.edit('src/pay.js', SIG_NEW, SIG_OLD);   // revert by hand through the edit tool
    const gone = await H.waitFor(async () => {
      const s = await H.getState(PORT);
      return s.writes.length === 0 && !s.notices.some((n) => n.open && n.severity === 'high') ? s : null;
    });
    assert.ok(gone.value, 'write and high notice retracted: ' + JSON.stringify((await H.getState(PORT)).notices));
    // the retraction itself is delivered to B once, as a low-severity note, then B hears nothing more
    const ctx = H.ctxOf(await B.read('src/util.js'));
    assert.match(ctx, /Retraction/i);
    assert.equal(/\[high\]/.test(ctx), false);
    assert.equal(H.ctxOf(await B.read('src/util.js')), '', 'delivered once');
  }));

test('Q5b reverting an in-flight change (git checkout through a shell command) retracts the notice', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await B.read('src/cart.js'); await B.read('src/pay.js');
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW);
    assert.equal((await H.getState(PORT)).writes.length > 0, true);
    A.revertFile('src/pay.js');
    const t0 = Date.now();
    await A.bash('git checkout -- src/pay.js');
    const gone = await H.waitFor(async () => (await H.getState(PORT)).writes.length === 0, { timeout: 8000 });
    H.recordMetric('Q5b_retract_ms_after_bash_hook', gone.ms);
    assert.ok(gone.value, 'write retracted after checkout');
    const s = await H.getState(PORT);
    assert.equal(s.notices.some((n) => n.open && n.severity === 'high'), false, 'no open high notice remains');
    assert.ok(s.notices.some((n) => n.kind === 'retracted'), 'a retraction notice was issued to the reader');
    assert.ok(Date.now() - t0 < 8000);
  }));

test('Q6 edits made through a shell command (Bash hook) are detected', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await B.read('src/cart.js'); await B.read('src/pay.js');
    const t0 = Date.now();
    await A.bash("sed -i '' 's/(amount, currency)/(amount, currency, fee)/' src/pay.js", (wt) => {
      const f = wt + '/src/pay.js';
      fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('(amount, currency)', '(amount, currency, fee)'));
    });
    const seen = await H.waitFor(async () => {
      const s = await H.getState(PORT);
      return s.writes.find((w) => /pay\.js#charge/.test(w.node)) || null;
    }, { timeout: 8000 });
    assert.ok(seen.value, 'shell edit appears in writes');
    assert.equal(seen.value.how, 'shell');
    assert.equal(seen.value.kind, 'signature');
    H.recordMetric('Q6_shell_edit_detect_ms', seen.ms);
    // and the reader is told
    const ctx = H.ctxOf(await B.read('src/util.js'));
    assert.match(ctx, /charge/);
    assert.match(ctx, /signature/);
    // a shell command that edits and a second agent editing the same function via tools
    const b = await B.edit('src/pay.js', 'return amount * 100;', 'return amount * 100 + 1;', { allowDeny: true });
    assert.equal(b.denied, true, 'shell-made change creates a hold that denies the other agent');
  }));

test('Q7 unrelated parallel work: zero denials and zero high notices over 25 edit pairs', () => {
  const N = 25;
  const files = { 'package.json': '{"type":"module"}\n', 'src/shared.js': 'export function shared(x) {\n  return x + 1;\n}\n' };
  for (let i = 0; i < N; i++) {
    files[`src/a${i}.js`] = `import { shared } from './shared.js';\nexport function fa${i}(x) {\n  return shared(x) + ${i};\n}\n`;
    files[`src/b${i}.js`] = `import { shared } from './shared.js';\nexport function fb${i}(x) {\n  return shared(x) * ${i + 2};\n}\n`;
  }
  return H.withDaemon(PORT, { files, rules: { version: 1, revalidate: 'always', rules: [{ path: '', checks: ['true'] }] } }, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    let denials = 0, high = 0, anyNotice = 0;
    const scan = (r) => { const c = H.ctxOf(r); if (/\[high\]/.test(c)) high++; if (/Canopy notices/.test(c)) anyNotice++; };
    for (let i = 0; i < N; i++) {
      scan(await A.read(`src/a${i}.js`)); scan(await B.read(`src/b${i}.js`));
      const [ra, rb] = await Promise.all([
        A.edit(`src/a${i}.js`, `+ ${i};`, `+ ${i + 100};`, { allowDeny: true }),
        B.edit(`src/b${i}.js`, `* ${i + 2};`, `* ${i + 200};`, { allowDeny: true }),
      ]);
      for (const r of [ra, rb]) { if (r.denied) denials++; if (r.post) scan(r.post); if (r.pre) scan(r.pre); }
    }
    H.recordMetric('Q7_pairs', N);
    H.recordMetric('Q7_denials', denials); H.recordMetric('Q7_high_notices', high); H.recordMetric('Q7_any_notices', anyNotice);
    const st = await H.getState(PORT);
    H.recordMetric('Q7_open_notices_in_state', st.notices.filter((n) => n.open).length);
    assert.equal(denials, 0);
    assert.equal(high, 0);
    assert.equal(st.notices.filter((n) => n.severity === 'high').length, 0);
    A.commit('a'); B.commit('b');
    const ra = A.land(), rb = B.land();
    assert.equal(ra.json?.status, 'landed', ra.out); assert.equal(rb.json?.status, 'landed', rb.out);
  });
});

test('Q8 symlinked hook paths (/var vs /private/var) behave the same as real paths', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    if (process.platform !== 'darwin') return;
    const A = new H.Agent(d, repo, 'a', { hookPathOf: H.toSymlinked }), B = new H.Agent(d, repo, 'b', { hookPathOf: H.toSymlinked });
    assert.notEqual(H.toSymlinked(A.wt), A.wt, 'path really differs in symlinked form');
    await A.start(); await B.start();
    await B.read('src/cart.js'); await B.read('src/pay.js');
    await A.read('src/pay.js');
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW);
    const st = await H.getState(PORT);
    assert.ok(st.writes.some((w) => w.node === 'src/pay.js#charge'), 'write recorded against the repo-relative node: ' + JSON.stringify(st.writes));
    assert.ok(st.reads.some((r) => r.path === 'src/cart.js'), 'read recorded with repo-relative path');
    assert.match(H.ctxOf(await B.read('src/util.js')), /charge/, 'reader notified');
    const b1 = await B.edit('src/pay.js', 'return amount * 100', 'return amount * 101', { allowDeny: true });
    assert.equal(b1.denied, true, 'same-function collision still detected');
    // landing from a symlinked cwd
    A.commit('x');
    const r = H.land(H.toSymlinked(A.wt), PORT);
    assert.ok(['landed', 'needs-human', 'blocked'].includes(r.json?.status), r.out + r.err);
  }));

test('Q9 agent git commands issued right after a Bash hook do not fail (index.lock contention with canopyd)', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'); await A.start();
    let fails = 0; const N = 40; const errs = [];
    for (let i = 0; i < N; i++) {
      fs.writeFileSync(A.abs('src/util.js'), `export function clamp(x, lo, hi) {\n  return ${i} + Math.min(hi, Math.max(lo, x));\n}\n`);
      await A.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'echo ' + i }, tool_response: {} });
      const r = H.git(A.wt, 'add', '-A');          // no retry here on purpose
      if (r.code !== 0) { fails++; errs.push(r.err.split('\n')[0].slice(0, 80)); }
      H.git(A.wt, 'commit', '-q', '--allow-empty', '-m', 'c' + i);
    }
    H.recordMetric('Q9_git_add_failures', { failed: fails, of: N, sample: errs[0] });
    assert.equal(fails, 0, `${fails}/${N} 'git add' calls failed: ${errs[0]}`);
  }));

test('Q10 stale assumption: branch calls old signature, no test covers it. Gate output', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW); await A.edit('src/cart.js', "charge(5, 'usd')", "charge(5, 'usd', 0)");
    A.commit('fee');
    await B.write('src/invoice.js', "import { charge } from './pay.js';\nexport function invoice() { return charge(2, 'usd'); }\n"); // no selfTest
    B.commit('invoice');
    assert.equal(A.land().json?.status, 'landed');
    const rb = B.land();
    H.recordMetric('Q10_verdict_when_no_test_covers_old_call', { status: rb.json?.status, stale: rb.json?.record?.stale_assumptions, reasons: rb.json?.reasons });
    const rec = rb.json?.record;
    assert.ok(rec?.stale_assumptions?.some((s) => /pay\.js#charge/.test(s.node)), 'record lists the stale assumption');
    assert.notEqual(rb.json.status, 'landed', 'a branch built on a signature that has since changed should not land silently');
  }));

// QUALITY/PERFORMANCE comparison against a plain "worktrees + merge + run the check on every merge" baseline.
// Port 7817.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import * as H from './helpers.mjs';

const PORT = 7817;
const SIG_OLD = 'charge(amount, currency) {\n  return amount * 100;';
const SIG_NEW = 'charge(amount, currency, fee) {\n  return amount * 100 + fee;';
const INVOICE = "import { charge } from './pay.js';\nexport function invoice() { return charge(2, 'usd'); }\nexport function selfTest() { return invoice() === 200; }\n";

const sh = (cwd, cmd) => spawnSync('sh', ['-c', cmd], { cwd, encoding: 'utf8' });
const shAsync = (cwd, cmd) => new Promise((res) => { const c = spawn('sh', ['-c', cmd], { cwd, stdio: 'ignore' }); c.on('close', (code) => res(code)); });

// ---------------------------------------------------------------------------
test('B1 (a) when is the semantic conflict first detected: Canopy vs. plain merge-and-CI baseline', async () => {
  const out = {};
  // ---- Canopy
  await H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await A.read('src/pay.js'); await A.read('src/cart.js');
    // (i) A changes the signature first; B then writes the old-form call. t0 = B's conflicting edit.
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW); await A.edit('src/cart.js', "charge(5, 'usd')", "charge(5, 'usd', 0)");
    const t0 = process.hrtime.bigint();
    const w = await B.write('src/invoice.js', INVOICE);
    let ctx = H.ctxOf(w.post), when = 'same hook response as the edit';
    if (!/charge/.test(ctx)) { ctx = H.ctxOf(await B.read('src/util.js')); when = 'next hook'; }
    const tNotice = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.match(ctx, /charge/);
    out.canopy_order_A_first = { detected_ms_after_conflicting_edit: +tNotice.toFixed(1), phase: 'while working', delivered_in: when };
    // (ii) landing time detection: A lands, then B's land is blocked
    A.commit('fee'); B.commit('invoice');
    assert.equal(A.land().json?.status, 'landed');
    const rb = B.land();
    out.canopy_at_land = { status: rb.json?.status, land_call_ms: +rb.ms.toFixed(0), phase: 'at merge (gate)' };
    assert.equal(rb.json?.status, 'blocked');
  });
  // (iii) other order: B's call exists first, A changes the signature afterwards. t0 = A's edit.
  await H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await B.write('src/invoice.js', INVOICE);
    await B.read('src/pay.js');
    await A.read('src/pay.js');
    const t0 = process.hrtime.bigint();
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW);
    const ctx = H.ctxOf(await B.read('src/util.js'));
    const t = Number(process.hrtime.bigint() - t0) / 1e6;
    assert.match(ctx, /charge/);
    out.canopy_order_B_first = { detected_ms_after_conflicting_edit: +t.toFixed(1), phase: 'while working' };
  });
  // ---- baseline: worktrees + merge + run the check on every merge
  {
    const repo = H.mkRepo(H.BASE_FILES, null);
    const A = H.addWorktree(repo, 'a'), B = H.addWorktree(repo, 'b');
    for (const [p, from, to] of [['src/pay.js', SIG_OLD, SIG_NEW], ['src/cart.js', "charge(5, 'usd')", "charge(5, 'usd', 0)"]]) fs.writeFileSync(path.join(A, p), fs.readFileSync(path.join(A, p), 'utf8').replace(from, to));
    H.gitOk(A, 'commit', '-qam', 'fee');
    fs.writeFileSync(path.join(B, 'src/invoice.js'), INVOICE); H.gitOk(B, 'add', '-A'); H.gitOk(B, 'commit', '-qm', 'invoice');
    const t0 = process.hrtime.bigint();       // the conflicting edit has just been committed on both branches (best case for the baseline: agents finish at once)
    const merge = (br) => {
      const tmp = H.tmp('mq-'); H.gitOk(repo, 'worktree', 'add', '-q', '--detach', path.join(tmp, 'w'), 'main');
      const w = path.join(tmp, 'w');
      const m = H.git(w, 'merge', '--no-ff', '-q', '-m', 'merge ' + br, br);
      const chk = spawnSync(process.execPath, ['test.js'], { cwd: w });
      const sha = H.gitOk(w, 'rev-parse', 'HEAD');
      return { clean: m.code === 0, check: chk.status, sha };
    };
    const ma = merge('a'); assert.equal(ma.check, 0); H.gitOk(repo, 'update-ref', 'refs/heads/main', ma.sha); H.gitOk(repo, 'reset', '-q', '--hard');
    const mb = merge('b');
    const tDetect = Number(process.hrtime.bigint() - t0) / 1e6;
    out.baseline = { text_merge_clean: mb.clean, check_exit_on_merge_of_B: mb.check, detected_ms_after_both_branches_committed: +tDetect.toFixed(0), phase: 'at merge (CI on the merge result)', note: 'agents are assumed to commit instantly; real agents add their remaining working time on top' };
    assert.equal(mb.clean, true, 'textually clean'); assert.notEqual(mb.check, 0, 'check catches it at merge');
  }
  H.recordMetric('B1_detection', out);
});

// ---------------------------------------------------------------------------
async function canopyEightBranches(mode, checkSleep) {
  const counterDir = H.tmp('cnt-'); const cf = path.join(counterDir, 'count');
  const files = { 'package.json': '{"type":"module"}\n' };
  for (let i = 0; i < 8; i++) files[`m${i}/f${i}.js`] = `export function f${i}(x) {\n  return x + ${i};\n}\n`;
  // Changed after the sandbox was tightened (defect D3): a check can no longer write a counter
  // file outside its checkout, so runs are read from canopyd's own `check_runs` statistic.
  const rules = { version: 1, revalidate: mode, rules: [{ path: '', checks: [`sleep ${checkSleep}`] }] };
  return H.withDaemon(PORT, { files, rules }, async ({ d, repo }) => {
    const ags = [];
    for (let i = 0; i < 8; i++) { const A = new H.Agent(d, repo, 'w' + i); await A.start(); await A.read(`m${i}/f${i}.js`); await A.edit(`m${i}/f${i}.js`, `+ ${i};`, `+ ${i + 10};`); A.commit('c' + i); ags.push(A); }
    const t0 = Date.now();
    const rs = await Promise.all(ags.map((A) => new Promise((res) => {
      const c = spawn(process.execPath, [H.CLI, 'land', '--json'], { cwd: A.wt, env: { ...process.env, ...H.GIT_ENV, CANOPY_PORT: String(PORT) } });
      let o = ''; c.stdout.on('data', (x) => { o += x; }); c.on('close', () => { try { res(JSON.parse(o)); } catch { res({ status: 'unparsable', o }); } });
    })));
    const wall = Date.now() - t0;
    const runs = (await (await fetch(`http://127.0.0.1:${PORT}/api/stats`)).json()).check_runs;
    return { statuses: rs.map((r) => r.status + (r.reasons ? ':' + r.reasons.join('|').slice(0, 160) : '')), landed: rs.filter((r) => r.status === 'landed').length, check_runs: runs, wall_ms: wall, reval: rs.map((r) => r.record?.revalidated || '').filter(Boolean).length };
  });
}

async function baselineEightBranches(strategy, checkSleep) {
  const counterDir = H.tmp('cnt-'); const cf = path.join(counterDir, 'count');
  const files = { 'package.json': '{"type":"module"}\n' };
  for (let i = 0; i < 8; i++) files[`m${i}/f${i}.js`] = `export function f${i}(x) {\n  return x + ${i};\n}\n`;
  const seed = H.mkRepo(files, null);
  const bare = path.join(H.tmp('bq-'), 'origin.git'); H.gitOk(seed, 'clone', '-q', '--bare', seed, bare);
  for (let i = 0; i < 8; i++) {        // each branch: one commit touching its own file
    const w = H.tmp('bw-'); H.gitOk(bare, 'worktree', 'add', '-q', '-b', 'b' + i, path.join(w, 'w'), 'main');
    const f = path.join(w, 'w', `m${i}/f${i}.js`); fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace(`+ ${i};`, `+ ${i + 10};`));
    H.gitOk(path.join(w, 'w'), 'commit', '-qam', 'c' + i);
  }
  const check = `echo x >> ${cf}; sleep ${checkSleep}`;
  let lock = Promise.resolve();
  const critical = (fn) => { const p = lock.then(fn); lock = p.catch(() => {}); return p; };
  async function job(i) {
    for (;;) {
      const base = H.gitOk(bare, 'rev-parse', 'main');
      const tmp = H.tmp('bm-'); const w = path.join(tmp, 'w');
      H.gitOk(bare, 'worktree', 'add', '-q', '--detach', w, base);
      assert.equal(H.git(w, 'merge', '--no-ff', '-q', '-m', 'merge b' + i, 'b' + i).code, 0);
      const code = await shAsync(w, check);
      if (code !== 0) return false;
      const ok = await critical(async () => {
        if (H.gitOk(bare, 'rev-parse', 'main') !== base) return false;       // main moved: our test result is stale
        H.gitOk(bare, 'update-ref', 'refs/heads/main', H.gitOk(w, 'rev-parse', 'HEAD')); return true;
      });
      if (ok) return true;
    }
  }
  const t0 = Date.now();
  if (strategy === 'serial') { for (let i = 0; i < 8; i++) assert.equal(await job(i), true); }
  else await Promise.all(Array.from({ length: 8 }, (_, i) => job(i)));
  const runs = fs.readFileSync(cf, 'utf8').trim().split('\n').length;
  return { landed: H.gitOk(bare, 'rev-list', '--first-parent', '--merges', '--count', 'main'), check_runs: runs, wall_ms: Date.now() - t0 };
}

test('B2 (b) check runs when 8 unrelated branches land while main keeps moving: Canopy always / disjoint vs. baseline', { timeout: 300000 }, async () => {
  const SLEEP = 1;
  const res = {};
  res.canopy_always = await canopyEightBranches('always', SLEEP);
  res.canopy_disjoint = await canopyEightBranches('disjoint', SLEEP);
  res.baseline_serial_merge_queue = await baselineEightBranches('serial', SLEEP);
  res.baseline_optimistic_parallel_ci = await baselineEightBranches('parallel', SLEEP);
  res.check_command = `echo x >> counter; sleep ${SLEEP}`;
  H.recordMetric('B2_check_runs_8_unrelated_branches', res);
  assert.equal(res.canopy_always.landed, 8); assert.equal(res.canopy_disjoint.landed, 8);
  assert.ok(res.canopy_disjoint.check_runs <= res.canopy_always.check_runs);
  assert.equal(res.canopy_disjoint.check_runs, 8, 'disjoint: one check run per branch');
});

test('B3 revalidate "disjoint" does not skip the re-run when the concurrent landings DO interact (semantic conflict, simultaneous land)', { timeout: 120000 }, async () => {
  for (const mode of ['always', 'disjoint']) {
    const rules = { version: 1, revalidate: mode, rules: [{ path: '', checks: ['node test.js && sleep 1'] }] };
    await H.withDaemon(PORT, { rules }, async ({ d, repo }) => {
      const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
      await A.start(); await B.start();
      await A.read('src/pay.js'); await A.read('src/cart.js');
      await A.edit('src/pay.js', SIG_OLD, SIG_NEW); await A.edit('src/cart.js', "charge(5, 'usd')", "charge(5, 'usd', 0)");
      await B.read('src/pay.js');
      await B.write('src/invoice.js', INVOICE);
      A.commit('fee'); B.commit('invoice');
      const landOne = (X, delay) => new Promise((res) => setTimeout(() => {
        const c = spawn(process.execPath, [H.CLI, 'land', '--json'], { cwd: X.wt, env: { ...process.env, ...H.GIT_ENV, CANOPY_PORT: String(PORT) } });
        let o = ''; c.stdout.on('data', (x) => { o += x; }); c.on('close', () => { try { res(JSON.parse(o)); } catch { res({ status: 'unparsable', o }); } });
      }, delay));
      const [ra, rb] = await Promise.all([landOne(A, 0), landOne(B, 150)]);
      const commits = H.gitOk(repo, 'rev-list', '--first-parent', 'main').split('\n');
      let failing = 0;
      for (const c of commits) {
        const dir = H.tmp('chk-'); H.gitOk(repo, 'worktree', 'add', '-q', '--detach', dir + '/w', c);
        if (spawnSync(process.execPath, ['test.js'], { cwd: dir + '/w' }).status !== 0) failing++;
      }
      H.recordMetric(`B3_simultaneous_interacting_land_${mode}`, { A: ra.status, B: rb.status, B_reval: rb.record?.revalidated, main_commits_failing_tests: failing });
      assert.equal(failing, 0, `${mode}: main contains a failing state`);
      assert.ok(!(ra.status === 'landed' && rb.status === 'landed'), `${mode}: both landed`);
    });
  }
});

// Boundary of the B3 defect: does `disjoint` notice interaction when B changes an EXISTING caller, or adds a function to an existing file?
const VARIANTS = {
  'new_file': async (B) => { await B.write('src/invoice.js', INVOICE); },
  'new_function_in_existing_file': async (B) => {
    await B.read('src/util.js');
    await B.edit('src/util.js', 'export function clamp', "import { charge } from './pay.js';\nexport function selfTest() { return charge(2, 'usd') === 200; }\nexport function clamp");
  },
  'edit_existing_caller_body': async (B) => {
    await B.read('src/report.js');
    // B adds a second old-form call inside an existing function that already depends on charge (A fixed the first call)
    await B.edit('src/report.js', 'return report() === 100;', "return report() === 100 && charge(3, 'usd') === 300;");
  },
};
for (const [name, work] of Object.entries(VARIANTS)) {
  test(`B3-${name}: simultaneous land with revalidate "disjoint" when B calls the old signature`, { timeout: 120000 }, async () => {
    const files = { ...H.BASE_FILES, 'src/report.js': "import { charge } from './pay.js';\nexport function report() {\n  return charge(1, 'usd');\n}\nexport function selfTest() { return report() === 100; }\n" };
    const rules = { version: 1, revalidate: 'disjoint', rules: [{ path: '', checks: ['node test.js && sleep 1'] }] };
    await H.withDaemon(PORT, { files, rules }, async ({ d, repo }) => {
      const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
      await A.start(); await B.start();
      await A.read('src/pay.js'); await A.read('src/cart.js');
      await A.edit('src/pay.js', SIG_OLD, SIG_NEW); await A.edit('src/cart.js', "charge(5, 'usd')", "charge(5, 'usd', 0)");
      await A.edit('src/report.js', "charge(1, 'usd')", "charge(1, 'usd', 0)");
      A.commit('fee');
      await work(B);
      B.commit('b');
      const landOne = (X, delay) => new Promise((res) => setTimeout(() => {
        const c = spawn(process.execPath, [H.CLI, 'land', '--json'], { cwd: X.wt, env: { ...process.env, ...H.GIT_ENV, CANOPY_PORT: String(PORT) } });
        let o = ''; c.stdout.on('data', (x) => { o += x; }); c.on('close', () => { try { res(JSON.parse(o)); } catch { res({ status: 'unparsable', o }); } });
      }, delay));
      const [ra, rb] = await Promise.all([landOne(A, 0), landOne(B, 150)]);
      let failing = 0;
      for (const c of H.gitOk(repo, 'rev-list', '--first-parent', 'main').split('\n')) {
        const dir = H.tmp('chk-'); H.gitOk(repo, 'worktree', 'add', '-q', '--detach', dir + '/w', c);
        if (spawnSync(process.execPath, ['test.js'], { cwd: dir + '/w' }).status !== 0) failing++;
      }
      H.recordMetric(`B3_${name}_disjoint`, { A: ra.status, B: rb.status, B_reval: rb.record?.revalidated, main_commits_failing_tests: failing, reasons: rb.reasons });
      assert.equal(failing, 0, 'main contains a failing state');
    });
  });
}

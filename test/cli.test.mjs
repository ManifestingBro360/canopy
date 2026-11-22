// Documented CLI behaviours: wait, release, status, pending/approve exit codes. Port 7821.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import * as H from './helpers.mjs';

const PORT = 7821;
const SIG_OLD = 'charge(amount, currency) {\n  return amount * 100;';
const SIG_NEW = 'charge(amount, currency, fee) {\n  return amount * 100 + fee;';

test('W1 `canopy wait` blocks until the other agent\'s change lands, then returns 0', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await A.read('src/pay.js');
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW); await A.edit('src/cart.js', "charge(5, 'usd')", "charge(5, 'usd', 0)");
    A.commit('fee');
    const t0 = Date.now();
    const c = spawn(process.execPath, [H.CLI, 'wait', 'src/pay.js#charge'], { cwd: B.wt, env: { ...process.env, ...H.GIT_ENV, CANOPY_PORT: String(PORT) } });
    let out = '', exited = null; c.stdout.on('data', (x) => { out += x; }); c.stderr.on('data', (x) => { out += x; });
    c.on('close', (code) => { exited = { code, at: Date.now() }; });
    await H.sleep(1500);
    assert.equal(exited, null, 'still blocked while A has not landed: ' + out);
    assert.equal(A.land().json?.status, 'landed');
    const tLandDone = Date.now();
    const done = await H.waitFor(() => exited, { timeout: 10000 });
    assert.ok(done.value, 'wait returned after the landing');
    H.recordMetric('W1_wait_exit_ms_relative_to_land_returning', done.value.at - tLandDone);
    assert.equal(exited.code, 0, out);
    c.kill('SIGKILL'); void t0;
  }));

test('W2 `canopy release` drops this worktree\'s holds so the other agent is no longer denied', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'a'), B = new H.Agent(d, repo, 'b');
    await A.start(); await B.start();
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW);
    assert.ok((await H.getState(PORT)).holds.length > 0);
    const r = H.cli(A.wt, PORT, ['release']);
    assert.equal(r.code, 0, r.err);
    const st = await H.getState(PORT);
    assert.equal(st.holds.length, 0, 'holds dropped: ' + JSON.stringify(st.holds));
    assert.equal(st.writes.filter((w) => w.wt === A.wt.split('/').pop()).length, 0, 'in-flight record dropped');
    const b = await B.edit('src/pay.js', 'return amount * 100;', 'return amount * 101;', { allowDeny: true });
    assert.equal(b.denied, false);
  }));

test('W3 `canopy status` lists who is changing what; `pending` lists a waiting landing; exit codes 0/2/1 of `land`', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const A = new H.Agent(d, repo, 'alpha'); await A.start();
    await A.edit('src/pay.js', SIG_OLD, SIG_NEW);
    const s = H.cli(repo, PORT, ['status']);
    assert.equal(s.code, 0); assert.match(s.out, /charge/); assert.match(s.out, /alpha/);
    // needs a person -> exit 2
    const B = new H.Agent(d, repo, 'beta'); await B.start();
    await B.write('package.json', '{"type":"module","x":1}\n'); B.commit('pkg');
    const rb = B.land(); assert.equal(rb.code, 2);
    const p = H.cli(repo, PORT, ['pending']); assert.equal(p.code, 0); assert.match(p.out, new RegExp(rb.json.id));
    // blocked -> exit 1 (uncommitted work)
    const r1 = A.land(); assert.equal(r1.code, 1, 'uncommitted changes: ' + r1.out + r1.err);
    // nothing to land
    A.revertFile('src/pay.js');
    const C = new H.Agent(d, repo, 'gamma'); await C.start();
    const rn = C.land(); H.recordMetric('W3_land_with_no_changes', { code: rn.code, status: rn.json?.status });
    // approve via the CLI uses the stored human token
    const ap = H.cli(repo, PORT, ['approve', rb.json.id]); assert.equal(ap.code, 0, ap.out + ap.err);
    assert.match(ap.out, /LANDED/);
  }));

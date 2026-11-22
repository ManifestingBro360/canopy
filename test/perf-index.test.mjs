// PERFORMANCE: index time at startup and after a landing. Port 7815.
import test from 'node:test';
import assert from 'node:assert/strict';
import { execSync } from 'node:child_process';
import * as H from './helpers.mjs';

const PORT = 7815;
const rssMb = (pid) => { try { return +(parseInt(execSync(`ps -o rss= -p ${pid}`).toString(), 10) / 1024).toFixed(1); } catch { return null; } };

for (const n of [1000, 10000]) {
  test(`P5 index ${n} JS files at startup, then land a one-function change`, { timeout: 300000 }, async () => {
    const repo = H.genRepo(n);
    const t0 = Date.now();
    const d = await H.startDaemon(repo, PORT);
    try {
      const startup = Date.now() - t0;
      const st0 = (await H.httpJson(PORT, 'GET', '/api/stats')).json;
      H.recordMetric(`P5_${n}_files_index`, { logged_index_ms: d.index?.ms, files: d.index?.files, nodes: d.index?.nodes, spawn_to_ready_ms: startup, rss_mb: rssMb(d.child.pid) });
      assert.ok(d.index.files >= n);
      // incremental behaviour: land one small change, see what the daemon does
      const A = new H.Agent(d, repo, 'inc'); await A.start();
      await A.read('mod0/m1.js');
      await A.edit('mod0/m1.js', 'x + 1;', 'x + 1000;');
      A.commit('inc');
      const r = A.land(['--task', 'one function']);
      assert.equal(r.json?.status, 'landed', r.out + r.err);
      const st1 = (await H.httpJson(PORT, 'GET', '/api/stats')).json;
      const rev = (await H.getState(PORT)).rev;
      H.recordMetric(`P5_${n}_files_land_one_change`, { land_wall_ms: +r.ms.toFixed(0), index_ms_before: st0.index_ms, index_ms_after: st1.index_ms, files_after: st1.files, main_rev_matches_head: rev === H.gitOk(repo, 'rev-parse', 'main'), rss_mb_after: rssMb(d.child.pid) });
      // a hook right after the landing still answers fast
      const q = await A.read('mod0/m2.js');
      H.recordMetric(`P5_${n}_hook_after_land_ms`, +q.ms.toFixed(2));
    } finally { d.kill(); }
  });
}

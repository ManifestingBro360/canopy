// PERFORMANCE: `canopy land` wall time, fixed overhead, 20 sequential landings. Port 7816.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import * as H from './helpers.mjs';

const PORT = 7816;
const stat = (a) => ({ n: a.length, p50: +H.pct(a, 50).toFixed(0), p95: +H.pct(a, 95).toFixed(0), min: +Math.min(...a).toFixed(0), max: +Math.max(...a).toFixed(0), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(0) });

function floor(repo) {
  const node = []; const status = [];
  for (let i = 0; i < 7; i++) {
    const t = process.hrtime.bigint(); spawnSync(process.execPath, ['-e', '0']); node.push(Number(process.hrtime.bigint() - t) / 1e6);
    status.push(H.cli(repo, PORT, ['stats']).ms);
  }
  return { bare_node_startup_ms: +H.pct(node, 50).toFixed(0), canopy_stats_cli_ms: +H.pct(status, 50).toFixed(0) };
}

async function sequential(repo, d, n, file, label) {
  const walls = [], checkMs = [], intents = [];
  for (let i = 0; i < n; i++) {
    const A = new H.Agent(d, repo, `s${label}${i}`);          // new worktree from current main each time
    await A.start(); await A.read(file);
    const cur = (await import('node:fs')).readFileSync(A.abs(file), 'utf8');
    const m = cur.match(/\+ (\d+);/)[0];
    await A.edit(file, m, `+ ${i + 1000};`);
    A.commit('seq' + i);
    const r = A.land(['--task', 'sequential ' + i]);
    assert.equal(r.json?.status, 'landed', `landing ${i}: ` + r.out + r.err);
    walls.push(r.ms); checkMs.push(r.json.record.checks.reduce((s, c) => s + c.ms, 0));
  }
  return { walls, checkMs };
}

test('P6 land wall time with a trivial check (`true`) and fixed overhead (tiny repo)', async () => {
  const files = { 'package.json': '{"type":"module"}\n' };
  for (let i = 0; i < 5; i++) files[`src/f${i}.js`] = `export function fn${i}(x) {\n  return x + ${i};\n}\n`;
  const repo = H.mkRepo(files, { version: 1, revalidate: 'always', rules: [{ path: '', checks: ['true'] }] });
  await H.withDaemon(PORT, { repo }, async ({ d }) => {
    const fl = floor(repo);
    const { walls, checkMs } = await sequential(repo, d, 20, 'src/f0.js', 'tiny');
    const first = walls.slice(0, 5), last = walls.slice(-5);
    H.recordMetric('P6_land_wall_ms_20_sequential_tiny_repo', { ...stat(walls), total_ms: +walls.reduce((a, b) => a + b, 0).toFixed(0), first5_mean: +(first.reduce((a, b) => a + b) / 5).toFixed(0), last5_mean: +(last.reduce((a, b) => a + b) / 5).toFixed(0) });
    H.recordMetric('P6_check_ms_for_true', stat(checkMs));
    H.recordMetric('P6_floor', fl);
    const overhead = H.pct(walls, 50) - H.pct(checkMs, 50) - fl.canopy_stats_cli_ms;
    H.recordMetric('P6_fixed_overhead_ms_over_check_and_cli_floor', +overhead.toFixed(0));
    // main has exactly 20 landings + initial, each landing a merge commit
    const merges = H.gitOk(repo, 'rev-list', '--first-parent', '--merges', '--count', 'main');
    assert.equal(merges, '20');
  });
});

test('P7 20 sequential landings on a 1000-file repo (does land time grow with repo size?)', { timeout: 300000 }, async () => {
  const repo = H.genRepo(1000);
  await H.withDaemon(PORT, { repo }, async ({ d }) => {
    const { walls, checkMs } = await sequential(repo, d, 20, 'mod0/m1.js', 'big');
    H.recordMetric('P7_land_wall_ms_20_sequential_1000_files', { ...stat(walls), total_ms: +walls.reduce((a, b) => a + b, 0).toFixed(0) });
    H.recordMetric('P7_floor', floor(repo));
  });
});

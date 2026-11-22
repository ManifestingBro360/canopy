// PERFORMANCE: hook round-trip latency. Port 7814.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import * as H from './helpers.mjs';

const PORT = 7814;
const stat = (a) => ({ n: a.length, p50: +H.pct(a, 50).toFixed(2), p95: +H.pct(a, 95).toFixed(2), p99: +H.pct(a, 99).toFixed(2), max: +Math.max(...a).toFixed(2), mean: +(a.reduce((x, y) => x + y, 0) / a.length).toFixed(2) });

async function mixedLoad(agents, rounds, perType, files) {
  // one round = SessionStart-less mixed sequence; every agent owns a disjoint slice of files
  await Promise.all(agents.map(async (A, ai) => {
    const mine = files.filter((_, i) => i % agents.length === ai);
    for (let r = 0; r < rounds; r++) {
      const f = mine[r % mine.length];
      const t = async (kind, p) => { const res = await p; (perType[kind] ||= []).push(res.ms); return res; };
      await t('Read', A.read(f));
      await t('Read', A.read(mine[(r + 1) % mine.length]));
      const cur = fs.readFileSync(A.abs(f), 'utf8');
      const input = { file_path: A.abs(f), old_string: cur.match(/\+ (\d+);/)[0], new_string: `+ ${r + 1000};` };
      await t('PreToolUse(Edit)', A.hook('PreToolUse', { tool_name: 'Edit', tool_input: input }));
      fs.writeFileSync(A.abs(f), cur.replace(input.old_string, input.new_string));
      await t('PostToolUse(Edit)', A.hook('PostToolUse', { tool_name: 'Edit', tool_input: input, tool_response: {} }));
      await t('PostToolUse(Bash)', A.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'ls -la' }, tool_response: { stdout: '' } }));
      await t('UserPromptSubmit', A.hook('UserPromptSubmit', { prompt: 'continue with the task' }));
    }
  }));
}

function repo300() {
  const files = {};
  for (let i = 0; i < 300; i++) files[`src/m${i % 15}/f${i}.js`] = `export function fn${i}(x) {\n  return x + ${i};\n}\nexport function other${i}(a, b) {\n  return a * b;\n}\n`;
  return H.mkRepo(files, { version: 1, revalidate: 'always', rules: [{ path: '', checks: ['true'] }] });
}
const FILES = Array.from({ length: 300 }, (_, i) => `src/m${i % 15}/f${i}.js`);

test('P1 hook latency, 1 client, >= 2000 mixed hooks (client-side, keep-alive) and server-side /api/stats', async () => {
  const repo = repo300();
  await H.withDaemon(PORT, { repo }, async ({ d }) => {
    const A = new H.Agent(d, repo, 'solo'); await A.start();
    const per = {}; const all0 = Date.now();
    await mixedLoad([A], 400, per, FILES);         // 400 rounds x 6 = 2400 hooks
    const wall = Date.now() - all0;
    const all = Object.values(per).flat();
    assert.ok(all.length >= 2000, 'hooks sent: ' + all.length);
    const client = stat(all);
    const byType = Object.fromEntries(Object.entries(per).map(([k, v]) => [k, stat(v)]));
    const srv = (await H.httpJson(PORT, 'GET', '/api/stats')).json;
    H.recordMetric('P1_client_ms_all', client);
    H.recordMetric('P1_client_ms_by_type', byType);
    H.recordMetric('P1_server_stats', srv);
    H.recordMetric('P1_throughput_hooks_per_s', +(all.length / (wall / 1000)).toFixed(0));
    assert.ok(client.p95 < 50, 'p95 under 50 ms: ' + client.p95);
  });
});

test('P2 hook latency, 4 agents in parallel, >= 2000 mixed hooks', async () => {
  const repo = repo300();
  await H.withDaemon(PORT, { repo }, async ({ d }) => {
    const agents = []; for (let i = 0; i < 4; i++) { const A = new H.Agent(d, repo, 'p' + i); await A.start(); agents.push(A); }
    const per = {}; const t0 = Date.now();
    await mixedLoad(agents, 100, per, FILES);       // 4 x 100 x 6 = 2400 hooks
    const wall = Date.now() - t0;
    const all = Object.values(per).flat();
    assert.ok(all.length >= 2000);
    H.recordMetric('P2_client_ms_all_4_parallel', stat(all));
    H.recordMetric('P2_server_stats', (await H.httpJson(PORT, 'GET', '/api/stats')).json);
    H.recordMetric('P2_throughput_hooks_per_s', +(all.length / (wall / 1000)).toFixed(0));
    assert.ok(stat(all).p95 < 100);
  });
});

test('P3 agent-visible overhead of one edit (Pre + Post hook) vs. an edit with no hooks', async () => {
  const repo = repo300();
  await H.withDaemon(PORT, { repo }, async ({ d }) => {
    const A = new H.Agent(d, repo, 'one'); await A.start();
    const f = FILES[0];
    const N = 300, withHooks = [], bare = [];
    for (let i = 0; i < N; i++) {
      const cur = fs.readFileSync(A.abs(f), 'utf8');
      const m = cur.match(/\+ (\d+);/)[0];
      const t0 = process.hrtime.bigint();
      const input = { file_path: A.abs(f), old_string: m, new_string: `+ ${i + 5000};` };
      await A.hook('PreToolUse', { tool_name: 'Edit', tool_input: input });
      fs.writeFileSync(A.abs(f), cur.replace(m, input.new_string));
      await A.hook('PostToolUse', { tool_name: 'Edit', tool_input: input, tool_response: {} });
      withHooks.push(Number(process.hrtime.bigint() - t0) / 1e6);
      const t1 = process.hrtime.bigint();
      fs.writeFileSync(A.abs(f), fs.readFileSync(A.abs(f), 'utf8'));
      bare.push(Number(process.hrtime.bigint() - t1) / 1e6);
    }
    H.recordMetric('P3_edit_with_hooks_ms', stat(withHooks));
    H.recordMetric('P3_edit_no_hooks_ms', stat(bare));
  });
});

test('P4 hook latency with a NEW TCP connection per hook (no keep-alive), 500 hooks', async () => {
  const repo = repo300();
  await H.withDaemon(PORT, { repo }, async ({ d }) => {
    const A = new H.Agent(d, repo, 'nk', { agent: false }); await A.start();
    const lat = [];
    for (let i = 0; i < 500; i++) lat.push((await A.read(FILES[i % FILES.length])).ms);
    H.recordMetric('P4_client_ms_no_keepalive', stat(lat));
  });
});

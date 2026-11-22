// SECURITY: HTTP surface. Port 7820.
import test from 'node:test';
import assert from 'node:assert/strict';
import * as H from './helpers.mjs';

const PORT = 7820;

test('A1 /api/file does not serve files outside the indexed tree (traversal, absolute, .git, key, token)', () =>
  H.withDaemon(PORT, {}, async () => {
    const ok = await H.httpJson(PORT, 'GET', '/api/file?path=src/pay.js');
    assert.equal(ok.status, 200); assert.ok(ok.json.symbols);
    for (const p of ['../../../../etc/passwd', '/etc/passwd', '%2e%2e%2f%2e%2e%2fetc%2fpasswd', '.git/config', '.git/canopy/key.pem', '.git/canopy/human.token']) {
      const r = await H.httpJson(PORT, 'GET', '/api/file?path=' + (p.includes('%') ? p : encodeURIComponent(p)));
      assert.equal(/root:|PRIVATE KEY|\[core\]/.test(r.text), false, `leaked content for ${p}`);
    }
    for (const u of ['/../../../etc/passwd', '/..%2f..%2fetc%2fpasswd', '/%2e%2e/%2e%2e/etc/passwd']) {
      const r = await H.httpJson(PORT, 'GET', u);
      assert.equal(/root:/.test(r.text), false, u);
    }
  }));

test('A2 CANOPY_TOKEN: API and hook endpoints require the bearer token; wrong token refused', () =>
  H.withDaemon(PORT, { daemonOpts: { token: 's3cret' } }, async ({ repo }) => {
    for (const u of ['/api/state', '/api/stats', '/api/pending', '/api/why?target=src/pay.js']) {
      assert.equal((await H.httpJson(PORT, 'GET', u)).status, 401, u + ' without token');
      assert.equal((await H.httpJson(PORT, 'GET', u, undefined, { headers: { authorization: 'Bearer nope' } })).status, 401, u + ' wrong token');
      assert.equal((await H.httpJson(PORT, 'GET', u, undefined, { headers: { authorization: 'Bearer s3cret' } })).status, 200, u + ' right token');
    }
    const body = { session_id: 'x', cwd: repo, hook_event_name: 'SessionStart' };
    assert.equal((await H.httpJson(PORT, 'POST', '/hook', body)).status, 401);
    assert.equal((await H.httpJson(PORT, 'POST', '/hook', body, { headers: { authorization: 'Bearer s3cret' } })).status, 200);
    assert.equal((await H.httpJson(PORT, 'POST', '/api/approve', { id: 'x', token: 'y' })).status, 401);
  }));

test('A3 CLI without CANOPY_TOKEN against a token-protected daemon fails with a readable message', () =>
  H.withDaemon(PORT, { daemonOpts: { token: 's3cret' } }, async ({ repo }) => {
    const r = H.cli(repo, PORT, ['status']);
    assert.notEqual(r.code, 0);
    H.recordMetric('A3_cli_error_text', r.err.trim().slice(0, 120));
    assert.match(r.err, /token/i, 'error should mention the token; got: ' + r.err.trim());
  }));

test('A4 hook payloads from outside the repository, malformed bodies, and unknown events do not crash the daemon', () =>
  H.withDaemon(PORT, {}, async ({ d }) => {
    const bodies = [
      { session_id: 'x', cwd: '/etc', hook_event_name: 'PostToolUse', tool_name: 'Read', tool_input: { file_path: '/etc/passwd' } },
      { session_id: 'x', cwd: '/nonexistent/dir', hook_event_name: 'PreToolUse', tool_name: 'Edit', tool_input: { file_path: '../../x', old_string: 'a', new_string: 'b' } },
      { hook_event_name: 'Nope' }, {}, { session_id: 1, cwd: null, hook_event_name: 'PostToolUse', tool_name: 'Edit', tool_input: null },
      'garbage', [], null,
    ];
    for (const b of bodies) { const r = await H.httpJson(PORT, 'POST', '/hook', b); assert.ok(r.status < 500, JSON.stringify(b) + ' -> ' + r.status); }
    const raw = await new Promise((resolve) => {
      const s = require_net().connect(PORT, '127.0.0.1', () => { s.write('POST /hook HTTP/1.1\r\nHost: x\r\nContent-Length: 5\r\n\r\n{not'); s.end(); });
      let o = ''; s.on('data', (c) => { o += c; }); s.on('close', () => resolve(o)); s.on('error', () => resolve('err'));
    });
    assert.equal(d.child.exitCode, null, 'daemon still alive: ' + d.log.slice(-300));
    assert.equal((await H.httpJson(PORT, 'GET', '/api/stats')).status, 200);
    void raw;
  }));

import net from 'node:net';
function require_net() { return net; }

test('A5 GET /api/events (server-sent events) pushes an event when an agent acts', () =>
  H.withDaemon(PORT, {}, async ({ d, repo }) => {
    const chunks = [];
    const req = (await import('node:http')).get({ host: '127.0.0.1', port: PORT, path: '/api/events' }, (res) => {
      assert.match(res.headers['content-type'] || '', /text\/event-stream/);
      res.on('data', (c) => chunks.push(c.toString()));
    });
    await H.sleep(200);
    const A = new H.Agent(d, repo, 'a'); await A.start(); await A.read('src/pay.js');
    await A.edit('src/pay.js', 'return amount * 100;', 'return amount * 101;');
    const got = await H.waitFor(() => chunks.join('').includes('pay.js'), { timeout: 3000 });
    req.destroy();
    H.recordMetric('A5_sse_bytes', chunks.join('').length);
    assert.ok(got.value, 'an event mentioning the edited file arrived: ' + chunks.join('').slice(0, 300));
  }));

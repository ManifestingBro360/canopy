// canopyd: one HTTP server on localhost. Hooks in, state and events out.
import { createServer } from 'node:http';
import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';
import { openStore } from './store.mjs';
import { Engine } from './engine.mjs';
import { Gate } from './gate.mjs';
import { loadOrCreateKey } from './sign.mjs';
import { worktreeOf, lsTree, showFile } from './git.mjs';
import { identify, usersExist } from './access.mjs';
import { parseManifest, isManifest, lookup } from './advisories.mjs';
import { Notifier, listChannels } from './notify.mjs';
import { basename } from 'node:path';

const UI = join(dirname(fileURLToPath(import.meta.url)), '..', 'ui', 'index.html');

export function paths(cwd) {
  const wt = worktreeOf(cwd);
  if (!wt) throw new Error('not inside a Git repository: ' + cwd);
  return { ...wt, home: process.env.CANOPY_HOME || join(wt.common, 'canopy') };
}

// One state directory serves one repository. Sharing it would mix their holds and records.
function bindHome(home, common) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const f = join(home, 'repo');
  if (!existsSync(f)) writeFileSync(f, common + '\n');
  else if (readFileSync(f, 'utf8').trim() !== common) throw new Error(`${home} already holds the state of another repository (${readFileSync(f, 'utf8').trim()}). Give each repository its own CANOPY_HOME.`);
}

export async function serve({ cwd, port = Number(process.env.CANOPY_PORT) || 7717, quiet = false }) {
  const p = paths(cwd);
  bindHome(p.home, p.common);
  const store = openStore(p.home);
  const key = loadOrCreateKey(p.home);
  const t0 = performance.now();
  const engine = new Engine({ repo: p.top, common: p.common, home: p.home, store, pub: key.pub });
  const indexMs = Math.round(performance.now() - t0);
  engine.out = new Notifier(store, () => engine.ruleset, basename(p.top));
  const gate = new Gate(engine, key, p.home);
  const token = process.env.CANOPY_TOKEN || null;
  const lat = [];

  const send = (res, code, obj) => {
    const body = JSON.stringify(obj);
    res.writeHead(code, { 'content-type': 'application/json', 'content-length': Buffer.byteLength(body), 'cache-control': 'no-store' });
    res.end(body);
  };
  const readBody = (req) => new Promise((resolve, reject) => {
    const chunks = []; let n = 0;
    req.on('data', (c) => { n += c.length; if (n > 8_000_000) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => { try { resolve(chunks.length ? JSON.parse(Buffer.concat(chunks).toString('utf8')) : {}); } catch (e) { reject(e); } });
    req.on('error', reject);
  });

  const server = createServer(async (req, res) => {
    try {
      const url = new URL(req.url, 'http://x');
      const host = String(req.headers.host || '').split(':')[0];
      // Only local callers; a web page in a browser must not be able to drive the API.
      if (!['127.0.0.1', 'localhost', '[::1]'].includes(host)) return send(res, 403, { error: 'bad host' });
      const origin = req.headers.origin;
      if (origin && !/^https?:\/\/(127\.0\.0\.1|localhost)(:\d+)?$/.test(origin)) return send(res, 403, { error: 'bad origin' });
      if (req.method === 'POST' && !String(req.headers['content-type'] || '').startsWith('application/json')) return send(res, 415, { error: 'json only' });
      // Who is asking. A valid user token also satisfies the single shared token of 0.1.
      const who = identify(store, req);
      const strict = usersExist(store);
      if (token && url.pathname !== '/' && !who.user && req.headers.authorization !== 'Bearer ' + token) return send(res, 401, { error: 'token required' });
      const needUser = () => (strict && !who.user ? (send(res, 401, { error: 'this canopyd has users: send your own token (CANOPY_TOKEN)' }), true) : false);

      if (req.method === 'POST' && url.pathname === '/hook') {
        // Once users exist, an event from nobody is not recorded. The harness
        // carries on (hooks fail open) and the gate sees the work as unwitnessed.
        if (needUser()) return;
        const body = await readBody(req);
        // Tool output is not kept. Only search tools' results are looked at, for the file paths in them.
        if (body && body.tool_name !== 'Grep' && body.tool_name !== 'Glob') delete body.tool_response;
        const a = performance.now();
        let out = {};
        try { out = engine.handle(body, who); } catch (e) { if (!quiet) console.error('[canopy] hook error:', e.message); }
        lat.push(performance.now() - a); if (lat.length > 5000) lat.shift();
        return send(res, 200, out);
      }
      if (req.method === 'GET') {
        if (url.pathname === '/') { res.writeHead(200, { 'content-type': 'text/html; charset=utf-8', 'cache-control': 'no-store' }); return res.end(readFileSync(UI)); }
        if (url.pathname === '/api/state') return send(res, 200, engine.state(url.searchParams.get('rev')));
        if (url.pathname === '/api/file') return send(res, 200, engine.fileView(url.searchParams.get('path') || '') || { error: 'unknown file' });
        if (url.pathname === '/api/why') return send(res, 200, engine.why(url.searchParams.get('target') || ''));
        if (url.pathname === '/api/pending') return send(res, 200, gate.pending());
        if (url.pathname === '/api/whoami') return send(res, 200, { user: who.user, role: who.role, users: strict });
        if (url.pathname === '/api/environments') return send(res, 200, gate.environments());
        if (url.pathname === '/api/channels') return send(res, 200, { channels: listChannels(store), routes: engine.ruleset.notify, sent: engine.out.sent, failed: engine.out.failed });
        if (url.pathname === '/api/catchup') {
          const w = worktreeOf(url.searchParams.get('cwd') || '');
          if (!w || w.common !== p.common) return send(res, 200, { error: 'not a worktree of this repository' });
          engine.refresh();
          const items = engine.catchup(w.top, url.searchParams.get('path') || '');
          return send(res, 200, { items, text: items.length ? engine.catchupText(items, 40) : '' });
        }
        if (url.pathname === '/api/audit') {
          // The log holds addresses and names: once users exist, only an administrator reads it.
          if (strict && who.role !== 'admin') return send(res, 403, { error: 'the audit log is for administrators' });
          const n = Math.min(Number(url.searchParams.get('limit')) || 100, 1000), user = url.searchParams.get('user');
          const rows = user ? store.all('select seq, ts, user, ip, action, target, detail from audit where user=? order by seq desc limit ?', user, n)
            : store.all('select seq, ts, user, ip, action, target, detail from audit order by seq desc limit ?', n);
          return send(res, 200, rows.map((r) => ({ ...r, detail: JSON.parse(r.detail || '{}') })));
        }
        if (url.pathname === '/api/advisories') {
          // Sends package names and versions to OSV.dev, so only when the rules on main ask for it.
          if (!engine.ruleset.advisories) return send(res, 200, { error: 'advisories are off. Add "advisories": { "source": "osv" } to .canopy/rules.json on ' + engine.main + ' to turn them on.' });
          const deps = new Map();
          for (const f of lsTree(p.top, engine.graph.rev).map((x) => x.path).filter(isManifest)) {
            for (const d of parseManifest(f, showFile(p.top, engine.graph.rev, f) || '')) deps.set(d.ecosystem + d.name + d.version, { ...d, manifest: f });
          }
          const r = await lookup([...deps.values()]);
          return send(res, 200, { checked: deps.size, ...r });
        }
        if (url.pathname === '/api/stats') {
          const s = [...lat].sort((x, y) => x - y);
          const pct = (q) => (s.length ? Math.round(s[Math.min(s.length - 1, Math.floor(q * s.length))] * 1000) / 1000 : 0);
          return send(res, 200, { hooks: s.length, hook_ms_p50: pct(0.5), hook_ms_p95: pct(0.95), hook_ms_max: pct(1), index_ms: indexMs, check_runs: gate.checkRuns, files: engine.graph.files.size, nodes: engine.graph.nodes.size, key_id: key.id });
        }
        if (url.pathname === '/api/wait') {
          const w = worktreeOf(url.searchParams.get('cwd') || '');
          const r = await engine.waitFor(url.searchParams.get('node') || '', w ? w.top : '', Math.min(Number(url.searchParams.get('ms')) || 600_000, 3_600_000));
          return send(res, 200, r);
        }
        if (url.pathname === '/api/events') {
          res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-store', connection: 'keep-alive' });
          res.write('retry: 2000\n\n');
          const l = (ev) => res.write('data: ' + JSON.stringify(ev) + '\n\n');
          store.listeners.add(l);
          const beat = setInterval(() => res.write(': beat\n\n'), 20_000);
          req.on('close', () => { clearInterval(beat); store.listeners.delete(l); });
          return;
        }
      }
      if (req.method === 'POST') {
        const body = await readBody(req);
        if (url.pathname === '/api/land') return send(res, 200, await gate.land({ cwd: body.cwd, intent: body.intent, who }));
        if (url.pathname === '/api/approve') {
          // The map's approval box sends the approver's token in the body.
          let approver = who;
          if (!approver.user && typeof body.token === 'string' && body.token.startsWith('cnp_')) approver = identify(store, { socket: req.socket, headers: { ...req.headers, authorization: 'Bearer ' + body.token } });
          return send(res, 200, await gate.approve(body.id, { who: approver, token: body.token, by: body.by }));
        }
        if (url.pathname === '/api/concerns') return send(res, 200, gate.concerns(String(body.id || ''), { who }));
        if (url.pathname === '/api/promote') return send(res, 200, await gate.promote({ env: String(body.env || ''), commit: body.commit ? String(body.commit) : undefined, who }));
        if (url.pathname === '/api/checkin') { if (needUser()) return; return send(res, 200, await engine.checkin({ cwd: String(body.cwd || ''), model: body.model, harness: body.harness }, who)); }
        // Releasing drops holds and the in-flight record. It does not forget that outside content was taken in.
        if (url.pathname === '/api/release') {
          if (needUser()) return;
          const w = worktreeOf(body.cwd || '');
          if (w && w.common === p.common) { engine.release(w.top); store.audit(who, 'release', engine.wtName(w.top), {}); }
          return send(res, 200, { ok: !!w });
        }
        if (url.pathname === '/api/clear-taint') {
          if (strict ? who.role !== 'admin' : !gate.isHuman(body.token)) return send(res, 200, { status: 'error', message: strict ? 'clearing taint needs an administrator\'s token' : 'clearing taint needs the human token' });
          const w = worktreeOf(body.cwd || '');
          if (w && w.common === p.common) { store.run('delete from taint where worktree=?', w.top); store.audit(who, 'taint.clear', engine.wtName(w.top), {}); }
          return send(res, 200, { status: 'ok' });
        }
        if (url.pathname === '/api/refresh') return send(res, 200, engine.refresh());
      }
      send(res, 404, { error: 'not found' });
    } catch (e) {
      if (!quiet) console.error('[canopy]', e);
      try { send(res, 500, { error: String(e.message || e) }); } catch { /* socket closed */ }
    }
  });
  setInterval(() => { try { engine.gc(); } catch { /* next round */ } }, 30_000).unref();
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(port, '127.0.0.1', resolve); });
  writeFileSync(join(p.home, 'port'), String(server.address().port));
  gate.port = server.address().port;
  if (!quiet) {
    console.log(`canopyd  http://127.0.0.1:${server.address().port}`);
    console.log(`repo     ${p.top}  (${engine.main} @ ${String(engine.graph.rev).slice(0, 8)})`);
    console.log(`index    ${engine.graph.files.size} files, ${engine.graph.nodes.size} nodes in ${indexMs} ms`);
    console.log(`key      ${key.id}   human token: ${join(p.home, 'human.token')}`);
  }
  return { server, engine, gate, store, key, home: p.home, port: server.address().port };
}

// Canopy 0.2: people, ownership, model policy, manager, advisories,
// environments, catch-up. Each test names the row of the brief it pins.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { mkRepo, addWorktree, startDaemon, httpJson, git, gitOk, tmp, cli, waitFor, ROOT, GIT_ENV } from './helpers.mjs';
import { loadRules, modelMatch } from '../src/rules.mjs';
import { parseManifest, lookup } from '../src/advisories.mjs';

const FILES = {
  'package.json': '{"type":"module"}\n',
  'pay/charge.js': "export function charge(amount, currency) {\n  const cents = amount * 100;\n  return cents;\n}\n",
  'shop/cart.js': "import { charge } from '../pay/charge.js';\nexport function total() {\n  return charge(5, 'usd');\n}\n",
  'lib/util.js': "export function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x));\n}\n",
};
const rules = (extra = {}, list = [{ path: '' }]) => ({ version: 1, rules: list, ...extra });
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';
const reason = (r) => r.json?.hookSpecificOutput?.permissionDecisionReason || '';
const context = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
let seq = 0;

// A repository, its daemon, some users, and agents that act for them.
async function world(port, ruleDoc, { users = [], env = {}, files = FILES } = {}, fn) {
  const repo = mkRepo(files, ruleDoc);
  const tokens = {};
  for (const u of users) {
    const [name, admin] = u.split(':');
    const r = cli(repo, port, ['user', 'add', name, '--json', ...(admin ? ['--admin'] : [])]);
    assert.equal(r.code, 0, r.err);
    tokens[name] = r.json.token;
  }
  const d = await startDaemon(repo, port, { env });
  const as = (user) => (user ? { authorization: 'Bearer ' + tokens[user] } : {});
  const agent = (user, { model = 'claude-fable-5-2', harness } = {}) => {
    const name = `w${++seq}`, wt = addWorktree(repo, name), sid = `s-${name}`, headers = as(user);
    const hook = (event, extra = {}, sess = sid) => httpJson(port, 'POST', '/hook', { session_id: sess, cwd: wt, hook_event_name: event, ...(harness ? { harness } : {}), ...extra }, { headers });
    const a = {
      wt, name, hook, headers,
      start: (m = model, sess = sid) => hook('SessionStart', { source: 'startup', ...(m ? { model: m } : {}) }, sess),
      read: (p) => hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(wt, p) } }),
      pre: (p, sess = sid) => hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(wt, p) } }, sess),
      async write(p, text, sess = sid) {
        const pre = await a.pre(p, sess);
        if (denied(pre)) return { denied: true, reason: reason(pre) };
        fs.mkdirSync(path.dirname(path.join(wt, p)), { recursive: true });
        fs.writeFileSync(path.join(wt, p), text);
        const post = await hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(wt, p) } }, sess);
        return { denied: false, warn: context(pre), post };
      },
      async shell(p, text, sess = sid) {
        fs.writeFileSync(path.join(wt, p), text);
        await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'sed -i x ' + p } }, sess);
        await waitFor(async () => (await httpJson(port, 'GET', '/api/state')).json.writes.some((w) => w.wt === path.basename(wt) && w.path === p));
      },
      commit(msg = 'work') { gitOk(wt, 'add', '-A'); gitOk(wt, 'commit', '-q', '-m', msg); },
      land: async (intent, hdrs = headers) => (await httpJson(port, 'POST', '/api/land', { cwd: wt, intent }, { headers: hdrs })).json,
    };
    return a;
  };
  // Give up a worktree's unlanded work, so its holds do not stand in the next agent's way.
  const release = (a) => httpJson(port, 'POST', '/api/release', { cwd: a.wt }, { headers: a.headers });
  const approve = async (id, user, body = {}) => (await httpJson(port, 'POST', '/api/approve', { id, ...body }, { headers: as(user) })).json;
  const get = async (p, user) => (await httpJson(port, 'GET', p, undefined, { headers: as(user) }));
  try { return await fn({ repo, d, port, tokens, as, agent, approve, get, release }); } finally { d.kill(); }
}
const BODY2 = "export function charge(amount, currency) {\n  const cents = Math.round(amount * 100);\n  return cents;\n}\n";
const SIG2 = "export function charge(amount, currency, mode) {\n  const cents = Math.round(amount * 100);\n  return cents;\n}\n";

// ---- identity ------------------------------------------------------------

test('identity: once users exist, nothing lands, approves or is recorded without a valid token; tokens are never stored in clear', async () => {
  await world(7900, rules(), { users: ['asha:admin', 'carol'] }, async ({ repo, d, port, tokens, agent, get }) => {
    const anon = agent(null);
    const h = await anon.start();
    assert.equal(h.status, 401, 'a hook event from nobody is refused');
    fs.writeFileSync(path.join(anon.wt, 'lib/util.js'), FILES['lib/util.js'] + '// x\n'); anon.commit();
    const l = await anon.land();
    assert.equal(l.status, 'error'); assert.match(l.message, /CANOPY_TOKEN/);
    const bogus = await httpJson(port, 'POST', '/api/land', { cwd: anon.wt }, { headers: { authorization: 'Bearer cnp_not-a-real-token' } });
    assert.equal(bogus.json.status, 'error');

    const c = agent('carol');
    assert.equal((await c.start('claude-fable-5-2')).status, 200);
    const s = (await get('/api/state')).json.sessions.find((x) => x.wt === path.basename(c.wt));
    assert.equal(s.user, 'carol'); assert.equal(s.model, 'claude-fable-5-2');
    assert.deepEqual((await get('/api/whoami', 'carol')).json, { user: 'carol', role: 'member', users: true });

    const home = path.join(repo, '.git', 'canopy');
    for (const f of fs.readdirSync(home)) {
      const buf = fs.readFileSync(path.join(home, f));
      for (const t of Object.values(tokens)) assert.ok(!buf.includes(t), `token found in clear in ${f}`);
    }
    for (const t of Object.values(tokens)) assert.ok(!d.log.includes(t), 'token in the daemon log');

    assert.equal(cli(repo, port, ['user', 'disable', 'carol']).code, 0);
    assert.equal((await c.hook('UserPromptSubmit', { prompt: 'x' })).status, 401, 'a disabled user\'s token stops working at once');
  });
});

test('identity: the audit log names the person and the address, only administrators read it, and no address reaches Git', async () => {
  await world(7901, rules(), { users: ['asha:admin', 'carol'] }, async ({ repo, agent, get }) => {
    const c = agent('carol');
    await c.start(); await c.write('lib/util.js', FILES['lib/util.js'] + 'export const one = 1;\n'); c.commit();
    const l = await c.land('add a constant');
    assert.equal(l.status, 'landed', JSON.stringify(l.reasons));
    assert.equal(l.record.by, 'carol');
    assert.deepEqual(l.record.authors, [{ user: 'carol', harness: 'claude-code', model: 'claude-fable-5-2' }]);
    assert.equal((await get('/api/audit', 'carol')).status, 403);
    const log = (await get('/api/audit', 'asha')).json;
    const landed = log.find((e) => e.action === 'land.landed');
    assert.equal(landed.user, 'carol'); assert.equal(landed.ip, '127.0.0.1');
    assert.ok(log.some((e) => e.action === 'session.start' && e.detail.model === 'claude-fable-5-2'));
    const note = gitOk(repo, 'notes', '--ref=canopy', 'show', l.commit);
    assert.ok(note.includes('"carol"') && !note.includes('127.0.0.1'), 'the signed record names the person but not the address');
  });
});

// ---- ownership -----------------------------------------------------------

const OWNED = (n = 1, more = {}) => rules({ teams: { payments: ['asha', 'ben'] } }, [{ path: '' }, { path: 'pay/', owners: ['@payments'], approvals: n, ...more }]);

test('ownership: a change in an owned section waits for an owner; the lander, a stranger and the shared token cannot approve it', async () => {
  await world(7902, OWNED(), { users: ['asha', 'ben', 'carol', 'dave'] }, async ({ d, agent, approve, port }) => {
    const c = agent('carol');
    await c.start(); await c.write('pay/charge.js', BODY2); c.commit();
    const l = await c.land('round cents');
    assert.equal(l.status, 'needs-human');
    assert.deepEqual(l.record.waiting_on.map((q) => [q.section, q.need, q.have]), [['pay/', 1, []]]);
    assert.match(l.reasons.join(' '), /owners of pay\/ \(asha, ben\)/);
    assert.match((await approve(l.id, 'carol')).message, /someone else has to approve/);
    assert.match((await approve(l.id, 'dave')).message, /no say over this landing/);
    const legacy = (await httpJson(port, 'POST', '/api/approve', { id: l.id, token: d.humanToken(), by: 'x' })).json;
    assert.equal(legacy.status, 'error'); assert.match(legacy.message, /own token/);
    const ok = await approve(l.id, 'asha');
    assert.equal(ok.status, 'landed', JSON.stringify(ok));
    assert.deepEqual(ok.record.approvals.map((x) => x.user), ['asha']);
    assert.equal(ok.record.by, 'carol');
  });
});

test('ownership: an owner landing counts as one approval; two-owner sections still need the second', async () => {
  await world(7903, OWNED(1), { users: ['asha', 'ben'] }, async ({ agent }) => {
    const a = agent('asha'); await a.start(); await a.write('pay/charge.js', BODY2); a.commit();
    assert.equal((await a.land()).status, 'landed');
  });
  await world(7904, OWNED(2), { users: ['asha', 'ben'] }, async ({ agent, approve }) => {
    const a = agent('asha'); await a.start(); await a.write('pay/charge.js', BODY2); a.commit();
    const l = await a.land();
    assert.equal(l.status, 'needs-human');
    assert.deepEqual(l.record.waiting_on[0].have, ['asha']);
    assert.match((await approve(l.id, 'asha')).message, /someone else/);
    assert.equal((await approve(l.id, 'ben')).status, 'landed');
  });
});

test('ownership: an approval covers one exact commit; a new commit needs it again', async () => {
  await world(7905, OWNED(), { users: ['asha', 'carol'] }, async ({ agent, approve }) => {
    const c = agent('carol'); await c.start(); await c.write('pay/charge.js', BODY2); c.commit();
    const l = await c.land();
    await c.write('pay/charge.js', BODY2.replace('Math.round', 'Math.floor')); c.commit('second thoughts');
    const r = await approve(l.id, 'asha');
    assert.equal(r.status, 'needs-human');
    assert.match(r.record.note, /approval must be given again/);
  });
});

test('ownership: owners who guard their dependents are asked when a signature they rely on changes, not for a body change', async () => {
  const doc = rules({}, [{ path: '' }, { path: 'shop/', owners: ['ben'], guard_dependents: true }]);
  await world(7906, doc, { users: ['ben', 'carol'] }, async ({ agent, approve }) => {
    const c = agent('carol'); await c.start(); await c.write('pay/charge.js', BODY2); c.commit();
    assert.equal((await c.land()).status, 'landed', 'a body change does not reach shop/');
    const c2 = agent('carol'); await c2.start(); await c2.read('shop/cart.js'); await c2.write('pay/charge.js', SIG2); c2.commit();
    const l = await c2.land();
    assert.equal(l.status, 'needs-human');
    assert.equal(l.record.waiting_on[0].section, 'shop/');
    assert.match(l.record.waiting_on[0].why, /depends on what this change alters \(.*shop\/cart\.js#total\)/);
    assert.equal((await approve(l.id, 'ben')).status, 'landed');
  });
});

test('ownership: rules that name owners are refused, not ignored, when canopyd has no users', async () => {
  await world(7907, OWNED(), {}, async ({ agent }) => {
    const a = agent(null); await a.start(); await a.write('pay/charge.js', BODY2); a.commit();
    const l = await a.land();
    assert.equal(l.status, 'blocked'); assert.match(l.reasons[0], /canopy user add/);
  });
});

// ---- access --------------------------------------------------------------

test('access: a user outside writers is refused at edit time, every time, and at the gate', async () => {
  const doc = rules({}, [{ path: '' }, { path: 'pay/', writers: ['asha'] }]);
  await world(7908, doc, { users: ['asha', 'carol'] }, async ({ agent, as, release }) => {
    const c = agent('carol'); await c.start();
    const one = await c.write('pay/charge.js', BODY2), two = await c.write('pay/charge.js', BODY2);
    assert.ok(one.denied && two.denied, 'not lifted by a retry');
    assert.match(one.reason, /carol may not change pay\/.*only: asha/);
    await c.shell('pay/charge.js', BODY2); c.commit();
    const l = await c.land();
    assert.equal(l.status, 'blocked'); assert.match(l.reasons[0], /carol may not change pay\//);
    // An allowed person cannot land work another person's session wrote there either.
    const l2 = await c.land(undefined, as('asha'));
    assert.equal(l2.status, 'blocked'); assert.match(l2.reasons[0], /carol may not change pay\//);
    await release(c);
    const a = agent('asha'); await a.start();
    assert.equal((await a.write('pay/charge.js', BODY2)).denied, false); a.commit();
    assert.equal((await a.land()).status, 'landed');
  });
});

// ---- model policy --------------------------------------------------------

const MODELS = rules({ model_tiers: { strong: ['claude-fable-*', 'gpt-5*'] } }, [{ path: '' }, { path: 'pay/', models: ['strong'] }]);

test('model policy: a disallowed model is refused at edit time; a model switch is followed', async () => {
  await world(7909, MODELS, { users: ['asha:admin', 'carol'] }, async ({ agent, get }) => {
    const weak = agent('carol'); await weak.start('llama-3-8b');
    const r = await weak.write('pay/charge.js', BODY2);
    assert.ok(r.denied); assert.match(r.reason, /these models only: strong.*llama-3-8b/);
    assert.equal((await weak.write('lib/util.js', FILES['lib/util.js'] + '// ok\n')).denied, false, 'elsewhere it may work');

    const sw = agent('carol'); await sw.start('gpt-5.5');
    assert.equal((await sw.pre('pay/charge.js')).json?.hookSpecificOutput?.permissionDecision, undefined);
    await sw.hook('PostModelSwitch', { from_model: 'gpt-5.5', to_model: 'tiny-1' });
    assert.equal((await get('/api/state')).json.sessions.find((x) => x.wt === path.basename(sw.wt)).model, 'tiny-1');
    assert.ok(denied(await sw.pre('pay/charge.js')));
  });
});

test('model policy: an unknown model, or an earlier weak model hidden under a later strong edit, cannot land without a person', async () => {
  await world(7910, MODELS, { users: ['asha:admin', 'carol'] }, async ({ agent, approve, release }) => {
    const u = agent('carol'); await u.start(null);
    const w = await u.write('pay/charge.js', BODY2);
    assert.equal(w.denied, false); assert.match(w.warn, /model is not known/);
    u.commit();
    const l = await u.land();
    assert.equal(l.status, 'needs-human'); assert.match(l.reasons.join(' '), /model is not known/);
    assert.equal((await approve(l.id, 'asha')).status, 'landed');

    const m = agent('carol');
    await m.start('llama-3-8b', 's-weak');
    await m.shell('pay/charge.js', SIG2.replace('mode', 'opts'), 's-weak');   // a shell edit has no pre-edit check
    await m.start('claude-fable-5-2', 's-strong');
    assert.equal((await m.write('pay/charge.js', SIG2, 's-strong')).denied, false);
    fs.writeFileSync(path.join(m.wt, 'shop/cart.js'), FILES['shop/cart.js']); m.commit();
    const l2 = await m.land();
    assert.equal(l2.status, 'needs-human');
    assert.match(l2.reasons.join(' '), /written by: .*llama-3-8b/);

    await release(m);
    const s = agent('carol'); await s.start('gpt-5.5'); await s.write('pay/charge.js', BODY2.replace('round', 'trunc')); s.commit();
    assert.equal((await s.land()).status, 'landed', 'an allowed model lands as usual');
  });
});

test('model policy: patterns match whole names, ignoring case', () => {
  assert.ok(modelMatch('claude-fable-*', 'claude-fable-5-2') && modelMatch('GPT-5*', 'gpt-5.5') && modelMatch('openai/*', 'openai/gpt-5'));
  assert.ok(!modelMatch('gpt-5*', 'not-gpt-5') && !modelMatch('gpt-5.5', 'gpt-5x5') && !modelMatch('claude-fable-*', ''));
});

// ---- manager -------------------------------------------------------------

test('manager: block blocks, concern and garbage and silence ask for a person, and it is given the facts and the diff', async () => {
  const dir = tmp('cnp-mgr-'), stub = path.join(dir, 'stub.mjs'), seen = path.join(dir, 'seen.json');
  fs.writeFileSync(stub, `import fs from 'node:fs';
let t = ''; for await (const c of process.stdin) t += c;
const d = JSON.parse(t); fs.writeFileSync(${JSON.stringify(seen)}, t);
// A manager that has been talked into misbehaving: try to read canopyd's key and write into its state.
const K = fs.readFileSync(${JSON.stringify(path.join(dir, 'home.txt'))}, 'utf8');
let stole = 'no'; try { stole = fs.readFileSync(K + '/key.pem', 'utf8').slice(0, 20); } catch (e) { stole = 'denied'; }
try { fs.writeFileSync(K + '/leak', 'x'); } catch {}
fs.writeFileSync(${JSON.stringify(seen)} + '.key', stole);
const say = (v) => console.log(JSON.stringify({ verdict: v, summary: v + ' because ' + d.intent, model: 'stub-1', findings: [{ severity: 'high', file: 'lib/util.js', note: 'look here' }] }));
if (/BLOCK/.test(d.intent)) say('block'); else if (/CONCERN/.test(d.intent)) say('concern');
else if (/GARBAGE/.test(d.intent)) console.log('I think it is fine {"verdict":"approve"}');
else if (/SLOW/.test(d.intent)) await new Promise((r) => setTimeout(r, 8000)); else if (/EXIT/.test(d.intent)) process.exit(3); else say('pass');
`);
  const doc = rules({ manager: { cmd: `node ${stub}`, when: 'always', timeout_ms: 1500 } });
  await world(7911, doc, {}, async ({ repo, d, agent, port }) => {
    fs.writeFileSync(path.join(dir, 'home.txt'), path.join(repo, '.git', 'canopy'));
    const go = async (intent, text) => { const a = agent(null); await a.start(); await a.write('lib/util.js', FILES['lib/util.js'] + text); a.commit(); return a.land(intent); };
    const pass = await go('tidy', '// a\n');
    assert.equal(pass.status, 'landed'); assert.equal(pass.record.manager.verdict, 'pass'); assert.equal(pass.record.manager.model, 'stub-1');
    const dossier = JSON.parse(fs.readFileSync(seen, 'utf8'));
    assert.ok(dossier.diff.includes('+// a') && dossier.write_set.length && dossier.intent === 'tidy' && Array.isArray(dossier.authors));
    const block = await go('BLOCK it', '// b\n');
    assert.equal(block.status, 'blocked'); assert.match(block.reasons[0], /manager refused this change about lib\/util\.js \[high\]/);
    // Its words stay with the people who decide; they are not handed back to whoever asked.
    assert.ok(!JSON.stringify(block).includes('look here') && !JSON.stringify(block).includes('because BLOCK'));
    assert.equal(block.record.manager.summary, undefined);
    // With no users the API hands the notes to nobody, whatever token is sent; the operator reads them on the host.
    const viaApi = (await httpJson(port, 'POST', '/api/concerns', { id: block.id, token: d.humanToken() })).json;
    assert.equal(viaApi.status, 'host-only'); assert.ok(!JSON.stringify(viaApi).includes('look here'));
    const onHost = cli(repo, port, ['concerns', block.id]);
    assert.match(onHost.out, /block because BLOCK it/); assert.match(onHost.out, /look here/);
    assert.ok(!gitOk(repo, 'notes', '--ref=canopy', 'show', pass.commit).includes('pass because'), 'nor into the signed record');
    if (process.platform === 'darwin') {
      assert.equal(fs.readFileSync(seen + '.key', 'utf8'), 'denied', 'the manager cannot read the signing key');
      assert.ok(!fs.existsSync(path.join(repo, '.git', 'canopy', 'leak')), 'or write into canopyd\'s state');
    }
    for (const [intent, re] of [['CONCERN here', /manager raised concerns/], ['GARBAGE out', /no usable verdict/], ['SLOW one', /did not answer within/], ['EXIT now', /exited with 3/]]) {
      const r = await go(intent, `// ${intent}\n`);
      assert.equal(r.status, 'needs-human', intent); assert.match(r.reasons.join(' '), re);
      if (/CONCERN/.test(intent)) {
        const ok = (await httpJson(port, 'POST', '/api/approve', { id: r.id, token: d.humanToken(), by: 'lead' })).json;
        assert.equal(ok.status, 'landed'); assert.equal(ok.record.manager.verdict, 'concern');
      }
    }
  });
});

test('manager: a pass cannot turn a refusal into a landing, and by default it only looks at flagged changes', async () => {
  const dir = tmp('cnp-mgr-'), stub = path.join(dir, 'yes.mjs'), ran = path.join(dir, 'ran');
  fs.writeFileSync(stub, `import fs from 'node:fs'; fs.appendFileSync(${JSON.stringify(ran)}, 'x'); console.log('{"verdict":"pass","summary":"ship it"}');`);
  await world(7912, rules({ manager: { cmd: `node ${stub}` } }, [{ path: '' }, { path: 'pay/', protected: true }]), {}, async ({ agent }) => {
    const a = agent(null); await a.start(); await a.write('lib/util.js', FILES['lib/util.js'] + '// plain\n'); a.commit();
    const plain = await a.land();
    assert.equal(plain.status, 'landed'); assert.equal(plain.record.manager, undefined); assert.ok(!fs.existsSync(ran));
    const b = agent(null); await b.start(); await b.write('pay/charge.js', BODY2); b.commit();
    const prot = await b.land();
    assert.equal(prot.status, 'needs-human', 'the manager said pass; the protected file still needs a person');
    assert.equal(prot.record.manager.verdict, 'pass'); assert.ok(fs.existsSync(ran));
  });
});

test('manager: its written reasons go to an administrator or a waiting approver, never to the person who asked or wrote the change', async () => {
  const dir = tmp('cnp-mgr-'), stub = path.join(dir, 'c.mjs');
  fs.writeFileSync(stub, `console.log(JSON.stringify({ verdict: 'concern', summary: 'SECRET-LOOKING-TEXT', findings: [] }));`);
  const doc = rules({ manager: { cmd: `node ${stub}`, when: 'always' } }, [{ path: '' }, { path: 'pay/', owners: ['ben'] }]);
  await world(7924, doc, { users: ['asha:admin', 'ben', 'carol', 'dave'] }, async ({ port, agent, as }) => {
    const c = agent('carol'); await c.start(); await c.write('pay/charge.js', BODY2); c.commit();
    const l = await c.land();
    assert.equal(l.status, 'needs-human'); assert.ok(!JSON.stringify(l).includes('SECRET-LOOKING-TEXT'));
    const ask = async (user) => (await httpJson(port, 'POST', '/api/concerns', { id: l.id }, { headers: as(user) })).json;
    for (const user of ['carol', 'dave', null]) { const r = await ask(user); assert.equal(r.status, 'error', String(user)); assert.ok(!JSON.stringify(r).includes('SECRET')); }
    assert.equal((await ask('asha')).summary, 'SECRET-LOOKING-TEXT');
    assert.equal((await ask('ben')).summary, 'SECRET-LOOKING-TEXT', 'an owner whose approval is still open may read them');
  });
});

// ---- advisories ----------------------------------------------------------

const LOCK = (v) => JSON.stringify({ name: 'x', lockfileVersion: 3, packages: { '': { name: 'x' }, 'node_modules/lodash': { version: v }, 'node_modules/a/node_modules/left-pad': { version: '1.3.0' } } }, null, 1) + '\n';
function osvStub(port) {
  const asked = [];
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/v1/querybatch') { const q = JSON.parse(b).queries; asked.push(...q); return res.end(JSON.stringify({ results: q.map((x) => (x.package.name === 'lodash' && x.version === '4.17.15' ? { vulns: [{ id: 'GHSA-test-0001' }] } : {})) })); }
      res.end(JSON.stringify({ id: 'GHSA-test-0001', summary: 'Prototype pollution', database_specific: { severity: 'HIGH' }, affected: [{ package: { name: 'lodash', ecosystem: 'npm' }, ranges: [{ events: [{ introduced: '0' }, { fixed: '4.17.21' }] }] }] }));
    });
  });
  return new Promise((r) => srv.listen(port, '127.0.0.1', () => r({ srv, asked })));
}

test('advisories: a new dependency with a known advisory is reported with its fixed version, and only names and versions are sent', async () => {
  const { srv, asked } = await osvStub(7950);
  try {
    for (const [port, on_new, want] of [[7913, 'review', 'needs-human'], [7914, 'block', 'blocked']]) {
      await world(port, rules({ advisories: { source: 'osv', on_new } }), { env: { CANOPY_OSV_URL: 'http://127.0.0.1:7950' } }, async ({ agent, get }) => {
        const a = agent(null); await a.start(); await a.write('package-lock.json', LOCK('4.17.15')); a.commit();
        const l = await a.land();
        assert.equal(l.status, want);
        assert.match(l.reasons.join(' '), /lodash@4\.17\.15 GHSA-test-0001 \(fixed in 4\.17\.21\)/);
        assert.deepEqual(l.record.advisories.map((f) => [f.package, f.id, f.severity, f.fixed[0]]), [['lodash', 'GHSA-test-0001', 'HIGH', '4.17.21']]);
        if (want === 'needs-human') assert.equal((await get('/api/advisories')).json.checked, 0, 'main itself has no lock file yet');
        const safe = agent(null); await safe.start(); await safe.write('package-lock.json', LOCK('4.17.21')); safe.commit();
        const s = await safe.land();
        assert.deepEqual(s.record.advisories, []); assert.ok(!/advisories/.test(s.reasons.join(' ')));
      });
    }
    assert.deepEqual(Object.keys(asked[0]).sort(), ['package', 'version']);
    assert.deepEqual(asked[0].package, { name: 'lodash', ecosystem: 'npm' });
  } finally { srv.close(); }
});

test('advisories: off by default, and an unreachable service never blocks by default', async () => {
  await world(7915, rules(), { env: { CANOPY_OSV_URL: 'http://127.0.0.1:7950' } }, async ({ agent, get }) => {
    const a = agent(null); await a.start(); await a.write('package-lock.json', LOCK('4.17.15')); a.commit();
    const l = await a.land();
    assert.equal(l.record.advisory_status, undefined);
    assert.match((await get('/api/advisories')).json.error, /advisories are off/);
  });
  await world(7916, rules({ advisories: { source: 'osv', on_new: 'block' } }), { env: { CANOPY_OSV_URL: 'http://127.0.0.1:1' } }, async ({ agent }) => {
    const a = agent(null); await a.start(); await a.write('package-lock.json', LOCK('4.17.15')); a.commit();
    const l = await a.land();
    assert.equal(l.status, 'needs-human', 'only because lock files are protected');
    assert.match(l.record.advisory_status, /^unavailable/);
    assert.ok(!/vulnerability database/.test(l.reasons.join(' ')));
  });
});

test('advisories: manifests are read exactly', () => {
  assert.deepEqual(parseManifest('a/package-lock.json', LOCK('1.0.0')).map((d) => `${d.name}@${d.version}`), ['lodash@1.0.0', 'left-pad@1.3.0']);
  assert.deepEqual(parseManifest('requirements-dev.txt', 'Django==4.2.1\n# c\nrequests[socks] == 2.31.0 ; python_version > "3"\nflask>=2\n').map((d) => `${d.ecosystem}:${d.name}@${d.version}`), ['PyPI:django@4.2.1', 'PyPI:requests@2.31.0']);
  assert.deepEqual(parseManifest('go.mod', 'module x\n\ngo 1.22\n\nrequire (\n\tgithub.com/gin-gonic/gin v1.9.1\n\tgolang.org/x/net v0.17.0 // indirect\n)\nrequire github.com/a/b v0.1.0\n').map((d) => `${d.name}@${d.version}`), ['github.com/gin-gonic/gin@1.9.1', 'golang.org/x/net@0.17.0', 'github.com/a/b@0.1.0']);
  assert.deepEqual(parseManifest('Cargo.lock', '[[package]]\nname = "serde"\nversion = "1.0.190"\nsource = "x"\n\n[[package]]\nname = "time"\nversion = "0.1.45"\n').map((d) => `${d.ecosystem}:${d.name}@${d.version}`), ['crates.io:serde@1.0.190', 'crates.io:time@0.1.45']);
  assert.deepEqual(parseManifest('package-lock.json', 'not json'), []);
});

test('advisories: live lookup against OSV.dev (set CANOPY_LIVE=1 to run)', { skip: process.env.CANOPY_LIVE !== '1' }, async () => {
  const r = await lookup([{ ecosystem: 'npm', name: 'lodash', version: '4.17.15', manifest: 'package-lock.json' }]);
  assert.ok(r.ok, r.error);
  assert.ok(r.findings.length >= 1 && r.findings.every((f) => f.id && f.package === 'lodash'));
  assert.ok(r.findings.some((f) => f.fixed.length), 'at least one advisory names a fixed version');
});

// ---- environments --------------------------------------------------------

const ENVS = rules({ teams: { release: ['carol', 'asha'] }, environments: [
  { name: 'staging', branch: 'staging', promoters: ['@release'] },
  { name: 'production', branch: 'production', promoters: ['@release'], approvers: ['asha', 'ben'], approvals: 2, checks: ['test -f package.json'] }] });

test('environments: a branch moves forward only, only to what the stage before it has, only by the people allowed, and the canonical repository refuses any other route', async () => {
  await world(7917, ENVS, { users: ['asha', 'ben', 'carol', 'dave'] }, async ({ repo, port, agent, approve, as, get }) => {
    const bare = tmp('cnp-bare-');
    gitOk(bare, 'init', '-q', '--bare', '-b', 'main'); gitOk(repo, 'push', '-q', bare, 'main');
    assert.equal(cli(repo, port, ['protect', bare]).code, 0);
    gitOk(repo, 'config', 'canopy.push', bare);
    const rev = (dir, r) => git(dir, 'rev-parse', '--verify', '--quiet', r).out;
    const promote = async (env, user, commit) => (await httpJson(port, 'POST', '/api/promote', { env, commit }, { headers: as(user) })).json;

    const c = agent('carol'); await c.start(); await c.write('lib/util.js', FILES['lib/util.js'] + 'export const v = 2;\n'); c.commit();
    assert.equal((await c.land()).status, 'landed');
    const m1 = rev(repo, 'main');

    assert.match((await promote('staging', 'dave')).message, /dave may not promote to staging/);
    assert.match((await promote('nowhere', 'carol')).message, /no environment named nowhere/);
    const s = await promote('staging', 'carol');
    assert.equal(s.status, 'promoted', JSON.stringify(s));
    assert.equal(rev(repo, 'staging'), m1); assert.equal(rev(bare, 'staging'), m1, 'pushed to the canonical repository with its record');
    assert.equal((await promote('staging', 'carol')).status, 'nothing');

    const p = await promote('production', 'carol');
    assert.equal(p.status, 'needs-human'); assert.match(p.reasons[0], /needs 2 more approvals from: asha, ben/);
    assert.match((await approve(p.id, 'dave')).message, /may not approve promotions to production/);
    assert.equal((await approve(p.id, 'asha')).status, 'needs-human');
    const done = await approve(p.id, 'ben');
    assert.equal(done.status, 'promoted', JSON.stringify(done));
    assert.deepEqual(done.record.approvals.map((x) => x.user), ['asha', 'ben']);
    assert.equal(rev(bare, 'production'), m1);

    // A commit that staging does not have cannot go to production.
    const c2 = agent('carol'); await c2.start(); await c2.write('lib/util.js', FILES['lib/util.js'] + 'export const v = 3;\n'); c2.commit();
    assert.equal((await c2.land()).status, 'landed');
    const m2 = rev(repo, 'main');
    assert.match((await promote('production', 'carol', m2)).message, /only commits already on staging/);
    const envs = (await get('/api/environments')).json;
    assert.deepEqual(envs.map((e) => [e.name, e.behind]), [['staging', 1], ['production', 0]]);

    // Around Canopy: straight to the canonical repository.
    const push = (...refs) => git(repo, 'push', bare, ...refs);
    const direct = push(`${m2}:refs/heads/staging`);
    assert.notEqual(direct.code, 0); assert.match(direct.err, /no promotion record|canopy: refused/);
    const rewind = push('--force', `${rev(repo, m1 + '~1')}:refs/heads/production`);
    assert.notEqual(rewind.code, 0);
    assert.notEqual(push('--delete', 'refs/notes/canopy-env-staging').code, 0, 'promotion records cannot be deleted');
    assert.equal(rev(bare, 'staging'), m1); assert.equal(rev(bare, 'production'), m1);

    // An environment branch is not a place to land from.
    const stg = repo + '-stg';
    gitOk(repo, 'worktree', 'add', '-q', stg, 'staging');
    const l = (await httpJson(port, 'POST', '/api/land', { cwd: fs.realpathSync(stg) }, { headers: as('carol') })).json;
    fs.rmSync(stg, { recursive: true, force: true });
    assert.match(l.message, /environment branch/);
  });
});

// ---- catching up ---------------------------------------------------------

test('catch-up: a worktree that knew the old version is told what changed, by whom and why, and which lines to re-read', async () => {
  await world(7918, rules(), {}, async ({ port, agent, get }) => {
    const a = agent(null); await a.start(); await a.read('pay/charge.js'); await a.read('lib/util.js');
    const b = agent(null); await b.start(); await b.read('pay/charge.js'); await b.write('pay/charge.js', SIG2); b.commit();
    const l = await b.land('add a rounding mode to charge');
    assert.equal(l.status, 'landed', JSON.stringify(l.reasons));

    const notice = context(await a.hook('UserPromptSubmit', { prompt: 'go on' }));
    assert.match(notice, /pay\/charge\.js#charge changed its signature on main/);
    assert.match(notice, /Its purpose: «add a rounding mode to charge»/);

    const cu = (await get('/api/catchup?cwd=' + encodeURIComponent(a.wt))).json;
    assert.deepEqual(cu.items.map((i) => [i.node, i.kind, i.lines]), [['pay/charge.js#charge', 'signature', [1, 4]]]);
    assert.match(cu.text, /Re-read only the lines named/);
    assert.match(cu.text, /charge changed its signature, lines 1-4 by .*add a rounding mode to charge/);
    assert.ok(cu.text.length < 420, `digest is ${cu.text.length} characters`);
    assert.deepEqual((await get('/api/catchup?cwd=' + encodeURIComponent(b.wt))).json.items, [], 'its own landing is not news to it');
    assert.deepEqual((await get('/api/catchup?cwd=' + encodeURIComponent(a.wt) + '&path=lib/')).json.items, []);

    // A new session in the same worktree is told at once.
    const again = context(await a.hook('SessionStart', { source: 'resume' }, 's-later'));
    assert.match(again, /Changed on main since this worktree last saw them/);
    const viaCli = cli(a.wt, port, ['catchup']);
    assert.match(viaCli.out, /pay\/charge\.js#charge/);

    // Once it has merged and re-read those lines, there is nothing left to catch up on.
    gitOk(a.wt, 'merge', '-q', 'main'); await a.read('pay/charge.js');
    assert.deepEqual((await get('/api/catchup?cwd=' + encodeURIComponent(a.wt))).json.items, []);
  });
});

// ---- any harness ---------------------------------------------------------

test('any harness: with no hooks at all, one check-in records the model, picks up edits from Git, and hands over notices', async () => {
  await world(7919, rules(), {}, async ({ repo, port, agent, get }) => {
    const other = agent(null); await other.start(); await other.read('pay/charge.js');
    const wt = addWorktree(repo, 'plain');
    fs.writeFileSync(path.join(wt, 'pay/charge.js'), SIG2);
    const r = cli(wt, port, ['checkin', '--harness', 'aider', '--model', 'qwen2.5-coder:32b', '--json']);
    assert.equal(r.code, 0, r.err);
    const st = (await get('/api/state')).json;
    const s = st.sessions.find((x) => x.wt === path.basename(wt));
    assert.equal(s.agent, 'aider'); assert.equal(s.model, 'qwen2.5-coder:32b');
    assert.ok(st.writes.some((w) => w.wt === path.basename(wt) && w.node === 'pay/charge.js#charge' && w.kind === 'signature' && w.how === 'shell'));
    assert.match(context(await other.hook('UserPromptSubmit', { prompt: 'x' })), /charge.*signature/, 'the hooked agent hears about the hook-less one');
    // And the other way: the hook-less agent hears on its next check-in.
    await other.write('lib/util.js', FILES['lib/util.js'].replace('(x, lo, hi)', '(x, lo, hi, step)'));
    fs.writeFileSync(path.join(wt, 'shop/cart.js'), FILES['shop/cart.js'] + "import { clamp } from '../lib/util.js';\nexport const c = () => clamp(1, 0, 2);\n");
    const r2 = cli(wt, port, ['checkin', '--harness', 'aider', '--json']);
    assert.match(JSON.stringify(r2.json.notices), /lib\/util\.js#clamp/);
  });
});

test('any harness: Codex edits arrive as apply_patch through `canopy hook`, and the same policy applies', async () => {
  const doc = rules({}, [{ path: '' }, { path: 'pay/', writers: ['asha'] }]);
  await world(7920, doc, { users: ['asha', 'carol'] }, async ({ port, tokens, agent, get }) => {
    const c = agent('carol', { harness: 'codex' });
    const send = (ev) => cli(c.wt, port, ['hook', '--harness', 'codex'], { env: { CANOPY_TOKEN: tokens.carol }, input: JSON.stringify({ session_id: 's-codex', cwd: c.wt, ...ev }) });
    assert.equal(send({ hook_event_name: 'SessionStart', model: 'gpt-5.5-codex' }).code, 0);
    const patch = '*** Begin Patch\n*** Update File: pay/charge.js\n@@\n-  return cents;\n+  return cents | 0;\n*** Add File: lib/new.js\n+export const n = 1;\n*** End Patch';
    const pre = send({ hook_event_name: 'PreToolUse', tool_name: 'apply_patch', tool_input: { command: patch } });
    assert.match(pre.out, /"permissionDecision":"deny"/); assert.match(pre.out, /carol may not change pay\//);
    fs.writeFileSync(path.join(c.wt, 'lib/new.js'), 'export const n = 1;\n');
    send({ hook_event_name: 'PostToolUse', tool_name: 'apply_patch', tool_input: { command: '*** Begin Patch\n*** Add File: lib/new.js\n+export const n = 1;\n*** End Patch' } });
    const seen = await waitFor(async () => (await get('/api/state')).json.writes.find((w) => w.path === 'lib/new.js'));
    assert.ok(seen.value, 'the edit was taken from Git');
    const s = (await get('/api/state')).json.sessions.find((x) => x.wt === path.basename(c.wt));
    assert.deepEqual([s.agent, s.model, s.user], ['codex', 'gpt-5.5-codex', 'carol']);
  });
});

// ---- notifications -------------------------------------------------------

test('notifications: approvals and security events reach the right channel in its own format, once, without pings, and without leaking the address', async () => {
  const got = [];
  const srv = http.createServer((req, res) => { let b = ''; req.on('data', (c) => { b += c; }); req.on('end', () => { got.push({ url: req.url, body: JSON.parse(b) }); res.end('ok'); }); });
  await new Promise((r) => srv.listen(7951, '127.0.0.1', r));
  const doc = rules({ notify: [{ channel: 'eng', on: ['approval'] }, { channel: 'ops', on: ['security'], paths: ['lib/'] }, { channel: 'all', on: ['approval', 'blocked', 'landed', 'security'] }, { channel: 'dead', on: ['landed'] }, { channel: 'unset', on: ['landed'] }] },
    [{ path: '' }, { path: 'pay/', owners: ['asha'] }, { path: 'lib/', writers: ['asha'] }]);
  try {
    await world(7923, doc, { users: ['asha:admin', 'carol'] }, async ({ repo, d, port, agent, approve, get }) => {
      for (const [name, url, kind] of [['eng', 'http://127.0.0.1:7951/slack/T0PSECRET', 'slack'], ['ops', 'http://127.0.0.1:7951/discord/T0PSECRET', 'discord'], ['all', 'http://127.0.0.1:7951/json/T0PSECRET', ''], ['dead', 'http://127.0.0.1:1/x', '']]) {
        assert.equal(cli(repo, port, ['notify', 'add', name, url, ...(kind ? ['--kind', kind] : [])]).code, 0);
      }
      assert.notEqual(cli(repo, port, ['notify', 'add', 'plain', 'http://example.com/hook']).code, 0, 'a webhook must be https');
      const of = (part) => got.filter((g) => g.url.startsWith('/' + part)).map((g) => g.body);

      const c = agent('carol'); await c.start(); await c.write('pay/charge.js', BODY2); c.commit();
      const l = await c.land('round cents @everyone <!channel>');
      assert.equal(l.status, 'needs-human');
      await waitFor(() => of('slack').length && of('json').length);
      const slack = of('slack')[0].text;
      assert.match(slack, /^\*Approval needed: w\d+\*/);
      assert.match(slack, new RegExp(`To approve: canopy approve ${l.id}`));
      assert.match(slack, /Waiting on: pay\/ \(asha\)/);
      assert.ok(slack.includes('@​everyone') && !slack.includes('<!'), 'text from a branch cannot ping a channel');
      const j = of('json')[0];
      assert.deepEqual([j.source, j.kinds, j.id, j.by, j.waiting_on[0].owners], ['canopy', ['approval'], l.id, 'carol', ['asha']]);
      await c.land('round cents @everyone <!channel>');
      await new Promise((r) => setTimeout(r, 300));
      assert.equal(of('slack').length, 1, 'the same held landing is announced once');

      assert.ok((await c.write('lib/util.js', '// x\n')).denied);
      await waitFor(() => of('discord').length);
      const disc = of('discord')[0];
      assert.match(disc.content, /^\*\*Edit refused by policy on w\d+\*\*\ncarol may not change lib\//);
      assert.deepEqual(disc.allowed_mentions, { parse: [] });
      assert.equal(of('slack').length, 1, 'a security event does not go to a channel that asked only for approvals');

      assert.equal((await approve(l.id, 'asha')).status, 'landed', 'a dead webhook does not hold a landing');
      await waitFor(() => of('json').some((b) => b.kinds.includes('landed')));
      const landed = of('json').find((b) => b.kinds.includes('landed'));
      assert.match(landed.lines.join('\n'), /Approved by: asha/);
      const log = await waitFor(async () => (await get('/api/audit?limit=200', 'asha')).json.find((e) => e.action === 'notify.failed'));
      assert.equal(log.value.target, 'dead');

      const ch = (await get('/api/channels')).json;
      assert.deepEqual(ch.channels.map((x) => [x.name, x.kind, x.host]), [['all', 'json', '127.0.0.1'], ['dead', 'json', '127.0.0.1'], ['eng', 'slack', '127.0.0.1'], ['ops', 'discord', '127.0.0.1']]);
      for (const text of [JSON.stringify(ch), d.log, JSON.stringify((await get('/api/audit?limit=200', 'asha')).json), JSON.stringify((await get('/api/state')).json), cli(repo, port, ['notify', 'list']).out]) assert.ok(!text.includes('T0PSECRET'), 'the webhook address is not shown anywhere');
      assert.ok(!JSON.stringify(got).includes('amount * 100'), 'no code is sent');
    });
  } finally { srv.close(); }
  assert.match(loadRules(mkRepo({ 'a.js': '1\n' }, rules({ notify: [{ channel: 'eng', on: ['everything'] }] })), 'HEAD').error, /notify\[0\]\.on must list some of/);
  assert.match(loadRules(mkRepo({ 'a.js': '1\n' }, rules({ notify: [{ channel: 'https://hooks.slack.com/x' }] })), 'HEAD').error, /never in this file/);
});

// ---- rules and compatibility --------------------------------------------

test('rules: a mistake in the new keys refuses the whole file with the reason', () => {
  const bad = (doc, re) => { const repo = mkRepo({ 'a.js': '1\n' }, doc); assert.match(loadRules(repo, 'HEAD').error || '', re); };
  bad(rules({}, [{ path: 'pay/', owners: ['@nobody'] }]), /team "@nobody", which is not defined/);
  bad(rules({}, [{ path: 'pay/', approvals: 2 }]), /names no owners/);
  bad(rules({}, [{ path: 'pay/', owners: ['Asha'] }]), /not a valid user name/);
  bad(rules({}, [{ path: 'pay/', models: [] }]), /models must be a non-empty list/);
  bad(rules({ manager: { cmd: 'x', when: 'sometimes' } }), /manager\.when/);
  bad(rules({ advisories: { source: 'npm-audit' } }), /source must be "osv"/);
  bad(rules({ environments: [{ name: 'prod', branch: 'prod', approvals: 1 }] }), /names no approvers/);
  bad(rules({ environments: [{ name: 'a', branch: 'x' }, { name: 'b', branch: 'x' }] }), /repeats a name or a branch/);
  bad(rules({ environment: [] }), /unknown key "environment"/);
  const ok = loadRules(mkRepo({ 'a.js': '1\n' }, ENVS), 'HEAD');
  assert.equal(ok.error, null);
  assert.deepEqual(ok.environments.map((e) => [e.name, e.from, e.promoters]), [['staging', null, ['carol', 'asha']], ['production', 'staging', ['carol', 'asha']]]);
});

test('compatibility: a 0.1 database gains the new columns and tables on first open', async () => {
  const home = tmp('cnp-old-');
  const { DatabaseSync } = await import('node:sqlite');
  const db = new DatabaseSync(path.join(home, 'canopy.db'));
  db.exec("create table sessions(id text primary key, short text, agent text, model text, worktree text, branch text, task text, started int, seen int, ended int); insert into sessions(id, short) values('old','o1');");
  db.close();
  const { openStore } = await import('../src/store.mjs');
  const s = openStore(home);
  s.run("update sessions set user='asha', ip='::1' where id='old'");
  assert.deepEqual({ ...s.get('select short, user, ip from sessions') }, { short: 'o1', user: 'asha', ip: '::1' });
  s.audit({ user: 'asha', ip: '::1' }, 'test', 'x', {});
  assert.equal(s.get('select count(*) n from audit').n, 1);
  s.db.close();
});

test('compatibility: with no users and none of the new keys, a landing behaves as in 0.1', async () => {
  await world(7921, rules({}, [{ path: '' }, { path: 'pay/', protected: true }]), {}, async ({ d, port, agent, get }) => {
    assert.deepEqual((await get('/api/whoami')).json, { user: '', role: '', users: false });
    const a = agent(null); await a.start(); await a.write('pay/charge.js', BODY2); a.commit();
    const l = await a.land();
    assert.equal(l.status, 'needs-human'); assert.deepEqual(l.reasons, ['protected files changed: pay/charge.js']);
    assert.equal((await httpJson(port, 'POST', '/api/approve', { id: l.id, token: 'wrong', by: 'x' })).json.message, 'approval needs the human token');
    const ok = (await httpJson(port, 'POST', '/api/approve', { id: l.id, token: d.humanToken(), by: 'noel' })).json;
    assert.equal(ok.status, 'landed'); assert.equal(ok.record.approval.by, 'noel'); assert.equal(ok.record.by, undefined);
  });
});

test('cli: users are managed on the Canopy host, and the token is shown once', async () => {
  const repo = mkRepo(FILES, rules());
  const add = cli(repo, 7922, ['user', 'add', 'asha', '--admin']);
  assert.match(add.out, /cnp_[A-Za-z0-9_-]{20,}/); assert.match(add.out, /shown once/);
  assert.notEqual(cli(repo, 7922, ['user', 'add', 'asha']).code, 0);
  assert.notEqual(cli(repo, 7922, ['user', 'add', 'Not Valid']).code, 0);
  const list = cli(repo, 7922, ['user', 'list']);
  assert.match(list.out, /asha\s+admin/); assert.ok(!/cnp_/.test(list.out));
});

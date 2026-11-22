// Independent review of the 0.2 access and approval logic. Each test is named
// after one defect and asserts the CORRECT behaviour, so it fails until the
// defect is fixed. Ports 7960-7989.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { mkRepo, addWorktree, startDaemon, httpJson, git, gitOk, tmp, cli, waitFor } from './helpers.mjs';
import { loadRules } from '../src/rules.mjs';

const FILES = {
  'package.json': '{"type":"module"}\n',
  'pay/charge.js': "export function charge(amount, currency) {\n  const cents = amount * 100;\n  return cents;\n}\n",
  'shop/cart.js': "import { charge } from '../pay/charge.js';\nexport function total() {\n  return charge(5, 'usd');\n}\n",
  'lib/util.js': "export function clamp(x, lo, hi) {\n  return Math.min(hi, Math.max(lo, x));\n}\n",
};
const rules = (extra = {}, list = [{ path: '' }]) => ({ version: 1, rules: list, ...extra });
const denied = (r) => r.json?.hookSpecificOutput?.permissionDecision === 'deny';
const context = (r) => r.json?.hookSpecificOutput?.additionalContext || '';
let seq = 0;

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
  const state = async () => (await httpJson(port, 'GET', '/api/state')).json;
  const agent = (user, { model = 'claude-fable-5-2', harness } = {}) => {
    const name = `r${++seq}`, wt = addWorktree(repo, name), sid = `s-${name}`, headers = as(user);
    const hook = (event, extra = {}, sess = sid, hdrs = headers) => httpJson(port, 'POST', '/hook', { session_id: sess, cwd: wt, hook_event_name: event, ...(harness ? { harness } : {}), ...extra }, { headers: hdrs });
    const seen = (p) => waitFor(async () => (await state()).writes.some((w) => w.wt === path.basename(wt) && w.path === p));
    const a = {
      wt, name, sid, hook, headers, seen,
      start: (m = model, sess = sid) => hook('SessionStart', { source: 'startup', ...(m ? { model: m } : {}) }, sess),
      pre: (p, sess = sid, hdrs = headers) => hook('PreToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(wt, p) } }, sess, hdrs),
      async write(p, text, sess = sid) {
        const pre = await a.pre(p, sess);
        if (denied(pre)) return { denied: true };
        fs.mkdirSync(path.dirname(path.join(wt, p)), { recursive: true });
        fs.writeFileSync(path.join(wt, p), text);
        await hook('PostToolUse', { tool_name: 'Write', tool_input: { file_path: path.join(wt, p) } }, sess);
        return { denied: false };
      },
      // A shell edit: no pre-edit check, picked up from Git afterwards.
      async shell(p, text, sess = sid) {
        fs.writeFileSync(path.join(wt, p), text);
        await hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'sed -i x ' + p } }, sess);
        await seen(p);
      },
      commit(msg = 'work') { gitOk(wt, 'add', '-A'); gitOk(wt, 'commit', '-q', '-m', msg); return gitOk(wt, 'rev-parse', 'HEAD'); },
      land: async (intent, hdrs = headers) => (await httpJson(port, 'POST', '/api/land', { cwd: wt, intent }, { headers: hdrs })).json,
    };
    return a;
  };
  const release = (a) => httpJson(port, 'POST', '/api/release', { cwd: a.wt }, { headers: a.headers });
  const approve = async (id, user, body = {}) => (await httpJson(port, 'POST', '/api/approve', { id, ...body }, { headers: as(user) })).json;
  const promote = async (envName, user, commit) => (await httpJson(port, 'POST', '/api/promote', { env: envName, commit }, { headers: as(user) })).json;
  const disable = (name) => assert.equal(cli(repo, port, ['user', 'disable', name]).code, 0);
  try { return await fn({ repo, d, port, tokens, as, agent, approve, promote, release, disable, state }); } finally { d.kill(); }
}
const BODY2 = "export function charge(amount, currency) {\n  const cents = Math.round(amount * 100);\n  return cents;\n}\n";
const BODY3 = BODY2.replace('Math.round', 'Math.floor');
const OWNED = (n = 1) => rules({ teams: { payments: ['asha', 'ben'] } }, [{ path: '' }, { path: 'pay/', owners: ['@payments'], approvals: n }]);
const MODELS = rules({ model_tiers: { strong: ['claude-fable-*', 'gpt-5*'] } }, [{ path: '' }, { path: 'pay/', models: ['strong'] }]);
const WRITERS = rules({}, [{ path: '' }, { path: 'pay/', writers: ['asha'] }]);

// ---- 1. ownership -----------------------------------------------------------

test('ownership: an approval given by an owner who is then disabled no longer counts', async () => {
  await world(7960, OWNED(2), { users: ['asha', 'ben', 'carol'] }, async ({ agent, approve, disable }) => {
    const c = agent('carol'); await c.start(); await c.write('pay/charge.js', BODY2); c.commit();
    const l = await c.land();
    assert.equal(l.status, 'needs-human');
    assert.equal((await approve(l.id, 'asha')).status, 'needs-human', 'one of two');
    disable('asha');   // e.g. her token leaked: the operator revokes her
    const r = await approve(l.id, 'ben');
    assert.notEqual(r.status, 'landed', 'two approvals are required and only one enabled owner has approved');
  });
});

test('ownership: a landing asked for by an owner who is then disabled does not land in their name, with their say-so counted', async () => {
  await world(7961, OWNED(2), { users: ['asha', 'ben'] }, async ({ agent, approve, disable }) => {
    const a = agent('asha'); await a.start(); await a.write('pay/charge.js', BODY2); a.commit();
    const l = await a.land();
    assert.equal(l.status, 'needs-human');
    assert.deepEqual(l.record.waiting_on[0].have, ['asha']);
    disable('asha');
    const r = await approve(l.id, 'ben');
    assert.notEqual(r.status, 'landed', 'the lander is disabled: neither her request nor her implied approval stands');
  });
});

test('ownership: two rules for the same path each keep their owners (combining rules only tightens)', async () => {
  const doc = rules({}, [{ path: '' }, { path: 'pay/', owners: ['asha'] }, { path: 'pay/', owners: ['ben'] }]);
  await world(7962, doc, { users: ['asha', 'ben', 'carol'] }, async ({ agent, approve }) => {
    const c = agent('carol'); await c.start(); await c.write('pay/charge.js', BODY2); c.commit();
    const l = await c.land();
    if (l.status === 'blocked') return;   // refusing such a rules file outright is also correct
    assert.equal(l.status, 'needs-human');
    const r = await approve(l.id, 'asha');
    assert.notEqual(r.status, 'landed', 'the second rule asks for ben, and ben has not approved');
  });
});

// ---- 2. writers -------------------------------------------------------------

test('access: a hook from one user that names another user\'s session is judged as the sender, not as the session\'s owner', async () => {
  await world(7963, WRITERS, { users: ['asha', 'carol'] }, async ({ agent, as }) => {
    const a = agent('asha'); await a.start();
    // carol is not a writer of pay/. She sends her own token with asha's session id.
    const pre = await a.pre('pay/charge.js', a.sid, as('carol'));
    assert.ok(denied(pre) || pre.status >= 400, 'carol may not change pay/, whatever session id her request carries');
  });
});

test('access: a Codex patch that moves a file into a writers section is refused at edit time', async () => {
  await world(7964, WRITERS, { users: ['asha', 'carol'] }, async ({ agent }) => {
    const c = agent('carol', { harness: 'codex' }); await c.start('gpt-5.5-codex');
    const patch = '*** Begin Patch\n*** Update File: lib/util.js\n*** Move to: pay/util.js\n@@\n-  return Math.min(hi, Math.max(lo, x));\n+  return x;\n*** End Patch';
    const pre = await c.hook('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: patch } });
    assert.ok(denied(pre), 'the patch writes pay/util.js, which only asha may change');
  });
});

test('access: a Codex patch naming more than 50 files has every file checked at edit time', async () => {
  await world(7965, WRITERS, { users: ['asha', 'carol'] }, async ({ agent }) => {
    const c = agent('carol', { harness: 'codex' }); await c.start('gpt-5.5-codex');
    const filler = Array.from({ length: 50 }, (_, i) => `*** Add File: lib/gen${i}.js\n+export const g${i} = ${i};`).join('\n');
    const patch = `*** Begin Patch\n${filler}\n*** Update File: pay/charge.js\n@@\n-  return cents;\n+  return cents | 0;\n*** End Patch`;
    const pre = await c.hook('PreToolUse', { tool_name: 'apply_patch', tool_input: { command: patch } });
    assert.ok(denied(pre), 'pay/charge.js is the 51st file in the patch and only asha may change it');
  });
});

// ---- 3. model policy --------------------------------------------------------

test('model policy: a model switch mid-session does not relabel what the earlier model wrote', async () => {
  await world(7966, MODELS, { users: ['asha:admin', 'carol'] }, async ({ agent }) => {
    const m = agent('carol'); await m.start('llama-3-8b');
    await m.shell('pay/charge.js', BODY2);   // the weak model edits through the shell
    await m.hook('PostModelSwitch', { from_model: 'llama-3-8b', to_model: 'claude-fable-5-2' });
    m.commit();
    const l = await m.land();
    assert.equal(l.status, 'needs-human', 'llama-3-8b wrote pay/charge.js; the record says: ' + JSON.stringify(l.record && l.record.authors));
  });
});

test('model policy: releasing a worktree does not let a later session take the credit for an earlier model\'s work', async () => {
  await world(7967, MODELS, { users: ['asha:admin', 'carol'] }, async ({ agent, release }) => {
    const m = agent('carol');
    await m.start('llama-3-8b', 's-weak');
    await m.shell('pay/charge.js', BODY2, 's-weak');
    await release(m);   // any user may do this; it wipes who wrote what
    await m.start('claude-fable-5-2', 's-strong');
    await m.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git status' } }, 's-strong');
    await m.seen('pay/charge.js');
    m.commit();
    const l = await m.land();
    assert.equal(l.status, 'needs-human', 'llama-3-8b wrote pay/charge.js; the record says: ' + JSON.stringify(l.record && l.record.authors));
  });
});

test('model policy: a session that merges another model\'s branch does not become the author of its files', async () => {
  await world(7968, MODELS, { users: ['asha:admin', 'carol'] }, async ({ agent }) => {
    const w = agent('carol'); await w.start('llama-3-8b');
    await w.shell('pay/charge.js', BODY2); w.commit('weak work');
    const s = agent('carol'); await s.start('claude-fable-5-2');
    gitOk(s.wt, 'merge', '-q', w.name);
    await s.hook('PostToolUse', { tool_name: 'Bash', tool_input: { command: 'git merge ' + w.name } });
    await s.seen('pay/charge.js');
    const l = await s.land();
    assert.equal(l.status, 'needs-human', 'llama-3-8b wrote pay/charge.js; the record says: ' + JSON.stringify(l.record && l.record.authors));
  });
});

test('model policy: a change made outside any session to a file an allowed model touched earlier still needs a person', async () => {
  await world(7969, MODELS, { users: ['asha:admin', 'carol'] }, async ({ agent }) => {
    const s = agent('carol'); await s.start('claude-fable-5-2');
    assert.equal((await s.write('pay/charge.js', BODY2)).denied, false);
    fs.writeFileSync(path.join(s.wt, 'pay/charge.js'), BODY3);   // nobody Canopy knows wrote this version
    s.commit();
    const l = await s.land();
    assert.equal(l.status, 'needs-human', 'the committed content was not written by any recorded session');
  });
});

// ---- 5. environments --------------------------------------------------------

const ENVS = rules({ teams: { release: ['carol', 'asha'] }, environments: [
  { name: 'staging', branch: 'staging', promoters: ['@release'] },
  { name: 'production', branch: 'production', promoters: ['@release'], approvers: ['asha', 'ben'], approvals: 2 }] });

test('environments: a disabled approver\'s earlier approval does not count toward a promotion', async () => {
  await world(7970, ENVS, { users: ['asha', 'ben', 'carol'] }, async ({ promote, approve, disable }) => {
    assert.equal((await promote('staging', 'carol')).status, 'promoted');
    const p = await promote('production', 'carol');
    assert.equal(p.status, 'needs-human');
    assert.equal((await approve(p.id, 'asha')).status, 'needs-human', 'one of two');
    disable('asha');
    const r = await approve(p.id, 'ben');
    assert.notEqual(r.status, 'promoted', 'two approvals are required and only one enabled approver has approved');
  });
});

test('environments: a commit that was never a landed state of main cannot be promoted', async () => {
  await world(7971, ENVS, { users: ['asha', 'ben', 'carol'] }, async ({ agent, promote }) => {
    const c = agent('carol'); await c.start();
    await c.write('lib/util.js', FILES['lib/util.js'] + 'export const DEBUG_BACKDOOR = true;\n');
    const wip = c.commit('wip');
    await c.write('lib/util.js', FILES['lib/util.js'] + 'export const v = 2;\n'); c.commit('final');
    const l = await c.land();
    assert.equal(l.status, 'landed', JSON.stringify(l.reasons));
    // `wip` is reachable from main only through the landing's second parent. Its
    // tree was never checked, never approved and never the tip of main.
    const r = await promote('staging', 'carol', wip);
    assert.notEqual(r.status, 'promoted', 'staging now runs a tree that never landed');
  });
});

test('environments: the canonical repository refuses environment pushes when its canopy.envs setting is unreadable, rather than guarding nothing', async () => {
  await world(7973, ENVS, { users: ['asha', 'ben', 'carol'] }, async ({ repo, port }) => {
    const bare = tmp('cnp-bare-');
    gitOk(bare, 'init', '-q', '--bare', '-b', 'main'); gitOk(repo, 'push', '-q', bare, 'main');
    assert.equal(cli(repo, port, ['protect', bare]).code, 0);
    const tip = gitOk(repo, 'rev-parse', 'main');
    assert.notEqual(git(repo, 'push', bare, `${tip}:refs/heads/staging`).code, 0, 'guarded while the setting is intact');
    gitOk(bare, 'config', 'canopy.envs', '{"staging":"staging",');   // a damaged value
    const direct = git(repo, 'push', bare, `${tip}:refs/heads/production`);
    assert.notEqual(direct.code, 0, 'a push with no promotion record was accepted');
  });
});

// ---- 1/7. approvals over time, and rules in a broken state ------------------

test('approval: an approval that could not be used is not kept and applied later to reasons its giver never saw', async () => {
  await world(7974, rules(), {}, async ({ d, port, agent }) => {
    const c = agent(null); await c.start(); await c.write('package.json', '{"type":"module","x":1}\n'); c.commit();
    const l = await c.land();
    assert.equal(l.status, 'needs-human'); assert.deepEqual(l.reasons, ['protected files changed: package.json']);
    const util = path.join(c.wt, 'lib/util.js');
    fs.writeFileSync(util, FILES['lib/util.js'] + '// not committed\n');
    const ap = (await httpJson(port, 'POST', '/api/approve', { id: l.id, token: d.humanToken(), by: 'noel' })).json;
    assert.equal(ap.status, 'error'); assert.match(ap.message, /commit your work first/);
    gitOk(c.wt, 'checkout', '--', 'lib/util.js');
    // After the person has gone, the session takes in outside content: a new reason to ask.
    await c.hook('PostToolUse', { tool_name: 'WebFetch', tool_input: { url: 'https://example.com/page' } });
    const again = await c.land();   // the agent, with no person present
    assert.equal(again.status, 'needs-human', 'landed with: ' + JSON.stringify(again.record && again.record.approval));
  });
});

test('rules: when the rules on main are broken, the repair cannot choose who approves it', async () => {
  const good = rules({}, [{ path: '' }, { path: 'pay/', owners: ['asha'] }]);
  await world(7975, good, { users: ['asha', 'root:admin', 'mal', 'zed'] }, async ({ repo, port, agent, approve }) => {
    // main's rules become invalid by a route other than a landing (a direct commit, or a key a newer Canopy wrote).
    fs.writeFileSync(path.join(repo, '.canopy/rules.json'), JSON.stringify({ ...good, some_future_key: true }));
    gitOk(repo, 'commit', '-q', '-am', 'break the rules');
    await httpJson(port, 'POST', '/api/refresh', {});
    const m = agent('mal'); await m.start();
    fs.writeFileSync(path.join(m.wt, '.canopy/rules.json'), JSON.stringify(rules({}, [{ path: '', owners: ['zed'] }])));
    await m.shell('pay/charge.js', BODY2); m.commit();
    const l = await m.land('repair');
    assert.equal(l.status, 'needs-human');
    const r = await approve(l.id, 'zed');   // zed has a say only because mal's own branch says so
    assert.notEqual(r.status, 'landed', 'neither an administrator nor asha (owner of pay/ in the last valid rules) was asked');
  });
});

// ---- 7. compatibility -------------------------------------------------------

test('compatibility: with no users and no new keys, a worktree that released its work gets no landing notice, as in 0.1', async () => {
  await world(7976, rules(), {}, async ({ agent, release }) => {
    const a = agent(null); await a.start();
    await a.hook('PostToolUse', { tool_name: 'Read', tool_input: { file_path: path.join(a.wt, 'lib/util.js') } });
    await release(a);   // 0.1: drops everything in flight, so nothing that lands later is addressed to it
    const b = agent(null); await b.start();
    await b.write('lib/util.js', FILES['lib/util.js'].replace('Math.min(hi, Math.max(lo, x))', 'Math.max(lo, Math.min(hi, x))')); b.commit();
    assert.equal((await b.land('swap min and max')).status, 'landed');
    const heard = context(await a.hook('UserPromptSubmit', { prompt: 'x' }));
    assert.equal(heard, '', 'a notice arrived that 0.1 would not have sent');
  });
});

// ---- 8. plain bugs ----------------------------------------------------------

test('rules: a team reference that is not defined is refused even when its name is a built-in property name', () => {
  const repo = mkRepo(FILES, rules({}, [{ path: '' }, { path: 'pay/', owners: ['@constructor'] }]));
  const rs = loadRules(repo, 'main');
  assert.ok(rs.error, 'owners resolved to: ' + JSON.stringify((rs.rules[1] || {}).owners && rs.rules[1].owners.map(String)));
});

test('cli: `canopy hook` never gets in the agent\'s way, even when the event is not an object', () => {
  const repo = mkRepo(FILES, rules());
  const r = cli(repo, 7989, ['hook', '--harness', 'codex'], { input: 'null' });
  assert.equal(r.code, 0, r.err);
});

// SECURITY pillar, part 1: the pre-receive hook on a protected canonical repo.
// Port 7811.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './helpers.mjs';

const PORT = 7811;

// canonical bare repo (protected) + a working repo cloned from it, served by canopyd.
async function canonical(home) {
  const seed = H.mkRepo(H.BASE_FILES, H.BASE_RULES);
  const bare = path.join(H.tmp('canon-'), 'canon.git');
  H.gitOk(seed, 'clone', '-q', '--bare', seed, bare);
  const work = path.join(H.tmp('work-'), 'w');
  H.gitOk(path.dirname(work), 'clone', '-q', bare, work);
  const env = { CANOPY_HOME: home };
  const p = H.cli(work, PORT, ['protect', bare], { env });
  assert.equal(p.code, 0, p.out + p.err);
  const d = await H.startDaemon(work, PORT, { home });
  return { bare, work, d, env };
}
// land one real change from an agent in `work`, returns the landing commit
async function landOne(c, name, file, from, to) {
  const A = new H.Agent(c.d, c.work, name);
  await A.start(); await A.read(file); await A.edit(file, from, to); A.commit(name);
  const r = A.land(['--task', name]);
  assert.equal(r.json?.status, 'landed', r.out + r.err);
  return { A, r, commit: r.json.commit };
}
const push = (cwd, ...refs) => H.git(cwd, 'push', 'origin', ...refs);

test('S1 direct push of an ordinary commit to protected main is refused', async () => {
  const home = H.tmp('home-'); const c = await canonical(home);
  try {
    fs.writeFileSync(path.join(c.work, 'x.txt'), 'x'); H.gitOk(c.work, 'add', '-A'); H.gitOk(c.work, 'commit', '-q', '-m', 'sneak');
    const before = H.gitOk(c.bare, 'rev-parse', 'main');
    const r = push(c.work, 'main');
    assert.notEqual(r.code, 0); assert.match(r.err, /refused|declined/);
    assert.equal(H.gitOk(c.bare, 'rev-parse', 'main'), before, 'canonical main unchanged');
    H.recordMetric('S1_message', (r.err.match(/canopy: refused[^\n]*/) || [''])[0]);
  } finally { c.d.kill(); }
});

test('S2 control: a real landing pushed with its record is accepted; pushing main without the record is refused', async () => {
  const home = H.tmp('home-'); const c = await canonical(home);
  try {
    const { commit } = await landOne(c, 'feat', 'src/util.js', 'Math.min(hi', 'Math.min(hi + 0');
    const bare0 = H.gitOk(c.bare, 'rev-parse', 'main');
    const noRec = push(c.work, 'main');
    H.recordMetric('S2_push_main_without_notes', { code: noRec.code, msg: noRec.err.split('\n').find((l) => /canopy/.test(l)) });
    const ok = push(c.work, 'main', 'refs/notes/canopy');
    assert.equal(ok.code, 0, ok.err);
    assert.equal(H.gitOk(c.bare, 'rev-parse', 'main'), commit);
    assert.notEqual(bare0, commit);
    assert.equal(noRec.code === 0, false, 'main without record should not be accepted');
  } finally { c.d.kill(); }
});

test('S3 replaying a valid landing record onto a different commit is refused', async () => {
  const home = H.tmp('home-'); const c = await canonical(home);
  try {
    const { commit } = await landOne(c, 'feat', 'src/util.js', 'Math.min(hi', 'Math.min(hi + 0');
    assert.equal(push(c.work, 'main', 'refs/notes/canopy').code, 0);
    // attacker clone: new commit X on top of canonical main, note copied from the valid landing
    const atk = path.join(H.tmp('atk-'), 'a');
    H.gitOk(path.dirname(atk), 'clone', '-q', c.bare, atk);
    H.gitOk(atk, 'fetch', '-q', 'origin', 'refs/notes/canopy:refs/notes/canopy');
    const blob = H.gitOk(atk, 'notes', '--ref=canopy', 'list', commit);
    fs.writeFileSync(path.join(atk, 'evil.js'), 'export const evil = 1;\n');
    H.gitOk(atk, 'add', '-A'); H.gitOk(atk, 'commit', '-q', '-m', 'evil');
    const X = H.gitOk(atk, 'rev-parse', 'HEAD');
    H.gitOk(atk, 'notes', '--ref=canopy', 'add', '-C', blob, X);
    const before = H.gitOk(c.bare, 'rev-parse', 'main');
    const r = push(atk, 'main', 'refs/notes/canopy');
    assert.notEqual(r.code, 0, 'replayed record must not be accepted: ' + r.err);
    assert.equal(H.gitOk(c.bare, 'rev-parse', 'main'), before);
    H.recordMetric('S3_message', (r.err.match(/canopy: refused[^\n]*/) || [''])[0]);
    // second replay shape: the same merge commit message trailer re-used on a squash-like commit
    H.gitOk(atk, 'reset', '-q', '--hard', before);
    fs.writeFileSync(path.join(atk, 'evil2.js'), 'export const evil2 = 1;\n');
    H.gitOk(atk, 'add', '-A');
    H.gitOk(atk, 'commit', '-q', '-m', `Land feat: x\n\nCanopy-Landing: ${JSON.parse(H.gitOk(atk, 'notes', '--ref=canopy', 'show', commit)).record.id}`);
    const Y = H.gitOk(atk, 'rev-parse', 'HEAD');
    H.gitOk(atk, 'notes', '--ref=canopy', 'add', '-f', '-C', blob, Y);
    const r2 = push(atk, 'main', 'refs/notes/canopy');
    assert.notEqual(r2.code, 0, 'replay with copied trailer refused: ' + r2.err);
  } finally { c.d.kill(); }
});

test('S4 a record signed by a different key is refused', async () => {
  const home = H.tmp('home-'); const c = await canonical(home);
  const home2 = H.tmp('home2-');
  let d2;
  try {
    // second, untrusted canopyd with its own key, working on a clone of the same canonical repo
    const work2 = path.join(H.tmp('work2-'), 'w'); H.gitOk(path.dirname(work2), 'clone', '-q', c.bare, work2);
    c.d.kill();
    d2 = await H.startDaemon(work2, PORT, { home: home2 });
    const A = new H.Agent(d2, work2, 'rogue'); await A.start();
    await A.edit('src/util.js', 'Math.min(hi', 'Math.min(hi + 0'); A.commit('rogue');
    const r = A.land(['--task', 'rogue']);
    assert.equal(r.json?.status, 'landed', r.out + r.err);
    const before = H.gitOk(c.bare, 'rev-parse', 'main');
    const p = push(work2, 'main', 'refs/notes/canopy');
    assert.notEqual(p.code, 0, 'record signed by another key must be refused: ' + p.err);
    assert.equal(H.gitOk(c.bare, 'rev-parse', 'main'), before);
    H.recordMetric('S4_message', (p.err.match(/canopy: refused[^\n]*/) || [''])[0]);
  } finally { c.d.kill(); d2?.kill(); }
});

test('S5 forged unsigned record (made-up signature) is refused', async () => {
  const home = H.tmp('home-'); const c = await canonical(home);
  try {
    const { commit } = await landOne(c, 'feat', 'src/util.js', 'Math.min(hi', 'Math.min(hi + 0');
    const atk = path.join(H.tmp('atk-'), 'a');
    H.gitOk(path.dirname(atk), 'clone', '-q', c.bare, atk);
    const base = H.gitOk(atk, 'rev-parse', 'main');
    fs.writeFileSync(path.join(atk, 'evil.js'), 'x\n'); H.gitOk(atk, 'add', '-A'); H.gitOk(atk, 'commit', '-q', '-m', 'Land x\n\nCanopy-Landing: deadbeef');
    const X = H.gitOk(atk, 'rev-parse', 'HEAD');
    const keyId = JSON.parse(H.gitOk(c.work, 'notes', '--ref=canopy', 'show', commit)).key_id;   // even claiming the trusted key id
    const rec = { canopy: 1, key_id: keyId, sig: Buffer.alloc(64, 7).toString('base64'), record: { v: 1, id: 'deadbeef', commit: X, base, verdict: 'land' } };
    fs.writeFileSync(path.join(atk, '.rec'), JSON.stringify(rec));
    H.gitOk(atk, 'notes', '--ref=canopy', 'add', '-F', path.join(atk, '.rec'), X);
    const p = push(atk, 'main', 'refs/notes/canopy');
    assert.notEqual(p.code, 0, p.err);
  } finally { c.d.kill(); }
});

test('S6 deleting or rewriting refs/notes/canopy is refused', async () => {
  const home = H.tmp('home-'); const c = await canonical(home);
  try {
    await landOne(c, 'feat', 'src/util.js', 'Math.min(hi', 'Math.min(hi + 0');
    assert.equal(push(c.work, 'main', 'refs/notes/canopy').code, 0);
    const notesBefore = H.gitOk(c.bare, 'rev-parse', 'refs/notes/canopy');
    const del = push(c.work, '--delete', 'refs/notes/canopy');
    assert.notEqual(del.code, 0, del.err);
    // rewrite: replace notes history with an unrelated root commit
    const atk = path.join(H.tmp('atk-'), 'a');
    H.gitOk(path.dirname(atk), 'clone', '-q', c.bare, atk);
    const empty = H.gitOk(atk, 'hash-object', '-t', 'tree', '/dev/null');
    const root = H.gitOk(atk, 'commit-tree', empty, '-m', 'rewritten notes');
    const rw = push(atk, `+${root}:refs/notes/canopy`);
    assert.notEqual(rw.code, 0, rw.err);
    assert.equal(H.gitOk(c.bare, 'rev-parse', 'refs/notes/canopy'), notesBefore, 'notes ref intact');
  } finally { c.d.kill(); }
});

test('S7 force-push (rewind) and deletion of main are refused', async () => {
  const home = H.tmp('home-'); const c = await canonical(home);
  try {
    await landOne(c, 'feat', 'src/util.js', 'Math.min(hi', 'Math.min(hi + 0');
    assert.equal(push(c.work, 'main', 'refs/notes/canopy').code, 0);
    const tip = H.gitOk(c.bare, 'rev-parse', 'main');
    const rewind = push(c.work, '+main~1:main');
    assert.notEqual(rewind.code, 0, rewind.err);
    const del = push(c.work, ':main');
    assert.notEqual(del.code, 0, del.err);
    // history rewrite to an unrelated commit
    H.gitOk(c.work, 'checkout', '-q', '--orphan', 'orph'); fs.writeFileSync(path.join(c.work, 'o.txt'), 'o');
    H.gitOk(c.work, 'add', '-A'); H.gitOk(c.work, 'commit', '-q', '-m', 'orphan');
    const orph = push(c.work, '+orph:main');
    assert.notEqual(orph.code, 0, orph.err);
    assert.equal(H.gitOk(c.bare, 'rev-parse', 'main'), tip);
  } finally { c.d.kill(); }
});

test('S8 other branches stay pushable on a protected repo (no collateral damage)', async () => {
  const home = H.tmp('home-'); const c = await canonical(home);
  try {
    H.gitOk(c.work, 'checkout', '-q', '-b', 'feature/x'); fs.writeFileSync(path.join(c.work, 'f.txt'), 'f');
    H.gitOk(c.work, 'add', '-A'); H.gitOk(c.work, 'commit', '-q', '-m', 'f');
    const r = push(c.work, 'feature/x');
    assert.equal(r.code, 0, r.err);
  } finally { c.d.kill(); }
});

test('S9 a signed landing with an unsigned commit smuggled on top of it is refused', async () => {
  const home = H.tmp('home-'); const c = await canonical(home);
  try {
    const { commit } = await landOne(c, 'feat', 'src/util.js', 'Math.min(hi', 'Math.min(hi + 0');
    const before = H.gitOk(c.bare, 'rev-parse', 'main');
    // work is on main at the landing commit; add an ordinary commit on top and push both
    assert.equal(H.gitOk(c.work, 'rev-parse', 'main'), commit);
    H.gitOk(c.work, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(c.work, 'smuggled.js'), 'export const s = 1;\n');
    H.gitOk(c.work, 'add', '-A'); H.gitOk(c.work, 'commit', '-q', '-m', 'smuggled');
    const r = push(c.work, 'main', 'refs/notes/canopy');
    assert.notEqual(r.code, 0, 'unsigned tip must be refused: ' + r.err);
    assert.equal(H.gitOk(c.bare, 'rev-parse', 'main'), before);
  } finally { c.d.kill(); }
});

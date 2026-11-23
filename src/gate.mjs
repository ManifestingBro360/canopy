// The landing gate. It decides whether a branch may reach main, builds the
// exact merge commit that will land, runs the section's checks on that commit
// inside a sandbox, signs a landing record for it, and moves main.
//
// Trust rules the gate follows:
// - The write set comes from the Git diff, never from what an agent reported.
// - Rules come from main, never from the branch being judged.
// - Checks run here, in canopyd. A result reported by a client is never used.
// - The signed record names the commit, its parents and its tree, so it cannot
//   be replayed onto another history.
import { spawn } from 'node:child_process';
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync, lstatSync, openSync, fstatSync, readSync, closeSync, constants as fsc } from 'node:fs';
import { join, basename, dirname, posix } from 'node:path';
import { randomBytes, timingSafeEqual, createHash } from 'node:crypto';
import { homedir, tmpdir, platform } from 'node:os';
import { extract } from './extract.mjs';
import { nodeId, pathOf, nameOf, bare, diffSymbols } from './graph.mjs';
import { git, tryGit, gitOk, worktreeOf, branchOf, showFile, mergeTree, commitTree, worktrees } from './git.mjs';
import { resolveAll, resolve, isTestFile, loadRules, modelMatch } from './rules.mjs';
import { usersExist, admins, activeUsers } from './access.mjs';
import { newDeps, lookup } from './advisories.mjs';
import { dossier, runManager } from './manager.mjs';
import { signRecord } from './sign.mjs';
import { fence, isBreaking, publishCommand } from './engine.mjs';

// Test cases and assertions in a test file's text. Comments are removed and the
// content of string and template literals is replaced by a token (equal text,
// equal token), so that text which only looks like a test or an assertion does
// not count, and commenting a check out counts as removing it. Constant
// assertions (assert.ok(true), assert.equal(1, 1), assert.equal(x, x)) and
// skipped or todo tests do not count. Approximate, and the same for the old and
// the new text, which is all the comparison needs.
function scrub(text, ext, keep = false, lits = new Map()) {
  const py = ext === 'py', n = text.length;
  let out = '', i = 0;
  while (i < n) {
    const c = text[i], d = text[i + 1];
    if (!py && c === '/' && d === '/') { while (i < n && text[i] !== '\n') i++; continue; }
    if (!py && c === '/' && d === '*') { const e = text.indexOf('*/', i + 2); i = e < 0 ? n : e + 2; out += ' '; continue; }
    if (py && c === '#') { while (i < n && text[i] !== '\n') i++; continue; }
    if (c === '"' || c === "'" || (c === '`' && !py)) {
      let j = i + 1;
      while (j < n && text[j] !== c) { if (text[j] === '\\') j++; else if (c !== '`' && text[j] === '\n') break; j++; }
      const body = text.slice(i + 1, j);
      if (keep) out += c + body + c;
      else { if (!lits.has(body)) lits.set(body, lits.size); out += `"S${lits.get(body)}"`; }
      i = j + 1; continue;
    }
    out += c; i++;
  }
  return out;
}
const CASE_RE = /(?:^|[^\w$.])(?:it|test|specify)(?:\.each)?\s*\(|^\s*(?:async\s+)?def test\w*|^\s*func Test\w+/gm;
const ASSERT_CALL = /(?:^|[^\w$.])assert(?:\.(\w+))?\s*\(/g;
const ASSERT_OTHER = /\bexpect\s*\(|^\s*assert\s+(?!True\b|1\b)|\bt\.(?:Error|Errorf|Fatal|Fatalf|Fail)\b|\.should\b/gm;
const LITERAL = /^(?:true|false|null|undefined|\d+(?:\.\d+)?|"S\d+"|!0|!1|\[\]|\{\})$/;
function callArgs(t, open) {
  const args = []; let depth = 0, cur = '';
  for (let i = open; i < t.length; i++) {
    const c = t[i];
    if ('([{'.includes(c)) { if (depth++) cur += c; }
    else if (')]}'.includes(c)) { if (--depth === 0) { if (cur.trim()) args.push(cur.trim()); return args; } cur += c; }
    else if (c === ',' && depth === 1) { args.push(cur.trim()); cur = ''; }
    else cur += c;
  }
  return args;
}
export function testStats(text, ext = 'js') {
  const t = scrub(String(text), ext);
  let cases = 0, asserts = 0;
  for (const m of t.matchAll(CASE_RE)) {
    const rest = t.slice(m.index + m[0].length, m.index + m[0].length + 400);
    const head = rest.split(/=>|\bfunction\b/)[0];
    if (!/\b(?:skip|todo)\s*:/.test(head)) cases++;
  }
  for (const m of t.matchAll(ASSERT_CALL)) {
    const args = callArgs(t, m.index + m[0].length - 1), name = m[1] || '';
    const equal = ['equal', 'strictEqual', 'deepEqual', 'deepStrictEqual'].includes(name);
    const constant = (!name || name === 'ok') ? args.length > 0 && LITERAL.test(args[0])
      : equal ? args.length >= 2 && (args[0] === args[1] || (LITERAL.test(args[0]) && LITERAL.test(args[1]))) : false;
    if (!constant) asserts++;
  }
  asserts += (t.match(ASSERT_OTHER) || []).length;
  return { cases, asserts };
}
// Two more ways to switch tests off without lowering the counts: remove a named
// test while padding with another, or wrap tests in something skipped. So the
// names of the old test cases must all still be there, and nothing new may be
// marked skip or todo.
const TITLE_RE = /(?:^|[^\w$.])(?:it|test|specify)(?:\.each)?\s*\(\s*"S(\d+)"|^\s*(?:async\s+)?def (test\w*)|^\s*func (Test\w+)/gm;
// Anything that switches a test off or narrows the run: skip, todo, only, conditional skips, the x- and f- forms,
// and the markers other runners use. Matched on text with literals replaced, so a string cannot stand in for one.
const SKIP_RE = /\.(?:skip|todo|only|skipIf|runIf|failing|fails)\b|\b(?:skip|todo|only)\s*:|(?:^|[^\w$.])(?:xit|xtest|xdescribe|xcontext|xspecify|fit|fdescribe|pending)\s*\(|@(?:pytest\.mark\.(?:skip|xfail)|unittest\.(?:skip|expectedFailure))|@(?:Disabled|Ignore)\b|#\[ignore\]|\bt\.Skip/g;
export function testMarks(text, ext = 'js') {
  const lits = new Map(), t = scrub(String(text), ext, false, lits);
  const body = [...lits.keys()], lit = (k) => body[Number(k)] ?? '';
  const titles = new Set([...t.matchAll(TITLE_RE)].map((m) => (m[1] !== undefined ? lit(m[1]) : m[2] ?? m[3])));
  // Each marker with what follows it (the test's name, with literals put back), so moving a skip from one test to another shows.
  const skips = new Map(); for (const k of [...t.matchAll(SKIP_RE)].map((m) => t.slice(m.index, m.index + m[0].length + 60).replace(/"S(\d+)"/g, (_, k) => JSON.stringify(lit(k))).replace(/\s+/g, ' ').trim())) skips.set(k, (skips.get(k) || 0) + 1);
  return { titles, skips };
}
// A path a test runner will pick up again; renaming a test file to anything else removes it.
const discoverable = (p) => isTestFile(p) && /\.(m?js|cjs|jsx|tsx?|py|go|rb|java|php|cs|rs|kt)$/.test(p);
export const SAFE_REL = /^(?!-)[\w./@-]+$/;
const safeRel = (p) => SAFE_REL.test(p) && !p.split('/').some((x) => x === '..' || x === '.git' || x === '');

export function testCommand(rel, tap = false) {
  if (!safeRel(rel)) throw new Error('unsafe test path');
  return `node --test${tap ? ' --test-reporter=tap' : ''} ${rel}`;
}

const real = (p) => { try { return realpathSync(p); } catch { return p; } };

// Wrap a check command so branch code cannot read the signing key, the
// database or common credential stores; cannot write anywhere except its own
// checkout, its own temp directory, Git's object store and package caches;
// cannot move refs or install hooks; cannot talk to canopyd; and has no
// outside network.
// Where credentials commonly live. One list, so the macOS and Linux profiles cannot drift apart.
const secretDirs = (H) => ['/.ssh', '/.aws', '/.gnupg', '/.config/gh', '/.config/gcloud', '/.azure', '/.kube', '/.docker', '/.password-store', '/.terraform.d', '/Library/Cookies'].map((p) => H + p);
const secretFiles = (H) => ['/.netrc', '/.npmrc', '/.git-credentials', '/.config/git/credentials', '/.pypirc'].map((p) => H + p);

export function sandbox(cmd, { home, common, network, dir, tmp, port, manager }) {
  if (platform() === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const H = real(homedir()), K = real(home), G = real(common);
    const q = (p) => JSON.stringify(p);
    const sub = (...ps) => ps.map((p) => `(subpath ${q(p)})`).join(' ');
    if (manager) {
      // The manager has to reach a model, so the network stays open. It can
      // write only inside its own throwaway directory: not to any tool's real
      // settings, where a planted hook or command would outlive the sandbox.
      // It can neither read nor write canopyd's key, tokens and database, the
      // repository's Git directory, or other credentials, nor talk to canopyd.
      const profile = ['(version 1)', '(allow default)',
        '(deny file-write* (subpath "/"))',
        `(allow file-write* ${sub(real(dir), '/dev')})`,
        `(deny file-read* file-write* ${sub(K, G)})`,
        `(deny file-read* ${sub(...secretDirs(H))} ${secretFiles(H).map((f) => `(literal ${q(f)})`).join(' ')})`,
        ...(port ? [`(deny network-outbound (remote ip "localhost:${port}"))`] : []),
      ].join('\n');
      return { file: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', cmd], mode: 'sandbox-exec' };
    }
    const profile = ['(version 1)', '(allow default)',
      '(deny file-write* (subpath "/"))',
      `(allow file-write* ${sub(real(dir), real(tmp), G + '/objects', G + '/worktrees', '/dev', H + '/.npm', H + '/.cache', H + '/Library/Caches')})`,
      `(deny file-read* ${sub(H + '/.ssh', H + '/.aws', H + '/.gnupg', H + '/.config/gh', H + '/.claude')} (literal ${q(H + '/.netrc')}) (literal ${q(H + '/.npmrc')}) (literal ${q(H + '/.claude.json')}))`,
      `(deny file-read* file-write* (subpath ${q(K)}))`,
      ...(network ? [] : ['(deny network-outbound)', '(allow network-outbound (remote ip "localhost:*"))', '(allow network-outbound (remote unix-socket))']),
      ...(port ? [`(deny network-outbound (remote ip "localhost:${port}"))`] : []),
    ].join('\n');
    return { file: '/usr/bin/sandbox-exec', args: ['-p', profile, '/bin/sh', '-c', cmd], mode: 'sandbox-exec' };
  }
  if (platform() === 'linux' && existsSync('/usr/bin/bwrap')) { // written to the same policy; not yet run on Linux
    const G = real(common);
    if (manager) {
      // Read-only everywhere and writable only in its own throwaway directory;
      // canopyd's state, the Git directory and credential stores are replaced by
      // empty ones. Not yet run on Linux. It does not stop the manager reaching
      // canopyd on the loopback address: that would need its own network namespace.
      const H = real(homedir());
      const args = ['--ro-bind', '/', '/', '--dev', '/dev', '--bind', real(dir), real(dir)];
      for (const p of [real(home), G, ...secretDirs(H)]) if (existsSync(p)) args.push('--tmpfs', p);
      for (const f of secretFiles(H)) if (existsSync(f)) args.push('--ro-bind', '/dev/null', f);
      return { file: '/usr/bin/bwrap', args: [...args, '/bin/sh', '-c', cmd], mode: 'bwrap' };
    }
    return { file: '/usr/bin/bwrap', args: ['--ro-bind', '/', '/', '--dev', '/dev', '--bind', real(dir), real(dir), '--bind', real(tmp), real(tmp), '--bind', G + '/objects', G + '/objects', '--bind', G + '/worktrees', G + '/worktrees', '--tmpfs', real(home), ...(network ? [] : ['--unshare-net']), '/bin/sh', '-c', cmd], mode: 'bwrap' };
  }
  return { file: '/bin/sh', args: ['-c', cmd], mode: 'none' };
}

function run(cmd, cwd, opts, timeoutMs) {
  return new Promise((res) => {
    const sb = sandbox(cmd, opts);
    const t0 = performance.now();
    const env = { PATH: process.env.PATH, HOME: homedir(), LANG: process.env.LANG || 'C.UTF-8', TMPDIR: opts.tmp, CI: '1', CANOPY_CHECK: '1' };
    // Its own process group, so a timeout takes the whole tree down, not just the shell.
    const child = spawn(sb.file, sb.args, { cwd, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
    let tail = '';
    const add = (d) => { tail = (tail + d.toString('utf8')).slice(-(opts.keep || 3000)); };
    child.stdout.on('data', add); child.stderr.on('data', add);
    const timer = setTimeout(() => { tail += '\n[canopy] timed out'; try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } }, timeoutMs);
    child.on('error', (e) => { clearTimeout(timer); res({ cmd, code: 127, ms: Math.round(performance.now() - t0), tail: String(e), mode: sb.mode }); });
    child.on('close', (code, sig) => { clearTimeout(timer); res({ cmd, code: code === null ? 137 : code, ms: Math.round(performance.now() - t0), tail: tail.trim(), mode: sb.mode, sig }); });
  });
}

export class Gate {
  constructor(engine, key, home) {
    this.e = engine; this.key = key; this.home = home;
    this.scratchRoot = join(engine.common, 'canopy-scratch');
    this.free = []; this.made = 0; this.waiting = []; this.busy = 0; this.port = 0; this.checkRuns = 0;
    this.chain = Promise.resolve();
    this.advCache = new Map(); this.mgrCache = new Map();
    const tp = join(home, 'human.token');
    if (!existsSync(tp)) writeFileSync(tp, randomBytes(16).toString('hex') + '\n', { mode: 0o600 });
    this.humanToken = readFileSync(tp, 'utf8').trim();
  }

  serial(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }

  // ---- analysis --------------------------------------------------------

  analyze(wt, C, M, by = '') {
    const e = this.e, repo = e.repo, g = e.graph;
    const mb = git(repo, ['merge-base', M, C]);
    const entries = [];
    const ns = git(repo, ['diff', '--name-status', '-M', '-z', mb, C]).split('\0');
    for (let i = 0; i < ns.length; i++) {
      const st = ns[i];
      if (!st) continue;
      if (st[0] === 'R' || st[0] === 'C') { entries.push({ st: st[0], old: ns[i + 1], path: ns[i + 2] }); i += 2; }
      else { entries.push({ st: st[0], old: ns[i + 1], path: ns[i + 1] }); i += 1; }
    }
    let changedLines = 0;
    const testReductions = [], testsModified = [];
    const sigs = new Map(); // symbol -> signature before and after, for the contract rule
    // -z: paths arrive as they are, whatever characters they contain.
    for (const l of git(repo, ['diff', '--numstat', '-z', '--no-renames', mb, C]).split('\0')) {
      const [a, d, ...rest] = l.split('\t');
      const p = rest.join('\t');
      if (!p) continue;
      changedLines += (Number(a) || 0) + (Number(d) || 0);
      if (!isTestFile(p) || !gitOk(repo, ['cat-file', '-e', `${mb}:${p}`])) continue;
      // A test file that was there before: deleted, shrunk, or only edited.
      const oldT = showFile(repo, mb, p);
      const moved = entries.find((x) => x.st === 'R' && x.old === p);
      const newT = showFile(repo, C, moved ? moved.path : p);
      if (newT === null || (moved && !discoverable(moved.path))) { testReductions.push(p); continue; }
      if (typeof oldT !== 'string' || oldT === newT) continue;
      const ext = (/\.(\w+)$/.exec(moved ? moved.path : p) || [])[1];
      const o = testStats(oldT, ext), n = testStats(newT, ext);
      if (!o.cases && !o.asserts) { if (Number(d) > 0) testReductions.push(p); continue; } // not a test layout we can count: any removed line holds
      const om = testMarks(oldT, ext), nm = testMarks(newT, ext);
      if (n.cases < o.cases || n.asserts < o.asserts || [...nm.skips].some(([k, c]) => c > (om.skips.get(k) || 0)) || [...om.titles].some((t) => !nm.titles.has(t))) testReductions.push(p);
      else testsModified.push(p);
    }
    const touched = new Set();
    const writeSet = [];
    const idents = new Set(); // identifiers used by the code this branch changed, taken from the diff itself
    const add = (node, kind, ch) => { writeSet.push({ node, kind }); if (ch) sigs.set(node, { old: ch.sigOld || '', new: ch.sigNew || '' }); };
    for (const en of entries) {
      touched.add(en.path); touched.add(en.old);
      const moved = en.st === 'R' && en.old !== en.path;
      const oldText = en.st === 'A' || en.st === 'C' ? null : showFile(repo, mb, en.old);
      const newText = en.st === 'D' ? null : showFile(repo, C, en.path);
      const exOld = oldText === null ? null : extract(en.old, oldText);
      const exNew = newText === null ? null : extract(en.path, newText);
      if (moved) {
        for (const ch of diffSymbols(exOld, null)) add(nodeId(en.old, ch.name), 'removed', ch);
        for (const ch of diffSymbols(null, exNew)) add(nodeId(en.path, ch.name), 'added');
        add(en.old, 'removed'); add(en.path, 'added');
        continue;
      }
      const before = writeSet.length;
      const chs = diffSymbols(exOld, exNew);
      for (const ch of chs) add(nodeId(en.path, ch.name), ch.kind, ch);
      if (!exOld) add(en.path, 'added');
      else if (!exNew) add(en.path, 'removed');
      else if (!exOld.lang || !exNew.lang || exOld.looseHash !== exNew.looseHash) add(en.path, 'body');
      // In the diff but nothing meaningful changed (layout only): still part of the record.
      if (writeSet.length === before) add(en.path, 'format');
      if (exNew) {
        const names = new Set(chs.filter((c) => c.kind !== 'removed').map((c) => c.name));
        for (const sym of exNew.symbols) if (names.has(sym.name)) for (const w of sym.idents) idents.add(w);
        if (!exOld || exOld.looseHash !== exNew.looseHash) for (const w of exNew.idents) idents.add(w);
      }
    }
    const written = new Set(writeSet.map((w) => w.node));
    const blast = new Set();
    for (const w of writeSet) {
      if (w.kind === 'added' || w.kind === 'format') continue;
      for (const d of g.dependents(w.node, w.kind === 'body' ? 1 : 2)) if (!written.has(d)) blast.add(d);
    }
    const reads = new Map(e.store.all('select node, hash, strength from reads where worktree=?', wt).map((r) => [r.node, r]));
    const unread = [];
    let covered = 0;
    for (const n of blast) {
      const r = reads.get(n), node = g.nodes.get(n);
      const fresh = r && r.strength === 2 && (!n.includes('#') || (node && r.hash === node.bodyHash));
      if (fresh) covered++; else unread.push(n);
    }
    // Landings since this branch forked that changed something it read or references.
    const stale = [];
    const since = (tryGit(repo, ['rev-list', '--first-parent', `${mb}..${M}`]) || '').split('\n').filter(Boolean);
    if (since.length) {
      const refs = new Set(e.store.all('select distinct name from refs where worktree=?', wt).map((r) => r.name));
      for (const sha of since) {
        const l = e.store.get('select id from landings where merge_sha=?', sha);
        if (!l) continue;
        for (const ln of e.store.all("select node, kind from landed_nodes where landing=? and kind in ('signature','removed')", l.id)) {
          const bn = bare(nameOf(ln.node));
          const uses = refs.has(bn) || idents.has(bn);
          if (reads.has(ln.node) || uses) stale.push({ node: ln.node, kind: ln.kind, landed: sha.slice(0, 8), uses });
        }
      }
    }
    const witnessed = new Set(e.store.all('select path from writes where worktree=? union select path from wtfiles where worktree=?', wt, wt).map((r) => r.path));
    // A file counts as witnessed only if what was committed is what Canopy last
    // saw there: an edit made afterwards, outside any session, is not covered by
    // the record of the edits before it.
    // Fails closed: with no content on record for a file that still exists, it is not witnessed.
    const seenBlob = new Map(e.store.all('select path, seen_blob from wtfiles where worktree=?', wt).map((r) => [r.path, r.seen_blob]));
    const unwitnessed = entries.filter((en) => !witnessed.has(en.path) || (en.st !== 'D' && (!seenBlob.get(en.path) || seenBlob.get(en.path) !== tryGit(repo, ['rev-parse', '--verify', '--quiet', `${C}:${en.path}`])))).map((en) => en.path);
    const taint = e.store.all('select source from taint where worktree=?', wt).map((r) => r.source);
    if (unwitnessed.length) taint.push('unwitnessed-writes');
    // Rules come from main. A branch that changes the rules file must leave a
    // valid one behind. If main's own rules are broken, the only thing that can
    // land is a repair, judged by the repaired rules and approved by a person.
    let rs = e.ruleset;
    const blocked = [], human = [];
    let repair = false;
    if (touched.has('.canopy/rules.json')) {
      const cand = loadRules(repo, C);
      if (cand.error) blocked.push('this branch would leave the rules file broken: ' + cand.error);
      else if (rs.error) { rs = cand; repair = true; human.push(`the rules on ${e.main} are invalid and this landing repairs them`); }
    }
    if (rs.error) blocked.push(rs.error + `. Nothing can land until a change that repairs .canopy/rules.json lands; that change needs a person.`);
    // Tests may not cover a call the branch just wrote. If main changed the thing
    // being called since the branch forked, the branch has to look at it first.
    const used = stale.filter((x) => x.uses);
    if (used.length) blocked.push(`${e.main} changed since this branch forked, and code this branch changed uses what changed: ${used.slice(0, 6).map((x) => `${x.node} [${x.kind}, landing ${x.landed}]`).join(', ')}. Run \`git merge ${e.main}\`, check those uses, commit, and land again.`);
    const plan = resolveAll(rs, [...touched].filter(Boolean));
    // Breaking change to shared code: the author must have published a contract.
    // Its test then has to pass on the merge commit like any other check.
    const contractsUsed = [];
    if (rs.contracts.requireForBreaking) {
      for (const w of writeSet) {
        const sg = sigs.get(w.node);
        if ((w.kind !== 'signature' && w.kind !== 'removed') || !w.node.includes('#') || !sg || !isBreaking(w.kind, sg.old, sg.new) || !e.isShared(w.node, wt)) continue;
        const ct = e.contractOf(w.node, wt);
        const sym = fence(w.node, 160), cmd = publishCommand(w.node);
        const what = w.kind === 'removed' ? 'removes' : 'changes the signature of';
        if (!ct) blocked.push(`this branch ${what} ${sym}, which other code uses, so existing callers will break, and no contract is published. Write a test that fails on ${e.main} and passes on this branch, commit it, then run \`${cmd}\`. Or keep old callers working (for example, give a new argument a default).`);
        else if (!safeRel(ct.test_path)) blocked.push(`the contract test path ${fence(ct.test_path, 100)} for ${sym} is not an allowed name. Publish it again from a file with a plain name.`);
        else if (ct.sig !== sg.new) blocked.push(`${sym} changed again after its contract was published. Publish it again: \`${publishCommand(w.node, ct.test_path)}\``);
        else {
          const blob = tryGit(repo, ['rev-parse', '--verify', '--quiet', `${C}:${ct.test_path}`]);
          if (!blob) blocked.push(`the contract test ${fence(ct.test_path, 100)} for ${sym} is not committed on this branch. Commit it and land again.`);
          else if (blob !== ct.test_blob) blocked.push(`the contract test ${fence(ct.test_path, 100)} for ${sym} changed after it was published. Publish it again: \`${publishCommand(w.node, ct.test_path)}\``);
          else { contractsUsed.push({ node: w.node, test: ct.test_path, sig: ct.sig }); const tc = testCommand(ct.test_path); if (!plan.checks.includes(tc)) plan.checks.push(tc); }
        }
      }
    }
    const coverage = blast.size ? covered / blast.size : 1;
    if (plan.protectedFiles.length) human.push(`protected files changed: ${plan.protectedFiles.slice(0, 8).join(', ')}`);
    if (taint.length && (plan.noTaintedFiles.length || plan.protectedFiles.length)) human.push(`the branch took in outside content (${taint.slice(0, 5).join(', ')}) and changes a section that does not accept that without review`);
    if (testReductions.length) human.push(`existing tests were removed or reduced: ${testReductions.slice(0, 8).join(', ')}`);
    if (coverage < plan.min_coverage) human.push(`inspection coverage ${Math.round(coverage * 100)}% is below the ${Math.round(plan.min_coverage * 100)}% this section requires`);
    if (changedLines > plan.max_changed_lines) human.push(`${changedLines} changed lines exceeds the section limit of ${plan.max_changed_lines}`);
    if (unwitnessed.length && plan.no_unwitnessed) human.push(`files changed with no recorded agent activity: ${unwitnessed.slice(0, 8).join(', ')}`);

    // People and models. Policy comes from the rules on main; identity comes
    // from canopyd's own user list, never from what a request says about itself.
    const strict = usersExist(e.store);
    // Each row is one session's hand in one file, with the person and model it had at that moment.
    const authorRows = e.store.all('select path, user, model, agent, how from authors where worktree=?', wt);
    const where = (x) => x.path || 'the repository';
    if ((plan.owned.size || plan.writers.size) && !strict) blocked.push(`the rules name owners or writers, but this canopyd has no users, so it cannot tell who anyone is. Add them with \`canopy user add <name>\`.`);
    else {
      for (const w of plan.writers.values()) {
        const people = new Set([by, ...authorRows.filter((r) => w.files.includes(r.path)).map((r) => r.user)].filter(Boolean));
        for (const u of people) if (!w.allowed.includes(u)) blocked.push(`${u} may not change ${where(w)} (${w.files.slice(0, 4).join(', ')}). The rules allow only: ${w.allowed.join(', ')}.`);
      }
    }
    for (const m of plan.models.values()) {
      const bad = new Set();
      for (const r of authorRows.filter((x) => m.files.includes(x.path))) {
        if (!r.model) bad.add('a session whose model is not known');
        else if (!m.allow.some((pat) => modelMatch(pat, r.model))) bad.add(r.model);
        // A shell command can be a merge, a script or a paste: the session that ran it did not necessarily write it.
        if (r.how !== 'hook') bad.add('changes that arrived through a shell command, a merge or a script');
      }
      for (const f of m.files) if (entries.some((en) => en.path === f) && (!authorRows.some((r) => r.path === f) || unwitnessed.includes(f))) bad.add('an author Canopy has no record of');
      if (bad.size) human.push(`${where(m)} accepts changes written by these models only: ${m.names.join(', ')}. This change was written by: ${[...bad].join(', ')}`);
    }
    // Approvals this landing needs: from the owners of every section it changes,
    // and from owners who asked to be consulted when code they depend on changes shape.
    const required = [...plan.owned.values()].map((o) => ({ section: o.path, owners: o.owners, need: o.approvals, why: 'owns files this change touches' }));
    const reach = new Map();
    for (const w of writeSet) {
      if (w.kind !== 'signature' && w.kind !== 'removed') continue;
      for (const d of g.dependents(w.node, 2)) {
        if (written.has(d)) continue;
        for (const gd of resolve(rs, pathOf(d)).guards) {
          if (plan.owned.has(gd.key)) continue;
          const x = reach.get(gd.key) || { ...gd, nodes: [] };
          x.nodes.push(d); reach.set(gd.key, x);
        }
      }
    }
    for (const x of reach.values()) required.push({ section: x.path, owners: x.owners, need: x.approvals, why: `code there depends on what this change alters (${x.nodes.slice(0, 4).join(', ')})` });
    if (required.length && !strict && !blocked.length) blocked.push('sections with owners are affected, but this canopyd has no users. Add them with `canopy user add <name>`.');
    const authors = [...new Map(authorRows.map((r) => [`${r.user}|${r.agent}|${r.model}`, { user: r.user || '', harness: r.agent || '', model: r.model || '' }])).values()];
    // Whether every file the change touches sits inside some owned section.
    const allOwned = entries.length > 0 && [...touched].filter(Boolean).every((f) => resolve(rs, f).owned.length);
    return { required, authors, by, repair, allOwned, authorUsers: [...new Set(authorRows.map((r) => r.user).filter(Boolean))], mb, entries, touched: [...touched].filter(Boolean), writeSet, blast: [...blast], unread, coverage, stale, unwitnessed, taint, plan, changedLines, testReductions, testsModified, contractsUsed, blocked, human, rulesHash: rs.hash, rs, idents };
  }

  // ---- checks ----------------------------------------------------------

  async scratch(rev) {
    let dir = this.free.pop();
    if (!dir && this.made < 2) dir = join(this.scratchRoot, 's' + this.made++);
    if (!dir) dir = await new Promise((res) => this.waiting.push(res));
    mkdirSync(this.scratchRoot, { recursive: true });
    const fresh = () => {
      rmSync(dir, { recursive: true, force: true });
      tryGit(this.e.repo, ['worktree', 'prune']);
      git(this.e.repo, ['worktree', 'add', '--detach', '--force', dir, rev]);
    };
    try {
      if (existsSync(join(dir, '.git'))) {
        // A scratch checkout a check left in a bad state is rebuilt, not trusted.
        if (tryGit(dir, ['checkout', '--detach', '--force', rev]) === null || tryGit(dir, ['clean', '-fd']) === null) fresh();
      } else fresh();
    } catch (err) {
      this.release(dir); // never lose a slot: a lost slot would hang every later landing
      throw err;
    }
    return dir;
  }
  release(dir) { const w = this.waiting.shift(); if (w) w(dir); else this.free.push(dir); }

  async runChecks(rev, plan, rs) {
    const out = { checks: [], perf: [], failed: null, sandbox: 'none' };
    if (!plan.checks.length && !plan.perf.length && !rs.setup.length) return out;
    this.checkRuns++;
    let dir;
    try { dir = await this.scratch(rev); } catch (err) { out.failed = 'could not prepare a checkout to run the checks in: ' + String(err.stderr || err.message).trim().slice(0, 300); return out; }
    // Each run gets an empty temp directory of its own; nothing carries over between landings.
    const tmp = dir + '.tmp';
    rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
    const opts = { home: this.home, common: this.e.common, network: rs.network, dir, tmp, port: this.port };
    try {
      for (const cmd of rs.setup) {
        const r = await run(cmd, dir, { ...opts, network: true }, rs.checkTimeoutMs);
        out.sandbox = r.mode;
        if (r.code !== 0) { out.failed = `setup \`${cmd}\` failed (exit ${r.code}): ${r.tail.slice(-600)}`; return out; }
      }
      for (const cmd of plan.checks) {
        const r = await run(cmd, dir, opts, rs.checkTimeoutMs);
        out.sandbox = r.mode;
        out.checks.push({ cmd, code: r.code, ms: r.ms });
        if (r.code !== 0) { out.failed = `check \`${cmd}\` failed (exit ${r.code}): ${r.tail.slice(-900)}`; return out; }
      }
      for (const p of plan.perf) {
        const times = [];
        for (let i = 0; i < (p.runs || 3); i++) {
          const r = await run(p.cmd, dir, opts, rs.checkTimeoutMs);
          out.sandbox = r.mode;
          if (r.code !== 0) { out.failed = `performance check \`${p.cmd}\` failed (exit ${r.code}): ${r.tail.slice(-600)}`; return out; }
          times.push(r.ms);
        }
        const med = times.sort((x, y) => x - y)[Math.floor(times.length / 2)];
        out.perf.push({ cmd: p.cmd, ms: med, max_ms: p.max_ms });
        if (med > p.max_ms) { out.failed = `performance budget exceeded: \`${p.cmd}\` took ${med} ms, budget ${p.max_ms} ms`; return out; }
      }
      return out;
    } finally { rmSync(tmp, { recursive: true, force: true }); this.release(dir); }
  }

  // True when nothing that landed between two revisions of main can interact
  // with this change, according to the graph.
  disjoint(a, from, to) {
    const e = this.e;
    const shas = (tryGit(e.repo, ['rev-list', '--first-parent', `${from}..${to}`]) || '').split('\n').filter(Boolean);
    // If anything this branch read or calls changed on main meanwhile, the checks must run again.
    if (a.stale.length || a.unwitnessed.length) return false;
    const mine = new Set([...a.writeSet.map((w) => w.node), ...a.blast]);
    const myPaths = new Set(a.touched);
    for (const sha of shas) {
      const l = e.store.get('select id from landings where merge_sha=?', sha);
      if (!l) return false;
      for (const n of e.store.all('select node from landed_nodes where landing=?', l.id)) {
        if (mine.has(n.node) || myPaths.has(pathOf(n.node)) || a.idents.has(bare(nameOf(n.node)))) return false;
        for (const d of e.graph.dependents(n.node, 2)) if (mine.has(d)) return false;
      }
    }
    return true;
  }

  // ---- landing ---------------------------------------------------------

  save(id, wt, branch, C, R, status, record) {
    const s = this.e.store;
    s.run("delete from landings where worktree=? and status in ('needs-human','blocked')", wt);
    s.run(`insert into landings(id, worktree, branch, commit_sha, merge_sha, status, record, ts) values(?,?,?,?,?,?,?,?)
           on conflict(id) do update set merge_sha=excluded.merge_sha, status=excluded.status, record=excluded.record, ts=excluded.ts`,
      id, wt, branch, C, R || '', status, JSON.stringify(record), Date.now());
    s.event('landing', { id, branch, status, wt: basename(wt), coverage: record.coverage, reasons: record.reasons || [] });
  }

  // ---- people ----------------------------------------------------------

  // Which approvals a landing still lacks. An approval counts only for the
  // exact commit and the exact rules it was given for.
  // What an approval is given for: these reasons and these requirements. If
  // either changes, earlier approvals no longer cover the landing.
  basis(a) {
    return createHash('sha256').update(JSON.stringify([[...a.human].sort(), a.required.map((r) => [r.section, r.owners, r.need])])).digest('hex').slice(0, 16);
  }

  approvalState(a, id, C) {
    const s = this.e.store, by = a.by, active = activeUsers(s), basis = this.basis(a);
    // Only approvals for this commit, these rules and these reasons, from people who are still users.
    const rows = s.all('select user, ts from approvals where landing=? and commit_sha=? and rules_hash=? and basis=? order by ts', id, C, a.rulesHash, basis)
      .filter((r) => r.user.startsWith('human:') || active.has(r.user));
    const approved = new Set(rows.map((r) => r.user));
    const waiting = [];
    for (const r of a.required) {
      // An owner who lands a change has, by landing it, approved it.
      const have = r.owners.filter((u) => active.has(u) && (approved.has(u) || u === by));
      if (have.length < r.need) waiting.push({ section: r.section, owners: r.owners.filter((u) => active.has(u)), need: r.need, have, why: r.why });
    }
    if (a.human.length) {
      // These need a person who neither landed nor wrote the change: an
      // administrator, or, when the whole change lies inside owned sections, one
      // of their owners. A repair of broken rules is for administrators only: the
      // rules being repaired must not pick their own approver. With no users, the
      // single human token stands in.
      const owners = a.allOwned && !a.repair ? a.required.flatMap((r) => r.owners) : [];
      const eligible = [...new Set([...owners, ...admins(s)])].filter((u) => active.has(u) && u !== by && !a.authorUsers.includes(u));
      const have = [...approved].filter((u) => u.startsWith('human:') || eligible.includes(u));
      if (!have.length) waiting.push({ kind: 'person', token: !usersExist(s) || undefined, section: '', owners: eligible, need: 1, have: [], why: 'a person other than the one landing must look at the reasons listed' });
    }
    return { ok: !waiting.length, waiting, approved: rows, basis };
  }

  async advise(a, C) {
    const cfg = a.rs.advisories;
    if (!cfg) return;
    const deps = newDeps(this.e.repo, a.mb, C, a.touched);
    a.advisories = []; a.advisoryStatus = deps.length ? 'checked' : 'no new dependencies';
    if (!deps.length) return;
    const key = C + a.mb;
    let r = this.advCache.get(key);
    if (!r) { r = await lookup(deps); if (r.ok) { if (this.advCache.size > 200) this.advCache.clear(); this.advCache.set(key, r); } }
    if (!r.ok) {
      a.advisoryStatus = 'unavailable: ' + r.error;
      if (cfg.onUnavailable === 'review') a.human.push('the vulnerability database could not be reached, and the rules ask for a person when that happens');
      return;
    }
    a.advisories = r.findings;
    if (!r.findings.length) return;
    const text = 'this change brings in dependencies with known advisories: ' + r.findings.slice(0, 8).map((f) => `${f.package}@${f.version} ${f.id}${f.fixed.length ? ` (fixed in ${f.fixed[0]})` : ''}`).join(', ');
    if (cfg.onNew === 'block') a.blocked.push(text + '. Move to a fixed version and land again.');
    else if (cfg.onNew === 'review') a.human.push(text);
  }

  // A second look by the team's manager command. It can add a reason to stop; it cannot remove one.
  async manage(a, info) {
    const cfg = a.rs.manager;
    if (!cfg || a.manager) return;
    if (cfg.when === 'flagged' && !a.human.length && !a.required.length) return;
    const key = info.C + a.mb + a.rulesHash;
    let r = this.mgrCache.get(key);
    if (!r) {
      r = await runManager(cfg, dossier(this.e, a, info), (cmd, dir) => sandbox(cmd, { home: this.home, common: this.e.common, port: this.port, dir, manager: true }));
      if (r.verdict !== 'error') { if (this.mgrCache.size > 200) this.mgrCache.clear(); this.mgrCache.set(key, r); }
      this.e.store.audit({ user: 'manager' }, 'manager.verdict', info.branch, { verdict: r.verdict, model: r.model, ms: r.ms });
    }
    // What the manager wrote is a model's words about untrusted code. It could
    // have been talked into quoting things it should not, so its words do not go
    // back to whoever asked for the landing, into the signed record, or to a
    // chat channel. They are kept for the people who decide (`canopy concerns`).
    // What travels is the verdict and, per finding, a severity and a file that
    // is really part of this change.
    const files = new Set(a.touched);
    const findings = r.findings.filter((f) => files.has(f.file)).map((f) => ({ severity: ['low', 'medium', 'high'].includes(f.severity) ? f.severity : 'medium', file: f.file }));
    a.manager = { verdict: r.verdict, findings, model: String(r.model || '').replace(/[^A-Za-z0-9._:\/-]/g, '').slice(0, 80), ms: r.ms };
    this.e.store.run('insert into manager_notes(landing, summary, findings, ts) values(?,?,?,?) on conflict(landing) do update set summary=excluded.summary, findings=excluded.findings, ts=excluded.ts', info.id, r.summary, JSON.stringify(r.findings), Date.now());
    const where = findings.length ? ` about ${findings.slice(0, 5).map((f) => `${f.file} [${f.severity}]`).join(', ')}` : '';
    const how = `Its written reasons are kept for the people who decide: \`canopy concerns ${info.id}\`.`;
    if (r.verdict === 'block') a.blocked.push(`the manager refused this change${where}. ${how}`);
    else if (r.verdict === 'concern') a.human.push(`the manager raised concerns${where}. ${how}`);
    else if (r.verdict === 'error' && cfg.onError === 'review') a.human.push(`the manager gave no usable verdict (${r.safe || 'no reason given'}), and the rules ask for a person when that happens`);
  }

  // ---- landing ---------------------------------------------------------

  async land({ cwd, intent, who, approvedId }) {
    const e = this.e, repo = e.repo;
    const w = worktreeOf(cwd);
    if (!w || w.common !== e.common) return { status: 'error', message: 'this directory is not a worktree of the repository canopyd serves' };
    const wt = w.top, branch = branchOf(w.gitdir);
    if (branch === e.main) return { status: 'error', message: `you are on ${e.main}; land from a branch` };
    if (e.ruleset.environments.some((x) => x.branch === branch)) return { status: 'error', message: `${branch} is an environment branch; it moves only through \`canopy promote\`` };
    const by = (who && who.user) || '';
    if (usersExist(e.store) && !by) return { status: 'error', message: 'this canopyd has users, so landing needs to know who you are. Set CANOPY_TOKEN to the token `canopy user add` printed for you.' };
    const dirty = git(wt, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) return { status: 'error', message: 'commit your work first; uncommitted changes:\n' + dirty.split('\n').slice(0, 10).join('\n') };
    const C = git(wt, ['rev-parse', 'HEAD']);
    e.refresh();
    const M0 = e.graph.rev;
    if (gitOk(repo, ['merge-base', '--is-ancestor', C, M0])) return { status: 'nothing', message: 'this branch is already on ' + e.main };
    const sessions = e.store.all('select short, agent, model, task, user from sessions where worktree=? order by seen desc limit 8', wt);
    const task = (intent || (sessions.find((x) => x.task) || {}).task || git(repo, ['log', '-1', '--format=%s', C])).replace(/\s+/g, ' ').slice(0, 200);
    const prior = e.store.get("select id from landings where worktree=? and commit_sha=? and status='needs-human'", wt, C);
    const id = prior ? prior.id : randomBytes(4).toString('hex');
    const msg = `Land ${branch}: ${task}\n\nCanopy-Landing: ${id}`;
    const info = { id, C, branch, intent: task, by, sessions: sessions.map((x) => ({ user: x.user || '', harness: x.agent, model: x.model })) };

    const draft = (a, extra = {}) => ({
      v: 2, id, candidate: C, branch, worktree: basename(wt), intent: task, by: by || undefined,
      sessions: sessions.map((x) => ({ id: x.short, agent: x.agent, model: x.model, user: x.user || undefined })),
      authors: a.authors, owners_required: a.required.length ? a.required : undefined,
      write_set: a.writeSet, blast: a.blast.length, coverage: Math.round(a.coverage * 1000) / 1000, unread: a.unread.slice(0, 60),
      unwitnessed: a.unwitnessed, taint: a.taint, stale_assumptions: a.stale, changed_lines: a.changedLines, test_reductions: a.testReductions, tests_modified: a.testsModified.length ? a.testsModified : undefined, contracts: a.contractsUsed.length ? a.contractsUsed : undefined,
      advisories: a.advisories, advisory_status: a.advisoryStatus, manager: a.manager,
      rules_hash: a.rulesHash, trust: 'hook-reported', ...extra,
    });
    const stop = (a, status, reasons, extra) => {
      const record = draft(a, { reasons, ...extra });
      this.save(id, wt, branch, C, '', status, record);
      e.store.audit(who, 'land.' + status, branch, { id, commit: C.slice(0, 12), reasons: reasons.slice(0, 6) });
      if (e.out) {
        // Worth a security reader's eye: outside content, known-vulnerable dependencies, a manager's refusal, or someone reaching past their access.
        const sec = a.taint.length || (a.advisories || []).length || (a.manager && a.manager.verdict === 'block') || reasons.some((r) => /may not change|accepts changes written by/.test(r));
        const held = status === 'needs-human', waiting = record.waiting_on || [];
        e.out.emit({ kinds: [held ? 'approval' : 'blocked', ...(sec ? ['security'] : [])], id, branch, by, files: a.touched, waiting, once: `${status}|${id}|${C}|${record.basis || reasons.join('|')}`,
          title: held ? `Approval needed: ${branch}` : `Landing refused: ${branch}`,
          lines: [`Purpose: ${task}`, by ? `Asked for by: ${by}` : '', ...((a.testsModified || []).length ? [`Tests edited, counts not lower: ${a.testsModified.slice(0, 6).map((f) => fence(f, 100)).join(', ')}`] : []), ...reasons.slice(0, 5).map((r) => `- ${r}`),
            ...(held ? [waiting.length ? `Waiting on: ${waiting.map((q) => (q.token ? 'anyone holding the approval token' : `${q.kind === 'person' ? 'a person' : q.section || 'the whole repository'} (${q.owners.join(', ') || 'no one eligible'})`)).join('; ')}` : '', `To approve: canopy approve ${id}`] : [])] });
      }
      return { status, id, reasons, record };
    };
    const needHuman = (x) => !this.approvalState(x, id, C).ok;
    const human = (x, r) => {
      const st = this.approvalState(x, id, C);
      const asks = st.waiting.map((q) => q.kind === 'person'
        ? `needs a person${q.owners.length ? ': ' + q.owners.join(', ') : ' (no eligible user exists yet; add an administrator with `canopy user add <name> --admin`)'}`
        : `needs ${q.need - q.have.length} more approval${q.need - q.have.length > 1 ? 's' : ''} from the owners of ${q.section || 'the repository'} (${q.owners.join(', ')}): ${q.why}`);
      const stale = approvedId && (approvedId !== id || e.store.get('select 1 x from approvals where landing=? and (commit_sha != ? or rules_hash != ? or basis != ?)', id, C, x.rulesHash, st.basis));
      return stop(x, 'needs-human', [...x.human, ...(usersExist(e.store) ? asks : [])], { checks: r.checks, perf: r.perf, sandbox: r.sandbox, waiting_on: st.waiting, basis: st.basis,
        note: stale ? 'the branch, the rules or the reasons changed after approval was given; approval must be given again' : undefined });
    };

    let a = this.analyze(wt, C, M0, by);
    await this.advise(a, C);
    if (a.blocked.length) return stop(a, 'blocked', a.blocked);
    let m = mergeTree(repo, M0, C);
    if (m.conflicts) return stop(a, 'blocked', [`does not merge cleanly with ${e.main}: ${m.conflicts.slice(0, 8).join(', ')}. Run \`git merge ${e.main}\`, resolve, commit, and land again.`]);
    this.busy++;
    try {
      let R = null, res = null;
      // Run the checks before taking a turn in the commit phase, unless another
      // landing is already in progress and the rules say checks must be re-run
      // whenever main moves: then the early run would only be thrown away.
      if (!(a.rs.revalidate === 'always' && this.busy > 1)) {
        R = commitTree(repo, m.tree, [M0, C], msg);
        res = await this.runChecks(R, a.plan, a.rs);
        if (res.failed) return stop(a, 'blocked', [res.failed], { checks: res.checks, perf: res.perf, sandbox: res.sandbox });
        await this.manage(a, info);
        if (a.blocked.length) return stop(a, 'blocked', a.blocked, { checks: res.checks, perf: res.perf, sandbox: res.sandbox });
        if (needHuman(a)) return human(a, res);
      }

      // Commit phase: one landing at a time, so the tree that was tested is the tree that lands.
      return await this.serial(async () => {
        e.refresh();
        const M1 = e.graph.rev;
        // A second `canopy land` for the same commit may have won the race.
        if (gitOk(repo, ['merge-base', '--is-ancestor', C, M1])) return { status: 'nothing', message: 'this branch is already on ' + e.main };
        let revalidated = null;
        if (M1 !== M0 || !res) {
          if (M1 !== M0) {
            a = this.analyze(wt, C, M1, by);
            await this.advise(a, C);
            if (a.blocked.length) return stop(a, 'blocked', a.blocked);
            m = mergeTree(repo, M1, C);
            if (m.conflicts) return stop(a, 'blocked', [`${e.main} moved while this landing waited and the branch no longer merges cleanly: ${m.conflicts.slice(0, 8).join(', ')}. Run \`git merge ${e.main}\` and land again.`]);
          }
          R = commitTree(repo, m.tree, [M1, C], msg);
          if (res && a.rs.revalidate === 'disjoint' && this.disjoint(a, M0, M1)) {
            revalidated = 'checks not re-run: the graph shows no interaction with what landed meanwhile';
          } else {
            const again = !!res;
            res = await this.runChecks(R, a.plan, a.rs);
            if (res.failed) return stop(a, 'blocked', [(again ? `after ${e.main} moved: ` : '') + res.failed], { checks: res.checks, perf: res.perf, sandbox: res.sandbox });
            if (again) revalidated = `checks re-run on the new ${e.main}`;
          }
          await this.manage(a, info);
          if (a.blocked.length) return stop(a, 'blocked', a.blocked, { checks: res.checks, perf: res.perf, sandbox: res.sandbox });
          if (needHuman(a)) return human(a, res);
        }
        const st = this.approvalState(a, id, C);
        const approvers = st.approved.map((r) => ({ user: r.user.replace(/^human:/, ''), ts: r.ts }));
        const record = draft(a, {
          commit: R, base: M1, parents: [M1, C], tree: git(repo, ['rev-parse', R + '^{tree}']), verdict: 'land',
          checks: res.checks, perf: res.perf, sandbox: res.sandbox, revalidated,
          approvals: approvers.length ? approvers : undefined,
          approval: approvers.length ? { id, by: approvers.map((x) => x.user).join(', '), ts: approvers[approvers.length - 1].ts, commit: C, rules_hash: a.rulesHash, reasons: a.human } : undefined,
          reasons: approvers.length ? a.human : [], events_head: e.store.eventsHead(), ts: Date.now(),
        });
        delete record.candidate;
        const noteFile = join(this.home, `note-${id}.json`);
        writeFileSync(noteFile, signRecord(record, this.key));
        try {
          git(repo, ['notes', '--ref=canopy', 'add', '-f', '-F', noteFile, R]);
        } finally { rmSync(noteFile, { force: true }); }
        const remote = tryGit(repo, ['config', '--get', 'canopy.push']);
        if (remote) {
          const pushed = tryGit(repo, ['push', '--atomic', remote, `${R}:refs/heads/${e.main}`, 'refs/notes/canopy:refs/notes/canopy']);
          if (pushed === null) {
            let why = '';
            try { git(repo, ['push', '--atomic', remote, `${R}:refs/heads/${e.main}`, 'refs/notes/canopy:refs/notes/canopy']); } catch (err) { why = String(err.stderr || err.message).split('\n').filter((l) => /remote:|rejected|error/i.test(l)).slice(0, 6).join(' | '); }
            tryGit(repo, ['notes', '--ref=canopy', 'remove', R]);
            return stop(a, 'blocked', [`the canonical repository refused the landing: ${why || 'push failed'}`], { checks: res.checks });
          }
        }
        let warning;
        const co = worktrees(repo).find((x) => x.branch === e.main && x.path && existsSync(join(x.path, '.git')));
        if (co) {
          if (tryGit(co.path, ['merge', '--ff-only', R]) === null) {
            if (remote) warning = `landed on ${remote}, but the local ${e.main} checkout has changes that block a fast-forward; run git pull there`;
            else { tryGit(repo, ['notes', '--ref=canopy', 'remove', R]); return stop(a, 'blocked', [`the ${e.main} checkout at ${co.path} has local changes that block a fast-forward`], { checks: res.checks }); }
          }
        } else if (!gitOk(repo, ['update-ref', `refs/heads/${e.main}`, R, M1])) {
          tryGit(repo, ['notes', '--ref=canopy', 'remove', R]);
          return stop(a, 'blocked', [`${e.main} moved outside Canopy during landing; land again`], { checks: res.checks });
        }
        this.finish(id, wt, branch, C, R, record, a);
        e.store.audit(who, 'land.landed', branch, { id, commit: R.slice(0, 12), approvals: approvers.map((x) => x.user) });
        if (e.out) e.out.emit({ kinds: ['landed'], id, branch, by, files: a.touched, title: `Landed on ${e.main}: ${branch}`,
          lines: [`Purpose: ${task}`, by ? `By: ${by}` : '', ...((a.testsModified || []).length ? [`Tests edited, counts not lower: ${a.testsModified.slice(0, 6).map((f) => fence(f, 100)).join(', ')}`] : []), approvers.length ? `Approved by: ${approvers.map((x) => x.user).join(', ')}` : '', `Commit: ${R.slice(0, 10)}`] });
        return { status: 'landed', id, commit: R, record, warning };
      });
    } finally { this.busy--; }
  }

  finish(id, wt, branch, C, R, record, a) {
    const e = this.e, s = e.store;
    this.save(id, wt, branch, C, R, 'landed', record);
    const reviewed = !!record.approval;
    s.tx(() => {
      for (const w of a.writeSet) {
        s.run('insert or replace into landed_nodes(landing, node, kind) values(?,?,?)', id, w.node, w.kind);
        if (a.taint.length && !reviewed) s.run('insert or replace into tainted_nodes(node, landing) values(?,?)', w.node, id);
        else s.run('delete from tainted_nodes where node=?', w.node);
      }
    });
    // Tell every other worktree whose record touches what just landed, and
    // those that knew the old version from earlier work. Say who and why, so
    // the receiver can decide what to re-read without opening the file.
    const said = a.taint.length ? '' : ` Its purpose: ${fence(record.intent, 100)}.`;
    for (const w of a.writeSet) {
      if (w.kind === 'added' || w.kind === 'format') continue;
      const high = w.kind !== 'body';
      const targets = new Set(s.all(`select worktree from reads where node=? and worktree != ? ${high ? '' : 'and strength=2'}`, w.node, wt).map((r) => r.worktree));
      for (const r of s.all('select worktree from writes where node=? and worktree != ?', w.node, wt)) targets.add(r.worktree);
      for (const r of s.all('select worktree from known where node=? and worktree != ?', w.node, wt)) if (existsSync(r.worktree)) targets.add(r.worktree);
      if (high && nameOf(w.node)) for (const r of s.all('select distinct worktree from refs where name=? and worktree != ?', bare(nameOf(w.node)), wt)) targets.add(r.worktree);
      for (const t of targets) {
        e.notify(t, w.node, e.main + '\u001f' + id, high ? 'high' : 'low', 'landed',
          `${w.node} ${w.kind === 'removed' ? 'was removed' : w.kind === 'signature' ? 'changed its signature' : 'changed'} on ${e.main} (landing ${R.slice(0, 8)}, branch ${fence(branch, 60)}${record.by ? ', by ' + fence(record.by, 40) : ''}).${said} Run \`git merge ${e.main}\` before you build on it.`);
      }
    }
    // New or changed code that just landed may call something another branch is
    // reshaping. That branch's author is the one who has to act, so tell them
    // now, by name and file, not when their own landing is refused.
    const users = new Map();
    for (const w of a.writeSet) if (w.kind !== 'removed' && w.kind !== 'format') users.set(pathOf(w.node), 1);
    for (const m of s.all("select worktree, node, kind from writes where worktree != ? and kind in ('signature','removed') and node like '%#%'", wt)) {
      if (!a.idents.has(bare(nameOf(m.node))) || a.writeSet.some((w) => w.node === m.node)) continue;
      e.notify(m.worktree, m.node, e.main + '\u001fuse:' + id, 'high', 'new-use',
        `Code that uses ${fence(m.node, 160)} just landed on ${e.main} (landing ${R.slice(0, 8)}, branch ${fence(branch, 60)}${a.taint.length ? '' : '; files: ' + [...users.keys()].slice(0, 5).map((f) => fence(f, 100)).join(', ')}). ` +
        `It is written for the form that is on ${e.main}, and you are ${m.kind === 'removed' ? 'removing it' : 'changing its signature'}. ` +
        `Run \`git merge ${e.main}\` and update those uses before you land, or your landing will be refused when the checks run.`);
    }
    e.clearWorktree(wt, true); // the session that took in outside content is still running: its taint stays
    e.refresh();
  }

  pending() {
    const lands = this.e.store.all("select id, branch, worktree, record, ts from landings where status='needs-human' order by ts").map((r) => {
      const x = JSON.parse(r.record);
      return { id: r.id, branch: r.branch, ts: r.ts, intent: x.intent, by: x.by, reasons: x.reasons, coverage: x.coverage, unread: x.unread, taint: x.taint, changed_lines: x.changed_lines, checks: x.checks, write_set: x.write_set, waiting_on: x.waiting_on || [], manager: x.manager, advisories: x.advisories };
    });
    const proms = this.e.store.all("select id, env, record, ts from promotions where status='needs-approval' order by ts").map((r) => {
      const x = JSON.parse(r.record);
      return { id: r.id, branch: `promote to ${r.env}`, ts: r.ts, intent: `promote ${String(x.commit).slice(0, 10)} to ${r.env}`, by: x.by, reasons: x.reasons, coverage: 1, unread: [], taint: [], changed_lines: 0, checks: [], write_set: [], waiting_on: x.waiting_on || [] };
    });
    return [...lands, ...proms];
  }

  isHuman(token) {
    const a = Buffer.from(String(token || '')), b = Buffer.from(this.humanToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  // ---- contracts -------------------------------------------------------

  // The author of a breaking change publishes a test that fails on main's
  // current source. Mechanical: the test runs in the same sandbox as the checks,
  // on main, and only a clean failure (exit code 1) is accepted. A test that
  // passes there proves nothing about the change; one that cannot run proves nothing either.
  async publishContract({ cwd, node, test, who }) {
    const e = this.e, no = (message) => ({ status: 'refused', message });
    const w = worktreeOf(String(cwd || ''));
    if (!w || w.common !== e.common) return { status: 'error', message: 'this directory is not a worktree of the repository canopyd serves' };
    // Same rule as landing: once canopyd has users, the caller must be one of them.
    if (usersExist(e.store) && !(who && who.user)) return { status: 'error', message: 'this canopyd has users, so publishing a contract needs to know who you are. Set CANOPY_TOKEN to the token `canopy user add` printed for you.' };
    node = String(node || ''); test = String(test || '');
    if (!/^[^#\s]+#[^#\s]+$/.test(node)) return no(`name the symbol as '<path>#<symbol>', for example 'src/money.js#toCents'`);
    const row = e.store.get("select kind, sig_old, sig_new, session from writes where worktree=? and node=? and kind in ('signature','removed')", w.top, node);
    if (!row) return no(`this worktree has no recorded change to the signature of ${fence(node, 160)}. Make the change first (run \`canopy checkin\` if your harness has no hooks), then publish.`);
    if (!isBreaking(row.kind, row.sig_old, row.sig_new)) return no(`the change to ${fence(node, 160)} keeps existing calls working, so it needs no contract.`);
    if (!test || !/^[\w./@-]+$/.test(test) || test.startsWith('-') || test.startsWith('/') || test.split('/').includes('..') || test.split('/').includes('.git'))
      return no('--test must be a path inside this worktree, for example test/money.contract.test.js');
    const root = real(w.top), abs = real(join(w.top, test));
    if (!abs.startsWith(root + '/')) return no(`${test} is outside this worktree. Put the test inside it and publish again.`);
    const rel = abs.slice(root.length + 1);
    // The name after links are resolved is what gets stored and put in a command: check it, not only what was typed.
    if (!safeRel(rel)) return no(`${fence(rel, 100)} is not an allowed name. A contract test path may use letters, digits and . / _ - @ only (no spaces, quotes or other characters), after any link is resolved. Rename the file and publish again.`);
    if (!isTestFile(rel) || !/\.(m?js|cjs)$/.test(rel)) return no(`${rel} is not a test file this step can run. Contracts run Node test files: a name such as ${rel.replace(/(\.[a-z]+)?$/, '.test.js')}, in a test folder or ending .test.js.`);
    // Open without following links or blocking, then look at what was opened: a pipe or a huge file must not stall canopyd.
    let bytes, text, fd;
    try { fd = openSync(abs, fsc.O_RDONLY | fsc.O_NONBLOCK | fsc.O_NOFOLLOW); } catch { return no(`${rel} could not be read. Write the test file first.`); }
    try {
      const st = fstatSync(fd);
      if (!st.isFile()) return no(`${rel} is not a regular file. A contract test must be an ordinary file.`);
      if (st.size > 200_000) return no(`${rel} is larger than 200 KB; a contract test should be small.`);
      bytes = Buffer.alloc(st.size);
      let off = 0;
      while (off < st.size) { const k = readSync(fd, bytes, off, st.size - off, off); if (!k) break; off += k; }
      bytes = bytes.subarray(0, off); text = bytes.toString('utf8');
    } finally { closeSync(fd); }
    if (!testStats(text).cases) return no(`${rel} contains no test case (a call to test( or it( ). Write one that pins the new behaviour.`);
    // The contract must be about this symbol: it loads only code that is on main, imports the file that defines
    // the symbol, and names it. (A test that imports a helper only the branch has, or never touches the symbol,
    // fails on main for reasons that say nothing about the change.)
    e.refresh();
    const clean = scrub(text, 'js', true);
    const specs = [...clean.matchAll(/(?:\bfrom\s*|\bimport\s*\(?\s*|\brequire\s*\(\s*)(['"`])(\.{1,2}\/[^'"`\n]*)\1/g)].map((m) => m[2]);
    const onMain = (f) => !f.startsWith('..') && tryGit(e.repo, ['cat-file', '-t', `${e.graph.rev}:${f}`]) === 'blob';
    const resolved = specs.map((sp) => ({ sp, file: posix.normalize(posix.join(dirname(rel), sp)) }));
    const missing = resolved.filter((x) => !onMain(x.file));
    if (missing.length) return no(`${rel} imports ${missing.slice(0, 4).map((x) => fence(x.sp, 80)).join(', ')}, which is not on ${e.main}. A contract test runs against ${e.main}'s source, so it may load only files ${e.main} already has. Put what the test needs in the test file itself, or import only existing files.`);
    const defFile = pathOf(node), nm = bare(nameOf(node));
    if (!resolved.some((x) => x.file === defFile)) return no(`${rel} does not import ${fence(defFile, 100)}, the file that defines ${fence(node, 160)}. Import ${defFile} directly (for example: import { ${nm} } from '<relative path to ${defFile}>') so the test is about this symbol.`);
    if (!new RegExp('(^|[^\\w$])' + nm.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '($|[^\\w$])').test(clean)) return no(`${rel} never uses the symbol's name (${fence(nm, 80)}). Call or inspect ${nm} in the test so it pins this change.`);
    // The id of the exact bytes that will be run, taken from them, not from a second read of the file.
    const blob = createHash('sha1').update(`blob ${bytes.length}\0`).update(bytes).digest('hex');
    // Run it on main's source, in a scratch checkout, in the sandbox.
    e.refresh();
    const rs = e.ruleset;
    let dir;
    try { dir = await this.scratch(e.graph.rev); } catch (err) { return { status: 'error', message: 'could not prepare a checkout of ' + e.main + ' to run the test in: ' + String(err.stderr || err.message).trim().slice(0, 300) }; }
    const tmp = dir + '.tmp';
    let r;
    try {
      rmSync(tmp, { recursive: true, force: true }); mkdirSync(tmp, { recursive: true });
      mkdirSync(join(dir, rel, '..'), { recursive: true });
      // A link in main's tree must not carry the write outside the scratch checkout.
      const target = join(real(join(dir, rel, '..')), basename(rel));
      let link = false; try { link = lstatSync(target).isSymbolicLink(); } catch { /* not there yet */ }
      if (!target.startsWith(real(dir) + '/') || link) return no(`${rel} would follow a link in ${e.main} out of the scratch checkout. Use a different file name or folder.`);
      writeFileSync(target, bytes);
      r = await run(testCommand(rel, true), dir, { home: this.home, common: e.common, network: rs.network, dir, tmp, port: this.port, keep: 400_000 }, rs.checkTimeoutMs);
    } finally { this.release(dir); }
    if (r.code === 0) return no(`${rel} PASSES on ${e.main}'s current source, so it does not show that anything changed. A contract test must fail on the old code and pass on yours: assert the new behaviour (for example, that the new signature works and the old form is refused), run it on ${e.main} to see it fail, then publish again.`);
    // Exit 1 with a failed test case. A file that could not be loaded (import, syntax, a throw at the top)
    // is reported as a failure of the file itself, which is not a contract; when that cannot be told, refuse.
    const failed = [...r.tail.matchAll(/^\s*not ok \d+ - (.*)$/gm)].map((m) => m[1].trim());
    const fileLevel = (n) => n === rel || n === basename(rel) || n.endsWith('/' + basename(rel));
    if (r.code === 1 && !/timed out/.test(r.tail) && !failed.some((n) => !fileLevel(n))) return no(`${rel} did not fail by a test on ${e.main}: it failed to load or run (an import, syntax or top-level error), which says nothing about the change (${fence(r.tail.slice(-300), 300)}). A contract test must load, run its test cases on ${e.main}, and fail an assertion there.`);
    if (r.code !== 1 || /timed out/.test(r.tail)) return no(`${rel} could not be run to a clean result on ${e.main} (exit ${r.code}): ${fence(r.tail.slice(-300), 300)} Fix the test so it runs and fails by an assertion on the old code.`);
    const m = /(^|\n)\s*(?:test|it)\s*\(/.exec(text);
    const excerpt = text.slice(m ? m.index + m[1].length : 0).replace(/\s+/g, ' ').trim().slice(0, 400);
    const sig = row.kind === 'removed' ? '' : row.sig_new;
    const branch = branchOf(w.gitdir);
    e.store.run('insert or replace into contracts(node, worktree, branch, kind, sig_old, sig, test_path, test_blob, excerpt, session, ts) values(?,?,?,?,?,?,?,?,?,?,?)',
      node, w.top, branch, row.kind, row.sig_old, sig, rel, blob, excerpt, row.session || '', Date.now());
    e.store.event('contract', { wt: e.wtName(w.top), branch, node, test: rel });
    e.store.audit(who, 'contract.publish', node, { branch, test: rel });
    e.announceContract(e.contractOf(node, w.top));
    return { status: 'accepted', node, test: rel, message: `contract accepted: ${rel} fails on ${e.main} (exit 1). It will also have to pass on the merge commit when you land. Other agents that use ${fence(node, 160)} are being shown it.` };
  }

  contracts() {
    return this.e.store.all('select node, branch, kind, sig_old, sig, test_path, ts from contracts order by ts desc');
  }

  async approve(id, { who, token, by } = {}) {
    const s = this.e.store, strict = usersExist(s);
    if (String(id).startsWith('env-')) return this.approvePromotion(id, who);
    const row = s.get("select * from landings where id=? and status='needs-human'", id);
    if (!row) return { status: 'error', message: 'no landing with that id is waiting for a human' };
    const rec = JSON.parse(row.record);
    if (!existsSync(row.worktree)) return { status: 'error', message: 'the worktree for that landing is gone' };
    let approver;
    if (strict) {
      // With users, only a named person can approve, and only where the rules give them a say.
      if (!who || !who.user) return { status: 'error', message: 'approval needs your own token (CANOPY_TOKEN). The shared human token stops working once users exist.' };
      // The landing goes in under the name of whoever asked for it; they must still be a user.
      if (rec.by && !activeUsers(s).has(rec.by)) return { status: 'error', message: `${rec.by}, who asked for this landing, is no longer an active user. Someone else has to run \`canopy land\` on that branch.` };
      const open = (rec.waiting_on || []).filter((q) => q.owners.includes(who.user) && !(q.have || []).includes(who.user));
      if (who.user === rec.by && !open.some((q) => q.kind !== 'person')) return { status: 'error', message: `${who.user} is the one landing this change; someone else has to approve it` };
      if (!open.length) { s.audit(who, 'approve.denied', id, {});
        if (this.e.out) this.e.out.emit({ kinds: ['security'], id, branch: row.branch, by: who.user, title: `Approval refused: ${who.user} has no say over ${row.branch}`, lines: [`Landing: ${id}`] }); return { status: 'error', message: `${who.user} has no say over this landing. It is waiting on: ${(rec.waiting_on || []).map((q) => `${q.kind === 'person' ? 'a person' : q.section || 'the whole repository'} (${q.owners.join(', ') || 'no one eligible'})`).join('; ')}` }; }
      approver = who.user;
    } else {
      if (!this.isHuman(token)) return { status: 'error', message: 'approval needs the human token' };
      approver = 'human:' + String(by || 'human').replace(/[^\x20-\x7e]/g, '').slice(0, 60);
    }
    s.run('insert or replace into approvals(landing, user, commit_sha, rules_hash, basis, ts) values(?,?,?,?,?,?)', id, approver, row.commit_sha, rec.rules_hash, rec.basis || '', Date.now());
    s.audit(who, 'approve', id, { branch: row.branch, commit: row.commit_sha.slice(0, 12), as: approver });
    const r = await this.land({ cwd: row.worktree, intent: rec.intent, who: { user: rec.by || '', ip: (who && who.ip) || '' }, approvedId: id });
    // An approval that could not be acted on (the worktree was not in a state to
    // land) is not kept for later: whoever gave it saw the landing as it was then.
    if (r.status === 'error') s.run('delete from approvals where landing=? and user=?', id, approver);
    return r;
  }

  // ---- environments ----------------------------------------------------

  // Move an environment branch forward to a commit already on the stage before
  // it. Like a landing, the move is checked, signed and, on the canonical
  // repository, refused by any other route.
  async promote({ env, commit, who }) {
    const e = this.e, repo = e.repo, s = e.store;
    e.refresh();
    const rs = e.ruleset;
    if (rs.error) return { status: 'error', message: rs.error };
    const cfg = rs.environments.find((x) => x.name === env);
    if (!cfg) return { status: 'error', message: rs.environments.length ? `no environment named ${env}. Defined: ${rs.environments.map((x) => x.name).join(', ')}` : 'the rules on ' + e.main + ' define no environments' };
    const by = (who && who.user) || '';
    if ((usersExist(s) || cfg.promoters || cfg.approvers) && !by) return { status: 'error', message: 'promoting needs to know who you are. Set CANOPY_TOKEN to your token.' };
    if (cfg.promoters && !cfg.promoters.includes(by)) { s.audit(who, 'promote.denied', env, {});
      if (e.out) e.out.emit({ kinds: ['security'], branch: cfg.branch, by, title: `Promotion refused: ${by} may not promote to ${env}`, lines: [`Allowed: ${cfg.promoters.join(', ')}`] }); return { status: 'error', message: `${by} may not promote to ${env}. The rules allow: ${cfg.promoters.join(', ')}` }; }
    const from = cfg.from || e.main;
    const rev = (r) => tryGit(repo, ['rev-parse', '--verify', '--quiet', r + '^{commit}']);
    const fromTip = rev('refs/heads/' + from);
    if (!fromTip) return { status: 'error', message: `the branch ${from}, which ${env} is promoted from, does not exist` };
    const target = commit ? rev(commit) : fromTip;
    if (!target) return { status: 'error', message: `no commit ${commit}` };
    // Not merely reachable from the stage before: one of the states it has actually been in.
    if (!(tryGit(repo, ['rev-list', '--first-parent', fromTip]) || '').split('\n').includes(target)) return { status: 'error', message: `only commits already on ${from}, as a state ${from} has been in, can be promoted to ${env}` };
    const ref = 'refs/heads/' + cfg.branch, prev = rev(ref);
    if (prev === target) return { status: 'nothing', message: `${env} is already at ${target.slice(0, 10)}` };
    if (prev && !gitOk(repo, ['merge-base', '--is-ancestor', prev, target])) return { status: 'error', message: `${env} is at ${prev.slice(0, 10)}, which is not behind ${target.slice(0, 10)}. An environment only moves forward.` };
    const id = `env-${env}-${target.slice(0, 10)}`;
    const base = { v: 1, kind: 'promotion', id, env, branch: cfg.branch, from, commit: target, previous: prev || null, by: by || undefined, rules_hash: rs.hash };
    const park = (status, reasons, extra = {}) => {
      const record = { ...base, reasons, ...extra };
      s.run('insert into promotions(id, env, commit_sha, status, record, ts) values(?,?,?,?,?,?) on conflict(id) do update set status=excluded.status, record=excluded.record, ts=excluded.ts', id, env, target, status, JSON.stringify(record), Date.now());
      s.event('promotion', { id, env, status, commit: target.slice(0, 10), by });
      s.audit(who, 'promote.' + status, env, { id, commit: target.slice(0, 12), reasons });
      if (e.out) e.out.emit({ kinds: [status === 'needs-approval' ? 'approval' : 'blocked'], id, branch: cfg.branch, by, once: `${status}|${id}|${reasons.join('|')}`,
        title: status === 'needs-approval' ? `Approval needed: promote to ${env}` : `Promotion to ${env} refused`,
        lines: [`Commit: ${target.slice(0, 10)}`, by ? `Asked for by: ${by}` : '', ...reasons.map((r) => `- ${r}`), ...(status === 'needs-approval' ? [`To approve: canopy approve ${id}`] : [])] });
      return { status: status === 'needs-approval' ? 'needs-human' : status, id, reasons, record };
    };
    const active = activeUsers(s);
    const rows = s.all('select user, ts from approvals where landing=? and commit_sha=? and rules_hash=? order by ts', id, target, rs.hash).filter((r) => active.has(r.user) && (cfg.approvers || []).includes(r.user));
    if (cfg.approvals) {
      const have = cfg.approvers.filter((u) => active.has(u) && (u === by || rows.some((r) => r.user === u)));
      if (have.length < cfg.approvals) return park('needs-approval', [`promotion to ${env} needs ${cfg.approvals - have.length} more approval${cfg.approvals - have.length > 1 ? 's' : ''} from: ${cfg.approvers.join(', ')}`], { waiting_on: [{ section: env, owners: cfg.approvers, need: cfg.approvals, have, why: 'approves promotions to this environment' }] });
    }
    const res = await this.runChecks(target, { checks: cfg.checks, perf: [] }, rs);
    if (res.failed) return park('blocked', [res.failed], { checks: res.checks });
    return this.serial(async () => {
      if (rev(ref) !== prev) return park('blocked', [`${cfg.branch} moved while this promotion was being checked; promote again`]);
      const record = { ...base, verdict: 'promote', approvals: rows.map((r) => ({ user: r.user, ts: r.ts })), checks: res.checks, sandbox: res.sandbox, events_head: s.eventsHead(), ts: Date.now() };
      const notes = 'canopy-env-' + env;
      const noteFile = join(this.home, `note-${id}.json`);
      writeFileSync(noteFile, signRecord(record, this.key));
      try { git(repo, ['notes', '--ref=' + notes, 'add', '-f', '-F', noteFile, target]); } finally { rmSync(noteFile, { force: true }); }
      const undo = () => tryGit(repo, ['notes', '--ref=' + notes, 'remove', target]);
      const remote = tryGit(repo, ['config', '--get', 'canopy.push']);
      if (remote && tryGit(repo, ['push', '--atomic', remote, `${target}:${ref}`, `refs/notes/${notes}:refs/notes/${notes}`]) === null) { undo(); return park('blocked', ['the canonical repository refused the promotion']); }
      const co = worktrees(repo).find((x) => x.branch === cfg.branch && x.path && existsSync(join(x.path, '.git')));
      const moved = co ? tryGit(co.path, ['merge', '--ff-only', target]) !== null : gitOk(repo, ['update-ref', ref, target, prev || '0'.repeat(40)]);
      if (!moved && !remote) { undo(); return park('blocked', [`could not move ${cfg.branch} forward locally`]); }
      s.run('insert into promotions(id, env, commit_sha, status, record, ts) values(?,?,?,?,?,?) on conflict(id) do update set status=excluded.status, record=excluded.record, ts=excluded.ts', id, env, target, 'promoted', JSON.stringify(record), Date.now());
      s.event('promotion', { id, env, status: 'promoted', commit: target.slice(0, 10), by });
      s.audit(who, 'promote.promoted', env, { id, commit: target.slice(0, 12), approvals: rows.map((r) => r.user) });
      if (e.out) e.out.emit({ kinds: ['promotion'], id, branch: cfg.branch, by, title: `Promoted to ${env}`, lines: [`Commit: ${target.slice(0, 10)}`, by ? `By: ${by}` : '', rows.length ? `Approved by: ${rows.map((r) => r.user).join(', ')}` : ''] });
      return { status: 'promoted', id, env, commit: target, record };
    });
  }

  async approvePromotion(id, who) {
    const s = this.e.store;
    const row = s.get("select * from promotions where id=? and status='needs-approval'", id);
    if (!row) return { status: 'error', message: 'no promotion with that id is waiting for approval' };
    const rec = JSON.parse(row.record);
    if (!who || !who.user) return { status: 'error', message: 'approving a promotion needs your own token (CANOPY_TOKEN)' };
    if (rec.by && !activeUsers(s).has(rec.by)) return { status: 'error', message: `${rec.by}, who asked for this promotion, is no longer an active user. Someone else has to run \`canopy promote ${row.env}\`.` };
    const q = (rec.waiting_on || [])[0];
    if (!q || !q.owners.includes(who.user)) { s.audit(who, 'approve.denied', id, {}); return { status: 'error', message: `${who.user} may not approve promotions to ${row.env}` }; }
    s.run("insert or replace into approvals(landing, user, commit_sha, rules_hash, basis, ts) values(?,?,?,?,'',?)", id, who.user, row.commit_sha, rec.rules_hash, Date.now());
    s.audit(who, 'approve', id, { env: row.env, commit: row.commit_sha.slice(0, 12) });
    return this.promote({ env: row.env, commit: row.commit_sha, who: { user: rec.by || '', ip: who.ip } });
  }

  // The manager's written reasons, for the people who decide on a landing and
  // nobody else: administrators and those it is waiting on, or, with no users,
  // whoever holds the approval token.
  concerns(id, { who, local } = {}) {
    const s = this.e.store;
    const row = s.get('select worktree, record from landings where id=?', id), notes = s.get('select summary, findings from manager_notes where landing=?', id);
    if (!row || !notes) return { status: 'error', message: 'no manager notes are kept for that landing' };
    const rec = JSON.parse(row.record);
    if (!local) {
      // Without users there is nobody the API could tell apart from the requester:
      // the notes are read on the Canopy host itself.
      if (!usersExist(s)) return { status: 'host-only', message: 'with no users, the manager\'s written reasons are read on the Canopy host: run `canopy concerns` there' };
      const u = who && who.user;
      const open = (rec.waiting_on || []).some((q) => q.owners.includes(u) && !(q.have || []).includes(u));
      const involved = u === rec.by || (rec.authors || []).some((x) => x.user === u);
      if (!u || involved || !(who.role === 'admin' || open)) { s.audit(who, 'concerns.denied', id, {}); return { status: 'error', message: 'the manager\'s written reasons are shown only to administrators and to people whose approval this landing is waiting on, never to the person who asked for it or wrote it' }; }
    }
    s.audit(local ? { user: 'operator' } : who, 'concerns.read', id, {});
    return { status: 'ok', verdict: rec.manager && rec.manager.verdict, summary: notes.summary, findings: JSON.parse(notes.findings || '[]') };
  }

  environments() {
    const e = this.e;
    return e.ruleset.environments.map((x) => {
      const tip = tryGit(e.repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + x.branch]);
      const fromTip = tryGit(e.repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + (x.from || e.main)]);
      const behind = tip && fromTip ? Number(tryGit(e.repo, ['rev-list', '--count', '--first-parent', `${tip}..${fromTip}`]) || 0) : null;
      return { name: x.name, branch: x.branch, from: x.from || e.main, at: tip, behind, promoters: x.promoters, approvers: x.approvers, approvals: x.approvals, checks: x.checks };
    });
  }
}

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
import { existsSync, mkdirSync, writeFileSync, readFileSync, realpathSync, rmSync } from 'node:fs';
import { join, basename } from 'node:path';
import { randomBytes, timingSafeEqual } from 'node:crypto';
import { homedir, tmpdir, platform } from 'node:os';
import { extract } from './extract.mjs';
import { nodeId, pathOf, nameOf, bare, diffSymbols } from './graph.mjs';
import { git, tryGit, gitOk, worktreeOf, branchOf, showFile, mergeTree, commitTree, worktrees } from './git.mjs';
import { resolveAll, isTestFile, loadRules } from './rules.mjs';
import { signRecord } from './sign.mjs';
import { fence } from './engine.mjs';

const real = (p) => { try { return realpathSync(p); } catch { return p; } };

// Wrap a check command so branch code cannot read the signing key, the
// database or common credential stores; cannot write anywhere except its own
// checkout, its own temp directory, Git's object store and package caches;
// cannot move refs or install hooks; cannot talk to canopyd; and has no
// outside network.
export function sandbox(cmd, { home, common, network, dir, tmp, port }) {
  if (platform() === 'darwin' && existsSync('/usr/bin/sandbox-exec')) {
    const H = real(homedir()), K = real(home), G = real(common);
    const q = (p) => JSON.stringify(p);
    const sub = (...ps) => ps.map((p) => `(subpath ${q(p)})`).join(' ');
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
    const add = (d) => { tail = (tail + d.toString('utf8')).slice(-3000); };
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
    const tp = join(home, 'human.token');
    if (!existsSync(tp)) writeFileSync(tp, randomBytes(16).toString('hex') + '\n', { mode: 0o600 });
    this.humanToken = readFileSync(tp, 'utf8').trim();
  }

  serial(fn) { const p = this.chain.then(fn, fn); this.chain = p.catch(() => {}); return p; }

  // ---- analysis --------------------------------------------------------

  analyze(wt, C, M) {
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
    const testReductions = [];
    // -z: paths arrive as they are, whatever characters they contain.
    for (const l of git(repo, ['diff', '--numstat', '-z', '--no-renames', mb, C]).split('\0')) {
      const [a, d, ...rest] = l.split('\t');
      const p = rest.join('\t');
      if (!p) continue;
      changedLines += (Number(a) || 0) + (Number(d) || 0);
      if (isTestFile(p) && Number(d) > 0 && gitOk(repo, ['cat-file', '-e', `${mb}:${p}`])) testReductions.push(p);
    }
    const touched = new Set();
    const writeSet = [];
    const idents = new Set(); // identifiers used by the code this branch changed, taken from the diff itself
    const add = (node, kind) => writeSet.push({ node, kind });
    for (const en of entries) {
      touched.add(en.path); touched.add(en.old);
      const moved = en.st === 'R' && en.old !== en.path;
      const oldText = en.st === 'A' || en.st === 'C' ? null : showFile(repo, mb, en.old);
      const newText = en.st === 'D' ? null : showFile(repo, C, en.path);
      const exOld = oldText === null ? null : extract(en.old, oldText);
      const exNew = newText === null ? null : extract(en.path, newText);
      if (moved) {
        for (const ch of diffSymbols(exOld, null)) add(nodeId(en.old, ch.name), 'removed');
        for (const ch of diffSymbols(null, exNew)) add(nodeId(en.path, ch.name), 'added');
        add(en.old, 'removed'); add(en.path, 'added');
        continue;
      }
      const before = writeSet.length;
      const chs = diffSymbols(exOld, exNew);
      for (const ch of chs) add(nodeId(en.path, ch.name), ch.kind);
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
    const unwitnessed = entries.map((en) => en.path).filter((p) => !witnessed.has(p));
    const taint = e.store.all('select source from taint where worktree=?', wt).map((r) => r.source);
    if (unwitnessed.length) taint.push('unwitnessed-writes');
    // Rules come from main. A branch that changes the rules file must leave a
    // valid one behind. If main's own rules are broken, the only thing that can
    // land is a repair, judged by the repaired rules and approved by a person.
    let rs = e.ruleset;
    const blocked = [], human = [];
    if (touched.has('.canopy/rules.json')) {
      const cand = loadRules(repo, C);
      if (cand.error) blocked.push('this branch would leave the rules file broken: ' + cand.error);
      else if (rs.error) { rs = cand; human.push(`the rules on ${e.main} are invalid and this landing repairs them`); }
    }
    if (rs.error) blocked.push(rs.error + `. Nothing can land until a change that repairs .canopy/rules.json lands; that change needs a person.`);
    // Tests may not cover a call the branch just wrote. If main changed the thing
    // being called since the branch forked, the branch has to look at it first.
    const used = stale.filter((x) => x.uses);
    if (used.length) blocked.push(`${e.main} changed since this branch forked, and code this branch changed uses what changed: ${used.slice(0, 6).map((x) => `${x.node} [${x.kind}, landing ${x.landed}]`).join(', ')}. Run \`git merge ${e.main}\`, check those uses, commit, and land again.`);
    const plan = resolveAll(rs, [...touched].filter(Boolean));
    const coverage = blast.size ? covered / blast.size : 1;
    if (plan.protectedFiles.length) human.push(`protected files changed: ${plan.protectedFiles.slice(0, 8).join(', ')}`);
    if (taint.length && (plan.noTaintedFiles.length || plan.protectedFiles.length)) human.push(`the branch took in outside content (${taint.slice(0, 5).join(', ')}) and changes a section that does not accept that without review`);
    if (testReductions.length) human.push(`existing tests were removed or reduced: ${testReductions.slice(0, 8).join(', ')}`);
    if (coverage < plan.min_coverage) human.push(`inspection coverage ${Math.round(coverage * 100)}% is below the ${Math.round(plan.min_coverage * 100)}% this section requires`);
    if (changedLines > plan.max_changed_lines) human.push(`${changedLines} changed lines exceeds the section limit of ${plan.max_changed_lines}`);
    if (unwitnessed.length && plan.no_unwitnessed) human.push(`files changed with no recorded agent activity: ${unwitnessed.slice(0, 8).join(', ')}`);
    return { mb, entries, touched: [...touched].filter(Boolean), writeSet, blast: [...blast], unread, coverage, stale, unwitnessed, taint, plan, changedLines, testReductions, blocked, human, rulesHash: rs.hash, rs, idents };
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

  async land({ cwd, approval, intent }) {
    const e = this.e, repo = e.repo;
    const w = worktreeOf(cwd);
    if (!w || w.common !== e.common) return { status: 'error', message: 'this directory is not a worktree of the repository canopyd serves' };
    const wt = w.top, branch = branchOf(w.gitdir);
    if (branch === e.main) return { status: 'error', message: `you are on ${e.main}; land from a branch` };
    const dirty = git(wt, ['status', '--porcelain', '--untracked-files=no']);
    if (dirty) return { status: 'error', message: 'commit your work first; uncommitted changes:\n' + dirty.split('\n').slice(0, 10).join('\n') };
    const C = git(wt, ['rev-parse', 'HEAD']);
    e.refresh();
    const M0 = e.graph.rev;
    if (gitOk(repo, ['merge-base', '--is-ancestor', C, M0])) return { status: 'nothing', message: 'this branch is already on ' + e.main };
    const sessions = e.store.all('select short, agent, model, task from sessions where worktree=? order by seen desc limit 8', wt);
    const task = (intent || (sessions.find((x) => x.task) || {}).task || git(repo, ['log', '-1', '--format=%s', C])).replace(/\s+/g, ' ').slice(0, 200);
    const prior = e.store.get("select id from landings where worktree=? and commit_sha=? and status='needs-human'", wt, C);
    const id = prior ? prior.id : randomBytes(4).toString('hex');
    const msg = `Land ${branch}: ${task}\n\nCanopy-Landing: ${id}`;

    const draft = (a, extra = {}) => ({
      v: 1, id, candidate: C, branch, worktree: basename(wt), intent: task,
      sessions: sessions.map((x) => ({ id: x.short, agent: x.agent, model: x.model })),
      write_set: a.writeSet, blast: a.blast.length, coverage: Math.round(a.coverage * 1000) / 1000, unread: a.unread.slice(0, 60),
      unwitnessed: a.unwitnessed, taint: a.taint, stale_assumptions: a.stale, changed_lines: a.changedLines, test_reductions: a.testReductions,
      rules_hash: a.rulesHash, trust: 'hook-reported', ...extra,
    });
    const stop = (a, status, reasons, extra) => {
      const record = draft(a, { reasons, ...extra });
      this.save(id, wt, branch, C, '', status, record);
      return { status, id, reasons, record };
    };
    const okApproval = (a) => approval && approval.commit === C && approval.rules_hash === a.rulesHash && approval.id === id;

    let a = this.analyze(wt, C, M0);
    if (a.blocked.length) return stop(a, 'blocked', a.blocked);
    let m = mergeTree(repo, M0, C);
    if (m.conflicts) return stop(a, 'blocked', [`does not merge cleanly with ${e.main}: ${m.conflicts.slice(0, 8).join(', ')}. Run \`git merge ${e.main}\`, resolve, commit, and land again.`]);
    const needHuman = (x) => x.human.length && !okApproval(x);
    const human = (x, r) => stop(x, 'needs-human', x.human, { checks: r.checks, perf: r.perf, sandbox: r.sandbox,
      note: approval ? 'the branch or the rules changed after approval was given; approval must be given again' : undefined });
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
            a = this.analyze(wt, C, M1);
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
          if (needHuman(a)) return human(a, res);
        }
        const record = draft(a, {
          commit: R, base: M1, parents: [M1, C], tree: git(repo, ['rev-parse', R + '^{tree}']), verdict: 'land',
          checks: res.checks, perf: res.perf, sandbox: res.sandbox, revalidated, approval: okApproval(a) ? approval : undefined,
          reasons: okApproval(a) ? a.human : [], events_head: e.store.eventsHead(), ts: Date.now(),
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
    // Tell every other worktree whose record touches what just landed.
    for (const w of a.writeSet) {
      if (w.kind === 'added' || w.kind === 'format') continue;
      const high = w.kind !== 'body';
      const targets = new Set(s.all(`select worktree from reads where node=? and worktree != ? ${high ? '' : 'and strength=2'}`, w.node, wt).map((r) => r.worktree));
      for (const r of s.all('select worktree from writes where node=? and worktree != ?', w.node, wt)) targets.add(r.worktree);
      if (high && nameOf(w.node)) for (const r of s.all('select distinct worktree from refs where name=? and worktree != ?', bare(nameOf(w.node)), wt)) targets.add(r.worktree);
      for (const t of targets) {
        e.notify(t, w.node, e.main + '\u001f' + id, high ? 'high' : 'low', 'landed',
          `${w.node} ${w.kind === 'removed' ? 'was removed' : w.kind === 'signature' ? 'changed its signature' : 'changed'} on ${e.main} (landing ${R.slice(0, 8)}, branch ${fence(branch, 60)}). Run \`git merge ${e.main}\` before you build on it.`);
      }
    }
    e.clearWorktree(wt, true); // the session that took in outside content is still running: its taint stays
    e.refresh();
  }

  pending() {
    return this.e.store.all("select id, branch, worktree, record, ts from landings where status='needs-human' order by ts").map((r) => {
      const x = JSON.parse(r.record);
      return { id: r.id, branch: r.branch, ts: r.ts, intent: x.intent, reasons: x.reasons, coverage: x.coverage, unread: x.unread, taint: x.taint, changed_lines: x.changed_lines, checks: x.checks, write_set: x.write_set };
    });
  }

  isHuman(token) {
    const a = Buffer.from(String(token || '')), b = Buffer.from(this.humanToken);
    return a.length === b.length && timingSafeEqual(a, b);
  }

  async approve(id, token, by) {
    if (!this.isHuman(token)) return { status: 'error', message: 'approval needs the human token' };
    const row = this.e.store.get("select * from landings where id=? and status='needs-human'", id);
    if (!row) return { status: 'error', message: 'no landing with that id is waiting for a human' };
    const rec = JSON.parse(row.record);
    if (!existsSync(row.worktree)) return { status: 'error', message: 'the worktree for that landing is gone' };
    return this.land({ cwd: row.worktree, intent: rec.intent, approval: { id, by: String(by || 'human').slice(0, 60), ts: Date.now(), commit: row.commit_sha, rules_hash: rec.rules_hash, reasons: rec.reasons } });
  }
}

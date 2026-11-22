// Thin Git helpers. Everything Canopy knows about history comes through here.
import { execFileSync, execFile } from 'node:child_process';
import { readFileSync, existsSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { join, isAbsolute } from 'node:path';

const BASE = { encoding: 'utf8', maxBuffer: 1 << 30, stdio: ['pipe', 'pipe', 'pipe'] };

export function git(cwd, args, opts = {}) {
  return execFileSync('git', args, { ...BASE, cwd, ...opts }).replace(/\n$/, '');
}
export function tryGit(cwd, args, opts = {}) {
  try { return git(cwd, args, opts); } catch { return null; }
}
export function gitOk(cwd, args) {
  try { execFileSync('git', args, { ...BASE, cwd }); return true; } catch { return false; }
}
export function gitAsync(cwd, args) {
  return new Promise((res) => execFile('git', args, { ...BASE, cwd }, (err, out) => res(err ? null : out.replace(/\n$/, ''))));
}

export const ZERO = '0'.repeat(40);
export const blobOid = (text) => {
  const b = Buffer.from(text, 'utf8');
  return createHash('sha1').update(`blob ${b.length}\0`).update(b).digest('hex');
};

const topCache = new Map();
// Worktree root for a directory, or null when the directory is not in a Git repo.
// Cached briefly: directories are created, removed and re-used as worktrees.
export function worktreeOf(dir) {
  const hit = topCache.get(dir);
  if (hit && Date.now() - hit.t < (hit.v ? 60_000 : 3_000) && (!hit.v || existsSync(hit.v.gitdir))) return hit.v;
  const out = dir && existsSync(dir) ? tryGit(dir, ['rev-parse', '--path-format=absolute', '--show-toplevel', '--git-common-dir', '--absolute-git-dir']) : null;
  const v = out ? (([top, common, gitdir]) => ({ top, common, gitdir }))(out.split('\n')) : null;
  if (topCache.size > 2000) topCache.clear();
  topCache.set(dir, { v, t: Date.now() });
  return v;
}

// Current branch of a worktree, read straight from its HEAD file (no process spawn).
export function branchOf(gitdir) {
  try {
    const head = readFileSync(join(gitdir, 'HEAD'), 'utf8').trim();
    return head.startsWith('ref: refs/heads/') ? head.slice(16) : 'detached@' + head.slice(0, 8);
  } catch { return 'unknown'; }
}

export function mainRef(repo) {
  const cfg = tryGit(repo, ['config', '--get', 'canopy.main']);
  if (cfg) return cfg;
  for (const b of ['main', 'master']) if (gitOk(repo, ['rev-parse', '--verify', '--quiet', 'refs/heads/' + b])) return b;
  return 'main';
}

// [{path, oid}] for every regular file at a ref.
export function lsTree(repo, ref) {
  const out = tryGit(repo, ['ls-tree', '-r', '-z', ref]);
  if (!out) return [];
  const res = [];
  for (const rec of out.split('\0')) {
    if (!rec) continue;
    const tab = rec.indexOf('\t');
    const [mode, type, oid] = rec.slice(0, tab).split(' ');
    if (type === 'blob' && mode !== '120000') res.push({ path: rec.slice(tab + 1), oid });
  }
  return res;
}

// Read many blobs with one process. Returns Map oid -> utf8 text.
export function catBlobs(repo, oids) {
  const out = new Map();
  if (!oids.length) return out;
  const buf = execFileSync('git', ['cat-file', '--batch'], { cwd: repo, input: oids.join('\n') + '\n', maxBuffer: 1 << 30 });
  let p = 0;
  while (p < buf.length) {
    const nl = buf.indexOf(10, p);
    if (nl < 0) break;
    const [oid, type, size] = buf.toString('utf8', p, nl).split(' ');
    if (type === 'missing' || size === undefined) { p = nl + 1; continue; }
    const n = Number(size);
    out.set(oid, buf.toString('utf8', nl + 1, nl + 1 + n));
    p = nl + 1 + n + 1;
  }
  return out;
}

// Exact content of a file at a revision, or null when it does not exist there.
export function showFile(repo, ref, path) {
  try { return execFileSync('git', ['show', `${ref}:${path}`], { ...BASE, cwd: repo }); } catch { return null; }
}

// Merge `theirs` into `ours` without touching any working tree.
// Returns { tree } on a clean merge or { conflicts: [paths] }.
export function mergeTree(repo, ours, theirs) {
  try {
    const out = execFileSync('git', ['merge-tree', '--write-tree', '--name-only', ours, theirs], { ...BASE, cwd: repo });
    return { tree: out.split('\n')[0] };
  } catch (e) {
    const lines = String(e.stdout || '').split('\n');
    const conflicts = [];
    for (let i = 1; i < lines.length && lines[i] !== ''; i++) conflicts.push(lines[i]);
    return { conflicts: conflicts.length ? conflicts : ['(unknown)'] };
  }
}

export function commitTree(repo, tree, parents, message) {
  const args = ['-c', 'user.name=canopy', '-c', 'user.email=canopy@localhost', 'commit-tree', tree];
  for (const p of parents) args.push('-p', p);
  args.push('-m', message);
  return git(repo, args);
}

export function worktrees(repo) {
  const out = tryGit(repo, ['worktree', 'list', '--porcelain']) || '';
  return out.split('\n\n').filter(Boolean).map((blk) => {
    const o = {};
    for (const l of blk.split('\n')) {
      const sp = l.indexOf(' ');
      if (sp < 0) o[l] = true; else o[l.slice(0, sp)] = l.slice(sp + 1);
    }
    return { path: o.worktree, head: o.HEAD, branch: o.branch ? o.branch.replace('refs/heads/', '') : null };
  });
}

export const abs = (root, p) => (isAbsolute(p) ? p : join(root, p));
export const exists = existsSync;

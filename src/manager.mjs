// The manager: a second, independent look at a landing by a model of the
// team's choosing. Canopy calls no model itself. It hands a dossier to the
// command named in the rules on main and reads one JSON verdict back.
//
// The manager is contained, not trusted: it runs in an empty directory inside
// a sandbox that cannot read canopyd's secrets, and what it writes is kept
// for the people who decide, not sent back to whoever asked for the landing.
//
// The manager can only tighten. "block" refuses the landing, "concern" sends
// it to a person, and anything else, including no answer or nonsense, never
// turns a refusal into a landing. Its input is untrusted code, so adapters run
// the model without tools.
import { spawn } from 'node:child_process';
import { homedir, tmpdir } from 'node:os';
import { mkdtempSync, mkdirSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tryGit } from './git.mjs';

const clean = (s, n) => String(s || '').replace(/[^\x20-\x7e\n]/g, ' ').slice(0, n);

export function dossier(e, a, { C, branch, intent, by, sessions }) {
  const diff = tryGit(e.repo, ['diff', '--no-color', '-U3', a.mb, C]) || '';
  const sections = new Map();
  for (const f of a.touched) for (const line of e.describeRules(f)) sections.set(line, 1);
  return {
    v: 1, repo_main: e.main, branch, commit: C, base: a.mb, intent, landed_by: by || null,
    authors: sessions,
    write_set: a.writeSet.slice(0, 300), affected: a.blast.length, affected_not_read: a.unread.slice(0, 80), inspection_coverage: Math.round(a.coverage * 1000) / 1000,
    stale_assumptions: a.stale, unwitnessed_files: a.unwitnessed, outside_content: a.taint, test_reductions: a.testReductions,
    advisories: a.advisories || [], rules: [...sections.keys()].slice(0, 40), reasons_already_raised: a.human,
    history: a.touched.slice(0, 12).flatMap((f) => e.why(f).slice(0, 2).map((h) => ({ file: f, intent: h.intent, commit: h.commit }))),
    diff: diff.slice(0, 120_000), diff_truncated: diff.length > 120_000,
  };
}

// -> { verdict: 'pass' | 'concern' | 'block' | 'error', summary, findings, model, ms }
export function runManager(cfg, input, wrap) {
  return new Promise((resolve) => {
    const t0 = performance.now();
    // `safe` is Canopy's own account of what went wrong; `detail` may contain the manager's output and stays in the notes.
    const fail = (safe, detail = '') => resolve({ verdict: 'error', safe, summary: safe + (detail ? ': ' + detail : ''), findings: [], ms: Math.round(performance.now() - t0) });
    const env = { PATH: process.env.PATH, HOME: homedir(), LANG: process.env.LANG || 'C.UTF-8' };
    const setEnv = (dir) => { env.TMPDIR = join(dir, 'tmp'); mkdirSync(env.TMPDIR, { recursive: true }); };
    let child, cwd;
    // Never in the repository: the adapter and the model get the dossier, not a checkout.
    try { cwd = mkdtempSync(join(tmpdir(), 'canopy-manager-')); } catch (err) { return fail('could not make a working directory for the manager: ' + err.message); }
    // Its temp files go inside its own directory too: that is the only place it may write.
    try { setEnv(cwd); } catch { /* it will fall back to the system temp directory and be refused there */ }
    const tidy = () => { try { rmSync(cwd, { recursive: true, force: true }); } catch { /* left for the system to clear */ } };
    // Model credentials and settings reach the adapter only under these names.
    for (const [k, v] of Object.entries(process.env)) if (/^(CANOPY_MANAGER_|ANTHROPIC_|OPENAI_|CLAUDE_|CODEX_)/.test(k)) env[k] = v;
    // In a sandbox that cannot read canopyd's key, tokens or database (see sandbox() in gate.mjs).
    const sb = wrap ? wrap(cfg.cmd, cwd) : { file: '/bin/sh', args: ['-c', cfg.cmd] };
    try { child = spawn(sb.file, sb.args, { cwd, env, stdio: ['pipe', 'pipe', 'pipe'], detached: true }); } catch (err) { tidy(); return fail('could not start the manager: ' + err.message); }
    let out = '', err = '';
    child.stdout.on('data', (d) => { out = (out + d).slice(-400_000); });
    child.stderr.on('data', (d) => { err = (err + d).slice(-2000); });
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { child.kill('SIGKILL'); } fail(`the manager did not answer within ${Math.round(cfg.timeoutMs / 1000)} s`); }, cfg.timeoutMs);
    child.on('error', (e2) => { clearTimeout(timer); tidy(); fail('could not start the manager: ' + e2.message); });
    child.on('close', (code) => {
      clearTimeout(timer); tidy();
      if (code !== 0) return fail(`the manager exited with ${code}`, clean(err, 300));
      // The verdict is the last line of output that is a JSON object.
      let v = null;
      for (const line of out.trim().split('\n').reverse()) { try { const x = JSON.parse(line); if (x && typeof x === 'object' && !Array.isArray(x)) { v = x; break; } } catch { /* not this line */ } }
      if (!v || !['pass', 'concern', 'block'].includes(v.verdict)) return fail('the manager did not return a verdict of "pass", "concern" or "block"');
      resolve({ verdict: v.verdict, summary: clean(v.summary, 400), model: clean(v.model, 80),
        findings: (Array.isArray(v.findings) ? v.findings : []).slice(0, 12).map((f) => ({ severity: clean(f && f.severity, 20), file: clean(f && f.file, 200), note: clean(f && f.note, 400) })),
        ms: Math.round(performance.now() - t0) });
    });
    child.stdin.on('error', () => { /* the manager closed its input early */ });
    child.stdin.end(JSON.stringify(input));
  });
}

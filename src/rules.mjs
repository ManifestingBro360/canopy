// Section rules. They live in `.canopy/rules.json` and are always read from
// main, never from the branch being judged. Merging is monotone: every rule
// whose path is a prefix of the file applies, and combining rules can only
// tighten the result. There is no way for a deeper section to loosen a parent.
import { showFile } from './git.mjs';
import { createHash } from 'node:crypto';

// Files that decide how code is built, tested or shipped. A change to any of
// them needs a human, so a branch cannot lower the bar it is judged against.
export const DEFAULT_PROTECTED = [
  '.canopy/**', '.github/**', '.gitlab-ci.yml', '.circleci/**', '.claude/**', '.husky/**',
  '**/package.json', '**/package-lock.json', '**/pnpm-lock.yaml', '**/yarn.lock', '**/bun.lockb',
  '**/Makefile', '**/pyproject.toml', '**/setup.py', '**/setup.cfg', '**/tox.ini', '**/requirements*.txt',
  '**/go.mod', '**/go.sum', '**/Cargo.toml', '**/Cargo.lock', '**/conftest.py', '**/pytest.ini',
  '**/jest.config.*', '**/vitest.config.*', '**/playwright.config.*', '**/tsconfig*.json', '**/Dockerfile', '**/.npmrc',
];

const TEST_RE = /(^|\/)(tests?|__tests__|spec|specs)\/|\.(test|spec)\.[a-z]+$|_test\.(go|py)$|(^|\/)test_[^/]*\.py$/;
export const isTestFile = (p) => TEST_RE.test(p);

const globCache = new Map();
export function globMatch(glob, path) {
  let re = globCache.get(glob);
  if (!re) {
    const src = glob.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*\//g, '\u0001').replace(/\*\*/g, '\u0002').replace(/\*/g, '[^/]*')
      .replace(/\u0001/g, '(?:.*/)?').replace(/\u0002/g, '.*');
    re = new RegExp('^' + src + '$');
    globCache.set(glob, re);
  }
  return re.test(path);
}

const RULE_KEYS = new Set(['path', 'checks', 'perf', 'min_coverage', 'max_changed_lines', 'protected', 'no_tainted', 'no_unwitnessed']);
const TOP_KEYS = new Set(['version', 'rules', 'protected_globs', 'setup', 'revalidate', 'check_timeout_ms', 'checks_network']);
const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());

// Returns the first problem with a parsed rules document, or null. A rules
// file that is wrong in any way is refused whole: a typo must not silently
// turn a rule off.
function problem(doc) {
  if (!doc || typeof doc !== 'object' || Array.isArray(doc)) return 'the top level must be an object';
  for (const k of Object.keys(doc)) if (!TOP_KEYS.has(k)) return `unknown key "${k}"`;
  if (doc.rules !== undefined && !Array.isArray(doc.rules)) return '"rules" must be a list';
  for (const k of ['protected_globs', 'setup']) if (doc[k] !== undefined && !strList(doc[k])) return `"${k}" must be a list of strings`;
  if (doc.revalidate !== undefined && doc.revalidate !== 'always' && doc.revalidate !== 'disjoint') return '"revalidate" must be "always" or "disjoint"';
  if (doc.check_timeout_ms !== undefined && !(typeof doc.check_timeout_ms === 'number' && doc.check_timeout_ms > 0)) return '"check_timeout_ms" must be a positive number';
  if (doc.checks_network !== undefined && typeof doc.checks_network !== 'boolean') return '"checks_network" must be true or false';
  for (const [i, r] of (doc.rules || []).entries()) {
    const at = `rules[${i}]`;
    if (!r || typeof r !== 'object' || Array.isArray(r)) return `${at} must be an object`;
    for (const k of Object.keys(r)) if (!RULE_KEYS.has(k)) return `${at} has unknown key "${k}"`;
    if (typeof r.path !== 'string') return `${at} needs a "path" string ("" for the whole repository)`;
    if (/[*?[\]]/.test(normPath(r.path))) return `${at}: "${r.path}" is a pattern; rule paths are folders or files, use protected_globs for patterns`;
    if (r.checks !== undefined && !strList(r.checks)) return `${at}.checks must be a list of commands`;
    if (r.perf !== undefined && !(Array.isArray(r.perf) && r.perf.every((p) => p && typeof p.cmd === 'string' && p.cmd.trim() && typeof p.max_ms === 'number' && p.max_ms > 0 && (p.runs === undefined || (Number.isInteger(p.runs) && p.runs > 0 && p.runs < 10))))) return `${at}.perf must be a list of { "cmd": string, "max_ms": number }`;
    if (r.min_coverage !== undefined && !(typeof r.min_coverage === 'number' && r.min_coverage >= 0 && r.min_coverage <= 1)) return `${at}.min_coverage must be a number from 0 to 1`;
    if (r.max_changed_lines !== undefined && !(typeof r.max_changed_lines === 'number' && r.max_changed_lines >= 0)) return `${at}.max_changed_lines must be a number`;
    for (const k of ['protected', 'no_tainted', 'no_unwitnessed']) if (r[k] !== undefined && typeof r[k] !== 'boolean') return `${at}.${k} must be true or false`;
  }
  return null;
}
const normPath = (p) => p.replace(/^\.\//, '').replace(/\/\*{1,2}$/, '/').replace(/^\.$/, '');

export function loadRules(repo, ref) {
  const text = showFile(repo, ref, '.canopy/rules.json');
  const hash = createHash('sha256').update(text || '').digest('hex').slice(0, 16);
  const out = { rules: [], protectedGlobs: [...DEFAULT_PROTECTED], setup: [], revalidate: 'always', checkTimeoutMs: 600_000, network: false, hash, error: null, present: text !== null };
  if (text === null) return out;
  let doc, why = null;
  try { doc = JSON.parse(text); } catch (e) { why = 'it is not valid JSON (' + e.message + ')'; }
  why ||= problem(doc);
  if (why) return { ...out, error: `.canopy/rules.json at ${String(ref).slice(0, 10)} is invalid: ${why}` };
  return { ...out, rules: (doc.rules || []).map((r) => ({ ...r, path: normPath(r.path) })), protectedGlobs: [...DEFAULT_PROTECTED, ...(doc.protected_globs || [])],
    setup: doc.setup || [], revalidate: doc.revalidate || 'always', checkTimeoutMs: doc.check_timeout_ms || 600_000, network: doc.checks_network === true };
}

const under = (rulePath, file) => rulePath === '' || file === rulePath || file.startsWith(rulePath.endsWith('/') ? rulePath : rulePath + '/');

// The same benchmark named twice keeps the smaller budget.
function addPerf(list, p) {
  const q = list.find((x) => x.cmd === p.cmd);
  if (!q) list.push({ ...p }); else q.max_ms = Math.min(q.max_ms, p.max_ms);
}

// Rules that apply to one file, merged tighten-only.
export function resolve(ruleset, file) {
  const out = { checks: [], perf: [], min_coverage: 0, max_changed_lines: Infinity, protected: false, no_tainted: false, no_unwitnessed: false, sections: [] };
  for (const r of ruleset.rules) {
    if (!under(r.path, file)) continue;
    out.sections.push(r.path);
    for (const c of r.checks || []) if (!out.checks.includes(c)) out.checks.push(c);
    for (const p of r.perf || []) addPerf(out.perf, p);
    if (typeof r.min_coverage === 'number') out.min_coverage = Math.max(out.min_coverage, r.min_coverage);
    if (typeof r.max_changed_lines === 'number') out.max_changed_lines = Math.min(out.max_changed_lines, r.max_changed_lines);
    out.protected ||= r.protected === true;
    out.no_tainted ||= r.no_tainted === true;
    out.no_unwitnessed ||= r.no_unwitnessed === true;
  }
  if (ruleset.protectedGlobs.some((g) => globMatch(g, file))) out.protected = true;
  return out;
}

// Merge the per-file results for every path a change touches (old and new
// names of renamed files both count, so moving code cannot escape its rules).
export function resolveAll(ruleset, files) {
  const out = { checks: [], perf: [], min_coverage: 0, max_changed_lines: Infinity, protectedFiles: [], noTaintedFiles: [], no_unwitnessed: false };
  for (const f of files) {
    const r = resolve(ruleset, f);
    for (const c of r.checks) if (!out.checks.includes(c)) out.checks.push(c);
    for (const p of r.perf) addPerf(out.perf, p);
    out.min_coverage = Math.max(out.min_coverage, r.min_coverage);
    out.max_changed_lines = Math.min(out.max_changed_lines, r.max_changed_lines);
    if (r.protected) out.protectedFiles.push(f);
    if (r.no_tainted) out.noTaintedFiles.push(f);
    out.no_unwitnessed ||= r.no_unwitnessed;
  }
  return out;
}

// Short, human-readable summary of the rules for one path. Used as agent context.
export function describe(ruleset, file) {
  const r = resolve(ruleset, file);
  const parts = [];
  if (r.protected) parts.push('protected (a human must approve changes)');
  if (r.no_tainted) parts.push('no changes from sessions that read outside content without a human');
  if (r.min_coverage > 0) parts.push(`read at least ${Math.round(r.min_coverage * 100)}% of the code your change affects`);
  if (r.max_changed_lines !== Infinity) parts.push(`at most ${r.max_changed_lines} changed lines per landing`);
  if (r.checks.length) parts.push('checks: ' + r.checks.join('; '));
  if (r.perf.length) parts.push('performance budgets: ' + r.perf.map((p) => `${p.cmd} <= ${p.max_ms} ms`).join('; '));
  return parts;
}

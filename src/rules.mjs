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

const RULE_KEYS = new Set(['path', 'checks', 'perf', 'min_coverage', 'max_changed_lines', 'protected', 'no_tainted', 'no_unwitnessed',
  'owners', 'approvals', 'writers', 'guard_dependents', 'models']);
const TOP_KEYS = new Set(['version', 'rules', 'protected_globs', 'setup', 'revalidate', 'check_timeout_ms', 'checks_network',
  'teams', 'model_tiers', 'manager', 'advisories', 'environments', 'notify']);
const NOTIFY_KINDS = ['approval', 'security', 'blocked', 'landed', 'promotion'];
const strList = (v) => Array.isArray(v) && v.every((x) => typeof x === 'string' && x.trim());
const isObj = (v) => !!v && typeof v === 'object' && !Array.isArray(v);
const ENV_KEYS = 'name branch from promoters approvers approvals checks'.split(' ');
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
const only = (o, keys, at) => { for (const k of Object.keys(o)) if (!keys.includes(k)) return `${at} has unknown key "${k}"`; return null; };

// A list of people: user names, or "@team" for every member of a team.
function people(list, teams, at) {
  if (!strList(list) || !list.length) return `${at} must be a non-empty list of user names or "@team" names`;
  for (const x of list) {
    if (x.startsWith('@')) { if (!Object.hasOwn(teams, x.slice(1))) return `${at} names the team "${x}", which is not defined under "teams"`; }
    else if (!NAME.test(x)) return `${at}: "${x}" is not a valid user name`;
  }
  return null;
}
const expand = (list, teams) => [...new Set((list || []).flatMap((x) => (x.startsWith('@') ? (Object.hasOwn(teams, x.slice(1)) ? teams[x.slice(1)] : []) : [x])))];

// Model names are matched whole, ignoring case; "*" stands for any run of characters.
export function modelMatch(pattern, model) {
  return new RegExp('^' + String(pattern).replace(/[.+^${}()|[\]\\?]/g, '\\$&').replace(/\*/g, '.*') + '$', 'i').test(String(model || ''));
}

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
  const teams = doc.teams || {};
  if (doc.teams !== undefined) {
    if (!isObj(doc.teams)) return '"teams" must be an object of team name to list of user names';
    for (const [t, m] of Object.entries(doc.teams)) {
      if (!NAME.test(t)) return `"${t}" is not a valid team name`;
      if (!strList(m) || !m.length || !m.every((u) => NAME.test(u))) return `teams.${t} must be a non-empty list of user names`;
    }
  }
  if (doc.model_tiers !== undefined) {
    if (!isObj(doc.model_tiers)) return '"model_tiers" must be an object of tier name to list of model name patterns';
    for (const [t, m] of Object.entries(doc.model_tiers)) if (!NAME.test(t) || !strList(m) || !m.length) return `model_tiers.${t} must be a non-empty list of model name patterns`;
  }
  if (doc.manager !== undefined) {
    const m = doc.manager;
    if (!isObj(m)) return '"manager" must be an object';
    const bad = only(m, ['cmd', 'when', 'timeout_ms', 'on_error'], 'manager'); if (bad) return bad;
    if (typeof m.cmd !== 'string' || !m.cmd.trim()) return 'manager.cmd must be a command';
    if (m.when !== undefined && m.when !== 'always' && m.when !== 'flagged') return 'manager.when must be "always" or "flagged"';
    if (m.timeout_ms !== undefined && !(typeof m.timeout_ms === 'number' && m.timeout_ms > 0)) return 'manager.timeout_ms must be a positive number';
    if (m.on_error !== undefined && m.on_error !== 'review' && m.on_error !== 'ignore') return 'manager.on_error must be "review" or "ignore"';
  }
  if (doc.advisories !== undefined) {
    const a = doc.advisories;
    if (!isObj(a)) return '"advisories" must be an object';
    const bad = only(a, ['source', 'on_new', 'on_unavailable'], 'advisories'); if (bad) return bad;
    if (a.source !== 'osv') return 'advisories.source must be "osv"';
    if (a.on_new !== undefined && !['note', 'review', 'block'].includes(a.on_new)) return 'advisories.on_new must be "note", "review" or "block"';
    if (a.on_unavailable !== undefined && !['note', 'review'].includes(a.on_unavailable)) return 'advisories.on_unavailable must be "note" or "review"';
  }
  if (doc.notify !== undefined) {
    if (!Array.isArray(doc.notify)) return '"notify" must be a list';
    for (const [i, n] of doc.notify.entries()) {
      const at = `notify[${i}]`;
      if (!isObj(n)) return `${at} must be an object`;
      const bad = only(n, ['channel', 'on', 'paths'], at); if (bad) return bad;
      if (typeof n.channel !== 'string' || !NAME.test(n.channel)) return `${at}.channel must be a channel name (its address is set on the Canopy host with \`canopy notify add\`, never in this file)`;
      if (n.on !== undefined && !(strList(n.on) && n.on.length && n.on.every((k) => NOTIFY_KINDS.includes(k)))) return `${at}.on must list some of: ${NOTIFY_KINDS.join(', ')}`;
      if (n.paths !== undefined && !Array.isArray(n.paths)) return `${at}.paths must be a list of folders or files`;
      if (n.paths !== undefined && !n.paths.every((x) => typeof x === 'string')) return `${at}.paths must be a list of folders or files`;
    }
  }
  if (doc.environments !== undefined) {
    if (!Array.isArray(doc.environments)) return '"environments" must be a list';
    const seen = new Set(), branches = new Set();
    for (const [i, e] of doc.environments.entries()) {
      const at = `environments[${i}]`;
      if (!isObj(e)) return `${at} must be an object`;
      const bad = only(e, ENV_KEYS, at); if (bad) return bad;
      if (typeof e.name !== 'string' || !NAME.test(e.name)) return `${at}.name must be a short lower-case name`;
      if (typeof e.branch !== 'string' || !/^[A-Za-z0-9][A-Za-z0-9._/-]*$/.test(e.branch)) return `${at}.branch must be a branch name`;
      if (seen.has(e.name) || branches.has(e.branch)) return `${at} repeats a name or a branch`;
      seen.add(e.name); branches.add(e.branch);
      if (e.from !== undefined && !(typeof e.from === 'string' && e.from.trim())) return `${at}.from must be a branch name`;
      for (const k of ['promoters', 'approvers']) if (e[k] !== undefined) { const w = people(e[k], teams, `${at}.${k}`); if (w) return w; }
      if (e.approvals !== undefined && !(Number.isInteger(e.approvals) && e.approvals >= 0 && e.approvals <= 20)) return `${at}.approvals must be a whole number`;
      if (e.approvals > 0 && !e.approvers) return `${at} asks for approvals but names no approvers`;
      if (e.checks !== undefined && !strList(e.checks)) return `${at}.checks must be a list of commands`;
    }
  }
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
    for (const k of ['protected', 'no_tainted', 'no_unwitnessed', 'guard_dependents']) if (r[k] !== undefined && typeof r[k] !== 'boolean') return `${at}.${k} must be true or false`;
    for (const k of ['owners', 'writers']) if (r[k] !== undefined) { const w = people(r[k], teams, `${at}.${k}`); if (w) return w; }
    if (r.approvals !== undefined && !(Number.isInteger(r.approvals) && r.approvals >= 1 && r.approvals <= 20)) return `${at}.approvals must be a whole number, 1 or more`;
    if ((r.approvals !== undefined || r.guard_dependents) && !r.owners) return `${at} sets approvals or guard_dependents but names no owners`;
    if (r.models !== undefined && !(strList(r.models) && r.models.length)) return `${at}.models must be a non-empty list of tier names or model name patterns`;
  }
  return null;
}
const normPath = (p) => p.replace(/^\.\//, '').replace(/\/\*{1,2}$/, '/').replace(/^\.$/, '');

export function loadRules(repo, ref) {
  const text = showFile(repo, ref, '.canopy/rules.json');
  const hash = createHash('sha256').update(text || '').digest('hex').slice(0, 16);
  const out = { rules: [], protectedGlobs: [...DEFAULT_PROTECTED], setup: [], revalidate: 'always', checkTimeoutMs: 600_000, network: false, hash, error: null, present: text !== null,
    teams: {}, manager: null, advisories: null, environments: [], notify: [] };
  if (text === null) return out;
  let doc, why = null;
  try { doc = JSON.parse(text); } catch (e) { why = 'it is not valid JSON (' + e.message + ')'; }
  why ||= problem(doc);
  if (why) return { ...out, error: `.canopy/rules.json at ${String(ref).slice(0, 10)} is invalid: ${why}` };
  const teams = doc.teams || {}, tiers = doc.model_tiers || {};
  const rules = (doc.rules || []).map((r, i) => ({ ...r, path: normPath(r.path), key: i + ':' + normPath(r.path),
    owners: r.owners ? expand(r.owners, teams) : null, approvals: r.owners ? r.approvals || 1 : 0,
    // Owners may always write in their own section.
    writers: r.writers ? [...new Set([...expand(r.writers, teams), ...(r.owners ? expand(r.owners, teams) : [])])] : null,
    models: r.models ? r.models.flatMap((m) => (Object.hasOwn(tiers, m) ? tiers[m] : [m])) : null, modelNames: r.models || null }));
  const envs = (doc.environments || []).map((e, i, all) => ({ name: e.name, branch: e.branch, from: e.from || (i ? all[i - 1].branch : null),
    promoters: e.promoters ? expand(e.promoters, teams) : null, approvers: e.approvers ? expand(e.approvers, teams) : null, approvals: e.approvals || 0, checks: e.checks || [] }));
  return { ...out, rules, protectedGlobs: [...DEFAULT_PROTECTED, ...(doc.protected_globs || [])],
    setup: doc.setup || [], revalidate: doc.revalidate || 'always', checkTimeoutMs: doc.check_timeout_ms || 600_000, network: doc.checks_network === true,
    teams, environments: envs,
    notify: (doc.notify || []).map((n) => ({ channel: n.channel, on: n.on || ['approval', 'security', 'blocked'], paths: n.paths ? n.paths.map(normPath) : null })),
    manager: doc.manager ? { cmd: doc.manager.cmd, when: doc.manager.when || 'flagged', timeoutMs: doc.manager.timeout_ms || 180_000, onError: doc.manager.on_error || 'review' } : null,
    advisories: doc.advisories ? { source: 'osv', onNew: doc.advisories.on_new || 'review', onUnavailable: doc.advisories.on_unavailable || 'note' } : null };
}

const under = (rulePath, file) => rulePath === '' || file === rulePath || file.startsWith(rulePath.endsWith('/') ? rulePath : rulePath + '/');

// The same benchmark named twice keeps the smaller budget.
function addPerf(list, p) {
  const q = list.find((x) => x.cmd === p.cmd);
  if (!q) list.push({ ...p }); else q.max_ms = Math.min(q.max_ms, p.max_ms);
}

// Rules that apply to one file, merged tighten-only.
export function resolve(ruleset, file) {
  const out = { checks: [], perf: [], min_coverage: 0, max_changed_lines: Infinity, protected: false, no_tainted: false, no_unwitnessed: false, sections: [],
    owned: [], writers: [], models: [], guards: [] };
  for (const r of ruleset.rules) {
    if (!under(r.path, file)) continue;
    out.sections.push(r.path);
    // Every owned section a file sits in asks for its own approval; none replaces another.
    if (r.owners) out.owned.push({ key: r.key, path: r.path, owners: r.owners, approvals: r.approvals });
    if (r.owners && r.guard_dependents) out.guards.push({ key: r.key, path: r.path, owners: r.owners, approvals: r.approvals });
    if (r.writers) out.writers.push({ key: r.key, path: r.path, allowed: r.writers });
    if (r.models) out.models.push({ key: r.key, path: r.path, allow: r.models, names: r.modelNames });
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
  const out = { checks: [], perf: [], min_coverage: 0, max_changed_lines: Infinity, protectedFiles: [], noTaintedFiles: [], no_unwitnessed: false,
    owned: new Map(), writers: new Map(), models: new Map() };
  // Keyed by rule, not by path: two rules for one path are two requirements.
  const group = (map, x, f) => { const g = map.get(x.key) || { ...x, files: [] }; g.files.push(f); map.set(x.key, g); };
  for (const f of files) {
    const r = resolve(ruleset, f);
    for (const x of r.owned) group(out.owned, x, f);
    for (const x of r.writers) group(out.writers, x, f);
    for (const x of r.models) group(out.models, x, f);
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
  for (const o of r.owned) parts.push(`${o.path || 'the repository'} is owned by ${o.owners.join(', ')}; ${o.approvals} owner approval${o.approvals > 1 ? 's' : ''} needed to land`);
  for (const w of r.writers) parts.push(`only ${w.allowed.join(', ')} may change ${w.path || 'the repository'}`);
  for (const m of r.models) parts.push(`${m.path || 'the repository'} accepts changes written by these models only: ${m.names.join(', ')}`);
  if (r.no_tainted) parts.push('no changes from sessions that read outside content without a human');
  if (r.min_coverage > 0) parts.push(`read at least ${Math.round(r.min_coverage * 100)}% of the code your change affects`);
  if (r.max_changed_lines !== Infinity) parts.push(`at most ${r.max_changed_lines} changed lines per landing`);
  if (r.checks.length) parts.push('checks: ' + r.checks.join('; '));
  if (r.perf.length) parts.push('performance budgets: ' + r.perf.map((p) => `${p.cmd} <= ${p.max_ms} ms`).join('; '));
  return parts;
}

// The code graph of main: symbols, files, and who depends on whom.
// Built from Git objects (not a working tree), cached per blob in SQLite,
// and rebuilt incrementally when main moves.
import { posix } from 'node:path';
import { extract, langOf } from './extract.mjs';
import { lsTree, catBlobs, git } from './git.mjs';

const SKIP = /(^|\/)(node_modules|vendor|dist|build|out|target|\.next|\.venv|venv|__pycache__|coverage|\.git)\//;
const SKIP_FILE = /\.(min\.js|map|lock|png|jpe?g|gif|webp|ico|pdf|zip|gz|tar|woff2?|ttf|eot|mp4|mov|wasm|so|dylib|dll|exe|bin|jar|class|pyc)$/i;
const JS_EXT = ['.ts', '.tsx', '.js', '.jsx', '.mjs', '.cjs', '.mts', '.cts'];

export const nodeId = (path, name) => (name ? path + '#' + name : path);
export const pathOf = (id) => { const i = id.indexOf('#'); return i < 0 ? id : id.slice(0, i); };
export const nameOf = (id) => { const i = id.indexOf('#'); return i < 0 ? '' : id.slice(i + 1); };
export const bare = (name) => name.split('.').pop().split('~')[0];

export class Graph {
  constructor(store, repo) {
    this.store = store; this.repo = repo;
    this.rev = null;
    this.files = new Map();   // path -> { oid, lang, lines, symbols, imports, idents }
    this.nodes = new Map();   // id -> { id, path, name, kind, start, end, sig, sigHash, bodyHash }
    this.deps = new Map();    // id -> Set(id) it depends on
    this.rdeps = new Map();   // id -> Set(id) depending on it
  }

  // Bring the graph to `ref`. Only blobs that changed since the last build are parsed.
  build(ref) {
    const t0 = performance.now();
    const rev = git(this.repo, ['rev-parse', ref]);
    if (rev === this.rev) return { files: this.files.size, parsed: 0, ms: 0 };
    const listing = lsTree(this.repo, rev).filter((f) => !SKIP.test('/' + f.path) && !SKIP_FILE.test(f.path));
    const cached = new Map();
    if (!this.files.size) for (const r of this.store.all('select path, oid, data from files')) cached.set(r.path, r);
    const next = new Map();
    const need = [];
    for (const f of listing) {
      const live = this.files.get(f.path);
      if (live && live.oid === f.oid) { next.set(f.path, live); continue; }
      const c = cached.get(f.path);
      if (c && c.oid === f.oid) { next.set(f.path, { oid: f.oid, ...JSON.parse(c.data) }); continue; }
      need.push(f);
    }
    const code = need.filter((f) => langOf(f.path));
    const blobs = catBlobs(this.repo, [...new Set(code.map((f) => f.oid))]);
    const sizes = this.#sizes(need.filter((f) => !langOf(f.path)));
    this.store.tx(() => {
      for (const f of need) {
        let rec;
        if (langOf(f.path)) {
          const ex = extract(f.path, blobs.get(f.oid) || '');
          rec = { lang: ex.lang, lines: ex.lines, symbols: ex.symbols, imports: ex.imports, idents: ex.idents, looseHash: ex.looseHash };
        } else {
          rec = { lang: null, lines: sizes.get(f.oid) || 1, symbols: [], imports: [], idents: [] };
        }
        next.set(f.path, { oid: f.oid, ...rec });
        this.store.run('insert into files(path, oid, data) values(?,?,?) on conflict(path) do update set oid=excluded.oid, data=excluded.data', f.path, f.oid, JSON.stringify(rec));
      }
      for (const p of this.files.keys()) if (!next.has(p)) this.store.run('delete from files where path=?', p);
      if (!this.files.size) for (const p of cached.keys()) if (!next.has(p)) this.store.run('delete from files where path=?', p);
    });
    this.files = next; this.rev = rev;
    this.#link();
    return { files: next.size, parsed: need.length, ms: Math.round(performance.now() - t0) };
  }

  // Line counts for non-code files, estimated from blob size (one process).
  #sizes(files) {
    const out = new Map();
    if (!files.length) return out;
    const res = git(this.repo, ['cat-file', '--batch-check'], { input: files.map((f) => f.oid).join('\n') + '\n' });
    for (const l of res.split('\n')) { const [oid, , size] = l.split(' '); out.set(oid, Math.max(1, Math.round(Number(size) / 40))); }
    return out;
  }

  #resolveImport(from, spec, lang, dirs) {
    const dir = posix.dirname(from);
    const has = (p) => this.files.has(p);
    if (lang === 'js') {
      const base = spec.startsWith('.') ? posix.normalize(posix.join(dir, spec)) : spec.replace(/^[@~]\//, 'src/');
      const stem = base.replace(/\.(js|mjs|cjs|jsx)$/, '');
      const tries = [base, ...JS_EXT.map((e) => base + e), ...JS_EXT.map((e) => stem + e), ...JS_EXT.map((e) => base + '/index' + e)];
      const hit = tries.find(has);
      return hit ? [hit] : [];
    }
    if (lang === 'py') {
      const dots = spec.match(/^\.*/)[0].length;
      const rel = spec.slice(dots).split('.').filter(Boolean).join('/');
      const roots = [];
      if (dots) { let d = dir; for (let i = 1; i < dots; i++) d = posix.dirname(d); roots.push(d); }
      else { roots.push('.'); for (let d = dir; d !== '.' && d !== '/'; d = posix.dirname(d)) roots.push(d); roots.push('src'); }
      for (const r of roots) {
        for (const c of [posix.join(r, rel + '.py'), posix.join(r, rel, '__init__.py')]) if (has(posix.normalize(c))) return [posix.normalize(c)];
      }
      return [];
    }
    if (lang === 'go') {
      const out = [];
      for (const [d, list] of dirs) if (d !== '.' && (spec === d || spec.endsWith('/' + d))) out.push(...list);
      return out;
    }
    return [];
  }

  #link() {
    const nodes = new Map(), deps = new Map(), rdeps = new Map();
    const byName = new Map(), byMethod = new Map();
    const goDirs = new Map();
    for (const [path, f] of this.files) {
      nodes.set(path, { id: path, path, name: '', kind: 'file', start: 0, end: Math.max(0, f.lines - 1), lines: f.lines });
      if (f.lang === 'go') { const d = posix.dirname(path); if (!goDirs.has(d)) goDirs.set(d, []); goDirs.get(d).push(path); }
      for (const s of f.symbols) {
        const id = nodeId(path, s.name);
        nodes.set(id, { id, path, name: s.name, kind: s.kind, start: s.start, end: s.end, sig: s.sig, sigHash: s.sigHash, bodyHash: s.bodyHash });
        const map = s.kind === 'method' ? byMethod : byName;
        const key = bare(s.name);
        if (!map.has(key)) map.set(key, []);
        map.get(key).push(id);
      }
    }
    const link = (a, b) => {
      if (a === b) return;
      if (!deps.has(a)) deps.set(a, new Set());
      deps.get(a).add(b);
      if (!rdeps.has(b)) rdeps.set(b, new Set());
      rdeps.get(b).add(a);
    };
    for (const [path, f] of this.files) {
      const imp = new Set();
      for (const spec of f.imports) for (const p of this.#resolveImport(path, spec, f.lang, goDirs)) imp.add(p);
      if (f.lang === 'go') for (const p of goDirs.get(posix.dirname(path)) || []) imp.add(p);
      f.resolved = imp;
      for (const p of imp) link(path, p);
      const use = (from, idents) => {
        for (const w of idents) {
          const tops = byName.get(w);
          if (tops) for (const id of tops) {
            const tp = pathOf(id);
            if (tp === path || imp.has(tp) || (tops.length === 1 && w.length >= 4)) link(from, id);
          }
          const meths = byMethod.get(w);
          // A class does not "depend on" its own methods: they are part of it.
          if (meths) for (const id of meths) { const tp = pathOf(id); if ((tp === path || imp.has(tp)) && !id.startsWith(from + '.')) link(from, id); }
        }
      };
      use(path, f.idents);
      for (const s of f.symbols) use(nodeId(path, s.name), s.idents);
    }
    this.nodes = nodes; this.deps = deps; this.rdeps = rdeps; this.byName = byName; this.byMethod = byMethod;
  }

  // Everything that depends on `id`, out to `hops` levels. Excludes `id` itself.
  dependents(id, hops = 1) {
    const out = new Set();
    let frontier = [id];
    for (let h = 0; h < hops; h++) {
      const nextF = [];
      for (const n of frontier) for (const d of this.rdeps.get(n) || []) if (d !== id && !out.has(d)) { out.add(d); nextF.push(d); }
      frontier = nextF;
    }
    return out;
  }

  // In-flight top-level symbols on main whose bare name is `name`.
  named(name) { return [...(this.byName.get(name) || []), ...(this.byMethod.get(name) || [])]; }

  symbolsIn(path) {
    const f = this.files.get(path);
    return f ? f.symbols.map((s) => nodeId(path, s.name)) : [];
  }
}

// Compare two extractions of the same path. Returns [{ name, kind, sigOld, sigNew }]
// where kind is signature | body | added | removed.
export function diffSymbols(oldEx, newEx) {
  const out = [];
  if ((oldEx && oldEx.oversize) || (newEx && newEx.oversize)) return out; // too large to parse: handled as a file-level change
  const o = new Map((oldEx ? oldEx.symbols : []).map((s) => [s.name, s]));
  const n = new Map((newEx ? newEx.symbols : []).map((s) => [s.name, s]));
  for (const [name, s] of n) {
    const p = o.get(name);
    if (!p) out.push({ name, kind: 'added', sigNew: s.sig });
    else if (p.sigHash !== s.sigHash) out.push({ name, kind: 'signature', sigOld: p.sig, sigNew: s.sig });
    else if (p.bodyHash !== s.bodyHash) out.push({ name, kind: 'body', sigOld: p.sig, sigNew: s.sig });
  }
  for (const [name, s] of o) if (!n.has(name)) out.push({ name, kind: 'removed', sigOld: s.sig });
  // A class whose only change is inside one of its methods is reported once, as the method.
  const methodChanged = new Set(out.filter((c) => c.name.includes('.')).map((c) => c.name.split('.')[0]));
  return out.filter((c) => !(c.kind === 'body' && methodChanged.has(c.name)));
}

// Symbol extraction: source text -> symbols (with line spans and hashes) + imports.
// Pattern-based and dependency-free. Sits behind one function, `extract`, so a
// tree-sitter or language-server backend can replace it.
import { createHash } from 'node:crypto';

const h = (s) => createHash('sha1').update(s).digest('hex').slice(0, 16);
const squash = (s) => s.replace(/\s+/g, ' ').trim();
// Form used for hashing: layout does not count. Whitespace next to punctuation
// and trailing commas are dropped, so re-wrapping or re-indenting changes nothing.
const norm = (s) => s.replace(/\s+/g, ' ').replace(/ ?([^\w$ ]) ?/g, '$1').replace(/,([)\]}])/g, '$1').trim();

const LANG = {
  js: 'js', mjs: 'js', cjs: 'js', jsx: 'js', ts: 'js', tsx: 'js', mts: 'js', cts: 'js',
  py: 'py', go: 'go',
};
export const langOf = (path) => LANG[path.slice(path.lastIndexOf('.') + 1).toLowerCase()] || null;

const STOP = new Set(('if else for while do switch case break continue return function class const let var new ' +
  'this super import export from default async await try catch finally throw typeof instanceof void delete in of ' +
  'true false null undefined yield static get set extends implements interface type enum public private protected ' +
  'readonly def self None True False and or not is lambda pass raise with as elif except global nonlocal assert ' +
  'func package range chan go defer select struct map nil string number boolean any int float bool').split(' '));

export function identsOf(text, own) {
  const out = new Set();
  for (const m of text.matchAll(/[A-Za-z_$][\w$]*/g)) {
    const w = m[0];
    if (w.length > 1 && w !== own && !STOP.has(w)) out.add(w);
  }
  return [...out];
}

// One pass over C-like source. For each line: brace depth at start and end,
// paren depth at start, whether the line starts inside a comment or string,
// and the position of every `{` that opens outside parentheses relative to it.
function scanBraces(text, lang) {
  const lines = text.split('\n');
  const info = new Array(lines.length);
  let depth = 0, paren = 0, state = 0; // 0 code, 1 block comment, 2 template string
  const tpl = []; // brace depth at which each open template interpolation started
  const top = lang === 'js' ? JS_COL0 : GO_COL0;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    // A declaration that starts in column 0 is top level. If earlier text was
    // misread (JSX text, an odd literal), this puts the counters right again.
    if (state === 0 && (depth || paren) && top.test(s)) { depth = 0; paren = 0; tpl.length = 0; }
    const rec = { d0: depth, p0: paren, clean: state === 0, opens: [], d1: 0, p1: 0 };
    let prev = '';
    for (let c = 0; c < s.length; c++) {
      const ch = s[c];
      if (state === 1) { if (ch === '*' && s[c + 1] === '/') { state = 0; c++; } continue; }
      if (state === 2) {
        if (ch === '\\') { c++; continue; }
        if (ch === '`') { state = 0; continue; }
        if (lang === 'js' && ch === '$' && s[c + 1] === '{') { tpl.push(depth); depth++; state = 0; c++; }
        continue;
      }
      if (ch === '/' && s[c + 1] === '/') break;
      if (ch === '/' && s[c + 1] === '*') { state = 1; c++; continue; }
      if (ch === '"' || ch === "'") {
        for (c++; c < s.length && s[c] !== ch; c++) if (s[c] === '\\') c++;
        prev = ch; continue;
      }
      if (ch === '`') { state = 2; continue; }
      if (ch === '/' && lang === 'js' && regexMayStart(s, c, prev)) {
        let cls = false, j = c + 1; // regex literal: skip to its closing slash
        for (; j < s.length; j++) {
          if (s[j] === '\\') { j++; continue; }
          if (s[j] === '[') cls = true; else if (s[j] === ']') cls = false;
          else if (s[j] === '/' && !cls) break;
        }
        if (j < s.length) { c = j; prev = '/'; continue; }
      }
      if (ch === '{') { rec.opens.push([c, paren]); depth++; }
      else if (ch === '}') {
        depth--;
        if (tpl.length && tpl[tpl.length - 1] === depth) { tpl.pop(); state = 2; }
      } else if (ch === '(' || ch === '[') paren++;
      else if (ch === ')' || ch === ']') paren--;
      if (ch !== ' ' && ch !== '\t') prev = ch;
    }
    rec.d1 = depth; rec.p1 = paren;
    info[i] = rec;
  }
  return { lines, info };
}

const JS_COL0 = /^(export\s|import\s|function[\s*(]|async\s+function|class\s|const\s|let\s|var\s|interface\s|type\s+[A-Za-z_$]|enum\s|declare\s|abstract\s+class|namespace\s)/;
const GO_COL0 = /^(func|type|var|const|import|package)\b/;
const RE_KW = new Set(['return', 'typeof', 'case', 'in', 'of', 'do', 'else', 'void', 'delete', 'throw', 'yield', 'await']);
function regexMayStart(s, c, prev) {
  if (prev === '' || '(,=:[!&|?{};+-*%<>~^'.includes(prev)) return true;
  const m = /([A-Za-z_$][\w$]*)\s*$/.exec(s.slice(0, c));
  return !!m && RE_KW.has(m[1]);
}

// End line of a declaration starting at line L, and where its body opens.
function braceExtent(lines, info, L, nextDecl) {
  const d0 = info[L].d0, p0 = info[L].p0;
  let open = null;
  for (let e = L; e < lines.length; e++) {
    if (e > L && info[e].d0 < d0) return { end: e - 1, open };
    if (!open) {
      // The body brace is the one still open at the end of the line. Braces
      // that open and close before it belong to the header (a return type).
      const cand = info[e].opens.filter(([, p]) => p === p0);
      if (cand.length) { const k = cand.length - Math.max(0, info[e].d1 - info[e].d0); open = [e, cand[k >= 0 && k < cand.length ? k : 0][0]]; }
    }
    if (open && info[e].d1 <= d0) return { end: e, open };
    if (!open && info[e].p1 <= p0 && info[e].d1 <= d0) {
      const t = lines[e].trimEnd();
      const nxt = lines[e + 1];
      if (t.endsWith(';') || nxt === undefined || nxt.trim() === '' || (nextDecl && nextDecl(e + 1))) return { end: e, open };
    }
  }
  return { end: lines.length - 1, open };
}

// Text of a declaration's header. For `const x = ...` the header ends at the
// top-level arrow if there is one, otherwise at the `=`: the value is body.
function sigText(lines, L, ext, isConst) {
  let s;
  if (ext.open) { const [ol, oc] = ext.open; s = lines.slice(L, ol).join('\n') + '\n' + lines[ol].slice(0, oc); }
  else s = lines.slice(L, ext.end + 1).join('\n');
  return squash(isConst ? cutTop(s) : s);
}
function cutTop(s) {
  let p = 0, eq = -1;
  for (let i = 0; i < s.length; i++) {
    const ch = s[i];
    if (ch === '"' || ch === "'" || ch === '`') { for (i++; i < s.length && s[i] !== ch; i++) if (s[i] === '\\') i++; continue; }
    if ('([{'.includes(ch)) p++; else if (')]}'.includes(ch)) p--;
    else if (p === 0 && ch === '=') {
      if (s[i + 1] === '>') return s.slice(0, i + 2);
      if (eq < 0 && s[i + 1] !== '=' && !'=!<>'.includes(s[i - 1] || '')) eq = i;
    }
  }
  return eq >= 0 ? s.slice(0, eq + 1) : s;
}

const JS_TOP = [
  [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:async\s+)?function\s*\*?\s*([A-Za-z_$][\w$]*)/, 'function'],
  [/^\s*(?:export\s+)?(?:default\s+)?(?:declare\s+)?(?:abstract\s+)?class\s+([A-Za-z_$][\w$]*)/, 'class'],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:interface|type|enum|namespace)\s+([A-Za-z_$][\w$]*)/, 'type'],
  [/^\s*(?:export\s+)?(?:declare\s+)?(?:const|let|var)\s+([A-Za-z_$][\w$]*)/, 'const'],
  [/^\s*export\s+default\s+()/, 'function'], // anonymous default export
];
const JS_FN_VALUE = /=\s*(?:async\s*)?(?:function\b|\(|[A-Za-z_$][\w$]*\s*=>)/;
const JS_METHOD = /^\s*(?:(?:public|private|protected|static|async|readonly|override|abstract|get|set)\s+)*\*?\s*(#?[A-Za-z_$][\w$]*)\s*(?:<[^>(]*>)?\s*(?:\(|=\s*(?:async\s*)?\()/;
const NOT_METHOD = new Set(['if', 'for', 'while', 'switch', 'catch', 'return', 'function', 'new', 'await', 'typeof', 'throw', 'else', 'do']);

function extractJs(text) {
  const { lines, info } = scanBraces(text, 'js');
  const out = [];
  const topAt = (i) => info[i] && info[i].clean && info[i].d0 === 0 && info[i].p0 === 0 && JS_TOP.some(([re]) => re.test(lines[i]));
  for (let i = 0; i < lines.length; i++) {
    if (!info[i].clean || info[i].d0 !== 0 || info[i].p0 !== 0) continue;
    for (const [re, kind0] of JS_TOP) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const ext = braceExtent(lines, info, i, topAt);
      let kind = kind0;
      if (kind === 'const' && JS_FN_VALUE.test(lines[i])) kind = 'function';
      out.push({ name: m[1] || 'default', kind, start: i, end: ext.end, sig: sigText(lines, i, ext, kind0 === 'const'), exported: /^\s*export\b/.test(lines[i]) });
      if (kind === 'class') {
        for (let j = i + 1; j <= ext.end; j++) {
          if (!info[j].clean || info[j].d0 !== 1 || info[j].p0 !== 0) continue;
          const mm = JS_METHOD.exec(lines[j]);
          if (!mm || NOT_METHOD.has(mm[1])) continue;
          const mx = braceExtent(lines, info, j, null);
          out.push({ name: m[1] + '.' + mm[1], kind: 'method', start: j, end: Math.min(mx.end, ext.end), sig: sigText(lines, j, mx, /^\s*(?:(?:public|private|protected|static|readonly|override)\s+)*#?[\w$]+\s*=/.test(lines[j])), exported: false });
          j = Math.max(j, mx.end);
        }
      }
      i = Math.max(i, ext.end);
      break;
    }
  }
  const imports = [];
  for (const re of [/\bimport\s+(?:[^'"]*?\sfrom\s+)?['"]([^'"]+)['"]/g, /\bexport\s+[^'"]*?\sfrom\s+['"]([^'"]+)['"]/g,
    /\brequire\(\s*['"]([^'"]+)['"]\s*\)/g, /\bimport\(\s*['"]([^'"]+)['"]\s*\)/g]) {
    for (const m of text.matchAll(re)) imports.push(m[1]);
  }
  return { lines, symbols: out, imports };
}

// A Python `def`/`class` header: everything up to the colon that ends it.
function pyHeader(lines, L, end) {
  let depth = 0, out = '';
  for (let i = L; i <= end; i++) {
    const s = lines[i];
    for (let c = 0; c < s.length; c++) {
      const ch = s[c];
      if (ch === '#') break;
      if (ch === '"' || ch === "'") { const q = c; for (c++; c < s.length && s[c] !== ch; c++) if (s[c] === '\\') c++; out += s.slice(q, c + 1); continue; }
      if ('([{'.includes(ch)) depth++; else if (')]}'.includes(ch)) depth--;
      else if (ch === ':' && depth === 0) return out + ':';
      out += ch;
    }
    out += '\n';
  }
  return out;
}

function extractPy(text) {
  const lines = text.split('\n');
  const out = [];
  const indentOf = (s) => s.length - s.trimStart().length;
  const blank = (s) => { const t = s.trim(); return t === '' || t.startsWith('#'); };
  const stack = []; // enclosing classes: [indent, name, end]
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i];
    if (blank(s)) continue;
    const ind = indentOf(s);
    while (stack.length && (i > stack[stack.length - 1][2] || ind <= stack[stack.length - 1][0])) stack.pop();
    const m = /^\s*(?:async\s+)?(def|class)\s+([A-Za-z_]\w*)/.exec(s);
    const top = !m && ind === 0 && /^([A-Za-z_]\w*)\s*(?::[^=]+)?=(?!=)/.exec(s);
    if (!m && !top) continue;
    let end = i;
    for (let j = i + 1; j < lines.length; j++) {
      if (blank(lines[j])) continue;
      if (indentOf(lines[j]) <= ind && !/^[\s)\]}]/.test(lines[j].trimStart()[0] === ')' ? ')' : 'x')) break;
      end = j;
    }
    let start = i;
    while (start > 0 && lines[start - 1].trim().startsWith('@') && indentOf(lines[start - 1]) === ind) start--;
    if (top) {
      out.push({ name: top[1], kind: 'const', start, end, sig: squash(cutTop(s)), exported: !top[1].startsWith('_') });
      i = end; continue;
    }
    const sig = squash(lines.slice(start, i).join('\n') + '\n' + pyHeader(lines, i, end));
    const inClass = stack.length && ind > stack[stack.length - 1][0] ? stack[stack.length - 1][1] : null;
    if (m[1] === 'class') {
      out.push({ name: m[2], kind: 'class', start, end, sig, exported: !m[2].startsWith('_') });
      stack.push([ind, m[2], end]);
    } else if (inClass) {
      out.push({ name: inClass + '.' + m[2], kind: 'method', start, end, sig, exported: false });
      i = end;
    } else {
      // Top level, or under an `if`/`try` at module level. Nested defs are never reached: their parent is skipped whole.
      out.push({ name: m[2], kind: 'function', start, end, sig, exported: !m[2].startsWith('_') });
      i = end;
    }
  }
  const imports = [];
  for (const m of text.matchAll(/^\s*from\s+([.\w]+)\s+import\b/gm)) imports.push(m[1]);
  for (const m of text.matchAll(/^\s*import\s+([\w.]+(?:\s*,\s*[\w.]+)*)/gm)) for (const p of m[1].split(',')) imports.push(p.trim());
  return { lines, symbols: out, imports };
}

const GO_TOP = [
  [/^func\s+(?:\(\s*\w*\s*\*?\s*([A-Za-z_]\w*)(?:\[[^\]]*\])?\s*\)\s*)?([A-Za-z_]\w*)\s*[(\[]/, 'function'],
  [/^type\s+()([A-Za-z_]\w*)\b/, 'type'],
  [/^(?:var|const)\s+()([A-Za-z_]\w*)\b/, 'const'],
];
function extractGo(text) {
  const { lines, info } = scanBraces(text, 'go');
  const out = [];
  const topAt = (i) => info[i] && info[i].d0 === 0 && GO_TOP.some(([re]) => re.test(lines[i]));
  for (let i = 0; i < lines.length; i++) {
    if (!info[i].clean || info[i].d0 !== 0 || info[i].p0 !== 0) continue;
    for (const [re, kind] of GO_TOP) {
      const m = re.exec(lines[i]);
      if (!m) continue;
      const ext = braceExtent(lines, info, i, topAt);
      const name = m[1] ? m[1] + '.' + m[2] : m[2];
      out.push({ name, kind: m[1] ? 'method' : kind, start: i, end: ext.end, sig: sigText(lines, i, ext, kind === 'const'), exported: /^[A-Z]/.test(m[2]) });
      i = Math.max(i, ext.end);
      break;
    }
  }
  const imports = [];
  for (const m of text.matchAll(/^\s*(?:import\s+)?(?:[\w.]+\s+)?"([\w./-]+)"\s*$/gm)) imports.push(m[1]);
  return { lines, symbols: out, imports };
}

// extract(path, text) -> { lang, lines, symbols:[{name,kind,start,end,sig,sigHash,bodyHash,idents,exported}], imports, idents, looseHash }
// Line numbers are 0-based and inclusive. `idents` on the result are the
// identifiers used outside any symbol (module-level code). Files that are too
// large to parse come back with `oversize` set and are handled at file level.
export function extract(path, text) {
  const lang = langOf(path);
  const total = text.length ? text.split('\n').length : 0;
  if (!lang) return { lang: null, lines: total, symbols: [], imports: [], idents: [], looseHash: null };
  if (text.length > 2_000_000) return { lang: null, oversize: true, lines: total, symbols: [], imports: [], idents: [], looseHash: null };
  const r = lang === 'js' ? extractJs(text) : lang === 'py' ? extractPy(text) : extractGo(text);
  // Overloads: consecutive declarations of one name are one symbol.
  const merged = [];
  for (const s of r.symbols) {
    const p = merged[merged.length - 1];
    if (p && p.name === s.name && p.kind === s.kind && (s.kind === 'function' || s.kind === 'method') && s.start <= p.end + 2) { p.end = s.end; p.sig += ' | ' + s.sig; }
    else merged.push(s);
  }
  const seen = new Map();
  const covered = new Uint8Array(r.lines.length);
  for (const s of merged) {
    const n = (seen.get(s.name) || 0) + 1;
    seen.set(s.name, n);
    if (n > 1) s.name += '~' + n;
    const body = r.lines.slice(s.start, s.end + 1).join('\n');
    s.bodyHash = h(norm(body));
    // For a type, its members are its interface: any change is a signature change.
    s.sigHash = s.kind === 'type' ? s.bodyHash : h(norm(s.sig));
    s.sig = s.sig.slice(0, 400);
    s.idents = identsOf(body, s.name.split('.').pop().split('~')[0]);
    if (s.kind !== 'class') covered.fill(1, s.start, s.end + 1);
    else covered[s.start] = 1;
  }
  const loose = r.lines.filter((_, i) => !covered[i]).join('\n');
  return { lang, lines: r.lines.length, symbols: merged, imports: r.imports, idents: identsOf(loose, ''), looseHash: h(norm(loose)) };
}

export const hashText = h;

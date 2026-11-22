// Known-vulnerability lookup for dependencies a change adds or moves.
//
// Off unless the rules on main set "advisories". When on, package names and
// versions (nothing else) are sent to OSV.dev, the open vulnerability database
// that aggregates the GitHub, PyPI, Go, RustSec and npm advisory feeds.
import { showFile } from './git.mjs';
import { basename } from 'node:path';

const OSV = () => (process.env.CANOPY_OSV_URL || 'https://api.osv.dev').replace(/\/$/, '');

// path -> [{ ecosystem, name, version }] for the manifest formats we can read exactly.
export function parseManifest(path, text) {
  const file = basename(path), out = [];
  try {
    if (file === 'package-lock.json') {
      const doc = JSON.parse(text);
      for (const [k, v] of Object.entries(doc.packages || {})) {
        const i = k.lastIndexOf('node_modules/');
        if (i < 0 || !v || !v.version || v.link) continue;
        out.push({ ecosystem: 'npm', name: k.slice(i + 13), version: v.version });
      }
    } else if (/^requirements.*\.txt$/.test(file)) {
      for (const line of text.split('\n')) {
        const m = /^\s*([A-Za-z0-9][A-Za-z0-9._-]*)\s*(?:\[[^\]]*\])?\s*==\s*([A-Za-z0-9.!+_-]+)/.exec(line);
        if (m) out.push({ ecosystem: 'PyPI', name: m[1].toLowerCase(), version: m[2] });
      }
    } else if (file === 'go.mod') {
      for (const m of text.matchAll(/^\s*(?:require\s+)?([a-z0-9][\w.\-/~]*\.[\w.\-/~]+)\s+v(\d[\w.\-+]*)/gm)) out.push({ ecosystem: 'Go', name: m[1], version: m[2] });
    } else if (file === 'Cargo.lock') {
      for (const m of text.matchAll(/\[\[package\]\]\s*\nname = "([^"]+)"\s*\nversion = "([^"]+)"/g)) out.push({ ecosystem: 'crates.io', name: m[1], version: m[2] });
    }
  } catch { /* unreadable manifest: nothing to look up */ }
  return out;
}
export const isManifest = (p) => { const f = basename(p); return f === 'package-lock.json' || f === 'go.mod' || f === 'Cargo.lock' || /^requirements.*\.txt$/.test(f); };

const key = (d) => `${d.ecosystem}\u001f${d.name}\u001f${d.version}`;

// Dependencies present at `to` that were absent, or at another version, at `from`.
export function newDeps(repo, from, to, paths) {
  const out = new Map();
  for (const p of paths.filter(isManifest)) {
    const before = new Set(from ? parseManifest(p, showFile(repo, from, p) || '').map(key) : []);
    for (const d of parseManifest(p, showFile(repo, to, p) || '')) if (!before.has(key(d))) out.set(key(d), { ...d, manifest: p });
  }
  return [...out.values()];
}

async function call(path, body) {
  const res = await fetch(OSV() + path, { method: body ? 'POST' : 'GET', headers: { 'content-type': 'application/json' }, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(10_000) });
  if (!res.ok) throw new Error('OSV answered ' + res.status);
  return res.json();
}

// -> { ok, findings: [{ package, version, ecosystem, manifest, id, summary, severity, fixed }], error }
export async function lookup(deps) {
  if (!deps.length) return { ok: true, findings: [] };
  try {
    const hits = [];
    for (let i = 0; i < deps.length; i += 500) {
      const part = deps.slice(i, i + 500);
      const r = await call('/v1/querybatch', { queries: part.map((d) => ({ package: { name: d.name, ecosystem: d.ecosystem }, version: d.version })) });
      (r.results || []).forEach((x, j) => { for (const v of (x && x.vulns) || []) hits.push({ dep: part[j], id: v.id }); });
    }
    const detail = new Map();
    for (const id of [...new Set(hits.map((h) => h.id))].slice(0, 40)) { try { detail.set(id, await call('/v1/vulns/' + encodeURIComponent(id))); } catch { /* keep the id alone */ } }
    const findings = hits.slice(0, 80).map((h) => {
      const v = detail.get(h.id) || {};
      const fixed = new Set();
      for (const a of v.affected || []) {
        if (a.package && a.package.name && a.package.name.toLowerCase() !== h.dep.name.toLowerCase()) continue;
        for (const rg of a.ranges || []) for (const ev of rg.events || []) if (ev.fixed) fixed.add(ev.fixed);
      }
      const sev = (v.database_specific && v.database_specific.severity) || ((v.severity || [])[0] || {}).score || '';
      return { package: h.dep.name, version: h.dep.version, ecosystem: h.dep.ecosystem, manifest: h.dep.manifest, id: h.id,
        summary: String(v.summary || '').replace(/[^\x20-\x7e]/g, ' ').slice(0, 160), severity: String(sev).slice(0, 60), fixed: [...fixed].slice(0, 4) };
    });
    return { ok: true, findings };
  } catch (e) {
    return { ok: false, findings: [], error: String(e.message || e).slice(0, 200) };
  }
}

// One SQLite file holds all live state. In-flight state is keyed by worktree,
// because a change belongs to a branch, not to whichever session happens to be
// attached to it.
import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import { createHash } from 'node:crypto';

// node:sqlite is stable enough to use but still prints a warning on load.
const emit = process.emit;
process.emit = function (name, data, ...rest) {
  if (name === 'warning' && data && data.name === 'ExperimentalWarning' && /SQLite/i.test(data.message)) return false;
  return emit.call(this, name, data, ...rest);
};
const { DatabaseSync } = await import('node:sqlite');

const SCHEMA = `
pragma journal_mode = wal;
pragma synchronous = normal;
create table if not exists files(path text primary key, oid text, data text);
create table if not exists sessions(id text primary key, short text, agent text, model text, worktree text, branch text, task text, started int, seen int, ended int);
create table if not exists reads(worktree text, node text, hash text, strength int, session text, ts int, primary key(worktree, node));
create table if not exists writes(worktree text, node text, path text, kind text, how text, sig_old text, sig_new text, session text, ts int, primary key(worktree, node));
create table if not exists refs(worktree text, path text, name text, primary key(worktree, path, name));
create table if not exists holds(node text primary key, worktree text, session text, ts int);
create table if not exists denied(session text, node text, primary key(session, node));
create table if not exists notices(id integer primary key, target text, node text, source text, severity text, kind text, body text, ts int, delivered int default 0, open int default 1, unique(target, node, source));
create table if not exists taint(worktree text, source text, ts int, primary key(worktree, source));
create table if not exists tainted_nodes(node text primary key, landing text);
create table if not exists spans(worktree text, path text, hash text, spans text, primary key(worktree, path));
create table if not exists wtfiles(worktree text, path text, stamp text, primary key(worktree, path));
create table if not exists landings(id text primary key, worktree text, branch text, commit_sha text, merge_sha text, status text, record text, ts int);
create table if not exists landed_nodes(landing text, node text, kind text, primary key(landing, node));
create index if not exists landed_nodes_node on landed_nodes(node);
create table if not exists events(seq integer primary key, ts int, type text, data text, hash text);
create table if not exists meta(k text primary key, v text);
`;

export function openStore(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(home, 'canopy.db'));
  db.exec(SCHEMA);
  const cache = new Map();
  const q = (sql) => { let s = cache.get(sql); if (!s) cache.set(sql, (s = db.prepare(sql))); return s; };
  const store = {
    db,
    run: (sql, ...a) => q(sql).run(...a),
    get: (sql, ...a) => q(sql).get(...a),
    all: (sql, ...a) => q(sql).all(...a),
    tx(fn) { db.exec('begin'); try { const r = fn(); db.exec('commit'); return r; } catch (e) { db.exec('rollback'); throw e; } },
    listeners: new Set(),
    // Append to the hash-chained event log and fan out to live listeners (the UI).
    event(type, data) {
      const ts = Date.now();
      const prev = store.get('select hash from events order by seq desc limit 1');
      const body = JSON.stringify(data);
      const hash = createHash('sha256').update((prev ? prev.hash : '') + ts + type + body).digest('hex').slice(0, 32);
      const r = store.run('insert into events(ts, type, data, hash) values(?,?,?,?)', ts, type, body, hash);
      const ev = { seq: Number(r.lastInsertRowid), ts, type, ...data };
      for (const l of store.listeners) { try { l(ev); } catch { /* listener went away */ } }
      return ev;
    },
    eventsHead: () => (store.get('select hash from events order by seq desc limit 1') || {}).hash || null,
  };
  return store;
}

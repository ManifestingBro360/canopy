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
create table if not exists sessions(id text primary key, short text, agent text, model text, worktree text, branch text, task text, started int, seen int, ended int, user text default '', ip text default '');
create table if not exists reads(worktree text, node text, hash text, strength int, session text, ts int, primary key(worktree, node));
create table if not exists writes(worktree text, node text, path text, kind text, how text, sig_old text, sig_new text, session text, ts int, primary key(worktree, node));
create table if not exists refs(worktree text, path text, name text, primary key(worktree, path, name));
create table if not exists holds(node text primary key, worktree text, session text, ts int);
create table if not exists denied(session text, node text, primary key(session, node));
create table if not exists notices(id integer primary key, target text, node text, source text, severity text, kind text, body text, ts int, delivered int default 0, open int default 1, unique(target, node, source));
create table if not exists taint(worktree text, source text, ts int, primary key(worktree, source));
create table if not exists tainted_nodes(node text primary key, landing text);
create table if not exists spans(worktree text, path text, hash text, spans text, primary key(worktree, path));
create table if not exists wtfiles(worktree text, path text, stamp text, seen_blob text default '', primary key(worktree, path));
create table if not exists landings(id text primary key, worktree text, branch text, commit_sha text, merge_sha text, status text, record text, ts int);
create table if not exists landed_nodes(landing text, node text, kind text, primary key(landing, node));
create index if not exists landed_nodes_node on landed_nodes(node);
create table if not exists events(seq integer primary key, ts int, type text, data text, hash text);
create table if not exists meta(k text primary key, v text);
create table if not exists users(name text primary key, role text, token_hash text unique, created int, disabled int default 0);
create table if not exists approvals(landing text, user text, commit_sha text, rules_hash text, basis text default '', ts int, primary key(landing, user));
create table if not exists authors(worktree text, path text, session text, user text, model text, agent text, how text, primary key(worktree, path, session, model, how));
create table if not exists promotions(id text primary key, env text, commit_sha text, status text, record text, ts int);
create table if not exists channels(name text primary key, url text, kind text, created int);
create table if not exists notified(key text primary key, ts int);
create table if not exists manager_notes(landing text primary key, summary text, findings text, ts int);
create table if not exists known(worktree text, node text, hash text, ts int, primary key(worktree, node));
create table if not exists audit(seq integer primary key, ts int, user text, ip text, action text, target text, detail text, hash text);
`;
// Columns added after 0.1. A database made by 0.1 gains them on first open.
// (Not named `oid`: in SQLite that is another name for a table's row id.)
const ADDED = [['sessions', 'user', "text default ''"], ['sessions', 'ip', "text default ''"], ['wtfiles', 'seen_blob', "text default ''"]];

export function openStore(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const db = new DatabaseSync(join(home, 'canopy.db'));
  db.exec(SCHEMA);
  for (const [t, c, type] of ADDED) {
    const has = () => db.prepare(`pragma table_info(${t})`).all().some((x) => x.name === c);
    if (!has()) db.exec(`alter table ${t} add column ${c} ${type}`);
    // A column that is not there would make every write fail quietly later; fail here instead.
    if (!has()) throw new Error(`canopy: could not add column ${t}.${c} to the database`);
  }
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
    // The audit log: who did what, from where. Hash-chained like the event log,
    // but never sent to the map and never written into Git.
    audit(who, action, target, detail) {
      const ts = Date.now(), user = (who && who.user) || '', ip = (who && who.ip) || '';
      const prev = store.get('select hash from audit order by seq desc limit 1');
      const body = JSON.stringify(detail || {});
      const hash = createHash('sha256').update((prev ? prev.hash : '') + ts + user + ip + action + String(target || '') + body).digest('hex').slice(0, 32);
      store.run('insert into audit(ts, user, ip, action, target, detail, hash) values(?,?,?,?,?,?,?)', ts, user, ip, action, String(target || ''), body, hash);
    },
  };
  return store;
}

// Notifications to where a team already talks: Slack, Discord, or any service
// that accepts a JSON webhook. Nobody has to watch a dashboard.
//
// Policy in Git, secrets in the daemon: the rules on main say which events go
// to which named channel; the webhook address of a channel is known only to
// canopyd (`canopy notify add`). Off until both exist. What is sent: names of
// branches and people, the stated purpose of a change, and the reasons a
// landing was held or refused. Never code, diffs or tokens.
import { createHash } from 'node:crypto';

export const KINDS = ['approval', 'security', 'blocked', 'landed', 'promotion'];
const NAME = /^[a-z0-9][a-z0-9._-]{0,39}$/;
// Text from branches, intents and models is untrusted: printable, bounded, and unable to ping anyone.
const clean = (s, n = 300) => String(s ?? '').replace(/[^\x20-\x7e]/g, ' ').replace(/@/g, '@​').replace(/</g, '‹').replace(/>/g, '›').replace(/\s+/g, ' ').trim().slice(0, n);

export function addChannel(store, name, url, kind) {
  if (!NAME.test(name)) throw new Error('a channel name is lower-case letters, digits, dot, dash, underscore');
  let u;
  try { u = new URL(url); } catch { throw new Error('that is not a URL'); }
  const local = ['127.0.0.1', 'localhost', '[::1]'].includes(u.hostname);
  if (u.protocol !== 'https:' && !(u.protocol === 'http:' && local)) throw new Error('a webhook address must be https');
  kind ||= /(^|\.)slack\.com$/.test(u.hostname) ? 'slack' : /(^|\.)discord(app)?\.com$/.test(u.hostname) ? 'discord' : 'json';
  if (!['slack', 'discord', 'json'].includes(kind)) throw new Error('kind is slack, discord or json');
  store.run('insert into channels(name, url, kind, created) values(?,?,?,?) on conflict(name) do update set url=excluded.url, kind=excluded.kind', name, url, kind, Date.now());
  store.audit({ user: 'operator' }, 'notify.channel', name, { kind, host: u.hostname });
  return { name, kind, host: u.hostname };
}
export function removeChannel(store, name) {
  if (!store.run('delete from channels where name=?', name).changes) throw new Error(`no channel named ${name}`);
  store.audit({ user: 'operator' }, 'notify.channel.remove', name, {});
}
// The address itself is never shown again: it is a credential.
export const listChannels = (store) => store.all('select name, url, kind from channels order by name').map((c) => ({ name: c.name, kind: c.kind, host: new URL(c.url).hostname }));

function body(kind, ev) {
  const lines = ev.lines.map((l) => clean(l)).filter(Boolean);
  if (kind === 'slack') return { text: `*${clean(ev.title, 150)}*\n${lines.join('\n')}` };
  if (kind === 'discord') return { content: `**${clean(ev.title, 150)}**\n${lines.join('\n')}`.slice(0, 1900), allowed_mentions: { parse: [] } };
  return { source: 'canopy', repo: ev.repo, kinds: ev.kinds, title: clean(ev.title, 150), lines, id: ev.id, branch: clean(ev.branch, 120), by: ev.by || null, waiting_on: ev.waiting || [] };
}

export async function send(channel, ev) {
  const res = await fetch(channel.url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body(channel.kind, ev)), signal: AbortSignal.timeout(6000), redirect: 'error' });
  if (!res.ok) throw new Error('the webhook answered ' + res.status);
}

export class Notifier {
  constructor(store, rules, repo) { this.store = store; this.rules = rules; this.repo = repo; this.sent = 0; this.failed = 0; this.inflight = new Set(); }

  // ev: { kinds: [...], title, lines: [...], id, branch, by, files: [...], waiting: [...], once }
  emit(ev) {
    try {
      const routes = (this.rules().notify || []).filter((r) => r.on.some((k) => ev.kinds.includes(k)) &&
        (!r.paths || !ev.files || ev.files.some((f) => r.paths.some((p) => p === '' || f === p || f.startsWith(p.endsWith('/') ? p : p + '/')))));
      if (!routes.length) return;
      // The same thing is said once: a retried landing or an agent's repeated attempt does not flood a channel.
      const key = createHash('sha256').update(ev.once || JSON.stringify([ev.kinds, ev.title, ev.lines])).digest('hex').slice(0, 24);
      const seen = this.store.get('select ts from notified where key=?', key);
      if (seen && Date.now() - seen.ts < 30 * 60_000) return;
      this.store.run('insert into notified(key, ts) values(?,?) on conflict(key) do update set ts=excluded.ts', key, Date.now());
      this.store.run('delete from notified where ts < ?', Date.now() - 7 * 86_400_000);
      for (const name of new Set(routes.map((r) => r.channel))) {
        const ch = this.store.get('select name, url, kind from channels where name=?', name);
        if (!ch) continue; // named in the rules, not yet given an address on this host
        const p = send(ch, { ...ev, repo: this.repo }).then(() => { this.sent++; }, (err) => { this.failed++; this.store.audit({ user: 'canopy' }, 'notify.failed', name, { why: String(err.message || err).slice(0, 120) }); })
          .finally(() => this.inflight.delete(p));
        this.inflight.add(p);
      }
    } catch { /* telling people must never get in the way of the gate */ }
  }
}

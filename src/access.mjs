// Who is asking. Users and their tokens live only in canopyd's database; a
// token is shown once when it is made and stored as a hash. Policy about what
// a user may do (owners, writers, promoters) lives in the rules on main.
//
// With no users defined, canopyd behaves as 0.1 did: requests are anonymous
// and a single human token approves. Once one user exists, landing, approving
// and promoting all need a valid user token.
import { createHash, randomBytes } from 'node:crypto';

const NAME_RE = /^[a-z0-9][a-z0-9._-]{0,39}$/;
export const hashToken = (t) => createHash('sha256').update(String(t)).digest('hex');

export function addUser(store, name, role = 'member') {
  if (!NAME_RE.test(name)) throw new Error('a user name is 1 to 40 characters: lower-case letters, digits, dot, dash, underscore');
  if (role !== 'admin' && role !== 'member') throw new Error('role is "admin" or "member"');
  if (store.get('select 1 x from users where name=?', name)) throw new Error(`user ${name} already exists`);
  const token = 'cnp_' + randomBytes(24).toString('base64url');
  store.run('insert into users(name, role, token_hash, created, disabled) values(?,?,?,?,0)', name, role, hashToken(token), Date.now());
  store.audit({ user: 'operator' }, 'user.add', name, { role });
  return token;
}

export function setDisabled(store, name, disabled) {
  const r = store.run('update users set disabled=? where name=?', disabled ? 1 : 0, name);
  if (!r.changes) throw new Error(`no user named ${name}`);
  store.audit({ user: 'operator' }, disabled ? 'user.disable' : 'user.enable', name, {});
}

export const listUsers = (store) => store.all('select name, role, created, disabled from users order by name');
export const usersExist = (store) => !!store.get('select 1 x from users limit 1');
export const activeUsers = (store) => new Set(store.all('select name from users where disabled=0').map((r) => r.name));
export const admins = (store) => store.all("select name from users where role='admin' and disabled=0").map((r) => r.name);

// The caller of one HTTP request: { user, role, ip }. `user` is '' when the
// request carries no valid user token.
export function identify(store, req) {
  let ip = String((req.socket && req.socket.remoteAddress) || '').replace(/^::ffff:/, '');
  if (process.env.CANOPY_TRUST_PROXY === '1' && req.headers['x-forwarded-for']) ip = String(req.headers['x-forwarded-for']).split(',')[0].trim().slice(0, 64);
  const m = /^Bearer\s+(\S+)$/.exec(String(req.headers.authorization || ''));
  if (m && m[1].startsWith('cnp_')) {
    const u = store.get('select name, role from users where token_hash=? and disabled=0', hashToken(m[1]));
    if (u) return { user: u.name, role: u.role, ip };
  }
  return { user: '', role: '', ip };
}

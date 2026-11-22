// Ed25519 signing of landing records. The private key never leaves canopyd.
import { generateKeyPairSync, createPrivateKey, createPublicKey, sign, verify, createHash } from 'node:crypto';
import { readFileSync, writeFileSync, existsSync, mkdirSync, chmodSync } from 'node:fs';
import { join } from 'node:path';

// Stable JSON: keys sorted at every level, so a record has exactly one byte form.
export function canon(v) {
  if (v === null || typeof v !== 'object') return JSON.stringify(v);
  if (Array.isArray(v)) return '[' + v.map(canon).join(',') + ']';
  return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + canon(v[k])).join(',') + '}';
}

export const keyId = (pubPem) => createHash('sha256').update(pubPem.replace(/\s+/g, '')).digest('hex').slice(0, 16);

export function loadOrCreateKey(home) {
  mkdirSync(home, { recursive: true, mode: 0o700 });
  const kp = join(home, 'key.pem'), pp = join(home, 'pub.pem');
  if (!existsSync(kp)) {
    const { publicKey, privateKey } = generateKeyPairSync('ed25519');
    writeFileSync(kp, privateKey.export({ type: 'pkcs8', format: 'pem' }), { mode: 0o600 });
    writeFileSync(pp, publicKey.export({ type: 'spki', format: 'pem' }), { mode: 0o644 });
  }
  chmodSync(kp, 0o600);
  const pub = readFileSync(pp, 'utf8');
  return { privateKey: createPrivateKey(readFileSync(kp)), pub, id: keyId(pub) };
}

export function signRecord(record, key) {
  const sig = sign(null, Buffer.from(canon(record)), key.privateKey).toString('base64');
  return JSON.stringify({ canopy: 1, key_id: key.id, sig, record });
}

// Returns the record when the note is validly signed by `pubPem`; throws otherwise.
export function verifyNote(noteText, pubPem) {
  let note;
  try { note = JSON.parse(noteText); } catch { throw new Error('landing record is not valid JSON'); }
  if (!note || note.canopy !== 1 || !note.record || typeof note.sig !== 'string') throw new Error('not a Canopy landing record');
  const ok = verify(null, Buffer.from(canon(note.record)), createPublicKey(pubPem), Buffer.from(note.sig, 'base64'));
  if (!ok) throw new Error('landing record signature does not verify');
  return note.record;
}

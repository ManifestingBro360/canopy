#!/usr/bin/env node
// Git pre-receive hook for the canonical repository.
//
// It lets `main` move only one landing at a time, and only to a commit that
// carries a landing record signed by the trusted Canopy key. The record must
// name this exact commit, its tree, and the commit main is moving from, so a
// record cannot be copied onto a different history. The notes ref that holds
// the records can only grow.
//
// Needs no database and no running canopyd: only Git and the public key in
// `git config canopy.pubkey` (base64 of the PEM).
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { verifyNote } from '../src/sign.mjs';

const ZERO = /^0+$/;
const g = (...args) => execFileSync('git', args, { encoding: 'utf8', stdio: ['pipe', 'pipe', 'pipe'], maxBuffer: 1 << 28 }).replace(/\n$/, '');
const ok = (...args) => { try { g(...args); return true; } catch { return false; } };
const fail = (msg) => { process.stderr.write(`canopy: refused - ${msg}\n`); process.exit(1); };

let pub;
try { pub = Buffer.from(g('config', '--get', 'canopy.pubkey'), 'base64').toString('utf8'); } catch { fail('this repository has no canopy.pubkey configured'); }
let main = 'main';
try { main = g('config', '--get', 'canopy.main'); } catch { /* default */ }
const MAIN = 'refs/heads/' + main, NOTES = 'refs/notes/canopy';

const updates = readFileSync(0, 'utf8').split('\n').filter(Boolean).map((l) => { const [old, neu, ref] = l.split(' '); return { old, neu, ref }; });
const notesUp = updates.find((u) => u.ref === NOTES);
let notesTip = notesUp ? notesUp.neu : null;
if (!notesTip) { try { notesTip = g('rev-parse', '--verify', '--quiet', NOTES); } catch { notesTip = null; } }

// A note for commit `sha` inside the notes commit `tip`. Git fans note paths
// out into directories once there are many, so try each layout.
function noteFor(tip, sha) {
  if (!tip || ZERO.test(tip)) return null;
  for (const p of [sha, sha.slice(0, 2) + '/' + sha.slice(2), sha.slice(0, 2) + '/' + sha.slice(2, 4) + '/' + sha.slice(4)]) {
    try { return g('cat-file', '-p', `${tip}:${p}`); } catch { /* next layout */ }
  }
  return null;
}

for (const u of updates) {
  if (u.ref === NOTES) {
    if (ZERO.test(u.neu)) fail('landing records cannot be deleted');
    if (!ZERO.test(u.old)) {
      if (!ok('merge-base', '--is-ancestor', u.old, u.neu)) fail('landing records cannot be rewritten');
      const changes = g('diff-tree', '-r', '--name-status', '--no-renames', u.old, u.neu).split('\n').filter(Boolean);
      for (const c of changes) if (c[0] !== 'A') fail('existing landing records cannot be changed or removed');
    }
  }
  if (u.ref !== MAIN) continue;
  if (ZERO.test(u.neu)) fail(`${main} cannot be deleted`);
  if (ZERO.test(u.old)) continue; // first push that creates main: nothing to compare against
  if (!ok('merge-base', '--is-ancestor', u.old, u.neu)) fail(`${main} cannot be rewound or force-pushed`);
  const chain = g('rev-list', '--first-parent', '--reverse', `${u.old}..${u.neu}`).split('\n').filter(Boolean);
  let prev = u.old;
  for (const c of chain) {
    const note = noteFor(notesTip, c);
    if (!note) fail(`${c.slice(0, 10)} has no landing record. ${main} only accepts commits landed by Canopy; use \`canopy land\`.`);
    let rec;
    try { rec = verifyNote(note, pub); } catch (e) { fail(`${c.slice(0, 10)}: ${e.message}`); }
    const parents = g('rev-list', '--parents', '-n', '1', c).split(' ').slice(1);
    const tree = g('rev-parse', c + '^{tree}');
    if (rec.verdict !== 'land') fail(`${c.slice(0, 10)}: its record is not a landing verdict`);
    if (rec.commit !== c) fail(`${c.slice(0, 10)}: its record was signed for a different commit`);
    if (rec.tree !== tree) fail(`${c.slice(0, 10)}: its record was signed for different content`);
    if (rec.base !== prev || parents[0] !== prev) fail(`${c.slice(0, 10)}: its record was signed for a different position in history`);
    prev = c;
  }
  if (prev !== u.neu) fail(`${main} must move along first-parent landings only`);
}
process.exit(0);

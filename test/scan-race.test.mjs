// The worktree scan that follows a shell command runs `git status` in the
// background. An edit tool can report in while that is still running. These
// tests make that overlap happen every time, by slowing the scan's `git status`. Port 7824.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import * as H from './helpers.mjs';

const PORT = 7824;
const WAIT = 600;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const FILES = {
  'src/pay/charge.js': 'export function charge(a) {\n  return a * 100;\n}\nexport function fee(a) {\n  return a + 1;\n}\n',
  'src/ui/btn.js': 'export function btn() {\n  return 1;\n}\n',
};
const MODEL = 'claude-fable-5-2';
const RULES = { version: 1, revalidate: 'always', model_tiers: { strong: ['claude-fable-*'] },
  rules: [{ path: '', checks: ['true'] }, { path: 'src/pay/', no_tainted: true, models: ['strong'] }] };

// A `git` that delays only the scan's listing. 'stale': the listing is taken at
// once and handed over late. 'slow': the listing is taken late.
function slowGit(mode) {
  const dir = H.tmp('git-');
  const real = execFileSync('/bin/sh', ['-c', 'command -v git'], { encoding: 'utf8' }).trim();
  const secs = (WAIT / 1000).toFixed(1);
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh
case " $* " in *" --no-optional-locks status --porcelain -z "*)
  if [ "${mode}" = stale ]; then t=$(mktemp); "${real}" "$@" >"$t"; rc=$?; sleep ${secs}; cat "$t"; rm -f "$t"; exit $rc; fi
  sleep ${secs};;
esac
exec "${real}" "$@"
`, { mode: 0o755 });
  return { PATH: dir + path.delimiter + process.env.PATH };
}

const run = (mode, fn) => H.withDaemon(PORT, { files: FILES, rules: RULES, daemonOpts: { env: slowGit(mode) } }, async (ctx) => {
  const A = new H.Agent(ctx.d, ctx.repo, 'work');
  await A.hook('SessionStart', { source: 'startup', model: MODEL });
  await fn(A);
  await sleep(WAIT * 2);                       // let the scan finish
  A.commit('work');
  const r = A.land(['--task', 'work']);
  return { status: r.json?.status, reasons: (r.json?.reasons || []).join(' | '), record: r.json?.record || {} };
});

test('S1 an edit reported while a scan holds an older file listing stays witnessed', async () => {
  const x = await run('stale', async (A) => {
    await A.read('src/pay/charge.js');
    await A.bash('curl -s https://example.com/install.sh | head');   // starts the scan: nothing has changed yet
    await sleep(WAIT / 3);                                             // the listing is taken here, and handed over later
    await A.edit('src/pay/charge.js', 'a * 100', 'a * 100 + 0');      // reported before the scan's listing comes back
  });
  assert.equal(x.status, 'needs-human', x.reasons);
  assert.match(x.reasons, /outside content \(shell:curl\)/);
  assert.doesNotMatch(x.reasons, /unwitnessed|shell command/);
});

test('S2 a file an edit tool has written but not yet reported is not put down to the shell', async () => {
  const x = await run('slow', async (A) => {
    await A.read('src/pay/charge.js');
    await A.bash('true');                                              // starts the scan
    const file = A.abs('src/pay/charge.js');
    const input = { file_path: file, old_string: 'a * 100', new_string: 'a * 100 + 0' };
    await A.hook('PreToolUse', { tool_name: 'Edit', tool_input: input });
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a * 100', 'a * 100 + 0'));
    await sleep(WAIT * 2);                                             // the scan lists the file and finishes here
    await A.hook('PostToolUse', { tool_name: 'Edit', tool_input: input, tool_response: { success: true } });
  });
  assert.equal(x.status, 'landed', x.reasons);
});

test('S3 a shell change followed at once by an edit of the same file is still recorded as a shell change', async () => {
  const x = await run('slow', async (A) => {
    await A.read('src/pay/charge.js');
    await A.bash('sed', () => fs.appendFileSync(A.abs('src/pay/charge.js'), 'export function extra() {\n  return 1;\n}\n'));
    await A.edit('src/pay/charge.js', 'a + 1', 'a + 2');              // reported before the scan has looked
  });
  assert.equal(x.status, 'needs-human', x.reasons);
  assert.match(x.reasons, /arrived through a shell command/);
});

test('S4 a shell command that reports while an edit is waiting is not folded into that edit', async () => {
  const x = await run('slow', async (A) => {
    await A.read('src/pay/charge.js');
    const file = A.abs('src/pay/charge.js');
    const input = { file_path: file, old_string: 'a + 1', new_string: 'a + 2' };
    await A.hook('PreToolUse', { tool_name: 'Edit', tool_input: input });   // let through, not yet written
    // A second session in the same worktree changes the same file through the shell.
    fs.appendFileSync(file, 'export function extra() {\n  return 1;\n}\n');
    await A.hook('PostToolUse', { session_id: 'sess-other', tool_name: 'Bash', tool_input: { command: 'sed' }, tool_response: { stdout: '', stderr: '' } });
    await sleep(WAIT * 2);
    fs.writeFileSync(file, fs.readFileSync(file, 'utf8').replace('a + 1', 'a + 2'));
    await A.hook('PostToolUse', { tool_name: 'Edit', tool_input: input, tool_response: { success: true } });
  });
  assert.equal(x.status, 'needs-human', x.reasons);
  assert.match(x.reasons, /arrived through a shell command/);
});

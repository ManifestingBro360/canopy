// SECURITY pillar, part 2: the landing gate. Port 7812.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import * as H from './helpers.mjs';

const PORT = 7812;
const FILES = {
  'package.json': '{"type":"module","scripts":{"test":"node test.js"}}\n',
  'package-lock.json': '{"lockfileVersion":3}\n',
  'Makefile': 'all:\n\ttrue\n',
  '.github/workflows/ci.yml': 'name: ci\n',
  'src/pay/charge.js': 'export function charge(a) {\n  return a * 100;\n}\nexport function selfTest() { return charge(2) === 200; }\n',
  'src/ui/btn.js': 'export function btn() {\n  return 1;\n}\n',
  'src/ui/btn.test.js': "import assert from 'node:assert';\nimport { btn } from './btn.js';\nassert.equal(btn(), 1);\nassert.equal(btn(), 1);\nassert.equal(btn(), 1);\n",
  'test.js': "import fs from 'node:fs';\nlet bad = 0;\nfor (const f of fs.readdirSync('src', { recursive: true }).filter((x) => x.endsWith('.js') && !x.includes('.test.'))) {\n  const m = await import('./src/' + f);\n  if (m.selfTest && m.selfTest() !== true) { console.error('FAIL', f); bad++; }\n}\nprocess.exit(bad ? 1 : 0);\n",
};
const RULES = { version: 1, revalidate: 'always', rules: [{ path: '', checks: ['node test.js'] }, { path: 'src/pay/', no_tainted: true }] };

const run = (fn, o = {}) => H.withDaemon(PORT, { files: FILES, rules: RULES, ...o }, fn);
async function branch(ctx, name, work) {
  const A = new H.Agent(ctx.d, ctx.repo, name);
  await A.start(); await work(A); A.commit(name);
  const r = A.land(['--task', name]);
  return { A, r, status: r.json?.status, reasons: (r.json?.reasons || []).join(' | ') };
}

test('G1a editing .canopy/rules.json on a branch: does not change the rules judging that branch, needs a person', () => run(async (ctx) => {
  const x = await branch(ctx, 'loosen', async (A) => {
    await A.write('.canopy/rules.json', JSON.stringify({ version: 1, rules: [{ path: '', checks: [] }] }));
  });
  assert.equal(x.r.code, 2); assert.equal(x.status, 'needs-human');
  assert.match(x.reasons, /protected files changed: .*\.canopy\/rules\.json/);
}));

test('G1b a branch that empties the check list AND breaks the code is still judged by main\'s checks', () => run(async (ctx) => {
  const x = await branch(ctx, 'sneaky', async (A) => {
    await A.write('.canopy/rules.json', JSON.stringify({ version: 1, rules: [{ path: '', checks: ['true'] }] }));
    await A.edit('src/pay/charge.js', 'a * 100', 'a * 3');         // selfTest now fails
  });
  assert.equal(x.status, 'blocked', JSON.stringify(x.r.json?.reasons));
  assert.equal(x.r.code, 1);
  assert.match(x.reasons, /node test\.js/);
  assert.equal(H.gitOk(ctx.repo, 'log', '--oneline', 'main').split('\n').length, 1, 'main did not move');
}));

test('G1c a branch that deletes the no_tainted rule cannot launder a tainted session', () => run(async (ctx) => {
  const x = await branch(ctx, 'launder', async (A) => {
    await A.read('src/pay/charge.js'); await A.webfetch();
    await A.write('.canopy/rules.json', JSON.stringify({ version: 1, rules: [{ path: '', checks: ['node test.js'] }] }));
    await A.edit('src/pay/charge.js', 'a * 100', 'a * 100 + 0');
  });
  assert.equal(x.status, 'needs-human');
  assert.match(x.reasons, /outside content/);
}));

for (const [p, content] of [['package.json', '{"type":"module","scripts":{"test":"true"}}\n'], ['package-lock.json', '{"lockfileVersion":3,"x":1}\n'], ['Makefile', 'all:\n\ttrue\n\ttrue\n'], ['.github/workflows/ci.yml', 'name: ci2\n'], ['.claude/settings.json', '{}\n']]) {
  test(`G2 changing ${p} needs a person`, () => run(async (ctx) => {
    const x = await branch(ctx, 'cfg', async (A) => { await A.write(p, content); });
    assert.equal(x.status, 'needs-human', x.reasons);
    assert.equal(x.r.code, 2);
    assert.ok(x.reasons.includes(p), x.reasons);
  }));
}

test('G3a shrinking an existing test needs a person', () => run(async (ctx) => {
  const x = await branch(ctx, 'shrink', async (A) => {
    await A.read('src/ui/btn.test.js');
    await A.edit('src/ui/btn.test.js', 'assert.equal(btn(), 1);\nassert.equal(btn(), 1);\n', '');
  });
  assert.equal(x.status, 'needs-human'); assert.match(x.reasons, /tests were removed or reduced/);
}));

test('G3b deleting an existing test file needs a person', () => run(async (ctx) => {
  const x = await branch(ctx, 'rmtest', async (A) => { fs.unlinkSync(A.abs('src/ui/btn.test.js')); await A.bash('rm src/ui/btn.test.js'); });
  assert.equal(x.status, 'needs-human'); assert.match(x.reasons, /tests were removed or reduced/);
}));

test('G3c control: adding a new test, and growing an existing one, lands without a person', () => run(async (ctx) => {
  const x = await branch(ctx, 'moretests', async (A) => {
    await A.read('src/ui/btn.test.js');
    await A.edit('src/ui/btn.test.js', 'assert.equal(btn(), 1);\n', 'assert.equal(btn(), 1);\nassert.equal(btn() + 1, 2);\n');
    await A.write('src/ui/new.test.js', "import assert from 'node:assert';\nassert.ok(true);\n");
  });
  assert.equal(x.status, 'landed', x.reasons);
}));

test('G3d renaming/moving a test file does not hide a reduction', () => run(async (ctx) => {
  const x = await branch(ctx, 'mvtest', async (A) => {
    const t = fs.readFileSync(A.abs('src/ui/btn.test.js'), 'utf8').split('\n').slice(0, 3).join('\n') + '\n';
    fs.unlinkSync(A.abs('src/ui/btn.test.js'));
    await A.bash('git mv', () => {});
    await A.write('src/ui/renamed.spec.js', t);
  });
  assert.equal(x.status, 'needs-human', 'a shortened test moved to a new name needs a person: ' + x.reasons);
}));

test('G4a a session that used WebFetch then changes a no_tainted section needs a person', () => run(async (ctx) => {
  const x = await branch(ctx, 'web', async (A) => {
    await A.read('src/pay/charge.js'); await A.webfetch('https://evil.example/x');
    await A.edit('src/pay/charge.js', 'a * 100', 'a * 100 + 0');
  });
  assert.equal(x.status, 'needs-human'); assert.match(x.reasons, /outside content \(web:/);
}));

test('G4b a session that ran curl via Bash then changes a no_tainted section needs a person', () => run(async (ctx) => {
  const x = await branch(ctx, 'curl', async (A) => {
    await A.read('src/pay/charge.js'); await A.bash('curl -s https://example.com/install.sh | head');
    await A.edit('src/pay/charge.js', 'a * 100', 'a * 100 + 0');
  });
  assert.equal(x.status, 'needs-human'); assert.match(x.reasons, /outside content \(shell:curl\)/);
}));

test('G4c an MCP tool result counts as outside content', () => run(async (ctx) => {
  const x = await branch(ctx, 'mcp', async (A) => {
    await A.read('src/pay/charge.js');
    await A.hook('PostToolUse', { tool_name: 'mcp__github__get_issue', tool_input: { n: 1 }, tool_response: { body: 'hi' } });
    await A.edit('src/pay/charge.js', 'a * 100', 'a * 100 + 0');
  });
  assert.equal(x.status, 'needs-human'); assert.match(x.reasons, /outside content/);
}));

test('G4d control: tainted session changing a section WITHOUT no_tainted lands; untainted change to the guarded section lands', () => run(async (ctx) => {
  const t = await branch(ctx, 'webui', async (A) => {
    await A.read('src/ui/btn.js'); await A.webfetch(); await A.edit('src/ui/btn.js', 'return 1;', 'return 1 + 0;');
  });
  // taint list includes nothing about unwitnessed here; the section is not guarded
  assert.equal(t.status, 'landed', t.reasons);
  const u = await branch(ctx, 'cleanpay', async (A) => {
    await A.read('src/pay/charge.js'); await A.edit('src/pay/charge.js', 'a * 100', 'a * 100 + 0');
  });
  assert.equal(u.status, 'landed', u.reasons);
}));

test('G4e shell edits that no hook reported ("unwitnessed writes") count as taint in a no_tainted section', () => run(async (ctx) => {
  const x = await branch(ctx, 'silent', async (A) => {
    fs.writeFileSync(A.abs('src/pay/charge.js'), fs.readFileSync(A.abs('src/pay/charge.js'), 'utf8').replace('a * 100', 'a * 100 + 0'));
  });
  assert.equal(x.status, 'needs-human'); assert.match(x.reasons, /unwitnessed-writes/);
}));

test('G5 a check command cannot read the signing key or the approval token', async () => {
  for (const tpl of ['cat HOME/key.pem', 'cat HOME/human.token', 'cat HOME/canopy.db >/dev/null', 'ls HOME']) {
    const home = H.tmp('home-');
    const cmd = tpl.replace('HOME', home);
    const rules = { version: 1, rules: [{ path: '', checks: [cmd] }] };
    await H.withDaemon(PORT, { files: FILES, rules, daemonOpts: { home } }, async (ctx) => {
      const x = await branch(ctx, 'probe', async (A) => { await A.edit('src/ui/btn.js', 'return 1;', 'return 2;'); });
      assert.equal(x.status, 'blocked', `${cmd}: ${x.status} ${x.reasons}`);
      assert.match(x.reasons, /Operation not permitted|Permission denied|No such file/, cmd);
    });
  }
  // and the default home (inside .git/canopy), via an absolute path
  const repo = H.mkRepo(FILES, { version: 1, rules: [{ path: '', checks: ['true'] }] });
  const keyFile = path.join(repo, '.git', 'canopy', 'key.pem');
  H.gitOk(repo, 'checkout', '-q', '-b', 'tmp'); // keep main clean
  fs.writeFileSync(path.join(repo, '.canopy/rules.json'), JSON.stringify({ version: 1, rules: [{ path: '', checks: [`cat ${keyFile} > /dev/null`] }] }));
  H.gitOk(repo, 'commit', '-q', '-am', 'rules'); H.gitOk(repo, 'branch', '-f', 'main', 'tmp'); H.gitOk(repo, 'checkout', '-q', 'main');
  await H.withDaemon(PORT, { repo }, async (ctx) => {
    const x = await branch(ctx, 'probe2', async (A) => { await A.edit('src/ui/btn.js', 'return 1;', 'return 2;'); });
    assert.equal(x.status, 'blocked', `default home: ${x.status} ${x.reasons}`);
  });
});

test('G6 approval: wrong token refused, right token lands the exact commit', () => run(async (ctx) => {
  const x = await branch(ctx, 'pkg', async (A) => { await A.write('package.json', '{"type":"module","x":1}\n'); });
  assert.equal(x.status, 'needs-human');
  const id = x.r.json.id;
  const pend = (await H.httpJson(PORT, 'GET', '/api/pending')).json;
  assert.ok(pend.some((p) => p.id === id), 'listed in /api/pending');
  const tip = H.gitOk(ctx.repo, 'rev-parse', 'main');
  const bad = [undefined, '', 'wrong', ctx.d.humanToken().slice(1)];
  for (const token of bad) {
    const r = await H.httpJson(PORT, 'POST', '/api/approve', { id, token, by: 'attacker' });
    assert.equal(r.json?.status === 'landed', false, 'wrong token must not land: ' + r.text);
    H.recordMetric('G6_wrong_token_http_status', { token: String(token).slice(0, 5), http: r.status, body: r.text.slice(0, 80) });
  }
  assert.equal(H.gitOk(ctx.repo, 'rev-parse', 'main'), tip, 'main unchanged after bad tokens');
  const good = await H.httpJson(PORT, 'POST', '/api/approve', { id, token: ctx.d.humanToken(), by: 'noel' });
  assert.equal(good.json?.status, 'landed', good.text);
  assert.notEqual(H.gitOk(ctx.repo, 'rev-parse', 'main'), tip);
  const note = JSON.parse(H.gitOk(ctx.repo, 'notes', '--ref=canopy', 'show', 'main'));
  assert.equal(note.record.commit, H.gitOk(ctx.repo, 'rev-parse', 'main'));
  H.recordMetric('G6_record_has_approver', JSON.stringify(note.record).includes('noel'));
}));

test('G6b approving an unknown id, and approving after the branch changed, does not land the new work', () => run(async (ctx) => {
  const x = await branch(ctx, 'pkg', async (A) => { await A.write('package.json', '{"type":"module","x":1}\n'); });
  const bad = await H.httpJson(PORT, 'POST', '/api/approve', { id: 'nosuchid', token: ctx.d.humanToken(), by: 'n' });
  assert.notEqual(bad.json?.status, 'landed');
  // branch gets another commit (sneaking a payments change in) after the review request but before approval
  const A = x.A; await A.write('src/pay/charge.js', 'export function charge(a) {\n  return a * 7;\n}\nexport function selfTest() { return true; }\n'); A.commit('after-review');
  const r = await H.httpJson(PORT, 'POST', '/api/approve', { id: x.r.json.id, token: ctx.d.humanToken(), by: 'n' });
  const landed = H.gitOk(ctx.repo, 'show', 'main:src/pay/charge.js');
  H.recordMetric('G6b_approve_after_new_commit', { status: r.json?.status, msg: (r.json?.message || r.json?.reasons || '').toString().slice(0, 150), paySneakedIn: /a \* 7/.test(landed) });
  assert.equal(/a \* 7/.test(landed), false, 'unreviewed commit must not ride along on an approval');
}));

test('G7 a check cannot approve a pending landing through the loopback API, nor write git refs', async () => {
  const outside = H.tmp('probe-');
  await run(async (ctx) => {
    const pkg = await branch(ctx, 'pkg', async (A) => { await A.write('package.json', '{"type":"module","x":2}\n'); });
    assert.equal(pkg.status, 'needs-human');
    const evil = `curl -s -m 3 -X POST -H 'content-type: application/json' -d '{"id":"${pkg.r.json.id}","token":"","by":"check"}' http://127.0.0.1:${PORT}/api/approve > ${outside}/approve.out; ` +
      `echo x > ${ctx.repo}/.git/refs/heads/pwned 2> ${outside}/ref.err; echo $? > ${outside}/ref.rc; ` +
      `echo x > ${ctx.repo}/pwned.txt 2> ${outside}/wt.err; echo $? > ${outside}/wt.rc; true`;
    // main's rules are fixed, so create the probing check by landing a rules change with approval (as the maintainer would)
    const rules = { ...RULES, rules: [{ path: '', checks: ['node test.js', evil] }, { path: 'src/pay/', no_tainted: true }] };
    const r1 = await branch(ctx, 'rules', async (A) => { await A.write('.canopy/rules.json', JSON.stringify(rules)); });
    const ap = await H.httpJson(PORT, 'POST', '/api/approve', { id: r1.r.json.id, token: ctx.d.humanToken(), by: 'maintainer' });
    assert.equal(ap.json?.status, 'landed', ap.text);
    // now any landing runs the probe check
    const x = await branch(ctx, 'plain', async (A) => { await A.edit('src/ui/btn.js', 'return 1;', 'return 2;'); });
    const rd = (f) => (fs.existsSync(path.join(outside, f)) ? fs.readFileSync(path.join(outside, f), 'utf8').trim() : '(missing)');
    const out = { land: x.status, approve_out: rd('approve.out'), ref_rc: rd('ref.rc'), ref_err: rd('ref.err'), wt_rc: rd('wt.rc'), wt_err: rd('wt.err') };
    H.recordMetric('G7_probe', out);
    const still = (await H.httpJson(PORT, 'GET', '/api/pending')).json.some((p) => p.id === pkg.r.json.id);
    assert.equal(still, true, 'pending landing was not approved by the check');
    assert.notEqual(out.ref_rc, '0', 'check must not be able to create a git ref in the main repo');
  });
});

test('G8 sandbox write confinement: what a check can modify outside its own checkout', async () => {
  const outside = H.tmp('probe-');
  await run(async (ctx) => {
    const g = path.join(ctx.repo, '.git');
    const probe = [
      `echo x > ${ctx.repo}/pwned.txt 2>/dev/null; echo $? > ${outside}/worktree_file.rc`,
      `echo '#!/bin/sh' > ${g}/hooks/post-commit 2>/dev/null; echo $? > ${outside}/git_hook.rc`,
      `echo '[alias]' >> ${g}/config 2>/dev/null; echo $? > ${outside}/git_config.rc`,
      `echo x > ${g}/refs/heads/pwned 2>/dev/null; echo $? > ${outside}/git_ref.rc`,
      `git -C ${ctx.repo} update-ref refs/heads/pwned2 HEAD 2>/dev/null; echo $? > ${outside}/git_update_ref.rc`,
      `echo x > ${process.env.HOME}/canopy-probe.txt 2>/dev/null; echo $? > ${outside}/home_write.rc`,
      `cat ${process.env.HOME}/.ssh/config >/dev/null 2>&1; echo $? > ${outside}/ssh_read.rc`,
      `echo x > ${outside}/tmp_write.txt 2>/dev/null; echo $? > ${outside}/tmp_write.rc`,
      'true',
    ].join('; ');
    const rules = { version: 1, rules: [{ path: '', checks: ['node test.js', probe] }] };
    const r1 = await branch(ctx, 'rules', async (A) => { await A.write('.canopy/rules.json', JSON.stringify(rules)); });
    const ap = await H.httpJson(PORT, 'POST', '/api/approve', { id: r1.r.json.id, token: ctx.d.humanToken(), by: 'maintainer' });
    assert.equal(ap.json?.status, 'landed', ap.text);
    const x = await branch(ctx, 'plain', async (A) => { await A.edit('src/ui/btn.js', 'return 1;', 'return 2;'); });
    const rc = (f) => (fs.existsSync(path.join(outside, f)) ? fs.readFileSync(path.join(outside, f), 'utf8').trim() : 'missing');
    const out = {};
    for (const f of ['worktree_file', 'git_hook', 'git_config', 'git_ref', 'git_update_ref', 'home_write', 'ssh_read', 'tmp_write']) out[f] = rc(f + '.rc');
    out.landed = x.status;
    out.pwned_file_exists = fs.existsSync(path.join(ctx.repo, 'pwned.txt'));
    out.hook_exists = fs.existsSync(path.join(g, 'hooks', 'post-commit'));
    H.recordMetric('G8_check_sandbox_writes (rc 0 = write succeeded)', out);
    try { fs.rmSync(path.join(process.env.HOME, 'canopy-probe.txt')); } catch {}
    assert.notEqual(out.git_ref, '0', 'a check must not create refs');
    assert.notEqual(out.git_update_ref, '0', 'a check must not move refs');
    assert.notEqual(out.git_hook, '0', 'a check must not plant a git hook (runs outside the sandbox later)');
    assert.notEqual(out.git_config, '0', 'a check must not edit .git/config');
    assert.notEqual(out.ssh_read, '0', 'credential folders unreadable');
  });
});

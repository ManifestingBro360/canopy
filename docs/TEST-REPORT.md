# Canopy test report

Written by an independent tester who treated Canopy as a black box (README and
the project brief only; `src/` was opened only to explain a failure already
observed). Machine: macOS arm64, Node 22.22.0, Git 2.54. All numbers below were
measured, including the bad ones.

## How to reproduce

```
cd canopy
node --test test/          # whole suite, one process, files one after another (about 4 minutes)
node --test                # same files, each in its own process, in parallel (faster, noisier timings)
node --test test/quality.test.mjs   # one file
```

* Node 22 passes a directory argument straight to `node`, so `node --test test/`
  fails with "Cannot find module .../test" unless the directory has an
  `index.js`. The suite ships `test/index.js` and `test/package.json` for that
  reason (see defect D9). Without them `npm test` as written in `package.json`
  fails.
* Only `node:test` and Node built-ins are used. Each test builds throwaway repos
  under `os.tmpdir()`, starts `canopyd` as a child process (ports 7810-7823, one
  port per file), edits files for real in separate Git worktrees, POSTs the
  matching hook payloads, and lands through the CLI (`land --json`). Servers are
  always killed. Git identity comes from env vars only.
* Measured numbers are printed as `# METRIC name = value` lines in the test
  output and appended to `$TMPDIR/canopy-test-metrics.jsonl`.
* Simulated agents: the suite does not run a real Claude Code session. It sends
  the hook payload shapes described in the README (see "Not tested").

## Important: the product changed while it was being tested

`src/` was edited by someone else between 22:43 and 22:49 on the test day. I ran
the full suite twice: once before those edits ("snapshot 1") and once after
("snapshot 2"). Two defects I found in snapshot 1 (D1, D2) no longer reproduce in
snapshot 2. Tables show snapshot 2 unless stated; the defect list says which
snapshot showed what.

`test/regressions.test.mjs` is **not mine** (it was added to the folder during my
work, uses port 7860). It is loaded by `node --test test/` and its 10 tests all
failed in my snapshot-2 run with "fetch failed" (its daemon was unreachable). I did
not investigate and do not count them below.

## Scoreboard (my 83 tests, snapshot 2)

| Pillar | Tests | Pass | Fail |
|---|---|---|---|
| Quality (collisions, landing gate, rules, CLI workflow) | 28 | 26 | 2 (Q10, R10) |
| Security (pre-receive hook, gate, sandbox, HTTP) | 36 | 35 | 1 (A3) |
| Context | 4 | 4 | 0 |
| Performance (+ comparison with a plain baseline) | 10 | 10 | 0 (limits in my tests are loose; the numbers are the result) |
| Maintainability | 5 | 4 | 1 (M4) |
| **Total** | **83** | **79** | **4** |

A "fail" is a test whose assertion states what the README or BRIEF implies and the
product did not do. A "pass" can still carry a finding; see the Notes column and
the defect list.

---

## Quality

Fixture: a tiny JS project (`charge`, `cart`, `util`) whose `test.js` imports every
module under `src/` and runs its `selfTest()`. Check = `node test.js`.

| ID | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| Q1 | Two agents edit the same function | Second is denied once, retry is allowed with a warning, a third edit is not denied again | Exactly that. Denial text names the other branch and offers `canopy wait`; the denied edit did not touch the file | Pass |
| Q2 | A changes `charge` signature; B had read it | B's next hook response carries a high notice with old and new signature | Notice in B's very next hook, 396 characters, not shown to A | Pass |
| Q3 | B writes new code calling `charge` while A's signature change is in flight | B is told | Notice arrives in B's hook response ("You reference it in code you are writing") | Pass |
| Q4 | Clean text merge, broken behaviour: A changes signature and lands, B's branch still calls the old form (B has a self-test for it) | B blocked at landing; main never holds a failing state | B: `blocked`, exit 1, reason `check node test.js failed ... FAIL invoice.js`. Both branches pass their own tests alone, text merge is clean. All first-parent commits of main pass `test.js` | Pass |
| Q5a | A reverts the change through the edit tool | Notice retracted | High notice closed, a low "Retraction" notice is delivered to B once, then silence | Pass |
| Q5b | A reverts with `git checkout` through a shell command | Same | Retracted 28 ms after the Bash hook | Pass |
| Q6 | A edits through a shell command (Bash hook) | Detected, reader notified, creates a hold | Detected as `how: shell`, kind `signature`, 28-43 ms after the hook; B notified; B's own edit of that function denied | Pass |
| Q7 | 25 pairs of unrelated edits (50 edits, two agents, shared read-only helper) | 0 denials, 0 high notices | 0 denials, 0 high notices, 0 notices of any kind, both branches landed | Pass |
| Q8 | Hook paths and cwd in the symlinked form (`/var/...` instead of `/private/var/...`) | Same behaviour as real paths | Writes and reads recorded against repo-relative names, notice delivered, collision denied, `land` from the symlinked cwd works | Pass |
| Q9 | Agent runs `git add` immediately after a Bash hook, 40 times | No failures | Snapshot 1: 2-5 of 40 failed with `index.lock` exists. Snapshot 2: 0 of 40 (3 repeat runs) | Pass now (was D2) |
| Q10 | Same as Q4 but no test covers B's new call | Not landed silently | Record lists the stale assumption (`src/pay.js#charge` signature), verdict is still `landed` | **Fail** (D4) |
| W1 | `canopy wait 'src/pay.js#charge'` | Blocks until the other change lands, then exit 0 | Still blocked after 1.5 s, exited 0 within 1 ms of the landing returning | Pass |
| W2 | `canopy release` | Holds and in-flight record dropped | Yes; other agent no longer denied | Pass |
| W3 | `status`, `pending`, `approve`, exit codes of `land` | 0 landed, 2 needs a person, 1 blocked | As documented. Landing a branch with no changes returns exit 0 / `nothing` | Pass |
| B3 x4 | Two interacting branches land at the same moment under `revalidate: "disjoint"` (new file calling old signature; new function in existing file; extra call inside existing caller; and the same pair under `always`) | The later one is re-checked and blocked | Snapshot 2: all blocked, main clean. Snapshot 1: "new file" and "new function" cases landed both branches and main contained a failing commit (D1) | Pass now (was D1) |
| R1 | `min_coverage` 0.8 on a section | Unread dependents need a person; reading them lands | Coverage 0% -> needs a person; after reading both callers coverage 100% -> landed | Pass |
| R2 | `max_changed_lines` | Over the limit needs a person | Yes | Pass |
| R3 | `protected` section, `protected_globs` | Any change needs a person | Yes | Pass |
| R4 | `perf` budget | Over budget does not land | `blocked`: "`sleep 0.5` took 522 ms, budget 100 ms" | Pass |
| R5 | `setup` | Runs before checks; failing setup blocks | Yes | Pass |
| R6 | `no_unwitnessed` | File changed with no agent activity needs a person | Yes | Pass |
| R7 | Child rule cannot loosen parent | Parent check still applies | Yes (`exit 1` at root blocks despite child `true`) | Pass |
| R8 | Malformed `.canopy/rules.json` on main | Nothing lands | `blocked` with a clear message | Pass |
| R9 | No `.canopy/rules.json` at all | Not specified | Lands with no checks run, no warning | Pass (finding F3) |
| R10 | Rule `path: "src/core"` and changed file `src/core.js`; README: "every rule whose `path` is a prefix of a changed file applies" | Rule applies | Rule silently does not apply (landed). Only directory-style prefixes (`src/`) match | **Fail** (D5) |

### Comparison with a plain baseline (worktrees + merge + run the check on every merge)

Baseline = two worktrees, merge the finished branch into `main` in a temporary
worktree, run `node test.js`, fast-forward `main` if it passes. For the check-run
comparison the baseline is scripted two ways: a serial merge queue, and optimistic
parallel CI (each branch merges and tests against the current `main`, retries if
`main` moved).

**(a) When is the semantic conflict first detected?**

| System | Detected | Phase | Note |
|---|---|---|---|
| Canopy, A's signature change first, then B writes the old-form call | 22 ms after B's conflicting edit (snapshot 1: 3.7 ms) | While working, in the hook response | |
| Canopy, B's call exists first, then A changes the signature | 23 ms after A's edit (snapshot 1: 3.3 ms) | While working, B's next hook | |
| Canopy gate | `land` call returns `blocked` after 446 ms | At landing | Needs a check that exercises the code |
| Baseline | 339 ms after both branches are committed (text merge clean, check exit 1) | At merge, never earlier | Best case: agents are assumed to commit the instant they finish. A real agent's remaining working time is added on top |

**(b) Check runs when 8 branches touching unrelated files land while main keeps moving.**
Check is `echo x >> counter; sleep 1`; all 8 branches are landed at once.

| System | Branches landed | Check runs | Wall time |
|---|---|---|---|
| Canopy `revalidate: "always"` | 8 | **15** (8 + 7 re-runs) | 15.7 s |
| Canopy `revalidate: "disjoint"` | 8 | **8** | 6.2 s |
| Baseline, serial merge queue | 8 | 8 | 9.3 s |
| Baseline, optimistic parallel CI | 8 | 36 | 9.7 s |

Reading: `disjoint` does the fewest runs and is fastest. `always` is slower than a
simple serial queue (15.7 s vs 9.3 s) because its re-runs happen one at a time inside
the landing lock. Canopy did not use fewer check runs than the serial baseline;
it matched it (disjoint) or exceeded it (always).

---

## Security

Canonical repo = local bare repo, protected with `canopy protect`; a working clone
runs `canopyd`. "Push" always means a real `git push`.

| ID | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| S1 | Direct push of an ordinary commit to protected `main` | Refused | `refused - <sha> has no landing record`; canonical `main` unchanged | Pass |
| S2 | Control: a real landing pushed with `main` + `refs/notes/canopy` | Accepted | Accepted. Pushing `main` alone is refused (see D8) | Pass |
| S3 | Replay a valid landing record onto a different commit (two variants, incl. copied trailer) | Refused | `its record was signed for a different commit` | Pass |
| S4 | Record signed by another key (second daemon, own home, clone of same repo) | Refused | `landing record signature does not verify` | Pass |
| S5 | Hand-forged record with a made-up signature that claims the trusted key id | Refused | Refused | Pass |
| S6 | Delete `refs/notes/canopy`; rewrite it to an unrelated root commit | Refused | Both refused, ref intact | Pass |
| S7 | Force-push (rewind), delete `main`, force-push an orphan | Refused | All refused (`cannot be rewound or force-pushed`, `cannot be deleted`) | Pass |
| S8 | Push a feature branch to the protected repo | Allowed | Allowed | Pass |
| S9 | Signed landing with an unsigned commit smuggled on top | Refused | Refused | Pass |
| G1a | Edit `.canopy/rules.json` on a branch | Needs a person | `needs-human`, exit 2 | Pass |
| G1b | Branch empties the check list in rules and breaks the code | Judged by main's rules | `blocked` by main's `node test.js`; main did not move | Pass |
| G1c | Branch deletes the `no_tainted` rule and fetches web content | Still needs a person | `needs-human` (outside content) | Pass |
| G2 | Change `package.json`, `package-lock.json`, `Makefile`, `.github/workflows/ci.yml`, `.claude/settings.json` | Needs a person | All `needs-human` ("protected files changed") | Pass x5 |
| G3a | Shrink an existing test | Needs a person | `needs-human` | Pass |
| G3b | Delete a test file | Needs a person | `needs-human` | Pass |
| G3c | Control: add a test, grow a test | Lands | Landed | Pass |
| G3d | Move a shortened test to a new file name | Needs a person | `needs-human` | Pass |
| G4a | Session used WebFetch, then changes a `no_tainted` section | Needs a person | `needs-human` ("web:...") | Pass |
| G4b | Session ran `curl` via Bash, then changes it | Needs a person | `needs-human` ("shell:curl"). Also tainted: wget, git, npm | Pass |
| G4c | MCP tool result | Counts as outside content | Yes | Pass |
| G4d | Controls: tainted but in an unguarded section; untainted in the guarded section | Both land | Both landed | Pass |
| G4e | Shell edit that no hook reported | Counts as taint | `unwitnessed-writes`, needs a person | Pass |
| G5 | Check does `cat` on `key.pem`, `human.token`, `canopy.db`, `ls` of the home dir; also default home under `.git/canopy` | Fails | All `Operation not permitted`, landing `blocked` | Pass |
| G6 | Approve with no / empty / wrong / truncated token; then right token | Wrong refused, right lands exact commit | Wrong: refused, `main` unchanged. Right: landed, signed record names approver. Wrong-token reply is HTTP 200 with `{"status":"error"}` (D8) | Pass |
| G6b | Approve an unknown id; approve after the branch got a new commit | Not landed / re-reviewed | Unknown id not landed. New commit made it `needs-human` again, payments change not landed | Pass |
| G7 | A check posts to `/api/approve` over loopback and tries to create a git ref | Approval fails, ref write fails | Approval refused (no token); `.git/refs` write blocked | Pass |
| G8 | What can a check write outside its own checkout? | Not specified beyond "key, credential folders, refs, outside network" | Blocked: `.git/hooks`, `.git/config`, `.git/refs`, `git update-ref`, reading `~/.ssh`. **Allowed**: a file in the user's main working tree, a file in `$HOME`, `$TMPDIR`; connecting to canopyd on loopback | Pass (finding D3) |
| A1 | `/api/file` and static paths: `../`, absolute, encoded, `.git/config`, key, token | No leak | "unknown file" / 404 | Pass |
| A2 | `CANOPY_TOKEN` | API, hook and approve endpoints need bearer | 401 without or with wrong token, 200 with | Pass |
| A3 | CLI run without the token against a token-protected daemon | Readable message | `canopy: Cannot read properties of undefined (reading 'length')` | **Fail** (D7) |
| A4 | Malformed bodies, `cwd` outside repo, odd events | Daemon survives | Survives, no 5xx | Pass |
| A5 | `GET /api/events` (SSE) | Pushes an event when an agent acts | Yes | Pass |

Security result: every bypass attempt in the Brief's list (direct push, edited rules,
weakened tests, forged record) was refused or sent to a person. Open issues are in D3, D7, D8.

---

## Context

| ID | Scenario | Expected | Observed | Result |
|---|---|---|---|---|
| C1 | `canopy why src/payments/ledger.js#post` after a landing with intent text | Intent, checks, landing commit | 188 characters: commit, time, branch, intent, coverage, `node test.js -> pass (N ms)`, touched symbol. An unchanged sibling symbol is not attributed; file-level and `/api/why` forms work | Pass |
| C1b | Two landings on one symbol | Both intents, newest first | Yes | Pass |
| C2 | First read in a section | Small; contains that section's rules | `src/payments/` first read: **249 characters** (checks, 80% coverage, no outside content, perf budget, 800-line limit). `src/auth/`: 131. Plain `src/`: 83. A second read in the same section adds nothing. Whole fixture repo: 806 characters | Pass |
| C3 | Same, after 12 landings in the section | Still small, recent history only | **339 characters**: rules plus the 3 most recent landings, each as id and intent | Pass |

Caveat: the fixture repos are tiny, so "small compared to the repo" is only
weakly shown. The absolute sizes (83-339 characters) are what matter.

---

## Performance

Measured client-side with a keep-alive HTTP agent unless stated. Snapshot 2,
suite run one file at a time on an otherwise idle machine. Real Claude Code adds
its own hook-dispatch time, which is not measured here.

### Hook round trip (>= 2,000 mixed hooks: Read, PreToolUse(Edit), PostToolUse(Edit), PostToolUse(Bash), UserPromptSubmit; 300-file repo)

| Setup | Hooks | p50 | p95 | p99 | max |
|---|---|---|---|---|---|
| 1 client, client-side | 2,400 | 0.36 ms | 0.78 ms | 2.0 ms | 20.3 ms |
| same, `GET /api/stats` (server-side) | 2,401 | 0.14 ms | 0.46 ms | n/a | 29.3 ms |
| 4 clients in parallel, client-side | 2,400 | 1.61 ms | 4.96 ms | 7.2 ms | 46.3 ms |
| same, `/api/stats` | 2,404 | 0.18 ms | 1.45 ms | n/a | 22.0 ms |
| New TCP connection per hook | 500 | 0.38 ms | 0.63 ms | 1.2 ms | 2.5 ms |
| Cost of one edit's Pre + Post hooks | 300 | 0.74 ms (vs 0.08 ms for the bare file write) | 1.05 ms | 2.0 ms | 21.3 ms |

Throughput about 1,900 hooks/s single client. The worst Bash hook p95 is 1.8 ms
(it triggers a worktree scan). Snapshot 1 gave the same medians (0.35 ms) with
max 3.8 ms; the later maximum spikes (about 20 ms) are single events.

### Index time

| Repo | Index at startup (logged) | Spawn to ready | Memory (RSS) |
|---|---|---|---|
| 1,000 JS files (3,001 symbol nodes) | 241 ms | 365 ms | 73 MB |
| 10,000 JS files (30,001 nodes) | 1,692 ms | 1,823 ms | 140 MB |

Incremental re-index after one landing: **not directly observable** through the
documented interface (`index_ms` in `/api/stats` only reports startup). What can be
seen: after one landing `/api/state.rev` equals the new `main`, the next hook
answers in 1.5-1.7 ms, and `land` for a one-function change costs 761 ms on the
1,000-file repo and 1,923 ms on the 10,000-file repo, against 589 ms on a 6-file
repo. So some per-landing work grows with repo size (about 1.3 s extra at 10,000
files); I could not tell from outside whether that is re-indexing.

### `canopy land`

| Measure | Value |
|---|---|
| Wall time, check `true`, 6-file repo, 20 runs | p50 589 ms, p95 698, min 537, max 698 |
| The check itself | 13 ms |
| Bare `node -e 0` | 53 ms |
| `canopy stats` (CLI start + one HTTP call) | 252 ms |
| Fixed overhead of `land` above the check | about 575 ms, of which about 250 ms is CLI start-up and one round trip; the rest (about 320 ms) is server work (merge, signing, notes, refresh) |
| 20 sequential landings, 6-file repo | 11.8 s total (591 ms mean); first five 598 ms, last five 583 ms, so no slow-down across 20 |
| 20 sequential landings, 1,000-file repo | 12.1 s total (606 ms mean), p95 760 ms |

---

## Maintainability

| ID | Scenario | Observed | Result |
|---|---|---|---|
| M1 | Dependencies | 0 in `dependencies`, `devDependencies`, `optionalDependencies`, `peerDependencies`; no `node_modules`, no lock file; every import is a `node:` built-in (`child_process`, `crypto`, `fs`, `http`, `os`, `path`, `sqlite`, `url`) | Pass |
| M2 | Size (`wc -l`) | `src/*.mjs` 2,085 lines (engine 677, gate 421, extract 313, graph 190, rules 131, git 127, server 120, store 65, sign 41); `bin` 210; `hooks` 72; `ui/index.html` 502; `demo` 181. `src` + `bin` + `hooks` = 2,367 lines. (Snapshot 1: 2,101; the code grew 13% during testing.) Engine field says Node >= 22.13 | Pass |
| M3 | README quick-start `node bin/canopy.mjs demo` | Page served at `/` in 0.56 s; first scripted landing after 7.7 s; state shows 4 sessions, 2 notices, 43 files. I used `--port 7818` because the default 7717 range is outside my allowed ports and was in use | Pass |
| M4 | "Use it on a repository" steps as written | `canopy init` -> edit rules -> commit -> `canopy serve` -> `git worktree add ../wt-refunds -b feat/refunds` -> `canopy land` all work **when run as `node bin/canopy.mjs ...`**. As written (`canopy ...`) they fail: `canopy` is not on PATH and the README has no install or `npm link` step. Also `canopy init` writes hook URLs for port 7717 even with `CANOPY_PORT=7819` set | **Fail** (D6) |
| M5 | One process, one data file | Idle daemon has 0 child processes; one SQLite file (`canopy.db` plus its `-wal`/`-shm`), plus `key.pem`, `pub.pem`, `human.token`, `port`. No Node warnings on stderr | Pass |

---

## Defects found

Ordered most serious first. "Snapshot" says when it was seen.

**D1. (High at discovery; FIXED before snapshot 2) `revalidate: "disjoint"` lets a broken merge into main.**
Snapshot 1. Repro: rules `{"revalidate":"disjoint","rules":[{"path":"","checks":["node test.js && sleep 1"]}]}`.
Agent A changes `charge(amount, currency)` to take `fee` and fixes callers; agent B adds a new file
`src/invoice.js` calling `charge(2,'usd')` with a self-test. Run `canopy land` for both at the same time
(B 150 ms later). Both landed, B's record said "checks not re-run: the graph shows no interaction with
what landed meanwhile", and `main` held a commit whose `node test.js` fails. Same with a new function added
to an existing file. Changing an existing caller was handled correctly. Cause (not investigated beyond the
symptom): new code that references a changed symbol is not in the graph of the new `main`. Re-tested in
snapshot 2: all variants blocked, main clean (tests B3 x4).

**D2. (Medium; FIXED before snapshot 2) canopyd's `git status` takes the agent's index lock.**
Snapshot 1. Repro: after any Bash hook, immediately run `git add -A` in that worktree, 40 times.
2-5 of 40 failed with `fatal: Unable to create '.../index.lock': File exists`. The daemon ran
`git status` without `--no-optional-locks`. Snapshot 2 and three repeats: 0 of 40.

**D3. (Medium, open) The check sandbox is a deny-list; checks can write almost anywhere.**
Verified on macOS (`sandbox-exec`). A rules check can create a file in the repo's main working tree,
in `$HOME`, and in `$TMPDIR`, and can open a TCP connection to canopyd on loopback. Blocked as documented:
the home dir of the daemon (key, token, db), `~/.ssh`, `.git/refs`, `.git/hooks`, `.git/config`, `HEAD`.
Repro: set a main rule check to `echo x > $HOME/probe.txt; echo x > /path/to/repo/pwned.txt; true`, land
anything; both files appear (test G8). Impact: a malicious or compromised test dependency run by a check
can plant files in the user's home (shell start-up files, launch agents) or alter the working tree.
The README claims less than that (key, credential folders, refs, network), but "sandboxed" invites more trust.
Approval by a check over loopback was tried and fails (no token), so the approval path is not affected.

**D4. (Medium, open) A branch built on a signature that has since changed lands if no test covers the call.**
Repro: A lands a signature change to `charge`; B's branch (forked earlier) adds `src/invoice.js` that calls
the old form, with no test for it; `canopy land` in B -> `landed`. The record lists
`stale_assumptions: [{node: "src/pay.js#charge", kind: "signature"}]` but the verdict ignores it. With a
covering test (Q4) it is blocked. Canopy knows about the problem and only reports it. Decision for the
owner: whether a stale assumption on a signature should send the landing to a person.

**D5. (Medium-low, open) Rule `path` is matched on directory boundaries, not as a string prefix.**
Repro: rule `{"path":"src/core","protected":true}`, change `src/core.js` -> landed, no warning.
README says "every rule whose `path` is a prefix of a changed file applies". A rule that silently
does not apply is the dangerous way to be wrong. Use `src/` or the exact file name.

**D6. (Low, open) Quick-start does not work as written.**
`canopy` is not on PATH and there is no install step (`npm link` or `node bin/canopy.mjs`).
`canopy init` always writes `http://127.0.0.1:7717/hook` into `.claude/settings.json`, ignoring `CANOPY_PORT`,
so a non-default port needs a hand edit.

**D7. (Low, open) CLI crash against a token-protected daemon.**
Repro: start with `CANOPY_TOKEN=s3cret`, run `canopy status` without the variable ->
`canopy: Cannot read properties of undefined (reading 'length')` instead of "token required".

**D8. (Low, open) Push and approval messages mislead.**
(a) After `canopy land`, `git push origin main` to a protected repo is refused with "has no landing record"
although the landing has one; the record lives in `refs/notes/canopy` and must be pushed together
(`git push origin main refs/notes/canopy`). The README does not say so.
(b) A wrong approval token is refused correctly but the HTTP reply is status 200 with `{"status":"error"}`.

**D9. (Low, open) `npm test` / `node --test test/` fails on Node 22.22.**
`package.json` has `"test": "node --test test/"`. On Node 22 the directory is run as a module and fails with
"Cannot find module .../test". The suite's `test/index.js` works around it; remove it and the command fails.

**D10. (Low, open) Daemon state is not scoped to a repository.**
Repro: `CANOPY_HOME=/tmp/h`; serve repo 1, agent edits `src/pay.js#charge`; stop; serve a different repo 2 with
the same `CANOPY_HOME`; an agent editing the same path is denied because of repo 1's hold. Holds also survive
a daemon restart. Likely rare (home defaults to `.git/canopy`).

### Observations that are not defects

* F1. `always` revalidation is slower than a plain serial merge queue (15.7 s vs 9.3 s for 8 branches).
* F2. Hook max latency has occasional single spikes of 20-30 ms (server side max 29 ms); medians stay under 0.2 ms.
* F3. With no `.canopy/rules.json`, landing succeeds with no checks and no warning.
* F4. `canopy land` is about 0.6 s even with a 13 ms check; 250 ms of that is CLI start-up.
* F5. In snapshot 2 notice latency in the B1 scenario (22 ms) was higher than snapshot 1 (3.7 ms); both are far below any human-visible delay.

---

## Not tested and why

* **A real Claude Code session.** Hooks were simulated from the README's payload description (`session_id`,
  `cwd`, `hook_event_name`, `tool_name`, `tool_input`, `tool_response`, `prompt`). Real harness payload details
  (`MultiEdit`, `NotebookEdit` input shapes, response bodies, `SessionEnd` behaviour, timeouts) may differ.
* **The live map (3D UI).** Needs a browser and human judgement. Only `GET /` (HTML served) and the SSE feed were checked.
* **Hold expiry** ("Holds expire on their own"). The README gives no time limit and the Verifier log says holds last until the branch lands or is released; I did not wait to find out.
* **Linux sandbox (`bwrap`), Windows, and other languages.** Only macOS `sandbox-exec` and JavaScript source were exercised. The Linux path is described as untested by its authors.
* **A hostile agent in local mode.** The README says local mode guards against mistakes; I did not try a shell-capable agent reading the approval token or posting false events.
* **Hosted forges (GitHub, GitLab), a protected repo reached over SSH, and a multi-machine "team mode" with a separate account.** Only local bare repos in temp dirs were used; no remote was touched.
* **The "pre-receive hook" under non-Node environments** (hook runs `exec node`; a server without Node on PATH was not tried).
* **True incremental re-index time.** Not exposed through any documented interface (see Performance).
* **Concurrent landings of more than 8 branches, repos above 10,000 files, very large files, binary files, and renames in the write set** (rename handling was only exercised through the "moved test" case).
* **`canopy protect` on a repo that already contains unsigned history beyond the first push**, and key rotation.
* **Security issues in the SQLite file or UI code.** I did not read `src/` for vulnerabilities; this was a behavioural test only.

## Notes on the test environment

* While testing, another process on this machine repeatedly sent SIGTERM to daemons started as
  `node .../canopy.mjs serve` (idle daemons died after 4 s to 35 s). I could not identify the sender. The suite
  therefore runs the CLI through a differently named symlink (`cp-under-test.mjs`, created per run under the temp
  dir); with that, daemons survived. Before that change two runs showed bogus "canopyd is not running" and
  "landed: 1 of 8" results; those are excluded from this report.
* Timing tests assume an otherwise idle machine. `node --test test/` runs one file at a time; plain `node --test`
  runs files in parallel and inflates latencies.
* Temp directories are removed when the suite exits (set `CANOPY_KEEP=1` to keep them).


---

## Addendum: after the fixes (written by the builder, not the tester)

The report above is the tester's and describes the build as they found it.
After it was written, the open defects were fixed (see `VERIFIER.md`) and the
whole suite was run again on the final code: **93 tests, 93 pass** (the
tester's 83 plus 10 regression tests for the reviewer's findings). Four of
the tester's tests were edited to match changed contracts; each edit carries a
comment explaining it.

Numbers that changed, measured on the final code (macOS arm64, Node 22.22):

| Measure | In the report above | Final |
|---|---|---|
| Check runs, 8 unrelated branches landed at once, `always` | 15 runs, 15.7 s | 9 runs, 12.2 s |
| Same, `disjoint` | 8 runs, 6.2 s | 8 runs, 5.9 s |
| Same, plain serial merge queue (baseline) | 8 runs, 9.3 s | 8 runs, 9.2 s |
| Same, optimistic parallel CI (baseline) | 36 runs, 9.7 s | 36 runs, 9.9 s |
| Hook round trip, one client, 2,400 hooks | p50 0.36 ms, p95 0.78 ms | p50 0.46 ms, p95 1.54 ms |
| `canopy land`, trivial check | p50 589 ms | p50 582 ms |
| Index at start, 1,000 / 10,000 files | 241 ms / 1.7 s | 317 ms / 1.6 s |
| Semantic conflict first detected | 22 ms after the edit | 22 ms after the edit |

Still true and not flattering: with `revalidate: "always"` Canopy is slower
than a plain serial merge queue on wall time (12.2 s against 9.2 s for eight
one-second checks), because each landing carries about 0.6 s of its own
overhead. `disjoint` is faster than the queue (5.9 s). A landing in a
10,000-file repository takes about 1.8 s because the dependency graph is
re-linked in full.

# Trials with real agents

Run on 23 Nov 2026. Eight Claude Sonnet 5.5 agents, four per arm, started at
the same moment, each in its own Git worktree of the same small repository
(a shop: money helpers, cart, checkout; six test files by the end). Canopy was
the `main` branch of the public repository at that date.

## Tasks (the same in both arms)

| Agent | Task |
|---|---|
| A | Make `toCents` require a second argument, `mode`; update callers and tests |
| B | Add `jobs/settlement.js`, a new caller of `toCents` |
| C | Fix a discount bug in `cart/discount.js` |
| D | Add `checkout/refund.js`, a second new caller of `toCents` |

A collides with B and D by design: there is no text conflict, only a changed
signature and new callers in other files. Agents were not told about it.

## Arms

- **Plain Git.** Run the tests, commit, `git merge main`, run the tests, fix
  what fails, merge into `main`.
- **Canopy**, connected through the hook-less path: `canopy checkin` before
  starting, after each edited file and before committing; `canopy land`
  instead of merging. Checks: `node test.js`.

## What happened

| | Plain Git | Canopy |
|---|---|---|
| States of `main` with failing tests | 1 of 4 | 0 of 5 |
| Agents told of the collision while working | 0 | 2 (B and D, right after writing the call) |
| When the collision was first found | After a broken landing, by A, with instructions not to fix it | Before anything landed, by B and D; then at the gate by A |
| Who repaired it | C and D, each fixing code they did not write, at merge | A, the agent that made the breaking change |
| Landings refused | none | 1 (A, by the checks on the merge commit) |
| Landings held for a person | none | 1 (A: an existing test assertion was edited) |
| Final `main` | green | green |

Every state `main` passed through was checked out and tested afterwards; the
table reports those results, not the agents' own accounts.

## What this shows

- With plain Git, `main` was broken once. A merged `main`, saw nothing new,
  and landed seconds after B had; the combination failed.
- With Canopy, `main` was never broken. The gate ran the tests on the exact
  merge commit and refused A until A had fixed both new callers.
- Real agents received the mid-task notice and understood it.

## What it does not show

- **The notice did not change behaviour.** B and D both read "toCents changed
  its signature on another branch" and both decided their call would keep
  working. They were wrong. The gate, not the notice, kept `main` green. The
  notice says the signature changed but not that the new argument is
  required; that is worth fixing.
- **One run, one small repository, tasks built to collide.** This is a
  demonstration, not a measurement.
- **Not the Claude Code hook path.** Headless Claude Code could not sign in on
  the test machine, so agents used `canopy checkin`. Reads were not recorded,
  which is why inspection coverage shows 0%.
- **The hold on A was arguably a false alarm**: A changed one assertion to
  match the new signature and added two. A person approved it.
- **Cost.** Canopy-arm agents made more tool calls (A: 12 against 4) because
  of check-ins and the refused landing.

## Second run, after the notice was reworded (same day)

Canopy arm only, four new Sonnet agents, same tasks, Canopy at commit 4325b5b.
The notice now ends: "It now requires a new argument with no default («mode»):
a call written for the old form will not work as it is."

| | Result |
|---|---|
| States of `main` with failing tests | 0 of 4 |
| Agents that received the reworded notice | 2 (B and D) |
| Agents that changed their code because of it | 0 |
| Their stated reason | The other change had not landed, and their task said to call the function with one argument |
| A's landing | Held for a person (same "test reduced" alarm). When a person approved it, the gate still refused it: the checks failed on the merge commit because B and D had landed in the meantime |

What this adds:

- **Clearer wording did not change behaviour.** Both agents understood the
  notice and made a defensible choice: code against what is on `main`, not
  against someone's unfinished branch. The notice informs; it cannot make the
  later lander's problem the earlier lander's job.
- **Approval does not override checks.** A person's approval of A did not let
  a broken merge through.
- **`main` stayed green in both Canopy runs** (9 states tested across the two)
  against one broken state in four with plain Git.
- The cost of the collision fell on A, the agent that made the breaking
  change, in both Canopy runs. With plain Git it fell on bystanders.
- A's intermediate check-ins failed on a shell quoting slip in this run, so
  the order of events differed from the first run. Timing was not controlled.

## Third run: steering the author instead (same day)

Canopy arm only, four new Sonnet agents, same tasks, Canopy on branch
`feat/steer-author`. New behaviour: the agent making a breaking change is
told when another branch writes a new caller of what it is reshaping, and
again when such code lands on `main`.

| | Result |
|---|---|
| States of `main` with failing tests | 0 of 4 |
| Callers (B, D) that changed their code after the warning | 0, as before |
| Author (A) told of new callers | Yes: both notices for B arrived at A's first check-in after its edit; both for D were waiting at its next |
| A's landing attempts refused by the checks | 1 (2 in the first run) |
| A's rework cycles caused by others | 1 (2 in the first run) |
| End state | A held for a person on the "test reduced" alarm; on approval the gate refused it again, because D had landed meanwhile |

What this adds:

- The author now receives the right information, naming the branch, the file
  and the fix. In this run that roughly halved A's wasted attempts. It did
  not remove them: A landed once before acting on what it had been told.
- With a hook-less harness the notice arrives only when the agent checks in.
  A learned about D's caller after it had stopped. Under real hooks the
  notice would arrive inside its next tool call.
- Three runs, `main` green in all 13 states tested under Canopy.
- Still one small repository, tasks built to collide, timing uncontrolled.

## Run 4: contracts (24 Nov 2026, branch `feat/contracts`)

New: the author of a breaking change must publish a test that fails on `main`
before landing (`canopy contract publish`), and agents that use the function
are shown the new signature and a fenced excerpt of that test. Rule
`contracts.require_for_breaking` was on. Five Sonnet 5.5 agents (A to E), each
in its own worktree of a rebuilt shop repository, hook-less `canopy checkin`
and `canopy land`, canopyd on a spare port. A: `toCents` requires `mode`.
B and D: new callers of `toCents`. C: unrelated discount bug. E: `lineTotal`
returns cents instead of dollars, same signature. The brief to each agent was
four sentences; B and D were not told about A. After the run one Opus agent,
read-only, checked the numbers below against the repository, the landing
records, canopyd's database and the agents' transcripts.

| | Result |
|---|---|
| States of `main` passing | 5 of 5 landings. The two setup commits before them: the first had one failing test of my own making (fixed in the second), so 6 of 7 counting those |
| Order landed | B, C, D, A, E, all within about 18 seconds |
| A published a contract | Yes, first attempt, accepted. The file was A's edited existing `test/money.test.js`, not a new test |
| B and D wrote the new form before landing (was 0 of 2 three times) | **D yes, B no: 1 of 2** |
| Landing refusals | 0 for every agent |
| Rework cycles | A 1 (merged `main`, fixed B's file after B landed, prompted by the "code that uses it just landed" notice). D 1 (rewrote its own call after the notice, before landing). B, C, E 0 |
| Wrong refusals | 0 |
| Characters of notice text delivered | A 1,293 (3 notices), B 422 (1), D 1,035 (1, includes the contract), C 0, E 0 |

What this shows:

- **D is the first caller in four runs to change its code because of a
  notice.** D wrote `toCents(order.total)`, got the notice with the contract
  at its next check-in ("in code you just wrote"), and rewrote the call as
  `toCents(order.total, 'round')`, which also works on the old signature.
- **The author was steered at the edit.** A got the one-time notice with the
  exact publish command after its first edit, published on its first try, and
  landed on its first try with the contract test passing on the merge commit.
  It also edited an existing test file without the old "tests reduced" hold:
  the record shows `tests_modified: test/money.test.js`, no reductions.
- `main` was green in all 5 landed states; 18 of 18 under Canopy across the
  four runs.

What went badly, or does not show what it seems to:

- **B's "no" is timing, not the feature.** B landed before A had published
  anything. B ran commit, check-in and land as one shell command, so its only
  notice arrived in the same command as LANDED and could not be acted on.
- **One run, timing decided who saw a contract.** Everything landed within
  about 18 seconds. D's 1 of 2 is an observation, not a rate.
- **A's contract is weak.** It is the whole existing test file (including
  `fromCents`), and it "fails on main" because of the floor/ceil and
  `assert.throws` cases A added. The mechanical check cannot tell a test written
  to pin the new interface from any test that happens to fail on `main`. A
  second limit: it cannot tell a failure by assertion from a failure to import
  a file that exists only on the branch.
- **E was not a real test.** Nothing but E used `lineTotal`. E left
  `checkout/summary.js` unchanged, so `summary()` now returns cents with its
  test edited to match. Canopy raised nothing, as expected for a change in what
  a function returns. The run does not show what happens when another branch
  uses `lineTotal`.
- **A's contract disappears from `canopy contract list` once it lands.** It
  survives only in the landing record.
- A landed about 1.4 s after D with an unread notice about D's code; it came
  out right only because D had already used the new form.
- The agents were not briefed on Claude Code hooks; the hook-less path means
  notices arrive only at check-ins. Agents in the throwaway repository added a
  Claude co-author line to some commits there; that repository is discarded.

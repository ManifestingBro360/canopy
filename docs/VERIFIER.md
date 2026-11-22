# Verifier log

An independent reviewer attacked Canopy twice: once on paper before anything
was built, and once against the running build with real commands. This file
records what they found and what was done about each point.

## Round 1 — attack on the design (before the build)

| # | Finding | Pillar | What was done |
|---|---|---|---|
| 1 | Checks run branch code beside the signing key, or a client reports the result | Security | Checks run only inside canopyd, in a sandbox that cannot read canopyd's home (key, token, database) or credential folders, cannot write Git refs, hooks or config, and has no outside network. The environment is scrubbed. A client-reported result is never used. Linux sandbox path is written but untested. |
| 2 | A signed record can be replayed onto another commit or history | Security | The record now names the merge commit, its tree, its parents and the commit `main` moves from. The hook requires each new first-parent commit to match its own record and the record's base to equal the previous commit. Replay, forged key and force-push are refused (tested). |
| 3 | The hook would read stale notes, and the notes ref was unguarded | Security | Notes are read from the incoming notes commit, with fan-out paths handled. The notes ref accepts additions only; deletion and rewriting are refused (tested). |
| 4 | The tree that was tested is not the tree that lands | Quality | Landings are serialised in the commit phase. The gate signs and lands the exact merge commit the checks ran on. If `main` moved, the merge is rebuilt and checks run again, unless rules opt into `revalidate: "disjoint"`. |
| 5 | Unauthenticated HTTP allows forged reads, stops and approvals | Security | Partly fixed. Loopback only, `Host` and `Origin` checked, JSON-only POST, optional bearer token, a separate approval token, approvals bound to commit and rules hash, session ids never exposed by the API, and `Stop` no longer releases anything. Not fixed: an agent on the same machine as its hooks can still post false read events. So reported reads never decide a security question alone. |
| 6 | Taint can be laundered three ways | Security | Taint is per worktree, not per session. Network-capable shell commands taint. Unwitnessed writes taint. Unreviewed tainted landings mark their nodes and later readers inherit. The shell pattern is a heuristic and can be evaded. |
| 7 | Canopy is an agent-to-agent prompt-injection bus | Security | Notices are built from structured fields. Text that came from another agent is reduced to printable characters, capped, quoted, and labelled as data. Intent from tainted landings is withheld from section context. |
| 8 | The bar can be lowered through build files, or escaped by moving code | Security | Build, dependency, CI and agent-configuration files are protected by default. Removing lines from existing tests needs a person. Rules for both the old and new path of a rename apply. |
| 9 | Holds dropped at the end of every turn; denial invites a shell workaround | Quality | A hold now lasts until the branch lands or is released. Deny once, then warn. Deleted worktrees are garbage-collected. |
| 10 | Edits made through shell commands fire no notices | Quality | After every shell command the worktree is scanned and changed files go through the same path as an edit. |
| 11 | Pair-testing in-flight branches blocks on unfinished work and explodes | Performance | Removed. The later lander's checks run on the merged result instead. |
| 12 | Coverage counts tool calls and can be gamed | Quality | Coverage is a routing signal, not a security control. Dependency uniqueness is computed on `main`, so a decoy symbol on the branch cannot shrink the blast radius. It still cannot prove understanding. |
| 13 | Notices are never retracted and can be lost | Context | Reverting a change retracts its notices. High notices stay open and are re-sent on session start. The gate lists what changed on `main` since the fork that the branch relied on. |
| 14 | Wrong baseline; no story for hosted forges | Advantage | The test report compares against "worktrees + merge + checks on every merge" on detection time and check runs, not on broken-main count. The README states that on GitHub.com and GitLab.com Canopy must be the only identity allowed to push `main`. |

Wording the reviewer called overstated was corrected in `DESIGN.md`: the Git
guarantee is stated for the canonical repository only, the event log is now
anchored by writing its head hash into each signed record, and file-level
nodes only warn instead of serialising agents.

## Round 2 — against the running build

**The hands-on security attack did not run.** The reviewer was asked to break
the running build with real commands (gate bypass, sandbox escape, taint
laundering, injection). The model's safety filter stopped that task and it was
not rephrased to get around the filter. What stands in for it is narrower:
the defensive behaviours are exercised by the test suite (see
`TEST-REPORT.md`), and the points in round 1 were each fixed and re-tested.
An independent penetration test of the sandbox and the gate is still owed.

**A correctness and robustness review did run**, with every finding reproduced
by commands. It confirmed 12 defects. All 12 were fixed; ten have a
regression test in `test/regressions.test.mjs`.

| # | Defect reproduced | Severity | Fix |
|---|---|---|---|
| 1 | `revalidate: "disjoint"` skipped checks for a branch that calls a function whose signature had just landed, and `main` broke | Serious | Checks are skipped only if nothing the branch read, references or calls (taken from the diff itself) changed meanwhile, and nothing in the change is unwitnessed. Test. |
| 2 | In-flight changes were measured against the tip of `main`, so a branch behind `main` appeared to be changing what others had landed | Serious | Measured against the branch's fork point; re-measured when the branch merges `main`. Test. |
| 3 | Taint was erased by `canopy release` and by any landing | Serious | Taint stays for the life of the worktree. Only a person clears it (`canopy clear-taint`). Test. |
| 4 | The reduced-test guard missed files with non-ASCII or quoted names | Serious | Diff statistics are read with `-z`. Test. |
| 5 | The rules file was never validated: a typo disabled a rule, `null` crashed the daemon, an invalid file on `main` blocked every landing including the fix, and a repeated benchmark kept the looser budget | Serious | Strict validation with reasons. A branch cannot land a broken rules file. A broken file on `main` can be repaired by a person-approved landing. The smaller budget wins. Test. |
| 6 | The extractor misread real signature changes as body changes and layout changes as signature changes (17 cases) | Serious | Extractor reworked: layout-insensitive hashing, regex and JSX recovery, return types, type members, default exports, overloads, one-line and nested Python definitions. All 17 cases now classify correctly. |
| 7 | Two simultaneous `canopy land` calls produced a second, empty signed merge | Moderate | The commit phase returns "nothing to land" when the commit is already on `main`. Test. |
| 8 | Git and the database were never reconciled after a crash or a manual merge: landings missing from history, holds stuck | Moderate | On start and whenever `main` moves, unrecorded landings are imported from their signed notes and branches already on `main` release their holds. Test. |
| 9 | `canopy wait` failed after five minutes and reported "free" for a node nobody held | Moderate | The CLI waits in short requests and reports the two cases differently. |
| 10 | A long file read in pieces never counted as read; a class counted as an unread dependent of its own method; a re-indent counted as unwitnessed | Moderate | Reads accumulate line ranges; a class no longer depends on its own methods; any file the engine processed counts as witnessed. Test. |
| 11 | "Landed" notices never closed | Moderate | They close once the branch contains the landing. Found on the way: a NUL separator in stored notice sources was truncated by SQLite on read; replaced. Test. |
| 12 | Reads and writes were recorded for paths outside the repository (through a symlink) and inside `.git` | Moderate | Paths are compared after resolving symlinks, and Git's directory is excluded. Test. |

Also fixed from the same review: the worktree scan no longer takes Git's index
lock (it had collided with agents' own `git add`), a failed scratch checkout
no longer consumes a slot (two failures had hung every later landing),
`canopy why` no longer treats `_` in a path as a wildcard, files over 2 MB are
handled at file level instead of reporting every symbol removed, pending
landings of deleted worktrees are dropped, and a timed-out check takes its
whole process group with it.

Left open from this review: when two sessions share one worktree, only the
first to make a tool call receives a notice.

## Tester's defects

The tester's own report is `TEST-REPORT.md`. It listed ten defects; this is
what was done about each.

| Id | Defect | Status |
|---|---|---|
| D1 | `disjoint` let two interacting branches both land | Fixed (same as reviewer defect 1) |
| D2 | canopyd's `git status` took the index lock under the agent | Fixed |
| D3 | A check could write to the home directory, the main working tree and the shared temp directory, and could reach canopyd on loopback | Fixed on macOS: writes are limited to the checkout, a per-run temp directory, Git objects and package caches; canopyd's port is denied. Re-tested. Linux path written, not run. |
| D4 | A stale assumption was listed in the record but the branch still landed when no test covered the call | Fixed: the landing is refused until the branch merges `main` |
| D5 | Rule path `src/core` did not apply to `src/core.js` though the README said "prefix" | README corrected: a rule path is a folder or an exact file. Behaviour unchanged; the test was updated to the stated contract. |
| D6 | Quick-start failed as written; `init` ignored `CANOPY_PORT` | Fixed: install step added, `init` honours the variable |
| D7 | CLI crashed against a token-protected daemon | Fixed: clear message |
| D8 | Pushing `main` by hand without the notes ref is refused | Documented; this is the hook working as designed |
| D9 | `npm test` failed on Node 22 | Fixed: the script names the test files |
| D10 | A shared `CANOPY_HOME` mixed two repositories' state | Fixed: canopyd refuses a state directory bound to another repository |

Four of the tester's tests were edited after these fixes, each with a comment
saying why: two could no longer write a marker file outside the sandbox, one
asserted the old "prefix" wording, and one could not install the command
globally and now checks that the install step is documented.

## Round 3 — people and policy (0.2)

An independent reviewer read the access-control and approval code against the
0.2 brief and reproduced every finding as a failing test. It confirmed 18
defects. All 18 are fixed, and the 18 reproductions are kept as regression
tests in `test/review.test.mjs`.

| # | Defect reproduced | Severity | Fix |
|---|---|---|---|
| 1 | A model switch relabelled what the earlier model had written | Serious | Authorship rows carry the model and person the session had when it wrote |
| 2 | `canopy release` wiped authorship; the next session took the credit | Serious | Authorship lasts until the branch lands, whatever is released |
| 3 | A session that merged another model's branch became its sole author | Serious | Changes that arrive through a shell command are marked as such; in a section with model rules they need a person |
| 4 | Edit-time policy was judged by the session's first user, so a hook naming someone else's session id passed as them | Serious | A session id is stored under the user whose token sent it, and policy is judged against the request's token |
| 5 | A disabled owner's earlier approval still counted | Serious | Only approvals from active users count |
| 6 | A pending landing by a since-disabled owner landed in her name | Moderate | Refused; someone else has to land it |
| 7 | The same two faults for promotions | Serious | Same fixes |
| 8 | A feature branch's intermediate commit, never checked as a tip, could be promoted, and the canonical repository accepted it | Serious | Only commits on the first-parent line of the stage before qualify, in the gate and in the `pre-receive` hook |
| 9 | Two rules for one path kept only the first rule's owners, writers and models | Moderate | Requirements are kept per rule, not per path |
| 10 | An edit made outside any session to a file an allowed model had touched landed unflagged | Moderate | The content last seen for each file is kept; committed content that differs counts as unwitnessed |
| 11 | An approval was stored before a re-land that could fail, then silently covered reasons that appeared later | Moderate | An approval is bound to the reasons shown, and one that cannot be acted on is discarded |
| 12 | With broken rules on `main`, the repair's own rules named who could approve it | Moderate | Administrators only |
| 13 | A Codex patch's `Move to:` target was not checked at edit time | Moderate | Checked |
| 14 | Only the first 50 files of a patch were checked | Minor | All are |
| 15 | An unreadable `canopy.envs` setting made the hook guard nothing | Minor | Refuses the push |
| 16 | With no users, a worktree that had released its work now received landing notices | Minor | Releasing also forgets what the worktree knew |
| 17 | `@constructor` passed as a team name | Minor | Own-property lookups |
| 18 | `canopy hook` exited with an error on a `null` event | Minor | Exits quietly |

Also changed after the reviewer's unconfirmed suspicions: a person whose
session wrote a change cannot approve the reasons it was held for, even if
someone else lands it; an owner can approve such reasons only when the whole
change lies inside owned sections, so a trivial edit elsewhere cannot recruit
an approver; a repository-wide owner is no longer described as "a person".

A separate automated security review flagged the Codex manager adapter twice:
Codex cannot run with its tools switched off, so a diff under review could try
to talk the manager model into reading files on the Canopy host, and the
manager's summary, shown to whoever asked for the landing, could then carry
them out. Both ends were closed. Every manager now runs in an empty directory
inside a sandbox that cannot read canopyd's key, tokens or database, the Git
directory, or common credential stores (a test has a stand-in manager try to
read the signing key and write into canopyd's state; both fail). And the
manager's words no longer travel: the requester, the signed record and chat
channels get the verdict and the files concerned, and the text is read with
`canopy concerns` by administrators and the people the landing waits on. What
remains is stated in `SECURITY.md`: inside the sandbox Codex can still read
other files of canopyd's account, and the sandbox is macOS-only so far.

One behaviour changed on purpose and is not a defect: landing notices now say
who landed the change and why (the stated purpose), so the receiving agent can
decide what to re-read without opening the file.

Still owed, as before: a hands-on penetration test of the sandbox and gate by
someone outside the project, and runs against real Claude Code and Codex
sessions and live manager models.

# Canopy — architecture as built (v0.1)

Canopy is a layer above Git. Git still stores the code and the team's forge
still hosts it. Canopy adds three things Git does not have: a live record of
what each agent read and wrote, a map built from that record, and a landing
gate that decides what may reach `main`.

This document describes what the code does. The first draft was attacked by
an independent reviewer before anything was built; `VERIFIER.md` lists what
they found and what changed because of it.

## 1. Parts

```
 agent (Claude Code) ──HTTP hooks──▶ canopyd ◀──SSE── map UI (browser)
        │                              │  ▲
        │ git commit (own worktree)    │  └── canopy CLI (land, why, status, approve)
        ▼                              ▼
   local worktree                canonical repo (bare) + pre-receive verifier
```

- **canopyd** (`src/server.mjs`) — one Node process, no npm dependencies.
  HTTP on the loopback address, server-sent events, one SQLite file in WAL
  mode (`node:sqlite`).
- **Adapter** — Claude Code HTTP hooks posting straight to canopyd. No client
  code runs in the agent's process and no process is spawned per tool call.
- **Indexer** (`src/extract.mjs`, `src/graph.mjs`) — source files to symbols
  and dependency edges, built from Git objects of `main`.
- **Engine** (`src/engine.mjs`) — hooks to reads, writes, holds, notices and
  taint.
- **Gate** (`src/gate.mjs`) — `canopy land`.
- **Verifier hook** (`hooks/pre-receive.mjs`) — refuses any route into `main`
  other than a signed landing.
- **Map UI** (`ui/index.html`) — one static page, plain Canvas, no libraries.

## 2. The record

In-flight state is keyed by **worktree**, because a change belongs to a
branch, not to whichever session happens to be attached to it. Sessions come
and go; the record stays until the branch lands or is released.

| Table | Holds |
|---|---|
| `reads` | worktree, node, body hash at read time, strength (full or weak) |
| `writes` | worktree, node, change kind (`signature`, `body`, `added`, `removed`), how it was seen (`hook` or `shell`), old and new signature |
| `refs` | identifiers used by code the worktree has written |
| `holds` | node, worktree |
| `notices` | target worktree, node, source, severity, text, delivered, open |
| `taint` | worktree, source of outside content |
| `tainted_nodes` | nodes last landed from a tainted branch without review |
| `landings`, `landed_nodes` | every verdict and its full record; which nodes each landing changed |
| `events` | append-only, hash-chained log; its head hash is written into each signed landing record |

A node is `path#name` for a symbol and `path` for a file. Every file is a
node, so languages the extractor does not parse still work at file level.

## 3. Indexing

The extractor finds functions, classes, methods, types and top-level
constants in JavaScript, TypeScript, Python and Go with line-anchored patterns
and brace or indent matching. Each symbol gets a signature hash and a body
hash, so a change is classified as `signature` or `body`.

An edge `A → B` exists when A's body names B and one of these holds: same
file, A's file imports B's file, or B's name is unique among top-level symbols
on `main`. This over-approximates on purpose: the cost is noise. It is not
complete: dynamic dispatch, re-exports and non-code dependencies are missed.

The graph is built from Git blobs, cached per blob, and rebuilt incrementally
when `main` moves. The extractor sits behind one function so a tree-sitter or
language-server backend can replace it.

## 4. What each hook does

| Hook | Action |
|---|---|
| `SessionStart` | Register the session. Re-open undelivered high notices. Return a short context block: how to land, what else is in flight. |
| `UserPromptSubmit` | Record the first prompt as the session's task. |
| `PostToolUse` Read | Record a read of every symbol the lines cover (full when at least 80% of the symbol was read). On first entry to a section, attach that section's rules, what others are changing in that file, and the intent of its last three landings. Inherit taint if the file was last landed unreviewed from a tainted branch. |
| `PostToolUse` Grep, Glob | Weak reads for the files named in the results. |
| `PostToolUse` Bash | Taint if the command can fetch outside content. Then scan the worktree for files the command changed and run them through the same path as an edit. The scan runs in the background and an edit can report in while it does, so a scan already running when an edit is let through skips that file (a shell command that reports afterwards ends that), and leaves alone any file whose record changed after its Git listing was taken. |
| `PostToolUse` WebFetch, WebSearch, `mcp__*` | Taint the worktree with the source. |
| `PreToolUse` Edit, Write, MultiEdit, NotebookEdit | If another branch has an unlanded change to a function this edit touches: deny once, with who, and how to wait or proceed. A second attempt is allowed with a warning. File-level and stale holds only warn. If the edit goes ahead, anything already different in the file that no hook reported is recorded first as a shell change, and the file is marked as being written by a tool. |
| `PostToolUse` Edit, Write, … | Compare the file with `main`, classify each changed symbol, record writes and holds, fan out notices, retract notices for anything reverted. |
| every hook above | Deliver the worktree's pending notices as `additionalContext`. |

If canopyd is unreachable the hooks fail open: the agent keeps working and
nothing is recorded. Coordination is advisory; the gate is the control and it
fails closed. Work done while the daemon was down shows up at the gate as
unwitnessed writes.

## 5. Collision handling

1. **Presence.** Reads and writes are visible on the map, in `canopy status`,
   and in the context an agent gets when it reads a file others are changing.
2. **Hold.** A hold lasts as long as the change is unlanded. The first
   conflicting edit to a held function is refused with an explanation and a
   `canopy wait` command; a retry goes through and both sides are told.
   Deny-once cannot deadlock or loop. A holder idle for 30 minutes only warns.
3. **Notice.** When a branch changes a symbol in its working tree, before any
   commit:
   - signature changed or symbol removed → notify every other worktree that
     read it, references it in code it has written, or is changing something
     that depends on it (high);
   - body changed → notify worktrees that fully read it (low).
   The reverse also fires: writing code that calls a symbol another branch is
   changing produces a notice to the writer. High notices stay open until
   retracted or landed and are re-sent after a restart or compaction.
4. **At the gate.** Anything the first three missed is caught by running the
   checks on the merged commit, and the record lists what changed on `main`
   since the branch forked that the branch had read or referenced.

Notice text is built from structured fields. Text that originates from another
agent's work (branch names, signatures, intent) is reduced to printable
characters, cut to a fixed length, and placed inside quotation marks under a
line that tells the receiving model it is data.

## 6. The landing gate

`canopy land` asks canopyd to judge the branch in the caller's worktree.

1. **Write set from Git.** Diff the branch against its merge base, re-extract
   both versions, list changed symbols and files. Renames count as removal at
   the old path and addition at the new one.
2. **Blast radius.** Dependents of the write set on `main`'s graph: one hop
   for body changes, two for signature changes and removals.
3. **Inspection coverage.** The share of the blast radius the branch fully
   read, where the read is still fresh against `main`. The unread nodes are
   listed.
4. **Stale assumptions.** Landings since the fork that changed a signature the
   branch read, references, or calls in the code it changed (the calls are
   taken from the diff itself). If the branch's own code uses what changed,
   the landing is refused until the branch merges `main`: a test may not
   cover a call the agent just wrote.
5. **Unwitnessed writes.** Changed files with no recorded agent activity.
   They also count as taint.
6. **Rules** from `main` (section 7). Rules for both old and new paths of a
   rename apply.
7. **Merge.** `git merge-tree` builds the merge of `main` and the branch
   without touching a working tree. A conflict blocks with the file list.
8. **Checks.** The section's commands run on that exact merge commit in a
   scratch worktree, inside a sandbox. Only canopyd runs checks; a result
   reported by a client is never used.
9. **Verdict.** `blocked` (checks, conflict, invalid rules), `needs-human`
   (protected files, taint in a section that forbids it, removed or reduced tests,
   coverage or size below the section's bar), or land.
10. **Commit phase, one landing at a time.** If `main` moved while checks ran,
    the merge is rebuilt on the new `main` and the checks run again. A landing
    that arrives while another is in progress skips the early run and runs
    its checks once, in its turn, so a busy queue costs one run per landing.
    With `revalidate: "disjoint"` the early run is kept and the re-run is
    skipped when nothing that landed meanwhile touches this change's write
    set, blast radius, files, or anything its changed code reads or calls;
    the record says so.
11. **Sign and land.** The record names the merge commit, its tree, its
    parents and the commit `main` is moving from. canopyd signs it with
    Ed25519, stores it as a Git note on the merge commit, pushes `main` and
    the notes ref atomically if a canonical remote is configured, and
    fast-forwards the local `main`.

Every landing is exactly one first-parent commit on `main`.

A person approves a `needs-human` landing with `canopy approve <id>` or in the
UI. The approval is bound to the branch commit and the rules hash: if either
changes, it must be given again.

## 7. Rules

`.canopy/rules.json` on `main`. Every rule whose path is a prefix of a changed
file applies. Checks are unioned, minimum coverage takes the highest value,
size limits take the lowest, and `protected` and `no_tainted` are OR-ed. A
deeper section cannot loosen a parent. Files that decide how code is built,
tested, shipped or how agents are configured are protected by default, and so
is removing lines from existing tests.

## 8. Trust and security

- **Canonical repository.** The `pre-receive` hook accepts an update of
  `main` only if it is a fast-forward and every new first-parent commit has a
  note that verifies against the trusted public key and names that commit,
  its tree, and the previous commit as its base. Notes are read from the
  incoming push. The notes ref can only gain entries.
- **Checks are sandboxed.** On macOS, `sandbox-exec` denies reading
  canopyd's home (key, token, database) and common credential folders. Writes
  are allowed only inside the scratch checkout, a temp directory created for
  that run, Git's object store and package caches; so refs, hooks, config,
  the home directory and other working trees cannot be touched. Outside
  network and canopyd's own port are denied. On Linux
  a `bwrap` wrapper is used when present; that path is untested. If neither
  exists, the record says `sandbox: none`.
- **Taint.** Outside content restricts what a branch may land without a
  person, per section. Unreviewed tainted landings mark their nodes, so a
  later clean session that reads them inherits the taint.
- **API.** Loopback only. Requests with a foreign `Host` or `Origin` are
  refused, and POST bodies must be JSON, so a web page cannot drive it.
  Optional bearer token. Approval needs a separate token.
- **Two modes.** In team mode canopyd and the canonical repository run away
  from the agents and the controls are enforced. In local mode everything
  runs as one user and the controls guard against mistakes only.
- **Trust tier.** Reads are `hook-reported`. They are used to route work to a
  person and to target notices. No security decision rests on them alone.

- **Git is the truth.** On start, and whenever `main` moves by a route other
  than a landing made here, canopyd imports landings it has no row for from
  their signed notes and releases the holds of branches already on `main`.
- **Rules are validated strictly** (section 7). A file that is wrong in any
  way is refused whole.

## 9. Context

- `canopy why <path>[#symbol]` returns the landings that touched it: intent,
  coverage, checks, who approved.
- On first reading in a section an agent receives that section's rules,
  in-flight changes to that file, and the intent of its last three landings.

## 10. Map UI

One screen. The repository is a treemap on a plane, drawn in orthographic 3D:
directories are districts, files are blocks, height grows with file size. A
block takes a branch's colour while that branch has an unlanded change in it
and splits into two colours when two branches do. A ring marks a recent read.
A dashed arc joins a change to the work it reaches. Panels list the branches
being worked on and a feed of landings and high notices; clicking a block
shows its rules, who is changing it and why it is the way it is. Drag to
turn, scroll to zoom, one button flattens it to 2D.

## 11. People and policy (0.2)

**Identity.** `users` holds a name, a role and the SHA-256 of a token. A
request's bearer token is hashed and looked up on every request, so disabling
a user takes effect at once. With no users, canopyd behaves as 0.1. With
users, `/hook`, landing, approving, promoting, releasing and check-in refuse a
request that carries no valid token. A session records the user it acts for,
the harness, the model (from `SessionStart`, and from `PostModelSwitch` when it
changes) and the caller's address.

**Sessions belong to people.** With users, a session id is stored under the
user whose token sent it, so nobody can speak through another person's
session, and edit-time policy is judged against the token on that request.

**Authorship.** `authors(worktree, path, session, user, model, agent, how)`
gains a row whenever a session changes a file, with the person and model the
session had at that moment and whether the change was seen through an edit
tool or found afterwards in Git. Rows last until the branch lands: a model
switch, a release, or a later edit by another session does not remove them.
`wtfiles.oid` keeps the content last seen for each file; at the gate a file
whose committed content is something else counts as unwitnessed.

**At the gate**, after the 0.1 analysis:

1. `writers`: the lander, and every user whose session wrote in the section,
   must be allowed. Otherwise blocked.
2. `models`: every session that wrote in the section must run an allowed
   model. An unlisted model, an unknown one, a file with no recorded author,
   or a change that arrived through a shell command (which may have been a
   merge or a script) adds a reason that needs a person.
3. Approvals required: one entry per owned section the change touches, plus
   one per section with `guard_dependents` reached by a signature change or
   removal (two hops in the graph).
4. Advisories, if on: dependencies added or moved in the diff are looked up;
   findings are noted, sent to a person, or block, as the rules say. An
   unreachable service is recorded and, by default, does not hold the landing.
5. Checks, as before.
6. Manager, if configured: runs after the checks pass, at most once per commit
   and rules version, in an empty directory inside a sandbox that denies
   canopyd's state directory, the Git directory and common credential stores.
   `block` blocks, `concern` adds a reason for a person, an error does the same
   unless the rules say to ignore it. The record and the reasons carry the
   verdict and, per finding, a severity and a file that is part of the change;
   the manager's own words go to `manager_notes`, readable through
   `canopy concerns` by administrators and owners whose approval is still
   open, never the requester or an author, and with no users only on the host.
7. Approval state. An approval row is `(landing, user, commit, rules hash,
   basis)`, where the basis is a hash of the reasons and requirements the
   approver was shown. Only rows from active users count. An owned section is
   satisfied when enough of its owners have approved or are the lander.
   Reasons that need a person are satisfied by an administrator, or by an owner
   when every changed file lies in an owned section; never by the lander or
   anyone whose session wrote the change. A repair of broken rules can be
   approved by administrators only. An approval that could not be acted on is
   discarded. Until then the record lists who is being waited on.

**Environments.** `canopy promote <env>` checks the caller against
`promoters`, that the commit is one of the states the `from` branch has been in (its first-parent line, so a commit that only arrived inside a merge does not qualify), that the environment
branch is behind it, the approvals, and the environment's checks; then signs a
promotion record (a note in `refs/notes/canopy-env-<env>`), pushes it with the
branch if a canonical remote is set, and moves the branch. The `pre-receive`
hook guards branches listed in `git config canopy.envs` the same way it guards
`main`.

**Notifications.** The rules name channels and the events routed to each;
canopyd holds each channel's webhook address. The gate and the engine emit
`approval`, `security`, `blocked`, `landed` and `promotion` events with a
title and a few lines of text made from structured fields. Untrusted text is
reduced to printable characters, cut, and stripped of anything that could
ping a channel. Each event is sent once per half hour at most, delivery is
asynchronous, and a failure is written to the audit log and nothing else.

**Audit log.** `audit(ts, user, ip, action, target, detail, hash)`,
hash-chained. Addresses appear here and nowhere else: not in events sent to
the map, not in Git.

**Catch-up.** `known(worktree, node, hash, ts)` records the version of each
symbol a worktree last read in full or wrote, and survives a landing. A symbol
whose hash on `main` differs, and which the worktree is not itself changing,
is reported with the landings that touched it since (who, intent unless the
landing was tainted, line range). Landing notices also go to worktrees in
`known`, so an agent that landed and moved on still hears about later changes
to code it knows.

**Other harnesses.** `canopy hook` forwards a command hook's JSON to `/hook`.
Codex's `apply_patch` names its files inside the patch text; those paths are
checked before the edit, and after any tool the engine does not recognise the
worktree is scanned as after a shell command. `canopy checkin` does the scan
and returns notices for a harness with no hooks.

## 12a. Contracts (0.3)

A breaking change is a symbol removed, or one whose signature `paramDelta`
reports as forcing callers to change (`isBreaking` in `src/engine.mjs`; an
added optional argument is not). It is *shared* when something on `main`
depends on it (the graph) or another worktree reads or references it
(`Engine.isShared`).

- **Author notice.** When `processWrite` first sees a breaking edit to shared
  code and `contracts.require_for_breaking` is true, the author gets one notice
  (kind `contract`) naming the exact `canopy contract publish` command. Nothing
  is refused mid-task.
- **Publish** (`Gate.publishContract`, `POST /api/contract/publish`). The
  symbol must have a breaking write recorded in the worktree. The test path must
  stay inside the worktree (links resolved), look like a test file, end in
  `.js`, `.mjs` or `.cjs` and contain a test case. canopyd copies the file into a
  scratch checkout of `main` and runs `node --test --test-reporter=tap <file>`
  in the sandbox. The file is opened without following links or blocking and
  its size is taken from the open file (a pipe or huge file is refused); its
  resolved name must be plain (`[\w./@-]`), and the id stored is that of the bytes
  that were run. Before running, every relative import must exist on `main`, the
  test must import the file that defines the symbol and use its name. Exit 1
  with a failed test case is accepted; 0 is refused ("passes on main proves
  nothing"); a failure of the file itself (import, syntax or top-level error) or
  anything not clearly a test failure is refused. Symbol names and test paths
  are fenced in every message, and a name too odd to paste into a shell never
  appears in a command. The accepted contract
  (symbol, new signature, test path, blob id, a 400-character excerpt) goes in
  the `contracts` table and is announced to every affected worktree.
- **Caller notice.** `changeText` appends the contract to the change notice:
  new signature, excerpt of the test, and when to adapt (now, if building on the
  author's branch; otherwise after `git merge main`). The signature and the
  excerpt both go through `fence()` (the excerpt capped so the fenced text is
  400 characters at most).
- **Gate.** In `analyze`, each breaking write to shared code needs a contract
  for this worktree whose signature still matches and whose test blob at the
  candidate equals the published one; otherwise the landing is `blocked` with
  the symbol and the publish command. The contract test is added to the checks,
  so it has to pass on the merge commit. The record lists `contracts`. The key
  comes from `main`'s rules like every other rule, so a branch cannot switch it
  off; absent, it is off.
- **Tests reduced, made precise.** For each test file that existed at the
  merge base: deleted (and not renamed) holds; fewer test cases or fewer
  assertions (comments stripped, so commenting out counts as removing) holds;
  equal or higher counts do not hold and the file goes in `tests_modified` in
  the record and the landing notification. A file whose layout the counter
  cannot read (no recognised case or assertion) keeps the old rule: any removed
  line holds.

Counting ignores string and template literal contents and comments, constant
assertions (`assert.ok(true)`, `assert.equal(1, 1)`, `assert.equal(x, x)`) and
tests marked skip or todo. Renaming a test file to a name a runner will not
pick up (for example `.disabled`) is a deletion. An optional argument inserted
before existing ones, and a signature that cannot be read as a parameter list
on shared code, are breaking; a change in types alone is not seen (out of scope
in this step).

Limits: Node test files only; the "fails on main" check cannot tell a test that
fails because it pins the new behaviour from one that fails because it imports
a file that exists only on the branch; a behaviour change with an unchanged
signature is not a breaking change here.

## 12. Known limits

- The extractor is pattern-based.
- Dependencies that are not code references are invisible.
- Reads are hook-reported.
- Landings are serialised in the commit phase; with `revalidate: "always"`
  throughput is one check run per landing, like a serial merge queue.
- Each landing costs about 0.6 s besides its checks, and the dependency graph
  is re-linked in full when `main` moves (about 1 s at 10,000 files).
- When two sessions share a worktree, only the first to act receives a notice.
- The Claude Code adapter is the only one exercised by tests against the real
  hook payload shape. The Codex adapter follows Codex's documentation and has
  not been run against Codex; manager adapters have not been run against live
  models.
- canopyd is local: it reads worktrees by path and listens on loopback. A team
  whose agents run on other machines cannot use it yet, and recorded addresses
  are always the local one.
- Model names are whatever the harness reports.
- Advisories cover four manifest formats and only known vulnerabilities, not
  "a newer version exists".
- Hosted forges cannot run the `pre-receive` hook; there Canopy must be the
  only identity allowed to push to `main`.

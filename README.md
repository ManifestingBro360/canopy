<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="assets/logo-dark.svg">
    <img src="assets/logo.svg" alt="Canopy" width="300">
  </picture>
</p>

<p align="center">
  <b>Catch agent collisions while they work, not at merge.</b><br>
  A coordination and landing layer above Git for code written by many AI agents at once.
</p>

<p align="center">
  <a href="https://github.com/ManifestingBro360/canopy/actions/workflows/ci.yml"><img src="https://github.com/ManifestingBro360/canopy/actions/workflows/ci.yml/badge.svg" alt="tests"></a>
  <img src="https://img.shields.io/badge/dependencies-0-12805C" alt="no dependencies">
  <img src="https://img.shields.io/badge/node-%E2%89%A5%2022.13-12805C" alt="Node 22.13 or later">
  <a href="LICENSE"><img src="https://img.shields.io/badge/licence-Apache--2.0-12805C" alt="Apache-2.0"></a>
</p>

<p align="center"><a href="https://theprojectsierra.ai/canopy/">Website</a> · <a href="docs/DESIGN.md">Design</a> · <a href="docs/TEST-REPORT.md">Test report</a> · <a href="CONTRIBUTING.md">Contribute</a></p>

![How Canopy works: two agents in separate worktrees; one changes a function the other calls and the second is told at once; each change passes a five-stage gate; only signed changes move main and then staging and production](assets/how-it-works.svg)

## By design

- **It spends as little of an agent's context as it can.** An agent is told
  only what touches its own work, in a line or two: a notice when its ground
  shifts, a section's rules on first entry (83 to 339 characters in our tests),
  and on return a digest of what others changed with the lines to re-read
  (under 420 characters per function) instead of the whole file again.
- **Quality and security are enforced, not requested.** Checks, owners, model
  rules and approvals are applied at the gate from rules on `main`. Nothing an
  agent is told in a prompt is relied on.
- **It gets stricter where your team tells it to.** Every rule you add (an
  owner, a check, a model tier, an environment) applies from the next landing,
  and every landing leaves a signed record you can learn from.
- **People are told where they already are.** Approvals and alerts go to
  Slack, Discord or any webhook. Nobody has to watch a dashboard.

Your team works on the product. The record, the gate and the rules are
Canopy's job.

![The Canopy map: a repository drawn as blocks, with the branches being worked on and a feed of landings](docs/map.jpg)

## Why

Pull requests were designed for people, who talk before they collide. Agents
in separate worktrees do not.

- **Conflicts surface too late.** Git sees conflicts in text, at merge. When
  one agent changes a function's signature and another writes a new call to it
  in a different file, both branches pass their own checks and `main` breaks
  after both are merged.
- **The reasoning is gone.** A pull request shows the diff, not which of the
  affected code the agent read or what it pulled in from the web.
- **Rules live in prompts.** "Always run the payment tests" in a prompt file
  is a request, and an agent can edit the file that states it.

## What Canopy does

Git still stores the code and your forge still hosts it. Canopy adds:

- **A live record of what each agent read and wrote**, observed from the agent
  harness and from Git, not declared by the agent.
- **Collision handling while the work is happening.** If one agent changes a
  function another agent has read or is calling, the second agent is told in
  its next tool call, before either has committed.
- **A landing gate.** `canopy land` works out what a branch really changed,
  what that affects, how much of the affected code the agent read, whether
  outside content entered the session, and whether the section's rules pass.
  It lands, asks for a person, or refuses, and says why.
- **Signed landings that Git itself enforces.** Each landing is one merge
  commit with a signed record attached. A `pre-receive` hook on the canonical
  repository refuses any other route into `main`.
- **A live map.** One screen showing the codebase as a city: who is reading
  and changing what, which changes reach other work, what landed and why.

```mermaid
sequenceDiagram
    participant A as Agent A (worktree)
    participant C as canopyd
    participant B as Agent B (worktree)
    participant M as main
    B->>C: hook: wrote cart.js, calls total()
    A->>C: hook: changed signature of total()
    C-->>B: notice in B's next tool call
    Note over B: B fixes its call before committing
    A->>C: canopy land
    C->>C: sandboxed checks on the exact merge commit
    C->>M: one signed merge commit
    B->>C: canopy land
    C->>M: one signed merge commit
```

## See it working in one minute

No npm dependencies. One Node process. One SQLite file. You need Node 22.13 or
later and Git 2.38 or later.

```bash
git clone https://github.com/ManifestingBro360/canopy
cd canopy
node bin/canopy.mjs demo
```

Open http://127.0.0.1:7717. The demo generates a small repository and plays
scripted agents against the real hook endpoint and the real gate.

## Compared

| | Git, pull requests, CI | Serial merge queue | File locks or claims | Canopy |
|---|---|---|---|---|
| Changed signature and a new caller in another file | Found by CI after both merge, if a test covers it | Found in the queue, if a test covers it | Not seen | Seen while both are working; blocked at the gate even with no test |
| Other agent told mid-task | No | No | Made to wait | Yes, in its next tool call |
| When agents wait | Never | At merge | Whenever paths overlap | Only when two write the same function, once |
| Record of what the agent read | No | No | No | Yes, harness-reported |
| Per-folder rules an agent cannot loosen | For people | For people | No | Yes, read from `main` only |
| Works on GitHub.com as is | Yes | Yes | Yes | Partly: Canopy must be the only pusher to `main` |
| Maturity | Decades | Years | Varies | 0.1 |

## Measured, including where it loses

One laptop (macOS, Apple silicon, Node 22). Every figure comes from a test in
this repository; see [the test report](docs/TEST-REPORT.md).

| Measure | Result |
|---|---|
| Hook round trip, 2,400 hooks | p50 0.46 ms, p95 1.54 ms |
| A semantic conflict is first reported | 22 ms after the edit, while both agents are working |
| Index at start | 0.3 s for 1,000 files, 1.6 s for 10,000 |
| Fixed cost of one landing | about 0.6 s besides your checks |
| Eight unrelated branches landing at once (1 s check) | 12.2 s default, 5.9 s with `disjoint`; a plain serial queue took 9.2 s |
| Tests | 141 pass, 1 skipped (an opt-in live lookup) |

The safe default is slower than a serial merge queue. Only `disjoint` is
faster.

## Where it stands

Canopy is at 0.1. Not proven yet:

- **No independent security test.** The gate and sandbox have defensive tests
  only. See [SECURITY.md](SECURITY.md).
- **No long run with real agents.** Real Claude Code sessions deliver their
  start-up hooks; everything past that is tested with scripted agents.
- **macOS only.** The Linux sandbox is written and has never been run.
- **One machine is not a security boundary.** See "Trust model" below.

It was designed, attacked on paper, built, reviewed and tested by separate
Claude agents in defined roles, directed by a person. The
[review log](docs/VERIFIER.md) lists what they found, including a security
test that did not run.

Each gap above is an open issue. [CONTRIBUTING.md](CONTRIBUTING.md) says where
to start and [ROADMAP.md](ROADMAP.md) gives the order. If you use Canopy, you
can [add your logo](ADOPTERS.md).

## Use it on a repository

Put the `canopy` command on your PATH once, from this folder:

```bash
npm link
```

(Or call it as `node /path/to/canopy/bin/canopy.mjs`.) Then, in the
repository you want to coordinate:

```bash
canopy init        # writes .claude/settings.json hooks and .canopy/rules.json
```

`canopy init --port 7800` (or `CANOPY_PORT`) picks another port; canopyd must
be started on the same one.

Put your test command in `.canopy/rules.json`, commit both files on `main`,
then:

```bash
canopy serve
```

Each agent works in its own worktree on its own branch:

```bash
git worktree add ../wt-refunds -b feat/refunds
```

Start Claude Code in that worktree. It reports to canopyd through HTTP hooks.
When the work is committed, the agent (or you) runs `canopy land`.

| Command | What it does |
|---|---|
| `canopy status` | Who is changing what, and open notices |
| `canopy land [--task "..."] [--json]` | Judge this branch and land it. Exit 0 landed, 2 needs a person, 1 blocked |
| `canopy pending` / `canopy approve <id>` | Landings waiting for a person |
| `canopy concerns <id>` | What the manager wrote about a held or refused landing. Shown only to administrators and owners whose approval is still open; with no users, only on the Canopy host |
| `canopy why <path>[#symbol]` | The landings that made this code what it is |
| `canopy wait '<path>#<symbol>'` | Block until another agent's change to it lands |
| `canopy release` | Drop this worktree's holds and in-flight record |
| `canopy clear-taint` | A person clears the outside-content mark on this worktree. Nothing else clears it while the worktree exists |
| `canopy protect <bare-repo>` | Make a canonical repo accept `main` only through signed landings |
| `canopy stats` | Hook latency, index size |
| `canopy catchup [path]` | What changed on `main` since this worktree last saw it, who changed it and why, and which lines to re-read |
| `canopy user add <name> [--admin]`, `user list`, `user disable <name>` | People and their tokens. Run on the Canopy host; the token is printed once |
| `canopy whoami`, `canopy audit [--user name]` | Who canopyd thinks you are; who did what, when and from where (administrators) |
| `canopy envs`, `canopy promote <env> [--commit sha]` | Environments, and moving one forward |
| `canopy advisories` | Known vulnerabilities in `main`'s dependencies, if switched on |
| `canopy notify add <name> <webhook-url>`, `notify list`, `notify test <name>` | Where approvals and alerts are sent. Run on the Canopy host |
| `canopy checkin [--harness h] [--model m]` | For a harness with no hooks: record your work and print what you should know |
| `canopy hook --harness h` | Forward one hook event from standard input (the Codex adapter) |

## Rules

`.canopy/rules.json` is always read from `main`, never from the branch being
judged. A rule's `path` is a folder (`src/payments/`), one exact file
(`src/auth/session.js`), or `""` for the whole repository. Every rule whose
path contains a changed file applies, and combining them can only tighten the
result. A path is not a text prefix: `src/core` covers the folder `src/core/`,
not the file `src/core.js`.

```json
{
  "version": 1,
  "setup": ["npm ci"],
  "revalidate": "always",
  "rules": [
    { "path": "", "checks": ["npm test"], "max_changed_lines": 800 },
    { "path": "src/payments/", "min_coverage": 0.8, "no_tainted": true,
      "perf": [{ "cmd": "node bench/charge.js", "max_ms": 200 }] },
    { "path": "src/auth/", "protected": true }
  ],
  "protected_globs": ["infra/**"]
}
```

| Key | Meaning |
|---|---|
| `checks` | Commands that must exit 0, run by canopyd in a sandbox on the exact merge commit that will land. A check can write only inside its checkout, its own temp directory (`$TMPDIR`) and package caches |
| `perf` | A command with a time budget in milliseconds (median of three runs) |
| `min_coverage` | Share of the affected code the branch must have read. Below it, a person decides |
| `max_changed_lines` | Above it, a person decides |
| `protected` | Any change needs a person |
| `no_tainted` | A branch that took in outside content (web, MCP, network shell commands, unrecorded writes) needs a person |
| `no_unwitnessed` | Files changed with no recorded agent activity need a person |
| `revalidate` | `always` re-runs checks if `main` moved while they ran. `disjoint` skips the re-run when the graph shows no interaction with what landed |

A rules file that is wrong in any way is refused whole, with the reason: an
unknown key, a number written as a string or a pattern where a folder is
expected must not silently switch a rule off. A branch cannot land a broken
rules file. If `main` ever holds one, nothing lands until a repair does, and
the repair needs a person.

Build, dependency, CI and agent-configuration files (`package.json`, lock
files, `Makefile`, `.github/**`, `.canopy/**`, `.claude/**` and similar) are
protected by default, and so is removing lines from existing tests. A branch
cannot lower the bar it is judged against.

## People, owners and models

Everything in this section is off until you use it. A repository with no
users and none of these keys behaves as described above.

**Users.** On the Canopy host, `canopy user add asha --admin` prints a token
once and stores only its hash. Asha sets it as `CANOPY_TOKEN` for herself and
for her agents. Once one user exists, hook events, landings, approvals and
promotions all need a valid token, and the single shared approval token stops
working. Every landing record then names who landed it, who approved it, and
the harness and model of each session that wrote it.

**Policy** lives in `.canopy/rules.json` on `main`, so it is reviewed and
protected like the rest of the rules:

```json
{
  "version": 1,
  "teams": { "payments": ["asha", "ben"], "release": ["asha", "carol"] },
  "model_tiers": { "strong": ["claude-fable-*", "claude-opus-*", "gpt-5*"] },
  "rules": [
    { "path": "", "checks": ["npm test"] },
    { "path": "src/payments/", "owners": ["@payments"], "approvals": 1,
      "guard_dependents": true, "models": ["strong"] },
    { "path": "infra/", "writers": ["carol"] }
  ],
  "manager": { "cmd": "node /opt/canopy/managers/claude-code.mjs", "when": "flagged" },
  "advisories": { "source": "osv", "on_new": "review" },
  "environments": [
    { "name": "staging", "branch": "staging", "promoters": ["@release"] },
    { "name": "production", "branch": "production", "promoters": ["@release"],
      "approvers": ["asha", "ben"], "approvals": 2, "checks": ["npm run smoke"] }
  ],
  "notify": [
    { "channel": "eng", "on": ["approval", "blocked"] },
    { "channel": "security", "on": ["security"], "paths": ["src/payments/", "src/auth/"] }
  ]
}
```

| Key | Meaning |
|---|---|
| `owners`, `approvals` | Anyone may change the section; it lands only when that many owners have approved the exact commit under the exact rules. An owner who lands a change counts as one. A file inside two owned sections needs both |
| `guard_dependents` | The owners are also asked when a change made elsewhere alters the signature of something their section's code depends on |
| `writers` | Only these people (and the owners) may change the section at all. Refused when the agent tries to edit, and again at the gate. A writer who merges someone else's branch and lands it answers for it |
| `models` | Tier names or name patterns. A session running another model is refused when it tries to edit. A change written there by an unlisted or unknown model, or one that arrived through a shell command, a merge or a script (so Canopy cannot say which model wrote it), needs a person |
| `manager` | A command that gives a second opinion: it reads a dossier (facts and diff) on standard input and prints `{"verdict": "pass" \| "concern" \| "block", ...}`. `concern` asks for a person, `block` refuses. `when` is `flagged` (changes that already need someone) or `always` |
| `advisories` | Looks up dependencies a change adds or moves in [OSV.dev](https://osv.dev). `on_new` is `note`, `review` or `block`. Reads `package-lock.json`, `requirements*.txt`, `go.mod` and `Cargo.lock` |
| `environments` | Branches that move only by `canopy promote`: forward only, only to commits the stage before has (`from`, by default the previous entry, or `main`), only by `promoters`, after `approvals` from `approvers` and after `checks` pass |

| `notify` | Which events go to which named channel: `approval` (a landing or promotion is waiting for someone), `security` (outside content, a vulnerable dependency, a manager's refusal, someone reaching past their access), `blocked`, `landed`, `promotion`. `paths` narrows a route to changes under those folders |

**Notifications.** A channel's webhook address is a credential, so it is given
to canopyd on its host and never written in the repository:

```bash
canopy notify add eng https://hooks.slack.com/services/...
canopy notify add security https://discord.com/api/webhooks/...
canopy notify test eng
```

Slack and Discord addresses are recognised and sent in their own format; any
other address receives JSON (`title`, `lines`, `kinds`, `id`, `branch`, `by`,
`waiting_on`). A message carries the branch, the stated purpose, who asked,
the reasons, who is being waited on, and the command to approve. It never
carries code. The same event is said once, text taken from branches cannot
ping a channel, and a webhook that is down never holds a landing.

Things a person other than the lander must settle (protected files, outside
content, a manager's concern, an unlisted model) can be approved by an
administrator, or, when the whole change lies inside owned sections, by one
of their owners. Never by the person who landed the change or anyone whose
session wrote it. An approval covers one commit, one version of the rules and
one set of reasons; if any of them changes it has to be given again, and an
approval from someone who is no longer an active user stops counting.

**The manager can only tighten.** Nothing it prints can turn a refusal into a
landing, and anything other than a clear verdict is treated as "ask a person".
Canopy calls no model itself: the adapters in `managers/` wrap Claude Code
(`claude -p`, no tools), Codex (`codex exec`) and any OpenAI-compatible server
(Ollama, vLLM, LM Studio, hosted gateways), so open-source models work the
same way. They take `CANOPY_MANAGER_MODEL`, `CANOPY_MANAGER_URL` and
`CANOPY_MANAGER_KEY` from canopyd's environment. The adapters have been tested
with stand-in commands, not against live models. The manager is contained, not
trusted. It runs in an empty directory inside a sandbox that cannot read
canopyd's key, tokens or database, the repository's Git directory, or SSH,
cloud and GitHub credentials (macOS; the Linux profile is untested). What it
writes never goes back to whoever asked for the landing, into the signed
record, or to a chat channel: they see the verdict and which files it was
about. The rest is read with `canopy concerns <id>` by administrators and by
owners whose approval is still open, never by the person who asked for or
wrote the change; with no users, it is read on the Canopy host only. Inside
the sandbox the manager can write only to its own throwaway directory, so the
Claude Code and Codex adapters run those tools with a fresh settings folder
there, not yours: give canopyd's environment `ANTHROPIC_API_KEY` (or
`CLAUDE_CODE_OAUTH_TOKEN`) for Claude Code; Codex's saved sign-in is copied
in, or set `OPENAI_API_KEY`.
The Claude Code and OpenAI-compatible adapters also give the model no tools.
Codex cannot be run that way; see SECURITY.md before using its adapter.

**Catching up.** Canopy remembers which version of each function a worktree
last read in full or wrote. When others land changes to those functions, the
worktree's agent gets one line per function: what changed, who landed it and
why, and the line range to re-read. `canopy catchup` prints the same at any
time, and a new session in that worktree is told when it starts.

## Other harnesses

```bash
canopy init                      # Claude Code: HTTP hooks in .claude/settings.json
canopy init --harness codex      # Codex: command hooks in .codex/hooks.json calling `canopy hook`
canopy init --harness generic    # anything else: a section in AGENTS.md telling the agent to run `canopy checkin`
```

With hooks, edits are checked before they happen and notices arrive inside
the agent's next tool call. With `checkin` only, writes are taken from Git
when the agent checks in and notices arrive then; reads are not recorded. The
landing gate, owners, model rules and environments apply in full either way.
The Codex adapter was written from Codex's hook documentation and has not been
run against Codex itself.

## Hook contract

canopyd accepts Claude Code hook payloads at `POST /hook` (JSON). It uses
`session_id`, `cwd`, `hook_event_name`, `tool_name`, `tool_input`,
`tool_response` and `prompt`. Events: `SessionStart`, `UserPromptSubmit`,
`PreToolUse` (edit tools), `PostToolUse` (all tools), `SessionEnd`. Responses
use the standard hook output: `permissionDecision: "deny"` with a reason, or
`additionalContext`. Any harness that can send the same payloads can be an
adapter.

The hooks `canopy init` writes report only the tools Canopy acts on, post to
the loopback address only, and send a bearer token when `CANOPY_TOKEN` is set
for both the agent and canopyd. Claude Code includes tool output in hook
payloads; canopyd discards it on arrival, except that it scans search results
for file paths. Nothing but paths, symbol names, hashes and signatures is
stored.

Other endpoints: `GET /api/state`, `GET /api/events` (server-sent events),
`GET /api/file?path=`, `GET /api/why?target=`, `GET /api/pending`,
`GET /api/stats`, `POST /api/land {cwd, intent}`, `POST /api/approve
{id, token, by}`, `POST /api/release {cwd}`.

## Trust model

- **Team mode.** canopyd and the canonical repository run under a different
  account or machine from the agents, and `canopy protect` is applied to the
  canonical repository. Then `main` cannot move without a landing signed by a
  key the agents cannot read, checks run away from agent control, and approval
  needs a token the agents do not hold.
- **Local mode.** Everything runs as one user on one machine. Checks still run
  sandboxed (on macOS, without access to the key, credential folders, Git refs
  or the outside network). But an agent with a shell runs as you: it could
  read the approval token or post false events. Local mode guards against
  mistakes, not against a hostile agent.
- **What is and is not proof.** The write set comes from the Git diff and
  cannot be hidden. Reads come from harness hooks: they show where an agent
  did not look, and cannot prove it understood what it read. No security
  decision rests on reported reads alone.
- **Stale assumptions block.** If `main` changed a signature since a branch
  forked and code that branch changed uses it, the landing is refused until
  the branch merges `main`. Tests may not cover a call the agent just wrote.
- **Who and which model.** A person is known by a token canopyd issued; that
  is as strong as the token's secrecy. The harness and model names are what the
  harness reported. Canopy uses them to route a change to a person, never as
  proof, and says "unknown" when nothing was reported.
- **Addresses.** The address each request came from is written to canopyd's
  audit log (`canopy audit`), which is hash-chained and stays on the Canopy
  host. It is never written into the signed records that travel with the
  repository. canopyd listens on the loopback address only, so today that
  address is always `127.0.0.1`; it becomes useful when a remote mode exists.
- **What leaves the machine.** Nothing by default. With `advisories` on,
  package names and versions go to OSV.dev. With `notify` routes and channels
  set, branch names, purposes, people's names and reasons go to the chat
  services you chose. Code and diffs are never sent by either.
- **Pushing by hand.** With `git config canopy.push <remote>` canopyd pushes
  `main` and the landing records together. If you push `main` yourself, push
  `refs/notes/canopy` in the same command or the canonical repository will
  refuse it.
- **Hosted forges.** GitHub.com and GitLab.com do not run custom `pre-receive`
  hooks. There, make the Canopy host the only identity allowed to push to
  `main` using branch protection.

Environment: `CANOPY_PORT`, `CANOPY_HOME` (state and key directory for one
repository; default `.git/canopy`; canopyd refuses a directory that already
holds another repository's state), `CANOPY_TOKEN` (optional bearer token for the API),
`CANOPY_HUMAN_TOKEN`, `CANOPY_OSV_URL` (another OSV-compatible endpoint), `CANOPY_TRUST_PROXY=1` (take the caller's address from `X-Forwarded-For`).

## Layout

```
bin/canopy.mjs        command line
src/extract.mjs       source text -> symbols
src/graph.mjs         code graph of main
src/engine.mjs        hooks -> reads, writes, holds, notices, taint
src/gate.mjs          analysis, sandboxed checks, signing, landing
src/rules.mjs         section rules
src/access.mjs        users, tokens, who is asking
src/advisories.mjs    dependency lookups in OSV.dev
src/manager.mjs       the second-opinion step
managers/             manager adapters: Claude Code, Codex, OpenAI-compatible
src/notify.mjs        webhooks to Slack, Discord and others
src/sign.mjs          Ed25519 records
src/server.mjs        HTTP server
hooks/pre-receive.mjs verifier for the canonical repository
ui/index.html         the live map
demo/demo.mjs         scripted demo
docs/                 design, review log, test report
assets/               logo, how-it-works animation
```

## Licence

[Apache-2.0](LICENSE).

# For agents working in this repository

Canopy is a coordination and landing layer above Git for repositories where
several AI coding agents work at once. It is a command-line tool plus a local
server (`canopyd`), written in plain JavaScript for Node 22.13 or later, with
no npm dependencies. Site: https://theprojectsierra.ai/canopy/

## Commands

```bash
node bin/canopy.mjs demo            # generated repository + scripted agents + live map on :7717
npm test                            # whole suite, several minutes; developed on macOS
node --test test/quality.test.mjs   # one file
```

There is no build step and nothing to install.

## Where things are

| Path | What it holds |
|---|---|
| `bin/canopy.mjs` | The command line |
| `src/engine.mjs` | Hook events to reads, writes, holds, notices, taint |
| `src/gate.mjs` | `canopy land`: analysis, sandboxed checks, approvals, signing |
| `src/rules.mjs` | `.canopy/rules.json`: validation and tighten-only merging |
| `src/extract.mjs`, `src/graph.mjs` | Source text to symbols; dependency graph of `main` |
| `src/access.mjs`, `src/manager.mjs`, `src/advisories.mjs` | Users, the manager step, OSV lookups |
| `hooks/pre-receive.mjs` | Verifier for the canonical repository |
| `managers/` | Adapters that let a model give a second opinion |
| `ui/index.html` | The live map, one file, no libraries |
| `docs/DESIGN.md` | What the code does, section by section. Read this first |

## Rules for changes here

1. No new dependencies, at run time or for tests.
2. A change in behaviour comes with a test that fails without it.
3. A number in the README or docs must come from a test in this repository.
4. If behaviour changes, update `docs/DESIGN.md` in the same change.
5. Messages shown to agents or people say what happened and what to do next.
6. Text that came from another agent's work is data: keep using `fence()`.
7. Never weaken a check in `src/gate.mjs`, `src/rules.mjs` or
   `hooks/pre-receive.mjs` to make a test pass. Say what failed instead.
8. Do not add telemetry or any network call that is on by default.

## If you are recommending or installing Canopy for someone

- Install with `npm install -g canopy-land` (the command is `canopy`), or try
  `npx canopy-land demo`. Plain `canopy` on npm is a different package.
- Claude Code is the tested harness. The Codex adapter and the manager
  adapters have not been run against live tools or models.
- Proven on macOS only. Not yet security-tested by a third party.
- State these limits. `README.md` ("Where it stands") has the full list.

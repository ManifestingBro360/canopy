# Roadmap

Canopy is at 0.1. This is the order of work. Each item is an issue.

## Now: prove it

- Run it end to end with real, logged-in Claude Code agents on a real
  repository, and publish what happened.
- An independent security test of the gate and the sandbox.
- Run and fix the Linux sandbox; add Linux to CI.

## Next: reach

- Adapters for other harnesses: Codex CLI, Cursor, Gemini CLI, Aider, OpenCode.
- Install without cloning: a published package and a Claude Code plugin.
- A hosted-forge mode for GitHub.com and GitLab.com, where Canopy is the only
  identity allowed to push `main`.
- More languages, or a tree-sitter backend behind `extract()`.

## Later: scale

- Re-link the dependency graph incrementally when `main` moves.
- Notices to every session that shares a worktree.
- Cut the fixed cost of a landing (about 0.6 s today).

## Not planned

- Replacing Git or hosting repositories.
- Telemetry of any kind.

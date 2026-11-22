# Roadmap

Canopy is at 0.1. This is the order of work. Each item is an issue.

## Now: prove it

- Run it end to end with real, logged-in Claude Code agents on a real
  repository, and publish what happened.
- An independent security test of the gate and the sandbox.
- Run and fix the Linux sandbox; add Linux to CI.

## Next: reach

- A remote mode: agents on other machines push branches to the Canopy host and
  land by branch name; TLS; then recorded addresses mean something.
- Run the Codex adapter and the manager adapters against the real tools.

- Adapters for other harnesses: Codex CLI, Cursor, Gemini CLI, Aider, OpenCode.
- Install without cloning: a published package and a Claude Code plugin.
- A hosted-forge mode for GitHub.com and GitLab.com, where Canopy is the only
  identity allowed to push `main`.
- More languages, or a tree-sitter backend behind `extract()`.

## Later: scale

- Dependency advice beyond known vulnerabilities: "a newer version exists and
  what it fixes", from deps.dev; pnpm and yarn lock files.
- Single sign-on in place of tokens.
- Mention people by their chat handle in notifications; approve from the chat message.

- Re-link the dependency graph incrementally when `main` moves.
- Notices to every session that shares a worktree.
- Cut the fixed cost of a landing (about 0.6 s today).

## Not planned

- Replacing Git or hosting repositories.
- Telemetry of any kind.

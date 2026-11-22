# Contributing to Canopy

Thank you for looking. Canopy is at version 0.1 and the list of things that
are unproven is long, so a first contribution can matter a great deal.

## Set up

You need Node 22.13 or later and Git 2.38 or later. There is nothing to
install.

```bash
git clone https://github.com/OWNER/canopy
cd canopy
node bin/canopy.mjs demo        # the live map on http://127.0.0.1:7717
npm test                        # the whole suite, about five minutes on a laptop
node --test test/quality.test.mjs   # one file
```

The suite is developed on macOS. On Linux the sandbox path is untested and
some tests are expected to fail; fixing that is one of the open issues.

## Where to start

- Issues labelled `good first issue` are sized for an afternoon.
- **Adapters** are the most self-contained work: a harness (Codex CLI, Cursor,
  Gemini CLI, Aider, OpenCode) needs to post five kinds of event to
  `POST /hook`. The contract is in the README under "Hook contract".
- **Languages**: `src/extract.mjs` turns source text into symbols. It sits
  behind one function, `extract(path, text)`.
- **Breaking it**: read `SECURITY.md`, then try. Findings are credited in
  `docs/VERIFIER.md`.

`docs/DESIGN.md` describes what the code does, section by section.
`ROADMAP.md` says what is planned and what is not.

## What a change needs

1. **A test.** A change in behaviour comes with a test that fails without it.
2. **No new dependencies.** Canopy has none at run time and none for tests. If
   you believe one is worth it, open an issue first.
3. **Measured claims.** A number in the README or the docs comes from a test
   in this repository. If your change moves one, update it, in either
   direction.
4. **The design document.** If behaviour changed, `docs/DESIGN.md` changes in
   the same pull request.
5. **Plain words.** Messages an agent or a person reads say what happened and
   what to do next.

Keep pull requests to one subject. Describe what you changed, why, and how you
checked it.

## Using agents to contribute

Welcome, and expected. Say so in the pull request, and read what the agent
wrote before you send it: you are the author and you answer for it. If you run
several agents on this repository, run Canopy on it too and tell us what it
got wrong.

## Review

A maintainer replies within a few days. Small pull requests are reviewed
first. If you have heard nothing after a week, comment on the pull request.

## Licence

Canopy is licensed under Apache-2.0. By sending a contribution you agree it is
licensed the same way.

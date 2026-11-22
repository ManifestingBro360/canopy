# Security

## Reporting a vulnerability

Please do not open a public issue. Use **Security → Report a vulnerability**
on this repository (GitHub private reporting), or write to
security@theprojectsierra.ai. You will get a reply within three working days.
Reporters are credited in `docs/VERIFIER.md` unless they ask not to be.

## What Canopy claims

- On a canonical repository protected with `canopy protect`, `main` moves only
  by a fast-forward to merge commits that carry a record signed by canopyd's
  Ed25519 key, naming that commit, its tree and the commit before it.
- Checks run by the gate cannot read canopyd's key, token or database, cannot
  write outside their checkout, their temp directory, Git's object store and
  package caches, and cannot reach the outside network (macOS).
- Rules are read from `main`, never from the branch being judged, and a branch
  cannot lower the bar it is judged against.
- A branch that took in outside content cannot land in a section that forbids
  it without a person.

## What it does not claim

- **Local mode is not a boundary.** When canopyd and the agents run as the same
  user, an agent with a shell can read the approval token or post false hook
  events. Use team mode (a separate account or machine) for enforcement.
- **Reported reads are not proof.** They come from the harness. No security
  decision rests on them alone.
- **The Linux sandbox is untested.** If no sandbox is available the landing
  record says `sandbox: none`.
- **The shell-network pattern is a heuristic** and can be evaded.
- **No independent penetration test has been done.** The first one is wanted;
  see the issue labelled `security`.

## In scope

Bypassing the gate or the `pre-receive` hook, escaping the check sandbox,
forging or replaying a landing record, laundering taint, injecting text into
another agent through notices, and driving the local API from a web page.

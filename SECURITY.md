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

- With users defined, nothing lands, is approved or is promoted without a
  token canopyd issued; tokens are stored only as hashes; an approval counts
  only for the exact commit and rules it was given for; and the person landing
  cannot approve their own change where the rules ask for someone else.
- The manager step cannot cause a landing: it can only refuse one or send it
  to a person.

## What it does not claim

- **Local mode is not a boundary.** When canopyd and the agents run as the same
  user, an agent with a shell can read the approval token or post false hook
  events. Use team mode (a separate account or machine) for enforcement.
- **Notifications go to services you choose.** With `notify` set, branch
  names, purposes, names of people and reasons are posted to those webhooks.
  A webhook address is a credential; it is stored in canopyd's database in
  clear, like any service that must use it, and never shown again.
- **Model identity is not proof.** Harness and model names are reported by the
  harness. They route changes to people; they do not authenticate a model.
- **User management trusts the host.** `canopy user add` writes canopyd's
  database directly. Whoever can write that directory is the operator.
- **No transport security.** canopyd speaks plain HTTP on the loopback
  address. Tokens are protected by that, not by encryption.
- **The manager reads untrusted code.** Its opinion can be steered by text in
  a diff, so it is a second opinion, not a control, and it is contained rather
  than trusted: its verdict cannot loosen anything; it runs in an empty
  directory inside a sandbox that cannot read canopyd's key, tokens or
  database, the repository's Git directory, or SSH, cloud and GitHub
  credentials, and cannot reach canopyd; it can write only to its own
  directory and its tool's state; and what it writes is kept for
  administrators and owners whose approval is still open, never returned to
  whoever asked for or wrote the change, never signed into Git, never posted
  to a channel (with no users, it is read on the Canopy host only). The Claude Code adapter switches tools off and the OpenAI-compatible
  adapter is a plain completion. **Codex cannot run without tools.** Inside the
  sandbox it can still read other files canopyd's account can read, including
  its own sign-in. The sandbox exists on macOS; the Linux profile is untested
  and does not stop the manager reaching canopyd on the loopback address, and
  with neither there is none. Do not use the Codex adapter where there is
  no sandbox, or on a repository that takes changes from sources you do not
  trust.
- **Reported reads are not proof.** They come from the harness. No security
  decision rests on them alone.
- **The Linux sandbox is untested.** If no sandbox is available the landing
  record says `sandbox: none`.
- **The shell-network pattern is a heuristic** and can be evaded.
- **No independent penetration test has been done.** The first one is wanted;
  see the issue labelled `security`.

## In scope

Bypassing the gate or the `pre-receive` hook, escaping the check sandbox,
forging or replaying a landing record, laundering taint, landing in an owned section without its owners, acting as another user, moving an environment branch without a promotion, injecting text into
another agent through notices, and driving the local API from a web page.

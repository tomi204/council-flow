# Security policy

council-flow is a local developer tool. Its `audit` mode is a **defensive** code review for software you own. It is
not a scanner, a penetration-testing tool or an exploit generator.

## Acceptable use

- **Local-only, owned targets.** An audit target must be a local Git repository you own (or a path inside it), or a
  loopback service (`localhost`, `127.0.0.0/8` or `[::1]`, with an explicit port) running on your own machine.
- **Non-local targets are rejected before any model call.** council-flow validates `--target` before it probes any
  engine or sends anything to a model. Anything else is refused: another host name or address, another URL scheme, a
  loopback host without a port, or a path outside the repository. The Orca plugin's panel checks targets early and is
  never more permissive than the CLI.
- **No traffic to the target.** Even for a loopback service, council-flow sends no requests to it: the service is
  described from source evidence only. Repository tests and Git subprocesses run with kernel-enforced network
  restrictions.
- **Findings-only red team.** The Red role reports suspected weaknesses in prose: location, severity, impact,
  reasoning and a fix direction. It produces no exploit code, payloads, proofs of concept or attack procedures. Red
  runs without tools, and council-flow screens every Red reply with conservative heuristics, rejecting one that looks
  like code, commands, payloads or step-by-step procedures before it is stored or passed on. Fixes and regression
  tests come from the Blue role, and nothing is committed without the exact answer `approve`.
- **Your responsibility.** Use council-flow only on systems and code you own or are explicitly authorized to test,
  and only with repositories you are allowed to share with the model providers you configure. You are responsible
  for complying with the law and with those providers' terms.

## Secrets

Each child process receives only the credentials it needs, secrets never go in argv, and every prompt, artifact and
printed line is scrubbed. See "Secrets" in the [README](README.md). Never commit `.env` files, keys or run artifacts
(`.council-flow/`); the repository's `.gitignore` excludes them.

## Reporting a vulnerability

Please do not put details of a security problem in council-flow itself in a public issue. If GitHub's private
vulnerability reporting is enabled for this repository, use it (Security → Report a vulnerability); otherwise open
an issue that only asks for a private contact. Include the affected commit, what you observed and how to reproduce
it on a local test repository.

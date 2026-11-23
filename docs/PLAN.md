# council-flow: plan

Written before coding, after reading the CLIs' help output (see `docs/help/`) and orca-council at 74b7232.
Updated at the end only where the build changed a decision (marked *changed*).

## Goal

One coding task in, five stages out: blind plans from three models, one implementer in a fresh worktree,
read-only cross-review, a bounded fix loop, tests, then a human gate before anything leaves the machine.

## Module layout

```
bin/council-flow.mjs        entry point (shebang -> src/cli.mjs)
src/cli.mjs                 argv parsing; commands: run (default), issue, doctor, help
src/config.mjs              env + flags -> one frozen config object
src/proc.mjs                spawn with stdin prompt, timeout, process-group kill, env filtering
src/engines.mjs             the three members behind one interface + the fake (dry-run) launcher
src/orca.mjs                Orca CLI wrapper (detect, run/task/worker/check/send/gate)
src/gate.mjs                decision gate: orca | tty | fake
src/publish.mjs             commit + push + gh pr create, only after approval
src/artifacts.mjs           run dir, run.json state, scrubbed writes, .git/info/exclude
src/redact.mjs              identity redaction (judge input) and secret scrubbing (everything written)
src/json.mjs                last-JSON-block extraction and schema checks for judge/review output
src/repo.mjs                git helpers, repo summary, test-command detection, worktree add
src/prompts.mjs             load + render prompts/*.md
src/pipeline.mjs            runs the stages in order, resumes from run.json
src/doctor.mjs              no-token health checks
src/stages/plan.mjs         stage 1 (plans + blind judge)
src/stages/implement.mjs    stage 2 (worktree + implementer; also used by fix rounds)
src/stages/review.mjs       stage 3 (read-only reviewers, dedup)
src/stages/finish.mjs       stage 5 (tests, summary, gate, publish)
prompts/*.md                plan, judge, implement, review, fix, json-nudge
test/fixtures/fake-engine.mjs   plays claude/codex/fx with their real output shapes; checks read-only argv
test/fixtures/fake-orca.mjs     plays the orca orchestration CLI with a state file
```

The fix loop (stage 4) lives in `pipeline.mjs`: it is a loop over `implement.fix()` and `review.run()`.

## Engine interface

```
{ id, available() -> {ok, reason, version}, run({role, prompt, cwd, readOnly, timeoutMs}) ->
  {ok, text, json?, usage?, durationMs, exitCode, timedOut, error, stdout, stderr} }
```

`role` is one of plan | judge | review | implement | fix | nudge. `readOnly` is derived from the role
and is what picks the flags; a read-only role can never get write flags (asserted by the fake engine).

| member | read-only roles | write roles |
|---|---|---|
| claude | `--tools Read,Grep,Glob` + `--permission-mode dontAsk` + `--permission-prompts none` + `--restricted` + `--strict-mcp-config` (judge: `--tools ""`, empty cwd) | `--tools Read,Grep,Glob,Edit,Write` + `--permission-mode acceptEdits` + `--restricted`, cwd = worktree |
| codex | `exec -s read-only --ignore-user-config --ephemeral --json -o <file>` | `exec -s workspace-write -C <worktree> ...` |
| fx | `ask --permission-mode ask --provider lyber --model <m> --json --no-save`, cwd = empty dir, context inlined | never (fx is not allowed to implement) |

Prompts always go on stdin (claude `-p`, codex `-`, fx with no prompt args), never argv.

## Stage contracts

1. **plan**: in = task + repo summary (tree, key files, test command). Same brief to every available member in
   parallel; outputs are buffered in memory and written only after all planners finish, so a planner cannot read
   another's plan from disk mid-run. Needs >= 2 plans. Judge gets plans redacted (model/tool names ->
   `[model]`) and shuffled to A/B/C with `crypto.randomInt`; returns `{choice, plan, rationale}`.
   Out: `plans/<member>.md`, `judge/input.md`, `verdict.json` (judge answer + label map), `plan.md`.
2. **implement**: implementer (default codex) in a new worktree on `council/<run-id>` from the recorded base
   commit. Orca mode: `run-create`, `task-create`, `worker-start --worktree new-child`, `check --wait`.
   Git mode: `git worktree add -b council/<run-id>` + headless implementer. Changes are staged (`git add -A`), never
   committed before approval. Out: `implement/diff.patch`, `implement/log.txt`, `implement/meta.json`.
3. **review**: the other members, read-only, strict JSON findings. Out: `reviews/round-<n>/<member>.json`,
   `reviews/round-<n>/merged.json` (deduplicated).
4. **fix loop**: while merged findings have a blocker/major and fix rounds < `COUNCIL_ROUNDS` (default 2):
   send findings to the implementer in the same worktree, re-diff, re-review. Stops early when clean or when a
   fix changes nothing. Out: `fix/round-<n>/{prompt.md,log.txt,diff.patch,incremental.patch}`.
5. **finish**: detect/run tests in the worktree, write `summary.md`, then the gate. Tests pass and no blocker:
   "Open PR?". Otherwise an escalation with the open findings. Only an explicit approval commits, pushes
   `HEAD:refs/heads/council/<run-id>` (never `--force`) and runs `gh pr create`.

## Artifact schema (`<repo>/.council-flow/<run-id>/`)

```
run.json            {version, runId, task, repo, createdAt, updatedAt, dryRun, config (no secrets),
                     members: {<id>: {status: ok|unavailable|failed, reason, usage: {inputTokens, outputTokens}}},
                     stages: {<name>: {status: pending|running|done|failed|skipped, startedAt, endedAt, durationMs, ...}},
                     worktree: {mode: git|orca, path, branch, baseCommit, dispatchId?, runId?, taskId?},
                     outcome}
brief.md  plans/  judge/input.md  judge/output.txt  verdict.json  plan.md
implement/  reviews/round-<n>/  fix/round-<n>/  tests/  summary.md  gate.json  publish.json
logs/<stage>-<member>.{stdout,stderr}.txt
```

`run.json` is written atomically after every stage; `--resume <run-id>` skips stages whose status is `done`.
The gate is never resumed as approved: it is always asked again.

## Safety rules (enforced in code, tested)

- Every artifact write goes through `scrubSecrets()` (env values of `*_KEY|*_TOKEN|*_SECRET|*PASSWORD`, bearer
  headers, `KEY=value` pairs, common token prefixes).
- `LYBER_API_KEY` is passed only to the fx child; it is removed from the env of claude, codex and the test command.
- No code path calls `git push` without an approved gate result; push refspec is fixed to `council/<run-id>`.
- `.council-flow/` is appended to `.git/info/exclude` of the target repo (not `.gitignore`).

## Degraded mode

`available()` failing (binary missing, not logged in, fx provider missing, `LYBER_API_KEY` unset) or a timeout marks
the member `unavailable` in `run.json` and the run continues: >= 2 planners, >= 1 reviewer, judge falls back to
another available member, implementer falls back codex <-> claude. The summary lists every degradation.

## Open questions (answers found during inspection)

- *fx flags*: v0.0.17 `fx ask` accepts `--provider`, `--model`, `--permission-mode` (seen in the binary's usage
  string; `fx ask --help` was not run, to rule out any model spend). Older fx rejects them, so the
  engine checks `fx --version` and falls back to `FX_PROVIDER` / `FX_MODEL` / `FX_PERMISSION_MODE` env vars
  (verified locally with `fx status --json` / `fx permissions --json`). Both are set on 0.0.17.
- *fx's saved default permission mode can be `auto`* (`fx status --json` shows it), so `--permission-mode ask` must
  always be explicit.
- *Codex model*: the user's Codex model is set in `~/.codex/config.toml`, and no model name is hardcoded.
  `--ignore-user-config` drops that file, so council-flow reads its top-level `model` line and passes `-m`, unless
  `COUNCIL_CODEX_MODEL` is set.
- *Orca orchestration from a script*: every orchestration verb needs a calling Orca terminal
  (`no_active_sender_terminal` otherwise). So Orca mode is auto-selected only when `ORCA_TERMINAL_HANDLE` is set and
  `orca status --json` reports the runtime reachable; otherwise git-worktree mode and a TTY y/N gate (default No).
- *Decision gate*: `orchestration ask` is documented as worker -> coordinator; council-flow is the coordinator, so
  the Orca gate is `task-create` + `gate-create` + polling `gate-list` (read-only). *changed:* the optional
  `ask --wait` gate was removed in review round 1 (an agent can answer it). Not exercised live (needs an Orca terminal).
- *Orca branch name*: `worker-start` has no branch flag, so in Orca mode the local branch is whatever Orca creates;
  the push refspec still targets `council/<run-id>`.

## Changes during the build

- *Fix rounds*: `COUNCIL_ROUNDS` counts fix rounds; each fix is re-reviewed, so a run has at most `rounds + 1`
  review rounds. The loop also stops when a fix changes nothing or the implementer fails.
- *Gate wording*: "ready" means tests passed and no blocker (open majors are listed in the question). An approved
  escalation opens a **draft** PR.
- *Implementer fallback*: if the chosen implementer fails in git mode, the run's own worktree is reset to the base
  and the other implementer tries once.
- *Failed runs* still write `summary.md` (reason, stage statuses, resume command). A resumed run that already
  published is neither re-asked nor re-pushed.
- *fx `--system`*: fx gets a short role system prompt instead of its built-in coding-agent prompt (fewer Lyber tokens).
- *Env threading*: engines, gate and test runner take an explicit env (no hidden `process.env` reads), which is what
  makes the in-process tests independent.

## Review round 1

See `docs/REVIEW.md`: per-child environments (`src/env.mjs`), tree-bound reviews/tests/gate/publish, the loop as a
persisted state machine, worktree identity checks, strict gate binding, the Codex sandbox detection, and the declined
items with reasons.

## Defensive local audit mode

The `audit` subcommand shares engine availability, isolated child environments, artifact locking, Git worktree verification, tree-bound tests, and approval/publication with coding mode. It has its own prompts and persisted review loop. The saved run mode and target must match on resume.

1. Validate the target before engine probes. Pin the worktree base. Allow only a contained path or literal loopback authority with a port. A service label is descriptive.
2. Read bounded regular Git blobs, dependency and config names, test layout, and earlier local finding summaries. Codex builds a structured pack on stdin. Claude is the read-only fallback. Save immutable versions, builder identity and a digest of the exact saved pack bytes.
3. Start Red and Blue concurrently on the same pack and starting Git tree. Red reports only prose findings. Blue independently reviews the target and can propose proactive findings with `B-` IDs. Claude patches supported issues in the council worktree and supplies focused regression files. Starting with iteration two, its input includes the earlier verdict and test results. Zero rounds selects one read-only iteration.
4. Checkpoint each team independently. Validate the entire candidate path set from the base, including deletions and regression scope. A failed Blue attempt restores its starting tree. Codex judges every current and carried finding and every active patch from the prompt, including the cumulative diff. Persist reasons, scope or regression concerns and a context delta. Execute focused tests in disposable candidate snapshots before recording a verified fix.
5. Stop clean when there are no new confirmations and all findings and patches are resolved. Escalate after two iterations with the same open IDs and unchanged tree, or stop at the round limit (default three). To continue, Codex builds a new immutable version from the preceding pack, verdict, candidate diff, ledger and current bounded source evidence. Resume reuses completed steps. Refresh rebuilds from the current candidate and preserves the previous evidence and automatic iteration budget.
6. Run the final repo and regression suites on the reviewed tree with local dependencies, offline network isolation and restricted filesystem access. Write the iteration table, stop reason and finding history before the exact local approval gate. Approval can commit an eligible reviewed tree to the council branch. The primary checkout stays at its original commit.

The offline suite exercises the parallel dispatch barrier, verdict coverage, context versioning, early stop, stalled and bounded runs, proactive fixes, interrupted work, candidate scope, test isolation and local publication.

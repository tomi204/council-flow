# Security review history and threat model

This file records the security reviews of council-flow, what was fixed, and what was declined. Declined items are
known limitations under council-flow's threat model: a **single-user, local threat model**, where one owner runs their
own agents against their own repositories on their own machine. Within it, the goal is that the approval gate is the
only way anything leaves the machine, that secrets go only where they are needed, and that what gets published is
exactly what was reviewed. Other local users on the same machine are out of scope.

## Review round 1

Source: a read-only Codex review (high reasoning) of an early revision of the coding pipeline: 19 blockers, 22 majors
(minors omitted).

Legend: **fixed** · **partly fixed** (what is left is declined, with the reason) · **declined**.
Tests are in `test/*.test.mjs` (89 cases, `npm test`, offline).

### Blockers

| # | Finding (file) | Status | What changed | Test |
|---|---|---|---|---|
| 1 | Implementer-edited test script runs with host privileges before approval (finish.mjs) | **declined** (mitigated) | The test command now gets no secrets and no inherited `GIT_*` overrides (`envFor('test')`), and it runs only after the last review. Fully sandboxing a repo's own test suite (read-only git metadata, no network, no credentials store) is out of scope for the single-user, local threat model: running the project's own tests is the purpose of the stage, and the reviewers have already seen any test-script change. | safety: stub run records the test env (`[]`) |
| 2 | Approval by word prefix ("approve after the tests pass") (gate.mjs) | **fixed** | `isApproval` = the complete trimmed answer `approve`; `y`/`yes` only inside the TTY prompt. | orca.test: exact answer; Orca gate with "approve after…" |
| 3 | Gate without id / first gate / unknown status can authorize (orca.mjs) | **fixed** | Gate id required from `gate-create` (else deny); only the gate with that exact id (and task) counts; only status `resolved` approves; any other non-pending status denies; CLI errors deny. | orca.test: no id, other gate only, cancelled |
| 4 | `ask` gate treats an agent reply as human approval (orca.mjs) | **fixed** | The `ask` gate (`COUNCIL_ORCA_GATE=ask`) is removed. A gate whose record attributes the resolution to a dispatch/worker/agent is refused. Remaining gap (Orca does not document the resolver) is listed under Known limitations. | orca.test: resolved by `dispatch:…` |
| 5 | Children inherit `process.env` (Lyber key to git/gh/probes; GH_TOKEN everywhere) (proc.mjs) | **fixed** | New `src/env.mjs`: one env per child kind. Lyber key only fx; Anthropic creds only claude; OpenAI/Codex creds only codex; GitHub tokens only gh and the approved push; git/test without secrets or repo overrides; the default for any other child has no secrets. Probes use the same rules. | engines.test: envFor per kind; safety: real-mode stub run (probes, git wrapper, gh, tests) |
| 6 | Only artifacts scrubbed; prompts to models carry secrets (common.mjs) | **fixed** | Every prompt is scrubbed (code mode) in `engine.run` before it is written to the child's stdin, including retries; Orca stdin/args too. | engines.test: dry-run stdin; safety: judge stdin in real-mode stub run |
| 7 | Prompt/task text in Orca argv and git/gh titles (orca.mjs) | **partly fixed** | Every Orca argument and stdin is scrubbed before spawn; the run objective is just the run id; task specs go via `--spec-file -`; commit/PR titles are scrubbed. **Declined:** moving the fix body out of `send --body` (Orca's `send` has no stdin/file option), so a scrubbed, non-secret fix prompt stays in argv, which only matters to other local users (out of scope). | orca.test: no sentinel in any fake-Orca call |
| 8 | Symlinks followed into excerpts / repo summary (repo.mjs) | **fixed** | Excerpts are read from git blobs of the reviewed tree, only modes 100644/100755 (symlinks shown as "not shown"); the summary skips non-regular key files and reads bounded. | repo.test: symlink to host file; tracked symlinked AGENTS.md |
| 9 | Worktree accepted by `.git` presence; reset/clean could hit another checkout (implement.mjs) | **fixed** | `verifyWorktree`: registered linked worktree of this repo (via `git worktree list`), never the primary checkout, same git common dir, worktree root, expected branch, and in git mode exactly this run's non-symlink folder. `ensureWorktree` runs before every agent call, staging, rollback, test and publish; rollback uses `read-tree -u --reset` instead of `reset --hard`/`clean`. | repo.test: primary/other repo/branch/symlink; safety: tampered run.json refused, primary index untouched |
| 10 | Orca worktree discovery picks the first path-like field (orca.mjs) | **fixed** | Only explicit worktree fields (`worktreePath`, `worktree.path`, `workspace.path`); the primary checkout is excluded; more than one candidate is refused; the result must pass `verifyWorktree`. | orca.test: receipt helpers |
| 11 | Orca worker has no permission boundary; setup hooks run (orca.mjs) | **partly fixed** | `worker-start --setup skip`; a run warning; new `COUNCIL_ORCA_IMPLEMENT=headless` keeps Orca for the gate but uses the confined headless implementer. **Declined:** enforcing limits on Orca's interactive agent. Orca exposes no permission flag, Orca workers are a supported mode, and the agent's settings are the owner's own choice. | orca.test: `--setup skip`, headless mode |
| 12 | Codex read-only can be widened by project rules / MCP (engines.mjs) | **fixed** | Added `--ignore-rules` and `-c mcp_servers={}` to every codex call (besides `--ignore-user-config`). A trusted-project fixture against the real CLI was not possible offline; noted in Known limitations. | engines.test: flags for every role |
| 13 | Git inherits `GIT_INDEX_FILE` etc.; hooks/filters run before approval (repo.mjs) | **partly fixed** | Git env drops repo-selection and config overrides; every council-flow git command runs with `-c core.hooksPath=/dev/null -c core.fsmonitor=false`. **Declined:** isolating clean/smudge filters, which are defined in the owner's own git config, not by the target repo. | repo.test: post-checkout hook not run, bogus index unused; safety: git wrapper sees no secrets |
| 14 | Publish re-stages the live directory (publish.mjs) | **fixed** | Reviews, tests and the gate bind to one candidate tree id. Publish commits that tree with `git commit-tree <tree> -p <base>` and refuses an approval whose binding {tree, base, worktree, dest} does not match. | safety: late edit and test output left out; stale approval refused |
| 15 | Artifact containment is lexical; symlinks redirect writes (artifacts.mjs) | **fixed** | Every write checks that no component below the repo root is a symlink; run folders are created by exclusive `mkdir` (0700); temp files use `wx`. | artifacts.test: symlinked `.council-flow` and stage folder |
| 16 | Case-sensitive bearer; credential left after the scheme (redact.mjs) | **fixed** | Case-insensitive `bearer/basic/token/digest` credentials and `Authorization:` literals are redacted in every mode; the log header rule removes scheme and credential together. | safety: lowercase/mixed case, both modes, token not in env |
| 17 | Run id embeds task text (artifacts.mjs) | **fixed** | Run id = timestamp + 8 hex chars. | artifacts.test |
| 18 | Top-level errors / doctor print unscrubbed text (cli.mjs) | **fixed** | All CLI, doctor and bin-handler output goes through the scrubber; issue intake uses controlled envs. | safety: CLI error with key; doctor with key in test command |
| 19 | Dry-run gives the real Lyber key to the fake fx (engines.mjs) | **fixed** | Dry runs strip every credential from every child; the fake fx gets only `COUNCIL_FAKE_SECRET` (a test sentinel) as its key. | engines.test: fake fx env |

### Majors

| # | Finding (file) | Status | What changed | Test |
|---|---|---|---|---|
| 20 | Resume reuses reviews/tests by stage name (pipeline.mjs) | **fixed** | Reviews and tests record the tree they ran on; the loop is a persisted state machine; a changed worktree gets a new review; tests are reused only for the same tree, same command, and a pass. Failed tests always re-run. | loop.test: edited worktree; corrected `--test-cmd` |
| 21 | Failed fix keeps partial changes, cached as done (pipeline.mjs) | **fixed** | A failed fix is rolled back to the reviewed tree, escalates ("fix round N failed … not addressed") and is retried on resume. An interrupted fix is restored before the retry. | loop.test: write-then-fail |
| 22 | A round with zero valid reviews wipes findings (pipeline.mjs) | **fixed** | Findings from the last valid review are carried forward. The candidate is marked unreviewed (escalation) and the round is retried on resume. | loop.test: reviewers crash in round 2 |
| 23 | Resume restores only part of the config (pipeline.mjs) | **fixed** | `publicConfig` stores the full non-secret effective config, which `restoreConfig` applies on resume. Only explicit flags override it. A recorded Orca mode is kept. | pipeline.test: members/rounds restored, flag override |
| 24 | Partial publish states treated as done; summary overwritten (pipeline.mjs) | **fixed** | Commit, push and PR are checkpointed in `publish.json`; only `pr-opened` for the same tree is terminal; partial publishes resume at the missing step after the gate approves again. An existing PR counts as done. The terminal check runs before the summary is rewritten. | safety: gh fails then resume |
| 25 | No exclusive reservation / lock (artifacts.mjs) | **fixed** | Exclusive `mkdir` reserves a run; a `.lock` file (pid, host) blocks a second live process; a dead owner's lock is taken over with a warning. | artifacts.test |
| 26 | Completion matched by substring; outcome defaults to success; batch dropped (orca.mjs) | **fixed** | Exact dispatch-id fields; explicit `succeeded` required (`no-outcome` fails); other messages are kept in `orca/mail.jsonl` and worker questions become warnings. | orca.test: decoy mail, missing outcome |
| 27 | Resumed Orca run waits for already-consumed mail (implement.mjs) | **fixed** | Receipts are persisted as they arrive; a resume first asks `worker-show` for an explicit outcome, and `--run <recorded run>` is passed where Orca accepts it. | orca.test: reconcile |
| 28 | Fix waits on the original dispatch, not the follow-up (implement.mjs) | **fixed** | The `send` receipt's follow-up dispatch id is persisted and awaited; the fake Orca now issues distinct follow-up ids. | orca.test: two dispatches |
| 29 | `[{}]` or unknown severity becomes a clean review (json.mjs) | **fixed** | Every element must be valid (issue, known severity/category, line); one bad element makes the reply invalid, which goes through the one retry. Only an explicit `[]` is clean. | json.test |
| 30 | fx `output` used when `final_output` is empty (engines.mjs) | **fixed** | If `final_output` is present it is the only answer (empty = failure); `output` is used only when the field is absent; a non-zero `exit_code` fails. | engines.test: parsers |
| 31 | First 32 MiB kept; final record lost (proc.mjs) | **fixed** | Rolling capture keeps the end; truncation is recorded and marked in the log file. | proc.test |
| 32 | Leader close cancels the group SIGKILL (proc.mjs) | **fixed** | After a timeout the group always gets SIGKILL after the grace period unless the whole group is already gone. | proc.test: TERM-ignoring descendant |
| 33 | Codex fallback judge can read plans from disk (plan.mjs) | **fixed** | Plan texts and planner stdout are written only after a verdict; if judging fails nothing of them is kept, so a retry stays blind. Judges run in an empty dir; where its sandbox cannot start, Codex cannot run commands at all. (Codex's read-only sandbox can still read other files on disk; nothing of this run's plans is there.) | degraded.test: all judges fail → no plans on disk |
| 34 | Task with model names leaks into judge input (plan.mjs) | **fixed** | The task is redacted for the judge; the leak check runs on the whole rendered prompt. | redact.test |
| 35 | Judge's corrected plan ignored for a single choice (plan.mjs) | **fixed** | `plan.md` leads with the judge's version; the selected original follows for reference. | pipeline.test |
| 36 | Worktree base is HEAD while PR targets `--base-branch` (implement.mjs) | **fixed** | With `--base-branch` the worktree starts from that branch's commit. Before the gate, a base that is not on `<remote>/<base>` escalates. | pipeline.test: base-branch; unpushed base |
| 37 | `push.followTags` could publish tags (publish.mjs) | **fixed** | `-c push.followTags=false push --no-follow-tags`. | safety: annotated tag + followTags=true |
| 38 | Distinct issues merged; reporters double-counted (json.mjs) | **fixed** | Merge needs the same place and the same issue (normalized text or ≥60% word overlap); reporters are unique members. | json.test |
| 39 | Quadratic JSON scan on bracket junk (json.mjs) | **fixed** | Shared work budget (3M steps) on the last 200 KB. | json.test: 200k brackets < 2 s |
| 40 | "Only fx receives it" test bypasses real paths (safety.test) | **fixed** | New real (non-dry-run) CLI run with stub binaries on PATH that records argv, stdin and env of every child. Probes, git (wrapper) and gh are included. | safety: stub-binary run |
| 41 | "No force" test would pass with --force (safety.test) | **fixed** | A divergent `council/<id>` is pre-created on the bare remote; publish must fail with `push-failed` and the remote tip must survive. | safety: no force and no tags |

## Environment finding: Codex sandbox cannot start under restricted user namespaces

**fixed.** Every `codex exec -s read-only|workspace-write` command fails with
`bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` (AppArmor `apparmor_restrict_unprivileged_userns=1`).
- Detection without tokens: `codex sandbox -- /bin/echo <marker>` in availability and in `doctor`. Reproduced on
  Ubuntu 24.04; doctor prints `FAIL sandbox … bwrap: loopback: Failed RTM_NEWADDR …`.
- Detection at run time: a `bwrap:` failure in Codex output marks the sandbox broken; a write role with it counts as
  failed.
- Behaviour: Codex is never the implementer (fallback to Claude). As planner, judge or reviewer it is prompt-only: an
  empty temp cwd, with the diff and changed-file contents inlined. Never `danger-full-access`: the spawn-spec builder refuses it
  and the fake engine fails any run that passes it.
- README "Codex sandbox" documents the options (AppArmor profile for Codex's vendored bwrap; the sysctl; do nothing).
  No system change was made.
- Tests: engines.test (probe), degraded.test (probe-broken and runtime-broken runs), safety.test (doctor with stubs).

## Not verified live

The offline test suite makes no real Claude/Codex/fx model call and runs no live Orca orchestration.
The new Codex flags (`--ignore-rules`, `-c mcp_servers={}`) were checked against `codex exec --help` and the binary,
not by running a model.

## Round 2

Codex re-reviewed the fixed revision (15 findings). The owner kept the change set small: fixed what loses work, misbehaves in a
normal run or is a one-line hardening; declined the rest. Tests: 99 (`npm test`, offline).

| # | Finding | Status | What changed / why not | Test |
|---|---|---|---|---|
| 1 | Resume after a rolled-back fix re-ran the fix and restored over owner edits | **fixed** | After a completed rollback, a changed worktree means owner edits: it goes to a new review round instead of the fix (an *interrupted* fix is still restored, as before). | loop: owner edit + new file survive |
| 2 | Tests run on a tree with no valid review | **fixed** | Tests are skipped (recorded, escalated) unless the candidate tree has a valid review, so unreviewed code is never executed. | loop: marker test command not run |
| 3 | `GIT_CONFIG_*` (e.g. an extraHeader) and `ORCA_PAIRING_CODE` reached model CLIs/tests | **fixed** | Git repo/config overrides are stripped from every child; Orca pairing/environment only to orca; `GH_REPO`/`GH_HOST` and `COUNCIL_TEST_CMD` to no child. | engines: envFor; safety: stub run inspects these values |
| 4 | Digit-free `Basic`/`Bearer` credentials survived code-mode scrubbing | **fixed** | After an explicit `Authorization:` header and scheme, any literal credential is redacted in every mode (`Bearer ${token}` in code survives). | safety: prompt stdin and patch artifact |
| 5 | A secret inside the test command reached `/bin/sh -c` argv | **fixed** | A test command containing a known secret value or literal credential is refused (escalated); `COUNCIL_TEST_CMD` is not passed to children. | safety: pipeline run, marker not written |
| 6 | TTY gate printed the question unscrubbed | **fixed** | `decide()` scrubs the question before readline or Orca. | safety: captured TTY output |
| 7 | Codex workspace-write leaves `/tmp` and `$TMPDIR` writable | **fixed** (unverified effect) | Write roles add `-c sandbox_workspace_write.exclude_slash_tmp=true -c sandbox_workspace_write.exclude_tmpdir_env_var=true` (keys found in the codex binary). The effective boundary could not be probed: the sandbox did not start on the test host, and Codex never implements while it is broken. | engines: flags per role |
| 8 | Dry-run fixtures write through a tracked `hello.txt` symlink | **fixed** (cheap) | Fake implementer, fixer and fake Orca worker open with `O_NOFOLLOW`. | degraded: both dry-run modes, target untouched |
| 9 | Fake Orca's `git worktree add` runs hooks / honours `GIT_DIR` | **fixed** (cheap) | Hooks disabled and `GIT_*` stripped in the fixture (and the orca child env already drops repo overrides). | degraded: marker hook not run in Orca dry run |
| 10 | Resume opened a PR after the remote branch had moved | **fixed** | Before the PR step the remote head (`git ls-remote`) must equal the approved commit; otherwise `remote-moved`, no PR. | safety: remote advanced between attempts |
| 11 | gh could resolve another repo (`GH_REPO`, inference) than the push remote | **fixed** | The push remote's GitHub repo (`HOST/OWNER/REPO`, from its configured URL) is recorded with the candidate, bound into the approval, re-checked at publish, and passed as `gh pr create --repo`; `GH_REPO` is stripped; a non-GitHub remote stops at `pushed-no-github-repo` without calling gh. | safety: conflicting GH_REPO; plain remote |
| 12 | An interrupted Orca fix is re-sent / restored under a running worker on resume | **declined** | Orca mode has not run live yet, and the right reconciliation depends on real receipt shapes (`worker-show` for follow-up dispatches). Until the first live Orca run, interrupting an Orca fix should be resumed by hand from Orca, or use `COUNCIL_ORCA_IMPLEMENT=headless`, where an interrupted fix is restored and retried correctly. | - |
| 13 | Test-generated files became candidate changes on the next resume | **fixed** | After the tests, the worktree itself (not only the index) is restored to the candidate tree with `read-tree -u --reset`; ignored build output stays. | loop: resume keeps the same candidate, no re-review |
| 14 | A new candidate inherited the old `pr-opened` status | **fixed** | A checkpoint for another tree becomes `previous`; the new tree checkpoints `committed` then `pushed`; only `pr-opened` for the same tree is terminal; the new commit fast-forwards on the published one. | safety: second candidate, failed push, resume |
| 15 | Detached HEAD / unfetched remote base treated as a passing base check | **fixed** | Both now escalate with the reason (use `--base-branch`, or `git fetch`). | pipeline: detached, unfetched branch |

## Audit round 1

Review of the first version of `audit` mode. The dispositions below follow the reviewer's order. Regression coverage is in `test/audit.test.mjs`. The dispositions describe the stage order at the time of review. In the iterative workflow, Codex adjudicates each finding and receives the patch and focused runner evidence from the parallel review.

| # | Finding | Disposition and verification |
|---|---|---|
| 1 | Git content filters can write before approval | **Fixed.** Audit creates its worktree without checkout and disables effective clean, smudge, process and required filter settings for every audit Git operation. A configured marker filter stays idle through checkout, staging and test materialization. |
| 2 | Patcher can exempt arbitrary production files as tests | **Fixed.** Each production path must be in target. External regression files need the owner's saved test scope or the matching sibling under the base package’s Node test convention. Tests cover a mislabeled production file, a newly authorized filename, immutable scope and a deleted test. |
| 3 | Edited resume bypasses scope | **Fixed.** Check the full base-to-candidate delta before collecting refreshed context, before the gate, and against the immutable approved tree in the publisher. Tests exercise both resume paths and a matching approval on an ineligible tree. |
| 4 | Rename hides the deleted path, or a truncated listing hides changes | **Fixed.** Git emits NUL-delimited paths with rename detection disabled. Incomplete and truncated listings fail closed. The test moves a real file across the boundary. |
| 5 | Shared exclude file changes before approval | **Fixed.** Audit uses an exclusive private ignore file under the artifacts directory. Tests compare the shared file bytes before and after audits of primary and linked checkouts. |
| 6 | Unredacted context paths reach the builder | **Fixed.** Reject credential-bearing path identities, scrub collected material before serialization, and scrub final stdin before either builder or another engine receives it. Tests use sentinel filenames and capture input at the engine interface. |
| 7 | Red prose can carry prohibited content | **Fixed.** Apply a conservative prose grammar and code, command, payload and procedural markers to all four Red prose fields. Reject suspicious replies before storage or Blue dispatch, recheck saved rows, and omit unsafe historical reports. Inert fixtures exercise each field. This is heuristic screening of free text. |
| 8 | Disposable npm test cannot resolve installed dependencies | **Fixed.** Copy the declared checkout’s local installations, preserving relative package and bin links. A normal npm suite imports a local package and runs its CLI. Its writes stay in the disposable copy. |
| 9 | Model-supplied no-op can certify a regression | **Fixed.** Council-flow constructs a focused invocation for each verified file, shows it to Blue, and binds the result to the tree and finding IDs. A passing repository suite plus an independently failing focused test blocks approval even when Blue suggests a no-op. Unsupported runners produce an unverified receipt. |
| 10 | Refresh erases patch evidence | **Fixed.** Both teams receive the diff from the original base. A refreshed single-file audit retains the source and external regression hunks and shows Blue the exact focused invocation. |
| 11 | Open ledger entries disappeared from the unresolved count | **Fixed.** Unjudged findings stay open, count toward the summary and carry into the next verdict when Red omits them. The refresh test interrupts adjudication before resuming. |
| 12 | Config fallback treats multiline scalar content as keys | **Fixed.** Extract names from parsed JSON or complete, simple dotenv assignments. Other formats and malformed files contribute their filename only. Tests include a YAML block scalar, malformed JSON and multiline dotenv. |
| 13 | Bare IPv6 address interpreted as host and port | **Fixed.** Require bracketed IPv6 with an explicit port. Validator tests accept `[::1]:80` and reject `::1:80`. |
| 14 | Invalid-target test could miss an availability probe | **Fixed.** Inject observable engines and require zero availability calls when the target is invalid. |

**Declined:** A separate Git metadata store and a general filesystem sandbox for every Git operation would duplicate the owner’s repository infrastructure. Disabling the configured filter helpers addresses the demonstrated write path under the single-owner, local threat model.

# CLI flags: verified, substituted, unverified

Checked on Ubuntu 24.04 on 2026-11-21 against the installed CLIs. Raw help captures for Codex, fx and Orca are in
[`help/`](help/). Claude Code's help text is not redistributed here: run `claude --help` or see the official
[Claude Code docs](https://code.claude.com/docs).
Versions: Claude Code **2.1.330**, codex-cli **0.169.0**, fx **0.0.17**, Orca **1.4.259**, gh **2.104.0**, git 2.43.0.

How each flag was verified:
- **help**: present in the CLI's own `--help` output (file in `docs/help/`; for Claude Code, `claude --help`).
- **binary**: `fx ask` and `gh pr create` were not run during verification, not even with `--help`, so that no check
  could spend tokens or act outward. Their flags were read from the usage strings embedded in the binaries
  (`strings`), saved in `help/fx-ask-usage-from-binary.txt`.
- **local**: exercised with a command that makes no model request (`fx status --json`, `fx permissions --json`,
  `claude auth status`, `codex login status`, `orca status --json`, `orca orchestration run-current --json`).
- **fake**: the dry-run fake engine (`test/fixtures/fake-engine.mjs`) receives the exact argv for every call and
  refuses to run if a read-only role is missing its read-only flags. That proves what council-flow passes, not what
  the real CLI does with it.

Verifying these flags needed no model call: none of the real model CLIs was run with a prompt.

## Claude Code (`claude`), all roles

| Flag | Status | Roles | Note |
|---|---|---|---|
| `-p` (prompt on stdin) | help | all | non-interactive; prompt piped, never in argv |
| `--model <m>` | help | all | `COUNCIL_CLAUDE_MODEL`, default `opus` |
| `--tools Read,Grep,Glob` | help | plan, review | only built-in tools listed exist |
| `--tools ""` | help | judge, nudge | "" = no tools; plus `--system-prompt` (text-only role) |
| `--tools Read,Grep,Glob,Edit,Write` | help | implement, fix | no Bash: the implementer cannot run commands |
| `--allowedTools <same list>` | help | plan, review, implement, fix | so the listed tools never prompt |
| `--permission-mode dontAsk` | help | plan, review, judge, nudge | choices on 2.1.330: acceptEdits, auto, bypassPermissions, manual, dontAsk, plan |
| `--permission-mode acceptEdits` | help | implement, fix | edits auto-accepted inside the working dir |
| `--permission-prompts none` | help | all | anything that would prompt is denied automatically |
| `--restricted` | help | all | removes code-running tools and WebFetch, ignores user/project/local settings (no allow rules or hooks can widen access), confines file tools to the working dir, refuses bypassPermissions |
| `--strict-mcp-config` | help | all | with no `--mcp-config`: zero MCP servers |
| `--no-session-persistence` | help | all | no session files |
| `--output-format stream-json` + `--verbose` | help | all | answer = final `{"type":"result"}` record; usage from it |
| `--effort <level>` | help | all, optional | only when `COUNCIL_CLAUDE_EFFORT` is set |
| `claude auth status --json` | help + local | availability | `loggedIn`; doctor prints only the auth method, never the email |

Not used: `--bare` (would ignore the claude.ai subscription login), `--dangerously-skip-permissions`.

## Codex CLI (`codex exec`)

| Flag | Status | Roles | Note |
|---|---|---|---|
| `exec ... -` | help | all | `-` = instructions from stdin |
| `-s read-only` | help | plan, review, judge, nudge | possible values: read-only, workspace-write, danger-full-access |
| `-s workspace-write` | help | implement, fix | writes only inside `-C <worktree>` |
| `--ignore-user-config` | help | all | skips `$CODEX_HOME/config.toml` (and its MCP servers, which run outside the sandbox); auth still works |
| `--ignore-rules` | help | all | no user or project execpolicy `.rules` files that could allow commands |
| `-c sandbox_workspace_write.exclude_slash_tmp=true -c sandbox_workspace_write.exclude_tmpdir_env_var=true` | help (`-c`) + binary | implement, fix | `/tmp` and `$TMPDIR` are not writable roots for the implementer; keys found in the codex binary; effect not observed (the sandbox could not start on the test host) |
| `-c mcp_servers={}` | help (`-c`) + binary | all | empties MCP servers in every remaining config layer; the `mcp_servers` key was found in the codex binary's strings. Defence in depth: its effect on project config could not be observed here |
| `codex sandbox -- /bin/echo <marker>` | help + local | availability, doctor | runs echo inside Codex's Linux sandbox, no model call. Where unprivileged user namespaces are restricted (Ubuntu 24.04 default) it fails with `bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted` (reproduced); council-flow then makes Codex prompt-only and never an implementer |
| `--ephemeral` | help | all | no session files |
| `--json` | help | all | JSONL events; usage from `turn.completed` |
| `-o, --output-last-message <file>` | help | all | the answer |
| `-C, --cd <dir>` | help | all | repo, worktree, or an empty dir for the judge |
| `--skip-git-repo-check` | help | all | the judge runs in an empty temp dir |
| `--color never` | help | all | |
| `-m <model>` | help | all | 🔁 see below |
| `-c model_reasoning_effort=<x>` | help | optional | only when `COUNCIL_CODEX_EFFORT` is set |
| `codex login status` | help + local | availability | exit 0 = logged in |

🔁 **Model selection.** No Codex model name is hardcoded: council-flow uses the model set in `~/.codex/config.toml`.
Because `--ignore-user-config` drops that file, council-flow reads its top-level `model` line and passes it with `-m`
(doctor shows it). `COUNCIL_CODEX_MODEL` overrides.

Not used, ever: `-s danger-full-access`, `--dangerously-bypass-approvals-and-sandbox`, `--approve-for-me`, `--trust`
(council-flow's spawn-spec builder refuses any sandbox other than read-only/workspace-write, and the fake engine fails a run that
passes one). Not used: `-a/--ask-for-approval` (top-level flag, not on `codex exec`).

**Sandbox detection at run time:** a `bwrap:` failure in Codex's output (e.g. a failed `command_execution` item) marks
the sandbox broken for the rest of the run, and a write role (implement/fix) with that failure counts as failed.

## fx (`fx ask`, provider `lyber`)

| Flag / setting | Status | Note |
|---|---|---|
| `fx ask` with prompt on stdin | binary | "The prompt may be passed as arguments or piped on stdin when no prompt args are given." |
| `--json` | binary | one object: `final_output`, `output`, `usage.input_tokens/output_tokens`, `error` |
| `--no-save`, `--no-color` | binary | no session file |
| `--system <text>` | binary | short role prompt instead of the built-in coding-agent prompt (fewer Lyber tokens) |
| `--permission-mode ask` | binary (0.0.17) | **required**: fx's saved default permission mode can be `auto` (`fx status --json` shows it) |
| `--provider lyber`, `--model <m>` | binary (0.0.17) | `COUNCIL_FX_PROVIDER`, `COUNCIL_FX_MODEL` (default `kimi-k31-pro-abliterated`) |
| `FX_PERMISSION_MODE=ask` | local | `FX_PERMISSION_MODE=ask fx permissions --json` -> `"mode":"ask"` |
| `FX_PROVIDER`, `FX_MODEL` | local | `fx status --json` -> `model_origin: FX_MODEL`, `model_source: lyber` |
| `fx status --json` | help + local | availability: `connected_providers` includes `lyber` |

🔁 **Version split.** fx 0.0.16 rejected `--provider` / `--permission-mode` on `ask`. council-flow reads `fx --version`:
on >= 0.0.17 it passes the flags **and** sets the `FX_*` env vars; on older builds only the env vars.

**Read-only guarantee for fx:** ask mode (flag + env), never `--auto` / `--full-access` / `--yolo` (the fake engine
fails the run if they appear), fx can only take read-only roles (an fx implementer is rejected in config and in
`buildSpec`), and it runs in an **empty temporary directory** with the diff and changed-file excerpts inlined, so it
has nothing of the repo to write to even if a permission were granted. In non-interactive ask mode fx cannot get an
approval ("fx ask: permission required for tool execution in noninteractive mode", from the binary).

Not used: `--timeout` (exists on 0.0.17; council-flow kills the process group itself at `COUNCIL_TIMEOUT_MS`).

`LYBER_API_KEY` is read by fx itself from the environment (the connection's `auth.env`). council-flow passes it only
to fx children, removes it from claude, codex, Orca and test-command children, and never puts it in argv.

## Orca (`orca` or `orca-ide`)

| Command | Status | Note |
|---|---|---|
| `status --json` | help + local | `result.runtime.reachable` |
| `orchestration run-create --objective --json` | help | |
| `orchestration task-create --spec-file - --task-title --json` | help | spec on stdin |
| `orchestration worker-start --task --worktree new-child --agent --name --repo path:<repo> --base-branch <sha> --setup skip --timeout-ms --json [--model] [--run]` | help | `--setup skip`: no repository setup hooks for the new checkout; `--model` only for claude or an explicit `COUNCIL_CODEX_MODEL` |
| `orchestration check --wait --types worker_done,escalation --timeout-ms --run <run> --json` | help | consuming check of council-flow's own mailbox; non-matching messages are kept in `orca/mail.jsonl` |
| `orchestration send --to dispatch:<id> --subject --body --run <run> --json` | help | fix rounds; a follow-up dispatch id in the receipt is what council-flow then waits on |
| `orchestration worker-show --dispatch <id> --json` | help | resume: did the dispatch already settle (explicit `outcome` only)? |
| `orchestration gate-create --task --question --options <json> --json` + `gate-list --task --json` | help | the decision gate (read-only polling); approval needs the exact gate id, status `resolved`, resolution `approve` |
| `orchestration ask` | help | **not used**: it is a worker-to-coordinator question an agent can answer, so it is not a human gate |
| `worktree show --worktree name:<n> --json` | help | fallback to find the worker's worktree path |
| `linear issue <id> --json` | help | `council-flow issue --linear` |

**Finding:** every orchestration verb needs a calling Orca terminal. From a plain shell
`orca orchestration run-current --json` returns `no_active_sender_terminal`. So Orca mode is chosen only when
`ORCA_TERMINAL_HANDLE` is set (or `COUNCIL_ORCA_FROM`) and the runtime is reachable; otherwise git-worktree mode with a
TTY y/N gate (default No). **None of the orchestration verbs above was run live** (they need an Orca terminal and
would start a real agent); the JSON receipts are parsed defensively and the path is covered only by the fake Orca.

🔁 `worker-start` has no branch flag, so in Orca mode the local branch name is Orca's; the push refspec is still
`HEAD:refs/heads/council/<run-id>`.

## git and gh (only after an approved gate)

| Command | Status | Note |
|---|---|---|
| `git -c core.hooksPath=/dev/null -c core.fsmonitor=false …` | standard | every git command council-flow runs: no hooks, no fsmonitor program; env without secrets or `GIT_DIR`/`GIT_INDEX_FILE`/`GIT_CONFIG_*` |
| `git worktree add -b council/<run-id> <path> <base>`, `git worktree list --porcelain` | standard | git mode; identity check before every use |
| `git add -A`, `git write-tree`, `git diff --cached --binary <base>`, `git diff <tree> <tree>` | standard | diffs and tree ids without committing |
| `git read-tree -u --reset <tree>`, `git read-tree <tree>` | standard | roll a failed fix back; put the index back after tests |
| `git ls-tree -r -z <tree> -- <paths>`, `git cat-file blob <sha>` | standard | excerpts from regular blobs only (symlinks never followed) |
| `git commit-tree <tree> -p <parent> -m …`, `git update-ref refs/heads/council/<id> <new> <old>` | standard | commits exactly the approved tree; the local branch moves by compare-and-swap |
| `git -c push.followTags=false push --no-follow-tags <remote> <commit>:refs/heads/council/<run-id>` | binary | `follow-tags` / `push.followTags` found in the git binary (`git push -h` was not run during verification); never `--force`, never a `+` refspec |
| `git merge-base --is-ancestor <base> <remote>/<base-branch>` | standard | escalate when the PR would contain unreviewed commits |
| `git config --get remote.<r>.url`, `git ls-remote <r> refs/heads/council/<id>` | standard | PR repository for the approval; the remote branch must still be the approved commit before the PR |
| `gh pr create --repo HOST/OWNER/REPO --head --base --title --body-file [--draft]` | binary + help | `--repo` is the inherited `-R, --repo [HOST/]OWNER/REPO` flag (seen in `gh issue view --help`); repo derived from the push remote's URL, `GH_REPO` stripped; `--head`, `--base`, `--body-file`, `--draft` descriptions found in the gh binary; tested only against a fake gh |
| `gh issue view <n> --json number,title,body,url` | help | `council-flow issue --github` |
| `gh auth status` | standard | doctor, exit code only |

## Audit mode

Audit requires fx 0.0.17 or later for the explicit ask/provider/model flags. It creates a temporary `FX_HOME` containing only the pinned Lyber bearer-env connection and Kimi model. Model metadata sets `supports_tool_use: false`. The profile sets `first_call_tool_choice: "none"` and `max_agent_steps: 1`, also set through `FX_MAX_AGENT_STEPS=1`. The installed binary's offline `fx config schema` lists both settings and accepts `none` for first-call tool choice. An offline `fx status --json` against the temporary profile resolved the expected model, Lyber source and ask permission mode. Live provider behavior is not covered by the offline tests.

Codex consumes the supplied text in an empty directory, with the existing read-only sandbox, `web_search="disabled"`, and shell, unified exec, apps, plugins and code-mode features disabled. Claude uses the existing restricted read/write tool lists and `CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC=1`. Audit starts no Orca, gh or remote Git workflow. Repository tests and Git subprocesses use the offline launcher in `src/audit/isolation.py`.

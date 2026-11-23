---
name: orchestration
description: >-
  Run work in separate Orca worker agents and get their results back. Use when
  the user asks for Orca workers or supervision (monitor, task DAGs, ask/reply,
  decision gates), or when the work needs something your own subagents cannot
  give: a different agent (such as Codex from Claude) or its own Orca workspace.
  "Have Codex (or Claude) review this and report back" means an Orca worker of
  that agent, even when you have your own model subagents.
  Also use when you are a dispatched worker (a prompt with Task and Dispatch
  IDs: ask, worker_done). Otherwise prefer your own subagents,
  including for long or parallel work. Use `orca-cli` to hand work off with
  nothing expected back ("hand off", "handover", "give this to another agent",
  "another worktree"), and for terminal control, shell commands, worktree
  management, and reading or waiting on terminals.
---

# Orca orchestration

If your prompt has a preamble with Task and Dispatch IDs, you are a worker:
follow the preamble. To ask your coordinator, run `ask`, then end your turn;
Orca wakes you with the answer. To hand work off with nothing back, use `orca-cli`.
When you report your effort, take it from the dispatch's `--effort` or your process
argv, not from a numeric `reasoning_effort`: that number is not on a 0–100 scale
(claude-opus-5-5: low=5, medium=10, high=15, xhigh=40).

## Recipe

`ORCA` stands for the executable you used to run `skills get`; type it in its
place and use it for every command.

```text
ORCA orchestration worker-start --spec "<task>" --worktree current --agent <agent>
```

`<agent>` is an Orca agent id: one the user named, else the agent you are
running as when the worker shares your execution host. Otherwise, such as a
different SSH/WSL host or `--on`, ask the user. `worker-start` does not check
that the CLI is installed; a missing one fails as an `agent_readiness` timeout.

- Start every independent worker, then **end your turn**. "Report back" and
  "tell me when it's done" still mean end your turn; Orca wakes you and you
  report then.
- If a receipt has `next`, follow it. When Orca has nothing for you, end your
  turn.
- `--worktree current` uses your workspace. Use a new one only when the user
  asks or sharing would conflict: `--worktree new-child --name <short-name>`
  nests it under yours. For one with no parent, use
  `--worktree new-top-level --repo id:<repoId> --name <short-name>`
  (`ORCA repo list --json` gives the id). If nothing needs to come back to you
  (the user will work in those chats), don't start workers; per workspace run
  `ORCA worktree create --name <name> --no-parent --agent <agent> --prompt "<brief>" --json`
  and end your turn.
- Add `--model` only if the user named one.
- If `worker-start` fails, do not rerun it; read `failedStage` and load
  `references/recovery-and-cleanup.md`.
- To talk to a worker, use
  `ORCA orchestration send --to dispatch:<dispatch_id> --subject "<topic>" --body "<message>"`
  in any state: a working worker gets it when its current turn ends; a finished
  or closed one gets it as a follow-up Task and reports with `worker_done`. The
  receipt says which.
  Except on a paired server: a finished worker there refuses `send`, so start
  new work there with `worker-start --on <server>` (load
  `references/placement-and-remote.md` first).

Never:

- Poll or run watch scripts: a script's plain `check` takes your mail, so it is
  hidden from you and Orca has nothing to wake you with. Orca wakes you.
- Steer through a worker's terminal; use `send`.
- Make checkouts yourself; let `worker-start` create a worker's workspace.

## When Orca wakes you

- In a chat, each message arrives whole as its own message: act on it. A wake
  that names a `check` command (a terminal, or one message too large for a chat
  message) means run that command. Answer a `question` with
  `ORCA orchestration reply --id <message_id> --body "<answer>"` when the answer
  follows from the task or the user's instructions; otherwise ask the user first.
- An `escalation` with `stopReason` means the worker stopped without
  `worker_done`: steer it with `send`, stop and retry it, or tell the user.
  `exited` or `lost` means it is gone: retry it or tell the user.
- A `worker_done` settles its Task; never mark a reported failure completed.
- When every worker has settled, report to the user per Task: outcome,
  evidence, open blockers.
- Lost track? `ORCA orchestration inbox --terminal run:<run_id> --limit 50`
  shows mail `check` already handled.

Finished workers close on their own unless `worker-list` gives one a `next`; follow
it. Kept-open workers, including new-workspace ones, stay open for the user.
`send` reopens a closed worker when you need it again.
Start a worker in your workspace with `--keep-open` when the user will keep using
its chat after it reports: they want to watch it or talk to it. To keep one already
started, run
`ORCA orchestration worker-keep-open --dispatch <dispatch_id>`.

## Task spec

Make each spec self-contained: the target, the change, constraints, what the
worker may edit, and the evidence that proves it is done. Say whether a
non-zero exit means the Task failed or capturing it is the deliverable. Send
fixes to a worker unless the user gave them to you.

Fetch this guide once. Summarize the worker's evidence; rerun checks only for a
gap or contradiction.

## Safety

Silence, a timeout, or `unverifiable` liveness alone never proves exit or authorizes
autonomous recovery. For explicit user cancellation or assignment abandonment,
load `references/recovery-and-cleanup.md`: requesting a guarded stop or fencing an
assignment does not prove its agent stopped.

## References

`ORCA skills get orchestration --reference references/<file>.md`

| Situation                                      | Reference                            |
| ---------------------------------------------- | ------------------------------------ |
| Task DAGs, several Runs                        | `references/coordinator-loop.md`     |
| Child worktrees, SSH, WSL, a connected server  | `references/placement-and-remote.md` |
| Group messages                                 | `references/messaging-and-gates.md`  |
| A failed or unknown worker; retry, stop, reset | `references/recovery-and-cleanup.md` |
| Custom argv or terminal layout                 | `references/low-level-topology.md`   |

---

# Bundled references

These references belong to the version-matched guide above. Read only the documents named by its action gates.

<!-- bundled-reference: references/coordinator-loop.md -->

# Coordinator loop

## Task DAGs

A Task needs a Run, so create one first. Workers editing the same files at once
need separate workspaces.

```text
ORCA orchestration run-create --objective "<goal>"
ORCA orchestration task-create --spec "<dependent work>" --deps <json_array>
ORCA orchestration task-list --ready --brief
ORCA orchestration worker-start --task <task_id> --worktree current --agent <agent>
```

On every wake, start the Tasks `task-list --ready` shows.

## Several Runs

A later `run-create` keeps your earlier Runs: their mail still wakes you, but
commands without `--run` use the newest Run, so pass `--run <id>` for an earlier
one. `run-use` keeps only the Run it names.

<!-- bundled-reference: references/low-level-topology.md -->

# Low-level topology

```text
ORCA terminal create --worktree active --title <task_name> --command "<agent_command>" --json
ORCA terminal wait --terminal <handle> --for tui-idle --timeout-ms 60000 --json
ORCA orchestration dispatch --task <task_id> --to <handle> --inject
```

To give a Task to a terminal or chat Orca did not start:

```text
ORCA orchestration worker-start --task <task_id> --terminal <handle> --worktree <its_workspace> --json
```

<!-- bundled-reference: references/messaging-and-gates.md -->

# Messaging and gates

Handle a whole `check` batch before the next `check`.

Groups (`@all`, `@idle`, `@codex`, ...) reach the live workers of your Run;
`@worktree:<id>` also reaches coordinators in that workspace. Use groups only
for deliberate fan-out.

To reach an agent on a paired server, use `send --on <server>`; a reply to mail
from another server needs no flag. See
[Placement and remote execution](placement-and-remote.md).

<!-- bundled-reference: references/placement-and-remote.md -->

# Placement and remote execution

Folder workspaces are valid. `new-child` and `new-top-level` make Git worktrees,
never in a folder project; never `git init` a user's folder. From a multi-repo
folder workspace, `new-child` nests under the folder and needs `--repo` naming
the Git repo to create the worktree in.

Local `current`, `new-child` and `new-top-level` stay in the caller's project;
`new-child` also uses the caller's workspace as its parent. Omit `--repo` for
same-project work. Pass it only to deliberately target another project, or for
the connected-server creation described below. The project visible in the app
is not the caller's project. For direct `worktree create`, likewise omit
`--repo`/`--project` for same-project work and use `--parent-worktree active`
when requesting a child of the current workspace.

```text
# Child of the current worktree.
ORCA orchestration worker-start --task <task_id> --worktree new-child --agent <agent> --setup run

# On a connected server, nested under your workspace; the Run stays on yours.
ORCA orchestration worker-start --task <task_id> --on <server> --worktree new-child --repo <exact_remote_repo_selector> --name <name> --agent <agent> --setup run

# On a connected server, with no parent.
ORCA orchestration worker-start --task <task_id> --on <server> --worktree new-top-level --repo <exact_remote_repo_selector> --name <name> --agent <agent> --setup run
```

With `--on`, both `new-child` and `new-top-level` need `--repo` naming a
project on that server. `new-child` nests the server's worktree under your
workspace on this machine. A server whose Orca is too old to nest across
machines still starts the worker, top-level, and the receipt's `warning` says
so; the worker is fine to use. `current` is not valid with `--on`.

`--name` is optional: without it Orca picks a name as it does for an unnamed
workspace, and the start output names the workspace it created.

After start, address a remote worker only by Dispatch ID, never by a terminal
handle.

## Agents on another server

To message an agent that already runs on a paired server, send with `--on`,
using the same server names as `worker-start --on`:

```bash
ORCA orchestration send --on <server> --to <term_…|orca_session_id:…> --subject "<text>" --body "<text>"
```

Your own Orca carries the mail and keeps the conversation. Replies come back to
your own `check`, and they wake you like local mail. The other agent answers
with a plain `reply --id <msg_id> --body <text>`; no flag is needed on either
side. Mail from another server names its sender as `<sender> on <server name>`.

`--environment <server>` runs one command on that server and delivers nothing back
to you, so an agent never mails with it. Your mailbox stays on your own Orca:
`check` takes no `--environment`. Read-only commands such as `inbox` or
`worker-list` with `--environment` show that server's records. A server whose Orca
is too old answers `server_mail_unsupported` and nothing is sent. Pair servers
with `orca pair` or in Settings.

<!-- bundled-reference: references/recovery-and-cleanup.md -->

# Recovery and cleanup

Act only on proof. `worker-list --run <run_id> --include-remote` gives
each worker's liveness and `next`; follow it.

Retry a failed or stopped attempt on the same Task; `--spec` would create a new
one. Placement is not inherited:

```text
ORCA orchestration worker-start --task <task_id> --retry-of <dispatch_id> --worktree <placement> --agent <agent>
```

`worker-stop` exits 1 with `stop_unknown` when it cannot prove the agent
stopped; check `worker-show` before acting again.

`orchestration reset` deletes coordination state; run it only when the user
gives that state up.

## User-directed recovery after the breaker

After three failed starts in one `--retry-of` chain, the Dispatch circuit-breaks
and the Task fails. A worker's own failed report does not advance that count.
Report the failure and stop automatic retries; never route around the breaker
with a new Run or Task, or reset its count, including on restart.

Only when the user explicitly asks to retry or reassign this Task may its Run's
current coordinator reopen the **same Task**. Use `worker-list` above to find
every retained attempt, then inspect each:

```text
ORCA orchestration worker-show --dispatch <dispatch_id>
ORCA orchestration worker-read --dispatch <dispatch_id>
```

Silence, a startup timeout, or `unverifiable` liveness alone never proves exit or
authorizes autonomous stop, abandon, retry, or release.

For explicit user cancellation of an unsettled attempt, including an unknown
start, request `ORCA orchestration worker-stop --dispatch <dispatch_id>`.
Prior exit is not required: guarded stop can attempt cancellation of an exact
owned live agent or one with exact identity but unverifiable liveness. Respect
identity, custody, and Keep open refusals; never close or reuse an unknown or
user-owned process. Claim cancellation only on a confirmed stopped result. On
`stop_unknown`, inspect `worker-show` and the receipt, then report the unresolved
blocker; do not blindly repeat stop, retry, or start fresh.

For explicit intentional abandonment, use
`ORCA orchestration worker-abandon --dispatch <dispatch_id>` to fence and
settle the assignment while retaining possibly-live resources. This does not
cancel physical work or prove exit; never silently substitute it for cancellation.
A same-runtime in-flight stop must finish first. Reopen only after the Dispatch
is settled; never reuse an unproven or still-busy predecessor.

An already-failed start can still own a live terminal; stop/abandon does not close
it. For reclaimable failed-start terminals you are replacing, use
`ORCA orchestration worker-release --dispatch <dispatch_id>`; follow the
receipt's exact recovery action for `release_pending` or `release_unknown`, never
`terminal close`. Preserve the selected proven reusable agent with
`worker-keep-open` by its Dispatch ID; preserve user-taken-over and unproven
terminals. A fresh start without `--retry-of` does not clean up its
predecessor's terminal.

Reopen and start the same Task in its owning Run:

```text
ORCA orchestration task-update --id <task_id> --status ready --run <owning_run_id>
ORCA orchestration worker-start --task <task_id> --run <owning_run_id> --worktree <placement> --agent <agent>
```

This fresh series starts at zero. The broken Dispatch and its failure count stay
in history; `--retry-of` that Dispatch is still refused after reopening.

To reuse a proven existing agent whose previous work is settled, replace the
start command with:

```text
ORCA orchestration worker-start --task <task_id> --run <owning_run_id> --worktree <exact_existing_workspace> --terminal <agent_terminal_handle>
```

Use that terminal's workspace; omit `--agent`, `--model`, `--effort`, and
new-worktree creation. Follow [Placement and remote execution](placement-and-remote.md)
for execution-host selection and Dispatch-addressed follow-ups. After starting
independent work, end your turn; Orca wakes you. Follow a receipt's `next` action.

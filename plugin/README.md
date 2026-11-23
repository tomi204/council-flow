# Council Flow Orca plugin: sources

The plugin's manifest is `../orca-plugin.json` at the repository root, so that
`orca plugin install tomi204/council-flow` finds it (Orca's Git installs read the manifest from the
repository root). Install and usage are in the main README, section "Orca plugin".

The panel is one prompt with a Run button, an Audit | Code toggle picked from the prompt, a dry-run
switch, a Repo dropdown and collapsed Options; below it, the live Workflows list; Setup and doctor
behind the gear.

| File | What it is |
|---|---|
| `src/worker.ts` | The worker (`main`): panel requests, palette commands, `terminal.create`, `terminal.focus`, the Workflows list and the status bar item |
| `src/panel.tsx` | The right-sidebar panel (components UI) |
| `src/mode.ts` | Picks audit or code from the prompt, and the manual-override rule; pure |
| `src/progress.ts` | A run's phase, stage, step trail and findings from `run.json`, its lock and file times; pure |
| `src/command.ts` | Builds the single council-flow command line; pure, shared by panel, worker and `test/plugin.test.mjs` |
| `src/runs.ts` | Read-only listing of `<repo>/.council-flow/<run-id>/` and the artifact allowlist |
| `src/watch.ts` | `fs.watch` on `.council-flow/` and live run folders (non-recursive), debounced |
| `src/cli.ts` | Finds the council-flow checkout to run |
| `src/redact.ts` | Shape-based scrub of artifact text before display |
| `src/protocol.ts` | Panel/worker request and event types |
| `src/node.d.ts` | The few Node built-in typings the worker uses (the plugin ships no `node_modules`) |
| `src/*.test.ts(x)` | `orca plugin test plugin` |
| `src/panel.check.ts` | Scenarios for `orca plugin check .` and `orca plugin shot . --scenario <name>`: `empty`, `running`, `waiting-approve`, `done`, `public-target-refused`, `no-focus-grant`, `cli-missing`, `no-git-workspace` |

No build step: Orca transpiles the `.ts`/`.tsx` files when it loads them.

```sh
# from the repository root
orca plugin types .                 # writes .orca/types (ignored by Git)
orca plugin validate . --json
orca plugin check . --json
orca plugin test plugin --json
(cd plugin && npx -p typescript@5 tsc -p .)
orca plugin shot . --scenario waiting-approve --out waiting.png --json   # needs the desktop app
```

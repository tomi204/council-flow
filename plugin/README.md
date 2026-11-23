# Council Flow Orca plugin: sources

The plugin's manifest is `../orca-plugin.json` at the repository root, so that
`orca plugin install tomi204/council-flow` finds it (Orca's Git installs read the manifest from the
repository root). Install and usage are in the main README, section "Orca plugin".

| File | What it is |
|---|---|
| `src/worker.ts` | The worker (`main`): panel requests, palette commands, `terminal.create` |
| `src/panel.tsx` | The right-sidebar panel (components UI) |
| `src/command.ts` | Builds the single council-flow command line; pure, shared by panel, worker and `test/plugin.test.mjs` |
| `src/runs.ts` | Read-only listing of `<repo>/.council-flow/<run-id>/` and the artifact allowlist |
| `src/cli.ts` | Finds the council-flow checkout to run |
| `src/redact.ts` | Shape-based scrub of artifact text before display |
| `src/protocol.ts` | Panel/worker request and event types |
| `src/node.d.ts` | The few Node built-in typings the worker uses (the plugin ships no `node_modules`) |
| `src/*.test.ts(x)` | `orca plugin test plugin` |
| `src/panel.check.ts` | Scenarios for `orca plugin check .` |

No build step: Orca transpiles the `.ts`/`.tsx` files when it loads them.

```sh
# from the repository root
orca plugin types .                 # writes .orca/types (ignored by Git)
orca plugin validate . --json
orca plugin check . --json
orca plugin test plugin --json
(cd plugin && npx -p typescript@5 tsc -p .)
```

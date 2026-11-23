# Third-party notices

council-flow is MIT-licensed (see `LICENSE`). This file lists third-party material that is included in the
repository or that influenced it.

## orca-council

council-flow is its own code base. Several patterns were learned from reading
[orca-council](https://github.com/VukanCekic/orca-council) by Vukan Cekic at commit `74b7232`:

- one spawn spec per engine with the read-only flags built in (`src/engines.mjs`);
- the answer of `claude -p --output-format stream-json` is the last `{"type":"result"}` record;
- the answer of `codex exec` is the `-o` last-message file, with the last `agent_message` event as fallback;
- a text-only blind judge (`--tools ""` plus a short system prompt) in an empty working directory;
- removing a Claude Code host session's environment markers before starting a nested `claude -p`;
- members' outputs redacted of model names and shuffled with `crypto.randomInt` before the judge sees them;
- fake engines that print the real CLIs' output shapes for dry runs.

No source file was copied. orca-council's MIT notice is reproduced here as attribution for those patterns:

```
MIT License

Copyright (c) 2026 Vukan Cekic

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Orca

The following files in `docs/help/` are captures of help output and documentation from
[Orca](https://github.com/stablyai/orca) (app 1.4.259), redistributed under the MIT License:

- `docs/help/orca.txt`
- `docs/help/orca-orchestration.txt`
- `docs/help/orca-orchestration-commands.txt`
- `docs/help/orca-agent-context.json`
- `docs/help/orca-skill-orchestration.md`

```
MIT License

Copyright (c) 2026 Lovecast Inc.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.
```

## Codex CLI and fx

These help captures in `docs/help/` come from projects licensed under the
[Apache License, Version 2.0](https://www.apache.org/licenses/LICENSE-2.0):

- `docs/help/codex.txt`, `docs/help/codex-exec.txt`: `codex --help` and `codex exec --help` output of
  [Codex CLI](https://github.com/openai/codex) 0.169.0 by OpenAI.
- `docs/help/fx.txt`, `docs/help/fx-ask-usage-from-binary.txt`: `fx --help` output and the `fx ask` usage string
  embedded in the binary of [fx](https://github.com/vercel-labs/fx) 0.0.17 by Vercel Labs.

They are unmodified captures, included only to document which flags council-flow relies on.

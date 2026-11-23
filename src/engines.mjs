// engines.mjs: the three council members behind one interface.
//
//   engine = { id, available() -> {ok, reason, version, sandbox?}, run({role, prompt, cwd, timeoutMs}) -> result }
//   result = { ok, text, json?, usage?, durationMs, exitCode, timedOut, limitHit, sandboxBroken, error, stdout, stderr, argv }
//
// The role decides the flags. Read-only roles (plan, judge, review, nudge) can only ever get read-only flags;
// write roles (implement, fix) exist for claude and codex only. Every flag below was checked against the CLI's
// own --help on the VM; see docs/flags.md. Prompts always travel on stdin, never in argv, and are scrubbed of
// secrets before they leave this process. Each child gets only its own credentials (src/env.mjs).
//
// Patterns (spawn spec per engine, stream-json result record, codex -o file, blind text-only judge, removing a
// Claude host session's env) follow orca-council (MIT, VukanCekic, commit 74b7232); the code is new.
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import { runProcess, run, which } from './proc.mjs'
import { envFor } from './env.mjs'
import { scrubSecrets } from './redact.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FAKE_ENGINE = path.join(HERE, '..', 'test', 'fixtures', 'fake-engine.mjs')

export const READ_ONLY_ROLES = new Set(['plan', 'judge', 'review', 'nudge', 'audit-context', 'audit-red', 'audit-blue-read', 'audit-review'])
export const WRITE_ROLES = new Set(['implement', 'fix', 'audit-patch'])

const CLAUDE_READ_TOOLS = 'Read,Grep,Glob'
const CLAUDE_WRITE_TOOLS = 'Read,Grep,Glob,Edit,Write'      // no Bash: the implementer cannot run commands
const TEXT_ONLY_SYSTEM = {
  judge: 'You are a text-only judge. No tools exist in this session: do not emit tool calls or tool markup. Use only the text you are given and answer with exactly the JSON object requested.',
  nudge: 'You reformat a previous answer into the JSON shape you are given. No tools exist in this session. Output only JSON.'
}
const FX_SYSTEM = 'You are a careful senior software engineer answering one request. Everything you need is in the prompt. You must not create, modify or delete files or run commands.'
const LIMIT = /(usage limit|rate[ -]?limit(ed)?|quota (exceeded|exhausted|reached)|too many requests|\b429\b|insufficient (credits|balance|funds)|out of credits|hit your (usage )?limit)/i
// Codex's bubblewrap sandbox failing to start (e.g. Ubuntu 24.04 with kernel.apparmor_restrict_unprivileged_userns=1).
export const SANDBOX_BROKEN = /bwrap: [^\n]*(Operation not permitted|Failed RTM_NEWADDR|setting up uid map|No permissions to create (a )?new namespace|Creating new namespace failed)/i
const SANDBOX_MARKER = 'council-flow-sandbox-ok'
const CODEX_SANDBOXES = new Set(['read-only', 'workspace-write'])      // never danger-full-access

export function versionGte(v, min) {
  const a = String(v || '').match(/(\d+)\.(\d+)\.(\d+)/), b = min.split('.').map(Number)
  if (!a) return false
  for (let i = 0; i < 3; i++) { const x = Number(a[i + 1]); if (x !== b[i]) return x > b[i] }
  return true
}

function jsonLines(text) {
  const out = []
  for (const l of String(text || '').split(/\r?\n/)) {
    const t = l.trim()
    if (!t.startsWith('{')) continue
    try { out.push(JSON.parse(t)) } catch { /* partial line */ }
  }
  return out
}
const lastWhere = (arr, f) => { for (let i = arr.length - 1; i >= 0; i--) if (f(arr[i])) return arr[i]; return null }
const tail = (s, n = 4000) => String(s || '').slice(-n)
const childEnvOpts = (cfg) => ({ fxKeyEnv: cfg.fxKeyEnv, dryRun: cfg.dryRun })

// ---------------------------------------------------------------- claude
function claudeSpec(cfg, role, o) {
  const args = ['-p', '--model', cfg.models.claude]
  if (cfg.efforts.claude) args.push('--effort', cfg.efforts.claude)
  if (role === 'judge' || role === 'nudge') args.push('--tools', '', '--system-prompt', TEXT_ONLY_SYSTEM[role], '--permission-mode', 'dontAsk')
  else if (WRITE_ROLES.has(role)) args.push('--tools', CLAUDE_WRITE_TOOLS, '--allowedTools', CLAUDE_WRITE_TOOLS, '--permission-mode', 'acceptEdits')
  else args.push('--tools', CLAUDE_READ_TOOLS, '--allowedTools', CLAUDE_READ_TOOLS, '--permission-mode', 'dontAsk')
  // --permission-prompts none: anything that would prompt is denied. --restricted: no code-running tools, no
  // user/project settings (no allow rules or hooks can widen this), file tools confined to the working dir.
  args.push('--permission-prompts', 'none', '--restricted', '--strict-mcp-config', '--no-session-persistence', '--output-format', 'stream-json', '--verbose')
  return { exe: cfg.bins.claude, args, env: envFor('claude', o.env, { ...childEnvOpts(cfg), set: cfg.audit ? { CLAUDE_CODE_DISABLE_NONESSENTIAL_TRAFFIC: '1' } : {} }) }
}
function parseClaude(stdout) {
  const rec = lastWhere(jsonLines(stdout), o => o.type === 'result')
  if (!rec) return { ok: false, error: 'claude printed no result record' }
  const u = rec.usage
  const usage = u ? { inputTokens: (u.input_tokens || 0) + (u.cache_read_input_tokens || 0) + (u.cache_creation_input_tokens || 0), outputTokens: u.output_tokens || 0 } : null
  const text = String(rec.result ?? '')
  if (rec.is_error || (rec.subtype && rec.subtype !== 'success')) return { ok: false, text, usage, error: `claude result: ${rec.subtype || 'error'}` }
  return { ok: true, text, usage, json: { costUsd: rec.total_cost_usd ?? null, numTurns: rec.num_turns ?? null } }
}

// ---------------------------------------------------------------- codex
function codexSpec(cfg, role, o) {
  const sandbox = READ_ONLY_ROLES.has(role) ? 'read-only' : 'workspace-write'
  if (!CODEX_SANDBOXES.has(sandbox)) throw new Error(`refusing codex sandbox ${sandbox}`)
  const lastFile = path.join(o.scratch, `codex-${role}-${crypto.randomBytes(4).toString('hex')}.last.txt`)
  // -s read-only: model shell commands cannot write. --ignore-user-config: no MCP servers or overrides from
  // config.toml (MCP servers run outside the sandbox). --ignore-rules: no user/project execpolicy rules that could
  // allow commands. -c mcp_servers={}: no MCP servers from any remaining config layer. --ephemeral: no session files.
  const args = ['exec', '--skip-git-repo-check', '--color', 'never', '--ephemeral', '--ignore-user-config', '--ignore-rules',
    '-c', 'mcp_servers={}', '--json', '-o', lastFile, '-C', o.cwd, '-s', sandbox]
  // workspace-write would also make /tmp and $TMPDIR writable: keep the implementer inside its worktree.
  if (sandbox === 'workspace-write') args.push('-c', 'sandbox_workspace_write.exclude_slash_tmp=true', '-c', 'sandbox_workspace_write.exclude_tmpdir_env_var=true')
  if (cfg.audit) {
    if (sandbox === 'workspace-write') args.push('-c', 'sandbox_workspace_write.network_access=false')
    args.push('-c', 'web_search="disabled"')
    for (const feature of ['shell_tool', 'unified_exec', 'apps', 'plugins', 'code_mode', 'code_mode_host']) args.push('--disable', feature)
  }
  if (cfg.models.codex) args.push('-m', cfg.models.codex)
  if (cfg.efforts.codex) args.push('-c', `model_reasoning_effort=${cfg.efforts.codex}`)
  args.push('-')                                                     // prompt from stdin
  return { exe: cfg.bins.codex, args, lastFile, env: envFor('codex', o.env, childEnvOpts(cfg)) }
}
function parseCodex(stdout, spec) {
  let text = ''
  try { text = fs.readFileSync(spec.lastFile, 'utf8') } catch { /* no -o file */ }
  const lines = jsonLines(stdout)
  if (!text.trim()) { const m = lastWhere(lines, x => x.type === 'item.completed' && x.item && x.item.type === 'agent_message'); if (m) text = String(m.item.text || '') }
  const tc = lastWhere(lines, x => x.type === 'turn.completed')
  const usage = tc && tc.usage ? { inputTokens: tc.usage.input_tokens || 0, outputTokens: tc.usage.output_tokens || 0 } : null
  if (!text.trim()) {
    const f = lastWhere(lines, x => x.type === 'turn.failed' || x.type === 'error')
    return { ok: false, usage, error: f ? `codex: ${(f.error && f.error.message) || f.message || f.type}` : 'codex returned an empty answer' }
  }
  return { ok: true, text, usage }
}

// ---------------------------------------------------------------- fx (Lyber)
// fx >= 0.0.17 takes --permission-mode/--provider/--model on `ask`; 0.0.16 rejected them, so the env vars
// (FX_PERMISSION_MODE, FX_PROVIDER, FX_MODEL) are always set too and are the only selector on older builds.
function fxSpec(cfg, role, o) {
  if (!READ_ONLY_ROLES.has(role)) throw new Error(`fx is read-only in council-flow and cannot take the ${role} role`)
  const auditRed = cfg.audit || role === 'audit-red'
  if (auditRed && !versionGte(o.fxVersion, '0.0.17')) throw new Error('audit Red requires fx >= 0.0.17')
  const args = ['ask', '--json', '--no-save', '--no-color', '--system', auditRed ? 'Report only defensive findings in JSON from supplied text. No tools, commands, payloads, PoCs or secrets.' : FX_SYSTEM]
  if (versionGte(o.fxVersion, '0.0.17')) args.push('--permission-mode', 'ask', '--provider', cfg.fxProvider, '--model', cfg.models.fx)
  const env = envFor('fx', o.env, { ...childEnvOpts(cfg), set: { FX_PROVIDER: cfg.fxProvider, FX_MODEL: cfg.models.fx, FX_PERMISSION_MODE: 'ask' } })
  return { exe: cfg.bins.fx, args, env }
}
// `final_output` is the completed final response; `output` is accumulated Markdown that can include intermediate
// commentary. When final_output exists it is the only answer; `output` is used only by builds without the field.
function parseFx(stdout) {
  let obj = null
  try { obj = JSON.parse(String(stdout).trim()) } catch { obj = lastWhere(jsonLines(stdout), x => 'final_output' in x || 'output' in x) }
  if (!obj || typeof obj !== 'object') return { ok: false, error: 'fx printed no JSON result' }
  const text = String(('final_output' in obj ? obj.final_output : obj.output) ?? '')
  const u = obj.usage
  const usage = u ? { inputTokens: u.input_tokens || 0, outputTokens: u.output_tokens || 0 } : null
  if (obj.error) return { ok: false, text, usage, error: `fx: ${typeof obj.error === 'string' ? obj.error : (obj.error.message || JSON.stringify(obj.error))}` }
  if (obj.exit_code != null && obj.exit_code !== 0) return { ok: false, text, usage, error: `fx exit_code ${obj.exit_code}` }
  if (!text.trim()) return { ok: false, usage, error: 'final_output' in obj ? 'fx returned no completed final response' : 'fx returned an empty answer' }
  return { ok: true, text, usage }
}

// ---------------------------------------------------------------- availability (no tokens spent)
// Codex's sandbox, checked by running /bin/echo inside it (`codex sandbox`, no model call).
export async function probeCodexSandbox(bin, env) {
  const r = await run(bin, ['sandbox', '--', '/bin/echo', SANDBOX_MARKER], { timeoutMs: 30000, env })
  if (r.ok && r.stdout.includes(SANDBOX_MARKER)) return { ok: true }
  const msg = (String(r.stderr || r.stdout).match(SANDBOX_BROKEN) || [String(r.stderr || r.error || '').trim().split('\n').pop()])[0]
  return { ok: false, reason: `codex sandbox cannot start: ${String(msg).slice(0, 200)}` }
}

async function probe(id, cfg, base, cwd) {
  const env = envFor(id, base, childEnvOpts(cfg))
  const bin = which(cfg.bins[id], env)
  if (!bin) return { ok: false, reason: `${cfg.bins[id]} not found on PATH` }
  const v = await run(bin, ['--version'], { cwd, timeoutMs: 20000, env })
  const version = ((v.stdout || v.stderr).match(/\d+\.\d+\.\d+/) || [''])[0] || null
  if (id === 'claude') {
    const r = await run(bin, ['auth', 'status', '--json'], { cwd, timeoutMs: 20000, env })
    let j = null; try { j = JSON.parse(r.stdout) } catch { /* not JSON */ }
    if (!j || !j.loggedIn) return { ok: false, version, reason: 'claude is not logged in (claude auth login)' }
    return { ok: true, version, detail: `logged in (${j.authMethod || 'unknown method'})` }
  }
  if (id === 'codex') {
    const r = await run(bin, ['login', 'status'], { cwd, timeoutMs: 20000, env })
    if (!r.ok) return { ok: false, version, reason: 'codex is not logged in (codex login)' }
    const sb = await probeCodexSandbox(bin, env)
    return { ok: true, version, sandbox: sb.ok, sandboxReason: sb.reason || null,
      detail: `logged in; model ${cfg.models.codex || '(codex built-in default)'}${sb.ok ? '' : '; sandbox broken: prompt-only reviewer, cannot implement'}` }
  }
  // fx: the provider must be configured and its key present in env (value never read or printed).
  const keyPresent = Boolean(base[cfg.fxKeyEnv])
  const r = await run(bin, ['status', '--json'], { cwd, timeoutMs: 20000, env: envFor('fx', base, { ...childEnvOpts(cfg), set: { FX_PROVIDER: cfg.fxProvider, FX_MODEL: cfg.models.fx } }) })
  let j = null; try { j = JSON.parse(r.stdout) } catch { /* not JSON */ }
  const providers = (j && j.connected_providers) || []
  const configured = Boolean(j && (providers.includes(cfg.fxProvider) || j.model_source === cfg.fxProvider))
  if (cfg.audit && !versionGte(version, '0.0.17')) return { ok: false, version, reason: 'audit Red requires fx >= 0.0.17' }
  if (!configured) return { ok: false, version, reason: `fx provider "${cfg.fxProvider}" is not configured (see README: Lyber connection)` }
  if (!keyPresent) return { ok: false, version, reason: `${cfg.fxKeyEnv} is not set in the environment` }
  return { ok: true, version, detail: `provider ${cfg.fxProvider}, model ${cfg.models.fx}, ${cfg.fxKeyEnv} present` }
}

// ---------------------------------------------------------------- the interface
// The exact spawn spec for a member and role (exported for the flag tests).
export function buildSpec(id, cfg, role, o) {
  const build = { claude: claudeSpec, codex: codexSpec, fx: fxSpec }[id]
  if (!build) throw new Error(`unknown member ${id}`)
  return build(cfg, role, { env: process.env, ...o })
}

export function createEngine(id, cfg, { scratch, env = process.env }) {
  if (cfg.audit && id === 'fx') {
    // A private profile prevents saved MCP servers, additional directories and permission grants.
    // The Lyber connection explicitly advertises a text-only model and a single tool-free turn.
    const fxHome = fs.mkdtempSync(path.join(scratch, 'fx-profile-'))
    const profile = { provider: 'lyber', models: { lyber: cfg.models.fx }, first_call_tool_choice: 'none', max_agent_steps: 1,
      providers: { lyber: { protocol: 'openai-chat-completions', base_url: 'https://api.lyber.ai/v1',
        auth: { type: 'bearer', env: 'LYBER_API_KEY' }, model_metadata: { [cfg.models.fx]: { supports_tool_use: false } } } } }
    fs.writeFileSync(path.join(fxHome, 'settings.json'), JSON.stringify(profile), { mode: 0o600 })
    env = { ...Object.fromEntries(Object.entries(env).filter(([key]) => !key.startsWith('FX_'))), FX_HOME: fxHome, FX_MAX_AGENT_STEPS: '1' }
  }
  const build = { claude: claudeSpec, codex: codexSpec, fx: fxSpec }[id]
  const parse = { claude: parseClaude, codex: parseCodex, fx: parseFx }[id]
  if (!build) throw new Error(`unknown member ${id}`)
  let cached = null
  const fakeList = (name) => String(env[name] || '').split(',').map(s => s.trim()).filter(Boolean)

  return {
    id,
    async available() {
      if (cached) return cached
      if (cfg.dryRun) {
        const sandboxBroken = id === 'codex' && env.COUNCIL_FAKE_CODEX_SANDBOX === 'broken'
        cached = fakeList('COUNCIL_FAKE_MISSING').includes(id)
          ? { ok: false, reason: `${id} not installed (fake: COUNCIL_FAKE_MISSING)` }
          : { ok: true, version: id === 'fx' ? (env.COUNCIL_FAKE_FX_VERSION || '0.0.17') : 'fake', detail: 'dry-run fake',
            ...(id === 'codex' ? { sandbox: !sandboxBroken, sandboxReason: sandboxBroken ? 'codex sandbox cannot start: bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted (fake)' : null } : {}) }
      } else {
        try { cached = await probe(id, cfg, env, cfg.audit ? scratch : undefined) } catch (e) { cached = { ok: false, reason: `probe failed: ${e.message}` } }
      }
      return cached
    },
    async run({ role, prompt, cwd, timeoutMs }) {
      const avail = await this.available()
      const spec = build(cfg, role, { cwd, scratch, env, fxVersion: avail.version })
      let { exe, args, env: childVars } = spec
      if (cfg.dryRun) {
        // The fake gets the exact real argv after `--` and refuses to run if a read-only role lacks its flags.
        exe = process.execPath
        args = [FAKE_ENGINE, id, '--', ...spec.args]
        childVars = { ...childVars, COUNCIL_FAKE_ROLE: role }
      }
      // Known secret values and credential shapes never leave this process, whatever the prompt was built from.
      const stdin = scrubSecrets(prompt, { env, mode: 'code' })
      const r = await runProcess({ exe, args, cwd, env: childVars, stdin, timeoutMs })
      const p = r.timedOut ? { ok: false } : parse(r.stdout, spec)
      if (spec.lastFile) fs.rmSync(spec.lastFile, { force: true })
      const sandboxBroken = id === 'codex' && SANDBOX_BROKEN.test(tail(r.stdout, 200000) + '\n' + tail(r.stderr, 50000))
      // A codex write role whose sandbox failed did not do its job, even when it exited 0.
      const ok = r.ok && p.ok && !(sandboxBroken && WRITE_ROLES.has(role))
      let error = null
      if (!ok) {
        const lastErr = String(r.stderr || '').trim().split('\n').pop().slice(0, 300)
        if (sandboxBroken && WRITE_ROLES.has(role)) error = 'codex sandbox cannot start (bwrap); see README "Codex sandbox"'
        else if (r.timedOut) error = r.error
        else if (p.error) error = r.ok ? p.error : `${p.error} (${r.error})`
        else error = lastErr ? `${r.error}: ${lastErr}` : r.error
      }
      return {
        ok, text: p.text || '', json: p.json, usage: p.usage || null, durationMs: r.durationMs, exitCode: r.exitCode,
        timedOut: r.timedOut, limitHit: !ok && LIMIT.test(tail(r.stderr) + '\n' + tail(r.stdout)), sandboxBroken, error,
        stdout: r.stdout, stderr: r.stderr, stdoutTruncated: r.stdoutTruncated, stdoutBytes: r.stdoutBytes, argv: [spec.exe, ...spec.args]
      }
    }
  }
}

export function createEngines(cfg, opts) {
  return Object.fromEntries(['claude', 'codex', 'fx'].map(id => [id, createEngine(id, cfg, opts)]))
}

// Exported for the parser tests.
export const PARSERS = { claude: parseClaude, codex: parseCodex, fx: parseFx }

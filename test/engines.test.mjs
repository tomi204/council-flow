// The exact command lines per member and role, the output parsers, and availability in dry-run.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { buildSpec, PARSERS, createEngine, versionGte, probeCodexSandbox, FAKE_ENGINE } from '../src/engines.mjs'
import { envFor } from '../src/env.mjs'
import { tmp } from './helpers.mjs'
import { loadConfig, codexConfiguredModel } from '../src/config.mjs'

const cfg = loadConfig({}, { HOME: '/nonexistent', COUNCIL_CODEX_MODEL: 'gpt-test' })
const scratch = tmp('council-eng-')
const spec = (id, role, extra = {}) => buildSpec(id, cfg, role, { cwd: '/repo', scratch, env: { PATH: '/bin', LYBER_API_KEY: 'k'.repeat(20), CLAUDECODE: '1', CLAUDE_CODE_MESSAGING_TOKEN: 't'.repeat(20) }, fxVersion: '0.0.17', ...extra })
const after = (args, f) => args[args.indexOf(f) + 1]

test('claude read-only roles: Read/Grep/Glob only, dontAsk, restricted, no MCP, no session, stream-json', () => {
  for (const role of ['plan', 'review']) {
    const { args, env } = spec('claude', role)
    assert.equal(args[0], '-p')
    assert.equal(after(args, '--tools'), 'Read,Grep,Glob')
    assert.equal(after(args, '--allowedTools'), 'Read,Grep,Glob')
    assert.equal(after(args, '--permission-mode'), 'dontAsk')
    assert.equal(after(args, '--permission-prompts'), 'none')
    assert.equal(after(args, '--output-format'), 'stream-json')
    for (const f of ['--restricted', '--strict-mcp-config', '--no-session-persistence', '--verbose']) assert.ok(args.includes(f), f)
    assert.ok(!args.some(a => /dangerously|bypass|Bash|Edit|Write/.test(a)))
    assert.equal(env.LYBER_API_KEY, undefined, 'no Lyber key for claude')
    assert.equal(env.CLAUDECODE, undefined, 'host session markers removed')
    assert.equal(env.CLAUDE_CODE_MESSAGING_TOKEN, undefined)
  }
  const judge = spec('claude', 'judge').args
  assert.equal(after(judge, '--tools'), '')
  assert.ok(judge.includes('--system-prompt'))
})

test('claude write roles: edit tools without Bash, acceptEdits, still restricted', () => {
  const { args } = spec('claude', 'implement')
  assert.equal(after(args, '--tools'), 'Read,Grep,Glob,Edit,Write')
  assert.equal(after(args, '--permission-mode'), 'acceptEdits')
  assert.ok(args.includes('--restricted') && !args.some(a => /Bash|dangerously/.test(a)))
})

test('codex: read-only sandbox for read roles, workspace-write for write roles, prompt on stdin', () => {
  const ro = spec('codex', 'review').args
  assert.equal(ro[0], 'exec')
  assert.equal(after(ro, '-s'), 'read-only')
  for (const f of ['--ignore-user-config', '--ephemeral', '--json', '--skip-git-repo-check']) assert.ok(ro.includes(f), f)
  assert.equal(after(ro, '-C'), '/repo')
  assert.equal(after(ro, '-m'), 'gpt-test')
  assert.equal(ro[ro.length - 1], '-')
  assert.equal(spec('codex', 'review').env.LYBER_API_KEY, undefined)
  assert.equal(after(spec('codex', 'implement').args, '-s'), 'workspace-write')
  for (const role of ['plan', 'judge', 'review', 'nudge', 'implement', 'fix']) {
    const a = spec('codex', role).args
    assert.ok(a.includes('--ignore-rules'), `${role}: --ignore-rules`)
    const tmpExcl = a.includes('sandbox_workspace_write.exclude_slash_tmp=true') && a.includes('sandbox_workspace_write.exclude_tmpdir_env_var=true')
    assert.equal(tmpExcl, ['implement', 'fix'].includes(role), `${role}: /tmp and $TMPDIR are not writable roots for the implementer`)
    assert.equal(a[a.indexOf('-c') + 1], 'mcp_servers={}', `${role}: no MCP servers from any config layer`)
    assert.ok(!a.some(x => /dangerously|approve-for-me|danger-full-access|--trust/.test(x)), `${role}: never a sandbox bypass`)
  }
})

test('envFor: each kind of child gets only its own credentials and no git overrides', () => {
  const base = { PATH: '/bin', HOME: '/h', LYBER_API_KEY: 'lyb-1234567890', GH_TOKEN: 'gh-1234567890', ANTHROPIC_API_KEY: 'ant-1234567890',
    OPENAI_API_KEY: 'oai-1234567890', AWS_SECRET_ACCESS_KEY: 'aws-1234567890', GIT_INDEX_FILE: '/tmp/i', GIT_DIR: '/tmp/d', CLAUDECODE: '1', ORCA_TERMINAL_HANDLE: 'term_1' }
  const keys = (kind, o) => Object.keys(envFor(kind, base, o)).filter(k => k !== 'PATH' && k !== 'HOME').sort()
  assert.deepEqual(keys('fx'), ['LYBER_API_KEY', 'ORCA_TERMINAL_HANDLE'])
  assert.deepEqual(keys('claude'), ['ANTHROPIC_API_KEY', 'ORCA_TERMINAL_HANDLE'])
  assert.deepEqual(keys('codex'), ['OPENAI_API_KEY', 'ORCA_TERMINAL_HANDLE'])
  assert.deepEqual(keys('gh'), ['GH_TOKEN', 'ORCA_TERMINAL_HANDLE'])
  assert.deepEqual(keys('git'), ['GIT_TERMINAL_PROMPT', 'ORCA_TERMINAL_HANDLE'])
  assert.deepEqual(keys('push'), ['GH_TOKEN', 'GIT_TERMINAL_PROMPT', 'ORCA_TERMINAL_HANDLE'])
  assert.deepEqual(keys('test'), ['ORCA_TERMINAL_HANDLE'])
  assert.deepEqual(keys('plain'), ['ORCA_TERMINAL_HANDLE'])
  assert.deepEqual(keys('fx', { dryRun: true }), ['ORCA_TERMINAL_HANDLE'], 'dry-run: no real credential at all')
  // Git config overrides (e.g. an http.extraHeader with a token), Orca pairing codes, GH_REPO and the runner's test
  // command never reach the wrong child.
  const more = { ...base, GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic c2VjcmV0', ORCA_PAIRING_CODE: 'orca://pair?x', GH_REPO: 'someone/else', COUNCIL_TEST_CMD: 'npm test' }
  for (const kind of ['claude', 'codex', 'fx', 'test', 'git', 'gh', 'plain']) {
    const e = envFor(kind, more)
    assert.deepEqual(Object.keys(e).filter(k => /^GIT_CONFIG|^ORCA_PAIRING|^GH_REPO$|^COUNCIL_TEST_CMD$/.test(k)), [], kind)
  }
  assert.equal(envFor('orca', more).ORCA_PAIRING_CODE, 'orca://pair?x')
  assert.equal(envFor('fx', { ...base, COUNCIL_FAKE_SECRET: 'sentinel-123456' }, { dryRun: true }).LYBER_API_KEY, 'sentinel-123456')
  assert.equal(envFor('claude', { ...base, COUNCIL_FAKE_SECRET: 'sentinel-123456' }, { dryRun: true }).COUNCIL_FAKE_SECRET, undefined)
  assert.equal(envFor('claude', { ...base, MY_KEY: 'x' }, { fxKeyEnv: 'MY_KEY' }).MY_KEY, undefined)
})

test('fx: ask mode by flag (>= 0.0.17) and env; never auto/full-access; cannot implement', () => {
  const { args, env } = spec('fx', 'review')
  assert.equal(args[0], 'ask')
  assert.equal(after(args, '--permission-mode'), 'ask')
  assert.equal(after(args, '--provider'), 'lyber')
  assert.equal(after(args, '--model'), 'kimi-k31-pro-abliterated')
  assert.ok(args.includes('--json') && args.includes('--no-save'))
  assert.ok(!args.some(a => ['--auto', '--full-access', '--yolo'].includes(a)))
  assert.deepEqual([env.FX_PERMISSION_MODE, env.FX_PROVIDER, env.FX_MODEL], ['ask', 'lyber', 'kimi-k31-pro-abliterated'])
  assert.equal(env.LYBER_API_KEY, 'k'.repeat(20), 'fx is the one child that gets the key (from env, not argv)')
  assert.ok(!args.some(a => a.includes('k'.repeat(20))))
  const old = spec('fx', 'plan', { fxVersion: '0.0.16' }).args
  assert.ok(!old.includes('--permission-mode') && !old.includes('--provider'), 'fx 0.0.16 rejects these flags; env vars only')
  assert.throws(() => spec('fx', 'implement'), /read-only/)
  assert.throws(() => spec('fx', 'fix'), /read-only/)
})

test('versionGte', () => {
  assert.ok(versionGte('fx 0.0.17', '0.0.17')); assert.ok(versionGte('0.1.0', '0.0.17'))
  assert.ok(!versionGte('0.0.16', '0.0.17')); assert.ok(!versionGte(null, '0.0.17'))
})

test('parsers: claude result record, codex -o file then agent_message, fx JSON with usage', () => {
  const J = (o) => JSON.stringify(o)
  const c = PARSERS.claude([J({ type: 'system' }), J({ type: 'result', subtype: 'success', result: 'hi', usage: { input_tokens: 3, cache_read_input_tokens: 2, output_tokens: 4 } })].join('\n'))
  assert.deepEqual([c.ok, c.text, c.usage], [true, 'hi', { inputTokens: 5, outputTokens: 4 }])
  assert.match(PARSERS.claude(J({ type: 'result', subtype: 'error_max_turns', is_error: true })).error, /error_max_turns/)
  assert.equal(PARSERS.claude(J({ type: 'system' })).ok, false)

  const last = path.join(scratch, 'last.txt')
  const lines = [J({ type: 'item.completed', item: { type: 'agent_message', text: 'from events' } }), J({ type: 'turn.completed', usage: { input_tokens: 7, output_tokens: 8 } })].join('\n')
  assert.deepEqual(PARSERS.codex(lines, { lastFile: last }), { ok: true, text: 'from events', usage: { inputTokens: 7, outputTokens: 8 } })
  fs.writeFileSync(last, 'from -o file')
  assert.equal(PARSERS.codex(lines, { lastFile: last }).text, 'from -o file')
  assert.match(PARSERS.codex(J({ type: 'turn.failed', error: { message: 'boom' } }), { lastFile: '/none' }).error, /boom/)

  assert.deepEqual(PARSERS.fx(J({ final_output: 'answer', output: 'x', usage: { input_tokens: 1, output_tokens: 2 }, error: null })), { ok: true, text: 'answer', usage: { inputTokens: 1, outputTokens: 2 } })
  assert.match(PARSERS.fx(J({ final_output: '', error: { message: 'unauthorized' } })).error, /unauthorized/)
  assert.match(PARSERS.fx(J({ final_output: '', output: 'thinking... [{"severity":"minor"}]', error: null })).error, /no completed final response/, 'accumulated output is not the answer')
  assert.equal(PARSERS.fx(J({ output: 'legacy answer', error: null })).text, 'legacy answer', 'builds without final_output')
  assert.equal(PARSERS.fx(J({ final_output: 'x', exit_code: 2, error: null })).ok, false)
  assert.equal(PARSERS.fx('not json').ok, false)
})

test("codex model: COUNCIL_CODEX_MODEL wins, else config.toml's top-level model, never a table's", () => {
  const home = tmp('council-codexhome-')
  fs.writeFileSync(path.join(home, 'config.toml'), 'model_reasoning_effort = "max"\nmodel = "gpt-configured"\n\n[profiles.x]\nmodel = "other"\n')
  assert.equal(codexConfiguredModel({ CODEX_HOME: home }), 'gpt-configured')
  assert.equal(loadConfig({}, { CODEX_HOME: home }).models.codex, 'gpt-configured')
  assert.equal(loadConfig({}, { CODEX_HOME: home, COUNCIL_CODEX_MODEL: 'gpt-x' }).models.codex, 'gpt-x')
  fs.writeFileSync(path.join(home, 'config.toml'), '[profiles.x]\nmodel = "other"\n')
  assert.equal(codexConfiguredModel({ CODEX_HOME: home }), null)
})

test('dry-run availability honours COUNCIL_FAKE_MISSING and spends nothing', async () => {
  const dry = loadConfig({ dryRun: true }, {})
  const env = { ...process.env, COUNCIL_FAKE_MISSING: 'fx' }
  assert.equal((await createEngine('fx', dry, { scratch, env }).available()).ok, false)
  assert.equal((await createEngine('claude', dry, { scratch, env }).available()).ok, true)
})

test('a dry-run call goes through the fake with the real argv and parses like the real CLI', async () => {
  const dry = loadConfig({ dryRun: true }, {})
  const cwd = tmp('council-cwd-')
  for (const id of ['claude', 'codex', 'fx']) {
    const r = await createEngine(id, dry, { scratch, env: { ...process.env, LYBER_API_KEY: '' } }).run({ role: 'plan', prompt: 'Plan this task.', cwd, timeoutMs: 15000 })
    assert.equal(r.ok, true, `${id}: ${r.error} ${r.stderr}`)
    assert.match(r.text, /## Approach/)
    assert.ok(r.usage && r.usage.outputTokens > 0)
    assert.equal(r.argv[0], dry.bins[id])
  }
})

test('dry-run: the fake fx gets only the test sentinel (never the real key), other fakes get no secret, prompts are scrubbed', async () => {
  const dry = loadConfig({ dryRun: true }, {})
  const rec = path.join(tmp('council-rec-'), 'rec.jsonl')
  const env = { ...process.env, LYBER_API_KEY: 'lyb-PRODUCTION-KEY-777', GH_TOKEN: 'gh-PRODUCTION-888', COUNCIL_FAKE_SECRET: 'sentinel-SECRET-999', COUNCIL_FAKE_RECORD: rec }
  const cwd = tmp('council-cwd-')
  for (const id of ['fx', 'claude']) {
    const r = await createEngine(id, dry, { scratch, env }).run({ role: 'plan', prompt: 'Plan it. Key: lyb-PRODUCTION-KEY-777 and sentinel-SECRET-999', cwd, timeoutMs: 15000 })
    assert.equal(r.ok, true, r.error)
  }
  const lines = fs.readFileSync(rec, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const fx = lines.find(l => l.member === 'fx'), cl = lines.find(l => l.member === 'claude')
  assert.equal(fx.env.LYBER_API_KEY, 'sentinel-SECRET-999')
  assert.equal(fx.env.GH_TOKEN, undefined)
  assert.deepEqual(Object.keys(cl.env).filter(k => /KEY|TOKEN|SECRET/.test(k)), [])
  for (const l of lines) assert.doesNotMatch(l.stdin, /PRODUCTION|sentinel-SECRET/, `${l.member} stdin was not scrubbed`)
})

test('codex sandbox probe: no model call, reports the bwrap failure', async () => {
  const dir = tmp('council-stub-')
  const stub = path.join(dir, 'codex')
  fs.writeFileSync(stub, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ENGINE}" codex -- "$@"\n`, { mode: 0o755 })
  assert.deepEqual(await probeCodexSandbox(stub, { ...process.env, COUNCIL_FAKE_CODEX_SANDBOX: 'ok' }), { ok: true })
  const broken = await probeCodexSandbox(stub, { ...process.env, COUNCIL_FAKE_CODEX_SANDBOX: 'broken' })
  assert.equal(broken.ok, false)
  assert.match(broken.reason, /bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted/)
})

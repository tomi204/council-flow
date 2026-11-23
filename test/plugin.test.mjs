// The Orca plugin (orca-plugin.json + plugin/) seen from council-flow's side: its manifest asks for no more than it
// needs, its sources never read the environment or type into a terminal, and every command line it builds is parsed
// by council-flow's own parser exactly as intended. The plugin's own tests run with `orca plugin test plugin`.
//
// plugin/src/command.ts and redact.ts are imported directly when Node can strip TypeScript types (Node 22.18+ /
// 23.6+); on older Node those checks are skipped.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { parseArgs } from 'node:util'
import { OPTIONS, AUDIT_OPTIONS } from '../src/cli.mjs'
import { validateTarget } from '../src/audit/target.mjs'
import { scrubSecrets } from '../src/redact.mjs'
import { ROOT, BIN, toyRepo, testEnv, tmp, runDir, readJson } from './helpers.mjs'

const MANIFEST = readJson(path.join(ROOT, 'orca-plugin.json'))
const SRC = path.join(ROOT, 'plugin', 'src')
const sources = fs.readdirSync(SRC).filter(f => /\.tsx?$/.test(f) && !/\.(test|check)\.tsx?$/.test(f) && !f.endsWith('.d.ts'))
const strip = Boolean(process.features?.typescript)
const ts = strip ? { skip: false } : { skip: 'this Node cannot import TypeScript' }
const load = async (f) => import(new URL(`../plugin/src/${f}`, import.meta.url).href)

test('plugin manifest: worker, one panel, four commands and exactly three capabilities', () => {
  assert.equal(MANIFEST.id, 'council-flow')
  assert.ok(!MANIFEST.id.startsWith('orca-'))
  assert.equal(MANIFEST.publisher, undefined, 'Orca names the publisher after the repository owner')
  assert.equal(MANIFEST.execution, 'trusted-worker')
  assert.deepEqual(MANIFEST.capabilities.map(c => c.kind).sort(), ['storage:own', 'terminal:send', 'workspace:read'])
  assert.deepEqual(MANIFEST.contributes.commands.map(c => c.id), ['council-flow.audit', 'council-flow.code', 'council-flow.resume', 'council-flow.doctor'])
  assert.ok(MANIFEST.contributes.commands.every(c => !c.action && c.when === 'workspace'))
  assert.deepEqual(Object.keys(MANIFEST.contributes).sort(), ['commands', 'panels'], 'no hooks, events, settings or keybindings')
  for (const p of [MANIFEST.main, ...MANIFEST.contributes.panels.map(p => p.entry)]) assert.ok(fs.statSync(path.join(ROOT, p)).isFile(), p)
})

test('plugin sources: no environment, no secrets API, no typing into terminals, no subprocesses, no network', () => {
  assert.ok(sources.includes('worker.ts') && sources.includes('panel.tsx'))
  for (const f of sources) {
    const code = fs.readFileSync(path.join(SRC, f), 'utf8').replace(/^\s*\/\/.*$/gm, '')
    assert.doesNotMatch(code, /process\.env|import\.meta\.env/, `${f} reads the environment`)
    assert.doesNotMatch(code, /terminal\.sendText|sendText/, `${f} types into a terminal`)
    assert.doesNotMatch(code, /secrets\.|'secrets:own'/, `${f} uses the secrets store`)
    assert.doesNotMatch(code, /child_process|node:net|node:http|fetch\(|XMLHttpRequest|WebSocket/, `${f} spawns or connects`)
    assert.doesNotMatch(code, /writeFileSync|appendFileSync|rmSync|renameSync|mkdirSync|unlinkSync/, `${f} writes files`)
  }
})

const CLI = path.join(ROOT, 'bin', 'council-flow.mjs')
const REPO = '/home/me/code/api'
const ID = '20261122-101500-0a1b2c3d'
const parse = (argv) => {
  assert.deepEqual(argv.slice(0, 2), ['node', CLI])
  const { values, positionals } = parseArgs({ args: argv.slice(2), options: OPTIONS, allowPositionals: true })
  return { values: { ...values }, positionals }
}

test('every plugin command line means to council-flow exactly what the panel asked for', ts, async () => {
  const { buildAudit, buildCode, buildResume, buildDoctor } = await load('command.ts')
  for (const scope of ['Review authorization', '--dry-run', '-h', 'audit', "it's; touch \"$MARKER\" $(true)", '--target example.com:443']) {
    const r = buildAudit(CLI, REPO, { scope, target: 'localhost:3000', testTarget: 'test', rounds: '2', dryRun: true, refreshContext: true }, ID)
    assert.ok(r.ok, r.error)
    const { values, positionals } = parse(r.argv)
    assert.deepEqual(positionals, ['audit', scope])
    assert.deepEqual(values, { repo: REPO, target: 'localhost:3000', 'test-target': 'test', rounds: '2', 'refresh-context': true, 'dry-run': true, 'run-id': ID })
    assert.ok(Object.keys(values).every(k => AUDIT_OPTIONS.has(k)))
  }
  for (const task of ['Add /health', 'audit', 'doctor', 'issue', '--resume x']) {
    const r = buildCode(CLI, REPO, { task, implementer: 'codex', rounds: '0' }, ID)
    const { values, positionals } = parse(r.argv)
    assert.deepEqual(positionals, ['run', task])
    assert.deepEqual(values, { repo: REPO, implementer: 'codex', rounds: '0', 'run-id': ID })
  }
  const ar = parse(buildResume(CLI, REPO, { mode: 'audit', runId: ID, dryRun: true, refreshContext: true }).argv)
  assert.deepEqual(ar.positionals, ['audit'], 'audit resume passes no scope')
  assert.deepEqual(ar.values, { repo: REPO, resume: ID, 'refresh-context': true, 'dry-run': true })
  const cr = parse(buildResume(CLI, REPO, { mode: 'code', runId: ID, dryRun: false }).argv)
  assert.deepEqual([cr.positionals, cr.values], [[], { resume: ID, repo: REPO }])
  assert.deepEqual(parse(buildDoctor(CLI, REPO).argv).positionals, ['doctor'])
})

test('the plugin target pre-check never accepts a host council-flow refuses', ts, async () => {
  const { precheckTarget } = await load('command.ts')
  const repo = tmp('council-plugin-target-')
  const hosts = ['localhost:3000', 'http://localhost:1', 'https://127.0.0.1:8443/', '[::1]:80', '127.255.255.255:65535', '127.0.0.1:0', 'localhost:65536',
    '127.0.0.01:80', '127.0.0.256:80', '127.1:80', '0x7f000001:80', '2130706433:80', 'example.com:443', 'https://example.com:443', '10.0.0.1:22',
    '[::2]:80', '[::ffff:127.0.0.1]:80', 'localhost', '127.0.0.1', '0', '1.2.3.4.5', '//localhost:80', 'localhost.:80', 'LOCALHOST:80', 'ftp://localhost:21']
  for (const t of hosts) {
    let cliOk = true
    try { validateTarget(repo, t) } catch { cliOk = false }
    const mine = precheckTarget(t)
    if (mine.ok) assert.ok(cliOk, `plugin accepts ${t}, council-flow refuses it`)
    if (mine.ok && mine.kind === 'loopback') assert.equal(validateTarget(repo, t).kind, 'loopback', t)
  }
})

test('the plugin display scrub matches council-flow on credentials, without reading the environment', ts, async () => {
  const { scrubForDisplay } = await load('redact.ts')
  const corpus = [
    'Authorization: Bearer abcdef1234567890', 'curl -H "x-api-key: q1w2e3r4t5"', 'token ghp_' + 'a1'.repeat(15), 'sk-ant-' + 'x9'.repeat(12),
    'LYBER_API_KEY=lyb-12345678abcdef', '{"apiKey": "secret-value-1"}', 'AKIAABCDEFGHIJKLMNOP', 'xoxb-1234567890-abc', 'lin_api_' + 'z'.repeat(24),
    'github_pat_' + 'Q'.repeat(30), 'Basic authentication is fine', 'const t = `Bearer ${token}`', 'plain text, nothing to hide'
  ]
  for (const s of corpus) assert.equal(scrubForDisplay(s), scrubSecrets(s, { env: {} }), s)
})

test('a plugin-built coding command, run by a shell, is a normal dry run with the plugin\'s run id', ts, async () => {
  const { buildCode } = await load('command.ts')
  const toy = toyRepo()
  const r = buildCode(BIN, toy.dir, { task: "Add hello.txt saying 'hello council'", dryRun: true }, ID)
  assert.ok(r.ok)
  const run = spawnSync('/bin/sh', ['-c', r.line], { cwd: tmp('council-plugin-cwd-'), encoding: 'utf8', env: testEnv(), timeout: 120000 })
  assert.equal(run.status, 0, run.stderr)
  const state = readJson(path.join(runDir(toy.dir, ID), 'run.json'))
  assert.equal(state.runId, ID)
  assert.equal(state.task, "Add hello.txt saying 'hello council'")
  assert.equal(state.config.dryRun, true)
  assert.equal(state.outcome.gate, 'deny', 'the fake gate denies by default; the plugin answered nothing')
})

test('a plugin-built audit command still gets council-flow\'s own target check before any model call', ts, async () => {
  const { buildAudit } = await load('command.ts')
  const toy = toyRepo()
  const r = buildAudit(BIN, toy.dir, { scope: 'Review the reader', target: 'src/missing.js', dryRun: true }, ID)
  assert.ok(r.ok, 'a path is left to council-flow to check')
  const run = spawnSync('/bin/sh', ['-c', r.line], { encoding: 'utf8', env: testEnv(), timeout: 60000 })
  assert.equal(run.status, 1)
  assert.match(run.stderr, /invalid --target/)
  assert.ok(!fs.existsSync(runDir(toy.dir, ID)), 'refused before a run folder exists')
  assert.equal(buildAudit(BIN, toy.dir, { scope: 'x', target: 'prod.example.com:443' }, ID).ok, false, 'a public host is never even built')
})

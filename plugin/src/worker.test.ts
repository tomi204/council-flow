// Runs src/worker.ts's activate(orca) over Orca's mock host, with real temp repos on disk.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { afterEach, assert, describe, hostError, mockHost, mountWorker, test, type TestWorker } from 'orca/testing'
import * as main from './worker'
import type { ContextInfo, StartResult } from './protocol'

const noMatch = (value: string, re: RegExp, message?: string) => assert.ok(!re.test(value), message ?? `${value} matches ${re}`)

const made: string[] = []
let worker: TestWorker | undefined
afterEach(async () => {
  if (worker) {
    // The one rule above all: the plugin never types into a terminal after opening it.
    assert.equal(worker.host.callsOf('terminal.sendText').length, 0)
    assert.deepEqual(worker.refusals, [])
    for (const call of worker.host.calls) assert.ok(ALLOWED.has(call.method), `unexpected host call ${call.method}`)
    await worker.deactivate()
    worker = undefined
  }
  while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true })
})

const ALLOWED = new Set(['workspace.list', 'workspace.readContext', 'terminal.create', 'storage.get', 'storage.set', 'storage.delete', 'storage.keys'])

function tmp(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix))
  made.push(dir)
  return dir
}

function gitRepo(): string {
  const root = tmp('cf-plugin-repo-')
  fs.mkdirSync(path.join(root, '.git'))
  return root
}

function fakeCouncilFlow(): string {
  const root = tmp('cf-plugin-cli-')
  fs.mkdirSync(path.join(root, 'bin'))
  fs.writeFileSync(path.join(root, 'bin', 'council-flow.mjs'), '// stand-in\n')
  fs.writeFileSync(path.join(root, 'package.json'), JSON.stringify({ name: 'council-flow', version: '9.9.9' }))
  return root
}

type Created = { workspaceId: string; title?: string; command?: string }

async function setup(opts: { focused?: string | null; failCreate?: boolean; storage?: Record<string, never> } = {}) {
  const repo = gitRepo()
  const plain = tmp('cf-plugin-plain-')
  const created: Created[] = []
  const workspaces = [
    { id: 'identity:repo', kind: 'worktree', name: 'api', project: 'api', projectId: 'p1', path: repo, branch: 'main', hostId: 'local' },
    { id: 'folder:notes', kind: 'folder', name: 'notes', project: null, projectId: null, path: plain, branch: null, hostId: null },
    { id: 'identity:remote', kind: 'worktree', name: 'remote', project: 'api', projectId: 'p1', path: repo, branch: 'main', hostId: 'ssh:box' },
    { id: 'identity:plain', kind: 'worktree', name: 'plain', project: 'x', projectId: 'p2', path: plain, branch: 'main', hostId: 'local' }
  ]
  const host = mockHost({
    storage: opts.storage ?? {},
    results: {
      'workspace.list': () => ({ workspaces, truncated: false }),
      'workspace.readContext': () =>
        opts.focused === null ? null : { workspaceId: opts.focused ?? 'identity:repo', branch: 'main', displayName: 'api', terminals: [] },
      'terminal.create': (params: Created) => {
        if (opts.failCreate) throw hostError('action_failed', 'no workspace has this id')
        created.push(params)
        return { terminalId: `term-${created.length}` }
      }
    }
  })
  worker = await mountWorker(main, { host })
  return { repo, plain, created, host, worker }
}

function writeRun(repo: string, id: string, state: object, lock = false): void {
  const dir = path.join(repo, '.council-flow', id)
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(state))
  if (lock) fs.writeFileSync(path.join(dir, '.lock'), JSON.stringify({ pid: process.pid, host: os.hostname(), at: 'now' }))
}

const okStart = (r: StartResult) => {
  if (!r.ok) throw new Error(`expected a start, got: ${r.error}`)
  return r
}

describe('context', () => {
  test('lists usable Git workspaces, the focused one and the bundled council-flow', async () => {
    const { repo, worker } = await setup()
    const ctx = (await worker.request('cf.context')) as ContextInfo
    assert.deepEqual(ctx.workspaces.map((w) => [w.id, w.usable]), [['identity:repo', true], ['folder:notes', false], ['identity:remote', false], ['identity:plain', false]])
    assert.match(ctx.workspaces[1].reason ?? '', /folder workspace/)
    assert.match(ctx.workspaces[2].reason ?? '', /ssh:box/)
    assert.match(ctx.workspaces[3].reason ?? '', /not a Git checkout/)
    assert.equal(ctx.workspaces[0].path, repo)
    assert.equal(ctx.focusedId, 'identity:repo')
    assert.equal(ctx.canStart, true)
    // This plugin lives in the council-flow repository: the CLI next to it is found.
    assert.ok(ctx.cli.ok)
    if (ctx.cli.ok) {
      assert.equal(ctx.cli.source, 'bundled')
      assert.match(ctx.cli.path, /\/bin\/council-flow\.mjs$/)
    }
  })

  test('no focused workspace', async () => {
    const { worker } = await setup({ focused: null })
    assert.equal(((await worker.request('cf.context')) as ContextInfo).focusedId, null)
  })
})

describe('starting runs', () => {
  test('an audit opens exactly one new Orca terminal running the built command', async () => {
    const { repo, created, worker } = await setup()
    const res = okStart(await worker.request('cf.start', { kind: 'audit', workspaceId: 'identity:repo', repo, audit: { scope: 'Review auth', target: 'localhost:3000', dryRun: true } }))
    assert.equal(created.length, 1)
    const [call] = created
    assert.equal(call.workspaceId, 'identity:repo')
    assert.equal(call.title, `council-flow audit ${res.runId}`)
    assert.equal(call.command, res.line)
    assert.match(res.line, new RegExp(`^node /\\S+/bin/council-flow\\.mjs audit --repo ${repo} --target localhost:3000 --dry-run --run-id ${res.runId} -- 'Review auth'$`))
    assert.equal(res.terminalId, 'term-1')
    assert.deepEqual(worker.posts.map((p) => p.event), ['cf.started'])
    const stored = worker.host.data().storage as { started: { runId: string }[]; last: Record<string, { audit: { scope: string } }> }
    assert.equal(stored.started[0].runId, res.runId)
    assert.equal(stored.last[repo].audit.scope, 'Review auth')
  })

  test('a non-local target never reaches Orca', async () => {
    const { repo, created, worker } = await setup()
    for (const target of ['example.com:443', 'https://203.0.113.9:443', '10.1.2.3:8080']) {
      const res = await worker.request('cf.start', { kind: 'audit', workspaceId: 'identity:repo', repo, audit: { scope: 'x', target } })
      assert.equal(res.ok, false, target)
      if (!res.ok) assert.match(res.error, /loopback/)
    }
    assert.equal(created.length, 0)
    assert.equal(worker.posts.length, 0)
  })

  test('a coding run uses the run subcommand', async () => {
    const { repo, created, worker } = await setup()
    const res = okStart(await worker.request('cf.start', { kind: 'code', workspaceId: 'identity:repo', repo, code: { task: 'audit', implementer: 'claude', rounds: '1' } }))
    assert.match(created[0].command ?? '', new RegExp(` run --repo ${repo} --implementer claude --rounds 1 --run-id ${res.runId} -- audit$`))
  })

  test('unknown form fields are dropped, not passed on', async () => {
    const { repo, created, worker } = await setup()
    okStart(await worker.request('cf.start', { kind: 'code', workspaceId: 'identity:repo', repo, code: { task: 't', env: 'COUNCIL_FAKE_GATE=approve', dryRun: 'yes', implementer: 'fx' } as never }))
    noMatch(created[0].command ?? '', /COUNCIL_FAKE_GATE|--dry-run|--implementer/)
  })

  test('refuses unusable workspaces and non-Git repositories', async () => {
    const { repo, plain, created, worker } = await setup()
    for (const [workspaceId, r] of [['folder:notes', plain], ['identity:remote', repo], ['identity:plain', plain], ['identity:gone', repo]]) {
      const res = await worker.request('cf.start', { kind: 'doctor', workspaceId, repo: r })
      assert.equal(res.ok, false, workspaceId)
    }
    const res = await worker.request('cf.start', { kind: 'doctor', workspaceId: 'identity:repo', repo: plain })
    assert.equal(res.ok, false)
    assert.equal(created.length, 0)
  })

  test('reports a terminal Orca could not open', async () => {
    const { repo, worker } = await setup({ failCreate: true })
    const res = await worker.request('cf.start', { kind: 'doctor', workspaceId: 'identity:repo', repo })
    assert.equal(res.ok, false)
    if (!res.ok) assert.match(res.error, /could not open a terminal.*action_failed/)
    assert.equal(worker.posts.length, 0)
  })

  test('a configured council-flow checkout wins over the bundled one', async () => {
    const { repo, created, worker } = await setup()
    const bad = await worker.request('cf.setCli', { path: '/nonexistent/council-flow' })
    assert.equal(bad.ok, false)
    assert.equal(worker.host.data().storage.cliPath, undefined)
    const cli = fakeCouncilFlow()
    const good = await worker.request('cf.setCli', { path: cli })
    assert.deepEqual(good, { ok: true, path: path.join(cli, 'bin', 'council-flow.mjs'), version: '9.9.9', source: 'configured' })
    okStart(await worker.request('cf.start', { kind: 'doctor', workspaceId: 'identity:repo', repo }))
    assert.equal(created[0].command, `node ${cli}/bin/council-flow.mjs doctor --repo ${repo}`)
    const cleared = await worker.request('cf.setCli', { path: null })
    assert.equal(cleared.ok && cleared.source, 'bundled')
  })
})

describe('runs and resume', () => {
  test('lists runs with the terminals the plugin started', async () => {
    const { repo, worker } = await setup()
    writeRun(repo, '20261120-100000-aaaaaaaa', { mode: 'audit', task: 'scope', config: { dryRun: true }, updatedAt: '2026-11-20T10:00:00Z' })
    const started = okStart(await worker.request('cf.start', { kind: 'code', workspaceId: 'identity:repo', repo, code: { task: 'x' } }))
    const answer = await worker.request('cf.runs', { repo })
    assert.deepEqual(answer.runs.map((r) => r.runId), ['20261120-100000-aaaaaaaa'])
    assert.deepEqual(answer.started.map((s) => s.runId), [started.runId])
    const bad = await worker.request('cf.runs', { repo: 'relative' })
    assert.match(bad.error ?? '', /absolute/)
  })

  test('opens artifacts through the allowlist only', async () => {
    const { repo, worker } = await setup()
    writeRun(repo, '20261120-100000-aaaaaaaa', { task: 'x' })
    const ok = await worker.request('cf.artifact', { repo, runId: '20261120-100000-aaaaaaaa', name: 'run.json' })
    assert.equal(ok.ok, true)
    const no = await worker.request('cf.artifact', { repo, runId: '20261120-100000-aaaaaaaa', name: '../../../.git/config' })
    assert.equal(no.ok, false)
  })

  test('resume uses the run\'s own subcommand and dry-run setting', async () => {
    const { repo, created, worker } = await setup()
    writeRun(repo, '20261120-100000-aaaaaaaa', { mode: 'audit', task: 's', config: { dryRun: true }, outcome: null })
    writeRun(repo, '20261121-100000-bbbbbbbb', { task: 't', config: { dryRun: false }, outcome: { status: 'failed' } })
    okStart(await worker.request('cf.resume', { workspaceId: 'identity:repo', repo, runId: '20261120-100000-aaaaaaaa', refreshContext: true }))
    okStart(await worker.request('cf.resume', { workspaceId: 'identity:repo', repo, runId: '20261121-100000-bbbbbbbb', refreshContext: true }))
    assert.match(created[0].command ?? '', new RegExp(` audit --repo ${repo} --resume 20261120-100000-aaaaaaaa --refresh-context --dry-run$`))
    assert.match(created[1].command ?? '', new RegExp(` --resume 20261121-100000-bbbbbbbb --repo ${repo}$`))
    assert.equal(created[1].title, 'council-flow resume 20261121-100000-bbbbbbbb')
  })

  test('a running or missing run is not resumed', async () => {
    const { repo, created, worker } = await setup()
    writeRun(repo, '20261120-100000-aaaaaaaa', { task: 's' }, true)
    const running = await worker.request('cf.resume', { workspaceId: 'identity:repo', repo, runId: '20261120-100000-aaaaaaaa' })
    assert.equal(running.ok, false)
    const missing = await worker.request('cf.resume', { workspaceId: 'identity:repo', repo, runId: '20261120-100000-ffffffff' })
    assert.equal(missing.ok, false)
    assert.equal(created.length, 0)
  })
})

describe('palette commands', () => {
  test('start from the focused workspace\'s last settings, or say how to begin', async () => {
    const { repo, created, worker } = await setup()
    const first = await worker.command('council-flow.audit')
    assert.match(String(first), /no earlier audit.*Council Flow panel/)
    assert.equal(created.length, 0)

    okStart(await worker.request('cf.start', { kind: 'audit', workspaceId: 'identity:repo', repo, audit: { scope: 'Review auth', target: 'src', rounds: '1' } }))
    const again = await worker.command('council-flow.audit')
    assert.match(String(again), /opened terminal "council-flow audit \S+" in api/)
    assert.match(created[1].command ?? '', / --target src --rounds 1 --run-id \S+ -- 'Review auth'$/)

    const withArgs = await worker.command('council-flow.code', { task: 'Add /health', dryRun: true })
    assert.match(String(withArgs), /opened terminal/)
    assert.match(created[2].command ?? '', / run --repo \S+ --dry-run --run-id \S+ -- 'Add \/health'$/)
  })

  test('resume picks the newest interrupted or failed run', async () => {
    const { repo, created, worker } = await setup()
    assert.match(String(await worker.command('council-flow.resume')), /no interrupted or failed run/)
    writeRun(repo, '20261119-100000-aaaaaaaa', { task: 'old', updatedAt: '2026-11-19T10:00:00Z', outcome: null })
    writeRun(repo, '20261120-100000-bbbbbbbb', { task: 'new', updatedAt: '2026-11-20T10:00:00Z', outcome: null })
    writeRun(repo, '20261121-100000-cccccccc', { task: 'done', updatedAt: '2026-11-21T10:00:00Z', outcome: { status: 'declined' } })
    assert.match(String(await worker.command('council-flow.resume')), /opened terminal "council-flow resume 20261120-100000-bbbbbbbb"/)
    assert.match(created[0].command ?? '', /--resume 20261120-100000-bbbbbbbb/)
  })

  test('doctor opens a terminal in the focused workspace', async () => {
    const { created, worker } = await setup()
    assert.match(String(await worker.command('council-flow.doctor')), /opened terminal "council-flow doctor"/)
    assert.match(created[0].command ?? '', / doctor --repo \S+$/)
  })

  test('a focused workspace that cannot run council-flow is named, nothing opens', async () => {
    const { created, worker } = await setup({ focused: 'folder:notes' })
    assert.match(String(await worker.command('council-flow.doctor')), /notes: a folder workspace/)
    assert.match(String(await worker.command('council-flow.audit')), /notes: a folder workspace/)
    assert.equal(created.length, 0)
  })
})

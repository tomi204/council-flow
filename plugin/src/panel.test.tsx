// The panel against a stand-in worker: what it shows, and exactly what it asks the worker to do.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import type { ArtifactResult, ContextInfo, RunRow, RunsAnswer, StartResult } from './protocol'

const CLI = '/home/me/council-flow/bin/council-flow.mjs'
const REPO = '/home/me/code/api'

let view: TestPanel | undefined
afterEach(async () => {
  if (view) {
    assert.deepEqual(view.errors, [])
    assert.deepEqual(view.warnings, [])
    assert.deepEqual(view.refusals, [])
    await view.unmount()
    view = undefined
  }
})

const context = (over: Partial<ContextInfo> = {}): ContextInfo => ({
  workspaces: [
    { id: 'identity:api', name: 'api', project: 'api', path: REPO, branch: 'main', hostId: 'local', usable: true, reason: null },
    { id: 'folder:notes', name: 'notes', project: null, path: '/home/me/notes', branch: null, hostId: null, usable: false, reason: 'a folder workspace, not a Git checkout' }
  ],
  focusedId: 'identity:api',
  cli: { ok: true, path: CLI, version: '0.2.0', source: 'bundled' },
  canStart: true,
  ...over
})

const row = (over: Partial<RunRow>): RunRow => ({
  runId: '20261120-100000-aaaaaaaa',
  mode: 'audit',
  status: 'declined',
  tone: 'warning',
  title: 'Review authorization',
  createdAt: Date.UTC(2026, 10, 20, 10),
  updatedAt: Date.UTC(2026, 10, 20, 11),
  dryRun: true,
  target: 'localhost:3000',
  stopReason: 'max-rounds',
  unresolved: 2,
  running: false,
  resumable: true,
  files: { summary: true, findings: true, runJson: true },
  ...over
})

function host(opts: { ctx?: ContextInfo; runs?: RunRow[]; artifact?: string } = {}) {
  const calls: { name: string; input: unknown }[] = []
  const started = (input: { kind: string }): StartResult => ({
    ok: true,
    kind: input.kind as 'audit',
    runId: '20261122-120000-bbbbbbbb',
    repo: REPO,
    workspaceId: 'identity:api',
    workspaceName: 'api',
    terminalId: 'term-1',
    title: `council-flow ${input.kind} 20261122-120000-bbbbbbbb`,
    line: 'node … (built by the worker)',
    at: 0
  })
  const h = mockHost({
    requests: {
      'cf.context': () => opts.ctx ?? context(),
      'cf.runs': (input: { repo: string }): RunsAnswer => {
        calls.push({ name: 'cf.runs', input })
        return { repo: input.repo, runs: opts.runs ?? [], truncated: false, started: [] }
      },
      'cf.start': (input: { kind: string }) => {
        calls.push({ name: 'cf.start', input })
        return started(input)
      },
      'cf.resume': (input: unknown) => {
        calls.push({ name: 'cf.resume', input })
        return { ...started({ kind: 'resume' }) }
      },
      'cf.artifact': (input: { name: string }): ArtifactResult => {
        calls.push({ name: 'cf.artifact', input })
        return { ok: true, artifact: { runId: '20261120-100000-aaaaaaaa', name: input.name as 'summary.md', text: opts.artifact ?? '# Local security audit\n\nUnresolved: 2', truncated: false, bytes: 10, path: `${REPO}/.council-flow/20261120-100000-aaaaaaaa/${input.name}` } }
      },
      'cf.setCli': (input: { path: string | null }) => {
        calls.push({ name: 'cf.setCli', input })
        return { ok: true, path: `${input.path}/bin/council-flow.mjs`, version: '0.2.0', source: 'configured' }
      }
    }
  })
  return { h, calls, of: (name: string) => calls.filter((c) => c.name === name).map((c) => c.input) }
}

const codeText = (v: TestPanel) => v.findAll({ type: 'Code' }).map((c) => c.text)

describe('audit', () => {
  test('defaults to the focused workspace and a dry run; needs a scope', async () => {
    const { h } = host()
    view = await mount(panel, { host: h })
    assert.equal(view.valueOf({ label: 'Workspace' }), 'identity:api')
    assert.equal(view.valueOf({ label: 'Dry run' }), true)
    assert.ok(view.find({ type: 'Callout', text: /Local only/ }))
    assert.ok(view.find({ type: 'Text', text: 'scope is required' }))
    assert.equal(view.find({ role: 'button', text: 'Start audit in a new terminal' })?.disabled, true)
  })

  test('shows the exact command and starts it through the worker', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    await view.type({ label: 'Scope' }, "Review the reader's authorization")
    await view.type({ label: 'Target' }, 'localhost:3000')
    await view.select({ label: 'Iterations' }, '1')
    assert.deepEqual(codeText(view), [`node ${CLI} audit --repo ${REPO} --target localhost:3000 --rounds 1 --dry-run --run-id <new run id> -- 'Review the reader'\\''s authorization'`])
    await view.press({ role: 'button', text: 'Start audit in a new terminal' })
    assert.deepEqual(of('cf.start'), [{ kind: 'audit', workspaceId: 'identity:api', repo: REPO, audit: { scope: "Review the reader's authorization", target: 'localhost:3000', testTarget: '', rounds: '1', dryRun: true, refreshContext: false } }])
    assert.ok(view.find({ type: 'Callout', text: /Opened "council-flow audit 20261122-120000-bbbbbbbb".*only your exact "approve" there.*never types into it/ }))
  })

  test('a non-local target is flagged and cannot be started', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    await view.type({ label: 'Scope' }, 'x')
    await view.type({ label: 'Target' }, 'prod.example.com:443')
    assert.ok(view.find({ type: 'Text', text: /loopback host/ }))
    assert.equal(view.find({ role: 'button', text: 'Start audit in a new terminal' })?.disabled, true)
    assert.deepEqual(of('cf.start'), [])
  })
})

describe('coding run', () => {
  test('collects the task and options', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    await view.select({ label: 'Mode' }, 'code')
    await view.type({ label: 'Task' }, 'Add a /health endpoint')
    await view.select({ label: 'Implementer' }, 'claude')
    await view.toggle({ label: 'Dry run' })
    assert.deepEqual(codeText(view), [`node ${CLI} run --repo ${REPO} --implementer claude --run-id <new run id> -- 'Add a /health endpoint'`])
    await view.press({ role: 'button', text: 'Start coding run in a new terminal' })
    assert.deepEqual(of('cf.start'), [{ kind: 'code', workspaceId: 'identity:api', repo: REPO, code: { task: 'Add a /health endpoint', implementer: 'claude', rounds: '', dryRun: false } }])
    assert.ok(view.find({ type: 'Callout', text: /decision gate in Orca/ }))
  })
})

describe('runs', () => {
  test('lists runs, opens artifacts and resumes with the run\'s own settings', async () => {
    const long = `# Findings\n\n${'line of findings\n'.repeat(1000)}`
    const { h, of } = host({ runs: [row({}), row({ runId: '20261121-100000-cccccccc', mode: 'code', status: 'running', running: true, resumable: false, target: null, files: { summary: false, findings: false, runJson: true } })], artifact: long })
    view = await mount(panel, { host: h })
    await view.select({ label: 'Mode' }, 'runs')
    assert.deepEqual(view.rowsOf({ label: 'Runs' }), ['20261120-100000-aaaaaaaa', '20261121-100000-cccccccc'])
    assert.deepEqual(of('cf.runs'), [{ repo: REPO }])

    await view.activateRow({ label: 'Runs' }, '20261120-100000-aaaaaaaa')
    assert.ok(view.find({ type: 'KeyValue' }))
    await view.press({ role: 'button', text: 'findings.md' })
    assert.deepEqual(of('cf.artifact'), [{ repo: REPO, runId: '20261120-100000-aaaaaaaa', name: 'findings.md' }])
    const pages = Math.ceil(long.length / panel.PAGE)
    assert.ok(view.find({ type: 'Badge', text: `1/${pages}` }))
    await view.press({ label: 'Next page' })
    assert.ok(view.find({ type: 'Badge', text: `2/${pages}` }))
    for (const md of view.findAll({ type: 'Markdown' })) assert.ok(String(md.props.content).length <= panel.PAGE)

    await view.toggle({ label: 'Refresh context on resume' })
    await view.press({ role: 'button', text: 'Resume in a new terminal (dry run)' })
    assert.deepEqual(of('cf.resume'), [{ workspaceId: 'identity:api', repo: REPO, runId: '20261120-100000-aaaaaaaa', refreshContext: true }])

    await view.activateRow({ label: 'Runs' }, '20261121-100000-cccccccc')
    assert.equal(view.find({ role: 'button', text: 'Running' })?.disabled, true)
    assert.equal(view.find({ role: 'button', text: 'summary.md' })?.disabled, true)
  })
})

describe('setup and empty states', () => {
  test('no council-flow found: says so and blocks starting', async () => {
    const { h, of } = host({ ctx: context({ cli: { ok: false, error: 'council-flow not found next to the plugin: set its checkout folder under Setup', configured: null } }) })
    view = await mount(panel, { host: h })
    assert.ok(view.find({ type: 'Callout', text: /council-flow not found/ }))
    await view.type({ label: 'Scope' }, 'x')
    assert.equal(view.find({ role: 'button', text: 'Start audit in a new terminal' })?.disabled, true)
    await view.type({ label: 'council-flow checkout' }, '/home/me/council-flow')
    await view.press({ role: 'button', text: 'Use this checkout' })
    assert.deepEqual(of('cf.setCli'), [{ path: '/home/me/council-flow' }])
    assert.equal(view.find({ role: 'button', text: 'Start audit in a new terminal' })?.disabled, false)
  })

  test('no Git workspace', async () => {
    const { h } = host({ ctx: context({ workspaces: [], focusedId: null }) })
    view = await mount(panel, { host: h })
    assert.ok(view.find({ type: 'EmptyState', label: 'No Git workspace' }))
  })
})

// The panel against a stand-in worker: what it shows, and exactly what it asks the worker to do.
import { afterEach, assert, describe, mockHost, mount, test, type TestPanel } from 'orca/testing'
import * as panel from './panel'
import { EXAMPLE_PROMPT } from './mode'
import { progressOf, type RunState } from './progress'
import type { ArtifactResult, ContextInfo, StartResult, Workflow, WorkflowsAnswer } from './protocol'

const CLI = '/home/me/council-flow/bin/council-flow.mjs'
const REPO = '/home/me/code/api'
const WEB = '/home/me/code/web'

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
    { id: 'identity:web', name: 'web', project: 'web', path: WEB, branch: 'dev', hostId: 'local', usable: true, reason: null },
    { id: 'folder:notes', name: 'notes', project: null, path: '/home/me/notes', branch: null, hostId: null, usable: false, reason: 'a folder workspace, not a Git checkout' }
  ],
  focusedId: 'identity:api',
  cli: { ok: true, path: CLI, version: '0.2.0', source: 'bundled' },
  canStart: true,
  canFocus: true,
  ...over
})

const iso = (minAgo: number) => new Date(Date.now() - minAgo * 60_000).toISOString()

function flow(over: Partial<Workflow> & { state?: RunState; live?: boolean; summaryAgo?: number } = {}): Workflow {
  const { state, live, summaryAgo, ...rest } = over
  const mode = rest.mode === 'code' ? 'code' : 'audit'
  const progress = progressOf({
    mode,
    state: state ?? { mode, config: { rounds: 3 }, stages: { 'context-1': { status: 'done', startedAt: iso(9), endedAt: iso(8) }, 'teams-1': { status: 'running', startedAt: iso(8) } }, auditLoop: { iterations: [{ number: 1 }], ledger: [{ status: 'open' }, { status: 'fixed' }] } },
    lock: live === false ? 'none' : 'alive',
    lockAt: Date.now() - 10 * 60_000,
    summaryMtime: summaryAgo === undefined ? null : Date.now() - summaryAgo * 60_000
  })
  return {
    runId: '20261123-100000-aaaaaaaa',
    repo: REPO,
    repoName: 'api',
    mode,
    title: 'Review authorization',
    dryRun: true,
    target: null,
    createdAt: Date.now() - 10 * 60_000,
    updatedAt: Date.now() - 60_000,
    since: live === false ? null : Date.now() - 10 * 60_000,
    progress,
    files: { summary: true, findings: true, runJson: true },
    resumable: progress.phase === 'interrupted' || progress.phase === 'failed',
    terminal: { id: 'term-7', title: 'council-flow audit 20261123-100000-aaaaaaaa', workspaceName: 'api', alive: true },
    ...rest
  }
}

const waitingFlow = () =>
  flow({
    runId: '20261123-090000-bbbbbbbb',
    title: 'Review request parsing',
    summaryAgo: 1,
    state: { mode: 'audit', config: { rounds: 1 }, stages: { 'review-1': { status: 'done', startedAt: iso(6), endedAt: iso(5) }, tests: { status: 'done', startedAt: iso(5), endedAt: iso(3) } }, auditLoop: { iterations: [{ number: 1 }], ledger: [{ status: 'fixed' }] } },
    terminal: { id: 'term-3', title: 'council-flow audit 20261123-090000-bbbbbbbb', workspaceName: 'api', alive: true }
  })

function host(opts: { ctx?: ContextInfo; flows?: Workflow[]; artifact?: string } = {}) {
  const calls: { name: string; input: unknown }[] = []
  let flows = opts.flows ?? []
  const started = (input: { kind: string }): StartResult => ({
    ok: true,
    kind: input.kind as 'audit',
    runId: '20261123-120000-cccccccc',
    repo: REPO,
    workspaceId: 'identity:api',
    workspaceName: 'api',
    terminalId: 'term-1',
    title: `council-flow ${input.kind === 'audit' ? 'audit ' : ''}20261123-120000-cccccccc`,
    line: 'node … (built by the worker)',
    at: 0
  })
  const h = mockHost({
    requests: {
      'cf.context': () => {
        calls.push({ name: 'cf.context', input: null })
        return opts.ctx ?? context()
      },
      'cf.workflows': (input: { repo: string }): WorkflowsAnswer => {
        calls.push({ name: 'cf.workflows', input })
        return { repos: [input.repo], workflows: flows, errors: [], truncated: false }
      },
      'cf.start': (input: { kind: string }) => {
        calls.push({ name: 'cf.start', input })
        return started(input)
      },
      'cf.resume': (input: unknown) => {
        calls.push({ name: 'cf.resume', input })
        return started({ kind: 'resume' })
      },
      'cf.focus': (input: unknown) => {
        calls.push({ name: 'cf.focus', input })
        return { ok: true, focused: true }
      },
      'cf.artifact': (input: { runId: string; name: string }): ArtifactResult => {
        calls.push({ name: 'cf.artifact', input })
        return { ok: true, artifact: { runId: input.runId, name: input.name as 'summary.md', text: opts.artifact ?? '# Local security audit\n\nUnresolved: 1', truncated: false, bytes: 10, path: `${REPO}/.council-flow/${input.runId}/${input.name}` } }
      },
      'cf.setCli': (input: { path: string | null }) => {
        calls.push({ name: 'cf.setCli', input })
        return { ok: true, path: `${input.path}/bin/council-flow.mjs`, version: '0.2.0', source: 'configured' }
      }
    }
  })
  return {
    h,
    calls,
    of: (name: string) => calls.filter((c) => c.name === name).map((c) => c.input),
    setFlows: (next: Workflow[]) => {
      flows = next
    }
  }
}

const noMatch = (value: string, re: RegExp, message?: string) => assert.ok(!re.test(value), message ?? `${value} matches ${re}`)
const runButton = (v: TestPanel) => v.find({ role: 'button', text: 'Run' })
const codeText = (v: TestPanel) => v.findAll({ type: 'Code' }).map((c) => c.text)

describe('the prompt', () => {
  test('one prompt, one Run; the focused workspace; dry run on; audit until the prompt says otherwise', async () => {
    const { h } = host()
    view = await mount(panel, { host: h })
    assert.ok(view.find({ type: 'Textarea', label: 'What should the council do?' }))
    assert.equal(view.valueOf({ label: 'Repo' }), 'identity:api')
    assert.equal(view.valueOf({ label: 'Dry run' }), true)
    assert.equal(view.valueOf({ label: 'Mode' }), 'audit')
    assert.equal(runButton(view)?.disabled, true, 'nothing to run yet')
    assert.ok(view.find({ type: 'Text', text: 'Say what the council should do, then Run.' }))
    assert.equal(view.findAll({ role: 'button', text: 'Run' }).length, 1)
    assert.ok(!view.find({ type: 'Tabs' }), 'no Audit / Code / Runs / Setup tabs')
  })

  test('Options are not needed: type, Run, and it starts a dry-run audit in a new terminal', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    await view.type({ label: 'What should the council do?' }, "Review the reader's authorization")
    assert.equal(view.valueOf({ label: 'Mode' }), 'audit')
    assert.ok(view.find({ type: 'Text', text: /Dry run: fake models.*No tokens are spent/ }))
    await view.press({ role: 'button', text: 'Run' })
    assert.deepEqual(of('cf.start'), [{ kind: 'audit', workspaceId: 'identity:api', repo: REPO, audit: { scope: "Review the reader's authorization", target: '', testTarget: '', rounds: '', dryRun: true, refreshContext: false } }])
    assert.ok(view.find({ type: 'Callout', text: /Started "council-flow audit 20261123-120000-cccccccc".*only your exact "approve" there.*never types into it/ }))
    assert.equal(view.valueOf({ label: 'What should the council do?' }), '', 'the prompt is cleared for the next one')
  })

  test('the mode follows the prompt, and a manual pick holds until the prompt reads differently', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    await view.type({ label: 'What should the council do?' }, 'Add a /health endpoint')
    assert.equal(view.valueOf({ label: 'Mode' }), 'code')
    assert.ok(view.find({ type: 'Text', text: /^Picked from your prompt: code/ }))
    await view.select({ label: 'Mode' }, 'audit')
    assert.equal(view.valueOf({ label: 'Mode' }), 'audit')
    assert.ok(view.find({ type: 'Text', text: /^Your pick: audit/ }))
    await view.type({ label: 'What should the council do?' }, ' with a test')
    assert.equal(view.valueOf({ label: 'Mode' }), 'audit', 'still reads as code: the pick holds')
    await view.type({ label: 'What should the council do?' }, 'Review the session store', { replace: true })
    assert.equal(view.valueOf({ label: 'Mode' }), 'audit')
    await view.type({ label: 'What should the council do?' }, 'Refactor the session store', { replace: true })
    assert.equal(view.valueOf({ label: 'Mode' }), 'code', 'the pick was let go when the prompt read as audit')
    await view.press({ role: 'button', text: 'Run' })
    assert.deepEqual(of('cf.start'), [{ kind: 'code', workspaceId: 'identity:api', repo: REPO, code: { task: 'Refactor the session store', implementer: '', rounds: '', dryRun: true } }])
    assert.ok(view.find({ type: 'Callout', text: /decision gate in Orca/ }))
  })

  test('turning dry run off is visible and says tokens are spent', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    await view.type({ label: 'What should the council do?' }, 'Review auth')
    await view.toggle({ label: 'Dry run' })
    assert.ok(view.find({ type: 'Text', text: /Real run: .*tokens are spent/ }))
    await view.press({ role: 'button', text: 'Run' })
    assert.equal((of('cf.start')[0] as { audit: { dryRun: boolean } }).audit.dryRun, false)
  })

  test('Options: audit fields, the exact command, and a non-local target is refused', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    await view.type({ label: 'What should the council do?' }, 'Review request parsing')
    await view.toggle({ label: 'Options' })
    await view.type({ label: 'Target' }, 'localhost:3000')
    await view.select({ label: 'Iterations' }, '1')
    await view.toggle({ label: 'Refresh context' })
    assert.deepEqual(codeText(view), [`node ${CLI} audit --repo ${REPO} --target localhost:3000 --rounds 1 --refresh-context --dry-run --run-id <new run id> -- 'Review request parsing'`])
    await view.type({ label: 'Target' }, 'prod.example.com:443', { replace: true })
    assert.ok(view.find({ type: 'Text', text: /loopback host/ }))
    assert.equal(runButton(view)?.disabled, true)
    await view.press({ role: 'button', text: 'Run' }).catch(() => undefined)
    assert.deepEqual(of('cf.start'), [])
    await view.type({ label: 'Target' }, 'src/reader.js', { replace: true })
    await view.type({ label: 'Test target' }, 'test/reader.test.mjs')
    await view.press({ role: 'button', text: 'Run' })
    assert.deepEqual(of('cf.start'), [{ kind: 'audit', workspaceId: 'identity:api', repo: REPO, audit: { scope: 'Review request parsing', target: 'src/reader.js', testTarget: 'test/reader.test.mjs', rounds: '1', dryRun: true, refreshContext: true } }])
  })

  test('Options: coding fields', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    await view.type({ label: 'What should the council do?' }, 'Implement pagination')
    await view.toggle({ label: 'Options' })
    await view.select({ label: 'Implementer' }, 'claude')
    await view.select({ label: 'Fix rounds' }, '1')
    assert.deepEqual(codeText(view), [`node ${CLI} run --repo ${REPO} --implementer claude --rounds 1 --dry-run --run-id <new run id> -- 'Implement pagination'`])
    await view.press({ role: 'button', text: 'Run' })
    assert.deepEqual(of('cf.start'), [{ kind: 'code', workspaceId: 'identity:api', repo: REPO, code: { task: 'Implement pagination', implementer: 'claude', rounds: '1', dryRun: true } }])
  })

  test('another workspace, or a folder path, from the Repo dropdown and Options', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    await view.select({ label: 'Repo' }, 'identity:web')
    assert.deepEqual(of('cf.workflows').at(-1), { repo: WEB })
    await view.type({ label: 'What should the council do?' }, 'Review auth')
    await view.press({ role: 'button', text: 'Run' })
    assert.equal((of('cf.start')[0] as { workspaceId: string; repo: string }).repo, WEB)
    await view.toggle({ label: 'Options' })
    await view.type({ label: 'Repository folder' }, '/home/me/code/web/packages/core')
    await view.type({ label: 'What should the council do?' }, 'Review auth')
    await view.press({ role: 'button', text: 'Run' })
    assert.deepEqual(of('cf.start')[1], { kind: 'audit', workspaceId: 'identity:web', repo: '/home/me/code/web/packages/core', audit: { scope: 'Review auth', target: '', testTarget: '', rounds: '', dryRun: true, refreshContext: false } })
  })
})

describe('workflows', () => {
  test('first run: what Council Flow does, and an example prompt to try', async () => {
    const { h } = host()
    view = await mount(panel, { host: h })
    const empty = view.find({ type: 'EmptyState', label: 'No workflows yet' })
    assert.ok(empty)
    const words = `${empty?.props.description ?? ''} ${empty?.text ?? ''}`
    assert.match(words, /council of models/)
    assert.match(words, /local-only/)
    assert.match(words, /Dry run is on until you turn it off/)
    await view.press({ role: 'button', text: `Try: ${EXAMPLE_PROMPT}` })
    assert.equal(view.valueOf({ label: 'What should the council do?' }), EXAMPLE_PROMPT)
    assert.equal(view.valueOf({ label: 'Mode' }), 'audit')
    assert.equal(runButton(view)?.disabled, false)
  })

  test('a running audit: status, stage trail in the loop\'s words, iteration, findings, elapsed', async () => {
    const { h } = host({ flows: [flow({})] })
    view = await mount(panel, { host: h })
    assert.ok(view.find({ type: 'Badge', text: 'Running' }))
    assert.ok(view.find({ type: 'Badge', text: 'dry run' }))
    assert.ok(view.find({ type: 'Text', text: 'context' }))
    assert.equal(view.find({ type: 'Text', text: 'red & blue' })?.props.tone, 'accent')
    assert.ok(view.find({ type: 'Text', text: 'Codex review' }))
    assert.ok(view.find({ type: 'Text', text: 'iteration 1/3 · 2 findings, 1 open' }))
    assert.ok(view.find({ type: 'RelativeTime' }))
    assert.ok(view.find({ role: 'button', text: 'Open terminal' }))
    assert.ok(!view.find({ type: 'Callout', text: /Waiting for your approve/ }))
  })

  test('waiting for approve is loud, comes first, and its button only shows the terminal', async () => {
    const { h, calls, of } = host({ flows: [waitingFlow(), flow({})] })
    view = await mount(panel, { host: h })
    const boxes = view.findAll({ type: 'Box' }).filter((b) => /20261123-/.test(b.text))
    assert.equal(boxes[0].props.border, 'warning')
    assert.match(boxes[0].text, /Waiting for approve/)
    const callout = view.find({ type: 'Callout', text: /Waiting for your approve/ })
    assert.equal(callout?.props.tone, 'warning')
    assert.equal(callout?.props.icon, 'bell')
    assert.match(callout?.text ?? '', /type approve in the run's terminal yourself/)
    assert.match(callout?.text ?? '', /The plugin never answers the gate/)
    const before = calls.length
    await view.press({ role: 'button', text: 'Jump to terminal' })
    assert.deepEqual(calls.slice(before).map((c) => c.name), ['cf.focus'])
    assert.deepEqual(of('cf.focus'), [{ terminalId: 'term-3' }])
  })

  test('the panel has no control that answers a gate', async () => {
    const { h, calls } = host({ flows: [waitingFlow(), flow({ mode: 'code', state: { mode: 'code', stages: { gate: { status: 'running', startedAt: iso(1) } } } })] })
    view = await mount(panel, { host: h })
    for (const b of view.findAll({ role: 'button' })) noMatch(b.text, /^\s*(approve|yes|y)\s*$/i, `a button labelled ${b.text}`)
    for (const field of view.findAll({ type: 'Textarea' }).concat(view.findAll({ type: 'Input' }))) noMatch(String(field.props.value ?? ''), /approve/i)
    for (const b of view.findAll({ role: 'button', text: /Jump to terminal|Open terminal/ })) await view.press(b)
    for (const c of calls) assert.ok(['cf.context', 'cf.workflows', 'cf.focus'].includes(c.name), `unexpected ${c.name}`)
    noMatch(JSON.stringify(calls.filter((c) => c.name === 'cf.focus')), /approve/i)
  })

  test('without the workspace:write grant, jumping is off and Setup says why', async () => {
    const { h, of } = host({ ctx: context({ canFocus: false }), flows: [waitingFlow()] })
    view = await mount(panel, { host: h })
    assert.equal(view.find({ role: 'button', text: 'Jump to terminal' })?.disabled, true)
    assert.deepEqual(of('cf.focus'), [])
    await view.press({ label: 'Setup and doctor' })
    assert.ok(view.find({ type: 'Callout', text: /Jump to terminal is off.*workspace:write/ }))
  })

  test('done, failed and interrupted runs; resume; summary and findings open in the panel', async () => {
    const long = `# Findings\n\n${'line of findings\n'.repeat(1000)}`
    const done = flow({ runId: '20261122-100000-dddddddd', live: false, title: 'Review uploads', terminal: { id: 'term-5', title: 't', workspaceName: 'api', alive: false }, state: { mode: 'audit', config: { rounds: 3 }, stages: { tests: { status: 'done', startedAt: iso(70), endedAt: iso(69) } }, auditLoop: { ledger: [{ status: 'fixed' }, { status: 'fixed' }, { status: 'open' }] }, outcome: { status: 'committed-local' } } })
    const stopped = flow({ runId: '20261121-100000-eeeeeeee', live: false, repo: WEB, repoName: 'web', mode: 'code', title: 'Refactor the store', terminal: null, state: { mode: 'code', stages: { implement: { status: 'running', startedAt: iso(300) } } } })
    const { h, of } = host({ flows: [done, stopped], artifact: long })
    view = await mount(panel, { host: h })
    assert.ok(view.find({ type: 'Badge', text: 'Done' }))
    assert.ok(view.find({ type: 'Text', text: '3 findings, 1 open · committed locally' }))
    assert.ok(view.find({ type: 'Badge', text: 'Interrupted' }))
    assert.ok(!view.find({ role: 'button', text: 'Open terminal' }), 'a closed terminal is not offered')
    const resume = view.find({ role: 'button', text: 'Resume (dry run)' })
    assert.ok(resume)
    await view.press(resume!)
    assert.deepEqual(of('cf.resume'), [{ workspaceId: 'identity:web', repo: WEB, runId: '20261121-100000-eeeeeeee' }])

    const [findingsButton] = view.findAll({ role: 'button', text: 'Findings' })
    await view.press(findingsButton)
    assert.deepEqual(of('cf.artifact'), [{ repo: REPO, runId: '20261122-100000-dddddddd', name: 'findings.md' }])
    const pages = Math.ceil(long.length / panel.PAGE)
    assert.ok(view.find({ type: 'Badge', text: `1/${pages}` }))
    await view.press({ label: 'Next page' })
    assert.ok(view.find({ type: 'Badge', text: `2/${pages}` }))
    for (const md of view.findAll({ type: 'Markdown' })) assert.ok(String(md.props.content).length <= panel.PAGE)
    await view.press({ label: 'Close file' })
    assert.ok(!view.find({ type: 'Markdown' }))
  })

  test('live: a worker post or a terminal change re-reads the list, no polling', async () => {
    const { h, of, setFlows } = host()
    view = await mount(panel, { host: h })
    const first = of('cf.workflows').length
    assert.ok(view.find({ type: 'EmptyState', label: 'No workflows yet' }))
    setFlows([flow({})])
    await view.post('cf.workflows.changed', { repos: [REPO] })
    assert.equal(of('cf.workflows').length, first + 1)
    assert.ok(view.find({ type: 'Badge', text: 'Running' }))
    setFlows([waitingFlow()])
    await view.emit('workspace.changed', { context: { workspaceId: 'identity:api', branch: 'main', displayName: 'api', terminals: [] } })
    assert.ok(of('cf.context').length >= 2)
    assert.ok(view.find({ type: 'Callout', text: /Waiting for your approve/ }))
    await view.post('cf.started', { kind: 'audit', runId: 'x', repo: REPO, workspaceId: 'identity:api', workspaceName: 'api', terminalId: 't', title: 't', line: 'l', at: 0 })
    assert.ok(of('cf.workflows').length >= first + 3)
  })
})

describe('setup and empty states', () => {
  test('the gear opens Setup: council-flow path and doctor', async () => {
    const { h, of } = host()
    view = await mount(panel, { host: h })
    assert.ok(!view.find({ role: 'button', text: 'Run doctor' }), 'not on the home screen')
    await view.press({ label: 'Setup and doctor' })
    assert.ok(view.find({ type: 'Heading', text: 'Setup' }))
    assert.ok(view.find({ type: 'Code', text: CLI }))
    await view.press({ role: 'button', text: 'Run doctor' })
    assert.deepEqual(of('cf.start'), [{ kind: 'doctor', workspaceId: 'identity:api', repo: REPO }])
    await view.press({ role: 'button', text: 'Done' })
    assert.ok(view.find({ type: 'Textarea', label: 'What should the council do?' }))
  })

  test('no council-flow found: says so, blocks Run, and Setup fixes it', async () => {
    const { h, of } = host({ ctx: context({ cli: { ok: false, error: 'council-flow not found next to the plugin: set its checkout folder under Setup', configured: null } }) })
    view = await mount(panel, { host: h })
    assert.ok(view.find({ type: 'Callout', text: /council-flow not found/ }))
    await view.type({ label: 'What should the council do?' }, 'Review auth')
    assert.equal(runButton(view)?.disabled, true)
    await view.press({ role: 'button', text: 'Open setup' })
    await view.type({ label: 'council-flow checkout' }, '/home/me/council-flow')
    await view.press({ role: 'button', text: 'Use this checkout' })
    assert.deepEqual(of('cf.setCli'), [{ path: '/home/me/council-flow' }])
    await view.press({ role: 'button', text: 'Done' })
    assert.equal(runButton(view)?.disabled, false)
  })

  test('no Git workspace', async () => {
    const { h } = host({ ctx: context({ workspaces: [], focusedId: null }) })
    view = await mount(panel, { host: h })
    assert.ok(view.find({ type: 'EmptyState', label: 'No Git workspace' }))
  })
})

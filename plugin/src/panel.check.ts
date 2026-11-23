// `orca plugin check .` (and `orca plugin shot . --scenario <name>`) render the panel once per
// scenario. The worker's answers are stubbed with `requests` (it reads the file system, which a
// check should not depend on); the worker itself is still mounted, so check also proves it
// activates. Each workflow's progress comes from a run.json-shaped state through the real
// progressOf, so these show exactly what the worker would derive.
import { defineCheck } from 'orca/testing'
import { progressOf, type Liveness, type RunState } from './progress'
import type { ContextInfo, Workflow, WorkflowsAnswer } from './protocol'

const REPO = '/home/me/code/api'
const NOW = Date.now()
const ago = (minutes: number) => NOW - minutes * 60_000
const iso = (minutes: number) => new Date(ago(minutes)).toISOString()

const ctx = (over: Partial<ContextInfo> = {}): ContextInfo => ({
  workspaces: [
    { id: 'identity:api', name: 'api', project: 'api', path: REPO, branch: 'main', hostId: 'local', usable: true, reason: null },
    { id: 'identity:web', name: 'web', project: 'web', path: '/home/me/code/web', branch: 'main', hostId: 'local', usable: true, reason: null },
    { id: 'folder:notes', name: 'notes', project: null, path: '/home/me/notes', branch: null, hostId: null, usable: false, reason: 'a folder workspace, not a Git checkout' }
  ],
  focusedId: 'identity:api',
  cli: { ok: true, path: '/home/me/council-flow/bin/council-flow.mjs', version: '0.2.0', source: 'bundled' },
  canStart: true,
  canFocus: true,
  ...over
})

const stage = (startedMin: number, endedMin: number | null, status = endedMin === null ? 'running' : 'done') => ({
  status,
  startedAt: iso(startedMin),
  ...(endedMin === null ? {} : { endedAt: iso(endedMin) })
})

type Card = {
  runId: string
  mode: 'audit' | 'code'
  title: string
  state: RunState
  lock?: Liveness
  lockAt?: number
  summaryMtime?: number
  gateMtime?: number
  dryRun?: boolean
  target?: string | null
  terminal?: boolean
  createdMin: number
  updatedMin: number
}

function card(c: Card): Workflow {
  const progress = progressOf({ mode: c.mode, state: c.state, lock: c.lock ?? 'none', lockAt: c.lockAt ?? null, summaryMtime: c.summaryMtime ?? null, gateMtime: c.gateMtime ?? null })
  return {
    runId: c.runId,
    repo: REPO,
    repoName: 'api',
    mode: c.mode,
    title: c.title,
    dryRun: c.dryRun ?? false,
    target: c.target ?? null,
    createdAt: ago(c.createdMin),
    updatedAt: ago(c.updatedMin),
    since: c.lock === 'alive' ? c.lockAt ?? null : null,
    progress,
    files: { summary: progress.phase !== 'running', findings: c.mode === 'audit', runJson: true },
    resumable: progress.phase === 'interrupted' || progress.phase === 'failed',
    terminal: c.terminal === false ? null : { id: `term-${c.runId}`, title: `council-flow ${c.mode === 'audit' ? 'audit ' : ''}${c.runId}`, workspaceName: 'api', alive: progress.phase !== 'done' }
  }
}

const ledger = (statuses: string[]) => statuses.map((status, i) => ({ id: `F-${i + 1}`, status }))

const runningAudit = card({
  runId: '20261123-101500-1a2b3c4d',
  mode: 'audit',
  title: 'Review authorization in the request handler',
  target: 'src/handler.js',
  lock: 'alive',
  lockAt: ago(14),
  createdMin: 14,
  updatedMin: 0,
  state: {
    mode: 'audit',
    config: { rounds: 3 },
    stages: { 'context-1': stage(14, 12), 'teams-1': stage(12, 8), 'review-1': stage(8, 6), 'context-2': stage(6, 5), 'teams-2': stage(5, null) },
    auditLoop: { iterations: [{ number: 1 }, { number: 2 }], ledger: ledger(['fixed', 'open', 'confirmed']) }
  }
})

const runningCode = card({
  runId: '20261123-100200-5e6f7a8b',
  mode: 'code',
  title: 'Add a /health endpoint with a test',
  lock: 'alive',
  lockAt: ago(25),
  createdMin: 25,
  updatedMin: 1,
  dryRun: true,
  state: {
    mode: 'code',
    config: { rounds: 2 },
    stages: { plan: stage(25, 20), implement: stage(20, 9), 'review-1': stage(9, 6), 'fix-1': stage(6, null) },
    loop: { n: 1, fixRounds: 0, findings: [{ severity: 'major' }, { severity: 'minor' }] }
  }
})

const waitingAudit = card({
  runId: '20261123-093000-9c0d1e2f',
  mode: 'audit',
  title: 'Review request parsing and its trust boundaries',
  target: 'localhost:3000',
  lock: 'alive',
  lockAt: ago(40),
  summaryMtime: ago(3),
  createdMin: 40,
  updatedMin: 3,
  state: {
    mode: 'audit',
    config: { rounds: 2 },
    stages: { 'context-1': stage(40, 37), 'teams-1': stage(37, 25), 'review-1': stage(25, 20), 'context-2': stage(20, 18), 'teams-2': stage(18, 9), 'review-2': stage(9, 6), tests: stage(6, 4) },
    auditLoop: { iterations: [{ number: 1 }, { number: 2 }], ledger: ledger(['fixed', 'fixed', 'rejected', 'open']) }
  }
})

const doneAudit = card({
  runId: '20261122-161000-3a4b5c6d',
  mode: 'audit',
  title: 'Review file uploads for path traversal',
  target: 'src/uploads',
  createdMin: 900,
  updatedMin: 868,
  state: {
    mode: 'audit',
    config: { rounds: 3 },
    stages: { 'context-1': stage(900, 897), 'teams-1': stage(897, 885), 'review-1': stage(885, 880), tests: stage(872, 870) },
    auditLoop: { iterations: [{ number: 1 }], ledger: ledger(['fixed', 'fixed', 'rejected', 'fixed', 'open']) },
    outcome: { status: 'committed-local', unresolved: 1 }
  }
})

const dryDone = card({
  runId: '20261122-120000-7e8f9a0b',
  mode: 'audit',
  title: 'Review authorization in the request handler',
  dryRun: true,
  createdMin: 1200,
  updatedMin: 1199,
  state: {
    mode: 'audit',
    config: { rounds: 1 },
    stages: { 'context-1': stage(1200, 1200), 'teams-1': stage(1200, 1200), 'review-1': stage(1200, 1199), tests: stage(1199, 1199) },
    auditLoop: { iterations: [{ number: 1 }], ledger: ledger(['open', 'confirmed']) },
    outcome: { status: 'declined', unresolved: 2 }
  }
})

const interruptedCode = card({
  runId: '20261121-090000-1f2e3d4c',
  mode: 'code',
  title: 'Refactor the session store',
  createdMin: 2900,
  updatedMin: 2880,
  terminal: false,
  state: { mode: 'code', config: { rounds: 2 }, stages: { plan: stage(2900, 2895), implement: stage(2895, null) } }
})

const flows = (workflows: Workflow[]): WorkflowsAnswer => ({ repos: [REPO], workflows, errors: [], truncated: false })

export default defineCheck({
  empty: {
    requests: { 'cf.context': ctx(), 'cf.workflows': flows([]) }
  },
  running: {
    requests: { 'cf.context': ctx(), 'cf.workflows': flows([runningAudit, runningCode, doneAudit]) },
    persisted: { plugin: { prompt: 'Add rate limiting to the login endpoint' } }
  },
  'waiting-approve': {
    requests: { 'cf.context': ctx(), 'cf.workflows': flows([waitingAudit, runningCode, doneAudit]) }
  },
  done: {
    requests: { 'cf.context': ctx(), 'cf.workflows': flows([doneAudit, dryDone, interruptedCode]) }
  },
  'public-target-refused': {
    requests: { 'cf.context': ctx(), 'cf.workflows': flows([]) },
    persisted: { plugin: { prompt: 'Review the login flow', options: { auditRounds: '', codeRounds: '', target: 'prod.example.com:443', testTarget: '', refreshContext: false, implementer: '' } } }
  },
  'no-focus-grant': {
    requests: { 'cf.context': ctx({ canFocus: false }), 'cf.workflows': flows([waitingAudit]) }
  },
  'cli-missing': {
    requests: { 'cf.context': ctx({ cli: { ok: false, error: 'council-flow not found next to the plugin: set its checkout folder under Setup', configured: null } }), 'cf.workflows': flows([]) }
  },
  'no-git-workspace': {
    requests: { 'cf.context': ctx({ workspaces: [], focusedId: null }), 'cf.workflows': flows([]) }
  }
})

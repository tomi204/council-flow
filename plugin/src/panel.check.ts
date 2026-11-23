// `orca plugin check .` renders the panel once per scenario. The worker's answers are stubbed with
// `requests` (they read the file system, which a check should not depend on); the worker itself is
// still mounted, so check also proves it activates.
import { defineCheck } from 'orca/testing'
import type { ContextInfo, RunRow, RunsAnswer } from './protocol'

const REPO = '/home/me/code/api'

const ctx = (over: Partial<ContextInfo> = {}): ContextInfo => ({
  workspaces: [
    { id: 'identity:api', name: 'api', project: 'api', path: REPO, branch: 'main', hostId: 'local', usable: true, reason: null },
    { id: 'folder:notes', name: 'notes', project: null, path: '/home/me/notes', branch: null, hostId: null, usable: false, reason: 'a folder workspace, not a Git checkout' }
  ],
  focusedId: 'identity:api',
  cli: { ok: true, path: '/home/me/council-flow/bin/council-flow.mjs', version: '0.2.0', source: 'bundled' },
  canStart: true,
  ...over
})

const run = (over: Partial<RunRow>): RunRow => ({
  runId: '20261120-100000-aaaaaaaa',
  mode: 'audit',
  status: 'declined',
  tone: 'warning',
  title: 'Review authorization in the file reader',
  createdAt: Date.UTC(2026, 10, 20, 10),
  updatedAt: Date.UTC(2026, 10, 20, 11),
  dryRun: false,
  target: 'src/reader.js',
  stopReason: 'max-rounds',
  unresolved: 2,
  running: false,
  resumable: true,
  files: { summary: true, findings: true, runJson: true },
  ...over
})

const runs = (list: RunRow[]): RunsAnswer => ({ repo: REPO, runs: list, truncated: false, started: [] })

export default defineCheck({
  audit: {
    requests: { 'cf.context': ctx(), 'cf.runs': runs([]) },
    persisted: { plugin: { tab: 'audit', auditForm: { scope: 'Review request parsing and its trust boundaries', target: 'localhost:3000', testTarget: '', rounds: '1', dryRun: true, refreshContext: false } } }
  },
  'audit-public-target-refused': {
    requests: { 'cf.context': ctx(), 'cf.runs': runs([]) },
    persisted: { plugin: { tab: 'audit', auditForm: { scope: 'x', target: 'prod.example.com:443', testTarget: '', rounds: '', dryRun: false, refreshContext: false } } }
  },
  code: {
    requests: { 'cf.context': ctx(), 'cf.runs': runs([]) },
    persisted: { plugin: { tab: 'code', codeForm: { task: 'Add a /health endpoint with a test', implementer: 'codex', rounds: '2', dryRun: false } } }
  },
  runs: {
    requests: {
      'cf.context': ctx(),
      'cf.runs': runs([
        run({ runId: '20261122-090000-bbbbbbbb', mode: 'code', status: 'running', tone: 'accent', title: 'Add a /health endpoint', target: null, running: true, resumable: false, stopReason: null, unresolved: null }),
        run({}),
        run({ runId: '20261119-080000-cccccccc', status: 'interrupted', dryRun: true, unresolved: null, stopReason: null })
      ])
    },
    persisted: { plugin: { tab: 'runs' } }
  },
  'cli-missing': {
    requests: { 'cf.context': ctx({ cli: { ok: false, error: 'council-flow not found next to the plugin: set its checkout folder under Setup', configured: null } }), 'cf.runs': runs([]) }
  },
  'no-git-workspace': {
    requests: { 'cf.context': ctx({ workspaces: [], focusedId: null }), 'cf.runs': runs([]) }
  }
})

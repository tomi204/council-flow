// The plugin's worker: Node code Orca runs on the Orca host (`trusted-worker`).
//
// What it does, and all it does:
// - lists Orca workspaces and their terminals (workspace:read) and reads run folders under
//   <repo>/.council-flow with node:fs (read-only, see runs.ts);
// - starts council-flow by opening ONE new Orca terminal per run with terminal.create
//   (terminal:send). That terminal is an Orca terminal, so ORCA_TERMINAL_HANDLE is set inside it
//   and council-flow's Orca orchestration works. The command line comes from command.ts;
// - shows and focuses a terminal it opened when the person asks (terminal.focus, workspace:write);
// - keeps the Workflows list and its status bar item current: fs.watch on run folders (watch.ts),
//   and, only while a run is live, a re-check every LIVE_POLL_MS for a process that died without
//   writing anything. A plugin with a status bar item keeps its worker running; Orca documents that
//   such a worker may poll;
// - remembers the last settings per repository and what it started (storage:own).
//
// What it never does: type into a terminal (no terminal.sendText, so it can never answer
// council-flow's "approve" gate or any other prompt), read the environment (no LYBER_API_KEY or any
// other variable), call a model, or touch the network.
import * as path from 'node:path'
import type { OrcaWorkerApi } from 'orca/worker'
import { buildAudit, buildCode, buildDoctor, buildResume, newRunId, terminalTitle, type AuditForm, type BuildResult, type CodeForm, type Implementer } from './command'
import { checkRepo, listRuns, readArtifact, readRun, type RunRow } from './runs'
import { inspectCli, resolveCli, type CliInfo } from './cli'
import { phaseRank, type Phase, type Progress } from './progress'
import { scrubForDisplay } from './redact'
import { RunWatcher } from './watch'
import type { ArtifactResult, ContextInfo, FocusResult, StartKind, StartResult, StartedRecord, Workflow, WorkflowsAnswer, WorkspaceRow } from './protocol'

export const STORAGE = { started: 'started', last: 'last', cliPath: 'cliPath' } as const
export const STATUS_ITEM = 'council-flow-status'
const MAX_STARTED = 50
const MAX_LAST_REPOS = 20
const RUNS_PER_REPO = 30
export const MAX_FINISHED = 12
const MAX_OTHER_REPOS = 5
const MAX_PANEL_REPOS = 4
const STARTED_REPO_MS = 7 * 24 * 3600_000
const PENDING_MS = 24 * 3600_000
const TERMINAL_CACHE_MS = 5000
/** A run the plugin started that council-flow has not created yet reads "Starting" this long. */
export const START_GRACE_MS = 2 * 60_000
/** While a run is live: re-check this often, so a process that died without writing is noticed. */
export const LIVE_POLL_MS = 15_000
export const LIVE: ReadonlySet<Phase> = new Set(['starting', 'running', 'waiting-approve', 'publishing'])

type Last = Record<string, { audit?: AuditForm; code?: CodeForm }>

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const fail = (error: string): StartResult => ({ ok: false, error })
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)
const unref = (t: unknown) => (t as { unref?: () => void } | null)?.unref?.()
const unique = (list: string[]) => [...new Set(list)]
const firstLine = (s: string) => {
  const line = scrubForDisplay((s.split(/\r?\n/).find((l) => l.trim()) ?? '').trim())
  return line.length > 160 ? `${line.slice(0, 157)}...` : line
}

/** Untrusted JSON -> an audit form with only the known fields. */
export function auditForm(v: unknown): AuditForm {
  const o = isObject(v) ? v : {}
  return {
    scope: str(o.scope),
    target: str(o.target),
    testTarget: str(o.testTarget),
    rounds: str(o.rounds),
    dryRun: o.dryRun === true,
    refreshContext: o.refreshContext === true
  }
}

/** Untrusted JSON -> a coding form with only the known fields. */
export function codeForm(v: unknown): CodeForm {
  const o = isObject(v) ? v : {}
  const impl = str(o.implementer)
  return { task: str(o.task), implementer: (['codex', 'claude'].includes(impl) ? impl : '') as Implementer, rounds: str(o.rounds), dryRun: o.dryRun === true }
}

async function storedCliPath(orca: OrcaWorkerApi): Promise<string | null> {
  const v = await orca.storage.get(STORAGE.cliPath)
  return typeof v === 'string' && v ? v : null
}

async function cliInfo(orca: OrcaWorkerApi): Promise<CliInfo> {
  return resolveCli(await storedCliPath(orca))
}

async function readStarted(orca: OrcaWorkerApi): Promise<StartedRecord[]> {
  const raw = await orca.storage.get(STORAGE.started)
  return (Array.isArray(raw) ? (raw as StartedRecord[]) : []).filter((r) => isObject(r) && typeof r.repo === 'string' && typeof r.terminalId === 'string')
}

/** Focusing a terminal needs `terminal.focus` (host API 1.7) and the workspace:write grant. */
export const canFocus = (orca: OrcaWorkerApi) => orca.grantedCapabilities.includes('workspace:write') && orca.host.has('terminal.focus')

/** Workspaces from Orca. Usable: a Git checkout on this host, not an SSH or WSL workspace. */
async function workspaceRows(orca: OrcaWorkerApi): Promise<WorkspaceRow[]> {
  const { workspaces } = await orca.host.call('workspace.list', {})
  return workspaces.map((w) => {
    const row: WorkspaceRow = {
      id: w.id,
      name: w.name,
      project: w.project ?? null,
      path: w.path,
      branch: w.branch,
      hostId: w.hostId,
      usable: false,
      reason: null
    }
    if (w.kind !== 'worktree') row.reason = 'a folder workspace, not a Git checkout'
    else if (w.hostId && /^(ssh|wsl)[:-]/i.test(w.hostId)) row.reason = `on ${w.hostId}: the plugin reads run folders on its own Orca host only`
    else {
      try {
        checkRepo(w.path)
        row.usable = true
      } catch (e) {
        row.reason = message(e)
      }
    }
    return row
  })
}

async function focusedId(orca: OrcaWorkerApi, rows: WorkspaceRow[]): Promise<string | null> {
  const ctx = await orca.host.call('workspace.readContext', {})
  if (!ctx) return null
  if (ctx.workspaceId && rows.some((r) => r.id === ctx.workspaceId)) return ctx.workspaceId
  const byName = rows.filter((r) => r.name === ctx.displayName && (r.branch ?? '') === (ctx.branch ?? ''))
  return byName.length === 1 ? byName[0].id : null
}

// ---- the live Workflows list

type RepoRuns = { repo: string; workflows: Workflow[]; error: string | null; truncated: boolean }

const workflowTime = (w: Workflow) => w.since ?? w.updatedAt ?? w.createdAt ?? 0

/** Waiting for approve first, then live runs, then the rest; newest first within each. */
export function sortWorkflows(list: Workflow[]): Workflow[] {
  return [...list].sort((a, b) => phaseRank(a.progress.phase) - phaseRank(b.progress.phase) || workflowTime(b) - workflowTime(a) || (a.runId < b.runId ? 1 : -1))
}

function pendingProgress(record: StartedRecord, now: number): Progress {
  const fresh = now - record.at < START_GRACE_MS
  return {
    phase: fresh ? 'starting' : 'failed',
    label: fresh ? 'Starting' : 'Did not start',
    tone: fresh ? 'accent' : 'danger',
    stage: fresh ? 'opening the terminal' : null,
    stageStartedAt: record.at,
    steps: [],
    round: null,
    findings: null,
    open: null,
    outcome: fresh ? null : 'council-flow did not create this run: its terminal says why'
  }
}

class Live {
  private readonly watcher: RunWatcher
  private panelRepos: string[] = []
  private signatures = new Map<string, string>()
  private terminalCache = new Map<string, { at: number; ids: Set<string> | null; truncated: boolean }>()
  private poll: ReturnType<typeof setTimeout> | null = null
  private inflight: Promise<Map<string, RepoRuns>> | null = null
  private again = false
  private statusKey: string | null = null
  disposed = false

  constructor(private readonly orca: OrcaWorkerApi) {
    this.watcher = new RunWatcher(() => void this.refresh().catch((e) => this.orca.log(`refresh failed: ${message(e)}`)))
  }

  private startedRepos(started: StartedRecord[], now: number): string[] {
    return unique(started.filter((s) => now - (s.at ?? 0) < STARTED_REPO_MS).map((s) => s.repo)).slice(0, MAX_OTHER_REPOS + 1)
  }

  private async terminalAlive(workspaceId: string, terminalId: string): Promise<boolean | null> {
    if (!this.orca.host.has('terminal.list')) return null
    let hit = this.terminalCache.get(workspaceId)
    if (!hit || Date.now() - hit.at > TERMINAL_CACHE_MS) {
      try {
        const { terminals, truncated } = await this.orca.host.call('terminal.list', { workspaceId })
        hit = { at: Date.now(), ids: new Set(terminals.map((t) => t.id)), truncated }
      } catch {
        hit = { at: Date.now(), ids: null, truncated: false }
      }
      this.terminalCache.set(workspaceId, hit)
    }
    if (!hit.ids) return null
    return hit.ids.has(terminalId) ? true : hit.truncated ? null : false
  }

  private async terminalOf(record: StartedRecord | null): Promise<Workflow['terminal']> {
    if (!record) return null
    return { id: record.terminalId, title: record.title, workspaceName: record.workspaceName, alive: await this.terminalAlive(record.workspaceId, record.terminalId) }
  }

  private async toWorkflow(repo: string, r: RunRow, record: StartedRecord | null): Promise<Workflow> {
    return {
      runId: r.runId,
      repo,
      repoName: path.basename(repo),
      mode: r.mode,
      title: r.title,
      dryRun: r.dryRun,
      target: r.target,
      createdAt: r.createdAt,
      updatedAt: r.updatedAt,
      since: r.since,
      progress: r.progress,
      files: r.files,
      resumable: r.resumable && (r.progress.phase === 'interrupted' || r.progress.phase === 'failed'),
      terminal: await this.terminalOf(record)
    }
  }

  private async repoRuns(repo: string, started: StartedRecord[], now: number): Promise<RepoRuns> {
    let res
    try {
      res = listRuns(repo, RUNS_PER_REPO)
    } catch (e) {
      return { repo, workflows: [], error: message(e), truncated: false }
    }
    const records = new Map<string, StartedRecord>()
    for (const s of started) if (s.runId && s.repo === res.repo && !records.has(s.runId)) records.set(s.runId, s)
    const workflows: Workflow[] = []
    for (const r of res.runs) workflows.push(await this.toWorkflow(res.repo, r, records.get(r.runId) ?? null))
    for (const s of records.values()) {
      if ((s.kind !== 'audit' && s.kind !== 'code') || !s.runId || now - s.at > PENDING_MS || res.runs.some((r) => r.runId === s.runId)) continue
      let exists = false
      try {
        exists = readRun(res.repo, s.runId) !== null
      } catch {
        exists = true
      }
      if (exists) continue // an older run, outside the newest RUNS_PER_REPO
      workflows.push({
        runId: s.runId,
        repo: res.repo,
        repoName: path.basename(res.repo),
        mode: s.kind,
        title: s.prompt ?? '',
        dryRun: / --dry-run( |$)/.test(s.line),
        target: null,
        createdAt: s.at,
        updatedAt: s.at,
        since: null,
        progress: pendingProgress(s, now),
        files: { summary: false, findings: false, runJson: false },
        resumable: false,
        terminal: await this.terminalOf(s)
      })
    }
    return { repo: res.repo, workflows, error: null, truncated: res.truncated }
  }

  private async compute(): Promise<Map<string, RepoRuns>> {
    const started = await readStarted(this.orca)
    const now = Date.now()
    const repos = unique([...this.panelRepos, ...this.startedRepos(started, now)])
    const out = new Map<string, RepoRuns>()
    for (const repo of repos) {
      if (this.disposed) return out
      const r = await this.repoRuns(repo, started, now)
      out.set(repo, r)
    }
    if (this.disposed) return out
    this.watcher.retain(repos)
    for (const [repo, r] of out) {
      if (r.error) continue
      const live = r.workflows.filter((w) => LIVE.has(w.progress.phase) || (w.terminal && now - (w.createdAt ?? 0) < START_GRACE_MS)).map((w) => w.runId)
      this.watcher.sync(repo, live)
    }
    const changed: string[] = []
    for (const [repo, r] of out) {
      const sig = JSON.stringify([r.error, r.workflows.map((w) => [w.runId, w.progress, w.updatedAt, w.files, w.terminal?.alive ?? null, w.resumable])])
      const prev = this.signatures.get(repo)
      if (prev !== sig) {
        this.signatures.set(repo, sig)
        // The first read of a repository is answered directly (or posted as cf.started): no change to announce.
        if (prev !== undefined) changed.push(repo)
      }
    }
    if (changed.length) this.orca.panels.post('cf.workflows.changed', { repos: changed })
    await this.status(out)
    this.schedule(out)
    return out
  }

  /** Re-reads every watched repository; concurrent calls share one pass (and one more if asked meanwhile). */
  refresh(): Promise<Map<string, RepoRuns>> {
    if (this.inflight) {
      this.again = true
      return this.inflight
    }
    const run = async () => {
      let out = new Map<string, RepoRuns>()
      do {
        this.again = false
        out = await this.compute()
      } while (this.again && !this.disposed)
      return out
    }
    this.inflight = run().finally(() => {
      this.inflight = null
    })
    return this.inflight
  }

  private schedule(out: Map<string, RepoRuns>): void {
    if (this.poll) clearTimeout(this.poll)
    this.poll = null
    const live = [...out.values()].some((r) => r.workflows.some((w) => LIVE.has(w.progress.phase)))
    if (!live || this.disposed) return
    this.poll = setTimeout(() => {
      this.poll = null
      void this.refresh().catch((e) => this.orca.log(`refresh failed: ${message(e)}`))
    }, LIVE_POLL_MS)
    unref(this.poll)
  }

  private async status(out: Map<string, RepoRuns>): Promise<void> {
    const all = sortWorkflows([...out.values()].flatMap((r) => r.workflows))
    const waiting = all.filter((w) => w.progress.phase === 'waiting-approve')
    const live = all.filter((w) => LIVE.has(w.progress.phase))
    const cut = (s: string) => (s.length > 60 ? `${s.slice(0, 57)}...` : s)
    let update: { id: string; text?: string; icon?: 'bell' | 'activity'; tone?: 'warning' | 'accent'; tooltip?: string; visible: boolean }
    if (waiting.length) {
      update = {
        id: STATUS_ITEM,
        text: waiting.length > 1 ? `Council Flow: ${waiting.length} waiting for approve` : 'Council Flow: waiting for approve',
        icon: 'bell',
        tone: 'warning',
        tooltip: `"${cut(waiting[0].title || waiting[0].runId)}" is waiting for your approve. Type approve in its terminal yourself; click to jump there.`,
        visible: true
      }
    } else if (live.length) {
      update = {
        id: STATUS_ITEM,
        text: `Council Flow: ${live.length} running`,
        icon: 'activity',
        tone: 'accent',
        tooltip: `${cut(live[0].title || live[0].runId)}: ${live[0].progress.stage ?? live[0].progress.label}`,
        visible: true
      }
    } else update = { id: STATUS_ITEM, visible: false }
    const key = JSON.stringify(update)
    if (key === this.statusKey || !this.orca.host.has('statusBar.update')) return
    this.statusKey = key
    try {
      await this.orca.host.call('statusBar.update', update)
    } catch (e) {
      // Desktop app only: a windowless Orca has no status bar.
      this.orca.log(`status bar: ${message(e)}`)
    }
  }

  /** The panel's view: `repo` first, then the other repositories this plugin started runs in. */
  async answer(repoInput: unknown): Promise<WorkflowsAnswer> {
    let asked: string | null = null
    let askedError: string | null = null
    try {
      asked = checkRepo(repoInput)
    } catch (e) {
      askedError = message(e)
    }
    if (asked) this.panelRepos = [asked, ...this.panelRepos.filter((r) => r !== asked)].slice(0, MAX_PANEL_REPOS)
    this.terminalCache.clear()
    const out = await this.refresh()
    const started = await readStarted(this.orca)
    const others = this.startedRepos(started, Date.now()).filter((r) => r !== asked).slice(0, MAX_OTHER_REPOS)
    const repos = asked ? [asked, ...others] : others
    const errors: WorkflowsAnswer['errors'] = askedError ? [{ repo: str(repoInput), error: askedError }] : []
    let truncated = false
    const all: Workflow[] = []
    for (const repo of repos) {
      const r = out.get(repo)
      if (!r) continue
      if (r.error) {
        if (repo === asked) errors.push({ repo, error: r.error })
        continue
      }
      truncated ||= r.truncated
      all.push(...r.workflows)
    }
    const sorted = sortWorkflows(all)
    const live = sorted.filter((w) => LIVE.has(w.progress.phase) || w.progress.phase === 'elsewhere')
    const finished = sorted.filter((w) => !live.includes(w))
    if (finished.length > MAX_FINISHED) truncated = true
    return { repos, workflows: [...live, ...finished.slice(0, MAX_FINISHED)], errors, truncated }
  }

  async all(): Promise<Workflow[]> {
    return sortWorkflows([...(await this.refresh()).values()].flatMap((r) => r.workflows))
  }

  dispose(): void {
    this.disposed = true
    this.watcher.dispose()
    if (this.poll) clearTimeout(this.poll)
    this.poll = null
  }
}

let live: Live | null = null

// ---- starting runs

async function remember(orca: OrcaWorkerApi, record: StartedRecord, forms: { audit?: AuditForm; code?: CodeForm }): Promise<void> {
  const prev = await readStarted(orca)
  await orca.storage.set(STORAGE.started, [record, ...prev].slice(0, MAX_STARTED))
  if (forms.audit || forms.code) {
    const raw = await orca.storage.get(STORAGE.last)
    const last: Last = isObject(raw) ? (raw as Last) : {}
    const entry = { ...(last[record.repo] ?? {}), ...forms }
    const others = Object.entries(last).filter(([repo]) => repo !== record.repo).slice(0, MAX_LAST_REPOS - 1)
    await orca.storage.set(STORAGE.last, Object.fromEntries([[record.repo, entry], ...others]))
  }
}

async function launch(
  orca: OrcaWorkerApi,
  ws: WorkspaceRow,
  repo: string,
  kind: StartedRecord['kind'],
  built: BuildResult,
  forms: { audit?: AuditForm; code?: CodeForm } = {},
  prompt?: string
): Promise<StartResult> {
  if (!built.ok) return fail(built.error)
  if (!orca.host.has('terminal.create')) return fail('this Orca cannot open terminals for plugins (needs host API 1.3)')
  const title = terminalTitle(kind, built.runId)
  let terminalId: string
  try {
    ;({ terminalId } = await orca.host.call('terminal.create', { workspaceId: ws.id, title, command: built.line }))
  } catch (e) {
    const code = (e as { code?: string }).code
    return fail(`Orca could not open a terminal in ${ws.name}${code ? ` (${code})` : ''}: ${message(e)}`)
  }
  const record: StartedRecord = { kind, runId: built.runId, repo, workspaceId: ws.id, workspaceName: ws.name, terminalId, title, line: built.line, at: Date.now(), ...(prompt ? { prompt } : {}) }
  await remember(orca, record, forms)
  orca.panels.post('cf.started', record)
  orca.log(`opened terminal "${title}" in ${ws.name}`)
  if (live && built.runId) await live.refresh().catch((e) => orca.log(`refresh failed: ${message(e)}`))
  return { ok: true, ...record }
}

type Target = { ok: true; ws: WorkspaceRow; repo: string; cli: string } | { ok: false; error: string }

async function target(orca: OrcaWorkerApi, workspaceId: unknown, repo: unknown): Promise<Target> {
  const rows = await workspaceRows(orca)
  const ws = rows.find((r) => r.id === workspaceId)
  if (!ws) return { ok: false, error: 'that workspace is not open in Orca' }
  if (!ws.usable) return { ok: false, error: `${ws.name}: ${ws.reason}` }
  let root: string
  try {
    root = checkRepo(str(repo) || ws.path)
  } catch (e) {
    return { ok: false, error: message(e) }
  }
  const cli = await cliInfo(orca)
  if (!cli.ok) return { ok: false, error: cli.error }
  return { ok: true, ws, repo: root, cli: cli.path }
}

export async function start(orca: OrcaWorkerApi, kind: StartKind, input: { workspaceId?: unknown; repo?: unknown; audit?: unknown; code?: unknown }): Promise<StartResult> {
  const t = await target(orca, input.workspaceId, input.repo)
  if (!t.ok) return fail(t.error)
  if (kind === 'audit') {
    const form = auditForm(input.audit)
    return launch(orca, t.ws, t.repo, 'audit', buildAudit(t.cli, t.repo, form, newRunId()), { audit: form }, firstLine(form.scope))
  }
  if (kind === 'code') {
    const form = codeForm(input.code)
    return launch(orca, t.ws, t.repo, 'code', buildCode(t.cli, t.repo, form, newRunId()), { code: form }, firstLine(form.task))
  }
  if (kind === 'doctor') return launch(orca, t.ws, t.repo, 'doctor', buildDoctor(t.cli, t.repo))
  return fail('unknown kind')
}

export async function resume(orca: OrcaWorkerApi, input: { workspaceId?: unknown; repo?: unknown; runId?: unknown; refreshContext?: unknown }): Promise<StartResult> {
  const t = await target(orca, input.workspaceId, input.repo)
  if (!t.ok) return fail(t.error)
  let row
  try {
    row = readRun(t.repo, input.runId)
  } catch (e) {
    return fail(message(e))
  }
  if (!row) return fail(`no run ${str(input.runId)} in ${t.repo}`)
  if (row.running) return fail(`run ${row.runId} is still running (${row.status})`)
  if (!row.resumable || row.mode === 'unknown') return fail(`run ${row.runId} has no readable run.json to resume from`)
  const built = buildResume(t.cli, t.repo, { mode: row.mode, runId: row.runId, dryRun: row.dryRun, refreshContext: row.mode === 'audit' && input.refreshContext === true })
  return launch(orca, t.ws, t.repo, 'resume', built, {}, row.title || undefined)
}

/** Shows and focuses a terminal this plugin opened. It only moves focus: nothing is typed. */
export async function focusTerminal(orca: OrcaWorkerApi, terminalId: unknown): Promise<FocusResult> {
  if (typeof terminalId !== 'string' || !terminalId) return { ok: false, error: 'no terminal to show' }
  const started = await readStarted(orca)
  if (!started.some((s) => s.terminalId === terminalId)) return { ok: false, error: 'the plugin only shows terminals it opened' }
  if (!canFocus(orca)) {
    return { ok: false, error: 'this Orca has not granted the plugin workspace:write, which showing a terminal needs: re-approve the plugin, or find the terminal by its title' }
  }
  try {
    const { focused } = await orca.host.call('terminal.focus', { terminalId })
    return { ok: true, focused }
  } catch (e) {
    const code = (e as { code?: string }).code
    return { ok: false, error: `Orca could not show that terminal${code ? ` (${code})` : ''}: ${message(e)}` }
  }
}

// ---- palette commands: act on the focused workspace

async function focused(orca: OrcaWorkerApi): Promise<{ ok: true; ws: WorkspaceRow } | { ok: false; error: string }> {
  const rows = await workspaceRows(orca)
  const id = await focusedId(orca, rows)
  const ws = rows.find((r) => r.id === id)
  if (!ws) return { ok: false, error: 'focus a workspace that is a Git checkout first' }
  if (!ws.usable) return { ok: false, error: `${ws.name}: ${ws.reason}` }
  return { ok: true, ws }
}

const say = (r: StartResult): string =>
  r.ok
    ? `Council Flow: opened terminal "${r.title}" in ${r.workspaceName}. Follow the run there; any approval is yours to give in that terminal or in Orca, never the plugin's.`
    : `Council Flow: ${r.error}`

async function fromPalette(orca: OrcaWorkerApi, kind: 'audit' | 'code', args: unknown): Promise<string> {
  const f = await focused(orca)
  if (!f.ok) return `Council Flow: ${f.error}`
  const repo = f.ws.path
  let form: unknown = null
  if (isObject(args) && (kind === 'audit' ? 'scope' in args : 'task' in args)) form = args
  else {
    const raw = await orca.storage.get(STORAGE.last)
    const last = isObject(raw) ? (raw as Last) : {}
    form = last[repo]?.[kind] ?? null
  }
  if (!form) return `Council Flow: no earlier ${kind === 'audit' ? 'audit' : 'coding'} prompt for ${repo}. Open the Council Flow panel in the right sidebar and run one there.`
  return say(await start(orca, kind, { workspaceId: f.ws.id, repo, [kind]: form }))
}

async function resumeLatest(orca: OrcaWorkerApi, args: unknown): Promise<string> {
  const f = await focused(orca)
  if (!f.ok) return `Council Flow: ${f.error}`
  let runId = isObject(args) && typeof args.runId === 'string' ? args.runId : null
  if (!runId) {
    const { runs } = listRuns(f.ws.path)
    runId = runs.find((r) => r.resumable && (r.progress.phase === 'interrupted' || r.progress.phase === 'failed'))?.runId ?? null
  }
  if (!runId) return `Council Flow: no interrupted or failed run in ${f.ws.path}/.council-flow to resume.`
  return say(await resume(orca, { workspaceId: f.ws.id, repo: f.ws.path, runId, refreshContext: isObject(args) && args.refreshContext === true }))
}

async function jump(orca: OrcaWorkerApi): Promise<string> {
  const all = live ? await live.all() : []
  const target = all.find((w) => w.progress.phase === 'waiting-approve' && w.terminal) ?? all.find((w) => LIVE.has(w.progress.phase) && w.terminal && w.terminal.alive !== false)
  if (!target?.terminal) return 'Council Flow: no run is waiting for approve or running in a terminal the plugin opened.'
  const r = await focusTerminal(orca, target.terminal.id)
  if (!r.ok) return `Council Flow: ${r.error}`
  const name = `"${target.terminal.title}" in ${target.terminal.workspaceName}`
  return target.progress.phase === 'waiting-approve'
    ? `Council Flow: showing ${name}. If you want the change, type approve there yourself; the plugin never answers the gate.`
    : `Council Flow: showing ${name}.`
}

export function deactivate(): void {
  live?.dispose()
  live = null
}

export default function activate(orca: OrcaWorkerApi): void {
  live?.dispose()
  const mine = new Live(orca)
  live = mine

  orca.panels.handle('cf.context', async (): Promise<ContextInfo> => {
    const workspaces = await workspaceRows(orca)
    return { workspaces, focusedId: await focusedId(orca, workspaces), cli: await cliInfo(orca), canStart: orca.host.has('terminal.create'), canFocus: canFocus(orca) }
  })

  orca.panels.handle('cf.workflows', async ({ repo }) => mine.answer(repo))

  orca.panels.handle('cf.artifact', async ({ repo, runId, name }): Promise<ArtifactResult> => {
    try {
      return { ok: true, artifact: readArtifact(repo, runId, name) }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  })

  orca.panels.handle('cf.start', async (input) => start(orca, input.kind, input))
  orca.panels.handle('cf.resume', async (input) => resume(orca, input))
  orca.panels.handle('cf.focus', async ({ terminalId }) => focusTerminal(orca, terminalId))

  orca.panels.handle('cf.setCli', async ({ path: p }): Promise<CliInfo> => {
    if (!p) {
      await orca.storage.delete(STORAGE.cliPath)
      return cliInfo(orca)
    }
    const c = inspectCli(p)
    if (!c.ok) return { ok: false, error: c.error, configured: p }
    await orca.storage.set(STORAGE.cliPath, c.path)
    return { ...c, source: 'configured' }
  })

  orca.commands.register('council-flow.audit', (args) => fromPalette(orca, 'audit', args))
  orca.commands.register('council-flow.code', (args) => fromPalette(orca, 'code', args))
  orca.commands.register('council-flow.resume', (args) => resumeLatest(orca, args))
  orca.commands.register('council-flow.jump', () => jump(orca))
  orca.commands.register('council-flow.doctor', async () => {
    const f = await focused(orca)
    return f.ok ? say(await start(orca, 'doctor', { workspaceId: f.ws.id, repo: f.ws.path })) : `Council Flow: ${f.error}`
  })

  // A status bar item keeps this worker running: pick up the runs it started before Orca restarted.
  void mine.refresh().catch((e) => orca.log(`refresh failed: ${message(e)}`))
}

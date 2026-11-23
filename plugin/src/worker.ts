// The plugin's worker: Node code Orca runs on the Orca host (`trusted-worker`).
//
// What it does, and all it does:
// - lists Orca workspaces (workspace:read) and reads run folders under <repo>/.council-flow with
//   node:fs (read-only, see runs.ts);
// - starts council-flow by opening ONE new Orca terminal per run with terminal.create
//   (terminal:send). That terminal is an Orca terminal, so ORCA_TERMINAL_HANDLE is set inside it
//   and council-flow's Orca orchestration works. The command line comes from command.ts;
// - remembers the last settings per repository and what it started (storage:own).
//
// What it never does: type into a terminal after it was opened (no terminal.sendText, so it can
// never answer council-flow's "approve" gate), read the environment (no LYBER_API_KEY or any
// other variable), call a model, or touch the network.
import type { OrcaWorkerApi } from 'orca/worker'
import { buildAudit, buildCode, buildDoctor, buildResume, newRunId, terminalTitle, type AuditForm, type BuildResult, type CodeForm, type Implementer } from './command'
import { checkRepo, listRuns, readArtifact, readRun } from './runs'
import { inspectCli, resolveCli, type CliInfo } from './cli'
import type { ArtifactResult, ContextInfo, StartKind, StartResult, StartedRecord, WorkspaceRow } from './protocol'

export const STORAGE = { started: 'started', last: 'last', cliPath: 'cliPath' } as const
const MAX_STARTED = 50
const MAX_LAST_REPOS = 20

type Last = Record<string, { audit?: AuditForm; code?: CodeForm }>

const message = (e: unknown) => (e instanceof Error ? e.message : String(e))
const fail = (error: string): StartResult => ({ ok: false, error })
const str = (v: unknown) => (typeof v === 'string' ? v : typeof v === 'number' ? String(v) : '')
const isObject = (v: unknown): v is Record<string, unknown> => Boolean(v) && typeof v === 'object' && !Array.isArray(v)

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

async function remember(orca: OrcaWorkerApi, record: StartedRecord, forms: { audit?: AuditForm; code?: CodeForm }): Promise<void> {
  const prev = await orca.storage.get(STORAGE.started)
  const started = [record, ...(Array.isArray(prev) ? (prev as StartedRecord[]) : [])].slice(0, MAX_STARTED)
  await orca.storage.set(STORAGE.started, started)
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
  forms: { audit?: AuditForm; code?: CodeForm } = {}
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
  const record: StartedRecord = { kind, runId: built.runId, repo, workspaceId: ws.id, workspaceName: ws.name, terminalId, title, line: built.line, at: Date.now() }
  await remember(orca, record, forms)
  orca.panels.post('cf.started', record)
  orca.log(`opened terminal "${title}" in ${ws.name}`)
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
    return launch(orca, t.ws, t.repo, 'audit', buildAudit(t.cli, t.repo, form, newRunId()), { audit: form })
  }
  if (kind === 'code') {
    const form = codeForm(input.code)
    return launch(orca, t.ws, t.repo, 'code', buildCode(t.cli, t.repo, form, newRunId()), { code: form })
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
  return launch(orca, t.ws, t.repo, 'resume', built)
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
  if (!form) return `Council Flow: no earlier ${kind === 'audit' ? 'audit' : 'coding run'} for ${repo}. Open the Council Flow panel in the right sidebar and start one there.`
  return say(await start(orca, kind, { workspaceId: f.ws.id, repo, [kind]: form }))
}

async function resumeLatest(orca: OrcaWorkerApi, args: unknown): Promise<string> {
  const f = await focused(orca)
  if (!f.ok) return `Council Flow: ${f.error}`
  let runId = isObject(args) && typeof args.runId === 'string' ? args.runId : null
  if (!runId) {
    const { runs } = listRuns(f.ws.path)
    runId = runs.find((r) => r.resumable && (r.status === 'interrupted' || r.status === 'failed'))?.runId ?? null
  }
  if (!runId) return `Council Flow: no interrupted or failed run in ${f.ws.path}/.council-flow to resume.`
  return say(await resume(orca, { workspaceId: f.ws.id, repo: f.ws.path, runId, refreshContext: isObject(args) && args.refreshContext === true }))
}

export default function activate(orca: OrcaWorkerApi): void {
  orca.panels.handle('cf.context', async (): Promise<ContextInfo> => {
    const workspaces = await workspaceRows(orca)
    return { workspaces, focusedId: await focusedId(orca, workspaces), cli: await cliInfo(orca), canStart: orca.host.has('terminal.create') }
  })

  orca.panels.handle('cf.runs', async ({ repo }) => {
    const raw = await orca.storage.get(STORAGE.started)
    const started = (Array.isArray(raw) ? (raw as StartedRecord[]) : []).filter((r) => r && r.repo === repo)
    try {
      return { ...listRuns(repo), started }
    } catch (e) {
      return { repo: str(repo), runs: [], truncated: false, error: message(e), started }
    }
  })

  orca.panels.handle('cf.artifact', async ({ repo, runId, name }): Promise<ArtifactResult> => {
    try {
      return { ok: true, artifact: readArtifact(repo, runId, name) }
    } catch (e) {
      return { ok: false, error: message(e) }
    }
  })

  orca.panels.handle('cf.start', async (input) => start(orca, input.kind, input))
  orca.panels.handle('cf.resume', async (input) => resume(orca, input))

  orca.panels.handle('cf.setCli', async ({ path }): Promise<CliInfo> => {
    if (!path) {
      await orca.storage.delete(STORAGE.cliPath)
      return cliInfo(orca)
    }
    const c = inspectCli(path)
    if (!c.ok) return { ok: false, error: c.error, configured: path }
    await orca.storage.set(STORAGE.cliPath, c.path)
    return { ...c, source: 'configured' }
  })

  orca.commands.register('council-flow.audit', (args) => fromPalette(orca, 'audit', args))
  orca.commands.register('council-flow.code', (args) => fromPalette(orca, 'code', args))
  orca.commands.register('council-flow.resume', (args) => resumeLatest(orca, args))
  orca.commands.register('council-flow.doctor', async () => {
    const f = await focused(orca)
    return f.ok ? say(await start(orca, 'doctor', { workspaceId: f.ws.id, repo: f.ws.path })) : `Council Flow: ${f.error}`
  })
}

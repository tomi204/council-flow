// runs.ts: read-only view of <repo>/.council-flow/<run-id>/ for the panel.
//
// Follows council-flow's own rules (src/artifacts.mjs): run ids are validated, nothing below the
// repository is followed through a symlink, and only summary.md, findings.md and run.json are
// ever read. Files are size-capped and scrubbed again before display. Nothing here writes.
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { validRunId, type Mode } from './command'
import { progressOf, type Liveness, type Progress, type RunState } from './progress'
import { scrubForDisplay } from './redact'

export const ARTIFACT_DIR = '.council-flow'
export const ARTIFACTS = ['summary.md', 'findings.md', 'run.json'] as const
export type ArtifactName = (typeof ARTIFACTS)[number]
export const MAX_RUNS = 200
export const MAX_ARTIFACT_BYTES = 256 * 1024
const MAX_RUN_JSON_BYTES = 4 * 1024 * 1024

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'

export type RunRow = {
  runId: string
  mode: Mode | 'unknown'
  status: string
  tone: Tone
  /** First line of the task or audit scope, scrubbed and cut to 160 characters. */
  title: string
  createdAt: number | null
  updatedAt: number | null
  dryRun: boolean
  /** Audit target as the run recorded it, e.g. `localhost:3000` or `src/reader.js`. */
  target: string | null
  stopReason: string | null
  unresolved: number | null
  running: boolean
  resumable: boolean
  files: { summary: boolean; findings: boolean; runJson: boolean }
  /** Phase, stage, step trail and findings, derived from run.json, the lock and file times. */
  progress: Progress
  /** When the council-flow process working on it now took the run lock, ms; null when none does. */
  since: number | null
}

export type RunsResult = { repo: string; runs: RunRow[]; truncated: boolean; error?: string }
export type Artifact = { runId: string; name: ArtifactName; text: string; truncated: boolean; bytes: number; path: string }

export class RunsError extends Error {}

const isLink = (p: string): boolean => {
  try {
    return fs.lstatSync(p).isSymbolicLink()
  } catch {
    return false
  }
}

/** A regular file directly at `p` (not a link), or null. */
function regularFile(p: string): { size: number; mtimeMs: number } | null {
  try {
    const st = fs.lstatSync(p)
    return st.isFile() && !st.isSymbolicLink() ? { size: st.size, mtimeMs: st.mtimeMs } : null
  } catch {
    return null
  }
}

/** The repository root as given, after checking it is a local Git checkout. */
export function checkRepo(repo: unknown): string {
  if (typeof repo !== 'string' || !repo.startsWith('/') || /[\u0000-\u001f\u007f]/.test(repo) || repo.split('/').includes('..')) {
    throw new RunsError('repository must be an absolute path')
  }
  const root = repo.length > 1 ? repo.replace(/\/+$/, '') : repo
  let st
  try {
    st = fs.statSync(root)
  } catch {
    throw new RunsError(`no folder at ${root} on this Orca host`)
  }
  if (!st.isDirectory()) throw new RunsError(`${root} is not a folder`)
  if (!fs.existsSync(path.join(root, '.git'))) throw new RunsError(`${root} is not a Git checkout`)
  return root
}

/** `<repo>/.council-flow`, refusing a symlinked folder. Null when it does not exist yet. */
function artifactBase(root: string): string | null {
  const base = path.join(root, ARTIFACT_DIR)
  let st
  try {
    st = fs.lstatSync(base)
  } catch {
    return null
  }
  if (st.isSymbolicLink()) throw new RunsError(`refusing ${base}: it is a symlink`)
  if (!st.isDirectory()) throw new RunsError(`${base} is not a folder`)
  return base
}

function readCapped(file: string, limit: number): { text: string; truncated: boolean; bytes: number } {
  const info = regularFile(file)
  if (!info) throw new RunsError(`${path.basename(file)} is missing or not a regular file`)
  const length = Math.min(info.size, limit)
  const buffer = new Uint8Array(length)
  const fd = fs.openSync(file, 'r')
  let read = 0
  try {
    while (read < length) {
      const n = fs.readSync(fd, buffer, read, length - read, read)
      if (n <= 0) break
      read += n
    }
  } finally {
    fs.closeSync(fd)
  }
  return { text: new TextDecoder('utf-8').decode(buffer.subarray(0, read)), truncated: info.size > limit, bytes: info.size }
}

const firstLine = (s: unknown): string => {
  const line = String(s ?? '').split(/\r?\n/).find((l) => l.trim()) ?? ''
  const clean = scrubForDisplay(line.trim())
  return clean.length > 160 ? `${clean.slice(0, 157)}...` : clean
}

const time = (s: unknown): number | null => {
  const t = typeof s === 'string' ? Date.parse(s) : NaN
  return Number.isFinite(t) ? t : null
}

type Lock = { state: 'none' } | { state: 'alive'; pid: number; at: number | null } | { state: 'stale' } | { state: 'other-host'; host: string }

// council-flow's lock file: {pid, host, at}. Alive only for a live process on this host.
function lockState(dir: string): Lock {
  const file = path.join(dir, '.lock')
  if (!regularFile(file)) return { state: 'none' }
  let owner: { pid?: unknown; host?: unknown; at?: unknown } | null = null
  try {
    owner = JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return { state: 'stale' }
  }
  if (!owner || typeof owner.pid !== 'number') return { state: 'stale' }
  if (typeof owner.host === 'string' && owner.host !== os.hostname()) return { state: 'other-host', host: owner.host }
  const at = time(owner.at)
  try {
    process.kill(owner.pid, 0)
    return { state: 'alive', pid: owner.pid, at }
  } catch (e) {
    return (e as { code?: string }).code === 'EPERM' ? { state: 'alive', pid: owner.pid, at } : { state: 'stale' }
  }
}

const SUCCESS = new Set(['approved', 'pr-opened', 'published', 'pushed', 'committed', 'no-changes'])
const DANGER = new Set(['failed', 'commit-failed', 'branch-moved'])

export function toneOf(status: string): Tone {
  if (status === 'running') return 'accent'
  if (SUCCESS.has(status)) return 'success'
  if (DANGER.has(status)) return 'danger'
  if (status === 'empty' || status === 'unknown') return 'neutral'
  return 'warning'
}

type State = RunState & {
  task?: unknown
  createdAt?: unknown
  updatedAt?: unknown
  outcome?: { status?: unknown; stopReason?: unknown; unresolved?: unknown } | null
  config?: { dryRun?: unknown; rounds?: unknown } | null
  targetInput?: unknown
  auditLoop?: (NonNullable<RunState['auditLoop']> & { stopReason?: unknown }) | null
}

// Parsed run.json by path, reused while its size and mtime are unchanged: the worker re-reads runs
// each time a run folder changes.
const parsed = new Map<string, { size: number; mtimeMs: number; state: State | null }>()

function readState(file: string, info: { size: number; mtimeMs: number }): State | null {
  const hit = parsed.get(file)
  if (hit && hit.size === info.size && hit.mtimeMs === info.mtimeMs) return hit.state
  let state: State | null = null
  try {
    const raw = readCapped(file, MAX_RUN_JSON_BYTES)
    if (!raw.truncated) state = JSON.parse(raw.text)
  } catch {
    state = null
  }
  if (parsed.size > 500) parsed.clear()
  parsed.set(file, { size: info.size, mtimeMs: info.mtimeMs, state })
  return state
}

function describe(dir: string, runId: string): RunRow {
  const summaryFile = regularFile(path.join(dir, 'summary.md'))
  const runFile = regularFile(path.join(dir, 'run.json'))
  const gateFile = regularFile(path.join(dir, 'gate.json'))
  const files = {
    summary: Boolean(summaryFile),
    findings: Boolean(regularFile(path.join(dir, 'findings.md'))),
    runJson: Boolean(runFile)
  }
  const state: State | null = runFile ? readState(path.join(dir, 'run.json'), runFile) : null
  const lock = lockState(dir)
  const outcome = state && state.outcome && typeof state.outcome === 'object' ? state.outcome : null
  let status: string
  if (lock.state === 'alive') status = 'running'
  else if (lock.state === 'other-host') status = `locked by ${lock.host}`
  else if (outcome && typeof outcome.status === 'string') status = outcome.status
  else if (state) status = 'interrupted'
  else {
    // No readable run.json: fall back to the last "Outcome:" line of summary.md, if any.
    let fromSummary: string | null = null
    if (files.summary) {
      try {
        const m = /^(?:\*\*)?Outcome:(?:\*\*)?\s*([a-z][\w-]*)/im.exec(readCapped(path.join(dir, 'summary.md'), MAX_ARTIFACT_BYTES).text)
        fromSummary = m ? m[1] : null
      } catch {
        fromSummary = null
      }
    }
    status = fromSummary ?? (files.runJson ? 'unknown' : 'empty')
  }
  const mode: RunRow['mode'] = state ? (state.mode === 'audit' ? 'audit' : 'code') : 'unknown'
  const stop = outcome?.stopReason ?? state?.auditLoop?.stopReason
  const running = lock.state === 'alive' || lock.state === 'other-host'
  const liveness: Liveness = lock.state
  const progress = progressOf({
    mode: mode === 'audit' ? 'audit' : 'code',
    state,
    lock: liveness,
    lockAt: lock.state === 'alive' ? lock.at : null,
    summaryMtime: summaryFile?.mtimeMs ?? null,
    gateMtime: gateFile?.mtimeMs ?? null
  })
  return {
    runId,
    mode,
    status,
    tone: toneOf(status),
    title: state ? firstLine(state.task) : '',
    createdAt: time(state?.createdAt),
    updatedAt: time(state?.updatedAt),
    dryRun: Boolean(state?.config && state.config.dryRun),
    target: mode === 'audit' && typeof state?.targetInput === 'string' ? scrubForDisplay(state.targetInput) : null,
    stopReason: typeof stop === 'string' ? stop : null,
    unresolved: typeof outcome?.unresolved === 'number' ? outcome.unresolved : null,
    running,
    // council-flow can resume any run it has a run.json for; a live run is left alone.
    resumable: Boolean(state) && mode !== 'unknown' && !running,
    files,
    progress,
    since: lock.state === 'alive' ? lock.at : null
  }
}

/** Every run folder under `<repo>/.council-flow` (the newest `limit` by run id), newest first. */
export function listRuns(repo: unknown, limit: number = MAX_RUNS): RunsResult {
  const root = checkRepo(repo)
  const base = artifactBase(root)
  if (!base) return { repo: root, runs: [], truncated: false }
  const names = fs.readdirSync(base).filter((n) => validRunId(n)).sort().reverse()
  const max = Math.max(1, Math.min(MAX_RUNS, limit))
  const runs: RunRow[] = []
  for (const name of names) {
    const dir = path.join(base, name)
    let st
    try {
      st = fs.lstatSync(dir)
    } catch {
      continue
    }
    if (st.isSymbolicLink() || !st.isDirectory()) continue
    runs.push(describe(dir, name))
    if (runs.length >= max) break
  }
  runs.sort((a, b) => (b.updatedAt ?? b.createdAt ?? 0) - (a.updatedAt ?? a.createdAt ?? 0) || (a.runId < b.runId ? 1 : -1))
  return { repo: root, runs, truncated: names.length > runs.length }
}

/** One run's row, or null when it has no folder. */
export function readRun(repo: unknown, runId: unknown): RunRow | null {
  const root = checkRepo(repo)
  if (!validRunId(runId)) throw new RunsError('invalid run id')
  const base = artifactBase(root)
  if (!base) return null
  const dir = path.join(base, runId)
  if (isLink(dir)) throw new RunsError(`refusing ${dir}: it is a symlink`)
  try {
    if (!fs.lstatSync(dir).isDirectory()) return null
  } catch {
    return null
  }
  return describe(dir, runId)
}

/** summary.md, findings.md or run.json of one run: capped, scrubbed, run.json pretty-printed. */
export function readArtifact(repo: unknown, runId: unknown, name: unknown): Artifact {
  const root = checkRepo(repo)
  if (!validRunId(runId)) throw new RunsError('invalid run id')
  if (typeof name !== 'string' || !(ARTIFACTS as readonly string[]).includes(name)) {
    throw new RunsError(`only ${ARTIFACTS.join(', ')} can be opened here`)
  }
  const base = artifactBase(root)
  if (!base) throw new RunsError(`no ${ARTIFACT_DIR} folder in ${root}`)
  const dir = path.join(base, runId)
  if (isLink(dir)) throw new RunsError(`refusing ${dir}: it is a symlink`)
  const file = path.join(dir, name)
  if (isLink(file)) throw new RunsError(`refusing ${file}: it is a symlink`)
  const raw = readCapped(file, MAX_ARTIFACT_BYTES)
  let text = raw.text
  if (name === 'run.json' && !raw.truncated) {
    try {
      text = JSON.stringify(JSON.parse(text), null, 2)
    } catch {
      // Not valid JSON: show it as it is.
    }
  }
  return { runId, name: name as ArtifactName, text: scrubForDisplay(text), truncated: raw.truncated, bytes: raw.bytes, path: file }
}

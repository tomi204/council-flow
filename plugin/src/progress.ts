// progress.ts: where a council-flow run is, in words, for a workflow card. Pure: no Orca, no Node.
//
// Everything here is read from what the CLI already writes; there is no second state machine.
// - run.json `stages`: every stage the CLI starts and ends (pipeline.mjs `stage()`), by name:
//     audit:  context-<n>, teams-<n> (Red & Blue), review-<n> (Codex), tests
//     coding: plan, implement, review-<n>, fix-<n>, tests, gate (the gate and publishing)
// - the run lock `.lock` ({pid, host, at}): alive while a council-flow process works on the run;
// - run.json `outcome`: set once the gate was answered (or the run failed);
// - the times summary.md and gate.json were last written. An audit writes summary.md right before it
//   asks its gate and gate.json right after the answer, so "summary newer than the tests, gate.json
//   older" is an audit waiting for its approve. A coding run asks inside its `gate` stage, and writes
//   gate.json once answered.
import type { Mode } from './command'

export type Tone = 'neutral' | 'accent' | 'success' | 'warning' | 'danger'
export type Phase = 'starting' | 'running' | 'waiting-approve' | 'publishing' | 'elsewhere' | 'done' | 'failed' | 'interrupted'
export type StepState = 'done' | 'current' | 'next' | 'failed'
export type Step = { label: string; state: StepState }

export type Progress = {
  phase: Phase
  /** Status words for the card: Running, Waiting for approve, Done, Failed, Interrupted, ... */
  label: string
  tone: Tone
  /** The stage in words while the run is live, e.g. "red & blue"; null once it stopped. */
  stage: string | null
  stageStartedAt: number | null
  /** The loop, each step done, current, next or failed. */
  steps: Step[]
  /** "iteration 2/3" (audit) or "review round 2 · fixes 1/2" (coding), when known. */
  round: string | null
  findings: number | null
  open: number | null
  /** What a finished run ended with, e.g. "gate declined", "committed locally". */
  outcome: string | null
}

export type Liveness = 'alive' | 'none' | 'stale' | 'other-host'

type StageRecord = { status?: unknown; startedAt?: unknown; endedAt?: unknown }
/** The parts of run.json this reads. Anything may be missing or malformed. */
export type RunState = {
  mode?: unknown
  stages?: Record<string, StageRecord> | null
  outcome?: { status?: unknown; unresolved?: unknown } | null
  config?: { rounds?: unknown } | null
  auditLoop?: { iterations?: { number?: unknown }[] | null; ledger?: { status?: unknown }[] | null } | null
  loop?: { n?: unknown; fixRounds?: unknown; findings?: { severity?: unknown }[] | null } | null
}

export type ProgressInput = {
  mode: Mode
  state: RunState | null
  lock: Liveness
  /** When the live lock was taken (this council-flow process started), ms. */
  lockAt?: number | null
  summaryMtime?: number | null
  gateMtime?: number | null
}

const num = (v: unknown): number | null => (typeof v === 'number' && Number.isFinite(v) ? v : null)
const time = (v: unknown): number | null => {
  const t = typeof v === 'string' ? Date.parse(v) : NaN
  return Number.isFinite(t) ? t : null
}

type Entry = { name: string; status: string; startedAt: number; endedAt: number | null }

function entries(state: RunState | null): Entry[] {
  const stages = state && state.stages && typeof state.stages === 'object' ? state.stages : {}
  return Object.entries(stages)
    .filter(([, s]) => s && typeof s === 'object')
    .map(([name, s]) => ({ name, status: typeof s.status === 'string' ? s.status : 'unknown', startedAt: time(s.startedAt) ?? 0, endedAt: time(s.endedAt) }))
    .sort((a, b) => b.startedAt - a.startedAt)
}

// Stage names -> the words on the card. Audit uses the loop as people say it: context -> red & blue -> Codex review -> re-context.
function auditStep(name: string): { label: string; iteration: number | null } | null {
  const m = /^(context|teams|review)-(\d+)$/.exec(name)
  if (m) {
    const n = Number(m[2])
    const label = m[1] === 'context' ? (n > 1 ? 're-context' : 'context') : m[1] === 'teams' ? 'red & blue' : 'Codex review'
    return { label, iteration: n }
  }
  return name === 'tests' ? { label: 'tests', iteration: null } : null
}

function codeStep(name: string): { label: string; iteration: number | null } | null {
  if (name === 'plan' || name === 'implement' || name === 'tests') return { label: name, iteration: null }
  const m = /^(review|fix)-(\d+)$/.exec(name)
  if (m) return { label: m[1], iteration: Number(m[2]) }
  return name === 'gate' ? { label: 'approve', iteration: null } : null
}

const OUTCOMES: Record<string, [string, Tone]> = {
  declined: ['gate declined', 'neutral'],
  'dry-run': ['approved (dry run: nothing committed)', 'success'],
  approved: ['approved', 'success'],
  'no-changes': ['no changes to commit', 'neutral'],
  'tests-incomplete': ['not committed: tests incomplete', 'warning'],
  'review-incomplete': ['not committed: review incomplete', 'warning'],
  committed: ['committed', 'success'],
  'committed-local': ['committed locally', 'success'],
  'committed-no-remote': ['committed (no remote)', 'success'],
  pushed: ['pushed', 'success'],
  'pushed-no-gh': ['pushed, no PR (gh missing)', 'warning'],
  'pushed-no-github-repo': ['pushed, no PR (not a GitHub remote)', 'warning'],
  'pushed-pr-failed': ['pushed, PR failed', 'warning'],
  'pr-opened': ['PR opened', 'success'],
  published: ['published', 'success'],
  'commit-failed': ['commit failed', 'danger'],
  'branch-moved': ['branch moved: not committed', 'danger'],
  'push-failed': ['push failed', 'danger'],
  'remote-moved': ['remote moved: not pushed', 'danger']
}

/** Words and tone for a finished run's outcome status. */
export function outcomeWords(status: string): [string, Tone] {
  return OUTCOMES[status] ?? [status, 'warning']
}

function counts(mode: Mode, state: RunState | null): { findings: number | null; open: number | null } {
  if (!state) return { findings: null, open: null }
  if (mode === 'audit') {
    const ledger = state.auditLoop && Array.isArray(state.auditLoop.ledger) ? state.auditLoop.ledger : null
    if (!ledger) return { findings: null, open: num(state.outcome?.unresolved) }
    // council-flow's `unresolved` (src/audit/findings.mjs): open, confirmed or reopened.
    const open = ledger.filter((f) => f && ['open', 'confirmed', 'reopened'].includes(String(f.status))).length
    return { findings: ledger.length, open }
  }
  const list = state.loop && Array.isArray(state.loop.findings) ? state.loop.findings : null
  if (!list) return { findings: null, open: null }
  // The coding loop keeps the open findings of its last valid review; blocker and major block the PR.
  return { findings: list.length, open: list.filter((f) => f && ['blocker', 'major'].includes(String(f.severity))).length }
}

function roundText(mode: Mode, state: RunState | null, iteration: number | null): string | null {
  if (!state) return null
  const max = num(state.config?.rounds)
  if (mode === 'audit') {
    const its = state.auditLoop && Array.isArray(state.auditLoop.iterations) ? state.auditLoop.iterations : []
    const n = iteration ?? num(its.at(-1)?.number)
    if (n === null) return null
    // --rounds 0 is one report-only iteration.
    const of = max === null ? null : Math.max(1, max)
    return of !== null && n <= of ? `iteration ${n}/${of}` : `iteration ${n}`
  }
  const loop = state.loop
  const n = num(loop?.n)
  if (!loop || n === null) return null
  const fixes = num(loop.fixRounds) ?? 0
  return `review round ${n}${max !== null ? ` · fixes ${fixes}/${max}` : ''}`
}

function trail(mode: Mode, iteration: number | null, maxIterations: number | null, current: string | null, state: StepState, finished: boolean): Step[] {
  let labels: string[]
  if (mode === 'audit') {
    const first = iteration !== null && iteration > 1 ? 're-context' : 'context'
    const inLoop = current === null || ['context', 're-context', 'red & blue', 'Codex review'].includes(current)
    const more = !finished && inLoop && (maxIterations === null || iteration === null || iteration < maxIterations)
    labels = [first, 'red & blue', 'Codex review', ...(more ? ['re-context …'] : []), 'tests', 'approve']
    if (current === 'context' || current === 're-context') current = first
  } else {
    labels = ['plan', 'implement', 'review', 'fix', 'tests', 'approve', ...(current === 'publish' ? ['publish'] : [])]
  }
  const at = current === null ? -1 : labels.indexOf(current)
  return labels.map((label, i) => ({
    label,
    state: finished && at < 0 ? 'done' : i < at ? 'done' : i === at ? state : 'next'
  }))
}

/** Phase, status words, current stage and the step trail of one run. */
export function progressOf(input: ProgressInput): Progress {
  const { mode, state, lock } = input
  const list = entries(state)
  const latest = list[0] ?? null
  const step = (name: string) => (mode === 'audit' ? auditStep(name) : codeStep(name))
  const maxRounds = num(state?.config?.rounds)
  const maxIterations = mode === 'audit' && maxRounds !== null ? Math.max(1, maxRounds) : null
  const { findings, open } = counts(mode, state)
  const base = { findings, open }
  const make = (p: Omit<Progress, 'findings' | 'open' | 'steps' | 'round'>, current: string | null, iteration: number | null, stepState: StepState, finished: boolean): Progress => ({
    ...p,
    ...base,
    round: roundText(mode, state, iteration),
    steps: trail(mode, iteration, maxIterations, current, stepState, finished)
  })

  if (lock === 'other-host') {
    return make({ phase: 'elsewhere', label: 'Running elsewhere', tone: 'neutral', stage: null, stageStartedAt: null, outcome: null }, null, null, 'current', false)
  }

  if (lock === 'alive') {
    const lockAt = input.lockAt ?? null
    // A stage left "running" by an earlier, killed process is not this process's stage.
    const mine = latest && (lockAt === null || latest.startedAt >= lockAt - 1000) ? latest : null
    if (!mine) return make({ phase: 'starting', label: 'Starting', tone: 'accent', stage: 'checking members', stageStartedAt: lockAt, outcome: null }, null, null, 'current', false)
    const s = step(mine.name)
    const iteration = s?.iteration ?? null
    const summary = input.summaryMtime ?? null
    const gate = input.gateMtime ?? null
    if (mode === 'audit' && mine.name === 'tests' && mine.status === 'done' && mine.endedAt !== null) {
      if (gate !== null && gate >= mine.endedAt) {
        return make({ phase: 'publishing', label: 'Finishing', tone: 'accent', stage: 'recording the gate answer', stageStartedAt: gate, outcome: null }, 'approve', null, 'done', false)
      }
      if (summary !== null && summary >= mine.endedAt) {
        return make({ phase: 'waiting-approve', label: 'Waiting for approve', tone: 'warning', stage: 'waiting for your approve', stageStartedAt: summary, outcome: null }, 'approve', null, 'current', false)
      }
      return make({ phase: 'running', label: 'Running', tone: 'accent', stage: 'regression tests and summary', stageStartedAt: mine.endedAt, outcome: null }, 'tests', null, 'current', false)
    }
    if (mode === 'code' && mine.name === 'gate' && mine.status === 'running') {
      if (gate !== null && gate >= mine.startedAt) {
        return make({ phase: 'publishing', label: 'Publishing', tone: 'accent', stage: 'publish', stageStartedAt: gate, outcome: null }, 'publish', null, 'current', false)
      }
      return make({ phase: 'waiting-approve', label: 'Waiting for approve', tone: 'warning', stage: 'waiting for your approve', stageStartedAt: mine.startedAt, outcome: null }, 'approve', null, 'current', false)
    }
    const label = s?.label ?? mine.name
    return make({ phase: 'running', label: 'Running', tone: 'accent', stage: label, stageStartedAt: mine.status === 'running' ? mine.startedAt : mine.endedAt ?? mine.startedAt, outcome: null }, s ? label : null, iteration, 'current', false)
  }

  // No live process.
  const status = state?.outcome && typeof state.outcome.status === 'string' ? state.outcome.status : null
  const stopped = latest && (latest.status === 'running' || latest.status === 'interrupted') ? latest : null
  if (stopped || !status) {
    const s = stopped ? step(stopped.name) : latest ? step(latest.name) : null
    return make({ phase: 'interrupted', label: 'Interrupted', tone: 'warning', stage: null, stageStartedAt: null, outcome: s ? `stopped at ${s.label}` : null }, s?.label ?? null, s?.iteration ?? null, 'failed', false)
  }
  if (status === 'failed') {
    const failed = list.find((e) => e.status === 'failed') ?? latest
    const s = failed ? step(failed.name) : null
    return make({ phase: 'failed', label: 'Failed', tone: 'danger', stage: null, stageStartedAt: null, outcome: s ? `failed at ${s.label}` : 'failed' }, s?.label ?? null, s?.iteration ?? null, 'failed', false)
  }
  const [words, tone] = outcomeWords(status)
  const done = make({ phase: 'done', label: 'Done', tone, stage: null, stageStartedAt: null, outcome: words }, null, null, 'done', true)
  // A declined gate was never approved: leave that step unlit.
  if (status === 'declined') done.steps = done.steps.map((s) => (s.label === 'approve' ? { ...s, state: 'next' } : s))
  return done
}

const plural = (n: number, word: string) => `${n} ${word}${n === 1 ? '' : 's'}`

/** "5 findings, 2 open" (audit) or "3 open findings, 1 blocking" (coding); null when not known yet. */
export function findingsText(mode: Mode | 'unknown', p: Pick<Progress, 'findings' | 'open'>): string | null {
  if (mode === 'audit') {
    if (p.findings !== null) return `${plural(p.findings, 'finding')}${p.open !== null ? `, ${p.open} open` : ''}`
    return p.open !== null ? `${p.open} unresolved` : null
  }
  if (mode === 'code' && p.findings !== null) return p.findings ? `${plural(p.findings, 'open finding')}${p.open ? `, ${p.open} blocking` : ''}` : 'no open findings'
  return null
}

/** Sort key: waiting first, then live runs, then the rest (newest first within each). */
export function phaseRank(phase: Phase): number {
  return phase === 'waiting-approve' ? 0 : phase === 'running' || phase === 'publishing' || phase === 'starting' ? 1 : phase === 'elsewhere' ? 2 : 3
}

/** "12s", "4m", "1h 5m", "2d 3h". */
export function formatDuration(ms: number): string {
  const s = Math.max(0, Math.round(ms / 1000))
  if (s < 60) return `${s}s`
  const m = Math.floor(s / 60)
  if (m < 60) return `${m}m`
  const h = Math.floor(m / 60)
  if (h < 24) return m % 60 ? `${h}h ${m % 60}m` : `${h}h`
  const d = Math.floor(h / 24)
  return h % 24 ? `${d}d ${h % 24}h` : `${d}d`
}

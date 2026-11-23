// orca.mjs: the Orca orchestration CLI as council-flow uses it (orca 1.4.259; flags from `orca orchestration
// <cmd> --help`, see docs/help/orca-orchestration-commands.txt).
//
// Every orchestration verb needs a calling Orca terminal: outside one, Orca answers no_active_sender_terminal.
// So Orca mode is used only when ORCA_TERMINAL_HANDLE is set (council-flow started from an Orca terminal or
// automation) and the runtime is reachable. Otherwise the pipeline falls back to `git worktree add` + a TTY gate.
//
// Response shapes are not documented beyond {ok, result | error}. Ids are taken only from explicit fields
// (<kind>Id or <kind>.id); anything ambiguous is refused rather than guessed. Every argument and stdin is scrubbed
// of secrets before it reaches the orca process.
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { run, which, sleep } from './proc.mjs'
import { envFor } from './env.mjs'
import { scrubSecrets } from './redact.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
export const FAKE_ORCA = path.join(HERE, '..', 'test', 'fixtures', 'fake-orca.mjs')

export class OrcaError extends Error {}

// Breadth-first search for the first (key, value) the predicate accepts.
export function deepFind(root, pred) {
  const queue = [[null, root]]
  const seen = new Set()
  while (queue.length) {
    const [k, v] = queue.shift()
    if (k !== null && pred(k, v)) return v
    if (v && typeof v === 'object' && !seen.has(v)) {
      seen.add(v)
      for (const [ck, cv] of Array.isArray(v) ? v.entries() : Object.entries(v)) queue.push([String(ck), cv])
    }
  }
  return undefined
}

// Only explicit fields: <kind>Id / <kind>_id anywhere, or {<kind>: {id}}. No guessing from a bare "id".
export function pickId(res, kind) {
  const direct = deepFind(res, (k, v) => typeof v === 'string' && v && (k === `${kind}Id` || k === `${kind}_id`))
  if (direct) return direct
  const obj = deepFind(res, (k, v) => k === kind && v && typeof v === 'object' && typeof v.id === 'string' && v.id)
  return obj ? obj.id : undefined
}

const typeOf = (m) => (m && (m.type || m.messageType || m.kind)) || ''
export const dispatchOf = (m) => m && (m.dispatchId ?? m.dispatch_id ?? m.dispatch?.id ?? m.payload?.dispatchId ?? m.payload?.dispatch_id ?? null)
export const outcomeOf = (m) => m && (m.outcome ?? m.payload?.outcome ?? null)
export function collectMessages(res) {
  const arr = deepFind(res, (k, v) => Array.isArray(v) && v.some(x => x && typeof x === 'object' && typeOf(x)))
  return Array.isArray(arr) ? arr : []
}

// The new worker's worktree: only from explicit worktree fields, never the primary checkout, and exactly one
// candidate. The caller still verifies it is a registered linked worktree of the repo (repo.verifyWorktree).
export function findWorktreePath(res, repoRoot) {
  const real = (p) => { try { return fs.realpathSync(p) } catch { return null } }
  const cands = new Set()
  const visit = (v, key, parentKey) => {
    if (!v || typeof v !== 'object') {
      if (typeof v === 'string' && path.isAbsolute(v) && (/^worktree_?path$/i.test(key) || (/^path$/i.test(key) && /^(worktree|workspace)$/i.test(parentKey || '')))) {
        const r = real(v)
        if (r && fs.existsSync(path.join(r, '.git'))) cands.add(r)
      }
      return
    }
    for (const [k, cv] of Object.entries(v)) visit(cv, k, key)
  }
  visit(res, null, null)
  const root = repoRoot ? real(repoRoot) : null
  const list = [...cands].filter(p => p !== root)
  if (list.length > 1) throw new OrcaError(`ambiguous worktree in the receipt: ${list.join(', ')}`)
  return list[0]
}

const PENDING = new Set(['pending', 'open', 'waiting', 'created'])

export function createOrca(cfg, { env = process.env, scratch = null } = {}) {
  const handle = cfg.orca.from
  let bin = null
  const history = []
  const pollMs = cfg.dryRun ? 20 : 15000
  const set = handle ? { ORCA_TERMINAL_HANDLE: handle } : {}
  if (cfg.dryRun && !env.COUNCIL_FAKE_ORCA_STATE && scratch) set.COUNCIL_FAKE_ORCA_STATE = path.join(scratch, 'fake-orca.json')
  const childEnv = envFor('orca', env, { fxKeyEnv: cfg.fxKeyEnv, dryRun: cfg.dryRun, set })
  const clean = (s) => scrubSecrets(s, { env, mode: 'code' })
  let orcaRun = null                                          // the recorded Run: passed with --run where Orca takes it

  async function exec(args, { stdin, timeoutMs = 120000 } = {}) {
    const exe = cfg.dryRun ? process.execPath : bin
    if (!exe) throw new OrcaError('orca binary not resolved')
    const safeArgs = args.map(clean)
    const r = await run(exe, cfg.dryRun ? [FAKE_ORCA, ...safeArgs] : safeArgs, { stdin: stdin == null ? undefined : clean(stdin), timeoutMs, env: childEnv })
    history.push({ cmd: args.slice(0, 2).join(' '), ok: r.ok, ms: r.durationMs })
    let j = null
    try { j = JSON.parse(r.stdout) } catch {
      const line = r.stdout.trim().split('\n').reverse().find(l => l.trim().startsWith('{'))
      try { j = line ? JSON.parse(line) : null } catch { j = null }
    }
    if (!j) throw new OrcaError(`orca ${args.slice(0, 2).join(' ')}: no JSON output (${r.error || 'exit 0'}: ${r.stderr.trim().slice(-300)})`)
    if (j.ok === false || !r.ok) throw new OrcaError(`orca ${args.slice(0, 2).join(' ')}: ${j.error?.code || r.error || 'error'}: ${j.error?.message || ''}`)
    return j.result ?? j
  }
  const withRun = (args) => (orcaRun ? [...args, '--run', orcaRun] : args)

  const api = {
    history,
    useRun(id) { orcaRun = id || null },
    async detect() {
      if (cfg.orca.mode === 'off') return { usable: false, reason: 'COUNCIL_ORCA=off' }
      if (cfg.dryRun) return cfg.orca.mode === 'on' ? { usable: true, reason: 'dry-run fake Orca' } : { usable: false, reason: 'dry-run uses git worktrees unless COUNCIL_ORCA=on' }
      bin = cfg.bins.orca ? which(cfg.bins.orca, env) : (which('orca', env) || which('orca-ide', env))
      if (!bin) return { usable: false, reason: 'orca / orca-ide not found on PATH' }
      let st
      try { st = await exec(['status', '--json'], { timeoutMs: 20000 }) } catch (e) { return { usable: false, bin, reason: `orca status failed: ${e.message}` } }
      const rt = st && st.runtime
      if (!rt || rt.reachable !== true) return { usable: false, bin, reason: 'Orca runtime not reachable (start the Orca app or `orca serve`)' }
      if (!handle) return { usable: false, bin, runtime: rt.state, reason: 'not inside an Orca terminal (ORCA_TERMINAL_HANDLE unset); orchestration verbs need a calling terminal' }
      return { usable: true, bin, runtime: rt.state, reason: 'Orca runtime ready, running in an Orca terminal' }
    },

    async runCreate(objective) {
      const id = pickId(await exec(['orchestration', 'run-create', '--objective', objective, '--json']), 'run')
      if (!id) throw new OrcaError('run-create: no run id in the receipt')
      orcaRun = id
      return id
    },

    async taskCreate(spec, title) {
      const id = pickId(await exec(withRun(['orchestration', 'task-create', '--spec-file', '-', '--task-title', title, '--json']), { stdin: spec }), 'task')
      if (!id) throw new OrcaError('task-create: no task id in the receipt')
      return id
    },

    // New worktree for the implementer, nested under the caller's workspace (new-child) unless configured.
    // --setup skip: repository setup hooks do not run for this checkout.
    async workerStart({ taskId, agent, model, name, repo, baseRef }) {
      const args = ['orchestration', 'worker-start', '--task', taskId, '--worktree', cfg.orca.worktree, '--agent', agent,
        '--name', name, '--repo', `path:${repo}`, '--base-branch', baseRef, '--setup', 'skip', '--timeout-ms', '180000', '--json']
      if (model) args.push('--model', model)
      const res = await exec(withRun(args), { timeoutMs: 240000 })
      const dispatchId = pickId(res, 'dispatch')
      if (!dispatchId) throw new OrcaError('worker-start: no dispatch id in the receipt')
      let worktreePath = findWorktreePath(res, repo)
      if (!worktreePath) worktreePath = findWorktreePath(await exec(['worktree', 'show', '--worktree', `name:${name}`, '--json']), repo)
      if (!worktreePath) throw new OrcaError(`worker-start: no worktree path in the receipt (dispatch ${dispatchId}); set COUNCIL_ORCA=off to use git worktrees`)
      return { dispatchId, worktreePath, receipt: res }
    },

    // Whether a dispatch already settled (e.g. its worker_done was consumed before a crash). Only an explicit
    // outcome counts.
    async reconcile(dispatchId) {
      const res = await exec(['orchestration', 'worker-show', '--dispatch', dispatchId, '--json'])
      const outcome = deepFind(res, (k, v) => k === 'outcome' && typeof v === 'string')
      return ['succeeded', 'failed'].includes(outcome) ? { settled: true, outcome } : { settled: false }
    },

    // Blocks on `check --wait` until one of `dispatchIds` reports worker_done (with an explicit outcome) or
    // escalates. Every other message in a delivered batch is handed to onOther, never silently dropped.
    async waitDone(dispatchIds, timeoutMs, { onOther = () => {} } = {}) {
      const ids = new Set([].concat(dispatchIds).filter(Boolean))
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const chunk = Math.max(1000, Math.min(deadline - Date.now(), 1800000))
        const t0 = Date.now()
        const res = await exec(withRun(['orchestration', 'check', '--wait', '--types', 'worker_done,escalation', '--timeout-ms', String(chunk), '--json']), { timeoutMs: chunk + 60000 })
        let mine = null
        for (const m of collectMessages(res)) {
          if (['worker_done', 'escalation'].includes(typeOf(m)) && ids.has(dispatchOf(m))) mine = m
          else onOther(m)
        }
        if (mine) {
          if (typeOf(mine) === 'escalation') return { outcome: 'escalation', message: mine, dispatchId: dispatchOf(mine) }
          const o = outcomeOf(mine)
          return { outcome: ['succeeded', 'failed'].includes(o) ? o : 'no-outcome', message: mine, dispatchId: dispatchOf(mine) }
        }
        if (Date.now() - t0 < 1000) await sleep(Math.min(pollMs, 1000))
      }
      return { outcome: 'timeout' }
    },

    // Returns the follow-up dispatch id when Orca turned the message into a new Task for a finished worker.
    async send(dispatchId, subject, body) {
      const res = await exec(withRun(['orchestration', 'send', '--to', `dispatch:${dispatchId}`, '--subject', subject, '--body', body, '--json']))
      return { followUpDispatchId: pickId(res, 'dispatch') || null, followUpTaskId: pickId(res, 'task') || null }
    },

    // Human decision gate: a gate on its own task, polled read-only with gate-list (no mail is consumed). Approval
    // needs the exact gate created here, the "resolved" status and a resolution; anything else is not approval.
    async gate({ question, title, timeoutMs, workerIds = [] }) {
      const base = { via: 'orca gate', answer: null }
      const taskId = await api.taskCreate(`Human decision for ${title}: ${question}`, title)
      const g = await exec(['orchestration', 'gate-create', '--task', taskId, '--question', question, '--options', JSON.stringify(['approve', 'deny']), '--json'])
      const gateId = pickId(g, 'gate')
      if (!gateId) return { ...base, taskId, error: 'gate-create returned no gate id' }
      const deadline = Date.now() + timeoutMs
      while (Date.now() < deadline) {
        const list = await exec(['orchestration', 'gate-list', '--task', taskId, '--json'])
        const gates = deepFind(list, (k, v) => Array.isArray(v) && v.some(x => x && typeof x === 'object' && 'status' in x)) || []
        const gate = gates.find(x => x && (x.id === gateId || x.gateId === gateId))
        if (gate) {
          if ((gate.taskId ?? gate.task_id ?? taskId) !== taskId) return { ...base, gateId, taskId, error: 'gate belongs to another task' }
          const status = String(gate.status || '').toLowerCase()
          if (!PENDING.has(status)) {
            if (status !== 'resolved') return { ...base, gateId, taskId, status, error: `gate ended as "${status}"` }
            const by = gate.resolvedBy ?? gate.resolved_by ?? gate.resolver ?? null
            if (by && (workerIds.some(w => JSON.stringify(by).includes(w)) || /dispatch|worker|agent/i.test(JSON.stringify(by)))) {
              return { ...base, gateId, taskId, status, error: 'the gate was resolved by an agent, not a person' }
            }
            return { ...base, answer: typeof gate.resolution === 'string' ? gate.resolution : null, gateId, taskId, status }
          }
        }
        await sleep(pollMs)
      }
      return { ...base, gateId, taskId, timedOut: true }
    },

    async version() {
      if (!bin) bin = cfg.bins.orca ? which(cfg.bins.orca, env) : (which('orca', env) || which('orca-ide', env))
      if (!bin) return null
      const r = await run(bin, ['--version'], { timeoutMs: 15000, env: childEnv })
      return (r.stdout.match(/\d+\.\d+\.\d+/) || [null])[0]
    }
  }
  return api
}

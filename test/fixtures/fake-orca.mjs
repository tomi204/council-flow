// fake-orca.mjs: plays the Orca CLI for `--dry-run` with COUNCIL_ORCA=on and for the tests. No Orca, no agents.
// State lives in COUNCIL_FAKE_ORCA_STATE (a JSON file); every call (full argv and stdin) is appended to state.calls.
// worker-start creates a real git worktree (under <repo>/.council-flow/fake-orca-worktrees/) and plays the
// implementer; send plays a fix round as a follow-up Task with its own dispatch id.
// Knobs:
//   COUNCIL_FAKE_GATE            resolution: approve | deny (default deny)
//   COUNCIL_FAKE_GATE_STATUS     status of a decided gate (default resolved), e.g. cancelled
//   COUNCIL_FAKE_GATE_NOID=1     gate-create returns no gate id
//   COUNCIL_FAKE_GATE_OTHER=1    gate-list shows only some other gate (resolved "approve")
//   COUNCIL_FAKE_GATE_BY         resolvedBy value on the gate (e.g. "dispatch:dsp_fake_4")
//   COUNCIL_FAKE_WORKER_OUTCOME  succeeded (default) | failed | none (worker_done without an outcome)
//   COUNCIL_FAKE_ORCA_DECOY=1    a foreign worker_done that mentions our dispatch id arrives first
//   COUNCIL_FAKE_FIX             noop: send changes nothing
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'

const args = process.argv.slice(2)
const STATE = process.env.COUNCIL_FAKE_ORCA_STATE || path.join(os.tmpdir(), 'council-fake-orca-state.json')
const flag = (f) => { const i = args.indexOf(f); return i >= 0 ? args[i + 1] : undefined }
const out = (result) => process.stdout.write(JSON.stringify({ ok: true, result }) + '\n')
const fail = (code, message) => { process.stdout.write(JSON.stringify({ ok: false, error: { code, message } }) + '\n'); save(); process.exit(1) }

let state
try { state = JSON.parse(fs.readFileSync(STATE, 'utf8')) } catch { state = { n: 0, calls: [], tasks: {}, dispatches: {}, mail: [], gates: {} } }
function save() { fs.mkdirSync(path.dirname(STATE), { recursive: true }); fs.writeFileSync(STATE, JSON.stringify(state, null, 1)) }
const id = (p) => `${p}_fake_${++state.n}`
// Like production git calls: no hooks, no inherited repository overrides; writes never follow a symlink.
const gitEnv = Object.fromEntries(Object.entries(process.env).filter(([k]) => !/^GIT_/.test(k)))
function put(file, data, append = false) {
  const C = fs.constants
  const fd = fs.openSync(file, C.O_WRONLY | C.O_CREAT | C.O_NOFOLLOW | (append ? C.O_APPEND : C.O_TRUNC), 0o644)
  try { fs.writeSync(fd, data) } finally { fs.closeSync(fd) }
}
const done = (dsp) => {
  const o = process.env.COUNCIL_FAKE_WORKER_OUTCOME || 'succeeded'
  if (process.env.COUNCIL_FAKE_ORCA_DECOY) state.mail.push({ id: id('msg'), type: 'worker_done', dispatchId: 'dsp_someone_else', body: `I saw ${dsp} finish`, payload: { outcome: 'succeeded' } })
  state.mail.push({ id: id('msg'), type: 'worker_done', dispatchId: dsp, payload: o === 'none' ? {} : { outcome: o } })
  if (o !== 'none') state.dispatches[dsp].outcome = o
}

let stdin = ''
if (flag('--spec-file') === '-') stdin = fs.readFileSync(0, 'utf8')
state.calls.push({ args, stdin })

const [a0, a1] = args
if (a0 === '--version') { process.stdout.write('0.0.0-fake\n'); process.exit(0) }
if (a0 === 'status') out({ runtime: { state: 'ready', reachable: true } })
else if (a0 === 'worktree' && a1 === 'show') {
  const name = String(flag('--worktree') || '').replace(/^name:/, '')
  const d = Object.values(state.dispatches).find(x => x.name === name)
  d ? out({ worktree: { path: d.path } }) : fail('not_found', 'no such worktree')
} else if (a0 === 'orchestration') {
  if (a1 === 'run-create') { const runId = id('run'); out({ run: { id: runId, objective: flag('--objective') } }) }
  else if (a1 === 'task-create') { const t = id('task'); state.tasks[t] = { title: flag('--task-title'), spec: stdin }; out({ task: { id: t } }) }
  else if (a1 === 'worker-start') {
    for (const f of ['--task', '--worktree', '--agent', '--repo', '--base-branch']) if (!flag(f)) fail('bad_args', `missing ${f}`)
    const repo = flag('--repo').replace(/^path:/, '')
    const name = flag('--name') || id('wt')
    const wt = path.join(repo, '.council-flow', 'fake-orca-worktrees', name)
    execFileSync('git', ['-c', 'core.hooksPath=/dev/null', '-C', repo, 'worktree', 'add', '-q', '-b', `orca/${name}`, wt, flag('--base-branch')], { stdio: 'ignore', env: gitEnv })
    try { put(path.join(wt, 'hello.txt'), 'hello council\n') } catch (e) { fail('agent_failed', `refusing to write hello.txt: ${e.code}`) }   // the "agent" implements
    const d = id('dsp')
    state.dispatches[d] = { name, path: wt, agent: flag('--agent'), task: flag('--task') }
    done(d)
    out({ status: 'ready', dispatch: { id: d, taskId: flag('--task') }, repo: { path: repo }, workspace: { worktreePath: wt, branch: `orca/${name}` } })
  } else if (a1 === 'check') {
    const msgs = state.mail.splice(0)
    out({ delivery: { id: id('dlv'), messages: msgs } })
  } else if (a1 === 'worker-show') {
    const d = state.dispatches[flag('--dispatch')]
    d ? out({ dispatch: { id: flag('--dispatch'), ...(d.outcome ? { outcome: d.outcome } : {}) } }) : fail('not_found', 'no such dispatch')
  } else if (a1 === 'send') {
    const from = String(flag('--to')).replace(/^dispatch:/, '')
    const d = state.dispatches[from]
    if (!d) fail('not_found', 'no such dispatch')
    const round = (String(flag('--subject')).match(/round (\d+)/) || [0, '?'])[1]
    if (process.env.COUNCIL_FAKE_FIX !== 'noop') put(path.join(d.path, 'hello.txt'), `fixed in round ${round}\n`, true)
    const follow = id('dsp')                                         // a finished worker gets a follow-up Task
    state.dispatches[follow] = { ...d, followUpOf: from }
    done(follow)
    out({ message: { id: id('msg') }, delivery: 'follow-up task', task: { id: id('task') }, dispatch: { id: follow } })
  } else if (a1 === 'gate-create') {
    const g = id('gate')
    state.gates[g] = { id: g, taskId: flag('--task'), question: flag('--question'), options: JSON.parse(flag('--options') || '[]'), status: 'pending' }
    out(process.env.COUNCIL_FAKE_GATE_NOID ? { gate: { status: 'pending' } } : { gate: { id: g, status: 'pending' } })
  } else if (a1 === 'gate-list') {
    if (process.env.COUNCIL_FAKE_GATE_OTHER) out({ gates: [{ id: 'gate_other', taskId: flag('--task'), status: 'resolved', resolution: 'approve' }] })
    else {
      const gates = Object.values(state.gates).filter(g => g.taskId === flag('--task'))
      for (const g of gates) Object.assign(g, { status: process.env.COUNCIL_FAKE_GATE_STATUS || 'resolved', resolution: process.env.COUNCIL_FAKE_GATE || 'deny' },
        process.env.COUNCIL_FAKE_GATE_BY ? { resolvedBy: process.env.COUNCIL_FAKE_GATE_BY } : {})
      out({ gates })
    }
  } else fail('unknown_command', `fake orca has no orchestration ${a1}`)
} else fail('unknown_command', `fake orca has no ${a0}`)
save()

// Orca mode with the fake Orca CLI, the strict receipt parsing, the gate's binding rules, and auto-detection.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runPipeline } from '../src/pipeline.mjs'
import { createOrca, deepFind, pickId, collectMessages, findWorktreePath, FAKE_ORCA } from '../src/orca.mjs'
import { loadConfig } from '../src/config.mjs'
import { decide, isApproval, bindingMatches } from '../src/gate.mjs'
import { toyRepo, testEnv, quiet, runDir, readJson, tmp, FAKE_KEY } from './helpers.mjs'

const binding = { tree: 't1', base: 'b1', worktree: '/w', dest: 'council/x' }

test('receipt helpers: explicit ids only; one unambiguous worktree that is not the primary checkout', () => {
  assert.equal(pickId({ run: { id: 'run_1' } }, 'run'), 'run_1')
  assert.equal(pickId({ receipt: { dispatchId: 'd_2' } }, 'dispatch'), 'd_2')
  assert.equal(pickId({ id: 'task_3' }, 'task'), undefined, 'a bare id is not trusted')
  assert.deepEqual(collectMessages({ delivery: { messages: [{ type: 'worker_done', id: 'm' }] } }).map(m => m.id), ['m'])
  const toy = toyRepo(), other = toyRepo()
  assert.equal(findWorktreePath({ workspace: { worktreePath: other.dir }, repo: { path: toy.dir } }, toy.dir), other.dir)
  assert.equal(findWorktreePath({ workspace: { worktreePath: toy.dir } }, toy.dir), undefined, 'the primary checkout is never the worker worktree')
  const third = toyRepo()
  assert.throws(() => findWorktreePath({ a: { worktreePath: other.dir }, b: { worktree_path: third.dir } }, toy.dir), /ambiguous/)
  assert.equal(findWorktreePath({ repoPath: other.dir }, toy.dir), undefined, 'path-like keys that are not worktree fields are ignored')
  assert.equal(deepFind({ a: [{ b: { outcome: 'failed' } }] }, (k) => k === 'outcome'), 'failed')
})

test('auto-detect: no Orca terminal handle means the git-worktree fallback, with the reason', async () => {
  const dir = tmp('council-orcabin-')
  const bin = path.join(dir, 'orca')
  fs.writeFileSync(bin, `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ORCA}" "$@"\n`, { mode: 0o755 })
  const env = testEnv({ COUNCIL_ORCA_BIN: bin, COUNCIL_FAKE_ORCA_STATE: path.join(dir, 'state.json') })
  const noTerm = await createOrca(loadConfig({}, env), { env }).detect()
  assert.equal(noTerm.usable, false)
  assert.match(noTerm.reason, /ORCA_TERMINAL_HANDLE unset/)
  assert.equal((await createOrca(loadConfig({}, { ...env, ORCA_TERMINAL_HANDLE: 'term_x' }), { env }).detect()).usable, true)
  assert.equal((await createOrca(loadConfig({}, { ...env, ORCA_TERMINAL_HANDLE: 'term_x', COUNCIL_ORCA: 'off' }), { env }).detect()).usable, false)
  assert.match((await createOrca(loadConfig({}, { ...env, COUNCIL_ORCA_BIN: path.join(dir, 'nope') }), { env }).detect()).reason, /not found/)
})

test('approval is the exact answer "approve" only; the binding must match', () => {
  for (const a of ['approve', 'Approve', ' approve\n']) assert.ok(isApproval(a), a)
  for (const a of ['approve after the tests pass', 'approved', 'yes', 'y', 'ok', 'deny', '', null, 'not approve']) assert.ok(!isApproval(a), String(a))
  assert.ok(bindingMatches({ decision: 'approve', binding }, binding))
  assert.ok(!bindingMatches({ decision: 'approve', binding: { ...binding, tree: 't2' } }, binding))
  assert.ok(!bindingMatches({ decision: 'approve', binding: null }, binding))
  assert.ok(!bindingMatches({ decision: 'deny', binding }, binding))
})

test('gate: no TTY and no Orca denies; dry-run uses COUNCIL_FAKE_GATE; an Orca error denies', async () => {
  const notTTY = { isTTY: false }
  const real = await decide({ cfg: loadConfig({}, {}), env: {}, orcaUsable: false, question: 'Open PR?', input: notTTY, binding })
  assert.deepEqual([real.decision, real.via, real.binding], ['deny', 'none', binding])
  assert.equal((await decide({ cfg: loadConfig({ dryRun: true }, {}), env: { COUNCIL_FAKE_GATE: 'approve' }, orcaUsable: false, question: 'q', input: notTTY })).decision, 'approve')
  assert.equal((await decide({ cfg: loadConfig({ dryRun: true }, {}), env: { COUNCIL_FAKE_GATE: 'approve later' }, orcaUsable: false, question: 'q', input: notTTY })).decision, 'deny')
  const broken = await decide({ cfg: loadConfig({}, {}), env: {}, orcaUsable: true, orca: { gate: async () => { throw new Error('orca down') } }, question: 'q', input: notTTY })
  assert.deepEqual([broken.decision, broken.error], ['deny', 'orca down'])
})

async function orcaGate(extraEnv) {
  const state = path.join(tmp('council-orcastate-'), 'state.json')
  const env = testEnv({ COUNCIL_FAKE_ORCA_STATE: state, ...extraEnv })
  const cfg = loadConfig({ dryRun: true }, { ...env, COUNCIL_ORCA: 'on', COUNCIL_GATE_TIMEOUT_MS: '400' })
  return decide({ cfg, env, orca: createOrca(cfg, { env }), orcaUsable: true, question: 'Open PR?', title: 't', binding, workerIds: ['dsp_fake_4'], input: { isTTY: false } })
}

test('Orca gate: only the exact gate created here, with status "resolved" and resolution "approve", approves', async () => {
  assert.equal((await orcaGate({ COUNCIL_FAKE_GATE: 'approve' })).decision, 'approve')
  assert.equal((await orcaGate({ COUNCIL_FAKE_GATE: 'approve after the tests pass' })).decision, 'deny')
  const noId = await orcaGate({ COUNCIL_FAKE_GATE: 'approve', COUNCIL_FAKE_GATE_NOID: '1' })
  assert.deepEqual([noId.decision, noId.error], ['deny', 'gate-create returned no gate id'])
  const other = await orcaGate({ COUNCIL_FAKE_GATE_OTHER: '1' })
  assert.deepEqual([other.decision, other.timedOut], ['deny', true], 'another gate resolved "approve" is ignored')
  const cancelled = await orcaGate({ COUNCIL_FAKE_GATE: 'approve', COUNCIL_FAKE_GATE_STATUS: 'cancelled' })
  assert.equal(cancelled.decision, 'deny'); assert.match(cancelled.error, /cancelled/)
  const byAgent = await orcaGate({ COUNCIL_FAKE_GATE: 'approve', COUNCIL_FAKE_GATE_BY: 'dispatch:dsp_fake_4' })
  assert.equal(byAgent.decision, 'deny'); assert.match(byAgent.error, /agent, not a person/)
})

test('Orca mode (fake Orca): new-child worker with setup skipped, follow-up dispatch per fix, exact gate, no secret in argv', async () => {
  const toy = toyRepo()
  const state = path.join(tmp('council-orcastate-'), 'state.json')
  const res = await runPipeline({ task: 'Add a hello.txt greeting file', repo: toy.dir, dryRun: true, runId: 'orca-1' },
    { env: testEnv({ COUNCIL_ORCA: 'on', COUNCIL_FAKE_ORCA_STATE: state, COUNCIL_FAKE_GATE: 'deny', COUNCIL_FAKE_SECRET: FAKE_KEY, COUNCIL_FAKE_ORCA_DECOY: '1' }), log: quiet, noSignals: true })
  assert.equal(res.exitCode, 0, res.error)
  const run = readJson(path.join(runDir(toy.dir, 'orca-1'), 'run.json'))
  assert.equal(run.worktree.mode, 'orca')
  assert.equal(run.worktree.pushBranch, 'council/orca-1')
  assert.equal(run.worktree.dispatches.length, 2, 'the fix round waited on its own follow-up dispatch')
  assert.notEqual(run.worktree.dispatches[0], run.worktree.dispatches[1])
  const st = readJson(state)
  const calls = st.calls.map(c => c.args)
  const ws = calls.find(a => a[1] === 'worker-start')
  assert.deepEqual([ws[ws.indexOf('--worktree') + 1], ws[ws.indexOf('--agent') + 1], ws[ws.indexOf('--setup') + 1], ws[ws.indexOf('--base-branch') + 1]], ['new-child', 'codex', 'skip', toy.head])
  assert.ok(!ws.includes('--model'), 'no --model for codex unless COUNCIL_CODEX_MODEL is set')
  assert.ok(calls.filter(a => a[1] === 'check').every(a => a.includes('--run')), 'check is scoped to the recorded Run')
  assert.ok(st.calls.every(c => !JSON.stringify(c).includes(FAKE_KEY)), 'no secret in any Orca argv or stdin')
  assert.match(fs.readFileSync(path.join(run.worktree.path, 'hello.txt'), 'utf8'), /fixed in round 1/)
  assert.match(fs.readFileSync(path.join(runDir(toy.dir, 'orca-1'), 'orca/mail.jsonl'), 'utf8'), /dsp_someone_else/, 'foreign mail is kept, not dropped or mistaken for ours')
  assert.equal(readJson(path.join(runDir(toy.dir, 'orca-1'), 'gate.json')).via, 'orca gate')
  assert.ok(run.warnings.some(w => /Orca permission settings/.test(w)))
  assert.equal(run.outcome.status, 'declined')
})

test('Orca worker that fails, or reports done without an outcome: the implement stage fails (exit 2)', async () => {
  for (const outcome of ['failed', 'none']) {
    const toy = toyRepo()
    const state = path.join(tmp('council-orcastate-'), 'state.json')
    const res = await runPipeline({ task: 'Add a hello.txt greeting file', repo: toy.dir, dryRun: true, runId: `orca-${outcome}` },
      { env: testEnv({ COUNCIL_ORCA: 'on', COUNCIL_FAKE_ORCA_STATE: state, COUNCIL_FAKE_WORKER_OUTCOME: outcome }), log: quiet, noSignals: true })
    assert.equal(res.exitCode, 2)
    assert.match(res.outcome.error, outcome === 'none' ? /"no-outcome"/ : /"failed"/)
  }
})

test('reconcile: a dispatch that already settled is recognised from worker-show, without waiting for mail', async () => {
  const state = path.join(tmp('council-orcastate-'), 'state.json')
  fs.writeFileSync(state, JSON.stringify({ n: 0, calls: [], tasks: {}, mail: [], gates: {}, dispatches: { dsp_done: { outcome: 'succeeded' }, dsp_live: {} } }))
  const env = testEnv({ COUNCIL_FAKE_ORCA_STATE: state })
  const orca = createOrca(loadConfig({ dryRun: true }, { ...env, COUNCIL_ORCA: 'on' }), { env })
  assert.deepEqual(await orca.reconcile('dsp_done'), { settled: true, outcome: 'succeeded' })
  assert.deepEqual(await orca.reconcile('dsp_live'), { settled: false })
})

test('COUNCIL_ORCA_IMPLEMENT=headless: Orca still gates, but the implementer is the confined headless CLI', async () => {
  const toy = toyRepo()
  const state = path.join(tmp('council-orcastate-'), 'state.json')
  const res = await runPipeline({ task: 'Add a hello.txt greeting file', repo: toy.dir, dryRun: true, runId: 'orca-headless' },
    { env: testEnv({ COUNCIL_ORCA: 'on', COUNCIL_ORCA_IMPLEMENT: 'headless', COUNCIL_FAKE_ORCA_STATE: state }), log: quiet, noSignals: true })
  assert.equal(res.exitCode, 0, res.error)
  const run = readJson(path.join(runDir(toy.dir, 'orca-headless'), 'run.json'))
  assert.equal(run.worktree.mode, 'git')
  const cmds = readJson(state).calls.map(c => c.args.slice(0, 2).join(' '))
  assert.ok(!cmds.includes('orchestration worker-start'))
  assert.ok(cmds.includes('orchestration gate-create'))
})

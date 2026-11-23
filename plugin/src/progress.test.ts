// Workflow card status and stage, derived from what council-flow writes (run.json, the lock, file times).
import { assert, describe, test } from 'orca/testing'
import { findingsText, formatDuration, outcomeWords, phaseRank, progressOf, type ProgressInput, type RunState } from './progress'

const T0 = Date.UTC(2026, 10, 23, 10, 0, 0)
const at = (min: number) => new Date(T0 + min * 60_000).toISOString()
const ms = (min: number) => T0 + min * 60_000
const st = (start: number, end: number | null, status = end === null ? 'running' : 'done') => ({ status, startedAt: at(start), ...(end === null ? {} : { endedAt: at(end) }) })
const trail = (p: ReturnType<typeof progressOf>) => p.steps.map((s) => `${s.label}:${s.state}`).join(' ')

const audit = (over: RunState = {}): RunState => ({ mode: 'audit', config: { rounds: 3 }, ...over })
const run = (input: Partial<ProgressInput> & { state: RunState | null }) => progressOf({ mode: 'audit', lock: 'alive', lockAt: ms(0), ...input })

describe('audit loop', () => {
  test('context, then red & blue, then Codex review, in the loop\'s own words', () => {
    const ctx1 = run({ state: audit({ stages: { 'context-1': st(1, null) } }) })
    assert.equal(ctx1.phase, 'running')
    assert.equal(ctx1.label, 'Running')
    assert.equal(ctx1.stage, 'context')
    assert.equal(ctx1.stageStartedAt, ms(1))
    assert.equal(trail(ctx1), 'context:current red & blue:next Codex review:next re-context …:next tests:next approve:next')

    const teams = run({ state: audit({ stages: { 'context-1': st(1, 2), 'teams-1': st(2, null) }, auditLoop: { iterations: [{ number: 1 }] } }) })
    assert.equal(teams.stage, 'red & blue')
    assert.equal(teams.round, 'iteration 1/3')
    assert.equal(trail(teams), 'context:done red & blue:current Codex review:next re-context …:next tests:next approve:next')

    const review = run({ state: audit({ stages: { 'context-1': st(1, 2), 'teams-1': st(2, 5), 'review-1': st(5, null) } }) })
    assert.equal(review.stage, 'Codex review')
  })

  test('a later iteration starts with re-context and counts N/M', () => {
    const p = run({
      state: audit({
        stages: { 'context-1': st(1, 2), 'teams-1': st(2, 5), 'review-1': st(5, 6), 'context-2': st(6, null) },
        auditLoop: { iterations: [{ number: 1 }, { number: 2 }] }
      })
    })
    assert.equal(p.stage, 're-context')
    assert.equal(p.round, 'iteration 2/3')
    assert.equal(trail(p), 're-context:current red & blue:next Codex review:next re-context …:next tests:next approve:next')
    const last = run({ state: audit({ config: { rounds: 2 }, stages: { 'context-2': st(6, 7), 'teams-2': st(7, null) } }) })
    assert.equal(last.round, 'iteration 2/2')
    assert.ok(!last.steps.some((s) => s.label === 're-context …'), 'no further iteration on the last one')
  })

  test('--rounds 0 is one report-only iteration', () => {
    assert.equal(run({ state: audit({ config: { rounds: 0 }, stages: { 'teams-1': st(1, null) } }) }).round, 'iteration 1/1')
  })

  test('waiting for approve: summary written after the tests, no gate answer yet', () => {
    const state = audit({ stages: { 'review-2': st(5, 6), tests: st(6, 8) }, auditLoop: { iterations: [{ number: 1 }, { number: 2 }] } })
    const between = run({ state, summaryMtime: ms(7) })
    assert.equal(between.phase, 'running', 'summary older than the tests: regression tests and summary still to come')
    assert.equal(between.stage, 'regression tests and summary')

    const waiting = run({ state, summaryMtime: ms(8.5) })
    assert.equal(waiting.phase, 'waiting-approve')
    assert.equal(waiting.label, 'Waiting for approve')
    assert.equal(waiting.tone, 'warning')
    assert.equal(waiting.stageStartedAt, ms(8.5))
    assert.equal(trail(waiting), 'context:done red & blue:done Codex review:done tests:done approve:current')
    assert.equal(waiting.round, 'iteration 2/3')

    const stale = run({ state, summaryMtime: ms(8.5), gateMtime: ms(3) })
    assert.equal(stale.phase, 'waiting-approve', 'a gate.json from an earlier attempt does not count')

    const answered = run({ state, summaryMtime: ms(8.5), gateMtime: ms(9) })
    assert.equal(answered.phase, 'publishing')
  })

  test('a stage another, killed process left running is not this process\'s stage', () => {
    const p = run({ lockAt: ms(30), state: audit({ stages: { 'teams-1': st(2, null) } }) })
    assert.equal(p.phase, 'starting')
    assert.equal(p.label, 'Starting')
    assert.equal(p.stageStartedAt, ms(30))
    assert.equal(run({ lockAt: ms(30), state: null }).phase, 'starting')
  })

  test('findings: the ledger, open meaning open, confirmed or reopened', () => {
    const p = run({ state: audit({ stages: { 'teams-1': st(1, null) }, auditLoop: { ledger: [{ status: 'open' }, { status: 'fixed' }, { status: 'rejected' }, { status: 'confirmed' }, { status: 'reopened' }] } }) })
    assert.equal(p.findings, 5)
    assert.equal(p.open, 3)
    assert.equal(findingsText('audit', p), '5 findings, 3 open')
    assert.equal(findingsText('audit', { findings: 1, open: 0 }), '1 finding, 0 open')
    assert.equal(findingsText('audit', { findings: null, open: 2 }), '2 unresolved')
  })
})

describe('coding pipeline', () => {
  const code = (over: RunState = {}): RunState => ({ mode: 'code', config: { rounds: 2 }, ...over })
  const crun = (input: Partial<ProgressInput> & { state: RunState | null }) => progressOf({ mode: 'code', lock: 'alive', lockAt: ms(0), ...input })

  test('plan, implement, review, fix, tests, approve', () => {
    const plan = crun({ state: code({ stages: { plan: st(1, null) } }) })
    assert.equal(plan.stage, 'plan')
    assert.equal(plan.round, null)
    assert.equal(findingsText('code', plan), null)
    const fix = crun({ state: code({ stages: { plan: st(1, 2), implement: st(2, 4), 'review-1': st(4, 5), 'fix-1': st(5, null) }, loop: { n: 1, fixRounds: 0, findings: [{ severity: 'major' }, { severity: 'minor' }] } }) })
    assert.equal(fix.stage, 'fix')
    assert.equal(fix.round, 'review round 1 · fixes 0/2')
    assert.equal(trail(fix), 'plan:done implement:done review:done fix:current tests:next approve:next')
    assert.equal(findingsText('code', fix), '2 open findings, 1 blocking')
    assert.equal(findingsText('code', { findings: 0, open: 0 }), 'no open findings')
  })

  test('the gate stage waits for approve until gate.json is written, then publishes', () => {
    const state = code({ stages: { tests: st(5, 6), gate: st(6, null) }, loop: { n: 2, fixRounds: 1, findings: [] } })
    const waiting = crun({ state })
    assert.equal(waiting.phase, 'waiting-approve')
    assert.equal(waiting.stageStartedAt, ms(6))
    assert.equal(trail(waiting), 'plan:done implement:done review:done fix:done tests:done approve:current')
    const publishing = crun({ state, gateMtime: ms(7) })
    assert.equal(publishing.phase, 'publishing')
    assert.equal(publishing.stage, 'publish')
    assert.equal(publishing.steps.at(-1)?.label, 'publish')
  })
})

describe('finished runs', () => {
  test('done: the outcome in words, every step lit', () => {
    const p = progressOf({ mode: 'audit', lock: 'none', state: audit({ stages: { 'context-1': st(1, 2), tests: st(5, 6) }, outcome: { status: 'committed-local', unresolved: 1 } }) })
    assert.equal(p.phase, 'done')
    assert.equal(p.label, 'Done')
    assert.equal(p.tone, 'success')
    assert.equal(p.outcome, 'committed locally')
    assert.equal(p.stage, null)
    assert.ok(p.steps.every((s) => s.state === 'done'))
    assert.ok(!p.steps.some((s) => s.label === 're-context …'))
  })

  test('a declined gate is done, not a success, and its approve step stays unlit', () => {
    const p = progressOf({ mode: 'audit', lock: 'stale', state: audit({ stages: { tests: st(5, 6) }, outcome: { status: 'declined' } }) })
    assert.equal(p.phase, 'done')
    assert.equal(p.tone, 'neutral')
    assert.equal(p.outcome, 'gate declined')
    assert.equal(p.steps.at(-1)?.state, 'next')
  })

  test('failed: the stage that failed', () => {
    const p = progressOf({ mode: 'code', lock: 'none', state: { mode: 'code', stages: { plan: st(1, 2), implement: st(2, 3, 'failed') }, outcome: { status: 'failed' } } })
    assert.equal(p.phase, 'failed')
    assert.equal(p.label, 'Failed')
    assert.equal(p.tone, 'danger')
    assert.equal(p.outcome, 'failed at implement')
    assert.equal(trail(p), 'plan:done implement:failed review:next fix:next tests:next approve:next')
  })

  test('interrupted: no live process and no outcome, or a newer stage left running', () => {
    const none = progressOf({ mode: 'audit', lock: 'stale', state: audit({ stages: { 'teams-1': st(1, null) } }) })
    assert.equal(none.phase, 'interrupted')
    assert.equal(none.label, 'Interrupted')
    assert.equal(none.outcome, 'stopped at red & blue')
    // Resumed after a declined gate, then the terminal was closed mid-stage: the old outcome is stale.
    const resumed = progressOf({ mode: 'audit', lock: 'none', state: audit({ stages: { tests: st(5, 6), 'context-2': st(60, null) }, outcome: { status: 'declined' } }) })
    assert.equal(resumed.phase, 'interrupted')
    assert.equal(resumed.outcome, 'stopped at re-context')
    // An old stage left running that a later attempt never re-ran does not hide the real outcome.
    const old = progressOf({ mode: 'audit', lock: 'none', state: audit({ stages: { 'teams-1': st(1, null), 'teams-2': st(10, 12), tests: st(12, 13) }, outcome: { status: 'declined' } }) })
    assert.equal(old.phase, 'done')
  })

  test('locked by another host', () => {
    const p = progressOf({ mode: 'audit', lock: 'other-host', state: audit({}) })
    assert.equal(p.phase, 'elsewhere')
    assert.equal(p.label, 'Running elsewhere')
  })

  test('malformed run.json never throws', () => {
    for (const state of [null, {}, { stages: null }, { stages: { x: null } } as unknown as RunState, { stages: { 'review-x': { status: 3 } } } as unknown as RunState, { auditLoop: { ledger: 'no' } } as unknown as RunState, { loop: { n: 'one' } } as unknown as RunState]) {
      for (const lock of ['alive', 'none', 'stale', 'other-host'] as const) {
        const p = progressOf({ mode: 'audit', lock, state })
        assert.equal(typeof p.label, 'string')
        progressOf({ mode: 'code', lock, state })
      }
    }
  })
})

describe('helpers', () => {
  test('waiting first, then live, then the rest', () => {
    const order = (['done', 'running', 'interrupted', 'waiting-approve', 'starting', 'failed', 'publishing', 'elsewhere'] as const).slice().sort((a, b) => phaseRank(a) - phaseRank(b))
    assert.equal(order[0], 'waiting-approve')
    assert.deepEqual(order.slice(1, 4).sort(), ['publishing', 'running', 'starting'])
    assert.equal(order[4], 'elsewhere')
  })

  test('outcome words', () => {
    assert.deepEqual(outcomeWords('pr-opened'), ['PR opened', 'success'])
    assert.deepEqual(outcomeWords('tests-incomplete'), ['not committed: tests incomplete', 'warning'])
    assert.deepEqual(outcomeWords('something-new'), ['something-new', 'warning'])
  })

  test('durations', () => {
    assert.equal(formatDuration(12_000), '12s')
    assert.equal(formatDuration(4 * 60_000 + 10_000), '4m')
    assert.equal(formatDuration(65 * 60_000), '1h 5m')
    assert.equal(formatDuration(2 * 3600_000), '2h')
    assert.equal(formatDuration(51 * 3600_000), '2d 3h')
    assert.equal(formatDuration(-5), '0s')
  })
})

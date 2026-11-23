// The fix loop: stops when clean / at max rounds / when a fix changes nothing; failed fixes roll back and are retried
// on resume; unreviewed rounds keep the earlier findings; resume re-reviews a changed worktree and re-runs failed tests.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runPipeline } from '../src/pipeline.mjs'
import { toyRepo, testEnv, quiet, runDir, readJson, git, tmp } from './helpers.mjs'

const dry = (repo, runId, env = {}, extra = {}, deps = {}) => runPipeline({ task: 'Add a hello.txt greeting file', repo, dryRun: true, runId, ...extra }, { env: testEnv(env), log: quiet, noSignals: true, ...deps })
const resume = (repo, runId, env = {}, extra = {}, deps = {}) => runPipeline({ resume: runId, repo, dryRun: true, ...extra }, { env: testEnv(env), log: quiet, noSignals: true, ...deps })
const state = (repo, id) => readJson(path.join(runDir(repo, id), 'run.json'))
const stages = (repo, id) => Object.keys(state(repo, id).stages)

test('clean after one fix: review 1 -> fix 1 -> review 2 clean, no second fix; reviews bound to trees', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'clean')
  assert.equal(res.exitCode, 0, res.error)
  assert.deepEqual(stages(toy.dir, 'clean'), ['plan', 'implement', 'review-1', 'fix-1', 'review-2', 'tests', 'gate'])
  const dir = runDir(toy.dir, 'clean')
  const r1 = readJson(path.join(dir, 'reviews/round-1/merged.json')), r2 = readJson(path.join(dir, 'reviews/round-2/merged.json'))
  assert.equal(r1.blocking, 1); assert.equal(r2.blocking, 0)
  const fix = readJson(path.join(dir, 'fix/round-1/result.json'))
  assert.deepEqual([fix.beforeTree, fix.afterTree], [r1.tree, r2.tree])
  const run = state(toy.dir, 'clean')
  assert.equal(run.candidate.tree, r2.tree, 'the candidate is exactly the last reviewed tree')
  assert.equal(readJson(path.join(dir, 'tests/result.json')).tree, r2.tree)
  assert.match(fs.readFileSync(path.join(dir, 'fix/round-1/incremental.patch'), 'utf8'), /\+fixed in round 1/)
  assert.match(fs.readFileSync(path.join(dir, 'fix/round-1/prompt.md'), 'utf8'), /\[MAJOR\]\[test\] hello\.txt:1/)
  assert.equal(res.outcome.ready, true)
})

test('blockers every round: stops at max rounds with open findings and escalates', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'maxed', { COUNCIL_FAKE_REVIEW: 'always' }, { rounds: 1 })
  assert.equal(res.exitCode, 0, res.error)
  assert.deepEqual(stages(toy.dir, 'maxed'), ['plan', 'implement', 'review-1', 'fix-1', 'review-2', 'tests', 'gate'])
  const { loop, outcome } = state(toy.dir, 'maxed')
  assert.deepEqual([loop.n, loop.fixRounds, loop.stopReason, loop.reviewed], [2, 1, 'max fix rounds (1) reached', true])
  assert.equal(outcome.ready, false)
  assert.ok(outcome.reasons.some(r => /1 blocker finding/.test(r)))
  assert.match(readJson(path.join(runDir(toy.dir, 'maxed'), 'gate.json')).question, /needs a decision.*DRAFT PR/)
  assert.match(fs.readFileSync(path.join(runDir(toy.dir, 'maxed'), 'summary.md'), 'utf8'), /\| blocker \| bug \| hello\.txt:1 \|/)
})

test('default --rounds 2 with blockers every round: exactly two fixes and three reviews; --rounds 0: no fix', async () => {
  const toy = toyRepo()
  await dry(toy.dir, 'two', { COUNCIL_FAKE_REVIEW: 'always' })
  assert.deepEqual(stages(toy.dir, 'two'), ['plan', 'implement', 'review-1', 'fix-1', 'review-2', 'fix-2', 'review-3', 'tests', 'gate'])
  await dry(toy.dir, 'zero', { COUNCIL_FAKE_REVIEW: 'always' }, { rounds: 0 })
  assert.deepEqual(stages(toy.dir, 'zero'), ['plan', 'implement', 'review-1', 'tests', 'gate'])
})

test('a fix that changes nothing ends the loop early', async () => {
  const toy = toyRepo()
  await dry(toy.dir, 'noop', { COUNCIL_FAKE_REVIEW: 'always', COUNCIL_FAKE_FIX: 'noop' })
  const run = state(toy.dir, 'noop')
  assert.deepEqual(Object.keys(run.stages), ['plan', 'implement', 'review-1', 'fix-1', 'tests', 'gate'])
  assert.equal(run.loop.stopReason, 'fix round 1 changed nothing')
})

test('a fix that writes and then fails is rolled back to the reviewed tree, escalated, and retried on resume', async () => {
  const toy = toyRepo()
  const first = await dry(toy.dir, 'badfix', { COUNCIL_FAKE_FIX: 'write-then-fail' })
  assert.equal(first.exitCode, 0, first.error)
  let run = state(toy.dir, 'badfix')
  assert.match(run.loop.stopReason, /fix round 1 failed \(rolled back\)/)
  assert.equal(run.loop.retry, 'fix')
  assert.equal(run.candidate.tree, run.loop.reviewedTree, 'nothing unreviewed is offered for approval')
  assert.doesNotMatch(fs.readFileSync(path.join(run.worktree.path, 'hello.txt'), 'utf8'), /fixed in round/)
  assert.equal(run.outcome.ready, false, 'the major from round 1 is still open')
  const second = await resume(toy.dir, 'badfix')
  assert.equal(second.exitCode, 0, second.error)
  run = state(toy.dir, 'badfix')
  assert.deepEqual([run.loop.fixRounds, run.loop.stopReason, run.outcome.ready], [1, 'clean (no blocker or major)', true])
  assert.ok(run.stages['review-2'])
})

test('a round with no valid review keeps the earlier findings open, is not "clean", and is retried on resume', async () => {
  const toy = toyRepo()
  const first = await dry(toy.dir, 'noreview', { COUNCIL_FAKE_REVIEW_FAIL_FROM: '2' })
  assert.equal(first.exitCode, 0, first.error)
  let run = state(toy.dir, 'noreview')
  assert.deepEqual([run.loop.reviewed, run.loop.retry, run.loop.reviewedRound], [false, 'review', 1])
  assert.equal(run.loop.findings.filter(f => f.severity === 'major').length, 1, 'round 1 findings carried forward')
  assert.ok(run.outcome.reasons.some(r => /latest change was not reviewed/.test(r)))
  const summary = fs.readFileSync(path.join(runDir(toy.dir, 'noreview'), 'summary.md'), 'utf8')
  assert.match(summary, /candidate tree has not been reviewed/)
  assert.doesNotMatch(summary, /No open findings/)
  const second = await resume(toy.dir, 'noreview')
  assert.equal(second.exitCode, 0, second.error)
  run = state(toy.dir, 'noreview')
  assert.deepEqual([run.loop.reviewed, run.outcome.ready], [true, true])
})

test('resume after the worktree was edited: the new tree is reviewed again and tests re-run', async () => {
  const toy = toyRepo()
  await dry(toy.dir, 'edited', { COUNCIL_FAKE_REVIEW: 'clean' })
  let run = state(toy.dir, 'edited')
  const firstTree = run.candidate.tree
  fs.appendFileSync(path.join(run.worktree.path, 'hello.txt'), 'edited by hand\n')
  await resume(toy.dir, 'edited', { COUNCIL_FAKE_REVIEW: 'clean' })
  run = state(toy.dir, 'edited')
  assert.ok(run.stages['review-2'], 'a second review round ran')
  assert.notEqual(run.candidate.tree, firstTree)
  assert.equal(readJson(path.join(runDir(toy.dir, 'edited'), 'reviews/round-2/merged.json')).tree, run.candidate.tree)
  assert.equal(readJson(path.join(runDir(toy.dir, 'edited'), 'tests/result.json')).tree, run.candidate.tree)
})

test('failing tests escalate; resuming with a corrected --test-cmd re-runs them; a passing result is reused for the same tree', async () => {
  const toy = toyRepo()
  await dry(toy.dir, 'redtests', { COUNCIL_FAKE_REVIEW: 'clean' }, { testCmd: 'echo boom >&2; exit 3' })
  const dir = runDir(toy.dir, 'redtests')
  assert.deepEqual([readJson(path.join(dir, 'tests/result.json')).status, readJson(path.join(dir, 'tests/result.json')).exitCode], ['failed', 3])
  assert.match(fs.readFileSync(path.join(dir, 'tests/output.txt'), 'utf8'), /boom/)
  assert.equal(state(toy.dir, 'redtests').outcome.ready, false)
  await resume(toy.dir, 'redtests', { COUNCIL_FAKE_REVIEW: 'clean' }, { testCmd: 'node check.mjs' })
  assert.equal(readJson(path.join(dir, 'tests/result.json')).status, 'passed')
  assert.equal(state(toy.dir, 'redtests').outcome.ready, true)
  const lines = []
  await runPipeline({ resume: 'redtests', repo: toy.dir, dryRun: true }, { env: testEnv({ COUNCIL_FAKE_REVIEW: 'clean' }), log: (m) => lines.push(m), noSignals: true })
  assert.ok(lines.some(l => /reusing the passing result/.test(l)), 'the saved --test-cmd and the passing result are reused')
})

test('files written by the tests are not part of the candidate tree', async () => {
  const toy = toyRepo()
  await dry(toy.dir, 'gen', { COUNCIL_FAKE_REVIEW: 'clean' }, { testCmd: 'node check.mjs && echo junk > generated.txt' })
  const run = state(toy.dir, 'gen')
  assert.equal(readJson(path.join(runDir(toy.dir, 'gen'), 'tests/result.json')).wroteFiles, true)
  assert.doesNotMatch(git(run.worktree.path, 'ls-tree', '-r', '--name-only', run.candidate.tree), /generated\.txt/)
  assert.doesNotMatch(git(run.worktree.path, 'diff', '--cached', '--name-only', run.worktree.baseCommit), /generated\.txt/, 'the index is back to the candidate')
  assert.ok(!fs.existsSync(path.join(run.worktree.path, 'generated.txt')), 'the test output is undone in the worktree too')
  // A resume with no edits: same candidate, no new review, generated.txt never becomes a change.
  await resume(toy.dir, 'gen', { COUNCIL_FAKE_REVIEW: 'clean' })
  const again = state(toy.dir, 'gen')
  assert.equal(again.candidate.tree, run.candidate.tree)
  assert.ok(!again.stages['review-2'], 'no spurious re-review')
})

test('owner edits made after a rolled-back fix survive the resume and are reviewed instead of overwritten', async () => {
  const toy = toyRepo()
  await dry(toy.dir, 'ownerfix', { COUNCIL_FAKE_FIX: 'write-then-fail' })
  let run = state(toy.dir, 'ownerfix')
  assert.equal(run.loop.retry, 'fix')
  fs.appendFileSync(path.join(run.worktree.path, 'hello.txt'), 'corrected by the owner\n')
  fs.writeFileSync(path.join(run.worktree.path, 'owner-note.txt'), 'added by the owner\n')
  const res = await resume(toy.dir, 'ownerfix')
  assert.equal(res.exitCode, 0, res.error)
  run = state(toy.dir, 'ownerfix')
  assert.match(fs.readFileSync(path.join(run.worktree.path, 'hello.txt'), 'utf8'), /corrected by the owner/)
  assert.ok(fs.existsSync(path.join(run.worktree.path, 'owner-note.txt')))
  assert.match(git(run.worktree.path, 'ls-tree', '-r', '--name-only', run.candidate.tree), /owner-note\.txt/)
  assert.equal(readJson(path.join(runDir(toy.dir, 'ownerfix'), 'reviews/round-2/merged.json')).tree, run.candidate.tree, 'the owner\'s tree was reviewed')
  assert.ok(run.warnings.some(w => /changed after the rolled-back fix/.test(w)))
})

test('no valid review for the candidate: the project tests are not executed', async () => {
  const toy = toyRepo()
  const marker = path.join(tmp('council-marker-'), 'tests-ran')
  const res = await dry(toy.dir, 'skiptests', { COUNCIL_FAKE_REVIEW_FAIL_FROM: '1' }, { testCmd: `touch '${marker}'` })
  assert.equal(res.exitCode, 0, res.error)
  assert.ok(!fs.existsSync(marker), 'the test command ran on an unreviewed tree')
  assert.equal(readJson(path.join(runDir(toy.dir, 'skiptests'), 'tests/result.json')).status, 'skipped')
  assert.ok(res.outcome.reasons.some(r => /tests skipped/.test(r)))
})

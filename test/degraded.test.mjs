// Degraded mode: a missing member, a member that times out, too few planners, judge / implementer fallback,
// and the one JSON retry.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runPipeline } from '../src/pipeline.mjs'
import { toyRepo, testEnv, quiet, runDir, readJson, walk, tmp, git } from './helpers.mjs'

const dry = (repo, runId, env = {}, extra = {}) => runPipeline({ task: 'Add a hello.txt greeting file', repo, dryRun: true, runId, ...extra }, { env: testEnv(env), log: quiet, noSignals: true })

test('missing member: marked unavailable, two planners, one reviewer, the summary says so', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'missing', { COUNCIL_FAKE_MISSING: 'fx' })
  assert.equal(res.exitCode, 0, res.error)
  const dir = runDir(toy.dir, 'missing')
  const run = readJson(path.join(dir, 'run.json'))
  assert.equal(run.members.fx.status, 'unavailable')
  assert.match(run.members.fx.reason, /not installed/)
  assert.deepEqual(Object.keys(readJson(path.join(dir, 'verdict.json')).labels).sort(), ['A', 'B'])
  assert.deepEqual(readJson(path.join(dir, 'reviews/round-1/merged.json')).reviewers, ['claude'])
  assert.ok(!fs.existsSync(path.join(dir, 'plans/fx.md')))
  assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /fx unavailable: fx not installed/)
})

test('timeout: the member is killed at the deadline, marked unavailable, and the run goes on without it', async () => {
  const toy = toyRepo()
  const t0 = Date.now()
  const res = await dry(toy.dir, 'timeout', { COUNCIL_FAKE_TIMEOUT: 'fx:plan', COUNCIL_TIMEOUT_MS: '1500' })
  assert.equal(res.exitCode, 0, res.error)
  assert.ok(Date.now() - t0 < 30000, `took ${Date.now() - t0} ms`)
  const dir = runDir(toy.dir, 'timeout')
  const run = readJson(path.join(dir, 'run.json'))
  assert.equal(run.members.fx.status, 'unavailable')
  assert.match(run.members.fx.reason, /timed out during plan/)
  assert.ok(!walk(dir).some(f => f === 'reviews/round-1/fx.json'), 'a timed-out member does not review later')
  assert.equal(run.outcome.status, 'declined')
})

test('fewer than two planners: the run stops with exit 2 and a clear reason', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'lonely', { COUNCIL_FAKE_MISSING: 'fx,codex' })
  assert.equal(res.exitCode, 2)
  assert.match(res.outcome.error, /at least two available members/)
  assert.equal(readJson(path.join(runDir(toy.dir, 'lonely'), 'run.json')).stages.plan.status, 'failed')
})

test('judge fallback: the configured judge fails, another member judges blind', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'judgefb', { COUNCIL_FAKE_FAIL: 'claude:judge' })
  assert.equal(res.exitCode, 0, res.error)
  const v = readJson(path.join(runDir(toy.dir, 'judgefb'), 'verdict.json'))
  assert.notEqual(v.judge, 'claude')
})

test('judge returns prose: one "return only JSON" retry, then the verdict is used', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'nudge', { COUNCIL_FAKE_BADJSON: 'claude:judge' })
  assert.equal(res.exitCode, 0, res.error)
  const dir = runDir(toy.dir, 'nudge')
  assert.equal(readJson(path.join(dir, 'verdict.json')).judge, 'claude')
  assert.ok(fs.existsSync(path.join(dir, 'logs/judge-claude-nudge.argv.json')))
})

test('a reviewer that never returns JSON is marked invalid; the other review still counts', async () => {
  const toy = toyRepo()
  // The nudge answer for reviews is "[]" in the fake, so make the nudge fail too: only the first attempt is bad JSON
  // and the retry is a failure.
  const res = await dry(toy.dir, 'badreview', { COUNCIL_FAKE_BADJSON: 'fx:review', COUNCIL_FAKE_FAIL: 'fx:nudge' })
  assert.equal(res.exitCode, 0, res.error)
  const dir = runDir(toy.dir, 'badreview')
  assert.equal(readJson(path.join(dir, 'reviews/round-1/fx.json')).status, 'invalid')
  assert.deepEqual(readJson(path.join(dir, 'reviews/round-1/merged.json')).reviewers, ['claude'])
})

test('implementer fallback: codex fails, claude implements in the same fresh worktree', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'implfb', { COUNCIL_FAKE_FAIL: 'codex:implement' })
  assert.equal(res.exitCode, 0, res.error)
  const run = readJson(path.join(runDir(toy.dir, 'implfb'), 'run.json'))
  assert.equal(run.worktree.implementer, 'claude')
  assert.ok(run.warnings.some(w => /implementer fell back from codex to claude/.test(w)))
  const reviewers = readJson(path.join(runDir(toy.dir, 'implfb'), 'reviews/round-1/merged.json')).reviewers
  assert.ok(!reviewers.includes('claude'), 'the actual implementer does not review its own change')
})

test('missing member and a timeout in one run: still reaches the gate, escalated as unreviewed', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'both', { COUNCIL_FAKE_MISSING: 'fx', COUNCIL_FAKE_TIMEOUT: 'claude:review', COUNCIL_TIMEOUT_MS: '1500' })
  assert.equal(res.exitCode, 0, res.error)
  const run = readJson(path.join(runDir(toy.dir, 'both'), 'run.json'))
  assert.equal(run.members.fx.status, 'unavailable')
  assert.equal(run.members.claude.status, 'unavailable')
  assert.match(run.members.claude.reason, /timed out during review/)
  assert.equal(run.loop.stopReason, 'no reviewer produced a valid review')
  assert.equal(run.outcome.ready, false)
  assert.ok(run.outcome.reasons.some(r => /not reviewed/.test(r)))
  assert.equal(run.stages.gate.status, 'done')
})

test('a failed run still writes summary.md with the reason and the resume command', async () => {
  const toy = toyRepo()
  await dry(toy.dir, 'failsum', { COUNCIL_FAKE_MISSING: 'fx,codex' })
  const s = fs.readFileSync(path.join(runDir(toy.dir, 'failsum'), 'summary.md'), 'utf8')
  assert.match(s, /\*\*Outcome:\*\* failed: planning needs at least two/)
  assert.match(s, /council-flow --resume failsum --repo .* --dry-run/)
})

test('codex sandbox broken (probe): codex never implements, claude does; codex reviews from the prompt in an empty dir', async () => {
  const toy = toyRepo()
  const rec = path.join(tmp('council-rec-'), 'rec.jsonl')
  const res = await dry(toy.dir, 'sandbox', { COUNCIL_FAKE_CODEX_SANDBOX: 'broken', COUNCIL_FAKE_RECORD: rec })
  assert.equal(res.exitCode, 0, res.error)
  const run = readJson(path.join(runDir(toy.dir, 'sandbox'), 'run.json'))
  assert.equal(run.members.codex.sandbox, 'broken')
  assert.equal(run.worktree.implementer, 'claude')
  assert.ok(run.warnings.some(w => /codex sandbox unavailable/.test(w)))
  const calls = fs.readFileSync(rec, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(!calls.some(c => c.member === 'codex' && ['implement', 'fix'].includes(c.role)), 'codex was never asked to write')
  const review = calls.find(c => c.member === 'codex' && c.role === 'review')
  assert.ok(review, 'codex still reviewed')
  assert.ok(!review.cwd.startsWith(toy.dir), 'prompt-only codex runs outside the repo')
  assert.match(review.stdin, /You cannot read files or run commands/)
  assert.match(review.stdin, /## Current contents of the changed files/)
  assert.ok(calls.filter(c => c.member === 'codex').every(c => c.args[c.args.indexOf('-s') + 1] === 'read-only'), 'never anything but read-only for codex here')
  assert.match(fs.readFileSync(path.join(runDir(toy.dir, 'sandbox'), 'summary.md'), 'utf8'), /sandbox broken/)
})

test('codex sandbox broken at runtime (bwrap error in its output): detected, codex is then prompt-only and not the implementer', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'sandbox-rt', { COUNCIL_FAKE_CODEX_SANDBOX: 'runtime' })
  assert.equal(res.exitCode, 0, res.error)
  const run = readJson(path.join(runDir(toy.dir, 'sandbox-rt'), 'run.json'))
  assert.equal(run.members.codex.sandbox, 'broken')
  assert.match(run.members.codex.sandboxReason, /bwrap failed during plan/)
  assert.equal(run.worktree.implementer, 'claude')
})

test('plan texts are not on disk while judging: if every judge fails, no plan or planner stdout is left behind', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'nojudge', { COUNCIL_FAKE_FAIL: 'claude:judge,codex:judge,fx:judge' })
  assert.equal(res.exitCode, 2)
  assert.match(res.outcome.error, /no judge produced a valid verdict/)
  const files = walk(runDir(toy.dir, 'nojudge'))
  assert.ok(!files.some(f => f.startsWith('plans/')), files.join(', '))
  assert.ok(!files.some(f => /^logs\/plan-.*\.stdout\.txt$/.test(f)), 'planner stdout (the plans) is not kept either')
  assert.ok(files.includes('judge/input.md'), 'the redacted judge input is kept for debugging')
})

test('dry-run fixtures never write through a tracked hello.txt symlink, and fake Orca runs git without hooks', async () => {
  for (const orca of [false, true]) {
    const toy = toyRepo()
    const outside = path.join(tmp('council-outside-'), 'precious.txt')
    fs.writeFileSync(outside, 'original\n')
    fs.symlinkSync(outside, path.join(toy.dir, 'hello.txt'))
    git(toy.dir, 'add', 'hello.txt'); git(toy.dir, 'commit', '-q', '-m', 'link')
    const marker = path.join(tmp('council-hook-'), 'hook-ran')
    fs.writeFileSync(path.join(toy.dir, '.git', 'hooks', 'post-checkout'), `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
    const env = orca ? { COUNCIL_ORCA: 'on', COUNCIL_FAKE_ORCA_STATE: path.join(tmp('council-orcastate-'), 's.json') } : {}
    const res = await dry(toy.dir, `link-${orca}`, env)
    assert.equal(res.exitCode, 2, `${orca ? 'orca' : 'git'} mode: the fake implementer refuses the symlink`)
    assert.equal(fs.readFileSync(outside, 'utf8'), 'original\n', 'the target outside the worktree is untouched')
    assert.ok(!fs.existsSync(marker), 'no post-checkout hook ran')
  }
})

// End-to-end dry runs: artifact layout, blind judge input on disk, run.json, CLI, resume, doctor.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runPipeline } from '../src/pipeline.mjs'
import { toyRepo, testEnv, quiet, runDir, readJson, walk, git, cli, tmp } from './helpers.mjs'

const dry = (repo, runId, extra = {}, env = {}) => runPipeline({ task: 'Add a hello.txt greeting file', repo, dryRun: true, runId, ...extra }, { env: testEnv(env), log: quiet, noSignals: true })

test('full dry run: artifact layout, verdict map, judge input blind, gate denies, repo untouched', async () => {
  const toy = toyRepo()
  const res = await dry(toy.dir, 'layout')
  assert.equal(res.exitCode, 0, res.error)
  assert.equal(res.outcome.status, 'declined')
  const dir = runDir(toy.dir, 'layout')
  const files = walk(dir).filter(f => !f.startsWith('worktree/')).sort()
  for (const f of ['run.json', 'brief.md', 'plans/claude.md', 'plans/codex.md', 'plans/fx.md', 'judge/input.md', 'verdict.json', 'plan.md',
    'implement/prompt.md', 'implement/diff.patch', 'implement/log.txt', 'implement/meta.json',
    'reviews/round-1/claude.json', 'reviews/round-1/fx.json', 'reviews/round-1/merged.json',
    'fix/round-1/prompt.md', 'fix/round-1/diff.patch', 'fix/round-1/incremental.patch', 'fix/round-1/result.json',
    'reviews/round-2/merged.json', 'tests/output.txt', 'tests/result.json', 'summary.md', 'gate.json',
    'logs/plan-claude.argv.json', 'logs/review-1-fx.argv.json']) assert.ok(files.includes(f), `missing ${f}`)
  assert.ok(!files.includes('publish.json'), 'nothing published on deny')
  assert.ok(!files.some(f => /reviews\/round-\d\/codex\.json/.test(f)), 'the implementer does not review itself')

  const verdict = readJson(path.join(dir, 'verdict.json'))
  assert.deepEqual(Object.keys(verdict.labels).sort(), ['A', 'B', 'C'])
  assert.deepEqual(Object.values(verdict.labels).sort(), ['claude', 'codex', 'fx'])
  const judgeIn = fs.readFileSync(path.join(dir, 'judge/input.md'), 'utf8')
  assert.doesNotMatch(judgeIn, /claude|anthropic|opus|codex|openai|gpt|kimi|lyber|vercel|todowrite|apply_patch|\bfx\b/i)
  assert.match(fs.readFileSync(path.join(dir, 'plans/claude.md'), 'utf8'), /Claude/, 'plans on disk keep the original text')

  const run = readJson(path.join(dir, 'run.json'))
  for (const s of ['plan', 'implement', 'review-1', 'fix-1', 'review-2', 'tests', 'gate']) assert.equal(run.stages[s].status, 'done', s)
  for (const s of Object.values(run.stages)) assert.ok(s.durationMs >= 0 && s.startedAt && s.endedAt)
  for (const id of ['claude', 'codex', 'fx']) { assert.equal(run.members[id].status, 'ok'); assert.ok(run.members[id].usage.outputTokens > 0) }
  assert.equal(run.worktree.branch, 'council/layout')
  assert.equal(run.worktree.baseCommit, toy.head)

  assert.equal(readJson(path.join(dir, 'gate.json')).decision, 'deny')
  assert.equal(readJson(path.join(dir, 'tests/result.json')).status, 'passed')
  assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /Fix rounds: 1 of max 2/)

  // Target repo: main untouched, nothing committed, artifacts excluded via info/exclude (not .gitignore).
  assert.equal(git(toy.dir, 'rev-parse', 'main'), toy.head)
  assert.equal(git(toy.dir, 'status', '--porcelain'), '')
  assert.match(fs.readFileSync(path.join(toy.dir, '.git/info/exclude'), 'utf8'), /^\.council-flow\/$/m)
  assert.ok(!fs.existsSync(path.join(toy.dir, '.gitignore')))
  assert.equal(git(run.worktree.path, 'rev-parse', 'HEAD'), toy.head, 'the change is staged in the worktree, not committed')
  assert.match(git(run.worktree.path, 'diff', '--cached', '--name-only'), /hello\.txt/)
})

test('CLI: dry run exits 0 and prints status, run id and dir; bad input exits 1', () => {
  const toy = toyRepo()
  const ok = cli(['Add a hello.txt greeting file', '--repo', toy.dir, '--dry-run', '--run-id', 'cli-1'], testEnv())
  assert.equal(ok.status, 0, ok.stderr)
  assert.match(ok.stdout, /^declined\tcli-1\t.*\.council-flow\/cli-1$/m)
  assert.match(ok.stderr, /gate: deny/)
  assert.equal(cli(['--repo', toy.dir, '--dry-run'], testEnv()).status, 1)
  assert.match(cli(['x', '--repo', toy.dir, '--dry-run', '--implementer', 'fx'], testEnv()).stderr, /implementer must be one of codex, claude/)
  assert.match(cli(['x', '--repo', toy.dir, '--dry-run', '--rounds', 'two'], testEnv()).stderr, /--rounds must be a whole number/)
  assert.equal(cli(['--help'], testEnv()).status, 0)
})

test('issue entry point: task text from a file goes through the same pipeline', () => {
  const toy = toyRepo()
  const f = path.join(tmp('council-issue-'), 'issue.md')
  fs.writeFileSync(f, 'Issue #7: add a greeting\n\nWe need hello.txt.')
  const r = cli(['issue', '--text-file', f, '--repo', toy.dir, '--dry-run', '--run-id', 'issue-1'], testEnv())
  assert.equal(r.status, 0, r.stderr)
  const run = readJson(path.join(runDir(toy.dir, 'issue-1'), 'run.json'))
  assert.match(run.task, /^Issue #7: add a greeting/)
  assert.equal(run.source.kind, 'text')
})

test('resume: a failed implement stage is retried; finished stages are not rerun', async () => {
  const toy = toyRepo()
  const first = await dry(toy.dir, 'resume-1', {}, { COUNCIL_FAKE_FAIL: 'codex:implement,claude:implement' })
  assert.equal(first.exitCode, 2)
  let run = readJson(path.join(runDir(toy.dir, 'resume-1'), 'run.json'))
  assert.equal(run.stages.plan.status, 'done')
  assert.equal(run.stages.implement.status, 'failed')
  assert.equal(run.members.codex.status, 'unavailable', 'a rate limit takes the member out for the rest of the run')
  const planCalls = run.members.fx.usage.calls

  const second = await runPipeline({ resume: 'resume-1', repo: toy.dir, dryRun: true }, { env: testEnv(), log: quiet, noSignals: true })
  assert.equal(second.exitCode, 0, second.error)
  run = readJson(path.join(runDir(toy.dir, 'resume-1'), 'run.json'))
  assert.equal(run.stages.implement.status, 'done')
  assert.equal(run.members.codex.status, 'ok', 'availability is checked again on resume')
  assert.equal(run.stages.gate.status, 'done')
  assert.ok(run.members.fx.usage.calls > planCalls, 'fx reviewed after the resume')
  const fxPlanLogs = walk(path.join(runDir(toy.dir, 'resume-1'), 'logs')).filter(f => f.startsWith('plan-fx'))
  assert.equal(fxPlanLogs.length, 2, 'plan ran once (argv + stdout), not again on resume')
  await assert.rejects(() => runPipeline({ resume: 'resume-1', repo: toy.dir, dryRun: false }, { env: testEnv(), log: quiet, noSignals: true }), /created with --dry-run/)
})

test('an existing run id is refused instead of overwritten', async () => {
  const toy = toyRepo()
  assert.equal((await dry(toy.dir, 'twice')).exitCode, 0)
  await assert.rejects(() => dry(toy.dir, 'twice'), /already exists/)
})

test('doctor --dry-run: one OK/FAIL line per piece, READY with two members, no tokens', () => {
  const all = cli(['doctor', '--dry-run'], testEnv())
  assert.equal(all.status, 0, all.stderr)
  for (const n of ['node', 'claude', 'codex', 'fx', 'orca', 'git']) assert.match(all.stdout, new RegExp(`^(OK  |FAIL)  ${n}\\b`, 'm'))
  assert.match(all.stdout, /READY: 3\/3/)
  const two = cli(['doctor', '--dry-run'], testEnv({ COUNCIL_FAKE_MISSING: 'fx' }))
  assert.equal(two.status, 0)
  assert.match(two.stdout, /^FAIL  fx /m)
  const one = cli(['doctor', '--dry-run'], testEnv({ COUNCIL_FAKE_MISSING: 'fx,codex' }))
  assert.equal(one.status, 1)
  assert.match(one.stdout, /NOT READY/)
})

test('plan.md gives the implementer the judge\'s corrected plan, with the selected original below it', async () => {
  const toy = toyRepo()
  await dry(toy.dir, 'judgeplan')
  const plan = fs.readFileSync(path.join(runDir(toy.dir, 'judgeplan'), 'plan.md'), 'utf8')
  assert.match(plan, /^# Plan \(judge's version, choice [ABC]\)\n\nJUDGE-CORRECTED PLAN/)
  assert.match(plan, /# Selected plan [ABC] as written/)
  assert.ok(plan.indexOf('JUDGE-CORRECTED') < plan.indexOf('Selected plan'))
  assert.match(fs.readFileSync(path.join(runDir(toy.dir, 'judgeplan'), 'implement/prompt.md'), 'utf8'), /JUDGE-CORRECTED PLAN/)
})

test('resume restores the run\'s saved members and settings; only explicit flags override them', async () => {
  const toy = toyRepo()
  const rec = path.join(tmp('council-rec-'), 'rec.jsonl')
  const first = await dry(toy.dir, 'members', { members: 'claude,codex', rounds: 1 }, { COUNCIL_FAKE_FAIL: 'codex:implement,claude:implement' })
  assert.equal(first.exitCode, 2)
  const second = await runPipeline({ resume: 'members', repo: toy.dir, dryRun: true }, { env: testEnv({ COUNCIL_FAKE_RECORD: rec, COUNCIL_ROUNDS: '5', COUNCIL_MEMBERS: 'claude,codex,fx' }), log: quiet, noSignals: true })
  assert.equal(second.exitCode, 0, second.error)
  const run = readJson(path.join(runDir(toy.dir, 'members'), 'run.json'))
  assert.deepEqual(run.config.members, ['claude', 'codex'])
  assert.equal(run.config.rounds, 1)
  assert.equal(run.members.fx.status, 'disabled')
  const calls = fs.readFileSync(rec, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(!calls.some(c => c.member === 'fx'), 'no paid fx call after a resume of a claude,codex run')
  const third = await runPipeline({ resume: 'members', repo: toy.dir, dryRun: true, rounds: 0 }, { env: testEnv(), log: quiet, noSignals: true })
  assert.equal(third.exitCode, 0)
  assert.equal(readJson(path.join(runDir(toy.dir, 'members'), 'run.json')).config.rounds, 0, 'an explicit flag still wins')
})

test('--base-branch: the worktree starts from that branch, not from the checked-out HEAD', async () => {
  const toy = toyRepo()
  git(toy.dir, 'checkout', '-q', '-b', 'feature')
  fs.writeFileSync(path.join(toy.dir, 'feature-only.txt'), 'unreviewed feature work\n')
  git(toy.dir, 'add', '-A'); git(toy.dir, 'commit', '-q', '-m', 'feature work')
  const res = await dry(toy.dir, 'base', { baseBranch: 'main' })
  assert.equal(res.exitCode, 0, res.error)
  const run = readJson(path.join(runDir(toy.dir, 'base'), 'run.json'))
  assert.deepEqual([run.worktree.baseCommit, run.worktree.baseBranch], [toy.head, 'main'])
  assert.doesNotMatch(fs.readFileSync(path.join(runDir(toy.dir, 'base'), 'implement/diff.patch'), 'utf8'), /feature-only/)
})

test('a base commit that is not on the remote base branch escalates (the PR would show unreviewed commits)', async () => {
  const toy = toyRepo({ remote: true })
  fs.writeFileSync(path.join(toy.dir, 'local-only.txt'), 'not pushed\n')
  git(toy.dir, 'add', '-A'); git(toy.dir, 'commit', '-q', '-m', 'local only')
  const res = await dry(toy.dir, 'unpushed', {}, { COUNCIL_FAKE_REVIEW: 'clean' })
  assert.equal(res.exitCode, 0, res.error)
  assert.equal(res.outcome.ready, false)
  assert.ok(res.outcome.reasons.some(r => /is not on origin\/main: the PR would also contain commits that were not reviewed/.test(r)))
})

test('a detached HEAD or an unfetched remote base escalates: the PR base cannot be verified', async () => {
  const toy = toyRepo({ remote: true })
  fs.writeFileSync(path.join(toy.dir, 'detached-only.txt'), 'x\n')
  git(toy.dir, 'add', '-A'); git(toy.dir, 'commit', '-q', '-m', 'unpushed'); git(toy.dir, 'checkout', '-q', '--detach')
  const det = await dry(toy.dir, 'detached', {}, { COUNCIL_FAKE_REVIEW: 'clean' })
  assert.equal(det.outcome.ready, false)
  assert.ok(det.outcome.reasons.some(r => /detached HEAD/.test(r)), det.outcome.reasons.join('; '))
  git(toy.dir, 'checkout', '-q', '-b', 'feature')                 // a named branch that the remote does not have
  const nf = await dry(toy.dir, 'unfetched', {}, { COUNCIL_FAKE_REVIEW: 'clean' })
  assert.equal(nf.outcome.ready, false)
  assert.ok(nf.outcome.reasons.some(r => /origin\/feature is not fetched locally/.test(r)), nf.outcome.reasons.join('; '))
})

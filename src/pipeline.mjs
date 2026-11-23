// pipeline.mjs: plan -> implement -> review <-> fix (bounded) -> tests -> summary -> gate -> publish.
//
// The review/fix loop is a small persisted state machine (run.json `loop`), so --resume continues exactly where a
// run stopped: an interrupted or failed fix is retried from the reviewed tree, a round with no valid review is
// retried, and a worktree changed between runs gets a fresh review. Reviews, tests, the gate and publish are all
// bound to tree ids. The gate is always asked again on resume (unless that exact tree was already published).
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { loadConfig, validateConfig, publicConfig, restoreConfig, MEMBERS } from './config.mjs'
import { RunStore, ensureExcluded, newRunId } from './artifacts.mjs'
import { repoRoot as findRepoRoot, gitCommonDir, remoteInfo } from './repo.mjs'
import { createEngines } from './engines.mjs'
import { createOrca } from './orca.mjs'
import { scrubSecrets, scrubAudit } from './redact.mjs'
import { isBlocking } from './json.mjs'
import { killAll } from './proc.mjs'
import { DONE as PUBLISHED } from './publish.mjs'
import { StageError, markSandboxBroken } from './stages/common.mjs'
import { planStage } from './stages/plan.mjs'
import { implementStage, fixRound } from './stages/implement.mjs'
import { reviewRound } from './stages/review.mjs'
import { runTests, writeSummary, gateAndPublish, decisionFor, currentDiff, checkBase } from './stages/finish.mjs'

import { validateTarget, validateTestTarget } from './audit/target.mjs'
import { auditGit } from './audit/offline.mjs'
import { auditConfig } from './audit/config.mjs'
import { runAudit } from './audit/workflow.mjs'

export class UsageError extends Error {}

function makeScratch() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'council-flow-'))
  return {
    root,
    empty(name) { const d = path.join(root, name.replace(/[^a-z0-9._-]/gi, '_')); fs.mkdirSync(d, { recursive: true }); return d },
    remove() { fs.rmSync(root, { recursive: true, force: true }) }
  }
}

async function stage(ctx, name, fn) {
  ctx.store.startStage(name)
  ctx.current = name
  try {
    const res = await fn()
    ctx.store.endStage(name, 'done')
    return res
  } catch (e) {
    ctx.store.endStage(name, 'failed', { error: scrubSecrets(e.message, { env: ctx.env }) })
    throw e
  } finally { ctx.current = null }
}

// opts: {task, repo, implementer, judge, rounds, members, dryRun, runId, resume, testCmd, baseBranch, source}
// deps (tests): {env, engines, orca, gate, publish, log, randomInt, noSignals}
export function runPipeline(opts, deps = {}) {
  return opts.audit ? auditGit.run(true, () => runConfigured(opts, deps)) : runConfigured(opts, deps)
}

async function runConfigured(opts, deps) {
  const env = deps.env || process.env
  const log = deps.log || ((m) => process.stderr.write(`[council-flow] ${scrubSecrets(m, { env })}\n`))
  if (opts.audit && [opts.repo, opts.target, opts.testTarget, opts.runId, opts.resume].some(p => p && scrubAudit(p, env) !== p)) throw new UsageError('audit path contains credential material')
  const root = await findRepoRoot(path.resolve(opts.repo || process.cwd()))
  let target, testTarget

  // Resume: the run's saved configuration wins over today's environment; explicit flags override it.
  let store = null, cfg
  try {
    if (opts.resume) {
      store = RunStore.open(root, opts.resume, env)
      if ((store.state.mode === 'audit') !== Boolean(opts.audit)) throw new UsageError('resume the run with its original subcommand')
      const saved = store.state.config || {}
      if (Boolean(saved.dryRun) !== Boolean(opts.dryRun)) throw new UsageError(`run ${opts.resume} was created ${saved.dryRun ? 'with' : 'without'} --dry-run; resume it the same way`)
      cfg = restoreConfig(loadConfig({ dryRun: opts.dryRun }, env), saved, opts)
    } else cfg = loadConfig(opts, env)
    if (opts.audit) {
      if (fs.realpathSync(opts.repo || '.') !== fs.realpathSync(root)) throw new UsageError('audit --repo must name the repository root')
      if (opts.implementer && opts.implementer !== 'claude') throw new UsageError('audit uses Claude for Blue patches')
      cfg = auditConfig(cfg)
      const raw = opts.target ?? store?.state.targetInput ?? '.'
      try { target = validateTarget(root, raw) } catch (e) { throw new UsageError('invalid --target: ' + e.message) }
      const testPath = opts.testTarget ?? store?.state.testTarget?.path
      if (testPath !== undefined) {
        try { testTarget = validateTestTarget(root, testPath) } catch { throw new UsageError('invalid --test-target path') }
      }
      if (store && JSON.stringify(testTarget) !== JSON.stringify(store.state.testTarget)) throw new UsageError('cannot change test scope on resume')
      if (store && JSON.stringify(target) !== JSON.stringify(store.state.target)) throw new UsageError('cannot change target on resume')
    }
    if (!opts.audit) ensureExcluded(await gitCommonDir(root))
    const errors = validateConfig(cfg)
    if (errors.length) throw new UsageError(errors.join('\n'))
    if (!store && !String(opts.task || '').trim()) throw new UsageError('a task is required')
  } catch (e) { if (store) store.unlock(); throw e }
  if (!store) {
    store = RunStore.create(root, opts.runId || newRunId(), {
      ...(opts.audit ? { mode: 'audit', target, testTarget, targetInput: opts.target ?? '.' } : {}),
      task: String(opts.task).trim(), repo: root, source: opts.source || null, config: publicConfig(cfg)
    }, env)
  } else { store.state.config = publicConfig(cfg); store.save() }
  if (store.lockNote) store.warn(store.lockNote)

  const scratch = makeScratch()
  const ctx = {
    cfg, env, store, log, scratch, repoRoot: root, task: store.state.task, randomInt: deps.randomInt,
    engines: deps.engines || createEngines(cfg, { scratch: scratch.root, env }),
    orca: deps.orca || createOrca(cfg, { env, scratch: scratch.root }),
    current: null
  }
  log(`run ${store.runId}${cfg.dryRun ? ' (dry run: fake members, fake Orca, fake gate)' : ''}`)
  log(`artifacts: ${store.dir}`)

  const onSignal = (sig) => {
    killAll()
    try { if (ctx.current) store.endStage(ctx.current, 'interrupted', { signal: sig }) } catch { /* best effort */ }
    store.unlock()
    scratch.remove()
    log(`interrupted (${sig}); resume with: council-flow ${opts.audit ? 'audit ' : ''}--resume ${store.runId} --repo ${root}`)
    process.exit(130)
  }
  if (!deps.noSignals) { process.once('SIGINT', onSignal); process.once('SIGTERM', onSignal) }

  try {
    // Who can sit today (no tokens: binary, version, login, provider/key and sandbox checks).
    for (const id of MEMBERS) {
      if (!cfg.members.includes(id)) { store.setMember(id, 'disabled', 'not in the run\'s members'); continue }
      const a = await ctx.engines[id].available()
      store.setMember(id, a.ok ? 'ok' : 'unavailable', a.ok ? (a.detail || null) : a.reason)
      const m = store.member(id)
      m.version = a.version || null
      if (id === 'codex') { delete m.sandbox; delete m.sandboxReason; if (a.ok && a.sandbox === false) markSandboxBroken(ctx, a.sandboxReason) }
      if (!a.ok) store.warn(`${id} unavailable: ${a.reason}`)
      log(`member ${id}: ${a.ok ? `available${m.sandbox === 'broken' ? ' (sandbox broken: prompt-only, cannot implement)' : ''}` : `unavailable (${a.reason})`}`)
    }
    if (opts.audit) return await runAudit(ctx, opts, stage)
    ctx.orcaInfo = await ctx.orca.detect()
    if (cfg.orca.mode === 'on' && !ctx.orcaInfo.usable) throw new UsageError(`COUNCIL_ORCA=on but Orca is not usable: ${ctx.orcaInfo.reason}`)
    if (store.state.worktree?.orcaRunId) ctx.orca.useRun(store.state.worktree.orcaRunId)
    store.state.orca = ctx.orcaInfo
    store.save()
    log(`orca: ${ctx.orcaInfo.usable ? 'orchestration' : 'git worktree fallback'} (${ctx.orcaInfo.reason})`)

    // 1. plan
    if (!store.isDone('plan')) await stage(ctx, 'plan', () => planStage(ctx))
    ctx.plan = store.read('plan.md')
    // 2. implement
    if (!store.isDone('implement')) await stage(ctx, 'implement', () => implementStage(ctx))

    // 3 + 4. review <-> fix
    const loop = store.state.loop ||= { n: 1, fixRounds: 0, next: 'review', findings: [], reviewed: false, reviewedTree: null, reviewedRound: null, stopReason: null, retry: null, candidateTree: null }
    let { stat, tree } = await currentDiff(ctx)
    // A failed fix was already rolled back to reviewedTree. If the tree differs now, the owner edited the worktree
    // after the escalation: review those edits instead of re-running the fix (which would restore over them).
    if (loop.retry === 'fix' && tree !== loop.reviewedTree) {
      store.warn(`the worktree changed after the rolled-back fix (tree ${tree.slice(0, 12)}); reviewing it instead of retrying the fix`)
      Object.assign(loop, { retry: null, n: loop.n + 1, next: 'review', stopReason: null })
    }
    if (loop.retry) { loop.next = loop.retry; loop.retry = null; loop.stopReason = null }
    if (loop.next === 'done' && loop.candidateTree && tree !== loop.candidateTree) {
      store.warn(`the worktree changed since the last run (tree ${tree.slice(0, 12)}); reviewing it again`)
      Object.assign(loop, { n: loop.n + 1, next: 'review', stopReason: null })
    }
    if (stat.files === 0) Object.assign(loop, { next: 'done', reviewed: true, findings: [], stopReason: 'implementer produced no changes' })
    while (loop.next !== 'done') {
      if (loop.next === 'review') {
        const res = await stage(ctx, `review-${loop.n}`, () => reviewRound(ctx, loop.n))
        if (!res.reviewed) Object.assign(loop, { reviewed: false, stopReason: 'no reviewer produced a valid review', retry: 'review', next: 'done' })   // earlier findings stay open
        else {
          Object.assign(loop, { findings: res.findings, reviewed: true, reviewedTree: res.tree, reviewedRound: loop.n })
          if (!res.findings.some(isBlocking)) Object.assign(loop, { stopReason: 'clean (no blocker or major)', next: 'done' })
          else if (loop.fixRounds >= cfg.rounds) Object.assign(loop, { stopReason: `max fix rounds (${cfg.rounds}) reached`, next: 'done' })
          else loop.next = 'fix'
        }
      } else if (loop.next === 'fix') {
        const n = loop.n
        const fx = await stage(ctx, `fix-${n}`, () => fixRound(ctx, n, loop.findings, loop.reviewedTree))
        if (!fx.ok) Object.assign(loop, { stopReason: `fix round ${n} failed (rolled back): ${fx.error}`, retry: 'fix', next: 'done' })
        else {
          loop.fixRounds += 1
          if (!fx.changed) Object.assign(loop, { stopReason: `fix round ${n} changed nothing`, next: 'done' })
          else Object.assign(loop, { n: n + 1, next: 'review' })
        }
      } else throw new StageError(`unknown loop state ${loop.next}`)
      store.save()
    }
    ;({ stat, tree } = await currentDiff(ctx))
    if (stat.files > 0 && loop.reviewed && tree !== loop.reviewedTree) Object.assign(loop, { reviewed: false, stopReason: `${loop.stopReason}; the worktree no longer matches the reviewed tree` })
    loop.candidateTree = tree
    const remote = await remoteInfo(store.state.worktree.path)
    store.state.candidate = { tree, base: store.state.worktree.baseCommit, worktree: store.state.worktree.path, dest: `council/${store.runId}`, repo: remote ? remote.id : null }
    store.save()

    // 5. tests, summary, gate, publish
    // Project code (the tests) runs only on a tree that was reviewed as it is.
    const tests = loop.reviewed || stat.files === 0 ? await stage(ctx, 'tests', () => runTests(ctx, tree))
      : { cmd: null, tree, status: 'skipped', passed: false, note: 'not run: this tree has no valid review, so its code is not executed' }
    if (tests.status === 'skipped') store.writeJson('tests/result.json', tests)
    const baseCheck = await checkBase(ctx)
    const decision = decisionFor({ tests, findings: loop.findings, reviewed: loop.reviewed, stopReason: loop.stopReason, stat, baseCheck, fixFailed: loop.retry === 'fix' })
    const prev = store.exists('publish.json') ? store.readJson('publish.json') : null
    if (prev && prev.status === PUBLISHED && prev.tree === tree) {
      log(`already published this tree (${prev.prUrl || prev.remoteBranch}); not asking the gate again`)
      return { runId: store.runId, dir: store.dir, outcome: store.state.outcome, exitCode: 0 }
    }
    const facts = { tests, findings: loop.findings, loop, stat, decision }
    writeSummary(ctx, facts)
    const { gate, publish } = await stage(ctx, 'gate', () => gateAndPublish(ctx, { decision, findings: loop.findings, ...(deps.publish ? { publish: deps.publish } : {}), ...(deps.gate ? { gate: deps.gate } : {}) }))
    store.state.outcome = { status: gate.decision === 'approve' ? (publish?.status || 'approved') : 'declined', ready: decision.ready, reasons: decision.reasons, gate: gate.decision, tree, prUrl: publish?.prUrl || null }
    store.save()
    writeSummary(ctx, { ...facts, gate, publish })
    log(`done: ${store.state.outcome.status}. Summary: ${store.path('summary.md')}`)
    return { runId: store.runId, dir: store.dir, outcome: store.state.outcome, exitCode: 0 }
  } catch (e) {
    store.state.outcome = { status: 'failed', error: scrubSecrets(e.message, { env }) }
    store.save()
    store.write('summary.md', [`# council-flow run ${store.runId}`, '', `**Task:** ${String(store.state.task).split('\n')[0]}`, '',
      `**Outcome:** failed: ${e.message}`, '', '## Stages', '', ...Object.entries(store.state.stages).map(([k, v]) => `- ${k}: ${v.status}${v.error ? ` (${v.error})` : ''}`),
      '', '## Warnings', '', ...(store.state.warnings.length ? store.state.warnings.map(w => `- ${w}`) : ['- none']),
      '', `Resume after fixing the cause: \`council-flow ${opts.audit ? 'audit ' : ''}--resume ${store.runId} --repo ${root}${cfg.dryRun ? ' --dry-run' : ''}\``, ''].join('\n'))
    log(`failed: ${e.message}`)
    if (e instanceof UsageError) throw e
    return { runId: store.runId, dir: store.dir, outcome: store.state.outcome, exitCode: 2, error: e instanceof StageError ? e.message : e.stack }
  } finally {
    if (!deps.noSignals) { process.removeListener('SIGINT', onSignal); process.removeListener('SIGTERM', onSignal) }
    store.unlock()
    scratch.remove()
  }
}

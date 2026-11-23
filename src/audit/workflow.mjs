import fs from 'node:fs'
import { assertNoSymlinks } from '../artifacts.mjs'
import { git, addWorktree, headCommit, currentBranch, writeTree, restoreTree } from '../repo.mjs'
import { ensureWorktree } from '../stages/common.mjs'
import { runTests } from '../stages/finish.mjs'
import { decide } from '../gate.mjs'
import { publish, expectedBinding } from '../publish.mjs'
import { contextPack, safeText } from './context.mjs'
import { auditScope, changesBetween } from './scope.mjs'
import { redFindings, unresolved } from './findings.mjs'
import { activeFixes, candidateDiff, judge, mergeFindings, parallelReview, regressions, reports } from './iteration.mjs'

async function worktree(ctx) {
  const { store, repoRoot } = ctx
  const branch = 'council/' + store.runId
  const path = store.path('worktree')
  assertNoSymlinks(repoRoot, path)
  if (!store.state.worktree) {
    store.state.worktree = { mode: 'git', branch, path, initializing: true, baseCommit: await headCommit(repoRoot), baseBranch: await currentBranch(repoRoot), implementer: 'claude' }
    store.save()
  }
  const wt = store.state.worktree
  if (wt.path !== path || wt.mode !== 'git' || wt.branch !== branch) throw new Error('invalid audit worktree')
  if (!fs.existsSync(path)) {
    wt.initializing = true
    store.save()
    await addWorktree(repoRoot, path, branch, wt.baseCommit, { checkout: false })
  }
  await ensureWorktree(ctx)
  if (wt.initializing) {
    await git(['read-tree', '-u', '--reset', wt.baseCommit], path)
    delete wt.initializing
    store.save()
  }
  return wt
}

function history(loop, round, findings) {
  for (const f of findings) {
    const last = loop.history.findLast(h => h.id === f.id)
    if (last?.status !== f.status || last.round !== round) loop.history.push({ round, id: f.id, status: f.status })
    loop.ledger = [...loop.ledger.filter(prev => prev.id !== f.id), f]
  }
}

function writeLedger(store, loop) {
  const lines = ['# Audit findings', '']
  for (const f of loop.ledger) {
    lines.push(`## ${f.id} · ${f.severity} · ${f.status} · ${f.title}`, '', `${f.file}:${f.line} ${f.cwe || ''}`, '',
      f.why_exploitable, '', 'Impact: ' + f.impact, '', 'Fix direction: ' + f.fix_hint, '',
      loop.history.filter(h => h.id === f.id).map(h => `round ${h.round} ${h.status}`).join(' → '), '')
  }
  if (!loop.ledger.length) lines.push('No findings recorded.')
  store.write('findings.md', lines.join('\n') + '\n')
}

function openIds(ledger) {
  return ledger.filter(unresolved).map(f => f.id).sort()
}

function begin(loop, tree, full) {
  const number = (loop.iterations.at(-1)?.number || 0) + 1
  const it = { number, start: tree, full, openBefore: openIds(loop.ledger) }
  if (full) loop.stagnant = 0
  loop.iterations.push(it)
  loop.round = number
  delete loop.stopReason
  return it
}

function incorporate(loop, round, findings) {
  for (const f of findings) {
    const idx = loop.ledger.findIndex(old => old.id === f.id)
    if (idx < 0) history(loop, round, [{ ...f, status: 'open' }])
    else loop.ledger[idx] = { ...f, status: loop.ledger[idx].status }
  }
}

function settle(loop, it, verdict, receipts, cfg) {
  const verified = new Set()
  const newConfirmed = []
  for (const v of verdict.findings) {
    const f = loop.ledger.find(row => row.id === v.id)
    const patch = verdict.patches.find(p => p.id === f.id)
    const passed = receipts.some(r => r.passed && r.tree === it.tree && r.focus.ids.includes(f.id))
    if (v.decision === 'confirmed' && ['open', 'rejected'].includes(f.status)) {
      newConfirmed.push(f.id)
      history(loop, it.number, [{ ...f, status: 'confirmed' }])
    }
    let status = 'open'
    if (v.decision === 'false-positive') status = 'rejected'
    if (v.decision === 'confirmed') {
      status = 'confirmed'
      if (patch?.decision === 'verified' && passed) {
        verified.add(f.id)
        status = 'fixed'
      } else if (f.status === 'fixed' || f.status === 'reopened' || patch?.decision === 'rejected') status = 'reopened'
    }
    history(loop, it.number, [{ ...f, status }])
  }
  const partial = Object.keys(it.teamFailures || {}).length > 0
  const open = openIds(loop.ledger)
  const pendingPatches = verdict.patches.filter(p => !verified.has(p.id)).map(p => p.id)
  Object.assign(it, { done: true, newConfirmed, open, pendingPatches, concerns: verdict.concerns.length, verified: [...verified] })
  loop.feedback = { ...verdict, teamFailures: it.teamFailures, pendingPatches, regressionResults: receipts.map(r => ({ file: r.focus.file, ids: r.focus.ids, status: r.status })) }
  loop.stagnant = it.start === it.tree && JSON.stringify(open) === JSON.stringify(it.openBefore) ? loop.stagnant + 1 : 0
  if (partial && (!cfg.rounds || loop.stagnant >= 2 || it.number >= cfg.rounds)) loop.stopReason = 'team-incomplete'
  else if (!cfg.rounds) loop.stopReason = 'report-only'
  else if (!partial && !newConfirmed.length && !open.length && !pendingPatches.length && !it.concerns) loop.stopReason = 'clean'
  else if (loop.stagnant >= 2) loop.stopReason = 'no-progress'
  else if (it.number >= cfg.rounds) loop.stopReason = 'max-rounds'
}

async function finish(ctx, loop, it, stage) {
  const { store, cfg } = ctx
  const wt = await ensureWorktree(ctx)
  const tree = it.tree
  if (tree !== await writeTree(wt.path)) throw new Error('reviewed worktree changed before testing')
  const fixes = activeFixes(loop)
  const tests = await stage(ctx, 'tests', () => runTests(ctx, tree))
  const focused = await regressions(ctx, fixes, tree, 'tests')
  const passed = tests.passed && focused.every(r => r.passed)
  for (const id of it.verified) {
    const ok = focused.some(r => r.focus.ids.includes(id) && r.passed)
    const f = loop.ledger.find(row => row.id === id)
    history(loop, it.number, [{ ...f, status: ok ? 'fixed' : 'reopened' }])
  }
  writeLedger(store, loop)
  store.state.candidate = { tree, repo: ctx.repoRoot }
  store.save()
  const open = loop.ledger.filter(unresolved)
  const summary = [`# Local security audit ${store.runId}`, '', ctx.task, '', 'Target: ' + JSON.stringify(store.state.target),
    `Candidate tree: ${tree}`, `Stop reason: ${loop.stopReason}${loop.stopReason === 'no-progress' ? ' (escalated after two unchanged iterations)' : ''}`, '',
    '| Iteration | Context | New confirmed | Verified fixes | Open | Review concerns | Failed team |',
    '|---|---|---|---|---|---|---|',
    ...loop.iterations.map(i => `| ${i.number} | v${i.version || '?'} | ${i.done ? i.newConfirmed.length : 'superseded'} | ${i.verified?.length ?? '—'} | ${i.open?.length ?? '—'} | ${i.concerns ?? '—'} | ${Object.keys(i.teamFailures || {}).join(', ') || '—'} |`),
    '', `Repository tests: ${tests.status} (${tests.cmd || 'none'})`,
    ...focused.map(r => `Regression tests: ${r.status} (${r.cmd || r.note})`),
    `Unresolved: ${open.length}`, ...open.map(f => `- ${f.id} [${f.severity}] ${f.file}:${f.line} ${f.title}`),
    '', 'See findings.md and the per-iteration review verdicts for decisions and justifications.', ...store.state.warnings, ''].join('\n')
  store.write('summary.md', summary)
  await ctx.scopePolicy.validate(await changesBetween(store, wt.baseCommit, tree), tree, fixes)
  const changes = tree !== (await git(['rev-parse', wt.baseCommit + '^{tree}'], wt.path)).stdout.trim()
  const gate = await decide({ cfg, env: ctx.env, binding: expectedBinding(store), question: `Audit ${store.runId}, tree ${tree}, stop ${loop.stopReason}, tests ${tests.status}, ${open.length} unresolved, ${it.pendingPatches.length} unverified patches, ${it.concerns} concerns. Commit eligible changes locally on ${wt.branch}? See ${store.path('summary.md')}` })
  store.writeJson('gate.json', gate)
  let status = 'declined'
  if (gate.decision === 'approve') {
    status = !changes ? 'no-changes' : !passed ? 'tests-incomplete' : loop.stopReason === 'team-incomplete' || it.pendingPatches.length || it.concerns ? 'review-incomplete' :
      (await publish({ cfg, env: ctx.env, store, approval: gate, title: 'Local security fixes for ' + store.runId })).status
  }
  store.state.outcome = { status, tree, gate: gate.decision, testsPassed: passed, unresolved: open.length, stopReason: loop.stopReason }
  store.save()
  store.write('summary.md', summary + '\nGate: ' + gate.decision + '\nOutcome: ' + status + '\n')
  return { runId: store.runId, dir: store.dir, outcome: store.state.outcome, exitCode: ['commit-failed', 'branch-moved'].includes(status) ? 2 : 0 }
}

export async function runAudit(ctx, opts, stage) {
  const { store, cfg } = ctx
  const wt = await worktree(ctx)
  ctx.scope = JSON.stringify({ scope: safeText(ctx.task, ctx.env), target: store.state.target, testTarget: store.state.testTarget })
  ctx.scopePolicy = auditScope(store)
  const loop = store.state.auditLoop ||= { patches: 0, history: [], proofs: [], ledger: [] }
  loop.ledger = loop.ledger.map(f => redFindings(JSON.stringify([f]))[0])
  if (loop.red) {
    incorporate(loop, loop.round, redFindings(JSON.stringify(loop.red)))
    delete loop.red
  }
  loop.iterations ||= []
  if (loop.rollback) {
    await restoreTree(wt.path, loop.rollback)
    delete loop.rollback
    store.save()
  }
  const tree = await writeTree(wt.path)
  await ctx.scopePolicy.validate(await changesBetween(store, wt.baseCommit, tree), tree, activeFixes(loop))
  let it = loop.iterations.at(-1)
  if (!it || opts.refreshContext || tree !== (it.tree || it.start)) {
    if (it && !it.done) {
      const old = reports(store, it)
      incorporate(loop, it.number, mergeFindings(old.red?.findings || [], old.blue?.findings || []))
    }
    it = begin(loop, tree, true)
  } else if ((loop.stopReason === 'report-only' && cfg.rounds > 0) ||
             (['max-rounds', 'team-incomplete'].includes(loop.stopReason) && it.number < cfg.rounds)) {
    it = begin(loop, tree, false)
  }
  store.save()
  writeLedger(store, loop)
  while (true) {
    const pack = await stage(ctx, `context-${it.number}`, async () => {
      let revision
      if (!it.hash && (it.number > 1 || loop.ledger.length)) {
        revision = { verdict: loop.feedback, ledger: loop.ledger, history: loop.history,
          candidateDiff: await candidateDiff(ctx, wt.baseCommit, it.start) }
      }
      return contextPack(ctx, it.start, it.number, revision, it.full)
    })
    if (it.hash && it.hash !== pack.hash) throw new Error('iteration context hash mismatch')
    Object.assign(it, { hash: pack.hash, version: pack.version })
    store.save()
    if (!it.done) {
      if (!it.teamsComplete && (!it.redDone || !it.blueDone)) await stage(ctx, `teams-${it.number}`, () => parallelReview(ctx, loop, it, pack))
      const outputs = reports(store, it)
      const findings = mergeFindings(loop.ledger, outputs.red.findings, outputs.blue.findings)
      incorporate(loop, it.number, findings)
      writeLedger(store, loop)
      store.save()
      const verdict = await stage(ctx, `review-${it.number}`, () => judge(ctx, loop, it, pack, outputs, findings))
      const receipts = await regressions(ctx, activeFixes(loop), it.tree, `iterations/${it.number}/review`)
      settle(loop, it, verdict, receipts, cfg)
      writeLedger(store, loop)
      store.save()
    }
    if (loop.stopReason) break
    it = begin(loop, it.tree, false)
    store.save()
  }
  return finish(ctx, loop, it, stage)
}

// Stage 2 (implement) and the fix half of stage 4. One implementer, one new worktree on council/<run-id>.
// Changes are staged, never committed, until the gate approves. The worktree is verified before every use.
import fs from 'node:fs'
import { render } from '../prompts.mjs'
import { git, headCommit, currentBranch, branchExists, resolveCommit, addWorktree, verifyWorktree, writeTree, restoreTree, diffSince, diffTrees, cap } from '../repo.mjs'
import { IMPLEMENTERS } from '../config.mjs'
import { StageError, canImplement, callMember, writeCallLogs, formatFindings, ensureWorktree } from './common.mjs'

function callLog(r) {
  return `exit ${r.exitCode}${r.timedOut ? ' (timed out)' : ''}, ${(r.durationMs / 1000).toFixed(1)}s\n${r.error ? `error: ${r.error}\n` : ''}\n--- answer ---\n${r.text}\n`
}

// Mail that is not the completion we wait for is kept, never dropped; a worker question needs a person.
export function retainMail(ctx, m) {
  ctx.store.append('orca/mail.jsonl', JSON.stringify(m))
  const type = m && (m.type || m.messageType || m.kind)
  if (type === 'question') ctx.store.warn(`an Orca worker asked a question (${m.subject || m.id || 'see orca/mail.jsonl'}); answer it in Orca`)
}

async function implementWithGit(ctx, { implementer, base, baseBranch, prompt }) {
  const { store, repoRoot } = ctx
  const wt = store.path('worktree')
  const branch = `council/${store.runId}`
  if (fs.existsSync(wt)) await verifyWorktree(repoRoot, wt, { branch, expectPath: wt })           // resume: must be ours
  else {
    if (await branchExists(repoRoot, branch)) throw new StageError(`branch ${branch} already exists; use another --run-id`)
    await addWorktree(repoRoot, wt, branch, base)
    await verifyWorktree(repoRoot, wt, { branch, expectPath: wt })
    ctx.log(`implement: worktree ${wt} on ${branch} from ${base.slice(0, 12)}`)
  }
  store.state.worktree = { mode: 'git', path: wt, branch, baseCommit: base, baseBranch, pushBranch: branch, implementer }
  store.save()
  const baseTree = (await git(['rev-parse', `${base}^{tree}`], repoRoot)).stdout.trim()
  // Degraded mode: if the chosen implementer fails, put this run's own worktree back to the base and try the other.
  const order = [implementer, ...IMPLEMENTERS.filter(m => m !== implementer)].filter(id => canImplement(ctx, id))
  let log = ''
  for (const id of order) {
    if (!canImplement(ctx, id)) continue                                         // e.g. codex sandbox found broken
    await ensureWorktree(ctx)
    const r = await callMember(ctx, id, { role: 'implement', prompt, cwd: wt, timeoutMs: ctx.cfg.implTimeoutMs, name: `implement-${id}` })
    writeCallLogs(ctx, `implement-${id}`, r)
    log += `## ${id}\n${callLog(r)}\n`
    store.write('implement/log.txt', log)
    if (r.ok) {
      if (id !== implementer) store.warn(`implementer fell back from ${implementer} to ${id}`)
      store.state.worktree.implementer = id
      return store.state.worktree
    }
    await ensureWorktree(ctx)
    await restoreTree(wt, baseTree)
  }
  throw new StageError(`no implementer succeeded (tried ${order.join(', ') || 'none available'})`)
}

async function implementWithOrca(ctx, { implementer, base, baseBranch, prompt, prior }) {
  const { cfg, store, orca, repoRoot } = ctx
  const meta = { mode: 'orca', implementer, baseCommit: base, baseBranch, pushBranch: `council/${store.runId}`, ...(prior || {}) }
  const save = () => { store.state.worktree = { ...meta }; store.save() }
  if (meta.orcaRunId) orca.useRun(meta.orcaRunId)
  let settled = null
  if (!meta.dispatchId) {
    if (!meta.orcaRunId) { meta.orcaRunId = await orca.runCreate(`council-flow run ${store.runId}`); save() }
    if (!meta.taskId) { meta.taskId = await orca.taskCreate(prompt, `council-flow implement ${store.runId}`); save() }
    // --model only when the user named one (Orca's own guidance); claude always gets its configured model (default "opus").
    const model = implementer === 'claude' ? cfg.models.claude : (cfg.modelsExplicit.codex ? cfg.models.codex : null)
    const w = await orca.workerStart({ taskId: meta.taskId, agent: implementer, model, name: `council-${store.runId}`, repo: repoRoot, baseRef: base })
    store.writeJson('orca/worker-start.json', w.receipt)
    const v = await verifyWorktree(repoRoot, w.worktreePath)                    // registered, not primary, same repo
    Object.assign(meta, { dispatchId: w.dispatchId, dispatches: [w.dispatchId], path: v.path, branch: v.branch })
    save()                                                                       // a resume reconciles this dispatch
    store.warn('Orca mode: the implementer is your Orca agent with your Orca permission settings; council-flow cannot enforce read/write limits on it (COUNCIL_ORCA_IMPLEMENT=headless avoids this)')
    ctx.log(`implement: Orca worker ${w.dispatchId} (${implementer}) in ${v.path}`)
  } else settled = await orca.reconcile(meta.dispatchId).catch(() => null)
  const done = settled && settled.settled ? { outcome: settled.outcome, reconciled: true }
    : await orca.waitDone([meta.dispatchId], cfg.implTimeoutMs, { onOther: (m) => retainMail(ctx, m) })
  store.write('implement/log.txt', `Orca dispatch ${meta.dispatchId}: ${done.outcome}${done.reconciled ? ' (from worker-show)' : ''}\n${JSON.stringify(done.message || {}, null, 2)}\n`)
  if (done.outcome !== 'succeeded') throw new StageError(`Orca worker ${meta.dispatchId} ended with "${done.outcome}"`)
  save()
  return meta
}

export async function implementStage(ctx) {
  const { cfg, store, repoRoot } = ctx
  const prior = store.state.worktree
  let base = prior?.baseCommit, baseBranch = prior?.baseBranch
  if (!base) {
    if (cfg.baseBranch) {
      base = await resolveCommit(repoRoot, cfg.baseBranch)
      if (!base) throw new StageError(`--base-branch ${cfg.baseBranch} does not resolve to a commit`)
      baseBranch = cfg.baseBranch
    } else { base = await headCommit(repoRoot); baseBranch = await currentBranch(repoRoot) }
  }
  const dirty = (await git(['status', '--porcelain'], repoRoot)).stdout.trim()
  if (dirty) store.warn(`the repo has uncommitted changes; they are not part of base ${base.slice(0, 12)} and not in the worktree`)

  const implementer = canImplement(ctx, cfg.implementer) ? cfg.implementer : IMPLEMENTERS.find(id => canImplement(ctx, id))
  if (!implementer) throw new StageError('no implementer available (needs claude, or codex with a working sandbox)')
  if (implementer !== cfg.implementer) store.warn(`implementer ${cfg.implementer} cannot implement here, using ${implementer}`)

  const prompt = render('implement', { task: ctx.task, plan: ctx.plan })
  store.write('implement/prompt.md', prompt)
  // A resumed run keeps the mode it started in.
  const useOrca = prior?.mode ? prior.mode === 'orca' : (ctx.orcaInfo.usable && cfg.orca.implement === 'orca')
  if (useOrca && !ctx.orcaInfo.usable) throw new StageError(`this run's implementer is an Orca worker; resume it from an Orca terminal (${ctx.orcaInfo.reason})`)
  if (useOrca) await implementWithOrca(ctx, { implementer, base, baseBranch, prompt, prior })
  else await implementWithGit(ctx, { implementer, base, baseBranch, prompt })

  const wt = await ensureWorktree(ctx)
  const { patch, stat, tree } = await diffSince(wt.path, wt.baseCommit)
  store.write('implement/diff.patch', patch)
  store.writeJson('implement/meta.json', { ...wt, stat, tree })
  ctx.log(`implement: ${stat.files} file(s), +${stat.insertions} -${stat.deletions}`)
  return { stat, tree }
}

// Stage 4, the fix half: findings back to the same implementer in the same worktree. The findings refer to
// `reviewedTree`; a failed fix is rolled back to it, so nothing unreviewed is left behind.
export async function fixRound(ctx, n, findings, reviewedTree) {
  const { cfg, store, orca } = ctx
  const wt = await ensureWorktree(ctx)
  if (await writeTree(wt.path) !== reviewedTree) { await restoreTree(wt.path, reviewedTree); store.warn(`fix ${n}: worktree differed from the reviewed tree and was restored first`) }
  const prompt = render('fix', { task: ctx.task, plan: cap(ctx.plan, 8000), round: n, findings: formatFindings(findings) })
  store.write(`fix/round-${n}/prompt.md`, prompt)
  let ok, error = null, log
  if (wt.mode === 'orca') {
    if (!ctx.orcaInfo.usable) { ok = false; error = `this run's implementer is an Orca worker; resume from an Orca terminal`; log = error + '\n' }
    else {
      const current = wt.dispatches?.[wt.dispatches.length - 1] || wt.dispatchId
      const s = await orca.send(current, `council-flow fix round ${n}`, cap(prompt, 60000))
      const waitOn = s.followUpDispatchId || current
      if (s.followUpDispatchId) { wt.dispatches = [...(wt.dispatches || [wt.dispatchId]), s.followUpDispatchId]; store.state.worktree = wt; store.save() }
      const done = await orca.waitDone([waitOn], cfg.implTimeoutMs, { onOther: (m) => retainMail(ctx, m) })
      ok = done.outcome === 'succeeded'
      if (!ok) error = `Orca worker ended with "${done.outcome}"`
      log = `Orca dispatch ${waitOn}: ${done.outcome}\n`
    }
  } else if (!canImplement(ctx, wt.implementer)) {
    ok = false; error = `implementer ${wt.implementer} is unavailable`; log = error + '\n'
  } else {
    const r = await callMember(ctx, wt.implementer, { role: 'fix', prompt, cwd: wt.path, timeoutMs: cfg.implTimeoutMs, name: `fix-${n}-${wt.implementer}` })
    writeCallLogs(ctx, `fix-${n}-${wt.implementer}`, r)
    ok = r.ok; error = r.error; log = callLog(r)
  }
  await ensureWorktree(ctx)
  let after = await writeTree(wt.path)
  if (!ok && after !== reviewedTree) { await restoreTree(wt.path, reviewedTree); after = reviewedTree; log += 'fix failed: worktree restored to the reviewed tree\n' }
  const changed = after !== reviewedTree
  store.write(`fix/round-${n}/log.txt`, log)
  store.write(`fix/round-${n}/incremental.patch`, changed ? await diffTrees(wt.path, reviewedTree, after) : '')
  const { patch, stat } = await diffSince(wt.path, wt.baseCommit)
  store.write(`fix/round-${n}/diff.patch`, patch)
  const result = { round: n, ok, changed, error, stat, beforeTree: reviewedTree, afterTree: after, addressed: findings.length }
  store.writeJson(`fix/round-${n}/result.json`, result)
  ctx.log(`fix ${n}: ${ok ? 'ok' : 'FAILED'}, ${changed ? 'changed the diff' : 'no change'}`)
  return result
}

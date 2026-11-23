// Stage 3: read-only cross-review by every available member except the implementer. Each round is bound to the
// tree id it reviewed.
import { render } from '../prompts.mjs'
import { diffSince, fileExcerpts, cap } from '../repo.mjs'
import { parseFindings, dedupeFindings, isBlocking } from '../json.mjs'
import { availableMembers, callMember, writeCallLogs, parseWithRetry, ensureWorktree, promptOnly } from './common.mjs'

const FINDINGS_SHAPE = '[{"severity": "blocker|major|minor", "category": "bug|security|gap|test|style", "file": "<path>", "line": <number|null>, "issue": "<text>", "suggestion": "<text>"}]  (use [] when there are no problems)'
// Lyber is paid per token: fx gets a smaller diff and capped excerpts. Codex without a sandbox gets more.
const DIFF_CAP = { claude: 120000, codex: 120000, fx: 40000 }
const EXCERPT_CAP = { codex: 60000, fx: 24000 }

export async function reviewRound(ctx, n) {
  const { store } = ctx
  const wt = await ensureWorktree(ctx)
  const dir = `reviews/round-${n}`
  const { patch, stat, tree } = await diffSince(wt.path, wt.baseCommit)
  const reviewers = availableMembers(ctx).filter(id => id !== wt.implementer)
  if (!reviewers.length) {
    const res = { round: n, tree, reviewed: false, reviewers: [], failed: [], findings: [], blocking: 0, note: 'no reviewer available' }
    store.writeJson(`${dir}/merged.json`, res)
    store.warn(`review round ${n}: no reviewer available`)
    return res
  }
  const common = { task: ctx.task, plan: cap(ctx.plan, 8000), round: n, base: wt.baseCommit.slice(0, 12) }
  const prompts = {}
  for (const id of reviewers) {
    const inline = promptOnly(ctx, id)
    prompts[id] = render('review', {
      ...common,
      diff: cap(patch, DIFF_CAP[id]),
      access: inline ? 'You cannot read files or run commands: everything you need is in this prompt.' : 'You may read files in the current directory (the worktree with the change applied) for context.',
      excerpts: inline ? `## Current contents of the changed files\n${await fileExcerpts(wt.path, tree, stat.paths, { total: EXCERPT_CAP[id] || 24000 })}` : ''
    })
  }
  ctx.log(`review ${n}: ${reviewers.map(id => promptOnly(ctx, id) ? `${id} (prompt only)` : id).join(', ')} (read-only)`)
  const results = await Promise.all(reviewers.map(id => callMember(ctx, id, {
    role: 'review', prompt: prompts[id], name: `review-${n}-${id}`,
    cwd: promptOnly(ctx, id) ? ctx.scratch.empty(`review-${n}-${id}`) : wt.path
  })))

  const valid = [], failed = []
  for (let i = 0; i < reviewers.length; i++) {
    const id = reviewers[i], r = results[i]
    writeCallLogs(ctx, `review-${n}-${id}`, r)
    let entry = { member: id, round: n, tree, durationMs: r.durationMs, usage: r.usage }
    if (!r.ok) entry = { ...entry, status: 'failed', error: r.error, findings: [] }
    else {
      const p = await parseWithRetry(ctx, id, r, { parse: parseFindings, shape: FINDINGS_SHAPE, name: `review-${n}-${id}` })
      entry = p.ok
        ? { ...entry, status: 'ok', findings: p.value, nudged: p.nudged }
        : { ...entry, status: 'invalid', error: p.error, findings: [], raw: cap(r.text, 4000) }
    }
    store.writeJson(`${dir}/${id}.json`, entry)
    if (entry.status === 'ok') valid.push(entry); else { failed.push(id); store.warn(`review round ${n}: ${id} ${entry.status} (${entry.error})`) }
  }
  const findings = dedupeFindings(valid.map(v => ({ member: v.member, findings: v.findings })))
  const res = { round: n, tree, reviewed: valid.length > 0, reviewers: valid.map(v => v.member), failed, findings, blocking: findings.filter(isBlocking).length }
  store.writeJson(`${dir}/merged.json`, res)
  ctx.log(`review ${n}: ${res.reviewed ? `${findings.length} finding(s), ${res.blocking} blocker/major` : 'no valid review'}`)
  return res
}

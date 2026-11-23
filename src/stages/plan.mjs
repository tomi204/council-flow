// Stage 1: blind planning. Same brief to every available member in parallel, then a blind judge.
import crypto from 'node:crypto'
import { render } from '../prompts.mjs'
import { repoSummary } from '../repo.mjs'
import { redactIdentities, findIdentityLeaks, shuffle } from '../redact.mjs'
import { parseVerdict } from '../json.mjs'
import { StageError, availableMembers, callMember, writeCallLogs, parseWithRetry, modelTerms, promptOnly } from './common.mjs'

const VERDICT_SHAPE = '{"choice": "A" | "B" | "C" | "merge", "plan": "<plan in Markdown>", "rationale": "<short reason>"}'

// Builds the judge's input: task and plans redacted of model/tool names, plans shuffled to A/B/C. The leak check
// runs on the complete rendered prompt. Returns the label map, which is stored only in verdict.json.
export function buildJudgeInput({ task, plans, extraTerms = [], randomInt = crypto.randomInt }) {
  const ids = Object.keys(plans)
  const labels = ['A', 'B', 'C'].slice(0, ids.length)
  const order = shuffle(ids, randomInt)
  const mapping = Object.fromEntries(labels.map((l, i) => [l, order[i]]))
  const blocks = labels.map(l => `=== PLAN ${l} ===\n${redactIdentities(plans[mapping[l]], extraTerms).trim()}\n=== END PLAN ${l} ===`).join('\n\n')
  const input = render('judge', { task: redactIdentities(task, extraTerms), labels: labels.join(', '), choices: [...labels.map(l => `"${l}"`), '"merge"'].join(', '), plans: blocks })
  const leaks = findIdentityLeaks(input, extraTerms)
  if (leaks.length) throw new StageError(`redaction failed, the judge input would contain: ${leaks.join(', ')}`)
  return { input, labels, mapping }
}

export async function planStage(ctx) {
  const { cfg, store } = ctx
  const summary = await repoSummary(ctx.repoRoot, { testCmd: cfg.testCmd })
  const brief = render('plan', { task: ctx.task, repo_summary: summary.text, test_cmd: summary.testCmd || '(none detected)' })
  store.write('brief.md', brief)

  const planners = availableMembers(ctx)
  if (planners.length < 2) throw new StageError(`planning needs at least two available members; available: ${planners.join(', ') || 'none'}`)
  ctx.log(`plan: asking ${planners.join(', ')} in parallel (blind)`)
  const results = await Promise.all(planners.map(id => callMember(ctx, id, {
    role: 'plan', prompt: brief, name: `plan-${id}`,
    cwd: promptOnly(ctx, id) ? ctx.scratch.empty(`plan-${id}`) : ctx.repoRoot     // prompt-only members get an empty dir
  })))

  // Plan text stays in memory until judging is over: nothing a judge (or a retried planner) could read is on disk.
  const plans = {}
  const logs = []
  results.forEach((r, i) => {
    const id = planners[i]
    logs.push([`plan-${id}`, r])
    if (r.ok && r.text.trim()) plans[id] = r.text.trim()
    else store.warn(`plan from ${id} missing: ${r.error || 'empty answer'}`)
  })
  const persist = (withPlans) => {
    for (const [name, r] of logs) writeCallLogs(ctx, name, r, { stdout: withPlans })
    if (withPlans) for (const [id, text] of Object.entries(plans)) store.write(`plans/${id}.md`, text + '\n')
  }
  if (Object.keys(plans).length < 2) { persist(false); throw new StageError(`only ${Object.keys(plans).length} plan(s) came back; planning needs two`) }

  const { input, labels, mapping } = buildJudgeInput({ task: ctx.task, plans, extraTerms: modelTerms(cfg), randomInt: ctx.randomInt })
  store.write('judge/input.md', input)

  const order = [cfg.judge, ...cfg.members.filter(m => m !== cfg.judge)]
  let verdict = null, judge = null
  for (const id of availableMembers(ctx, order)) {
    const r = await callMember(ctx, id, { role: 'judge', prompt: input, cwd: ctx.scratch.empty(`judge-${id}`), name: `judge-${id}` })
    writeCallLogs(ctx, `judge-${id}`, r)
    if (!r.ok) { store.warn(`judge ${id} failed: ${r.error}`); continue }
    store.write(`judge/output-${id}.txt`, r.text)
    const p = await parseWithRetry(ctx, id, r, { parse: t => parseVerdict(t, labels), shape: VERDICT_SHAPE, name: `judge-${id}` })
    if (p.ok) { verdict = p.value; judge = id; break }
    store.warn(`judge ${id} gave no valid verdict: ${p.error}`)
  }
  if (!verdict) { persist(false); throw new StageError('no judge produced a valid verdict (plans were not kept, so a retry stays blind)') }
  persist(true)
  if (judge !== cfg.judge) store.warn(`judge fell back from ${cfg.judge} to ${judge}`)

  // The implementer gets the judge's version (the chosen plan with its corrections, or the merge); the selected
  // original is kept below it for reference and attribution.
  const chosenMember = verdict.choice === 'merge' ? null : mapping[verdict.choice]
  const original = chosenMember ? plans[chosenMember] : null
  if (verdict.choice === 'merge' && !verdict.plan) throw new StageError('merge verdict without a plan')
  const parts = []
  if (verdict.plan) parts.push(`# Plan (judge's version, choice ${verdict.choice})\n\n${verdict.plan.trim()}`)
  if (original) parts.push(`# Selected plan ${verdict.choice} as written\n\n${original}`)
  parts.push(`---\nJudge rationale: ${verdict.rationale || '(none given)'}`)
  store.writeJson('verdict.json', {
    choice: verdict.choice, rationale: verdict.rationale, judgePlan: verdict.plan, judge,
    labels: mapping, chosenMember, planners: Object.keys(plans), createdAt: new Date().toISOString()
  })
  store.write('plan.md', parts.join('\n\n') + '\n')
  ctx.log(`plan: judge chose ${verdict.choice}${chosenMember ? ` (${chosenMember})` : ''}`)
  return { choice: verdict.choice, judge, chosenMember }
}

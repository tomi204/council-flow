// Stage 5: run the repo's tests in the worktree, write summary.md, ask the gate, publish only on approval.
// Tests, summary and gate are all bound to one candidate tree id; publish commits exactly that tree.
import fs from 'node:fs'
import path from 'node:path'
import { installedPackageDirs, prepareTestTree } from '../audit/test-tree.mjs'
import { offlineCommand } from '../audit/offline.mjs'
import { runProcess } from '../proc.mjs'
import { envFor } from '../env.mjs'
import { detectTestCommand, diffSince, writeTree, restoreTree, remotes, resolveCommit, isAncestor } from '../repo.mjs'
import { scrubSecrets, scrubAudit } from '../redact.mjs'
import { isBlocking } from '../json.mjs'
import { decide } from '../gate.mjs'
import { publish as realPublish, expectedBinding } from '../publish.mjs'
import { ensureWorktree } from './common.mjs'

const tailText = (s, n) => (s.length > n ? `[... ${s.length - n} earlier characters cut]\n${s.slice(-n)}` : s)

// Runs the test command on the candidate tree. A previous result is reused only for the same tree and command and
// only when it passed; a failure is always retried. Files the tests write do not become part of the candidate.
export async function runTests(ctx, tree, { focus, folder = 'tests' } = {}) {
  const { cfg, store } = ctx
  const wt = await ensureWorktree(ctx)
  const invocation = focus?.invocation
  const cmd = invocation ? [invocation.exe, ...invocation.args].join(' ') : cfg.testCmd || detectTestCommand(wt.path)
  const installedModules = cfg.audit && cmd ? await installedPackageDirs(ctx, wt, tree) : undefined
  const prev = store.exists(`${folder}/result.json`) ? store.readJson(`${folder}/result.json`) : null
  const cacheableInputs = !cfg.audit || (prev?.installedModules?.length === 0 && installedModules?.length === 0)
  if (prev && cacheableInputs && prev.passed && prev.tree === tree && prev.cmd === cmd && JSON.stringify(prev.focus) === JSON.stringify(focus)) { ctx.log('tests: reusing the passing result for this tree'); return prev }
  if (!cmd) {
    const res = { cmd: null, tree, status: 'none', passed: false, note: 'no test command detected; pass --test-cmd' }
    store.writeJson(`${folder}/result.json`, res)
    return res
  }
  // A command that contains a known secret value or a literal credential would put it in argv: refuse it.
  if ((cfg.audit ? scrubAudit(cmd, ctx.env) : scrubSecrets(cmd, { env: ctx.env, mode: 'code' })) !== cmd) {
    const res = { cmd, tree, status: 'refused', passed: false, note: 'the test command contains a secret value; not run' }
    store.writeJson(`${folder}/result.json`, res)
    ctx.log('tests: refused (the test command contains a secret value)')
    return res
  }
  ctx.log(`tests: ${cmd}`)
  // The repo's own test command, with no secrets and no inherited git overrides in its env.
  // A parent node:test worker marks its children. A nested node --test otherwise
  // exits successfully without running the requested suite.
  const set = { CI: '1', NODE_TEST_CONTEXT: null }
  const program = invocation || { exe: '/bin/sh', args: ['-c', cmd] }
  const spec = cfg.audit ? offlineCommand('test', program.exe, program.args) : program
  let cwd = wt.path
  let r
  try {
    if (cfg.audit) {
      cwd = fs.mkdtempSync(path.join(ctx.scratch.root, 'test-tree-'))
      await prepareTestTree(ctx, wt, tree, cwd, installedModules)
      const tmp = fs.mkdtempSync(path.join(ctx.scratch.root, 'test-home-'))
      Object.assign(set, { HOME: tmp, TMPDIR: tmp, npm_config_offline: 'true', COUNCIL_NODE_PREFIX: path.dirname(path.dirname(process.execPath)) })
    }
    r = await runProcess({ ...spec, cwd, timeoutMs: cfg.testTimeoutMs,
      env: envFor('test', ctx.env, { fxKeyEnv: cfg.fxKeyEnv, set }) })
  } finally {
    if (cfg.audit && cwd !== wt.path) {
      fs.rmSync(cwd, { recursive: true, force: true })
      fs.rmSync(cwd + '.index', { force: true })
    }
  }
  const output = cfg.audit ? 'Audit tests ran offline. Raw project output is omitted because it can print local configuration values.'
    : tailText(r.stdout, 150000) + '\n--- stderr ---\n' + tailText(r.stderr, 50000)
  store.write(`${folder}/output.txt`, `$ ${cmd}\n(exit ${r.exitCode}${r.timedOut ? ', timed out' : ''}, ${(r.durationMs / 1000).toFixed(1)}s)\n\n${output}\n`)
  // Whatever the tests wrote (new files, edits) is undone: the worktree goes back to exactly the candidate, so a
  // later resume does not see test output as a change. Ignored files (build output) stay.
  const after = cfg.audit ? tree : await writeTree(wt.path)
  if (after !== tree) await restoreTree(wt.path, tree)
  const res = { cmd, tree, focus, installedModules, status: r.ok ? 'passed' : (r.timedOut ? 'timeout' : 'failed'), passed: r.ok, exitCode: r.exitCode, timedOut: r.timedOut, durationMs: r.durationMs, wroteFiles: after !== tree }
  store.writeJson(`${folder}/result.json`, res)
  ctx.log(`tests: ${res.status}`)
  return res
}

// The PR is opened against baseBranch on the remote; if the recorded base is not on that branch, the PR would also
// show commits nobody reviewed.
export async function checkBase(ctx) {
  const wt = ctx.store.state.worktree
  const rems = await remotes(ctx.repoRoot)
  const remote = rems.includes('origin') ? 'origin' : rems[0]
  if (!remote) return { ok: true, note: 'no remote: nothing can be pushed' }
  if (!wt.baseBranch) return { ok: false, problem: 'the run started from a detached HEAD, so the PR base is unknown and the PR could show unreviewed commits (use --base-branch <branch>)' }
  const tip = await resolveCommit(ctx.repoRoot, `refs/remotes/${remote}/${wt.baseBranch}`)
  if (!tip) return { ok: false, problem: `${remote}/${wt.baseBranch} is not fetched locally, so the PR base cannot be verified (git fetch ${remote}, or use --base-branch)` }
  if (!(await isAncestor(ctx.repoRoot, wt.baseCommit, tip))) {
    return { ok: false, problem: `base ${wt.baseCommit.slice(0, 12)} is not on ${remote}/${wt.baseBranch}: the PR would also contain commits that were not reviewed (push them first or use --base-branch)` }
  }
  return { ok: true }
}

const esc = (s) => String(s ?? '').replace(/\|/g, '\\|').replace(/\n+/g, ' ')

export function decisionFor({ tests, findings, reviewed, stopReason, stat, baseCheck, fixFailed = false }) {
  const reasons = []
  if (fixFailed) reasons.push(`${stopReason}; the open findings were not addressed`)
  if (!stat || stat.files === 0) reasons.push('the implementer produced no changes')
  if (!reviewed) reasons.push('the latest change was not reviewed (no reviewer produced a valid review)')
  const blockers = findings.filter(f => f.severity === 'blocker').length
  const majors = findings.filter(f => f.severity === 'major').length
  if (blockers) reasons.push(`${blockers} blocker finding(s) open`)
  if (tests.status === 'none') reasons.push('no test command, so nothing was tested')
  else if (tests.status === 'skipped' || tests.status === 'refused') reasons.push(`tests ${tests.status}: ${tests.note}`)
  else if (!tests.passed) reasons.push(`tests ${tests.status} (${tests.cmd})`)
  if (baseCheck && !baseCheck.ok) reasons.push(baseCheck.problem)
  return { ready: reasons.length === 0, reasons, blockers, majors, stopReason }
}

export function writeSummary(ctx, { tests, findings, loop, stat, decision, gate, publish }) {
  const { store, cfg } = ctx
  const st = store.state, wt = st.worktree || {}
  let verdict = null
  try { verdict = store.readJson('verdict.json') } catch { /* planning failed */ }
  const L = []
  L.push(`# council-flow run ${store.runId}`, '')
  L.push(`**Task:** ${ctx.task.split('\n')[0]}`, '')
  L.push(`**Outcome:** ${gate ? `${decision.ready ? 'ready for PR' : 'escalated'}; gate answered **${gate.decision}** via ${gate.via}${gate.error ? ` (${gate.error})` : ''}${publish ? `; publish: ${publish.status}${publish.prUrl ? ` (${publish.prUrl})` : ''}` : ''}` : (decision.ready ? 'ready for PR, waiting for the gate' : 'escalated, waiting for the gate')}`)
  if (!decision.ready) L.push('', `**Why escalated:** ${decision.reasons.join('; ')}`)
  L.push('', `- Repo: \`${ctx.repoRoot}\``, `- Base: \`${(wt.baseCommit || '').slice(0, 12)}\`${wt.baseBranch ? ` (${wt.baseBranch})` : ''}`,
    `- Worktree: \`${wt.path || '-'}\` (${wt.mode || '-'} mode, local branch \`${wt.branch || '-'}\`, PR branch \`council/${store.runId}\`)`,
    `- Candidate tree (what the gate approves and publish commits): \`${st.candidate?.tree || '-'}\``,
    `- Implementer: ${wt.implementer || '-'}${cfg.dryRun ? '  \n- **Dry run:** every member, Orca call and the gate were fakes' : ''}`)

  L.push('', '## Members', '', '| member | status | calls | input tokens | output tokens | note |', '|---|---|---|---|---|---|')
  for (const id of ['claude', 'codex', 'fx']) {
    const m = st.members[id]
    if (!m) continue
    const sb = m.sandbox === 'broken' ? `; sandbox broken: ${m.sandboxReason || ''}` : ''
    L.push(`| ${id} | ${m.status} | ${m.usage.calls} | ${m.usage.inputTokens} | ${m.usage.outputTokens} | ${esc((m.reason || '') + sb)} |`)
  }

  L.push('', '## Plan', '')
  if (verdict) {
    const labels = Object.entries(verdict.labels).map(([l, m]) => `${l} = ${m}`).join(', ')
    L.push(`Judge (${verdict.judge}, blind) chose **${verdict.choice}**${verdict.chosenMember ? ` (${verdict.chosenMember})` : ''}. Labels, unsealed after judging: ${labels}.`, '', `Rationale: ${verdict.rationale || '(none)'}`, '', 'Full plan: `plan.md`.')
  } else L.push('(no verdict)')

  L.push('', '## Change', '')
  if (stat) L.push(`${stat.files} file(s), +${stat.insertions} -${stat.deletions}`, '', ...stat.paths.slice(0, 40).map(p => `- \`${p}\``), stat.paths.length > 40 ? `- ... ${stat.paths.length - 40} more` : '')

  L.push('', '## Review', '', `Review rounds: ${loop.n}. Fix rounds: ${loop.fixRounds} of max ${cfg.rounds}. Loop stopped: ${loop.stopReason}.`, '')
  if (!loop.reviewed) L.push(`**The candidate tree has not been reviewed.** Findings below are from the last valid review${loop.reviewedRound ? ` (round ${loop.reviewedRound})` : ''}.`, '')
  if (findings.length) {
    L.push('Open findings (deduplicated):', '', '| severity | category | where | issue | suggestion |', '|---|---|---|---|---|')
    for (const f of findings) L.push(`| ${f.severity} | ${f.category} | ${esc(f.file)}${f.line ? `:${f.line}` : ''} | ${esc(f.issue)} | ${esc(f.suggestion)} |`)
  } else L.push(loop.reviewed ? 'No open findings.' : 'No findings carried over.')

  L.push('', '## Tests', '', ['skipped', 'refused'].includes(tests.status) ? `Tests **${tests.status}**: ${tests.note}.` : tests.cmd ? `\`${tests.cmd}\`: **${tests.status}** (exit ${tests.exitCode}, ${((tests.durationMs || 0) / 1000).toFixed(1)}s)${tests.wroteFiles ? '; files the tests wrote were undone and are not part of the candidate' : ''}. Output: \`tests/output.txt\`.` : 'No test command detected (use `--test-cmd`).')

  if (st.warnings.length) L.push('', '## Degraded mode and warnings', '', ...st.warnings.map(w => `- ${w}`))

  L.push('', '## Next steps', '', `- Inspect the change: \`git -C ${wt.path} diff --cached ${(wt.baseCommit || '').slice(0, 12)}\``,
    `- Re-run the gate later (or re-review after editing the worktree): \`council-flow --resume ${store.runId} --repo ${ctx.repoRoot}\``,
    `- Discard (manual; council-flow never deletes branches): \`git -C ${ctx.repoRoot} worktree remove ${wt.path}\` then \`git -C ${ctx.repoRoot} branch -D ${wt.branch}\``, '')
  store.write('summary.md', L.join('\n'))
}

export async function gateAndPublish(ctx, { decision, findings, publish = realPublish, gate: gateFn = decide }) {
  const { store, cfg } = ctx
  const binding = expectedBinding(store)
  const pr = binding.dest
  const summaryPath = store.path('summary.md')
  const open = findings.filter(isBlocking).slice(0, 5).map(f => `[${f.severity}] ${f.file}${f.line ? `:${f.line}` : ''} ${f.issue}`.slice(0, 160))
  const what = `tree ${binding.tree.slice(0, 12)} on base ${binding.base.slice(0, 12)}`
  const question = decision.ready
    ? `council-flow ${store.runId}: tests passed and no blockers${decision.majors ? ` (${decision.majors} major finding(s) still open)` : ''}. Open PR ${pr} (${what})? Summary: ${summaryPath}`
    : `council-flow ${store.runId} needs a decision: ${decision.reasons.join('; ')}.${open.length ? ` Open findings: ${open.join(' | ')}.` : ''} Open a DRAFT PR ${pr} (${what}) anyway? Summary: ${summaryPath}`
  const workerIds = store.state.worktree?.dispatches || []
  const gate = await gateFn({ cfg, env: ctx.env, orca: ctx.orca, orcaUsable: ctx.orcaInfo.usable, question, title: `council-flow ${store.runId}`, binding, workerIds })
  store.writeJson('gate.json', gate)
  ctx.log(`gate: ${gate.decision} (via ${gate.via}${gate.error ? `: ${gate.error}` : ''})`)
  let result = null
  if (gate.decision === 'approve') {
    const title = `council-flow: ${ctx.task.split('\n')[0].slice(0, 72)}`
    try { result = await publish({ cfg, env: ctx.env, store, approval: gate, title, draft: !decision.ready }) } catch (e) {
      result = { ...(store.exists('publish.json') ? store.readJson('publish.json') : {}), status: 'failed', error: e.message }
      store.writeJson('publish.json', result)
    }
    ctx.log(`publish: ${result.status}${result.prUrl ? ` ${result.prUrl}` : ''}${result.error ? ` (${result.error})` : ''}`)
  }
  return { gate, publish: result }
}

export async function currentDiff(ctx) {
  const wt = await ensureWorktree(ctx)
  return diffSince(wt.path, wt.baseCommit)
}

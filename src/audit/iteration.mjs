import { render } from '../prompts.mjs'
import { git, cap, writeTree, restoreTree } from '../repo.mjs'
import { ensureWorktree, isAvailable } from '../stages/common.mjs'
import { runTests } from '../stages/finish.mjs'
import { auditJson, MemberFailure } from './calls.mjs'
import { inTarget, safeDiff } from './context.mjs'
import { auditDiff, changesBetween, ScopeError } from './scope.mjs'
import { blueReport, invalid, iterationVerdict, patchReport, patchable, redFindings } from './findings.mjs'
import { scrubAuditData } from '../redact.mjs'

export async function candidateDiff(ctx, from, tree) {
  const diff = safeDiff(await auditDiff(ctx.store, from, tree), ctx.env)
  if (diff.length > 30000) throw new Error('candidate diff exceeds audit review budget')
  return diff
}

const folder = it => `iterations/${it.number}`
const name = (it, role) => `iteration-${it.number}-${role}`
const receipt = (it, role) => `${folder(it)}/${role}/result.json`

// An ID denotes the same reported location across teams and iterations.
export function mergeFindings(...groups) {
  const rows = new Map()
  for (const f of groups.flat()) {
    if (rows.has(f.id) && rows.get(f.id).file !== f.file) invalid('finding.id', 'an existing ID refers to a different file')
    rows.set(f.id, f)
  }
  return [...rows.values()]
}

async function checkedFindings(ctx, text, tree, ledger, role, it) {
  let dropped = 0
  let rows
  try { rows = redFindings(text, () => dropped++) }
  finally { if (dropped) ctx.store.warn(`${role} iteration ${it.number}: stripped ${dropped} prohibited field(s)`) }
  rows = scrubAuditData(rows, ctx.env)
  mergeFindings(ledger, rows)
  for (const f of rows) {
    const known = ledger.some(old => old.id === f.id)
    if (!known && (role === 'Blue') !== f.id.startsWith('B-')) invalid('finding.id', role === 'Blue' ? 'new Blue IDs must start with B-' : 'B- is reserved for Blue')
    if (!inTarget(f.file, ctx.store.state.target)) invalid('finding.file', 'outside the declared target')
    if (known && f.status === 'fixed') continue
    const blob = await git(['--literal-pathspecs', 'ls-tree', '-z', tree, '--', f.file], ctx.repoRoot)
    if (!/^100(?:644|755) blob /.test(blob.stdout)) invalid('finding.file', 'expected a regular file in the starting snapshot')
  }
  return { findings: rows, dropped }
}

export const activeFixes = loop => loop.proofs.flatMap(p => p.fixes)

async function red(ctx, loop, it, common, pack) {
  const evidence = pack.material.excerpts.map(e => e.file + '\n' + e.excerpt).join('\n\n')
  const prompt = render('audit-red', { ...common, brief: cap(pack.red_brief, 1200),
    ledger: JSON.stringify(loop.ledger.map(({ id, severity, file, line, title, status }) => ({ id, severity, file, line, title, status }))),
    evidence: cap(evidence, 12000) + '\nCandidate diff:\n' + common.diff })
  const result = await auditJson(ctx, { id: 'fx', role: 'audit-red', prompt, name: name(it, 'red'),
    shape: prompt.split('Shared pack SHA-256')[0] }, value => checkedFindings(ctx, JSON.stringify(value), it.start, loop.ledger, 'Red', it))
  ctx.store.writeJson(receipt(it, 'red'), { tree: it.start, packHash: common.hash, ...result })
  it.redDone = true
  ctx.store.save()
}

async function blue(ctx, loop, it, common, pack) {
  const { store } = ctx
  const wt = await ensureWorktree(ctx)
  const readOnly = ctx.cfg.rounds === 0
  const shape = render('audit-blue-schema')
  const prompt = render('audit-blue', { ...common, schema: shape, brief: JSON.stringify(pack),
    prior: JSON.stringify({ ledger: loop.ledger, feedback: loop.feedback, claims: activeFixes(loop) }),
    mode: readOnly ? 'Report-only iteration. Return findings and an empty fixes array. No edits.' :
      'Propose source fixes and safe regression tests in this council worktree. Correct or revert rejected work.' })
  if (await writeTree(wt.path) !== it.start) throw new Error('starting worktree changed before Blue')
  loop.rollback = it.start
  store.save()
  try {
    const role = readOnly ? 'audit-blue-read' : 'audit-patch'
    let tree, changes, cumulative
    const prior = activeFixes(loop)
    const { findings, proof } = await auditJson(ctx, { id: 'claude', role, prompt, name: name(it, 'blue'),
      cwd: readOnly ? undefined : wt.path, shape }, async value => {
      const out = blueReport(value)
      const { findings } = await checkedFindings(ctx, JSON.stringify(out.findings), it.start, loop.ledger, 'Blue', it)
      const known = mergeFindings(loop.ledger.filter(f => patchable(f) || prior.some(p => p.id === f.id)),
        findings.filter(f => !loop.ledger.some(old => old.id === f.id)))
      await ensureWorktree(ctx)
      tree = await writeTree(wt.path)
      changes = await changesBetween(store, it.start, tree)
      cumulative = await changesBetween(store, wt.baseCommit, tree)
      const proof = patchReport(out.fixes, known, cumulative)
      for (const fix of proof.fixes) {
        const old = prior.find(p => p.id === fix.id)
        const sourceChanged = changes.includes(fix.file)
        const testChanged = changes.includes(fix.test)
        if ((!sourceChanged && old?.file !== fix.file) || (!testChanged && old?.test !== fix.test) || (!sourceChanged && !testChanged)) {
          invalid('fixes', 'each claim needs a changed source and regression or an amendment')
        }
      }
      if (changes.length && !proof.fixes.length && changes.some(file => cumulative.includes(file))) invalid('fixes', 'a changed worktree requires a patch claim')
      return { findings, proof }
    })
    const retained = prior.filter(f => !proof.fixes.some(p => p.id === f.id) && (cumulative.includes(f.test) || cumulative.includes(f.file)))
    const fixes = [...retained, ...proof.fixes]
    if (readOnly && (changes.length || proof.fixes.length)) throw new Error('report-only iteration changed the candidate')
    await ctx.scopePolicy.validate(cumulative, tree, fixes)
    const diff = await candidateDiff(ctx, it.start, tree)
    store.write(`patches/${it.number}.diff`, diff)
    store.writeJson(receipt(it, 'blue'), { tree, start: it.start, packHash: common.hash, findings, fixes: proof.fixes })
    loop.proofs = [{ fixes }]
    if (changes.length) loop.patches++
    it.tree = tree
    it.blueDone = true
    delete loop.rollback
    store.save()
  } catch (e) {
    await ensureWorktree(ctx)
    await restoreTree(wt.path, it.start)
    if (await writeTree(wt.path) !== it.start) throw new Error('Blue rollback did not restore the starting tree')
    delete loop.rollback
    store.save()
    if (e instanceof ScopeError) throw new MemberFailure('claude audit-patch rolled back: ' + e.message)
    throw e
  }
}

export async function parallelReview(ctx, loop, it, context) {
  const common = { hash: context.hash, scope: ctx.scope, round: it.number,
    diff: await candidateDiff(ctx, ctx.store.state.worktree.baseCommit, it.start) }
  if (!isAvailable(ctx, 'codex')) throw new Error('Codex is required to judge both outputs')
  const results = await Promise.allSettled([
    !it.redDone && red(ctx, loop, it, common, context.pack),
    !it.blueDone && blue(ctx, loop, it, common, context.pack)
  ])
  const failures = {}
  for (const [i, r] of results.entries()) {
    if (r.status !== 'rejected') continue
    // Filesystem and rollback failures are integrity errors. Only a
    // member failure with its work successfully restored can be adjudicated.
    if (!(r.reason instanceof MemberFailure)) throw r.reason
    const team = ['red', 'blue'][i]
    const member = ['fx', 'claude'][i]
    failures[team] = r.reason.message
    const failure = { status: 'failed', member, error: r.reason.message, packHash: it.hash, tree: it.start }
    ctx.store.writeJson(`${folder(it)}/${team}/failure.json`, failure)
    const message = `Iteration ${it.number} ${team}: ${r.reason.message}`
    ctx.log(message)
    ctx.store.warn(message)
  }
  it.teamFailures = failures
  if (!it.redDone && !it.blueDone) {
    ctx.store.save()
    throw new Error('Both audit teams failed: ' + Object.values(failures).join(' / '))
  }
  if (!it.blueDone) {
    it.tree = it.start
    ctx.store.write(`patches/${it.number}.diff`, '')
  }
  it.teamsComplete = true
  ctx.store.save()
}

export function reports(store, it) {
  const read = role => {
    const r = store.readJson(receipt(it, role))
    if (r.packHash !== it.hash || r.tree !== (role === 'red' ? it.start : it.tree)) throw new Error('iteration receipt binding mismatch')
    r.findings = redFindings(JSON.stringify(r.findings))
    return r
  }
  const report = role => {
    if (it[role + 'Done']) return read(role)
    return { status: 'failed', error: it.teamFailures?.[role], findings: [], fixes: [] }
  }
  return { red: report('red'), blue: report('blue') }
}

export async function judge(ctx, loop, it, context, outputs, findings) {
  const { store } = ctx
  const fixes = activeFixes(loop)
  if (it.judged) {
    const saved = store.readJson(receipt(it, 'review'))
    if (saved.packHash !== it.hash || saved.tree !== it.tree) throw new Error('saved verdict binding mismatch')
    return iterationVerdict(JSON.stringify(saved.verdict), findings, fixes)
  }
  const claims = await Promise.all(fixes.map(async f => ({ ...f, invocation: await ctx.scopePolicy.focus(f.test) })))
  const evidence = { ...outputs, findings, claims, previousVerdict: loop.feedback, startingTree: it.start, candidate: it.tree,
    patch: store.read(`patches/${it.number}.diff`), cumulativeDiff: await candidateDiff(ctx, store.state.worktree.baseCommit, it.tree) }
  const prompt = render('audit-codex-review', { hash: context.hash, scope: ctx.scope, brief: JSON.stringify(context.pack), evidence: JSON.stringify(evidence) })
  const verdict = await auditJson(ctx, { id: 'codex', role: 'audit-review', prompt, name: name(it, 'review'),
    shape: prompt.split('Pack SHA-256')[0] }, value => scrubAuditData(iterationVerdict(JSON.stringify(value), findings, fixes), ctx.env))
  store.writeJson(receipt(it, 'review'), { packHash: it.hash, tree: it.tree, verdict })
  it.judged = true
  store.save()
  return verdict
}

export async function regressions(ctx, fixes, tree, dir) {
  const files = new Map()
  for (const { test, id } of fixes) {
    if (!files.has(test)) files.set(test, new Set())
    files.get(test).add(id)
  }
  const results = []
  for (const [file, ids] of files) {
    const focus = { file, ids: [...ids].sort(), invocation: await ctx.scopePolicy.focus(file) }
    const folder = `${dir}/regression-${results.length + 1}`
    if (focus.invocation) results.push(await runTests(ctx, tree, { folder, focus }))
    else {
      const result = { tree, focus, passed: false, status: 'unverified', note: 'no focused runner for ' + file }
      ctx.store.writeJson(folder + '/result.json', result)
      results.push(result)
    }
  }
  return results
}

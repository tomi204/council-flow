// publish.mjs: commit, push and open the PR. Only ever called with an approved gate result whose binding matches
// the run (tree, base, worktree, destination, repository).
//
// It commits exactly the approved tree with `git commit-tree <tree> -p <base>` (the live directory is not staged
// again, so files written by tests or edits made while the gate was open are not included), pushes that commit to
// refs/heads/council/<run-id> with --no-follow-tags (never --force, never a + refspec, never deletes a branch) and
// runs gh pr create --repo <the push remote's repository>. Each step is checkpointed in publish.json (committed ->
// pushed -> pr-opened), so a resume finishes only the missing steps; before the PR step the remote branch must still
// point at the approved commit.
import { git, verifyWorktree, resolveCommit, remoteInfo, remoteHead } from './repo.mjs'
import { run, which } from './proc.mjs'
import { envFor } from './env.mjs'
import { auditScope, changesBetween } from './audit/scope.mjs'
import { auditGit } from './audit/offline.mjs'
import { bindingMatches } from './gate.mjs'
import { scrubSecrets } from './redact.mjs'

const PROTECTED = new Set(['main', 'master', 'trunk', 'develop', 'production', 'release'])
export const DONE = 'pr-opened'

export function expectedBinding(store) {
  const wt = store.state.worktree || {}
  return { tree: store.state.candidate?.tree || null, base: wt.baseCommit || null, worktree: wt.path || null, dest: `council/${store.runId}`, repo: store.state.candidate?.repo ?? null }
}

export async function publish({ cfg, env = process.env, store, approval, title, draft = false }) {
  const expected = expectedBinding(store)
  if (!bindingMatches(approval, expected)) throw new Error('refusing to publish: no approval for exactly this tree, base, worktree, destination and repository')
  const wt = store.state.worktree
  const localOnly = cfg.audit || store.state.mode === 'audit'
  if (localOnly && (approval.answer !== 'approve' || wt.mode !== 'git' || wt.branch !== expected.dest || expected.repo !== store.repoRoot)) throw new Error('audit requires exact local approval')
  if (localOnly) await auditGit.run(true, async () => {
    const changes = await changesBetween(store, expected.base, expected.tree)
    await auditScope(store).validate(changes, expected.tree, store.state.auditLoop.proofs.flatMap(p => p.fixes))
  })
  const dest = expected.dest
  if (PROTECTED.has(dest) || dest === wt.baseBranch) throw new Error('refusing to push to a protected branch')
  const safeTitle = scrubSecrets(title, { env })
  const bodyFile = store.path('summary.md')
  const prArgs = ['pr', 'create', ...(expected.repo && !expected.repo.startsWith('remote:') ? ['--repo', expected.repo] : []), '--head', dest, '--title', safeTitle, '--body-file', bodyFile]
  if (wt.baseBranch) prArgs.push('--base', wt.baseBranch)
  if (draft) prArgs.push('--draft')
  // A checkpoint for another tree is history, not progress: its terminal status must not carry over.
  const prev = store.exists('publish.json') ? store.readJson('publish.json') : {}
  const same = prev.tree === expected.tree
  const result = same ? { ...prev, steps: prev.steps || [] }
    : { steps: [], previous: prev.tree ? { tree: prev.tree, status: prev.status || null, pushed: prev.pushed || null, prUrl: prev.prUrl || null } : null }
  Object.assign(result, { at: new Date().toISOString(), remoteBranch: dest, tree: expected.tree, repo: expected.repo, draft })
  const step = (name, r, extra = {}) => result.steps.push({ name, ok: r.ok, at: new Date().toISOString(), error: r.ok ? null : (r.stderr || r.error || '').trim().slice(-500), ...extra })
  const finish = (status) => { result.status = status; store.writeJson('publish.json', result); return result }

  if (cfg.dryRun) {
    result.wouldRun = [`git commit-tree ${expected.tree} -p ${expected.base}`, `git push --no-follow-tags origin <commit>:refs/heads/${dest}`, `gh ${prArgs.join(' ')}`]
    if (localOnly) result.wouldRun = result.wouldRun.slice(0, 1)
    return finish('dry-run')
  }

  const v = await verifyWorktree(store.repoRoot, wt.path, { branch: wt.branch, expectPath: wt.mode === 'git' ? store.path('worktree') : null })
  if (!v.branch || PROTECTED.has(v.branch) || v.branch === wt.baseBranch) throw new Error(`refusing to publish from branch "${v.branch}" (protected or base branch)`)
  if ((await git(['cat-file', '-t', expected.tree], wt.path, { allowFail: true })).stdout.trim() !== 'tree') throw new Error(`approved tree ${expected.tree} is missing`)

  // The push remote must still be the repository the approval named.
  const info = localOnly ? { id: store.repoRoot } : await remoteInfo(wt.path)
  if ((info ? info.id : null) !== (expected.repo ?? null)) throw new Error(`refusing to publish: the push remote is now ${info ? info.id : 'missing'}, the approval was for ${expected.repo}`)

  // 1. commit: exactly the approved tree, on the recorded base (or on top of what an earlier approval already pushed).
  const treeOf = async (c) => (await git(['rev-parse', `${c}^{tree}`], wt.path, { allowFail: true })).stdout.trim()
  const priorCommit = localOnly && !same && prev.status === 'committed-local' ? prev.commit : result.previous?.pushed
  const parent = (!same && priorCommit) || expected.base
  let commit = result.commit && (await resolveCommit(wt.path, result.commit)) ? result.commit : null
  if (commit && (await treeOf(commit)) !== expected.tree) commit = null
  if (!commit) {
    const r = await git(['commit-tree', expected.tree, '-p', parent, '-m', safeTitle, '-m', `Generated by council-flow run ${store.runId}.`], wt.path, { allowFail: true })
    step('commit', r)
    if (!r.ok) return finish('commit-failed')
    commit = r.stdout.trim()
    if (localOnly) result.parent = parent
    result.commit = commit
    result.status = 'committed'
    store.writeJson('publish.json', result)
    // Git mode: move this run's own local branch from the base to the commit (compare-and-swap, never forced).
    if (!localOnly && wt.mode === 'git') step('local-branch', await git(['update-ref', `refs/heads/${v.branch}`, commit, parent], wt.path, { allowFail: true }))
  }

  if (localOnly) {
    const ref = `refs/heads/${dest}`
    if (await resolveCommit(wt.path, ref) !== commit) {
      const r = await git(['update-ref', ref, commit, result.parent || parent], wt.path, { allowFail: true })
      step('local-branch', r)
      if (!r.ok) return finish('branch-moved')
    }
    return finish('committed-local')
  }

  // 2. push the commit, no tags.
  if (!info) return finish('committed-no-remote')
  const remote = info.remote
  result.remote = remote
  if (result.pushed !== commit) {
    const r = await git(['-c', 'push.followTags=false', 'push', '--no-follow-tags', remote, `${commit}:refs/heads/${dest}`], wt.path, { allowFail: true, timeoutMs: 300000, kind: 'push' })
    step('push', r, { remote })
    if (!r.ok) return finish('push-failed')
    result.pushed = commit
    result.status = 'pushed'
    store.writeJson('publish.json', result)
  }

  // 3. the PR, only while the remote branch still holds exactly the approved commit. An existing PR counts as done.
  const head = await remoteHead(wt.path, remote, dest)
  if (head !== commit) {
    result.error = head === undefined ? `could not read ${remote}/${dest}` : `${remote}/${dest} is at ${head || 'nothing'}, not the approved commit ${commit}; review again before opening a PR`
    return finish('remote-moved')
  }
  if (!info.repo) return finish('pushed-no-github-repo')
  const gh = which(cfg.bins.gh, env)
  if (!gh) return finish('pushed-no-gh')
  const pr = await run(gh, prArgs, { cwd: wt.path, timeoutMs: 120000, env: envFor('gh', env, { fxKeyEnv: cfg.fxKeyEnv }) })
  const existing = /already exists/i.test(pr.stderr) ? (pr.stderr.match(/https?:\/\/\S+/) || [null])[0] : null
  step('pr', pr.ok || existing ? { ok: true } : pr)
  if (pr.ok || existing) { result.prUrl = existing || (pr.stdout.match(/https?:\/\/\S+/) || [null])[0]; return finish(DONE) }
  return finish('pushed-pr-failed')
}

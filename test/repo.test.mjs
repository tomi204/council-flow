// Git layer: worktree identity checks, symlink-safe reads, hooks and inherited git overrides neutralised.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { verifyWorktree, addWorktree, fileExcerpts, repoSummary, writeTree, git as cfGit } from '../src/repo.mjs'
import { toyRepo, git, tmp } from './helpers.mjs'

test('verifyWorktree accepts only this repo\'s registered linked worktree on the expected branch', async () => {
  const toy = toyRepo()
  const wt = path.join(toy.dir, '.council-flow', 'r', 'worktree')
  await addWorktree(toy.dir, wt, 'council/r', toy.head)
  assert.equal((await verifyWorktree(toy.dir, wt, { branch: 'council/r', expectPath: wt })).branch, 'council/r')
  await assert.rejects(() => verifyWorktree(toy.dir, toy.dir), /primary checkout/)
  await assert.rejects(() => verifyWorktree(toy.dir, wt, { branch: 'main' }), /expected main/)
  // Another repository's worktree, and a plain clone, are not ours.
  const other = toyRepo()
  const otherWt = path.join(other.dir, 'wt2')
  await addWorktree(other.dir, otherWt, 'x', other.head)
  await assert.rejects(() => verifyWorktree(toy.dir, otherWt), /not a registered worktree/)
  // A symlink planted where this run's worktree should be.
  const runDir = path.join(toy.dir, '.council-flow', 's')
  fs.mkdirSync(runDir, { recursive: true })
  fs.symlinkSync(wt, path.join(runDir, 'worktree'))
  await assert.rejects(() => verifyWorktree(toy.dir, path.join(runDir, 'worktree'), { expectPath: path.join(runDir, 'worktree') }), /symlink/)
})

test('fileExcerpts reads git blobs only: a symlink to a host file is never inlined', async () => {
  const toy = toyRepo()
  const secret = path.join(tmp('council-host-'), 'host-secret.txt')
  fs.writeFileSync(secret, 'HOST-FILE-CONTENT-12345\n')
  fs.symlinkSync(secret, path.join(toy.dir, 'leak.txt'))
  fs.writeFileSync(path.join(toy.dir, 'ok.txt'), 'regular content\n')
  const tree = await writeTree(toy.dir)
  const ex = await fileExcerpts(toy.dir, tree, ['leak.txt', 'ok.txt'])
  assert.doesNotMatch(ex, /HOST-FILE-CONTENT/)
  assert.match(ex, /leak\.txt \(symlink: not shown\)/)
  assert.match(ex, /regular content/)
})

test('repoSummary skips a tracked key file that is a symlink', async () => {
  const toy = toyRepo()
  const secret = path.join(tmp('council-host-'), 'notes.md')
  fs.writeFileSync(secret, 'HOST-NOTES-67890\n')
  fs.symlinkSync(secret, path.join(toy.dir, 'AGENTS.md'))
  git(toy.dir, 'add', 'AGENTS.md'); git(toy.dir, 'commit', '-q', '-m', 'link')
  const s = await repoSummary(toy.dir)
  assert.match(s.text, /AGENTS\.md/, 'listed as a tracked file')
  assert.doesNotMatch(s.text, /HOST-NOTES/)
})

test('council-flow\'s git runs without hooks and ignores an inherited GIT_INDEX_FILE / GIT_DIR', async () => {
  const toy = toyRepo()
  const marker = path.join(tmp('council-hook-'), 'hook-ran')
  const hook = path.join(toy.dir, '.git', 'hooks', 'post-checkout')
  fs.writeFileSync(hook, `#!/bin/sh\ntouch '${marker}'\n`, { mode: 0o755 })
  await addWorktree(toy.dir, path.join(toy.dir, 'wt'), 'council/h', toy.head)
  assert.ok(!fs.existsSync(marker), 'post-checkout hook must not run')
  const bogusIndex = path.join(tmp('council-idx-'), 'index')
  fs.writeFileSync(path.join(toy.dir, 'wt', 'new.txt'), 'x\n')
  const base = { ...process.env, GIT_INDEX_FILE: bogusIndex, GIT_DIR: '/nonexistent' }
  const r = await cfGit(['add', '-A'], path.join(toy.dir, 'wt'), { baseEnv: base })
  assert.equal(r.ok, true)
  assert.ok(!fs.existsSync(bogusIndex), 'the inherited index file was not used')
  assert.match(git(path.join(toy.dir, 'wt'), 'diff', '--cached', '--name-only'), /new\.txt/)
})

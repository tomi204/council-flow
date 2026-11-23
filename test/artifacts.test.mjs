// The run folder: run ids never contain task text, symlinked components are refused, one process per run.
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { spawnSync } from 'node:child_process'
import { RunStore, newRunId, validRunId } from '../src/artifacts.mjs'
import { tmp } from './helpers.mjs'

test('new run ids are timestamp + randomness only', () => {
  const id = newRunId(new Date(2026, 10, 21, 9, 8, 7))
  assert.match(id, /^20261121-090807-[0-9a-f]{8}$/)
  assert.ok(validRunId(id))
  assert.ok(!validRunId('../x') && !validRunId('a/b') && !validRunId('x.lock') && !validRunId(''))
})

test('a symlinked .council-flow, run folder or stage folder is refused', () => {
  const repo = tmp('council-art-'), elsewhere = tmp('council-art-out-')
  fs.symlinkSync(elsewhere, path.join(repo, '.council-flow'))
  assert.throws(() => RunStore.create(repo, 'r1', {}), /symlink/)
  assert.deepEqual(fs.readdirSync(elsewhere), [], 'nothing was written through the link')

  const repo2 = tmp('council-art-')
  const s = RunStore.create(repo2, 'r2', {})
  fs.symlinkSync(elsewhere, path.join(s.dir, 'plans'))
  assert.throws(() => s.write('plans/x.md', 'hello'), /symlink/)
  assert.deepEqual(fs.readdirSync(elsewhere), [])
  s.unlock()
})

test('run creation is exclusive and a live lock blocks a second process; a dead owner\'s lock is taken over', () => {
  const repo = tmp('council-art-')
  const s = RunStore.create(repo, 'r3', { task: 't' })
  assert.throws(() => RunStore.create(repo, 'r3', {}), /already exists/)
  assert.throws(() => RunStore.open(repo, 'r3'), /in use by process/, 'the lock held by this process blocks another opener')
  s.unlock()
  // A lock left by a process that no longer exists.
  const dead = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))'], { encoding: 'utf8' })
  fs.writeFileSync(path.join(s.dir, '.lock'), JSON.stringify({ pid: Number(dead.stdout), host: os.hostname(), at: 'then' }))
  const again = RunStore.open(repo, 'r3')
  assert.match(again.lockNote, /stale lock/)
  again.unlock()
  assert.ok(!fs.existsSync(path.join(s.dir, '.lock')))
})

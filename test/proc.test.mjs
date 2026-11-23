// The process runner: rolling output capture and a timeout that kills the whole process group.
import test from 'node:test'
import assert from 'node:assert/strict'
import { runProcess } from '../src/proc.mjs'
import { sleep } from '../src/proc.mjs'

test('output beyond the capture limit keeps the END (where result records are) and says it was truncated', async () => {
  const r = await runProcess({ exe: process.execPath, args: ['-e', 'process.stdout.write("x".repeat(5000) + "\\nTHE-END\\n")'], timeoutMs: 15000, maxCapture: 1000 })
  assert.equal(r.ok, true)
  assert.equal(r.stdoutTruncated, true)
  assert.ok(r.stdout.endsWith('THE-END\n'))
  assert.equal(r.stdout.length, 1000)
  assert.equal(r.stdoutBytes, 5009)
})

test('timeout: a descendant that closed its pipes and ignores SIGTERM is still killed (SIGKILL to the group)', async () => {
  // The leader starts a child that ignores TERM and detaches its stdio, prints the child's pid, then waits.
  const keeper = `"${process.execPath}" -e "process.on('SIGTERM', () => {}); setTimeout(() => {}, 30000)"`
  const script = `${keeper} </dev/null >/dev/null 2>&1 & echo $!; wait`
  const t0 = Date.now()
  const r = await runProcess({ exe: '/bin/sh', args: ['-c', script], timeoutMs: 500, killGraceMs: 300 })
  assert.equal(r.timedOut, true)
  const pid = Number(r.stdout.trim())
  assert.ok(pid > 0, r.stdout)
  await sleep(200)
  let alive = true
  try { process.kill(pid, 0) } catch { alive = false }
  if (alive) { try { process.kill(pid, 'SIGKILL') } catch { /* cleanup */ } }
  assert.equal(alive, false, 'the TERM-ignoring descendant survived the timeout')
  assert.ok(Date.now() - t0 < 5000)
})

test('a missing binary is an error result, not a throw', async () => {
  const r = await runProcess({ exe: '/nonexistent/council-flow-nope', args: [], timeoutMs: 5000 })
  assert.equal(r.ok, false)
  assert.match(r.error, /not found/)
})

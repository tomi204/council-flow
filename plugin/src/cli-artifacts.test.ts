// The Workflows cards against what council-flow really writes: two token-free --dry-run runs (fake
// members, fake gate that says no) on a scratch repository, read back with the plugin's own reader.
// If the CLI renames a stage or changes run.json, this fails instead of the cards quietly drifting.
import { spawnSync } from 'node:child_process'
import * as fs from 'node:fs'
import * as path from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { listRuns } from './runs'
import { progressOf, type RunState } from './progress'

type Helpers = { BIN: string; toyRepo: () => { dir: string }; testEnv: (extra?: Record<string, string>) => Record<string, string> }
const helpers = (async () => (await import(new URL('../../test/helpers.mjs', import.meta.url).href)) as Helpers)()

const AUDIT = '20261123-120000-aaaaaaaa'
const CODE = '20261123-120100-bbbbbbbb'

async function dryRuns(): Promise<string> {
  const { BIN, toyRepo, testEnv } = await helpers
  const toy = toyRepo()
  const env = testEnv()
  const audit = spawnSync('node', [BIN, 'audit', '--repo', toy.dir, '--dry-run', '--rounds', '1', '--run-id', AUDIT, '--', 'Review authorization in the request handler'], { env, encoding: 'utf8', timeout: 180_000 })
  assert.equal(audit.status, 0, audit.stderr)
  const code = spawnSync('node', [BIN, 'run', '--repo', toy.dir, '--dry-run', '--run-id', CODE, '--', 'Add hello.txt'], { env, encoding: 'utf8', timeout: 180_000 })
  assert.equal(code.status, 0, code.stderr)
  return toy.dir
}

describe('cards from real council-flow runs', () => {
  test('finished dry runs read as done, gate declined, with their loop and counts', async () => {
    const repo = await dryRuns()
    const runs = Object.fromEntries(listRuns(repo).runs.map((r) => [r.runId, r]))
    const audit = runs[AUDIT]
    assert.equal(audit.mode, 'audit')
    assert.equal(audit.progress.phase, 'done')
    assert.equal(audit.progress.outcome, 'gate declined')
    assert.equal(audit.progress.round, 'iteration 1/1')
    assert.equal(audit.progress.findings, 0)
    assert.deepEqual(audit.progress.steps.map((s) => `${s.label}:${s.state}`), ['context:done', 'red & blue:done', 'Codex review:done', 'tests:done', 'approve:next'])
    assert.equal(audit.since, null)
    assert.deepEqual(audit.files, { summary: true, findings: true, runJson: true })

    const code = runs[CODE]
    assert.equal(code.mode, 'code')
    assert.equal(code.progress.phase, 'done')
    assert.equal(code.progress.outcome, 'gate declined')
    assert.match(code.progress.round ?? '', /^review round \d+ · fixes \d+\/2$/)
    assert.equal(code.progress.steps.at(-1)?.label, 'approve')
  })

  test('every stage name council-flow writes is one the cards know', async () => {
    const repo = await dryRuns()
    for (const id of [AUDIT, CODE]) {
      const state = JSON.parse(fs.readFileSync(path.join(repo, '.council-flow', id, 'run.json'), 'utf8')) as RunState & { stages: Record<string, unknown> }
      const mode = state.mode === 'audit' ? 'audit' : 'code'
      const names = Object.keys(state.stages)
      assert.ok(names.length >= 4, `${id}: ${names.join(', ')}`)
      for (const name of names) {
        const live = progressOf({ mode, lock: 'alive', lockAt: Date.now() - 1000, state: { ...state, outcome: null, stages: { [name]: { status: 'running', startedAt: new Date().toISOString() } } } })
        assert.ok(live.steps.some((s) => s.state === 'current'), `${mode} stage "${name}" is not on the card's trail`)
      }
    }
  })
})

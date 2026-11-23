import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { spawnSync } from 'node:child_process'
import { afterEach, assert, describe, test } from 'orca/testing'
import { checkRepo, listRuns, MAX_ARTIFACT_BYTES, readArtifact, readRun, RunsError } from './runs'

const noMatch = (value: string, re: RegExp, message?: string) => assert.ok(!re.test(value), message ?? `${value} matches ${re}`)

const made: string[] = []
afterEach(() => {
  while (made.length) fs.rmSync(made.pop() as string, { recursive: true, force: true })
})

function repo(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-plugin-runs-'))
  made.push(root)
  fs.mkdirSync(path.join(root, '.git'))
  fs.mkdirSync(path.join(root, '.council-flow'))
  fs.writeFileSync(path.join(root, '.council-flow', '.gitignore'), '*\n')
  return root
}

function run(root: string, id: string, files: Record<string, string | object>): string {
  const dir = path.join(root, '.council-flow', id)
  fs.mkdirSync(dir, { recursive: true })
  for (const [name, body] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), typeof body === 'string' ? body : JSON.stringify(body))
  return dir
}

const deadPid = (): number => {
  const r = spawnSync('/bin/true', [], { encoding: 'utf8' }) as unknown as { pid: number }
  return r.pid
}

describe('listRuns', () => {
  test('derives mode and status from run.json, the lock and summary.md', () => {
    const root = repo()
    run(root, '20261120-100000-aaaaaaaa', {
      'run.json': { version: 2, runId: 'x', mode: 'audit', task: 'Review authorization\nin the reader', createdAt: '2026-11-20T10:00:00Z', updatedAt: '2026-11-20T10:30:00Z',
        config: { dryRun: true }, targetInput: 'localhost:3000', outcome: { status: 'declined', gate: 'deny', unresolved: 2, stopReason: 'max-rounds' } },
      'summary.md': '# Local security audit\n', 'findings.md': '# Findings\n'
    })
    run(root, '20261121-100000-bbbbbbbb', { 'run.json': { version: 2, task: 'Add /health', createdAt: '2026-11-21T10:00:00Z', updatedAt: '2026-11-21T10:05:00Z', config: { dryRun: false }, outcome: null } })
    run(root, '20261122-100000-cccccccc', {
      'run.json': { version: 2, task: 'still going', createdAt: '2026-11-22T10:00:00Z', updatedAt: '2026-11-22T10:01:00Z', outcome: null },
      '.lock': JSON.stringify({ pid: process.pid, host: os.hostname(), at: 'now' })
    })
    run(root, '20261119-100000-dddddddd', {
      'run.json': { version: 2, task: 'crashed', createdAt: '2026-11-19T10:00:00Z', updatedAt: '2026-11-19T10:00:00Z', outcome: null },
      '.lock': JSON.stringify({ pid: deadPid(), host: os.hostname(), at: 'then' })
    })
    run(root, '20261118-100000-eeeeeeee', {
      'run.json': { version: 2, task: 'elsewhere', createdAt: '2026-11-18T10:00:00Z', updatedAt: '2026-11-18T10:00:00Z' },
      '.lock': JSON.stringify({ pid: 1, host: 'some-other-box', at: 'then' })
    })
    run(root, '20261117-100000-ffffffff', { 'summary.md': '# council-flow run\n\n**Outcome:** failed: boom\n' })
    run(root, '20261116-100000-00000000', { 'run.json': { version: 2, task: 'failed run', createdAt: '2026-11-16T10:00:00Z', updatedAt: '2026-11-16T10:00:00Z', outcome: { status: 'failed', error: 'x' } } })

    const { runs, truncated } = listRuns(root)
    assert.equal(truncated, false)
    const by = Object.fromEntries(runs.map((r) => [r.runId.slice(-8), r]))
    assert.deepEqual(runs.map((r) => r.runId.slice(-8)), ['cccccccc', 'bbbbbbbb', 'aaaaaaaa', 'dddddddd', 'eeeeeeee', '00000000', 'ffffffff'])

    assert.equal(by.aaaaaaaa.mode, 'audit')
    assert.equal(by.aaaaaaaa.status, 'declined')
    assert.equal(by.aaaaaaaa.tone, 'warning')
    assert.equal(by.aaaaaaaa.title, 'Review authorization')
    assert.equal(by.aaaaaaaa.target, 'localhost:3000')
    assert.equal(by.aaaaaaaa.unresolved, 2)
    assert.equal(by.aaaaaaaa.stopReason, 'max-rounds')
    assert.equal(by.aaaaaaaa.dryRun, true)
    assert.deepEqual(by.aaaaaaaa.files, { summary: true, findings: true, runJson: true })
    assert.equal(by.aaaaaaaa.resumable, true)

    assert.equal(by.bbbbbbbb.mode, 'code')
    assert.equal(by.bbbbbbbb.status, 'interrupted')
    assert.equal(by.bbbbbbbb.target, null)

    assert.equal(by.cccccccc.status, 'running')
    assert.equal(by.cccccccc.running, true)
    assert.equal(by.cccccccc.resumable, false)

    assert.equal(by.dddddddd.status, 'interrupted', 'a lock left by a dead process is stale')
    assert.equal(by.eeeeeeee.status, 'locked by some-other-box')
    assert.equal(by.eeeeeeee.resumable, false)

    assert.equal(by.ffffffff.status, 'failed', 'summary.md fallback')
    assert.equal(by.ffffffff.mode, 'unknown')
    assert.equal(by.ffffffff.resumable, false)
    assert.equal(by['00000000'].tone, 'danger')
  })

  test('skips what is not a run folder, symlinks included', () => {
    const root = repo()
    run(root, '20261120-100000-aaaaaaaa', { 'run.json': { version: 2, task: 'real' } })
    fs.mkdirSync(path.join(root, '.council-flow', 'worktrees'))
    fs.mkdirSync(path.join(root, '.council-flow', 'bad name!'))
    fs.writeFileSync(path.join(root, '.council-flow', '20261120-100000-bbbbbbbb'), 'a file')
    const outside = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-plugin-outside-'))
    made.push(outside)
    fs.writeFileSync(path.join(outside, 'run.json'), JSON.stringify({ task: 'outside' }))
    fs.symlinkSync(outside, path.join(root, '.council-flow', '20261120-100000-cccccccc'))
    assert.deepEqual(listRuns(root).runs.map((r) => r.runId), ['20261120-100000-aaaaaaaa'])
    assert.throws(() => readArtifact(root, '20261120-100000-cccccccc', 'run.json'), (e) => e instanceof RunsError)
  })

  test('no .council-flow folder yet: no runs', () => {
    const root = repo()
    fs.rmSync(path.join(root, '.council-flow'), { recursive: true })
    assert.deepEqual(listRuns(root), { repo: root, runs: [], truncated: false })
  })

  test('refuses a symlinked .council-flow folder', () => {
    const root = repo()
    fs.rmSync(path.join(root, '.council-flow'), { recursive: true })
    const elsewhere = fs.mkdtempSync(path.join(os.tmpdir(), 'cf-plugin-elsewhere-'))
    made.push(elsewhere)
    fs.symlinkSync(elsewhere, path.join(root, '.council-flow'))
    assert.throws(() => listRuns(root), /symlink/)
  })

  test('the repository must be an absolute local Git checkout', () => {
    const root = repo()
    assert.equal(checkRepo(`${root}/`), root)
    fs.rmSync(path.join(root, '.git'), { recursive: true })
    assert.throws(() => checkRepo(root), /not a Git checkout/)
    assert.throws(() => checkRepo('relative'), /absolute/)
    assert.throws(() => checkRepo(`${root}/../x`), /absolute/)
    assert.throws(() => checkRepo('/nonexistent/cf-plugin'), /no folder/)
  })
})

describe('readArtifact', () => {
  test('reads only summary.md, findings.md and run.json, scrubbed', () => {
    const root = repo()
    const token = `ghp_${'a1'.repeat(15)}`
    run(root, '20261120-100000-aaaaaaaa', {
      'summary.md': `# Summary\nleaked ${token}\nLYBER_API_KEY=lyb-1234567890abcdef\n-----BEGIN RSA PRIVATE KEY-----\nMIIabc\n-----END RSA PRIVATE KEY-----\n`,
      'findings.md': '# Findings\n',
      'run.json': '{"task":"x","config":{"fxKeyEnv":"LYBER_API_KEY"}}',
      'gate.json': '{}'
    })
    const a = readArtifact(root, '20261120-100000-aaaaaaaa', 'summary.md')
    noMatch(a.text, /a1a1a1/)
    noMatch(a.text, /lyb-1234567890abcdef/)
    noMatch(a.text, /MIIabc/)
    assert.match(a.text, /ghp_\[REDACTED\]/)
    assert.equal(a.truncated, false)
    assert.equal(a.path, path.join(root, '.council-flow', '20261120-100000-aaaaaaaa', 'summary.md'))

    const j = readArtifact(root, '20261120-100000-aaaaaaaa', 'run.json')
    assert.equal(j.text, JSON.stringify({ task: 'x', config: { fxKeyEnv: 'LYBER_API_KEY' } }, null, 2), 'pretty-printed; a variable name is not a secret')

    for (const name of ['gate.json', '../../.git/config', 'logs/x.txt', '.lock', 'worktree']) {
      assert.throws(() => readArtifact(root, '20261120-100000-aaaaaaaa', name), /can be opened/)
    }
    for (const id of ['..', '../..', '.', 'a/b', 'worktrees']) assert.throws(() => readArtifact(root, id, 'summary.md'), /invalid run id/)
  })

  test('refuses a symlinked artifact', () => {
    const root = repo()
    const dir = run(root, '20261120-100000-aaaaaaaa', { 'run.json': '{}' })
    fs.symlinkSync('/etc/hostname', path.join(dir, 'summary.md'))
    assert.throws(() => readArtifact(root, '20261120-100000-aaaaaaaa', 'summary.md'), /symlink/)
    assert.equal(listRuns(root).runs[0].files.summary, false)
  })

  test('caps what it reads', () => {
    const root = repo()
    run(root, '20261120-100000-aaaaaaaa', { 'findings.md': 'x'.repeat(MAX_ARTIFACT_BYTES + 10) })
    const a = readArtifact(root, '20261120-100000-aaaaaaaa', 'findings.md')
    assert.equal(a.truncated, true)
    assert.equal(a.text.length, MAX_ARTIFACT_BYTES)
    assert.equal(a.bytes, MAX_ARTIFACT_BYTES + 10)
  })

  test('readRun finds one run or none', () => {
    const root = repo()
    run(root, '20261120-100000-aaaaaaaa', { 'run.json': { mode: 'audit', task: 't', config: { dryRun: true } } })
    assert.equal(readRun(root, '20261120-100000-aaaaaaaa')?.mode, 'audit')
    assert.equal(readRun(root, '20261120-100000-ffffffff'), null)
    assert.throws(() => readRun(root, '../x'), /invalid run id/)
  })
})

describe('progress from the run folder', () => {
  const iso = (msAgo: number) => new Date(Date.now() - msAgo).toISOString()

  test('a live audit: its stage, iteration, findings and the lock\'s start time', () => {
    const root = repo()
    const lockAt = iso(10 * 60_000)
    run(root, '20261123-100000-aaaaaaaa', {
      'run.json': {
        version: 2, mode: 'audit', task: 'Review auth', config: { dryRun: true, rounds: 3 }, outcome: null,
        stages: { 'context-1': { status: 'done', startedAt: iso(9 * 60_000), endedAt: iso(8 * 60_000) }, 'teams-1': { status: 'running', startedAt: iso(8 * 60_000) } },
        auditLoop: { iterations: [{ number: 1 }], ledger: [{ id: 'F-1', status: 'open' }, { id: 'F-2', status: 'fixed' }] }
      },
      '.lock': JSON.stringify({ pid: process.pid, host: os.hostname(), at: lockAt })
    })
    const [r] = listRuns(root).runs
    assert.equal(r.progress.phase, 'running')
    assert.equal(r.progress.stage, 'red & blue')
    assert.equal(r.progress.round, 'iteration 1/3')
    assert.equal(r.progress.findings, 2)
    assert.equal(r.progress.open, 1)
    assert.equal(r.since, Date.parse(lockAt))
  })

  test('waiting for approve: summary.md written after the tests, gate.json not yet', () => {
    const root = repo()
    const dir = run(root, '20261123-100000-bbbbbbbb', {
      'run.json': {
        version: 2, mode: 'audit', task: 'Review auth', config: { rounds: 1 }, outcome: null,
        stages: { 'review-1': { status: 'done', startedAt: iso(5 * 60_000), endedAt: iso(4 * 60_000) }, tests: { status: 'done', startedAt: iso(4 * 60_000), endedAt: iso(3 * 60_000) } }
      },
      '.lock': JSON.stringify({ pid: process.pid, host: os.hostname(), at: iso(20 * 60_000) }),
      'summary.md': '# Local security audit\n'
    })
    assert.equal(readRun(root, '20261123-100000-bbbbbbbb')?.progress.phase, 'waiting-approve')
    fs.writeFileSync(path.join(dir, 'gate.json'), '{"decision":"deny"}')
    assert.equal(readRun(root, '20261123-100000-bbbbbbbb')?.progress.phase, 'publishing', 'answered: recording it')
    fs.rmSync(path.join(dir, '.lock'))
    assert.equal(readRun(root, '20261123-100000-bbbbbbbb')?.progress.phase, 'interrupted', 'the process is gone without an outcome')
  })

  test('a rewritten run.json is read again', () => {
    const root = repo()
    const dir = run(root, '20261123-100000-cccccccc', { 'run.json': { version: 2, task: 't', outcome: null } })
    assert.equal(readRun(root, '20261123-100000-cccccccc')?.progress.phase, 'interrupted')
    fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify({ version: 2, task: 't', outcome: { status: 'declined' }, padding: 'changes the size' }))
    assert.equal(readRun(root, '20261123-100000-cccccccc')?.progress.phase, 'done')
  })

  test('limit keeps the newest run folders', () => {
    const root = repo()
    for (const id of ['20261120-100000-aaaaaaaa', '20261121-100000-bbbbbbbb', '20261122-100000-cccccccc']) run(root, id, { 'run.json': { version: 2, task: id } })
    const res = listRuns(root, 2)
    assert.deepEqual(res.runs.map((r) => r.runId).sort(), ['20261121-100000-bbbbbbbb', '20261122-100000-cccccccc'])
    assert.equal(res.truncated, true)
  })
})

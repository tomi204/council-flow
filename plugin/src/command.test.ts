// The command line is the plugin's only output to a terminal: test it hard.
import { spawnSync } from 'node:child_process'
import { existsSync, mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { assert, describe, test } from 'orca/testing'
import { buildAudit, buildCode, buildDoctor, buildResume, newRunId, oneLine, precheckTarget, precheckTestTarget, shellQuote, terminalTitle, validRunId } from './command'

const noMatch = (value: string, re: RegExp, message?: string) => assert.ok(!re.test(value), message ?? `${value} matches ${re}`)

const CLI = '/home/me/council-flow/bin/council-flow.mjs'
const REPO = '/home/me/code/api'
const ID = '20261122-101500-0a1b2c3d'

/** What /bin/sh makes of a line: the argv it would run, one word per entry. */
function shellWords(line: string): string[] {
  const r = spawnSync('/bin/sh', ['-c', `set -- ${line}; for a in "$@"; do printf '%s\\0' "$a"; done`], { encoding: 'utf8' })
  assert.equal(r.status, 0, r.stderr)
  return r.stdout.split('\0').slice(0, -1)
}

function ok(r: ReturnType<typeof buildAudit>) {
  if (!r.ok) throw new Error(`expected ok, got: ${r.error}`)
  return r
}

describe('audit command', () => {
  test('full form: fixed flags, run id, then the scope after --', () => {
    const r = ok(buildAudit(CLI, REPO, { scope: 'Review request parsing', target: 'localhost:3000', testTarget: 'test/', rounds: '1', dryRun: true, refreshContext: true }, ID))
    assert.deepEqual(r.argv, ['node', CLI, 'audit', '--repo', REPO, '--target', 'localhost:3000', '--test-target', 'test/', '--rounds', '1', '--refresh-context', '--dry-run', '--run-id', ID, '--', 'Review request parsing'])
    assert.equal(r.line, `node ${CLI} audit --repo ${REPO} --target localhost:3000 --test-target test/ --rounds 1 --refresh-context --dry-run --run-id ${ID} -- 'Review request parsing'`)
    assert.equal(r.runId, ID)
  })

  test('blank optional fields are left out: the CLI defaults apply', () => {
    const r = ok(buildAudit(CLI, REPO, { scope: 'x', target: '', testTarget: '', rounds: '' }, ID))
    assert.deepEqual(r.argv, ['node', CLI, 'audit', '--repo', REPO, '--run-id', ID, '--', 'x'])
  })

  test('the shell reads back exactly the argv, whatever the scope says', () => {
    // Each injection attempt can only create a marker file in a fresh temp dir. If quoting ever broke, the shell
    // would create a marker (and the argv would not round-trip): the test fails without running anything harmful.
    const dir = mkdtempSync(join(tmpdir(), 'council-flow-quote-'))
    const marker = (name: string) => join(dir, name)
    try {
      const nasty = [
        `it's "quoted" $HOME \`touch ${marker('backtick')}\` $(touch ${marker('subshell')}) ; touch ${marker('semicolon')} && echo`,
        `x" ; touch ${marker('dquote')} ; echo "`,
        `x' ; touch ${marker('squote')} ; echo '`,
        `| touch ${marker('pipe')} & touch ${marker('background')}`,
        '--dry-run --target example.com:443',
        'COUNCIL_FAKE_GATE=approve',
        "'; approve; '",
        'ünïcødé ✓ \u00a0 nbsp',
        '-h'
      ]
      for (const scope of nasty) {
        const r = ok(buildAudit(CLI, REPO, { scope, target: 'src/a b.js' }, ID))
        assert.deepEqual(shellWords(r.line), r.argv, scope)
        assert.equal(r.argv.at(-1), scope.trim())
        assert.equal(r.argv.at(-2), '--')
      }
      for (const name of ['backtick', 'subshell', 'semicolon', 'dquote', 'squote', 'pipe', 'background']) {
        assert.ok(!existsSync(marker(name)), `the shell ran an injected command (${name}) from a scope`)
      }
    } finally {
      rmSync(dir, { recursive: true, force: true })
    }
  })

  test('newlines and tabs are folded: nothing can reach a gate as type-ahead', () => {
    const r = ok(buildAudit(CLI, REPO, { scope: 'look at auth\napprove\r\napprove\u2028x\tend' }, ID))
    assert.equal(r.argv.at(-1), 'look at auth approve approve x end')
    noMatch(r.line, /[\u0000-\u001f\u007f\u0085\u2028\u2029]/)
  })

  test('other control characters are refused, not passed on', () => {
    for (const scope of ['ctrl-c \u0003', 'esc \u001b[A', 'nul \u0000', 'del \u007f']) {
      const r = buildAudit(CLI, REPO, { scope }, ID)
      assert.equal(r.ok, false, JSON.stringify(scope))
    }
  })

  test('non-local targets are refused before anything is built', () => {
    for (const target of ['example.com:443', 'https://example.com:443', '10.0.0.5:22', '192.168.1.1:80', '[::2]:80', '127.0.0.1', 'localhost', '127.1:80', '127.0.0.256:80',
      '127.0.0.01:80', 'localhost:0', 'localhost:65536', '0x7f000001:80', '2130706433:80', '//localhost:80', ' localhost:80', 'localhost:80 ', 'file:///etc/passwd', 'ftp://localhost:21']) {
      const r = buildAudit(CLI, REPO, { scope: 'x', target }, ID)
      assert.equal(r.ok, false, target)
      if (!r.ok) assert.match(r.error, /--target/)
    }
  })

  test('local targets pass through unchanged for the CLI to validate', () => {
    for (const target of ['localhost:3000', 'http://localhost:3000', 'https://127.0.0.1:8443/', '[::1]:8080', '127.3.4.5:1', 'src/reader.js', 'src', 'docs/a b.md', 'example.com']) {
      const r = ok(buildAudit(CLI, REPO, { scope: 'x', target }, ID))
      assert.equal(r.argv[r.argv.indexOf('--target') + 1], target)
    }
  })

  test('repository paths cannot leave the repo or name its internals', () => {
    for (const target of ['../other', 'src/../../x', '.git/config', 'a/.council-flow/b', '/etc/passwd', 'src\\x']) assert.equal(precheckTarget(target).ok, false, target)
  })

  test('the test target is a repository path only', () => {
    assert.equal(precheckTestTarget('localhost:3000').ok, false)
    assert.equal(precheckTestTarget('test/x.test.mjs').ok, true)
    assert.deepEqual(precheckTestTarget(''), { ok: true, kind: 'repo' })
  })

  test('rounds are 0 to 5; scope is required and bounded', () => {
    assert.equal(buildAudit(CLI, REPO, { scope: 'x', rounds: '6' }, ID).ok, false)
    assert.equal(buildAudit(CLI, REPO, { scope: 'x', rounds: '-1' }, ID).ok, false)
    assert.equal(buildAudit(CLI, REPO, { scope: 'x', rounds: '1e1' }, ID).ok, false)
    assert.deepEqual(ok(buildAudit(CLI, REPO, { scope: 'x', rounds: '0' }, ID)).argv.slice(5, 7), ['--rounds', '0'])
    assert.equal(buildAudit(CLI, REPO, { scope: '  \n ' }, ID).ok, false)
    assert.equal(buildAudit(CLI, REPO, { scope: 'x'.repeat(4001) }, ID).ok, false)
  })

  test('repo and CLI must be absolute paths without ..', () => {
    assert.equal(buildAudit(CLI, 'relative/repo', { scope: 'x' }, ID).ok, false)
    assert.equal(buildAudit(CLI, '/a/../b', { scope: 'x' }, ID).ok, false)
    assert.equal(buildAudit('council-flow', REPO, { scope: 'x' }, ID).ok, false)
    assert.equal(buildAudit(CLI, REPO, { scope: 'x' }, '../escape').ok, false)
  })
})

describe('coding command', () => {
  test('uses the explicit run subcommand so a task can never be read as one', () => {
    for (const task of ['audit', 'doctor', 'issue --github 1', 'Add a /health endpoint']) {
      const r = ok(buildCode(CLI, REPO, { task, implementer: 'claude', rounds: '2', dryRun: true }, ID))
      assert.deepEqual(r.argv, ['node', CLI, 'run', '--repo', REPO, '--implementer', 'claude', '--rounds', '2', '--dry-run', '--run-id', ID, '--', task])
      assert.deepEqual(shellWords(r.line), r.argv)
    }
  })

  test('only codex or claude implement', () => {
    assert.equal(buildCode(CLI, REPO, { task: 'x', implementer: 'fx' as never }, ID).ok, false)
    assert.deepEqual(ok(buildCode(CLI, REPO, { task: 'x' }, ID)).argv, ['node', CLI, 'run', '--repo', REPO, '--run-id', ID, '--', 'x'])
  })
})

describe('resume and doctor', () => {
  test('audit resume keeps the saved scope and target: no positional, no --target', () => {
    const r = ok(buildResume(CLI, REPO, { mode: 'audit', runId: ID, dryRun: true, refreshContext: true }))
    assert.deepEqual(r.argv, ['node', CLI, 'audit', '--repo', REPO, '--resume', ID, '--refresh-context', '--dry-run'])
  })

  test('coding resume', () => {
    assert.deepEqual(ok(buildResume(CLI, REPO, { mode: 'code', runId: ID, dryRun: false })).argv, ['node', CLI, '--resume', ID, '--repo', REPO])
    assert.equal(buildResume(CLI, REPO, { mode: 'code', runId: ID, dryRun: false, refreshContext: true }).ok, false)
    assert.equal(buildResume(CLI, REPO, { mode: 'code', runId: 'x;rm', dryRun: false }).ok, false)
  })

  test('doctor', () => {
    assert.deepEqual(ok(buildDoctor(CLI, REPO)).argv, ['node', CLI, 'doctor', '--repo', REPO])
  })
})

describe('helpers', () => {
  test('shellQuote', () => {
    assert.equal(shellQuote('plain/path-1.js'), 'plain/path-1.js')
    assert.equal(shellQuote(''), "''")
    assert.equal(shellQuote("a'b"), `'a'\\''b'`)
    assert.equal(shellQuote('a b'), "'a b'")
  })

  test('run ids look like council-flow ones and pass its rule', () => {
    const id = newRunId(new Date(2026, 10, 22, 9, 5, 7), () => new Uint8Array([0, 15, 160, 255]))
    assert.equal(id, '20261122-090507-000fa0ff')
    assert.ok(validRunId(id))
    assert.ok(validRunId(newRunId()))
    for (const bad of ['', '..', 'a/b', 'x.lock', 'worktrees', 'a.', '-a', 'a'.repeat(81)]) assert.equal(validRunId(bad), false, bad)
  })

  test('oneLine', () => {
    assert.equal(oneLine('  a\n\n b  ', 'x'), 'a b')
    assert.throws(() => oneLine(3, 'x'))
  })

  test('terminal titles name the run', () => {
    assert.equal(terminalTitle('audit', ID), `council-flow audit ${ID}`)
    assert.equal(terminalTitle('doctor', null), 'council-flow doctor')
  })
})

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { createHash } from 'node:crypto'
import { auditScope, changedPaths, changesBetween } from '../src/audit/scope.mjs'
import { runPipeline } from '../src/pipeline.mjs'
import { lastJsonBlock } from '../src/json.mjs'
import { auditCall, collect } from '../src/audit/context.mjs'
import { validateTarget, validateTestTarget } from '../src/audit/target.mjs'
import { redFindings, iterationVerdict } from '../src/audit/findings.mjs'
import { decide } from '../src/gate.mjs'
import { publish, expectedBinding } from '../src/publish.mjs'
import { RunStore } from '../src/artifacts.mjs'
import { cli, tmp, toyRepo, testEnv, git, walk, readJson } from './helpers.mjs'

const sentinel = 'local-config-value-with-spaces-831'
function fixture() {
  const { dir } = toyRepo()
  fs.writeFileSync(path.join(dir, 'guard.mjs'), 'export const allowed = () => true\n')
  fs.writeFileSync(path.join(dir, '.env'), 'UNUSUAL_SETTING="' + sentinel + '"\n')
  fs.writeFileSync(path.join(dir, 'config.yaml'), 'nested:\n  password: |\n    ' + sentinel + '\n')
  fs.writeFileSync(path.join(dir, 'package.json'), JSON.stringify({ scripts: { test: 'node --test' } }))
  fs.symlinkSync('/etc/passwd', path.join(dir, 'unread.mjs'))
  git(dir, 'add', '.')
  git(dir, 'commit', '-qm', 'local guard and config')
  return dir
}

function audit(repo, args = [], knobs = {}, resume = false) {
  return cli(['audit', ...(resume ? ['--resume', 'audit-test'] : ['Review authorization', '--run-id', 'audit-test']), '--repo', repo, '--dry-run', ...args], testEnv(knobs))
}
const dirOf = root => path.join(root, '.council-flow/audit-test')
const state = root => readJson(path.join(dirOf(root), 'run.json'))
const assertOK = r => assert.equal(r.status, 0, r.stderr)

test('target uses literal loopback authorities or real contained regular paths', () => {
  const repo = fixture()
  for (const value of ['localhost:443', 'https://LOCALHOST:443', 'http://127.255.2.1:1/', '[::1]:65535', 'http://[::1]:80']) {
    assert.equal(validateTarget(repo, value).kind, 'loopback', value)
  }
  fs.mkdirSync(path.join(repo, '@local'))
  for (const value of ['.', 'guard.mjs', '@local', path.join(repo, 'guard.mjs')]) assert.equal(validateTarget(repo, value).kind, 'path')
  for (const value of ['::1:80', '//localhost:80', 'http://localhost', 'http://::1:80', 'https://x@localhost:443', 'foo:80', 'file://localhost:80',
    '127.0.0.1.nip.io:80', '127.0.0.1.nip.io', '8.8.8.8', '8.8.8.8:80', '192.168.0.1:80', '2130706433', '2130706433:80',
    '0x7f000001:80', '127.01.0.1:80', '127.1:80', '[::ffff:8.8.8.8]:80', 'localhost:0', 'localhost:65536',
    'localhost:80/foo', 'localhost:80?x', 'localhost:80#x', 'unread.mjs', '.git', '/etc/passwd', '../guard.mjs']) {
    assert.throws(() => validateTarget(repo, value), undefined, value)
  }
  const record = path.join(tmp('audit-record-'), 'calls')
  assert.equal(audit(repo, ['--target', 'https://example.org:443'], { COUNCIL_FAKE_RECORD: record }).status, 1)
  assert.equal(fs.existsSync(record), false)
  assert.equal(fs.existsSync(dirOf(repo)), false)
})

test('only strict, complete Red and Blue JSON counts as a review', () => {
  const valid = { id: 'A1', severity: 'medium', file: 'guard.mjs', line: 1, title: 'Unchecked boolean',
    why_exploitable: 'The condition permits an unchecked value.', impact: 'Authorization failure.', fix_hint: 'Compare to true.', status: 'open' }
  let dropped = 0
  const [f] = redFindings(JSON.stringify([{ ...valid, PoC: {}, payload: 'omit', exploit_code: [] }]), () => dropped++)
  assert.equal(dropped, 3)
  assert.deepEqual(f, valid)
  for (const raw of ['oops []', '{}', '[{}]', JSON.stringify([valid, valid]), JSON.stringify([{ ...valid, file: '../guard' }]),
    JSON.stringify([{ ...valid, severity: 'blocker' }]), JSON.stringify([{ ...valid, line: 0 }])]) assert.throws(() => redFindings(raw))
  const row = { id: f.id, decision: 'false-positive', justification: 'The caller enforces a boolean.' }
  const v = { findings: [row], patches: [], concerns: [], context_delta: 'Account for the caller.' }
  for (const decision of ['confirmed', 'needs-info', 'false-positive']) {
    const value = { ...v, findings: [{ ...row, decision }] }
    assert.deepEqual(iterationVerdict(JSON.stringify(value), [f], []), value)
  }
  for (const invalid of [{ ...v, findings: [] }, { ...v, findings: [row, row] }, { ...v, findings: [{ ...row, justification: '' }] },
    { ...v, patches: [row] }, { ...v, concerns: [{}] }, { ...v, context_delta: null }]) {
    assert.throws(() => iterationVerdict(JSON.stringify(invalid), [f], []))
  }
  assert.throws(() => iterationVerdict(JSON.stringify(v), [f], [f]))
})

test('pack, independent role calls, safe regressions, denial and versioned resume', () => {
  const repo = fixture(), dir = dirOf(repo), head = git(repo, 'rev-parse', 'HEAD')
  const record = path.join(tmp('audit-calls-'), 'calls')
  const knobs = { COUNCIL_FAKE_AUDIT_LEAK: '1', COUNCIL_FAKE_PARALLEL: '1', COUNCIL_FAKE_RECORD: record, COUNCIL_FAKE_SECRET: 'fake-audit-key-0123456789', COUNCIL_FAKE_CODEX_SANDBOX: 'broken' }
  assertOK(audit(repo, ['--target', 'localhost:8080'], knobs))
  const calls = () => fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse)
  const first = calls()
  assert.deepEqual(first.map(c => c.role).sort(), Array(2).fill(['audit-context', 'audit-red', 'audit-patch', 'audit-review']).flat().sort())
  assert.ok(first.filter(c => ['audit-context', 'audit-review'].includes(c.role)).every(c => c.member === 'codex'))
  assert.ok(first.filter(c => c.role === 'audit-patch').every(c => c.member === 'claude'))
  for (const n of [1, 2]) {
    const meta = readJson(path.join(dir, `context/v${n}/meta.json`))
    for (const who of ['red', 'blue', 'review']) {
      assert.equal(readJson(path.join(dir, `iterations/${n}/${who}/result.json`)).packHash, meta.hash)
    }
    assert.ok(first.filter(c => c.stdin.includes(meta.hash)).length >= 3)
  }
  const delta = first.filter(c => c.role === 'audit-context')[1].stdin
  assert.match(delta, /Distinguish the guard and its callers/)
  const revision = JSON.parse(delta.trim().split('Previous pack, Codex verdict, candidate diff and ledger:\n').at(-1))
  assert.deepEqual(revision.previousPack, readJson(path.join(dir, 'context/v1/pack.json')))
  assert.match(revision.verdict.context_delta, /REDACTED/)
  assert.match(delta, /candidateDiff/)
  assert.match(delta, /confirmed/)
  const blues = first.filter(c => c.role === 'audit-patch')
  assert.doesNotMatch(blues[0].stdin, /The helper accepts values outside its boolean contract/)
  assert.match(blues[1].stdin, /The helper accepts values outside its boolean contract/)
  for (const c of first.filter(c => c.role === 'audit-red')) {
    assert.match(c.stdin, /no tools/i)
    assert.match(c.stdin, /No exploit code, payloads, PoCs, step-by-step attack instructions/)
    assert.match(c.stdin, /8080/)
    assert.ok(c.args.includes('ask') && !c.args.includes('--prompt-permissions'))
    assert.equal(c.env.LYBER_API_KEY, knobs.COUNCIL_FAKE_SECRET)
  }
  assert.ok(first.filter(c => c.member !== 'fx').every(c => !c.env.LYBER_API_KEY))
  assert.ok(first.every(c => !c.stdin.includes(sentinel) && !c.stdin.includes('ScrubFixture98765')))
  const read = file => fs.readFileSync(path.join(dir, file), 'utf8')
  const pack = read('context/v1/pack.json')
  const meta = JSON.parse(read('context/v1/meta.json'))
  assert.equal(meta.hash, createHash('sha256').update(pack).digest('hex'))
  assert.equal(meta.commit, head)
  assert.match(pack, /UNUSUAL_SETTING/)
  assert.doesNotMatch(pack, /unread\.mjs/)
  for (const p of ['pack.md', 'briefs/red.md', 'briefs/blue.md']) assert.ok(read('context/v1/' + p))
  for (const p of walk(dir).filter(p => !p.startsWith('worktree/'))) {
    assert.ok(![sentinel, knobs.COUNCIL_FAKE_SECRET, 'DISCARDED_FIELD_SENTINEL', 'ScrubFixture98765'].some(s => read(p).includes(s)), p)
  }
  assert.match(read('findings.md'), /round 1 open → round 1 confirmed → round 2 fixed/)
  assert.match(read('patches/2.diff'), /guard.test.mjs/)
  assert.equal(state(repo).outcome.testsPassed, true)
  assert.equal(git(repo, 'rev-parse', 'HEAD'), head)
  assert.equal(git(repo, 'rev-parse', 'council/audit-test'), head)
  assert.equal(git(repo, 'status', '--porcelain'), '')
  assert.deepEqual(state(repo).warnings.filter(w => w.includes('prohibited field')).length, 2)
  assertOK(audit(repo, [], knobs, true))
  assert.equal(calls().length, first.length)
  assertOK(audit(repo, ['--refresh-context'], knobs, true))
  assert.equal(calls().filter(c => c.role === 'audit-context').length, 3)
  assert.equal(read('context/v1/pack.json'), pack)
  assert.equal(JSON.parse(read('context/v3/meta.json')).mode, 'full')
  assert.equal(cli(['--repo', repo, '--resume', 'audit-test', '--dry-run'], testEnv()).status, 1)
})

test('round bound, persistent finding, clean early stop and fallback context', () => {
  const repo = fixture()
  assertOK(audit(repo, ['--rounds', '2'], { COUNCIL_FAKE_REVIEW: 'always' }))
  assert.equal(state(repo).auditLoop.patches, 1)
  assert.equal(state(repo).auditLoop.round, 2)
  assert.equal(state(repo).outcome.stopReason, 'max-rounds')
  assert.equal(state(repo).auditLoop.ledger[0].status, 'reopened')
  assertOK(audit(repo, ['--refresh-context'], { COUNCIL_FAKE_REVIEW: 'always' }, true))
  assert.equal(state(repo).auditLoop.round, 3, 'an explicit refresh grants one review without resetting the automatic budget')
  assert.equal(state(repo).outcome.stopReason, 'max-rounds')
  const clean = fixture()
  assertOK(audit(clean, [], { COUNCIL_FAKE_REVIEW: 'clean', COUNCIL_FAKE_BADJSON: 'codex:audit-context' }))
  assert.equal(state(clean).context.builder, 'claude')
  assert.equal(state(clean).auditLoop.patches, 0)
  assert.equal(state(clean).auditLoop.round, 1)
  assert.equal(state(clean).outcome.stopReason, 'clean')
  assert.equal(state(clean).config.rounds, 3)
})

test('a failed Blue call rolls back; partial iterations escalate and a fresh review can repair', () => {
  const repo = fixture()
  assertOK(audit(repo, [], { COUNCIL_FAKE_FIX: 'write-then-fail' }))
  assert.equal(state(repo).outcome.stopReason, 'team-incomplete')
  assert.match(state(repo).auditLoop.iterations.at(-1).teamFailures.blue, /claude audit-patch failed/)
  assert.equal(git(path.join(dirOf(repo), 'worktree'), 'status', '--porcelain'), '')
  assertOK(audit(repo, ['--refresh-context'], {}, true))
  assert.equal(state(repo).auditLoop.ledger[0].status, 'fixed')
})

test('both teams failing or a missing judge cannot reach tests or gate', () => {
  for (const knobs of [{ COUNCIL_FAKE_BADJSON: 'fx:audit-red,claude:audit-patch' }, { COUNCIL_FAKE_MISSING: 'codex' }]) {
    const repo = fixture()
    const r = audit(repo, [], knobs)
    assert.equal(r.status, 2)
    if (knobs.COUNCIL_FAKE_BADJSON) assert.match(r.stderr, /Both audit teams failed: fx audit-red.*claude audit-patch/)
    for (const file of ['gate.json', 'tests/result.json']) assert.equal(fs.existsSync(path.join(dirOf(repo), file)), false)
    assert.ok(fs.existsSync(path.join(dirOf(repo), 'summary.md')))
  }
})

test('approval is literal, bound to a local commit and independent of remotes', async () => {
  const repo = fixture()
  const cfg = { audit: true, dryRun: true }
  for (const answer of ['yes', 'y', 'APPROVE', ' approve', 'approve ', 'approve with caveats']) {
    assert.equal((await decide({ cfg, question: 'commit?', env: { COUNCIL_FAKE_GATE: answer } })).decision, 'deny')
  }
  git(repo, 'remote', 'add', 'origin', 'does-not-exist')
  assertOK(audit(repo, [], { COUNCIL_FAKE_GATE: 'approve' }))
  const dir = dirOf(repo)
  const gate = readJson(path.join(dir, 'gate.json'))
  assert.equal(gate.decision, 'approve')
  assert.doesNotMatch(JSON.stringify(readJson(path.join(dir, 'publish.json'))), /git push|gh pr/)
  const store = RunStore.open(repo, 'audit-test')
  try {
    const local = approval => publish({ cfg: { audit: true }, store, approval, title: 'Toy fix' })
    await assert.rejects(local({ ...gate, answer: 'yes' }))
    await assert.rejects(local({ ...gate, binding: { ...gate.binding, tree: 'other' } }))
    const before = git(repo, 'rev-parse', 'HEAD')
    const r = await local(gate)
    assert.equal(r.status, 'committed-local')
    assert.equal(git(repo, 'rev-parse', 'council/audit-test^{tree}'), expectedBinding(store).tree)
    assert.equal(git(repo, 'rev-parse', 'HEAD'), before)
    assert.deepEqual(r.steps.map(s => s.name), ['commit', 'local-branch'])
  } finally { store.unlock() }
})

test('audit tests and descendants cannot create a network socket or write to the primary checkout', () => {
  const repo = fixture()
  const source = `import fs from 'node:fs'
import net from 'node:net'
import assert from 'node:assert/strict'
assert.throws(() => fs.writeFileSync(${JSON.stringify(path.join(repo, 'must-not-exist'))}, 'x'), /EACCES|EPERM/)
assert.throws(() => fs.chmodSync(${JSON.stringify(path.join(repo, 'guard.mjs'))}, 0o777), /EACCES|EPERM/)
const sock = net.createServer()
sock.on('error', e => assert.equal(e.code, 'EPERM'))
sock.listen(0, '127.0.0.1', () => {sock.close(); process.exitCode = 1})
`
  fs.writeFileSync(path.join(repo, 'offline.test.mjs'), source)
  git(repo, 'add', 'offline.test.mjs')
  git(repo, 'commit', '-qm', 'check isolation')
  assertOK(audit(repo))
  assert.equal(state(repo).outcome.testsPassed, true)
  assert.equal(fs.existsSync(path.join(repo, 'must-not-exist')), false)
})

test('audit includes prior local findings, skips symlinks and detects a changed saved pack', () => {
  const repo = fixture()
  const previous = path.join(repo, '.council-flow', 'earlier')
  fs.mkdirSync(previous, { recursive: true })
  fs.writeFileSync(path.join(previous, 'findings.md'), 'Historical guard review. API_KEY=oldHistoricalSecret123')
  const decoy = path.join(repo, '.council-flow', 'later')
  fs.mkdirSync(decoy)
  fs.symlinkSync(path.join(repo, 'config.yaml'), path.join(decoy, 'findings.md'))
  assertOK(audit(repo, ['--rounds', '0']))
  const pack = path.join(dirOf(repo), 'context/v1/pack.json')
  const data = fs.readFileSync(pack, 'utf8')
  assert.match(data, /Historical guard review/)
  assert.doesNotMatch(data, /oldHistoricalSecret123|local-config-value/)
  assert.equal(state(repo).auditLoop.patches, 0)
  fs.writeFileSync(pack, data + ' ')
  const bad = audit(repo, [], {}, true)
  assert.equal(bad.status, 2)
  assert.match(bad.stderr, /context hash mismatch/)
})

test('a failed repository suite blocks publication of a verified fix', () => {
  const repo = fixture()
  assertOK(audit(repo, ['--test-cmd', 'exit 9'], { COUNCIL_FAKE_GATE: 'approve' }))
  assert.equal(state(repo).outcome.status, 'tests-incomplete')
  assert.equal(state(repo).auditLoop.ledger[0].status, 'fixed')
  assert.equal(fs.existsSync(path.join(dirOf(repo), 'publish.json')), false)
  assertOK(audit(repo, ['--test-cmd', 'npm test'], {}, true))
  assert.equal(state(repo).auditLoop.ledger[0].status, 'fixed')
})

test('doctor reports all audit roles and offline isolation using fake CLIs', () => {
  const r = cli(['doctor', '--dry-run'], testEnv({ COUNCIL_FAKE_CODEX_SANDBOX: 'broken' }))
  assertOK(r)
  for (const name of ['context', 'Red', 'Blue', 'judge', 'tests']) assert.match(r.stdout, new RegExp('OK +audit ' + name))
})

test('audit reserves writes for Claude', () => {
  const repo = fixture()
  assert.equal(audit(repo, ['--implementer', 'codex']).status, 1)
  assert.equal(fs.existsSync(dirOf(repo)), false)
})

test('a disputed closure reopens a finding even with passing tests', () => {
  const repo = fixture()
  assertOK(audit(repo, ['--rounds', '2'], { COUNCIL_FAKE_DISPUTE_CLOSURE: 'codex' }))
  const run = state(repo)
  assert.equal(run.outcome.testsPassed, true)
  assert.equal(run.outcome.unresolved, 1)
  assert.equal(run.auditLoop.ledger[0].status, 'reopened')
})

test('invalid targets fail before even availability probes', async () => {
  let probes = 0
  const engines = Object.fromEntries(['fx', 'codex', 'claude'].map(id => [id, { available() { probes++; throw new Error('unexpected probe') } }]))
  await assert.rejects(runPipeline({ audit: true, repo: fixture(), task: 'check', target: 'outside.invalid:80', dryRun: true }, { engines }), /invalid --target/)
  assert.equal(probes, 0)
})

test('audit leaves shared exclusions alone and runs no configured Git content filters', () => {
  const repo = fixture(), marker = path.join(tmp('audit-filter-'), 'marker')
  const exclude = path.join(repo, '.git/info/exclude')
  const original = fs.readFileSync(exclude)
  fs.writeFileSync(path.join(repo, '.gitattributes'), '*.mjs filter=marker\n')
  git(repo, 'add', '.gitattributes')
  git(repo, 'commit', '-qm', 'attribute for fixture')
  for (const kind of ['smudge', 'clean']) git(repo, 'config', 'filter.marker.' + kind, 'touch ' + marker + ' && cat')
  git(repo, 'config', 'filter.marker.required', 'true')
  assertOK(audit(repo))
  assert.equal(state(repo).outcome.testsPassed, true)
  assert.equal(fs.existsSync(marker), false)
  assert.deepEqual(fs.readFileSync(exclude), original)
  assert.equal(git(repo, 'ls-files', '--others', '--exclude-standard'), '')
})

test('secret-bearing filenames and targets never reach a context builder', () => {
  const repo = fixture(), key = 'test-key-for-local-audit-92021'
  const name = key + '.mjs'
  fs.writeFileSync(path.join(repo, name), 'export default true')
  git(repo, 'add', name)
  git(repo, 'commit', '-qm', 'filename fixture')
  const record = path.join(tmp('audit-calls-'), 'calls')
  const knobs = { LYBER_API_KEY: key, COUNCIL_FAKE_RECORD: record }
  assert.equal(audit(repo, ['--target', name], knobs).status, 1)
  const r = audit(repo, [], knobs)
  assert.equal(r.status, 2)
  assert.ok(!r.stderr.includes(key))
  assert.equal(fs.existsSync(record), false)
})

test('the rendered context prompt is scrubbed before the engine adapter', async () => {
  const secret = 'builder-prompt-sentinel-01234'
  let received
  const store = { member: () => ({ status: 'ok' }), save() {}, addUsage() {}, writeJson() {}, write() {}, writeAuditStream() {} }
  const engine = { run({ prompt }) { received = prompt; return { ok: true, text: '{}', durationMs: 1 } } }
  for (const id of ['codex', 'claude']) {
    const ctx = { store, env: { LYBER_API_KEY: secret }, cfg: { members: [id] }, engines: { [id]: engine }, log() {} }
    await auditCall(ctx, id, 'audit-context', 'tracked data ' + secret, 'context', '/tmp')
    assert.equal(received, 'tracked data [REDACTED]')
  }
})

test('opaque or multiline configuration values cannot be exported as key names', () => {
  const repo = fixture(), value = 'SensitiveBodyLooksLikeAKey'
  for (const [file, content] of Object.entries({
    'config.yaml': 'key: |\n  ' + value + '==\n',
    'config.json': '{"ok":1,\n"' + value + '":',
    '.env.multi': 'SECRET="multiline\n' + value + '=text\nend"'
  })) fs.writeFileSync(path.join(repo, file), content)
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'multiline configuration')
  const record = path.join(tmp('audit-config-'), 'calls')
  assertOK(audit(repo, ['--rounds', '0'], { COUNCIL_FAKE_RECORD: record }))
  assert.ok(!fs.readFileSync(record, 'utf8').includes(value))
  assert.ok(!fs.readFileSync(path.join(dirOf(repo), 'context/v1/pack.json'), 'utf8').includes(value))
})

test('Red rejects prohibited content in every prose field before artifacts or Blue', () => {
  const finding = { id: 'F1', severity: 'low', file: 'guard.mjs', line: 1, title: 'Missing validation',
    why_exploitable: 'The caller trusts a string.', impact: 'Access checks can fail.', fix_hint: 'Require a boolean.', status: 'open' }
  for (const field of ['title', 'impact', 'why_exploitable', 'fix_hint']) {
    for (const text of ['print("AUDIT_SENTINEL")', 'Payload: AUDIT_SENTINEL', '1) Set a marker. 2) Read the marker.', 'First open the sample, then send the marker.', 'First create a marker. Next read the marker.', 'echo INERT_MARKER', 'SELECT 1']) {
      assert.throws(() => redFindings(JSON.stringify([{ ...finding, [field]: text }])), /invalid/)
    }
  }
  const repo = fixture()
  const calls = path.join(tmp('audit-red-'), 'calls')
  const r = audit(repo, [], { COUNCIL_FAKE_RECORD: calls, COUNCIL_FAKE_RED_PROSE: 'Payload: AUDIT_SENTINEL' })
  assertOK(r)
  assert.equal(state(repo).outcome.stopReason, 'team-incomplete')
  assert.ok(!fs.readFileSync(calls, 'utf8').includes('AUDIT_SENTINEL'))
  assert.ok(walk(dirOf(repo)).filter(p => !p.startsWith('worktree/')).every(p => !fs.readFileSync(path.join(dirOf(repo), p), 'utf8').includes('AUDIT_SENTINEL')))
})

test('untriaged open findings carry forward when refreshed Red omits them', async () => {
  const { unresolved, patchable } = await import('../src/audit/findings.mjs')
  assert.equal(unresolved({ status: 'open' }), true)
  assert.equal(patchable({ status: 'open' }), false)
  const repo = fixture()
  assert.equal(audit(repo, ['--rounds', '0'], { COUNCIL_FAKE_BADJSON: 'codex:audit-review' }).status, 2)
  assert.equal(state(repo).auditLoop.ledger[0].status, 'open')
  assertOK(audit(repo, ['--refresh-context'], { COUNCIL_FAKE_REVIEW: 'clean' }, true))
  assert.equal(state(repo).auditLoop.ledger[0].status, 'confirmed')
  assert.equal(state(repo).outcome.unresolved, 1)
  assert.match(fs.readFileSync(path.join(dirOf(repo), 'summary.md'), 'utf8'), /Unresolved: 1/)
})

test('a patcher cannot declare a production file outside the target to be a regression', () => {
  const repo = fixture()
  const r = audit(repo, ['--target', 'guard.mjs'], { COUNCIL_FAKE_MISLABEL_TEST: '1', COUNCIL_FAKE_GATE: 'approve' })
  assertOK(r)
  assert.equal(state(repo).outcome.stopReason, 'team-incomplete')
  assert.match(state(repo).auditLoop.iterations.at(-1).teamFailures.blue, /outside the authorized regression scope/)
  assert.equal(git(path.join(dirOf(repo), 'worktree'), 'status', '--porcelain'), '')
  assert.equal(fs.existsSync(path.join(dirOf(repo), 'publish.json')), false)
})

test('path listings include both sides of a rename and fail closed on truncation', async () => {
  const repo = fixture(), base = git(repo, 'rev-parse', 'HEAD')
  git(repo, 'mv', 'check.mjs', 'helper.mjs')
  const tree = git(repo, 'write-tree')
  const store = { state: { target: { kind: 'path', path: 'helper.mjs' }, worktree: { baseCommit: base } }, repoRoot: repo, env: {} }
  const changes = await changesBetween(store, base, tree)
  assert.deepEqual(changes.sort(), ['check.mjs', 'helper.mjs'])
  await assert.rejects(auditScope(store).validate(changes, tree, []), /outside the target/)
  assert.throws(() => changedPaths({ stdout: 'helper.mjs\0', stdoutTruncated: true }), /incomplete/)
  assert.throws(() => changedPaths({ stdout: 'partial' }), /incomplete/)
})

test('resume refuses out-of-scope edits before refresh, testing or approval', () => {
  const repo = fixture(), dir = dirOf(repo)
  assertOK(audit(repo, ['--target', 'guard.mjs']))
  const wt = path.join(dir, 'worktree')
  fs.writeFileSync(path.join(wt, 'unexpected.txt'), 'owner edit')
  const gate = fs.readFileSync(path.join(dir, 'gate.json'))
  for (const args of [[], ['--refresh-context']]) {
    const r = audit(repo, args, { COUNCIL_FAKE_GATE: 'approve' }, true)
    assert.equal(r.status, 2)
    assert.match(r.stderr, /outside the target/)
    assert.deepEqual(fs.readFileSync(path.join(dir, 'gate.json')), gate)
    assert.equal(state(repo).context.version, 2)
    assert.equal(fs.readFileSync(path.join(wt, 'unexpected.txt'), 'utf8'), 'owner edit')
    assert.equal(git(repo, 'rev-parse', 'council/audit-test'), git(repo, 'rev-parse', 'HEAD'))
  }
})

test('explicit regression scope is pinned and cannot authorize out-of-scope production or deleted tests', async () => {
  const repo = fixture(), base = git(repo, 'rev-parse', 'HEAD')
  const target = { kind: 'path', path: 'guard.mjs' }, testTarget = { kind: 'path', path: 'check.mjs' }
  const store = { state: { target, testTarget, worktree: { baseCommit: base } }, repoRoot: repo }
  assert.deepEqual(validateTestTarget(repo, 'new.test.mjs'), { kind: 'path', path: 'new.test.mjs', directory: false })
  assert.throws(() => validateTestTarget(repo, '../outside/new.test.mjs'))
  const policy = auditScope(store)
  const fix = { file: 'guard.mjs', test: 'check.mjs' }
  await policy.validate(['guard.mjs', 'check.mjs'], base, [fix])
  await assert.rejects(policy.validate([], base, [{ ...fix, file: 'README.md' }]), /production file/)
  git(repo, 'rm', 'check.mjs')
  await assert.rejects(policy.validate(['check.mjs'], git(repo, 'write-tree'), [fix]), /remain regular/)
  assertOK(audit(repo, ['--target', 'guard.mjs', '--test-target', 'README.md', '--rounds', '0']))
  assert.equal(audit(repo, ['--test-target', '.'], {}, true).status, 1)
})

test('refresh supplies the base-to-candidate patch and focused regression to the Codex judge', () => {
  const repo = fixture(), dir = dirOf(repo)
  assertOK(audit(repo, ['--target', 'guard.mjs']))
  const record = path.join(tmp('audit-refresh-'), 'calls')
  assertOK(audit(repo, ['--refresh-context'], { COUNCIL_FAKE_RECORD: record }, true))
  const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse)
  for (const c of calls.filter(c => ['audit-red', 'audit-review'].includes(c.role))) {
    assert.match(c.stdin, /diff --git a\/guard\.mjs/)
    assert.match(c.stdin, /diff --git a\/guard\.test\.mjs/)
    if (c.role === 'audit-review') assert.match(c.stdin, /"args":\["--test","\.\/guard\.test\.mjs"\]/)
  }
  const receipt = readJson(path.join(dir, 'tests/regression-1/result.json'))
  assert.equal(receipt.tree, state(repo).candidate.tree)
  assert.deepEqual(receipt.focus.ids, ['F1'])
  assert.equal(receipt.focus.file, 'guard.test.mjs')
})

test('a suggested no-op cannot certify a failing regression', () => {
  const repo = fixture()
  assertOK(audit(repo, ['--test-cmd', 'true'], { COUNCIL_FAKE_FAIL_FOCUSED: '1', COUNCIL_FAKE_GATE: 'approve' }))
  assert.equal(readJson(path.join(dirOf(repo), 'tests/result.json')).passed, true)
  assert.equal(readJson(path.join(dirOf(repo), 'tests/regression-1/result.json')).status, 'failed')
  assert.equal(state(repo).outcome.status, 'tests-incomplete')
  assert.equal(state(repo).auditLoop.ledger[0].status, 'confirmed')
})

test('ordinary npm test resolves installed bins and packages from an isolated copy', () => {
  const repo = fixture()
  const modules = path.join(repo, 'node_modules'), dep = path.join(modules, 'local-runner')
  fs.mkdirSync(dep, { recursive: true })
  fs.mkdirSync(path.join(modules, '.bin'))
  fs.symlinkSync('../local-runner/runner.cjs', path.join(modules, '.bin/local-test'))
  fs.writeFileSync(path.join(dep, 'runner.cjs'), "#!/usr/bin/env node\nrequire('node:fs').writeFileSync(require('node:path').join(__dirname, 'ran'), 'ok')\n", { mode: 0o755 })
  fs.writeFileSync(path.join(dep, 'index.js'), 'module.exports = 42')
  fs.writeFileSync(path.join(repo, 'installed.test.mjs'), "import assert from 'node:assert/strict'\nimport n from 'local-runner/index.js'\nassert.equal(n, 42)\n")
  fs.writeFileSync(path.join(repo, '.gitignore'), 'node_modules/\n')
  fs.writeFileSync(path.join(repo, 'package.json'), JSON.stringify({ scripts: { test: 'local-test && node --test' } }))
  git(repo, 'add', '.')
  git(repo, 'commit', '-qm', 'suite uses installed packages')
  assertOK(audit(repo))
  const result = readJson(path.join(dirOf(repo), 'tests/result.json'))
  assert.equal(result.cmd, 'npm test')
  assert.equal(result.passed, true)
  assert.deepEqual(result.installedModules, ['node_modules'])
  assert.equal(fs.existsSync(path.join(dep, 'ran')), false)
  assert.equal(fs.existsSync(path.join(dirOf(repo), 'worktree/node_modules')), false)
})

test('resume rejects legacy prohibited Red prose before forwarding the saved ledger', () => {
  const repo = fixture(), record = path.join(tmp('audit-legacy-'), 'calls')
  assertOK(audit(repo, ['--rounds', '0']))
  const previous = state(repo)
  previous.auditLoop.ledger[0].title = 'Payload: INERT_LEGACY_MARKER'
  fs.writeFileSync(path.join(dirOf(repo), 'run.json'), JSON.stringify(previous))
  const r = audit(repo, ['--refresh-context'], { COUNCIL_FAKE_RECORD: record }, true)
  assert.equal(r.status, 2)
  assert.equal(fs.existsSync(record), false)
  assert.ok(!fs.readFileSync(path.join(dirOf(repo), 'findings.md'), 'utf8').includes('INERT_LEGACY_MARKER'))
})

test('a prohibited historical Red report is omitted from new builder input', () => {
  const repo = fixture(), previous = path.join(repo, '.council-flow', 'prior-unsafe')
  fs.mkdirSync(previous, { recursive: true })
  fs.writeFileSync(path.join(previous, 'findings.md'), '## F1 · high · open · Guard issue\n\nImpact: Payload: INERT_ARCHIVED_TEXT\n')
  const record = path.join(tmp('audit-archive-'), 'calls')
  assertOK(audit(repo, ['--rounds', '0'], { COUNCIL_FAKE_RECORD: record }))
  assert.ok(!fs.readFileSync(record, 'utf8').includes('INERT_ARCHIVED_TEXT'))
})

test('even a tree-matching approval cannot publish an out-of-scope candidate', async () => {
  const repo = fixture()
  assertOK(audit(repo, ['--target', 'guard.mjs', '--rounds', '0']))
  const store = RunStore.open(repo, 'audit-test')
  try {
    const wt = store.state.worktree.path
    fs.writeFileSync(path.join(wt, 'external.txt'), 'fixture')
    git(wt, 'add', 'external.txt')
    store.state.candidate.tree = git(wt, 'write-tree')
    const approval = { decision: 'approve', answer: 'approve', binding: expectedBinding(store) }
    await assert.rejects(publish({ store, cfg: { audit: true }, approval, title: 'outside scope' }), /outside the target/)
    assert.equal(git(repo, 'rev-parse', 'council/audit-test'), store.state.worktree.baseCommit)
  } finally { store.unlock() }
})

test('report-only audit of a linked checkout leaves the external Git directory exclude unchanged', () => {
  const repo = fixture(), linked = path.join(tmp('audit-linked-'), 'checkout')
  git(repo, 'worktree', 'add', '-b', 'linked-audit-fixture', linked)
  const exclude = path.join(repo, '.git/info/exclude')
  const before = fs.readFileSync(exclude)
  assertOK(audit(linked, ['--rounds', '0']))
  assert.deepEqual(fs.readFileSync(exclude), before)
  assert.equal(git(linked, 'status', '--porcelain'), '')
})

test('two stagnant iterations escalate with no patches and a carried confirmed finding', () => {
  const repo = fixture()
  assertOK(audit(repo, ['--rounds', '5'], { COUNCIL_FAKE_FIX: 'noop' }))
  const run = state(repo)
  assert.equal(run.auditLoop.round, 3)
  assert.equal(run.auditLoop.patches, 0)
  assert.equal(run.outcome.stopReason, 'no-progress')
  assert.match(fs.readFileSync(path.join(dirOf(repo), 'summary.md'), 'utf8'), /escalated after two unchanged iterations/)
})

test('a proactive Blue patch survives Red failure and resume skips completed steps', () => {
  const repo = fixture(), record = path.join(tmp('audit-parallel-'), 'calls')
  const env = { COUNCIL_FAKE_PROACTIVE: '1', COUNCIL_FAKE_REVIEW: 'clean', COUNCIL_FAKE_RECORD: record }
  assert.equal(audit(repo, [], { ...env, COUNCIL_FAKE_BADJSON: 'fx:audit-red,codex:audit-review' }).status, 2)
  assert.ok(state(repo).auditLoop.iterations[0].blueDone)
  assert.ok(!state(repo).auditLoop.iterations[0].redDone)
  assert.ok(state(repo).auditLoop.iterations[0].teamsComplete)
  const pack = fs.readFileSync(path.join(dirOf(repo), 'context/v1/pack.json'))
  assertOK(audit(repo, [], env, true))
  const run = state(repo)
  assert.equal(run.outcome.stopReason, 'clean')
  assert.equal(run.auditLoop.round, 2)
  assert.equal(run.auditLoop.ledger[0].id, 'B-guard')
  assert.equal(run.auditLoop.ledger[0].status, 'fixed')
  assert.deepEqual(fs.readFileSync(path.join(dirOf(repo), 'context/v1/pack.json')), pack)
  const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse)
  for (const [role, count] of [['audit-context', 2], ['audit-red', 2], ['audit-patch', 2], ['audit-review', 3], ['nudge', 2]]) {
    assert.equal(calls.filter(c => c.role === role).length, count, role)
  }
})

test('Codex concerns block a clean verdict and an approved commit; needs-info stays open', () => {
  const repo = fixture()
  assertOK(audit(repo, ['--rounds', '2'], { COUNCIL_FAKE_AUDIT_CONCERN: '1', COUNCIL_FAKE_GATE: 'approve' }))
  assert.equal(state(repo).outcome.status, 'review-incomplete')
  assert.equal(state(repo).outcome.stopReason, 'max-rounds')
  assert.equal(fs.existsSync(path.join(dirOf(repo), 'publish.json')), false)
  const pending = fixture()
  assertOK(audit(pending, ['--rounds', '1'], { COUNCIL_FAKE_AUDIT_DECISION: 'needs-info' }))
  assert.equal(state(pending).auditLoop.ledger[0].status, 'open')
  assert.equal(state(pending).outcome.unresolved, 1)
})

test('Blue corrects a rejected regression and Codex re-verifies the revised candidate', () => {
  const repo = fixture(), dir = dirOf(repo)
  assertOK(audit(repo, [], { COUNCIL_FAKE_REPAIR: '1' }))
  const run = state(repo)
  assert.equal(run.outcome.stopReason, 'clean')
  assert.deepEqual(run.auditLoop.history.map(h => h.status), ['open', 'confirmed', 'reopened', 'fixed'])
  const review = n => readJson(path.join(dir, `iterations/${n}/review/result.json`))
  assert.equal(review(2).verdict.patches[0].decision, 'rejected')
  assert.equal(review(3).verdict.patches[0].decision, 'verified')
  assert.notEqual(review(2).tree, review(3).tree)
  assert.equal(review(3).tree, readJson(path.join(dir, 'tests/regression-1/result.json')).tree)
  assert.match(fs.readFileSync(path.join(dir, 'patches/3.diff'), 'utf8'), /allowed\(null\)/)
})

test('re-context can describe a target removed from the candidate that existed in the base', async () => {
  const repo = fixture(), baseCommit = git(repo, 'rev-parse', 'HEAD')
  const target = { kind: 'path', path: 'guard.mjs', directory: false }
  const store = { base: tmp('audit-prior-'), state: { target, worktree: { baseCommit } } }
  git(repo, 'rm', target.path)
  const tree = git(repo, 'write-tree')
  const ctx = { repoRoot: repo, store, env: {} }
  const pack = await collect(ctx, tree)
  assert.equal(pack.targetRemoved, true)
  assert.ok(!pack.tree.includes(target.path))
  target.path = 'never-tracked.mjs'
  await assert.rejects(collect(ctx, tree), /no tracked regular files/)
})

test('fenced Blue stream result keeps scrubbed diagnostics and parses the last block without a nudge', () => {
  const repo = fixture(), logs = path.join(dirOf(repo), 'logs')
  assertOK(audit(repo, [], { COUNCIL_FAKE_BLUE_FORMAT: 'wrapped' }))
  assert.equal(state(repo).outcome.stopReason, 'clean')
  const final = fs.readFileSync(path.join(logs, 'iteration-2-blue.final.txt'), 'utf8')
  assert.match(final, /```json/)
  assert.match(final, /"test":"guard.test.mjs"/)
  const events = fs.readFileSync(path.join(logs, 'iteration-2-blue.stdout.txt'), 'utf8').trim().split('\n').map(JSON.parse)
  assert.equal(events.at(-1).result, final)
  assert.ok(!fs.readdirSync(logs).some(f => f.includes('nudge')))
})

test('partially invalid Blue findings get one field-specific, tool-free repair per iteration', () => {
  const repo = fixture(), dir = dirOf(repo), record = path.join(tmp('audit-repair-'), 'calls')
  assertOK(audit(repo, ['--rounds', '1'], { COUNCIL_FAKE_BLUE_FORMAT: 'partial-repair', COUNCIL_FAKE_RECORD: record }))
  const calls = fs.readFileSync(record, 'utf8').trim().split('\n').map(JSON.parse)
  const nudges = calls.filter(c => c.role === 'nudge')
  assert.equal(nudges.length, 1)
  const [nudge] = nudges
  assert.equal(nudge.member, 'claude')
  assert.equal(nudge.args[nudge.args.indexOf('--tools') + 1], '')
  assert.notEqual(nudge.cwd, state(repo).worktree.path)
  assert.match(nudge.stdin, /findings\[1\]\.line: expected a positive integer/)
  assert.deepEqual(readJson(path.join(dir, 'iterations/1/blue/result.json')).findings.map(f => f.id), ['B-first', 'B-second'])
  assert.ok(fs.existsSync(path.join(dir, 'logs/iteration-1-blue-nudge.final.txt')))
})

test('a failed JSON repair preserves Red evidence, exposes the failing field and blocks a clean gate', () => {
  const repo = fixture(), dir = dirOf(repo)
  assertOK(audit(repo, ['--rounds', '2'], { COUNCIL_FAKE_BLUE_FORMAT: 'partial', COUNCIL_FAKE_GATE: 'approve' }))
  const run = state(repo)
  assert.equal(run.outcome.stopReason, 'team-incomplete')
  assert.equal(run.auditLoop.ledger[0].status, 'confirmed')
  for (const n of [1, 2]) {
    assert.match(readJson(path.join(dir, `iterations/${n}/blue/failure.json`)).error, /claude audit-patch: invalid findings\[1\]\.line: expected a positive integer after one JSON retry/)
    assert.ok(fs.existsSync(path.join(dir, `iterations/${n}/red/result.json`)))
    assert.ok(fs.existsSync(path.join(dir, `logs/iteration-${n}-blue-nudge.validation.json`)))
  }
  assert.match(fs.readFileSync(path.join(dir, 'summary.md'), 'utf8'), /team-incomplete/)
  assert.equal(fs.existsSync(path.join(dir, 'publish.json')), false)
  assert.equal(git(run.worktree.path, 'status', '--porcelain'), '')
})

test('malformed outer JSON cannot turn a nested empty array into a clean audit', () => {
  for (const text of ['{"fixes":[]', '{"findings":[{}],"fixes":[],}', '[] then {"more":[]']) {
    assert.equal(lastJsonBlock(text), undefined)
  }
  assert.deepEqual(lastJsonBlock('Draft {}. Final ```json\n{"findings":[]}\n```'), { findings: [] })
  assert.deepEqual(lastJsonBlock('Incomplete draft {\nFinal:\n```json\n{"fixes":[]}\n```\n[done]'), { fixes: [] })
})

test('a partial review with a passing proactive patch cannot publish', () => {
  const repo = fixture()
  assertOK(audit(repo, ['--rounds', '1'], { COUNCIL_FAKE_BADJSON: 'fx:audit-red', COUNCIL_FAKE_PROACTIVE: '1', COUNCIL_FAKE_GATE: 'approve' }))
  assert.equal(state(repo).outcome.testsPassed, true)
  assert.equal(state(repo).outcome.status, 'review-incomplete')
  assert.equal(state(repo).outcome.stopReason, 'team-incomplete')
  assert.equal(fs.existsSync(path.join(dirOf(repo), 'publish.json')), false)
})

test('resuming the original Red-only checkpoint preserves argv and retries only Claude', () => {
  const repo = fixture(), dir = dirOf(repo)
  assert.equal(audit(repo, ['--rounds', '0'], { COUNCIL_FAKE_BADJSON: 'codex:audit-review' }).status, 2)
  const run = state(repo), it = run.auditLoop.iterations[0]
  for (const key of ['blueDone', 'teamsComplete', 'teamFailures', 'tree']) delete it[key]
  fs.writeFileSync(path.join(dir, 'run.json'), JSON.stringify(run))
  const argvFile = path.join(dir, 'logs/iteration-1-blue.argv.json')
  const original = fs.readFileSync(argvFile)
  const record = path.join(tmp('audit-old-checkpoint-'), 'calls')
  assertOK(audit(repo, [], { COUNCIL_FAKE_RECORD: record }, true))
  const roles = fs.readFileSync(record, 'utf8').trim().split('\n').map(s => JSON.parse(s).role)
  assert.deepEqual(roles, ['audit-blue-read', 'audit-review'])
  assert.deepEqual(fs.readFileSync(argvFile), original)
  assert.ok(fs.existsSync(path.join(dir, 'logs/iteration-1-blue-attempt-2.final.txt')))
})

test('audit stdout drops file-tool bodies and scrubs credentials inside stream events and final text', async () => {
  const output = {}, secret = 'local-diagnostic-sentinel-12345'
  const store = { member: () => ({ status: 'ok' }), save() {}, addUsage() {}, writeJson() {},
    writeAuditStream(name, events) { output['logs/' + name + '.stdout.txt'] = events.map(JSON.stringify).join('\n') },
    write(name, text) { output[name] = text } }
  const result = 'Trailing prose. API_KEY="literal fixture 1234" ' + secret
  const stdout = [{ type: 'assistant', message: { content: [{ type: 'tool_use', input: { content: 'PRIVATE_TOOL_CONTENT' } }] } },
    { type: 'user', tool_use_result: { file: { content: 'PRIVATE_TOOL_CONTENT' } } },
    { type: 'result', result }].map(v => JSON.stringify(v)).join('\n')
  const engine = { run() { return { ok: true, text: result, stdout, durationMs: 1, argv: [] } } }
  await auditCall({ store, env: { LYBER_API_KEY: secret }, engines: { claude: engine }, cfg: { members: ['claude'] }, log() {} },
    'claude', 'audit-patch', 'Review', 'blue', '/tmp')
  assert.match(output['logs/blue.final.txt'], /Trailing prose/)
  assert.match(output['logs/blue.stdout.txt'], /REDACTED/)
  assert.doesNotMatch(JSON.stringify(output), /PRIVATE_TOOL_CONTENT|literal fixture|local-diagnostic-sentinel/)
})

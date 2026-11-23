// Secrets: only fx gets the Lyber key, nothing secret reaches argv, stdin, logs or artifacts (checked end to end with
// stub binaries in a real, non-dry-run CLI run). Publishing: only an approval bound to the exact tree publishes, only
// that tree is committed, no tags, no force, checkpointed resume (checked against a real local bare remote).
import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { runPipeline } from '../src/pipeline.mjs'
import { publish as realPublish } from '../src/publish.mjs'
import { decide } from '../src/gate.mjs'
import { scrubSecrets } from '../src/redact.mjs'
import { FAKE_ENGINE } from '../src/engines.mjs'
import { which } from '../src/proc.mjs'
import { PassThrough } from 'node:stream'
import { loadConfig } from '../src/config.mjs'
import { RunStore } from '../src/artifacts.mjs'
import { createEngine } from '../src/engines.mjs'
import { toyRepo, testEnv, quiet, runDir, readJson, walk, git, cli, FAKE_KEY, tmp } from './helpers.mjs'

const GH = 'gh-SENTINEL-TOKEN-111', ANT = 'ant-SENTINEL-KEY-222', OAI = 'oai-SENTINEL-KEY-333'
const SENTINELS = [FAKE_KEY, GH, ANT, OAI]

test('scrubSecrets: env secret values, bearer headers, KEY=value, JSON keys, token shapes', () => {
  const env = { LYBER_API_KEY: FAKE_KEY, GH_TOKEN: 'ghtokenvalue123456', PATH: '/usr/bin:/bin' }
  const s = scrubSecrets([
    `key is ${FAKE_KEY}`, 'Authorization: Bearer abcdefghijklmnop1234', 'OPENAI_API_KEY=sk-live-should-go', 'export MY_SECRET="hunter2hunter2"',
    '{"api_key": "abcdef123456", "input_tokens": 12}', 'token ghp_abcdefghijklmnopqrstuvwxyz0123', 'gh says ghtokenvalue123456', 'PATH=/usr/bin:/bin'
  ].join('\n'), { env })
  for (const bad of [FAKE_KEY, 'abcdefghijklmnop1234', 'sk-live-should-go', 'hunter2hunter2', 'abcdef123456', 'ghp_abcdefghijklmnopqrstuvwxyz0123', 'ghtokenvalue123456']) assert.ok(!s.includes(bad), `${bad} survived:\n${s}`)
  assert.match(s, /"input_tokens": 12/)
  assert.match(s, /PATH=\/usr\/bin:\/bin/, 'non-secret env values stay')
})

test('scrubSecrets code mode keeps ordinary code but still removes real secret values', () => {
  const code = '+API_KEY = os.environ["API_KEY"]\n+const token = process.env.GH_TOKEN\n'
  assert.equal(scrubSecrets(code, { env: {}, mode: 'code' }), code)
  assert.ok(!scrubSecrets(`+key = "${FAKE_KEY}"`, { env: { LYBER_API_KEY: FAKE_KEY }, mode: 'code' }).includes(FAKE_KEY))
})

test('scrubSecrets: lowercase/mixed-case bearer and basic credentials are removed in log AND code mode', () => {
  for (const mode of ['log', 'code']) {
    for (const t of ['Authorization: bearer abc123def456ghi789', 'authorization: BeArEr xyz987abc654qq', 'curl -H "Authorization: Basic dXNlcjpwYXNz1234"', 'Authorization: tok3nwithoutscheme99']) {
      const s = scrubSecrets(t, { env: {}, mode })
      assert.doesNotMatch(s, /abc123def456ghi789|xyz987abc654qq|dXNlcjpwYXNz1234|tok3nwithoutscheme99/, `${mode}: ${s}`)
    }
  }
  for (const mode of ['log', 'code']) {
    for (const t of ['Authorization: Basic dXNlcjpwYXNz', 'authorization: bearer abcdefghijklmnopq']) {
      assert.doesNotMatch(scrubSecrets(t, { env: {}, mode }), /dXNlcjpwYXNz|abcdefghijklmnopq/, `${mode}: digit-free ${t}`)
    }
  }
  assert.equal(scrubSecrets('use Basic authentication', { env: {} }), 'use Basic authentication')
  assert.equal(scrubSecrets('h = { Authorization: `Bearer ${token}` }', { env: {}, mode: 'code' }), 'h = { Authorization: `Bearer ${token}` }')
})

// Stub binaries on PATH: claude/codex/fx are the fake engine (real argv, records env/stdin), gh records its env,
// git records its env and then runs the real git.
function stubBin() {
  const dir = tmp('council-stubs-')
  const rec = path.join(dir, 'calls.jsonl'), gitLog = path.join(dir, 'git-env.log'), ghLog = path.join(dir, 'gh.log')
  for (const m of ['claude', 'codex', 'fx']) fs.writeFileSync(path.join(dir, m), `#!/bin/sh\nexec "${process.execPath}" "${FAKE_ENGINE}" ${m} -- "$@"\n`, { mode: 0o755 })
  const realGit = which('git')
  fs.writeFileSync(path.join(dir, 'git'), `#!/bin/sh\nenv | grep -E '^(LYBER_API_KEY|GH_TOKEN|ANTHROPIC_API_KEY|OPENAI_API_KEY|GIT_INDEX_FILE|GIT_DIR)=' >> '${gitLog}'\nexec ${realGit} "$@"\n`, { mode: 0o755 })
  fs.writeFileSync(path.join(dir, 'gh'), `#!/bin/sh\nenv | grep -E '^(LYBER_API_KEY|ANTHROPIC_API_KEY|OPENAI_API_KEY)=' >> '${ghLog}'\necho "ARGS $*" >> '${ghLog}'\necho https://github.com/example/toy/pull/9\n`, { mode: 0o755 })
  return { dir, rec, gitLog, ghLog }
}

test('real (non-dry-run) CLI run with stub binaries: each child gets only its own secret; no secret in any argv, stdin, artifact or output', () => {
  const toy = toyRepo()
  const envRec = path.join(tmp('council-testenv-'), 'test-env.json')
  fs.writeFileSync(path.join(toy.dir, 'check.mjs'), `import fs from 'node:fs'\nfs.writeFileSync(process.env.COUNCIL_TEST_ENV_RECORD, JSON.stringify(Object.keys(process.env).filter(k => /KEY|TOKEN|SECRET|^GIT_(DIR|INDEX_FILE|WORK_TREE|CONFIG)|^ORCA_PAIRING|^GH_REPO$/.test(k))))\nif (!fs.readFileSync('hello.txt', 'utf8').startsWith('hello council')) process.exit(1)\n`)
  git(toy.dir, 'commit', '-q', '-am', 'record env in tests')
  const s = stubBin()
  const bogusIndex = path.join(tmp('council-idx-'), 'index')
  const env = testEnv({ PATH: `${s.dir}:${process.env.PATH}`, LYBER_API_KEY: FAKE_KEY, GH_TOKEN: GH, ANTHROPIC_API_KEY: ANT, OPENAI_API_KEY: OAI,
    GIT_INDEX_FILE: bogusIndex, COUNCIL_FAKE_RECORD: s.rec, COUNCIL_ORCA: 'off', COUNCIL_CODEX_MODEL: 'fake-model', COUNCIL_TEST_ENV_RECORD: envRec,
    GIT_CONFIG_COUNT: '1', GIT_CONFIG_KEY_0: 'http.extraHeader', GIT_CONFIG_VALUE_0: 'Authorization: Basic c2VjcmV0aGVhZGVy', ORCA_PAIRING_CODE: 'orca://pair?code=SENTINEL', GH_REPO: 'someone/else' })
  const r = cli(['Add a hello.txt greeting file', '--repo', toy.dir, '--run-id', 'stub-1'], env)
  assert.equal(r.status, 0, r.stderr)
  assert.match(r.stdout, /^declined\tstub-1\t/m, 'no TTY and no Orca: the gate denies')
  for (const x of SENTINELS) assert.ok(!r.stdout.includes(x) && !r.stderr.includes(x), `console leaked ${x}`)

  const calls = fs.readFileSync(s.rec, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  const roles = new Set(calls.map(c => `${c.member}:${c.role}`))
  for (const want of ['claude:probe:auth', 'codex:probe:login', 'codex:probe:sandbox', 'fx:probe:status', 'claude:plan', 'codex:plan', 'fx:plan', 'claude:judge', 'codex:implement', 'claude:review', 'fx:review', 'codex:fix']) assert.ok(roles.has(want), `missing call ${want}`)
  for (const c of calls) {
    for (const x of SENTINELS) {
      assert.ok(!c.args.join(' ').includes(x), `${c.member}:${c.role} argv contains a secret`)
      assert.ok(!String(c.stdin).includes(x), `${c.member}:${c.role} stdin contains a secret`)
    }
    assert.equal(c.env.LYBER_API_KEY, c.member === 'fx' ? FAKE_KEY : undefined, `${c.member}:${c.role} LYBER_API_KEY`)
    assert.equal(c.env.ANTHROPIC_API_KEY, c.member === 'claude' ? ANT : undefined, `${c.member}:${c.role} ANTHROPIC_API_KEY`)
    assert.equal(c.env.OPENAI_API_KEY, c.member === 'codex' ? OAI : undefined, `${c.member}:${c.role} OPENAI_API_KEY`)
    assert.equal(c.env.GH_TOKEN, undefined, `${c.member}:${c.role} GH_TOKEN`)
    assert.deepEqual(Object.keys(c.env).filter(k => /^GIT_CONFIG|^ORCA_PAIRING_CODE$|^GH_REPO$|^COUNCIL_TEST_CMD$/.test(k)), [], `${c.member}:${c.role} got git config / Orca pairing / GH_REPO / test command`)
  }
  // The fake fx put the key into its plan and stderr; the judge's stdin (above) and every artifact are clean.
  const gitEnv = fs.existsSync(s.gitLog) ? fs.readFileSync(s.gitLog, 'utf8') : ''
  assert.equal(gitEnv, '', `git got secrets or repo overrides:\n${gitEnv}`)
  assert.ok(!fs.existsSync(bogusIndex), 'an inherited GIT_INDEX_FILE was never used')
  assert.ok(!fs.existsSync(s.ghLog), 'gh never ran (the gate denied)')
  assert.deepEqual(JSON.parse(fs.readFileSync(envRec, 'utf8')), [], 'the repo test command got no secrets and no GIT_* overrides')
  const dir = runDir(toy.dir, 'stub-1')
  for (const f of walk(dir)) for (const x of SENTINELS) assert.ok(!fs.readFileSync(path.join(dir, f), 'utf8').includes(x), `${x} in ${f}`)
  assert.match(fs.readFileSync(path.join(dir, 'plans/fx.md'), 'utf8'), /LYBER_API_KEY=\[REDACTED\]/)
})

test('doctor with stub binaries: real probes, a broken codex sandbox is reported without a model call, nothing secret printed', () => {
  const s = stubBin()
  const env = testEnv({ PATH: `${s.dir}:${process.env.PATH}`, LYBER_API_KEY: FAKE_KEY, COUNCIL_FAKE_RECORD: s.rec, COUNCIL_ORCA: 'off', COUNCIL_FAKE_CODEX_SANDBOX: 'broken', COUNCIL_TEST_CMD: `echo ${FAKE_KEY}` })
  const toy = toyRepo()
  const r = cli(['doctor', '--repo', toy.dir], env)
  assert.match(r.stdout, /^FAIL  sandbox .*bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted.*cannot implement/m)
  assert.match(r.stdout, /^OK    codex /m)
  assert.match(r.stdout, /^READY:/m, 'claude can still implement')
  assert.ok(!r.stdout.includes(FAKE_KEY), 'the test command with a secret is printed scrubbed')
  const calls = fs.readFileSync(s.rec, 'utf8').trim().split('\n').map(l => JSON.parse(l))
  assert.ok(calls.every(c => c.role.startsWith('probe:')), 'doctor only probes: no plan/review/implement call')
})

test('CLI errors are scrubbed too', () => {
  const toy = toyRepo()
  const r = cli(['x', '--repo', toy.dir, '--dry-run', '--implementer', FAKE_KEY], testEnv({ LYBER_API_KEY: FAKE_KEY }))
  assert.equal(r.status, 1)
  assert.match(r.stderr, /implementer must be one of/)
  assert.ok(!r.stderr.includes(FAKE_KEY))
})

// ---------------------------------------------------------------- publishing
function realPublishWith(ghLog, { failFlag = null } = {}) {
  const ghDir = tmp('council-gh-')
  const gh = path.join(ghDir, 'gh')
  fs.writeFileSync(gh, `#!/bin/sh\n${failFlag ? `if [ -f '${failFlag}' ]; then echo "gh: network down" >&2; exit 1; fi\n` : ''}printf '%s\\n' "$*" >> '${ghLog}'\nenv | grep '^GH_REPO=' >> '${ghLog}'\necho https://github.com/example/toy/pull/1\n`, { mode: 0o755 })
  const calls = []
  const fn = (o) => { calls.push(o.approval.decision); return realPublish({ ...o, cfg: { ...o.cfg, dryRun: false, bins: { ...o.cfg.bins, gh } } }) }
  return { fn, calls }
}
const remoteRefs = (bare) => git(bare, 'for-each-ref', '--format=%(refname)').split('\n').filter(Boolean).sort()
const opts = (extra) => ({ log: quiet, noSignals: true, ...extra })
const go = (toy, runId, env, deps, extra = {}) => runPipeline({ task: 'Add a hello.txt greeting file', repo: toy.dir, dryRun: true, runId, ...extra }, opts({ env: testEnv(env), ...deps }))

test('gate denies: publish is never called and the remote only has main', async () => {
  const toy = toyRepo({ remote: true })
  const ghLog = path.join(toy.bare, 'gh.log')
  const pub = realPublishWith(ghLog)
  const res = await go(toy, 'deny', { COUNCIL_FAKE_GATE: 'deny' }, { publish: pub.fn })
  assert.equal(res.exitCode, 0, res.error)
  assert.equal(res.outcome.status, 'declined')
  assert.deepEqual(pub.calls, [])
  assert.deepEqual(remoteRefs(toy.bare), ['refs/heads/main'])
  assert.ok(!fs.existsSync(ghLog))
  const wt = readJson(path.join(runDir(toy.dir, 'deny'), 'run.json')).worktree.path
  assert.equal(git(wt, 'rev-parse', 'HEAD'), toy.head, 'nothing was committed either')
})

test('gate approves: exactly the candidate tree is pushed to council/<run-id>, main untouched, PR opened against main', async () => {
  const toy = toyRepo({ remote: true })
  const ghLog = path.join(toy.bare, 'gh.log')
  const pub = realPublishWith(ghLog)
  const res = await go(toy, 'approve', { COUNCIL_FAKE_GATE: 'approve' }, { publish: pub.fn })
  assert.equal(res.exitCode, 0, res.error)
  assert.deepEqual([pub.calls, res.outcome.status, res.outcome.prUrl], [['approve'], 'pr-opened', 'https://github.com/example/toy/pull/1'])
  assert.deepEqual(remoteRefs(toy.bare), ['refs/heads/council/approve', 'refs/heads/main'])
  const run = readJson(path.join(runDir(toy.dir, 'approve'), 'run.json'))
  assert.equal(git(toy.bare, 'rev-parse', 'council/approve^{tree}'), run.candidate.tree)
  assert.equal(git(toy.bare, 'rev-parse', 'council/approve^'), toy.head, 'parent is the recorded base')
  assert.equal(git(toy.bare, 'rev-parse', 'main'), toy.head)
  assert.equal(git(toy.dir, 'rev-parse', 'main'), toy.head)
  assert.equal(git(toy.dir, 'rev-parse', 'council/approve'), git(toy.bare, 'rev-parse', 'council/approve'), 'the local council branch matches what was pushed')
  assert.match(fs.readFileSync(ghLog, 'utf8'), /^pr create --repo github\.com\/example\/toy --head council\/approve --title council-flow: Add a hello\.txt greeting file --body-file \S+summary\.md --base main$/m)
})

test('publish commits only the approved tree: edits made while the gate was open and test outputs are left out', async () => {
  const toy = toyRepo({ remote: true })
  const pub = realPublishWith(path.join(toy.bare, 'gh.log'))
  const lateGate = async (o) => {
    fs.writeFileSync(path.join(o.binding.worktree, 'late.txt'), 'written while the gate was open\n')
    return decide({ ...o, env: { COUNCIL_FAKE_GATE: 'approve' } })
  }
  const res = await go(toy, 'bound', { COUNCIL_FAKE_REVIEW: 'clean' }, { publish: pub.fn, gate: lateGate }, { testCmd: 'node check.mjs && echo junk > generated.txt' })
  assert.equal(res.outcome.status, 'pr-opened', res.error)
  const files = git(toy.bare, 'ls-tree', '-r', '--name-only', 'council/bound')
  assert.match(files, /hello\.txt/)
  assert.doesNotMatch(files, /late\.txt|generated\.txt/)
})

test('an approval bound to another tree publishes nothing', async () => {
  const toy = toyRepo({ remote: true })
  const pub = realPublishWith(path.join(toy.bare, 'gh.log'))
  const staleGate = async (o) => ({ ...(await decide({ ...o, env: { COUNCIL_FAKE_GATE: 'approve' } })), binding: { ...o.binding, tree: '0'.repeat(40) } })
  const res = await go(toy, 'stale', {}, { publish: pub.fn, gate: staleGate })
  assert.equal(res.outcome.status, 'failed')
  assert.match(readJson(path.join(runDir(toy.dir, 'stale'), 'publish.json')).error, /no approval for exactly this tree/)
  assert.deepEqual(remoteRefs(toy.bare), ['refs/heads/main'])
})

test('no force and no tags: a divergent remote council branch survives, and push.followTags=true publishes no tag', async () => {
  const toy = toyRepo({ remote: true })
  git(toy.dir, 'config', 'push.followTags', 'true')
  git(toy.dir, 'tag', '-a', 'v-unpublished', '-m', 'private tag', toy.head)
  // Someone else's commit already sits at council/force on the remote.
  const other = tmp('council-other-')
  git(other, 'clone', '-q', toy.bare, '.')
  git(other, 'config', 'user.email', 'o@example.invalid'); git(other, 'config', 'user.name', 'O')
  fs.writeFileSync(path.join(other, 'theirs.txt'), 'theirs\n')
  git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'theirs')
  git(other, 'push', '-q', 'origin', 'HEAD:refs/heads/council/force')
  const theirs = git(toy.bare, 'rev-parse', 'council/force')
  const res = await go(toy, 'force', { COUNCIL_FAKE_GATE: 'approve' }, { publish: realPublishWith(path.join(toy.bare, 'gh.log')).fn })
  assert.equal(res.outcome.status, 'push-failed')
  assert.equal(git(toy.bare, 'rev-parse', 'council/force'), theirs, 'the remote tip was not overwritten')
  assert.deepEqual(git(toy.bare, 'tag', '-l').split('\n').filter(Boolean), [], 'no tag was pushed')
  // Same repo, a fresh branch name: the push succeeds and still carries no tag.
  const ok = await go(toy, 'tags', { COUNCIL_FAKE_GATE: 'approve' }, { publish: realPublishWith(path.join(toy.bare, 'gh.log')).fn })
  assert.equal(ok.outcome.status, 'pr-opened')
  assert.deepEqual(git(toy.bare, 'tag', '-l').split('\n').filter(Boolean), [])
})

test('publish is checkpointed: a failed PR step is finished on resume without a second commit or push', async () => {
  const toy = toyRepo({ remote: true })
  const ghLog = path.join(toy.bare, 'gh.log'), failFlag = path.join(tmp('council-flag-'), 'fail')
  fs.writeFileSync(failFlag, '')
  const pub = realPublishWith(ghLog, { failFlag })
  const first = await go(toy, 'partial', { COUNCIL_FAKE_GATE: 'approve' }, { publish: pub.fn })
  assert.equal(first.outcome.status, 'pushed-pr-failed')
  const pushed = git(toy.bare, 'rev-parse', 'council/partial')
  fs.rmSync(failFlag)
  const second = await runPipeline({ resume: 'partial', repo: toy.dir, dryRun: true }, opts({ env: testEnv({ COUNCIL_FAKE_GATE: 'approve' }), publish: pub.fn }))
  assert.equal(second.outcome.status, 'pr-opened')
  assert.equal(git(toy.bare, 'rev-parse', 'council/partial'), pushed, 'same commit, not pushed again')
  const p = readJson(path.join(runDir(toy.dir, 'partial'), 'publish.json'))
  assert.equal(p.steps.filter(s => s.name === 'push').length, 1)
  assert.equal(p.steps.filter(s => s.name === 'commit').length, 1)
  // A third resume: this tree is already published, so the gate is not asked and the summary keeps the outcome.
  const before = fs.readFileSync(path.join(runDir(toy.dir, 'partial'), 'summary.md'), 'utf8')
  await runPipeline({ resume: 'partial', repo: toy.dir, dryRun: true }, opts({ env: testEnv({ COUNCIL_FAKE_GATE: 'approve' }), publish: pub.fn }))
  assert.deepEqual(pub.calls, ['approve', 'approve'])
  assert.equal(fs.readFileSync(path.join(runDir(toy.dir, 'partial'), 'summary.md'), 'utf8'), before)
})

test('escalated + approved: the PR is a draft', async () => {
  const toy = toyRepo({ remote: true })
  const ghLog = path.join(toy.bare, 'gh.log')
  const res = await go(toy, 'draft', { COUNCIL_FAKE_GATE: 'approve', COUNCIL_FAKE_REVIEW: 'always' }, { publish: realPublishWith(ghLog).fn }, { rounds: 0 })
  assert.equal(res.outcome.ready, false)
  assert.match(fs.readFileSync(ghLog, 'utf8'), /--draft/)
})

test('a run.json pointing the worktree at the primary checkout is refused before anything is staged', async () => {
  const toy = toyRepo()
  await go(toy, 'tamper', {}, {})
  const file = path.join(runDir(toy.dir, 'tamper'), 'run.json')
  const run = readJson(file)
  run.worktree.path = toy.dir
  run.loop.next = 'review'
  fs.writeFileSync(file, JSON.stringify(run))
  fs.writeFileSync(path.join(toy.dir, 'untracked.txt'), 'mine\n')
  const res = await runPipeline({ resume: 'tamper', repo: toy.dir, dryRun: true }, opts({ env: testEnv() }))
  assert.equal(res.exitCode, 2)
  assert.match(res.outcome.error, /worktree check failed: .*(primary checkout|is not this run's worktree)/)
  assert.equal(git(toy.dir, 'diff', '--cached', '--name-only'), '', 'nothing was staged in the primary checkout')
  assert.equal(git(toy.dir, 'rev-parse', 'HEAD'), toy.head)
})

test('digit-free credentials are scrubbed on the way to a model (stdin) and in patch artifacts', async () => {
  const rec = path.join(tmp('council-rec-'), 'rec.jsonl')
  const header = 'curl -H "Authorization: Basic dXNlcjpwYXNz" -H "Authorization: Bearer abcdefghijklmnopq"'
  const r = await createEngine('claude', loadConfig({ dryRun: true }, {}), { scratch: tmp('council-scr-'), env: { ...process.env, COUNCIL_FAKE_RECORD: rec } })
    .run({ role: 'plan', prompt: `You are planning a code change.\n${header}`, cwd: tmp('council-cwd-'), timeoutMs: 15000 })
  assert.equal(r.ok, true, r.error)
  assert.doesNotMatch(fs.readFileSync(rec, 'utf8'), /dXNlcjpwYXNz|abcdefghijklmnopq/)
  const store = RunStore.create(tmp('council-art-'), 'p1', {})
  store.write('implement/diff.patch', `+${header}\n`)
  assert.doesNotMatch(store.read('implement/diff.patch'), /dXNlcjpwYXNz|abcdefghijklmnopq/)
  store.unlock()
})

test('a test command containing a secret is refused, never spawned', async () => {
  const toy = toyRepo()
  const marker = path.join(tmp('council-marker-'), 'ran')
  const res = await go(toy, 'secretcmd', { LYBER_API_KEY: FAKE_KEY, COUNCIL_FAKE_REVIEW: 'clean' }, {}, { testCmd: `echo ${FAKE_KEY} > '${marker}'` })
  assert.equal(res.exitCode, 0, res.error)
  assert.ok(!fs.existsSync(marker))
  assert.equal(readJson(path.join(runDir(toy.dir, 'secretcmd'), 'tests/result.json')).status, 'refused')
  assert.ok(res.outcome.reasons.some(r => /tests refused/.test(r)))
  for (const f of walk(runDir(toy.dir, 'secretcmd'))) assert.ok(!fs.readFileSync(path.join(runDir(toy.dir, 'secretcmd'), f), 'utf8').includes(FAKE_KEY), f)
})

test('the TTY gate prints its question scrubbed', async () => {
  const input = new PassThrough(), output = new PassThrough()
  input.isTTY = true
  let printed = ''
  output.on('data', (c) => { printed += c })
  const p = decide({ cfg: loadConfig({}, {}), env: { LYBER_API_KEY: FAKE_KEY }, orcaUsable: false, question: `Open findings: [blocker] config.js leaks ${FAKE_KEY}. Open PR?`, input, output })
  setTimeout(() => input.write('n\n'), 50)
  const g = await p
  assert.equal(g.decision, 'deny')
  assert.match(printed, /Open findings: \[blocker\] config\.js leaks \[REDACTED\]/)
  assert.ok(!printed.includes(FAKE_KEY))
})

test('gh opens the PR in the push remote\'s repository: --repo is explicit and a conflicting GH_REPO is ignored', async () => {
  const toy = toyRepo({ remote: true })
  const ghLog = path.join(toy.bare, 'gh.log')
  const res = await go(toy, 'ghrepo', { COUNCIL_FAKE_GATE: 'approve', GH_REPO: 'someone/else' }, { publish: realPublishWith(ghLog).fn })
  assert.equal(res.outcome.status, 'pr-opened', res.error)
  const log = fs.readFileSync(ghLog, 'utf8')
  assert.match(log, /^pr create --repo github\.com\/example\/toy /m)
  assert.doesNotMatch(log, /GH_REPO=/, 'gh did not inherit GH_REPO')
  assert.equal(readJson(path.join(runDir(toy.dir, 'ghrepo'), 'gate.json')).binding.repo, 'github.com/example/toy', 'the approval names the repository')
  // A remote that is not a GitHub repository: pushed, but gh is never asked to guess one.
  const plain = toyRepo()
  const bare = tmp('council-remote-')
  git(bare, 'init', '-q', '--bare'); git(plain.dir, 'remote', 'add', 'origin', bare); git(plain.dir, 'push', '-q', 'origin', 'main')
  const log2 = path.join(bare, 'gh.log')
  const r2 = await go(plain, 'plainremote', { COUNCIL_FAKE_GATE: 'approve' }, { publish: realPublishWith(log2).fn })
  assert.equal(r2.outcome.status, 'pushed-no-github-repo')
  assert.ok(!fs.existsSync(log2), 'gh was not called')
})

test('if the remote branch moved after the push, no PR is opened on resume', async () => {
  const toy = toyRepo({ remote: true })
  const ghLog = path.join(toy.bare, 'gh.log'), failFlag = path.join(tmp('council-flag-'), 'fail')
  fs.writeFileSync(failFlag, '')
  const pub = realPublishWith(ghLog, { failFlag })
  assert.equal((await go(toy, 'moved', { COUNCIL_FAKE_GATE: 'approve' }, { publish: pub.fn })).outcome.status, 'pushed-pr-failed')
  // Someone adds a commit on top of the pushed council branch.
  const other = tmp('council-other-')
  git(other, 'clone', '-q', toy.bare, '.')
  git(other, 'config', 'user.email', 'o@example.invalid'); git(other, 'config', 'user.name', 'O')
  git(other, 'checkout', '-q', 'council/moved')
  fs.writeFileSync(path.join(other, 'extra.txt'), 'not reviewed\n')
  git(other, 'add', '-A'); git(other, 'commit', '-q', '-m', 'extra'); git(other, 'push', '-q', 'origin', 'council/moved')
  fs.rmSync(failFlag)
  const res = await runPipeline({ resume: 'moved', repo: toy.dir, dryRun: true }, opts({ env: testEnv({ COUNCIL_FAKE_GATE: 'approve' }), publish: pub.fn }))
  assert.equal(res.outcome.status, 'remote-moved')
  assert.match(readJson(path.join(runDir(toy.dir, 'moved'), 'publish.json')).error, /not the approved commit/)
  assert.ok(!fs.existsSync(ghLog) || !/pr create/.test(fs.readFileSync(ghLog, 'utf8')), 'no PR was created')
})

test('a second candidate after an opened PR: no stale "pr-opened", a failed push is resumed as a fast-forward', async () => {
  const toy = toyRepo({ remote: true })
  const pub = realPublishWith(path.join(toy.bare, 'gh.log'))
  const env = { COUNCIL_FAKE_GATE: 'approve', COUNCIL_FAKE_REVIEW: 'clean' }
  assert.equal((await go(toy, 'second', env, { publish: pub.fn })).outcome.status, 'pr-opened')
  const first = git(toy.bare, 'rev-parse', 'council/second')
  const wt = readJson(path.join(runDir(toy.dir, 'second'), 'run.json')).worktree.path
  fs.appendFileSync(path.join(wt, 'hello.txt'), 'second change\n')
  const hook = path.join(toy.bare, 'hooks', 'pre-receive')
  fs.writeFileSync(hook, '#!/bin/sh\necho rejected for the test >&2\nexit 1\n', { mode: 0o755 })
  const r2 = await runPipeline({ resume: 'second', repo: toy.dir, dryRun: true }, opts({ env: testEnv(env), publish: pub.fn }))
  assert.equal(r2.outcome.status, 'push-failed')
  const cp = readJson(path.join(runDir(toy.dir, 'second'), 'publish.json'))
  assert.notEqual(cp.status, 'pr-opened', 'the old terminal status did not carry over to the new tree')
  assert.equal(cp.previous.status, 'pr-opened')
  fs.rmSync(hook)
  const r3 = await runPipeline({ resume: 'second', repo: toy.dir, dryRun: true }, opts({ env: testEnv(env), publish: pub.fn }))
  assert.equal(r3.outcome.status, 'pr-opened', 'the new tree was not mistaken for already published')
  const run = readJson(path.join(runDir(toy.dir, 'second'), 'run.json'))
  assert.equal(git(toy.bare, 'rev-parse', 'council/second^{tree}'), run.candidate.tree)
  assert.equal(git(toy.bare, 'rev-parse', 'council/second^'), first, 'the new commit sits on top of the published one')
})

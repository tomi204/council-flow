// fake-engine.mjs: plays claude / codex / fx for --dry-run and the tests. No AI, no network, no quota.
//   node fake-engine.mjs <claude|codex|fx> -- <the exact argv council-flow would give the real CLI>
// It also works as a PATH stub for the real binaries (`exec node fake-engine.mjs claude -- "$@"`): then it answers
// the availability probes (--version, auth/login status, fx status, `codex sandbox -- /bin/echo`) and infers the
// role from the prompt.
//
// Before answering it checks the argv: read-only roles must carry the read-only flags, write roles must stay
// sandboxed, fx must never be in auto/full-access, prompts must come on stdin, and the Lyber key must not be in a
// non-fx env. A violation exits 97/98 so the run (and the test) fails loudly.
// Then it prints the real CLI's output shape: claude stream-json, codex --json + the -o file, fx --json.
//
// Knobs (comma lists of `member` or `member:role`):
//   COUNCIL_FAKE_TIMEOUT  hangs (tests the timeout kill)
//   COUNCIL_FAKE_FAIL     exits 1 with a rate-limit message
//   COUNCIL_FAKE_BADJSON  first answer has no JSON (tests the one JSON retry)
// and:
//   COUNCIL_FAKE_REVIEW            once (default: a major finding in round 1 only) | always | clean
//   COUNCIL_FAKE_REVIEW_FAIL_FROM  reviewers crash from this review round on (not a rate limit)
//   COUNCIL_FAKE_FIX               change (default) | noop | write-then-fail
//   COUNCIL_FAKE_IMPL              plain (default) | symlink (also adds leak.txt -> $COUNCIL_FAKE_SYMLINK_TARGET)
//   COUNCIL_FAKE_JUDGE             first (default: the first label) | merge
//   COUNCIL_FAKE_CODEX_SANDBOX     ok (default) | broken (probe fails) | runtime (every codex call shows a bwrap error)
//   COUNCIL_FAKE_RECORD            append one JSON line per call: member, role, argv, cwd, stdin, secret-like env
import fs from 'node:fs'
import path from 'node:path'

const member = process.argv[2]
const sep = process.argv.indexOf('--')
const args = sep > 0 ? process.argv.slice(sep + 1) : []
const READ_ONLY = ['plan', 'judge', 'review', 'nudge', 'audit-context', 'audit-blue-read', 'audit-review', 'audit-red']
const WRITE = ['implement', 'fix', 'audit-patch']
const SECRETISH = /(_KEY|_TOKEN|_SECRET|PASSWORD|_PAT|APIKEY)$|^GIT_(DIR|INDEX_FILE|WORK_TREE|CONFIG\w*)$|^ORCA_PAIRING_CODE$|^GH_REPO$|^COUNCIL_TEST_CMD$/i
const list = (n) => String(process.env[n] || '').split(',').map(s => s.trim()).filter(Boolean)
let role = process.env.COUNCIL_FAKE_ROLE || ''
const hit = (n) => list(n).some(x => x === member || x === `${member}:${role}`)
const val = (flag) => { const i = args.indexOf(flag); return i >= 0 ? args[i + 1] : undefined }
const die = (code, msg) => { process.stderr.write(`FAKE-ENGINE: ${msg}\n`); process.exit(code) }
const BWRAP = 'bwrap: loopback: Failed RTM_NEWADDR: Operation not permitted'
// Fixture writes never follow a symlink (a tracked hello.txt link must not let a rehearsal write outside the worktree).
function put(file, data, append = false) {
  const C = fs.constants
  let fd
  try { fd = fs.openSync(file, C.O_WRONLY | C.O_CREAT | C.O_NOFOLLOW | (append ? C.O_APPEND : C.O_TRUNC), 0o644) } catch (e) { die(1, `refusing to write ${file}: ${e.code}`) }
  try { fs.writeSync(fd, data) } finally { fs.closeSync(fd) }
}

function record(stdin) {
  const file = process.env.COUNCIL_FAKE_RECORD
  if (!file) return
  const env = Object.fromEntries(Object.entries(process.env).filter(([k]) => SECRETISH.test(k)))
  fs.appendFileSync(file, JSON.stringify({ member, role, args, cwd: process.cwd(), stdin, env }) + '\n')
}

// Availability probes (only when used as a PATH stub for the real binary).
function probe() {
  if (args[0] === '--version') { process.stdout.write(`${member} 9.9.9 (fake)\n`); return true }
  if (member === 'claude' && args[0] === 'auth') { process.stdout.write(JSON.stringify({ loggedIn: true, authMethod: 'fake' }) + '\n'); return true }
  if (member === 'codex' && args[0] === 'login') { process.stdout.write('Logged in (fake)\n'); return true }
  if (member === 'codex' && args[0] === 'sandbox') {
    if (process.env.COUNCIL_FAKE_CODEX_SANDBOX === 'broken') { process.stderr.write(BWRAP + '\n'); process.exit(1) }
    const i = args.indexOf('--'); process.stdout.write(args.slice(i + 2).join(' ') + '\n'); return true
  }
  if (member === 'fx' && args[0] === 'status') { process.stdout.write(JSON.stringify({ kind: 'status', connected_providers: ['lyber'], model_source: 'lyber' }) + '\n'); return true }
  return false
}

function inferRole(prompt) {
  if (prompt.startsWith('You are planning a code change')) return 'plan'
  if (prompt.startsWith('You are a blind judge')) return 'judge'
  if (prompt.startsWith('You are the implementer again')) return 'fix'
  if (prompt.startsWith('You are the implementer.')) return 'implement'
  if (prompt.startsWith('You are a strict code reviewer')) return 'review'
  if (prompt.startsWith('Your previous reply could not be used')) return 'nudge'
  return ''
}

function checkFlags() {
  const ro = READ_ONLY.includes(role)
  if (!ro && !WRITE.includes(role)) die(97, `unknown role "${role}"`)
  if (args.some(a => a.length > 2000)) die(97, 'an argument over 2000 chars: prompts must go on stdin')
  if (member !== 'fx' && process.env.LYBER_API_KEY) die(98, `LYBER_API_KEY leaked into the ${member} env`)
  if (member === 'claude') {
    if (args[0] !== '-p') die(97, 'claude must run with -p')
    for (const f of ['--restricted', '--strict-mcp-config', '--no-session-persistence']) if (!args.includes(f)) die(97, `claude ${role}: missing ${f}`)
    if (val('--permission-prompts') !== 'none') die(97, 'claude: --permission-prompts none missing')
    if (args.some(a => /dangerously|bypassPermissions/.test(a))) die(97, 'claude: permission bypass flag')
    const tools = val('--tools'), mode = val('--permission-mode')
    if (tools === undefined) die(97, 'claude: --tools missing')
    if (/bash|powershell|webfetch|websearch/i.test(tools)) die(97, `claude: command/network tool in --tools: ${tools}`)
    if (ro) {
      if (/edit|write|notebook/i.test(tools)) die(97, `read-only claude ${role} has write tools: ${tools}`)
      if (mode !== 'dontAsk') die(97, `read-only claude ${role} must use --permission-mode dontAsk (got ${mode})`)
    } else if (mode !== 'acceptEdits') die(97, `claude ${role} must use acceptEdits (got ${mode})`)
    if ((role === 'judge' || role === 'nudge') && tools !== '') die(97, `claude ${role} must have no tools`)
  } else if (member === 'codex') {
    if (args[0] !== 'exec') die(97, 'codex must run exec')
    for (const f of ['--ignore-user-config', '--ignore-rules', '--ephemeral', '--json', '-o']) if (!args.includes(f)) die(97, `codex ${role}: missing ${f}`)
    if (args.some(a => /dangerously|approve-for-me|danger-full-access/.test(a))) die(97, 'codex: sandbox bypass flag')
    const sb = val('-s')
    if (ro ? sb !== 'read-only' : sb !== 'workspace-write') die(97, `codex ${role}: sandbox ${sb}`)
    if (args[args.length - 1] !== '-') die(97, 'codex: prompt must come from stdin (-)')
  } else if (member === 'fx') {
    if (!ro) die(97, `fx may never take the ${role} role`)
    if (args[0] !== 'ask') die(97, 'fx must run ask')
    if (args.some(a => ['--auto', '--full-access', '--yolo'].includes(a))) die(97, 'fx: auto/full-access')
    const mode = val('--permission-mode')
    if (mode !== undefined && mode !== 'ask') die(97, `fx: --permission-mode ${mode}`)
    if (process.env.FX_PERMISSION_MODE !== 'ask') die(97, 'fx: FX_PERMISSION_MODE must be ask')
    if (!args.includes('--json') || !args.includes('--no-save')) die(97, 'fx: needs --json --no-save')
    if (role === 'audit-red') {
      const profile = JSON.parse(fs.readFileSync(path.join(process.env.FX_HOME, 'settings.json')))
      if (mode !== 'ask' || val('--provider') !== 'lyber' || val('--model') !== 'kimi-k31-pro-abliterated' ||
          profile.providers.lyber.model_metadata[val('--model')].supports_tool_use !== false ||
          profile.first_call_tool_choice !== 'none' || profile.max_agent_steps !== 1 || fs.readdirSync('.').length) die(97, 'Red must run text-only in an empty directory')
    }
    const withValue = new Set(['--system', '--permission-mode', '--provider', '--model', '--timeout'])
    for (let i = 1; i < args.length; i++) {
      if (withValue.has(args[i])) { i++; continue }
      if (!args[i].startsWith('--')) die(97, `fx: positional argument "${args[i].slice(0, 40)}": the prompt must come on stdin`)
    }
  } else die(97, `unknown member ${member}`)
}

const SELF = {
  claude: 'I am Claude (Opus 5.5), made by Anthropic. I used TodoWrite to plan this.',
  codex: 'As Codex from OpenAI (gpt-6.2-astra), I would use apply_patch. Here is my plan.',
  fx: 'Kimi here (kimi-k31-pro-abliterated), running through Lyber on fx by Vercel.'
}
const leak = () => (member === 'fx' && process.env.LYBER_API_KEY ? `\n\n(debug) LYBER_API_KEY=${process.env.LYBER_API_KEY}` : '')
const roundOf = (prompt, re) => Number((prompt.match(re) || [0, 1])[1])

function review(prompt) {
  const round = roundOf(prompt, /review round (\d+)/i)
  const mode = process.env.COUNCIL_FAKE_REVIEW || 'once'
  if (mode === 'clean' || (mode === 'once' && round > 1)) return []
  if (mode === 'always') return [{ severity: 'blocker', category: 'bug', file: 'hello.txt', line: 1, issue: `Greeting is still wrong in round ${round}.`, suggestion: 'Fix the greeting.' }]
  return [
    { severity: 'major', category: 'test', file: 'hello.txt', line: 1, issue: 'No test checks the greeting text.', suggestion: 'Add an assertion in check.mjs.' },
    { severity: 'minor', category: 'style', file: 'hello.txt', line: null, issue: `Greeting could be capitalised (${member}).`, suggestion: 'Use "Hello".' }
  ]
}

function answerFor(prompt) {
  if (role.startsWith('audit-') && hit('COUNCIL_FAKE_BADJSON')) return 'invalid JSON'
  if (role === 'audit-context') {
    const sections = ['architecture', 'attack_surface', 'trust_boundaries', 'auth_model', 'dependencies', 'config_secrets', 'data_flows', 'prior_findings', 'red_brief', 'blue_brief']
    return JSON.stringify(Object.fromEntries(sections.map(k => [k, 'Local snapshot: ' + k])))
  }
  if (role === 'audit-red') {
    const round = roundOf(prompt, /Review round (\d+)/)
    const scoped = JSON.parse(prompt.match(/^Scope and target: (.+)$/m)[1]).target
    if (process.env.COUNCIL_FAKE_REVIEW === 'clean' || !prompt.includes('guard.mjs') ||
        (scoped.kind === 'path' && !['.', 'guard.mjs'].includes(scoped.path))) return '[]'
    const status = round === 1 ? 'open' : process.env.COUNCIL_FAKE_REVIEW === 'always' ? 'reopened' : 'fixed'
    return JSON.stringify([{ id: 'F1', severity: 'high', file: 'guard.mjs', line: 1, title: 'Missing boolean check',
      why_exploitable: process.env.COUNCIL_FAKE_RED_PROSE || 'The helper accepts values outside its boolean contract.', impact: 'Access decisions can be incorrect.',
      fix_hint: 'Require an explicit boolean true.', status, poc: 'DISCARDED_FIELD_SENTINEL', payload: 'DISCARDED_FIELD_SENTINEL' }])
  }
  if (role === 'audit-review') {
    const evidence = JSON.parse(prompt.split('\nIteration evidence:\n').at(-1))
    const reject = process.env.COUNCIL_FAKE_DISPUTE_CLOSURE === 'codex' || process.env.COUNCIL_FAKE_REVIEW === 'always' ||
      process.env.COUNCIL_FAKE_REPAIR && !evidence.cumulativeDiff.includes('allowed(null)')
    const decision = process.env.COUNCIL_FAKE_AUDIT_DECISION || 'confirmed'
    return JSON.stringify({
      findings: evidence.findings.map(f => ({ id: f.id, decision, justification: 'The source requires an explicit boolean boundary.' })),
      patches: evidence.claims.map(f => ({ id: f.id, decision: reject ? 'rejected' : 'verified', justification: 'Checked the comparison and the file specific assertion.' })),
      concerns: process.env.COUNCIL_FAKE_AUDIT_CONCERN ? [{ kind: 'regression', reason: 'Inspect the changed guard.' }] : [],
      context_delta: 'Distinguish the guard and its callers.' + (process.env.COUNCIL_FAKE_AUDIT_LEAK ? ' API_KEY=ScrubFixture98765' : '')
    })
  }
  if (role === 'audit-patch' || role === 'audit-blue-read') {
    const prior = JSON.parse(prompt.split('\nPrevious verdict and ledger:\n').at(-1))
    const proactive = process.env.COUNCIL_FAKE_PROACTIVE && !prior.ledger.length
    const findings = proactive ? [{ id: 'B-guard', file: 'guard.mjs', line: 1, title: 'Missing type check', status: 'open',
      severity: 'medium', why_exploitable: 'The helper trusts a string.', impact: 'The check grants access.', fix_hint: 'Require boolean true.' }] : []
    const claim = prior.ledger.find(f => ['confirmed', 'reopened'].includes(f.status)) || findings[0]
    const empty = JSON.stringify({ findings, fixes: [] })
    if (!claim || role === 'audit-blue-read' || process.env.COUNCIL_FAKE_FIX === 'noop') return empty
    if (process.env.COUNCIL_FAKE_REPAIR && prior.feedback?.patches.some(p => p.id === claim.id && p.decision === 'rejected')) {
      put('guard.test.mjs', 'assert.equal(allowed(null), false)\n', true)
      return JSON.stringify({ findings, fixes: [{ id: claim.id, file: 'guard.mjs', test: 'guard.test.mjs' }] })
    }
    if (prior.claims.some(p => p.id === claim.id) && process.env.COUNCIL_FAKE_REVIEW !== 'always') return empty
    put('guard.mjs', 'export const allowed = value => value === true\n')
    const testFile = process.env.COUNCIL_FAKE_MISLABEL_TEST ? 'check.mjs' : 'guard.test.mjs'
    put(testFile, "import assert from 'node:assert/strict'\nimport { allowed } from './guard.mjs'\nassert.equal(allowed(false), false)\nassert.equal(allowed('false'), false)\nassert.equal(allowed(true), true)\n")
    if (process.env.COUNCIL_FAKE_REVIEW === 'always') {
      for (const f of ['guard.mjs', 'guard.test.mjs']) put(f, '// ' + process.pid + '\n', true)
    }
    if (process.env.COUNCIL_FAKE_FAIL_FOCUSED) put(testFile, "throw new Error('inert fixture failure')\n", true)
    if (process.env.COUNCIL_FAKE_FIX === 'write-then-fail') die(1, 'fake partial patch')
    return JSON.stringify({ findings, fixes: [{ id: claim.id, file: 'guard.mjs', test: testFile }], test_command: 'true' })
  }
  if (role === 'plan') return `${SELF[member]}\n\n## Approach\nAdd hello.txt with a greeting and a check script that verifies it.\n\n## Files\n- hello.txt: new, "hello council".\n\n## Tests\n- check.mjs asserts the greeting.\n\n## Risks\n- None; this is a fake plan.${leak()}`
  if (role === 'judge') {
    const labels = [...prompt.matchAll(/^=== PLAN ([A-C]) ===$/gm)].map(m => m[1])
    if (hit('COUNCIL_FAKE_BADJSON')) return `I prefer plan ${labels[0]}: it is the simplest.`
    if (process.env.COUNCIL_FAKE_JUDGE === 'merge') return JSON.stringify({ choice: 'merge', plan: `Merged plan from ${labels.join(' and ')}: add hello.txt with a greeting and a check script.`, rationale: 'Both halves are needed.' })
    return `Judging done.\n${JSON.stringify({ choice: labels[0] || 'A', plan: 'JUDGE-CORRECTED PLAN: add hello.txt containing "hello council" and verify it with check.mjs.', rationale: `Plan ${labels[0]} is the smallest correct change.` })}`
  }
  if (role === 'nudge') return prompt.includes('"choice"') ? JSON.stringify({ choice: 'A', plan: 'As written.', rationale: 'Reformatted.' }) : '[]'
  if (role === 'review') {
    const from = Number(process.env.COUNCIL_FAKE_REVIEW_FAIL_FROM || 0)
    if (from && roundOf(prompt, /review round (\d+)/i) >= from) die(1, 'fake reviewer crash')
    if (hit('COUNCIL_FAKE_BADJSON')) return 'Looks mostly fine to me, but the greeting is not tested.'
    const f = JSON.stringify(review(prompt), null, 1)
    return member === 'codex' ? `Review complete.\n${f}` : member === 'fx' ? `\`\`\`json\n${f}\n\`\`\`${leak()}` : f
  }
  if (role === 'implement') {
    if (member === 'codex' && process.env.COUNCIL_FAKE_CODEX_SANDBOX === 'runtime') return 'I could not run any command.'
    put(path.join(process.cwd(), 'hello.txt'), 'hello council\n')
    if (process.env.COUNCIL_FAKE_IMPL === 'symlink') fs.symlinkSync(process.env.COUNCIL_FAKE_SYMLINK_TARGET, path.join(process.cwd(), 'leak.txt'))
    return 'Added hello.txt.'
  }
  if (role === 'fix') {
    const round = roundOf(prompt, /fix round (\d+)/i)
    if (process.env.COUNCIL_FAKE_FIX === 'noop') return 'I disagree with every finding; nothing changed.'
    put(path.join(process.cwd(), 'hello.txt'), `fixed in round ${round}\n`, true)
    if (process.env.COUNCIL_FAKE_FIX === 'write-then-fail') die(1, 'fake crash after writing')
    return `Addressed the findings of round ${round}.`
  }
  return ''
}

const line = (o) => process.stdout.write(JSON.stringify(o) + '\n')

async function main() {
  if (['--version', 'auth', 'login', 'sandbox', 'status'].includes(args[0])) { role = `probe:${args[0]}`; record('') }
  if (probe()) return
  let prompt = ''
  for await (const c of process.stdin) prompt += c
  if (!prompt.trim()) die(96, 'empty prompt on stdin')
  role ||= inferRole(prompt)
  record(prompt)
  checkFlags()
  // Both subprocesses must reach this rendezvous before either can answer.
  if (process.env.COUNCIL_FAKE_PARALLEL && ['audit-red', 'audit-patch'].includes(role)) {
    const round = roundOf(prompt, /Review round (\d+)/)
    const other = role === 'audit-red' ? 'audit-patch' : 'audit-red'
    const start = Date.now()
    while (!fs.readFileSync(process.env.COUNCIL_FAKE_RECORD, 'utf8').trim().split('\n').map(JSON.parse)
      .some(c => c.role === other && roundOf(c.stdin, /Review round (\d+)/) === round)) {
      if (Date.now() - start > 5000) die(1, 'parallel peer did not start')
      await new Promise(resolve => setTimeout(resolve, 20))
    }
  }
  if (hit('COUNCIL_FAKE_TIMEOUT')) await new Promise(r => setTimeout(r, 600000))
  if (hit('COUNCIL_FAKE_FAIL')) die(1, 'Error: rate limit reached, try again later (fake)')
  let answer = answerFor(prompt)
  const format = process.env.COUNCIL_FAKE_BLUE_FORMAT
  if (format && ['audit-blue-read', 'audit-patch'].includes(role)) {
    if (format === 'wrapped') answer = 'Preliminary {"draft":true}\nFinal report\n```json\n' + answer + '\n```\nComplete.'
    else if (format.startsWith('partial')) answer = JSON.stringify({ findings: [{ id: 'B-first', severity: 'medium', file: 'guard.mjs',
      line: 1, title: 'Guard issue', why_exploitable: 'The guard trusts a string.', impact: 'Incorrect access.', fix_hint: 'Require a boolean.' },
      { id: 'B-second', severity: 'medium', file: 'guard.mjs' }], fixes: [] })
  }
  if (role === 'nudge' && prompt.includes('Validation error:')) {
    if (format === 'partial-repair') {
      const rows = JSON.parse(prompt.split('<<<\n')[1].split('\n>>>')[0]).findings
      answer = JSON.stringify({ findings: [rows[0], { ...rows[0], id: rows[1].id }] })
    } else if (format === 'partial') answer = prompt.split('<<<\n')[1].split('\n>>>')[0]
    else answer = 'cannot repair'
  }
  const usage = { input_tokens: Math.ceil(prompt.length / 4), output_tokens: Math.ceil(answer.length / 4) }
  if (member === 'claude') {
    line({ type: 'system', subtype: 'init', model: 'fake' })
    line({ type: 'assistant', message: { content: [{ type: 'text', text: answer }] } })
    line({ type: 'result', subtype: 'success', is_error: false, result: answer, usage: { ...usage, cache_read_input_tokens: 0 }, total_cost_usd: 0, num_turns: 1 })
  } else if (member === 'codex') {
    line({ type: 'thread.started', thread_id: 'fake' })
    line({ type: 'turn.started' })
    if (process.env.COUNCIL_FAKE_CODEX_SANDBOX === 'runtime') line({ type: 'item.completed', item: { id: 'cmd_0', type: 'command_execution', command: 'bash -lc ls', aggregated_output: BWRAP + '\n', exit_code: 1, status: 'failed' } })
    fs.writeFileSync(val('-o'), answer)
    line({ type: 'item.completed', item: { id: 'item_0', type: 'agent_message', text: answer } })
    line({ type: 'turn.completed', usage: { ...usage, cached_input_tokens: 0 } })
  } else {
    if (process.env.LYBER_API_KEY) process.stderr.write(`debug: POST https://api.lyber.ai/v1/chat/completions Authorization: Bearer ${process.env.LYBER_API_KEY}\n`)
    process.stdout.write(JSON.stringify({ kind: 'ask', output: answer, final_output: answer, usage, exit_code: 0, error: null }) + '\n')
  }
}
main().catch(e => die(1, e.stack || String(e)))

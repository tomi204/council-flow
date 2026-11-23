// cli.mjs: argv -> pipeline / issue intake / doctor.
import fs from 'node:fs'
import path from 'node:path'
import { parseArgs } from 'node:util'
import { runPipeline, UsageError } from './pipeline.mjs'
import { loadConfig, validateConfig, VERSION } from './config.mjs'
import { doctor } from './doctor.mjs'
import { run, which } from './proc.mjs'
import { deepFind } from './orca.mjs'
import { envFor } from './env.mjs'
import { scrubSecrets } from './redact.mjs'

// Every line council-flow prints goes through the scrubber.
export const say = (s) => process.stdout.write(scrubSecrets(s))
export const shout = (s) => process.stderr.write(scrubSecrets(s))

export const USAGE = `council-flow ${VERSION}: blind planning, one implementer, read-only cross-review, bounded fixes, tests, human gate.

Usage:
  council-flow "<task>" --repo <path> [options]
  council-flow audit "<scope>" --repo <path> [--target <path-in-repo|localhost:PORT>] [--test-target <path-in-repo>] [--rounds N] [--refresh-context] [--dry-run] [--resume <run-id>]
  council-flow issue (--github <number|url> | --linear <id|url> | --text-file <path|->) --repo <path> [options]
  council-flow --resume <run-id> --repo <path> [--dry-run]
  council-flow doctor [--repo <path>] [--dry-run]

Options:
  --repo <path>              target git repository (default: current directory)
  --implementer codex|claude implementer (env COUNCIL_IMPLEMENTER, default codex)
  --judge claude|codex|fx    blind judge (env COUNCIL_JUDGE, default claude)
  --rounds <n>               0-5 (COUNCIL_ROUNDS; coding default 2 fixes, audit default 3 iterations)
  --test-cmd <cmd>           test command (default: detected from package.json/Makefile/pyproject/...)
  --base-branch <name>       PR base branch (default: the repo's current branch)
  --members <list>           comma list of members to use (env COUNCIL_MEMBERS, default claude,codex,fx)
  --run-id <id>              run id (default: timestamp + task slug)
  --resume <run-id>          continue a run from its last completed stage (the gate is always asked again)
  --task-file <path>         read the task from a file instead of the argument
  --dry-run                  fake members, fake Orca, fake gate (COUNCIL_FAKE_GATE=approve|deny, default deny)
  -h, --help                 this help
  -v, --version              version

Nothing is committed, pushed or opened as a PR unless the decision gate is answered "approve".
Artifacts: <repo>/.council-flow/<run-id>/ (excluded via .git/info/exclude).`

// Exported for test/plugin.test.mjs, which parses the Orca plugin's command lines with these exact definitions.
export const OPTIONS = {
  repo: { type: 'string' }, implementer: { type: 'string' }, judge: { type: 'string' }, rounds: { type: 'string' },
  'test-cmd': { type: 'string' }, 'base-branch': { type: 'string' }, members: { type: 'string' },
  'run-id': { type: 'string' }, resume: { type: 'string' }, 'task-file': { type: 'string' }, 'dry-run': { type: 'boolean' },
  target: { type: 'string' }, 'test-target': { type: 'string' }, 'refresh-context': { type: 'boolean' },
  github: { type: 'string' }, linear: { type: 'string' }, 'text-file': { type: 'string' },
  help: { type: 'boolean', short: 'h' }, version: { type: 'boolean', short: 'v' }
}

export const AUDIT_OPTIONS = new Set(['repo', 'target', 'test-target', 'implementer', 'rounds', 'refresh-context', 'resume', 'dry-run', 'run-id', 'test-cmd'])

const readStdin = async () => { let s = ''; for await (const c of process.stdin) s += c; return s }

// Issue text -> task. GitHub via `gh issue view --json`, Linear via `orca linear issue --json`.
export async function issueTask(v, { repo, dryRun }) {
  const cap = (s) => String(s || '').slice(0, 20000)
  if (v['text-file']) {
    const text = v['text-file'] === '-' ? await readStdin() : fs.readFileSync(path.resolve(v['text-file']), 'utf8')
    return { task: cap(text).trim(), source: { kind: 'text', path: v['text-file'] } }
  }
  if (v.github) {
    if (dryRun) return { task: `Fake GitHub issue ${v.github}: add a greeting file (dry run).`, source: { kind: 'github', ref: v.github, fake: true } }
    const gh = which('gh')
    if (!gh) throw new UsageError('gh not found; needed for --github')
    const r = await run(gh, ['issue', 'view', v.github, '--json', 'number,title,body,url'], { cwd: repo, timeoutMs: 60000, env: envFor('gh') })
    if (!r.ok) throw new UsageError(`gh issue view ${v.github} failed: ${r.stderr.trim().slice(0, 300)}`)
    const j = JSON.parse(r.stdout)
    return { task: cap(`GitHub issue #${j.number}: ${j.title}\n\n${j.body || ''}\n\nSource: ${j.url}`), source: { kind: 'github', ref: v.github, url: j.url } }
  }
  if (v.linear) {
    if (dryRun) return { task: `Fake Linear issue ${v.linear}: add a greeting file (dry run).`, source: { kind: 'linear', ref: v.linear, fake: true } }
    const orca = which('orca') || which('orca-ide')
    if (!orca) throw new UsageError('orca not found; needed for --linear (or pass the issue text with --text-file)')
    const r = await run(orca, ['linear', 'issue', v.linear, '--json'], { timeoutMs: 60000, env: envFor('orca') })
    let j = null; try { j = JSON.parse(r.stdout) } catch { /* below */ }
    if (!r.ok || !j || j.ok === false) throw new UsageError(`orca linear issue ${v.linear} failed: ${(j && j.error && j.error.message) || r.stderr.trim().slice(0, 300)}`)
    const pick = (re) => deepFind(j, (k, val) => typeof val === 'string' && re.test(k))
    const title = pick(/^title$/i), body = pick(/^(description|body)$/i), id = pick(/^identifier$/i) || v.linear, url = pick(/^url$/i)
    return { task: cap(`Linear issue ${id}: ${title || ''}\n\n${body || ''}${url ? `\n\nSource: ${url}` : ''}`), source: { kind: 'linear', ref: v.linear, url: url || null } }
  }
  throw new UsageError('issue needs --github, --linear or --text-file')
}

export async function main(argv = process.argv.slice(2)) {
  let parsed
  try { parsed = parseArgs({ args: argv, options: OPTIONS, allowPositionals: true }) } catch (e) { shout(`${e.message}\n\n${USAGE}\n`); return 1 }
  const { values: v, positionals } = parsed
  if (v.version) { say(`${VERSION}\n`); return 0 }
  const cmd = ['doctor', 'issue', 'help', 'run', 'audit'].includes(positionals[0]) ? positionals.shift() : 'run'
  if (v.help || cmd === 'help') { say(USAGE + '\n'); return 0 }
  const dryRun = Boolean(v['dry-run'])

  try {
    if (cmd !== 'audit' && (v.target !== undefined || v['test-target'] !== undefined || v['refresh-context'])) throw new UsageError('--target, --test-target and --refresh-context require audit')
    if (cmd === 'audit') {
      for (const k of Object.keys(v)) if (!AUDIT_OPTIONS.has(k)) throw new UsageError('--' + k + ' is unavailable in audit mode')
      if (v.resume && positionals.length) throw new UsageError('resume uses the saved audit scope')
    }
    if (cmd === 'doctor') {
      const cfg = loadConfig({ dryRun, members: v.members, testCmd: v['test-cmd'] })
      return await doctor(cfg, { repo: v.repo ? path.resolve(v.repo) : null, write: (l) => say(l + '\n') })
    }
    if (v.rounds != null && !/^\d+$/.test(v.rounds)) throw new UsageError(`--rounds must be a whole number (got "${v.rounds}")`)
    const opts = {
      audit: cmd === 'audit', target: v.target, testTarget: v['test-target'], refreshContext: v['refresh-context'],
      repo: v.repo || process.cwd(), implementer: v.implementer, judge: v.judge,
      rounds: v.rounds != null ? Number(v.rounds) : undefined, testCmd: v['test-cmd'], baseBranch: v['base-branch'],
      members: v.members, dryRun, runId: v['run-id'], resume: v.resume
    }
    if (cmd === 'issue') Object.assign(opts, await issueTask(v, { repo: path.resolve(opts.repo), dryRun }))
    else if (!v.resume) opts.task = v['task-file'] ? fs.readFileSync(path.resolve(v['task-file']), 'utf8') : positionals.join(' ')
    if (!v.resume && !String(opts.task || '').trim()) throw new UsageError('missing task')
    const errs = cmd === 'audit' ? [] : validateConfig(loadConfig({ ...opts, dryRun }))
    if (errs.length) throw new UsageError(errs.join('\n'))

    const res = await runPipeline(opts)
    say(`${res.outcome.status}\t${res.runId}\t${res.dir}\n`)
    return res.exitCode
  } catch (e) {
    if (e instanceof UsageError) { shout(`council-flow: ${e.message}\n\nRun council-flow --help for usage.\n`); return 1 }
    shout(`council-flow: ${e.stack || e.message}\n`)
    return 2
  }
}

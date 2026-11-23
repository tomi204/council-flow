// doctor.mjs: one OK/FAIL line per piece. Spends no tokens: only --version, login-status, local status commands
// and `codex sandbox -- /bin/echo` (runs echo inside Codex's sandbox, no model call). Never prints account emails or
// key values (only whether a key is present); every line goes through the secret scrubber.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { auditConfig } from './audit/config.mjs'
import { offlineCommand } from './audit/offline.mjs'
import { MEMBERS } from './config.mjs'
import { createEngine, versionGte } from './engines.mjs'
import { createOrca } from './orca.mjs'
import { run, which } from './proc.mjs'
import { envFor } from './env.mjs'
import { git, detectTestCommand } from './repo.mjs'
import { scrubSecrets } from './redact.mjs'

export async function doctor(cfg, { repo = null, env = process.env, write = (l) => process.stdout.write(l + '\n') } = {}) {
  const add = (ok, name, detail) => write(scrubSecrets(`${ok ? 'OK  ' : 'FAIL'}  ${name.padEnd(7)} ${detail}`, { env }))
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'council-doctor-'))
  try {
    const major = Number(process.versions.node.split('.')[0])
    add(major >= 20, 'node', `v${process.versions.node} (needs >= 20)`)

    const ok = {}
    const available = {}
    let codexSandbox = null
    for (const id of MEMBERS) {
      const a = await createEngine(id, cfg, { scratch, env }).available()
      available[id] = a.ok
      ok[id] = a.ok && cfg.members.includes(id)
      let detail = `${a.version || 'version ?'}: ${a.ok ? a.detail : a.reason}`
      if (id === 'fx' && a.version) detail += versionGte(a.version, '0.0.17')
        ? '; ask flags --permission-mode ask --provider --model (+ FX_* env fallback)'
        : '; fx < 0.0.17: provider/model/permission via FX_* env vars only'
      if (!cfg.members.includes(id)) detail += ' (disabled by COUNCIL_MEMBERS)'
      add(a.ok, id, detail)
      if (id === 'codex' && a.ok) codexSandbox = a
    }
    if (codexSandbox) add(codexSandbox.sandbox !== false, 'sandbox', codexSandbox.sandbox === false
      ? `${codexSandbox.sandboxReason} -> codex reviews and plans from the prompt only (never danger-full-access) and cannot implement; claude implements. Fix: README "Codex sandbox"`
      : 'codex sandbox starts (`codex sandbox -- /bin/echo`)')

    const red = await createEngine('fx', auditConfig(cfg), { scratch, env }).available()
    add(available.codex || available.claude, 'audit context', available.codex ? 'Codex (prompt only)' : 'Claude read-only fallback')
    add(red.ok && versionGte(red.version, '0.0.17'), 'audit Red', red.ok ? 'Kimi via Lyber, text-only profile requires fx >= 0.0.17' : red.reason)
    add(available.claude, 'audit Blue', 'Claude review, patches and regression tests')
    add(available.codex, 'audit judge', 'Codex prompt-only iteration verdict and context delta')
    const guard = offlineCommand('test', '/bin/true', [])
    const isolated = await run(guard.exe, guard.args, { cwd: scratch, env: envFor('test', env, { set: { TMPDIR: scratch, COUNCIL_NODE_PREFIX: path.dirname(path.dirname(process.execPath)) } }) })
    add(isolated.ok, 'audit tests', isolated.ok ? 'offline Linux test isolation available' : 'requires Python 3, libseccomp and Landlock ABI 3+ on Linux')
    const orca = createOrca(cfg, { env })
    const info = await orca.detect()
    const v = cfg.dryRun ? 'fake' : await orca.version()
    const installed = cfg.dryRun || Boolean(info.bin)
    add(installed && !/not reachable|status failed/.test(info.reason), 'orca',
      `${v || 'not installed'}: ${info.usable ? 'orchestration usable' : `orchestration not used -> git worktree + TTY gate fallback (${info.reason})`}`)

    const g = await run('git', ['--version'], { timeoutMs: 15000, env: envFor('git', env) })
    add(g.ok, 'git', g.ok ? g.stdout.trim() : 'git not found')

    const gh = which(cfg.bins.gh, env)
    if (!gh) add(false, 'gh', 'not found (needed only to open PRs after approval)')
    else {
      const ghEnv = envFor('gh', env)
      const ver = (await run(gh, ['--version'], { timeoutMs: 15000, env: ghEnv })).stdout.split('\n')[0].trim()
      const auth = cfg.dryRun ? { ok: true } : await run(gh, ['auth', 'status'], { timeoutMs: 30000, env: ghEnv })
      add(auth.ok, 'gh', `${ver}; ${auth.ok ? 'authenticated' : 'not authenticated (gh auth login), needed only to open PRs'}`)
    }

    if (repo) {
      const r = await git(['rev-parse', '--show-toplevel'], repo, { allowFail: true, baseEnv: env })
      add(r.ok, 'repo', r.ok ? `${r.stdout.trim()}; test command: ${cfg.testCmd || detectTestCommand(r.stdout.trim()) || 'none detected (use --test-cmd)'}` : `${repo} is not a git repository`)
    }

    const ready = MEMBERS.filter(id => ok[id])
    const implementer = ok.claude || (ok.codex && codexSandbox?.sandbox !== false)
    const usable = major >= 20 && g.ok && ready.length >= 2 && implementer
    write(`\n${usable ? 'READY' : 'NOT READY'}: ${ready.length}/${MEMBERS.length} members available (planning needs 2, review needs 1 besides the implementer)${implementer ? '' : '; no implementer: needs claude, or codex with a working sandbox'}`)
    return usable ? 0 : 1
  } finally { fs.rmSync(scratch, { recursive: true, force: true }) }
}

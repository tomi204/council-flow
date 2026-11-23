// config.mjs: every knob in one place. Flags win over env, env wins over defaults.
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

export const MEMBERS = ['claude', 'codex', 'fx']
export const IMPLEMENTERS = ['codex', 'claude']   // fx never writes: it would need auto/full-access
export const VERSION = '0.3.0'

const int = (v, d) => { const n = Number.parseInt(v, 10); return Number.isFinite(n) ? n : d }
const list = (v) => String(v || '').split(',').map(s => s.trim()).filter(Boolean)

// Codex's own configured model. --ignore-user-config skips config.toml, so council-flow reads the top-level
// `model = "..."` line itself and passes it with -m. Returns null when there is none.
export function codexConfiguredModel(env = process.env) {
  const home = env.CODEX_HOME || path.join(env.HOME || os.homedir(), '.codex')
  let text = ''
  try { text = fs.readFileSync(path.join(home, 'config.toml'), 'utf8') } catch { return null }
  for (const line of text.split(/\r?\n/)) {
    if (/^\s*\[/.test(line)) break                       // first table: top-level keys are over
    const m = line.match(/^\s*model\s*=\s*["']([^"']+)["']/)
    if (m) return m[1]
  }
  return null
}

export function loadConfig(flags = {}, env = process.env) {
  const dryRun = Boolean(flags.dryRun)
  const cfg = {
    version: VERSION,
    dryRun,
    members: flags.members ? list(flags.members) : (env.COUNCIL_MEMBERS ? list(env.COUNCIL_MEMBERS) : [...MEMBERS]),
    implementer: flags.implementer || env.COUNCIL_IMPLEMENTER || 'codex',
    judge: flags.judge || env.COUNCIL_JUDGE || 'claude',
    rounds: int(flags.rounds ?? env.COUNCIL_ROUNDS, flags.audit ? 3 : 2),
    timeoutMs: int(env.COUNCIL_TIMEOUT_MS, dryRun ? 20000 : 15 * 60000),
    implTimeoutMs: int(env.COUNCIL_IMPL_TIMEOUT_MS, dryRun ? 20000 : 45 * 60000),
    testTimeoutMs: int(env.COUNCIL_TEST_TIMEOUT_MS, 10 * 60000),
    gateTimeoutMs: int(env.COUNCIL_GATE_TIMEOUT_MS, 30 * 60000),
    testCmd: flags.testCmd || env.COUNCIL_TEST_CMD || null,
    baseBranch: flags.baseBranch || env.COUNCIL_BASE_BRANCH || null,
    models: {
      claude: env.COUNCIL_CLAUDE_MODEL || 'opus',
      codex: env.COUNCIL_CODEX_MODEL || null,          // null: Codex's configured model (see codexConfiguredModel)
      fx: env.COUNCIL_FX_MODEL || 'kimi-k31-pro-abliterated'
    },
    modelsExplicit: { claude: Boolean(env.COUNCIL_CLAUDE_MODEL), codex: Boolean(env.COUNCIL_CODEX_MODEL), fx: Boolean(env.COUNCIL_FX_MODEL) },
    efforts: { claude: env.COUNCIL_CLAUDE_EFFORT || null, codex: env.COUNCIL_CODEX_EFFORT || null },
    fxProvider: env.COUNCIL_FX_PROVIDER || 'lyber',
    fxKeyEnv: env.COUNCIL_FX_KEY_ENV || 'LYBER_API_KEY',
    bins: {
      claude: env.COUNCIL_CLAUDE_BIN || 'claude',
      codex: env.COUNCIL_CODEX_BIN || 'codex',
      fx: env.COUNCIL_FX_BIN || 'fx',
      orca: env.COUNCIL_ORCA_BIN || null,              // null: orca, then orca-ide on PATH
      gh: env.COUNCIL_GH_BIN || 'gh',
      git: 'git'
    },
    orca: {
      mode: (env.COUNCIL_ORCA || 'auto').toLowerCase(),        // auto | on | off
      implement: (env.COUNCIL_ORCA_IMPLEMENT || 'orca').toLowerCase(),   // orca (Orca worker) | headless (confined CLI)
      worktree: env.COUNCIL_ORCA_WORKTREE || 'new-child',      // new-child | new-top-level
      from: env.COUNCIL_ORCA_FROM || env.ORCA_TERMINAL_HANDLE || null
    }
  }
  if (!cfg.models.codex && !dryRun) cfg.models.codex = codexConfiguredModel(env)
  return cfg
}

export function validateConfig(cfg) {
  const errors = []
  for (const m of cfg.members) if (!MEMBERS.includes(m)) errors.push(`unknown member "${m}" (known: ${MEMBERS.join(', ')})`)
  if (!IMPLEMENTERS.includes(cfg.implementer)) errors.push(`implementer must be one of ${IMPLEMENTERS.join(', ')} (got "${cfg.implementer}")`)
  if (!MEMBERS.includes(cfg.judge)) errors.push(`judge must be one of ${MEMBERS.join(', ')} (got "${cfg.judge}")`)
  if (!(cfg.rounds >= 0 && cfg.rounds <= 5)) errors.push(`rounds must be 0..5 (got ${cfg.rounds})`)
  if (!['auto', 'on', 'off'].includes(cfg.orca.mode)) errors.push(`COUNCIL_ORCA must be auto, on or off (got "${cfg.orca.mode}")`)
  if (!['orca', 'headless'].includes(cfg.orca.implement)) errors.push(`COUNCIL_ORCA_IMPLEMENT must be orca or headless (got "${cfg.orca.implement}")`)
  if (!['new-child', 'new-top-level'].includes(cfg.orca.worktree)) errors.push(`COUNCIL_ORCA_WORKTREE must be new-child or new-top-level`)
  for (const k of ['timeoutMs', 'implTimeoutMs', 'testTimeoutMs', 'gateTimeoutMs']) if (!(cfg[k] > 0)) errors.push(`${k} must be > 0`)
  return errors
}

// What goes into run.json: the complete non-secret effective configuration (no env dump, no binaries' paths).
export function publicConfig(cfg) {
  return {
    version: cfg.version, dryRun: cfg.dryRun, members: cfg.members, implementer: cfg.implementer, judge: cfg.judge,
    rounds: cfg.rounds, timeoutMs: cfg.timeoutMs, implTimeoutMs: cfg.implTimeoutMs, testTimeoutMs: cfg.testTimeoutMs,
    gateTimeoutMs: cfg.gateTimeoutMs, testCmd: cfg.testCmd, baseBranch: cfg.baseBranch, models: cfg.models,
    modelsExplicit: cfg.modelsExplicit, efforts: cfg.efforts, fxProvider: cfg.fxProvider, fxKeyEnv: cfg.fxKeyEnv,
    orca: { mode: cfg.orca.mode, implement: cfg.orca.implement, worktree: cfg.orca.worktree }
  }
}

// Resume: the run's saved configuration wins over the current environment; only explicit flags override it.
// flags: the CLI values the user actually passed this time.
export function restoreConfig(cfg, saved, flags = {}) {
  if (!saved) return cfg
  const out = { ...cfg, models: { ...cfg.models }, efforts: { ...cfg.efforts }, orca: { ...cfg.orca } }
  for (const k of ['members', 'implementer', 'judge', 'rounds', 'timeoutMs', 'implTimeoutMs', 'testTimeoutMs', 'gateTimeoutMs', 'testCmd', 'baseBranch', 'fxProvider', 'fxKeyEnv']) {
    if (saved[k] !== undefined) out[k] = saved[k]
  }
  if (saved.models) Object.assign(out.models, saved.models)
  if (saved.modelsExplicit) out.modelsExplicit = { ...saved.modelsExplicit }
  if (saved.efforts) Object.assign(out.efforts, saved.efforts)
  if (saved.orca) for (const k of ['mode', 'implement', 'worktree']) if (saved.orca[k]) out.orca[k] = saved.orca[k]
  const list = (v) => String(v).split(',').map(x => x.trim()).filter(Boolean)
  if (flags.members != null) out.members = list(flags.members)
  if (flags.implementer != null) out.implementer = flags.implementer
  if (flags.judge != null) out.judge = flags.judge
  if (flags.rounds != null) out.rounds = Number(flags.rounds)
  if (flags.testCmd != null) out.testCmd = flags.testCmd
  if (flags.baseBranch != null) out.baseBranch = flags.baseBranch
  return out
}

// env.mjs: the one place that decides which environment each child process gets.
//
// Rule: a secret-looking variable (…_KEY, …_TOKEN, …_SECRET, …PASSWORD, …) reaches a child only when that kind of
// child needs it: the Lyber key only fx, Anthropic credentials only claude, OpenAI/Codex credentials only codex,
// GitHub tokens only gh and the approved push. Git commands never inherit repository-selection overrides
// (GIT_DIR, GIT_INDEX_FILE, ...), and no child inherits a Claude Code host session's markers.

export const SECRET_NAME = /(?:_KEY|_TOKEN|_SECRET|PASSWORD|_PASS|_PAT|APIKEY|_CREDENTIALS?|_COOKIE)$/i

// Env-var names a Claude Code host session sets for its own children. A nested `claude -p` must not believe it is
// that session (or inherit its messaging token).
export const CLAUDE_HOST_ENV = ['CLAUDECODE', 'CLAUDE_CODE_ENTRYPOINT', 'CLAUDE_CODE_SESSION_ID', 'CLAUDE_CODE_CHILD_SESSION',
  'CLAUDE_CODE_CHILD_NOTES_DIR', 'CLAUDE_CODE_EXECPATH', 'CLAUDE_CODE_HOST_SESSION_ID', 'CLAUDE_CODE_SSE_PORT',
  'CLAUDE_CODE_MESSAGING_SOCKET', 'CLAUDE_CODE_MESSAGING_TOKEN', 'CLAUDE_CODE_SESSION_ATTENDED', 'CLAUDE_PID', 'CLAUDE_EFFORT']

const GIT_REPO_VARS = /^GIT_(DIR|WORK_TREE|INDEX_FILE|OBJECT_DIRECTORY|ALTERNATE_OBJECT_DIRECTORIES|COMMON_DIR|NAMESPACE|CEILING_DIRECTORIES|DISCOVERY_ACROSS_FILESYSTEM|PREFIX|QUARANTINE_PATH|CONFIG|CONFIG_PARAMETERS|CONFIG_COUNT|CONFIG_KEY_\d+|CONFIG_VALUE_\d+|CONFIG_GLOBAL|CONFIG_SYSTEM|CONFIG_NOSYSTEM|EXEC_PATH|SSH_COMMAND|ASKPASS)$/

// Credentials whose names do not look secret: Orca's remote-access pairing code only goes to orca.
const ORCA_CREDENTIALS = /^ORCA_(PAIRING_CODE|ENVIRONMENT)$/
// The runner's own test command is never passed down (it may embed anything the user typed).
const RUNNER_ONLY = new Set(['COUNCIL_TEST_CMD'])
// gh must use the repository council-flow passes with --repo, not one selected by the caller's environment (no child needs these).
const GH_REPO_VARS = new Set(['GH_REPO', 'GH_HOST'])
const GH_TOKENS = [/^(GH|GITHUB)_(ENTERPRISE_)?TOKEN$/]
const ALLOWED_SECRETS = {
  claude: [/^ANTHROPIC_/, /^CLAUDE_CODE_OAUTH_TOKEN$/],
  codex: [/^OPENAI_/, /^CODEX_/],
  fx: [],                     // only cfg.fxKeyEnv, added below
  gh: GH_TOKENS,
  push: GH_TOKENS,            // `gh auth git-credential` may be the credential helper
  orca: [/^ORCA_/],
  git: [], test: [], plain: []
}
export const KINDS = Object.keys(ALLOWED_SECRETS)

// kind: claude | codex | fx | gh | push | orca | git | test | plain
// opts.fxKeyEnv: the variable fx reads its key from. opts.dryRun: no real credential reaches any child; the fake
// fx gets COUNCIL_FAKE_SECRET (a test sentinel) under fxKeyEnv instead, and only when it is set.
export function envFor(kind, base = process.env, { fxKeyEnv = 'LYBER_API_KEY', dryRun = false, set = {} } = {}) {
  if (!ALLOWED_SECRETS[kind]) throw new Error(`unknown env kind ${kind}`)
  const env = {}
  for (const [k, v] of Object.entries(base)) {
    if (v == null || CLAUDE_HOST_ENV.includes(k) || RUNNER_ONLY.has(k)) continue
    if (ORCA_CREDENTIALS.test(k) && (kind !== 'orca' || dryRun)) continue
    if (GH_REPO_VARS.has(k)) continue
    const secret = SECRET_NAME.test(k) || k === fxKeyEnv
    if (secret) {
      if (dryRun) continue
      if (k === fxKeyEnv ? kind !== 'fx' : !ALLOWED_SECRETS[kind].some(re => re.test(k))) continue
    }
    if (GIT_REPO_VARS.test(k)) continue                       // no child gets git repo/config overrides (e.g. an extraHeader)
    env[k] = v
  }
  if (dryRun && kind === 'fx' && base.COUNCIL_FAKE_SECRET) env[fxKeyEnv] = base.COUNCIL_FAKE_SECRET
  if (kind === 'push' || kind === 'git') env.GIT_TERMINAL_PROMPT = '0'
  for (const [k, v] of Object.entries(set)) if (v == null) delete env[k]; else env[k] = String(v)
  return env
}

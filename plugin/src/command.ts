// command.ts: builds the one council-flow command line the plugin ever sends to an Orca terminal.
//
// Pure: no Orca, no Node imports and no environment, so the panel (live preview), the worker (the
// real thing) and council-flow's own test suite (test/plugin.test.mjs) all run this same code.
//
// Safety rules enforced here (and tested):
// - The line never contains a control character. A newline or carriage return would be type-ahead
//   that council-flow's terminal gate could read as an answer, so free text is folded to one line
//   and anything else is refused. The plugin never types into a gate.
// - Every user value is a single shell word (POSIX single quotes), and free text comes after `--`,
//   so a scope or task can never become an option, an environment assignment or a second command.
// - Only a fixed set of council-flow flags is produced. `--target` is passed through for the CLI
//   to validate (it refuses non-local targets before any model call); the pre-check below only
//   refuses earlier, it never widens what council-flow accepts.

export type Mode = 'audit' | 'code'
export type Implementer = '' | 'codex' | 'claude'

export type AuditForm = {
  scope: string
  target?: string
  testTarget?: string
  rounds?: string
  dryRun?: boolean
  refreshContext?: boolean
}

export type CodeForm = {
  task: string
  implementer?: Implementer
  rounds?: string
  dryRun?: boolean
}

export type ResumeForm = {
  mode: Mode
  runId: string
  dryRun: boolean
  refreshContext?: boolean
}

export type Built = { argv: string[]; line: string; runId: string | null }
export type BuildResult = ({ ok: true } & Built) | { ok: false; error: string }

/** Longest scope or task accepted on the command line. Longer text belongs in a file (`--task-file`). */
export const MAX_TEXT = 4000
export const MAX_ROUNDS = 5

const CONTROL = /[\u0000-\u001f\u007f\u0085\u2028\u2029]/
const FOLDABLE = / *[\t\n\v\f\r\u0085\u2028\u2029][\t\n\v\f\r\u0085\u2028\u2029 ]*/g

class FormError extends Error {}

/** Folds each run of line breaks and tabs (with the spaces around it) to one space; refuses any other control character. */
export function oneLine(raw: unknown, what: string): string {
  if (typeof raw !== 'string') throw new FormError(`${what} must be text`)
  const text = raw.replace(FOLDABLE, ' ').trim()
  if (CONTROL.test(text)) throw new FormError(`${what} contains control characters`)
  return text
}

function requiredText(raw: unknown, what: string): string {
  const text = oneLine(raw, what)
  if (!text) throw new FormError(`${what} is required`)
  if (text.length > MAX_TEXT) throw new FormError(`${what} is longer than ${MAX_TEXT} characters; use council-flow --task-file in a terminal`)
  return text
}

/** POSIX shell quoting: plain words stay as they are, everything else is one single-quoted word. */
export function shellQuote(word: string): string {
  if (word !== '' && /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(word)) return word
  return `'${word.replace(/'/g, `'\\''`)}'`
}

/** An absolute path on the Orca host, one line, no `..` segments. Existence is checked by the worker. */
export function checkAbsolutePath(raw: unknown, what: string): string {
  const p = oneLine(raw, what)
  if (!p) throw new FormError(`${what} is required`)
  if (!p.startsWith('/')) throw new FormError(`${what} must be an absolute path`)
  if (p.split('/').includes('..')) throw new FormError(`${what} must not contain ".."`)
  return p.length > 1 ? p.replace(/\/+$/, '') : p
}

// Same shapes as council-flow's src/audit/target.mjs. The CLI stays the authority: this only
// refuses earlier, with the same wording, and is never more permissive for anything host-like.
const LOOPBACK = /^(?:(https?):\/\/)?(localhost|127(?:\.\d{1,3}){3}|\[::1\]):(\d{1,5})\/?$/i
const HOSTLIKE = /^(?:localhost|\d[\d.]*|0x[\da-f]+|(?:\d+\.){4}.+)$/i

export type TargetCheck =
  | { ok: true; kind: 'repo' }
  | { ok: true; kind: 'loopback'; host: string; port: number }
  | { ok: true; kind: 'path'; path: string }
  | { ok: false; error: string }

/** Pre-check of an audit `--target`: blank (the whole repo), a repository path, or a loopback host with a port. */
export function precheckTarget(raw: unknown): TargetCheck {
  if (raw === undefined || raw === null || raw === '') return { ok: true, kind: 'repo' }
  if (typeof raw !== 'string' || CONTROL.test(raw) || raw.includes('\\') || raw !== raw.trim() || raw.startsWith('//')) {
    return { ok: false, error: 'invalid audit target' }
  }
  if (raw.includes(':')) {
    const m = LOOPBACK.exec(raw)
    const port = m ? Number(m[3]) : 0
    const octetsOk = !m || !m[2].startsWith('127') || m[2].split('.').every((o) => Number(o) <= 255 && String(Number(o)) === o)
    if (!m || port < 1 || port > 65535 || !octetsOk) {
      return { ok: false, error: 'audit requires a loopback host (localhost, 127.x.x.x or [::1]) and an explicit port; council-flow audits local code only' }
    }
    return { ok: true, kind: 'loopback', host: m[2].toLowerCase(), port }
  }
  if (HOSTLIKE.test(raw)) return { ok: false, error: 'audit requires a loopback host with port' }
  if (raw.startsWith('/')) return { ok: false, error: 'give the target as a path relative to the repository' }
  if (raw.split('/').some((part) => ['..', '.git', '.council-flow'].includes(part))) return { ok: false, error: 'invalid audit repository path' }
  return { ok: true, kind: 'path', path: raw }
}

/** `--test-target`: a repository path only (never a host). */
export function precheckTestTarget(raw: unknown): TargetCheck {
  if (raw === undefined || raw === null || raw === '') return { ok: true, kind: 'repo' }
  if (typeof raw === 'string' && raw.includes(':')) return { ok: false, error: 'test target must be a repository path' }
  const t = precheckTarget(raw)
  return t.ok && t.kind !== 'path' ? { ok: false, error: 'test target must be a repository path' } : t
}

function rounds(raw: unknown): string | null {
  if (raw === undefined || raw === null || raw === '') return null
  const s = String(raw).trim()
  if (!/^\d+$/.test(s) || Number(s) > MAX_ROUNDS) throw new FormError(`rounds must be a whole number from 0 to ${MAX_ROUNDS}`)
  return String(Number(s))
}

// Same rule as council-flow's validRunId (src/artifacts.mjs).
export function validRunId(id: unknown): id is string {
  return typeof id === 'string' && /^[a-z0-9][a-z0-9._-]{0,79}$/i.test(id) && !id.includes('..') &&
    !id.endsWith('.lock') && !id.endsWith('.') && id !== 'worktrees'
}

/** council-flow's run id shape: local timestamp plus randomness, never task text. */
export function newRunId(now: Date = new Date(), random: () => Uint8Array = () => globalThis.crypto.getRandomValues(new Uint8Array(4))): string {
  const p = (n: number) => String(n).padStart(2, '0')
  const hex = [...random()].slice(0, 4).map((b) => b.toString(16).padStart(2, '0')).join('')
  return `${now.getFullYear()}${p(now.getMonth() + 1)}${p(now.getDate())}-${p(now.getHours())}${p(now.getMinutes())}${p(now.getSeconds())}-${hex}`
}

function finish(argv: string[], runId: string | null): BuildResult {
  const line = argv.map(shellQuote).join(' ')
  // Belt and braces: whatever happened above, nothing that could act as Enter reaches a terminal.
  if (CONTROL.test(line)) return { ok: false, error: 'refusing a command line with control characters' }
  return { ok: true, argv, line, runId }
}

function guard(build: () => BuildResult): BuildResult {
  try {
    return build()
  } catch (e) {
    if (e instanceof FormError) return { ok: false, error: e.message }
    throw e
  }
}

const base = (cli: string) => ['node', checkAbsolutePath(cli, 'council-flow path')]

/** `node <cli> audit --repo <repo> [--target …] [--test-target …] [--rounds N] [--refresh-context] [--dry-run] --run-id <id> -- <scope>` */
export function buildAudit(cli: string, repo: string, form: AuditForm, runId: string): BuildResult {
  return guard(() => {
    const argv = [...base(cli), 'audit', '--repo', checkAbsolutePath(repo, 'repository')]
    const target = precheckTarget(form.target)
    if (!target.ok) throw new FormError(`invalid --target: ${target.error}`)
    if (target.kind !== 'repo') argv.push('--target', String(form.target))
    const testTarget = precheckTestTarget(form.testTarget)
    if (!testTarget.ok) throw new FormError(`invalid --test-target: ${testTarget.error}`)
    if (testTarget.kind !== 'repo') argv.push('--test-target', String(form.testTarget))
    const r = rounds(form.rounds)
    if (r !== null) argv.push('--rounds', r)
    if (form.refreshContext) argv.push('--refresh-context')
    if (form.dryRun) argv.push('--dry-run')
    if (!validRunId(runId)) throw new FormError('invalid run id')
    argv.push('--run-id', runId, '--', requiredText(form.scope, 'scope'))
    return finish(argv, runId)
  })
}

/** `node <cli> run --repo <repo> [--implementer codex|claude] [--rounds N] [--dry-run] --run-id <id> -- <task>` */
export function buildCode(cli: string, repo: string, form: CodeForm, runId: string): BuildResult {
  return guard(() => {
    const argv = [...base(cli), 'run', '--repo', checkAbsolutePath(repo, 'repository')]
    const impl = form.implementer ?? ''
    if (!['', 'codex', 'claude'].includes(impl)) throw new FormError('implementer must be codex or claude')
    if (impl) argv.push('--implementer', impl)
    const r = rounds(form.rounds)
    if (r !== null) argv.push('--rounds', r)
    if (form.dryRun) argv.push('--dry-run')
    if (!validRunId(runId)) throw new FormError('invalid run id')
    argv.push('--run-id', runId, '--', requiredText(form.task, 'task'))
    return finish(argv, runId)
  })
}

/**
 * Resume with the run's own subcommand and dry-run setting (council-flow refuses anything else):
 * `node <cli> audit --repo <repo> --resume <id> [--refresh-context] [--dry-run]` or
 * `node <cli> --resume <id> --repo <repo> [--dry-run]`.
 */
export function buildResume(cli: string, repo: string, form: ResumeForm): BuildResult {
  return guard(() => {
    if (!validRunId(form.runId)) throw new FormError('invalid run id')
    const repoPath = checkAbsolutePath(repo, 'repository')
    let argv: string[]
    if (form.mode === 'audit') {
      argv = [...base(cli), 'audit', '--repo', repoPath, '--resume', form.runId]
      if (form.refreshContext) argv.push('--refresh-context')
    } else if (form.mode === 'code') {
      if (form.refreshContext) throw new FormError('--refresh-context is for audit runs')
      argv = [...base(cli), '--resume', form.runId, '--repo', repoPath]
    } else throw new FormError('unknown run mode')
    if (form.dryRun) argv.push('--dry-run')
    return finish(argv, form.runId)
  })
}

/** `node <cli> doctor --repo <repo>`: checks members and Orca without any model call. */
export function buildDoctor(cli: string, repo: string): BuildResult {
  return guard(() => finish([...base(cli), 'doctor', '--repo', checkAbsolutePath(repo, 'repository')], null))
}

/** Title of the Orca terminal a run is started in. */
export function terminalTitle(kind: Mode | 'resume' | 'doctor', runId: string | null): string {
  const label = kind === 'audit' ? 'council-flow audit' : kind === 'code' ? 'council-flow' : kind === 'resume' ? 'council-flow resume' : 'council-flow doctor'
  return runId ? `${label} ${runId}` : label
}

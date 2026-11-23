// common.mjs: what every stage does with a member call: usage, degraded-mode bookkeeping, logs, JSON retry,
// worktree verification and the codex sandbox capability.
import { render } from '../prompts.mjs'
import { cap, verifyWorktree } from '../repo.mjs'

export class StageError extends Error {}

export const isAvailable = (ctx, id) => ctx.cfg.members.includes(id) && ctx.store.member(id).status === 'ok'
export const availableMembers = (ctx, ids = ctx.cfg.members) => ids.filter(id => isAvailable(ctx, id))

// Codex whose bubblewrap sandbox cannot start can still answer from the prompt (diff + excerpts inlined, empty cwd),
// but it must never write: it is not an implementer, and council-flow never falls back to danger-full-access.
export const sandboxBroken = (ctx, id) => id === 'codex' && ctx.store.member('codex').sandbox === 'broken'
export const promptOnly = (ctx, id) => id === 'fx' || sandboxBroken(ctx, id)
export const canImplement = (ctx, id) => isAvailable(ctx, id) && !sandboxBroken(ctx, id)

export function markSandboxBroken(ctx, reason) {
  if (sandboxBroken(ctx, 'codex')) return
  Object.assign(ctx.store.member('codex'), { sandbox: 'broken', sandboxReason: reason })
  ctx.store.warn(`codex sandbox unavailable (${reason}): codex reviews from the prompt only and cannot implement; see README "Codex sandbox"`)
}

// Runs one member. A timeout or a usage limit takes the member out for the rest of the run (degraded mode).
// Logs are NOT written here: parallel stages write them after every member finished, so a member can't read
// another's output from disk mid-stage.
export async function callMember(ctx, id, { role, prompt, cwd, timeoutMs, name }) {
  const r = await ctx.engines[id].run({ role, prompt, cwd, timeoutMs: timeoutMs || ctx.cfg.timeoutMs })
  ctx.store.addUsage(id, r.usage)
  if (r.sandboxBroken) markSandboxBroken(ctx, `bwrap failed during ${role}`)
  if (r.timedOut) markUnavailable(ctx, id, `timed out during ${role}`)
  else if (r.limitHit) markUnavailable(ctx, id, `usage or rate limit during ${role}`)
  const tokens = r.usage ? `, ${r.usage.inputTokens} in / ${r.usage.outputTokens} out tokens` : ''
  ctx.log(`${name}: ${r.ok ? 'ok' : 'FAILED'} (${(r.durationMs / 1000).toFixed(1)}s${tokens})${r.ok ? '' : ` - ${r.error}`}`)
  ctx.store.save()
  return r
}

export function markUnavailable(ctx, id, reason) {
  ctx.store.setMember(id, 'unavailable', reason)
  ctx.store.warn(`${id} unavailable: ${reason}`)
}

export function writeCallLogs(ctx, name, r, opts) {
  ctx.store.writeJson(`logs/${name}.argv.json`, r.argv)
  ctx.store.writeLogs(name, r, opts)
}

// Parse a reply; on failure ask the same member once to reformat its own reply (cheap: no tools, no repo).
export async function parseWithRetry(ctx, id, first, { parse, shape, name }) {
  const p = parse(first.text)
  if (p.ok) return { ...p, nudged: false }
  if (!first.text.trim() || !isAvailable(ctx, id)) return { ok: false, error: p.error, nudged: false }
  const prompt = render('json-nudge', { shape, previous: cap(first.text, 20000) })
  const r = await callMember(ctx, id, { role: 'nudge', prompt, cwd: ctx.scratch.empty(`${name}-nudge`), name: `${name}-nudge` })
  writeCallLogs(ctx, `${name}-nudge`, r)
  if (!r.ok) return { ok: false, error: `${p.error}; the JSON retry failed: ${r.error}`, nudged: true }
  const p2 = parse(r.text)
  return p2.ok ? { ...p2, nudged: true } : { ok: false, error: `${p2.error} (after one JSON retry)`, nudged: true }
}

// Before every agent call, staging, reset, test or publish: the recorded worktree must still be this run's own
// linked worktree (see repo.verifyWorktree). Returns the verified worktree record.
export async function ensureWorktree(ctx) {
  const wt = ctx.store.state.worktree
  if (!wt || !wt.path) throw new StageError('no worktree recorded for this run')
  try {
    await verifyWorktree(ctx.repoRoot, wt.path, { branch: wt.branch || null, expectPath: wt.mode === 'git' ? ctx.store.path('worktree') : null })
  } catch (e) { throw new StageError(`worktree check failed: ${e.message}`) }
  return wt
}

// Configured model ids are redacted from judge input too (they may not contain a family word).
export const modelTerms = (cfg) => Object.values(cfg.models).filter(Boolean)

export function formatFindings(findings) {
  if (!findings.length) return '(none)'
  return findings.map((f, i) => `${i + 1}. [${f.severity.toUpperCase()}][${f.category}] ${f.file || '(no file)'}${f.line ? `:${f.line}` : ''}: ${f.issue}${f.suggestion ? `\n   Suggestion: ${f.suggestion}` : ''}`).join('\n')
}

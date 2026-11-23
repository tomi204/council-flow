// Audit calls keep a scrubbed diagnostic before any report validation or worktree rollback.
import { lastJsonBlock } from '../json.mjs'
import { render } from '../prompts.mjs'
import { cap } from '../repo.mjs'
import { scrubAudit, scrubSecrets } from '../redact.mjs'
import { isAvailable, callMember } from '../stages/common.mjs'
import { invalid, redFindings, ReplyError } from './findings.mjs'

export class MemberFailure extends Error {}

function outputValue(text) {
  if (typeof text !== 'string' || text.length > 120000) invalid('reply', 'expected text up to 120000 characters')
  const value = lastJsonBlock(text)
  if (value === undefined) invalid('reply', 'no complete final JSON object or array')
  return value
}

function redText(text) {
  try {
    const rows = redFindings(JSON.stringify(outputValue(text)))
    for (const row of rows) if (!/^[\w./-]+$/.test(row.file)) row.file = '[path omitted]'
    return JSON.stringify(rows, null, 2)
  } catch (e) { return '[Red response withheld: ' + e.message + ']' }
}

function scrubEvent(value, env) {
  if (typeof value === 'string') return scrubAudit(value, env)
  if (Array.isArray(value)) return value.map(v => scrubEvent(v, env))
  if (!value || typeof value !== 'object') return value
  // File reads and tool arguments may include arbitrary configuration values.
  if (value.role === 'tool' || ['tool_use', 'tool_result', 'command_execution', 'thinking', 'reasoning', 'mcp_tool_call'].includes(value.type)) return { type: value.type, content: '[omitted]' }
  return Object.fromEntries(Object.entries(value).map(([k, v]) => {
    const counter = /tokens$/i.test(k) && Number.isSafeInteger(v)
    const sensitive = /secret|passw(?:or)?d|credential|api[_-]?key|authorization|cookie|private[_-]?key|token|tool_calls|tool_use_result|tool_response/i.test(k)
    return [scrubAudit(k, env), sensitive && !counter ? '[REDACTED]' : scrubEvent(v, env)]
  }))
}

function stdoutLog(r, id, env) {
  if (id === 'fx') {
    // fx.output and reasoning may repeat unfiltered material even when final_output is safe.
    try {
      const raw = JSON.parse(r.stdout)
      const final = redText(r.text)
      const usage = Object.fromEntries(['input_tokens', 'output_tokens'].filter(k => Number.isSafeInteger(raw.usage?.[k])).map(k => [k, raw.usage[k]]))
      return [{ kind: 'ask', exit_code: Number.isInteger(raw.exit_code) ? raw.exit_code : r.exitCode, usage,
        output: raw.output === r.text ? final : '[intermediate output omitted]', final_output: final }]
    } catch { return [redText(r.text)] }
  }
  const records = [], raw = []
  function flushRaw() {
    if (raw.length) {
      const block = raw.join('\n')
      records.push(/tool_use|tool_result|tool_response/.test(block) ? '[malformed tool event omitted]' : scrubAudit(block, env))
      raw.length = 0
    }
  }
  for (const line of (r.stdout || '').split('\n')) {
    let event
    try { event = JSON.parse(line) }
    catch { raw.push(line); continue }
    flushRaw()
    records.push(scrubEvent(event, env))
  }
  flushRaw()
  return records
}

function logName(store, name) {
  let chosen = name
  for (let n = 2; store.exists(`logs/${chosen}.argv.json`); n++) chosen = name + '-attempt-' + n
  return chosen
}

export async function auditCall(ctx, id, role, prompt, name, cwd = ctx.scratch.empty(name)) {
  if (!isAvailable(ctx, id)) throw new MemberFailure(`${id} unavailable for ${role}`)
  const stdin = scrubSecrets(prompt, { env: ctx.env, mode: 'code' })
  const r = await callMember(ctx, id, { role, prompt: stdin, cwd, name, timeoutMs: role === 'audit-patch' ? ctx.cfg.implTimeoutMs : ctx.cfg.timeoutMs })
  ctx.store.writeJson(`logs/${name}.argv.json`, r.argv)
  ctx.store.writeAuditStream(name, stdoutLog(r, id, ctx.env))
  ctx.store.write(`logs/${name}.final.txt`, id === 'fx' ? redText(r.text) : scrubAudit(r.text || '', ctx.env))
  if (id !== 'fx' && r.stderr) ctx.store.write(`logs/${name}.stderr.txt`, scrubAudit(r.stderr, ctx.env))
  if (!r.ok) throw new MemberFailure(`${id} ${role} failed (exit ${r.exitCode}). See logs/${name}.stdout.txt`)
  return r.text
}

function countReported(value) {
  if (Array.isArray(value)) return { rows: value.length }
  return Object.fromEntries(['findings', 'fixes', 'patches', 'concerns']
    .filter(k => Array.isArray(value?.[k])).map(k => [k, value[k].length]))
}

// Only the first call can edit. The JSON nudge runs in empty scratch and can
// correct the report about the existing candidate, including path claims.
export async function auditJson(ctx, { id, role, prompt, name, cwd, shape }, validate) {
  const first = logName(ctx.store, name)
  let previous, reason, counts = {}
  for (const retry of [false, true]) {
    const attempt = retry ? first + '-nudge' : first
    const instructions = retry ? render('json-nudge', { shape: `${shape}\nValidation error: ${reason}\nPreserve all observations and patch claims. If evidence is missing, return an error object. Never invent or discard findings.`, previous }) : prompt
    let text
    try { text = await auditCall(ctx, id, retry ? 'nudge' : role, instructions, attempt, retry ? undefined : cwd) }
    catch (e) {
      if (retry && e instanceof MemberFailure) throw new MemberFailure(`${id} ${role}: ${reason}; JSON retry failed: ${e.message}`)
      throw e
    }
    try {
      const value = outputValue(text)
      const next = countReported(value)
      if (retry && Object.entries(counts).some(([k, n]) => (next[k] || 0) < n)) invalid('reply', 'JSON repair discarded entries from the first report')
      counts = next
      return await validate(value)
    } catch (e) {
      if (!(e instanceof ReplyError)) throw e
      reason = e.message
      ctx.store.writeJson(`logs/${attempt}.validation.json`, { member: id, role, error: reason })
      if (retry) throw new MemberFailure(`${id} ${role}: ${reason} after one JSON retry (logs/${attempt}.validation.json)`)
      previous = id === 'fx' ? redText(text) + '\nOriginal review evidence:\n' + prompt : cap(scrubAudit(text, ctx.env), 20000)
      ctx.log(`${id} ${role}: ${reason}; requesting one JSON repair`)
    }
  }
}

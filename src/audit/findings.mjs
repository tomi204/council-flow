import path from 'node:path'

export const severities = ['low', 'medium', 'high', 'critical']
const statuses = ['open', 'confirmed', 'rejected', 'fixed', 'reopened']
export const patchable = f => ['confirmed', 'reopened'].includes(f.status)
export const unresolved = f => f.status === 'open' || patchable(f)
export const repoFile = f => typeof f === 'string' && f.length <= 512 && !path.isAbsolute(f) && !/[\x00-\x1f\\]/.test(f) && !f.split('/').some(p => ['', '.', '..', '.git', '.council-flow'].includes(p))
const plain = s => typeof s === 'string' && s.trim() && s.length <= 3000 && !/[\r\n`]/.test(s)
export class ReplyError extends Error {}
export function invalid(field, reason) { throw new ReplyError(`invalid ${field}: ${reason}`) }
export function parseReply(text) {
  if (typeof text !== 'string' || text.length > 120000) invalid('reply', 'expected JSON text up to 120000 characters')
  try { return JSON.parse(text) } catch { invalid('reply', 'expected a complete JSON object or array') }
}

// Red supplies English prose. Reject the whole reply without logging its contents.
// Restrict the alphabet first, then catch command-like and procedural text that also
// fits that alphabet. Blue's code and test reports use a separate parser.
export function reportProse(s) {
  if (!plain(s)) return false
  const text = s.normalize('NFKC').replaceAll('[REDACTED]', 'redacted')
  if (!/^[\p{L}\p{N} .,:'’()_-]+$/u.test(text)) return false
  const instructions = [
    /\b(?:step\s*(?:\d+|one|two)|(?:first|next|finally)[,:]|first\b.*\b(?:next|then|finally)|\d+[.)]\s+\w)/i,
    /\b(?:payload|exploit|poc|command|request|input)\s*:/i,
    /\b(?:curl|wget|bash|sh|python3?|node|powershell)\s+(?:-|\.\/|\w+\.\w+)/i,
    /(?:^|\s)--?[a-z]\w*\b/i,
    /\b(?:select\s+\d+|sudo\s+\w+|[a-f0-9]{48,}|[A-Za-z0-9_]{80,})\b/i,
    /\b(?:to reproduce|steps to reproduce|proof of concept|paste the following)\b/i,
    /(?:^|:\s*|\bthen\s+)(?:echo|printf|cat|ls|touch|chmod|whoami)\b/i,
    /\b(?:select\b.+\bfrom|union\s+select|insert\s+into|drop\s+table|import\s+\w+\s+from)\b/i,
    /\b[\w.]+\([^)]*\)|(?:--\w|\.\.\/)/,
    /(?:^|[.!:]\s*|\bthen\s+)(?:send|submit|execute|run|craft|inject|invoke|navigate|visit|type|paste|upload)\b/i,
    /\b(?:GET|POST|PUT|DELETE|PATCH)\s+(?:https?|localhost|the following)\b/i
  ]
  return !instructions.some(pattern => pattern.test(text))
}

export function redFindings(text, recordDropped = () => {}) {
  const rows = parseReply(text)
  if (!Array.isArray(rows) || rows.length > 80) invalid('findings', 'expected an array with at most 80 entries')
  const seen = new Set()
  const prose = ['title', 'why_exploitable', 'impact', 'fix_hint']
  return rows.map((f, i) => {
    const field = `findings[${i}]`
    if (!f || typeof f !== 'object' || Array.isArray(f)) invalid(field, 'expected an object')
    for (const k of Object.keys(f)) {
      if (/poc|payload|exploit/i.test(k) && k !== 'why_exploitable') { recordDropped(); delete f[k] }
      else if (!['id', 'severity', 'cwe', 'file', 'line', 'status', ...prose].includes(k)) invalid(/^[a-z_][a-z0-9_]{0,35}$/i.test(k) ? field + '.' + k : field, 'unexpected field outside the finding schema')
    }
    if (typeof f.id !== 'string' || !/^[a-z0-9][a-z0-9_-]{0,63}$/i.test(f.id) || seen.has(f.id)) invalid(field + '.id', 'expected a unique 1–64 character finding ID')
    if (!severities.includes(f.severity)) invalid(field + '.severity', 'expected low, medium, high or critical')
    if (!statuses.includes(f.status)) invalid(field + '.status', 'unknown or missing finding status')
    if (!repoFile(f.file)) invalid(field + '.file', 'expected a repository-relative path')
    if (!Number.isSafeInteger(f.line) || f.line < 1) invalid(field + '.line', 'expected a positive integer')
    for (const k of prose) if (!reportProse(f[k])) invalid(field + '.' + k, 'expected short plain English without code, commands or procedures')
    if ('cwe' in f && !(typeof f.cwe === 'string' && /^CWE-\d+$/.test(f.cwe))) invalid(field + '.cwe', 'omit if unknown or use CWE-number')
    seen.add(f.id)
    return f
  })
}

// Require one justified decision per expected ID, even when a model omits a finding on re-review.
function decisions(field, rows, expected, allowed) {
  if (!Array.isArray(rows) || rows.length !== expected.length) invalid(field, 'expected exactly one decision per supplied ID')
  return expected.map(({ id }) => {
    const row = rows.find(v => v?.id === id)
    if (!row) invalid(field, 'missing decision for ' + id)
    if (!allowed.includes(row.decision)) invalid(field + '.' + id + '.decision', 'expected ' + allowed.join(' or '))
    if (!plain(row.justification)) invalid(field + '.' + id + '.justification', 'expected one nonempty line of prose')
    return { id, decision: row.decision, justification: row.justification }
  })
}

export function iterationVerdict(text, findings, fixes) {
  const v = parseReply(text)
  if (!plain(v?.context_delta)) invalid('context_delta', 'expected one nonempty line of prose')
  if (!Array.isArray(v.concerns) || v.concerns.length > 80) invalid('concerns', 'expected an array of at most 80 entries')
  const concerns = v.concerns.map((c, i) => {
    if (!['regression', 'scope'].includes(c?.kind)) invalid(`concerns[${i}].kind`, 'expected regression or scope')
    if (!plain(c.reason)) invalid(`concerns[${i}].reason`, 'expected one nonempty line of prose')
    return { kind: c.kind, reason: c.reason }
  })
  return { findings: decisions('findings', v.findings, findings, ['confirmed', 'false-positive', 'needs-info']),
    patches: decisions('patches', v.patches, fixes, ['verified', 'rejected']), concerns, context_delta: v.context_delta }
}

export function blueReport(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value) || !('findings' in value || 'fixes' in value)) {
    invalid('Blue report', 'expected an object containing findings or fixes; use {"findings":[],"fixes":[]} for no changes')
  }
  const { findings = [], fixes = [] } = value
  if (!Array.isArray(findings)) invalid('findings', 'expected an array')
  if (!Array.isArray(fixes)) invalid('fixes', 'expected an array')
  for (const f of findings) {
    if (!f || typeof f !== 'object' || Array.isArray(f)) continue
    if (f.status === undefined) f.status = 'open'
    if (f.cwe === null) delete f.cwe
    for (const key of ['title', 'why_exploitable', 'impact', 'fix_hint']) {
      if (typeof f[key] === 'string') f[key] = f[key].replace(/`([A-Za-z_][\w.-]*)`/g, '$1')
    }
  }
  return { findings, fixes }
}

export function patchReport(fixes, findings, changed) {
  const ids = new Set()
  return { fixes: fixes.map((fix, i) => {
    const field = `fixes[${i}]`
    if (!fix || ids.has(fix.id) || !findings.some(f => f.id === fix.id)) invalid(field + '.id', 'expected a unique confirmed or newly reported finding ID')
    for (const k of ['file', 'test']) {
      if (!repoFile(fix[k]) || !changed.includes(fix[k])) invalid(field + '.' + k, 'expected a changed repository-relative file')
    }
    if (fix.file === fix.test) invalid(field + '.test', 'must differ from the production file')
    ids.add(fix.id)
    return { id: fix.id, file: fix.file, test: fix.test }
  }) }
}

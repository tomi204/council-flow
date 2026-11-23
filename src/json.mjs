// json.mjs: pull the last JSON value out of a model's reply and check it against the judge / review contracts.

// End index of the balanced {...} or [...] that starts at `start`, or -1 (-2 when the work budget is spent).
// String-aware. `budget.steps` is shared by every call for one text, so bracket-heavy junk cannot make the scan
// quadratic.
function matchEnd(s, start, budget) {
  const stack = []
  let inStr = false, esc = false
  for (let j = start; j < s.length; j++) {
    if (--budget.steps < 0) return -2
    const c = s[j]
    if (inStr) {
      if (esc) esc = false
      else if (c === '\\') esc = true
      else if (c === '"') inStr = false
      continue
    }
    if (c === '"') inStr = true
    else if (c === '{' || c === '[') stack.push(c)
    else if (c === '}' || c === ']') {
      const open = stack.pop()
      if ((c === '}' && open !== '{') || (c === ']' && open !== '[')) return -1
      if (!stack.length) return j
    }
  }
  return -1
}

const kindOf = (v) => Array.isArray(v) ? 'array' : (v && typeof v === 'object') ? 'object' : typeof v

// Every top-level JSON object/array in the text that parses, in order. A block that does not parse is
// rescanned from its next character, so JSON nested inside prose brackets is still found.
export const SCAN_BUDGET = 3_000_000
export function jsonBlocks(text, budget = { steps: SCAN_BUDGET }) {
  const s = String(text ?? '').slice(-200000)
  const out = []
  let i = 0
  while (i < s.length) {
    const c = s[i]
    if (c !== '{' && c !== '[') { i++; continue }
    const end = matchEnd(s, i, budget)
    if (end === -2) break
    if (end < 0) { i++; continue }
    try { out.push(JSON.parse(s.slice(i, end + 1))); i = end + 1 } catch { i++ }
  }
  return out
}

// The last JSON value of the wanted kind ('object' | 'array' | 'any'), or undefined.
export function extractJson(text, want = 'any') {
  const blocks = jsonBlocks(text)
  for (let k = blocks.length - 1; k >= 0; k--) if (want === 'any' || kindOf(blocks[k]) === want) return blocks[k]
  return undefined
}

// For an audit, a malformed final block requires a repair. Its nested empty
// arrays must never be interpreted as a standalone clean report.
export function lastJsonBlock(text) {
  const budget = { steps: SCAN_BUDGET }
  // A labelled JSON fence can start a fresh reply after an incomplete draft.
  let start = 0
  for (const m of text.matchAll(/^[ \t]*`{3}json[ \t]*\r?\n/gim)) start = m.index + m[0].length
  let value
  for (let i = start; i < text.length; i++) {
    if (text[i] !== '{' && text[i] !== '[') continue
    if (text[i] === '[') {
      let next = i + 1
      while (next < text.length && /\s/.test(text[next])) next++
      // Bracketed labels in surrounding prose do not supersede a valid reply.
      if (!/^(?:[\[\]{"0-9-]|true|false|null)/.test(text.slice(next, next + 5))) continue
    }
    const end = matchEnd(text, i, budget)
    if (end < 0) return undefined
    try { value = JSON.parse(text.slice(i, end + 1)) } catch { value = undefined }
    i = end
  }
  return value
}

// ---------------------------------------------------------------- judge verdict
// {choice: "A"|"B"|"C"|"merge", plan, rationale}
export function parseVerdict(text, labels) {
  const blocks = jsonBlocks(text).filter(b => kindOf(b) === 'object' && 'choice' in b)
  const obj = blocks[blocks.length - 1]
  if (!obj) return { ok: false, error: 'no JSON object with a "choice" field' }
  let choice = String(obj.choice ?? '').trim()
  const m = choice.match(/^(?:plan\s+)?([A-Z])$/i)
  if (m) choice = m[1].toUpperCase()
  else if (/^merge(d)?$/i.test(choice)) choice = 'merge'
  if (choice !== 'merge' && !labels.includes(choice)) return { ok: false, error: `choice "${obj.choice}" is not one of ${[...labels, 'merge'].join(', ')}` }
  const plan = typeof obj.plan === 'string' ? obj.plan.trim() : ''
  const rationale = typeof obj.rationale === 'string' ? obj.rationale.trim() : ''
  if (choice === 'merge' && plan.length < 20) return { ok: false, error: 'choice "merge" needs the merged plan in "plan"' }
  return { ok: true, value: { choice, plan, rationale } }
}

// ---------------------------------------------------------------- review findings
export const SEVERITIES = ['blocker', 'major', 'minor']
export const CATEGORIES = ['bug', 'security', 'gap', 'test', 'style']
const SEVERITY_ALIASES = { critical: 'blocker', blocking: 'blocker', high: 'major', medium: 'minor', moderate: 'minor', low: 'minor', nit: 'minor', info: 'minor' }
const CATEGORY_ALIASES = { tests: 'test', testing: 'test', correctness: 'bug', logic: 'bug', missing: 'gap', completeness: 'gap', docs: 'style', readability: 'style', perf: 'bug', performance: 'bug' }

// Accepts a bare array (the contract) or {findings: [...]}. Every element must be a valid finding: one malformed
// element makes the whole reply invalid (so it goes through the JSON retry) instead of silently becoming "clean".
// Only an explicit [] means "no problems".
export function parseFindings(text) {
  const blocks = jsonBlocks(text)
  let arr
  for (let k = blocks.length - 1; k >= 0 && !arr; k--) {
    const b = blocks[k]
    if (Array.isArray(b) && (b.length === 0 || b.some(x => x && typeof x === 'object' && !Array.isArray(x)))) arr = b
    else if (b && typeof b === 'object' && Array.isArray(b.findings)) arr = b.findings
  }
  if (!arr) return { ok: false, error: 'no JSON findings array' }
  const findings = []
  for (let i = 0; i < arr.length; i++) {
    const r = normalizeFinding(arr[i])
    if (r.error) return { ok: false, error: `finding ${i + 1}: ${r.error}` }
    findings.push(r.value)
  }
  return { ok: true, value: findings }
}

export function normalizeFinding(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return { error: 'not an object' }
  const issue = typeof raw.issue === 'string' ? raw.issue.trim() : ''
  if (!issue) return { error: 'missing "issue"' }
  let severity = String(raw.severity ?? '').trim().toLowerCase()
  severity = SEVERITY_ALIASES[severity] || severity
  if (!SEVERITIES.includes(severity)) return { error: `unknown severity "${raw.severity}"` }
  let category = String(raw.category ?? '').trim().toLowerCase()
  category = CATEGORY_ALIASES[category] || category
  if (!CATEGORIES.includes(category)) return { error: `unknown category "${raw.category}"` }
  if (raw.file != null && typeof raw.file !== 'string') return { error: '"file" must be a string' }
  const lineNum = raw.line == null || raw.line === '' ? null : Number.parseInt(raw.line, 10)
  if (lineNum !== null && !(Number.isFinite(lineNum) && lineNum > 0)) return { error: `bad "line" ${JSON.stringify(raw.line)}` }
  return { value: {
    severity, category, file: String(raw.file ?? '').trim(), line: lineNum,
    issue: issue.slice(0, 2000), suggestion: String(raw.suggestion ?? '').trim().slice(0, 2000)
  } }
}

const RANK = { blocker: 0, major: 1, minor: 2 }
const norm = (s) => s.toLowerCase().replace(/[^a-z0-9 ]+/g, ' ').replace(/\s+/g, ' ').trim()

const words = (s) => new Set(norm(s).split(' ').filter(w => w.length > 2))
function similar(a, b) {
  if (norm(a).slice(0, 60) === norm(b).slice(0, 60)) return true
  const A = words(a), B = words(b)
  if (!A.size || !B.size) return false
  let both = 0
  for (const w of A) if (B.has(w)) both++
  return both / (A.size + B.size - both) >= 0.6
}

// Merge findings from several reviewers. Two findings merge only when they are at the same place (file, line,
// category) AND say the same thing; distinct issues on one line stay separate. reportedBy counts distinct reviewers.
// lists: [{member, findings}] (or plain arrays, numbered).
export function dedupeFindings(lists) {
  const merged = []
  lists.forEach((entry, idx) => {
    const member = Array.isArray(entry) ? `reviewer-${idx + 1}` : entry.member
    for (const f of (Array.isArray(entry) ? entry : entry.findings)) {
      const hit = merged.find(m => m.file === f.file && m.line === f.line && m.category === f.category && similar(m.issue, f.issue))
      if (hit) {
        if (RANK[f.severity] < RANK[hit.severity]) hit.severity = f.severity
        if (!hit.suggestion && f.suggestion) hit.suggestion = f.suggestion
        hit.reporters.add(member)
      } else merged.push({ ...f, reporters: new Set([member]) })
    }
  })
  return merged
    .map(({ reporters, ...f }) => ({ ...f, reportedBy: reporters.size }))
    .sort((a, b) => RANK[a.severity] - RANK[b.severity] || b.reportedBy - a.reportedBy)
}

export const isBlocking = (f) => f.severity === 'blocker' || f.severity === 'major'

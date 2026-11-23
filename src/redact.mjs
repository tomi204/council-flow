// redact.mjs: two kinds of hiding.
//   redactIdentities  removes model / vendor / tool names from member output before the blind judge sees it
//   scrubSecrets      removes secrets from anything council-flow writes to disk or prints

// ---------------------------------------------------------------- identities (judge input only)
// Vendor, product and model-family words. A trailing version or model suffix joined by - _ . (gpt-6.2-astra,
// kimi-k31-pro-abliterated, claude-opus-5-5) or a spaced version number (Claude 4, GPT 5.1) is removed with it.
export const IDENTITY_TERMS = [
  'claude code', 'claude', 'anthropic', 'opus', 'sonnet', 'haiku', 'fable',
  'chatgpt', 'openai', 'codex', 'gpt', 'o3', 'o4',
  'kimi', 'moonshot', 'deepseek', 'lyber', 'minimax', 'vercel', 'fx',
  'gemini', 'google', 'deepmind', 'llama', 'mistral', 'qwen', 'grok', 'xai'
]
// Tool names that give away which agent wrote a text.
const TOOL_TERMS = ['apply_patch', 'todowrite', 'multiedit', 'notebookedit', 'exec_command', 'update_plan', 'websearch', 'webfetch']

const esc = (s) => s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
const SUFFIX = '(?:[-_.][a-z0-9]+)*(?:\\s+v?\\d[\\w.]*)?'

function termsRegex(terms) {
  const sorted = [...new Set(terms.map(t => String(t).trim().toLowerCase()).filter(Boolean))].sort((a, b) => b.length - a.length)
  // Not inside a longer word, but `my-claude-tool` and `.codex/` still match.
  return new RegExp(`(?<![A-Za-z0-9])(?:${sorted.map(t => esc(t).replace(/ /g, '\\s+')).join('|')})${SUFFIX}(?![A-Za-z0-9])`, 'gi')
}

// extraTerms: the configured model ids (they may not contain a known family word).
export function redactIdentities(text, extraTerms = []) {
  let s = String(text ?? '')
  s = s.replace(termsRegex([...IDENTITY_TERMS, ...extraTerms]), '[model]')
  s = s.replace(termsRegex(TOOL_TERMS), '[tool]')
  return s
}

// The words that must never reach the judge (used by the runtime guard and the tests).
export function findIdentityLeaks(text, extraTerms = []) {
  const hits = String(text ?? '').match(termsRegex([...IDENTITY_TERMS, ...extraTerms])) || []
  return [...new Set(hits.map(h => h.toLowerCase()))]
}

// Fisher-Yates with an injectable random int (crypto.randomInt by default).
export function shuffle(items, randomInt) {
  const a = [...items]
  for (let i = a.length - 1; i > 0; i--) {
    const j = randomInt(i + 1);
    [a[i], a[j]] = [a[j], a[i]]
  }
  return a
}

// ---------------------------------------------------------------- secrets (everything written, sent or printed)
import { SECRET_NAME } from './env.mjs'

export function secretValues(env = process.env) {
  return Object.entries(env)
    .filter(([k, v]) => SECRET_NAME.test(k) && typeof v === 'string' && v.length >= 8)
    .map(([, v]) => v)
    .sort((a, b) => b.length - a.length)
}

// A literal credential: 8+ token characters with at least one digit (so prose like "Basic authentication" and code
// like `Bearer ${token}` survive).
const CRED = '(?=[A-Za-z0-9._~+/=-]*\\d)[A-Za-z0-9._~+/=-]{8,}'
// High-confidence shapes, case-insensitive schemes: applied to everything, including code diffs and prompts.
const TOKEN_PATTERNS = [
  [new RegExp(`\\b(bearer|basic|token|digest)(\\s+)${CRED}`, 'gi'), '$1$2[REDACTED]'],
  [new RegExp(`(\\b(?:proxy-)?authorization\\s*[:=]\\s*["']?)${CRED}`, 'gi'), '$1[REDACTED]'],
  // After an explicit Authorization header and scheme, any literal credential goes, digits or not
  // (`Authorization: Basic dXNlcjpwYXNz`); `Bearer ${token}` in code has no literal and stays.
  [/(\b(?:proxy-)?authorization\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '$1_[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox-[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
  [/\blin_api_[A-Za-z0-9]{20,}/g, 'lin_api_[REDACTED]']
]
// Headers, env-like assignments and JSON secret fields: right for logs, too aggressive for code
// (would mangle `API_KEY = os.environ[...]`). The header rule removes the scheme and the credential together.
const LOG_PATTERNS = [
  [/\b(authorization|proxy-authorization|x-api-key|api-key)(\s*[:=]\s*)("?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]{4,}/gi, '$1$2$3[REDACTED]'],
  [/\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|PASSWORD))(\s*[=:]\s*)(["']?)[^\s"']{4,}\3/g, '$1$2$3[REDACTED]$3'],
  [/("(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|key|token|secret|password)")(\s*:\s*)"[^"]{4,}"/gi, '$1$2"[REDACTED]"']
]

// mode 'log' (default): everything. mode 'code': exact secret values + credential shapes only (patches, prompts).
export function scrubSecrets(text, { env = process.env, mode = 'log' } = {}) {
  let s = String(text ?? '')
  for (const v of secretValues(env)) s = s.split(v).join('[REDACTED]')
  for (const [re, rep] of TOKEN_PATTERNS) s = s.replace(re, rep)
  if (mode !== 'code') for (const [re, rep] of LOG_PATTERNS) s = s.replace(re, rep)
  return s
}

// Audit prose and excerpts can include literal assignments from source, including quoted values with spaces.
// Apply this before serializing structured artifacts so redactions cannot break their JSON escaping.
export function scrubAudit(text, env = process.env) {
  const literal = /(["']?[\w.-]*(?:passw(?:or)?d|passwd|secret|token|credential|api[_-]?key|private[_-]?key|authorization|cookie)[\w.-]*["']?\s*[:=]\s*)(?:"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'|`[^`]*`|[\w./+%=-]+)/gi
  return scrubSecrets(String(text).replace(/-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g, '[REDACTED]')
    .replace(literal, '$1[REDACTED]'), { env })
}

export function scrubAuditData(value, env) {
  if (typeof value === 'string') return scrubAudit(value, env)
  if (Array.isArray(value)) return value.map(v => scrubAuditData(v, env))
  if (value && typeof value === 'object') return Object.fromEntries(Object.entries(value).map(([k, v]) => [k, scrubAuditData(v, env)]))
  return value
}

// redact.ts: a second scrub of artifact text before the panel shows it.
//
// council-flow already scrubs every artifact it writes (src/redact.mjs). This copy of its shape
// rules runs again on display, so a hand-edited or older file still cannot put a credential on
// screen. Unlike the CLI it never looks at environment values: the plugin does not read
// LYBER_API_KEY or any other variable. test/plugin.test.mjs keeps these rules in step with the CLI.

const CRED = '(?=[A-Za-z0-9._~+/=-]*\\d)[A-Za-z0-9._~+/=-]{8,}'

export const TOKEN_PATTERNS: readonly [RegExp, string][] = [
  [new RegExp(`\\b(bearer|basic|token|digest)(\\s+)${CRED}`, 'gi'), '$1$2[REDACTED]'],
  [new RegExp(`(\\b(?:proxy-)?authorization\\s*[:=]\\s*["']?)${CRED}`, 'gi'), '$1[REDACTED]'],
  [/(\b(?:proxy-)?authorization\s*[:=]\s*["']?(?:bearer|basic|token|digest)\s+)[A-Za-z0-9._~+/=-]{8,}/gi, '$1[REDACTED]'],
  [/\bsk-(?:ant-|proj-)?[A-Za-z0-9_-]{16,}/g, 'sk-[REDACTED]'],
  [/\b(ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}/g, '$1_[REDACTED]'],
  [/\bgithub_pat_[A-Za-z0-9_]{20,}/g, 'github_pat_[REDACTED]'],
  [/\bxox[abprs]-[A-Za-z0-9-]{10,}/g, 'xox-[REDACTED]'],
  [/\bAKIA[0-9A-Z]{16}\b/g, 'AKIA[REDACTED]'],
  [/\blin_api_[A-Za-z0-9]{20,}/g, 'lin_api_[REDACTED]']
]

export const LOG_PATTERNS: readonly [RegExp, string][] = [
  [/\b(authorization|proxy-authorization|x-api-key|api-key)(\s*[:=]\s*)("?)(?:(?:bearer|basic|token|digest)\s+)?[^\s"',;]{4,}/gi, '$1$2$3[REDACTED]'],
  [/\b([A-Z][A-Z0-9_]*(?:_KEY|_TOKEN|_SECRET|PASSWORD))(\s*[=:]\s*)(["']?)[^\s"']{4,}\3/g, '$1$2$3[REDACTED]$3'],
  [/("(?:[A-Za-z0-9]+[_-])*(?:api[_-]?key|key|token|secret|password)")(\s*:\s*)"[^"]{4,}"/gi, '$1$2"[REDACTED]"']
]

const PRIVATE_KEY = /-----BEGIN [^-\n]*PRIVATE KEY-----[\s\S]*?(?:-----END [^-\n]*PRIVATE KEY-----|$)/g

/** Removes private key blocks, credential shapes and secret-looking assignments. */
export function scrubForDisplay(text: string): string {
  let s = String(text ?? '').replace(PRIVATE_KEY, '[REDACTED]')
  for (const [re, rep] of TOKEN_PATTERNS) s = s.replace(re, rep)
  for (const [re, rep] of LOG_PATTERNS) s = s.replace(re, rep)
  return s
}

// mode.ts: picks audit or code from what the person typed. Pure: no Orca, no Node, so the panel and
// the tests run the same code.
//
// The rule, in order:
//   1. Security language anywhere (security, vulnerability, injection, XSS, CSRF, exploit, ...) -> audit.
//      Security work belongs in the local-only audit loop, even when the prompt says "fix".
//   2. Otherwise the first intent verb decides: review / audit / inspect / find / check / ... -> audit;
//      add / implement / build / fix / create / refactor / write / change / ... -> code.
//   3. Nothing recognised -> audit. It is the safer default: it reads, and dry run is on.
//
// A manual pick (the Audit | Code toggle) holds until the suggestion for the text changes, that is
// until the prompt reads as a different mode than it did when the person picked, or until they
// pick again. See `nextOverride`.

export type Mode = 'audit' | 'code'
export type Override = { mode: Mode; suggestedAtPick: Mode }

/** Shown in the empty state; clicking it fills the prompt. A harmless, read-only audit. */
export const EXAMPLE_PROMPT = 'Review authorization in the request handler'

const SECURITY = /^(security|secure|insecure|vulnerab\w*|exploit\w*|injections?|xss|csrf|ssrf|xxe|rce|cves?|cwes?|threats?|attackers?|attacks?|bypass\w*|privilege\w*|escalation)$/

// Word stems with optional endings, so "added", "fixing", "reviews" and "findings" count.
const stems = (list: string): RegExp => new RegExp(`^(?:${list})(?:s|es|ed|d|ing|ings|e)?$`)
const AUDIT_VERB = stems('review|audit|inspect|assess|analy[sz]e?|scan|scann|check|find|look|examin|investigat|evaluat|explain|identify|identifi|detect|spot|hunt|verify|verifi')
const CODE_VERB = stems('add|implement|build|built|fix|creat|refactor|writ|wrote|chang|updat|mak|made|renam|remov|delet|migrat|support|upgrad|bump|replac|introduc|extract|convert|rewrit|generat|scaffold|optimi[sz]|improv|wir|enabl|disabl|debug|debugg|document')

const words = (text: string): string[] => text.toLowerCase().match(/[a-z]+/g) ?? []

/** The mode the prompt reads as. Deterministic: same text, same answer. */
export function suggestMode(text: unknown): Mode {
  const list = words(typeof text === 'string' ? text : '')
  if (list.some((w) => SECURITY.test(w))) return 'audit'
  for (const w of list) {
    if (AUDIT_VERB.test(w)) return 'audit'
    if (CODE_VERB.test(w)) return 'code'
  }
  return 'audit'
}

/** The mode a run starts in: the manual pick while it holds, else the suggestion. */
export function effectiveMode(text: unknown, override: Override | null): Mode {
  const suggested = suggestMode(text)
  return override && override.suggestedAtPick === suggested ? override.mode : suggested
}

/** What the toggle stores when the person picks `mode` for `text`. Picking the suggestion clears it. */
export function pick(text: unknown, mode: Mode): Override | null {
  const suggested = suggestMode(text)
  return mode === suggested ? null : { mode, suggestedAtPick: suggested }
}

/** After the text changed: keep the pick while the suggestion is the one it was made against. */
export function nextOverride(override: Override | null, text: unknown): Override | null {
  if (!override) return null
  return suggestMode(text) === override.suggestedAtPick ? override : null
}

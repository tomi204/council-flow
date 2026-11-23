// gate.mjs: the human decision before anything is pushed. The default answer is always "no".
//   Orca usable  -> Orca decision gate (gate-create on its own task; reaches the Orca app / phone)
//   dry-run      -> COUNCIL_FAKE_GATE (approve | deny, default deny)
//   TTY          -> y/N prompt, default No, times out to No
//   otherwise    -> deny (nobody can answer)
// The decision is bound to what was shown: the exact tree, base commit, worktree and destination ref. publish()
// refuses an approval whose binding does not match the run.
import readline from 'node:readline'
import { scrubSecrets } from './redact.mjs'

// Only the complete answer "approve" is approval ("approve after the tests pass" is not).
export const isApproval = (answer) => typeof answer === 'string' && answer.trim().toLowerCase() === 'approve'

function ttyAsk(question, timeoutMs, input, output, exact) {
  return new Promise((resolve) => {
    const rl = readline.createInterface({ input, output })
    const timer = setTimeout(() => { rl.close(); resolve({ answer: null, via: 'tty', timedOut: true }) }, timeoutMs)
    rl.question(`\n${question}\n${exact ? 'Type approve to commit locally' : '[y/N]'} `, (a) => { clearTimeout(timer); rl.close(); resolve({ answer: exact ? a : /^(y|yes)$/i.test(a.trim()) ? 'approve' : 'deny', via: 'tty' }) })
  })
}

// binding: {tree, base, worktree, dest, repo}
export async function decide({ cfg, env = process.env, orca, orcaUsable, question: raw, title, binding, workerIds = [], input = process.stdin, output = process.stderr }) {
  const question = scrubSecrets(raw, { env })              // shown in the terminal / Orca: never a secret
  let res
  if (orcaUsable) {
    try { res = await orca.gate({ question, title, timeoutMs: cfg.gateTimeoutMs, workerIds }) } catch (e) { res = { answer: null, via: 'orca gate', error: e.message } }
  } else if (cfg.dryRun) res = { answer: env.COUNCIL_FAKE_GATE || 'deny', via: 'dry-run fake gate' }
  else if (input.isTTY) res = await ttyAsk(question, cfg.gateTimeoutMs, input, output, cfg.audit)
  else res = { answer: null, via: 'none', note: 'no Orca terminal and no interactive terminal to ask' }
  return { decision: (cfg.audit ? res.answer === 'approve' : isApproval(res.answer)) ? 'approve' : 'deny', question, at: new Date().toISOString(), binding: binding || null, ...res }
}

export function bindingMatches(approval, expected) {
  if (!approval || approval.decision !== 'approve' || !approval.binding || !expected) return false
  const b = approval.binding
  return ['tree', 'base', 'worktree', 'dest'].every(k => b[k] && b[k] === expected[k]) && (b.repo ?? null) === (expected.repo ?? null)
}

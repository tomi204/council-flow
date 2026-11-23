// Blind redaction and shuffling: nothing that names a member reaches the judge.
import test from 'node:test'
import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import { redactIdentities, findIdentityLeaks, shuffle } from '../src/redact.mjs'
import { buildJudgeInput } from '../src/stages/plan.mjs'

const SELF = {
  claude: 'I am Claude (Opus 5.5), made by Anthropic. Claude Code read ~/.claude/settings.json. I used TodoWrite.',
  codex: 'As Codex from OpenAI (gpt-6.2-astra / ChatGPT), I ran apply_patch and read .codex/config.toml.',
  fx: 'Kimi here (kimi-k31-pro-abliterated) through Lyber on fx by Vercel; DeepSeek-v4.1-flash-1017-abliterated is the alt.'
}
const NAMES = /claude|anthropic|opus|codex|openai|gpt|chatgpt|kimi|lyber|vercel|deepseek|moonshot|todowrite|apply_patch|\bfx\b/i

test('redactIdentities removes vendor, model, version-suffixed ids and tool names', () => {
  for (const t of Object.values(SELF)) {
    const r = redactIdentities(t, ['gpt-6.2-astra', 'kimi-k31-pro-abliterated', 'opus'])
    assert.doesNotMatch(r, NAMES, r)
    assert.deepEqual(findIdentityLeaks(r), [])
  }
  assert.equal(redactIdentities('use my-claude-tool here'), 'use my-[model] here')
  assert.equal(redactIdentities('Claude 4 and GPT 5.1 agree'), '[model] and [model] agree')
})

test('redactIdentities keeps ordinary words and code intact', () => {
  const t = 'Add side effects to fxml parsing; the offx flag and refx stay. Open the reports.'
  assert.equal(redactIdentities(t), t)
})

test('configured model ids without a family word are redacted too', () => {
  assert.equal(redactIdentities('ran on astra-9000-pro today', ['astra-9000-pro']), 'ran on [model] today')
})

test('shuffle is a permutation and follows the injected random source', () => {
  const ids = ['claude', 'codex', 'fx']
  assert.deepEqual(shuffle(ids, () => 0), ['codex', 'fx', 'claude'])
  assert.deepEqual(shuffle(ids, (n) => n - 1), ids)
  const firsts = new Set()
  for (let i = 0; i < 200; i++) { const s = shuffle(ids, crypto.randomInt); assert.deepEqual([...s].sort(), [...ids].sort()); firsts.add(s[0]) }
  assert.equal(firsts.size, 3, 'every member lands on label A at some point')
})

test('judge input: labels A-C, no identity, no label map; the map covers every planner', () => {
  const { input, labels, mapping } = buildJudgeInput({ task: 'Add a greeting file', plans: SELF, extraTerms: ['gpt-6.2-astra', 'kimi-k31-pro-abliterated', 'opus'] })
  assert.deepEqual(labels, ['A', 'B', 'C'])
  assert.deepEqual(Object.values(mapping).sort(), ['claude', 'codex', 'fx'])
  assert.doesNotMatch(input, NAMES)
  assert.ok(!input.includes('"labels"') && !input.includes('mapping'))
  for (const l of labels) assert.match(input, new RegExp(`^=== PLAN ${l} ===$`, 'm'))
})

test('judge input with two planners only uses A and B', () => {
  const { input, labels } = buildJudgeInput({ task: 't', plans: { claude: 'plan one', codex: 'plan two' } })
  assert.deepEqual(labels, ['A', 'B'])
  assert.doesNotMatch(input, /=== PLAN C ===/)
  assert.match(input, /"A", "B", "merge"/)
})

test('judge input: model names in the task are redacted too; the leak check covers the whole prompt', () => {
  const { input } = buildJudgeInput({ task: 'Port the Claude client to the OpenAI SDK like Codex does, via Lyber', plans: { claude: 'plan one', codex: 'plan two' } })
  assert.doesNotMatch(input, /claude|openai|codex|lyber/i)
  assert.match(input, /Port the \[model\] client to the \[model\] SDK/)
})

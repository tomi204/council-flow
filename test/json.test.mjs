// Defensive JSON parsing for the judge verdict and review findings, and finding dedup.
import test from 'node:test'
import assert from 'node:assert/strict'
import { extractJson, jsonBlocks, parseVerdict, parseFindings, dedupeFindings, isBlocking } from '../src/json.mjs'

test('extractJson returns the last JSON value of the wanted kind, inside prose or fences', () => {
  const t = 'first {"a":1} then [1,2] and finally\n```json\n{"b": "x } y"}\n```\nbye'
  assert.deepEqual(extractJson(t, 'object'), { b: 'x } y' })
  assert.deepEqual(extractJson(t, 'array'), [1, 2])
  assert.equal(extractJson('no json [here', 'any'), undefined)
  assert.deepEqual(extractJson('(see [the note]) {"ok":true}', 'object'), { ok: true })
})

test('parseVerdict: prose around JSON, label forms, merge, bad choices', () => {
  const ok = parseVerdict('I think so.\n{"choice": "Plan b", "plan": "do it", "rationale": "short"}', ['A', 'B', 'C'])
  assert.deepEqual(ok, { ok: true, value: { choice: 'B', plan: 'do it', rationale: 'short' } })
  assert.equal(parseVerdict('{"choice":"merge","plan":"a merged plan that is long enough","rationale":"r"}', ['A', 'B']).value.choice, 'merge')
  assert.equal(parseVerdict('{"choice":"merge","plan":"x","rationale":"r"}', ['A', 'B']).ok, false)
  assert.match(parseVerdict('{"choice":"C","plan":"","rationale":""}', ['A', 'B']).error, /not one of A, B, merge/)
  assert.equal(parseVerdict('I pick A', ['A', 'B']).ok, false)
})

test('parseFindings: bare array or {findings}; aliases normalized; [] is clean', () => {
  const r = parseFindings('Review:\n[{"severity":"High","category":"tests","file":"a.js","line":"12","issue":"no test","suggestion":"add one"},{"severity":"critical","category":"correctness","issue":"x"}]')
  assert.equal(r.ok, true)
  assert.deepEqual(r.value[0], { severity: 'major', category: 'test', file: 'a.js', line: 12, issue: 'no test', suggestion: 'add one' })
  assert.deepEqual([r.value[1].severity, r.value[1].category, r.value[1].line], ['blocker', 'bug', null])
  assert.deepEqual(parseFindings('{"findings": []}'), { ok: true, value: [] })
  assert.deepEqual(parseFindings('[]').value, [])
  assert.equal(parseFindings('All good, no issues.').ok, false)
})

test('parseFindings: one malformed element makes the whole reply invalid (never a silent "clean")', () => {
  assert.match(parseFindings('[{}]').error, /missing "issue"/)
  assert.match(parseFindings('[{"severity":"urgent-ish","category":"bug","issue":"x"}]').error, /unknown severity/)
  assert.match(parseFindings('[{"severity":"major","category":"vibes","issue":"x"}]').error, /unknown category/)
  assert.match(parseFindings('[{"severity":"major","category":"bug","issue":"x","line":"twelve"}]').error, /bad "line"/)
  assert.match(parseFindings('[{"severity":"major","category":"bug","issue":"ok"}, {"nothing": true}]').error, /finding 2/)
})

test('jsonBlocks has a work budget: bracket-heavy junk cannot block the pipeline', () => {
  const t0 = Date.now()
  assert.deepEqual(jsonBlocks('['.repeat(150000) + '{'.repeat(50000)), [])
  assert.ok(Date.now() - t0 < 2000, `took ${Date.now() - t0} ms`)
  assert.deepEqual(jsonBlocks('x [1,2] y', { steps: 2 }), [], 'an exhausted budget stops the scan')
})

test('dedupeFindings: same place AND same issue merge; distinct issues on one line stay; reporters are unique', () => {
  const a = { member: 'claude', findings: [
    { severity: 'minor', category: 'bug', file: 'x.js', line: 3, issue: 'Off by one in the loop bound', suggestion: '' },
    { severity: 'minor', category: 'bug', file: 'x.js', line: 3, issue: 'off by one in the loop bound', suggestion: '' }] }
  const b = { member: 'fx', findings: [
    { severity: 'blocker', category: 'bug', file: 'x.js', line: 3, issue: 'off by one in the loop bound!', suggestion: 'use <' },
    { severity: 'blocker', category: 'bug', file: 'x.js', line: 3, issue: 'SQL injection through the name parameter', suggestion: 'escape it' }] }
  const m = dedupeFindings([a, b])
  assert.equal(m.length, 2)
  const loop = m.find(f => /off by one/i.test(f.issue)), sql = m.find(f => /SQL/.test(f.issue))
  assert.deepEqual([loop.severity, loop.reportedBy, loop.suggestion], ['blocker', 2, 'use <'])
  assert.deepEqual([sql.severity, sql.reportedBy, sql.suggestion], ['blocker', 1, 'escape it'], 'the second blocker keeps its own text and fix')
  assert.equal(m.filter(isBlocking).length, 2)
})

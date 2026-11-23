// The auto mode pick and the manual override rule.
import { assert, describe, test } from 'orca/testing'
import { effectiveMode, EXAMPLE_PROMPT, nextOverride, pick, suggestMode } from './mode'

describe('suggestMode', () => {
  test('review, audit and security language read as audit', () => {
    for (const t of [
      'Review authorization in the request handler',
      'audit the upload code',
      'Inspect src/reader.js',
      'Find issues in the parser',
      'look for bugs in session handling',
      'Check the findings from yesterday',
      'Explain how tokens are validated',
      'Is the login vulnerable?',
      'SQL injection in search',
      'Fix the XSS in comments',
      'Add CSRF protection to the forms',
      'Make the upload endpoint secure',
      EXAMPLE_PROMPT
    ]) {
      assert.equal(suggestMode(t), 'audit', t)
    }
  })

  test('building and changing read as code', () => {
    for (const t of [
      'Add a /health endpoint with a test',
      'Implement pagination for /users',
      'build a CLI flag for verbose output',
      'Fix the failing date test',
      'Create a Dockerfile',
      'refactor the config loader',
      'Write tests for the parser',
      'Please rename getUser to fetchUser',
      'Can you make the build faster?',
      'Update the README install steps',
      'Remove the deprecated v1 routes',
      'Added caching to the client'
    ]) {
      assert.equal(suggestMode(t), 'code', t)
    }
  })

  test('the first intent word decides when both kinds appear', () => {
    assert.equal(suggestMode('Review the parser and fix what you find'), 'audit')
    assert.equal(suggestMode('Fix the parser, then review the docs'), 'code')
    assert.equal(suggestMode('Find and fix the slow query'), 'audit')
  })

  test('security language wins over a coding verb', () => {
    assert.equal(suggestMode('Fix the security bug in auth'), 'audit')
    assert.equal(suggestMode('Implement rate limiting against brute-force attacks'), 'audit')
  })

  test('ambiguous or empty prompts default to audit', () => {
    for (const t of ['', '   ', 'the request handler', 'what about auth?', 'hmm', 'prefix and suffix', 42, null, undefined]) {
      assert.equal(suggestMode(t), 'audit', String(t))
    }
  })

  test('deterministic, case-insensitive, whole words only', () => {
    assert.equal(suggestMode('ADD A ROUTE'), 'code')
    assert.equal(suggestMode('add a route'), suggestMode('add a route'))
    assert.equal(suggestMode('the prefixed address'), 'audit', '"prefixed" and "address" are not "fix" and "add"')
  })
})

describe('manual override', () => {
  test('a pick holds while the prompt keeps reading the same way', () => {
    let o = pick('Review auth', 'code')
    assert.deepEqual(o, { mode: 'code', suggestedAtPick: 'audit' })
    assert.equal(effectiveMode('Review auth', o), 'code')
    o = nextOverride(o, 'Review auth and the session store')
    assert.deepEqual(o, { mode: 'code', suggestedAtPick: 'audit' })
    assert.equal(effectiveMode('Review auth and the session store', o), 'code')
  })

  test('it lets go once the prompt reads as the other mode, and does not come back', () => {
    let o = pick('Add tests for the parser', 'audit')
    assert.equal(effectiveMode('Add tests for the parser', o), 'audit')
    o = nextOverride(o, 'Review the parser')
    assert.equal(o, null, 'the suggestion changed (code -> audit): the pick is dropped')
    assert.equal(effectiveMode('Review the parser', o), 'audit')
    o = nextOverride(o, 'Add tests for the parser')
    assert.equal(effectiveMode('Add tests for the parser', o), 'code', 'back to the suggestion, not the old pick')
  })

  test('picking the suggestion clears the pick; picking again replaces it', () => {
    assert.equal(pick('Review auth', 'audit'), null)
    assert.deepEqual(pick('Add tests', 'audit'), { mode: 'audit', suggestedAtPick: 'code' })
    assert.equal(pick('Add tests', 'code'), null)
  })

  test('no pick: the suggestion', () => {
    assert.equal(effectiveMode('Add a route', null), 'code')
    assert.equal(nextOverride(null, 'anything'), null)
  })
})

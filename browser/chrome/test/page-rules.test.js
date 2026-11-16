import assert from 'node:assert/strict'
import { test } from 'node:test'
import { keeps, rulesFor, siteOf, styleFor, validSelector } from '../src/page-rules-core.js'

test('a page gets its own rules and the whole site\'s', () => {
  const rules = [{ id: 1, path: '/', rule: {} }, { id: 2, path: '', rule: {} }, { id: 3, path: '/courses', rule: {} }]
  assert.deepEqual(rulesFor(rules, '/').map((r) => r.id), [1, 2])
  assert.deepEqual(rulesFor(rules, '/courses/').map((r) => r.id), [2, 3])
  assert.equal(siteOf('www.Canvas.wisc.edu'), 'canvas.wisc.edu')
})

test('hidden selectors become one style rule, and nothing can break out of it', () => {
  const css = styleFor([{ rule: { hide: ['#right-side', 'x{}', '.banner'], css: '.a{color:red}' } }])
  assert.match(css, /#right-side,\n\.banner \{ display: none !important; \}/)
  assert.match(css, /\.a\{color:red\}/)
  assert.equal(validSelector('a</style>'), false)
})

test('keep leaves only the items that name what the owner wants', () => {
  assert.equal(keeps('COMP SCI 400: Programming III  Fall 2026', ['comp sci 400']), true)
  assert.equal(keeps('Old course Spring 2025', ['comp sci 400', 'math 341']), false)
})

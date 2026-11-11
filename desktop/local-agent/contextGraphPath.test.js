import assert from 'node:assert/strict'
import test from 'node:test'

import { resolveContextGraphPath } from './contextGraph.js'

test('context graph location is module-relative rather than cwd-relative', () => {
  const moduleUrl = new URL('./contextGraph.js', import.meta.url)
  const originalCwd = process.cwd()
  const before = resolveContextGraphPath(moduleUrl)

  try {
    process.chdir('/tmp')
    assert.equal(resolveContextGraphPath(moduleUrl), before)
  } finally {
    process.chdir(originalCwd)
  }

  assert.match(before, /local-agent\/memory\/context_graph\.json$/)
  assert.doesNotMatch(before, /local-agent\/local-agent\/memory/)
})

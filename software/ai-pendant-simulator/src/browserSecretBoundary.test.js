import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

for (const source of [
  new URL('./App.jsx', import.meta.url),
  new URL('./ops/api.js', import.meta.url),
]) {
  test(`${source.pathname.split('/').at(-1)} has no private Vite token fallback`, () => {
    const text = fs.readFileSync(source, 'utf8')
    assert.doesNotMatch(text, /VITE_AGENT_TOKEN/)
    assert.doesNotMatch(text, /VITE_RELAY_API_KEY/)
  })
}

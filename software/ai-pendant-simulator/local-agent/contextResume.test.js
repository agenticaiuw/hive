import assert from 'node:assert/strict'
import test from 'node:test'

import { describeResume, resumeContext } from './contextResume.js'
import { packContext } from '../shared/contextHandoff.js'
import { createMemoryStore } from '../cloud-relay/store/memoryStore.js'
import {
  parseContextHandle,
  publicContext,
  verifyContextHandle,
} from '../shared/contextHandoff.js'

function jsonResponse(body, status = 200) {
  return {
    ok: status >= 200 && status < 300,
    status,
    json: async () => body,
  }
}

/* Stands in for the relay route, using the real store and the real verifier so
 * the degrade paths are exercised against the actual contract. */
function relayFetch(store) {
  return async (_url, init) => {
    const handle = JSON.parse(init.body).handle
    const parsed = parseContextHandle(handle)
    if (!parsed) return jsonResponse({ ok: true, resumed: false, reason: 'malformed_handle' })
    const record = await store.getContext(parsed.handleId)
    if (!record || !verifyContextHandle(handle, record)) {
      return jsonResponse({ ok: true, resumed: false, reason: 'missing_or_expired' })
    }
    return jsonResponse({ ok: true, resumed: true, context: publicContext(record) })
  }
}

const THREAD = [
  { kind: 'message', role: 'user', text: 'why is the deploy stuck' },
  { kind: 'tool_call', name: 'web_search', callId: 'c1', text: '{"query":"status"}' },
  { kind: 'tool_result', callId: 'c1', text: '{"ok":true,"summary":"queue drained at 09:02"}' },
  { kind: 'reasoning', role: 'assistant', text: 'provider reasoning blob' },
]

test('a stored thread crosses to the Mac planner', async () => {
  const store = createMemoryStore()
  const { handle, record } = packContext({ items: THREAD, origin: 'cloud-relay/realtime' })
  await store.saveContext(record)

  const result = await resumeContext(handle, { fetchImpl: relayFetch(store) })

  assert.equal(result.resumed, true)
  assert.equal(result.origin, 'cloud-relay/realtime')
  assert.ok(
    result.messages.some((message) => message.content.includes('queue drained at 09:02')),
    'the finding the relay already made must arrive',
  )
  // Nothing the chat-completions endpoint would reject without declared tools.
  assert.equal(result.messages.some((message) => message.role === 'tool'), false)
  assert.equal(result.cacheKey, `ctx_${record.handleId}`)
})

test('an unknown handle degrades to a cold start instead of failing', async () => {
  const store = createMemoryStore()
  const { handle } = packContext({ items: THREAD, origin: 'cloud-relay/realtime' })
  // Never saved, so the store has no such row.

  const result = await resumeContext(handle, { fetchImpl: relayFetch(store) })

  assert.equal(result.resumed, false)
  assert.equal(result.reason, 'missing_or_expired')
  assert.deepEqual(result.messages, [])
})

test('an expired handle degrades to a cold start', async () => {
  const store = createMemoryStore()
  const { handle, record } = packContext({
    items: THREAD,
    origin: 'cloud-relay/realtime',
    ttlMs: -1,
  })
  await store.saveContext(record)

  const result = await resumeContext(handle, { fetchImpl: relayFetch(store) })

  assert.equal(result.resumed, false)
})

test('a missing handle never reaches the network', async () => {
  let called = false
  const result = await resumeContext(null, {
    fetchImpl: async () => {
      called = true
      return jsonResponse({})
    },
  })

  assert.equal(called, false)
  assert.equal(result.resumed, false)
  assert.equal(result.reason, 'no_handle')
})

test('an unreachable relay degrades to a cold start', async () => {
  const { handle } = packContext({ items: THREAD, origin: 'cloud-relay/realtime' })

  const result = await resumeContext(handle, {
    fetchImpl: async () => {
      throw new Error('socket hang up')
    },
  })

  assert.equal(result.resumed, false)
  assert.match(result.reason, /relay_unreachable/)
})

test('a relay error status degrades to a cold start', async () => {
  const { handle } = packContext({ items: THREAD, origin: 'cloud-relay/realtime' })

  const result = await resumeContext(handle, {
    fetchImpl: async () => jsonResponse({ ok: false }, 503),
  })

  assert.equal(result.resumed, false)
  assert.equal(result.reason, 'relay_status_503')
})

test('describeResume names the cold start rather than going quiet', () => {
  assert.match(describeResume({ resumed: false, reason: 'missing_or_expired' }), /cold start/)
  assert.match(
    describeResume({
      resumed: true,
      itemCount: 4,
      bytes: 512,
      origin: 'cloud-relay/realtime',
      notes: [{ action: 'dropped' }, { action: 'transcribed' }],
    }),
    /resumed 4 item\(s\).*1 transcribed.*1 dropped/,
  )
})

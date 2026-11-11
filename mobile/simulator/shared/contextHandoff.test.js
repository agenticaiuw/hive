import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CONTEXT_TTL_MS,
  adaptContextForModel,
  buildResumeMessages,
  contextItemsFromRealtimeState,
  fitContextToBudget,
  isContextExpired,
  mintContextHandle,
  normalizeContextItems,
  packContext,
  parseContextHandle,
  publicContext,
  redactContextItems,
  verifyContextHandle,
} from './contextHandoff.js'

const NOW = Date.parse('2026-08-07T09:00:00.000Z')

function items() {
  return [
    { kind: 'message', role: 'user', text: 'what did the cluster page say' },
    {
      kind: 'tool_call',
      name: 'read_web_page',
      callId: 'call_1',
      text: '{"url":"https://status.example"}',
    },
    {
      kind: 'tool_result',
      callId: 'call_1',
      text: '{"ok":false,"reason":"sign-in wall"}',
    },
    { kind: 'reasoning', role: 'assistant', text: 'opaque provider blob' },
    { kind: 'message', role: 'assistant', text: 'It is behind a login.' },
  ]
}

test('a handle verifies only against its own record', () => {
  const first = mintContextHandle()
  const second = mintContextHandle()
  const record = {
    handleId: first.handleId,
    secretHash: first.secretHash,
    expiresAt: new Date(NOW + 1000).toISOString(),
  }

  assert.equal(verifyContextHandle(first.handle, record, NOW), true)
  assert.equal(verifyContextHandle(second.handle, record, NOW), false)
})

test('the handle secret never appears in the stored record', () => {
  const { handle, record } = packContext({
    items: items(),
    origin: 'test',
    now: NOW,
  })
  const parsed = parseContextHandle(handle)

  assert.ok(parsed)
  assert.equal(JSON.stringify(record).includes(parsed.secret), false)
  assert.equal(publicContext(record).secretHash, undefined)
})

test('a tampered secret is rejected even with the right handle id', () => {
  const { handle, record } = packContext({
    items: items(),
    origin: 'test',
    now: NOW,
  })
  const { handleId, secret } = parseContextHandle(handle)
  const forged = `pcx_${handleId}.${secret.slice(0, -1)}${secret.endsWith('A') ? 'B' : 'A'}`

  assert.equal(verifyContextHandle(forged, record, NOW), false)
})

test('a context expires, and an expired one never verifies', () => {
  const { handle, record } = packContext({
    items: items(),
    origin: 'test',
    now: NOW,
  })

  assert.equal(isContextExpired(record, NOW + CONTEXT_TTL_MS - 1), false)
  assert.equal(isContextExpired(record, NOW + CONTEXT_TTL_MS), true)
  assert.equal(verifyContextHandle(handle, record, NOW + CONTEXT_TTL_MS), false)
})

test('a spoken secret is withheld, not appended to', () => {
  // maskSecretValue() is written for `key: value` and, given a sentence, used
  // to append its marker and leave the secret intact.
  const { items: redacted } = redactContextItems([
    { kind: 'message', role: 'user', text: 'my bike lock code is 4829' },
  ])

  assert.equal(redacted[0].text.includes('4829'), false)
  assert.equal(redacted[0].text, '[withheld]')
})

test('redaction takes the sentence, not the whole item', () => {
  const { items: redacted, redaction } = redactContextItems([
    {
      kind: 'tool_result',
      text: 'The build passed. The gate code is 7781. Deploy is queued.',
    },
  ])

  assert.equal(redacted[0].text.includes('7781'), false)
  assert.ok(redacted[0].text.includes('The build passed.'))
  assert.ok(redacted[0].text.includes('Deploy is queued.'))
  assert.equal(redaction.secrets, 1)
})

test('an API key pasted into a tool result does not reach the store', () => {
  const { handle: _handle, record } = packContext({
    items: [
      {
        kind: 'tool_result',
        text: 'export SLACK_TOKEN=xoxb-4827362718-abcdefghijkl',
      },
    ],
    origin: 'test',
    now: NOW,
  })

  assert.equal(JSON.stringify(record).includes('xoxb-4827362718'), false)
  assert.equal(record.redaction.secrets, 1)
})

test('screenshot bytes never cross a body', () => {
  const { record } = packContext({
    items: [
      {
        kind: 'tool_result',
        text: 'saw the page',
        imageBase64: 'AAAABBBBCCCC',
      },
    ],
    origin: 'test',
    now: NOW,
  })

  assert.equal(JSON.stringify(record).includes('AAAABBBBCCCC'), false)
})

test('the budget is bytes, and what was shed is recorded', () => {
  const fat = [
    { index: 0, kind: 'message', role: 'user', text: 'short' },
    { index: 1, kind: 'tool_result', name: 'read_web_page', text: 'x'.repeat(50_000) },
    { index: 2, kind: 'message', role: 'assistant', text: 'also short' },
  ]

  const { items: fitted, shed } = fitContextToBudget(fat, 4096)

  assert.ok(JSON.stringify(fitted).length <= 4096 + 512)
  assert.equal(shed.length, 1)
  assert.equal(shed[0].index, 1)
  assert.equal(shed[0].name, 'read_web_page')
  assert.ok(shed[0].bytes > 50_000)
  // The item survives as an item — a reader can tell elided from absent.
  assert.equal(fitted.length, 3)
  assert.ok(fitted[1].text.includes('[elided:'))
  assert.equal(fitted[0].text, 'short')
})

test('a count cap is not a size cap: many small items still fit', () => {
  const many = Array.from({ length: 400 }, (_, index) => ({
    index,
    kind: 'message',
    role: 'assistant',
    text: `step ${index}`,
  }))

  const { items: fitted, shed } = fitContextToBudget(many, 64 * 1024)

  assert.equal(fitted.length, 400)
  assert.equal(shed.length, 0)
})

test('reasoning items are dropped with a recorded note, never silently', () => {
  const { record } = packContext({ items: items(), origin: 'test', now: NOW })
  const { messages, notes } = adaptContextForModel(record)

  assert.equal(
    messages.some((message) => message.content.includes('opaque provider blob')),
    false,
  )
  const note = notes.find((entry) => entry.kind === 'reasoning')
  assert.equal(note.action, 'dropped')
  assert.match(note.reason, /model-specific/)
})

test('tool items are transcribed when the receiver declares no tools', () => {
  const { record } = packContext({ items: items(), origin: 'test', now: NOW })
  const { messages, notes } = adaptContextForModel(record)

  // Nothing the provider would reject: no role:"tool", no tool_call_id.
  assert.equal(messages.some((message) => message.role === 'tool'), false)
  // But the ruled-out finding still crossed.
  assert.ok(
    messages.some((message) => message.content.includes('sign-in wall')),
    'the tool result must survive as prose',
  )
  assert.equal(
    notes.filter((entry) => entry.action === 'transcribed').length,
    2,
  )
})

test('a receiver that accepts tool items gets them as tool items', () => {
  const { record } = packContext({ items: items(), origin: 'test', now: NOW })
  const { messages } = adaptContextForModel(record, {
    accepts: { toolItems: true, reasoning: false },
  })

  const toolMessage = messages.find((message) => message.role === 'tool')
  assert.ok(toolMessage)
  assert.equal(toolMessage.tool_call_id, 'call_1')
})

test('the resume prefix is stable across calls and the cache key is not the secret', () => {
  const { handle, record } = packContext({
    items: items(),
    origin: 'cloud-relay/realtime',
    now: NOW,
  })

  const first = buildResumeMessages(record)
  const second = buildResumeMessages(record)

  // Byte-identical prefix is the precondition for a provider cache hit.
  assert.equal(JSON.stringify(first.messages), JSON.stringify(second.messages))
  assert.equal(first.cacheKey, `ctx_${record.handleId}`)
  assert.equal(first.cacheKey.includes(parseContextHandle(handle).secret), false)
})

test('the realtime producer keeps what was checked, not only what was decided', () => {
  const state = {
    transcript: 'is the status page up',
    toolTrace: [
      { kind: 'tool_call', name: 'read_web_page', callId: 'c1', text: '{}' },
      { kind: 'tool_result', callId: 'c1', text: '{"ok":false}' },
    ],
    actions: [{ type: 'open_app', label: 'Open Safari' }],
    response: 'It is down.',
  }

  const produced = contextItemsFromRealtimeState(state)

  assert.equal(produced[0].role, 'user')
  assert.equal(produced[1].kind, 'tool_call')
  assert.equal(produced[2].kind, 'tool_result')
  // The action list goes last: it is the conclusion, and the Mac already has
  // it on the job. The argument above it is the part that was being lost.
  assert.ok(produced.at(-1).text.includes('open_app'))
})

test('unrecognised item shapes normalize rather than vanish', () => {
  const normalized = normalizeContextItems([
    { role: 'user', content: 'plain string content' },
    { kind: 'nonsense', role: 'weird', output: { ok: true } },
    null,
  ])

  assert.equal(normalized.length, 2)
  assert.equal(normalized[0].text, 'plain string content')
  assert.equal(normalized[1].kind, 'message')
  assert.equal(normalized[1].text, '{"ok":true}')
})

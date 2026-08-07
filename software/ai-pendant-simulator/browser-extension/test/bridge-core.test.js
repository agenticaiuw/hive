import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_COMMAND_AGE_MS,
  isScriptableUrl,
  normalizeAgentUrl,
  normalizeConfig,
  originPattern,
  pickTargetTab,
  retryDelay,
  validateCommand,
  validateNavigationUrl,
} from '../src/bridge-core.js'

test('agent URLs are restricted to the loopback interface', () => {
  assert.equal(normalizeAgentUrl('http://127.0.0.1:8000/'), 'http://127.0.0.1:8000')
  assert.equal(normalizeAgentUrl('http://localhost:9000'), 'http://localhost:9000')
  assert.throws(() => normalizeAgentUrl('https://example.com'), /must use http/)
  assert.throws(() => normalizeAgentUrl('http://192.168.1.5:8000'), /must use http/)
  assert.throws(() => normalizeAgentUrl('http://localhost:8000/api'), /must not contain a path/)
})

test('config normalization never invents a token and bounds labels', () => {
  assert.deepEqual(normalizeConfig({}), {
    agentUrl: 'http://127.0.0.1:8000',
    agentToken: '',
    deviceName: '',
    targetMode: 'last-focused',
  })
  assert.equal(normalizeConfig({ targetMode: 'unknown' }).targetMode, 'last-focused')
  assert.equal(normalizeConfig({ deviceName: 'x'.repeat(100) }).deviceName.length, 80)
})

test('navigation permits web URLs and rejects privileged schemes', () => {
  assert.equal(validateNavigationUrl('https://example.com/a'), 'https://example.com/a')
  assert.throws(() => validateNavigationUrl('javascript:alert(1)'), /Only http/)
  assert.throws(() => validateNavigationUrl('file:///etc/passwd'), /Only http/)
  assert.equal(isScriptableUrl('https://example.com'), true)
  assert.equal(isScriptableUrl('chrome://settings'), false)
  assert.equal(originPattern('https://example.com/path'), 'https://example.com/*')
})

test('commands are validated before touching a tab', () => {
  assert.deepEqual(
    validateCommand({
      action: { type: 'click', params: { selector: '#save', tabId: 4 } },
    }),
    { type: 'click', params: { selector: '#save', tabId: 4 } },
  )
  assert.deepEqual(
    validateCommand({
      action: { type: 'click', params: { ref: 'e3' } },
    }),
    { type: 'click', params: { ref: 'e3' } },
  )
  assert.deepEqual(
    validateCommand({
      action: { type: 'snapshot', params: { maxElements: 40 } },
    }),
    { type: 'snapshot', params: { maxElements: 40 } },
  )
  assert.deepEqual(
    validateCommand({
      action: { type: 'wait_for', params: { textContains: 'Done' } },
    }),
    { type: 'wait_for', params: { textContains: 'Done' } },
  )
  assert.deepEqual(
    validateCommand({ action: { type: 'list_tabs', params: {} } }),
    { type: 'list_tabs', params: {} },
  )
  assert.throws(
    () => validateCommand({ action: { type: 'type', params: {} } }),
    /selector or snapshot ref/,
  )
  assert.throws(
    () => validateCommand({ action: { type: 'delete_history', params: {} } }),
    /Unsupported/,
  )
})

test('target selection honors explicit tab, URL matching, and recency', () => {
  const tabs = [
    { id: 1, windowId: 1, active: true, url: 'https://example.com', lastAccessed: 5 },
    { id: 2, windowId: 2, active: true, url: 'https://mail.example', lastAccessed: 10 },
    { id: 3, windowId: 2, active: false, url: 'https://docs.example', lastAccessed: 20 },
  ]

  assert.equal(pickTargetTab(tabs, { tabId: 1 })?.id, 1)
  assert.equal(pickTargetTab(tabs, { urlContains: 'docs.' })?.id, 3)
  assert.equal(pickTargetTab(tabs, {}, 'last-focused')?.id, 2)
  assert.equal(pickTargetTab(tabs, { windowId: 1 })?.id, 1)
})

test('retry delays back off and remain bounded', () => {
  assert.equal(retryDelay(0), 750)
  assert.equal(retryDelay(2), 3_000)
  assert.equal(retryDelay(99), 15_000)
})

/*
 * The receiving side has to defend itself, because the sending side cannot be
 * fixed without the owner restarting the agent.
 *
 * Observed 2026-08-07: a live Mac agent, started before the bridge's expiry fix
 * landed, holding three commands queued hours earlier. They would have run the
 * moment this extension next connected — opening tabs in Safari unrelated to
 * anything the owner was doing. An extension reloads with the browser, so this
 * is the half that can be fixed today.
 */
test('a command queued long ago is refused rather than run', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')
  const command = {
    commandId: 'browser_stale',
    createdAt: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
    action: { type: 'navigate', params: { url: 'https://example.com' } },
  }

  assert.throws(() => validateCommand(command, now), /queued 14400s ago/)
})

test('a fresh command still runs', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')
  const command = {
    commandId: 'browser_fresh',
    createdAt: new Date(now - 5_000).toISOString(),
    action: { type: 'navigate', params: { url: 'https://example.com' } },
  }

  assert.equal(validateCommand(command, now).type, 'navigate')
})

test('a command right on the expiry boundary is still honoured', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')
  const at = (ms) => ({
    commandId: 'b',
    createdAt: new Date(now - ms).toISOString(),
    action: { type: 'list_tabs', params: {} },
  })

  assert.equal(validateCommand(at(MAX_COMMAND_AGE_MS), now).type, 'list_tabs')
  assert.throws(() => validateCommand(at(MAX_COMMAND_AGE_MS + 1), now), /Refused/)
})

/* Older agents do not stamp createdAt. Refusing everything from one would take
 * the bridge down entirely, which is worse than the surprise this guards. */
test('a command without a timestamp is not refused for staleness', () => {
  const command = { commandId: 'b', action: { type: 'list_tabs', params: {} } }
  assert.equal(validateCommand(command).type, 'list_tabs')
})

test('a stale command is refused whatever it asks for, valid or not', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')
  const command = {
    commandId: 'b',
    createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
    action: { type: 'not_a_real_command', params: {} },
  }
  assert.throws(() => validateCommand(command, now), /Refused/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  completeBrowserCommand,
  enqueueBrowserCommand,
  getBrowserCommandResult,
  getBrowserStatus,
  pollBrowserCommand,
  registerBrowserHeartbeat,
} from './browserBridge.js'

test('browser heartbeats expose useful device state', () => {
  const extensionId = `test-extension-${crypto.randomUUID()}`
  registerBrowserHeartbeat({
    extensionId,
    tabId: 42,
    windowId: 7,
    tabUrl: 'https://example.com',
    deviceName: 'Test Chrome',
    browserName: 'Google Chrome',
    extensionVersion: '1.1.0',
    userAgent: 'test-agent',
  })

  const device = getBrowserStatus().devices.find(
    (candidate) => candidate.extensionId === extensionId,
  )
  assert.equal(device.online, true)
  assert.equal(device.tabId, 42)
  assert.equal(device.deviceName, 'Test Chrome')
  assert.equal(device.extensionVersion, '1.1.0')
})

test('a browser command is claimed and completed by the same extension', () => {
  const extensionId = `test-extension-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId })
  const queued = enqueueBrowserCommand({
    type: 'read_page',
    params: {},
  })
  const claimed = pollBrowserCommand(extensionId)

  assert.equal(claimed.commandId, queued.commandId)
  assert.equal(claimed.status, 'processing')
  assert.equal(claimed.claimedBy, extensionId)

  assert.equal(
    completeBrowserCommand(
      queued.commandId,
      { ok: true, result: { message: 'done' } },
      'a-different-extension',
    ),
    null,
  )

  const completed = completeBrowserCommand(
    queued.commandId,
    { ok: true, result: { message: 'done' } },
    extensionId,
  )
  assert.equal(completed.status, 'completed')
  assert.equal(getBrowserCommandResult(queued.commandId).result.message, 'done')
})

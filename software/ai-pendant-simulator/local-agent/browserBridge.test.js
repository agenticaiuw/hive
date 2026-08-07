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

/*
 * A stale device disappears the next time any extension checks in.
 *
 * There is no route to unregister a heartbeat, so anything that ever polls this
 * bridge — a diagnostic probe, an agent verifying an offline path — leaves a
 * device row the owner never installed, visible in /browser/status and in
 * /observe. What makes that acceptable rather than permanent is that
 * registerBrowserHeartbeat prunes on every registration, so the residue clears
 * as a side effect of the real extension's next heartbeat, with no restart.
 *
 * That was being relied on in an explanation to the owner while nothing in the
 * code named it or held it still. Pinned here so that removing the prune, or
 * loosening the window, fails loudly instead of quietly making a reassurance
 * that was given out of date.
 *
 * The clock must be mocked as a whole: registerBrowserHeartbeat stamps with
 * `new Date()` and pruneOfflineHeartbeats compares against `Date.now()`. Faking
 * only one of the two desyncs them and prunes a device that just checked in,
 * which reads as a bug in the bridge rather than in the test.
 */
test('a stale device is pruned by the next heartbeat, without a restart', (t) => {
  const startedAt = Date.now()
  t.mock.timers.enable({ apis: ['Date'], now: startedAt })

  const phantom = `probe-residue-${crypto.randomUUID()}`
  const real = `real-extension-${crypto.randomUUID()}`

  registerBrowserHeartbeat({ extensionId: phantom })
  assert.ok(
    getBrowserStatus().devices.some((device) => device.extensionId === phantom),
    'the probe is listed while it is fresh',
  )

  /* Past ONLINE_WINDOW_MS * 4, the point at which a device stops being kept. */
  t.mock.timers.tick(300_000)

  const stranded = getBrowserStatus()
  assert.equal(stranded.online, false)
  assert.ok(
    stranded.devices.some((device) => device.extensionId === phantom),
    'nothing has swept it yet: reading the status does not prune',
  )

  /* The owner opens Safari and the real extension checks in. */
  registerBrowserHeartbeat({ extensionId: real })

  const devices = getBrowserStatus().devices.map((device) => device.extensionId)
  assert.equal(devices.includes(phantom), false, 'the residue is gone')
  assert.equal(devices.includes(real), true, 'the device that just checked in survives')
})

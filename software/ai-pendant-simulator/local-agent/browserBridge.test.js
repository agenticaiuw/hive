import assert from 'node:assert/strict'
import test from 'node:test'

import {
  cancelBrowserCommands,
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

test('a queued command nobody is waiting for expires instead of firing late', (t) => {
  /* Both clocks, deliberately: createdAt is stamped with new Date() and the
   * expiry compares against Date.now(). Faking one desyncs them and produces a
   * failure that reads as a bug in the bridge rather than in the test. */
  t.mock.timers.enable({ apis: ['Date'] })

  const { commandId } = enqueueBrowserCommand({ type: 'browser_navigate' })

  /* Past COMMAND_TTL_MS: twice waitForBrowserResult's own 45s timeout, so the
   * caller gave up long ago and there is nobody left to answer. */
  t.mock.timers.tick(90_001)

  const extensionId = `late-extension-${crypto.randomUUID()}`
  assert.equal(
    pollBrowserCommand(extensionId),
    null,
    'the extension reconnects and is handed nothing',
  )

  const result = getBrowserCommandResult(commandId)
  assert.equal(result.status, 'failed')
  assert.equal(result.expired, true)
  assert.match(result.error, /without an extension to run it/)
})

test('a command a caller is still waiting on is not taken away', (t) => {
  t.mock.timers.enable({ apis: ['Date'] })

  const { commandId } = enqueueBrowserCommand({ type: 'browser_navigate' })
  /* Inside waitForBrowserResult's 45s window: the caller is still there. */
  t.mock.timers.tick(30_000)

  const claimed = pollBrowserCommand(`live-extension-${crypto.randomUUID()}`)
  assert.equal(claimed?.commandId, commandId)
})

test('the queue can be drained without impersonating an extension', () => {
  const first = enqueueBrowserCommand({ type: 'browser_navigate' })
  const second = enqueueBrowserCommand({ type: 'browser_read_page' })

  const { cancelled } = cancelBrowserCommands()

  assert.ok(cancelled.includes(first.commandId))
  assert.ok(cancelled.includes(second.commandId))
  assert.equal(getBrowserStatus().pendingCommands, 0)

  const result = getBrowserCommandResult(first.commandId)
  assert.equal(result.status, 'failed')
  assert.equal(result.cancelled, true)

  /* No fake device was registered, which is the whole point — the old drain
   * left a phantom extension behind in the heartbeat registry. */
  const devices = getBrowserStatus().devices.map((device) => device.extensionId)
  assert.equal(devices.some((id) => String(id).includes('cleanup')), false)
})

test('cancelling one command leaves the others queued', () => {
  cancelBrowserCommands()
  const doomed = enqueueBrowserCommand({ type: 'browser_navigate' })
  const spared = enqueueBrowserCommand({ type: 'browser_read_page' })

  const { cancelled } = cancelBrowserCommands(doomed.commandId)

  assert.deepEqual(cancelled, [doomed.commandId])
  assert.equal(getBrowserCommandResult(spared.commandId).status, 'queued')
  cancelBrowserCommands()
})

/*
 * The case the TTL was added for, and did not actually cover.
 *
 * Expiry ran only from pollBrowserCommand, which assumed an extension would
 * eventually connect. This system spent an entire day with `online: false` and
 * a device row hours stale, so the sweep never ran once and the queue grew
 * without bound — two commands were sitting in it when this was found.
 */
test('the queue is bounded even when no extension ever connects', (t) => {
  cancelBrowserCommands()
  t.mock.timers.enable({ apis: ['Date'] })

  const abandoned = enqueueBrowserCommand({ type: 'browser_navigate' })
  t.mock.timers.tick(90_001)

  /* Nothing polls. The only thing that happens is more work arriving. */
  const fresh = enqueueBrowserCommand({ type: 'browser_read_page' })

  assert.equal(getBrowserStatus().pendingCommands, 1, 'the dead one was retired')
  assert.equal(getBrowserCommandResult(abandoned.commandId).expired, true)
  assert.equal(getBrowserCommandResult(fresh.commandId).status, 'queued')
  cancelBrowserCommands()
})

test('enqueueing does not retire a command a caller is still waiting on', (t) => {
  cancelBrowserCommands()
  t.mock.timers.enable({ apis: ['Date'] })

  const inFlight = enqueueBrowserCommand({ type: 'browser_navigate' })
  t.mock.timers.tick(30_000)
  enqueueBrowserCommand({ type: 'browser_read_page' })

  assert.equal(getBrowserCommandResult(inFlight.commandId).status, 'queued')
  assert.equal(getBrowserStatus().pendingCommands, 2)
  cancelBrowserCommands()
})

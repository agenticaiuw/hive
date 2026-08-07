import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  cancelBrowserCommands,
  completeBrowserCommand,
  configureBrowserBridge,
  enqueueBrowserCommand,
  getBrowserCommandResult,
  getBrowserStatus,
  pollBrowserCommand,
  redactAction,
  registerBrowserBridgeRoutes,
  registerBrowserHeartbeat,
  sweepBrowserBridge,
} from './browserBridge.js'
import { clearBrowserSpool, readBrowserSpool } from './browserSpool.js'

/*
 * Every expiry and every orphaned lease writes to the offline spool, so the
 * whole file is redirected at a temporary store before the first test runs.
 * Without this the suite would write into the owner's real workspace, and the
 * spool's own tests would be reading whatever the other tests happened to leave
 * there.
 */
const SPOOL_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-browser-bridge-'))
const SPOOL_PATH = path.join(SPOOL_DIR, 'browser-spool.json')
configureBrowserBridge({ spoolPath: SPOOL_PATH })

process.on('exit', () => {
  fs.rmSync(SPOOL_DIR, { force: true, recursive: true })
})

const spool = () => readBrowserSpool({ filePath: SPOOL_PATH })
const resetSpool = () => clearBrowserSpool(null, { filePath: SPOOL_PATH })

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

/* ==================================================== idempotency ========= */

/*
 * The failure this closes is invisible from here, which is why it needs a key.
 *
 * A caller stops waiting at 45s and asks again. Nothing about the second ask
 * distinguishes "the first one never ran" from "the first one ran and we did
 * not hear back", so without a declared identity the bridge queues a second
 * command and the click happens twice on a real page.
 */
test('two enqueues sharing an idempotency key are one command', () => {
  cancelBrowserCommands()
  const key = `checkout-${crypto.randomUUID()}`

  const first = enqueueBrowserCommand(
    { type: 'click', params: { selector: '#place-order' } },
    { idempotencyKey: key },
  )
  const retry = enqueueBrowserCommand(
    { type: 'click', params: { selector: '#place-order' } },
    { idempotencyKey: key },
  )

  assert.equal(retry.commandId, first.commandId)
  assert.equal(retry.deduplicated, true)
  assert.equal(
    getBrowserStatus().pendingCommands,
    1,
    'the second ask must not put a second click on the queue',
  )
  cancelBrowserCommands()
})

test('a retry after the answer arrived gets the answer, not a second run', () => {
  cancelBrowserCommands()
  const key = `submit-${crypto.randomUUID()}`
  const extensionId = `ext-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId })

  const first = enqueueBrowserCommand(
    { type: 'click', params: { selector: '#pay' } },
    { idempotencyKey: key },
  )
  pollBrowserCommand(extensionId)
  completeBrowserCommand(
    first.commandId,
    { ok: true, result: { message: 'Clicked #pay' } },
    extensionId,
  )

  const retry = enqueueBrowserCommand(
    { type: 'click', params: { selector: '#pay' } },
    { idempotencyKey: key },
  )

  assert.equal(retry.commandId, first.commandId)
  assert.equal(retry.status, 'completed')
  assert.equal(retry.result.message, 'Clicked #pay')
  assert.equal(getBrowserStatus().pendingCommands, 0)
  cancelBrowserCommands()
})

test('different keys are different acts', () => {
  cancelBrowserCommands()
  const a = enqueueBrowserCommand({ type: 'click', params: {} }, { idempotencyKey: 'a' })
  const b = enqueueBrowserCommand({ type: 'click', params: {} }, { idempotencyKey: 'b' })

  assert.notEqual(a.commandId, b.commandId)
  assert.equal(getBrowserStatus().pendingCommands, 2)
  cancelBrowserCommands()
})

/* ==================================================== affinity ============ */

test('a command pinned to one device is not handed to another', () => {
  cancelBrowserCommands()
  const mine = `safari-${crypto.randomUUID()}`
  const theirs = `chrome-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId: mine })
  registerBrowserHeartbeat({ extensionId: theirs })

  const pinned = enqueueBrowserCommand(
    { type: 'read_page', params: {} },
    { extensionId: mine },
  )

  assert.equal(pollBrowserCommand(theirs), null, 'the wrong device is handed nothing')
  assert.equal(pollBrowserCommand(mine)?.commandId, pinned.commandId)
  cancelBrowserCommands()
})

/*
 * Safari gives every extension context its own tab-id namespace — the same page
 * was reported as 226923 and then 226919 seconds apart, and an id from one
 * command is rejected by the next (see browserSessions.js). A session's tab
 * therefore only means anything to the device that opened it, and sending the
 * session's next command elsewhere silently retargets the task at another page.
 */
test('a session follows the device that last served it', () => {
  cancelBrowserCommands()
  const first = `safari-${crypto.randomUUID()}`
  const second = `chrome-${crypto.randomUUID()}`
  const session = `invoice-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId: first })
  registerBrowserHeartbeat({ extensionId: second })

  const opened = enqueueBrowserCommand({
    type: 'navigate',
    params: { url: 'https://example.com', session },
  })
  pollBrowserCommand(first)
  completeBrowserCommand(
    opened.commandId,
    { ok: true, result: { tabId: 9, url: 'https://example.com' } },
    first,
  )

  const next = enqueueBrowserCommand({
    type: 'read_page',
    params: { session },
  })

  assert.equal(pollBrowserCommand(second), null, 'the other browser is skipped')
  assert.equal(pollBrowserCommand(first)?.commandId, next.commandId)
  cancelBrowserCommands()
})

/* A pin is a preference, not a hostage-taking: if the device it names has gone
 * away, the work must still be doable by whoever is actually there. */
test('a session pin yields once its device stops answering', (t) => {
  cancelBrowserCommands()
  t.mock.timers.enable({ apis: ['Date'] })

  const gone = `safari-${crypto.randomUUID()}`
  const here = `chrome-${crypto.randomUUID()}`
  const session = `invoice-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId: gone })

  const opened = enqueueBrowserCommand({ type: 'navigate', params: { session } })
  pollBrowserCommand(gone)
  completeBrowserCommand(opened.commandId, { ok: true, result: {} }, gone)

  /* Past ONLINE_WINDOW_MS: the pinned browser is no longer heartbeating. */
  t.mock.timers.tick(71_000)
  registerBrowserHeartbeat({ extensionId: here })

  const next = enqueueBrowserCommand({ type: 'read_page', params: { session } })
  assert.equal(pollBrowserCommand(here)?.commandId, next.commandId)
  cancelBrowserCommands()
})

/*
 * browserSessions.js is owned elsewhere and cannot be changed from here, and it
 * strips its own session name out of every command before enqueueing it
 * (toWireParams drops session/sessionId/…). What survives on the wire is the
 * urlContains needle the session targets with — "the page this task is working
 * in" — so that is what the affinity is keyed on for the caller that has one.
 */
test('a task keeps the browser its page is open in, without naming a session', () => {
  cancelBrowserCommands()
  const first = `safari-${crypto.randomUUID()}`
  const second = `chrome-${crypto.randomUUID()}`
  const needle = `https://example.com/orders/${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId: first })
  registerBrowserHeartbeat({ extensionId: second })

  const opened = enqueueBrowserCommand({
    type: 'read_page',
    params: { urlContains: needle },
  })
  pollBrowserCommand(first)
  completeBrowserCommand(opened.commandId, { ok: true, result: { tabId: 3 } }, first)

  const next = enqueueBrowserCommand({
    type: 'click',
    params: { urlContains: needle, selector: '#confirm' },
  })

  assert.equal(pollBrowserCommand(second), null)
  assert.equal(pollBrowserCommand(first)?.commandId, next.commandId)
  cancelBrowserCommands()
})

/* =============================================== typed results ============ */

test('a result carries what it is and where it came from', () => {
  cancelBrowserCommands()
  const extensionId = `ext-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId })

  const queued = enqueueBrowserCommand({
    type: 'read_page',
    params: { selector: 'main', session: 'receipts' },
    label: 'read the receipt',
  })
  pollBrowserCommand(extensionId)

  const record = completeBrowserCommand(
    queued.commandId,
    {
      ok: true,
      result: {
        content: 'Total $12.40',
        provenance: {
          tabId: 42,
          windowId: 7,
          url: 'https://shop.example/receipt/9',
          title: 'Receipt',
          locator: 'main',
          observedAt: '2026-08-07T12:00:00.000Z',
        },
        privacy: { withheld: 0, verified: true },
      },
    },
    extensionId,
  )

  assert.equal(record.result.resultType, 'page_text')
  assert.equal(record.result.content, 'Total $12.40', 'the payload still reads as before')

  const { provenance } = record.result
  assert.equal(provenance.commandId, queued.commandId)
  assert.equal(provenance.action, 'read_page')
  assert.equal(provenance.label, 'read the receipt')
  assert.equal(provenance.sessionId, 'receipts')
  assert.equal(provenance.extensionId, extensionId)
  assert.equal(provenance.tabId, 42)
  assert.equal(provenance.url, 'https://shop.example/receipt/9')
  assert.equal(provenance.locator, 'main')
  assert.equal(provenance.observedAt, '2026-08-07T12:00:00.000Z')
  assert.deepEqual(provenance.privacy, { withheld: 0, verified: true })
  cancelBrowserCommands()
})

/* An older extension asserts nothing about privacy. "unknown" is the honest
 * reading of that, and null is how this says it — never "clean". */
test('a result from an extension without the privacy boundary says so', () => {
  cancelBrowserCommands()
  const extensionId = `ext-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId })
  const queued = enqueueBrowserCommand({ type: 'list_tabs', params: {} })
  pollBrowserCommand(extensionId)

  const record = completeBrowserCommand(
    queued.commandId,
    { ok: true, result: { tabs: [] } },
    extensionId,
  )

  assert.equal(record.result.resultType, 'tab_list')
  assert.equal(record.result.provenance.privacy, null)
  assert.equal(record.result.provenance.locator, 'document')
  cancelBrowserCommands()
})

/* ============================================ leases and orphans ========== */

/*
 * The double-act this bridge used to permit.
 *
 * reclaimExpiredCommands put an expired lease back on the queue. But the lease
 * is 45s and waitForBrowserResult gives up at 45s, so nothing is ever waiting
 * when one expires — and the extension may well have run the command and only
 * failed to post the result back. Re-queueing turned "we never heard" into a
 * second navigate in the owner's Safari.
 */
test('an expired lease is retired, not re-queued', (t) => {
  cancelBrowserCommands()
  resetSpool()
  t.mock.timers.enable({ apis: ['Date'] })

  const extensionId = `ext-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId })
  const queued = enqueueBrowserCommand({
    type: 'navigate',
    params: { url: 'https://example.com' },
  })
  assert.equal(pollBrowserCommand(extensionId)?.commandId, queued.commandId)

  t.mock.timers.tick(46_000)

  assert.equal(
    pollBrowserCommand(extensionId),
    null,
    'the same command must not come back around',
  )

  const record = getBrowserCommandResult(queued.commandId)
  assert.equal(record.status, 'failed')
  assert.equal(record.orphaned, true)
  assert.match(record.error, /running it twice would act on the page twice/)

  const spooled = spool().entries.find((e) => e.commandId === queued.commandId)
  assert.equal(spooled.reason, 'lease-expired')
  cancelBrowserCommands()
})

/*
 * A restarted service worker has lost its own idempotency ledger, so it can no
 * longer tell whether it already ran what it was holding. The extensionId is
 * stable across a restart; only the nonce moves.
 */
test('a changed heartbeat nonce retires the leases that incarnation held', () => {
  cancelBrowserCommands()
  resetSpool()
  const extensionId = `safari-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId, nonce: 'incarnation-1' })

  const queued = enqueueBrowserCommand({ type: 'click', params: { selector: '#go' } })
  pollBrowserCommand(extensionId)

  const heartbeat = registerBrowserHeartbeat({ extensionId, nonce: 'incarnation-2' })

  assert.deepEqual(heartbeat.orphaned, [queued.commandId])
  const record = getBrowserCommandResult(queued.commandId)
  assert.equal(record.status, 'failed')
  assert.match(record.error, /restarted while holding this command/)
  assert.equal(
    spool().entries.find((e) => e.commandId === queued.commandId).reason,
    'extension-restarted',
  )
  cancelBrowserCommands()
})

/* A poll registers a heartbeat with no nonce at all. That must not read as a
 * restart, or every offline extension's first poll would retire its own work. */
test('a heartbeat carrying no nonce is not mistaken for a restart', () => {
  cancelBrowserCommands()
  const extensionId = `safari-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId, nonce: 'incarnation-1' })
  const queued = enqueueBrowserCommand({ type: 'click', params: { selector: '#go' } })
  pollBrowserCommand(extensionId)

  const heartbeat = registerBrowserHeartbeat({ extensionId })

  assert.equal(heartbeat.orphaned, undefined)
  assert.equal(getBrowserCommandResult(queued.commandId).status, 'processing')
  cancelBrowserCommands()
})

/* =================================================== offline spool ======== */

/*
 * Offline is this bridge's normal state. Before the spool the only evidence
 * that the browser tier had been asked for something and never did it was a
 * queue length, and the queue is swept to zero by design — so the evidence
 * erased itself. Expiry is the spool's main feeder for exactly that reason.
 */
test('a command that expired unrun is written down, not just deleted', (t) => {
  cancelBrowserCommands()
  resetSpool()
  t.mock.timers.enable({ apis: ['Date'] })

  const abandoned = enqueueBrowserCommand({
    type: 'navigate',
    params: { url: 'https://example.com/report' },
    label: 'open the report',
  })
  t.mock.timers.tick(90_001)
  enqueueBrowserCommand({ type: 'list_tabs', params: {} })

  const entry = spool().entries.find((e) => e.commandId === abandoned.commandId)
  assert.equal(entry.reason, 'expired')
  assert.equal(entry.action.type, 'navigate')
  assert.equal(entry.action.params.url, 'https://example.com/report')
  assert.equal(entry.action.label, 'open the report')
  /* When it was asked for, not just when it was given up on — the gap is the
   * only way to tell "the browser was offline all afternoon" from "the browser
   * answered everything else and stalled on this one". */
  assert.equal(entry.queuedAt, abandoned.createdAt)
  assert.ok(entry.spooledAt > entry.queuedAt)
  cancelBrowserCommands()
})

/* Cancelling is a decision, not a loss. Recording decisions in the same list as
 * losses makes the list unreadable, which is the only thing it is for. */
test('a deliberate cancellation is not spooled as a loss', () => {
  cancelBrowserCommands()
  resetSpool()

  const doomed = enqueueBrowserCommand({ type: 'navigate', params: {} })
  cancelBrowserCommands()

  assert.equal(spool().entries.some((e) => e.commandId === doomed.commandId), false)
})

/* ================================================ supervision ============= */

/*
 * Every other sweep in this module is a side effect of traffic. With the
 * extension offline nothing polls, and on a quiet system nothing enqueues, so
 * on the system this bridge actually spends its life on, nothing runs at all.
 */
test('the supervisor sweeps a system where nothing is happening', (t) => {
  cancelBrowserCommands()
  t.mock.timers.enable({ apis: ['Date'] })

  const stranded = enqueueBrowserCommand({ type: 'navigate', params: {} })
  t.mock.timers.tick(90_001)

  const swept = sweepBrowserBridge()

  assert.equal(swept.pendingBefore, 1)
  assert.equal(swept.pendingAfter, 0)
  assert.equal(getBrowserCommandResult(stranded.commandId).expired, true)
})

/* ================================================ secret handling ========= */

/*
 * The retained record is built by spreading the command, so a `type` command
 * carrying a password kept that password in the completed-results map for the
 * life of 200 more commands — and POST /browser/result/:commandId handed it
 * straight back out. The extension needs the real text; nothing after it does.
 */
test('a typed password does not survive into the record the agent keeps', () => {
  cancelBrowserCommands()
  const extensionId = `ext-${crypto.randomUUID()}`
  registerBrowserHeartbeat({ extensionId })

  const queued = enqueueBrowserCommand({
    type: 'type',
    params: {
      selector: '#login-password',
      text: 'hunter2-correct-horse',
      allowSensitiveInput: true,
    },
  })

  /* The extension still gets the real thing — it has to type it. */
  const handed = pollBrowserCommand(extensionId)
  assert.equal(handed.action.params.text, 'hunter2-correct-horse')

  const record = completeBrowserCommand(
    queued.commandId,
    { ok: true, result: { message: 'Typed into #login-password' } },
    extensionId,
  )

  assert.equal(
    JSON.stringify(record).includes('hunter2'),
    false,
    'nothing anywhere in the kept record may contain the secret',
  )
  assert.deepEqual(record.action.secretsWithheld, ['text'])
  assert.equal(
    JSON.stringify(getBrowserCommandResult(queued.commandId)).includes('hunter2'),
    false,
  )
  cancelBrowserCommands()
})

test('ordinary typed text is left alone', () => {
  const action = {
    type: 'type',
    params: { selector: '#search', text: 'flights to lisbon' },
  }
  assert.equal(redactAction(action).params.text, 'flights to lisbon')
  assert.match(
    redactAction({
      type: 'type',
      params: { selector: '#card-cvv', text: '123' },
    }).params.text,
    /withheld/,
  )
})

/* ==================================================== registration ======== */

/* server.js is wired by hand and owned elsewhere, so this module hands over a
 * registration function rather than route definitions someone has to copy. */
test('the bridge registers its own durability routes', () => {
  const registered = []
  const app = {
    get: (routePath) => registered.push(`GET ${routePath}`),
    post: (routePath) => registered.push(`POST ${routePath}`),
    delete: (routePath) => registered.push(`DELETE ${routePath}`),
  }

  const routes = registerBrowserBridgeRoutes(app)

  assert.deepEqual(registered, routes)
  assert.ok(routes.includes('GET /browser/spool'))
  assert.ok(routes.includes('POST /browser/sweep'))
})

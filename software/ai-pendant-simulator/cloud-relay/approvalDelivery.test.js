import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { prepareAction } from '../local-agent/prepareApprove.js'
import { attestApprovalDelivery } from '../shared/approvalHandoff.js'
import {
  APPROVAL_DECISION_KIND,
  APPROVAL_REQUEST_KIND,
  answerSpokenApproval,
  approvalPromptRoute,
  consumeRelayApprovalMail,
  decideApproval,
  decideNextPendingApproval,
  isPendantRoutedApproval,
  registerApprovalDeliveryRoutes,
  routeApprovalPrompt,
} from './approvalDelivery.js'
import { readApproval, saveApproval, speakNextApproval } from './approvalStore.js'
import { drainNodeInbox, sendNodeMessage } from './nodeMailbox.js'
import { createMemoryStore } from './store/memoryStore.js'

const NOW = Date.parse('2026-08-09T09:00:00.000Z')

/* Same conventions as approvalStore.test.js: a real temp tree, the real memory
 * store, and records produced by the real prepare path — origin routing is a
 * claim about those records, so a hand-built stub would test the assertion. */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-delivery-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return {
    dir,
    ledger: path.join(dir, 'ledger.json'),
    store: createMemoryStore(),
    file(name, body) {
      const target = path.join(dir, name)
      fs.writeFileSync(target, body)
      return target
    },
  }
}

function plan(space) {
  space.file('notes.txt', 'the original body')
  return [
    {
      type: 'write_file',
      label: 'update the notes file',
      params: { path: path.join(space.dir, 'notes.txt'), content: 'a new body' },
    },
    {
      type: 'send_email',
      label: 'email the summary to sam@example.com',
      params: { to: 'sam@example.com', subject: 'Summary', body: 'here it is' },
    },
  ]
}

function preparedRecord(space, overrides = {}) {
  return prepareAction({
    command: 'send sam the notes summary',
    actions: plan(space),
    filePath: space.ledger,
    now: NOW,
    ...overrides,
  }).approval
}

async function storedRecord(space, overrides = {}) {
  const record = preparedRecord(space, overrides)
  await saveApproval(space.store, record, { now: NOW })
  return record
}

async function pairNode(store, deviceId, deviceType) {
  await store.saveDevice({
    deviceId,
    deviceType,
    name: deviceId,
    registeredAt: new Date(NOW).toISOString(),
    lastSeenAt: new Date(NOW).toISOString(),
    updatedAt: new Date(NOW).toISOString(),
  })
}

/* ------------------------------------------------------------- routing */

test('a pendant-originated approval routes to speech, not to the mesh', async (t) => {
  const space = workspace(t)
  const record = preparedRecord(space, { origin: 'nrf9160' })

  const route = await approvalPromptRoute({ store: space.store, record })
  assert.equal(route.channel, 'pendant-speech')
  assert.equal(isPendantRoutedApproval(record), true)
})

test('mac-surface origins stay with the Mac agent and push nothing', async (t) => {
  const space = workspace(t)
  for (const origin of ['floating-hud', 'mac-bridge', 'dashboard']) {
    const record = preparedRecord(space, { origin })
    const route = await approvalPromptRoute({ store: space.store, record })
    assert.equal(route.channel, 'mac-agent', origin)
    assert.equal(isPendantRoutedApproval(record), false, origin)

    const outcome = await routeApprovalPrompt({ store: space.store, record, now: NOW })
    assert.equal(outcome.channel, 'mac-agent')
    assert.equal(outcome.pushed, false)
    assert.equal(outcome.queued, true)
  }
})

test('a registered mesh node origin gets an approval_request envelope in its inbox', async (t) => {
  const space = workspace(t)
  await pairNode(space.store, 'ios-phone-1', 'mobile')
  const record = await storedRecord(space, { origin: 'ios-phone-1' })

  const outcome = await routeApprovalPrompt({ store: space.store, record, now: NOW })
  assert.equal(outcome.channel, 'mesh')
  assert.equal(outcome.to, 'ios-phone-1')
  assert.ok(outcome.messageId, 'the envelope id is reported so the push is auditable')

  const { messages } = await drainNodeInbox({ store: space.store, deviceId: 'ios-phone-1', now: NOW })
  assert.equal(messages.length, 1)
  const envelope = messages[0]
  assert.equal(envelope.kind, APPROVAL_REQUEST_KIND)
  assert.equal(envelope.from, '@relay')
  assert.deepEqual(Object.keys(envelope.payload).sort(), ['approvalId', 'detail', 'expiresAt', 'risk', 'summary'])
  assert.equal(envelope.payload.approvalId, record.approvalId)
  assert.equal(envelope.payload.detail, record.readback)
  assert.ok(record.readback.startsWith(envelope.payload.summary))
  assert.equal(typeof envelope.payload.risk, 'string', 'risk crosses the mesh as a phrase, never an object')
  assert.equal(envelope.payload.expiresAt, record.expiresAt)
  /* The prompt dies with the approval: its delivery window never outlives the
   * decision window it is prompting for. */
  assert.ok(Date.parse(envelope.expiresAt) <= Date.parse(record.expiresAt))
})

test('an unregistered origin falls back to the Mac surface instead of queueing mail nobody drains', async (t) => {
  const space = workspace(t)
  const record = preparedRecord(space, { origin: 'never-paired-node' })

  const outcome = await routeApprovalPrompt({ store: space.store, record, now: NOW })
  assert.equal(outcome.channel, 'mac-agent')
  assert.equal(await space.store.countPendingNodeMessages('never-paired-node', { now: NOW }), 0)
})

test('a record from before origin existed routes exactly as it always did', async (t) => {
  const space = workspace(t)
  const record = preparedRecord(space)
  assert.equal(record.origin, 'prepare-approve', 'prepareAction defaults origin to its source')

  const { origin: _dropped, ...legacy } = record
  const route = await approvalPromptRoute({ store: space.store, record: legacy })
  assert.equal(route.channel, 'mac-agent')
})

/* ------------------------------------------------------------ deciding */

test('deny settles the record and a second decision is a no-op with its own code', async (t) => {
  const space = workspace(t)
  const record = await storedRecord(space, { origin: 'ios-phone-1' })

  const denied = await decideApproval({
    store: space.store,
    approvalId: record.approvalId,
    decision: 'deny',
    decidedBy: 'ios-phone-1',
    now: NOW + 1000,
  })
  assert.equal(denied.ok, true)
  assert.equal(denied.code, 'settled')
  assert.equal(denied.state, 'denied')

  const again = await decideApproval({
    store: space.store,
    approvalId: record.approvalId,
    decision: 'approve',
    now: NOW + 2000,
  })
  assert.equal(again.ok, false)
  assert.equal(again.code, 'already_settled')
  assert.equal(again.noop, true)
  assert.equal(again.state, 'denied', 'the earlier decision stands')

  const stored = await readApproval(space.store, record.approvalId)
  assert.equal(stored.state, 'denied')
  assert.equal(stored.decidedBy, 'ios-phone-1')
})

test('approve settles the record granted, and records who decided', async (t) => {
  const space = workspace(t)
  const record = await storedRecord(space)

  const granted = await decideApproval({
    store: space.store,
    approvalId: record.approvalId,
    decision: 'approve',
    decidedBy: 'browser-node-1',
    now: NOW + 1000,
  })
  assert.equal(granted.ok, true)
  assert.equal(granted.state, 'granted')

  const stored = await readApproval(space.store, record.approvalId)
  assert.equal(stored.state, 'granted')
  assert.equal(stored.decidedBy, 'browser-node-1')
})

test('a late approve is refused as expired; a late deny still lands', async (t) => {
  const space = workspace(t)
  const first = await storedRecord(space, { ttlMs: 60_000 })
  const late = NOW + 10 * 60_000

  const approve = await decideApproval({
    store: space.store,
    approvalId: first.approvalId,
    decision: 'approve',
    now: late,
  })
  assert.equal(approve.ok, false)
  assert.equal(approve.code, 'expired')
  assert.equal((await readApproval(space.store, first.approvalId)).state, 'refused')

  const second = await storedRecord(space, { ttlMs: 60_000 })
  const deny = await decideApproval({
    store: space.store,
    approvalId: second.approvalId,
    decision: 'deny',
    now: late,
  })
  assert.equal(deny.ok, true)
  assert.equal(deny.state, 'denied', 'a refusal is never wrong to record')
})

test('junk decisions and unknown ids answer with codes, not throws', async (t) => {
  const space = workspace(t)
  const record = await storedRecord(space)

  assert.equal(
    (await decideApproval({ store: space.store, approvalId: record.approvalId, decision: 'maybe' })).code,
    'invalid_decision',
  )
  assert.equal(
    (await decideApproval({ store: space.store, approvalId: 'apv_missing', decision: 'approve' })).code,
    'not_found',
  )
})

/* ------------------------------------------------------- the mesh reply */

test('an approval_decision envelope to @relay is consumed and settled in the send itself', async (t) => {
  const space = workspace(t)
  await pairNode(space.store, 'ios-phone-1', 'mobile')
  const record = await storedRecord(space, { origin: 'ios-phone-1' })
  const push = await routeApprovalPrompt({ store: space.store, record, now: NOW })

  const result = await sendNodeMessage({
    store: space.store,
    from: 'ios-phone-1',
    to: '@relay',
    kind: APPROVAL_DECISION_KIND,
    payload: { approvalId: record.approvalId, decision: 'approve' },
    correlationId: push.messageId,
    now: NOW + 1000,
    relayMail: consumeRelayApprovalMail,
  })

  assert.equal(result.consumed, true)
  assert.equal(result.queued, false)
  assert.equal(result.receipt.code, 'settled')
  assert.equal(result.receipt.state, 'granted')
  assert.equal(result.receipt.corr, push.messageId)

  const stored = await readApproval(space.store, record.approvalId)
  assert.equal(stored.state, 'granted')
  assert.equal(stored.decidedBy, 'ios-phone-1', 'decidedBy is the envelope sender, stamped by the relay')

  /* Consumed means consumed: nothing joined the @relay inbox to rot. */
  assert.equal(await space.store.countPendingNodeMessages('@relay', { now: NOW }), 0)
})

test('a redelivered decision is a no-op receipt, never an error', async (t) => {
  const space = workspace(t)
  const record = await storedRecord(space)
  await decideApproval({ store: space.store, approvalId: record.approvalId, decision: 'deny', now: NOW })

  const replay = await consumeRelayApprovalMail({
    store: space.store,
    envelope: {
      kind: APPROVAL_DECISION_KIND,
      from: 'ios-phone-1',
      corr: 'nmsg_original',
      payload: { approvalId: record.approvalId, decision: 'deny' },
    },
    now: NOW + 5000,
  })
  assert.equal(replay.consumed, true, 'redelivery must be absorbed or the lease loop replays it forever')
  assert.equal(replay.receipt.ok, false)
  assert.equal(replay.receipt.code, 'already_settled')
  assert.equal(replay.receipt.state, 'denied')
})

test('malformed decisions are consumed with a code; other kinds are left alone', async (t) => {
  const space = workspace(t)

  const empty = await consumeRelayApprovalMail({
    store: space.store,
    envelope: { kind: APPROVAL_DECISION_KIND, from: 'x', payload: {} },
    now: NOW,
  })
  assert.equal(empty.consumed, true)
  assert.equal(empty.receipt.code, 'invalid_decision')

  const unmatchable = await consumeRelayApprovalMail({
    store: space.store,
    envelope: { kind: APPROVAL_DECISION_KIND, from: 'x', payload: { approvalId: 'apv_gone', decision: 'deny' } },
    now: NOW,
  })
  assert.equal(unmatchable.consumed, true)
  assert.equal(unmatchable.receipt.code, 'not_found')

  const foreign = await consumeRelayApprovalMail({
    store: space.store,
    envelope: { kind: 'browser.tab.open', from: 'x', payload: {} },
    now: NOW,
  })
  assert.equal(foreign.consumed, false, 'the letterbox owns one kind and must not eat the rest')
})

test('mail to @relay of a kind nobody consumes still queues exactly as before', async (t) => {
  const space = workspace(t)
  const result = await sendNodeMessage({
    store: space.store,
    from: 'ios-phone-1',
    to: '@relay',
    kind: 'browser.tab.open',
    payload: { url: 'https://example.com' },
    now: NOW,
    relayMail: consumeRelayApprovalMail,
  })
  assert.equal(result.consumed, undefined)
  assert.equal(await space.store.countPendingNodeMessages('@relay', { now: NOW }), 1)
})

/* --------------------------------------------------- the spoken answer */

const streamed = async (space, record) => {
  const spoken = attestApprovalDelivery(record, {
    evidence: 'stream-complete',
    sentBytes: 4096,
    totalBytes: 4096,
    now: NOW + 500,
  })
  assert.equal(spoken.ok, true, spoken.why)
  await saveApproval(space.store, spoken.record, { now: NOW })
  return spoken.record
}

test('ordinary conversation is not an answer and torches nothing', async (t) => {
  const space = workspace(t)
  const record = await streamed(space, await storedRecord(space, { origin: 'nrf9160' }))

  const outcome = await answerSpokenApproval({
    store: space.store,
    approvalId: record.approvalId,
    utterance: 'what is my battery at',
    now: NOW + 1000,
  })
  assert.equal(outcome.code, 'not_an_answer')
  assert.equal(outcome.settled, false)
  assert.equal((await readApproval(space.store, record.approvalId)).state, 'pending')
})

test('a bare confirm word gets the repair line and the approval stays answerable', async (t) => {
  const space = workspace(t)
  const record = await streamed(space, await storedRecord(space, { origin: 'nrf9160' }))

  const outcome = await answerSpokenApproval({
    store: space.store,
    approvalId: record.approvalId,
    utterance: record.confirmWord,
    now: NOW + 1000,
  })
  assert.equal(outcome.code, 'confirm_word_alone')
  assert.equal(outcome.settled, false)
  assert.match(outcome.speak, new RegExp(`approve ${record.confirmWord}`))
  assert.equal((await readApproval(space.store, record.approvalId)).state, 'pending')
})

test('an assent missing its required word is repaired, not refused', async (t) => {
  const space = workspace(t)
  /* This plan carries a send_email, so the word is mandatory. */
  const record = await streamed(space, await storedRecord(space, { origin: 'nrf9160' }))
  assert.equal(record.requiresConfirmWord, true)

  const outcome = await answerSpokenApproval({
    store: space.store,
    approvalId: record.approvalId,
    utterance: 'yes go ahead',
    now: NOW + 1000,
  })
  assert.equal(outcome.code, 'needs_confirm_word')
  assert.equal(outcome.settled, false)
  assert.match(outcome.speak, new RegExp(record.confirmWord))
  assert.equal((await readApproval(space.store, record.approvalId)).state, 'pending')
})

test('a spoken no settles the approval denied', async (t) => {
  const space = workspace(t)
  const record = await streamed(space, await storedRecord(space, { origin: 'nrf9160' }))

  const outcome = await answerSpokenApproval({
    store: space.store,
    approvalId: record.approvalId,
    utterance: 'no, cancel that',
    now: NOW + 1000,
  })
  assert.equal(outcome.code, 'denied')
  assert.equal(outcome.settled, true)
  assert.ok(outcome.speak, 'the owner hears that the cancel landed')
  assert.equal((await readApproval(space.store, record.approvalId)).state, 'denied')
})

test('a spoken yes with the word grants: streamed, echoed, settled', async (t) => {
  const space = workspace(t)
  const record = await streamed(space, await storedRecord(space, { origin: 'nrf9160' }))

  const outcome = await answerSpokenApproval({
    store: space.store,
    approvalId: record.approvalId,
    utterance: `approve ${record.confirmWord}`,
    now: NOW + 1000,
  })
  assert.equal(outcome.code, 'granted')
  assert.equal(outcome.settled, true)
  assert.equal(outcome.speak, 'Approved.')

  const stored = await readApproval(space.store, record.approvalId)
  assert.equal(stored.state, 'granted')
  assert.equal(stored.decidedBy, 'pendant')
  assert.equal(stored.deliveryState, 'delivered', 'the echo is the delivery witness, recorded as such')
})

test('speakNextApproval with the origin filter keeps foreign prompts off the speaker', async (t) => {
  const space = workspace(t)
  await storedRecord(space, { origin: 'ios-phone-1' })
  const forPendant = await storedRecord(space, { origin: 'nrf9160' })

  const spoken = await speakNextApproval({
    store: space.store,
    deviceId: forPendant.deviceId,
    eligible: isPendantRoutedApproval,
    speak: async () => ({ sentBytes: 4096, totalBytes: 4096, stopped: false }),
    now: NOW + 1000,
  })
  assert.equal(spoken.spoke, true)
  assert.equal(spoken.approval.approvalId, forPendant.approvalId)
  /* And with everything foreign, nothing is spoken at all. */
  const nothing = await speakNextApproval({
    store: space.store,
    deviceId: forPendant.deviceId,
    eligible: (record) => record.origin === 'somewhere-else',
    speak: async () => ({ sentBytes: 4096, totalBytes: 4096, stopped: false }),
    now: NOW + 1000,
  })
  assert.equal(nothing.spoke, false)
  assert.equal(nothing.reason, 'nothing-waiting')
})

/* ------------------------------------------------------------ the route */

function fakeApp() {
  const routes = new Map()
  const register = (method) => (route, handler) => routes.set(`${method} ${route}`, handler)
  return {
    get: register('GET'),
    post: register('POST'),
    async call(method, route, { params = {}, body = {}, relayPrincipal = null } = {}) {
      const handler = routes.get(`${method} ${route}`)
      if (!handler) throw new Error(`No route registered for ${method} ${route}`)
      let statusCode = 200
      let payload = null
      const response = {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        },
      }
      await handler({ params, body, relayPrincipal }, response)
      return { statusCode, payload }
    },
  }
}

test('the decision route: a device principal decides under its own name', async (t) => {
  const space = workspace(t)
  /* The route runs on the wall clock, so this record must actually be live. */
  const record = await storedRecord(space, { now: Date.now() })
  const app = fakeApp()
  registerApprovalDeliveryRoutes(app, { getStore: async () => space.store })

  const granted = await app.call('POST', '/v1/approvals/:approvalId/decision', {
    params: { approvalId: record.approvalId },
    body: { decision: 'approve', decidedBy: 'spoofed-name' },
    relayPrincipal: { kind: 'device', deviceId: 'browser-node-1' },
  })
  assert.equal(granted.statusCode, 200)
  assert.equal(granted.payload.ok, true)
  assert.equal(granted.payload.state, 'granted')
  assert.equal(
    (await readApproval(space.store, record.approvalId)).decidedBy,
    'browser-node-1',
    'decidedBy comes from the credential, never the body',
  )

  const replay = await app.call('POST', '/v1/approvals/:approvalId/decision', {
    params: { approvalId: record.approvalId },
    body: { decision: 'deny' },
    relayPrincipal: { kind: 'device', deviceId: 'browser-node-1' },
  })
  assert.equal(replay.statusCode, 409)
  assert.equal(replay.payload.code, 'already_settled')

  const missing = await app.call('POST', '/v1/approvals/:approvalId/decision', {
    params: { approvalId: 'apv_missing' },
    body: { decision: 'deny' },
    relayPrincipal: { kind: 'admin' },
  })
  assert.equal(missing.statusCode, 404)

  const junk = await app.call('POST', '/v1/approvals/:approvalId/decision', {
    params: { approvalId: record.approvalId },
    body: { decision: 'shrug' },
    relayPrincipal: { kind: 'admin' },
  })
  assert.equal(junk.statusCode, 400)
})

/* ------------------------------------------- the hardware button (P0.23) */

/* A reversible-write-only plan: no WORD_REQUIRED tier, so the record does
 * not demand its confirm word and a blind button press may commit it. */
function writeOnlyRecord(space, overrides = {}) {
  space.file('quiet.txt', 'the original body')
  return prepareAction({
    command: 'tidy the quiet notes',
    actions: [
      {
        type: 'write_file',
        label: 'update the quiet file',
        params: { path: path.join(space.dir, 'quiet.txt'), content: 'tidied' },
      },
    ],
    filePath: space.ledger,
    now: NOW,
    ...overrides,
  }).approval
}

test('the blue button decides the oldest live pendant-routed approval, and only that', async (t) => {
  const space = workspace(t)
  /* Foreign origin first (oldest of all): must never be the button's target. */
  const foreign = writeOnlyRecord(space, { origin: 'dashboard', now: NOW - 2000 })
  await saveApproval(space.store, foreign, { now: NOW })
  const older = writeOnlyRecord(space, { origin: 'nrf9160', now: NOW - 1000 })
  await saveApproval(space.store, older, { now: NOW })
  const newer = writeOnlyRecord(space, { origin: 'nrf9160', now: NOW })
  await saveApproval(space.store, newer, { now: NOW })

  const pressed = await decideNextPendingApproval({
    store: space.store,
    deviceId: older.deviceId,
    decision: 'approve',
    now: NOW + 1000,
  })
  assert.equal(pressed.ok, true)
  assert.equal(pressed.code, 'settled')
  assert.equal(pressed.state, 'granted')
  assert.equal(pressed.approvalId, older.approvalId, 'oldest pendant record wins')

  const stored = await readApproval(space.store, older.approvalId)
  assert.equal(stored.state, 'granted')
  assert.equal(stored.decidedBy, 'pendant-button')
  assert.equal((await readApproval(space.store, newer.approvalId)).state, 'pending')
  assert.equal(
    (await readApproval(space.store, foreign.approvalId)).state,
    'pending',
    'a dashboard-routed prompt is never committed by the pendant button',
  )
})

test('a blind button press cannot commit a plan that demands its confirm word — but a hold still denies it', async (t) => {
  const space = workspace(t)
  const record = await storedRecord(space, { origin: 'nrf9160' })
  assert.equal(record.requiresConfirmWord, true, 'guard: this plan demands the word')

  const approve = await decideNextPendingApproval({
    store: space.store,
    deviceId: record.deviceId,
    decision: 'approve',
    now: NOW + 1000,
  })
  assert.equal(approve.ok, false)
  assert.equal(approve.code, 'nothing_pending')
  assert.equal((await readApproval(space.store, record.approvalId)).state, 'pending')

  const deny = await decideNextPendingApproval({
    store: space.store,
    deviceId: record.deviceId,
    decision: 'deny',
    now: NOW + 2000,
  })
  assert.equal(deny.ok, true)
  assert.equal(deny.state, 'denied', 'a refusal never needs the ritual')
  assert.equal(deny.approvalId, record.approvalId)
})

test('an explicit approvalId — the readback just spoken — is decided directly', async (t) => {
  const space = workspace(t)
  const record = await storedRecord(space, { origin: 'nrf9160' })
  assert.equal(record.requiresConfirmWord, true)

  /* The conversation identified the record by reading it back; the thumb
   * answers THAT record, same trust level as a dashboard click on a row. */
  const pressed = await decideNextPendingApproval({
    store: space.store,
    deviceId: record.deviceId,
    approvalId: record.approvalId,
    decision: 'approve',
    now: NOW + 1000,
  })
  assert.equal(pressed.ok, true)
  assert.equal(pressed.state, 'granted')
  assert.equal((await readApproval(space.store, record.approvalId)).decidedBy, 'pendant-button')
})

test('a button press with nothing waiting answers nothing_pending, never a throw', async (t) => {
  const space = workspace(t)
  const outcome = await decideNextPendingApproval({
    store: space.store,
    deviceId: 'nrf9160-pendant',
    decision: 'approve',
    now: NOW,
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'nothing_pending')
  assert.equal(outcome.approvalId, null)
})

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'

import { commitApproval, prepareAction } from '../local-agent/prepareApprove.js'
import {
  APPROVAL_STORE_CONTRACT,
  DELIVERY_EVIDENCE,
  DELIVERY_PROVES_HEARING,
  attestApprovalDelivery,
  confirmWordFor,
} from '../shared/approvalHandoff.js'
import {
  answerApproval,
  listApprovals,
  readApproval,
  registerApprovalRoutes,
  saveApproval,
  settleStoredApproval,
  speakNextApproval,
} from './approvalStore.js'
import { createMemoryStore } from './store/memoryStore.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.join(HERE, '..')

/*
 * A real ledger file, a real temp tree, and the real memory store rather than a
 * stub. The staleness check is a comparison of two filesystem readings and the
 * store contract is a claim about saveState/getState, so faking either would
 * test the assertion instead of the mechanism. The memory store is a faithful
 * stand-in for D1: same method signatures, same row shape.
 */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'approval-store-'))
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
    notes() {
      return fs.readFileSync(path.join(dir, 'notes.txt'), 'utf8')
    },
  }
}

function plan(space) {
  space.file('notes.txt', 'the original body')
  return [
    { type: 'write_file', label: 'update the notes file', params: { path: path.join(space.dir, 'notes.txt'), content: 'a new body' } },
    {
      type: 'send_email',
      label: 'email the summary to sam@example.com',
      params: { to: 'sam@example.com', subject: 'Summary', body: 'here it is' },
    },
  ]
}

function prepared(space, overrides = {}) {
  const actions = overrides.actions ?? plan(space)
  return {
    actions,
    ...prepareAction({ command: 'send sam the notes summary', actions, filePath: space.ledger, ...overrides }),
  }
}

/* A `speak` that behaves like streamAnnouncementPcm: it reports bytes. */
const streamedFully = (bytes = 4096) => async () => ({ sentBytes: bytes, totalBytes: bytes, stopped: false })

function sourceFiles() {
  const found = []
  const walk = (dir) => {
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name)
      if (entry.isDirectory()) {
        if (entry.name === 'node_modules' || entry.name === 'wasm') continue
        walk(full)
        continue
      }
      if (!entry.name.endsWith('.js') || entry.name.endsWith('.test.js')) continue
      found.push(full)
    }
  }
  for (const tree of ['shared', 'local-agent', 'cloud-relay']) walk(path.join(ROOT, tree))
  return found
}

function fakeApp() {
  const routes = new Map()
  const app = {
    get(routePath, handler) {
      routes.set(`get ${routePath}`, handler)
      return app
    },
    post(routePath, handler) {
      routes.set(`post ${routePath}`, handler)
      return app
    },
    async call(method, routePath, request = {}) {
      const handler = routes.get(`${method} ${routePath}`)
      if (!handler) throw new Error(`no route ${method} ${routePath}`)
      const captured = { status: 200, body: null }
      const response = {
        status(code) {
          captured.status = code
          return response
        },
        json(body) {
          captured.body = body
          return response
        },
      }
      await handler({ body: {}, params: {}, query: {}, ...request }, response)
      return captured
    },
  }
  return app
}

/* ================================================================= *
 * THE DEFECT THIS FILE WAS OPENED FOR
 *
 * APPROVAL_STORE_CONTRACT was a frozen object whose values are STRINGS naming
 * store calls. Nothing spoke it, so no record was ever persisted; and the only
 * function that set `deliveredAt` was imported by test files and nothing else.
 * Since evaluateApprovalGrant() refuses any grant whose `deliveredAt` is null,
 * the loop could be prepared, spoken and answered and never once completed.
 *
 * The three tests below are what proved it. Two of them still pass unchanged
 * afterwards, because they were never describing a bug — they describe the
 * safety property, which has to survive the fix. The third is the one that was
 * failing, and its passing is the fix.
 * ================================================================= */

test('an approval that was never spoken refuses a perfectly correct answer', (t) => {
  const space = workspace(t)
  const { approval, actions } = prepared(space)

  /* The owner says exactly what the readback told them to say. */
  const word = confirmWordFor(approval.planDigest)
  assert.ok(approval.readback.includes(word), 'the readback names the word')

  const result = commitApproval({ approval, utterance: `approve ${word}`, actions, filePath: space.ledger })

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'not-delivered')
  assert.equal(result.committed, false)
  assert.equal(space.notes(), 'the original body')
})

test('the store contract names the module that implements it', () => {
  /* The values are still prose — they are a design note and always were. What
   * was missing is the pointer to code that actually makes those calls. */
  for (const call of [...APPROVAL_STORE_CONTRACT.reads, ...APPROVAL_STORE_CONTRACT.writes]) {
    assert.equal(typeof call, 'string')
  }
  assert.equal(APPROVAL_STORE_CONTRACT.implementedBy, 'cloud-relay/approvalStore.js')
  assert.ok(fs.existsSync(path.join(ROOT, APPROVAL_STORE_CONTRACT.implementedBy)))

  /* And it still needs no new store method, which is what the note promised. */
  const store = createMemoryStore()
  assert.equal(typeof store.saveState, 'function')
  assert.equal(typeof store.getState, 'function')
})

test('deliveredAt has a writer outside the tests', () => {
  /*
   * The original defect in one assertion. `evaluateApprovalGrant` refuses on a
   * null `deliveredAt` — correctly — but the field had no writer anywhere a
   * running system could reach, so the precondition was unsatisfiable and the
   * capability was dead on arrival.
   */
  const writers = sourceFiles().filter((file) => {
    if (file.endsWith(path.join('shared', 'approvalHandoff.js'))) return false
    return /\battestApprovalDelivery\b/.test(fs.readFileSync(file, 'utf8'))
  })

  assert.ok(writers.length > 0, 'no non-test module attests delivery, so every grant is refused')
})

/* ================================================================= *
 * THE LOOP, END TO END
 * ================================================================= */

test('the whole loop completes: prepare, store, speak, answer, commit, settle', async (t) => {
  const space = workspace(t)
  const { approval, actions, relay } = prepared(space)

  /* 1. The Mac prepares and hands the record to the relay, which persists it
   *    against the contract — the real saveState/getState pair. */
  await saveApproval(space.store, approval)
  assert.equal((await space.store.getState(relay.stateKey))?.data?.approvalId, approval.approvalId)
  assert.equal((await listApprovals(space.store, approval.deviceId)).length, 1)

  /* 2. The owner presses the button. The relay reads out the oldest waiting
   *    readback and records what the streaming actually witnessed. */
  const spoke = await speakNextApproval({ store: space.store, deviceId: approval.deviceId, speak: streamedFully() })
  assert.equal(spoke.spoke, true)
  assert.equal(spoke.evidence.kind, 'stream-complete')
  assert.match(spoke.speech, new RegExp(`approve ${approval.confirmWord}`))

  /* ...and streaming is NOT delivery. This is the line the announcement path
   *    crosses and this one does not. */
  assert.equal(spoke.approval.deliveryState, 'spoken')
  assert.equal(spoke.approval.deliveredAt, null)

  /* 3. The owner answers. The word they say back is the only thing on this
   *    system that witnesses a human having heard the sentence. */
  const answered = await answerApproval({
    store: space.store,
    approvalId: approval.approvalId,
    utterance: `approve ${approval.confirmWord}`,
  })
  assert.equal(answered.ok, true)
  assert.equal(answered.decision, 'granted')
  assert.equal(answered.approval.deliveryState, 'delivered')
  assert.ok(answered.approval.deliveredAt)

  /* The relay must NOT have settled it. It has no filesystem, so it cannot run
   * the world check — and a record marked `granted` here would come back from
   * the Mac as `already-decided`, which is how a helpful write on this side
   * would silently break the commit. */
  assert.equal(answered.handOff, true)
  assert.equal((await readApproval(space.store, approval.approvalId)).state, 'pending')

  /* 4. The Mac commits: plan digest, then the world, then the answer. */
  const committed = commitApproval({
    approval: answered.approval,
    utterance: `approve ${approval.confirmWord}`,
    actions,
    filePath: space.ledger,
  })
  assert.equal(committed.ok, true)
  assert.equal(committed.committed, true)
  /* A commit produces actions; it does not perform them. */
  assert.equal(committed.executed, false)
  assert.equal(committed.actions.length, 2)
  assert.equal(space.notes(), 'the original body')

  /* The receipt says which witness the consent actually rests on. */
  assert.deepEqual(
    committed.verified.delivery.evidence.map((entry) => entry.kind),
    ['stream-complete', 'owner-echo'],
  )

  /* 5. The outcome goes back to the durable copy, because the replay guard
   *    lives in `state` and `state` lives on the relay. */
  const settled = await settleStoredApproval({
    store: space.store,
    approvalId: approval.approvalId,
    outcome: committed.approval,
  })
  assert.equal(settled.ok, true)
  assert.equal((await readApproval(space.store, approval.approvalId)).state, 'granted')
})

test('a committed approval cannot be committed twice', async (t) => {
  const space = workspace(t)
  const { approval, actions } = prepared(space)
  await saveApproval(space.store, approval)
  await speakNextApproval({ store: space.store, deviceId: approval.deviceId, speak: streamedFully() })

  const utterance = `approve ${approval.confirmWord}`
  const first = await answerApproval({ store: space.store, approvalId: approval.approvalId, utterance })
  const committed = commitApproval({ approval: first.approval, utterance, actions, filePath: space.ledger })
  await settleStoredApproval({ store: space.store, approvalId: approval.approvalId, outcome: committed.approval })

  /* A double button press, a retried delivery, a resent request. */
  const again = await answerApproval({ store: space.store, approvalId: approval.approvalId, utterance })
  assert.equal(again.ok, false)
  assert.equal(again.reason, 'already-decided')
})

test('a denial settles on the relay without needing the Mac at all', async (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)
  await saveApproval(space.store, approval)
  await speakNextApproval({ store: space.store, deviceId: approval.deviceId, speak: streamedFully() })

  /*
   * "No" is not consent, so the delivery gate has no business standing in front
   * of it. A denial that came back as `not-delivered` would leave the record
   * pending for something else to grant later — the failure the gate exists to
   * prevent, arriving through the gate itself.
   */
  const answered = await answerApproval({
    store: space.store,
    approvalId: approval.approvalId,
    utterance: 'no, cancel that',
  })

  assert.equal(answered.decision, 'denied')
  assert.equal((await readApproval(space.store, approval.approvalId)).state, 'denied')
})

/* ================================================================= *
 * FAILING CLOSED
 * ================================================================= */

test('no amount of streaming ever becomes delivery', async (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)
  await saveApproval(space.store, approval)

  for (let attempt = 0; attempt < 3; attempt += 1) {
    await speakNextApproval({ store: space.store, deviceId: approval.deviceId, speak: streamedFully() })
  }

  const record = await readApproval(space.store, approval.approvalId)
  assert.equal(record.attempts, 3)
  assert.equal(record.spokenAt !== null, true)
  /* Three complete streams, and the owner may have been in another room for all
   * three. Bytes accepted by a socket are not a person hearing words. */
  assert.equal(record.deliveredAt, null)
  assert.equal(record.deliveryState, 'spoken')
})

test('a stream that sent nothing leaves the approval untouched and still deliverable', async (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)
  await saveApproval(space.store, approval)

  const spoke = await speakNextApproval({
    store: space.store,
    deviceId: approval.deviceId,
    speak: async () => ({ sentBytes: 0, totalBytes: 4096, stopped: true }),
  })

  assert.equal(spoke.spoke, false)
  assert.equal(spoke.reason, 'nothing-sent')
  const record = await readApproval(space.store, approval.approvalId)
  assert.equal(record.spokenAt, null)
  assert.equal(record.state, 'pending', 'still waiting for the next button press')
})

test('a speak that throws is not a delivery', async (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)
  await saveApproval(space.store, approval)

  const spoke = await speakNextApproval({
    store: space.store,
    deviceId: approval.deviceId,
    speak: async () => {
      throw new Error('TTS is down')
    },
  })

  assert.equal(spoke.spoke, false)
  assert.equal(spoke.reason, 'speak-failed')
  assert.equal((await readApproval(space.store, approval.approvalId)).deliveryState, 'undelivered')
})

test('a truncated readback is graded down, whatever the caller called it', (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)

  /* The caller says `stream-complete`; the byte counts say otherwise, and the
   * byte counts win. A readback names what cannot be undone in the MIDDLE, so a
   * truncated one may never have said it. */
  const attested = attestApprovalDelivery(approval, {
    evidence: 'stream-complete',
    sentBytes: 100,
    totalBytes: 4096,
    stopped: true,
  })

  assert.equal(attested.ok, true)
  assert.equal(attested.evidence.kind, 'stream-partial')
  assert.equal(attested.record.deliveredAt, null)
})

test('an unknown kind of evidence proves nothing', (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)

  for (const evidence of ['', null, 'delivered', 'heard', 'device-said-so']) {
    const attested = attestApprovalDelivery(approval, { evidence })
    assert.equal(attested.ok, false, String(evidence))
    assert.equal(attested.reason, 'unknown-evidence')
    /* Unchanged, not partially marked. A claim that did not convince must not
     * leave a residue a later one could build on. */
    assert.equal(attested.record.deliveredAt, null)
    assert.equal(attested.record.spokenAt, null)
  }
})

test('playback confirmation is declared and refused, because nothing emits it', (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)

  /*
   * `device_playback` is a pipeline stage with readers in cloud-relay/jobs.js
   * and local-agent/pipelineTrace.js and no writer anywhere. It is the rung that
   * SHOULD carry delivery, and it does not exist — so it is named in the
   * vocabulary, where the gap is visible, and refused in the code, because a
   * rung nothing can produce is a rung anything could claim.
   */
  assert.equal(DELIVERY_EVIDENCE['playback-report'].availableToday, false)
  assert.match(DELIVERY_EVIDENCE['playback-report'].gap, /device_playback/)

  const attested = attestApprovalDelivery(approval, { evidence: 'playback-report' })
  assert.equal(attested.ok, false)
  assert.equal(attested.reason, 'evidence-unavailable')
  assert.equal(attested.record.deliveredAt, null)
})

test('the confirm word proves nothing unless the readback was actually streamed', (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)

  /*
   * The word is derived from the plan digest and was never a secret — the module
   * says so where CONFIRM_WORDS is defined. Anybody holding the record can
   * compute it, so an echo on its own witnesses only that somebody holds the
   * record. What cannot be forged is the conjunction: the relay streamed this
   * readback to this device, AND a voice then said the word back.
   */
  const forged = attestApprovalDelivery(approval, {
    evidence: 'owner-echo',
    transcript: `approve ${confirmWordFor(approval.planDigest)}`,
  })

  assert.equal(forged.ok, false)
  assert.equal(forged.reason, 'not-spoken')
  assert.equal(forged.record.deliveredAt, null)
})

test('the wrong word, or no word, is not an echo', (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)
  const spoken = attestApprovalDelivery(approval, {
    evidence: 'stream-complete', sentBytes: 4096, totalBytes: 4096,
  }).record

  for (const transcript of ['yes go ahead', 'approve it', '', null, 'approve pelican and approve granite']) {
    const attested = attestApprovalDelivery(spoken, { evidence: 'owner-echo', transcript })
    if (String(transcript ?? '').includes(spoken.confirmWord)) continue
    assert.equal(attested.ok, false, String(transcript))
    assert.equal(attested.reason, 'no-echo')
    assert.equal(attested.record.deliveredAt, null)
  }
})

test('an answer with no witness refuses, and says what would fix it', async (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)
  await saveApproval(space.store, approval)
  await speakNextApproval({ store: space.store, deviceId: approval.deviceId, speak: streamedFully() })

  const answered = await answerApproval({
    store: space.store,
    approvalId: approval.approvalId,
    utterance: 'yes, go ahead',
  })

  assert.equal(answered.ok, false)
  /* Recoverable by one more sentence, and the sentence is supplied rather than
   * left for the caller to invent. */
  assert.match(answered.speak, new RegExp(`approve ${approval.confirmWord}`))
  assert.equal((await readApproval(space.store, approval.approvalId)).deliveredAt, null)
})

test('only evidence that witnesses a person can set deliveredAt', () => {
  /* The ladder is the whole safety argument, so it is asserted rather than
   * described. */
  assert.deepEqual([...DELIVERY_PROVES_HEARING].sort(), ['owner-echo', 'playback-report'])
  for (const [kind, grade] of Object.entries(DELIVERY_EVIDENCE)) {
    if (grade.provesEar) continue
    assert.equal(grade.witness, 'the relay socket', kind)
    assert.ok(grade.gap, `${kind} must say what it does not prove`)
  }
})

/* ================================================================= *
 * ROUTES
 * ================================================================= */

test('the routes carry the loop and none of them commits', async (t) => {
  const space = workspace(t)
  const app = fakeApp()
  registerApprovalRoutes(app, { getStore: async () => space.store })

  const { approval } = prepared(space)

  const stored = await app.call('post', '/v1/approvals', { body: { approval } })
  assert.equal(stored.status, 201)

  const listed = await app.call('get', '/v1/approvals', { query: { deviceId: approval.deviceId } })
  assert.equal(listed.body.readOnly, true)
  assert.equal(listed.body.waiting, 1)
  assert.equal(listed.body.next.approval.approvalId, approval.approvalId)

  const spoken = await app.call('post', `/v1/approvals/:approvalId/spoken`, {
    params: { approvalId: approval.approvalId },
    body: { sentBytes: 4096, totalBytes: 4096 },
  })
  assert.equal(spoken.body.ok, true)
  assert.equal(spoken.body.approval.deliveryState, 'spoken')
  assert.equal(spoken.body.approval.deliveredAt, null)

  const answered = await app.call('post', `/v1/approvals/:approvalId/answer`, {
    params: { approvalId: approval.approvalId },
    body: { utterance: `approve ${approval.confirmWord}` },
  })
  assert.equal(answered.body.ok, true)
  assert.equal(answered.body.handOff, true, 'the relay hands a grant to the Mac rather than committing it')
  assert.equal(space.notes(), 'the original body')
})

test('a record arriving over HTTP cannot claim its own delivery', async (t) => {
  const space = workspace(t)
  const app = fakeApp()
  registerApprovalRoutes(app, { getStore: async () => space.store })

  const { approval } = prepared(space)
  /* Delivery is witnessed on the relay and nowhere else. A prepared record that
   * turns up already claiming to have been heard is the exact forgery the whole
   * check exists to stop. */
  const forged = await app.call('post', '/v1/approvals', {
    body: { approval: { ...approval, deliveredAt: new Date().toISOString(), deliveryState: 'delivered' } },
  })

  assert.equal(forged.status, 400)
  assert.equal(await readApproval(space.store, approval.approvalId), null)
})

test('a refusal is a 200 so nobody retries it as a transport failure', async (t) => {
  const space = workspace(t)
  const app = fakeApp()
  registerApprovalRoutes(app, { getStore: async () => space.store })

  const { approval } = prepared(space)
  await app.call('post', '/v1/approvals', { body: { approval } })

  const answered = await app.call('post', `/v1/approvals/:approvalId/answer`, {
    params: { approvalId: approval.approvalId },
    body: { utterance: `approve ${approval.confirmWord}` },
  })

  assert.equal(answered.status, 200)
  assert.equal(answered.body.reason, 'not-delivered')
})

test('the routes refuse an app that is not Express-shaped', () => {
  assert.throws(() => registerApprovalRoutes(null), /Express-style app/)
  assert.throws(() => registerApprovalRoutes({ get() {} }), /Express-style app/)
})

/* ================================================================= *
 * STORAGE
 * ================================================================= */

test('an index entry pointing at a row that is gone does not break the read', async (t) => {
  const space = workspace(t)
  const first = prepared(space).approval
  const second = prepared(space).approval
  await saveApproval(space.store, first)
  await saveApproval(space.store, second)

  /* A bounded store dropping the tail of an index is ordinary; it must not make
   * the live approvals unreadable. */
  await space.store.saveState(`approval:${first.approvalId}`, null)

  const records = await listApprovals(space.store, first.deviceId)
  assert.deepEqual(records.map((record) => record.approvalId), [second.approvalId])
})

test('settling a record that was already decided changes nothing', async (t) => {
  const space = workspace(t)
  const { approval } = prepared(space)
  await saveApproval(space.store, approval)

  const once = await settleStoredApproval({
    store: space.store,
    approvalId: approval.approvalId,
    outcome: { decision: 'granted', decidedBy: 'pendant' },
  })
  assert.equal(once.ok, true)

  const twice = await settleStoredApproval({
    store: space.store,
    approvalId: approval.approvalId,
    outcome: { decision: 'denied', decidedBy: 'someone-else' },
  })
  assert.equal(twice.ok, false)
  assert.equal(twice.reason, 'already-decided')
  assert.equal((await readApproval(space.store, approval.approvalId)).state, 'granted')
})

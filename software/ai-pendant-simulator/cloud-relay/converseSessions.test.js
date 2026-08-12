import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { prepareAction } from '../local-agent/prepareApprove.js'
import { routeApprovalPrompt } from './approvalDelivery.js'
import { readApproval, saveApproval } from './approvalStore.js'
import {
  hasConverseSession,
  nudgeConverseSession,
  registerConverseSession,
} from './converseSessions.js'
import { createMemoryStore } from './store/memoryStore.js'

const NOW = Date.parse('2026-08-09T09:00:00.000Z')
const DEVICE = 'nrf9160-pendant'

/* Same conventions as approvalDelivery.test.js: the real memory store and
 * records from the real prepare path, because "a pendant-routed record nudges
 * the live session" is a claim about those records. */
function workspace(t) {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'converse-sessions-'))
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }))
  return { dir, ledger: path.join(dir, 'ledger.json'), store: createMemoryStore() }
}

async function storedRecord(space, overrides = {}) {
  const target = path.join(space.dir, 'notes.txt')
  fs.writeFileSync(target, 'the original body')
  const { approval } = prepareAction({
    command: 'send sam the notes summary',
    actions: [
      {
        type: 'write_file',
        label: 'update the notes file',
        params: { path: target, content: 'a new body' },
      },
    ],
    filePath: space.ledger,
    now: NOW,
    ...overrides,
  })
  await saveApproval(space.store, approval, { now: NOW })
  return approval
}

/* A stand-in for the handle pendantConverse registers: counts calls the way
 * queueApprovalReadback would absorb them. */
function fakeSession() {
  const handle = {
    calls: 0,
    speakApprovals() {
      handle.calls += 1
      return Promise.resolve()
    },
  }
  return handle
}

test('an approval saved while the converse session is open nudges that session to speak', async (t) => {
  const space = workspace(t)
  const session = fakeSession()
  const unregister = registerConverseSession(DEVICE, session)
  t.after(unregister)

  const record = await storedRecord(space, { origin: 'live_lte' })
  const outcome = await routeApprovalPrompt({ store: space.store, record, now: NOW })

  assert.equal(outcome.channel, 'pendant-speech')
  assert.equal(outcome.queued, true, 'the store remains the delivery of record')
  assert.equal(outcome.nudged, true, 'the open conversation was told to read it now')
  assert.equal(session.calls, 1, 'exactly one readback was asked for')
})

test('with the session closed, the record is store-only and waits for the next press', async (t) => {
  const space = workspace(t)
  const session = fakeSession()
  registerConverseSession(DEVICE, session)()

  const record = await storedRecord(space, { origin: 'nrf9160' })
  const outcome = await routeApprovalPrompt({ store: space.store, record, now: NOW })

  assert.equal(outcome.channel, 'pendant-speech')
  assert.equal(outcome.queued, true)
  assert.equal(outcome.nudged, false, 'no socket, no nudge — and no error either')
  assert.equal(session.calls, 0)

  /* The old behaviour is intact: the record sits pending in the store, which
   * is what the next button press reads. */
  const stored = await readApproval(space.store, record.approvalId)
  assert.equal(stored?.state, 'pending')
})

test('a non-pendant origin never nudges the conversation, even when one is open', async (t) => {
  const space = workspace(t)
  const session = fakeSession()
  const unregister = registerConverseSession(DEVICE, session)
  t.after(unregister)

  const record = await storedRecord(space, { origin: 'dashboard' })
  const outcome = await routeApprovalPrompt({ store: space.store, record, now: NOW })

  assert.equal(outcome.channel, 'mac-agent')
  assert.equal(outcome.nudged, false)
  assert.equal(session.calls, 0, 'a Mac-surface prompt stays off the speaker')
})

test('a stale unregister cannot evict the successor session (sequential socket reuse)', (t) => {
  const first = fakeSession()
  const unregisterFirst = registerConverseSession(DEVICE, first)
  const second = fakeSession()
  const unregisterSecond = registerConverseSession(DEVICE, second)
  t.after(unregisterSecond)

  /* The old conversation's teardown runs after the restart registered the new
   * one — the exact ordering endConversation can produce. */
  unregisterFirst()
  assert.equal(hasConverseSession(DEVICE), true, 'the live session survived the stale teardown')

  const outcome = nudgeConverseSession(DEVICE)
  assert.equal(outcome.nudged, true)
  assert.equal(second.calls, 1)
  assert.equal(first.calls, 0)
})

test('a session whose speakApprovals throws costs the nudge, never the save', async (t) => {
  const space = workspace(t)
  const unregister = registerConverseSession(DEVICE, {
    speakApprovals() {
      throw new Error('encoder already destroyed')
    },
  })
  t.after(unregister)

  const record = await storedRecord(space, { origin: 'pendant_upload' })
  const outcome = await routeApprovalPrompt({ store: space.store, record, now: NOW })

  assert.equal(outcome.queued, true, 'the record is still delivered by the store')
  assert.equal(outcome.nudged, false)
  assert.equal((await readApproval(space.store, record.approvalId))?.state, 'pending')
})

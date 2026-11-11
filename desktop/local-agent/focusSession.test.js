import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  activeFocusSession,
  describeBlocked,
  endFocusSession,
  focusStatus,
  resumeFocusSessions,
  startFocusSession,
} from './focusSession.js'

/*
 * Every test runs with distractions:[] and mute:false, so nothing here touches
 * the owner's running apps or their volume. What is under test is the part that
 * has to be right when the process dies: the durable record of the promise.
 */
const QUIET = { distractions: [], mute: false }

function sandbox(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-focus-test-'))
  process.env.PENDANT_FOCUS_STORE_PATH = path.join(directory, 'focus.json')
  t.after(() => {
    delete process.env.PENDANT_FOCUS_STORE_PATH
    fs.rmSync(directory, { force: true, recursive: true })
  })
}

test('a session records when it ends before it blocks anything', async (t) => {
  sandbox(t)
  const now = Date.now()
  const session = await startFocusSession({ minutes: 25, now, ...QUIET })

  assert.equal(session.minutes, 25)
  assert.equal(session.endsAt, now + 25 * 60_000)
  assert.equal(activeFocusSession().id, session.id)

  await endFocusSession({ id: session.id, reason: 'cancelled', announce: false })
})

test('the end time survives the process — status is read from disk', async (t) => {
  sandbox(t)
  const now = Date.now()
  const session = await startFocusSession({ minutes: 25, now, ...QUIET })

  const status = focusStatus({ now: now + 10 * 60_000 })
  assert.equal(status.running, true)
  assert.equal(status.remainingMinutes, 15)
  assert.equal(status.id, session.id)

  await endFocusSession({ id: session.id, reason: 'cancelled', announce: false })
})

test('a second session is refused rather than silently replacing the first', async (t) => {
  sandbox(t)
  const first = await startFocusSession({ minutes: 25, ...QUIET })
  await assert.rejects(() => startFocusSession({ minutes: 10, ...QUIET }), /already running/)
  await endFocusSession({ id: first.id, reason: 'cancelled', announce: false })
})

test('a session that outlived the process is ended, late, rather than dropped', async (t) => {
  sandbox(t)
  const started = Date.now() - 40 * 60_000
  await startFocusSession({ minutes: 25, now: started, ...QUIET })

  const resumed = await resumeFocusSessions({ now: Date.now(), announce: false })
  assert.deepEqual(
    resumed.map((entry) => entry.outcome),
    ['ended-late'],
    'the owner is owed the alarm even if the agent was down for it',
  )
  assert.equal(activeFocusSession(), null)
})

test('a session still inside its window is re-armed, not ended', async (t) => {
  sandbox(t)
  const session = await startFocusSession({ minutes: 60, now: Date.now() - 60_000, ...QUIET })

  const resumed = await resumeFocusSessions({ now: Date.now(), announce: false })
  assert.equal(resumed[0].outcome, 'rearmed')
  assert.equal(activeFocusSession().id, session.id)

  await endFocusSession({ id: session.id, reason: 'cancelled', announce: false })
})

test('ending twice is not an error', async (t) => {
  sandbox(t)
  const session = await startFocusSession({ minutes: 5, ...QUIET })
  await endFocusSession({ id: session.id, announce: false })
  const again = await endFocusSession({ id: session.id, announce: false })
  assert.equal(again.alreadyEnded, true)
})

test('a nonsense duration is clamped, not obeyed', async (t) => {
  sandbox(t)
  const session = await startFocusSession({ minutes: -5, ...QUIET })
  assert.equal(session.minutes, 1)
  await endFocusSession({ id: session.id, reason: 'cancelled', announce: false })
})

test('unmuting only happens when this session did the muting', async (t) => {
  sandbox(t)
  // volumeWasMuted true means the owner was already silent before we arrived.
  const blocked = { hidden: [], muted: true, volumeWasMuted: true, failures: [] }
  assert.match(describeBlocked(blocked), /Muted notification sounds/)

  const nothing = { hidden: [], muted: false, volumeWasMuted: null, failures: [] }
  assert.match(describeBlocked(nothing), /already clear/)
})

test('the spoken start line says what was actually blocked', async (t) => {
  sandbox(t)
  const session = await startFocusSession({ minutes: 25, ...QUIET })
  assert.match(session.spoken, /25 minutes/)
  assert.match(session.spoken, /time's up/)
  await endFocusSession({ id: session.id, reason: 'cancelled', announce: false })
})

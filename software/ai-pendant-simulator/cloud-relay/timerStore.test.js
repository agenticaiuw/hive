import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_TIMER_MS,
  cancelTimers,
  claimDueTimers,
  createTimerControl,
  createTimerRecord,
  describeDuration,
  describeDurationShort,
  indexTimer,
  listTimers,
  remainingMs,
  selectDueTimers,
  selectRunningTimers,
  settleClaimedTimer,
  startTimer,
  timerCancelledSpeech,
  timerDoneSpeech,
  timerIndexKey,
  timerOverdueSpeech,
  timerRemainingSpeech,
  timerStartedSpeech,
  timerStateKey,
} from './timerStore.js'
import { createMemoryStore } from './store/memoryStore.js'

/*
 * The real memory store, not a stub. The whole claim of this module is that a
 * relay-held timer needs NO new store methods — it rides the same
 * getState/saveState pair approvals ride — and a fake with two maps in it
 * would prove that claim by assuming it.
 */
const DEVICE = 'nrf9160-pendant'
const T0 = Date.parse('2026-08-12T15:00:00.000Z')
const MIN = 60_000

test('a duration is spoken, never printed as digits', () => {
  assert.equal(describeDuration(1 * MIN), '1 minute')
  assert.equal(describeDuration(10 * MIN), '10 minutes')
  assert.equal(describeDuration(60 * MIN), '1 hour')
  assert.equal(describeDuration(90 * MIN), '1 hour 30 minutes')
  assert.equal(describeDuration(120 * MIN), '2 hours')
  assert.equal(describeDuration(30_000), '30 seconds')
})

/*
 * The "s" that makes a device sound broken. A TTS voice reads exactly what it
 * is handed, so "ten minutes timer started" ships as a defect the moment a
 * measure is used as an adjective. This is why there are two formatters.
 */
test('a duration used as an adjective drops the plural', () => {
  assert.equal(describeDurationShort(10 * MIN), '10 minute')
  assert.equal(describeDurationShort(1 * MIN), '1 minute')
  assert.equal(describeDurationShort(60 * MIN), '1 hour')
  assert.equal(describeDurationShort(120 * MIN), '2 hour')
  /* Not "1 hour 30 minute timer" — that is not a thing anyone says. */
  assert.equal(describeDurationShort(90 * MIN), '90 minute')
})

test('a timer is refused rather than quietly shortened', () => {
  assert.throws(() => createTimerRecord({ deviceId: DEVICE, minutes: 0 }), /positive duration/)
  assert.throws(() => createTimerRecord({ deviceId: DEVICE, durationMs: MAX_TIMER_MS + 1 }), /24 hours/)
  /* A silently clamped timer is the kind of helpfulness that leaves somebody's
   * laundry in the machine. */
  assert.doesNotThrow(() => createTimerRecord({ deviceId: DEVICE, durationMs: MAX_TIMER_MS }))
})

test('it rides getState/saveState and adds no store methods', async () => {
  const store = createMemoryStore()
  const record = await startTimer({ store, deviceId: DEVICE, minutes: 10, now: T0 })

  assert.equal((await store.getState(timerStateKey(record.timerId)))?.data?.timerId, record.timerId)
  const index = (await store.getState(timerIndexKey(DEVICE)))?.data
  assert.deepEqual(
    index.entries.map((entry) => entry.timerId),
    [record.timerId],
  )
  assert.equal(record.expiresAt, new Date(T0 + 10 * MIN).toISOString())
})

test('a timer is running until its expiry, then due', () => {
  const record = createTimerRecord({ deviceId: DEVICE, minutes: 10, now: T0 })
  assert.deepEqual(selectRunningTimers([record], T0 + 9 * MIN), [record])
  assert.deepEqual(selectDueTimers([record], T0 + 9 * MIN), [])
  assert.deepEqual(selectDueTimers([record], T0 + 10 * MIN), [record])
  assert.equal(remainingMs(record, T0 + 4 * MIN), 6 * MIN)
  assert.equal(remainingMs(record, T0 + 99 * MIN), 0)
})

test('the chime names the duration, because by then the owner has forgotten', () => {
  const record = createTimerRecord({ deviceId: DEVICE, minutes: 10, now: T0 })
  assert.equal(timerStartedSpeech(record), '10 minute timer started.')
  assert.equal(timerDoneSpeech(record), 'Your 10 minute timer is done.')
  const labelled = createTimerRecord({ deviceId: DEVICE, minutes: 5, label: 'the pasta', now: T0 })
  assert.equal(timerStartedSpeech(labelled), '5 minute timer set for the pasta.')
  assert.equal(timerDoneSpeech(labelled), 'Your 5 minute timer for the pasta is done.')
})

/*
 * The queue-to-next-press half, spoken honestly. A chime that fired an hour
 * ago and is only now being read out must SAY it fired an hour ago — otherwise
 * the owner reaches for a pan that has been off the heat since lunch.
 */
test('an overdue chime says how late it is; a fresh one does not', () => {
  const record = createTimerRecord({ deviceId: DEVICE, minutes: 10, now: T0 })
  const firedAt = T0 + 10 * MIN
  assert.equal(timerOverdueSpeech(record, firedAt + 3_000), timerDoneSpeech(record))
  assert.match(timerOverdueSpeech(record, firedAt + 42 * MIN), /That was 42 minutes ago\.$/)
})

test('remaining time reads back one timer plainly and several briefly', () => {
  assert.equal(timerRemainingSpeech([], T0), 'You have no timers running.')
  const ten = createTimerRecord({ deviceId: DEVICE, minutes: 10, now: T0 })
  assert.equal(timerRemainingSpeech([ten], T0 + 4 * MIN), '6 minutes left on your 10 minute timer.')
  const hour = createTimerRecord({ deviceId: DEVICE, minutes: 60, now: T0 })
  assert.match(timerRemainingSpeech([ten, hour], T0 + 4 * MIN), /^You have 2 timers running: /)
})

test('cancelling reports what was actually cancelled', async () => {
  const store = createMemoryStore()
  await startTimer({ store, deviceId: DEVICE, minutes: 10, now: T0 })
  await startTimer({ store, deviceId: DEVICE, minutes: 30, now: T0 })

  const cancelled = await cancelTimers({ store, deviceId: DEVICE, now: T0 + MIN })
  assert.equal(cancelled.length, 2)
  assert.equal(timerCancelledSpeech(cancelled), 'Cancelled 2 timers.')
  assert.deepEqual(selectRunningTimers(await listTimers(store, DEVICE), T0 + MIN), [])

  /* Nothing running is a fact with its own sentence, not an error. */
  assert.equal(timerCancelledSpeech(await cancelTimers({ store, deviceId: DEVICE, now: T0 + MIN })), 'You have no timers running.')
})

test('a cancelled timer never comes due again', async () => {
  const store = createMemoryStore()
  const record = await startTimer({ store, deviceId: DEVICE, minutes: 10, now: T0 })
  await cancelTimers({ store, deviceId: DEVICE, timerId: record.timerId, now: T0 + MIN })
  assert.deepEqual(await claimDueTimers({ store, deviceId: DEVICE, now: T0 + 99 * MIN }), [])
})

/*
 * THE DOUBLE-CHIME GUARD. A reconnect racing a stale socket means two sweeps
 * can run against one store within milliseconds. Hearing your timer go off
 * twice is exactly how an owner learns to stop trusting it, so the claim is
 * what makes the second sweep find nothing.
 */
test('a due timer is claimed once, so two sweeps cannot both chime it', async () => {
  const store = createMemoryStore()
  const record = await startTimer({ store, deviceId: DEVICE, minutes: 10, now: T0 })
  const at = T0 + 11 * MIN

  const first = await claimDueTimers({ store, deviceId: DEVICE, now: at })
  assert.deepEqual(first.map((r) => r.timerId), [record.timerId])
  assert.deepEqual(await claimDueTimers({ store, deviceId: DEVICE, now: at }), [])

  await settleClaimedTimer({ store, timerId: record.timerId, spoke: true, now: at })
  const settled = (await listTimers(store, DEVICE)).find((r) => r.timerId === record.timerId)
  assert.equal(settled.state, 'done')
  assert.equal(settled.spokenAt, new Date(at).toISOString())
  assert.deepEqual(await claimDueTimers({ store, deviceId: DEVICE, now: at + MIN }), [])
})

/*
 * THE QUEUE-TO-NEXT-PRESS GUARANTEE. This is the one that matters most: with
 * no conversation open the chime cannot be spoken, and a claim that is not
 * settled as spoken MUST come back. Losing it here would be a timer that
 * silently never goes off — which is worse than a device with no timer at all,
 * because the owner stopped watching the clock.
 */
test('a chime that never made it out goes back on the queue for the next press', async () => {
  const store = createMemoryStore()
  const record = await startTimer({ store, deviceId: DEVICE, minutes: 10, now: T0 })
  const fired = T0 + 11 * MIN

  await claimDueTimers({ store, deviceId: DEVICE, now: fired })
  await settleClaimedTimer({ store, timerId: record.timerId, spoke: false, now: fired })

  /* Still due, because its expiry is still in the past. The next press sweeps
   * it up and speaks it late — with "that was N ago" attached. */
  const nextPress = fired + 40 * MIN
  const again = await claimDueTimers({ store, deviceId: DEVICE, now: nextPress })
  assert.deepEqual(again.map((r) => r.timerId), [record.timerId])
  /* Late is measured from the EXPIRY, not from the failed attempt: the owner
   * wants to know how stale the fact is, not how long the relay struggled. */
  assert.match(timerOverdueSpeech(again[0], nextPress), /41 minutes ago/)
})

test('several due timers chime oldest first', async () => {
  const store = createMemoryStore()
  const short = await startTimer({ store, deviceId: DEVICE, minutes: 1, now: T0 })
  const long = await startTimer({ store, deviceId: DEVICE, minutes: 5, now: T0 })
  const claimed = await claimDueTimers({ store, deviceId: DEVICE, now: T0 + 10 * MIN })
  assert.deepEqual(claimed.map((r) => r.timerId), [short.timerId, long.timerId])
})

test('a missing row is skipped, not raised — a bounded store loses tails', async () => {
  const store = createMemoryStore()
  const record = await startTimer({ store, deviceId: DEVICE, minutes: 10, now: T0 })
  await store.saveState(timerStateKey(record.timerId), { junk: true })
  assert.deepEqual(await listTimers(store, DEVICE), [])
})

test('the index keeps running timers and ages settled ones out', () => {
  const running = createTimerRecord({ deviceId: DEVICE, minutes: 600, now: T0 })
  let index = indexTimer(null, running, { now: T0 })

  /* An ancient settled entry rides along, then falls off once it is stale. */
  index = {
    ...index,
    entries: [
      { timerId: 'old', state: 'done', settledAt: new Date(T0 - 12 * 60 * MIN).toISOString() },
      ...index.entries,
    ],
  }
  const later = indexTimer(index, createTimerRecord({ deviceId: DEVICE, minutes: 1, now: T0 }), { now: T0 })
  assert.ok(!later.entries.some((entry) => entry.timerId === 'old'))
  assert.ok(later.entries.some((entry) => entry.timerId === running.timerId))
})

test('the index is bounded, and settled entries are evicted before running ones', () => {
  let index = null
  const settled = []
  for (let i = 0; i < 10; i += 1) {
    const done = { ...createTimerRecord({ deviceId: DEVICE, minutes: 5, now: T0 + i }), state: 'done' }
    settled.push(done.timerId)
    index = indexTimer(index, done, { now: T0 + i })
  }
  const soonest = createTimerRecord({ deviceId: DEVICE, minutes: 1, now: T0 })
  index = indexTimer(index, soonest, { now: T0 })
  for (let i = 0; i < 60; i += 1) {
    index = indexTimer(index, createTimerRecord({ deviceId: DEVICE, minutes: 90 + i, now: T0 + i }), { now: T0 + i })
  }

  assert.ok(index.entries.length <= 32)
  /* The one about to fire is the one the owner is standing there waiting for. */
  assert.ok(index.entries.some((entry) => entry.timerId === soonest.timerId))
  /* And the finished ones went first, rather than crowding out live timers. */
  assert.ok(!index.entries.some((entry) => settled.includes(entry.timerId)))
})

/*
 * VOICE PARITY, at the seam where it can actually be proven: one store, one
 * clock, one set of sentences. The knob writes through startTimer and the
 * model writes through createTimerControl — if these ever became two systems,
 * this is the test that would fail first.
 */
test('a knob-set timer and a voice-set timer are one system', async () => {
  const store = createMemoryStore()
  let clock = T0
  const control = createTimerControl({ store, deviceId: DEVICE, now: () => clock })

  await startTimer({ store, deviceId: DEVICE, minutes: 10, setBy: 'knob', now: clock })
  const spoken = await control.start({ minutes: 17, label: null })
  assert.equal(spoken.spoken, '17 minute timer started.')

  clock = T0 + 5 * MIN
  const status = await control.status()
  assert.match(status.spoken, /^You have 2 timers running: 5 minutes on the 10 minute one, 12 minutes on the 17 minute one\.$/)

  /* The voice cancel reaches the knob's timer too — the model is not given a
   * private list of its own. */
  const cancelled = await control.cancel({})
  assert.equal(cancelled.spoken, 'Cancelled 2 timers.')

  clock = T0 + 99 * MIN
  assert.deepEqual(await claimDueTimers({ store, deviceId: DEVICE, now: clock }), [])
})

test('the voice control sweeps the same due queue the knob path sweeps', async () => {
  const store = createMemoryStore()
  let clock = T0
  const control = createTimerControl({ store, deviceId: DEVICE, now: () => clock })
  await control.start({ minutes: 10 })
  clock = T0 + 11 * MIN
  const due = await claimDueTimers({ store, deviceId: DEVICE, now: clock })
  assert.equal(due.length, 1)
  assert.equal(due[0].setBy, 'voice')
  assert.equal(timerDoneSpeech(due[0]), 'Your 10 minute timer is done.')
})

test('timers are per device — one pendant cannot chime another', async () => {
  const store = createMemoryStore()
  await startTimer({ store, deviceId: DEVICE, minutes: 10, now: T0 })
  assert.deepEqual(await listTimers(store, 'other-pendant'), [])
  assert.deepEqual(await claimDueTimers({ store, deviceId: 'other-pendant', now: T0 + 99 * MIN }), [])
})

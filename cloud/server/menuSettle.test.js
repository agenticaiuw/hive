import assert from 'node:assert/strict'
import test from 'node:test'

import { SETTLE_MS, createSettle } from './menuSettle.js'

/**
 * A fake clock, because the thing under test is entirely about time.
 *
 * Real timers would make this suite either slow (forty detents at 200 ms) or
 * flaky (racing the event loop to assert a NON-event). Neither is acceptable
 * for a guarantee this load-bearing, so the clock is injected and advanced by
 * hand — every assertion below is then exact rather than probable.
 */
function fakeClock() {
  let now = 0
  let nextId = 1
  const timers = new Map()
  return {
    setTimer(fn, delay) {
      const id = nextId++
      timers.set(id, { fn, at: now + delay })
      return id
    },
    clearTimer(id) {
      timers.delete(id)
    },
    advance(ms) {
      now += ms
      for (const [id, timer] of [...timers].sort((a, b) => a[1].at - b[1].at)) {
        if (timer.at <= now) {
          timers.delete(id)
          timer.fn()
        }
      }
    },
    get armed() {
      return timers.size
    },
  }
}

function harness({ delayMs = SETTLE_MS } = {}) {
  const clock = fakeClock()
  const spoken = []
  const settle = createSettle({
    delayMs,
    speak: (utterance) => spoken.push(utterance),
    setTimer: clock.setTimer,
    clearTimer: clock.clearTimer,
  })
  return { clock, spoken, settle }
}

test('a 40-detent spin speaks EXACTLY ONE number, and it is the last one', () => {
  /*
   * The feature, as a test. The owner turns from ten minutes to fifty in one
   * motion. If more than one of those forty numbers is spoken, the pendant
   * reads a countdown at them while they are still turning and numeric entry
   * is unusable; if the number spoken is not the one they landed on, the
   * readout is a lie. Both failure modes are covered by this single assertion.
   */
  const { clock, spoken, settle } = harness()
  for (let value = 11; value <= 50; value += 1) {
    settle.offer({ kind: 'number', value })
    /* 25 ms between detents: a brisk but entirely ordinary spin. */
    clock.advance(25)
  }
  assert.deepEqual(spoken, [], 'nothing may be spoken while the hand is still moving')

  clock.advance(SETTLE_MS)
  assert.deepEqual(spoken, [{ kind: 'number', value: 50 }])
})

test('the same holds for ring names — a fast spin costs one sentence', () => {
  const { clock, spoken, settle } = harness()
  for (const text of ['Time.', 'Timer.', 'Alarm.', 'Reminders.', 'Calendar.']) {
    settle.offer({ kind: 'name', text })
    clock.advance(30)
  }
  clock.advance(SETTLE_MS)
  assert.deepEqual(spoken, [{ kind: 'name', text: 'Calendar.' }])
})

test('a genuine pause speaks, and the spin that follows speaks again', () => {
  /* The other half of the contract: this is a debounce, not a mute. An owner
   * who stops, hears where they are, and keeps going must be answered twice. */
  const { clock, spoken, settle } = harness()
  settle.offer({ kind: 'number', value: 7 })
  clock.advance(SETTLE_MS)
  assert.deepEqual(spoken, [{ kind: 'number', value: 7 }])

  settle.offer({ kind: 'number', value: 8 })
  settle.offer({ kind: 'number', value: 9 })
  clock.advance(SETTLE_MS)
  assert.deepEqual(spoken, [
    { kind: 'number', value: 7 },
    { kind: 'number', value: 9 },
  ])
})

test('it is TRAILING, not leading — the owner hears where they landed', () => {
  /*
   * A throttle would speak the first value of a burst and rate-limit the rest,
   * which on a spinner means announcing where the owner STARTED. Only the
   * trailing edge answers the question they actually asked.
   */
  const { clock, spoken, settle } = harness()
  settle.offer({ kind: 'number', value: 1 })
  clock.advance(SETTLE_MS - 1)
  assert.deepEqual(spoken, [])
  settle.offer({ kind: 'number', value: 2 })
  clock.advance(SETTLE_MS)
  assert.deepEqual(spoken, [{ kind: 'number', value: 2 }])
})

test('a hesitation shorter than the settle does not fire', () => {
  const { clock, spoken, settle } = harness()
  settle.offer({ kind: 'number', value: 1 })
  /* ~300 ms is a real between-detent pause while the owner is still hunting;
   * 150 ms is a stumble. The settle must ride out the stumble. */
  clock.advance(150)
  settle.offer({ kind: 'number', value: 2 })
  clock.advance(150)
  settle.offer({ kind: 'number', value: 3 })
  assert.deepEqual(spoken, [])
  clock.advance(SETTLE_MS)
  assert.deepEqual(spoken, [{ kind: 'number', value: 3 }])
})

test('cancel drops a pending utterance and disarms the timer', () => {
  /*
   * The ring closing, or the conversation ending. A name armed by the detent
   * that got the owner OUT of a ring would otherwise land after the falling
   * earcon and announce a place they have already left — the device
   * disagreeing with itself about where it is.
   */
  const { clock, spoken, settle } = harness()
  settle.offer({ kind: 'name', text: 'Calendar.' })
  assert.equal(settle.pending, true)
  settle.cancel()
  assert.equal(settle.pending, false)
  assert.equal(clock.armed, 0, 'a cancelled settle must not leave a timer behind')
  clock.advance(SETTLE_MS * 10)
  assert.deepEqual(spoken, [])
})

test('cancelling twice, or with nothing pending, is harmless', () => {
  const { settle, spoken, clock } = harness()
  settle.cancel()
  settle.cancel()
  clock.advance(SETTLE_MS)
  assert.deepEqual(spoken, [])
})

test('a burst leaves exactly one armed timer, never a pile', () => {
  /* Each offer must CANCEL its predecessor, not merely outlive it. A leak here
   * would be invisible in the spoken output and fatal on a long session. */
  const { clock, settle } = harness()
  for (let i = 0; i < 100; i += 1) settle.offer({ kind: 'number', value: i })
  assert.equal(clock.armed, 1)
})

test('the settle is short enough to feel immediate', () => {
  /* The owner's word was "immediately". This is the budget that has to hold
   * for that to be true, and it is asserted so a future retune has to argue
   * with a test rather than quietly drift. */
  assert.ok(SETTLE_MS <= 250, `settle is ${SETTLE_MS}ms; a spinner cannot feel immediate above ~250`)
})

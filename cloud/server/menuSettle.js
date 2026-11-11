/*
 * The settle: when the ring is allowed to speak.
 *
 * WHY THIS IS ITS OWN FILE. It used to be four lines inside pendantConverse.js,
 * and while it only governed ring names that was fine — a spin costing two
 * sentences instead of one is untidy, not broken. Numeric entry changed the
 * stakes. The owner turns a knob forty detents to get from ten minutes to
 * fifty, and every one of those detents produces a number the device COULD
 * speak. If more than one of them actually gets spoken, the pendant spends the
 * next thirty seconds reading a countdown at the owner while they try to keep
 * turning, and the feature is unusable.
 *
 * "Exactly one utterance per burst" is therefore a promise, and a promise
 * buried in a socket handler is a promise nobody can test. So it lives here,
 * with its timer injected, and menuSettle.test.js drives forty detents through
 * it on a fake clock and asserts a single call. That test is the feature.
 *
 * WHY DEBOUNCE RATHER THAN THROTTLE. A throttle speaks the FIRST value of a
 * burst and then rate-limits; the owner would hear where they started. Only a
 * trailing debounce says where they LANDED, which is the only number that
 * matters — and it is why the delay is short (~200 ms) rather than generous:
 * this fires after the hand stops, so every millisecond of it is dead air
 * between the owner finishing and the device answering.
 */

/** The pause that counts as "the hand stopped".
 *
 * 200 ms, and the bound is human rather than arbitrary: a pause BETWEEN detents
 * while the owner is still hunting runs ~300 ms at conversational speed, so a
 * longer settle starts eating real pauses and the number arrives late; much
 * shorter and an ordinary hesitation mid-spin fires an utterance the owner then
 * talks over with more turning. It is also no longer load-bearing for SAFETY
 * the way it was under dwell — nothing commits on a settle any more, so this
 * number can be retuned for feel alone. */
export const SETTLE_MS = 200

/**
 * A debouncer with its clock handed to it.
 *
 * `speak` is called with the last utterance of a burst and nothing else. The
 * timer functions are injected so tests can run a fake clock; production passes
 * the globals. Keeping them as parameters rather than reaching for a module
 * -level clock is what makes the forty-detent test possible at all.
 */
export function createSettle({
  delayMs = SETTLE_MS,
  speak,
  setTimer = setTimeout,
  clearTimer = clearTimeout,
} = {}) {
  let pending = null
  let queued = null

  return {
    /**
     * Offer an utterance. It will be spoken `delayMs` after the LAST offer.
     *
     * Each offer cancels the one before it, which is the whole mechanism: the
     * owner's fortieth detent is the only one whose timer is ever allowed to
     * expire.
     */
    offer(utterance) {
      queued = utterance
      if (pending) clearTimer(pending)
      pending = setTimer(() => {
        pending = null
        const value = queued
        queued = null
        if (value !== null && value !== undefined) speak(value)
      }, delayMs)
    },

    /**
     * Drop anything pending without speaking it.
     *
     * Called when the ring closes or the conversation ends. Without it, a
     * position name armed by the detent that got you OUT of a ring would land
     * after the falling earcon and announce a place the owner has already left
     * — which reads as the device disagreeing with itself about where it is.
     */
    cancel() {
      if (pending) clearTimer(pending)
      pending = null
      queued = null
    },

    /** Whether an utterance is waiting. Exists for the tests and for teardown
     * assertions; nothing in the hot path asks. */
    get pending() {
      return pending !== null
    },
  }
}

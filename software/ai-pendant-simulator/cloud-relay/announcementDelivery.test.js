import assert from 'node:assert/strict'
import test from 'node:test'

import { eventsFromAnnouncements } from '../local-agent/catchupSources.js'
import { announcementDeliveryOutcome, createAnnouncement } from './announce.js'

/*
 * The reported bug: an announcement became `state: 'delivered'` on
 * `sentBytes > 0` — one byte accepted by a WebSocket — and `deliveredAt` was
 * stamped unconditionally, including on the branch that put the announcement
 * back on the queue having sent nothing at all. Anything treating `deliveredAt`
 * as evidence was reading a clock.
 */

test('nothing sent leaves no delivery timestamp behind', () => {
  const outcome = announcementDeliveryOutcome({ sentBytes: 0, sentFrames: 0 })

  assert.equal(outcome.state, 'pending')
  assert.equal(outcome.deliveredAt, null)
  assert.equal(outcome.deliveryPath, null)
  assert.equal(outcome.deliveryEvidence, null)
})

test('bytes on a socket are recorded as bytes on a socket', () => {
  const outcome = announcementDeliveryOutcome({
    sentBytes: 48000,
    sentFrames: 120,
    stopped: false,
    now: () => '2026-08-07T09:00:00.000Z',
  })

  assert.equal(outcome.deliveredAt, '2026-08-07T09:00:00.000Z')
  assert.equal(outcome.deliveryEvidence, 'bytes_sent_to_device')
  assert.equal(outcome.deliveryComplete, true)
  assert.equal(outcome.sentBytes, 48000)
  // The queue may be finished with it. That is not the same as being heard.
  assert.equal(outcome.state, 'delivered')
  assert.equal(outcome.heard, 'unknown')
})

test('an interrupted briefing is recorded as interrupted', () => {
  const outcome = announcementDeliveryOutcome({
    sentBytes: 4000,
    sentFrames: 10,
    stopped: true,
  })

  assert.equal(outcome.deliveryPath, 'converse-interrupted')
  assert.equal(outcome.deliveryComplete, false)
  assert.equal(outcome.heard, 'unknown')
})

/*
 * The digest is where this stops being bookkeeping and starts being something
 * the owner is told. It used to read `state: 'delivered'` and say "The pendant
 * spoke this to you."
 */
const digestFor = (overrides) =>
  eventsFromAnnouncements([
    {
      announcementId: 'anc_1',
      title: 'Morning brief',
      speech: 'Two meetings today.',
      createdAt: '2026-08-07T07:00:00.000Z',
      expiresAt: '2026-08-07T19:00:00.000Z',
      ...overrides,
    },
  ])[0]

test('the digest never tells the owner they heard bytes on a socket', () => {
  const event = digestFor(
    announcementDeliveryOutcome({ sentBytes: 48000, sentFrames: 120 }),
  )

  assert.equal(event.label, 'indeterminate')
  assert.match(event.why, /not known/i)
  /* The old sentence is gone and the uncertainty is stated, not implied. */
  assert.doesNotMatch(event.why, /spoke this to you/i)
})

test('an interrupted briefing is routed back to the owner', () => {
  const event = digestFor(
    announcementDeliveryOutcome({ sentBytes: 4000, sentFrames: 8, stopped: true }),
  )

  assert.equal(event.label, 'indeterminate')
  assert.equal(event.needsOwner, true)
})

test('a real playback report would be allowed to say the pendant played it', () => {
  const event = digestFor({
    ...announcementDeliveryOutcome({ sentBytes: 48000, sentFrames: 120 }),
    heard: 'yes',
  })

  assert.equal(event.label, 'occurred')
  assert.match(event.why, /reported playing/i)
})

test('a record written before evidence existed does not invent any', () => {
  const event = digestFor({ state: 'delivered' })

  assert.match(event.why, /predates playback evidence/i)
  assert.match(event.why, /cannot say/i)
  assert.doesNotMatch(event.why, /spoke this to you/i)
})

test('a fresh announcement starts with no delivery claim of any kind', () => {
  const announcement = createAnnouncement({
    deviceId: 'nrf9160-pendant',
    title: 'Morning brief',
    speech: 'Two meetings today.',
  })

  assert.equal(announcement.state, 'pending')
  assert.equal(announcement.deliveredAt, null)
  assert.equal(announcement.deliveryEvidence, null)
  assert.equal(announcement.sentBytes, 0)
  assert.equal(announcement.heard, 'unknown')
})

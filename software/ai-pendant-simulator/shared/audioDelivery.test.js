import assert from 'node:assert/strict'
import test from 'node:test'

import {
  AUDIO_DELIVERY_STATES,
  DELIVERY_STAGES,
  HEARD_UNKNOWN,
  PIPELINE_STATUS_UNKNOWN,
  PLAYBACK_REPORT_CONTRACT,
  PLAYBACK_UNKNOWN_STATUS,
  deliveryRunStatus,
  gradeAudioDelivery,
  normalizePipelineStatus,
  runAwaitsDevice,
  stageIsReportable,
} from './audioDelivery.js'

const at = '2026-08-07T09:00:00.000Z'

const pendantEvents = ({ downlink = null, playback = null, received = null } = {}) =>
  [
    {
      stage: 'transcription',
      status: 'done',
      meta: { inputTelemetry: { storage: 'live_lte', audioBytes: 148800 } },
      at,
    },
    { stage: 'agent', status: 'done', at },
    { stage: DELIVERY_STAGES.COMPOSED, status: 'done', meta: { pcmBytes: 32000 }, at },
    { stage: DELIVERY_STAGES.HELD, status: 'done', meta: { pcmBytes: 32000 }, at },
    downlink,
    received,
    playback,
  ].filter(Boolean)

const downlinkDone = (meta = {}) => ({
  stage: DELIVERY_STAGES.DOWNLINK,
  status: 'done',
  meta: { sentBytes: 32000, pulledByDevice: true, ...meta },
  at,
})

test('a pendant run with no playback report is unknown, not completed', () => {
  const delivery = gradeAudioDelivery(pendantEvents({ downlink: downlinkDone() }))

  assert.equal(delivery.state, 'requested_by_device')
  assert.equal(delivery.provesPlayback, false)
  assert.equal(delivery.heard, HEARD_UNKNOWN)
  assert.equal(
    deliveryRunStatus(delivery, { macDone: true }),
    PLAYBACK_UNKNOWN_STATUS,
  )
})

test('the strongest claim is never rounded up past its witness', () => {
  const relayOnly = gradeAudioDelivery(pendantEvents())
  assert.equal(relayOnly.state, 'held_by_relay')
  assert.equal(relayOnly.witness, 'the relay store')

  const pushed = gradeAudioDelivery(
    pendantEvents({ downlink: downlinkDone({ pulledByDevice: false }) }),
  )
  // A push the device may have slept through claims the weaker rung than a pull.
  assert.equal(pushed.state, 'bytes_sent_to_device')
  assert.ok(
    AUDIO_DELIVERY_STATES.bytes_sent_to_device.rank <
      AUDIO_DELIVERY_STATES.requested_by_device.rank,
  )
})

test('only the pendant’s own word reaches the playback rung', () => {
  const played = gradeAudioDelivery(
    pendantEvents({
      downlink: downlinkDone(),
      playback: { stage: DELIVERY_STAGES.PLAYED, status: 'done', at },
    }),
  )

  assert.equal(played.state, 'played_by_device')
  assert.equal(played.provesPlayback, true)
  assert.equal(played.heard, 'yes')
  assert.equal(deliveryRunStatus(played, { macDone: true }), 'completed')
})

test('a playback failure is a failure, not a quieter success', () => {
  const delivery = gradeAudioDelivery(
    pendantEvents({
      downlink: downlinkDone(),
      playback: { stage: DELIVERY_STAGES.PLAYED, status: 'failed', at },
    }),
  )

  assert.equal(delivery.playbackFailed, true)
  assert.equal(delivery.provesPlayback, false)
  assert.equal(deliveryRunStatus(delivery, { macDone: true }), 'failed')
})

test('playback still running keeps the run in progress', () => {
  const delivery = gradeAudioDelivery(
    pendantEvents({
      downlink: downlinkDone(),
      playback: { stage: DELIVERY_STAGES.PLAYED, status: 'active', at },
    }),
  )

  assert.equal(delivery.playbackActive, true)
  assert.equal(deliveryRunStatus(delivery, { macDone: true }), 'processing')
})

/*
 * normalizePipelineStatus: the ingestion-side fix. A firmware typo, an
 * omitted status field, or any other malformed report used to default to
 * 'done' — the one value that, once it reaches gradeAudioDelivery's PLAYED
 * check below, forges a claim nothing actually witnessed.
 */
test('normalizePipelineStatus recognizes exactly its known vocabulary', () => {
  assert.equal(normalizePipelineStatus('active'), 'active')
  assert.equal(normalizePipelineStatus('processing'), 'active')
  assert.equal(normalizePipelineStatus('failed'), 'failed')
  assert.equal(normalizePipelineStatus('error'), 'failed')
  assert.equal(normalizePipelineStatus('waiting'), 'waiting')
  assert.equal(normalizePipelineStatus('queued'), 'waiting')
  assert.equal(normalizePipelineStatus('done'), 'done')
  // Case/whitespace tolerated the same way the recognized words are.
  assert.equal(normalizePipelineStatus('  DONE '), 'done')
})

test('normalizePipelineStatus defaults anything unrecognized to unknown, never done', () => {
  assert.equal(normalizePipelineStatus(undefined), PIPELINE_STATUS_UNKNOWN)
  assert.equal(normalizePipelineStatus(null), PIPELINE_STATUS_UNKNOWN)
  assert.equal(normalizePipelineStatus(''), PIPELINE_STATUS_UNKNOWN)
  assert.equal(normalizePipelineStatus('   '), PIPELINE_STATUS_UNKNOWN)
  // A plausible-looking typo of the one word that must never be guessed at.
  assert.equal(normalizePipelineStatus('donee'), PIPELINE_STATUS_UNKNOWN)
  assert.equal(normalizePipelineStatus('complete'), PIPELINE_STATUS_UNKNOWN)
  assert.equal(normalizePipelineStatus('ok'), PIPELINE_STATUS_UNKNOWN)
  assert.notEqual(PIPELINE_STATUS_UNKNOWN, 'done')
})

/*
 * The scenario the fix exists for, run end to end through gradeAudioDelivery:
 * a malformed/missing device_playback status must NEVER reach the one
 * comparison that sets provesPlayback/heard:'yes'.
 */
test('a malformed playback report normalizes to unknown, never forges heard:yes', () => {
  const delivery = gradeAudioDelivery(
    pendantEvents({
      downlink: downlinkDone(),
      playback: {
        stage: DELIVERY_STAGES.PLAYED,
        status: normalizePipelineStatus(undefined),
        at,
      },
    }),
  )

  assert.notEqual(delivery.state, 'played_by_device')
  assert.equal(delivery.provesPlayback, false)
  assert.notEqual(delivery.heard, 'yes')
  assert.equal(delivery.heard, HEARD_UNKNOWN)
  assert.notEqual(deliveryRunStatus(delivery, { macDone: true }), 'completed')
})

test('an unknown status on any other device-witnessed stage is also refused, not laundered to done', () => {
  // Same bug, same fix, different rung: RECEIVED also requires an exact
  // 'done' match (latestDone), so the old default forged this rung too.
  const delivery = gradeAudioDelivery(
    pendantEvents({
      downlink: downlinkDone(),
      received: {
        stage: DELIVERY_STAGES.RECEIVED,
        status: normalizePipelineStatus('garbage'),
        at,
      },
    }),
  )

  assert.notEqual(delivery.state, 'received_by_device')
  assert.equal(delivery.state, 'requested_by_device')
})

test('a relay still holding the audio is in flight, not unknown', () => {
  // Nothing has been offered to the pendant yet, so there is no unanswered
  // question — only an unfinished handoff.
  const delivery = gradeAudioDelivery(pendantEvents())
  assert.equal(deliveryRunStatus(delivery, { macDone: true }), 'processing')
})

test('a run with no device waiting on it finishes on the Mac', () => {
  const events = [
    {
      stage: 'transcription',
      status: 'done',
      meta: { inputTelemetry: { storage: 'dashboard', inputMode: 'typed' } },
      at,
    },
    { stage: 'agent', status: 'done', at },
  ]

  assert.equal(runAwaitsDevice(events), false)
  const delivery = gradeAudioDelivery(events, { origin: 'dashboard' })
  assert.equal(delivery.heard, 'no-audio')
  assert.equal(deliveryRunStatus(delivery, { macDone: true }), 'completed')
})

test('rendered pendant audio makes the run owe an answer on its own', () => {
  // No input telemetry at all: the fact that speech was rendered for the device
  // is enough. The old microSD-only check missed every live-LTE run.
  const events = [
    { stage: DELIVERY_STAGES.COMPOSED, status: 'done', meta: { pcmBytes: 24000 }, at },
    { stage: DELIVERY_STAGES.HELD, status: 'done', at },
  ]
  assert.equal(runAwaitsDevice(events), true)
})

test('a run that rendered nothing is not held open forever', () => {
  const events = [
    { stage: DELIVERY_STAGES.COMPOSED, status: 'done', meta: { pcmBytes: 0 }, at },
    { stage: DELIVERY_STAGES.HELD, status: 'done', at },
  ]
  assert.equal(runAwaitsDevice(events), false)
})

test('unreportable stages are distinguishable from stages that simply have not run', () => {
  assert.equal(stageIsReportable(DELIVERY_STAGES.COMPOSED), true)
  assert.equal(stageIsReportable(DELIVERY_STAGES.HELD), true)
  assert.equal(stageIsReportable(DELIVERY_STAGES.DOWNLINK), true)
  // Both device-witnessed stages: one has no caller, one has an unreachable one.
  assert.equal(stageIsReportable(DELIVERY_STAGES.RECEIVED), false)
  assert.equal(stageIsReportable(DELIVERY_STAGES.PLAYED), false)
})

test('every rung names a witness and what it fails to prove', () => {
  for (const [id, grade] of Object.entries(AUDIO_DELIVERY_STATES)) {
    assert.ok(grade.witness, `${id} needs a witness`)
    assert.ok(grade.evidence, `${id} needs its evidence spelled out`)
    assert.ok(grade.doesNotProve, `${id} needs its limit spelled out`)
    if (!grade.availableToday) {
      assert.ok(grade.gap, `${id} is unavailable and must say why`)
    }
  }

  // Exactly one rung answers the real question, and it is not producible.
  const proving = Object.values(AUDIO_DELIVERY_STATES).filter(
    (grade) => grade.provesPlayback,
  )
  assert.equal(proving.length, 1)
  assert.equal(proving[0].availableToday, false)
})

test('the firmware contract refuses a bare played boolean', () => {
  assert.equal(PLAYBACK_REPORT_CONTRACT.stage, DELIVERY_STAGES.PLAYED)
  assert.ok(PLAYBACK_REPORT_CONTRACT.blockers.length >= 3)
  for (const blocker of PLAYBACK_REPORT_CONTRACT.blockers) {
    assert.ok(blocker.what && blocker.detail && blocker.requires)
  }
  // A report that cannot tell a truncated playback from a complete one is not
  // evidence, so both counts are required.
  assert.ok('framesPlayed' in PLAYBACK_REPORT_CONTRACT.requiredMeta)
  assert.ok('framesDropped' in PLAYBACK_REPORT_CONTRACT.requiredMeta)
  assert.match(PLAYBACK_REPORT_CONTRACT.doesNotImply, /owner heard it/i)
})

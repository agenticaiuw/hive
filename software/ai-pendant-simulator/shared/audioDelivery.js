/*
 * What this system can honestly claim about a reply the pendant was meant to
 * speak out loud.
 *
 * THE BUG THIS FILE EXISTS TO FIX
 *
 * `device_playback` had three readers and no emitter. cloud-relay/jobs.js looked
 * for a done event, local-agent/pipelineTrace.js looked for the stage, and
 * src/ops/OpsApp.jsx drew it as a step in the stage map. Nothing anywhere in the
 * JavaScript ever wrote one. Both status derivations then fell through to
 * Mac-side completion, so a run the owner may never have heard rendered as
 * "Done" — the finish line of a voice device silently redefined as "the Mac
 * finished making the audio".
 *
 * The firmware is not innocent here either, and it is not the fix. It HAS the
 * emitter: pendant_cloud_report_playback_started() and
 * pendant_cloud_report_playback_result() (firmware/nrf9160/src/pendant_cloud.c)
 * build exactly the right POST. Neither is called from anywhere. See
 * PLAYBACK_REPORT_CONTRACT at the bottom of this file for what wiring them up
 * would actually require — it is more than adding two call sites.
 *
 * THE RULE
 *
 * Composed, held, sent, requested, received and played are six different facts
 * with six different witnesses. Each rung below names its witness and says what
 * it does NOT prove. A rung is only claimable when the body that can witness it
 * actually said so. Nothing rounds up: the absence of a playback report is
 * reported as unknown, never as success, and never as "still working" once the
 * work is over.
 *
 * RELATED VOCABULARY
 *
 * shared/approvalHandoff.js grades the SAME physical event for a different
 * purpose — whether a spoken approval readback may count as consent. It is
 * deliberately stricter (only a rung that witnesses a PERSON may set
 * `deliveredAt`) and it already refuses 'playback-report' as unproducible. This
 * file grades the pipeline's own reply audio for the dashboard, so it keeps the
 * intermediate rungs that file collapses. Neither is allowed to launder the
 * other's evidence: a rung here never becomes consent there.
 */

/** Stage ids that carry delivery evidence, weakest witness first. */
export const DELIVERY_STAGES = Object.freeze({
  /** The Mac rendering PCM. Witness: the Mac. */
  COMPOSED: 'tts',
  /** The relay accepting the Mac's upload. Witness: the relay store. */
  HELD: 'relay_result',
  /**
   * The relay writing reply bytes at a device. Witness: the relay socket.
   * Emitted by cloud-relay/pendantDownlink.js, which is the last point on the
   * Mac/relay side of the wire that observes anything real.
   */
  DOWNLINK: 'device_downlink',
  /** The device saying it holds the bytes. Witness: the device. */
  RECEIVED: 'reply_downloaded',
  /** The device saying it played them. Witness: the device. Never emitted. */
  PLAYED: 'device_playback',
})

const DEVICE_WITNESSED_STAGES = Object.freeze([
  DELIVERY_STAGES.DOWNLINK,
  DELIVERY_STAGES.RECEIVED,
  DELIVERY_STAGES.PLAYED,
])

/*
 * The rungs, weakest first. `rank` orders them; `witness` names the body whose
 * word this is; `provesPlayback` is true for exactly one rung and that rung
 * cannot currently be produced.
 *
 * `doesNotProve` is not decoration. It is the sentence that has to be true when
 * someone reads the state name and stops reading.
 */
export const AUDIO_DELIVERY_STATES = Object.freeze({
  not_composed: Object.freeze({
    rank: 0,
    stage: null,
    label: 'No reply audio rendered',
    witness: 'the Mac',
    evidence: 'No text-to-speech stage has finished with any bytes.',
    proves: 'Nothing has been made for the pendant to play.',
    doesNotProve: 'That the run failed — speech may still be rendering.',
    provesPlayback: false,
    availableToday: true,
  }),

  composed_on_mac: Object.freeze({
    rank: 1,
    stage: DELIVERY_STAGES.COMPOSED,
    label: 'Rendered on the Mac',
    witness: 'the Mac',
    evidence: 'The text-to-speech stage finished and reported PCM bytes.',
    proves: 'Audio for this reply exists on the Mac.',
    doesNotProve: 'That anything left the Mac.',
    provesPlayback: false,
    availableToday: true,
  }),

  held_by_relay: Object.freeze({
    rank: 2,
    stage: DELIVERY_STAGES.HELD,
    label: 'Waiting at the relay',
    witness: 'the relay store',
    evidence: 'The relay accepted the Mac result carrying the reply audio.',
    proves: 'The pendant could fetch this reply if it asked.',
    doesNotProve: 'That the pendant asked, or that it is even powered on.',
    provesPlayback: false,
    availableToday: true,
  }),

  /*
   * The push case: streamAnnouncementPcm metering frames onto an open pendant
   * socket. The socket accepting bytes says nothing about the device draining
   * them — the modem queue can overrun and the firmware drops rather than
   * drains (see PLAYBACK_REPORT_CONTRACT).
   */
  bytes_sent_to_device: Object.freeze({
    rank: 3,
    stage: DELIVERY_STAGES.DOWNLINK,
    label: 'Bytes written to the pendant socket',
    witness: 'the relay socket',
    evidence: 'The relay wrote reply bytes to a socket addressed to this device.',
    proves: 'Bytes left the relay aimed at the pendant.',
    doesNotProve: 'That the pendant received, decoded, or made a sound.',
    provesPlayback: false,
    availableToday: true,
  }),

  /*
   * The pull case, and the strongest thing the relay can witness on its own:
   * the device authenticated, named this job, and the relay wrote the body to
   * that request. The device proved it is alive and wanted the reply. It did
   * not prove the body arrived — a response can die mid-body.
   */
  requested_by_device: Object.freeze({
    rank: 4,
    stage: DELIVERY_STAGES.DOWNLINK,
    label: 'Fetched by the pendant',
    witness: 'the pendant’s own request, and the relay socket',
    evidence:
      'The device asked for this job’s reply and the relay wrote the audio body to that request.',
    proves: 'The pendant was powered, online, and asked for this exact reply.',
    doesNotProve:
      'That the whole body arrived, that it decoded, or that it was ever played.',
    provesPlayback: false,
    availableToday: true,
  }),

  /*
   * The firmware does build this one — pendant_cloud_wait_for_agent_reply()
   * posts reply_downloaded/done. Its only call site sits behind
   * CONFIG_PENDANT_BOOT_AGENT_JOB_ID, which ships empty ("Leave empty in
   * production"), so in a shipped build nothing reaches it. Marked unavailable
   * for that reason rather than because the code is absent: the distinction
   * between "not written" and "written and unreachable" is exactly the kind of
   * thing this file exists to keep visible.
   */
  received_by_device: Object.freeze({
    rank: 5,
    stage: DELIVERY_STAGES.RECEIVED,
    label: 'Held by the pendant',
    witness: 'the pendant',
    evidence: 'The device reported that it finished downloading the reply.',
    proves: 'The bytes are on the device.',
    doesNotProve: 'That the speaker ever ran.',
    provesPlayback: false,
    availableToday: false,
    gap:
      'Only reachable from the Kconfig-gated boot diagnostic path, which is ' +
      'empty in production builds. A shipped pendant never sends this.',
  }),

  /*
   * The only rung that answers the question anyone actually asked, and the one
   * rung nothing can produce. Kept in the vocabulary rather than omitted, so the
   * gap is visible where the states are read instead of being invisible.
   */
  played_by_device: Object.freeze({
    rank: 6,
    stage: DELIVERY_STAGES.PLAYED,
    label: 'Played by the pendant',
    witness: 'the pendant',
    evidence: 'The device reported that it played the reply out of its speaker.',
    proves: 'The reply became sound in the room.',
    doesNotProve: 'That the owner was in the room.',
    provesPlayback: true,
    availableToday: false,
    gap:
      'No device_playback event has ever been emitted. The firmware defines the ' +
      'reporters and never calls them, and on the live duplex path it holds no job ' +
      'id to put in one. See PLAYBACK_REPORT_CONTRACT.',
  }),
})

/**
 * Can any body in this system currently produce an event for this stage?
 *
 * A stage map that draws an unproducible step the same grey as one that simply
 * has not happened yet is telling the reader to keep waiting for something that
 * is never coming. Driven off each rung's own `availableToday`, so a stage
 * becomes reportable the moment its witness is actually wired up — not when
 * someone remembers to update a list.
 */
export function stageIsReportable(stage) {
  const rung = Object.values(AUDIO_DELIVERY_STATES).find(
    (grade) => grade.stage === stage,
  )
  return rung ? rung.availableToday : true
}

/** The single honest answer to "did the owner hear it" on this system. */
export const HEARD_UNKNOWN = 'unknown'
export const HEARD_NO_AUDIO = 'no-audio'

/**
 * What a per-stage pipeline event's raw, device- or bridge-reported status
 * means, normalized to the small vocabulary the rest of this pipeline reads.
 *
 * THE BUG THIS FIXES. This used to default anything it did not recognize —
 * including a missing status field entirely — to 'done'. That is invisible
 * for most stages, but `played?.status === 'done'` (gradeAudioDelivery,
 * below) is the ONE comparison in this whole file that sets `provesPlayback:
 * true` / `heard: 'yes'` — the single claim this file exists to keep honest
 * ("Nothing rounds up," this file's own rule, above). A firmware typo, a
 * status field an older firmware build omits, or a proxy that drops an
 * unrecognized field would all have been laundered into "the pendant said it
 * played this," with nothing anywhere disagreeing. It was dormant only
 * because nothing calls the reporters that would ever send a device_playback
 * event at all (PLAYBACK_REPORT_CONTRACT) — the moment that ships, this
 * default activates with zero other code change.
 *
 * THE FIX. Unknown must map to unknown, never to success — the same rule
 * this file applies to a MISSING event; a malformed one deserves no more
 * trust than an absent one. Every OTHER stage this feeds (composed/held/
 * downlink/received, not only played) shares the same fix for the same
 * reason: `latestDone()` below requires an exact 'done' match for all of
 * them, so the old default silently forged a "done" for whichever of those
 * stages happened to carry a bad status too.
 *
 * Every consumer of this value compares it against a specific known string
 * ('done'/'active'/'failed') rather than switching on it or indexing a table
 * with it, so PIPELINE_STATUS_UNKNOWN reaching any of them is a non-match,
 * never a crash — checked at every call site as this function moved here.
 */
export const PIPELINE_STATUS_UNKNOWN = 'unknown'

export function normalizePipelineStatus(value) {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'active' || status === 'processing') return 'active'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'waiting' || status === 'queued') return 'waiting'
  if (status === 'done') return 'done'
  return PIPELINE_STATUS_UNKNOWN
}

/**
 * Run status for work that is finished everywhere the Mac and relay can see,
 * and whose last mile nothing witnessed.
 *
 * Deliberately not 'completed' (that rounds unknown up to success) and
 * deliberately not 'processing' (that rounds unknown up to "still working", so
 * a run that will never resolve looks like one that is about to). It says the
 * one true thing: the Mac is done and the pendant never reported back.
 */
export const PLAYBACK_UNKNOWN_STATUS = 'playback_unknown'

const asEvents = (events) => (Array.isArray(events) ? events : [])
const stageEvents = (events, stage) =>
  asEvents(events).filter((event) => event?.stage === stage)

function latestDone(events, stage) {
  const matching = stageEvents(events, stage).filter(
    (event) => event?.status === 'done',
  )
  return matching[matching.length - 1] ?? null
}

function latestOfStage(events, stage) {
  const matching = stageEvents(events, stage)
  return matching[matching.length - 1] ?? null
}

function numericMeta(event, ...keys) {
  for (const key of keys) {
    const value = Number(event?.meta?.[key])
    if (Number.isFinite(value) && value > 0) return value
  }
  return 0
}

/**
 * Does this run owe the pendant a spoken answer?
 *
 * Several independent signals, none of them a hardcoded product string: audio
 * was rendered for the device, OR the device is already visible in the run, OR
 * the request was captured on a device rather than typed into a browser. Any one
 * of them means the last mile is a live question and a Mac-side finish is not
 * the finish.
 *
 * A run that owes nothing to a device — a dashboard command, a run whose speech
 * never rendered — is not held open by this. There is no ear waiting on it.
 */
export function runAwaitsDevice(events, { origin = '' } = {}) {
  const list = asEvents(events)

  const composed = latestDone(list, DELIVERY_STAGES.COMPOSED)
  if (composed && numericMeta(composed, 'pcmBytes', 'audioBytes') > 0) return true

  if (list.some((event) => DEVICE_WITNESSED_STAGES.includes(event?.stage))) {
    return true
  }

  /*
   * Input telemetry describes where the request was captured. Anything captured
   * off-device (a browser tab) has no speaker waiting; anything else came in
   * through a device that is expecting to be answered out loud. Read as "not a
   * browser" rather than as a list of blessed device values, so a new capture
   * path is treated as owing an answer until it proves otherwise.
   */
  const telemetry = list.find(
    (event) => event?.meta && typeof event.meta === 'object' && event.meta.inputTelemetry,
  )?.meta?.inputTelemetry
  const capturedBy = String(
    telemetry?.storage || telemetry?.source || origin || '',
  ).toLowerCase()
  if (!capturedBy) return false
  return !/dashboard|browser|web|typed/.test(capturedBy)
}

/**
 * Grade what is actually known about this reply's journey.
 *
 * Returns the highest rung with real evidence behind it, plus the reason the
 * next rung up is missing. Never returns a rung whose witness did not speak.
 */
export function gradeAudioDelivery(events, { origin = '' } = {}) {
  const list = asEvents(events)
  const awaitsDevice = runAwaitsDevice(list, { origin })

  const played = latestOfStage(list, DELIVERY_STAGES.PLAYED)
  const received = latestDone(list, DELIVERY_STAGES.RECEIVED)
  const downlink = latestDone(list, DELIVERY_STAGES.DOWNLINK)
  const held = latestDone(list, DELIVERY_STAGES.HELD)
  const composed = latestDone(list, DELIVERY_STAGES.COMPOSED)

  let state = 'not_composed'
  let at = null
  let bytes = 0

  if (composed) {
    state = 'composed_on_mac'
    at = composed.at ?? null
    bytes = numericMeta(composed, 'pcmBytes', 'audioBytes')
  }
  if (held) {
    state = 'held_by_relay'
    at = held.at ?? at
    bytes = numericMeta(held, 'pcmBytes', 'audioBytes') || bytes
  }
  if (downlink) {
    /*
     * The relay writes this one. `pulledByDevice` distinguishes the device's own
     * authenticated GET (it asked) from a push the device may have slept
     * through. Absent the flag, claim only the weaker rung.
     */
    state = downlink.meta?.pulledByDevice
      ? 'requested_by_device'
      : 'bytes_sent_to_device'
    at = downlink.at ?? at
    bytes = numericMeta(downlink, 'sentBytes', 'pcmBytes', 'audioBytes') || bytes
  }
  if (received) {
    state = 'received_by_device'
    at = received.at ?? at
  }
  if (played?.status === 'done') {
    state = 'played_by_device'
    at = played.at ?? at
  }

  const grade = AUDIO_DELIVERY_STATES[state]
  const playbackFailed = played?.status === 'failed'
  const playbackActive = played?.status === 'active'

  return Object.freeze({
    state,
    rank: grade.rank,
    label: grade.label,
    witness: grade.witness,
    evidence: grade.evidence,
    proves: grade.proves,
    doesNotProve: grade.doesNotProve,
    provesPlayback: grade.provesPlayback,
    at,
    bytes,
    awaitsDevice,
    playbackActive,
    playbackFailed,
    /*
     * The headline. Never true unless the pendant itself said so, which on this
     * build it never does — so this reads 'unknown' on every real pendant run
     * and that is the correct, uncomfortable answer.
     */
    heard: grade.provesPlayback
      ? 'yes'
      : awaitsDevice
        ? HEARD_UNKNOWN
        : HEARD_NO_AUDIO,
    heardBecause: grade.provesPlayback
      ? grade.evidence
      : awaitsDevice
        ? `${grade.evidence} ${AUDIO_DELIVERY_STATES.played_by_device.gap}`
        : 'This run had no pendant waiting on it.',
  })
}

/**
 * The run status implied by the delivery grade, for a run whose Mac-side work
 * has finished and has not failed.
 *
 * `completed` only when the finish line was actually crossed: either the pendant
 * reported playback, or there was never a pendant in the loop. Everything else
 * is PLAYBACK_UNKNOWN_STATUS while the last mile is still plausibly moving —
 * except that a run still visibly in flight stays 'processing'.
 */
export function deliveryRunStatus(delivery, { macDone = false } = {}) {
  if (delivery.playbackFailed) return 'failed'
  if (delivery.provesPlayback) return 'completed'
  if (!delivery.awaitsDevice) return macDone ? 'completed' : 'processing'
  if (delivery.playbackActive) return 'processing'
  /*
   * Below the downlink rung the pendant genuinely has not been given a chance
   * yet — the relay is still holding the audio, waiting to be asked. That is
   * ordinary in-flight, not an unanswerable question.
   */
  if (delivery.rank < AUDIO_DELIVERY_STATES.bytes_sent_to_device.rank) {
    return 'processing'
  }
  return PLAYBACK_UNKNOWN_STATUS
}

/**
 * The exact contract a real playback report has to satisfy, kept in code so the
 * gap is reviewable rather than remembered.
 *
 * This is written for the accepted-but-unbuilt `audio_delivery_ack_queue` device
 * skill and the granted `record_pendant_delivery_event` tool. Until something
 * satisfies it, gradeAudioDelivery() will never return `played_by_device` and no
 * caller should behave as if it might.
 */
export const PLAYBACK_REPORT_CONTRACT = Object.freeze({
  stage: DELIVERY_STAGES.PLAYED,
  endpoint: 'POST /v1/pendant/jobs/:jobId/events',
  emitter: 'firmware/nrf9160/src/pendant_cloud.c',

  /*
   * The reporters already exist and build the right body. They have no call
   * sites — grep report_playback across the firmware and only the declarations
   * and definitions come back.
   */
  existingButUncalled: Object.freeze([
    'pendant_cloud_report_playback_started()',
    'pendant_cloud_report_playback_result()',
  ]),

  /*
   * Wiring the calls up is not sufficient, and this is the part that matters.
   * Each blocker is a thing that must change before a device_playback event can
   * be both produced AND meaningful.
   */
  blockers: Object.freeze([
    Object.freeze({
      what: 'The live path holds no job id.',
      detail:
        'post_pendant_event() returns -ENODATA when mac_job_id is empty. The duplex ' +
        'WebSocket path never sets it: the device sends {"type":"start"} with only a ' +
        'deviceTime, and the relay’s {"type":"started"} reply is matched by substring ' +
        'with its payload discarded. A playback report from a live conversation has ' +
        'nothing to correlate itself to.',
      requires:
        'The relay must put a correlation id in the "started" frame, and the firmware ' +
        'must parse it rather than strstr it. Until then a playback ACK can only ever ' +
        'cover the HTTP blob path.',
    }),
    Object.freeze({
      what: 'The speaker is stopped by DROP, not DRAIN.',
      detail:
        'Teardown calls i2s_trigger(I2S_DIR_BOTH, I2S_TRIGGER_DROP) and discards the ' +
        'queued tail by design, because draining as a clock slave needs the PWM clocks ' +
        'kept alive. The device therefore does not know that the last block reached the ' +
        'speaker — only that it stopped asking for more.',
      requires:
        'A report must state what it actually witnessed: frames handed to i2s_write() ' +
        'and the tail that was dropped. A bare "done" would be the same lie one layer ' +
        'lower down.',
    }),
    Object.freeze({
      what: 'Nothing counts what was played.',
      detail:
        'The only end-of-speech signal is a hangover timer on dl_jitter_fill(), used to ' +
        'duck the uplink bitrate and blink an LED. Per-conversation counters exist but ' +
        'are printk’d at teardown and never transmitted.',
      requires:
        'The report must carry played frames and dropped frames so a partial playback ' +
        'is distinguishable from a complete one.',
    }),
  ]),

  /*
   * What an honest report has to say. Note what is NOT here: no bare boolean
   * "played". A report that cannot distinguish a complete playback from a
   * truncated one is not evidence, and a readback truncated in the middle is
   * exactly the case that must never count.
   */
  requiredMeta: Object.freeze({
    framesPlayed: 'int — frames actually handed to i2s_write() for this reply.',
    framesDropped: 'int — frames discarded by the teardown DROP, 0 if it ran to the end.',
    interrupted: 'bool — true if a flush/barge-in or conversation end cut it short.',
    transport: 'string — "I2S".',
  }),

  /*
   * Status values a report may carry, and what each is allowed to mean. Only the
   * first sets played_by_device.
   */
  statusMeaning: Object.freeze({
    done: 'framesDropped === 0 and interrupted === false. The whole reply reached the speaker.',
    active: 'Playback started. Sets nothing; the run stays in progress.',
    failed:
      'Playback started and did not finish. This is a distinct fact from silence and ' +
      'must not be reported as done with a smaller frame count.',
  }),

  /*
   * A device may not grade itself into consent. approvalHandoff.js already
   * refuses 'playback-report' as unproducible; if this contract is ever
   * satisfied, that refusal is a separate decision made there, on its own
   * evidence, and not a consequence of this event existing.
   */
  doesNotImply:
    'That the owner heard it. A speaker running in an empty room satisfies this contract in full.',
})

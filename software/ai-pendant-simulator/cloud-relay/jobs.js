import crypto from 'node:crypto'
import {
  DELIVERY_STAGES,
  deliveryRunStatus,
  gradeAudioDelivery,
} from '../shared/audioDelivery.js'
/* The one definition of "this plan is parked for the owner's approval" —
 * shared with the routine reaper so the run feed and the scheduler can never
 * disagree about what a parked job is. */
import { jobParkedForApproval } from './routines.js'

export function createJobId() {
  return `job_${crypto.randomUUID()}`
}

export function createAudioCapture({
  audioBase64,
  audioRef = null,
  audioStorage = null,
  audioStorageWarning = null,
  audioBytes,
  format,
  language,
  transcript,
  transcriptionModel,
  planJobId = null,
  status = 'completed',
}) {
  const now = new Date().toISOString()

  return {
    jobId: createJobId(),
    type: 'audio_capture',
    status,
    planJobId,
    audioBase64,
    audioRef,
    audioStorage,
    ...(audioStorageWarning ? { audioStorageWarning } : {}),
    audioBytes,
    format,
    language: language ?? null,
    transcript,
    transcriptionModel,
    createdAt: now,
    updatedAt: now,
  }
}

export function createPlanJob({
  command,
  deviceId,
  sessionId,
  inputTelemetry = null,
  jobId = null,
  status = 'queued',
  /*
   * Opaque handle to the reasoning thread that produced this job, stored on
   * the relay. It travels instead of the context because it is ~60 bytes and
   * the context is up to 256 KB, and because the receiving body can ask for a
   * representation shaped for its own model. Null is the normal case and
   * means "start cold" — see local-agent/contextResume.js.
   */
  contextHandle = null,
}) {
  const now = new Date().toISOString()

  return {
    jobId: jobId ?? createJobId(),
    type: 'plan',
    status,
    command,
    sessionId: sessionId ?? null,
    contextHandle: contextHandle ?? null,
    inputTelemetry: inputTelemetry ?? null,
    deviceEvents: [],
    actions: [],
    result: null,
    error: null,
    createdBy: deviceId ?? 'mobile',
    createdAt: now,
    updatedAt: now,
    claimedBy: null,
    claimedAt: null,
  }
}

export function createExecuteJob({ command, actions, planJobId, deviceId, sessionId }) {
  const now = new Date().toISOString()

  return {
    jobId: createJobId(),
    type: 'execute',
    status: 'queued',
    command,
    actions,
    planJobId: planJobId ?? null,
    sessionId: sessionId ?? null,
    deviceEvents: [],
    result: null,
    error: null,
    createdBy: deviceId ?? 'mobile',
    createdAt: now,
    updatedAt: now,
    claimedBy: null,
    claimedAt: null,
  }
}

export function createAgentProxyJob({
  method,
  path,
  body,
  deviceId,
}) {
  const now = new Date().toISOString()

  return {
    jobId: createJobId(),
    type: 'agent_proxy',
    status: 'queued',
    command: `${method} ${path}`,
    sessionId: null,
    deviceEvents: [],
    actions: [],
    method: method || 'GET',
    path: path || '/',
    body: body ?? null,
    result: null,
    error: null,
    createdBy: deviceId ?? 'ops',
    createdAt: now,
    updatedAt: now,
    claimedBy: null,
    claimedAt: null,
  }
}

export function publicJob(job) {
  if (!job) {
    return null
  }

  return {
    jobId: job.jobId,
    type: job.type,
    status: job.status,
    command: job.command,
    actions: job.actions,
    planJobId: job.planJobId ?? null,
    method: job.method ?? null,
    path: job.path ?? null,
    inputTelemetry: job.inputTelemetry ?? null,
    /*
     * job.contextHandle is deliberately NOT here. This shape is what any
     * principal holding mac:jobs:read gets back — the pendant, the phone, the
     * dashboard — and the handle is a bearer capability for the owner's own
     * words. The one body that needs it, the Mac bridge, is handed it directly
     * on /v1/bridge/work under bridge:work:claim.
     */
    // Hint from audio-native Realtime plan; bridge executes actions without re-planning.
    plannerHint: job.plannerHint ?? null,
    toolsUsed: job.toolsUsed ?? null,
    deviceEvents: Array.isArray(job.deviceEvents)
      ? job.deviceEvents.slice(-32)
      : [],
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

// A job earns a spot in the operator feed when the owner started it directly:
// live LTE upload, legacy microSD-buffered label, or dashboard (spoken/typed).
const VOICE_RUN_ORIGINS = new Set([
  'live_lte',
  'microsd',
  'dashboard',
  'pendant_upload',
])

/*
 * Reasons pendantConverse.js's endConversation(reason) can close a duplex
 * conversation that captured audio but never recognised a word — the only
 * ambiguous case here, since "audio arrived AND a reply happened" is already
 * unambiguous (`answered`, below). Membership here means "this ending is
 * ordinary": the idle timer fired, the model settled the session on its own,
 * the pendant sent an explicit stop, a fresh press superseded this one, or
 * the socket closed the way it always does when a call is over. None of
 * those imply anything went wrong — a healthy press that heard silence is
 * not a failure.
 *
 * Deliberately NOT in this set: 'agent-error' (the Realtime session itself
 * errored), 'bad-audio' (the uplink Opus stream failed to decode) and
 * 'socket-error' (the transport broke while a conversation was live) — real
 * failures, and 'socket-error' covers the "truncated mid-upload" case this
 * fix is required to keep visible. An `endReason` that is absent entirely —
 * every capture written before this field existed — is ALSO not in this set
 * on purpose: a capture this code cannot explain stays a visible failure
 * rather than being reclassified on a guess. That is why the flood already
 * on the owner's dashboard renders exactly as it does today; only presses
 * from here forward get the honest read.
 */
const BENIGN_SILENCE_REASONS = new Set([
  'idle',
  'agent-done',
  'stopped',
  'restarted',
  'socket-closed',
])

/*
 * Conversational-only presses (the model answered by voice; no Mac job) leave
 * only an audio_capture behind. Surface those as first-class runs so chat
 * questions don't vanish from the dashboard.
 *
 * `feed: true` is the Recent-list membership rule (server.js /v1/ops/voice-
 * runs and its /latest probe): a benign silent press returns null there, so
 * it never occupies one of the feed's slots. Every other caller (the full
 * /v1/ops/history page, a direct run-detail lookup) keeps the default and
 * still gets a real run back — nothing here is ever deleted, only excluded
 * from the glanceable list.
 */
export function voiceRunForCapture(capture, { feed = false } = {}) {
  if (!capture || capture.type !== 'audio_capture') return null
  if (capture.planJobId) return null // its plan job already owns the run
  if (capture.role === 'reply') return null // agent-voice sidecar, not a run
  const transcript = String(capture.transcript || '').trim()
  /*
   * Whether the agent actually said anything back. This used to be assumed:
   * the agent event was hardcoded to 'done' with the label "Answered by
   * voice", so a run where the model produced NOTHING was recorded as a
   * success and looked healthy on every dashboard. The pendant's own
   * decoded_packets=0 was the only place the truth appeared. A reply exists
   * only if audio was captured for it or it left a transcript.
   */
  const replyTranscript = String(capture.replyTranscript || '').trim()
  const answered = Boolean(capture.replyCaptureId) || Boolean(replyTranscript)

  /*
   * "Nobody spoke" and "speech-to-text broke" look identical from the
   * transcript alone — both are empty. `endReason`, stamped by
   * pendantConverse.js at the moment the conversation actually ended, is the
   * one place that distinction is still known; see BENIGN_SILENCE_REASONS.
   */
  const noSpeech = !transcript && !answered
  const benignSilence =
    noSpeech && BENIGN_SILENCE_REASONS.has(String(capture.endReason || ''))

  if (benignSilence && feed) return null

  /*
   * A reply capture is built from the very same PCM buffer that the duplex
   * handler encodes and server.send()s frame by frame (see the onAudioDelta
   * callback in pendantConverse.js), so its existence really does witness bytes
   * going onto the pendant's socket. That is all it witnesses. The pendant is
   * pushed to here, not asked, so it cannot even be claimed that the device was
   * awake — only that the relay wrote.
   */
  const events = [
    {
        eventId: `cloud-${capture.jobId}-transcription`,
        stage: 'transcription',
        status: transcript ? 'done' : 'failed',
        label: transcript
          ? 'Transcript received from cloud'
          : 'Speech was not recognized',
        detail: 'Speech-to-text ran inside the Realtime session.',
        text: transcript,
        source: 'cloudflare',
        meta: { audioBytes: capture.audioBytes, format: capture.format },
        at: capture.createdAt,
      },
      {
        eventId: `cloud-${capture.jobId}-agent`,
        stage: 'agent',
        status: answered ? 'done' : benignSilence ? 'skipped' : 'failed',
        label: answered
          ? 'Answered by voice (no Mac action)'
          : benignSilence
            ? 'Nothing to answer — no speech reached the agent'
            : 'The agent produced no reply',
        detail: answered
          ? 'The cloud agent spoke its reply down the pendant stream; the Mac was not involved.'
          : benignSilence
            ? 'The press opened a conversation and it ended without anyone speaking. Nothing was asked, so there is nothing to answer.'
            : capture.endError ||
              'Speech reached the relay and was stored, but no reply audio or text came back. The pendant played silence.',
        text: replyTranscript,
        source: 'cloudflare',
        meta: null,
        at: capture.updatedAt || capture.createdAt,
      },
    ]

  if (capture.replyCaptureId) {
    events.push({
      eventId: `cloud-${capture.jobId}-downlink`,
      stage: DELIVERY_STAGES.DOWNLINK,
      status: 'done',
      label: 'Reply audio written to the pendant socket',
      detail:
        'The relay encoded the reply and pushed the frames down the open ' +
        'conversation socket. Bytes leaving the relay is the whole of what this ' +
        'observes — nothing here reports that the pendant played them.',
      text: '',
      source: 'cloudflare',
      meta: {
        pulledByDevice: false,
        transport: 'websocket',
        witness: 'relay-socket',
        replyCaptureId: capture.replyCaptureId,
      },
      at: capture.updatedAt || capture.createdAt,
    })
  }

  return {
    pipelineId: capture.jobId,
    kind: 'voice_command',
    command: transcript,
    source: 'cloudflare',
    origin: 'live_lte',
    /*
     * `status` still answers "did the agent produce a reply", which is the
     * question jobsVoiceRun.test.js locked down. `delivery` answers the separate
     * question of whether the reply ever became sound, and on this path the
     * honest answer stops at "the relay wrote bytes at the device". A benign
     * silent press is neither — 'recorded' is the same terminal vocabulary
     * browserTaskHistory.js falls back to for "ended honestly, no verdict
     * either way," which the dashboard already renders as a neutral, non-red
     * "Recorded" rather than a failure.
     */
    status: answered ? 'completed' : benignSilence ? 'recorded' : 'failed',
    delivery: gradeAudioDelivery(events, { origin: 'live_lte' }),
    error: answered
      ? null
      : benignSilence
        ? null
        : capture.endError ||
          'The pendant uploaded audio but the agent produced no reply.',
    events,
    createdAt: capture.createdAt,
    updatedAt: capture.updatedAt || capture.createdAt,
    audio: {
      captureId: capture.jobId,
      replyCaptureId: capture.replyCaptureId || null,
      replyTranscript: capture.replyTranscript || null,
    },
  }
}

export function voiceRunForJob(job, { now = Date.now(), feed = false } = {}) {
  if (!job || job.type !== 'plan') return null
  const telemetry = job.inputTelemetry
  const origin = String(telemetry?.storage || '').toLowerCase()
  if (!VOICE_RUN_ORIGINS.has(origin)) return null
  const typed = String(telemetry?.inputMode || '') === 'typed'

  const events = []
  const hasTranscript = /[\p{L}\p{N}]/u.test(String(job.command || ''))
  // Boot diagnostics / failed uploads can leave status=transcribing forever.
  // After this window, treat them as failed so the dashboard returns to idle.
  const STALE_TRANSCRIBE_MS = 90_000
  const updatedMs = new Date(job.updatedAt || job.createdAt || 0).getTime()
  const ageMs = Number.isFinite(updatedMs) ? Number(now) - updatedMs : 0
  const transcriptionStale =
    job.status === 'transcribing' && ageMs > STALE_TRANSCRIBE_MS
  const transcriptionPending =
    job.status === 'transcribing' && !transcriptionStale
  events.push(
    typed
      ? {
          eventId: `cloud-${job.jobId}-transcription`,
          stage: 'transcription',
          status: 'done',
          label: 'Typed in the dashboard',
          detail:
            'Command typed on a signed-in device, so there was no audio to transcribe.',
          text: String(job.command || ''),
          source: 'dashboard',
          meta: { inputTelemetry: telemetry },
          at: job.createdAt,
        }
      : {
          eventId: `cloud-${job.jobId}-transcription`,
          stage: 'transcription',
          status: transcriptionPending
            ? 'active'
            : hasTranscript
              ? 'done'
              : 'failed',
          label: transcriptionPending
            ? 'Recording received; transcription running'
            : hasTranscript
              ? 'Transcript received from cloud'
              : transcriptionStale
                ? 'Transcription timed out'
                : 'Speech was not recognized',
          detail: transcriptionPending
            ? 'Cloudflare received the pendant recording and is transcribing it now.'
            : hasTranscript
              ? 'Speech-to-text completed before this job reached the Mac bridge.'
              : transcriptionStale
                ? 'This run sat in transcribing with no transcript — usually a failed or partial upload. Safe to ignore; start a new recording.'
                : job.error ||
                  'Audio arrived, but speech-to-text did not return words.',
          text: String(job.command || ''),
          source: 'cloudflare',
          meta: { inputTelemetry: telemetry },
          at: job.createdAt,
        },
  )

  const result = job.result && typeof job.result === 'object' ? job.result : null
  const macActionDone = Boolean(
    result &&
      (result.executed === true ||
        result.phase === 'executed' ||
        result.execution?.ok === true ||
        (result.execution && result.executed !== false)),
  )
  /*
   * Parked for approval is neither done nor failed, and the feed must not
   * pick a side. Before this check a parked plan_ready job satisfied the
   * dashboard's "agent event done" clause and the whole run rendered as
   * COMPLETED — a plan nobody had approved, reported as finished. Jobs a
   * pre-fix bridge recorded as status 'failed' keep reading as failed here:
   * that is what that bridge claimed, and the routine reaper (not this feed)
   * is the compatibility path that rescues those.
   */
  const parkedRun =
    !['failed', 'cancelled'].includes(String(job.status || '')) &&
    jobParkedForApproval(job)
  if (result) {
    const actionText = Array.isArray(result.actions)
      ? result.actions
          .map((action) => {
            const label = String(
              action?.label || action?.description || action?.type || '',
            ).trim()
            const parameters =
              action?.params && typeof action.params === 'object'
                ? Object.entries(action.params)
                    .map(([key, value]) => `${key}: ${String(value)}`)
                    .join(', ')
                : ''
            return parameters ? `${label} (${parameters})` : label
          })
          .filter(Boolean)
          .join('\n')
      : ''
    const agentText = String(
      result.response || result.summary || actionText || '',
    )
    events.push({
      eventId: `cloud-${job.jobId}-agent`,
      stage: 'agent',
      status: parkedRun ? 'waiting' : 'done',
      label: parkedRun
        ? 'Waiting for your approval'
        : macActionDone
          ? 'Plan executed on this Mac'
          : actionText
            ? 'Mac action selected'
            : 'Agent response ready',
      detail: parkedRun
        ? 'The plan is parked for your approval on the dashboard; nothing has run yet.'
        : macActionDone
          ? 'The Mac already ran the action; speech may still be rendering.'
          : actionText
            ? 'The Mac agent produced this action plan from the transcript.'
            : 'The Mac agent completed this request.',
      text: agentText,
      source: 'mac-bridge',
      meta: {
        planner: result.planner || null,
        thinkingTraceId: result.thinking?.traceId || null,
        actions: Array.isArray(result.actions) ? result.actions : [],
        executed: macActionDone,
        phase: result.phase || null,
        ...(parkedRun
          ? {
              parked: true,
              awaitingApproval: Array.isArray(result.awaitingApproval)
                ? result.awaitingApproval
                : [],
            }
          : {}),
      },
      at: result.thinking?.updatedAt || job.updatedAt,
    })

    const speech = result.pendantSpeech
    if (speech && typeof speech === 'object') {
      events.push({
        eventId: `cloud-${job.jobId}-tts`,
        stage: 'tts',
        status: 'done',
        label: 'Response speech rendered',
        detail: 'The Mac rendered raw PCM for the pendant.',
        text: agentText,
        source: 'mac-bridge',
        meta: {
          format: speech.format,
          sampleRate: speech.sampleRate,
          channels: speech.channels,
          bitsPerSample: speech.bitsPerSample,
          pcmBytes: speech.pcmBytes,
        },
        at: job.updatedAt,
      })
    } else if (macActionDone && job.status === 'processing') {
      events.push({
        eventId: `cloud-${job.jobId}-tts-pending`,
        stage: 'tts',
        status: 'active',
        label: 'Rendering response speech',
        detail: 'Action already ran; generating the spoken confirmation.',
        text: agentText,
        source: 'mac-bridge',
        meta: null,
        at: job.updatedAt,
      })
    }

    if (['plan_ready', 'completed'].includes(job.status) && speech) {
      events.push({
        eventId: `cloud-${job.jobId}-relay`,
        stage: 'relay_result',
        status: 'done',
        label: 'Agent result stored in Cloudflare',
        detail: 'The response is ready for the pendant to download.',
        source: 'cloudflare',
        meta: null,
        at: job.updatedAt,
      })
    }
  } else if (
    !transcriptionPending &&
    !['failed', 'cancelled', 'completed'].includes(job.status)
  ) {
    events.push({
      eventId: `cloud-${job.jobId}-agent-active`,
      stage: 'agent',
      status: ['queued', 'transcribed'].includes(job.status)
        ? 'waiting'
        : 'active',
      label:
        job.status === 'transcribed'
          ? 'Transcript ready; dispatching to Mac'
          : job.status === 'queued'
            ? 'Waiting for Mac agent'
            : 'Mac agent is processing',
      detail:
        job.status === 'transcribed'
          ? 'The pendant is linking this transcript to the agent job.'
          : 'The transcript is moving through the Mac bridge and agent.',
      text: '',
      source: 'cloudflare',
      meta: null,
      at: job.updatedAt,
    })
  }

  for (const event of Array.isArray(job.deviceEvents) ? job.deviceEvents : []) {
    events.push({
      eventId: event.eventId,
      stage: event.stage,
      status: event.status,
      label: event.label,
      detail: event.detail,
      text: event.text || '',
      source: event.source || 'nrf9160',
      meta: event.meta || null,
      at: event.at,
    })
  }

  /*
   * What is actually known about the reply reaching the pendant, graded against
   * the body that witnessed each step. This used to be a single boolean looking
   * for a `device_playback` done event that nothing in this system has ever
   * emitted — so it was always false, and the status fell through to Mac-side
   * completion. A run the owner may never have heard rendered as "Done".
   */
  const delivery = gradeAudioDelivery(events, { origin })

  // The Mac's own finish line: the plan ran. Says nothing about the pendant.
  const macDone =
    macActionDone ||
    events.some(
      (event) =>
        event.stage === 'agent' &&
        event.status === 'done' &&
        (origin === 'dashboard' ||
          /executed|Plan executed/i.test(String(event.label || ''))),
    )

  /*
   * A job that reached 'transcribed' and stopped there, with no error and no
   * useful words, is the /v1/transcribe sibling of the duplex-conversation
   * silence bug (voiceRunForCapture, above) — same product, same mistake:
   * speech-to-text ran and genuinely heard nothing, which is not a failure.
   * This is safe to call "genuinely nothing happened" rather than "we don't
   * know why it failed": a real STT error already sets job.status to
   * 'failed' with the real message at write time (server.js /v1/transcribe's
   * catch block) or leaves it 'transcribing' past STALE_TRANSCRIBE_MS —
   * BOTH of which the first branch below already claims as 'failed' before
   * this one is ever reached. `typed` is excluded on purpose — an empty
   * *typed* command would be a different, stranger bug, not silence.
   */
  const genuinelyFailed =
    ['failed', 'cancelled'].includes(job.status) || transcriptionStale
  const recordedSilently =
    !genuinelyFailed &&
    !transcriptionPending &&
    !typed &&
    !(macDone || delivery.rank > 0) &&
    !hasTranscript &&
    !result

  if (recordedSilently && feed) return null

  const status = genuinelyFailed
    ? 'failed'
    : transcriptionPending
      ? 'processing'
      : macDone || delivery.rank > 0
        ? /*
           * Browser-originated runs have no speaker waiting, so the Mac's
           * answer really is their finish line and deliveryRunStatus() says
           * so. Pendant runs get PLAYBACK_UNKNOWN_STATUS instead of
           * 'completed': the audio left the relay and nothing on this system
           * can say whether it was ever played.
           */
          deliveryRunStatus(delivery, { macDone })
        : hasTranscript || result
          ? 'processing'
          : recordedSilently
            ? 'recorded'
            : 'failed'

  return {
    pipelineId: job.jobId,
    kind: 'voice_command',
    command: String(job.command || ''),
    source: 'cloudflare',
    origin,
    status,
    delivery,
    events,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
    audio: {
      captureId: telemetry?.captureId || null,
      replyCaptureId: null,
      replyTranscript: String(result?.response || '').trim() || null,
    },
  }
}

/*
 * Consecutive failures wider apart than this read as a recurring problem
 * worth seeing separately (the owner hit the same bug this morning and
 * again tonight), not one burst. The flood this fix responds to was eight
 * presses inside two minutes, so ten minutes is generous headroom for "one
 * burst" without being wide enough to hide a real intermittent pattern.
 */
const REPEAT_FOLD_WINDOW_MS = 10 * 60_000

/*
 * Fold consecutive, indistinguishable failures into one row with a count.
 *
 * A repeated identical failure is still real and must stay visible — the
 * whole point of BENIGN_SILENCE_REASONS above is that a non-event gets
 * filtered out well before this runs, so anything reaching here that is
 * `status: 'failed'` genuinely happened. But DESIGN.md's "no repeating text"
 * rule does not carve out an exception for real failures: if a device hits
 * the same error press after press (a dead network, a broken Realtime
 * session), eight identical rows are exactly as unreadable as eight
 * identical silences were. Only ever folds ADJACENT entries in an
 * already-newest-first list that share a device, a non-empty identical error
 * string, AND fall within REPEAT_FOLD_WINDOW_MS of each other — two
 * different failures, the same failure hours apart, or one separated by
 * something else that happened in between, are never merged. `completed`
 * and `recorded` runs are never touched: two genuinely repeated actions (the
 * owner asked twice) are two real events, not noise.
 */
export function collapseRepeatRuns(runs) {
  const list = Array.isArray(runs) ? runs : []
  const collapsed = []

  for (const run of list) {
    const previous = collapsed[collapsed.length - 1]
    if (previous && isRepeatFailure(previous, run)) {
      previous.repeatCount = (previous.repeatCount || 1) + 1
      previous.repeatFirstAt = run.createdAt || previous.repeatFirstAt
      continue
    }
    collapsed.push({ ...run })
  }

  return collapsed.map((run) =>
    run.repeatCount > 1 ? withRepeatNote(run) : run,
  )
}

function isRepeatFailure(a, b) {
  if (a.status !== 'failed' || b.status !== 'failed') return false
  if (!a.error || String(a.error).trim() !== String(b.error || '').trim()) {
    return false
  }
  if (String(a.origin || '') !== String(b.origin || '')) return false
  const gapMs = Math.abs(
    new Date(a.repeatFirstAt || a.createdAt || 0).getTime() -
      new Date(b.createdAt || 0).getTime(),
  )
  return Number.isFinite(gapMs) && gapMs <= REPEAT_FOLD_WINDOW_MS
}

function withRepeatNote(run) {
  const note = `This exact failure repeated ${run.repeatCount} times in a row (most recently just now); the earlier ones are folded into this row to keep the list readable.`
  return {
    ...run,
    error: `${run.error} ${note}`,
  }
}

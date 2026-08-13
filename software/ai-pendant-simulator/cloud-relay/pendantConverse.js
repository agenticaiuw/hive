/*
 * Full-duplex pendant conversation over one WebSocket.
 *
 * The nRF9160 keeps this socket open and speaks a tiny protocol:
 *   text frames  — JSON control:
 *     up:   {type:'start', sampleRate?, deviceTime?, deviceId?}
 *           {type:'stop'}   (button press: end the conversation)
 *           {type:'ping'}
 *     down: {type:'started'}
 *           {type:'pong'}
 *           {type:'flush'}  (barge-in: drop any buffered agent audio NOW)
 *           {type:'end', reason}  (conversation over — stopped/idle/error)
 *   binary frames — length-prefixed Opus packets (2-byte BE), both ways.
 *     Uplink is 16 kHz mic audio; downlink is 16 kHz agent speech. Every
 *     downlink frame stays under the nRF9160 modem's ~2 KB TLS record limit.
 *
 * Unlike the chunked-HTTP path there is no body end: OpenAI's semantic VAD
 * segments utterances and speaks whenever it decides to, audio flows down
 * the moment it is generated, and the model can be interrupted mid-sentence
 * by the owner's voice. The button only ends the conversation.
 */
import {
  createStreamingRealtimeSession,
  REALTIME_PCM_RATE,
} from './openaiRealtimeVoice.js'
import {
  createOpusReplyEncoder,
  createOpusUploadDecoder,
  OPUS_WIRE_SAMPLE_RATE,
} from './opusTranscode.js'
import { createAudioCapture } from './jobs.js'
import { RECALL_JOB_LIMIT, recallJobStatus } from './jobRecall.js'
import { getStore } from './store/index.js'
import { loadFleetFromStore, parseDeviceTime } from './fleetContext.js'
/*
 * The screenless app framework (docs/Screenless_App_Grammar.md). The pendant
 * is stateless — it sends {"type":"menu",delta:±1} per detent,
 * {"type":"menu_select"} per YELLOW press while the ring is open and
 * {"type":"menu_back"} per BLUE press — so the ring, the mode and the presets
 * all live HERE, in the conversation's own state. A menu exists only while
 * this socket is open, which is the honest scope: today's firmware plays no
 * audio outside a started conversation, and a menu you cannot hear is not a
 * menu.
 *
 * BECAUSE THE RING LIVES HERE, THE DEVICE MUST BE TOLD WHEN IT OPENS. The same
 * two buttons carry global verbs (talk, memo) when the ring is closed and ring
 * verbs (select, back) when it is open, and the device cannot work out which
 * state it is in — this socket is the only thing that knows. Every transition
 * therefore sends {"type":"menu_context","active":bool} AHEAD of the sound
 * that announces it. See handleMenuFrame's 'context' effect.
 */
import {
  createMenuState,
  clockLabel,
  currentRing,
  menuContextFrame,
  menuIsOpen,
  menuWithAudioDevices,
  reduceMenuFrame,
} from './menuRing.js'
import { createSettle, SETTLE_MS } from './menuSettle.js'
import { renderNumberPcm } from './spokenNumbers.js'
import { renderEarconPcm, renderTimerChimePcm } from './pendantEarcon.js'
import {
  appBriefSpeech,
  appFetchingSpeech,
  appMacPlan,
  macUnansweredSpeech,
  timeSpeech,
} from './pendantApps.js'
import {
  claimDueTimers,
  createTimerControl,
  settleClaimedTimer,
  startAlarm,
  startTimer,
  timerOverdueSpeech,
  timerSetSpeech,
} from './timerStore.js'
import { createDomainMemoryRelay } from './domainMemoryRelay.js'
import { persistAudioCapture } from './audioStorage.js'
import { pcmS16leToWavBuffer } from './rawAudio.js'
import {
  ANNOUNCE_ON_CONNECT,
  RELAY_API_KEY,
} from './config.js'
import {
  authenticateRelayRequest,
  principalHasScopes,
  principalOwnsDevice,
} from './deviceAuth.js'
import { SOCKET_SCOPES } from './relayScopes.js'
import {
  announcementDeliveryOutcome,
  renderAnnouncementPcm,
  selectDeliverable,
  streamAnnouncementPcm,
} from './announce.js'
import { speakNextApproval } from './approvalStore.js'
import {
  answerSpokenApproval,
  decideNextPendingApproval,
  isPendantRoutedApproval,
} from './approvalDelivery.js'
import { registerConverseSession } from './converseSessions.js'
import { synthesizeSpeech } from './speak.js'
import {
  enqueueMacPlanJob,
  trimMacResultForModel,
} from './server.js'

/*
 * Modem-safe downlink framing. The hard ceiling is the nRF9160's ~2 KB TLS
 * record limit, but the REAL contract is the firmware's 640 B receive
 * buffer and its jitter-ring flow-control gate (a frame may decode to at
 * most ~4 packets ≈ 3,840 samples). Packet-aligned at ≤500 B.
 */
const MAX_DOWNLINK_FRAME_BYTES = 500
/* End the conversation when neither side has said anything for this long. */
const IDLE_END_MS = 30_000
const IDLE_SWEEP_MS = 5_000
/*
 * How long the knob waits after the last detent before SAYING where it landed.
 * The blip is instant; the name is not. Spinning through four apps must cost
 * four blips and one sentence, not four sentences.
 *
 * It lives in cloud-relay/menuSettle.js now, with an injectable clock, because
 * numeric entry made "exactly one utterance per burst" a promise worth testing
 * rather than asserting: a forty-detent spin from ten minutes to fifty must
 * speak ONE number. It is also no longer coupled to a commit — the old dwell
 * needed the name to land 1.3 s before the selection it caused, and with a
 * button doing the committing that ordering constraint is simply gone. This
 * number is now free to be tuned for feel alone.
 */
const MENU_NAME_SETTLE_MS = SETTLE_MS
/*
 * How long an app brief waits on the Mac before it says so out loud.
 *
 * Measured, not chosen: the Reminders read takes ~16 s on the owner's Mac
 * (2026-08-12, bulk-fetch form — the per-item loop never returned at all).
 * The model's own 9 s status window would therefore make "Your Mac hasn't
 * answered yet" the usual answer to a question the Mac was about to answer
 * correctly. 26 s clears the measurement with margin for the bridge's claim
 * poll, and stays under IDLE_END_MS so the brief still has a live
 * conversation to land in — the "Checking your reminders." line spoken on
 * entry refreshes the idle clock, so the window is a full 26 s from there.
 */
const APP_BRIEF_WAIT_MS = 26_000
/* Capture caps mirror the HTTP path's diagnostic limits. */
const CAPTURE_MAX_BYTES = 7_500_000

/*
 * Split a length-prefixed Opus wire buffer at packet boundaries, capping
 * BOTH bytes and packet count per frame. The byte cap alone is not enough:
 * DTX/comfort-noise packets are a few bytes each, so a 500 B frame could
 * smuggle dozens of 60 ms packets past the firmware's ring budget, which
 * assumes ≤ MAX_DOWNLINK_FRAME_PACKETS × 960 samples per frame.
 */
const MAX_DOWNLINK_FRAME_PACKETS = 2
function splitWireFrames(wire, maxBytes = MAX_DOWNLINK_FRAME_BYTES) {
  const frames = []
  let start = 0
  let cursor = 0
  let packets = 0
  while (cursor + 2 <= wire.length) {
    const packetEnd = cursor + 2 + wire.readUInt16BE(cursor)
    if (
      cursor > start &&
      (packetEnd - start > maxBytes || packets >= MAX_DOWNLINK_FRAME_PACKETS)
    ) {
      frames.push(wire.subarray(start, cursor))
      start = cursor
      packets = 0
    }
    cursor = packetEnd
    packets += 1
  }
  if (start < wire.length) frames.push(wire.subarray(start))
  return frames
}

export function isPendantConverseRequest(request, url) {
  return (
    url.pathname === '/v1/pendant/converse' &&
    String(request.headers.get('Upgrade') || '').toLowerCase() === 'websocket'
  )
}

/*
 * Authenticate the duplex voice socket.
 *
 * This used to be `auth !== 'Bearer ' + RELAY_API_KEY` — an exact match on the
 * ADMIN key and nothing else. That single line made the scoped scheme
 * unusable on the pendant: a paired nrf_pendant token was refused here, so the
 * only credential that could open the pendant's main voice path was the one
 * that also opens /v1/ops/*. Now it runs the same authenticateRelayRequest the
 * Express routes and the bridge doorbell run, and demands the scopes this
 * socket actually exercises — it uploads captured audio and streams the spoken
 * reply back, i.e. the socket form of /v1/pendant/command plus the speech
 * read. A device principal must also own the X-Device-Id it claims, so one
 * paired pendant cannot open a conversation as another.
 *
 * The admin key still passes (scopes '*'), which is what keeps today's
 * unmigrated firmware working while the token is provisioned.
 */
async function authenticateConverse(request, deviceId) {
  const auth = await authenticateRelayRequest({
    authorization: request.headers.get('Authorization') || '',
    adminApiKey: RELAY_API_KEY,
    credentialStore: await getStore(),
  })
  if (!auth.ok) {
    return { ok: false, status: auth.status || 401 }
  }
  if (
    !principalHasScopes(auth.principal, ...SOCKET_SCOPES['/v1/pendant/converse'])
  ) {
    return { ok: false, status: 403 }
  }
  if (!principalOwnsDevice(auth.principal, deviceId)) {
    return { ok: false, status: 403 }
  }
  return { ok: true, principal: auth.principal }
}

export async function handlePendantConverse(request, context) {
  const deviceIdHeader =
    String(request.headers.get('X-Device-Id') || '').trim() ||
    'nrf9160-pendant'

  const authorized = await authenticateConverse(request, deviceIdHeader)
  if (!authorized.ok) {
    return new Response(
      authorized.status === 403
        ? 'Blocked for safety: this device may not open a pendant conversation.'
        : 'Unauthorized',
      { status: authorized.status },
    )
  }

  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)
  server.accept()
  if ('binaryType' in server) server.binaryType = 'arraybuffer'

  /* ---- per-socket state; one conversation at a time, sequential reuse ---- */
  let convo = null

  const sendJson = (obj) => {
    try {
      server.send(JSON.stringify(obj))
    } catch {
      /* socket already gone */
    }
  }

  async function startConversation(startMsg) {
    if (convo) await endConversation('restarted')
    const startedAt = Date.now()
    const deviceId =
      String(startMsg.deviceId || '').trim() || deviceIdHeader
    /*
     * The state exists SYNCHRONOUSLY: the firmware starts streaming audio
     * the instant it sends {start}, racing every await below. Frames that
     * arrive before the decoder/session are ready buffer in pendingWire /
     * pendingPcm — dropping them would desync the length-prefix stream
     * (frames are not packet-aligned).
     */
    const state = {
      store: null,
      deviceId,
      startedAt,
      lastActivityAt: startedAt,
      lastDownlinkAt: 0,
      jobs: [],
      jobCount: 0,
      turns: [],
      userPcm: [],
      userPcmBytes: 0,
      replyPcm: [],
      replyPcmBytes: 0,
      uploadDecoder: null,
      replyEncoder: null,
      session: null,
      pendingWire: [],
      pendingPcm: [],
      idleTimer: null,
      ended: false,
      /* A queued announcement is currently streaming down this socket. Any
       * model audio or owner speech clears it — see onAudioDelta/onUserSpeech. */
      announcing: false,
      /*
       * The approval whose readback this conversation just spoke, if any. The
       * NEXT owner utterance is tried against it as a yes/no; ordinary speech
       * clears it (the owner moved on; the record stays pending for the next
       * press). Null means no readback is awaiting an answer.
       */
      pendingApprovalAnswer: null,
      /*
       * EVERYTHING THE RELAY SAYS ON ITS OWN runs one at a time, in order, on
       * this one chain: approval readbacks, the menu's earcons and names, an
       * app's spoken surface, a timer chime. They all feed the same STATEFUL
       * Opus encoder, so two running concurrently would splice one sound into
       * the middle of another — a briefing through a readback, a blip through
       * the word "Calendar". One chain is the only place that invariant can
       * live. (It was `approvalRuns` when approvals were the only thing the
       * relay said unprompted; the apps made it general.)
       *
       * `approvalRunQueued` still collapses a burst of approval nudges into
       * one pending run: the run reads the STORE when it starts, so whatever
       * was saved by then gets spoken.
       */
      relaySpeechRuns: Promise.resolve(),
      approvalRunQueued: false,
      /* Set at register time (initConversation); called by endConversation. */
      unregisterSession: null,
      /*
       * The app ring, held relay-side because the pendant is stateless. Closed
       * at the start of every conversation and reset when it ends: the next
       * press begins at the ring's home position, so the same gesture always
       * means the same thing.
       */
      menu: createMenuState(),
      /* The settle debounce (cloud-relay/menuSettle.js), built on first use
       * because it closes over this state. One utterance per burst, whether
       * that utterance is a ring position or a bare number. */
      menuSettle: null,
      /* Non-zero while a bt_list is outstanding. A bt_devices frame the owner
       * did not ask for must not yank the ring out from under them. */
      audioAskedAt: 0,
      /* Timer verbs shared with the voice loop, so a knob-set and a voice-set
       * timer are one system. Built in initConversation once the store exists. */
      timerControl: null,
      /* The owner's clock, for the Time app: the pendant's own LTE network
       * time when it parses, the Mac's reported timezone otherwise. */
      deviceTime: parseDeviceTime(startMsg.deviceTime, startedAt),
      timezone: null,
    }
    convo = state

    try {
      await initConversation(state, startMsg)
    } catch (error) {
      // Kill only OUR conversation; a newer start may own convo already.
      state.ended = true
      clearInterval(state.idleTimer)
      if (convo === state) convo = null
      throw error
    }
  }

  async function initConversation(state, startMsg) {
    const { deviceId, startedAt } = state
    const store = await getStore()
    state.store = store
    /*
     * One fleet read, two consumers: the model's instructions and the Time
     * app's timezone. Read once because a second loadFleetFromStore is a
     * second store round-trip for a string that cannot have changed in the
     * milliseconds between them.
     */
    const fleetPromise = loadFleetFromStore(store).catch(() => null)
    void fleetPromise.then((fleet) => {
      state.timezone = fleet?.mac?.timezone || null
    })
    state.timerControl = createTimerControl({ store, deviceId })
    state.uploadDecoder = await createOpusUploadDecoder()
    for (const wire of state.pendingWire) {
      try {
        const pcm = state.uploadDecoder.push(wire)
        if (pcm.length) {
          state.pendingPcm.push(pcm)
          if (state.userPcmBytes < CAPTURE_MAX_BYTES) {
            state.userPcm.push(pcm)
            state.userPcmBytes += pcm.length
          }
        }
      } catch (error) {
        console.warn(`[converse] pre-session decode: ${error?.message}`)
      }
    }
    state.pendingWire = null
    state.replyEncoder = await createOpusReplyEncoder()
    if (state.ended) return

    const dispatchPlan = async (plan) => {
      const hasWork =
        Boolean(String(plan?.text || '').trim()) ||
        (Array.isArray(plan?.actions) && plan.actions.length > 0) ||
        Boolean(String(plan?.response || '').trim()) ||
        Boolean(plan?.requireLocalPlanner)
      if (!hasWork) return null
      state.jobCount += 1
      const job = await enqueueMacPlanJob({
        store,
        deviceId,
        sessionId: null,
        plan,
        rawAudioBytes: state.userPcmBytes,
        format: 'opus-frames',
        sampleRate: OPUS_WIRE_SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        transcriptionDurationMs: Date.now() - startedAt,
        /* Yellow: this is the live conversation socket by definition. */
        pendantMode: 'duplex',
      })
      if (job?.jobId) state.jobs.push(job.jobId)
      return job
    }

    state.session = await createStreamingRealtimeSession({
      inputSampleRate: OPUS_WIRE_SAMPLE_RATE,
      fleet: fleetPromise,
      audioOut: true,
      conversation: true,
      /*
       * Capability-domain memory, replacing the generic spoken-memory tier
       * the owner deleted ("delete all of these bullshits"): deliberate
       * saves now go through the model's memory_save tool, and each domain's
       * facts are fetched when that domain's tool is selected. The closures
       * read and merge the hive block in fleet state (domainMemoryRelay.js).
       */
      domainMemory: createDomainMemoryRelay({ store }),
      deviceTime: String(startMsg.deviceTime || '').trim() || null,
      onAudioDelta: (pcm) => {
        state.lastActivityAt = Date.now()
        state.lastDownlinkAt = Date.now()
        /*
         * The model has something to say, so it wins the socket. Both feed
         * the same stateful Opus encoder; letting them interleave would
         * splice a briefing into the middle of an answer.
         */
        state.announcing = false
        if (state.replyPcmBytes < CAPTURE_MAX_BYTES) {
          state.replyPcm.push(Buffer.from(pcm))
          state.replyPcmBytes += pcm.length
        }
        const wire = state.replyEncoder.push(pcm)
        if (!wire.length) return
        for (const frame of splitWireFrames(wire)) {
          try {
            server.send(frame)
          } catch {
            /* device leg died; close handler ends the conversation */
          }
        }
      },
      onTurn: (turn) => {
        state.lastActivityAt = Date.now()
        if (turn.transcript || turn.response) state.turns.push(turn)
        /*
         * A readback was just spoken, so this utterance gets first refusal as
         * its answer. answerSpokenApproval is gated on a decisive yes/no —
         * "what's my battery" returns not_an_answer and touches nothing — so
         * feeding it every turn is safe, and the model hearing the same words
         * costs a slightly puzzled reply, not a commitment.
         */
        if (turn.transcript && state.pendingApprovalAnswer) {
          const approvalId = state.pendingApprovalAnswer
          void answerSpokenApproval({
            store: state.store,
            approvalId,
            utterance: turn.transcript,
          })
            .then((outcome) => {
              /* One shot per readback unless the machinery asked for a retry
               * (a bare confirm word, a missing witness). Anything settled or
               * off-topic stops listening; the next press re-reads what is
               * still pending. */
              const retryable = ['confirm_word_alone', 'needs_confirm_word'].includes(outcome.code)
              if (!retryable) state.pendingApprovalAnswer = null
              if (outcome.speak) {
                void queueRelaySpeech(state, () => speakRelayLine(state, outcome.speak))
              }
              console.log(
                `[converse] approval ${approvalId} answer: ${outcome.code}` +
                  (outcome.state ? ` state=${outcome.state}` : ''),
              )
            })
            .catch((error) => {
              console.warn(`[converse] approval answer: ${error?.message || error}`)
            })
        }
        /*
         * No automatic transcript capture here anymore. The generic
         * spoken-memory tier scraped every utterance into an event log that
         * fed the prompt; the owner's verdict was to delete it. A fact is
         * remembered when the model calls memory_save on purpose — the
         * deliberate verb — and read when a domain's tool is selected.
         */
      },
      onUserSpeech: () => {
        state.lastActivityAt = Date.now()
        // Barge-in applies to a briefing exactly as it does to a reply: the
        // owner talking is the owner saying "not now".
        const wasAnnouncing = state.announcing
        state.announcing = false
        // Barge-in: the model stops itself server-side; the device may still
        // hold ~a second of its speech in the jitter ring. Flush it so the
        // owner isn't talked over — but only if agent audio was in flight.
        if (wasAnnouncing || Date.now() - state.lastDownlinkAt < 5_000) {
          sendJson({ type: 'flush' })
        }
      },
      onEarlyPlan: dispatchPlan,
      waitForMacResult: async (jobId) => {
        const deadline = Date.now() + 9000
        while (Date.now() < deadline) {
          const current = await store.getJob(jobId).catch(() => null)
          const result = current?.result
          if (
            result &&
            (result.phase === 'executed' ||
              result.executed === true ||
              result.executionError ||
              current.status === 'completed')
          ) {
            return trimMacResultForModel(result)
          }
          await new Promise((resolve) => setTimeout(resolve, 300))
        }
        return null
      },
      /*
       * Voice parity, made structural. "Set a timer for ten minutes" and
       * turning the ring to 10 both land in cloud-relay/timerStore.js, are
       * both swept by the same interval below, and both chime through the
       * same speech path. The owner must not be able to tell which hand set
       * a timer, and the only way to guarantee that is for there to be one
       * store rather than two implementations that agree today.
       */
      timerControl: state.timerControl,
      lookupJobStatus: async ({ reference, jobId }) =>
        recallJobStatus({
          jobs: await store.listJobs({ type: 'plan', limit: RECALL_JOB_LIMIT }),
          reference,
          jobId,
          /* Everything this conversation itself queued. A duplex session can
           * run many turns, so all of them are excluded, not just the last. */
          excludeJobIds: state.jobs,
        }),
    })

    if (state.ended) {
      // stop/close raced the OpenAI handshake: tear the session down now
      // instead of leaving it (and an idle timer) orphaned.
      try {
        await state.session.end()
      } catch {
        /* already dead */
      }
      return
    }

    // Mic audio that arrived while the OpenAI handshake ran.
    for (const pcm of state.pendingPcm) state.session.appendRawPcm(pcm)
    state.pendingPcm.length = 0

    // The session settling — resolve (OpenAI closed cleanly) OR reject —
    // means no more replies are coming; end the conversation either way
    // rather than leaving the pendant streaming into a dead session.
    state.session.done.then(
      () => {
        if (!state.ended) void endConversation('agent-done')
      },
      (error) => {
        // The real reason the Realtime session died, kept for the run record
        // (jobs.js voiceRunForCapture) instead of the generic 'agent-error'
        // tag alone — a genuine STT/agent failure should say why, the same
        // way every other failure in this codebase does.
        if (!state.ended) {
          state.endError = String(
            error?.message || error || 'The realtime voice session failed.',
          )
          void endConversation('agent-error')
        }
      },
    )

    state.idleTimer = setInterval(() => {
      /*
       * Timers are swept BEFORE the idle check, and on the same interval
       * rather than a second one. Before, because a chime that comes due in
       * the same tick that retires the conversation must not lose that race —
       * the owner set it, it fired, they get told. On the same interval
       * because the store sweep and the idle sweep want the same cadence and
       * a worker with two timers is a worker with two things to leak.
       * Speaking a chime refreshes lastActivityAt through the send callback,
       * which is correct: the owner has just been handed something to react
       * to, and cutting them off mid-reaction would be the wrong reading of
       * "idle".
       */
      void sweepDueTimers(state)
      if (Date.now() - state.lastActivityAt > IDLE_END_MS) {
        void endConversation('idle')
      }
    }, IDLE_SWEEP_MS)

    sendJson({ type: 'started' })
    console.log(`[converse] conversation started device=${deviceId}`)

    /*
     * The conversation can now play audio, so it becomes findable: an
     * approval saved WHILE this socket is open (the owner asked by voice, the
     * plan parked on the Mac seconds later) gets spoken into this very
     * conversation instead of waiting mute for the next button press — which
     * is exactly the silence the owner complained about. The nudge lands on
     * the same serialised readback the on-connect sweep uses, so it can never
     * splice into other relay speech. Registered here, after the session and
     * encoder exist, and torn down in endConversation.
     */
    state.unregisterSession = registerConverseSession(deviceId, {
      speakApprovals: () => queueApprovalReadback(state),
    })

    /*
     * The pendant is now in a state where it will PLAY what arrives, so this
     * is the first moment anything the relay composed on its own can reach
     * the owner's ear. Not awaited: a queued briefing must never delay the
     * answer to the question that was just asked.
     *
     * Approvals first, then announcements, CHAINED — both feed the same
     * stateful Opus encoder, so running them concurrently would splice a
     * briefing into the middle of a readback. Order is a decision, not an
     * accident: an approval expires and commits something, a briefing merely
     * goes stale, and the readback ends with the confirm word the owner is
     * about to say — burying it under a briefing would ask them to answer a
     * question three paragraphs old.
     */
    void queueApprovalReadback(state)
      .then(() => {
        /*
         * Then any timer that fired while nobody was listening. The order is
         * the doc's: after the approval readback (which ends with the confirm
         * word the owner is about to say), before the briefings (which merely
         * went stale). A chime is the one queued sound with a deadline
         * attached — it already went off late, and burying it under a
         * three-paragraph briefing makes it later.
         */
        return sweepDueTimers(state)
      })
      .then(() => {
        if (!ANNOUNCE_ON_CONNECT || state.ended) return
        return playPendingAnnouncements(state).catch((error) => {
          console.warn(`[converse] announce: ${error?.message || error}`)
        })
      })
  }

  /* ------------------------------------------------------------ the apps */

  /**
   * One queue for every sound the relay makes on its own.
   *
   * Menu blips, spoken positions, app surfaces, timer chimes and approval
   * readbacks all encode through ONE stateful Opus encoder, so they must never
   * overlap. Errors are swallowed into a warning so the chain itself can never
   * go rejected and silently refuse everything queued after it.
   */
  function queueRelaySpeech(state, run) {
    if (state.ended) return state.relaySpeechRuns
    state.relaySpeechRuns = state.relaySpeechRuns.then(() => {
      if (state.ended) return
      return Promise.resolve()
        .then(run)
        .catch((error) => {
          console.warn(`[converse] relay speech: ${error?.message || error}`)
        })
    })
    return state.relaySpeechRuns
  }

  /**
   * Where the knob's detents actually go.
   *
   * The reducer (cloud-relay/menuRing.js) decides; this only performs. Note
   * what is and is not queued: the earcon is queued immediately so the blip
   * tracks the thumb, the NAME is debounced so a fast spin costs one sentence,
   * and a Mac-backed brief is NOT queued at all — it is fetched off-chain and
   * only its spoken result joins the queue, so the owner can keep scrolling
   * while Reminders is still coming back.
   *
   * The select frame is a YELLOW PRESS, so it arrives the instant the owner
   * decides rather than 1.5 s after they stop moving. Nothing here re-says the
   * position name the settle already spoke: this handler queues only what the
   * reducer returns, and the reducer returns no 'name' effect on a commit. One
   * chain keeps the order honest even if a fast spin backed the queue up.
   */
  function handleMenuFrame(state, frame) {
    const reduced = reduceMenuFrame(state.menu, frame)
    state.menu = reduced.state

    for (const effect of reduced.effects) {
      if (effect.kind === 'context') {
        /*
         * Sent BEFORE any sound, and never awaited. The owner's next press can
         * land during the earcon that announces this very transition, and a
         * device still holding the old meaning would fire the wrong verb —
         * a memo instead of a select, or worse, nothing at all.
         */
        sendJson(menuContextFrame(state.menu))
        console.log(`[converse] menu context -> ${effect.active ? 'ring' : 'global'}`)
        continue
      }
      if (effect.kind === 'earcon') {
        queueRelaySpeech(state, () => streamRelayPcm(state, renderEarconPcm(effect)))
        continue
      }
      if (effect.kind === 'name') {
        menuSettleFor(state).offer(effect)
        continue
      }
      if (effect.kind === 'number') {
        /*
         * A bare number, rendered LOCALLY. This is the whole reason numeric
         * entry is possible at all: TTS is a network round trip, and one per
         * settle would put the number a second behind the thumb.
         */
        menuSettleFor(state).offer(effect)
        continue
      }
      if (effect.kind === 'speak') {
        /* An announcement or a confirmation, caused by a PRESS. A press has
         * already proven the hand stopped, so this never waits on a settle. */
        queueRelaySpeech(state, () => speakRelayLine(state, effect.text))
        continue
      }
      if (effect.kind === 'closed') {
        /* A pending name from the detent that got you here would speak AFTER
         * the falling earcon, announcing a position in a ring you just left. */
        clearMenuName(state)
        continue
      }
      if (effect.kind === 'app') {
        void enterApp(state, effect.app)
        continue
      }
      if (effect.kind === 'timer') {
        queueRelaySpeech(state, () => startKnobTimer(state, effect.minutes))
        continue
      }
      if (effect.kind === 'alarm') {
        queueRelaySpeech(state, () => startKnobAlarm(state, effect.hour, effect.minute))
        continue
      }
      if (effect.kind === 'bt-list') {
        /* The remembered sinks, which make the ring usable the instant it
         * opens — they come from the device's own table and cost no radio. */
        state.audioAskedAt = Date.now()
        sendJson({ type: 'bt_list' })
        continue
      }
      if (effect.kind === 'bt-scan') {
        /* Discovery, which does cost radio time and arrives seconds later. It
         * is fired alongside bt_list rather than after it so the two overlap:
         * the owner is already scrolling remembered devices while this runs. */
        sendJson({ type: 'bt_scan', action: 'start' })
        continue
      }
      if (effect.kind === 'audio-select') {
        /*
         * Both frames, in this order. The first commands the module to
         * connect; audio_sink routes the next answer to Bluetooth. Sending
         * only the first would connect a headphone the pendant then talks past
         * — choosing where sound goes and connecting the thing it goes to are
         * one intention.
         *
         * REMEMBERED and NEW take different frames, because they are different
         * questions. A remembered sink is addressed by its INDEX in the
         * device's own table (bt_select, which also promotes it to
         * most-recent), and the relay must not pretend to know that table's
         * shape. A device the scan just found has no index at all — it exists
         * only as a name in a result the relay is holding — so it goes by name
         * and the device decides where it lands in its table.
         */
        if (effect.remembered) {
          sendJson({ type: 'bt_select', index: effect.index })
        } else {
          sendJson({ type: 'bt_connect', name: effect.name })
        }
        sendJson({ type: 'audio_sink', sink: 'bluetooth' })
        console.log(
          `[converse] audio sink -> ${effect.name}` +
            (effect.remembered ? ` (remembered, index ${effect.index})` : ' (newly discovered)'),
        )
        queueRelaySpeech(state, () => speakRelayLine(state, `Connecting ${effect.name}.`))
        continue
      }
      if (effect.kind === 'audio-sink') {
        sendJson({ type: 'audio_sink', sink: effect.sink })
        console.log(`[converse] audio sink -> ${effect.sink}`)
        queueRelaySpeech(state, () => speakRelayLine(state, 'Using the pendant speaker.'))
      }
    }
  }

  function clearMenuName(state) {
    state.menuSettle?.cancel()
  }

  /**
   * The settle, built on first use because it closes over this conversation.
   *
   * Both utterance kinds go through the SAME debouncer, which is the point: a
   * ring name and a bare number are the same event ("the hand stopped, say
   * where it is") and only differ in how they are rendered. Splitting them into
   * two timers would let a name and a number both fire from one burst.
   */
  function menuSettleFor(state) {
    if (!state.menuSettle) {
      state.menuSettle = createSettle({
        delayMs: MENU_NAME_SETTLE_MS,
        speak: (utterance) => {
          queueRelaySpeech(state, () =>
            utterance.kind === 'number'
              ? streamRelayPcm(state, renderNumberPcm(utterance.value))
              : speakRelayLine(state, utterance.text),
          )
        },
      })
    }
    return state.menuSettle
  }

  /**
   * Entering an app speaks its surface. There is no silent landing anywhere.
   *
   * Time answers from the relay's own clock — instant, and correct with the
   * Mac asleep. Reminders and Calendar go to the Mac on the same job path
   * voice tool-calls ride, and they say so out loud when it does not answer,
   * because on a screenless device silence is indistinguishable from
   * breakage.
   */
  async function enterApp(state, app) {
    if (app === 'time') {
      const speech = timeSpeech({
        now: Date.now(),
        timezone: state.timezone,
        deviceTime: state.deviceTime,
      })
      queueRelaySpeech(state, () => speakRelayLine(state, speech))
      return
    }

    /* Audio no longer reaches here: the reducer emits bt-list and bt-scan as
     * effects of its own, because the ring's ORDER (remembered first, then
     * discovered) is a decision about the ring and belongs beside it. */

    const plan = appMacPlan(app)
    if (!plan) return

    /*
     * Measured: the Reminders read takes ~16 s on the owner's Mac and the
     * Calendar read is slower still. Sixteen seconds of silence on a device
     * with no screen is indistinguishable from a dead knob, and the grammar's
     * rule is that nothing lands silently — so the app says where it is
     * looking, and the brief lands when the Mac answers.
     */
    queueRelaySpeech(state, () => speakRelayLine(state, appFetchingSpeech(app)))

    let speech
    try {
      const job = await enqueueMacPlanJob({
        store: state.store,
        deviceId: state.deviceId,
        sessionId: null,
        plan,
        rawAudioBytes: 0,
        format: 'opus-frames',
        sampleRate: OPUS_WIRE_SAMPLE_RATE,
        channels: 1,
        bitsPerSample: 16,
        transcriptionDurationMs: 0,
        /* Not a spoken question at all — a ring entry the owner stopped on. */
        pendantMode: 'knob',
      })
      if (job?.jobId) {
        state.jobCount += 1
        state.jobs.push(job.jobId)
      }
      speech = appBriefSpeech(app, await pollMacResult(state.store, job?.jobId, APP_BRIEF_WAIT_MS))
    } catch (error) {
      console.warn(`[converse] ${app} brief: ${error?.message || error}`)
      speech = macUnansweredSpeech(app)
    }
    queueRelaySpeech(state, () => speakRelayLine(state, speech))
  }

  async function startKnobTimer(state, minutes) {
    const record = await startTimer({
      store: state.store,
      deviceId: state.deviceId,
      minutes,
      setBy: 'knob',
    })
    console.log(`[converse] timer ${record.timerId} started by knob: ${record.durationMs}ms`)
    /*
     * timerSetSpeech, not timerStartedSpeech. Coming off a numeric field the
     * owner has heard nothing but bare numbers — "seven.", "eight." — with no
     * unit attached, so this confirmation is the first and only place the unit
     * is said: "Timer set for 7 minutes." A preset commit lands here too, and
     * gets the same sentence, because two phrasings for one outcome is how an
     * owner starts wondering whether they did something different.
     */
    await speakRelayLine(state, timerSetSpeech(record))
  }

  /**
   * An alarm, which is a timer whose duration came off a clock face.
   *
   * The offset is the pendant's own LTE network clock when it has one — the
   * same source the Time app trusts, and for the same reason: a worn device
   * must set 7 AM in the timezone the owner is STANDING in, not the one their
   * Mac is sleeping in. With no device clock the Mac's offset is the fallback
   * and UTC is the fallback's fallback, which is stated out loud rather than
   * silently assumed, because an alarm in the wrong timezone is the single
   * worst failure this app has.
   */
  async function startKnobAlarm(state, hour, minute) {
    const offsetMinutes = Number.isFinite(state.deviceTime?.offsetMinutes)
      ? state.deviceTime.offsetMinutes
      : macOffsetMinutes(state.timezone)
    const record = await startAlarm({
      store: state.store,
      deviceId: state.deviceId,
      hour,
      minute,
      alarmAt: clockLabel(hour, minute),
      offsetMinutes,
      setBy: 'knob',
    })
    console.log(
      `[converse] alarm ${record.timerId} set by knob for ${record.alarmAt} ` +
        `(offset ${offsetMinutes}m, fires in ${record.durationMs}ms)`,
    )
    await speakRelayLine(state, timerSetSpeech(record))
  }

  /** The Mac's timezone as a UTC offset in minutes, or 0 if it cannot be read.
   * Derived by formatting "now" in that zone rather than by a table, so a zone
   * this relay has never heard of still works if the platform knows it. */
  function macOffsetMinutes(timezone) {
    const zone = String(timezone || '').trim()
    if (!zone) return 0
    try {
      const now = new Date()
      const local = new Date(now.toLocaleString('en-US', { timeZone: zone }))
      const utc = new Date(now.toLocaleString('en-US', { timeZone: 'UTC' }))
      return Math.round((local.getTime() - utc.getTime()) / 60_000)
    } catch {
      return 0
    }
  }

  /**
   * Chime whatever came due.
   *
   * Claimed before it is spoken and settled after, so a reconnect racing a
   * stale socket cannot chime the same timer twice, and a chime that died
   * mid-stream goes back on the queue rather than being silently eaten — the
   * timer is still overdue, so the next press picks it up.
   */
  async function sweepDueTimers(state) {
    if (state.ended || !state.store) return
    let due = []
    try {
      due = await claimDueTimers({ store: state.store, deviceId: state.deviceId })
    } catch (error) {
      console.warn(`[converse] timer sweep: ${error?.message || error}`)
      return
    }
    if (!due.length) return

    for (const record of due) {
      /* Queued on the one chain, and AWAITED here, so two due timers chime one
       * after the other instead of on top of each other. */
      await queueRelaySpeech(state, async () => {
        const chimed = await streamRelayPcm(state, renderTimerChimePcm())
        /* One sentence for both callers. timerOverdueSpeech reads the clock
         * itself and only adds "that was N ago" when the chime is genuinely
         * late, so a live sweep and a next-press sweep need no flag to tell
         * them apart — the lateness IS the difference. */
        const spoke = await speakRelayLine(state, timerOverdueSpeech(record))
        await settleClaimedTimer({
          store: state.store,
          timerId: record.timerId,
          spoke: Boolean(chimed || spoke),
        })
      })
    }
  }

  /**
   * Poll a Mac job for its executed result, raw.
   *
   * Deliberately NOT trimMacResultForModel: that trims entries to 400 chars
   * for a language model's context budget, and an app brief parses the
   * AppleScript's actual stdout. Same polling contract as the model's status
   * window otherwise, so there is one idea of "the Mac has answered".
   */
  async function pollMacResult(store, jobId, timeoutMs) {
    if (!store || !jobId) return null
    const deadline = Date.now() + timeoutMs
    while (Date.now() < deadline) {
      const current = await store.getJob(jobId).catch(() => null)
      const result = current?.result
      if (
        result &&
        (result.phase === 'executed' ||
          result.executed === true ||
          result.executionError ||
          current.status === 'completed')
      ) {
        return result
      }
      await new Promise((resolve) => setTimeout(resolve, 300))
    }
    return null
  }

  /**
   * One approval readback at a time, always reading the store fresh.
   *
   * Every caller — the on-connect sweep above, a mid-conversation nudge from
   * converseSessions.js — goes through here, so the invariant that relay
   * speech never interleaves lives in one place. A nudge that arrives while a
   * readback is queued is absorbed rather than stacked: the queued run will
   * read the store after the triggering save (saveApproval completed before
   * routeApprovalPrompt ran), so it speaks the new record too. Errors are
   * swallowed into a warning here so the chain itself can never go rejected
   * and silently refuse every later readback.
   */
  function queueApprovalReadback(state) {
    if (state.ended || state.approvalRunQueued) return state.relaySpeechRuns
    state.approvalRunQueued = true
    /* Onto the SAME chain the menu and the timers use — see relaySpeechRuns.
     * A readback and a menu blip on separate chains would both be correct in
     * isolation and garbage together. */
    return queueRelaySpeech(state, () => {
      state.approvalRunQueued = false
      return speakQueuedApprovals(state).catch((error) => {
        console.warn(`[converse] approvals: ${error?.message || error}`)
      })
    })
  }

  /**
   * Read out the next approval parked for THIS pendant, and remember which
   * one, so the owner's next words can answer it.
   *
   * Everything doing the work here already existed: speakNextApproval picks
   * the oldest live record and attests exactly what the stream witnessed
   * (bytes on a socket, never a hearing), and the origin filter keeps prompts
   * that belong to other surfaces — a phone's card, the HUD's list — off a
   * speaker nobody asked. What was missing was only this call.
   */
  async function speakQueuedApprovals(state) {
    if (state.ended || !state.replyEncoder || !state.store) return

    const spoken = await speakNextApproval({
      store: state.store,
      deviceId: state.deviceId,
      eligible: isPendantRoutedApproval,
      speak: async ({ speech }) => {
        /*
         * The device's strong haptic, fired before the words.
         *
         * This became load-bearing on 2026-08-12: blue is push-to-talk now, so
         * the pendant no longer has an approve button, and this hit is the ONLY
         * device-side cue that the thing about to be read out is a decision
         * rather than an answer. It is sent unconditionally and not awaited —
         * the firmware parses it from the idle loop, and a missed buzz must
         * cost the nudge, never the readback.
         */
        sendJson({ type: 'approval_readback' })
        const pcm = await renderAnnouncementPcm({
          speech,
          synthesize: synthesizeSpeech,
        })
        if (state.ended || !pcm.length) {
          /* Zero bytes reported keeps the record undelivered and deliverable
           * — speakNextApproval fails closed on exactly this shape. */
          return { sentBytes: 0, totalBytes: pcm.length, stopped: true }
        }
        state.announcing = true
        const delivery = await streamAnnouncementPcm({
          pcm,
          sampleRate: REALTIME_PCM_RATE,
          encode: (chunk) => state.replyEncoder.push(chunk),
          split: (wire) => splitWireFrames(wire),
          send: (frame) => {
            state.lastActivityAt = Date.now()
            state.lastDownlinkAt = Date.now()
            try {
              server.send(frame)
            } catch {
              state.announcing = false
            }
          },
          sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
          shouldStop: () => state.ended || !state.announcing,
        })
        state.announcing = false
        return {
          sentBytes: delivery.sentBytes,
          totalBytes: pcm.length,
          stopped: delivery.stopped,
          path: 'converse-approval',
        }
      },
    })

    if (spoken.spoke && spoken.approval) {
      state.pendingApprovalAnswer = spoken.approval.approvalId
      console.log(
        `[converse] approval ${spoken.approval.approvalId} read back` +
          ` (${spoken.waiting} waiting, evidence=${spoken.evidence?.kind ?? 'none'})`,
      )
    } else if (spoken.reason && spoken.reason !== 'nothing-waiting') {
      console.warn(`[converse] approval readback: ${spoken.reason} ${spoken.why ?? ''}`)
    }
  }

  /**
   * Put a buffer of ready PCM down the socket, paced.
   *
   * The ONE place relay-composed audio reaches the wire. Everything the relay
   * says on its own — an approval line, a menu blip, an app's answer, a timer
   * chime — comes through here, so the barge-in rule ("the owner talking is
   * the owner saying not now"), the activity stamps and the flow control are
   * written once. Returns whether anything actually went out, because a timer
   * chime has to know: bytes on a socket is not a hearing, but zero bytes is
   * definitely not a delivery, and the record says so either way.
   */
  async function streamRelayPcm(state, pcm) {
    if (state.ended || !state.replyEncoder || !pcm?.length) return false
    state.announcing = true
    const delivery = await streamAnnouncementPcm({
      pcm,
      sampleRate: REALTIME_PCM_RATE,
      encode: (chunk) => state.replyEncoder.push(chunk),
      split: (wire) => splitWireFrames(wire),
      send: (frame) => {
        state.lastActivityAt = Date.now()
        state.lastDownlinkAt = Date.now()
        try {
          server.send(frame)
        } catch {
          state.announcing = false
        }
      },
      sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
      shouldStop: () => state.ended || !state.announcing,
    })
    state.announcing = false
    return delivery.sentBytes > 0
  }

  /** One short spoken line — "Approved.", "Timer.", "No open reminders." — on
   * the same paced path as everything else this relay says on its own. */
  async function speakRelayLine(state, text) {
    if (state.ended || !state.replyEncoder || !text) return false
    try {
      const pcm = await renderAnnouncementPcm({ speech: text, synthesize: synthesizeSpeech })
      if (state.ended || !pcm.length) return false
      return await streamRelayPcm(state, pcm)
    } catch (error) {
      console.warn(`[converse] spoken line: ${error?.message || error}`)
      return false
    }
  }

  /**
   * Speak whatever the relay queued for this device while nobody was asking.
   *
   * This is the honest answer to "how does a 7am briefing reach the pendant?"
   * on today's firmware. The device holds one WebSocket open around the clock,
   * but main.c's idle branch drains and DISCARDS every frame that arrives
   * while no conversation is active, and binary frames are dropped unless
   * `convo_started` is set. So the relay cannot wake the pendant — but the
   * moment a press opens a conversation, the relay speaks first, before the
   * owner has asked for anything. Unprompted in substance; the press is the
   * doorbell, not the request.
   *
   * The remaining gap, precisely: a truly unprompted 7am announcement needs
   * (1) firmware that recognises {"type":"announce"} on the idle socket and
   * arms the I2S playback path without a button press, and (2) the socket to
   * be owned by a Durable Object, because a Cron Trigger runs in a different
   * isolate and cannot reach a WebSocket held in a fetch handler's closure.
   */
  async function playPendingAnnouncements(state) {
    /*
     * Unfiltered on purpose: selectDeliverable also picks up announcements
     * left 'delivering' by a socket that died mid-briefing, which a
     * state:'pending' query would hide forever.
     */
    const queued = await state.store
      .listAnnouncements({ deviceId: state.deviceId, limit: 20 })
      .catch(() => [])
    const due = selectDeliverable(queued, { limit: 2 })
    if (!due.length) return

    for (const announcement of due) {
      if (state.ended || !state.replyEncoder) return
      /*
       * Claim before speaking. Two sockets (a reconnect racing a stale one)
       * would otherwise both play the same briefing.
       */
      const claimed = await state.store
        .updateAnnouncement(announcement.announcementId, {
          state: 'delivering',
          deliveringSince: new Date().toISOString(),
          attempts: Number(announcement.attempts || 0) + 1,
        })
        .catch(() => null)
      if (!claimed) continue

      let pcm
      try {
        pcm = await renderAnnouncementPcm({
          speech: announcement.speech,
          /* OpenAI's `pcm` response format is 24 kHz mono s16le — already the
           * pendant's reply format, so nothing is resampled on the way out. */
          synthesize: synthesizeSpeech,
        })
      } catch (error) {
        /* Put it back: a TTS outage must not silently eat a briefing. */
        await state.store
          .updateAnnouncement(announcement.announcementId, { state: 'pending' })
          .catch(() => {})
        throw error
      }

      if (state.ended || !pcm.length) {
        await state.store
          .updateAnnouncement(announcement.announcementId, { state: 'pending' })
          .catch(() => {})
        continue
      }

      state.announcing = true

      const delivery = await streamAnnouncementPcm({
        pcm,
        sampleRate: REALTIME_PCM_RATE,
        encode: (chunk) => state.replyEncoder.push(chunk),
        split: (wire) => splitWireFrames(wire),
        send: (frame) => {
          state.lastActivityAt = Date.now()
          state.lastDownlinkAt = Date.now()
          try {
            server.send(frame)
          } catch {
            state.announcing = false
          }
        },
        sleep: (ms) => new Promise((resolve) => setTimeout(resolve, ms)),
        shouldStop: () => state.ended || !state.announcing,
      })

      state.announcing = false

      /*
       * Bytes on a socket is the whole of what happened here, and the record now
       * says so. `state: 'delivered'` remains the QUEUE's way of saying "do not
       * offer this one again"; whether anyone heard it lives in `heard`, which
       * is 'unknown' because the pendant reports nothing back. Nothing sent at
       * all goes back on the queue for the next press — and, unlike before, it
       * no longer carries a `deliveredAt` while it does.
       */
      const outcome = announcementDeliveryOutcome(delivery)
      await state.store
        .updateAnnouncement(announcement.announcementId, outcome)
        .catch(() => {})
      console.log(
        `[converse] announcement ${announcement.announcementId} ` +
          `sent=${delivery.sentBytes}B frames=${delivery.sentFrames}` +
          `${delivery.stopped ? ' (interrupted)' : ''} heard=${outcome.heard}`,
      )
      if (delivery.stopped) return
    }
  }

  async function endConversation(reason) {
    const state = convo
    if (!state || state.ended) return
    state.ended = true
    convo = null
    clearInterval(state.idleTimer)
    /* A debounced position name outliving its conversation would speak into
     * the next one, announcing a ring the owner is no longer standing in. */
    state.menuSettle?.cancel()
    /*
     * Hand the buttons back. The conversation ending closes the ring, so the
     * device must be told its buttons mean talk and memo again — otherwise the
     * owner's next yellow press is a select against a ring that no longer
     * exists, and they get silence from the one control that is supposed to
     * always work. Sent unconditionally rather than only when the ring
     * happened to be open: the cost is one small frame, and the cost of
     * skipping it is a pendant that appears dead.
     */
    if (menuIsOpen(state.menu)) {
      console.log('[converse] menu context -> global (conversation ended)')
    }
    try {
      sendJson({ type: 'menu_context', active: false })
    } catch {
      /* The socket is usually already gone by here; that is fine. A device
       * whose socket closed has no ring either, and the firmware's own rule is
       * to fall back to the global verbs when it has no context. */
    }
    /* No longer nudgeable: from here the store-and-next-press path is the
     * only delivery again, which is correct — the firmware cannot be woken.
     * The unregister is identity-checked, so a restart that already
     * registered the successor session is not clobbered by this teardown. */
    try {
      state.unregisterSession?.()
    } catch {
      /* registry teardown must never block the conversation teardown */
    }

    let plan = null
    try {
      if (state.session) plan = await state.session.end()
    } catch (error) {
      console.warn(`[converse] session end: ${error?.message || error}`)
    }
    try {
      const tail = state.replyEncoder ? state.replyEncoder.end() : Buffer.alloc(0)
      if (tail.length) {
        for (const frame of splitWireFrames(tail)) server.send(frame)
      }
    } catch {
      /* encoder already destroyed or socket gone */
    }
    sendJson({ type: 'end', reason })
    console.log(
      `[converse] conversation ended reason=${reason} turns=${state.turns.length} jobs=${state.jobCount} userPcm=${state.userPcmBytes} replyPcm=${state.replyPcmBytes}`,
    )

    const work = storeConversationCapture(state, plan, reason).catch((error) => {
      console.warn(
        `[converse] capture not stored: ${error?.message || error}`,
      )
    })
    try {
      context?.waitUntil?.(work)
    } catch {
      /* outside a request context — the promise still runs */
    }
    await work
  }

  async function storeConversationCapture(state, plan, endReason) {
    if (state.userPcmBytes === 0 || !state.store) return
    console.log(
      `[converse] storing capture: user=${state.userPcmBytes}B reply=${state.replyPcmBytes}B turns=${state.turns.length}`,
    )
    const store = state.store
    /*
     * ASR text only. `plan.text` used to be the fallback here, but that field
     * is a history LABEL whose last resort is the literal string
     * 'voice command' — so every conversation the model never answered was
     * filed with a transcript the owner never spoke, and looked healthy.
     * No words recognised now means no transcript.
     */
    const transcript =
      state.turns.map((t) => t.transcript).filter(Boolean).join('\n') ||
      plan?.transcript ||
      undefined
    const replyTranscript =
      state.turns.map((t) => t.response).filter(Boolean).join('\n') ||
      String(plan?.response || '').trim() ||
      null

    const userWav = pcmS16leToWavBuffer(Buffer.concat(state.userPcm), {
      sampleRate: OPUS_WIRE_SAMPLE_RATE,
      channels: 1,
      bitsPerSample: 16,
    })
    let capture = createAudioCapture({
      audioBase64: userWav.toString('base64'),
      audioBytes: userWav.length,
      format: 'wav',
      language: null,
      transcript,
      transcriptionModel: 'gpt-realtime-2.1',
      status: 'completed',
    })
    const persisted = await persistAudioCapture({
      captureId: capture.jobId,
      audioBase64: capture.audioBase64,
      audioBytes: userWav.length,
      format: 'wav',
      createdAt: capture.createdAt,
      allowD1Fallback: userWav.length <= 1024 * 1024,
    })
    if (persisted.audioStorage === 'unavailable') return
    capture = {
      ...capture,
      ...persisted,
      /*
       * The one moment this fact is knowable: WHY the conversation ended.
       * jobs.js voiceRunForCapture reads this — not the transcript, not a
       * rendered label — to tell "nobody spoke" apart from "speech-to-text
       * broke" when it later decides whether this press is a failure.
       * `endError`, when this ending came from a real fault (see the
       * assignments above), rides along so the failure the owner sees names
       * what actually went wrong instead of a generic "no reply".
       */
      endReason,
      ...(state.endError ? { endError: state.endError } : {}),
    }
    await store.createJob(capture)

    if (state.replyPcmBytes > 0) {
      const replyWav = pcmS16leToWavBuffer(Buffer.concat(state.replyPcm), {
        sampleRate: REALTIME_PCM_RATE,
        channels: 1,
        bitsPerSample: 16,
      })
      let replyCapture = createAudioCapture({
        audioBase64: replyWav.toString('base64'),
        audioBytes: replyWav.length,
        format: 'wav',
        language: null,
        transcript: replyTranscript,
        transcriptionModel: 'gpt-realtime-2.1',
        status: 'completed',
      })
      replyCapture = { ...replyCapture, role: 'reply' }
      const persistedReply = await persistAudioCapture({
        captureId: replyCapture.jobId,
        audioBase64: replyCapture.audioBase64,
        audioBytes: replyWav.length,
        format: 'wav',
        createdAt: replyCapture.createdAt,
        allowD1Fallback: replyWav.length <= 1024 * 1024,
      })
      if (persistedReply.audioStorage !== 'unavailable') {
        replyCapture = { ...replyCapture, ...persistedReply }
        await store.createJob(replyCapture)
        await store.updateJob(capture.jobId, {
          replyCaptureId: replyCapture.jobId,
          replyTranscript,
        })
      } else if (replyTranscript) {
        await store.updateJob(capture.jobId, { replyTranscript })
      }
    } else if (replyTranscript) {
      await store.updateJob(capture.jobId, { replyTranscript })
    }

    console.log(`[converse] capture stored: ${capture.jobId}`)

    // Tie the capture and the Mac jobs it spawned together, mirroring the
    // HTTP path — without this, history shows the same exchange as two
    // unrelated, half-labeled runs (review finding).
    if (state.jobs.length > 0) {
      await store.updateJob(capture.jobId, { planJobId: state.jobs[0] })
      for (const jobId of state.jobs) {
        const job = await store.getJob(jobId).catch(() => null)
        if (!job) continue
        await store
          .updateJob(jobId, {
            inputTelemetry: {
              ...(job.inputTelemetry || {}),
              captureId: capture.jobId,
            },
          })
          .catch(() => {})
      }
    }
  }

  server.addEventListener('message', (event) => {
    const data = event.data
    if (typeof data === 'string') {
      let msg = null
      try {
        msg = JSON.parse(data)
      } catch {
        return
      }
      if (msg?.type === 'ping') {
        sendJson({ type: 'pong' })
        return
      }
      if (msg?.type === 'start') {
        void startConversation(msg).catch((error) => {
          console.warn(`[converse] start failed: ${error?.message || error}`)
          sendJson({ type: 'end', reason: 'error' })
        })
        return
      }
      if (msg?.type === 'stop') {
        void endConversation('stopped')
        return
      }
      /*
       * Hardware-control frames (firmware/CONTROLS_WIRING.md). These arrive
       * on the idle socket as readily as mid-conversation — the firmware's
       * WS I/O thread sends them whenever the socket is open — so none of
       * them may assume `convo` exists.
       */
      if (msg?.type === 'approval_decision') {
        // Blue button: press = approve, ≥1.5 s hold = deny. If this
        // conversation just read an approval back, the thumb answers THAT
        // record; otherwise the oldest live pendant-routed one.
        const decision = String(msg.decision ?? '').trim().toLowerCase()
        const state = convo
        void (async () => {
          const store = state?.store ?? (await getStore())
          const result = await decideNextPendingApproval({
            store,
            deviceId: state?.deviceId ?? deviceIdHeader,
            approvalId: state?.pendingApprovalAnswer ?? null,
            decision,
            decidedBy: 'pendant-button',
          })
          if (
            state?.pendingApprovalAnswer &&
            ['settled', 'already_settled', 'expired'].includes(result.code)
          ) {
            state.pendingApprovalAnswer = null
          }
          console.log(
            `[converse] button approval ${decision}: ${result.code}` +
              (result.approvalId ? ` id=${result.approvalId}` : '') +
              (result.state ? ` state=${result.state}` : ''),
          )
          // Close the loop in the owner's ear when a conversation is live —
          // a silent grant from a button feels identical to a dead button.
          if (state && !state.ended && result.ok) {
            await queueRelaySpeech(state, () =>
              speakRelayLine(
                state,
                decision === 'approve' ? 'Approved.' : 'Cancelled. Nothing will run.',
              ),
            )
          }
        })().catch((error) => {
          console.warn(`[converse] approval button: ${error?.message || error}`)
        })
        return
      }
      if (
        msg?.type === 'menu' ||
        msg?.type === 'menu_select' ||
        msg?.type === 'menu_back'
      ) {
        /*
         * Rotary encoder navigation. The log line stays and stays FIRST: it is
         * what hardware bring-up reads to prove the knob's detents arrive with
         * the right sign and count, and that is still true now that the frames
         * also drive something.
         */
        const delta = Number(msg.delta)
        const state = convo
        console.log(
          `[converse] menu control from ${deviceIdHeader}: ` +
            (msg.type === 'menu' && Number.isFinite(delta)
              ? `step ${delta > 0 ? '+1' : '-1'}`
              : msg.type === 'menu_back'
                ? 'back (blue)'
                : 'select (yellow)') +
            (state && !state.ended ? ` mode=${state.menu.mode}` : ' (no conversation)'),
        )
        /*
         * Detents on an idle socket are logged and IGNORED, deliberately.
         * Today's firmware plays no audio outside a started conversation, so a
         * menu opened here would be a menu the owner cannot hear — and the
         * frames are dropped by the firmware when the socket is closed, so a
         * knob twist banked across a dead link can never replay as stale
         * intent either. The yellow press is the one press; it opens the
         * conversation, and the knob works from there.
         *
         * A menu_select or menu_back arriving with no conversation is the same
         * story from the other end: with the ring closed the device should be
         * sending its buttons to their GLOBAL jobs (talk, memo) and not to
         * this handler at all, so one landing here means the device is holding
         * a stale context. Ignoring it is right — endConversation has already
         * sent {"active":false}, and acting on it would commit against a ring
         * that no longer exists.
         */
        if (!state || state.ended) return
        handleMenuFrame(state, msg)
        return
      }
      if (msg?.type === 'bt_devices') {
        /*
         * The pendant's answer to bt_list: its remembered Bluetooth sinks, in
         * ITS most-recently-used order. The relay does not re-sort them — the
         * device knows when it last connected to each and the relay does not —
         * and it does not author them either. It only decides where they sit
         * relative to whatever the scan turns up, which is: first.
         */
        const state = convo
        const devices = Array.isArray(msg.devices) ? msg.devices : []
        console.log(
          `[converse] ${deviceIdHeader} remembers ${devices.length} audio device(s)` +
            `${msg.connected ? ' (connected)' : ''}`,
        )
        if (!state || state.ended || !state.audioAskedAt) return
        state.audioAskedAt = 0
        state.menu = { ...menuWithAudioDevices(state.menu, devices), mode: 'audio' }
        const ring = currentRing(state.menu)
        void queueRelaySpeech(state, async () => {
          await streamRelayPcm(
            state,
            renderEarconPcm({ ring: 'audio', index: 0, size: ring.entries.length, motion: 'enter' }),
          )
          /*
           * The empty case is no longer a dead end, because a scan is running
           * behind it. It says what is true right now and leaves the ring open
           * so results can land in it — the old copy ("Pair one from your
           * phone first") sent the owner to another device to solve a problem
           * this one was already working on.
           *
           * No gesture is named here: entering the app already spoke the
           * how-to, and this is a status line, not a lesson.
           */
          await speakRelayLine(
            state,
            devices.length
              ? `${devices.length} remembered. ${String(devices[0]?.name || 'The first one')}.`
              : 'Nothing remembered yet. Still searching.',
          )
        })
        return
      }
      if (msg?.type === 'bt_scan_result') {
        /*
         * Devices the radio just found, folded in BEHIND the remembered ones.
         *
         * Two rules make this safe to do while the owner is already scrolling:
         * the discovered half is appended after the remembered half (so the
         * entries they are aiming at never move), and menuWithAudioDevices
         * re-finds the entry the cursor is standing ON rather than keeping a
         * numeric index (so even the entries after the insertion point stay
         * under the thumb). Without the second rule, every speaker that
         * answered would slide "Pendant speaker" one step further away.
         */
        const state = convo
        const found = Array.isArray(msg.devices) ? msg.devices : []
        const scanning = msg.done !== true
        console.log(
          `[converse] ${deviceIdHeader} scan: ${found.length} nearby` +
            `${scanning ? ' (still scanning)' : ' (complete)'}`,
        )
        if (!state || state.ended || state.menu.mode !== 'audio') return
        state.menu = menuWithAudioDevices(state.menu, undefined, {
          discovered: found,
          scanning,
        })
        /*
         * Deliberately SILENT. The owner is mid-scroll; announcing every
         * speaker that answers would talk over the ring they are listening to.
         * The honest signal is positional instead — the "Still searching."
         * entry sits at the end of the list while this is true, so an owner who
         * scrolls to the bottom is told, and an owner who does not is left
         * alone.
         */
        return
      }
      if (msg?.type === 'mic_muted') {
        /*
         * The owner pressed talk with the red switch holding mic power off.
         * No conversation follows (the firmware refuses to record a dead
         * mic), and today's firmware only plays audio inside a started
         * conversation — so a spoken "your mic is muted" cannot reach the
         * owner yet. The device's LED pattern carries the message locally;
         * this log preserves the fact for the dashboard/ops trail.
         */
        console.log(
          `[converse] ${deviceIdHeader} pressed talk while hard-muted (mic power cut)`,
        )
        return
      }
      return
    }
    // Binary: uplink mic audio. Ignored when no conversation is live (the
    // device may still be draining its FIFO right after a stop).
    const state = convo
    if (!state || state.ended) return
    const buf = Buffer.from(data)
    if (!state.uploadDecoder) {
      // Decoder still being created: keep raw wire bytes in order. The
      // stream is NOT packet-aligned across frames, so dropping any of
      // these would desync every later length prefix.
      if (state.pendingWire && state.pendingWire.length < 128) {
        state.pendingWire.push(buf)
      }
      return
    }
    let pcm
    try {
      pcm = state.uploadDecoder.push(buf)
    } catch (error) {
      console.warn(`[converse] uplink decode: ${error?.message || error}`)
      state.endError = `The uplink recording could not be decoded: ${
        error?.message || error
      }`
      void endConversation('bad-audio')
      return
    }
    if (!pcm.length) return
    state.lastActivityAt = Date.now()
    if (state.userPcmBytes < CAPTURE_MAX_BYTES) {
      state.userPcm.push(pcm)
      state.userPcmBytes += pcm.length
    }
    if (state.session) {
      state.session.appendRawPcm(pcm)
    } else {
      state.pendingPcm.push(pcm)
    }
  })

  server.addEventListener('close', () => {
    void endConversation('socket-closed')
  })
  server.addEventListener('error', (event) => {
    // A transport error mid-conversation can truncate whatever audio was
    // mid-flight — the "network error" / "truncated upload" case a genuine
    // failure has to stay visible for, not the ordinary hangup 'socket-
    // closed' already covers.
    if (convo) {
      convo.endError =
        String(event?.message || '') ||
        'The connection to the pendant broke while the conversation was live.'
    }
    void endConversation('socket-error')
  })

  return new Response(null, { status: 101, webSocket: client })
}

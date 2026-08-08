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
import { loadFleetFromStore } from './fleetContext.js'
import { createSpokenMemoryWriter } from '../shared/spokenMemory.js'
import { persistAudioCapture } from './audioStorage.js'
import { pcmS16leToWavBuffer } from './rawAudio.js'
import {
  ANNOUNCE_ON_CONNECT,
  ANNOUNCE_PUSH_CONTROL_FRAMES,
  RELAY_API_KEY,
} from './config.js'
import {
  announceDoneFrame,
  announcementDeliveryOutcome,
  announceOpenFrame,
  renderAnnouncementPcm,
  selectDeliverable,
  streamAnnouncementPcm,
} from './announce.js'
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

export async function handlePendantConverse(request, context) {
  const auth = String(request.headers.get('Authorization') || '')
  if (!RELAY_API_KEY || auth !== `Bearer ${RELAY_API_KEY}`) {
    return new Response('Unauthorized', { status: 401 })
  }

  const pair = new WebSocketPair()
  const [client, server] = Object.values(pair)
  server.accept()
  if ('binaryType' in server) server.binaryType = 'arraybuffer'

  const deviceIdHeader =
    String(request.headers.get('X-Device-Id') || '').trim() ||
    'nrf9160-pendant'

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
      })
      if (job?.jobId) state.jobs.push(job.jobId)
      return job
    }

    /*
     * The write end of cross-surface memory, and until now there was none: the
     * relay has been folding an empty log into every prompt while the only
     * body that could write memory was the Mac, for utterances that reached
     * the Mac. Scoped to one conversation so its byte budget cannot be spent
     * by yesterday, and fire-and-forget below because a fact is worth less
     * than the audio path it would otherwise be able to stall.
     */
    const spokenMemory = createSpokenMemoryWriter({ store })

    state.session = await createStreamingRealtimeSession({
      inputSampleRate: OPUS_WIRE_SAMPLE_RATE,
      fleet: loadFleetFromStore(store).catch(() => null),
      audioOut: true,
      conversation: true,
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
         * Only the owner's own words. The model's reply is the model agreeing
         * with itself, and a log that remembers what it said last turn is how
         * a memory system talks itself into a fact nobody stated.
         */
        if (turn.transcript) {
          spokenMemory.remember(turn.transcript).then(
            (result) => {
              // Counts and keys only. A skipped-for-sensitivity result carries
              // the subject and never the value, and this is where that matters.
              if (result.appended) {
                console.log(
                  `[converse] memory: +${result.appended} event(s), ${result.bytes} B`,
                )
              } else if (result.error) {
                console.warn(`[converse] memory write failed: ${result.error}`)
              }
            },
            (error) => console.warn(`[converse] memory write: ${error?.message}`),
          )
        }
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
      () => {
        if (!state.ended) void endConversation('agent-error')
      },
    )

    state.idleTimer = setInterval(() => {
      if (Date.now() - state.lastActivityAt > IDLE_END_MS) {
        void endConversation('idle')
      }
    }, IDLE_SWEEP_MS)

    sendJson({ type: 'started' })
    console.log(`[converse] conversation started device=${deviceId}`)

    /*
     * The pendant is now in a state where it will PLAY what arrives, so this
     * is the first moment anything the relay composed on its own can reach
     * the owner's ear. Not awaited: a queued briefing must never delay the
     * answer to the question that was just asked.
     */
    if (ANNOUNCE_ON_CONNECT) {
      void playPendingAnnouncements(state).catch((error) => {
        console.warn(`[converse] announce: ${error?.message || error}`)
      })
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
      if (ANNOUNCE_PUSH_CONTROL_FRAMES) {
        sendJson(
          JSON.parse(
            announceOpenFrame({
              id: announcement.announcementId,
              seconds: pcm.length / 2 / REALTIME_PCM_RATE,
            }),
          ),
        )
      }

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

      if (ANNOUNCE_PUSH_CONTROL_FRAMES) {
        sendJson(JSON.parse(announceDoneFrame({ id: announcement.announcementId })))
      }
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

    const work = storeConversationCapture(state, plan).catch((error) => {
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

  async function storeConversationCapture(state, plan) {
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
    capture = { ...capture, ...persisted }
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
  server.addEventListener('error', () => {
    void endConversation('socket-error')
  })

  return new Response(null, { status: 101, webSocket: client })
}

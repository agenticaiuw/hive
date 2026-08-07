import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import {
  AUDIO_RETENTION_MAX_AGE_MS,
  AUDIO_RETENTION_SWEEP_ENABLED,
  BRIDGE_CLAIM_MAX_INTERVAL_MS,
  BRIDGE_CLAIM_MIN_INTERVAL_MS,
  BRIDGE_POLL_TIMEOUT_MS,
  JOB_TTL_MS,
  LLM_API_KEY,
  PAIRING_CODE,
  PENDANT_ACCOUNT_ID,
  PORT,
  RELAY_API_KEY,
  TTS_MODEL,
  TTS_VOICE,
} from './config.js'
import {
  voiceRunForCapture,
  createAudioCapture,
  createAgentProxyJob,
  createExecuteJob,
  createPlanJob,
  publicJob,
  voiceRunForJob,
} from './jobs.js'
import { getStore } from './store/index.js'
import { planFromAudio } from './audioPlan.js'
import {
  createStreamingRealtimeSession,
  G711_SAMPLE_RATE,
  REALTIME_PCM_RATE,
} from './openaiRealtimeVoice.js'
import { loadFleetFromStore } from './fleetContext.js'
import { synthesizeSpeech } from './speak.js'
import { getCloudflareBindings } from './cloudflareBindings.js'
import {
  createOpusReplyEncoder,
  createOpusUploadDecoder,
  isOpusFramesFormat,
  OPUS_REPLY_SAMPLE_RATE,
  OPUS_WIRE_SAMPLE_RATE,
} from './opusTranscode.js'
import {
  deleteAudioCaptureObject,
  loadAudioCapture,
  persistAudioCapture,
} from './audioStorage.js'
import {
  audioCaptureExpiresAt,
  audioRetentionPolicy,
  deleteStoredAudio,
  hasStoredAudio,
  normalizeMaxAgeMs,
  selectExpiredAudioCaptures,
  sweepExpiredAudio,
} from './audioRetention.js'
import {
  // GET /v1/ops/audio-captures used this without importing it, so every call
  // threw ReferenceError and Express turned it into a bare HTML 500.
  audioCaptureSummary,
  buildHistoryPage,
  decodeHistoryCursor,
  HISTORY_MAX_SCAN,
  HISTORY_OVERSCAN,
  linkAudioCaptures,
  normalizeHistoryLimit,
  normalizeHistoryQuery,
  runDetailForJob,
} from './history.js'
import { parseByteRange, RANGE_UNSATISFIABLE } from './httpRange.js'
import {
  PRODUCT_SYNC_LIMITS,
  visibleProductSync,
} from '../shared/productSync.js'
import {
  authenticateRelayRequest,
  createDeviceCredential,
  principalHasScopes,
  principalOwnsDevice,
  publicCredential,
  SUPPORTED_DEVICE_TYPES,
  verifyPairingCode,
} from './deviceAuth.js'
import { bridgeClaimDelay } from './polling.js'
import {
  isRawPcmFormat,
  isG711UlawFormat,
  pendantAudioFormat,
  pcmS16leToWavBuffer,
  preparePendantAudioForStt,
  ulawToPcmS16le,
} from './rawAudio.js'

const app = express()
// Default if pendant omits X-Sample-Rate (nRF live path sends 15625).
const PENDANT_PCM_SAMPLE_RATE = 15625
const PENDANT_PCM_CHANNELS = 1
const PENDANT_PCM_BITS = 16
const DIAGNOSTIC_AUDIO_MAX_BYTES = 1024 * 1024
const DIAGNOSTIC_AUDIO_R2_MAX_BYTES = 8 * 1024 * 1024

/**
 * Build the complete Mac-side plan payload from a Realtime voice plan.
 * Mac must execute plannerHint.actions (or speak plannerHint.response), never
 * treat job.command (history label / transcript) as the plan.
 *
 * E2E probe (local):
 *   # With relay + bridge + agent running, press the pendant (or POST PCM to
 *   # /v1/pendant/command). Expect: relay log actionCount>0, bridge log
 *   # "Audio-native execute-only" and no local /plan when actions present.
 *   # Battery: Realtime emits run_shell pmset -g batt → bridge auto-executes.
 */
export function plannerHintFromPlan(plan) {
  if (!plan) return undefined
  // Realtime / audio-native plans always attach a complete hint so the Mac
  // never treats the job as "transcript-only → re-plan with text LLM".
  const isAudioNative =
    plan.planner === 'audio-native' ||
    plan.planner === 'audio-native-delegate' ||
    plan.planner === 'audio-native-realtime' ||
    plan.source === 'audio-native-realtime' ||
    plan.source === 'audio-native'
  const actions = Array.isArray(plan.actions) ? plan.actions : []
  const requireLocalPlanner = Boolean(plan.requireLocalPlanner)
  const hasPlanPayload =
    isAudioNative ||
    actions.length > 0 ||
    Boolean(plan.status) ||
    Boolean(plan.response) ||
    requireLocalPlanner
  if (!hasPlanPayload) return undefined
  return {
    status:
      plan.status ||
      (requireLocalPlanner || actions.length ? 'ready' : 'instant'),
    response: plan.response,
    actions,
    planner:
      plan.planner ||
      (requireLocalPlanner ? 'audio-native-delegate' : 'audio-native'),
    requireLocalPlanner,
    toolsUsed: plan.toolsUsed,
    passes: plan.passes ?? 1,
    midPressStreamed: Boolean(plan.midPressStreamed),
  }
}

export async function enqueueMacPlanJob({
  store,
  deviceId,
  sessionId,
  plan,
  rawAudioBytes,
  format,
  sampleRate,
  channels,
  bitsPerSample,
  transcriptionDurationMs,
}) {
  const inputTelemetry = {
    audioBytes: rawAudioBytes,
    format: isRawPcmFormat(format) ? 'pcm-s16le' : format,
    sampleRate,
    channels,
    bitsPerSample,
    storage: 'live_lte',
    uploadState: 'uploaded',
    uploadedFormat: isRawPcmFormat(format) ? 'pcm' : format,
    transcriptionModel: plan.model,
    transcriptionLanguage: plan.language,
    transcriptionDurationMs,
    transcriptionSource: plan.source || 'stt',
    midPressStreamed: Boolean(plan.midPressStreamed),
  }
  // command is a short history label only; plannerHint carries the real plan.
  // Never put transcript-as-plan into job.actions — Mac uses plannerHint.
  const job = createPlanJob({
    command: String(plan.text || '').trim() || 'voice command',
    deviceId,
    sessionId,
    inputTelemetry,
  })
  const hint = plannerHintFromPlan(plan)
  if (hint) job.plannerHint = hint
  if (plan.toolsUsed) job.toolsUsed = plan.toolsUsed
  const actionCount = Array.isArray(hint?.actions) ? hint.actions.length : 0
  console.log(
    `[relay] Enqueued Mac plan job ${job.jobId} actionCount=${actionCount}` +
      ` requireLocalPlanner=${Boolean(hint?.requireLocalPlanner)}` +
      ` planner=${hint?.planner || 'none'}` +
      (plan.toolsUsed?.length ? ` toolsUsed=${plan.toolsUsed.join(',')}` : ''),
  )
  await store.createJob(job)
  return job
}

/**
 * Voice audio → Realtime plan only (no Whisper / gpt-audio fallbacks).
 */
async function resolveAudioTranscript({
  audioBase64,
  audioBuffer,
  format,
  sampleRate,
  language,
}) {
  const plan = await planFromAudio({
    audioBase64,
    audioBuffer,
    format,
    sampleRate,
    language,
  })

  return {
    text: plan.text,
    model: plan.model,
    language: plan.language,
    durationMs: plan.durationMs,
    source: plan.source,
    toolsUsed: plan.toolsUsed,
    // Always complete so Mac uses actions/response, never re-plans from text.
    plannerHint: plannerHintFromPlan(plan),
  }
}

app.use(cors())
app.use(express.json({ limit: '12mb' }))

app.get('/health', async (_request, response) => {
  const store = await getStore()
  const devices = await store.listDevices()
  const macBridge = devices.find((device) => device.deviceType === 'mac_bridge')
  const cloudflareBindings = getCloudflareBindings()

  response.json({
    ok: true,
    service: 'AI Pendant Cloud Relay',
    version: '1.1.0',
    platform: cloudflareBindings ? 'cloudflare-workers' : 'node',
    store: store.kind,
    relayApiKeyConfigured: Boolean(RELAY_API_KEY),
    speechToTextConfigured: Boolean(
      process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || LLM_API_KEY,
    ),
    pairingRequired: Boolean(PAIRING_CODE),
    macBridgeOnline: isDeviceOnline(macBridge),
    macBridgeLastSeen: macBridge?.lastSeenAt ?? null,
    capabilities: {
      pendantPipelineTelemetry: true,
      pendantSpeech: true,
      persistentAgentState: true,
      durableAudio: Boolean(cloudflareBindings?.AUDIO_BUCKET),
    },
    models: {
      voiceAgent: process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
      textToSpeech: 'macOS say (24 kHz PCM)',
      relayTextToSpeechFallback: `${TTS_MODEL} · ${TTS_VOICE}`,
    },
  })
})

app.post('/v1/devices/pair', async (request, response) => {
  const deviceId = String(request.body?.deviceId ?? '').trim()
  const deviceType = String(request.body?.deviceType ?? '').trim()
  const name = String(request.body?.name ?? '').trim()
  const pairingCode = String(request.body?.pairingCode ?? '').trim()

  if (!deviceId || !SUPPORTED_DEVICE_TYPES.includes(deviceType)) {
    response.status(400).json({
      ok: false,
      error: `deviceId and deviceType (${SUPPORTED_DEVICE_TYPES.join('|')}) are required.`,
    })
    return
  }

  if (!PAIRING_CODE) {
    response.status(503).json({
      ok: false,
      error:
        'Blocked for safety: device pairing is not configured on the cloud relay.',
    })
    return
  }

  if (!verifyPairingCode(pairingCode, PAIRING_CODE)) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: invalid pairing code.',
    })
    return
  }

  const now = new Date().toISOString()
  let issued
  try {
    issued = createDeviceCredential({
      deviceId,
      deviceType,
      now,
    })
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error.message || 'Device pairing request is invalid.',
    })
    return
  }

  const store = await getStore()
  const device = await store.saveDevice({
    deviceId,
    deviceType,
    name: name || deviceId,
    registeredAt: now,
    lastSeenAt: now,
    updatedAt: now,
  })
  await store.saveDeviceCredential(issued.record)

  response.status(201).json({
    ok: true,
    device,
    credential: {
      ...publicCredential(issued.record),
      token: issued.token,
    },
  })
})

app.use(async (request, response, next) => {
  const auth = await authenticateRelayRequest({
    authorization: request.get('authorization') ?? '',
    adminApiKey: RELAY_API_KEY,
    credentialStore: await getStore(),
  })
  if (!auth.ok) {
    response.status(auth.status || 401).json({
      ok: false,
      error: auth.error,
    })
    return
  }

  request.relayPrincipal = auth.principal
  const requiredScopes = requiredScopesForRequest(request)
  if (
    !requiredScopes ||
    !principalHasScopes(request.relayPrincipal, ...requiredScopes)
  ) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: this device is not allowed to use that route.',
    })
    return
  }

  next()
})

app.post('/v1/devices/register', async (request, response) => {
  const deviceId = String(request.body?.deviceId ?? '').trim()
  const deviceType = String(request.body?.deviceType ?? '').trim()
  const name = String(request.body?.name ?? '').trim()
  const pairingCode = String(request.body?.pairingCode ?? '').trim()

  if (!deviceId || !['mac_bridge', 'mobile'].includes(deviceType)) {
    response.status(400).json({
      ok: false,
      error: 'deviceId and deviceType (mac_bridge|mobile) are required.',
    })
    return
  }

  if (PAIRING_CODE && pairingCode !== PAIRING_CODE) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: invalid pairing code.',
    })
    return
  }

  const store = await getStore()
  const now = new Date().toISOString()
  const device = await store.saveDevice({
    deviceId,
    deviceType,
    name: name || deviceId,
    registeredAt: now,
    lastSeenAt: now,
    updatedAt: now,
  })

  response.json({
    ok: true,
    device,
  })
})

app.post('/v1/devices/heartbeat', async (request, response) => {
  const deviceId = String(request.body?.deviceId ?? '').trim()

  if (!deviceId) {
    response.status(400).json({
      ok: false,
      error: 'deviceId is required.',
    })
    return
  }
  if (!principalOwnsDevice(request.relayPrincipal, deviceId)) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: a device may only heartbeat itself.',
    })
    return
  }

  const store = await getStore()
  const existing = await store.getDevice(deviceId)
  if (!existing) {
    response.status(404).json({
      ok: false,
      error: 'Device is not registered.',
    })
    return
  }

  const now = new Date().toISOString()
  const device = await store.saveDevice({
    deviceId,
    deviceType: existing.deviceType,
    name: existing.name,
    registeredAt: existing.registeredAt,
    lastSeenAt: now,
    updatedAt: now,
  })

  response.json({
    ok: true,
    device,
  })
})

app.get('/v1/devices/status', async (_request, response) => {
  const store = await getStore()
  const devices = await store.listDevices()

  response.json({
    ok: true,
    devices: devices.map((device) => ({
      ...device,
      online: isDeviceOnline(device),
    })),
  })
})

app.get('/v1/product/state/:accountId', async (request, response) => {
  const accountId = String(request.params.accountId || '').trim()
  if (accountId !== PENDANT_ACCOUNT_ID) {
    response.status(404).json({
      ok: false,
      error: 'Product state was not found for this account.',
    })
    return
  }

  try {
    const state = await (await getStore()).getProductState(accountId)
    if (!state) {
      response.status(404).json({
        ok: false,
        error: 'Product state has not been synchronized yet.',
      })
      return
    }
    response.set('Cache-Control', 'private, no-store')
    response.json({ ok: true, state })
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error.message || 'Product state could not be read.',
    })
  }
})

app.put('/v1/product/state', async (request, response) => {
  const input = request.body?.state
  if (!input || typeof input !== 'object' || Array.isArray(input)) {
    response.status(400).json({
      ok: false,
      error: 'A product state object is required.',
    })
    return
  }
  if (String(input.accountId || '').trim() !== PENDANT_ACCOUNT_ID) {
    response.status(403).json({
      ok: false,
      error: 'Product state belongs to a different account.',
    })
    return
  }

  try {
    const sourceDeviceId =
      request.relayPrincipal?.kind === 'device'
        ? request.relayPrincipal.deviceId
        : input.sourceDeviceId
    const state = await (await getStore()).mergeProductState({
      ...input,
      sourceDeviceId,
    })
    response.set('Cache-Control', 'private, no-store')
    response.status(200).json({ ok: true, state })
  } catch (error) {
    response.status(error instanceof RangeError ? 413 : 400).json({
      ok: false,
      error: error.message || 'Product state could not be synchronized.',
    })
  }
})

app.get('/v1/state/:stateKey', async (request, response) => {
  const stateKey = normalizeStateKey(request.params.stateKey)
  if (!stateKey) {
    response.status(400).json({
      ok: false,
      error: 'State key must use lowercase letters, numbers, and hyphens.',
    })
    return
  }

  const store = await getStore()
  const state = await store.getState(stateKey)
  if (!state) {
    response.status(404).json({
      ok: false,
      error: 'Persistent state has not been published yet.',
    })
    return
  }

  response.set('Cache-Control', 'private, no-store')
  response.json({ ok: true, state })
})

app.put('/v1/state/:stateKey', async (request, response) => {
  const stateKey = normalizeStateKey(request.params.stateKey)
  const data = request.body?.data
  const updatedBy =
    request.relayPrincipal?.kind === 'device'
      ? request.relayPrincipal.deviceId
      : 'admin'

  if (!stateKey) {
    response.status(400).json({
      ok: false,
      error: 'State key must use lowercase letters, numbers, and hyphens.',
    })
    return
  }
  if (!data || typeof data !== 'object' || Array.isArray(data)) {
    response.status(400).json({
      ok: false,
      error: 'Persistent state data must be a JSON object.',
    })
    return
  }

  const store = await getStore()
  const state = await store.saveState(stateKey, data, {
    updatedBy: updatedBy || 'unknown',
  })
  response.status(201).json({ ok: true, state })
})

app.post('/v1/pendant/announce', async (request, response) => {
  // Creates a visible pending job the moment the pendant stops recording,
  // seconds before the audio upload itself completes.
  const deviceId =
    String(request.body?.deviceId || 'nrf9160-pendant').trim() ||
    'nrf9160-pendant'
  if (!principalOwnsDevice(request.relayPrincipal, deviceId)) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: a device may only announce its own audio.',
    })
    return
  }
  const store = await getStore()
  const job = createPlanJob({
    command: '',
    deviceId,
    sessionId: String(request.body?.sessionId || '').trim() || null,
    status: 'transcribing',
    inputTelemetry: {
      storage: 'microSD',
      format: String(request.body?.format || 'wav'),
      expectedPcmBytes: Number(request.body?.pcmBytes || 0) || null,
      sampleRate: Number(request.body?.sampleRate || 0) || null,
      uploadState: 'uploading',
      announcedAt: new Date().toISOString(),
    },
  })
  await store.createJob(job)
  response.status(201).json({ ok: true, jobId: job.jobId })
})

app.post('/v1/transcribe', async (request, response) => {
  let transcriptionJob = null
  let capture = null
  let store = null

  try {
    const requestDeviceId = String(request.body?.deviceId || '').trim()
    if (
      request.relayPrincipal?.kind === 'device' &&
      (!requestDeviceId ||
        !principalOwnsDevice(request.relayPrincipal, requestDeviceId))
    ) {
      response.status(403).json({
        ok: false,
        error:
          'Blocked for safety: deviceId must identify the authenticated device.',
      })
      return
    }
    const audioBase64 = String(request.body?.audioBase64 || '')
      .replace(/^data:[^;]+;base64,/, '')
      .trim()
    const audioBytes = Buffer.byteLength(audioBase64, 'base64')
    const requestedTelemetry =
      request.body?.inputTelemetry &&
      typeof request.body.inputTelemetry === 'object'
        ? request.body.inputTelemetry
        : {}

    if (audioBytes > 0) {
      store = await getStore()
      const announcedJobId = String(request.body?.jobId || '').trim()
      const announced = announcedJobId
        ? await store.getJob(announcedJobId)
        : null
      if (
        announced?.type === 'plan' &&
        !announced.result &&
        announced.status === 'transcribing'
      ) {
        // The pendant announced this recording before uploading; attach
        // the audio to the already-visible job instead of a new one.
        transcriptionJob = await store.updateJob(announced.jobId, {
          status: 'transcribing',
          inputTelemetry: {
            ...(announced.inputTelemetry || {}),
            ...requestedTelemetry,
            audioBytes,
            format: String(request.body?.format || 'wav'),
            storage:
              requestedTelemetry.storage ||
              announced.inputTelemetry?.storage ||
              'microSD',
            transcriptionLanguage: request.body?.language || null,
            uploadState: 'uploaded',
          },
        })
      } else {
        transcriptionJob = createPlanJob({
          command: '',
          deviceId: String(
            request.body?.deviceId || 'nrf9160-pendant',
          ).trim(),
          sessionId: String(request.body?.sessionId || '').trim() || null,
          status: 'transcribing',
          inputTelemetry: {
            ...requestedTelemetry,
            audioBytes,
            format: String(request.body?.format || 'wav'),
            storage: requestedTelemetry.storage || 'microSD',
            transcriptionLanguage: request.body?.language || null,
          },
        })
        await store.createJob(transcriptionJob)
      }

      const r2AudioEnabled = Boolean(
        getCloudflareBindings()?.AUDIO_BUCKET?.put,
      )
      const diagnosticAudioLimit = r2AudioEnabled
        ? DIAGNOSTIC_AUDIO_R2_MAX_BYTES
        : DIAGNOSTIC_AUDIO_MAX_BYTES
      if (audioBytes <= diagnosticAudioLimit) {
        capture = createAudioCapture({
          audioBase64,
          audioBytes,
          format: String(request.body?.format || 'wav'),
          language: request.body?.language || null,
          transcript: null,
          transcriptionModel: null,
          // Cross-reference the run from the start: without it a history page
          // can only guess which recording belongs to which transcript.
          planJobId: transcriptionJob?.jobId ?? null,
          status: 'received',
        })
        const persistedAudio = await persistAudioCapture({
          captureId: capture.jobId,
          audioBase64,
          audioBytes,
          format: capture.format,
          createdAt: capture.createdAt,
          allowD1Fallback: audioBytes <= DIAGNOSTIC_AUDIO_MAX_BYTES,
        })
        if (persistedAudio.audioStorageWarning) {
          console.warn(`[relay] ${persistedAudio.audioStorageWarning}`)
        }
        if (persistedAudio.audioStorage === 'unavailable') {
          capture = null
        } else {
          capture = {
            ...capture,
            ...persistedAudio,
          }
        }
        /*
         * Persist the raw recording before / alongside Realtime planning so the
         * Mac capture watcher can download it without waiting on the plan.
         */
        if (capture) {
          try {
            await store.createJob(capture)
          } catch (error) {
            await deleteAudioCaptureObject(capture).catch((cleanupError) => {
              console.warn(
                `[relay] Could not remove orphaned audio object: ${
                  cleanupError?.message || cleanupError
                }`,
              )
            })
            capture = null
            throw error
          }

          // Mirror the link onto the plan job so run detail can offer
          // "play this recording" without timestamp guesswork.
          if (transcriptionJob) {
            transcriptionJob =
              (await store.updateJob(transcriptionJob.jobId, {
                inputTelemetry: {
                  ...(transcriptionJob.inputTelemetry || {}),
                  captureId: capture.jobId,
                },
              })) || transcriptionJob
          }
        }
      }
    }

    const result = await resolveAudioTranscript({
      audioBase64,
      format: request.body?.format,
      language: request.body?.language,
    })
    const transcriptionDurationMs = result.durationMs

    if (transcriptionJob) {
      const jobPatch = {
        command: result.text,
        status: 'transcribed',
        inputTelemetry: {
          ...transcriptionJob.inputTelemetry,
          transcriptionModel: result.model,
          transcriptionLanguage: result.language,
          transcriptionDurationMs,
          transcriptionSource: result.source || 'stt',
        },
      }
      if (result.plannerHint) {
        jobPatch.plannerHint = result.plannerHint
      }
      transcriptionJob = await store.updateJob(transcriptionJob.jobId, jobPatch)
    }

    if (capture) {
      capture = await store.updateJob(capture.jobId, {
        status: 'completed',
        language: result.language || request.body?.language || null,
        transcript: result.text,
        transcriptionModel: result.model,
      })
    }

    response.json({
      ok: true,
      text: result.text,
      model: result.model,
      language: result.language,
      durationMs: transcriptionDurationMs,
      source: result.source || 'stt',
      plannerHint: result.plannerHint,
      captureId: capture?.jobId ?? null,
      jobId: transcriptionJob?.jobId ?? null,
    })
  } catch (error) {
    if (transcriptionJob && store) {
      await store
        .updateJob(transcriptionJob.jobId, {
          status: 'failed',
          error: error.message || 'Transcription failed.',
        })
        .catch(() => {})
    }
    if (capture && store) {
      await store
        .updateJob(capture.jobId, {
          status: 'failed',
          error: error.message || 'Transcription failed.',
        })
        .catch(() => {})
    }
    response.status(error.message.includes('not configured') ? 503 : 400).json({
      ok: false,
      error: error.message || 'Transcription failed.',
    })
  }
})

/*
 * Mid-press streaming voice command.
 *
 * Pendant opens chunked POST during record and pumps PCM while the button is
 * held. This handler does NOT wait for the full body before talking to
 * OpenAI: it opens Realtime immediately and appends each PCM chunk as it
 * arrives, then commits when the body ends.
 *
 * Headers:
 *   Content-Type: audio/pcm | audio/ogg | audio/wav
 *   Transfer-Encoding: chunked (live capture)
 *   Authorization: Bearer <RELAY_API_KEY>
 *   X-Device-Id, X-Session-Id, X-Language, X-Sample-Rate
 *   X-Audio-Format: pcm | ogg | wav
 *
 * Add ?dispatch=0 to plan without queueing a Mac command.
 */
/*
 * Run async work that must SURVIVE the response ending. In Cloudflare
 * Workers, promises left dangling after the response completes are killed —
 * which silently dropped the dashboard capture for every conversational run
 * (the audio stream ends the response first). ctx.waitUntil keeps them alive;
 * plain Node (tests, local agent) just runs the promise.
 */
let cloudflareWaitUntil = null
void import('cloudflare:workers')
  .then((mod) => {
    cloudflareWaitUntil = mod.waitUntil || null
  })
  .catch(() => {})

function keepAliveAfterResponse(work) {
  const promise = Promise.resolve()
    .then(work)
    .catch((error) => {
      console.warn(
        `[relay] post-response task failed: ${error?.message || error}`,
      )
    })

  if (typeof cloudflareWaitUntil === 'function') {
    try {
      cloudflareWaitUntil(promise)
    } catch {
      /* outside a request context — the promise still runs */
    }
  }
  return promise
}

/*
 * Compact a Mac execution result for a Realtime function_call_output: keep
 * the fields the model needs to speak an answer, cap the per-action outputs
 * so a chatty command can't blow up the conversation context.
 */
export function trimMacResultForModel(result) {
  const actionResults = Array.isArray(result.results)
    ? result.results.slice(0, 6).map((entry) => {
        const text = JSON.stringify(entry) || ''
        return text.length > 400 ? `${text.slice(0, 400)}…` : entry
      })
    : undefined

  return {
    executed: Boolean(result.executed),
    response: String(result.response || '').slice(0, 400) || undefined,
    executionError:
      String(result.executionError || '').slice(0, 400) || undefined,
    results: actionResults,
  }
}

app.post('/v1/pendant/command', async (request, response) => {
  const format = pendantAudioFormat({
    headerFormat: request.get('x-audio-format'),
    contentType: request.get('content-type'),
  })
  const sampleRateHeader = Number(
    request.get('x-sample-rate') || PENDANT_PCM_SAMPLE_RATE,
  )
  const sampleRate = Number.isFinite(sampleRateHeader)
    ? sampleRateHeader
    : PENDANT_PCM_SAMPLE_RATE
  const channelsHeader = Number(
    request.get('x-audio-channels') || PENDANT_PCM_CHANNELS,
  )
  const bitsHeader = Number(request.get('x-audio-bits') || PENDANT_PCM_BITS)
  const channels = Number.isFinite(channelsHeader)
    ? channelsHeader
    : PENDANT_PCM_CHANNELS
  const bitsPerSample = Number.isFinite(bitsHeader)
    ? bitsHeader
    : PENDANT_PCM_BITS
  const language = String(request.get('x-language') || '').trim() || null
  const deviceId =
    String(request.get('x-device-id') || 'nrf9160-pendant').trim() ||
    'nrf9160-pendant'
  const sessionId = String(request.get('x-session-id') || '').trim() || null
  const shouldDispatch = String(request.query?.dispatch ?? '1') !== '0'

  if (!principalOwnsDevice(request.relayPrincipal, deviceId)) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: a device may only upload its own commands.',
    })
    return
  }

  if (!process.env.OPENAI_API_KEY && !process.env.OPENAI_KEY) {
    response.status(503).json({
      ok: false,
      error: 'Voice agent requires OPENAI_API_KEY on the Worker.',
    })
    return
  }

  try {
    const store = await getStore()
    let job = null
    let jobEnqueuedCount = 0
    let macBridgeOnline = false
    const pcmChunks = []
    let rawByteCount = 0
    const startedAt = Date.now()

    async function dispatchPlan(plan, { allowRepeat = false } = {}) {
      // Semantic-VAD recordings can carry SEVERAL commands; each tool call
      // dispatches its own job (allowRepeat). Everything else keeps the
      // one-job-per-request rule.
      if (!shouldDispatch || !plan) return job
      if (jobEnqueuedCount > 0 && !allowRepeat) return job
      const hasWork =
        Boolean(String(plan.text || '').trim()) ||
        (Array.isArray(plan.actions) && plan.actions.length > 0) ||
        Boolean(String(plan.response || '').trim()) ||
        Boolean(plan.requireLocalPlanner)
      if (!hasWork) return job
      jobEnqueuedCount += 1
      job = await enqueueMacPlanJob({
        store,
        deviceId,
        sessionId,
        plan,
        rawAudioBytes: rawByteCount,
        format,
        sampleRate,
        channels,
        bitsPerSample,
        transcriptionDurationMs: plan.durationMs ?? Date.now() - startedAt,
      })
      return job
    }

    // Async diagnostic store (WAV for dashboard). Fire-and-forget; called on
    // every response path, including the inline audio-stream exits which
    // would otherwise leave no trace of the run in history.
    function storeDiagnosticCapture(planForCapture) {
      const rawAudio = Buffer.concat(pcmChunks)
      const isUlawCapture = isG711UlawFormat(format)
      const isOpusCapture = isOpusFramesFormat(format)
      const wavForHistory = isUlawCapture
        ? pcmS16leToWavBuffer(ulawToPcmS16le(rawAudio), {
            sampleRate: G711_SAMPLE_RATE,
            channels: 1,
            bitsPerSample: 16,
          })
        : isOpusCapture
          ? pcmS16leToWavBuffer(rawAudio, {
              sampleRate: OPUS_WIRE_SAMPLE_RATE,
              channels: 1,
              bitsPerSample: 16,
            })
          : isRawPcmFormat(format)
            ? pcmS16leToWavBuffer(rawAudio, {
                sampleRate,
                channels,
                bitsPerSample,
              })
            : rawAudio
      const captureFormat =
        isUlawCapture || isOpusCapture || isRawPcmFormat(format)
          ? 'wav'
          : format
      const audioBase64 = wavForHistory.toString('base64')
      const r2AudioEnabled = Boolean(getCloudflareBindings()?.AUDIO_BUCKET?.put)
      const diagnosticAudioLimit = r2AudioEnabled
        ? DIAGNOSTIC_AUDIO_R2_MAX_BYTES
        : DIAGNOSTIC_AUDIO_MAX_BYTES
      if (
        wavForHistory.length === 0 ||
        wavForHistory.length > diagnosticAudioLimit
      ) {
        return
      }
      return keepAliveAfterResponse(async () => {
        let capture = null
        try {
          capture = createAudioCapture({
            audioBase64,
            audioBytes: wavForHistory.length,
            format: captureFormat,
            language,
            // ASR text only, never plan.text — that is a history label whose
            // fallback is the literal filler 'voice command'.
            transcript: planForCapture?.transcript,
            transcriptionModel: planForCapture?.model,
            status: 'completed',
          })
          const persistedAudio = await persistAudioCapture({
            captureId: capture.jobId,
            audioBase64,
            audioBytes: wavForHistory.length,
            format: captureFormat,
            createdAt: capture.createdAt,
            allowD1Fallback: wavForHistory.length <= DIAGNOSTIC_AUDIO_MAX_BYTES,
          })
          if (persistedAudio.audioStorage === 'unavailable') return
          capture = { ...capture, ...persistedAudio }
          await store.createJob(capture)

          // The agent's own voice, WAV-wrapped, as a linked reply capture so
          // the dashboard can play BOTH sides of the exchange.
          const replyRaw = Buffer.concat(replyAudioChunks)
          if (replyRaw.length > 0) {
            const replyWav = replyIsUlaw
              ? pcmS16leToWavBuffer(ulawToPcmS16le(replyRaw), {
                  sampleRate: G711_SAMPLE_RATE,
                  channels: 1,
                  bitsPerSample: 16,
                })
              : pcmS16leToWavBuffer(replyRaw, {
                  sampleRate: REALTIME_PCM_RATE,
                  channels: 1,
                  bitsPerSample: 16,
                })
            const replyTranscript =
              String(planForCapture?.response || '').trim() || null

            if (replyWav.length <= diagnosticAudioLimit) {
              let replyCapture = createAudioCapture({
                audioBase64: replyWav.toString('base64'),
                audioBytes: replyWav.length,
                format: 'wav',
                language,
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
                allowD1Fallback:
                  replyWav.length <= DIAGNOSTIC_AUDIO_MAX_BYTES,
              })
              if (persistedReply.audioStorage !== 'unavailable') {
                replyCapture = { ...replyCapture, ...persistedReply }
                await store.createJob(replyCapture)
                await store.updateJob(capture.jobId, {
                  replyCaptureId: replyCapture.jobId,
                  replyTranscript,
                })
              }
            } else if (replyTranscript) {
              await store.updateJob(capture.jobId, { replyTranscript })
            }
          }
          if (job?.jobId) {
            await store.updateJob(capture.jobId, { planJobId: job.jobId })
            await store.updateJob(job.jobId, {
              inputTelemetry: {
                ...(job.inputTelemetry || {}),
                captureId: capture.jobId,
              },
            })
          }
        } catch (error) {
          console.warn(
            `[relay] Pendant audio capture not stored (async): ${
              error?.message || error
            }`,
          )
          if (capture) {
            await deleteAudioCaptureObject(capture).catch(() => {})
          }
        }
      })
    }

    let plan

    // Realtime only: mid-press stream when PCM, else buffer then Realtime batch.
    // Promise, not value: the D1 fleet read overlaps the OpenAI WS handshake
    // (createStreamingRealtimeSession awaits it after the socket is open).
    const fleetPromise = loadFleetFromStore(store).catch(() => null)

    /*
     * Conversational reply path (firmware opt-in via X-Reply-Stream):
     * the model speaks and its audio deltas go straight down this same
     * connection as a chunked audio response — no Mac TTS, no reply polling.
     * Header value picks the reply codec: 'pcmu' = G.711 μ-law 8 kHz
     * (64 kbps — fits real-world LTE-M downlink), 'pcm' = 24 kHz s16le
     * (broadband only). Without the header the classic JSON response is
     * unchanged.
     */
    const replyStreamCodec = String(request.headers['x-reply-stream'] || '')
      .trim()
      .toLowerCase()
    const wantsReplyStream =
      replyStreamCodec === 'pcm' ||
      replyStreamCodec === 'pcmu' ||
      replyStreamCodec === 'opus'
    const replyIsUlaw = replyStreamCodec === 'pcmu'
    // Opus reply: model speaks 24 kHz PCM; we transcode to ~14 kbps 60 ms
    // length-prefixed packets the pendant can actually receive in realtime.
    const replyIsOpus = replyStreamCodec === 'opus'
    const replyOpusEncoder = replyIsOpus ? await createOpusReplyEncoder() : null
    let replyStreamStarted = false
    // Keep a copy of the agent's spoken reply for dashboard playback.
    const replyAudioChunks = []
    let replyAudioBytes = 0
    const REPLY_AUDIO_MAX_BYTES = 1_500_000
    const streamReplyDelta = (pcm) => {
      if (!pcm?.length || response.writableEnded) return
      if (!replyIsOpus && replyAudioBytes < REPLY_AUDIO_MAX_BYTES) {
        // COPY: response.write() transfers (detaches) the buffer's memory in
        // the Workers stream bridge, leaving pushed references empty.
        replyAudioChunks.push(Buffer.from(pcm))
        replyAudioBytes += pcm.length
      }
      if (!replyStreamStarted) {
        replyStreamStarted = true
        response.status(200).set({
          'Content-Type': replyIsOpus
            ? 'audio/opus'
            : replyIsUlaw
              ? 'audio/pcmu'
              : 'audio/pcm',
          'Cache-Control': 'no-store',
          'X-Audio-Format': replyIsOpus
            ? 'opus-frames'
            : replyIsUlaw
              ? 'pcmu'
              : 's16le',
          // The firmware clocks its I2S output from this header: opus
          // replies are 24 kHz (the model's own rate, never resampled),
          // μ-law is fixed 8 kHz, PCM deltas are 24 kHz — never the
          // 15,625 mic rate.
          'X-Audio-Sample-Rate': String(
            replyIsOpus
              ? OPUS_REPLY_SAMPLE_RATE
              : replyIsUlaw
                ? G711_SAMPLE_RATE
                : REALTIME_PCM_RATE,
          ),
          'X-Audio-Channels': '1',
          'X-Audio-Bits': replyIsOpus ? '0' : replyIsUlaw ? '8' : '16',
          ...(job?.jobId ? { 'X-Job-Id': job.jobId } : {}),
        })
        response.flushHeaders?.()
      }
      response.write(pcm)
    }
    // Opus replies: capture the model's 24 kHz PCM for the dashboard, then
    // stream the transcoded packets. Other codecs pass deltas straight through.
    const onReplyDelta = replyIsOpus
      ? (pcm) => {
          if (!pcm?.length) return
          if (replyAudioBytes < REPLY_AUDIO_MAX_BYTES) {
            replyAudioChunks.push(Buffer.from(pcm))
            replyAudioBytes += pcm.length
          }
          const packets = replyOpusEncoder.push(pcm)

          if (packets.length) streamReplyDelta(packets)
        }
      : streamReplyDelta
    const flushReplyEncoder = () => {
      if (!replyIsOpus || response.writableEnded) return
      try {
        const tail = replyOpusEncoder.end()

        if (tail.length) streamReplyDelta(tail)
      } catch (error) {
        console.warn(`[relay] opus flush failed: ${error?.message || error}`)
      }
    }

    const ulawUpload = isG711UlawFormat(format)
    const opusUpload = isOpusFramesFormat(format)
    const opusUploadDecoder = opusUpload
      ? await createOpusUploadDecoder()
      : null

    if (isRawPcmFormat(format) || ulawUpload || opusUpload) {
      /*
       * Create the Realtime session on the FIRST body byte, not at headers:
       * the firmware prewarms this request (headers sent, body idle) and
       * rotates stale sockets every ~15s, so a header-time session would
       * open and leak an OpenAI WS per idle refresh, all day.
       *
       * NEVER await the session inside the read loop: blocking the read
       * backpressures TCP into the modem and overflows the pendant's tiny
       * PCM ring (~1s of audio) mid-utterance. The WS handshake runs
       * concurrently; chunks buffer locally and catch up when it opens.
       */
      let session = null
      let sessionPromise = null
      const chunksAwaitingSession = []

      try {
        for await (const chunk of request) {
          const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
          if (!buf.length) continue
          if (!sessionPromise) {
            sessionPromise = createStreamingRealtimeSession({
              inputSampleRate: opusUpload ? OPUS_WIRE_SAMPLE_RATE : sampleRate,
              language,
              fleet: fleetPromise,
              audioOut: wantsReplyStream,
              onAudioDelta: wantsReplyStream ? onReplyDelta : null,
              inputFormat: ulawUpload ? 'pcmu' : 'pcm',
              outputFormat: replyIsUlaw ? 'pcmu' : 'pcm',
              deviceTime:
                String(request.get('x-device-time') || '').trim() || null,
              onEarlyPlan: async (earlyPlan) => {
                return await dispatchPlan(earlyPlan, {
                  allowRepeat: wantsReplyStream,
                })
              },
              // Status tools hold the turn on this so the spoken reply can
              // contain the Mac's actual data (Mac claims in ~250 ms and
              // posts an early phase:'executed' result).
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
            }).then((opened) => {
              session = opened
              for (const pending of chunksAwaitingSession) {
                session.appendRawPcm(pending)
              }
              chunksAwaitingSession.length = 0
              return opened
            })
            // Failures surface at the await below; don't crash the process.
            sessionPromise.catch(() => {})
          }
          rawByteCount += buf.length
          const feed = opusUpload ? opusUploadDecoder.push(buf) : buf

          if (!feed.length) continue
          pcmChunks.push(feed)
          if (session) {
            session.appendRawPcm(feed)
          } else {
            chunksAwaitingSession.push(feed)
          }
        }
      } catch (error) {
        // Client (pendant) aborted mid-upload — free the OpenAI WS now
        // instead of leaking it until its own timeout.
        void sessionPromise?.then((opened) => opened.abort(error)).catch(() => {})
        throw error
      }

      if (rawByteCount === 0 || !sessionPromise) {
        response.status(400).json({
          ok: false,
          error: 'Raw audio body is required.',
        })
        return
      }

      try {
        session = await sessionPromise
        plan = await session.finish()
      } catch (error) {
        if (replyStreamStarted) {
          // Mid-speech failure: end the audio stream cleanly; the pendant
          // treats a short stream as a finished (if clipped) reply.
          console.warn(
            `[relay] Realtime session failed mid-reply-stream: ${error?.message || error}`,
          )
          flushReplyEncoder()
          await storeDiagnosticCapture(null)
          response.end()
          return
        }
        throw error
      }
      // When the spoken reply already streamed inline, a plan whose only
      // content is that speech needs no Mac job — nothing would consume it.
      // Tool-call plans were already dispatched early (dispatchPlan is
      // idempotent via jobEnqueued).
      if (
        jobEnqueuedCount === 0 &&
        (!replyStreamStarted ||
          (Array.isArray(plan?.actions) && plan.actions.length > 0) ||
          plan?.requireLocalPlanner)
      ) {
        await dispatchPlan(plan)
      }
    } else {
      const bodyChunks = []
      for await (const chunk of request) {
        const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
        if (buf.length) {
          bodyChunks.push(buf)
          rawByteCount += buf.length
        }
      }
      const rawAudio = Buffer.concat(bodyChunks)
      if (!rawAudio.length) {
        response.status(400).json({
          ok: false,
          error: 'Raw audio body is required.',
        })
        return
      }
      pcmChunks.push(rawAudio)

      plan = await planFromAudio({
        audioBuffer: rawAudio,
        format,
        sampleRate,
        language,
        fleet: await fleetPromise,
      })
      await dispatchPlan(plan)
    }

    if (replyStreamStarted) {
      // The spoken reply already went down this connection; the job (if any)
      // was dispatched from the tool-call handler. Close the audio stream.
      flushReplyEncoder()
      await storeDiagnosticCapture(plan)
      response.end()
      return
    }

    const planHasContent =
      Boolean(String(plan?.text || '').trim()) ||
      (Array.isArray(plan?.actions) && plan.actions.length > 0) ||
      Boolean(String(plan?.response || '').trim()) ||
      Boolean(plan?.requireLocalPlanner)
    if (!plan || !planHasContent) {
      response.status(400).json({
        ok: false,
        error: 'Voice agent returned an empty plan.',
      })
      return
    }

    try {
      const devices = await store.listDevices()
      const macBridge = devices.find((d) => d.deviceType === 'mac_bridge')
      macBridgeOnline = isDeviceOnline(macBridge)
    } catch {
      macBridgeOnline = false
    }

    const hint = job?.plannerHint || plannerHintFromPlan(plan)
    response.status(job ? 202 : 200).json({
      ok: true,
      text: plan.text,
      model: plan.model,
      language: plan.language,
      durationMs: plan.durationMs ?? Date.now() - startedAt,
      source: plan.source || 'stt',
      plannerHint: hint,
      toolsUsed: plan.toolsUsed,
      midPressStreamed: Boolean(plan.midPressStreamed),
      audioBytes: rawByteCount,
      sttAudioBytes: rawByteCount,
      format: isRawPcmFormat(format) ? 'pcm' : format,
      sampleRate,
      captureId: null,
      dispatchRequested: shouldDispatch,
      macBridgeOnline,
      queued: Boolean(job),
      job: publicJob(job),
    })

    storeDiagnosticCapture(plan)
  } catch (error) {
    if (!response.headersSent) {
      response
        .status(error.message?.includes('not configured') ? 503 : 400)
        .json({
          ok: false,
          error: error.message || 'Pendant audio upload failed.',
        })
    } else {
      console.warn(
        `[relay] Pendant command error after response: ${
          error?.message || error
        }`,
      )
    }
  }
})

app.post('/v1/speak', async (request, response) => {
  try {
    const { audio: _audio, ...result } = await synthesizeSpeech({
      text: request.body?.text,
      language: request.body?.language,
      format: 'mp3',
    })

    response.json({
      ok: true,
      ...result,
    })
  } catch (error) {
    response.status(error.message.includes('not configured') ? 503 : 400).json({
      ok: false,
      error: error.message || 'Speech synthesis failed.',
    })
  }
})

/*
 * The embedded pendant cannot decode MP3. Return raw signed little-endian
 * PCM so the nRF9160 can stream it directly over I2S to the Bluetooth module.
 */
app.post('/v1/pendant/speak', async (request, response) => {
  try {
    const result = await synthesizeSpeech({
      text: request.body?.text,
      language: request.body?.language,
      format: 'pcm',
      includeBase64: false,
    })

    sendPendantAudio(response, result)
  } catch (error) {
    response.status(error.message.includes('not configured') ? 503 : 400).json({
      ok: false,
      error: error.message || 'Pendant speech synthesis failed.',
    })
  }
})

/*
 * Long-poll a Mac job and, once its result is ready, synthesize the spoken
 * response as raw PCM. This keeps JSON parsing and TTS credentials out of the
 * embedded firmware.
 */
app.get('/v1/pendant/jobs/:jobId/speech', async (request, response) => {
  const store = await getStore()
  const waitMs = Math.min(
    Math.max(Number(request.query?.waitMs || 25000), 0),
    28000,
  )
  const deadline = Date.now() + waitMs

  while (true) {
    const job = await store.getJob(request.params.jobId)

    if (!job) {
      response.status(404).json({
        ok: false,
        error: 'Job not found.',
      })
      return
    }
    if (
      request.relayPrincipal?.kind === 'device' &&
      job.createdBy !== request.relayPrincipal.deviceId
    ) {
      response.status(403).json({
        ok: false,
        error: 'Blocked for safety: this job belongs to another device.',
      })
      return
    }

    if (job.status === 'failed' || job.status === 'cancelled') {
      response.status(502).json({
        ok: false,
        error: job.error || `Mac job ${job.status}.`,
      })
      return
    }

    if (job.status === 'plan_ready' || job.status === 'completed') {
      const pendantSpeech = pendantSpeechForJob(job)
      if (pendantSpeech) {
        response.set('X-Pendant-Job-Status', job.status)
        sendPendantAudio(response, pendantSpeech)
        return
      }

      /*
       * Partial execute report: the Mac ran the actions and its speech is
       * still rendering (result.phase === 'executed', pendantSpeech absent).
       * Keep the long-poll parked for it — synthesizing the same text with
       * cloud TTS here would race the Mac render, and a synthesis failure
       * reads as fatal to the pendant (it abandons the reply entirely).
       */
      if (
        job.status === 'plan_ready' &&
        job.result?.phase === 'executed' &&
        Date.now() < deadline
      ) {
        await sleep(350)
        continue
      }

      const text = spokenTextForJob(job)
      if (!text) {
        response.status(422).json({
          ok: false,
          error: 'Mac job completed without a spoken response.',
        })
        return
      }

      try {
        const result = await synthesizeSpeech({
          text,
          format: 'pcm',
          includeBase64: false,
        })
        response.set('X-Pendant-Job-Status', job.status)
        sendPendantAudio(response, result)
      } catch (error) {
        response
          .status(error.message.includes('not configured') ? 503 : 400)
          .json({
            ok: false,
            error: error.message || 'Pendant speech synthesis failed.',
          })
      }
      return
    }

    if (Date.now() >= deadline) {
      response.status(202).json({
        ok: true,
        ready: false,
        status: job.status,
      })
      return
    }

    await sleep(350)
  }
})

app.post('/v1/mac/plan', async (request, response) => {
  const command = String(request.body?.command ?? '').trim()
  const deviceId = String(request.body?.deviceId ?? 'mobile').trim()
  const sessionId = String(request.body?.sessionId ?? '').trim() || null
  const transcriptionJobId = String(
    request.body?.transcriptionJobId ?? '',
  ).trim()
  const inputTelemetry =
    request.body?.inputTelemetry &&
    typeof request.body.inputTelemetry === 'object'
      ? request.body.inputTelemetry
      : null
  if (!principalOwnsDevice(request.relayPrincipal, deviceId)) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: a device may only create its own jobs.',
    })
    return
  }

  if (!command) {
    response.status(400).json({
      ok: false,
      error: 'command is required.',
    })
    return
  }

  const store = await getStore()
  const transcriptionJob = transcriptionJobId
    ? await store.getJob(transcriptionJobId)
    : null
  const devices = await store.listDevices()
  const macBridge = devices.find((device) => device.deviceType === 'mac_bridge')

  if (!isDeviceOnline(macBridge)) {
    if (transcriptionJob?.type === 'plan') {
      await store.updateJob(transcriptionJob.jobId, {
        status: 'failed',
        error: 'Mac bridge is offline.',
      })
    }
    response.status(503).json({
      ok: false,
      error:
        'Mac bridge is offline. Start the home laptop bridge before sending remote commands.',
    })
    return
  }

  const job =
    transcriptionJob?.type === 'plan' &&
    !transcriptionJob.result &&
    ['transcribing', 'transcribed'].includes(transcriptionJob.status)
      ? await store.updateJob(transcriptionJob.jobId, {
          command,
          status: 'queued',
          sessionId,
          inputTelemetry: {
            ...(transcriptionJob.inputTelemetry || {}),
            ...(inputTelemetry || {}),
          },
          createdBy: deviceId,
          error: null,
        })
      : createPlanJob({
          command,
          deviceId,
          sessionId,
          inputTelemetry,
        })
  if (job.jobId !== transcriptionJob?.jobId) {
    await store.createJob(job)
  }

  response.status(202).json({
    ok: true,
    job: publicJob(job),
  })
})

app.post('/v1/mac/execute', async (request, response) => {
  const command = String(request.body?.command ?? '').trim()
  const planJobId = String(request.body?.planJobId ?? '').trim()
  const deviceId = String(request.body?.deviceId ?? 'mobile').trim()
  const sessionId = String(request.body?.sessionId ?? '').trim() || null
  const actions = Array.isArray(request.body?.actions)
    ? request.body.actions
    : []
  if (!principalOwnsDevice(request.relayPrincipal, deviceId)) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: a device may only execute its own jobs.',
    })
    return
  }

  if (!actions.length) {
    response.status(400).json({
      ok: false,
      error: 'actions are required.',
    })
    return
  }

  const store = await getStore()
  const devices = await store.listDevices()
  const macBridge = devices.find((device) => device.deviceType === 'mac_bridge')

  if (!isDeviceOnline(macBridge)) {
    response.status(503).json({
      ok: false,
      error:
        'Mac bridge is offline. Start the home laptop bridge before executing remote commands.',
    })
    return
  }

  const job = createExecuteJob({
    command,
    actions,
    planJobId: planJobId || null,
    deviceId,
    sessionId,
  })
  await store.createJob(job)

  response.status(202).json({
    ok: true,
    job: publicJob(job),
  })
})

app.get('/v1/mac/jobs/:jobId', async (request, response) => {
  const store = await getStore()
  const job = await store.getJob(request.params.jobId)

  if (!job) {
    response.status(404).json({
      ok: false,
      error: 'Job not found.',
    })
    return
  }
  if (
    request.relayPrincipal?.kind === 'device' &&
    job.createdBy !== request.relayPrincipal.deviceId
  ) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: this job belongs to another device.',
    })
    return
  }

  response.json({
    ok: true,
    job: publicJob(job),
  })
})

app.get('/v1/ops/voice-runs', async (request, response) => {
  const store = await getStore()
  const requestedLimit = Math.min(
    Math.max(Number(request.query?.limit || 12), 1),
    40,
  )
  const [jobs, captures] = await Promise.all([
    store.listJobs({ type: 'plan', limit: 80 }),
    store.listJobs({ type: 'audio_capture', limit: 40 }),
  ])
  const runs = [
    ...jobs.map(voiceRunForJob),
    ...captures.map(voiceRunForCapture),
  ]
    .filter(Boolean)
    .sort(
      (left, right) =>
        new Date(right.createdAt || 0) - new Date(left.createdAt || 0),
    )
    .slice(0, requestedLimit)

  response.set('Cache-Control', 'no-store, max-age=0')
  response.json({
    ok: true,
    runs,
    observedAt: new Date().toISOString(),
  })
})

// Tiny freshness probe for fast dashboard polling: latest pendant run's
// identity only, so clients can poll cheaply and fetch the full list
// just when something changed.
app.get('/v1/ops/voice-runs/latest', async (_request, response) => {
  const store = await getStore()
  const [jobs, captures] = await Promise.all([
    store.listJobs({ type: 'plan', limit: 8 }),
    store.listJobs({ type: 'audio_capture', limit: 8 }),
  ])
  // Same membership rule as /v1/ops/voice-runs so the fast probe and the full
  // list can never disagree about which run is newest.
  const job = [...jobs, ...captures]
    .sort(
      (left, right) =>
        new Date(right.createdAt || 0) - new Date(left.createdAt || 0),
    )
    .find(
      (candidate) =>
        Boolean(voiceRunForJob(candidate)) ||
        Boolean(voiceRunForCapture(candidate)),
    )
  response.set('Cache-Control', 'no-store, max-age=0')
  response.json({
    ok: true,
    latest: job
      ? {
          pipelineId: job.jobId,
          status: job.status,
          updatedAt: job.updatedAt,
        }
      : null,
    observedAt: new Date().toISOString(),
  })
})

app.get('/v1/ops/audio-captures', async (request, response) => {
  const store = await getStore()
  const captures = await store.listJobs({
    type: 'audio_capture',
    limit: Math.min(Math.max(Number(request.query?.limit || 8), 1), 20),
  })

  response.set('Cache-Control', 'no-store')
  response.json({
    ok: true,
    // Additive since the last shape: `planJobId` links a recording back to its
    // run, and `audioDeletedAt` marks one that retention has already removed.
    captures: captures.map(audioCaptureSummary),
    retention: audioRetentionPolicy(),
  })
})

app.get('/v1/ops/audio-captures/:captureId/audio', async (request, response) => {
  const store = await getStore()
  const capture = await store.getJob(request.params.captureId)

  if (!capture || capture.type !== 'audio_capture') {
    response.status(404).json({
      ok: false,
      error: 'Audio capture not found.',
    })
    return
  }

  await streamCaptureAudio(request, response, { store, capture })
})

app.delete('/v1/ops/audio-captures/:captureId/audio', async (request, response) => {
  const store = await getStore()
  const capture = await store.getJob(request.params.captureId)

  if (!capture || capture.type !== 'audio_capture') {
    response.status(404).json({
      ok: false,
      error: 'Audio capture not found.',
    })
    return
  }

  await deleteCaptureAudio(request, response, { store, capture })
})

/*
 * Durable history.
 *
 * `plan` rows are pruned after JOB_TTL_MS (24h by default), so this list is a
 * recent-activity view rather than an archive. The `retention` block on every
 * response says so explicitly, because a history page that quietly forgets
 * yesterday is worse than one that admits its horizon.
 */
app.get('/v1/ops/history', async (request, response) => {
  const store = await getStore()
  const limit = normalizeHistoryLimit(request.query?.limit)
  const query = normalizeHistoryQuery(request.query?.q ?? request.query?.query)
  const cursor = decodeHistoryCursor(request.query?.cursor ?? request.query?.before)
  const origin = String(request.query?.origin || '')
    .trim()
    .toLowerCase()

  // voiceRunForJob() drops plan jobs the owner did not start, so read several
  // pages' worth of rows and let the filter thin them out.
  const scanLimit = Math.min(limit * HISTORY_OVERSCAN + 10, HISTORY_MAX_SCAN)
  const jobs = await store.listJobs({
    type: 'plan',
    limit: scanLimit,
    before: cursor,
    search: query || null,
  })

  // First page: anchor the capture window at NOW, not at the newest plan
  // job — a conversation that dispatched no Mac jobs stores a capture newer
  // than every job, which the job-anchored window silently excluded.
  // Cursored pages keep the job anchor so older pages don't re-serve the
  // newest captures.
  const captureAnchor = cursor
    ? await capturesNear(store, jobs)
    : await capturesNear(
        store,
        jobs.length
          ? [...jobs, { createdAt: new Date().toISOString() }]
          : [{ createdAt: new Date().toISOString() }],
      )

  const page = buildHistoryPage({
    jobs,
    captures: captureAnchor,
    limit,
    query,
    scanLimit,
  })
  const entries = origin
    ? page.entries.filter((entry) => entry.origin === origin)
    : page.entries

  response.set('Cache-Control', 'private, no-store')
  response.json({
    ok: true,
    entries,
    nextCursor: page.nextCursor,
    hasMore: page.hasMore,
    limit,
    query,
    retention: historyRetention(),
    observedAt: new Date().toISOString(),
  })
})

app.get('/v1/ops/history/:pipelineId', async (request, response) => {
  const detail = await loadRunDetail(request, response)
  if (!detail) return

  response.set('Cache-Control', 'private, no-store')
  response.json({
    ok: true,
    run: detail.run,
    retention: historyRetention(),
    observedAt: new Date().toISOString(),
  })
})

app.get('/v1/ops/history/:pipelineId/audio', async (request, response) => {
  const detail = await loadRunDetail(request, response)
  if (!detail) return

  let capture = detail.capture
  // ?voice=reply streams the AGENT's stored voice instead of the owner's.
  if (String(request.query?.voice || '') === 'reply') {
    const replyCaptureId = detail.capture?.replyCaptureId || null
    capture = replyCaptureId ? await detail.store.getJob(replyCaptureId) : null
    if (!capture || capture.type !== 'audio_capture') {
      response.status(404).json({
        ok: false,
        error: 'No agent reply audio is stored for this run.',
      })
      return
    }
  }
  if (!capture) {
    response.status(404).json({
      ok: false,
      error: 'No recording is stored for this run.',
    })
    return
  }

  await streamCaptureAudio(request, response, {
    store: detail.store,
    capture,
  })
})

app.delete('/v1/ops/history/:pipelineId/audio', async (request, response) => {
  const detail = await loadRunDetail(request, response)
  if (!detail) return

  if (!detail.capture) {
    response.status(404).json({
      ok: false,
      error: 'No recording is stored for this run.',
    })
    return
  }

  await deleteCaptureAudio(request, response, {
    store: detail.store,
    capture: detail.capture,
  })
})

// Same detail payload under the operator-feed name, so a dashboard that
// already speaks voice-runs can deep-link without learning a second shape.
app.get('/v1/ops/voice-runs/:pipelineId', async (request, response) => {
  if (request.params.pipelineId === 'latest') {
    response.status(404).json({ ok: false, error: 'Run not found.' })
    return
  }

  const detail = await loadRunDetail(request, response)
  if (!detail) return

  response.set('Cache-Control', 'private, no-store')
  response.json({
    ok: true,
    run: detail.run,
    observedAt: new Date().toISOString(),
  })
})

/*
 * What the agent remembers: the canonical product_memory_* tables plus the
 * sessions and turns behind them. Unlike /v1/ops/proxy this keeps working
 * while the Mac bridge is offline, because D1 is the system of record.
 */
app.get('/v1/ops/memory', async (request, response) => {
  const store = await getStore()
  const includeTurns = String(request.query?.includeTurns ?? 'true') !== 'false'
  const entityLimit = clampNumber(request.query?.entityLimit, 200, 1, 5000)
  const relationLimit = clampNumber(request.query?.relationLimit, 200, 1, 10000)
  const sessionLimit = clampNumber(request.query?.sessionLimit, 25, 1, 100)
  const turnLimit = clampNumber(request.query?.turnLimit, 40, 1, 200)
  const query = normalizeHistoryQuery(request.query?.q ?? request.query?.query)
  const needle = query.toLowerCase()

  let state
  try {
    state = await store.getProductState(PENDANT_ACCOUNT_ID)
  } catch (error) {
    response.status(400).json({
      ok: false,
      error: error.message || 'Memory could not be read.',
    })
    return
  }

  const visible = visibleProductSync(state)
  const matchesEntity = (entity) =>
    !needle ||
    `${entity.name || ''} ${entity.type || ''} ${JSON.stringify(
      entity.attributes || {},
    )}`
      .toLowerCase()
      .includes(needle)
  const entities = visible.memory.entities.filter(matchesEntity)
  const entityIds = new Set(entities.map((entity) => entity.id))
  const relations = visible.memory.relations.filter(
    (relation) =>
      !needle || entityIds.has(relation.from) || entityIds.has(relation.to),
  )

  const sessions = visible.sessions
    .filter(
      (session) =>
        !needle ||
        String(session.title || '').toLowerCase().includes(needle) ||
        session.turns.some((turn) =>
          String(turn.content || '').toLowerCase().includes(needle),
        ),
    )
    .sort((left, right) =>
      String(right.updatedAt || '').localeCompare(String(left.updatedAt || '')),
    )
    .slice(0, sessionLimit)
    .map((session) => ({
      sessionId: session.sessionId,
      title: session.title,
      createdAt: session.createdAt,
      updatedAt: session.updatedAt,
      sourceDeviceId: session.sourceDeviceId,
      turnCount: session.turns.length,
      // Newest turns are the useful ones, but a transcript reads forwards.
      turns: includeTurns ? session.turns.slice(-turnLimit) : [],
    }))

  response.set('Cache-Control', 'private, no-store')
  response.json({
    ok: true,
    accountId: visible.accountId,
    revision: visible.revision,
    generatedAt: visible.generatedAt,
    query,
    counts: {
      entities: visible.memory.entities.length,
      relations: visible.memory.relations.length,
      sessions: visible.sessions.length,
      turns: visible.sessions.reduce(
        (total, session) => total + session.turns.length,
        0,
      ),
      matchedEntities: entities.length,
      matchedRelations: relations.length,
      matchedSessions: sessions.length,
    },
    memory: {
      entities: entities.slice(0, entityLimit),
      relations: relations.slice(0, relationLimit),
    },
    sessions,
    limits: PRODUCT_SYNC_LIMITS,
    observedAt: new Date().toISOString(),
  })
})

app.get('/v1/ops/audio-retention', async (request, response) => {
  const store = await getStore()
  const maxAgeMs = normalizeMaxAgeMs(
    request.query?.maxAgeMs ?? AUDIO_RETENTION_MAX_AGE_MS,
  )
  const now = Date.now()
  const captures = await store.listJobs({ type: 'audio_capture', limit: 100 })
  const expired = selectExpiredAudioCaptures(captures, { now, maxAgeMs })

  response.set('Cache-Control', 'private, no-store')
  response.json({
    ok: true,
    policy: audioRetentionPolicy({ maxAgeMs, now }),
    scanned: captures.length,
    storedRecordings: captures.filter(hasStoredAudio).length,
    expiredCount: expired.length,
    expired: expired.map((capture) => ({
      captureId: capture.jobId,
      createdAt: capture.createdAt,
      expiresAt: audioCaptureExpiresAt(capture, { maxAgeMs }),
      audioBytes: capture.audioBytes ?? null,
      storage: capture.audioStorage || 'd1-base64',
    })),
    observedAt: new Date().toISOString(),
  })
})

/*
 * The sweep is inert unless BOTH the operator asks for it (dryRun:false) and
 * the deployment opts in (AUDIO_RETENTION_SWEEP_ENABLED=true). Anything else
 * returns the list of recordings it would have removed.
 */
app.post('/v1/ops/audio-retention/sweep', async (request, response) => {
  const store = await getStore()
  const maxAgeMs = normalizeMaxAgeMs(
    request.body?.maxAgeMs ?? AUDIO_RETENTION_MAX_AGE_MS,
  )
  const requestedDryRun = request.body?.dryRun !== false
  const mode = request.body?.mode === 'record' ? 'record' : 'audio'
  const dryRun = requestedDryRun || !AUDIO_RETENTION_SWEEP_ENABLED

  const report = await sweepExpiredAudio(store, {
    maxAgeMs,
    limit: clampNumber(request.body?.limit, 50, 1, 100),
    mode,
    dryRun,
  })

  response.set('Cache-Control', 'private, no-store')
  response.json({
    ok: true,
    ...report,
    requestedDryRun,
    blockedBySafetyFlag: !requestedDryRun && !AUDIO_RETENTION_SWEEP_ENABLED,
    ...(!requestedDryRun && !AUDIO_RETENTION_SWEEP_ENABLED
      ? {
          note:
            'Set AUDIO_RETENTION_SWEEP_ENABLED=true on the relay before a sweep may delete recordings.',
        }
      : {}),
    observedAt: new Date().toISOString(),
  })
})

app.post('/v1/pendant/jobs/:jobId/events', async (request, response) => {
  const jobId = String(request.params.jobId || '').trim()
  const stage = String(request.body?.stage || '').trim().toLowerCase()
  const status = normalizePipelineStatus(request.body?.status)
  const label = String(request.body?.label || stage)
    .trim()
    .slice(0, 160)
  const detail = String(request.body?.detail || '')
    .trim()
    .slice(0, 1000)

  if (!/^[a-z0-9_]{1,48}$/.test(stage)) {
    response.status(400).json({
      ok: false,
      error: 'A lowercase pipeline stage is required.',
    })
    return
  }

  const store = await getStore()
  const job = await store.getJob(jobId)
  if (!job) {
    response.status(404).json({
      ok: false,
      error: 'Job not found.',
    })
    return
  }

  const event = {
    eventId: `device_evt_${crypto.randomUUID()}`,
    stage,
    status,
    label: label || stage,
    detail,
    source: 'nrf9160',
    meta: sanitizeTelemetryMeta(request.body?.meta),
    at: new Date().toISOString(),
  }
  const deviceEvents = [
    ...(Array.isArray(job.deviceEvents) ? job.deviceEvents : []),
    event,
  ].slice(-32)
  await store.updateJob(jobId, { deviceEvents })

  // Reuse the authenticated bridge queue to deliver device telemetry to the
  // local dashboard. The nRF never needs direct access to the Mac.
  const proxy = createAgentProxyJob({
    method: 'POST',
    path: '/pipeline/events',
    body: {
      pipelineId: jobId,
      kind: job.type || 'voice_command',
      command: job.command || '',
      sessionId: job.sessionId ?? null,
      ...event,
    },
    deviceId: 'pendant-telemetry',
  })
  await store.createJob(proxy)

  response.status(202).json({
    ok: true,
    event,
  })
})

const OPS_PROXY_TIMEOUT_MS = 28_000
const OPS_ALLOWED_PREFIXES = [
  '/health',
  '/ops/',
  '/sessions',
  '/context-graph',
  '/jobs',
  '/thinking',
  '/pipeline',
  '/logs',
  '/machine-context',
]

app.post('/v1/ops/proxy', async (request, response) => {
  const method = String(request.body?.method || 'GET')
    .trim()
    .toUpperCase()
  const path = String(request.body?.path || '').trim()
  const body = request.body?.body ?? null
  const deviceId = String(request.body?.deviceId || 'ops-dashboard').trim()

  if (!path.startsWith('/')) {
    response.status(400).json({
      ok: false,
      error: 'path must start with /',
    })
    return
  }

  if (path.startsWith('/thinking/stream')) {
    response.status(400).json({
      ok: false,
      error: 'SSE thinking stream is not available over the relay. Use polling.',
    })
    return
  }

  if (!OPS_ALLOWED_PREFIXES.some((prefix) => path === prefix || path.startsWith(prefix))) {
    response.status(403).json({
      ok: false,
      error: `Blocked for safety: path not allowed for ops proxy (${path}).`,
    })
    return
  }

  const store = await getStore()
  const devices = await store.listDevices()
  const macBridge = devices.find((device) => device.deviceType === 'mac_bridge')

  if (!isDeviceOnline(macBridge)) {
    response.status(503).json({
      ok: false,
      error:
        'Mac bridge is offline. Start the home laptop bridge before opening the remote dashboard.',
    })
    return
  }

  const job = createAgentProxyJob({ method, path, body, deviceId })
  await store.createJob(job)

  // Dashboard snapshot should jump the queue — drop other ops proxy backlog.
  // Drop only stale backlog (older than 3s), never a peer request created at the same time.
  if (path === '/ops/snapshot' && typeof store.failQueuedAgentProxyJobs === 'function') {
    try {
      await store.failQueuedAgentProxyJobs(
        'Superseded by a newer dashboard snapshot request.',
        {
          exceptJobId: job.jobId,
          olderThan: new Date(Date.now() - 3000).toISOString(),
        },
      )
    } catch {
      // best-effort
    }
  }

  const deadline = Date.now() + OPS_PROXY_TIMEOUT_MS
  while (Date.now() < deadline) {
    const current = await store.getJob(job.jobId)
    if (current?.status === 'completed') {
      response.status(200).json(current.result ?? { ok: true })
      return
    }
    if (current?.status === 'failed') {
      response.status(502).json({
        ok: false,
        error: current.error || 'Mac agent proxy failed.',
        result: current.result ?? null,
      })
      return
    }
    await sleep(350)
  }

  response.status(504).json({
    ok: false,
    error: 'Timed out waiting for the home Mac bridge.',
    jobId: job.jobId,
  })
})

app.get('/v1/bridge/work', async (request, response) => {
  const deviceId = String(request.query.deviceId ?? '').trim()

  if (!deviceId) {
    response.status(400).json({
      ok: false,
      error: 'deviceId query parameter is required.',
    })
    return
  }
  if (!principalOwnsDevice(request.relayPrincipal, deviceId)) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: a bridge may only claim its own work.',
    })
    return
  }

  const store = await getStore()
  const deadline = Date.now() + BRIDGE_POLL_TIMEOUT_MS
  let emptyClaimCount = 0

  while (Date.now() < deadline) {
    const job = await store.claimNextJob(deviceId)

    if (job) {
      // Drop stale ops proxy jobs so a backlog cannot starve the dashboard.
      if (job.type === 'agent_proxy') {
        const ageMs = Date.now() - new Date(job.createdAt || 0).getTime()
        if (ageMs > 12_000) {
          await store.updateJob(job.jobId, {
            status: 'failed',
            error: 'Expired before the Mac bridge could run it.',
          })
          continue
        }
      }

      response.json({
        ok: true,
        work: {
          jobId: job.jobId,
          type: job.type,
          // Lets the bridge log queue-to-claim age per job.
          createdAt: job.createdAt ?? null,
          command: job.command,
          actions: job.actions,
          sessionId: job.sessionId ?? null,
          inputTelemetry: job.inputTelemetry ?? null,
          // Multimodal audio→plan on the relay; bridge may skip a second LLM.
          plannerHint: job.plannerHint ?? null,
          method: job.method ?? null,
          path: job.path ?? null,
          body: job.body ?? null,
        },
      })
      return
    }

    // Yield only when the queue is empty. When a job exists, claim returns
    // immediately (no intentional product delay).
    const delayMs = bridgeClaimDelay(emptyClaimCount, {
      minimumMs: BRIDGE_CLAIM_MIN_INTERVAL_MS,
      maximumMs: BRIDGE_CLAIM_MAX_INTERVAL_MS,
    })
    if (delayMs > 0) {
      await sleep(delayMs)
    }
    emptyClaimCount += 1
  }

  response.status(204).end()
})

app.post('/v1/bridge/work/:jobId/result', async (request, response) => {
  const jobId = request.params.jobId
  const ok = Boolean(request.body?.ok)
  const result = request.body?.result ?? null
  const error = String(request.body?.error ?? '').trim()
  // Partial = Mac already ran the action; TTS/speech may still be rendering.
  // Keeps status=processing so a final completeWork can attach pendantSpeech.
  const partial = Boolean(request.body?.partial)
  const store = await getStore()
  const job = await store.getJob(jobId)

  if (!job) {
    response.status(404).json({
      ok: false,
      error: 'Job not found.',
    })
    return
  }
  if (
    request.relayPrincipal?.kind === 'device' &&
    job.claimedBy !== request.relayPrincipal.deviceId
  ) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: this work was claimed by another bridge.',
    })
    return
  }

  // Final success may arrive after a partial progress report (still processing).
  // Failures and partials must still be on a live processing job.
  const allowFinalAfterPartial =
    !partial &&
    ok &&
    job.status === 'processing' &&
    job.result &&
    typeof job.result === 'object'
  if (job.status !== 'processing' && !allowFinalAfterPartial) {
    response.status(409).json({
      ok: false,
      error: `Job is not processing (current status: ${job.status}).`,
    })
    return
  }

  if (!ok) {
    const failed = await store.updateJob(jobId, {
      status: 'failed',
      error: error || 'Mac bridge reported failure.',
      result,
    })

    response.json({
      ok: true,
      job: publicJob(failed),
    })
    return
  }

  if (partial) {
    const mergedResult =
      result && typeof result === 'object'
        ? {
            ...(job.result && typeof job.result === 'object' ? job.result : {}),
            ...result,
            // Explicit so the dashboard can flip to "Done" before TTS finishes.
            executed: result.executed !== false,
            phase: result.phase || 'executed',
          }
        : job.result
    const updated = await store.updateJob(jobId, {
      status: 'processing',
      result: mergedResult,
      error: null,
      actions:
        job.type === 'plan'
          ? mergedResult?.actions ?? job.actions ?? []
          : job.actions,
    })
    response.json({
      ok: true,
      partial: true,
      job: publicJob(updated),
    })
    return
  }

  const nextStatus =
    job.type === 'plan' ? 'plan_ready' : 'completed'

  const updated = await store.updateJob(jobId, {
    status: nextStatus,
    result,
    error: null,
    actions: job.type === 'plan' ? result?.actions ?? [] : job.actions,
  })

  response.json({
    ok: true,
    job: publicJob(updated),
  })
})

app.listen(PORT, '0.0.0.0', () => {
  console.log(`AI Pendant Cloud Relay listening on http://0.0.0.0:${PORT}`)
  console.log('[relay] Store mode: Cloudflare D1 in Workers, memory locally')
})

function normalizePipelineStatus(value) {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'active' || status === 'processing') return 'active'
  if (status === 'failed' || status === 'error') return 'failed'
  if (status === 'waiting' || status === 'queued') return 'waiting'
  return 'done'
}

function sanitizeTelemetryMeta(value) {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return {}
  }

  const result = {}
  for (const [rawKey, rawValue] of Object.entries(value).slice(0, 32)) {
    const key = String(rawKey || '').slice(0, 80)
    if (
      !key ||
      /base64|authorization|api.?key|token|secret|password/i.test(key)
    ) {
      continue
    }
    if (
      typeof rawValue === 'number' ||
      typeof rawValue === 'boolean'
    ) {
      result[key] = rawValue
    } else if (typeof rawValue === 'string') {
      result[key] = rawValue.slice(0, 240)
    }
  }
  return result
}

function spokenTextForJob(job) {
  const result = job?.result && typeof job.result === 'object'
    ? job.result
    : {}
  const direct = [
    result.response,
    result.summary,
    result.message,
    typeof result.result === 'string' ? result.result : '',
  ]
    .map((value) => String(value || '').replace(/\s+/g, ' ').trim())
    .find(Boolean)

  if (direct) {
    return direct.slice(0, 800)
  }

  const actions = Array.isArray(result.actions)
    ? result.actions
    : Array.isArray(job?.actions)
      ? job.actions
      : []
  const labels = actions
    .map((action) => String(action?.label || action?.type || '').trim())
    .filter(Boolean)

  if (labels.length) {
    const needsConfirmation = actions.some(
      (action) => action?.requiresConfirmation,
    )
    return `${needsConfirmation ? 'Ready for confirmation: ' : ''}${labels.join(
      ', ',
    )}.`.slice(0, 800)
  }

  return job?.status === 'completed' ? 'Done.' : ''
}

function sendPendantAudio(response, result) {
  response.set({
    'Content-Type': result.mimeType || 'audio/pcm',
    'Content-Length': String(result.audio.length),
    'Cache-Control': 'no-store',
    'X-Audio-Format': result.format || 's16le',
    'X-Audio-Sample-Rate': String(PENDANT_PCM_SAMPLE_RATE),
    'X-Audio-Channels': String(PENDANT_PCM_CHANNELS),
    'X-Audio-Bits': String(PENDANT_PCM_BITS),
  })
  response.status(200).send(result.audio)
}

function pendantSpeechForJob(job) {
  const speech = job?.result?.pendantSpeech
  const audioBase64 = String(speech?.audioBase64 || '').trim()

  if (
    !audioBase64 ||
    String(speech?.format || '').toLowerCase() !== 's16le' ||
    Number(speech?.sampleRate || 0) !== PENDANT_PCM_SAMPLE_RATE ||
    Number(speech?.channels || 0) !== PENDANT_PCM_CHANNELS ||
    Number(speech?.bitsPerSample || 0) !== PENDANT_PCM_BITS
  ) {
    return null
  }

  const compressedAudioBase64 = String(
    speech?.compressedAudioBase64 || '',
  ).trim()
  if (
    compressedAudioBase64 &&
    String(speech?.compressedFormat || '').toLowerCase() === 'ogg-opus'
  ) {
    const compressedAudio = Buffer.from(compressedAudioBase64, 'base64')
    if (
      compressedAudio.length >= 64 &&
      compressedAudio.toString('ascii', 0, 4) === 'OggS'
    ) {
      return {
        audio: compressedAudio,
        mimeType: 'audio/ogg',
        format: 'ogg-opus',
      }
    }
  }

  const audio = Buffer.from(audioBase64, 'base64')
  if (!audio.length || audio.length % 2 !== 0) {
    return null
  }

  return {
    audio,
    mimeType: 'audio/pcm',
    format: 's16le',
  }
}

function isDeviceOnline(device) {
  if (!device?.lastSeenAt) {
    return false
  }

  const lastSeen = new Date(device.lastSeenAt).getTime()
  return Date.now() - lastSeen < 90_000
}

function normalizeStateKey(value) {
  const stateKey = String(value || '').trim().toLowerCase()
  return /^[a-z0-9][a-z0-9-]{0,63}$/.test(stateKey) ? stateKey : ''
}

function clampNumber(value, fallback, min, max) {
  const parsed = Number(value)
  if (!Number.isFinite(parsed)) {
    return fallback
  }
  return Math.min(Math.max(Math.floor(parsed), min), max)
}

function historyRetention() {
  return {
    // Every /v1/ops/history response repeats this so the dashboard can tell
    // the owner why last week's runs are missing.
    runsTtlMs: JOB_TTL_MS,
    runsOldestVisibleAt: new Date(Date.now() - JOB_TTL_MS).toISOString(),
    runsNote:
      'Relay run records are pruned after JOB_TTL_MS. Recordings, transcripts, and product turns outlive them.',
    audio: audioRetentionPolicy(),
  }
}

/**
 * Recordings are written moments before or after their plan job, so a window
 * around the page is enough to resolve every link on it.
 */
async function capturesNear(store, jobs, { window = 5 * 60_000, limit = 100 } = {}) {
  if (!jobs.length) {
    return []
  }

  const newest = jobs.reduce((latest, job) => {
    const time = new Date(job?.createdAt || 0).getTime()
    return Number.isFinite(time) && time > latest ? time : latest
  }, 0)
  if (!newest) {
    return []
  }

  return store.listJobs({
    type: 'audio_capture',
    limit,
    before: { createdAt: new Date(newest + window).toISOString() },
  })
}

async function resolveRunCapture(store, job) {
  const declared = String(job?.inputTelemetry?.captureId || '').trim()
  if (declared) {
    const capture = await store.getJob(declared)
    if (capture?.type === 'audio_capture') {
      return { capture, link: 'telemetry' }
    }
  }

  const captures = await capturesNear(store, [job], { limit: 60 })
  return linkAudioCaptures([job], captures).get(job.jobId) || { capture: null, link: null }
}

/**
 * A device token can never reach /v1/ops/* today (those routes demand the
 * admin scope), but ownership is asserted here as well so that widening the
 * scope table later cannot silently hand one device another device's audio.
 */
function principalCanReadJob(principal, job) {
  return (
    principal?.kind !== 'device' || principalOwnsDevice(principal, job?.createdBy)
  )
}

/**
 * Shared front half of every run-scoped route: resolve the run, enforce
 * ownership, and attach its recording. Responds and returns null on failure.
 */
async function loadRunDetail(request, response) {
  const store = await getStore()
  const job = await store.getJob(String(request.params.pipelineId || '').trim())

  // Conversational presses: the audio_capture IS the run (no plan job).
  if (job && job.type === 'audio_capture' && job.role !== 'reply') {
    const run = voiceRunForCapture(job)

    if (!run) {
      response.status(404).json({ ok: false, error: 'Run not found.' })
      return null
    }
    return { store, job, capture: job, link: 'self', run }
  }

  if (!job || job.type !== 'plan') {
    response.status(404).json({
      ok: false,
      error: 'Run not found. Relay run records expire after JOB_TTL_MS.',
    })
    return null
  }
  if (!principalCanReadJob(request.relayPrincipal, job)) {
    response.status(403).json({
      ok: false,
      error: 'Blocked for safety: this run belongs to another device.',
    })
    return null
  }

  const { capture, link } = await resolveRunCapture(store, job)
  const run = runDetailForJob(job, { capture, link })
  if (!run) {
    response.status(404).json({
      ok: false,
      error: 'That job is not an owner-initiated run.',
    })
    return null
  }

  return { store, job, capture, link, run }
}

/**
 * Stream a private recording. Range support is byte-slicing over an already
 * buffered object rather than a ranged R2 read, which is enough for <audio>
 * scrubbing on captures measured in kilobytes.
 */
async function streamCaptureAudio(request, response, { capture }) {
  const storedAudio = await loadAudioCapture(capture)
  if (!storedAudio) {
    response.set('Cache-Control', 'private, no-store')
    response.status(404).json({
      ok: false,
      error:
        capture.audioStorage === 'deleted'
          ? 'This recording was deleted.'
          : 'Audio capture data was not found.',
    })
    return
  }

  const total = storedAudio.audio.length
  response.set('Cache-Control', 'private, no-store')
  response.set('Content-Type', storedAudio.contentType)
  response.set('Accept-Ranges', 'bytes')
  response.set('X-Audio-Storage', storedAudio.source)
  response.set('X-Cloud-Transcript', encodeURIComponent(capture.transcript || ''))
  response.set('X-Cloud-Model', capture.transcriptionModel || '')

  const range = parseByteRange(request.get('range'), total)
  if (range === RANGE_UNSATISFIABLE) {
    response.set('Content-Range', `bytes */${total}`)
    response.status(416).end()
    return
  }

  if (range) {
    const slice = storedAudio.audio.subarray(range.start, range.end + 1)
    response.set('Content-Range', `bytes ${range.start}-${range.end}/${total}`)
    response.set('Content-Length', String(slice.length))
    response.status(206).send(slice)
    return
  }

  response.set('Content-Length', String(total))
  response.send(storedAudio.audio)
}

async function deleteCaptureAudio(request, response, { store, capture }) {
  const mode = request.query?.mode === 'record' ? 'record' : 'audio'

  try {
    const report = await deleteStoredAudio(store, capture, {
      mode,
      reason: 'operator',
    })
    response.set('Cache-Control', 'private, no-store')
    response.json({
      ok: true,
      deleted: report,
      policy: audioRetentionPolicy(),
    })
  } catch (error) {
    response.status(500).json({
      ok: false,
      error: error?.message || 'The recording could not be deleted.',
    })
  }
}

function requiredScopesForRequest(request) {
  const method = request.method.toUpperCase()
  const path = request.path

  if (method === 'POST' && path === '/v1/devices/register') return ['admin']
  if (method === 'POST' && path === '/v1/devices/heartbeat') {
    return ['device:heartbeat:self']
  }
  if (method === 'GET' && path === '/v1/devices/status') {
    return ['device:status:read']
  }
  if (
    method === 'GET' &&
    /^\/v1\/product\/state\/[^/]+$/.test(path)
  ) {
    return ['product:read']
  }
  if (method === 'PUT' && path === '/v1/product/state') {
    return ['product:write']
  }
  if (method === 'GET' && path.startsWith('/v1/state/')) {
    return ['state:read']
  }
  if (method === 'PUT' && path.startsWith('/v1/state/')) {
    return ['state:write']
  }
  if (method === 'POST' && path === '/v1/pendant/announce') {
    return ['pendant:announce']
  }
  if (method === 'POST' && path === '/v1/transcribe') {
    return ['speech:transcribe']
  }
  if (method === 'POST' && path === '/v1/pendant/command') {
    return ['pendant:audio:upload']
  }
  if (method === 'POST' && path === '/v1/speak') {
    return ['speech:synthesize']
  }
  if (
    (method === 'POST' && path === '/v1/pendant/speak') ||
    (method === 'GET' &&
      /^\/v1\/pendant\/jobs\/[^/]+\/speech$/.test(path))
  ) {
    return ['pendant:speech:read']
  }
  if (method === 'POST' && path === '/v1/mac/plan') return ['mac:plan']
  if (method === 'POST' && path === '/v1/mac/execute') return ['mac:execute']
  if (method === 'GET' && /^\/v1\/mac\/jobs\/[^/]+$/.test(path)) {
    return ['mac:jobs:read']
  }
  if (path.startsWith('/v1/ops/')) return ['admin']
  if (
    method === 'POST' &&
    /^\/v1\/pendant\/jobs\/[^/]+\/events$/.test(path)
  ) {
    return ['pendant:event:write']
  }
  if (method === 'GET' && path === '/v1/bridge/work') {
    return ['bridge:work:claim']
  }
  if (
    method === 'POST' &&
    /^\/v1\/bridge\/work\/[^/]+\/result$/.test(path)
  ) {
    return ['bridge:work:complete']
  }

  return null
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

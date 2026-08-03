import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import {
  AUDIO_NATIVE_PLANNER,
  AUDIO_RETENTION_MAX_AGE_MS,
  AUDIO_RETENTION_SWEEP_ENABLED,
  BRIDGE_POLL_TIMEOUT_MS,
  JOB_TTL_MS,
  LLM_API_KEY,
  PAIRING_CODE,
  PENDANT_ACCOUNT_ID,
  PORT,
  RELAY_API_KEY,
  STT_MODEL,
  TTS_MODEL,
  TTS_VOICE,
} from './config.js'
import {
  createAudioCapture,
  createAgentProxyJob,
  createExecuteJob,
  createPlanJob,
  publicJob,
  voiceRunForJob,
} from './jobs.js'
import { getStore } from './store/index.js'
import { planFromAudio } from './audioPlan.js'
import { transcribeAudio } from './transcribe.js'
import { synthesizeSpeech } from './speak.js'
import { getCloudflareBindings } from './cloudflareBindings.js'
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

const app = express()
const pendantAudioParser = express.raw({
  type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'],
  limit: '12mb',
})
const PENDANT_PCM_SAMPLE_RATE = 24000
const PENDANT_PCM_CHANNELS = 1
const PENDANT_PCM_BITS = 16
const DIAGNOSTIC_AUDIO_MAX_BYTES = 1024 * 1024
const DIAGNOSTIC_AUDIO_R2_MAX_BYTES = 8 * 1024 * 1024

/**
 * Prefer multimodal audio→plan when configured; fall back to Whisper STT.
 * Returns a transcript-shaped object plus optional plannerHint for plan jobs.
 */
async function resolveAudioTranscript({ audioBase64, format, language }) {
  if (AUDIO_NATIVE_PLANNER && LLM_API_KEY) {
    try {
      const plan = await planFromAudio({ audioBase64, format, language })
      const hasPlanPayload =
        (Array.isArray(plan.actions) && plan.actions.length > 0) ||
        Boolean(plan.status) ||
        Boolean(plan.response)

      return {
        text: plan.text,
        model: plan.model,
        language: plan.language,
        durationMs: plan.durationMs,
        source: plan.source,
        plannerHint: hasPlanPayload
          ? {
              status: plan.status,
              response: plan.response,
              actions: plan.actions || [],
              planner: 'audio-native',
            }
          : undefined,
      }
    } catch (error) {
      console.warn(
        `[relay] Audio-native planner failed; falling back to STT: ${
          error?.message || error
        }`,
      )
    }
  }

  const startedAt = Date.now()
  const result = await transcribeAudio({ audioBase64, format, language })
  return {
    text: result.text,
    model: result.model,
    language: result.language,
    durationMs: Date.now() - startedAt,
    source: 'stt',
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
    speechToTextConfigured: Boolean(cloudflareBindings?.AI || LLM_API_KEY),
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
      speechToText: cloudflareBindings?.AI
        ? '@cf/openai/whisper-large-v3-turbo'
        : STT_MODEL,
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
         * Persist the raw recording before starting speech-to-text. The Mac
         * capture watcher can now download it while Whisper is still running.
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
 * Embedded pendants can stream a WAV file directly from storage instead of
 * first allocating a Base64 JSON document. The relay performs the Base64
 * conversion required by the upstream speech-to-text API and, by default,
 * queues the resulting transcript for the Mac bridge.
 *
 * Headers:
 *   Content-Type: audio/wav
 *   Authorization: Bearer <RELAY_API_KEY>
 *   X-Device-Id, X-Session-Id, X-Language (all optional)
 *
 * Add ?dispatch=0 to transcribe without queueing a Mac command.
 */
app.post(
  '/v1/pendant/command',
  pendantAudioParser,
  async (request, response) => {
    try {
      const audio = Buffer.isBuffer(request.body)
        ? request.body
        : Buffer.alloc(0)

      if (!audio.length) {
        response.status(400).json({
          ok: false,
          error: 'Raw audio body is required.',
        })
        return
      }

      const format =
        String(request.get('x-audio-format') || 'wav')
          .trim()
          .toLowerCase() || 'wav'
      const language = String(request.get('x-language') || '').trim() || null
      const deviceId =
        String(request.get('x-device-id') || 'nrf9160-pendant').trim() ||
        'nrf9160-pendant'
      if (!principalOwnsDevice(request.relayPrincipal, deviceId)) {
        response.status(403).json({
          ok: false,
          error:
            'Blocked for safety: a device may only upload its own commands.',
        })
        return
      }
      const sessionId =
        String(request.get('x-session-id') || '').trim() || null
      const shouldDispatch = String(request.query?.dispatch ?? '1') !== '0'
      const audioBase64 = audio.toString('base64')

      const transcript = await resolveAudioTranscript({
        audioBase64,
        format,
        language,
      })
      const transcriptionDurationMs = transcript.durationMs

      let job = null
      let capture = null
      let macBridgeOnline = false
      const store = await getStore()

      // Persist a diagnostic capture when the raw upload fits the same limits
      // as /v1/transcribe so ops history can replay pendant audio.
      const r2AudioEnabled = Boolean(getCloudflareBindings()?.AUDIO_BUCKET?.put)
      const diagnosticAudioLimit = r2AudioEnabled
        ? DIAGNOSTIC_AUDIO_R2_MAX_BYTES
        : DIAGNOSTIC_AUDIO_MAX_BYTES
      if (audio.length > 0 && audio.length <= diagnosticAudioLimit) {
        try {
          capture = createAudioCapture({
            audioBase64,
            audioBytes: audio.length,
            format,
            language,
            transcript: transcript.text,
            transcriptionModel: transcript.model,
            status: 'completed',
          })
          const persistedAudio = await persistAudioCapture({
            captureId: capture.jobId,
            audioBase64,
            audioBytes: audio.length,
            format,
            createdAt: capture.createdAt,
            allowD1Fallback: audio.length <= DIAGNOSTIC_AUDIO_MAX_BYTES,
          })
          if (persistedAudio.audioStorage === 'unavailable') {
            capture = null
          } else {
            capture = { ...capture, ...persistedAudio }
            await store.createJob(capture)
          }
        } catch (error) {
          console.warn(
            `[relay] Pendant audio capture not stored: ${
              error?.message || error
            }`,
          )
          if (capture) {
            await deleteAudioCaptureObject(capture).catch(() => {})
          }
          capture = null
        }
      }

      if (shouldDispatch) {
        const devices = await store.listDevices()
        const macBridge = devices.find(
          (device) => device.deviceType === 'mac_bridge',
        )
        macBridgeOnline = isDeviceOnline(macBridge)

        if (macBridgeOnline) {
          const sampleRateHeader = Number(
            request.get('x-sample-rate') || PENDANT_PCM_SAMPLE_RATE,
          )
          const inputTelemetry = {
            audioBytes: audio.length,
            format: format === 'ogg' ? 'ogg-opus' : format,
            sampleRate: Number.isFinite(sampleRateHeader)
              ? sampleRateHeader
              : PENDANT_PCM_SAMPLE_RATE,
            channels: PENDANT_PCM_CHANNELS,
            bitsPerSample: PENDANT_PCM_BITS,
            // voiceRunForJob only surfaces microSD/dashboard origins.
            storage: 'microSD',
            uploadState: 'uploaded',
            uploadedFormat: format === 'ogg' ? 'ogg' : format,
            transcriptionModel: transcript.model,
            transcriptionLanguage: transcript.language,
            transcriptionDurationMs,
            transcriptionSource: transcript.source || 'stt',
            ...(capture ? { captureId: capture.jobId } : {}),
          }
          job = createPlanJob({
            command: transcript.text,
            deviceId,
            sessionId,
            inputTelemetry,
          })
          if (transcript.plannerHint) {
            job.plannerHint = transcript.plannerHint
          }
          await store.createJob(job)

          if (capture) {
            capture =
              (await store.updateJob(capture.jobId, {
                planJobId: job.jobId,
              })) || capture
          }
        }
      }

      response.status(job ? 202 : 200).json({
        ok: true,
        text: transcript.text,
        model: transcript.model,
        language: transcript.language,
        durationMs: transcriptionDurationMs,
        source: transcript.source || 'stt',
        plannerHint: transcript.plannerHint,
        audioBytes: audio.length,
        captureId: capture?.jobId ?? null,
        dispatchRequested: shouldDispatch,
        macBridgeOnline,
        queued: Boolean(job),
        job: publicJob(job),
      })
    } catch (error) {
      response
        .status(error.message.includes('not configured') ? 503 : 400)
        .json({
          ok: false,
          error: error.message || 'Pendant audio upload failed.',
        })
    }
  },
)

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
  const jobs = await store.listJobs({ type: 'plan', limit: 80 })
  const runs = jobs
    .map(voiceRunForJob)
    .filter(Boolean)
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
  const jobs = await store.listJobs({ type: 'plan', limit: 8 })
  // Same membership rule as /v1/ops/voice-runs so the fast probe and the full
  // list can never disagree about which run is newest.
  const job = jobs.find((candidate) => Boolean(voiceRunForJob(candidate)))
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

  const page = buildHistoryPage({
    jobs,
    captures: await capturesNear(store, jobs),
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

  if (!detail.capture) {
    response.status(404).json({
      ok: false,
      error: 'No recording is stored for this run.',
    })
    return
  }

  await streamCaptureAudio(request, response, {
    store: detail.store,
    capture: detail.capture,
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

    // Every millisecond here lands directly in the voice-command latency the
    // owner feels, so poll tightly rather than politely.
    await sleep(50)
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

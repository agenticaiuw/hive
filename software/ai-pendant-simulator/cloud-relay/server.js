import crypto from 'node:crypto'
import express from 'express'
import cors from 'cors'
import {
  BRIDGE_POLL_TIMEOUT_MS,
  LLM_API_KEY,
  PAIRING_CODE,
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
import { transcribeAudio } from './transcribe.js'
import { synthesizeSpeech } from './speak.js'
import { getCloudflareBindings } from './cloudflareBindings.js'

const app = express()
const pendantAudioParser = express.raw({
  type: ['audio/wav', 'audio/x-wav', 'application/octet-stream'],
  limit: '12mb',
})
const PENDANT_PCM_SAMPLE_RATE = 24000
const PENDANT_PCM_CHANNELS = 1
const PENDANT_PCM_BITS = 16
const DIAGNOSTIC_AUDIO_MAX_BYTES = 1024 * 1024

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

app.use((request, response, next) => {
  if (!RELAY_API_KEY) {
    response.status(503).json({
      ok: false,
      error:
        'Blocked for safety: RELAY_API_KEY is not configured on the cloud relay.',
    })
    return
  }

  const authorization = request.get('authorization') ?? ''
  const token = authorization.replace(/^Bearer\s+/i, '')

  if (token !== RELAY_API_KEY) {
    response.status(401).json({
      ok: false,
      error: 'Blocked for safety: invalid or missing relay API key.',
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

app.post('/v1/pendant/announce', async (request, response) => {
  // Creates a visible pending job the moment the pendant stops recording,
  // seconds before the audio upload itself completes.
  const deviceId =
    String(request.body?.deviceId || 'nrf9160-pendant').trim() ||
    'nrf9160-pendant'
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

      if (audioBytes <= DIAGNOSTIC_AUDIO_MAX_BYTES) {
        capture = createAudioCapture({
          audioBase64,
          audioBytes,
          format: String(request.body?.format || 'wav'),
          language: request.body?.language || null,
          transcript: null,
          transcriptionModel: null,
          status: 'received',
        })
        /*
         * Persist the raw recording before starting speech-to-text. The Mac
         * capture watcher can now download it while Whisper is still running.
         */
        await store.createJob(capture)
      }
    }

    const transcriptionStartedAt = Date.now()
    const result = await transcribeAudio({
      audioBase64,
      format: request.body?.format,
      language: request.body?.language,
    })
    const transcriptionDurationMs = Date.now() - transcriptionStartedAt

    if (transcriptionJob) {
      transcriptionJob = await store.updateJob(transcriptionJob.jobId, {
        command: result.text,
        status: 'transcribed',
        inputTelemetry: {
          ...transcriptionJob.inputTelemetry,
          transcriptionModel: result.model,
          transcriptionLanguage: result.language,
          transcriptionDurationMs,
        },
      })
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
      ...result,
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
      const sessionId =
        String(request.get('x-session-id') || '').trim() || null
      const shouldDispatch = String(request.query?.dispatch ?? '1') !== '0'

      const transcriptionStartedAt = Date.now()
      const transcript = await transcribeAudio({
        audioBase64: audio.toString('base64'),
        format,
        language,
      })
      const transcriptionDurationMs = Date.now() - transcriptionStartedAt

      let job = null
      let macBridgeOnline = false

      if (shouldDispatch) {
        const store = await getStore()
        const devices = await store.listDevices()
        const macBridge = devices.find(
          (device) => device.deviceType === 'mac_bridge',
        )
        macBridgeOnline = isDeviceOnline(macBridge)

        if (macBridgeOnline) {
          job = createPlanJob({
            command: transcript.text,
            deviceId,
            sessionId,
            inputTelemetry: {
              audioBytes: audio.length,
              format,
              sampleRate: PENDANT_PCM_SAMPLE_RATE,
              channels: PENDANT_PCM_CHANNELS,
              bitsPerSample: PENDANT_PCM_BITS,
              transcriptionModel: transcript.model,
              transcriptionLanguage: transcript.language,
              transcriptionDurationMs,
            },
          })
          await store.createJob(job)
        }
      }

      response.status(job ? 202 : 200).json({
        ok: true,
        ...transcript,
        audioBytes: audio.length,
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
  const job = jobs.find(
    (candidate) =>
      String(candidate?.inputTelemetry?.storage || '').toLowerCase() ===
      'microsd',
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
    captures: captures.map((capture) => ({
      captureId: capture.jobId,
      audioBytes: capture.audioBytes,
      format: capture.format,
      language: capture.language,
      cloudTranscript: capture.transcript,
      cloudModel: capture.transcriptionModel,
      status: capture.status,
      createdAt: capture.createdAt,
    })),
  })
})

app.get('/v1/ops/audio-captures/:captureId/audio', async (request, response) => {
  const store = await getStore()
  const capture = await store.getJob(request.params.captureId)

  if (!capture || capture.type !== 'audio_capture' || !capture.audioBase64) {
    response.status(404).json({
      ok: false,
      error: 'Audio capture not found.',
    })
    return
  }

  const audio = Buffer.from(capture.audioBase64, 'base64')
  response.set('Cache-Control', 'no-store')
  response.set(
    'Content-Type',
    ['ogg', 'opus', 'ogg-opus'].includes(
      String(capture.format || '').toLowerCase(),
    )
      ? 'audio/ogg'
      : String(capture.format || '').toLowerCase() === 'wav'
        ? 'audio/wav'
        : 'application/octet-stream',
  )
  response.set('Content-Length', String(audio.length))
  response.set('X-Cloud-Transcript', encodeURIComponent(capture.transcript || ''))
  response.set('X-Cloud-Model', capture.transcriptionModel || '')
  response.send(audio)
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
          method: job.method ?? null,
          path: job.path ?? null,
          body: job.body ?? null,
        },
      })
      return
    }

    await sleep(800)
  }

  response.status(204).end()
})

app.post('/v1/bridge/work/:jobId/result', async (request, response) => {
  const jobId = request.params.jobId
  const ok = Boolean(request.body?.ok)
  const result = request.body?.result ?? null
  const error = String(request.body?.error ?? '').trim()
  const store = await getStore()
  const job = await store.getJob(jobId)

  if (!job) {
    response.status(404).json({
      ok: false,
      error: 'Job not found.',
    })
    return
  }

  if (job.status !== 'processing') {
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

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

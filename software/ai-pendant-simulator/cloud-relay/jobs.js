import crypto from 'node:crypto'

export function createJobId() {
  return `job_${crypto.randomUUID()}`
}

export function createAudioCapture({
  audioBase64,
  audioBytes,
  format,
  language,
  transcript,
  transcriptionModel,
  status = 'completed',
}) {
  const now = new Date().toISOString()

  return {
    jobId: createJobId(),
    type: 'audio_capture',
    status,
    audioBase64,
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
}) {
  const now = new Date().toISOString()

  return {
    jobId: jobId ?? createJobId(),
    type: 'plan',
    status,
    command,
    sessionId: sessionId ?? null,
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
    deviceEvents: Array.isArray(job.deviceEvents)
      ? job.deviceEvents.slice(-32)
      : [],
    result: job.result,
    error: job.error,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

export function voiceRunForJob(job) {
  if (!job || job.type !== 'plan') return null
  const telemetry = job.inputTelemetry
  if (String(telemetry?.storage || '').toLowerCase() !== 'microsd') return null

  const events = []
  const hasTranscript = /[\p{L}\p{N}]/u.test(String(job.command || ''))
  const transcriptionPending = job.status === 'transcribing'
  events.push({
    eventId: `cloud-${job.jobId}-transcription`,
    stage: 'transcription',
    status: transcriptionPending ? 'active' : hasTranscript ? 'done' : 'failed',
    label: transcriptionPending
      ? 'Recording received; transcription running'
      : hasTranscript
        ? 'Transcript received from cloud'
        : 'Speech was not recognized',
    detail: transcriptionPending
      ? 'Cloudflare received the pendant recording and is transcribing it now.'
      : hasTranscript
        ? 'Speech-to-text completed before this job reached the Mac bridge.'
        : job.error || 'Audio arrived, but speech-to-text did not return words.',
    text: String(job.command || ''),
    source: 'cloudflare',
    meta: { inputTelemetry: telemetry },
    at: job.createdAt,
  })

  const result = job.result && typeof job.result === 'object' ? job.result : null
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
      status: 'done',
      label: actionText ? 'Mac action selected' : 'Agent response ready',
      detail: actionText
        ? 'The Mac agent produced this action plan from the transcript.'
        : 'The Mac agent completed this request.',
      text: agentText,
      source: 'mac-bridge',
      meta: {
        planner: result.planner || null,
        thinkingTraceId: result.thinking?.traceId || null,
        actions: Array.isArray(result.actions) ? result.actions : [],
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
    }

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

  const playbackDone = events.some(
    (event) => event.stage === 'device_playback' && event.status === 'done',
  )
  const status = ['failed', 'cancelled'].includes(job.status)
    ? 'failed'
    : playbackDone
      ? 'completed'
      : 'processing'

  return {
    pipelineId: job.jobId,
    kind: 'voice_command',
    command: String(job.command || ''),
    source: 'cloudflare',
    status,
    events,
    createdAt: job.createdAt,
    updatedAt: job.updatedAt,
  }
}

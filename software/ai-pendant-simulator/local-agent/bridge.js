import {
  AGENT_TOKEN,
  BRIDGE_DEVICE_ID,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_AGENT_URL,
  PAIRING_CODE,
  RELAY_API_KEY,
  RELAY_URL,
  WORK_POLL_INTERVAL_MS,
} from './bridgeConfig.js'
import {
  spokenTextForResult,
  synthesizePendantSpeech,
} from './pendantSpeech.js'

const relayHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${RELAY_API_KEY}`,
}

let running = false

export async function startBridge() {
  if (!RELAY_API_KEY) {
    throw new Error(
      'RELAY_API_KEY is required for the Mac bridge. Add it to .env when cloud credentials are ready.',
    )
  }

  if (!AGENT_TOKEN) {
    throw new Error(
      'AGENT_TOKEN is required for the Mac bridge to call the local agent.',
    )
  }

  running = true
  console.log(`[bridge] Connecting to relay at ${RELAY_URL}`)
  await registerBridge()
  startHeartbeat()
  await workLoop()
}

export function stopBridge() {
  running = false
}

async function registerBridge() {
  // A previously paired bridge can resume with its relay credential alone.
  // This avoids requiring the one-time pairing code again after a local
  // checkout is moved or rebuilt.
  const heartbeatResponse = await fetch(`${RELAY_URL}/v1/devices/heartbeat`, {
    method: 'POST',
    headers: relayHeaders,
    body: JSON.stringify({ deviceId: BRIDGE_DEVICE_ID }),
  })

  if (heartbeatResponse.ok) {
    console.log(`[bridge] Resumed existing registration as ${BRIDGE_DEVICE_ID}`)
    return
  }

  const response = await fetch(`${RELAY_URL}/v1/devices/register`, {
    method: 'POST',
    headers: relayHeaders,
    body: JSON.stringify({
      deviceId: BRIDGE_DEVICE_ID,
      deviceType: 'mac_bridge',
      name: 'Home MacBook Bridge',
      pairingCode: PAIRING_CODE || undefined,
    }),
  })

  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error ?? 'Bridge registration failed.')
  }

  console.log(`[bridge] Registered as ${BRIDGE_DEVICE_ID}`)
}

function startHeartbeat() {
  const sendHeartbeat = async () => {
    if (!running) {
      return
    }

    try {
      await fetch(`${RELAY_URL}/v1/devices/heartbeat`, {
        method: 'POST',
        headers: relayHeaders,
        body: JSON.stringify({ deviceId: BRIDGE_DEVICE_ID }),
      })
    } catch (error) {
      console.warn(`[bridge] Heartbeat failed: ${error.message}`)
    }
  }

  sendHeartbeat()
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
}

async function workLoop() {
  while (running) {
    try {
      const work = await pollForWork()

      if (work) {
        await handleWork(work)
      }
    } catch (error) {
      console.warn(`[bridge] Work loop error: ${error.message}`)
      await sleep(WORK_POLL_INTERVAL_MS)
    }
  }
}

async function pollForWork() {
  const response = await fetch(
    `${RELAY_URL}/v1/bridge/work?deviceId=${encodeURIComponent(BRIDGE_DEVICE_ID)}`,
    {
      headers: relayHeaders,
    },
  )

  if (response.status === 204) {
    return null
  }

  const contentType = response.headers.get('content-type') || ''
  if (!contentType.includes('application/json')) {
    const body = (await response.text()).slice(0, 200)
    throw new Error(
      `Bridge work poll returned non-JSON (${response.status}): ${body}`,
    )
  }

  const payload = await response.json()

  if (!response.ok) {
    throw new Error(payload.error ?? 'Bridge work poll failed.')
  }

  return payload.work ?? null
}

async function handleWork(work) {
  console.log(`[bridge] Processing ${work.type} job ${work.jobId}`)
  const observablePipeline =
    work.type === 'plan' || work.type === 'execute'

  if (observablePipeline) {
    await reportPipelineEvent(work, {
      stage: 'transcription',
      status: 'done',
      label: 'Transcript received from cloud',
      detail:
        'Speech-to-text completed before this job reached the Mac bridge.',
      text: work.command,
      source: 'cloud-relay',
      meta: {
        relayJobId: work.jobId,
        workType: work.type,
        inputTelemetry: work.inputTelemetry ?? null,
      },
    })
  }

  try {
    if (work.type === 'plan') {
      const agentStartedAt = Date.now()
      await reportPipelineEvent(work, {
        stage: 'agent',
        status: 'active',
        label: 'Agent is processing the transcript',
        detail: 'Streaming the request through the local Mac agent and LLM.',
      })
      const plan = await callLocalAgent('/plan', {
        method: 'POST',
        body: {
          command: work.command,
          sessionId: work.sessionId,
          source: 'pendant',
        },
      })

      await reportPipelineEvent(work, {
        stage: 'agent',
        status: 'done',
        label: 'Agent response ready',
        detail: `Completed in ${Date.now() - agentStartedAt} ms.`,
        text: spokenTextForResult(plan),
        meta: {
          durationMs: Date.now() - agentStartedAt,
          localJobId: plan.jobId ?? null,
          thinkingTraceId: plan.thinking?.traceId ?? null,
          planner: plan.planner ?? null,
          resultStatus: plan.status ?? null,
          responseCharacters: spokenTextForResult(plan).length,
        },
      })

      const speechStartedAt = Date.now()
      await reportPipelineEvent(work, {
        stage: 'tts',
        status: 'active',
        label: 'Rendering response speech',
        detail: 'macOS speech is generating 24 kHz mono PCM for the pendant.',
        text: spokenTextForResult(plan),
      })
      const planWithSpeech = synthesizePendantSpeech(plan)

      await reportSynthesizedSpeech(work, planWithSpeech, speechStartedAt)

      await reportPipelineEvent(work, {
        stage: 'relay_result',
        status: 'active',
        label: 'Uploading response to cloud relay',
        detail: 'Sending the answer and PCM payload back for the nRF9160.',
      })
      await completeWork(work.jobId, {
        ok: plan.status !== 'unsupported',
        result: planWithSpeech,
        error:
          plan.status === 'unsupported'
            ? plan.error ?? 'Planning failed on local agent.'
            : '',
      })
      await reportPipelineEvent(work, {
        stage: 'relay_result',
        status: 'done',
        label: 'Response waiting for the pendant',
        detail:
          'The cloud relay accepted the response. The nRF9160 can now download and play it.',
        meta: {
          pcmBytes: planWithSpeech.pendantSpeech?.pcmBytes ?? 0,
        },
      })
      return
    }

    if (work.type === 'execute') {
      const agentStartedAt = Date.now()
      await reportPipelineEvent(work, {
        stage: 'agent',
        status: 'active',
        label: 'Agent is executing the approved actions',
        detail: 'The Mac agent is running the requested tool actions.',
      })
      const execution = await callLocalAgent('/execute', {
        method: 'POST',
        body: {
          command: work.command,
          actions: work.actions,
          sessionId: work.sessionId,
          source: 'pendant',
        },
      })

      await reportPipelineEvent(work, {
        stage: 'agent',
        status: 'done',
        label: 'Agent execution finished',
        detail: `Completed in ${Date.now() - agentStartedAt} ms.`,
        text: spokenTextForResult(execution),
        meta: {
          durationMs: Date.now() - agentStartedAt,
          localJobId: execution.jobId ?? null,
          thinkingTraceId: execution.thinking?.traceId ?? null,
          resultStatus: execution.status ?? null,
        },
      })

      const speechStartedAt = Date.now()
      await reportPipelineEvent(work, {
        stage: 'tts',
        status: 'active',
        label: 'Rendering execution result speech',
        detail: 'Generating the PCM response that the pendant will play.',
        text: spokenTextForResult(execution),
      })
      const executionWithSpeech = synthesizePendantSpeech(execution)

      await reportSynthesizedSpeech(
        work,
        executionWithSpeech,
        speechStartedAt,
      )

      await reportPipelineEvent(work, {
        stage: 'relay_result',
        status: 'active',
        label: 'Uploading execution result',
        detail: 'Sending the result and PCM payload back to the cloud relay.',
      })
      await completeWork(work.jobId, {
        ok: Boolean(execution.ok),
        result: executionWithSpeech,
        error: execution.error ?? '',
      })
      await reportPipelineEvent(work, {
        stage: 'relay_result',
        status: 'done',
        label: 'Execution response waiting for the pendant',
        detail:
          'The cloud relay accepted the result. The nRF9160 can now download and play it.',
        meta: {
          pcmBytes: executionWithSpeech.pendantSpeech?.pcmBytes ?? 0,
        },
      })
      return
    }

    if (work.type === 'agent_proxy') {
      const method = String(work.method || 'GET').toUpperCase()
      const path =
        String(work.path || '').trim() ||
        String(work.command || '')
          .replace(/^(GET|POST|PUT|PATCH|DELETE)\s+/i, '')
          .trim()

      if (!path.startsWith('/')) {
        await completeWork(work.jobId, {
          ok: false,
          error: `Invalid agent proxy path: ${path || '(empty)'}`,
        })
        return
      }

      const payload = await callLocalAgent(path, {
        method,
        body: method === 'GET' || method === 'DELETE' ? undefined : work.body,
      })
      await completeWork(work.jobId, {
        ok: true,
        result: payload,
        error: '',
      })
      return
    }

    await completeWork(work.jobId, {
      ok: false,
      error: `Unsupported work type: ${work.type}`,
    })
  } catch (error) {
    if (observablePipeline) {
      await reportPipelineEvent(work, {
        stage: 'error',
        status: 'failed',
        label: 'Pipeline failed',
        detail: error.message,
      })
    }
    await completeWork(work.jobId, {
      ok: false,
      error: error.message,
    })
  }
}

async function reportSynthesizedSpeech(work, result, startedAt) {
  const speech = result?.pendantSpeech ?? null
  let diagnosticAudio = null

  if (speech?.audioBase64) {
    try {
      const payload = await callLocalAgent('/pipeline/audio', {
        method: 'POST',
        body: {
          pipelineId: work.jobId,
          direction: 'output',
          format: speech.format,
          sampleRate: speech.sampleRate,
          channels: speech.channels,
          bitsPerSample: speech.bitsPerSample,
          audioBase64: speech.audioBase64,
        },
      })
      diagnosticAudio = payload.audio ?? null
    } catch (error) {
      console.warn(
        `[bridge] Could not save TTS preview for ${work.jobId}: ${error.message}`,
      )
    }
  }

  const durationMs = speech?.sampleRate
    ? Math.round(
        (Number(speech.pcmBytes || 0) /
          (Number(speech.bitsPerSample || 16) / 8) /
          Number(speech.channels || 1) /
          Number(speech.sampleRate)) *
          1000,
      )
    : 0

  await reportPipelineEvent(work, {
    stage: 'tts',
    status: 'done',
    label: speech ? 'Response speech rendered' : 'No response speech generated',
    detail: speech
      ? `${formatBytes(speech.pcmBytes)} · ${durationMs} ms · ${speech.sampleRate} Hz mono PCM`
      : 'The agent result did not contain speakable text.',
    text: spokenTextForResult(result),
    meta: speech
      ? {
          renderDurationMs: Date.now() - startedAt,
          audioDurationMs: durationMs,
          format: speech.format,
          sampleRate: speech.sampleRate,
          channels: speech.channels,
          bitsPerSample: speech.bitsPerSample,
          pcmBytes: speech.pcmBytes,
          truncated: speech.truncated,
          previewAvailable: Boolean(diagnosticAudio),
          peakPercent: diagnosticAudio?.peakPercent ?? null,
          rmsPercent: diagnosticAudio?.rmsPercent ?? null,
          clippedSamples: diagnosticAudio?.clippedSamples ?? null,
        }
      : {
          renderDurationMs: Date.now() - startedAt,
          pcmBytes: 0,
        },
  })
}

async function reportPipelineEvent(work, event) {
  try {
    await callLocalAgent('/pipeline/events', {
      method: 'POST',
      body: {
        pipelineId: work.jobId,
        kind: work.type,
        command: work.command,
        sessionId: work.sessionId,
        source: event.source || 'mac-bridge',
        ...event,
      },
    })
  } catch (error) {
    console.warn(
      `[bridge] Pipeline telemetry failed for ${work.jobId}: ${error.message}`,
    )
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

async function completeWork(jobId, { ok, result, error }) {
  const response = await fetch(`${RELAY_URL}/v1/bridge/work/${jobId}/result`, {
    method: 'POST',
    headers: relayHeaders,
    body: JSON.stringify({ ok, result, error }),
  })
  const raw = await response.text()
  let payload
  try {
    payload = JSON.parse(raw)
  } catch {
    throw new Error(
      `Failed to report bridge work result (${response.status}): ${raw.slice(0, 160)}`,
    )
  }

  if (!response.ok) {
    throw new Error(payload.error ?? 'Failed to report bridge work result.')
  }

  console.log(`[bridge] Completed job ${jobId} (${payload.job?.status})`)
}

async function callLocalAgent(path, { method = 'POST', body } = {}) {
  const response = await fetch(`${LOCAL_AGENT_URL}${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${AGENT_TOKEN}`,
      ...(body !== undefined
        ? { 'Content-Type': 'application/json' }
        : {}),
    },
    body: body !== undefined ? JSON.stringify(body) : undefined,
  })

  const contentType = response.headers.get('content-type') || ''
  const raw = await response.text()
  let payload
  if (contentType.includes('application/json')) {
    try {
      payload = JSON.parse(raw)
    } catch (error) {
      throw new Error(
        `Local agent ${method} ${path} returned invalid JSON: ${error.message}`,
        { cause: error },
      )
    }
  } else {
    throw new Error(
      `Local agent ${method} ${path} returned non-JSON (${response.status}): ${raw.slice(0, 120)}`,
    )
  }

  if (!response.ok) {
    throw new Error(payload.error ?? `Local agent ${method} ${path} failed.`)
  }

  return payload
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

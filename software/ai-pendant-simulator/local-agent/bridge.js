import {
  AGENT_TOKEN,
  BRIDGE_DEVICE_ID,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_AGENT_URL,
  PAIRING_CODE,
  PENDANT_ACCOUNT_ID,
  RELAY_API_KEY,
  RELAY_URL,
  WORK_RETRY_BASE_MS,
  WORK_RETRY_MAX_MS,
} from './bridgeConfig.js'
import {
  spokenConfirmation,
  spokenTextForResult,
  synthesizePendantSpeech,
} from './pendantSpeech.js'
import { synchronizeProductState } from './productSyncClient.js'
import { classifyPlan } from './actionRisk.js'
import { stripImageBytes } from './redaction.js'
import {
  createRateLimitedErrorReporter,
  createRetryBackoff,
} from './retryPolicy.js'

const relayHeaders = {
  'Content-Type': 'application/json',
  Authorization: `Bearer ${RELAY_API_KEY}`,
}

let running = false
let productSyncPromise = null

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
  await syncProductState()
  startHeartbeat()
  await syncAgentSnapshot()
  // Warm trivial success speech so first open_app does not pay cold TTS.
  try {
    const { synthesizePendantSpeech } = await import('./pendantSpeech.js')
    synthesizePendantSpeech({ response: 'Done.', status: 'ready', actions: [] })
  } catch (error) {
    console.warn(`[bridge] Speech cache warm failed: ${error.message}`)
  }
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
      await syncProductState()
      await syncAgentSnapshot()
    } catch (error) {
      console.warn(`[bridge] Heartbeat failed: ${error.message}`)
    }
  }

  sendHeartbeat()
  setInterval(sendHeartbeat, HEARTBEAT_INTERVAL_MS)
}

async function workLoop() {
  const retryBackoff = createRetryBackoff({
    baseMs: WORK_RETRY_BASE_MS,
    maximumMs: WORK_RETRY_MAX_MS,
  })
  const reportWorkLoopError = createRateLimitedErrorReporter()

  while (running) {
    try {
      const work = await pollForWork()

      if (work) {
        await handleWork(work)
      }
      retryBackoff.reset()
    } catch (error) {
      reportWorkLoopError('[bridge] Work loop error', error)
      await sleep(retryBackoff.nextDelay())
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

// Exported for the regression test that drives a full screenshot job and
// asserts nothing pixel-shaped reaches the relay.
export async function handleWork(work) {
  console.log(`[bridge] Processing ${work.type} job ${work.jobId}`)
  const observablePipeline =
    work.type === 'plan' || work.type === 'execute'

  if (observablePipeline) {
    // Telemetry only — not a product STT stage. Realtime already planned.
    const hint = work.plannerHint
    const hintActions = Array.isArray(hint?.actions) ? hint.actions : []
    const hasPlanPayload =
      Boolean(hint) &&
      (hintActions.length > 0 ||
        String(hint?.response || '').trim().length > 0 ||
        hint?.planner === 'audio-native' ||
        hint?.planner === 'audio-native-realtime' ||
        hint?.planner === 'audio-native-delegate')
    void reportPipelineEvent(work, {
      stage: hasPlanPayload ? 'agent' : 'command',
      status: hasPlanPayload ? 'active' : 'done',
      label: hasPlanPayload
        ? 'Realtime plan received from cloud'
        : 'Command label received from cloud',
      detail: hasPlanPayload
        ? 'Audio-native Realtime plan (tools/reply) — not a separate STT step.'
        : 'Job label for history; local planning may still be needed.',
      text: work.command,
      source: 'cloud-relay',
      meta: {
        relayJobId: work.jobId,
        workType: work.type,
        inputTelemetry: work.inputTelemetry ?? null,
        planner: hint?.planner ?? null,
      },
    })
  }

  try {
    if (work.type === 'plan') {
      const agentStartedAt = Date.now()
      const hint = work.plannerHint
      const hintActions = Array.isArray(hint?.actions) ? hint.actions : []
      const spokenResponse = String(hint?.response || '').trim()
      // Realtime hot path: if the cloud already produced tools and/or a spoken
      // reply, execute it. Do NOT require a second Mac text LLM.
      // Empty status alone is not usable (Realtime defaults status to
      // "instant" even for battery-style transcripts with no tools — those
      // still need local LLM as last resort when requireLocalPlanner or empty).
      const hasUsableNativePayload =
        hintActions.length > 0 || spokenResponse.length > 0
      const useAudioNativePlan =
        Boolean(hint) &&
        !hint?.requireLocalPlanner &&
        hasUsableNativePayload
      let plan
      if (useAudioNativePlan) {
        void reportPipelineEvent(work, {
          stage: 'agent',
          status: 'active',
          label: 'Using audio-native plan from the relay',
          detail: 'Skipping local LLM — Realtime already decided actions/reply.',
        })
        plan = {
          status:
            hint.status === 'instant' ||
            (!hintActions.length && spokenResponse)
              ? 'instant'
              : 'ready',
          command: work.command,
          response: spokenResponse || undefined,
          actions: hintActions,
          requiresConfirmation: hintActions.length > 0,
          planner:
            hint.planner === 'audio-native-realtime'
              ? 'audio-native-realtime'
              : 'audio-native',
          fullControl: true,
        }
      } else {
        void reportPipelineEvent(work, {
          stage: 'agent',
          status: 'active',
          label: hint?.requireLocalPlanner
            ? 'Realtime delegated multi-step plan to Mac LLM'
            : 'Mac LLM planning (no usable Realtime actions)',
          detail:
            'Local OpenAI planner — fallback only, not the Realtime hot path.',
        })
        plan = await callLocalAgent('/plan', {
          method: 'POST',
          body: {
            command: work.command,
            sessionId: work.sessionId,
            source: 'pendant',
            plannerHint: hint ?? null,
          },
        })
      }

      // Planning may create the session when the relay did not supply one.
      // Every later turn and telemetry event must follow that canonical id;
      // otherwise execution creates a second assistant-only conversation.
      const activeSessionId = plan.sessionId ?? work.sessionId
      const planWork =
        activeSessionId === work.sessionId
          ? work
          : { ...work, sessionId: activeSessionId }

      void reportPipelineEvent(planWork, {
        stage: 'agent',
        status: 'done',
        label: 'Agent response ready',
        detail: `Completed in ${Date.now() - agentStartedAt} ms${
          useAudioNativePlan ? ' (audio-native, no local LLM)' : ''
        }.`,
        text: spokenTextForResult(plan),
        meta: {
          durationMs: Date.now() - agentStartedAt,
          localJobId: plan.jobId ?? null,
          thinkingTraceId: plan.thinking?.traceId ?? null,
          planner: plan.planner ?? null,
          audioNative: Boolean(useAudioNativePlan),
          resultStatus: plan.status ?? null,
          responseCharacters: spokenTextForResult(plan).length,
        },
      })

      // A pendant command has no confirm button, so the plan is useless unless
      // the safe part of it actually runs.
      const verdict = classifyPlan(plan.actions)
      if (verdict.autoRun) {
        const executionStartedAt = Date.now()
        void reportPipelineEvent(planWork, {
          stage: 'agent',
          status: 'active',
          label: 'Running the plan on this Mac',
          detail: `Executing ${plan.actions.length} action(s) hands-free.`,
        })
        try {
          const execution = await callLocalAgent('/execute', {
            method: 'POST',
            body: {
              command: work.command,
              actions: plan.actions,
              sessionId: activeSessionId,
              planMeta: { planner: plan.planner ?? null, source: 'pendant' },
              source: 'pendant',
            },
          })
          // Already free of image bytes — callLocalAgent strips them — which
          // matters because this object is spread into the relay job result.
          plan.execution = execution
          plan.executed = execution?.ok !== false
          // The planner wrote its reply before anything ran, so it can only
          // describe intent. Speak what actually happened instead.
          plan.response = spokenConfirmation(plan, execution)
          await reportPipelineEvent(planWork, {
            stage: 'agent',
            status: plan.executed ? 'done' : 'failed',
            label: plan.executed ? 'Plan executed on this Mac' : 'Execution failed',
            detail: `Finished in ${Date.now() - executionStartedAt} ms.`,
            text: spokenTextForResult(plan),
            meta: { results: execution?.results ?? null },
          })
          // Dashboard: show Done the moment Outlook (etc.) is open — do not
          // wait for TTS. partial keeps the job open so speech can attach next.
          // Await so the final completeWork cannot race ahead of this patch.
          if (plan.executed) {
            try {
              await completeWork(work.jobId, {
                ok: true,
                partial: true,
                result: {
                  ...plan,
                  executed: true,
                  phase: 'executed',
                  pendantSpeech: undefined,
                },
              })
            } catch (err) {
              console.warn(
                `[bridge] Early execute report failed for ${work.jobId}: ${err.message}`,
              )
            }
          }
        } catch (executionError) {
          plan.executed = false
          plan.executionError = executionError.message
          // Always tell the owner what failed — an optimistic planner response
          // ("Opening Outlook") must not be the last thing the pendant says.
          plan.response = `That didn't work: ${executionError.message}`
            .replace(/\s+/g, ' ')
            .trim()
            .slice(0, 180)
          await reportPipelineEvent(planWork, {
            stage: 'agent',
            status: 'failed',
            label: 'Execution failed',
            detail: executionError.message,
            text: plan.response,
          })
        }
      } else if (Array.isArray(plan.actions) && plan.actions.length) {
        plan.executed = false
        // Array of blocked actions (not a boolean) — dashboard and tests read it.
        plan.awaitingApproval = verdict.blocked
        plan.response =
          spokenTextForResult({ ...plan, awaitingApproval: true }) ||
          'Waiting for your approval on the dashboard.'
        await reportPipelineEvent(planWork, {
          stage: 'agent',
          status: 'waiting',
          label: 'Waiting for your approval',
          detail: verdict.reason,
          text: plan.response,
          meta: { blocked: verdict.blocked },
        })
      }

      const speechStartedAt = Date.now()
      // Trivial single open_app success: skip a long spoken sentence; still send
      // a one-word cached "Done." so the pendant has something to play.
      const trivialOpen =
        plan.executed &&
        Array.isArray(plan.actions) &&
        plan.actions.length === 1 &&
        plan.actions[0]?.type === 'open_app'
      if (trivialOpen) {
        plan.response = 'Done.'
      }

      void reportPipelineEvent(planWork, {
        stage: 'tts',
        status: 'active',
        label: trivialOpen
          ? 'Rendering short confirmation speech'
          : 'Rendering response speech',
        detail: trivialOpen
          ? 'Simple open_app success — using cached one-word reply.'
          : 'macOS speech is generating 24 kHz mono PCM for the pendant.',
        text: spokenTextForResult(plan),
      })
      // TTS after execute; cached phrases are near-instant.
      const planWithSpeech = synthesizePendantSpeech(plan)

      void reportSynthesizedSpeech(planWork, planWithSpeech, speechStartedAt)

      void reportPipelineEvent(planWork, {
        stage: 'relay_result',
        status: 'active',
        label: 'Uploading response to cloud relay',
        detail: 'Sending the answer and PCM payload back for the nRF9160.',
      })
      await completeWork(work.jobId, {
        ok: plan.status !== 'unsupported' && plan.executed !== false,
        result: {
          ...planWithSpeech,
          executed: plan.executed !== false,
          phase: 'complete',
        },
        error:
          plan.status === 'unsupported'
            ? plan.error ?? 'Planning failed on local agent.'
            : plan.executed === false
              ? plan.executionError || plan.response || 'Execution failed.'
              : '',
      })
      void reportPipelineEvent(planWork, {
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
  } finally {
    await syncProductState()
    await syncAgentSnapshot()
  }
}

async function syncProductState() {
  if (productSyncPromise) {
    return productSyncPromise
  }

  productSyncPromise = synchronizeProductState({
    relayUrl: RELAY_URL,
    authorization: `Bearer ${RELAY_API_KEY}`,
    accountId: PENDANT_ACCOUNT_ID,
    sourceDeviceId: BRIDGE_DEVICE_ID,
  }).catch((error) => {
    console.warn(`[bridge] Canonical product sync failed: ${error.message}`)
    return null
  }).finally(() => {
    productSyncPromise = null
  })

  return productSyncPromise
}

async function syncAgentSnapshot() {
  try {
    const snapshot = await callLocalAgent('/ops/snapshot', { method: 'GET' })
    const response = await fetch(`${RELAY_URL}/v1/state/agent-snapshot`, {
      method: 'PUT',
      headers: relayHeaders,
      body: JSON.stringify({
        data: snapshot,
        updatedBy: BRIDGE_DEVICE_ID,
      }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload.error || `relay returned ${response.status}`)
    }
    // Compact fleet snapshot for Realtime voice agent (apps, browser, memory).
    await syncFleetContext(snapshot)
  } catch (error) {
    console.warn(`[bridge] Persistent state sync failed: ${error.message}`)
  }
}

/**
 * Push a cache-friendly fleet world-model to the relay for Realtime instructions.
 * Built from live Mac discovery — no hard-coded app or command lists.
 */
async function syncFleetContext(snapshot) {
  try {
    const { buildFleetPayloadFromLocal } = await import(
      '../cloud-relay/fleetContext.js'
    )
    const status = snapshot?.status || snapshot || {}
    const fleet = buildFleetPayloadFromLocal({
      machine: status.machine || null,
      browser: status.browser || null,
      permissions: status.agent?.permissions || status.permissions || null,
      memory: status.memory || snapshot?.context?.memory || null,
      workingProject:
        status.workingProject || snapshot?.context?.workingProject || null,
      speaker: process.env.PENDANT_SPEAKER_NAME || null,
    })
    const response = await fetch(`${RELAY_URL}/v1/state/fleet`, {
      method: 'PUT',
      headers: relayHeaders,
      body: JSON.stringify({
        data: fleet,
        updatedBy: BRIDGE_DEVICE_ID,
      }),
    })
    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.error || `relay returned ${response.status}`)
    }
  } catch (error) {
    console.warn(`[bridge] Fleet context sync failed: ${error.message}`)
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

async function completeWork(jobId, { ok, result, error, partial = false }) {
  const response = await fetch(`${RELAY_URL}/v1/bridge/work/${jobId}/result`, {
    method: 'POST',
    headers: relayHeaders,
    // The relay stores this body verbatim in D1 and hands it back to every API
    // consumer, so this is the last place to catch image bytes before they
    // leave the owner's machine for good. `callLocalAgent` already stripped
    // them; this is the belt to that suspenders, and it covers every work type
    // including agent_proxy, whose result shape is whatever path was proxied.
    body: JSON.stringify({
      ok,
      result: stripImageBytes(result),
      error,
      partial: Boolean(partial),
    }),
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

  console.log(
    `[bridge] ${partial ? 'Progress' : 'Completed'} job ${jobId} (${payload.job?.status})`,
  )
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

  // The agent's HTTP response carries screenshot bytes for its in-process
  // callers (the ops dashboard, the computer-use loop). The bridge is not one
  // of them: it is the cloud-facing process, and everything it holds ends up in
  // a relay job result, a pipeline event or a state snapshot. Drop the pixels
  // on the way in, so no later code path has any to forward.
  return stripImageBytes(payload)
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

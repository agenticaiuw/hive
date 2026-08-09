import {
  AGENT_TOKEN,
  BRIDGE_DEVICE_ID,
  BRIDGE_SAFETY_POLL_INTERVAL_MS,
  BRIDGE_SOCKET_HEARTBEAT_MS,
  BRIDGE_SOCKET_RECONNECT_BASE_MS,
  BRIDGE_SOCKET_RECONNECT_MAX_MS,
  HEARTBEAT_INTERVAL_MS,
  LOCAL_AGENT_URL,
  PAIRING_CODE,
  PENDANT_ACCOUNT_ID,
  RELAY_API_KEY,
  RELAY_URL,
  WORK_RETRY_BASE_MS,
  WORK_RETRY_MAX_MS,
  WORK_POLL_ABORT_MS,
} from './bridgeConfig.js'
import {
  bridgeSocketUrl,
  createBridgeSocket,
  createWorkSignal,
  pollIdleDelay,
} from './bridgePush.js'
import {
  resultForWire,
  spokenConfirmation,
  spokenTextForResult,
  synthesizePendantSpeech,
  telemetryForWire,
} from './pendantSpeech.js'
import { synchronizeProductState } from './productSyncClient.js'
import { classifyPlan, classifyPlanForRoutine } from './actionRisk.js'
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
/*
 * Doorbell plumbing. The signal is the ONLY coupling between the socket and
 * the work loop: a work frame, a health flip (either direction) and stop()
 * all just ring it, and the loop re-evaluates what to do. The claim request
 * stays the sole way work is fetched — a doorbell is never trusted as
 * evidence that work exists, only as a reason to look now.
 */
const workSignal = createWorkSignal()
let pushSocket = null

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
  /*
   * Doorbell socket: push delivery for the queue the loop below drains. On
   * open AND on close it rings the signal — open so the backlog drains
   * immediately, close so a loop asleep on the quiet cadence wakes and
   * resumes continuous polling instead of finishing a 60 s nap without
   * cover. Against a relay deployed before this route the connect fails,
   * the socket never turns healthy, and the loop runs exactly as before —
   * one rate-limited log line, capped reconnect backoff, no spam.
   */
  pushSocket = createBridgeSocket({
    url: bridgeSocketUrl(RELAY_URL, BRIDGE_DEVICE_ID),
    headers: { Authorization: `Bearer ${RELAY_API_KEY}` },
    heartbeatMs: BRIDGE_SOCKET_HEARTBEAT_MS,
    reconnectBaseMs: BRIDGE_SOCKET_RECONNECT_BASE_MS,
    reconnectMaxMs: BRIDGE_SOCKET_RECONNECT_MAX_MS,
    onWork: () => workSignal.ring(),
    onHealthyChange: () => workSignal.ring(),
  })
  pushSocket.start()
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
  if (pushSocket) {
    pushSocket.stop()
    pushSocket = null
  }
  // Wake a loop idling on the safety cadence so shutdown is prompt.
  workSignal.ring()
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
        retryBackoff.reset()
        // Drain: claim again immediately until the queue answers empty.
        continue
      }
      retryBackoff.reset()

      /*
       * Queue is empty. With a healthy doorbell socket, idle a full safety
       * interval — the doorbell (or a health flip, or stopBridge) wakes the
       * wait instantly, and a ring that landed while we were polling or
       * executing is latched so this returns at once instead of napping
       * through it. With no healthy socket the delay is 0 and this loop is
       * the old continuous long-poll, unchanged.
       */
      const idleMs = pollIdleDelay({
        socketHealthy: pushSocket?.isHealthy() ?? false,
        safetyIntervalMs: BRIDGE_SAFETY_POLL_INTERVAL_MS,
      })
      if (idleMs > 0 && running) {
        await workSignal.wait(idleMs)
      }
    } catch (error) {
      reportWorkLoopError('[bridge] Work loop error', error)
      await sleep(retryBackoff.nextDelay())
    }
  }
}

async function pollForWork() {
  // The abort signal bounds a stalled long-poll; without it a wedged socket
  // holds the work loop hostage for undici's multi-minute default timeout.
  const response = await fetch(
    `${RELAY_URL}/v1/bridge/work?deviceId=${encodeURIComponent(BRIDGE_DEVICE_ID)}`,
    {
      headers: relayHeaders,
      signal: AbortSignal.timeout(WORK_POLL_ABORT_MS),
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
  const queueAgeMs = work.createdAt
    ? Date.now() - new Date(work.createdAt).getTime()
    : null
  console.log(
    `[bridge] Processing ${work.type} job ${work.jobId}` +
      (queueAgeMs === null ? '' : ` (claimed +${queueAgeMs}ms after creation)`),
  )
  const observablePipeline =
    work.type === 'plan' || work.type === 'execute'

  if (observablePipeline) {
    // Telemetry only — not a product STT stage. Realtime already planned.
    // Stage labels: "Realtime plan" / command label — never "transcription" as product.
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
        ? `Realtime plan — ${hintActions.length} action(s); not a separate STT step.`
        : 'Job label for history; local planning may still be needed.',
      text: work.command,
      source: 'cloud-relay',
      meta: {
        relayJobId: work.jobId,
        workType: work.type,
        inputTelemetry: work.inputTelemetry ?? null,
        planner: hint?.planner ?? null,
        actionCount: hintActions.length,
        requireLocalPlanner: Boolean(hint?.requireLocalPlanner),
      },
    })
  }

  try {
    if (work.type === 'plan') {
      const agentStartedAt = Date.now()
      const hint = work.plannerHint
      const hintActions = Array.isArray(hint?.actions) ? hint.actions : []
      const spokenResponse = String(hint?.response || '').trim()
      // Execute-only hot path (no second Mac text LLM):
      // 1) actions.length > 0 && !requireLocalPlanner → use Realtime actions
      // 2) status instant + spoken response + no actions → instant reply
      // Local LLM only when: requireLocalPlanner, typed dashboard (no hint),
      // or empty-tool chitchat that still needs planning.
      const hasUsableNativePayload =
        hintActions.length > 0 || spokenResponse.length > 0
      const useAudioNativePlan =
        Boolean(hint) &&
        !hint?.requireLocalPlanner &&
        hasUsableNativePayload
      let plan
      if (useAudioNativePlan) {
        console.log(
          `[bridge] Audio-native execute-only job ${work.jobId} actionCount=${hintActions.length}`,
        )
        void reportPipelineEvent(work, {
          stage: 'agent',
          status: 'active',
          label:
            hintActions.length > 0
              ? 'Realtime plan — executing actions'
              : 'Realtime plan — spoken reply only',
          detail:
            hintActions.length > 0
              ? `Skipping local LLM — executing ${hintActions.length} Realtime action(s).`
              : 'Skipping local LLM — Realtime already provided the spoken reply.',
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
          // Hands-free pendant: classifyPlan decides auto-run vs approval.
          requiresConfirmation: false,
          planner:
            hint.planner === 'audio-native-realtime'
              ? 'audio-native-realtime'
              : 'audio-native',
          fullControl: true,
          toolsUsed: hint.toolsUsed,
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
        // Prefer explicit goal from the hint when Realtime delegated planning;
        // job.command is only a history label (may be empty / generic).
        const planCommand =
          (hint?.requireLocalPlanner && String(hint?.goal || '').trim()) ||
          work.command
        plan = await callLocalAgent('/plan', {
          method: 'POST',
          body: {
            command: planCommand,
            sessionId: work.sessionId,
            source: 'pendant',
            plannerHint: hint ?? null,
            /*
             * Only this branch gets the handle. The audio-native path above
             * never calls a model, so a context it would not read is pure
             * latency; this branch is the one that was starting from a bare
             * action list and rediscovering what the relay already knew.
             */
            contextHandle: work.contextHandle ?? null,
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
        label: useAudioNativePlan
          ? 'Realtime plan ready'
          : 'Agent response ready',
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
          actionCount: Array.isArray(plan.actions) ? plan.actions.length : 0,
          resultStatus: plan.status ?? null,
          responseCharacters: spokenTextForResult(plan).length,
        },
      })

      // Pendant has no confirm UI: auto-run allowlisted / status actions.
      // Status run_shell (pmset, open -a, …) is hands-free via actionRisk.
      //
      // A routine-originated job is a different venue: the owner wrote and
      // enabled the schedule, and that is standing approval for its own
      // purpose (exactly how local-agent/routines.js has always executed).
      // classifyPlanForRoutine widens auto-run to everything except the
      // outward/irreversible deny-list — those still park, and the relay is
      // told so loudly rather than being handed a fake failure to retry.
      //
      // THE MODEL'S JUDGEMENT WINS, when it made one. The owner's ruling is
      // that a spoken request IS the authorization, and that the model — not a
      // table of action types — decides when something goes beyond what was
      // asked and deserves a question. llmPlanner now returns
      // requiresConfirmation false by default and raises it with a reason when
      // the model wants to ask.
      //
      // This gate used to ignore that field entirely and re-decide from the
      // action types, which broke the intent in both directions: a plan the
      // model chose to ask about ran anyway if its actions happened to be
      // allowlisted, and an in-scope plan parked because they were not. The
      // pendant is the device the owner actually uses, so the override landed
      // exactly where it hurt most.
      //
      // classifyPlan remains the fallback for plans that carry no verdict at
      // all — the audio-native branch above hardcodes false, and a routine is
      // still its own venue with its own deny-list.
      // A spoken-only reply carries no actions, and "run it" is meaningless
      // there — classifyPlan already answers that case correctly ("No actions
      // to run"), so the model's verdict only applies when there is something
      // to execute.
      const routineJob = isRoutineWork(work)
      const hasActions = Array.isArray(plan.actions) && plan.actions.length > 0
      const askedByModel = plan.requiresConfirmation === true
      const modelReason =
        plan.confirmReason || 'The planner asked for your approval on this step.'
      const modelVerdict =
        hasActions && !routineJob && typeof plan.requiresConfirmation === 'boolean'
          ? {
              autoRun: !askedByModel,
              blocked: askedByModel
                ? plan.actions.map((action) => ({
                    type: action?.type ?? 'unknown',
                    reason: modelReason,
                  }))
                : [],
              reason: askedByModel ? modelReason : '',
            }
          : null
      const verdict =
        modelVerdict ??
        (routineJob
          ? classifyPlanForRoutine(plan.actions)
          : classifyPlan(plan.actions))
      let parkedForApproval = false
      if (verdict.autoRun) {
        const executionStartedAt = Date.now()
        void reportPipelineEvent(planWork, {
          stage: 'agent',
          status: 'active',
          label: 'Executing actions',
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
            label: plan.executed
              ? 'Executing actions — done'
              : 'Executing actions — failed',
            detail: `Finished in ${Date.now() - executionStartedAt} ms.`,
            text: spokenTextForResult(plan),
            /* A summary, not the results themselves: the full array carries the
             * briefing payload, and nothing reads meta.results anywhere. */
            meta: summarizeActionResults(execution?.results),
          })
          // Dashboard: show Done the moment Outlook (etc.) is open — do not
          // wait for TTS. partial keeps the job open so speech can attach next.
          // Await so the final completeWork cannot race ahead of this patch.
          if (plan.executed) {
            try {
              /*
               * Trimmed like the final report. This one has no pendantSpeech of
               * its own, but it still spreads `plan` -- and therefore
               * plan.execution, which carries the agent's whole activity-log
               * ring. Untrimmed it was a ~45 MB body that the relay refused
               * (413) and that also blew the agent's own /pipeline/events cap,
               * so the dashboard lost the very "executed" signal this report
               * exists to deliver.
               */
              await completeWork(work.jobId, {
                ok: true,
                partial: true,
                result: resultForWire({
                  ...plan,
                  executed: true,
                  phase: 'executed',
                  pendantSpeech: undefined,
                }),
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
            label: 'Executing actions — failed',
            detail: executionError.message,
            text: plan.response,
          })
        }
      } else if (Array.isArray(plan.actions) && plan.actions.length) {
        plan.executed = false
        parkedForApproval = true
        // Array of blocked actions (not a boolean) — dashboard and tests read it.
        // For a routine job this is the hard deny-list, the only thing that can
        // park a routine; for voice it is everything over the hands-free line.
        plan.awaitingApproval =
          routineJob && Array.isArray(verdict.denied) && verdict.denied.length
            ? verdict.denied
            : verdict.blocked
        plan.response =
          spokenTextForResult({ ...plan, awaitingApproval: true }) ||
          'Waiting for your approval on the dashboard.'
        await reportPipelineEvent(planWork, {
          stage: 'agent',
          status: 'waiting',
          label: 'Waiting for your approval',
          detail: verdict.reason,
          text: plan.response,
          meta: { blocked: plan.awaitingApproval, routineJob },
        })
      }

      const speechStartedAt = Date.now()
      void reportPipelineEvent(planWork, {
        stage: 'tts',
        status: 'active',
        label: 'Rendering response speech',
        detail: 'macOS speech is generating 24 kHz mono PCM for the pendant.',
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
      /*
       * Parked is not failed. A plan held for the owner's approval used to be
       * reported ok:false, which the relay recorded as a FAILURE — and its
       * routine reaper then retried the "failure", burning a planner call
       * every backoff step while the parked plan sat unseen (live incident,
       * 2026-08-08 07:00 briefing). Parked plans now report ok with a
       * distinct phase and the approval handle. A relay deployed before this
       * fix ignores `parked` and records the ordinary plan_ready it already
       * uses for "plan produced, awaiting execution" — no failure, no retry.
       */
      /*
       * resultForWire drops the raw PCM when the opus track is one the relay
       * will serve. It runs HERE, after reportSynthesizedSpeech() above has
       * already sent the full-fidelity copy to the Mac dashboard's audio
       * preview, so only the relay body shrinks.
       */
      await completeWork(work.jobId, {
        ok:
          parkedForApproval ||
          (plan.status !== 'unsupported' && plan.executed !== false),
        parked: parkedForApproval,
        result: {
          ...resultForWire(planWithSpeech),
          executed: plan.executed !== false,
          phase: parkedForApproval ? 'parked_for_approval' : 'complete',
          ...(parkedForApproval
            ? {
                parked: true,
                approval: {
                  relayJobId: work.jobId,
                  planJobId: plan.jobId ?? null,
                  sessionId: activeSessionId ?? null,
                },
              }
            : {}),
        },
        error: parkedForApproval
          ? ''
          : plan.status === 'unsupported'
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
      // Same wire trim as the plan branch, and likewise only after
      // reportSynthesizedSpeech() has taken its full-fidelity copy above.
      await completeWork(work.jobId, {
        ok: Boolean(execution.ok),
        result: resultForWire(executionWithSpeech),
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
 * Ask the Mac what the voice agent should know right now.
 *
 * The projection is task-scoped by design, but this is a heartbeat: nobody has
 * spoken yet, so there is no task to scope to and the query is deliberately
 * empty. What comes back is the surface-stable core — preferences, standing
 * permissions, open tasks — which is the part worth caching in the prompt
 * prefix anyway. Per-utterance scoping would have to happen in the relay, at
 * the point where the words actually exist.
 *
 * Returns null on any failure so the caller falls back to the legacy entity
 * fields: a projection outage should cost the voice agent context quality, not
 * its whole fleet snapshot.
 */
async function fetchVoiceMemoryProjection() {
  try {
    const projected = await callLocalAgent(
      '/memory/projection?surface=voice',
      { method: 'GET' },
    )
    const text = String(projected?.text || '').trim()
    return text || null
  } catch (error) {
    console.warn(
      `[bridge] Memory projection unavailable, using entity fallback: ${error.message}`,
    )
    return null
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
      memoryText: await fetchVoiceMemoryProjection(),
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
      /*
       * Telemetry never carries audio bytes. The receiver drops them anyway
       * (pipelineTrace.js sanitizeMeta strips every /base64/ key), so they could
       * only ever cost us the event: with a briefing payload attached this POST
       * hit the agent's body limit and returned 413, losing the whole event and
       * with it the stage transition the dashboard strip renders. Guarding here
       * rather than at each call site means no future `meta` can reintroduce it.
       */
      body: telemetryForWire({
        pipelineId: work.jobId,
        kind: work.type,
        command: work.command,
        sessionId: work.sessionId,
        source: event.source || 'mac-bridge',
        ...event,
      }),
    })
  } catch (error) {
    console.warn(
      `[bridge] Pipeline telemetry failed for ${work.jobId}: ${error.message}`,
    )
  }
}

/*
 * What the dashboard can actually use about a set of executed actions: how many
 * ran, whether each worked, and what kind it was. The results themselves are
 * where the briefing payload rides, and no reader anywhere consumes
 * meta.results — sanitizeMeta would strip its audio on arrival regardless.
 */
function summarizeActionResults(results) {
  if (!Array.isArray(results)) return { results: null }
  return {
    resultCount: results.length,
    results: results.slice(0, 20).map((entry) => ({
      type: entry?.type ?? entry?.action ?? null,
      ok: entry?.ok !== false,
      ...(entry?.error ? { error: String(entry.error).slice(0, 240) } : {}),
    })),
  }
}

function formatBytes(value) {
  const bytes = Number(value || 0)
  if (bytes < 1024) return `${bytes} B`
  return `${(bytes / 1024).toFixed(1)} KiB`
}

/*
 * A job the relay scheduler enqueued for a routine, verified against a live
 * job (2026-08-08): cloud-relay/scheduler.js enqueueRoutineMacJob stamps
 * inputTelemetry { storage: 'routine', inputMode: 'routine', routineId,
 * routineName, runId }. Either field is accepted; when both are absent the
 * job falls back to the stricter voice policy, which is the safe direction.
 */
function isRoutineWork(work) {
  const telemetry = work?.inputTelemetry
  return (
    telemetry?.storage === 'routine' || telemetry?.inputMode === 'routine'
  )
}

async function completeWork(
  jobId,
  { ok, result, error, partial = false, parked = false },
) {
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
      // Distinct outcome for a plan held for approval. Relays deployed before
      // this field ignore it and record plan_ready, which neither fails nor
      // retries the job — the degradation this report shape was chosen for.
      ...(parked ? { parked: true } : {}),
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
    `[bridge] ${partial ? 'Progress' : 'Completed'} job ${jobId} (${payload.job?.status}${
      parked ? ', parked for approval' : ''
    })`,
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

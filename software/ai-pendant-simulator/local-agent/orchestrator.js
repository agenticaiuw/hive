import { buildConversationContext } from './conversationContext.js'
import { planCommand } from './llmPlanner.js'
import {
  createSession,
  appendTurn,
} from './sessionStore.js'
import {
  addThinkingStep,
  appendThinkingChunk,
  finishThinkingTrace,
  startThinkingTrace,
} from './thinkingTrace.js'

const INSTANT_INFO_TYPES = new Set([
  'get_weather',
  'get_time',
  'translate_text',
])

export async function orchestratePlan({
  command,
  sessionId,
  source = 'local',
  signal = null,
}) {
  const { throwIfAborted } = await import('./jobControl.js')
  let activeSessionId = sessionId

  if (!activeSessionId) {
    activeSessionId = createSession({ title: command }).sessionId
  }

  const trace = startThinkingTrace({
    command,
    sessionId: activeSessionId,
    source,
    kind: 'plan',
  })

  try {
    throwIfAborted(signal)
    addThinkingStep(trace.traceId, {
      id: 'heard',
      label: 'Heard your request',
      detail: command,
      status: 'done',
      chunks: [
        {
          id: 'heard_raw',
          phase: 'input',
          text: command,
          at: new Date().toISOString(),
        },
      ],
    })

    addThinkingStep(trace.traceId, {
      id: 'context',
      label: 'Checking recent chat and memory',
      detail: 'Loading conversation and remembered people, files, and tasks',
      status: 'active',
    })

    const context = buildConversationContext({
      command,
      sessionId: activeSessionId,
    })
    const workingCommand = context.resolvedCommand || command

    const contextChunks = buildContextChunks(context, command, workingCommand)
    addThinkingStep(trace.traceId, {
      id: 'context',
      label: 'Checked recent chat and memory',
      detail: summarizeContext(context),
      status: 'done',
      chunks: contextChunks,
      streamText: contextChunks.map((chunk) => chunk.text).join('\n'),
    })

    appendTurn(activeSessionId, {
      role: 'user',
      content: command,
      source: 'user',
    })

    addThinkingStep(trace.traceId, {
      id: 'route',
      label: 'Routing via LLM',
      detail: 'No keyword short-circuit — the model chooses tools and answers',
      status: 'done',
      chunks: [
        {
          id: 'route_llm',
          phase: 'route',
          text: 'Sending request to LLM planner (string intent parsing disabled)',
          at: new Date().toISOString(),
        },
      ],
    })

    appendThinkingChunk(trace.traceId, {
      stepId: 'plan',
      label: 'Streaming planner draft',
      phase: 'llm_start',
      text: 'Opening model stream…',
      detail: 'Waiting for the first tokens',
      status: 'active',
      streamText: '',
    })

    const startedAt = Date.now()
    let lastPartial = ''
    let seenLabels = new Set()
    let seenTypes = new Set()

    let plan = await planCommand(workingCommand, {
      context,
      onProgress: (progress) => {
        const elapsedSec = Math.max(
          1,
          Math.round((Date.now() - startedAt) / 1000),
        )
        const partial = String(progress?.partial || '')
        const phase = progress?.phase || 'llm_stream'
        const delta = partial.slice(lastPartial.length)
        lastPartial = partial

        const discoveries = extractPlanDiscoveries(partial)
        for (const type of discoveries.types) {
          if (!seenTypes.has(type)) {
            seenTypes.add(type)
            appendThinkingChunk(trace.traceId, {
              stepId: 'plan',
              label: 'Streaming planner draft',
              phase: 'discover_type',
              text: `action type → ${type}`,
              status: 'active',
              streamText: partial,
              detail: `${progress?.message || 'Drafting'} · ${elapsedSec}s · ${partial.length} chars`,
            })
          }
        }
        for (const label of discoveries.labels) {
          if (!seenLabels.has(label)) {
            seenLabels.add(label)
            appendThinkingChunk(trace.traceId, {
              stepId: 'plan',
              label: 'Streaming planner draft',
              phase: 'discover_label',
              text: `step → ${label}`,
              status: 'active',
              streamText: partial,
              detail: `${progress?.message || 'Drafting'} · ${elapsedSec}s · ${partial.length} chars`,
            })
          }
        }

        if (delta || phase !== 'llm_stream') {
          appendThinkingChunk(trace.traceId, {
            stepId: 'plan',
            label: 'Streaming planner draft',
            phase,
            text:
              phase === 'llm_stream'
                ? delta || `(+${progress?.chars || partial.length} chars)`
                : progress?.message || phase,
            status: 'active',
            streamText: partial,
            detail: [
              progress?.message || 'Model is drafting',
              `${elapsedSec}s`,
              `${partial.length} chars`,
              discoveries.labels.length
                ? `steps: ${discoveries.labels.slice(0, 5).join(' → ')}`
                : null,
            ]
              .filter(Boolean)
              .join(' · '),
            meta: {
              chars: partial.length,
              labels: discoveries.labels,
              types: discoveries.types,
              elapsedSec,
            },
          })
        }
      },
    })

    if (plan.status === 'unsupported') {
      addThinkingStep(trace.traceId, {
        id: 'plan',
        label: 'Could not make a safe plan',
        detail: plan.error || 'Unsupported request',
        status: 'done',
      })
      const finished = finishThinkingTrace(trace.traceId, {
        status: 'failed',
        summary: plan.error || 'Unsupported request',
      })
      return {
        ...plan,
        context,
        sessionId: activeSessionId,
        thinking: finished,
      }
    }

    // Info-only tools: run immediately, skip confirm.
    if (isInstantInfoPlan(plan)) {
      plan = await realizeInstantInfoPlan(plan, {
        traceId: trace.traceId,
        command: workingCommand,
      })
    }

    if (plan.status === 'instant') {
      addThinkingStep(trace.traceId, {
        id: 'plan',
        label: 'Ready with an answer',
        detail: plan.response || plan.summary || 'Done',
        status: 'done',
        streamText: lastPartial || String(plan.response || ''),
        chunks: [
          {
            id: 'instant_answer',
            phase: 'answer',
            text: String(plan.response || plan.summary || '').slice(0, 400),
            at: new Date().toISOString(),
          },
        ],
      })

      appendTurn(activeSessionId, {
        role: 'assistant',
        content: plan.response || plan.summary,
        source: plan.planner ?? 'llm',
        result: plan.response,
      })

      const finished = finishThinkingTrace(trace.traceId, {
        status: 'done',
        summary: plan.response || plan.summary || 'Done',
      })

      return {
        ...plan,
        context,
        sessionId: activeSessionId,
        thinking: finished,
      }
    }

    addThinkingStep(trace.traceId, {
      id: 'plan',
      label: 'Prepared a plan for you',
      detail: summarizePlan(plan),
      status: 'done',
      streamText: lastPartial || undefined,
      meta: {
        actionCount: plan.actions?.length ?? 0,
        planner: plan.planner ?? 'llm',
      },
    })

    for (const [index, action] of (plan.actions ?? []).entries()) {
      appendThinkingChunk(trace.traceId, {
        stepId: 'plan',
        label: 'Prepared a plan for you',
        phase: 'final_step',
        text: `${index + 1}. ${action.label || action.type}${
          action.params && Object.keys(action.params).length
            ? ` · ${JSON.stringify(action.params).slice(0, 140)}`
            : ''
        }`,
        status: 'done',
        streamText: lastPartial || undefined,
        detail: summarizePlan(plan),
      })
    }

    appendTurn(activeSessionId, {
      role: 'assistant',
      content: plan.summary ?? plan.actions?.[0]?.label ?? 'Prepared a plan.',
      source: plan.planner ?? 'planner',
      plan,
    })

    const finished = finishThinkingTrace(trace.traceId, {
      status: 'done',
      summary: plan.summary ?? 'Plan ready',
    })

    return {
      ...plan,
      context,
      sessionId: activeSessionId,
      thinking: finished,
    }
  } catch (error) {
    addThinkingStep(trace.traceId, {
      id: 'error',
      label: 'Something went wrong while thinking',
      detail: error.message,
      status: 'done',
    })
    finishThinkingTrace(trace.traceId, {
      status: 'failed',
      summary: error.message,
    })
    throw error
  }
}

export async function orchestrateExecute({
  command,
  actions,
  sessionId,
  planMeta,
  source = 'local',
  signal = null,
}) {
  const { executeActions } = await import('./executor.js')
  const { appendLog } = await import('./logger.js')
  const { updateContextGraphFromExecution } = await import('./contextGraph.js')
  const { throwIfAborted, JobCancelledError } = await import('./jobControl.js')

  const trace = startThinkingTrace({
    command,
    sessionId,
    source,
    kind: 'execute',
  })

  try {
    addThinkingStep(trace.traceId, {
      id: 'start',
      label: 'Starting your approved plan',
      detail: `${actions.length} step${actions.length === 1 ? '' : 's'} to run`,
      status: 'done',
    })

    const results = []
    for (const [index, action] of actions.entries()) {
      throwIfAborted(signal)

      const stepId = `action-${index}`
      addThinkingStep(trace.traceId, {
        id: stepId,
        label: `Running: ${action.label || action.type}`,
        detail: action.type,
        status: 'active',
      })

      const [result] = await executeActions([action])
      results.push(result)

      addThinkingStep(trace.traceId, {
        id: stepId,
        label: result.ok
          ? `Done: ${action.label || action.type}`
          : `Failed: ${action.label || action.type}`,
        detail: result.message || result.error || '',
        status: 'done',
      })
    }

    throwIfAborted(signal)

    const status = results.every((result) => result.ok)
      ? 'success'
      : results.some((result) => result.status === 'blocked')
        ? 'blocked'
        : 'failed'

    const responseText = results.map((item) => item.message).join(' ')
    appendTurn(sessionId, {
      role: 'assistant',
      content: responseText,
      source: 'executor',
      result: responseText,
      plan: planMeta ?? null,
    })

    addThinkingStep(trace.traceId, {
      id: 'memory',
      label: 'Updating what I remember',
      status: 'active',
    })

    const logs = appendLog({ command, actions, results, status })
    const contextGraph = updateContextGraphFromExecution({
      command,
      actions,
      results,
    })

    let workingProject = null
    if (status === 'success') {
      const { refreshWorkingMemoryFromExecution } = await import(
        './projectMemory.js'
      )
      workingProject = refreshWorkingMemoryFromExecution({
        command,
        actions,
        results,
      })
    }

    addThinkingStep(trace.traceId, {
      id: 'memory',
      label: 'Memory updated',
      detail: `${contextGraph.entities?.length ?? 0} remembered items`,
      status: 'done',
    })

    const thinking = finishThinkingTrace(trace.traceId, {
      status: status === 'success' ? 'done' : 'failed',
      summary: responseText,
    })

    return {
      ok: status === 'success',
      status,
      results,
      logs,
      contextGraph,
      workingProject,
      response: responseText,
      sessionId,
      thinking,
    }
  } catch (error) {
    if (error?.name === 'JobCancelledError' || error?.code === 'JOB_CANCELLED') {
      const thinking = finishThinkingTrace(trace.traceId, {
        status: 'failed',
        summary: error.message || 'Cancelled from dashboard',
      })
      error.thinking = thinking
      throw error
    }
    finishThinkingTrace(trace.traceId, {
      status: 'failed',
      summary: error.message,
    })
    throw error
  }
}

function isInstantInfoPlan(plan) {
  if (plan.status === 'instant' && plan.response) {
    return false
  }
  const actions = Array.isArray(plan.actions) ? plan.actions : []
  return (
    actions.length > 0 &&
    actions.every((action) => INSTANT_INFO_TYPES.has(action.type))
  )
}

async function realizeInstantInfoPlan(plan, { traceId, command }) {
  const { executeActions } = await import('./executor.js')

  addThinkingStep(traceId, {
    id: 'act',
    label: 'Running info tools',
    detail: plan.actions.map((action) => action.type).join(', '),
    status: 'active',
  })

  const results = await executeActions(plan.actions)
  const ok = results.every((result) => result.ok)
  const response = results
    .map((result) => result.message || result.error || '')
    .filter(Boolean)
    .join('\n')

  addThinkingStep(traceId, {
    id: 'act',
    label: ok ? 'Info tools finished' : 'Info tools failed',
    detail: response,
    status: 'done',
  })

  if (!ok) {
    return {
      ...plan,
      status: 'unsupported',
      error: response || 'Info tool failed',
      requiresConfirmation: true,
    }
  }

  return {
    status: 'instant',
    mode: 'llm_tool',
    command,
    requiresConfirmation: false,
    summary: response,
    response,
    actions: [],
    sideResults: results,
    planner: plan.planner ?? 'llm',
  }
}

function summarizeContext(context) {
  const bits = []
  if (context.shortTerm?.turnCount) {
    bits.push(`${context.shortTerm.turnCount} short-term turns`)
  } else if (context.recentTurns?.length) {
    bits.push(`${context.recentTurns.length} recent messages`)
  }
  if (context.workingProject?.name) {
    bits.push(`project: ${context.workingProject.name}`)
  }
  if (context.longTerm?.length) {
    bits.push(`${context.longTerm.length} long-term facts`)
  }
  if (context.memory?.latestPerson?.name) {
    bits.push(`person: ${context.memory.latestPerson.name}`)
  }
  if (context.memory?.latestEmailDraft?.name) {
    bits.push(`email: ${context.memory.latestEmailDraft.name}`)
  }
  if (context.resolvedCommand && context.resolvedCommand !== context.originalCommand) {
    bits.push('rewrote follow-up wording')
  }
  return bits.join(' · ') || 'No prior memory yet'
}

function buildContextChunks(context, command, workingCommand) {
  const now = new Date().toISOString()
  const chunks = [
    {
      id: 'ctx_cmd',
      phase: 'short_term',
      text: `command: ${command}`,
      at: now,
    },
  ]

  if (workingCommand && workingCommand !== command) {
    chunks.push({
      id: 'ctx_resolved',
      phase: 'short_term',
      text: `resolved: ${workingCommand}`,
      at: now,
    })
  }

  if (context.shortTerm?.lastUserCommand) {
    chunks.push({
      id: 'ctx_last_user',
      phase: 'short_term',
      text: `last user: ${String(context.shortTerm.lastUserCommand).slice(0, 160)}`,
      at: now,
    })
  }

  for (const [index, turn] of (context.recentTurns ?? []).slice(-4).entries()) {
    chunks.push({
      id: `ctx_turn_${index}`,
      phase: 'short_term',
      text: `${turn.role}: ${String(turn.content || '').slice(0, 140)}`,
      at: now,
    })
  }

  if (context.workingProject) {
    chunks.push({
      id: 'ctx_project',
      phase: 'working_project',
      text: `active project → ${context.workingProject.name}${
        context.workingProject.path ? ` @ ${context.workingProject.path}` : ''
      }`,
      at: now,
    })
    if (context.workingProject.summary) {
      chunks.push({
        id: 'ctx_project_summary',
        phase: 'working_project',
        text: `summary → ${String(context.workingProject.summary).slice(0, 180)}`,
        at: now,
      })
    }
    for (const [index, thread] of (context.workingProject.openThreads || [])
      .slice(0, 3)
      .entries()) {
      chunks.push({
        id: `ctx_thread_${index}`,
        phase: 'working_project',
        text: `thread → ${thread.title}${
          thread.lastNote ? `: ${String(thread.lastNote).slice(0, 100)}` : ''
        }`,
        at: now,
      })
    }
  }

  for (const [index, entity] of (context.longTerm || []).slice(0, 8).entries()) {
    chunks.push({
      id: `ctx_lt_${index}`,
      phase: 'long_term',
      text: `${entity.type} → ${entity.name}`,
      at: now,
    })
  }

  if (chunks.length === 1) {
    chunks.push({
      id: 'ctx_empty',
      phase: 'context',
      text: 'No prior turns or memory entities for this session',
      at: now,
    })
  }

  return chunks
}

function summarizePlan(plan) {
  if (plan.summary) return plan.summary
  if (plan.response) return plan.response
  if (plan.actions?.length) {
    return plan.actions
      .slice(0, 4)
      .map((action) => action.label || action.type)
      .join(' → ')
  }
  return 'Plan ready'
}

function extractPlanDiscoveries(partial) {
  const text = String(partial || '')
  const labels = [...text.matchAll(/"label"\s*:\s*"((?:\\.|[^"\\])*)"/g)].map(
    (match) => match[1].replace(/\\"/g, '"'),
  )
  const types = [...text.matchAll(/"type"\s*:\s*"((?:\\.|[^"\\])*)"/g)].map(
    (match) => match[1],
  )
  return {
    labels: [...new Set(labels)],
    types: [...new Set(types)],
  }
}

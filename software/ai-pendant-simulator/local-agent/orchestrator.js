import {
  attachmentsPromptBlock,
  describeAttachmentProblems,
  prepareAttachments,
} from './attachments.js'
import { prepareCallerContext } from './callerContext.js'
import { buildConversationContext } from './conversationContext.js'
import { describeResume, resumeContext } from './contextResume.js'
import { recordGapSafely } from './capabilityGapInbox.js'
import { applyGoalVerdict } from './goalVerdict.js'
import { planCommand } from './llmPlanner.js'
import { rememberDomainFact } from './memoryService.js'
import { extractDomainFacts } from '../shared/domainCapture.js'
import {
  TIER_BACKGROUND,
  TIER_DETERMINISTIC,
  TIER_PLANNER,
  classifyTier,
  matchDeterministic,
} from './policyRouter.js'
import { closeLedger, ledgerStepObserver, openLedger } from './actionLedger.js'
import { recordRouting } from './routingStats.js'
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

/* Escape hatch: PENDANT_FAST_PATH=off sends every request back through the
 * planner, which is the only way to A/B the router without a code change. */
const FAST_PATH_ENABLED = process.env.PENDANT_FAST_PATH !== 'off'

export async function orchestratePlan({
  command: rawCommand,
  sessionId,
  source = 'local',
  signal = null,
  /*
   * Handle to a reasoning thread another body already built (the relay's voice
   * session, usually). Optional in the strongest sense: it is spent on a best
   * effort and a miss is a cold start, which is what every plan did before it
   * existed.
   */
  contextHandle = null,
  /*
   * Absolute paths the HUD attached (mac-menubar 06171f1). Vetted before any
   * other work: each must exist and be a regular file, and credential paths
   * are refused by name — attachments.js says why. When the array is present
   * the redundant " [attached: …]" suffix is stripped from the command so the
   * model sees each path exactly once, in the attachments block.
   */
  attachments = null,
  /*
   * What the CALLER's surface was looking at: {page:{url,title}}. Distinct from
   * `context` below, which is what this agent REMEMBERS (chat, facts, people) —
   * one is the other end's screen, the other is our memory.
   *
   * Settled here as well as at the /plan boundary, and the settling is
   * idempotent, so every entry point is correct on its own rather than each
   * depending on the last to have cleaned up.
   */
  callerContext = null,
}) {
  const { throwIfAborted } = await import('./jobControl.js')
  const caller = prepareCallerContext({ command: rawCommand, context: callerContext })
  const prepared = prepareAttachments({ command: caller.command, attachments })
  const command = prepared.command
  const attachmentPaths = prepared.attachments.map((file) => file.path)
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

  // Wall clock for the whole routing decision, not just the model call — the
  // fast path's win is that it never reaches the model, so timing only the
  // model would report zero.
  const routeStartedAt = Date.now()

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

    /*
     * Attachments are settled before any context is built or model is asked:
     * one bad path fails the whole request, loudly. Planning around a missing
     * file yields a plan that reads a file that is not there, and planning
     * with "the attachments that survived" is a request the owner never made.
     */
    if (prepared.problems.length) {
      const refusal = describeAttachmentProblems(prepared.problems)
      addThinkingStep(trace.traceId, {
        id: 'attachments',
        label: 'Could not use the attached files',
        detail: refusal,
        status: 'done',
        meta: { problems: prepared.problems },
      })
      const finished = finishThinkingTrace(trace.traceId, {
        status: 'failed',
        summary: refusal,
      })
      return {
        status: 'unsupported',
        command,
        actions: [],
        requiresConfirmation: true,
        error: refusal,
        planner: 'attachments',
        attachments: attachmentPaths,
        attachmentProblems: prepared.problems,
        sessionId: activeSessionId,
        thinking: finished,
      }
    }

    if (prepared.attachments.length) {
      addThinkingStep(trace.traceId, {
        id: 'attachments',
        label: `Attached ${prepared.attachments.length} file${
          prepared.attachments.length === 1 ? '' : 's'
        }`,
        detail: attachmentPaths.join(', '),
        status: 'done',
        meta: { attachments: attachmentPaths },
      })
    }

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

    /*
     * Pick the cheapest path that reaches the same result. This never refuses
     * anything: a deterministic hit is a claim that no planner could do better,
     * and every other tier is just a starting point that can escalate.
     *
     * A request with attachments always goes to the planner: the deterministic
     * templates know nothing about attached files, so a fast-path hit would run
     * a plan that ignores the very files the owner just handed over.
     */
    const deterministic =
      FAST_PATH_ENABLED && !prepared.attachments.length
        ? await matchDeterministic(workingCommand).catch(() => null)
        : null
    const route = classifyTier(workingCommand, { source, deterministic })

    addThinkingStep(trace.traceId, {
      id: 'route',
      label: `Routed to the ${route.tier} tier`,
      detail: route.reason,
      status: 'done',
      meta: { tier: route.tier, intent: deterministic?.intent ?? null },
      chunks: [
        {
          id: 'route_tier',
          phase: 'route',
          text:
            route.tier === TIER_DETERMINISTIC
              ? `${deterministic.intent} → ${deterministic.actions
                  .map((action) => action.type)
                  .join(', ')} (no model call)`
              : `${route.tier} tier: ${route.reason}`,
          at: new Date().toISOString(),
        },
      ],
    })

    if (deterministic) {
      const fast = await runDeterministicPlan(deterministic, {
        traceId: trace.traceId,
        command: workingCommand,
      })

      if (fast) {
        appendTurn(activeSessionId, {
          role: 'assistant',
          content: fast.response,
          source: 'deterministic',
          result: fast.response,
        })

        const finished = finishThinkingTrace(trace.traceId, {
          status: 'done',
          summary: fast.response,
        })

        return stampRouting(
          { ...fast, context, sessionId: activeSessionId, thinking: finished },
          {
            command: workingCommand,
            tier: TIER_DETERMINISTIC,
            reason: route.reason,
            intent: deterministic.intent,
            latencyMs: Date.now() - routeStartedAt,
            usage: [],
            ok: true,
          },
        )
      }

      /*
       * The one action we were certain about did not work — a missing app, a
       * permission, a display that is asleep. Certainty was wrong, so hand the
       * request to the model rather than reporting a dead end. Costs a wasted
       * fast path in exchange for never being less capable than before.
       */
      addThinkingStep(trace.traceId, {
        id: 'route',
        label: 'Fast path failed — escalating to the planner',
        detail: `${deterministic.intent} did not succeed; asking the model instead`,
        status: 'done',
      })
    }

    const plannedTier = deterministic ? TIER_PLANNER : route.tier

    /*
     * Spent here rather than at the top of the function on purpose: the
     * deterministic fast path above never reaches a model, so a context it
     * would not read is latency the owner pays for nothing.
     */
    const resumed = contextHandle
      ? await resumeContext(contextHandle).catch(() => null)
      : null

    /*
     * No memory splice happens here any more. The projection swap that used to
     * rewrite context.promptBlock is gone with the generic memory sections it
     * projected — the owner's durable facts now ride as domain memory,
     * fetched inside llmPlanner.js at the moment a domain's tools are
     * selected. The prompt block that leaves this function is session
     * continuity plus the request, exactly as conversationContext.js built it.
     */

    /*
     * The attachments block travels exactly the way context does: appended to
     * context.promptBlock, which llmPlanner sends ahead of "Current request:"
     * and whose tail the tool-discovery pre-pass reads (so `files` gets
     * picked).
     */
    if (prepared.attachments.length) {
      context.promptBlock = [
        context.promptBlock,
        attachmentsPromptBlock(prepared.attachments),
      ]
        .filter(Boolean)
        .join('\n\n')
    }

    /*
     * The caller's page rides the same rail as attachments, for the same
     * reasons.
     *
     * This is the payoff for the `context` field existing. The page used to
     * reach the model as a bracketed trailer glued to the owner's sentence,
     * where it read as part of the request; here it is a labelled block that
     * says what it is and — the line that matters — that being on a page is
     * not the same as the task being about it.
     */
    if (caller.promptBlock) {
      context.promptBlock = [context.promptBlock, caller.promptBlock]
        .filter(Boolean)
        .join('\n\n')
      addThinkingStep(trace.traceId, {
        id: 'caller-context',
        label: 'Noted what the sender was looking at',
        detail: caller.context.page.url,
        status: 'done',
        meta: { page: caller.context.page, surface: caller.context.surface ?? null },
      })
    }

    if (contextHandle) {
      addThinkingStep(trace.traceId, {
        id: 'inherit',
        label: resumed?.resumed
          ? 'Continued a thread from another body'
          : 'Started cold',
        detail: describeResume(resumed),
        status: 'done',
        meta: {
          resumed: Boolean(resumed?.resumed),
          origin: resumed?.origin ?? null,
          originModel: resumed?.originModel ?? null,
          notes: resumed?.notes ?? [],
        },
      })
    }

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

    const onPlannerProgress = (progress) => {
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
    }

    let plan = await planCommand(workingCommand, {
      context,
      tier: plannedTier,
      onProgress: onPlannerProgress,
      resumed,
    })

    const usage = plan.usage ? [plan.usage] : []
    let effectiveTier = plannedTier
    let escalatedFrom = deterministic ? TIER_DETERMINISTIC : null

    /*
     * The cheap tier plans against a trimmed schema and is told to say so when
     * a request needs more. Taking it at its word — instead of shipping a plan
     * it hedged on — is what makes the small tier safe to try first: the owner
     * pays two cheap-ish calls in the miss case and never loses a capability.
     */
    if (plannedTier === TIER_BACKGROUND && needsEscalation(plan)) {
      addThinkingStep(trace.traceId, {
        id: 'escalate',
        label: 'Escalating to the full planner',
        detail: plan.error || 'The small tier did not produce a usable plan',
        status: 'done',
      })
      escalatedFrom = TIER_BACKGROUND
      effectiveTier = TIER_PLANNER
      lastPartial = ''
      plan = await planCommand(workingCommand, {
        context,
        tier: TIER_PLANNER,
        onProgress: onPlannerProgress,
        resumed,
      })
      if (plan.usage) usage.push(plan.usage)
    }

    /*
     * Every way out of this function spreads `plan`, so stamping once here
     * puts the vetted paths on the ready plan, the instant answer and the
     * unsupported refusal alike — which is what the job store and the
     * dashboards read back as "this run had these files".
     */
    if (attachmentPaths.length) {
      plan = { ...plan, attachments: attachmentPaths }
    }

    const routing = () => ({
      command: workingCommand,
      tier: effectiveTier,
      reason: route.reason,
      intent: deterministic?.intent ?? null,
      latencyMs: Date.now() - routeStartedAt,
      escalatedFrom,
      usage,
    })

    if (plan.status === 'unsupported') {
      /*
       * The ask used to evaporate right here — folded into a thinking step and
       * never seen by the design loop. File it as a capability gap before
       * answering. recordGapSafely never throws; recording a refusal must not
       * be able to break the refusal.
       */
      recordGapSafely({
        source: 'planner-unsupported',
        want: workingCommand,
        detail: plan.error || 'Unsupported request',
        surface: source,
      })
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
      return stampRouting(
        {
          ...plan,
          context,
          sessionId: activeSessionId,
          thinking: finished,
        },
        { ...routing(), ok: false },
      )
    }

    // Info-only tools: run immediately, skip confirm.
    if (isInstantInfoPlan(plan)) {
      plan = await realizeInstantInfoPlan(plan, {
        traceId: trace.traceId,
        command: workingCommand,
      })
      /* The realizer deliberately rebuilds the plan from scratch, which drops
       * the stamp applied above; the run still had its files. */
      if (attachmentPaths.length) {
        plan = { ...plan, attachments: attachmentPaths }
      }
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

      return stampRouting(
        {
          ...plan,
          context,
          sessionId: activeSessionId,
          thinking: finished,
        },
        routing(),
      )
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

    return stampRouting(
      {
        ...plan,
        context,
        sessionId: activeSessionId,
        thinking: finished,
      },
      routing(),
    )
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
  const jobControl = await import('./jobControl.js')
  const { runWithCancellation, throwIfAborted } = jobControl
  const { stripImageBytes } = await import('./screenCapture.js')
  const { runFocusSafePlan } = await import('./focusCoordinator.js')

  const trace = startThinkingTrace({
    command,
    sessionId,
    source,
    kind: 'execute',
  })

  /*
   * Closing the manifest, on every path out of this function.
   *
   * The ledger's whole recovery story rests on "a run still open is a run that
   * never came back", and that sentence is only true if a run that DID come back
   * says so. Nothing on this path used to, so every ordinary /execute stayed
   * open forever and `GET /ledger/interrupted` returned the entire history.
   *
   * Latched, because the three exits overlap: the success return names the
   * status it computed, the catch names cancelled-or-failed, and the finally is
   * the backstop for any path that reaches neither. First one to arrive wins,
   * and it swallows its own failures for the same reason the observer does —
   * bookkeeping never gets to be the thing that breaks the owner's plan.
   */
  let ledgerId = null
  let ledgerClosed = false
  const closeRun = (status, outcome) => {
    if (!ledgerId || ledgerClosed) return
    ledgerClosed = true
    try {
      closeLedger(ledgerId, { status, outcome })
    } catch (error) {
      console.warn('action ledger could not be closed:', error?.message || error)
    }
  }

  try {
    addThinkingStep(trace.traceId, {
      id: 'start',
      label: 'Starting your approved plan',
      detail: `${actions.length} step${actions.length === 1 ? '' : 's'} to run`,
      status: 'done',
    })

    // The coordinator still hands the executor one action at a time, so the
    // per-step trace and the per-action receipts are exactly what they were. It
    // adds the foreground watch around them: UI steps aimed at the app the plan
    // named instead of at whoever happens to be in front, and a stop if that app
    // goes away mid-plan. It cannot ask anyone anything.
    /*
     * The manifest is written and fsynced before the executor sees anything.
     *
     * /journal, receipts and undo are all derived AFTER an action runs, and the
     * derivation is right — but absence of a receipt cannot tell "never
     * dispatched" from "dispatched, then we crashed", and those two want
     * opposite recoveries. Recording the intent first is the only thing that
     * separates them. focusCoordinator awaits onStep before execute([action])
     * and again after it returns, which is exactly the crash boundary, so the
     * observer composes in without executor.js or focusPolicy.js changing.
     */
    let recordStep = null
    try {
      const ledger = openLedger({
        command,
        actions,
        jobId: jobIdForRun({ planMeta, signal, jobControl }),
        sessionId: sessionId ?? null,
        source,
      })
      ledgerId = ledger.ledgerId
      recordStep = ledgerStepObserver(ledger)
    } catch (error) {
      /* Bookkeeping must never stop the owner's work. A plan that cannot be
       * recorded still runs; it simply cannot be resumed, which is strictly
       * better than refusing to act because the notebook is full. */
      console.warn('action ledger unavailable:', error?.message || error)
    }

    const { results, receipt: focus } = await runFocusSafePlan(actions, {
      /*
       * The job's cancel signal, carried down to whatever spawns a child
       * process. `throwIfAborted` below only ever fires between steps, so
       * without this a cancel could not touch the step already running.
       * executor.js takes one argument and stays that way; the scope is how
       * the signal gets past it.
       */
      execute: (batch) => runWithCancellation(signal, () => executeActions(batch)),
      onStep: async ({ phase, seq, action, result }) => {
        /* Awaited first, so "pending means it never ran" stays true. */
        await recordStep?.({ phase, seq, action, result })

        const stepId = `action-${seq}`

        if (phase === 'start') {
          throwIfAborted(signal)
          addThinkingStep(trace.traceId, {
            id: stepId,
            label: `Running: ${action.label || action.type}`,
            detail: action.type,
            status: 'active',
          })
          return
        }

        addThinkingStep(trace.traceId, {
          id: stepId,
          label: result.ok
            ? `Done: ${action.label || action.type}`
            : `Failed: ${action.label || action.type}`,
          detail: result.message || result.error || '',
          status: 'done',
        })
      },
    })

    throwIfAborted(signal)

    if (focus.drift) {
      addThinkingStep(trace.traceId, {
        id: 'focus-drift',
        label: 'Stopped: the screen changed under the plan',
        detail: focus.drift.detail,
        status: 'done',
      })
    }

    // Drift means the plan did not finish, whatever the steps that did run said.
    const stepStatus = focus.drift
      ? 'failed'
      : results.every((result) => result.ok)
        ? 'success'
        : results.some((result) => result.status === 'blocked')
          ? 'blocked'
          : 'failed'

    /*
     * "Every planned step ran" is not "the goal was met" — that gap is the
     * 2026-08-09 IBKR incident: a plan that opened a brokerage and snapshotted
     * the page was stamped done against "cancel my recurring investments", and
     * nothing was cancelled. The verdict compares the STATED GOAL against the
     * effects the steps actually achieved (goalVerdict.js, standing on the
     * same per-step results the journal derives from). A clean run whose goal
     * never got an acting step is 'incomplete', never 'success', and its
     * response names what WAS done and what was NOT. Failures, blocks and
     * drift pass through untouched — they were already honest.
     */
    const { status, verdict, response: verdictResponse } = applyGoalVerdict({
      command,
      actions,
      results,
      status: stepStatus,
    })

    const responseText =
      verdictResponse ??
      [...results.map((item) => item.message), focus.drift?.detail]
        .filter(Boolean)
        .join(' ')

    if (verdict.goal.wantsChange) {
      addThinkingStep(trace.traceId, {
        id: 'goal-check',
        label: verdict.met
          ? 'Goal check: the change you asked for ran'
          : 'Goal check: the goal was not completed',
        detail: verdict.met
          ? `An acting step aimed at "${verdict.goal.gerundPhrase}" ran and reported success.`
          : verdict.summary,
        status: 'done',
        meta: {
          met: verdict.met,
          carriers: verdict.carriers,
          remainderNeedsApproval: Boolean(verdict.remainder?.needsApproval),
        },
      })
    }

    /* The plan is over. Said here rather than after the memory writes below,
     * because every one of those can throw and none of them changes what the
     * run did — a ledger left open by a failed context-graph write would be
     * reported as an abandoned automation, which it is not. */
    closeRun(status === 'success' ? 'settled' : status, responseText || null)

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

    // Screenshot bytes must never reach anything durable: the activity log, the
    // context graph and the job store all persist to disk, and the context
    // graph is what the cloud relay syncs. Strip once, here, at the choke point
    // every sink flows through.
    const persistableResults = stripImageBytes(results)
    const logs = appendLog({
      command,
      actions,
      results: persistableResults,
      status,
    })
    const contextGraph = updateContextGraphFromExecution({
      command,
      actions,
      results: persistableResults,
    })

    /*
     * SELECTIVE CAPTURE AT RUN-SETTLE. The owner's rule, verbatim: "when
     * there's a likely chance that i'm gonna use this connection or the same
     * tasks again, then it should save it." shared/domainCapture.js reads the
     * settled run and lifts out only the reusable shapes — stated identities,
     * connections actually used, repeated task shapes — deduped by key. NOT
     * chat logs, not page contents. Wrapped whole: capture must never throw a
     * settled run, whatever the store is doing.
     */
    let domainFactCount = 0
    try {
      const captured = extractDomainFacts({
        command,
        actions,
        results: persistableResults,
        ok: status === 'success',
        node: 'mac',
      })
      for (const fact of captured) {
        rememberDomainFact(fact, { origin: 'domain-capture' })
      }
      domainFactCount = captured.length
    } catch (error) {
      console.warn('domain capture skipped:', error?.message || error)
    }

    let workingProject = null
    if (status === 'success') {
      const { refreshWorkingMemoryFromExecution } = await import(
        './projectMemory.js'
      )
      workingProject = refreshWorkingMemoryFromExecution({
        command,
        actions,
        results: persistableResults,
      })
    }

    addThinkingStep(trace.traceId, {
      id: 'memory',
      label: 'Memory updated',
      detail:
        `${contextGraph.entities?.length ?? 0} remembered items` +
        (domainFactCount ? ` · ${domainFactCount} domain facts` : ''),
      status: 'done',
    })

    const thinking = finishThinkingTrace(trace.traceId, {
      /* 'incomplete' is passed through by name: renderers that key on 'done'
       * must never say Done over a goal that was not met. */
      status:
        status === 'success'
          ? 'done'
          : status === 'incomplete'
            ? 'incomplete'
            : 'failed',
      summary: responseText,
    })

    return {
      ok: status === 'success',
      status,
      /* server.js records `payload.error || payload.status` for a non-ok run,
       * so the job store's row carries the sentence that names what was and
       * was not done — not just the word 'incomplete'. */
      ...(status === 'incomplete' ? { error: responseText } : {}),
      /* The goal-grounded verdict, including the needs_approval-compatible
       * remainder the approval-at-origin flow can pick up. */
      verdict,
      results,
      logs,
      contextGraph,
      workingProject,
      response: responseText,
      sessionId,
      thinking,
      // Carries no copy of `results`, so it never sails past stripImageBytes on
      // its way into the job store. executionJournal reads it back from there
      // rather than keeping a second copy of its own.
      focus,
    }
  } catch (error) {
    const cancelled = error?.name === 'JobCancelledError' || error?.code === 'JOB_CANCELLED'
    /* A throw is still an ending, and a process that can run a catch block is
     * still alive to say so. Only a run whose process stops existing gets to
     * leave the manifest open — that is the whole distinction the resume path
     * turns on. The steps are untouched: one left `inflight` here really was
     * dispatched and really never answered. */
    closeRun(cancelled ? 'cancelled' : 'failed', error?.message ?? String(error))

    if (cancelled) {
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
  } finally {
    /* Unreachable if either branch above ran, which is the point: it exists for
     * the path nobody thought of. A ledger this process opened and did not close
     * would be read as an abandoned run by a process that is demonstrably still
     * here to execute a finally. */
    closeRun('abandoned', 'The run left the orchestrator without recording an outcome.')
  }
}

/*
 * WHICH JOB THIS RUN BELONGS TO.
 *
 * `planMeta` is built by the pendant (bridge.js) before the request is sent, so
 * it cannot contain the job id — the id does not exist until server.js calls
 * jobTracker.recordJobStart() on arrival. Reading `planMeta.jobId` therefore
 * produced null on every run ever made, and a ledger with no jobId cannot answer
 * "which job wrote this file".
 *
 * NO SECOND ID SCHEME. jobTracker mints `local_<uuid>` and that stays the
 * identity of a run. The join is one server.js already makes and hands us: it
 * registers the job's AbortController under that id, then passes that same
 * controller's signal into this function. Object identity on the signal is an
 * exact match — not a fuzzy one on command text, which two identical concurrent
 * requests would collide on.
 *
 * A caller that already knows its job id wins, because it knows better than a
 * lookup. A caller with neither (routines.js runs plans that were never
 * registered as jobs at all) gets null, which is the honest answer: there is no
 * job, rather than a plausible-looking id belonging to somebody else's run.
 */
function jobIdForRun({ planMeta, signal, jobControl }) {
  const declared = String(planMeta?.jobId ?? '').trim()
  if (declared) return declared
  if (!signal || typeof jobControl?.listActiveJobIds !== 'function') return null

  for (const jobId of jobControl.listActiveJobIds()) {
    if (jobControl.getActiveJob?.(jobId)?.abortController?.signal === signal) return jobId
  }
  return null
}

/**
 * Attach the routing receipt to the plan and add it to the running totals.
 *
 * The receipt rides on the plan itself rather than living only in the stats
 * endpoint because the owner asked to SEE which tier answered — and the place
 * they see a plan is the plan.
 */
function stampRouting(plan, meta) {
  const entry = recordRouting(meta)
  return {
    ...plan,
    routing: {
      tier: entry.tier,
      reason: entry.reason,
      intent: entry.intent,
      latencyMs: entry.latencyMs,
      escalatedFrom: entry.escalatedFrom,
      llmCalls: entry.llmCalls,
      estimatedPromptTokens: entry.promptTokens,
      estimatedCompletionTokens: entry.completionTokens,
      estimatedCostUsd: entry.costUsd,
      models: entry.calls.map((call) => call.model),
    },
  }
}

/* The small tier is told to bail out rather than improvise past its schema, so
 * "unsupported" and "nothing at all" both mean: this one needs the big model. */
function needsEscalation(plan) {
  if (!plan) return true
  if (plan.status === 'unsupported') return true
  return !plan.actions?.length && !plan.response
}

/**
 * Run the one action the router was sure about. Returns null when it did not
 * work, which is the caller's signal to fall back to the model.
 *
 * Executing here rather than handing actions back mirrors what /plan already
 * does for get_weather / get_time / translate_text: when there is nothing to
 * decide, a round trip to ask permission to do the obvious thing is latency the
 * owner pays for nothing. Callers see the familiar instant shape (empty
 * `actions`, filled `response`), so none of them execute it a second time.
 */
async function runDeterministicPlan(deterministic, { traceId, command }) {
  const { executeActions } = await import('./executor.js')
  const { stripImageBytes } = await import('./screenCapture.js')

  addThinkingStep(traceId, {
    id: 'act',
    label: 'Running it directly',
    detail: deterministic.actions.map((action) => action.label).join(', '),
    status: 'active',
  })

  const results = await executeActions(deterministic.actions)
  const ok = results.every((result) => result.ok)
  const response = results
    .map((result) => result.message || result.error || '')
    .filter(Boolean)
    .join('\n')

  addThinkingStep(traceId, {
    id: 'act',
    label: ok ? 'Done — no model was needed' : 'Direct run failed',
    detail: response,
    status: 'done',
  })

  if (!ok) return null

  return {
    status: 'instant',
    mode: 'deterministic',
    command,
    requiresConfirmation: false,
    summary: response,
    response,
    actions: [],
    // Image bytes never reach here in practice, but /plan writes its result to
    // the durable job store, so strip at the boundary like orchestrateExecute.
    sideResults: stripImageBytes(results),
    planner: 'deterministic',
    fullControl: true,
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

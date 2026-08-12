/*
 * THE CONSOLE/MESH HALF, SHARED BY BOTH ENGINES.
 *
 * Extracted verbatim from background.js on 2026-08-12 for the same reason
 * executor.js was: on the owner's Safari the background never evaluates, so
 * the popup and the standalone console must be able to run the owner's
 * commands, the brain loop, plan decisions, approval decisions and the relay
 * drain THEMSELVES — and they must run this exact code, not a fork.
 *
 * Per-context state lives at module scope on purpose (each bundle context is
 * its own incarnation): the history/approval write chains, the journal
 * instance, the brain cooldown. Anything that must be IDENTICAL across
 * contexts comes from storage (config identity, relay deviceId), and anything
 * that must be PER-INCARNATION (the replay ledger, mac freshness) is a
 * parameter threaded through by the caller.
 */
import { commandIdentity } from './bridge-core.js'
import {
  CONSOLE_SOURCE,
  EXECUTE_TIMEOUT_MS,
  HISTORY_KEY,
  PLAN_TIMEOUT_MS,
  SESSION_KEY,
  appendHistory,
  buildCommandText,
  commandContext,
  interpretExecuteResponse,
  interpretPlanResponse,
  localStepPending,
  newHistoryEntry,
  outcomeToPatch,
  patchHistory,
  planDecisionPreflight,
  scrubPageContext,
} from './command-console.js'
import {
  CAPABILITY_BROWSER,
  EFFECT_OUTWARD,
  createOutwardGuard,
  honestVerdict,
  routePlan,
} from './affinity.js'
import {
  BRAIN_MAX_STEPS,
  compactToolResult,
  createBrainTranscript,
  describeInferFailure,
  inferRequest,
  parseBrainReply,
  readInferPayload,
} from './brain.js'
import {
  createExecutionJournal,
  hiveClaimRecordFor,
  hiveVerdictRecordFor,
} from './execution-status.js'
import {
  BRIDGE_PING_FRAME,
  BRIDGE_PING_INTERVAL_MS,
  RELAY_STORAGE_KEYS,
  acceptEnvelopes,
  ackRequest,
  createEnvelopeLedger,
  envelopeToCommand,
  hasMoreMail,
  inboxRequest,
  normalizeRelayConfig,
  pongMessageFor,
  pruneEnvelopeLedger,
  reactToFrame,
  relayResponseError,
  resultMessageFor,
  socketProtocolAccepted,
  socketProtocols,
  socketUrl,
} from './relay-peer.js'
import {
  APPROVALS_KEY,
  mergeApprovalPrompts,
  prepareApprovalDecision,
} from './approvals.js'
import {
  FETCH_TIMEOUT_MS,
  browserLabel,
  executeCommand,
  getConfig,
  refreshBadge,
  updateRelayStatus,
} from './executor.js'

const api = globalThis.browser ?? globalThis.chrome

/* Survives the worker restarts the 60 s inbox lease is measured against — see
 * createEnvelopeLedger's note on why this one cannot live in module scope. */
export const RELAY_LEDGER_KEY = 'relaySeenEnvelopes'

export async function getRelayConfig() {
  return normalizeRelayConfig(await api.storage.local.get(RELAY_STORAGE_KEYS))
}

export async function relayFetch(relayConfig, descriptor, timeoutMs = FETCH_TIMEOUT_MS) {
  const response = await fetch(`${relayConfig.relayUrl}${descriptor.path}`, {
    method: descriptor.method,
    cache: 'no-store',
    headers: {
      Accept: 'application/json',
      /* The device token, on the wire, in a header — never in the path or a
       * query string, which is why inboxRequest carries only the deviceId. */
      Authorization: `Bearer ${relayConfig.deviceToken}`,
      ...(descriptor.body ? { 'Content-Type': 'application/json' } : {}),
    },
    ...(descriptor.body ? { body: JSON.stringify(descriptor.body) } : {}),
    signal: AbortSignal.timeout(timeoutMs),
  })

  if (!response.ok) {
    // Tested in relay-peer: carries message, status and the relay's `code`
    // (e.g. not_your_inbox) so describeRelayFailure can sharpen the fix.
    throw await relayResponseError(response)
  }

  return response.status === 204 ? null : await response.json()
}

/*
 * storage.local has no transactions, so every read-modify-write of the
 * approval list rides one chain, exactly like the console history below: a
 * doorbell drain and a popup decision finishing together must not eat each
 * other's cards. Unlike withHistory this returns the caller's own result and
 * rethrows its error — a decision needs to know whether it went through —
 * while the chain itself swallows the failure so the next write still runs.
 */
let approvalWrites = Promise.resolve()

export function withApprovals(mutate) {
  const run = approvalWrites.then(async () => {
    const values = await api.storage.local.get(APPROVALS_KEY)
    const next = await mutate(values[APPROVALS_KEY] ?? [])
    /* null means "nothing changed" — skip the write, and with it a popup
     * re-render and a storage.onChanged fan-out that would say nothing. */
    if (next) await api.storage.local.set({ [APPROVALS_KEY]: next })
    return next
  })
  approvalWrites = run.then(
    () => {},
    (error) => {
      console.warn('approval store write failed:', error?.message || error)
    },
  )
  return run
}

/**
 * The owner's answer to one approval card, from the popup.
 *
 * Order is the contract: SEND the decision, THEN persist the settle, THEN ack
 * the request envelope. A decision recorded but never sent would read as
 * answered while the requester waits forever; a decision sent but not
 * recorded merely invites a duplicate answer, which the relay's approvalId
 * makes idempotent — so the settle waits for the send. The whole
 * check-send-settle runs inside the approval write chain, which is what makes
 * two frantic clicks land as one answer and one "answered once" refusal.
 */
export async function decideApproval({ approvalId, decision }) {
  const relayConfig = await getRelayConfig()
  if (!relayConfig.ready) {
    return { ok: false, error: relayConfig.reason || 'The relay peer is switched off.' }
  }

  let outcome = { ok: false, error: 'The decision was not sent.' }
  try {
    await withApprovals(async (stored) => {
      const prepared = prepareApprovalDecision(stored, String(approvalId ?? ''), decision, {
        config: relayConfig,
      })
      if (!prepared.ok) {
        outcome = { ok: false, error: prepared.error }
        return null
      }

      await relayFetch(relayConfig, prepared.request)

      /* Ack AFTER the send. Usually a no-op — the drain acked on receipt —
       * but it covers a re-sent copy the store adopted after that ack, and a
       * failed ack costs one redelivery the approvalId dedupe absorbs. */
      try {
        await relayFetch(relayConfig, ackRequest(relayConfig, [prepared.envelopeId]))
      } catch {
        /* The lease will lapse; the settled card swallows the redelivery. */
      }

      outcome = { ok: true, decision }
      return prepared.prompts
    })
  } catch (error) {
    outcome = { ok: false, error: error?.message || String(error) }
  }

  await refreshBadge()
  return outcome
}

/* ===================================================================== *
 * The mesh drain — parameterized by incarnation context.
 *
 * `ctx` is { ledger, macFresh }: the caller's replay ledger (per-incarnation
 * by design — see createCommandLedger) and a closure answering "has the Mac
 * answered this context recently", which the pong reports. Bodies are
 * verbatim from background.js; only those two seams were threaded.
 * ===================================================================== */

export async function runMeshEnvelope(envelope, handling, relayConfig, macConfig, ctx) {
  /*
   * An approval_request is RENDERED, never executed: fold it into the stored
   * card list (dedupe by approvalId — at-least-once re-sends the same
   * question under new envelope ids) and put the count on the badge. No
   * answer goes back from here; the answer is the owner's button in the
   * popup, which arrives later as 'approval:decide'. The request envelope was
   * already acked by drainRelayOnce — an ack means "I have this" — and the
   * decision path acks once more after its send, per the contract.
   */
  if (handling === 'approval') {
    const changed = await withApprovals((stored) => {
      const merged = mergeApprovalPrompts(stored, [envelope])
      return merged.changed ? merged.prompts : null
    })
    if (changed) await refreshBadge()
    return
  }

  if (handling === 'ping') {
    await relayFetch(
      relayConfig,
      pongMessageFor(
        envelope,
        {
          browser: browserLabel(),
          extensionVersion: api.runtime.getManifest().version,
          macFresh: Boolean(ctx.macFresh?.()),
          observedAt: new Date().toISOString(),
        },
        relayConfig,
      ),
    )
    return
  }

  let outcome
  try {
    const command = envelopeToCommand(envelope)
    /* The same replay check the Mac path runs, over the same ledger: a mesh
     * redelivery and an agent re-poll are the same hazard wearing two hats. */
    const identity = commandIdentity(command)
    const replayed = ctx.ledger.recall(identity)
    if (replayed) {
      outcome = { ...replayed.result, replayed: true }
    } else {
      try {
        outcome = { ok: true, result: await executeCommand(command, macConfig) }
      } catch (error) {
        outcome = { ok: false, error: error?.message || String(error) }
      }
      ctx.ledger.remember(identity, outcome)
    }
  } catch (error) {
    outcome = { ok: false, error: error?.message || String(error) }
  }

  await relayFetch(relayConfig, resultMessageFor(envelope, outcome, relayConfig))
}

export async function drainRelayOnce(relayConfig, macConfig, ctx) {
  const page = await relayFetch(relayConfig, inboxRequest(relayConfig))
  const stored = (await api.storage.local.get(RELAY_LEDGER_KEY))[RELAY_LEDGER_KEY] ?? {}
  const accepted = acceptEnvelopes(page?.messages, {
    ledger: createEnvelopeLedger(stored),
    config: relayConfig,
  })

  /*
   * Written BEFORE anything runs, for the reason commandLedger.remember is
   * called before the result POST: the step that fails is the one after this,
   * and forgetting that a click happened costs the owner a second click on a
   * real page, while forgetting a result costs one repeated read.
   */
  await api.storage.local.set({
    [RELAY_LEDGER_KEY]: pruneEnvelopeLedger(accepted.ledger),
  })

  /*
   * Everything drained is acked, including what this node refused to run. An
   * ack means "I have this", not "I did this" — leaving a refusal unacked
   * would redeliver it every 60 s until the inbox hit MAX_INBOX_DEPTH and
   * started rejecting the sends that mattered.
   */
  if (accepted.ackIds.length) {
    await relayFetch(relayConfig, ackRequest(relayConfig, accepted.ackIds))
  }

  for (const { envelope, handling } of accepted.run) {
    try {
      await runMeshEnvelope(envelope, handling, relayConfig, macConfig, ctx)
    } catch (error) {
      console.warn(
        `mesh ${envelope.kind} from ${envelope.from} failed: ${error?.message || error}`,
      )
    }
  }

  return {
    drained: accepted.ackIds.length,
    ran: accepted.run.length,
    ignored: accepted.ignored.length,
    /*
     * NOT `pending > 0`. The relay's `pending` counts the page it just leased
     * you — a one-message drain reports pending:1 and only reads 0 after the
     * ack — so a caller looping on it never terminates. hasMoreMail does the
     * comparison that actually means "come back". Measured, not assumed.
     */
    more: hasMoreMail(page),
    pending: Number(page?.pending || 0),
  }
}

/* Drain until the inbox is genuinely empty, bounded so a relay that keeps
 * reporting more can never hold this context forever. */
export async function drainRelayUntilEmpty(relayConfig, macConfig, ctx, maxPages = 5) {
  let report = await drainRelayOnce(relayConfig, macConfig, ctx)
  let totals = { ...report, pages: 1 }
  for (let page = 1; page < maxPages && report.more; page += 1) {
    report = await drainRelayOnce(relayConfig, macConfig, ctx)
    totals = {
      drained: totals.drained + report.drained,
      ran: totals.ran + report.ran,
      ignored: totals.ignored + report.ignored,
      more: report.more,
      pending: report.pending,
      pages: page + 1,
    }
  }
  return totals
}

/**
 * The mesh doorbell, as a controller each context holds for its own lifetime.
 *
 * Bodies verbatim from background.js's ensureMeshSocket/closeMeshSocket; the
 * module-level socket globals became closure state so the background worker
 * and a page engine can each hold their own doorbell without sharing wires.
 * The refusal latch (1008/4001/4003) lives here too: a credential the relay
 * will not accept must not be retried on every tick, and clearRefusal() is
 * how a pasted re-pair lifts it.
 */
export function createMeshSocket() {
  let socket = null
  let open = false
  let pingTimer = null
  let refused = false

  const close = () => {
    if (pingTimer) {
      clearInterval(pingTimer)
      pingTimer = null
    }
    if (socket) {
      try {
        socket.close()
      } catch {
        /* already closed */
      }
    }
    socket = null
    open = false
  }

  return {
    isOpen: () => open,
    isRefused: () => refused,
    clearRefusal() {
      refused = false
    },
    close,

    ensure(relayConfig, onMail) {
      if (socket || refused) return
      const url = socketUrl(relayConfig)
      const protocols = socketProtocols(relayConfig)
      if (!url || !protocols.length) return

      let candidate
      try {
        candidate = new WebSocket(url, protocols)
      } catch (error) {
        console.warn(`mesh socket could not be created: ${error?.message || error}`)
        return
      }
      socket = candidate

      candidate.addEventListener('open', () => {
        /* A server that echoed anything but the plain mesh name would mean the
         * token came back in a response header. Refuse rather than proceed. */
        if (!socketProtocolAccepted(candidate.protocol)) {
          console.warn('mesh socket selected an unexpected subprotocol; closing.')
          try {
            candidate.close()
          } catch {
            /* already closing */
          }
          return
        }
        open = true
        void updateRelayStatus({
          state: 'connected',
          connected: true,
          transport: 'socket',
          message: 'The relay is pushing over its own socket.',
          lastConnectedAt: new Date().toISOString(),
          error: '',
        })
        /* Cloudflare answers this from the hibernation layer, so an idle socket
         * costs a frame rather than a woken Durable Object. */
        pingTimer = setInterval(() => {
          try {
            candidate.send(BRIDGE_PING_FRAME)
          } catch {
            /* the close handler will clean up */
          }
        }, BRIDGE_PING_INTERVAL_MS)
      })

      candidate.addEventListener('message', (event) => {
        if (reactToFrame(event?.data).drain) void onMail()
      })

      candidate.addEventListener('close', (event) => {
        open = false
        socket = null
        if (pingTimer) {
          clearInterval(pingTimer)
          pingTimer = null
        }
        /*
         * 1008 is how the hub reports a refused handshake once the socket
         * exists. A credential the relay will not accept must not be retried
         * on every tick — see the war story in background.js's original.
         */
        if (event?.code === 1008 || event?.code === 4001 || event?.code === 4003) {
          refused = true
          void updateRelayStatus({
            state: 'unauthorized',
            connected: false,
            transport: 'poll',
            message: 'The relay refused this browser\'s socket credential.',
            lastErrorAt: new Date().toISOString(),
          })
        }
      })

      candidate.addEventListener('error', () => {
        /* `close` always follows; the browser gives no detail here on purpose. */
        open = false
      })
    },
  }
}

/* ===================================================================== *
 * Popup command console: the owner's own commands, sent to the Mac agent's
 * plan/execute machinery — or thought about right here by the brain loop.
 * ===================================================================== */

/*
 * storage.local has no transactions, so every read-modify-write of the
 * history list goes through this one chain; two commands finishing at the
 * same moment must not eat each other's entries.
 */
let historyWrites = Promise.resolve()

export function withHistory(mutate) {
  historyWrites = historyWrites
    .then(async () => {
      const values = await api.storage.local.get(HISTORY_KEY)
      const next = mutate(values[HISTORY_KEY] ?? [])
      await api.storage.local.set({ [HISTORY_KEY]: next })
    })
    .catch((error) => {
      console.warn('console history write failed:', error?.message || error)
    })
  return historyWrites
}

export const patchEntry = (id, patch) =>
  withHistory((history) => patchHistory(history, id, patch))

/**
 * POST one console leg to the agent and interpret the response. Unlike the
 * poll-loop `request()` this gets a long timeout: a /plan can sit in a model
 * stream for most of a minute and that is normal, not an outage.
 */
export async function consolePost(config, path, payload, timeoutMs, interpret) {
  try {
    const response = await fetch(`${config.agentUrl}${path}`, {
      method: 'POST',
      cache: 'no-store',
      headers: {
        Accept: 'application/json',
        Authorization: `Bearer ${config.agentToken}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    const body = await response.json().catch(() => null)
    return interpret({ status: response.status, payload: body })
  } catch (error) {
    return {
      kind: 'error',
      message:
        error?.name === 'TimeoutError'
          ? `The local agent did not answer within ${Math.round(timeoutMs / 1000)}s. Check the dashboard — the job may still be running.`
          : error?.message || String(error),
    }
  }
}

/*
 * One journal per context incarnation, lazily built over storage.local so a
 * run's trace survives the context being suspended mid-run.
 */
let journalInstance = null

export function executionJournal() {
  if (!journalInstance) {
    journalInstance = createExecutionJournal({ storage: api.storage.local })
  }
  return journalInstance
}

/**
 * Tell the hive about a locally executed run — the owner's rule: "it should
 * stay in the browser extension but of course it can record the task to the
 * hive." Sent as node-mesh mail addressed to '@relay', which the Mac agent
 * can NEVER claim. A record, not a job. Best effort by design.
 */
export async function recordRunToHive(runId, phase) {
  const journal = executionJournal()
  const relayConfig = await getRelayConfig()
  if (!relayConfig.ready) {
    await journal.markHiveRecord(runId, 'unconfigured')
    return
  }

  const run = (await journal.getStatus()).runs.find((entry) => entry.runId === runId)
  if (!run) return

  try {
    const descriptor =
      phase === 'claim'
        ? hiveClaimRecordFor(run, relayConfig)
        : hiveVerdictRecordFor(run, relayConfig)
    await relayFetch(relayConfig, descriptor)
    await journal.markHiveRecord(
      runId,
      phase === 'claim' ? 'claimed-recorded' : 'recorded',
    )
  } catch (error) {
    await journal.markHiveRecord(runId, `failed: ${error?.message || error}`)
  }
}

export async function handleConsoleSubmit({ command, page }) {
  const text = String(command ?? '').trim()
  if (!text) return { ok: false, error: 'Type a command first.' }

  const config = await getConfig()
  /*
   * A brain of its own is enough to accept a command. The Mac token used to be
   * the only way in, so a browser with a relay credential and no agent token
   * was told to go to settings for a peer it no longer needs.
   */
  const brain = await brainAvailability()
  if (!config.agentToken && !brain.ok) return { ok: false, needsSetup: true }

  const id = crypto.randomUUID()
  const scrubbedPage = scrubPageContext(page)
  await withHistory((history) =>
    appendHistory(history, newHistoryEntry({ id, command: text, page: scrubbedPage })),
  )

  /* The submit reply only says "accepted". The outcome lands in storage,
   * which the popup renders live — and still renders after being closed
   * and reopened, which a sendMessage reply would not survive. */
  void runConsoleCommand({ id, command: text, page: scrubbedPage, config }).catch(
    (error) =>
      patchEntry(id, {
        state: 'failed',
        headline: error?.message || String(error),
        finishedAt: new Date().toISOString(),
      }),
  )

  return { ok: true, id }
}

async function runConsoleCommand({ id, command, page, config }) {
  /*
   * THIS NODE THINKS FIRST.
   *
   * The affinity argument, one storey up from where affinity.js makes it: a
   * command typed into a browser, about a page in that browser, has no reason
   * to cross a room to be understood. The brain runs here, and the Mac is
   * asked only when this node says it cannot do it.
   */
  const brain = await brainAvailability()
  if (brain.ok) {
    await patchEntry(id, { headline: 'Thinking in this browser…' })
    const outcome = await runBrainLocally({
      id,
      command,
      page,
      config,
      relayConfig: brain.relayConfig,
    })
    if (!outcome.handoff) return

    if (!config.agentToken) {
      await patchEntry(id, {
        state: 'failed',
        headline: `This browser could not do it and there is no Mac agent configured: ${outcome.reason}`,
        finishedAt: new Date().toISOString(),
      })
      return
    }
    await patchEntry(id, { headline: `Handing this to the Mac — ${outcome.reason}` })
  } else if (!config.agentToken) {
    await patchEntry(id, {
      state: 'failed',
      headline: brain.reason,
      finishedAt: new Date().toISOString(),
    })
    return
  }

  const commandText = buildCommandText(command, page)
  /* Both channels, deliberately: `context` for an agent that has the field,
   * the trailer inside commandText for one that does not. An agent with both
   * drops the trailer — see command-console.js buildCommandText. */
  const context = commandContext(page)
  const stored = await api.storage.local.get(SESSION_KEY)
  const sessionId = String(stored[SESSION_KEY] ?? '').trim()

  const planOutcome = await consolePost(
    config,
    '/plan',
    {
      command: commandText,
      ...(context ? { context } : {}),
      ...(sessionId ? { sessionId } : {}),
      source: CONSOLE_SOURCE,
    },
    PLAN_TIMEOUT_MS,
    interpretPlanResponse,
  )

  /* The agent minted (or confirmed) the conversation; keep following it. */
  if (planOutcome.sessionId) {
    await api.storage.local.set({ [SESSION_KEY]: planOutcome.sessionId })
  }

  if (planOutcome.kind !== 'execute') {
    await patchEntry(id, outcomeToPatch(planOutcome))
    return
  }

  /*
   * AFFINITY ROUTING (the fix for "open ibkr" opening on the Mac). A plan
   * that is entirely browser work executes HERE, through the same validated
   * executor agent-issued commands use. One non-browser step anywhere and the
   * whole plan forwards to the hive exactly as before.
   */
  const affinity = routePlan(planOutcome.actions)
  if (affinity.route === CAPABILITY_BROWSER) {
    await patchEntry(id, {
      headline: 'Plan is all browser work — running it in this browser…',
    })
    await executePlanLocally({ id, command, steps: affinity.steps, config })
    return
  }

  /* The planner said requiresConfirmation:false — the one case the popup
   * executes on its own. Everything else parked above. */
  await patchEntry(id, { headline: 'Plan ready — executing…' })

  const executeOutcome = await consolePost(
    config,
    '/execute',
    {
      command: commandText,
      ...(context ? { context } : {}),
      actions: planOutcome.actions,
      ...(planOutcome.sessionId ? { sessionId: planOutcome.sessionId } : {}),
      planMeta: { planner: planOutcome.planner ?? null, source: CONSOLE_SOURCE },
      source: CONSOLE_SOURCE,
    },
    EXECUTE_TIMEOUT_MS,
    interpretExecuteResponse,
  )

  await patchEntry(id, outcomeToPatch(executeOutcome))
}

/**
 * Execute a fully browser-capable plan on this node.
 *
 * Steps run in order through the SAME validateCommand → runCommand →
 * sanitizeExtraction path every agent-issued command takes — a locally
 * claimed plan gets no shortcut past the privacy boundary. An outward step
 * stops the run and parks in the approval queue; a failed step stops the run
 * honestly rather than pressing on into a page in an unknown state.
 */
async function executePlanLocally({ id, command, steps, config }) {
  const journal = executionJournal()
  await journal.beginRun({ runId: id, command, route: 'local-plan' })
  await recordRunToHive(id, 'claim')

  const parked = []
  for (const step of steps) {
    if (step.effect === EFFECT_OUTWARD) {
      /* The park point is the stop point. Steps after the outward one do NOT
       * run on approval — approving runs exactly the parked step — and that
       * is said out loud rather than discovered. */
      const remaining = steps.length - step.index - 1
      parked.push(
        await journal.parkStep(id, {
          call: step.localCall,
          effect: step.effect,
          reason:
            step.effectReason +
            (remaining
              ? ` (${remaining} later plan step(s) will not run either way — re-run the command after deciding.)`
              : ''),
          targetName: step.label,
        }),
      )
      break
    }

    try {
      const result = await executeCommand(
        {
          commandId: `local-${id}-${step.index}`,
          createdAt: new Date().toISOString(),
          action: step.localCall,
        },
        config,
      )
      await journal.recordStep(id, {
        tool: step.localCall.type,
        effect: step.effect,
        ok: true,
        summary: String(result?.message ?? step.label).slice(0, 300),
      })
    } catch (error) {
      const message = error?.message || String(error)
      await journal.recordStep(id, {
        tool: step.localCall.type,
        effect: step.effect,
        ok: false,
        summary: message.slice(0, 300),
      })
      const runState = (await journal.getStatus()).runs.find((run) => run.runId === id)
      const verdict = honestVerdict({ command, steps: runState?.steps ?? [], parked: [] })
      await journal.finishRun(id, {
        state: 'failed',
        verdict: 'failed',
        headline: `Stopped at step ${step.index + 1} (${step.label}): ${message}`,
        detail: verdict.detail,
      })
      await recordRunToHive(id, 'verdict')
      await patchEntry(id, {
        state: 'failed',
        headline: `Stopped at step ${step.index + 1} (${step.label}): ${message}`,
        detail: verdict.detail,
        finishedAt: new Date().toISOString(),
      })
      return
    }
  }

  const runState = (await journal.getStatus()).runs.find((run) => run.runId === id)
  const verdict = honestVerdict({ command, steps: runState?.steps ?? [], parked })
  await journal.finishRun(id, {
    state: parked.length ? 'parked' : 'finished',
    ...verdict,
  })
  await recordRunToHive(id, 'verdict')

  await patchEntry(id, {
    state: parked.length
      ? 'parked'
      : verdict.verdict === 'incomplete'
        ? 'failed'
        : 'executed',
    headline: verdict.headline,
    detail: [
      `Ran in this browser (affinity: all steps browser-capable).`,
      verdict.detail,
      ...(parked.length
        ? [
            `The parked step (${parked[0].id}) has not run. Approve below to run ` +
              'exactly that step — nothing after it runs either way.',
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n'),
    /* The parked step travels with the entry so Approve can run THAT call,
     * not a re-plan of it. Only the first one: the run stopped there. */
    pending: parked.length
      ? localStepPending({
          call: parked[0].call,
          effect: parked[0].effect,
          reason: parked[0].reason,
          runId: id,
          approvalId: parked[0].id,
        })
      : null,
    finishedAt: new Date().toISOString(),
  })
}

/* ===================================================================== *
 * THE BRAIN LOOP. See background.js's original block comment for the four
 * things this loop will not do; the code is verbatim.
 * ===================================================================== */

/*
 * When the brain may next be asked, as an epoch ms. Set from a relay refusal
 * that carried `retryAfter`. In memory on purpose: a suspended context forgets
 * it and asks once more, which costs one refusal and cannot get stuck holding
 * a cooldown that the relay has long since lifted.
 */
let brainParkedUntil = 0

/** Can this node think for itself right now, and if not, why not? */
export async function brainAvailability(now = Date.now()) {
  const relayConfig = await getRelayConfig()
  if (!relayConfig.ready) {
    return { ok: false, reason: 'No relay credential is configured, so this browser has no brain of its own.' }
  }
  if (brainParkedUntil > now) {
    return {
      ok: false,
      reason: `The relay asked this device to stop calling its brain for another ${Math.ceil((brainParkedUntil - now) / 1000)}s.`,
    }
  }
  return { ok: true, relayConfig }
}

/** One turn: ask the relay, and read the answer strictly. */
async function brainTurn(relayConfig, transcript) {
  let payload
  try {
    payload = await relayFetch(
      relayConfig,
      inferRequest(relayConfig, transcript.messages()),
      /* A model turn is not a 7s poll. Under the relay's own 60s upstream
       * timeout, so the relay's error arrives rather than this one. */
      70_000,
    )
  } catch (error) {
    const failure = describeInferFailure(error)
    if (failure.parkBrain) brainParkedUntil = Date.now() + failure.retryAfter * 1_000
    return { kind: 'unavailable', ...failure }
  }

  const read = readInferPayload(payload)
  /* A truncated or filtered answer is the model's problem, not the relay's:
   * tell the model and let it try again inside the step budget. */
  if (!read.ok) return { kind: 'retry', error: read.error, raw: '' }

  const reply = parseBrainReply(read.content)
  if (reply.kind === 'error') return { kind: 'retry', error: reply.error, raw: read.content }
  return { ...reply, raw: read.content }
}

/**
 * Think and act in this browser until the task is done, parked, or out of
 * steps. Writes the same journal and history a Mac-planned run writes, so
 * nothing downstream has to know which brain produced it.
 */
async function runBrainLocally({ id, command, page, config, relayConfig }) {
  const journal = executionJournal()
  const guard = createOutwardGuard()
  const transcript = createBrainTranscript({ command, page })

  await journal.beginRun({ runId: id, command, route: 'local-brain', executor: 'browser-brain' })
  await recordRunToHive(id, 'claim')

  const parked = []
  let answer = ''
  let steps = 0

  /*
   * A handed-off run still has to be CLOSED here. beginRun above opened it as
   * 'executing', and a run left in that state is a run the status pane shows
   * spinning forever over work that has moved to another machine.
   */
  const handOff = async (reason) => {
    await journal.finishRun(id, {
      state: 'finished',
      verdict: 'handed-off',
      headline: `Handed to the Mac: ${reason}`,
      detail: `This node ran ${steps} step(s) of thinking and executed nothing.`,
    })
    await recordRunToHive(id, 'verdict')
    return { handoff: true, reason, steps }
  }

  while (steps < BRAIN_MAX_STEPS) {
    const turn = await brainTurn(relayConfig, transcript)

    /* The relay is unreachable or has told this device to back off. Nothing
     * has been claimed that the Mac cannot also do, so hand the command back
     * rather than failing it. */
    if (turn.kind === 'unavailable') {
      return await handOff(turn.message)
    }

    if (turn.kind === 'retry') {
      /* Feed the complaint back as the "result" of the turn: the model is the
       * one that can fix a malformed reply, and this costs one step. */
      transcript.pushAssistant(turn.raw || '')
      transcript.pushResult(`That reply could not be used: ${turn.error}`)
      steps += 1
      continue
    }

    transcript.pushAssistant(turn.raw)

    if (turn.kind === 'handoff') {
      /* Only a handoff BEFORE anything ran is a clean handoff. Once this
       * browser has touched a page, sending the same command to the Mac would
       * run those steps a second time. */
      const ran = (await journal.getStatus()).runs.find((run) => run.runId === id)
      if (!(ran?.steps ?? []).length) return await handOff(turn.reason)
      answer = `Stopped: ${turn.reason}`
      break
    }

    if (turn.kind === 'answer') {
      answer = turn.answer
      break
    }

    /* A tool call. The guard decides whether it may run unattended. */
    const assessment = guard.assess(turn.call)
    if (!assessment.allow) {
      parked.push(
        await journal.parkStep(id, {
          call: turn.call,
          effect: assessment.effect,
          reason: assessment.reason,
          targetName: assessment.targetName,
        }),
      )
      break
    }

    try {
      const result = await executeCommand(
        {
          commandId: `brain-${id}-${steps}`,
          createdAt: new Date().toISOString(),
          action: turn.call,
        },
        config,
      )
      /* The guard learns each ref's accessible name from snapshots going past,
       * so a later {click, ref:"e4"} is judged on the words the OWNER would
       * have read rather than on an opaque token. */
      guard.observe(turn.call, result)
      await journal.recordStep(id, {
        tool: turn.call.type,
        effect: assessment.effect,
        ok: true,
        summary: String(result?.message ?? turn.call.type).slice(0, 300),
      })
      transcript.pushResult(compactToolResult(turn.call.type, result))
    } catch (error) {
      const message = error?.message || String(error)
      await journal.recordStep(id, {
        tool: turn.call.type,
        effect: assessment.effect,
        ok: false,
        summary: message.slice(0, 300),
      })
      /* A failed step is information, not the end: the model is told and gets
       * to try something else inside the same budget. */
      transcript.pushResult(`That step failed: ${message}`)
    }

    steps += 1
  }

  const runState = (await journal.getStatus()).runs.find((run) => run.runId === id)
  const executed = runState?.steps ?? []

  if (!executed.length && !parked.length && !answer) {
    /* Nothing thought, nothing ran — the Mac can still have a go. */
    return await handOff('this browser produced no usable step')
  }

  const exhausted = steps >= BRAIN_MAX_STEPS && !answer && !parked.length
  const verdict = honestVerdict({
    command,
    steps: executed,
    parked,
    response: answer,
  })

  await journal.finishRun(id, {
    state: parked.length ? 'parked' : 'finished',
    ...verdict,
  })
  await recordRunToHive(id, 'verdict')

  await patchEntry(id, {
    state: parked.length
      ? 'parked'
      : verdict.verdict === 'incomplete' || exhausted
        ? 'failed'
        : 'executed',
    headline: exhausted
      ? `Stopped after ${BRAIN_MAX_STEPS} steps without finishing. ${verdict.headline}`
      : verdict.headline,
    detail: [
      'Thought and run in this browser (brain: relay inference, execution: this node).',
      verdict.detail,
      ...(parked.length
        ? [
            'The parked step has not run. Approve below to run exactly that step — ' +
              'nothing after it runs either way.',
          ]
        : []),
    ]
      .filter(Boolean)
      .join('\n'),
    pending: parked.length
      ? localStepPending({
          call: parked[0].call,
          effect: parked[0].effect,
          reason: parked[0].reason,
          runId: id,
          approvalId: parked[0].id,
        })
      : null,
    finishedAt: new Date().toISOString(),
  })

  return { handoff: false, steps }
}

/* ===================================================================== *
 * Deciding a parked plan FROM THE POPUP. See background.js's original block
 * comment; the two guards (still waiting? still fresh?) are unchanged.
 * ===================================================================== */

export async function decidePlan({ id, decision }) {
  const entryId = String(id ?? '')
  const history = (await api.storage.local.get(HISTORY_KEY))[HISTORY_KEY] ?? []
  const entry = (Array.isArray(history) ? history : []).find(
    (candidate) => candidate?.id === entryId,
  )

  const preflight = planDecisionPreflight(entry)
  if (!preflight.ok) return { ok: false, error: preflight.error }
  const { pending } = preflight

  if (decision === 'deny') return denyPlan(entry, pending)
  if (decision !== 'approve') {
    return { ok: false, error: `Unknown decision "${decision}".` }
  }

  const config = await getConfig()
  if (!config.agentToken) return { ok: false, needsSetup: true }

  if (pending.kind === 'mac-plan') {
    /* The agent is the arbiter. A plan the dashboard already approved is no
     * longer plan_ready, and saying so is better than running it again. */
    const stillWaiting = await confirmPlanStillWaiting(config, pending.jobId)
    if (!stillWaiting.ok) return stillWaiting
  }

  /* Claimed: the entry goes back to 'working' before anything runs, so a
   * second click (or a second popup) finds no parked plan to press. */
  await patchEntry(entryId, {
    state: 'working',
    headline: 'Approved — running it…',
    pending: null,
    startedAt: new Date().toISOString(),
    finishedAt: null,
  })

  void runApprovedPlan({ entry, pending, config }).catch((error) =>
    patchEntry(entryId, {
      state: 'failed',
      headline: error?.message || String(error),
      finishedAt: new Date().toISOString(),
    }),
  )

  return { ok: true }
}

/**
 * Deny: the plan does not run, and the Mac's parked job is dismissed so the
 * dashboard does not keep offering the same decision the owner just made.
 */
async function denyPlan(entry, pending) {
  let note = ''
  if (pending.kind === 'mac-plan' && pending.jobId) {
    const config = await getConfig()
    try {
      const response = await fetch(
        `${config.agentUrl}/jobs/${encodeURIComponent(pending.jobId)}/dismiss`,
        {
          method: 'POST',
          cache: 'no-store',
          headers: {
            Accept: 'application/json',
            Authorization: `Bearer ${config.agentToken}`,
          },
          signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
        },
      )
      if (!response.ok) {
        note = `The Mac still lists this plan as parked (HTTP ${response.status}).`
      }
    } catch (error) {
      note = `The Mac was not told (${error?.message || error}), so its dashboard may still offer this plan.`
    }
  }

  await patchEntry(entry.id, {
    state: 'denied',
    headline: 'Denied — nothing ran.',
    detail: [entry.detail, note].filter(Boolean).join('\n'),
    pending: null,
    finishedAt: new Date().toISOString(),
  })
  return { ok: true, note }
}

/** Is the Mac's parked job still waiting for a decision? */
async function confirmPlanStillWaiting(config, jobId) {
  /* A plan with no job id was never recorded on the Mac (an older agent, or a
   * /plan that answered without one). There is nothing to race with. */
  if (!jobId) return { ok: true }

  try {
    const response = await fetch(
      `${config.agentUrl}/jobs/${encodeURIComponent(jobId)}`,
      {
        cache: 'no-store',
        headers: {
          Accept: 'application/json',
          Authorization: `Bearer ${config.agentToken}`,
        },
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      },
    )
    if (response.status === 404) return { ok: true }
    if (!response.ok) {
      return {
        ok: false,
        error: `The Mac would not confirm this plan is still waiting (HTTP ${response.status}).`,
      }
    }
    const body = await response.json().catch(() => null)
    const job = body?.job ?? body
    const status = String(job?.status ?? '')
    if (status && status !== 'plan_ready') {
      return {
        ok: false,
        error: `This plan is no longer waiting: the Mac now reports "${status}". It may already have been approved on the dashboard.`,
      }
    }
    return { ok: true }
  } catch (error) {
    return {
      ok: false,
      error: `Could not reach the Mac to check this plan is still waiting (${error?.message || error}).`,
    }
  }
}

/** Run what was approved — the whole plan, or the single parked step. */
async function runApprovedPlan({ entry, pending, config }) {
  if (pending.kind === 'local-step') {
    await runApprovedStep({ entry, pending, config })
    return
  }

  /* Same affinity rule the first pass used: browser-only work runs here, in
   * front of the owner's signed-in tabs, and anything else goes to the Mac. */
  const affinity = routePlan(pending.actions)
  if (affinity.route === CAPABILITY_BROWSER) {
    await executePlanLocally({
      id: entry.id,
      command: entry.command,
      steps: affinity.steps,
      config,
    })
    return
  }

  /* Both channels here too — see buildCommandText on why the trailer stays. */
  const approvedContext = commandContext(entry.page)
  const outcome = await consolePost(
    config,
    '/execute',
    {
      command: buildCommandText(entry.command, entry.page),
      ...(approvedContext ? { context: approvedContext } : {}),
      actions: pending.actions,
      ...(pending.sessionId ? { sessionId: pending.sessionId } : {}),
      planMeta: { planner: pending.planner ?? null, source: CONSOLE_SOURCE },
      source: CONSOLE_SOURCE,
    },
    EXECUTE_TIMEOUT_MS,
    interpretExecuteResponse,
  )
  await patchEntry(entry.id, outcomeToPatch(outcome))
}

/**
 * The approved outward step, run alone.
 *
 * Only this call runs. The steps that would have followed it did not run and
 * are not resumed — the run that parked has already reported what it did, and
 * quietly continuing past the approval point would make that report a lie.
 */
async function runApprovedStep({ entry, pending, config }) {
  const journal = executionJournal()
  const runId = pending.runId || entry.id

  try {
    const result = await executeCommand(
      {
        commandId: `approved-${runId}`,
        createdAt: new Date().toISOString(),
        action: pending.call,
      },
      config,
    )
    await journal.recordStep(runId, {
      tool: pending.call.type,
      effect: pending.effect,
      ok: true,
      summary: String(result?.message ?? 'Approved step ran.').slice(0, 300),
    })
    await journal.finishRun(runId, {
      state: 'finished',
      verdict: 'achieved',
      headline: `Approved and ran: ${pending.call.type}.`,
    })
    await recordRunToHive(runId, 'verdict')
    await patchEntry(entry.id, {
      state: 'executed',
      headline: `You approved it and it ran: ${result?.message || pending.call.type}.`,
      detail:
        'Only the approved step ran. Any later steps from the original plan did not — send the command again if more is left to do.',
      finishedAt: new Date().toISOString(),
    })
  } catch (error) {
    const message = error?.message || String(error)
    await journal.recordStep(runId, {
      tool: pending.call.type,
      effect: pending.effect,
      ok: false,
      summary: message.slice(0, 300),
    })
    await journal.finishRun(runId, {
      state: 'failed',
      verdict: 'failed',
      headline: `The approved step failed: ${message}`,
    })
    await recordRunToHive(runId, 'verdict')
    await patchEntry(entry.id, {
      state: 'failed',
      headline: `The approved step failed: ${message}`,
      finishedAt: new Date().toISOString(),
    })
  }
}

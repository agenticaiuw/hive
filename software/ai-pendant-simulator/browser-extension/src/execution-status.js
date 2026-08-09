/*
 * Execution status, pending approvals, and the hive record — the observable
 * half of local (affinity-routed) execution.
 *
 * Three consumers, one source of truth:
 *
 *   1. THE POPUP (a later pass, by someone else). It imports the storage keys
 *      and render helpers from this module and reads storage.local — the same
 *      pattern consoleHistory already uses, so an entry survives the popup
 *      closing. It never needs the journal instance itself. The background
 *      answers three runtime messages for it (see MESSAGE TYPES below).
 *   2. THE BACKGROUND WORKER, which owns the single journal instance and is
 *      the only writer.
 *   3. THE HIVE. Local execution must not be invisible execution — the owner:
 *      "it should stay in the browser extension but of course it can record
 *      the task to the hive." Records go out as node-mesh mail addressed to
 *      '@relay' (the relay brain's own inbox), via the request builder
 *      relay-peer.js already exports.
 *
 * WHY MESH MAIL AND NOT A JOB. The record must be one the Mac can NEVER
 * claim. Relay jobs are the Mac's work feed (store.claimNextJob behind
 * GET /v1/bridge/work), so writing one — whatever status it is born with —
 * is putting a browser-executed task where the claimer looks. The '@relay'
 * inbox is the opposite: cloud-relay/nodeMailbox.js has principalOwnsDevice
 * on every drain, so only an admin principal can read it — the mac_bridge
 * credential gets a 403 by the relay's own enforcement, not by our
 * convention. And node:message:send is a scope the browser_node credential
 * already holds; no new endpoint, no re-pair.
 *
 * NAMED GAP, deliberately left visible: nothing renders these records into
 * /v1/ops/history yet. The dashboard's RECENT list is derived from plan jobs,
 * which this extension has no scope to create (and must not create — see
 * above). The records are durable for RECORD_TTL_MS and correctly attributed
 * from the moment they are sent; the hive-side consumer (or the pre-declared
 * browser:work:* queue) is other agents' work.
 */
import { sendRequest } from './relay-peer.js'
import { withholdSecrets } from './bridge-core.js'

/* ------------------------------------------------------------------ *
 * Storage keys — the popup's read surface. Bump the schema by adding
 * fields, never by renaming these.
 * ------------------------------------------------------------------ */

export const EXECUTION_STATUS_KEY = 'localExecutionStatus'
export const PENDING_APPROVALS_KEY = 'localPendingApprovals'

/*
 * MESSAGE TYPES the background answers for the (future) approval UI:
 *
 *   {type:'affinity:get-status'}                → the EXECUTION_STATUS_KEY value
 *   {type:'affinity:list-pending'}              → [approval, …] still pending
 *   {type:'affinity:resolve-approval',
 *    id, verdict:'approved'|'declined'}         → {ok, ran?, error?}
 *
 * Approving EXECUTES the parked step in the background and folds the result
 * into the run — the popup only ever says yes or no.
 */
export const APPROVAL_MESSAGE_TYPES = Object.freeze({
  status: 'affinity:get-status',
  listPending: 'affinity:list-pending',
  resolve: 'affinity:resolve-approval',
})

/*
 * How long a parked step stays approvable. The same reasoning as
 * MAX_COMMAND_AGE_MS one storey up: a "cancel my plan" click approved hours
 * later lands on whatever page is THERE NOW, which may be neither the page
 * nor the plan the owner looked at. Ten minutes is long enough to notice the
 * badge and short enough that the page is probably still the page.
 */
export const APPROVAL_TTL_MS = 10 * 60_000

/* Bounded lists: the popup renders these, storage.local holds them. */
const MAX_RUNS_KEPT = 8
const MAX_STEPS_KEPT = 24
const MAX_PENDING_KEPT = 12

/* ------------------------------------------------------------------ *
 * A tiny emitter, dependency-free, so in-process listeners (tests, a
 * future live view) can watch a run advance without polling storage.
 * ------------------------------------------------------------------ */

export function createStatusEmitter() {
  const listeners = new Map()
  return {
    on(event, handler) {
      if (!listeners.has(event)) listeners.set(event, new Set())
      listeners.get(event).add(handler)
      return () => listeners.get(event)?.delete(handler)
    },
    emit(event, payload) {
      for (const handler of listeners.get(event) ?? []) {
        try {
          handler(payload)
        } catch {
          /* A broken listener must not break the run it is watching. */
        }
      }
    },
  }
}

/* ------------------------------------------------------------------ *
 * The journal: the background's single writer over both storage keys.
 * ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {object} options.storage  a storage.local-shaped object
 *                                  ({get(keys), set(values)}) — injected so
 *                                  tests hand in a plain fake.
 * @param {object} [options.emitter] createStatusEmitter() output.
 * @param {() => number} [options.now]
 *
 * All writes go through one promise chain, same as background.js's
 * withHistory: storage.local has no transactions, and two steps finishing
 * together must not eat each other's entries.
 */
export function createExecutionJournal({ storage, emitter = createStatusEmitter(), now = Date.now } = {}) {
  if (!storage) throw new Error('createExecutionJournal requires a storage.')

  let writes = Promise.resolve()
  const serialize = (mutate) => {
    writes = writes.then(mutate, mutate)
    return writes
  }

  const readStatus = async () =>
    (await storage.get(EXECUTION_STATUS_KEY))[EXECUTION_STATUS_KEY] ?? { runs: [] }

  const readPending = async () =>
    (await storage.get(PENDING_APPROVALS_KEY))[PENDING_APPROVALS_KEY] ?? []

  const writeRun = (runId, mutate) =>
    serialize(async () => {
      const status = await readStatus()
      const runs = Array.isArray(status.runs) ? [...status.runs] : []
      const index = runs.findIndex((run) => run?.runId === runId)
      if (index === -1) return null
      runs[index] = mutate({ ...runs[index] })
      await storage.set({ [EXECUTION_STATUS_KEY]: { runs } })
      emitter.emit('run', runs[index])
      return runs[index]
    })

  return {
    events: emitter,

    /** A run exists from the moment the command is claimed locally. */
    beginRun({ runId, command, origin = 'browser-extension', route, executor }) {
      return serialize(async () => {
        const status = await readStatus()
        const runs = Array.isArray(status.runs) ? status.runs : []
        const run = {
          runId,
          command: String(command ?? ''),
          origin,
          route: route ?? 'local',
          executor: executor ?? 'browser-extension',
          state: 'executing',
          steps: [],
          verdict: null,
          headline: '',
          detail: '',
          /* Whether the hive heard about this run. 'unconfigured' is honest:
           * a relay peer that is off records nothing and says so. */
          hiveRecord: 'pending',
          startedAt: new Date(now()).toISOString(),
          finishedAt: null,
        }
        await storage.set({
          [EXECUTION_STATUS_KEY]: { runs: [run, ...runs].slice(0, MAX_RUNS_KEPT) },
        })
        emitter.emit('run', run)
        return run
      })
    },

    /** One executed (or failed) step, already effect-tagged by affinity.js. */
    recordStep(runId, step) {
      return writeRun(runId, (run) => ({
        ...run,
        steps: [
          ...run.steps,
          {
            tool: String(step?.tool ?? step?.type ?? 'step'),
            effect: step?.effect ?? null,
            ok: step?.ok === true,
            summary: String(step?.summary ?? '').slice(0, 300),
            at: new Date(now()).toISOString(),
          },
        ].slice(-MAX_STEPS_KEPT),
      }))
    },

    /**
     * Park an outward step. The run stops here; the approval entry is what a
     * later popup pass renders, and resolveApproval is what its buttons call.
     */
    parkStep(runId, { call, effect, reason, targetName = '' }) {
      return serialize(async () => {
        const pending = await readPending()
        const entry = {
          id: `apr-${runId}-${pending.length + 1}`,
          runId,
          call: { type: String(call?.type ?? ''), params: call?.params ?? {} },
          effect: effect ?? 'outward',
          reason: String(reason ?? 'This step is irreversible or outward-facing.'),
          targetName: String(targetName ?? ''),
          state: 'pending',
          requestedAt: new Date(now()).toISOString(),
          resolvedAt: null,
          expiresAt: new Date(now() + APPROVAL_TTL_MS).toISOString(),
        }
        await storage.set({
          [PENDING_APPROVALS_KEY]: [entry, ...pending].slice(0, MAX_PENDING_KEPT),
        })
        emitter.emit('approval', entry)
        return entry
      })
    },

    /** The terminal verdict, from affinity.honestVerdict — never from a model. */
    finishRun(runId, { state = 'finished', verdict, headline, detail } = {}) {
      return writeRun(runId, (run) => ({
        ...run,
        state,
        verdict: verdict ?? run.verdict,
        headline: String(headline ?? run.headline).slice(0, 500),
        detail: String(detail ?? run.detail).slice(0, 2_000),
        finishedAt: new Date(now()).toISOString(),
      }))
    },

    /** Stamp whether the hive heard about this run. */
    markHiveRecord(runId, outcome) {
      return writeRun(runId, (run) => ({ ...run, hiveRecord: outcome }))
    },

    async getStatus() {
      await writes
      return readStatus()
    },

    /** Pending approvals that have not expired. Expiry is enforced on read
     * AND on resolve, so a stale entry cannot run by being clicked late. */
    async listPendingApprovals() {
      await writes
      const pending = await readPending()
      const at = now()
      return pending.filter(
        (entry) =>
          entry?.state === 'pending' && Date.parse(entry.expiresAt ?? '') > at,
      )
    },

    /**
     * Resolve one approval. Returns the entry in its new state, or null when
     * it does not exist. An expired entry resolves to 'expired' whatever the
     * verdict was — approving a ten-minute-old click is refused, not honored.
     * The caller (background.js) is the one who actually executes on
     * 'approved'; this module only owns the state.
     */
    resolveApproval(id, verdict) {
      return serialize(async () => {
        const pending = await readPending()
        const index = pending.findIndex((entry) => entry?.id === id)
        if (index === -1) return null
        const entry = { ...pending[index] }
        if (entry.state !== 'pending') return entry

        const expired = Date.parse(entry.expiresAt ?? '') <= now()
        entry.state = expired
          ? 'expired'
          : verdict === 'approved'
            ? 'approved'
            : 'declined'
        entry.resolvedAt = new Date(now()).toISOString()

        const next = [...pending]
        next[index] = entry
        await storage.set({ [PENDING_APPROVALS_KEY]: next })
        emitter.emit('approval', entry)
        return entry
      })
    },
  }
}

/* ------------------------------------------------------------------ *
 * The hive record: mesh mail to '@relay', built here, sent by
 * background.js through the same relayFetch every other descriptor uses.
 * ------------------------------------------------------------------ */

export const BROWSER_TASK_RECORD_KIND = 'browser.task.record'

/*
 * Longer than the mesh default (10 min) because nothing drains '@relay' yet
 * and a record that evaporates before any consumer exists recorded nothing;
 * far under the 24 h ceiling because the inbox is depth-capped at 500 and a
 * record is not worth crowding out live mail for. Six hours: a dashboard
 * sweep built tomorrow still sees today's afternoon.
 */
export const RECORD_TTL_MS = 6 * 60 * 60_000

const scrub = (text) => withholdSecrets(String(text ?? '')).text

/**
 * The submission record — sent WHEN THE RUN BEGINS, already marked claimed
 * by this node. The invariant the shape encodes: this is a record OF work,
 * never a request FOR work. `claimable:false` states it; the transport
 * enforces it (see the module header — the Mac cannot drain '@relay').
 */
export function hiveClaimRecordFor(run, relayConfig) {
  return sendRequest(relayConfig, {
    to: '@relay',
    kind: BROWSER_TASK_RECORD_KIND,
    correlationId: run.runId,
    ttlMs: RECORD_TTL_MS,
    payload: {
      record: 'claim',
      claimable: false,
      taskId: run.runId,
      command: scrub(run.command).slice(0, 500),
      origin: run.origin ?? 'browser-extension',
      claimedBy: relayConfig.relayDeviceId,
      executedBy: relayConfig.relayDeviceId,
      status: 'executing',
      startedAt: run.startedAt,
    },
  })
}

/** The terminal record: verdict plus the step trace, same address. */
export function hiveVerdictRecordFor(run, relayConfig) {
  return sendRequest(relayConfig, {
    to: '@relay',
    kind: BROWSER_TASK_RECORD_KIND,
    correlationId: run.runId,
    ttlMs: RECORD_TTL_MS,
    payload: {
      record: 'verdict',
      claimable: false,
      taskId: run.runId,
      command: scrub(run.command).slice(0, 500),
      origin: run.origin ?? 'browser-extension',
      claimedBy: relayConfig.relayDeviceId,
      executedBy: relayConfig.relayDeviceId,
      status: run.state,
      verdict: run.verdict,
      headline: scrub(run.headline).slice(0, 500),
      /* Step summaries are already post-privacy-boundary (they are built from
       * sanitizeExtraction output), scrubbed again here because re-checking
       * at the wire is cheaper than being wrong once. */
      steps: (run.steps ?? []).slice(-MAX_STEPS_KEPT).map((step) => ({
        tool: step.tool,
        effect: step.effect,
        ok: step.ok,
        summary: scrub(step.summary).slice(0, 200),
        at: step.at,
      })),
      startedAt: run.startedAt,
      finishedAt: run.finishedAt,
    },
  })
}

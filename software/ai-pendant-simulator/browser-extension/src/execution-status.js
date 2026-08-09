/*
 * Execution status, pending approvals, and the hive record — the observable
 * half of local (affinity-routed) execution.
 *
 * Two consumers, one source of truth:
 *
 *   1. THE BACKGROUND WORKER, which owns the single journal instance and is
 *      the only writer.
 *   2. THE HIVE. Local execution must not be invisible execution — the owner:
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
 * Storage keys. Bump the schema by adding fields, never by renaming
 * these.
 * ------------------------------------------------------------------ */

export const EXECUTION_STATUS_KEY = 'localExecutionStatus'
export const PENDING_APPROVALS_KEY = 'localPendingApprovals'

/*
 * How long a parked step stays listed as pending. The same reasoning as
 * MAX_COMMAND_AGE_MS one storey up: a parked "cancel my plan" click acted on
 * hours later would land on whatever page is THERE NOW, which may be neither
 * the page nor the plan the owner looked at.
 */
export const APPROVAL_TTL_MS = 10 * 60_000

/* Bounded lists: storage.local holds them. */
const MAX_RUNS_KEPT = 8
const MAX_STEPS_KEPT = 24
const MAX_PENDING_KEPT = 12

/* ------------------------------------------------------------------ *
 * The journal: the background's single writer over both storage keys.
 * ------------------------------------------------------------------ */

/**
 * @param {object} options
 * @param {object} options.storage  a storage.local-shaped object
 *                                  ({get(keys), set(values)}) — injected so
 *                                  tests hand in a plain fake.
 * @param {() => number} [options.now]
 *
 * All writes go through one promise chain, same as background.js's
 * withHistory: storage.local has no transactions, and two steps finishing
 * together must not eat each other's entries.
 */
export function createExecutionJournal({ storage, now = Date.now } = {}) {
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
      return runs[index]
    })

  return {
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
     * Park an outward step. The run stops here; the entry records what was
     * refused and why, and expires unrun after APPROVAL_TTL_MS.
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
          expiresAt: new Date(now() + APPROVAL_TTL_MS).toISOString(),
        }
        await storage.set({
          [PENDING_APPROVALS_KEY]: [entry, ...pending].slice(0, MAX_PENDING_KEPT),
        })
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

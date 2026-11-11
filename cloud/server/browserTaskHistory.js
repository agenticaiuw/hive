/*
 * Browser-executed tasks, folded into the hive's history.
 *
 * The browser extension executes browser-doable commands itself (its affinity
 * layer) and records each run to the hive as node-mesh mail addressed to
 * '@relay' — kind 'browser.task.record', built by
 * browser-extension/src/execution-status.js. Two records per run, sharing one
 * taskId: a 'claim' the moment the run starts, and a 'verdict' when it ends
 * (a run that is approved later sends a second verdict — the newer truth).
 * Until this module existed those envelopes had exactly one fate: queue in D1
 * with no drainer until their TTL erased them. The dashboard's RECENT list is
 * derived from relay_jobs, so browser-executed work was invisible work.
 *
 * THE SEAM. This is the second consumer on nodeMailbox.js's `relayMail`
 * letterbox — the first is approvalDelivery.js's 'approval_decision' handler;
 * server.js chains them with composeRelayMail(). Same contract: called inside
 * the send request for mail addressed to '@relay', {consumed:false} for kinds
 * it does not own, and its own kind is ALWAYS consumed when the record is
 * unusable — nothing ever drains the '@relay' inbox, so an unconsumed
 * envelope is not "retried later", it is a corpse. The receipt names what
 * happened instead. A STORE failure, by contrast, propagates (same as the
 * approval consumer): the send fails loudly and the extension records that
 * the hive did not hear, which is the honest outcome.
 *
 * A RECORD, NEVER WORK. The row this writes is a relay_jobs row with type
 * 'browser_task' and claimable:false, and the Mac must never claim or re-run
 * it. That invariant is structural, twice over:
 *   - the status vocabulary below cannot produce 'queued', the only status
 *     claimNextJob() claims, and normalizeBrowserTaskStatus() clamps it away
 *     even if a future edit tries; and
 *   - both stores' claimNextJob() additionally refuse the type outright
 *     (memoryStore.js / d1Store.js), so even a hand-written 'queued' row of
 *     this type is not work.
 * Re-running a browser task on the Mac would be exactly the affinity
 * violation the extension exists to prevent.
 *
 * SCOPE DECISION — the record rides node:message:send; there is no
 * browser:work:record scope, deliberately.
 *
 *   - The record arrives on POST /v1/node/messages, which relayScopes.js
 *     already gates on node:message:send — a scope the browser_node role
 *     holds. Scopes in this codebase gate ROUTES and fail closed; there is no
 *     per-kind scope machinery, and the precedent is this seam's first
 *     consumer: deciding an approval over the mesh rides node:message:send
 *     while the HTTP decision route carries approval:decide, because what a
 *     mesh sender may do is bounded by the consumer, not the table.
 *   - What this consumer grants is narrower than the scope it rides: a note
 *     about the SENDER'S OWN work. executedBy is stamped from envelope.from —
 *     which the send route derives from the credential, never the body — and
 *     an existing row whose executedBy is another node refuses the update
 *     ('not_your_task'). A stolen token can therefore only write fiction
 *     about itself, under its own name, into a JOB_TTL_MS-bounded view; it
 *     cannot create claimable work or touch another node's history.
 *   - A new browser:work:record scope was considered and rejected: it would
 *     re-gate a route its holder already has a scope for, enforcing it would
 *     need kind-level checks that exist nowhere else, and it could never deny
 *     anything real — a scope that cannot refuse is documentation wearing a
 *     uniform.
 */

/* Mirrors BROWSER_TASK_RECORD_KIND in browser-extension/src/execution-status.js.
 * Spelled as a literal so relay and extension can land independently; the
 * tests freeze the string on this side, the extension's on that side. */
export const BROWSER_TASK_RECORD_KIND = 'browser.task.record'

/* The relay_jobs type. Distinct from 'plan' so nothing built for Mac work —
 * the claim queue, the routine reaper, voiceRunForJob() — ever reads one of
 * these rows as its own. */
export const BROWSER_TASK_JOB_TYPE = 'browser_task'

const JOB_ID_PREFIX = 'btask_'
const MAX_RECORD_STEPS = 32

/* Same charset decodeHistoryCursor() accepts for a pipeline id, minus the
 * prefix budget: a taskId that cannot survive a history cursor round trip
 * would break paging for every entry behind it. */
const TASK_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,119}$/

/*
 * The verdict → history-status table, and the honesty rules it encodes.
 *
 * The wire carries the extension's own vocabulary: run states 'executing' |
 * 'finished' | 'failed' | 'parked' | 'handed-off', verdicts 'achieved' |
 * 'recon-only' | 'incomplete' | 'parked' | 'failed' | 'handoff'
 * (browser-extension/src/affinity.js honestVerdict, background.js). History
 * speaks the dashboard's vocabulary (dashboard statusLabel): 'completed'
 * renders as "Done", 'processing' as "Running", 'needs_approval' as "Needs
 * your approval"; anything else is humanized verbatim.
 *
 * The one rule that must never bend: ONLY verdict 'achieved' maps to
 * 'completed'. An 'incomplete' run — the command asked for an outward effect
 * and none ran — stays 'incomplete', and a 'recon-only' run stays 'read_only'
 * ("Read only"): both finished, neither did the thing, and a status that says
 * "Done" over either would be the relay overruling the extension's own
 * honesty gate.
 */
const STATUS_BY_VERDICT = Object.freeze({
  achieved: 'completed',
  'recon-only': 'read_only',
  incomplete: 'incomplete',
  parked: 'needs_approval',
  failed: 'failed',
  handoff: 'handed_off',
})

const STATUS_BY_STATE = Object.freeze({
  executing: 'processing',
  failed: 'failed',
  parked: 'needs_approval',
  'handed-off': 'handed_off',
  /* 'finished' with no recognizable verdict: the run ended, but without the
   * ledger-derived verdict nothing here may claim the goal was met. "Finished"
   * is the neutral truth; "Done" is reserved for 'achieved'. */
  finished: 'finished',
})

/** The stored/listed status for one record payload. Never 'queued'. */
export function browserTaskStatusFor(payload = {}) {
  const status =
    payload.record === 'claim'
      ? 'processing'
      : STATUS_BY_VERDICT[String(payload.verdict ?? '')] ||
        STATUS_BY_STATE[String(payload.status ?? '')] ||
        'recorded'
  return normalizeBrowserTaskStatus(status)
}

/* The last line of the never-claimable invariant inside this module: whatever
 * the tables above evolve into, a browser task row must never carry the one
 * status claimNextJob() claims. */
export function normalizeBrowserTaskStatus(status) {
  return status === 'queued' ? 'processing' : status
}

export function browserTaskJobId(taskId) {
  return `${JOB_ID_PREFIX}${taskId}`
}

function normalizeTaskId(value) {
  const taskId = String(value ?? '').trim()
  return TASK_ID_PATTERN.test(taskId) ? taskId : ''
}

function isoOrNull(value) {
  const parsed = Date.parse(String(value ?? ''))
  return Number.isFinite(parsed) ? new Date(parsed).toISOString() : null
}

function sanitizeSteps(steps) {
  return (Array.isArray(steps) ? steps : [])
    .slice(-MAX_RECORD_STEPS)
    .map((step) => ({
      tool: String(step?.tool ?? 'step').slice(0, 80),
      effect: step?.effect == null ? null : String(step.effect).slice(0, 40),
      ok: step?.ok === true,
      summary: String(step?.summary ?? '').slice(0, 300),
      at: isoOrNull(step?.at),
    }))
}

/**
 * The row for one record, shaped for relay_jobs. `createdAt` prefers the
 * run's own startedAt so the history stays in the order the work actually
 * happened, clamped to "not in the future" so a skewed browser clock cannot
 * pin its runs above everything the Mac does next.
 */
function browserTaskRowFor({ payload, taskId, executedBy, now }) {
  const nowIso = new Date(now).toISOString()
  const startedAt = isoOrNull(payload.startedAt)
  const finishedAt = isoOrNull(payload.finishedAt)
  const headline = String(payload.headline ?? '').slice(0, 500)
  const status = browserTaskStatusFor(payload)
  const phase = payload.record === 'verdict' ? 'verdict' : 'claim'
  const senderClaimed = String(payload.executedBy ?? '').trim()

  return {
    jobId: browserTaskJobId(taskId),
    type: BROWSER_TASK_JOB_TYPE,
    status,
    taskId,
    command: String(payload.command ?? '').slice(0, 500),
    origin: String(payload.origin ?? 'browser-extension').slice(0, 80) ||
      'browser-extension',
    /* The invariant, stated on the row itself so every reader — including
     * ones not written yet — can see this is a record OF work, never a
     * request FOR it. Enforcement lives in the stores' claimNextJob. */
    claimable: false,
    executor: 'browser',
    /* Credential-derived (envelope.from), NEVER payload.executedBy: the
     * payload is the sender's story, the envelope is the relay's knowledge. */
    executedBy,
    claimedBy: executedBy,
    createdBy: executedBy,
    error:
      status === 'failed'
        ? headline || 'The browser run failed.'
        : null,
    /* Mirror the headline where job search already looks
     * (jobQuery.jobSearchHaystack / d1's json_extract $.result.response), so
     * q= finds browser outcomes exactly like Mac ones. */
    result: headline ? { response: headline } : null,
    browser: {
      phase,
      state: String(payload.status ?? '').slice(0, 40),
      verdict: payload.verdict == null ? null : String(payload.verdict).slice(0, 40),
      headline,
      steps: phase === 'verdict' ? sanitizeSteps(payload.steps) : [],
      /* Honesty note, kept only when the payload disagreed with the
       * credential about who ran this. */
      senderClaimedExecutor:
        senderClaimed && senderClaimed !== executedBy
          ? senderClaimed.slice(0, 128)
          : null,
    },
    startedAt,
    finishedAt,
    createdAt: startedAt && startedAt <= nowIso ? startedAt : nowIso,
    updatedAt: finishedAt && finishedAt <= nowIso ? finishedAt : nowIso,
  }
}

/**
 * Fold one record into relay_jobs. Idempotent on the record's id — the mesh
 * is at-least-once and a retried POST builds a fresh envelope, so the dedupe
 * key is taskId (jobId = btask_<taskId>), never envelope.id:
 *
 *   claim, no row      → create (status 'processing')      code 'recorded'
 *   claim replayed     → same row rewritten                code 'updated'
 *   claim after verdict→ ignored, terminal truth stands    code 'already_recorded'
 *   verdict, no row    → create (claim mail was lost)      code 'recorded'
 *   verdict / replay   → row updated in place              code 'updated'
 *
 * A verdict always overwrites a verdict: identical replays are no-ops by
 * value, and a genuinely newer verdict (a parked run approved in the popup)
 * is the newer truth.
 */
export async function foldBrowserTaskRecord({ store, envelope, now = Date.now() } = {}) {
  const payload = envelope?.payload ?? {}
  const phase =
    payload.record === 'verdict'
      ? 'verdict'
      : payload.record === 'claim'
        ? 'claim'
        : null
  const taskId = normalizeTaskId(payload.taskId)
  if (!phase || !taskId) {
    return { ok: false, code: 'invalid_record', jobId: null, status: null }
  }

  const executedBy = String(envelope?.from ?? '').trim()
  if (!executedBy) {
    return { ok: false, code: 'invalid_record', jobId: null, status: null }
  }

  const row = browserTaskRowFor({ payload, taskId, executedBy, now })

  const applyToExisting = async (existing) => {
    if (existing.type !== BROWSER_TASK_JOB_TYPE) {
      /* A job id that already belongs to something else. Never overwrite it —
       * btask_ prefixing makes this unreachable short of a crafted taskId,
       * and a crafted taskId gets a refusal, not a write. */
      return { ok: false, code: 'id_collision', jobId: row.jobId, status: null }
    }
    if (String(existing.executedBy ?? '') !== executedBy) {
      /* Same rule as the inbox routes' principalOwnsDevice: your credential
       * is fine, that task is not yours. */
      return { ok: false, code: 'not_your_task', jobId: row.jobId, status: null }
    }
    if (phase === 'claim' && existing.browser?.phase === 'verdict') {
      /* At-least-once redelivery of the opening record after the closing one
       * landed. The terminal truth stands. */
      return {
        ok: true,
        code: 'already_recorded',
        jobId: row.jobId,
        status: existing.status,
      }
    }
    await store.updateJob(row.jobId, {
      status: row.status,
      command: row.command || existing.command,
      origin: row.origin,
      claimable: false,
      executor: 'browser',
      error: row.error,
      result: row.result ?? existing.result ?? null,
      browser: row.browser,
      startedAt: existing.startedAt ?? row.startedAt,
      finishedAt: row.finishedAt ?? existing.finishedAt ?? null,
      /* createdAt is deliberately not patched: the row keeps the moment the
       * run began, whatever order its records arrived in. */
    })
    return { ok: true, code: 'updated', jobId: row.jobId, status: row.status }
  }

  const existing = await store.getJob(row.jobId)
  if (existing) {
    return applyToExisting(existing)
  }

  try {
    await store.createJob(row)
    return { ok: true, code: 'recorded', jobId: row.jobId, status: row.status }
  } catch (error) {
    /* Two records for one task racing through separate requests: the loser's
     * INSERT hits the primary key. Re-read and merge — that is the replay
     * path, not an error. A store that failed for any other reason returns
     * nothing here and the rethrow tells the sender the truth. */
    const raced = await store.getJob(row.jobId)
    if (raced) {
      return applyToExisting(raced)
    }
    throw error
  }
}

/**
 * The relayMail consumer. {consumed:false} for kinds this module does not
 * own; its own kind is consumed whenever the record itself is the problem
 * (see the header for why), while store failures propagate to fail the send.
 */
export async function consumeBrowserTaskRecordMail({ store, envelope, now = Date.now() } = {}) {
  if (String(envelope?.kind ?? '') !== BROWSER_TASK_RECORD_KIND) {
    return { consumed: false }
  }

  const outcome = await foldBrowserTaskRecord({ store, envelope, now })

  /* Source and disposition only — never the command or the step trace. */
  console.log(
    `[relay] browser task record from ${envelope?.from ?? '?'}: ${outcome.jobId ?? 'no-task'} -> ${outcome.code}`,
  )

  return {
    consumed: true,
    receipt: {
      kind: BROWSER_TASK_RECORD_KIND,
      record: String(envelope?.payload?.record ?? '') || null,
      taskId: outcome.jobId ? outcome.jobId.slice(JOB_ID_PREFIX.length) : null,
      corr: envelope?.corr ?? null,
      ok: outcome.ok,
      code: outcome.code,
      status: outcome.status ?? null,
    },
  }
}

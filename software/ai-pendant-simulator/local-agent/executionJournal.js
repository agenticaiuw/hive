import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { classifyAction } from './actionRisk.js'
import { receiptsForJob, undoVaultLocation } from './actionReceipts.js'
import { describeUndoability } from './undo.js'
import { allowedFolders, FULL_CONTROL_MODE } from './config.js'

/*
 * What ran, in what order, what it touched, how long it took, which tier
 * planned it, and whether it can still be taken back.
 *
 * Every one of those facts already existed somewhere in this process — the job
 * store had the order, the receipts had the touched paths and the snapshots,
 * undo.js had the reversibility verdict, routingStats had the tier. None of
 * them were ever joined, so answering "what did the agent do to my Mac in the
 * last hour, and can I take it back" meant opening four endpoints and matching
 * them by eye. `/jobs/:id/receipts` answers it for one job you already know the
 * id of, which is the case where you needed it least.
 *
 * DERIVED, never hand-maintained, for the same reason capabilityManifest.js
 * reads the live Express router: a journal you have to remember to write to is
 * a journal that is wrong the first time someone forgets. Nothing in the
 * execution path had to change to produce this file — if the executor records a
 * receipt, it lands here.
 *
 * THIS OBSERVES. It cannot block, refuse, gate, or delay an action, and it must
 * never learn how: it is a read path over records that already exist, reached
 * only by GET, and every classification it reports (`handsFree`, `effect`,
 * `reversible`) is a LABEL on something that already happened. The owner asked
 * for a camera. actionReceipts.js says the same thing about itself, and the two
 * files should keep agreeing.
 *
 * The honest edges, stated in the payload rather than papered over:
 *   - tier attribution for an `execute` job is a JOIN, not a record. The
 *     executor is never told which tier planned the actions it is handed, so
 *     the tier is recovered from the `plan` job that carried the same command.
 *     Every entry names the source it was attributed from.
 *   - routingStats is in-memory by design, so after an agent restart older jobs
 *     attribute to `unattributed` rather than to a guess.
 */

const execFileAsync = promisify(execFile)

/* Named in the payload so a caller can go read the source of any field. */
export const JOURNAL_SOURCES = [
  'local-agent/jobTracker.js — pendant-jobs.json, the durable job store',
  'local-agent/actionReceipts.js — receiptsForJob(), written by the executor per action',
  'local-agent/undo.js — describeUndoability(), the same verdict POST /jobs/:id/undo uses',
  'local-agent/routingStats.js — in-memory routing receipts, for tier attribution',
  'local-agent/actionRisk.js — classifyAction(), reported as a label only',
]

/* routingStats truncates the command it stores to 160 characters. Joining on
 * the untruncated string silently misses every long command, which would look
 * exactly like "the router never ran". */
export const ROUTING_COMMAND_KEY_LENGTH = 160

export function commandKey(command) {
  return String(command ?? '').slice(0, ROUTING_COMMAND_KEY_LENGTH)
}

/* Deterministic instant plans record their steps under `sideResults`; executed
 * plans use `results`. Both are real execution, so both belong in the journal. */
function resultsOf(job) {
  if (Array.isArray(job?.result?.results)) return job.result.results
  if (Array.isArray(job?.result?.sideResults)) return job.result.sideResults
  return []
}

function millisBetween(from, to) {
  const start = Date.parse(from ?? '')
  const end = Date.parse(to ?? '')
  return Number.isFinite(start) && Number.isFinite(end) && end >= start
    ? end - start
    : null
}

function timeOf(value) {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

/* Two shapes carry the same facts: the receipt stamped onto a plan by
 * orchestrator.stampRouting, and the raw routingStats entry. Normalize once so
 * a caller never has to know which one answered. */
function projectRouting(raw) {
  const calls = Array.isArray(raw?.calls) ? raw.calls : []
  return {
    tier: raw?.tier ?? null,
    reason: raw?.reason || null,
    intent: raw?.intent ?? null,
    escalatedFrom: raw?.escalatedFrom ?? null,
    llmCalls: raw?.llmCalls ?? null,
    latencyMs: raw?.latencyMs ?? null,
    estimatedPromptTokens: raw?.estimatedPromptTokens ?? raw?.promptTokens ?? null,
    estimatedCompletionTokens:
      raw?.estimatedCompletionTokens ?? raw?.completionTokens ?? null,
    estimatedCostUsd: raw?.estimatedCostUsd ?? raw?.costUsd ?? null,
    models: Array.isArray(raw?.models)
      ? raw.models
      : calls.map((call) => call.model).filter(Boolean),
  }
}

/**
 * Which tier planned this job, and how confident the journal is that it knows.
 *
 * `source` is the whole point. A plan job carries its own routing receipt and
 * is a fact. An execute job is a join over the command text and has to say so —
 * reporting a guess as a record is how observability starts lying.
 */
export function attributeTier(job, { jobs = [], routing = null } = {}) {
  const direct = job?.result?.routing
  if (direct?.tier) {
    return {
      ...projectRouting(direct),
      source: 'plan-receipt',
      sourceDetail: 'the job carries the routing receipt the planner stamped on it',
      confidence: 'recorded',
    }
  }

  const key = commandKey(job?.command)
  const until = Math.max(timeOf(job?.updatedAt), timeOf(job?.createdAt))

  if (key) {
    /* `jobs` is newest-first (jobTracker unshifts), so the first match is the
     * most recent plan at or before this job — the one that produced it. */
    const plan = jobs.find(
      (other) =>
        other &&
        other.jobId !== job?.jobId &&
        other.result?.routing?.tier &&
        commandKey(other.command) === key &&
        (other.sessionId ?? null) === (job?.sessionId ?? null) &&
        timeOf(other.createdAt) <= until,
    )
    if (plan) {
      return {
        ...projectRouting(plan.result.routing),
        source: 'plan-job',
        sourceDetail: `joined to ${plan.jobId} on identical command and session`,
        confidence: 'joined',
      }
    }

    const entry = (routing?.recent ?? []).find(
      (item) => item?.command === key && timeOf(item.at) <= until,
    )
    if (entry) {
      return {
        ...projectRouting(entry),
        source: 'routing-stats',
        sourceDetail: `joined to the routing receipt recorded at ${entry.at}`,
        confidence: 'joined',
      }
    }
  }

  return {
    ...projectRouting(null),
    source: 'unattributed',
    sourceDetail:
      'no routing receipt for this command is still in memory — routingStats is per-process and keeps the last 200',
    confidence: 'unknown',
  }
}

/**
 * One job, fully expanded: its steps in execution order, each with the
 * content-addressed id that doubles as its idempotency key.
 */
export function journalEntry(job, { jobs = [], routing = null } = {}) {
  const receipts = receiptsForJob(job)
  const results = resultsOf(job)
  const undo = describeUndoability(job)
  const terminal = job?.status !== 'processing'

  const actions = receipts.map((receipt, index) => {
    const item = results[index] ?? {}
    const action = item.action ?? { type: receipt.type }
    /* A label, not a verdict. The action already ran; nothing here could have
     * stopped it and nothing here should ever try. */
    const risk = classifyAction(action)

    return {
      seq: index,
      /* Content-addressed in actionReceipts.actionIdFor: the same step in a
       * re-run of the same plan carries the same id, which is what makes it
       * usable as an idempotency key rather than just a row number. */
      idempotencyKey: receipt.actionId ?? null,
      receiptId: receipt.receiptId ?? null,
      type: receipt.type,
      label: receipt.label ?? action?.label ?? null,
      effect: receipt.effect,
      handsFree: risk.safe,
      handsFreeNote: risk.safe ? null : risk.reason ?? null,
      ok: receipt.ok !== false,
      status: receipt.status || (receipt.ok === false ? 'failed' : 'success'),
      startedAt: receipt.startedAt ?? null,
      finishedAt: receipt.finishedAt ?? null,
      durationMs: receipt.durationMs ?? null,
      touched: Array.isArray(receipt.touched) ? receipt.touched : [],
      snapshot: receipt.snapshot ?? null,
      reversible: Boolean(receipt.reversible),
      reversedBy: receipt.reversedBy ?? null,
      irreversibleReason: receipt.irreversibleReason ?? null,
      /* The structured per-action outcome. Receipts deliberately do not carry
       * the message, so a failed step used to be visible as `ok: false` with no
       * way to see what it said. */
      outcome: {
        message: item.message ?? null,
        error: item.error ?? item.reason ?? null,
      },
      recordedBy: receipt.synthesized ? 'derived-from-result' : 'executor-receipt',
    }
  })

  const measured = actions.filter((action) => Number.isFinite(action.durationMs))

  return {
    jobId: job?.jobId ?? null,
    type: job?.type ?? null,
    status: job?.status ?? null,
    command: String(job?.command ?? ''),
    source: job?.source ?? null,
    sessionId: job?.sessionId ?? null,
    running: job?.status === 'processing',
    error: job?.error ?? null,
    startedAt: job?.createdAt ?? null,
    finishedAt: terminal ? (job?.updatedAt ?? null) : null,
    durationMs: terminal ? millisBetween(job?.createdAt, job?.updatedAt) : null,
    /* Wall-clock for the job includes planning and bookkeeping; this is the
     * part actually spent inside actions, and it is null rather than 0 when no
     * step recorded a duration (every pre-receipt job in the store). */
    actionTimeMs: measured.length
      ? measured.reduce((sum, action) => sum + action.durationMs, 0)
      : null,
    plannedBy: attributeTier(job, { jobs, routing }),
    undo: { ...undo, undoneAt: job?.undoneAt ?? null },
    counts: {
      actions: actions.length,
      read: actions.filter((action) => action.effect === 'read').length,
      wrote: actions.filter((action) => action.effect === 'write').length,
      failed: actions.filter((action) => !action.ok).length,
      reversible: actions.filter((action) => action.reversible).length,
      snapshotted: actions.filter((action) => action.snapshot).length,
    },
    actions,
  }
}

/**
 * Every action id that ran more than once, with when and in which job.
 *
 * This is what the content-addressed action id was always for: "has this exact
 * step already run" is answerable from the journal alone, without the caller
 * keeping its own table of what it has sent.
 */
export function repeatedActions(entries) {
  const byKey = new Map()

  for (const entry of entries) {
    for (const action of entry.actions) {
      if (!action.idempotencyKey) continue
      const runs = byKey.get(action.idempotencyKey) ?? []
      runs.push({
        jobId: entry.jobId,
        seq: action.seq,
        at: action.startedAt ?? entry.startedAt,
        ok: action.ok,
      })
      byKey.set(action.idempotencyKey, runs)
    }
  }

  return [...byKey.entries()]
    .filter(([, runs]) => runs.length > 1)
    .map(([idempotencyKey, runs]) => ({
      idempotencyKey,
      type: findType(entries, idempotencyKey),
      runs: runs.length,
      firstAt: runs[runs.length - 1]?.at ?? null,
      lastAt: runs[0]?.at ?? null,
      jobIds: [...new Set(runs.map((run) => run.jobId))],
    }))
    .sort((a, b) => b.runs - a.runs)
}

function findType(entries, idempotencyKey) {
  for (const entry of entries) {
    for (const action of entry.actions) {
      if (action.idempotencyKey === idempotencyKey) return action.type
    }
  }
  return null
}

/**
 * The journal. `jobs` and `routing` are passed in rather than read here so the
 * derivation is testable without a job store on disk — the same reason
 * buildCapabilityManifest takes the app instead of importing the server.
 */
export function buildExecutionJournal({
  jobs = [],
  routing = null,
  limit = 25,
  type = null,
  status = null,
  idempotencyKey = null,
  storePath = null,
} = {}) {
  const all = jobs.map((job) => journalEntry(job, { jobs, routing }))

  const filtered = all.filter((entry) => {
    if (type && entry.type !== type) return false
    if (status && entry.status !== status) return false
    if (
      idempotencyKey &&
      !entry.actions.some((action) => action.idempotencyKey === idempotencyKey)
    ) {
      return false
    }
    return true
  })

  const bounded = Number.isFinite(limit) && limit > 0 ? filtered.slice(0, limit) : filtered
  const timestamps = all.map((entry) => entry.startedAt).filter(Boolean).sort()

  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    /* Said in the payload, not only in a comment: a caller that finds this
     * endpoint should not have to read the source to learn it is inert. */
    readOnly: true,
    note: 'Observation only. Nothing on this path can block, refuse, or delay an action.',
    derivedFrom: JOURNAL_SOURCES,
    filters: { type, status, idempotencyKey, limit },
    window: {
      jobsInStore: jobs.length,
      matched: filtered.length,
      returned: bounded.length,
      oldest: timestamps[0] ?? null,
      newest: timestamps[timestamps.length - 1] ?? null,
      storePath,
      note: 'The job store keeps the most recent 120 jobs; anything older has already been dropped by jobTracker.',
    },
    totals: {
      actions: filtered.reduce((sum, entry) => sum + entry.counts.actions, 0),
      wrote: filtered.reduce((sum, entry) => sum + entry.counts.wrote, 0),
      failed: filtered.reduce((sum, entry) => sum + entry.counts.failed, 0),
      undoable: filtered.filter((entry) => entry.undo?.canUndo).length,
      undone: filtered.filter((entry) => entry.undo?.undoneAt).length,
      unattributedTier: filtered.filter(
        (entry) => entry.plannedBy.source === 'unattributed',
      ).length,
    },
    /* Computed over the matched set, not the returned page: "has this action
     * run before" is a question about history, not about the current page. */
    repeatedActions: repeatedActions(filtered),
    snapshotVault: undoVaultLocation(),
    entries: bounded,
  }
}

/* ------------------------------------------------------------------------ *
 * Host state: the context an entry in the journal happened in.
 *
 * A ui_click that "succeeded" against the wrong frontmost app, or a whole run
 * of ui_* steps that were silently swallowed because Accessibility is granted
 * to the wrong bundle, are both invisible in the journal alone — the receipts
 * say success because the executor was told success. This is the other half of
 * the record. Also GET-only, also inert.
 * ------------------------------------------------------------------------ */

/* Top-level application bundles only. ps also reports the ~90 XPC and helper
 * processes that live inside app bundles; listing those as "running apps" is
 * technically true and practically useless. */
const APP_PROCESS = new RegExp(
  String.raw`^\s*(\d+)\s+((?:/Applications|/System/Applications|/Users/[^/]+/Applications)/[^/]+\.app)/Contents/MacOS/[^/]+$`,
)

export function parseRunningApps(psOutput) {
  const apps = new Map()
  let helpers = 0

  for (const line of String(psOutput ?? '').split('\n')) {
    if (!line.includes('.app/Contents/MacOS/')) continue
    const match = APP_PROCESS.exec(line)
    if (!match) {
      helpers += 1
      continue
    }
    const [, pid, bundlePath] = match
    const name = bundlePath.split('/').pop().replace(/\.app$/, '')
    /* Some apps run several top-level processes (OneDrive does). Keep the
     * lowest pid, which is the one that was launched first. */
    const existing = apps.get(bundlePath)
    if (!existing || Number(pid) < existing.pid) {
      apps.set(bundlePath, { name, pid: Number(pid), bundlePath })
    }
  }

  return {
    apps: [...apps.values()].sort((a, b) => a.name.localeCompare(b.name)),
    helperProcesses: helpers,
  }
}

export function parseForegroundApp(infoOutput) {
  const fields = {}
  for (const [, key, value] of String(infoOutput ?? '').matchAll(
    /"([^"]+)"=(?:"([^"]*)"|(\d+))/g,
  )) {
    fields[key] = value
  }
  const raw = String(infoOutput ?? '')
  const pid = raw.match(/"pid"=(\d+)/)?.[1]
  return {
    name: fields.LSDisplayName ?? null,
    bundleId: fields.CFBundleIdentifier ?? null,
    pid: pid ? Number(pid) : null,
  }
}

async function readForegroundApp(execFileImpl) {
  try {
    const front = await execFileImpl('lsappinfo', ['front'], { timeout: 4000 })
    const asn = String(front.stdout ?? '').trim()
    if (!asn) {
      return { name: null, bundleId: null, pid: null, detail: 'No front application.' }
    }
    const info = await execFileImpl(
      'lsappinfo',
      ['info', '-only', 'name,bundleID,pid', asn],
      { timeout: 4000 },
    )
    return { asn, ...parseForegroundApp(info.stdout) }
  } catch (error) {
    /* lsappinfo needs no TCC grant, so a failure here is a real fault worth
     * surfacing rather than a permission the owner has to go turn on. */
    return { name: null, bundleId: null, pid: null, error: String(error?.message ?? error) }
  }
}

async function readRunningApps(execFileImpl) {
  try {
    const { stdout } = await execFileImpl('ps', ['-Ao', 'pid=,comm='], {
      timeout: 6000,
      maxBuffer: 4 * 1024 * 1024,
    })
    return parseRunningApps(stdout)
  } catch (error) {
    return { apps: [], helperProcesses: 0, error: String(error?.message ?? error) }
  }
}

/**
 * Accessibility as the journal needs it: not "is the checkbox on" but "would a
 * ui_* or type_text step in the next job actually reach the screen".
 */
export function projectAccessibility(permissions) {
  if (!permissions || permissions.error) {
    return {
      probed: false,
      detail: permissions?.error ?? 'No permission report was supplied.',
    }
  }

  const accessibility = permissions.accessibility ?? {}
  const posting = permissions.inputPosting ?? {}
  const screen = permissions.screenRecording ?? {}

  return {
    probed: true,
    trusted: Boolean(accessibility.trusted),
    detail: accessibility.detail ?? null,
    hostApp: permissions.hostApp ?? null,
    /* The failure this exists to make visible: events post silently into
     * nothing when Accessibility is granted to a different bundle. */
    eventsPost: Boolean(posting.granted),
    secureInputActive: Boolean(posting.secureInput),
    screenRecording: Boolean(screen.granted),
    automationMissing: Array.isArray(permissions.requiredMissing)
      ? permissions.requiredMissing
      : [],
    uiActionsWillReachTheScreen: Boolean(accessibility.trusted && posting.granted),
    consequence:
      accessibility.trusted && posting.granted
        ? null
        : 'ui_click, ui_menu, type_text and press_keys report success while doing nothing — receipts for those steps cannot be trusted until this is granted.',
  }
}

function describeRoots(roots) {
  return roots.map((root) => {
    try {
      const entries = fs.readdirSync(root, { withFileTypes: true })
      return {
        path: root,
        exists: true,
        readable: true,
        entries: entries.length,
        directories: entries.filter((entry) => entry.isDirectory()).length,
      }
    } catch (error) {
      return {
        path: root,
        exists: fs.existsSync(root),
        readable: false,
        detail: String(error?.message ?? error),
      }
    }
  })
}

/**
 * The host as the agent currently sees it. `permissions` and `browserSessions`
 * are injected by the caller, which already holds both — the same contract
 * buildCapabilityManifest uses, so that reading this never triggers a fresh
 * macOS permission probe.
 */
export async function observeHost({
  permissions = null,
  browserSessions = [],
  roots = allowedFolders,
  execFileImpl = execFileAsync,
} = {}) {
  const [foreground, running] = await Promise.all([
    readForegroundApp(execFileImpl),
    readRunningApps(execFileImpl),
  ])

  const sessions = Array.isArray(browserSessions) ? browserSessions : []

  return {
    ok: true,
    observedAt: new Date().toISOString(),
    readOnly: true,
    note: 'Observation only. Nothing on this path can block, refuse, or delay an action.',
    derivedFrom: [
      'lsappinfo front — foreground application',
      'ps -Ao pid=,comm= — running application bundles',
      'local-agent/macos/permissions.js — accessibility, input posting, screen recording',
      'local-agent/browserSessions.js — durable browser sessions',
      'local-agent/config.js — allowedFolders',
    ],
    foregroundApp: foreground,
    runningApps: {
      count: running.apps.length,
      helperProcesses: running.helperProcesses,
      error: running.error ?? null,
      apps: running.apps,
    },
    accessibility: projectAccessibility(permissions),
    browser: {
      sessions: sessions.length,
      tabs: sessions.map((session) => ({
        id: session.id ?? null,
        url: session.url ?? null,
        title: session.title ?? null,
        tabId: session.tabId ?? null,
        lastUsedAt: session.lastUsedAt ?? session.updatedAt ?? null,
      })),
    },
    directories: {
      /* In full control the allowlist is not consulted at all; reporting these
       * as "the boundary" would be a comfortable lie. */
      enforced: !FULL_CONTROL_MODE,
      note: FULL_CONTROL_MODE
        ? 'FULL_CONTROL_MODE is on: security.assertAllowedPath resolves any path. These are the configured roots, not a limit.'
        : 'security.assertAllowedPath rejects any path outside these roots.',
      roots: describeRoots(roots),
    },
  }
}

/*
 * Browser-executed tasks in hive history: the fold, the honesty of the
 * status vocabulary, the idempotence contract, and the one invariant that
 * must never bend — the Mac can neither claim nor re-run a browser task.
 *
 * The wire fixtures mirror browser-extension/src/execution-status.js
 * (hiveClaimRecordFor / hiveVerdictRecordFor); the kind string is frozen on
 * both sides so the two modules can land independently.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'

import { createMemoryStore } from './store/memoryStore.js'
import { createD1Store } from './store/d1Store.js'
import {
  BROWSER_TASK_JOB_TYPE,
  BROWSER_TASK_RECORD_KIND,
  browserTaskJobId,
  browserTaskStatusFor,
  consumeBrowserTaskRecordMail,
  foldBrowserTaskRecord,
} from './browserTaskHistory.js'
import {
  browserTaskRunDetail,
  buildHistoryPage,
  historyEntryForBrowserTask,
} from './history.js'
import { composeRelayMail, registerNodeMeshRoutes } from './nodeMailbox.js'
import { consumeRelayApprovalMail } from './approvalDelivery.js'
import { createNodeEnvelope } from '../shared/nodeMesh.js'

const BROWSER_DEVICE = 'ext-probe-chrome'
const TASK_ID = '6f0b8a04-1111-4222-8333-abcdefabcdef'

function claimEnvelope({ from = BROWSER_DEVICE, taskId = TASK_ID, now = Date.now() } = {}) {
  return createNodeEnvelope({
    from,
    to: '@relay',
    kind: BROWSER_TASK_RECORD_KIND,
    correlationId: taskId,
    now,
    payload: {
      record: 'claim',
      claimable: false,
      taskId,
      command: 'open my meal plan and read the total',
      origin: 'browser-extension',
      claimedBy: from,
      executedBy: from,
      status: 'executing',
      startedAt: new Date(now - 1_000).toISOString(),
    },
  })
}

function verdictEnvelope({
  from = BROWSER_DEVICE,
  taskId = TASK_ID,
  state = 'finished',
  verdict = 'achieved',
  headline = 'Done.',
  steps = [
    { tool: 'navigate', effect: 'act', ok: true, summary: 'Opened the page', at: new Date().toISOString() },
    { tool: 'read_page', effect: 'read', ok: true, summary: 'Read the total', at: new Date().toISOString() },
  ],
  now = Date.now(),
} = {}) {
  return createNodeEnvelope({
    from,
    to: '@relay',
    kind: BROWSER_TASK_RECORD_KIND,
    correlationId: taskId,
    now,
    payload: {
      record: 'verdict',
      claimable: false,
      taskId,
      command: 'open my meal plan and read the total',
      origin: 'browser-extension',
      claimedBy: from,
      executedBy: from,
      status: state,
      verdict,
      headline,
      steps,
      startedAt: new Date(now - 9_000).toISOString(),
      finishedAt: new Date(now - 1_000).toISOString(),
    },
  })
}

/* ------------------------------------------------ the status vocabulary */

test('only an achieved verdict may read completed; the rest stay honest', () => {
  assert.equal(browserTaskStatusFor({ record: 'claim' }), 'processing')
  assert.equal(
    browserTaskStatusFor({ record: 'verdict', verdict: 'achieved', status: 'finished' }),
    'completed',
  )
  // The GAP this file exists for: an incomplete run must never render Done.
  assert.equal(
    browserTaskStatusFor({ record: 'verdict', verdict: 'incomplete', status: 'finished' }),
    'incomplete',
  )
  assert.equal(
    browserTaskStatusFor({ record: 'verdict', verdict: 'recon-only', status: 'finished' }),
    'read_only',
  )
  assert.equal(
    browserTaskStatusFor({ record: 'verdict', verdict: 'parked', status: 'parked' }),
    'needs_approval',
  )
  assert.equal(
    browserTaskStatusFor({ record: 'verdict', verdict: 'failed', status: 'failed' }),
    'failed',
  )
  assert.equal(
    browserTaskStatusFor({ record: 'verdict', verdict: 'handoff', status: 'handed-off' }),
    'handed_off',
  )
  // No verdict at all: the run ended, but nothing may claim the goal was met.
  assert.equal(
    browserTaskStatusFor({ record: 'verdict', status: 'finished' }),
    'finished',
  )
  // The one status claimNextJob claims can never be produced or stored.
  assert.notEqual(browserTaskStatusFor({ record: 'claim' }), 'queued')
})

/* --------------------------------------------------------- the consumer */

test('the consumer leaves other kinds to the queue and owns its own', async () => {
  const store = createMemoryStore()
  const other = await consumeBrowserTaskRecordMail({
    store,
    envelope: createNodeEnvelope({
      from: BROWSER_DEVICE,
      to: '@relay',
      kind: 'approval_decision',
      payload: { approvalId: 'apr-1', decision: 'approve' },
    }),
  })
  assert.deepEqual(other, { consumed: false })

  const outcome = await consumeBrowserTaskRecordMail({
    store,
    envelope: claimEnvelope(),
  })
  assert.equal(outcome.consumed, true)
  assert.equal(outcome.receipt.ok, true)
  assert.equal(outcome.receipt.code, 'recorded')
  assert.equal(outcome.receipt.kind, BROWSER_TASK_RECORD_KIND)
  assert.equal(outcome.receipt.taskId, TASK_ID)
  assert.equal(outcome.receipt.status, 'processing')

  const row = await store.getJob(browserTaskJobId(TASK_ID))
  assert.equal(row.type, BROWSER_TASK_JOB_TYPE)
  assert.equal(row.status, 'processing')
  assert.equal(row.claimable, false)
  assert.equal(row.executedBy, BROWSER_DEVICE)
})

test('a malformed record is consumed with a refusal, never queued as a corpse', async () => {
  const store = createMemoryStore()
  const outcome = await consumeBrowserTaskRecordMail({
    store,
    envelope: createNodeEnvelope({
      from: BROWSER_DEVICE,
      to: '@relay',
      kind: BROWSER_TASK_RECORD_KIND,
      payload: { record: 'claim' /* no taskId */ },
    }),
  })
  assert.equal(outcome.consumed, true)
  assert.equal(outcome.receipt.ok, false)
  assert.equal(outcome.receipt.code, 'invalid_record')
  assert.equal((await store.listJobs({ type: BROWSER_TASK_JOB_TYPE })).length, 0)
})

/* ---------------------------------------------- idempotence / replays */

test('replayed records never duplicate a row; the verdict upgrades the claim', async () => {
  const store = createMemoryStore()

  await foldBrowserTaskRecord({ store, envelope: claimEnvelope() })
  // At-least-once delivery: the same record resent is one row, not two.
  const replay = await foldBrowserTaskRecord({ store, envelope: claimEnvelope() })
  assert.equal(replay.code, 'updated')

  const verdict = await foldBrowserTaskRecord({ store, envelope: verdictEnvelope() })
  assert.equal(verdict.code, 'updated')
  const verdictReplay = await foldBrowserTaskRecord({ store, envelope: verdictEnvelope() })
  assert.equal(verdictReplay.code, 'updated')

  const rows = await store.listJobs({ type: BROWSER_TASK_JOB_TYPE })
  assert.equal(rows.length, 1)
  assert.equal(rows[0].status, 'completed')
  assert.equal(rows[0].browser.phase, 'verdict')
  assert.equal(rows[0].browser.steps.length, 2)
})

test('a claim redelivered after the verdict cannot regress the terminal truth', async () => {
  const store = createMemoryStore()
  await foldBrowserTaskRecord({ store, envelope: verdictEnvelope() })

  const stale = await foldBrowserTaskRecord({ store, envelope: claimEnvelope() })
  assert.equal(stale.code, 'already_recorded')

  const row = await store.getJob(browserTaskJobId(TASK_ID))
  assert.equal(row.status, 'completed')
  assert.equal(row.browser.phase, 'verdict')
})

test('a parked run approved later moves needs_approval to the newer verdict', async () => {
  const store = createMemoryStore()
  await foldBrowserTaskRecord({
    store,
    envelope: verdictEnvelope({
      state: 'parked',
      verdict: 'parked',
      headline: 'Stopped before the irreversible step.',
    }),
  })
  assert.equal(
    (await store.getJob(browserTaskJobId(TASK_ID))).status,
    'needs_approval',
  )

  await foldBrowserTaskRecord({
    store,
    envelope: verdictEnvelope({ verdict: 'achieved', headline: 'Approved and done.' }),
  })
  const row = await store.getJob(browserTaskJobId(TASK_ID))
  assert.equal(row.status, 'completed')
  assert.equal((await store.listJobs({ type: BROWSER_TASK_JOB_TYPE })).length, 1)
})

/* ------------------------------------------------------- attribution */

test('attribution comes from the credentialled envelope, never the payload', async () => {
  const store = createMemoryStore()
  const envelope = claimEnvelope()
  // A payload that lies about who executed: the envelope's authenticated
  // sender wins, and the disagreement is kept as a note.
  envelope.payload.executedBy = 'mac-bridge-1'
  envelope.payload.claimedBy = 'mac-bridge-1'

  await foldBrowserTaskRecord({ store, envelope })
  const row = await store.getJob(browserTaskJobId(TASK_ID))
  assert.equal(row.executedBy, BROWSER_DEVICE)
  assert.equal(row.claimedBy, BROWSER_DEVICE)
  assert.equal(row.browser.senderClaimedExecutor, 'mac-bridge-1')
})

test('one node cannot overwrite another node\'s task record', async () => {
  const store = createMemoryStore()
  await foldBrowserTaskRecord({ store, envelope: claimEnvelope() })

  const outcome = await foldBrowserTaskRecord({
    store,
    envelope: verdictEnvelope({ from: 'ext-other-browser', verdict: 'failed', state: 'failed' }),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'not_your_task')

  const row = await store.getJob(browserTaskJobId(TASK_ID))
  assert.equal(row.status, 'processing')
  assert.equal(row.executedBy, BROWSER_DEVICE)
})

test('a taskId aimed at an existing non-browser job id is refused, not written', async () => {
  const store = createMemoryStore()
  await store.createJob({
    jobId: browserTaskJobId('shadowed'),
    type: 'plan',
    status: 'queued',
    command: 'real mac work',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })

  const outcome = await foldBrowserTaskRecord({
    store,
    envelope: claimEnvelope({ taskId: 'shadowed' }),
  })
  assert.equal(outcome.ok, false)
  assert.equal(outcome.code, 'id_collision')
  assert.equal((await store.getJob(browserTaskJobId('shadowed'))).command, 'real mac work')
})

/* -------------------------------------------- never claimable, ever */

test('the Mac work claim never serves a browser task, whatever its status', async () => {
  const store = createMemoryStore()
  await foldBrowserTaskRecord({ store, envelope: claimEnvelope() })
  assert.equal(await store.claimNextJob('mac-bridge-1'), null)

  // Even a hand-forged 'queued' row of this type is not work — the claim
  // excludes the TYPE, not merely the statuses the fold happens to produce.
  await store.createJob({
    jobId: 'btask_forged',
    type: BROWSER_TASK_JOB_TYPE,
    status: 'queued',
    command: 'forged',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  assert.equal(await store.claimNextJob('mac-bridge-1'), null)

  // A real queued plan job is still claimed — the guard removed nothing else.
  await store.createJob({
    jobId: 'job_real',
    type: 'plan',
    status: 'queued',
    command: 'real work',
    createdAt: new Date().toISOString(),
    updatedAt: new Date().toISOString(),
  })
  const claimed = await store.claimNextJob('mac-bridge-1')
  assert.equal(claimed.jobId, 'job_real')
})

test('the D1 claim query excludes the browser task type in SQL itself', async () => {
  const statements = []
  const db = {
    prepare(sql) {
      statements.push(sql)
      return {
        bind() {
          return this
        },
        async first() {
          return null
        },
        async all() {
          return { results: [] }
        },
        async run() {
          return { meta: { changes: 0 } }
        },
      }
    },
  }
  const store = createD1Store(db)
  await store.claimNextJob('mac-bridge-1')
  const claimSelect = statements.find((sql) => sql.includes("status = 'queued'"))
  assert.ok(claimSelect.includes("type <> 'browser_task'"))
})

test('the D1 list query pages multiple types under one cursor', async () => {
  const statements = []
  const db = {
    prepare(sql) {
      const call = { sql, bindings: [] }
      statements.push(call)
      return {
        bind(...bindings) {
          call.bindings = bindings
          return this
        },
        async all() {
          return { results: [] }
        },
        async first() {
          return null
        },
        async run() {
          return { meta: { changes: 0 } }
        },
      }
    },
  }
  const store = createD1Store(db)

  await store.listJobs({ type: ['plan', BROWSER_TASK_JOB_TYPE], limit: 10 })
  assert.ok(statements[0].sql.includes('type IN (?1, ?2)'))
  assert.deepEqual(statements[0].bindings, ['plan', BROWSER_TASK_JOB_TYPE, 10])

  await store.listJobs({
    type: ['plan', BROWSER_TASK_JOB_TYPE],
    limit: 10,
    before: { createdAt: '2026-08-09T10:00:00.000Z', jobId: 'job_x' },
  })
  const cursored = statements[1]
  assert.ok(cursored.sql.includes('type IN (?1, ?2)'))
  assert.ok(cursored.sql.includes('created_at <'))
  assert.deepEqual(cursored.bindings.slice(0, 2), ['plan', BROWSER_TASK_JOB_TYPE])
})

/* ------------------------------------------------- the history page */

test('browser tasks appear in the history page, in order, attributed, honest', async () => {
  const store = createMemoryStore()
  const now = Date.now()

  await store.createJob({
    jobId: 'job_plan',
    type: 'plan',
    status: 'completed',
    command: 'what is on my calendar',
    inputTelemetry: { storage: 'dashboard', inputMode: 'typed' },
    result: { response: 'Two meetings.', executed: true },
    createdAt: new Date(now - 60_000).toISOString(),
    updatedAt: new Date(now - 55_000).toISOString(),
  })
  await foldBrowserTaskRecord({
    store,
    envelope: verdictEnvelope({
      verdict: 'incomplete',
      state: 'finished',
      headline: 'NOT done: the final submit step never ran.',
      now: now - 30_000,
    }),
  })

  const jobs = await store.listJobs({ type: ['plan', BROWSER_TASK_JOB_TYPE], limit: 40 })
  const page = buildHistoryPage({ jobs, captures: [], limit: 20 })

  assert.equal(page.entries.length, 2)
  // Newest first: the browser run started ~9s before its verdict fold time,
  // still newer than the minute-old plan job.
  const [browserEntry, planEntry] = page.entries
  assert.equal(browserEntry.kind, 'browser_task')
  assert.equal(browserEntry.pipelineId, browserTaskJobId(TASK_ID))
  assert.equal(planEntry.pipelineId, 'job_plan')

  // Honest status: incomplete is not Done, on both fields the dashboard reads.
  assert.equal(browserEntry.status, 'incomplete')
  assert.equal(browserEntry.jobStatus, 'incomplete')

  // Attribution: executed by the browser node, marked never-claimable.
  assert.equal(browserEntry.executor, 'browser')
  assert.equal(browserEntry.executedBy, BROWSER_DEVICE)
  assert.equal(browserEntry.claimedBy, BROWSER_DEVICE)
  assert.equal(browserEntry.claimable, false)
  assert.equal(browserEntry.source, BROWSER_DEVICE)
  assert.equal(browserEntry.origin, 'browser-extension')

  // The ledger-derived line rides the reply field; audio is honestly absent.
  assert.match(browserEntry.reply, /NOT done/)
  assert.equal(browserEntry.audio.available, false)
  assert.equal(browserEntry.eventCount, 2)
})

test('history search reaches browser outcomes like Mac ones', async () => {
  const store = createMemoryStore()
  await foldBrowserTaskRecord({
    store,
    envelope: verdictEnvelope({ headline: 'Cancelled the trial subscription.' }),
  })
  const jobs = await store.listJobs({ type: ['plan', BROWSER_TASK_JOB_TYPE] })

  const hit = buildHistoryPage({ jobs, captures: [], query: 'trial subscription' })
  assert.equal(hit.entries.length, 1)
  const miss = buildHistoryPage({ jobs, captures: [], query: 'lawnmower' })
  assert.equal(miss.entries.length, 0)
})

test('a pendant capture with the same words is never linked to a browser run', async () => {
  const store = createMemoryStore()
  const now = Date.now()
  await foldBrowserTaskRecord({ store, envelope: verdictEnvelope({ now }) })

  const capture = {
    jobId: 'job_capture',
    type: 'audio_capture',
    status: 'completed',
    transcript: 'open my meal plan and read the total',
    audioBase64: 'QUJD',
    audioBytes: 3,
    format: 'wav',
    createdAt: new Date(now - 5_000).toISOString(),
    updatedAt: new Date(now - 5_000).toISOString(),
  }

  const jobs = await store.listJobs({ type: ['plan', BROWSER_TASK_JOB_TYPE] })
  const page = buildHistoryPage({ jobs, captures: [capture], limit: 20 })

  const browserEntry = page.entries.find((entry) => entry.kind === 'browser_task')
  assert.equal(browserEntry.audio.available, false)
  // The capture still surfaces as its own conversational run.
  assert.ok(page.entries.some((entry) => entry.pipelineId === 'job_capture'))
})

/* ------------------------------------------------------ the detail view */

test('the run detail carries the step trace and the extension\'s own verdict', async () => {
  const store = createMemoryStore()
  await foldBrowserTaskRecord({
    store,
    envelope: verdictEnvelope({
      steps: [
        { tool: 'navigate', effect: 'act', ok: true, summary: 'Opened billing', at: new Date().toISOString() },
        { tool: 'click', effect: 'outward', ok: false, summary: 'Cancel button missing', at: new Date().toISOString() },
      ],
      verdict: 'incomplete',
      headline: 'NOT done: the cancel step never ran.',
    }),
  })

  const detail = browserTaskRunDetail(await store.getJob(browserTaskJobId(TASK_ID)))
  assert.equal(detail.status, 'incomplete')
  assert.equal(detail.events.length, 3) // two steps + the verdict line
  assert.equal(detail.events.at(-1).stage, 'verdict')
  assert.equal(detail.events.at(-1).status, 'failed')
  assert.match(detail.events.at(-1).label, /NOT done/)
  assert.equal(detail.execution.ok, null)
  assert.equal(detail.execution.status, 'incomplete')
  assert.equal(detail.execution.results.length, 2)
  assert.equal(detail.execution.results[1].ok, false)
  assert.equal(detail.createdBy, BROWSER_DEVICE)

  // A claim-only row reads as still running, with no execution block to
  // mistake for an outcome.
  const claimStore = createMemoryStore()
  await foldBrowserTaskRecord({ store: claimStore, envelope: claimEnvelope() })
  const running = browserTaskRunDetail(
    await claimStore.getJob(browserTaskJobId(TASK_ID)),
  )
  assert.equal(running.status, 'processing')
  assert.equal(running.execution, null)
  assert.equal(running.events.at(-1).status, 'active')

  // Non-browser rows are someone else's business.
  assert.equal(historyEntryForBrowserTask({ type: 'plan' }), null)
  assert.equal(browserTaskRunDetail({ type: 'plan' }), null)
})

/* -------------------------------------- the seam, exercised over HTTP */

async function relayFor(principal, store) {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.relayPrincipal = principal
    next()
  })
  registerNodeMeshRoutes(app, {
    getStore: async () => store,
    relayMail: composeRelayMail(
      consumeRelayApprovalMail,
      consumeBrowserTaskRecordMail,
    ),
  })

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const { port } = server.address()
  return {
    async call(method, path, body) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      })
      return { status: response.status, body: await response.json() }
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

test('a record POSTed to the mesh is consumed in the send request itself', async () => {
  const store = createMemoryStore()
  await store.saveDevice({ deviceId: BROWSER_DEVICE, deviceType: 'browser_node' })
  const relay = await relayFor(
    { kind: 'device', tokenId: 'tok-b', deviceId: BROWSER_DEVICE, role: 'browser_node', scopes: [] },
    store,
  )

  try {
    const sent = await relay.call('POST', '/v1/node/messages', {
      to: '@relay',
      kind: BROWSER_TASK_RECORD_KIND,
      correlationId: TASK_ID,
      payload: claimEnvelope().payload,
    })
    assert.equal(sent.status, 202)
    assert.equal(sent.body.consumed, true)
    assert.equal(sent.body.receipt.code, 'recorded')
    assert.equal(sent.body.queued, false)

    // Folded, not parked: nothing waits in the '@relay' inbox…
    assert.equal(await store.countPendingNodeMessages('@relay'), 0)
    // …the row is in the history store, attributed to the CREDENTIAL even
    // though the HTTP body could not name a sender at all…
    const row = await store.getJob(browserTaskJobId(TASK_ID))
    assert.equal(row.executedBy, BROWSER_DEVICE)
    // …and the Mac's work feed cannot see it.
    assert.equal(await store.claimNextJob('mac-bridge-1'), null)
  } finally {
    await relay.close()
  }
})

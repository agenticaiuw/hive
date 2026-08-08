import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

/*
 * First, before anything that reads config.js: every default store below —
 * including the executor's, exercised end to end — must resolve into the temp
 * workspace, and testWorkspace.js also points PENDANT_COMMONS_DIR into it so
 * no test can deposit into the committee's real diagnostics/harness-derivation.
 */
import { testWorkspacePath } from './testWorkspace.js'

import { commonsPaths } from '../scripts/commons.mjs'
import { createCapabilityRegistry } from '../shared/capabilityRegistry.js'
import {
  DEDUP_WINDOW_MS,
  listGaps,
  recordGap,
  recordGapSafely,
  registerCapabilityGapInboxRoutes,
  resolveGap,
} from './capabilityGapInbox.js'
import { registerGoalRouterRoutes } from './goalRouter.js'

const T0 = Date.parse('2026-08-08T10:00:00.000Z')

let storeCount = 0
const tempStore = () =>
  path.join(testWorkspacePath, `gap-inbox-${(storeCount += 1)}.json`)

const tempCommons = () => {
  const dir = fs.mkdtempSync(path.join(testWorkspacePath, 'commons-'))
  return dir
}

const quietWarn = () => {}

/* Same shape as goalRouter.test.js's fakeApp, plus URL params for /:id. */
function fakeApp() {
  const routes = new Map()
  const app = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  }
  const call = async (method, route, { body = {}, params = {} } = {}) => {
    const handler = routes.get(`${method} ${route}`)
    assert.ok(handler, `no handler for ${method} ${route}`)
    let statusCode = 200
    let payload = null
    await handler(
      { body, params },
      {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        },
      },
    )
    return { statusCode, payload }
  }
  return { app, call, routes }
}

/* ---- recording ----------------------------------------------------------- */

test('each writer source records, with its fields intact', () => {
  const filePath = tempStore()
  const commonsDir = tempCommons()
  const options = { filePath, commonsDir, warn: quietWarn }

  const planner = recordGap(
    {
      source: 'planner-unsupported',
      want: 'fax the lease to the landlord',
      detail: 'LLM could not plan this command.',
      surface: 'pendant',
      jobId: 'local_123',
    },
    { ...options, now: T0 },
  )
  recordGap(
    {
      source: 'goal-router-unroutable',
      want: 'water the plants while I am away',
      detail: 'nothing on any published surface answers to "goal actuate"',
      surface: 'goal-router',
    },
    { ...options, now: T0 + 1000 },
  )
  recordGap(
    {
      source: 'executor-missing-action',
      want: 'Summon a ride',
      detail: 'Unsupported action type: summon_ride',
      surface: 'executor',
    },
    { ...options, now: T0 + 2000 },
  )

  assert.equal(planner.deduped, false)
  assert.equal(planner.gap.timesAsked, 1)
  assert.equal(planner.gap.jobId, 'local_123')
  assert.equal(planner.gap.surface, 'pendant')
  assert.equal(planner.gap.resolvedAt, null)

  const listed = listGaps({ filePath })
  assert.equal(listed.counts.total, 3)
  assert.equal(listed.counts.open, 3)
  assert.equal(listed.counts.resolved, 0)
  assert.deepEqual(listed.counts.bySource, {
    'planner-unsupported': 1,
    'goal-router-unroutable': 1,
    'executor-missing-action': 1,
  })
  /* Newest ask first. */
  assert.deepEqual(
    listed.gaps.map((gap) => gap.source),
    ['executor-missing-action', 'goal-router-unroutable', 'planner-unsupported'],
  )

  assert.throws(
    () => recordGap({ source: 'made-up', want: 'x' }, options),
    /unknown source/,
  )
  assert.throws(() => recordGap({ source: 'planner-unsupported', want: '   ' }, options), /required/)
})

test('the same ask inside 24h increments timesAsked instead of duplicating', () => {
  const filePath = tempStore()
  const commonsDir = tempCommons()
  const options = { filePath, commonsDir, warn: quietWarn }

  const first = recordGap(
    { source: 'planner-unsupported', want: 'Send a fax to Dr. Kim', detail: 'no fax capability' },
    { ...options, now: T0 },
  )
  /* Case and whitespace differences are the same ask, and a second writer
   * seeing the same demand is a second ask, not a second record. */
  const second = recordGap(
    { source: 'goal-router-unroutable', want: '  send a   FAX to dr. kim ' },
    { ...options, now: T0 + 60 * 60 * 1000 },
  )

  assert.equal(second.deduped, true)
  assert.equal(second.gap.id, first.gap.id)
  assert.equal(second.gap.timesAsked, 2)
  assert.equal(second.gap.lastAskedAt, new Date(T0 + 60 * 60 * 1000).toISOString())
  assert.deepEqual(second.gap.sources, ['planner-unsupported', 'goal-router-unroutable'])
  assert.equal(listGaps({ filePath }).counts.total, 1)
  assert.equal(listGaps({ filePath }).counts.asks, 2)

  /* Outside the window (measured from the LAST ask) it is a fresh record. */
  const later = recordGap(
    { source: 'planner-unsupported', want: 'send a fax to dr. kim' },
    { ...options, now: T0 + 60 * 60 * 1000 + DEDUP_WINDOW_MS + 1000 },
  )
  assert.equal(later.deduped, false)
  assert.equal(listGaps({ filePath }).counts.total, 2)
})

test('a resolved gap does not absorb new asks — asking again reopens the file', () => {
  const filePath = tempStore()
  const options = { filePath, commonsDir: tempCommons(), warn: quietWarn }

  const first = recordGap(
    { source: 'planner-unsupported', want: 'order groceries' },
    { ...options, now: T0 },
  )
  resolveGap(first.gap.id, 'shipped in groceryRun.js', { filePath, now: T0 + 1000 })

  const again = recordGap(
    { source: 'planner-unsupported', want: 'order groceries' },
    { ...options, now: T0 + 2000 },
  )
  assert.equal(again.deduped, false)
  assert.notEqual(again.gap.id, first.gap.id)
  assert.equal(listGaps({ filePath }).counts.total, 2)
  assert.equal(listGaps({ filePath }).counts.open, 1)
})

/* ---- resolve ------------------------------------------------------------- */

test('resolveGap marks and never deletes; unknown ids say so', () => {
  const filePath = tempStore()
  const options = { filePath, commonsDir: tempCommons(), warn: quietWarn }

  const { gap } = recordGap(
    { source: 'executor-missing-action', want: 'dim the porch light' },
    { ...options, now: T0 },
  )

  const resolved = resolveGap(gap.id, 'porchLight.js landed', { filePath, now: T0 + 5000 })
  assert.equal(resolved.resolvedAt, new Date(T0 + 5000).toISOString())
  assert.equal(resolved.resolutionNote, 'porchLight.js landed')

  const listed = listGaps({ filePath })
  assert.equal(listed.counts.total, 1, 'resolving must not delete the record')
  assert.equal(listed.counts.resolved, 1)
  assert.equal(listed.gaps[0].resolvedAt, resolved.resolvedAt)

  /* Idempotent: the first resolution time stands. */
  const twice = resolveGap(gap.id, 'noticed again', { filePath, now: T0 + 99000 })
  assert.equal(twice.resolvedAt, resolved.resolvedAt)

  assert.equal(resolveGap('gap_does-not-exist', '', { filePath }), null)
})

/* ---- secrets ------------------------------------------------------------- */

test('a credential in the ask or the error never reaches disk', () => {
  const filePath = tempStore()
  const commonsDir = tempCommons()
  const token = 'sk-live-abcdef1234567890XY'

  const { gap } = recordGap(
    {
      source: 'planner-unsupported',
      want: `connect stripe using key ${token}`,
      detail: `planner error: key ${token} was rejected`,
    },
    { filePath, commonsDir, warn: quietWarn, now: T0 },
  )

  assert.ok(gap.want.includes('[withheld]'))
  assert.ok(!gap.want.includes(token))
  assert.ok(!gap.detail.includes(token))

  /* The stored bytes, not just the returned object. */
  assert.ok(!fs.readFileSync(filePath, 'utf8').includes(token))

  /* And the commons mirror: log line and content payloads. */
  const { log, content } = commonsPaths(commonsDir)
  assert.ok(!fs.readFileSync(log, 'utf8').includes(token))
  for (const name of fs.readdirSync(content)) {
    assert.ok(!fs.readFileSync(path.join(content, name), 'utf8').includes(token))
  }
})

/* ---- failure isolation --------------------------------------------------- */

test('an unwritable store loses the gap, warns once, and breaks nobody', () => {
  /* Parent path is a plain file, so every mkdir/write under it must fail. */
  const notADir = path.join(testWorkspacePath, `not-a-dir-${Date.now()}`)
  fs.writeFileSync(notADir, 'plain file')
  const filePath = path.join(notADir, 'inbox.json')

  const warns = []
  const out = recordGapSafely(
    { source: 'planner-unsupported', want: 'anything at all' },
    { filePath, warn: (reason, message) => warns.push({ reason, message }) },
  )

  assert.equal(out, null, 'the safe writer reports failure as null, never a throw')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /not recorded/)
})

test('a broken commons mirror still keeps the gap locally', () => {
  const filePath = tempStore()
  /* Exists, but is a file: deposit()'s mkdir under it must throw. */
  const commonsDir = path.join(testWorkspacePath, `commons-as-file-${Date.now()}`)
  fs.writeFileSync(commonsDir, 'plain file')

  const warns = []
  const { gap, deduped } = recordGap(
    { source: 'goal-router-unroutable', want: 'sync my running watch' },
    { filePath, commonsDir, warn: (reason, message) => warns.push({ reason, message }), now: T0 },
  )

  assert.equal(deduped, false)
  assert.equal(listGaps({ filePath }).gaps[0].id, gap.id, 'the local inbox is the source of truth')
  assert.equal(warns.length, 1)
  assert.match(warns[0].message, /deposit failed/)
})

/* ---- the commons deposit ------------------------------------------------- */

test('a NEW gap deposits into the commons in the shape the committee folds', () => {
  const filePath = tempStore()
  const commonsDir = tempCommons()
  const options = { filePath, commonsDir, warn: quietWarn }

  recordGap(
    {
      source: 'planner-unsupported',
      want: 'Send a fax to Dr. Kim',
      detail: 'planner: no fax capability',
      surface: 'pendant',
    },
    { ...options, now: T0 },
  )
  /* A dedup increment is not novelty and must not wake the committee. */
  recordGap(
    { source: 'planner-unsupported', want: 'send a fax to dr. kim' },
    { ...options, now: T0 + 1000 },
  )

  const { log, content } = commonsPaths(commonsDir)
  const lines = fs.readFileSync(log, 'utf8').trim().split('\n')
  assert.equal(lines.length, 1, 'one deposit for one new gap, none for the increment')

  const record = JSON.parse(lines[0])
  assert.equal(record.tool, 'capability_gap')
  assert.equal(record.agent, 'runtime')
  assert.equal(record.round, 0)
  assert.equal(record.absent, false, 'a gap is a fact, not an absence')
  assert.equal(record.at, new Date(T0).toISOString())
  assert.deepEqual(record.args, {
    source: 'planner-unsupported',
    want: 'Send a fax to Dr. Kim',
  })

  const payload = JSON.parse(
    fs.readFileSync(path.join(content, `${record.hash}.json`), 'utf8'),
  )
  assert.deepEqual(payload, {
    want: 'Send a fax to Dr. Kim',
    detail: 'planner: no fax capability',
    surface: 'pendant',
    timesAsked: 1,
  })
})

/* ---- http ---------------------------------------------------------------- */

test('the inbox routes list newest-first with counts, and resolve by id', async () => {
  const filePath = tempStore()
  const options = { filePath, commonsDir: tempCommons(), warn: quietWarn }

  recordGap({ source: 'planner-unsupported', want: 'older ask' }, { ...options, now: T0 })
  const newer = recordGap(
    { source: 'executor-missing-action', want: 'newer ask' },
    { ...options, now: T0 + 1000 },
  )

  const { app, call, routes } = fakeApp()
  const mounted = registerCapabilityGapInboxRoutes(app, { filePath })
  assert.deepEqual(mounted, [
    'GET /capability-gaps/inbox',
    'POST /capability-gaps/inbox/:id/resolve',
  ])
  assert.deepEqual([...routes.keys()], mounted)

  const listed = await call('GET', '/capability-gaps/inbox')
  assert.equal(listed.statusCode, 200)
  assert.equal(listed.payload.ok, true)
  assert.equal(listed.payload.counts.open, 2)
  assert.deepEqual(
    listed.payload.gaps.map((gap) => gap.want),
    ['newer ask', 'older ask'],
  )

  const resolved = await call('POST', '/capability-gaps/inbox/:id/resolve', {
    params: { id: newer.gap.id },
    body: { note: 'built it' },
  })
  assert.equal(resolved.statusCode, 200)
  assert.equal(resolved.payload.gap.resolutionNote, 'built it')

  const after = await call('GET', '/capability-gaps/inbox')
  assert.equal(after.payload.counts.open, 1)
  assert.equal(after.payload.counts.resolved, 1)

  const missing = await call('POST', '/capability-gaps/inbox/:id/resolve', {
    params: { id: 'gap_nope' },
  })
  assert.equal(missing.statusCode, 404)

  assert.throws(() => registerCapabilityGapInboxRoutes({}), /Express-style app/)
})

/* ---- the writers, end to end --------------------------------------------- */

test('the goal-router /route handler files every unroutable part as a gap', async () => {
  const recorded = []
  const { app, call } = fakeApp()
  registerGoalRouterRoutes(app, {
    /* An empty registry: nothing can do anything, so a web read is unroutable. */
    loadContext: async () => ({ registry: createCapabilityRegistry(), surfaces: {} }),
    recordGap: (gap) => recorded.push(gap),
  })

  const { statusCode, payload } = await call('POST', '/goal-router/route', {
    body: { goal: 'read https://example.com/pricing' },
  })
  assert.equal(statusCode, 200, 'recording must not change the routing response')
  assert.ok(payload.plan.unroutable.length >= 1)

  /* noteUnroutable is fire-and-forget; give the microtask queue a beat. */
  await Promise.resolve()
  assert.equal(recorded.length, payload.plan.unroutable.length)
  assert.equal(recorded[0].source, 'goal-router-unroutable')
  assert.equal(recorded[0].want, payload.plan.unroutable[0].text)
  assert.equal(recorded[0].detail, payload.plan.unroutable[0].why)
  assert.equal(recorded[0].surface, 'goal-router')
})

test('an unsupported plan no longer evaporates in the orchestrator', async () => {
  /* Before llmPlanner.js is first imported: its LLM_ENABLED is a module-level
   * const, and 'false' here means planCommand refuses without a network call. */
  process.env.LLM_ENABLED = 'false'
  const { orchestratePlan } = await import('./orchestrator.js')

  const result = await orchestratePlan({
    command: 'flibber the wozzle backwards',
    source: 'local',
  })
  assert.equal(result.status, 'unsupported', 'the owner still gets the same refusal')

  const gap = listGaps().gaps.find((entry) => entry.source === 'planner-unsupported')
  assert.ok(gap, 'the refused ask was filed as a capability gap')
  assert.equal(gap.want, 'flibber the wozzle backwards')
  assert.equal(gap.surface, 'local')
  assert.ok(gap.detail.length > 0)
})

test('an action type no dispatcher knows still fails cleanly and lands in the inbox', async () => {
  const { executeActions } = await import('./executor.js')

  const results = await executeActions([
    { type: 'summon_helicopter', label: 'Summon a helicopter', params: {} },
  ])
  assert.equal(results[0].ok, false, 'the step still fails exactly as before')
  assert.match(results[0].message, /Unsupported action type/)

  /* Default store — resolved under the temp workspace by testWorkspace.js. */
  const gap = listGaps().gaps.find((entry) => entry.source === 'executor-missing-action')
  assert.ok(gap, 'the refusal was recorded, not just reported')
  assert.equal(gap.want, 'Summon a helicopter')
  assert.match(gap.detail, /summon_helicopter/)
  assert.equal(gap.surface, 'executor')
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  DEFER_MAX_MS,
  DEFER_RETRY_MS,
  RETRY_BASE_MS,
  RETRY_MAX_ATTEMPTS,
  RETRY_MAX_MS,
  advanceRoutine,
  chooseVenue,
  composeOnRelay,
  createRoutine,
  jobParkedForApproval,
  occurrenceKey,
  planRetry,
  reapDispatchedRuns,
  retryDelayMs,
  routineCanRunOnRelay,
  runDueRoutines,
  updateRoutineRecord,
} from './routines.js'

/* A store with the same contract as d1Store/memoryStore, kept local so these
 * tests never depend on module-level singleton state. */
function fakeStore() {
  const routines = new Map()
  const runs = new Map()
  const announcements = new Map()
  const jobs = new Map()
  return {
    routines,
    runs,
    announcements,
    jobs,
    async saveRoutine(routine) {
      routines.set(routine.routineId, { ...routine })
      return routine
    },
    async getRoutine(id) {
      return routines.get(id) ?? null
    },
    async claimDueRoutines({ now, limit = 8 }) {
      return [...routines.values()]
        .filter((r) => r.enabled && r.nextRunAt && r.nextRunAt <= now)
        .slice(0, limit)
        .map((r) => ({ ...r }))
    },
    async recordRoutineRun(run) {
      runs.set(run.runId, { ...run })
      return run
    },
    /* routineId is filtered here because both real stores filter it, and the
     * retry guard depends on it: a fake that ignored it would let one
     * routine's receipts suppress another routine's retry. */
    async listRoutineRuns({ routineId = null, status = null, limit = 25 } = {}) {
      return [...runs.values()]
        .filter((run) => !routineId || run.routineId === routineId)
        .filter((run) => !status || run.status === status)
        .slice(0, limit)
    },
    async createAnnouncement(announcement) {
      announcements.set(announcement.announcementId, announcement)
      return announcement
    },
    async createJob(job) {
      jobs.set(job.jobId, job)
      return job
    },
    async getJob(jobId) {
      return jobs.get(jobId) ?? null
    },
  }
}

const NOW = Date.parse('2026-08-07T12:00:00Z')

const dueRoutine = (overrides = {}) => ({
  ...createRoutine({
    name: 'Morning news',
    command: 'summarize the top world news',
    schedule: { kind: 'daily', at: '07:00' },
    now: NOW,
    ...overrides,
  }),
  nextRunAt: NOW - 1,
})

const silentLogger = { log() {}, warn() {} }

test('a routine with an impossible schedule is refused at creation, not at 7am', () => {
  assert.throws(
    () => createRoutine({ command: 'brief me', schedule: { kind: 'daily', at: 'morning' } }),
    /HH:MM/,
  )
  assert.throws(() => createRoutine({ command: '', schedule: { kind: 'daily', at: '07:00' } }), /command/)
})

test('auto venue prefers the Mac when it is awake — it can act, the relay can only read', () => {
  const routine = dueRoutine()
  assert.equal(chooseVenue(routine, { macOnline: true }), 'mac')
  assert.equal(chooseVenue(routine, { macOnline: false }), 'relay')
})

test('work that needs the owner machine waits for it instead of being faked', () => {
  const macWork = createRoutine({
    command: 'summarize my calendar and unread email for today',
    schedule: { kind: 'daily', at: '07:00' },
    now: NOW,
  })
  assert.equal(routineCanRunOnRelay(macWork), false)
  // The relay has no Calendar and no Mail. Guessing would be worse than late.
  assert.equal(chooseVenue(macWork, { macOnline: false }), 'defer')
  assert.equal(chooseVenue(macWork, { macOnline: true }), 'mac')
})

test('an explicit venue is obeyed in both directions', () => {
  const relayOnly = dueRoutine({ venue: 'relay' })
  assert.equal(chooseVenue(relayOnly, { macOnline: true }), 'relay')
  const macOnly = createRoutine({
    command: 'read the news',
    schedule: { kind: 'daily', at: '07:00' },
    venue: 'mac',
    now: NOW,
  })
  assert.equal(chooseVenue(macOnly, { macOnline: false }), 'defer')
})

test('naming page sources makes a routine relay-capable regardless of wording', () => {
  const withSources = createRoutine({
    command: 'check the meeting notes page',
    schedule: { kind: 'interval', everyMs: 3_600_000 },
    sources: ['https://example.com/status'],
    now: NOW,
  })
  assert.equal(routineCanRunOnRelay(withSources), true)
})

test('the Mac asleep at 7am is the whole point: the relay runs it and queues speech', async () => {
  const store = fakeStore()
  await store.saveRoutine(dueRoutine())

  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => false,
    webSearch: async () => ({ ok: true, summary: 'Two things happened overnight.' }),
    logger: silentLogger,
  })

  assert.equal(runs.length, 1)
  assert.equal(runs[0].venue, 'relay')
  assert.equal(runs[0].status, 'completed')

  const announcement = [...store.announcements.values()][0]
  assert.equal(announcement.speech, 'Two things happened overnight.')
  assert.equal(announcement.state, 'pending')
  assert.equal(announcement.deviceId, 'nrf9160-pendant')
  assert.equal(announcement.runId, runs[0].runId)
})

test('an awake Mac gets a plain plan job — the same one a typed command makes', async () => {
  const store = fakeStore()
  await store.saveRoutine(dueRoutine())
  const enqueued = []

  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => true,
    enqueueMacJob: async ({ routine, receipt }) => {
      enqueued.push({ command: routine.command, runId: receipt.runId })
      return { jobId: 'job_1' }
    },
    logger: silentLogger,
  })

  assert.equal(runs[0].venue, 'mac')
  assert.equal(runs[0].status, 'dispatched')
  assert.equal(runs[0].macJobId, 'job_1')
  assert.equal(enqueued[0].command, 'summarize the top world news')
  // The occurrence is spent even though the answer has not returned, or the
  // next tick sixty seconds later would ask the Mac to do it all over again.
  assert.ok(store.routines.get(runs[0].routineId).nextRunAt > NOW)
})

test('"is the Mac awake?" is asked once per tick, and not at all when nothing is due', async () => {
  const store = fakeStore()
  let asked = 0
  const isMacOnline = async () => {
    asked += 1
    return false
  }

  await runDueRoutines({ store, now: NOW, isMacOnline, logger: silentLogger })
  assert.equal(asked, 0, 'an empty tick must not pay for a second D1 round trip')

  await store.saveRoutine(dueRoutine())
  await store.saveRoutine(dueRoutine())
  await runDueRoutines({
    store,
    now: NOW,
    isMacOnline,
    webSearch: async () => ({ ok: true, summary: 'news' }),
    logger: silentLogger,
  })
  assert.equal(asked, 1)
})

test('a Mac-only routine defers instead of burning its occurrence', async () => {
  const store = fakeStore()
  const routine = {
    ...createRoutine({
      command: 'summarize my calendar for today',
      schedule: { kind: 'daily', at: '07:00' },
      now: NOW,
    }),
    nextRunAt: NOW - 1,
  }
  await store.saveRoutine(routine)

  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => false,
    logger: silentLogger,
  })

  assert.equal(runs[0].status, 'deferred')
  const stored = store.routines.get(routine.routineId)
  assert.equal(stored.nextRunAt, NOW + DEFER_RETRY_MS)
  assert.ok(stored.deferredSince)
  // A routine waiting for the lid to open has not run: no receipt row, or one
  // a minute would bury the runs that did.
  assert.equal(store.runs.size, 0)
})

test('a deferred routine runs on the Mac the moment the lid opens', async () => {
  const store = fakeStore()
  const routine = {
    ...createRoutine({
      command: 'summarize my calendar for today',
      schedule: { kind: 'daily', at: '07:00' },
      now: NOW,
    }),
    nextRunAt: NOW - 1,
  }
  await store.saveRoutine(routine)

  await runDueRoutines({ store, now: NOW, isMacOnline: async () => false, logger: silentLogger })
  const laterNow = NOW + DEFER_RETRY_MS + 1
  const { runs } = await runDueRoutines({
    store,
    now: laterNow,
    isMacOnline: async () => true,
    enqueueMacJob: async () => ({ jobId: 'job_2' }),
    logger: silentLogger,
  })

  assert.equal(runs[0].status, 'dispatched')
  // The receipt is filed against the occurrence that came due, not the retry.
  assert.equal(runs[0].dueAt, new Date(NOW - 1).toISOString())
  assert.equal(store.routines.get(routine.routineId).deferredSince, null)
})

test('deferral is bounded: a lid closed for a day drops the occurrence, with a receipt', async () => {
  const store = fakeStore()
  const routine = {
    ...createRoutine({
      command: 'summarize my calendar for today',
      schedule: { kind: 'daily', at: '07:00' },
      now: NOW,
    }),
    nextRunAt: NOW - 1,
    deferredSince: new Date(NOW - DEFER_MAX_MS - 1).toISOString(),
  }
  await store.saveRoutine(routine)

  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => false,
    logger: silentLogger,
  })

  assert.equal(runs[0].status, 'missed')
  assert.match(runs[0].error, /stayed offline/)
  const stored = store.routines.get(routine.routineId)
  assert.equal(stored.deferredSince, null)
  assert.ok(stored.nextRunAt > NOW, 'the schedule moves on rather than piling up')
})

test('one failing routine does not take the tick down with it', async () => {
  const store = fakeStore()
  await store.saveRoutine({ ...dueRoutine({ name: 'broken' }) })
  await store.saveRoutine({ ...dueRoutine({ name: 'fine' }) })
  let call = 0

  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => false,
    webSearch: async () => {
      call += 1
      if (call === 1) throw new Error('search exploded')
      return { ok: true, summary: 'still worked' }
    },
    logger: silentLogger,
  })

  assert.deepEqual(runs.map((run) => run.status).sort(), ['completed', 'failed'])
  // Neither routine is stuck: one advanced, one is queued for another attempt.
  for (const routine of store.routines.values()) assert.ok(routine.nextRunAt > NOW)
})

test('a wall-clock routine that ran slowly still fires at the same time tomorrow', () => {
  const routine = {
    ...createRoutine({
      command: 'brief me',
      schedule: { kind: 'daily', at: '07:00' },
      now: NOW,
    }),
    dueSince: Date.parse('2026-08-07T12:00:00Z'),
  }
  // Four minutes of web search must not push 07:00 to 07:04 forever.
  const advanced = advanceRoutine(routine, {
    now: Date.parse('2026-08-07T12:04:00Z'),
    status: 'completed',
  })
  assert.equal(
    new Date(advanced.nextRunAt).toISOString(),
    '2026-08-08T12:00:00.000Z',
  )
  assert.equal(advanced.runCount, 1)
})

test('a routine that fires exactly on its second does not run twice', () => {
  // NOW is exactly 07:00 Chicago. Rescheduling from the occurrence rather
  // than from the clock hands back this same instant, and the next tick a
  // minute later runs the whole routine again.
  const routine = {
    ...createRoutine({
      command: 'brief me',
      schedule: { kind: 'daily', at: '07:00' },
      now: NOW,
    }),
    dueSince: NOW,
  }
  const advanced = advanceRoutine(routine, { now: NOW, status: 'completed' })
  assert.equal(new Date(advanced.nextRunAt).toISOString(), '2026-08-08T12:00:00.000Z')
})

test('interval routines count from the finish, not from the missed occurrence', () => {
  const routine = {
    ...createRoutine({
      command: 'check the status page',
      schedule: { kind: 'interval', everyMs: 3_600_000 },
      sources: ['https://example.com/status'],
      now: NOW,
    }),
    dueSince: NOW,
  }
  const advanced = advanceRoutine(routine, { now: NOW + 120_000, status: 'completed' })
  assert.equal(advanced.nextRunAt, NOW + 120_000 + 3_600_000)
})

test('page text is context for the search, never the answer on its own', async () => {
  const seen = []
  const composed = await composeOnRelay({
    routine: {
      command: 'what changed on the status page?',
      sources: ['https://example.com/status'],
    },
    readPage: async (url) => ({ ok: true, text: `contents of ${url}` }),
    webSearch: async (query) => {
      seen.push(query)
      return { ok: true, summary: 'Everything is green.' }
    },
  })
  assert.equal(composed.speech, 'Everything is green.')
  assert.equal(composed.source, 'browser-run+search')
  assert.match(seen[0], /Context already gathered/)
  assert.match(seen[0], /contents of https:\/\/example\.com\/status/)
})

test('a browser read still produces speech when the search is the thing that broke', async () => {
  const composed = await composeOnRelay({
    routine: { command: 'check it', sources: ['https://example.com/status'] },
    readPage: async () => ({ ok: true, text: 'All systems nominal.' }),
    webSearch: async () => ({ ok: false, error: 'rate limited' }),
  })
  assert.match(composed.speech, /All systems nominal/)
  assert.equal(composed.source, 'browser-run')
})

test('the relay says why it cannot run something rather than inventing an answer', async () => {
  await assert.rejects(
    composeOnRelay({ routine: { command: 'brief me', sources: [] } }),
    /no page sources and no web search/,
  )
  await assert.rejects(
    composeOnRelay({
      routine: { command: 'brief me' },
      webSearch: async () => ({ ok: false, error: 'no API key' }),
    }),
    /no API key/,
  )
})

test('a Mac routine that finished becomes an announcement — the loop actually closes', async () => {
  const store = fakeStore()
  const routine = dueRoutine()
  await store.saveRoutine(routine)
  await store.createJob({
    jobId: 'job_9',
    status: 'completed',
    result: { response: 'You had four meetings and answered two emails.' },
  })
  await store.recordRoutineRun({
    runId: 'run_9',
    routineId: routine.routineId,
    routineName: routine.name,
    status: 'dispatched',
    startedAt: new Date(NOW).toISOString(),
    macJobId: 'job_9',
  })

  const closed = await reapDispatchedRuns({ store, now: NOW + 60_000 })
  assert.equal(closed.length, 1)
  assert.equal(closed[0].status, 'completed')
  const announcement = [...store.announcements.values()][0]
  assert.equal(announcement.speech, 'You had four meetings and answered two emails.')
  assert.equal(announcement.state, 'pending')
})

test('a Mac job that never came back stops being waited on', async () => {
  const store = fakeStore()
  await store.recordRoutineRun({
    runId: 'run_10',
    routineId: 'rtn_x',
    status: 'dispatched',
    startedAt: new Date(NOW).toISOString(),
    macJobId: 'job_missing',
  })
  assert.deepEqual(await reapDispatchedRuns({ store, now: NOW + 60_000 }), [])
  const closed = await reapDispatchedRuns({ store, now: NOW + 31 * 60_000 })
  assert.equal(closed[0].status, 'failed')
  assert.match(closed[0].error, /never returned a result/)
})

/* ---- retries -------------------------------------------------------------
 * "Queue this up and tell me when it's done" is a one-shot, and a one-shot had
 * exactly one chance: nextRunAt() returns null for a spent {kind:'once'}, so a
 * failed attempt used to end the task permanently and silently.
 * ------------------------------------------------------------------------- */

/* A one-shot whose instant has already passed — the state a queued task is in
 * on the tick that runs it. Built through createRoutine with a past `now` so
 * the validation that rejects an unschedulable routine still applies. */
const queuedTask = (overrides = {}) => ({
  ...createRoutine({
    name: 'Compare the two laptops',
    command: 'compare the two laptops I asked about and say which is better',
    schedule: { kind: 'once', inMs: 60_000 },
    venue: 'relay',
    now: NOW - 60_000,
    ...overrides,
  }),
  nextRunAt: NOW - 1,
})

test('a queued one-shot survives a transient failure instead of vanishing', async () => {
  const store = fakeStore()
  const task = queuedTask()
  await store.saveRoutine(task)
  let call = 0

  const first = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => false,
    webSearch: async () => {
      call += 1
      if (call === 1) throw new Error('search rate limited')
      return { ok: true, summary: 'The lighter one, by a nose.' }
    },
    logger: silentLogger,
  })

  assert.equal(first.runs[0].status, 'failed')
  assert.equal(first.runs[0].final, false, 'a queued retry is not the end of the story')
  assert.equal(first.runs[0].nextAttemptAt, new Date(NOW + RETRY_BASE_MS).toISOString())
  // Nothing is said yet: a failure that is about to be retried is not news.
  assert.equal(store.announcements.size, 0)

  const armed = store.routines.get(task.routineId)
  assert.equal(armed.nextRunAt, NOW + RETRY_BASE_MS)
  assert.equal(armed.attempt, 1)
  assert.equal(armed.dueSince, NOW - 1, 'the retry belongs to the same occurrence')

  const second = await runDueRoutines({
    store,
    now: NOW + RETRY_BASE_MS,
    isMacOnline: async () => false,
    webSearch: async () => ({ ok: true, summary: 'The lighter one, by a nose.' }),
    logger: silentLogger,
  })
  assert.equal(second.runs[0].status, 'completed')
  assert.equal(second.runs[0].attempt, 2)
  assert.equal(
    [...store.announcements.values()][0].speech,
    'The lighter one, by a nose.',
  )
  // Both attempts are in the log; "it worked on the second try" is visible.
  assert.equal(store.runs.size, 2)
  assert.equal(
    new Set([...store.runs.values()].map((run) => run.occurrenceKey)).size,
    1,
  )
})

test('when the retries run out the owner is told, not just the log', async () => {
  const store = fakeStore()
  const task = { ...queuedTask(), attempt: RETRY_MAX_ATTEMPTS - 1, dueSince: NOW - 1 }
  await store.saveRoutine(task)

  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => false,
    webSearch: async () => {
      throw new Error('search rate limited')
    },
    logger: silentLogger,
  })

  assert.equal(runs[0].status, 'failed')
  assert.equal(runs[0].final, true)
  assert.match(runs[0].stoppedBecause, /failed 3 times/)

  // The whole point of the feature: silence is the one outcome that must not
  // happen. A queued task that will never finish has to say so out loud.
  const announcement = [...store.announcements.values()][0]
  assert.match(announcement.speech, /Compare the two laptops did not finish/)
  assert.match(announcement.speech, /rate limited/)
  assert.equal(announcement.runId, runs[0].runId)
  assert.equal(store.routines.get(task.routineId).nextRunAt, null)
})

test('a routine the owner asked not to announce stays quiet even when it fails', async () => {
  const store = fakeStore()
  await store.saveRoutine({
    ...queuedTask({ announce: false }),
    attempt: RETRY_MAX_ATTEMPTS - 1,
    dueSince: NOW - 1,
  })

  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => false,
    webSearch: async () => {
      throw new Error('nope')
    },
    logger: silentLogger,
  })
  assert.equal(runs[0].final, true)
  assert.equal(store.announcements.size, 0)
})

test('retries back off, and never outrun the schedule that would rerun it anyway', () => {
  assert.deepEqual(
    [1, 2, 3, 9].map(retryDelayMs),
    [RETRY_BASE_MS, RETRY_BASE_MS * 2, RETRY_BASE_MS * 4, RETRY_MAX_MS],
  )

  const fast = createRoutine({
    command: 'check the status page',
    schedule: { kind: 'interval', everyMs: 60_000 },
    sources: ['https://example.com/status'],
    now: NOW,
  })
  // A minute-interval routine retrying in a minute is racing itself: two
  // claims for what the owner thinks of as one job. Let the schedule do it.
  const raced = planRetry({ ...fast, dueSince: NOW }, { now: NOW, attempt: 1 })
  assert.equal(raced.retry, false)
  assert.match(raced.reason, /next scheduled run arrives sooner/)

  // A spent one-shot has no next occurrence at all, which is exactly the case
  // that has nothing else to fall back on.
  const once = { ...queuedTask(), dueSince: NOW - 1 }
  assert.equal(planRetry(once, { now: NOW, attempt: 1 }).retry, true)

  // Twelve hours, same as DEFER_MAX_MS: an answer about this morning is worth
  // nothing tomorrow, and stale retries would all come due at once.
  const stale = { ...once, dueSince: NOW - DEFER_MAX_MS - 1 }
  assert.equal(planRetry(stale, { now: NOW, attempt: 1 }).retry, false)
  assert.match(planRetry(stale, { now: NOW, attempt: 1 }).reason, /too old/)
})

/* ---- idempotency ---------------------------------------------------------
 * dispatchToMac() is fire-and-forget, so a retry and a completion can be in
 * flight at the same time. The Mac not answering within MAC_RESULT_MAX_WAIT_MS
 * is not the Mac having stopped.
 * ------------------------------------------------------------------------- */

test('a retry that races a completion does not run the command a second time', async () => {
  const store = fakeStore()
  const routine = { ...dueRoutine(), attempt: 1, dueSince: NOW - 1 }
  await store.saveRoutine(routine)
  /* The earlier attempt finished while this retry was already queued. */
  await store.recordRoutineRun({
    runId: 'run_first',
    routineId: routine.routineId,
    status: 'completed',
    startedAt: new Date(NOW - 60_000).toISOString(),
    occurrenceKey: occurrenceKey(routine.routineId, new Date(NOW - 1).toISOString()),
  })

  let enqueued = 0
  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => true,
    enqueueMacJob: async () => {
      enqueued += 1
      return { jobId: 'job_dup' }
    },
    logger: silentLogger,
  })

  assert.equal(enqueued, 0, 'the same command must not reach the Mac twice')
  assert.equal(runs[0].status, 'superseded')
  assert.match(runs[0].error, /already completed as run_first/)
  // The refusal is recorded: "the guard fired" and "nothing was due" have to
  // look different, or the guard cannot be shown to work.
  assert.equal(store.runs.size, 2)
  assert.ok(store.routines.get(routine.routineId).nextRunAt > NOW)
})

test('a retry while the first attempt is still on the Mac waits rather than doubling', async () => {
  const store = fakeStore()
  const routine = { ...dueRoutine(), attempt: 1, dueSince: NOW - 1 }
  await store.saveRoutine(routine)
  await store.recordRoutineRun({
    runId: 'run_inflight',
    routineId: routine.routineId,
    status: 'dispatched',
    startedAt: new Date(NOW - 60_000).toISOString(),
    macJobId: 'job_slow',
    occurrenceKey: occurrenceKey(routine.routineId, new Date(NOW - 1).toISOString()),
  })

  let enqueued = 0
  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => true,
    enqueueMacJob: async () => {
      enqueued += 1
      return { jobId: 'job_dup' }
    },
    logger: silentLogger,
  })

  assert.equal(enqueued, 0)
  assert.match(runs[0].error, /still running on the Mac as run_inflight/)
})

test('another routine failing at the same instant never suppresses this one', async () => {
  const store = fakeStore()
  const mine = { ...dueRoutine(), attempt: 1, dueSince: NOW - 1 }
  await store.saveRoutine(mine)
  /* Same occurrence instant, different routine: the key must not collide. */
  await store.recordRoutineRun({
    runId: 'run_someone_else',
    routineId: 'rtn_other',
    status: 'completed',
    startedAt: new Date(NOW - 60_000).toISOString(),
    occurrenceKey: occurrenceKey('rtn_other', new Date(NOW - 1).toISOString()),
  })

  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => false,
    webSearch: async () => ({ ok: true, summary: 'ran fine' }),
    logger: silentLogger,
  })
  assert.equal(runs[0].status, 'completed')
})

test('a Mac job that failed is retried, and only announced once it is really over', async () => {
  const store = fakeStore()
  const routine = dueRoutine()
  await store.saveRoutine(routine)
  await store.createJob({ jobId: 'job_bad', status: 'failed', error: 'Mail was locked' })
  const run = {
    runId: 'run_mac',
    routineId: routine.routineId,
    routineName: routine.name,
    status: 'dispatched',
    startedAt: new Date(NOW).toISOString(),
    dueAt: new Date(NOW).toISOString(),
    attempt: 1,
    macJobId: 'job_bad',
    occurrenceKey: occurrenceKey(routine.routineId, new Date(NOW).toISOString()),
  }
  await store.recordRoutineRun(run)

  const retried = await reapDispatchedRuns({ store, now: NOW + 60_000 })
  assert.equal(retried[0].status, 'failed')
  assert.equal(retried[0].final, false)
  assert.equal(store.announcements.size, 0)
  // dispatchToMac() already advanced the routine to tomorrow; the retry has to
  // put the occurrence back, and advanceRoutine() will return it to the grid.
  const armed = store.routines.get(routine.routineId)
  assert.equal(armed.nextRunAt, NOW + 60_000 + RETRY_BASE_MS)
  assert.equal(armed.dueSince, NOW)

  await store.recordRoutineRun({ ...run, attempt: RETRY_MAX_ATTEMPTS, status: 'dispatched' })
  const done = await reapDispatchedRuns({ store, now: NOW + 120_000 })
  assert.equal(done[0].final, true)
  assert.match([...store.announcements.values()][0].speech, /Mail was locked/)
})

test('a routine deleted mid-flight is reported, not resurrected', async () => {
  const store = fakeStore()
  await store.createJob({ jobId: 'job_gone', status: 'failed', error: 'boom' })
  await store.recordRoutineRun({
    runId: 'run_orphan',
    routineId: 'rtn_deleted',
    status: 'dispatched',
    startedAt: new Date(NOW).toISOString(),
    dueAt: new Date(NOW).toISOString(),
    macJobId: 'job_gone',
  })

  const closed = await reapDispatchedRuns({ store, now: NOW + 60_000 })
  assert.equal(closed[0].final, true)
  assert.equal(closed[0].stoppedBecause, 'the routine is gone')
  assert.equal(store.routines.size, 0)
  assert.equal(store.announcements.size, 0)
})

test('an occurrence dropped after a day of lid-closed silence is said out loud', async () => {
  const store = fakeStore()
  await store.saveRoutine({
    ...createRoutine({
      command: 'summarize my calendar for today',
      schedule: { kind: 'daily', at: '07:00' },
      now: NOW,
    }),
    nextRunAt: NOW - 1,
    deferredSince: new Date(NOW - DEFER_MAX_MS - 1).toISOString(),
  })

  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => false,
    logger: silentLogger,
  })

  assert.equal(runs[0].status, 'missed')
  // Nothing else in the stack would ever mention this: there is no error the
  // owner could go looking for, only a briefing that never arrived.
  const announcement = [...store.announcements.values()][0]
  assert.match(announcement.speech, /did not run/)
  assert.match(announcement.speech, /stayed offline/)
})

test('editing a schedule reschedules and clears any deferral', () => {
  const routine = { ...dueRoutine(), deferredSince: new Date(NOW).toISOString() }
  const updated = updateRoutineRecord(
    routine,
    { schedule: { kind: 'weekly', at: '17:00', days: ['weekdays'] } },
    NOW,
  )
  assert.equal(updated.deferredSince, null)
  assert.ok(updated.nextRunAt > NOW)
  assert.match(updated.scheduleText, /every weekday at 17:00/)
  assert.throws(() => updateRoutineRecord(routine, { schedule: { kind: 'nope' } }, NOW))
})

/* ---- parked is not failed ------------------------------------------------
 * The 2026-08-08 07:00 incident, as tests. The Morning news plan parked on
 * the Mac for dashboard approval; the bridge reported that as a FAILURE; the
 * reaper retried the "failure" — three planner calls in five minutes — and
 * the parked plan sat behind a dashboard nobody had open. A parked run is now
 * its own final state, it is announced loudly, and it is never retried.
 * ------------------------------------------------------------------------- */

const dispatchedRun = (routine, { runId = 'run_parked', jobId = 'job_parked' } = {}) => ({
  runId,
  routineId: routine.routineId,
  routineName: routine.name,
  status: 'dispatched',
  startedAt: new Date(NOW).toISOString(),
  dueAt: new Date(NOW).toISOString(),
  attempt: 1,
  macJobId: jobId,
  occurrenceKey: occurrenceKey(routine.routineId, new Date(NOW).toISOString()),
})

test('a parked plan closes as awaiting-approval, says so loudly, and is never retried', async () => {
  const store = fakeStore()
  const routine = dueRoutine()
  const rearmedFor = NOW + 86_400_000
  await store.saveRoutine({ ...routine, nextRunAt: rearmedFor })
  /* The new bridge dialect: ok report, ordinary plan_ready, parked markers. */
  await store.createJob({
    jobId: 'job_parked',
    type: 'plan',
    status: 'plan_ready',
    result: {
      executed: false,
      parked: true,
      phase: 'parked_for_approval',
      awaitingApproval: [
        { type: 'send_email', reason: 'Sending email acts on your behalf and needs approval.' },
      ],
      response: 'Waiting for your approval on the dashboard.',
    },
  })
  await store.recordRoutineRun(dispatchedRun(routine))

  const closed = await reapDispatchedRuns({ store, now: NOW + 60_000, logger: silentLogger })
  assert.equal(closed.length, 1)
  assert.equal(closed[0].status, 'awaiting-approval')
  assert.equal(closed[0].final, true, 'awaiting-approval settles the occurrence')
  assert.equal(closed[0].nextAttemptAt, null)
  assert.equal(closed[0].error, null, 'nothing failed; nothing may say so')

  // LOUD: the owner hears about the parked plan instead of silence.
  const announcement = [...store.announcements.values()][0]
  assert.ok(announcement, 'a parked routine must be announced')
  assert.match(announcement.speech, /Morning news/)
  assert.match(announcement.speech, /needs your approval on the dashboard/)
  assert.match(announcement.speech, /acts on your behalf/)
  assert.equal(announcement.priority, 'high')
  assert.equal(announcement.runId, 'run_parked')

  // Never retried: the routine stays armed for tomorrow, not for a backoff.
  const stored = store.routines.get(routine.routineId)
  assert.equal(stored.nextRunAt, rearmedFor)
  assert.equal(Number(stored.attempt || 0), 0)
})

test('an old bridge reporting the park as a failure still must not trigger retries', async () => {
  const store = fakeStore()
  const routine = dueRoutine()
  const rearmedFor = NOW + 86_400_000
  await store.saveRoutine({ ...routine, nextRunAt: rearmedFor })
  /*
   * The pre-fix dialect, verbatim from job_3276a969 (2026-08-08): the relay
   * stored status 'failed' with the parked plan still in `result`. The reaper
   * must read the structure, not the status, or one stale bridge re-creates
   * the retry storm against a fixed relay.
   */
  await store.createJob({
    jobId: 'job_parked',
    type: 'plan',
    status: 'failed',
    error: 'Waiting for your approval on the dashboard.',
    result: {
      executed: false,
      awaitingApproval: [
        { type: 'run_shell', reason: 'Running a shell command needs your approval.' },
      ],
      requiresConfirmation: true,
    },
  })
  await store.recordRoutineRun(dispatchedRun(routine))

  const closed = await reapDispatchedRuns({ store, now: NOW + 60_000, logger: silentLogger })
  assert.equal(closed[0].status, 'awaiting-approval')
  assert.equal(closed[0].final, true)
  assert.match([...store.announcements.values()][0].speech, /needs your approval/)
  // No retry was armed and no attempt was burned.
  const stored = store.routines.get(routine.routineId)
  assert.equal(stored.nextRunAt, rearmedFor)
  assert.equal(Number(stored.attempt || 0), 0)

  // A genuinely failed execution (executionError, no parked markers) is NOT
  // mistaken for a park — that path keeps its capped retries.
  assert.equal(
    jobParkedForApproval({
      status: 'failed',
      result: { executed: false, executionError: 'the script crashed' },
    }),
    false,
  )
  // And a job the owner already cancelled stops being "awaiting" anything.
  assert.equal(
    jobParkedForApproval({
      status: 'cancelled',
      result: { executed: false, parked: true },
    }),
    false,
  )
})

test('a parked routine with announce:false stays quiet but the receipt still says why', async () => {
  const store = fakeStore()
  const routine = dueRoutine({ announce: false })
  await store.saveRoutine({ ...routine, nextRunAt: NOW + 86_400_000 })
  await store.createJob({
    jobId: 'job_parked',
    type: 'plan',
    status: 'plan_ready',
    result: { executed: false, parked: true, phase: 'parked_for_approval', awaitingApproval: [] },
  })
  await store.recordRoutineRun(dispatchedRun(routine))

  const closed = await reapDispatchedRuns({ store, now: NOW + 60_000, logger: silentLogger })
  assert.equal(closed[0].status, 'awaiting-approval')
  assert.equal(store.announcements.size, 0)
  assert.match(store.runs.get('run_parked').summary, /Parked for your approval/)
})

test('a queued retry that lands after the park is superseded, not re-planned', async () => {
  const store = fakeStore()
  /* An earlier attempt armed a retry; before it fired, the dispatch parked. */
  const routine = { ...dueRoutine(), attempt: 1, dueSince: NOW - 1 }
  await store.saveRoutine(routine)
  await store.recordRoutineRun({
    runId: 'run_waiting',
    routineId: routine.routineId,
    status: 'awaiting-approval',
    final: true,
    startedAt: new Date(NOW - 60_000).toISOString(),
    occurrenceKey: occurrenceKey(routine.routineId, new Date(NOW - 1).toISOString()),
  })

  let enqueued = 0
  const { runs } = await runDueRoutines({
    store,
    now: NOW,
    isMacOnline: async () => true,
    enqueueMacJob: async () => {
      enqueued += 1
      return { jobId: 'job_dup' }
    },
    logger: silentLogger,
  })

  assert.equal(enqueued, 0, 'the planner must not be asked the same question again')
  assert.equal(runs[0].status, 'superseded')
  assert.match(runs[0].error, /already waiting for your approval as run_waiting/)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  INFLIGHT_STALE_MS,
  eventsFromAnnouncements,
  eventsFromBriefingRuns,
  eventsFromBrowserSpool,
  eventsFromJobs,
  eventsFromLedgers,
  eventsFromPendantInbox,
  eventsFromPendantItems,
  eventsFromReviewQueue,
  eventsFromRoutineRuns,
} from './catchupSources.js'

const NOW = Date.parse('2026-08-07T18:00:00.000Z')
const ago = (ms) => new Date(NOW - ms).toISOString()

const labelOf = (events, id) => events.find((row) => row.id === id)?.label
const byId = (events, id) => events.find((row) => row.id === id)

/* ------------------------------------------------------------ the spool */

/*
 * THE DISTINCTION THIS WHOLE FEATURE IS ABOUT, in its sharpest form.
 *
 * browserBridge.js spools for three reasons and they mean three different
 * things about the owner's screen. A TTL expiry means no extension ever saw
 * the command. A lease expiry means an extension TOOK it and went quiet — the
 * bridge's own words are "it may already have run, and running it twice would
 * act on the page twice". Reporting both as "it didn't happen" would tell the
 * owner a tab was never opened when it may be open in front of them.
 */
test('the spool distinguishes never-seen from taken-and-never-answered', () => {
  const events = eventsFromBrowserSpool({
    entries: [
      { commandId: 'a', reason: 'expired', action: { type: 'navigate' }, queuedAt: ago(60_000) },
      { commandId: 'b', reason: 'lease-expired', action: { type: 'click' }, queuedAt: ago(50_000) },
      { commandId: 'c', reason: 'extension-restarted', action: { type: 'type' }, queuedAt: ago(40_000) },
    ],
    dropped: { entries: 0 },
  })

  assert.equal(labelOf(events, 'spool:a'), 'expired')
  assert.equal(labelOf(events, 'spool:b'), 'indeterminate')
  assert.equal(labelOf(events, 'spool:c'), 'indeterminate')

  /* And none of them is "failed" — nothing here was attempted and refused. */
  assert.equal(events.some((row) => row.label === 'failed'), false)

  /* The expired one needs nothing from the owner beyond knowing; the claimed
   * ones are the only kind of item a human has to settle. */
  assert.equal(byId(events, 'spool:a').needsOwner, false)
  assert.equal(byId(events, 'spool:b').needsOwner, true)
  assert.match(byId(events, 'spool:b').needsOwnerReason, /twice/)
})

/*
 * A spool that silently overflowed reads exactly like a spool nothing was ever
 * written to. browserSpool.js reports its own losses; a digest that dropped
 * that report would re-open the hole one layer up and tell the owner about
 * four dead commands when there were nine.
 */
test('commands evicted from the bounded spool are still counted in the account', () => {
  const events = eventsFromBrowserSpool({
    entries: [],
    dropped: { entries: 5, bytes: 900, firstAt: ago(90_000), lastAt: ago(20_000) },
  })

  const row = byId(events, 'spool:dropped')
  assert.equal(row.label, 'expired')
  assert.match(row.title, /5 more browser command/)
})

/* ------------------------------------------------------- action ledger */

const ledger = (overrides = {}) => ({
  ledgerId: 'ldg_1',
  planKey: 'plan_abc',
  jobId: null,
  command: 'send the invoice',
  title: 'Send the invoice',
  status: 'open',
  createdAt: ago(3_600_000),
  updatedAt: ago(3_600_000),
  steps: [],
  ...overrides,
})

const step = (seq, phase, overrides = {}) => ({
  seq,
  stepKey: `k${seq}`,
  type: 'send_email',
  label: `step ${seq}`,
  phase,
  startedAt: phase === 'pending' ? null : ago(3_600_000),
  finishedAt: phase === 'done' ? ago(3_500_000) : null,
  ok: phase === 'done' ? true : null,
  status: phase === 'done' ? 'success' : null,
  replaySafety: 'unsafe',
  preState: { kind: 'unobservable' },
  ...overrides,
})

/*
 * The gap actionLedger.js was written to close, read back out at the digest
 * layer. A step recorded `inflight` was DEFINITELY dispatched — the manifest is
 * fsynced before the executor sees the action — and nothing recorded whether
 * it answered. That is not occurred, not queued, not failed.
 */
test('a plan that died mid-step is indeterminate, and is routed to the owner', () => {
  const events = eventsFromLedgers(
    [ledger({ steps: [step(0, 'done'), step(1, 'inflight'), step(2, 'pending')] })],
    { now: NOW },
  )

  const plan = byId(events, 'ledger:ldg_1')
  assert.equal(plan.label, 'indeterminate')
  assert.equal(plan.needsOwner, true)
  assert.match(plan.why, /written before dispatch/)

  const inflight = byId(events, 'ledger-step:ldg_1:k1')
  assert.equal(inflight.label, 'indeterminate')
  assert.match(inflight.detail, /no after-the-fact check/)
})

/* The same record, moments old, means the opposite thing: it is running. */
test('a plan touched moments ago is queued, not declared unknown', () => {
  const events = eventsFromLedgers(
    [
      ledger({
        updatedAt: ago(1000),
        steps: [step(0, 'done'), step(1, 'inflight')],
      }),
    ],
    { now: NOW },
  )

  assert.equal(labelOf(events, 'ledger:ldg_1'), 'queued')
  assert.equal(byId(events, 'ledger:ldg_1').needsOwner, false)
})

/*
 * The other half of actionLedger's ordering invariant, and the reason a
 * dead-between-steps run is FAILED rather than indeterminate: the manifest is
 * written before dispatch, so a step still marked `pending` provably never ran.
 * That is a definite statement and the digest is entitled to make it.
 */
test('steps still pending in a dead run are known never to have run', () => {
  const events = eventsFromLedgers(
    [
      ledger({
        updatedAt: ago(INFLIGHT_STALE_MS * 2),
        steps: [step(0, 'done'), step(1, 'pending'), step(2, 'pending')],
      }),
    ],
    { now: NOW },
  )

  const plan = byId(events, 'ledger:ldg_1')
  assert.equal(plan.label, 'failed')
  assert.match(plan.why, /definitively never ran/)
})

test('a step that returned an error gets its own row, labelled failed', () => {
  const events = eventsFromLedgers(
    [
      ledger({
        status: 'settled',
        steps: [step(0, 'done', { ok: false, status: 'failed', message: 'no such recipient' })],
      }),
    ],
    { now: NOW },
  )

  const failed = byId(events, 'ledger-step:ldg_1:k0')
  assert.equal(failed.label, 'failed')
  assert.equal(failed.why, 'no such recipient')
})

/* The job row exists before the plan is built from it, so the edge runs that
 * way — and it is an identifier, not a guess about timing. */
test('a plan names the job that caused it, by identifier', () => {
  const events = eventsFromLedgers(
    [ledger({ jobId: 'local_7', status: 'settled', steps: [step(0, 'done')] })],
    { now: NOW },
  )

  assert.deepEqual(byId(events, 'ledger:ldg_1').causedBy, ['job:local_7'])
})

/* ---------------------------------------------------------- routine runs */

const run = (overrides = {}) => ({
  runId: 'run_1',
  routineId: 'rtn_1',
  routineName: 'Morning news',
  command: 'read me the news',
  status: 'completed',
  attempt: 1,
  final: true,
  dueAt: ago(7_200_000),
  startedAt: ago(7_200_000),
  occurrenceKey: 'rtn_1#morning',
  ...overrides,
})

/*
 * scheduler.js already says why the unit is the occurrence: "Three receipts for
 * one 7am briefing is one thing that happened, not three — flattening them
 * reads as a routine that fired three times." The owner declared one briefing.
 */
test('three attempts at one occurrence are one thing that happened', () => {
  const events = eventsFromRoutineRuns(
    [
      run({ runId: 'run_1', attempt: 1, status: 'failed', final: false }),
      run({ runId: 'run_2', attempt: 2, status: 'failed', final: false }),
      run({ runId: 'run_3', attempt: 3, status: 'completed' }),
    ],
    { now: NOW },
  )

  assert.equal(events.length, 1)
  assert.equal(events[0].label, 'occurred')
  assert.match(events[0].detail, /3 attempt/)
})

/*
 * scheduler.js counts retries separately from failures because "a tick
 * reporting ranCount=1 failed=1 looks like a broken schedule; the same tick
 * reporting retryingCount=1 is a schedule doing its job". A retry pending is
 * QUEUED — nothing has been lost and the owner does not need to act.
 */
test('a failed attempt with a retry scheduled is queued, not failed', () => {
  const events = eventsFromRoutineRuns(
    [run({ status: 'failed', final: false, attempt: 1, nextAttemptAt: ago(-60_000) })],
    { now: NOW },
  )

  assert.equal(events[0].label, 'queued')
  assert.equal(events[0].needsOwner, false)
  assert.match(events[0].why, /Nothing has been lost/)
})

test('a failed attempt with no retry left is failed, and needs the owner', () => {
  const events = eventsFromRoutineRuns(
    [run({ status: 'failed', final: true, attempt: 3, error: 'it failed 3 times' })],
    { now: NOW },
  )

  assert.equal(events[0].label, 'failed')
  assert.equal(events[0].needsOwner, true)
})

/*
 * A missed occurrence EXPIRED — routines.js drops it deliberately rather than
 * letting it fire late ("far better than a briefing about last Tuesday
 * arriving on Thursday"). Nobody failed; the window closed.
 */
test('an occurrence dropped for age is expired, not failed', () => {
  const events = eventsFromRoutineRuns([run({ status: 'missed' })], { now: NOW })

  assert.equal(events[0].label, 'expired')
  assert.match(events[0].needsOwnerReason, /not coming back on its own/)
})

test('an occurrence held for a sleeping Mac is queued', () => {
  const events = eventsFromRoutineRuns([run({ status: 'deferred' })], { now: NOW })

  assert.equal(events[0].label, 'queued')
  assert.equal(events[0].needsOwner, false)
})

/*
 * A superseded attempt is the duplicate guard working. It is real evidence and
 * it is counted — but it is not a thing that happened to the owner, and giving
 * it a row would report their one 7am briefing as two events.
 */
test('a refused duplicate attempt is counted, never given a row of its own', () => {
  const events = eventsFromRoutineRuns(
    [
      run({ runId: 'run_1', attempt: 1, status: 'completed' }),
      run({ runId: 'run_2', attempt: 2, status: 'superseded' }),
    ],
    { now: NOW },
  )

  assert.equal(events.length, 1)
  assert.equal(events[0].label, 'occurred')
  assert.match(events[0].detail, /1 duplicate attempt\(s\) were refused/)
})

/*
 * A dispatch the relay never got an answer to is the relay/Mac version of the
 * same in-flight hole the action ledger has. Recent means queued; past the
 * window the reaper works to, nobody is coming.
 */
test('a dispatch that outlived the reaper window becomes indeterminate', () => {
  const recent = eventsFromRoutineRuns(
    [run({ status: 'dispatched', startedAt: ago(60_000), macJobId: 'relay_9' })],
    { now: NOW },
  )
  const stale = eventsFromRoutineRuns(
    [run({ status: 'dispatched', startedAt: ago(3 * 3_600_000), macJobId: 'relay_9' })],
    { now: NOW },
  )

  assert.equal(recent[0].label, 'queued')
  assert.equal(stale[0].label, 'indeterminate')
  assert.equal(stale[0].needsOwner, true)
})

/* --------------------------------------------------------- announcements */

const announcement = (overrides = {}) => ({
  announcementId: 'anc_1',
  title: 'Morning news',
  speech: 'Here is the news.',
  state: 'pending',
  createdAt: ago(3_600_000),
  expiresAt: new Date(NOW + 3_600_000).toISOString(),
  ...overrides,
})

/*
 * The surface where queued and occurred are most often blurred, because both
 * are just a row in a table. `delivered` means the pendant actually said it —
 * the strongest "you already know this" signal in the whole digest.
 */
test('announcements separate spoken from waiting from never-said', () => {
  const events = eventsFromAnnouncements(
    [
      announcement({ announcementId: 'a', state: 'delivered' }),
      announcement({ announcementId: 'b', state: 'pending' }),
      announcement({ announcementId: 'c', state: 'pending', expiresAt: ago(60_000) }),
      announcement({ announcementId: 'd', state: 'delivering' }),
    ],
    { now: NOW },
  )

  assert.equal(labelOf(events, 'announcement:a'), 'occurred')
  assert.equal(labelOf(events, 'announcement:b'), 'queued')
  assert.equal(labelOf(events, 'announcement:c'), 'expired')
  assert.equal(labelOf(events, 'announcement:d'), 'indeterminate')

  /* Words that expired unheard are indistinguishable, from the owner's side,
   * from words that were never composed — so this one is surfaced. */
  assert.equal(byId(events, 'announcement:c').needsOwner, true)
  assert.equal(byId(events, 'announcement:b').needsOwner, false)
})

test('an announcement names the run that produced it, by identifier', () => {
  const events = eventsFromAnnouncements([announcement({ runId: 'run_1' })], { now: NOW })
  assert.deepEqual(events[0].causedBy, ['run:run_1'])
})

/* --------------------------------------------------------------- pendant */

/*
 * The press happened — the device wrote it to its card, which IS it having
 * happened. What is unknown is only when, and that uncertainty is carried in
 * the clock label rather than smoothed away with the forwarding timestamp.
 */
test('an offline press occurred; only its time is unknown', () => {
  const events = eventsFromPendantItems([
    {
      itemId: 'M1',
      kind: 'M',
      clockSource: 'uptime',
      deviceAt: 240_000,
      forwardedAt: ago(600_000),
    },
  ])

  const press = byId(events, 'pendant:M1')
  assert.equal(press.label, 'occurred')
  assert.equal(press.at.quality, 'uptime')
  assert.equal(press.at.iso, null, 'an uptime reading is never rendered as a wall-clock time')
  assert.match(press.why, /before the item reached the relay/)

  /* The one true statement about when it happened is expressed as an edge,
   * not as a number: the forward is caused by the press. */
  const forward = byId(events, 'pendant-forward:M1')
  assert.deepEqual(forward.causedBy, ['pendant:M1'])
  assert.equal(forward.at.domain, 'relay')
})

test('a device that had a network clock keeps it, and is placeable', () => {
  const events = eventsFromPendantItems([
    { itemId: 'V1', kind: 'V', clockSource: 'nitz', deviceAt: ago(900_000) },
  ])

  assert.equal(byId(events, 'pendant:V1').at.quality, 'wall')
  assert.equal(byId(events, 'pendant:V1').at.domain, 'pendant')
})

test('alerts still held on the card are queued — nothing is lost yet', () => {
  const events = eventsFromPendantInbox({ heldAlerts: 3, observedAt: ago(0) })

  assert.equal(events[0].label, 'queued')
  assert.equal(events[0].needsOwner, false)
  assert.match(events[0].title, /3 alert/)
})

/* ------------------------------------------------------------- briefings */

/*
 * COMPOSED IS NOT HEARD. briefingQueue.js exists because a briefing was
 * composed, marked its findings told, and went unplayed — after which the next
 * run found the fingerprints, said "nothing needs you right now", and replaced
 * the audio nobody had heard. An unplayed briefing is queued and it is waiting
 * on the owner.
 */
test('a briefing that was written but never played is queued and needs the owner', () => {
  const events = eventsFromBriefingRuns(
    [
      { id: 'btg_1', generatedAt: ago(3_600_000), spoken: 'Two things need you.', told: 2, queued: 1 },
      { id: 'btg_2', generatedAt: ago(1_800_000), spoken: 'All clear.', told: 0, queued: 0 },
    ],
    { unheardRunIds: ['btg_1'] },
  )

  assert.equal(labelOf(events, 'briefing:btg_1'), 'queued')
  assert.equal(byId(events, 'briefing:btg_1').needsOwner, true)
  assert.match(byId(events, 'briefing:btg_1').why, /nothing in it has actually reached you/)

  assert.equal(labelOf(events, 'briefing:btg_2'), 'occurred')
  assert.equal(byId(events, 'briefing:btg_2').needsOwner, false)
})

/* ---------------------------------------------------------- review queue */

/*
 * The queue rows already carry briefingTriage fingerprints. Recomputing one
 * here would hash a different key and quietly never match the told-ledger, so
 * every already-heard item would be told again — the one thing this digest was
 * asked not to do.
 */
test('a queued finding keeps the fingerprint it was minted with', () => {
  const events = eventsFromReviewQueue([
    { id: 'bqi_1', fingerprint: 'bf_deadbeef', title: 'File the form', openedAt: ago(3_600_000), seenCount: 3 },
  ])

  assert.equal(events[0].fingerprint, 'bf_deadbeef')
  assert.equal(events[0].label, 'queued')
  assert.equal(events[0].needsOwner, true, 'this queue waits on the owner, not on the system')
  assert.match(events[0].why, /across 3 briefings/)
})

/* An item whose evidence was revoked keeps its row and loses its body. Passing
 * the detail through untouched is what keeps "forget what you read there"
 * meaning something. */
test('a finding whose evidence was revoked keeps its row and not its contents', () => {
  const events = eventsFromReviewQueue([
    {
      id: 'bqi_2',
      title: 'Something was found',
      detail: '',
      summary: 'Something was found: this was found, but the evidence for it is no longer available.',
      openedAt: ago(3_600_000),
      evidenceWithheld: ['cap_1'],
    },
  ])

  assert.equal(events[0].title, 'Something was found')
  assert.match(events[0].detail, /no longer available/)
})

/* -------------------------------------------------------------- Mac jobs */

test('a job left processing by a dead process is indeterminate, not still running', () => {
  const events = eventsFromJobs(
    [
      { jobId: 'j1', status: 'processing', command: 'tidy up', createdAt: ago(30_000), updatedAt: ago(30_000) },
      {
        jobId: 'j2',
        status: 'processing',
        command: 'research',
        createdAt: ago(INFLIGHT_STALE_MS * 3),
        updatedAt: ago(INFLIGHT_STALE_MS * 3),
      },
    ],
    { now: NOW },
  )

  assert.equal(labelOf(events, 'job:j1'), 'queued')
  assert.equal(labelOf(events, 'job:j2'), 'indeterminate')
  assert.equal(byId(events, 'job:j2').needsOwner, true)
})

/*
 * An undone job DID occur and was then reversed. Both are true, and reporting
 * only the undo would leave the owner believing a change is in place that is
 * not — while reporting only the run would leave them believing the opposite.
 */
test('an undone job still occurred, and says it was undone', () => {
  const events = eventsFromJobs(
    [
      {
        jobId: 'j3',
        status: 'completed',
        command: 'move the file',
        createdAt: ago(3_600_000),
        updatedAt: ago(3_500_000),
        undoneAt: ago(3_400_000),
      },
    ],
    { now: NOW },
  )

  assert.equal(events[0].label, 'occurred')
  assert.match(events[0].why, /undone/)
})

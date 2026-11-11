import assert from 'node:assert/strict'
import test from 'node:test'

import {
  NO_CONTENT_WINDOW_MS,
  SPOKEN_MAX_CHARS,
  STALE_QUEUE_MS,
  STALE_TRANSCRIBE_MS,
  describeJobOutcome,
  jobLabel,
  recallJobStatus,
  resolveJobReference,
  speakJobStatus,
} from './jobRecall.js'

const NOW = Date.parse('2026-08-07T12:00:00.000Z')
const at = (msAgo) => new Date(NOW - msAgo).toISOString()

function planJob(overrides = {}) {
  const createdAt = overrides.createdAt ?? at(60_000)
  return {
    jobId: 'job_a',
    type: 'plan',
    status: 'plan_ready',
    command: 'open Outlook',
    createdAt,
    updatedAt: overrides.updatedAt ?? createdAt,
    result: { executed: true, response: 'Outlook is open.' },
    ...overrides,
  }
}

test('a finished job speaks as done, and names the task', () => {
  const job = planJob({ createdAt: at(120_000), updatedAt: at(115_000) })
  const outcome = describeJobOutcome(job, { now: NOW })
  assert.equal(outcome.state, 'done')
  const spoken = speakJobStatus(job, outcome)
  assert.match(spoken, /open Outlook/)
  assert.match(spoken, /done/)
  assert.ok(spoken.length <= SPOKEN_MAX_CHARS, spoken)
})

test('a failed job says it failed and why — never "done"', () => {
  const job = planJob({
    status: 'failed',
    error: 'open_app failed: Application not found.',
    result: { executed: false },
  })
  const outcome = describeJobOutcome(job, { now: NOW })
  assert.equal(outcome.state, 'failed')
  const spoken = speakJobStatus(job, outcome)
  assert.match(spoken, /failed/)
  assert.match(spoken, /Application not found/)
  assert.doesNotMatch(spoken, /\bdone\b/)
})

/*
 * The voiceRunForCapture regression, transplanted: a terminal status with
 * nothing to show for it used to read as success on every dashboard.
 */
test('terminal status with no result is unknown, not success', () => {
  const outcome = describeJobOutcome(planJob({ result: null }), { now: NOW })
  assert.equal(outcome.state, 'unknown')
  const spoken = speakJobStatus(planJob({ result: null }), outcome)
  assert.match(spoken, /can't tell you/)
  assert.doesNotMatch(spoken, /\bdone\b/)
})

test('completed status with executed:false is a failure', () => {
  const job = planJob({
    status: 'completed',
    result: { executed: false, executionError: 'Outlook is not installed' },
  })
  const outcome = describeJobOutcome(job, { now: NOW })
  assert.equal(outcome.state, 'failed')
  assert.equal(outcome.reason, 'Outlook is not installed')
})

/*
 * The follow-up to the voiceRunForCapture/voiceRunForJob fix: a job stuck at
 * 'transcribed' with no useful command is speech-to-text that genuinely
 * heard nothing — not "your Mac hasn't picked it up" (nothing was ever
 * queued for the Mac at all). This is the screenless surface, so getting it
 * wrong is worse here than on the dashboard: there is no evidence next to
 * the spoken sentence for the owner to check it against.
 */
test('a silent press (transcribed, no words) is spoken as nothing said, not queued', () => {
  const job = planJob({
    status: 'transcribed',
    command: '',
    result: null,
    inputTelemetry: { storage: 'live_lte' },
    createdAt: at(STALE_QUEUE_MS + 30_000),
  })
  const outcome = describeJobOutcome(job, { now: NOW })
  assert.equal(outcome.state, 'no_speech')
  const spoken = speakJobStatus(job, outcome)
  assert.match(spoken, /nothing was said/)
  assert.doesNotMatch(spoken, /hasn't picked it up/)
  assert.doesNotMatch(spoken, /\bfailed\b/)
  assert.doesNotMatch(spoken, /\bqueued\b/)
})

test('a real STT failure on the same job shape still says failed, with the real reason', () => {
  const job = planJob({
    status: 'failed',
    command: '',
    result: null,
    error: 'OpenAI STT request timed out.',
  })
  const outcome = describeJobOutcome(job, { now: NOW })
  assert.equal(outcome.state, 'failed')
  assert.match(outcome.reason, /timed out/)
  assert.match(speakJobStatus(job, outcome), /failed/)
})

test('a stalled transcription (never left transcribing) still says failed, not no_speech', () => {
  const job = planJob({
    status: 'transcribing',
    command: '',
    result: null,
    createdAt: at(STALE_TRANSCRIBE_MS + 30_000),
  })
  const outcome = describeJobOutcome(job, { now: NOW })
  assert.equal(outcome.state, 'failed')
})

test('an empty TYPED command is not read as silence — it is still queued/pending', () => {
  const job = planJob({
    status: 'transcribed',
    command: '',
    result: null,
    inputTelemetry: { storage: 'dashboard', inputMode: 'typed' },
  })
  const outcome = describeJobOutcome(job, { now: NOW })
  assert.equal(outcome.state, 'queued')
})

test('a genuinely queued job with real content is unaffected by the silence check', () => {
  const outcome = describeJobOutcome(
    planJob({ status: 'queued', command: 'open Outlook', result: null }),
    { now: NOW },
  )
  assert.equal(outcome.state, 'queued')
})

test('a queued job past the claim window says the Mac never picked it up', () => {
  const fresh = describeJobOutcome(
    planJob({ status: 'queued', result: null, createdAt: at(2_000) }),
    { now: NOW },
  )
  assert.equal(fresh.state, 'queued')
  assert.equal(fresh.stalled, false)

  const stale = planJob({
    status: 'queued',
    result: null,
    createdAt: at(STALE_QUEUE_MS + 30_000),
  })
  const outcome = describeJobOutcome(stale, { now: NOW })
  assert.equal(outcome.state, 'queued')
  assert.equal(outcome.stalled, true)
  assert.match(speakJobStatus(stale, outcome), /hasn't picked it up/)
})

test('an approval gate reports as waiting on the owner, not as running', () => {
  const job = planJob({
    status: 'processing',
    result: { awaitingApproval: [{ type: 'run_shell' }] },
  })
  const outcome = describeJobOutcome(job, { now: NOW })
  assert.equal(outcome.state, 'awaiting_approval')
  assert.match(speakJobStatus(job, outcome), /approval/)
})

test('a processing job that already executed says so', () => {
  const job = planJob({
    status: 'processing',
    result: { phase: 'executed', executed: true },
  })
  const outcome = describeJobOutcome(job, { now: NOW })
  assert.equal(outcome.state, 'running')
  assert.equal(outcome.actionsDone, true)
  assert.match(speakJobStatus(job, outcome), /finishing up/)
})

test('jobLabel never speaks the "voice command" filler back at the owner', () => {
  assert.equal(
    jobLabel({
      command: 'voice command',
      plannerHint: { actions: [{ type: 'open_app', label: 'Open Slack' }] },
    }),
    'Open Slack',
  )
  assert.equal(jobLabel({ command: 'voice command' }), 'your last Mac task')
})

/* ---------------- reference resolution ---------------- */

const RECENT = planJob({
  jobId: 'job_recent',
  command: 'set the volume to thirty percent',
  createdAt: at(30_000),
  updatedAt: at(28_000),
  /* Its own result, deliberately: the default fixture's "Outlook is open."
   * would make this job match "the Outlook thing" too, and the point of the
   * next test is that content beats recency between DIFFERENT jobs. */
  result: { executed: true, response: 'Volume set to thirty percent.' },
})
const OLDER = planJob({
  jobId: 'job_older',
  command: 'open Outlook and check my mail',
  createdAt: at(10 * 60_000),
  updatedAt: at(10 * 60_000),
})

test('a bare deictic resolves to the most recent Mac task', () => {
  const match = resolveJobReference({
    jobs: [OLDER, RECENT],
    reference: 'that thing I asked you to handle earlier',
    now: NOW,
  })
  assert.equal(match.job.jobId, 'job_recent')
  assert.equal(match.how, 'most-recent')
  assert.equal(match.matchedWords, 0)
})

test('one content word beats recency', () => {
  const match = resolveJobReference({
    jobs: [OLDER, RECENT],
    reference: 'the Outlook thing',
    now: NOW,
  })
  assert.equal(match.job.jobId, 'job_older')
  assert.equal(match.how, 'content-match')
  assert.ok(match.matchedWords > 0)
})

test('action params are searchable, not just the spoken command', () => {
  const byParam = planJob({
    jobId: 'job_param',
    command: 'voice command',
    createdAt: at(5 * 60_000),
    plannerHint: {
      actions: [
        { type: 'open_app', label: 'Open app', params: { appName: 'Reminders' } },
      ],
    },
  })
  const match = resolveJobReference({
    jobs: [RECENT, byParam],
    reference: 'the reminders one',
    now: NOW,
  })
  assert.equal(match.job.jobId, 'job_param')
})

test('non-plan jobs are never candidates', () => {
  const match = resolveJobReference({
    jobs: [
      { jobId: 'job_proxy', type: 'agent_proxy', status: 'completed', createdAt: at(1_000) },
      { jobId: 'job_capture', type: 'audio_capture', status: 'completed', createdAt: at(2_000) },
      RECENT,
    ],
    reference: 'that',
    now: NOW,
  })
  assert.equal(match.job.jobId, 'job_recent')
})

/*
 * The failure mode that matters most: a named reference that matches nothing
 * must not silently answer about whatever ran last.
 */
test('a named reference that matches nothing resolves to nothing', () => {
  const match = resolveJobReference({
    jobs: [RECENT, OLDER],
    reference: 'the Photoshop export',
    now: NOW,
  })
  assert.equal(match.job, null)
  assert.equal(match.how, 'no-match')
})

test('with no content words, stale jobs are not guessed at', () => {
  const ancient = planJob({
    jobId: 'job_ancient',
    createdAt: at(NO_CONTENT_WINDOW_MS + 60_000),
  })
  const match = resolveJobReference({ jobs: [ancient], reference: 'that', now: NOW })
  assert.equal(match.job, null)
  assert.equal(match.how, 'nothing-recent')

  /* Content still reaches it — the window only bounds a blind guess. */
  const named = resolveJobReference({
    jobs: [ancient],
    reference: 'the Outlook one',
    now: NOW,
  })
  assert.equal(named.job.jobId, 'job_ancient')
})

test('two equally plausible recent jobs are flagged ambiguous with alternatives', () => {
  const other = planJob({ jobId: 'job_other', command: 'mute the speakers', createdAt: at(35_000) })
  const match = resolveJobReference({
    jobs: [RECENT, other],
    reference: 'that',
    now: NOW,
  })
  assert.equal(match.ambiguous, true)
  assert.deepEqual(
    match.alternatives.map((entry) => entry.jobId),
    ['job_other'],
  )
})

test('the current turn\'s own job is excluded from "that"', () => {
  const thisTurn = planJob({ jobId: 'job_now', command: 'what is the status', createdAt: at(500) })
  const match = resolveJobReference({
    jobs: [thisTurn, RECENT],
    reference: 'that',
    excludeJobIds: ['job_now'],
    now: NOW,
  })
  assert.equal(match.job.jobId, 'job_recent')
})

test('an explicit job id wins over every heuristic', () => {
  const match = resolveJobReference({
    jobs: [RECENT, OLDER],
    reference: 'the volume thing',
    jobId: 'job_older',
    now: NOW,
  })
  assert.equal(match.job.jobId, 'job_older')
  assert.equal(match.how, 'explicit-id')
})

/* ---------------- tool payload ---------------- */

test('recallJobStatus returns one short spoken sentence plus its evidence', () => {
  const payload = recallJobStatus({
    jobs: [OLDER, RECENT],
    reference: 'that thing on my Mac',
    now: NOW,
  })
  assert.equal(payload.found, true)
  assert.equal(payload.jobId, 'job_recent')
  assert.equal(payload.state, 'done')
  assert.equal(payload.resolvedBy, 'most-recent')
  assert.ok(payload.spoken.length <= SPOKEN_MAX_CHARS)
  /* Spoken, not read: one sentence, no JSON, no timestamps. */
  assert.doesNotMatch(payload.spoken, /[{}[\]]/)
  assert.doesNotMatch(payload.spoken, /\d{4}-\d{2}-\d{2}/)
})

test('recallJobStatus admits it has nothing rather than inventing a task', () => {
  const empty = recallJobStatus({ jobs: [], reference: 'that', now: NOW })
  assert.equal(empty.found, false)
  assert.match(empty.spoken, /haven't asked me to run anything/)

  const noMatch = recallJobStatus({
    jobs: [RECENT],
    reference: 'the Photoshop export',
    now: NOW,
  })
  assert.equal(noMatch.found, false)
  assert.match(noMatch.spoken, /don't have a Mac task that matches/)
  /* A dead end still hands the owner something to correct with. */
  assert.match(noMatch.spoken, /The last one was set the volume/)
  assert.equal(noMatch.recent[0].jobId, 'job_recent')
})

test('recallJobStatus surfaces a failure through the whole payload', () => {
  const failed = planJob({
    jobId: 'job_failed',
    status: 'failed',
    command: 'empty the trash',
    error: 'Blocked for safety: destructive action needs approval.',
    createdAt: at(45_000),
    updatedAt: at(44_000),
  })
  const payload = recallJobStatus({ jobs: [failed], reference: 'that', now: NOW })
  assert.equal(payload.state, 'failed')
  assert.match(payload.reason, /Blocked for safety/)
  assert.match(payload.spoken, /failed/)
})

test('a long command is clipped for speech instead of read out whole', () => {
  const wordy = planJob({
    jobId: 'job_wordy',
    command:
      'go through my downloads folder and sort every screenshot from the last three weeks into a dated subfolder then tell me how many there were',
    createdAt: at(20_000),
    updatedAt: at(18_000),
  })
  const payload = recallJobStatus({ jobs: [wordy], reference: 'that', now: NOW })
  assert.ok(payload.spoken.length <= SPOKEN_MAX_CHARS, payload.spoken)
  assert.match(payload.spoken, /go through my downloads/)
})

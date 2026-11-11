import test from 'node:test'
import assert from 'node:assert/strict'

import { collapseRepeatRuns, voiceRunForCapture, voiceRunForJob } from './jobs.js'

/*
 * A live pendant run on 2026-08-07 uploaded 1,053,484 bytes of speech and got
 * nothing back — decoded_packets=0 on the device — yet the relay recorded the
 * run as completed and labelled it "Answered by voice". These lock that shut:
 * a reply has to exist before the pipeline is allowed to claim one.
 */

const base = {
  type: 'audio_capture',
  jobId: 'job_test',
  transcript: 'what is my battery at',
  audioBytes: 1053484,
  format: 'wav',
  createdAt: '2026-08-07T05:19:49.683Z',
}

const agentEvent = (run) => run.events.find((e) => e.stage === 'agent')

test('a capture with no reply is a failed run, not a completed one', () => {
  const run = voiceRunForCapture({ ...base })

  assert.equal(run.status, 'failed')
  assert.match(run.error, /no reply/i)
  assert.equal(agentEvent(run).status, 'failed')
  assert.doesNotMatch(agentEvent(run).label, /answered/i)
})

test('reply audio alone is enough to count as answered', () => {
  const run = voiceRunForCapture({ ...base, replyCaptureId: 'cap_reply' })

  assert.equal(run.status, 'completed')
  assert.equal(run.error, null)
  assert.equal(agentEvent(run).status, 'done')
  assert.match(agentEvent(run).label, /answered/i)
})

test('a reply transcript is carried into the agent event text', () => {
  const run = voiceRunForCapture({
    ...base,
    replyTranscript: 'Your battery is at 63 percent.',
  })

  assert.equal(run.status, 'completed')
  assert.equal(agentEvent(run).text, 'Your battery is at 63 percent.')
})

test('whitespace is not a reply', () => {
  const run = voiceRunForCapture({ ...base, replyTranscript: '   ' })

  assert.equal(run.status, 'failed')
})

test('unrecognised speech still marks the transcription stage failed', () => {
  const run = voiceRunForCapture({ ...base, transcript: '' })
  const transcription = run.events.find((e) => e.stage === 'transcription')

  assert.equal(transcription.status, 'failed')
  assert.match(transcription.label, /not recognized/i)
})

/*
 * The line this whole fix draws: a duplex press that captured audio, heard
 * no words, and ended for an ordinary reason (endReason) is a non-event, not
 * a failure — vs. a press that captured audio and heard nothing because
 * something actually broke, which must stay a visible failure. Both start
 * from the exact same shape (empty transcript, no reply); only `endReason`,
 * stamped by pendantConverse.js at the moment the conversation ended,
 * separates them.
 */

const silentCapture = {
  type: 'audio_capture',
  jobId: 'job_silent',
  transcript: '',
  audioBytes: 48_000,
  format: 'wav',
  createdAt: '2026-08-13T05:19:49.683Z',
}

test('a healthy press that heard silence is recorded, not failed', () => {
  for (const endReason of ['idle', 'agent-done', 'stopped', 'restarted', 'socket-closed']) {
    const run = voiceRunForCapture({ ...silentCapture, endReason })
    assert.equal(run.status, 'recorded', `endReason=${endReason}`)
    assert.equal(run.error, null, `endReason=${endReason}`)
  }
})

test('a benign silent press never occupies a Recent-feed slot', () => {
  const run = voiceRunForCapture(
    { ...silentCapture, endReason: 'idle' },
    { feed: true },
  )
  assert.equal(run, null)
})

test('the same benign silent press is still visible off the feed (history, direct lookup)', () => {
  const run = voiceRunForCapture({ ...silentCapture, endReason: 'idle' })
  assert.ok(run, 'the row must still exist for history/direct-link callers')
  assert.equal(run.status, 'recorded')
})

test('a genuine session failure stays a failed, visible run — even with feed:true', () => {
  const run = voiceRunForCapture(
    {
      ...silentCapture,
      endReason: 'agent-error',
      endError: 'Realtime API connection reset by peer.',
    },
    { feed: true },
  )
  assert.ok(run, 'a real failure must never be excluded from the feed')
  assert.equal(run.status, 'failed')
  assert.equal(run.error, 'Realtime API connection reset by peer.')
})

test('a decode failure (bad-audio) also stays a visible failure', () => {
  const run = voiceRunForCapture({
    ...silentCapture,
    endReason: 'bad-audio',
    endError: 'The uplink recording could not be decoded: unexpected EOF',
  })
  assert.equal(run.status, 'failed')
  assert.match(run.error, /could not be decoded/)
})

test('a truncated upload (socket-error) stays a visible failure', () => {
  const run = voiceRunForCapture({ ...silentCapture, endReason: 'socket-error' })
  assert.equal(run.status, 'failed')
})

test('a legacy capture with no endReason at all keeps the pre-fix failed reading', () => {
  // Written before this field existed. Fail closed rather than guess.
  const run = voiceRunForCapture({ ...silentCapture })
  assert.equal(run.status, 'failed')
})

test('reply audio still counts as answered even with an endReason present', () => {
  const run = voiceRunForCapture({
    ...silentCapture,
    endReason: 'agent-done',
    replyCaptureId: 'cap_reply',
  })
  assert.equal(run.status, 'completed')
})

/* ------------------------------------------------- voiceRunForJob siblings */

const planBase = {
  type: 'plan',
  jobId: 'job_plan_silent',
  status: 'transcribed',
  command: '',
  inputTelemetry: { storage: 'dashboard' },
  createdAt: '2026-08-13T05:19:49.683Z',
  updatedAt: '2026-08-13T05:19:52.683Z',
}

test('a /v1/transcribe job that genuinely heard nothing is recorded, not failed', () => {
  const run = voiceRunForJob(planBase)
  assert.equal(run.status, 'recorded')
})

test('that same silent plan job is excluded from the feed', () => {
  const run = voiceRunForJob(planBase, { feed: true })
  assert.equal(run, null)
})

test('a real STT error on the plan path is unaffected — still failed, still visible', () => {
  const run = voiceRunForJob(
    { ...planBase, status: 'failed', error: 'OpenAI STT request timed out.' },
    { feed: true },
  )
  assert.ok(run, 'a genuine transcription failure must stay in the feed')
  assert.equal(run.status, 'failed')
})

test('a stalled transcription (never left transcribing) is unaffected — still failed', () => {
  const run = voiceRunForJob(
    { ...planBase, status: 'transcribing', updatedAt: '2020-01-01T00:00:00.000Z' },
    { now: Date.parse('2026-08-13T06:00:00.000Z') },
  )
  assert.equal(run.status, 'failed')
})

test('an empty TYPED command is not waved through as silence', () => {
  const run = voiceRunForJob({
    ...planBase,
    inputTelemetry: { storage: 'dashboard', inputMode: 'typed' },
  })
  assert.equal(run.status, 'failed')
})

/* --------------------------------------------------------- collapseRepeatRuns */

function failedRun({ id, origin = 'live_lte', error = 'boom', createdAt }) {
  return {
    pipelineId: id,
    status: 'failed',
    origin,
    error,
    createdAt,
  }
}

test('consecutive identical failures from the same device fold into one row', () => {
  const runs = [
    failedRun({ id: 'r8', error: 'boom', createdAt: '2026-08-13T05:08:00Z' }),
    failedRun({ id: 'r7', error: 'boom', createdAt: '2026-08-13T05:07:00Z' }),
    failedRun({ id: 'r6', error: 'boom', createdAt: '2026-08-13T05:06:00Z' }),
    // Three hours earlier: the same error recurring is worth seeing on its
    // own, not swallowed into the tonight's-burst count.
    failedRun({ id: 'r1', error: 'boom', createdAt: '2026-08-13T02:06:00Z' }),
  ]
  const collapsed = collapseRepeatRuns(runs)

  assert.equal(collapsed.length, 2)
  assert.equal(collapsed[0].pipelineId, 'r8')
  assert.equal(collapsed[0].repeatCount, 3)
  assert.match(collapsed[0].error, /repeated 3 times/)
  assert.equal(collapsed[1].pipelineId, 'r1')
  assert.equal(collapsed[1].repeatCount, undefined)
})

test('different errors, different devices, or completed runs are never folded', () => {
  const runs = [
    failedRun({ id: 'a', error: 'boom', createdAt: '2026-08-13T05:03:00Z' }),
    failedRun({ id: 'b', error: 'a different problem', createdAt: '2026-08-13T05:02:00Z' }),
    failedRun({ id: 'c', origin: 'dashboard', error: 'boom', createdAt: '2026-08-13T05:01:00Z' }),
    {
      pipelineId: 'd',
      status: 'completed',
      origin: 'live_lte',
      error: null,
      createdAt: '2026-08-13T05:00:00Z',
    },
    {
      pipelineId: 'e',
      status: 'completed',
      origin: 'live_lte',
      error: null,
      createdAt: '2026-08-13T04:59:00Z',
    },
  ]
  const collapsed = collapseRepeatRuns(runs)
  assert.equal(collapsed.length, 5)
  assert.ok(collapsed.every((run) => run.repeatCount === undefined))
})

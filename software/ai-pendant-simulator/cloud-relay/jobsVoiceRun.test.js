import test from 'node:test'
import assert from 'node:assert/strict'

import { voiceRunForCapture } from './jobs.js'

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

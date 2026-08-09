import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

const testWorkspace = fs.mkdtempSync(
  path.join(os.tmpdir(), 'pendant-pipeline-test-'),
)
process.env.PENDANT_WORKSPACE_PATH = testWorkspace

const {
  NEEDS_APPROVAL_STATUS,
  pendingApproval,
  pipelineLocation,
  readPipelineRuns,
  recordPipelineEvent,
} = await import(`./pipelineTrace.js?test=${Date.now()}`)

test.after(() => {
  fs.rmSync(testWorkspace, { recursive: true, force: true })
})

test('persists a correlated pipeline without storing secrets or audio Base64', () => {
  recordPipelineEvent({
    pipelineId: 'job_test',
    stage: 'transcription',
    command: 'What time is it?',
    text: 'What time is it?',
    meta: {
      audioBytes: 48000,
      audioBase64: 'must-not-be-stored',
      authorization: 'must-not-be-stored',
    },
  })
  recordPipelineEvent({
    pipelineId: 'job_test',
    stage: 'relay_result',
    status: 'done',
    meta: {
      pcmBytes: 24000,
      apiKey: 'must-not-be-stored',
    },
  })

  const [run] = readPipelineRuns()
  assert.equal(run.pipelineId, 'job_test')
  assert.equal(run.command, 'What time is it?')
  assert.equal(run.status, 'completed')
  assert.equal(run.events.length, 2)
  assert.equal(run.events[0].meta.audioBytes, 48000)
  assert.equal(run.events[0].meta.audioBase64, undefined)
  assert.equal(run.events[0].meta.authorization, undefined)
  assert.equal(run.events[1].meta.pcmBytes, 24000)
  assert.equal(run.events[1].meta.apiKey, undefined)
  assert.ok(fs.existsSync(pipelineLocation()))
})

test('keeps a real pendant run live until nRF playback completes', () => {
  recordPipelineEvent({
    pipelineId: 'job_device_test',
    stage: 'transcription',
    command: 'Tell me the weather.',
    meta: {
      inputTelemetry: {
        audioBytes: 64000,
        sampleRate: 16000,
        storage: 'microSD',
      },
    },
  })
  recordPipelineEvent({
    pipelineId: 'job_device_test',
    stage: 'relay_result',
    status: 'done',
  })

  let run = readPipelineRuns().find(
    (item) => item.pipelineId === 'job_device_test',
  )
  assert.equal(run.status, 'processing')

  recordPipelineEvent({
    pipelineId: 'job_device_test',
    stage: 'reply_downloaded',
    status: 'done',
  })
  recordPipelineEvent({
    pipelineId: 'job_device_test',
    stage: 'device_playback',
    status: 'active',
  })
  run = readPipelineRuns().find(
    (item) => item.pipelineId === 'job_device_test',
  )
  assert.equal(run.status, 'processing')

  recordPipelineEvent({
    pipelineId: 'job_device_test',
    stage: 'device_playback',
    status: 'done',
  })
  run = readPipelineRuns().find(
    (item) => item.pipelineId === 'job_device_test',
  )
  assert.equal(run.status, 'completed')
})

/* ---- a held plan is a question, and questions have to be visible ---------
 * The other half of the 2026-08-09 incident. bridge.js parked the reading-list
 * plan, wrote `stage: agent, status: waiting`, and then rendered and uploaded
 * speech exactly as usual — so the last event was an ordinary relay_result
 * done, this derivation returned 'processing', and the dashboard drew
 * "Running" over a run that had stopped forever. The only announcement of the
 * hold was spoken to a pendant with no speaker. The data has to say "needs
 * approval" on its own, in the field every reader already looks at.
 * ------------------------------------------------------------------------- */

/** Replay of what bridge.js writes for a parked plan, in order. */
function recordParkedRun(pipelineId) {
  recordPipelineEvent({
    pipelineId,
    stage: 'transcription',
    command: 'What are the four latest items on my Safari reading list?',
    status: 'done',
  })
  recordPipelineEvent({
    pipelineId,
    stage: 'agent',
    status: 'done',
    label: 'Agent response ready',
  })
  recordPipelineEvent({
    pipelineId,
    stage: 'agent',
    status: 'waiting',
    label: 'Waiting for your approval',
    detail: 'That script calls "delete", which deletes something in Safari, so it needs your approval.',
    text: 'Waiting for your approval on the dashboard.',
    meta: {
      routineJob: false,
      blocked: [
        {
          type: 'run_applescript',
          reason: 'That script calls "delete", which deletes something in Safari, so it needs your approval.',
        },
      ],
    },
  })
  recordPipelineEvent({ pipelineId, stage: 'tts', status: 'done', meta: { pcmBytes: 24000 } })
  return recordPipelineEvent({ pipelineId, stage: 'relay_result', status: 'done' })
}

test('a parked plan reads as needing approval, not as Running', () => {
  recordParkedRun('job_parked_test')

  const run = readPipelineRuns().find(
    (item) => item.pipelineId === 'job_parked_test',
  )
  // The headline status: a distinct state, not "still working" and not "done".
  assert.equal(run.status, NEEDS_APPROVAL_STATUS)
  assert.notEqual(run.status, 'processing')
  assert.notEqual(run.status, 'completed')

  // And the structure a reader needs without walking the event list.
  assert.equal(run.approval.actionCount, 1)
  assert.deepEqual(
    run.approval.blocked.map((entry) => entry.type),
    ['run_applescript'],
  )
  assert.match(run.approval.reason, /needs your approval/)
  assert.equal(run.approval.routine, false)
  assert.ok(run.approval.since)
})

test('approval clears when the agent moves again, and fails when it fails', () => {
  recordParkedRun('job_approved_test')
  recordPipelineEvent({
    pipelineId: 'job_approved_test',
    stage: 'agent',
    status: 'done',
    label: 'Agent execution finished',
  })
  let run = readPipelineRuns().find(
    (item) => item.pipelineId === 'job_approved_test',
  )
  assert.equal(run.approval, null)
  assert.notEqual(run.status, NEEDS_APPROVAL_STATUS)

  // A run that then fails reports the failure, not the answered question.
  recordParkedRun('job_parked_failed_test')
  recordPipelineEvent({
    pipelineId: 'job_parked_failed_test',
    stage: 'agent',
    status: 'failed',
    label: 'Executing actions — failed',
  })
  run = readPipelineRuns().find(
    (item) => item.pipelineId === 'job_parked_failed_test',
  )
  assert.equal(run.status, 'failed')
  assert.equal(run.approval, null)
})

test('a run nobody held is unaffected by any of this', () => {
  recordPipelineEvent({
    pipelineId: 'job_unheld_test',
    stage: 'agent',
    status: 'done',
    command: 'What time is it?',
  })
  recordPipelineEvent({ pipelineId: 'job_unheld_test', stage: 'relay_result', status: 'done' })

  const run = readPipelineRuns().find(
    (item) => item.pipelineId === 'job_unheld_test',
  )
  assert.equal(run.status, 'completed')
  assert.equal(run.approval, null)

  // A `waiting` event on some OTHER stage is not an approval question.
  assert.equal(
    pendingApproval([{ stage: 'transcription', status: 'waiting' }]),
    null,
  )
  assert.equal(pendingApproval([]), null)
  assert.equal(pendingApproval(undefined), null)
})

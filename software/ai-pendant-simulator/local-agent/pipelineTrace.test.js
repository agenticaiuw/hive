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

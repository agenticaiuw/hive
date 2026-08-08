import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { PLAYBACK_UNKNOWN_STATUS } from '../shared/audioDelivery.js'

const testWorkspace = fs.mkdtempSync(
  path.join(os.tmpdir(), 'pendant-delivery-test-'),
)
process.env.PENDANT_WORKSPACE_PATH = testWorkspace

const { readPipelineRuns, recordPipelineEvent } = await import(
  `./pipelineTrace.js?delivery=${Date.now()}`
)

test.after(() => {
  fs.rmSync(testWorkspace, { recursive: true, force: true })
})

const runFor = (pipelineId) =>
  readPipelineRuns().find((item) => item.pipelineId === pipelineId)

function pendantRun(pipelineId) {
  recordPipelineEvent({
    pipelineId,
    stage: 'transcription',
    status: 'done',
    command: 'what is my battery at',
    meta: { inputTelemetry: { storage: 'live_lte', audioBytes: 148800 } },
  })
  recordPipelineEvent({
    pipelineId,
    stage: 'tts',
    status: 'done',
    meta: { pcmBytes: 32000, sampleRate: 24000 },
  })
  recordPipelineEvent({
    pipelineId,
    stage: 'relay_result',
    status: 'done',
    meta: { pcmBytes: 32000 },
  })
}

test('a live-LTE run no longer finishes on the relay accepting the audio', () => {
  // The old rule only held a run open when input telemetry literally said
  // microSD, so every live-LTE reply was called completed the moment the relay
  // took it — the exact fallback this change removes.
  pendantRun('job_live_lte')
  const held = runFor('job_live_lte')

  assert.equal(held.status, 'processing')
  assert.equal(held.delivery.state, 'held_by_relay')
  assert.equal(held.delivery.awaitsDevice, true)
  assert.equal(held.delivery.heard, 'unknown')
})

test('bytes reaching the pendant makes the run unknown, not done', () => {
  pendantRun('job_downlink')
  recordPipelineEvent({
    pipelineId: 'job_downlink',
    stage: 'device_downlink',
    status: 'done',
    source: 'cloudflare',
    meta: { sentBytes: 32000, pulledByDevice: true },
  })

  const run = runFor('job_downlink')
  assert.equal(run.status, PLAYBACK_UNKNOWN_STATUS)
  assert.equal(run.delivery.state, 'requested_by_device')
  assert.equal(run.delivery.provesPlayback, false)
  assert.equal(run.delivery.heard, 'unknown')
  assert.match(run.delivery.doesNotProve, /never played|ever played/i)
})

test('only a playback report from the pendant completes a pendant run', () => {
  pendantRun('job_played')
  recordPipelineEvent({
    pipelineId: 'job_played',
    stage: 'device_downlink',
    status: 'done',
    meta: { sentBytes: 32000, pulledByDevice: true },
  })
  recordPipelineEvent({
    pipelineId: 'job_played',
    stage: 'device_playback',
    status: 'done',
    source: 'nrf9160',
    meta: { framesPlayed: 1500, framesDropped: 0 },
  })

  const run = runFor('job_played')
  assert.equal(run.status, 'completed')
  assert.equal(run.delivery.state, 'played_by_device')
  assert.equal(run.delivery.heard, 'yes')
})

test('a reported playback failure is not softened into unknown', () => {
  pendantRun('job_playback_failed')
  recordPipelineEvent({
    pipelineId: 'job_playback_failed',
    stage: 'device_downlink',
    status: 'done',
    meta: { sentBytes: 32000, pulledByDevice: true },
  })
  recordPipelineEvent({
    pipelineId: 'job_playback_failed',
    stage: 'device_playback',
    status: 'failed',
    source: 'nrf9160',
  })

  assert.equal(runFor('job_playback_failed').status, 'failed')
})

test('a dashboard run with no speaker waiting still completes', () => {
  recordPipelineEvent({
    pipelineId: 'job_dashboard',
    stage: 'transcription',
    status: 'done',
    command: 'open Outlook',
    meta: { inputTelemetry: { storage: 'dashboard', inputMode: 'typed' } },
  })
  recordPipelineEvent({
    pipelineId: 'job_dashboard',
    stage: 'relay_result',
    status: 'done',
  })

  const run = runFor('job_dashboard')
  assert.equal(run.status, 'completed')
  assert.equal(run.delivery.awaitsDevice, false)
  assert.equal(run.delivery.heard, 'no-audio')
})

test('every stored run carries its delivery evidence, not just a status', () => {
  pendantRun('job_evidence')
  const run = runFor('job_evidence')

  assert.ok(run.delivery.witness)
  assert.ok(run.delivery.evidence)
  assert.ok(run.delivery.doesNotProve)
  assert.match(run.delivery.heardBecause, /device_playback/)
})

import assert from 'node:assert/strict'
import { EventEmitter } from 'node:events'
import test from 'node:test'

import {
  PLAYBACK_UNKNOWN_STATUS,
  gradeAudioDelivery,
} from '../shared/audioDelivery.js'
import {
  pendantDownlinkEvent,
  pendantSpeechJobId,
  recordPendantDownlink,
  registerPendantDownlinkWitness,
} from './pendantDownlink.js'
import { voiceRunForJob } from './jobs.js'

/* Let the witness's fire-and-forget store write land. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

function fakeApp() {
  const middleware = []
  return {
    use: (fn) => middleware.push(fn),
    async run(request, response) {
      for (const fn of middleware) await new Promise((r) => fn(request, response, r))
    },
  }
}

function fakeResponse({ statusCode = 200, contentLength = 32000 } = {}) {
  const response = new EventEmitter()
  response.statusCode = statusCode
  response.getHeader = (name) =>
    String(name).toLowerCase() === 'content-length' ? contentLength : undefined
  return response
}

function fakeStore(job) {
  const created = []
  return {
    created,
    updates: [],
    async getJob(jobId) {
      return jobId === job?.jobId ? job : null
    },
    async updateJob(jobId, patch) {
      this.updates.push({ jobId, patch })
      Object.assign(job, patch)
      return job
    },
    async createJob(record) {
      created.push(record)
      return record
    },
  }
}

const proxyJob = ({ method, path, body, deviceId }) => ({
  jobId: 'proxy_1',
  type: 'agent_proxy',
  method,
  path,
  body,
  createdBy: deviceId,
})

test('only the pendant’s reply-audio pull is matched', () => {
  assert.equal(
    pendantSpeechJobId('/v1/pendant/jobs/job_abc/speech'),
    'job_abc',
  )
  assert.equal(
    pendantSpeechJobId('/v1/pendant/jobs/job_abc/speech?waitMs=25000'),
    'job_abc',
  )
  assert.equal(pendantSpeechJobId('/v1/pendant/jobs/job_abc/events'), null)
  assert.equal(pendantSpeechJobId('/v1/ops/audio-captures'), null)
})

test('a completed pull is recorded as bytes leaving, never as playback', () => {
  const event = pendantDownlinkEvent({
    sentBytes: 32000,
    pulledByDevice: true,
    completed: true,
    deviceId: 'nrf9160-pendant',
    at: '2026-08-07T09:00:00.000Z',
  })

  assert.equal(event.stage, 'device_downlink')
  assert.equal(event.status, 'done')
  assert.equal(event.meta.sentBytes, 32000)
  assert.equal(event.meta.pulledByDevice, true)
  assert.equal(event.meta.witness, 'relay-socket')
  // The label and detail have to say what was seen, not what would be nice.
  assert.match(event.detail, /says nothing about whether the reply was played/i)
  assert.doesNotMatch(event.label, /played|heard|delivered/i)
})

test('a download that breaks off is failed, not a smaller success', () => {
  const event = pendantDownlinkEvent({
    sentBytes: 32000,
    pulledByDevice: true,
    completed: false,
  })

  assert.equal(event.status, 'failed')
  assert.equal(event.meta.completed, false)
  assert.match(event.detail, /all, some, or none/i)
})

test('the witness records a finished 200 and forwards it to the Mac', async () => {
  const job = { jobId: 'job_1', type: 'plan', command: 'open Outlook', deviceEvents: [] }
  const store = fakeStore(job)
  const app = fakeApp()
  registerPendantDownlinkWitness(app, {
    getStore: async () => store,
    createAgentProxyJob: proxyJob,
  })

  const response = fakeResponse()
  await app.run(
    {
      method: 'GET',
      path: '/v1/pendant/jobs/job_1/speech',
      relayPrincipal: { kind: 'device', deviceId: 'nrf9160-pendant' },
    },
    response,
  )
  response.emit('finish')
  await settle()

  assert.equal(job.deviceEvents.length, 1)
  assert.equal(job.deviceEvents[0].stage, 'device_downlink')
  assert.equal(job.deviceEvents[0].status, 'done')
  assert.equal(job.deviceEvents[0].meta.pulledByDevice, true)

  assert.equal(store.created.length, 1)
  assert.equal(store.created[0].path, '/pipeline/events')
  assert.equal(store.created[0].body.pipelineId, 'job_1')
  assert.equal(store.created[0].body.stage, 'device_downlink')
})

test('a reader that is not the device claims the weaker rung', async () => {
  const job = { jobId: 'job_2', type: 'plan', deviceEvents: [] }
  const store = fakeStore(job)
  const app = fakeApp()
  registerPendantDownlinkWitness(app, { getStore: async () => store })

  const response = fakeResponse()
  await app.run(
    {
      method: 'GET',
      path: '/v1/pendant/jobs/job_2/speech',
      relayPrincipal: { kind: 'admin' },
    },
    response,
  )
  response.emit('finish')
  await settle()

  assert.equal(job.deviceEvents[0].meta.pulledByDevice, false)
  const delivery = gradeAudioDelivery(job.deviceEvents)
  assert.equal(delivery.state, 'bytes_sent_to_device')
})

test('being told "not ready yet" is not a downlink', async () => {
  const job = { jobId: 'job_3', type: 'plan', deviceEvents: [] }
  const store = fakeStore(job)
  const app = fakeApp()
  registerPendantDownlinkWitness(app, { getStore: async () => store })

  const response = fakeResponse({ statusCode: 202, contentLength: 0 })
  await app.run(
    {
      method: 'GET',
      path: '/v1/pendant/jobs/job_3/speech',
      relayPrincipal: { kind: 'device', deviceId: 'p' },
    },
    response,
  )
  response.emit('finish')
  await settle()

  assert.equal(job.deviceEvents.length, 0)
})

test('a response that dies mid-body is recorded as broken off', async () => {
  const job = { jobId: 'job_4', type: 'plan', deviceEvents: [] }
  const store = fakeStore(job)
  const app = fakeApp()
  registerPendantDownlinkWitness(app, { getStore: async () => store })

  const response = fakeResponse()
  await app.run(
    {
      method: 'GET',
      path: '/v1/pendant/jobs/job_4/speech',
      relayPrincipal: { kind: 'device', deviceId: 'p' },
    },
    response,
  )
  response.emit('close')
  await settle()

  assert.equal(job.deviceEvents[0].status, 'failed')
})

test('telemetry never breaks the reply it is watching', async () => {
  const broken = {
    async getJob() {
      throw new Error('D1 unavailable')
    },
  }

  const event = pendantDownlinkEvent({ sentBytes: 10, pulledByDevice: true })
  const result = await recordPendantDownlink({
    store: broken,
    jobId: 'job_5',
    event,
  })
  assert.equal(result, null)
})

test('voiceRunForJob stops calling a Mac-side finish a delivery', () => {
  const job = {
    jobId: 'job_live',
    type: 'plan',
    status: 'completed',
    command: 'open Outlook',
    inputTelemetry: { storage: 'live_lte', audioBytes: 148800 },
    result: {
      response: 'Outlook is open.',
      executed: true,
      pendantSpeech: { format: 's16le', sampleRate: 24000, pcmBytes: 32000 },
    },
    deviceEvents: [
      pendantDownlinkEvent({
        sentBytes: 32000,
        pulledByDevice: true,
        at: '2026-08-07T09:00:04.000Z',
      }),
    ],
    createdAt: '2026-08-07T09:00:00.000Z',
    updatedAt: '2026-08-07T09:00:04.000Z',
  }

  const run = voiceRunForJob(job)

  // The Mac executed the plan AND the pendant fetched the audio, and the run
  // still refuses to say Done, because nothing witnessed the speaker.
  assert.equal(run.status, PLAYBACK_UNKNOWN_STATUS)
  assert.equal(run.delivery.state, 'requested_by_device')
  assert.equal(run.delivery.heard, 'unknown')
  assert.equal(run.delivery.provesPlayback, false)
})

test('a browser run still finishes on the Mac’s answer', () => {
  const run = voiceRunForJob({
    jobId: 'job_dash',
    type: 'plan',
    status: 'completed',
    command: 'open Outlook',
    inputTelemetry: { storage: 'dashboard', source: 'dashboard-web', inputMode: 'typed' },
    result: { response: 'Outlook is open.', executed: true },
    deviceEvents: [],
    createdAt: '2026-08-07T09:00:00.000Z',
    updatedAt: '2026-08-07T09:00:02.000Z',
  })

  assert.equal(run.status, 'completed')
  assert.equal(run.delivery.heard, 'no-audio')
})

test('a pendant run whose device reported playback is genuinely done', () => {
  const run = voiceRunForJob({
    jobId: 'job_played',
    type: 'plan',
    status: 'completed',
    command: 'open Outlook',
    inputTelemetry: { storage: 'live_lte' },
    result: {
      response: 'Outlook is open.',
      executed: true,
      pendantSpeech: { format: 's16le', sampleRate: 24000, pcmBytes: 32000 },
    },
    deviceEvents: [
      { eventId: 'e1', stage: 'device_playback', status: 'done', at: '2026-08-07T09:00:06.000Z' },
    ],
    createdAt: '2026-08-07T09:00:00.000Z',
    updatedAt: '2026-08-07T09:00:06.000Z',
  })

  assert.equal(run.status, 'completed')
  assert.equal(run.delivery.heard, 'yes')
})

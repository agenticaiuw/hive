/*
 * The last point on the relay side of the wire that witnesses anything real
 * about a reply reaching the pendant.
 *
 * The pendant pulls its reply with an authenticated
 * `GET /v1/pendant/jobs/:jobId/speech`. When that request completes, three
 * separate things are true and none of them was being recorded:
 *
 *   1. a credentialled device asked for THIS job's reply — so it was powered,
 *      on the network, and wanted the answer;
 *   2. the relay wrote N bytes of audio to that request;
 *   3. the response finished rather than dying mid-body.
 *
 * That is strictly more than "the Mac finished rendering" and strictly less than
 * "the owner heard it". It gets its own stage, `device_downlink`, and its own
 * rung in shared/audioDelivery.js, so it can be reported without being mistaken
 * for playback. The event's label says what happened — bytes went out — rather
 * than inventing a confident word for it.
 *
 * WHAT THIS DOES NOT DO
 *
 * It does not emit `device_playback`. Only the pendant can witness its own
 * speaker, the firmware has the reporters and never calls them, and on the live
 * duplex path it holds no job id to put in one. See PLAYBACK_REPORT_CONTRACT in
 * shared/audioDelivery.js. Emitting a playback event from here would be a lie
 * told by the one body in the system that cannot possibly know.
 *
 * WIRING
 *
 * cloud-relay/server.js is not edited by this change. Call
 * `registerPendantDownlinkWitness(app, { getStore, createAgentProxyJob })` there,
 * AFTER the authentication middleware (it reads `request.relayPrincipal`) and
 * BEFORE the route declarations (it wraps the response before the handler runs).
 * The existing `registerFleetMemoryRoutes(app, { getStore })` call is the same
 * pattern.
 */
import { DELIVERY_STAGES } from '../shared/audioDelivery.js'
import { ringBridgeDoorbell } from './bridgeDoorbell.js'

/**
 * Matches the pendant's reply-audio pull and captures the job id.
 * A pattern rather than a route registration, because the witness has to wrap a
 * handler that already exists rather than add one.
 */
export const PENDANT_SPEECH_PATH = /^\/v1\/pendant\/jobs\/([^/?#]+)\/speech\/?$/

/** Where the relay parks telemetry destined for the Mac dashboard. */
const TELEMETRY_DEVICE_ID = 'pendant-telemetry'
const AGENT_PIPELINE_PATH = '/pipeline/events'

export function pendantSpeechJobId(pathname) {
  const match = PENDANT_SPEECH_PATH.exec(String(pathname || '').split('?')[0])
  return match ? decodeURIComponent(match[1]) : null
}

/**
 * Build the event for one completed (or aborted) reply pull.
 *
 * `pulledByDevice` is the difference between "the pendant asked" and "someone
 * asked on the pendant's behalf" — an ops dashboard fetching the same audio for
 * a preview proves nothing about the pendant, so it claims the weaker rung.
 */
export function pendantDownlinkEvent({
  sentBytes = 0,
  pulledByDevice = false,
  completed = true,
  deviceId = null,
  at = null,
  makeEventId = () => `relay_evt_${Math.random().toString(36).slice(2)}`,
}) {
  const bytes = Math.max(0, Number(sentBytes) || 0)
  const who = pulledByDevice ? 'The pendant' : 'A signed-in reader'

  return {
    eventId: makeEventId(),
    stage: DELIVERY_STAGES.DOWNLINK,
    /*
     * A response that died mid-body is a distinct fact from one that finished,
     * and it is not a smaller success. It is recorded as failed so nothing
     * downstream can read a truncated download as a delivered one.
     */
    status: completed && bytes > 0 ? 'done' : 'failed',
    label: completed
      ? `${who} fetched the reply audio`
      : `${who} asked for the reply audio and the download broke off`,
    detail: completed
      ? `${bytes} bytes of reply audio were written to the request. ` +
        'This is the relay watching bytes leave. It is not a report from the ' +
        'pendant and says nothing about whether the reply was played.'
      : `The request was accepted and ${bytes} bytes were in flight when the ` +
        'connection ended. The pendant may hold all, some, or none of it.',
    source: 'cloudflare',
    meta: {
      sentBytes: bytes,
      pulledByDevice: Boolean(pulledByDevice),
      completed: Boolean(completed),
      deviceId: deviceId ? String(deviceId).slice(0, 120) : null,
      transport: 'https',
      witness: 'relay-socket',
    },
    at: at || new Date().toISOString(),
  }
}

/**
 * Persist one downlink observation: onto the relay job, and forward to the Mac's
 * pipeline through the same authenticated bridge queue the device's own
 * telemetry uses. Never throws — telemetry must not be able to break a reply.
 */
export async function recordPendantDownlink({
  store,
  createAgentProxyJob,
  jobId,
  event,
  maxDeviceEvents = 32,
}) {
  if (!store || !jobId || !event) return null

  try {
    const job = await store.getJob(jobId)
    if (!job) return null

    const deviceEvents = [
      ...(Array.isArray(job.deviceEvents) ? job.deviceEvents : []),
      event,
    ].slice(-maxDeviceEvents)
    await store.updateJob(jobId, { deviceEvents })

    if (typeof createAgentProxyJob === 'function' && typeof store.createJob === 'function') {
      await store.createJob(
        createAgentProxyJob({
          method: 'POST',
          path: AGENT_PIPELINE_PATH,
          body: {
            pipelineId: jobId,
            kind: job.type || 'voice_command',
            command: job.command || '',
            sessionId: job.sessionId ?? null,
            ...event,
          },
          deviceId: TELEMETRY_DEVICE_ID,
        }),
      )
      /* Queued work exists now, so ring — a quiet-cadence bridge would
       * otherwise show this downlink a safety-poll interval late. Never
       * throws, matching this function's own contract. */
      await ringBridgeDoorbell({ store, reason: 'pendant-downlink' })
    }

    return event
  } catch (error) {
    console.warn(
      `[downlink] Could not record reply pull for ${jobId}: ${error?.message || error}`,
    )
    return null
  }
}

/**
 * Wrap the reply-audio route so its outcome is observed.
 *
 * Nothing about the response is altered. The witness reads what the response
 * declared it was sending and whether it finished, then records asynchronously
 * after the bytes are gone, so a slow store write can never delay a pendant that
 * is waiting to speak.
 */
export function registerPendantDownlinkWitness(
  app,
  { getStore, createAgentProxyJob, now = () => new Date().toISOString() } = {},
) {
  if (!app || typeof getStore !== 'function') {
    throw new TypeError(
      'registerPendantDownlinkWitness needs an app and getStore().',
    )
  }

  app.use((request, response, next) => {
    if (String(request.method || '').toUpperCase() !== 'GET') {
      next()
      return
    }
    const jobId = pendantSpeechJobId(request.path ?? request.url)
    if (!jobId) {
      next()
      return
    }

    const principal = request.relayPrincipal
    const pulledByDevice = principal?.kind === 'device'
    const deviceId = principal?.deviceId ?? null
    let settled = false

    const settle = (completed) => {
      if (settled) return
      settled = true

      /*
       * Only a 200 carried audio. A 202 (not ready yet) or a 404/502 is the
       * pendant asking and being told no, which is not a downlink and must not
       * be recorded as one.
       */
      if (Number(response.statusCode) !== 200) return
      const declared = Number(response.getHeader?.('Content-Length'))
      const sentBytes = Number.isFinite(declared) ? declared : 0
      if (sentBytes <= 0) return

      const event = pendantDownlinkEvent({
        sentBytes,
        pulledByDevice,
        completed,
        deviceId,
        at: now(),
      })

      void (async () => {
        const store = await getStore().catch(() => null)
        await recordPendantDownlink({
          store,
          createAgentProxyJob,
          jobId,
          event,
        })
      })()
    }

    response.on('finish', () => settle(true))
    /* 'close' after 'finish' is normal; 'close' alone means the body broke off. */
    response.on('close', () => settle(false))
    next()
  })

  return app
}

import assert from 'node:assert/strict'
import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  AUDIO_RETENTION_DEFAULT_MAX_AGE_MS,
  AUDIO_RETENTION_DEFAULT_MAX_BYTES,
  audioReachability,
  audioRetentionLocations,
  audioRetentionPolicy,
  deleteAudioForJob,
  planAudioSweep,
  registerAudioRetentionRoutes,
  scanAudioOnDisk,
  startAudioRetentionSweeper,
  sweepAudio,
} from './audioRetention.js'

const HOUR_MS = 60 * 60 * 1000
const NOW = Date.parse('2026-08-07T18:00:00.000Z')

function workspace(t) {
  const directory = fs.mkdtempSync(
    path.join(os.tmpdir(), 'pendant-audio-retention-test-'),
  )
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  fs.mkdirSync(path.join(directory, 'Briefings'), { recursive: true })
  fs.mkdirSync(path.join(directory, 'pipeline-audio'), { recursive: true })
  return directory
}

const digestOf = (value) =>
  crypto.createHash('sha256').update(String(value)).digest('hex')

/** Write a file of an exact size with an exact age. */
function putFile(filePath, { bytes = 1024, ageHours = 0 } = {}) {
  fs.writeFileSync(filePath, Buffer.alloc(bytes, 7))
  const when = new Date(NOW - ageHours * HOUR_MS)
  fs.utimesSync(filePath, when, when)
  return filePath
}

function putBriefingAudio(root, basename, options) {
  return putFile(path.join(root, 'Briefings', `${basename}.wav`), options)
}

function putPipelineAudio(root, pipelineId, direction, options) {
  return putFile(
    path.join(
      root,
      'pipeline-audio',
      `${digestOf(pipelineId)}-${direction}.wav`,
    ),
    options,
  )
}

function writeBriefingStore(root, briefings) {
  fs.writeFileSync(
    path.join(root, '.pendant-briefings.json'),
    JSON.stringify({ briefings }, null, 2),
  )
}

function writePipelineStore(root, runs) {
  fs.writeFileSync(
    path.join(root, 'pendant-pipeline.json'),
    JSON.stringify(runs, null, 2),
  )
}

/*
 * THE BUDGET IS IN BYTES, AND THIS IS THE TEST THAT SAYS SO.
 *
 * jobTracker.js carries the postmortem for the alternative: a store that
 * capped a COUNT of jobs reached 129 MB and wedged the agent. The same
 * mistake in audioBrief.js — MAX_STORED_BRIEFINGS = 50 entries — is what left
 * 48.2 MB of orphaned .wav files on this machine.
 *
 * Six files is a number no plausible item cap would ever evict. They are also
 * six times the byte budget here, because audio is the payload where "how
 * many" and "how much" differ by four orders of magnitude: a 10-second reply
 * is 480 KB of PCM and a two-minute briefing is 5.8 MB. A count-based sweeper
 * passes this scenario and still fills the disk.
 */
test('the sweep is bounded in bytes, whatever the files weigh', (t) => {
  const root = workspace(t)
  for (let index = 0; index < 6; index += 1) {
    putBriefingAudio(root, `20260807-00000${index}-brief`, {
      bytes: 100_000,
      ageHours: 6 - index,
    })
  }

  const report = sweepAudio({
    workspace: root,
    now: NOW,
    maxBytes: 100_000,
    apply: true,
  })

  assert.equal(report.applied, true)
  assert.ok(report.keep.bytes <= 100_000, `kept ${report.keep.bytes} bytes`)
  assert.equal(report.removed.length, 5)
  assert.equal(report.freedBytes, 500_000)
  assert.ok(report.removed.every((file) => file.reason === 'over-budget'))

  const survivors = fs.readdirSync(path.join(root, 'Briefings'))
  assert.equal(survivors.length, 1)
  /* Oldest-first eviction: the newest briefing — the one the owner has most
   * likely not played yet — is the last thing to go. */
  assert.equal(survivors[0], '20260807-000005-brief.wav')
})

/*
 * The measured failure, reproduced.
 *
 * On 2026-08-07 .pendant-briefings.json held 50 entries whose wavPath was the
 * SAME single file, because a routine re-ran and the 50-entry count cap pushed
 * everything else out. Seventeen .wav files — 48.2 MB, 80% of all audio bytes
 * on disk — were referenced by no entry at all.
 *
 * A sweeper that walked the store would have seen one file and called the disk
 * clean. This one walks the filesystem, so the orphans are exactly what it
 * finds.
 */
test('orphaned audio the store cap forgot is still swept', (t) => {
  const root = workspace(t)
  const kept = putBriefingAudio(root, '20260807-113000-schedule-brief', {
    bytes: 2_000,
    ageHours: 1,
  })
  for (let index = 0; index < 17; index += 1) {
    putBriefingAudio(root, `20260807-0000${index}-orphan`, {
      bytes: 3_000,
      ageHours: 72,
    })
  }
  /* Fifty entries, one path — the shape actually measured. */
  writeBriefingStore(
    root,
    Array.from({ length: 50 }, (_unused, index) => ({
      id: `brf_${index}`,
      createdAt: new Date(NOW - HOUR_MS).toISOString(),
      wavPath: kept,
      spoken: 'Your schedule for today.',
    })),
  )

  const inventory = scanAudioOnDisk({ workspace: root, now: NOW })
  assert.equal(inventory.count, 18)
  assert.equal(inventory.unattributable.files, 17)
  assert.equal(inventory.unattributable.bytes, 51_000)

  const report = sweepAudio({ workspace: root, now: NOW, apply: true })
  assert.equal(report.removed.length, 17)
  assert.ok(report.removed.every((file) => file.reason === 'expired'))
  assert.equal(fs.existsSync(kept), true, 'the live briefing survives')
  assert.equal(fs.readdirSync(path.join(root, 'Briefings')).length, 1)
})

/*
 * audioBrief.js writes to `Briefings/` and briefing.js writes its routine
 * notes to `briefings/`; on a case-insensitive volume those are one directory,
 * and the .md notes and latest.json in it belong to another module. A sweeper
 * that took "everything in the audio directory" as its scope would delete
 * another agent's files, so the filter is extensions and never the folder.
 */
test('non-audio in the shared briefings directory is never touched', (t) => {
  const root = workspace(t)
  putBriefingAudio(root, '20260807-000001-brief', { bytes: 500, ageHours: 200 })
  const note = path.join(root, 'Briefings', '20260807-000001-brief.md')
  const latest = path.join(root, 'Briefings', 'latest.json')
  fs.writeFileSync(note, '# a briefing note')
  fs.writeFileSync(latest, '{"kind":"workday"}')

  const inventory = scanAudioOnDisk({ workspace: root, now: NOW })
  assert.equal(inventory.count, 1)
  assert.equal(
    inventory.skipped.filter((entry) => entry.reason === 'not-pendant-audio')
      .length,
    2,
  )

  sweepAudio({ workspace: root, now: NOW, apply: true })
  assert.equal(fs.existsSync(note), true)
  assert.equal(fs.existsSync(latest), true)
  assert.equal(
    fs.existsSync(path.join(root, 'Briefings', '20260807-000001-brief.wav')),
    false,
  )
})

/*
 * The owner's own voice gets the shortest life of anything here. Transcription
 * has already succeeded by the time the file exists, so a recording of the
 * owner speaking is a debugging byproduct of a finished job — the most
 * sensitive thing on the disk and the least useful to keep.
 */
test('captured speech expires before generated audio does', (t) => {
  const root = workspace(t)
  putPipelineAudio(root, 'job_alpha', 'input', { bytes: 900, ageHours: 8 })
  putPipelineAudio(root, 'job_alpha', 'output', { bytes: 900, ageHours: 8 })
  putBriefingAudio(root, '20260807-000001-brief', { bytes: 900, ageHours: 8 })

  const plan = planAudioSweep({ workspace: root, now: NOW })
  const removed = plan.remove.map((file) => file.kind)

  assert.deepEqual(removed, ['captured'])
  assert.ok(
    AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.captured <
      AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.spoken,
  )
  assert.ok(
    AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.spoken <
      AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.generated,
  )
})

/*
 * cloud-relay/config.js states the rule for its own copy of this knob:
 * "AUDIO_RETENTION_MAX_AGE_MS=0 must never mean 'erase everything'". The same
 * holds here, and for every other unit. A typo in a launchd plist must not be
 * able to widen deletion.
 */
test('a zero or nonsense setting falls back instead of widening deletion', () => {
  const policy = audioRetentionPolicy({
    maxBytes: 0,
    maxAgeMs: { generated: 0, captured: -1, spoken: 'soon' },
    now: NOW,
  })

  assert.equal(policy.maxBytes, AUDIO_RETENTION_DEFAULT_MAX_BYTES)
  assert.deepEqual(policy.maxAgeMs, {
    generated: AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.generated,
    captured: AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.captured,
    spoken: AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.spoken,
  })
})

test('a sweep removes nothing unless it is told to apply', (t) => {
  const root = workspace(t)
  const stale = putBriefingAudio(root, '20260807-000001-brief', {
    bytes: 900,
    ageHours: 500,
  })

  const dry = sweepAudio({ workspace: root, now: NOW })
  assert.equal(dry.dryRun, true)
  assert.equal(dry.applied, false)
  assert.equal(dry.removed.length, 0)
  assert.equal(dry.remove.length, 1)
  assert.equal(dry.wouldFreeBytes, 900)
  assert.equal(fs.existsSync(stale), true)
})

test('retention can be switched off entirely for a debugging session', (t) => {
  const root = workspace(t)
  const stale = putBriefingAudio(root, '20260807-000001-brief', {
    bytes: 900,
    ageHours: 500,
  })
  const previous = process.env.PENDANT_AUDIO_RETENTION_DISABLED
  process.env.PENDANT_AUDIO_RETENTION_DISABLED = 'true'
  t.after(() => {
    if (previous === undefined) delete process.env.PENDANT_AUDIO_RETENTION_DISABLED
    else process.env.PENDANT_AUDIO_RETENTION_DISABLED = previous
  })

  const report = sweepAudio({ workspace: root, now: NOW, apply: true })
  assert.equal(report.applied, false)
  assert.equal(report.blocked, 'PENDANT_AUDIO_RETENTION_DISABLED')
  assert.equal(fs.existsSync(stale), true)
})

/*
 * A symlink dropped in the audio directory must not turn a retention sweep
 * into a delete of whatever it points at. readdir reports it as neither a file
 * nor a directory, and it is skipped by name rather than followed.
 */
test('a symlink in the audio directory is reported, not followed', (t) => {
  const root = workspace(t)
  const outside = path.join(root, 'not-audio.wav')
  putFile(outside, { bytes: 64, ageHours: 500 })
  fs.symlinkSync(outside, path.join(root, 'Briefings', 'linked.wav'))

  const inventory = scanAudioOnDisk({ workspace: root, now: NOW })
  assert.equal(inventory.count, 0)
  assert.equal(inventory.skipped[0].reason, 'not-a-regular-file')

  sweepAudio({ workspace: root, now: NOW, apply: true })
  assert.equal(fs.existsSync(outside), true)
})

test('per-job deletion removes both halves of a conversation and says how much', (t) => {
  const root = workspace(t)
  putPipelineAudio(root, 'job_alpha', 'input', { bytes: 1_200 })
  putPipelineAudio(root, 'job_alpha', 'output', { bytes: 800 })
  putPipelineAudio(root, 'job_beta', 'output', { bytes: 400 })
  writePipelineStore(root, [
    { pipelineId: 'job_alpha', command: 'what is on my calendar', events: [] },
    { pipelineId: 'job_beta', command: 'unrelated', events: [] },
  ])

  const report = deleteAudioForJob('job_alpha', { workspace: root, now: NOW })

  assert.equal(report.matched, 2)
  assert.equal(report.freedBytes, 2_000)
  assert.deepEqual(report.removed.map((file) => file.kind).sort(), [
    'captured',
    'spoken',
  ])
  assert.equal(report.failed.length, 0)
  assert.equal(fs.readdirSync(path.join(root, 'pipeline-audio')).length, 1)
})

/*
 * pipeline-audio filenames are sha256(pipelineId), and pendant-pipeline.json
 * caps itself at MAX_RUNS = 80 RUNS — another count. Once a run rolls off,
 * nothing on disk can tell you which conversation the file belonged to,
 * because a hash does not invert.
 *
 * Deleting by the id the CALLER supplies rather than by lookup is what keeps
 * "forget everything from that conversation" working after the index is gone.
 */
test('per-job deletion still finds audio after the run record has rolled off', (t) => {
  const root = workspace(t)
  putPipelineAudio(root, 'job_forgotten', 'input', { bytes: 640 })
  writePipelineStore(root, [])

  const inventory = scanAudioOnDisk({ workspace: root, now: NOW })
  assert.equal(inventory.files[0].attributable, false)
  assert.equal(inventory.files[0].jobId, null)

  const report = deleteAudioForJob('job_forgotten', {
    workspace: root,
    now: NOW,
  })
  assert.equal(report.matched, 1)
  assert.equal(report.freedBytes, 640)
})

/*
 * Deleting the recording and keeping the words is not deletion. The briefing
 * store keeps `spoken`, the full transcript — 32 700 characters of it across
 * the 50 entries measured on this machine.
 */
test('deleting a briefing takes its transcript with it', (t) => {
  const root = workspace(t)
  const wavPath = putBriefingAudio(root, '20260807-113000-schedule-brief', {
    bytes: 2_048,
  })
  writeBriefingStore(root, [
    {
      id: 'brf_keep',
      wavPath: path.join(root, 'Briefings', 'other.wav'),
      spoken: 'a different briefing',
    },
    {
      id: 'brf_target',
      wavPath,
      spoken: 'Your first meeting is with the cardiologist at nine.',
    },
  ])

  const report = deleteAudioForJob('brf_target', { workspace: root, now: NOW })

  assert.equal(report.matched, 1)
  assert.equal(report.metadata.briefingEntriesRemoved, 1)
  const store = JSON.parse(
    fs.readFileSync(path.join(root, '.pendant-briefings.json'), 'utf8'),
  )
  assert.equal(store.briefings.length, 1)
  assert.equal(
    JSON.stringify(store).includes('cardiologist'),
    false,
    'the transcript went with the audio',
  )
})

/*
 * A local_ job never left this Mac, so there is nothing in R2 or D1 to miss
 * and the delete can honestly call itself complete. That claim is only worth
 * anything because the opposite case below refuses to make it.
 */
test('a job that never left the Mac reports a complete deletion', (t) => {
  const root = workspace(t)
  putPipelineAudio(root, 'local_only', 'output', { bytes: 512 })
  writePipelineStore(root, [{ pipelineId: 'local_only', events: [] }])

  const report = deleteAudioForJob('local_only', { workspace: root, now: NOW })

  assert.equal(report.complete, true)
  const relay = report.unreachable.find((sink) => sink.sink.includes('cloud-relay'))
  assert.equal(relay.holdsCopy, 'no')
  assert.equal(relay.reachable, false)
})

test('a relay job admits the server-side copy it cannot reach', (t) => {
  const root = workspace(t)
  putPipelineAudio(root, 'job_relayed', 'input', { bytes: 512 })
  writePipelineStore(root, [{ pipelineId: 'job_relayed', events: [] }])

  const report = deleteAudioForJob('job_relayed', { workspace: root, now: NOW })

  assert.equal(report.complete, false, 'a copy may survive on the relay')
  const relay = report.unreachable.find((sink) => sink.sink.includes('cloud-relay'))
  assert.equal(relay.holdsCopy, 'unknown')
  assert.match(relay.reachItWith, /DELETE \/v1\/ops\/history\/job_relayed\/audio/)
})

/*
 * The standing rule in firmware/nrf9160/src/pendant_store.h: "Only save an
 * audio copy to SD if the chunk upload cannot be uploaded. SD is the failure
 * path, never the default."
 *
 * So the absence of microSD telemetry is real evidence that no device copy was
 * made, and its presence is real evidence that one was. Reporting the second
 * case as a completed deletion would be a lie about hardware this process
 * cannot touch.
 */
test('a recording that came off the pendant SD card is not reported as fully deleted', (t) => {
  const root = workspace(t)
  putPipelineAudio(root, 'job_offline', 'input', { bytes: 512 })
  writePipelineStore(root, [
    {
      pipelineId: 'job_offline',
      events: [
        {
          stage: 'transcription',
          meta: { inputTelemetry: { storage: 'microSD' } },
        },
      ],
    },
  ])

  const report = deleteAudioForJob('job_offline', { workspace: root, now: NOW })

  assert.equal(report.matched, 1)
  assert.equal(report.complete, false)
  const card = report.unreachable.find((sink) => sink.sink.includes('microSD'))
  assert.equal(card.holdsCopy, 'likely')
  assert.equal(card.reachable, false)
  assert.match(card.detail, /failure buffer/)
})

test('a job with no microSD telemetry says so rather than shrugging', (t) => {
  const root = workspace(t)
  putPipelineAudio(root, 'local_live', 'input', { bytes: 512 })
  writePipelineStore(root, [{ pipelineId: 'local_live', events: [] }])

  const report = deleteAudioForJob('local_live', { workspace: root, now: NOW })
  const card = report.unreachable.find((sink) => sink.sink.includes('microSD'))
  assert.equal(card.holdsCopy, 'no')
  assert.match(card.detail, /only when an upload fails/)
})

/*
 * writeJsonAtomic advances the .bak to the new value once the primary lands,
 * so a clean delete leaves nothing behind — but an interrupted write does, and
 * an abandoned .tmp holding the transcript is a copy of the thing the owner
 * asked to have removed. Checking is cheap; assuming is the failure mode this
 * whole module exists to avoid.
 */
test('a transcript left in an interrupted write is found and reported', (t) => {
  const root = workspace(t)
  const wavPath = putBriefingAudio(root, '20260807-000001-brief', { bytes: 128 })
  writeBriefingStore(root, [
    { id: 'brf_target', wavPath, spoken: 'the words' },
  ])
  fs.writeFileSync(
    path.join(root, '.pendant-briefings.json.tmp.9999.abandoned'),
    JSON.stringify({ briefings: [{ id: 'brf_target', spoken: 'the words' }] }),
  )

  const report = deleteAudioForJob('brf_target', { workspace: root, now: NOW })

  assert.equal(report.complete, false)
  const residual = report.unreachable.find((sink) =>
    sink.sink.includes('backup/temp'),
  )
  assert.ok(residual, 'the leftover copy is named, not ignored')
  assert.equal(residual.reachable, true)
  assert.equal(residual.paths.length, 1)
})

test('deleting an id with nothing on disk is a success, not an error', (t) => {
  const root = workspace(t)

  const report = deleteAudioForJob('local_nothing', {
    workspace: root,
    now: NOW,
  })

  assert.equal(report.matched, 0)
  assert.equal(report.freedBytes, 0)
  assert.equal(report.removed.length, 0)
  assert.equal(report.complete, true)
})

test('deleting without an id is refused', (t) => {
  const root = workspace(t)
  assert.throws(
    () => deleteAudioForJob('  ', { workspace: root }),
    /needs a job or briefing id/,
  )
})

/*
 * The sweep can reach unattributable files by age and by budget, and can never
 * reach them by name. Saying which of those two is true is the difference
 * between a retention report and a promise that cannot be kept.
 */
test('the sweep names the audio that no targeted delete could ever find', (t) => {
  const root = workspace(t)
  putPipelineAudio(root, 'job_gone', 'output', { bytes: 4_096, ageHours: 1 })
  writePipelineStore(root, [])

  const report = sweepAudio({ workspace: root, now: NOW })
  const orphaned = report.unreachable.find((sink) =>
    sink.sink.includes('unattributable'),
  )

  assert.ok(orphaned)
  assert.equal(orphaned.reachable, true)
  assert.equal(orphaned.holdsCopy, 'likely')
  assert.match(orphaned.detail, /4096 bytes/)
})

test('reachability lists every sink, including the ones off this machine', (t) => {
  const root = workspace(t)
  putBriefingAudio(root, '20260807-000001-brief', { bytes: 10 })
  putPipelineAudio(root, 'job_a', 'input', { bytes: 20 })
  putPipelineAudio(root, 'job_a', 'output', { bytes: 30 })

  const map = audioReachability({ workspace: root, now: NOW })

  assert.equal(map.readOnly, true)
  assert.equal(map.reachable.length, 4)
  assert.deepEqual(
    map.reachable.map((sink) => sink.bytes),
    [10, 20, 30, null],
  )
  assert.ok(
    map.unreachable.some((sink) => sink.sink.includes('cloud-relay')),
    'the relay copy is named even when nothing is being deleted',
  )
  assert.ok(map.unreachable.some((sink) => sink.sink.includes('microSD')))
})

test('locations are derived from the workspace, not hard-coded', () => {
  const locations = audioRetentionLocations({ workspace: '/tmp/example' })
  assert.equal(locations.briefings, '/tmp/example/Briefings')
  assert.equal(locations.pipelineAudio, '/tmp/example/pipeline-audio')
  assert.equal(locations.briefingStore, '/tmp/example/.pendant-briefings.json')
})

test('an empty workspace scans clean instead of throwing', (t) => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-audio-empty-'))
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))

  const inventory = scanAudioOnDisk({ workspace: directory, now: NOW })
  assert.equal(inventory.count, 0)
  assert.equal(inventory.bytes, 0)
  assert.equal(inventory.unattributable.files, 0)
})

/* --- HTTP surface --------------------------------------------------------- */

function fakeApp() {
  const routes = new Map()
  const app = {}
  for (const method of ['get', 'post', 'delete']) {
    app[method] = (routePath, handler) => {
      routes.set(`${method.toUpperCase()} ${routePath}`, handler)
      return app
    }
  }
  app.routes = routes
  return app
}

function invoke(app, key, { params = {}, body = {} } = {}) {
  const handler = app.routes.get(key)
  assert.ok(handler, `no handler registered for ${key}`)
  let payload = null
  let status = 200
  const response = {
    status(code) {
      status = code
      return response
    },
    json(value) {
      payload = value
      return response
    },
  }
  handler({ params, body, query: {} }, response)
  return { status, payload }
}

test('the routes mount and the read path changes nothing', (t) => {
  const root = workspace(t)
  const stale = putBriefingAudio(root, '20260807-000001-brief', {
    bytes: 900,
    ageHours: 500,
  })
  const app = registerAudioRetentionRoutes(fakeApp(), {
    locations: audioRetentionLocations({ workspace: root }),
    sweep: false,
  })

  assert.deepEqual(
    [...app.routes.keys()].sort(),
    [
      'DELETE /audio-retention/jobs/:jobId',
      'GET /audio-retention',
      'GET /audio-retention/reachability',
      'POST /audio-retention/sweep',
    ],
  )

  const read = invoke(app, 'GET /audio-retention')
  assert.equal(read.payload.readOnly, true)
  assert.equal(read.payload.remove.length, 1)
  assert.equal(fs.existsSync(stale), true, 'a GET never deletes')
})

/*
 * A curl typo against a route that erases the owner's voice is not a mistake
 * anyone gets to make twice, so the sweep route is inert without an explicit
 * apply in the body.
 */
test('the sweep route is a dry run unless the body says apply', (t) => {
  const root = workspace(t)
  const stale = putBriefingAudio(root, '20260807-000001-brief', {
    bytes: 900,
    ageHours: 500,
  })
  const app = registerAudioRetentionRoutes(fakeApp(), {
    locations: audioRetentionLocations({ workspace: root }),
    sweep: false,
  })

  const dry = invoke(app, 'POST /audio-retention/sweep', { body: {} })
  assert.equal(dry.payload.applied, false)
  assert.equal(fs.existsSync(stale), true)

  const applied = invoke(app, 'POST /audio-retention/sweep', {
    body: { apply: true },
  })
  assert.equal(applied.payload.applied, true)
  assert.equal(applied.payload.freedBytes, 900)
  assert.equal(fs.existsSync(stale), false)
})

test('the delete route reports what it removed and what it could not reach', (t) => {
  const root = workspace(t)
  putPipelineAudio(root, 'job_route', 'input', { bytes: 300 })
  writePipelineStore(root, [{ pipelineId: 'job_route', events: [] }])
  const app = registerAudioRetentionRoutes(fakeApp(), {
    locations: audioRetentionLocations({ workspace: root }),
    sweep: false,
  })

  const result = invoke(app, 'DELETE /audio-retention/jobs/:jobId', {
    params: { jobId: 'job_route' },
  })

  assert.equal(result.status, 200)
  assert.equal(result.payload.ok, true)
  assert.equal(result.payload.freedBytes, 300)
  assert.equal(result.payload.complete, false)
  assert.equal(result.payload.unreachable.length, 2)
})

test('deleting an id with nothing behind it answers ok and says so', (t) => {
  const root = workspace(t)
  const app = registerAudioRetentionRoutes(fakeApp(), {
    locations: audioRetentionLocations({ workspace: root }),
    sweep: false,
  })

  const result = invoke(app, 'DELETE /audio-retention/jobs/:jobId', {
    params: { jobId: 'local_missing' },
  })

  assert.equal(result.status, 200)
  assert.equal(result.payload.ok, true)
  assert.match(result.payload.note, /No audio for that id/)
})

test('registering against something that is not an app is refused', () => {
  assert.throws(
    () => registerAudioRetentionRoutes({}),
    /requires an Express-style app/,
  )
})

/*
 * A retention policy nothing calls is the state this module exists to fix, so
 * mounting the routes is what enables expiry. The alternative — an export the
 * owner has to remember to schedule — is how nineteen proposals for this
 * feature ended up with none of it running.
 */
test('mounting the routes enables the periodic sweep', (t) => {
  const root = workspace(t)
  const app = registerAudioRetentionRoutes(fakeApp(), {
    locations: audioRetentionLocations({ workspace: root }),
  })
  t.after(() => app.stopAudioRetentionSweeper())

  assert.equal(typeof app.stopAudioRetentionSweeper, 'function')
  assert.equal(app.stopAudioRetentionSweeper.intervalMs, 60 * 60 * 1000)
})

test('the periodic sweep removes expired audio when it runs', (t) => {
  const root = workspace(t)
  const stale = putBriefingAudio(root, '20260807-000001-brief', {
    bytes: 900,
    ageHours: 500,
  })
  const reports = []
  const stop = startAudioRetentionSweeper({
    workspace: root,
    onReport: (report) => reports.push(report),
  })
  t.after(stop)

  const report = stop.runOnce()

  assert.equal(report.applied, true)
  assert.equal(report.freedBytes, 900)
  assert.equal(fs.existsSync(stale), false)
  assert.equal(reports.length, 1, 'the caller is told what was removed')
})

/*
 * A sweep that throws must not take the interval down with it. A crashed timer
 * is a silently disabled retention policy, which looks exactly like a working
 * one until somebody measures the disk.
 */
test('a failing sweep is reported rather than killing the schedule', (t) => {
  const errors = []
  /* A number where a path belongs is a real misconfiguration — one bad line in
   * a launchd plist — and path.resolve throws on it. */
  const stop = startAudioRetentionSweeper({
    workspace: 42,
    onError: (error) => errors.push(error),
  })
  t.after(stop)

  assert.equal(stop.runOnce(), null)
  assert.equal(stop.runOnce(), null)

  assert.equal(errors.length, 2, 'every failure is surfaced, not just the first')
  assert.ok(errors[0] instanceof TypeError)
  /* The point of the guard: the second call still ran, so an hourly timer
   * would still be alive. A crashed timer is a silently disabled retention
   * policy, which looks exactly like a working one until somebody measures
   * the disk. */
})

/* A background cleanup that keeps the process alive turns "the agent will not
 * shut down" into a debugging session about audio files. */
test('the sweep timer never holds the process open', (t) => {
  const root = workspace(t)
  const before = (process.getActiveResourcesInfo?.() ?? []).filter(
    (name) => name === 'Timeout',
  ).length

  const stop = startAudioRetentionSweeper({ workspace: root })
  t.after(stop)

  const after = (process.getActiveResourcesInfo?.() ?? []).filter(
    (name) => name === 'Timeout',
  ).length
  assert.equal(after, before, 'neither the delay nor the interval is ref’d')
})

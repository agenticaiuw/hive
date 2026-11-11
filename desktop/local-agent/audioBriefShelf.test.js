/*
 * The briefing shelf's bounds.
 *
 * Separate file from audioBrief.test.js because that one is about the ENCODER —
 * it shells out to macOS `say` several times and asserts the wire format the
 * relay will forward. These tests are about the STORE, they must not spend
 * thirty seconds of speech synthesis to fill a shelf, and they write to a
 * workspace of their own.
 *
 * testWorkspace.js is imported FIRST and deliberately: audioBrief.js resolves
 * STORE_PATH from config.workspacePath at import time with no parameter to
 * point it elsewhere, and the agent app on :8000 is writing the owner's real
 * .pendant-briefings.json right now.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'

import './testWorkspace.js'

import {
  EVICTION_RANKS,
  MAX_EVICTION_RECORDS,
  MAX_SHELF_AUDIO_BYTES,
  MAX_SHELF_STORE_BYTES,
  MAX_STORED_BRIEFINGS,
  SHELF_STALE_AFTER_MS,
  briefingEvictions,
  briefingShelfStatus,
  briefingsLocation,
  deleteBriefing,
  evictionRankOf,
  fitShelf,
  listBriefings,
  markBriefingPlayed,
  saveBriefing,
  shelfAudioBytes,
  storeBytesOf,
} from './audioBrief.js'
import { AUDIO_RETENTION_DEFAULT_MAX_AGE_MS } from './audioRetention.js'

const { store: STORE_PATH, directory: BRIEFINGS } = briefingsLocation()

const HOUR_MS = 60 * 60 * 1000

function resetShelf() {
  fs.rmSync(STORE_PATH, { force: true })
  fs.rmSync(`${STORE_PATH}.bak`, { force: true })
  fs.rmSync(BRIEFINGS, { recursive: true, force: true })
  fs.mkdirSync(BRIEFINGS, { recursive: true })
}

/* A briefing's audio, at a real size, without invoking `say`. */
function writeAudio(basename, { wavBytes = 2_000_000, opusBytes = 80_000 } = {}) {
  fs.mkdirSync(BRIEFINGS, { recursive: true })
  const wavPath = path.join(BRIEFINGS, `${basename}.wav`)
  const opusPath = path.join(BRIEFINGS, `${basename}.opus`)
  fs.writeFileSync(wavPath, Buffer.alloc(wavBytes, 1))
  fs.writeFileSync(opusPath, Buffer.alloc(opusBytes, 2))
  return { wavPath, opusPath }
}

function row(overrides = {}) {
  return {
    id: `brf_${Math.random().toString(16).slice(2)}`,
    createdAt: new Date().toISOString(),
    played: false,
    playedAt: null,
    topic: 'A briefing',
    mode: 'schedule',
    seconds: 40,
    spoken: 'Good morning. Three meetings today.',
    ...overrides,
  }
}

/* ------------------------------------------------------ the reported defect */

test('an unplayed briefing is never evicted while a played one could go instead', () => {
  const heard = row({
    id: 'brf_heard',
    played: true,
    playedAt: new Date().toISOString(),
    createdAt: new Date(Date.now() - 60_000).toISOString(),
  })
  const unheard = row({ id: 'brf_unheard' })
  const incoming = row({ id: 'brf_new' })

  const fitted = fitShelf([incoming, unheard, heard], {
    protect: incoming,
    maxRows: 2,
  })

  assert.deepEqual(
    fitted.evict.map((entry) => entry.id),
    ['brf_heard'],
  )
  assert.deepEqual(
    fitted.keep.map((entry) => entry.id),
    ['brf_new', 'brf_unheard'],
  )
  assert.equal(fitted.tombstones[0].heard, true)
  assert.equal(fitted.tombstones[0].reason, 'played')
  assert.equal(fitted.tombstones[0].forcedBy, 'row-count')
})

test('the old slice-by-count is gone: a full shelf of unplayed rows still stores the new brief, and says what it dropped', () => {
  resetShelf()

  /* The owner's live shelf, in shape: fifty rows, every one unplayed, each
   * with real audio on disk. */
  const oldest = new Date(Date.now() - 90 * 60 * 1000).toISOString()
  for (let index = 0; index < MAX_STORED_BRIEFINGS; index += 1) {
    saveBriefing({
      topic: `Filler ${index}`,
      mode: 'schedule',
      spoken: 'x',
      ...writeAudio(`filler-${index}`, { wavBytes: 4096, opusBytes: 256 }),
      /* Spread over the last 90 minutes, oldest first, so "oldest unheard" is
       * unambiguous. */
      createdAt: new Date(
        Date.parse(oldest) + index * 60_000,
      ).toISOString(),
    })
  }

  let status = briefingShelfStatus()
  assert.equal(status.rows, MAX_STORED_BRIEFINGS)
  assert.equal(status.unplayed, MAX_STORED_BRIEFINGS)
  assert.equal(status.evicted.total, 0)

  const stored = saveBriefing({ topic: 'The new one', mode: 'schedule', spoken: 'y' })

  status = briefingShelfStatus()
  /* Stored, not refused. */
  assert.equal(status.rows, MAX_STORED_BRIEFINGS)
  assert.ok(listBriefings({ limit: 50 }).some((entry) => entry.id === stored.id))

  /* And the loss is on the record, named, dated and marked unheard. */
  assert.equal(status.evicted.total, 1)
  assert.equal(status.evicted.unheard, 1)
  const [stone] = status.evicted.recent
  assert.equal(stone.topic, 'Filler 0', 'the OLDEST unheard row is the one that goes')
  assert.equal(stone.heard, false)
  assert.equal(stone.reason, 'unheard')
  assert.equal(stone.forcedBy, 'row-count')
  assert.ok(Date.parse(stone.evictedAt) > 0)

  /* And its audio went with it — the row is not hiding megabytes on disk. */
  assert.equal(stone.audio, 'removed')
  assert.equal(stone.bytesFreed, 4096 + 256)
  assert.equal(fs.existsSync(path.join(BRIEFINGS, 'filler-0.wav')), false)
  assert.equal(fs.existsSync(path.join(BRIEFINGS, 'filler-1.wav')), true)
})

/* ------------------------------------------------------------ byte bounds */

test('the byte budget is verified against the file atomicJsonStore actually writes', () => {
  resetShelf()

  /* A budget small enough to bite without writing half a megabyte through
   * fsync forty times; the undercount this guards against is proportional, so
   * a small budget proves the same mechanism. */
  const maxStoreBytes = 8 * 1024
  const long = 'The quarterly summary continues at length. '.repeat(20)

  for (let index = 0; index < 40; index += 1) {
    saveBriefing(
      { topic: `Brief ${index}`, mode: 'research', spoken: long },
      { maxStoreBytes },
    )
  }

  const onDisk = fs.statSync(STORE_PATH).size
  assert.ok(
    onDisk <= maxStoreBytes,
    `the file on disk is ${onDisk} bytes against a ${maxStoreBytes} budget`,
  )

  /* The same number the module reports, so the report is not a second opinion. */
  const status = briefingShelfStatus()
  assert.equal(status.bytes.store, onDisk)
  assert.ok(status.evicted.total > 0, 'rows were shed to make it fit')
})

test('audio bytes are measured on disk and deduplicated by path', () => {
  resetShelf()
  /* The live shelf's exact shape: many rows, one file pair. Summing each row's
   * recorded pcmBytes said 95.5 MB; the disk said 1.99 MB. */
  const shared = writeAudio('shared-brief', { wavBytes: 1_912_894, opusBytes: 78_824 })
  const rows = Array.from({ length: 50 }, () =>
    row({ ...shared, pcmBytes: 1_908_798, opusBytes: 78_824 }),
  )

  const naive = rows.reduce((sum, entry) => sum + entry.pcmBytes + entry.opusBytes, 0)
  const real = shelfAudioBytes(rows)

  assert.equal(real, 1_912_894 + 78_824)
  assert.ok(naive > real * 40, `the proxy overstates by ${(naive / real).toFixed(0)}x`)
})

test('the shelf is bounded in audio bytes, not just rows', () => {
  resetShelf()

  /* Ten distinct 2 MB briefs against a 6 MB ceiling: the row count never comes
   * close to 50, so only the byte bound can stop this. */
  const maxAudioBytes = 6 * 1024 * 1024
  for (let index = 0; index < 10; index += 1) {
    const audio = writeAudio(`bulk-${index}`, { wavBytes: 2 * 1024 * 1024, opusBytes: 1024 })
    saveBriefing(
      { topic: `Bulk ${index}`, mode: 'research', spoken: 'x', ...audio },
      { maxAudioBytes },
    )
  }

  const status = briefingShelfStatus()
  assert.ok(status.rows < 10, `all ten rows survived a ${maxAudioBytes}-byte ceiling`)
  assert.ok(
    status.bytes.audio <= maxAudioBytes,
    `${status.bytes.audio} bytes of audio against a ${maxAudioBytes} ceiling`,
  )
  assert.equal(status.evicted.recent[0].forcedBy, 'audio-bytes')

  /* And the bytes are actually gone from the disk, not merely unreferenced. */
  const live = fs
    .readdirSync(BRIEFINGS)
    .filter((name) => name.endsWith('.wav'))
    .reduce((sum, name) => sum + fs.statSync(path.join(BRIEFINGS, name)).size, 0)
  assert.ok(live <= maxAudioBytes, `${live} bytes of .wav still on disk`)
})

test('the stated bounds are the ones enforced, in bytes', () => {
  assert.equal(MAX_SHELF_STORE_BYTES, 256 * 1024)
  assert.equal(MAX_SHELF_AUDIO_BYTES, 64 * 1024 * 1024)
  /* A quarter of audioRetention's whole-disk audio ceiling, so the shelf alone
   * can never be what blows it. */
  assert.equal(MAX_SHELF_AUDIO_BYTES * 4, 256 * 1024 * 1024)
})

/* -------------------------------------------------------- the audio on disk */

test('evicting a row removes its .wav and .opus but never its note', () => {
  resetShelf()

  const doomedAudio = writeAudio('doomed', { wavBytes: 4 * 1024 * 1024, opusBytes: 2048 })
  const notePath = path.join(BRIEFINGS, 'doomed.md')
  fs.writeFileSync(notePath, '# The readable half\n', 'utf8')

  const doomed = saveBriefing({
    topic: 'Doomed',
    mode: 'research',
    spoken: 'x',
    notePath,
    ...doomedAudio,
  })
  markBriefingPlayed(doomed.id)

  const keeper = writeAudio('keeper', { wavBytes: 1024, opusBytes: 256 })
  saveBriefing(
    { topic: 'Keeper', mode: 'research', spoken: 'x', ...keeper },
    { maxRows: 1 },
  )

  assert.equal(fs.existsSync(doomedAudio.wavPath), false, 'the .wav should be gone')
  assert.equal(fs.existsSync(doomedAudio.opusPath), false, 'the .opus should be gone')
  assert.equal(fs.existsSync(notePath), true, 'the note is text and must survive')
  assert.equal(fs.existsSync(keeper.wavPath), true)

  const stone = briefingEvictions().recent[0]
  assert.equal(stone.audio, 'removed')
  assert.equal(stone.bytesFreed, 4 * 1024 * 1024 + 2048)
  assert.equal(stone.notePath, notePath, 'the tombstone says where the note still is')
})

test('a file another row still points at is never removed with the row', () => {
  resetShelf()

  /* The live shelf: fifty rows, one file pair. Evicting one duplicate must not
   * destroy the recording the other forty-nine are for. */
  const shared = writeAudio('one-recording', { wavBytes: 1_912_894, opusBytes: 78_824 })
  const saved = []
  for (let index = 0; index < 6; index += 1) {
    saved.push(
      saveBriefing({ topic: `Copy ${index}`, mode: 'schedule', spoken: 'x', ...shared }),
    )
  }
  for (const entry of saved.slice(0, 5)) markBriefingPlayed(entry.id)

  saveBriefing(
    { topic: 'Something new', mode: 'schedule', spoken: 'x' },
    { maxRows: 2 },
  )

  assert.equal(
    fs.existsSync(shared.wavPath),
    true,
    'a surviving row still points at this recording',
  )
  assert.equal(fs.existsSync(shared.opusPath), true)

  const stones = briefingEvictions().recent
  assert.ok(stones.length >= 4)
  assert.ok(
    stones.every((stone) => stone.audio === 'shared'),
    'every eviction of a duplicate reports the file as still referenced',
  )
  assert.ok(
    stones.every((stone) => stone.bytesFreed === 0),
    'and claims to have freed nothing, because it freed nothing',
  )
})

test('deleteBriefing takes the audio with the row', () => {
  resetShelf()
  const audio = writeAudio('explicit-delete', { wavBytes: 65_536, opusBytes: 4096 })
  const saved = saveBriefing({ topic: 'Delete me', mode: 'research', spoken: 'x', ...audio })

  assert.equal(deleteBriefing(saved.id), true)
  assert.equal(fs.existsSync(audio.wavPath), false)
  assert.equal(fs.existsSync(audio.opusPath), false)
  assert.equal(deleteBriefing(saved.id), false)
})

test('eviction only unlinks .wav/.opus directly inside the Briefings directory', () => {
  resetShelf()
  const outsider = path.join(path.dirname(BRIEFINGS), 'not-a-briefing.wav')
  fs.writeFileSync(outsider, Buffer.alloc(1024))

  const trap = row({
    id: 'brf_trap',
    played: true,
    playedAt: new Date().toISOString(),
    wavPath: outsider,
    opusPath: path.join(BRIEFINGS, 'nothing.md'),
  })

  const fitted = fitShelf([row({ id: 'brf_keep' }), trap], {
    protect: null,
    maxRows: 1,
  })

  assert.deepEqual(fitted.evict.map((entry) => entry.id), ['brf_trap'])
  assert.deepEqual([...fitted.plan.values()][0].files, [])
  assert.equal(fs.existsSync(outsider), true, 'a path outside Briefings is never unlinked')
})

/* ----------------------------------------------------------------- ordering */

test('a row whose audio is already gone outranks a fresh unheard one for eviction', () => {
  resetShelf()
  const present = writeAudio('still-here', { wavBytes: 1024, opusBytes: 128 })
  const gone = {
    wavPath: path.join(BRIEFINGS, 'evaporated.wav'),
    opusPath: path.join(BRIEFINGS, 'evaporated.opus'),
  }

  assert.equal(evictionRankOf(row({ ...present })), 3)
  assert.equal(evictionRankOf(row({ ...gone })), 1)
  assert.equal(
    evictionRankOf(row({ played: true, playedAt: new Date().toISOString(), ...present })),
    0,
  )
})

test('the staleness threshold is audioRetention\'s own window for generated audio, not a number invented here', () => {
  assert.equal(SHELF_STALE_AFTER_MS, AUDIO_RETENTION_DEFAULT_MAX_AGE_MS.generated)
  assert.equal(SHELF_STALE_AFTER_MS, 48 * HOUR_MS)

  const now = Date.now()
  const audio = writeAudio('aged', { wavBytes: 512, opusBytes: 64 })
  const stale = row({ createdAt: new Date(now - 49 * HOUR_MS).toISOString(), ...audio })
  const fresh = row({ createdAt: new Date(now - 47 * HOUR_MS).toISOString(), ...audio })

  assert.equal(evictionRankOf(stale, { now }), 2)
  assert.equal(evictionRankOf(fresh, { now }), 3)
  assert.equal(EVICTION_RANKS[2], 'unheard-stale')
})

test('age alone never drops anything: a shelf inside its bounds keeps three-week-old unheard briefs', () => {
  resetShelf()
  const audio = writeAudio('ancient', { wavBytes: 1024, opusBytes: 128 })
  const saved = saveBriefing({
    topic: 'Three weeks ago',
    mode: 'research',
    spoken: 'x',
    createdAt: new Date(Date.now() - 21 * 24 * HOUR_MS).toISOString(),
    ...audio,
  })
  saveBriefing({ topic: 'Today', mode: 'schedule', spoken: 'x' })

  assert.ok(listBriefings({ limit: 10 }).some((entry) => entry.id === saved.id))
  assert.equal(briefingShelfStatus().evicted.total, 0)
})

/* ------------------------------------------------------------- the details */

test('a runaway spoken script is clipped rather than allowed to evict the shelf', () => {
  resetShelf()
  const first = saveBriefing({ topic: 'Ordinary', mode: 'schedule', spoken: 'x' })
  const huge = saveBriefing({
    topic: 'Runaway',
    mode: 'research',
    spoken: 'word '.repeat(40_000),
  })

  assert.equal(huge.spokenClipped, true)
  assert.equal(huge.spokenChars, 200_000)
  assert.ok(storeBytesOf(huge) <= 32 * 1024)
  assert.ok(
    listBriefings({ limit: 10 }).some((entry) => entry.id === first.id),
    'the ordinary row survived the runaway one',
  )
})

test('a legacy row bigger than the whole budget is clipped, not answered by emptying the shelf', () => {
  /* A row written before the per-row cap existed. Evicting neighbours can never
   * make room for it, so the loop would have run the shelf down to one row. */
  const legacy = row({ id: 'brf_legacy', spoken: 'word '.repeat(60_000) })
  const keepers = Array.from({ length: 4 }, (_, index) =>
    row({ id: `brf_keep_${index}` }),
  )

  const fitted = fitShelf([...keepers, legacy], { protect: null })

  assert.equal(fitted.evict.length, 0, 'nothing had to be evicted')
  assert.equal(fitted.overBudget, false)
  assert.ok(fitted.bytes.store <= MAX_SHELF_STORE_BYTES)
  const clipped = fitted.keep.find((entry) => entry.id === 'brf_legacy')
  assert.equal(clipped.spokenClipped, true)
  assert.equal(clipped.spokenChars, 300_000)
  assert.ok(storeBytesOf(clipped) <= 32 * 1024)
})

test('tombstones are capped but the counters are all-time', () => {
  resetShelf()
  for (let index = 0; index < MAX_EVICTION_RECORDS + 8; index += 1) {
    saveBriefing({ topic: `Row ${index}`, mode: 'schedule', spoken: 'x' }, { maxRows: 1 })
  }

  const evicted = briefingEvictions()
  assert.equal(evicted.recent.length, MAX_EVICTION_RECORDS)
  assert.equal(evicted.total, MAX_EVICTION_RECORDS + 7)
  assert.equal(evicted.unheard, MAX_EVICTION_RECORDS + 7)
})

test('the shelf survives a store written by audioRetention, which knows nothing about the eviction block', () => {
  resetShelf()
  saveBriefing({ topic: 'Before', mode: 'schedule', spoken: 'x' }, { maxRows: 1 })
  saveBriefing({ topic: 'After', mode: 'schedule', spoken: 'x' }, { maxRows: 1 })
  assert.equal(briefingEvictions().total, 1)

  /* audioRetention.pruneBriefingEntries writes `{ ...store, briefings: kept }`,
   * so the eviction block rides along. Simulate that shape exactly. */
  const raw = JSON.parse(fs.readFileSync(STORE_PATH, 'utf8'))
  fs.writeFileSync(
    STORE_PATH,
    JSON.stringify({ ...raw, briefings: [] }, null, 2),
    'utf8',
  )

  const status = briefingShelfStatus()
  assert.equal(status.rows, 0)
  assert.equal(status.evicted.total, 1, 'the record of what was dropped is not lost')
})

test('registerBriefingShelfRoutes mounts reads only, off the /research/briefings parameter route', async () => {
  const { registerBriefingShelfRoutes } = await import('./audioBrief.js')
  const mounted = []
  const app = {
    get: (routePath) => mounted.push(routePath),
    post: () => {
      throw new Error('the shelf report must not mount a write route')
    },
    delete: () => {
      throw new Error('the shelf report must not mount a delete route')
    },
  }

  const routes = registerBriefingShelfRoutes(app)
  assert.deepEqual(mounted, ['/briefings/shelf', '/briefings/shelf/evictions'])
  assert.equal(routes.length, 2)
  /* server.js owns GET /research/briefings/:id; a literal under it would be
   * swallowed by the parameter. */
  assert.ok(mounted.every((routePath) => !routePath.startsWith('/research/briefings')))
})

/*
 * One file for the whole contract: the fold and the budgets, both store
 * adapters, and the SQL running against a real SQLite.
 *
 * They are together on purpose. The interesting failures in this feature are
 * not inside any one of those layers, they are between them — a JS pruner that
 * evicts in one order and a SQL pruner that evicts in another, a fold that
 * resurrects a retracted fact only when the sweep has not run. A test file per
 * layer would pass all three while the feature is broken.
 *
 * D1 is SQLite, so d1Store's statements replay here verbatim apart from ?N -> ?,
 * which is the only dialect difference that touches them.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  appendFleetMemory,
  compareMemoryEventsByValue,
  DEFAULT_PROJECTION_BYTES,
  foldMemoryEvents,
  MAX_EVENT_BYTES,
  MEMORY_EVENT_TYPES,
  MEMORY_SURFACES,
  MEMORY_TTL_MS,
  normalizeMemoryEvent,
  normalizeMemoryEvents,
  projectFleetMemory,
  pruneFleetMemoryEvents,
  readFleetMemoryProjection,
} from './fleetMemory.js'
import { createD1Store } from '../cloud-relay/store/d1Store.js'
import { createMemoryStore } from '../cloud-relay/store/memoryStore.js'
import { loadFleetFromStore } from '../cloud-relay/fleetContext.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, '..', 'cloudflare-worker')

const NOW = Date.parse('2026-08-07T12:00:00.000Z')

let sequence = 0
const randomUUID = () => `test-${String(++sequence).padStart(4, '0')}`

function makeEvent(overrides = {}) {
  return normalizeMemoryEvent(
    { node: 'cloud-relay/realtime', value: 'a value', ...overrides },
    { now: overrides.now ?? NOW, randomUUID },
  )
}

const idsOf = (records) => [...records].map((record) => record.eventId).sort()

/* ---- the event ---------------------------------------------------------- */

test('an event without a key, a value, or a writer is refused', () => {
  assert.throws(() => makeEvent({ type: 'task', key: '' }), /needs a key/)
  assert.throws(() => makeEvent({ type: 'task', key: 'k', value: '' }), /needs a value/)
  assert.throws(() => makeEvent({ type: 'task', key: 'k', node: '' }), /node that wrote it/)
  assert.throws(() => makeEvent({ type: 'rumour', key: 'k' }), /type must be one of/)
})

/*
 * A surface list is the routing table for the fact. A typo does not mean "goes
 * somewhere unusual", it means "reaches nobody" — indistinguishable from a
 * write that never happened, which is the one failure a memory system cannot
 * afford to make quietly.
 */
test('an unknown surface is refused rather than carried', () => {
  assert.throws(
    () => makeEvent({ type: 'task', key: 'k', surfaces: ['watch'] }),
    /Unknown surface/,
  )
  assert.deepEqual(makeEvent({ type: 'task', key: 'k', surfaces: [] }).surfaces, [])
  assert.deepEqual(
    makeEvent({ type: 'task', key: 'k', surfaces: ['voice', 'mac'] }).surfaces,
    ['mac', 'voice'],
  )
})

test('each type carries its own lifetime, and a preference has none', () => {
  for (const type of MEMORY_EVENT_TYPES) {
    const record = makeEvent({ type, key: `${type}.k` })
    const ttl = MEMORY_TTL_MS[type]
    if (ttl === null) {
      assert.equal(record.expiresAt, null, `${type} should not expire`)
    } else {
      assert.equal(record.expiresAt, new Date(NOW + ttl).toISOString())
    }
  }
})

/*
 * The per-event ceiling is a byte budget, not a character cap, because the
 * envelope (provenance, surfaces, timestamps) is most of a short event and none
 * of a long one. The measured facts on this machine are 511 bytes at the median
 * with a 400-character value, so a 1 KB event has room for its provenance and
 * is still a fixed, known cost.
 */
test('a fat value is clipped until the whole record fits the byte budget', () => {
  const record = makeEvent({ type: 'entity', key: 'e', value: 'x'.repeat(20_000) })

  assert.ok(record.bytes <= MAX_EVENT_BYTES, `record was ${record.bytes} bytes`)
  assert.equal(record.clipped, true)
  assert.ok(record.value.endsWith('…'))
  // Clipped, not dropped: what it was about survives.
  assert.ok(record.value.length > 100)
})

test('one malformed event does not fail the batch, and says so', () => {
  const { events, rejected } = normalizeMemoryEvents(
    [
      { type: 'task', key: 'ship the audio path', value: 'in progress', node: 'mac' },
      { type: 'task', value: 'no key', node: 'mac' },
    ],
    { now: NOW, randomUUID },
  )

  assert.equal(events.length, 1)
  assert.deepEqual(rejected, [{ index: 1, reason: 'A memory event needs a key.' }])
})

test('a secret is classified on the way in, without being asked', () => {
  const record = makeEvent({
    type: 'entity',
    key: 'deploy.token',
    value: 'the token is ghp_abcdefghijklmnopqrstuvwxyz0123',
  })
  assert.equal(record.sensitivity, 'secret')
})

/* ---- the fold ----------------------------------------------------------- */

test('the newest write for a key wins, and older ones stop being read', () => {
  const older = makeEvent({ type: 'preference', key: 'editor', value: 'Vim' })
  const newer = makeEvent({
    type: 'preference',
    key: 'editor',
    value: 'VS Code',
    at: new Date(NOW + 1000).toISOString(),
  })

  const live = foldMemoryEvents([older, newer], { now: NOW + 2000 })
  assert.deepEqual(live.map((record) => record.value), ['VS Code'])
})

test('a retraction removes the key rather than adding a line about it', () => {
  const said = makeEvent({ type: 'entity', key: 'trip', value: 'in Seoul this week' })
  const unsaid = makeEvent({
    type: 'entity',
    key: 'trip',
    retract: true,
    at: new Date(NOW + 1000).toISOString(),
  })

  assert.deepEqual(foldMemoryEvents([said, unsaid], { now: NOW + 2000 }), [])
})

/*
 * The resurrection bug this whole ordering exists to prevent. A retraction
 * inherits its type's TTL, so it can expire while the value it cancelled is
 * still live. Filter expiry before folding and the retracted fact comes back —
 * silently, and confidently wrong.
 */
test('an expired retraction does not resurrect the fact it cancelled', () => {
  const said = makeEvent({
    type: 'preference',
    key: 'wake-word',
    value: 'always on',
  })
  const unsaid = makeEvent({
    type: 'preference',
    key: 'wake-word',
    retract: true,
    at: new Date(NOW + 1000).toISOString(),
    ttlMs: 60_000,
  })

  const wellAfter = NOW + 10 * 60_000
  assert.equal(foldMemoryEvents([said, unsaid], { now: wellAfter }).length, 0)
})

test('a surface only reads what was addressed to it, or to everyone', () => {
  const everyone = makeEvent({ type: 'preference', key: 'brief', value: 'be terse' })
  const macOnly = makeEvent({
    type: 'task',
    key: 'build',
    value: 'the release build is running',
    surfaces: ['mac'],
  })

  assert.equal(foldMemoryEvents([everyone, macOnly], { now: NOW, surface: 'voice' }).length, 1)
  assert.equal(foldMemoryEvents([everyone, macOnly], { now: NOW, surface: 'mac' }).length, 2)
})

/* ---- the pruner --------------------------------------------------------- */

test('the pruner reports what it dropped and why', () => {
  const superseded = makeEvent({ type: 'entity', key: 'k', value: 'old' })
  const current = makeEvent({
    type: 'entity',
    key: 'k',
    value: 'new',
    at: new Date(NOW + 1000).toISOString(),
  })
  const stale = makeEvent({ type: 'event', key: 'e', value: 'happened', ttlMs: 10 })

  const report = pruneFleetMemoryEvents([superseded, current, stale], {
    now: NOW + 60_000,
  })

  assert.deepEqual(idsOf(report.kept), [current.eventId])
  assert.deepEqual(report.stats.reasons, { superseded: 1, expired: 1 })
})

/*
 * The reason eviction is not newest-first. A preference is written once and
 * then never again, so it is permanently the oldest row in the log and
 * permanently the most valuable one; an age-ordered eviction deletes the
 * owner's standing choices to make room for an hour-old observation.
 */
test('byte pressure eats observations first and standing choices last', () => {
  const preference = makeEvent({ type: 'preference', key: 'p', value: 'be terse' })
  const observation = makeEvent({
    type: 'event',
    key: 'e',
    value: 'the browser went offline',
    at: new Date(NOW + 60_000).toISOString(),
  })

  const report = pruneFleetMemoryEvents([preference, observation], {
    now: NOW + 60_000,
    maxBytes: preference.bytes,
  })

  assert.deepEqual(idsOf(report.kept), [preference.eventId])
  assert.equal(report.stats.reasons.overflow, 1)
})

test('the value order is a total order, so two readers cannot disagree', () => {
  const records = MEMORY_EVENT_TYPES.map((type, index) =>
    makeEvent({
      type,
      key: `k${index}`,
      value: 'v',
      at: new Date(NOW + index).toISOString(),
    }),
  ).reverse()

  assert.deepEqual(
    [...records].sort(compareMemoryEventsByValue).map((record) => record.type),
    [...MEMORY_EVENT_TYPES],
  )
})

/* ---- the projection ----------------------------------------------------- */

function sampleLog() {
  return [
    makeEvent({ type: 'preference', key: 'preference.editor', value: 'VS Code' }),
    makeEvent({ type: 'preference', key: 'preference.brief', value: 'answer in one sentence' }),
    makeEvent({ type: 'task', key: 'audio', value: 'ship the 24 kHz audio path' }),
    makeEvent({
      type: 'entity',
      key: 'person.nico',
      value: 'Nico reviews the firmware changes',
      node: 'local-agent/mac',
    }),
    makeEvent({
      type: 'entity',
      key: 'file.notes',
      value: 'quarterly notes live in Documents',
      node: 'local-agent/mac',
    }),
    makeEvent({
      type: 'event',
      key: 'browser.offline',
      value: 'the browser extension stopped reporting',
      node: 'browser-extension',
    }),
  ]
}

test('the head is sorted by key, so it is byte-identical between turns', () => {
  const log = sampleLog()
  const first = projectFleetMemory({ events: log, task: 'what is Nico doing', now: NOW })
  const second = projectFleetMemory({ events: log, task: 'set the volume', now: NOW })

  const head = (text) => text.split('\n').slice(0, 3).join('\n')
  assert.equal(head(first.text), head(second.text))
  assert.match(first.text, /^## Owner\n- brief: answer in one sentence\n- editor: VS Code/)
})

test('the projection answers what was asked and leaves out what was not', () => {
  const projection = projectFleetMemory({
    events: sampleLog(),
    task: 'ask Nico about the firmware review',
    now: NOW,
    budgetBytes: 260,
  })

  assert.match(projection.text, /Nico reviews the firmware changes/)
  assert.ok(!projection.text.includes('quarterly notes'))
  assert.ok(projection.stats.bytes <= 260)
})

/*
 * Byte budgets, never item counts, and a share per section so an earlier
 * section cannot spend a later one's bytes. A growing preference list eating
 * the whole budget and starving the facts the request actually needs is the
 * documented failure in contextProjection.js; preferences lead the prompt here
 * for cache reasons, so without the share they would lead it right off a cliff.
 */
test('a long preference list cannot starve the section below it', () => {
  const noisy = Array.from({ length: 60 }, (_, index) =>
    makeEvent({
      type: 'preference',
      key: `preference.setting${String(index).padStart(2, '0')}`,
      value: `a standing choice, number ${index}`,
    }),
  )
  const task = makeEvent({ type: 'task', key: 'audio', value: 'ship the audio path' })

  const projection = projectFleetMemory({
    events: [...noisy, task],
    now: NOW,
    budgetBytes: DEFAULT_PROJECTION_BYTES,
  })

  assert.match(projection.text, /## Now\n- ship the audio path/)
  assert.ok(projection.stats.bytes <= DEFAULT_PROJECTION_BYTES)
  assert.ok(projection.stats.droppedForBudget > 0)
})

test('an event carries who said it and when; a keyed statement does not', () => {
  const projection = projectFleetMemory({ events: sampleLog(), now: NOW })

  assert.match(projection.text, /## Recent\n- the browser extension stopped reporting \[browser-extension 08-07 \d{2}:\d{2}\]/)
  assert.match(projection.text, /- ship the 24 kHz audio path$/m)
})

test('a secret never reaches the prompt in full, asked about or not', () => {
  const projection = projectFleetMemory({
    events: [
      makeEvent({
        type: 'entity',
        key: 'deploy.token',
        value: 'deploy token: ghp_abcdefghijklmnopqrstuvwxyz0123',
      }),
    ],
    task: 'what is the deploy token',
    now: NOW,
  })

  assert.ok(!projection.text.includes('ghp_abcdefghijklmnopqrstuvwxyz0123'))
})

test('a secret spoken as a sentence does not reach the prompt either', () => {
  /*
   * The test above uses a `key: value` line, which was the one shape
   * maskSecretValue handled. A secret the owner says out loud has no separator
   * in it, and that is the ordinary case for a worn pendant -- it went into the
   * fleet prompt in full with "[withheld]" appended after it.
   */
  const projection = projectFleetMemory({
    events: [
      makeEvent({
        type: 'entity',
        key: 'home.lock',
        value: 'my bike lock code is 4829',
      }),
      makeEvent({
        type: 'preference',
        key: 'home.wifi',
        value: 'the guest wifi password is hunter2',
      }),
    ],
    task: 'what is my bike lock code',
    now: NOW,
  })

  assert.ok(!projection.text.includes('4829'), 'a spoken code reached the prompt')
  assert.ok(!projection.text.includes('hunter2'), 'a spoken password reached the prompt')
  assert.match(projection.text, /\[withheld\]/)
})

test('the projection reports which events it shipped, and writes nothing', () => {
  const log = sampleLog()
  const projection = projectFleetMemory({ events: log, now: NOW })

  assert.equal(projection.eventIds.length, projection.stats.included)
  assert.ok(projection.eventIds.every((id) => log.some((event) => event.eventId === id)))
})

/* ---- the migration accommodation ---------------------------------------- */

/*
 * The Mac still PUTs a pre-rendered projection through fleet state. Emitting it
 * beside this one would pay twice for one idea; merging it under one budget is
 * what makes the rewire safe to land before local-agent/bridge.js is changed.
 */
test('a projection from another body merges into these sections, once', () => {
  const projection = projectFleetMemory({
    events: sampleLog(),
    now: NOW,
    inheritedText: [
      '## Owner',
      '- editor: VS Code',
      '- shell: zsh',
      '## Web',
      '- the status page says degraded [status.example 08-06]',
    ].join('\n'),
  })

  // One heading per section, never two.
  assert.deepEqual(projection.text.match(/^## Owner$/gm), ['## Owner'])
  // A fact both bodies know is paid for once.
  assert.deepEqual(projection.text.match(/- editor: VS Code/g), ['- editor: VS Code'])
  // A fact only the other body knows still crosses.
  assert.match(projection.text, /- shell: zsh/)
  // Including under a heading this module has no type for.
  assert.match(projection.text, /## Web\n- the status page says degraded/)
})

test('an inherited block cannot push the projection past its budget', () => {
  const projection = projectFleetMemory({
    events: sampleLog(),
    now: NOW,
    budgetBytes: 300,
    inheritedText: `## Owner\n${'- a long remembered line\n'.repeat(200)}`,
  })

  assert.ok(projection.stats.bytes <= 300, `was ${projection.stats.bytes}`)
})

/* ---- the store adapters ------------------------------------------------- */

/*
 * A real SQLite standing in for D1 rather than a hand-written fake. The fake
 * used by contextStore.test.js can prove the bind order and nothing else; the
 * statements here carry a correlated compaction delete and two window
 * functions, and the first place a mistake in those would otherwise show up is
 * production, on the owner's own facts.
 */
function d1FromSqlite(db) {
  return {
    prepare(sql) {
      // node:sqlite binds positionally and rejects ?N. Every statement in
      // d1Store numbers its parameters in ascending order exactly once, which
      // is what makes this rewrite safe; assert it rather than assume it.
      const numbers = [...sql.matchAll(/\?(\d+)/g)].map((match) => Number(match[1]))
      numbers.forEach((value, index) => {
        assert.equal(value, index + 1, `parameters must ascend 1..N in: ${sql}`)
      })
      const statement = db.prepare(sql.replace(/\?\d+/g, '?'))
      let values = []

      return {
        bind(...next) {
          values = next
          return this
        },
        async run() {
          const result = statement.run(...values)
          return { meta: { changes: Number(result.changes || 0) } }
        },
        async all() {
          return { results: statement.all(...values).map((row) => ({ ...row })) }
        },
        async first() {
          const row = statement.get(...values)
          return row ? { ...row } : null
        },
      }
    },
  }
}

function migratedD1() {
  const db = new DatabaseSync(':memory:')
  db.exec(fs.readFileSync(path.join(WORKER, 'schema.sql'), 'utf8'))
  db.exec(fs.readFileSync(path.join(WORKER, 'fleet-memory-migration.sql'), 'utf8'))
  return { db, store: createD1Store(d1FromSqlite(db)) }
}

/*
 * A store per call, which is now what createMemoryStore() means.
 *
 * This helper used to scrub the log with `pruneMemoryEvents({ maxBytes: 0 })`
 * before every case, because memoryStore.js declared its maps at MODULE scope
 * and every "new" store was a façade over one shared set. The scrub was the
 * bug's receipt: a test that has to erase the world before it starts is a test
 * telling you the world is shared. The isolation test below is what replaced
 * it.
 */
async function freshMemoryStore() {
  return createMemoryStore()
}

/*
 * Two stores are two stores.
 *
 * memoryStore.js declared `jobs`, `states`, `memoryEvents` and eight more maps
 * at module scope, so `createMemoryStore()` returned a new façade over one
 * shared set of them. Production never noticed — store/index.js memoizes a
 * single store per isolate — but the shape was a cross-tenant leak waiting for
 * the first relay that holds two stores at once, and the memory log is the
 * worst table for that to happen to: it is the one designed to be pasted into
 * a prompt.
 *
 * It also made the tests lie to each other. Before the fix, the second
 * assertion below returned the row written to `left`.
 */
test('two stores do not share one log, or one anything else', async () => {
  const left = createMemoryStore()
  const right = createMemoryStore()

  await left.appendMemoryEvents([
    makeEvent({ type: 'preference', key: 'editor', value: 'VS Code' }),
  ])

  assert.deepEqual(await right.listMemoryEvents({ now: NOW }), [])
  assert.equal((await left.listMemoryEvents({ now: NOW })).length, 1)

  // Memory was the loudest case, not the only one: every map moved.
  await left.saveState('fleet', { mac: { online: true } })
  await left.createJob({ jobId: 'job-1', type: 'plan', status: 'queued', createdAt: new Date(NOW).toISOString(), updatedAt: new Date(NOW).toISOString() })
  await left.saveDevice({ deviceId: 'pendant-1' })

  assert.equal(await right.getState('fleet'), null)
  assert.deepEqual(await right.listJobs({}), [])
  assert.deepEqual(await right.listDevices(), [])
})

/*
 * The table was applied to the live database by hand and never written into
 * schema.sql, so the file that describes the database could not rebuild it.
 * The migration stays — it is what an EXISTING database runs — but a fresh one
 * must come out of schema.sql alone, and the two must agree column for column.
 */
test('schema.sql alone builds the memory table, identically to the migration', () => {
  const columnsOf = (sqlFiles) => {
    const db = new DatabaseSync(':memory:')
    for (const file of sqlFiles) db.exec(fs.readFileSync(path.join(WORKER, file), 'utf8'))
    return db
      .prepare('PRAGMA table_info(relay_memory_events)')
      .all()
      .map((row) => `${row.name} ${row.type} ${row.notnull} ${row.dflt_value ?? ''}`)
  }

  const fromSchema = columnsOf(['schema.sql'])
  assert.ok(fromSchema.length > 0, 'schema.sql must create relay_memory_events')
  assert.deepEqual(fromSchema, columnsOf(['fleet-memory-migration.sql']))

  const indexes = new DatabaseSync(':memory:')
  indexes.exec(fs.readFileSync(path.join(WORKER, 'schema.sql'), 'utf8'))
  assert.deepEqual(
    indexes
      .prepare("SELECT name FROM sqlite_master WHERE type='index' AND tbl_name='relay_memory_events' AND name NOT LIKE 'sqlite_%' ORDER BY name")
      .all()
      .map((row) => row.name),
    ['relay_memory_events_expiry', 'relay_memory_events_fold', 'relay_memory_events_value'],
  )
})

test('the migration applies on top of the schema, and applies twice', () => {
  const { db } = migratedD1()
  db.exec(fs.readFileSync(path.join(WORKER, 'fleet-memory-migration.sql'), 'utf8'))

  const columns = db
    .prepare('PRAGMA table_info(relay_memory_events)')
    .all()
    .map((row) => row.name)

  assert.deepEqual(columns, [
    'event_id',
    'type',
    'fact_key',
    'node',
    'surfaces',
    'at',
    'expires_at',
    'bytes',
    'data',
  ])
})

test('the compaction delete uses the fold index, not a table scan', () => {
  const { db } = migratedD1()
  const plan = db
    .prepare(
      `EXPLAIN QUERY PLAN
       DELETE FROM relay_memory_events
        WHERE EXISTS (
          SELECT 1 FROM relay_memory_events AS newer
           WHERE newer.type = relay_memory_events.type
             AND newer.fact_key = relay_memory_events.fact_key
             AND (newer.at > relay_memory_events.at
                  OR (newer.at = relay_memory_events.at
                      AND newer.event_id > relay_memory_events.event_id)))`,
    )
    .all()

  assert.ok(
    JSON.stringify(plan).includes('relay_memory_events_fold'),
    `compaction should use the fold index, plan was ${JSON.stringify(plan)}`,
  )
})

for (const [name, make] of [
  ['memory', freshMemoryStore],
  ['d1', async () => migratedD1().store],
]) {
  test(`${name}: events round-trip and a resend is not a second copy`, async () => {
    const store = await make()
    const events = [
      makeEvent({ type: 'preference', key: 'editor', value: 'VS Code' }),
      makeEvent({ type: 'task', key: 'audio', value: 'ship the audio path' }),
    ]

    await store.appendMemoryEvents(events)
    await store.appendMemoryEvents(events)

    const loaded = await store.listMemoryEvents({ now: NOW })
    assert.deepEqual(idsOf(loaded), idsOf(events))
    assert.equal(loaded[0].type, 'preference')
    assert.equal(loaded[0].value, 'VS Code')
  })

  /*
   * The write-loss regression, pinned in both stores.
   *
   * `appendMemoryEvents` used to call its post-append sweep with no argument,
   * so the sweep ran on the wall clock while the events it had just written
   * carried the caller's. An event stamped more than one TTL behind real time
   * was deleted by the very call that created it — and the call still returned
   * `appended: 1`. A silent write-loss that reports success is the worst
   * failure a memory system can have, and the only place it was ever visible
   * was the sweep report's `reasons: {expired: 1}`, so both are asserted.
   *
   * This was NOT previously pinned: the existing round-trip cases all append
   * with events stamped near real time, so the bug would have gone unnoticed
   * until a replay, a backfill, or a device with a skewed clock.
   */
  test(`${name}: an append on the caller's clock does not expire what it just wrote`, async () => {
    const store = await make()
    const longAgo = NOW - 30 * 24 * 60 * 60 * 1000 // many `event` TTLs back

    const { status, body } = await appendFleetMemory(
      store,
      {
        node: 'browser-extension',
        events: [{ type: 'event', key: 'printer', value: 'the printer was out of paper' }],
      },
      { now: longAgo, randomUUID },
    )

    assert.equal(status, 201)
    assert.equal(body.appended, 1)
    assert.equal(body.log?.reasons?.expired ?? 0, 0, 'the write reported success; nothing may have expired')
    assert.equal(
      (await store.listMemoryEvents({ now: longAgo })).length,
      1,
      'the event the append reported writing must exist',
    )
  })

  test(`${name}: an expired event is unreadable before any sweep has run`, async () => {
    const store = await make()
    const live = makeEvent({ type: 'preference', key: 'p', value: 'live' })
    const stale = makeEvent({ type: 'event', key: 'e', value: 'stale', ttlMs: 1000 })

    await store.appendMemoryEvents([live, stale])

    const loaded = await store.listMemoryEvents({ now: NOW + 60_000 })
    assert.deepEqual(idsOf(loaded), [live.eventId])
  })

  test(`${name}: an append compacts the key it overwrites`, async () => {
    const store = await make()
    const older = makeEvent({ type: 'preference', key: 'editor', value: 'Vim' })
    const newer = makeEvent({
      type: 'preference',
      key: 'editor',
      value: 'VS Code',
      at: new Date(NOW + 1000).toISOString(),
    })

    await store.appendMemoryEvents([older])
    await store.appendMemoryEvents([newer])

    const loaded = await store.listMemoryEvents({ now: NOW + 2000 })
    assert.deepEqual(idsOf(loaded), [newer.eventId])
  })

  test(`${name}: the log is capped in bytes, and keeps the valuable end`, async () => {
    const store = await make()
    const preference = makeEvent({ type: 'preference', key: 'p', value: 'be terse' })
    const noise = Array.from({ length: 20 }, (_, index) =>
      makeEvent({
        type: 'event',
        key: `noise.${index}`,
        value: `something happened ${index}`,
        at: new Date(NOW + index).toISOString(),
      }),
    )

    await store.appendMemoryEvents([preference, ...noise])
    await store.pruneMemoryEvents({ now: NOW + 1000, maxBytes: preference.bytes * 3 })

    const loaded = await store.listMemoryEvents({ now: NOW + 1000 })
    assert.ok(loaded.length < 21, 'the byte ceiling should have bound')
    assert.ok(loaded.some((record) => record.eventId === preference.eventId))
  })
}

/*
 * The cross-check the rest of this file exists to make possible: the JS pruner
 * and the SQL pruner, over the same log, must keep the same rows. They are
 * separate implementations of one policy, and they only diverge once a log is
 * full — which is the worst moment to discover it.
 */
test('both stores prune to exactly the same set', async () => {
  const log = []
  for (let index = 0; index < 24; index += 1) {
    const type = MEMORY_EVENT_TYPES[index % MEMORY_EVENT_TYPES.length]
    log.push(
      makeEvent({
        type,
        // Every fourth event overwrites an earlier key, so supersession is in play.
        key: `${type}.${index % 4 === 0 ? 'shared' : index}`,
        value: `value number ${index}`,
        at: new Date(NOW + index * 1000).toISOString(),
        ...(index % 7 === 0 ? { ttlMs: 500 } : {}),
      }),
    )
  }

  const maxBytes = log[0].bytes * 6
  const now = NOW + 30_000

  const memory = await freshMemoryStore()
  await memory.appendMemoryEvents(log)
  await memory.pruneMemoryEvents({ now, maxBytes })

  const { store: d1 } = migratedD1()
  await d1.appendMemoryEvents(log)
  await d1.pruneMemoryEvents({ now, maxBytes })

  const fromMemory = idsOf(await memory.listMemoryEvents({ now }))
  const fromD1 = idsOf(await d1.listMemoryEvents({ now }))

  assert.ok(fromMemory.length > 0, 'the fixture should leave something alive')
  assert.ok(fromMemory.length < log.length, 'the fixture should force eviction')
  assert.deepEqual(fromD1, fromMemory)
})

/*
 * Compaction has to run before expiry, in SQL as in the fold. A retraction
 * inherits its type's TTL; delete expired rows first and the tombstone is gone
 * before it has suppressed anything.
 */
test('d1: an expired retraction still buries the value it cancelled', async () => {
  const { store } = migratedD1()
  const said = makeEvent({ type: 'preference', key: 'wake-word', value: 'always on' })
  const unsaid = makeEvent({
    type: 'preference',
    key: 'wake-word',
    retract: true,
    at: new Date(NOW + 1000).toISOString(),
    ttlMs: 60_000,
  })

  await store.appendMemoryEvents([said])
  await store.appendMemoryEvents([unsaid])
  await store.pruneMemoryEvents({ now: NOW + 10 * 60_000 })

  const loaded = await store.listMemoryEvents({ now: NOW + 10 * 60_000 })
  assert.deepEqual(loaded, [])
})

/* ---- the operations ----------------------------------------------------- */

test('appending stamps the writing node onto every event in the batch', async () => {
  const store = await freshMemoryStore()
  const { status, body } = await appendFleetMemory(
    store,
    {
      node: 'browser-extension',
      events: [
        { type: 'event', key: 'tab', value: 'the owner opened the status page' },
        { type: 'event', value: 'no key here' },
      ],
    },
    { now: NOW, randomUUID },
  )

  assert.equal(status, 201)
  assert.equal(body.appended, 1)
  assert.equal(body.rejected.length, 1)
  const loaded = await store.listMemoryEvents({ now: NOW })
  assert.equal(loaded[0].node, 'browser-extension')
})

test('a batch with no node, and a store that cannot hold memory, both refuse', async () => {
  const store = await freshMemoryStore()
  assert.equal((await appendFleetMemory(store, { events: [] })).status, 400)
  assert.equal(
    (await appendFleetMemory({}, { node: 'x', events: [{ type: 'event', key: 'k', value: 'v' }] }))
      .status,
    503,
  )
  assert.equal((await readFleetMemoryProjection({}, {})).status, 503)
})

test('a projection read is bounded however large the request asks for', async () => {
  const store = await freshMemoryStore()
  await store.appendMemoryEvents(sampleLog())

  const { status, body } = await readFleetMemoryProjection(
    store,
    { surface: 'voice', task: 'firmware review', budgetBytes: 10_000_000 },
    { now: NOW },
  )

  assert.equal(status, 200)
  assert.equal(body.surface, 'voice')
  assert.ok(body.stats.budgetBytes <= 2000)
  assert.ok(body.stats.bytes <= body.stats.budgetBytes)
})

test('an unknown surface reads as the default rather than as nothing', async () => {
  const store = await freshMemoryStore()
  await store.appendMemoryEvents(sampleLog())

  const { body } = await readFleetMemoryProjection(store, { surface: 'watch' }, { now: NOW })
  assert.equal(body.surface, 'voice')
  assert.ok(MEMORY_SURFACES.includes(body.surface))
})

/* ---- the rewire --------------------------------------------------------- */

function fleetStore(overrides = {}) {
  return {
    async getState(key) {
      if (key !== 'fleet') return null
      return {
        data: {
          version: 1,
          updatedAt: new Date(NOW).toISOString(),
          mac: { online: true, hostname: 'home', applications: ['Safari'] },
          memory: overrides.memoryText ? { text: overrides.memoryText } : {},
        },
      }
    },
    ...overrides.store,
  }
}

test('the relay prompt now carries memory written by another body', async () => {
  const store = await freshMemoryStore()
  await store.appendMemoryEvents([
    makeEvent({
      type: 'preference',
      key: 'brief',
      value: 'answer in one sentence',
      node: 'cloud-relay/realtime',
    }),
  ])

  const fleet = await loadFleetFromStore(
    { ...fleetStore(), listMemoryEvents: store.listMemoryEvents },
    { surface: 'voice', now: NOW },
  )

  assert.match(fleet.memory.text, /## Owner\n- brief: answer in one sentence/)
  assert.equal(fleet.memory.text.length <= 2000, true)
  assert.equal(fleet.memoryProjection.included, 1)
})

test('the Mac block survives the rewire when the log is empty', async () => {
  const store = await freshMemoryStore()
  const fleet = await loadFleetFromStore(
    {
      ...fleetStore({ memoryText: '## Owner\n- editor: VS Code' }),
      listMemoryEvents: store.listMemoryEvents,
    },
    { now: NOW },
  )

  assert.match(fleet.memory.text, /- editor: VS Code/)
})

test('a store with no memory tables costs the projection and nothing else', async () => {
  const fleet = await loadFleetFromStore(
    fleetStore({ memoryText: '## Owner\n- editor: VS Code' }),
    { now: NOW },
  )

  assert.equal(fleet.mac.hostname, 'home')
  assert.match(fleet.memory.text, /- editor: VS Code/)
})

test('a memory read that throws does not cost the fleet snapshot', async () => {
  const fleet = await loadFleetFromStore(
    {
      ...fleetStore(),
      async listMemoryEvents() {
        throw new Error('D1 is unreachable')
      },
    },
    { now: NOW },
  )

  assert.equal(fleet.mac.hostname, 'home')
})

/*
 * The first end-to-end path through cross-surface memory: the owner says
 * something, the relay writes a typed event, and the next conversation's prompt
 * carries it.
 *
 * The extractor and the round trip are in one file on purpose. An extractor
 * test alone proves a regex; a store test alone proves SQL. What was actually
 * broken before this was neither — it was that nothing connected them, so the
 * relay folded an empty log into every prompt and reported no error at all.
 * The tests that matter here are the ones that fail if that wire is cut again.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { DatabaseSync } from 'node:sqlite'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  createSpokenMemoryWriter,
  extractSpokenMemory,
  MAX_SESSION_BYTES,
  MAX_UTTERANCE_BYTES,
  SPOKEN_MEMORY_NODE,
  SPOKEN_RETRACTION_TTL_MS,
  stripLeadIn,
} from './spokenMemory.js'
import { MEMORY_TTL_MS } from './fleetMemory.js'
import { createD1Store } from '../cloud-relay/store/d1Store.js'
import { createMemoryStore } from '../cloud-relay/store/memoryStore.js'
import { loadFleetFromStore } from '../cloud-relay/fleetContext.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const WORKER = path.join(HERE, '..', 'cloudflare-worker')

const NOW = Date.parse('2026-08-07T12:00:00.000Z')

/* Synthetic throughout. Nothing in this file is a real credential. */
const FAKE_TOKEN = 'ghp_000000000000000000000000000000000000'

const only = (utterance, options = {}) => {
  const { events, skipped } = extractSpokenMemory(utterance, { now: NOW, ...options })
  assert.equal(events.length, 1, `expected one event, got ${JSON.stringify({ events, skipped })}`)
  return events[0]
}

const nothing = (utterance, options = {}) =>
  extractSpokenMemory(utterance, { now: NOW, ...options })

/* ---- what counts as a stated fact ---------------------------------------- */

test('a named fact keeps its subject, so masking leaves a usable label', () => {
  const event = only("remember that my sister's name is Mei")

  assert.equal(event.type, 'entity')
  assert.equal(event.key, 'owner.sister-s-name')
  assert.equal(event.value, "sister's name: Mei")
  // The owner said it themselves; the projection hedges anything below 0.5.
  assert.equal(event.confidence, 1)
})

test('a standing instruction is a preference, not an observation', () => {
  const event = only('from now on answer in one sentence')

  assert.equal(event.type, 'preference')
  assert.equal(event.value, 'answer in one sentence')
  // A preference has no TTL, which is exactly why the shapes that produce one
  // are narrow.
  assert.equal(MEMORY_TTL_MS.preference, null)
})

/*
 * Two standing instructions about the same topic are one preference changed,
 * not two held. Preferences never expire, so a key that separated them would
 * put both in every prompt for the life of the log.
 */
test('restating a standing instruction lands on the same key', () => {
  assert.equal(
    only('from now on answer in one sentence').key,
    only('from now on answer in one line, please').key,
  )
  assert.notEqual(
    only('from now on answer in one sentence').key,
    only('always ask before you send anything').key,
  )
})

test('a lead-in wrapping a standing instruction is still a standing instruction', () => {
  assert.equal(only('remember that from now on I want short answers').type, 'preference')
})

/*
 * The bias is precision, not recall. A wrong fact is paid for on every future
 * turn and is confidently wrong; a missed one costs the owner one sentence.
 */
test('ordinary conversation is not filed as memory', () => {
  for (const utterance of [
    'what time is it',
    'you always do that',
    'I never get the notification',
    'turn the volume down',
    'my flight was late and the printer is out of paper',
    '',
  ]) {
    const { events, skipped } = nothing(utterance)
    assert.equal(events.length, 0, `should not have remembered: ${utterance}`)
    assert.ok(skipped.length > 0, `a decline must say why: ${utterance}`)
  }
})

test('the lead-in vocabulary strips longest-first', () => {
  // "save this idea for later" must not be clipped by "save this".
  assert.equal(stripLeadIn('save this idea for later: call the vet'), 'call the vet')
  assert.equal(stripLeadIn('remember: the spare key is under the mat'), 'the spare key is under the mat')
})

/* ---- the bounds ---------------------------------------------------------- */

/*
 * Bounded in BYTES, and refused whole rather than truncated. A transcript this
 * long is a transcription fault, and the first 600 bytes of a fault is still a
 * fault — stored, it becomes a confident memory of nothing.
 */
test('an oversized utterance is refused in bytes, not clipped', () => {
  const runaway = `remember that my note is ${'ありがとう '.repeat(60)}`
  assert.ok(runaway.length < MAX_UTTERANCE_BYTES, 'the character count must be under the cap')
  assert.ok(Buffer.byteLength(runaway) > MAX_UTTERANCE_BYTES, 'the byte count must be over it')

  const { events, skipped } = nothing(runaway)
  assert.equal(events.length, 0)
  assert.match(skipped[0].reason, /byte budget/)
})

/*
 * The asymmetry with local-agent/quickCapture.js, on purpose. That module puts
 * a spoken passcode in one 0600 file on the owner's own machine. This log lives
 * off-device, is replicated by the platform, and is read into a third-party
 * prompt every turn.
 */
test('a spoken secret does not go on the fleet wire, and the refusal carries no value', () => {
  const { events, skipped } = nothing(`remember that my deploy token is ${FAKE_TOKEN}`)

  assert.equal(events.length, 0)
  assert.equal(skipped[0].sensitivity, 'secret')
  assert.ok(!JSON.stringify(skipped).includes(FAKE_TOKEN), 'the refusal must not repeat the secret')
  // The subject still travels, so an operator can see WHICH fact was refused.
  assert.match(skipped[0].key, /deploy-token/)
})

test("a personal detail is allowed, because the projection already withholds it", () => {
  const event = only('remember that my number is 555 867 5309')
  assert.equal(event.sensitivity, 'sensitive')
})

test('a body with its own store can raise the ceiling without editing the module', () => {
  const event = only(`remember that my deploy token is ${FAKE_TOKEN}`, {
    maxSensitivity: 'secret',
  })
  assert.equal(event.sensitivity, 'secret')
})

/* ---- deletion ------------------------------------------------------------ */

/*
 * A durable personal store that can be written to and not erased is the one
 * shape this must never have. "Forget X" has to work whether the fact was
 * filed as a named entity or as a standing preference, because the owner
 * cannot be expected to remember which shape they used.
 */
test('forget writes a tombstone in both namespaces, with a bounded lifetime', () => {
  const { events } = extractSpokenMemory("forget my sister's name", { now: NOW })

  assert.deepEqual(
    events.map((event) => `${event.type} ${event.key}`).sort(),
    ['entity owner.sister-s-name', 'preference preference.sister-s-name'],
  )
  for (const event of events) {
    assert.equal(event.retract, true)
    /* Not the preference TTL, which is "never": a permanent tombstone in the
     * tier that evicts LAST is a leak pointed at the most valuable rows. */
    assert.equal(event.ttlMs, SPOKEN_RETRACTION_TTL_MS)
    assert.ok(Number.isFinite(event.ttlMs))
  }
})

test('forget also understands the phrasing people actually use', () => {
  for (const utterance of [
    'forget what I said about the spare key',
    'please forget my address',
    'delete my address',
  ]) {
    assert.ok(
      extractSpokenMemory(utterance, { now: NOW }).events.length === 2,
      `should have retracted: ${utterance}`,
    )
  }
})

/* ---- the writer ---------------------------------------------------------- */

function d1FromSqlite(db) {
  return {
    prepare(sql) {
      const statement = db.prepare(sql.replace(/\?\d+/g, '?'))
      let values = []
      return {
        bind(...next) {
          values = next
          return this
        },
        async run() {
          return { meta: { changes: Number(statement.run(...values).changes || 0) } }
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
  // schema.sql alone, with no migration file: the whole point of writing the
  // table down is that a database can be rebuilt from it.
  db.exec(fs.readFileSync(path.join(WORKER, 'schema.sql'), 'utf8'))
  return createD1Store(d1FromSqlite(db))
}

const writerFor = (store, overrides = {}) =>
  createSpokenMemoryWriter({ store, now: () => NOW, ...overrides })

test('the writer stamps the surface that heard it', async () => {
  const store = createMemoryStore()
  const result = await writerFor(store).remember('remember that my desk is by the window')

  assert.equal(result.appended, 1)
  const [record] = await store.listMemoryEvents({ now: NOW })
  assert.equal(record.node, SPOKEN_MEMORY_NODE)
})

/*
 * fleetMemory caps the whole log at MAX_LOG_BYTES, but preferences evict LAST —
 * so one talkative session emitting standing choices could crowd out every
 * other body's facts while the log stayed perfectly within its budget. The
 * budget that stops that has to be per conversation, and it has to be bytes.
 */
test('one conversation cannot spend more than its byte budget', async () => {
  const store = createMemoryStore()
  const writer = writerFor(store, { budgetBytes: 400 })

  let refusals = 0
  for (let index = 0; index < 40; index += 1) {
    const result = await writer.remember(`remember that my item ${index} is a thing worth keeping`)
    if (!result.appended) refusals += 1
  }

  const stats = writer.stats()
  assert.ok(refusals > 0, 'the budget must actually bind')
  assert.ok(stats.bytes <= 400 + 1024, `spent ${stats.bytes} B`) // one event may straddle the line
  assert.equal(stats.remainingBytes, 0)
  assert.ok(stats.appended < 40)
})

/*
 * Called from the audio turn boundary, where an unhandled rejection ends the
 * owner's conversation. Losing a fact is survivable; losing the call is not.
 */
test('a store that cannot hold memory costs the fact and nothing else', async () => {
  const exploding = {
    async appendMemoryEvents() {
      throw new Error('D1_ERROR: no such table: relay_memory_events')
    },
  }

  const result = await writerFor(exploding).remember('remember that my desk is by the window')
  assert.equal(result.ok, false)
  assert.equal(result.appended, 0)
  assert.match(result.error, /relay_memory_events/)
})

test('a store with no memory support at all is refused, not crashed into', async () => {
  const result = await writerFor({}).remember('remember that my desk is by the window')
  assert.equal(result.ok, false)
  assert.equal(result.appended, 0)
})

/* ---- end to end ---------------------------------------------------------- */

/*
 * The relay's real reader. loadFleetFromStore() is what cloud-relay/server.js
 * and pendantConverse.js call to build the voice prompt; nothing here is a
 * stand-in for it.
 */
function fleetStore(store, memoryText = null) {
  return {
    ...store,
    async getState(key) {
      if (key !== 'fleet') return null
      return {
        data: {
          version: 1,
          updatedAt: new Date(NOW).toISOString(),
          mac: { online: true, hostname: 'home' },
          memory: memoryText ? { text: memoryText } : {},
        },
      }
    },
  }
}

test('a fact said out loud reaches the next conversation prompt', async () => {
  const store = createMemoryStore()

  // Turn one: the owner says it.
  const written = await writerFor(store).remember("remember that my sister's name is Mei")
  assert.equal(written.appended, 1)

  // The next conversation builds its prompt the way the relay does.
  const fleet = await loadFleetFromStore(fleetStore(store), {
    surface: 'voice',
    now: NOW + 60_000,
  })

  assert.match(fleet.memory.text, /sister's name: Mei/)
  assert.equal(fleet.memoryProjection.included, 1)
  assert.ok(fleet.memoryProjection.bytes <= fleet.memoryProjection.budgetBytes)
})

test('a standing instruction reaches the prompt as a standing instruction', async () => {
  const store = createMemoryStore()
  await writerFor(store).remember('from now on answer in one sentence')

  const fleet = await loadFleetFromStore(fleetStore(store), { now: NOW + 60_000 })

  // Under the heading that leads the block and is sorted by key, so a provider
  // prompt cache stays warm between turns.
  assert.match(fleet.memory.text, /^## Owner\n- answer-in-one: answer in one sentence/)
})

test('forget removes it from the prompt on the very next turn', async () => {
  const store = createMemoryStore()
  const writer = writerFor(store)

  await writer.remember("remember that my sister's name is Mei")
  const before = await loadFleetFromStore(fleetStore(store), { now: NOW + 1000 })
  assert.match(before.memory.text, /Mei/)

  await createSpokenMemoryWriter({ store, now: () => NOW + 2000 }).remember(
    "forget my sister's name",
  )

  const after = await loadFleetFromStore(fleetStore(store), { now: NOW + 3000 })
  // Nothing left to project, so the prompt carries no memory block at all —
  // not an emptied one, and not a stale one.
  assert.ok(!String(after.memory.text ?? '').includes('Mei'), `still present: ${after.memory.text}`)
  /* The value row is gone; what is left is the tombstone, which is the point.
   * Deleting both would let any body still holding the fact re-introduce it. */
  const remaining = await store.listMemoryEvents({ now: NOW + 3000 })
  assert.ok(remaining.length > 0)
  assert.ok(remaining.every((record) => record.retracted && !record.value))
  // The fleet snapshot itself is untouched — a forget is not an outage.
  assert.equal(after.mac.hostname, 'home')
})

/*
 * The Mac's pre-rendered `memory.text` blob is what carried the voice agent's
 * memory before any of this existed, and it is still the only memory some
 * deployments have. A spoken fact must join it, not replace it, until
 * local-agent/bridge.js appends events instead.
 */
test('a spoken fact merges with the block the Mac still pushes', async () => {
  const store = createMemoryStore()
  await writerFor(store).remember("remember that my sister's name is Mei")

  const fleet = await loadFleetFromStore(
    fleetStore(store, '## Owner\n- editor: VS Code'),
    { now: NOW + 60_000 },
  )

  assert.match(fleet.memory.text, /- editor: VS Code/)
  assert.match(fleet.memory.text, /sister's name: Mei/)
  assert.deepEqual(fleet.memory.text.match(/^## Owner$/gm), ['## Owner'])
})

/*
 * The same round trip against real SQL, built from schema.sql alone. The write
 * path is new; the table it writes to was only ever created by a migration
 * applied by hand.
 */
test('d1: a spoken fact survives the real statements and reads back', async () => {
  const store = migratedD1()
  const writer = createSpokenMemoryWriter({ store, now: () => NOW })

  assert.equal((await writer.remember('from now on answer in one sentence')).appended, 1)
  assert.equal((await writer.remember("remember that my sister's name is Mei")).appended, 1)

  const loaded = await store.listMemoryEvents({ now: NOW })
  assert.deepEqual(
    loaded.map((record) => record.type),
    ['preference', 'entity'],
  )
  assert.ok(loaded.every((record) => record.node === SPOKEN_MEMORY_NODE))

  await createSpokenMemoryWriter({ store, now: () => NOW + 1000 }).remember(
    "forget my sister's name",
  )
  const after = await store.listMemoryEvents({ now: NOW + 2000 })
  assert.ok(!after.some((record) => record.value.includes('Mei')))
})

test('the session budget default is a byte count, not an item count', () => {
  assert.ok(Number.isFinite(MAX_SESSION_BYTES) && MAX_SESSION_BYTES > MAX_UTTERANCE_BYTES)
})

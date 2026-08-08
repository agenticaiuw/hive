import assert from 'node:assert/strict'
import test from 'node:test'

import {
  applyContextGraphRetention,
  contextGraphBytes,
  contextGraphRetentionEnabled,
  contextGraphRetentionPolicy,
  recordAgeMs,
  retentionTombstone,
  CONTEXT_GRAPH_DEFAULT_MAX_BYTES,
} from './contextGraphRetention.js'

const NOW = Date.parse('2026-08-07T12:00:00.000Z')
const DAY = 24 * 60 * 60 * 1000

function action(id, { ageDays = 0, padding = 400 } = {}) {
  const at = new Date(NOW - ageDays * DAY).toISOString()
  return {
    id,
    type: 'Action',
    name: `step ${id}`,
    attributes: { command: 'x'.repeat(padding), status: 'success' },
    createdAt: at,
    updatedAt: at,
    sourceDeviceId: 'local-mac-agent',
  }
}

function owned(id, type = 'Note', { ageDays = 400 } = {}) {
  const at = new Date(NOW - ageDays * DAY).toISOString()
  return {
    id,
    type,
    name: `${type} ${id}`,
    attributes: { note: 'y'.repeat(600) },
    createdAt: at,
    updatedAt: at,
    sourceDeviceId: 'local-mac-agent',
  }
}

function relation(id, from, to) {
  const at = new Date(NOW).toISOString()
  return {
    id,
    from,
    to,
    type: 'uses',
    attributes: {},
    createdAt: at,
    updatedAt: at,
    sourceDeviceId: 'local-mac-agent',
  }
}

function graphOf(entities, relations = []) {
  return {
    version: 2,
    updatedAt: new Date(NOW).toISOString(),
    entities,
    relations,
    tombstones: { entities: [], relations: [] },
  }
}

const policy = (overrides = {}) =>
  contextGraphRetentionPolicy({ enabled: true, ...overrides })

test('the budget is bytes, and it is the bytes the file will actually hold', () => {
  const graph = graphOf([action('a1'), action('a2')])
  const serialized = `${JSON.stringify(graph, null, 2)}\n`
  assert.equal(contextGraphBytes(graph), Buffer.byteLength(serialized, 'utf8'))
})

test('telemetry past its stated life is removed; fresh telemetry is not', () => {
  const graph = graphOf([
    action('old', { ageDays: 30 }),
    action('fresh', { ageDays: 1 }),
  ])
  const { graph: next, report } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy({ telemetryTtlMs: 14 * DAY, maxBytes: 10 * 1024 * 1024 }),
  })

  assert.deepEqual(
    next.entities.map((entity) => entity.id),
    ['fresh'],
  )
  assert.equal(report.reasons.telemetryExpired, 1)
  assert.equal(report.reasons.byteOverflow, 0)
  assert.equal(report.removed.entities, 1)
  assert.ok(report.removed.bytes > 0, 'bytes freed are reported')
  assert.equal(report.kept.entities, 1)
})

test('owner content is never removed by age, however old it is', () => {
  const graph = graphOf([
    owned('note', 'Note', { ageDays: 900 }),
    owned('person', 'Person', { ageDays: 900 }),
    owned('task', 'Task', { ageDays: 900 }),
  ])
  const { report, changed } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy({ telemetryTtlMs: 1 }),
  })

  assert.equal(changed, false)
  assert.equal(report.removed.entities, 0)
  assert.equal(report.scanned.protectedEntities, 3)
})

test('an unrecognised type is owner content, not telemetry', () => {
  const graph = graphOf([
    { ...owned('mystery'), type: 'SomethingNewSomebodyAdded' },
    action('old', { ageDays: 90 }),
  ])
  const { graph: next } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy({ telemetryTtlMs: 14 * DAY }),
  })

  assert.deepEqual(
    next.entities.map((entity) => entity.id),
    ['mystery'],
  )
})

test('telemetry with an unreadable timestamp is kept and counted, never deleted', () => {
  const broken = { ...action('broken'), createdAt: 'not-a-date', updatedAt: null }
  const graph = graphOf([broken, action('old', { ageDays: 90 })])
  const { graph: next, report } = applyContextGraphRetention(graph, {
    now: NOW,
    /* A budget of nothing: even under maximum size pressure the malformed row
     * must survive, because "I cannot read its age" is not "it is expired". */
    policy: policy({ telemetryTtlMs: 14 * DAY, maxBytes: 1024 }),
  })

  assert.ok(next.entities.some((entity) => entity.id === 'broken'))
  assert.equal(report.scanned.undatedTelemetry, 1)
  assert.equal(recordAgeMs(broken, NOW), null)
})

test('the byte bound removes oldest telemetry first and stops once it fits', () => {
  const entities = []
  for (let index = 0; index < 60; index += 1) {
    entities.push(action(`a${String(index).padStart(2, '0')}`, { ageDays: 60 - index }))
  }
  const graph = graphOf(entities)
  const before = contextGraphBytes(graph)
  const maxBytes = Math.floor(before / 2)

  const { graph: next, report } = applyContextGraphRetention(graph, {
    now: NOW,
    /* TTL long enough that only the size pressure can act. */
    policy: policy({ telemetryTtlMs: 3650 * DAY, maxBytes }),
  })

  assert.equal(report.reasons.telemetryExpired, 0)
  assert.ok(report.reasons.byteOverflow > 0)
  assert.ok(report.bytesAfter <= maxBytes, `${report.bytesAfter} <= ${maxBytes}`)
  assert.equal(report.overBudgetBytes, 0)
  /* Oldest went first: the survivors are a suffix of the age ordering. */
  const survivors = next.entities.map((entity) => entity.id)
  const expectedSuffix = entities
    .map((entity) => entity.id)
    .slice(entities.length - survivors.length)
  assert.deepEqual(survivors, expectedSuffix)
  assert.equal(report.removed.entities + report.kept.entities, 60)
})

test('a removed entity takes its relations with it; the entity is tombstoned', () => {
  const graph = graphOf(
    [action('old', { ageDays: 90 }), owned('tool', 'Tool', { ageDays: 90 })],
    [relation('r1', 'old', 'tool'), relation('r2', 'tool', 'tool')],
  )
  const { graph: next, report } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy({ telemetryTtlMs: 14 * DAY, maxBytes: 10 * 1024 * 1024 }),
  })

  assert.deepEqual(
    next.relations.map((item) => item.id),
    ['r2'],
  )
  assert.equal(report.removed.relations, 1)
  assert.deepEqual(
    next.tombstones.entities.map((item) => item.id),
    ['old'],
  )
  /* Relations get no tombstone of their own: one costs more than the relation
   * it replaces, which is what made the first version of this grow the file. */
  assert.deepEqual(next.tombstones.relations, [])
})

test('THE BUG: a removal must free bytes, and one that would not is refused', () => {
  /*
   * Regression guard for the failure that reached the owner's real graph.
   * Relation tombstones were larger than the relations they replaced, so every
   * removal grew the store, the greedy loop never met its target, and it ate
   * every candidate. The rule now: measure the real serialization on both
   * sides, and if the pass did not shrink the file, it did not happen.
   */
  const entities = []
  const relations = []
  for (let index = 0; index < 80; index += 1) {
    const id = `a${String(index).padStart(2, '0')}`
    entities.push(action(id, { ageDays: 80 - index, padding: 60 }))
    for (let link = 0; link < 3; link += 1) {
      relations.push(relation(`${id}-r${link}`, id, 'tool'))
    }
  }
  entities.push(owned('tool', 'Tool'))
  const graph = graphOf(entities, relations)
  const before = contextGraphBytes(graph)

  const { graph: next, report } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy({ telemetryTtlMs: 3650 * DAY, maxBytes: Math.floor(before / 2) }),
  })

  assert.ok(report.bytesAfter < before, 'the file really did get smaller')
  assert.equal(report.bytesAfter, contextGraphBytes(next), 'reported bytes are real')
  assert.ok(
    report.kept.entities > 1,
    `the bound must not consume every candidate (kept ${report.kept.entities})`,
  )
  assert.equal(report.overBudgetBytes, 0)
})

test('a pass that cannot shrink the file removes nothing at all', () => {
  /* An entity whose tombstone would cost more than the entity: no attributes,
   * a long name, and no relations to reclaim. There is nothing to win here and
   * the store must notice rather than delete anyway. */
  const entities = []
  for (let index = 0; index < 40; index += 1) {
    const at = new Date(NOW - (40 - index) * DAY).toISOString()
    entities.push({
      id: `a${index}`,
      type: 'Action',
      name: 'n',
      createdAt: at,
      updatedAt: at,
      sourceDeviceId: 'local-mac-agent',
    })
  }
  const graph = graphOf(entities)

  const { graph: next, report, changed } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy({ telemetryTtlMs: 3650 * DAY, maxBytes: 512 }),
  })

  assert.equal(changed, false)
  assert.equal(next.entities.length, 40)
  assert.equal(report.reasons.byteOverflow, 0)
  assert.ok(report.reasons.notWorthRemoving > 0)
})

test('a relation left pointing at a tombstoned entity is dropped on sight', () => {
  /* How one arrives: a peer that had not seen the deletion syncs its live copy
   * of the relation back. The endpoint is a proven tombstone, so it is dead. */
  const graph = {
    ...graphOf([owned('note')], [relation('r1', 'ghost', 'note')]),
    tombstones: {
      entities: [
        retentionTombstone(action('ghost'), {
          deletedAt: new Date(NOW - DAY).toISOString(),
        }),
      ],
      relations: [],
    },
  }

  const { graph: next, report } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy(),
  })

  assert.equal(next.relations.length, 0)
  assert.equal(report.reasons.dangling, 1)
})

test('a relation pointing at a merely absent entity is left alone', () => {
  /* Absent is not deleted. A half-synced graph must not be read as a deleted
   * one, or a sync that arrives in two parts eats the first part. */
  const graph = graphOf([owned('note')], [relation('r1', 'unknown', 'note')])

  const { graph: next, report } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy(),
  })

  assert.equal(next.relations.length, 1)
  assert.equal(report.reasons.dangling, 0)
})

test('a retention tombstone is lean enough that deleting actually frees bytes', () => {
  const fat = action('a1', { padding: 4000 })
  const stone = retentionTombstone(fat, {
    deletedAt: new Date(NOW).toISOString(),
  })

  assert.equal(stone.attributes, undefined, 'the body is gone')
  assert.ok(
    JSON.stringify(stone).length < JSON.stringify(fat).length / 4,
    'a tombstone must not cost what the record cost',
  )
  /* shared/productSync.js requires these of every memory record it ships. */
  for (const field of ['id', 'type', 'name', 'createdAt', 'updatedAt', 'deletedAt']) {
    assert.ok(stone[field], `tombstone keeps ${field}`)
  }
})

test('tombstones are themselves bounded, oldest dropped first', () => {
  const stones = []
  for (let index = 0; index < 200; index += 1) {
    stones.push(
      retentionTombstone(action(`t${String(index).padStart(3, '0')}`), {
        deletedAt: new Date(NOW - (200 - index) * 60_000).toISOString(),
      }),
    )
  }
  const graph = {
    ...graphOf([owned('note')]),
    tombstones: { entities: stones, relations: [] },
  }

  const { graph: next, report } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy({ maxBytes: 16 * 1024 }),
  })

  assert.ok(report.reasons.tombstoneOverflow > 0)
  assert.ok(next.tombstones.entities.length < 200)
  /* The survivors are the newest, i.e. the ones peers may not have synced. */
  const kept = next.tombstones.entities.map((item) => item.id)
  assert.equal(kept.at(-1), 't199')
})

test('over budget with only owner content left is reported, never paid for', () => {
  const entities = []
  for (let index = 0; index < 40; index += 1) entities.push(owned(`n${index}`))
  const graph = graphOf(entities)

  const { graph: next, report } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy({ maxBytes: 2048 }),
  })

  assert.equal(report.removed.entities, 0)
  assert.equal(next.entities.length, 40)
  assert.ok(report.overBudgetBytes > 0, 'the shortfall is stated out loud')
  assert.equal(report.kept.bytes, report.bytesAfter)
})

test('retention can be switched off, and off means nothing is touched', () => {
  const graph = graphOf([action('old', { ageDays: 900 })])
  const { graph: next, report, changed } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: contextGraphRetentionPolicy({ enabled: false }),
  })

  assert.equal(changed, false)
  assert.equal(next.entities.length, 1)
  assert.match(report.skipped, /disabled/)

  assert.equal(contextGraphRetentionEnabled('off'), false)
  assert.equal(contextGraphRetentionEnabled('false'), false)
  assert.equal(contextGraphRetentionEnabled(''), true)
  assert.equal(contextGraphRetentionEnabled(undefined), true)
})

test('a non-positive byte setting falls back to the default, it does not mean zero', () => {
  assert.equal(
    contextGraphRetentionPolicy({ maxBytes: 0 }).maxBytes,
    CONTEXT_GRAPH_DEFAULT_MAX_BYTES,
  )
  assert.equal(
    contextGraphRetentionPolicy({ maxBytes: Number.NaN }).maxBytes,
    CONTEXT_GRAPH_DEFAULT_MAX_BYTES,
  )
  assert.equal(
    contextGraphRetentionPolicy({ telemetryTtlMs: 0 }).telemetryTtlMs,
    14 * DAY,
  )
})

test('every sweep reports what it removed and what it kept, in counts and bytes', () => {
  const graph = graphOf(
    [action('old', { ageDays: 90 }), owned('note')],
    [relation('r1', 'old', 'note')],
  )
  const { report } = applyContextGraphRetention(graph, {
    now: NOW,
    policy: policy({ telemetryTtlMs: 14 * DAY }),
  })

  for (const field of ['entities', 'relations', 'tombstones', 'bytes']) {
    assert.equal(typeof report.removed[field], 'number', `removed.${field}`)
    assert.equal(typeof report.kept[field], 'number', `kept.${field}`)
  }
  assert.equal(report.bytesBefore - report.removed.bytes, report.bytesAfter)
  assert.ok(report.policy.maxBytes > 0)
  assert.ok(report.policy.telemetryTtlMs > 0)
})

test('the pass is idempotent: running it twice removes nothing the second time', () => {
  const entities = []
  for (let index = 0; index < 40; index += 1) {
    entities.push(action(`a${String(index).padStart(2, '0')}`, { ageDays: 40 - index }))
  }
  const graph = graphOf(entities)
  const settings = policy({
    telemetryTtlMs: 3650 * DAY,
    maxBytes: Math.floor(contextGraphBytes(graph) / 2),
  })

  const first = applyContextGraphRetention(graph, { now: NOW, policy: settings })
  assert.equal(first.changed, true)

  const second = applyContextGraphRetention(first.graph, { now: NOW, policy: settings })
  assert.equal(second.changed, false)
  assert.equal(second.report.removed.entities, 0)
})

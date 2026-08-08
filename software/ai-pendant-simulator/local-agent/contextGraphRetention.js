/*
 * A bound for the context graph, in BYTES.
 *
 * The graph had no bound of any kind. Measured on this machine before this
 * module existed: 798,767 bytes on disk, 514 entities, 1,434 relations, zero
 * tombstones. 474 of those entities were type Action — the agent's own
 * execution exhaust — and 1,426 of the 1,434 relations had an Action at one
 * end. Compact-serialized that is ~608 KB of ~620 KB of content.
 *
 * None of it is readable by any prompt. contextGraph.js already declares
 * PROMPT_EXCLUDED_TYPES = Action | Tool | Device | Model, so retrieveLongTermMemory
 * skips every one of those rows on every call. The store was paying to keep,
 * sync, parse and re-serialize half a megabyte that nothing reads.
 *
 * BYTES, NOT ROWS. This project has capped by item count before while the
 * items themselves grew, which is a cap that stops working exactly when it
 * starts mattering. shared/fleetMemory.js says the same thing at the top of
 * its budget block and reaches for the same units. Bytes here means bytes as
 * writeGraph() will actually write them — pretty-printed with the trailing
 * newline — so a number in a report is a number you can check with `ls`.
 *
 * TELEMETRY GETS A SHORTER LIFE THAN SOMETHING THE OWNER SAID. An Action row
 * is a record that the agent did something; a Person, Project, File, Note,
 * EmailDraft or Task row is the owner's own content. They are not worth the
 * same and they do not expire on the same clock. Owner content is never
 * removed by this module at all: not by TTL, not by the byte budget. If
 * telemetry runs out and the graph is still over budget, that is REPORTED
 * (overBudgetBytes) rather than paid for out of the owner's content.
 *
 * UNRECOGNISED TYPES ARE KEPT. A type this module has never heard of is not
 * telemetry; it is something a newer writer added. Never delete a row because
 * you failed to classify it.
 *
 * REMOVALS LEAVE A TOMBSTONE, and the tombstone is LEAN. contextGraph.js's own
 * toTombstone() copies the whole record, attributes and all — correct for a
 * single explicit delete, useless here, since tombstoning 474 Actions that way
 * would free exactly zero bytes and the bound would be a lie. A retention
 * tombstone keeps only what a peer needs to not resurrect the row: identity,
 * the three timestamps, the device, and the type/name (or from/to) that
 * shared/productSync.js requires of every memory record. The body is gone,
 * which is the point: this is deletion, not a filter that hides it.
 */

const DAY_MS = 24 * 60 * 60 * 1000

/*
 * 256 KB. Sized against what the graph actually holds rather than picked
 * round: the owner content on this machine measures ~10 KB of entities and a
 * handful of relations, and one Action costs ~384 bytes plus its ~3 relations
 * at ~298 bytes each — call it 1.7 KB written. 256 KB therefore keeps every
 * durable row plus roughly 140 recent executions, which is several days of
 * heavy use, and holds the whole file inside one comfortable read.
 *
 * PROPOSED, NOT DISCOVERED: nothing in the codebase stated a size for this
 * store before now. Override with PENDANT_CONTEXT_GRAPH_MAX_BYTES.
 */
export const CONTEXT_GRAPH_DEFAULT_MAX_BYTES = 256 * 1024

/*
 * How long the agent's own exhaust is worth keeping. Two weeks: long enough
 * that "what did it do last week" is answerable from the graph, short enough
 * that a machine left running does not accumulate a year of it. Note that on a
 * graph as young as this one the TTL removes nothing and the byte budget is
 * what binds — both are reported separately so which one acted is never a
 * guess. Override with PENDANT_CONTEXT_GRAPH_TELEMETRY_TTL_MS.
 */
export const CONTEXT_GRAPH_DEFAULT_TELEMETRY_TTL_MS = 14 * DAY_MS

/*
 * Tombstones are deletion markers that must survive long enough to cross a
 * sync (productSyncClient.js ships them so another body cannot resurrect a
 * deleted row). They are also rows, and a retention pass mints one per
 * removal, so left alone they would eat the budget they exist to enforce.
 * A quarter of the budget is theirs; past that the oldest go, oldest being the
 * ones every peer has long since seen.
 */
export const CONTEXT_GRAPH_TOMBSTONE_BYTE_SHARE = 0.25

/*
 * Which entity types are the agent's exhaust.
 *
 * contextGraph.js excludes four types from every prompt — Action, Tool,
 * Device, Model — but only one of them GROWS. Tool, Device and Model are
 * upserted by name, so their row count is bounded by how many distinct tools
 * and machines exist (28 + 1 + 1 here) and stays flat no matter how long the
 * agent runs. Action is addEntity'd once per executed step and is the only
 * type whose size is a function of uptime.
 *
 * So the default set is the append-per-execution type, not "everything the
 * prompt ignores": deleting the 32 rows that describe what tools exist would
 * buy 7 KB and lose the shape of the machine.
 */
export const CONTEXT_GRAPH_DEFAULT_TELEMETRY_TYPES = Object.freeze(['Action'])

const RETENTION_OFF = new Set(['off', 'false', 'disabled', '0'])

/*
 * Stamped onto every tombstone this module mints, so a row that vanished
 * because of a size bound is never mistaken for one the owner deleted.
 * A short token, not a sentence: it is repeated on every removed row, and the
 * first draft of this spent a kilobyte per thousand rows restating the reason.
 */
export const RETENTION_TOMBSTONE_MARK = 'retention'

function envNumber(name, fallback) {
  const raw = Number(process.env[name])
  /*
   * A blank or non-positive value falls back to the default on purpose, the
   * same rule cloud-relay/config.js applies to AUDIO_RETENTION_MAX_AGE_MS:
   * an accidental `=0` must never read as "keep nothing".
   */
  return Number.isFinite(raw) && raw > 0 ? raw : fallback
}

/** Whether retention runs at all. Explicit opt-out only — `=0` does not mean off. */
export function contextGraphRetentionEnabled(
  env = process.env.PENDANT_CONTEXT_GRAPH_RETENTION,
) {
  return !RETENTION_OFF.has(String(env ?? '').trim().toLowerCase())
}

/** The policy, as a value, so a report can state it rather than imply it. */
export function contextGraphRetentionPolicy({
  maxBytes = envNumber(
    'PENDANT_CONTEXT_GRAPH_MAX_BYTES',
    CONTEXT_GRAPH_DEFAULT_MAX_BYTES,
  ),
  telemetryTtlMs = envNumber(
    'PENDANT_CONTEXT_GRAPH_TELEMETRY_TTL_MS',
    CONTEXT_GRAPH_DEFAULT_TELEMETRY_TTL_MS,
  ),
  telemetryTypes = CONTEXT_GRAPH_DEFAULT_TELEMETRY_TYPES,
  enabled = contextGraphRetentionEnabled(),
} = {}) {
  const safeMaxBytes = Math.max(1024, Number(maxBytes) || CONTEXT_GRAPH_DEFAULT_MAX_BYTES)
  return {
    enabled: Boolean(enabled),
    maxBytes: safeMaxBytes,
    maxTombstoneBytes: Math.floor(safeMaxBytes * CONTEXT_GRAPH_TOMBSTONE_BYTE_SHARE),
    telemetryTtlMs:
      Number(telemetryTtlMs) > 0
        ? Number(telemetryTtlMs)
        : CONTEXT_GRAPH_DEFAULT_TELEMETRY_TTL_MS,
    telemetryTtlDays:
      Math.round(
        ((Number(telemetryTtlMs) > 0
          ? Number(telemetryTtlMs)
          : CONTEXT_GRAPH_DEFAULT_TELEMETRY_TTL_MS) /
          DAY_MS) *
          100,
      ) / 100,
    telemetryTypes: [...telemetryTypes],
    protectedNote:
      'Every other entity type, recognised or not, is owner content and is never removed by retention.',
    settings: {
      maxBytes: 'PENDANT_CONTEXT_GRAPH_MAX_BYTES',
      telemetryTtlMs: 'PENDANT_CONTEXT_GRAPH_TELEMETRY_TTL_MS',
      disable: 'PENDANT_CONTEXT_GRAPH_RETENTION=off',
    },
  }
}

/**
 * Bytes as writeGraph() writes them.
 *
 * Deliberately not JSON.stringify(graph).length: the file is pretty-printed
 * with a trailing newline, and a budget measured in a different serialization
 * than the one on disk is a budget nobody can verify.
 */
export function contextGraphBytes(graph) {
  return Buffer.byteLength(`${JSON.stringify(normalizeShape(graph), null, 2)}\n`, 'utf8')
}

function normalizeShape(graph) {
  const tombstones = graph?.tombstones || {}
  return {
    version: 2,
    updatedAt: graph?.updatedAt || null,
    entities: Array.isArray(graph?.entities) ? graph.entities : [],
    relations: Array.isArray(graph?.relations) ? graph.relations : [],
    tombstones: {
      entities: Array.isArray(tombstones.entities) ? tombstones.entities : [],
      relations: Array.isArray(tombstones.relations) ? tombstones.relations : [],
    },
  }
}

/*
 * What one record costs in the written file.
 *
 * The naive way to answer "does the graph fit yet" is to re-serialize it after
 * every candidate removal. On the store this module was written for that is
 * ~600 KB of JSON per candidate across ~470 candidates, which turns a bound
 * into a stall. So each record's contribution is priced once — its own
 * pretty-printed block, plus the four spaces of array indent on every line and
 * the ",\n" that separates it from its neighbour — and the search runs on
 * arithmetic. The final number in the report is still a real serialization, so
 * the model is an accelerator and never the source of truth.
 */
const BLOCK_INDENT = 4

function blockBytes(record) {
  const text = JSON.stringify(record ?? null, null, 2)
  const lines = text.split('\n').length
  return Buffer.byteLength(text, 'utf8') + BLOCK_INDENT * lines + 2
}

function sumBlockBytes(records) {
  let total = 0
  for (const record of records) total += blockBytes(record)
  return total
}

/**
 * The clock a row is judged on.
 *
 * updatedAt first, createdAt second. A row with neither, or with an
 * unparseable value, returns null and is KEPT — the same rule
 * cloud-relay/audioRetention.js applies to a capture with a broken timestamp.
 * Never delete something because its metadata is malformed.
 */
export function recordAgeMs(record, now) {
  const stamp = Date.parse(record?.updatedAt || record?.createdAt || '')
  if (!Number.isFinite(stamp)) return null
  return now - stamp
}

/**
 * Identity, timestamps, and the fields shared/productSync.js demands. Nothing
 * else — and specifically no per-row prose. A `retiredReason` string repeated
 * across a thousand rows is a kilobyte of the same sentence; `retiredBy` says
 * which mechanism did it, and this file says why.
 *
 * MEASURED, because the first version of this was not: an Action entity is 366
 * bytes and its tombstone is 298, so tombstoning an entity frees 68 bytes.
 */
export function retentionTombstone(record, { deletedAt }) {
  return {
    id: record.id,
    createdAt: record.createdAt || deletedAt,
    updatedAt: deletedAt,
    deletedAt,
    sourceDeviceId: record.sourceDeviceId || null,
    type: record.type,
    name: record.name,
    retiredBy: RETENTION_TOMBSTONE_MARK,
  }
}

function sortOldestFirst(records) {
  return [...records].sort(
    (left, right) =>
      Date.parse(left.updatedAt || left.createdAt || 0) -
      Date.parse(right.updatedAt || right.createdAt || 0),
  )
}

/**
 * Apply the bound to a graph value. Pure: takes a graph, returns a new graph
 * and a report. Nothing here touches the filesystem, which is what makes the
 * live deleter testable without a real store anywhere near it.
 *
 * Order is load-bearing and mirrors pruneMemoryEventLog() on the relay:
 *
 *   1. Telemetry past its TTL. Age is the policy the owner can point at, so it
 *      acts first and independently of how full the store happens to be.
 *   2. Telemetry over the byte budget, oldest first. This is a size pressure,
 *      not a claim that the row is stale, and it stops the moment the graph
 *      fits.
 *   3. Tombstones over their share of the budget, oldest first — the markers
 *      every peer has already seen.
 *
 * A removed entity takes its relations with it. A dangling relation is not
 * cheaper than the row it points at and it is strictly worse to read.
 */
export function applyContextGraphRetention(
  graph,
  {
    now = Date.now(),
    policy = contextGraphRetentionPolicy(),
  } = {},
) {
  const source = normalizeShape(graph)
  const bytesBefore = contextGraphBytes(source)
  const deletedAt = new Date(now).toISOString()
  const telemetryTypes = new Set(policy.telemetryTypes)

  const report = {
    policy,
    bytesBefore,
    bytesAfter: bytesBefore,
    removed: { entities: 0, relations: 0, tombstones: 0, bytes: 0 },
    kept: {
      entities: source.entities.length,
      relations: source.relations.length,
      tombstones:
        source.tombstones.entities.length + source.tombstones.relations.length,
      bytes: bytesBefore,
    },
    reasons: {
      telemetryExpired: 0,
      byteOverflow: 0,
      tombstoneOverflow: 0,
      dangling: 0,
      notWorthRemoving: 0,
    },
    overBudgetBytes: 0,
    scanned: {
      telemetryEntities: 0,
      protectedEntities: 0,
      undatedTelemetry: 0,
    },
  }

  if (!policy.enabled) {
    report.skipped = 'retention disabled (PENDANT_CONTEXT_GRAPH_RETENTION=off)'
    return { graph: source, report, changed: false }
  }

  const telemetry = []
  const protectedEntities = []
  for (const entity of source.entities) {
    if (telemetryTypes.has(entity?.type)) telemetry.push(entity)
    else protectedEntities.push(entity)
  }
  report.scanned.telemetryEntities = telemetry.length
  report.scanned.protectedEntities = protectedEntities.length

  const doomed = new Set()
  const removedEntities = []

  /* ---- 1. past its stated life ---------------------------------------- */
  for (const entity of telemetry) {
    const age = recordAgeMs(entity, now)
    if (age === null) {
      report.scanned.undatedTelemetry += 1
      continue
    }
    if (age <= policy.telemetryTtlMs) continue
    doomed.add(entity.id)
    removedEntities.push(entity)
    report.reasons.telemetryExpired += 1
  }

  /* ---- 2. over the byte budget, oldest telemetry first ----------------- */
  /*
   * Priced on the model rather than on repeated serialization, then checked
   * once for real below. `overhead` is whatever the file costs that is not a
   * record — the version line, the wrapper braces, the array brackets — and it
   * is measured from the true size so the model starts out exact.
   */
  const relationsByEntity = new Map()
  for (const relation of source.relations) {
    for (const end of [relation.from, relation.to]) {
      if (!relationsByEntity.has(end)) relationsByEntity.set(end, new Set())
      relationsByEntity.get(end).add(relation)
    }
  }

  const liveRecordBytes =
    sumBlockBytes(source.entities) +
    sumBlockBytes(source.relations) +
    sumBlockBytes(source.tombstones.entities) +
    sumBlockBytes(source.tombstones.relations)
  const overhead = bytesBefore - liveRecordBytes

  const goneRelations = new Set()
  let modelBytes = bytesBefore

  /*
   * What removing this entity would cost, net, in written bytes. Negative means
   * the file gets smaller.
   *
   * The first version of this function did not compute a delta, and the
   * omission was expensive: relation tombstones were LARGER than the relations
   * they replaced (367 bytes against 278, measured), so every removal grew the
   * store, the greedy loop never reached its target, and it consumed every
   * candidate it was allowed to touch. A bound has to be able to tell that a
   * removal is not paying for itself, so this returns the number and the caller
   * refuses anything that does not.
   */
  const removalDelta = (entity) => {
    let delta = blockBytes(retentionTombstone(entity, { deletedAt })) - blockBytes(entity)
    for (const relation of relationsByEntity.get(entity.id) || []) {
      if (goneRelations.has(relation)) continue
      delta -= blockBytes(relation)
    }
    return delta
  }

  const chargeRemoval = (entity) => {
    modelBytes += removalDelta(entity)
    for (const relation of relationsByEntity.get(entity.id) || []) {
      goneRelations.add(relation)
    }
  }
  for (const entity of removedEntities) chargeRemoval(entity)

  /* Oldest first, and only telemetry that is not already going. A row with no
   * usable timestamp sorts as epoch-zero under a plain Date.parse, which would
   * make the malformed rows the FIRST to be deleted — the exact opposite of the
   * rule above — so they are excluded outright. */
  const candidates = sortOldestFirst(
    telemetry.filter(
      (entity) => !doomed.has(entity.id) && recordAgeMs(entity, now) !== null,
    ),
  )
  let nextCandidate = 0
  const trimToBudget = () => {
    while (modelBytes > policy.maxBytes && nextCandidate < candidates.length) {
      const entity = candidates[nextCandidate]
      nextCandidate += 1
      /*
       * Never delete something that does not buy anything. A removal that
       * would leave the file the same size or larger is skipped and counted,
       * not performed: the store keeps the row AND keeps the bytes, which is
       * strictly better than losing the row and keeping the bytes anyway.
       */
      if (removalDelta(entity) >= 0) {
        report.reasons.notWorthRemoving += 1
        continue
      }
      doomed.add(entity.id)
      removedEntities.push(entity)
      report.reasons.byteOverflow += 1
      chargeRemoval(entity)
    }
  }

  trimToBudget()
  let projected = projectGraph(source, doomed, deletedAt, removedEntities)

  /* ---- 2b. relations left pointing at a proven tombstone ---------------- */
  const dangling = dropDanglingRelations(projected)
  projected = dangling.graph
  report.reasons.dangling = dangling.dropped

  let bytesNow = contextGraphBytes(projected)

  /*
   * Re-anchor on the real number. The model is off by a handful of bytes at
   * most — the trailing separator of each array — but "at most" is not "never",
   * and a bound that lands a few bytes over is a bound that reports itself as
   * broken. Two corrective passes are plenty; the loop exits early the moment
   * there is nothing left it is allowed to remove.
   */
  for (let pass = 0; pass < 2 && bytesNow > policy.maxBytes; pass += 1) {
    if (nextCandidate >= candidates.length) break
    modelBytes = bytesNow
    trimToBudget()
    projected = dropDanglingRelations(
      projectGraph(source, doomed, deletedAt, removedEntities),
    ).graph
    bytesNow = contextGraphBytes(projected)
  }

  /* ---- 3. tombstones over their share ---------------------------------- */
  const tombstoneRecords = [
    ...projected.tombstones.entities,
    ...projected.tombstones.relations,
  ].sort(
    (left, right) =>
      Date.parse(left.deletedAt || 0) - Date.parse(right.deletedAt || 0),
  )
  let tombstoneBytes = sumBlockBytes(tombstoneRecords)
  if (tombstoneBytes > policy.maxTombstoneBytes) {
    const dropped = new Set()
    for (const record of tombstoneRecords) {
      if (tombstoneBytes <= policy.maxTombstoneBytes) break
      dropped.add(record)
      tombstoneBytes -= blockBytes(record)
      report.reasons.tombstoneOverflow += 1
    }
    projected = {
      ...projected,
      tombstones: {
        entities: projected.tombstones.entities.filter(
          (record) => !dropped.has(record),
        ),
        relations: projected.tombstones.relations.filter(
          (record) => !dropped.has(record),
        ),
      },
    }
    bytesNow = contextGraphBytes(projected)
  }

  /*
   * THE INVARIANT: a pass that does not make the file smaller does not happen.
   *
   * This is not belt and braces, it is the guard the first version of this
   * module lacked and paid for. Relation tombstones were larger than the
   * relations they replaced, so every "trim" grew the store; the greedy loop
   * chased a target it was moving away from and consumed every candidate it was
   * allowed to touch. Deletion is irreversible and this ran on every write, so
   * the arithmetic being wrong cost real rows before anything reported a
   * problem.
   *
   * Comparing the two REAL serializations cannot be fooled by a bad cost model,
   * because it does not use the cost model. If the projection is not smaller,
   * the original graph is returned untouched and the refusal is reported.
   */
  if (bytesNow >= bytesBefore && (doomed.size || report.reasons.dangling)) {
    report.refused =
      'the pass would not have made the file smaller, so nothing was removed'
    report.bytesAfter = bytesBefore
    report.overBudgetBytes = Math.max(0, bytesBefore - policy.maxBytes)
    return { graph: source, report, changed: false }
  }

  report.modelBytes = modelBytes
  report.overheadBytes = overhead
  const removedRelationCount =
    source.relations.length - projected.relations.length
  report.removed.entities = source.entities.length - projected.entities.length
  report.removed.relations = removedRelationCount
  report.removed.tombstones = report.reasons.tombstoneOverflow
  report.removed.bytes = Math.max(0, bytesBefore - bytesNow)
  report.bytesAfter = bytesNow
  report.kept = {
    entities: projected.entities.length,
    relations: projected.relations.length,
    tombstones:
      projected.tombstones.entities.length + projected.tombstones.relations.length,
    bytes: bytesNow,
  }
  /*
   * Over budget with nothing left that retention is allowed to touch. Said out
   * loud rather than solved: the only rows left are the owner's, and a bound
   * is not a reason to delete those.
   */
  report.overBudgetBytes = Math.max(0, bytesNow - policy.maxBytes)

  const changed =
    report.removed.entities > 0 ||
    report.removed.relations > 0 ||
    report.removed.tombstones > 0

  return { graph: changed ? projected : source, report, changed }
}

/**
 * The graph as it would be with `doomed` gone.
 *
 * ENTITIES GET A TOMBSTONE. RELATIONS DO NOT, and that asymmetry is the whole
 * reason this pass can free anything. A relation record is already almost pure
 * identity — two ids, a verb, three timestamps — so a tombstone for one costs
 * MORE than the row it replaces (measured: 367 bytes against 278). Minting them
 * turned every removal into a net gain in size. The entity tombstone at the
 * relation's endpoint is what a sync peer actually needs: it says the thing
 * this relation points at is deleted, which makes the relation dead by
 * definition, and `dropDanglingRelations` below finishes the job on any copy
 * that comes back over a sync.
 */
function projectGraph(source, doomed, deletedAt, removedEntities) {
  if (!doomed.size) return source

  const entities = source.entities.filter((entity) => !doomed.has(entity.id))
  const relations = source.relations.filter(
    (relation) => !doomed.has(relation.from) && !doomed.has(relation.to),
  )

  const entityTombstones = removedEntities.map((entity) =>
    retentionTombstone(entity, { deletedAt }),
  )

  return {
    ...source,
    entities,
    relations,
    tombstones: {
      entities: mergeById(source.tombstones.entities, entityTombstones),
      relations: source.tombstones.relations,
    },
  }
}

/**
 * Relations pointing at an entity this store has already tombstoned.
 *
 * They arrive one way: a sync from a peer that had not seen the deletion yet.
 * shared/productSync.js merges records by id, so the peer's live copy of a
 * relation comes back even though the entity it names is gone here. Removing it
 * is not a judgement call — the endpoint is a proven tombstone.
 *
 * A relation whose endpoint is simply ABSENT is left alone. Absent is not the
 * same as deleted, and a half-synced graph must not be treated as a deleted one.
 */
function dropDanglingRelations(graph) {
  const tombstoned = new Set(graph.tombstones.entities.map((record) => record.id))
  if (!tombstoned.size) return { graph, dropped: 0 }

  const relations = graph.relations.filter(
    (relation) => !tombstoned.has(relation.from) && !tombstoned.has(relation.to),
  )
  const dropped = graph.relations.length - relations.length
  return dropped ? { graph: { ...graph, relations }, dropped } : { graph, dropped: 0 }
}

function mergeById(existing, incoming) {
  const byId = new Map(
    [...existing, ...incoming].filter(Boolean).map((record) => [record.id, record]),
  )
  return [...byId.values()].sort((left, right) =>
    String(left.deletedAt).localeCompare(String(right.deletedAt)),
  )
}

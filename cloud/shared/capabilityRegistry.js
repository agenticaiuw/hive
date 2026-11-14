/*
 * A typed registry that answers "can I do X right now, and with what" — which
 * is a different question from "does X exist", and the difference is measurable.
 *
 * WHAT WAS MEASURED. An overnight run of nine agents against this repo produced
 * three independent forms of one failure: an agent cannot tell what it can
 * already do.
 *
 *   - One capability was proposed EIGHTEEN times. Every piece of it had already
 *     shipped — /jobs, /jobs/:jobId/receipts, /v1/pendant/announce — and two of
 *     those were named in the requesting agent's own prompt.
 *   - Twenty-one requests were filed for tools the agents had already been
 *     granted.
 *   - Two agents asked for authenticated Mac access that the bearer token in
 *     their own probe already carried, while the shared store held their peers'
 *     HTTP 200s from those exact routes.
 *
 * Every one of those was answerable from information the system already had and
 * never surfaced. Together they are roughly a third of the wasted effort in the
 * run.
 *
 * WHY A ROUTE LIST DOES NOT FIX IT. local-agent/capabilityManifest.js is a good
 * directory: ~120 routes derived from the live Express router, groups, auth
 * scheme, action types, drift. It answers "does this exist on this process".
 * It cannot answer:
 *
 *   - Is `mac_run_actions` — the name I was handed — a thing that runs, or a
 *     schema with nothing behind it? (A granted name and an implementation are
 *     different objects. describeActions() already reports the gap in one
 *     direction, dispatchableButNotPlannable; nothing names it in general.)
 *   - Does the credential I am holding reach it, or will I get a 401 that reads
 *     like a 404?
 *   - Has anyone already succeeded at this, and when?
 *   - What do I have to call first to get the jobId this route wants?
 *   - When the answer is "no such capability", does that mean it is absent, or
 *     that the surface which owns it never published anything? Those look
 *     identical from the outside and they are the /v1/pendant/announce case
 *     exactly: the relay publishes no inventory, so nothing outside it can
 *     enumerate its 41 routes, so an announce endpoint that has existed for
 *     weeks is invisible and gets proposed again.
 *
 * So the record here is not a route. It is: a stable identifier, the surface
 * that owns it, whether it is IMPLEMENTED or MERELY A GRANTED SCHEMA, what
 * credential reaches it, what it needs and what it yields (so composition is
 * derived, not guessed), and what has been observed to work. Names resolve into
 * that record through an alias index, because the eighteen proposals did not
 * repeat a path — they repeated an idea, in eighteen spellings.
 *
 * NO IMPORTS ON PURPOSE. Every body has to be able to load this: the Mac
 * (node), the relay (node and Cloudflare Workers), the browser extension. A
 * registry that only one surface can parse reintroduces the asymmetry it exists
 * to remove. Surfaces register themselves; see registerSurface().
 */

export const CAPABILITY_REGISTRY_VERSION = 1

/*
 * Bodies a capability can live on.
 *
 * The first four are the memory-wire surface vocabulary (voice, mac,
 * browser, ios) verbatim, in the same order, so a fact and a capability name
 * the same body the same way. Two
 * are added because a capability can live somewhere a prompt never goes:
 * 'relay' is a process with 41 routes and no prompt of its own, and 'pendant'
 * is firmware that offers capabilities (announce, audio upload) while reading
 * nothing. Do not rename these to match capabilityManifest.js's
 * OFF_BOX_SURFACES ('cloud-relay', 'browser-extension', ...) — one vocabulary
 * has to win, and the memory wire chose first.
 */
export const CAPABILITY_SURFACES = Object.freeze([
  'voice',
  'mac',
  'browser',
  'ios',
  'relay',
  'pendant',
])

/* What kind of thing the name denotes. Kept small: these three are the only
 * ones a caller invokes differently. */
export const CAPABILITY_KINDS = Object.freeze(['http', 'tool', 'action'])

/*
 * The distinction the whole file exists for.
 *
 * 'implemented'    — code on the named surface runs when you call it.
 * 'granted-schema' — a name you have been handed (a Realtime tool definition, a
 *                    scope in a token, an action type advertised to a planner).
 *                    It may point at an implementation on another surface via
 *                    implementedBy, or it may point at nothing, and those two
 *                    are indistinguishable from the tool list alone. Twenty-one
 *                    of the measured requests were for names already in this
 *                    state.
 * 'retired'        — existed, does not now. Registered rather than deleted so
 *                    its aliases keep resolving; "that was removed in June" is
 *                    an answer and silence is not.
 */
export const CAPABILITY_STATUSES = Object.freeze([
  'implemented',
  'granted-schema',
  'retired',
])

/*
 * How long an observed success stays evidence.
 *
 * Six hours, the event TTL the old fleet-memory wire used, kept for the
 * same reason: this is one body's claim about a moment, not a standing
 * fact. Device tokens rotate, AGENT_TOKEN gets reconfigured, the Mac sleeps. A
 * 200 from last week is history; a 200 from an hour ago is the reason not to
 * re-probe. Past the TTL the observation is kept and reported as stale — "it
 * worked, a while ago" is still worth more than nothing, it is just not proof.
 */
export const EVIDENCE_TTL_MS = 6 * 60 * 60 * 1000

/* Newest few per capability. Evidence is not an audit log — local-agent's
 * action ledger and context graph are. Five is enough to see whether one caller
 * succeeded or several did. */
export const MAX_EVIDENCE_PER_CAPABILITY = 5

/*
 * What a digest may cost. 1200 bytes ≈ 300 tokens at the 4-chars-per-token
 * estimate local-agent/contextProjection.js uses — larger than the 800-byte
 * memory projection because this is the artifact meant to stop request
 * twenty-two from being written, and a truncated list of what you can do is
 * worse than none: it reads as an exhaustive list.
 */
export const DEFAULT_DIGEST_BYTES = 1200
export const MAX_DIGEST_BYTES = 4000

/* Words that carry no identity in a capability name. 'endpoint', 'route' and
 * 'api' are how humans and agents spell "I want a thing"; 'v1' is a deploy
 * detail. Dropping them is what lets "an announce endpoint for the pendant"
 * meet POST /v1/pendant/announce. */
const NAME_STOPWORDS = new Set([
  'a',
  'an',
  'the',
  'for',
  'of',
  'to',
  'on',
  'v1',
  'v2',
  'api',
  'route',
  'routes',
  'endpoint',
  'endpoints',
  'tool',
  'tools',
])

/* Leading verbs that describe the access, not the thing accessed. `getJobReceipts`,
 * `GET /jobs/:id/receipts` and `job receipts` are one capability. */
const ACCESS_VERBS = new Set([
  'get',
  'post',
  'put',
  'patch',
  'delete',
  'head',
  'options',
  'list',
  'fetch',
  'read',
  'create',
  'run',
])

/* ---- names -------------------------------------------------------------- */

/**
 * Collapse any spelling of a capability into one lookup key.
 *
 * The eighteen duplicate proposals did not repeat a string — they repeated an
 * idea. So this is deliberately lossy: the version prefix, camelCase
 * boundaries, plurals, separators and — in the loose form — path parameters and
 * the leading HTTP verb all disappear. What survives is the noun phrase.
 *
 *   'POST /v1/pendant/announce'  -> 'pendant announce'
 *   '/v1/pendant/announce'       -> 'pendant announce'
 *   'pendantAnnounce'            -> 'pendant announce'
 *   'GET /jobs/:jobId/receipts'  -> 'job receipt'
 *   'job receipts'               -> 'job receipt'
 *
 * Two strengths, because one is not enough. `keepParams` retains ':jobId' as a
 * token and the leading verb as a token, which is how a capability's own full
 * name is indexed; the loose form is how a caller's guess is matched. Without
 * the strict form, GET /jobs and POST /jobs collapse together and every REST
 * pair in the repo becomes unresolvable; without the loose one, "the pendant
 * announce endpoint" never meets POST /v1/pendant/announce, which is the
 * failure being fixed.
 */
export function normalizeCapabilityName(name, { keepParams = false } = {}) {
  const raw = String(name ?? '')
  if (!raw.trim()) return ''

  const spaced = raw
    /*
     * Path params in either spelling, before punctuation is stripped. Loose
     * form deletes them; strict form keeps the parameter's own name, already
     * lowercased so the camelCase split below leaves ':jobId' as one token —
     * ':jobId' and ':job_id' are one parameter spelled twice, not two.
     */
    .replace(/[:{]([A-Za-z0-9_]+)\}?/g, (_match, param) =>
      keepParams ? ` ${param.replace(/[^A-Za-z0-9]/g, '').toLowerCase()} ` : ' ',
    )
    // camelCase and PascalCase boundaries.
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .replace(/[^A-Za-z0-9]+/g, ' ')
    .toLowerCase()

  const tokens = []
  for (const token of spaced.split(' ')) {
    if (!token) continue
    if (NAME_STOPWORDS.has(token)) continue
    // Only a LEADING verb is access; 'run' inside 'mac run actions' is the
    // capability's own name and has to stay.
    if (!keepParams && tokens.length === 0 && ACCESS_VERBS.has(token)) continue
    tokens.push(singular(token))
  }

  return tokens.join(' ')
}

function singular(token) {
  if (token.length > 3 && token.endsWith('ies')) return `${token.slice(0, -3)}y`
  if (token.length > 3 && token.endsWith('ses')) return token.slice(0, -2)
  if (token.length > 3 && token.endsWith('s') && !token.endsWith('ss')) {
    return token.slice(0, -1)
  }
  return token
}

/**
 * The stable internal identifier.
 *
 * Derived from surface + kind + the invocation, never from registration order
 * or from the display name, so two bodies registering the same route agree on
 * the id without coordinating. Path parameters are masked to '*': /jobs/:jobId
 * and /jobs/:id are the same capability spelled by two people.
 *
 * Renaming a path mints a NEW id, on purpose. A moved route is a different
 * capability to every caller holding the old one; register the old id as
 * 'retired' so its aliases still resolve to an answer.
 */
export function capabilityId({ surface, kind, invoke = {}, name = '' } = {}) {
  const body = String(surface || '').trim().toLowerCase()
  const type = String(kind || '').trim().toLowerCase()

  if (type === 'http') {
    const method = String(invoke.method || 'GET').trim().toUpperCase()
    return `${body}:http:${method} ${maskPath(invoke.path)}`
  }

  const label = String(invoke.tool || invoke.action || name || '').trim()
  return `${body}:${type}:${label.toLowerCase()}`
}

function maskPath(path) {
  return String(path ?? '/')
    .replace(/[:{][A-Za-z0-9_]+\}?/g, '*')
    .replace(/\/+$/, '') || '/'
}

/** Path parameters a caller must already hold. Derived, never hand-listed. */
export function pathParams(path) {
  return [...String(path ?? '').matchAll(/[:{]([A-Za-z0-9_]+)\}?/g)].map(
    (match) => match[1],
  )
}

/* ---- records ------------------------------------------------------------ */

/**
 * Normalize and validate one capability declaration.
 *
 * Throws rather than coercing, in the style of normalizeMemoryEvent(): the
 * writers are other surfaces, and a capability registered with an unknown
 * surface name is not "filed somewhere unusual" — it is filed where no caller
 * will look, which is indistinguishable from never registering it. That is the
 * failure mode this whole module exists to end, so it must not be reachable by
 * a typo.
 */
export function defineCapability(input = {}, { now = Date.now() } = {}) {
  const {
    name,
    surface,
    kind = 'http',
    status = 'implemented',
    invoke = {},
    auth = {},
    aliases = [],
    requires = [],
    provides = [],
    implementedBy = [],
    what = null,
    module = null,
    id = null,
  } = input

  const body = String(surface ?? '').trim().toLowerCase()
  if (!CAPABILITY_SURFACES.includes(body)) {
    throw new TypeError(
      `surface must be one of ${CAPABILITY_SURFACES.join(', ')} (got ${JSON.stringify(surface)}).`,
    )
  }

  const type = String(kind ?? '').trim().toLowerCase()
  if (!CAPABILITY_KINDS.includes(type)) {
    throw new TypeError(
      `kind must be one of ${CAPABILITY_KINDS.join(', ')} (got ${JSON.stringify(kind)}).`,
    )
  }

  const state = String(status ?? '').trim().toLowerCase()
  if (!CAPABILITY_STATUSES.includes(state)) {
    throw new TypeError(
      `status must be one of ${CAPABILITY_STATUSES.join(', ')} (got ${JSON.stringify(status)}).`,
    )
  }

  const label = String(name ?? '').trim() ||
    (type === 'http' ? `${invoke.method ?? 'GET'} ${invoke.path ?? ''}`.trim() : '')
  if (!label) throw new TypeError('A capability needs a name.')

  const call = normalizeInvoke(type, invoke, label)
  const record = {
    version: CAPABILITY_REGISTRY_VERSION,
    id: String(id || '').trim() ||
      capabilityId({ surface: body, kind: type, invoke: call, name: label }),
    name: label,
    surface: body,
    kind: type,
    status: state,
    what: what ? String(what).trim() : null,
    module: module ? String(module).trim() : null,
    invoke: call,
    auth: normalizeAuth(auth),
    /*
     * Composition, as data rather than prose. `requires` are the handles a
     * caller must already hold; for an HTTP capability the path parameters are
     * added automatically, because ":jobId" IS a stated prerequisite and
     * nobody should have to also write it down. `provides` are the handles a
     * successful call yields. composableWith() joins the two, so "what can I
     * chain this with" is derived from the same declarations the router
     * already implies.
     */
    requires: uniqueStrings([...toList(requires), ...pathParams(call.path)]),
    provides: uniqueStrings(toList(provides)),
    /* For 'granted-schema': the id(s) that actually do the work, possibly on
     * another surface. Empty here is the dangling grant — a name you hold that
     * resolves to nothing. capabilityRegistryReport() counts them. */
    implementedBy: uniqueStrings(toList(implementedBy)),
    aliases: uniqueStrings(toList(aliases)),
    registeredAt: new Date(now).toISOString(),
    evidence: [],
  }

  if (state === 'granted-schema' && record.implementedBy.includes(record.id)) {
    throw new TypeError(
      `A granted schema cannot implement itself (${record.id}).`,
    )
  }

  return record
}

function normalizeInvoke(kind, invoke, label) {
  if (kind === 'http') {
    const path = String(invoke?.path ?? '').trim()
    if (!path.startsWith('/')) {
      throw new TypeError(
        `An http capability needs an absolute path (got ${JSON.stringify(invoke?.path)}).`,
      )
    }
    return {
      method: String(invoke?.method || 'GET').trim().toUpperCase(),
      path,
      // The one string a caller can paste. Written down because the measured
      // failure was callers guessing it.
      baseUrl: invoke?.baseUrl ? String(invoke.baseUrl).trim() : null,
    }
  }

  if (kind === 'tool') {
    return { tool: String(invoke?.tool || label).trim() }
  }

  return { action: String(invoke?.action || label).trim() }
}

/*
 * What reaches it. `credential` is the stable name of a secret, never a secret:
 * 'agent-token', 'relay-admin-key', 'device-token', 'none'. `scopes` is the
 * relay's per-device scope list (cloud-relay/deviceAuth.js DEVICE_SCOPES).
 *
 * `unknown: true` is a first-class answer and not an error. A surface that can
 * enumerate its routes but cannot say what guards each one should say so — an
 * honestly unknown auth shows up in the report and gets fixed, while a guessed
 * one gets believed.
 */
function normalizeAuth(auth = {}) {
  const credential = String(auth?.credential ?? '').trim().toLowerCase()
  return {
    credential: credential || 'unknown',
    scopes: uniqueStrings(toList(auth?.scopes)),
    unknown: !credential || credential === 'unknown',
    note: auth?.note ? String(auth.note).trim() : null,
  }
}

function toList(value) {
  if (value == null) return []
  return Array.isArray(value) ? value : [value]
}

function uniqueStrings(list) {
  const out = []
  for (const item of list) {
    const value = String(item ?? '').trim()
    if (value && !out.includes(value)) out.push(value)
  }
  return out
}

/* ---- registry ----------------------------------------------------------- */

/**
 * An empty registry. Plain data and free functions, no class: the wire form is
 * a separate, flat snapshot (toCapabilityRegistrySnapshot below), so nothing
 * here needs methods to survive a hop between bodies.
 */
export function createCapabilityRegistry() {
  return {
    version: CAPABILITY_REGISTRY_VERSION,
    capabilities: new Map(),
    /* A capability's own full name, params and verb intact -> Set(id). Checked
     * first so an exact ask is never answered "ambiguous". */
    primaryIndex: new Map(),
    /* Every looser spelling -> Set(id). Many keys per capability; collisions
     * here are honest ambiguity and are reported as such. */
    index: new Map(),
    surfaces: new Map(),
  }
}

/**
 * A surface says "I am here, and here is how I know what I have".
 *
 * Registering the surface is separate from registering its capabilities, and it
 * is the half that makes an honest "no". Without it, "no such capability" means
 * either "nothing implements that" or "the body that would have has never
 * spoken" — the relay case, where /v1/pendant/announce had shipped and was
 * still proposed eighteen times. resolveCapability() reports coverage on every
 * miss so a caller can tell those apart.
 */
export function registerSurface(
  registry,
  { surface, inventorySource = null, publishesAt = null, note = null } = {},
  { now = Date.now() } = {},
) {
  const body = String(surface ?? '').trim().toLowerCase()
  if (!CAPABILITY_SURFACES.includes(body)) {
    throw new TypeError(
      `surface must be one of ${CAPABILITY_SURFACES.join(', ')} (got ${JSON.stringify(surface)}).`,
    )
  }

  const record = {
    surface: body,
    /* How the inventory was derived. 'express-router' and 'tool-schema' are
     * self-maintaining; 'hand-written' is a warning that capabilityManifest.js
     * already learned the hard way, and the report surfaces it. */
    inventorySource: inventorySource ? String(inventorySource).trim() : null,
    publishesAt: publishesAt ? String(publishesAt).trim() : null,
    note: note ? String(note).trim() : null,
    registeredAt: new Date(now).toISOString(),
  }

  registry.surfaces.set(body, record)
  return record
}

/**
 * Register one capability and index every name it could be asked for by.
 *
 * Re-registering the same id replaces the declaration and KEEPS the evidence:
 * a process restart re-derives its routes but does not un-observe the 200s its
 * peers reported.
 */
export function registerCapability(registry, input, { now = Date.now() } = {}) {
  const record = defineCapability(input, { now })
  const existing = registry.capabilities.get(record.id)
  if (existing) record.evidence = existing.evidence

  registry.capabilities.set(record.id, record)
  const keys = indexKeysFor(record)
  addKeys(registry.primaryIndex, keys.primary, record.id)
  addKeys(registry.index, [...keys.primary, ...keys.derived], record.id)

  return record
}

function addKeys(target, keys, id) {
  for (const key of keys) {
    if (!key) continue
    if (!target.has(key)) target.set(key, new Set())
    target.get(key).add(id)
  }
}

export function registerCapabilities(registry, list, options = {}) {
  const registered = []
  const rejected = []

  for (const input of Array.isArray(list) ? list : []) {
    try {
      registered.push(registerCapability(registry, input, options))
    } catch (error) {
      // One malformed declaration must not cost a surface its whole inventory —
      // a surface that publishes nothing is the failure being fixed.
      rejected.push({ input, error: error.message })
    }
  }

  return { registered, rejected }
}

/**
 * Every spelling this capability answers to, split by strength.
 *
 * Primary is what it calls itself: the method and the path parameters are part
 * of the name, so GET /jobs and POST /jobs stay distinct and /jobs/:jobId does
 * not swallow /jobs. Derived is every way a caller might ask for it — the path
 * alone, the verb dropped, the parameters dropped, each declared alias.
 */
function indexKeysFor(record) {
  const strict = { keepParams: true }
  const primary = [normalizeCapabilityName(record.name, strict)]
  const derived = [normalizeCapabilityName(record.name)]

  for (const alias of record.aliases) {
    primary.push(normalizeCapabilityName(alias, strict))
    derived.push(normalizeCapabilityName(alias))
  }

  if (record.kind === 'http') {
    primary.push(
      normalizeCapabilityName(`${record.invoke.method} ${record.invoke.path}`, strict),
    )
    derived.push(normalizeCapabilityName(record.invoke.path, strict))
    derived.push(normalizeCapabilityName(record.invoke.path))
    derived.push(normalizeCapabilityName(`${record.invoke.method} ${record.invoke.path}`))
  } else {
    const label = record.invoke.tool ?? record.invoke.action
    primary.push(normalizeCapabilityName(label, strict))
    derived.push(normalizeCapabilityName(label))
  }

  const primaryKeys = uniqueStrings(primary)
  return {
    primary: primaryKeys,
    derived: uniqueStrings(derived).filter((key) => !primaryKeys.includes(key)),
  }
}

/**
 * Record that someone actually called it and what came back.
 *
 * The measured case: two agents asked for authenticated Mac access while the
 * shared store held their peers' 200s from those routes. The 200 was in the
 * system; nothing attached it to the capability, so it could not be read as an
 * answer. Failures are recorded too — a 401 from a caller holding the same
 * credential as you is the cheapest possible warning.
 */
export function recordCapabilityObservation(
  registry,
  { name, status, by = null, note = null, at = undefined } = {},
  { now = Date.now() } = {},
) {
  const resolved = resolveCapability(registry, name)
  if (resolved.status !== 'resolved') return resolved

  const code = Number(status)
  if (!Number.isFinite(code)) {
    throw new TypeError('An observation needs a numeric status.')
  }

  const stamp = Number.isFinite(Date.parse(at || '')) ? Date.parse(at) : now
  const observation = {
    status: code,
    ok: code >= 200 && code < 300,
    by: by ? String(by).trim() : null,
    note: note ? String(note).trim() : null,
    at: new Date(stamp).toISOString(),
  }

  const record = resolved.capability
  record.evidence = [observation, ...record.evidence]
    .sort((left, right) => Date.parse(right.at) - Date.parse(left.at))
    .slice(0, MAX_EVIDENCE_PER_CAPABILITY)

  return { status: 'recorded', capability: record, observation }
}

/* ---- resolution --------------------------------------------------------- */

/**
 * Turn a name — any spelling of it — into the thing it actually is.
 *
 * Three outcomes, and the third one is the point:
 *   'resolved'  — one capability. Read it.
 *   'ambiguous' — several. Both are returned; a caller that cannot choose has
 *                 found a real naming collision, not a lookup failure.
 *   'unknown'   — nothing indexed. `coverage` says which surfaces have never
 *                 published, so "unknown" can be read as "absent" only when
 *                 every surface has spoken. `suggestions` carries the near
 *                 misses, because the duplicate proposals were near misses:
 *                 "pendant announce endpoint" is two thirds of
 *                 "POST /v1/pendant/announce".
 */
export function resolveCapability(registry, name) {
  const query = String(name ?? '')
  const coverage = registryCoverage(registry)

  /* A stable id is the one spelling that is never a guess. Checked before any
   * normalization so the registry can be walked by id without round-tripping
   * through the fuzzy matcher. */
  const byId = registry.capabilities.get(query.trim())
  if (byId) return { status: 'resolved', query, capability: byId, coverage }

  const strict = normalizeCapabilityName(query, { keepParams: true })
  const loose = normalizeCapabilityName(query)
  if (!strict && !loose) {
    return { status: 'unknown', query, candidates: [], suggestions: [], coverage }
  }

  /* Strongest match first: an exact full name beats a loose one, so asking for
   * "GET /jobs" never comes back ambiguous just because POST /jobs also exists. */
  for (const index of [registry.primaryIndex, registry.index]) {
    const ids = new Set([
      ...(index.get(strict) ?? []),
      ...(index.get(loose) ?? []),
    ])
    const hits = [...ids].map((id) => registry.capabilities.get(id)).filter(Boolean)

    if (hits.length === 1) return { status: 'resolved', query, capability: hits[0], coverage }
    if (hits.length > 1) {
      return {
        status: 'ambiguous',
        query,
        candidates: hits.sort((left, right) => left.id.localeCompare(right.id)),
        suggestions: [],
        coverage,
      }
    }
  }

  return {
    status: 'unknown',
    query,
    candidates: [],
    suggestions: suggestCapabilities(registry, loose || strict),
    coverage,
  }
}

/**
 * Near misses by token overlap.
 *
 * Deliberately simple — Jaccard over the normalized tokens. The duplicate
 * proposals were not subtle: they shared most of their nouns with the thing
 * that already existed. Anything cleverer would need a model, and a registry
 * that needs a model to be read is not a registry.
 */
export function suggestCapabilities(registry, name, { limit = 5 } = {}) {
  const wanted = new Set(normalizeCapabilityName(name).split(' ').filter(Boolean))
  if (wanted.size === 0) return []

  const scored = []
  for (const record of registry.capabilities.values()) {
    let best = 0
    const keys = indexKeysFor(record)
    for (const key of [...keys.primary, ...keys.derived]) {
      const tokens = new Set(key.split(' ').filter(Boolean))
      if (tokens.size === 0) continue
      let shared = 0
      for (const token of wanted) if (tokens.has(token)) shared += 1
      if (shared === 0) continue
      const score = shared / new Set([...wanted, ...tokens]).size
      if (score > best) best = score
    }
    if (best > 0) scored.push({ score: Number(best.toFixed(3)), capability: record })
  }

  return scored
    .sort(
      (left, right) =>
        right.score - left.score ||
        left.capability.id.localeCompare(right.capability.id),
    )
    .slice(0, limit)
}

function registryCoverage(registry) {
  const published = [...registry.surfaces.keys()].sort()
  const withCapabilities = new Set(
    [...registry.capabilities.values()].map((record) => record.surface),
  )

  return {
    published,
    /* A surface nobody has registered cannot be reasoned about. Listing it is
     * the difference between "that does not exist" and "I cannot see that far",
     * and the relay has been in the second state this whole time. */
    unpublished: CAPABILITY_SURFACES.filter(
      (surface) => !registry.surfaces.has(surface),
    ),
    /* Registered as present but contributed nothing — a surface that said hello
     * and then published an empty inventory is a bug, not an empty surface. */
    silent: published.filter((surface) => !withCapabilities.has(surface)),
  }
}

/* ---- the question ------------------------------------------------------- */

/**
 * "Can I do X right now, and with what?"
 *
 * The principal is what the CALLER already holds, and the whole shape of this
 * function follows from the measurement: the answers that were missing were
 * never "does it exist", they were "does my token reach it" and "is this name
 * even wired to anything".
 *
 *   principal = {
 *     credentials: ['agent-token'],   // stable names, never secrets
 *     scopes: ['mac:plan'],           // relay device scopes
 *     holds: ['jobId'],               // handles already in hand
 *     onlineSurfaces: ['mac'],        // omit if liveness is genuinely unknown
 *   }
 *
 * Verdicts:
 *   'yes'           — call it. `invoke` says how, `evidence` says who last did.
 *   'blocked'       — it is real and implemented; you are missing something.
 *                     `missing` says what. Never conflate this with absence:
 *                     the Mac's token middleware runs before routing, so a
 *                     wrong guess returns 401 and reads like "forbidden, so it
 *                     must exist" — this is the field that tells the truth.
 *   'unimplemented' — you hold the name, nothing behind it runs. The
 *                     twenty-one-requests case, answered before the request is
 *                     written. `because` names the id the grant points at.
 *   'unknown'       — no such name here. `coverage`/`suggestions` say whether
 *                     that is absence or blindness.
 */
export function canInvoke(registry, name, principal = {}, { now = Date.now() } = {}) {
  const resolved = resolveCapability(registry, name)

  if (resolved.status !== 'resolved') {
    return {
      query: String(name ?? ''),
      verdict: 'unknown',
      because:
        resolved.status === 'ambiguous'
          ? `"${name}" names ${resolved.candidates.length} different capabilities.`
          : resolved.coverage.unpublished.length > 0
            ? `Nothing registered under that name, and these surfaces have published no inventory: ${resolved.coverage.unpublished.join(', ')}. Absence here is not evidence of absence.`
            : 'Nothing registered under that name on any published surface.',
      candidates: resolved.candidates ?? [],
      suggestions: resolved.suggestions ?? [],
      coverage: resolved.coverage,
    }
  }

  const record = resolved.capability
  const target = resolveImplementation(registry, record)

  if (record.status === 'retired') {
    return answer(record, target, 'unimplemented', {
      because: `${record.name} is retired; it existed and no longer does.`,
      now,
    })
  }

  if (!target.capability) {
    return answer(record, target, 'unimplemented', {
      because:
        record.status === 'granted-schema'
          ? `${record.name} is a granted schema with no registered implementation${
              record.implementedBy.length
                ? ` (it points at ${record.implementedBy.join(', ')}, which nothing has registered)`
                : ''
            }. Holding the name does not make the call work.`
          : `${record.name} has no invocable implementation.`,
      now,
    })
  }

  const implementation = target.capability
  const missing = []

  const credentials = uniqueStrings(toList(principal.credentials))
  const scopes = uniqueStrings(toList(principal.scopes))
  const holds = uniqueStrings(toList(principal.holds))

  if (
    implementation.auth.credential !== 'none' &&
    !implementation.auth.unknown &&
    !credentials.includes(implementation.auth.credential)
  ) {
    missing.push({ kind: 'credential', need: implementation.auth.credential })
  }

  for (const scope of implementation.auth.scopes) {
    // An admin principal is not modelled here on purpose: whether a credential
    // implies a scope is the relay's decision (cloud-relay/server.js), and a
    // second opinion about that in a discovery module would be a security bug
    // waiting to disagree. Pass the scopes the token actually carries.
    if (!scopes.includes(scope)) missing.push({ kind: 'scope', need: scope })
  }

  const onlineSurfaces = toList(principal.onlineSurfaces).map((value) =>
    String(value).trim().toLowerCase(),
  )
  if (onlineSurfaces.length > 0 && !onlineSurfaces.includes(implementation.surface)) {
    missing.push({ kind: 'surface', need: implementation.surface })
  }

  const missingInputs = implementation.requires.filter(
    (handle) => !holds.includes(handle),
  )

  if (missing.length > 0) {
    return answer(record, target, 'blocked', {
      because: `${implementation.name} is implemented on ${implementation.surface}; you are missing ${missing
        .map((entry) => `${entry.kind} ${entry.need}`)
        .join(', ')}.`,
      missing,
      missingInputs,
      registry,
      now,
    })
  }

  return answer(record, target, 'yes', {
    because:
      implementation.auth.credential === 'none'
        ? `${implementation.name} is implemented on ${implementation.surface} and needs no credential.`
        : implementation.auth.unknown
          ? `${implementation.name} is implemented on ${implementation.surface}; its guard was never declared, so try it rather than requesting it.`
          : `${implementation.name} is implemented on ${implementation.surface} and the ${implementation.auth.credential} you already hold reaches it.`,
    missing: [],
    missingInputs,
    registry,
    now,
  })
}

function answer(
  record,
  target,
  verdict,
  { because, missing = [], missingInputs = [], registry = null, now = Date.now() } = {},
) {
  const implementation = target.capability
  const result = {
    query: record.name,
    verdict,
    /*
     * The two fields that would have prevented the measured waste, kept apart
     * because they answer different requests.
     *
     * alreadyGranted — this name is already in your hand. Twenty-one requests
     * were filed for tools in exactly this state.
     * alreadyBuilt   — something implements it, so proposing to build it is
     *                  proposing a duplicate. The capability proposed eighteen
     *                  times was in this state the entire time.
     */
    alreadyGranted: record.status === 'granted-schema',
    alreadyBuilt: Boolean(implementation),
    capability: record,
    resolvedTo: implementation ? implementation.id : null,
    invoke: implementation ? implementation.invoke : null,
    auth: implementation ? implementation.auth : record.auth,
    because,
    missing,
    /* Not a blocker — a chain. `composeWith` below names what supplies them. */
    missingInputs,
    evidence: implementation ? summarizeEvidence(implementation, now) : null,
    composeWith:
      registry && implementation
        ? composableWith(registry, implementation.id).fedBy.map((entry) => entry.id)
        : [],
    via: target.via,
  }

  return result
}

/**
 * Follow a granted name to the thing that actually runs.
 *
 * This is the sentence in the proposal — "a name can be resolved to what it
 * actually is" — as code. `mac_run_actions` is a Realtime tool schema on the
 * voice surface; what runs is POST /execute on the Mac. Asking whether the
 * voice agent can run a Mac action is really asking whether the Mac is online
 * and AGENT_TOKEN is set, and only the pointer makes that one lookup.
 */
export function resolveImplementation(registry, record, seen = new Set()) {
  if (!record) return { capability: null, via: [] }
  if (record.status === 'implemented') return { capability: record, via: [] }
  if (record.status === 'retired') return { capability: null, via: [] }
  if (seen.has(record.id)) return { capability: null, via: [...seen] }

  seen.add(record.id)
  for (const id of record.implementedBy) {
    const next = registry.capabilities.get(id)
    if (!next) continue
    const found = resolveImplementation(registry, next, seen)
    if (found.capability) {
      return { capability: found.capability, via: [record.id, ...found.via] }
    }
  }

  return { capability: null, via: [record.id] }
}

function summarizeEvidence(record, now) {
  if (record.evidence.length === 0) return null
  const successes = record.evidence.filter((entry) => entry.ok)
  const latest = successes[0] ?? record.evidence[0]
  const age = now - Date.parse(latest.at)

  return {
    lastStatus: latest.status,
    lastAt: latest.at,
    lastBy: latest.by,
    /* Past the TTL it is history, not proof — see EVIDENCE_TTL_MS. Reported
     * either way, because "it worked yesterday" still beats guessing. */
    fresh: age <= EVIDENCE_TTL_MS,
    successes: successes.length,
    failures: record.evidence.length - successes.length,
  }
}

/* ---- composition -------------------------------------------------------- */

/**
 * What this can be chained with, derived from requires/provides.
 *
 * `fedBy` are capabilities that produce a handle this one needs — the answer to
 * "where do I get a jobId". `feeds` are the ones this one unblocks. Nothing
 * here is hand-maintained: for HTTP capabilities the requirements come straight
 * out of the path parameters, so a new /jobs/:jobId/* route joins the graph the
 * moment its surface publishes.
 */
export function composableWith(registry, id) {
  const record = registry.capabilities.get(id)
  if (!record) return { fedBy: [], feeds: [] }

  const fedBy = []
  const feeds = []

  for (const other of registry.capabilities.values()) {
    if (other.id === record.id) continue
    if (other.provides.some((handle) => record.requires.includes(handle))) {
      fedBy.push(other)
    }
    if (record.provides.some((handle) => other.requires.includes(handle))) {
      feeds.push(other)
    }
  }

  const byId = (left, right) => left.id.localeCompare(right.id)
  return { fedBy: fedBy.sort(byId), feeds: feeds.sort(byId) }
}

/* ---- reports ------------------------------------------------------------ */

/**
 * What the registry knows about its own gaps.
 *
 * Modelled on capabilityManifest.js's `undocumentedGroups`: a discovery
 * artifact that cannot report its own rot becomes the next thing nobody trusts.
 */
export function capabilityRegistryReport(registry, { now = Date.now() } = {}) {
  const all = [...registry.capabilities.values()]
  const bySurface = {}
  for (const surface of CAPABILITY_SURFACES) {
    const owned = all.filter((record) => record.surface === surface)
    if (owned.length === 0 && !registry.surfaces.has(surface)) continue
    bySurface[surface] = {
      registered: registry.surfaces.has(surface),
      inventorySource: registry.surfaces.get(surface)?.inventorySource ?? null,
      count: owned.length,
      implemented: owned.filter((record) => record.status === 'implemented').length,
      grantedSchemas: owned.filter((record) => record.status === 'granted-schema').length,
    }
  }

  /* A name a caller holds that runs nothing. The twenty-one duplicate tool
   * requests are the downstream cost of never counting these. */
  const danglingGrants = all
    .filter((record) => record.status === 'granted-schema')
    .filter((record) => !resolveImplementation(registry, record).capability)
    .map((record) => record.id)

  /* Reachable by nobody until someone says what guards it. Not an error — the
   * relay will start here, since deriving 41 routes is easy and deriving their
   * scopes safely is the part that needs care. */
  const undeclaredAuth = all
    .filter((record) => record.status === 'implemented' && record.auth.unknown)
    .map((record) => record.id)

  /* Only primary collisions: two capabilities that call themselves the same
   * thing. Loose-index collisions are normal — GET /jobs and POST /jobs share
   * a noun — and reporting those would bury the real ones. */
  const collisions = []
  for (const [key, ids] of registry.primaryIndex) {
    if (ids.size > 1) collisions.push({ name: key, ids: [...ids].sort() })
  }

  return {
    version: CAPABILITY_REGISTRY_VERSION,
    generatedAt: new Date(now).toISOString(),
    count: all.length,
    coverage: registryCoverage(registry),
    bySurface,
    danglingGrants,
    undeclaredAuth,
    /* Two capabilities a caller cannot tell apart by name. Reported rather than
     * resolved: the fix is a rename by whoever owns them. */
    ambiguousNames: collisions.sort((left, right) => left.name.localeCompare(right.name)),
    withEvidence: all.filter((record) => record.evidence.length > 0).length,
  }
}

/**
 * The prompt-sized answer to "what can I do right now".
 *
 * This is the artifact that has to reach an agent BEFORE it writes a proposal.
 * Everything above is a lookup for an agent that already suspects something
 * exists; the measured failure is that it did not suspect. Lines are ordered
 * yes-first because an agent that reads half of this must read the usable half,
 * and the closing line names the unpublished surfaces so a truncated list is
 * never mistaken for a complete one.
 */
export function capabilityDigest(
  registry,
  { principal = {}, maxBytes = DEFAULT_DIGEST_BYTES, now = Date.now() } = {},
) {
  const budget = Math.min(
    Math.max(Number(maxBytes) || DEFAULT_DIGEST_BYTES, 0),
    MAX_DIGEST_BYTES,
  )

  const rows = []
  for (const record of registry.capabilities.values()) {
    if (record.status === 'retired') continue
    // Granted schemas are reported through their implementation, so a tool and
    // the route behind it are one line, not two.
    if (record.status === 'granted-schema' && resolveImplementation(registry, record).capability) {
      continue
    }
    const verdict = canInvoke(registry, record.id, principal, { now })
    rows.push({ record, verdict })
  }

  const rank = { yes: 0, blocked: 1, unimplemented: 2, unknown: 3 }
  /*
   * Verdict first, then kind. Kind matters because the Mac alone registers 95
   * action types against ~120 routes, and sorting by id alone puts every
   * `mac:action:*` ahead of every `mac:http:*` — a digest that spends its whole
   * budget on browser_click and never mentions /jobs. The measured duplicates
   * were route-shaped, so routes lead.
   */
  const kindRank = { http: 0, tool: 1, action: 2 }
  rows.sort(
    (left, right) =>
      (rank[left.verdict.verdict] ?? 9) - (rank[right.verdict.verdict] ?? 9) ||
      (kindRank[left.record.kind] ?? 9) - (kindRank[right.record.kind] ?? 9) ||
      left.record.id.localeCompare(right.record.id),
  )

  const lines = []
  let bytes = 0
  let dropped = 0

  for (const { record, verdict } of rows) {
    const line = digestLine(record, verdict)
    const cost = Buffer.byteLength(`${line}\n`)
    if (bytes + cost > budget) {
      dropped += 1
      continue
    }
    lines.push(line)
    bytes += cost
  }

  const coverage = registryCoverage(registry)
  return {
    lines,
    bytes,
    dropped,
    coverage,
    text: [
      ...lines,
      dropped > 0 ? `(+${dropped} more, over the ${budget}-byte budget)` : null,
      coverage.unpublished.length > 0
        ? `Not covered here: ${coverage.unpublished.join(', ')} — those surfaces publish no inventory, so this list is not exhaustive.`
        : null,
    ]
      .filter(Boolean)
      .join('\n'),
  }
}

function digestLine(record, verdict) {
  const where =
    record.kind === 'http'
      ? `${record.invoke.method} ${record.invoke.path}`
      : record.invoke.tool ?? record.invoke.action
  const mark = verdict.verdict === 'yes' ? 'YES' : verdict.verdict.toUpperCase()
  const need =
    verdict.missing.length > 0
      ? ` needs ${verdict.missing.map((entry) => entry.need).join('+')}`
      : ''
  const chain =
    verdict.missingInputs.length > 0
      ? ` after ${verdict.missingInputs.join('+')}`
      : ''

  return `${mark} ${record.surface} ${where}${need}${chain}`
}

/* ---- adapters ----------------------------------------------------------- */

/**
 * Register a surface from the manifest local-agent/capabilityManifest.js
 * already builds.
 *
 * Takes the object, not the module: importing it here would pull the Mac's
 * config, executor and macOS permission probes into every body that wants to
 * read a registry, and the relay cannot load them at all. The Mac calls this
 * with its own manifest; nothing is re-derived and nothing is typed twice.
 */
export function registerFromCapabilityManifest(
  registry,
  manifest,
  { surface = 'mac', credential = 'agent-token', baseUrl = null, now = Date.now() } = {},
) {
  if (!manifest?.http?.routes) {
    throw new TypeError(
      'registerFromCapabilityManifest needs a manifest with http.routes (see local-agent/capabilityManifest.js).',
    )
  }

  registerSurface(
    registry,
    {
      surface,
      inventorySource: 'capability-manifest (express router stack)',
      publishesAt: 'GET /capabilities',
      note: manifest.service ?? null,
    },
    { now },
  )

  const groupNote = new Map(
    (manifest.http.groups ?? []).map((group) => [group.group, group]),
  )

  const inputs = manifest.http.routes.map((route) => {
    const group = groupNote.get(route.group || '/') ?? {}
    return {
      name: `${route.method} ${route.path}`,
      surface,
      kind: 'http',
      status: 'implemented',
      invoke: {
        method: route.method,
        path: route.path,
        baseUrl: baseUrl ?? manifest.http.baseUrl ?? null,
      },
      auth: {
        credential: route.auth === 'public' ? 'none' : credential,
        note: manifest.http.auth?.statusContract
          ? `401 means the route exists and the token is wrong; 404 means no such route.`
          : null,
      },
      /* The route's own line first, its family's only as a fallback. A group
       * blurb is shared by every sibling, so scoring against it alone made
       * /evidence/revoke and /evidence/sweep the same capability to a matcher.
       * Older manifests carry no per-route `what` and are unaffected. */
      what: route.what ?? group.what ?? null,
      module: route.module ?? group.module ?? null,
      /* A route that ends in a collection and returns ids is the usual source
       * of the ids its siblings require. Declared narrowly: only the parameters
       * a sibling route already asks for, so this stays derivation rather than
       * invention. */
      provides: providesFromRoute(route, manifest.http.routes),
    }
  })

  const actions = (manifest.actions?.types ?? []).map((action) => ({
    name: action.type,
    surface,
    kind: 'action',
    /* Dispatchable by the executor = implemented, even when the planner has
     * never heard of it. The reverse — advertised to the planner, dropped by
     * sanitizeActions — is exactly the granted-schema-with-nothing-behind-it
     * shape, and capabilityManifest.describeActions() already computes it. */
    status: 'implemented',
    invoke: { action: action.type },
    auth: { credential, note: 'Dispatched through POST /execute.' },
    requires: [],
    /* What the action DOES, plus the drift warning when it applies — they are
     * different facts and the second used to displace the first, which is how
     * every planner-advertised type arrived here describing nothing at all. */
    what:
      [
        action.what ?? null,
        action.plannerAdvertised
          ? null
          : 'Executes over POST /execute but is stripped from LLM-authored plans by llmPlanner.sanitizeActions.',
      ]
        .filter(Boolean)
        .join(' ') || null,
    module: manifest.actions?.executor ?? null,
  }))

  return registerCapabilities(registry, [...inputs, ...actions], { now })
}

function providesFromRoute(route, allRoutes) {
  if (route.params?.length) return []
  const prefix = `${route.path.replace(/\/+$/, '')}/`
  const supplies = new Set()

  for (const other of allRoutes) {
    if (!other.path.startsWith(prefix)) continue
    for (const param of other.params ?? []) supplies.add(param)
  }

  return [...supplies]
}

/**
 * Register granted tool schemas — cloud-relay/openaiRealtimeVoice.js
 * REALTIME_TOOLS, or any other list of names handed to a model.
 *
 * These are the archetype of the second measured failure: a name in a system
 * prompt is not a capability, and twenty-one requests were filed for names
 * already in exactly this state. `implementedBy` is the wiring that turns the
 * name into an answer; leaving it empty is legal and shows up in the report as
 * a dangling grant, which is a finding rather than a silence.
 */
export function registerGrantedTools(
  registry,
  tools,
  { surface = 'voice', implementedBy = {}, credential = 'none', now = Date.now() } = {},
) {
  registerSurface(
    registry,
    {
      surface,
      inventorySource: 'tool-schema',
      note: 'Names granted to a model. Granted, not implemented.',
    },
    { now },
  )

  const inputs = (Array.isArray(tools) ? tools : []).map((tool) => ({
    name: tool?.name,
    surface,
    kind: 'tool',
    status: 'granted-schema',
    invoke: { tool: tool?.name },
    auth: { credential, note: 'The model calls it; the session carries the auth.' },
    implementedBy: implementedBy[tool?.name] ?? [],
    requires: requiredToolArguments(tool),
    what: firstSentence(tool?.description),
  }))

  return registerCapabilities(registry, inputs, { now })
}

function requiredToolArguments(tool) {
  const required = tool?.parameters?.required
  return Array.isArray(required) ? required : []
}

function firstSentence(text) {
  const value = String(text ?? '').trim()
  if (!value) return null
  const stop = value.indexOf('. ')
  return stop === -1 ? value.slice(0, 200) : value.slice(0, stop + 1)
}

/** Everything registered, optionally narrowed. Sorted so output is diffable. */
export function listCapabilities(registry, { surface = null, status = null } = {}) {
  return [...registry.capabilities.values()]
    .filter((record) => !surface || record.surface === surface)
    .filter((record) => !status || record.status === status)
    .sort((left, right) => left.id.localeCompare(right.id))
}

/* ---- the wire ----------------------------------------------------------- */

/**
 * The flat form one body serves and another reads.
 *
 * This is what a surface would put behind its own inventory route — the Mac at
 * GET /capabilities, the relay at a GET /v1/capabilities it does not yet have.
 * Maps and Sets do not survive JSON, and the indexes are derived anyway, so the
 * snapshot carries only the two things that cannot be recomputed: the records
 * and who published them.
 */
export function toCapabilityRegistrySnapshot(registry, { now = Date.now() } = {}) {
  return {
    version: CAPABILITY_REGISTRY_VERSION,
    generatedAt: new Date(now).toISOString(),
    surfaces: [...registry.surfaces.values()],
    capabilities: listCapabilities(registry),
  }
}

/**
 * Fold another body's snapshot into this registry.
 *
 * A snapshot is a CLAIM, not a fact, so by default a body is believed only
 * about the surfaces it declared it publishes. Without that rule the relay's
 * inventory could redefine what POST /execute on the Mac requires, and a
 * discovery answer that one body can rewrite for another is worse than no
 * answer. Records outside the declared surfaces are returned in `rejected`
 * rather than dropped in silence.
 *
 * Evidence merges rather than overwrites in either direction: the peer's 200s
 * are the entire reason to read their snapshot — that was the third measured
 * failure, two agents asking for access their peers had already demonstrated.
 */
export function mergeCapabilityRegistrySnapshot(
  registry,
  snapshot,
  { now = Date.now(), surfaces = null } = {},
) {
  if (Number(snapshot?.version) !== CAPABILITY_REGISTRY_VERSION) {
    throw new TypeError(
      `Snapshot version ${snapshot?.version} is not ${CAPABILITY_REGISTRY_VERSION}; refusing to half-read it.`,
    )
  }

  const declared = new Set(
    (snapshot.surfaces ?? []).map((entry) => String(entry?.surface ?? '').trim().toLowerCase()),
  )
  const allowed = surfaces
    ? new Set(toList(surfaces).filter((surface) => declared.has(surface)))
    : declared

  for (const entry of snapshot.surfaces ?? []) {
    if (!allowed.has(entry?.surface)) continue
    registerSurface(registry, entry, { now })
  }

  const registered = []
  const rejected = []

  for (const record of snapshot.capabilities ?? []) {
    if (!allowed.has(record?.surface)) {
      rejected.push({
        input: record,
        error: `Snapshot declares surfaces ${[...declared].join(', ') || '(none)'} and cannot speak for ${record?.surface}.`,
      })
      continue
    }

    try {
      const stored = registerCapability(registry, record, { now })
      stored.evidence = mergeEvidence(stored.evidence, record.evidence)
      registered.push(stored)
    } catch (error) {
      rejected.push({ input: record, error: error.message })
    }
  }

  return { registered, rejected }
}

function mergeEvidence(left, right) {
  const seen = new Set()
  const merged = []

  for (const entry of [...(left ?? []), ...(right ?? [])]) {
    if (!entry?.at) continue
    const identity = `${entry.at}|${entry.status}|${entry.by ?? ''}`
    if (seen.has(identity)) continue
    seen.add(identity)
    merged.push(entry)
  }

  return merged
    .sort((first, second) => Date.parse(second.at) - Date.parse(first.at))
    .slice(0, MAX_EVIDENCE_PER_CAPABILITY)
}

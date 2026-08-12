/*
 * One file for the whole contract: naming, resolution, the verdict, evidence,
 * composition, and the Express adapter driving a real Express app.
 *
 * Together on purpose. The
 * interesting failures here are not inside any one layer, they are between
 * them: a normalizer that collapses two routes the resolver then reports as
 * ambiguous forever, an adapter that derives routes correctly but probes the
 * scope function with a path its own regexes cannot match. A test per layer
 * would pass while the registry is useless.
 *
 * The fixtures are shaped from the real thing but are NOT imported from it.
 * local-agent/capabilityManifest.js pulls the Mac's config, executor and macOS
 * permission probes at import time, and cloud-relay/server.js starts a server;
 * importing either would make this file fail for reasons that have nothing to
 * do with the registry. The shapes are pinned in comments instead, next to the
 * file they come from.
 *
 * Every scenario below is one of the three measured failures from the overnight
 * nine-agent run, reproduced: a capability proposed eighteen times that had
 * already shipped, twenty-one requests for already-granted tools, and two
 * agents asking for access their own token already carried while their peers'
 * HTTP 200s sat unread in the shared store.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  CAPABILITY_SURFACES,
  DEFAULT_DIGEST_BYTES,
  EVIDENCE_TTL_MS,
  MAX_DIGEST_BYTES,
  MAX_EVIDENCE_PER_CAPABILITY,
  canInvoke,
  capabilityDigest,
  capabilityId,
  capabilityRegistryReport,
  composableWith,
  createCapabilityRegistry,
  defineCapability,
  listCapabilities,
  normalizeCapabilityName,
  recordCapabilityObservation,
  registerCapabilities,
  registerCapability,
  registerFromCapabilityManifest,
  registerGrantedTools,
  mergeCapabilityRegistrySnapshot,
  registerSurface,
  resolveCapability,
  resolveImplementation,
  toCapabilityRegistrySnapshot,
} from './capabilityRegistry.js'

const NOW = Date.parse('2026-08-07T12:00:00.000Z')

/*
 * Shaped exactly like buildCapabilityManifest() in
 * local-agent/capabilityManifest.js: http.routes carries {method, path, group,
 * params, auth}, http.groups carries {group, what, module}, actions.types
 * carries {type, plannerAdvertised, handsFree, ...}. Four routes, not 120 —
 * enough to cover public, bearer, parameterised and collection.
 */
const MAC_MANIFEST = {
  service: 'AI Pendant Mac Local Agent',
  http: {
    baseUrl: 'http://127.0.0.1:8000',
    auth: { statusContract: { 401: 'route exists, token missing or wrong' } },
    groups: [
      {
        group: 'jobs',
        what: 'Every plan/execute run, its receipts, cancel and undo.',
        module: 'local-agent/jobTracker.js + undo.js',
      },
      {
        group: 'execute',
        what: 'Run an approved action list. Returns a receipt per action.',
        module: 'local-agent/orchestrator.js + executor.js',
      },
    ],
    routes: [
      { method: 'GET', path: '/health', group: 'health', params: [], auth: 'public' },
      { method: 'GET', path: '/jobs', group: 'jobs', params: [], auth: 'bearer' },
      {
        method: 'GET',
        path: '/jobs/:jobId/receipts',
        group: 'jobs',
        params: ['jobId'],
        auth: 'bearer',
      },
      { method: 'POST', path: '/execute', group: 'execute', params: [], auth: 'bearer' },
    ],
  },
  actions: {
    executor: 'local-agent/computerControl.js',
    types: [
      { type: 'open_app', plannerAdvertised: true, handsFree: true },
      /* The real drift capabilityManifest.describeActions() reports: executes
       * over POST /execute, stripped from LLM plans by sanitizeActions. */
      { type: 'set_volume', plannerAdvertised: false, handsFree: true },
    ],
  },
}

/* Shaped like REALTIME_TOOLS in cloud-relay/openaiRealtimeVoice.js. */
const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'mac_run_actions',
    description:
      'PROACTIVE for reversible control. Execute 1-3 concrete Mac actions when the Mac surface is online.',
    parameters: { type: 'object', properties: {}, required: ['actions'] },
  },
  {
    type: 'function',
    name: 'relay_job_status',
    description: 'PROACTIVE. Answer what happened to work already handed to the Mac.',
    parameters: { type: 'object', properties: {}, required: [] },
  },
  {
    type: 'function',
    name: 'web_search',
    description: 'PROACTIVE for live public facts.',
    parameters: { type: 'object', properties: {}, required: ['query'] },
  },
]

const EXECUTE_ID = 'mac:http:POST /execute'
const RECEIPTS_ID = 'mac:http:GET /jobs/*/receipts'

function macRegistry() {
  const registry = createCapabilityRegistry()
  registerFromCapabilityManifest(registry, MAC_MANIFEST, { now: NOW })
  registerGrantedTools(registry, REALTIME_TOOLS, {
    surface: 'voice',
    implementedBy: { mac_run_actions: [EXECUTE_ID] },
    now: NOW,
  })
  return registry
}

/*
 * The relay surface, declared directly. This used to be probed off a live
 * Express router by shared/capabilityRegistryExpress.js; that adapter was
 * never wired into a real surface and is gone, so the fixture now states the
 * same records the probe used to derive: scopes as cloud-relay/server.js's
 * requiredScopesForRequest() answers them, /health public, and /v1/undeclared
 * deliberately outside the scope table — the honest answer for it is
 * "unknown", not a guessed default.
 */
function registerRelaySurface(registry) {
  registerSurface(registry, { surface: 'relay', inventorySource: 'declared' }, { now: NOW })

  const route = (method, path, auth, provides = []) => ({
    name: `${method} ${path}`,
    surface: 'relay',
    kind: 'http',
    status: 'implemented',
    invoke: { method, path, baseUrl: 'https://relay.example' },
    auth,
    provides,
  })

  registerCapabilities(
    registry,
    [
      route('GET', '/health', { credential: 'none', scopes: [], note: null }),
      route('POST', '/v1/pendant/announce', {
        credential: 'device-token',
        scopes: ['pendant:announce'],
        note: null,
      }),
      route('GET', '/v1/mac/jobs/:jobId', {
        credential: 'device-token',
        scopes: ['mac:jobs:read'],
        note: null,
      }),
      route('POST', '/v1/ops/proxy', { credential: 'device-token', scopes: ['admin'], note: null }),
      route('GET', '/v1/undeclared', {
        credential: 'unknown',
        scopes: [],
        note: 'No scope declared for this route by the surface that owns it.',
      }),
    ],
    { now: NOW },
  )
  return registry
}

function fullRegistry() {
  return registerRelaySurface(macRegistry())
}

/* ---- names -------------------------------------------------------------- */

test('every spelling of the capability proposed eighteen times collapses to one key', () => {
  const spellings = [
    'POST /v1/pendant/announce',
    '/v1/pendant/announce',
    'pendantAnnounce',
    'pendant announce',
    'the pendant announce endpoint',
    'pendant-announce',
  ]

  const keys = new Set(spellings.map((name) => normalizeCapabilityName(name)))
  assert.deepEqual([...keys], ['pendant announce'])
})

test('job receipts normalizes the same whether written as a path or a phrase', () => {
  assert.equal(normalizeCapabilityName('GET /jobs/:jobId/receipts'), 'job receipt')
  assert.equal(normalizeCapabilityName('/jobs/{jobId}/receipts'), 'job receipt')
  assert.equal(normalizeCapabilityName('getJobReceipts'), 'job receipt')
  assert.equal(normalizeCapabilityName('job receipts'), 'job receipt')
})

test('the strict form keeps the verb and the parameter so REST pairs stay distinct', () => {
  const strict = { keepParams: true }
  assert.notEqual(
    normalizeCapabilityName('GET /jobs', strict),
    normalizeCapabilityName('POST /jobs', strict),
  )
  assert.equal(normalizeCapabilityName('/jobs/:jobId', strict), 'job jobid')
  assert.equal(normalizeCapabilityName('/jobs/{job_id}', strict), 'job jobid')
  // The loose form is where they collapse, which is what makes guesses match.
  assert.equal(normalizeCapabilityName('GET /jobs'), normalizeCapabilityName('POST /jobs'))
})

test('a leading access verb is stripped but the same word inside a name is kept', () => {
  assert.equal(normalizeCapabilityName('run_shell'), 'shell')
  assert.equal(normalizeCapabilityName('mac_run_actions'), 'mac run action')
})

test('the identifier is stable across parameter spellings and unstable across paths', () => {
  const left = capabilityId({
    surface: 'mac',
    kind: 'http',
    invoke: { method: 'get', path: '/jobs/:jobId/receipts' },
  })
  const right = capabilityId({
    surface: 'mac',
    kind: 'http',
    invoke: { method: 'GET', path: '/jobs/{id}/receipts' },
  })

  assert.equal(left, right)
  assert.equal(left, RECEIPTS_ID)
  // A moved route is a different capability to everyone holding the old one.
  assert.notEqual(
    left,
    capabilityId({
      surface: 'mac',
      kind: 'http',
      invoke: { method: 'GET', path: '/v2/jobs/:jobId/receipts' },
    }),
  )
})

/* ---- records ------------------------------------------------------------ */

test('a typo in the surface name is rejected rather than filed where nobody looks', () => {
  assert.throws(
    () => defineCapability({ name: 'x', surface: 'cloud-relay', invoke: { path: '/x' } }),
    /surface must be one of/,
  )
  assert.throws(
    () => defineCapability({ name: 'x', surface: 'mac', kind: 'rpc', invoke: { path: '/x' } }),
    /kind must be one of/,
  )
  assert.throws(
    () =>
      defineCapability({
        name: 'x',
        surface: 'mac',
        status: 'maybe',
        invoke: { path: '/x' },
      }),
    /status must be one of/,
  )
  assert.throws(
    () => defineCapability({ name: 'x', surface: 'mac', invoke: { path: 'jobs' } }),
    /absolute path/,
  )
})

test('a granted schema cannot be its own implementation', () => {
  assert.throws(
    () =>
      defineCapability({
        name: 'web_search',
        surface: 'voice',
        kind: 'tool',
        status: 'granted-schema',
        implementedBy: ['voice:tool:web_search'],
      }),
    /cannot implement itself/,
  )
})

test('path parameters become requirements without anyone writing them down', () => {
  const record = defineCapability({
    name: 'GET /jobs/:jobId/receipts',
    surface: 'mac',
    kind: 'http',
    invoke: { method: 'GET', path: '/jobs/:jobId/receipts' },
    auth: { credential: 'agent-token' },
  })

  assert.deepEqual(record.requires, ['jobId'])
})

test('auth that was never declared reports as unknown instead of as open', () => {
  const record = defineCapability({
    name: 'GET /x',
    surface: 'relay',
    kind: 'http',
    invoke: { path: '/x' },
  })

  assert.equal(record.auth.credential, 'unknown')
  assert.equal(record.auth.unknown, true)
})

/* ---- manifest adapter --------------------------------------------------- */

test('the Mac manifest registers as routes and actions with derived composition', () => {
  const registry = macRegistry()
  const routes = listCapabilities(registry, { surface: 'mac' })

  assert.equal(routes.length, MAC_MANIFEST.http.routes.length + MAC_MANIFEST.actions.types.length)

  const health = registry.capabilities.get('mac:http:GET /health')
  assert.equal(health.auth.credential, 'none')

  const execute = registry.capabilities.get(EXECUTE_ID)
  assert.equal(execute.auth.credential, 'agent-token')
  assert.equal(execute.invoke.baseUrl, 'http://127.0.0.1:8000')
  assert.equal(execute.what, 'Run an approved action list. Returns a receipt per action.')

  // /jobs is the only place a jobId comes from, derived from its own children.
  assert.deepEqual(registry.capabilities.get('mac:http:GET /jobs').provides, ['jobId'])
  assert.deepEqual(registry.capabilities.get(RECEIPTS_ID).requires, ['jobId'])
})

test('an action the planner never hears about is still registered as implemented', () => {
  const registry = macRegistry()
  const setVolume = registry.capabilities.get('mac:action:set_volume')

  assert.equal(setVolume.status, 'implemented')
  assert.match(setVolume.what, /stripped from LLM-authored plans/)
})

test('a manifest without routes is refused rather than registered empty', () => {
  assert.throws(
    () => registerFromCapabilityManifest(createCapabilityRegistry(), { service: 'x' }),
    /http\.routes/,
  )
})

/* ---- resolution --------------------------------------------------------- */

test('an exact name resolves even when a looser spelling is shared', () => {
  const registry = createCapabilityRegistry()
  const common = { surface: 'mac', kind: 'http', auth: { credential: 'agent-token' } }
  registerCapability(registry, { ...common, name: 'GET /jobs', invoke: { method: 'GET', path: '/jobs' } })
  registerCapability(registry, { ...common, name: 'POST /jobs', invoke: { method: 'POST', path: '/jobs' } })

  assert.equal(resolveCapability(registry, 'GET /jobs').capability.id, 'mac:http:GET /jobs')
  assert.equal(resolveCapability(registry, 'POST /jobs').capability.id, 'mac:http:POST /jobs')

  // "jobs" alone genuinely is ambiguous, and saying so beats guessing.
  const loose = resolveCapability(registry, 'jobs')
  assert.equal(loose.status, 'ambiguous')
  assert.equal(loose.candidates.length, 2)
})

test('a capability resolves by its stable id without going through the matcher', () => {
  const registry = macRegistry()
  assert.equal(resolveCapability(registry, EXECUTE_ID).capability.id, EXECUTE_ID)
})

test('an unknown name carries the near misses that would have ended the duplicate', () => {
  const registry = macRegistry()
  const resolved = resolveCapability(registry, 'a receipts endpoint for jobs')

  assert.equal(resolved.status, 'unknown')
  assert.equal(resolved.suggestions[0].capability.id, RECEIPTS_ID)
})

/* ---- the relay gap ------------------------------------------------------ */

test('an unpublished surface makes "unknown" mean blindness, not absence', () => {
  const registry = macRegistry()
  const resolved = resolveCapability(registry, 'pendant announce')

  assert.equal(resolved.status, 'unknown')
  // The measured cause: the relay has 41 routes and publishes no inventory, so
  // POST /v1/pendant/announce could not be seen and was proposed anyway.
  assert.ok(resolved.coverage.unpublished.includes('relay'))

  const verdict = canInvoke(registry, 'pendant announce', {}, { now: NOW })
  assert.equal(verdict.verdict, 'unknown')
  assert.match(verdict.because, /relay/)
  assert.match(verdict.because, /not evidence of absence/)
})

test('once the relay registers itself the announce route answers as already built', () => {
  const registry = fullRegistry()
  const verdict = canInvoke(
    registry,
    'the pendant announce endpoint',
    {
      credentials: ['device-token'],
      scopes: ['pendant:announce'],
      onlineSurfaces: ['relay'],
    },
    { now: NOW },
  )

  assert.equal(verdict.verdict, 'yes')
  assert.equal(verdict.alreadyBuilt, true)
  assert.deepEqual(verdict.invoke, {
    method: 'POST',
    path: '/v1/pendant/announce',
    baseUrl: 'https://relay.example',
  })
  assert.equal(resolveCapability(registry, 'pendant announce').coverage.unpublished.includes('relay'), false)
})

/* ---- the verdict -------------------------------------------------------- */

test('a held credential answers yes without a probe', () => {
  const registry = macRegistry()
  const verdict = canInvoke(
    registry,
    'GET /jobs/:jobId/receipts',
    { credentials: ['agent-token'], holds: ['jobId'], onlineSurfaces: ['mac'] },
    { now: NOW },
  )

  assert.equal(verdict.verdict, 'yes')
  assert.deepEqual(verdict.missing, [])
  assert.deepEqual(verdict.missingInputs, [])
  assert.match(verdict.because, /you already hold/)
})

test('a missing scope is blocked, never mistaken for absent', () => {
  const registry = fullRegistry()
  const verdict = canInvoke(
    registry,
    'POST /v1/pendant/announce',
    { credentials: ['device-token'], scopes: ['mac:jobs:read'] },
    { now: NOW },
  )

  assert.equal(verdict.verdict, 'blocked')
  assert.equal(verdict.alreadyBuilt, true)
  assert.deepEqual(verdict.missing, [{ kind: 'scope', need: 'pendant:announce' }])
})

test('an offline surface blocks, and liveness is only judged when it is supplied', () => {
  const registry = macRegistry()
  const principal = { credentials: ['agent-token'] }

  assert.equal(
    canInvoke(registry, 'POST /execute', { ...principal, onlineSurfaces: ['relay'] }, { now: NOW })
      .verdict,
    'blocked',
  )
  assert.equal(canInvoke(registry, 'POST /execute', principal, { now: NOW }).verdict, 'yes')
})

test('a public route needs nothing and says so', () => {
  const registry = macRegistry()
  const verdict = canInvoke(registry, 'GET /health', {}, { now: NOW })

  assert.equal(verdict.verdict, 'yes')
  assert.match(verdict.because, /needs no credential/)
})

test('undeclared auth tells the caller to try it rather than to request it', () => {
  const registry = fullRegistry()
  const verdict = canInvoke(registry, 'GET /v1/undeclared', {}, { now: NOW })

  assert.equal(verdict.verdict, 'yes')
  assert.match(verdict.because, /never declared/)
})

/* ---- granted schemas ---------------------------------------------------- */

test('a granted tool resolves across surfaces to the route that actually runs', () => {
  const registry = macRegistry()
  const verdict = canInvoke(
    registry,
    'mac_run_actions',
    { credentials: ['agent-token'], onlineSurfaces: ['mac'] },
    { now: NOW },
  )

  assert.equal(verdict.verdict, 'yes')
  assert.equal(verdict.alreadyGranted, true)
  assert.equal(verdict.resolvedTo, EXECUTE_ID)
  assert.deepEqual(verdict.via, ['voice:tool:mac_run_actions'])
})

test('a granted name with nothing behind it answers unimplemented, not yes', () => {
  const registry = macRegistry()
  const verdict = canInvoke(registry, 'web_search', { credentials: ['agent-token'] }, { now: NOW })

  assert.equal(verdict.verdict, 'unimplemented')
  assert.equal(verdict.alreadyGranted, true)
  assert.equal(verdict.alreadyBuilt, false)
  assert.match(verdict.because, /Holding the name does not make the call work/)
})

test('a grant pointing at an id nobody registered names the id it is missing', () => {
  const registry = createCapabilityRegistry()
  registerGrantedTools(registry, [REALTIME_TOOLS[0]], {
    surface: 'voice',
    implementedBy: { mac_run_actions: [EXECUTE_ID] },
    now: NOW,
  })

  const verdict = canInvoke(registry, 'mac_run_actions', {}, { now: NOW })
  assert.equal(verdict.verdict, 'unimplemented')
  assert.match(verdict.because, new RegExp(EXECUTE_ID.replace(/[/*]/g, '\\$&')))
})

test('a grant cycle terminates instead of recursing', () => {
  const registry = createCapabilityRegistry()
  registerCapability(registry, {
    name: 'left',
    surface: 'voice',
    kind: 'tool',
    status: 'granted-schema',
    implementedBy: ['voice:tool:right'],
  })
  registerCapability(registry, {
    name: 'right',
    surface: 'voice',
    kind: 'tool',
    status: 'granted-schema',
    implementedBy: ['voice:tool:left'],
  })

  assert.equal(resolveImplementation(registry, registry.capabilities.get('voice:tool:left')).capability, null)
})

test('a retired capability keeps answering to its name', () => {
  const registry = createCapabilityRegistry()
  registerCapability(registry, {
    name: 'GET /v1/legacy/jobs',
    surface: 'relay',
    kind: 'http',
    status: 'retired',
    invoke: { path: '/v1/legacy/jobs' },
  })

  const verdict = canInvoke(registry, 'legacy jobs', {}, { now: NOW })
  assert.equal(verdict.verdict, 'unimplemented')
  assert.match(verdict.because, /retired/)
})

/* ---- evidence ----------------------------------------------------------- */

test("a peer's 200 is the answer two agents went and asked for instead", () => {
  const registry = macRegistry()
  recordCapabilityObservation(
    registry,
    { name: 'GET /jobs/:jobId/receipts', status: 200, by: 'agent/borg-episodes' },
    { now: NOW },
  )

  const verdict = canInvoke(
    registry,
    'job receipts',
    { credentials: ['agent-token'], holds: ['jobId'] },
    { now: NOW },
  )

  assert.equal(verdict.evidence.lastStatus, 200)
  assert.equal(verdict.evidence.lastBy, 'agent/borg-episodes')
  assert.equal(verdict.evidence.fresh, true)
  assert.equal(verdict.evidence.successes, 1)
})

test('evidence past its TTL is reported as stale rather than dropped', () => {
  const registry = macRegistry()
  recordCapabilityObservation(registry, { name: 'POST /execute', status: 200 }, { now: NOW })

  const later = NOW + EVIDENCE_TTL_MS + 1
  const verdict = canInvoke(registry, 'POST /execute', { credentials: ['agent-token'] }, { now: later })

  assert.equal(verdict.evidence.fresh, false)
  assert.equal(verdict.evidence.lastStatus, 200)
})

test('a success outranks a failure as the reported reading, and both are counted', () => {
  const registry = macRegistry()
  recordCapabilityObservation(registry, { name: 'POST /execute', status: 401 }, { now: NOW })
  recordCapabilityObservation(registry, { name: 'POST /execute', status: 200 }, { now: NOW + 1000 })

  const verdict = canInvoke(registry, 'POST /execute', { credentials: ['agent-token'] }, { now: NOW + 2000 })
  assert.equal(verdict.evidence.lastStatus, 200)
  assert.equal(verdict.evidence.successes, 1)
  assert.equal(verdict.evidence.failures, 1)
})

test('only the newest observations are kept', () => {
  const registry = macRegistry()
  for (let index = 0; index < MAX_EVIDENCE_PER_CAPABILITY + 3; index += 1) {
    recordCapabilityObservation(
      registry,
      { name: 'POST /execute', status: 200, at: new Date(NOW + index * 1000).toISOString() },
      { now: NOW },
    )
  }

  assert.equal(
    registry.capabilities.get(EXECUTE_ID).evidence.length,
    MAX_EVIDENCE_PER_CAPABILITY,
  )
})

test('re-registering a surface re-derives declarations and keeps observations', () => {
  const registry = macRegistry()
  recordCapabilityObservation(registry, { name: 'POST /execute', status: 200 }, { now: NOW })
  registerFromCapabilityManifest(registry, MAC_MANIFEST, { now: NOW + 60_000 })

  assert.equal(registry.capabilities.get(EXECUTE_ID).evidence.length, 1)
})

test('an observation on a name nobody registered is a lookup miss, not a throw', () => {
  const registry = macRegistry()
  assert.equal(
    recordCapabilityObservation(registry, { name: 'nothing here', status: 200 }, { now: NOW }).status,
    'unknown',
  )
  assert.throws(
    () => recordCapabilityObservation(registry, { name: 'POST /execute', status: 'ok' }, { now: NOW }),
    /numeric status/,
  )
})

/* ---- composition -------------------------------------------------------- */

test('where to get the jobId is derived, not documented', () => {
  const registry = macRegistry()
  const { fedBy } = composableWith(registry, RECEIPTS_ID)

  assert.deepEqual(fedBy.map((record) => record.id), ['mac:http:GET /jobs'])
  assert.deepEqual(
    composableWith(registry, 'mac:http:GET /jobs').feeds.map((record) => record.id),
    [RECEIPTS_ID],
  )
})

test('a caller without the handle is told what it still needs and who supplies it', () => {
  const registry = macRegistry()
  const verdict = canInvoke(
    registry,
    'job receipts',
    { credentials: ['agent-token'] },
    { now: NOW },
  )

  assert.equal(verdict.verdict, 'yes')
  assert.deepEqual(verdict.missingInputs, ['jobId'])
  assert.deepEqual(verdict.composeWith, ['mac:http:GET /jobs'])
})

/* ---- reports ------------------------------------------------------------ */

test('the report names its own gaps the way the manifest names undocumented groups', () => {
  const registry = fullRegistry()
  const report = capabilityRegistryReport(registry, { now: NOW })

  assert.deepEqual(report.danglingGrants, ['voice:tool:relay_job_status', 'voice:tool:web_search'])
  assert.deepEqual(report.undeclaredAuth, ['relay:http:GET /v1/undeclared'])
  assert.deepEqual(report.coverage.unpublished, ['browser', 'ios', 'pendant'])
  /* Both bodies serve GET /health, so "health" is genuinely ambiguous across
   * the fleet and the report says so rather than picking one. The stable id
   * carries the surface, which is how a caller that means one of them asks. */
  assert.deepEqual(report.ambiguousNames, [
    { name: 'get health', ids: ['mac:http:GET /health', 'relay:http:GET /health'] },
  ])
  assert.equal(report.bySurface.relay.inventorySource, 'declared')
  assert.equal(report.bySurface.voice.grantedSchemas, 3)
})

test('a surface that says hello and publishes nothing is reported as silent', () => {
  const registry = macRegistry()
  registerSurface(registry, { surface: 'browser', inventorySource: 'extension' }, { now: NOW })

  assert.deepEqual(capabilityRegistryReport(registry, { now: NOW }).coverage.silent, ['browser'])
})

test('two capabilities with the same full name are reported, not silently merged', () => {
  const registry = createCapabilityRegistry()
  registerCapability(registry, {
    name: 'web_search',
    surface: 'voice',
    kind: 'tool',
    status: 'granted-schema',
  })
  registerCapability(registry, {
    name: 'web_search',
    surface: 'relay',
    kind: 'tool',
    status: 'implemented',
  })

  const report = capabilityRegistryReport(registry, { now: NOW })
  assert.equal(report.ambiguousNames.length, 1)
  assert.deepEqual(report.ambiguousNames[0].ids, ['relay:tool:web_search', 'voice:tool:web_search'])
})

/* ---- digest ------------------------------------------------------------- */

test('the digest leads with what the caller can actually do', () => {
  const registry = fullRegistry()
  const digest = capabilityDigest(registry, {
    principal: { credentials: ['agent-token'], onlineSurfaces: ['mac'] },
    now: NOW,
  })

  assert.match(digest.lines[0], /^YES /)
  // A tool wired to a route is one line, not two.
  assert.equal(digest.lines.some((line) => line.includes('mac_run_actions')), false)
  assert.ok(digest.lines.some((line) => line.includes('POST /execute')))
  /* Routes before action types. The real Mac manifest carries 95 action types
   * against ~120 routes, so an id-ordered digest spends its entire budget on
   * browser_click and never reaches /jobs — and the measured duplicates were
   * all route-shaped. */
  assert.ok(
    digest.lines.findIndex((line) => line.includes('POST /execute')) <
      digest.lines.findIndex((line) => line.includes('open_app')),
  )
  // Blocked is present and labelled — the relay routes are real, just not reachable.
  assert.ok(digest.lines.some((line) => line.startsWith('BLOCKED relay')))
})

test('a truncated digest never passes itself off as exhaustive', () => {
  const registry = macRegistry()
  const digest = capabilityDigest(registry, { maxBytes: 60, now: NOW })

  assert.ok(digest.bytes <= 60)
  assert.ok(digest.dropped > 0)
  assert.match(digest.text, /over the 60-byte budget/)
  assert.match(digest.text, /publish no inventory/)
})

test('the digest budget is clamped at both ends', () => {
  const registry = macRegistry()
  assert.ok(capabilityDigest(registry, { maxBytes: 10 ** 9, now: NOW }).bytes <= MAX_DIGEST_BYTES)
  assert.ok(capabilityDigest(registry, { now: NOW }).bytes <= DEFAULT_DIGEST_BYTES)
})

/* ---- the wire ----------------------------------------------------------- */

test('a snapshot survives JSON and carries the peer observations that were the point', () => {
  const relay = registerRelaySurface(createCapabilityRegistry())
  recordCapabilityObservation(
    relay,
    { name: 'POST /v1/pendant/announce', status: 200, by: 'agent/graveyard-pendants' },
    { now: NOW },
  )

  const overWire = JSON.parse(JSON.stringify(toCapabilityRegistrySnapshot(relay, { now: NOW })))
  const mac = macRegistry()
  const { rejected } = mergeCapabilityRegistrySnapshot(mac, overWire, { now: NOW })

  assert.deepEqual(rejected, [])
  const verdict = canInvoke(
    mac,
    'pendant announce',
    { credentials: ['device-token'], scopes: ['pendant:announce'] },
    { now: NOW },
  )
  assert.equal(verdict.verdict, 'yes')
  assert.equal(verdict.evidence.lastBy, 'agent/graveyard-pendants')
})

test('a snapshot cannot redefine a surface it never claimed to publish', () => {
  const mac = macRegistry()
  const forged = {
    version: 1,
    surfaces: [{ surface: 'relay' }],
    capabilities: [
      {
        id: EXECUTE_ID,
        name: 'POST /execute',
        surface: 'mac',
        kind: 'http',
        status: 'implemented',
        invoke: { method: 'POST', path: '/execute' },
        auth: { credential: 'none' },
      },
    ],
  }

  const { registered, rejected } = mergeCapabilityRegistrySnapshot(mac, forged, { now: NOW })
  assert.equal(registered.length, 0)
  assert.match(rejected[0].error, /cannot speak for mac/)
  // Untouched: the Mac still says its own executor needs the agent token.
  assert.equal(mac.capabilities.get(EXECUTE_ID).auth.credential, 'agent-token')
})

test('a snapshot from another version is refused rather than half-read', () => {
  assert.throws(
    () => mergeCapabilityRegistrySnapshot(createCapabilityRegistry(), { version: 99 }),
    /refusing to half-read/,
  )
})

test('the surface vocabulary is shared with fleet memory', () => {
  /* The memory wire's surface vocabulary, not imported — pinned by value. The
   * four must stay a prefix of this list — a body named one way for facts and
   * another for capabilities is a body nothing can join on. */
  assert.deepEqual(CAPABILITY_SURFACES.slice(0, 4), ['voice', 'mac', 'browser', 'ios'])
})

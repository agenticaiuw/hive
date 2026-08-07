import assert from 'node:assert/strict'
import test from 'node:test'

import {
  createCapabilityRegistry,
  recordCapabilityObservation,
  registerCapabilities,
  registerSurface,
} from '../shared/capabilityRegistry.js'
/*
 * The real definition of "the public internet can reach this", not a stand-in.
 * The whole public-vs-authenticated rule rests on this function, so a test that
 * mocked it would prove the rule against a fiction.
 */
import { normalizePublicUrl } from '../cloud-relay/serverBrowser.js'
import {
  ACCESS,
  NEED,
  classifyAccess,
  deriveNeed,
  registerGoalRouterRoutes,
  rerouteAfterAttempt,
  routeGoal,
  splitGoalParts,
} from './goalRouter.js'
import { buildGoalRoutingContext, probeBrowserRun } from './goalRouterSurfaces.js'

/*
 * The same four registrations goalRouterSurfaces.js makes against the live
 * system, by hand, so the routing rules can be exercised without a Mac, an
 * extension or a Cloudflare account. Ids match production exactly
 * (capabilityId() derives them), which is what keeps this from drifting into a
 * test of a different system.
 */
function registry() {
  const store = createCapabilityRegistry()
  for (const surface of ['relay', 'browser', 'mac', 'voice']) {
    registerSurface(store, { surface, inventorySource: 'test' })
  }

  registerCapabilities(store, [
    {
      name: 'read_web_page',
      surface: 'relay',
      kind: 'tool',
      status: 'implemented',
      invoke: { tool: 'read_web_page' },
      auth: { credential: 'cloudflare-browser-run' },
    },
    {
      name: 'browser_run_actions',
      surface: 'browser',
      kind: 'action',
      status: 'implemented',
      invoke: { action: 'browser_run_actions' },
      auth: { credential: 'owner-web-session' },
    },
    {
      name: 'POST /execute',
      surface: 'mac',
      kind: 'http',
      status: 'implemented',
      invoke: { method: 'POST', path: '/execute' },
      auth: { credential: 'agent-token' },
    },
    /* Granted names, resolved through implementedBy — the production shape, so
     * the tests cover the indirection the router actually walks. */
    {
      name: 'read_web_page',
      surface: 'voice',
      kind: 'tool',
      status: 'granted-schema',
      invoke: { tool: 'read_web_page' },
      implementedBy: ['relay:tool:read_web_page'],
      aliases: ['goal web read'],
    },
    {
      name: 'browser_run_actions',
      surface: 'voice',
      kind: 'tool',
      status: 'granted-schema',
      invoke: { tool: 'browser_run_actions' },
      implementedBy: ['browser:action:browser_run_actions'],
      aliases: ['goal web read', 'goal web interact'],
    },
    {
      name: 'mac_run_actions',
      surface: 'voice',
      kind: 'tool',
      status: 'granted-schema',
      invoke: { tool: 'mac_run_actions' },
      implementedBy: ['mac:http:POST /execute'],
      aliases: ['goal mac control'],
    },
  ])

  return store
}

const SURFACES = {
  everythingUp: {
    mac: { online: true, attended: true, holdsOwnerSessions: true, network: 'owner' },
    browser: { online: true, attended: true, holdsOwnerSessions: true, network: 'owner' },
    relay: {
      online: true,
      attended: false,
      holdsOwnerSessions: false,
      network: 'public-internet',
    },
  },
}

function context(overrides = {}) {
  return {
    registry: registry(),
    principal: {
      credentials: ['agent-token', 'owner-web-session', 'cloudflare-browser-run'],
    },
    surfaces: SURFACES.everythingUp,
    reach: normalizePublicUrl,
    observations: [],
    now: Date.parse('2026-08-07T12:00:00Z'),
    ...overrides,
  }
}

const partOf = (plan, id) => plan.parts.find((part) => part.id === id)

/* ---- decomposition ------------------------------------------------------ */

test('a goal splits on sequencers and on "and <verb>", never on a bare and', () => {
  assert.deepEqual(
    splitGoalParts('read example.com and then check my orders; tell me the difference'),
    ['read example.com', 'check my orders', 'tell me the difference'],
  )

  // "search and rescue" is one noun phrase, not two steps.
  assert.deepEqual(splitGoalParts('look up search and rescue teams near me'), [
    'look up search and rescue teams near me',
  ])

  assert.deepEqual(splitGoalParts('   '), [])
})

/* ---- what a part needs -------------------------------------------------- */

test('a part is classified by what it touches, not by which body is up', () => {
  assert.equal(deriveNeed('read example.com/pricing').kind, NEED.WEB_READ)
  assert.equal(deriveNeed('read example.com/pricing').target.url, 'example.com/pricing')

  assert.equal(deriveNeed('click the renew button on example.com').kind, NEED.WEB_INTERACT)

  // No address, but a resource that only exists inside a session.
  const orders = deriveNeed('check my orders')
  assert.equal(orders.kind, NEED.WEB_READ)
  assert.equal(orders.target.kind, 'owner-resource')

  assert.equal(deriveNeed('look up the ferry timetable').kind, NEED.WEB_SEARCH)
  assert.equal(deriveNeed('set the volume to 30').kind, NEED.MAC_CONTROL)
  assert.equal(deriveNeed('tell me the difference').kind, NEED.SPEAK)

  // "Notes.app" is an application; the bare-hostname pattern must not claim it.
  assert.equal(deriveNeed('open Notes.app').kind, NEED.MAC_CONTROL)
})

/* ---- public vs authenticated -------------------------------------------- */

test('publicness is decided by reachability, evidence and phrasing — never a domain list', () => {
  const at = (text, extra = {}) =>
    classifyAccess({ text, need: deriveNeed(text), ...extra }, { reach: normalizePublicUrl, ...extra.deps })

  const open = at('read example.com/pricing')
  assert.equal(open.access, ACCESS.PUBLIC)
  assert.equal(open.basis, 'no-session-signal')
  assert.equal(open.verifiedPublic, true)

  // Physics, and it outranks the caller: a datacentre browser cannot route to
  // an RFC1918 address whatever anyone declares.
  const lan = classifyAccess(
    { text: 'read 192.168.1.1/status', need: deriveNeed('read 192.168.1.1/status'), access: ACCESS.PUBLIC },
    { reach: normalizePublicUrl },
  )
  assert.equal(lan.access, ACCESS.OWNER)
  assert.equal(lan.basis, 'unreachable-from-public-internet')

  assert.equal(at('read router.local/status').basis, 'unreachable-from-public-internet')

  const embedded = classifyAccess(
    {
      text: 'read https://me:pw@example.com/account',
      need: { kind: NEED.WEB_READ, target: { kind: 'url', url: 'https://me:pw@example.com/account' } },
    },
    { reach: normalizePublicUrl },
  )
  assert.equal(embedded.basis, 'credentials-in-url')

  assert.equal(at('check my orders on shop.example.com').basis, 'owner-resource-phrasing')
  assert.equal(at('click renew on example.com/plan').basis, 'interaction')

  // Evidence from this run beats every guess above it.
  const learned = classifyAccess(
    { text: 'read shop.example.com/deals', need: deriveNeed('read shop.example.com/deals') },
    {
      reach: normalizePublicUrl,
      observations: [{ kind: 'login-wall', origin: 'https://shop.example.com' }],
    },
  )
  assert.equal(learned.access, ACCESS.OWNER)
  assert.equal(learned.basis, 'observed-login-wall')
})

test('with no reachability check, publicness is unverified and stays that way', () => {
  const verdict = classifyAccess(
    { text: 'read example.com', need: deriveNeed('read example.com') },
    { reach: null },
  )
  assert.equal(verdict.access, ACCESS.PUBLIC)
  assert.equal(verdict.verifiedPublic, false)
  assert.ok(verdict.signals.some((signal) => signal.signal === 'reachability-unchecked'))

  // And an unverified target must not be handed to a body that only reaches
  // the public internet.
  const plan = routeGoal('read example.com', context({ reach: null }))
  assert.equal(partOf(plan, 'p1').decision.surface, 'browser')
  assert.match(
    partOf(plan, 'p1').candidates.find((entry) => entry.surface === 'relay').why,
    /nothing verified this target is on it/,
  )
})

/* ---- routing ------------------------------------------------------------ */

test('a public read goes to the body nothing of the owner has to wake', () => {
  const plan = routeGoal('read example.com/pricing', context())
  const part = partOf(plan, 'p1')

  assert.equal(part.decision.surface, 'relay')
  assert.equal(part.decision.capability, 'read_web_page')
  // Chosen through the granted name, resolved to what actually runs.
  assert.equal(part.decision.capabilityId, 'voice:tool:read_web_page')
  assert.equal(part.decision.resolvedTo, 'relay:tool:read_web_page')
  assert.match(part.why, /without anything of the owner's being awake/)
  // The owner's browser could have done it and is reported as the alternate.
  assert.deepEqual(part.alternates, ['voice:tool:browser_run_actions'])
})

test('an authenticated page goes to the only body that holds the sessions', () => {
  const plan = routeGoal('check my orders on shop.example.com', context())
  const part = partOf(plan, 'p1')

  assert.equal(part.access.access, ACCESS.OWNER)
  assert.equal(part.decision.surface, 'browser')
  assert.match(part.why, /holds the owner's sessions/)

  const relay = part.candidates.find((entry) => entry.surface === 'relay')
  assert.equal(relay.usable, false)
  assert.match(relay.why, /holds none of the owner's sessions/)
})

test('an authenticated page is left unrouted rather than sent to a body with no session', () => {
  const plan = routeGoal(
    'check my orders on shop.example.com',
    context({
      surfaces: {
        ...SURFACES.everythingUp,
        browser: { online: false, attended: true, holdsOwnerSessions: true, network: 'owner' },
      },
      principal: { credentials: ['agent-token', 'cloudflare-browser-run'] },
    }),
  )
  const part = partOf(plan, 'p1')

  assert.equal(part.decision, null)
  assert.equal(plan.unroutable.length, 1)
  // The relay is up, idle and capable, and is still not offered: it cannot
  // succeed on that page, so spending a browser-minute to be shown a login
  // form is worse than saying so.
  assert.match(part.why, /browser is offline/)
  assert.match(part.why, /relay holds none of the owner's sessions/)
})

test('an offline body is never chosen, however capable', () => {
  const plan = routeGoal(
    'read example.com/pricing',
    context({
      surfaces: {
        ...SURFACES.everythingUp,
        relay: {
          online: false,
          attended: false,
          holdsOwnerSessions: false,
          network: 'public-internet',
          why: 'Browser Run is not configured in this process',
        },
      },
    }),
  )
  const part = partOf(plan, 'p1')

  assert.equal(part.decision.surface, 'browser')
  const relay = part.candidates.find((entry) => entry.surface === 'relay')
  assert.equal(relay.usable, false)
  assert.match(relay.why, /relay is offline \(Browser Run is not configured/)
})

test('without the Browser Run credential the server-side path is blocked, not silently skipped', () => {
  const plan = routeGoal(
    'read example.com/pricing',
    context({ principal: { credentials: ['agent-token', 'owner-web-session'] } }),
  )
  const relay = partOf(plan, 'p1').candidates.find((entry) => entry.surface === 'relay')

  assert.equal(relay.verdict, 'blocked')
  assert.deepEqual(relay.missing, [{ kind: 'credential', need: 'cloudflare-browser-run' }])
  assert.equal(partOf(plan, 'p1').decision.surface, 'browser')
})

test('acting on a page has no server-side candidate at all', () => {
  const plan = routeGoal('click renew on example.com/plan', context())
  const part = partOf(plan, 'p1')

  assert.equal(part.need.kind, NEED.WEB_INTERACT)
  assert.equal(part.decision.surface, 'browser')
  // Nothing on the relay answers to 'goal web interact' — the edge browser has
  // three read-only quick actions, so the absence is structural.
  assert.deepEqual(
    part.candidates.map((entry) => entry.surface),
    ['browser'],
  )
})

test('one goal is routed across bodies, part by part', () => {
  const plan = routeGoal(
    'read example.com/pricing and then check my orders on shop.example.com and tell me the difference',
    context(),
  )

  assert.deepEqual(
    plan.parts.map((part) => part.decision?.surface ?? null),
    ['relay', 'browser', null],
  )
  assert.equal(partOf(plan, 'p3').decision.kind, 'no-surface')
  assert.equal(plan.unroutable.length, 0)
})

test('machine control resolves through the granted name to the route that runs it', () => {
  const plan = routeGoal('set the volume to 30', context())
  const part = partOf(plan, 'p1')

  assert.equal(part.need.kind, NEED.MAC_CONTROL)
  assert.equal(part.decision.surface, 'mac')
  assert.equal(part.decision.resolvedTo, 'mac:http:POST /execute')
  assert.deepEqual(part.decision.invoke, {
    method: 'POST',
    path: '/execute',
    baseUrl: null,
  })
})

test('a need nobody registered says whether that is absence or blindness', () => {
  const bare = createCapabilityRegistry()
  registerSurface(bare, { surface: 'mac', inventorySource: 'test' })
  const plan = routeGoal('read example.com', context({ registry: bare }))

  assert.equal(partOf(plan, 'p1').decision, null)
  assert.match(partOf(plan, 'p1').why, /published no inventory: voice, browser, ios, relay, pendant/)
})

test('two bodies that can both do it are separated by fresh evidence', () => {
  const store = registry()
  const now = Date.parse('2026-08-07T12:00:00Z')
  recordCapabilityObservation(
    store,
    { name: 'browser:action:browser_run_actions', status: 200, by: 'test', at: new Date(now - 60_000).toISOString() },
    { now },
  )

  /* Both attended, so the tie-break falls to evidence: a body that answered a
   * minute ago beats one that has never been tried. */
  const plan = routeGoal(
    'read example.com/pricing',
    context({
      registry: store,
      surfaces: {
        ...SURFACES.everythingUp,
        relay: {
          online: true,
          attended: true,
          holdsOwnerSessions: false,
          network: 'public-internet',
        },
      },
      now,
    }),
  )

  assert.equal(partOf(plan, 'p1').decision.surface, 'browser')
})

/* ---- learning from an attempt ------------------------------------------- */

test('a login wall re-routes the part that hit it and every later part on that origin', () => {
  const ctx = context()
  const plan = routeGoal(
    'read shop.example.com/deals and then read shop.example.com/stock',
    ctx,
  )
  assert.equal(partOf(plan, 'p1').decision.surface, 'relay')
  assert.equal(partOf(plan, 'p2').decision.surface, 'relay')

  const next = rerouteAfterAttempt(
    plan,
    { partId: 'p1', ok: false, likelyLoginWall: true, surface: 'relay' },
    ctx,
  )

  assert.equal(next.rerouted.changed, true)
  assert.equal(partOf(next, 'p1').decision.surface, 'browser')
  assert.equal(partOf(next, 'p1').access.basis, 'observed-login-wall')
  // The second part never had to pay for its own wall.
  assert.equal(partOf(next, 'p2').decision.surface, 'browser')
  assert.equal(partOf(next, 'p2').access.basis, 'observed-login-wall')
})

test('a body that reports itself out of action is dropped for this plan only', () => {
  const ctx = context()
  const plan = routeGoal('read example.com/pricing', ctx)
  assert.equal(partOf(plan, 'p1').decision.surface, 'relay')

  const next = rerouteAfterAttempt(
    plan,
    { partId: 'p1', ok: false, reason: 'rate-limited', surface: 'relay' },
    ctx,
  )
  assert.equal(partOf(next, 'p1').decision.surface, 'browser')
  assert.match(next.rerouted.because, /rate-limited/)

  // Nothing was stored: routing the same goal again from the same context is
  // unchanged, because liveness belongs to the caller.
  assert.equal(partOf(routeGoal('read example.com/pricing', ctx), 'p1').decision.surface, 'relay')
})

test('an outcome that changes nothing says so instead of re-deciding', () => {
  const ctx = context()
  const plan = routeGoal('read example.com/pricing', ctx)
  const next = rerouteAfterAttempt(plan, { partId: 'p1', ok: true }, ctx)

  assert.equal(next.rerouted.changed, false)
  assert.equal(partOf(next, 'p1').decision.surface, 'relay')
})

/* ---- surfaces, probed --------------------------------------------------- */

test('Browser Run availability is probed through the relay module, without a request', async () => {
  const account = process.env.CLOUDFLARE_ACCOUNT_ID
  const token = process.env.CLOUDFLARE_API_TOKEN
  const serverBrowser = await import('../cloud-relay/serverBrowser.js')

  try {
    delete process.env.CLOUDFLARE_ACCOUNT_ID
    delete process.env.CLOUDFLARE_API_TOKEN
    const missing = await probeBrowserRun({ serverBrowser })
    assert.equal(missing.configured, false)
    assert.match(missing.why, /no Workers BROWSER binding/)

    process.env.CLOUDFLARE_ACCOUNT_ID = 'probe-account'
    process.env.CLOUDFLARE_API_TOKEN = 'probe-token'
    const present = await probeBrowserRun({ serverBrowser })
    assert.equal(present.configured, true)
    assert.equal(present.transport, 'rest')

    // A binding is believed, never exercised: driving it would really open a
    // page and spend a browser-second of a ten-minute daily budget.
    const bound = await probeBrowserRun({
      serverBrowser,
      bindings: {
        BROWSER: {
          quickAction: () => assert.fail('a configuration probe must not open a page'),
        },
      },
    })
    assert.equal(bound.transport, 'binding')
  } finally {
    if (account === undefined) delete process.env.CLOUDFLARE_ACCOUNT_ID
    else process.env.CLOUDFLARE_ACCOUNT_ID = account
    if (token === undefined) delete process.env.CLOUDFLARE_API_TOKEN
    else process.env.CLOUDFLARE_API_TOKEN = token
  }
})

test('a context is still usable when a body cannot be loaded at all', async () => {
  const boom = () => {
    throw new Error('module unavailable')
  }
  const ctx = await buildGoalRoutingContext({
    app: null,
    loadRealtimeTools: boom,
    loadServerBrowser: boom,
    loadCloudflareBindings: boom,
    loadBrowserBridge: () => ({ getBrowserStatus: () => ({ online: true, devices: [{}] }) }),
    env: { AGENT_TOKEN: 'set' },
  })

  // The owner's browser is still routable, and the goal-level names fell back
  // onto the implementations because no granted schemas could be read.
  const plan = routeGoal('check my orders on shop.example.com', ctx)
  assert.equal(partOf(plan, 'p1').decision.surface, 'browser')
  assert.ok(ctx.notes.some((note) => /Realtime tool schemas could not be loaded/.test(note)))
  assert.equal(ctx.reach, null)
  assert.equal(ctx.surfaces.relay.online, false)
})

test('an unconfigured Browser Run blocks one capability, not the whole body', async () => {
  const serverBrowser = await import('../cloud-relay/serverBrowser.js')
  const ctx = await buildGoalRoutingContext({
    app: null,
    /* Browser Run unconfigured, everything else about the relay intact — the
     * state this checkout is actually in. */
    loadServerBrowser: async () => ({
      ...serverBrowser,
      readPublicPage: async () => ({ ok: false, reason: 'not-configured' }),
    }),
    loadBrowserBridge: async () => ({
      getBrowserStatus: () => ({ online: true, devices: [{}] }),
    }),
    env: { AGENT_TOKEN: 'set', OPENAI_API_KEY: 'set' },
  })

  assert.equal(ctx.browserRun.configured, false)
  assert.equal(ctx.surfaces.relay.online, true)

  // web_search never needed a Cloudflare account and must not go down with it.
  assert.equal(partOf(routeGoal('look up the ferry timetable', ctx), 'p1').decision.surface, 'relay')

  // The page read does move, and says which credential would move it back.
  const read = partOf(routeGoal('read example.com/pricing', ctx), 'p1')
  assert.equal(read.decision.surface, 'browser')
  assert.deepEqual(
    read.candidates.find((entry) => entry.surface === 'relay').missing,
    [{ kind: 'credential', need: 'cloudflare-browser-run' }],
  )
})

test('the pendant is reported unknown rather than offline, and is never chosen', async () => {
  const ctx = await buildGoalRoutingContext({
    app: null,
    loadBrowserBridge: () => ({ getBrowserStatus: () => ({ online: false, devices: [] }) }),
    env: {},
  })

  assert.equal(ctx.surfaces.pendant.online, null)
  assert.match(ctx.surfaces.pendant.why, /no LTE registration/)
  assert.equal(ctx.principal.credentials.includes('owner-web-session'), false)
})

/* ---- http --------------------------------------------------------------- */

function fakeApp() {
  const routes = new Map()
  const app = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  }
  const call = async (method, route, body = {}) => {
    const handler = routes.get(`${method} ${route}`)
    assert.ok(handler, `no handler for ${method} ${route}`)
    let statusCode = 200
    let payload = null
    await handler(
      { body },
      {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        },
      },
    )
    return { statusCode, payload }
  }
  return { app, call, routes }
}

test('the routes decide and return, and run nothing', async () => {
  const { app, call, routes } = fakeApp()
  const ctx = context()
  const mounted = registerGoalRouterRoutes(app, { loadContext: async () => ctx })

  assert.deepEqual(mounted, [
    'GET /goal-router/surfaces',
    'POST /goal-router/route',
    'POST /goal-router/reroute',
  ])
  assert.deepEqual([...routes.keys()], mounted)

  const routed = await call('POST', '/goal-router/route', {
    goal: 'read example.com/pricing and then check my orders on shop.example.com',
  })
  assert.equal(routed.statusCode, 200)
  assert.deepEqual(
    routed.payload.plan.parts.map((part) => part.decision.surface),
    ['relay', 'browser'],
  )

  const rerouted = await call('POST', '/goal-router/reroute', {
    plan: routed.payload.plan,
    outcome: { partId: 'p1', likelyLoginWall: true, surface: 'relay' },
  })
  assert.equal(rerouted.payload.plan.parts[0].decision.surface, 'browser')

  const surfaces = await call('GET', '/goal-router/surfaces')
  assert.equal(surfaces.payload.surfaces.relay.attended, false)
  assert.equal(surfaces.payload.reachabilityCheck, 'available')

  const empty = await call('POST', '/goal-router/route', {})
  assert.equal(empty.statusCode, 400)
})

test('mounting refuses anything that is not an Express-style app', () => {
  assert.throws(() => registerGoalRouterRoutes({}), /Express-style app/)
})

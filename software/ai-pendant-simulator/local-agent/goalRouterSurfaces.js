/*
 * The facts goalRouter.js decides on, gathered from the bodies themselves.
 *
 * goalRouter.js is a pure decision and knows nothing about Cloudflare, Safari
 * or LaunchAgents. This is the half that does: it asks each surface what it can
 * do, whether it is answering, and what reaches it, and hands the result over
 * as data. The split is the point — the routing rules can be read and tested
 * without a Mac, and the awkward truths about the deployment live in one file
 * where they can be checked rather than assumed.
 *
 * WHAT IS DERIVED, NOT DECLARED. Everything that already has a source of truth
 * is read from it, because a second copy is a copy that goes stale:
 *
 *   - The Mac's ~120 routes and 95 action types come from
 *     capabilityManifest.buildCapabilityManifest(), off the live Express router.
 *   - The names the voice model holds come from
 *     openaiRealtimeVoice.REALTIME_TOOLS, the array actually sent to the model.
 *   - Whether Cloudflare Browser Run works is PROBED through
 *     serverBrowser.readPublicPage itself, with a fetch that throws, rather than
 *     re-reading the environment variables — resolveCredentials() there is not
 *     exported, its precedence (binding > option > var > env) is real, and a
 *     second opinion about whether a backend is configured is exactly the
 *     parallel notion of reachability this work was told not to build.
 *   - Whether the owner's browser is answering comes from
 *     browserBridge.getBrowserStatus(), the heartbeat table the extension
 *     actually writes to.
 *
 * WHAT IS DECLARED, AND WHY IT HAS TO BE. Three properties per surface that no
 * module in this repo currently states anywhere: does it hold the owner's
 * sessions, which network can it reach, and does choosing it cost the owner
 * something (does it sleep). They are declared HERE, next to the surface they
 * describe, instead of inside the router — so the router matches properties
 * against a target and never a name, and a fourth body that holds the owner's
 * sessions becomes eligible for authenticated pages by adding a row here.
 *
 * NOTHING IS ASSERTED THAT WAS NOT OBSERVED. A surface nobody could reach is
 * reported `online: null` — unknown — and never `false`. The router will not
 * choose it either way, but "I cannot see that far" and "it is not there" are
 * different answers, and collapsing them is the failure
 * shared/capabilityRegistry.js exists to end.
 */

import {
  createCapabilityRegistry,
  registerCapabilities,
  registerCapability,
  registerFromCapabilityManifest,
  registerGrantedTools,
  registerSurface,
} from '../shared/capabilityRegistry.js'

/*
 * The goal-level names surfaces answer to, attached as ALIASES to the granted
 * tool names that already exist.
 *
 * This is the join between goalRouter.NEED_LOOKUP and the registry, and it is
 * deliberately a map from a name to a name — never from a need to a surface.
 * Which body ends up answering 'goal web read' is whatever the registry says is
 * implemented and reachable at the moment the question is asked.
 *
 * browser_run_actions carries both web aliases because the extension both reads
 * and acts; read_web_page carries only the read one because the edge browser
 * cannot click (serverBrowser.BROWSER_ACTIONS is markdown, content, links).
 * That asymmetry is what makes "an interaction has no server-side candidate"
 * true by construction rather than by a rule someone has to remember.
 */
export const GOAL_ALIASES = Object.freeze({
  read_web_page: ['goal web read'],
  browser_run_actions: ['goal web read', 'goal web interact'],
  mac_run_actions: ['goal mac control'],
  web_search: ['goal web search'],
})

/*
 * Which granted name runs where. The left side is a name a model holds; the
 * right side is an id something has actually registered as implemented. A name
 * with nothing on the right is a dangling grant and capabilityRegistryReport()
 * counts it — which is the honest state of relay_job_status and mac_delegate
 * here, since the relay publishes no inventory for this process to read.
 */
const IMPLEMENTED_BY = Object.freeze({
  read_web_page: ['relay:tool:read_web_page'],
  web_search: ['relay:tool:web_search'],
  browser_run_actions: ['browser:action:browser_run_actions'],
  mac_run_actions: ['mac:http:POST /execute'],
  get_mac_status: ['mac:http:POST /execute'],
  mac_delegate: ['mac:http:POST /plan'],
})

/* A page that exists, is public, and is nobody's business. Only ever passed to
 * a probe whose fetch throws before a byte leaves the process. */
const PROBE_URL = 'https://example.com/'

/**
 * Can the server-side browser actually run from here, right now?
 *
 * Answered by asking the module rather than the environment. readPublicPage()
 * returns reason 'not-configured' before it opens a socket when it has neither
 * a Workers binding nor an account id and token; with credentials it calls
 * `fetchImpl`, which here throws immediately. So 'not-configured' means
 * unconfigured and anything else means configured, and no request is made
 * either way.
 *
 * The binding is checked first and never probed: inside a Worker,
 * binding.quickAction() would really open a page and spend a browser-second of
 * a ten-minute daily budget just to answer a question about configuration.
 */
export async function probeBrowserRun({
  serverBrowser = null,
  bindings = null,
} = {}) {
  if (!serverBrowser?.readPublicPage) {
    return {
      configured: false,
      transport: null,
      why: 'the relay browser module could not be loaded in this process',
    }
  }

  if (bindings?.BROWSER) {
    return {
      configured: true,
      transport: 'binding',
      why: 'a Workers BROWSER binding is present, so Quick Actions run without a token',
    }
  }

  const result = await serverBrowser.readPublicPage(PROBE_URL, {
    fetchImpl: () => {
      throw new Error('goal-router configuration probe: no request is intended')
    },
  })

  if (result?.reason === 'not-configured') {
    return {
      configured: false,
      transport: null,
      why:
        'Browser Run is not configured in this process: no Workers BROWSER binding and no CLOUDFLARE_ACCOUNT_ID + CLOUDFLARE_API_TOKEN',
    }
  }

  return {
    configured: true,
    transport: 'rest',
    why: 'Cloudflare account credentials are present, so Quick Actions run over the REST API',
  }
}

/**
 * Everything goalRouter.routeGoal() needs, read off the running system.
 *
 * Every loader is injectable and every one of them is wrapped: a body that
 * cannot be loaded costs its own capabilities and a line in `notes`, never the
 * whole routing decision. A router that refuses to answer because one surface
 * is missing is worse than one that answers "three of the four bodies can be
 * seen, and here is which".
 */
export async function buildGoalRoutingContext(options = {}) {
  const {
    app = null,
    now = Date.now(),
    /* This module runs inside the Mac agent, so the Mac is up by construction —
     * it is the process answering. Injectable for the case where it is not. */
    macOnline = true,
    loadCapabilityManifest = () => import('./capabilityManifest.js'),
    loadRealtimeTools = () => import('../cloud-relay/openaiRealtimeVoice.js'),
    loadServerBrowser = () => import('../cloud-relay/serverBrowser.js'),
    loadCloudflareBindings = () => import('../cloud-relay/cloudflareBindings.js'),
    loadBrowserBridge = () => import('./browserBridge.js'),
    env = process.env,
  } = options

  const registry = createCapabilityRegistry()
  const notes = []

  const load = async (what, loader) => {
    try {
      return await loader()
    } catch (error) {
      notes.push(`${what} could not be loaded: ${error?.message || error}`)
      return null
    }
  }

  /* ---- the Mac: its own router, its own executor ---- */

  const manifestModule = app ? await load('the Mac capability manifest', loadCapabilityManifest) : null
  if (manifestModule?.buildCapabilityManifest) {
    try {
      const manifest = manifestModule.buildCapabilityManifest(app, { permissions: null })
      registerFromCapabilityManifest(registry, manifest, {
        surface: 'mac',
        credential: 'agent-token',
        now,
      })
    } catch (error) {
      notes.push(`the Mac manifest could not be registered: ${error?.message || error}`)
    }
  } else if (!app) {
    notes.push('no Express app was passed, so the Mac published no inventory')
  }

  /* ---- the relay's own browser, and what reaches it ---- */

  const serverBrowser = await load('the relay browser', loadServerBrowser)
  const bindingsModule = await load('the Cloudflare bindings', loadCloudflareBindings)
  const browserRun = await probeBrowserRun({
    serverBrowser,
    bindings: bindingsModule?.getCloudflareBindings?.() ?? null,
  })

  if (serverBrowser) {
    registerSurface(
      registry,
      {
        surface: 'relay',
        inventorySource: 'module exports (the relay publishes no inventory of its own)',
        note: 'Only the browsing capabilities this router needs. The relay has 46 routes and describes none of them.',
      },
      { now },
    )

    registerCapabilities(
      registry,
      [
        {
          name: 'read_web_page',
          surface: 'relay',
          kind: 'tool',
          status: 'implemented',
          invoke: { tool: 'read_web_page' },
          /* The credential IS the routing fact. With no Browser Run behind it
           * this capability is real code that cannot run, and canInvoke() says
           * 'blocked, missing credential cloudflare-browser-run' — which is a
           * far more useful answer than a surface silently never chosen. */
          auth: {
            credential: 'cloudflare-browser-run',
            note: browserRun.why,
          },
          module: 'cloud-relay/serverBrowser.js readPublicPage',
          what: `Renders one public page in a Cloudflare browser and returns text. Read-only: ${(
            serverBrowser.BROWSER_ACTIONS ?? []
          ).join(', ')}.`,
        },
        {
          name: 'web_search',
          surface: 'relay',
          kind: 'tool',
          status: 'implemented',
          invoke: { tool: 'web_search' },
          auth: { credential: 'openai-api-key', note: 'The relay calls the model provider.' },
          module: 'cloud-relay/openaiRealtimeVoice.js runWebSearch',
          what: 'Looks up live public facts. No page named, no session involved.',
        },
      ],
      { now },
    )
  }

  /* ---- the owner's browser ---- */

  const bridge = await load('the browser bridge', loadBrowserBridge)
  const browserStatus = bridge?.getBrowserStatus ? safely(() => bridge.getBrowserStatus()) : null
  if (!browserStatus) notes.push('the browser extension published no status')

  registerSurface(
    registry,
    {
      surface: 'browser',
      inventorySource: 'browserBridge heartbeat + executor action types',
      note: 'The owner\'s own browser, driven by the extension over the Mac\'s POST /execute.',
    },
    { now },
  )

  registerCapabilities(
    registry,
    [
      {
        name: 'browser_run_actions',
        surface: 'browser',
        kind: 'action',
        status: 'implemented',
        invoke: { action: 'browser_run_actions' },
        /*
         * The owner's logged-in sessions are a credential like any other: a
         * named thing that reaches a resource, held by exactly one body. Making
         * it one is what lets "authenticated pages must go through the owner's
         * own browser" be enforced by canInvoke() rather than by a special case
         * in the router.
         */
        auth: {
          credential: 'owner-web-session',
          note: 'Held only while the extension is answering; dispatched over the Mac\'s POST /execute.',
        },
        module: 'local-agent/browserBridge.js -> browser-extension',
        what: 'Drives the owner\'s browser: navigate, read_page, click, type, select, scroll.',
      },
    ],
    { now },
  )

  /* ---- the names a model was handed ---- */

  const voice = await load('the Realtime tool schemas', loadRealtimeTools)
  if (voice?.REALTIME_TOOLS) {
    registerGrantedTools(registry, voice.REALTIME_TOOLS, {
      surface: 'voice',
      implementedBy: IMPLEMENTED_BY,
      now,
    })
  }

  /*
   * Attach the goal-level names.
   *
   * Preferably to the GRANTED names, because then every need resolves the same
   * way — a name a model already holds, followed through implementedBy to
   * whatever runs it — and the plan speaks the same vocabulary the voice agent
   * does. If the Realtime schemas could not be loaded, the same aliases go on
   * the implementations directly, so a missing relay module costs the shared
   * vocabulary and not the routing.
   *
   * Only one record per need gets each alias: two records resolving to the same
   * implementation would appear as two candidates that are the same choice.
   * capabilityRegistryReport() will list 'goal web read' under ambiguousNames,
   * and that is a true statement — two capabilities answer to it, and choosing
   * between them is what this router is for.
   */
  const grantedNames = Boolean(voice?.REALTIME_TOOLS)
  for (const [name, aliases] of Object.entries(GOAL_ALIASES)) {
    const id = grantedNames ? `voice:tool:${name.toLowerCase()}` : IMPLEMENTED_BY[name]?.[0]
    const record = id ? registry.capabilities.get(id) : null
    if (!record) {
      notes.push(`nothing is registered as ${id ?? name}, so ${aliases.join(' / ')} lost a candidate`)
      continue
    }
    /* Re-registering an id replaces the declaration and KEEPS its evidence —
     * documented behaviour of registerCapability, and what lets this add a name
     * to a record it does not own. */
    registerCapability(
      registry,
      { ...record, aliases: [...record.aliases, ...aliases] },
      { now },
    )
  }

  /* ---- who is answering, and what each body is ---- */

  const extensionOnline = browserStatus?.online === true
  const surfaces = {
    mac: {
      online: macOnline === true ? true : macOnline === false ? false : null,
      /* It sleeps, it gets closed, it is carried around. Choosing it spends
       * something of the owner's. */
      attended: true,
      holdsOwnerSessions: true,
      network: 'owner',
      why: 'this process is the Mac agent',
    },
    browser: {
      /*
       * Two facts, one answer: the extension is only reachable THROUGH this
       * process, so an extension heartbeat on a Mac that is down is not a body
       * anything can use. The chain is collapsed here because this is where
       * both halves are known.
       */
      online: extensionOnline && macOnline === true,
      attended: true,
      holdsOwnerSessions: true,
      network: 'owner',
      why: extensionOnline
        ? `${browserStatus?.devices?.length ?? 1} extension(s) heartbeating`
        : 'no extension heartbeat',
    },
    relay: {
      /*
       * The relay's capabilities run wherever their code and credentials are:
       * originFanOut.js and research.js already call readPublicPage and
       * runWebSearch straight from this process. So liveness here is "is that
       * code loadable", and it is deliberately NOT "is Browser Run configured".
       *
       * Tying the surface's liveness to one capability's credential would take
       * web_search — which needs no Cloudflare account at all — down with the
       * browser, and would report a missing token as a dead body. The
       * credential is checked where it belongs, per capability, and canInvoke()
       * then says "blocked, missing cloudflare-browser-run", which is the
       * actionable sentence.
       */
      online: Boolean(serverBrowser),
      /* A datacentre process. Nothing of the owner's has to be awake for it,
       * which is the entire reason to prefer it for public reads. */
      attended: false,
      holdsOwnerSessions: false,
      network: 'public-internet',
      why: serverBrowser
        ? `the relay's own code runs in this process; ${browserRun.why}`
        : 'the relay module could not be loaded here',
    },
    voice: {
      /* Grants names, implements nothing; its own liveness never decides a
       * route because every name it holds resolves to another body. */
      online: null,
      attended: false,
      holdsOwnerSessions: false,
      network: 'public-internet',
      why: 'a tool list handed to a model, not a body that runs anything',
    },
    pendant: {
      online: null,
      attended: true,
      holdsOwnerSessions: false,
      network: 'unknown',
      why: 'no LTE registration today, and nothing announces the pendant to this process',
    },
  }

  /*
   * What the caller holds. Stable names, never secrets — the registry's rule.
   * Two of the three are conditional on a body answering, which is what makes
   * the credential check and the liveness check agree instead of contradicting
   * each other.
   */
  const credentials = []
  if (String(env.AGENT_TOKEN || '').trim()) credentials.push('agent-token')
  if (surfaces.browser.online) credentials.push('owner-web-session')
  if (browserRun.configured) credentials.push('cloudflare-browser-run')
  if (String(env.OPENAI_API_KEY || env.OPENAI_KEY || '').trim()) {
    credentials.push('openai-api-key')
  }

  if (!browserRun.configured) notes.push(browserRun.why)
  if (!surfaces.browser.online) {
    notes.push('the owner\'s browser is not answering, so authenticated pages have no body')
  }

  return {
    registry,
    principal: { credentials, scopes: [], holds: [] },
    surfaces,
    /* One definition of what the public internet can reach, borrowed from the
     * body that has to live with the answer. */
    reach: serverBrowser?.normalizePublicUrl ?? null,
    observations: [],
    browserRun,
    notes,
    now,
  }
}

function safely(fn) {
  try {
    return fn()
  } catch {
    return null
  }
}

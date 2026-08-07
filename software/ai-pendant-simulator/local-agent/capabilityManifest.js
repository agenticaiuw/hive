import fs from 'node:fs'
import path from 'node:path'
import { AGENT_TOKEN, FULL_CONTROL_MODE, PORT } from './config.js'
import { classifyAction } from './actionRisk.js'
import { SUPPORTED_ACTION_TYPES } from './computerControl.js'
import { staticReversibility } from './actionReceipts.js'
import {
  isFullControlPlanner,
  isKnownActionType,
  isLlmPlannerEnabled,
  isVisionConfigured,
  visionModelName,
} from './llmPlanner.js'
import { isPublicPath } from './httpPolicy.js'

/*
 * One authoritative answer to "what can this agent do, and where does it live".
 *
 * Nothing published it before. /health returns four fields, so every remote
 * caller — the relay, the Realtime planner, a reconnaissance agent — had to
 * guess route names and action types, and a wrong guess came back as 401
 * (token middleware runs before routing), which reads as "exists but
 * forbidden". Whole rounds were spent probing a surface that could simply
 * describe itself.
 *
 * Everything here is DERIVED, not typed out: routes come from the live Express
 * router, action types from the executor's dispatch table, planner coverage
 * from llmPlanner's own registry, hands-free status from actionRisk. A
 * hand-maintained list would be wrong within a week — the drift it is meant to
 * expose is exactly the drift it would develop.
 *
 * The only prose is GROUP_NOTES, keyed by the first path segment, and the
 * manifest reports `undocumentedGroups` so its own rot is visible in its own
 * output.
 */

/* Where each URL family is implemented, so a caller can read one file next. */
const GROUP_NOTES = {
  '': {
    what: 'Root: static dashboard bundle.',
    module: 'local-agent/server.js',
  },
  health: {
    what: 'Unauthenticated liveness. Deliberately says almost nothing.',
    module: 'local-agent/httpPolicy.js',
  },
  capabilities: {
    what: 'This manifest.',
    module: 'local-agent/capabilityManifest.js',
  },
  plan: {
    what: 'Turn a command into a plan of executor actions. Does not run them.',
    module: 'local-agent/orchestrator.js + llmPlanner.js',
  },
  execute: {
    what: 'Run an approved action list. Returns a receipt per action.',
    module: 'local-agent/orchestrator.js + executor.js',
  },
  sessions: {
    what: 'Conversation transcripts kept per session.',
    module: 'local-agent/sessionStore.js',
  },
  jobs: {
    what: 'Every plan/execute run, its receipts, cancel and undo.',
    module: 'local-agent/jobTracker.js + undo.js',
  },
  logs: {
    what: 'Flat activity log of executed commands.',
    module: 'local-agent/logger.js',
  },
  thinking: {
    what: 'Live planner reasoning traces (SSE on /thinking/stream).',
    module: 'local-agent/thinkingTrace.js',
  },
  pipeline: {
    what: 'Pendant audio pipeline runs and their recordings.',
    module: 'local-agent/pipelineTrace.js + pipelineAudio.js',
  },
  'context-graph': {
    what: 'Entities and relations the agent remembers.',
    module: 'local-agent/contextGraph.js',
  },
  projects: {
    what: 'Working project the agent is currently oriented around.',
    module: 'local-agent/projectMemory.js',
  },
  'machine-context': {
    what: 'Discovered host inventory: apps, CLIs, macOS version, timezone.',
    module: 'local-agent/machineContext.js',
  },
  ops: {
    what: 'Aggregate status and one-shot snapshot for dashboards and relay.',
    module: 'local-agent/server.js',
  },
  browser: {
    what: 'Chrome extension bridge: heartbeat, command queue, tab sessions.',
    module: 'local-agent/browserBridge.js + browserSessions.js',
  },
  routines: {
    what: 'Scheduled work the owner is not waiting on.',
    module: 'local-agent/routines.js',
  },
  briefing: {
    what: 'Spoken briefings assembled for the pendant.',
    module: 'local-agent/briefing.js + audioBrief.js',
  },
  research: {
    what: 'Multi-source research runs and their rendered answers.',
    module: 'local-agent/research.js',
  },
  watches: {
    what: 'Standing page watches and the reports they have raised.',
    module: 'local-agent/pageWatch.js',
  },
  forms: {
    what: 'Web form fills, staged and reviewable before submission.',
    module: 'local-agent/formFill.js',
  },
  memory: {
    what: 'Durable facts, separate from the per-session transcript.',
    module: 'local-agent/memoryService.js',
  },
  routing: {
    what: 'Which planner tier handled which request, and what it cost.',
    module: 'local-agent/routingStats.js',
  },
  dashboard: {
    what: 'Ops dashboard HTML. Issues a loopback session cookie.',
    module: 'local-agent/dashboardSession.js',
  },
}

/* Capabilities that are not HTTP routes on this process. A caller that only
 * probes this port would otherwise conclude they do not exist. */
const OFF_BOX_SURFACES = [
  {
    surface: 'cloud-relay',
    what:
      'Voice front door. Owns the Realtime session, the pendant work queue, audio storage and retention.',
    module: 'cloud-relay/server.js',
    reachedBy: 'local-agent/bridge.js polls it; it never calls in.',
  },
  {
    surface: 'realtime-planner',
    what:
      'Plans from pendant audio and emits executor actions. The Mac only executes.',
    module: 'cloud-relay/openaiRealtimeVoice.js (REALTIME_TOOLS)',
    reachedBy: 'Relay work queue -> bridge -> POST /execute on this process.',
  },
  {
    surface: 'browser-extension',
    what: 'Runs browser_* actions inside the real logged-in Chrome profile.',
    module: 'browser-extension/',
    reachedBy: 'Long-polls GET /browser/poll on this process.',
  },
  {
    surface: 'pendant-firmware',
    what: 'nRF9160 pendant: captures mic audio, plays the spoken reply.',
    module: 'firmware/nrf9160/',
    reachedBy: 'Speaks only to the relay over LTE-M.',
  },
]

/**
 * Every route the Express app actually has, read off the live router.
 * Method-less middleware layers are skipped: they match everything and
 * describe nothing.
 */
export function listRoutes(app) {
  const layers = app?.router?.stack ?? []
  const routes = []

  for (const layer of layers) {
    if (!layer.route) continue
    const paths = Array.isArray(layer.route.path)
      ? layer.route.path
      : [layer.route.path]

    for (const routePath of paths) {
      for (const method of Object.keys(layer.route.methods ?? {})) {
        routes.push({
          method: method.toUpperCase(),
          path: routePath,
          group: groupOf(routePath),
          params: [...String(routePath).matchAll(/:([A-Za-z0-9_]+)/g)].map(
            (match) => match[1],
          ),
          auth: isPublicPath(routePath) ? 'public' : 'bearer',
        })
      }
    }
  }

  return routes.sort(
    (a, b) => a.path.localeCompare(b.path) || a.method.localeCompare(b.method),
  )
}

/**
 * Does this process have anything at all at `requestPath`?
 *
 * The auth middleware runs before routing, so without this every typo was a
 * 401 and discovery was impossible. Only real endpoint layers count — the
 * catch-all static middleware matches every path and would make the answer
 * always "yes" — so served files are checked separately, by existence.
 */
export function isKnownRoutePath(app, requestPath, { staticDir = null } = {}) {
  const candidate = String(requestPath || '/')
  const layers = app?.router?.stack ?? []

  for (const layer of layers) {
    if (!layer.route) continue
    try {
      if (layer.match(candidate)) return true
    } catch {
      // A layer that cannot answer is not evidence either way.
    }
  }

  return Boolean(staticDir) && staticFileExists(staticDir, candidate)
}

function staticFileExists(staticDir, requestPath) {
  const decoded = safeDecode(requestPath)
  if (!decoded || decoded.includes('\0')) return false

  const resolved = path.resolve(staticDir, `.${path.posix.normalize(decoded)}`)
  // Never let a traversal attempt answer "yes" about a file outside dist/.
  if (resolved !== staticDir && !resolved.startsWith(`${staticDir}${path.sep}`)) {
    return false
  }

  try {
    return fs.statSync(resolved).isFile()
  } catch {
    return false
  }
}

function safeDecode(value) {
  try {
    return decodeURIComponent(value)
  } catch {
    return null
  }
}

function groupOf(routePath) {
  return String(routePath).split('/').filter(Boolean)[0] ?? ''
}

/** Action types the executor can dispatch, with who else knows about them. */
export function describeActions() {
  const types = SUPPORTED_ACTION_TYPES.map((type) => {
    const reversibility = staticReversibility(type)
    return {
      type,
      // Advertised to the local LLM planner. A type that is false here is
      // dispatchable but gets dropped by llmPlanner's sanitizeActions, so a
      // plan naming it silently loses the step.
      plannerAdvertised: isKnownActionType(type),
      handsFree: classifyAction({ type, params: {} }).safe,
      reversible: reversibility.reversible,
      reversedBy: reversibility.reversedBy,
    }
  })

  return {
    count: types.length,
    executor: 'local-agent/computerControl.js',
    plannerRegistry: 'local-agent/llmPlanner.js',
    handsFreeRegistry: 'local-agent/actionRisk.js',
    // Named, not hidden: this is the misalignment the manifest exists to show.
    drift: {
      dispatchableButNotPlannable: types
        .filter((entry) => !entry.plannerAdvertised)
        .map((entry) => entry.type),
      note:
        'Types listed here execute fine over POST /execute but are stripped from LLM-authored plans by llmPlanner.sanitizeActions.',
    },
    types,
  }
}

/**
 * The full manifest. Synchronous and cheap on purpose: `permissions` is passed
 * in by the caller, which already has it, rather than triggering a macOS
 * Automation probe on every request.
 */
export function buildCapabilityManifest(
  app,
  { permissions = null, staticDir = null, relayUrl = null, version = '0.5.0' } = {},
) {
  const routes = listRoutes(app)
  const groups = [...new Set(routes.map((route) => route.group))].sort()

  return {
    ok: true,
    service: 'AI Pendant Mac Local Agent',
    version,
    generatedAt: new Date().toISOString(),
    generatedFrom: [
      'express router stack',
      'computerControl dispatch table',
      'llmPlanner action registry',
      'actionRisk hands-free allowlist',
      'macos/permissions report',
    ],
    http: {
      port: PORT,
      baseUrl: `http://127.0.0.1:${PORT}`,
      auth: {
        scheme: 'Bearer',
        header: 'Authorization: Bearer <AGENT_TOKEN>',
        tokenConfigured: Boolean(AGENT_TOKEN),
        alsoAccepts: 'loopback dashboard session cookie',
        // Written down because the previous behaviour taught callers to read
        // 401 as "this route exists".
        statusContract: {
          401: 'route exists, token missing or wrong',
          404: 'no such route on this process',
          503: 'AGENT_TOKEN not configured on the Mac',
        },
      },
      routeCount: routes.length,
      publicPaths: routes
        .filter((route) => route.auth === 'public')
        .map((route) => route.path),
      groups: groups.map((group) => ({
        group: group || '/',
        routeCount: routes.filter((route) => route.group === group).length,
        ...(GROUP_NOTES[group] ?? { what: null, module: null }),
      })),
      // Self-reported rot: a new route family with no note shows up here.
      undocumentedGroups: groups.filter((group) => !GROUP_NOTES[group]),
      routes,
    },
    actions: describeActions(),
    models: {
      planner: {
        // Mirrors llmPlanner's own default; capabilityManifest.test.js fails
        // if that default is edited without updating this one.
        model: String(process.env.LLM_MODEL || 'gpt-5.6-luna').trim(),
        env: 'LLM_MODEL',
        enabled: isLlmPlannerEnabled(),
        fullControlPlanner: isFullControlPlanner(),
      },
      vision: {
        model: visionModelName(),
        env: 'LLM_VISION_MODEL',
        configured: isVisionConfigured(),
      },
      voice: {
        runsOn: 'cloud-relay',
        module: 'cloud-relay/openaiRealtimeVoice.js',
        env: 'OPENAI_REALTIME_MODEL',
        note: 'The relay selects the Realtime model; this process never does.',
      },
    },
    permissions,
    surfaces: OFF_BOX_SURFACES,
    relay: {
      configured: Boolean(relayUrl),
      url: relayUrl || null,
    },
    fullControlMode: FULL_CONTROL_MODE,
    staticDashboard: Boolean(
      staticDir && fs.existsSync(path.join(staticDir, 'dashboard.html')),
    ),
  }
}

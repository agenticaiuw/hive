/*
 * Tell the committee when the system it is designing for has changed.
 *
 * Discovery stops when the commons stops moving, which is the eligibility gate
 * working: an agent with nothing new to look at should not burn a round. But it
 * exposed a real gap. Capabilities ship — voiceNotes, visionLoop, the workbench
 * transaction, the briefing shelf, a dozen more in one night — and NOTHING tells
 * the agents. They can only learn about a new route by probing for it, and they
 * only probe while running, and they only run while something is new. A system
 * that changed under them was invisible precisely because it had gone quiet.
 *
 * So the manifest is published INTO the commons as one key. It is content
 * addressed, so an unchanged system deposits a re-confirmation and wakes nobody
 * — re-confirmation is explicitly not novelty — while a shipped capability
 * changes the content and registers as a CONTRADICTION, which is the strongest
 * eligibility signal there is. That is the correct strength: an agent whose plan
 * was built around a capability that did not exist should find out first.
 *
 * Run it after anything that changes the surface:
 *
 *   node scripts/publish-capabilities.mjs
 *
 * It reads the LIVE agent rather than the source, because a route that exists in
 * a file and is not mounted is exactly the failure this project spent a day
 * finding. What is published is what is actually reachable.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { deposit, recall } from './commons.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(HERE, '../../../diagnostics/harness-derivation')
const REPO_ROOT = path.resolve(HERE, '../../..')

const AGENT_URL = process.env.MAC_AGENT_URL || 'http://localhost:8000'
const TIMEOUT_MS = Number(process.env.PUBLISH_TIMEOUT_MS || 20_000)

/* The token lives in .env and is never printed — only used. */
function agentToken() {
  for (const candidate of [path.join(REPO_ROOT, '.env'), path.resolve(HERE, '../.env')]) {
    try {
      for (const line of fs.readFileSync(candidate, 'utf8').split(/\r?\n/)) {
        const eq = line.indexOf('=')
        if (eq > 0 && line.slice(0, eq).trim() === 'AGENT_TOKEN') return line.slice(eq + 1).trim()
      }
    } catch {
      /* absent is normal on a machine that has not been set up */
    }
  }
  return ''
}

async function liveManifest() {
  const controller = new AbortController()
  const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
  try {
    const token = agentToken()
    const response = await fetch(`${AGENT_URL.replace(/\/$/, '')}/capabilities`, {
      headers: token ? { Authorization: `Bearer ${token}` } : {},
      signal: controller.signal,
    })
    if (!response.ok) return { error: `GET /capabilities -> ${response.status}` }
    return { manifest: await response.json() }
  } catch (error) {
    return { error: error.name === 'AbortError' ? `no answer in ${TIMEOUT_MS}ms` : error.message }
  } finally {
    clearTimeout(timer)
  }
}

const { manifest, error } = await liveManifest()

if (error) {
  /*
   * A silent no-op here would be the same class of bug this file exists to
   * close: the publisher appearing to run while the agents learn nothing. An
   * unreachable agent is also not a reason to deposit a guess.
   */
  process.stdout.write(`Could not read the live manifest: ${error}\n`)
  process.stdout.write(`Nothing published. Start the agent, or set MAC_AGENT_URL.\n`)
  process.exit(1)
}

const http = manifest.http || {}
const actions = manifest.actions || {}

/*
 * Route paths and action names only — not their descriptions. The descriptions
 * are large and churn on wording, and a wording change is not news to an agent
 * planning against a surface. What is news is a route existing that did not.
 */
const summary = {
  surface: 'mac-local-agent',
  routeCount: http.routeCount ?? (http.routes || []).length,
  actionCount: (actions.types || []).length,
  routes: (http.routes || [])
    .map((route) => `${route.method} ${route.path}`)
    .sort(),
  actionTypes: (actions.types || [])
    .map((entry) => (typeof entry === 'string' ? entry : entry.type))
    .filter(Boolean)
    .sort(),
  undocumented: {
    routes: (http.undocumentedRoutes || []).length,
    actions: (actions.undocumented || []).length,
  },
}

const key = 'capability_manifest:surface=mac-local-agent'
const before = recall(OUT_DIR, key)
const beforeRoutes = new Set(before?.content?.routes || [])
const afterRoutes = new Set(summary.routes)

deposit(OUT_DIR, {
  tool: 'capability_manifest',
  args: { surface: 'mac-local-agent' },
  result: summary,
  agent: 'orchestrator',
  round: 0,
})

const added = summary.routes.filter((route) => !beforeRoutes.has(route))
const removed = [...beforeRoutes].filter((route) => !afterRoutes.has(route))

process.stdout.write(
  `Published ${summary.routeCount} routes and ${summary.actionCount} action types.\n`,
)
if (!before) {
  process.stdout.write('First publication — every agent will see this as new.\n')
} else if (!added.length && !removed.length) {
  process.stdout.write(
    'Unchanged since the last publication, so this is a re-confirmation and wakes nobody.\n',
  )
} else {
  process.stdout.write(`\n${added.length} new, ${removed.length} gone:\n`)
  for (const route of added.slice(0, 20)) process.stdout.write(`  + ${route}\n`)
  for (const route of removed.slice(0, 20)) process.stdout.write(`  - ${route}\n`)
  if (added.length + removed.length > 40) process.stdout.write('  …\n')
  process.stdout.write(
    '\nThis contradicts what the agents last saw, which makes them eligible.\n',
  )
}

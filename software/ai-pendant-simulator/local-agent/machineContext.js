import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

let cachedContext = null
let cachedAt = 0
const CACHE_MS = 60_000

/**
 * Runtime discovery only — no device-specific hardcoding.
 * Works on any Mac by scanning installed .app bundles.
 */
export async function getMachineContext() {
  const now = Date.now()

  if (cachedContext && now - cachedAt < CACHE_MS) {
    return cachedContext
  }

  const applications = listApplicationNames([
    '/Applications',
    path.join(os.homedir(), 'Applications'),
    '/System/Applications',
  ])

  cachedContext = {
    home: os.homedir(),
    hostname: os.hostname(),
    platform: process.platform,
    applications,
  }
  cachedAt = now
  return cachedContext
}

export function formatMachineContextForPrompt(context) {
  if (!context) {
    return ''
  }

  const apps = context.applications.join(', ')

  return `Live machine context for THIS device (discovered at runtime — do not assume another computer's software):
- Home: ${context.home}
- Host: ${context.hostname}
- Platform: ${context.platform}
- Installed applications: ${apps}

Universal judgment rules:
- Complete the user's intent using what is actually installed above.
- If the exact app is missing, choose the closest installed alternative from that list and say so in the action label.
- Never invent apps that are not listed.
- Never run shell/listing commands just to discover apps — the installed list is already provided.
- Keep plans short (1-3 actions) and prefer direct actions (open_app, open_url, write_file, etc.).`
}

export function findClosestInstalledApp(requestedName, applications = []) {
  const requested = normalizeAppName(requestedName)

  if (!requested || !applications.length) {
    return null
  }

  const exact = applications.find(
    (app) => normalizeAppName(app) === requested,
  )

  if (exact) {
    return exact
  }

  const contains = applications.find((app) => {
    const name = normalizeAppName(app)
    return name.includes(requested) || requested.includes(name)
  })

  if (contains) {
    return contains
  }

  // Lightweight token overlap, e.g. "visual studio code" vs "cursor" won't match,
  // but "google chrome" vs "chrome" will.
  const requestedTokens = new Set(requested.split(' ').filter(Boolean))
  let best = null
  let bestScore = 0

  for (const app of applications) {
    const tokens = normalizeAppName(app).split(' ').filter(Boolean)
    const overlap = tokens.filter((token) => requestedTokens.has(token)).length
    const score = overlap / Math.max(tokens.length, requestedTokens.length)

    if (score > bestScore) {
      bestScore = score
      best = app
    }
  }

  return bestScore >= 0.5 ? best : null
}

function listApplicationNames(roots) {
  const names = new Set()

  for (const root of roots) {
    if (!fs.existsSync(root)) {
      continue
    }

    let entries

    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }

    for (const entry of entries) {
      if (!entry.name.endsWith('.app')) {
        continue
      }

      names.add(entry.name.replace(/\.app$/i, ''))
    }
  }

  return [...names].sort((left, right) => left.localeCompare(right))
}

function normalizeAppName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\.app$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

export async function refreshMachineContext() {
  cachedAt = 0
  cachedContext = null
  return getMachineContext()
}

export function warmMachineContext() {
  getMachineContext().catch(() => {})
}

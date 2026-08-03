/**
 * Load the single repo-root `.env` for every AI Pendant package.
 * There is intentionally no package-local env file — only <repo>/.env.
 *
 * Safe on Cloudflare Workers: never throws if import.meta.url / fs are
 * unavailable. Workers get secrets from bindings via setCloudflareBindings().
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

function resolveRepoRoot() {
  try {
    const metaUrl = import.meta?.url
    if (typeof metaUrl !== 'string' || metaUrl.length === 0) return null
    const here = path.dirname(fileURLToPath(metaUrl))
    // software/ -> repo root
    return path.resolve(here, '..')
  } catch {
    return null
  }
}

const repoRoot = resolveRepoRoot()

const CANDIDATES = [
  process.env.AI_PENDANT_ENV_PATH,
  repoRoot ? path.join(repoRoot, '.env') : null,
].filter((value) => typeof value === 'string' && value.length > 0)

let loadedFrom = null

function parseEnvFile(filePath) {
  if (typeof filePath !== 'string' || !filePath) return
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return
  }
  for (const rawLine of text.split(/\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value
    }
  }
}

function canUseFilesystem() {
  try {
    return typeof fs.existsSync === 'function' && typeof fs.readFileSync === 'function'
  } catch {
    return false
  }
}

if (canUseFilesystem()) {
  for (const candidate of CANDIDATES) {
    try {
      if (candidate && fs.existsSync(candidate)) {
        parseEnvFile(candidate)
        loadedFrom = candidate
        break
      }
    } catch {
      // Workers / restricted runtimes: skip local .env quietly.
    }
  }
}

// --- aliases (old names → short set) ---
// Prefer OpenAI for audio-native planning when present.
if (!process.env.OPENAI_API_KEY && process.env.OPENAI_KEY) {
  process.env.OPENAI_API_KEY = process.env.OPENAI_KEY
}
if (!process.env.GEMINI_API_KEY && process.env.GOOGLE_API_KEY) {
  process.env.GEMINI_API_KEY = process.env.GOOGLE_API_KEY
}
if (!process.env.LLM_API_KEY && process.env.OPENROUTER_API_KEY) {
  process.env.LLM_API_KEY = process.env.OPENROUTER_API_KEY
}
if (!process.env.OPENROUTER_API_KEY && process.env.LLM_API_KEY) {
  process.env.OPENROUTER_API_KEY = process.env.LLM_API_KEY
}
// Text LLM on Mac can use OpenAI when no OpenRouter key is set.
if (!process.env.LLM_API_KEY && process.env.OPENAI_API_KEY) {
  process.env.LLM_API_KEY = process.env.OPENAI_API_KEY
}
if (!process.env.DASHBOARD_ACCESS_KEY && process.env.PAIRING_CODE) {
  process.env.DASHBOARD_ACCESS_KEY = process.env.PAIRING_CODE
}
if (!process.env.PAIRING_CODE && process.env.DASHBOARD_ACCESS_KEY) {
  process.env.PAIRING_CODE = process.env.DASHBOARD_ACCESS_KEY
}
if (!process.env.DASHBOARD_SESSION_SECRET && process.env.SESSION_SECRET) {
  process.env.DASHBOARD_SESSION_SECRET = process.env.SESSION_SECRET
}
if (!process.env.SESSION_SECRET && process.env.DASHBOARD_SESSION_SECRET) {
  process.env.SESSION_SECRET = process.env.DASHBOARD_SESSION_SECRET
}
if (!process.env.VITE_RELAY_URL && process.env.RELAY_URL) {
  process.env.VITE_RELAY_URL = process.env.RELAY_URL
}
/*
 * Never alias private credentials to VITE_* names. Vite embeds every VITE_*
 * value in browser JavaScript at build time, so doing that would turn the
 * relay administrator key or local-agent bearer token into a public secret.
 * Browser clients must pair or receive credentials at runtime instead.
 */
if (!process.env.LOCAL_AGENT_URL) {
  const port = process.env.MAC_AGENT_PORT || '8000'
  process.env.LOCAL_AGENT_URL = `http://127.0.0.1:${port}`
}

export function pendantEnvPath() {
  return loadedFrom
}

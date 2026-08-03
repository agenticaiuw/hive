/**
 * Load the single repo-root `.env` for every AI Pendant package.
 * There is intentionally no package-local env file — only <repo>/.env.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
// software/ -> repo root
const repoRoot = path.resolve(here, '..')

const CANDIDATES = [
  process.env.AI_PENDANT_ENV_PATH,
  path.join(repoRoot, '.env'),
].filter(Boolean)

let loadedFrom = null

function parseEnvFile(filePath) {
  const text = fs.readFileSync(filePath, 'utf8')
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

for (const candidate of CANDIDATES) {
  if (candidate && fs.existsSync(candidate)) {
    parseEnvFile(candidate)
    loadedFrom = candidate
    break
  }
}

// --- aliases (old names → short set) ---
if (!process.env.LLM_API_KEY && process.env.OPENROUTER_API_KEY) {
  process.env.LLM_API_KEY = process.env.OPENROUTER_API_KEY
}
if (!process.env.OPENROUTER_API_KEY && process.env.LLM_API_KEY) {
  process.env.OPENROUTER_API_KEY = process.env.LLM_API_KEY
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
if (!process.env.VITE_RELAY_API_KEY && process.env.RELAY_API_KEY) {
  process.env.VITE_RELAY_API_KEY = process.env.RELAY_API_KEY
}
if (!process.env.VITE_AGENT_TOKEN && process.env.AGENT_TOKEN) {
  process.env.VITE_AGENT_TOKEN = process.env.AGENT_TOKEN
}
if (!process.env.LOCAL_AGENT_URL) {
  const port = process.env.MAC_AGENT_PORT || '8000'
  process.env.LOCAL_AGENT_URL = `http://127.0.0.1:${port}`
}

export function pendantEnvPath() {
  return loadedFrom
}

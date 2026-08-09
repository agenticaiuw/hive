/**
 * Load the single repo-root `.env` for every AI Pendant package.
 * There is intentionally no package-local env file — only <repo>/.env.
 *
 * Safe on Cloudflare Workers: never throws if import.meta.url / fs are
 * unavailable. Workers get secrets from bindings via setCloudflareBindings().
 *
 * Precedence: an explicit process env value wins over the file, except that an
 * empty string counts as unset and is filled from the file. process.loadEnvFile
 * cannot express that rule (it never touches an existing key, empty or not),
 * which is why this stays a manual loop over util.parseEnv output.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

try {
  const here = path.dirname(fileURLToPath(import.meta.url))
  // software/ -> repo root
  const envPath = path.join(path.resolve(here, '..'), '.env')
  const parsed = parseEnv(fs.readFileSync(envPath, 'utf8'))
  for (const [key, value] of Object.entries(parsed)) {
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value
    }
  }
} catch {
  // Workers / restricted runtimes, or no repo .env: skip quietly.
}

// --- aliases (old names → short set) ---
// Prefer OpenAI for audio-native planning when present.
if (!process.env.OPENAI_API_KEY && process.env.OPENAI_KEY) {
  process.env.OPENAI_API_KEY = process.env.OPENAI_KEY
}
// Text LLM on Mac can use OpenAI when no dedicated key is set.
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

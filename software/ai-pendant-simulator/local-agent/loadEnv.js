/**
 * Load repo .env into process.env before other local-agent modules read keys.
 * LaunchAgent does not inject secrets — only PATH — so this is required.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const here = path.dirname(fileURLToPath(import.meta.url))

const CANDIDATES = [
  path.resolve(here, '../../../.env'), // repo root agentic-gadget/.env
  path.resolve(here, '../../.env'), // software/ai-pendant-simulator/.env
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
]

const appliedKeys = new Set()

/**
 * Put parsed keys into process.env. Exported only so the precedence rule is
 * testable without touching the real .env file; not part of the module's API.
 *
 * Keys are recorded whether or not they were applied: a key the shell already
 * set to the same credential is exactly as sensitive as one read from here,
 * and the point of the record is to keep it out of children (childEnv.js).
 *
 * Precedence: an explicit process env value (LaunchAgent / shell) is never
 * clobbered — the file only fills keys that are unset or empty.
 */
export function applyParsedEnv(parsed) {
  for (const [key, value] of Object.entries(parsed)) {
    appliedKeys.add(key)
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value
    }
  }
}

function applyEnvFile(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return false
  }
  applyParsedEnv(parseEnv(text))
  return true
}

let loadedFrom = null
for (const candidate of CANDIDATES) {
  if (applyEnvFile(candidate)) {
    loadedFrom = candidate
    break
  }
}

export function envLoadedFrom() {
  return loadedFrom
}

/**
 * The keys this file put into process.env, so callers can take them back out.
 *
 * A child process started by the agent inherits process.env by default, which
 * means every `run_shell` action has been running with the relay key, the agent
 * token and the session secret in its environment — one `env` away from being
 * printed into stdout, which is then stored on the job and can be composed into
 * a model prompt. Knowing which keys arrived from the .env file is what lets a
 * child be given everything EXCEPT the app's own credentials, without anyone
 * maintaining a list of secret names by hand.
 */
export function envKeysFromFile() {
  return [...appliedKeys]
}

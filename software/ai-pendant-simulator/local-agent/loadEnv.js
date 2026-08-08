/**
 * Load repo .env into process.env before other local-agent modules read keys.
 * LaunchAgent does not inject secrets — only PATH — so this is required.
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))

const CANDIDATES = [
  path.resolve(here, '../../../.env'), // repo root agentic-gadget/.env
  path.resolve(here, '../../.env'), // software/ai-pendant-simulator/.env
  path.resolve(process.cwd(), '.env'),
  path.resolve(process.cwd(), '../../.env'),
]

const appliedKeys = new Set()

function applyEnvFile(filePath) {
  let text
  try {
    text = fs.readFileSync(filePath, 'utf8')
  } catch {
    return false
  }
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim()
    if (!line || line.startsWith('#')) continue
    const eq = line.indexOf('=')
    if (eq <= 0) continue
    const key = line.slice(0, eq).trim()
    if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) continue
    let value = line.slice(eq + 1).trim()
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      value = value.slice(1, -1)
    }
    /* Recorded whether or not it was applied: a key the shell already set to
     * the same credential is exactly as sensitive as one read from here, and
     * the point of the record is to keep it out of children. */
    appliedKeys.add(key)
    // Do not clobber explicit process env (LaunchAgent / shell).
    if (process.env[key] === undefined || process.env[key] === '') {
      process.env[key] = value
    }
  }
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

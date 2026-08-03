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

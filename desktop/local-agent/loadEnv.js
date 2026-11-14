/**
 * Load repo .env into process.env before other local-agent modules read keys.
 * LaunchAgent does not inject secrets — only PATH — so this is required.
 */
import { createHmac } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { parseEnv } from 'node:util'

const here = path.dirname(fileURLToPath(import.meta.url))

const CANDIDATES = [
  path.resolve(here, '../../.env'), // repository root
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

/* ===================================================================== *
 * Derived secrets: PAIRING_CODE is the one owner-minted secret.
 *
 * The .env used to carry three independent random values that all proved the
 * same thing — "this is the owner's machine": PAIRING_CODE, AGENT_TOKEN and
 * SESSION_SECRET. Three values in ONE file is not three secrets; whoever
 * reads the file has all of them, so the extra two bought no isolation, only
 * bookkeeping. The owner's verdict (2026-08-09): "we must reduce the number
 * of env variables as much as possible."
 *
 * So the other two are now derived from PAIRING_CODE with labelled HMACs.
 * Deterministic and stateless: every process that can read the code computes
 * the same tokens, nothing new is stored, and rotating the code rotates
 * everything below it in one edit.
 *
 * Precedence is applyParsedEnv's, unchanged: an explicit AGENT_TOKEN or
 * SESSION_SECRET in the environment or the file still wins, which is both
 * the migration path and the escape hatch (the Mac menubar HUD, if it holds
 * the old token value somewhere of its own, is fixed by putting the old
 * AGENT_TOKEN line back).
 *
 * Going through applyParsedEnv rather than assigning process.env directly is
 * load-bearing: it records the keys, and childEnv.js strips recorded keys
 * from every child the agent spawns. A derived credential that skipped the
 * record would ride into run_shell children — the exact leak childEnv
 * exists to prevent.
 *
 * The same derivation exists in cloud/shared/loadEnv.mjs for scripts
 * and the dashboards. Duplicated, not imported — the loaders belong to
 * different packages and each must work with the other absent — and
 * loadEnv.test.js asserts the two stay bit-identical.
 * ===================================================================== */

export function deriveSecret(masterSecret, label) {
  const master = String(masterSecret ?? '')
  if (!master) return ''
  return createHmac('sha256', master).update(`hive:${label}`).digest('hex')
}

if (process.env.PAIRING_CODE) {
  applyParsedEnv({
    AGENT_TOKEN: deriveSecret(process.env.PAIRING_CODE, 'agent-token'),
    SESSION_SECRET: deriveSecret(process.env.PAIRING_CODE, 'session-secret'),
  })
}

/*
 * The production relay, as the default. The localhost:8787 fallback in
 * bridgeConfig.js dated from before the worker was deployed; on this machine
 * RELAY_URL has pointed at the worker ever since, so the env line was
 * restating a constant. The extension already ships this origin in its
 * RELAY_ORIGIN_ALLOWLIST — it is config, not a secret. `npm run relay` local
 * development sets RELAY_URL=http://localhost:8787 explicitly.
 */
applyParsedEnv({
  RELAY_URL: 'https://hive-relay.evan20050827.workers.dev',
})

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

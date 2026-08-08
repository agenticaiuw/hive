/*
 * The environment a child process gets, with the agent's own credentials taken
 * out.
 *
 * Every exec in this codebase inherited process.env, either explicitly
 * (`env: process.env` in runShell) or by omission, which is the same thing.
 * That put RELAY_API_KEY, AGENT_TOKEN, SESSION_SECRET, OPENAI_API_KEY and the
 * pairing code into the environment of every `run_shell` action — including
 * ones a model planned from a spoken sentence. `env`, `printenv`, or a script
 * that logs its own environment prints them to stdout, stdout is stored on the
 * job record, and job records are composed into later prompts. No exploit
 * required; one ordinary diagnostic command does it.
 *
 * Two rules rather than a list of secret names, because a hand-maintained list
 * is wrong the first time someone adds a key:
 *
 *   1. Anything that came from the .env file. loadEnv.js records what it read,
 *      so this stays correct when the file grows. These are the app's own
 *      credentials by definition.
 *   2. Anything whose NAME looks like a credential, wherever it came from. The
 *      agent also inherits the launching shell's environment, which on a
 *      developer's machine is full of tokens this file has never heard of.
 *
 * Everything else is kept. Stripping PATH, HOME, LANG or TMPDIR would break
 * ordinary commands, and a shell action that cannot run is not safer, it is
 * just broken in a way someone will fix by handing the whole environment back.
 */
import { envKeysFromFile } from './loadEnv.js'

/*
 * Substring match, deliberately. AWS_SECRET_ACCESS_KEY, GITHUB_TOKEN,
 * npm_config_//registry.npmjs.org/:_authToken and MY_APP_PASSWORD all have to
 * be caught, and they share no prefix or suffix.
 */
const CREDENTIAL_NAME =
  /(?:SECRET|TOKEN|PASSWORD|PASSWD|CREDENTIAL|PRIVATE_KEY|API_KEY|APIKEY|AUTH|SESSION|COOKIE|PASSPHRASE)/i

/*
 * A URL is not a credential and several commands genuinely need one, but a URL
 * with a password in it is. Kept narrow: this only matters for values whose
 * name did not already give them away.
 */
const CREDENTIAL_IN_URL = /^[a-z][a-z0-9+.-]*:\/\/[^/\s:@]+:[^/\s@]+@/i

export function isCredentialName(name) {
  return CREDENTIAL_NAME.test(String(name || ''))
}

/**
 * Build the environment for a child process.
 *
 * `extra` is merged in after filtering, so a caller that deliberately needs to
 * pass one credential to one command still can — explicitly, at the call site,
 * where it is reviewable. That is the difference between a decision and an
 * accident.
 */
export function childEnv({ base = process.env, extra = null } = {}) {
  const fromFile = new Set(envKeysFromFile())
  const out = {}

  for (const [key, value] of Object.entries(base)) {
    if (fromFile.has(key)) continue
    if (isCredentialName(key)) continue
    if (typeof value === 'string' && CREDENTIAL_IN_URL.test(value)) continue
    out[key] = value
  }

  return extra ? { ...out, ...extra } : out
}

/**
 * What was withheld, for a caller that wants to say so rather than let a
 * command fail with an unexplained empty variable.
 *
 * Names only. Returning the values would recreate the leak inside the thing
 * built to prevent it.
 */
export function withheldEnvNames({ base = process.env } = {}) {
  const fromFile = new Set(envKeysFromFile())
  return Object.keys(base)
    .filter(
      (key) =>
        fromFile.has(key) ||
        isCredentialName(key) ||
        CREDENTIAL_IN_URL.test(String(base[key] ?? '')),
    )
    .sort()
}

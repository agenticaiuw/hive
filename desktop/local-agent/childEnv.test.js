import assert from 'node:assert/strict'
import test from 'node:test'

import { childEnv, isCredentialName, withheldEnvNames } from './childEnv.js'

/*
 * Every value here is synthetic. A test fixture that carried a real key would
 * put it in git, which is the failure this module exists to prevent, one layer
 * further out.
 */
const FAKE = 'synthetic-not-a-real-credential'

test('the app’s own .env keys never reach a child', () => {
  /*
   * This is the concrete leak: runShell passed `env: process.env`, so every
   * command the planner emitted ran with the relay key and the agent token in
   * its environment. `printenv` puts them on stdout, stdout is stored on the
   * job record, and job records are composed into later prompts.
   */
  const base = {
    PATH: '/usr/bin',
    RELAY_API_KEY: FAKE,
    AGENT_TOKEN: FAKE,
    SESSION_SECRET: FAKE,
    OPENAI_API_KEY: FAKE,
    PAIRING_CODE: FAKE,
    NRF_CLOUD_API_KEY: FAKE,
  }
  const out = childEnv({ base })

  assert.equal(out.PATH, '/usr/bin', 'a child still needs to find its binaries')
  for (const key of Object.keys(base)) {
    if (key === 'PATH') continue
    assert.equal(out[key], undefined, `${key} must not reach a child`)
  }
  assert.ok(
    !Object.values(out).includes(FAKE),
    'no withheld value may survive under a different name',
  )
})

test('credential-shaped names are caught wherever they came from', () => {
  /*
   * The agent inherits the launching shell too, which on a developer machine
   * carries tokens this project has never heard of. A list of known secret
   * names would miss every one of them.
   */
  const base = {
    HOME: '/Users/someone',
    LANG: 'en_US.UTF-8',
    TMPDIR: '/tmp',
    AWS_SECRET_ACCESS_KEY: FAKE,
    GITHUB_TOKEN: FAKE,
    MY_APP_PASSWORD: FAKE,
    STRIPE_API_KEY: FAKE,
    DB_PASSWD: FAKE,
    SOME_PASSPHRASE: FAKE,
    HTTP_AUTHORIZATION: FAKE,
  }
  const out = childEnv({ base })

  assert.deepEqual(
    Object.keys(out).sort(),
    ['HOME', 'LANG', 'TMPDIR'],
    'ordinary environment survives, credentials do not',
  )
})

test('a password embedded in a URL is withheld even under an innocent name', () => {
  /*
   * SOME_SERVICE_URL rather than RELAY_URL: RELAY_URL really is in this repo's
   * .env, so rule 1 withholds it and it cannot demonstrate the plain-URL case.
   * That is the correct behaviour — everything the app loaded for itself stays
   * with the app — and it is worth knowing that a shell action does not get the
   * relay's address either.
   */
  const base = {
    SOME_SERVICE_URL: 'https://service.example/v1',
    DATABASE_URL: 'postgres://user:hunter2@db.example/app',
    NPM_REGISTRY: 'https://registry.npmjs.org/',
  }
  const out = childEnv({ base })

  assert.equal(out.SOME_SERVICE_URL, 'https://service.example/v1', 'a plain URL is not a secret')
  assert.equal(out.NPM_REGISTRY, 'https://registry.npmjs.org/')
  assert.equal(out.DATABASE_URL, undefined, 'credentials in a URL are still credentials')
})

test('everything the app loaded from .env is withheld, secret-looking or not', () => {
  /* RELAY_URL is the live example: not a secret by name, still the app's own
   * configuration, and a shell command has no business inheriting it. */
  const out = childEnv()
  assert.equal(out.RELAY_URL, undefined)
})

test('an explicit extra is merged after filtering, so a deliberate pass stays possible', () => {
  /*
   * The point is that it has to be written at the call site, where someone can
   * see it, rather than arriving by inheritance.
   */
  const out = childEnv({
    base: { PATH: '/usr/bin', RELAY_API_KEY: FAKE },
    extra: { RELAY_API_KEY: 'passed-on-purpose' },
  })

  assert.equal(out.RELAY_API_KEY, 'passed-on-purpose')
})

test('withheldEnvNames reports names and never values', () => {
  const base = { PATH: '/usr/bin', GITHUB_TOKEN: FAKE, HOME: '/Users/someone' }
  const names = withheldEnvNames({ base })

  assert.deepEqual(names, ['GITHUB_TOKEN'])
  assert.ok(
    !JSON.stringify(names).includes(FAKE),
    'reporting what was withheld must not re-leak it',
  )
})

test('the real process environment is filtered, not merely copied', () => {
  /*
   * Guards the wiring rather than the rule: childEnv() with no argument is what
   * runShell actually calls, and it must read process.env through the same
   * filter. A regression that restored `env: process.env` would pass every test
   * above and fail this one.
   */
  const out = childEnv()
  const leaked = Object.keys(out).filter((key) => isCredentialName(key))
  assert.deepEqual(leaked, [], `credential-named variables reached the child: ${leaked}`)

  for (const key of ['RELAY_API_KEY', 'AGENT_TOKEN', 'OPENAI_API_KEY', 'SESSION_SECRET']) {
    assert.equal(out[key], undefined, `${key} reached the child`)
  }
  assert.ok(out.PATH, 'PATH must survive or ordinary commands break')
})

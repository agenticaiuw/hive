import assert from 'node:assert/strict'
import test from 'node:test'

import { applyParsedEnv, envKeysFromFile } from './loadEnv.js'

/*
 * The precedence rule is the contract childEnv.js and the LaunchAgent rely on:
 * a value already present in process.env wins over the .env file, EXCEPT when
 * it is the empty string — an empty value is treated as unset and filled from
 * the file. Asserted here against sentinel keys so the real .env is never
 * read, written, or printed by this test.
 */
test('.env values never clobber explicit process env, but do fill empty and unset keys', () => {
  const SET = 'PENDANT_LOADENV_TEST_SET'
  const EMPTY = 'PENDANT_LOADENV_TEST_EMPTY'
  const UNSET = 'PENDANT_LOADENV_TEST_UNSET'

  process.env[SET] = 'from-shell'
  process.env[EMPTY] = ''
  delete process.env[UNSET]

  try {
    applyParsedEnv({
      [SET]: 'from-file',
      [EMPTY]: 'from-file',
      [UNSET]: 'from-file',
    })

    assert.equal(process.env[SET], 'from-shell')
    assert.equal(process.env[EMPTY], 'from-file')
    assert.equal(process.env[UNSET], 'from-file')

    // Recorded whether or not applied: the shell-set key is exactly as
    // sensitive as one read from the file, and childEnv strips by this record.
    const recorded = envKeysFromFile()
    for (const key of [SET, EMPTY, UNSET]) {
      assert.ok(recorded.includes(key), `${key} recorded for childEnv stripping`)
    }
  } finally {
    delete process.env[SET]
    delete process.env[EMPTY]
    delete process.env[UNSET]
  }
})

test('derived secrets are labelled, stable, and never invented without a master', async () => {
  const { deriveSecret } = await import('./loadEnv.js')

  const agent = deriveSecret('master-code', 'agent-token')
  const session = deriveSecret('master-code', 'session-secret')

  /* Deterministic: every process that reads the code computes the same
   * token — that is what lets the value leave .env entirely. */
  assert.equal(agent, deriveSecret('master-code', 'agent-token'))
  /* Labelled: the two derived secrets must never collide, or the session
   * secret IS the bearer token. */
  assert.notEqual(agent, session)
  /* 64 hex chars — clears the dashboard's MIN_SESSION_SECRET_LENGTH of 32. */
  assert.match(agent, /^[0-9a-f]{64}$/)
  /* No master, no secret. Deriving from '' would mint the same "secret" on
   * every unconfigured checkout in the world. */
  assert.equal(deriveSecret('', 'agent-token'), '')
  assert.equal(deriveSecret(null, 'agent-token'), '')
})

test('both loaders derive bit-identical secrets', async () => {
  /*
   * The derivation is deliberately duplicated in software/load-pendant-env.mjs
   * (different packages, each must work with the other absent). This is the
   * assertion that keeps the copies honest: if they drift, the agent and the
   * scripts compute DIFFERENT agent tokens from the same pairing code, and
   * every script gets 401s that look like a corrupted .env.
   */
  const local = (await import('./loadEnv.js')).deriveSecret
  const shared = (await import('../../load-pendant-env.mjs')).deriveSecret

  for (const label of ['agent-token', 'session-secret', 'future-label']) {
    assert.equal(local('sample-master', label), shared('sample-master', label))
  }
})

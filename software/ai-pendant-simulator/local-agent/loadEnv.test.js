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

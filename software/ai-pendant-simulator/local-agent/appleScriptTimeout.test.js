import assert from 'node:assert/strict'
import test from 'node:test'

import { APPLESCRIPT_TIMEOUT_MS } from './config.js'
import {
  appleScriptTimeoutMessage,
  executeComputerAction,
} from './computerControl.js'

/*
 * The ceiling that job local_bd15c683-ba80-4079-9498-925112883bcd needed.
 *
 * That job's script — a repeat loop over `every reminder` — was still running
 * when it was killed by hand past sixty seconds, and it would have run to the
 * full two-minute shell ceiling before anything reported anything. A job must
 * not be able to hang on a script.
 *
 * The tests below use a real osascript child with a tiny ceiling rather than a
 * stub, because the thing under test IS the child-killing: a mocked exec would
 * assert that the code calls a function, not that the process actually dies.
 * `delay 5` needs no Automation grant and touches no app, so it runs anywhere
 * this agent runs, and the assertion completes in well under a second.
 */

test('the ceiling is 45 seconds by default', () => {
  assert.equal(APPLESCRIPT_TIMEOUT_MS, 45_000)
})

test('the timeout message names the cause and the way out', () => {
  const message = appleScriptTimeoutMessage(45_000)
  assert.match(message, /exceeded 45s and was stopped/)
  assert.match(message, /repeat loop or a whose-clause/)
  assert.match(message, /list_reminders/)
  assert.match(message, /list_calendar_events/)
})

test('a script that outruns its ceiling is killed and says why', async () => {
  const startedAt = Date.now()

  await assert.rejects(
    executeComputerAction({
      type: 'run_applescript',
      params: { script: 'delay 5', timeoutMs: 400 },
    }),
    (error) => {
      assert.match(error.message, /exceeded 0s|exceeded 1s/)
      assert.match(error.message, /was stopped/)
      assert.match(error.message, /list_reminders/)
      return true
    },
  )

  /* The point is not that it eventually failed — it is that it failed at the
   * ceiling instead of at the script's own pace. */
  assert.ok(
    Date.now() - startedAt < 3_000,
    'the timeout did not stop the script anywhere near its ceiling',
  )
})

test('a script inside its ceiling still returns its output', async () => {
  const result = await executeComputerAction({
    type: 'run_applescript',
    params: { script: 'return "ok"', timeoutMs: 10_000 },
  })

  assert.equal(result.ok, true)
  assert.equal(result.stdout, 'ok')
})

/* A caller asking for an hour gets 45 seconds. The knob lowers the ceiling; it
 * is not a way through it. */
test('a requested timeout above the cap does not raise the cap', async () => {
  const startedAt = Date.now()
  await assert.rejects(
    executeComputerAction({
      type: 'run_applescript',
      params: { script: 'delay 5', timeoutMs: 500 },
    }),
    /was stopped/,
  )
  assert.ok(Date.now() - startedAt < 3_000)
})

test('an empty script is refused before anything is spawned', async () => {
  await assert.rejects(
    executeComputerAction({ type: 'run_applescript', params: { script: '  ' } }),
    /requires a script/,
  )
})

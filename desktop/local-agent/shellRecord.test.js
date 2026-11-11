import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import test from 'node:test'
import './testWorkspace.js'
import { executeComputerAction } from './computerControl.js'
import { runWithCancellation } from './jobControl.js'
import { SHELL_TIMEOUT_MS } from './config.js'

const execFileAsync = promisify(execFile)
const moduleDirectory = path.dirname(new URL(import.meta.url).pathname)

const shellAction = (command, params = {}) => ({
  type: 'run_shell',
  label: 'test command',
  params: { command, ...params },
})

const tempFile = (name) =>
  path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-shell-test-')), name)

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))

/*
 * What the record has to contain.
 *
 * The old runShell used promisify(exec), which rejects on a non-zero exit.
 * executor.js caught that rejection, kept `error.message`, and dropped
 * `error.code`, `error.signal`, `error.killed` and the command's own output —
 * all of which the rejection was carrying. "exited 42 with a diagnostic on
 * stderr" and "killed at the timeout" reached the job record as the same thing.
 */
test('a non-zero exit is recorded with its code, not flattened into a message', async () => {
  const result = await executeComputerAction(
    shellAction('echo to-stdout; echo to-stderr 1>&2; exit 42'),
  )

  assert.equal(result.ok, false)
  assert.equal(result.status, 'failed')
  assert.equal(result.shell.exitCode, 42)
  assert.equal(result.shell.ok, false)
  assert.equal(result.shell.outcome, 'failed')
  assert.equal(result.shell.killed, false)
  assert.equal(result.shell.timedOut, false)
  assert.equal(result.shell.cancelled, false)
  assert.equal(result.shell.signal, null)
  // The output of a failed command used to be discarded entirely.
  assert.equal(result.stdout, 'to-stdout')
  assert.equal(result.stderr, 'to-stderr')
  assert.match(result.message, /exited 42/)
})

test('a clean exit records the zero as well as the output', async () => {
  const result = await executeComputerAction(shellAction('echo hello'))

  assert.equal(result.ok, true)
  assert.equal(result.status, 'success')
  assert.equal(result.stdout, 'hello')
  assert.equal(result.shell.exitCode, 0)
  assert.equal(result.shell.ok, true)
  assert.equal(result.shell.outcome, 'exited')
  assert.equal(result.shell.killed, false)
  assert.ok(Number.isFinite(result.shell.durationMs))
})

test('a timeout kill is distinguishable from the command exiting badly', async () => {
  const result = await executeComputerAction(shellAction('sleep 30', { timeout: 250 }))

  assert.equal(result.ok, false)
  assert.equal(result.shell.timedOut, true)
  assert.equal(result.shell.killed, true)
  assert.equal(result.shell.exitCode, null)
  assert.equal(result.shell.signal, 'SIGTERM')
  assert.equal(result.shell.outcome, 'timed_out')
  assert.match(result.message, /timed out after 250ms/)
})

test('a command killed by a signal says which signal', async () => {
  const result = await executeComputerAction(
    shellAction('kill -INT $$; sleep 5'),
  )

  assert.equal(result.ok, false)
  assert.equal(result.shell.killed, true)
  assert.equal(result.shell.exitCode, null)
  assert.equal(result.shell.signal, 'SIGINT')
  assert.equal(result.shell.timedOut, false)
  assert.equal(result.shell.outcome, 'signalled')
})

/*
 * Cancellation.
 *
 * The claim to disprove is "cancel reports success while the command keeps
 * running". The marker file is the proof: the command backgrounds a subshell
 * that will touch it in three seconds, so the marker existing afterwards means
 * something in the group survived the kill.
 */
test('a cancel kills the whole process group, not just the shell', async () => {
  const marker = tempFile('survivor.txt')
  const controller = new AbortController()

  const started = Date.now()
  const result = await runWithCancellation(controller.signal, async () => {
    const running = executeComputerAction(
      shellAction(`( sleep 3; touch ${JSON.stringify(marker)} ) & wait`),
    )
    await sleep(200)
    controller.abort('cancelled from test')
    return running
  })
  const elapsed = Date.now() - started

  assert.equal(result.ok, false)
  assert.equal(result.status, 'cancelled')
  assert.equal(result.shell.cancelled, true)
  assert.equal(result.shell.killed, true)
  assert.equal(result.shell.interruptible, true)
  assert.match(result.message, /process group was killed/)
  // It stopped when asked, rather than running its three seconds out.
  assert.ok(elapsed < 2_000, `cancel took ${elapsed}ms; the command was not interrupted`)

  // The backgrounded subshell is a sibling of the shell, so killing only the
  // direct child would leave it alive to create this.
  await sleep(3_400)
  assert.equal(
    fs.existsSync(marker),
    false,
    'a process in the cancelled group survived and kept working',
  )
})

/*
 * The real chain. executor.js takes `executeActions(actions)` and nothing else,
 * which is why the signal travels in an async-local scope instead of an
 * argument — so the scope has to survive that call unchanged. This is the exact
 * shape orchestrator.js now wraps.
 */
test('the cancellation scope survives the executor, which takes no signal', async () => {
  const { executeActions } = await import('./executor.js')
  const controller = new AbortController()

  const started = Date.now()
  const [result] = await runWithCancellation(controller.signal, async () => {
    const running = executeActions([shellAction('sleep 10')])
    await sleep(200)
    controller.abort('cancelled from test')
    return running
  })

  assert.ok(Date.now() - started < 2_000)
  assert.equal(result.shell.interruptible, true)
  assert.equal(result.shell.cancelled, true)
  assert.equal(result.status, 'cancelled')
  // The receipt executor.js builds still describes the submitted action.
  assert.equal(result.receipt.type, 'run_shell')
  assert.equal(result.receipt.ok, false)
})

test('a command that runs outside a cancellation scope says a cancel cannot reach it', async () => {
  const result = await executeComputerAction(shellAction('echo unscoped'))

  assert.equal(result.ok, true)
  assert.equal(result.shell.interruptible, false)
})

test('a cancellation scope is reported as interruptible', async () => {
  const controller = new AbortController()
  const result = await runWithCancellation(controller.signal, () =>
    executeComputerAction(shellAction('echo scoped')),
  )

  assert.equal(result.shell.interruptible, true)
})

/*
 * The record must not become a second copy of the leak childEnv.js just closed.
 */
test('the shell record carries argv and cwd but never the environment', async () => {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-shell-cwd-'))
  const result = await executeComputerAction(shellAction('pwd', { cwd: directory }))

  assert.deepEqual(result.shell.argv, ['/bin/sh', '-c', 'pwd'])
  assert.equal(result.shell.cwd, path.resolve(directory))
  assert.equal(result.stdout, fs.realpathSync(directory))
  assert.equal('env' in result.shell, false)
  assert.equal('environment' in result.shell, false)
  assert.equal(JSON.stringify(result.shell).includes('PATH'), false)
})

test('a credential written into a command line is redacted out of the record', async () => {
  const result = await executeComputerAction(
    shellAction('echo sk-live0123456789abcdef'),
  )

  assert.equal(result.shell.command, 'echo [withheld]')
  assert.deepEqual(result.shell.argv, ['/bin/sh', '-c', 'echo [withheld]'])
  assert.equal(result.shell.command.includes('sk-live'), false)
  assert.equal(result.shell.argv.join(' ').includes('sk-live'), false)
})

test('an ordinary command line is recorded verbatim, not blanked', async () => {
  const result = await executeComputerAction(shellAction('echo ordinary output'))
  assert.equal(result.shell.command, 'echo ordinary output')
})

/*
 * Rewriting.
 *
 * get_battery is the safe end-to-end case: it is a fixed read that dispatches
 * as a run_shell the caller never wrote. The overlay and research rewrites take
 * over the screen and the network respectively, so they are covered by reading
 * the dispatcher rather than by running it.
 */
test('an action that dispatches as something else records both forms', async () => {
  const result = await executeComputerAction({
    type: 'get_battery',
    label: 'Check the battery',
    params: {},
  })

  assert.equal(result.rewrite.reason, 'builtin-shell')
  assert.equal(result.rewrite.submitted.type, 'get_battery')
  assert.equal(result.rewrite.submitted.label, 'Check the battery')
  assert.equal(result.rewrite.executed.type, 'run_shell')
  assert.equal(result.rewrite.executed.params.command, 'pmset -g batt')
  // `action` is the executed form, and the record says so rather than leaving
  // a reader to work out which of the two it is looking at.
  assert.equal(result.action.type, 'run_shell')
  assert.equal(result.shell.command, 'pmset -g batt')
})

test('both deliberate rewrites route through the recorder rather than returning bare', () => {
  const source = fs.readFileSync(path.join(moduleDirectory, 'computerControl.js'), 'utf8')
  const dispatcher = source.slice(
    source.indexOf('export async function executeComputerAction'),
    source.indexOf('switch (action.type)'),
  )

  for (const reason of ['overlay-interception', 'research-cli-in-process']) {
    assert.ok(
      dispatcher.includes(`reason: '${reason}'`),
      `${reason} must record what was submitted alongside what ran`,
    )
  }
  // Neither interception may hand back a result without the rewrite record.
  assert.equal(
    (dispatcher.match(/return recordRewrite\(/g) ?? []).length,
    2,
    'every interception in the dispatcher preamble must be recorded',
  )
})

/*
 * The knob. SHELL_TIMEOUT_MS had no importers at all: computerControl.js used
 * its own constant with the same number in it, so setting the documented
 * environment variable changed a value nobody read.
 */
test('SHELL_TIMEOUT_MS is the ceiling an operator actually sets', async () => {
  const script = `
    import { executeComputerAction } from ${JSON.stringify(path.join(moduleDirectory, 'computerControl.js'))}
    const result = await executeComputerAction({
      type: 'run_shell',
      label: 'slow',
      params: { command: 'sleep 30' },
    })
    console.log(JSON.stringify({
      timeoutMs: result.shell.timeoutMs,
      timedOut: result.shell.timedOut,
    }))
  `

  const { stdout } = await execFileAsync(process.execPath, ['--input-type=module', '-e', script], {
    env: {
      ...process.env,
      SHELL_TIMEOUT_MS: '300',
      PENDANT_WORKSPACE_PATH: process.env.PENDANT_WORKSPACE_PATH,
    },
  })

  const observed = JSON.parse(stdout.trim().split('\n').at(-1))
  assert.equal(observed.timeoutMs, 300)
  assert.equal(observed.timedOut, true)
})

test('a per-action timeout may tighten the operator ceiling but not lift it', async () => {
  const under = await executeComputerAction(shellAction('echo quick', { timeout: 5_000 }))
  assert.equal(under.shell.timeoutMs, 5_000)

  const over = await executeComputerAction(
    shellAction('echo quick', { timeout: SHELL_TIMEOUT_MS * 10 }),
  )
  assert.equal(over.shell.timeoutMs, SHELL_TIMEOUT_MS)

  const nonsense = await executeComputerAction(shellAction('echo quick', { timeout: 'soon' }))
  assert.equal(nonsense.shell.timeoutMs, SHELL_TIMEOUT_MS)
})

test('the dead constant is gone and the config export is the live one', () => {
  const source = fs.readFileSync(path.join(moduleDirectory, 'computerControl.js'), 'utf8')
  assert.equal(source.includes('DEFAULT_SHELL_TIMEOUT_MS'), false)
  assert.match(source, /import \{[^}]*SHELL_TIMEOUT_MS[^}]*\} from '\.\/config\.js'/)
})

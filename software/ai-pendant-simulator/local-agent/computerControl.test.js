import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import test from 'node:test'
import { executeComputerAction } from './computerControl.js'
import { LOOP_ALLOWED_ACTIONS } from './computerUseLoop.js'

const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const source = fs.readFileSync(path.join(moduleDirectory, 'computerControl.js'), 'utf8')
const plannerSource = fs.readFileSync(path.join(moduleDirectory, 'llmPlanner.js'), 'utf8')

const dispatchableTypes = new Set(
  [...source.matchAll(/^\s*case '([a-z_]+)':/gm)].map((match) => match[1]),
)

// The action vocabulary is declared in two places — the dispatch switch and the
// schema the planner shows the model. They have drifted before. This locks the
// direction that actually causes user-visible failures: advertising something
// the agent cannot run.
test('every computer-use action advertised to the model is dispatchable', () => {
  const advertised = [
    'screenshot',
    'zoom',
    'ui_snapshot',
    'ui_find',
    'ui_click',
    'ui_menu',
    'ui_wait_for',
    'ui_hit_test',
    'mouse_move',
    'mouse_click',
    'mouse_double_click',
    'mouse_right_click',
    'mouse_drag',
    'mouse_down',
    'mouse_up',
    'scroll',
    'cursor_position',
    'list_displays',
    'computer_use_task',
  ]

  for (const type of advertised) {
    assert.ok(plannerSource.includes(`  ${type}: {`), `${type} must be advertised to the planner`)
    assert.ok(dispatchableTypes.has(type), `${type} must have a dispatch case`)
  }
})

test('every action the loop may emit is dispatchable', () => {
  for (const type of LOOP_ALLOWED_ACTIONS) {
    assert.ok(dispatchableTypes.has(type), `loop-allowed ${type} has no dispatch case`)
  }
})

test('an unknown action type is refused rather than silently ignored', async () => {
  await assert.rejects(
    () => executeComputerAction({ type: 'mouse_teleport', params: {} }),
    /Unsupported action type/,
  )
})

// These validate before touching the screen, so they are safe to run headlessly
// on any machine — nothing moves, nothing is clicked.
test('mouse actions reject malformed parameters before posting any event', async () => {
  const cases = [
    [{ type: 'mouse_move', params: {} }, /requires numeric x and y/],
    [{ type: 'mouse_click', params: { x: 10 } }, /requires numeric x and y/],
    [{ type: 'mouse_click', params: { x: 'a', y: 10 } }, /finite number/],
    [{ type: 'mouse_click', params: { x: 10, y: 10, button: 'thumb' } }, /Unsupported mouse button/],
    [{ type: 'mouse_click', params: { x: 10, y: 10, clicks: 9 } }, /integer 1, 2, or 3/],
    [{ type: 'mouse_click', params: { x: 10, y: 10, modifiers: ['hyper'] } }, /Unsupported modifier/],
    [{ type: 'mouse_drag', params: { fromX: 1, fromY: 2 } }, /requires numeric toX and toY/],
    [{ type: 'mouse_drag', params: { fromX: 1, fromY: 2, toX: 3, toY: 4, steps: 1 } }, /between 2 and 200/],
    [{ type: 'scroll', params: {} }, /non-zero dx or dy/],
    [{ type: 'scroll', params: { dy: 'down' } }, /finite number/],
    [{ type: 'ui_click', params: {} }, /requires one of: ref, title, or titleContains/],
    [{ type: 'ui_menu', params: { app: 'Finder' } }, /non-empty path array/],
    [{ type: 'zoom', params: {} }, /requires a region/],
    [{ type: 'type_text', params: {} }, /non-empty text value/],
    [{ type: 'press_keys', params: {} }, /requires a keys value/],
  ]

  for (const [action, pattern] of cases) {
    await assert.rejects(
      () => executeComputerAction(action),
      pattern,
      `${action.type} with ${JSON.stringify(action.params)} should fail closed`,
    )
  }
})

test('the computer-use loop is on by default and off only by explicit 0', async () => {
  /*
   * The default flipped with the env-reduction pass (2026-08-09): the flag
   * sat at =1 in this machine's .env from the day it existed, and the owner
   * deleted every line that only restated a constant. The old opt-in default
   * survives as the '0' kill switch — which is the branch that still needs a
   * guarantee, because a kill switch that silently stopped killing is the
   * worst version of this bug.
   */
  const previous = process.env.PENDANT_COMPUTER_USE_ENABLED
  try {
    process.env.PENDANT_COMPUTER_USE_ENABLED = '0'
    await assert.rejects(
      () => executeComputerAction({ type: 'computer_use_task', params: { goal: 'do a thing' } }),
      /PENDANT_COMPUTER_USE_ENABLED=0/,
    )

    /* Unset = enabled — asserted on the PURE gate, not by calling
     * executeComputerAction: on a machine with a vision model configured that
     * call sails past every gate and starts driving the actual screen, which
     * a unit test must never do (it did, once, for 1.8 seconds). */
    delete process.env.PENDANT_COMPUTER_USE_ENABLED
    const { computerUseEnabled } = await import('./computerUseLoop.js')
    assert.equal(computerUseEnabled(), true)
    process.env.PENDANT_COMPUTER_USE_ENABLED = '0'
    assert.equal(computerUseEnabled(), false)
  } finally {
    if (previous !== undefined) {
      process.env.PENDANT_COMPUTER_USE_ENABLED = previous
    } else {
      delete process.env.PENDANT_COMPUTER_USE_ENABLED
    }
  }
})

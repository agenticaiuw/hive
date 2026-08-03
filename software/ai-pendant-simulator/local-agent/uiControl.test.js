import assert from 'node:assert/strict'
import test from 'node:test'
import {
  runUiHelper,
  validateButton,
  validateClicks,
  validateModifiers,
  validatePoint,
  validateScroll,
  validateSteps,
} from './uiControl.js'

test('a missing coordinate fails closed instead of defaulting to zero', () => {
  assert.throws(() => validatePoint({}, { label: 'mouse_click' }), /requires numeric x and y/)
  assert.throws(() => validatePoint({ x: 10 }, { label: 'mouse_click' }), /requires numeric x and y/)
  assert.throws(() => validatePoint({ x: 10, y: null }), /finite number/)
  assert.throws(() => validatePoint({ x: 'left', y: 10 }), /finite number/)
  assert.throws(() => validatePoint({ x: NaN, y: 10 }), /finite number/)
  assert.throws(() => validatePoint({ x: Infinity, y: 10 }), /finite number/)
})

test('valid coordinates come back as numbers', () => {
  assert.deepEqual(validatePoint({ x: 12, y: 34.5 }), { x: 12, y: 34.5 })
  assert.deepEqual(validatePoint({ x: '12', y: '0' }), { x: 12, y: 0 })
  assert.deepEqual(
    validatePoint({ fromX: 1, fromY: 2 }, { xKey: 'fromX', yKey: 'fromY' }),
    { x: 1, y: 2 },
  )
})

test('only the three real mouse buttons are accepted', () => {
  assert.equal(validateButton(undefined), 'left')
  assert.equal(validateButton('RIGHT'), 'right')
  assert.equal(validateButton('middle'), 'middle')
  assert.throws(() => validateButton('scroll'), /Unsupported mouse button/)
  assert.throws(() => validateButton(2), /Unsupported mouse button/)
})

test('click count is limited to a real 1-3 and rejects fractions', () => {
  assert.equal(validateClicks(undefined), 1)
  assert.equal(validateClicks(2), 2)
  assert.throws(() => validateClicks(0), /integer 1, 2, or 3/)
  assert.throws(() => validateClicks(4), /integer 1, 2, or 3/)
  assert.throws(() => validateClicks(1.5), /integer 1, 2, or 3/)
  assert.throws(() => validateClicks('many'), /finite number/)
})

test('modifiers are validated rather than passed through', () => {
  assert.deepEqual(validateModifiers(undefined), [])
  assert.deepEqual(validateModifiers(['Cmd', 'SHIFT']), ['cmd', 'shift'])
  assert.deepEqual(validateModifiers('cmd+alt'), ['cmd', 'alt'])
  assert.throws(() => validateModifiers(['hyper']), /Unsupported modifier/)
  assert.throws(() => validateModifiers('cmd+super'), /Unsupported modifier/)
})

test('a no-op scroll is rejected and huge deltas are capped', () => {
  assert.deepEqual(validateScroll({ dy: -120 }), { dx: 0, dy: -120 })
  assert.throws(() => validateScroll({}), /non-zero dx or dy/)
  assert.throws(() => validateScroll({ dx: 0, dy: 0 }), /non-zero dx or dy/)
  assert.throws(() => validateScroll({ dy: 99999 }), /limited to/)
  assert.throws(() => validateScroll({ dy: 'down' }), /finite number/)
})

test('drag step counts stay in a range that actually registers', () => {
  assert.equal(validateSteps(undefined), 24)
  assert.equal(validateSteps(50), 50)
  // A single jump from A to B is ignored by most AppKit drag targets.
  assert.throws(() => validateSteps(1), /between 2 and 200/)
  assert.throws(() => validateSteps(500), /between 2 and 200/)
})

test('a refusal from the helper surfaces its code rather than a generic failure', async () => {
  const execFileImpl = async () => {
    const error = new Error('Command failed')
    error.stdout = JSON.stringify({
      ok: false,
      code: 'SECURE_INPUT',
      message: 'Refusing to type text: macOS secure input is active.',
    })
    throw error
  }

  await assert.rejects(
    () =>
      runUiHelper(['type', '--text', 'hunter2'], {
        execFileImpl,
        binaryPath: '/nonexistent/aipendant-uicontrol',
      }),
    (error) => {
      assert.equal(error.code, 'SECURE_INPUT')
      assert.match(error.message, /secure input is active/)
      return true
    },
  )
})

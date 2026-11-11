import assert from 'node:assert/strict'
import test from 'node:test'

import { brightnessLevelFromText } from './llmPlanner.js'

/*
 * sanitizeActions rewrites some shell commands into structured actions. The
 * rewrite is the right idea — a structured set_brightness is better than
 * shelling out — but it ran on two guesses nobody had checked, and both were
 * wrong in the direction that does something the owner did not ask for.
 */

test('the level comes from the command, not from a constant', () => {
  /*
   * It was the literal 0.5. "Set brightness to 100%" dimmed the display to half
   * and reported success — the owner asked for something specific and got a
   * confident answer to a different question.
   */
  assert.equal(brightnessLevelFromText('set brightness to 100%'), 1)
  assert.equal(brightnessLevelFromText('brightness 50%'), 0.5)
  assert.equal(brightnessLevelFromText('brightness 0'), 0)
})

test('a bare integer reads as a percentage and a decimal reads literally', () => {
  /* "brightness 0.3" and "brightness 30%" are the same request, and neither
   * means thirty times full scale. */
  assert.equal(brightnessLevelFromText('set-brightness 70'), 0.7)
  assert.equal(brightnessLevelFromText('brightness set 0.4'), 0.4)
})

test('out-of-range values clamp instead of being passed through', () => {
  assert.equal(brightnessLevelFromText('brightness 250%'), 1)
  assert.equal(brightnessLevelFromText('brightness -20%'), 0.2, 'a lone minus is not a sign here')
})

test('a read is never rewritten into a write', () => {
  /*
   * The guard was /brightness/i against the whole command, so `brightness -l`
   * — a query — became an action that changed the display to 50%.
   */
  for (const command of [
    'brightness -l',
    'brightness --list',
    'get brightness',
    'read brightness',
    'show current brightness',
    'brightness status',
  ]) {
    assert.equal(brightnessLevelFromText(command), null, command)
  }
})

test('commands that merely mention nothing relevant are left alone', () => {
  assert.equal(brightnessLevelFromText('echo hello'), null)
  assert.equal(brightnessLevelFromText('nvram boot-args'), null)
  assert.equal(brightnessLevelFromText(''), null)
  assert.equal(brightnessLevelFromText(null), null)
})

test('a brightness word with no number is not a set', () => {
  /* Nothing to set it to. Rewriting this is how the 0.5 default was reached in
   * the first place. */
  assert.equal(brightnessLevelFromText('brightness'), null)
  assert.equal(brightnessLevelFromText('adjust the brightness please'), null)
})

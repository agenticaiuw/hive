/*
 * Voice input for the command box, tested as the pure module it is.
 *
 * The claims worth pinning: Web Speech is the only backend (the cloud
 * /v1/transcribe pipeline was deleted — browser_node never held the
 * speech:transcribe scope, so it could only ever earn a 403) and a browser
 * without it is told to type; the transcript LANDS IN THE BOX by appending,
 * clipped to the box's own limit; and recognition errors map to owner-
 * actionable words.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  chooseVoiceBackend,
  describeRecognitionError,
  mergeTranscript,
  speechLang,
} from '../src/voice-input.js'
import { MAX_COMMAND_CHARS } from '../src/command-console.js'

/* ------------------------------------------------------------------ *
 * Backend choice: Web Speech or honesty.
 * ------------------------------------------------------------------ */

test('Web Speech wins whenever the browser has it', () => {
  const choice = chooseVoiceBackend({ hasSpeechRecognition: true })
  assert.equal(choice.backend, 'webspeech')
})

test('without Web Speech, the mic says so instead of pretending', () => {
  const choice = chooseVoiceBackend({ hasSpeechRecognition: false })
  assert.equal(choice.backend, 'none')
  assert.match(choice.reason, /type the command instead/i)
  assert.equal(chooseVoiceBackend().backend, 'none')
})

test('the language rule is the simulator\'s: Korean keyboards get Korean STT', () => {
  assert.equal(speechLang('ko-KR'), 'ko-KR')
  assert.equal(speechLang('en-US'), 'en-US')
  assert.equal(speechLang(undefined), 'en-US')
})

/* ------------------------------------------------------------------ *
 * Landing in the box.
 * ------------------------------------------------------------------ */

test('a transcript appends to what was already typed, one space between', () => {
  assert.equal(mergeTranscript('open gmail', 'and archive everything'), 'open gmail and archive everything')
  assert.equal(mergeTranscript('', '  open gmail  '), 'open gmail')
  assert.equal(mergeTranscript('  typed  ', ''), 'typed')
})

test('the merged command respects the box\'s own length limit', () => {
  const merged = mergeTranscript('x'.repeat(MAX_COMMAND_CHARS), 'overflow')
  assert.equal(merged.length, MAX_COMMAND_CHARS)
})

/* ------------------------------------------------------------------ *
 * Web Speech errors → what the popup does about them.
 * ------------------------------------------------------------------ */

test('aborted is the owner\'s own click and says nothing', () => {
  assert.equal(describeRecognitionError('aborted').silent, true)
})

test('a network failure says type instead — there is no cloud to fall back to', () => {
  const outcome = describeRecognitionError('network')
  assert.equal(outcome.silent, false)
  assert.match(outcome.message, /type instead/i)
})

test('a blocked microphone tells the owner where the fix lives', () => {
  const outcome = describeRecognitionError('not-allowed')
  assert.equal(outcome.silent, false)
  assert.match(outcome.message, /mic access/i)
})

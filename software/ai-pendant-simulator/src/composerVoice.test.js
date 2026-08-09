/*
 * The composer mic's pure rules.
 *
 * The claims: a transcript APPENDS to the draft (dictation must never eat
 * typed words); punctuation-only recognition counts as no speech, the same
 * rule the dashboard uses; the button's three faces track the state table;
 * and every failure sentence ends with a way forward, in the app's voice.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import {
  composerMicView,
  describeComposerVoiceFailure,
  mergeTranscriptIntoDraft,
  transcriptHasSpeech,
} from './composerVoice.js'

test('a transcript appends to the draft, one space between, never replacing it', () => {
  assert.equal(
    mergeTranscriptIntoDraft('open gmail', 'and archive the newsletters'),
    'open gmail and archive the newsletters',
  )
  assert.equal(mergeTranscriptIntoDraft('', '  open gmail  '), 'open gmail')
  assert.equal(mergeTranscriptIntoDraft('  typed  ', ''), 'typed')
  assert.equal(mergeTranscriptIntoDraft(undefined, undefined), '')
})

test('punctuation-only recognition is not speech — the dashboard\'s own rule', () => {
  assert.equal(transcriptHasSpeech('. . .'), false)
  assert.equal(transcriptHasSpeech(''), false)
  assert.equal(transcriptHasSpeech('ok'), true)
  assert.equal(transcriptHasSpeech('안녕'), true)
})

test('the mic button\'s three faces follow the state, and only transcribing is busy', () => {
  assert.equal(composerMicView('idle').label, 'Speak')
  assert.equal(composerMicView('idle').busy, false)
  assert.match(composerMicView('listening').label, /Stop/)
  assert.equal(composerMicView('listening').busy, false)
  assert.match(composerMicView('transcribing').label, /Transcribing/)
  assert.equal(composerMicView('transcribing').busy, true)
  /* Unknown states fall back to the idle face rather than a blank button. */
  assert.equal(composerMicView(undefined).label, 'Speak')
})

test('permission failures name the fix; others keep the real message; all offer typing', () => {
  const permission = describeComposerVoiceFailure(new Error('Permission denied by system'))
  assert.match(permission, /allow mic/i)
  assert.match(permission, /Type instead/)

  const empty = describeComposerVoiceFailure(new Error('No audio captured.'))
  assert.match(empty, /Nothing captured/)

  const relay = describeComposerVoiceFailure(new Error('Speech-to-text failed.'))
  assert.match(relay, /Speech-to-text failed\./)
  assert.match(relay, /Type instead/)

  assert.equal(describeComposerVoiceFailure(null), 'Voice failed. Type instead.')
})

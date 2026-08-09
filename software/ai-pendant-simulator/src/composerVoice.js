/*
 * The composer's voice half, pure.
 *
 * The pendant tap already speaks-and-runs: capture, transcribe, execute in
 * one gesture. The COMPOSER mic is deliberately smaller than that — the
 * transcript lands in the draft for the owner to read, edit and Run, so the
 * submit path stays exactly the typed one (handleComposerSubmit →
 * runAgentFromCommand). These are the rules of that landing, kept out of
 * App.jsx the way approvalRequests.js keeps the card rules out: the merge,
 * the "was anything said" test, the button's three faces, and the failure
 * sentences — all assertable without a microphone.
 *
 * Capture and transcription themselves are the app's EXISTING machinery
 * (voiceCapture.startCloudVoiceCapture → cloudClient.transcribeAudio); this
 * module adds no second pipeline.
 */

/** The dashboard's own "was anything actually said" rule. */
export function transcriptHasSpeech(value) {
  return /[\p{L}\p{N}]/u.test(String(value || ''))
}

/**
 * How a transcript lands in the draft: appended to whatever is already
 * typed, one space between, so a spoken half-sentence can finish a typed
 * one — and a transcript never silently replaces words the owner wrote.
 */
export function mergeTranscriptIntoDraft(draft, transcript) {
  return [String(draft ?? '').trim(), String(transcript ?? '').trim()]
    .filter(Boolean)
    .join(' ')
}

/**
 * The mic button's three faces. A table rather than JSX ternaries so the
 * button can never say "Speak" while the recorder is live.
 */
export function composerMicView(state) {
  if (state === 'listening') {
    return {
      label: 'Stop & add to draft',
      aria: 'Stop recording and put the transcript in the draft',
      busy: false,
    }
  }
  if (state === 'transcribing') {
    return {
      label: 'Transcribing…',
      aria: 'Transcribing your recording',
      busy: true,
    }
  }
  return {
    label: 'Speak',
    aria: 'Dictate into the composer',
    busy: false,
  }
}

/**
 * Failure → the sentence shown under the composer, in the app's own voice
 * (every voice failure in App.jsx ends with a way forward, usually "Type
 * instead"). Permission problems name the fix; everything else keeps the
 * real message rather than a generic shrug.
 */
export function describeComposerVoiceFailure(error) {
  const message = String(error?.message ?? '').trim()
  if (/Permission|NotAllowed|denied/i.test(message)) {
    return 'Mic permission blocked. Type instead, or allow mic in browser settings.'
  }
  if (/No audio captured/i.test(message)) {
    return 'Nothing captured. Try again, or type instead.'
  }
  return message ? `Voice failed (${message}). Type instead.` : 'Voice failed. Type instead.'
}

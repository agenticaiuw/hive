/*
 * Voice input for the command box: the Web Speech API, and nothing else.
 *
 * The cloud speech-to-text fallback (MediaRecorder → base64 → the relay's
 * POST /v1/transcribe) was deleted deliberately: the browser_node role does
 * not hold the speech:transcribe scope (cloud-relay/deviceAuth.js), so that
 * whole pipeline could only ever earn a 403. On a browser without Web Speech
 * the mic says so and the owner types — see chooseVoiceBackend.
 *
 * EVERYTHING HERE IS PURE. No fetch, no storage, no DOM — popup.js owns the
 * impure edges (SpeechRecognition itself).
 */
import { MAX_COMMAND_CHARS } from './command-console.js'

/** The simulator's language rule: Korean keyboards get Korean STT. */
export function speechLang(navigatorLanguage) {
  return String(navigatorLanguage || '').toLowerCase().startsWith('ko')
    ? 'ko-KR'
    : 'en-US'
}

/**
 * Which backend this click should use. A table, not a cascade of ifs in a
 * click handler, so the policy is assertable:
 *
 *   Web Speech present -> 'webspeech' (the simulator's desktop default)
 *   otherwise          -> 'none', with the reason spelled out
 */
export function chooseVoiceBackend({ hasSpeechRecognition = false } = {}) {
  if (hasSpeechRecognition) {
    return {
      backend: 'webspeech',
      reason: 'This browser has the Web Speech API; speech stays the browser\'s own.',
    }
  }
  return {
    backend: 'none',
    reason: 'This browser has no Web Speech API — type the command instead.',
  }
}

/**
 * How a transcript lands in the box: appended to whatever is already typed,
 * one space between, clipped to the same limit the input enforces — so a
 * spoken half-sentence can finish a typed one.
 */
export function mergeTranscript(existing, transcript) {
  const merged = [String(existing ?? '').trim(), String(transcript ?? '').trim()]
    .filter(Boolean)
    .join(' ')
  return merged.slice(0, MAX_COMMAND_CHARS)
}

/**
 * Web Speech error → what the popup does about it. 'aborted' is the owner's
 * own click and says nothing.
 */
export function describeRecognitionError(code) {
  switch (String(code || '')) {
    case 'aborted':
      return { silent: true, message: '' }
    case 'no-speech':
      return { silent: false, message: 'No speech detected — try again.' }
    case 'not-allowed':
    case 'service-not-allowed':
      return {
        silent: false,
        message: 'Microphone blocked — allow mic access for this extension, or type instead.',
      }
    case 'audio-capture':
      return {
        silent: false,
        message: 'No microphone was found — plug one in or type instead.',
      }
    case 'network':
      return {
        silent: false,
        message: 'The browser\'s speech service is unreachable on this network — type instead.',
      }
    default:
      return {
        silent: false,
        message: `Voice failed (${code || 'unknown'}) — type instead.`,
      }
  }
}

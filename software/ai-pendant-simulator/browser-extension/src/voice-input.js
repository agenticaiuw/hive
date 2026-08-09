/*
 * Voice input for the command box: the dashboard's browser-speech pipeline,
 * re-homed to an extension page.
 *
 * THE PIPELINE BEING REUSED — dashboard-sveltekit's CommandBox records with
 * MediaRecorder (the same mime-candidate order as src/voiceCapture.js), turns
 * the blob into base64, and posts it to a server route that calls the relay's
 * POST /v1/transcribe (Workers AI Whisper). Capture side, this module is that
 * pipeline verbatim: same candidates, same format naming, same base64 step,
 * so a recording made here is one the relay demonstrably accepts.
 *
 * WHERE THIS SURFACE DIFFERS — the popup has no server of its own, so the
 * cloud leg goes straight at `${relayUrl}/v1/transcribe` with the extension's
 * paired device token (manifest.json already grants the relay origin; the
 * descriptor below is built here and fetched in popup.js, the relay-peer.js
 * split). One honest caveat, verified against cloud-relay/deviceAuth.js and
 * relayScopes.js: /v1/transcribe demands `speech:transcribe`, and the
 * `browser_node` role does NOT hold that scope today. So the DEFAULT backend
 * on this desktop surface is the Web Speech API — the same call the simulator
 * makes on desktops (prefersCloudSpeechToText is false there) — and the cloud
 * pipeline is the fallback for browsers without Web Speech, where a
 * scope-denied answer is reported in owner-actionable words rather than
 * disguised as a network failure.
 *
 * EVERYTHING HERE IS PURE apart from blobToBase64 (which touches only the
 * blob it is given). No fetch, no storage, no DOM — popup.js owns those.
 */
import { MAX_COMMAND_CHARS } from './command-console.js'

/* Same candidate order as the dashboard's pipeline.ts and the simulator's
 * voiceCapture.js: Safari lands on audio/mp4, Chrome/Firefox on webm/opus. */
export const RECORDER_MIME_CANDIDATES = Object.freeze([
  'audio/webm;codecs=opus',
  'audio/webm',
  'audio/mp4',
  'audio/ogg;codecs=opus',
  'audio/ogg',
])

/* The dashboard's /api/command/audio cap. The relay behind it accepts the
 * same; refusing locally spares a doomed multi-megabyte upload. */
export const MAX_AUDIO_BYTES = 8 * 1024 * 1024

export function pickRecorderMimeType(MediaRecorderCtor) {
  if (!MediaRecorderCtor || typeof MediaRecorderCtor.isTypeSupported !== 'function') {
    return ''
  }
  return (
    RECORDER_MIME_CANDIDATES.find((type) => MediaRecorderCtor.isTypeSupported(type)) || ''
  )
}

export function mimeToFormat(mimeType) {
  const value = String(mimeType || '').toLowerCase()
  if (value.includes('mp4') || value.includes('m4a') || value.includes('aac')) {
    return 'm4a'
  }
  if (value.includes('ogg')) return 'ogg'
  if (value.includes('mp3') || value.includes('mpeg')) return 'mp3'
  if (value.includes('wav')) return 'wav'
  return 'webm'
}

export function blobToBase64(blob) {
  /* FileReader in a page, arrayBuffer in tests — same bytes either way. */
  if (typeof FileReader === 'function') {
    return new Promise((resolve, reject) => {
      const reader = new FileReader()
      reader.onerror = () => reject(new Error('Could not read recorded audio.'))
      reader.onloadend = () => {
        const result = String(reader.result || '')
        resolve(result.includes(',') ? result.split(',')[1] : result)
      }
      reader.readAsDataURL(blob)
    })
  }
  return blob.arrayBuffer().then((buffer) => {
    let binary = ''
    const bytes = new Uint8Array(buffer)
    for (let index = 0; index < bytes.length; index += 1) {
      binary += String.fromCharCode(bytes[index])
    }
    return btoa(binary)
  })
}

/** The simulator's language rule: Korean keyboards get Korean STT. */
export function speechLang(navigatorLanguage) {
  return String(navigatorLanguage || '').toLowerCase().startsWith('ko')
    ? 'ko-KR'
    : 'en-US'
}

/** What /v1/transcribe's `language` field wants: a bare two-letter code. */
export function transcribeLanguage(navigatorLanguage) {
  return speechLang(navigatorLanguage).slice(0, 2)
}

/**
 * Which backend this click should use. A table, not a cascade of ifs in a
 * click handler, so the policy is assertable:
 *
 *   Web Speech present            -> 'webspeech' (the simulator's desktop
 *                                    default; costs no scope and no upload)
 *   no Web Speech, relay paired   -> 'cloud' (the dashboard's MediaRecorder →
 *                                    /v1/transcribe pipeline, device token)
 *   neither                       -> 'none', with the reason spelled out
 */
export function chooseVoiceBackend({ hasSpeechRecognition = false, relayReady = false } = {}) {
  if (hasSpeechRecognition) {
    return {
      backend: 'webspeech',
      reason: 'This browser has the Web Speech API; speech stays the browser\'s own.',
    }
  }
  if (relayReady) {
    return {
      backend: 'cloud',
      reason:
        'No Web Speech API here — recording locally and transcribing through the relay\'s speech route.',
    }
  }
  return {
    backend: 'none',
    reason:
      'This browser has no Web Speech API and no paired relay peer to transcribe a recording — type instead.',
  }
}

/**
 * The cloud leg as a request descriptor, the relay-peer.js discipline:
 * `auth: 'device'` means popup.js attaches the token; this module never
 * holds it and never puts it in a URL.
 */
export function transcribeRequest(config, { audioBase64, format, language, durationMs } = {}) {
  if (!config?.ready) {
    throw new Error(
      config?.reason || 'The relay peer is not configured; there is nowhere to transcribe.',
    )
  }
  const audio = String(audioBase64 ?? '').trim()
  if (!audio) {
    throw new Error('No audio captured — try again.')
  }
  if (Math.floor((audio.length * 3) / 4) > MAX_AUDIO_BYTES) {
    throw new Error('Recording is too large (8 MB max) — try a shorter one.')
  }
  return {
    method: 'POST',
    path: '/v1/transcribe',
    auth: 'device',
    body: {
      audioBase64: audio,
      /* mimeToFormat is idempotent over its own outputs, so callers may pass
       * either a mime type or an already-named format. */
      format: mimeToFormat(format),
      ...(language ? { language: String(language).slice(0, 2).toLowerCase() } : {}),
      ...(Number.isFinite(durationMs) && durationMs > 0
        ? { durationMs: Math.round(durationMs) }
        : {}),
      /* The relay refuses a device principal whose body deviceId is not its
       * own (principalOwnsDevice), so this is required, not decoration. */
      deviceId: config.relayDeviceId,
    },
  }
}

/** The dashboard's own "was anything actually said" rule. */
export function transcriptHasSpeech(value) {
  return /[\p{L}\p{N}]/u.test(String(value || ''))
}

/**
 * What one /v1/transcribe answer means for the box. The scope refusal gets
 * its own sentence because it is the one failure the owner can neither retry
 * nor fix in settings: today's browser_node pairing simply does not include
 * cloud speech, and pretending that is a network blip would send them
 * debugging their Wi-Fi.
 */
export function interpretTranscribeResponse({ status, payload }) {
  const body = payload && typeof payload === 'object' ? payload : {}

  if (status === 401) {
    return {
      kind: 'error',
      message:
        'The relay does not accept this browser\'s device token. Pair again in settings, then retry.',
    }
  }
  if (status === 403) {
    return {
      kind: 'error',
      message:
        'This browser\'s relay token is not allowed to use cloud speech-to-text ' +
        '(the browser_node role does not include the speech:transcribe scope). Type the command instead.',
    }
  }
  if (status < 200 || status >= 300) {
    return {
      kind: 'error',
      message: body.error || `The relay answered HTTP ${status}.`,
    }
  }

  const text = String(body.text || '').trim()
  if (!transcriptHasSpeech(text)) {
    return { kind: 'no-speech' }
  }
  return { kind: 'transcript', text }
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
 * Web Speech error → what the popup does about it. `fallbackToCloud` mirrors
 * the simulator's rule: a 'network' failure (carrier networks break Google's
 * STT constantly) retries through the relay pipeline WHEN there is one.
 * 'aborted' is the owner's own click and says nothing.
 */
export function describeRecognitionError(code, { relayReady = false } = {}) {
  switch (String(code || '')) {
    case 'aborted':
      return { silent: true, fallbackToCloud: false, message: '' }
    case 'no-speech':
      return { silent: false, fallbackToCloud: false, message: 'No speech detected — try again.' }
    case 'not-allowed':
    case 'service-not-allowed':
      return {
        silent: false,
        fallbackToCloud: false,
        message: 'Microphone blocked — allow mic access for this extension, or type instead.',
      }
    case 'audio-capture':
      return {
        silent: false,
        fallbackToCloud: false,
        message: 'No microphone was found — plug one in or type instead.',
      }
    case 'network':
      return {
        silent: false,
        fallbackToCloud: relayReady,
        message: relayReady
          ? 'Browser speech is blocked on this network — retrying through the relay…'
          : 'The browser\'s speech service is unreachable on this network — type instead.',
      }
    default:
      return {
        silent: false,
        fallbackToCloud: false,
        message: `Voice failed (${code || 'unknown'}) — type instead.`,
      }
  }
}

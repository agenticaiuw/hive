import '../../load-pendant-env.mjs'

export const PORT = Number(process.env.RELAY_PORT || process.env.PORT || 8787)
export const RELAY_API_KEY = process.env.RELAY_API_KEY || ''
export const PAIRING_CODE = process.env.PAIRING_CODE || ''
export const PENDANT_ACCOUNT_ID =
  process.env.PENDANT_ACCOUNT_ID || 'single-owner'
export const BRIDGE_POLL_TIMEOUT_MS = Number(
  process.env.BRIDGE_POLL_TIMEOUT_MS || 25000,
)
export const BRIDGE_CLAIM_MIN_INTERVAL_MS = Number(
  process.env.BRIDGE_CLAIM_MIN_INTERVAL_MS || 250,
)
export const BRIDGE_CLAIM_MAX_INTERVAL_MS = Number(
  process.env.BRIDGE_CLAIM_MAX_INTERVAL_MS || 1000,
)
export const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 1000 * 60 * 60 * 24)

/*
 * Voice recordings are the owner's private audio, so they outlive the 24h
 * relay job queue and are never touched by pruneExpiredJobs(). This is the one
 * knob that decides how long they stay: 30 days by default. A blank or
 * non-positive value falls back to the default on purpose — an accidental
 * `AUDIO_RETENTION_MAX_AGE_MS=0` must never mean "erase everything".
 */
export const AUDIO_RETENTION_DEFAULT_MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30
export const AUDIO_RETENTION_MAX_AGE_MS =
  Number(process.env.AUDIO_RETENTION_MAX_AGE_MS) > 0
    ? Number(process.env.AUDIO_RETENTION_MAX_AGE_MS)
    : AUDIO_RETENTION_DEFAULT_MAX_AGE_MS
/*
 * Retention sweeps are opt-in. With this unset the sweep endpoint reports what
 * it *would* remove and deletes nothing, so enabling retention is a deliberate
 * two-step act (set the flag, then post dryRun:false).
 */
export const AUDIO_RETENTION_SWEEP_ENABLED =
  String(process.env.AUDIO_RETENTION_SWEEP_ENABLED || '')
    .trim()
    .toLowerCase() === 'true'

// Used for mobile voice on cellular (browser Web Speech often fails off Wi‑Fi).
export const LLM_API_KEY = process.env.LLM_API_KEY || ''
export const LLM_API_BASE_URL =
  process.env.LLM_API_BASE_URL || 'https://openrouter.ai/api/v1'
export const STT_MODEL =
  process.env.STT_MODEL || 'openai/whisper-large-v3'
// Multimodal chat model that accepts input_audio (OpenRouter / OpenAI-compatible).
// Used by the audio-native planner pilot to go audio → transcript+plan in one hop.
export const LLM_AUDIO_MODEL =
  process.env.LLM_AUDIO_MODEL || 'google/gemini-3.6-flash'
// When true (default), /v1/transcribe and /v1/pendant/command try planFromAudio
// first and fall back to Whisper STT on failure. Set to 0 or false to disable.
export const AUDIO_NATIVE_PLANNER =
  process.env.AUDIO_NATIVE_PLANNER !== '0' &&
  process.env.AUDIO_NATIVE_PLANNER !== 'false'
// OpenRouter requires a live speech model slug (generic openai/gpt-4o-mini-tts
// no longer resolves). Prefer Grok voice for Korean + English mp3 replies.
export const TTS_MODEL =
  process.env.TTS_MODEL || 'x-ai/grok-voice-tts-1.0'
export const TTS_VOICE = process.env.TTS_VOICE || 'eve'
export const OPENROUTER_HTTP_REFERER =
  process.env.OPENROUTER_HTTP_REFERER ||
  'https://github.com/geunwoo-dev/ai-pendant-simulator'
export const OPENROUTER_APP_TITLE =
  process.env.OPENROUTER_APP_TITLE || 'AI Pendant Simulator'

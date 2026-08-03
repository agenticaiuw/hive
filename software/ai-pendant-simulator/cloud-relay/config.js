import '../../load-pendant-env.mjs'

export const PORT = Number(process.env.RELAY_PORT || process.env.PORT || 8787)
export const RELAY_API_KEY = process.env.RELAY_API_KEY || ''
export const PAIRING_CODE = process.env.PAIRING_CODE || ''
export const PENDANT_ACCOUNT_ID =
  process.env.PENDANT_ACCOUNT_ID || 'single-owner'
export const BRIDGE_POLL_TIMEOUT_MS = Number(
  process.env.BRIDGE_POLL_TIMEOUT_MS || 25000,
)
// Empty-queue yield only (not task latency). 0 = as fast as D1 allows.
export const BRIDGE_CLAIM_MIN_INTERVAL_MS = Number(
  process.env.BRIDGE_CLAIM_MIN_INTERVAL_MS || 0,
)
export const BRIDGE_CLAIM_MAX_INTERVAL_MS = Number(
  process.env.BRIDGE_CLAIM_MAX_INTERVAL_MS || 25,
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

// OpenAI only (no OpenRouter / multi-provider router).
export const OPENAI_API_KEY = process.env.OPENAI_API_KEY || ''
export const OPENAI_API_BASE_URL =
  process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
// Alias used by legacy relay STT/TTS helpers — same as OpenAI key/base.
export const LLM_API_KEY =
  process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || ''
export const LLM_API_BASE_URL =
  process.env.LLM_API_BASE_URL || OPENAI_API_BASE_URL
// Pendant mid-press voice front door only (not used by Mac agent).
// Realtime is the only voice path — no Whisper / gpt-audio fallbacks.
export const OPENAI_REALTIME_MODEL =
  process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1'
// Mac agent / non-voice text planning default (OpenAI).
export const LLM_MODEL = process.env.LLM_MODEL || 'gpt-5.6-luna'
// Relay TTS fallback (pendant prefers macOS say on the Mac).
export const TTS_MODEL = process.env.TTS_MODEL || 'tts-1'
export const TTS_VOICE = process.env.TTS_VOICE || 'alloy'

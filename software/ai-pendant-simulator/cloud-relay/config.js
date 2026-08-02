import dotenv from 'dotenv'

dotenv.config()

export const PORT = Number(process.env.RELAY_PORT || process.env.PORT || 8787)
export const RELAY_API_KEY = process.env.RELAY_API_KEY || ''
export const PAIRING_CODE = process.env.PAIRING_CODE || ''
export const PENDANT_ACCOUNT_ID =
  process.env.PENDANT_ACCOUNT_ID || 'single-owner'
export const BRIDGE_POLL_TIMEOUT_MS = Number(
  process.env.BRIDGE_POLL_TIMEOUT_MS || 25000,
)
export const JOB_TTL_MS = Number(process.env.JOB_TTL_MS || 1000 * 60 * 60 * 24)

// Used for mobile voice on cellular (browser Web Speech often fails off Wi‑Fi).
export const LLM_API_KEY = process.env.LLM_API_KEY || ''
export const LLM_API_BASE_URL =
  process.env.LLM_API_BASE_URL || 'https://openrouter.ai/api/v1'
export const STT_MODEL =
  process.env.STT_MODEL || 'openai/whisper-large-v3'
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

const OPENAI_BASE_URL = 'https://api.openai.com/v1'
const OPENROUTER_BASE_URL = 'https://openrouter.ai/api/v1'
// Gemini's OpenAI-compatible surface for text planning on the Mac agent.
// https://ai.google.dev/gemini-api/docs/openai
const GEMINI_OPENAI_BASE_URL =
  'https://generativelanguage.googleapis.com/v1beta/openai'

export function resolveLlmApiKey(env = process.env) {
  return String(
    env.LLM_API_KEY || env.GEMINI_API_KEY || env.OPENROUTER_API_KEY || '',
  ).trim()
}

export function resolveLlmApiBaseUrl(env = process.env) {
  const explicit = String(env.LLM_API_BASE_URL || '').trim()
  if (explicit) return explicit.replace(/\/$/, '')

  const selectedKey = resolveLlmApiKey(env)
  const geminiKey = String(env.GEMINI_API_KEY || '').trim()
  if (geminiKey && selectedKey === geminiKey) {
    return GEMINI_OPENAI_BASE_URL
  }

  const openRouterKey = String(env.OPENROUTER_API_KEY || '').trim()
  if (openRouterKey && selectedKey === openRouterKey) {
    return OPENROUTER_BASE_URL
  }

  return OPENAI_BASE_URL
}

export function resolveDefaultTextModel(env = process.env) {
  const explicit = String(env.LLM_MODEL || '').trim()
  if (explicit) return explicit
  const geminiKey = String(env.GEMINI_API_KEY || '').trim()
  if (geminiKey) {
    return String(env.GEMINI_TEXT_MODEL || 'gemini-3.6-flash').trim()
  }
  return 'deepseek/deepseek-v4-flash-0731'
}

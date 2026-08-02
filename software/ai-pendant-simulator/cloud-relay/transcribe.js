import {
  LLM_API_BASE_URL,
  LLM_API_KEY,
  OPENROUTER_APP_TITLE,
  OPENROUTER_HTTP_REFERER,
  STT_MODEL,
} from './config.js'
import { getCloudflareBindings } from './cloudflareBindings.js'

export async function transcribeAudio({ audioBase64, format, language }) {
  const cleanBase64 = String(audioBase64 || '')
    .replace(/^data:[^;]+;base64,/, '')
    .trim()

  if (!cleanBase64) {
    throw new Error('audioBase64 is required.')
  }

  const audioFormat = normalizeFormat(format)
  const cloudflareBindings = getCloudflareBindings()

  if (cloudflareBindings?.AI) {
    const options = {
      audio: cleanBase64,
      task: 'transcribe',
      language: language || 'en',
      vad_filter: true,
      beam_size: 8,
      condition_on_previous_text: false,
      initial_prompt:
        'A short spoken command for a Mac. Common application names include Outlook, Finder, Safari, Chrome, Mail, Calendar, Notes, Messages, Home, Music, and System Settings.',
    }

    const payload = await cloudflareBindings.AI.run(
      '@cf/openai/whisper-large-v3-turbo',
      options,
    )
    const text = String(payload?.text || '').trim()

    if (!text) {
      throw new Error('Speech-to-text returned empty text.')
    }

    return {
      text,
      model: '@cf/openai/whisper-large-v3-turbo',
      language: payload.language || language || null,
    }
  }

  if (!LLM_API_KEY) {
    throw new Error(
      'Speech-to-text is not configured on the relay (missing Workers AI binding or LLM_API_KEY).',
    )
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LLM_API_KEY}`,
  }

  if (LLM_API_BASE_URL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = OPENROUTER_HTTP_REFERER
    headers['X-Title'] = OPENROUTER_APP_TITLE
  }

  const body = {
    model: STT_MODEL,
    input_audio: {
      data: cleanBase64,
      format: audioFormat,
    },
  }

  if (language) {
    body.language = language
  }

  const response = await fetch(`${LLM_API_BASE_URL}/audio/transcriptions`, {
    method: 'POST',
    headers,
    body: JSON.stringify(body),
  })

  const payload = await response.json().catch(() => ({}))

  if (!response.ok) {
    throw new Error(
      payload.error?.message ||
        payload.error ||
        `Speech-to-text failed (${response.status}).`,
    )
  }

  const text = String(payload.text || '').trim()

  if (!text) {
    throw new Error('Speech-to-text returned empty text.')
  }

  return {
    text,
    model: STT_MODEL,
    language: payload.language || language || null,
  }
}

function normalizeFormat(format) {
  const value = String(format || 'webm').toLowerCase().replace(/^\./, '')

  if (value.includes('webm')) return 'webm'
  if (value.includes('mp4') || value.includes('m4a') || value.includes('aac')) {
    return 'm4a'
  }
  if (value.includes('ogg') || value.includes('opus')) return 'ogg'
  if (value.includes('mp3') || value.includes('mpeg')) return 'mp3'
  if (value.includes('wav')) return 'wav'
  if (value.includes('flac')) return 'flac'

  return value || 'webm'
}

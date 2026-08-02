import {
  LLM_API_BASE_URL,
  LLM_API_KEY,
  OPENROUTER_APP_TITLE,
  OPENROUTER_HTTP_REFERER,
  TTS_MODEL,
  TTS_VOICE,
} from './config.js'

export async function synthesizeSpeech({
  text,
  language,
  format = 'mp3',
  includeBase64 = true,
} = {}) {
  if (!LLM_API_KEY) {
    throw new Error(
      'Text-to-speech is not configured on the relay (missing LLM_API_KEY).',
    )
  }

  const input = String(text || '').replace(/\s+/g, ' ').trim()
  if (!input) {
    throw new Error('text is required.')
  }

  const responseFormat = String(format || 'mp3').trim().toLowerCase()
  if (!['mp3', 'pcm'].includes(responseFormat)) {
    throw new Error('format must be mp3 or pcm.')
  }

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LLM_API_KEY}`,
  }

  if (LLM_API_BASE_URL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = OPENROUTER_HTTP_REFERER
    headers['X-Title'] = OPENROUTER_APP_TITLE
  }

  const response = await fetch(`${LLM_API_BASE_URL}/audio/speech`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: TTS_MODEL,
      input: input.slice(0, 800),
      voice: TTS_VOICE,
      response_format: responseFormat,
    }),
  })

  if (!response.ok) {
    const payload = await response.json().catch(() => ({}))
    throw new Error(
      payload.error?.message ||
        payload.error ||
        `Text-to-speech failed (${response.status}).`,
    )
  }

  const buffer = Buffer.from(await response.arrayBuffer())
  return {
    audio: buffer,
    audioBase64: includeBase64 ? buffer.toString('base64') : undefined,
    audioBytes: buffer.length,
    mimeType:
      response.headers.get('content-type') ||
      (responseFormat === 'pcm' ? 'audio/pcm' : 'audio/mpeg'),
    format: responseFormat,
    model: TTS_MODEL,
    voice: TTS_VOICE,
  }
}

import {
  LLM_API_BASE_URL,
  LLM_API_KEY,
  LLM_AUDIO_MODEL,
  OPENROUTER_APP_TITLE,
  OPENROUTER_HTTP_REFERER,
} from './config.js'

const PLAN_PROMPT = `You are the voice planner for a wearable AI pendant that controls a Mac.
Listen to the short spoken command and respond with ONLY valid JSON (no markdown):
{"text":"transcript of what was said","status":"ready"|"instant"|"unsupported","response":"optional short spoken reply","actions":[{"type":"...","label":"...","params":{}}]}

Rules:
- text is a faithful short transcript of the audio (required).
- status "instant" when you can answer immediately (facts, time, short confirmations) with a spoken response and optional light actions.
- status "ready" when the Mac should run tool actions. Use the action types the Mac agent supports (apps, media, settings, files, UI, etc.) with concrete params.
- status "unsupported" only if the audio is empty/unintelligible or impossible; put a brief reason in response.
- Keep actions short (usually 0-3). Use empty actions [] when only a spoken reply is needed.
- Do not special-case particular apps or phrases; decide from the audio alone.`

/**
 * Normalize container labels from the pendant / browser into formats the
 * OpenAI-compatible input_audio field accepts (ogg-opus → ogg, m4a → wav-ish).
 */
export function normalizeAudioInputFormat(format) {
  const value = String(format || 'wav').toLowerCase().replace(/^\./, '')

  if (value === 'ogg-opus' || value.includes('ogg') || value.includes('opus')) {
    return 'ogg'
  }
  if (value.includes('webm')) return 'webm'
  if (value.includes('mp4') || value.includes('m4a') || value.includes('aac')) {
    return 'wav'
  }
  if (value.includes('mp3') || value.includes('mpeg')) return 'mp3'
  if (value.includes('wav')) return 'wav'
  if (value.includes('flac')) return 'flac'

  return value || 'wav'
}

export function extractJsonObject(text) {
  const trimmed = String(text || '').trim()
  if (!trimmed) {
    throw new Error('Audio planner returned empty content.')
  }

  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    const start = trimmed.indexOf('{')
    const end = trimmed.lastIndexOf('}')
    if (start >= 0 && end > start) {
      return trimmed.slice(start, end + 1)
    }
    throw new Error('Audio planner did not return valid JSON.')
  }
}

function normalizeActions(raw) {
  if (!Array.isArray(raw)) return []

  return raw
    .filter((action) => action && typeof action === 'object')
    .map((action) => ({
      type: String(action.type || '').trim(),
      label: String(action.label || action.type || '').trim() || undefined,
      params:
        action.params && typeof action.params === 'object' ? action.params : {},
    }))
    .filter((action) => action.type)
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'instant' || status === 'unsupported' || status === 'ready') {
    return status
  }
  return 'ready'
}

/**
 * One-shot multimodal plan: audio → transcript + optional actions via chat
 * completions with OpenAI-compatible input_audio parts.
 */
export async function planFromAudio({
  audioBase64,
  format,
  language,
  fetchImpl = fetch,
} = {}) {
  if (!LLM_API_KEY) {
    throw new Error(
      'Audio-native planner is not configured (missing LLM_API_KEY).',
    )
  }

  const cleanBase64 = String(audioBase64 || '')
    .replace(/^data:[^;]+;base64,/, '')
    .trim()

  if (!cleanBase64) {
    throw new Error('audioBase64 is required.')
  }

  const audioFormat = normalizeAudioInputFormat(format)
  const languageHint = language
    ? ` Spoken language hint: ${language}.`
    : ''

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${LLM_API_KEY}`,
  }

  if (LLM_API_BASE_URL.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = OPENROUTER_HTTP_REFERER
    headers['X-Title'] = OPENROUTER_APP_TITLE
  }

  const startedAt = Date.now()
  const response = await fetchImpl(`${LLM_API_BASE_URL}/chat/completions`, {
    method: 'POST',
    headers,
    body: JSON.stringify({
      model: LLM_AUDIO_MODEL,
      temperature: 0.1,
      max_tokens: 512,
      messages: [
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `${PLAN_PROMPT}${languageHint}`,
            },
            {
              type: 'input_audio',
              input_audio: {
                data: cleanBase64,
                format: audioFormat,
              },
            },
          ],
        },
      ],
    }),
  })

  const payload = await response.json().catch(() => ({}))
  const durationMs = Date.now() - startedAt

  if (!response.ok) {
    throw new Error(
      payload.error?.message ||
        payload.error ||
        `Audio-native planner failed (${response.status}).`,
    )
  }

  const content = payload.choices?.[0]?.message?.content
  let parsed
  try {
    parsed = JSON.parse(extractJsonObject(content))
  } catch (error) {
    throw new Error(
      error?.message || 'Audio-native planner returned unparseable JSON.',
    )
  }

  const text = String(parsed.text || parsed.transcript || '').trim()
  if (!text) {
    throw new Error('Audio-native planner returned empty transcript text.')
  }

  const actions = normalizeActions(parsed.actions)
  const status = normalizeStatus(parsed.status)
  const spoken = String(parsed.response || '').trim() || undefined

  return {
    text,
    model: LLM_AUDIO_MODEL,
    language: language || parsed.language || null,
    status,
    response: spoken,
    actions,
    durationMs,
    source: 'audio-native',
  }
}

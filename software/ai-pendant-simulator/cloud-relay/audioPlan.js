import {
  AUDIO_NATIVE_PLANNER_REQUIRES_OPENAI,
  LLM_API_BASE_URL,
  LLM_AUDIO_MODEL,
  OPENAI_API_BASE_URL,
  OPENAI_AUDIO_MODEL,
  OPENROUTER_APP_TITLE,
  OPENROUTER_HTTP_REFERER,
} from './config.js'
import { planUtteranceWithRealtime } from './openaiRealtimeVoice.js'

// Read secrets at call time so Cloudflare Worker bindings win over empty
// module-import captures.
function openaiApiKey() {
  return String(
    process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '',
  ).trim()
}
function llmApiKey() {
  return String(process.env.LLM_API_KEY || process.env.OPENROUTER_API_KEY || '').trim()
}

const PLAN_PROMPT = `You are the voice planner for a wearable AI pendant that controls a Mac.
Listen to the short spoken command and return a JSON object only (no markdown fences, no prose).
Shape:
{"text":"transcript","status":"ready"|"instant"|"unsupported","response":"optional short spoken reply","actions":[{"type":"...","label":"...","params":{}}]}

Rules:
- text is a faithful short transcript of the audio (required). Decide intent only from the audio — the client has no keyword shortcuts.
- status "instant" when you can answer immediately (facts, time, short confirmations) with a spoken response and optional light actions.
- status "ready" when the Mac should run tool actions. For launching apps use type open_app with params.appName set to the exact macOS application name the user said (or the common full app name). Never use params.name.
- status "unsupported" only if the audio is empty/unintelligible or impossible; put a brief reason in response.
- Keep actions short (usually 0-3). Use empty actions [] when only a spoken reply is needed.
- Do not invent apps or tools. Prefer open_app / open_url when clear from speech.`

/**
 * Normalize container labels from the pendant into formats the
 * OpenAI-compatible input_audio field accepts.
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
  if (value.includes('wav') || value === 'pcm' || value === 's16le') return 'wav'
  if (value.includes('flac')) return 'flac'

  return value || 'wav'
}

/** @deprecated Use normalizeAudioInputFormat; kept for older imports/tests. */
export function geminiAudioMimeType(format) {
  const fmt = normalizeAudioInputFormat(format)
  if (fmt === 'mp3') return 'audio/mp3'
  if (fmt === 'ogg') return 'audio/ogg'
  if (fmt === 'flac') return 'audio/flac'
  return 'audio/wav'
}

export function extractJsonObject(text) {
  let trimmed = String(text || '').trim()
  if (!trimmed) {
    throw new Error('Audio planner returned empty content.')
  }

  const fenced = trimmed.match(/^```(?:json)?\s*([\s\S]*?)\s*```$/i)
  if (fenced) {
    trimmed = fenced[1].trim()
  }

  try {
    JSON.parse(trimmed)
    return trimmed
  } catch {
    const start = trimmed.indexOf('{')
    if (start < 0) {
      throw new Error('Audio planner did not return valid JSON.')
    }
    let depth = 0
    let inString = false
    let escape = false
    for (let i = start; i < trimmed.length; i++) {
      const ch = trimmed[i]
      if (inString) {
        if (escape) {
          escape = false
        } else if (ch === '\\') {
          escape = true
        } else if (ch === '"') {
          inString = false
        }
        continue
      }
      if (ch === '"') {
        inString = true
        continue
      }
      if (ch === '{') depth++
      else if (ch === '}') {
        depth--
        if (depth === 0) {
          const candidate = trimmed.slice(start, i + 1)
          try {
            JSON.parse(candidate)
            return candidate
          } catch {
            throw new Error('Audio planner did not return valid JSON.')
          }
        }
      }
    }
    throw new Error('Audio planner did not return valid JSON.')
  }
}

function normalizeActions(raw) {
  if (!Array.isArray(raw)) return []

  return raw
    .filter((action) => action && typeof action === 'object')
    .map((action) => {
      const type = String(action.type || '').trim()
      const params =
        action.params && typeof action.params === 'object'
          ? { ...action.params }
          : {}

      // Schema fix only: model sometimes emits name instead of appName.
      if (type === 'open_app') {
        const appName = String(
          params.appName || params.name || params.app || params.application || '',
        ).trim()
        if (appName) {
          params.appName = appName
        }
        delete params.name
        delete params.app
        delete params.application
      }

      return {
        type,
        label: String(action.label || action.type || '').trim() || undefined,
        params,
      }
    })
    .filter((action) => action.type)
}

function normalizeStatus(value) {
  const status = String(value || '').trim().toLowerCase()
  if (status === 'instant' || status === 'unsupported' || status === 'ready') {
    return status
  }
  return 'ready'
}

function providerErrorMessage(payload, status) {
  return (
    payload?.error?.message ||
    payload?.error ||
    payload?.message ||
    `Audio-native planner failed (${status}).`
  )
}

function finalizePlanResult(
  parsed,
  { model, language, durationMs, source, toolsUsed, requireLocalPlanner },
) {
  const text = String(parsed.text || parsed.transcript || '').trim()
  if (!text) {
    throw new Error('Audio-native planner returned empty transcript text.')
  }

  const actions = normalizeActions(parsed.actions)
  const status = normalizeStatus(parsed.status)
  const spoken = String(parsed.response || '').trim() || undefined

  const result = {
    text,
    model,
    language: language || parsed.language || null,
    status,
    response: spoken,
    actions,
    durationMs,
    source,
    passes: 1,
    planner: 'audio-native',
  }
  if (Array.isArray(toolsUsed) && toolsUsed.length) {
    result.toolsUsed = toolsUsed
  }
  if (requireLocalPlanner) {
    result.requireLocalPlanner = true
  }
  return result
}

/**
 * OpenAI Chat Completions with audio input (request-based, Worker-friendly).
 * Docs: https://developers.openai.com/api/docs/guides/audio
 *
 * Note: True Realtime/Live (WebSocket gpt-realtime / gpt-live-transcribe) is
 * for continuous streaming while the user speaks. This relay receives a
 * completed utterance body over HTTP, so we use the audio chat path: one
 * multimodal request → JSON plan. Same product outcome, fits CF Workers.
 */
async function planFromAudioViaOpenAI({
  audioBase64,
  format,
  language,
  fetchImpl,
}) {
  const apiKey = openaiApiKey()
  if (!apiKey) {
    throw new Error(
      'Audio-native OpenAI planner is not configured (missing OPENAI_API_KEY).',
    )
  }

  const cleanBase64 = String(audioBase64 || '')
    .replace(/^data:[^;]+;base64,/, '')
    .trim()
  if (!cleanBase64) {
    throw new Error('audioBase64 is required.')
  }

  const audioFormat = normalizeAudioInputFormat(format)
  // OpenAI input_audio accepts wav or mp3 primarily.
  const openaiFormat = audioFormat === 'mp3' ? 'mp3' : 'wav'
  const languageHint = language ? ` Spoken language hint: ${language}.` : ''
  const model =
    String(process.env.OPENAI_AUDIO_MODEL || OPENAI_AUDIO_MODEL || '').trim() ||
    'gpt-audio-1.5'
  const base = String(
    process.env.OPENAI_API_BASE_URL || OPENAI_API_BASE_URL || '',
  )
    .replace(/\/$/, '')
    .trim() || 'https://api.openai.com/v1'

  const startedAt = Date.now()
  const response = await fetchImpl(`${base}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${apiKey}`,
    },
    body: JSON.stringify({
      model,
      temperature: 0.1,
      max_tokens: 512,
      // Text-only response; we already have the utterance audio.
      // (json_object response_format is not supported on all audio models.)
      modalities: ['text'],
      messages: [
        {
          role: 'system',
          content: PLAN_PROMPT,
        },
        {
          role: 'user',
          content: [
            {
              type: 'text',
              text: `Plan this spoken pendant command.${languageHint}`,
            },
            {
              type: 'input_audio',
              input_audio: {
                data: cleanBase64,
                format: openaiFormat,
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
    throw new Error(providerErrorMessage(payload, response.status))
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

  return finalizePlanResult(parsed, {
    model,
    language,
    durationMs,
    source: 'audio-native-openai',
  })
}

/**
 * Legacy OpenRouter / OpenAI-compatible path when OPENAI_API_KEY is absent.
 */
async function planFromAudioViaOpenAiCompat({
  audioBase64,
  format,
  language,
  fetchImpl,
}) {
  const apiKey = llmApiKey()
  if (!apiKey) {
    throw new Error(
      'Audio-native planner is not configured (missing OPENAI_API_KEY or LLM_API_KEY).',
    )
  }

  const cleanBase64 = String(audioBase64 || '')
    .replace(/^data:[^;]+;base64,/, '')
    .trim()
  if (!cleanBase64) {
    throw new Error('audioBase64 is required.')
  }

  const audioFormat = normalizeAudioInputFormat(format)
  const languageHint = language ? ` Spoken language hint: ${language}.` : ''
  const baseUrl = String(
    process.env.LLM_API_BASE_URL || LLM_API_BASE_URL || '',
  ).replace(/\/$/, '')

  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${apiKey}`,
  }

  if (baseUrl.includes('openrouter.ai')) {
    headers['HTTP-Referer'] = OPENROUTER_HTTP_REFERER
    headers['X-Title'] = OPENROUTER_APP_TITLE
  }

  const startedAt = Date.now()
  const response = await fetchImpl(`${baseUrl}/chat/completions`, {
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
                format: audioFormat === 'mp3' ? 'mp3' : 'wav',
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
    throw new Error(providerErrorMessage(payload, response.status))
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

  return finalizePlanResult(parsed, {
    model: LLM_AUDIO_MODEL,
    language,
    durationMs,
    source: 'audio-native',
  })
}

/**
 * Multimodal plan: pendant audio → versatile voice agent result.
 *
 * Prefer OpenAI Realtime (gpt-realtime-2.1) with tools (search / Mac / Q&A).
 * Fall back to gpt-audio chat completions, then OpenRouter-compat.
 *
 * @param {object} opts
 * @param {string} [opts.audioBase64]
 * @param {Buffer|Uint8Array} [opts.audioBuffer] - preferred when available
 * @param {string} [opts.format]
 * @param {number} [opts.sampleRate]
 * @param {string} [opts.language]
 */
export async function planFromAudio({
  audioBase64,
  audioBuffer,
  format,
  sampleRate,
  language,
  fetchImpl = fetch,
} = {}) {
  const useRealtime =
    process.env.OPENAI_VOICE_AGENT !== '0' &&
    process.env.OPENAI_VOICE_AGENT !== 'false'

  if (openaiApiKey() && useRealtime) {
    try {
      let buffer = audioBuffer
      if (!buffer && audioBase64) {
        const clean = String(audioBase64)
          .replace(/^data:[^;]+;base64,/, '')
          .trim()
        buffer = Buffer.from(clean, 'base64')
      }
      if (buffer?.length) {
        return await planUtteranceWithRealtime({
          audioBuffer: buffer,
          format,
          sampleRate,
          language,
        })
      }
    } catch (error) {
      console.warn(
        `[audioPlan] Realtime voice agent failed; falling back to audio chat: ${
          error?.message || error
        }`,
      )
    }
  }

  if (openaiApiKey()) {
    return planFromAudioViaOpenAI({
      audioBase64,
      format,
      language,
      fetchImpl,
    })
  }

  if (AUDIO_NATIVE_PLANNER_REQUIRES_OPENAI) {
    throw new Error(
      'Audio-native planner requires OPENAI_API_KEY (set it in the repo-root .env and as a Worker secret).',
    )
  }

  return planFromAudioViaOpenAiCompat({
    audioBase64,
    format,
    language,
    fetchImpl,
  })
}

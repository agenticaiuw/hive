import { planUtteranceWithRealtime } from './openaiRealtimeVoice.js'
import { loadFleetFromStore } from './fleetContext.js'
import { getStore } from './store/index.js'

// Read secrets at call time so Cloudflare Worker bindings win over empty
// module-import captures.
function openaiApiKey() {
  return String(
    process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '',
  ).trim()
}

/**
 * Normalize container labels from the pendant into formats Realtime / PCM
 * helpers accept.
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

/**
 * Voice → plan via OpenAI Realtime only.
 * No Whisper STT. No gpt-audio chat completions.
 */
export async function planFromAudio({
  audioBase64,
  audioBuffer,
  format,
  sampleRate,
  language,
  fleet = null,
} = {}) {
  if (!openaiApiKey()) {
    throw new Error(
      'Voice agent requires OPENAI_API_KEY (repo-root .env + Worker secret).',
    )
  }

  let buffer = audioBuffer
  if (!buffer && audioBase64) {
    const clean = String(audioBase64)
      .replace(/^data:[^;]+;base64,/, '')
      .trim()
    buffer = Buffer.from(clean, 'base64')
  }
  if (!buffer?.length) {
    throw new Error('audioBuffer or audioBase64 is required.')
  }

  let liveFleet = fleet
  if (!liveFleet) {
    try {
      const store = await getStore()
      liveFleet = await loadFleetFromStore(store)
    } catch {
      liveFleet = null
    }
  }

  return planUtteranceWithRealtime({
    audioBuffer: buffer,
    format,
    sampleRate,
    language,
    fleet: liveFleet,
  })
}

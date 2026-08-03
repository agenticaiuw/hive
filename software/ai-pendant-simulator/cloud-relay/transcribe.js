/**
 * Legacy module name kept for imports.
 * Voice transcription + planning is Realtime-only (see audioPlan.js).
 * Whisper / gpt-audio are not used.
 */
import { planFromAudio } from './audioPlan.js'

/**
 * @deprecated Prefer planFromAudio. Kept so /v1/transcribe and older callers
 * still resolve through Realtime.
 */
export async function transcribeAudio({
  audioBase64,
  audioBuffer,
  format,
  sampleRate,
  language,
}) {
  const plan = await planFromAudio({
    audioBase64,
    audioBuffer,
    format,
    sampleRate,
    language,
  })
  return {
    text: plan.text,
    model: plan.model,
    language: plan.language,
    durationMs: plan.durationMs,
    source: plan.source,
    plan,
  }
}

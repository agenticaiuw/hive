import assert from 'node:assert/strict'
import test from 'node:test'

process.env.OPENAI_API_KEY = 'test-openai-key'

const {
  extractJsonObject,
  normalizeAudioInputFormat,
  planFromAudio,
} = await import('./audioPlan.js')

test('normalizeAudioInputFormat maps common container labels', () => {
  assert.equal(normalizeAudioInputFormat('ogg-opus'), 'ogg')
  assert.equal(normalizeAudioInputFormat('wav'), 'wav')
  assert.equal(normalizeAudioInputFormat('pcm'), 'wav')
})

test('extractJsonObject pulls the first JSON object from mixed content', () => {
  const plan = '{"text":"add a reminder","status":"ready","actions":[]}'
  assert.equal(extractJsonObject(`\`\`\`json\n${plan}\n\`\`\``), plan)
  assert.throws(() => extractJsonObject('no json here'), /valid JSON/)
})

test('planFromAudio requires audio payload', async () => {
  await assert.rejects(
    () => planFromAudio({ audioBase64: '', format: 'wav' }),
    /audioBuffer or audioBase64/,
  )
})

test('planFromAudio requires OPENAI_API_KEY', async () => {
  const prev = process.env.OPENAI_API_KEY
  process.env.OPENAI_API_KEY = ''
  try {
    // Re-import would cache module — call with empty key via env at runtime:
    // openaiApiKey reads process.env each call, so this works without reimport.
    await assert.rejects(
      () =>
        planFromAudio({
          audioBase64: 'YWJj',
          format: 'wav',
        }),
      /OPENAI_API_KEY/,
    )
  } finally {
    process.env.OPENAI_API_KEY = prev
  }
})

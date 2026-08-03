import assert from 'node:assert/strict'
import test from 'node:test'

// Config is loaded at import time from process.env; pin values before import.
process.env.OPENAI_API_KEY = 'test-openai-key'
process.env.OPENAI_AUDIO_MODEL = 'gpt-audio-1.5'
process.env.OPENAI_API_BASE_URL = 'https://api.openai.com/v1'
// Unit tests exercise chat-audio fallback; Realtime is covered separately.
process.env.OPENAI_VOICE_AGENT = '0'
process.env.GEMINI_API_KEY = ''
process.env.LLM_API_KEY = ''
process.env.OPENROUTER_API_KEY = ''

const {
  extractJsonObject,
  geminiAudioMimeType,
  normalizeAudioInputFormat,
  planFromAudio,
} = await import('./audioPlan.js')

function mockFetch(handler) {
  return async (url, init) => handler(url, init)
}

function okOpenAiChat(content) {
  return {
    ok: true,
    status: 200,
    async json() {
      return {
        choices: [{ message: { content } }],
      }
    },
  }
}

test('normalizeAudioInputFormat maps ogg-opus to ogg', () => {
  assert.equal(normalizeAudioInputFormat('ogg-opus'), 'ogg')
  assert.equal(normalizeAudioInputFormat('wav'), 'wav')
  assert.equal(normalizeAudioInputFormat('pcm'), 'wav')
})

test('geminiAudioMimeType maps pendant formats (compat export)', () => {
  assert.equal(geminiAudioMimeType('wav'), 'audio/wav')
  assert.equal(geminiAudioMimeType('pcm'), 'audio/wav')
})

test('extractJsonObject pulls the first JSON object from mixed content', () => {
  const plan = '{"text":"open outlook","status":"ready","actions":[]}'
  assert.equal(
    extractJsonObject(`\`\`\`json\n${plan}\n\`\`\``),
    plan,
  )
  assert.throws(() => extractJsonObject('no json here'), /valid JSON/)
})

test('planFromAudio posts input_audio to OpenAI chat completions', async () => {
  let captured
  const result = await planFromAudio({
    audioBase64: 'YWJjZA==',
    format: 'wav',
    language: 'en',
    fetchImpl: mockFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body), headers: init.headers }
      return okOpenAiChat(
        JSON.stringify({
          text: 'open Outlook',
          status: 'ready',
          response: 'Opening Outlook.',
          actions: [
            {
              type: 'open_app',
              label: 'Open Outlook',
              params: { name: 'Outlook' },
            },
          ],
        }),
      )
    }),
  })

  assert.equal(captured.url, 'https://api.openai.com/v1/chat/completions')
  assert.equal(captured.headers.Authorization, 'Bearer test-openai-key')
  assert.equal(captured.body.model, 'gpt-audio-1.5')
  assert.deepEqual(captured.body.modalities, ['text'])
  const userContent = captured.body.messages[1].content
  assert.equal(userContent[1].type, 'input_audio')
  assert.equal(userContent[1].input_audio.data, 'YWJjZA==')
  assert.equal(userContent[1].input_audio.format, 'wav')

  assert.equal(result.text, 'open Outlook')
  assert.equal(result.source, 'audio-native-openai')
  assert.equal(result.actions[0]?.params?.appName, 'Outlook')
  assert.equal(result.actions[0]?.params?.name, undefined)
})

test('planFromAudio strips data-URL prefixes from base64', async () => {
  let captured
  await planFromAudio({
    audioBase64: 'data:audio/wav;base64,cXdlcg==',
    format: 'wav',
    fetchImpl: mockFetch(async (url, init) => {
      captured = JSON.parse(init.body)
      return okOpenAiChat(
        '{"text":"hi","status":"instant","response":"Hi","actions":[]}',
      )
    }),
  })
  assert.equal(captured.messages[1].content[1].input_audio.data, 'cXdlcg==')
})

test('planFromAudio throws when audio is missing', async () => {
  await assert.rejects(
    () =>
      planFromAudio({
        audioBase64: '',
        format: 'wav',
        fetchImpl: mockFetch(async () => okOpenAiChat('{}')),
      }),
    /audioBase64/,
  )
})

test('planFromAudio throws on HTTP failure with provider message', async () => {
  await assert.rejects(
    () =>
      planFromAudio({
        audioBase64: 'YWJj',
        format: 'wav',
        fetchImpl: mockFetch(async () => ({
          ok: false,
          status: 401,
          async json() {
            return { error: { message: 'Incorrect API key' } }
          },
        })),
      }),
    /Incorrect API key/,
  )
})

test('planFromAudio throws when transcript text is empty', async () => {
  await assert.rejects(
    () =>
      planFromAudio({
        audioBase64: 'YWJj',
        format: 'wav',
        fetchImpl: mockFetch(async () =>
          okOpenAiChat('{"text":"","status":"ready","actions":[]}'),
        ),
      }),
    /empty transcript/,
  )
})

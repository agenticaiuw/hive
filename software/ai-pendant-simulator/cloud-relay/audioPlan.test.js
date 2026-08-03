import assert from 'node:assert/strict'
import test from 'node:test'

// Config is loaded at import time from process.env; pin values before import.
process.env.LLM_API_KEY = 'test-key'
process.env.LLM_API_BASE_URL = 'https://openrouter.ai/api/v1'
process.env.LLM_AUDIO_MODEL = 'google/gemini-3.6-flash'

const {
  extractJsonObject,
  normalizeAudioInputFormat,
  planFromAudio,
} = await import('./audioPlan.js')

function mockFetch(handler) {
  return async (url, init) => handler(url, init)
}

function okChatResponse(content) {
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
  assert.equal(normalizeAudioInputFormat('audio/ogg; codecs=opus'), 'ogg')
  assert.equal(normalizeAudioInputFormat('wav'), 'wav')
  assert.equal(normalizeAudioInputFormat('webm'), 'webm')
  assert.equal(normalizeAudioInputFormat('m4a'), 'wav')
  assert.equal(normalizeAudioInputFormat('.MP3'), 'mp3')
})

test('extractJsonObject pulls the first JSON object from mixed content', () => {
  const raw = 'Sure.\n{"text":"open Outlook","status":"ready","actions":[]}\n'
  assert.equal(
    extractJsonObject(raw),
    '{"text":"open Outlook","status":"ready","actions":[]}',
  )
  assert.equal(
    extractJsonObject('{"text":"mute","status":"instant","actions":[]}'),
    '{"text":"mute","status":"instant","actions":[]}',
  )
  assert.throws(() => extractJsonObject('no json here'), /valid JSON/)
  assert.throws(() => extractJsonObject(''), /empty/)
})

test('planFromAudio posts input_audio with normalized format and parses JSON', async () => {
  let captured
  const result = await planFromAudio({
    audioBase64: 'YWJjZA==',
    format: 'ogg-opus',
    language: 'en',
    fetchImpl: mockFetch(async (url, init) => {
      captured = { url, body: JSON.parse(init.body), headers: init.headers }
      return okChatResponse(
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

  assert.equal(captured.url, 'https://openrouter.ai/api/v1/chat/completions')
  assert.equal(captured.headers.Authorization, 'Bearer test-key')
  assert.equal(captured.body.model, 'google/gemini-3.6-flash')
  const parts = captured.body.messages[0].content
  assert.equal(parts[0].type, 'text')
  assert.equal(parts[1].type, 'input_audio')
  assert.equal(parts[1].input_audio.format, 'ogg')
  assert.equal(parts[1].input_audio.data, 'YWJjZA==')

  assert.equal(result.text, 'open Outlook')
  assert.equal(result.status, 'ready')
  assert.equal(result.response, 'Opening Outlook.')
  assert.equal(result.model, 'google/gemini-3.6-flash')
  assert.equal(result.source, 'audio-native')
  assert.equal(result.language, 'en')
  assert.ok(Number.isFinite(result.durationMs))
  assert.deepEqual(result.actions, [
    {
      type: 'open_app',
      label: 'Open Outlook',
      params: { name: 'Outlook' },
    },
  ])
})

test('planFromAudio strips data-URL prefixes from base64', async () => {
  let data
  await planFromAudio({
    audioBase64: 'data:audio/wav;base64,cXdlcg==',
    format: 'wav',
    fetchImpl: mockFetch(async (_url, init) => {
      data = JSON.parse(init.body).messages[0].content[1].input_audio.data
      return okChatResponse('{"text":"hi","status":"instant","actions":[]}')
    }),
  })
  assert.equal(data, 'cXdlcg==')
})

test('planFromAudio accepts fenced or noisy model content', async () => {
  const result = await planFromAudio({
    audioBase64: 'YWJj',
    format: 'wav',
    fetchImpl: mockFetch(async () =>
      okChatResponse(
        '```json\n{"text":"mute the Mac","status":"instant","response":"Muted.","actions":[{"type":"set_mute","params":{"muted":true}}]}\n```',
      ),
    ),
  })
  assert.equal(result.text, 'mute the Mac')
  assert.equal(result.status, 'instant')
  assert.equal(result.actions[0].type, 'set_mute')
})

test('planFromAudio throws when audio is missing', async () => {
  await assert.rejects(
    () =>
      planFromAudio({
        audioBase64: '',
        format: 'wav',
        fetchImpl: mockFetch(async () => {
          throw new Error('fetch should not be called')
        }),
      }),
    /audioBase64 is required/,
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
          status: 400,
          async json() {
            return { error: { message: 'model does not support audio' } }
          },
        })),
      }),
    /model does not support audio/,
  )
})

test('planFromAudio throws when transcript text is empty', async () => {
  await assert.rejects(
    () =>
      planFromAudio({
        audioBase64: 'YWJj',
        format: 'wav',
        fetchImpl: mockFetch(async () =>
          okChatResponse('{"text":"","status":"ready","actions":[]}'),
        ),
      }),
    /empty transcript/,
  )
})

test('planFromAudio throws when response is not JSON', async () => {
  await assert.rejects(
    () =>
      planFromAudio({
        audioBase64: 'YWJj',
        format: 'wav',
        fetchImpl: mockFetch(async () => okChatResponse('I heard open mail')),
      }),
    /valid JSON|unparseable/,
  )
})

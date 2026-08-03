import assert from 'node:assert/strict'
import test from 'node:test'

import {
  resolveDefaultTextModel,
  resolveLlmApiBaseUrl,
  resolveLlmApiKey,
} from './llmProvider.js'

test('Gemini API key is preferred for key + OpenAI-compatible base URL', () => {
  const env = {
    GEMINI_API_KEY: 'gemini-key',
    OPENROUTER_API_KEY: 'router-key',
  }
  assert.equal(resolveLlmApiKey(env), 'gemini-key')
  assert.equal(
    resolveLlmApiBaseUrl(env),
    'https://generativelanguage.googleapis.com/v1beta/openai',
  )
  assert.equal(resolveDefaultTextModel(env), 'gemini-3.6-flash')
})

test('an OpenRouter credential selects the matching provider by default', () => {
  const env = { OPENROUTER_API_KEY: 'router-key' }
  assert.equal(resolveLlmApiKey(env), 'router-key')
  assert.equal(resolveLlmApiBaseUrl(env), 'https://openrouter.ai/api/v1')
})

test('the root-loader alias still selects OpenRouter', () => {
  const env = {
    LLM_API_KEY: 'same-key',
    OPENROUTER_API_KEY: 'same-key',
  }
  assert.equal(resolveLlmApiBaseUrl(env), 'https://openrouter.ai/api/v1')
})

test('an explicit base URL wins and is normalized', () => {
  const env = {
    LLM_API_KEY: 'custom-key',
    OPENROUTER_API_KEY: 'router-key',
    LLM_API_BASE_URL: 'https://inference.example.test/v1/',
  }
  assert.equal(
    resolveLlmApiBaseUrl(env),
    'https://inference.example.test/v1',
  )
})

test('a generic LLM credential retains the OpenAI-compatible default', () => {
  assert.equal(
    resolveLlmApiBaseUrl({ LLM_API_KEY: 'generic-key' }),
    'https://api.openai.com/v1',
  )
})

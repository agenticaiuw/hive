import assert from 'node:assert/strict'
import test from 'node:test'

/*
 * The owner (2026-11-18): "why am i not able to mute the mic on the browser popup". In Safari a tap
 * on the mic while it listened told Hive "done talking" and sent what it had heard, so there was no
 * way to make it stop hearing you. Now a tap while it listens mutes it (ask-hive.js tapMic): it
 * stops at once, sends nothing, keeps what's in the box, and stays muted, even in the next popup,
 * until the mic is tapped again. The same in Chrome, where the popup listens by itself.
 */

class Element {
  constructor(id) {
    this.id = id
    this.value = ''
    this.textContent = ''
    this.title = ''
    this.hidden = id === 'ask-note' || id === 'ask-said'
    this.disabled = false
    this.listeners = {}
    this.attributes = {}
    const classes = new Set()
    this.classList = {
      add: (c) => classes.add(c),
      remove: (c) => classes.delete(c),
      toggle: (c, on) => (on ? classes.add(c) : classes.delete(c)),
      contains: (c) => classes.has(c),
    }
  }
  addEventListener(kind, fn) {
    this.listeners[kind] = fn
  }
  setAttribute(name, value) {
    this.attributes[name] = value
  }
  replaceChildren() {}
  append() {}
}

let elements = {}
function openPopup() {
  elements = {}
  for (const id of ['ask-form', 'ask-text', 'ask-mic', 'ask-send', 'ask-note', 'ask-said', 'ask-rules']) {
    elements[id] = new Element(id)
  }
}
globalThis.document = { getElementById: (id) => elements[id] ?? null, createElement: (tag) => new Element(tag) }
globalThis.addEventListener = () => {}

let userAgent = 'Safari'
Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  get: () => ({ userAgent, language: 'en-US' }),
})

const storage = {}
const told = [] // what the popup asked Hive on this Mac (Safari)
let listening = null
let hearing = { state: 'listening' }
const sent = []
globalThis.browser = {
  storage: {
    local: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (values) => Object.assign(storage, values),
    },
  },
  tabs: { query: async () => [{ id: 1, url: 'https://www.youtube.com/', title: 'YouTube' }] },
  scripting: { executeScript: async () => [{ result: 'outline' }] },
  runtime: {
    sendNativeMessage: async (_host, message) => {
      if (message.type === 'hive:key') return { ok: true, key: 'k', url: 'https://board.example' }
      if (message.type === 'hive:listen') {
        told.push(message.action)
        if (message.action === 'start') listening = { id: message.id }
        return { ok: true }
      }
      if (message.type === 'hive:heard') return listening ? { ok: true, heard: { id: listening.id, ...hearing } } : { ok: false }
      return { ok: true }
    },
  },
}
globalThis.fetch = async (url, init) => {
  if (init?.method === 'POST' && String(url).endsWith('/v1/requests')) {
    sent.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ id: 30 }) }
  }
  return { ok: true, json: async () => ({ rules: [], request: { id: 30, status: 'done', outcome: 'Done.' } }) }
}

// Chrome's own speech recognition, as the popup uses it there.
const recognitions = []
globalThis.webkitSpeechRecognition = class {
  constructor() {
    this.started = false
    this.aborted = false
    this.stopped = false
    recognitions.push(this)
  }
  start() {
    this.started = true
  }
  stop() {
    this.stopped = true
    setTimeout(() => this.onend?.(), 0)
  }
  abort() {
    this.aborted = true
    setTimeout(() => {
      this.onerror?.({ error: 'aborted' })
      this.onend?.()
    }, 0)
  }
}

const until = async (check) => {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(check(), 'timed out')
}
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const mic = () => elements['ask-mic']

test('Safari: a tap mutes it, sends nothing, and the next popup stays muted until a tap', async () => {
  const { initAskHive, MUTED_KEY } = await import('../src/ask-hive.js')
  userAgent = 'Safari'

  openPopup()
  initAskHive()
  await until(() => listening)
  assert.ok(mic().classList.contains('on'))
  hearing = { state: 'listening', text: 'turn off the' }
  await until(() => elements['ask-text'].value === 'turn off the')

  mic().listeners.click()
  await until(() => told.includes('cancel'))
  assert.equal(told.includes('stop'), false, 'a mute must not tell Hive "done talking"')
  assert.equal(storage[MUTED_KEY], true)
  assert.ok(mic().classList.contains('muted'))
  assert.equal(mic().classList.contains('on'), false)
  assert.equal(mic().attributes['aria-pressed'], 'false')
  assert.match(elements['ask-note'].textContent, /^Muted/)
  await pause(400)
  assert.equal(sent.length, 0, 'nothing heard is sent')
  assert.equal(elements['ask-text'].value, 'turn off the', 'what was in the box stays')

  // Opened again: muted, so it doesn't listen; what was in the box is back.
  listening = null
  told.length = 0
  openPopup()
  initAskHive()
  await pause(400)
  assert.deepEqual(told, [])
  assert.ok(mic().classList.contains('muted'))
  assert.equal(mic().title, 'Muted: tap to listen')
  assert.equal(elements['ask-text'].value, 'turn off the')

  // A tap listens again and unmutes.
  hearing = { state: 'listening' }
  mic().listeners.click()
  await until(() => listening)
  assert.equal(storage[MUTED_KEY], false)
  assert.ok(mic().classList.contains('on'))
  assert.equal(mic().classList.contains('muted'), false)
  assert.equal(mic().title, 'Mute')

  // Send still sends what's in the box while it listens.
  hearing = { state: 'listening', text: 'lights' }
  await until(() => elements['ask-text'].value === 'turn off the lights')
  elements['ask-form'].listeners.submit({ preventDefault() {} })
  await until(() => sent.length === 1)
  assert.equal(sent[0].text, 'turn off the lights')
  listening = null
})

test('Chrome: a tap aborts its own listening, sends nothing, and stays muted', async () => {
  const { initAskHive, MUTED_KEY } = await import('../src/ask-hive.js')
  userAgent = 'Mozilla/5.0 Chrome/142.0'
  storage[MUTED_KEY] = false
  sent.length = 0

  openPopup()
  initAskHive()
  await until(() => recognitions.length === 1 && recognitions[0].started)
  const r = recognitions[0]
  r.onresult({ results: [[{ transcript: 'open my' }]] })
  assert.equal(elements['ask-text'].value, 'open my')

  mic().listeners.click()
  assert.ok(r.aborted, 'muting drops what the browser had not handed over')
  assert.equal(storage[MUTED_KEY], true)
  assert.ok(mic().classList.contains('muted'))
  await pause(200)
  assert.equal(sent.length, 0)
  assert.equal(elements['ask-text'].value, 'open my')

  openPopup()
  initAskHive()
  await pause(300)
  assert.equal(recognitions.length, 1, 'a muted popup does not listen')

  mic().listeners.click()
  await until(() => recognitions.length === 2 && recognitions[1].started)
  assert.equal(storage[MUTED_KEY], false)
})

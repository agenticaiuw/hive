import assert from 'node:assert/strict'
import test from 'node:test'

/*
 * The owner (2026-11-17): "when i typed smth and i hide the popup and reopen what i typed was gone".
 * The popup is a page that's thrown away each time it closes, so the box is kept in
 * storage.local as it changes (ask-hive.js DRAFT_KEY) and put back when the popup opens again,
 * before it starts listening, so what's said next is added to it. Once it's sent the kept copy goes.
 */

class Element {
  constructor(id) {
    this.id = id
    this.value = ''
    this.textContent = ''
    this.hidden = id === 'ask-note' || id === 'ask-said'
    this.disabled = false
    this.listeners = {}
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
  setAttribute() {}
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

const storage = {}
let listening = null // { id, typedAtStart }
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
      if (message.type === 'hive:listen' && message.action === 'start') {
        listening = { id: message.id, typedAtStart: elements['ask-text'].value }
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

const until = async (check) => {
  const deadline = Date.now() + 5000
  while (!check() && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 20))
  assert.ok(check(), 'timed out')
}

test('what was typed comes back when the popup opens again, and goes once sent', async () => {
  const { initAskHive, DRAFT_KEY } = await import('../src/ask-hive.js')

  // First open: it listens; the owner types instead, then closes the popup.
  openPopup()
  initAskHive()
  await until(() => listening)
  elements['ask-text'].value = 'find the cheapest'
  elements['ask-text'].listeners.input()
  await until(() => storage[DRAFT_KEY] === 'find the cheapest')

  // Opened again: the words are back before it listens, and what's said is added to them.
  listening = null
  openPopup()
  initAskHive()
  await until(() => listening)
  assert.equal(listening.typedAtStart, 'find the cheapest')
  hearing = { state: 'done', text: 'flight to Taipei.' }
  await until(() => sent.length)
  assert.equal(sent[0].text, 'find the cheapest flight to Taipei.')
  await until(() => storage[DRAFT_KEY] === '')
  assert.equal(elements['ask-text'].value, '')
})

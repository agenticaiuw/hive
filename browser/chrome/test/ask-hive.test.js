import assert from 'node:assert/strict'
import test from 'node:test'

/*
 * Safari's popup listens through Hive on this Mac (ask-hive.js listenThroughHive). The owner
 * (2026-11-17): the popup should feel like the floating window, which shows the words as you say
 * them; it used to show nothing until Hive had read the whole recording, then sent it and cleared
 * the box, so what was heard never showed at all. Here a stand-in for Hive's native handler hears
 * "make sure", then "make sure it works", then the final, and the popup has to show each as it
 * comes and keep the words on screen once they're sent.
 */

class Element {
  constructor(id) {
    this.id = id
    this.value = ''
    this.textContent = ''
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

const elements = {}
for (const id of ['ask-form', 'ask-text', 'ask-mic', 'ask-send', 'ask-note', 'ask-said', 'ask-rules']) {
  elements[id] = new Element(id)
}
globalThis.document = { getElementById: (id) => elements[id] ?? null, createElement: (tag) => new Element(tag) }
globalThis.addEventListener = () => {}

// What Hive hears, one answer per hive:heard after it was asked to start.
const hearing = [
  { state: 'listening' },
  { state: 'listening', text: 'make sure' },
  { state: 'listening', text: 'make sure it works' },
  { state: 'done', text: 'Make sure it works in full screen.' },
]
let listenId = null
const seenInBox = []
const sent = []
const storage = {}
globalThis.browser = {
  storage: {
    local: {
      get: async (key) => ({ [key]: storage[key] }),
      set: async (values) => Object.assign(storage, values),
    },
  },
  tabs: { query: async () => [{ id: 1, url: 'https://canvas.wisc.edu/courses/1', title: 'Canvas' }] },
  scripting: { executeScript: async () => [{ result: 'outline' }] },
  runtime: {
    sendNativeMessage: async (_host, message) => {
      if (message.type === 'hive:key') return { ok: true, key: 'k', url: 'https://board.example' }
      if (message.type === 'hive:listen' && message.action === 'start') {
        listenId = message.id
        return { ok: true }
      }
      if (message.type === 'hive:heard') {
        seenInBox.push(elements['ask-text'].value)
        if (!listenId) return { ok: false }
        const next = hearing.length > 1 ? hearing.shift() : hearing[0]
        return { ok: true, heard: { id: listenId, ...next } }
      }
      return { ok: true }
    },
  },
}
globalThis.fetch = async (url, init) => {
  if (init?.method === 'POST' && String(url).endsWith('/v1/requests')) {
    sent.push(JSON.parse(init.body))
    return { ok: true, json: async () => ({ id: 21 }) }
  }
  // Hive finished it, so the popup stops following it (and the test doesn't wait on it).
  return { ok: true, json: async () => ({ rules: [], request: { id: 21, status: 'done', outcome: 'Done.' } }) }
}

test('Safari: the words show as Hive hears them, go once you stop, and stay on screen', async () => {
  const { initAskHive } = await import('../src/ask-hive.js')
  initAskHive()
  const deadline = Date.now() + 5000
  while (!sent.length && Date.now() < deadline) await new Promise((resolve) => setTimeout(resolve, 50))

  assert.equal(sent.length, 1, 'what was heard went to Hive')
  assert.equal(sent[0].text, 'Make sure it works in full screen.')
  assert.equal(sent[0].from, 'safari')
  // Live: each draft was in the box before the next answer came.
  assert.ok(seenInBox.includes('make sure'), `drafts seen: ${JSON.stringify(seenInBox)}`)
  assert.ok(seenInBox.includes('make sure it works'))
  // Sent: the box is ready for the next thing, and what was asked stays in view.
  assert.equal(elements['ask-text'].value, '')
  assert.equal(elements['ask-said'].hidden, false)
  assert.equal(elements['ask-said'].textContent, 'Make sure it works in full screen.')
  assert.equal(elements['ask-mic'].classList.contains('on'), false)
})

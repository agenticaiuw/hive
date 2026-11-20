/*
 * The popup's ask box: the same one the dashboard, the phone app and Hive's floating window have.
 * Opening the popup starts listening right away (unless the mic was muted: a tap while it listens
 * mutes it, another listens again); when the owner stops talking, what they said goes to
 * Hive in the cloud with the page they're on (its address, title and an outline of it), so "when I
 * come to this page, show just my five courses" becomes a page rule Hive writes and the page applies
 * (page-rules.js). Anything else they ask goes to Hive like any other request, from this browser.
 *
 * The key to the cloud board comes from Hive on this Mac: Safari's native handler reads the one Hive
 * wrote (SafariWebExtensionHandler.swift "hive:key"), so nobody pastes anything.
 */
import {
  BOARD_KEY,
  NO_BOARD,
  RULES_KEY,
  WAITING_KEY,
  outlinePage,
  boardUrl,
  siteOf,
} from './page-rules-core.js'
import { boardKey, browserKind, keyName } from './cloud-peer.js'
import { nodeHeaders } from './version.js'

const api = globalThis.browser ?? globalThis.chrome
const $ = (id) => document.getElementById(id)
// What's in the box, kept while the popup is closed (the owner, 2026-11-17: typing something,
// hiding the popup and opening it again lost what was typed). Cleared once it's sent.
export const DRAFT_KEY = 'hiveAskDraft'
// The mic's mute, kept while the popup is closed: a muted popup opens without listening until the
// mic is tapped again (the owner, 2026-11-18: "why am i not able to mute the mic on the browser popup").
export const MUTED_KEY = 'hiveAskMuted'

async function call(board, path, body) {
  const base = boardUrl(board)
  if (!base) throw new Error(NO_BOARD)
  const response = await fetch(`${base}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${board.key}`, 'content-type': 'application/json', ...nodeHeaders(keyName(board.key)) },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: 'no-store',
  })
  const value = await response.json().catch(() => ({}))
  if (!response.ok) throw new Error(value.error || `Hive's cloud said ${response.status}`)
  return value
}

async function activeTab() {
  const [tab] = await api.tabs.query({ active: true, currentWindow: true })
  return tab || null
}

async function pageOf(tab) {
  if (!tab?.url || !/^https?:/.test(tab.url)) return null
  let outline = ''
  try {
    const [result] = await api.scripting.executeScript({ target: { tabId: tab.id }, func: outlinePage })
    outline = String(result?.result || '')
  } catch {}
  return { url: tab.url, title: tab.title || '', outline }
}

export function initAskHive() {
  const form = $('ask-form')
  if (!form) return
  const box = $('ask-text')
  const mic = $('ask-mic')
  const send = $('ask-send')
  const note = $('ask-note')
  const said = $('ask-said')
  const list = $('ask-rules')
  let board = null
  let tab = null
  let recognition = null
  let heard = ''
  let muted = false

  const say = (text, bad = false) => {
    note.textContent = text
    note.classList.toggle('bad', bad)
    note.hidden = !text
  }
  // Every change to the box goes through here, so closing the popup never loses it.
  const fill = (text) => {
    box.value = text
    keepDraft()
  }
  function keepDraft() {
    Promise.resolve(api.storage.local.set({ [DRAFT_KEY]: box.value })).catch(() => {})
  }

  async function showRules() {
    if (!tab?.url || !/^https?:/.test(tab.url)) return
    const site = siteOf(new URL(tab.url).hostname)
    let rules = (await api.storage.local.get(RULES_KEY))[RULES_KEY]?.[site] || []
    if (board) {
      try {
        const answer = await call(board, `/v1/page-rules?host=${encodeURIComponent(site)}`)
        rules = (answer.rules || []).map(({ id, path, title, rule, request }) => ({ id, path, title, rule, request }))
        const all = (await api.storage.local.get(RULES_KEY))[RULES_KEY] || {}
        await api.storage.local.set({ [RULES_KEY]: { ...all, [site]: rules } })
      } catch {}
    }
    list.replaceChildren()
    list.hidden = !rules.length
    for (const r of rules) {
      const li = document.createElement('li')
      const label = document.createElement('span')
      label.textContent = r.path ? `${r.title} (${r.path})` : r.title
      const back = document.createElement('button')
      back.type = 'button'
      back.textContent = 'Put back'
      back.title = 'Show this page the way it was'
      back.addEventListener('click', async () => {
        back.disabled = true
        try {
          await call(board, '/v1/page-rules/off', { id: r.id })
          say('Put back.')
        } catch (error) {
          say(error.message, true)
        }
        showRules()
      })
      li.append(label, back)
      list.append(li)
    }
  }

  async function submit() {
    stopListening()
    const words = box.value.trim()
    if (!words) return
    if (!board) board = await boardKey()
    if (!board) {
      say('Hive on this Mac hasn\'t connected this browser yet. Open Hive, then try again.', true)
      return
    }
    send.disabled = true
    send.textContent = 'Sending…'
    try {
      const page = await pageOf(tab)
      const { id } = await call(board, '/v1/requests', { text: words, from: browserKind(), page })
      fill('')
      // What you asked stays on screen, like your words on the floating window's card.
      said.textContent = words
      said.hidden = false
      say('Sent to Hive.')
      if (page) {
        const site = siteOf(new URL(page.url).hostname)
        await api.storage.local.set({ [WAITING_KEY]: { site, request: id, until: Date.now() + 5 * 60_000 } })
        watch(id)
      }
    } catch (error) {
      say(`Hive didn't take it: ${error.message}`, true)
    } finally {
      send.disabled = false
      send.textContent = 'Send'
    }
  }

  async function watch(id) {
    for (let i = 0; i < 120; i++) {
      await new Promise((resolve) => setTimeout(resolve, 2500))
      try {
        const { request } = await call(board, `/v1/requests/state?id=${id}`)
        if (request?.status === 'done' || request?.status === 'failed') {
          say(request.outcome || (request.status === 'done' ? 'Done.' : 'Hive couldn\'t do it.'), request.status === 'failed')
          showRules()
          return
        }
        say(request?.status === 'queued' ? 'Sent to Hive. Waiting its turn…' : 'Hive is on it…')
      } catch {}
    }
  }

  const Recognition = globalThis.SpeechRecognition || globalThis.webkitSpeechRecognition
  /** The mic button says what a tap does: mute while it listens, listen again while muted. */
  function showMic(on) {
    mic.classList.toggle('on', on)
    mic.classList.toggle('muted', !on && muted)
    mic.setAttribute('aria-pressed', on ? 'true' : 'false')
    const label = on ? 'Mute' : muted ? 'Muted: tap to listen' : 'Listen'
    mic.setAttribute('aria-label', label)
    mic.title = label
  }
  /** Stops listening. `drop` (a mute) throws away what the browser hadn't handed over yet. */
  function stopListening(drop = false) {
    if (recognition) {
      const r = recognition
      recognition = null
      try { drop ? r.abort() : r.stop() } catch {}
    }
    if (hiveListening) {
      const { id } = hiveListening
      hiveListening = null
      native({ type: 'hive:listen', action: 'cancel', id }).catch(() => {})
    }
    showMic(false)
  }
  function setMuted(on) {
    muted = on
    Promise.resolve(api.storage.local.set({ [MUTED_KEY]: on })).catch(() => {})
  }
  /*
   * A tap while it listens mutes it: it stops hearing at once, nothing is sent, and the words
   * already in the box stay there to send or change. It stays muted, even in the next popup,
   * until the mic is tapped again. (Send is how to send what was said before it stops by itself.)
   */
  function tapMic() {
    if (recognition || hiveListening) {
      setMuted(true)
      stopListening(true)
      say('Muted. Tap the mic to listen again.')
      return
    }
    setMuted(false)
    listen()
  }

  /*
   * Safari gives an extension's popup no way to ask for the microphone: its speech recognition
   * answers not-allowed before anyone is asked. So in Safari Hive on this Mac listens instead: the
   * app's extension handler passes start, stop and cancel to Hive.app, which has the microphone and
   * listens the way the floating window does: the words show here as Hive hears them, and once the
   * owner stops talking all of it is sent (SafariWebExtensionHandler.swift hive:listen and
   * hive:heard; Hive's SafariListen and sidecar_voice.py listen_for).
   */
  const throughHive = browserKind() === 'safari' && typeof api.runtime?.sendNativeMessage === 'function'
  const native = (message) => api.runtime.sendNativeMessage('application.id', message)
  let hiveListening = null
  addEventListener('pagehide', () => stopListening())

  async function listenThroughHive() {
    if (hiveListening) return
    const mine = { id: `${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`, typed: box.value.trim() }
    hiveListening = mine
    showMic(true)
    say('')
    const done = () => {
      if (hiveListening !== mine) return false
      hiveListening = null
      showMic(false)
      return true
    }
    try {
      const sent = await native({ type: 'hive:listen', action: 'start', id: mine.id })
      if (!sent?.ok) throw new Error(sent?.error || 'no answer')
    } catch {
      if (done()) say('Hive on this Mac couldn\'t listen. Open Hive, or type instead.', true)
      return
    }
    const started = Date.now()
    let answered = false
    while (hiveListening === mine) {
      await new Promise((resolve) => setTimeout(resolve, 250))
      let heard = null
      try {
        heard = (await native({ type: 'hive:heard' }))?.heard
      } catch {}
      if (hiveListening !== mine) return
      if (heard?.id !== mine.id) {
        if (!answered && Date.now() - started > 4000 && done()) {
          say('Hive isn\'t listening. Open Hive from the menu bar, or type instead.', true)
        }
        continue
      }
      answered = true
      if (heard.state === 'listening') {
        // The words so far, as Hive hears them: the floating window's live text, here.
        if (heard.text) fill([mine.typed, heard.text].filter(Boolean).join(' '))
        continue
      }
      if (heard.state === 'reading') {
        say('Reading what you said…')
        continue
      }
      if (!done()) return
      if (heard.state === 'error') {
        say(heard.error || 'Hive couldn\'t listen. Type instead.', true)
        return
      }
      const words = String(heard.text || '').trim()
      fill([mine.typed, words].filter(Boolean).join(' '))
      say('')
      if (words) submit()
      else say('Didn\'t hear anything. Tap the mic to try again, or type.')
      return
    }
  }

  function listen() {
    if (throughHive) {
      listenThroughHive()
      return
    }
    if (!Recognition) {
      mic.hidden = true
      return
    }
    if (recognition) return
    const r = new Recognition()
    recognition = r
    r.lang = navigator.language || 'en-US'
    r.interimResults = true
    r.continuous = false
    const typed = box.value.trim()
    heard = ''
    r.onresult = (event) => {
      let text = ''
      for (const result of event.results) text += result[0].transcript
      heard = text.trim()
      fill([typed, heard].filter(Boolean).join(' '))
    }
    r.onerror = (event) => {
      if (event.error === 'not-allowed' || event.error === 'service-not-allowed') say('Allow the microphone for Hive, or type instead.', true)
      else if (event.error !== 'aborted' && event.error !== 'no-speech') say(`Couldn't listen (${event.error}). Type instead.`, true)
    }
    r.onend = () => {
      const finished = recognition === r
      stopListening()
      // Like the floating window: when the owner stops talking, it goes.
      if (finished && heard) submit()
    }
    showMic(true)
    say('')
    try {
      r.start()
    } catch {
      stopListening()
    }
  }

  form.addEventListener('submit', (event) => {
    event.preventDefault()
    submit()
  })
  box.addEventListener('keydown', (event) => {
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      submit()
    }
  })
  box.addEventListener('input', () => {
    keepDraft()
    if (recognition || hiveListening) stopListening()
  })
  mic.addEventListener('click', tapMic)

  ;(async () => {
    tab = await activeTab().catch(() => null)
    board = await boardKey()
    showRules()
  })()
  // What was typed before the popup closed comes back first; then it listens, adding to it, unless
  // the mic was muted.
  ;(async () => {
    try {
      const draft = (await api.storage.local.get(DRAFT_KEY))[DRAFT_KEY]
      if (typeof draft === 'string' && draft.trim() && !box.value) box.value = draft
      muted = (await api.storage.local.get(MUTED_KEY))[MUTED_KEY] === true
    } catch {}
    if (muted) showMic(false)
    else listen()
  })()
}

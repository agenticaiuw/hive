/*
 * The popup's ask box: the same one the dashboard, the phone app and Hive's floating window have.
 * Opening the popup starts listening right away; when the owner stops talking, what they said goes to
 * Hive in the cloud with the page they're on (its address, title and an outline of it), so "when I
 * come to this page, show just my five courses" becomes a page rule Hive writes and the page applies
 * (page-rules.js). Anything else they ask goes to Hive like any other request, from this browser.
 *
 * The key to the cloud board comes from Hive on this Mac: Safari's native handler reads the one Hive
 * wrote (SafariWebExtensionHandler.swift "hive:key"), so nobody pastes anything.
 */
import {
  BOARD_KEY,
  BOARD_URL,
  RULES_KEY,
  WAITING_KEY,
  outlinePage,
  siteOf,
} from './page-rules-core.js'
import { boardKey, browserKind } from './cloud-peer.js'

const api = globalThis.browser ?? globalThis.chrome
const $ = (id) => document.getElementById(id)

async function call(board, path, body) {
  const response = await fetch(`${board.url || BOARD_URL}${path}`, {
    method: body === undefined ? 'GET' : 'POST',
    headers: { authorization: `Bearer ${board.key}`, 'content-type': 'application/json' },
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
  const list = $('ask-rules')
  let board = null
  let tab = null
  let recognition = null
  let heard = ''

  const say = (text, bad = false) => {
    note.textContent = text
    note.classList.toggle('bad', bad)
    note.hidden = !text
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
      box.value = ''
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
  function stopListening() {
    if (recognition) {
      const r = recognition
      recognition = null
      try { r.stop() } catch {}
    }
    mic.classList.remove('on')
    mic.setAttribute('aria-pressed', 'false')
  }
  function listen() {
    if (!Recognition) {
      mic.hidden = true
      return
    }
    if (recognition) {
      stopListening()
      return
    }
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
      box.value = [typed, heard].filter(Boolean).join(' ')
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
    mic.classList.add('on')
    mic.setAttribute('aria-pressed', 'true')
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
    if (recognition) stopListening()
  })
  mic.addEventListener('click', listen)

  ;(async () => {
    tab = await activeTab().catch(() => null)
    board = await boardKey()
    showRules()
  })()
  listen()
}

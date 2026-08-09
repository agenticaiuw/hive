/*
 * Popup: a command box in front of the Mac agent's plan/execute machinery.
 *
 * The popup only renders. Submitting sends the command to the background
 * service worker (console:submit), which talks to the agent and writes every
 * outcome into storage.local under HISTORY_KEY — so closing the popup never
 * kills a command, and reopening it shows what happened while it was closed.
 *
 * THE SAME FILE DRIVES TWO SURFACES: the toolbar popover (popup.html) and the
 * standalone console (popup.html?standalone=1) — same document, same storage
 * keys, so every render path here paints both. The standalone window exists
 * because Safari dismisses the popover on any outside click.
 */
import {
  HISTORY_KEY,
  INCLUDE_PAGE_KEY,
  MAX_COMMAND_CHARS,
  dashboardUrlFor,
  describeEntry,
} from './command-console.js'
import { DEFAULT_AGENT_URL } from './bridge-core.js'
import {
  APPROVALS_KEY,
  approvalCountdown,
  approvalIsAnswerable,
  approvalIsExpired,
} from './approvals.js'
import {
  chooseVoiceBackend,
  describeRecognitionError,
  mergeTranscript,
  speechLang,
} from './voice-input.js'

const api = globalThis.browser ?? globalThis.chrome

/* The standalone console is this same page under ?standalone=1. */
const CONSOLE_PAGE = 'popup.html?standalone=1'

const elements = {
  statusDot: document.getElementById('status-dot'),
  statusTitle: document.getElementById('status-title'),
  approvals: document.getElementById('approvals'),
  form: document.getElementById('command-form'),
  input: document.getElementById('command-input'),
  send: document.getElementById('command-send'),
  mic: document.getElementById('command-mic'),
  popOut: document.getElementById('pop-out'),
  includePage: document.getElementById('include-page'),
  includePageLabel: document.querySelector('label[for="include-page"] span'),
  notice: document.getElementById('command-notice'),
  history: document.getElementById('history'),
  openDashboard: document.getElementById('open-dashboard'),
  connectNow: document.getElementById('connect-now'),
  openSettings: document.getElementById('open-settings'),
}

/* Which surface this document is. The standalone console hides the pop-out
 * control (it IS the pop-out) and words the page checkbox for a window that
 * is never itself the page being talked about. The class on <body> is what
 * ui.css keys its standalone layout on. */
const standalone = new URLSearchParams(location.search).get('standalone') === '1'
if (standalone) {
  document.body.classList.add('standalone')
  document.title = 'AI Pendant Console'
  elements.popOut.hidden = true
  if (elements.includePageLabel) {
    elements.includePageLabel.textContent =
      'Include the active browser tab (title and address) with the command'
  }
}

let dashboardUrl = dashboardUrlFor(DEFAULT_AGENT_URL)

/* ===== Approval cards ===== */

/*
 * The popup only renders and asks; the decision itself is background.js's
 * (approval:decide), the same split the command box uses — so a card decided
 * here is decided even if the popup closes mid-flight, and the storage write
 * that settles it re-renders every open surface through onChanged.
 */
let heldApprovals = []
let approvalTicker = null
/* One in-flight decision at a time. The background chain would refuse the
 * second click anyway ("answered once"); this keeps the first click's card
 * visibly busy instead of letting two buttons race. */
let approvalBusyId = null

function renderApprovals(prompts) {
  heldApprovals = Array.isArray(prompts) ? prompts : []
  elements.approvals.replaceChildren(...heldApprovals.map((prompt) => renderApprovalCard(prompt)))
  elements.approvals.hidden = heldApprovals.length === 0

  /* A 1 Hz repaint while any countdown is running. The final tick is what
   * flips the last live card to its disabled "expired" state, after which the
   * ticker stops paying for a popup that no longer changes. */
  const anyLive = heldApprovals.some(
    (prompt) => approvalIsAnswerable(prompt) && prompt.expiresAt,
  )
  if (anyLive && approvalTicker === null) {
    approvalTicker = window.setInterval(() => renderApprovals(heldApprovals), 1_000)
  } else if (!anyLive && approvalTicker !== null) {
    window.clearInterval(approvalTicker)
    approvalTicker = null
  }
}

function renderApprovalCard(prompt) {
  const expired = !prompt.decision && approvalIsExpired(prompt)
  const settled = Boolean(prompt.decision)
  const busy = approvalBusyId === prompt.approvalId

  const item = document.createElement('article')
  item.className = `approval${settled ? ' approval-decided' : expired ? ' approval-expired' : ''}`

  const summary = document.createElement('p')
  summary.className = 'approval-summary'
  summary.textContent = prompt.summary

  const chip = document.createElement('span')
  chip.className = 'approval-chip'
  chip.textContent = prompt.risk ? `${prompt.risk} risk` : 'approval'
  summary.prepend(chip)
  item.append(summary)

  if (prompt.detail) {
    const detail = document.createElement('p')
    detail.className = 'approval-detail'
    detail.textContent = prompt.detail
    item.append(detail)
  }

  const clock = document.createElement('p')
  clock.className = `approval-clock${expired ? ' expired' : ''}`
  clock.textContent = settled
    ? `${prompt.decision === 'approve' ? 'Approved' : 'Denied'} — answer sent`
    : approvalCountdown(prompt)
  item.append(clock)

  const row = document.createElement('div')
  row.className = 'approval-actions'

  const approve = document.createElement('button')
  approve.type = 'button'
  approve.className = 'primary'
  approve.textContent =
    prompt.decision === 'approve' ? 'Approved' : expired ? 'Expired' : busy ? 'Sending…' : 'Approve'

  const deny = document.createElement('button')
  deny.type = 'button'
  deny.className = 'danger'
  deny.textContent = prompt.decision === 'deny' ? 'Denied' : expired ? 'Expired' : 'Deny'

  for (const button of [approve, deny]) {
    button.disabled = settled || expired || busy
  }
  approve.addEventListener('click', () => void decide(prompt, 'approve'))
  deny.addEventListener('click', () => void decide(prompt, 'deny'))

  row.append(approve, deny)
  item.append(row)
  return item
}

async function decide(prompt, decision) {
  if (approvalBusyId || !approvalIsAnswerable(prompt)) return
  approvalBusyId = prompt.approvalId
  renderApprovals(heldApprovals)

  try {
    const reply = await api.runtime.sendMessage({
      type: 'approval:decide',
      approvalId: prompt.approvalId,
      decision,
    })
    if (reply?.ok) {
      setNotice(decision === 'approve' ? 'Approved.' : 'Denied.')
      /* The settled list arrives through storage.onChanged; nothing to do. */
    } else {
      setNotice(reply?.error || 'The decision could not be sent.', true)
    }
  } catch (error) {
    setNotice(error?.message || 'The bridge is not awake yet — try again.', true)
  } finally {
    approvalBusyId = null
    renderApprovals(heldApprovals)
  }
}

function renderStatus(status) {
  const state = status?.state || 'offline'
  elements.statusDot.className = `dot ${
    state === 'connected' ? 'connected' : state === 'offline' ? 'error' : ''
  }`
  elements.statusTitle.textContent =
    state === 'connected'
      ? 'Connected'
      : state === 'needs-setup'
        ? 'Needs setup'
        : state === 'unauthorized'
          ? 'Bad token'
          : 'Offline'
}

function renderHistory(history) {
  const list = Array.isArray(history) ? history : []
  elements.history.replaceChildren(
    ...list.map((entry) => renderEntry(entry)),
  )
  elements.history.hidden = list.length === 0
}

function renderEntry(entry) {
  const view = describeEntry(entry)
  const item = document.createElement('article')
  item.className = `entry entry-${view.state}`

  const command = document.createElement('p')
  command.className = 'entry-command'
  command.textContent = entry.command
  item.append(command)

  const chip = document.createElement('span')
  chip.className = 'entry-chip'
  chip.textContent = view.label
  command.prepend(chip)

  if (view.headline) {
    const headline = document.createElement('p')
    headline.className = 'entry-headline'
    headline.textContent = view.headline
    item.append(headline)
  }

  if (entry.detail) {
    const detail = document.createElement('pre')
    detail.className = 'entry-detail'
    detail.textContent = entry.detail
    item.append(detail)
  }

  if (view.showDashboardLink) {
    const link = document.createElement('a')
    link.className = 'entry-link'
    link.href = dashboardUrl
    link.target = '_blank'
    link.rel = 'noreferrer'
    link.textContent = 'Open dashboard to review and approve'
    item.append(link)
  }

  return item
}

function setNotice(message, isError = false) {
  elements.notice.textContent = message
  elements.notice.className = `notice${isError ? ' error' : ''}`
}

async function currentPage() {
  try {
    /* In the popover, the last focused window is the one under the popover.
     * In the standalone console the last focused window is often the console
     * itself, whose extension-scheme URL scrubPageContext would discard —
     * so there the ACTIVE TABS across windows are searched for the first one
     * that is an actual web page. */
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true })
    if (tab && !standalone) return { url: tab.url ?? '', title: tab.title ?? '' }

    const selfUrl = api.runtime.getURL('')
    const candidates = await api.tabs.query({ active: true })
    const page = [tab, ...candidates].find(
      (candidate) => candidate?.url && !candidate.url.startsWith(selfUrl),
    )
    return page ? { url: page.url ?? '', title: page.title ?? '' } : null
  } catch {
    return null
  }
}

/* ===== Voice input =====
 *
 * A mic beside the box, a listening state, and the transcript LANDING IN THE
 * BOX — Send stays the only thing that sends. The pure halves (backend
 * choice, error wording, transcript merging) live in voice-input.js; this
 * block owns the one impure edge: SpeechRecognition. There is no cloud
 * fallback — a browser without Web Speech is told to type.
 */

/* One voice session at a time. `phase` is 'idle' | 'listening'. */
const voice = { phase: 'idle', recognition: null }

const speechRecognitionCtor = () =>
  globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null

function renderMic() {
  const listening = voice.phase === 'listening'
  elements.mic.classList.toggle('is-listening', listening)
  elements.mic.setAttribute('aria-pressed', String(listening))
  const label = listening ? 'Stop listening' : 'Speak a command'
  elements.mic.title = label
  elements.mic.setAttribute('aria-label', label)
  /* The box is the transcript's landing strip while a session runs; typing
   * into it mid-flight would fight the interim results. */
  elements.input.disabled = listening
  elements.send.disabled = listening
  elements.input.placeholder = listening ? 'Listening…' : 'Ask the agent anything…'
}

function settleVoice() {
  voice.phase = 'idle'
  voice.recognition = null
  renderMic()
  /* Re-assert honest availability: renderMic's idle state assumes a usable
   * backend, and there may not be one. */
  refreshMicAvailability()
  elements.input.focus()
}

/** Advertise availability honestly: a mic that cannot work says why. */
function refreshMicAvailability() {
  if (voice.phase !== 'idle') return
  const choice = chooseVoiceBackend({
    hasSpeechRecognition: Boolean(speechRecognitionCtor()),
  })
  elements.mic.disabled = choice.backend === 'none'
  elements.mic.title = choice.backend === 'none' ? choice.reason : 'Speak a command'
}

function startWebSpeech() {
  const Recognition = speechRecognitionCtor()
  const recognition = new Recognition()
  /* The transcript appends to whatever was already typed (mergeTranscript),
   * so a spoken half-sentence can finish a typed one. `committed` advances
   * only on final results; interim results preview past it. */
  let committed = elements.input.value
  recognition.lang = speechLang(navigator.language)
  recognition.interimResults = true
  recognition.maxAlternatives = 1
  recognition.continuous = false

  recognition.onresult = (event) => {
    let interim = ''
    for (let index = event.resultIndex; index < event.results.length; index += 1) {
      const result = event.results[index]
      const text = result[0]?.transcript ?? ''
      if (result.isFinal) {
        committed = mergeTranscript(committed, text)
      } else {
        interim += text
      }
    }
    elements.input.value = mergeTranscript(committed, interim)
  }

  recognition.onerror = (event) => {
    if (voice.recognition !== recognition) return
    const outcome = describeRecognitionError(event.error)
    if (!outcome.silent) setNotice(outcome.message, true)
    settleVoice()
  }

  recognition.onend = () => {
    /* Fires after onerror too; only settle a session still owned here. */
    if (voice.recognition !== recognition) return
    elements.input.value = committed
    settleVoice()
  }

  voice.phase = 'listening'
  voice.recognition = recognition
  renderMic()
  try {
    recognition.start()
  } catch (error) {
    setNotice(error?.message || 'Voice could not start — type instead.', true)
    settleVoice()
  }
}

elements.mic.addEventListener('click', () => {
  if (voice.phase === 'listening') {
    /* Finishing a Web Speech session: stop() delivers any final result and
     * then onend settles. */
    try {
      voice.recognition?.stop()
    } catch {
      settleVoice()
    }
    return
  }

  setNotice('')
  const choice = chooseVoiceBackend({
    hasSpeechRecognition: Boolean(speechRecognitionCtor()),
  })
  if (choice.backend === 'webspeech') {
    startWebSpeech()
  } else {
    setNotice(choice.reason, true)
  }
})

/* A popover that closes mid-listen must not keep the microphone. The
 * standalone console gets the same courtesy on close. */
window.addEventListener('pagehide', () => {
  try {
    voice.recognition?.abort?.()
  } catch {
    /* already stopped */
  }
})

/* ===== Pop-out =====
 *
 * Safari closes the popover on any outside click, so the pin opens this same
 * page under ?standalone=1 as its own window. Called from THIS document on
 * the owner's click; background.js is not involved. The ladder (focus what
 * exists → windows.create popup → pinned tab) is tried rung by rung, because
 * which rung Safari honors is not knowable from feature detection alone.
 */
elements.popOut.addEventListener('click', async () => {
  const url = api.runtime.getURL(CONSOLE_PAGE)

  try {
    /* Match patterns cannot name a query string, so ask for every popup.html
     * tab and keep the standalone ones — newest last, since the owner's most
     * recent pop-out is the one they arranged where they wanted it. */
    const tabs = await api.tabs.query({ url: `${api.runtime.getURL('popup.html')}*` })
    const open = (Array.isArray(tabs) ? tabs : [])
      .filter(
        (tab) =>
          tab &&
          tab.id !== undefined &&
          tab.id !== null &&
          String(tab.url ?? '').includes('standalone=1'),
      )
      .at(-1)
    if (open) {
      if (open.windowId !== undefined && api.windows?.update) {
        await api.windows.update(open.windowId, { focused: true })
      }
      await api.tabs.update(open.id, { active: true })
      if (!standalone) window.close()
      return
    }
  } catch {
    /* tabs.query over an extension URL can itself be refused (Safari);
     * opening a fresh console is the acceptable cost. */
  }

  /* Rung 1: a popup-type window (no tab strip in Chrome; a plain window in
   * browsers that ignore the type — persistence is the point, not chrome).
   * Rung 2: a pinned tab, the honest last resort when every window shape is
   * refused — still a page that survives clicking elsewhere. */
  if (api.windows?.create) {
    try {
      await api.windows.create({ url, type: 'popup', width: 420, height: 680, focused: true })
      if (!standalone) window.close()
      return
    } catch {
      /* Refused at runtime — fall through to the pinned tab. */
    }
  }
  try {
    await api.tabs.create({ url, pinned: true, active: true })
    if (!standalone) window.close()
    return
  } catch {
    /* Refused too. */
  }
  setNotice('This browser refused to open the console window or a pinned tab.', true)
})

elements.form.addEventListener('submit', async (event) => {
  event.preventDefault()
  const command = elements.input.value.trim().slice(0, MAX_COMMAND_CHARS)
  if (!command) return

  setNotice('')
  elements.send.disabled = true
  try {
    const page = elements.includePage.checked ? await currentPage() : null
    const reply = await api.runtime.sendMessage({
      type: 'console:submit',
      command,
      page,
    })
    if (reply?.ok) {
      elements.input.value = ''
    } else if (reply?.needsSetup) {
      setNotice('Save the agent token in settings first.', true)
    } else {
      setNotice(reply?.error || 'The bridge did not accept the command.', true)
    }
  } catch (error) {
    setNotice(error?.message || 'The bridge is not awake yet — try again.', true)
  } finally {
    elements.send.disabled = false
    elements.input.focus()
  }
})

elements.includePage.addEventListener('change', () => {
  void api.storage.local.set({ [INCLUDE_PAGE_KEY]: elements.includePage.checked })
})

elements.openDashboard.addEventListener('click', () => {
  void api.tabs.create({ url: dashboardUrl })
})

elements.connectNow.addEventListener('click', async () => {
  elements.statusTitle.textContent = 'Connecting…'
  try {
    await api.runtime.sendMessage({ type: 'bridge:poll-now' })
  } catch {
    // The alarm will restart a suspended service worker.
  }
  await refresh()
})

elements.openSettings.addEventListener('click', () => {
  void api.runtime.openOptionsPage()
})

api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  if (changes.bridgeStatus) renderStatus(changes.bridgeStatus.newValue)
  if (changes[HISTORY_KEY]) renderHistory(changes[HISTORY_KEY].newValue)
  if (changes[APPROVALS_KEY]) renderApprovals(changes[APPROVALS_KEY].newValue)
})

async function refresh() {
  const values = await api.storage.local.get([
    'bridgeStatus',
    'agentUrl',
    HISTORY_KEY,
    INCLUDE_PAGE_KEY,
    APPROVALS_KEY,
  ])
  dashboardUrl = dashboardUrlFor(values.agentUrl || DEFAULT_AGENT_URL)
  renderStatus(values.bridgeStatus)
  renderApprovals(values[APPROVALS_KEY])
  renderHistory(values[HISTORY_KEY])
  /* Default ON for convenience, but visible and remembered. */
  elements.includePage.checked = values[INCLUDE_PAGE_KEY] !== false
  refreshMicAvailability()
}

void refresh().then(() => elements.input.focus())

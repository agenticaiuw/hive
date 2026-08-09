/*
 * Popup: a command box in front of the Mac agent's plan/execute machinery.
 *
 * The popup only renders. Submitting sends the command to the background
 * service worker (console:submit), which talks to the agent and writes every
 * outcome into storage.local under HISTORY_KEY — so closing the popup never
 * kills a command, and reopening it shows what happened while it was closed.
 *
 * THE SAME FILE DRIVES TWO SURFACES: the toolbar popover (popup.html) and the
 * standalone console (console.html, <body class="standalone">) — same DOM ids,
 * same storage keys, so every render path here paints both. The standalone
 * window exists because Safari dismisses the popover on any outside click.
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
import { RELAY_STORAGE_KEYS, normalizeRelayConfig } from './relay-peer.js'
import {
  blobToBase64,
  chooseVoiceBackend,
  describeRecognitionError,
  interpretTranscribeResponse,
  mergeTranscript,
  mimeToFormat,
  pickRecorderMimeType,
  speechLang,
  transcribeLanguage,
  transcribeRequest,
} from './voice-input.js'
import {
  CONSOLE_PAGE,
  consoleWindowOptions,
  existingConsoleTab,
  isStandaloneSurface,
  planConsoleOpen,
} from './console-window.js'

const api = globalThis.browser ?? globalThis.chrome

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
 * is never itself the page being talked about. */
const standalone = isStandaloneSurface(document)
if (standalone) {
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
 * The dashboard's "speak from this browser" pipeline, on this surface: a mic
 * beside the box, a listening state, and the transcript LANDING IN THE BOX —
 * Send stays the only thing that sends. The pure halves (backend choice,
 * capture format table, /v1/transcribe descriptor, error wording) live in
 * voice-input.js; this block owns the impure edges: SpeechRecognition,
 * getUserMedia/MediaRecorder, and the one authenticated fetch.
 */

/* One voice session at a time. `phase` is 'idle' | 'listening' (Web Speech) |
 * 'recording' (MediaRecorder) | 'transcribing' (cloud round trip). */
const voice = { phase: 'idle', recognition: null, capture: null }

const speechRecognitionCtor = () =>
  globalThis.SpeechRecognition ?? globalThis.webkitSpeechRecognition ?? null

async function relayConfig() {
  return normalizeRelayConfig(await api.storage.local.get(RELAY_STORAGE_KEYS))
}

function renderMic() {
  const active = voice.phase !== 'idle'
  elements.mic.classList.toggle('is-listening', voice.phase === 'listening' || voice.phase === 'recording')
  elements.mic.classList.toggle('is-transcribing', voice.phase === 'transcribing')
  elements.mic.setAttribute('aria-pressed', String(voice.phase === 'listening' || voice.phase === 'recording'))
  elements.mic.disabled = voice.phase === 'transcribing'
  const label =
    voice.phase === 'listening' || voice.phase === 'recording'
      ? 'Stop listening'
      : voice.phase === 'transcribing'
        ? 'Transcribing…'
        : 'Speak a command'
  elements.mic.title = label
  elements.mic.setAttribute('aria-label', label)
  /* The box is the transcript's landing strip while a session runs; typing
   * into it mid-flight would fight the interim results. */
  elements.input.disabled = active
  elements.send.disabled = active
  elements.input.placeholder = active
    ? voice.phase === 'transcribing'
      ? 'Transcribing…'
      : 'Listening…'
    : 'Ask the agent anything…'
}

function settleVoice() {
  voice.phase = 'idle'
  voice.recognition = null
  voice.capture = null
  renderMic()
  /* Re-assert honest availability: renderMic's idle state assumes a usable
   * backend, and there may not be one. */
  void refreshMicAvailability()
  elements.input.focus()
}

/** Advertise availability honestly: a mic that cannot work says why. */
async function refreshMicAvailability() {
  if (voice.phase !== 'idle') return
  const relay = await relayConfig()
  const choice = chooseVoiceBackend({
    hasSpeechRecognition: Boolean(speechRecognitionCtor()),
    relayReady: relay.ready,
  })
  elements.mic.disabled = choice.backend === 'none'
  elements.mic.title = choice.backend === 'none' ? choice.reason : 'Speak a command'
}

function startWebSpeech(relay) {
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
    const outcome = describeRecognitionError(event.error, { relayReady: relay.ready })
    if (!outcome.silent) setNotice(outcome.message, !outcome.fallbackToCloud)
    if (outcome.fallbackToCloud) {
      voice.recognition = null
      void startRecording(relay)
      return
    }
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

/** The dashboard's capture, verbatim in behavior: 250 ms chunks, the same
 * mime candidates, the recorder handle kept out of any render path. */
async function startRecording(relay) {
  if (typeof MediaRecorder === 'undefined' || !navigator.mediaDevices?.getUserMedia) {
    setNotice('This browser cannot record audio — type a command instead.', true)
    settleVoice()
    return
  }
  let stream = null
  try {
    stream = await navigator.mediaDevices.getUserMedia({ audio: true })
    const mimeType = pickRecorderMimeType(MediaRecorder)
    const recorder = mimeType
      ? new MediaRecorder(stream, { mimeType })
      : new MediaRecorder(stream)
    const chunks = []
    recorder.ondataavailable = (event) => {
      if (event.data && event.data.size > 0) chunks.push(event.data)
    }
    recorder.start(250)
    voice.phase = 'recording'
    voice.capture = {
      recorder,
      stream,
      chunks,
      relay,
      mimeType: recorder.mimeType || mimeType || 'audio/webm',
      startedAt: Date.now(),
    }
    renderMic()
    setNotice('Recording — press the mic again to transcribe.')
  } catch {
    stream?.getTracks().forEach((track) => track.stop())
    setNotice('Microphone blocked — allow mic access for this extension, or type instead.', true)
    settleVoice()
  }
}

async function stopRecordingAndTranscribe() {
  const capture = voice.capture
  if (!capture) {
    settleVoice()
    return
  }
  voice.capture = null
  voice.phase = 'transcribing'
  renderMic()
  setNotice('Transcribing…')
  try {
    if (capture.recorder.state !== 'inactive') {
      /* A wedged recorder must not strand the box in "transcribing". */
      const stopped = new Promise((resolve) => {
        capture.recorder.onstop = () => resolve()
      })
      capture.recorder.stop()
      await Promise.race([
        stopped,
        new Promise((resolve) => window.setTimeout(resolve, 2000)),
      ])
    }
    const blob = new Blob(capture.chunks, { type: capture.mimeType })
    if (!blob.size) throw new Error('No audio captured — try again.')

    const request = transcribeRequest(capture.relay, {
      audioBase64: await blobToBase64(blob),
      format: mimeToFormat(blob.type || capture.mimeType),
      language: transcribeLanguage(navigator.language),
      durationMs: Date.now() - capture.startedAt,
    })
    const response = await fetch(`${capture.relay.relayUrl}${request.path}`, {
      method: request.method,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${capture.relay.deviceToken}`,
      },
      body: JSON.stringify(request.body),
    })
    let payload = null
    try {
      payload = await response.json()
    } catch {
      payload = null
    }
    const outcome = interpretTranscribeResponse({ status: response.status, payload })
    if (outcome.kind === 'transcript') {
      elements.input.value = mergeTranscript(elements.input.value, outcome.text)
      setNotice('')
    } else if (outcome.kind === 'no-speech') {
      setNotice('No speech detected — try again.')
    } else {
      setNotice(outcome.message, true)
    }
  } catch (error) {
    setNotice(error?.message || 'Voice transcription failed — type instead.', true)
  } finally {
    /* Always hand the microphone back, however the send ended. */
    capture.stream.getTracks().forEach((track) => track.stop())
    settleVoice()
  }
}

elements.mic.addEventListener('click', async () => {
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
  if (voice.phase === 'recording') {
    void stopRecordingAndTranscribe()
    return
  }
  if (voice.phase !== 'idle') return

  setNotice('')
  const relay = await relayConfig()
  const choice = chooseVoiceBackend({
    hasSpeechRecognition: Boolean(speechRecognitionCtor()),
    relayReady: relay.ready,
  })
  if (choice.backend === 'webspeech') {
    startWebSpeech(relay)
  } else if (choice.backend === 'cloud') {
    await startRecording(relay)
  } else {
    setNotice(choice.reason, true)
  }
})

/* A popover that closes mid-recording must not keep the microphone. The
 * standalone console gets the same courtesy on close. */
window.addEventListener('pagehide', () => {
  try {
    voice.recognition?.abort?.()
  } catch {
    /* already stopped */
  }
  const capture = voice.capture
  voice.capture = null
  if (!capture) return
  try {
    if (capture.recorder.state !== 'inactive') capture.recorder.stop()
  } catch {
    /* already stopped */
  }
  capture.stream.getTracks().forEach((track) => track.stop())
})

/* ===== Pop-out =====
 *
 * Safari closes the popover on any outside click, so the pin opens
 * console.html — this same UI — as a standalone window. Called from THIS
 * document on the owner's click; background.js is not involved. The ladder
 * (focus what exists → windows.create popup → pinned tab) is pure in
 * console-window.js; each rung is tried only when the one above it is
 * refused at runtime, because which rung Safari honors is not knowable from
 * feature detection alone.
 */
elements.popOut.addEventListener('click', async () => {
  const url = api.runtime.getURL(CONSOLE_PAGE)

  try {
    const open = existingConsoleTab(await api.tabs.query({ url }))
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

  for (const attempt of planConsoleOpen({ hasWindows: Boolean(api.windows?.create) })) {
    try {
      if (attempt.how === 'window') {
        await api.windows.create(consoleWindowOptions(url))
      } else {
        await api.tabs.create({ url, pinned: true, active: true })
      }
      if (!standalone) window.close()
      return
    } catch {
      /* Refused at runtime — fall through to the next rung. */
    }
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
  /* Pairing the relay peer in settings can turn the cloud mic on while a
   * standalone console sits open. */
  if (RELAY_STORAGE_KEYS.some((key) => key in changes)) void refreshMicAvailability()
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
  await refreshMicAvailability()
}

void refresh().then(() => elements.input.focus())

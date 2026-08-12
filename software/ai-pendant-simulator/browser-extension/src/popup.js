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
  consoleWindowRungs,
  currentEntry,
  dashboardUrlFor,
  describeBrainState,
  describeEntry,
} from './command-console.js'
import { DEFAULT_AGENT_URL } from './bridge-core.js'
import {
  PAIR_OUTCOME_KEY,
  defaultPairDeviceId,
  normalizePairLifetime,
} from './pairing.js'
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

/* The optional grant the local brain needs to act in tabs. Lived on the
 * deleted settings page ("Website access"); the popup owns it now. */
const WEBSITE_ORIGINS = ['http://*/*', 'https://*/*']

const elements = {
  statusDot: document.getElementById('status-dot'),
  statusTitle: document.getElementById('status-title'),
  brainDot: document.getElementById('brain-dot'),
  brainTitle: document.getElementById('brain-title'),
  brainHelp: document.getElementById('brain-help'),
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
  setup: document.getElementById('setup'),
  pairCode: document.getElementById('pair-code'),
  pairLifetime: document.getElementById('pair-lifetime'),
  pairConnect: document.getElementById('pair-connect'),
  pairNotice: document.getElementById('pair-notice'),
  grantPages: document.getElementById('grant-pages'),
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

/*
 * ONE ENTRY, NOT A LOG. The owner: "it should not show my past tasks in this
 * popup, only the current task." The history list is untouched in storage —
 * this is a 400px popover, and the thing worth its whole height is the command
 * in flight (or the last one's answer), not a scrollback the dashboard already
 * keeps better. Which entry that is, is currentEntry's decision, so the rule
 * is stated once and tested.
 */
/* One decision in flight at a time, for the same reason approvals have one. */
let planBusyId = null
let lastHistory = []

/**
 * Which brain, and the footer that explains it. Both come from one pure
 * function so the chip and the sentence can never disagree.
 */
function renderBrain({ relayStatus, agentConfigured }) {
  const view = describeBrainState({ relayStatus, agentConfigured })
  elements.brainDot.className = `dot ${
    view.tone === 'ok' ? 'connected' : view.tone === 'error' ? 'error' : ''
  }`
  elements.brainTitle.textContent = view.label
  elements.brainHelp.textContent = view.help
  /* The chip is short by necessity; the reason lives in the tooltip too, so it
   * survives the footer being scrolled past. */
  elements.brainDot.parentElement.title = view.help
}

function renderHistory(history) {
  lastHistory = Array.isArray(history) ? history : []
  const entry = currentEntry(lastHistory)
  elements.history.replaceChildren(...(entry ? [renderEntry(entry)] : []))
  elements.history.hidden = !entry
}

function renderEntry(entry) {
  const view = describeEntry(entry)
  const busy = planBusyId === entry.id
  const item = document.createElement('article')
  item.className = `entry entry-${view.state}`

  /*
   * The chip lives INSIDE this paragraph so it flows with the first line, and
   * a margin — not a space — separated it from the command. That is a visual
   * separation only: the paragraph's text content read
   * "Failedwhat are the most worth watching movies here", which is what a
   * screen reader announces, what a copy lands, and what the owner saw and
   * reported. An explicit space costs nothing and makes the text true.
   */
  const command = document.createElement('p')
  command.className = 'entry-command'

  const chip = document.createElement('span')
  chip.className = 'entry-chip'
  chip.textContent = view.label

  const commandText = document.createElement('span')
  commandText.textContent = entry.command

  command.append(chip, ' ', commandText)
  item.append(command)

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

  /*
   * The decision, HERE. A parked plan used to offer only a link to another
   * window; now Approve runs exactly the steps listed above it and Deny drops
   * them. background.js re-checks with the Mac before anything runs, so these
   * buttons cannot double-fire against the dashboard's.
   */
  if (view.canDecide) {
    const row = document.createElement('div')
    row.className = 'entry-actions'

    const approve = document.createElement('button')
    approve.type = 'button'
    approve.className = 'primary'
    approve.textContent = busy ? 'Running…' : 'Approve and run'
    approve.disabled = busy

    const deny = document.createElement('button')
    deny.type = 'button'
    deny.className = 'danger'
    deny.textContent = 'Deny'
    deny.disabled = busy

    approve.addEventListener('click', () => void decidePlan(entry, 'approve'))
    deny.addEventListener('click', () => void decidePlan(entry, 'deny'))
    row.append(approve, deny)
    item.append(row)
  } else if (view.decisionNote) {
    const note = document.createElement('p')
    note.className = 'entry-note'
    note.textContent = view.decisionNote
    item.append(note)
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

async function decidePlan(entry, decision) {
  if (planBusyId) return
  planBusyId = entry.id
  renderHistory(lastHistory)

  try {
    const reply = await api.runtime.sendMessage({
      type: 'plan:decide',
      id: entry.id,
      decision,
    })
    if (reply?.ok) {
      setNotice(
        decision === 'approve' ? 'Approved — running it…' : 'Denied. Nothing ran.',
      )
      /* The outcome arrives through storage.onChanged, same as a command. */
    } else if (reply?.needsSetup) {
      setNotice('Connect this browser first — paste the pairing code above.', true)
    } else {
      setNotice(reply?.error || 'That decision could not be sent.', true)
    }
  } catch (error) {
    setNotice(error?.message || 'The bridge is not awake yet — try again.', true)
  } finally {
    planBusyId = null
    renderHistory(lastHistory)
  }
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
  /*
   * And drop the approval countdown's 1 Hz timer. Safari SUSPENDS a popover's
   * page rather than always destroying it, so a repainting interval left
   * running against a hidden document is work nobody sees and a second way to
   * wedge the view that the next click has to reuse. renderApprovals starts a
   * fresh one whenever a live card is on screen again.
   */
  if (approvalTicker !== null) {
    window.clearInterval(approvalTicker)
    approvalTicker = null
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
      return
    }
  } catch {
    /* tabs.query over an extension URL can itself be refused (Safari);
     * opening a fresh console is the acceptable cost. */
  }

  /*
   * The ladder, ordered by consoleWindowRungs (command-console.js — which is
   * also where the "falsy return is not a refusal" bug is written up). Which
   * rungs a given Safari actually honors is not knowable from feature
   * detection, so anything that THROWS falls through to the next one.
   */
  const open = {
    'popup-window': () =>
      api.windows.create({ url, type: 'popup', width: 420, height: 680, focused: true }),
    'pinned-tab': () => api.tabs.create({ url, pinned: true, active: true }),
    tab: () => api.tabs.create({ url, active: true }),
    window: () => api.windows.create({ url, focused: true }),
  }

  for (const rung of consoleWindowRungs({
    hasWindowsCreate: Boolean(api.windows?.create),
    hasTabsCreate: Boolean(api.tabs?.create),
  })) {
    try {
      await open[rung]()
      /*
       * NOTHING CLOSES THE POPOVER HERE, and that is the fix for "expand it,
       * collapse it, and it never opens again."
       *
       * This line used to be `if (!standalone) window.close()`. Calling
       * window.close() on a Safari POPOVER does not merely dismiss it —
       * Safari keeps one web view for the toolbar popover and reuses it, and
       * closing it from script leaves that view dead. Every later click on
       * the toolbar button then rendered nothing at all, with no error to
       * see, until the whole browser was relaunched.
       *
       * It is also unnecessary: the new window takes focus, and a popover
       * that loses focus is dismissed by the browser itself — which is the
       * very behaviour this pop-out exists to escape.
       */
      return
    } catch {
      /* Refused at runtime — next rung. */
    }
  }
  setNotice('This browser refused every way of opening the console (popup window, pinned tab, tab, window).', true)
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
      setNotice('Connect this browser first — paste the pairing code above.', true)
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

/* ===== Setup (pairing) =====
 *
 * The whole settings page, reduced to what the owner actually did on it:
 * paste the code, press Connect. The popup COLLECTS and the worker does
 * everything else — fetch AND storage writes both live in background.js
 * ('pair:run'), because Safari has dropped this page's async sendMessage
 * reply when the agent's relay leg ran long, and a reply that carries the
 * credential loses the credential with it. The authoritative outcome
 * arrives through storage.onChanged (PAIR_OUTCOME_KEY); the reply below is
 * only used for wording when it happens to survive.
 */

let pairStartedAt = 0

function setPairNotice(message, isError = false) {
  elements.pairNotice.textContent = message
  elements.pairNotice.className = `notice${isError ? ' error' : ''}`
}

function renderSetup({ agentConfigured, brainConfigured }) {
  /*
   * The card shows when EITHER credential is missing, not just the agent's.
   * The owner hit the gap this closes (2026-08-12): agent token present,
   * relay credential gone — the footer said "paste the pairing code in this
   * popup" while this card, gated on agentConfigured alone, was hidden.
   * There was no box anywhere to paste into. One paste fills both halves,
   * so the card IS the repair path for a missing brain too.
   */
  elements.setup.hidden = agentConfigured && brainConfigured
  const title = elements.setup.querySelector('.setup-title')
  if (title) {
    title.textContent = agentConfigured
      ? 'Reconnect the brain'
      : 'Connect this browser'
  }
  /* One thing at a time in 400px: while the MAC half is unpaired, the
   * command box and its footer chrome would only be dead controls under the
   * one live card. With the agent paired and only the brain missing, the
   * command box still works (via the Mac), so both stay visible. */
  elements.form.hidden = !agentConfigured
  elements.history.hidden = elements.history.hidden || !agentConfigured
  elements.openDashboard.parentElement.hidden = !agentConfigured
}

function renderPairOutcome(outcome) {
  /* Only narrate an outcome for a pairing THIS popup started: a record from
   * last week must not greet every fresh open with "Paired." */
  if (!outcome || !pairStartedAt || (outcome.at ?? 0) < pairStartedAt) return
  pairStartedAt = 0
  elements.pairConnect.disabled = false
  if (outcome.ok) {
    elements.pairCode.value = ''
    setPairNotice(outcome.note || 'Paired.')
  } else {
    setPairNotice(outcome.error || 'Pairing failed.', true)
  }
}

elements.pairConnect.addEventListener('click', async () => {
  const code = elements.pairCode.value.trim()
  if (!code) {
    setPairNotice('Paste the pairing code first.', true)
    return
  }

  elements.pairConnect.disabled = true
  pairStartedAt = Date.now()
  setPairNotice('Pairing…')

  /* A stored device id wins so re-pairing rotates the same device; a stored
   * agentUrl override keeps working even though the URL field is gone. */
  const stored = await api.storage.local.get(['relayDeviceId', 'agentUrl', 'deviceName'])
  const randomBytes = new Uint8Array(3)
  crypto.getRandomValues(randomBytes)
  const deviceId = defaultPairDeviceId(
    stored.relayDeviceId,
    [...randomBytes].map((byte) => byte.toString(16).padStart(2, '0')).join(''),
  )

  try {
    const reply = await api.runtime.sendMessage({
      type: 'pair:run',
      agentUrl: stored.agentUrl || DEFAULT_AGENT_URL,
      code,
      deviceId,
      deviceName: stored.deviceName || 'Browser extension',
      lifetime: normalizePairLifetime(elements.pairLifetime.value),
    })
    if (reply === undefined || reply === null) {
      /*
       * THE REPLY WAS DROPPED, NOT THE PAIRING. This exact shape — a healthy
       * agent, a minted credential, and an undefined sendMessage resolution —
       * is what used to print "Pairing failed: the agent returned no token."
       * The worker owns the storage writes now, so the truthful message is
       * that the outcome is still on its way via storage.onChanged.
       */
      setPairNotice('Still pairing — finishing in the background. This popup will update by itself.')
    } else if (!reply.ok) {
      renderPairOutcome({ ...reply, at: Date.now() })
    }
    /* On reply.ok: the storage write beat the reply here; onChanged narrates. */
  } catch (error) {
    pairStartedAt = 0
    elements.pairConnect.disabled = false
    setPairNotice(error?.message || 'The bridge is not awake yet — try again.', true)
  }
})

/* ===== Website access =====
 *
 * permissions.request MUST be called inside the click handler — browsers
 * refuse the prompt without a user gesture, which is why this cannot be done
 * for the owner after pairing succeeds. */
async function renderGrantPages({ agentConfigured }) {
  let granted = true
  try {
    granted = await api.permissions.contains({ origins: WEBSITE_ORIGINS })
  } catch {
    /* An engine that cannot answer is not offered a button that cannot work. */
  }
  elements.grantPages.hidden = !agentConfigured || granted
}

elements.grantPages.addEventListener('click', async () => {
  let granted = false
  try {
    granted = await api.permissions.request({ origins: WEBSITE_ORIGINS })
  } catch {
    granted = false
  }
  if (granted) {
    elements.grantPages.hidden = true
    setNotice('Website access granted — this browser can now act in your tabs.')
  } else {
    setNotice('The browser did not grant website access.', true)
  }
})

/*
 * THE LISTENER MUST BE REMOVED WHEN THIS DOCUMENT DIES.
 *
 * storage.onChanged lives on the EXTENSION's context, which outlives any one
 * popover document — but this callback closes over `elements`, which belongs
 * to the document. Registering without removing meant every open/close cycle
 * left another listener behind, each one pinning a dead document and each one
 * still called on every storage write the worker makes. Measured 2026-08-10
 * by cycling the real built popup through five open/close rounds against one
 * shared context: 1, 2, 3, 4, 5 listeners, none released. Exactly the shape of
 * "it works the first time and then stops."
 *
 * Named, not inline, so pagehide can hand back the same reference.
 */
function onStorageChanged(changes, areaName) {
  if (areaName !== 'local') return
  if (changes.bridgeStatus) renderStatus(changes.bridgeStatus.newValue)
  /* The brain chip depends on two keys and a token, so a change in any of them
   * re-reads all of them rather than patching from one. agentToken also flips
   * the setup card, which refresh() repaints. */
  if (
    changes.relayStatus ||
    changes.agentToken ||
    changes.deviceToken ||
    changes.relayEnabled
  )
    void refresh()
  if (changes[HISTORY_KEY]) renderHistory(changes[HISTORY_KEY].newValue)
  if (changes[APPROVALS_KEY]) renderApprovals(changes[APPROVALS_KEY].newValue)
  /* THE pairing result channel. The worker writes this record whether or not
   * its sendMessage reply survives Safari, so a dropped reply costs nothing. */
  if (changes[PAIR_OUTCOME_KEY]) renderPairOutcome(changes[PAIR_OUTCOME_KEY].newValue)
}

api.storage.onChanged.addListener(onStorageChanged)

window.addEventListener('pagehide', () => {
  try {
    api.storage.onChanged.removeListener(onStorageChanged)
  } catch {
    /* A browser without removeListener is one that never kept it. */
  }
})

async function refresh() {
  const values = await api.storage.local.get([
    'bridgeStatus',
    'relayStatus',
    'agentUrl',
    'agentToken',
    'deviceToken',
    'relayEnabled',
    HISTORY_KEY,
    INCLUDE_PAGE_KEY,
    APPROVALS_KEY,
  ])
  const agentConfigured = Boolean(values.agentToken)
  /* The brain half: a relay credential that is present AND switched on. */
  const brainConfigured = Boolean(values.relayEnabled && values.deviceToken)
  dashboardUrl = dashboardUrlFor(values.agentUrl || DEFAULT_AGENT_URL)
  renderStatus(values.bridgeStatus)
  renderBrain({
    relayStatus: values.relayStatus,
    agentConfigured,
  })
  renderApprovals(values[APPROVALS_KEY])
  renderHistory(values[HISTORY_KEY])
  /* Default ON for convenience, but visible and remembered. */
  elements.includePage.checked = values[INCLUDE_PAGE_KEY] !== false
  refreshMicAvailability()
  /* Last, so the setup card's show/hide wins over renderHistory's. */
  renderSetup({ agentConfigured, brainConfigured })
  void renderGrantPages({ agentConfigured })
}

void refresh().then(() => {
  /* Focus goes to whichever box is the one thing to do. */
  ;(elements.setup.hidden ? elements.input : elements.pairCode).focus()
})

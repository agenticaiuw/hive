/*
 * Popup: a command box in front of the Mac agent's plan/execute machinery.
 *
 * The popup only renders. Submitting sends the command to the background
 * service worker (console:submit), which talks to the agent and writes every
 * outcome into storage.local under HISTORY_KEY — so closing the popup never
 * kills a command, and reopening it shows what happened while it was closed.
 */
import {
  HISTORY_KEY,
  INCLUDE_PAGE_KEY,
  MAX_COMMAND_CHARS,
  dashboardUrlFor,
  describeEntry,
} from './command-console.js'
import { DEFAULT_AGENT_URL } from './bridge-core.js'

const api = globalThis.browser ?? globalThis.chrome

const elements = {
  statusDot: document.getElementById('status-dot'),
  statusTitle: document.getElementById('status-title'),
  form: document.getElementById('command-form'),
  input: document.getElementById('command-input'),
  send: document.getElementById('command-send'),
  includePage: document.getElementById('include-page'),
  notice: document.getElementById('command-notice'),
  history: document.getElementById('history'),
  openDashboard: document.getElementById('open-dashboard'),
  connectNow: document.getElementById('connect-now'),
  openSettings: document.getElementById('open-settings'),
}

let dashboardUrl = dashboardUrlFor(DEFAULT_AGENT_URL)

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
    const [tab] = await api.tabs.query({ active: true, lastFocusedWindow: true })
    return tab ? { url: tab.url ?? '', title: tab.title ?? '' } : null
  } catch {
    return null
  }
}

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
})

async function refresh() {
  const values = await api.storage.local.get([
    'bridgeStatus',
    'agentUrl',
    HISTORY_KEY,
    INCLUDE_PAGE_KEY,
  ])
  dashboardUrl = dashboardUrlFor(values.agentUrl || DEFAULT_AGENT_URL)
  renderStatus(values.bridgeStatus)
  renderHistory(values[HISTORY_KEY])
  /* Default ON for convenience, but visible and remembered. */
  elements.includePage.checked = values[INCLUDE_PAGE_KEY] !== false
}

void refresh().then(() => elements.input.focus())

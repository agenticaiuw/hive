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
import {
  APPROVALS_KEY,
  approvalCountdown,
  approvalIsAnswerable,
  approvalIsExpired,
} from './approvals.js'

const api = globalThis.browser ?? globalThis.chrome

const elements = {
  statusDot: document.getElementById('status-dot'),
  statusTitle: document.getElementById('status-title'),
  approvals: document.getElementById('approvals'),
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
}

void refresh().then(() => elements.input.focus())

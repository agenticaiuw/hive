const api = globalThis.browser ?? globalThis.chrome
const statusDot = document.getElementById('status-dot')
const statusTitle = document.getElementById('status-title')
const statusDetail = document.getElementById('status-detail')

function render(status) {
  const state = status?.state || 'offline'
  statusDot.className = `dot ${
    state === 'connected' ? 'connected' : state === 'offline' ? 'error' : ''
  }`
  statusTitle.textContent =
    status?.message || 'The browser bridge has not connected yet.'
  statusDetail.textContent = status?.error || ''
}

async function refresh() {
  const values = await api.storage.local.get('bridgeStatus')
  render(values.bridgeStatus)
}

document.getElementById('connect-now').addEventListener('click', async () => {
  statusTitle.textContent = 'Connecting…'
  try {
    await api.runtime.sendMessage({ type: 'bridge:poll-now' })
  } catch {
    // The alarm will restart a suspended service worker.
  }
  await refresh()
})

document.getElementById('open-settings').addEventListener('click', () => {
  void api.runtime.openOptionsPage()
})

api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName === 'local' && changes.bridgeStatus) {
    render(changes.bridgeStatus.newValue)
  }
})

void refresh()

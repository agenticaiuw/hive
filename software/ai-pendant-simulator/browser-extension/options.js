const status = document.getElementById('status')

chrome.storage.sync.get(['agentUrl', 'agentToken'], (values) => {
  document.getElementById('agent-url').value =
    values.agentUrl ?? 'http://127.0.0.1:8000'
  document.getElementById('agent-token').value = values.agentToken ?? ''
})

document.getElementById('save').addEventListener('click', async () => {
  const agentUrl = document.getElementById('agent-url').value.trim()
  const agentToken = document.getElementById('agent-token').value.trim()

  await chrome.storage.sync.set({ agentUrl, agentToken })
  status.textContent = 'Saved. The background worker will reconnect automatically.'
})

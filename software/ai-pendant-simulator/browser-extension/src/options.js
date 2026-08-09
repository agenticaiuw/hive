import { normalizeConfig } from './bridge-core.js'
import {
  RELAY_ORIGIN_ALLOWLIST,
  RELAY_STORAGE_KEYS,
  normalizeRelayConfig,
  normalizeRelayUrl,
  relayOriginPattern,
} from './relay-peer.js'

const api = globalThis.browser ?? globalThis.chrome
const WEBSITE_ORIGINS = ['http://*/*', 'https://*/*']
const elements = {
  agentUrl: document.getElementById('agent-url'),
  agentToken: document.getElementById('agent-token'),
  deviceName: document.getElementById('device-name'),
  targetMode: document.getElementById('target-mode'),
  statusDot: document.getElementById('status-dot'),
  statusTitle: document.getElementById('status-title'),
  statusDetail: document.getElementById('status-detail'),
  extensionId: document.getElementById('extension-id'),
  lastConnected: document.getElementById('last-connected'),
  formStatus: document.getElementById('form-status'),
  permissionTitle: document.getElementById('permission-title'),
  permissionToggle: document.getElementById('permission-toggle'),
  relayEnabled: document.getElementById('relay-enabled'),
  relayUrl: document.getElementById('relay-url'),
  relayDeviceId: document.getElementById('relay-device-id'),
  relayDeviceToken: document.getElementById('relay-device-token'),
  relayTrusted: document.getElementById('relay-trusted'),
  relayDot: document.getElementById('relay-dot'),
  relayTitle: document.getElementById('relay-title'),
  relayDetail: document.getElementById('relay-detail'),
  relayStatus: document.getElementById('relay-status'),
  relayAllowlist: document.getElementById('relay-allowlist'),
}

async function load() {
  const values = await api.storage.local.get([
    'agentUrl',
    'agentToken',
    'deviceName',
    'targetMode',
    'bridgeStatus',
    'relayStatus',
    ...RELAY_STORAGE_KEYS,
  ])
  const config = normalizeConfig(values)
  elements.agentUrl.value = config.agentUrl
  elements.agentToken.value = config.agentToken
  elements.deviceName.value = config.deviceName
  elements.targetMode.value = config.targetMode

  const relay = normalizeRelayConfig(values)
  elements.relayEnabled.checked = relay.relayEnabled
  elements.relayUrl.value = relay.relayUrl || RELAY_ORIGIN_ALLOWLIST[0]
  elements.relayDeviceId.value = relay.relayDeviceId || ''
  elements.relayDeviceToken.value = relay.deviceToken || ''
  elements.relayTrusted.value = relay.trustedSenders
    .filter((sender) => !sender.startsWith('@'))
    .join(', ')
  elements.relayAllowlist.textContent = `Only these origins are accepted: ${RELAY_ORIGIN_ALLOWLIST.join(', ')}`

  renderStatus(values.bridgeStatus)
  renderRelayStatus(values.relayStatus, relay)
  await renderPermissions()
}

function renderRelayStatus(status, relay) {
  const state = relay?.ready ? status?.state || 'offline' : 'off'
  elements.relayDot.className = `dot ${
    state === 'connected' ? 'connected' : state === 'off' ? '' : 'error'
  }`
  elements.relayTitle.textContent =
    status?.message || relay?.reason || 'The relay peer has not connected yet.'
  elements.relayDetail.textContent = status?.error || ''
}

function renderStatus(status) {
  const state = status?.state || 'offline'
  elements.statusDot.className = `dot ${
    state === 'connected' ? 'connected' : state === 'offline' ? 'error' : ''
  }`
  elements.statusTitle.textContent =
    status?.message || 'The browser bridge has not connected yet.'
  elements.statusDetail.textContent = status?.error || ''
  elements.extensionId.textContent = api.runtime.id
  elements.lastConnected.textContent = formatDate(status?.lastConnectedAt)
}

async function renderPermissions() {
  const granted = await api.permissions.contains({ origins: WEBSITE_ORIGINS })
  elements.permissionTitle.textContent = granted
    ? 'Website control is allowed'
    : 'Website control is not allowed'
  elements.permissionToggle.textContent = granted ? 'Revoke access' : 'Grant access'
  elements.permissionToggle.dataset.granted = String(granted)
}

async function save() {
  setFormStatus('')
  let config

  try {
    config = normalizeConfig({
      agentUrl: elements.agentUrl.value,
      agentToken: elements.agentToken.value,
      deviceName: elements.deviceName.value,
      targetMode: elements.targetMode.value,
    })
  } catch (error) {
    setFormStatus(error.message, true)
    return
  }

  if (!config.agentToken) {
    setFormStatus('Enter AGENT_TOKEN before connecting.', true)
    return
  }

  await api.storage.local.set(config)
  if (api.storage.sync) await api.storage.sync.remove('agentToken')
  setFormStatus('Saved only in this browser profile.')
  void requestPoll()
}

async function testConnection() {
  setFormStatus('Testing…')
  let config
  try {
    config = normalizeConfig({
      agentUrl: elements.agentUrl.value,
      agentToken: elements.agentToken.value,
      deviceName: elements.deviceName.value,
      targetMode: elements.targetMode.value,
    })

    if (!config.agentToken) throw new Error('Enter AGENT_TOKEN first.')

    const controller = new AbortController()
    const timeout = setTimeout(() => controller.abort(), 6_000)
    let response
    try {
      response = await fetch(`${config.agentUrl}/browser/status`, {
        headers: { Authorization: `Bearer ${config.agentToken}` },
        cache: 'no-store',
        signal: controller.signal,
      })
    } finally {
      clearTimeout(timeout)
    }

    if (!response.ok) {
      const payload = await response.json().catch(() => ({}))
      throw new Error(payload.error || `Local agent returned HTTP ${response.status}.`)
    }

    setFormStatus('Connection and token are valid.')
  } catch (error) {
    setFormStatus(
      error.name === 'AbortError'
        ? 'Connection timed out. Is the local agent running?'
        : error.message,
      true,
    )
  }
}

async function togglePermissions() {
  const granted = elements.permissionToggle.dataset.granted === 'true'
  const changed = granted
    ? await api.permissions.remove({ origins: WEBSITE_ORIGINS })
    : await api.permissions.request({ origins: WEBSITE_ORIGINS })

  if (!changed && !granted) {
    setFormStatus('The browser did not grant website access.', true)
  }
  await renderPermissions()
}

async function clearToken() {
  elements.agentToken.value = ''
  await api.storage.local.remove('agentToken')
  if (api.storage.sync) await api.storage.sync.remove('agentToken')
  setFormStatus('The local token was removed from this browser profile.')
}

/* ------------------------------------------------------------------ *
 * The relay peer.
 * ------------------------------------------------------------------ */

function relayFormValues() {
  return {
    relayEnabled: elements.relayEnabled.checked,
    relayUrl: elements.relayUrl.value,
    relayDeviceId: elements.relayDeviceId.value,
    deviceToken: elements.relayDeviceToken.value,
    meshTrustedSenders: elements.relayTrusted.value,
  }
}

async function saveRelay() {
  setRelayStatus('')
  const raw = relayFormValues()

  if (raw.relayEnabled && !normalizeRelayUrl(raw.relayUrl)) {
    setRelayStatus(
      `That relay URL is not on the allowlist. Accepted: ${RELAY_ORIGIN_ALLOWLIST.join(', ')}`,
      true,
    )
    return
  }

  const relay = normalizeRelayConfig(raw)
  if (raw.relayEnabled && !relay.ready) {
    setRelayStatus(relay.reason, true)
    return
  }

  /*
   * The browser has to have granted the relay origin before a fetch from the
   * service worker can reach it. It is in host_permissions, but Safari treats
   * every host as something the owner grants, so ask here rather than let the
   * first drain fail with an opaque network error.
   */
  const pattern = relayOriginPattern(raw.relayUrl)
  if (relay.ready && pattern) {
    const granted =
      (await api.permissions.contains({ origins: [pattern] }).catch(() => false)) ||
      (await api.permissions.request({ origins: [pattern] }).catch(() => false))
    if (!granted) {
      setRelayStatus(
        'The browser has not granted access to the relay origin, so this browser cannot reach it. Allow it in the extension’s website settings.',
        true,
      )
      return
    }
  }

  await api.storage.local.set({
    relayEnabled: relay.relayEnabled,
    relayUrl: relay.relayUrl ?? '',
    relayDeviceId: relay.relayDeviceId ?? '',
    deviceToken: relay.deviceToken ?? '',
    meshTrustedSenders: relay.trustedSenders.filter((sender) => !sender.startsWith('@')),
  })
  setRelayStatus('Saved only in this browser profile.')
  void requestRelayDrain()
}

async function testRelay() {
  setRelayStatus('Testing…')
  const relay = normalizeRelayConfig({ ...relayFormValues(), relayEnabled: true })

  if (!relay.ready) {
    setRelayStatus(relay.reason, true)
    return
  }

  const controller = new AbortController()
  const timeout = setTimeout(() => controller.abort(), 8_000)
  try {
    const response = await fetch(
      `${relay.relayUrl}/v1/node/presence?deviceId=${encodeURIComponent(relay.relayDeviceId)}`,
      {
        headers: { Authorization: `Bearer ${relay.deviceToken}` },
        cache: 'no-store',
        signal: controller.signal,
      },
    )
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) {
      throw new Error(payload.error || `The relay returned HTTP ${response.status}.`)
    }
    setRelayStatus(
      `Relay reachable. ${payload.pending || 0} message(s) waiting for ${relay.relayDeviceId}.`,
    )
  } catch (error) {
    setRelayStatus(
      error.name === 'AbortError'
        ? 'The relay did not answer within 8s.'
        : error.message,
      true,
    )
  } finally {
    clearTimeout(timeout)
  }
}

async function clearRelayToken() {
  elements.relayDeviceToken.value = ''
  await api.storage.local.remove('deviceToken')
  setRelayStatus('The relay device token was removed from this browser profile.')
}

async function requestRelayDrain() {
  try {
    await api.runtime.sendMessage({ type: 'relay:drain-now' })
  } catch {
    // The next alarm will wake the service worker if it restarted mid-request.
  }
}

function setRelayStatus(message, isError = false) {
  elements.relayStatus.textContent = message
  elements.relayStatus.className = `notice${isError ? ' error' : ''}`
}

async function requestPoll() {
  try {
    await api.runtime.sendMessage({ type: 'bridge:poll-now' })
  } catch {
    // The next alarm will wake the service worker if it restarted mid-request.
  }
}

function setFormStatus(message, isError = false) {
  elements.formStatus.textContent = message
  elements.formStatus.className = `notice${isError ? ' error' : ''}`
}

function formatDate(value) {
  if (!value) return 'Never'
  const date = new Date(value)
  return Number.isNaN(date.getTime()) ? 'Never' : date.toLocaleString()
}

document.getElementById('save').addEventListener('click', save)
document.getElementById('test').addEventListener('click', testConnection)
document.getElementById('clear').addEventListener('click', clearToken)
document.getElementById('connect-now').addEventListener('click', requestPoll)
document.getElementById('relay-save').addEventListener('click', saveRelay)
document.getElementById('relay-test').addEventListener('click', testRelay)
document.getElementById('relay-clear').addEventListener('click', clearRelayToken)
document.getElementById('relay-drain').addEventListener('click', requestRelayDrain)
elements.permissionToggle.addEventListener('click', togglePermissions)

api.storage.onChanged.addListener((changes, areaName) => {
  if (areaName !== 'local') return
  if (changes.bridgeStatus) renderStatus(changes.bridgeStatus.newValue)
  if (changes.relayStatus) {
    void api.storage.local
      .get(RELAY_STORAGE_KEYS)
      .then((values) =>
        renderRelayStatus(changes.relayStatus.newValue, normalizeRelayConfig(values)),
      )
  }
})

void load()

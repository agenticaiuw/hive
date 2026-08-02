const DEFAULT_RELAY_URL = import.meta.env.VITE_RELAY_URL || 'http://localhost:8787'
const DEFAULT_RELAY_API_KEY = import.meta.env.VITE_RELAY_API_KEY || ''
const DEFAULT_PAIRING_CODE = import.meta.env.VITE_PAIRING_CODE || ''
const POLL_INTERVAL_MS = 350
const POLL_TIMEOUT_MS = 120000

export function loadCloudSettings() {
  return {
    relayUrl: localStorage.getItem('relayUrl') || DEFAULT_RELAY_URL,
    relayApiKey:
      localStorage.getItem('relayApiKey') || DEFAULT_RELAY_API_KEY,
    pairingCode:
      localStorage.getItem('relayPairingCode') || DEFAULT_PAIRING_CODE,
    mobileDeviceId:
      localStorage.getItem('mobileDeviceId') || 'mobile-controller',
  }
}

export function saveCloudSettings(settings) {
  localStorage.setItem('relayUrl', settings.relayUrl)
  localStorage.setItem('relayApiKey', settings.relayApiKey)
  localStorage.setItem('relayPairingCode', settings.pairingCode)
  localStorage.setItem('mobileDeviceId', settings.mobileDeviceId)
}

export function createCloudClient(settings) {
  const headers = {
    'Content-Type': 'application/json',
    Authorization: `Bearer ${settings.relayApiKey}`,
  }

  return {
    async checkHealth() {
      const response = await fetch(`${settings.relayUrl}/health`)
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Cloud relay health check failed.')
      }

      return payload
    },

    async registerMobile() {
      const response = await fetch(`${settings.relayUrl}/v1/devices/register`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          deviceId: settings.mobileDeviceId,
          deviceType: 'mobile',
          name: 'Mobile Pendant Controller',
          pairingCode: settings.pairingCode || undefined,
        }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Mobile device registration failed.')
      }

      return payload
    },

    async requestPlan(command, sessionId) {
      const response = await fetch(`${settings.relayUrl}/v1/mac/plan`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command,
          deviceId: settings.mobileDeviceId,
          sessionId: sessionId || undefined,
        }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Remote plan request failed.')
      }

      return waitForJob(settings, payload.job.jobId, (job) =>
        ['plan_ready', 'failed'].includes(job.status),
      )
    },

    async executePlan({ command, actions, planJobId, sessionId }) {
      const response = await fetch(`${settings.relayUrl}/v1/mac/execute`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          command,
          actions,
          planJobId,
          deviceId: settings.mobileDeviceId,
          sessionId: sessionId || undefined,
        }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Remote execute request failed.')
      }

      return waitForJob(settings, payload.job.jobId, (job) =>
        ['completed', 'failed'].includes(job.status),
      )
    },

    async transcribeAudio({ audioBase64, format, language }) {
      const response = await fetch(`${settings.relayUrl}/v1/transcribe`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          audioBase64,
          format,
          language,
        }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Speech-to-text failed.')
      }

      return payload
    },

    async speakText({ text, language }) {
      const response = await fetch(`${settings.relayUrl}/v1/speak`, {
        method: 'POST',
        headers,
        body: JSON.stringify({
          text,
          language,
        }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Text-to-speech failed.')
      }

      return payload
    },
  }
}

async function waitForJob(settings, jobId, isDone) {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    const response = await fetch(
      `${settings.relayUrl}/v1/mac/jobs/${encodeURIComponent(jobId)}`,
      {
        headers: {
          Authorization: `Bearer ${settings.relayApiKey}`,
        },
      },
    )
    const payload = await response.json()

    if (!response.ok) {
      throw new Error(payload.error ?? 'Remote job polling failed.')
    }

    if (isDone(payload.job)) {
      return payload.job
    }

    await sleep(POLL_INTERVAL_MS)
  }

  throw new Error('Remote job timed out. Check that the home Mac bridge is running.')
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

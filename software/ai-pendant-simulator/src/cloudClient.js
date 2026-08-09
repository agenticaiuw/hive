import {
  clearDeviceCredential,
  loadDeviceCredential,
  storeDeviceCredential,
} from './nativeSecureStorage.js'

const viteEnv = import.meta.env || {}
const DEFAULT_RELAY_URL = viteEnv.VITE_RELAY_URL || 'http://localhost:8787'
const DEFAULT_ACCOUNT_ID =
  viteEnv.VITE_PENDANT_ACCOUNT_ID || 'single-owner'
const POLL_INTERVAL_MS = 350
const POLL_TIMEOUT_MS = 120000

export function loadCloudSettings() {
  return {
    relayUrl: localStorage.getItem('relayUrl') || DEFAULT_RELAY_URL,
    relayApiKey:
      localStorage.getItem('relayApiKey') || '',
    pairingCode:
      localStorage.getItem('relayPairingCode') || '',
    mobileDeviceId: loadOrCreateMobileDeviceId(),
    deviceCredential: null,
  }
}

export function saveCloudSettings(settings) {
  localStorage.setItem('relayUrl', settings.relayUrl)
  localStorage.setItem('mobileDeviceId', settings.mobileDeviceId)
  // Administrator and one-time pairing secrets must never be newly persisted
  // in browser storage. Existing installs can still read them just long enough
  // to complete the device-token migration.
  localStorage.removeItem('relayApiKey')
  localStorage.removeItem('relayPairingCode')
}

export function createCloudClient(settings) {
  let credential = settings.deviceCredential || null
  let credentialLoaded = Boolean(credential)

  async function currentCredential() {
    if (!credentialLoaded) {
      credential = await loadDeviceCredential()
      credentialLoaded = true
    }
    return credential
  }

  async function authenticationHeaders() {
    const storedCredential = await currentCredential()
    const token = storedCredential?.token || settings.relayApiKey
    return {
      'Content-Type': 'application/json',
      ...(token ? { Authorization: `Bearer ${token}` } : {}),
    }
  }

  async function pairMobile() {
    const response = await fetch(`${settings.relayUrl}/v1/devices/pair`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        deviceId: settings.mobileDeviceId,
        deviceType: 'mobile',
        name: 'Mobile Pendant Controller',
        pairingCode: settings.pairingCode || undefined,
      }),
    })
    const payload = await response.json()

    if (!response.ok) {
      return { response, payload }
    }

    const issuedCredential = payload.credential
    if (!issuedCredential?.token) {
      throw new Error('Relay paired the device without issuing a credential.')
    }

    credential = issuedCredential
    credentialLoaded = true
    settings.deviceCredential = issuedCredential
    await storeDeviceCredential(issuedCredential)
    settings.pairingCode = ''
    localStorage.removeItem('relayPairingCode')
    return { response, payload }
  }

  async function legacyRegisterMobile() {
    const response = await fetch(`${settings.relayUrl}/v1/devices/register`, {
      method: 'POST',
      headers: await authenticationHeaders(),
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

    /*
     * The raw POST, status included rather than thrown.
     *
     * The brain's model transport (src/brain/relayInference.js) has to tell 403
     * "the relay has no inference route yet" apart from 401 "this phone was
     * revoked" apart from 429 "slow down" — three different sentences for the
     * owner. Every other method here collapses all of them into one Error, so
     * this is the one that hands back the response.
     *
     * It is also the single place a swap to a socket transport would land: the
     * credential lookup is here and nowhere above it.
     */
    async postJson(path, body, { signal = null } = {}) {
      const response = await fetch(`${settings.relayUrl}${path}`, {
        method: 'POST',
        headers: await authenticationHeaders(),
        body: JSON.stringify(body ?? {}),
        ...(signal ? { signal } : {}),
      })
      const payload = await response.json().catch(() => ({}))
      return { response, payload }
    },

    /** One key out of the relay's shared state store (`state:read`). */
    async readSharedState(stateKey) {
      const key = String(stateKey ?? '').trim()
      if (!key) {
        throw new Error('A state key is required.')
      }

      const response = await fetch(
        `${settings.relayUrl}/v1/state/${encodeURIComponent(key)}`,
        { headers: await authenticationHeaders() },
      )
      const payload = await response.json()

      if (response.status === 404) {
        return null
      }
      if (!response.ok) {
        throw new Error(payload.error ?? `Shared state "${key}" could not be read.`)
      }

      return payload.state?.data ?? null
    },

    /** Is the Mac's bridge socket connected right now (`device:status:read`)? */
    async bridgePresence() {
      const response = await fetch(`${settings.relayUrl}/v1/bridge/presence`, {
        headers: await authenticationHeaders(),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Bridge presence could not be read.')
      }

      return payload
    },

    /** Every registered device and when it was last seen (`device:status:read`). */
    async deviceStatus() {
      const response = await fetch(`${settings.relayUrl}/v1/devices/status`, {
        headers: await authenticationHeaders(),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(payload.error ?? 'Device status could not be read.')
      }

      return payload
    },

    /*
     * What this phone is paired as — and never the token itself.
     *
     * The brain needs the scope list to build its tool catalogue, and the UI
     * needs the role and tokenId to show which credential to revoke. Neither
     * needs the secret, so it does not leave this module.
     */
    async credentialSummary() {
      const stored = await currentCredential()
      if (!stored?.token) {
        return {
          paired: false,
          source: settings.relayApiKey ? 'admin-key-fallback' : 'none',
          role: null,
          tokenId: null,
          scopes: [],
        }
      }

      return {
        paired: true,
        source: 'device-credential',
        role: stored.role ?? 'device',
        tokenId: stored.tokenId ?? null,
        scopes: Array.isArray(stored.scopes) ? [...stored.scopes] : [],
        expiresAt: stored.expiresAt ?? null,
      }
    },

    async getAgentSnapshot() {
      const response = await fetch(
        `${settings.relayUrl}/v1/state/agent-snapshot`,
        {
          headers: await authenticationHeaders(),
        },
      )
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(
          payload.error ?? 'Shared agent state could not be loaded.',
        )
      }

      return payload.state?.data || null
    },

    async getProductState(accountId = DEFAULT_ACCOUNT_ID) {
      const response = await fetch(
        `${settings.relayUrl}/v1/product/state/${encodeURIComponent(accountId)}`,
        {
          headers: await authenticationHeaders(),
        },
      )
      const payload = await response.json()

      if (response.status === 404) {
        return emptyProductState(accountId, settings.mobileDeviceId)
      }
      if (!response.ok) {
        throw new Error(
          payload.error ?? 'Shared product data could not be loaded.',
        )
      }

      return payload.state || null
    },

    async saveProductState(state) {
      const response = await fetch(`${settings.relayUrl}/v1/product/state`, {
        method: 'PUT',
        headers: await authenticationHeaders(),
        body: JSON.stringify({ state }),
      })
      const payload = await response.json()

      if (!response.ok) {
        throw new Error(
          payload.error ?? 'Shared product data could not be saved.',
        )
      }

      return payload.state
    },

    async createProductSession({
      sessionId,
      title = 'New session',
      accountId = DEFAULT_ACCOUNT_ID,
    }) {
      const state = await this.getProductState(accountId)
      const now = new Date().toISOString()
      return this.saveProductState({
        ...state,
        accountId,
        sourceDeviceId: settings.mobileDeviceId,
        revision: Number(state.revision || 0) + 1,
        generatedAt: now,
        sessions: [
          ...(state.sessions || []),
          {
            sessionId,
            title,
            createdAt: now,
            updatedAt: now,
            deletedAt: null,
            sourceDeviceId: settings.mobileDeviceId,
            turns: [],
          },
        ],
        memory: state.memory || { entities: [], relations: [] },
      })
    },

    async registerMobile() {
      const storedCredential = await currentCredential()
      if (storedCredential?.token) {
        const response = await fetch(
          `${settings.relayUrl}/v1/devices/heartbeat`,
          {
            method: 'POST',
            headers: await authenticationHeaders(),
            body: JSON.stringify({ deviceId: settings.mobileDeviceId }),
          },
        )
        const payload = await response.json()

        if (response.ok) {
          return payload
        }

        if (response.status !== 401) {
          throw new Error(payload.error ?? 'Mobile device heartbeat failed.')
        }

        credential = null
        settings.deviceCredential = null
        await clearDeviceCredential()
      }

      const paired = await pairMobile()
      if (paired.response.ok) {
        return paired.payload
      }

      // Compatibility path for the currently deployed relay. Remove it once
      // all clients have paired and the administrator key is server-only.
      if (settings.relayApiKey) {
        return legacyRegisterMobile()
      }

      throw new Error(
        paired.payload.error ?? 'Mobile device pairing failed.',
      )
    },

    async requestPlan(command, sessionId) {
      const response = await fetch(`${settings.relayUrl}/v1/mac/plan`, {
        method: 'POST',
        headers: await authenticationHeaders(),
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
        headers: await authenticationHeaders(),
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
        headers: await authenticationHeaders(),
        body: JSON.stringify({
          audioBase64,
          format,
          language,
          deviceId: settings.mobileDeviceId,
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
        headers: await authenticationHeaders(),
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

    async forgetDeviceCredential() {
      credential = null
      credentialLoaded = true
      settings.deviceCredential = null
      await clearDeviceCredential()
    },
  }
}

function emptyProductState(accountId, sourceDeviceId) {
  return {
    schemaVersion: 'product-sync.v1',
    accountId,
    sourceDeviceId,
    revision: 0,
    generatedAt: new Date().toISOString(),
    sessions: [],
    memory: {
      entities: [],
      relations: [],
    },
  }
}

async function waitForJob(settings, jobId, isDone) {
  const deadline = Date.now() + POLL_TIMEOUT_MS

  while (Date.now() < deadline) {
    const response = await fetch(
      `${settings.relayUrl}/v1/mac/jobs/${encodeURIComponent(jobId)}`,
      {
        headers: await relayAuthenticationHeaders(settings),
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

async function relayAuthenticationHeaders(settings) {
  const credential =
    settings.deviceCredential || (await loadDeviceCredential())
  const token = credential?.token || settings.relayApiKey
  return token ? { Authorization: `Bearer ${token}` } : {}
}

function sleep(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms)
  })
}

function loadOrCreateMobileDeviceId() {
  const stored = localStorage.getItem('mobileDeviceId')
  if (stored) {
    return stored
  }

  const randomId =
    globalThis.crypto?.randomUUID?.() ||
    `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`
  const deviceId = `mobile-${randomId}`
  localStorage.setItem('mobileDeviceId', deviceId)
  return deviceId
}

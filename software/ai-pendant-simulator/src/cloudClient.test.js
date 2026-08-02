import assert from 'node:assert/strict'
import test from 'node:test'
import {
  createCloudClient,
  loadCloudSettings,
  saveCloudSettings,
} from './cloudClient.js'

function installLocalStorage(seed = {}) {
  const values = new Map(Object.entries(seed))
  globalThis.localStorage = {
    getItem(key) {
      return values.get(key) ?? null
    },
    setItem(key, value) {
      values.set(key, String(value))
    },
    removeItem(key) {
      values.delete(key)
    },
  }
  return values
}

function jsonResponse(status, payload) {
  return {
    ok: status >= 200 && status < 300,
    status,
    async json() {
      return payload
    },
  }
}

test('pairs without an admin key and uses the scoped token afterwards', async () => {
  const storage = installLocalStorage()
  const requests = []
  const deviceToken = 'pdt_deviceTokenId1.deviceSecretLongEnoughForValidation000'
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options })
    if (url.endsWith('/v1/devices/pair')) {
      return jsonResponse(200, {
        ok: true,
        device: { deviceId: 'mobile-test' },
        credential: {
          token: deviceToken,
          tokenId: 'deviceTokenId1',
          role: 'mobile',
          scopes: ['mac:plan', 'mac:jobs:read'],
        },
      })
    }
    if (url.endsWith('/v1/mac/plan')) {
      return jsonResponse(202, {
        ok: true,
        job: { jobId: 'job-1', status: 'queued' },
      })
    }
    if (url.endsWith('/v1/mac/jobs/job-1')) {
      return jsonResponse(200, {
        ok: true,
        job: { jobId: 'job-1', status: 'plan_ready' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const settings = {
    relayUrl: 'https://relay.example',
    relayApiKey: '',
    pairingCode: 'one-time-code',
    mobileDeviceId: 'mobile-test',
    deviceCredential: null,
  }
  const client = createCloudClient(settings)

  await client.registerMobile()
  const job = await client.requestPlan('Open Finder')

  assert.equal(job.status, 'plan_ready')
  assert.equal(requests[0].options.headers.Authorization, undefined)
  assert.equal(
    requests[1].options.headers.Authorization,
    `Bearer ${deviceToken}`,
  )
  assert.equal(
    requests[2].options.headers.Authorization,
    `Bearer ${deviceToken}`,
  )
  assert.equal(
    JSON.parse(storage.get('pendantDeviceCredential')).token,
    deviceToken,
  )
  assert.equal(storage.has('relayApiKey'), false)
})

test('keeps the admin-key registration path only for relay migration', async () => {
  installLocalStorage()
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options })
    if (url.endsWith('/v1/devices/pair')) {
      return jsonResponse(401, { ok: false, error: 'Old relay' })
    }
    if (url.endsWith('/v1/devices/register')) {
      return jsonResponse(200, {
        ok: true,
        device: { deviceId: 'mobile-legacy' },
      })
    }
    throw new Error(`Unexpected request: ${url}`)
  }

  const client = createCloudClient({
    relayUrl: 'https://relay.example',
    relayApiKey: 'temporary-admin-key',
    pairingCode: 'pair',
    mobileDeviceId: 'mobile-legacy',
    deviceCredential: null,
  })
  await client.registerMobile()

  assert.equal(requests.length, 2)
  assert.equal(
    requests[1].options.headers.Authorization,
    'Bearer temporary-admin-key',
  )
})

test('saving browser settings removes a previously persisted admin key', () => {
  const storage = installLocalStorage({
    relayApiKey: 'old-admin-key',
    relayPairingCode: 'old-pairing-code',
  })
  const settings = loadCloudSettings()
  assert.equal(settings.relayApiKey, 'old-admin-key')

  saveCloudSettings({
    ...settings,
    relayUrl: 'https://relay.example',
    pairingCode: 'pair',
    mobileDeviceId: 'mobile',
  })

  assert.equal(storage.has('relayApiKey'), false)
  assert.equal(storage.has('relayPairingCode'), false)
})

test('loads shared sessions from the durable agent snapshot', async () => {
  installLocalStorage()
  const deviceToken = 'pdt_snapshotToken01.deviceSecretLongEnoughForValidation000'
  globalThis.fetch = async (url, options = {}) => {
    assert.equal(url, 'https://relay.example/v1/state/agent-snapshot')
    assert.equal(options.headers.Authorization, `Bearer ${deviceToken}`)
    return jsonResponse(200, {
      ok: true,
      state: {
        revision: 4,
        data: {
          sessions: [{ sessionId: 'shared-session', title: 'Across devices' }],
        },
      },
    })
  }

  const client = createCloudClient({
    relayUrl: 'https://relay.example',
    relayApiKey: '',
    pairingCode: '',
    mobileDeviceId: 'mobile-snapshot',
    deviceCredential: { token: deviceToken },
  })

  const snapshot = await client.getAgentSnapshot()
  assert.deepEqual(snapshot.sessions, [
    { sessionId: 'shared-session', title: 'Across devices' },
  ])
})

test('loads canonical cross-device product state with the scoped credential', async () => {
  installLocalStorage({ relayUrl: 'https://relay.example' })
  const settings = loadCloudSettings()
  settings.deviceCredential = { token: 'device-token' }
  const requests = []
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, authorization: options.headers?.Authorization })
    return jsonResponse(200, {
      state: {
        accountId: 'single-owner',
        revision: 9,
        sessions: [{ sessionId: 'shared-session', turns: [] }],
        memory: { entities: [], relations: [] },
      },
    })
  }

  const state = await createCloudClient(settings).getProductState()
  assert.equal(state.revision, 9)
  assert.equal(state.sessions[0].sessionId, 'shared-session')
  assert.deepEqual(requests, [
    {
      url: 'https://relay.example/v1/product/state/single-owner',
      authorization: 'Bearer device-token',
    },
  ])
})

test('creates a mobile session in canonical product state', async () => {
  installLocalStorage()
  const requests = []
  const deviceToken =
    'pdt_productToken002.deviceSecretLongEnoughForValidation000'
  globalThis.fetch = async (url, options = {}) => {
    requests.push({ url, options })
    if (options.method !== 'PUT') {
      return jsonResponse(404, {
        ok: false,
        error: 'Product state has not been synchronized yet.',
      })
    }

    const { state } = JSON.parse(options.body)
    return jsonResponse(200, { ok: true, state })
  }

  const client = createCloudClient({
    relayUrl: 'https://relay.example',
    relayApiKey: '',
    pairingCode: '',
    mobileDeviceId: 'mobile-product',
    deviceCredential: { token: deviceToken },
  })
  const state = await client.createProductSession({
    sessionId: 'mobile-session',
    title: 'New session',
  })

  assert.equal(requests.length, 2)
  assert.equal(
    requests[0].url,
    'https://relay.example/v1/product/state/single-owner',
  )
  assert.equal(requests[1].url, 'https://relay.example/v1/product/state')
  assert.equal(requests[1].options.method, 'PUT')
  assert.equal(
    requests[1].options.headers.Authorization,
    `Bearer ${deviceToken}`,
  )
  assert.equal(state.sessions[0].sessionId, 'mobile-session')
  assert.equal(state.sessions[0].sourceDeviceId, 'mobile-product')
  assert.equal(state.revision, 1)
})

test('generates a stable unique mobile identity on first launch', () => {
  const storage = installLocalStorage()
  const first = loadCloudSettings().mobileDeviceId
  const second = loadCloudSettings().mobileDeviceId

  assert.match(first, /^mobile-[A-Za-z0-9-]+$/)
  assert.equal(second, first)
  assert.equal(storage.get('mobileDeviceId'), first)
})

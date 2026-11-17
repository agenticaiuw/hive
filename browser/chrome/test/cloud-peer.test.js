// The extension's way in from the cloud (src/cloud-peer.js), against a fake board and a fake browser.
import assert from 'node:assert/strict'
import { test } from 'node:test'
import { boardKey, browserKind, CLOUD_STATUS_KEY, connectionBadge, runCloudPeer } from '../src/cloud-peer.js'
import { BOARD_KEY } from '../src/page-rules-core.js'

function fakeBrowser(stored = {}, native = null) {
  const data = { ...stored }
  return {
    data,
    storage: {
      local: {
        get: async (key) => (key in data ? { [key]: data[key] } : {}),
        set: async (values) => Object.assign(data, values),
        remove: async (key) => {
          delete data[key]
        },
      },
    },
    runtime: native ? { sendNativeMessage: async (_app, message) => native(message) } : {},
  }
}

// A board that answers each call with the next of `answers` ({status, body} or a function of the
// call), and records every call.
function fakeBoard(answers) {
  const calls = []
  const fetchImpl = async (url, init) => {
    const call = { path: url.replace(/^https?:\/\/[^/]+/, ''), method: init.method, auth: init.headers.authorization, body: init.body && JSON.parse(init.body) }
    calls.push(call)
    let answer = answers.shift() ?? { status: 200, body: { command: null } }
    if (typeof answer === 'function') answer = answer(call)
    if (answer instanceof Error) throw answer
    return { ok: answer.status < 300, status: answer.status, json: async () => answer.body }
  }
  return { calls, fetchImpl }
}

const KEY = { url: 'https://board.test', key: 'ext.owner-mac-browser.abc' }
const command = { commandId: '7', createdAt: new Date().toISOString(), action: { type: 'list_tabs', params: {} } }
const quick = { delay: async () => {}, retryDelay: () => 0 }

test('the badge is ON while the cloud board answers, SET while there is no key yet', () => {
  assert.equal(connectionBadge({ state: 'connected' }).text, 'ON')
  assert.deepEqual(connectionBadge({ state: 'off' }), { state: 'needs-setup', text: 'SET', color: '#B54736' })
  // The cloud link not heard from yet: no claim either way.
  assert.equal(connectionBadge(undefined).text, '')
  assert.equal(connectionBadge({ state: 'offline' }).text, '!')
  assert.equal(connectionBadge({ state: 'unauthorized' }).state, 'unauthorized')
})

test('which browser this is, as the cloud knows it', () => {
  assert.equal(browserKind('Mozilla/5.0 (Macintosh) AppleWebKit/537.36 Chrome/158.0 Safari/537.36'), 'chrome')
  assert.equal(browserKind('Mozilla/5.0 (Macintosh) AppleWebKit/605.1.15 Version/26.0 Safari/605.1.15'), 'safari')
})

test('Safari gets the key from Hive on this Mac once, then keeps it', async () => {
  let asked = 0
  const browserApi = fakeBrowser({}, (message) => {
    asked += 1
    assert.deepEqual(message, { type: 'hive:key' })
    return { ok: true, key: KEY.key, url: KEY.url }
  })
  assert.deepEqual(await boardKey(browserApi), KEY)
  assert.deepEqual(await boardKey(browserApi), KEY)
  assert.equal(asked, 1)
  assert.equal(await boardKey(fakeBrowser()), null, 'no key and no Hive: nothing')
})

test('Chrome asks hive-tasks for the key by its host name; Safari asks the app', async () => {
  const asked = []
  for (const kind of ['chrome', 'safari']) {
    const browserApi = fakeBrowser()
    browserApi.runtime.sendNativeMessage = async (host, message) => {
      asked.push([host, message.type])
      return { ok: true, key: KEY.key, url: KEY.url }
    }
    assert.deepEqual(await boardKey(browserApi, kind), KEY)
  }
  assert.deepEqual(asked, [['hive.board_key', 'hive:key'], ['application.id', 'hive:key']])
  const missing = fakeBrowser()
  missing.runtime.sendNativeMessage = async () => {
    throw new Error('Specified native messaging host not found.')
  }
  assert.equal(await boardKey(missing, 'chrome'), null, 'no hive-tasks yet: nothing, and no throw')
})

test('a command from the cloud runs once and its result goes back', async () => {
  const browserApi = fakeBrowser({ [BOARD_KEY]: KEY })
  let stop = false
  const board = fakeBoard([
    { status: 200, body: { command } },
    { status: 200, body: { ok: true, saved: 1 } },
    () => {
      stop = true
      return { status: 200, body: { command: null } }
    },
  ])
  const ran = []
  await runCloudPeer({
    browserApi,
    fetchImpl: board.fetchImpl,
    kind: 'safari',
    getConfig: async () => ({ cfg: 1 }),
    executeCommand: async (cmd, config) => {
      ran.push([cmd, config])
      return { tabs: [{ title: 'Canvas' }] }
    },
    shouldStop: () => stop,
    ...quick,
  })
  assert.deepEqual(ran, [[command, { cfg: 1 }]])
  assert.equal(board.calls[0].path, '/v1/browser/next?browser=safari&wait=20')
  assert.equal(board.calls[0].auth, `Bearer ${KEY.key}`)
  assert.deepEqual(board.calls[1], { path: '/v1/browser/result', method: 'POST', auth: `Bearer ${KEY.key}`, body: { id: '7', ok: true, result: { tabs: [{ title: 'Canvas' }] } } })
  assert.equal(browserApi.data[CLOUD_STATUS_KEY].state, 'connected')
})

test('a command that fails sends back why, and a lost answer is sent again', async () => {
  const browserApi = fakeBrowser({ [BOARD_KEY]: KEY })
  let stop = false
  const board = fakeBoard([
    { status: 200, body: { command } },
    new Error('network down'),
    { status: 503, body: { error: 'busy' } },
    () => {
      stop = true
      return { status: 200, body: { ok: true, saved: 1 } }
    },
  ])
  await runCloudPeer({
    browserApi,
    fetchImpl: board.fetchImpl,
    kind: 'chrome',
    getConfig: async () => ({}),
    executeCommand: async () => {
      throw new Error('Page access denied')
    },
    shouldStop: () => stop,
    ...quick,
  })
  const results = board.calls.filter((c) => c.path === '/v1/browser/result')
  assert.equal(results.length, 3)
  for (const r of results) assert.deepEqual(r.body, { id: '7', ok: false, error: 'Page access denied' })
})

test('a key the cloud refuses is dropped, so the next start asks Hive for the current one', async () => {
  const browserApi = fakeBrowser({ [BOARD_KEY]: KEY })
  const board = fakeBoard([{ status: 401, body: { error: 'Not signed in.' } }])
  await runCloudPeer({ browserApi, fetchImpl: board.fetchImpl, kind: 'safari', getConfig: async () => ({}), executeCommand: async () => ({}), ...quick })
  assert.equal(BOARD_KEY in browserApi.data, false)
  assert.equal(browserApi.data[CLOUD_STATUS_KEY].state, 'unauthorized')
  assert.equal(board.calls.length, 1)
})

test('with no key yet it says so and stops, asking the cloud nothing', async () => {
  const browserApi = fakeBrowser()
  const board = fakeBoard([])
  await runCloudPeer({ browserApi, fetchImpl: board.fetchImpl, kind: 'safari', getConfig: async () => ({}), executeCommand: async () => ({}), ...quick })
  assert.equal(board.calls.length, 0)
  assert.equal(browserApi.data[CLOUD_STATUS_KEY].state, 'off')
})

test('an unreachable cloud is retried after a pause, and the status says so meanwhile', async () => {
  const browserApi = fakeBrowser({ [BOARD_KEY]: KEY })
  let stop = false
  const pauses = []
  const states = []
  const board = fakeBoard([
    new Error('offline'),
    () => {
      states.push(browserApi.data[CLOUD_STATUS_KEY].state)
      stop = true
      return { status: 200, body: { command: null } }
    },
  ])
  await runCloudPeer({
    browserApi,
    fetchImpl: board.fetchImpl,
    kind: 'safari',
    getConfig: async () => ({}),
    executeCommand: async () => ({}),
    shouldStop: () => stop,
    delay: async (ms) => pauses.push(ms),
  })
  assert.deepEqual(states, ['offline'])
  assert.deepEqual(pauses, [1000])
  assert.equal(browserApi.data[CLOUD_STATUS_KEY].state, 'connected')
})

/*
 * The mesh routes and the socket upgrade, exercised as HTTP rather than as
 * functions.
 *
 * nodeMailbox.test.js proves the queue behaves. This proves the BOUNDARY: that
 * a credential which is allowed to drain *an* inbox cannot drain *that* one,
 * and that a stolen token cannot open another node's socket. Those checks live
 * in the handlers, not in the scope table — a scope can say "you may drain an
 * inbox", it cannot say which — so testing the functions alone would have left
 * the entire authorization story unasserted.
 *
 * Binds 127.0.0.1:0 (an ephemeral port the OS picks), so it cannot collide
 * with the owner's relay on 8787 or the agent on 8000. No real credentials:
 * the principal is injected the same way server.js's auth middleware injects
 * it, which is what these handlers actually read.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import express from 'express'
import { createMemoryStore } from './store/memoryStore.js'
import { setCloudflareBindings } from './cloudflareBindings.js'
import { registerNodeMeshRoutes } from './nodeMailbox.js'
import { handleNodeSocketUpgrade } from '../cloudflare-worker/bridgeHub.js'
import { createDeviceCredential } from './deviceAuth.js'

/** A relay with one injected principal, on a port the OS chooses. */
async function relayFor(principal, store) {
  const app = express()
  app.use(express.json())
  app.use((request, _response, next) => {
    request.relayPrincipal = principal
    next()
  })
  registerNodeMeshRoutes(app, { getStore: async () => store })

  const server = await new Promise((resolve) => {
    const listener = app.listen(0, '127.0.0.1', () => resolve(listener))
  })
  const { port } = server.address()
  return {
    async call(method, path, body) {
      const response = await fetch(`http://127.0.0.1:${port}${path}`, {
        method,
        headers: body ? { 'content-type': 'application/json' } : {},
        body: body ? JSON.stringify(body) : undefined,
      })
      return { status: response.status, body: await response.json() }
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}

function devicePrincipal(deviceId, scopes = []) {
  return { kind: 'device', tokenId: 'tok-fixture', deviceId, role: 'mobile', scopes }
}

async function storeWithNodes(deviceIds) {
  const store = createMemoryStore()
  for (const deviceId of deviceIds) {
    await store.saveDevice({ deviceId, deviceType: 'mobile', name: deviceId })
  }
  return store
}

test.afterEach(() => setCloudflareBindings(null))

test('a node sends, the addressee drains, and the sender is stamped', async () => {
  const store = await storeWithNodes(['node-a', 'node-b'])
  const sender = await relayFor(devicePrincipal('node-a'), store)
  const receiver = await relayFor(devicePrincipal('node-b'), store)

  const sent = await sender.call('POST', '/v1/node/messages', {
    to: 'node-b',
    kind: 'browser.tab.open',
    payload: { url: 'https://example.com' },
  })
  assert.equal(sent.status, 202)
  assert.equal(sent.body.from, 'node-a')
  assert.equal(sent.body.queued, true, 'no socket in this test process')

  const inbox = await receiver.call('GET', '/v1/node/inbox?deviceId=node-b')
  assert.equal(inbox.status, 200)
  assert.equal(inbox.body.messages.length, 1)
  assert.equal(inbox.body.messages[0].payload.url, 'https://example.com')

  const acked = await receiver.call('POST', '/v1/node/inbox/ack', {
    deviceId: 'node-b',
    messageIds: [inbox.body.messages[0].id],
  })
  assert.equal(acked.body.acknowledged, 1)
  assert.equal(acked.body.pending, 0)

  await sender.close()
  await receiver.close()
})

test('a node cannot claim to be another node', async () => {
  /*
   * The receiver's only basis for trusting a message is `from`. If a sender
   * could name itself, a compromised extension could impersonate the Mac and
   * hand the phone an instruction it would treat as the owner's.
   */
  const store = await storeWithNodes(['node-a', 'node-b'])
  const relay = await relayFor(devicePrincipal('node-a'), store)

  const sent = await relay.call('POST', '/v1/node/messages', {
    from: 'mac-bridge-1',
    to: 'node-b',
    kind: 'mac.run',
    payload: { command: 'rm -rf' },
  })
  assert.equal(sent.status, 202)
  assert.equal(
    sent.body.from,
    'node-a',
    'the body-supplied `from` must be ignored entirely',
  )
  await relay.close()
})

test('a node cannot drain or acknowledge another node’s inbox', async () => {
  /*
   * THE test for a stolen token. The thief holds a real credential with the
   * real scope — node:message:receive — so the scope table lets the request
   * through and only principalOwnsDevice stops it.
   */
  const store = await storeWithNodes(['victim', 'thief'])
  const sender = await relayFor(devicePrincipal('thief'), store)
  await sender.call('POST', '/v1/node/messages', {
    to: 'victim',
    kind: 'test.a',
    payload: { secret: 'for the victim only' },
  })

  const stolen = await relayFor(devicePrincipal('thief'), store)
  const drain = await stolen.call('GET', '/v1/node/inbox?deviceId=victim')
  assert.equal(drain.status, 403)
  assert.match(drain.body.error, /only drain its own inbox/)

  const ack = await stolen.call('POST', '/v1/node/inbox/ack', {
    deviceId: 'victim',
    messageIds: ['nmsg_anything'],
  })
  assert.equal(ack.status, 403)

  /* And the message is still there for its actual addressee. */
  const victim = await relayFor(devicePrincipal('victim'), store)
  const inbox = await victim.call('GET', '/v1/node/inbox?deviceId=victim')
  assert.equal(inbox.body.messages.length, 1)

  await sender.close()
  await stolen.close()
  await victim.close()
})

test('the admin principal may drain any inbox, and owns no device', async () => {
  const store = await storeWithNodes(['node-b'])
  const admin = await relayFor({ kind: 'admin', role: 'admin', scopes: ['*'] }, store)

  const sent = await admin.call('POST', '/v1/node/messages', {
    to: 'node-b',
    kind: 'relay.notice',
    payload: { text: 'hello' },
  })
  /* An admin has no deviceId, so it speaks as the relay itself rather than
   * borrowing a node's identity. */
  assert.equal(sent.body.from, '@relay')

  const inbox = await admin.call('GET', '/v1/node/inbox?deviceId=node-b')
  assert.equal(inbox.status, 200)
  await admin.close()
})

test('a malformed send is refused with a reason, not a 500', async () => {
  const store = await storeWithNodes(['node-a', 'node-b'])
  const relay = await relayFor(devicePrincipal('node-a'), store)

  for (const body of [
    {},
    { to: 'node-b' },
    { to: 'node-b', kind: 'NOT A KIND' },
    { to: 'nobody-here', kind: 'test.a' },
    { to: 'node-b', kind: 'test.a', payload: 'a string' },
    { to: 'node-a', kind: 'test.a' },
  ]) {
    const response = await relay.call('POST', '/v1/node/messages', body)
    assert.equal(response.status, 400, JSON.stringify(body))
    assert.equal(response.body.ok, false)
    assert.ok(response.body.error, 'must say why')
  }
  await relay.close()
})

test('presence over HTTP reports pending depth alongside the socket', async () => {
  const store = await storeWithNodes(['node-a', 'node-b'])
  const relay = await relayFor(devicePrincipal('node-a'), store)
  await relay.call('POST', '/v1/node/messages', { to: 'node-b', kind: 'test.a' })

  const presence = await relay.call('GET', '/v1/node/presence?deviceId=node-b')
  assert.equal(presence.status, 200)
  assert.equal(presence.body.connected, false)
  assert.equal(presence.body.observed, false, 'no hub binding in this process')
  assert.equal(presence.body.pending, 1)
  await relay.close()
})

/* ---- the socket upgrade ------------------------------------------------- */

function socketRequest(deviceId, token, { upgrade = 'websocket' } = {}) {
  const headers = new Headers()
  if (upgrade) headers.set('Upgrade', upgrade)
  if (token) headers.set('Authorization', `Bearer ${token}`)
  return new Request(
    `https://relay.invalid/v1/node/socket?deviceId=${encodeURIComponent(deviceId)}`,
    { headers },
  )
}

/*
 * A BRIDGE_HUB whose stub records that it was reached at all — which is the
 * assertion that matters: an upgrade the handler should have refused must not
 * reach the Durable Object, because reaching it IS the grant.
 *
 * The stub answers 200, not 101: undici refuses to construct a Response
 * outside 200-599, so the real 101 the workerd runtime returns cannot be
 * faked here. What is under test is the handler's decision, and the handler
 * returns the stub's response unexamined.
 */
const HUB_REACHED_STATUS = 200
function hubEnv(reached) {
  return {
    BRIDGE_HUB: {
      idFromName: (name) => name,
      get: (name) => ({
        async fetch() {
          reached.push(name)
          return new Response(null, { status: HUB_REACHED_STATUS })
        },
      }),
    },
  }
}

test('the mesh socket refuses a token that does not own the device', async () => {
  /*
   * The briefing's requirement, asserted: "a stolen extension token must not
   * be able to open the phone's socket." The handler shares its auth path with
   * /v1/bridge/socket, so this covers both.
   */
  const store = await createMemoryStore()
  const { token, record } = createDeviceCredential({
    deviceId: 'browser-node-1',
    deviceType: 'browser_node',
  })
  await store.saveDeviceCredential(record)

  /* handleNodeSocketUpgrade imports the shared store lazily; point that at
   * ours by seeding the module-level binding the store resolves through. */
  const { getStore } = await import('./store/index.js')
  const sharedStore = await getStore()
  await sharedStore.saveDeviceCredential(record)

  const reached = []
  const denied = await handleNodeSocketUpgrade(
    socketRequest('phone-1', token),
    hubEnv(reached),
  )
  assert.equal(denied.status, 403)
  assert.equal(
    reached.length,
    0,
    'the hub must never be reached by an unauthorized upgrade',
  )

  const allowed = await handleNodeSocketUpgrade(
    socketRequest('browser-node-1', token),
    hubEnv(reached),
  )
  assert.equal(allowed.status, HUB_REACHED_STATUS)
  assert.deepEqual(
    reached,
    ['browser-node-1'],
    'and it must reach the instance named for ITS OWN deviceId',
  )
})

test('the mesh socket refuses a role without node:message:receive', async () => {
  const { getStore } = await import('./store/index.js')
  const sharedStore = await getStore()
  const { token, record } = createDeviceCredential({
    deviceId: 'pendant-1',
    deviceType: 'nrf_pendant',
  })
  await sharedStore.saveDeviceCredential(record)

  const reached = []
  const response = await handleNodeSocketUpgrade(
    socketRequest('pendant-1', token),
    hubEnv(reached),
  )
  assert.equal(response.status, 403, 'the pendant holds no mesh scope')
  /* 403 and not 401: the credential is real and was accepted. It is the scope
   * that is missing, and a test that could not tell those apart would pass
   * just as happily if the token lookup had silently broken. */
  const body = await response.json()
  assert.match(body.error, /may only open its own socket/)
  assert.equal(reached.length, 0)
})

test('the mesh socket refuses a missing deviceId, a bad token, and a plain GET', async () => {
  const reached = []
  assert.equal(
    (await handleNodeSocketUpgrade(socketRequest('', 'pdt_x.y'), hubEnv(reached)))
      .status,
    400,
  )
  assert.equal(
    (
      await handleNodeSocketUpgrade(
        socketRequest('node-a', 'pdt_notarealtoken.notarealsecret'),
        hubEnv(reached),
      )
    ).status,
    401,
  )
  assert.equal(
    (
      await handleNodeSocketUpgrade(
        socketRequest('node-a', 'anything', { upgrade: null }),
        hubEnv(reached),
      )
    ).status,
    426,
    'a plain GET must not be answered as if it were a socket',
  )
  assert.equal(
    (await handleNodeSocketUpgrade(socketRequest('node-a', 'anything'), {})).status,
    503,
    'no binding is a 503, not a silent success',
  )
  assert.equal(reached.length, 0)
})

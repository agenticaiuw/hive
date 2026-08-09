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
import { OWNERSHIP_DENIED_CODE, registerNodeMeshRoutes } from './nodeMailbox.js'
import {
  handleNodeSocketUpgrade,
  selectSubprotocol,
  upgradeCredential,
} from '../cloudflare-worker/bridgeHub.js'
import {
  BEARER_SUBPROTOCOL_PREFIX,
  MESH_SUBPROTOCOL,
} from '../shared/bridgeSocketProtocol.js'
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

/*
 * A BRIDGE_HUB that always answers — the DEPLOYED condition, where every
 * presence query reaches a Durable Object and comes back `observed:true`.
 *
 * The presence test that already existed ran with no binding at all, so it
 * only ever saw observed:false. That is the one arrangement in which the
 * unknown-node bug is invisible, which is why it survived: with a hub
 * reachable, a deviceId that was never paired and a node that is merely asleep
 * answer identically.
 *
 * idFromName is total, exactly as Cloudflare's is: it hashes a name into an
 * object id and cannot fail on a name nothing was ever registered under.
 */
function presenceHub({ connected = new Set() } = {}) {
  return {
    idFromName: (name) => name,
    get: (name) => ({
      async fetch() {
        return {
          json: async () => ({
            connected: connected.has(name),
            sockets: connected.has(name) ? 1 : 0,
            since: connected.has(name) ? '2026-08-08T11:00:00.000Z' : null,
          }),
        }
      },
    }),
  }
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

test('the ownership refusal carries a code, so no client keys on its wording', async () => {
  /*
   * Every other refusal on these routes names itself — scope_denied,
   * credential_predates_capability, unknown_node, inbox_full,
   * invalid_envelope. This one did not, and it is the likeliest real
   * misconfiguration of the lot (a wrong deviceId), so the one failure a
   * client most needs to explain was the one it could not classify. It had to
   * special-case the bare HTTP status instead, which stops working the moment
   * these routes grow a second kind of 403.
   *
   * Asserted as an EXACT string because switching on it is the entire point;
   * a match() would pass on a rename that breaks every consumer.
   */
  const store = await storeWithNodes(['victim', 'thief'])
  const stolen = await relayFor(devicePrincipal('thief'), store)

  const drain = await stolen.call('GET', '/v1/node/inbox?deviceId=victim')
  assert.equal(drain.status, 403)
  assert.equal(drain.body.code, 'not_your_inbox')

  const ack = await stolen.call('POST', '/v1/node/inbox/ack', {
    deviceId: 'victim',
    messageIds: ['nmsg_anything'],
  })
  assert.equal(ack.status, 403)
  assert.equal(ack.body.code, 'not_your_inbox')

  /* The exported constant and the wire value are the same string. A client
   * that imports it must not be reading a second, drifting copy. */
  assert.equal(OWNERSHIP_DENIED_CODE, 'not_your_inbox')
  assert.equal(drain.body.code, OWNERSHIP_DENIED_CODE)

  /*
   * And the code did NOT buy the prober anything the message was withheld
   * for. The denial stays deliberately vague — it must not name the inbox it
   * refused, or a token could enumerate the fleet one 403 at a time.
   */
  for (const body of [drain.body, ack.body]) {
    assert.ok(body.error, 'must still say something human')
    assert.ok(
      !JSON.stringify(body).includes('victim'),
      'the refusal must not echo the deviceId it protected',
    )
  }

  /* It is a DISTINCT code, not a generic one: a client switching on `code`
   * must land somewhere different from an unroutable send. */
  const unknown = await stolen.call('POST', '/v1/node/messages', {
    to: 'nobody-here',
    kind: 'test.a',
  })
  assert.equal(unknown.body.code, 'unknown_node')
  assert.notEqual(unknown.body.code, drain.body.code)

  await stolen.close()
})

test('presence tells "never paired" apart from "asleep", without touching observed', async () => {
  /*
   * THE bug: with a hub reachable, an unregistered deviceId answered
   * `connected:false, observed:true` — character for character what a real
   * node that is merely disconnected answers. A typo and a sleeping Mac are
   * opposite client behaviours: one is a device ID to correct, the other is
   * the normal resting state and should be rendered as nothing at all.
   *
   * The fix must be ADDITIVE. `observed:false` already means "we could not
   * ask" and clients are told never to draw that as a dead node; spending
   * that value on "there is nothing to ask about" would collapse a
   * distinction that is already load-bearing elsewhere.
   */
  setCloudflareBindings({ BRIDGE_HUB: presenceHub() })
  const store = await storeWithNodes(['node-a', 'node-b'])
  const relay = await relayFor(devicePrincipal('node-a'), store)

  const asleep = await relay.call('GET', '/v1/node/presence?deviceId=node-b')
  const neverPaired = await relay.call(
    'GET',
    '/v1/node/presence?deviceId=typo-node',
  )

  assert.equal(asleep.body.known, true)
  assert.equal(neverPaired.body.known, false)

  /*
   * The strongest form of "additive": the two answers differ in `known` and
   * in NOTHING else. That fails if the fix leaked into observed/connected,
   * and it fails if `known` is not actually the discriminator.
   */
  assert.deepEqual(
    { ...asleep.body, known: null, deviceId: null },
    { ...neverPaired.body, known: null, deviceId: null },
    'known must be the only field that separates a typo from a sleeping node',
  )
  assert.equal(asleep.body.observed, true, 'the hub answered for both')
  assert.equal(neverPaired.body.observed, true)
  assert.equal(asleep.body.connected, false)
  assert.equal(neverPaired.body.connected, false)

  /* A node that IS connected is still reported connected — the lookup did not
   * become a gate on the answer. */
  setCloudflareBindings({ BRIDGE_HUB: presenceHub({ connected: new Set(['node-b']) }) })
  const awake = await relay.call('GET', '/v1/node/presence?deviceId=node-b')
  assert.equal(awake.body.connected, true)
  assert.equal(awake.body.known, true)
  assert.equal(awake.body.sockets, 1)

  await relay.close()
})

test('presence keeps observed meaning "we could not ask", for a known node', async () => {
  /*
   * The third state, unchanged: no hub binding is the deployed relay during a
   * hub outage and every `npm run relay` on a laptop. A registered node in
   * that condition is `known:true, observed:false` — we know it exists and we
   * could not ask about it. Three independent facts, three fields.
   */
  setCloudflareBindings(null)
  const store = await storeWithNodes(['node-a', 'node-b'])
  const relay = await relayFor(devicePrincipal('node-a'), store)

  const cannotAsk = await relay.call('GET', '/v1/node/presence?deviceId=node-b')
  assert.equal(cannotAsk.body.known, true)
  assert.equal(cannotAsk.body.observed, false)
  assert.equal(cannotAsk.body.connected, false)

  /* Unknown AND unaskable is still legible: known:false is not derived from
   * observed, so it survives the hub being gone. */
  const neither = await relay.call('GET', '/v1/node/presence?deviceId=typo-node')
  assert.equal(neither.body.known, false)
  assert.equal(neither.body.observed, false)

  /* '@relay' is a real address the send route accepts and no device row will
   * ever hold. The two routes must not disagree about which addresses exist. */
  const relayAddress = await relay.call(
    'GET',
    `/v1/node/presence?deviceId=${encodeURIComponent('@relay')}`,
  )
  assert.equal(
    relayAddress.body.known,
    true,
    'the relay brain is an address you can send to, so it is not an unknown node',
  )

  await relay.close()
})

test('presence stays open to any principal, and stays gated on device:status:read', async () => {
  /*
   * Pinned because `known` is the first thing this route reveals that is not
   * about a live socket, and the temptation on review is to bolt
   * principalOwnsDevice onto it. That would break the feature the route
   * exists for: answering "is the Mac connected right now" from the phone.
   * The existence it now reports was already reachable through this route
   * (a connected node reports connected:true whoever asks) and through the
   * send route's unknown_node.
   */
  setCloudflareBindings({ BRIDGE_HUB: presenceHub({ connected: new Set(['node-b']) }) })
  const store = await storeWithNodes(['node-a', 'node-b'])
  const phone = await relayFor(devicePrincipal('node-a'), store)

  const other = await phone.call('GET', '/v1/node/presence?deviceId=node-b')
  assert.equal(other.status, 200, 'asking about another node is not a refusal')
  assert.equal(other.body.known, true)

  const { requiredScopesForRoute } = await import('./relayScopes.js')
  assert.deepEqual(requiredScopesForRoute('GET', '/v1/node/presence'), [
    'device:status:read',
  ])
  await phone.close()
})

/* ---- the socket upgrade ------------------------------------------------- */

function socketRequest(
  deviceId,
  token,
  { upgrade = 'websocket', via = 'header' } = {},
) {
  const headers = new Headers()
  if (upgrade) headers.set('Upgrade', upgrade)
  if (token && via === 'header') headers.set('Authorization', `Bearer ${token}`)
  if (token && via === 'subprotocol') {
    headers.set('Sec-WebSocket-Protocol', `pendant.mesh.v1, bearer.${token}`)
  }
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

test('a browser can authenticate the handshake, having no way to send a header', async () => {
  /*
   * The gap that made the mesh socket useless to the node it was built for: a
   * service worker's WebSocket constructor cannot set request headers. Its
   * only extension point is the subprotocol argument, so a header-only
   * handshake excluded the browser extension entirely.
   *
   * Same credential, same ownership rule, different channel.
   */
  const { getStore } = await import('./store/index.js')
  const sharedStore = await getStore()
  const { token, record } = createDeviceCredential({
    deviceId: 'browser-node-2',
    deviceType: 'browser_node',
  })
  await sharedStore.saveDeviceCredential(record)

  const reached = []
  const accepted = await handleNodeSocketUpgrade(
    socketRequest('browser-node-2', token, { via: 'subprotocol' }),
    hubEnv(reached),
  )
  assert.equal(accepted.status, HUB_REACHED_STATUS)
  assert.deepEqual(reached, ['browser-node-2'])

  /* And it is not a bypass: ownership still applies through this channel. */
  const wrongDevice = await handleNodeSocketUpgrade(
    socketRequest('phone-1', token, { via: 'subprotocol' }),
    hubEnv(reached),
  )
  assert.equal(wrongDevice.status, 403)
  assert.equal(reached.length, 1, 'the hub was not reached a second time')

  /* A junk subprotocol token is refused like any other junk token. */
  const junk = await handleNodeSocketUpgrade(
    socketRequest('browser-node-2', 'pdt_notreal.notreal', { via: 'subprotocol' }),
    hubEnv(reached),
  )
  assert.equal(junk.status, 401)
})

test('upgradeCredential reports the channel and never the secret', async () => {
  const { upgradeCredential } = await import('../cloudflare-worker/bridgeHub.js')

  const header = upgradeCredential(socketRequest('n', 'tok-abc', { via: 'header' }))
  assert.equal(header.source, 'header')
  assert.equal(header.authorization, 'Bearer tok-abc')

  const sub = upgradeCredential(
    socketRequest('n', 'tok-abc', { via: 'subprotocol' }),
  )
  assert.equal(sub.source, 'subprotocol')
  assert.equal(sub.authorization, 'Bearer tok-abc')

  const none = upgradeCredential(socketRequest('n', null))
  assert.equal(none.source, 'none')
  assert.equal(none.authorization, '')

  /* `source` is the thing that is safe to log. It must be a channel name and
   * must never contain the credential. */
  for (const result of [header, sub, none]) {
    assert.ok(!result.source.includes('tok-abc'))
  }
})

test('the worker negotiates with the SHARED subprotocol strings, not its own', async () => {
  /*
   * bridgeHub.js kept private literals for both of these until the shared
   * module grew them. That is the same latent disagreement bridgeSocketProtocol
   * warns about for the ping frame, one layer up — and it fails more quietly:
   * subprotocol negotiation is byte-exact, a browser closes any socket whose
   * handshake selected a name it did not offer, and nothing on either side
   * logs a reason. The symptom is "the extension cannot connect".
   *
   * Everything below is driven from the SHARED constants, so a drift of one
   * character in either copy fails this test instead of the fleet. Note that
   * the older tests in this file hardcode the strings, which is exactly why
   * they could not have caught it.
   */
  /* The exact two-offer handshake bridgeSocketProtocol documents, built from
   * the constants a client would import rather than retyped here. */
  const credentialled = new Request('https://relay.invalid/v1/node/socket', {
    headers: {
      'Sec-WebSocket-Protocol': `${MESH_SUBPROTOCOL}, ${BEARER_SUBPROTOCOL_PREFIX}tok-abc`,
    },
  })

  /* The name the server selects must be the one the client was told to offer. */
  assert.deepEqual(selectSubprotocol(credentialled), {
    'Sec-WebSocket-Protocol': MESH_SUBPROTOCOL,
  })

  /* And the credential is read off the shared prefix, not a private copy. */
  assert.deepEqual(upgradeCredential(credentialled), {
    authorization: 'Bearer tok-abc',
    source: 'subprotocol',
  })

  /* The mesh name is never mistaken for a credential, and the credential is
   * never echoed back — a selected bearer.* entry would put the token in the
   * RESPONSE headers, which is the reason there are two offers and not one. */
  const meshOnly = new Request('https://relay.invalid/v1/node/socket', {
    headers: { 'Sec-WebSocket-Protocol': MESH_SUBPROTOCOL },
  })
  assert.equal(upgradeCredential(meshOnly).source, 'none')
  assert.ok(
    !JSON.stringify(selectSubprotocol(credentialled)).includes('tok-abc'),
    'the selected protocol must never carry the token',
  )

  /* A client that offered nothing gets no header at all: RFC 6455 forbids
   * naming a protocol the client did not offer, and the Mac's header-
   * authenticated socket offers none. */
  const bare = new Request('https://relay.invalid/v1/node/socket')
  assert.equal(selectSubprotocol(bare), undefined)
  const wrongName = new Request('https://relay.invalid/v1/node/socket', {
    headers: { 'Sec-WebSocket-Protocol': 'pendant.mesh.v0' },
  })
  assert.equal(selectSubprotocol(wrongName), undefined)
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

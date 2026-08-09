/*
 * The switch, exercised against the real memory store rather than a stub, so
 * the lease/ack semantics under test are the ones a local `npm run relay`
 * actually runs. The hub binding is faked (there is no Durable Object in a
 * Node test process) and the fake counts sockets exactly the way BridgeHub
 * does, because "delivered" is the only thing that distinguishes a pushed
 * message from a parked one.
 *
 * No network, no credentials, no real deviceIds.
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createMemoryStore } from './store/memoryStore.js'
import { setCloudflareBindings } from './cloudflareBindings.js'
import {
  drainNodeInbox,
  INBOX_LEASE_MS,
  MAX_INBOX_DEPTH,
  nodePresence,
  resetNodeMailboxWarnings,
  sendNodeMessage,
} from './nodeMailbox.js'
import { MAX_INBOX_PAGE, RELAY_NODE_ADDRESS } from '../shared/nodeMesh.js'

const NOW = Date.parse('2026-08-08T12:00:00.000Z')

/** A BRIDGE_HUB stand-in. `connected` is the set of deviceIds holding a socket. */
function fakeHub({ connected = new Set(), onRing = () => {} } = {}) {
  const rings = []
  return {
    rings,
    connected,
    binding: {
      idFromName: (name) => name,
      get: (name) => ({
        async fetch(url, init = {}) {
          const path = new URL(url).pathname
          if (path === '/deliver') {
            const delivered = connected.has(name) ? 1 : 0
            rings.push({ name, delivered })
            onRing(name)
            return { json: async () => ({ ok: true, delivered }) }
          }
          if (path === '/presence') {
            return {
              json: async () => ({
                connected: connected.has(name),
                sockets: connected.has(name) ? 1 : 0,
                since: connected.has(name) ? '2026-08-08T11:00:00.000Z' : null,
              }),
            }
          }
          throw new Error(`unexpected hub path ${path}`)
        },
      }),
    },
  }
}

async function freshStore({ devices = ['node-a', 'node-b'] } = {}) {
  const store = createMemoryStore()
  for (const deviceId of devices) {
    await store.saveDevice({ deviceId, deviceType: 'mobile', name: deviceId })
  }
  return store
}

test.afterEach(() => {
  setCloudflareBindings(null)
  resetNodeMailboxWarnings()
})

test('a message to a connected node is pushed, not parked', async () => {
  const hub = fakeHub({ connected: new Set(['node-b']) })
  setCloudflareBindings({ BRIDGE_HUB: hub.binding })
  const store = await freshStore()

  const result = await sendNodeMessage({
    store,
    from: 'node-a',
    to: 'node-b',
    kind: 'test.ping',
    payload: { n: 1 },
    now: NOW,
  })

  assert.equal(result.pushed, true)
  assert.equal(result.queued, false)
  assert.deepEqual(hub.rings, [{ name: 'node-b', delivered: 1 }])
})

test('a message to a sleeping node is durably queued and delivered on reconnect', async () => {
  /* The whole point. The sender does not fail, does not block, and does not
   * hold the message in its own memory — where it would die with the sender. */
  const hub = fakeHub({ connected: new Set() })
  setCloudflareBindings({ BRIDGE_HUB: hub.binding })
  const store = await freshStore()

  const result = await sendNodeMessage({
    store,
    from: 'node-a',
    to: 'node-b',
    kind: 'test.ping',
    payload: { n: 1 },
    now: NOW,
  })
  assert.equal(result.pushed, false)
  assert.equal(result.queued, true)
  /* Rung anyway: presence is observed at the hub, not guessed by the sender. */
  assert.deepEqual(hub.rings, [{ name: 'node-b', delivered: 0 }])

  /* node-b wakes up nine minutes later and drains. */
  const { messages, pending } = await drainNodeInbox({
    store,
    deviceId: 'node-b',
    now: NOW + 9 * 60_000,
  })
  assert.equal(messages.length, 1)
  assert.equal(messages[0].payload.n, 1)
  assert.equal(messages[0].from, 'node-a')
  assert.equal(pending, 1, 'still pending until acknowledged')

  /*
   * NINE minutes, not sixty, and the first draft of this test said sixty and
   * failed. DEFAULT_TTL_MS is ten minutes, so a sender that wants its message
   * to survive a lunch break has to say so. That is the correct default —
   * most mesh traffic is an instruction whose moment passes — but it means
   * "durably queued" is bounded by the TTL the sender chose, not unbounded.
   */
  const patient = await freshStore()
  await sendNodeMessage({
    store: patient,
    from: 'node-a',
    to: 'node-b',
    kind: 'test.ping',
    ttlMs: 4 * 3_600_000,
    now: NOW,
  })
  const hoursLater = await drainNodeInbox({
    store: patient,
    deviceId: 'node-b',
    now: NOW + 3 * 3_600_000,
  })
  assert.equal(hoursLater.messages.length, 1)
})

test('the Mac is not in the path: the relay itself can address a node', async () => {
  const hub = fakeHub({ connected: new Set(['browser-node-1']) })
  setCloudflareBindings({ BRIDGE_HUB: hub.binding })
  const store = await freshStore({ devices: ['browser-node-1'] })

  const result = await sendNodeMessage({
    store,
    from: RELAY_NODE_ADDRESS,
    to: 'browser-node-1',
    kind: 'browser.tab.open',
    payload: { url: 'https://example.com' },
    now: NOW,
  })
  assert.equal(result.envelope.from, RELAY_NODE_ADDRESS)
  assert.equal(result.pushed, true)
})

test('and a node can address the relay brain', async () => {
  const hub = fakeHub()
  setCloudflareBindings({ BRIDGE_HUB: hub.binding })
  const store = await freshStore({ devices: ['node-a'] })

  /* '@relay' has no device row, and must not need one — the relay is a node
   * without a registration. */
  const result = await sendNodeMessage({
    store,
    from: 'node-a',
    to: RELAY_NODE_ADDRESS,
    kind: 'brain.ask',
    payload: { question: 'is the door locked' },
    now: NOW,
  })
  assert.equal(result.envelope.to, RELAY_NODE_ADDRESS)
  const { messages } = await drainNodeInbox({
    store,
    deviceId: RELAY_NODE_ADDRESS,
    now: NOW,
  })
  assert.equal(messages.length, 1)
})

test('an unregistered addressee is refused while the sender can still hear it', async () => {
  setCloudflareBindings({ BRIDGE_HUB: fakeHub().binding })
  const store = await freshStore({ devices: ['node-a'] })

  await assert.rejects(
    sendNodeMessage({
      store,
      from: 'node-a',
      to: 'node-typo',
      kind: 'test.ping',
      now: NOW,
    }),
    (error) => error.code === 'unknown_node',
  )
  /* Nothing was written: a typo must not leave a row nobody will ever drain. */
  assert.equal(await store.countPendingNodeMessages('node-typo'), 0)
})

test('a drained batch is leased, so a second drain cannot double-deliver', async () => {
  setCloudflareBindings({ BRIDGE_HUB: fakeHub().binding })
  const store = await freshStore()
  await sendNodeMessage({
    store, from: 'node-a', to: 'node-b', kind: 'test.a', now: NOW,
  })

  const first = await drainNodeInbox({ store, deviceId: 'node-b', now: NOW })
  assert.equal(first.messages.length, 1)

  /* A doorbell arriving mid-processing must not hand the same work over
   * twice — the receiver would run the side effect twice. */
  const second = await drainNodeInbox({ store, deviceId: 'node-b', now: NOW + 1_000 })
  assert.equal(second.messages.length, 0)

  /* But a node that crashed mid-batch gets it back when the lease lapses.
   * At-least-once: the alternative is silently losing the message. */
  const afterLease = await drainNodeInbox({
    store,
    deviceId: 'node-b',
    now: NOW + INBOX_LEASE_MS + 1,
  })
  assert.equal(afterLease.messages.length, 1)
})

test('acknowledging deletes, and only from your own inbox', async () => {
  setCloudflareBindings({ BRIDGE_HUB: fakeHub().binding })
  const store = await freshStore()
  const sent = await sendNodeMessage({
    store, from: 'node-a', to: 'node-b', kind: 'test.a', now: NOW,
  })

  /* node-a knows the id — it sent the message — and must still not be able to
   * reach into node-b's inbox with it. */
  assert.equal(await store.ackNodeMessages('node-a', [sent.envelope.id]), 0)
  assert.equal(await store.countPendingNodeMessages('node-b', { now: NOW }), 1)

  assert.equal(await store.ackNodeMessages('node-b', [sent.envelope.id]), 1)
  assert.equal(await store.countPendingNodeMessages('node-b', { now: NOW }), 0)
})

test('expired mail is never delivered and is swept', async () => {
  setCloudflareBindings({ BRIDGE_HUB: fakeHub().binding })
  const store = await freshStore()
  await sendNodeMessage({
    store, from: 'node-a', to: 'node-b', kind: 'test.a', ttlMs: 60_000, now: NOW,
  })

  const late = await drainNodeInbox({
    store, deviceId: 'node-b', now: NOW + 61_000,
  })
  assert.equal(late.messages.length, 0, 'a stale instruction must not arrive')
  assert.equal(
    await store.pruneExpiredNodeMessages({ now: NOW + 61_000 }),
    1,
  )
})

test('a full inbox is refused rather than growing D1 without bound', async () => {
  setCloudflareBindings({ BRIDGE_HUB: fakeHub().binding })
  const store = await freshStore()

  for (let index = 0; index < MAX_INBOX_DEPTH; index += 1) {
    await sendNodeMessage({
      store, from: 'node-a', to: 'node-b', kind: 'test.a', now: NOW + index,
    })
  }
  await assert.rejects(
    sendNodeMessage({
      store, from: 'node-a', to: 'node-b', kind: 'test.a', now: NOW,
    }),
    (error) => error.code === 'inbox_full',
  )
})

test('a drain returns at most one page and says how much is left', async () => {
  setCloudflareBindings({ BRIDGE_HUB: fakeHub().binding })
  const store = await freshStore()
  const total = MAX_INBOX_PAGE + 5
  for (let index = 0; index < total; index += 1) {
    await sendNodeMessage({
      store, from: 'node-a', to: 'node-b', kind: 'test.a', now: NOW + index,
    })
  }

  const page = await drainNodeInbox({ store, deviceId: 'node-b', now: NOW + total })
  assert.equal(page.messages.length, MAX_INBOX_PAGE)
  assert.equal(page.pending, total, 'leased is still pending until acked')
  /* Oldest first: a mesh that reordered instructions would be worse than one
   * that dropped them. */
  assert.equal(page.messages[0].payload.seq, undefined)
  assert.ok(
    page.messages[0].createdAt <= page.messages[1].createdAt,
  )
})

test('with no hub binding the send still persists — it just cannot ring', async () => {
  /* This is `npm run relay` on a laptop, and the deployed relay during a hub
   * outage. The message must survive both. */
  setCloudflareBindings(null)
  const store = await freshStore()
  const result = await sendNodeMessage({
    store, from: 'node-a', to: 'node-b', kind: 'test.a', now: NOW,
  })
  assert.equal(result.pushed, false)
  assert.equal(result.ring.reason, 'no_hub_binding')
  const drained = await drainNodeInbox({ store, deviceId: 'node-b', now: NOW })
  assert.equal(drained.messages.length, 1)
})

test('presence distinguishes "offline" from "we could not ask"', async () => {
  const hub = fakeHub({ connected: new Set(['node-b']) })
  setCloudflareBindings({ BRIDGE_HUB: hub.binding })
  assert.deepEqual(await nodePresence({ deviceId: 'node-b' }), {
    connected: true,
    sockets: 1,
    since: '2026-08-08T11:00:00.000Z',
    observed: true,
  })
  assert.equal((await nodePresence({ deviceId: 'node-a' })).connected, false)
  assert.equal((await nodePresence({ deviceId: 'node-a' })).observed, true)

  setCloudflareBindings(null)
  const unknown = await nodePresence({ deviceId: 'node-b' })
  assert.equal(unknown.connected, false)
  assert.equal(
    unknown.observed,
    false,
    'not knowing is not the same as knowing it is offline',
  )
})

test('retiring a device takes its undrained mail with it', async () => {
  setCloudflareBindings({ BRIDGE_HUB: fakeHub().binding })
  const store = await freshStore()
  await sendNodeMessage({
    store, from: 'node-a', to: 'node-b', kind: 'test.a', now: NOW,
  })
  assert.equal(await store.countPendingNodeMessages('node-b', { now: NOW }), 1)

  await store.deleteDevice('node-b')
  assert.equal(await store.getDevice('node-b'), null)
  assert.equal(
    await store.countPendingNodeMessages('node-b', { now: NOW }),
    0,
    'an inbox nothing will ever drain is not storage, it is a leak',
  )
})

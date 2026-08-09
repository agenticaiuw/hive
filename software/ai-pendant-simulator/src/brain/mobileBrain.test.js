/*
 * The loop, driven by a scripted model.
 *
 * `infer` is a function, so the whole brain runs with no network, no API key
 * and no relay — which is the point of the seam in relayInference.js. Every
 * test here is about the loop's own behaviour: does it observe before it
 * concludes, does it widen when asked, and — the one that matters most — does
 * the confirmation gate open ONLY when the model opens it.
 *
 * No filesystem, no network, no workspace: everything here is pure.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

import { DEVICE_SCOPES } from '../../cloud-relay/deviceAuth.js'
/* The relay's route → scope table, imported rather than transcribed, for the
 * same reason mobileDiscovery.test.js imports DEVICE_SCOPES: a tool declaring a
 * scope its route does not require is invisible on a credential that happens to
 * hold both. */
import { requiredScopesForRoute } from '../../cloud-relay/relayScopes.js'
import {
  buildBrainSystemPrompt,
  describeSituation,
  fitMessagesToBudget,
  PROMPT_SCHEMA_BUDGET,
  runMobileBrain,
} from './mobileBrain.js'
import {
  bufferedMeshMail,
  createMeshListener,
  drainMeshInbox,
  resetMeshMailbox,
} from './meshMailbox.js'
import { buildMobileCatalogue, renderFullSchema, toolsForDomains } from './mobileDiscovery.js'
import { extractJsonObject, INFERENCE_LIMITS, parseModelJson } from './relayInference.js'
import { MOBILE_TOOLS, MOBILE_TOOL_TYPES } from './mobileTools.js'
import {
  BRIDGE_MAIL_FRAME,
  BRIDGE_PING_FRAME,
  MESH_SUBPROTOCOL,
} from '../../shared/bridgeSocketProtocol.js'

/** A model that says exactly what the script says, in order. */
function scriptedModel(...answers) {
  const seen = []
  const infer = async ({ messages }) => {
    seen.push(messages.map((message) => ({ role: message.role, content: message.content })))
    const next = answers.shift()
    if (next === undefined) throw new Error('the script ran out of answers')
    return { content: typeof next === 'string' ? next : JSON.stringify(next), model: 'test-model' }
  }
  infer.seen = seen
  infer.remaining = () => answers.length
  return infer
}

/** A cloud client stub: only the methods the tools under test actually call. */
function stubClient(overrides = {}) {
  return {
    async readSharedState() {
      return { nodes: [{ id: 'mac', status: 'down', reason: 'lid shut' }] }
    },
    async bridgePresence() {
      return { ok: true, connected: false }
    },
    async deviceStatus() {
      return { ok: true, devices: [{ deviceId: 'home-macbook-bridge', deviceType: 'mac_bridge', online: false }] }
    },
    ...overrides,
  }
}

/*
 * The mesh dedupe ledger and the socket buffer are module scope — they have to
 * be, because at-least-once redelivery crosses tool calls and a per-call ledger
 * would dedupe nothing. That makes them shared state between tests, so every
 * mesh test starts by clearing them. One test leaking an envelope id into the
 * next would show up as "the duplicate was filtered", which is exactly the
 * assertion it would be silently faking.
 */
test.beforeEach(() => {
  resetMeshMailbox()
})

/*
 * A WebSocket that does nothing until told to. The listener is a state machine
 * over four events, and driving it with a real socket would make every test
 * about the network instead of about the machine.
 */
function fakeSocket() {
  const listeners = new Map()
  let resolveOpened = null
  const handedOver = new Promise((resolve) => {
    resolveOpened = resolve
  })
  return {
    protocol: MESH_SUBPROTOCOL,
    sent: [],
    send(frame) {
      this.sent.push(frame)
    },
    close() {
      this.closed = true
    },
    addEventListener(type, handler) {
      listeners.set(type, handler)
      /* Every handler is attached in one synchronous block after the await in
       * connect(), so the last one is the signal that wiring is finished. */
      if (type === 'error') resolveOpened?.()
    },
    emit(type, event = {}) {
      listeners.get(type)?.(event)
    },
    opened: () => handedOver,
  }
}

/* Let the listener's own awaits run. It drains without anyone awaiting it —
 * that is the point of a doorbell — so a test has to yield rather than await. */
const settle = () => new Promise((resolve) => setTimeout(resolve, 0))

/* One envelope, in the shape the relay really returns — verified in
 * production against GET /v1/node/inbox on 2026-08-09. */
function envelope(overrides = {}) {
  const createdAt = overrides.createdAt ?? new Date().toISOString()
  return {
    v: 1,
    id: 'nmsg_TVrhgP2jcIVoaG7laKMdYw',
    from: 'home-macbook-bridge',
    to: 'mobile-test',
    kind: 'ios.notify',
    payload: { text: 'the build finished' },
    corr: null,
    createdAt,
    expiresAt: new Date(Date.parse(createdAt) + 600_000).toISOString(),
    ...overrides,
  }
}

const baseCtx = () => ({
  client: stubClient(),
  deviceId: 'mobile-test',
  platform: 'test',
  navigator: { onLine: true, language: 'en-US' },
})

test('the loop observes, then answers from what it saw', async () => {
  const infer = scriptedModel(
    { status: 'act', say: 'Checking the hive.', actions: [{ tool: 'hive_read', label: 'read hive', params: { key: 'hive' } }] },
    { status: 'done', say: 'Your Mac is down — the lid is shut.' },
  )

  const phases = []
  const outcome = await runMobileBrain({
    command: 'is my mac awake?',
    infer,
    ctx: baseCtx(),
    onProgress: (event) => phases.push(event.phase),
    confirm: async () => {
      throw new Error('confirm must not be called when the model did not ask')
    },
  })

  assert.equal(outcome.status, 'done')
  assert.match(outcome.say, /lid is shut/)
  assert.equal(outcome.steps.length, 1)
  assert.equal(outcome.steps[0].tool, 'hive_read')
  assert.equal(outcome.steps[0].ok, true)
  assert.equal(outcome.turns, 2)
  assert.equal(outcome.usage.calls, 2)
  assert.ok(phases.includes('tool'))
  assert.ok(phases.includes('done'))

  /* The second call must have seen the tool result — otherwise it "concluded"
   * from nothing, which is the failure this whole loop exists to prevent. */
  const secondCall = infer.seen[1]
  assert.match(secondCall.at(-1).content, /Tool results/)
  assert.match(secondCall.at(-1).content, /hive_read/)
})

test('confirmation happens only when the model asks for it', async () => {
  const asked = []
  const infer = scriptedModel(
    {
      status: 'act',
      say: 'One moment.',
      requiresConfirmation: true,
      confirmReason: 'I also want to save this as a note for later — you did not ask for that.',
      actions: [{ tool: 'memory_save', label: 'save note', params: { name: 'x', observations: 'y' } }],
    },
    { status: 'done', say: 'Saved.' },
  )

  const outcome = await runMobileBrain({
    command: 'remember my wifi password is on the fridge',
    infer,
    ctx: {
      ...baseCtx(),
      client: stubClient({
        async getProductState() {
          return { sessions: [], memory: { entities: [], relations: [] }, revision: 1 }
        },
        async saveProductState(state) {
          return state
        },
      }),
    },
    confirm: async (request) => {
      asked.push(request)
      return true
    },
  })

  assert.equal(asked.length, 1)
  assert.match(asked[0].reason, /you did not ask for that/)
  assert.equal(asked[0].actions[0].tool, 'memory_save')
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.steps.length, 1)
})

test('declining does not run the step, and the model is told so it can adapt', async () => {
  const infer = scriptedModel(
    {
      status: 'act',
      requiresConfirmation: true,
      confirmReason: 'I want to also open the link.',
      actions: [{ tool: 'phone_open_url', label: 'open', params: { url: 'https://example.com' } }],
    },
    { status: 'done', say: 'Left it closed.' },
  )

  let opened = 0
  const outcome = await runMobileBrain({
    command: 'what is on my clipboard',
    infer,
    ctx: { ...baseCtx(), openUrl: () => { opened += 1 } },
    confirm: async () => false,
  })

  assert.equal(opened, 0, 'a declined action still ran')
  assert.equal(outcome.steps.length, 0)
  assert.match(infer.seen[1].at(-1).content, /declined/i)
})

test('with no confirm callback an ask is a decline, never a silent yes', async () => {
  const infer = scriptedModel(
    {
      status: 'act',
      requiresConfirmation: true,
      confirmReason: 'extra step',
      actions: [{ tool: 'phone_open_url', label: 'open', params: { url: 'https://example.com' } }],
    },
    { status: 'done', say: 'ok' },
  )
  let opened = 0
  const outcome = await runMobileBrain({
    command: 'anything',
    infer,
    ctx: { ...baseCtx(), openUrl: () => { opened += 1 } },
    confirm: null,
  })
  assert.equal(opened, 0)
  assert.equal(outcome.steps.length, 0)
})

test('nothing deterministic gates a tool the model did not flag', async () => {
  /* The standing policy: no per-tool guardrails. A tool that opens a URL on the
   * owner's screen runs without a confirm callback ever being consulted, if the
   * model judged it to be what the owner asked for. */
  let opened = null
  const infer = scriptedModel(
    { status: 'act', actions: [{ tool: 'phone_open_url', label: 'open', params: { url: 'https://example.com/x' } }] },
    { status: 'done', say: 'Opened it.' },
  )
  const outcome = await runMobileBrain({
    command: 'open example.com',
    infer,
    ctx: { ...baseCtx(), openUrl: (url) => { opened = url } },
    confirm: async () => {
      throw new Error('confirm must not be consulted for an unflagged action')
    },
  })
  assert.equal(opened, 'https://example.com/x')
  assert.equal(outcome.steps[0].ok, true)
})

test('need_tools widens the prompt instead of ending the turn', async () => {
  /* Force the drill-down path with a budget of zero, so the pre-pass runs and
   * the first planning prompt really is a subset. */
  const infer = scriptedModel(
    { domains: ['phone'] }, // level-1 pre-pass
    { status: 'need_tools', domains: ['mac'] },
    { status: 'done', say: 'Got them.' },
  )

  const opened = []
  const outcome = await runMobileBrain({
    command: 'ask the mac something',
    infer,
    ctx: baseCtx(),
    schemaBudget: 0,
    onProgress: (event) => {
      if (event.phase === 'discover_tools') opened.push(event.message)
    },
  })

  assert.equal(outcome.status, 'done')
  const firstPlanPrompt = infer.seen[1][0].content
  const widenedPrompt = infer.seen[2][0].content

  assert.ok(!firstPlanPrompt.includes('mac_run'), 'mac was never actually withheld')
  assert.ok(widenedPrompt.includes('mac_run'), 'the ask did not widen the prompt')
  /* And widening ADDS: the shelf it already had is still there. */
  assert.ok(widenedPrompt.includes('phone_status'), 'widening took a shelf away')
  assert.match(infer.seen[2].at(-1).content, /now in your system prompt/i)
  assert.deepEqual(opened, ['Opened: phone', 'Opened: phone, mac'])
})

test('asking for a domain that does not exist opens everything rather than looping', async () => {
  const infer = scriptedModel(
    { domains: ['phone'] },
    { status: 'need_tools', domains: ['telepathy'] },
    { status: 'done', say: 'fine' },
  )
  const outcome = await runMobileBrain({
    command: 'x',
    infer,
    ctx: baseCtx(),
    schemaBudget: 0,
  })
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.usage.calls, 3)
  /* Every tool is on the table now, not just the one shelf it started with. */
  assert.ok(infer.seen[2][0].content.includes('mac_run'))
})

test('asking for tools when every shelf is already open does not narrow the prompt', async () => {
  const infer = scriptedModel(
    { status: 'need_tools', domains: ['mac'] },
    { status: 'done', say: 'fine' },
  )
  const outcome = await runMobileBrain({ command: 'x', infer, ctx: baseCtx() })
  assert.equal(outcome.status, 'done')
  /* The system prompt is untouched — narrowing to the named shelf would take
   * tools away as a reward for asking for more. */
  assert.equal(infer.seen[0][0].content, infer.seen[1][0].content)
  assert.match(infer.seen[1].at(-1).content, /already in your system prompt/i)
})

test('a failing tool is a result to reason about, not an exception', async () => {
  const infer = scriptedModel(
    { status: 'act', actions: [{ tool: 'hive_read', label: 'read', params: { key: 'hive' } }] },
    { status: 'done', say: 'The relay would not answer, so I could not check.' },
  )

  const outcome = await runMobileBrain({
    command: 'check the hive',
    infer,
    ctx: {
      ...baseCtx(),
      client: stubClient({
        async readSharedState() {
          throw new Error('relay unreachable')
        },
      }),
    },
  })

  assert.equal(outcome.status, 'done')
  assert.equal(outcome.steps[0].ok, false)
  assert.match(outcome.steps[0].error, /relay unreachable/)
  assert.match(infer.seen[1].at(-1).content, /relay unreachable/)
})

test('an unknown tool name comes back with the real ones', async () => {
  const infer = scriptedModel(
    { status: 'act', actions: [{ tool: 'summon_helicopter', label: 'nope', params: {} }] },
    { status: 'done', say: 'That is not something I can do.' },
  )
  const outcome = await runMobileBrain({ command: 'x', infer, ctx: baseCtx() })
  assert.equal(outcome.steps[0].ok, false)
  assert.match(outcome.steps[0].error, /No such tool/)
  assert.match(infer.seen[1].at(-1).content, /No such tool/)
})

test('invalid JSON costs one turn, not the request', async () => {
  const infer = scriptedModel(
    'I think I should check the hive first!',
    { status: 'done', say: 'Recovered.' },
  )
  const outcome = await runMobileBrain({ command: 'x', infer, ctx: baseCtx() })
  assert.equal(outcome.status, 'done')
  assert.match(infer.seen[1].at(-1).content, /not valid JSON/)
})

test('the loop stops at maxSteps and says so instead of inventing an ending', async () => {
  const spin = { status: 'act', actions: [{ tool: 'phone_status', label: 'look', params: {} }] }
  const infer = scriptedModel(spin, spin, spin)
  const outcome = await runMobileBrain({
    command: 'loop forever',
    infer,
    ctx: baseCtx(),
    maxSteps: 3,
  })
  assert.equal(outcome.status, 'exhausted')
  assert.equal(outcome.turns, 3)
  assert.equal(outcome.steps.length, 3)
  assert.match(outcome.say, /did not finish/)
})

test('"act" with no actions but an answer is treated as the answer', async () => {
  const infer = scriptedModel({ status: 'act', say: 'It is 4pm.', actions: [] })
  const outcome = await runMobileBrain({ command: 'time?', infer, ctx: baseCtx() })
  assert.equal(outcome.status, 'done')
  assert.equal(outcome.say, 'It is 4pm.')
})

test('unsupported carries the reason to the owner', async () => {
  const infer = scriptedModel({ status: 'unsupported', error: 'this phone has no camera tool' })
  const outcome = await runMobileBrain({ command: 'take a photo', infer, ctx: baseCtx() })
  assert.equal(outcome.status, 'unsupported')
  assert.match(outcome.say, /no camera tool/)
})

/* ---------------------------------------------------------------- the mesh */

test('a queued mesh message is reported as waiting, not as a failure', async () => {
  const sends = []
  const infer = scriptedModel(
    {
      status: 'act',
      actions: [
        {
          tool: 'mesh_send',
          label: 'tell the browser',
          params: { to: 'browser-node-1', kind: 'browser.tab.open', payload: { url: 'https://example.com' } },
        },
      ],
    },
    { status: 'done', say: 'Your browser is not connected, so it is waiting for it.' },
  )

  const outcome = await runMobileBrain({
    command: 'open example.com in my browser',
    infer,
    ctx: {
      ...baseCtx(),
      client: stubClient({
        async sendNodeMessage(request) {
          sends.push(request)
          /* The relay's real 202 body when nothing was holding a socket. */
          return {
            ok: true,
            messageId: 'nmsg_r_obOCK4v9Uru5CA3rgWeQ',
            to: request.to,
            from: 'mobile-test',
            expiresAt: '2026-08-09T04:19:28.591Z',
            pushed: false,
            queued: true,
          }
        },
      }),
    },
  })

  assert.equal(outcome.status, 'done')
  assert.equal(sends.length, 1)
  /* `from` is never sent: the relay stamps it and ignores a body-supplied one,
   * so putting it on the wire would only imply it means something. */
  assert.equal(Object.hasOwn(sends[0], 'from'), false)
  assert.equal(sends[0].kind, 'browser.tab.open')

  const result = outcome.steps[0].result
  assert.equal(outcome.steps[0].ok, true)
  assert.equal(result.delivered, false)
  assert.match(result.note, /holding it until/)
  /* And the model saw that distinction rather than a bare "ok". */
  assert.match(infer.seen[1].at(-1).content, /not connected/)
})

test('mesh mail is deduped across drains, because delivery is at-least-once', async () => {
  /* The same envelope twice: a lease that lapsed before the ack landed. That is
   * not an error condition, it is the contract, and the model must be shown the
   * message exactly once or it will act on it twice. */
  const acked = []
  const client = stubClient({
    async drainNodeInbox() {
      return { ok: true, messages: [envelope()], pending: 1, leaseMs: 60000 }
    },
    async ackNodeMessages(deviceId, messageIds) {
      acked.push(messageIds)
      return { ok: true, acknowledged: messageIds.length, pending: 0 }
    },
  })

  const first = await drainMeshInbox({ client, deviceId: 'mobile-test' })
  const second = await drainMeshInbox({ client, deviceId: 'mobile-test' })

  assert.equal(first.messages.length, 1)
  assert.equal(second.messages.length, 0, 'a redelivered envelope was reported as new mail')
  assert.equal(second.duplicates.length, 1)
  /* Both drains ack. An ack for something already deleted is a no-op, and
   * skipping it would leave the duplicate to come back every lease forever. */
  assert.equal(acked.length, 2)
})

test('`pending` counts the page it just leased you, so `more` is the honest field', async () => {
  /* Measured in production: a drain that returned one message came back with
   * pending: 1, and only after the ack did it read 0. A caller that loops on
   * `pending > 0` never stops. */
  const client = stubClient({
    async drainNodeInbox() {
      return { ok: true, messages: [envelope()], pending: 1, leaseMs: 60000 }
    },
    async ackNodeMessages() {
      return { ok: true, acknowledged: 1, pending: 0 }
    },
  })
  const drained = await drainMeshInbox({ client, deviceId: 'mobile-test' })
  assert.equal(drained.pending, 1)
  assert.equal(drained.more, false, 'the drainer would have looped on its own leased page')
})

test('a failed ack still hands over the mail it already drained', async () => {
  const client = stubClient({
    async drainNodeInbox() {
      return { ok: true, messages: [envelope()], pending: 1, leaseMs: 60000 }
    },
    async ackNodeMessages() {
      throw new Error('relay unreachable')
    },
  })
  const drained = await drainMeshInbox({ client, deviceId: 'mobile-test' })
  assert.equal(drained.messages.length, 1, 'the mail was thrown away over a failed ack')
  assert.equal(drained.acknowledged, 0)
})

test('mesh_inbox reads what the socket already drained, so a doorbell never eats mail', async () => {
  /* The listener drains and acks on its own — that is what makes mail arrive
   * rather than be found. If the tool only asked the relay, everything the
   * socket pulled down would be gone by the time the model looked. */
  const socket = fakeSocket()
  const client = stubClient({
    async openNodeSocket() {
      return socket
    },
    async drainNodeInbox() {
      return { ok: true, messages: [envelope()], pending: 1, leaseMs: 60000 }
    },
    async ackNodeMessages() {
      return { ok: true, acknowledged: 1, pending: 0 }
    },
  })

  const stop = createMeshListener({ client, deviceId: 'mobile-test' })
  await socket.opened()
  socket.emit('open')
  await settle()
  stop()

  assert.equal(bufferedMeshMail(), 1, 'the doorbell drained nothing on connect')

  const infer = scriptedModel(
    { status: 'act', actions: [{ tool: 'mesh_inbox', label: 'read mail', params: {} }] },
    { status: 'done', say: 'The Mac says the build finished.' },
  )
  const outcome = await runMobileBrain({ command: 'anything for me?', infer, ctx: { ...baseCtx(), client } })

  const result = outcome.steps[0].result
  assert.equal(result.count, 1)
  assert.equal(result.messages[0].from, 'home-macbook-bridge')
  assert.equal(result.messages[0].payload.text, 'the build finished')
  assert.equal(bufferedMeshMail(), 0, 'the buffer was read but not emptied')
})

test('reading without acking names the ids that will come back', async () => {
  /* The only reason to read without acking is that you might not survive to
   * act, so the ids have to come back with the mail — otherwise the model has
   * left a batch leased with no way to name it. */
  const infer = scriptedModel(
    { status: 'act', actions: [{ tool: 'mesh_inbox', label: 'peek', params: { ack: false } }] },
    { status: 'done', say: 'One message is waiting.' },
  )
  const outcome = await runMobileBrain({
    command: 'peek at my mail',
    infer,
    ctx: {
      ...baseCtx(),
      client: stubClient({
        async drainNodeInbox() {
          return { ok: true, messages: [envelope()], pending: 1, leaseMs: 60000 }
        },
        async ackNodeMessages() {
          throw new Error('mesh_inbox acked despite ack:false')
        },
      }),
    },
  })
  const result = outcome.steps[0].result
  assert.deepEqual(result.unacknowledged, [envelope().id])
  assert.match(result.note, /arrive again/)
})

test('the doorbell drains on connect and on every mail frame, and pings the exact bytes', async () => {
  const drains = []
  const socket = fakeSocket()
  const client = stubClient({
    async openNodeSocket(deviceId, options) {
      socket.openedWith = { deviceId, options }
      return socket
    },
    async drainNodeInbox() {
      drains.push(Date.now())
      return { ok: true, messages: [], pending: 0, leaseMs: 60000 }
    },
    async ackNodeMessages() {
      return { ok: true, acknowledged: 0, pending: 0 }
    },
  })

  let ping = null
  const stop = createMeshListener({
    client,
    deviceId: 'mobile-test',
    /* Run the ping immediately rather than waiting 55 s of wall clock. */
    setIntervalImpl: (fn) => {
      ping = fn
      return 1
    },
    clearIntervalImpl: () => {},
  })
  await socket.opened()
  socket.emit('open')
  await settle()

  /* Mail queued while this node was disconnected rang a doorbell nobody heard,
   * so connecting has to drain even though no frame said to. */
  assert.equal(drains.length, 1, 'connecting did not drain')

  socket.emit('message', { data: BRIDGE_MAIL_FRAME })
  await settle()
  assert.equal(drains.length, 2)

  /* Anything that is not a mail frame must not cause a drain — the pong is
   * answered by Cloudflare's hibernation layer and means nothing here. */
  socket.emit('message', { data: '{"type":"pong"}' })
  socket.emit('message', { data: 'not json at all' })
  await settle()
  assert.equal(drains.length, 2)

  ping?.()
  assert.deepEqual(socket.sent, [BRIDGE_PING_FRAME], 'the ping is byte-matched by the relay')
  stop()
})

test('stopping mid-handshake closes the socket that arrives late', async () => {
  /* React unmounts faster than a WebSocket handshake, and StrictMode does it on
   * purpose. A socket that resolves after the stop would otherwise keep its
   * listeners, its ping interval and its reconnect loop, with nothing holding a
   * reference that could close it. */
  const socket = fakeSocket()
  let handOver = null
  const client = stubClient({
    openNodeSocket: () =>
      new Promise((resolve) => {
        handOver = () => resolve(socket)
      }),
  })

  const stop = createMeshListener({ client, deviceId: 'mobile-test' })
  await settle()
  stop()
  handOver()
  await settle()

  assert.equal(socket.closed, true, 'a socket that arrived after the stop was left open')
  assert.deepEqual(socket.sent, [])
})

test('an unpaired phone gets no doorbell and no exception', async () => {
  /* The socket is the optional half. A phone that cannot open one still has the
   * durable inbox over HTTP, so this must degrade to a status line. */
  const states = []
  const client = stubClient({
    async openNodeSocket() {
      throw new Error('This phone is not paired, so it cannot open a mesh socket.')
    },
  })
  const stop = createMeshListener({
    client,
    deviceId: 'mobile-test',
    onStatus: (event) => states.push(event.state),
    setTimeoutImpl: () => 1,
    clearTimeoutImpl: () => {},
  })
  await settle()
  stop()
  assert.ok(states.includes('unavailable'), `saw ${JSON.stringify(states)}`)
  assert.ok(states.includes('reconnecting'), 'a failed connect did not schedule a retry')
})

test('presence that could not be observed is never reported as offline', async () => {
  const infer = scriptedModel(
    { status: 'act', actions: [{ tool: 'mesh_presence', label: 'check', params: { deviceId: 'home-macbook-bridge' } }] },
    { status: 'done', say: 'I could not check whether your Mac is connected.' },
  )
  const outcome = await runMobileBrain({
    command: 'is my mac connected?',
    infer,
    ctx: {
      ...baseCtx(),
      client: stubClient({
        async nodePresence(deviceId) {
          /* The relay's honest "I could not ask": connected:false and
           * observed:false arrive together, in the same shape as a genuine
           * disconnection. Only `observed` tells them apart. */
          return { ok: true, deviceId, connected: false, sockets: 0, since: null, observed: false, pending: 0 }
        },
      }),
    },
  })

  const result = outcome.steps[0].result
  assert.equal(result.connected, false)
  assert.equal(result.observed, false)

  /* The rule that stops the model turning that into "your Mac is offline" must
   * be in the prompt whenever mesh_presence is. */
  const prompt = infer.seen[0][0].content
  assert.match(prompt, /"observed": false means the relay could not reach/)
  assert.match(prompt, /does NOT mean the node is offline/)
})

test('mesh rules ship only when a mesh tool did', () => {
  const catalogue = buildMobileCatalogue()
  const withoutMesh = buildBrainSystemPrompt({
    schemaText: '(schema)',
    toolNames: toolsForDomains(['phone'], { catalogue }),
    situation: 'now',
  })
  assert.ok(!withoutMesh.includes('observed'), 'a mesh rule shipped with no mesh tool loaded')
  assert.ok(!withoutMesh.includes('mesh_presence'), 'a rule named a tool that was not loaded')
})

test('a narrowed credential is told apart from a denial by code, all the way to the model', async () => {
  /* A credential minted with an explicit `scopes` ceiling keeps that ceiling
   * forever. A phone narrowed to a list without node:message:* 403s until it
   * is re-paired with a wider list — and re-pairing is the opposite of the
   * advice a `scope_denied` deserves. The two differ only in `code`, so the
   * code has to survive the tool boundary and reach the model. */
  const denial = new Error(
    'Blocked for safety: this credential is narrowed to a subset of its role and does not carry node:message:send.',
  )
  denial.code = 'credential_predates_capability'
  denial.status = 403

  const infer = scriptedModel(
    {
      status: 'act',
      actions: [{ tool: 'mesh_send', label: 'send', params: { to: '@relay', kind: 'ios.notify', payload: {} } }],
    },
    { status: 'done', say: 'This phone needs re-pairing before it can message other nodes.' },
  )
  const outcome = await runMobileBrain({
    command: 'tell the relay hello',
    infer,
    ctx: {
      ...baseCtx(),
      client: stubClient({
        async sendNodeMessage() {
          throw denial
        },
      }),
    },
  })

  assert.equal(outcome.steps[0].ok, false)
  assert.equal(outcome.steps[0].code, 'credential_predates_capability')
  const shown = infer.seen[1].at(-1).content
  assert.match(shown, /credential_predates_capability/)
  assert.ok(!shown.includes('scope_denied'))
})

test('the mesh tools ask for exactly the scopes those relay routes require', () => {
  /* Not a transcription of the brief — the relay's own route table, imported.
   * `/v1/node/presence` is the one that surprises: it is gated on
   * device:status:read, the same audience as /v1/devices/status, NOT on
   * node:message:receive. Declaring the wrong scope would be invisible on a
   * `mobile` credential (it holds both) and would silently withhold the tool
   * from any role that holds one and not the other. */
  const routeScopes = {
    mesh_send: requiredScopesForRoute('POST', '/v1/node/messages'),
    mesh_inbox: requiredScopesForRoute('GET', '/v1/node/inbox'),
    mesh_ack: requiredScopesForRoute('POST', '/v1/node/inbox/ack'),
    mesh_presence: requiredScopesForRoute('GET', '/v1/node/presence'),
  }
  for (const [tool, required] of Object.entries(routeScopes)) {
    assert.deepEqual(
      MOBILE_TOOLS[tool].needs,
      required,
      `${tool} declares scopes the relay does not actually require for its route`,
    )
  }
})

test('the mesh socket is opened with the handshake a WKWebView can emit', async () => {
  /* A WebSocket constructor in a WebView cannot set a request header, so the
   * credential rides as a subprotocol offer and NEVER in the query string,
   * which is what gets logged. Verified against production on 2026-08-09: two
   * offers, no Authorization header, and the server selected the plain mesh
   * name rather than echoing the bearer entry back in a response header. */
  const { createCloudClient } = await import('../cloudClient.js')
  const opened = []
  class FakeSocket {
    constructor(url, protocols) {
      opened.push({ url, protocols })
    }
  }
  const client = createCloudClient({
    relayUrl: 'https://relay.example',
    mobileDeviceId: 'mobile-test',
    deviceCredential: { token: 'pdt_fake.secret', role: 'mobile', scopes: [], tokenId: 'fake' },
  })
  await client.openNodeSocket('mobile-test', { WebSocketImpl: FakeSocket })

  const [handshake] = opened
  assert.match(handshake.url, /^wss:\/\/relay\.example\/v1\/node\/socket\?deviceId=mobile-test$/)
  assert.ok(!handshake.url.includes('pdt_'), 'the token was put in the URL, which is what gets logged')
  assert.equal(handshake.protocols.length, 2, 'one offer would make the server echo the token back')
  assert.equal(handshake.protocols[0], MESH_SUBPROTOCOL)
  assert.match(handshake.protocols[1], /^bearer\./)
})

/* ------------------------------------------------------------- the prompt */

test('the prompt carries only tools it was actually given', () => {
  const catalogue = buildMobileCatalogue()
  const phoneOnly = toolsForDomains(['phone'], { catalogue })
  const prompt = buildBrainSystemPrompt({
    schemaText: '(schema)',
    toolNames: phoneOnly,
    otherDomains: ['mac', 'hive'],
    blocked: [],
    situation: 'now',
  })

  /* The mac rules name mac tools. With no mac tool loaded they must not ship —
   * a prompt that tells the model to "check mac_status first" while giving it
   * no mac_status is advertising a capability it does not have. */
  assert.ok(!prompt.includes('mac_status'), 'a rule named a tool that was not loaded')
  assert.ok(!prompt.includes('mac_run'), 'a rule named a tool that was not loaded')
  /* But the escape hatch must be there, naming the shelves held back. */
  assert.match(prompt, /need_tools/)
  assert.match(prompt, /mac, hive/)
})

test('the prompt names no tool that is not in the catalogue', () => {
  /* The standing rule: never hardcode a capability list into a prompt. The only
   * tool names allowed in the prompt body are ones the executor really has. */
  const catalogue = buildMobileCatalogue()
  const everyTool = [...catalogue.tools.keys()]
  const prompt = buildBrainSystemPrompt({
    schemaText: renderFullSchema({ catalogue }),
    toolNames: everyTool,
    situation: 'now',
  })
  const known = new Set(MOBILE_TOOL_TYPES)
  for (const candidate of prompt.match(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g) ?? []) {
    if (known.has(candidate)) continue
    /* Everything else that looks like a tool name must be a JSON field or a
     * status word from the contract, not an invented capability. */
    assert.ok(
      ['need_tools', 'requiresConfirmation', 'confirmReason', 'json_object'].includes(candidate),
      `prompt names "${candidate}", which is not a tool the executor has`,
    )
  }
})

test('a blocked tool is explained by scope, not silently missing', () => {
  const catalogue = buildMobileCatalogue({ scopes: [] })
  const prompt = buildBrainSystemPrompt({
    schemaText: renderFullSchema({ catalogue }),
    toolNames: [...catalogue.tools.keys()],
    blocked: catalogue.blocked,
    situation: 'now',
  })
  assert.match(prompt, /missing relay scope/)
  assert.match(prompt, /re-pair the phone/)
})

test('the situation block states facts and never guesses', () => {
  const offline = describeSituation({
    now: new Date('2026-08-08T12:00:00Z'),
    navigator: { onLine: false },
    credential: { role: 'mobile' },
    platform: 'ios',
  })
  assert.match(offline, /NO network/)
  assert.match(offline, /role "mobile"/)
  assert.match(offline, /ios/)

  /* A platform that reports nothing must not produce a claim either way. */
  const unknown = describeSituation({ navigator: {}, credential: null })
  assert.ok(!/network/i.test(unknown), 'invented a network claim from nothing')
  assert.ok(!/role/i.test(unknown), 'invented a pairing claim from nothing')
})

test('the whole schema fits the prompt budget today, and the budget is measured', () => {
  const catalogue = buildMobileCatalogue({ scopes: [...DEVICE_SCOPES.mobile] })
  const chars = renderFullSchema({ catalogue }).length
  console.log(`[measured] full mobile schema ${chars} chars vs budget ${PROMPT_SCHEMA_BUDGET}`)
  assert.ok(
    chars <= PROMPT_SCHEMA_BUDGET,
    `the phone's schema is ${chars} chars, past the ${PROMPT_SCHEMA_BUDGET} budget — the drill-down path now runs on every turn, which costs a round trip. Either raise the budget deliberately or split a domain.`,
  )
})

/* ------------------------------------------------------- the prompt budget */

test('the thread is fitted to the relay ceilings, keeping the schema and the request', () => {
  const messages = [
    { role: 'system', content: 'SCHEMA' },
    { role: 'user', content: 'THE REQUEST' },
    ...Array.from({ length: 20 }, (_, i) => ({ role: 'user', content: `obs ${i} ${'x'.repeat(200)}` })),
  ]
  const fitted = fitMessagesToBudget(messages, { maxMessages: 8, maxChars: 100000 })

  assert.ok(fitted.length <= 8)
  assert.equal(fitted[0].content, 'SCHEMA', 'the tool schema was dropped')
  assert.equal(fitted[1].content, 'THE REQUEST', "the owner's request was dropped")
  assert.match(fitted[2].content, /dropped to stay inside/)
  /* What survives is the NEWEST working memory, not the oldest. */
  assert.match(fitted.at(-1).content, /obs 19/)
})

test('a character overflow drops messages rather than cutting one in half', () => {
  const messages = [
    { role: 'system', content: 'S'.repeat(100) },
    { role: 'user', content: 'R'.repeat(100) },
    { role: 'user', content: 'A'.repeat(5000) },
    { role: 'user', content: 'B'.repeat(5000) },
  ]
  const fitted = fitMessagesToBudget(messages, { maxMessages: 40, maxChars: 5500 })
  for (const message of fitted) {
    assert.ok(
      messages.some((original) => original.content === message.content) ||
        /dropped to stay inside/.test(message.content),
      'a message was truncated instead of dropped',
    )
  }
})

test('a thread already inside the budget is passed through untouched', () => {
  const messages = [
    { role: 'system', content: 'S' },
    { role: 'user', content: 'R' },
  ]
  assert.equal(fitMessagesToBudget(messages), messages)
})

test('the loop never asks for more tokens than the relay allows', async () => {
  let seen = null
  const infer = async ({ maxTokens }) => {
    seen = maxTokens
    return { content: JSON.stringify({ status: 'done', say: 'ok' }) }
  }
  await runMobileBrain({ command: 'x', infer, ctx: baseCtx() })
  assert.ok(seen <= INFERENCE_LIMITS.maxTokens, `asked for ${seen} tokens`)
})

/* -------------------------------------------- what a 403 is actually saying */

test('a narrowed credential and a genuine denial are told apart by code, not prose', async () => {
  const { createRelayInference, InferenceUnavailableError } = await import('./relayInference.js')

  const clientAnswering = (status, payload) => ({
    async postJson() {
      return { response: { status, ok: false, headers: { get: () => null } }, payload }
    },
  })

  /* Re-pairing with a wider scope list fixes this one — the role grants it,
   * this credential's pair-time ceiling leaves it out. */
  const stale = createRelayInference({
    client: clientAnswering(403, {
      ok: false,
      code: 'credential_predates_capability',
      error:
        'Blocked for safety: this credential is narrowed to a subset of its role and does not carry llm:infer.',
    }),
  })
  await assert.rejects(
    () => stale({ messages: [{ role: 'user', content: 'x' }] }),
    (error) => {
      assert.ok(error instanceof InferenceUnavailableError)
      assert.equal(error.code, 'credential_predates_capability')
      assert.equal(error.staleCredential, true, 'the UI cannot offer a re-pair without this')
      assert.match(error.message, /Re-pair the phone/)
      return true
    },
  )

  /* Re-pairing does NOT fix this one, and saying so would send the owner in
   * circles. The role itself has to change. */
  const denied = createRelayInference({
    client: clientAnswering(403, { ok: false, code: 'scope_denied', error: 'Blocked for safety.' }),
  })
  await assert.rejects(
    () => denied({ messages: [{ role: 'user', content: 'x' }] }),
    (error) => {
      assert.equal(error.code, 'scope_denied')
      assert.equal(error.staleCredential, false)
      assert.match(error.message, /Re-pairing will not help/)
      return true
    },
  )

  /* An older relay sends no code, and then both really are possible. */
  const oldRelay = createRelayInference({ client: clientAnswering(404, {}) })
  await assert.rejects(
    () => oldRelay({ messages: [{ role: 'user', content: 'x' }] }),
    (error) => {
      assert.equal(error.code, null)
      assert.match(error.message, /Either the relay has no inference route/)
      return true
    },
  )
})

/* --------------------------------------------------------- JSON extraction */

test('JSON survives fences, preamble and braces inside strings', () => {
  assert.deepEqual(parseModelJson('{"status":"done"}'), { status: 'done' })
  assert.deepEqual(parseModelJson('```json\n{"status":"done"}\n```'), { status: 'done' })
  assert.deepEqual(parseModelJson('Sure! {"status":"done"} — hope that helps'), { status: 'done' })
  assert.deepEqual(
    parseModelJson('{"say":"use {curly} braces","status":"done"}'),
    { say: 'use {curly} braces', status: 'done' },
  )
  assert.deepEqual(
    parseModelJson('{"say":"he said \\"{\\" once","status":"done"}'),
    { say: 'he said "{" once', status: 'done' },
  )
  assert.deepEqual(parseModelJson('{"a":{"b":{"c":1}}}'), { a: { b: { c: 1 } } })
})

test('JSON extraction says what it saw when it fails', () => {
  assert.throws(() => extractJsonObject('no object here'), /did not return JSON/)
  assert.throws(() => extractJsonObject('{"unterminated": true'), /unterminated/)
})

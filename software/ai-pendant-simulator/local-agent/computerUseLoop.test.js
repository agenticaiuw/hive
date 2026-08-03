import assert from 'node:assert/strict'
import test from 'node:test'
import {
  buildObservationTurn,
  elideOldImages,
  gateAction,
  LOOP_ALLOWED_ACTIONS,
  parseReply,
  resolveActionCoordinates,
  runComputerUseTask,
} from './computerUseLoop.js'

const DATA_URL = 'data:image/jpeg;base64,/9j/4AAQSkZJRg=='

const CAPTURE = {
  id: 'obs-1',
  display: { index: 1, x: 0, y: 0, w: 1440, h: 900, backingScale: 2 },
  region: { x: 0, y: 0, w: 1440, h: 900 },
  image: { width: 1456, height: 910, bytes: 210_000 },
  scale: { x: 1440 / 1456, y: 900 / 910 },
  sha256: 'abc',
  imageBase64: '/9j/4AAQSkZJRg==',
  mediaType: 'image/jpeg',
}

function makeDeps(replies, overrides = {}) {
  const queue = [...replies]
  const executed = []
  const requested = []

  return {
    executed,
    requested,
    deps: {
      requestMessages: async ({ messages, hasImages }) => {
        requested.push({ messages: structuredCloneish(messages), hasImages })
        return queue.shift() ?? JSON.stringify({ status: 'done', response: 'ran out of replies' })
      },
      execute: async (actions) => {
        executed.push(...actions)
        return actions.map((action) => ({ action, ok: true, status: 'success', message: 'ok' }))
      },
      capture: async () => ({ ...CAPTURE }),
      snapshot: async () => ({ app: 'TestApp', semanticAvailable: false, elements: [] }),
      cursor: async () => ({ x: 0, y: 0 }),
      displays: async () => [{ index: 1, x: 0, y: 0, w: 1440, h: 900, scale: 2, main: true }],
      sleep: async () => {},
      ...overrides,
    },
  }
}

// A snapshot whose contents change every call, so the no-progress detector does
// not fire in tests that are about something else.
function changingSnapshot() {
  let counter = 0
  return async () => ({
    app: 'TestApp',
    semanticAvailable: true,
    elements: [
      {
        ref: `0/${(counter += 1)}`,
        role: 'AXButton',
        title: `Button ${counter}`,
        x: 10,
        y: 10,
        w: 40,
        h: 20,
        centerX: 30,
        centerY: 20,
        offscreen: false,
      },
    ],
  })
}

test('the image message uses the OpenAI content-array shape with a base64 data URL', () => {
  const turn = buildObservationTurn(
    { text: 'Finder: nothing semantic', dataUrl: DATA_URL },
    3,
  )

  assert.equal(turn.role, 'user')
  assert.ok(Array.isArray(turn.content))
  // Text first: that ordering is what OpenRouter parses most reliably.
  assert.equal(turn.content[0].type, 'text')
  assert.match(turn.content[0].text, /^Step 3\./)
  assert.deepEqual(turn.content[1], {
    type: 'image_url',
    image_url: { url: DATA_URL, detail: 'high' },
  })
})

test('a text-only observation stays a plain string message', () => {
  const turn = buildObservationTurn({ text: 'Finder: 12 elements', dataUrl: null }, 1)

  assert.equal(typeof turn.content, 'string')
})

test('only the most recent images are carried in the message history', () => {
  const messages = []

  for (let step = 1; step <= 6; step += 1) {
    messages.push(buildObservationTurn({ text: `obs ${step}`, dataUrl: DATA_URL }, step))
  }

  elideOldImages(messages, 3)

  const withImages = messages.filter(
    (message) =>
      Array.isArray(message.content) && message.content.some((part) => part.type === 'image_url'),
  )

  assert.equal(withImages.length, 3)
  assert.match(messages[0].content[0].text, /screenshot elided/)
  // The elided turn keeps its text so the model still knows what it looked at.
  assert.match(messages[0].content[0].text, /obs 1/)
})

test('shell, file and mail actions are structurally unreachable from the loop', () => {
  for (const type of [
    'run_shell',
    'run_applescript',
    'run_project',
    'write_file',
    'delete_path',
    'move_path',
    'copy_path',
    'send_email',
    'create_note',
  ]) {
    assert.equal(LOOP_ALLOWED_ACTIONS.has(type), false, `${type} must not be loop-reachable`)

    const gate = gateAction(
      { type },
      { observation: { dataUrl: DATA_URL }, mutations: 0, maxMutations: 10, unnamedClicks: 0, maxUnnamedClicks: 5 },
    )

    assert.equal(gate.ok, false)
    assert.match(gate.message, /not available inside a computer-use task/)
  }
})

test('a pixel click is refused until the step actually has a screenshot', () => {
  const context = {
    observation: { dataUrl: null },
    allowPixelFallback: false,
    mutations: 0,
    maxMutations: 10,
    unnamedClicks: 0,
    maxUnnamedClicks: 5,
  }

  assert.equal(gateAction({ type: 'mouse_click' }, context).ok, false)
  // Naming a control needs no image at all, so it stays allowed.
  assert.equal(gateAction({ type: 'ui_click' }, context).ok, true)
  assert.equal(
    gateAction({ type: 'mouse_click' }, { ...context, observation: { dataUrl: DATA_URL } }).ok,
    true,
  )
})

test('the mutation cap and the unnamed-click cap both close the gate', () => {
  const base = {
    observation: { dataUrl: DATA_URL },
    mutations: 15,
    maxMutations: 15,
    unnamedClicks: 0,
    maxUnnamedClicks: 5,
  }

  assert.match(gateAction({ type: 'ui_click' }, base).message, /Mutation cap reached/)
  assert.match(
    gateAction({ type: 'mouse_click' }, { ...base, mutations: 0, unnamedClicks: 5 }).message,
    /unnamed controls/,
  )
})

test('normalized model coordinates are converted through the observation ratio', () => {
  const resolved = resolveActionCoordinates(
    { type: 'mouse_click', params: { nx: 499.5, ny: 499.5 } },
    { capture: CAPTURE },
  )

  assert.equal(resolved.params.x, 720)
  assert.equal(resolved.params.y, 450)
  assert.equal(resolved.params.nx, undefined)
})

test('normalized coordinates without a screenshot are refused', () => {
  assert.throws(
    () => resolveActionCoordinates({ type: 'mouse_click', params: { nx: 10, ny: 10 } }, {}),
    /no screenshot was taken/,
  )
})

test('the loop stops at the step cap instead of running forever', async () => {
  const replies = Array.from({ length: 50 }, () =>
    JSON.stringify({ status: 'continue', thought: 'again', actions: [{ type: 'ui_snapshot' }] }),
  )
  const { deps, executed } = makeDeps(replies, { snapshot: changingSnapshot() })

  const result = await runComputerUseTask({ goal: 'never finish', maxSteps: 4 }, deps)

  assert.equal(result.ok, false)
  assert.equal(result.reason, 'step_cap')
  assert.equal(result.stepsUsed, 4)
  assert.equal(executed.length, 4)
  assert.match(result.message, /4-step cap/)
})

test('maxSteps cannot be raised past the env-capped ceiling', async () => {
  const { deps } = makeDeps([JSON.stringify({ status: 'done', response: 'fine' })], {
    snapshot: changingSnapshot(),
  })

  const result = await runComputerUseTask({ goal: 'x', maxSteps: 100000 }, deps)

  assert.ok(result.maxSteps <= 25)
})

test('the loop stops when the screen stops changing', async () => {
  const replies = Array.from({ length: 20 }, () =>
    JSON.stringify({ status: 'continue', actions: [{ type: 'ui_snapshot' }] }),
  )
  // A snapshot that never changes: the classic "clicking a dead pixel forever".
  const { deps } = makeDeps(replies, {
    snapshot: async () => ({
      app: 'TestApp',
      semanticAvailable: true,
      elements: [
        { ref: '0/0', role: 'AXButton', title: 'Stuck', x: 0, y: 0, w: 10, h: 10, centerX: 5, centerY: 5, offscreen: false },
      ],
    }),
  })

  const result = await runComputerUseTask({ goal: 'stuck', maxSteps: 20 }, deps)

  assert.equal(result.reason, 'no_progress')
  assert.ok(result.stepsUsed < 20)
})

test('the wall-clock budget ends the loop even while steps remain', async () => {
  let clock = 0
  const replies = Array.from({ length: 20 }, () =>
    JSON.stringify({ status: 'continue', actions: [{ type: 'ui_snapshot' }] }),
  )
  const { deps } = makeDeps(replies, {
    snapshot: changingSnapshot(),
    now: () => (clock += 400),
  })

  const result = await runComputerUseTask({ goal: 'slow', maxSteps: 20, budgetMs: 1000 }, deps)

  assert.equal(result.reason, 'budget_exhausted')
  assert.ok(result.stepsUsed < 20)
})

test('status done ends the loop successfully', async () => {
  const { deps } = makeDeps(
    [JSON.stringify({ status: 'done', response: 'Preferences are open.' })],
    { snapshot: changingSnapshot() },
  )

  const result = await runComputerUseTask({ goal: 'open preferences' }, deps)

  assert.equal(result.ok, true)
  assert.equal(result.reason, 'done')
  assert.equal(result.message, 'Preferences are open.')
  assert.equal(result.stepsUsed, 1)
})

test('status ask and status blocked both stop and hand back to the user', async () => {
  const asked = await runComputerUseTask(
    { goal: 'x' },
    makeDeps([JSON.stringify({ status: 'ask', question: 'Which account?' })], {
      snapshot: changingSnapshot(),
    }).deps,
  )
  assert.equal(asked.reason, 'ask')
  assert.equal(asked.message, 'Which account?')

  const blocked = await runComputerUseTask(
    { goal: 'x' },
    makeDeps([JSON.stringify({ status: 'blocked', reason: 'Needs a shell command.' })], {
      snapshot: changingSnapshot(),
    }).deps,
  )
  assert.equal(blocked.reason, 'blocked')
  assert.equal(blocked.message, 'Needs a shell command.')
})

test('the assistant turn is replayed verbatim, not re-serialized', async () => {
  const raw = '{"status":"continue","thought":"look","actions":[{"type":"ui_snapshot"}]}'
  const { deps, requested } = makeDeps(
    [raw, JSON.stringify({ status: 'done', response: 'ok' })],
    { snapshot: changingSnapshot() },
  )

  await runComputerUseTask({ goal: 'x', maxSteps: 2 }, deps)

  const assistantTurns = requested[1].messages.filter((message) => message.role === 'assistant')
  assert.equal(assistantTurns.length, 1)
  assert.equal(assistantTurns[0].content, raw)
})

test('images are only requested when the accessibility tree is unusable', async () => {
  let captures = 0
  const { deps, requested } = makeDeps(
    [JSON.stringify({ status: 'done', response: 'ok' })],
    {
      snapshot: changingSnapshot(),
      capture: async () => {
        captures += 1
        return { ...CAPTURE }
      },
    },
  )

  await runComputerUseTask({ goal: 'x' }, deps)

  assert.equal(captures, 0)
  assert.equal(requested[0].hasImages, false)
})

test('an empty accessibility tree escalates to a screenshot automatically', async () => {
  const { deps, requested } = makeDeps([JSON.stringify({ status: 'done', response: 'ok' })])

  await runComputerUseTask({ goal: 'x' }, deps)

  assert.equal(requested[0].hasImages, true)
})

test('image bytes never appear in the loop result', async () => {
  const { deps } = makeDeps([JSON.stringify({ status: 'done', response: 'ok' })])

  const result = await runComputerUseTask({ goal: 'x' }, deps)

  assert.equal(JSON.stringify(result).includes(CAPTURE.imageBase64), false)
  assert.equal(result.observations[0].hadImage, true)
})

test('a malformed model reply is rejected rather than acted on', () => {
  assert.throws(() => parseReply(''), /empty step/)
  assert.throws(() => parseReply('I will click the button'), /did not return a JSON step/)
  // Prose-wrapped JSON is still recoverable.
  assert.equal(parseReply('Sure!\n{"status":"done"}\nDone.').status, 'done')
  // An unknown status degrades to "continue" rather than terminating silently.
  assert.equal(parseReply('{"status":"explode"}').status, 'continue')
  assert.deepEqual(parseReply('{"actions":[{"noType":1}]}').actions, [])
})

test('an aborted job stops the loop', async () => {
  const replies = Array.from({ length: 10 }, () =>
    JSON.stringify({ status: 'continue', actions: [{ type: 'ui_snapshot' }] }),
  )
  const { deps } = makeDeps(replies, {
    snapshot: changingSnapshot(),
    throwIfAborted: () => {
      throw new Error('Cancelled from dashboard')
    },
  })

  await assert.rejects(() => runComputerUseTask({ goal: 'x' }, deps), /Cancelled/)
})

function structuredCloneish(value) {
  return JSON.parse(JSON.stringify(value))
}

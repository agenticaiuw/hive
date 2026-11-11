import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import { LOOP_ALLOWED_ACTIONS } from './computerUseLoop.js'
import { getLedger, openLedger } from './actionLedger.js'
import { VISION_LOOP_SOURCE, planVisionLoop, runVisionLoop, visionLoopStatus } from './visionLoop.js'
import {
  MENU_ACTIVATION,
  PRESS_FALLBACK,
  VISION_LOOP_VOCABULARY,
  admitStep,
  describePolicy,
  describeStep,
  requirementsFor,
  unclassifiedGeneralLoopActions,
} from './visionLoopPolicy.js'
import { preflight } from './visionLoopPreflight.js'
import { explainStep, narrateRun, recentActions, undoPosition } from './visionLoopHistory.js'
import {
  KNOWN_STATES,
  buildDigest,
  classifyUiState,
  describeOffload,
  digestElement,
} from './visionLoopRelay.js'

function sandbox() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vision-loop-'))
  return { root, filePath: path.join(root, 'ledger.json') }
}

/* The machine this was written on: both grants denied, both switches off.
 * Every test that wants a different world says so explicitly. */
const DENIED = {
  accessibility: { trusted: false, detail: 'Enable Accessibility for AI Pendant Agent' },
  screenRecording: { granted: false, detail: 'Screen Recording permission missing' },
}

const GRANTED = {
  accessibility: { trusted: true, detail: 'Accessibility is granted' },
  screenRecording: { granted: false, detail: 'Screen Recording permission missing' },
}

const HOST = {
  bundleId: 'com.aipendant.agent',
  bundlePath: '/Users/owner/Applications/AI Pendant Agent.app',
  execPath: '/Users/owner/Applications/AI Pendant Agent.app/Contents/MacOS/node',
  source: 'app-bundle Info.plist',
}

const gateWith = (overrides = {}) =>
  preflight({
    readPermissions: async () => DENIED,
    reachability: { status: 'unverified' },
    loopEnabled: () => false,
    uploadConsented: () => false,
    host: HOST,
    hostApp: 'AI Pendant Agent',
    ...overrides,
  })

const readySteps = [
  { type: 'ui_wait_for', params: { title: 'Send' } },
  { type: 'ui_click', params: { title: 'Send' } },
]

/* Mirrors focusCoordinator.runFocusSafePlan's onStep contract exactly, the same
 * way actionLedger.test.js does: `start` is awaited before the executor sees the
 * action, `done` after it answers. If that contract changes, the fallback
 * detector finds out here. */
function fakeFocusSafePlan(results) {
  return async (actions, { execute, onStep }) => {
    const out = []
    for (const [seq, action] of actions.entries()) {
      await onStep?.({ phase: 'start', seq, action })
      await execute([action])
      const result = results[seq] ?? { action, ok: true, status: 'success', message: 'ok' }
      out.push(result)
      await onStep?.({ phase: 'done', seq, action, result })
    }
    return { results: out, receipt: { ok: true, status: 'completed', ranSteps: out.length } }
  }
}

// ---------------------------------------------------------------- vocabulary

test('every action the general computer-use loop allows is either in the vocabulary or excluded with a reason', () => {
  /* The drift guard. A new action type added to computerUseLoop cannot arrive
   * here unclassified — someone has to decide which side of the line it is on,
   * and this fails until they do. */
  assert.deepEqual(unclassifiedGeneralLoopActions(), [])

  for (const type of VISION_LOOP_VOCABULARY) {
    assert.ok(LOOP_ALLOWED_ACTIONS.has(type), `${type} must also be executable by the general loop`)
  }
})

test('nothing that touches pixels, the pointer, the keyboard or the foreground is admissible', () => {
  const forbidden = [
    'screenshot',
    'zoom',
    'mouse_click',
    'mouse_move',
    'mouse_drag',
    'scroll',
    'type_text',
    'press_keys',
    'ui_hit_test',
    'open_app',
  ]

  for (const type of forbidden) {
    const verdict = admitStep({ type, params: {} })
    assert.equal(verdict.ok, false, `${type} must not be admissible`)
    assert.equal(verdict.category, 'takes-over-screen-or-focus')
    /* A refusal without a sentence is a shrug. */
    assert.ok(verdict.reason.length > 40, `${type} needs a real reason`)
  }
})

test('the loop needs Accessibility and explicitly does not need Screen Recording', () => {
  for (const type of VISION_LOOP_VOCABULARY) {
    const requirements = requirementsFor(type)
    assert.deepEqual(requirements.grants, ['accessibility'])
    assert.deepEqual(requirements.doesNotNeed, ['screenRecording'])
  }

  const policy = describePolicy()
  assert.deepEqual(policy.needs.map((grant) => grant.grant), ['accessibility'])
  assert.deepEqual(policy.doesNotNeed.map((grant) => grant.grant), ['screenRecording'])
})

test('the one hole in the promise is declared, not hidden', () => {
  // ui_click can degrade to a real mouse click inside the Swift helper.
  assert.equal(requirementsFor('ui_click').pressFallback, PRESS_FALLBACK)
  assert.equal(PRESS_FALLBACK.detectableBy.includes('method:"mouse"'), true)
  // ui_snapshot cannot: it only reads.
  assert.equal(requirementsFor('ui_snapshot').pressFallback, null)
  // Whether ui_menu activates the app is unmeasured, and says so.
  assert.equal(MENU_ACTIVATION.status, 'unverified')
})

// --------------------------------------------------------------------- plan

test('a plan that does not name an app is refused outright', () => {
  for (const app of ['', '   ', 'frontmost', 'Frontmost']) {
    const plan = planVisionLoop({ goal: 'send it', app, steps: readySteps })
    assert.equal(plan.ok, false)
    assert.equal(plan.rejected[0].category, 'no-target-app')
    assert.deepEqual(plan.actions, [])
  }
})

test('every admitted step is aimed at the named app rather than inheriting frontmost', () => {
  const plan = planVisionLoop({ goal: 'send the draft', app: 'Mail', steps: readySteps })

  assert.equal(plan.ok, true)
  assert.equal(plan.app, 'Mail')
  // uiControl defaults every one of these calls to app: 'frontmost', so an
  // omitted name is not neutral — it is the takeover spelled as an absence.
  for (const action of plan.actions) assert.equal(action.params.app, 'Mail')
  assert.equal(plan.focus.foregroundBound, 0)
  assert.equal(plan.focus.addressed, plan.actions.length)
})

test('one unreachable step rejects the whole plan, not just that step', () => {
  const plan = planVisionLoop({
    goal: 'fill the form',
    app: 'Safari',
    steps: [
      { type: 'ui_click', params: { title: 'Name' } },
      { type: 'type_text', params: { text: 'Evan' } },
      { type: 'ui_click', params: { title: 'Submit' } },
    ],
  })

  assert.equal(plan.ok, false)
  assert.deepEqual(plan.actions, [], 'a partial plan is how a refusal becomes a silent degradation')
  assert.equal(plan.rejected.length, 1)
  assert.equal(plan.rejected[0].type, 'type_text')
  assert.match(plan.rejected[0].reason, /keyboard focus/i)
})

test('the plan describes what it would do in sentences, before anything can run', () => {
  const plan = planVisionLoop({
    goal: 'send the draft',
    app: 'Mail',
    steps: [{ type: 'ui_click', params: { title: 'Send' } }],
  })

  assert.equal(plan.steps[0].does.includes('“Send”'), true)
  assert.equal(plan.steps[0].does.includes('Mail'), true)
  assert.equal(plan.steps[0].readOnly, false)
  assert.equal(plan.writes, 1)
  assert.equal(plan.pressFallbackRisk, PRESS_FALLBACK)
})

// ---------------------------------------------------------------- preflight

test('on this machine the preflight blocks, names the exact binary, and does not call Screen Recording a blocker', async () => {
  const gate = await gateWith()

  assert.equal(gate.ok, false)
  assert.equal(gate.status, 'blocked')

  const accessibility = gate.grants.find((entry) => entry.grant === 'accessibility')
  assert.equal(accessibility.held, false)
  assert.equal(accessibility.required, true)
  // Per-binary trust is the part that actually goes wrong.
  assert.match(accessibility.ownerAction, /AI Pendant Agent/)
  assert.match(accessibility.ownerAction, /AI Pendant Agent\.app/)
  assert.match(gate.target.note, /per-binary/i)

  const screen = gate.grants.find((entry) => entry.grant === 'screenRecording')
  assert.equal(screen.required, false)
  assert.equal(
    gate.blockedOn.some((entry) => entry.name === 'screenRecording'),
    false,
    'Screen Recording is denied and irrelevant; listing it would send the owner to the wrong checkbox',
  )

  // Nothing here is obtainable from inside the process.
  for (const blocker of gate.blockedOn) assert.equal(blocker.grantableFromHere, false)
})

test('an unmeasured permission blocks and is reported as unmeasured, not as denied', async () => {
  const gate = await gateWith({
    readPermissions: async () => {
      throw new Error('osascript unavailable')
    },
    loopEnabled: () => true,
  })

  assert.equal(gate.ok, false)
  const accessibility = gate.grants.find((entry) => entry.grant === 'accessibility')
  assert.equal(accessibility.held, false)
  assert.equal(accessibility.measured, null)
  assert.match(accessibility.detail, /unreadable/i)
})

test('a process that reports itself trusted while events do not arrive is treated as not granted', async () => {
  const gate = await gateWith({
    readPermissions: async () => GRANTED,
    reachability: { status: 'failed' },
    loopEnabled: () => true,
  })

  assert.equal(gate.ok, false)
  const accessibility = gate.grants.find((entry) => entry.grant === 'accessibility')
  assert.match(accessibility.measured, /disagree/)
  assert.match(accessibility.detail, /different binary/)
})

test('the loop switch is required and vision-upload consent is not', async () => {
  const withSwitchOff = await gateWith({
    readPermissions: async () => GRANTED,
    reachability: { status: 'verified' },
    loopEnabled: () => false,
  })
  assert.equal(withSwitchOff.ok, false)
  assert.equal(withSwitchOff.blockedOn[0].kind, 'switch')

  const ready = await gateWith({
    readPermissions: async () => GRANTED,
    reachability: { status: 'verified' },
    loopEnabled: () => true,
    // Still false, and the gate still opens: the loop never needs an upload.
    uploadConsented: () => false,
  })
  assert.equal(ready.ok, true)
  assert.equal(ready.status, 'ready')
  assert.match(ready.summary, /Screen Recording is still denied and is not needed/)
})

// ---------------------------------------------------------------------- run

test('a blocked run never calls the executor, never opens a ledger, and says what it would have done', async () => {
  const box = sandbox()
  let executeCalls = 0
  let ledgersOpened = 0

  const plan = planVisionLoop({ goal: 'send the draft', app: 'Mail', steps: readySteps })
  const outcome = await runVisionLoop(plan, {
    execute: async () => {
      executeCalls += 1
      return [{ ok: true }]
    },
    preflightImpl: () => gateWith(),
    openLedgerImpl: (...args) => {
      ledgersOpened += 1
      return openLedger(...args)
    },
    ledgerPath: box.filePath,
  })

  // The claim that decays unless it is a counter.
  assert.equal(executeCalls, 0)
  assert.equal(outcome.dispatched, 0)
  assert.equal(outcome.executed, false)
  assert.equal(outcome.status, 'blocked-on-grant')

  /* A blocked attempt must not be written down as an open ledger:
   * interruptedLedgers() reads an open ledger as a run that did not get to
   * finish, and a pile of never-started runs would bury the one real one. */
  assert.equal(ledgersOpened, 0)
  assert.equal(outcome.ledgerId, null)
  assert.equal(fs.existsSync(box.filePath), false)

  // And it reports precisely what it would have done.
  assert.deepEqual(
    outcome.wouldRun.map((step) => step.type),
    ['ui_wait_for', 'ui_click'],
  )
  assert.equal(outcome.wouldTouch.app, 'Mail')
  assert.equal(outcome.wouldTouch.presses, 1)
  assert.match(outcome.summary, /Nothing was dispatched/)
})

test('an invalid plan is not blamed on the permission state', async () => {
  let preflights = 0
  const outcome = await runVisionLoop(planVisionLoop({ app: '', steps: readySteps }), {
    preflightImpl: () => {
      preflights += 1
      return gateWith()
    },
  })

  assert.equal(outcome.status, 'invalid-plan')
  assert.equal(preflights, 0, 'a bad plan must not be reported as blocked on a grant')
})

test('once the grant lands the run writes a manifest first, dispatches, and closes it', async () => {
  const box = sandbox()
  const dispatched = []

  const plan = planVisionLoop({ goal: 'send the draft', app: 'Mail', steps: readySteps })
  const outcome = await runVisionLoop(plan, {
    execute: async ([action]) => {
      /* The ordering invariant actionLedger rests on: the manifest exists and
       * the step is already recorded before the executor sees it. */
      const ledgers = JSON.parse(fs.readFileSync(box.filePath, 'utf8')).ledgers
      dispatched.push({ type: action.type, ledgerExists: ledgers.length === 1 })
      return [{ action, ok: true, status: 'success', message: 'ok', method: 'press' }]
    },
    preflightImpl: () =>
      gateWith({
        readPermissions: async () => GRANTED,
        reachability: { status: 'verified' },
        loopEnabled: () => true,
      }),
    runPlanImpl: fakeFocusSafePlan([]),
    ledgerPath: box.filePath,
  })

  assert.equal(outcome.executed, true)
  assert.equal(outcome.dispatched, 2)
  assert.deepEqual(dispatched.map((entry) => entry.type), ['ui_wait_for', 'ui_click'])
  assert.deepEqual(dispatched.map((entry) => entry.ledgerExists), [true, true])

  const manifest = getLedger(outcome.ledgerId, { filePath: box.filePath })
  assert.equal(manifest.source, VISION_LOOP_SOURCE)
  assert.equal(manifest.status, 'settled', 'a closed ledger is not an interrupted run')
  assert.deepEqual(manifest.steps.map((step) => step.phase), ['done', 'done'])
})

test('a press that degrades into a real mouse click stops the whole run', async () => {
  const box = sandbox()
  const plan = planVisionLoop({
    goal: 'send the draft',
    app: 'Mail',
    steps: [
      { type: 'ui_click', params: { title: 'Send' } },
      { type: 'ui_click', params: { title: 'Confirm' } },
    ],
  })

  const outcome = await runVisionLoop(plan, {
    execute: async () => [{ ok: true }],
    preflightImpl: () =>
      gateWith({
        readPermissions: async () => GRANTED,
        reachability: { status: 'verified' },
        loopEnabled: () => true,
      }),
    /* The helper reporting method:"mouse" is the only evidence that a click
     * went to a screen coordinate rather than through the accessibility API. */
    runPlanImpl: fakeFocusSafePlan([
      { ok: true, status: 'success', method: 'mouse', message: 'Pressed (mouse).' },
    ]),
    ledgerPath: box.filePath,
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.status, 'stopped-on-press-fallback')
  assert.equal(outcome.pressFallbacks.length, 1)
  assert.equal(outcome.pressFallbacks[0].method, 'mouse')
  assert.match(outcome.summary, /owner/)
})

test('the status read says what works today and what does not', async () => {
  const status = await visionLoopStatus({ preflightImpl: () => gateWith() })

  assert.equal(status.ready, false)
  assert.equal(status.readOnly, true)
  assert.ok(status.todayWithoutTheGrant.length >= 3)
  assert.ok(status.blockedUntilGranted.length >= 2)
  assert.equal(status.policy.mode, 'accessibility')
})

// ------------------------------------------------------------------ history

test('a step that never started is not narrated in the past tense, and an in-flight one is not narrated at all', () => {
  const never = explainStep({ seq: 0, type: 'ui_click', phase: 'pending' }, { app: 'Mail' })
  assert.equal(never.outcome, 'not started')
  assert.match(never.text, /^Would have:/)

  const unknown = explainStep({ seq: 1, type: 'ui_click', phase: 'inflight' }, { app: 'Mail' })
  assert.equal(unknown.outcome, 'unknown')
  assert.match(unknown.text, /genuinely unknown/)
  assert.equal(unknown.undoable, false)
})

test('a completed press is explained in terms of what it means, not what tier it is in', () => {
  const done = explainStep(
    {
      seq: 0,
      type: 'ui_click',
      phase: 'done',
      ok: true,
      riskTier: 'uncontained',
      reversible: false,
      touches: [{ kind: 'app', ref: 'Mail' }],
    },
    { app: 'Mail' },
  )

  assert.equal(done.outcome, 'succeeded')
  assert.match(done.text, /accessibility API/)
  assert.match(done.text, /no snapshot of an app’s internal state/)
  assert.equal(done.undoable, false)
})

test('the undo option points at the existing route and never performs the undo itself', () => {
  const reversible = undoPosition({
    jobId: 'job_1',
    status: 'completed',
    result: {
      results: [
        {
          ok: true,
          action: { type: 'set_volume' },
          before: { percent: 30 },
        },
      ],
    },
  })
  assert.equal(reversible.available, true)
  assert.equal(reversible.via, 'POST /jobs/job_1/undo')

  const pressed = undoPosition({
    jobId: 'job_2',
    status: 'completed',
    result: { results: [{ ok: true, action: { type: 'ui_click' } }] },
  })
  assert.equal(pressed.available, false)
  assert.equal(pressed.via, null)
  /* The sentence a bare `canUndo: false` fails to convey: nothing broke, there
   * was never a snapshot to take. */
  assert.match(pressed.plainly, /leaves no snapshot/)

  const gone = undoPosition(null, { ledger: { jobId: 'job_3' } })
  assert.equal(gone.available, false)
  assert.match(gone.reason, /no longer in the job store/)
})

test('history narrates real ledgers, filters to this loop, and flags an interrupted run', () => {
  const box = sandbox()

  const mine = openLedger({
    command: 'send the draft',
    actions: planVisionLoop({ app: 'Mail', steps: readySteps }).actions,
    jobId: 'job_9',
    source: VISION_LOOP_SOURCE,
    filePath: box.filePath,
  })
  openLedger({
    command: 'tidy downloads',
    actions: [{ type: 'open_folder', params: { path: '~/Downloads' } }],
    source: 'local',
    filePath: box.filePath,
  })

  const history = recentActions({ filePath: box.filePath, jobLookup: () => null })
  assert.equal(history.total, 1, 'the ledger is shared; the history is filtered on source')
  assert.equal(history.runs[0].ledgerId, mine.ledgerId)
  assert.equal(history.runs[0].app, 'Mail')
  // Opened and never closed, so it reads as unfinished rather than as complete.
  assert.equal(history.runs[0].interrupted, true)
  assert.equal(history.runs[0].resume, `GET /ledger/${mine.ledgerId}/resume`)
  assert.match(history.undoNote, /POST \/jobs\/:jobId\/undo/)

  const all = recentActions({ filePath: box.filePath, all: true, jobLookup: () => null })
  assert.equal(all.total, 2)

  const narrated = narrateRun(getLedger(mine.ledgerId, { filePath: box.filePath }), { job: null })
  assert.equal(narrated.steps.length, 2)
  assert.match(narrated.headline, /never closed|Interrupted/)
})

// -------------------------------------------------------------------- relay

test('the offload digest is structurally incapable of carrying pixels', () => {
  const built = buildDigest({
    app: 'Mail',
    elements: [{ role: 'AXButton', title: 'Send', centerY: 400, windowHeight: 500 }],
  })

  assert.equal(built.contains.screenshot, false)
  assert.equal(built.contains.pixels, false)
  const serialized = JSON.stringify(built.payload)
  for (const marker of ['data:image', 'base64', 'png', 'screenshot']) {
    assert.equal(serialized.includes(marker), false, `digest must not carry ${marker}`)
  }
  assert.equal(built.payload.elements[0].band, 'bottom')
})

test('off-machine is stricter than on-disk: sensitive titles are masked, not merely secrets', () => {
  const secret = digestElement({ role: 'AXTextField', title: 'sk-live-4f9ab2c7d1e' })
  assert.equal(secret.title, null)
  assert.equal(secret.titleWithheld, 'secret')
  assert.notEqual(secret.masked, 'sk-live-4f9ab2c7d1e')

  const sensitive = digestElement({ role: 'AXTextField', title: 'eliu59@wisc.edu' })
  assert.equal(sensitive.title, null, 'actionLedger keeps these on disk; the relay does not get them')
  assert.equal(sensitive.titleWithheld, 'sensitive')

  const ordinary = digestElement({ role: 'AXButton', title: 'Send' })
  assert.equal(ordinary.title, 'Send')
  /* Present and null rather than absent: a classifier that cannot tell "no
   * title" from "title withheld" reads a masked login field as an unlabelled
   * one and classifies the window wrong. */
  assert.equal(Object.hasOwn(secret, 'title'), true)
  assert.equal(secret.titleHash?.length, 16)
})

test('without consent nothing is sent, and the payload is still computable so it can be read first', async () => {
  let fetches = 0
  const result = await classifyUiState(
    { app: 'Mail', elements: [{ role: 'AXButton', title: 'Send' }] },
    {
      fetchImpl: async () => {
        fetches += 1
        return { ok: true, json: async () => ({ state: 'ready' }) }
      },
      consented: () => false,
      endpointImplemented: true,
    },
  )

  assert.equal(fetches, 0)
  assert.equal(result.classified, false)
  assert.equal(result.reason, 'no_upload_consent')
  assert.equal(result.source, 'local')

  const described = describeOffload({
    app: 'Mail',
    elements: [{ role: 'AXButton', title: 'Send' }],
    consented: () => false,
    accessibilityHeld: false,
  })
  assert.equal(described.wouldSend, false)
  assert.deepEqual(
    described.blockedOn.map((entry) => entry.kind).sort(),
    ['consent', 'endpoint', 'grant'],
  )
  // Built anyway: consenting to an invisible payload is not consent.
  assert.equal(described.digest.payload.elements.length, 1)
  assert.equal(described.endpointImplemented, false)
})

test('a relay answer is data: an unknown state is declined rather than acted on', async () => {
  const post = async (state) =>
    classifyUiState(
      { app: 'Mail', elements: [{ role: 'AXButton', title: 'Send' }] },
      {
        fetchImpl: async () => ({ ok: true, json: async () => ({ state, confidence: 4 }) }),
        consented: () => true,
        endpointImplemented: true,
      },
    )

  const invented = await post('press-the-send-button')
  assert.equal(invented.classified, false)
  assert.equal(invented.reason, 'unrecognised_state')

  const known = await post('confirmation')
  assert.equal(known.classified, true)
  assert.equal(known.state, 'confirmation')
  assert.equal(known.confidence, 1, 'confidence is clamped, not trusted')
  assert.ok(KNOWN_STATES.has(known.state))
})

test('an unreachable relay declines instead of failing the run', async () => {
  const result = await classifyUiState(
    { app: 'Mail', elements: [{ role: 'AXButton', title: 'Send' }] },
    {
      fetchImpl: async () => {
        throw new Error('ECONNREFUSED')
      },
      consented: () => true,
      endpointImplemented: true,
    },
  )

  assert.equal(result.classified, false)
  assert.equal(result.reason, 'relay_unreachable')
})

// ------------------------------------------------------------------- routes

function fakeApp() {
  const routes = new Map()
  const app = {
    get: (route, handler) => routes.set(`GET ${route}`, handler),
    post: (route, handler) => routes.set(`POST ${route}`, handler),
  }
  const call = async (method, route, { params = {}, query = {}, body = {} } = {}) => {
    const handler = routes.get(`${method} ${route}`)
    assert.ok(handler, `no handler for ${method} ${route}`)
    let statusCode = 200
    let payload = null
    await handler(
      { params, query, body },
      {
        status(code) {
          statusCode = code
          return this
        },
        json(value) {
          payload = value
          return this
        },
      },
    )
    return { statusCode, payload }
  }
  return { app, call, routes }
}

test('registers the routes and the run route dispatches nothing on this machine', async () => {
  const { registerVisionLoopRoutes } = await import('./visionLoopRoutes.js')
  const box = sandbox()
  const { app, call, routes } = fakeApp()

  registerVisionLoopRoutes(app, { filePath: box.filePath, preflightImpl: () => gateWith() })

  assert.deepEqual(
    [...routes.keys()].sort(),
    [
      'GET /vision-loop/history',
      'GET /vision-loop/offload',
      'GET /vision-loop/preflight',
      'GET /vision-loop/status',
      'POST /vision-loop/plan',
      'POST /vision-loop/run',
    ],
  )

  const planned = await call('POST', '/vision-loop/plan', {
    body: { goal: 'send the draft', app: 'Mail', steps: readySteps },
  })
  assert.equal(planned.statusCode, 200)
  assert.equal(planned.payload.executed, false)

  const refused = await call('POST', '/vision-loop/plan', {
    body: { goal: 'type it', app: 'Mail', steps: [{ type: 'type_text', params: { text: 'hi' } }] },
  })
  assert.equal(refused.statusCode, 400)
  assert.deepEqual(refused.payload.actions, [])

  const ran = await call('POST', '/vision-loop/run', {
    body: { goal: 'send the draft', app: 'Mail', steps: readySteps },
  })
  assert.equal(ran.statusCode, 409)
  assert.equal(ran.payload.executed, false)
  assert.equal(ran.payload.dispatched, 0)
  assert.equal(ran.payload.status, 'blocked-on-grant')
  assert.equal(fs.existsSync(box.filePath), false, 'a blocked run writes no ledger')

  const offload = await call('GET', '/vision-loop/offload')
  assert.equal(offload.payload.wouldSend, false)

  const history = await call('GET', '/vision-loop/history')
  assert.equal(history.payload.readOnly, true)
  assert.equal(typeof history.payload.spoken, 'string')
})

test('no module in this feature reaches for the capture layer or the pixel tier', () => {
  /*
   * The structural version of "it will not degrade to pixel capture". The
   * general loop's observe() attaches a screenshot whenever the accessibility
   * tree comes back empty — which is exactly what a denied grant looks like
   * from the inside — so the guarantee here has to be that the code to do that
   * is not reachable, not that it is not preferred.
   *
   * Source-level, deliberately: a mock cannot prove absence, and a future
   * "just this once" import is the thing worth failing a build over.
   */
  const forbidden = [
    'screenCapture',
    'captureObservation',
    'observationDataUrl',
    'clickMouse',
    'typeUnicode',
    'pressChord',
    'screencapture',
  ]

  for (const file of fs
    .readdirSync(import.meta.dirname)
    .filter((name) => name.startsWith('visionLoop') && name.endsWith('.js') && !name.endsWith('.test.js'))) {
    const source = fs.readFileSync(path.join(import.meta.dirname, file), 'utf8')
    const imports = source
      .split('\n')
      .filter((line) => line.startsWith('import ') || line.includes("from '."))
      .join('\n')

    for (const marker of forbidden) {
      assert.equal(imports.includes(marker), false, `${file} must not import ${marker}`)
    }
  }
})

test('describeStep is the one source of wording for both the plan and the history', () => {
  const action = { type: 'ui_click', params: { app: 'Mail', title: 'Send' } }
  const before = describeStep(action)
  const after = explainStep(
    { seq: 0, type: 'ui_click', phase: 'done', ok: true, params: action.params, riskTier: 'uncontained' },
    { app: 'Mail' },
  )

  // The line read before the run and the line read afterwards describe the same
  // step in the same words.
  assert.ok(after.text.startsWith(before))
})

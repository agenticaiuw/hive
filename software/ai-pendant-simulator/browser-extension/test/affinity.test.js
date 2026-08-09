/*
 * The affinity rule, held to its own wording: a command entered on this node
 * whose plan is browser-doable executes HERE; only non-browser work forwards
 * to the hive; irreversible/outward steps NEVER auto-run; completion is
 * reported from the ledger, not from a model's prose.
 *
 * Everything under test is pure (affinity.js has no impure edge), so nothing
 * here mocks a browser — same discipline as relay-peer.test.js. The loop
 * integration at the bottom drives runBrainLoop with injected edges only.
 * No test drives a real site, financial or otherwise: fixtures throughout.
 */
import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

import {
  CAPABILITY_BROWSER,
  CAPABILITY_HIVE,
  EFFECT_ACT,
  EFFECT_OUTWARD,
  EFFECT_READ,
  LOCAL_CLAIMABLE_ACTIONS,
  OUTWARD_EFFECT_PATTERNS,
  classifyEffect,
  commandWantsOutwardEffect,
  createOutwardGuard,
  honestVerdict,
  localCallFor,
  routePlan,
  summarizeEffects,
  tagPlanStep,
  textLooksOutward,
} from '../src/affinity.js'
import { COMMAND_TYPES } from '../src/bridge-core.js'
import { runBrainLoop, normalizeBrainConfig } from '../src/brain.js'

/* ------------------------------------------------------------------ *
 * Capability tags: a closed table, not a vibe.
 * ------------------------------------------------------------------ */

test('every local translation lands on a command the executor accepts', () => {
  for (const [hiveType, localType] of Object.entries(LOCAL_CLAIMABLE_ACTIONS)) {
    assert.ok(
      COMMAND_TYPES.has(localType),
      `${hiveType} maps to ${localType}, which must be executable`,
    )
  }
})

test('open_url — the observed failure — becomes activate_tab here', () => {
  /* The exact shape the Mac planner produced for "open ibkr": an open_url the
   * Mac would have run with `open <url>` in ITS browser session. */
  const call = localCallFor({
    type: 'open_url',
    params: { url: 'https://www.interactivebrokers.com/portal' },
  })
  assert.equal(call.type, 'activate_tab')
  assert.equal(call.params.urlContains, 'www.interactivebrokers.com')
  assert.equal(call.params.url, 'https://www.interactivebrokers.com/portal')
})

test('steps the browser cannot do stay hive work', () => {
  for (const type of ['run_shell', 'open_app', 'create_note', 'search_file', 'send_email']) {
    assert.equal(localCallFor({ type, params: {} }), null, `${type} must not claim locally`)
    assert.equal(tagPlanStep({ type, params: {} }).capability, CAPABILITY_HIVE)
  }
})

test('browser_* planner actions and native commands tag browser-capable', () => {
  assert.equal(
    tagPlanStep({ type: 'browser_read_page', params: { mode: 'text' } }).capability,
    CAPABILITY_BROWSER,
  )
  assert.equal(
    tagPlanStep({ type: 'snapshot', params: {} }).capability,
    CAPABILITY_BROWSER,
  )
})

test('an open_url with a garbage or missing url is not claimable', () => {
  assert.equal(localCallFor({ type: 'open_url', params: {} }), null)
  assert.equal(localCallFor({ type: 'open_url', params: { url: 'not a url' } }), null)
})

/* ------------------------------------------------------------------ *
 * THE RULE: all-browser plans run here; one foreign step forwards all.
 * ------------------------------------------------------------------ */

test('a fully browser-doable plan routes local', () => {
  const route = routePlan([
    { type: 'open_url', label: 'Open IBKR', params: { url: 'https://example-broker.test/' } },
    { type: 'browser_snapshot', label: 'Look at the page', params: {} },
  ])
  assert.equal(route.route, CAPABILITY_BROWSER)
  assert.equal(route.steps.length, 2)
  assert.match(route.reason, /this node runs them itself/)
})

test('one non-browser step anywhere forwards the WHOLE plan to the hive', () => {
  const route = routePlan([
    { type: 'open_url', params: { url: 'https://example.com/' } },
    { type: 'run_shell', label: 'tidy downloads', params: { command: 'ls' } },
  ])
  assert.equal(route.route, CAPABILITY_HIVE)
  assert.match(route.reason, /run_shell/)
  /* The tags survive so a caller can render WHY. */
  assert.equal(route.steps[0].capability, CAPABILITY_BROWSER)
  assert.equal(route.steps[1].capability, CAPABILITY_HIVE)
})

test('an empty plan is hive work (nothing to claim)', () => {
  assert.equal(routePlan([]).route, CAPABILITY_HIVE)
  assert.equal(routePlan(null).route, CAPABILITY_HIVE)
})

/* ------------------------------------------------------------------ *
 * Effects: reads run, acts run, outward parks. Errs toward outward.
 * ------------------------------------------------------------------ */

test('reads and navigation auto-run', () => {
  assert.equal(classifyEffect({ type: 'read_page', params: {} }).effect, EFFECT_READ)
  assert.equal(classifyEffect({ type: 'snapshot', params: {} }).effect, EFFECT_READ)
  assert.equal(classifyEffect({ type: 'list_tabs', params: {} }).effect, EFFECT_READ)
  assert.equal(
    classifyEffect({ type: 'navigate', params: { url: 'https://x.test/cancel-plan' } }).effect,
    EFFECT_ACT,
    'LOOKING at a page named cancel-plan cancels nothing',
  )
  assert.equal(
    classifyEffect({ type: 'activate_tab', params: { urlContains: 'broker' } }).effect,
    EFFECT_ACT,
  )
})

test('commit-point clicks are outward: the ibkr cancellation, verbatim', () => {
  const verdict = classifyEffect({
    type: 'click',
    params: { selector: '#confirm' },
    targetName: 'Confirm cancellation of recurring investment (button)',
  })
  assert.equal(verdict.effect, EFFECT_OUTWARD)
  assert.match(verdict.reason, /commit point/)
})

test('outward vocabulary covers money, messages, arrangements, agreements', () => {
  for (const name of [
    'Place order',
    'Submit',
    'Send message',
    'Transfer funds',
    'Cancel subscription',
    'Unsubscribe',
    'Sign and agree',
    'Buy now',
    'Delete account',
  ]) {
    assert.equal(
      classifyEffect({ type: 'click', params: { selector: '#x' }, targetName: name }).effect,
      EFFECT_OUTWARD,
      `"${name}" must never auto-run`,
    )
  }
})

test('ordinary interaction stays runnable', () => {
  assert.equal(
    classifyEffect({ type: 'click', params: { selector: '#nav' }, targetName: 'Portfolio tab' })
      .effect,
    EFFECT_ACT,
  )
  assert.equal(
    classifyEffect({ type: 'type', params: { selector: '#q', text: 'AAPL' } }).effect,
    EFFECT_ACT,
  )
})

test('typing with submit:true, and Enter, are outward', () => {
  assert.equal(
    classifyEffect({ type: 'type', params: { selector: '#q', text: 'x', submit: true } }).effect,
    EFFECT_OUTWARD,
  )
  assert.equal(
    classifyEffect({ type: 'press_key', params: { key: 'Enter' } }).effect,
    EFFECT_OUTWARD,
  )
  assert.equal(
    classifyEffect({ type: 'press_key', params: { key: 'Escape' } }).effect,
    EFFECT_ACT,
  )
})

test('a click nobody can describe fails closed', () => {
  const verdict = classifyEffect({ type: 'click', params: { ref: 'e9' }, targetName: '' })
  assert.equal(verdict.effect, EFFECT_OUTWARD)
  assert.match(verdict.reason, /cannot describe/)
})

test('an unclassified command type fails closed', () => {
  assert.equal(classifyEffect({ type: 'brand_new_verb', params: {} }).effect, EFFECT_OUTWARD)
})

test('the outward vocabulary is frozen and pattern-valid', () => {
  assert.ok(Object.isFrozen(OUTWARD_EFFECT_PATTERNS))
  for (const source of OUTWARD_EFFECT_PATTERNS) {
    assert.doesNotThrow(() => new RegExp(source, 'i'))
  }
  assert.equal(textLooksOutward(''), false)
  assert.equal(textLooksOutward('read the balance'), false)
})

/* ------------------------------------------------------------------ *
 * The guard: refs get the names the page gave them.
 * ------------------------------------------------------------------ */

test('the guard classifies a ref click by its snapshotted accessible name', () => {
  const guard = createOutwardGuard()
  guard.observe(
    { type: 'snapshot', params: {} },
    {
      elements: [
        { ref: 'e0', name: 'Portfolio', role: 'link' },
        { ref: 'e1', name: 'Cancel recurring investment', role: 'button' },
      ],
    },
  )

  const safe = guard.assess({ type: 'click', params: { ref: 'e0' } })
  assert.equal(safe.allow, true)
  assert.equal(safe.effect, EFFECT_ACT)

  const parked = guard.assess({ type: 'click', params: { ref: 'e1' } })
  assert.equal(parked.allow, false)
  assert.equal(parked.effect, EFFECT_OUTWARD)
  assert.match(parked.targetName, /Cancel recurring investment/)
})

test('a ref the guard never saw snapshotted is refused, not guessed', () => {
  const guard = createOutwardGuard()
  const verdict = guard.assess({ type: 'click', params: { ref: 'e7' } })
  assert.equal(verdict.allow, false)
  assert.match(verdict.reason, /cannot describe/)
})

/* ------------------------------------------------------------------ *
 * Honesty: the verdict comes from the ledger of steps.
 * ------------------------------------------------------------------ */

test('a recon-only run says it changed nothing — whatever the model said', () => {
  const verdict = honestVerdict({
    command: 'check my ibkr balance',
    steps: [
      { tool: 'activate_tab', effect: EFFECT_ACT, ok: true },
      { tool: 'read_page', effect: EFFECT_READ, ok: true },
    ],
    parked: [],
    response: 'Your balance is $12,345.',
  })
  /* Navigation alone is still recon: nothing ON any page changed. */
  assert.equal(verdict.verdict, 'recon-only')
  assert.match(verdict.headline, /changed nothing/i)
  assert.match(verdict.headline, /\$12,345/)
})

test('a command that wanted an outward effect cannot be reported done without one', () => {
  const verdict = honestVerdict({
    command: 'open ibkr and cancel my recurring investments',
    steps: [
      { tool: 'activate_tab', effect: EFFECT_ACT, ok: true },
      { tool: 'click', effect: EFFECT_ACT, ok: true },
    ],
    parked: [],
    response: 'Done! I cancelled your recurring investments.',
  })
  assert.equal(verdict.verdict, 'incomplete')
  assert.match(verdict.headline, /NOT done/)
  assert.match(verdict.headline, /nothing was changed/i)
})

test('a parked run reports the effect as NOT having happened', () => {
  const verdict = honestVerdict({
    command: 'cancel my recurring investments',
    steps: [{ tool: 'read_page', effect: EFFECT_READ, ok: true }],
    parked: [{ id: 'apr-1', reason: 'The click target reads as a commit point.' }],
  })
  assert.equal(verdict.verdict, 'parked')
  assert.match(verdict.headline, /nothing was submitted, cancelled or sent/i)
  assert.match(verdict.headline, /waiting for your approval/i)
})

test('an approved outward step makes the run achieved', () => {
  const verdict = honestVerdict({
    command: 'cancel my recurring investments',
    steps: [
      { tool: 'activate_tab', effect: EFFECT_ACT, ok: true },
      { tool: 'click', effect: EFFECT_OUTWARD, ok: true },
    ],
    parked: [],
    response: 'Cancelled the recurring investment.',
  })
  assert.equal(verdict.verdict, 'achieved')
  assert.equal(commandWantsOutwardEffect('cancel my recurring investments'), true)
  assert.equal(commandWantsOutwardEffect('what time is it'), false)
})

test('failed steps are counted, not laundered', () => {
  const effects = summarizeEffects([
    { tool: 'click', effect: EFFECT_ACT, ok: false },
    { tool: 'read_page', effect: EFFECT_READ, ok: true },
  ])
  assert.equal(effects.failed, 1)
  assert.equal(effects.act, 0)
})

/* ------------------------------------------------------------------ *
 * The loop integration: the brain parks instead of clicking.
 * ------------------------------------------------------------------ */

const READY = normalizeBrainConfig({
  brainEnabled: true,
  modelProxyUrl: 'https://relay.example/v1/infer',
  deviceToken: 'scoped',
})

test('the brain snapshots, then PARKS the cancel click instead of running it', async () => {
  /* Fixture page, no network, no browser: the injected runTool returns what a
   * snapshot of a broker-shaped page would have said. */
  const replies = [
    '{"tool":"snapshot","params":{}}',
    '{"tool":"click","params":{"ref":"e1"}}',
    '{"done":true,"response":"should never be reached"}',
  ]
  const ran = []
  const guard = createOutwardGuard()

  const state = await runBrainLoop({
    command: 'cancel my recurring investments',
    config: READY,
    callModel: async () => replies.shift(),
    runTool: async (call) => {
      ran.push(call.type)
      const result =
        call.type === 'snapshot'
          ? {
              elements: [
                { ref: 'e0', name: 'Portfolio', role: 'link' },
                { ref: 'e1', name: 'Cancel recurring investment', role: 'button' },
              ],
            }
          : { message: 'clicked' }
      guard.observe(call, result)
      return result
    },
    assessTool: (call) => guard.assess(call),
  })

  assert.equal(state.status, 'parked')
  assert.deepEqual(ran, ['snapshot'], 'the outward click must never execute')
  assert.deepEqual(state.parkedCall, { type: 'click', params: { ref: 'e1' } })
  assert.match(state.parkedReason, /commit point/)
})

test('a parked loop is terminal and never falls through to a handoff', async () => {
  const state = await runBrainLoop({
    command: 'send the message',
    config: READY,
    callModel: async () => '{"tool":"press_key","params":{"key":"Enter"}}',
    runTool: async () => ({}),
    assessTool: () => ({ allow: false, reason: 'Enter submits the form.' }),
  })
  assert.equal(state.status, 'parked')
  assert.notEqual(state.status, 'handoff')
})

test('a throwing gate fails closed instead of running the tool', async () => {
  let toolRan = 0
  const state = await runBrainLoop({
    command: 'x',
    config: READY,
    callModel: async () => '{"tool":"click","params":{"selector":"#a"}}',
    runTool: async () => {
      toolRan += 1
      return {}
    },
    assessTool: () => {
      throw new Error('gate exploded')
    },
  })
  assert.equal(state.status, 'parked')
  assert.equal(toolRan, 0)
  assert.match(state.parkedReason, /gate itself failed/)
})

/* ------------------------------------------------------------------ *
 * Manifest: the tools' permissions exist TODAY — asserted, not assumed.
 * ------------------------------------------------------------------ */

test('the shipped manifest already grants what the local tools need', () => {
  const manifest = JSON.parse(
    fs.readFileSync(
      fileURLToPath(new URL('../src/manifest.json', import.meta.url)),
      'utf8',
    ),
  )
  /* tabs: query/activate; scripting: page reads and clicks; storage: the
   * journal and approval queue. Site access itself stays an OPTIONAL grant
   * the owner makes in settings — that is the existing model, unchanged. */
  for (const permission of ['tabs', 'scripting', 'storage', 'alarms']) {
    assert.ok(
      manifest.permissions.includes(permission),
      `manifest must grant ${permission}`,
    )
  }
  assert.ok(manifest.optional_host_permissions.includes('https://*/*'))
})

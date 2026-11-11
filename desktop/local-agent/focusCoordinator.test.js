import test from 'node:test'
import assert from 'node:assert/strict'

import {
  classifyFocus,
  detectDrift,
  fingerprintHost,
  inferTargetApp,
  planFocus,
  routeByTargetApp,
  runFocusSafePlan,
} from './focusCoordinator.js'
import { journalEntry } from './executionJournal.js'

/* A fake `lsappinfo` + `open`. Every call is recorded so a test can assert what
 * the coordinator did to the host, not only what it said about it. */
function fakeHost({ front = ['Notes'], target = {} } = {}) {
  const calls = []
  const fronts = [...front]
  let current = fronts[0]

  const execFileImpl = async (file, args) => {
    calls.push({ file, args })

    if (file === 'open') return { stdout: '' }

    if (args[0] === 'front') {
      current = fronts.length > 1 ? fronts.shift() : fronts[0]
      return { stdout: 'ASN:0x0-0x1:' }
    }

    const query = args[args.length - 1]
    if (query === 'ASN:0x0-0x1:') {
      return { stdout: appInfo(current) }
    }

    const state = target[query]
    if (!state) return { stdout: '' }
    return { stdout: appInfo(state.name ?? query, state.pid) }
  }

  return { execFileImpl, calls }
}

const APPS = {
  Notes: { bundleId: 'com.apple.Notes', pid: 101 },
  Safari: { bundleId: 'com.apple.Safari', pid: 202 },
}

function appInfo(name, pid) {
  const app = APPS[name] ?? { bundleId: `com.test.${name}`, pid: 900 }
  return `"LSDisplayName"="${name}"\n"CFBundleIdentifier"="${app.bundleId}"\n"pid"=${pid ?? app.pid}\n`
}

const ok = (action) => ({ action, ok: true, status: 'success', message: `ran ${action.type}` })

function recordingExecutor() {
  const ran = []
  return {
    ran,
    execute: async ([action]) => {
      ran.push(action)
      return [ok(action)]
    },
  }
}

/* Every key in the receipt, however deep. */
function keysOf(value, out = []) {
  if (Array.isArray(value)) {
    for (const item of value) keysOf(item, out)
  } else if (value && typeof value === 'object') {
    for (const [key, child] of Object.entries(value)) {
      out.push(key)
      keysOf(child, out)
    }
  }
  return out
}

test('a UI step with no app of its own is aimed at the app the plan named', () => {
  const actions = [
    { type: 'open_app', params: { appName: 'Notes' } },
    { type: 'ui_click', params: { title: 'New Note' } },
    { type: 'type_text', params: { text: 'hello' } },
  ]

  const plan = planFocus(actions)
  assert.equal(plan.targetApp, 'Notes')
  assert.equal(plan.steps[1].focus, 'addressed')
  assert.equal(plan.steps[1].targetApp, 'Notes')
  assert.equal(plan.steps[1].routedByCoordinator, true)

  const routed = routeByTargetApp(actions, plan)
  assert.equal(routed[1].params.app, 'Notes')
  // The originals are untouched: the caller still logs what it planned.
  assert.equal(actions[1].params.app, undefined)
  assert.deepEqual(routed[0], actions[0])
})

test('routing never invents a target the plan did not name', () => {
  const actions = [{ type: 'ui_click', params: { title: 'OK' } }]
  const plan = planFocus(actions)

  assert.equal(inferTargetApp(actions), null)
  assert.equal(plan.targetApp, null)
  assert.equal(plan.steps[0].focus, 'foreground')
  assert.equal(plan.steps[0].routedByCoordinator, false)
  assert.deepEqual(routeByTargetApp(actions, plan), actions)
})

test('an explicit app on the step wins over the plan target', () => {
  const actions = [
    { type: 'open_app', params: { appName: 'Notes' } },
    { type: 'ui_menu', params: { app: 'Safari', path: ['File', 'New Tab'] } },
  ]
  const plan = planFocus(actions)

  assert.equal(plan.steps[1].targetApp, 'Safari')
  assert.equal(plan.steps[1].routedByCoordinator, false)
  assert.equal(routeByTargetApp(actions, plan)[1].params.app, 'Safari')
})

test('typing is marked as needing the foreground; a screenshot is not', () => {
  assert.equal(classifyFocus({ type: 'type_text', params: { text: 'x' } }).focus, 'foreground')
  assert.equal(planFocus([{ type: 'type_text', params: {} }]).steps[0].needsForeground, true)
  // Read-only steps depend on the foreground but change nothing in it, so they
  // must not arm the drift stop.
  assert.equal(planFocus([{ type: 'screenshot', params: {} }]).steps[0].needsForeground, false)
  assert.equal(planFocus([{ type: 'write_file', params: { path: '/tmp/a' } }]).steps[0].focus, 'none')
  assert.equal(classifyFocus({ type: 'open_app', params: { appName: 'Notes' } }).mayActivate, true)
})

test('the owner switching apps is not drift when the rest of the plan is addressed by name', () => {
  const before = { foreground: { name: 'Notes', bundleId: 'com.apple.Notes' }, target: { probed: true, running: true, pid: 101, app: 'Notes' } }
  const after = { foreground: { name: 'Safari', bundleId: 'com.apple.Safari' }, target: { probed: true, running: true, pid: 101, app: 'Notes' } }

  const addressed = [{ seq: 1, focus: 'addressed', needsForeground: false }]
  assert.equal(detectDrift(before, after, { remaining: addressed }), null)

  const foreground = [{ seq: 1, focus: 'foreground', needsForeground: true }]
  const drift = detectDrift(before, after, { remaining: foreground })
  assert.equal(drift.kind, 'foreground')
  assert.equal(drift.to, 'com.apple.Safari')
})

test('an expected activation is not drift, and neither is an unreadable foreground', () => {
  const before = { foreground: { name: 'Notes', bundleId: 'com.apple.Notes' }, target: { probed: false } }
  const after = { foreground: { name: 'Safari', bundleId: 'com.apple.Safari' }, target: { probed: false } }
  const remaining = [{ seq: 1, focus: 'foreground', needsForeground: true }]

  assert.equal(detectDrift(before, after, { remaining, expectActivation: true }), null)
  assert.equal(
    detectDrift(before, { foreground: { name: null, bundleId: null } }, { remaining }),
    null,
  )
})

test('the target quitting or restarting under an addressed plan is drift', () => {
  const remaining = [{ seq: 1, focus: 'addressed', needsForeground: false }]
  const before = { foreground: { name: 'Notes' }, target: { probed: true, running: true, pid: 101, app: 'Notes' } }

  assert.equal(
    detectDrift(before, { foreground: { name: 'Notes' }, target: { probed: true, running: false, app: 'Notes' } }, { remaining }).kind,
    'target-gone',
  )
  assert.equal(
    detectDrift(before, { foreground: { name: 'Notes' }, target: { probed: true, running: true, pid: 777, app: 'Notes' } }, { remaining }).kind,
    'target-restarted',
  )
})

test('the fingerprint reports the foreground and the target, and says when it did not probe', async () => {
  const { execFileImpl } = fakeHost({ front: ['Notes'], target: { Notes: { name: 'Notes' } } })
  const print = await fingerprintHost({ targetApp: 'Notes', execFileImpl })

  assert.equal(print.foreground.name, 'Notes')
  assert.equal(print.foreground.bundleId, 'com.apple.Notes')
  assert.equal(print.target.running, true)
  assert.equal(print.target.pid, 101)
  assert.equal(print.windows.probed, false)
  assert.match(print.windows.detail, /Not probed/)
})

test('an app that is not running fingerprints as not running rather than as an error', async () => {
  const { execFileImpl } = fakeHost({ front: ['Notes'], target: {} })
  const print = await fingerprintHost({ targetApp: 'Notes', execFileImpl })

  assert.equal(print.target.probed, true)
  assert.equal(print.target.running, false)
  assert.equal(print.target.pid, null)
})

test('an accessibility fingerprint is taken when one is supplied', async () => {
  const { execFileImpl } = fakeHost({ front: ['Notes'], target: { Notes: { name: 'Notes' } } })
  const print = await fingerprintHost({
    targetApp: 'Notes',
    execFileImpl,
    uiSnapshot: async () => ({ elements: [{ role: 'AXWindow', title: 'Untitled' }] }),
  })

  assert.equal(print.windows.probed, true)
  assert.equal(print.windows.elements, 1)
  assert.match(print.windows.digest, /^[0-9a-f]{12}$/)
})

test('a clean plan runs every step and reports no drift', async () => {
  const { execFileImpl } = fakeHost({ front: ['Notes'], target: { Notes: { name: 'Notes' } } })
  const executor = recordingExecutor()

  const { results, receipt } = await runFocusSafePlan(
    [
      { type: 'open_app', params: { appName: 'Notes' } },
      { type: 'ui_click', params: { title: 'New Note' } },
      { type: 'ui_find', params: { title: 'Body' } },
    ],
    { execute: executor.execute, execFileImpl, batchSize: 2 },
  )

  assert.equal(results.length, 3)
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.ok, true)
  assert.equal(receipt.drift, null)
  assert.equal(receipt.ranSteps, 3)
  assert.deepEqual(receipt.remaining, [])
  assert.equal(receipt.focus.changed, false)
  // Bounded batches: three steps at two per batch is two host re-checks.
  assert.equal(receipt.batches.length, 2)
  assert.deepEqual(receipt.batches[0].steps, [0, 1])
  assert.deepEqual(receipt.batches[1].steps, [2])
  assert.equal(receipt.batches[0].verified.foregroundApp, 'Notes')
  assert.equal(receipt.batches[0].verified.targetRunning, true)
  assert.equal(receipt.batches[0].verified.targetWindows, 'not-probed')
  // The executor saw the routed action, so the receipt records what really ran.
  assert.equal(executor.ran[1].params.app, 'Notes')
})

test('drift stops the plan mid-way and names the step that remains', async () => {
  const { execFileImpl } = fakeHost({
    front: ['Notes', 'Safari', 'Safari', 'Safari'],
    target: { Notes: { name: 'Notes' } },
  })
  const executor = recordingExecutor()

  const { results, receipt } = await runFocusSafePlan(
    [
      { type: 'ui_click', params: { app: 'Notes', title: 'New Note' } },
      { type: 'type_text', params: { text: 'the rest of my note' } },
    ],
    { execute: executor.execute, execFileImpl, batchSize: 1, restoreFocus: false },
  )

  assert.equal(results.length, 1)
  assert.equal(executor.ran.length, 1, 'the typing never reached Safari')
  assert.equal(receipt.status, 'stopped-on-drift')
  assert.equal(receipt.ok, false)
  assert.equal(receipt.drift.kind, 'foreground')
  assert.equal(receipt.ranSteps, 1)
  assert.deepEqual(receipt.remaining, [
    { seq: 1, type: 'type_text', label: null, focus: 'foreground', targetApp: null },
  ])
  assert.equal(receipt.focus.changed, true)
  assert.equal(receipt.focus.changes[0].expected, false)
})

test('the foreground is handed back only when this plan is what moved it', async () => {
  const { execFileImpl, calls } = fakeHost({
    front: ['Notes', 'Safari', 'Safari'],
    target: { Notes: { name: 'Notes' }, 'com.apple.Notes': { name: 'Notes' }, Safari: { name: 'Safari' } },
  })

  const { receipt } = await runFocusSafePlan(
    [
      { type: 'open_app', params: { appName: 'Safari' } },
      { type: 'type_text', params: { text: 'hi' } },
    ],
    { execute: recordingExecutor().execute, execFileImpl, batchSize: 2 },
  )

  assert.equal(receipt.focus.restored.attempted, true)
  assert.equal(receipt.focus.restored.ok, true)
  assert.equal(receipt.focus.restored.restoredTo, 'Notes')
  assert.deepEqual(
    calls.filter((call) => call.file === 'open').map((call) => call.args),
    [['-b', 'com.apple.Notes']],
    'restores by bundle id, once, and activates nothing else',
  )
})

test('a foreground the plan never named is left alone', async () => {
  const { execFileImpl, calls } = fakeHost({
    front: ['Notes', 'Mail', 'Mail'],
    target: { Notes: { name: 'Notes' } },
  })

  // The plan opened Notes; Mail is where the owner went, not where it put them.
  const { receipt } = await runFocusSafePlan(
    [
      { type: 'open_app', params: { appName: 'Notes' } },
      { type: 'type_text', params: { text: 'hi' } },
    ],
    { execute: recordingExecutor().execute, execFileImpl },
  )

  assert.equal(receipt.focus.changed, true)
  assert.equal(receipt.focus.restored.attempted, false)
  assert.match(receipt.focus.restored.reason, /never named it/)
  assert.equal(calls.filter((call) => call.file === 'open').length, 0)
})

test('a plan that never goes near the foreground activates nothing on its way out', async () => {
  const { execFileImpl, calls } = fakeHost({ front: ['Notes', 'Safari', 'Safari'] })

  for (const actions of [
    [{ type: 'write_file', params: { path: '/tmp/x' } }],
    // Addressed by name through the accessibility API: it never needed the
    // foreground, so it has no business handing one back either.
    [{ type: 'ui_click', params: { app: 'Notes', title: 'New Note' } }],
  ]) {
    const { receipt } = await runFocusSafePlan(actions, {
      execute: recordingExecutor().execute,
      execFileImpl,
    })

    assert.equal(receipt.focus.restored.attempted, false)
    assert.match(receipt.focus.restored.reason, /could have moved the foreground/)
  }

  assert.equal(calls.filter((call) => call.file === 'open').length, 0)
})

test('a cancelled plan still gets the foreground handed back', async () => {
  const { execFileImpl, calls } = fakeHost({
    front: ['Notes', 'Safari', 'Safari'],
    target: { Safari: { name: 'Safari' }, 'com.apple.Notes': { name: 'Notes' } },
  })

  await assert.rejects(
    runFocusSafePlan(
      [
        { type: 'open_app', params: { appName: 'Safari' } },
        { type: 'type_text', params: { text: 'hi' } },
      ],
      {
        execute: recordingExecutor().execute,
        execFileImpl,
        onStep: ({ phase, seq }) => {
          if (phase === 'start' && seq === 1) throw new Error('Cancelled from dashboard')
        },
      },
    ),
    /Cancelled from dashboard/,
  )

  assert.deepEqual(
    calls.filter((call) => call.file === 'open').map((call) => call.args),
    [['-b', 'com.apple.Notes']],
  )
})

test('a failing step is reported, not swallowed, and the plan still finishes', async () => {
  const { execFileImpl } = fakeHost({ front: ['Notes'], target: { Notes: { name: 'Notes' } } })

  const { results, receipt } = await runFocusSafePlan(
    [
      { type: 'ui_click', params: { app: 'Notes', title: 'Nope' } },
      { type: 'ui_find', params: { app: 'Notes', title: 'Body' } },
    ],
    {
      execute: async ([action]) => [
        action.params.title === 'Nope'
          ? { action, ok: false, status: 'failed', message: 'Failed: no such control' }
          : ok(action),
      ],
      execFileImpl,
      batchSize: 1,
    },
  )

  assert.equal(results.length, 2, 'a failed step is not drift and does not stop the plan')
  assert.equal(receipt.ok, false)
  assert.equal(receipt.status, 'completed')
  assert.equal(receipt.drift, null)
})

test('nothing in the receipt is an approval, a confirmation, or a prompt', async () => {
  const { execFileImpl } = fakeHost({
    front: ['Notes', 'Safari', 'Safari'],
    target: { Notes: { name: 'Notes' } },
  })

  const { receipt } = await runFocusSafePlan(
    [
      { type: 'open_app', params: { appName: 'Notes' } },
      { type: 'ui_click', params: { title: 'New Note' } },
      { type: 'type_text', params: { text: 'hello' } },
    ],
    { execute: recordingExecutor().execute, execFileImpl, batchSize: 1 },
  )

  const forbidden = /approv|confirm|consent|authoriz|permission|permitted|allow|deny|gate|prompt|ask|await|pending|review|acknowledg/i
  const offenders = keysOf(receipt).filter((key) => forbidden.test(key))

  assert.deepEqual(offenders, [], 'the focus receipt must never grow a field a person has to answer')
  assert.match(receipt.note, /Nothing on this path can block, prompt, or wait for a person/)
})

test('every step runs without the coordinator consulting anything', async () => {
  const { execFileImpl } = fakeHost({ front: ['Notes'], target: { Notes: { name: 'Notes' } } })
  const executor = recordingExecutor()
  const actions = [
    // Types actionRisk marks as needing approval elsewhere in the stack. The
    // coordinator has no opinion about them: it runs them and records what
    // happened to the foreground.
    { type: 'run_shell', params: { command: 'rm -rf /tmp/nothing' } },
    { type: 'send_email', params: { to: 'a@b.c', subject: 'hi' } },
    { type: 'delete_path', params: { path: '/tmp/nothing' } },
  ]

  const { results, receipt } = await runFocusSafePlan(actions, {
    execute: executor.execute,
    execFileImpl,
  })

  assert.equal(executor.ran.length, 3)
  assert.equal(results.length, 3)
  assert.equal(receipt.status, 'completed')
  assert.deepEqual(receipt.remaining, [])
})

test('an unreadable host does not stop a plan', async () => {
  const executor = recordingExecutor()
  const { results, receipt } = await runFocusSafePlan(
    [
      { type: 'ui_click', params: { app: 'Notes', title: 'New Note' } },
      { type: 'type_text', params: { text: 'hi' } },
    ],
    {
      execute: executor.execute,
      execFileImpl: async () => {
        throw new Error('lsappinfo: command not found')
      },
      batchSize: 1,
    },
  )

  assert.equal(results.length, 2)
  assert.equal(receipt.drift, null)
  assert.match(receipt.focus.before.error, /command not found/)
})

test('runFocusSafePlan will not run without an executor to run through', async () => {
  await assert.rejects(runFocusSafePlan([{ type: 'screenshot' }]), /requires an execute function/)
})

test('the journal reads the focus receipt back out of the job it is already stored in', async () => {
  const { execFileImpl } = fakeHost({
    front: ['Notes', 'Safari', 'Safari'],
    target: { Notes: { name: 'Notes' } },
  })

  const { receipt } = await runFocusSafePlan(
    [
      { type: 'ui_click', params: { app: 'Notes', title: 'New Note' } },
      { type: 'type_text', params: { text: 'the rest of my note' } },
    ],
    { execute: recordingExecutor().execute, execFileImpl, batchSize: 1 },
  )

  const entry = journalEntry({
    jobId: 'job-1',
    type: 'execute',
    status: 'done',
    command: 'take a note',
    createdAt: '2026-08-07T00:00:00.000Z',
    updatedAt: '2026-08-07T00:00:01.000Z',
    result: { results: [], focus: receipt },
  })

  assert.equal(entry.focus.foregroundBefore, 'Notes')
  assert.equal(entry.focus.foregroundAfter, 'Safari')
  assert.equal(entry.focus.changed, true)
  assert.equal(entry.focus.stoppedOnDrift, true)
  assert.equal(entry.focus.drift.kind, 'foreground')
  assert.equal(entry.focus.stepsRun, 1)
  assert.equal(entry.focus.stepsRemaining, 1)

  // Nothing new is written to produce that: a job from before the coordinator
  // existed simply has no focus section.
  assert.equal(journalEntry({ jobId: 'old', result: { results: [] } }).focus, null)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  attributeTier,
  buildExecutionJournal,
  commandKey,
  journalEntry,
  observeHost,
  parseForegroundApp,
  parseRunningApps,
  projectAccessibility,
  repeatedActions,
} from './executionJournal.js'
import { actionIdFor, buildActionReceipt } from './actionReceipts.js'

/* Receipts are built by the real builder, not typed out: a test that invents
 * its own receipt shape proves the journal reads a shape nothing produces. */
function receiptFor(action, result, { before = null, startedAt, finishedAt } = {}) {
  return buildActionReceipt({
    action,
    result,
    before,
    startedAt: startedAt ?? '2026-08-07T10:00:00.000Z',
    finishedAt: finishedAt ?? '2026-08-07T10:00:00.400Z',
  })
}

function executedStep(action, result, options) {
  return { ...result, action, receipt: receiptFor(action, result, options) }
}

function executeJob(overrides = {}) {
  const openApp = { type: 'open_app', label: 'Open Notes', params: { appName: 'Notes' } }
  const shell = { type: 'run_shell', label: 'Sync repo', params: { command: 'git push' } }

  return {
    jobId: 'local_exec_1',
    type: 'execute',
    status: 'completed',
    command: 'open notes and push',
    sessionId: 'sess_a',
    source: 'pendant',
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:00:02.000Z',
    error: null,
    result: {
      ok: true,
      results: [
        executedStep(openApp, { ok: true, status: 'success', message: 'Opened Notes' }),
        executedStep(
          shell,
          { ok: true, status: 'success', message: 'pushed 1 commit' },
          { startedAt: '2026-08-07T10:00:00.400Z', finishedAt: '2026-08-07T10:00:01.400Z' },
        ),
      ],
    },
    ...overrides,
  }
}

function planJob(overrides = {}) {
  return {
    jobId: 'local_plan_1',
    type: 'plan',
    status: 'plan_ready',
    command: 'open notes and push',
    sessionId: 'sess_a',
    source: 'pendant',
    createdAt: '2026-08-07T09:59:58.000Z',
    updatedAt: '2026-08-07T09:59:59.000Z',
    result: {
      status: 'ready',
      routing: {
        tier: 'planner',
        reason: 'multi-step request',
        intent: null,
        escalatedFrom: 'deterministic',
        llmCalls: 2,
        latencyMs: 1802,
        estimatedPromptTokens: 6500,
        estimatedCompletionTokens: 100,
        estimatedCostUsd: null,
        models: ['gpt-5.6-luna'],
      },
    },
    ...overrides,
  }
}

test('the journal reports what ran, in what order, and what each step touched', () => {
  const entry = journalEntry(executeJob())

  assert.deepEqual(
    entry.actions.map((action) => [action.seq, action.type, action.label]),
    [
      [0, 'open_app', 'Open Notes'],
      [1, 'run_shell', 'Sync repo'],
    ],
  )

  const [opened, pushed] = entry.actions
  assert.equal(opened.effect, 'write')
  assert.equal(opened.durationMs, 400)
  assert.deepEqual(opened.touched, [{ kind: 'app', ref: 'Notes' }])
  assert.equal(pushed.durationMs, 1000)
  assert.deepEqual(pushed.touched, [{ kind: 'shell', ref: 'git push' }])
  assert.equal(pushed.outcome.message, 'pushed 1 commit')

  // Wall clock covers planning and bookkeeping; action time is what the steps
  // themselves cost. Conflating them is how "the agent took 2s" becomes a lie.
  assert.equal(entry.durationMs, 2000)
  assert.equal(entry.actionTimeMs, 1400)
  assert.equal(entry.counts.actions, 2)
  assert.equal(entry.counts.wrote, 2)
})

test('every step carries the content-addressed id that is its idempotency key', () => {
  const entry = journalEntry(executeJob())
  const expected = actionIdFor({
    type: 'open_app',
    label: 'Open Notes',
    params: { appName: 'Notes' },
  })

  assert.equal(entry.actions[0].idempotencyKey, expected)
  assert.match(entry.actions[0].idempotencyKey, /^act_[0-9a-f]{12}$/)
  assert.notEqual(entry.actions[0].idempotencyKey, entry.actions[1].idempotencyKey)
})

test('whether a step can be taken back comes from undo.js, not a second opinion', () => {
  const entry = journalEntry(executeJob())

  const [opened, pushed] = entry.actions
  assert.equal(opened.reversible, true)
  assert.equal(opened.reversedBy, 'close the front window')
  assert.equal(pushed.reversible, false)
  assert.match(pushed.irreversibleReason, /no reversible trace/i)

  assert.equal(entry.undo.canUndo, true)
  assert.equal(entry.counts.reversible, 1)
  assert.deepEqual(
    entry.undo.irreversible.map((step) => step.type),
    ['run_shell'],
  )
})

test('a job overwriting a file without a snapshot is reported as irreversible', () => {
  const action = { type: 'write_file', label: 'Update notes', params: { path: '/tmp/x.md' } }
  const job = executeJob({
    jobId: 'local_exec_write',
    result: {
      ok: true,
      results: [
        executedStep(
          action,
          { ok: true, status: 'success', message: 'wrote', path: '/tmp/x.md' },
          {
            before: {
              target: {
                path: '/tmp/x.md',
                existed: true,
                bytes: 99_000_000,
                snapshotPath: null,
                snapshotSkipped: 'larger than 8388608 bytes',
              },
            },
          },
        ),
      ],
    },
  })

  const entry = journalEntry(job)
  assert.equal(entry.actions[0].reversible, false)
  assert.match(entry.actions[0].irreversibleReason, /Overwrote an existing file/)
  assert.equal(entry.counts.snapshotted, 0)
  assert.equal(entry.undo.canUndo, false)
})

test('a plan job is attributed from the routing receipt it already carries', () => {
  const attribution = attributeTier(planJob())

  assert.equal(attribution.tier, 'planner')
  assert.equal(attribution.source, 'plan-receipt')
  assert.equal(attribution.confidence, 'recorded')
  assert.equal(attribution.escalatedFrom, 'deterministic')
  assert.equal(attribution.estimatedPromptTokens, 6500)
})

test('an execute job is joined back to the plan that produced it, and says so', () => {
  const jobs = [executeJob(), planJob()]
  const attribution = attributeTier(jobs[0], { jobs })

  assert.equal(attribution.tier, 'planner')
  assert.equal(attribution.source, 'plan-job')
  // A join is not a record. Reporting it as one is how observability lies.
  assert.equal(attribution.confidence, 'joined')
  assert.match(attribution.sourceDetail, /local_plan_1/)
})

test('a plan job from a different session is never borrowed for attribution', () => {
  const jobs = [executeJob(), planJob({ sessionId: 'sess_b' })]
  assert.equal(attributeTier(jobs[0], { jobs }).source, 'unattributed')
})

test('a plan job recorded after the execute job is not credited with planning it', () => {
  const jobs = [executeJob(), planJob({ createdAt: '2026-08-07T11:00:00.000Z' })]
  assert.equal(attributeTier(jobs[0], { jobs }).source, 'unattributed')
})

test('routingStats fills in when the plan job has aged out of the store', () => {
  const job = executeJob()
  const routing = {
    recent: [
      {
        at: '2026-08-07T09:59:59.000Z',
        command: 'open notes and push',
        tier: 'deterministic',
        reason: 'matched a known intent',
        intent: 'open_app',
        latencyMs: 12,
        promptTokens: 0,
        completionTokens: 0,
        costUsd: null,
        calls: [],
      },
    ],
  }

  const attribution = attributeTier(job, { jobs: [job], routing })
  assert.equal(attribution.tier, 'deterministic')
  assert.equal(attribution.source, 'routing-stats')
  assert.equal(attribution.estimatedPromptTokens, 0)
  assert.deepEqual(attribution.models, [])
})

test('the join uses the same 160-character key routingStats stores', () => {
  const long = `${'a'.repeat(200)}tail`
  const job = executeJob({ command: long })
  const routing = {
    recent: [{ at: '2026-08-07T10:00:01.000Z', command: commandKey(long), tier: 'planner' }],
  }

  assert.equal(commandKey(long).length, 160)
  // Matching on the untruncated command would look exactly like "the router
  // never ran" for every long command.
  assert.equal(attributeTier(job, { jobs: [job], routing }).source, 'routing-stats')
})

test('an unknown tier is reported as unknown rather than guessed', () => {
  const attribution = attributeTier(executeJob(), { jobs: [executeJob()] })
  assert.equal(attribution.tier, null)
  assert.equal(attribution.source, 'unattributed')
  assert.equal(attribution.confidence, 'unknown')
  assert.match(attribution.sourceDetail, /per-process/)
})

test('jobs recorded before receipts existed still appear, flagged as derived', () => {
  const legacy = {
    jobId: 'local_legacy',
    type: 'execute',
    status: 'completed',
    command: 'turn the volume down',
    createdAt: '2026-08-01T10:00:00.000Z',
    updatedAt: '2026-08-01T10:00:01.000Z',
    result: {
      ok: true,
      results: [
        {
          action: { type: 'set_volume', params: { percent: 20 } },
          ok: true,
          status: 'success',
          message: 'Volume 20%',
          before: { percent: 60 },
          percent: 20,
        },
      ],
    },
  }

  const entry = journalEntry(legacy)
  assert.equal(entry.actions[0].recordedBy, 'derived-from-result')
  assert.equal(entry.actions[0].reversible, true)
  assert.equal(entry.actions[0].reversedBy, 'set_volume')
  // Nothing measured these, so they report null instead of a fabricated zero.
  assert.equal(entry.actions[0].durationMs, null)
  assert.equal(entry.actionTimeMs, null)
})

test('a deterministic instant plan records its steps under sideResults and is still journalled', () => {
  const action = { type: 'get_battery', label: 'Battery', params: {} }
  const job = {
    jobId: 'local_instant',
    type: 'plan',
    status: 'completed',
    command: 'how much battery',
    createdAt: '2026-08-07T10:00:00.000Z',
    updatedAt: '2026-08-07T10:00:00.100Z',
    result: {
      status: 'instant',
      mode: 'deterministic',
      routing: { tier: 'deterministic', reason: 'known intent', llmCalls: 0 },
      sideResults: [executedStep(action, { ok: true, status: 'success', message: '86%' })],
    },
  }

  const entry = journalEntry(job)
  assert.equal(entry.counts.actions, 1)
  assert.equal(entry.actions[0].type, 'get_battery')
  assert.equal(entry.plannedBy.tier, 'deterministic')
})

test('a failed step keeps its error text instead of collapsing to ok:false', () => {
  const action = { type: 'run_shell', label: 'Deploy', params: { command: 'make deploy' } }
  const job = executeJob({
    status: 'failed',
    result: {
      ok: false,
      results: [
        executedStep(action, {
          ok: false,
          status: 'failed',
          message: 'Failed: exit 1',
          reason: 'exit 1',
        }),
      ],
    },
  })

  const entry = journalEntry(job)
  assert.equal(entry.actions[0].ok, false)
  assert.equal(entry.actions[0].outcome.error, 'exit 1')
  assert.equal(entry.actions[0].outcome.message, 'Failed: exit 1')
  assert.equal(entry.counts.failed, 1)
  // A step that never completed changed nothing, so there is nothing to undo.
  assert.equal(entry.actions[0].reversible, false)
})

test('risk is a label on something that already ran, never a gate', () => {
  const entry = journalEntry(executeJob())
  const shell = entry.actions.find((action) => action.type === 'run_shell')

  // run_shell is off the hands-free allowlist. The journal still reports it in
  // full, in order, with what it touched — labelling is not withholding.
  assert.equal(shell.handsFree, false)
  assert.match(shell.handsFreeNote, /needs your approval/)
  assert.equal(shell.ok, true)
  assert.deepEqual(shell.touched, [{ kind: 'shell', ref: 'git push' }])

  const journal = buildExecutionJournal({ jobs: [executeJob()] })
  assert.equal(journal.readOnly, true)
  assert.match(journal.note, /Nothing on this path can block, refuse, or delay/)
})

test('the same action across two jobs is surfaced by its idempotency key', () => {
  const first = executeJob({ jobId: 'local_a', createdAt: '2026-08-07T10:00:00.000Z' })
  const second = executeJob({ jobId: 'local_b', createdAt: '2026-08-07T12:00:00.000Z' })
  const journal = buildExecutionJournal({ jobs: [second, first] })

  const repeated = journal.repeatedActions
  assert.equal(repeated.length, 2)
  assert.deepEqual(
    repeated.map((row) => [row.type, row.runs]).sort(),
    [
      ['open_app', 2],
      ['run_shell', 2],
    ],
  )
  assert.equal(repeated[0].jobs, 2)
  assert.deepEqual(repeated[0].recentJobIds.sort(), ['local_a', 'local_b'])
  assert.equal(repeated[0].failed, 0)

  // A different payload is a different action, so it must not collide.
  const other = executeJob({
    jobId: 'local_c',
    result: {
      ok: true,
      results: [
        executedStep(
          { type: 'open_app', label: 'Open Mail', params: { appName: 'Mail' } },
          { ok: true, status: 'success', message: 'Opened Mail' },
        ),
      ],
    },
  })
  assert.equal(repeatedActions([journalEntry(other)]).length, 0)
})

test('a step that ran fifty times does not put fifty uuids in a summary row', () => {
  const jobs = Array.from({ length: 12 }, (_unused, index) =>
    executeJob({ jobId: `local_${index}` }),
  )
  const [row] = buildExecutionJournal({ jobs }).repeatedActions

  assert.equal(row.runs, 12)
  assert.equal(row.jobs, 12)
  assert.equal(row.recentJobIds.length, 5)
})

test('the journal filters by type, status and idempotency key, newest first', () => {
  const jobs = [
    executeJob({ jobId: 'local_new', createdAt: '2026-08-07T12:00:00.000Z' }),
    executeJob({ jobId: 'local_bad', status: 'failed' }),
    planJob(),
  ]

  assert.deepEqual(
    buildExecutionJournal({ jobs, type: 'plan' }).entries.map((entry) => entry.jobId),
    ['local_plan_1'],
  )
  assert.deepEqual(
    buildExecutionJournal({ jobs, status: 'failed' }).entries.map((entry) => entry.jobId),
    ['local_bad'],
  )
  assert.deepEqual(
    buildExecutionJournal({ jobs, limit: 1 }).entries.map((entry) => entry.jobId),
    ['local_new'],
  )

  const key = actionIdFor({
    type: 'run_shell',
    label: 'Sync repo',
    params: { command: 'git push' },
  })
  const matched = buildExecutionJournal({ jobs, idempotencyKey: key })
  assert.deepEqual(matched.entries.map((entry) => entry.jobId), ['local_new', 'local_bad'])
  assert.equal(matched.window.matched, 2)
  assert.equal(matched.window.jobsInStore, 3)
})

test('totals count the matched set, and name how many tiers are unknown', () => {
  const jobs = [executeJob(), planJob()]
  const journal = buildExecutionJournal({ jobs })

  assert.equal(journal.totals.actions, 2)
  assert.equal(journal.totals.wrote, 2)
  assert.equal(journal.totals.undoable, 1)
  assert.equal(journal.totals.unattributedTier, 0)
  assert.equal(buildExecutionJournal({ jobs: [executeJob()] }).totals.unattributedTier, 1)
})

test('a running job reports no finish time rather than its start time', () => {
  const job = executeJob({ status: 'processing', result: null, updatedAt: '2026-08-07T10:00:00.000Z' })
  const entry = journalEntry(job)

  assert.equal(entry.running, true)
  assert.equal(entry.finishedAt, null)
  assert.equal(entry.durationMs, null)
  assert.equal(entry.counts.actions, 0)
})

test('running apps are the apps, not the ninety helper processes inside them', () => {
  const ps = [
    '  711 /Applications/superwhisper.app/Contents/MacOS/superwhisper',
    ' 3236 /Applications/OneDrive.app/Contents/MacOS/OneDrive',
    ' 3246 /Applications/OneDrive.app/Contents/MacOS/OneDrive',
    '21035 /System/Applications/System Settings.app/Contents/MacOS/System Settings',
    '  640 /System/Library/CoreServices/CoreServicesUIAgent.app/Contents/MacOS/CoreServicesUIAgent',
    ' 4102 /Applications/Chrome.app/Contents/Frameworks/Helper.app/Contents/MacOS/Helper',
    '  1 /sbin/launchd',
  ].join('\n')

  const { apps, helperProcesses } = parseRunningApps(ps)
  assert.deepEqual(
    apps.map((app) => app.name),
    ['OneDrive', 'superwhisper', 'System Settings'],
  )
  // Two OneDrive processes, one app: the earliest pid is the one that launched.
  assert.equal(apps.find((app) => app.name === 'OneDrive').pid, 3236)
  assert.equal(helperProcesses, 2)
})

test('the foreground app is parsed off lsappinfo, which needs no permission grant', () => {
  const output = [
    '"LSDisplayName"="Claude"',
    '"CFBundleIdentifier"="com.anthropic.claudefordesktop"',
    '"pid"=55646',
  ].join('\n')

  assert.deepEqual(parseForegroundApp(output), {
    name: 'Claude',
    bundleId: 'com.anthropic.claudefordesktop',
    pid: 55646,
  })
  assert.deepEqual(parseForegroundApp(''), { name: null, bundleId: null, pid: null })
})

test('accessibility reports whether ui steps actually reach the screen', () => {
  const granted = projectAccessibility({
    hostApp: 'AI Pendant Agent',
    accessibility: { trusted: true, detail: 'Trusted' },
    inputPosting: { granted: true, secureInput: false },
    screenRecording: { granted: true },
    requiredMissing: [],
  })
  assert.equal(granted.uiActionsWillReachTheScreen, true)
  assert.equal(granted.consequence, null)

  // The failure worth surfacing: the checkbox is on, but for another bundle,
  // so synthesized events vanish and every ui_* receipt says "success".
  const wrongBundle = projectAccessibility({
    hostApp: 'AI Pendant Agent',
    accessibility: { trusted: true, detail: 'Trusted' },
    inputPosting: { granted: false },
    screenRecording: { granted: false },
    requiredMissing: ['Mail'],
  })
  assert.equal(wrongBundle.uiActionsWillReachTheScreen, false)
  assert.match(wrongBundle.consequence, /report success while doing nothing/)
  assert.deepEqual(wrongBundle.automationMissing, ['Mail'])

  assert.equal(projectAccessibility(null).probed, false)
  assert.equal(projectAccessibility({ error: 'probe failed' }).detail, 'probe failed')
})

test('an unprobed input path is reported as unknown, not as "does not post"', () => {
  /* The quiet permission report /capabilities and /observe use carries no
   * `inputPosting` at all. Reading that absence as `false` is how the first
   * live run of this endpoint confidently told the owner their ui_* steps were
   * going nowhere. Absent means not probed. */
  const quiet = projectAccessibility({
    hostApp: 'AI Pendant Agent',
    accessibility: { trusted: true, detail: 'Accessibility is granted' },
    screenRecording: { granted: true },
    requiredMissing: [],
  })

  assert.equal(quiet.eventsPost, null)
  assert.equal(quiet.uiActionsWillReachTheScreen, null)
  assert.equal(quiet.secureInputActive, null)
  assert.match(quiet.eventsPostDetail, /Not probed/)
  assert.match(quiet.consequence, /^Unverified:/)
})

test('the opt-in probe answers the question the TCC lookup cannot', async () => {
  const probed = await observeHost({
    roots: [],
    permissions: {
      hostApp: 'AI Pendant Agent',
      accessibility: { trusted: true, detail: 'Accessibility is granted' },
      screenRecording: { granted: true },
    },
    execFileImpl: async () => ({ stdout: '' }),
    inputProbe: async () => ({ axTrusted: true, secureInput: false }),
  })
  assert.equal(probed.accessibility.eventsPost, true)
  assert.equal(probed.accessibility.uiActionsWillReachTheScreen, true)
  assert.equal(probed.accessibility.consequence, null)

  // A probe that cannot run is not "unknown": posting events is what the helper
  // is for, so failing to run it is failing to post.
  const broken = await observeHost({
    roots: [],
    permissions: { accessibility: { trusted: true }, screenRecording: { granted: true } },
    execFileImpl: async () => ({ stdout: '' }),
    inputProbe: async () => {
      throw new Error('helper not built')
    },
  })
  assert.equal(broken.accessibility.eventsPost, false)
  assert.match(broken.accessibility.eventsPostDetail, /helper not built/)
  assert.match(broken.accessibility.consequence, /report success while doing nothing/)
})

test('host observation never throws when the host will not answer', async () => {
  const observed = await observeHost({
    roots: [],
    browserSessions: null,
    execFileImpl: async () => {
      throw new Error('lsappinfo: command not found')
    },
  })

  assert.equal(observed.ok, true)
  assert.equal(observed.readOnly, true)
  assert.match(observed.foregroundApp.error, /command not found/)
  assert.deepEqual(observed.runningApps.apps, [])
  assert.equal(observed.browser.sessions, 0)
})

test('host observation reports the allowlist honestly under full control', async () => {
  const observed = await observeHost({
    roots: ['/definitely/not/a/real/root'],
    browserSessions: [
      { id: 'orders', url: 'https://example.com/orders', title: 'Orders', tabId: 4 },
    ],
    execFileImpl: async (file, args) => {
      if (file === 'lsappinfo' && args[0] === 'front') return { stdout: 'ASN:0x0-0x1:' }
      if (file === 'lsappinfo') return { stdout: '"LSDisplayName"="Notes"\n"pid"=42' }
      return { stdout: ' 100 /Applications/Notes.app/Contents/MacOS/Notes' }
    },
  })

  assert.equal(observed.foregroundApp.name, 'Notes')
  assert.equal(observed.runningApps.count, 1)
  assert.equal(observed.browser.tabs[0].id, 'orders')
  assert.equal(observed.directories.roots[0].readable, false)
  // Under FULL_CONTROL_MODE the roots are configuration, not a boundary, and
  // saying otherwise would be a comfortable lie.
  assert.equal(observed.directories.enforced, false)
  assert.match(observed.directories.note, /not a limit/)
})

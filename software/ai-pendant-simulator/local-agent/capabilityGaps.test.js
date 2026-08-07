import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

/* Before capabilityGaps.js, which reaches routines, pageWatch and briefings —
 * all three default to the owner's real workspace, and the agent app is a live
 * concurrent writer to every one of them. */
import './testWorkspace.js'

import {
  ANNOUNCEMENT_EXPECTED_PRODUCERS,
  REASKED_CAPABILITIES,
  announcementProducers,
  auditCapabilities,
  auditCapability,
  evidenceOfUse,
  registerCapabilityGapsRoutes,
  renderCapabilityGapReport,
  resolveRoute,
  schedulesFor,
} from './capabilityGaps.js'
import {
  CAPABILITY_GAP_ACTIONS,
  CAPABILITY_GAP_ACTION_TYPES,
  CAPABILITY_GAP_HANDS_FREE,
  CAPABILITY_GAP_MATCHERS,
  capabilityGapHandsFree,
  isCapabilityGapAction,
  matchMorningTriageCommand,
  matchWatchPageCommand,
  runCapabilityGapAction,
} from './capabilityGapsActions.js'
import { matchBriefingCommand } from './briefing.js'
import { createWatch, listWatches } from './pageWatch.js'

/*
 * These tests are about REACHABILITY, not about whether the nine capabilities
 * work. briefingTriage.test.js, pageWatch.test.js and routines.test.js already
 * cover the work, and they pass — which is exactly why nine proposals re-asked
 * for capabilities that were finished. The thing nobody was testing is whether
 * a sentence a person says can arrive at any of them.
 */

const scratch = () =>
  fs.mkdtempSync(path.join(os.tmpdir(), 'capability-gaps-'))

/* ------------------------------------------------------------- the matchers */

test('every re-asked phrasing reaches the capability that answers it', () => {
  /*
   * The verbatim asks, which is the point: three of them are missed by
   * briefingTriage.js's own matcher, because it requires the words
   * accounts/tabs/sites next to logged-in/authenticated and the owner wrote
   * "authenticated work portal", "logged-in work dashboards", and "account
   * notifications in Safari".
   */
  const triageAsks = REASKED_CAPABILITIES.filter(
    (entry) => entry.wants === 'briefing_triage',
  )
  assert.equal(triageAsks.length, 6)
  for (const entry of triageAsks) {
    assert.notEqual(
      matchMorningTriageCommand(entry.ask),
      null,
      `verbatim ask unmatched: ${entry.ask}`,
    )
    for (const phrase of entry.spoken) {
      assert.notEqual(
        matchMorningTriageCommand(phrase),
        null,
        `spoken form unmatched: ${phrase}`,
      )
    }
  }
})

test('the triage matcher does not steal briefing.js traffic', () => {
  /*
   * The failure mode pointed the other way. compose_briefing is not broken and
   * "brief me" is its traffic; a matcher spliced in above it that claims a bare
   * morning brief would replace one silent substitution with another.
   *
   * Every phrase below is one briefing.js already claims. All of them must miss
   * here, and the assertion checks BOTH halves so the test still means
   * something if briefing.js's patterns are edited.
   */
  const theirs = [
    'brief me',
    'give me my morning brief',
    'morning brief',
    'every morning brief me',
    'prepare my workday',
    'what did I miss in email',
    'read my schedule',
    'summarize the notes I created today into three next actions',
  ]
  for (const phrase of theirs) {
    assert.notEqual(matchBriefingCommand(phrase), null, `no longer briefing.js: ${phrase}`)
    assert.equal(matchMorningTriageCommand(phrase), null, `stolen: ${phrase}`)
  }

  /* And things that belong to nobody here. */
  for (const phrase of ['triage my inbox', 'set volume to 30', 'open Safari', '']) {
    assert.equal(matchMorningTriageCommand(phrase), null, `stolen: ${phrase}`)
  }
})

test('a watch is only claimed deterministically when the page is named', () => {
  /*
   * A watch on the wrong page is silent forever about the thing the owner
   * cared about, and silence is the one failure this feature cannot signal.
   * So without a url the request goes to the planner, which can read the open
   * tabs and find out.
   */
  assert.deepEqual(matchWatchPageCommand('watch example.com/orders and tell me when it changes'), {
    url: 'https://example.com/orders',
  })
  assert.deepEqual(matchWatchPageCommand('keep an eye on https://shop.test/o/1'), {
    url: 'https://shop.test/o/1',
  })
  assert.equal(matchWatchPageCommand('watch my order page'), null)
  assert.equal(matchWatchPageCommand('watch the news'), null)
  assert.equal(matchWatchPageCommand('open example.com'), null)
})

test('the matchers are shaped for policyRouter and carry their slots', async () => {
  /* If this drifts, the splice into DETERMINISTIC_MATCHERS compiles and
   * silently matches nothing. */
  for (const matcher of CAPABILITY_GAP_MATCHERS) {
    assert.equal(typeof matcher.intent, 'string')
    assert.equal(typeof matcher.test, 'function')
    assert.equal(typeof matcher.build, 'function')
  }

  const triage = CAPABILITY_GAP_MATCHERS.find((m) => m.intent === 'briefing_triage')
  const built = triage.build(triage.test('the three things I need to know'))
  assert.equal(built.type, 'briefing_triage')

  const watch = CAPABILITY_GAP_MATCHERS.find((m) => m.intent === 'watch_page')
  const watchBuilt = watch.build(watch.test('watch example.com/orders please'))
  assert.equal(watchBuilt.params.url, 'https://example.com/orders')
})

/* ------------------------------------------------------------- hands-free */

test('a routine may only be installed hands-free if what it runs is hands-free', () => {
  /*
   * The escalation this guards. routines.js runs orchestratePlan and
   * orchestrateExecute directly and never calls classifyPlan, so a routine
   * installed by voice would execute — every morning, forever — actions that
   * voice is not allowed to run once.
   */
  assert.deepEqual(capabilityGapHandsFree({ type: 'briefing_triage' }), { safe: true })
  assert.deepEqual(capabilityGapHandsFree({ type: 'review_queue' }), { safe: true })
  assert.deepEqual(capabilityGapHandsFree({ type: 'watch_page' }), { safe: true })

  assert.deepEqual(
    capabilityGapHandsFree({
      type: 'schedule_routine',
      params: { command: 'check my logged-in accounts every morning' },
    }),
    { safe: true },
  )

  const arbitrary = capabilityGapHandsFree({
    type: 'schedule_routine',
    params: { command: 'delete everything in Downloads' },
  })
  assert.equal(arbitrary.safe, false)
  assert.match(arbitrary.reason, /approval/i)

  /* Not ours to answer for. */
  assert.equal(capabilityGapHandsFree({ type: 'open_url' }), null)
})

test('the hands-free set never contains an action that can act', () => {
  assert.ok(!CAPABILITY_GAP_HANDS_FREE.includes('schedule_routine'))
  for (const type of CAPABILITY_GAP_HANDS_FREE) {
    assert.ok(CAPABILITY_GAP_ACTION_TYPES.includes(type))
  }
})

/* --------------------------------------------------------------- dispatch */

test('briefing_triage speaks the digest and reports that it sent nothing', async () => {
  /*
   * `sent: false` / `acted: false` are carried out of the brief rather than
   * restated, because nine of the nine asks are conditional on them and a
   * caller should be able to read them off the result without knowing which
   * module produced it.
   */
  const result = await runCapabilityGapAction(
    { type: 'briefing_triage', params: { knownPeople: ['Ada'] } },
    {
      triage: async (options) => {
        assert.deepEqual(options.knownPeople, ['Ada'])
        assert.equal(options.play, false)
        return {
          id: 'btg_1',
          title: 'Morning triage',
          spoken: 'Good morning. 2 things need you.',
          narration: 'Good morning. 2 things need you. One is in the review queue.',
          path: '/tmp/note.md',
          counts: { found: 5, told: 2, queued: 1, drafts: 1 },
          unavailable: [],
          problems: [],
          policySource: 'default',
          sent: false,
          acted: false,
        }
      },
    },
  )

  assert.equal(result.ok, true)
  assert.equal(result.message, 'Good morning. 2 things need you.')
  assert.equal(result.sent, false)
  assert.equal(result.acted, false)
  assert.equal(result.briefing.counts.drafts, 1)
})

test('briefing_triage passes an unreadable source through instead of smoothing it', async () => {
  /*
   * The trap that makes this whole feature untrustworthy if it is lost:
   * EventKit returns [] rather than throwing when unauthorised, so zero events
   * reads identically to a clear day. briefingTriage reports both-empty as
   * unreadable, and a wrapper that dropped `unavailable` on the way out would
   * hand the caller a confident "nothing needs you".
   */
  const result = await runCapabilityGapAction(
    { type: 'briefing_triage', params: {} },
    {
      triage: async () => ({
        id: 'btg_2',
        title: 't',
        spoken: 'Nothing needs you right now.',
        narration: 'Nothing needs you right now. I could not read your calendar and reminders.',
        counts: { found: 0, told: 0, queued: 0, drafts: 0 },
        unavailable: ['your calendar and reminders'],
        problems: ['your calendar and reminders: EventKit returned nothing for both.'],
        policySource: 'default',
        sent: false,
        acted: false,
      }),
    },
  )

  assert.deepEqual(result.briefing.unavailable, ['your calendar and reminders'])
  assert.equal(result.briefing.problems.length, 1)
})

test('review_queue reads and resolves nothing', async () => {
  const result = await runCapabilityGapAction(
    { type: 'review_queue', params: {} },
    {
      queue: ({ includeResolved }) => {
        assert.equal(includeResolved, false)
        return [
          { id: 'q1', title: 'A', draft: { body: 'hi' } },
          { id: 'q2', title: 'B', draft: null },
        ]
      },
    },
  )
  assert.equal(result.waiting, 2)
  assert.equal(result.drafts, 1)
  assert.equal(result.acted, false)
  assert.match(result.message, /nobody has sent/)

  const empty = await runCapabilityGapAction(
    { type: 'review_queue', params: {} },
    { queue: () => [] },
  )
  assert.match(empty.message, /empty/i)
})

test('watch_page builds anchor fields, not selectors, and is idempotent by url', async () => {
  /*
   * Anchors because pageWatch.js's own header explains the cost of the
   * alternative: a CSS selector stops matching the week the site ships a
   * redesign, and the watch then reports "the value is no longer on the page"
   * every poll, at 3am, with nobody there.
   *
   * Real createWatch against a scratch store — the validation, the schedule
   * defaulting and the field normalisation are the parts worth exercising.
   */
  const dir = scratch()
  const filePath = path.join(dir, 'watches.json')
  const deps = {
    addWatch: (input) => createWatch(input, { filePath }),
    watches: () => listWatches({ filePath }),
  }

  const created = await runCapabilityGapAction(
    {
      type: 'watch_page',
      params: {
        url: 'https://example.com/orders',
        name: 'My orders',
        anchors: ['Order status', 'Estimated delivery'],
      },
    },
    deps,
  )
  assert.equal(created.created, true)
  assert.deepEqual(
    created.watch.fields.map((field) => field.anchor),
    ['Order status', 'Estimated delivery'],
  )
  assert.equal(created.watch.fields.every((field) => field.selector === null), true)

  const again = await runCapabilityGapAction(
    { type: 'watch_page', params: { url: 'https://example.com/orders' } },
    deps,
  )
  assert.equal(again.created, false)
  assert.equal(listWatches({ filePath }).length, 1)

  const noUrl = await runCapabilityGapAction({ type: 'watch_page', params: {} }, deps)
  assert.equal(noUrl.ok, false)
  assert.equal(noUrl.status, 'blocked')

  fs.rmSync(dir, { recursive: true, force: true })
})

test('a weekday schedule is refused by name rather than stored as daily', async () => {
  /*
   * The eleven-vote ask says "every WEEKDAY morning" and
   * local-agent/routines.js nextRunAt() understands only daily and interval.
   * A weekday routine written there as daily fires on Saturday morning about a
   * work portal nobody is looking at — and the owner believes it is right,
   * which is worse than it never having been created.
   */
  const created = []
  const deps = {
    addRoutine: (input) => {
      created.push(input)
      return { id: 'rtn_1', ...input }
    },
    routines: () => [],
  }

  const weekday = await runCapabilityGapAction(
    {
      type: 'schedule_routine',
      params: { command: 'check my authenticated work portal every weekday morning', at: '07:00' },
    },
    deps,
  )
  assert.equal(weekday.ok, false)
  assert.equal(weekday.status, 'blocked')
  assert.match(weekday.message, /weekend/i)
  assert.equal(created.length, 0, 'a refused schedule must not be written anyway')

  const withDays = await runCapabilityGapAction(
    { type: 'schedule_routine', params: { command: 'check my accounts', days: ['mon'] } },
    deps,
  )
  assert.equal(withDays.ok, false)
  assert.equal(created.length, 0)
})

test('schedule_routine stores what the store can keep, once', async () => {
  const store = []
  const deps = {
    addRoutine: (input) => {
      const routine = { id: `rtn_${store.length}`, ...input }
      store.push(routine)
      return routine
    },
    routines: () => store,
  }

  const daily = await runCapabilityGapAction(
    { type: 'schedule_routine', params: { command: 'check my logged-in accounts', at: '07:00' } },
    deps,
  )
  assert.equal(daily.created, true)
  assert.deepEqual(daily.routine.schedule, { kind: 'daily', at: '07:00' })

  const repeat = await runCapabilityGapAction(
    { type: 'schedule_routine', params: { command: 'check my logged-in accounts', at: '07:00' } },
    deps,
  )
  assert.equal(repeat.created, false)
  assert.equal(store.length, 1, '"every morning" said twice is one routine')

  /* Below the store's own floor, clamped rather than accepted. */
  const fast = await runCapabilityGapAction(
    { type: 'schedule_routine', params: { command: 'check my accounts', everyMs: 1000 } },
    deps,
  )
  assert.equal(fast.routine.schedule.everyMs, 60_000)

  const noSchedule = await runCapabilityGapAction(
    { type: 'schedule_routine', params: { command: 'check my accounts' } },
    deps,
  )
  assert.equal(noSchedule.ok, false)

  const noCommand = await runCapabilityGapAction(
    { type: 'schedule_routine', params: { at: '07:00' } },
    deps,
  )
  assert.equal(noCommand.ok, false)
})

test('an unknown type is a thrown error, not a quiet success', async () => {
  await assert.rejects(
    () => runCapabilityGapAction({ type: 'open_url', params: {} }),
    /does not handle/,
  )
  assert.equal(isCapabilityGapAction('briefing_triage'), true)
  assert.equal(isCapabilityGapAction('open_url'), false)
})

test('every action type carries a planner schema that says what it is NOT for', () => {
  /*
   * The planner's failure here is not a wrong slot — it is choosing
   * compose_briefing for a request that named authenticated pages, a review
   * queue, or drafts. The description is the only thing that prevents it, so
   * it is asserted rather than assumed.
   */
  for (const type of CAPABILITY_GAP_ACTION_TYPES) {
    const schema = CAPABILITY_GAP_ACTIONS[type]
    assert.equal(typeof schema.description, 'string')
    assert.ok(schema.description.length > 120, `${type} description is too thin to route on`)
    assert.equal(typeof schema.params, 'object')
  }
  assert.match(CAPABILITY_GAP_ACTIONS.briefing_triage.description, /compose_briefing/)
  assert.match(CAPABILITY_GAP_ACTIONS.briefing_triage.description, /never sends/i)
})

/* ------------------------------------------------------------------ audit */

test('misrouting is reported as a distinct and worse verdict than unrouted', async () => {
  /*
   * The finding this whole file exists for. An unrouted request reaches the
   * planner and has a chance. A misrouted one is answered deterministically by
   * a narrower capability, no model is consulted, no error is raised, and the
   * reply sounds like a success.
   */
  const misroute = await resolveRoute('every weekday morning check my work portal', {
    wants: 'briefing_triage',
    router: async () => ({ intent: 'compose_briefing' }),
  })
  assert.equal(misroute.routed, false)
  assert.equal(misroute.misroutedTo, 'compose_briefing')

  const unrouted = await resolveRoute('check my logged-in dashboards', {
    wants: 'briefing_triage',
    router: async () => null,
  })
  assert.equal(unrouted.routed, false)
  assert.equal(unrouted.misroutedTo, null)

  const fine = await resolveRoute('morning triage', {
    wants: 'briefing_triage',
    router: async () => ({ intent: 'briefing_triage' }),
  })
  assert.equal(fine.routed, true)
  assert.equal(fine.misroutedTo, null)
})

test('a schedule is judged by where its command lands, not by its name', async () => {
  /*
   * Measured on this Mac: a routine named "Daily brief: calendar, mail, files"
   * runs the command "give me my morning brief", which resolves to
   * compose_briefing. Reading the store by name would have called that a
   * scheduled cross-account triage.
   */
  const schedules = await schedulesFor('briefing_triage', {
    routines: () => [
      {
        id: 'r1',
        name: 'Daily brief: calendar, mail, files',
        command: 'give me my morning brief',
        schedule: { kind: 'daily', at: '07:00' },
        enabled: true,
      },
      {
        id: 'r2',
        name: 'off',
        command: 'check my logged-in accounts',
        schedule: { kind: 'daily', at: '07:00' },
        enabled: false,
      },
    ],
    router: async (text) =>
      matchBriefingCommand(text) ? { intent: 'compose_briefing' } : null,
  })

  assert.equal(schedules.length, 1, 'a disabled routine is not a schedule')
  assert.equal(schedules[0].hits, false)
  assert.equal(schedules[0].lands, 'compose_briefing')
})

test('a capability is not delivered just because its module imports', async () => {
  const audit = await auditCapability(
    REASKED_CAPABILITIES.find((entry) => entry.id === 'summarize-and-draft'),
    {
      /* Everything downstream missing, module fine. */
      actions: () => ({ types: [] }),
      risk: () => ({ safe: false, reason: 'not on the hands-free allowlist.' }),
      router: async () => null,
      routines: () => [],
      usage: () => ({
        briefingQueuePath: '/nope.json',
        briefingQueueExists: false,
        briefingRuns: 0,
        shelfRows: 0,
        shelfUnplayed: 0,
        triageShelfRows: 0,
        watches: 0,
        watchesEverChecked: 0,
        watchReports: 0,
      }),
      health: () => ({ online: false }),
    },
  )

  assert.equal(audit.verdict, 'partial')
  assert.equal(audit.links.find((entry) => entry.link === 'module').ok, true)
  assert.deepEqual(audit.blocking, [
    'plannerAction',
    'handsFree',
    'voiceRoute',
    'everRun',
  ])
})

test('a dispatchable action the planner cannot name still counts as a gap', async () => {
  /*
   * The two registries fail differently. A type computerControl can dispatch
   * but llmPlanner does not advertise is stripped from every LLM-authored plan
   * by sanitizeActions — the drift capabilityManifest.js was built to catch,
   * and the failure that once let the owner hear a confident summary of a
   * briefing that was never made. Half-wired must not read as wired.
   */
  const audit = await auditCapability(
    REASKED_CAPABILITIES.find((entry) => entry.id === 'summarize-and-draft'),
    {
      actions: () => ({
        types: [{ type: 'briefing_triage', plannerAdvertised: false }],
      }),
      risk: () => ({ safe: true }),
      router: async () => ({ intent: 'briefing_triage' }),
      routines: () => [],
      usage: () => ({
        briefingQueuePath: '/queue.json',
        briefingQueueExists: true,
        briefingRuns: 1,
        shelfRows: 1,
        shelfUnplayed: 0,
        triageShelfRows: 1,
        watches: 0,
        watchesEverChecked: 0,
        watchReports: 0,
      }),
      health: () => ({ online: true }),
    },
  )

  assert.deepEqual(audit.blocking, ['plannerAction'])
  assert.match(
    audit.links.find((entry) => entry.link === 'plannerAction').evidence,
    /sanitizeActions/,
  )
})

test('a fully wired capability audits as delivered', async () => {
  /*
   * The other direction, which matters more: this audit has to be able to say
   * yes, or landing the fix produces the same report and nobody believes it.
   */
  const audit = await auditCapability(
    REASKED_CAPABILITIES.find((entry) => entry.id === 'summarize-and-draft'),
    {
      actions: () => ({ types: [{ type: 'briefing_triage' }] }),
      risk: () => ({ safe: true }),
      router: async () => ({ intent: 'briefing_triage' }),
      routines: () => [],
      usage: () => ({
        briefingQueuePath: '/queue.json',
        briefingQueueExists: true,
        briefingRuns: 3,
        shelfRows: 10,
        shelfUnplayed: 1,
        triageShelfRows: 3,
        watches: 0,
        watchesEverChecked: 0,
        watchReports: 0,
      }),
      health: () => ({ online: true }),
    },
  )

  assert.equal(audit.verdict, 'delivered')
  assert.deepEqual(audit.blocking, [])
})

test('the weekday ask always reports the schedule shape it cannot have', async () => {
  const audit = await auditCapability(
    REASKED_CAPABILITIES.find((entry) => entry.id === 'weekday-work-portal'),
    {
      /* Everything else wired, so the weekday link is the only one left. */
      actions: () => ({ types: [{ type: 'briefing_triage' }] }),
      risk: () => ({ safe: true }),
      router: async () => ({ intent: 'briefing_triage' }),
      routines: () => [
        {
          id: 'r1',
          name: 'morning',
          command: 'check my logged-in accounts',
          schedule: { kind: 'daily', at: '07:00' },
          enabled: true,
        },
      ],
      usage: () => ({
        briefingQueuePath: '/queue.json',
        briefingQueueExists: true,
        briefingRuns: 1,
        shelfRows: 1,
        shelfUnplayed: 0,
        triageShelfRows: 1,
        watches: 0,
        watchesEverChecked: 0,
        watchReports: 0,
      }),
      health: () => ({ online: true }),
    },
  )

  assert.deepEqual(audit.blocking, ['weekdaySchedule'])
  assert.match(
    audit.links.find((entry) => entry.link === 'weekdaySchedule').evidence,
    /Saturday/,
  )
})

test('the relay asks separate the firmware gap from the relay code gap', async () => {
  /*
   * "Announcements do not push" is true and is firmware work. It is also not
   * the only thing wrong: nothing creates an announcement for an ad-hoc
   * delegated job at all, so fixing the firmware would still deliver nothing
   * for "queue this up and tell me when it's done". Waving the item through as
   * "firmware" would hide that.
   */
  const audit = await auditCapability(
    REASKED_CAPABILITIES.find((entry) => entry.id === 'queue-this-up'),
    { announcements: () => ({ readable: true, producers: ['routines.js', 'server.js'], adHocJobPath: false }) },
  )

  assert.equal(audit.verdict, 'partial')
  assert.deepEqual(audit.notOurs, ['push'])
  assert.deepEqual(audit.blocking, ['announceOnDone', 'push'])
  assert.equal(audit.links.find((entry) => entry.link === 'keepsWorking').ok, true)
  assert.equal(audit.links.find((entry) => entry.link === 'statusOnAsk').ok, true)
  assert.match(
    audit.links.find((entry) => entry.link === 'announceOnDone').evidence,
    /not firmware/i,
  )

  /* And it closes the moment a job-completion path announces. */
  const fixed = await auditCapability(
    REASKED_CAPABILITIES.find((entry) => entry.id === 'queue-this-up'),
    { announcements: () => ({ readable: true, producers: ['routines.js', 'server.js', 'jobs.js'], adHocJobPath: true }) },
  )
  assert.deepEqual(fixed.blocking, ['push'])
})

test('the announcement producer scan reads the real relay sources', () => {
  /*
   * Not a fixture: the property being asserted is which files CALL a function,
   * which no export can report, so it is read off disk. If this stops finding
   * routines.js the scan itself has broken and every relay verdict above is
   * meaningless.
   */
  const found = announcementProducers()
  assert.equal(found.readable, true, 'cloud-relay sources are not readable')
  assert.ok(found.producers.includes('routines.js'))
  for (const name of found.producers) {
    assert.ok(name.endsWith('.js'))
    assert.ok(!name.endsWith('.test.js'))
  }
  /* Sanity on the expectation list itself. */
  assert.ok(ANNOUNCEMENT_EXPECTED_PRODUCERS.includes('routines.js'))
})

test('an unreadable relay directory reports as unknown, never as fine', () => {
  const found = announcementProducers({
    read: {
      readdirSync: () => {
        throw new Error('ENOENT')
      },
      readFileSync: () => '',
    },
  })
  assert.equal(found.readable, false)
  assert.equal(found.adHocJobPath, false)
})

test('never-run is reported as never-run, not as nothing-to-report', () => {
  /*
   * The same confusion the brief itself is careful about, one level up: an
   * empty store is what a capability nobody can reach looks like after a
   * month, and it must not read as a quiet week.
   */
  const used = evidenceOfUse({
    queueLocation: () => ({ store: '/nowhere/queue.json' }),
    runs: () => [],
    shelf: () => [
      { id: 'a', played: false },
      { id: 'b', played: false, producer: 'briefingTriage' },
    ],
    watches: () => [{ id: 'w', checkCount: 0, reports: [] }],
    exists: () => false,
  })

  assert.equal(used.briefingQueueExists, false)
  assert.equal(used.briefingRuns, 0)
  assert.equal(used.triageShelfRows, 1)
  assert.equal(used.shelfUnplayed, 2)
  assert.equal(used.watchesEverChecked, 0)
})

test('the full audit runs against the live registries and renders', async () => {
  /*
   * No injection: this is the whole point. The verdicts come from the real
   * action registry, the real hands-free allowlist, the real deterministic
   * router and the real stores, so the report is worth reading on the day
   * somebody breaks a link.
   */
  const audit = await auditCapabilities()

  assert.equal(audit.ok, true)
  assert.equal(audit.items.length, REASKED_CAPABILITIES.length)
  assert.equal(audit.summary.votes, 118)
  /* Sorted by cost of the absence. */
  for (let index = 1; index < audit.items.length; index += 1) {
    assert.ok(audit.items[index - 1].votes >= audit.items[index].votes)
  }
  for (const item of audit.items) {
    assert.ok(['delivered', 'partial', 'missing'].includes(item.verdict))
    assert.ok(item.links.length > 0)
    for (const entry of item.links) {
      assert.equal(typeof entry.evidence, 'string')
      assert.ok(entry.evidence.length > 0, `${item.id}/${entry.link} has no evidence`)
    }
  }

  const text = renderCapabilityGapReport(audit)
  assert.match(text, /Capability gaps/)
  assert.match(text, /built but unreachable/)
})

test('the audit names the module that would close the wiring gaps', async () => {
  const audit = await auditCapabilities()
  assert.equal(audit.wiring.module, 'local-agent/capabilityGapsActions.js')
  assert.deepEqual(audit.wiring.actionTypes, CAPABILITY_GAP_ACTION_TYPES)
})

/* ----------------------------------------------------------------- routes */

test('the audit mounts as one call on an Express-like app', async () => {
  const routes = new Map()
  const app = {
    get: (route, handler) => routes.set(route, handler),
    post: () => {},
  }
  registerCapabilityGapsRoutes(app)
  assert.ok(routes.has('/capabilities/gaps'))

  let payload = null
  let contentType = null
  await routes.get('/capabilities/gaps')(
    { query: {} },
    {
      json: (body) => {
        payload = body
      },
      status() {
        return this
      },
      type(value) {
        contentType = value
        return this
      },
      send: (body) => {
        payload = body
      },
    },
  )
  assert.equal(payload.ok, true)
  assert.equal(contentType, null)
  assert.equal(payload.items.length, REASKED_CAPABILITIES.length)

  await routes.get('/capabilities/gaps')(
    { query: { format: 'text' } },
    {
      json: () => {},
      status() {
        return this
      },
      type(value) {
        contentType = value
        return this
      },
      send: (body) => {
        payload = body
      },
    },
  )
  assert.equal(contentType, 'text/plain')
  assert.match(payload, /Capability gaps/)

  assert.throws(() => registerCapabilityGapsRoutes(null), /Express-like/)
})

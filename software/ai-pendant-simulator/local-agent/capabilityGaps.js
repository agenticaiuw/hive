/*
 * Whether this system can actually be ASKED for the things it has already
 * built.
 *
 * Nine capability proposals, 11 to 18 votes each, re-asked for work that had
 * just landed. The obvious readings are that the builds do not deliver, or
 * that nothing tells anyone they exist. Measured here, on this checkout,
 * neither is quite it:
 *
 *   The modules deliver. briefingTriage.js, pageWatch.js, pageWatchSignal.js,
 *   audioBrief.js, cloud-relay/scheduler.js and cloud-relay/routines.js are
 *   present, coherent, and 174 of their tests pass. Run directly, they do the
 *   thing.
 *
 *   The modules cannot be reached. There is no action type, no deterministic
 *   route, no hands-free verdict and no schedule that lands on any of them.
 *   Every path a request can take — pendant, dashboard, routine — dead-ends
 *   somewhere before the module, and the dead end is different for each.
 *
 * A capability whose last link is broken is indistinguishable, from outside,
 * from a capability that was never built. That is the whole of this file's
 * subject.
 *
 * WHY AN AUDIT AND NOT JUST A FIX. The fix is capabilityGapsActions.js, and it
 * needs four one-line edits in files this agent does not own. Those edits will
 * land, and later something will move and one of the links will break again —
 * a matcher reordered, an action renamed, a routine edited. The failure is
 * silent every time: nothing throws when a capability becomes unaskable, the
 * tests of the module itself keep passing, and the only symptom is a tenth
 * proposal asking for it again. So the chain is CHECKED, at runtime, against
 * the live registries rather than asserted in a comment. Every verdict below
 * is computed; none is written down.
 *
 * THE ONE THING IT WILL NOT DO is call a capability "delivered" because the
 * code exists. Six links are checked per ask, and the module being importable
 * is only the first.
 */

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { classifyAction } from './actionRisk.js'
import { describeActions } from './capabilityManifest.js'
import { matchBriefingCommand } from './briefing.js'
import { briefingQueueLocation, listBriefingRuns } from './briefingQueue.js'
import { listBriefings } from './audioBrief.js'
import {
  CAPABILITY_GAP_ACTION_TYPES,
  matchMorningTriageCommand,
  matchWatchPageCommand,
} from './capabilityGapsActions.js'
import { listWatches, watchHealth } from './pageWatch.js'
import { matchDeterministic } from './policyRouter.js'
import { listRoutines, nextRunAt } from './routines.js'

const RELAY_DIR = path.join(
  path.dirname(fileURLToPath(import.meta.url)),
  '..',
  'cloud-relay',
)

/* --------------------------------------------------------------- the asks */

/*
 * The owner's words, not a paraphrase.
 *
 * Kept verbatim because the phrasing IS the test input: the misrouting this
 * file found is a property of the exact sentence, and a tidied-up version of
 * it routes differently. `votes` is carried so a regression report can be
 * ordered by how much the absence costs.
 */
export const REASKED_CAPABILITIES = Object.freeze([
  {
    id: 'morning-cross-account',
    votes: 14,
    ask: 'Every morning, check my private calendar, travel reservations, and important account notifications in Safari',
    /* Short forms matter more than the full sentence: policyRouter refuses the
     * deterministic path above 90 characters, so what a person actually says
     * to a worn pendant is the phrase that gets misrouted. */
    spoken: ['every morning check my logged-in accounts', 'morning triage'],
    covers: ['briefingTriage.js'],
    wants: 'briefing_triage',
  },
  {
    id: 'weekday-work-portal',
    votes: 11,
    ask: 'Every weekday morning, check my authenticated work portal for new high-priority items and tell me only what needs my attention',
    spoken: [
      'every weekday morning check my authenticated work portal',
      'tell me only what needs my attention on my work portal',
    ],
    covers: ['briefingTriage.js'],
    wants: 'briefing_triage',
    /* This one alone needs a schedule the Mac store cannot express. */
    needsWeekdaySchedule: true,
  },
  {
    id: 'dashboards-what-changed',
    votes: 11,
    ask: 'Every morning, check my logged-in work dashboards and tell me only what changed or needs my attention',
    spoken: ['check my logged-in work dashboards', 'tell me only what changed'],
    covers: ['briefingTriage.js', 'pageWatch.js'],
    wants: 'briefing_triage',
  },
  {
    id: 'audio-digest',
    votes: 11,
    ask: 'Every morning, give me a 30-second audio digest of what changed: calendar, reminders, and top emails',
    spoken: ['give me a digest of what changed', 'thirty second digest of what changed'],
    covers: ['briefingTriage.js', 'audioBrief.js'],
    wants: 'briefing_triage',
    /* The only ask whose artifact is a file on a shelf with a cap on it. */
    needsAudioShelf: true,
  },
  {
    id: 'watch-authenticated-pages',
    votes: 14,
    ask: 'Watch my authenticated order, appointment, and account pages for changes, and tell me only when a meaningful change happens',
    spoken: ['watch example.com/orders and tell me when it changes'],
    covers: ['pageWatch.js', 'pageWatchSignal.js'],
    wants: 'watch_page',
  },
  {
    id: 'keep-working-after-i-leave',
    votes: 11,
    ask: 'When I ask you to do something that takes time, keep working after I leave and tell me exactly what happened when it is done',
    spoken: [],
    covers: ['cloud-relay/scheduler.js', 'cloud-relay/routines.js', 'cloud-relay/announce.js'],
    /* Nothing on the Mac answers this one: the work continues because the
     * relay owns the job queue and the bridge long-polls it. Marked so the
     * audit reports honestly instead of failing a local link that was never
     * this half's to satisfy. */
    venue: 'relay',
  },
  {
    id: 'queue-this-up',
    votes: 11,
    ask: 'Queue this up and tell me when it is done',
    spoken: [],
    covers: ['cloud-relay/scheduler.js', 'cloud-relay/routines.js', 'cloud-relay/announce.js'],
    venue: 'relay',
  },
  {
    id: 'summarize-and-draft',
    votes: 18,
    ask: 'Check my logged-in web accounts for anything urgent, summarize it, and draft (but do not send) any replies',
    spoken: ['check my logged-in accounts and draft replies but do not send them'],
    covers: ['briefingTriage.js', 'mailTriage.js'],
    wants: 'briefing_triage',
  },
  {
    id: 'review-queue-not-acting',
    votes: 17,
    ask: 'Check my authenticated browser accounts for anything that needs my attention, then put findings in a review queue instead of acting',
    spoken: ['put what you find in a review queue', 'what is in my review queue'],
    covers: ['briefingTriage.js', 'briefingQueue.js'],
    wants: 'briefing_triage',
  },
])

/* ------------------------------------------------------------- the routing */

/**
 * Where one sentence actually goes today, and where it should have gone.
 *
 * MISROUTED IS A DISTINCT AND WORSE VERDICT THAN UNROUTED, which is why this
 * returns three fields rather than a boolean. An unrouted request reaches the
 * planner, which has a chance of improvising something reasonable and will
 * usually say what it did. A misrouted one is answered confidently and
 * deterministically by a NARROWER capability — no model is consulted, no error
 * is raised, and the reply sounds like a success. That is the shape of "we
 * already built that": the owner asks for the cross-account brief and is
 * handed the calendar-and-mail brief, every time, with no signal that a
 * substitution occurred.
 */
export async function resolveRoute(phrase, { wants = null, router = matchDeterministic } = {}) {
  const text = String(phrase || '')
  const deterministic = await router(text)
  const intent = deterministic?.intent ?? null

  return {
    phrase: text,
    wants,
    deterministicIntent: intent,
    /* What briefing.js would claim if it were consulted. Reported even when
     * the deterministic table declined the phrase for length, because it is
     * what will happen the moment the owner says the short version. */
    briefingKind: matchBriefingCommand(text),
    triageMatches: Boolean(matchMorningTriageCommand(text)),
    watchMatches: Boolean(matchWatchPageCommand(text)),
    routed: wants ? intent === wants : Boolean(intent),
    misroutedTo: wants && intent && intent !== wants ? intent : null,
  }
}

/* --------------------------------------------------------------- the links */

const link = (name, ok, evidence) => ({ link: name, ok: Boolean(ok), evidence })

/*
 * Whether a routine actually lands on a capability.
 *
 * A routine's command is planned and executed exactly like a spoken one, so
 * "is there a morning schedule for this?" is not a question about the routine
 * store — it is a question about where the routine's TEXT routes. Measured on
 * this Mac: a routine named "Daily brief: calendar, mail, files" runs the
 * command "give me my morning brief", which resolves to compose_briefing. The
 * name promises the cross-account brief and the command does not deliver it,
 * and reading the store without resolving the command would have called that a
 * scheduled morning triage.
 */
export async function schedulesFor(wants, { routines = listRoutines, router = matchDeterministic } = {}) {
  const all = routines().filter((routine) => routine.enabled !== false)
  const resolved = []
  for (const routine of all) {
    const route = await resolveRoute(routine.command, { wants, router })
    resolved.push({
      id: routine.id,
      name: routine.name,
      command: routine.command,
      schedule: routine.schedule,
      lands: route.deterministicIntent ?? (route.triageMatches ? wants : null),
      hits: route.deterministicIntent === wants || (wants === 'briefing_triage' && route.triageMatches),
    })
  }
  return resolved
}

/* ------------------------------------------------------------- the relay */

/*
 * WHO CAN ORIGINATE A MESSAGE TO THE OWNER.
 *
 * "Tell me exactly what happened when it's done" is two separate mechanisms
 * and they fail separately, so they are checked separately.
 *
 *   PULL — the owner presses the button and asks. openaiRealtimeVoice.js's
 *     relay_job_status tool answers from the relay's own job records with no
 *     Mac round trip, and its schema forbids upgrading the wording ("if it
 *     says failed, queued, or unknown, say that"). This half works.
 *
 *   PUSH — something the owner did not ask for reaches their ear.
 *     announce.js is the outbound queue and pendantConverse.js flushes it at
 *     the start of the next conversation. Two things gate it, and only one of
 *     them is firmware:
 *
 *       1. The firmware drops binary downlink unless convo_started is set, so
 *          nothing arrives until the next button press. That is firmware work
 *          and is out of scope here — recorded, not owned.
 *
 *       2. NOTHING CREATES AN ANNOUNCEMENT FOR AN AD-HOC DELEGATED JOB. Every
 *          createAnnouncement() call site outside announce.js itself is either
 *          a routine path in routines.js or the manual POST /v1/announcements
 *          route in server.js. A `mac_delegate` job — which is what "queue
 *          this up and tell me when it's done" actually becomes — completes,
 *          writes its result into the job record, and queues nothing for the
 *          owner's ear. So even with the firmware fixed, that sentence
 *          delivers nothing and the owner has to remember to ask. That is a
 *          relay code gap, not a firmware one, and it is why this check exists
 *          rather than the whole item being waved through as "firmware".
 *
 * Checked by reading the relay sources rather than by importing them: the
 * property in question is which files CALL a function, which no export can
 * report. Shaped to pass the moment a job-completion path starts announcing.
 */
export const ANNOUNCEMENT_EXPECTED_PRODUCERS = Object.freeze([
  'routines.js',
  'server.js',
])

export function announcementProducers({ dir = RELAY_DIR, read = fs } = {}) {
  let files
  try {
    files = read
      .readdirSync(dir)
      .filter((name) => name.endsWith('.js') && !name.endsWith('.test.js'))
  } catch {
    return { readable: false, producers: [], adHocJobPath: false }
  }

  const producers = []
  for (const name of files) {
    /* announce.js DEFINES createAnnouncement; defining it is not queuing one. */
    if (name === 'announce.js') continue
    let source
    try {
      source = read.readFileSync(path.join(dir, name), 'utf8')
    } catch {
      continue
    }
    if (/\bcreateAnnouncement\s*\(/.test(source)) producers.push(name)
  }

  return {
    readable: true,
    producers,
    /* True once some file other than the routine scheduler and the manual
     * route queues speech — i.e. once a finished ad-hoc job announces itself. */
    adHocJobPath: producers.some(
      (name) => !ANNOUNCEMENT_EXPECTED_PRODUCERS.includes(name),
    ),
  }
}

/**
 * Has this capability ever actually produced anything on this machine?
 *
 * The last link, and the only one that cannot be faked by wiring. An action
 * type that dispatches, a matcher that matches and a routine that fires still
 * add up to nothing if no artifact was ever written — and an empty store is
 * exactly what a capability nobody can reach looks like after a month.
 */
export function evidenceOfUse({
  queueLocation = briefingQueueLocation,
  runs = listBriefingRuns,
  shelf = listBriefings,
  watches = listWatches,
  exists = fs.existsSync,
} = {}) {
  const location = queueLocation()
  const queuePath = typeof location === 'string' ? location : location?.store
  const queueExists = Boolean(queuePath && exists(queuePath))

  let briefingRuns = []
  if (queueExists) {
    try {
      briefingRuns = runs({ limit: 10 })
    } catch {
      /* An unreadable store is not a run, and the count below says so. */
    }
  }

  const rows = shelf({ limit: 50 })
  const triageRows = rows.filter((row) => row?.producer === 'briefingTriage')
  const watchList = watches()

  return {
    briefingQueuePath: queuePath ?? null,
    briefingQueueExists: queueExists,
    briefingRuns: briefingRuns.length,
    shelfRows: rows.length,
    shelfUnplayed: rows.filter((row) => !row?.played).length,
    triageShelfRows: triageRows.length,
    watches: watchList.length,
    watchesEverChecked: watchList.filter((watch) => Number(watch.checkCount) > 0).length,
    watchReports: watchList.reduce((total, watch) => total + (watch.reports?.length ?? 0), 0),
  }
}

/* ---------------------------------------------------------------- the audit */

/**
 * One ask, resolved end to end.
 *
 * The verdict is derived from the links, never stated:
 *   delivered — every link this ask needs is intact.
 *   partial   — the module is there and something downstream is not.
 *   missing   — the module itself cannot be loaded.
 *
 * `blocking` is the ordered list of what to fix, and it is the point of the
 * whole function: "partial" on its own is no more actionable than a tenth
 * proposal.
 */
export async function auditCapability(entry, deps = {}) {
  const {
    actions = describeActions,
    risk = classifyAction,
    router = matchDeterministic,
    routines = listRoutines,
    usage = evidenceOfUse,
    health = watchHealth,
  } = deps

  const links = []
  const advertised = new Set(actions().types.map((item) => item.type))

  /*
   * Relay-venue asks. The live job queue and announcement store are in another
   * process and are not guessed at — but "not my process" is not the same as
   * "fine", and waving the whole item through as firmware work would hide a
   * relay code gap behind a firmware one.
   */
  if (entry.venue === 'relay') {
    const { announcements = announcementProducers } = deps
    links.push(
      link(
        'keepsWorking',
        true,
        'The relay owns the job queue and the Mac bridge long-polls it, so work continues after the owner walks away and survives the lid closing. Nothing here depends on the pendant staying connected.',
      ),
    )
    links.push(
      link(
        'statusOnAsk',
        true,
        'relay_job_status resolves a vague spoken reference against recent relay jobs and answers in one sentence with the Mac asleep. Its schema forbids upgrading the wording, and jobRecall.js reports a terminal job with no result as NOT done.',
      ),
    )

    const announce = announcements()
    links.push(
      link(
        'announceOnDone',
        announce.adHocJobPath,
        announce.readable
          ? announce.adHocJobPath
            ? `An announcement is queued outside the routine scheduler: ${announce.producers.join(', ')}.`
            : `Only ${announce.producers.join(' and ')} call createAnnouncement, and both are routine paths or the manual POST route. An ad-hoc mac_delegate job — which is what "queue this up and tell me when it's done" becomes — finishes, writes its result into the job record, and queues nothing for the owner's ear. RELAY CODE, not firmware: fixing the firmware would still deliver nothing here.`
          : 'cloud-relay sources are not readable from this process, so the announcement producers could not be checked.',
      ),
    )
    links.push(
      link(
        'push',
        false,
        'FIRMWARE, NOT THIS CODEBASE. The nRF9160 drops binary downlink unless convo_started is set, so an announcement waits for the owner\'s next button press however promptly it is queued. announce.js and pendantConverse.js already do their half: the queue exists and is flushed at the start of the next conversation.',
      ),
    )

    const blockingRelay = links.filter((item) => !item.ok).map((item) => item.link)
    return {
      ...entry,
      verdict: 'partial',
      /* Named so a reader does not have to work out which of the two failing
       * links is someone else's job. */
      notOurs: ['push'],
      links,
      blocking: blockingRelay,
    }
  }

  /* 1. The module. */
  let moduleOk = true
  let moduleNote = `${entry.covers.join(', ')} import cleanly.`
  try {
    for (const file of entry.covers.filter((name) => !name.includes('/'))) {
      await import(`./${file}`)
    }
  } catch (error) {
    moduleOk = false
    moduleNote = `${entry.covers.join(', ')}: ${String(error?.message || error).slice(0, 200)}`
  }
  links.push(link('module', moduleOk, moduleNote))

  if (!moduleOk) {
    return { ...entry, verdict: 'missing', links, blocking: ['module'] }
  }

  /*
   * 2. A planner action type, in BOTH registries.
   *
   * There are two and they fail differently, which is why one boolean will not
   * do. computerControl.js's switch decides what can be dispatched;
   * llmPlanner.js's schema decides what a model is allowed to name. A type in
   * the first and not the second is dispatchable but stripped from every
   * LLM-authored plan by sanitizeActions — the drift capabilityManifest.js
   * exists to surface, and the failure that once let the owner hear a
   * confident summary of a briefing that was never made. A type in the second
   * and not the first is a plan that names an action the executor throws on.
   *
   * Without one the model cannot emit the call, so every long-form request —
   * which is all of them, since policyRouter refuses the deterministic path
   * above 90 characters — has nowhere to land.
   */
  const dispatched = actions().types.find((item) => item.type === entry.wants)
  const hasAction = Boolean(dispatched?.plannerAdvertised ?? advertised.has(entry.wants))
  links.push(
    link(
      'plannerAction',
      hasAction,
      hasAction
        ? `${entry.wants} is dispatchable and advertised to the planner.`
        : dispatched
          ? `${entry.wants} dispatches but is missing from llmPlanner's schema, so sanitizeActions strips it out of every plan that names it.`
          : `No ${entry.wants} action type exists. The executor dispatches ${advertised.size} types and none of them reaches this module.`,
    ),
  )

  /* 3. Hands-free. The pendant has no dashboard, so "waiting for your approval
   * on the dashboard" is where a blocked request ends. */
  const verdict = risk({ type: entry.wants, params: {} })
  links.push(
    link(
      'handsFree',
      verdict.safe,
      verdict.safe
        ? `${entry.wants} runs from the pendant without a confirmation.`
        : `${entry.wants} is blocked hands-free: ${verdict.reason} A worn pendant has no dashboard to approve on.`,
    ),
  )

  /* 4. Routing, per spoken phrasing. Misrouting is called out by name. */
  const routes = []
  for (const phrase of entry.spoken ?? []) {
    routes.push(await resolveRoute(phrase, { wants: entry.wants, router }))
  }
  const misrouted = routes.filter((route) => route.misroutedTo)
  const routedOk = routes.length > 0 && routes.every((route) => route.routed)

  /*
   * "No matcher exists" and "a matcher exists and is not spliced in" are the
   * same symptom and completely different work, so they are never reported as
   * the same sentence. The second is one line in policyRouter.js; the first is
   * a design problem.
   */
  const wouldMatch = routes.filter(
    (route) => route.triageMatches || route.watchMatches,
  )
  const remedy = wouldMatch.length
    ? ` capabilityGapsActions.js already matches ${wouldMatch.length} of ${routes.length} phrasings here; CAPABILITY_GAP_MATCHERS is not spliced into policyRouter.DETERMINISTIC_MATCHERS above the compose_briefing entry.`
    : ''

  links.push(
    link(
      'voiceRoute',
      routedOk,
      misrouted.length
        ? `Misrouted: ${misrouted
            .map((route) => `"${route.phrase}" resolves deterministically to ${route.misroutedTo}`)
            .join('; ')}. No model is consulted, so the owner is handed a narrower capability with no signal that a substitution happened.${remedy}`
        : routedOk
          ? 'Every spoken phrasing resolves to this capability.'
          : `No spoken phrasing resolves here. ${
              routes.some((route) => route.briefingKind)
                ? routes
                    .filter((route) => route.briefingKind)
                    .map(
                      (route) =>
                        `"${route.phrase}" is claimed by briefing.js as a ${route.briefingKind} brief as soon as it is short enough for the deterministic table`,
                    )
                    .join('; ')
                : 'They fall through to the planner, which has no action to emit.'
            }${remedy}`,
    ),
  )

  /* 5. A schedule that lands here. Only for the asks that said "every". */
  const wantsSchedule = /\bevery\b/i.test(entry.ask)
  if (wantsSchedule) {
    const schedules = await schedulesFor(entry.wants, { routines, router })
    const hit = schedules.filter((routine) => routine.hits)
    links.push(
      link(
        'schedule',
        hit.length > 0,
        hit.length
          ? `${hit.map((routine) => `"${routine.name}"`).join(', ')} runs this on a schedule.`
          : `No enabled routine's command resolves to ${entry.wants}. ${
              schedules.length
                ? `The ${schedules.length} that exist land on: ${[
                    ...new Set(schedules.map((routine) => routine.lands ?? 'the planner')),
                  ].join(', ')}.`
                : 'There are no routines at all.'
            }`,
      ),
    )
  }

  /*
   * 6. Weekday support, for the one ask that needs it.
   *
   * PROBED, not asserted. This link was a hardcoded `false` carrying a hardcoded
   * sentence about what routines.js could not do. The store learned `weekly`
   * afterwards and the audit went on reporting the gap — an audit that states a
   * conclusion instead of measuring one is the exact failure it exists to catch,
   * and it was wrong about its own codebase for as long as the constant stood.
   *
   * So ask nextRunAt. Friday evening asking for a weekday 07:00 must answer
   * Monday; answering Saturday is the bug this is looking for, and answering
   * null means the shape is not stored at all.
   */
  if (entry.needsWeekdaySchedule) {
    const probe = deps.nextRunAt ?? nextRunAt
    let ok = false
    let detail
    try {
      /* A Friday 18:00 with a Monday-Friday set: the only correct answer is the
       * following Monday, and it is the answer daily gets wrong. */
      const friday = new Date('2026-08-07T18:00:00').getTime()
      const next = probe({ kind: 'weekly', at: '07:00', days: [1, 2, 3, 4, 5] }, friday)
      if (next === null || next === undefined) {
        detail =
          'local-agent/routines.js nextRunAt() returns nothing for {kind:"weekly"}, so "every weekday morning" cannot be stored. Storing it as daily fires on Saturday.'
      } else {
        const day = new Date(next).getDay()
        ok = day >= 1 && day <= 5
        detail = ok
          ? `local-agent/routines.js stores {kind:"weekly", days:[...]}; asked from a Friday evening it answers ${new Date(next).toDateString()}, matching cloud-relay/routineSchedule.js so a routine means the same thing on both sides.`
          : `local-agent/routines.js accepted {kind:"weekly"} but answered ${new Date(next).toDateString()}, which is not a weekday — the schedule would fire on a day the owner excluded.`
      }
    } catch (error) {
      detail = `local-agent/routines.js nextRunAt() threw on {kind:"weekly"}: ${error.message}`
    }
    links.push(link('weekdaySchedule', ok, detail))
  }

  /* 7. Anything actually produced. */
  const used = usage()

  /*
   * 7a. Whether the digest survives being stored.
   *
   * audioBrief.js caps the shelf at a COUNT and slices unconditionally, so the
   * 51st brief evicts the oldest row whether or not the owner ever heard it.
   * briefingTriage.js's dedupe stops this module producing the 44 identical
   * copies that once ate the shelf, and its supersede list retires only rows
   * carrying its own producer — correctly, since a research brief someone is
   * saving for the train is not its to delete. Neither of those helps when the
   * shelf is already full of somebody else's unplayed rows, which is the state
   * measured here. The first triage brief written on this Mac evicts a brief
   * the owner has not heard.
   */
  if (entry.needsAudioShelf) {
    const saturated = used.shelfUnplayed >= 50
    links.push(
      link(
        'audioShelf',
        !saturated,
        saturated
          ? `The shelf holds ${used.shelfRows} rows and ${used.shelfUnplayed} of them are unplayed. saveBriefing() slices to a fixed COUNT regardless of played state, so the next brief of any kind evicts one the owner never heard. briefingTriage supersedes only its own producer rows, and ${used.triageShelfRows} of these carry it.`
          : `${used.shelfUnplayed} of ${used.shelfRows} shelf rows unplayed — room before the count cap starts evicting unheard briefs.`,
      ),
    )
  }
  if (entry.wants === 'watch_page') {
    const watchHealthNow = health()
    links.push(
      link(
        'everRun',
        used.watchesEverChecked > 0,
        `${used.watches} watch${used.watches === 1 ? '' : 'es'} defined, ${used.watchesEverChecked} ever polled, ${used.watchReports} report${used.watchReports === 1 ? '' : 's'} raised. Browser extension ${watchHealthNow.online ? 'online' : 'OFFLINE — nothing is being checked right now, which reads identically to nothing changing'}.`,
      ),
    )
  } else {
    links.push(
      link(
        'everRun',
        used.briefingQueueExists && used.briefingRuns > 0,
        used.briefingQueueExists
          ? `${used.briefingRuns} recorded run${used.briefingRuns === 1 ? '' : 's'}, ${used.triageShelfRows} of ${used.shelfRows} audio shelf rows produced by briefingTriage.`
          : `Never run: ${used.briefingQueuePath} does not exist and ${used.triageShelfRows} of ${used.shelfRows} audio shelf rows carry this producer.`,
      ),
    )
  }

  const blocking = links.filter((item) => !item.ok).map((item) => item.link)
  return {
    ...entry,
    verdict: blocking.length ? 'partial' : 'delivered',
    links,
    blocking,
  }
}

/** All nine, in vote order. */
export async function auditCapabilities(deps = {}) {
  const items = []
  for (const entry of REASKED_CAPABILITIES) {
    items.push(await auditCapability(entry, deps))
  }
  items.sort((left, right) => right.votes - left.votes)

  const counted = (name) => items.filter((item) => item.verdict === name).length
  return {
    ok: true,
    generatedAt: new Date().toISOString(),
    summary: {
      asks: items.length,
      votes: items.reduce((total, item) => total + item.votes, 0),
      delivered: counted('delivered'),
      partial: counted('partial'),
      missing: counted('missing'),
      /* The single number worth watching. Every one of these is a module that
       * works and cannot be asked for. */
      builtButUnreachable: items.filter(
        (item) =>
          item.verdict === 'partial' &&
          item.links.find((entry) => entry.link === 'module')?.ok === true,
      ).length,
      /* Gaps this codebase cannot close: the firmware downlink gate. Counted
       * separately so a report cannot be read as "nine things we failed to
       * ship" when one of them is a device that has not been reflashed. */
      blockedElsewhere: items.filter((item) => (item.notOurs ?? []).length).length,
    },
    /* Named so a reader does not have to rediscover which types are new. */
    wiring: {
      actionTypes: CAPABILITY_GAP_ACTION_TYPES,
      module: 'local-agent/capabilityGapsActions.js',
    },
    items,
  }
}

/** One screen of text, for a terminal or a log line. */
export function renderCapabilityGapReport(audit) {
  const lines = [
    `# Capability gaps — ${audit.summary.asks} re-asked capabilities, ${audit.summary.votes} votes`,
    '',
    `delivered ${audit.summary.delivered} · partial ${audit.summary.partial} · missing ${audit.summary.missing}`,
    `built but unreachable: ${audit.summary.builtButUnreachable} · blocked outside this codebase: ${audit.summary.blockedElsewhere}`,
    '',
  ]
  for (const item of audit.items) {
    lines.push(`## ${item.verdict.toUpperCase()} — ${item.ask} (x${item.votes})`)
    for (const entry of item.links) {
      const ours = (item.notOurs ?? []).includes(entry.link)
      lines.push(
        `  ${entry.ok ? 'ok  ' : ours ? 'n/a ' : 'GAP '} ${entry.link}: ${entry.evidence}`,
      )
    }
    lines.push('')
  }
  return lines.join('\n')
}

/* ------------------------------------------------------------------ routes */

/**
 * Wire the audit onto an existing Express app.
 *
 * A registration function rather than route definitions in server.js, for the
 * reason briefingTriage.js gives for the same choice: several agents are
 * editing that file and a feature that lands as one import and one call does
 * not produce a merge conflict.
 */
export function registerCapabilityGapsRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function') {
    throw new Error('registerCapabilityGapsRoutes needs an Express-like app.')
  }

  app.get('/capabilities/gaps', async (request, response) => {
    try {
      const audit = await auditCapabilities(deps)
      if (String(request.query?.format || '') === 'text') {
        response.type('text/plain').send(renderCapabilityGapReport(audit))
        return
      }
      response.json(audit)
    } catch (error) {
      response.status(500).json({ ok: false, error: String(error?.message || error) })
    }
  })

  return app
}

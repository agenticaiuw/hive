/*
 * The four action types that were missing, and the reason nine proposals
 * re-asked for work that was already finished.
 *
 * Every module named in those nine asks exists, is tested, and does what it
 * says. briefingTriage.js reads across calendar, reminders, mail and the
 * owner's authenticated pages and comes back with three sentences and a review
 * queue. pageWatch.js + pageWatchSignal.js watch a logged-in page and stay
 * quiet unless something meaningful moved. cloud-relay/routines.js keeps a 7am
 * promise with the lid closed. 174 tests across those files pass.
 *
 * None of them can be asked for.
 *
 * Measured on this checkout, not inferred:
 *
 *   - llmPlanner.js advertises 95 action types. None of them runs the morning
 *     triage, creates a page watch, or creates a routine. A planner cannot
 *     emit an action that does not exist, so the entire cross-account brief is
 *     unreachable from any spoken sentence.
 *   - matchBriefingTriageCommand() is exported from briefingTriage.js and
 *     imported by nothing but its own test. Its header says it is "matched
 *     AFTER briefing.js's own patterns by the caller". There is no caller.
 *   - Worse than unreachable: MISROUTED. briefing.js's COMMAND_PATTERNS claim
 *     /\bevery\s+(?:week)?day?\s*morning\b/, so "every weekday morning check my
 *     work portal" resolves DETERMINISTICALLY to compose_briefing — the older,
 *     narrower brief that reads calendar, mail and files, has no review queue,
 *     drafts nothing, and never opens an authenticated page. No model is ever
 *     consulted. The owner asks for the new thing and is silently handed the
 *     old one, which is exactly what "we already built that" feels like from
 *     the outside.
 *   - Three of the six asks briefingTriage is meant to answer do not match its
 *     own matcher either: it requires the words accounts/tabs/sites next to
 *     logged-in/authenticated, and the owner said "authenticated work portal"
 *     and "logged-in work dashboards".
 *
 * So this file is not new capability. It is the wiring loom: planner schemas,
 * a dispatch, deterministic matchers, and a hands-free verdict for the four
 * verbs that had no way in. Every one of them delegates immediately to the
 * module that already does the work, and none of them re-implements any of it.
 *
 * WHAT IT DELIBERATELY DOES NOT DO: it does not paper over a schedule the
 * local store cannot express. "Every weekday morning" is item two's own
 * wording, and local-agent/routines.js nextRunAt() understands only `daily`
 * and `interval` — a weekday routine stored as daily fires on Saturday. That
 * is refused with the missing support named, rather than accepted and quietly
 * downgraded. A capability that says yes and does something adjacent is how
 * this whole class of bug started.
 */

/*
 * HOW THIS GETS WIRED IN — five insertions, in files this agent does not own.
 * Each is one import plus one splice, except the dispatch, which has to be
 * case labels for the reason given below. GET /capabilities/gaps reports which
 * of them have landed, so none of this has to be remembered.
 *
 *   1. llmPlanner.js — inside FULL_CONTROL_ACTION_SCHEMA:
 *          ...CAPABILITY_GAP_ACTIONS,
 *      This is also what makes isKnownActionType() accept them; without it
 *      sanitizeActions strips the action out of every plan that names it.
 *
 *   2. computerControl.js — inside `switch (action.type)`, as real case
 *      labels, NOT a guard before the switch:
 *          case 'briefing_triage':
 *          case 'review_queue':
 *          case 'watch_page':
 *          case 'schedule_routine':
 *            return runCapabilityGapAction(action)
 *      readDispatchableActionTypes() parses this file's own source for
 *      `case '...':` between the switch and its throw, so an early return
 *      would execute correctly and still be invisible to GET /capabilities —
 *      the manifest would report the types as planner-advertised but not
 *      dispatchable, which is precisely the drift it was built to catch.
 *
 *   3. policyRouter.js — in DETERMINISTIC_MATCHERS, ABOVE the compose_briefing
 *      entry:
 *          ...CAPABILITY_GAP_MATCHERS,
 *      Order is the whole point. Below it, briefing.js's `every weekday
 *      morning` pattern still claims the sentence first.
 *
 *   4. actionRisk.js — first line of classifyAction():
 *          const gap = capabilityGapHandsFree(action); if (gap) return gap
 *      It returns null for anything else, so no existing verdict moves.
 *
 *   5. server.js — beside the other registration calls:
 *          registerCapabilityGapsRoutes(app)
 *
 * NOTHING IS IMPORTED AT MODULE SCOPE, and that is load-bearing rather than
 * tidy. Three consumers want only the cheap half of this file: policyRouter.js
 * wants the matchers on every spoken command, actionRisk.js wants the
 * hands-free verdict on every pendant plan, and capabilityGaps.js wants both
 * to run an audit. All three are hot paths, and briefingTriage.js alone pulls
 * in appleData, mailTriage, audioBrief, pageWatch and evidenceCapsules.
 *
 * So the matchers and the schemas are pure — regex and frozen objects — and
 * the modules that do the work load inside the dispatch, when an action is
 * actually run. Same reasoning computerControl.js gives for its own lazy
 * imports: an action nobody used should not cost a Calendar or Mail import at
 * boot.
 */

/* ------------------------------------------------------------------ schemas */

/**
 * llmPlanner.js's ACTIONS shape: `{ description, params }` per type.
 *
 * The descriptions carry the routing rules, not just the parameters, because
 * the planner's failure mode here is not "wrong slot" — it is choosing
 * compose_briefing for a request that named authenticated pages, a review
 * queue, or drafts. Each description therefore says what it is NOT for, in the
 * same style as the triage_inbox entry that already works.
 */
export const CAPABILITY_GAP_ACTIONS = Object.freeze({
  briefing_triage: {
    description:
      "Read ACROSS the owner's calendar, reminders, unread mail AND their logged-in/authenticated pages, rank what actually needs them, say at most three things out loud as a ~30 second digest, draft replies for the rest, and leave everything else in a REVIEW QUEUE. Use whenever the request names authenticated/logged-in/signed-in accounts, portals, dashboards or web accounts; or says 'only what changed' / 'only what needs my attention'; or asks for a review queue; or asks to draft but NOT send. Prefer this over compose_briefing for any of those — compose_briefing reads only calendar, mail and files, has no review queue and opens no web page. It composes, stores and speaks; it never sends, replies or acts.",
    params: {
      knownPeople: 'optional array of names whose mail matters more',
      play: 'optional true to play the audio digest on the Mac speakers now',
    },
  },
  review_queue: {
    description:
      "Read back what the last cross-account brief FOUND and did not act on: the waiting findings and the drafted replies nobody has sent. Use for 'what is in my review queue', 'what did you find', 'what is waiting for me'. Read-only — it resolves nothing and sends nothing.",
    params: {
      all: 'optional true to include already reviewed and dismissed items',
    },
  },
  watch_page: {
    description:
      "Put a standing watch on ONE web page — including a page behind the owner's login, since the watch reads through their own browser session — and report only meaningful changes. Use for 'watch my order page', 'tell me when my appointment moves', 'let me know if the status changes'. Needs the page's URL: if the owner said 'this page' or 'my order page' without one, call browser_list_tabs first and pass the url you find. Name the values to track in `anchors` using the words that sit NEXT TO them on the page ('Order status', 'Total', 'Appointment') rather than CSS selectors, because the words survive a redesign and the markup does not. It only reads: there is no click and no type on this path.",
    params: {
      url: 'required http(s) url of the page to watch',
      name: 'optional short label for the watch',
      anchors:
        "optional array of on-page labels to track, e.g. ['Order status','Estimated delivery']",
      everyMs: 'optional poll interval in ms, default 900000 (15 minutes)',
      threshold:
        'optional 0-1 bar for how sure a change must be before it is reported; default 0.5',
    },
  },
  schedule_routine: {
    description:
      "Install a STANDING scheduled task that runs a spoken command later and repeatedly — 'every morning...', 'every day at 5pm...', 'every 30 minutes...'. Use this when the request describes a recurring time, not a thing to do right now; the `command` is the rest of the sentence, phrased as if the owner said it directly. Do NOT use it to run something once immediately. It only schedules; it runs nothing at the moment it is called.",
    params: {
      command: 'required — the spoken command this routine will run each time',
      name: 'optional short label',
      at: "for a daily routine: 'HH:MM' 24-hour local time",
      everyMs: 'for a repeating routine: interval in milliseconds, minimum 60000',
    },
  },
})

export const CAPABILITY_GAP_ACTION_TYPES = Object.freeze(
  Object.keys(CAPABILITY_GAP_ACTIONS),
)

const CAPABILITY_GAP_TYPE_SET = new Set(CAPABILITY_GAP_ACTION_TYPES)

export function isCapabilityGapAction(type) {
  return CAPABILITY_GAP_TYPE_SET.has(String(type || ''))
}

/* ------------------------------------------------------------- hands-free */

/*
 * THE PENDANT HAS NO CONFIRM UI, AND THAT CUTS BOTH WAYS.
 *
 * bridge.js runs classifyPlan() on every pendant-issued plan and, when
 * anything is not on actionRisk.js's allowlist, replies "Waiting for your
 * approval on the dashboard." A worn pendant has no dashboard, so that
 * sentence is where the request ends. Measured: compose_briefing, triage_inbox
 * and research_brief are all off the allowlist today, which means the brief
 * the owner already has is already unusable from the device it was built for.
 * Adding action types without settling this would reproduce that exactly.
 *
 * The line drawn here is not "read-only". It is WHETHER THE ACTION CAN CREATE
 * A PATH THAT LATER SKIPS THIS CHECK.
 *
 *   briefing_triage, review_queue — compose and read. assertNeverSends() gates
 *     the sinks, mailTriage refuses osascript any script containing Mail's
 *     `send` verb, and pageWatch's action allow-list has no click and no type.
 *     Three independent structural refusals, none of which a spoken sentence
 *     can relax. Hands-free.
 *
 *   watch_page — creates standing work, but the standing work is a READ. Its
 *     worst case is polling a URL the owner did not mean; it is listed by GET
 *     /watches and removed by one DELETE. Hands-free.
 *
 *   schedule_routine — creates standing work that is ARBITRARY EXECUTION.
 *     routines.js runs orchestratePlan/orchestrateExecute directly and never
 *     calls classifyPlan, so a routine installed by voice would execute, every
 *     morning forever, actions that voice is not allowed to run once. That is
 *     a privilege escalation with a timer on it. It needs the owner's approval
 *     exactly once, at install time — UNLESS what it will run is itself
 *     hands-free, which is the whole of the "every morning brief me across my
 *     accounts" case and is checked below rather than assumed.
 */
export const CAPABILITY_GAP_HANDS_FREE = Object.freeze([
  'briefing_triage',
  'review_queue',
  'watch_page',
])

export function capabilityGapHandsFree(action) {
  const type = String(action?.type || '')
  if (!CAPABILITY_GAP_TYPE_SET.has(type)) return null

  if (CAPABILITY_GAP_HANDS_FREE.includes(type)) return { safe: true }

  /* schedule_routine. A routine may be installed without a confirmation if,
   * and only if, the thing it will run is something the owner could have said
   * to the pendant and had run without one. Recursion of the same rule, one
   * level deep — which is all the depth there is, since a routine cannot
   * install a routine. */
  const command = String(action?.params?.command || '')
  const inner = matchMorningTriageCommand(command) ? 'briefing_triage' : null
  if (inner && CAPABILITY_GAP_HANDS_FREE.includes(inner)) {
    return { safe: true }
  }
  return {
    safe: false,
    reason:
      'Setting up a recurring task that runs on its own needs your approval once.',
  }
}

/* ------------------------------------------------------------- the matchers */

/*
 * Phrasings that mean the cross-account brief, superseding briefing.js.
 *
 * These have to be MORE specific than briefing.js's patterns, not merely
 * different, because both matchers see the same sentence and whichever is
 * consulted first wins. A bare "brief me", "morning brief" or "prepare my
 * workday" must still reach compose_briefing — that module is not broken and
 * stealing its traffic would be the same bug pointed the other way.
 *
 * So every pattern below requires a SCOPE WORD the older brief cannot honour:
 * an authenticated surface, "only what changed", a review queue, a
 * draft-but-do-not-send, or a digest OF WHAT CHANGED. "Every morning" on its
 * own is deliberately not enough, in either direction.
 *
 * The vocabulary is wider than briefingTriage.js's own matcher on purpose. Its
 * pattern requires the words accounts/tabs/sites adjacent to
 * logged-in/authenticated, and the owner wrote "authenticated work portal" and
 * "logged-in work dashboards" — two of the nine asks, missed by the matcher
 * built for them.
 */
const AUTHENTICATED = /\b(?:logged[\s-]?in|authenticated|signed[\s-]?in|my\s+accounts?)\b/i
const AUTHENTICATED_SURFACE =
  /\b(?:accounts?|tabs?|sites?|portals?|dashboards?|inbox(?:es)?|web\s+accounts?|browser\s+accounts?)\b/i

/*
 * The fourteen-vote ask names no authenticated surface at all: "check my
 * private calendar, travel reservations, and important account notifications
 * in Safari". What makes it this capability rather than compose_briefing is
 * that it names a BROWSER as a source — briefing.js reads calendar, mail and
 * files and opens no page, so any request that expects the answer to come
 * partly out of Safari or Chrome cannot be satisfied there.
 */
const BROWSER_ONLY_SURFACE =
  /\b(?:work\s+)?(?:portals?|dashboards?|web\s+accounts?|browser\s+accounts?|websites?|web\s+sites?)\b/i

const NAMED_BROWSER = /\b(?:safari|chrome|(?:my|the)\s+browser|browser\s+tabs?)\b/i
const ACCOUNT_MATERIAL =
  /\b(?:accounts?|notifications?|reservations?|orders?|appointments?|statements?|bills?)\b/i

const TRIAGE_PATTERNS = [
  /* "check my logged-in work dashboards", "my authenticated work portal" */
  (text) => AUTHENTICATED.test(text) && AUTHENTICATED_SURFACE.test(text),
  /*
   * A surface only a browser can reach, even with no "logged-in" marker on it.
   * Measured: "every weekday morning check my work portal" still resolved to
   * compose_briefing after the splice, because it names a portal but never
   * says authenticated — and compose_briefing cannot open a page at all, so
   * the owner gets the calendar-and-mail brief and no portal.
   *
   * Deliberately narrower than AUTHENTICATED_SURFACE: inbox and accounts are
   * excluded because briefing.js genuinely does read mail, and claiming those
   * would take traffic that already has a correct home.
   */
  BROWSER_ONLY_SURFACE,
  /* "important account notifications in Safari" */
  (text) => NAMED_BROWSER.test(text) && ACCOUNT_MATERIAL.test(text),
  /* "tell me only what changed", "only what needs my attention" */
  /\bonly\s+(?:tell\s+me\s+)?what\s+(?:changed|has\s+changed|needs\s+my\s+attention)\b/i,
  /\btell\s+me\s+only\s+what\b/i,
  /* "put findings in a review queue instead of acting" */
  /\breview\s+queue\b/i,
  /* "draft (but do not send) any replies" */
  /\bdraft\b[^.]{0,40}\b(?:but\s+)?(?:do\s+not|don'?t|never)\s+send\b/i,
  /\b(?:do\s+not|don'?t|never)\s+send\b[^.]{0,40}\bdraft\b/i,
  /* "a 30-second audio digest of what changed" */
  /\bdigest\b[^.]{0,30}\bwhat\s+(?:has\s+)?changed\b/i,
  /\bwhat\s+(?:has\s+)?changed\b[^.]{0,30}\bdigest\b/i,
  /* the owner's own shorthand, kept from briefingTriage.js */
  /\b(?:the\s+)?(?:three|3)\s+things\s+i\s+need\s+to\s+know\b/i,
  /\b(?:morning|weekday)\s+triage\b|\btriage\s+my\s+(?:morning|day|accounts?)\b/i,
  /\bwhat\s+(?:has\s+)?changed\b.*\b(?:overnight|since\s+(?:yesterday|last\s+night)|while\s+i\s+(?:slept|was\s+asleep))\b/i,
]

/** The cross-account brief, or null. Null means some other module's traffic. */
export function matchMorningTriageCommand(command) {
  const text = String(command || '').trim()
  if (!text) return null
  const hit = TRIAGE_PATTERNS.some((pattern) =>
    typeof pattern === 'function' ? pattern(text) : pattern.test(text),
  )
  return hit ? {} : null
}

/*
 * "Watch this page and tell me when it changes."
 *
 * Deliberately requires a url in the sentence. A watch on the wrong page is a
 * watcher that is silent forever about the thing the owner cared about, and
 * silence is the one failure this feature cannot signal. Without a url the
 * request goes to the planner, which can call browser_list_tabs and find out.
 */
const WATCH_VERB =
  /\b(?:watch|keep\s+an\s+eye\s+on|monitor|track|check\s+regularly)\b/i
const URL_IN_TEXT = /\b((?:https?:\/\/)?(?:[a-z0-9-]+\.)+[a-z]{2,}(?:\/\S*)?)\b/i

export function matchWatchPageCommand(command) {
  const text = String(command || '').trim()
  if (!text || !WATCH_VERB.test(text)) return null
  const found = URL_IN_TEXT.exec(text)
  if (!found) return null
  const raw = found[1]
  const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
  try {
    new URL(url)
  } catch {
    return null
  }
  return { url }
}

/**
 * policyRouter.js's DETERMINISTIC_MATCHERS shape.
 *
 * ORDER IS THE WHOLE POINT: these must be spliced in ABOVE the
 * compose_briefing entry. Below it, "every weekday morning check my
 * authenticated work portal" is still swallowed by matchBriefingCommand and
 * nothing here ever runs — which is the state this file exists to end.
 *
 * schedule_routine is deliberately absent. Choosing a schedule out of a
 * sentence ("every other Tuesday", "first thing", "after lunch") is exactly
 * the judgement policyRouter's own header says the deterministic table must
 * not attempt, and a wrong guess here installs a repeating mistake.
 */
export const CAPABILITY_GAP_MATCHERS = Object.freeze([
  {
    intent: 'briefing_triage',
    readOnly: false,
    test: (text) => matchMorningTriageCommand(text),
    build: (options) => ({
      type: 'briefing_triage',
      label: 'Brief across the accounts you are logged in to',
      params: options ?? {},
    }),
  },
  {
    intent: 'watch_page',
    readOnly: false,
    test: (text) => matchWatchPageCommand(text),
    build: (options) => ({
      type: 'watch_page',
      label: `Watch ${options.url} for meaningful changes`,
      params: options,
    }),
  },
])

/* ------------------------------------------------------------- the dispatch */

const MIN_ROUTINE_INTERVAL_MS = 60_000

/*
 * Schedule shapes local-agent/routines.js can actually keep.
 *
 * nextRunAt() there understands `interval` and `daily`. Not `weekly`, not a
 * weekday set, not a timezone. cloud-relay/routineSchedule.js understands all
 * three, which is the right long-term home for a 7am promise anyway since the
 * relay is the half that does not sleep — but the Mac-local store is what this
 * action writes to, and a weekday routine written there as `daily` fires on
 * Saturday morning about a work portal nobody is looking at.
 */
const WEEKDAY_WORDS = /\b(?:weekday|weekdays|monday|tuesday|wednesday|thursday|friday|saturday|sunday|weekly|every\s+other)\b/i

function reject(action, message) {
  return {
    action,
    ok: false,
    status: 'blocked',
    message,
    reason: message,
  }
}

function done(action, message, extra = {}) {
  return { action, ok: true, status: 'success', message, ...extra }
}

/**
 * Run one of the four. Shaped exactly like computerControl.js's own handlers —
 * `{ action, ok, status, message }` plus whatever the caller needs — so it can
 * be dropped into that dispatch table without translation.
 *
 * Every module is injectable, and an injected one is never loaded: a test that
 * supplies its own readers must not touch the owner's real mailbox, browser or
 * routine store, and importing the module to then ignore it would defeat that.
 */
export async function runCapabilityGapAction(action, overrides = {}) {
  const type = String(action?.type || '')
  const params = action?.params ?? {}

  if (type === 'briefing_triage') {
    const { runBriefingTriage, TRIAGE_SINKS } = overrides.triage
      ? { runBriefingTriage: overrides.triage, TRIAGE_SINKS: ['file', 'speech'] }
      : await import('./briefingTriage.js')
    const triage = overrides.triage ?? runBriefingTriage
    const brief = await triage({
      sinks: TRIAGE_SINKS,
      knownPeople: Array.isArray(params.knownPeople) ? params.knownPeople : [],
      play: params.play === true,
    })
    /*
     * `message` is what gets spoken, so it is the digest and not a count. The
     * counts ride alongside for the dashboard. `sent` and `acted` are carried
     * through from the brief rather than restated: nine of the nine asks are
     * conditional on them staying false, and a caller should be able to read
     * that off the result without knowing which module produced it.
     */
    return done(action, brief.spoken, {
      briefing: {
        id: brief.id,
        title: brief.title,
        spoken: brief.spoken,
        narration: brief.narration,
        notePath: brief.path ?? null,
        briefingId: brief.briefingId ?? null,
        counts: brief.counts,
        unavailable: brief.unavailable,
        problems: brief.problems,
        policySource: brief.policySource,
      },
      sent: brief.sent === true,
      acted: brief.acted === true,
    })
  }

  if (type === 'review_queue') {
    const queue =
      overrides.queue ?? (await import('./briefingQueue.js')).reviewQueue
    const items = queue({ includeResolved: params.all === true })
    const drafts = items.filter((item) => item?.draft).length
    return done(
      action,
      items.length
        ? `${items.length} finding${items.length === 1 ? '' : 's'} waiting, including ${drafts} drafted repl${drafts === 1 ? 'y' : 'ies'} nobody has sent.`
        : 'Your review queue is empty.',
      { waiting: items.length, drafts, items, acted: false },
    )
  }

  if (type === 'watch_page') {
    const url = String(params.url || '').trim()
    if (!url) {
      return reject(
        action,
        'watch_page needs the url of the page to watch. Read the open tabs first if the owner said "this page".',
      )
    }

    /* `??` never evaluates its right operand when an override is supplied, so
     * a fully injected call loads nothing. */
    const pageWatch =
      overrides.addWatch && overrides.watches ? null : await import('./pageWatch.js')
    const addWatch = overrides.addWatch ?? pageWatch.createWatch
    const watches = overrides.watches ?? pageWatch.listWatches

    /*
     * Anchors, not selectors, and that is the owner's interest rather than a
     * style preference: pageWatch.js's own header explains that a CSS selector
     * stops matching the week a site ships a redesign and the watch then
     * reports "the value is no longer on the page" every poll, at 3am, with
     * nobody there. The words next to the value survive.
     */
    const anchors = Array.isArray(params.anchors)
      ? params.anchors.filter(Boolean).slice(0, 8)
      : []
    const fields = anchors.map((anchor) => ({
      name: String(anchor).toLowerCase().replace(/[^a-z0-9]+/g, '_').slice(0, 60),
      anchor: String(anchor),
    }))

    /* Idempotent by url: "watch my order page" said twice on two mornings is
     * one watch, not two polling the same page and reporting it twice. */
    const already = watches().find(
      (watch) => watch.url === url && watch.enabled !== false,
    )
    if (already) {
      return done(
        action,
        `Already watching ${already.name}. Nothing new was created.`,
        { watch: already, created: false },
      )
    }

    const watch = addWatch({
      name: params.name || undefined,
      url,
      fields,
      everyMs: Number(params.everyMs) > 0 ? Number(params.everyMs) : undefined,
      threshold: params.threshold,
    })
    return done(
      action,
      `Watching ${watch.name}. You will hear from me only when something meaningful changes.`,
      { watch, created: true },
    )
  }

  if (type === 'schedule_routine') {
    const command = String(params.command || '').trim()
    const store =
      overrides.addRoutine && overrides.routines ? null : await import('./routines.js')
    const addRoutine = overrides.addRoutine ?? store.createRoutine
    const routines = overrides.routines ?? store.listRoutines
    if (!command) {
      return reject(action, 'schedule_routine needs the command it should run.')
    }

    /*
     * The refusal that matters. Item two says "every WEEKDAY morning" and this
     * store cannot express it — so it is declined by name, with the change
     * that would fix it, instead of being written down as `daily` and firing
     * on Saturday. A routine that runs on a day the owner excluded is worse
     * than one that was never created, because the owner believes it is right.
     */
    const scheduleText = `${params.at || ''} ${params.schedule?.kind || ''} ${command}`
    if (WEEKDAY_WORDS.test(scheduleText) || Array.isArray(params.days)) {
      return reject(
        action,
        'I can schedule this every day or on an interval, but not on a weekday-only schedule — the Mac routine store has no weekday setting, so it would also fire at the weekend. Ask for it every day, or set it up on the relay, which does understand weekdays.',
      )
    }

    const everyMs = Number(params.everyMs)
    const schedule = params.at
      ? { kind: 'daily', at: String(params.at) }
      : Number.isFinite(everyMs) && everyMs > 0
        ? { kind: 'interval', everyMs: Math.max(MIN_ROUTINE_INTERVAL_MS, everyMs) }
        : null
    if (!schedule) {
      return reject(
        action,
        'schedule_routine needs either a daily time (at: "07:00") or an interval in milliseconds.',
      )
    }

    /* Same idempotence rule as watch_page, for the same reason: "every morning
     * brief me across my accounts" said on three mornings is one routine. */
    const already = routines().find(
      (routine) =>
        routine.command.trim().toLowerCase() === command.toLowerCase() &&
        routine.schedule?.kind === schedule.kind &&
        routine.schedule?.at === schedule.at &&
        routine.schedule?.everyMs === schedule.everyMs,
    )
    if (already) {
      return done(action, `That is already scheduled: ${already.name}.`, {
        routine: already,
        created: false,
      })
    }

    const routine = addRoutine({
      name: params.name || command.slice(0, 60),
      command,
      schedule,
    })
    return done(
      action,
      schedule.kind === 'daily'
        ? `Scheduled. I will run that every day at ${schedule.at}.`
        : `Scheduled. I will run that every ${Math.round(schedule.everyMs / 60_000)} minutes.`,
      { routine, created: true },
    )
  }

  throw new Error(`capabilityGaps does not handle action type: ${type}`)
}

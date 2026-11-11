import crypto from 'node:crypto'

import { listEvents, listOpenReminders } from './appleData.js'
import {
  briefingSlug,
  deleteBriefing,
  listBriefings,
  playBriefingOnMac,
  renderBriefAudio,
  saveBriefing,
} from './audioBrief.js'
import {
  assertNeverSends,
  formatClock,
  fitSpoken,
  writeBriefingFile,
} from './briefing.js'
import {
  briefingQueueLocation,
  lastBriefingRun,
  listBriefingRuns,
  recordBriefingRun,
  resolveQueueItem,
  reviewQueue,
  statePolicy,
  statedPolicy,
  toldFingerprints,
  unheardRunIds,
} from './briefingQueue.js'
import { getBrowserStatus } from './browserBridge.js'
import { redactionMapFor } from './evidenceCapsules.js'
import { DRAFTED_BUCKETS, triageInbox } from './mailTriage.js'
import { pendingReports } from './pageWatch.js'

/*
 * The morning brief, as the owner actually asked for it.
 *
 * Eleven separate capability requests converged on one shape: look across the
 * places the owner is already logged in — calendar, task board, mail,
 * authenticated pages — and come back with a very short list. Every one of them
 * carried the same two clauses, and those two clauses are the whole design:
 *
 *   "draft but do not send" / "a review queue instead of acting"
 *      → there is no transmit and no write on this path. assertNeverSends()
 *        from briefing.js gates the sinks; the drafts come from mailTriage.js,
 *        which refuses to hand osascript a script containing Mail's `send`
 *        verb; account findings come from pageWatch.js, whose action allow-list
 *        has no click and no type. Three modules, three independent structural
 *        refusals, none of which this file can relax.
 *
 *   "the three things" / "only what changed"
 *      → the default is silence. A finding has to be new AND score past a
 *        threshold to consume one of three spoken slots. Everything else lands
 *        in the review queue, which is a list the owner opens, not a thing that
 *        speaks. A brief that reports everything is the failure mode, not the
 *        goal.
 *
 * This extends the existing briefing path rather than forking it: the composed
 * brief is written through briefing.js's writeBriefingFile, so GET
 * /briefing/latest finds it, and the audio goes onto audioBrief.js's shelf, so
 * GET /research/briefings lists it alongside every other brief.
 *
 * Travel reservations, named in one of the requests, are deliberately not a
 * source of their own. They already arrive through two channels that exist:
 * airlines and hotels write to Calendar, and a logged-in reservation page is a
 * pageWatch away. A per-airline scraper would be exactly the per-site hardcoding
 * this feature is supposed to avoid.
 */

/* ------------------------------------------------------------------- policy */

/*
 * WHO GETS INTERRUPTED, AND FOR WHAT.
 *
 * PLACEHOLDER. The owner has not stated their interruption policy — five agent
 * proposals asked for it and it is still unanswered — so every number below is
 * a defensible guess, not a decision. The point of putting them here, named and
 * writable through POST /briefing/policy, is that the day the owner says "wake
 * me for anything a person is waiting on, never for a calendar entry" it is one
 * object to change and nothing has to be re-derived from code.
 *
 * Every run reports which of the two it used: `policySource: 'owner'` once they
 * have stated one, `'default'` until then. A threshold nobody chose must never
 * be reported as though someone had.
 *
 * URGENCY IS STRUCTURAL HERE, NOT TOPICAL. Nothing below reads the words in a
 * subject line or the name of a site. Each signal is a fact about the shape of
 * the finding: a typed deadline, another person on the other end, or the owner
 * having previously asked to be told. That is a deliberate constraint — a
 * keyword list is a policy the owner never wrote, and it is wrong in a
 * different way for every person who uses it.
 */
export const DEFAULT_INTERRUPTION_POLICY = Object.freeze({
  /* "Tell me the three things I need to know" — said in those words. */
  maxSpoken: 3,

  /*
   * Weights, and the structural fact each one stands for.
   *
   * closingWindow is the largest because it is the only signal that answers the
   * question a briefing exists to answer: is telling you at the next briefing
   * too late? Everything else is a reason to care, not a reason to be told now.
   */
  weights: Object.freeze({
    /* A typed deadline — an event's start, a reminder's due date — that falls
     * before the next briefing. Never inferred from text. */
    closingWindow: 4,
    /* That deadline already passed and the item is still open. Worth saying,
     * but lower than closingWindow: the moment to act cleanly is already gone,
     * so it is news rather than an interruption. */
    overdue: 3,
    /* The owner set a standing watch on exactly this. The strongest possible
     * signal, because it is the only one where the owner has already stated the
     * policy themselves rather than having it guessed for them. */
    ownerSubscribed: 4,
    /* Another identified person is on the other end: an event with attendees
     * besides the owner, or a message from an address a reply can reach. */
    awaited: 2,
    /* The owner wrote this down themselves. A reminder is a promise to a future
     * self and deserves more than a stranger's email. */
    ownerAsked: 2,
    /* Continues a thread the owner already wrote into. Structural: it is the
     * owner's own prior action, not a judgement about the topic. */
    inMyThread: 2,
  }),

  /*
   * The line between "say this" and "queue this".
   *
   * Worked backwards from the combinations, all of which are pinned in
   * briefingTriage.test.js:
   *   4  a meeting today the owner attends alone            → spoken
   *   6  a meeting today with other attendees               → spoken
   *   6  a reminder due before the next brief               → spoken
   *   5  a reminder that is already overdue                 → spoken
   *   4  a change on a page the owner asked to be watched   → spoken
   *   4  an unread reply inside a thread the owner started  → spoken
   *   2  an unread first-contact email from a real person   → queued, drafted
   *   0  an all-day holiday, a solo calendar block tomorrow → suppressed
   * A threshold of 3 would let a cold email interrupt; a threshold of 5 would
   * drop the owner's own watched pages, which are the one thing they explicitly
   * asked to hear about.
   */
  threshold: 4,

  /*
   * Say it once. A fingerprint already in the ledger never consumes a spoken
   * slot again — that is what "only what changed" means. It stays in the review
   * queue while it is open, so nothing is lost, it is just not read aloud twice.
   *
   * null means never repeat. A number of milliseconds would mean "you may say
   * it again after this long", which is a reasonable thing for the owner to
   * want and is why it is a field rather than a constant.
   */
  repeatAfterMs: null,

  /*
   * Two briefings composed minutes apart, both unplayed, is a bug this feature
   * has already produced once. Below this gap a run that would say the same
   * things returns the previous brief instead of rendering a second one.
   * Thirty minutes is short enough that a genuine re-run after the owner
   * changes something still works, and long enough to cover a scheduler that
   * fires twice.
   */
  minRerunGapMs: 30 * 60 * 1000,

  /* How far back the mail and account reads look. A morning brief is about the
   * night; 24h is the span that makes "what changed" true on a Monday and on a
   * Thursday alike. */
  lookbackHours: 24,

  /*
   * Drafts are for the queue, and the queue is for reading, so this is capped
   * low on purpose: each draft costs a message-body read plus a share of one
   * model call, and eight drafts nobody opens is worse than three they do.
   */
  maxDrafts: 3,

  /*
   * "A 30-second audio digest." audioBrief.js speaks at 185 wpm, so thirty
   * seconds is ~92 words. The narration is composed to fit rather than trimmed
   * to fit, because a digest cut off at word 93 is not a digest.
   */
  digestWords: 92,

  /* Weekday mornings, in the owner's words. Used to work out when the next
   * briefing would be, which is what "is this too late to tell you then?"
   * measures against. */
  schedule: Object.freeze({ weekdaysOnly: true, at: '07:00' }),
})

/** Merge a stated policy over the placeholder without losing nested defaults. */
export function normalizePolicy(stated) {
  if (!stated || typeof stated !== 'object') return DEFAULT_INTERRUPTION_POLICY
  return Object.freeze({
    ...DEFAULT_INTERRUPTION_POLICY,
    ...stated,
    weights: Object.freeze({
      ...DEFAULT_INTERRUPTION_POLICY.weights,
      ...(stated.weights ?? {}),
    }),
    schedule: Object.freeze({
      ...DEFAULT_INTERRUPTION_POLICY.schedule,
      ...(stated.schedule ?? {}),
    }),
  })
}

/**
 * The policy in force, and whether anybody chose it.
 *
 * Returned as a pair rather than just the object so the caller cannot report a
 * placeholder as a decision by accident.
 */
export function activePolicy({ filePath = undefined, override = null } = {}) {
  if (override) return { policy: normalizePolicy(override), source: 'request' }
  const stored = statedPolicy(filePath ? { filePath } : {})
  return stored
    ? { policy: normalizePolicy(stored), source: 'owner' }
    : {
        policy: DEFAULT_INTERRUPTION_POLICY,
        source: 'default',
        note: 'The owner has not stated an interruption policy; these thresholds are a placeholder.',
      }
}

/* --------------------------------------------------------- the next briefing */

/**
 * When the owner would next hear from this feature.
 *
 * routines.js's nextRunAt has no weekday concept, and "every weekday morning"
 * is the owner's literal phrasing, so the weekday case is computed here. The
 * daily and interval cases defer to that module's shape so the two cannot
 * disagree about what "every N" means.
 *
 * This is the clock the whole ranking is measured against: a deadline that
 * lands before it can wait for the queue, and one that lands after it cannot.
 */
export function nextBriefingAt({ policy = DEFAULT_INTERRUPTION_POLICY, now = new Date() } = {}) {
  const schedule = policy.schedule ?? DEFAULT_INTERRUPTION_POLICY.schedule
  if (Number.isFinite(schedule.everyMs)) {
    return new Date(new Date(now).getTime() + Math.max(60_000, schedule.everyMs))
  }

  const [hour, minute] = String(schedule.at || '07:00')
    .split(':')
    .map((part) => Number(part) || 0)
  const next = new Date(now)
  next.setSeconds(0, 0)
  next.setHours(hour, minute)
  if (next.getTime() <= new Date(now).getTime()) {
    next.setDate(next.getDate() + 1)
  }
  if (schedule.weekdaysOnly !== false) {
    /* Friday's brief is measured against Monday's, which is the honest span:
     * a task due Saturday that goes unmentioned on Friday is missed. */
    while (next.getDay() === 0 || next.getDay() === 6) {
      next.setDate(next.getDate() + 1)
    }
  }
  return next
}

/* ----------------------------------------------------------------- findings */

/*
 * One shape for everything, whatever read it came from.
 *
 * `actionableUntil` is the load-bearing field and it is only ever populated
 * from a typed date — EventKit's startDate, a reminder's dueDate. There is no
 * path here that parses a deadline out of prose, because a deadline invented
 * from a subject line is a wrong answer wearing the clothes of a right one.
 *
 * `provenance` travels with the finding rather than being reattached at the
 * end. Everything downstream — the queue row, the note, the redaction pass —
 * reads it off the finding, so a finding that reaches the owner without a
 * source is not a thing that can happen by forgetting a line.
 */
function finding({
  source,
  key,
  title,
  detail = '',
  at = null,
  actionableUntil = null,
  signals = [],
  provenance,
  raw = null,
}) {
  return {
    source,
    key: String(key),
    title: String(title || '').trim(),
    detail: String(detail || '').trim(),
    at,
    actionableUntil,
    signals: [...new Set(signals)],
    provenance,
    raw,
  }
}

/**
 * Calendar. Attendees are what make an event a commitment to somebody.
 *
 * All-day entries get no actionableUntil at all. A holiday or a birthday shapes
 * the day but there is nothing to be late for, and giving them a deadline is
 * how "立秋" — a real row from this Mac's 台灣節日 calendar — ends up as one of
 * the three things the owner needs to know.
 */
export function findingsFromEvents(events = [], { now = new Date() } = {}) {
  const nowMs = new Date(now).getTime()
  return events
    .filter((event) => event && event.start)
    .map((event) => {
      const startMs = Date.parse(event.start)
      const endMs = Date.parse(event.end ?? '')
      /* Already finished before the owner woke up: nothing to do about it. */
      if (Number.isFinite(endMs) && endMs < nowMs) return null

      const signals = []
      /* attendees includes the owner's own row on an invited event, so "someone
       * else is expecting you" is more than one, not more than zero. */
      if ((event.attendees ?? []).length > 1) signals.push('awaited')

      return finding({
        source: 'calendar',
        key: event.uid ?? `${event.title}@${event.start}`,
        title: event.title || '(untitled)',
        detail: [event.calendar, event.location].filter(Boolean).join(' · '),
        at: event.start,
        actionableUntil: event.allDay || !Number.isFinite(startMs) ? null : event.start,
        signals,
        provenance: {
          reader: 'local-agent/appleData.js listEvents (EventKit)',
          observedAt: new Date(now).toISOString(),
          reference: event.uid ?? null,
          capsuleIds: [],
        },
      })
    })
    .filter(Boolean)
}

/**
 * Reminders — the "task board" in the owner's phrasing.
 *
 * A reminder with no due date carries ownerAsked and nothing else, which puts
 * it well under the threshold. That is correct: "buy milk sometime" is a list,
 * not a briefing.
 */
export function findingsFromReminders(reminders = [], { now = new Date() } = {}) {
  return reminders
    .filter(Boolean)
    .map((task) =>
      finding({
        source: 'reminders',
        key: task.id ?? task.title,
        title: task.title || '(untitled)',
        detail: task.list || '',
        at: task.due ?? null,
        actionableUntil: task.due ?? null,
        signals: ['ownerAsked'],
        provenance: {
          reader: 'local-agent/appleData.js listOpenReminders (EventKit)',
          observedAt: new Date(now).toISOString(),
          reference: task.id ?? null,
          capsuleIds: [],
        },
      }),
    )
}

/**
 * Mail, as mailTriage.js already classified it.
 *
 * This module does not re-decide which mail matters and deliberately owns no
 * regex over subject lines. What it takes from the classifier is one structural
 * fact: whether the message came from an address a reply can actually reach —
 * DRAFTED_BUCKETS is exactly the set of messages that are not no-reply, not a
 * role address, and not a brand wearing a person's name. Both buckets inside it
 * are treated identically here, so the topical part of that classifier
 * (its deadline-language regex, which sorts urgent from reply-soon) has no
 * effect on this ranking.
 *
 * Mail has no typed deadline, so it can never score closingWindow. That is the
 * intended consequence: mail reaches the spoken brief only when the owner is
 * already inside the thread, and otherwise waits in the queue with a draft.
 */
export function findingsFromMailTriage(triage, { now = new Date() } = {}) {
  if (!triage) return []
  const replyable = DRAFTED_BUCKETS.flatMap((name) => triage.buckets?.[name] ?? [])

  return replyable.map((message) => {
    const draft = (triage.drafts ?? []).find(
      (entry) =>
        entry.message?.messageId === message.messageId &&
        entry.message?.subject === message.subject,
    )
    const signals = ['awaited']
    if (/^re:/i.test(message.subject || '')) signals.push('inMyThread')

    return finding({
      source: 'mail',
      key: message.messageId || `${message.sender}|${message.subject}`,
      title: message.subject || '(no subject)',
      detail: message.senderName || message.sender || '',
      at: message.receivedAt ?? null,
      actionableUntil: null,
      signals,
      provenance: {
        reader: 'local-agent/mailTriage.js triageInbox (Mail.app, envelope + body)',
        observedAt: new Date(now).toISOString(),
        reference: message.messageId ?? null,
        capsuleIds: [],
      },
      raw: draft
        ? {
            draft: {
              subject: draft.subject,
              body: draft.body,
              to: draft.to,
              generatedBy: draft.generatedBy,
              /* The file mailTriage already wrote. Pointing at it beats copying
               * it: one artifact, one place the owner edits it, and the queue
               * row stays small. */
              path: (triage.draftPaths ?? [])[triage.drafts.indexOf(draft)] ?? null,
              sent: false,
            },
          }
        : null,
    })
  })
}

/**
 * Authenticated accounts, via the watches the owner set up themselves.
 *
 * These arrive already diffed — pageWatch reports only exist when something
 * moved — so they are the only source where "what changed" needs no work here.
 * They carry capsule ids, which is why revoked evidence can blank a queue row
 * without the row disappearing.
 *
 * ONE FINDING PER WATCH, NOT PER POLL. pageWatch keeps up to 25 unacknowledged
 * reports per watch, and the first live run of this module against this Mac
 * spent two of its three spoken slots on the same watch: "UTC clock:
 * 06:20:54 → 06:24:52" followed by "UTC clock: 06:24:52 → 06:26:08", two
 * consecutive polls of one page. Reading every intermediate step out loud is
 * the exact opposite of the ask. The owner wants where it landed, and how much
 * it moved to get there.
 */
export function findingsFromAccountReports(reports = [], { now = new Date() } = {}) {
  const newestPerWatch = new Map()
  for (const report of reports.filter(Boolean)) {
    /* pendingReports is already newest-first, so the first one seen for a watch
     * is the one that is still true. */
    const key = report.watchId ?? report.name
    if (!newestPerWatch.has(key)) newestPerWatch.set(key, { report, polls: 0 })
    newestPerWatch.get(key).polls += 1
  }

  return [...newestPerWatch.values()].map(({ report, polls }) =>
    finding({
      source: 'account',
      key: `${report.watchId}:${(report.changes ?? [])
        .map((change) => `${change.field}=${change.after ?? ''}`)
        .join(',')}`,
      title: report.name || 'Watched page',
      detail:
        polls > 1
          ? `${report.summary || ''} (and ${polls - 1} earlier change${polls === 2 ? '' : 's'} since you last looked)`.trim()
          : report.summary || '',
      at: report.at ?? null,
      actionableUntil: null,
      signals: ['ownerSubscribed'],
      provenance: {
        reader: "local-agent/pageWatch.js pendingReports (owner's logged-in browser)",
        observedAt: new Date(now).toISOString(),
        reference: report.watchId ?? null,
        url: report.url ?? null,
        supersededPolls: polls - 1,
        capsuleIds: report.capsuleIds ?? [],
      },
    }),
  )
}

/* ------------------------------------------------------------------ ranking */

/**
 * Which of the time-shaped signals this finding has, given when the owner would
 * next hear from us.
 *
 * Returned separately from the score because it is also part of the
 * fingerprint: a meeting the owner was told about on Monday when it was still
 * Thursday's problem is genuinely new news on Thursday morning, and a
 * fingerprint that ignored the band would silence it.
 */
export function timeBand(item, { now = new Date(), nextAt } = {}) {
  if (!item?.actionableUntil) return 'none'
  const deadline = Date.parse(item.actionableUntil)
  if (!Number.isFinite(deadline)) return 'none'
  if (deadline <= new Date(now).getTime()) return 'overdue'
  if (deadline <= new Date(nextAt).getTime()) return 'closing'
  return 'later'
}

/**
 * A stable identity for "the owner was told this".
 *
 * Content-addressed on what was said, not on when it was found, so the same
 * open item found again tomorrow collapses onto the same fingerprint and stays
 * quiet — while a version of it that has changed in any way the owner would
 * care about (a moved meeting, a new value on a watched page, a different
 * urgency band) is a different fingerprint and is news again.
 */
export function fingerprintFinding(item, band = 'none') {
  const material = [
    item.source,
    item.key,
    item.title,
    item.actionableUntil ?? '',
    band,
  ].join('')
  return `bf_${crypto.createHash('sha256').update(material).digest('hex').slice(0, 24)}`
}

/**
 * Score one finding, and say why in the owner's terms.
 *
 * Additive and fully explainable on purpose. The owner is going to disagree
 * with this ranking at some point, and "it scored 6: closes before the next
 * brief, and two other people are on it" is a sentence they can correct. A
 * learned score is not.
 */
export function rankFinding(
  item,
  { policy = DEFAULT_INTERRUPTION_POLICY, now = new Date(), nextAt } = {},
) {
  const band = timeBand(item, { now, nextAt })
  const weights = policy.weights ?? DEFAULT_INTERRUPTION_POLICY.weights
  const matched = []
  let score = 0

  const add = (signal, why) => {
    const weight = Number(weights[signal]) || 0
    if (!weight) return
    score += weight
    matched.push({ signal, weight, why })
  }

  if (band === 'closing') {
    add(
      'closingWindow',
      `the time to act on this passes before the next briefing (${formatClock(new Date(item.actionableUntil))})`,
    )
  } else if (band === 'overdue') {
    add('overdue', 'its deadline has already passed and it is still open')
  }

  if (item.signals.includes('ownerSubscribed')) {
    add('ownerSubscribed', 'you asked to be told when this page changes')
  }
  if (item.signals.includes('awaited')) {
    add('awaited', 'someone else is on the other end of it')
  }
  if (item.signals.includes('ownerAsked')) {
    add('ownerAsked', 'you wrote this one down yourself')
  }
  if (item.signals.includes('inMyThread')) {
    add('inMyThread', 'it continues a thread you already wrote into')
  }

  return {
    score,
    band,
    matched,
    why: matched.map((entry) => entry.why),
    fingerprint: fingerprintFinding(item, band),
  }
}

/**
 * Rank everything, then cut hard.
 *
 * Two gates, in this order and not the other one:
 *   1. novelty — has the owner already been told this exact thing?
 *   2. threshold — is it worth one of three slots?
 * Novelty first because a repeat is not a ranking question. An item that was
 * important yesterday is still important today; the owner just does not need to
 * hear it again, and letting it compete for a slot would mean the same top item
 * crowds out everything new for as long as it stays open.
 *
 * Nothing is dropped. `spoken` gets at most maxSpoken, `queued` gets everything
 * else that scored, `suppressed` counts what did not — and the count is
 * reported out loud, because a thin brief must never be mistaken for a quiet
 * morning.
 */
export function triageFindings({
  findings = [],
  policy = DEFAULT_INTERRUPTION_POLICY,
  now = new Date(),
  nextAt = null,
  told = new Map(),
} = {}) {
  const horizon = nextAt ?? nextBriefingAt({ policy, now })
  const nowMs = new Date(now).getTime()

  const ranked = findings.map((item) => {
    const rank = rankFinding(item, { policy, now, nextAt: horizon })
    const previous = told.get(rank.fingerprint) ?? null
    const repeatable =
      previous &&
      Number.isFinite(policy.repeatAfterMs) &&
      nowMs - Date.parse(previous.at) >= policy.repeatAfterMs
    return {
      ...item,
      ...rank,
      novel: !previous || Boolean(repeatable),
      previouslyToldAt: previous?.at ?? null,
    }
  })

  const passing = ranked
    .filter((item) => item.score >= policy.threshold)
    .sort(
      (left, right) =>
        right.score - left.score ||
        deadlineOrder(left) - deadlineOrder(right) ||
        String(left.title).localeCompare(String(right.title)),
    )

  const spoken = passing.filter((item) => item.novel).slice(0, policy.maxSpoken)
  const spokenIds = new Set(spoken.map((item) => item.fingerprint))
  const queued = ranked.filter(
    (item) => item.score > 0 && !spokenIds.has(item.fingerprint),
  )

  return {
    spoken,
    queued,
    suppressed: ranked.filter((item) => item.score <= 0).length,
    /* Said separately from `suppressed` because they mean different things to
     * the owner: one is "nothing about it needed you", the other is "you have
     * already heard this". */
    repeats: ranked.filter((item) => item.score >= policy.threshold && !item.novel).length,
    ranked,
    horizon: new Date(horizon).toISOString(),
  }
}

/* An item with a deadline outranks one without, and sooner outranks later. */
function deadlineOrder(item) {
  const deadline = Date.parse(item.actionableUntil ?? '')
  return Number.isFinite(deadline) ? deadline : Number.MAX_SAFE_INTEGER
}

/* -------------------------------------------------------------- redaction */

/**
 * The last thing that happens before words leave this Mac.
 *
 * A briefing's spoken text goes to the relay to be synthesised, which means a
 * subject line the owner never looked at can reach a third-party TTS endpoint.
 * So everything spoken, narrated or written passes through the same classifier
 * the evidence capsules use — one pattern list, in redaction.js, shared by
 * every path that exports text. Secrets are withheld outright; personal data is
 * flagged and kept, because the owner reads their own mail at full fidelity and
 * this is metadata for the export decision, not an access gate.
 */
export function redactForDelivery(text) {
  const redaction = redactionMapFor(String(text ?? ''))
  return {
    text: redaction.content,
    redaction: {
      counts: redaction.counts,
      classification: redaction.classification,
      classifier: redaction.classifier,
      map: redaction.map,
    },
  }
}

/* ------------------------------------------------------------- composition */

function greeting(now) {
  const hours = new Date(now).getHours()
  if (hours < 12) return 'Good morning.'
  if (hours < 18) return 'Good afternoon.'
  return 'Good evening.'
}

/** One sentence per finding, in the vocabulary of the source it came from. */
export function sentenceFor(item) {
  if (item.source === 'calendar') {
    const when = item.actionableUntil ? ` at ${formatClock(new Date(item.actionableUntil))}` : ''
    return `${item.title}${when}.`
  }
  if (item.source === 'reminders') {
    return `${item.title}, ${item.band === 'overdue' ? 'overdue' : `due ${formatClock(new Date(item.actionableUntil))}`}.`
  }
  if (item.source === 'mail') {
    return `${item.detail || 'Someone'} is waiting on "${item.title}".`
  }
  return `${item.detail || item.title}.`
}

/**
 * The 30-second digest, and the 180-character version of it.
 *
 * Both are composed to a budget rather than truncated to one. fitSpoken comes
 * from briefing.js so the pendant's 180-character hard slice is enforced in one
 * place; the digest is cut on whole sentences at the word budget the policy
 * carries, because a digest that stops mid-clause reads as a dropped connection.
 */
export function composeTriage({
  spoken = [],
  queued = [],
  suppressed = 0,
  repeats = 0,
  policy = DEFAULT_INTERRUPTION_POLICY,
  unavailable = [],
  now = new Date(),
} = {}) {
  const headline = [greeting(now)]

  if (!spoken.length) {
    headline.push(
      queued.length
        ? `Nothing needs you right now. ${queued.length} thing${queued.length === 1 ? '' : 's'} ${queued.length === 1 ? 'is' : 'are'} waiting in your review queue.`
        : 'Nothing needs you right now.',
    )
  } else {
    headline.push(
      `${spoken.length} thing${spoken.length === 1 ? '' : 's'} need${spoken.length === 1 ? 's' : ''} you.`,
      ...spoken.map(sentenceFor),
    )
  }

  const tail = []
  if (queued.length && spoken.length) {
    tail.push(
      `${queued.length} more ${queued.length === 1 ? 'is' : 'are'} in the review queue, including ${countDrafts(queued)} drafted repl${countDrafts(queued) === 1 ? 'y' : 'ies'} nobody has sent.`,
    )
  }
  /* Say what was skipped, and say what could not be read. A brief that is quiet
   * because a source was unreachable sounds exactly like a quiet morning, and
   * that is the one confusion that makes the whole feature untrustworthy. */
  if (repeats) tail.push(`${repeats} thing${repeats === 1 ? '' : 's'} you have already heard about.`)
  if (suppressed) tail.push(`I looked at ${suppressed} other thing${suppressed === 1 ? '' : 's'} and none of them need you.`)
  for (const problem of unavailable) tail.push(`I could not read ${problem}.`)

  const digest = fitWords([...headline, ...tail], policy.digestWords ?? 92)

  return {
    spoken: redactForDelivery(fitSpoken(headline)),
    narration: redactForDelivery(digest),
  }
}

function countDrafts(items) {
  return items.filter((item) => item.raw?.draft).length
}

/** Whole sentences up to a word budget. */
export function fitWords(sentences, budget) {
  const kept = []
  let words = 0
  for (const sentence of sentences.filter(Boolean)) {
    const cost = String(sentence).trim().split(/\s+/).length
    if (words + cost > budget && kept.length) break
    kept.push(String(sentence).trim())
    words += cost
  }
  return kept.join(' ')
}

/**
 * The written brief. Longer than the digest and structured for skimming,
 * because "leave a ready-to-review brief" is a different artifact from "tell me
 * the three things".
 */
export function renderTriageNote({
  title,
  spoken,
  policySource,
  horizon,
  told = [],
  queued = [],
  suppressed = 0,
  unavailable = [],
  problems = [],
  now = new Date(),
}) {
  const body = [
    `# ${title}`,
    '',
    spoken,
    '',
    `_Ranked against the next briefing at ${new Date(horizon).toLocaleString()}._`,
    policySource === 'owner'
      ? '_Using the interruption policy you stated._'
      : '_Using the placeholder interruption policy — you have not stated one yet, so these thresholds are a guess. POST /briefing/policy to replace them._',
    '',
    '## Told you',
    '',
  ]

  if (!told.length) body.push('_Nothing cleared the threshold._', '')
  for (const item of told) {
    body.push(
      `- **${item.title}** — ${item.detail || item.source} _(score ${item.score})_`,
      `  - ${item.why.join('; ')}`,
      `  - _source: ${item.provenance?.reader ?? 'unknown'}${item.provenance?.url ? ` — ${item.provenance.url}` : ''}_`,
    )
  }
  body.push('', '## Review queue — nothing here was acted on', '')

  if (!queued.length) body.push('_Empty._', '')
  for (const item of queued) {
    body.push(
      `- ${item.title} — ${item.detail || item.source} _(score ${item.score})_`,
      `  - ${item.why.join('; ') || 'kept for context'}`,
      `  - _source: ${item.provenance?.reader ?? 'unknown'}_`,
    )
    if (item.raw?.draft) {
      body.push(
        `  - **Draft reply prepared, not sent** — \`${item.raw.draft.path ?? 'in the review queue'}\``,
      )
    }
  }

  body.push('', '## Not said', '')
  body.push(
    `- ${suppressed} finding${suppressed === 1 ? '' : 's'} scored below anything worth reporting.`,
  )
  for (const source of unavailable) body.push(`- Could not read ${source}.`)
  /* The technical detail goes here and not into the spoken digest. Somebody has
   * to be able to fix a source that stopped answering, and the owner listening
   * on a bike is not that somebody. */
  if (problems.length) {
    body.push('', '<details><summary>Why a source did not answer</summary>', '')
    for (const problem of problems) body.push(`- \`${problem}\``)
    body.push('', '</details>')
  }

  body.push(
    '',
    `_Composed ${new Date(now).toLocaleString()}. Nothing was sent, replied to, clicked, or changed._`,
  )
  return redactForDelivery(body.join('\n'))
}

/* ---------------------------------------------------------------- gathering */

/**
 * Read every source, and let each one fail on its own.
 *
 * One unreachable source must not take the others down, and — more important —
 * must not be silently reported as "nothing there". Everything that fails lands
 * in `unavailable` and is said out loud in the brief.
 */
export async function gatherTriageFindings(
  { policy = DEFAULT_INTERRUPTION_POLICY, now = new Date(), knownPeople = [] } = {},
  {
    readEvents = listEvents,
    readReminders = listOpenReminders,
    triageMail = triageInbox,
    readAccountReports = pendingReports,
    browserStatus = getBrowserStatus,
  } = {},
) {
  const from = new Date(now)
  const to = new Date(new Date(now).getTime() + 7 * 24 * 3_600_000)
  const unavailable = []
  const problems = []

  /*
   * Two vocabularies for one failure, because they have different audiences.
   *
   * The first live run put a raw osascript stack — four lines of AppleScript
   * including `on pad2(n)` — into the spoken digest, which is unlistenable and
   * ate a third of the thirty-second budget. So `unavailable` holds the short
   * human phrase the brief says out loud, and `problems` holds the text an
   * engineer needs. Neither is dropped.
   */
  const settle = async (label, read) => {
    try {
      return await read()
    } catch (error) {
      unavailable.push(label)
      problems.push(
        `${label}: ${String(error?.message || error).replace(/\s+/g, ' ').slice(0, 300)}`,
      )
      return null
    }
  }

  const [events, reminders, mail, reports] = await Promise.all([
    settle('your calendar', () => readEvents({ from, to })),
    settle('your reminders', () => readReminders({})),
    settle('your inbox', () =>
      triageMail({
        now,
        sinceHours: policy.lookbackHours,
        maxDrafts: policy.maxDrafts,
        knownPeople,
      }),
    ),
    settle('your watched accounts', async () => readAccountReports({ now: new Date(now).getTime() })),
  ])

  /*
   * SILENCE THAT LOOKS LIKE GOOD NEWS.
   *
   * appleData.js reads Calendar and Reminders through EventKit, and its own
   * header says the authorization callback never completes under osascript. On
   * an unauthorised Mac that path does not throw — it returns an empty array.
   * Measured here: listEvents over a seven-day window returned 0 and
   * listOpenReminders returned 0, from a process with no Automation grant, on a
   * day briefing.test.js's captured fixtures show four real events.
   *
   * A briefing built on that says "nothing needs you" with total confidence,
   * which is the single worst thing this feature can do. Both sources empty at
   * once is the signature: a real Mac with sixteen calendars, one of them a
   * subscribed holiday feed, does not have a blank week AND an empty task list.
   * So the pair is corroborated rather than each read being trusted alone, and
   * the ambiguity is reported instead of resolved in the reassuring direction.
   */
  if (events?.length === 0 && reminders?.length === 0) {
    unavailable.push('your calendar and reminders')
    problems.push(
      'your calendar and reminders: EventKit returned nothing for both. That is what an empty week looks like, and it is also what an unauthorised read looks like — appleData.js cannot tell them apart under osascript. Treating it as unreadable rather than as a clear day.',
    )
  }

  /*
   * An offline extension is not a quiet account. The watch store still holds
   * whatever it saw last, so pendingReports answers happily while the browser
   * has been unreachable for hours — which reads as "nothing changed on your
   * accounts" when the truth is "nobody looked". browserBridge already knows
   * the difference, so ask it and say so.
   */
  let browser = null
  try {
    browser = browserStatus()
  } catch {
    /* The bridge being unreadable is itself "nobody looked", and the line
     * below already says that. */
  }
  if (browser && !browser.online) {
    unavailable.push('your logged-in accounts — the browser extension is offline')
  }

  return {
    findings: [
      ...findingsFromEvents(events ?? [], { now }),
      ...findingsFromReminders(reminders ?? [], { now }),
      ...findingsFromMailTriage(mail, { now }),
      ...findingsFromAccountReports(reports ?? [], { now }),
    ],
    mailRun: mail,
    unavailable,
    problems,
    browserOnline: browser ? Boolean(browser.online) : null,
  }
}

/* ------------------------------------------------------------------ dedupe */

/**
 * Everything this module has put on the audio shelf and the owner has not
 * played yet.
 *
 * Scoped to this producer. Superseding is destructive to a row, and a row this
 * module did not create is not its to retire — a research brief the owner is
 * saving for the train must survive a morning run.
 */
export function unplayedTriageBriefings({ list = listBriefings } = {}) {
  return list({ limit: 50 }).filter(
    (entry) => entry?.producer === 'briefingTriage' && !entry.played,
  )
}

/**
 * The fix for the duplicate-unplayed-briefings bug, in one function.
 *
 * The invariant it enforces: AT MOST ONE unplayed morning-triage brief exists
 * on the shelf.
 *
 * Measured on this Mac while writing this, from .pendant-briefings.json: 50
 * briefings stored, 50 of them unplayed, and 44 of those were the same
 * "Today's schedule — Friday, August 7" rendered between 17:37 and 17:40 —
 * roughly one every twenty seconds. The shelf caps at 50, so those 44 identical
 * copies had already evicted every other brief the owner had not heard. The
 * failure is not that the duplicates are annoying; it is that a duplicate is
 * how a briefing shelf deletes the briefings that mattered.
 *
 * The digest is a hash of what the brief actually says, so:
 *   - same digest, inside the rerun gap → return the existing brief and render
 *     nothing. The second run had no news, so it produces no artifact and costs
 *     no `say` invocation.
 *   - anything else → render, and retire every unplayed row this module wrote,
 *     including an identical but stale one. Only the shelf row goes; the .wav
 *     and .opus stay on disk, so nothing the owner might still want to hear is
 *     destroyed, and the new row records what it superseded.
 */
export function dedupeDecision({
  digest,
  now = new Date(),
  policy = DEFAULT_INTERRUPTION_POLICY,
  existing = null,
}) {
  const unplayed = existing ?? unplayedTriageBriefings()
  const identical = unplayed.find((entry) => entry.digest === digest)
  if (identical) {
    const age = new Date(now).getTime() - Date.parse(identical.createdAt)
    if (!Number.isFinite(age) || age < policy.minRerunGapMs) {
      return { render: false, reuse: identical, supersede: [] }
    }
  }
  return {
    render: true,
    reuse: null,
    supersede: unplayed.map((entry) => entry.id),
  }
}

export function digestOf({ spoken, told = [] }) {
  const material = [spoken, ...told.map((item) => item.fingerprint)].join('')
  return crypto.createHash('sha256').update(material).digest('hex').slice(0, 16)
}

/* ---------------------------------------------------------------- the run */

/*
 * Storage and speech. Identical vocabulary to briefing.js so its assertion
 * covers this path too, and there is deliberately nothing here that transmits.
 */
export const TRIAGE_SINKS = Object.freeze(['file', 'speech'])

/**
 * The whole capability: read, rank, cut to three, draft, queue, speak, store.
 *
 * Every reader is injectable because the Mac is the one part that cannot be
 * reproduced in a test — and the part that must be testable is the ranking,
 * which is the part that decides what the owner never hears.
 */
export async function runBriefingTriage(
  {
    now = new Date(),
    sinks = TRIAGE_SINKS,
    policy: policyOverride = null,
    knownPeople = [],
    play = false,
    store = true,
    queueFilePath = undefined,
  } = {},
  deps = {},
) {
  assertNeverSends(sinks)

  const { policy, source: policySource, note: policyNote } = activePolicy({
    filePath: queueFilePath,
    override: policyOverride,
  })
  const queueOptions = queueFilePath ? { filePath: queueFilePath } : {}

  const gathered = await gatherTriageFindings({ policy, now, knownPeople }, deps)
  const horizon = nextBriefingAt({ policy, now })

  /*
   * Composed is not heard.
   *
   * A brief still sitting unplayed on the shelf has told the owner nothing, so
   * everything it said is still news. Without this, the second run of a morning
   * finds its own first run in the ledger, concludes there is nothing new, and
   * supersedes real content with "nothing needs you right now" — which is how a
   * dedupe fix turns into a data-loss bug. Verified end to end before this
   * existed: run one said "2 things need you", run two three minutes later said
   * nothing and replaced it.
   */
  const unplayed = (deps.listShelf ?? listBriefings)({ limit: 50 }).filter(
    (entry) => entry?.producer === 'briefingTriage' && !entry.played,
  )
  const told = toldFingerprints({
    ...queueOptions,
    now: new Date(now).getTime(),
    excludeRunIds: unheardRunIds({
      ...queueOptions,
      unplayedBriefingIds: unplayed.map((entry) => entry.id),
    }),
  })

  const triaged = triageFindings({
    findings: gathered.findings,
    policy,
    now,
    nextAt: horizon,
    told,
  })

  const composed = composeTriage({
    spoken: triaged.spoken,
    queued: triaged.queued,
    suppressed: triaged.suppressed,
    repeats: triaged.repeats,
    policy,
    unavailable: gathered.unavailable,
    now,
  })

  const digest = digestOf({ spoken: composed.spoken.text, told: triaged.spoken })
  const title = `Morning triage — ${new Date(now).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })}`

  const note = renderTriageNote({
    title,
    spoken: composed.spoken.text,
    policySource,
    horizon,
    told: triaged.spoken,
    queued: triaged.queued,
    suppressed: triaged.suppressed,
    unavailable: gathered.unavailable,
    problems: gathered.problems,
    now,
  })

  const brief = {
    ok: true,
    status: 'success',
    id: `btg_${new Date(now).toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`,
    kind: 'triage',
    title,
    generatedAt: new Date(now).toISOString(),
    digest,
    horizon: new Date(horizon).toISOString(),
    policySource,
    policyNote: policyNote ?? null,
    policy,
    spoken: composed.spoken.text,
    narration: composed.narration.text,
    note: note.text,
    redaction: {
      spoken: composed.spoken.redaction,
      narration: composed.narration.redaction,
      note: note.redaction,
    },
    told: triaged.spoken.map(publicFinding),
    queued: triaged.queued.map(publicFinding),
    counts: {
      found: gathered.findings.length,
      told: triaged.spoken.length,
      queued: triaged.queued.length,
      suppressed: triaged.suppressed,
      repeats: triaged.repeats,
      drafts: countDrafts(triaged.queued),
    },
    unavailable: gathered.unavailable,
    browserOnline: gathered.browserOnline,
    mailReviewPath: gathered.mailRun?.reviewPath ?? null,
    /* The owner asked for this in nine of the eleven proposals. */
    sent: false,
    acted: false,
    response: composed.spoken.text,
    summary: composed.spoken.text,
  }

  /* Reader failures and sink failures land in one list. To the owner they are
   * the same fact — a part of the brief that did not happen — and splitting
   * them means a caller has to check two places to know whether it did. */
  const problems = [...gathered.problems]
  const requested = new Set(sinks)

  if (requested.has('file')) {
    try {
      /* briefing.js's writer, not a second one: this lands on the same shelf and
       * advances the same latest.json pointer, so GET /briefing/latest returns
       * the triage brief when it is the most recent thing composed. */
      brief.path = writeBriefingFile(brief)
    } catch (error) {
      problems.push(`file: ${String(error?.message || error)}`)
    }
  }

  if (requested.has('speech')) {
    try {
      Object.assign(brief, speakTriage(brief, { ...deps, policy, now, play }))
    } catch (error) {
      problems.push(`speech: ${String(error?.message || error)}`)
    }
  }

  brief.problems = problems

  if (store) {
    recordBriefingRun(
      {
        run: {
          id: brief.id,
          generatedAt: brief.generatedAt,
          digest,
          spoken: brief.spoken,
          notePath: brief.path ?? null,
          briefingId: brief.briefingId ?? null,
          suppressed: triaged.suppressed,
          policySource,
        },
        told: triaged.spoken,
        queued: triaged.queued.map((item) => ({
          ...publicFinding(item),
          draft: item.raw?.draft ?? null,
        })),
      },
      queueOptions,
    )
  }

  return brief
}

/* The finding as anything outside this module is allowed to see it. `raw`
 * carries the whole draft body and the envelope it came from; the queue writer
 * lifts the draft out deliberately, and nothing else needs the rest. */
function publicFinding(item) {
  return {
    fingerprint: item.fingerprint,
    source: item.source,
    title: item.title,
    detail: item.detail,
    at: item.at,
    actionableUntil: item.actionableUntil,
    band: item.band,
    score: item.score,
    why: item.why,
    signals: item.matched?.map((entry) => entry.signal) ?? [],
    provenance: item.provenance,
    hasDraft: Boolean(item.raw?.draft),
    previouslyToldAt: item.previouslyToldAt ?? null,
  }
}

/**
 * Render the digest onto audioBrief.js's shelf, or decline to.
 *
 * The dedupe decision happens before the render, not after: `say` plus the Opus
 * encode is the expensive part of this whole feature, and a second brief that
 * says nothing new should not cost it.
 */
export function speakTriage(
  brief,
  {
    policy = DEFAULT_INTERRUPTION_POLICY,
    now = new Date(),
    play = false,
    render = renderBriefAudio,
    saveShelf = saveBriefing,
    listShelf = listBriefings,
    deleteShelf = deleteBriefing,
    playOnMac = playBriefingOnMac,
  } = {},
) {
  const decision = dedupeDecision({
    digest: brief.digest,
    now,
    policy,
    existing: listShelf({ limit: 50 }).filter(
      (entry) => entry?.producer === 'briefingTriage' && !entry.played,
    ),
  })

  if (!decision.render) {
    return {
      briefingId: decision.reuse.id,
      audio: {
        id: decision.reuse.id,
        wavPath: decision.reuse.wavPath,
        opusPath: decision.reuse.opusPath,
        seconds: decision.reuse.seconds,
      },
      deduped: true,
      dedupeReason:
        'An unplayed brief on the shelf already says exactly this; it was not rendered again.',
    }
  }

  const audio = render({
    text: brief.narration,
    basename: briefingSlug('morning-triage', brief.generatedAt),
  })

  const stored = saveShelf({
    producer: 'briefingTriage',
    digest: brief.digest,
    topic: brief.title,
    mode: 'triage',
    headline: brief.spoken,
    notePath: brief.path ?? null,
    wavPath: audio.wavPath,
    opusPath: audio.opusPath,
    seconds: audio.seconds,
    pcmBytes: audio.pcmBytes,
    opusBytes: audio.opusBytes,
    truncated: audio.truncated,
    supersedes: decision.supersede,
    spoken: brief.narration,
  })

  for (const staleId of decision.supersede) deleteShelf(staleId)
  if (play) playOnMac(stored)

  return {
    briefingId: stored.id,
    /* Metadata only. renderBriefAudio hands back the PCM and Opus buffers it
     * just wrote, and spreading those into a stored run turns it into a
     * multi-megabyte JSON blob — the same trap briefing.js documents. */
    audio: {
      id: stored.id,
      wavPath: audio.wavPath,
      opusPath: audio.opusPath,
      seconds: audio.seconds,
      words: audio.words,
      truncated: audio.truncated,
    },
    deduped: false,
    superseded: decision.supersede,
  }
}

/* --------------------------------------------------------------- the command */

/*
 * Spoken phrasings that mean "brief me on what changed". Same reasoning as
 * briefing.js and mailTriage.js: a 7am routine that needs a model round trip is
 * a routine that silently does nothing during an API outage, and "every weekday
 * morning" is a promise the owner is relying on.
 *
 * These are matched AFTER briefing.js's own patterns by the caller, because
 * "morning brief" on its own is that module's, not this one's. What lands here
 * is phrasing that names the cross-account scope or the review queue.
 */
const TRIAGE_COMMAND_PATTERNS = [
  /\bwhat\s+(?:has\s+)?changed\b.*\b(?:overnight|since\s+(?:yesterday|last\s+night)|while\s+i\s+(?:slept|was\s+asleep))\b/i,
  /\b(?:check|review|look\s+at)\b.*\b(?:logged[\s-]?in|authenticated|signed[\s-]?in)\b.*\b(?:accounts?|tabs?|sites?)\b/i,
  /\b(?:the\s+)?(?:three|3)\s+things\s+i\s+need\s+to\s+know\b/i,
  /\b(?:morning|weekday)\s+triage\b|\btriage\s+my\s+(?:morning|day|accounts?)\b/i,
  /\breview\s+queue\b/i,
  /\bdigest\s+of\s+what\s+changed\b/i,
]

export function matchBriefingTriageCommand(command) {
  const text = String(command || '').trim()
  if (!text) return null
  return TRIAGE_COMMAND_PATTERNS.some((pattern) => pattern.test(text))
    ? { kind: 'triage' }
    : null
}

/* ------------------------------------------------------------------ routes */

/**
 * Wire this capability onto an existing Express app.
 *
 * A registration function rather than route definitions in server.js: several
 * agents are editing that file, and a feature that can be added by one import
 * and one call is a feature that does not produce a merge conflict. `deps` is
 * forwarded to the run so the routes are testable against fake readers.
 */
export function registerBriefingTriageRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerBriefingTriageRoutes needs an Express-like app.')
  }

  /* Compose one. POST because it reads the owner's mailbox and their browser,
   * which is not a thing a GET should do. */
  app.post('/briefing/triage', async (request, response) => {
    try {
      response.json(
        await runBriefingTriage(
          {
            sinks: request.body?.sinks || TRIAGE_SINKS,
            policy: request.body?.policy || null,
            knownPeople: request.body?.knownPeople || [],
            play: request.body?.playOnMac === true,
          },
          deps,
        ),
      )
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message })
    }
  })

  app.get('/briefing/triage/runs', (request, response) => {
    response.json({
      ok: true,
      location: briefingQueueLocation(),
      latest: lastBriefingRun(),
      runs: listBriefingRuns({ limit: Number(request.query?.limit) || 10 }),
    })
  })

  /* The review queue: what was found and not acted on. */
  app.get('/briefing/review', (request, response) => {
    const items = reviewQueue({
      includeResolved: request.query?.all === 'true',
    })
    response.json({
      ok: true,
      waiting: items.length,
      acted: false,
      note: 'Findings only. Nothing in this queue has been sent, replied to, or changed.',
      items,
    })
  })

  app.post('/briefing/review/:id', (request, response) => {
    try {
      const item = resolveQueueItem(request.params.id, {
        status: String(request.body?.status || 'reviewed'),
      })
      if (!item) {
        response.status(404).json({ ok: false, error: 'No such queued finding.' })
        return
      }
      response.json({ ok: true, item })
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message })
    }
  })

  /* The owner states their interruption policy. Until they do, GET returns the
   * placeholder and says so. */
  app.get('/briefing/policy', (_request, response) => {
    response.json({ ok: true, ...activePolicy() })
  })

  app.post('/briefing/policy', (request, response) => {
    try {
      response.json({
        ok: true,
        policy: normalizePolicy(statePolicy(request.body?.policy ?? request.body)),
        source: 'owner',
      })
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message })
    }
  })

  return [
    'POST /briefing/triage',
    'GET /briefing/triage/runs',
    'GET /briefing/review',
    'POST /briefing/review/:id',
    'GET /briefing/policy',
    'POST /briefing/policy',
  ]
}

import crypto from 'node:crypto'

import { assertNeverSends, fitSpoken, formatClock, writeBriefingFile } from './briefing.js'
import { recordBriefingRun } from './briefingQueue.js'
import { fitWords, redactForDelivery } from './briefingTriage.js'
import {
  assembleMeetingBrief,
  readUpcomingEvents,
  upcomingMeetings,
} from './meetingPrep.js'
import {
  QUEUE_BUDGET,
  commitQueue,
  listMeetingPrepQueue,
  planQueue,
  queueSpoken,
} from './meetingPrepQueue.js'

/*
 * "While I sleep, prepare tomorrow's brief and leave me a short audio queue."
 *
 * This is meetingPrep.js's assembly with the clock moved, and almost nothing
 * else. The meeting brief does not become a different artifact because it was
 * built at five in the morning; what changes is that there is no one to ask a
 * follow-up question of, so everything that would normally be a prompt has to
 * be a written answer or an admitted gap.
 *
 * THIS FILE OWNS NO CLOCK. Two schedulers already exist and adding a third is
 * how a codebase ends up with three definitions of "every morning":
 *
 *   local-agent/routines.js  fires while this Mac is awake, and runs the plan
 *                            through the same orchestrator a typed command
 *                            uses. ensureOvernightRoutine() registers there.
 *   cloud-relay/scheduler.js fires from a Cron Trigger when the Mac is not
 *                            awake, and dispatches a Mac-venue routine as an
 *                            ordinary queued job — which lands on POST
 *                            /meeting-prep/overnight when the Mac reappears.
 *
 * THE HONEST LIMIT of that arrangement, and it belongs in the report rather
 * than in a comment nobody reads: a Mac with its lid shut all night runs this
 * when the lid opens. If that is at 08:55 for a 09:00 meeting, the brief is
 * technically on time and practically useless. The relay can start the job but
 * it cannot read this Mac's Calendar, Mail or disk — so there is no version of
 * this that produces tomorrow's brief from a machine that was never awake.
 */

/* Storage and speech. Same vocabulary as briefing.js so its assertion covers
 * this path too, and there is deliberately nothing here that transmits. */
export const OVERNIGHT_SINKS = Object.freeze(['file', 'speech'])

/*
 * 05:00 rather than 07:00.
 *
 * The brief has to be finished before the owner reaches for the pendant, and
 * rendering four items through macOS `say` plus the Opus encode is minutes of
 * work, not seconds. Five also puts it after the overnight mail has landed —
 * a 03:00 run would compose a thread history missing the message that arrived
 * at 04:30 and would say nothing about it, which is worse than being an hour
 * later.
 */
export const OVERNIGHT_AT = process.env.PENDANT_MEETING_PREP_AT || '05:00'

/*
 * The routine's command is a sentence, not a function reference, because that
 * is the interface both schedulers take: they carry text to a planner. It is
 * phrased so meetingPrep.js's own matchMeetingPrepCommand() classifies it as
 * `overnight` without a model in the loop — a 5am routine that needs an API
 * round trip is a routine that silently does nothing during an outage.
 */
export const OVERNIGHT_COMMAND =
  "While I sleep, prepare tomorrow's meeting briefs and leave a short audio queue on the pendant."

export const OVERNIGHT_ROUTINE_NAME = "Tomorrow's meeting briefs"

export function overnightRoutine({ at = OVERNIGHT_AT } = {}) {
  return {
    name: OVERNIGHT_ROUTINE_NAME,
    command: OVERNIGHT_COMMAND,
    schedule: { kind: 'daily', at },
  }
}

/**
 * Register the overnight run with the scheduler that already exists.
 *
 * Idempotent on the command text, so calling it on every agent start does not
 * accumulate a routine per boot — which is the same "a queue that grows by the
 * number of times you looked at it" failure briefingQueue.js documents, in a
 * store that fires timers.
 *
 * routines.js is imported lazily: it pulls in the orchestrator, and a module
 * that is only needed when someone actually asks to be scheduled should not
 * cost that on import.
 */
export async function ensureOvernightRoutine({ at = OVERNIGHT_AT, list, create } = {}) {
  const routines = await import('./routines.js')
  const listAll = list ?? routines.listRoutines
  const createOne = create ?? routines.createRoutine

  const existing = listAll().find((routine) => routine.command === OVERNIGHT_COMMAND)
  if (existing) return { created: false, routine: existing }
  return { created: true, routine: createOne(overnightRoutine({ at })) }
}

/**
 * The owner's tomorrow, as a wall-clock day.
 *
 * Local midnight to local midnight, deliberately, rather than "the next 24
 * hours". A run at 05:00 with a 24-hour window would sweep in tomorrow's 04:00
 * — technically the day after — and miss nothing, but it would also present a
 * meeting the owner thinks of as Thursday's inside Wednesday's brief. The day
 * boundary the owner uses is the one their calendar app draws.
 */
export function tomorrowWindow({ now = new Date() } = {}) {
  const from = new Date(now)
  from.setHours(0, 0, 0, 0)
  from.setDate(from.getDate() + 1)
  const to = new Date(from)
  to.setDate(to.getDate() + 1)
  return { from, to }
}

/**
 * A stable identity for "this meeting was put in the review queue".
 *
 * Keyed on the meeting and its start time, not on the brief's contents, so a
 * meeting re-prepped twice in one night is one row whose seenCount reached two
 * — briefingQueue.js upserts on exactly this — while a meeting that MOVED is a
 * different row, because a moved meeting is genuinely new information.
 */
export function meetingFingerprint(brief) {
  return `mp_${crypto
    .createHash('sha256')
    .update(`${brief.meetingKey}${brief.meeting.start}`)
    .digest('hex')
    .slice(0, 24)}`
}

/**
 * The 35-second track for one meeting.
 *
 * Composed to a word budget rather than truncated to one, for audioBrief.js's
 * reason: a digest cut off at word 111 reads as a dropped connection, not as an
 * ending. Ordered by what degrades if unheard — a person waiting on a reply
 * first, then what is unsettled, then where the paper is. Sentences that fall
 * off the end of the budget are all in the written brief.
 */
export function narrateMeeting(brief, { words = QUEUE_BUDGET.wordsPerItem } = {}) {
  const start = new Date(brief.meeting.start)
  const sentences = [`${brief.meeting.title} at ${formatClock(start)}.`]

  const others = brief.attendees.filter((person) => !person.isOwner)
  if (others.length) {
    sentences.push(
      others.length <= 3
        ? `With ${others.map((person) => person.name).join(', ')}.`
        : `With ${others.length} others.`,
    )
  }

  const owed = brief.threads.filter((thread) => thread.awaitingOwner === true)
  for (const thread of owed.slice(0, 2)) {
    const who = thread.lastFrom?.name || thread.lastFrom?.email || 'someone'
    sentences.push(`${who} wrote last on "${thread.subject}" and you have not replied.`)
  }

  if (brief.questions.length) {
    sentences.push(`Still open: ${brief.questions[0].text}`)
    if (brief.questions.length > 1) {
      sentences.push(
        `And ${brief.questions.length - 1} other open question${brief.questions.length === 2 ? '' : 's'} in the written brief.`,
      )
    }
  }

  if (brief.actions.length) {
    sentences.push(`${brief.actions.length} prior action item${brief.actions.length === 1 ? '' : 's'} are in the folder.`)
  }
  if (brief.documents.length) {
    sentences.push(
      `${brief.documents.length} document${brief.documents.length === 1 ? '' : 's'} collected, starting with ${brief.documents[0].name}.`,
    )
  }

  return fitWords(sentences, words)
}

/**
 * The whole overnight capability: read tomorrow, assemble each meeting, write
 * one brief, queue the audio, leave the findings where the owner already looks.
 *
 * The review surface is briefingQueue.js's — the SAME queue the morning triage
 * writes to and the same one GET /briefing/review reads. A second review list
 * for meeting prep would be a second list the owner has to remember to open,
 * and the whole premise of leaving work overnight is that they only have to
 * open one thing.
 */
export async function runOvernightMeetingPrep(
  {
    now = new Date(),
    maxMeetings = 4,
    collect = true,
    audio = true,
    store = true,
    sinks = OVERNIGHT_SINKS,
    roots = undefined,
    threads = true,
  } = {},
  deps = {},
) {
  assertNeverSends(sinks)

  const { from, to } = tomorrowWindow({ now })
  const { events, calendarReadable, problems } = await readUpcomingEvents({ from, to }, deps)

  /* `from`, not `now`: a meeting is "upcoming" relative to the day being
   * prepared, and measuring against 05:00 today would be a filter that never
   * removes anything. */
  const meetings = upcomingMeetings(events, { now: from }).slice(0, Math.max(1, maxMeetings))

  const briefs = []
  const failures = [...problems]
  for (const meeting of meetings) {
    try {
      briefs.push(
        await assembleMeetingBrief(meeting, { now, collect, roots, threads }, deps),
      )
    } catch (error) {
      /* One meeting failing to assemble must not cost the owner the other
       * three. The failure is named in the brief rather than swallowed. */
      failures.push(`${meeting.title}: ${String(error?.message || error)}`)
    }
  }

  const forDate = new Date(from).toLocaleDateString('en-US', {
    weekday: 'long',
    month: 'long',
    day: 'numeric',
  })
  const title = `Tomorrow's meetings — ${forDate}`

  const spoken = redactForDelivery(
    fitSpoken(overnightHeadline({ briefs, calendarReadable, forDate })),
  )
  const note = redactForDelivery(
    renderOvernightNote({ title, briefs, calendarReadable, failures, now }),
  )

  const result = {
    ok: true,
    status: 'success',
    id: `mpo_${new Date(now).toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`,
    kind: 'meeting-prep',
    title,
    forDate: new Date(from).toISOString().slice(0, 10),
    generatedAt: new Date(now).toISOString(),
    calendarReadable,
    meetings: briefs.map(publicMeeting),
    briefs,
    note: note.text,
    redaction: { spoken: spoken.redaction, note: note.redaction },
    spoken: spoken.text,
    counts: {
      meetings: briefs.length,
      questions: briefs.reduce((total, brief) => total + brief.questions.length, 0),
      awaitingReply: briefs.reduce(
        (total, brief) => total + brief.threads.filter((thread) => thread.awaitingOwner === true).length,
        0,
      ),
      documents: briefs.reduce((total, brief) => total + brief.documents.length, 0),
    },
    unavailable: calendarReadable ? [] : ['your calendar'],
    problems: failures,
    /* Said in the payload as well as in the prose. Nothing on this path sends,
     * replies, accepts or declines anything. */
    sent: false,
    acted: false,
  }

  if (sinks.includes('file')) {
    try {
      /*
       * A LEAN object goes to the pointer file, not this whole result.
       * writeBriefingFile serialises what it is handed into latest.json, and
       * `briefs` carries every quote from every matched document — the same
       * trap briefing.js documents about spreading audio buffers into a stored
       * run. The note on disk is the full artifact; latest.json is a pointer.
       */
      result.path = writeBriefingFile({
        id: result.id,
        kind: result.kind,
        title,
        generatedAt: result.generatedAt,
        spoken: result.spoken,
        note: result.note,
        counts: result.counts,
        sent: false,
      })
    } catch (error) {
      failures.push(`file: ${String(error?.message || error)}`)
    }
  }

  if (audio && sinks.includes('speech')) {
    try {
      result.queue = queueForBriefs(briefs, { now, notePath: result.path ?? null }, deps)
      result.queueSpoken = queueSpoken(
        listMeetingPrepQueue(deps.listShelf ? { list: deps.listShelf } : {}).filter(
          (row) => !row.played,
        ),
      )
    } catch (error) {
      failures.push(`speech: ${String(error?.message || error)}`)
    }
  }

  if (store) {
    recordBriefingRun(
      {
        run: {
          id: result.id,
          generatedAt: result.generatedAt,
          digest: crypto.createHash('sha256').update(result.spoken).digest('hex').slice(0, 16),
          spoken: result.spoken,
          notePath: result.path ?? null,
          suppressed: 0,
          policySource: 'meeting-prep',
        },
        /*
         * Nothing is "told". Meeting prep is not an interruption — it is work
         * left where the owner will look — so it consumes none of the morning
         * brief's three spoken slots and writes no fingerprints into that
         * module's novelty ledger. Everything goes to the review queue.
         */
        told: [],
        queued: briefs.map((brief) => reviewRow(brief, now)),
      },
      deps.queueFilePath ? { filePath: deps.queueFilePath } : {},
    )
  }

  result.problems = failures
  return result
}

function publicMeeting(brief) {
  return {
    title: brief.meeting.title,
    start: brief.meeting.start,
    location: brief.meeting.location ?? null,
    attendees: brief.attendees.map((person) => person.name),
    awaitingReply: brief.threads.filter((thread) => thread.awaitingOwner === true).length,
    questions: brief.questions.length,
    documents: brief.documents.length,
    folder: brief.folder,
  }
}

function reviewRow(brief, now) {
  const owed = brief.threads.filter((thread) => thread.awaitingOwner === true)
  return {
    fingerprint: meetingFingerprint(brief),
    source: 'meeting-prep',
    title: brief.meeting.title,
    detail: [
      brief.attendees.filter((person) => !person.isOwner).map((person) => person.name).join(', '),
      brief.meeting.location,
    ]
      .filter(Boolean)
      .join(' · '),
    why: [
      owed.length ? `${owed.length} thread${owed.length === 1 ? '' : 's'} waiting on your reply` : null,
      brief.questions.length ? `${brief.questions.length} open question${brief.questions.length === 1 ? '' : 's'}` : null,
      brief.documents.length ? `${brief.documents.length} document${brief.documents.length === 1 ? '' : 's'} collected` : null,
    ].filter(Boolean),
    score: 0,
    at: brief.meeting.start,
    /* A typed calendar start, never a deadline inferred from prose — the rule
     * briefingTriage.js's finding shape is built on, kept here so a meeting-prep
     * row ranks against the same clock as everything else in the queue. */
    actionableUntil: brief.meeting.start,
    provenance: {
      reader: 'local-agent/meetingPrep.js assembleMeetingBrief (EventKit + Mail + local files)',
      observedAt: new Date(now).toISOString(),
      reference: brief.meeting.uid ?? null,
      folder: brief.folder,
      capsuleIds: [],
    },
    /* There is no draft. Meeting prep composes nothing addressed to anybody, so
     * there is nothing here that could be sent by accident. */
    draft: null,
  }
}

/**
 * Put one track per meeting on the pendant, inside a fixed budget.
 *
 * meetingPrepQueue.js holds the rules; this only supplies the items. The order
 * is the day's order, so a queue that can only hold three of five holds the
 * three that happen first.
 */
export function queueForBriefs(briefs, { now = new Date(), notePath = null } = {}, deps = {}) {
  const existing = listMeetingPrepQueue(deps.listShelf ? { list: deps.listShelf } : {})
  const items = briefs.map((brief) => ({
    meetingKey: brief.meetingKey,
    meetingStart: brief.meeting.start,
    title: brief.meeting.title,
    headline: brief.spoken,
    notePath: brief.folder ? `${brief.folder}/BRIEF.md` : notePath,
    /* Redacted before it is spoken, for briefingTriage.js's reason: a subject
     * line the owner never looked at should not reach a synthesiser without
     * passing the same classifier every other exported string passes. */
    text: redactForDelivery(narrateMeeting(brief)).text,
  }))

  const plan = planQueue({ items, existing, now })
  return commitQueue(plan, { existing, now, ...pickAudioDeps(deps) })
}

/* Only the audio-shelf overrides are forwarded. Passing `deps` wholesale would
 * hand commitQueue the calendar and mail readers under names it does not use
 * today and might tomorrow. */
function pickAudioDeps(deps) {
  const picked = {}
  if (deps.render) picked.render = deps.render
  if (deps.saveShelf) picked.save = deps.saveShelf
  if (deps.deleteShelf) picked.remove = deps.deleteShelf
  return picked
}

/** The one-line version, for the pendant's 180-character spoken slot. */
export function overnightHeadline({ briefs = [], calendarReadable = true, forDate }) {
  if (!calendarReadable) {
    return [
      'I could not read your calendar overnight, so I do not know what tomorrow holds.',
      'That is not the same as a clear day.',
    ]
  }
  if (!briefs.length) return [`Nothing on your calendar for ${forDate}.`]

  const owed = briefs.reduce(
    (total, brief) => total + brief.threads.filter((thread) => thread.awaitingOwner === true).length,
    0,
  )
  const questions = briefs.reduce((total, brief) => total + brief.questions.length, 0)

  const parts = [
    `${briefs.length} meeting${briefs.length === 1 ? '' : 's'} tomorrow, starting with ${briefs[0].meeting.title} at ${formatClock(new Date(briefs[0].meeting.start))}.`,
  ]
  if (owed) {
    parts.push(`${owed} thread${owed === 1 ? '' : 's'} waiting on your reply.`)
  }
  if (questions) {
    parts.push(`${questions} open question${questions === 1 ? '' : 's'}.`)
  }
  return parts
}

/**
 * The written brief: one section per meeting, each one meetingPrep's own
 * markdown, and a closing section about the run itself.
 *
 * The per-meeting briefs are embedded rather than linked. The owner reads this
 * on a phone before they are out of bed; four links to four folders is four
 * things they will not open.
 */
export function renderOvernightNote({ title, briefs = [], calendarReadable = true, failures = [], now = new Date() }) {
  const body = [`# ${title}`, '']

  if (!calendarReadable) {
    body.push(
      '> **I could not read your calendar.** EventKit returned nothing for both events and reminders, which is what an empty day looks like and also what an unauthorised read looks like. This brief is empty because I could not see, not because you have nothing on.',
      '',
    )
  } else if (!briefs.length) {
    body.push('_Nothing on the calendar that looks like a meeting._', '')
  }

  for (const brief of briefs) {
    /* Demoted one level so the day's title stays the only H1. */
    body.push(brief.brief.replace(/^#/gm, '##'), '')
  }

  body.push('## About this run', '')
  body.push(
    `- Composed at ${new Date(now).toLocaleString()}, while you were not asked anything.`,
    '- Nothing was sent, replied to, accepted, declined, or changed.',
    '- Everything above is in your review queue at `GET /briefing/review`.',
  )
  if (failures.length) {
    body.push('', '<details><summary>What did not work</summary>', '')
    for (const failure of failures) body.push(`- \`${failure}\``)
    body.push('', '</details>')
  }

  return body.join('\n')
}

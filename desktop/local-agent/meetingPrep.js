import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listEvents, listOpenReminders } from './appleData.js'
import { workspacePath } from './config.js'
import {
  meetingThreadHistory,
  parseAddress,
  samePerson,
  summarizeThread,
} from './meetingPrepThreads.js'

/*
 * "Prepare me for my next meeting: find the agenda and related local documents,
 * summarize the open decisions and prior action items."
 *
 * The useful half of this is retrieval, not summary. The owner already knows
 * what the meeting is about; what they cannot do in the corridor is remember
 * which of four hundred files is the one with last month's decision in it. So
 * the effort goes into scoring local documents against the meeting, and the
 * "summary" is extraction — the sentences that already say "we decided" and
 * "I'll send", quoted, with the file they came from.
 *
 * It quotes rather than paraphrases on purpose. A paraphrased action item that
 * drops a name or a date is indistinguishable from a real one until the meeting
 * is already going wrong, and this runs unattended before the owner is looking.
 *
 * ONE CAPABILITY, THREE PHRASINGS. Three separate proposals — "get me ready for
 * my next meeting", "investigate my open threads overnight and leave a brief",
 * "prepare tomorrow's brief and a short audio queue" — are the same work at two
 * times of day: assemble everything relevant to a commitment before the owner
 * asks. So the assembly is one function, assembleMeetingBrief(), and the three
 * entry points differ only in WHICH meeting they hand it:
 *
 *   prepareForNextMeeting()   the next one on the calendar
 *   prepareForNamedMeeting()  the one the owner named out loud
 *   meetingPrepOvernight.js   every one on tomorrow's calendar, run while the
 *                             owner is asleep by the schedulers that already
 *                             exist (local-agent/routines.js on this Mac,
 *                             cloud-relay/scheduler.js when it is not awake)
 *
 * FOUR THINGS GO IN THE BRIEF, and they are four because a meeting goes wrong
 * in four different ways: you do not know who is in the room (attendees), you
 * have lost the thread of the conversation that led here (thread history), you
 * cannot find the document (documents), and you have forgotten what was left
 * unsettled (open questions). The fourth is kept apart from decisions
 * deliberately — see extractMeetingMaterial().
 */

const SEARCH_ROOTS = [
  workspacePath,
  path.join(os.homedir(), 'Documents'),
  path.join(os.homedir(), 'Downloads'),
  path.join(os.homedir(), 'Desktop'),
]

const READABLE_EXTENSIONS = new Set([
  '.md', '.txt', '.markdown', '.rst', '.org', '.json', '.csv', '.log',
])

/* Extensions worth surfacing by name even though their bytes are not text. */
const REFERENCE_EXTENSIONS = new Set([
  '.pdf', '.docx', '.doc', '.pages', '.key', '.pptx', '.ppt', '.xlsx', '.numbers',
])

const MAX_SCAN_FILES = 4000
const MAX_SCAN_DEPTH = 4
const MAX_READ_BYTES = 200_000
const MAX_FILE_AGE_MS = 180 * 24 * 60 * 60 * 1000

const DECISION_MARKERS =
  /\b(we (?:decided|agreed|settled on)|decision:|decided to|agreed to|going with|the call is|open question|still (?:undecided|open)|tbd|to be decided)\b/i

/*
 * The half of DECISION_MARKERS that means the opposite of a decision.
 *
 * "We decided to ship at 24 kHz" and "TBD: whether we keep the ESP32 bridge"
 * were arriving under one heading called "Open decisions", which is a heading
 * that quietly lies in both directions: it makes a settled thing look
 * reopenable and an unsettled thing look agreed. Walking into a meeting
 * believing a live question is already closed is the expensive direction of
 * that error — nobody raises it, and it surfaces after the decision it should
 * have informed. So a sentence carrying both a decision marker and a question
 * marker is filed as a QUESTION.
 */
const QUESTION_MARKERS =
  /\b(open question|still (?:undecided|open)|tbd|to be decided|not (?:yet )?decided|undecided|unresolved|needs? a decision|we need to decide|question for)\b/i

/* A markdown heading, of either style this codebase's notes actually use. */
const HEADING_LINE = /^#{1,6}\s+\S/
const BULLET_LINE = /^(?:[-*+]\s+|\d+[.)]\s+|\[[ xX]\]\s*)/

/*
 * "## Open questions" followed by bullets is a question list stated
 * structurally: the author said so with a heading rather than with a phrase
 * inside each line. Matching the heading and taking its bullets is the only way
 * to get "Do we keep the ESP32 bridge?" out of a note that never writes the
 * words "open question" on the same line as the question.
 *
 * A heading is required — either a `#` heading or a line ending in a colon.
 * Without that anchor, "Questions were raised about the budget" opens a section
 * and swallows the rest of the document.
 */
function isQuestionHeading(line) {
  const text = String(line).trim()
  if (HEADING_LINE.test(text)) {
    return /^#{1,6}\s+(?:open\s+|outstanding\s+)?questions?\b/i.test(text)
  }
  return /^(?:open\s+|outstanding\s+)?questions?\b.{0,40}:\s*$/i.test(text)
}

/*
 * Explicit markers only. "I'll" and "we'll" anywhere in a sentence looked like
 * a commitment and turned out to be how people talk: run against a real meeting
 * transcript it returned "I'm not planning to collect any fees, but I'll apply
 * for grants" as a prior action item. A transcript is mostly future tense, so
 * the tense is not the signal — the label is.
 */
const ACTION_MARKERS =
  /\b(action item|next step|follow[- ]up|todo|to-do|assigned to|owner:|due (?:by|on)|by (?:monday|tuesday|wednesday|thursday|friday|next week))\b/i

/* A commitment stated as a whole short sentence, not buried mid-paragraph:
 * "I'll rerun the probe", "Jorge will send the BOM". The subject has to be the
 * first thing in the sentence, which is what a written commitment looks like
 * and what a transcript of someone thinking out loud does not.
 *
 * The separator is required rather than optional: with it optional the pattern
 * split single words and read "all the raw components are cheap" as "a" + "ll"
 * + " the", which is how that sentence ended up in a meeting brief. */
const LEADING_COMMITMENT = /^(?:i|we|[a-z]+)(?:['’]ll|\s+will)\s+\w+/i

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'meeting', 'call', 'sync',
  'weekly', 'monthly', 'invite', 'zoom', 'google', 'between', 'about', 'into',
])

/*
 * Words that describe the ASKING rather than the meeting. "Get me ready for the
 * pendant firmware review" names one meeting; every word before "pendant" names
 * the request. They are stripped before a name is matched against a calendar,
 * or "meeting" matches every meeting equally and the owner gets whichever one
 * sorted first.
 */
const REQUEST_WORDS = new Set([
  'get', 'me', 'ready', 'for', 'prep', 'prepare', 'brief', 'my', 'the', 'our',
  'this', 'next', 'upcoming', 'today', 'tomorrow', 'please', 'before', 'need',
  'know', 'what', 'do', 'i', 'to', 'on', 'at', 'a', 'an',
])

/* -------------------------------------------------------- reading the calendar */

/**
 * Upcoming events, and whether the calendar could be read at all.
 *
 * THE TRAP, and it is measured, not theoretical: appleData.js reads Calendar
 * through EventKit, whose authorization callback never completes under
 * osascript. On a Mac without the grant the read does not throw — it returns an
 * empty array. So "you have nothing coming up" and "I am not allowed to look"
 * arrive as the same value, and the first one is a sentence this feature will
 * say with total confidence at 6am while the owner sleeps through a 9am
 * interview.
 *
 * briefingTriage.js established the corroboration: both EventKit reads empty at
 * once is the signature, because a real Mac with sixteen calendars and an open
 * task list does not have a blank day AND nothing to do. That check is repeated
 * here rather than imported because this module reads a different window
 * (the next few hours, not the next week) and the corroborating read has to
 * cover the same absence.
 *
 * If the corroborating read THROWS, the answer is still "unreadable" — a
 * failure to corroborate is not corroboration.
 */
export async function readUpcomingEvents(
  { from, to } = {},
  { readEvents = listEvents, readReminders = listOpenReminders } = {},
) {
  const events = (await readEvents({ from, to })) ?? []
  if (events.length) return { events, calendarReadable: true, problems: [] }

  let reminders = null
  let reminderError = null
  try {
    reminders = await readReminders({})
  } catch (error) {
    reminderError = String(error?.message || error)
  }

  if (reminders?.length) {
    /* EventKit answered a different question happily, so the grant is real and
     * the empty window is an empty window. */
    return { events, calendarReadable: true, problems: [] }
  }

  return {
    events,
    calendarReadable: false,
    problems: [
      reminderError
        ? `your calendar: EventKit returned nothing, and the corroborating reminders read failed (${reminderError}). Treating the calendar as unreadable rather than as a clear day.`
        : 'your calendar: EventKit returned nothing for both events and reminders. That is what an empty day looks like, and it is also what an unauthorised read looks like — appleData.js cannot tell them apart under osascript. Treating it as unreadable rather than as a clear day.',
    ],
  }
}

/* -------------------------------------------------------- choosing a meeting */

/** The words of a spoken meeting name that could plausibly name a meeting. */
export function nameTokens(name) {
  return [
    ...new Set(
      String(name ?? '')
        .toLowerCase()
        .replace(/[^\p{L}\p{N}\s:]/gu, ' ')
        .split(/\s+/)
        .filter(Boolean)
        .filter((word) => !REQUEST_WORDS.has(word) && !STOP_WORDS.has(word)),
    ),
  ]
}

/**
 * The meeting the owner named, or an honest refusal to guess.
 *
 * Ambiguity is returned rather than resolved. "My meeting with Jorge" against a
 * calendar holding two meetings with Jorge has no right answer, and picking the
 * earlier one produces a folder of documents for the wrong conversation with
 * nothing in the output to suggest anything was chosen. A tie is reported, both
 * candidates are named, and the owner disambiguates in one word.
 *
 * Attendees and location are scored alongside the title because that is how
 * people name meetings out loud: "my 4 o'clock with Jorge" and "the zoom with
 * the vendor" contain no words from the invite's title at all.
 */
export function matchMeetingName(events = [], name) {
  const wanted = nameTokens(name)
  if (!wanted.length) return { meeting: null, ambiguous: false, candidates: [] }

  const phrase = String(name ?? '').toLowerCase().trim()

  /*
   * TWO OF THE OWNER'S WORDS, OR THE ONLY ONE THEY USED.
   *
   * Accepting a single token from a multi-word name is how "the board review"
   * matches "Pendant firmware review" — on the word "review" — and produces a
   * complete, confident brief for a different meeting with nothing in the
   * output to suggest a substitution happened. One word is only ever enough
   * when one word is all there was ("Jorge"). Past two the requirement scales
   * with the length of the name, so a five-word title is not matched by two
   * incidental words.
   */
  const minMatched = Math.max(Math.min(2, wanted.length), Math.ceil(wanted.length / 2))

  const candidates = events
    .map((event) => {
      const haystack = `${event.title || ''} ${(event.attendees || []).join(' ')} ${event.location || ''} ${event.calendar || ''}`
        .toLowerCase()
      const matched = wanted.filter((token) => haystack.includes(token))
      /* A whole phrase landing in the title is a much stronger claim than the
       * same words scattered across the invite, and it is what makes "summer
       * interview" beat an unrelated event that merely mentions summer. */
      const phraseBonus = phrase && String(event.title || '').toLowerCase().includes(phrase) ? 4 : 0
      return { event, matched, score: matched.length * 2 + phraseBonus }
    })
    .filter((candidate) => candidate.matched.length >= minMatched)
    .sort(
      (left, right) =>
        right.score - left.score || Date.parse(left.event.start) - Date.parse(right.event.start),
    )

  if (!candidates.length) return { meeting: null, ambiguous: false, candidates: [] }

  const ambiguous = candidates.length > 1 && candidates[1].score === candidates[0].score

  return {
    meeting: ambiguous ? null : candidates[0].event,
    ambiguous,
    candidates: candidates.slice(0, 4).map((candidate) => ({
      title: candidate.event.title,
      start: candidate.event.start,
      score: candidate.score,
      matched: candidate.matched,
    })),
  }
}

/* ------------------------------------------------------------- the assembly */

/**
 * Everything worth having open before this meeting starts.
 *
 * This is the whole capability and it does not know what time it is. Called at
 * 8:55am for a 9am call, called at 5am for tomorrow's, it does the same work —
 * which is the point: "get me ready for my next meeting" and "prepare
 * tomorrow's brief overnight" differ in when they run, not in what they need.
 *
 * Readers are injectable because the calendar and the mailbox are the parts a
 * test cannot have; the scoring, extraction and composition can.
 */
export async function assembleMeetingBrief(
  meeting,
  {
    now = new Date(),
    maxDocuments = 3,
    roots = SEARCH_ROOTS,
    collect = true,
    threads: wantThreads = true,
    threadLimit = 4,
    threadDays = 30,
  } = {},
  { readThreads = meetingThreadHistory } = {},
) {
  const candidates = scanDocuments(roots, { now })
  const terms = discriminatingTerms(meetingTerms(meeting), candidates)
  const documents = rankDocuments(candidates, terms).slice(0, Math.max(1, maxDocuments))

  const extracted = documents.map((document) => ({
    ...document,
    ...extractMeetingMaterialFromFile(document.path),
  }))

  /*
   * ONE mailbox read, not two.
   *
   * The previous shape read the inbox once for a flat list of matching
   * envelopes and would have read it again for thread history. appleData.js's
   * header says why that is wrong — two readers of one mailbox eventually
   * disagree about what "recent" means — so the thread read is the mail read,
   * and the flat list is derived from it.
   */
  let history = { threads: [], ownerAddresses: [], sentReadable: null, limits: [] }
  let mailError = null
  if (wantThreads) {
    try {
      history = await readThreads({
        attendees: meeting.attendees || [],
        terms,
        limit: threadLimit,
        sinceDays: threadDays,
        now,
      })
    } catch (error) {
      /* Mail being unavailable must not cost the owner their documents. */
      mailError = String(error?.message || error)
    }
  }

  const attendees = attendeeRoster(meeting, history)

  /*
   * The invite's own notes are a document too, and usually the only one written
   * by the person who called the meeting. Reading questions out of it costs a
   * regex over a string already in memory and is the single highest-yield
   * source in the whole brief.
   */
  const inviteQuestions = meeting.notes?.trim()
    ? extractOpenQuestions(meeting.notes, 'the invite')
    : []

  const decisions = dedupe(extracted.flatMap((document) => document.decisions))
  const actions = dedupe(extracted.flatMap((document) => document.actions))
  const questions = dedupe([
    ...inviteQuestions,
    ...extracted.flatMap((document) => document.questions),
  ])

  const mail = history.threads.flatMap((thread) =>
    thread.messages.map((message) => ({
      subject: message.subject,
      sender: message.sender,
      receivedAt: message.sentAt,
      thread: thread.key,
    })),
  )

  const blindSpots = briefBlindSpots({ history, mailError, documents: extracted })

  const folder = collect ? collectIntoFolder(meeting, extracted, { now }) : null
  const brief = formatBrief({
    meeting,
    documents: extracted,
    attendees,
    threads: history.threads,
    decisions,
    actions,
    questions,
    blindSpots,
  })
  if (folder) {
    fs.writeFileSync(path.join(folder, 'BRIEF.md'), brief, 'utf8')
  }

  return {
    ok: true,
    meeting: {
      uid: meeting.uid ?? null,
      title: meeting.title,
      start: meeting.start,
      end: meeting.end,
      location: meeting.location,
      attendees: meeting.attendees,
      hasAgendaInInvite: Boolean(meeting.notes?.trim()),
    },
    /* Stable across a meeting's whole life, so the audio queue can tell "the
     * same meeting, re-prepped" from "a second meeting". The uid is EventKit's
     * and survives the meeting being moved; the title is the fallback for a
     * calendar that did not give us one. */
    meetingKey: meeting.uid || `${meeting.title}@${meeting.start}`,
    agenda: meeting.notes?.trim() || null,
    terms,
    attendees,
    threads: history.threads,
    /* The quotes are returned once, merged and deduped, rather than repeated
     * under every document they came from. */
    documents: extracted.map((document) => ({
      path: document.path,
      name: document.name,
      bytes: document.bytes,
      modifiedAt: document.modifiedAt,
      readable: document.readable,
      matchedTerms: document.matchedTerms,
      score: document.score,
    })),
    decisions,
    actions,
    questions,
    mail,
    mailError,
    blindSpots,
    folder,
    brief,
    spoken: speakableSummary({
      meeting,
      decisions,
      actions,
      questions,
      threads: history.threads,
      documents: extracted,
      now,
    }),
  }
}

/**
 * Everything worth having open before the NEXT meeting starts.
 *
 * The published entry point since this module existed; server.js and
 * computerControl.js both call it with no injected readers.
 */
export async function prepareForNextMeeting(
  {
    now = new Date(),
    withinHours = 24,
    maxDocuments = 3,
    roots = SEARCH_ROOTS,
    collect = true,
    threads = true,
  } = {},
  deps = {},
) {
  const { events, calendarReadable, problems } = await readUpcomingEvents(
    {
      from: now,
      to: new Date(new Date(now).getTime() + withinHours * 60 * 60 * 1000),
    },
    deps,
  )

  const meeting = upcomingMeetings(events, { now })[0]

  if (!meeting) {
    return emptyResult({ calendarReadable, problems, withinHours })
  }

  return {
    ...(await assembleMeetingBrief(meeting, { now, maxDocuments, roots, collect, threads }, deps)),
    calendarReadable,
  }
}

/**
 * The same brief, for a meeting the owner named out loud.
 *
 * The window is wider than the next-meeting default because a named meeting is
 * usually not the next one — "get me ready for the board review" is said days
 * ahead, and a 24-hour window would answer "I cannot find it" for a meeting
 * that is plainly on the calendar.
 */
export async function prepareForNamedMeeting(
  {
    name,
    now = new Date(),
    withinHours = 14 * 24,
    maxDocuments = 3,
    roots = SEARCH_ROOTS,
    collect = true,
    threads = true,
  } = {},
  deps = {},
) {
  if (!String(name ?? '').trim()) {
    throw new Error('Which meeting? prepareForNamedMeeting needs a name to match.')
  }

  const { events, calendarReadable, problems } = await readUpcomingEvents(
    {
      from: now,
      to: new Date(new Date(now).getTime() + withinHours * 60 * 60 * 1000),
    },
    deps,
  )

  const match = matchMeetingName(upcomingMeetings(events, { now }), name)

  if (match.ambiguous) {
    return {
      ok: true,
      meeting: null,
      ambiguous: true,
      calendarReadable,
      candidates: match.candidates,
      /* Named, not counted. "Two meetings match" sends the owner to look it up
       * themselves, which is the work they asked us to do. */
      spoken: `More than one meeting matches "${name}": ${match.candidates
        .map((candidate) => candidate.title)
        .join(', ')}. Which one?`,
    }
  }

  if (!match.meeting) {
    return {
      ...emptyResult({ calendarReadable, problems, withinHours }),
      requested: name,
      spoken: calendarReadable
        ? `I could not find a meeting matching "${name}" in the next ${Math.round(withinHours / 24)} days.`
        : 'I could not read your calendar, so I cannot tell you whether that meeting exists.',
    }
  }

  return {
    ...(await assembleMeetingBrief(
      match.meeting,
      { now, maxDocuments, roots, collect, threads },
      deps,
    )),
    calendarReadable,
    requested: name,
    matched: match.candidates[0] ?? null,
  }
}

/** Meetings that have not finished yet, soonest first. */
export function upcomingMeetings(events = [], { now = new Date() } = {}) {
  const nowMs = new Date(now).getTime()
  return events
    .filter((event) => event && !event.allDay && event.start)
    .filter((event) => {
      const end = Date.parse(event.end ?? '')
      /* A meeting that is already over cannot be prepared for; one that is
       * running still can, and the owner joining ten minutes late is exactly
       * when they most want the brief. */
      return !Number.isFinite(end) || end > nowMs
    })
    .filter(looksLikeMeeting)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))
}

/*
 * Nothing found — and the two reasons for that are said differently.
 *
 * "Nothing on your calendar" is a fact about the owner's day. "I could not read
 * your calendar" is a fact about this program. Reporting the second as the
 * first is the failure this whole feature has to avoid, so they never share a
 * sentence.
 */
function emptyResult({ calendarReadable, problems, withinHours }) {
  return {
    ok: true,
    meeting: null,
    calendarReadable,
    problems,
    unavailable: calendarReadable ? [] : ['your calendar'],
    spoken: calendarReadable
      ? `Nothing on your calendar in the next ${withinHours} hours.`
      : 'I could not read your calendar, so I do not know what is coming up. That is not the same as a clear day.',
  }
}

/**
 * Who is in the room, and what this Mac knows about each of them.
 *
 * An attendee list from an invite is a list of strings. What makes it worth
 * printing is the join against the thread history: this person wrote to you
 * four times in the last fortnight, most recently on Tuesday, and you have not
 * answered. `knownFrom` is on every row because "I only know their name" is a
 * real and common answer, and a roster that quietly omits it reads as though
 * the silence meant something.
 */
export function attendeeRoster(meeting, { threads = [], ownerAddresses = [] } = {}) {
  return (meeting.attendees || []).map((raw) => {
    const person = parseAddress(raw)
    const isOwner = Boolean(person.email) && ownerAddresses.includes(person.email)
    const theirThreads = threads.filter((thread) =>
      thread.participants.some((participant) => samePerson(person, participant)),
    )
    const rows = theirThreads.flatMap((thread) =>
      thread.participants.filter((participant) => samePerson(person, participant)),
    )
    const messageCount = rows.reduce((total, row) => total + (row.messageCount || 0), 0)
    const lastHeardFrom = rows
      .map((row) => row.lastAt)
      .filter(Boolean)
      .sort()
      .at(-1) ?? null

    return {
      name: person.name || String(raw),
      email: person.email || null,
      isOwner,
      messageCount,
      lastHeardFrom,
      threads: theirThreads.map((thread) => thread.subject),
      /* Only ever true when Sent was readable; buildThreads returns null
       * otherwise, and null is not true. */
      awaitingYourReply: theirThreads.some((thread) => thread.awaitingOwner === true),
      knownFrom: messageCount ? ['the invite', 'your mail'] : ['the invite'],
    }
  })
}

/**
 * What this brief could not see, in the owner's words.
 *
 * Written into the brief itself rather than left in a log. A brief with an
 * empty "open questions" section means one of two very different things — there
 * were none, or nothing that could hold one was readable — and the owner has no
 * way to tell which from the outside.
 */
export function briefBlindSpots({ history = {}, mailError = null, documents = [] } = {}) {
  const gaps = []

  if (mailError) {
    gaps.push('I could not read Mail at all, so there is no thread history in this brief.')
  } else {
    for (const limit of history.limits ?? []) gaps.push(limit)
    gaps.push(
      'I read who wrote, not who was copied — an attendee who has only ever been cc’d does not appear in the thread history.',
    )
  }

  if (!documents.length) {
    gaps.push('No local document matched this meeting, so nothing was quoted.')
  } else if (documents.every((document) => !document.readable)) {
    gaps.push(
      'The matching documents are all formats I cannot read as text, so they are listed by name without quotes.',
    )
  } else if (documents.some((document) => !document.readable)) {
    gaps.push(
      'Some matching documents are formats I cannot read as text; those are listed by name only.',
    )
  }

  /* Said every time, because it is true every time and it is the limit most
   * likely to matter: a decision reached in a chat app, a call, or a corridor
   * is invisible to a brief built from a calendar, a mailbox and a disk. */
  gaps.push(
    'Anything agreed in a chat app, on a call, or in person is not here. This brief is built from your calendar, your mailbox and your files.',
  )

  return gaps
}

/*
 * A calendar is not a list of meetings. It also holds the owner's own alarms —
 * "stand up", "take meds", a 5-minute recurring nudge with nobody else in it —
 * and preparing a briefing folder for one of those is the wrong answer to
 * "prepare me for my next meeting", delivered confidently.
 *
 * The three signals that separate the two are all on the event: somebody else
 * is invited, there is somewhere to be, or it is long enough that a person
 * blocked time out for it.
 */
export function looksLikeMeeting(event, { minMinutes = 15 } = {}) {
  if ((event.attendees || []).length > 0) return true
  if (String(event.location || '').trim()) return true
  const minutes = (Date.parse(event.end) - Date.parse(event.start)) / 60_000
  return Number.isFinite(minutes) && minutes >= minMinutes
}

/** Words from the invite that a filename or a document could plausibly share. */
export function meetingTerms(meeting) {
  const words = `${meeting.title || ''} ${(meeting.attendees || []).join(' ')}`
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .split(/\s+/)
    .filter((word) => word.length > 2 && !STOP_WORDS.has(word))

  return [...new Set(words)].slice(0, 12)
}

/**
 * Walk the usual places, cheaply. Only names and stat data here — reading four
 * thousand files to rank three of them is the wrong order of work.
 */
export function scanDocuments(roots, { now = new Date(), maxFiles = MAX_SCAN_FILES } = {}) {
  const found = []
  const cutoff = new Date(now).getTime() - MAX_FILE_AGE_MS

  for (const root of roots) {
    if (!fs.existsSync(root)) continue
    const queue = [{ dir: root, depth: 0 }]

    while (queue.length && found.length < maxFiles) {
      const { dir, depth } = queue.shift()
      let entries
      try {
        entries = fs.readdirSync(dir, { withFileTypes: true })
      } catch {
        continue
      }

      for (const entry of entries) {
        if (entry.name.startsWith('.') || entry.name === 'node_modules') continue
        const full = path.join(dir, entry.name)

        if (entry.isDirectory()) {
          if (depth < MAX_SCAN_DEPTH) queue.push({ dir: full, depth: depth + 1 })
          continue
        }

        const extension = path.extname(entry.name).toLowerCase()
        if (!READABLE_EXTENSIONS.has(extension) && !REFERENCE_EXTENSIONS.has(extension)) {
          continue
        }

        let stats
        try {
          stats = fs.statSync(full)
        } catch {
          continue
        }
        if (stats.mtimeMs < cutoff) continue

        found.push({
          path: full,
          name: entry.name,
          bytes: stats.size,
          modifiedAt: new Date(stats.mtimeMs).toISOString(),
          readable: READABLE_EXTENSIONS.has(extension),
        })
      }
    }
  }

  return found
}

/**
 * Drop the meeting words that match everything the owner owns.
 *
 * The invite names the organiser, and the organiser is usually the owner — so
 * "evan" and "liu" were scoring every file on the machine and dragging in an
 * unrelated PDF because it had the owner's own name in the path. A term that
 * appears in most candidates carries no information about which document is
 * the right one, whoever it names.
 *
 * Kept only when there is a corpus worth measuring against; below that the
 * frequency is noise and the owner is better served by the raw terms.
 */
export function discriminatingTerms(terms, candidates, { maxShare = 0.4, minCandidates = 8 } = {}) {
  if (candidates.length < minCandidates) return terms

  const discriminating = terms.filter((term) => {
    const hits = candidates.filter((candidate) =>
      candidate.path.toLowerCase().includes(term),
    ).length
    return hits / candidates.length <= maxShare
  })

  /* Never return nothing: an over-eager filter that empties the list would find
   * no documents at all, which is worse than finding slightly wrong ones. */
  return discriminating.length ? discriminating : terms
}

/**
 * Filename match dominates; the containing folder is corroboration, not proof.
 *
 * Scoring the whole path equally is how "grocery-list.md" ends up in the prep
 * folder for a pendant meeting — it lives under ~/Documents/Pendant, so the
 * path matched and the file did not. A folder says what a pile is about; a
 * filename was chosen by someone who meant this document. So a name match
 * admits a document on its own, and folder matches only admit one when at least
 * two of the meeting's words agree.
 */
export function rankDocuments(candidates, terms) {
  if (!terms.length) return []
  const now = Date.now()

  return candidates
    .map((candidate) => {
      const name = candidate.name.toLowerCase()
      const directory = path.dirname(candidate.path).toLowerCase()
      const inName = terms.filter((term) => name.includes(term))
      const inDirectory = terms.filter((term) => !inName.includes(term) && directory.includes(term))
      const ageDays = Math.max(0, (now - Date.parse(candidate.modifiedAt)) / 86_400_000)

      return {
        ...candidate,
        matchedTerms: [...inName, ...inDirectory],
        matchedInName: inName,
        score: inName.length * 10 + inDirectory.length * 3 + Math.max(0, 5 - ageDays / 14),
      }
    })
    .filter((candidate) => candidate.matchedInName.length > 0 || candidate.matchedTerms.length >= 2)
    .sort((left, right) => right.score - left.score)
}

/** Quote the sentences that already state a decision or an action. */
export function extractFromFile(filePath, { read = readTextFile } = {}) {
  const text = read(filePath)
  if (!text) return { decisions: [], actions: [] }
  return extractFromText(text, path.basename(filePath))
}

/*
 * One splitter, used by every extraction pass, so "a sentence" means the same
 * thing to decisions, actions and questions. Two splitters would eventually
 * disagree about a bullet that runs onto a second line, and the symptom would
 * be a quote that appears in one section and not the other.
 */
function sentencesIn(text, { min = 12, max = 320 } = {}) {
  return String(text ?? '')
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[\s>*#-]+/, '').trim())
    .filter((line) => line.length > min && line.length < max)
}

export function extractFromText(text, sourceName = '') {
  const sentences = sentencesIn(text)

  const decisions = []
  const actions = []

  for (const sentence of sentences) {
    if (DECISION_MARKERS.test(sentence)) {
      decisions.push({ text: sentence, source: sourceName })
      continue
    }
    /* An unchecked markdown box is an action item that says so structurally. */
    if (
      ACTION_MARKERS.test(sentence) ||
      /^\[ \]/.test(sentence) ||
      (LEADING_COMMITMENT.test(sentence) && sentence.length <= 140)
    ) {
      actions.push({ text: sentence, source: sourceName })
    }
  }

  return { decisions: decisions.slice(0, 12), actions: actions.slice(0, 12) }
}

/**
 * The questions this document leaves open.
 *
 * Two structural signals, no topical ones. A sentence that says it is open, and
 * a bullet sitting under a heading that says the bullets are open. Notably NOT
 * "any sentence ending in a question mark": a transcript is made of question
 * marks, and the same lesson that produced LEADING_COMMITMENT above applies —
 * the punctuation is not the signal, the label is.
 *
 * Question marks are, however, the reason the length floor is lower than
 * extractFromText's. "Do we ship?" is eleven characters and is the entire
 * question; the twelve-character floor that keeps chatter out of the decisions
 * list would drop it.
 */
export function extractOpenQuestions(text, sourceName = '') {
  const found = []

  /* Pass one: bullets under a questions heading. */
  let inSection = false
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trim()
    if (!line) continue
    if (HEADING_LINE.test(line) || /:\s*$/.test(line)) {
      inSection = isQuestionHeading(line)
      continue
    }
    if (!inSection) continue
    if (!BULLET_LINE.test(line)) {
      /* Prose after the list closes the section. A questions heading followed
       * by three bullets and then a paragraph has three questions, not three
       * questions and an essay. */
      inSection = false
      continue
    }
    const bullet = line.replace(BULLET_LINE, '').trim()
    if (bullet.length > 3 && bullet.length < 320) {
      found.push({ text: bullet, source: sourceName, origin: 'heading' })
    }
  }

  /* Pass two: sentences that label themselves. */
  for (const sentence of sentencesIn(text, { min: 8 })) {
    if (QUESTION_MARKERS.test(sentence)) {
      found.push({ text: sentence, source: sourceName, origin: 'marker' })
    }
  }

  return dedupe(found).slice(0, 12)
}

/**
 * Everything one document contributes to a meeting brief.
 *
 * extractFromText's contract is deliberately left alone — meetingFollowup.js
 * imports it and expects exactly two buckets — so the question split happens
 * here, on top of it, rather than inside it. Decisions lose the sentences that
 * were only ever questions wearing a decision marker.
 */
export function extractMeetingMaterial(text, sourceName = '') {
  const base = extractFromText(text, sourceName)
  const questions = extractOpenQuestions(text, sourceName)
  const asked = new Set(questions.map((item) => normalizeQuote(item.text)))

  return {
    decisions: base.decisions.filter((item) => !asked.has(normalizeQuote(item.text))),
    actions: base.actions,
    questions,
  }
}

export function extractMeetingMaterialFromFile(filePath, { read = readTextFile } = {}) {
  const text = read(filePath)
  if (!text) return { decisions: [], actions: [], questions: [] }
  return extractMeetingMaterial(text, path.basename(filePath))
}

function readTextFile(filePath) {
  const extension = path.extname(filePath).toLowerCase()
  if (!READABLE_EXTENSIONS.has(extension)) return ''
  try {
    const handle = fs.openSync(filePath, 'r')
    try {
      const stats = fs.fstatSync(handle)
      const buffer = Buffer.alloc(Math.min(stats.size, MAX_READ_BYTES))
      fs.readSync(handle, buffer, 0, buffer.length, 0)
      return buffer.toString('utf8')
    } finally {
      fs.closeSync(handle)
    }
  } catch {
    return ''
  }
}

export function matchMail(messages, terms) {
  if (!terms.length) return []
  return (messages || [])
    .map((message) => {
      const haystack = `${message.subject} ${message.sender}`.toLowerCase()
      const matched = terms.filter((term) => haystack.includes(term))
      return { ...message, matchedTerms: matched }
    })
    .filter((message) => message.matchedTerms.length > 0)
    .sort((left, right) => right.matchedTerms.length - left.matchedTerms.length)
    .slice(0, 5)
}

/*
 * Copies, not links or moves. The owner opens this folder and stops thinking
 * about it; a symlink breaks when Downloads is tidied and a move steals a file
 * out from under whatever else was using it.
 */
function collectIntoFolder(meeting, documents, { now }) {
  const slug =
    String(meeting.title || 'meeting')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'meeting'
  const folder = path.join(
    workspacePath,
    'meeting-prep',
    `${new Date(now).toISOString().slice(0, 10)}-${slug}`,
  )
  fs.mkdirSync(folder, { recursive: true })

  for (const document of documents) {
    try {
      fs.copyFileSync(document.path, path.join(folder, document.name))
    } catch {
      /* One unreadable file must not cost the owner the other two. */
    }
  }

  return folder
}

/**
 * The written brief: four sections in the order a person needs them.
 *
 * Who, then what has already been said, then what is unsettled, then where the
 * paper is. The blind-spot section is last and is never omitted — an empty
 * "open questions" heading with nothing underneath it says "there are none",
 * and only the closing section can say "or I could not see them".
 */
export function formatBrief({
  meeting,
  documents = [],
  attendees = [],
  threads = [],
  decisions = [],
  actions = [],
  questions = [],
  blindSpots = [],
}) {
  const lines = [
    `# ${meeting.title}`,
    '',
    `${new Date(meeting.start).toLocaleString()} — ${new Date(meeting.end).toLocaleTimeString()}`,
    meeting.location ? `Location: ${meeting.location}` : null,
    '',
    '## Who is in the room',
  ]

  if (!attendees.length) {
    lines.push(
      '_The invite lists no attendees. That means it is on your calendar without anyone else on it, not that you will be alone._',
    )
  }
  for (const person of attendees) {
    const known = person.messageCount
      ? `${person.messageCount} message${person.messageCount === 1 ? '' : 's'} in your mail, last on ${person.lastHeardFrom}`
      : 'nothing in your mail — I only know the name on the invite'
    lines.push(
      `- **${person.name}**${person.email ? ` <${person.email}>` : ''}${person.isOwner ? ' _(you)_' : ''} — ${known}` +
        (person.awaitingYourReply ? '\n  - **They wrote last and you have not replied.**' : ''),
    )
  }

  lines.push(
    '',
    '## Agenda from the invite',
    meeting.notes?.trim() || '_The invite carries no agenda._',
    '',
    '## The conversation so far',
  )

  if (!threads.length) {
    lines.push('_No mail thread matched this meeting._')
  }
  for (const thread of threads) {
    lines.push(
      `- **${thread.subject}** — ${summarizeThread(thread)}`,
      `  - ${thread.matchedPeople.length ? `matched on ${thread.matchedPeople.join(', ')}` : `matched on ${thread.matchedTerms.join(', ')}`}`,
    )
  }

  lines.push(
    '',
    '## Open questions',
    questions.length
      ? questions.map((item) => `- ${item.text}  \n  _${item.source}_`).join('\n')
      : '_Nothing reads as an unsettled question._',
    '',
    '## Decisions already made',
    decisions.length
      ? decisions.map((item) => `- ${item.text}  \n  _${item.source}_`).join('\n')
      : '_Nothing in the local documents records a decision._',
    '',
    '## Prior action items',
    actions.length
      ? actions.map((item) => `- ${item.text}  \n  _${item.source}_`).join('\n')
      : '_No prior action items found._',
    '',
    '## Documents',
    documents.length
      ? documents
          .map((doc) => `- ${doc.name} — matched ${doc.matchedTerms.join(', ')}\n  ${doc.path}`)
          .join('\n')
      : '_No local document matched this meeting._',
    '',
    '## What this brief could not see',
  )
  for (const gap of blindSpots) lines.push(`- ${gap}`)

  lines.push(
    '',
    '_Assembled from your calendar, your mailbox and your files. Nothing was sent, replied to, or changed._',
  )

  return `${lines.filter((line) => line !== null).join('\n')}\n`
}

function speakableSummary({ meeting, decisions, actions, questions = [], threads = [], documents, now }) {
  const minutesAway = Math.round((Date.parse(meeting.start) - new Date(now).getTime()) / 60_000)
  const when =
    minutesAway <= 0
      ? 'now'
      : minutesAway < 90
        ? `in ${minutesAway} minutes`
        : `at ${new Date(meeting.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`

  const parts = [`${meeting.title} ${when}.`]

  /*
   * The unanswered thread is said first when there is one. Everything else in
   * this brief is something the owner can read later; a person waiting on a
   * reply is the only item that gets worse while they sit in the meeting not
   * knowing about it.
   */
  const owed = threads.filter((thread) => thread.awaitingOwner === true)
  if (owed.length) {
    const who = owed[0].lastFrom?.name || owed[0].lastFrom?.email || 'someone'
    parts.push(
      owed.length === 1
        ? `${who} is waiting on your reply about ${owed[0].subject}.`
        : `${owed.length} threads are waiting on your reply, the oldest from ${who}.`,
    )
  }

  if (questions.length) {
    parts.push(`${questions.length} open question${questions.length === 1 ? '' : 's'}.`)
  }
  if (decisions.length) parts.push(`${decisions.length} decision${decisions.length === 1 ? '' : 's'} already on record.`)
  if (actions.length) parts.push(`${actions.length} prior action item${actions.length === 1 ? '' : 's'}.`)
  parts.push(
    documents.length
      ? `I put ${documents.length} document${documents.length === 1 ? '' : 's'} in a folder for you.`
      : 'I could not find a related local document.',
  )
  return parts.join(' ')
}

/* One spelling of a quote, so the same sentence found twice is one row. */
function normalizeQuote(text) {
  return String(text ?? '').toLowerCase().replace(/\s+/g, ' ').trim()
}

function dedupe(items) {
  const seen = new Set()
  return items.filter((item) => {
    const key = normalizeQuote(item.text)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/* --------------------------------------------------------------- the command */

/*
 * Spoken phrasings, matched deterministically for the reason briefing.js and
 * mailTriage.js both state: a routine that fires at 5am and needs a model round
 * trip is a routine that silently does nothing during an API outage, and "have
 * it ready before I wake up" is a promise the owner is relying on.
 *
 * Order matters below. "Get me ready for my next meeting" also matches the
 * named-meeting pattern, capturing the name "next meeting" — so the specific
 * phrasings are tested first and the open-ended capture last.
 */
const OVERNIGHT_PATTERNS = [
  /\bwhile\s+i\s+(?:sleep|am\s+asleep)\b/i,
  /\b(?:overnight|tonight|by\s+(?:the\s+)?morning|before\s+i\s+wake)\b/i,
  /\btomorrow'?s?\s+(?:brief|briefing|prep|meetings?|schedule)\b/i,
]

const NEXT_PATTERNS = [
  /\bget\s+me\s+ready\s+for\s+(?:my|the)?\s*next\s+(?:meeting|call)\b/i,
  /\b(?:prep|prepare|brief)\s+(?:me\s+)?for\s+(?:my|the)?\s*next\s+(?:meeting|call)\b/i,
  /\bmeeting\s+prep\b/i,
  /\bprepare\s+me\s+for\s+my\s+meeting\b/i,
  /\bwhat\s+do\s+i\s+need\s+(?:to\s+know\s+)?(?:before|for)\s+(?:my|the)?\s*next\s+(?:meeting|call)\b/i,
]

const NAMED_PATTERN =
  /\b(?:get\s+me\s+ready|prep(?:are)?\s+me|prep(?:are)?|brief\s+me)\s+for\s+(?:my|the|our|this)?\s*(.{2,80})$/i

export function matchMeetingPrepCommand(command) {
  const text = String(command || '').trim()
  if (!text) return null

  const meetingish = /\b(?:meeting|call|brief|prep|schedule|interview|sync|review|1:1|one[- ]on[- ]one)\b/i
  if (OVERNIGHT_PATTERNS.some((pattern) => pattern.test(text)) && meetingish.test(text)) {
    return { kind: 'overnight' }
  }
  if (NEXT_PATTERNS.some((pattern) => pattern.test(text))) return { kind: 'next' }

  const named = text.match(NAMED_PATTERN)
  if (named) {
    const name = cleanMeetingName(named[1])
    if (name) return { kind: 'named', name }
  }
  return null
}

/* Strip the words that name the request rather than the meeting, from both
 * ends: "the pendant firmware review please" is "pendant firmware review". */
export function cleanMeetingName(raw) {
  return String(raw ?? '')
    .replace(/[?.!]+\s*$/, '')
    .replace(/\b(?:please|thanks|thank\s+you)\s*$/i, '')
    .replace(/^\s*(?:my|the|our|this|a|an)\s+/i, '')
    .trim()
}

/* ------------------------------------------------------------------ routes */

/**
 * Wire this capability onto an existing Express app.
 *
 * A registration function rather than route definitions in server.js, for
 * briefingTriage.js's reason: several agents are editing that file, and a
 * feature that arrives as one import and one call does not produce a merge
 * conflict. `deps` is forwarded so the routes are testable against fake readers.
 *
 * The composing routes are POST even though they look like lookups. They read
 * the owner's mailbox, walk their disk and copy files into a folder; a GET that
 * does that is a GET a browser prefetch can fire.
 */
export function registerMeetingPrepRoutes(app, deps = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerMeetingPrepRoutes needs an Express-like app.')
  }

  app.post('/meeting-prep/brief', async (request, response) => {
    try {
      const body = request.body || {}
      const options = {
        maxDocuments: Number(body.maxDocuments) || undefined,
        collect: body.collect !== false,
        threads: body.threads !== false,
      }
      response.json(
        body.name
          ? await prepareForNamedMeeting({ ...options, name: String(body.name) }, deps)
          : await prepareForNextMeeting(
              { ...options, withinHours: Number(body.withinHours) || undefined },
              deps,
            ),
      )
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message })
    }
  })

  /* Overnight: the same assembly, for every meeting on tomorrow's calendar.
   * This is the endpoint a scheduled routine dispatches — see
   * meetingPrepOvernight.js for why there is no clock in this codebase's
   * meeting-prep path. */
  app.post('/meeting-prep/overnight', async (request, response) => {
    try {
      const { runOvernightMeetingPrep } = await import('./meetingPrepOvernight.js')
      const body = request.body || {}
      response.json(
        await runOvernightMeetingPrep(
          {
            maxMeetings: Number(body.maxMeetings) || undefined,
            collect: body.collect !== false,
            audio: body.audio !== false,
            store: body.store !== false,
          },
          deps,
        ),
      )
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message })
    }
  })

  /* Reading back is a GET: nothing here touches Mail or the disk beyond the
   * shelf metadata. */
  app.get('/meeting-prep/queue', async (_request, response) => {
    try {
      const { listMeetingPrepQueue, queueSpoken } = await import('./meetingPrepQueue.js')
      const rows = listMeetingPrepQueue()
      response.json({
        ok: true,
        waiting: rows.filter((row) => !row.played).length,
        spoken: queueSpoken(rows.filter((row) => !row.played)),
        items: rows,
      })
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message })
    }
  })

  /* The overnight schedule itself, created through local-agent/routines.js —
   * this feature owns no timer. */
  app.get('/meeting-prep/routine', async (_request, response) => {
    try {
      const { overnightRoutine } = await import('./meetingPrepOvernight.js')
      response.json({ ok: true, routine: overnightRoutine() })
    } catch (error) {
      response.status(500).json({ ok: false, error: error.message })
    }
  })

  app.post('/meeting-prep/routine', async (request, response) => {
    try {
      const { ensureOvernightRoutine } = await import('./meetingPrepOvernight.js')
      response.json({
        ok: true,
        ...ensureOvernightRoutine({ at: request.body?.at }),
      })
    } catch (error) {
      response.status(400).json({ ok: false, error: error.message })
    }
  })

  return [
    'POST /meeting-prep/brief',
    'POST /meeting-prep/overnight',
    'GET /meeting-prep/queue',
    'GET /meeting-prep/routine',
    'POST /meeting-prep/routine',
  ]
}

export const MEETING_PREP_ROOTS = SEARCH_ROOTS

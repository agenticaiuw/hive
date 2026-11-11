import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'

import { listEvents } from './appleData.js'
import { assertNeverSends } from './briefing.js'
import { workspacePath } from './config.js'
import { openArgs } from './focusPolicy.js'
import { readUnreadEnvelopes } from './mailTriage.js'
import {
  MEETING_PREP_ROOTS,
  discriminatingTerms,
  extractFromFile,
  looksLikeMeeting,
  matchMail,
  meetingTerms,
  rankDocuments,
  scanDocuments,
} from './meetingPrep.js'

const execFileAsync = promisify(execFile)

/*
 * The other half of a meeting.
 *
 * meetingPrep.js answers "what do I need before this starts". This answers the
 * question ten minutes after it ends, which is a different one: the owner is
 * holding a page of notes and about to lose the twenty minutes it would take to
 * turn them into anything. So the follow-up is a WORKSPACE, not a summary — the
 * notes open on screen, a draft summary file sitting next to them with the
 * attendees and the action items already extracted, and the unread mail that
 * belongs to this meeting listed underneath.
 *
 * Everything it writes is a draft and everything it says is a quote. The
 * extraction is meetingPrep's, unchanged and imported rather than copied: a
 * second regex table that decides what counts as an action item would drift
 * from the first one within a week, and the two would disagree about the same
 * meeting.
 *
 * It never sends. A follow-up is the most tempting place in this codebase to
 * add "…and email the summary to the attendees", and the owner asked for the
 * opposite, so the sink list is asserted here the same way a briefing's is.
 */

/* Composed, written, opened. Nothing that transmits. */
const FOLLOWUP_SINKS = Object.freeze(['file', 'speech'])

const DEFAULT_LOOKBACK_HOURS = 6
const DEFAULT_MAX_DOCUMENTS = 4
/* The unread-mail read is bounded the same way triage is: this mailbox holds
 * thousands of unread, and "relevant unread emails" is a filter over a recent
 * window, not an excuse to walk all of it. */
const MAIL_SCAN_LIMIT = 200
const MAIL_SINCE_HOURS = 72

const followupDirectory = path.join(workspacePath, 'meeting-followup')

/*
 * Folders inside the workspace that hold what the AGENT wrote, not what the
 * owner did.
 *
 * The first real run picked its notes out of meeting-prep/, which copies
 * matching documents into a per-meeting folder — and a copy carries the copy's
 * mtime, so every one of them looks like a file that was touched during the
 * meeting. The follow-up duly opened a transcript of a DIFFERENT meeting and
 * quoted it, while the owner's actual copy of the same file sat in
 * ~/Documents/Zoom and was listed below it as "other related".
 *
 * briefing.js learned this in its own shape (isBriefingNote, so the 5pm wrap-up
 * stops assigning the owner homework about its own output). Same rule: nothing
 * the agent produced is evidence of anything.
 */
const AGENT_OUTPUT_FOLDERS = [
  'meeting-prep',
  'meeting-followup',
  'mail-triage',
  'briefings',
  'Briefings',
  'form-fills',
  'pipeline-audio',
].map((name) => `${path.join(workspacePath, name)}${path.sep}`)

export function withoutAgentOutput(candidates) {
  return (candidates || []).filter(
    (candidate) => !AGENT_OUTPUT_FOLDERS.some((folder) => candidate.path.startsWith(folder)),
  )
}

/**
 * Spoken phrasings that mean "the meeting is over, set me up".
 *
 * Deliberately narrower than the briefing matcher: "follow up" on its own is
 * something the owner says about a person or an email at least as often as
 * about a meeting, and a deterministic path that claims the wrong request runs
 * the wrong action with no model in between to catch it.
 */
const FOLLOWUP_COMMAND_PATTERNS = [
  /\b(?:after|following)\s+(?:my|the|this|each|every)\s+meeting\b/i,
  /\b(?:meeting|post[- ]meeting)\s+follow[- ]?up\b/i,
  /\bfollow[- ]?up\s+(?:workspace|for\s+(?:my|the|that)\s+(?:last\s+)?meeting)\b/i,
  /\b(?:wrap|write)\s+up\s+(?:my|the|that)\s+(?:last\s+)?meeting\b/i,
  /\bmeeting\s+(?:summary|notes)\s+(?:draft|workspace)\b/i,
]

export function matchMeetingFollowupCommand(command) {
  const text = String(command || '').trim()
  if (!text) return null
  return FOLLOWUP_COMMAND_PATTERNS.some((pattern) => pattern.test(text)) ? {} : null
}

/**
 * The meeting that just finished, or null.
 *
 * "Just finished" has to mean finished — a meeting the owner is still sitting
 * in does not want a summary, it wants to be left alone — so the window is
 * closed at `now` and the latest ending one wins.
 */
export function mostRecentlyEnded(events, { now = new Date() } = {}) {
  const nowMs = new Date(now).getTime()
  return (
    (events || [])
      .filter((event) => !event.allDay)
      .filter(looksLikeMeeting)
      .filter((event) => Date.parse(event.end) <= nowMs)
      .sort((left, right) => Date.parse(right.end) - Date.parse(left.end))[0] || null
  )
}

/**
 * Which of the matched documents is "the meeting notes".
 *
 * A document that was touched around the time the meeting happened is the one
 * somebody typed into during it. That beats any amount of filename similarity:
 * a file called "kickoff-agenda.md" from three weeks ago scores well on terms
 * and is not what the owner wants opened.
 *
 * The window opens BEFORE the calendar start. On the first real run the right
 * file — Zoom's saved chat from "2026-08-06 21.44.26 Summer Interview…" — was
 * written at 21:46 for a meeting the calendar says began at 22:00, so a window
 * that opened at the nominal start missed it and the fallback opened a
 * transcript of a different meeting from four days earlier. People join early
 * and clients stamp the file when the session starts, not when the invite says.
 *
 * Inside the window the LATEST file wins rather than the best-named one: once
 * we know a file was written during the meeting, when it was written is a
 * stronger claim than what it is called.
 */
export function pickNotes(documents, meeting, { leadMinutes = 30, graceMinutes = 60 } = {}) {
  const startMs = Date.parse(meeting.start) - leadMinutes * 60_000
  const endMs = Date.parse(meeting.end) + graceMinutes * 60_000
  const readable = documents.filter((document) => document.readable)

  const touchedDuring = readable
    .filter((document) => {
      const modified = Date.parse(document.modifiedAt)
      return Number.isFinite(modified) && modified >= startMs && modified <= endMs
    })
    .sort((left, right) => Date.parse(right.modifiedAt) - Date.parse(left.modifiedAt))

  return touchedDuring[0] || readable[0] || null
}

/**
 * Build the workspace: folder, draft summary, matched unread mail, and the
 * notes brought to the front.
 *
 * Readers and the opener are injectable because the calendar, the mailbox and
 * the owner's screen are the three things a test cannot have; the shaping can.
 */
export async function prepareMeetingFollowup(
  {
    now = new Date(),
    lookbackHours = DEFAULT_LOOKBACK_HOURS,
    maxDocuments = DEFAULT_MAX_DOCUMENTS,
    roots = MEETING_PREP_ROOTS,
    open = true,
    sinks = FOLLOWUP_SINKS,
  } = {},
  {
    readEvents = listEvents,
    readUnread = readUnreadEnvelopes,
    openTarget = defaultOpen,
  } = {},
) {
  assertNeverSends(sinks)

  const events = await readEvents({
    from: new Date(new Date(now).getTime() - Math.max(1, lookbackHours) * 3_600_000),
    to: now,
  })

  const meeting = mostRecentlyEnded(events, { now })
  if (!meeting) {
    return {
      ok: true,
      meeting: null,
      spoken: `No meeting ended in the last ${lookbackHours} hours.`,
      sent: false,
    }
  }

  const candidates = withoutAgentOutput(scanDocuments(roots, { now }))
  const terms = discriminatingTerms(meetingTerms(meeting), candidates)
  const documents = rankDocuments(candidates, terms).slice(0, Math.max(1, maxDocuments))
  const notes = pickNotes(documents, meeting)

  const extracted = notes ? extractFromFile(notes.path) : { decisions: [], actions: [] }

  let mail = []
  let mailError = null
  try {
    const unread = await readUnread({
      sinceHours: MAIL_SINCE_HOURS,
      limit: MAIL_SCAN_LIMIT,
      now,
    })
    mail = matchMail(unread, terms)
  } catch (error) {
    /* Mail being unreachable must not cost the owner the workspace. */
    mailError = String(error?.message || error).slice(0, 200)
  }

  const folder = createWorkspace(meeting, { now })
  const summary = formatSummary({
    meeting,
    notes,
    documents,
    decisions: extracted.decisions,
    actions: extracted.actions,
    mail,
    mailError,
    now,
  })
  const summaryPath = path.join(folder, 'SUMMARY-DRAFT.md')
  fs.writeFileSync(summaryPath, summary, 'utf8')

  /*
   * Open the notes AND the draft: the owner asked for the notes, but a draft
   * they have to go looking for is a draft they will not edit, and the whole
   * value of this running unattended is that both are already on screen.
   */
  const opened = []
  if (open) {
    for (const target of [notes?.path, summaryPath].filter(Boolean)) {
      try {
        await openTarget(target)
        opened.push(target)
      } catch {
        /* A file that will not open is worth reporting, not worth failing on. */
      }
    }
  }

  return {
    ok: true,
    meeting: {
      title: meeting.title,
      start: meeting.start,
      end: meeting.end,
      location: meeting.location,
      attendees: meeting.attendees || [],
    },
    terms,
    notes: notes ? { path: notes.path, name: notes.name, modifiedAt: notes.modifiedAt } : null,
    documents: documents.map((document) => ({
      path: document.path,
      name: document.name,
      modifiedAt: document.modifiedAt,
      matchedTerms: document.matchedTerms,
      score: document.score,
    })),
    decisions: extracted.decisions,
    actions: extracted.actions,
    mail,
    mailError,
    folder,
    summaryPath,
    summary,
    opened,
    /* Stated in the payload, not only in the prose: a caller reading JSON
     * should not have to infer that nothing left the Mac. */
    sent: false,
    sinks: [...sinks],
    spoken: speakableSummary({ meeting, notes, actions: extracted.actions, mail, opened }),
  }
}

function createWorkspace(meeting, { now }) {
  const folder = path.join(
    followupDirectory,
    `${new Date(meeting.end || now).toISOString().slice(0, 10)}-${slug(meeting.title)}`,
  )
  fs.mkdirSync(folder, { recursive: true })
  return folder
}

/**
 * The draft summary.
 *
 * Attendees and times are facts off the invite. Everything under "action items"
 * and "decisions" is a QUOTE from the notes with its source named — the same
 * rule meetingPrep works to, and for the same reason: a paraphrased commitment
 * that drops a name or a date is indistinguishable from a real one, and this
 * file is going to be read as if the owner wrote it.
 */
export function formatSummary({
  meeting,
  notes,
  documents = [],
  decisions = [],
  actions = [],
  mail = [],
  mailError = null,
  now = new Date(),
}) {
  const attendees = meeting.attendees || []
  const lines = [
    `# ${meeting.title} — summary (DRAFT)`,
    '',
    `_Drafted by the pendant agent ${new Date(now).toLocaleString()}. Nothing here has been sent to anyone._`,
    '',
    `**When:** ${new Date(meeting.start).toLocaleString()} — ${new Date(meeting.end).toLocaleTimeString()}`,
    meeting.location ? `**Where:** ${meeting.location}` : null,
    `**Attendees:** ${attendees.length ? attendees.join(', ') : '_the invite listed nobody_'}`,
    notes ? `**Notes read:** ${notes.path}` : '**Notes read:** _no local file looked like notes for this meeting_',
    '',
    '## Action items',
    actions.length
      ? actions.map((item) => `- [ ] ${item.text}  \n  _${item.source}_`).join('\n')
      : '_Nothing in the notes is written as an action item. Add them here._',
    '',
    '## Decisions',
    decisions.length
      ? decisions.map((item) => `- ${item.text}  \n  _${item.source}_`).join('\n')
      : '_Nothing in the notes reads as a decision._',
    '',
    '## Summary',
    '_Yours to write. The quotes above are what the notes already say._',
    '',
    '## Unread mail about this',
    mail.length
      ? mail
          .map(
            (message) =>
              `- **${message.subject || '(no subject)'}** — ${message.sender}  \n  _${message.receivedAt} · matched ${message.matchedTerms.join(', ')}_`,
          )
          .join('\n')
      : mailError
        ? `_Mail could not be read: ${mailError}_`
        : '_No unread mail matches this meeting._',
  ]

  if (documents.length > 1) {
    lines.push('', '## Other related documents')
    for (const document of documents.filter((entry) => entry.path !== notes?.path)) {
      lines.push(`- ${document.name} — matched ${document.matchedTerms.join(', ')}\n  ${document.path}`)
    }
  }

  return `${lines.filter((line) => line !== null).join('\n')}\n`
}

function speakableSummary({ meeting, notes, actions, mail, opened }) {
  const parts = [`${meeting.title} is done.`]
  parts.push(
    actions.length
      ? `I pulled ${actions.length} action item${actions.length === 1 ? '' : 's'} out of your notes into a draft summary.`
      : 'I started a draft summary; your notes had no action items written as such.',
  )
  if (mail.length) {
    parts.push(`${mail.length} unread email${mail.length === 1 ? '' : 's'} about it.`)
  }
  if (opened.length) {
    parts.push(notes ? 'Your notes and the draft are open.' : 'The draft is open.')
  }
  parts.push('Nothing was sent.')
  return parts.join(' ')
}

/* Honours the focus policy: a follow-up fires right as a meeting ends, which is
 * exactly when the owner may still be talking to someone. */
async function defaultOpen(target) {
  await execFileAsync('open', await openArgs([target]))
}

function slug(value) {
  return (
    String(value || 'meeting')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 60) || 'meeting'
  )
}

export const MEETING_FOLLOWUP_SINKS = FOLLOWUP_SINKS
export function meetingFollowupLocation() {
  return { folder: followupDirectory }
}

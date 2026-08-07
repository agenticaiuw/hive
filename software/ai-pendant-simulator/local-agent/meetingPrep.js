import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { listEvents, listRecentMail } from './appleData.js'
import { workspacePath } from './config.js'

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

const ACTION_MARKERS =
  /\b(action item|next step|follow[- ]up|i(?:'| a)?ll |we(?:'| wi)?ll |todo|to-do|assigned to|owner:|due (?:by|on)|by (?:monday|tuesday|wednesday|thursday|friday|next week))\b/i

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'with', 'from', 'that', 'this', 'meeting', 'call', 'sync',
  'weekly', 'monthly', 'invite', 'zoom', 'google', 'between', 'about', 'into',
])

/**
 * Everything worth having open before the meeting starts.
 *
 * Readers are injectable because the calendar and the mailbox are the two parts
 * that cannot be reproduced in a test; the scoring and extraction can.
 */
export async function prepareForNextMeeting(
  {
    now = new Date(),
    withinHours = 24,
    maxDocuments = 3,
    roots = SEARCH_ROOTS,
    collect = true,
  } = {},
  { readEvents = listEvents, readMail = listRecentMail } = {},
) {
  const events = await readEvents({
    from: now,
    to: new Date(new Date(now).getTime() + withinHours * 60 * 60 * 1000),
  })

  const meeting = (events || [])
    .filter((event) => !event.allDay)
    .sort((left, right) => Date.parse(left.start) - Date.parse(right.start))[0]

  if (!meeting) {
    return {
      ok: true,
      meeting: null,
      spoken: `Nothing on your calendar in the next ${withinHours} hours.`,
    }
  }

  const terms = meetingTerms(meeting)
  const candidates = scanDocuments(roots, { now })
  const documents = rankDocuments(candidates, terms).slice(0, Math.max(1, maxDocuments))

  const extracted = documents.map((document) => ({
    ...document,
    ...extractFromFile(document.path),
  }))

  let mail = []
  try {
    mail = matchMail(await readMail({ limit: 60, unreadOnly: false }), terms)
  } catch (error) {
    /* Mail being unavailable must not cost the owner their documents. */
    mail = []
    documents.mailError = String(error?.message || error)
  }

  const decisions = dedupe(extracted.flatMap((document) => document.decisions))
  const actions = dedupe(extracted.flatMap((document) => document.actions))

  const folder = collect ? collectIntoFolder(meeting, extracted, { now }) : null
  const brief = formatBrief({ meeting, documents: extracted, decisions, actions, mail })
  if (folder) {
    fs.writeFileSync(path.join(folder, 'BRIEF.md'), brief, 'utf8')
  }

  return {
    ok: true,
    meeting: {
      title: meeting.title,
      start: meeting.start,
      end: meeting.end,
      location: meeting.location,
      attendees: meeting.attendees,
      hasAgendaInInvite: Boolean(meeting.notes?.trim()),
    },
    agenda: meeting.notes?.trim() || null,
    terms,
    documents: extracted.map(({ decisions: _d, actions: _a, ...rest }) => rest),
    decisions,
    actions,
    mail,
    folder,
    brief,
    spoken: speakableSummary({ meeting, decisions, actions, documents: extracted, now }),
  }
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

export function extractFromText(text, sourceName = '') {
  const sentences = String(text)
    .split(/\r?\n|(?<=[.!?])\s+/)
    .map((line) => line.replace(/^[\s>*#-]+/, '').trim())
    .filter((line) => line.length > 12 && line.length < 320)

  const decisions = []
  const actions = []

  for (const sentence of sentences) {
    if (DECISION_MARKERS.test(sentence)) {
      decisions.push({ text: sentence, source: sourceName })
      continue
    }
    /* An unchecked markdown box is an action item that says so structurally. */
    if (ACTION_MARKERS.test(sentence) || /^\[ \]/.test(sentence)) {
      actions.push({ text: sentence, source: sourceName })
    }
  }

  return { decisions: decisions.slice(0, 12), actions: actions.slice(0, 12) }
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

function formatBrief({ meeting, documents, decisions, actions, mail }) {
  const lines = [
    `# ${meeting.title}`,
    '',
    `${new Date(meeting.start).toLocaleString()} — ${new Date(meeting.end).toLocaleTimeString()}`,
    meeting.location ? `Location: ${meeting.location}` : null,
    meeting.attendees?.length ? `With: ${meeting.attendees.join(', ')}` : null,
    '',
    '## Agenda from the invite',
    meeting.notes?.trim() || '_The invite carries no agenda._',
    '',
    '## Open decisions',
    decisions.length
      ? decisions.map((item) => `- ${item.text}  \n  _${item.source}_`).join('\n')
      : '_Nothing in the local documents reads as an open decision._',
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
  ]

  if (mail?.length) {
    lines.push('', '## Related mail')
    for (const message of mail) {
      lines.push(`- ${message.subject} — ${message.sender} (${message.receivedAt})`)
    }
  }

  return `${lines.filter((line) => line !== null).join('\n')}\n`
}

function speakableSummary({ meeting, decisions, actions, documents, now }) {
  const minutesAway = Math.round((Date.parse(meeting.start) - new Date(now).getTime()) / 60_000)
  const when =
    minutesAway <= 0
      ? 'now'
      : minutesAway < 90
        ? `in ${minutesAway} minutes`
        : `at ${new Date(meeting.start).toLocaleTimeString([], { hour: 'numeric', minute: '2-digit' })}`

  const parts = [`${meeting.title} ${when}.`]
  if (decisions.length) parts.push(`${decisions.length} open decision${decisions.length === 1 ? '' : 's'} to settle.`)
  if (actions.length) parts.push(`${actions.length} prior action item${actions.length === 1 ? '' : 's'}.`)
  parts.push(
    documents.length
      ? `I put ${documents.length} document${documents.length === 1 ? '' : 's'} in a folder for you.`
      : 'I could not find a related local document.',
  )
  return parts.join(' ')
}

function dedupe(items) {
  const seen = new Set()
  return items.filter((item) => {
    const key = item.text.toLowerCase().replace(/\s+/g, ' ')
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

export const MEETING_PREP_ROOTS = SEARCH_ROOTS

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import { assertScriptNeverSends } from './mailTriage.js'

const execFileAsync = promisify(execFile)

/*
 * The thread history behind a meeting.
 *
 * meetingPrep.js already matched mail to a meeting, but only as a flat list of
 * envelopes: five subject lines, newest first, no idea which of them are the
 * same conversation and no idea whether the owner ever answered. Walking into a
 * meeting knowing "there are five emails about this" is barely better than
 * knowing nothing. What actually changes how the meeting goes is: this is one
 * conversation, it has run for nine days, Jorge wrote last on Tuesday, and you
 * have not replied.
 *
 * That last clause is the reason this module reads the SENT mailbox as well as
 * the inbox. An inbox-only read cannot distinguish "they are waiting on you"
 * from "you answered an hour later" — and those two facts want opposite
 * behaviour from the person walking into the room. Reading only the inbox and
 * reporting the first one would be a confident wrong answer, so when Sent
 * cannot be read this module returns `awaitingOwner: null` rather than `true`.
 * Unknown is a value here; it is never rounded down to "no".
 *
 * WHAT IT STILL CANNOT SEE, stated once here and repeated in the brief:
 *   - Recipients. Only the sender is read, so a thread's participants are the
 *     people who WROTE, not everyone who was copied. An attendee who has only
 *     ever been cc'd is invisible to this.
 *   - Bodies. Grouping and ordering are envelope facts; nothing here reads what
 *     anyone actually said.
 *   - Anything outside the scanned window, and anything filed out of INBOX.
 *     This is a bounded scan of recent mail, not a search of the archive.
 */

/* Unit separators, matching mailTriage.js. A subject line can contain a tab and
 * routinely contains a comma; the ASCII separators are the only delimiters that
 * a human-typed subject cannot forge. */
const FIELD_SEP = String.fromCharCode(31)
const RECORD_SEP = String.fromCharCode(30)

const DEFAULT_SCAN_PER_MAILBOX = 120
const MAX_SCAN_PER_MAILBOX = 400
const OSASCRIPT_TIMEOUT_MS = 90_000

/* Kept out of the thread objects: a brief shows the shape of a conversation,
 * and a thread carrying four hundred envelopes into a JSON response is a
 * response nobody reads twice. */
const MAX_MESSAGES_PER_THREAD = 25

/*
 * Reply and forward prefixes, in the languages Mail actually produces on this
 * Mac plus the ones a European correspondent's client adds. The trailing `+`
 * matters: "Re: Re: Fwd: agenda" is one conversation, and a single-strip
 * pattern leaves three different keys for it.
 */
const SUBJECT_PREFIX = /^\s*(?:(?:re|aw|fw|fwd|vs|sv|antw|tr)\s*(?:\[\d+\])?\s*:\s*)+/i

/* A mailing-list tag is part of the transport, not part of the subject:
 * "[pendant-dev] agenda" and "agenda" are the same thread to a human. Bounded
 * length so a subject that merely starts with a bracket survives intact. */
const LIST_TAG = /^\s*\[[^\]]{1,40}\]\s*/

/** The conversation two subject lines share, or don't. */
export function normalizeSubject(subject) {
  return String(subject ?? '')
    .replace(SUBJECT_PREFIX, '')
    .replace(LIST_TAG, '')
    .replace(/\s+/g, ' ')
    .trim()
    .toLowerCase()
}

/**
 * Split "Jorge Roji <jorge@example.com>" into the two things worth matching on.
 *
 * EventKit hands attendees back as either a display name or a `mailto:` URL
 * (see appleData.js listEvents), and Mail hands senders back as a display name
 * plus an angle-bracketed address. One parser for both, so an attendee and a
 * correspondent can be compared at all.
 */
export function parseAddress(raw) {
  const text = String(raw ?? '')
    .replace(/^mailto:/i, '')
    .trim()
  const angled = text.match(/<([^>]+)>/)
  const bare = text.match(/[^\s<>,;()"']+@[^\s<>,;()"']+/)
  const email = String(angled ? angled[1] : bare ? bare[0] : '')
    .trim()
    .toLowerCase()

  let name = angled ? text.slice(0, angled.index) : email ? '' : text
  name = name.replace(/^["']|["']$/g, '').trim()

  return {
    name: name || (email ? email.split('@')[0] : ''),
    email,
  }
}

/** The owner's own addresses, learned from what they have sent. */
export function ownerAddressesFrom(messages = []) {
  return [
    ...new Set(
      messages
        .filter((message) => message?.mailbox === 'sent')
        .map((message) => parseAddress(message.sender).email)
        .filter(Boolean),
    ),
  ]
}

/**
 * Group envelopes into conversations, oldest message first inside each.
 *
 * `sentReadable` is passed in rather than inferred from "did any sent message
 * turn up", because those are different facts. An owner who has sent nothing in
 * the scanned window produces zero sent rows, and so does a Mail account whose
 * Sent mailbox could not be opened — the first case can still answer "are they
 * waiting on you" and the second cannot.
 */
export function buildThreads(messages = [], { sentReadable = null } = {}) {
  const ownerAddresses = ownerAddressesFrom(messages)
  const ownerKnown = sentReadable === true
  const byKey = new Map()

  for (const message of messages.filter(Boolean)) {
    const key = normalizeSubject(message.subject)
    if (!key) continue
    if (!byKey.has(key)) byKey.set(key, [])
    byKey.get(key).push(message)
  }

  const threads = []
  for (const [key, group] of byKey) {
    const ordered = [...group].sort(
      (left, right) => sentAtMs(left) - sentAtMs(right),
    )
    const newest = ordered.at(-1)
    const oldest = ordered[0]

    const participants = rollUpParticipants(ordered, ownerAddresses)
    const lastFrom = parseAddress(newest.sender)
    const lastFromOwner =
      newest.mailbox === 'sent' ||
      (Boolean(lastFrom.email) && ownerAddresses.includes(lastFrom.email))

    threads.push({
      key,
      /* The newest message's subject, with its Re: intact — that is the string
       * the owner will recognise in their own mail client. */
      subject: newest.subject || oldest.subject || '',
      messageCount: ordered.length,
      firstAt: oldest.sentAt ?? null,
      lastAt: newest.sentAt ?? null,
      spanDays: spanInDays(oldest, newest),
      participants,
      lastFrom,
      lastFromOwner: ownerKnown ? lastFromOwner : null,
      ownerReplied: ownerKnown
        ? ordered.some((message) => message.mailbox === 'sent')
        : null,
      /* The whole point of reading Sent. Null means we could not tell, and the
       * brief says "could not tell" rather than picking the reassuring half. */
      awaitingOwner: ownerKnown ? !lastFromOwner : null,
      messages: ordered.slice(-MAX_MESSAGES_PER_THREAD).map(publicMessage),
    })
  }

  return threads.sort((left, right) => Date.parse(right.lastAt ?? 0) - Date.parse(left.lastAt ?? 0))
}

function publicMessage(message) {
  return {
    subject: message.subject ?? '',
    sender: message.sender ?? '',
    sentAt: message.sentAt ?? null,
    mailbox: message.mailbox ?? 'inbox',
    messageId: message.messageId ?? null,
    account: message.account ?? null,
  }
}

function rollUpParticipants(ordered, ownerAddresses) {
  const people = new Map()
  for (const message of ordered) {
    const { name, email } = parseAddress(message.sender)
    const identity = email || name.toLowerCase()
    if (!identity) continue
    if (!people.has(identity)) {
      people.set(identity, {
        name,
        email,
        isOwner: message.mailbox === 'sent' || ownerAddresses.includes(email),
        messageCount: 0,
        lastAt: null,
      })
    }
    const person = people.get(identity)
    person.messageCount += 1
    person.lastAt = message.sentAt ?? person.lastAt
    /* A display name is often empty on one message and present on the next
     * ("jorge@example.com" then "Jorge Roji <jorge@example.com>"). Keep the
     * better one rather than whichever arrived first. */
    if (name && name.length > person.name.length) person.name = name
  }
  return [...people.values()]
}

function sentAtMs(message) {
  const parsed = Date.parse(message?.sentAt ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function spanInDays(oldest, newest) {
  const from = sentAtMs(oldest)
  const to = sentAtMs(newest)
  if (!from || !to) return null
  return Math.max(0, Math.round((to - from) / 86_400_000))
}

/**
 * The threads that belong to this meeting.
 *
 * A participant match is worth more than a subject match, and on its own is
 * enough — mail from a person who will be in the room is relevant to the room
 * whatever it is called. A subject-term match on its own is not: meetingPrep's
 * document ranking learned this the expensive way, where a single shared word
 * pulled a grocery list into a firmware brief, and a subject line is shorter
 * and blunter than a filename. So one term is context, two terms are a claim.
 */
export function threadsForMeeting(
  threads = [],
  { attendees = [], terms = [], limit = 4, ownerAddresses = [] } = {},
) {
  const wanted = attendees
    .map((entry) => parseAddress(entry))
    .filter((person) => person.email || person.name)
    /* The owner is on their own invite. Matching on them would select every
     * thread they have ever been in, which is the same failure
     * discriminatingTerms() exists to prevent on the document side. */
    .filter((person) => !person.email || !ownerAddresses.includes(person.email))

  return threads
    .map((thread) => {
      const matchedPeople = wanted.filter((person) =>
        thread.participants.some((participant) => samePerson(person, participant)),
      )
      const matchedTerms = terms.filter((term) => thread.key.includes(String(term).toLowerCase()))

      return {
        ...thread,
        matchedPeople: matchedPeople.map((person) => person.name || person.email),
        matchedTerms,
        score: matchedPeople.length * 10 + matchedTerms.length * 3,
      }
    })
    .filter((thread) => thread.matchedPeople.length > 0 || thread.matchedTerms.length >= 2)
    .sort(
      (left, right) =>
        right.score - left.score ||
        Date.parse(right.lastAt ?? 0) - Date.parse(left.lastAt ?? 0),
    )
    .slice(0, Math.max(1, limit))
}

/*
 * Email first, and a name only when there is no address on either side.
 *
 * An invite that carries "Jorge" and a mailbox that carries "Jorge Roji
 * Pezzoli <jorge@example.com>" is the case this has to get right, and the only
 * thing they share is a first name — so name matching is a containment test in
 * both directions. That is loose enough to catch a partial name and tight
 * enough that it needs a whole token to match, which "J" would not.
 */
export function samePerson(left, right) {
  if (left.email && right.email) return left.email === right.email
  const leftName = String(left.name || '').toLowerCase().trim()
  const rightName = String(right.name || '').toLowerCase().trim()
  if (!leftName || !rightName) return false
  if (leftName === rightName) return true
  const leftTokens = leftName.split(/\s+/).filter((token) => token.length > 2)
  const rightTokens = rightName.split(/\s+/).filter((token) => token.length > 2)
  return leftTokens.some((token) => rightTokens.includes(token))
}

/** One line the owner can read at a glance, or hear. */
export function summarizeThread(thread) {
  const who = thread.lastFrom?.name || thread.lastFrom?.email || 'someone'
  const size =
    thread.messageCount === 1
      ? 'One message'
      : `${thread.messageCount} messages${thread.spanDays ? ` over ${thread.spanDays} day${thread.spanDays === 1 ? '' : 's'}` : ''}`

  const standing =
    thread.awaitingOwner === true
      ? `${who} wrote last and you have not replied`
      : thread.awaitingOwner === false
        ? 'you replied last'
        : `${who} wrote last — I could not read your Sent mail, so I cannot tell whether you replied`

  return `${size}. ${standing}.`
}

/* ------------------------------------------------------- reading the mailbox */

async function runOsascript(script, timeoutMs = OSASCRIPT_TIMEOUT_MS) {
  /* mailTriage.js's refusal, reused rather than restated: one place decides
   * what a Mail script is not allowed to contain, and this path is read-only
   * so it has nothing to lose by being held to it. */
  assertScriptNeverSends(script)
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return String(stdout)
}

/**
 * Recent envelopes from every account's INBOX and Sent mailbox.
 *
 * `date sent` is read rather than `date received` for both, because it is the
 * only clock both mailboxes share — a sent message has no received date, and
 * ordering a conversation by two different clocks is how a reply sorts before
 * the message it answers.
 *
 * The batched column reads are mailTriage.js's shape and for its documented
 * reason: one Apple event per column per mailbox rather than one per message,
 * which is the difference between one second and twenty.
 */
export async function readThreadEnvelopes(
  { perMailbox = DEFAULT_SCAN_PER_MAILBOX, sinceDays = 30, now = new Date() } = {},
  { osascript = runOsascript } = {},
) {
  const cap = Math.min(MAX_SCAN_PER_MAILBOX, Math.max(1, Number(perMailbox) || DEFAULT_SCAN_PER_MAILBOX))
  const floor = new Date(
    new Date(now).getTime() - Math.max(1, Number(sinceDays) || 30) * 86_400_000,
  )

  const script = `
on pad2(n)
  set s to (n as integer) as string
  if (count of s) < 2 then set s to "0" & s
  return s
end pad2

set fieldSep to (ASCII character 31)
set recSep to (ASCII character 30)
set output to ""
tell application "Mail"
  repeat with acct in accounts
    set acctName to name of acct
    set boxPairs to {}
    try
      set end of boxPairs to {"inbox", mailbox "INBOX" of acct}
    end try
    try
      repeat with mb in (every mailbox of acct whose name begins with "Sent")
        set end of boxPairs to {"sent", contents of mb}
      end repeat
    end try
    repeat with entry in boxPairs
      try
        set thisPair to contents of entry
        set boxRole to item 1 of thisPair
        set theBox to item 2 of thisPair
        set total to count of messages of theBox
        if total > ${cap} then set total to ${cap}
        if total > 0 then
          tell theBox
            set subs to subject of messages 1 thru total
            set snds to sender of messages 1 thru total
            set dts to date sent of messages 1 thru total
            set mids to message id of messages 1 thru total
          end tell
          repeat with i from 1 to total
            try
              set d to item i of dts
              set stamp to ((year of d) as string) & "-" & my pad2((month of d) as integer) & "-" & my pad2(day of d) & "T" & my pad2(hours of d) & ":" & my pad2(minutes of d) & ":" & my pad2(seconds of d)
              set theSubject to item i of subs
              if theSubject is missing value then set theSubject to ""
              set theId to item i of mids
              if theId is missing value then set theId to ""
              set output to output & acctName & fieldSep & boxRole & fieldSep & stamp & fieldSep & (item i of snds) & fieldSep & (theId as string) & fieldSep & (theSubject as string) & recSep
            end try
          end repeat
        end if
      end try
    end repeat
  end repeat
end tell
return output`

  const stdout = await osascript(script)
  const messages = parseThreadEnvelopes(stdout, { floor })
  return {
    messages,
    /* Whether ANY account produced a Sent mailbox. Everything downstream that
     * claims "you have not replied" is gated on this being true. */
    sentReadable: messages.some((message) => message.mailbox === 'sent'),
  }
}

/** Split what the envelope script emits. Exported so the shape is testable
 * without a mailbox. */
export function parseThreadEnvelopes(stdout, { floor = null } = {}) {
  const floorMs = floor ? new Date(floor).getTime() : null

  return String(stdout)
    .split(RECORD_SEP)
    .map((row) => row.split(FIELD_SEP))
    .filter((parts) => parts.length >= 6)
    .map(([account, mailbox, stamp, sender, messageId, ...rest]) => ({
      account: account.trim(),
      mailbox: mailbox.trim() === 'sent' ? 'sent' : 'inbox',
      sentAt: stamp.trim(),
      sender: sender.trim(),
      messageId: messageId.trim(),
      subject: rest.join(FIELD_SEP).trim(),
    }))
    .filter((message) => message.subject || message.sender)
    .filter((message) => {
      if (floorMs === null) return true
      const sentMs = Date.parse(message.sentAt)
      /* An unparseable date is kept, for mailTriage.js's reason: dropping mail
       * because its timestamp confused us is worse than showing a stale one. */
      return !Number.isFinite(sentMs) || sentMs >= floorMs
    })
}

/**
 * The whole read, as the brief wants it: threads for this meeting, the owner's
 * own addresses, and an honest note when Sent was unavailable.
 */
export async function meetingThreadHistory(
  { attendees = [], terms = [], limit = 4, sinceDays = 30, now = new Date() } = {},
  { readEnvelopes = readThreadEnvelopes } = {},
) {
  const { messages, sentReadable } = await readEnvelopes({ sinceDays, now })
  const ownerAddresses = ownerAddressesFrom(messages)
  const threads = buildThreads(messages, { sentReadable })

  return {
    threads: threadsForMeeting(threads, { attendees, terms, limit, ownerAddresses }),
    ownerAddresses,
    sentReadable,
    scanned: messages.length,
    /* Said out loud in the brief rather than left for someone to notice. */
    limits: sentReadable
      ? []
      : [
          'I could not read your Sent mail, so I cannot tell you which of these threads you have already answered.',
        ],
  }
}

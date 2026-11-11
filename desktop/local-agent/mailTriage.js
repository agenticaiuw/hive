import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { assertNeverSends } from './briefing.js'
import { workspacePath } from './config.js'
import { requestLlmMessages } from './llmPlanner.js'
import { scoreMail } from './notificationTriage.js'

const execFileAsync = promisify(execFile)

/*
 * "Triage my inbox": four buckets, drafted replies, and nothing leaves the Mac.
 *
 * Two things make this different from the mail brief in briefing.js. That one
 * answers "what did I miss" in one spoken paragraph; this one produces a
 * REVIEWABLE ARTEFACT — a list the owner scrolls through with a draft attached
 * to each item that deserves one. And it has to survive a real mailbox: this
 * one holds ~3,165 unread, and the first attempt at reading it walked every
 * message and hung the connection.
 *
 * So the read is bounded twice — by a date floor and by a message cap — and it
 * is BATCHED. `subject of msgs` is one Apple event that returns two hundred
 * subjects; `subject of msg` inside a repeat loop is two hundred Apple events,
 * which is where the twenty seconds in the earlier reader went.
 *
 * "Never send anything without me" is the product, not a permission gate. It is
 * enforced structurally in two places: assertNeverSends() rejects any sink that
 * transmits, and assertScriptNeverSends() refuses to hand osascript a script
 * containing Mail's `send` verb. Drafts land on disk as files. There is no code
 * path from this module to a transmit.
 */

/* The four buckets the owner named, in the order they are worth reading. */
export const MAIL_TRIAGE_BUCKETS = Object.freeze([
  'urgent',
  'reply-soon',
  'reference',
  'noise',
])

/** The two buckets a drafted reply belongs to — "the first two categories". */
export const DRAFTED_BUCKETS = Object.freeze(['urgent', 'reply-soon'])

/* Composed and stored, never transmitted. Same vocabulary as briefing.js so
 * one assertion covers both. */
const TRIAGE_SINKS = Object.freeze(['file', 'speech'])

/* Two independent bounds on the read. The cap is what stops a 3,165-message
 * mailbox from becoming a 3,165-row Apple event; the date floor is what stops
 * the cap from being spent on mail the owner stopped caring about in March. */
const DEFAULT_SCAN_LIMIT = 200
const DEFAULT_SINCE_HOURS = 72
const MAX_SCAN_LIMIT = 600

const OSASCRIPT_TIMEOUT_MS = 120_000
/* Bodies are only read for the handful of messages that get a draft, so this
 * is per-message generosity, not a budget for the whole mailbox. */
const MAX_BODY_CHARS = 4000
const DEFAULT_MAX_DRAFTS = 8
const MAX_STORED_RUNS = 30

/* Unit and record separators: a subject can hold a tab or a comma, and a body
 * holds newlines, so the delimiters have to be characters neither can contain. */
const FIELD_SEP = ''
const RECORD_SEP = ''

const triageDirectory = path.join(workspacePath, 'mail-triage')
const STORE_PATH = path.join(workspacePath, '.pendant-mail-triage.json')

const isValidStore = (value) => value && Array.isArray(value.runs)

/*
 * A deadline is a claim about consequence, and consequence is what separates
 * "urgent" from "I will get to it". Dates alone are not enough — half the
 * inbox mentions a date — so the marker has to be the language of a deadline.
 */
const DEADLINE_LANGUAGE =
  /\b(urgent|asap|immediately|action required|action needed|response required|deadline|due (?:today|tomorrow|by|on)|expires? (?:today|tomorrow|soon)|final notice|last (?:day|chance to respond)|overdue|past due|by end of day|by eod|by close of business|time[- ]sensitive|reminder to (?:sign|submit|respond)|needs? your (?:signature|approval|response))\b/i

/* Somebody is waiting on the owner specifically. A question mark in a subject
 * line is the cheapest honest version of that signal. */
const ASKS_SOMETHING =
  /\?|\b(can you|could you|would you|are you|will you|when can|any update|following up|checking in|let me know|thoughts\??|confirm|please (?:send|review|reply|respond|advise))\b/i

/*
 * Mail nobody can reply to. This is the load-bearing distinction in the whole
 * module: "reference" and "noise" both mean "no draft", and putting a drafted
 * reply on a no-reply address is the failure that would make the owner stop
 * trusting the review list. An address that says do-not-reply is telling the
 * truth about itself.
 *
 * The relay clause is not a guess. The first run against this Mac's real inbox
 * put two Rappi promos in "reference" because their sender is
 * "rappi_at_hello_rappi_com_mx_…@privaterelay.appleid.com" — nothing in it
 * reads as no-reply, so they were treated as a person writing. A Hide My Email
 * relay is an address the owner handed to a signup form; briefing.js's
 * isBulkMail reached the same conclusion from the same domain.
 *
 * The separator is a character class because Apple writes it "no_reply@" and
 * "\bno-?reply\b" does not match that: an underscore is a word character, so
 * there is no boundary after "reply".
 */
const NO_REPLY_SENDER =
  /\b(no[-_]?reply|donotreply|do[-_]not[-_]reply|mailer-daemon|bounce|notifications?@|automated@|alerts?@|postmaster)\b|@privaterelay\.appleid\.com|@(?:.*\.)?(?:e?mail|em|mailer|notifications?)\./i

/*
 * Automated but worth keeping: receipts, statements, the record of something
 * that happened or is about to. Filed, not answered, not deleted.
 *
 * "Subscription is expiring" is here because the real inbox filed it as noise:
 * it comes from Apple's bulk domain and says nothing a receipt regex knows, yet
 * it is a notice about something the owner pays for. Money and account state
 * are the line — a thing the owner owns changing status is a record, an
 * invitation to buy something is not.
 */
const REFERENCE_SUBJECT =
  /\b(receipt|invoice|statement|confirmation|confirmed|your (?:order|booking|reservation|appointment|payment|subscription|plan|account|membership)|subscription (?:is )?(?:expiring|expired|renew)|auto[- ]?renew|will (?:expire|renew)|shipped|out for delivery|itinerary|verification code|security alert|new sign-?in|password (?:reset|changed)|report is ready|has been (?:posted|published|updated)|summary for|transcript|enrollment|grade)\b/i

/* Marketing. Nothing here is a record of anything. */
const NOISE_SUBJECT =
  /\b(unsubscribe|newsletter|digest|weekly (?:update|roundup|digest)|% off|\d+% off|\bsale\b|\bdeal[s]?\b|save (?:big|up to)|limited time|last chance|last call|flash sale|webinar|promo(?:tion)?|survey|invitation to connect|you may (?:also )?like|recommended for you|new in|back in stock|don'?t miss|exclusive offer|free trial|upgrade (?:now|today))\b/i

/*
 * Local part only. The earlier version also treated any @mail./@email./@news.
 * domain as marketing, which is how "Your Subscription is Expiring" from
 * no_reply@email.apple.com ended up in noise — that domain carries a company's
 * transactional mail as well as its promotions, so it says "automated", not
 * "advertising". NO_REPLY_SENDER above is where the domain belongs.
 */
const NOISE_SENDER =
  /\b(marketing@|promo(?:tions?)?@|news(?:letter)?@|deals?@|offers?@|digest@)/i

/*
 * A role address is a department, not a person.
 *
 * The second real run drafted a reply to "Valerie from Holafly
 * <community@team.holafly.com>" because the subject ends in a question mark —
 * "What if your next destination is here?" — and a question from a person is
 * the definition of reply-soon. Nothing about the address says no-reply and
 * nothing about the subject says sale, so both earlier gates passed it, and the
 * owner got a drafted answer to an advert.
 *
 * A rhetorical question in a marketing subject is not detectable as text. Who
 * sent it is: nobody named Valerie reads community@. So a role address is
 * treated the way a no-reply address is — unless the subject is a reply, which
 * means the owner wrote INTO that queue first and a real thread exists.
 */
const ROLE_SENDER =
  /(?:^|[<\s."])(?:community|team|hello|hi|info|contact|help|care|service|sales|support|updates?|feedback|hey|news)(?:[._+-][a-z0-9]+)*@/i

/*
 * A brand wearing a person's name.
 *
 * "Premium★Tesla <Sales.SG@premiumtesla.com>" and "Valerie from Holafly"
 * both reached the drafted buckets on a rhetorical question — "Is your Tesla
 * road-trip ready?", "What if your next destination is here?" — because a
 * question from a person is exactly what reply-soon is for. The question is not
 * distinguishable as text; the display name is. A trademark glyph in a name, or
 * "<person> from <company>", is a sender who is broadcasting.
 *
 * This is envelope-only judgement and it has a ceiling: a marketing question
 * from firstname@brand.com still reads as a person. The containment is that
 * being wrong costs the owner a draft file they delete — the drafted buckets
 * are the only thing at stake, nothing is hidden, and nothing is ever sent.
 */
const BRAND_DISPLAY_NAME = /[★☆✦✧™®⭐]|\bfrom\s+\p{Lu}[\p{L}]*\s*$/u

/**
 * Spoken phrasings that mean "triage my inbox".
 *
 * Same reasoning as briefing.js's matcher: the deterministic path exists so the
 * capability still works when the planner API does not. `topThree` is carried
 * out of the phrasing because "draft replies for the top three" is a different
 * promise from "draft replies for the first two categories", and the owner
 * asked for both.
 */
const TRIAGE_COMMAND_PATTERNS = [
  [/\btriage\s+(?:my\s+)?(?:in[- ]?box|e-?mail|mail)\b/i, {}],
  [/\b(?:in[- ]?box|e-?mail|mail)\s+triage\b/i, {}],
  [
    /\b(?:turn|make)\s+my\s+unread\s+(?:e-?mail|mail)\s+into\s+(?:a\s+)?priority\s+list\b/i,
    { maxDrafts: 3 },
  ],
  [
    /\b(?:classify|sort|categori[sz]e|prioriti[sz]e|rank)\s+(?:my\s+)?unread\s+(?:e-?mail|mail|messages)\b/i,
    {},
  ],
  [
    /\bdraft\s+repl(?:y|ies)\s+(?:for|to)\s+(?:the\s+)?top\s+(?:three|3)\b/i,
    { maxDrafts: 3 },
  ],
]

/** The triage options a spoken command asks for, or null if it asks for something else. */
export function matchMailTriageCommand(command) {
  const text = String(command || '').trim()
  if (!text) return null
  for (const [pattern, options] of TRIAGE_COMMAND_PATTERNS) {
    if (pattern.test(text)) {
      /* "top three" anywhere in the utterance beats the pattern's own default:
       * the owner said a number out loud and meant it. */
      const topThree = /\btop\s+(?:three|3)\b/i.test(text)
      return { ...options, ...(topThree ? { maxDrafts: 3 } : {}) }
    }
  }
  return null
}

/**
 * Which bucket a message belongs in, and why.
 *
 * The order is the argument. Reply-ability is decided before importance,
 * because a bucket that earns a drafted reply has to be a bucket the owner can
 * actually reply into. Everything automated is filed first; what is left was
 * written by a person, and only then does urgency get a say.
 */
export function classifyMessage(message, { now = new Date(), knownPeople = [] } = {}) {
  const subject = String(message?.subject || '')
  const sender = String(message?.sender || '')
  const { score, reasons: baseReasons } = scoreMail(message, { now, knownPeople })
  const reasons = []

  const automated = NO_REPLY_SENDER.test(sender)
  const marketing = NOISE_SUBJECT.test(subject) || NOISE_SENDER.test(sender)
  const reference = REFERENCE_SUBJECT.test(subject)

  if (marketing && !reference) {
    reasons.push(NOISE_SUBJECT.test(subject) ? 'marketing subject' : 'marketing sender')
    return bucket('noise', score, reasons, baseReasons)
  }

  if (automated) {
    reasons.push('no-reply address — nothing to reply to')
    if (reference) reasons.push('a record worth keeping')
    return bucket(reference ? 'reference' : 'noise', score, reasons, baseReasons)
  }

  /*
   * A department or a brand, not a person — unless the owner already wrote to
   * them, which is what a "Re:" means and is the only cheap proof that a real
   * thread exists.
   */
  if (!/^re:/i.test(subject)) {
    const roleAddress = ROLE_SENDER.test(sender)
    const brandName = BRAND_DISPLAY_NAME.test(displayName(sender))
    if (roleAddress || brandName) {
      reasons.push(
        roleAddress
          ? 'a role address, not a person — no thread to reply into'
          : 'the display name is a brand, not a person',
      )
      if (reference) reasons.push('a record worth keeping')
      return bucket(reference ? 'reference' : 'noise', score, reasons, baseReasons)
    }
  }

  /* A person wrote this. */
  if (DEADLINE_LANGUAGE.test(subject)) {
    reasons.push('names a deadline or asks for an action')
    return bucket('urgent', score, reasons, baseReasons)
  }

  if (ASKS_SOMETHING.test(subject)) {
    reasons.push('asks the owner something directly')
    return bucket('reply-soon', score, reasons, baseReasons)
  }

  if (/^re:/i.test(subject)) {
    reasons.push('a thread the owner is already inside')
    return bucket('reply-soon', score, reasons, baseReasons)
  }

  /*
   * A stranger with nothing to answer is a bulletin, not a conversation. It
   * still gets kept — "reference" is the bucket for "read it when you have a
   * minute", and the whole point of four buckets is that only one of them is
   * throwaway.
   */
  if (reference) reasons.push('a record worth keeping')
  else reasons.push('no question in it and no deadline on it')
  return bucket('reference', score, reasons, baseReasons)
}

function bucket(name, score, reasons, baseReasons) {
  return {
    bucket: name,
    score,
    /*
     * The scorer's reasons are kept alongside the classifier's so the review
     * list can explain a ranking as well as a bucket — deduped, because the two
     * agree often enough that the real inbox produced "marketing subject |
     * marketing subject" on every promo.
     */
    reasons: [...new Set([...reasons, ...baseReasons])],
  }
}

/* ---------- reading the mailbox ---------- */

/*
 * The one thing this module must never do, checked on the way to osascript
 * rather than left to code review. `send` is Mail's verb for transmitting; a
 * script containing it does not get run from here, whatever it says it is for.
 */
export function assertScriptNeverSends(script) {
  const text = String(script || '')
  if (/\bsend\b/i.test(text)) {
    throw new Error(
      'Refusing to run a Mail script containing "send": triage drafts and stores, it never transmits.',
    )
  }
  return true
}

async function runOsascript(script, timeoutMs = OSASCRIPT_TIMEOUT_MS) {
  assertScriptNeverSends(script)
  const { stdout } = await execFileAsync('osascript', ['-e', script], {
    timeout: timeoutMs,
    maxBuffer: 16 * 1024 * 1024,
  })
  return String(stdout)
}

/*
 * Zero-padding lives in a handler because the alternative is `text -2 thru -1`
 * inline six times per message, and a locale-free numeric stamp is the only
 * date format that survives a Mac whose clock is 12-hour and a parser that is
 * not.
 */
const APPLESCRIPT_PAD = `
on pad2(n)
  set s to (n as integer) as string
  if (count of s) < 2 then set s to "0" & s
  return s
end pad2
`

/**
 * Unread envelopes, newest first, bounded by both a cap and a date floor.
 *
 * Envelope only — no bodies. Bodies are a much slower read and triage is
 * decided on who sent it and what they called it, exactly as
 * notificationTriage decided. The bodies for the few messages that earn a
 * draft are fetched afterwards, by index, in one more round trip.
 */
export async function readUnreadEnvelopes({
  sinceHours = DEFAULT_SINCE_HOURS,
  limit = DEFAULT_SCAN_LIMIT,
  now = new Date(),
} = {}, { osascript = runOsascript } = {}) {
  const cap = Math.min(MAX_SCAN_LIMIT, Math.max(1, Number(limit) || DEFAULT_SCAN_LIMIT))
  const floor = new Date(new Date(now).getTime() - Math.max(1, Number(sinceHours) || DEFAULT_SINCE_HOURS) * 3_600_000)

  const script = `${APPLESCRIPT_PAD}
set fieldSep to (ASCII character 31)
set recSep to (ASCII character 30)
set output to ""
tell application "Mail"
  repeat with acct in accounts
    set acctName to name of acct
    try
      set acctOwner to full name of acct
    on error
      set acctOwner to ""
    end try
    set box to missing value
    try
      set box to mailbox "INBOX" of acct
    end try
    if box is not missing value then
      set total to count of messages of box
      if total > ${cap} then set total to ${cap}
      if total > 0 then
        -- One Apple event per column, and the range specifier is never
        -- materialised into a variable first: assigning "messages 1 thru n" to
        -- a variable resolves it to a LIST of message specifiers, and Mail
        -- answers a property read on that list with -1728, "Can't get subject
        -- of {…}". Asking the mailbox for the property of the range keeps it
        -- one specifier, which is one event returning n subjects. The
        -- per-message alternative is what made the earlier reader take twenty
        -- seconds for sixty messages.
        tell box
          set subs to subject of messages 1 thru total
          set snds to sender of messages 1 thru total
          set dts to date received of messages 1 thru total
          set rds to read status of messages 1 thru total
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
            set output to output & acctName & fieldSep & acctOwner & fieldSep & (i as string) & fieldSep & stamp & fieldSep & ((item i of rds) as string) & fieldSep & (item i of snds) & fieldSep & (theId as string) & fieldSep & (theSubject as string) & recSep
          end try
        end repeat
      end if
    end if
  end repeat
end tell
return output`

  const stdout = await osascript(script)
  return parseEnvelopes(stdout, { floor })
}

/** Split what the envelope script emits. Exported so the shape is testable
 * without a mailbox. */
export function parseEnvelopes(stdout, { floor = null } = {}) {
  const floorMs = floor ? new Date(floor).getTime() : null

  return String(stdout)
    .split(RECORD_SEP)
    .map((row) => row.split(FIELD_SEP))
    .filter((parts) => parts.length >= 8)
    .map(([account, accountOwner, index, stamp, read, sender, messageId, ...rest]) => ({
      account: account.trim(),
      accountOwner: accountOwner.trim(),
      /* The 1-based position in this account's INBOX. It is how the body read
       * addresses the message a second time, and it is only valid for as long
       * as the mailbox does not shift under us — which is why the body read
       * checks the subject before it trusts it. */
      index: Number(index),
      receivedAt: stamp.trim(),
      read: read.trim() === 'true',
      sender: sender.trim(),
      messageId: messageId.trim(),
      subject: rest.join(FIELD_SEP).trim(),
    }))
    .filter((message) => Number.isFinite(message.index) && (message.subject || message.sender))
    .filter((message) => !message.read)
    .filter((message) => {
      if (floorMs === null) return true
      const receivedMs = Date.parse(message.receivedAt)
      /* An unparseable date is kept: dropping mail because its timestamp
       * confused us is a worse failure than showing one stale message. */
      return !Number.isFinite(receivedMs) || receivedMs >= floorMs
    })
    .sort((left, right) => Date.parse(right.receivedAt) - Date.parse(left.receivedAt))
}

/**
 * Bodies for the messages that will get a draft, addressed by the index the
 * envelope read recorded.
 *
 * The subject is re-read and compared. A mailbox that received new mail between
 * the two reads has shifted every index by one, and a draft written against the
 * wrong body is worse than a draft written against no body at all.
 */
export async function readMessageBodies(messages, { osascript = runOsascript } = {}) {
  const bodies = new Map()
  const byAccount = new Map()
  for (const message of messages) {
    if (!byAccount.has(message.account)) byAccount.set(message.account, [])
    byAccount.get(message.account).push(message)
  }

  for (const [account, group] of byAccount) {
    const script = `
set fieldSep to (ASCII character 31)
set recSep to (ASCII character 30)
set output to ""
tell application "Mail"
  set box to mailbox "INBOX" of (first account whose name is "${escapeAppleScript(account)}")
  repeat with idx in {${group.map((message) => message.index).join(', ')}}
    try
      set m to message (idx as integer) of box
      set theBody to content of m
      if theBody is missing value then set theBody to ""
      if (count of theBody) > ${MAX_BODY_CHARS} then set theBody to text 1 thru ${MAX_BODY_CHARS} of theBody
      set theSubject to subject of m
      if theSubject is missing value then set theSubject to ""
      set output to output & (idx as string) & fieldSep & (theSubject as string) & fieldSep & theBody & recSep
    end try
  end repeat
end tell
return output`

    let stdout
    try {
      stdout = await osascript(script)
    } catch {
      /* One account's bodies failing must not cost the other account's. The
       * draft falls back to the template, which says so. */
      continue
    }

    for (const row of String(stdout).split(RECORD_SEP)) {
      const parts = row.split(FIELD_SEP)
      if (parts.length < 3) continue
      const index = Number(parts[0])
      const subject = parts[1].trim()
      const body = parts.slice(2).join(FIELD_SEP)
      const expected = group.find((message) => message.index === index)
      if (!expected) continue
      if (normalizeSubject(expected.subject) !== normalizeSubject(subject)) continue
      bodies.set(bodyKey(expected), cleanBody(body))
    }
  }

  return bodies
}

function bodyKey(message) {
  return `${message.account}#${message.index}`
}

function normalizeSubject(value) {
  return String(value || '').replace(/\s+/g, ' ').trim().toLowerCase()
}

/*
 * Mail hands back the plain-text alternative of an HTML message, which is
 * mostly quoted history, tracking URLs and the wall of legal boilerplate under
 * the signature. What a draft needs is the top of the message.
 */
export function cleanBody(raw) {
  const lines = String(raw || '')
    .replace(/\r\n?/g, '\n')
    .split('\n')

  const kept = []
  for (const line of lines) {
    const text = line.trim()
    /* Everything below a quote marker or an "On <date> X wrote:" is the
     * conversation the owner already had. */
    if (/^>/.test(text)) break
    if (/^on .+ wrote:$/i.test(text)) break
    if (/^-{2,}\s*original message/i.test(text)) break
    if (/^(from|sent|to|subject):\s/i.test(text) && kept.length > 2) break
    if (/^https?:\/\/\S+$/i.test(text)) continue
    kept.push(text)
    if (kept.join('\n').length > 1200) break
  }

  return kept.join('\n').replace(/\n{3,}/g, '\n\n').trim()
}

/* ---------- drafting ---------- */

/**
 * A reply the owner can edit and send themselves.
 *
 * Deterministic, and deliberately incomplete where it does not know something:
 * a bracketed placeholder is a draft that admits what it is missing, whereas an
 * invented commitment reads exactly like a real one until the owner has already
 * sent it. Used verbatim when no model is configured, and as the fallback when
 * one is configured and fails.
 */
export function templateDraft(message, { body = '', signature = '' } = {}) {
  const first = firstName(message.sender)
  const ask = firstQuestion(body)
  const subject = /^re:/i.test(message.subject)
    ? message.subject
    : `Re: ${message.subject}`

  const lines = [
    `Hi ${first || 'there'},`,
    '',
    `Thanks for your note about "${stripRe(message.subject)}".`,
    '',
    ask
      ? `On "${ask}" — [your answer].`
      : '[Your reply.]',
    '',
    '[Anything you are committing to, and by when.]',
    '',
    'Best,',
    signature || '[your name]',
  ]

  return { subject, body: lines.join('\n'), generatedBy: 'template' }
}

/**
 * Ask the model for the drafts in one call, and keep the template for anything
 * it does not return.
 *
 * One call rather than one per message because the drafts are read together —
 * three replies that each open "Thanks for your note" is what per-message
 * drafting produces, and the owner notices immediately.
 */
export async function draftReplies(
  candidates,
  { bodies = new Map(), signature = '', llm = requestLlmMessages } = {},
) {
  const fallback = candidates.map((message) => ({
    ...templateDraft(message, { body: bodies.get(bodyKey(message)) || '', signature }),
    account: message.account,
    index: message.index,
    to: message.sender,
    inReplyTo: message.messageId,
    bucket: message.bucket,
  }))

  if (!candidates.length) return fallback

  let raw
  try {
    raw = await llm({
      messages: [
        {
          role: 'system',
          content: `You draft replies the owner will read, edit and send THEMSELVES. You cannot send mail and you never claim to have sent, scheduled, paid for, booked or agreed to anything.

Return JSON: {"drafts":[{"n":<number>,"subject":"...","body":"..."}]}

Rules:
- One draft per numbered message. Reuse the message's number in "n".
- "body" is plain text, 40-120 words, no markdown, no signature block — the signature is added afterwards.
- Answer what the sender actually asked. If the message does not say enough to answer, write the reply that asks for the missing piece rather than inventing it.
- Never state a fact about the owner's availability, decisions, finances or commitments that is not in the message. Where the owner has to fill something in, write it as a bracketed placeholder like [date].
- Match the register of the incoming mail: a one-line question gets a one-line answer.`,
        },
        {
          role: 'user',
          content: candidates
            .map((message, position) =>
              [
                `--- Message ${position + 1} ---`,
                `From: ${message.sender}`,
                `Subject: ${message.subject}`,
                `Received: ${message.receivedAt}`,
                `Why it needs a reply: ${(message.reasons || []).slice(0, 3).join('; ')}`,
                bodies.get(bodyKey(message))
                  ? `Body:\n${bodies.get(bodyKey(message))}`
                  : 'Body: (could not be read — draft from the subject line and say what you need)',
              ].join('\n'),
            )
            .join('\n\n'),
        },
      ],
    })
  } catch {
    /* A model outage costs the owner draft quality, never the triage. */
    return fallback
  }

  let parsed
  try {
    parsed = JSON.parse(raw)
  } catch {
    return fallback
  }

  const drafts = Array.isArray(parsed?.drafts) ? parsed.drafts : []
  return fallback.map((draft, position) => {
    const match = drafts.find((entry) => Number(entry?.n) === position + 1)
    const body = String(match?.body ?? '').trim()
    if (!body) return draft
    return {
      ...draft,
      subject: String(match?.subject ?? '').trim() || draft.subject,
      body: signature ? `${body}\n\nBest,\n${signature}` : body,
      generatedBy: 'model',
    }
  })
}

/* ---------- the run ---------- */

/**
 * Read the unread mail, sort it into four buckets, draft replies for the two
 * that deserve them, and leave the whole thing on disk to be reviewed.
 *
 * Readers are injectable because the mailbox is the one part that cannot be
 * reproduced in a test; the classification and the rendering can.
 */
export async function triageInbox(
  {
    now = new Date(),
    sinceHours = DEFAULT_SINCE_HOURS,
    limit = DEFAULT_SCAN_LIMIT,
    maxDrafts = DEFAULT_MAX_DRAFTS,
    knownPeople = [],
    sinks = TRIAGE_SINKS,
    store = true,
  } = {},
  {
    readEnvelopes = readUnreadEnvelopes,
    readBodies = readMessageBodies,
    draft = draftReplies,
  } = {},
) {
  assertNeverSends(sinks)

  const envelopes = await readEnvelopes({ sinceHours, limit, now })
  const signature = envelopes.find((message) => message.accountOwner)?.accountOwner || ''

  const classified = envelopes.map((message) => ({
    ...message,
    ...classifyMessage(message, { now, knownPeople }),
  }))

  const buckets = Object.fromEntries(
    MAIL_TRIAGE_BUCKETS.map((name) => [
      name,
      classified
        .filter((message) => message.bucket === name)
        .sort((left, right) => right.score - left.score || Date.parse(right.receivedAt) - Date.parse(left.receivedAt)),
    ]),
  )

  /*
   * "Draft replies for the first two categories" and "draft replies for the top
   * three" are the same operation with a different cap: urgent before
   * reply-soon, best-scoring first, cut at maxDrafts.
   */
  /* `?? DEFAULT` would not have caught a non-numeric cap: Number('lots') is
   * NaN, not nullish, and slice(0, NaN) silently drafts nothing at all. */
  const draftCap = Number.isFinite(Number(maxDrafts))
    ? Math.max(0, Number(maxDrafts))
    : DEFAULT_MAX_DRAFTS
  const candidates = DRAFTED_BUCKETS.flatMap((name) => buckets[name]).slice(0, draftCap)

  let bodies = new Map()
  let bodyError = null
  if (candidates.length) {
    try {
      bodies = await readBodies(candidates)
    } catch (error) {
      bodyError = String(error?.message || error).slice(0, 200)
    }
  }

  const drafts = await draft(candidates, { bodies, signature })

  const run = {
    id: `triage_${new Date(now).toISOString().replace(/[-:.]/g, '').slice(0, 15)}_${crypto.randomBytes(3).toString('hex')}`,
    generatedAt: new Date(now).toISOString(),
    window: {
      sinceHours,
      since: new Date(new Date(now).getTime() - sinceHours * 3_600_000).toISOString(),
      scanLimit: limit,
    },
    scanned: envelopes.length,
    counts: Object.fromEntries(
      MAIL_TRIAGE_BUCKETS.map((name) => [name, buckets[name].length]),
    ),
    buckets: Object.fromEntries(
      MAIL_TRIAGE_BUCKETS.map((name) => [name, buckets[name].map(publicMessage)]),
    ),
    drafts: drafts.map((entry, position) => ({
      ...entry,
      /* The draft points back at the message it answers, so the review list can
       * put them side by side and the owner can tell which is which. */
      message: publicMessage(candidates[position]),
    })),
    bodyError,
    /* Said in the object as well as the prose, because a caller that only reads
     * JSON should not have to infer it. */
    sent: false,
    sinks: [...sinks],
  }

  run.review = formatReview(run)
  run.spoken = speakableSummary(run)

  if (store) {
    const written = writeTriageRun(run)
    run.folder = written.folder
    run.reviewPath = written.reviewPath
    run.draftPaths = written.draftPaths
    rememberRun(run)
  }

  return run
}

function publicMessage(message) {
  if (!message) return null
  return {
    subject: message.subject,
    sender: message.sender,
    senderName: displayName(message.sender),
    receivedAt: message.receivedAt,
    account: message.account,
    messageId: message.messageId,
    bucket: message.bucket,
    score: message.score,
    reasons: message.reasons,
  }
}

/**
 * The reviewable list, as the owner reads it.
 *
 * Urgent and reply-soon are itemised with their reason and their draft; the
 * other two are counted and named. A four-hundred-line review is a review
 * nobody opens, and the two buckets with no draft attached are exactly the two
 * the owner is willing to skim.
 */
export function formatReview(run) {
  const lines = [
    `# Inbox triage — ${new Date(run.generatedAt).toLocaleString()}`,
    '',
    `${run.scanned} unread message${run.scanned === 1 ? '' : 's'} received since ${new Date(run.window.since).toLocaleString()}.`,
    `${run.drafts.length} repl${run.drafts.length === 1 ? 'y is' : 'ies are'} drafted below. **Nothing has been sent** — these are files, and sending them is yours to do.`,
    '',
  ]

  for (const name of DRAFTED_BUCKETS) {
    const items = run.buckets[name]
    lines.push(`## ${bucketTitle(name)} (${items.length})`, '')
    if (!items.length) {
      lines.push('_Nothing._', '')
      continue
    }
    for (const message of items) {
      const draft = run.drafts.find(
        (entry) => entry.message?.messageId === message.messageId && entry.message?.subject === message.subject,
      )
      lines.push(
        `- **${message.subject || '(no subject)'}** — ${message.senderName}`,
        `  _${new Date(message.receivedAt).toLocaleString()} · ${message.reasons.slice(0, 3).join('; ')}_`,
      )
      if (draft) {
        lines.push('', '  <details><summary>Draft reply</summary>', '')
        lines.push(`  Subject: ${draft.subject}`, '')
        for (const line of draft.body.split('\n')) lines.push(`  ${line}`)
        lines.push('', '  </details>', '')
      } else {
        lines.push('  _No draft: past the draft limit for this run._', '')
      }
    }
    lines.push('')
  }

  for (const name of ['reference', 'noise']) {
    const items = run.buckets[name]
    lines.push(`## ${bucketTitle(name)} (${items.length})`, '')
    if (!items.length) {
      lines.push('_Nothing._', '')
      continue
    }
    for (const message of items.slice(0, 25)) {
      lines.push(`- ${message.subject || '(no subject)'} — ${message.senderName}`)
    }
    if (items.length > 25) lines.push(`- _…and ${items.length - 25} more._`)
    lines.push('')
  }

  if (run.bodyError) {
    lines.push('---', '', `_Message bodies could not be read (${run.bodyError}); drafts were written from subject lines._`, '')
  }

  return `${lines.join('\n')}\n`
}

function bucketTitle(name) {
  return {
    urgent: 'Urgent',
    'reply-soon': 'Reply soon',
    reference: 'Reference',
    noise: 'Noise',
  }[name]
}

function speakableSummary(run) {
  if (!run.scanned) {
    return `No unread mail in the last ${run.window.sinceHours} hours.`
  }

  const parts = [
    `${run.counts.urgent} urgent, ${run.counts['reply-soon']} to reply to soon, ${run.counts.reference} for reference, ${run.counts.noise} noise.`,
  ]

  const top = run.buckets.urgent[0] || run.buckets['reply-soon'][0]
  if (top) parts.push(`Top of the pile is ${top.senderName} about ${stripRe(top.subject)}.`)
  if (run.drafts.length) {
    parts.push(
      `I drafted ${run.drafts.length} repl${run.drafts.length === 1 ? 'y' : 'ies'} for you to review. Nothing was sent.`,
    )
  }
  return parts.join(' ')
}

/* ---------- storage ---------- */

/*
 * Files, not Mail drafts. A draft inside Mail.app is one keystroke from being
 * sent by the app the owner already has open, and "without sending anything"
 * deserves a stronger guarantee than a UI convention. A markdown file cannot
 * transmit itself.
 */
function writeTriageRun(run) {
  const folder = path.join(triageDirectory, run.id)
  const draftsFolder = path.join(folder, 'drafts')
  fs.mkdirSync(draftsFolder, { recursive: true })

  const reviewPath = path.join(folder, 'REVIEW.md')
  fs.writeFileSync(reviewPath, run.review, 'utf8')

  const draftPaths = run.drafts.map((draft, position) => {
    const draftPath = path.join(
      draftsFolder,
      `${String(position + 1).padStart(2, '0')}-${slug(draft.message?.senderName || 'reply')}.md`,
    )
    fs.writeFileSync(
      draftPath,
      [
        `To: ${draft.to}`,
        `Subject: ${draft.subject}`,
        draft.inReplyTo ? `In-Reply-To: ${draft.inReplyTo}` : null,
        `Drafted-By: ${draft.generatedBy}`,
        'Status: DRAFT — not sent, not queued, not in Mail.app.',
        '',
        draft.body,
      ]
        .filter((line) => line !== null)
        .join('\n'),
      'utf8',
    )
    return draftPath
  })

  return { folder, reviewPath, draftPaths }
}

function load() {
  ensureJsonStore(STORE_PATH, { runs: [] }, { validate: isValidStore })
  return readJsonWithRecovery(STORE_PATH, {
    fallback: { runs: [] },
    validate: isValidStore,
  })
}

function rememberRun(run) {
  const store = load()
  store.runs.unshift({
    id: run.id,
    generatedAt: run.generatedAt,
    scanned: run.scanned,
    counts: run.counts,
    drafts: run.drafts.length,
    folder: run.folder,
    reviewPath: run.reviewPath,
    sent: false,
  })
  store.runs = store.runs.slice(0, MAX_STORED_RUNS)
  writeJsonAtomic(STORE_PATH, store)
}

export function listTriageRuns({ limit = 10 } = {}) {
  return load().runs.slice(0, Math.max(1, Number(limit) || 10))
}

export function readTriageRun(id) {
  const summary = load().runs.find((run) => run.id === id)
  if (!summary) return null
  let review
  try {
    review = fs.readFileSync(summary.reviewPath, 'utf8')
  } catch {
    /* The folder can be moved or deleted by the owner; the run summary is still
     * worth returning without it. */
    review = null
  }
  return { ...summary, review }
}

export function mailTriageLocation() {
  return { store: STORE_PATH, folder: triageDirectory }
}

/* ---------- small shared bits ---------- */

function displayName(sender) {
  const text = String(sender || '').trim()
  const named = text.match(/^"?([^"<]+?)"?\s*<[^>]+>$/)
  if (named) return named[1].trim()
  const local = text.match(/^([^@<]+)@/)
  return local ? local[1].trim() : text
}

function firstName(sender) {
  const name = displayName(sender)
  if (/@/.test(name)) return ''
  /* "Liu, Evan" is how directories render people; the given name is second. */
  const comma = name.match(/^([^,]+),\s*(\S+)/)
  if (comma) return comma[2]
  return name.split(/\s+/)[0] || ''
}

function stripRe(subject) {
  return String(subject || '').replace(/^(?:re|fwd?):\s*/i, '').trim()
}

/** The first thing in the body shaped like a question. */
function firstQuestion(body) {
  const sentences = String(body || '')
    .split(/(?<=[.!?])\s+|\n+/)
    .map((line) => line.trim())
    .filter(Boolean)
  const question = sentences.find((line) => line.endsWith('?') && line.length < 160)
  return question || ''
}

function slug(value) {
  return (
    String(value || '')
      .toLowerCase()
      .replace(/[^\p{L}\p{N}]+/gu, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 40) || 'reply'
  )
}

function escapeAppleScript(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export const MAIL_TRIAGE_SINKS = TRIAGE_SINKS

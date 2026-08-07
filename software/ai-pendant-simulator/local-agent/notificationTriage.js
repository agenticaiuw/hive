import { listEvents, listOpenReminders, listRecentMail } from './appleData.js'

/*
 * "Read my notifications and tell me only what's important."
 *
 * Notification Center's own database sits behind Full Disk Access and holds
 * banners that have already been dismissed — it is a log of what interrupted
 * the owner, not of what still needs them. The three things that actually
 * generate the interruptions are readable without it: unread mail, a meeting
 * about to start, and something past due. Those are what get triaged.
 *
 * "Only what's important" is the entire request, so the default is silence.
 * Everything starts at zero and has to earn its way past a threshold; nothing
 * is included because it exists. The signals are deliberately boring — a
 * sender who is a person, a subject that names a deadline, a meeting inside the
 * next hour — because clever importance heuristics are how an inbox full of
 * marketing ends up being read aloud to someone on a bike.
 */

const IMPORTANT_SUBJECT =
  /\b(urgent|asap|action required|deadline|expires?|final notice|overdue|past due|invoice|payment (?:due|failed)|interview|offer|contract|signature|sign|approve|approval|security alert|verify|suspicious|outage|incident|down)\b/i

const QUESTION_TO_ME = /\?\s*$|\b(can you|could you|are you|would you|will you|when can|any update)\b/i

const BULK_SENDER =
  /\b(no-?reply|noreply|donotreply|do-not-reply|notifications?@|updates?@|news(?:letter)?@|marketing@|info@|support@|team@|hello@|mailer|bounce|via\s)\b/i

const BULK_SUBJECT =
  /\b(unsubscribe|newsletter|digest|weekly (?:update|roundup)|sale|% off|deal|webinar|promo|survey|invitation to connect|you may (?:also )?like|recommended for you|new in)\b/i

/*
 * Anything at or above this gets spoken. Set by working backwards from the mail
 * that must NOT clear it: "Lunch sometime?" from a real person, sent an hour
 * ago, scores 3 on question-mark plus recency alone. A threshold of 3 would
 * read that aloud, which is the exact failure the owner asked to be spared.
 */
const IMPORTANCE_THRESHOLD = 4

const IMMINENT_MEETING_MINUTES = 60

/**
 * Rank one mail envelope. Envelope only: the body is a much slower read and
 * triage is decided on who sent it and what they called it.
 */
export function scoreMail(message, { now = new Date(), knownPeople = [] } = {}) {
  const subject = String(message.subject || '')
  const sender = String(message.sender || '')
  const reasons = []
  let score = 0

  if (BULK_SENDER.test(sender)) {
    score -= 4
    reasons.push('bulk sender')
  }
  if (BULK_SUBJECT.test(subject)) {
    score -= 3
    reasons.push('marketing subject')
  }
  if (IMPORTANT_SUBJECT.test(subject)) {
    score += 4
    reasons.push('names a deadline or an action')
  }
  if (QUESTION_TO_ME.test(subject)) {
    score += 2
    reasons.push('asks something')
  }

  const senderName = sender.replace(/<.*>/, '').trim().toLowerCase()
  if (
    knownPeople.some(
      (person) => person && senderName.includes(String(person).toLowerCase()),
    )
  ) {
    score += 3
    reasons.push('someone you know')
  }

  /* A reply is a thread the owner is already inside. */
  if (/^re:/i.test(subject)) {
    score += 1
    reasons.push('reply to a thread')
  }

  const receivedMs = Date.parse(message.receivedAt)
  if (Number.isFinite(receivedMs)) {
    const hoursOld = (new Date(now).getTime() - receivedMs) / 3_600_000
    if (hoursOld <= 4) {
      score += 1
      reasons.push('arrived in the last few hours')
    } else if (hoursOld > 72) {
      /* Three days unread is the owner's own answer about its importance. */
      score -= 2
      reasons.push('sat unread for days')
    }
  }

  return { score, reasons }
}

export function scoreEvent(event, { now = new Date() } = {}) {
  const minutesAway = Math.round((Date.parse(event.start) - new Date(now).getTime()) / 60_000)
  const reasons = []
  let score = 0

  if (minutesAway >= 0 && minutesAway <= IMMINENT_MEETING_MINUTES) {
    score += 5
    reasons.push(`starts in ${minutesAway} minutes`)
  } else if (minutesAway < 0 && Date.parse(event.end) > new Date(now).getTime()) {
    score += 5
    reasons.push('happening right now')
  }

  if ((event.attendees || []).length > 1) {
    score += 1
    reasons.push('other people are expecting you')
  }

  return { score, reasons, minutesAway }
}

export function scoreReminder(task, { now = new Date() } = {}) {
  const reasons = []
  let score = 0
  const dueMs = task.due ? Date.parse(task.due) : null
  const nowMs = new Date(now).getTime()

  if (dueMs && dueMs < nowMs) {
    score += 4
    reasons.push('past due')
  } else if (dueMs && dueMs - nowMs < 6 * 3_600_000) {
    /* Same weight as past due: the owner can still act on this one. */
    score += 4
    reasons.push('due in the next few hours')
  }

  if (task.priority > 0 && task.priority <= 4) {
    score += 2
    reasons.push('you marked it high priority')
  }

  return { score, reasons }
}

/**
 * Triage every source into one ranked list. Readers are injectable so the
 * ranking — the part that decides what the owner does not hear — is testable.
 */
export async function triageNotifications(
  { now = new Date(), knownPeople = [], mailLimit = 60, threshold = IMPORTANCE_THRESHOLD } = {},
  {
    readMail = listRecentMail,
    readEvents = listEvents,
    readReminders = listOpenReminders,
  } = {},
) {
  const soon = new Date(new Date(now).getTime() + IMMINENT_MEETING_MINUTES * 60_000)

  const [mail, events, reminders] = await Promise.all([
    settle(() => readMail({ limit: mailLimit, unreadOnly: true })),
    settle(() => readEvents({ from: now, to: soon })),
    settle(() => readReminders({})),
  ])

  const items = [
    ...(mail.value || []).map((message) => {
      const { score, reasons } = scoreMail(message, { now, knownPeople })
      return {
        kind: 'mail',
        title: message.subject,
        detail: message.sender,
        at: message.receivedAt,
        score,
        reasons,
      }
    }),
    ...(events.value || [])
      .filter((event) => !event.allDay)
      .map((event) => {
        const { score, reasons } = scoreEvent(event, { now })
        return {
          kind: 'calendar',
          title: event.title,
          detail: event.location || '',
          at: event.start,
          score,
          reasons,
        }
      }),
    ...(reminders.value || []).map((task) => {
      const { score, reasons } = scoreReminder(task, { now })
      return {
        kind: 'reminder',
        title: task.title,
        detail: task.list || '',
        at: task.due,
        score,
        reasons,
      }
    }),
  ]

  const important = items
    .filter((item) => item.score >= threshold)
    .sort((left, right) => right.score - left.score)

  const suppressed = items.length - important.length

  return {
    generatedAt: new Date(now).toISOString(),
    scanned: {
      mail: (mail.value || []).length,
      calendar: (events.value || []).length,
      reminders: (reminders.value || []).length,
    },
    unavailable: [mail, events, reminders].filter((entry) => entry.error).map((entry) => entry.error),
    important,
    suppressed,
    spoken: speak(important, suppressed),
  }
}

function speak(important, suppressed) {
  if (!important.length) {
    return suppressed
      ? `Nothing important. I looked at ${suppressed} thing${suppressed === 1 ? '' : 's'} and none of them need you.`
      : 'Nothing waiting for you.'
  }

  const lines = important.slice(0, 4).map((item) => {
    if (item.kind === 'mail') return `${item.detail.replace(/<.*>/, '').trim()}: ${item.title}`
    if (item.kind === 'calendar') return `${item.title}, ${item.reasons[0] || 'coming up'}`
    return `${item.title}, ${item.reasons[0] || 'due'}`
  })

  const tail = suppressed ? ` I skipped ${suppressed} that can wait.` : ''
  return `${lines.join('. ')}.${tail}`
}

/* One unreachable source must not take the other two down with it. */
async function settle(read) {
  try {
    return { value: await read() }
  } catch (error) {
    return { value: [], error: String(error?.message || error).slice(0, 200) }
  }
}

export const TRIAGE_THRESHOLD = IMPORTANCE_THRESHOLD

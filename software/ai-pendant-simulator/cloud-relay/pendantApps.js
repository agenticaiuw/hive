/*
 * What each app on the ring actually SAYS.
 *
 * Pure, and separate from menuRing.js on purpose: the ring decides where you
 * are, this decides what you hear when you get there, and the two have
 * completely different failure modes. A ring bug loses you; a phrasing bug
 * wastes the owner's only channel.
 *
 * THE HOUSE RULE FOR EVERY LINE IN THIS FILE. There is no screen, so silence
 * is indistinguishable from breakage — every path speaks, including the empty
 * one and the broken one. And there is no scrollback, so a sentence the owner
 * cannot act on is a sentence that cost them time: at most three items, no
 * preamble, no "here is your list of", no repeating the app's own name back at
 * them (they just heard it when they entered).
 *
 * THE MAC HALF, honestly. Reminders and Calendar are read from the Mac over
 * the exact relay→Mac job path voice tool-calls already ride (enqueueMacPlanJob
 * → bridge claims → hands-free execute → result posted back). They ride
 * `run_applescript` with READ-ONLY bodies rather than a purpose-built
 * `list_reminders` action, and that is a deliberate Phase-1 choice with a
 * reason: local-agent/actionRisk.js classifies run_applescript by what the
 * script BODY does (scriptEffects.js), so these two scripts come back
 * `{safe:true}` / tier `read` and execute hands-free, with no approval parked
 * in front of a question the owner asked out loud. A new typed action would be
 * off the hands-free allowlist on the day it shipped ("list_reminders is not
 * on the hands-free allowlist") and every brief would stall behind a prompt.
 */

/*
 * Read-only by construction, and checked: every statement is a read, no
 * System Events, no property assignment on an application object. Do not
 * "tidy" these into `set hours of dayStart to 0` — that exact line is what
 * makes actionRisk call the script a WRITE against Calendar and park it behind
 * an approval. Subtracting `time of (current date)` gets the same midnight and
 * stays a read.
 */
/*
 * MEASURED, NOT GUESSED. The first version of this script looped
 * `repeat with r in (every reminder whose completed is false)` and read
 * `name of r` per item — one Apple Event per reminder. On the owner's actual
 * Mac (2026-08-12) that never returned: killed at 40 s, and the live pendant
 * job sat in `processing` forever while the ring spoke the sleeping-Mac line.
 * Fetching the names in ONE bulk property read and looping over the resulting
 * LOCAL list returns the same data in ~16 s. Do not "simplify" this back into
 * a loop over application objects.
 *
 * The due dates are gone for the same reason: a second bulk read doubles the
 * cost, and the spoken brief only ever says titles.
 */
export const REMINDERS_SCRIPT = `
tell application "Reminders"
  set titles to name of (every reminder whose completed is false)
end tell
set out to ""
repeat with t in titles
  set out to out & t & linefeed
end repeat
return out
`.trim()

/*
 * Calendar, and the honest state of it.
 *
 * Two measured facts from the owner's Mac. First, Calendar.app must be
 * RUNNING: with it quit, every form of this query fails instantly with
 * "Application isn't running (-600)", and an in-script `launch` neither fixes
 * that nor survives actionRisk (it is classified as an app launch, which needs
 * approval). Hence the `open_app` action ahead of the script in the plan
 * below — `open_app` is on the hands-free allowlist, so the pair still runs
 * without a prompt.
 *
 * Second, and less comfortable: even with Calendar running this query is slow
 * against an iCloud-backed store — 90 s and still going on the owner's Mac,
 * where the same shape against Reminders takes 16 s. So entering Calendar
 * today will usually reach the wait window and speak the honest
 * "Your Mac hasn't answered yet" rather than a schedule. That is a real
 * limitation, written down rather than hidden: the fix is a typed EventKit
 * read on the Mac side (the `list_reminders`-shaped action this doc originally
 * called for, plus its hands-free allowlist entry), which is mac-agent's
 * territory, not the relay's. The script stays because it is correct and
 * costs nothing when the Mac is fast enough to answer.
 */
export const CALENDAR_SCRIPT = `
set dayStart to (current date) - (time of (current date))
set dayEnd to dayStart + (1 * days)
set out to ""
tell application "Calendar"
  repeat with cal in calendars
    tell cal
      repeat with e in (every event whose start date is greater than or equal to dayStart and start date is less than dayEnd)
        set out to out & ((start date of e) as string) & "|" & (summary of e) & linefeed
      end repeat
    end tell
  end repeat
end tell
return out
`.trim()

/** The plan enqueueMacPlanJob wants for one app's read. `text` is the history
 * label only — the actions are the real payload (see plannerHintFromPlan). */
export function appMacPlan(app) {
  if (app === 'reminders') {
    return {
      text: 'pendant: reminders brief',
      planner: 'audio-native',
      status: 'ready',
      actions: [{ type: 'run_applescript', label: 'Open reminders', params: { script: REMINDERS_SCRIPT } }],
    }
  }
  if (app === 'calendar') {
    return {
      text: 'pendant: calendar brief',
      planner: 'audio-native',
      status: 'ready',
      actions: [
        /* Not decoration: without this the script fails instantly with -600.
         * See the CALENDAR_SCRIPT note above. */
        { type: 'open_app', label: 'Calendar', params: { appName: 'Calendar' } },
        { type: 'run_applescript', label: "Today's events", params: { script: CALENDAR_SCRIPT } },
      ],
    }
  }
  return null
}

/**
 * What an app says the moment you enter it, before the Mac has answered.
 *
 * The measured latency is 16 s for Reminders. Sixteen seconds of silence on a
 * device with no screen is indistinguishable from a dead knob, and the grammar's
 * own rule is that there is no silent landing anywhere. One short sentence is
 * the whole fix, and it is also honest about where the answer is coming from.
 */
export function appFetchingSpeech(app) {
  /*
   * "Checking your Mac", not "Checking your reminders". The ring has just
   * spoken the app's name and its how-to ("Reminders. Yellow to check
   * again."), so naming the app a third time in four seconds is the device
   * filling airtime. What this sentence has to add is the thing the owner
   * cannot guess — that the delay they are about to sit through belongs to
   * another machine, and that the pendant has not frozen.
   */
  void app
  return 'Checking your Mac.'
}

/* ---------------------------------------------------------------- Time */

/**
 * The current time, in the owner's timezone.
 *
 * The pendant's own LTE network clock (NITZ, +CCLK) WINS when it parses, for
 * the reason fleetContext.js already gives: it stays correct with the Mac
 * asleep, offline, or in another city — and a worn device that tells you the
 * time of a laptop three timezones away is worse than one that says nothing.
 * The Mac's reported timezone is the fallback, UTC the fallback's fallback,
 * and the timezone is NOT read out loud: "It's 3:42 PM" is the answer, and
 * "Pacific Daylight Time" is four syllables of noise to a person standing in
 * it. Voice asks the same question through the model, which is handed this
 * same clock in its instructions, so the knob and the sentence agree.
 */
export function timeSpeech({ now = Date.now(), timezone = null, deviceTime = null } = {}) {
  if (deviceTime && Number.isFinite(deviceTime.utcMs) && Number.isFinite(deviceTime.offsetMinutes)) {
    const local = new Date(deviceTime.utcMs + deviceTime.offsetMinutes * 60_000)
    return `It's ${clockWords(local.getUTCHours(), local.getUTCMinutes())}.`
  }
  const zone = String(timezone || '').trim()
  if (!zone) {
    /*
     * No LTE clock and no Mac timezone means the relay is GUESSING, so it says
     * "UTC" out loud. A pendant that states a confident local time it cannot
     * possibly know is worse than one that admits the frame of reference — the
     * owner can subtract; they cannot detect a silent lie.
     */
    const utc = new Date(now)
    return `It's ${clockWords(utc.getUTCHours(), utc.getUTCMinutes())}, UTC.`
  }
  try {
    const parts = new Intl.DateTimeFormat('en-US', {
      timeZone: zone,
      hour: 'numeric',
      minute: '2-digit',
      hour12: false,
    }).formatToParts(new Date(now))
    const hour = Number(parts.find((part) => part.type === 'hour')?.value ?? NaN)
    const minute = Number(parts.find((part) => part.type === 'minute')?.value ?? NaN)
    if (Number.isFinite(hour) && Number.isFinite(minute)) {
      return `It's ${clockWords(hour, minute)}.`
    }
  } catch {
    /* An unknown timezone string is not worth a thrown error on the one app
     * that must always answer. Fall through to UTC below. */
  }
  const utc = new Date(now)
  return `It's ${clockWords(utc.getUTCHours(), utc.getUTCMinutes())}, UTC.`
}

function clockWords(hours24, minutes) {
  const hour = hours24 % 12 === 0 ? 12 : hours24 % 12
  const meridiem = hours24 < 12 ? 'AM' : 'PM'
  return `${hour}:${String(minutes).padStart(2, '0')} ${meridiem}`
}

/* ------------------------------------------------------- the Mac's answer */

/**
 * Dig the AppleScript's stdout out of whatever the Mac posted back.
 *
 * Three shapes are accepted because three are real: computerControl's
 * `success()` returns `{stdout, message}`, trimMacResultForModel can hand back
 * a JSON STRING when an entry ran long, and a plain `response` is what a
 * re-planned job carries. Returning null (rather than '') for "nothing usable"
 * is load-bearing: null means "the Mac did not answer", which speaks
 * differently from "the Mac answered, and the answer was empty".
 */
export function macStdout(result) {
  const entries = (Array.isArray(result?.results) ? result.results : [])
    .map((entry) => {
      if (typeof entry !== 'string') return entry
      try {
        /* trimMacResultForModel stringifies long entries; a brief must still
         * read them rather than reporting the Mac silent. */
        return JSON.parse(entry.replace(/…$/, ''))
      } catch {
        return null
      }
    })
    .filter((entry) => entry && entry.ok !== false)

  /*
   * TWO PASSES, and the order is load-bearing now that the Calendar plan runs
   * `open_app` before the script. A single pass taking the first usable string
   * would return open_app's receipt — "Opened Calendar" — and the owner would
   * hear that parsed as their schedule. Only run_applescript carries `stdout`,
   * so stdout-bearing entries are consulted first.
   *
   * An EMPTY stdout on a successful run is an ANSWER — "your day is clear" —
   * and it is returned as '' rather than skipped. Falsy-checking here is the
   * bug that turns a genuinely empty calendar into "your Mac hasn't answered
   * yet", which is the relay reporting a working read as a breakage.
   */
  for (const entry of entries) {
    if (typeof entry.stdout === 'string') return entry.stdout
  }
  for (const entry of entries) {
    if (typeof entry.message === 'string' && entry.message.trim()) return entry.message
  }
  const response = String(result?.response ?? '').trim()
  return response || null
}

export function macFailure(result) {
  const error = String(result?.executionError ?? '').trim()
  if (error) return error
  const entries = Array.isArray(result?.results) ? result.results : []
  for (const entry of entries) {
    if (entry && typeof entry === 'object' && entry.ok === false) {
      return String(entry.message ?? entry.error ?? 'the script failed').slice(0, 160)
    }
  }
  return null
}

const APP_WORDS = Object.freeze({ reminders: 'reminders', calendar: 'calendar' })

/** The Mac is asleep, or slow. Said out loud, because on a screenless device
 * silence and breakage are the same sound. */
export function macUnansweredSpeech(app) {
  return `Your Mac hasn't answered yet. I'll have your ${APP_WORDS[app] ?? 'answer'} when it wakes up.`
}

export function macFailedSpeech(app) {
  return `I couldn't read your ${APP_WORDS[app] ?? 'answer'} from your Mac.`
}

/* ----------------------------------------------------------- Reminders */

const MISSING = /^missing value$/i

export function parseReminderLines(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [title, due] = line.split('|')
      return {
        title: String(title ?? '').trim(),
        due: due && !MISSING.test(due.trim()) ? due.trim() : null,
      }
    })
    .filter((item) => item.title)
}

/**
 * Three at most, and a count for the rest.
 *
 * "You have eleven open reminders" then reading eleven titles is a list nobody
 * can hold; three plus "and eight more" is a brief. The doc's honest empty —
 * "No open reminders." — is a complete sentence and gets no apology attached.
 */
export function remindersBriefSpeech(items = []) {
  const open = items.filter((item) => item?.title)
  if (!open.length) return 'No open reminders.'
  const spoken = open.slice(0, 3).map((item) => item.title)
  const rest = open.length - spoken.length
  const head = open.length === 1 ? 'One open reminder:' : `${open.length} open reminders:`
  return `${head} ${joinSpoken(spoken)}${rest > 0 ? `, and ${rest} more` : ''}.`
}

/* ------------------------------------------------------------ Calendar */

export function parseEventLines(stdout) {
  return String(stdout ?? '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .map((line) => {
      const [when, ...rest] = line.split('|')
      return { when: String(when ?? '').trim(), title: rest.join('|').trim() }
    })
    .filter((event) => event.title)
}

/**
 * The clock reading out of an AppleScript date string.
 *
 * `(start date of e) as string` renders in the MAC's locale, so both
 * "Wednesday, August 12, 2026 at 3:00:00 PM" and "12 August 2026 at 15:00:00"
 * are real inputs. Matching the time-of-day alone handles both and never has
 * to guess a date order — the script already bounded the query to today, so
 * the date carries no information the owner needs.
 */
export function eventClock(when) {
  const match = /(\d{1,2}):(\d{2})(?::\d{2})?\s*([AaPp])?\.?[Mm]?\.?/.exec(String(when ?? ''))
  if (!match) return null
  let hours = Number(match[1])
  const minutes = Number(match[2])
  const meridiem = match[3] ? match[3].toLowerCase() : null
  if (meridiem === 'p' && hours < 12) hours += 12
  if (meridiem === 'a' && hours === 12) hours = 0
  if (!Number.isFinite(hours) || !Number.isFinite(minutes)) return null
  const hour12 = hours % 12 === 0 ? 12 : hours % 12
  const suffix = hours < 12 ? 'AM' : 'PM'
  return minutes === 0 ? `${hour12} ${suffix}` : `${hour12}:${String(minutes).padStart(2, '0')} ${suffix}`
}

/** Today's schedule, three events deep, each as "3 PM, Standup". */
export function calendarBriefSpeech(events = []) {
  const list = events.filter((event) => event?.title)
  if (!list.length) return 'Nothing on your calendar today.'
  const spoken = list.slice(0, 3).map((event) => {
    const clock = eventClock(event.when)
    return clock ? `${clock}, ${event.title}` : event.title
  })
  const rest = list.length - spoken.length
  const head = list.length === 1 ? 'One thing today:' : `${list.length} things today:`
  return `${head} ${joinSpoken(spoken)}${rest > 0 ? `, and ${rest} more` : ''}.`
}

/* Serial comma deliberately absent: this is read aloud, and TTS pauses on the
 * comma before "and" the same way it pauses everywhere else, which turns a
 * three-item list into a stutter. */
function joinSpoken(items) {
  if (items.length <= 1) return items.join('')
  if (items.length === 2) return `${items[0]} and ${items[1]}`
  return `${items.slice(0, -1).join(', ')} and ${items[items.length - 1]}`
}

/** One entry point so the socket handler holds no per-app formatting. */
export function appBriefSpeech(app, result) {
  if (!result) return macUnansweredSpeech(app)
  const stdout = macStdout(result)
  if (stdout === null) {
    return macFailure(result) ? macFailedSpeech(app) : macUnansweredSpeech(app)
  }
  return app === 'reminders'
    ? remindersBriefSpeech(parseReminderLines(stdout))
    : calendarBriefSpeech(parseEventLines(stdout))
}

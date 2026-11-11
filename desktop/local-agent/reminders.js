import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/**
 * Create a Reminders.app item with optional due date.
 * Uses AppleScript once Automation is granted — no interactive UI.
 */
export async function createReminder({
  title,
  due = null,
  notes = '',
  listName = null,
} = {}) {
  const reminderTitle = String(title || '').trim()
  if (!reminderTitle) {
    throw new Error('Reminder title is required.')
  }

  const dueDate = due ? parseDueDate(due) : null
  const script = buildReminderScript({
    title: reminderTitle,
    notes: String(notes || ''),
    dueDate,
    listName,
  })

  let result
  try {
    result = await execFileAsync('osascript', ['-e', script], {
      timeout: 20_000,
    })
  } catch (error) {
    const detail = String(error?.stderr || error?.message || error)
    if (/not allowed|authorization|permission|user canceled|(-1743)/i.test(detail)) {
      throw new Error(
        'macOS blocked Reminders automation. Run once: npm run agent:setup and Allow Reminders under Automation for this host.',
        { cause: error },
      )
    }
    throw error
  }
  const output = String(result?.stdout || result?.stderr || '').trim()

  if (!output || /error/i.test(output)) {
    throw new Error(output || 'Failed to create reminder.')
  }

  return {
    title: reminderTitle,
    due: dueDate?.toISOString?.() || due || null,
    id: output,
  }
}

export async function probeRemindersAccess() {
  try {
    await execFileAsync(
      'osascript',
      ['-e', 'tell application "Reminders" to get name of default list'],
      { timeout: 12_000 },
    )
    return { granted: true }
  } catch (error) {
    return { granted: false, detail: error.message }
  }
}

function buildReminderScript({ title, notes, dueDate, listName }) {
  const escapedTitle = escapeAppleScript(title)
  const escapedNotes = escapeAppleScript(notes)
  const listBlock = listName
    ? `set targetList to list "${escapeAppleScript(listName)}"`
    : 'set targetList to default list'

  let dueBlock = ''
  if (dueDate) {
    dueBlock = `
  set dueDate to current date
  set year of dueDate to ${dueDate.getFullYear()}
  set month of dueDate to ${dueDate.getMonth() + 1}
  set day of dueDate to ${dueDate.getDate()}
  set hours of dueDate to ${dueDate.getHours()}
  set minutes of dueDate to ${dueDate.getMinutes()}
  set seconds of dueDate to 0
  set due date of newReminder to dueDate`
  }

  return `
set wasRunning to (application "Reminders" is running)
tell application "Reminders"
  ${listBlock}
  set newReminder to make new reminder at end of reminders of targetList with properties {name:"${escapedTitle}", body:"${escapedNotes}"}
  ${dueBlock}
  set reminderId to id of newReminder
end tell
if wasRunning is false then
  tell application "Reminders" to quit
end if
return reminderId
`.trim()
}

export function parseDueDate(input, now = new Date()) {
  if (input instanceof Date && !Number.isNaN(input.getTime())) {
    return input
  }

  const text = String(input || '').trim()
  if (!text) return null

  const direct = new Date(text)
  if (!Number.isNaN(direct.getTime()) && /[a-z]/i.test(text) === false) {
    // ISO-like strings are fine; avoid greedy Date parsing of plain words.
  }

  const lower = text.toLowerCase()
  const base = new Date(now)
  let dayOffset = 0

  if (/\btoday\b|오늘/.test(lower)) dayOffset = 0
  else if (/\btomorrow\b|내일/.test(lower)) dayOffset = 1
  else if (/\btonight\b|오늘\s*밤/.test(lower)) dayOffset = 0

  const inDays = lower.match(/\bin\s+(\d+)\s+days?\b/)
  if (inDays) dayOffset = Number(inDays[1])

  const weekday = matchWeekday(lower)
  if (weekday != null) {
    const current = base.getDay()
    dayOffset = (weekday - current + 7) % 7 || 7
  }

  let hours = null
  let minutes = 0

  const ampm = lower.match(/(\d{1,2})(?::(\d{2}))?\s*(a\.?m\.?|p\.?m\.?)/i)
  if (ampm) {
    hours = Number(ampm[1]) % 12
    minutes = Number(ampm[2] || 0)
    if (/p/i.test(ampm[3])) hours += 12
  } else {
    const twentyFour = lower.match(/\b([01]?\d|2[0-3]):([0-5]\d)\b/)
    if (twentyFour) {
      hours = Number(twentyFour[1])
      minutes = Number(twentyFour[2])
    } else {
      const bareHour = lower.match(/\bat\s+(\d{1,2})\b/)
      if (bareHour) {
        hours = Number(bareHour[1])
        if (/\btonight\b|저녁|밤/.test(lower) && hours < 12) hours += 12
      }
    }
  }

  if (/\btonight\b|오늘\s*밤/.test(lower) && hours == null) {
    hours = 21
    minutes = 0
  }

  if (hours == null && dayOffset === 0 && !/\btoday\b|오늘|tonight|내일|tomorrow|in\s+\d+/.test(lower) && weekday == null) {
    const parsed = Date.parse(text)
    if (!Number.isNaN(parsed)) return new Date(parsed)
    return null
  }

  const due = new Date(base)
  due.setDate(due.getDate() + dayOffset)
  due.setSeconds(0, 0)
  if (hours != null) {
    due.setHours(hours, minutes, 0, 0)
  } else {
    due.setHours(9, 0, 0, 0)
  }

  return due
}

function matchWeekday(text) {
  const map = {
    sunday: 0,
    monday: 1,
    tuesday: 2,
    wednesday: 3,
    thursday: 4,
    friday: 5,
    saturday: 6,
  }
  for (const [name, value] of Object.entries(map)) {
    if (text.includes(name)) return value
  }
  return null
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

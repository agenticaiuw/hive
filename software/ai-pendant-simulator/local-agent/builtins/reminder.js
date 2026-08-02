import { createReminder, parseDueDate } from '../reminders.js'

export async function runReminderBuiltin({ command, slots }) {
  const title =
    slots.title ||
    extractReminderTitle(command) ||
    'Reminder'

  const dueText = slots.due || extractDueText(command)
  const due = dueText ? parseDueDate(dueText) || parseDueDate(command) : parseDueDate(command)

  const result = await createReminder({
    title,
    due,
    notes: `Created by AI Pendant from: ${command}`,
  })

  const when = due
    ? new Intl.DateTimeFormat('en-US', {
        weekday: 'short',
        month: 'short',
        day: 'numeric',
        hour: 'numeric',
        minute: '2-digit',
      }).format(due)
    : 'no due date'

  return {
    summary: `Reminder set: ${title}`,
    response: `Done — reminder “${title}” is set${due ? ` for ${when}` : ''}.`,
    actions: [],
    metadata: result,
  }
}

function extractReminderTitle(command = '') {
  const text = String(command)
  const patterns = [
    /remind(?:er)?\s+(?:me\s+)?(?:to\s+)?(.+?)(?:\s+(?:tonight|today|tomorrow|at|on|by)\b|$)/i,
    /add(?:\s+a)?\s+reminder(?:\s+to)?\s+(.+?)(?:\s+(?:tonight|today|tomorrow|at|on|by)\b|$)/i,
    /리마인더(?:\s*(?:를|을))?\s*(?:추가|설정)?(?:\s*해)?(?:\s*줘)?[:\s]*(.+)$/i,
  ]

  for (const pattern of patterns) {
    const match = text.match(pattern)
    if (match?.[1]) {
      return cleanupTitle(match[1])
    }
  }

  return cleanupTitle(text.replace(/add(?:\s+a)?\s+reminder(?:\s+to)?/i, '').trim())
}

function extractDueText(command = '') {
  const match = String(command).match(
    /\b(tonight|today|tomorrow|at\s+\d{1,2}(?::\d{2})?\s*(?:a\.?m\.?|p\.?m\.?)?|on\s+\w+day.*)$/i,
  )
  return match?.[0] || null
}

function cleanupTitle(value) {
  return String(value || '')
    .replace(/\b(tonight|today|tomorrow)\b.*$/i, '')
    .replace(/\bat\s+\d{1,2}.*/i, '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/^to\s+/i, '')
}

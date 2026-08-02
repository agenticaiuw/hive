const DEFAULT_NAME = 'David'
const DEFAULT_TOPIC = 'computing resources'

export function parseCommand(command) {
  const rawCommand = command.trim()

  if (!rawCommand) {
    return unknownPlan()
  }

  const actions = splitIntoActionPhrases(rawCommand)
    .map((phrase) => parseSingleAction(phrase))
    .filter(Boolean)

  if (!actions.length) {
    return unknownPlan()
  }

  return {
    status: 'ready',
    mode: actions.length > 1 ? 'multi_step' : 'single_step',
    action: actions.length > 1 ? 'Prepare multiple actions' : actions[0].action,
    tool: actions.length > 1 ? `${actions.length} mock tools` : actions[0].tool,
    summary:
      actions.length > 1
        ? `${actions.length} actions prepared`
        : actions[0].summary,
    actions,
    parameters: actions.map(({ step, tool, parameters }) => ({
      step,
      tool,
      parameters,
    })),
  }
}

function parseSingleAction(command) {
  const normalized = command.toLowerCase()

  if (normalized.includes('remind') || normalized.includes('reminder')) {
    return buildReminderAction(command)
  }

  if (isCalendarCommand(normalized)) {
    return buildCalendarAction(command)
  }

  if (isEmailCommand(normalized)) {
    return buildEmailAction(command)
  }

  return null
}

function splitIntoActionPhrases(command) {
  const normalized = command.replace(/\s+/g, ' ').trim()
  const reminderConnector = normalized.match(/\s+and\s+(remind me .*)$/i)
  const emailPrefix = reminderConnector
    ? normalized.slice(0, reminderConnector.index).trim()
    : ''

  if (emailPrefix && isEmailCommand(emailPrefix.toLowerCase())) {
    return [emailPrefix, reminderConnector[1]]
  }

  return [normalized]
}

function isEmailCommand(normalized) {
  return ['email', 'draft', 'write an email', 'write email'].some((keyword) =>
    normalized.includes(keyword),
  )
}

function isCalendarCommand(normalized) {
  return (
    normalized.includes('calendar') ||
    normalized.includes('schedule') ||
    normalized.startsWith('what do i have') ||
    normalized.startsWith('what is on my calendar') ||
    normalized.startsWith('show my day')
  )
}

function buildEmailAction(command) {
  const to = extractRecipient(command) || DEFAULT_NAME
  const topic = extractEmailTopic(command) || DEFAULT_TOPIC
  const subject = buildSubject(topic)
  const body = `Hi ${to},

I hope you are doing well. I wanted to ask about ${topic}.

Best,
Geunwoo`

  return {
    step: 1,
    action: 'Draft an email',
    tool: 'draft_email',
    summary: `Draft email to ${to}`,
    parameters: {
      to,
      subject,
      body,
    },
  }
}

function buildReminderAction(command) {
  const title = extractReminderTitle(command) || 'follow up'
  const time = extractReminderTime(command) || 'tomorrow'

  return {
    step: 1,
    action: 'Create a reminder',
    tool: 'create_reminder',
    summary: `Create reminder: ${title}`,
    parameters: {
      title,
      time,
    },
  }
}

function buildCalendarAction(command) {
  const date = extractCalendarDate(command) || 'tomorrow'

  return {
    step: 1,
    action: 'Check calendar',
    tool: 'check_calendar',
    summary: `Check schedule for ${date}`,
    parameters: {
      date,
    },
  }
}

function extractRecipient(command) {
  const match =
    command.match(/\b(?:to|email)\s+([A-Z][a-z]+)\b/) ||
    command.match(/\b([A-Z][a-z]+)\b/)

  return match?.[1] ?? ''
}

function extractEmailTopic(command) {
  const askMatch = command.match(/\basking about\s+(.+?)[.!?]?$/i)
  const aboutMatch = command.match(/\babout\s+(.+?)[.!?]?$/i)
  const regardingMatch = command.match(/\bregarding\s+(.+?)[.!?]?$/i)

  return cleanPhrase(askMatch?.[1] || aboutMatch?.[1] || regardingMatch?.[1])
}

function extractReminderTitle(command) {
  const match = command.match(/\bto\s+(.+?)(?:\s+(?:today|tomorrow|tonight|this morning|tomorrow morning))?[.!?]?$/i)
  return cleanPhrase(match?.[1])
}

function extractReminderTime(command) {
  const normalized = command.toLowerCase()
  const datePhrase = normalized.match(
    /\b(today|tomorrow morning|tomorrow afternoon|tomorrow evening|tomorrow|tonight|this morning|this afternoon|this evening)\b/,
  )?.[1]
  const clock = normalized.match(/\bat\s+([0-9]{1,2}(?::[0-9]{2})?\s*(?:am|pm)?)\b/)?.[1]

  return [datePhrase, clock].filter(Boolean).join(' ')
}

function extractCalendarDate(command) {
  const match = command.match(/\b(today|tomorrow|tonight|this week|next week)\b/i)
  return match?.[1]?.toLowerCase() ?? ''
}

function buildSubject(topic) {
  if (topic.includes('meeting')) {
    return `Follow-up about ${topic}`
  }

  return `Question about ${topic}`
}

function cleanPhrase(value = '') {
  return value
    .replace(/\s+/g, ' ')
    .replace(/[.!?]$/, '')
    .trim()
}

function unknownPlan() {
  return {
    status: 'error',
    message: 'I could not understand the task.',
  }
}

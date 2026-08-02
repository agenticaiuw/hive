import {
  allowedFolders,
  allowedUrls,
  projectPaths,
} from './config.js'
import { getLatestContext } from './contextGraph.js'

export function planCommand(command) {
  const rawCommand = command.trim()
  const normalized = rawCommand.toLowerCase()
  const graphContext = getLatestContext()

  if (!rawCommand) {
    return unsupportedPlan('Empty command.')
  }

  const actions = []

  if (normalized.includes('gmail')) {
    actions.push({
      type: 'open_url',
      label: 'Open Gmail',
      params: { url: allowedUrls.gmail },
    })
  } else if (normalized.includes('google calendar')) {
    actions.push({
      type: 'open_url',
      label: 'Open Google Calendar',
      params: { url: allowedUrls.calendar },
    })
  } else if (normalized.includes('google drive') || normalized.includes('drive')) {
    actions.push({
      type: 'open_url',
      label: 'Open Google Drive',
      params: { url: allowedUrls.drive },
    })
  } else if (normalized.includes('github')) {
    actions.push({
      type: 'open_url',
      label: 'Open GitHub',
      params: { url: allowedUrls.github },
    })
  }

  if (normalized.includes('open my ai pendant project in vs code')) {
    actions.push({
      type: 'open_app',
      label: 'Open VS Code',
      params: { appName: 'Visual Studio Code' },
    })
    actions.push({
      type: 'open_folder',
      label: 'Open AI pendant project folder',
      params: { path: projectPaths['ai-pendant-simulator'] },
    })
  } else if (normalized.includes('calendar')) {
    actions.push({
      type: 'open_app',
      label: 'Open Calendar app',
      params: { appName: 'Calendar' },
    })
  } else if (normalized.includes('finder')) {
    actions.push({
      type: 'open_app',
      label: 'Open Finder',
      params: { appName: 'Finder' },
    })
  } else if (normalized.includes('chrome')) {
    actions.push({
      type: 'open_app',
      label: 'Open Chrome',
      params: { appName: 'Google Chrome' },
    })
  }

  if (isShortenEmailCommand(normalized)) {
    const draft = graphContext.latestEmailDraft

    if (!draft) {
      return unsupportedPlan('No previous email draft was found in context graph.')
    }

    const shorterDraft = shortenEmailDraft(draft)
    actions.push({
      type: 'copy_to_clipboard',
      label: `Copy shorter email draft for ${shorterDraft.to}`,
      params: { text: shorterDraft.body },
      context: { emailDraft: shorterDraft },
    })
    actions.push({
      type: 'open_url',
      label: 'Open Gmail',
      params: { url: allowedUrls.gmail },
    })
  }

  if (isReminderFollowUpCommand(normalized)) {
    const personName = resolvePersonName(rawCommand, graphContext)
    const filename = `reminder-follow-up-${slugify(personName)}.md`
    const title = `Follow up with ${personName}`
    actions.push({
      type: 'create_note',
      label: `Create reminder note for ${personName}`,
      params: {
        filename,
        content: `# ${title}

Due: ${extractReminderTime(rawCommand)}

Created by AI Pendant Mac Local Agent.
`,
      },
      context: {
        task: {
          title,
          due: extractReminderTime(rawCommand),
          personName,
          followUpEmailDraftId: graphContext.latestEmailDraft?.id,
        },
      },
    })
  }

  if (isNoteCommand(normalized) && !isReminderFollowUpCommand(normalized)) {
    const filename = extractNoteFilename(rawCommand)
    actions.push({
      type: 'create_note',
      label: `Create note ${filename}`,
      params: {
        filename,
        content: `# ${titleFromFilename(filename)}

Created by AI Pendant Mac Local Agent.
`,
      },
    })
  }

  if (isEmailClipboardCommand(normalized) && !isShortenEmailCommand(normalized)) {
    const draft = buildEmailDraft(rawCommand)
    actions.push({
      type: 'copy_to_clipboard',
      label: `Copy email draft for ${draft.to}`,
      params: { text: draft.body },
      context: { emailDraft: draft },
    })
    actions.push({
      type: 'open_url',
      label: 'Open Gmail',
      params: { url: allowedUrls.gmail },
    })
  }

  if (normalized.includes('run the ai pendant simulator project')) {
    actions.push({
      type: 'run_project',
      label: 'Run AI pendant simulator project',
      params: { path: projectPaths['ai-pendant-simulator'] },
    })
  }

  if (normalized.includes('search') && normalized.includes('downloads')) {
    actions.push({
      type: 'search_file',
      label: 'Search Downloads folder',
      params: {
        root: allowedFolders.find((folder) => folder.endsWith('/Downloads')),
        query: extractSearchQuery(rawCommand),
      },
    })
  }

  if (!actions.length) {
    const conversation = planConversation(rawCommand, normalized)

    if (conversation) {
      return conversation
    }
    return unsupportedPlan('No safe predefined action matched this command.')
  }

  return {
    status: 'ready',
    command: rawCommand,
    actions,
    requiresConfirmation: true,
    safety:
      'Actions are prepared first. Nothing is executed on the Mac until you confirm.',
  }
}

function planConversation(rawCommand, normalized) {
  const introducedName = rawCommand.match(
    /\b(?:my name is|i am|i'm)\s+([A-Za-z][A-Za-z'-]{0,39})\b/i,
  )?.[1]

  if (introducedName) {
    const name =
      introducedName.charAt(0).toUpperCase() +
      introducedName.slice(1).toLowerCase()

    return instantResponse(
      rawCommand,
      `Hi ${name}, nice to meet you. How can I help?`,
    )
  }

  if (/^(?:hi|hello|hey)\b/.test(normalized)) {
    return instantResponse(rawCommand, 'Hi! How can I help?')
  }

  if (/\b(?:thank you|thanks)\b/.test(normalized)) {
    return instantResponse(rawCommand, "You're welcome.")
  }

  if (/\bwho are you\b/.test(normalized)) {
    return instantResponse(
      rawCommand,
      "I'm your pendant agent, connected to your Mac.",
    )
  }

  return null
}

function instantResponse(command, response) {
  return {
    status: 'instant',
    command,
    response,
    summary: response,
    actions: [],
    requiresConfirmation: false,
    planner: 'rules',
  }
}

function isEmailClipboardCommand(normalized) {
  return (
    normalized.includes('draft an email') ||
    normalized.includes('write an email') ||
    normalized.includes('email ')
  )
}

function isShortenEmailCommand(normalized) {
  return (
    normalized.includes('email') &&
    (normalized.includes('shorter') ||
      normalized.includes('shorten') ||
      normalized.includes('make that email short'))
  )
}

function isReminderFollowUpCommand(normalized) {
  return (
    (normalized.includes('reminder') || normalized.includes('remind me')) &&
    normalized.includes('follow up')
  )
}

function isNoteCommand(normalized) {
  return [
    'create a note',
    'make a note',
    'take a note',
    'new note',
    'write a note',
  ].some((phrase) => normalized.includes(phrase))
}

function buildEmailDraft(command) {
  const to = command.match(/\bto\s+([A-Z][a-z]+)\b/)?.[1] ?? 'David'
  const topic =
    command.match(/\babout\s+(.+?)\s+and\s+copy/i)?.[1] ??
    command.match(/\babout\s+(.+?)[.!?]?$/i)?.[1] ??
    'computing resources'
  const subject = `Question about ${topic}`

  return {
    to,
    topic,
    subject,
    body: `Hi ${to},

I hope you are doing well. I wanted to ask about ${topic}.

Best,
Geunwoo`,
  }
}

function shortenEmailDraft(draft) {
  const to = draft.attributes?.to ?? 'there'
  const topic = draft.attributes?.subject?.replace(/^Question about\s+/i, '') ??
    'this'

  return {
    to,
    topic,
    subject: draft.attributes?.subject ?? `Question about ${topic}`,
    body: `Hi ${to},

Could you let me know whether I can use ${topic} for my project?

Best,
Geunwoo`,
  }
}

function resolvePersonName(command, graphContext) {
  if (/\bhim\b/i.test(command) || /\bher\b/i.test(command)) {
    return graphContext.latestPerson?.name ?? 'David'
  }

  return command.match(/\bwith\s+([A-Z][a-z]+)\b/)?.[1] ??
    graphContext.latestPerson?.name ??
    'David'
}

function extractReminderTime(command) {
  return command.match(/\b(tomorrow(?:\s+morning|\s+afternoon|\s+evening)?|tonight|today)\b/i)?.[1] ??
    'tomorrow'
}

function extractNoteFilename(command) {
  const phrase =
    command.match(/\bcalled\s+(.+?)[.!?]?$/i)?.[1] ??
    command.match(/\bnamed\s+(.+?)[.!?]?$/i)?.[1] ??
    command.match(/\babout\s+(.+?)[.!?]?$/i)?.[1] ??
    'quick note'

  const slug = phrase
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')

  return `${slug || 'untitled-note'}.md`
}

function extractSearchQuery(command) {
  const match = command.match(/\bfor\s+(.+?)[.!?]?$/i)
  return (match?.[1] ?? 'simulator zip').trim()
}

function slugify(value) {
  return String(value)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '') || 'person'
}

function titleFromFilename(filename) {
  return filename
    .replace(/\.(md|txt)$/i, '')
    .replace(/-/g, ' ')
    .replace(/\b\w/g, (letter) => letter.toUpperCase())
}

function unsupportedPlan(reason) {
  return {
    status: 'unsupported',
    command: '',
    actions: [],
    requiresConfirmation: true,
    error: reason,
  }
}

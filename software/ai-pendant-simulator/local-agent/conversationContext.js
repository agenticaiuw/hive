import {
  formatLongTermMemoryForPrompt,
  getLatestContext,
  retrieveLongTermMemory,
} from './contextGraph.js'
import {
  formatWorkingProjectForPrompt,
  getActiveProject,
} from './projectMemory.js'
import { getRecentTurns } from './sessionStore.js'

export function buildConversationContext({ command, sessionId }) {
  const recentTurns = sessionId ? getRecentTurns(sessionId, 10) : []
  const graphContext = getLatestContext()
  const activeProject = getActiveProject()
  const longTerm = retrieveLongTermMemory({
    command,
    projectId: activeProject?.id ?? null,
    limit: 8,
  })

  const resolvedCommand = resolveFollowUpReferences(
    command,
    recentTurns,
    graphContext,
    activeProject,
  )

  const shortTerm = buildShortTermSnapshot(recentTurns)

  return {
    originalCommand: command,
    resolvedCommand,
    recentTurns: recentTurns.map((turn) => ({
      role: turn.role,
      content: turn.content,
      source: turn.source ?? null,
      createdAt: turn.createdAt,
      result: turn.result ?? null,
    })),
    shortTerm,
    workingProject: activeProject,
    longTerm,
    memory: {
      latestEmailDraft: graphContext.latestEmailDraft ?? null,
      latestPerson: graphContext.latestPerson ?? null,
      latestFile: graphContext.latestFile ?? null,
      latestTask: graphContext.latestTask ?? null,
    },
    promptBlock: formatPromptBlock({
      command,
      resolvedCommand,
      recentTurns,
      shortTerm,
      activeProject,
      longTerm,
    }),
  }
}

function buildShortTermSnapshot(recentTurns) {
  const lastUser = [...recentTurns].reverse().find((turn) => turn.role === 'user')
  const lastAssistant = [...recentTurns]
    .reverse()
    .find((turn) => turn.role === 'assistant')

  return {
    lastUserCommand: lastUser?.content ?? null,
    lastAssistantSummary: lastAssistant?.content ?? null,
    lastResult: lastAssistant?.result ?? null,
    turnCount: recentTurns.length,
  }
}

function resolveFollowUpReferences(
  command,
  recentTurns,
  graphContext,
  activeProject,
) {
  let resolved = command.trim()
  const lower = resolved.toLowerCase()

  const lastUserTurn = [...recentTurns].reverse().find((turn) => turn.role === 'user')
  const lastAssistantTurn = [...recentTurns]
    .reverse()
    .find((turn) => turn.role === 'assistant')

  if (/\b(that|it|this|those|same)\b/i.test(resolved) && lastUserTurn) {
    resolved = `${resolved}\n\nRefer to the previous user request: "${lastUserTurn.content}"`
  }

  if (/그거|방금|아까|이거|저거|같은/.test(resolved) && lastUserTurn) {
    resolved = `${resolved}\n\n이전 사용자 요청 참고: "${lastUserTurn.content}"`
  }

  if (/\b(him|her|them)\b/i.test(resolved) && graphContext.latestPerson?.name) {
    resolved = resolved.replace(/\b(him|her|them)\b/gi, graphContext.latestPerson.name)
  }

  if (/그 사람|그분|그에게/.test(resolved) && graphContext.latestPerson?.name) {
    resolved = resolved.replace(/그 사람|그분/g, graphContext.latestPerson.name)
  }

  if (/\b(the email|that email)\b/i.test(resolved) && graphContext.latestEmailDraft) {
    resolved = `${resolved}\n\nLatest email draft subject: ${graphContext.latestEmailDraft.name}`
  }

  if (/그 이메일|방금 이메일/.test(resolved) && graphContext.latestEmailDraft) {
    resolved = `${resolved}\n\n최근 이메일 초안: ${graphContext.latestEmailDraft.name}`
  }

  if (lastAssistantTurn?.result && /continue|continue that|이어서|계속/.test(lower)) {
    resolved = `${resolved}\n\nPrevious result: ${truncate(lastAssistantTurn.result, 240)}`
  }

  if (
    activeProject &&
    /(this project|current project|the project|open the project|continue the project|이 프로젝트|현재 프로젝트|프로젝트 열어)/i.test(
      resolved,
    )
  ) {
    resolved = `${resolved}\n\nActive project: ${activeProject.name}${
      activeProject.path ? ` at ${activeProject.path}` : ''
    }`
  }

  return resolved
}

function formatPromptBlock({
  command,
  resolvedCommand,
  recentTurns,
  shortTerm,
  activeProject,
  longTerm,
}) {
  const lines = [
    '## Short-term session context',
    shortTerm?.lastUserCommand
      ? `- last user command: ${truncate(shortTerm.lastUserCommand, 160)}`
      : '- last user command: (none)',
    shortTerm?.lastAssistantSummary
      ? `- last assistant note: ${truncate(shortTerm.lastAssistantSummary, 160)}`
      : null,
    shortTerm?.lastResult
      ? `- last result: ${truncate(String(shortTerm.lastResult), 160)}`
      : null,
    '- recent turns:',
  ].filter(Boolean)

  if (!recentTurns.length) {
    lines.push('  - (no prior turns in this session)')
  } else {
    for (const turn of recentTurns.slice(-6)) {
      lines.push(`  - ${turn.role}: ${truncate(turn.content, 180)}`)
    }
  }

  lines.push('', '## Working project context')
  lines.push(formatWorkingProjectForPrompt(activeProject, { maxThreads: 3 }))

  lines.push('', '## Long-term personal memory')
  lines.push(formatLongTermMemoryForPrompt(longTerm))

  lines.push('', `Current user request: ${command}`)
  if (resolvedCommand !== command) {
    lines.push(`Resolved request: ${resolvedCommand}`)
  }

  return lines.join('\n')
}

function truncate(value, maxLength) {
  const text = String(value ?? '')

  if (text.length <= maxLength) {
    return text
  }

  return `${text.slice(0, maxLength - 3)}...`
}

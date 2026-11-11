import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { workspacePath } from './config.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const projectsPath = path.join(__dirname, 'memory', 'projects.json')

const DEFAULT_PROJECT_ID = 'proj_pendant'

const seedStore = () => {
  const now = new Date().toISOString()
  const repoPath = path.resolve(__dirname, '..')

  return {
    version: 1,
    activeProjectId: DEFAULT_PROJECT_ID,
    projects: [
      {
        id: DEFAULT_PROJECT_ID,
        name: 'AI Pendant Simulator',
        path: repoPath,
        workspacePath,
        summary:
          'Wearable AI pendant simulator with cloud relay, Mac local agent, voice, and LLM planning.',
        goals: [
          'Reliable voice interaction',
          'LLM-first Mac planning',
          'Smarter multi-tier context memory',
        ],
        openThreads: [],
        people: [],
        updatedAt: now,
      },
    ],
    updatedAt: now,
  }
}

export function projectsLocation() {
  ensureStore()
  return projectsPath
}

export function readProjectStore() {
  ensureStore()
  try {
    return JSON.parse(fs.readFileSync(projectsPath, 'utf8'))
  } catch {
    const seeded = seedStore()
    writeStore(seeded)
    return seeded
  }
}

export function listProjects() {
  return readProjectStore().projects ?? []
}

export function getActiveProject() {
  const store = readProjectStore()
  const projects = store.projects ?? []
  return (
    projects.find((project) => project.id === store.activeProjectId) ??
    projects[0] ??
    null
  )
}

export function setActiveProject(projectId) {
  const store = readProjectStore()
  const project = (store.projects ?? []).find((item) => item.id === projectId)
  if (!project) {
    throw new Error(`Unknown project: ${projectId}`)
  }
  store.activeProjectId = projectId
  store.updatedAt = new Date().toISOString()
  writeStore(store)
  return project
}

export function updateActiveProject(patch = {}) {
  const store = readProjectStore()
  const index = (store.projects ?? []).findIndex(
    (project) => project.id === store.activeProjectId,
  )
  if (index < 0) {
    throw new Error('No active project to update.')
  }

  const now = new Date().toISOString()
  const current = store.projects[index]
  store.projects[index] = {
    ...current,
    ...pickDefined(patch, [
      'name',
      'path',
      'workspacePath',
      'summary',
      'goals',
      'people',
    ]),
    openThreads: Array.isArray(patch.openThreads)
      ? patch.openThreads
      : current.openThreads,
    updatedAt: now,
  }
  store.updatedAt = now
  writeStore(store)
  return store.projects[index]
}

export function updateWorkingSummary(summary) {
  const text = String(summary || '').trim()
  if (!text) {
    return getActiveProject()
  }
  return updateActiveProject({ summary: text.slice(0, 400) })
}

export function upsertOpenThread({ id, title, status = 'active', lastNote = '' }) {
  const store = readProjectStore()
  const index = (store.projects ?? []).findIndex(
    (project) => project.id === store.activeProjectId,
  )
  if (index < 0) {
    throw new Error('No active project for open thread.')
  }

  const now = new Date().toISOString()
  const project = store.projects[index]
  const threads = Array.isArray(project.openThreads) ? [...project.openThreads] : []
  const threadId = id || `thread_${crypto.randomUUID().slice(0, 8)}`
  const existingIndex = threads.findIndex((thread) => thread.id === threadId)
  const nextThread = {
    id: threadId,
    title: String(title || 'Untitled thread').trim(),
    status,
    lastNote: String(lastNote || '').slice(0, 280),
    updatedAt: now,
  }

  if (existingIndex >= 0) {
    threads[existingIndex] = { ...threads[existingIndex], ...nextThread }
  } else {
    threads.unshift(nextThread)
  }

  store.projects[index] = {
    ...project,
    openThreads: threads.slice(0, 12),
    updatedAt: now,
  }
  store.updatedAt = now
  writeStore(store)
  return store.projects[index]
}

/**
 * Rule-based working-memory refresh after a successful Mac execution.
 * No extra LLM call — keep a short durable summary + optional open thread.
 */
export function refreshWorkingMemoryFromExecution({ command, actions, results }) {
  const active = getActiveProject()
  if (!active) {
    return null
  }

  const okCount = (results || []).filter((result) => result?.ok).length
  const labels = (actions || [])
    .slice(0, 3)
    .map((action) => action.label || action.type)
    .filter(Boolean)
  const summary = [
    `Last work: ${truncate(command, 120)}`,
    labels.length ? `Steps: ${labels.join(' → ')}` : null,
    `${okCount}/${(actions || []).length || 0} actions succeeded.`,
  ]
    .filter(Boolean)
    .join(' ')

  updateWorkingSummary(summary)

  const lower = String(command || '').toLowerCase()
  if (/david|gpu|resource|sail/.test(lower)) {
    upsertOpenThread({
      id: 'thread_gpu',
      title: 'SAIL computing / GPU resources',
      status: 'active',
      lastNote: truncate(command, 160),
    })
  } else if (/voice|speech|whisper|tts|microphone/.test(lower)) {
    upsertOpenThread({
      id: 'thread_voice',
      title: 'Voice interaction',
      status: 'active',
      lastNote: truncate(command, 160),
    })
  } else if (/email|draft|remind|note|project/.test(lower)) {
    upsertOpenThread({
      id: `thread_${Date.now().toString(36)}`,
      title: truncate(command, 60),
      status: 'active',
      lastNote: truncate(
        (results || []).map((result) => result.message).filter(Boolean).join(' · '),
        160,
      ),
    })
  }

  return getActiveProject()
}

export function formatWorkingProjectForPrompt(project, { maxThreads = 3 } = {}) {
  if (!project) {
    return '- (no active project)'
  }

  const lines = [
    `- name: ${project.name}`,
    project.path ? `- path: ${project.path}` : null,
    project.summary ? `- summary: ${truncate(project.summary, 280)}` : null,
  ].filter(Boolean)

  if (Array.isArray(project.goals) && project.goals.length) {
    lines.push(`- goals: ${project.goals.slice(0, 4).join('; ')}`)
  }

  if (Array.isArray(project.people) && project.people.length) {
    lines.push(`- people: ${project.people.join(', ')}`)
  }

  const threads = (project.openThreads || []).slice(0, maxThreads)
  if (threads.length) {
    lines.push('- open threads:')
    for (const thread of threads) {
      lines.push(
        `  - ${thread.title}${thread.status ? ` [${thread.status}]` : ''}${
          thread.lastNote ? `: ${truncate(thread.lastNote, 120)}` : ''
        }`,
      )
    }
  }

  return lines.join('\n')
}

function ensureStore() {
  const directory = path.dirname(projectsPath)
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true })
  }
  if (!fs.existsSync(projectsPath)) {
    fs.writeFileSync(projectsPath, JSON.stringify(seedStore(), null, 2))
  }
}

function writeStore(store) {
  const directory = path.dirname(projectsPath)
  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true })
  }
  fs.writeFileSync(projectsPath, JSON.stringify(store, null, 2))
}

function pickDefined(source, keys) {
  const out = {}
  for (const key of keys) {
    if (source[key] !== undefined) {
      out[key] = source[key]
    }
  }
  return out
}

function truncate(value, maxLength) {
  const text = String(value ?? '')
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}

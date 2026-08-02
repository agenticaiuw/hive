import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const graphPath = path.join(process.cwd(), 'local-agent', 'memory', 'context_graph.json')

const initialGraph = {
  version: 1,
  updatedAt: null,
  entities: [],
  relations: [],
}

export function contextGraphLocation() {
  ensureGraph()
  return graphPath
}

export function readContextGraph() {
  ensureGraph()

  try {
    return JSON.parse(fs.readFileSync(graphPath, 'utf8'))
  } catch {
    return { ...initialGraph }
  }
}

export function resetContextGraph() {
  const graph = {
    ...initialGraph,
    updatedAt: new Date().toISOString(),
  }

  writeGraph(graph)
  return graph
}

export function loadDemoContextGraph() {
  const now = new Date().toISOString()
  const graph = {
    version: 1,
    updatedAt: now,
    entities: [],
    relations: [],
  }
  const context = createGraphWriter(graph, now)

  const david = context.upsertEntity('Person', 'David')
  const gpu = context.upsertEntity('Resource', 'GPU resources')
  const project = context.upsertEntity('Project', 'AI Pendant Project')
  const emailDraft = context.addEntity(
    'EmailDraft',
    'Question about GPU resources',
    {
      to: 'David',
      subject: 'Question about GPU resources',
      body: 'Hi David,\n\nI wanted to ask about GPU resources for my project.\n\nBest,\nGeunwoo',
    },
  )
  const reminder = context.addEntity('Task', 'Follow up with David', {
    due: 'tomorrow morning',
  })
  const note = context.addEntity('File', 'meeting-notes.md', {
    path: path.join(os.homedir(), 'AI-Pendant-Workspace', 'meeting-notes.md'),
  })
  const mac = context.upsertEntity('Device', 'MacBook')
  const model = context.upsertEntity('Model', 'Rule-based Planner')
  const clipboard = context.upsertEntity('Tool', 'copy_to_clipboard')
  const gmail = context.upsertEntity('Tool', 'open_url:gmail')
  const action = context.addEntity('Action', 'Draft email and open Gmail', {
    command: 'Draft an email to David about GPU resources.',
    status: 'success',
  })

  context.addRelation(emailDraft.id, 'sent_to', david.id)
  context.addRelation(emailDraft.id, 'about', gpu.id)
  context.addRelation(gpu.id, 'related_to', project.id)
  context.addRelation(reminder.id, 'follows_up', emailDraft.id)
  context.addRelation(reminder.id, 'related_to', david.id)
  context.addRelation(reminder.id, 'stored_at', note.id)
  context.addRelation(action.id, 'created_file', emailDraft.id)
  context.addRelation(action.id, 'uses', clipboard.id)
  context.addRelation(action.id, 'uses', gmail.id)
  context.addRelation(action.id, 'uses', model.id)
  context.addRelation(action.id, 'executed_on', mac.id)

  writeGraph(graph)
  return graph
}

export function updateContextGraphFromExecution({ command, actions, results }) {
  const graph = readContextGraph()
  const now = new Date().toISOString()
  const context = createGraphWriter(graph, now)

  const mac = context.upsertEntity('Device', 'MacBook')
  const model = context.upsertEntity('Model', 'Rule-based Planner')
  const defaultProject = context.upsertEntity('Project', 'AI Pendant Project')

  actions.forEach((action, index) => {
    const result = results[index]

    if (!result?.ok) {
      return
    }

    const actionEntity = context.addEntity('Action', action.label ?? action.type, {
      command,
      actionType: action.type,
      status: result.status,
      result: result.message,
    })
    const tool = context.upsertEntity('Tool', action.type)
    context.addRelation(actionEntity.id, 'uses', tool.id)
    context.addRelation(actionEntity.id, 'executed_on', mac.id)
    context.addRelation(actionEntity.id, 'uses', model.id)

    if (action.type === 'copy_to_clipboard') {
      linkEmailDraftContext(context, action, actionEntity, defaultProject)
    }

    if (action.type === 'create_note') {
      linkNoteContext(context, action, actionEntity, result)
    }

    if (action.type === 'run_project') {
      context.addRelation(actionEntity.id, 'belongs_to_project', defaultProject.id)
    }

    if (action.type === 'open_url' && action.params?.url) {
      const resource = context.upsertEntity('Resource', action.params.url, {
        url: action.params.url,
      })
      context.addRelation(resource.id, 'available_through', tool.id)
    }
  })

  graph.updatedAt = now
  writeGraph(graph)
  return graph
}

export function getLatestContext() {
  const graph = readContextGraph()
  const latestEmailDraft = latestEntity(graph, 'EmailDraft')
  const latestPerson =
    latestRelatedEntity(graph, latestEmailDraft, 'sent_to', 'Person') ??
    latestEntity(graph, 'Person')
  const latestResource = latestRelatedEntity(
    graph,
    latestEmailDraft,
    'about',
    'Resource',
  )
  const latestFile = latestEntity(graph, 'File')
  const latestTask = latestEntity(graph, 'Task')

  return {
    graph,
    latestEmailDraft,
    latestPerson,
    latestResource,
    latestFile,
    latestTask,
  }
}

const LONG_TERM_TYPES = new Set([
  'Person',
  'EmailDraft',
  'Task',
  'File',
  'Project',
  'Note',
  'Resource',
])

const PROMPT_EXCLUDED_TYPES = new Set(['Action', 'Tool', 'Device', 'Model'])

const TYPE_PRIORITY = {
  Person: 8,
  EmailDraft: 7,
  Task: 6,
  File: 5,
  Project: 5,
  Note: 4,
  Resource: 3,
}

/**
 * Retrieve durable facts for planner prompts.
 * Excludes Action/Tool telemetry noise; ranks by type, importance, recency, and command overlap.
 */
export function retrieveLongTermMemory({
  command = '',
  projectId = null,
  limit = 8,
} = {}) {
  const graph = readContextGraph()
  const tokens = tokenize(command)
  const now = Date.now()

  const scored = graph.entities
    .filter((entity) => LONG_TERM_TYPES.has(entity.type))
    .filter((entity) => !PROMPT_EXCLUDED_TYPES.has(entity.type))
    .map((entity) => {
      const haystack = normalizeText(
        [
          entity.name,
          entity.attributes?.note,
          entity.attributes?.subject,
          entity.attributes?.to,
          entity.attributes?.path,
          entity.attributes?.body,
        ]
          .filter(Boolean)
          .join(' '),
      )

      let overlap = 0
      for (const token of tokens) {
        if (haystack.includes(token)) overlap += 1
      }

      const ageHours = Math.max(
        0,
        (now - new Date(entity.updatedAt || entity.createdAt || now).getTime()) /
          (1000 * 60 * 60),
      )
      const recency = Math.max(0, 6 - ageHours / 24)
      const importance = Number(entity.attributes?.importance)
      const importanceBoost = Number.isFinite(importance) ? importance * 4 : 0
      const projectBoost =
        projectId && entity.attributes?.projectId === projectId ? 3 : 0
      const typeBoost = TYPE_PRIORITY[entity.type] || 1

      return {
        entity,
        score: typeBoost + recency + overlap * 2.5 + importanceBoost + projectBoost,
        overlap,
      }
    })
    .sort((a, b) => b.score - a.score || b.overlap - a.overlap)

  // Always surface latest pointers even if keyword overlap is weak.
  const latest = getLatestContext()
  const forced = [
    latest.latestPerson,
    latest.latestEmailDraft,
    latest.latestFile,
    latest.latestTask,
  ].filter(Boolean)

  const selected = []
  const seen = new Set()
  const seenKeys = new Set()

  const pushEntity = (entity) => {
    if (!entity || seen.has(entity.id) || PROMPT_EXCLUDED_TYPES.has(entity.type)) {
      return false
    }
    const key = `${entity.type}:${normalizeName(entity.name)}`
    if (seenKeys.has(key)) {
      return false
    }
    selected.push(entity)
    seen.add(entity.id)
    seenKeys.add(key)
    return true
  }

  for (const entity of forced) {
    pushEntity(entity)
  }

  for (const item of scored) {
    if (selected.length >= limit) break
    pushEntity(item.entity)
  }

  return selected.slice(0, limit)
}

export function formatLongTermMemoryForPrompt(entities = []) {
  if (!entities.length) {
    return '- (no durable memory yet)'
  }

  return entities
    .map((entity) => {
      const note =
        entity.attributes?.note ||
        entity.attributes?.subject ||
        entity.attributes?.path ||
        ''
      return `- ${entity.type}: ${entity.name}${
        note ? ` — ${truncateText(String(note), 100)}` : ''
      }`
    })
    .join('\n')
}

function tokenize(command) {
  return new Set(
    normalizeText(command)
      .split(' ')
      .filter((token) => token.length > 2),
  )
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function truncateText(text, maxLength) {
  if (text.length <= maxLength) return text
  return `${text.slice(0, maxLength - 3)}...`
}

export function upsertContextEntity({ id, type, name, attributes = {} }) {
  const graph = readContextGraph()
  const now = new Date().toISOString()
  const entityType = String(type || 'Note').trim() || 'Note'
  const entityName = String(name || 'Untitled').trim() || 'Untitled'
  let entity = id ? graph.entities.find((item) => item.id === id) : null

  // Manual Ops adds are intentional long-term memory — boost importance.
  const nextAttributes =
    attributes && typeof attributes === 'object'
      ? {
          ...attributes,
          importance:
            attributes.importance ??
            (['Person', 'Note', 'Project', 'Task', 'File', 'EmailDraft'].includes(
              entityType,
            )
              ? 0.8
              : attributes.importance),
        }
      : {}

  if (entity) {
    entity.type = entityType
    entity.name = entityName
    entity.attributes = nextAttributes
    entity.updatedAt = now
  } else {
    entity = {
      id: crypto.randomUUID(),
      type: entityType,
      name: entityName,
      attributes: nextAttributes,
      createdAt: now,
      updatedAt: now,
    }
    graph.entities.push(entity)
  }

  graph.updatedAt = now
  writeGraph(graph)
  return { graph, entity }
}

export function deleteContextEntity(entityId) {
  const graph = readContextGraph()
  const before = graph.entities.length
  graph.entities = graph.entities.filter((entity) => entity.id !== entityId)
  graph.relations = graph.relations.filter(
    (relation) => relation.from !== entityId && relation.to !== entityId,
  )

  if (graph.entities.length === before) {
    return null
  }

  graph.updatedAt = new Date().toISOString()
  writeGraph(graph)
  return graph
}

export function addContextRelation({ from, type, to, attributes = {} }) {
  const graph = readContextGraph()
  const now = new Date().toISOString()
  const writer = createGraphWriter(graph, now)
  writer.addRelation(from, String(type || 'related_to'), to, attributes)
  graph.updatedAt = now
  writeGraph(graph)
  return graph
}

export function deleteContextRelation(relationId) {
  const graph = readContextGraph()
  const before = graph.relations.length
  graph.relations = graph.relations.filter((relation) => relation.id !== relationId)

  if (graph.relations.length === before) {
    return null
  }

  graph.updatedAt = new Date().toISOString()
  writeGraph(graph)
  return graph
}

function linkEmailDraftContext(context, action, actionEntity, defaultProject) {
  const draft = action.context?.emailDraft ?? extractEmailDraftFromText(action.params?.text)
  const emailDraft = context.addEntity('EmailDraft', draft.subject, {
    to: draft.to,
    subject: draft.subject,
    body: draft.body,
  })
  const person = context.upsertEntity('Person', draft.to)
  const resource = context.upsertEntity('Resource', draft.topic)

  context.addRelation(actionEntity.id, 'created_file', emailDraft.id)
  context.addRelation(emailDraft.id, 'sent_to', person.id)
  context.addRelation(emailDraft.id, 'about', resource.id)
  context.addRelation(resource.id, 'related_to', defaultProject.id)
}

function linkNoteContext(context, action, actionEntity, result) {
  const note = context.addEntity('File', action.params.filename, {
    path: extractPathFromMessage(result.message),
    contentPreview: action.params.content?.slice(0, 220),
  })
  context.addRelation(actionEntity.id, 'created_file', note.id)

  if (action.context?.task) {
    const task = context.addEntity('Task', action.context.task.title, {
      due: action.context.task.due,
    })
    context.addRelation(task.id, 'stored_at', note.id)

    if (action.context.task.followUpEmailDraftId) {
      context.addRelation(task.id, 'follows_up', action.context.task.followUpEmailDraftId)
    }

    if (action.context.task.personName) {
      const person = context.upsertEntity('Person', action.context.task.personName)
      context.addRelation(task.id, 'related_to', person.id)
    }
  }
}

function createGraphWriter(graph, now) {
  return {
    addEntity(type, name, attributes = {}) {
      const entity = {
        id: crypto.randomUUID(),
        type,
        name,
        attributes,
        createdAt: now,
        updatedAt: now,
      }
      graph.entities.push(entity)
      return entity
    },
    upsertEntity(type, name, attributes = {}) {
      const normalizedName = normalizeName(name)
      const existing = graph.entities.find(
        (entity) =>
          entity.type === type && normalizeName(entity.name) === normalizedName,
      )

      if (existing) {
        existing.attributes = { ...existing.attributes, ...attributes }
        existing.updatedAt = now
        return existing
      }

      return this.addEntity(type, name, attributes)
    },
    addRelation(from, type, to, attributes = {}) {
      const exists = graph.relations.some(
        (relation) =>
          relation.from === from && relation.type === type && relation.to === to,
      )

      if (exists) {
        return
      }

      graph.relations.push({
        id: crypto.randomUUID(),
        from,
        type,
        to,
        attributes,
        createdAt: now,
      })
    },
  }
}

function ensureGraph() {
  const directory = path.dirname(graphPath)

  if (!fs.existsSync(directory)) {
    fs.mkdirSync(directory, { recursive: true })
  }

  if (!fs.existsSync(graphPath)) {
    resetContextGraph()
  }
}

function writeGraph(graph) {
  fs.writeFileSync(graphPath, JSON.stringify(graph, null, 2))
}

function latestEntity(graph, type) {
  return graph.entities
    .filter((entity) => entity.type === type)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]
}

function latestRelatedEntity(graph, source, relationType, targetType) {
  if (!source) {
    return null
  }

  const relation = graph.relations
    .filter((item) => item.from === source.id && item.type === relationType)
    .sort((a, b) => new Date(b.createdAt) - new Date(a.createdAt))[0]

  if (!relation) {
    return null
  }

  return graph.entities.find(
    (entity) => entity.id === relation.to && entity.type === targetType,
  )
}

function extractEmailDraftFromText(text = '') {
  const to = text.match(/^Hi\s+([^,\n]+)/i)?.[1] ?? 'Unknown'
  const topic = text.match(/ask about\s+(.+?)\./i)?.[1] ?? 'unknown topic'

  return {
    to,
    topic,
    subject: `Question about ${topic}`,
    body: text,
  }
}

function extractPathFromMessage(message = '') {
  return message.replace(/^Created note\s+/, '')
}

function normalizeName(name) {
  return String(name ?? '').trim().toLowerCase()
}

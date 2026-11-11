import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  LOCAL_SESSION_SCHEMA_VERSION,
  mergeSessionState,
  readSessionDocument,
  restoreSessionState,
  writeSessionDocumentAtomic,
} from './sessionStore.js'

function withTemporaryStore(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'pendant-session-test-'))
  const filePath = path.join(directory, 'sessions.json')
  t.after(() => fs.rmSync(directory, { force: true, recursive: true }))
  return filePath
}

test('migrates the legacy array and rewrites it as an atomic versioned document', (t) => {
  const filePath = withTemporaryStore(t)
  fs.writeFileSync(
    filePath,
    JSON.stringify([
      {
        sessionId: 'legacy-1',
        title: 'Legacy',
        createdAt: '2026-08-02T10:00:00.000Z',
        updatedAt: '2026-08-02T10:00:00.000Z',
        turns: [],
      },
    ]),
  )
  const migrated = readSessionDocument({ filePath })
  assert.equal(migrated.schemaVersion, LOCAL_SESSION_SCHEMA_VERSION)
  assert.equal(migrated.sessions[0].sessionId, 'legacy-1')

  writeSessionDocumentAtomic(migrated, { filePath })
  const stored = JSON.parse(fs.readFileSync(filePath, 'utf8'))
  assert.equal(stored.schemaVersion, LOCAL_SESSION_SCHEMA_VERSION)
  assert.equal(fs.statSync(filePath).mode & 0o777, 0o600)
  assert.deepEqual(
    fs.readdirSync(path.dirname(filePath)).filter((name) => name.endsWith('.tmp')),
    [],
  )
})

test('restore seeds a fresh store while merge preserves disjoint device turns', (t) => {
  const filePath = withTemporaryStore(t)
  const remote = {
    accountId: 'single-owner',
    sourceDeviceId: 'ios',
    generatedAt: '2026-08-02T12:00:00.000Z',
    sessions: [
      {
        sessionId: 'session-1',
        title: 'Phone',
        createdAt: '2026-08-02T11:00:00.000Z',
        updatedAt: '2026-08-02T12:00:00.000Z',
        sourceDeviceId: 'ios',
        turns: [
          {
            id: 'turn-ios',
            role: 'user',
            content: 'from phone',
            createdAt: '2026-08-02T11:01:00.000Z',
            updatedAt: '2026-08-02T11:01:00.000Z',
            sourceDeviceId: 'ios',
          },
        ],
      },
    ],
    memory: {},
  }
  restoreSessionState(remote, { filePath })

  const mac = {
    ...remote,
    sourceDeviceId: 'mac',
    generatedAt: '2026-08-02T12:01:00.000Z',
    sessions: [
      {
        ...remote.sessions[0],
        title: 'Mac',
        updatedAt: '2026-08-02T12:01:00.000Z',
        sourceDeviceId: 'mac',
        turns: [
          {
            id: 'turn-mac',
            role: 'assistant',
            content: 'from mac',
            createdAt: '2026-08-02T11:02:00.000Z',
            updatedAt: '2026-08-02T11:02:00.000Z',
            sourceDeviceId: 'mac',
          },
        ],
      },
    ],
  }
  const result = mergeSessionState(mac, { filePath })
  assert.equal(result.sessions[0].title, 'Mac')
  assert.deepEqual(
    result.sessions[0].turns.map((turn) => turn.id),
    ['turn-ios', 'turn-mac'],
  )
})

test('cloud tombstones survive a stale local merge', (t) => {
  const filePath = withTemporaryStore(t)
  const deleted = {
    accountId: 'single-owner',
    sourceDeviceId: 'ios',
    generatedAt: '2026-08-02T13:00:00.000Z',
    sessions: [
      {
        sessionId: 'session-deleted',
        title: 'Deleted',
        createdAt: '2026-08-02T11:00:00.000Z',
        updatedAt: '2026-08-02T13:00:00.000Z',
        deletedAt: '2026-08-02T13:00:00.000Z',
        sourceDeviceId: 'ios',
        turns: [],
      },
    ],
    memory: {},
  }
  restoreSessionState(deleted, { filePath })
  const merged = mergeSessionState(
    {
      ...deleted,
      sourceDeviceId: 'mac',
      generatedAt: '2026-08-02T12:00:00.000Z',
      sessions: [
        {
          ...deleted.sessions[0],
          updatedAt: '2026-08-02T12:00:00.000Z',
          deletedAt: null,
          sourceDeviceId: 'mac',
        },
      ],
    },
    { filePath },
  )
  assert.equal(merged.sessions.length, 0)
  assert.equal(merged.state.sessions[0].deletedAt, '2026-08-02T13:00:00.000Z')
})

function cloudState(sessions, generatedAt = '2026-08-02T13:00:00.000Z') {
  return {
    accountId: 'single-owner',
    sourceDeviceId: 'ios',
    generatedAt,
    sessions,
    memory: {},
  }
}

function cloudSession(sessionId, { updatedAt, deletedAt = null }) {
  return {
    sessionId,
    title: sessionId,
    createdAt: '2026-08-02T11:00:00.000Z',
    updatedAt,
    deletedAt,
    sourceDeviceId: 'ios',
    turns: [],
  }
}

test('a session the sync window omits is kept, not deleted', (t) => {
  const filePath = withTemporaryStore(t)
  writeSessionDocumentAtomic(
    {
      schemaVersion: LOCAL_SESSION_SCHEMA_VERSION,
      updatedAt: '2026-08-02T12:00:00.000Z',
      sessions: [
        cloudSession('only-on-this-mac', { updatedAt: '2026-08-02T12:00:00.000Z' }),
      ],
    },
    { filePath },
  )

  restoreSessionState(
    cloudState([cloudSession('only-in-cloud', { updatedAt: '2026-08-02T13:00:00.000Z' })]),
    { filePath },
  )

  const stored = readSessionDocument({ filePath })
  const kept = stored.sessions.find(
    (session) => session.sessionId === 'only-on-this-mac',
  )
  assert.ok(kept)
  assert.equal(kept.deletedAt, null)
  assert.ok(
    stored.sessions.some((session) => session.sessionId === 'only-in-cloud'),
  )
})

test('an explicit tombstone still deletes the local session', (t) => {
  const filePath = withTemporaryStore(t)
  writeSessionDocumentAtomic(
    {
      schemaVersion: LOCAL_SESSION_SCHEMA_VERSION,
      updatedAt: '2026-08-02T12:00:00.000Z',
      sessions: [
        cloudSession('deleted-elsewhere', { updatedAt: '2026-08-02T12:00:00.000Z' }),
      ],
    },
    { filePath },
  )

  const result = restoreSessionState(
    cloudState([
      cloudSession('deleted-elsewhere', {
        updatedAt: '2026-08-02T13:00:00.000Z',
        deletedAt: '2026-08-02T13:00:00.000Z',
      }),
    ]),
    { filePath },
  )

  assert.equal(result.sessions.length, 0)
  assert.equal(
    readSessionDocument({ filePath }).sessions[0].deletedAt,
    '2026-08-02T13:00:00.000Z',
  )
})

test('a fresh store still restores the whole cloud document', (t) => {
  const filePath = withTemporaryStore(t)
  const result = restoreSessionState(
    cloudState([
      cloudSession('cloud-a', { updatedAt: '2026-08-02T13:00:00.000Z' }),
      cloudSession('cloud-b', { updatedAt: '2026-08-02T12:30:00.000Z' }),
    ]),
    { filePath },
  )

  assert.deepEqual(
    result.sessions.map((session) => session.sessionId),
    ['cloud-a', 'cloud-b'],
  )
  assert.equal(readSessionDocument({ filePath }).sessions.length, 2)
})

test('legacy protocol-only turns are tombstoned and never rendered', (t) => {
  const filePath = withTemporaryStore(t)
  fs.writeFileSync(
    filePath,
    JSON.stringify({
      schemaVersion: LOCAL_SESSION_SCHEMA_VERSION,
      updatedAt: '2026-08-02T10:00:00.000Z',
      sessions: [
        {
          sessionId: 'session-control-frame',
          title: 'Provider frame',
          createdAt: '2026-08-02T10:00:00.000Z',
          updatedAt: '2026-08-02T10:00:00.000Z',
          turns: [
            {
              id: 'turn-control-frame',
              role: 'assistant',
              content: '[DONE]',
              createdAt: '2026-08-02T10:00:00.000Z',
              updatedAt: '2026-08-02T10:00:00.000Z',
            },
          ],
        },
      ],
    }),
  )

  const migrated = readSessionDocument({ filePath })
  assert.equal(migrated.sessions[0].turns[0].content, '')
  assert.ok(migrated.sessions[0].turns[0].deletedAt)

  writeSessionDocumentAtomic(migrated, { filePath })
  assert.doesNotMatch(fs.readFileSync(filePath, 'utf8'), /\[DONE\]/)
})

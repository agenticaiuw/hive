import path from 'node:path'
import { readJsonWithRecovery, writeJsonAtomic } from './atomicJsonStore.js'
import { logPath } from './config.js'

const ARRAY_STORE = { validate: Array.isArray }

export function readLogs() {
  return readJsonWithRecovery(logPath, { fallback: [], ...ARRAY_STORE })
}

export function appendLog(entry) {
  const logs = readLogs()
  const nextLogs = [
    {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...entry,
    },
    ...logs,
  ].slice(0, 200)

  writeJsonAtomic(logPath, nextLogs, ARRAY_STORE)
  return nextLogs
}

export function logLocation() {
  return path.resolve(logPath)
}

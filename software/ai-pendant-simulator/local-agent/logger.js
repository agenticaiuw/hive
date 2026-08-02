import fs from 'node:fs'
import path from 'node:path'
import { logPath, workspacePath } from './config.js'

export function readLogs() {
  if (!fs.existsSync(logPath)) {
    return []
  }

  try {
    return JSON.parse(fs.readFileSync(logPath, 'utf8'))
  } catch {
    return []
  }
}

export function appendLog(entry) {
  if (!fs.existsSync(workspacePath)) {
    fs.mkdirSync(workspacePath, { recursive: true })
  }

  const logs = readLogs()
  const nextLogs = [
    {
      id: crypto.randomUUID(),
      createdAt: new Date().toISOString(),
      ...entry,
    },
    ...logs,
  ].slice(0, 200)

  fs.writeFileSync(logPath, JSON.stringify(nextLogs, null, 2))
  return nextLogs
}

export function logLocation() {
  return path.resolve(logPath)
}

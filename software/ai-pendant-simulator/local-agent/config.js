import path from 'node:path'
import os from 'node:os'
import { fileURLToPath } from 'node:url'
import '../../load-pendant-env.mjs'

const localAgentDirectory = path.dirname(fileURLToPath(import.meta.url))
const repositoryRoot = path.resolve(localAgentDirectory, '..')
const homeDirectory = os.homedir()

export const PORT = Number(process.env.MAC_AGENT_PORT || 8000)
export const AGENT_TOKEN = process.env.AGENT_TOKEN || ''

// Used only when FULL_CONTROL_MODE=false (legacy safe demo). Full control
// opens whatever appName the LLM returns — no product keyword table.
export const allowedUrls = {
  gmail: 'https://mail.google.com',
  calendar: 'https://calendar.google.com',
  drive: 'https://drive.google.com',
  github: 'https://github.com',
}

export const allowedApps = {
  chrome: 'Google Chrome',
  calendar: 'Calendar',
  finder: 'Finder',
  vscode: 'Visual Studio Code',
  code: 'Visual Studio Code',
}

export const workspacePath = path.resolve(
  process.env.PENDANT_WORKSPACE_PATH ||
    path.join(homeDirectory, 'AI-Pendant-Workspace'),
)
const configuredProjectPath = path.resolve(
  process.env.PENDANT_PROJECT_PATH || repositoryRoot,
)

export const allowedFolders = [
  configuredProjectPath,
  workspacePath,
  path.join(homeDirectory, 'Downloads'),
]

export const projectPaths = {
  'ai-pendant-simulator': configuredProjectPath,
}

export const logPath = path.join(workspacePath, 'mac-agent-activity-log.json')

export const safeFileExtensions = new Set(['.txt', '.md'])

// Full computer control: shell, files, Mail.app, keyboard automation, any app/URL.
// Set to false to restore the original whitelist-only safe demo mode.
export const FULL_CONTROL_MODE = process.env.FULL_CONTROL_MODE !== 'false'

export const SHELL_TIMEOUT_MS = Number(
  process.env.SHELL_TIMEOUT_MS || 120000,
)

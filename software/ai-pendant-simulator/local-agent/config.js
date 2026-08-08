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

/*
 * The wall-clock ceiling on one `run_shell` / `run_applescript` child.
 *
 * This is the only definition of it. computerControl.js used to carry its own
 * DEFAULT_SHELL_TIMEOUT_MS with the same number in it, which made this export a
 * knob that moved nothing: setting SHELL_TIMEOUT_MS in .env changed this
 * constant and not one command behaved differently. A config value that no
 * importer reads is worse than a missing one — it tells whoever reads the
 * config that the timeout is theirs to set.
 *
 * A non-numeric or non-positive value falls back rather than becoming NaN.
 * `timeout: NaN` disables the ceiling entirely, so a typo in .env would have
 * removed the limit while looking like it tightened it.
 */
const configuredShellTimeoutMs = Number(process.env.SHELL_TIMEOUT_MS)
export const SHELL_TIMEOUT_MS =
  Number.isFinite(configuredShellTimeoutMs) && configuredShellTimeoutMs > 0
    ? configuredShellTimeoutMs
    : 120_000

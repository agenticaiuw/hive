import fs from 'node:fs'
import path from 'node:path'
import { execFile, spawn } from 'node:child_process'
import { promisify } from 'node:util'
import { FULL_CONTROL_MODE, allowedApps, allowedUrls, projectPaths, workspacePath } from './config.js'
import { executeComputerAction } from './computerControl.js'
import {
  assertAllowedPath,
  ensureAllowedFolder,
  safeNotePath,
} from './security.js'

const execFileAsync = promisify(execFile)
const runningProjects = new Map()

export async function executeActions(actions) {
  const results = []

  for (const action of actions) {
    try {
      if (FULL_CONTROL_MODE) {
        results.push(await executeComputerAction(action))
      } else {
        results.push(await executeSafeAction(action))
      }
    } catch (error) {
      results.push({
        action,
        ok: false,
        status: isBlockedError(error) ? 'blocked' : 'failed',
        message: isBlockedError(error)
          ? `Blocked for safety: ${error.message}`
          : `Failed: ${error.message}`,
        reason: error.message,
      })
    }
  }

  return results
}

async function executeSafeAction(action) {
  if (action.type === 'open_url') {
    assertAllowedUrl(action.params.url)
    await execFileAsync('open', [action.params.url])
    return success(action, `Opened ${action.params.url}`)
  }

  if (action.type === 'open_app') {
    assertAllowedApp(action.params.appName)
    await execFileAsync('open', ['-a', action.params.appName])
    return success(action, `Opened ${action.params.appName}`)
  }

  if (action.type === 'open_folder') {
    const folderPath = assertAllowedPath(action.params.path)
    await execFileAsync('open', [folderPath])
    return success(action, `Opened folder ${folderPath}`)
  }

  if (action.type === 'create_note') {
    ensureAllowedFolder(workspacePath)
    const notePath = nextAvailableNotePath(
      safeNotePath(workspacePath, action.params.filename),
    )
    fs.writeFileSync(notePath, action.params.content, { flag: 'wx' })
    await execFileAsync('open', [notePath])
    return success(action, `Created note ${notePath}`)
  }

  if (action.type === 'copy_to_clipboard') {
    await writeClipboard(action.params.text)
    return success(action, 'Copied text to Mac clipboard')
  }

  if (action.type === 'run_project') {
    const projectPath = assertKnownProject(action.params.path)

    if (runningProjects.has(projectPath)) {
      return success(action, `Project is already running at ${projectPath}`)
    }

    const child = spawn('npm', ['run', 'dev', '--', '--host', '0.0.0.0'], {
      cwd: projectPath,
      detached: true,
      stdio: 'ignore',
    })
    child.unref()
    runningProjects.set(projectPath, child.pid)

    return success(action, `Started npm run dev in ${projectPath}`)
  }

  if (action.type === 'search_file') {
    const root = assertAllowedPath(action.params.root)
    const matches = searchFiles(root, action.params.query)
    return {
      action,
      ok: true,
      status: 'success',
      message: `Found ${matches.length} match${matches.length === 1 ? '' : 'es'}`,
      matches,
    }
  }

  throw new Error(`Unsupported action type: ${action.type}`)
}

function assertAllowedUrl(url) {
  const parsedUrl = new URL(url)

  if (!['https:', 'http:'].includes(parsedUrl.protocol)) {
    throw new Error('Only http/https URLs are allowed.')
  }

  if (!Object.values(allowedUrls).includes(url)) {
    throw new Error(`URL is not whitelisted: ${url}`)
  }
}

function assertAllowedApp(appName) {
  const allowed = Object.values(allowedApps).includes(appName)

  if (!allowed) {
    throw new Error(`App is not whitelisted: ${appName}`)
  }
}

function assertKnownProject(projectPath) {
  const resolvedPath = assertAllowedPath(projectPath)
  const knownProject = Object.values(projectPaths).some(
    (knownPath) => path.resolve(knownPath) === resolvedPath,
  )

  if (!knownProject) {
    throw new Error(`Project is not whitelisted: ${projectPath}`)
  }

  return resolvedPath
}

function writeClipboard(text) {
  return new Promise((resolve, reject) => {
    const child = spawn('pbcopy', [], { stdio: ['pipe', 'ignore', 'ignore'] })
    child.on('error', reject)
    child.on('close', (code) => {
      if (code === 0) {
        resolve()
      } else {
        reject(new Error('pbcopy failed.'))
      }
    })
    child.stdin.end(text)
  })
}

function searchFiles(root, query) {
  const tokens = query
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean)
  const matches = []
  const queue = [root]

  while (queue.length && matches.length < 25) {
    const currentPath = queue.shift()
    const entries = fs.readdirSync(currentPath, { withFileTypes: true })

    for (const entry of entries) {
      if (entry.name.startsWith('.')) {
        continue
      }

      const entryPath = path.join(currentPath, entry.name)

      if (entry.isDirectory()) {
        queue.push(entryPath)
      } else if (tokens.every((token) => entry.name.toLowerCase().includes(token))) {
        matches.push(entryPath)
      }

      if (matches.length >= 25) {
        break
      }
    }
  }

  return matches
}

function nextAvailableNotePath(notePath) {
  if (!fs.existsSync(notePath)) {
    return notePath
  }

  const extension = path.extname(notePath)
  const basePath = notePath.slice(0, -extension.length)

  for (let index = 2; index < 100; index += 1) {
    const candidatePath = `${basePath}-${index}${extension}`

    if (!fs.existsSync(candidatePath)) {
      return candidatePath
    }
  }

  throw new Error('Could not create a unique note filename.')
}

function success(action, message) {
  return {
    action,
    ok: true,
    status: 'success',
    message,
  }
}

function isBlockedError(error) {
  const message = String(error?.message ?? '')
  return [
    'not whitelisted',
    'Only http/https',
    'Only .txt and .md',
    'AGENT_TOKEN is not configured',
    'RELAY_API_KEY is not configured',
    'invalid pairing code',
    'invalid or missing agent token',
    'invalid or missing relay',
  ].some((phrase) => message.includes(phrase))
}

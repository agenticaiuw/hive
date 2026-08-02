import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { allowedFolders, safeFileExtensions, FULL_CONTROL_MODE } from './config.js'

export function resolveUserPath(targetPath) {
  const expanded = String(targetPath ?? '')
    .trim()
    .replace(/^~(?=$|\/)/, os.homedir())

  if (!expanded) {
    throw new Error('Path is required.')
  }

  return path.resolve(expanded)
}

export function assertAllowedPath(targetPath) {
  if (FULL_CONTROL_MODE) {
    return resolveUserPath(targetPath)
  }

  const resolvedPath = path.resolve(targetPath)
  const allowed = allowedFolders.some((folder) => {
    const resolvedFolder = path.resolve(folder)
    return (
      resolvedPath === resolvedFolder ||
      resolvedPath.startsWith(`${resolvedFolder}${path.sep}`)
    )
  })

  if (!allowed) {
    throw new Error(`Path is not whitelisted: ${targetPath}`)
  }

  return resolvedPath
}

export function ensureAllowedFolder(targetPath) {
  const resolvedPath = assertAllowedPath(targetPath)

  if (!fs.existsSync(resolvedPath)) {
    fs.mkdirSync(resolvedPath, { recursive: true })
  }

  return resolvedPath
}

export function safeNotePath(workspacePath, filename) {
  const cleanName = path.basename(filename)

  if (!FULL_CONTROL_MODE) {
    const extension = path.extname(cleanName).toLowerCase()

    if (!safeFileExtensions.has(extension)) {
      throw new Error('Only .txt and .md note files are allowed.')
    }
  }

  return assertAllowedPath(path.join(workspacePath, cleanName))
}

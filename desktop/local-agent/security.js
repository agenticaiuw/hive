import os from 'node:os'
import path from 'node:path'

export function resolveUserPath(targetPath) {
  const expanded = String(targetPath ?? '')
    .trim()
    .replace(/^~(?=$|\/)/, os.homedir())

  if (!expanded) {
    throw new Error('Path is required.')
  }

  return path.resolve(expanded)
}

import fs from 'node:fs'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import {
  setDisplayBrightness,
  setOutputMuted,
  setOutputVolume,
} from './systemControls.js'

const execFileAsync = promisify(execFile)

/**
 * Reverse reversible actions from a completed execute job.
 * Returns per-step undo results.
 */
export async function undoJobResults(job) {
  const results = Array.isArray(job?.result?.results)
    ? job.result.results
    : Array.isArray(job?.result?.sideResults)
      ? job.result.sideResults
      : []

  if (!results.length) {
    throw new Error('This job has no reversible action results.')
  }

  if (job.undoneAt) {
    throw new Error('This job was already undone.')
  }

  const undone = []
  // Reverse in reverse order so later overlays/files unwind first.
  for (const item of [...results].reverse()) {
    if (!item?.ok) continue
    const step = await undoOneResult(item)
    if (step) undone.push(step)
  }

  if (!undone.length) {
    throw new Error(
      'Nothing in this job can be undone (shell/keyboard/email/browser steps are not reversible).',
    )
  }

  return {
    ok: true,
    undone,
    summary: undone.map((step) => step.message).join(' '),
  }
}

export function describeUndoability(job) {
  const results = Array.isArray(job?.result?.results)
    ? job.result.results
    : Array.isArray(job?.result?.sideResults)
      ? job.result.sideResults
      : []

  if (job?.undoneAt) {
    return { canUndo: false, reason: 'Already undone' }
  }
  if (job?.status !== 'completed' && job?.status !== 'success') {
    return { canUndo: false, reason: 'Only completed work can be undone' }
  }

  const reversible = results.filter((item) => item?.ok && canUndoResult(item))
  if (!reversible.length) {
    return {
      canUndo: false,
      reason: 'No reversible steps in this job',
    }
  }
  return {
    canUndo: true,
    reason: `${reversible.length} reversible step${reversible.length === 1 ? '' : 's'}`,
    count: reversible.length,
  }
}

function canUndoResult(item) {
  const type = item?.action?.type
  switch (type) {
    case 'set_brightness':
      return Number.isFinite(Number(item.before))
    case 'set_volume':
      return Number.isFinite(Number(item.before?.percent ?? item.before))
    case 'set_mute':
      return typeof item.before?.muted === 'boolean' || typeof item.before === 'boolean'
    case 'show_screen_overlay':
      return Boolean(item.pid)
    case 'write_file':
    case 'create_note':
      return Boolean(item.path || item.action?.params?.path)
    case 'copy_path':
      return Boolean(item.action?.params?.to)
    case 'move_path':
      return Boolean(item.action?.params?.from && item.action?.params?.to)
    case 'open_app':
    case 'open_url':
    case 'open_path':
    case 'open_folder':
      return true
    default:
      return false
  }
}

async function undoOneResult(item) {
  const type = item?.action?.type
  if (!canUndoResult(item)) return null

  switch (type) {
    case 'set_brightness': {
      const before = Number(item.before)
      const restored = await setDisplayBrightness(before)
      return {
        type,
        message: `Restored brightness to ${restored.percent}%`,
        restored,
      }
    }
    case 'set_volume': {
      const before = Number(item.before?.percent ?? item.before)
      const restored = await setOutputVolume(before)
      return {
        type,
        message: `Restored volume to ${restored.percent}%`,
        restored,
      }
    }
    case 'set_mute': {
      const beforeMuted =
        typeof item.before?.muted === 'boolean'
          ? item.before.muted
          : Boolean(item.before)
      const restored = await setOutputMuted(beforeMuted)
      return {
        type,
        message: beforeMuted ? 'Restored mute' : 'Restored unmute',
        restored,
      }
    }
    case 'show_screen_overlay': {
      try {
        process.kill(Number(item.pid), 'SIGTERM')
      } catch {
        // already gone
      }
      return {
        type,
        message: `Dismissed screen overlay (pid ${item.pid})`,
      }
    }
    case 'write_file':
    case 'create_note': {
      const filePath = item.path || item.action?.params?.path
      if (filePath && fs.existsSync(filePath)) {
        fs.unlinkSync(filePath)
      }
      return {
        type,
        message: `Removed created file ${filePath}`,
        path: filePath,
      }
    }
    case 'copy_path': {
      const to = item.action?.params?.to
      if (to && fs.existsSync(to)) {
        fs.rmSync(to, { recursive: true, force: true })
      }
      return {
        type,
        message: `Removed copied path ${to}`,
        path: to,
      }
    }
    case 'move_path': {
      const from = item.action?.params?.from
      const to = item.action?.params?.to
      if (to && from && fs.existsSync(to) && !fs.existsSync(from)) {
        fs.renameSync(to, from)
      }
      return {
        type,
        message: `Moved ${to} back to ${from}`,
        from,
        to,
      }
    }
    case 'open_app':
    case 'open_url':
    case 'open_path':
    case 'open_folder': {
      // Best-effort: hide frontmost if we opened something; cannot always close the right app.
      try {
        await execFileAsync('osascript', [
          '-e',
          'tell application "System Events" to keystroke "w" using command down',
        ])
      } catch {
        // ignore
      }
      return {
        type,
        message: 'Sent ⌘W to close the front window (best-effort undo for open)',
      }
    }
    default:
      return null
  }
}

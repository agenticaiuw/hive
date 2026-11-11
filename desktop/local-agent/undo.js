import fs from 'node:fs'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { describeReversibility } from './actionReceipts.js'
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
      // The owner asking "why not?" used to get nothing back. Receipts know.
      irreversible: irreversibleSteps(results),
    }
  }
  return {
    canUndo: true,
    reason: `${reversible.length} reversible step${reversible.length === 1 ? '' : 's'}`,
    count: reversible.length,
    steps: reversible.map((item) => ({
      type: item?.action?.type ?? 'unknown',
      actionId: item?.receipt?.actionId ?? null,
      by: describeReversibility(item).mechanism,
    })),
    irreversible: irreversibleSteps(results),
  }
}

function irreversibleSteps(results) {
  return results
    .filter((item) => item?.ok && !canUndoResult(item))
    .map((item) => ({
      type: item?.action?.type ?? 'unknown',
      actionId: item?.receipt?.actionId ?? null,
      reason: describeReversibility(item).reason,
    }))
}

/*
 * Reversibility lives in actionReceipts.js so the receipt the owner reads and
 * the decision undo makes cannot disagree. Jobs recorded before receipts
 * existed carry no receipt; describeReversibility falls back to the raw result
 * fields for those, which is why old history stays undoable.
 */
function canUndoResult(item) {
  return describeReversibility(item).reversible
}

async function undoOneResult(item) {
  const type = item?.action?.type
  if (!canUndoResult(item)) return null

  // A snapshot beats every heuristic below: the executor copied the file aside
  // before touching it, so put the exact bytes back. copy_path/move_path are
  // excluded because their primary undo has to run first — the snapshot is
  // only their clobbered destination, and it is restored after the move back.
  if (type === 'write_file' || type === 'create_note' || type === 'delete_path') {
    const restored = restoreFromSnapshot(item)
    if (restored) return restored
  }

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
      // Only ever delete a file this job CREATED. Deleting a file the job
      // merely overwrote destroys content the agent never wrote — that was the
      // old behaviour, and it read as a successful undo.
      if (item.receipt && item.receipt.preexisting?.existed) {
        return null
      }
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
      const replaced = restoreFromSnapshot(item)
      return {
        type,
        message: replaced
          ? `Removed copied path ${to} and restored what it replaced`
          : `Removed copied path ${to}`,
        path: to,
        restoredSnapshot: replaced?.snapshot ?? null,
      }
    }
    case 'move_path': {
      const from = item.action?.params?.from
      const to = item.action?.params?.to
      if (to && from && fs.existsSync(to) && !fs.existsSync(from)) {
        fs.renameSync(to, from)
      }
      const replaced = restoreFromSnapshot(item)
      return {
        type,
        message: replaced
          ? `Moved ${to} back to ${from} and restored what it replaced`
          : `Moved ${to} back to ${from}`,
        from,
        to,
        restoredSnapshot: replaced?.snapshot ?? null,
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

/**
 * Put back the bytes the executor copied aside before it overwrote or deleted
 * a file. This is what makes delete_path — previously permanent — undoable.
 */
function restoreFromSnapshot(item) {
  const snapshot = item?.receipt?.snapshot
  if (!snapshot?.at || !snapshot?.of) return null
  if (!fs.existsSync(snapshot.at)) return null

  fs.mkdirSync(path.dirname(snapshot.of), { recursive: true })
  fs.copyFileSync(snapshot.at, snapshot.of)

  return {
    type: item?.action?.type,
    message: `Restored ${snapshot.of} from its pre-action snapshot`,
    path: snapshot.of,
    snapshot: snapshot.at,
  }
}

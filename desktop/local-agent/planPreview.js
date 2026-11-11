import fs from 'node:fs'

import {
  SNAPSHOT_MAX_BYTES,
  actionIdFor,
  buildActionReceipt,
  staticReversibility,
} from './actionReceipts.js'
import { resolveUserPath } from './security.js'

/*
 * "First return a concise preview with the affected apps/files/URLs, then
 * execute." — the owner, four times.
 *
 * A preview is the receipt an action has not written yet.
 *
 * That is the whole idea, and it is why this file imports from
 * actionReceipts.js instead of re-deriving anything. The receipt already knows
 * how to answer "what did this touch" for all 76 action types; asking the same
 * function the same question *before* dispatch is what a preview is. Two
 * separate tables would drift, and the day they drifted the preview would
 * describe one thing and the receipt would record another — which is worse than
 * having no preview at all, because the owner would have read it.
 *
 * NOTHING HERE CAN REFUSE AN ACTION. There is no verdict field, no allow list,
 * no token, no confirmation. foreseeAction() is a pure description; calling it
 * is optional and skipping it changes nothing about what /execute will do. The
 * owner asked to be able to look before a bulk move, not to be stopped at one.
 * If you are reading this while adding a `blocked` or `requiresApproval` key,
 * you are building the thing that was rejected three times — don't.
 */

/* Below this, a plan is small enough to just read the actions. The number is a
 * hint for callers that want to *offer* a preview, never a threshold that
 * changes what runs. */
export const BULK_FILE_THRESHOLD = 5

/* Operations where "let me look first" is worth the round trip: they touch many
 * files at once, or they are the kind of thing you cannot walk back by hand. */
const FILE_MUTATIONS = new Set(['move_path', 'copy_path', 'delete_path', 'write_file'])
const HARD_TO_REVERSE = new Set(['delete_path'])

/**
 * What a plan would touch, and what of it could be taken back.
 *
 * `bulk` is advice for the caller — "this one is worth showing" — not a rule.
 * Everything else in the returned object is description.
 */
export function foreseePlan(actions, { title = '', now = Date.now() } = {}) {
  const list = Array.isArray(actions) ? actions : []
  const steps = list.map((action) => foreseeAction(action))

  const affected = { apps: [], paths: [], urls: [], other: [] }
  for (const step of steps) {
    for (const touch of step.touches) {
      const bucket =
        touch.kind === 'app'
          ? affected.apps
          : touch.kind === 'path'
            ? affected.paths
            : touch.kind === 'url'
              ? affected.urls
              : affected.other
      if (!bucket.includes(touch.ref)) bucket.push(touch.ref)
    }
  }

  const writes = steps.filter((step) => step.effect === 'write')
  const irreversible = writes.filter((step) => step.reversible === false)

  return {
    title: String(title || '') || null,
    createdAt: new Date(now).toISOString(),
    stepCount: steps.length,
    steps,
    affected,
    writeCount: writes.length,
    irreversible: irreversible.map((step) => ({
      actionId: step.actionId,
      type: step.type,
      reason: step.irreversibleReason,
    })),
    bulk: isBulkFileOperation(list),
    spoken: spokenSummary(steps, affected),
  }
}

/**
 * True when a plan is the kind the owner asked to see first: a pile of file
 * mutations, or a delete. Advisory. Callers that ignore it are correct to.
 */
export function isBulkFileOperation(actions) {
  const list = Array.isArray(actions) ? actions : []
  const fileMutations = list.filter((action) => FILE_MUTATIONS.has(String(action?.type ?? '')))
  if (list.some((action) => HARD_TO_REVERSE.has(String(action?.type ?? '')))) return true
  return fileMutations.length >= BULK_FILE_THRESHOLD
}

/**
 * One action, described as if it had already run.
 *
 * `touches` comes from buildActionReceipt with no result — the same derivation
 * the real receipt will use a moment later, so the preview line and the history
 * line say the same words about the same action id.
 */
export function foreseeAction(action) {
  const type = String(action?.type ?? '')
  /* A receipt with nothing to report on yet. We keep `touched` and `effect`,
   * which depend only on the action, and drop the fields that are lies until
   * the thing has actually run (receiptId, ok, status, timings). */
  const provisional = buildActionReceipt({
    action,
    result: null,
    before: null,
    startedAt: null,
    finishedAt: null,
  })

  const undo = foreseeUndo(type, action)

  return {
    actionId: actionIdFor(action),
    type,
    label: String(action?.label ?? '') || null,
    effect: provisional.effect,
    touches: provisional.touched,
    /* true / false where the filesystem can already answer, null where it
     * genuinely depends on how the action goes. */
    reversible: undo.reversible,
    reversedBy: undo.reversedBy,
    irreversibleReason: undo.irreversibleReason,
    /* The type-level answer, kept alongside the resolved one so a caller can
     * see that e.g. delete_path is only ever *conditionally* reversible. */
    typeReversibility: staticReversibility(type).reversible,
  }
}

/*
 * Resolve "conditional" into a real answer while the file is still there.
 *
 * This is the one thing a preview knows that a type table cannot: whether the
 * bytes about to be destroyed will fit in the undo vault. actionReceipts.js
 * makes exactly this call after the fact, against the same limit.
 */
function foreseeUndo(type, action) {
  const stat = (raw) => {
    if (!raw) return null
    try {
      return { path: resolveUserPath(raw), stats: fs.statSync(resolveUserPath(raw)) }
    } catch {
      return null
    }
  }

  if (type === 'write_file' || type === 'create_note') {
    const target = stat(action?.params?.path)
    if (!target) return yes('delete the file this creates')
    return snapshotVerdict(target, 'restore the snapshot taken just before the write', 'overwrite')
  }

  if (type === 'delete_path') {
    const target = stat(action?.params?.path)
    if (!target) {
      return no('There is nothing at that path right now, so the step would fail rather than delete')
    }
    return snapshotVerdict(target, 'restore the snapshot taken just before the delete', 'delete')
  }

  if (type === 'move_path') {
    const destination = stat(action?.params?.to)
    if (!destination) return yes('move it back')
    /* renameSync replaces the destination silently. Say so here rather than let
     * the owner find out from a receipt. */
    return snapshotVerdict(
      destination,
      'move it back, then restore what it replaced from the snapshot',
      'overwrite',
    )
  }

  if (type === 'copy_path') {
    const destination = stat(action?.params?.to)
    if (!destination) return yes('remove the copy')
    return snapshotVerdict(destination, 'remove the copy and restore what it replaced', 'overwrite')
  }

  const fallback = staticReversibility(type)
  if (fallback.reversible === 'always') return yes(fallback.reversedBy)
  if (fallback.reversible === 'not-needed') {
    return { reversible: true, reversedBy: null, irreversibleReason: null }
  }
  if (fallback.reversible === 'never') {
    return no(`${type || 'This action'} leaves no reversible trace`)
  }
  /* Conditional on state this preview cannot see (a volume level, a pid). */
  return { reversible: null, reversedBy: fallback.reversedBy, irreversibleReason: null }
}

function snapshotVerdict(target, mechanism, verb) {
  if (target.stats.isDirectory()) {
    return no(
      `Would ${verb} the folder ${target.path}; only single files are snapshotted, so this could not be undone`,
    )
  }
  if (target.stats.size > SNAPSHOT_MAX_BYTES) {
    return no(
      `Would ${verb} ${target.path} (${Math.round(target.stats.size / 1024 / 1024)} MB), which is too large to snapshot, so this could not be undone`,
    )
  }
  return yes(mechanism)
}

const yes = (reversedBy) => ({ reversible: true, reversedBy, irreversibleReason: null })
const no = (irreversibleReason) => ({ reversible: false, reversedBy: null, irreversibleReason })

function spokenSummary(steps, affected) {
  if (!steps.length) return 'Nothing to do.'
  const writes = steps.filter((step) => step.effect === 'write').length
  const parts = []
  if (writes) parts.push(`${writes} change${writes === 1 ? '' : 's'}`)
  const reads = steps.length - writes
  if (reads) parts.push(`${reads} read${reads === 1 ? '' : 's'}`)
  const where = [
    affected.paths.length && `${affected.paths.length} path${affected.paths.length === 1 ? '' : 's'}`,
    affected.apps.length && `${affected.apps.length} app${affected.apps.length === 1 ? '' : 's'}`,
    affected.urls.length && `${affected.urls.length} URL${affected.urls.length === 1 ? '' : 's'}`,
  ].filter(Boolean)
  return `${parts.join(', ')}${where.length ? ` across ${where.join(', ')}` : ''}.`
}

/** The preview as the owner would hear or read it. */
export function formatPlanPreview(preview) {
  const lines = [
    preview.title ? `${preview.title}` : 'Plan preview',
    `${preview.stepCount} step${preview.stepCount === 1 ? '' : 's'}, ${preview.writeCount} of them changing something. Nothing has run.`,
    '',
  ]

  for (const step of preview.steps) {
    const marker = step.effect === 'read' ? '·' : step.reversible === false ? '!' : '→'
    lines.push(`${marker} ${step.label || step.type}`)
    for (const touch of step.touches.slice(0, 4)) {
      lines.push(`      ${touch.kind}: ${touch.ref}`)
    }
    if (step.reversible === false && step.irreversibleReason) {
      lines.push(`      cannot be undone: ${step.irreversibleReason}`)
    } else if (step.effect === 'write' && step.reversedBy) {
      lines.push(`      undo: ${step.reversedBy}`)
    }
  }

  if (preview.irreversible.length) {
    lines.push(
      '',
      `${preview.irreversible.length} step${preview.irreversible.length === 1 ? '' : 's'} could not be taken back afterwards.`,
    )
  }

  return lines.join('\n')
}

import crypto from 'node:crypto'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { usableCapsuleIds } from './evidenceCapsules.js'

/*
 * The follow-up a change implies, written down and not done.
 *
 * Every proposal that asked for page watching put the same clause in the same
 * sentence: "prepare drafts for any follow-up forms but do not submit". That
 * clause is the deliverable, not a caveat on it. The owner is asking for a
 * watcher that reacts — and for the reaction to stop one step short, every
 * time, without them having to have thought in advance about which step.
 *
 * So this module cannot submit a form. It also cannot fill one, cannot open a
 * tab, and cannot reach the browser at all: THERE IS NO IMPORT OF browserPage,
 * browserBridge, formFill OR computerControl IN THIS FILE, and there is a test
 * that reads this source and fails if one appears. That is a stronger promise
 * than a flag defaulting to false, because it cannot be switched off by a
 * caller, a config value, or a future parameter someone adds in a hurry.
 *
 * What a draft is, precisely: a durable record naming the form, the values, and
 * the observed change that motivated it, with the evidence ids that change
 * stood on. What a draft is NOT: an intention the system holds. Nothing here
 * ticks, retries, or expires into action. A draft that is never approved is a
 * draft forever.
 *
 * The handoff is deliberately data rather than a call. draftHandoff() returns
 * the arguments a caller would pass to formFill.fillForm and returns them to
 * the CALLER — it does not invoke it. The owner's approval therefore has to
 * cross a process boundary (an HTTP route they hit) rather than a function
 * boundary inside a scheduler that runs while they are asleep. And formFill
 * itself then stops before the submit button, so there are two brakes in
 * series: the owner approving the draft, and the fill stopping one click short.
 */

const STORE_PATH = path.join(workspacePath, '.pendant-page-watch-drafts.json')

const MAX_DRAFTS = 100
const MAX_VALUE_CHARS = 400

const isValidStore = (value) => value && Array.isArray(value.drafts)

function load(filePath = STORE_PATH) {
  ensureJsonStore(filePath, { drafts: [] }, { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: { drafts: [] },
    validate: isValidStore,
  })
}

function save(store, filePath = STORE_PATH) {
  writeJsonAtomic(filePath, store)
}

/**
 * The follow-up definition a watch carries, if it carries one.
 *
 * Validated at watch-creation time rather than at fire time. A watch whose
 * follow-up is malformed should fail in front of the owner while they are
 * setting it up, not silently produce nothing at 4am on the one day the status
 * finally changed.
 */
export function normalizeFollowUp(input) {
  if (!input || typeof input !== 'object') return null

  const url = String(input.url ?? '').trim()
  if (!url) throw new Error('A follow-up needs the url of the form to prepare.')
  try {
    const protocol = new URL(url).protocol
    if (!['http:', 'https:'].includes(protocol)) throw new Error('bad protocol')
  } catch {
    throw new Error(`A follow-up needs an http(s) form url, not: ${url}`)
  }

  const rawValues = input.values && typeof input.values === 'object' ? input.values : {}
  const values = {}
  for (const [key, value] of Object.entries(rawValues)) {
    values[String(key).slice(0, 80)] = String(value ?? '').slice(0, MAX_VALUE_CHARS)
  }

  /*
   * Which fields moving should raise this draft. Absent means any meaningful
   * change does — the common case, since most follow-ups are "if this order
   * changes, get ready to ask about it".
   */
  const onFields = Array.isArray(input.onFields)
    ? input.onFields.map((name) => String(name).slice(0, 60)).filter(Boolean)
    : null

  return {
    name: String(input.name ?? url).slice(0, 120),
    url,
    values,
    onFields: onFields?.length ? onFields : null,
    note: String(input.note ?? '').slice(0, 400) || null,
  }
}

/**
 * Fill {{field}} placeholders from the reading that triggered the draft.
 *
 * The point is a draft that is actually usable: "my order {{order_number}} was
 * meant to arrive {{eta}}" becomes a sentence with the real values in it, taken
 * from the same reading the change was detected in. An unresolved placeholder
 * is left visibly unresolved rather than blanked, because a draft with a silent
 * hole in it is one the owner approves without noticing.
 */
export function resolvePlaceholders(text, values = {}) {
  return String(text ?? '').replace(/\{\{\s*([\w.-]+)\s*\}\}/g, (whole, key) => {
    const value = values?.[key]
    return value === null || value === undefined || value === '' ? whole : String(value)
  })
}

/**
 * Write down what could be sent, having sent nothing.
 *
 * Returns the draft. The `status` is 'draft' and there is no code path in this
 * module that sets it to anything a machine could act on.
 */
export function prepareDraft(
  { watchId, watchName, followUp, change, values = {}, capsuleIds = [], url = null, now = Date.now() },
  { filePath = STORE_PATH } = {},
) {
  const definition = normalizeFollowUp(followUp)
  if (!definition) return null

  /* A follow-up scoped to particular fields stays quiet for the others: an
   * order page whose price moved does not need the "where is my delivery"
   * draft that its status moving does. */
  const changedFields = (change?.changes ?? []).map((entry) => entry.field)
  if (definition.onFields && !definition.onFields.some((name) => changedFields.includes(name))) {
    return null
  }

  const resolved = {}
  for (const [key, value] of Object.entries(definition.values)) {
    resolved[key] = resolvePlaceholders(value, values)
  }

  const draft = {
    id: `dft_${crypto.randomUUID()}`,
    watchId,
    watchName: watchName ?? null,
    name: resolvePlaceholders(definition.name, values),
    formUrl: definition.url,
    values: resolved,
    note: definition.note ? resolvePlaceholders(definition.note, values) : null,
    /* Why this exists. A draft the owner cannot connect to a change is one they
     * have to reconstruct before they dare approve it. */
    because: {
      watchedUrl: url,
      changes: (change?.changes ?? []).map((entry) => ({
        field: entry.field,
        before: entry.before ?? null,
        after: entry.after ?? null,
      })),
      summary: change?.summary ?? null,
      at: new Date(now).toISOString(),
    },
    capsuleIds: [...new Set((capsuleIds ?? []).filter(Boolean))],
    status: 'draft',
    createdAt: new Date(now).toISOString(),
    approvedAt: null,
    unresolved: Object.entries(resolved)
      .filter(([, value]) => /\{\{/.test(String(value)))
      .map(([key]) => key),
  }

  const store = load(filePath)
  store.drafts.unshift(draft)
  store.drafts = store.drafts.slice(0, MAX_DRAFTS)
  save(store, filePath)
  return draft
}

export function listDrafts(
  { watchId = null, status = null, now = Date.now() } = {},
  { filePath = STORE_PATH } = {},
) {
  return load(filePath)
    .drafts.filter((draft) => (watchId ? draft.watchId === watchId : true))
    .filter((draft) => (status ? draft.status === status : true))
    .map((draft) => withEvidenceState(draft, now))
}

export function getDraft(id, { filePath = STORE_PATH, now = Date.now() } = {}) {
  const draft = load(filePath).drafts.find((entry) => entry.id === id)
  return draft ? withEvidenceState(draft, now) : null
}

/*
 * A draft whose evidence the owner revoked keeps its row and loses its reason.
 *
 * Same treatment page-watch reports get, for the same reason: dropping it would
 * make a revocation look like the follow-up was never prepared, and showing the
 * reading would make "forget that page" mean nothing. The values stay — the
 * owner typed those, they are not evidence — but the change that justified them
 * is withheld, and the draft says so, because approving a follow-up whose
 * justification you can no longer see is the thing to make hard.
 */
function withEvidenceState(draft, now) {
  const { withheld } = usableCapsuleIds(draft.capsuleIds ?? [], { now })
  if (!withheld.length) return draft
  return {
    ...draft,
    because: {
      ...draft.because,
      changes: [],
      summary: 'The reading this draft was prepared from is no longer available.',
    },
    evidenceWithheld: withheld,
  }
}

export function discardDraft(id, { filePath = STORE_PATH } = {}) {
  const store = load(filePath)
  const before = store.drafts.length
  store.drafts = store.drafts.filter((draft) => draft.id !== id)
  if (store.drafts.length === before) return false
  save(store, filePath)
  return true
}

/**
 * What the owner would hand to the form filler, if they chose to.
 *
 * Returns arguments. Calls nothing. The separation is the point: this module
 * can describe a fill it is incapable of performing, so the only way one
 * happens is a caller outside this file deciding to, with the owner present.
 */
export function draftHandoff(id, { filePath = STORE_PATH } = {}) {
  const draft = getDraft(id, { filePath })
  if (!draft) return null

  return {
    draftId: draft.id,
    /* The shape formFill.fillForm takes. Passed back, not passed on. */
    fillForm: {
      url: draft.formUrl,
      values: draft.values,
      label: draft.name,
    },
    submitted: false,
    note: 'Nothing has been sent. Filling this still stops before the submit control; see formFill.js.',
    unresolved: draft.unresolved ?? [],
  }
}

/**
 * Record that the owner said yes. Still sends nothing.
 *
 * Approval is stored so the audit trail shows a human in the loop, and so a
 * draft cannot be quietly approved twice. It does not trigger the fill; the
 * caller does that with the handoff, in front of the owner.
 */
export function approveDraft(id, { filePath = STORE_PATH, now = Date.now() } = {}) {
  const store = load(filePath)
  const draft = store.drafts.find((entry) => entry.id === id)
  if (!draft) return null
  if (draft.status === 'approved') return { ...draft, alreadyApproved: true }

  draft.status = 'approved'
  draft.approvedAt = new Date(now).toISOString()
  save(store, filePath)
  return draft
}

export const pageWatchDraftsLocation = () => STORE_PATH

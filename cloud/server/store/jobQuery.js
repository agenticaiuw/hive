/*
 * Shared job-query semantics so the D1 store and the in-memory development
 * store cannot drift. Pagination is keyset based on (created_at, job_id)
 * descending: a plain timestamp cursor would silently skip a run whenever two
 * rows land in the same millisecond.
 */

export const JOB_LIST_MAX_LIMIT = 100
export const JOB_SEARCH_MAX_LENGTH = 120

export function normalizeJobListLimit(limit, fallback = 40) {
  return Math.min(Math.max(Number(limit) || fallback, 1), JOB_LIST_MAX_LIMIT)
}

/**
 * Accepts either `{ createdAt, jobId }` or a bare ISO timestamp. Returns null
 * for anything unparseable so a malformed cursor degrades to "first page"
 * rather than to "no results".
 */
export function normalizeJobCursor(before) {
  if (!before) {
    return null
  }

  const createdAt = String(
    typeof before === 'string' ? before : before.createdAt || '',
  ).trim()
  if (!createdAt || Number.isNaN(new Date(createdAt).getTime())) {
    return null
  }

  const jobId = String(
    typeof before === 'string' ? '' : before.jobId || '',
  ).trim()

  // U+FFFF sorts after every legal job id, so an id-less cursor means
  // "everything strictly older than this timestamp".
  return { createdAt, jobId: jobId || '￿' }
}

export function normalizeJobSearch(search) {
  return String(search ?? '')
    .trim()
    .slice(0, JOB_SEARCH_MAX_LENGTH)
    .toLowerCase()
}

/** Fields a history search looks at: the transcript and the spoken reply. */
export function jobSearchHaystack(job) {
  return [job?.command, job?.transcript, job?.result?.response]
    .map((field) => String(field ?? '').toLowerCase())
    .join('\n')
}

export function jobMatchesSearch(job, search) {
  const needle = normalizeJobSearch(search)
  return !needle || jobSearchHaystack(job).includes(needle)
}

export function jobIsBeforeCursor(job, cursor) {
  if (!cursor) {
    return true
  }
  const createdAt = String(job?.createdAt || '')
  if (createdAt < cursor.createdAt) {
    return true
  }
  return createdAt === cursor.createdAt && String(job?.jobId || '') < cursor.jobId
}

export function compareJobsNewestFirst(left, right) {
  const byCreatedAt = String(right?.createdAt || '').localeCompare(
    String(left?.createdAt || ''),
  )
  if (byCreatedAt !== 0) {
    return byCreatedAt
  }
  return String(right?.jobId || '').localeCompare(String(left?.jobId || ''))
}

/** Escape LIKE wildcards; the caller must pair this with `ESCAPE '\'`. */
export function likePatternForSearch(search) {
  const needle = normalizeJobSearch(search).replace(/[\\%_]/g, '\\$&')
  return `%${needle}%`
}

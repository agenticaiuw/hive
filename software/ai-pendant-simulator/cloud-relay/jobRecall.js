/**
 * "I asked you to handle that on my Mac — what's the status?"
 *
 * The owner can start Mac work by voice, but until now there was no spoken way
 * to ask what became of it: the answer lived in the dashboard, in relay job
 * records nobody reads aloud, or nowhere. This resolves a vague spoken
 * reference against the relay's recent jobs and produces ONE short sentence.
 *
 * Two rules run through every function here.
 *
 * 1. The sentence must be speakable. Everything is budgeted in characters, not
 *    fields: a spoken answer that runs past ~180 characters has stopped being
 *    an answer. SPOKEN_MAX_CHARS matches the clip bridge.js already applies to
 *    its own failure speech.
 *
 * 2. Absence of evidence is never success. voiceRunForCapture in jobs.js used
 *    to hardcode 'done' for a run that produced nothing, and the dashboard
 *    looked healthy while the pendant played silence. So a terminal job with no
 *    result, or with `executed: false`, reports as NOT done — never as done.
 */

/* How many recent relay jobs a reference is resolved against. The store keeps
 * far more; this is the window in which "that" can plausibly mean something. */
export const RECALL_JOB_LIMIT = 25

/* A plan job sits queued until the Mac bridge long-poll claims it, which
 * normally takes well under a second. Past this, the honest answer is that the
 * Mac never picked it up — not that it is "in progress". */
export const STALE_QUEUE_MS = 60_000

/* Same window voiceRunForJob uses for a stuck transcription: past it, the
 * upload failed rather than "still working". */
export const STALE_TRANSCRIBE_MS = 90_000

/* With no content words to match on, "that" can only mean something recent.
 * Beyond this a bare deictic is a guess, and a confidently wrong "your Mac
 * task is done" is worse than admitting the reference did not resolve. */
export const NO_CONTENT_WINDOW_MS = 30 * 60_000

export const SPOKEN_MAX_CHARS = 180
const LABEL_MAX_CHARS = 60
const REASON_MAX_CHARS = 90

/* Statuses the relay assigns before the Mac has been handed the work. */
const PRE_DISPATCH_STATUSES = new Set([
  'received',
  'transcribing',
  'transcribed',
  'queued',
])
/* The bridge finishes a plan job as plan_ready; the pendant download moves it
 * to completed. Both mean "the Mac is done with it" — which is not the same as
 * "it worked", hence the result checks in describeJobOutcome. */
const TERMINAL_OK_STATUSES = new Set(['plan_ready', 'completed'])

/*
 * historyLabelFromState falls back to this string when the model emitted no
 * transcript, no action label and no spoken reply. Speaking it back would tell
 * the owner they had said the words "voice command".
 */
const FILLER_COMMAND = 'voice command'

/**
 * The short name to speak for a job. Prefers what the owner said, then what the
 * Mac was told to do, then what the agent said back.
 */
export function jobLabel(job) {
  const command = String(job?.command ?? '').trim()
  if (command && command.toLowerCase() !== FILLER_COMMAND && hasWords(command)) {
    return clipLabel(command)
  }

  for (const action of actionsOf(job)) {
    const label = String(action?.label || action?.type || '').trim()
    if (label) return clipLabel(label.replace(/_/g, ' '))
  }

  const spoken = String(
    job?.result?.response || job?.plannerHint?.response || '',
  ).trim()
  if (spoken) return clipLabel(spoken)

  return 'your last Mac task'
}

/**
 * What actually happened, stated honestly.
 *
 * `state` is the whole product: everything downstream (the spoken line, the
 * model's own framing) reads it rather than re-deriving from job.status, so
 * there is exactly one place that decides whether something worked.
 */
export function describeJobOutcome(job, { now = Date.now() } = {}) {
  const status = String(job?.status ?? '').trim()
  const result = job?.result && typeof job.result === 'object' ? job.result : null
  const ageMs = elapsed(job?.updatedAt || job?.createdAt, now)
  const totalMs = elapsed(job?.createdAt, now)

  const base = { relayStatus: status || null, ageMs, totalMs }

  if (status === 'cancelled') {
    return { ...base, state: 'cancelled', reason: null }
  }

  if (status === 'failed') {
    return {
      ...base,
      state: 'failed',
      reason: shortReason(
        job?.error || result?.executionError || result?.response,
      ),
    }
  }

  if (status === 'transcribing' && ageMs > STALE_TRANSCRIBE_MS) {
    return {
      ...base,
      state: 'failed',
      reason: 'the recording never finished transcribing',
    }
  }

  if (PRE_DISPATCH_STATUSES.has(status)) {
    return {
      ...base,
      state: 'queued',
      stalled: totalMs > STALE_QUEUE_MS,
      reason: null,
    }
  }

  /* An approval gate is a real, non-terminal state. Reporting it as "running"
   * would leave the owner waiting on a Mac that is waiting on them. */
  const blocked = Array.isArray(result?.awaitingApproval)
    ? result.awaitingApproval.length > 0
    : Boolean(result?.awaitingApproval)
  if (blocked) {
    return { ...base, state: 'awaiting_approval', reason: null }
  }

  if (status === 'processing') {
    return {
      ...base,
      state: 'running',
      /* The bridge posts a partial result the moment the action lands, before
       * speech is rendered. The action is genuinely done at that point. */
      actionsDone: result?.phase === 'executed' || result?.executed === true,
      reason: null,
    }
  }

  if (TERMINAL_OK_STATUSES.has(status)) {
    if (!result) {
      /* The voiceRunForCapture bug, in its general form: the job reached a
       * terminal status but nothing came back to show for it. */
      return {
        ...base,
        state: 'unknown',
        reason: 'your Mac closed it out without reporting what it did',
      }
    }
    if (result.executed === false) {
      return {
        ...base,
        state: 'failed',
        reason: shortReason(
          result.executionError || job?.error || result.response,
        ),
      }
    }
    return { ...base, state: 'done', reason: null }
  }

  return {
    ...base,
    state: 'unknown',
    reason: status ? `it is sitting in ${status}` : 'the relay has no status for it',
  }
}

/**
 * Resolve a vague spoken reference against recent jobs.
 *
 * The heuristic, in the order it decides:
 *
 *   1. An explicit jobId wins outright.
 *   2. Only jobs the owner actually asked for are candidates — `plan` jobs.
 *      agent_proxy is dashboard plumbing and audio_capture is a reply the
 *      model spoke without touching the Mac; neither is "that thing I asked
 *      you to handle on my Mac".
 *   3. Deictic words are stripped before scoring. "that", "the thing I asked
 *      earlier" tokenize to NOTHING, which is correct: they carry no evidence,
 *      and letting them match text would rank by coincidence and call it
 *      relevance.
 *   4. Content overlap dominates (x10) over recency, so one real word beats
 *      any amount of "but it is newer".
 *   5. Recency only breaks ties, and an unfinished job breaks them further —
 *      "what's the status" is usually asked about something not yet resolved.
 *   6. Recency is a fallback ONLY for a reference that carried no content. If
 *      the owner named something ("the Photoshop export") and nothing matches,
 *      that resolves to nothing — answering about whatever ran most recently
 *      would be a confident answer to a different question.
 *   7. With zero content words, candidates older than NO_CONTENT_WINDOW_MS are
 *      dropped rather than guessed at.
 *   8. When the top two are close and neither matched on content, the result is
 *      flagged `ambiguous`. Nothing is refused: the spoken answer always NAMES
 *      the task it is reporting on, so a wrong pick is correctable in the next
 *      breath instead of silently believed.
 */
export function resolveJobReference({
  jobs = [],
  reference = '',
  jobId = null,
  excludeJobIds = [],
  now = Date.now(),
} = {}) {
  const excluded = new Set(
    (Array.isArray(excludeJobIds) ? excludeJobIds : []).filter(Boolean),
  )
  const candidates = (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job && job.type === 'plan' && !excluded.has(job.jobId))
    .sort(newestFirst)

  const wantedId = String(jobId ?? '').trim()
  if (wantedId) {
    const exact = candidates.find((job) => job.jobId === wantedId)
    if (exact) {
      return { job: exact, how: 'explicit-id', ambiguous: false, alternatives: [] }
    }
    return {
      job: null,
      how: 'explicit-id-missing',
      ambiguous: false,
      alternatives: [],
      candidateCount: candidates.length,
    }
  }

  const wanted = tokenize(reference)
  const scored = candidates
    .map((job, rank) => {
      const overlap = countOverlap(searchableText(job), wanted)
      const age = elapsed(job.createdAt, now)
      const unfinished = !isTerminal(job)
      return {
        job,
        overlap,
        age,
        score: overlap * 10 + Math.max(0, 5 - rank) + (unfinished ? 1.5 : 0),
      }
    })
    .filter(
      (entry) => entry.overlap > 0 || entry.age <= NO_CONTENT_WINDOW_MS,
    )
    .sort((left, right) => right.score - left.score || left.age - right.age)

  if (!scored.length) {
    return {
      job: null,
      how: wanted.size ? 'no-match' : 'nothing-recent',
      ambiguous: false,
      alternatives: [],
      candidateCount: candidates.length,
    }
  }

  const [top, next] = scored
  if (wanted.size && top.overlap === 0) {
    /* The owner named something and nothing here is it. Recency is only ever a
     * fallback for a reference that gave us nothing to go on. */
    return {
      job: null,
      how: 'no-match',
      ambiguous: false,
      alternatives: [],
      candidateCount: candidates.length,
    }
  }

  return {
    job: top.job,
    how: top.overlap > 0 ? 'content-match' : 'most-recent',
    matchedWords: top.overlap,
    ambiguous: Boolean(
      next && top.overlap === 0 && top.score - next.score < 2,
    ),
    alternatives: scored.slice(1, 3).map((entry) => ({
      jobId: entry.job.jobId,
      label: jobLabel(entry.job),
    })),
    candidateCount: candidates.length,
  }
}

/**
 * One sentence, out loud. It always names the task, because a status the owner
 * cannot tie to a request is not an answer — and because naming it is what
 * makes a mis-resolved reference correctable in the next turn.
 */
export function speakJobStatus(job, outcome) {
  const label = jobLabel(job)
  const ago = agoPhrase(outcome.ageMs)

  switch (outcome.state) {
    case 'done':
      return clipSpoken(`${label} — done${ago ? `, ${ago}` : ''}.`)
    case 'failed':
      return clipSpoken(
        `${label} failed${outcome.reason ? `: ${outcome.reason}` : ''}.${
          ago ? ` That was ${ago}.` : ''
        }`,
      )
    case 'running':
      return clipSpoken(
        outcome.actionsDone
          ? `${label} ran on your Mac and is just finishing up.`
          : `${label} is still running on your Mac — ${durationPhrase(
              outcome.totalMs,
            )} so far.`,
      )
    case 'queued':
      return clipSpoken(
        outcome.stalled
          ? `${label} has been waiting ${durationPhrase(
              outcome.totalMs,
            )} — your Mac hasn't picked it up.`
          : `${label} is queued; your Mac hasn't started it yet.`,
      )
    case 'awaiting_approval':
      return clipSpoken(`${label} is waiting for your approval on the dashboard.`)
    case 'cancelled':
      return clipSpoken(`${label} was cancelled${ago ? ` ${ago}` : ''}.`)
    default:
      return clipSpoken(
        `I can't tell you ${label} worked — ${
          outcome.reason || 'nothing came back for it'
        }.`,
      )
  }
}

/**
 * The whole tool payload: a spoken sentence plus the few structured fields the
 * model needs to frame it. Deliberately small — this is read aloud, and the
 * model does not need the job record to say one sentence.
 */
export function recallJobStatus({
  jobs = [],
  reference = '',
  jobId = null,
  excludeJobIds = [],
  now = Date.now(),
} = {}) {
  const match = resolveJobReference({ jobs, reference, jobId, excludeJobIds, now })

  if (!match.job) {
    const recent = recentDigest(jobs, excludeJobIds, now)
    /* Naming the most recent task turns a dead end into something the owner can
     * correct in one word, which is the whole reason not to guess in the first
     * place. */
    const lastOne = recent.length ? ` The last one was ${recent[0].label}.` : ''
    const spoken =
      match.how === 'explicit-id-missing'
        ? "I don't have that task on record any more."
        : match.how === 'no-match'
          ? `I don't have a Mac task that matches${
              String(reference || '').trim() ? ` "${clipLabel(reference)}"` : ''
            }.${lastOne}`
          : match.candidateCount
            ? `Nothing you asked me to run is recent enough for me to be sure what you mean.${lastOne}`
            : "You haven't asked me to run anything on your Mac."
    return {
      ok: true,
      found: false,
      resolvedBy: match.how,
      spoken: clipSpoken(spoken),
      recent,
    }
  }

  const outcome = describeJobOutcome(match.job, { now })
  return {
    ok: true,
    found: true,
    jobId: match.job.jobId,
    label: jobLabel(match.job),
    state: outcome.state,
    relayStatus: outcome.relayStatus,
    reason: outcome.reason ?? null,
    resolvedBy: match.how,
    /* Said out loud so the model can offer the alternative instead of
     * pretending the pick was certain. */
    ambiguous: match.ambiguous,
    alternatives: match.alternatives,
    spoken: speakJobStatus(match.job, outcome),
  }
}

/* ------------------------------------------------------------------------ */

function recentDigest(jobs, excludeJobIds, now) {
  const excluded = new Set(
    (Array.isArray(excludeJobIds) ? excludeJobIds : []).filter(Boolean),
  )
  return (Array.isArray(jobs) ? jobs : [])
    .filter((job) => job?.type === 'plan' && !excluded.has(job.jobId))
    .sort(newestFirst)
    .slice(0, 3)
    .map((job) => ({
      jobId: job.jobId,
      label: jobLabel(job),
      state: describeJobOutcome(job, { now }).state,
    }))
}

function actionsOf(job) {
  if (Array.isArray(job?.actions) && job.actions.length) return job.actions
  if (Array.isArray(job?.plannerHint?.actions)) return job.plannerHint.actions
  return []
}

function searchableText(job) {
  const parts = [
    job?.command,
    job?.result?.response,
    job?.plannerHint?.response,
  ]
  for (const action of actionsOf(job)) {
    parts.push(action?.label, action?.type)
    const params = action?.params
    if (params && typeof params === 'object') {
      for (const value of Object.values(params)) {
        if (typeof value === 'string' || typeof value === 'number') {
          parts.push(String(value))
        }
      }
    }
  }
  return normalizeText(parts.filter(Boolean).join(' '))
}

/*
 * Deictics and status-question scaffolding. Everything here is what the owner
 * says INSTEAD of naming the task, so it must contribute zero evidence —
 * scoring on "that" or "status" would rank every job identically and dress the
 * result up as a match. The English list extends the one in
 * local-agent/contextProjection.js with the vocabulary specific to asking
 * about work already handed over.
 */
const REFERENCE_STOPWORDS = new Set([
  'the', 'and', 'for', 'you', 'your', 'that', 'this', 'those', 'these', 'with',
  'from', 'what', 'whats', 'when', 'where', 'which', 'who', 'how', 'why', 'can',
  'could', 'would', 'should', 'are', 'was', 'were', 'has', 'have', 'had', 'did',
  'does', 'doing', 'done', 'please', 'just', 'also', 'about', 'into', 'out',
  'off', 'not', 'any', 'all', 'some', 'more', 'get', 'got', 'let', 'ask',
  'asked', 'asking', 'tell', 'told', 'say', 'said', 'thing', 'stuff', 'task',
  'job', 'run', 'running', 'ran', 'handle', 'handled', 'status', 'update',
  'earlier', 'before', 'ago', 'yet', 'still', 'now', 'last', 'previous',
  'recent', 'recently', 'mac', 'macbook', 'laptop', 'computer', 'machine',
  'work', 'working', 'finish', 'finished', 'happen', 'happened', 'happening',
  'ever', 'him', 'her', 'them', 'it', 'its', 'one', 'my', 'me',
  /* Korean deictics, matching conversationContext.js. */
  '그거', '이거', '저거', '방금', '아까', '그것', '상태',
])

function tokenize(text) {
  return new Set(
    normalizeText(text)
      .split(' ')
      .filter((token) => token.length > 2 && !REFERENCE_STOPWORDS.has(token)),
  )
}

function countOverlap(haystack, wanted) {
  let overlap = 0
  for (const token of wanted) {
    if (haystack.includes(token)) overlap += 1
  }
  return overlap
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function hasWords(value) {
  return /[\p{L}\p{N}]/u.test(String(value ?? ''))
}

function isTerminal(job) {
  const status = String(job?.status ?? '')
  return (
    TERMINAL_OK_STATUSES.has(status) ||
    status === 'failed' ||
    status === 'cancelled'
  )
}

function newestFirst(left, right) {
  return timeOf(right.createdAt) - timeOf(left.createdAt)
}

function timeOf(value) {
  const parsed = Date.parse(value ?? '')
  return Number.isFinite(parsed) ? parsed : 0
}

function elapsed(from, now) {
  const at = timeOf(from)
  return at ? Math.max(0, now - at) : 0
}

function clipLabel(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.!?]+$/, '')
  if (text.length <= LABEL_MAX_CHARS) return text
  const cut = text.slice(0, LABEL_MAX_CHARS)
  const boundary = cut.lastIndexOf(' ')
  return `${boundary > 20 ? cut.slice(0, boundary) : cut}…`
}

function shortReason(value) {
  const text = String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .replace(/[.]+$/, '')
  if (!text) return null
  return text.length <= REASON_MAX_CHARS
    ? text
    : `${text.slice(0, REASON_MAX_CHARS).trimEnd()}…`
}

function clipSpoken(value) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= SPOKEN_MAX_CHARS
    ? text
    : `${text.slice(0, SPOKEN_MAX_CHARS - 1).trimEnd()}…`
}

/* Spoken time, not printed time: "3 minutes ago", never "2026-08-07T…". */
function agoPhrase(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return null
  const seconds = Math.round(ms / 1000)
  if (seconds < 20) return 'just now'
  if (seconds < 90) return 'a minute ago'
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes ago`
  const hours = Math.round(minutes / 60)
  if (hours < 24) return hours === 1 ? 'about an hour ago' : `about ${hours} hours ago`
  const days = Math.round(hours / 24)
  return days === 1 ? 'yesterday' : `${days} days ago`
}

function durationPhrase(ms) {
  const seconds = Math.max(1, Math.round((Number(ms) || 0) / 1000))
  if (seconds < 90) return `${seconds} seconds`
  const minutes = Math.round(seconds / 60)
  if (minutes < 60) return `${minutes} minutes`
  const hours = Math.round(minutes / 60)
  return hours === 1 ? 'an hour' : `${hours} hours`
}

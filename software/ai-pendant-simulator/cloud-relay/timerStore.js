/*
 * Timers, held by the relay.
 *
 * WHAT IS HONESTLY TRUE HERE, stated before anything else, because a timer
 * that lies about when it will fire is worse than no timer:
 *
 *   - The expiry lives in a store row, not on the device. The nRF9160 has no
 *     local clock-driven alarm today, so a pendant out of coverage does not
 *     beep. Phase 2 firmware mirrors the expiry down and the chime becomes
 *     local; this store stays the source of truth either way.
 *   - A timer chimes down an OPEN socket: the converse session sweeps this
 *     store every few seconds and speaks into the live conversation.
 *   - With no conversation open at expiry the chime QUEUES and speaks on the
 *     next press, exactly like an approval readback queues. That is not a
 *     consolation prize, it is the same delivery contract the rest of this
 *     relay already runs on: the firmware discards every frame that arrives
 *     while no conversation is active, so "the next press" is the earliest
 *     moment any relay-composed sound can reach the owner's ear at all.
 *
 * IT ADDS NO STORE METHODS. Everything is the existing saveState/getState pair
 * that approvals ride (cloud-relay/approvalStore.js), on both the D1 and the
 * memory implementation, so no schema moves and no Durable Object is needed.
 *
 * A timer set by the knob and a timer set by voice are ONE system: both land
 * here, both sweep here, both chime through the same path. The owner should
 * never be able to tell which hand set it.
 */

const WRITER = 'timer-store'

/* Index cap. A worn device sets a handful of timers a day; anything past this
 * is either a test harness or a bug, and neither deserves an unbounded row. */
const INDEX_LIMIT = 32
/* How long a settled timer stays in the index. Long enough that "cancel my
 * timer" right after it fires still finds something to talk about, short
 * enough that the row never becomes a log. */
const SETTLED_RETENTION_MS = 6 * 60 * 60 * 1000

export const MAX_TIMER_MS = 24 * 60 * 60 * 1000

export function timerStateKey(timerId) {
  return `pendant.timer.${String(timerId ?? '').trim()}`
}

export function timerIndexKey(deviceId) {
  return `pendant.timers.${String(deviceId ?? '').trim() || 'nrf9160-pendant'}`
}

/* ------------------------------------------------------------ pure model */

/**
 * "10 minutes", "1 hour", "1 hour 30 minutes".
 *
 * Spoken, not printed: no "01:30:00" anywhere, because a duration read out as
 * digits is a duration the owner has to translate.
 */
export function describeDuration(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  /* Under a minute stays in seconds. Rounding 30 s up to "1 minute" is the
   * kind of small lie that makes an owner stop trusting the readback. */
  if (total < 60_000) {
    const seconds = Math.max(1, Math.round(total / 1000))
    return `${seconds} second${seconds === 1 ? '' : 's'}`
  }
  const minutes = Math.round(total / 60_000)
  const hours = Math.floor(minutes / 60)
  const rest = minutes % 60
  if (!hours) return `${minutes} minute${minutes === 1 ? '' : 's'}`
  const hourPart = `${hours} hour${hours === 1 ? '' : 's'}`
  if (!rest) return hourPart
  return `${hourPart} ${rest} minute${rest === 1 ? '' : 's'}`
}

/**
 * The same duration used as an ADJECTIVE: "a 10 minute timer", not "a 10
 * minutes timer".
 *
 * English drops the plural on an attributive measure, and a text-to-speech
 * voice reads exactly what it is given — "ten minutes timer started" is the
 * sort of thing that makes a device sound broken in one syllable. Kept as a
 * second function rather than a flag because the two forms disagree on more
 * than an "s": "1 hour 30 minutes left" is right, and "1 hour 30 minute timer"
 * is not, so an hour-and-a-half timer is a "90 minute timer" here.
 */
export function describeDurationShort(ms) {
  const total = Math.max(0, Math.round(Number(ms) || 0))
  if (total < 60_000) return `${Math.max(1, Math.round(total / 1000))} second`
  const minutes = Math.round(total / 60_000)
  if (minutes % 60 === 0) return `${minutes / 60} hour`
  return `${minutes} minute`
}

export function createTimerRecord({
  deviceId,
  durationMs,
  minutes = null,
  setBy = 'knob',
  label = null,
  now = Date.now(),
  timerId = null,
} = {}) {
  /*
   * `durationMs ?? minutes`, spelled out. The tempting one-liner is
   * `Number.isFinite(Number(durationMs))` — and Number(null) is 0, which is
   * finite, so every caller that passed only `minutes` would get a zero-length
   * timer and a thrown "positive duration". Caught by the store test, which is
   * the only reason it is not in production.
   */
  const ms =
    durationMs != null && Number.isFinite(Number(durationMs))
      ? Math.round(Number(durationMs))
      : Math.round(Number(minutes) * 60_000)
  if (!Number.isFinite(ms) || ms <= 0) {
    throw new Error('A timer needs a positive duration.')
  }
  if (ms > MAX_TIMER_MS) {
    /* Refused rather than clamped. A silently shortened timer is the kind of
     * helpfulness that gets somebody's laundry left in the machine. */
    throw new Error('A pendant timer cannot be longer than 24 hours.')
  }
  return {
    timerId: String(timerId || `tmr_${Math.random().toString(16).slice(2, 10)}${now.toString(36)}`),
    deviceId: String(deviceId ?? '').trim() || 'nrf9160-pendant',
    durationMs: ms,
    label: label ? String(label).slice(0, 80) : null,
    setBy: setBy === 'voice' ? 'voice' : 'knob',
    state: 'running',
    startedAt: new Date(now).toISOString(),
    expiresAt: new Date(now + ms).toISOString(),
    claimedAt: null,
    spokenAt: null,
    cancelledAt: null,
  }
}

function expiryMs(record) {
  const at = Date.parse(record?.expiresAt ?? '')
  return Number.isFinite(at) ? at : Number.POSITIVE_INFINITY
}

export function timerIsRunning(record, now = Date.now()) {
  return record?.state === 'running' && expiryMs(record) > now
}

export function timerIsDue(record, now = Date.now()) {
  return record?.state === 'running' && expiryMs(record) <= now
}

export function remainingMs(record, now = Date.now()) {
  return Math.max(0, expiryMs(record) - now)
}

export function selectRunningTimers(records = [], now = Date.now()) {
  return records.filter((record) => timerIsRunning(record, now)).sort((a, b) => expiryMs(a) - expiryMs(b))
}

export function selectDueTimers(records = [], now = Date.now()) {
  return records.filter((record) => timerIsDue(record, now)).sort((a, b) => expiryMs(a) - expiryMs(b))
}

/* --------------------------------------------------------- what is said */

export function timerStartedSpeech(record) {
  const duration = describeDurationShort(record?.durationMs)
  return record?.label
    ? `${duration} timer set for ${record.label}.`
    : `${duration} timer started.`
}

/** The line the chime carries. Names the duration, because by the time it
 * fires the owner has usually forgotten which timer this was. */
export function timerDoneSpeech(record) {
  const duration = describeDurationShort(record?.durationMs)
  return record?.label
    ? `Your ${duration} timer for ${record.label} is done.`
    : `Your ${duration} timer is done.`
}

/** An overdue chime spoken at the next press instead of at expiry says so.
 * Pretending it just fired would be a small lie the owner can catch. */
export function timerOverdueSpeech(record, now = Date.now()) {
  const late = Math.max(0, now - expiryMs(record))
  if (late < 90_000) return timerDoneSpeech(record)
  return `${timerDoneSpeech(record)} That was ${describeDuration(late)} ago.`
}

export function timerRemainingSpeech(records = [], now = Date.now()) {
  const running = selectRunningTimers(records, now)
  if (!running.length) return 'You have no timers running.'
  if (running.length === 1) {
    return `${describeDuration(remainingMs(running[0], now))} left on your ${describeDurationShort(running[0].durationMs)} timer.`
  }
  const parts = running
    .slice(0, 3)
    .map(
      (record) =>
        `${describeDuration(remainingMs(record, now))} on the ${describeDurationShort(record.durationMs)} one`,
    )
  return `You have ${running.length} timers running: ${parts.join(', ')}.`
}

export function timerCancelledSpeech(cancelled = []) {
  if (!cancelled.length) return 'You have no timers running.'
  if (cancelled.length === 1) return `Cancelled your ${describeDurationShort(cancelled[0].durationMs)} timer.`
  return `Cancelled ${cancelled.length} timers.`
}

/* ------------------------------------------------------------ the index */

/**
 * Fold one record into a device's index, bounded.
 *
 * TWO EVICTION RULES, and the order between them is the whole design:
 *
 *  1. Settled entries age out after SETTLED_RETENTION_MS. They exist only so
 *     "cancel my timer" moments after it fired still has something to talk
 *     about; past that they are a log, and this is not a log.
 *  2. When the cap bites, SETTLED entries go before running ones, and among
 *     running ones the SOONEST to fire is kept. A row is a bound and a bound
 *     eventually costs something; what it must never cost is the timer the
 *     owner is standing there waiting for.
 *
 * The claim "a running timer is never dropped" would be nicer and is not true
 * — 33 concurrent timers is a bug or an attack, and an unbounded row is how
 * that bug becomes the store's problem. So it is stated as it actually is.
 */
export function indexTimer(current, record, { now = Date.now(), limit = INDEX_LIMIT } = {}) {
  const entries = Array.isArray(current?.entries) ? current.entries : []
  const kept = entries.filter((entry) => {
    if (!entry?.timerId || entry.timerId === record.timerId) return false
    if (entry.state === 'running') return true
    const settledAt = Date.parse(entry.settledAt ?? entry.expiresAt ?? '')
    return Number.isFinite(settledAt) ? now - settledAt < SETTLED_RETENTION_MS : false
  })

  kept.push({
    timerId: record.timerId,
    state: record.state,
    expiresAt: record.expiresAt,
    settledAt: record.state === 'running' ? null : new Date(now).toISOString(),
  })

  const at = (value) => {
    const parsed = Date.parse(value ?? '')
    return Number.isFinite(parsed) ? parsed : 0
  }
  const running = kept
    .filter((entry) => entry.state === 'running')
    .sort((a, b) => at(a.expiresAt) - at(b.expiresAt))
  const settled = kept
    .filter((entry) => entry.state !== 'running')
    .sort((a, b) => at(b.settledAt) - at(a.settledAt))

  return {
    deviceId: record.deviceId,
    updatedAt: new Date(now).toISOString(),
    entries: [...running, ...settled].slice(0, limit),
  }
}

/* ------------------------------------------------------------ the rows */

function unwrap(row) {
  const data = row?.data ?? null
  return data && typeof data === 'object' && data.timerId ? data : null
}

export async function readTimer(store, timerId) {
  const id = String(timerId ?? '').trim()
  if (!id) return null
  return unwrap(await store.getState(timerStateKey(id)))
}

/**
 * Write the record, then the index — the same ordering approvals use, for the
 * same reason: a crash between the two leaves an unindexed timer (invisible,
 * harmless) rather than an index pointing at nothing.
 */
export async function saveTimer(store, record, { updatedBy = WRITER, now = Date.now() } = {}) {
  if (!record?.timerId) throw new Error('A timer record needs a timerId before it can be stored.')
  await store.saveState(timerStateKey(record.timerId), record, { updatedBy })
  const indexKey = timerIndexKey(record.deviceId)
  const current = (await store.getState(indexKey))?.data ?? null
  await store.saveState(indexKey, indexTimer(current, record, { now }), { updatedBy })
  return record
}

/** Every timer this device still has a row for, soonest expiry first. */
export async function listTimers(store, deviceId, { now = Date.now() } = {}) {
  const index = (await store.getState(timerIndexKey(deviceId)))?.data ?? null
  const entries = Array.isArray(index?.entries) ? index.entries : []
  const records = []
  for (const entry of entries) {
    const record = await readTimer(store, entry?.timerId)
    /* A missing row is skipped, not raised: a bounded store losing the tail of
     * an index is ordinary and must not make the live timers unreadable. */
    if (record) records.push(record)
  }
  void now
  return records.sort((a, b) => expiryMs(a) - expiryMs(b))
}

export async function startTimer({
  store,
  deviceId,
  minutes = null,
  durationMs = null,
  setBy = 'knob',
  label = null,
  now = Date.now(),
} = {}) {
  const record = createTimerRecord({ deviceId, minutes, durationMs, setBy, label, now })
  await saveTimer(store, record, { now })
  return record
}

export async function cancelTimers({ store, deviceId, timerId = null, now = Date.now() } = {}) {
  const records = await listTimers(store, deviceId, { now })
  const targets = timerId
    ? records.filter((record) => record.timerId === String(timerId) && timerIsRunning(record, now))
    : selectRunningTimers(records, now)

  const cancelled = []
  for (const record of targets) {
    const next = { ...record, state: 'cancelled', cancelledAt: new Date(now).toISOString() }
    await saveTimer(store, next, { now })
    cancelled.push(next)
  }
  return cancelled
}

/**
 * Take the due timers off the queue so exactly one speaker chimes them.
 *
 * Claimed before speaking, exactly like a queued announcement is claimed: two
 * sockets (a reconnect racing a stale one) would otherwise both chime the same
 * timer, and hearing your timer go off twice is how an owner learns to stop
 * trusting it. `settleClaimedTimer` finishes the pair.
 */
export async function claimDueTimers({ store, deviceId, now = Date.now(), limit = 3 } = {}) {
  const records = await listTimers(store, deviceId, { now })
  const due = selectDueTimers(records, now).slice(0, Math.max(1, limit))
  const claimed = []
  for (const record of due) {
    const next = { ...record, state: 'announcing', claimedAt: new Date(now).toISOString() }
    await saveTimer(store, next, { now })
    claimed.push(next)
  }
  return claimed
}

/**
 * What the chime actually managed.
 *
 * `spoke: false` puts the timer BACK to running — and because its expiry is
 * already in the past it is due again immediately, so the next press picks it
 * up. That is the whole point: a TTS outage or a socket that died mid-chime
 * must not silently eat a timer the owner is relying on.
 */
export async function settleClaimedTimer({ store, timerId, spoke = false, now = Date.now() } = {}) {
  const record = await readTimer(store, timerId)
  if (!record) return null
  const next = spoke
    ? { ...record, state: 'done', spokenAt: new Date(now).toISOString() }
    : { ...record, state: 'running', claimedAt: null }
  await saveTimer(store, next, { now })
  return next
}

/**
 * Everything a converse session needs about timers, as one closure bag.
 *
 * Handed to the voice loop (openaiRealtimeVoice's `timerControl`) AND used by
 * the knob path, so "set a timer for ten minutes" and turning the ring to 10
 * cannot diverge: there is one store, one clock, one chime. Voice parity is a
 * requirement in docs/Screenless_App_Grammar.md, not a feature, and this is
 * where it is made structural rather than promised.
 */
export function createTimerControl({ store, deviceId, now = () => Date.now() } = {}) {
  return {
    async start({ minutes = null, durationMs = null, label = null, setBy = 'voice' } = {}) {
      const record = await startTimer({ store, deviceId, minutes, durationMs, label, setBy, now: now() })
      return { ok: true, action: 'start', spoken: timerStartedSpeech(record), timerId: record.timerId }
    },
    async cancel({ timerId = null } = {}) {
      const cancelled = await cancelTimers({ store, deviceId, timerId, now: now() })
      return { ok: cancelled.length > 0, action: 'cancel', spoken: timerCancelledSpeech(cancelled) }
    },
    async status() {
      const at = now()
      const records = await listTimers(store, deviceId, { now: at })
      return { ok: true, action: 'status', spoken: timerRemainingSpeech(records, at) }
    },
  }
}

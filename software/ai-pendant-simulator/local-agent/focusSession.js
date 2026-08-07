import crypto from 'node:crypto'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { workspacePath } from './config.js'
import { getOutputVolume, setOutputMuted } from './systemControls.js'

const execFileAsync = promisify(execFile)

/*
 * "Start a focus session for 25 minutes. Block distractions and let me know
 * when time's up."
 *
 * Three separate promises in one sentence, and the third is the one agents get
 * wrong: an alarm that lives in a setTimeout dies with the process, and the
 * owner finds out at minute 40 that nobody was counting. So the session is
 * written to disk with its end time before anything is blocked, and the timer
 * is only an optimisation over that record — resumeFocusSessions() re-arms
 * whatever is still running after a restart, and a session whose end time has
 * already passed is ended immediately rather than silently dropped.
 *
 * "Block distractions" is deliberately reversible. Hiding an app returns it on
 * ⌘-tab with every window and unsaved buffer intact; quitting it does not, and
 * a focus tool that loses work is a worse interruption than the notification it
 * was preventing. Everything it changes is recorded in the session so ending
 * restores exactly what starting touched, including the case where the owner
 * had already muted their own volume.
 */

/* Resolved per call so a test can hold its own session store. */
const storePath = () =>
  process.env.PENDANT_FOCUS_STORE_PATH || path.join(workspacePath, '.pendant-focus.json')

/* Apps that interrupt by design. Overridable per call; this is the default for
 * someone who did not want to enumerate their own distractions out loud. */
const DEFAULT_DISTRACTIONS = [
  'Messages',
  'Mail',
  'Slack',
  'Discord',
  'Telegram',
  'WhatsApp',
  'Signal',
  'Music',
  'Spotify',
  'TV',
  'News',
  'Photos',
]

const MAX_MINUTES = 8 * 60

const isValidStore = (value) => value && Array.isArray(value.sessions)

const timers = new Map()

function loadStore() {
  const filePath = storePath()
  ensureJsonStore(filePath, { sessions: [] }, { validate: isValidStore })
  return readJsonWithRecovery(filePath, {
    fallback: { sessions: [] },
    validate: isValidStore,
  })
}

function saveStore(store) {
  store.sessions = store.sessions.slice(-50)
  writeJsonAtomic(storePath(), store, { validate: isValidStore })
}

export function focusStoreLocation() {
  return storePath()
}

export function activeFocusSession() {
  return loadStore().sessions.find((session) => session.status === 'running') ?? null
}

/**
 * Start a session. Returns as soon as the blocking is done — the owner is
 * waiting to start working, not waiting for a report.
 */
export async function startFocusSession({
  minutes = 25,
  label = 'Focus',
  distractions = DEFAULT_DISTRACTIONS,
  mute = true,
  now = Date.now(),
} = {}) {
  const existing = activeFocusSession()
  if (existing) {
    throw new Error(
      `A focus session is already running until ${new Date(existing.endsAt).toLocaleTimeString()}.`,
    )
  }

  const duration = Math.min(MAX_MINUTES, Math.max(1, Math.round(Number(minutes) || 25)))
  const endsAt = now + duration * 60_000

  const session = {
    id: `foc_${crypto.randomUUID()}`,
    label: String(label || 'Focus').slice(0, 80),
    minutes: duration,
    startedAt: new Date(now).toISOString(),
    endsAt,
    status: 'running',
    blocked: { hidden: [], muted: false, volumeWasMuted: null, failures: [] },
    endedAt: null,
  }

  /* Written before anything is blocked: if the block half-fails, the record of
   * what to undo still exists. */
  const store = loadStore()
  store.sessions.push(session)
  saveStore(store)

  session.blocked = await blockDistractions({ distractions, mute })
  persist(session)

  armTimer(session)

  return {
    ...session,
    spoken: `${duration} minutes, starting now. ${describeBlocked(session.blocked)} I'll tell you when time's up.`,
  }
}

/** Restore what was blocked and say so out loud. */
export async function endFocusSession({ id = null, reason = 'completed', announce = true } = {}) {
  const store = loadStore()
  const session = id
    ? store.sessions.find((item) => item.id === id)
    : store.sessions.find((item) => item.status === 'running')
  if (!session) throw new Error('No focus session to end.')
  if (session.status !== 'running') return { ...session, alreadyEnded: true }

  clearTimeout(timers.get(session.id))
  timers.delete(session.id)

  const restored = await restoreDistractions(session.blocked)
  session.status = reason === 'cancelled' ? 'cancelled' : 'completed'
  session.endedAt = new Date().toISOString()
  session.restored = restored
  persist(session)

  const elapsed = Math.round(
    (Date.parse(session.endedAt) - Date.parse(session.startedAt)) / 60_000,
  )
  const spoken =
    reason === 'cancelled'
      ? `Focus session stopped after ${elapsed} minute${elapsed === 1 ? '' : 's'}.`
      : `Time's up — that's ${session.minutes} minutes of focus. Everything is back.`

  if (announce) await announceOutLoud(spoken, session.label)

  return { ...session, spoken }
}

/**
 * Re-arm sessions that outlived the process. Called on agent start: a promise
 * to tell the owner when time is up must survive a crash at minute 3.
 */
export async function resumeFocusSessions({ now = Date.now() } = {}) {
  const running = loadStore().sessions.filter((session) => session.status === 'running')
  const resumed = []

  for (const session of running) {
    if (session.endsAt <= now) {
      /* The alarm was owed while the process was down. Late is the honest
       * outcome; pretending it never existed is not. */
      await endFocusSession({ id: session.id, reason: 'completed' })
      resumed.push({ id: session.id, outcome: 'ended-late' })
      continue
    }
    armTimer(session)
    resumed.push({ id: session.id, outcome: 'rearmed', endsAt: session.endsAt })
  }

  return resumed
}

export function focusStatus({ now = Date.now() } = {}) {
  const session = activeFocusSession()
  if (!session) return { running: false }
  const remainingMs = Math.max(0, session.endsAt - now)
  return {
    running: true,
    id: session.id,
    label: session.label,
    minutes: session.minutes,
    remainingMinutes: Math.ceil(remainingMs / 60_000),
    endsAt: new Date(session.endsAt).toISOString(),
    blocked: session.blocked,
  }
}

function armTimer(session) {
  const delay = Math.max(0, session.endsAt - Date.now())
  const timer = setTimeout(() => {
    endFocusSession({ id: session.id, reason: 'completed' }).catch((error) => {
      console.warn(`[focus] Could not end session ${session.id}: ${error.message}`)
    })
  }, delay)
  /* Deliberately NOT unref'd: the whole point is that this fires. */
  timers.set(session.id, timer)
}

function persist(session) {
  const store = loadStore()
  const index = store.sessions.findIndex((item) => item.id === session.id)
  if (index >= 0) store.sessions[index] = session
  else store.sessions.push(session)
  saveStore(store)
}

async function blockDistractions({ distractions, mute }) {
  const hidden = []
  const failures = []

  for (const app of distractions) {
    try {
      const wasHidden = await hideApp(app)
      if (wasHidden) hidden.push(app)
    } catch (error) {
      failures.push({ app, reason: String(error?.message || error).slice(0, 160) })
    }
  }

  let muted = false
  let volumeWasMuted = null
  if (mute) {
    try {
      const before = await getOutputVolume()
      volumeWasMuted = before.muted
      if (!before.muted) {
        await setOutputMuted(true)
        muted = true
      }
    } catch (error) {
      failures.push({ app: 'volume', reason: String(error?.message || error).slice(0, 160) })
    }
  }

  return { hidden, muted, volumeWasMuted, failures }
}

async function restoreDistractions(blocked) {
  const shown = []
  const failures = []

  for (const app of blocked?.hidden ?? []) {
    try {
      await showApp(app)
      shown.push(app)
    } catch (error) {
      failures.push({ app, reason: String(error?.message || error).slice(0, 160) })
    }
  }

  /* Only unmute what this session muted. The owner may have been working in
   * silence before it started, and un-silencing them is its own interruption. */
  if (blocked?.muted && blocked.volumeWasMuted === false) {
    try {
      await setOutputMuted(false)
    } catch (error) {
      failures.push({ app: 'volume', reason: String(error?.message || error).slice(0, 160) })
    }
  }

  return { shown, failures }
}

/** Hide only what is already running — launching Slack to hide it is absurd. */
async function hideApp(appName) {
  const script = `
tell application "System Events"
  if exists (process "${escapeAppleScript(appName)}") then
    set visible of process "${escapeAppleScript(appName)}" to false
    return "hidden"
  end if
end tell
return "not running"`
  const { stdout } = await execFileAsync('osascript', ['-e', script], { timeout: 10_000 })
  return String(stdout).trim() === 'hidden'
}

async function showApp(appName) {
  const script = `
tell application "System Events"
  if exists (process "${escapeAppleScript(appName)}") then
    set visible of process "${escapeAppleScript(appName)}" to true
  end if
end tell
return "ok"`
  await execFileAsync('osascript', ['-e', script], { timeout: 10_000 })
  return true
}

/*
 * The owner asked to be told, and they are wearing a pendant rather than
 * watching a screen — so the banner is the fallback and the voice is the point.
 */
async function announceOutLoud(text, title) {
  const results = await Promise.allSettled([
    execFileAsync('say', ['-r', '180', text], { timeout: 20_000 }),
    execFileAsync(
      'osascript',
      [
        '-e',
        `display notification "${escapeAppleScript(text)}" with title "${escapeAppleScript(title)}" sound name "Glass"`,
      ],
      { timeout: 10_000 },
    ),
  ])
  return results.map((result) => result.status)
}

export function describeBlocked(blocked) {
  const parts = []
  if (blocked?.hidden?.length) parts.push(`Hid ${blocked.hidden.join(', ')}.`)
  if (blocked?.muted) parts.push('Muted notification sounds.')
  return parts.length ? parts.join(' ') : 'Nothing to block — you were already clear.'
}

function escapeAppleScript(value) {
  return String(value ?? '').replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

export const FOCUS_DEFAULT_DISTRACTIONS = DEFAULT_DISTRACTIONS

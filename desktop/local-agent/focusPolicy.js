import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

/*
 * The owner is a person sitting at this Mac, not a headless CI box. An agent
 * that yanks the foreground away mid-sentence is worse than an agent that is
 * slightly slower to be noticed, so launches default to NOT stealing focus.
 *
 *   steal       always activate (the pre-existing behaviour)
 *   background  never activate
 *   auto        activate only while the owner is away  (default)
 */
const POLICY = String(process.env.PENDANT_FOCUS_POLICY || 'auto').toLowerCase()

/* Below this, the owner is typing or moving the mouse right now. */
const PRESENT_IDLE_SECONDS = Number(process.env.PENDANT_PRESENT_IDLE_SECONDS || 60)

/**
 * Seconds since the last keyboard or mouse event, or null if it cannot be
 * read. HIDIdleTime is in nanoseconds and is the only presence signal that
 * needs no permissions and no extra process running.
 */
export async function idleSeconds() {
  try {
    const { stdout } = await execFileAsync('/bin/sh', [
      '-c',
      "ioreg -c IOHIDSystem | awk '/HIDIdleTime/ {print $NF; exit}'",
    ])
    const nanoseconds = Number(String(stdout).trim())
    if (!Number.isFinite(nanoseconds)) return null
    return nanoseconds / 1e9
  } catch {
    return null
  }
}

export async function ownerIsPresent() {
  const idle = await idleSeconds()
  /* Unreadable presence means assume present: the cautious direction is to
   * leave the owner's foreground alone, not to grab it. */
  if (idle === null) return true
  return idle < PRESENT_IDLE_SECONDS
}

/**
 * Whether this launch should take the foreground.
 * `explicit` is for the case where the owner literally asked to be shown
 * something — "show me my calendar" should still come to the front.
 */
export async function shouldTakeFocus({ explicit = false } = {}) {
  if (POLICY === 'steal') return true
  if (POLICY === 'background') return false
  if (explicit) return true
  return !(await ownerIsPresent())
}

/**
 * Arguments for `open` that honour the policy. `-g` opens without activating,
 * so the app appears in its own window behind whatever the owner is doing.
 */
export async function openArgs(args, options) {
  return (await shouldTakeFocus(options)) ? args : ['-g', ...args]
}

export const focusPolicy = { POLICY, PRESENT_IDLE_SECONDS }

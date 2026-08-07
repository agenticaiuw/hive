import fs from 'node:fs'
import path from 'node:path'

/*
 * Do synthesized events actually reach the screen from THIS binary, and when
 * was that last true?
 *
 * Accessibility trust on macOS is per-binary. "The agent can post events" is
 * only ever a statement about the exact executable that asked, so a result
 * recorded without the bundle it was measured from is not a result. An earlier
 * agent told the owner their ui_* steps were going nowhere purely because the
 * quiet permission report carried no `inputPosting` field — absent was read as
 * broken. It later posted a real event and found they do arrive. Both of those
 * are the same mistake in opposite directions: an inference reported as a
 * measurement.
 *
 * So this posts a real no-op event on a schedule and records the measurement:
 * status, the bundle tested, the timestamp. `unverified` means nothing more
 * and nothing less than "not probed". It never means "assumed fine".
 *
 * NOTHING HERE GATES. A `failed` reachability annotates a receipt and nothing
 * else; the step still runs. Gating on a permission signal has been proposed
 * and rejected on this project repeatedly, and a probe is a strictly worse
 * gate than the executor's own error path — it is a sample from the past, not
 * a fact about the step in front of it.
 *
 * The probe is a zero-delta mouse move to the cursor's OWN current location.
 * It opens no window, activates no app, and moves no pointer. Measured on this
 * Mac, it also does not reset the HID idle timer, so a periodic probe does not
 * hold the display awake.
 */

export const INPUT_REACHABILITY_STATES = Object.freeze([
  'verified',
  'unverified',
  'failed',
])

const DEFAULT_INTERVAL_MS = 15 * 60 * 1000

/* 0 disables the monitor entirely, which leaves the status at `unverified` —
 * the honest answer when nothing probed. */
const configuredInterval = Number(process.env.PENDANT_INPUT_PROBE_INTERVAL_MS)
export const INPUT_PROBE_INTERVAL_MS =
  Number.isFinite(configuredInterval) && configuredInterval >= 0
    ? configuredInterval
    : DEFAULT_INTERVAL_MS

export const PROBE_METHOD =
  'zero-delta mouse move to the cursor’s own location (aipendant-uicontrol probe)'

/*
 * Steps that only arrive by way of a posted event. The first four are the ones
 * executionJournal.js already names as reporting success while doing nothing;
 * the pixel tier is CGEventPost end to end; computer_use_task drives both in a
 * loop. Everything else — ui_snapshot, ui_find, ui_hit_test, ui_wait_for — only
 * reads the accessibility tree and is unaffected by whether events post.
 */
export const INPUT_POSTING_ACTION_TYPES = new Set([
  'ui_click',
  'ui_menu',
  'type_text',
  'press_keys',
  'mouse_move',
  'mouse_click',
  'mouse_double_click',
  'mouse_right_click',
  'mouse_down',
  'mouse_up',
  'mouse_drag',
  'mouse_scroll',
  'scroll',
  'computer_use_task',
])

export function postsSyntheticInput(type) {
  return INPUT_POSTING_ACTION_TYPES.has(String(type ?? ''))
}

let lastResult = null
let inFlight = null

/**
 * The binary whose Accessibility grant is actually being tested.
 *
 * Two different things can answer "which bundle is this": the .app the running
 * executable is embedded in, and the bundle LaunchServices recorded as having
 * started the process tree. When the agent runs from its own .app they agree.
 * When node runs from Homebrew under a terminal, only the second exists and it
 * is the right answer, because TCC attributes to the responsible process.
 * Both are recorded rather than collapsed, so a reader can tell which one the
 * result is a statement about.
 */
export function describeProbeHost({
  execPath = process.execPath,
  env = process.env,
} = {}) {
  const bundlePath = enclosingAppBundle(execPath)
  const launchedBy = String(env.__CFBundleIdentifier ?? '') || null
  const bundleId = bundleIdFromPlist(bundlePath) ?? launchedBy

  return {
    bundleId,
    bundlePath,
    launchedBy,
    execPath,
    source: bundlePath
      ? bundleIdFromPlist(bundlePath)
        ? 'app-bundle Info.plist'
        : 'LaunchServices env (bundle Info.plist unreadable)'
      : launchedBy
        ? 'LaunchServices env (executable is not in an app bundle)'
        : 'unknown',
  }
}

function enclosingAppBundle(execPath) {
  let current = path.resolve(String(execPath ?? ''))

  while (current && current !== path.dirname(current)) {
    if (current.endsWith('.app')) return current
    current = path.dirname(current)
  }

  return null
}

function bundleIdFromPlist(bundlePath) {
  if (!bundlePath) return null

  try {
    const text = fs.readFileSync(path.join(bundlePath, 'Contents', 'Info.plist'), 'utf8')
    const match = text.match(
      /<key>CFBundleIdentifier<\/key>\s*<string>([^<]+)<\/string>/,
    )
    return match ? match[1].trim() : null
  } catch {
    /* Binary plists and unreadable bundles both land here; the caller falls
     * back to the LaunchServices id rather than inventing one. */
    return null
  }
}

export function unprobedReachability(host = describeProbeHost()) {
  return {
    status: 'unverified',
    checkedAt: null,
    host,
    secureInput: null,
    probeMethod: PROBE_METHOD,
    detail:
      'Not probed. No event has been posted from this binary, so whether ui_* and type_text steps reach the screen is unmeasured — not assumed either way.',
  }
}

/** The last measurement, or an explicit "not probed". Never null. */
export function getInputReachability() {
  return lastResult ?? unprobedReachability()
}

/** Tests only: drop the recorded measurement so the next read is `unverified`. */
export function resetInputReachability() {
  lastResult = null
  inFlight = null
}

async function defaultProbeImpl() {
  const { probeInput } = await import('./uiControl.js')
  return probeInput()
}

/**
 * Post one no-op event and record what happened.
 *
 * A probe that throws is `failed`, not `unverified`: the helper is how events
 * get posted at all, so failing to run it is failing to post. macos/
 * permissions.js and executionJournal.js already reach the same conclusion the
 * same way, and the three should keep agreeing.
 */
export async function probeInputReachability({
  probeImpl = defaultProbeImpl,
  host = describeProbeHost(),
  now = () => new Date(),
} = {}) {
  /* A periodic probe and an on-demand /observe?probeInput=1 can land together;
   * spawning two helpers to answer one question posts two events for nothing. */
  if (inFlight) return inFlight

  inFlight = (async () => {
    const checkedAt = now().toISOString()

    try {
      const probe = await probeImpl()
      const posted = Boolean(probe?.axTrusted)

      return record({
        status: posted ? 'verified' : 'failed',
        checkedAt,
        host,
        secureInput: Boolean(probe?.secureInput),
        probeMethod: PROBE_METHOD,
        detail: posted
          ? `A synthesized event posted successfully from ${describeHost(host)}.`
          : `Synthesized events are not accepted from ${describeHost(host)} — Accessibility is granted to a different binary than the one running.`,
      })
    } catch (error) {
      return record({
        status: 'failed',
        checkedAt,
        host,
        secureInput: null,
        probeMethod: PROBE_METHOD,
        detail: `Input helper unavailable, so no event could be posted from ${describeHost(host)}: ${error?.message ?? error}`,
      })
    }
  })().finally(() => {
    inFlight = null
  })

  return inFlight
}

function record(result) {
  lastResult = result
  return result
}

function describeHost(host) {
  return host?.bundleId ?? host?.execPath ?? 'this process'
}

/**
 * Startup probe plus a periodic one, so the answer is a recorded fact before
 * anybody asks rather than something only `?probeInput=1` ever learns.
 */
export function startInputReachabilityMonitor({
  intervalMs = INPUT_PROBE_INTERVAL_MS,
  probeImpl = defaultProbeImpl,
  onResult = null,
} = {}) {
  if (!(intervalMs > 0)) {
    return { stop() {}, intervalMs: 0, enabled: false }
  }

  const run = () =>
    probeInputReachability({ probeImpl }).then((result) => {
      try {
        onResult?.(result)
      } catch {
        /* Reporting a measurement must not be able to stop the next one. */
      }
      return result
    })

  run()
  const timer = setInterval(run, intervalMs)
  /* The monitor must never be the reason this process refuses to exit. */
  timer.unref?.()

  return { stop: () => clearInterval(timer), intervalMs, enabled: true }
}

/**
 * The receipt annotation. Null for steps that do not post events, so a
 * read_file receipt does not carry a warning about a mechanism it never used.
 */
export function annotateInputReachability(type, snapshot = getInputReachability()) {
  if (!postsSyntheticInput(type)) return null

  return {
    status: snapshot.status,
    bundleId: snapshot.host?.bundleId ?? null,
    checkedAt: snapshot.checkedAt,
    warning: warningFor(type, snapshot),
  }
}

function warningFor(type, snapshot) {
  const where = snapshot.host?.bundleId ?? 'this binary'

  if (snapshot.status === 'verified') return null

  if (snapshot.status === 'failed') {
    return `${type} may have been a no-op: the last input probe from ${where} at ${snapshot.checkedAt} could not post an event. This step reports success either way.`
  }

  return `${type} posts a synthesized event, and input reachability from ${where} has never been probed. Success here does not prove the event arrived.`
}

/**
 * A recorded measurement read as the `inputPosting` shape the permission report
 * and executionJournal already speak. `unverified` maps to null, because that
 * path is contractually "not probed" and must not be handed a guess.
 */
export function inputPostingFromReachability(snapshot = getInputReachability()) {
  if (!snapshot || snapshot.status === 'unverified') return null

  return {
    granted: snapshot.status === 'verified',
    secureInput: Boolean(snapshot.secureInput),
    detail: `${snapshot.detail} (probed ${snapshot.checkedAt})`,
  }
}

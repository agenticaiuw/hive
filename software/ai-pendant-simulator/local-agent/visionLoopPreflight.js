import { computerUseEnabled, visionUploadConsented } from './computerUseLoop.js'
import { describeProbeHost, getInputReachability } from './inputReachability.js'
import { detectHostApp, ensurePermissions } from './macos/permissions.js'
import { ACCESSIBILITY_GRANT, SCREEN_RECORDING_GRANT } from './visionLoopPolicy.js'

/*
 * May the loop dispatch anything at all, and if not, exactly what is missing
 * and who can supply it?
 *
 * MEASURED ON THIS MACHINE, 2026-08-07, from a live /ops/status:
 *
 *     accessibility.trusted            false   ("Enable Accessibility for AI Pendant Agent")
 *     screenRecording.granted          false
 *     computerUse.loopEnabled          false   (PENDANT_COMPUTER_USE_ENABLED unset)
 *     computerUse.visionUploadConsented false  (PENDANT_VISION_UPLOAD_CONSENT unset)
 *
 * Two of those four are TCC grants and two are switches, and the difference is
 * the whole reason this file exists. A switch is an environment variable: this
 * process can read it, and the owner can flip it. A TCC grant cannot be
 * obtained from inside the process that wants it — the authorisation dialog is
 * driven by the system, the decision is the owner's, and the record is keyed to
 * a specific binary. Six agents on this project have independently asked for
 * the accessibility grant and all six were refused for that reason. Asking a
 * seventh time is not a plan.
 *
 * So this module does not ask. It does not call AXIsProcessTrustedWithOptions,
 * it does not open System Settings, and it does not retry. Opening a Settings
 * pane is itself a foreground grab, which would break the promise this feature
 * is named after in the course of trying to enable it. What it does instead is
 * name the exact binary the owner has to tick, because per-binary trust is the
 * part that actually goes wrong: a grant given to Terminal does nothing for an
 * agent running out of `AI Pendant Agent.app`, and vice versa.
 *
 * NOTHING HERE PROBES ON ITS OWN unless asked. The accessibility answer is read
 * from the same quiet permission call /health already makes, and from
 * inputReachability's RECORDED measurement. `unverified` is a first-class
 * result and blocks; it never rounds to either "granted" or "denied".
 */

export const GRANT_SOURCE_NOTE =
  'Read from the same quiet permission report /health and /ops/status use, so this cannot disagree with what the dashboard shows.'

/**
 * The quiet permission read.
 *
 * Exactly the call buildHealthPayload() makes: no prompts, no Settings pane, no
 * Automation preflight. Injected everywhere so tests never touch TCC.
 */
async function readPermissionsQuietly() {
  const { after } = await ensurePermissions({
    prompt: false,
    openSettings: false,
    preflightAutomation: false,
    force: false,
  })
  return after
}

/**
 * Which executable the owner would actually be granting.
 *
 * Two names, both reported, neither collapsed into the other: the human label
 * that appears in the Settings list, and the bundle/exec path that identifies
 * the binary TCC keys the record to. An owner who ticks the wrong row gets a
 * grant that changes nothing, and that is the single most common way this
 * fails.
 */
export function grantTarget({ host = describeProbeHost(), hostApp = detectHostApp() } = {}) {
  return {
    hostApp,
    bundleId: host?.bundleId ?? null,
    bundlePath: host?.bundlePath ?? null,
    execPath: host?.execPath ?? null,
    identifiedBy: host?.source ?? 'unknown',
    note: 'Accessibility trust on macOS is per-binary. A grant given to a different executable — a terminal, a different Node, an older copy of the app — does not apply to this one.',
  }
}

function accessibilityFinding(permissions, reachability) {
  const reported = permissions?.accessibility

  /* A recorded probe outranks nothing: both are readings, and they answer
   * slightly different questions (AXIsProcessTrusted vs "an event actually
   * posted"). They are reported together, and a disagreement is surfaced rather
   * than resolved, because a disagreement is real information — it usually
   * means the grant is held by a different binary than the one running. */
  const trusted = typeof reported?.trusted === 'boolean' ? reported.trusted : null
  const probed = reachability?.status ?? 'unverified'

  if (trusted === true && probed !== 'failed') {
    return { held: true, measured: 'AXIsProcessTrusted', detail: reported?.detail ?? null, probe: probed }
  }

  if (trusted === false) {
    return {
      held: false,
      measured: 'AXIsProcessTrusted',
      detail: reported?.detail ?? 'Accessibility is not granted to this process.',
      probe: probed,
    }
  }

  if (trusted === true && probed === 'failed') {
    return {
      held: false,
      measured: 'AXIsProcessTrusted vs input probe (they disagree)',
      detail:
        'The process reports itself trusted but the last posted event did not arrive. That normally means the grant is recorded against a different binary than the one running.',
      probe: probed,
    }
  }

  /* No reading at all. Not "denied" — unmeasured. Blocking on it is right;
   * calling it denied would be an inference reported as a measurement. */
  return {
    held: false,
    measured: null,
    detail:
      'Accessibility trust has not been measured. Nothing may be dispatched on an unmeasured permission — that is not the same as it being denied.',
    probe: probed,
  }
}

/**
 * The gate.
 *
 * Returns a description. It runs nothing, dispatches nothing, and cannot be
 * made to say `ok: true` by anything other than the two facts it reads.
 */
export async function preflight({
  readPermissions = readPermissionsQuietly,
  reachability = getInputReachability(),
  loopEnabled = computerUseEnabled,
  uploadConsented = visionUploadConsented,
  host = describeProbeHost(),
  hostApp = detectHostApp(),
  now = Date.now(),
} = {}) {
  let permissions = null
  let permissionsError = null

  try {
    permissions = await readPermissions()
  } catch (error) {
    /* An unreadable permission report is an unmeasured one, which blocks. It is
     * not an error the caller has to handle: "I could not find out" is a
     * perfectly good answer to "may I drive the owner's GUI". */
    permissionsError = String(error?.message ?? error)
  }

  const accessibility = accessibilityFinding(permissions, reachability)
  const target = grantTarget({ host, hostApp })

  const grants = [
    {
      ...ACCESSIBILITY_GRANT,
      required: true,
      held: accessibility.held,
      measured: accessibility.measured,
      detail: permissionsError ? `Permission report unreadable: ${permissionsError}` : accessibility.detail,
      inputProbe: accessibility.probe,
      ownerAction: accessibility.held
        ? null
        : `Open ${ACCESSIBILITY_GRANT.pane} and enable ${target.hostApp}${target.bundlePath ? ` (${target.bundlePath})` : ''}. This agent cannot grant it, cannot prompt usefully for it, and will not open the pane for you — that would take the foreground, which is the exact thing this loop promises not to do.`,
    },
    {
      ...SCREEN_RECORDING_GRANT,
      /* The point worth making loudly. */
      required: false,
      held: Boolean(permissions?.screenRecording?.granted),
      measured: 'screencapture probe',
      detail:
        'Not on this loop’s critical path. Accessibility mode reads controls, not pixels, so this stays denied and the loop still works.',
      ownerAction: null,
    },
  ]

  const switches = [
    {
      name: 'computerUse.loopEnabled',
      env: 'PENDANT_COMPUTER_USE_ENABLED',
      on: Boolean(loopEnabled()),
      required: true,
      detail:
        'The master switch for any perceive-act loop on this agent. Accessibility mode is a narrower loop, not an exemption from it.',
      ownerAction: 'Set PENDANT_COMPUTER_USE_ENABLED=1 and restart the agent.',
    },
    {
      name: 'computerUse.visionUploadConsented',
      env: 'PENDANT_VISION_UPLOAD_CONSENT',
      on: Boolean(uploadConsented()),
      /* Not required to RUN. It gates only the relay offload, and the loop is
       * fully functional without it — see visionLoopRelay.js. Listing it here
       * as required would have quietly turned a local feature into one that
       * needs an upload. */
      required: false,
      detail:
        'Only gates sending UI state off this machine for classification. The loop itself never needs it.',
      ownerAction: null,
    },
  ]

  const blockedOn = [
    ...grants.filter((entry) => entry.required && !entry.held).map((entry) => ({
      kind: 'grant',
      name: entry.grant,
      grantableFrom: 'the owner, in System Settings, for this exact binary',
      grantableFromHere: false,
      detail: entry.ownerAction,
    })),
    ...switches.filter((entry) => entry.required && !entry.on).map((entry) => ({
      kind: 'switch',
      name: entry.name,
      grantableFrom: `the ${entry.env} environment variable`,
      grantableFromHere: false,
      detail: entry.ownerAction,
    })),
  ]

  return {
    ok: blockedOn.length === 0,
    status: blockedOn.length === 0 ? 'ready' : 'blocked',
    checkedAt: new Date(now).toISOString(),
    mode: 'accessibility',
    target,
    grants,
    switches,
    blockedOn,
    source: GRANT_SOURCE_NOTE,
    /* The sentence to put in front of a person. Everything above is for a
     * program; this is the whole answer for someone who asked "why isn't it
     * doing anything". */
    summary: summarize(blockedOn, target),
  }
}

function summarize(blockedOn, target) {
  if (!blockedOn.length) {
    return `Accessibility-mode automation is ready: the accessibility grant is held by ${target.hostApp} and the loop switch is on. Screen Recording is still denied and is not needed.`
  }

  const grantNames = blockedOn.filter((entry) => entry.kind === 'grant').map((entry) => entry.name)
  const switchNames = blockedOn.filter((entry) => entry.kind === 'switch').map((entry) => entry.name)
  const parts = []

  if (grantNames.length) {
    parts.push(
      `${grantNames.join(' and ')} ${grantNames.length === 1 ? 'is' : 'are'} not granted to ${target.hostApp}${
        target.bundlePath ? ` (${target.bundlePath})` : ''
      }, and only the owner can grant that, in System Settings, for that exact binary`,
    )
  }
  if (switchNames.length) {
    parts.push(`${switchNames.join(' and ')} ${switchNames.length === 1 ? 'is' : 'are'} off`)
  }

  return `Nothing will be dispatched: ${parts.join('; ')}. The plan is still built, checked and written down in full, so the moment the grant lands there is nothing left to work out.`
}

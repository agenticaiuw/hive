import crypto from 'node:crypto'

import { RELAY_URL } from './bridgeConfig.js'
import { visionUploadConsented } from './computerUseLoop.js'
import { classifySensitivity, maskSecretValue } from './redaction.js'

/*
 * "Integrate mac-vision with the Cloudflare Worker relay to allow partial
 * offloading of UI state classification."
 *
 * The honest version of this proposal is much smaller than it sounds, and the
 * gap between the two is where the harm would be.
 *
 * WHAT IS BEING OFFLOADED. Not the screen. Not a screenshot, not a crop, not an
 * OCR of one. "UI state classification" here means: given the roles and titles
 * of the controls an app is exposing, which of a small set of states is this
 * window in — a login sheet, a progress spinner, a confirmation dialog, a
 * finished list. That is a judgement over a short structured digest, and a
 * short structured digest is the only thing this module will ever build.
 *
 * The guarantee is structural, not documentary: buildDigest() accepts an
 * ELEMENT LIST. There is no image parameter, no path parameter, no capture
 * call, and no import of screenCapture.js anywhere in this file. A future
 * caller who wants to send pixels cannot do it by passing a flag; they would
 * have to write a different function, which is a thing a reviewer can see.
 *
 * THE CONSENT GATE. `visionUploadConsented()` is false on this machine
 * (PENDANT_VISION_UPLOAD_CONSENT is unset), and while it is false this module
 * never calls fetch. Not with a redacted payload, not with a "harmless" digest,
 * not to a health endpoint. Consent to send UI state off the machine is the
 * owner's to give, and a module that decides for itself which of its uploads
 * are small enough to be exempt has no gate at all. computerControl.js already
 * checks the same flag before the vision loop; this is the same flag, checked
 * the same way, for the same reason.
 *
 * OFF-MACHINE IS STRICTER THAN ON-MACHINE. actionLedger.persistableParams keeps
 * `sensitive` values (an email address, a phone number) because it is writing
 * to a file that already sits next to a job store containing the same string,
 * and being useless is not the same as being safe. That reasoning does not
 * survive the boundary: nothing on the relay already has the owner's window
 * titles. So here, `sensitive` is masked as well as `secret`, and only titles
 * classified `normal` travel as text. The rest travel as a hash, which is
 * enough for the relay to notice that a control it saw before is back.
 *
 * IT IS AN OPTIMISATION AND BEHAVES LIKE ONE. contextResume.js is the model: a
 * missing consent, an unreachable relay, a malformed answer all return a
 * decline and the caller classifies locally. Nothing in this file may fail a
 * run, and nothing in it may be load-bearing — an offload that becomes required
 * is an agent that stops working when the network does.
 */

/* The route this would speak to. It does NOT exist on the relay today: the
 * Cloudflare Worker forwards everything except /v1/pendant/converse into
 * cloud-relay/server.js, and there is no classification handler there. Naming
 * it here is a proposal, not a claim, and `endpointImplemented` says so in the
 * payload rather than leaving a caller to discover it with a 404. */
export const CLASSIFY_ENDPOINT = '/v1/vision/classify-ui-state'
export const ENDPOINT_IMPLEMENTED = false

/* Whole-window classification is the useful unit; a digest that grows with the
 * app is one that starts carrying document contents. */
export const MAX_DIGEST_ELEMENTS = 60
export const MAX_TITLE_CHARS = 64

/* A slow classification is worse than a local guess: the loop is holding a step
 * while it waits. */
export const OFFLOAD_TIMEOUT_MS = Number(process.env.VISION_OFFLOAD_TIMEOUT_MS || 2000)

const sha256 = (value) => crypto.createHash('sha256').update(String(value ?? '')).digest('hex')

/**
 * One control, reduced to what a classifier needs and nothing else.
 *
 * Geometry is bucketed rather than sent: whether a control is in the top,
 * middle or bottom third of the window is what distinguishes a toolbar from a
 * dialog's action row, and exact points would let a reader reconstruct the
 * window layout — which is a picture of the screen assembled out of numbers.
 */
export function digestElement(element, { index = 0 } = {}) {
  const role = String(element?.role ?? '').slice(0, 40)
  const rawTitle = String(element?.title ?? '')
  const label = classifySensitivity(rawTitle)

  const shareable = label === 'normal'
  const title = shareable ? rawTitle.slice(0, MAX_TITLE_CHARS) : null

  return {
    i: index,
    role,
    /* Present and null, never absent: a classifier that cannot tell "no title"
     * from "title withheld" will treat a masked login field as an unlabelled
     * one and classify the window wrong. */
    title,
    titleWithheld: shareable ? null : label,
    /* Stable across observations of the same control, and useless off this
     * machine for recovering the text. This is what lets the relay say "the
     * same control is still here" without being told what it says. */
    titleHash: rawTitle ? sha256(rawTitle).slice(0, 16) : null,
    masked: shareable ? null : maskSecretValue(rawTitle),
    band: bandOf(element),
    enabled: element?.enabled === undefined ? null : Boolean(element.enabled),
  }
}

function bandOf(element) {
  const y = Number(element?.centerY ?? element?.y)
  if (!Number.isFinite(y)) return null
  const height = Number(element?.windowHeight)
  if (!Number.isFinite(height) || height <= 0) return 'unknown'
  const ratio = y / height
  return ratio < 0.34 ? 'top' : ratio < 0.67 ? 'middle' : 'bottom'
}

/**
 * The payload that would be sent. Computable locally, always, so the owner can
 * read exactly what an upload would contain before consenting to one.
 *
 * That is the point of building it even while the gate is shut: "consent to
 * uploads" is not a meaningful decision if the thing being consented to is
 * invisible until after you agree.
 */
export function buildDigest({ app = null, elements = [], goal = null } = {}) {
  const list = (Array.isArray(elements) ? elements : []).slice(0, MAX_DIGEST_ELEMENTS)
  const digested = list.map((element, index) => digestElement(element, { index }))
  const withheld = digested.filter((entry) => entry.titleWithheld).length

  const payload = {
    v: 1,
    /* The app NAME travels; the window title does not. A name is a public fact
     * about which program is running, and the classifier is useless without it.
     * A window title is the owner's document. */
    app: app ? String(app).slice(0, 60) : null,
    goal: goal ? String(goal).slice(0, 200) : null,
    elementCount: (Array.isArray(elements) ? elements : []).length,
    truncated: (Array.isArray(elements) ? elements : []).length > MAX_DIGEST_ELEMENTS,
    elements: digested,
  }

  return {
    payload,
    bytes: Buffer.byteLength(JSON.stringify(payload)),
    withheldTitles: withheld,
    contains: {
      screenshot: false,
      pixels: false,
      windowTitles: false,
      textFieldValues: false,
      elementRolesAndBands: true,
      controlTitles: `${digested.length - withheld} of ${digested.length}, the ones classified as carrying nothing sensitive`,
    },
  }
}

/**
 * What an offload would do, and what stops it.
 *
 * Never sends. This is the read an owner gets before deciding, and the read a
 * developer gets when asking why nothing is being offloaded.
 */
export function describeOffload({
  app = null,
  elements = [],
  goal = null,
  consented = visionUploadConsented,
  relayUrl = RELAY_URL,
  accessibilityHeld = false,
} = {}) {
  const digest = buildDigest({ app, elements, goal })
  const hasConsent = Boolean(typeof consented === 'function' ? consented() : consented)

  const blockedOn = []
  if (!hasConsent) {
    blockedOn.push({
      kind: 'consent',
      name: 'computerUse.visionUploadConsented',
      env: 'PENDANT_VISION_UPLOAD_CONSENT',
      detail:
        'Sending any description of the owner’s windows off this machine needs their explicit yes. While this is unset, no request is made — the digest below is built locally so it can be read before consenting, and then discarded.',
    })
  }
  if (!accessibilityHeld) {
    blockedOn.push({
      kind: 'grant',
      name: 'accessibility',
      detail:
        'There is nothing to classify. The element list comes from the accessibility tree, and the helper refuses to read it without the grant. An offload with an empty digest would be a network call that describes nothing.',
    })
  }
  if (!ENDPOINT_IMPLEMENTED) {
    blockedOn.push({
      kind: 'endpoint',
      name: `${relayUrl}${CLASSIFY_ENDPOINT}`,
      detail:
        'The relay has no UI-state classification handler yet. cloudflare-worker/worker.js forwards everything but the pendant WebSocket into cloud-relay/server.js, and no route there answers this. It is a proposed endpoint, not a live one.',
    })
  }

  return {
    ok: true,
    readOnly: true,
    wouldSend: blockedOn.length === 0,
    endpoint: `${relayUrl}${CLASSIFY_ENDPOINT}`,
    endpointImplemented: ENDPOINT_IMPLEMENTED,
    method: 'POST',
    timeoutMs: OFFLOAD_TIMEOUT_MS,
    blockedOn,
    digest,
    /* The "partial" in "partial offloading", made concrete. Without it, an
     * offload quietly becomes a dependency the first time it is convenient. */
    partial: {
      whatStaysLocal: [
        'Deciding which control to press. The relay classifies a state; it never picks an action.',
        'The step vocabulary and the focus guarantees, which are structural and enforced here.',
        'Every fallback: an unreachable or slow relay means the loop classifies locally and carries on.',
      ],
      whatWouldGoOut: [
        'Control roles, on-screen bands, and the subset of titles that classify as carrying nothing sensitive.',
        'The app name and the goal string.',
      ],
      whatNeverGoesOut: [
        'Screenshots or any pixels. This module has no image parameter and does not import the capture layer.',
        'Window titles, document contents, and the value of any text field.',
        'Titles classified as secret or sensitive; those travel as a hash if at all.',
      ],
    },
  }
}

/**
 * Perform the offload. Declines rather than throws, always.
 *
 * The consent check is inside this function rather than at its call site on
 * purpose: a gate a caller has to remember is a gate that gets forgotten.
 */
export async function classifyUiState(
  { app = null, elements = [], goal = null } = {},
  {
    fetchImpl = fetch,
    consented = visionUploadConsented,
    relayUrl = RELAY_URL,
    apiKey = process.env.RELAY_API_KEY || '',
    timeoutMs = OFFLOAD_TIMEOUT_MS,
    endpointImplemented = ENDPOINT_IMPLEMENTED,
  } = {},
) {
  const hasConsent = Boolean(typeof consented === 'function' ? consented() : consented)

  if (!hasConsent) {
    return decline('no_upload_consent', 'PENDANT_VISION_UPLOAD_CONSENT is not set.')
  }

  if (!endpointImplemented) {
    /* Refusing to call a route that does not exist is not pedantry: a 404 body
     * from a relay is untrusted text, and pretending it might be a
     * classification is how untrusted text gets parsed as a decision. */
    return decline(
      'endpoint_not_implemented',
      `The relay has no ${CLASSIFY_ENDPOINT} handler yet, so there is nothing to call.`,
    )
  }

  const list = Array.isArray(elements) ? elements : []
  if (!list.length) {
    return decline('nothing_to_classify', 'The element list was empty.')
  }

  const { payload } = buildDigest({ app, elements: list, goal })

  let answer
  try {
    const response = await fetchImpl(`${relayUrl}${CLASSIFY_ENDPOINT}`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        ...(apiKey ? { Authorization: `Bearer ${apiKey}` } : {}),
      },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(timeoutMs),
    })
    if (!response.ok) return decline(`relay_status_${response.status}`, 'The relay refused.')
    answer = await response.json()
  } catch (error) {
    return decline('relay_unreachable', String(error?.message ?? error))
  }

  /*
   * The relay's answer is DATA. It is a label to compare against a local guess,
   * never an instruction, never an action, and never a widening of what the
   * loop may do. computerUseLoop's system prompt makes the same promise about
   * text on screen; a remote classifier is the same threat with a TLS
   * certificate. So the answer is narrowed to a known label set and everything
   * else in the body is dropped on the floor.
   */
  const state = KNOWN_STATES.has(String(answer?.state ?? '')) ? String(answer.state) : null
  if (!state) return decline('unrecognised_state', 'The relay returned no state this loop knows.')

  return {
    classified: true,
    state,
    confidence: clamp01(answer?.confidence),
    source: 'relay',
    note: 'A label, not an instruction. It cannot add a step, change the target app, or raise a budget.',
  }
}

/* The closed set. A classifier that can invent a state can invent one the
 * caller happens to branch on. */
export const KNOWN_STATES = new Set([
  'ready',
  'loading',
  'dialog',
  'confirmation',
  'credential-prompt',
  'error',
  'empty',
  'unknown',
])

function decline(reason, detail) {
  return { classified: false, state: null, reason, detail, source: 'local', note: 'Classify locally.' }
}

function clamp01(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return null
  return Math.min(1, Math.max(0, numeric))
}

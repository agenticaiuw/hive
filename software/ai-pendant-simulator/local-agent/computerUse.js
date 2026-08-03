// Computer-use action handlers: mouse, screen capture, and the accessibility
// tier that the planner should reach for first.
//
// Design note — accessibility first. Clicking pixels is the fallback, not the
// default. `ui_find` / `ui_click` / `ui_menu` resolve a control BY NAME, which
// makes them layout independent, immune to the point-versus-pixel scaling bug
// class entirely (AXPosition is already in points), free of image tokens, and —
// most importantly — auditable: the trace records *what* was clicked, so a
// destructive control can be recognised before it is pressed. A raw
// mouse_click{x,y} has no name to check.

import fs from 'node:fs'
import path from 'node:path'
import { setTimeout as delay } from 'node:timers/promises'
import { workspacePath } from './config.js'
import { resolveUserPath } from './security.js'
import {
  captureObservation,
  releaseCaptures,
  sweepCaptures,
} from './screenCapture.js'
import {
  axFind,
  axHitTest,
  axMenu,
  axPress,
  axSnapshot,
  clickMouse,
  cursorPosition,
  dragMouse,
  listDisplays,
  mouseButtonPhase,
  moveMouse,
  pressChord,
  probeInput,
  scrollWheel,
  typeUnicode,
  validateButton,
  validateClicks,
  validateModifiers,
  validatePoint,
  validateScroll,
  validateSteps,
} from './uiControl.js'
import { assertOnScreen } from './coordinates.js'

// Controls whose activation is hard or impossible to walk back. Matching one
// does not silently proceed — the caller is told exactly which control it is.
export const DESTRUCTIVE_TITLE_PATTERN =
  /^(delete|move to trash|empty trash|erase|remove|send|buy|purchase|pay|place order|shut ?down|restart|log ?out|sign out|reset|format|revoke|deauthorize|unsubscribe|discard|don'?t save)\b/i

export const DEFAULT_SETTLE_MS = 350
// A window opening or a menu committing needs longer than a repaint.
export const SLOW_SETTLE_MS = 700

export function isDestructiveTitle(title) {
  return DESTRUCTIVE_TITLE_PATTERN.test(String(title || '').trim())
}

function success(action, message, extra = {}) {
  return { action, ok: true, status: 'success', message, ...extra }
}

async function settle(ms) {
  if (ms > 0) {
    await delay(ms)
  }
}

async function assertPointOnScreen(point) {
  const displays = await listDisplays()
  return assertOnScreen(point, displays)
}

// ---------------------------------------------------------------------------
// Mouse
// ---------------------------------------------------------------------------

export async function mouseMove(action) {
  const point = validatePoint(action.params, { label: 'mouse_move' })
  await assertPointOnScreen(point)
  await moveMouse(point)
  return success(action, `Moved the pointer to (${round(point.x)}, ${round(point.y)}).`, {
    point,
  })
}

export async function mouseClick(action, { defaultButton = 'left', defaultClicks = 1 } = {}) {
  const point = validatePoint(action.params, { label: 'mouse_click' })
  const button = validateButton(action.params?.button ?? defaultButton)
  const clicks = validateClicks(action.params?.clicks ?? defaultClicks)
  const modifiers = validateModifiers(action.params?.modifiers)
  const display = await assertPointOnScreen(point)

  // A click in the menu-bar strip or the menu-extras corner is how an agent
  // accidentally opens Wi-Fi, Focus or Shut Down. Require it to be declared.
  if (point.y < display.y + 25 && !action.params?.allowMenuBar) {
    throw new Error(
      `Refusing to click at (${round(point.x)}, ${round(point.y)}): that is the macOS menu bar. Use ui_menu for menus, or pass allowMenuBar: true if the menu bar is genuinely the target.`,
    )
  }

  const named = await axHitTest(point).catch(() => null)

  if (isDestructiveTitle(named?.title) && !action.params?.confirmDestructive) {
    throw new Error(
      `Refusing to click "${named.title}" — that control looks destructive. Ask the user to confirm, then retry with confirmDestructive: true.`,
    )
  }

  await clickMouse({ ...point, button, clicks, modifiers })
  await settle(DEFAULT_SETTLE_MS)

  const describedTarget = named?.named ? ` on "${named.title}"` : ' (no named control under the pointer)'
  return success(
    action,
    `${clicks === 1 ? 'Clicked' : `${clicks}x clicked`} ${button}${describedTarget} at (${round(point.x)}, ${round(point.y)}).`,
    { point, button, clicks, modifiers, target: named ?? null, named: Boolean(named?.named) },
  )
}

export async function mouseButton(action, phase) {
  const point = validatePoint(action.params, { label: `mouse_${phase}` })
  const button = validateButton(action.params?.button)
  const modifiers = validateModifiers(action.params?.modifiers)
  await assertPointOnScreen(point)
  await mouseButtonPhase({ phase, ...point, button, modifiers })
  return success(action, `Mouse ${button} button ${phase} at (${round(point.x)}, ${round(point.y)}).`, {
    point,
    button,
    phase,
  })
}

export async function mouseDrag(action) {
  const from = validatePoint(action.params, {
    xKey: 'fromX',
    yKey: 'fromY',
    label: 'mouse_drag start',
  })
  const to = validatePoint(action.params, {
    xKey: 'toX',
    yKey: 'toY',
    label: 'mouse_drag end',
  })
  const button = validateButton(action.params?.button)
  const steps = validateSteps(action.params?.steps)
  const modifiers = validateModifiers(action.params?.modifiers)

  await assertPointOnScreen(from)
  await assertPointOnScreen(to)

  await dragMouse({
    fromX: from.x,
    fromY: from.y,
    toX: to.x,
    toY: to.y,
    button,
    steps,
    modifiers,
  })
  await settle(DEFAULT_SETTLE_MS)

  return success(
    action,
    `Dragged from (${round(from.x)}, ${round(from.y)}) to (${round(to.x)}, ${round(to.y)}).`,
    { from, to, button, steps },
  )
}

export async function mouseScroll(action) {
  const { dx, dy } = validateScroll(action.params)
  const modifiers = validateModifiers(action.params?.modifiers)
  let point = null

  if (action.params?.x !== undefined || action.params?.y !== undefined) {
    point = validatePoint(action.params, { label: 'scroll' })
    await assertPointOnScreen(point)
  }

  await scrollWheel({ ...(point ?? {}), dx, dy, modifiers })
  await settle(DEFAULT_SETTLE_MS)

  return success(
    action,
    `Scrolled ${describeScroll(dx, dy)}${point ? ` at (${round(point.x)}, ${round(point.y)})` : ''}.`,
    { dx, dy, point },
  )
}

export async function readCursorPosition(action) {
  const point = await cursorPosition()
  return success(action, `The pointer is at (${round(point.x)}, ${round(point.y)}).`, { point })
}

export async function readDisplays(action) {
  const displays = await listDisplays()
  const summary = displays
    .map((display) => `#${display.index} ${display.w}x${display.h}pt @${display.scale}x`)
    .join(', ')
  return success(action, `${displays.length} display(s): ${summary}`, { displays })
}

export async function readInputPermissions(action) {
  const probe = await probeInput()
  return success(
    action,
    probe.axTrusted
      ? 'Accessibility is granted and synthesized events post successfully.'
      : 'Accessibility is NOT granted — mouse and keyboard actions will be silently ignored.',
    probe,
  )
}

// ---------------------------------------------------------------------------
// Screen capture
// ---------------------------------------------------------------------------

export async function takeScreenshot(action) {
  const params = action.params ?? {}
  const observation = await captureObservation({
    scope: params.scope,
    display: params.display,
    windowId: params.windowId,
    region: params.region,
    maxWidth: params.maxWidth,
    quality: params.quality,
    format: params.format,
    sessionId: params.sessionId || 'action',
  })

  if (observation.blocked) {
    throw new Error(observation.message)
  }

  // Callers that want a durable copy must ask for one explicitly; the default
  // capture is ephemeral and swept on a TTL.
  let savedPath = null

  if (params.path) {
    savedPath = resolveUserPath(params.path)
    fs.mkdirSync(path.dirname(savedPath), { recursive: true })
    fs.copyFileSync(observation.path, savedPath)
  } else if (params.keep) {
    savedPath = resolveUserPath(
      path.join(workspacePath, `screenshot-${Date.now()}.${observation.format === 'png' ? 'png' : 'jpg'}`),
    )
    fs.mkdirSync(path.dirname(savedPath), { recursive: true })
    fs.copyFileSync(observation.path, savedPath)
  }

  const includeImage = params.includeImage !== false

  return success(
    action,
    `Captured display #${observation.display.index}: ${observation.display.w}x${observation.display.h} points at ${observation.display.backingScale}x, downscaled to ${observation.image.width}x${observation.image.height} image pixels (${observation.scale.x.toFixed(5)} points per image pixel).${savedPath ? ` Saved to ${savedPath}.` : ''}`,
    {
      path: savedPath ?? observation.path,
      observationId: observation.id,
      display: observation.display,
      region: observation.region,
      image: observation.image,
      // Points per image pixel, per axis — the ONLY correct way back to screen
      // coordinates. Never derive this from the backing scale factor.
      scale: observation.scale,
      backingScale: observation.display.backingScale,
      frontmostApp: observation.frontmostApp,
      sha256: observation.sha256,
      mediaType: observation.mediaType,
      // The bytes appear once. A `dataUrl` alongside would double the response
      // for no gain — callers build it from mediaType + imageBase64.
      ...(includeImage ? { imageBase64: observation.imageBase64 } : {}),
    },
  )
}

// Reading 10pt UI text without paying for a full frame: capture just the region
// at native resolution, then downscale it on its own. The result carries its own
// region and per-axis scale, so coordinates map back through exactly the same
// conversion function — there is no second code path.
export async function zoomRegion(action) {
  const params = action.params ?? {}

  if (!params.region) {
    throw new Error('zoom requires a region {x, y, w, h} in screen points.')
  }

  return takeScreenshot({
    ...action,
    params: { ...params, maxWidth: params.maxWidth ?? 1024 },
  })
}

// ---------------------------------------------------------------------------
// Accessibility tier
// ---------------------------------------------------------------------------

export async function uiSnapshot(action) {
  const result = await axSnapshot({
    app: action.params?.app ?? 'frontmost',
    max: clampInt(action.params?.maxElements, 1, 400, 120),
  })

  const elements = action.params?.includeOffscreen
    ? result.elements
    : result.elements.filter((element) => !element.offscreen)

  return success(
    action,
    result.semanticAvailable
      ? `${result.app} exposes ${elements.length} actionable element(s).`
      : `${result.app} exposes no accessibility tree — fall back to screenshot plus mouse actions.`,
    { app: result.app, semanticAvailable: result.semanticAvailable, elements },
  )
}

export async function uiFind(action) {
  const result = await axFind(targetOf(action))
  return success(
    action,
    `Found ${result.element.role} "${result.element.title}" in ${result.app}.`,
    result,
  )
}

export async function uiClick(action) {
  const target = targetOf(action)
  const found = await axFind(target)
  const title = found.element?.title

  if (isDestructiveTitle(title) && !action.params?.confirmDestructive) {
    const error = new Error(
      `Refusing to press "${title}" in ${found.app} — that control looks destructive. Confirm with the user, then retry with confirmDestructive: true.`,
    )
    error.code = 'DESTRUCTIVE'
    throw error
  }

  const result = await axPress(target)
  await settle(SLOW_SETTLE_MS)

  return success(
    action,
    `Pressed ${result.element.role} "${result.element.title}" in ${result.app} (${result.method}).`,
    result,
  )
}

export async function uiMenu(action) {
  const menuPath = Array.isArray(action.params?.path)
    ? action.params.path.map((entry) => String(entry))
    : []
  const leaf = menuPath[menuPath.length - 1]

  if (isDestructiveTitle(leaf) && !action.params?.confirmDestructive) {
    const error = new Error(
      `Refusing to choose the menu item "${leaf}" — it looks destructive. Confirm with the user, then retry with confirmDestructive: true.`,
    )
    error.code = 'DESTRUCTIVE'
    throw error
  }

  const result = await axMenu({ app: action.params?.app ?? 'frontmost', path: menuPath })
  await settle(SLOW_SETTLE_MS)
  return success(action, `Chose menu path ${result.path.join(' > ')} in ${result.app}.`, result)
}

// Polling for a known target beats a blind sleep: it returns the moment the UI
// is ready and fails fast when it never becomes ready.
export async function uiWaitFor(action) {
  const timeoutMs = clampInt(action.params?.timeoutMs, 100, 60_000, 5000)
  const pollMs = clampInt(action.params?.pollMs, 50, 5000, 250)
  const deadline = Date.now() + timeoutMs
  const target = targetOf(action)
  let lastError = 'not found'

  while (Date.now() < deadline) {
    try {
      const result = await axFind(target)
      return success(
        action,
        `"${result.element.title}" appeared in ${result.app}.`,
        result,
      )
    } catch (error) {
      lastError = error.message
      await delay(pollMs)
    }
  }

  throw new Error(`Timed out after ${timeoutMs}ms waiting for the element (${lastError}).`)
}

export async function uiHitTest(action) {
  const point = validatePoint(action.params, { label: 'ui_hit_test' })
  const result = await axHitTest(point)
  return success(
    action,
    result.named
      ? `"${result.title}" (${result.role}) is at (${round(point.x)}, ${round(point.y)}).`
      : `No named control is at (${round(point.x)}, ${round(point.y)}).`,
    result,
  )
}

// ---------------------------------------------------------------------------
// Keyboard — CGEvent based, with the previous AppleScript path kept as a
// fallback so the agent stays functional where swiftc cannot build.
// ---------------------------------------------------------------------------

export async function pressKeysViaHelper(keys, { repeat = 1, holdMs = 0 } = {}) {
  return pressChord({ keys, repeat: clampInt(repeat, 1, 50, 1), holdMs: clampInt(holdMs, 0, 10_000, 0) })
}

export async function typeTextViaHelper(text, { perCharDelayMs = 0 } = {}) {
  return typeUnicode({ text, perCharDelayMs: clampInt(perCharDelayMs, 0, 200, 0) })
}

// ---------------------------------------------------------------------------

export function endObservationSession(sessionId) {
  releaseCaptures(sessionId)
}

export function sweepObservationSession(sessionId) {
  return sweepCaptures(sessionId)
}

function targetOf(action) {
  const params = action.params ?? {}
  const target = {
    app: params.app ?? 'frontmost',
    ref: params.ref,
    title: params.title,
    titleContains: params.titleContains,
    nth: clampInt(params.nth, 0, 50, 0),
  }

  if (!target.ref && !target.title && !target.titleContains) {
    throw new Error(
      `${action.type} requires one of: ref, title, or titleContains to identify the control.`,
    )
  }

  return target
}

function clampInt(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const numeric = Number(value)

  if (!Number.isFinite(numeric)) {
    throw new Error(`Expected a finite number, received ${String(value)}.`)
  }

  return Math.min(max, Math.max(min, Math.round(numeric)))
}

function describeScroll(dx, dy) {
  const parts = []
  if (dy) parts.push(`${Math.abs(dy)}px ${dy > 0 ? 'up' : 'down'}`)
  if (dx) parts.push(`${Math.abs(dx)}px ${dx > 0 ? 'left' : 'right'}`)
  return parts.join(' and ')
}

function round(value) {
  return Math.round(Number(value) * 10) / 10
}

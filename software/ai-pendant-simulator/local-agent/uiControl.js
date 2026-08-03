// Node wrapper around the aipendant-uicontrol Swift helper.
//
// Packaging note: this adds NO third-party or heavyweight native dependency.
// The helper is a single Swift file compiled lazily by the Xcode command line
// tools already on this machine, exactly like the existing ScreenOverlay.swift
// and InputSourceSelect.swift helpers. If swiftc is unavailable the keyboard
// actions fall back to the previous AppleScript implementation and the mouse
// actions fail closed with a clear message.
//
// The helper is always run as a short-lived DIRECT CHILD of the agent process
// so it inherits the app bundle's Accessibility TCC grant. Never detach it.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import { assertFinite } from './coordinates.js'

const execFileAsync = promisify(execFile)
const moduleDirectory = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_PATH = path.join(moduleDirectory, 'macos', 'UIControl.swift')
const BIN_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AIPendant')
const BIN_PATH = path.join(BIN_DIR, 'aipendant-uicontrol')

// Menu titles can contain any printable text, so segments are joined with a
// control character the Swift helper splits on.
const MENU_PATH_SEPARATOR = '\u0001'

export const MOUSE_BUTTONS = new Set(['left', 'right', 'middle'])
export const MODIFIERS = new Set([
  'cmd',
  'command',
  'meta',
  'shift',
  'alt',
  'option',
  'opt',
  'ctrl',
  'control',
  'fn',
  'function',
])

let cachedBinaryPromise = null

export function helperSourcePath() {
  return SOURCE_PATH
}

export function helperBinaryPath() {
  return BIN_PATH
}

export async function ensureUiHelper({ execFileImpl = execFileAsync } = {}) {
  if (cachedBinaryPromise) {
    return cachedBinaryPromise
  }

  cachedBinaryPromise = (async () => {
    fs.mkdirSync(BIN_DIR, { recursive: true })
    const sourceStat = fs.statSync(SOURCE_PATH)
    const needsBuild =
      !fs.existsSync(BIN_PATH) || fs.statSync(BIN_PATH).mtimeMs < sourceStat.mtimeMs

    if (needsBuild) {
      await execFileImpl(
        'swiftc',
        [
          '-O',
          '-framework',
          'AppKit',
          '-framework',
          'ApplicationServices',
          '-o',
          BIN_PATH,
          SOURCE_PATH,
        ],
        { timeout: 120_000 },
      )
      fs.chmodSync(BIN_PATH, 0o755)
    }

    return BIN_PATH
  })().catch((error) => {
    cachedBinaryPromise = null
    throw new Error(
      `Could not build the aipendant-uicontrol helper (${error.message}). Install the Xcode command line tools with: xcode-select --install`,
      { cause: error },
    )
  })

  return cachedBinaryPromise
}

export async function runUiHelper(
  args,
  // `binaryPath` exists so tests can exercise the parse/refusal path without
  // compiling anything.
  { execFileImpl = execFileAsync, timeout = 20_000, binaryPath = null } = {},
) {
  const binary = binaryPath ?? (await ensureUiHelper({ execFileImpl }))

  let stdout
  try {
    ;({ stdout } = await execFileImpl(binary, args, { timeout }))
  } catch (error) {
    stdout = error.stdout ?? ''
    const parsed = safeParse(stdout)

    if (parsed?.code) {
      const failure = new Error(parsed.message || `uicontrol failed: ${parsed.code}`)
      failure.code = parsed.code
      throw failure
    }

    throw new Error(
      String(error.stderr || error.message || 'uicontrol failed').trim(),
      { cause: error },
    )
  }

  const parsed = safeParse(stdout)

  if (!parsed) {
    throw new Error('uicontrol returned malformed output.')
  }

  if (parsed.ok === false) {
    const failure = new Error(parsed.message || 'uicontrol refused the request.')
    failure.code = parsed.code
    throw failure
  }

  return parsed
}

function safeParse(stdout) {
  const trimmed = String(stdout || '').trim()

  if (!trimmed) {
    return null
  }

  try {
    return JSON.parse(trimmed.split('\n').pop())
  } catch {
    return null
  }
}

// ---------------------------------------------------------------------------
// Strict parameter validation. Every one of these throws rather than coercing:
// `Number(undefined)` reaching a CGPoint produces a click at an arbitrary
// screen location, which is the worst possible failure mode for this feature.
// ---------------------------------------------------------------------------

export function validatePoint(params, { xKey = 'x', yKey = 'y', label = 'coordinate' } = {}) {
  if (params?.[xKey] === undefined || params?.[yKey] === undefined) {
    throw new Error(`${label} requires numeric ${xKey} and ${yKey} parameters.`)
  }

  return {
    x: assertFinite(params[xKey], `${label} ${xKey}`),
    y: assertFinite(params[yKey], `${label} ${yKey}`),
  }
}

export function validateButton(value) {
  if (value === undefined || value === null || value === '') {
    return 'left'
  }

  const button = String(value).toLowerCase()

  if (!MOUSE_BUTTONS.has(button)) {
    throw new Error(
      `Unsupported mouse button "${value}". Use one of: ${[...MOUSE_BUTTONS].join(', ')}.`,
    )
  }

  return button
}

export function validateClicks(value) {
  if (value === undefined || value === null || value === '') {
    return 1
  }

  const clicks = assertFinite(value, 'clicks')

  if (!Number.isInteger(clicks) || clicks < 1 || clicks > 3) {
    throw new Error('clicks must be the integer 1, 2, or 3.')
  }

  return clicks
}

export function validateModifiers(value) {
  if (value === undefined || value === null || value === '') {
    return []
  }

  const list = Array.isArray(value) ? value : String(value).split(/[+,]/)

  return list
    .map((entry) => String(entry).trim().toLowerCase())
    .filter(Boolean)
    .map((modifier) => {
      if (!MODIFIERS.has(modifier)) {
        throw new Error(
          `Unsupported modifier "${modifier}". Use one of: ${[...MODIFIERS].join(', ')}.`,
        )
      }

      return modifier
    })
}

export function validateScroll(params) {
  const dx = params?.dx === undefined ? 0 : assertFinite(params.dx, 'dx')
  const dy = params?.dy === undefined ? 0 : assertFinite(params.dy, 'dy')

  if (dx === 0 && dy === 0) {
    throw new Error('scroll requires a non-zero dx or dy (positive dy scrolls up).')
  }

  if (Math.abs(dx) > 10_000 || Math.abs(dy) > 10_000) {
    throw new Error('scroll deltas are limited to +/-10000 pixels per action.')
  }

  return { dx, dy }
}

export function validateSteps(value) {
  if (value === undefined || value === null || value === '') {
    return 24
  }

  const steps = assertFinite(value, 'steps')

  if (!Number.isInteger(steps) || steps < 2 || steps > 200) {
    throw new Error('steps must be an integer between 2 and 200.')
  }

  return steps
}

// ---------------------------------------------------------------------------
// Typed operations
// ---------------------------------------------------------------------------

const flag = (name, value) => [`--${name}`, String(value)]

export async function listDisplays(options = {}) {
  const result = await runUiHelper(['displays'], options)
  return result.displays ?? []
}

export async function cursorPosition(options = {}) {
  const result = await runUiHelper(['cursor'], options)
  return { x: result.x, y: result.y }
}

export async function probeInput(options = {}) {
  return runUiHelper(['probe'], options)
}

export async function moveMouse({ x, y }, options = {}) {
  return runUiHelper(['move', ...flag('x', x), ...flag('y', y)], options)
}

export async function clickMouse(
  { x, y, button = 'left', clicks = 1, modifiers = [] },
  options = {},
) {
  return runUiHelper(
    [
      'click',
      ...flag('x', x),
      ...flag('y', y),
      ...flag('button', button),
      ...flag('clicks', clicks),
      ...flag('modifiers', modifiers.join(',')),
    ],
    options,
  )
}

export async function mouseButtonPhase(
  { phase, x, y, button = 'left', modifiers = [] },
  options = {},
) {
  return runUiHelper(
    [
      phase,
      ...flag('x', x),
      ...flag('y', y),
      ...flag('button', button),
      ...flag('modifiers', modifiers.join(',')),
    ],
    options,
  )
}

export async function dragMouse(
  { fromX, fromY, toX, toY, button = 'left', steps = 24, modifiers = [] },
  options = {},
) {
  return runUiHelper(
    [
      'drag',
      ...flag('fromX', fromX),
      ...flag('fromY', fromY),
      ...flag('toX', toX),
      ...flag('toY', toY),
      ...flag('button', button),
      ...flag('steps', steps),
      ...flag('modifiers', modifiers.join(',')),
    ],
    { timeout: 30_000, ...options },
  )
}

export async function scrollWheel({ x, y, dx, dy, modifiers = [] }, options = {}) {
  const args = ['scroll', ...flag('dx', dx), ...flag('dy', dy)]

  if (x !== undefined && y !== undefined) {
    args.push(...flag('x', x), ...flag('y', y))
  }

  args.push(...flag('modifiers', modifiers.join(',')))
  return runUiHelper(args, options)
}

export async function pressChord({ keys, repeat = 1, holdMs = 0 }, options = {}) {
  return runUiHelper(
    ['key', ...flag('keys', keys), ...flag('repeat', repeat), ...flag('holdMs', holdMs)],
    options,
  )
}

export async function typeUnicode({ text, perCharDelayMs = 0 }, options = {}) {
  return runUiHelper(
    ['type', ...flag('text', text), ...flag('perCharDelayMs', perCharDelayMs)],
    { timeout: 60_000, ...options },
  )
}

export async function axSnapshot({ app = 'frontmost', max = 120 }, options = {}) {
  return runUiHelper(['snapshot', ...flag('app', app), ...flag('max', max)], options)
}

export async function axFind({ app = 'frontmost', ref, title, titleContains, nth = 0 }, options = {}) {
  const args = ['find', ...flag('app', app), ...flag('nth', nth)]
  if (ref) args.push(...flag('ref', ref))
  if (title) args.push(...flag('title', title))
  if (titleContains) args.push(...flag('titleContains', titleContains))
  return runUiHelper(args, options)
}

export async function axPress({ app = 'frontmost', ref, title, titleContains, nth = 0 }, options = {}) {
  const args = ['press', ...flag('app', app), ...flag('nth', nth)]
  if (ref) args.push(...flag('ref', ref))
  if (title) args.push(...flag('title', title))
  if (titleContains) args.push(...flag('titleContains', titleContains))
  return runUiHelper(args, options)
}

export async function axMenu({ app = 'frontmost', path: menuPath }, options = {}) {
  if (!Array.isArray(menuPath) || !menuPath.length) {
    throw new Error('ui_menu requires a non-empty path array, e.g. ["File","Save"].')
  }

  return runUiHelper(
    ['menu', ...flag('app', app), ...flag('path', menuPath.join(MENU_PATH_SEPARATOR))],
    { timeout: 30_000, ...options },
  )
}

export async function axHitTest({ x, y }, options = {}) {
  return runUiHelper(['hittest', ...flag('x', x), ...flag('y', y)], options)
}

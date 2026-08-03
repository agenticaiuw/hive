// Screen capture for computer use.
//
// Uses only stock macOS binaries — /usr/sbin/screencapture (which already works
// because the agent app holds the Screen Recording TCC grant) and /usr/bin/sips
// for the downscale. No new dependency, no image library.
//
// Screenshots are the single most sensitive thing this agent can read, so
// captures are EPHEMERAL by default: they live in a 0700 per-session directory
// under the system temp dir, are swept on a TTL, and the whole directory is
// removed when the agent starts.

import crypto from 'node:crypto'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { computeImageScale } from './coordinates.js'
import { listDisplays, probeInput } from './uiControl.js'

const execFileAsync = promisify(execFile)

export const CAPTURE_ROOT = path.join(os.tmpdir(), 'aipendant-observations')
const RETENTION_MS = Number(process.env.PENDANT_SCREENSHOT_TTL_MS || 30 * 60 * 1000)
const MAX_RETAINED = Number(process.env.PENDANT_SCREENSHOT_KEEP || 20)
const KEEP_SCREENSHOTS = process.env.PENDANT_KEEP_SCREENSHOTS === '1'

// Capturing these means uploading credentials or private conversations to a
// third-party inference provider. Refuse rather than redact.
const DEFAULT_DENY_APPS = [
  '1Password',
  'Keychain Access',
  'Passwords',
  'Bitwarden',
  'System Settings',
  'Messages',
  'Mail',
]

export function deniedApps() {
  const configured = String(process.env.PENDANT_SCREENSHOT_DENY_APPS || '').trim()
  const list = configured ? configured.split(',') : DEFAULT_DENY_APPS
  return list.map((entry) => entry.trim().toLowerCase()).filter(Boolean)
}

export function isDeniedApp(appName, denyList = deniedApps()) {
  const name = String(appName || '').trim().toLowerCase()

  if (!name) {
    return false
  }

  return denyList.some((denied) => name === denied || name.includes(denied))
}

export function purgeAllCaptures() {
  fs.rmSync(CAPTURE_ROOT, { recursive: true, force: true })
}

export function captureDirectory(sessionId = 'default') {
  const safeSession = String(sessionId).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64) || 'default'
  const directory = path.join(CAPTURE_ROOT, safeSession)
  fs.mkdirSync(directory, { recursive: true, mode: 0o700 })
  return directory
}

export function sweepCaptures(sessionId = 'default', now = Date.now()) {
  if (KEEP_SCREENSHOTS) {
    return []
  }

  const directory = captureDirectory(sessionId)
  const entries = fs
    .readdirSync(directory)
    .map((name) => {
      const filePath = path.join(directory, name)
      return { filePath, mtimeMs: fs.statSync(filePath).mtimeMs }
    })
    .sort((left, right) => right.mtimeMs - left.mtimeMs)

  const removed = []
  entries.forEach((entry, index) => {
    if (index >= MAX_RETAINED || now - entry.mtimeMs > RETENTION_MS) {
      fs.rmSync(entry.filePath, { force: true })
      removed.push(entry.filePath)
    }
  })

  return removed
}

export function releaseCaptures(sessionId = 'default') {
  if (KEEP_SCREENSHOTS) {
    return
  }

  fs.rmSync(captureDirectory(sessionId), { recursive: true, force: true })
}

export async function frontmostApp({ execFileImpl = execFileAsync } = {}) {
  try {
    const { stdout } = await execFileImpl(
      'osascript',
      [
        '-e',
        'tell application "System Events" to get name of first application process whose frontmost is true',
      ],
      { timeout: 8000 },
    )
    return String(stdout).trim()
  } catch {
    return ''
  }
}

export async function imageDimensions(filePath, { execFileImpl = execFileAsync } = {}) {
  const { stdout } = await execFileImpl(
    'sips',
    ['-g', 'pixelWidth', '-g', 'pixelHeight', filePath],
    { timeout: 15_000 },
  )
  const width = Number(/pixelWidth:\s*(\d+)/.exec(stdout)?.[1])
  const height = Number(/pixelHeight:\s*(\d+)/.exec(stdout)?.[1])

  if (!Number.isFinite(width) || !Number.isFinite(height)) {
    throw new Error('Could not read captured image dimensions.')
  }

  return { width, height }
}

/**
 * Capture the screen and return a structured observation.
 *
 * The returned object separates the image bytes (`imageBase64`) from everything
 * else so callers can persist the metadata and drop the bytes — see
 * `stripImageBytes`.
 */
export async function captureObservation(params = {}, deps = {}) {
  const {
    execFileImpl = execFileAsync,
    displaysImpl = listDisplays,
    probeImpl = probeInput,
    frontmostImpl = frontmostApp,
    dimensionsImpl = imageDimensions,
  } = deps

  const scope = String(params.scope || 'display')
  const maxWidth = clampNumber(params.maxWidth, 320, 3000, 1456)
  const quality = clampNumber(params.quality, 20, 95, 72)
  const format = params.format === 'png' ? 'png' : 'jpeg'
  const sessionId = params.sessionId || 'default'

  const probe = await probeImpl().catch(() => null)

  // The secure-input interlock also covers capture: if a password field has
  // focus, the frame very likely contains a credential prompt.
  if (probe?.secureInput) {
    return {
      blocked: 'secure_input',
      message:
        'Refusing to capture the screen: macOS secure input is active (a password field has focus).',
    }
  }

  const app = await frontmostImpl({ execFileImpl })

  if (isDeniedApp(app)) {
    return {
      blocked: 'sensitive_app',
      app,
      message: `Refusing to capture the screen while ${app} is frontmost. Use the accessibility actions instead, or bring a different app forward.`,
    }
  }

  const displays = probe?.displays?.length ? probe.displays : await displaysImpl()

  if (!displays.length) {
    throw new Error('No active displays were reported.')
  }

  const displayIndex = clampNumber(params.display, 1, displays.length, 1)
  const display = displays[displayIndex - 1]

  // `screencapture -R` consumes POINTS and renders at the backing scale, so the
  // region needs no conversion on the way in.
  const region = resolveRegion(params.region, display)

  const directory = captureDirectory(sessionId)
  sweepCaptures(sessionId)

  const stamp = `${Date.now()}-${crypto.randomBytes(4).toString('hex')}`
  const rawPath = path.join(directory, `raw-${stamp}.png`)
  const outPath = path.join(directory, `obs-${stamp}.${format === 'png' ? 'png' : 'jpg'}`)

  const args = ['-x', '-o']

  if (params.region) {
    args.push('-R', `${region.x},${region.y},${region.w},${region.h}`)
  } else if (scope === 'window' && params.windowId !== undefined) {
    args.push('-l', String(params.windowId))
  } else {
    args.push(`-D${displayIndex}`)
  }

  args.push(rawPath)
  await execFileImpl('screencapture', args, { timeout: 20_000 })

  if (!fs.existsSync(rawPath)) {
    throw new Error('screencapture produced no file — is the Screen Recording permission granted?')
  }

  fs.chmodSync(rawPath, 0o600)

  const sipsArgs = ['-Z', String(maxWidth)]

  if (format === 'jpeg') {
    sipsArgs.push('-s', 'format', 'jpeg', '-s', 'formatOptions', String(quality))
  }

  sipsArgs.push(rawPath, '--out', outPath)
  await execFileImpl('sips', sipsArgs, { timeout: 30_000 })
  fs.chmodSync(outPath, 0o600)
  fs.rmSync(rawPath, { force: true })

  // Read the ACTUAL post-downscale dimensions rather than assuming maxWidth was
  // reached: the axes round independently and the ratio must match the bytes.
  const image = await dimensionsImpl(outPath, { execFileImpl })
  const bytes = fs.readFileSync(outPath)
  const scale = computeImageScale(region, image)

  return {
    id: stamp,
    path: outPath,
    sessionId,
    display: {
      index: displayIndex,
      id: display.id,
      x: display.x,
      y: display.y,
      w: display.w,
      h: display.h,
      backingScale: display.scale,
    },
    region,
    image: { width: image.width, height: image.height, bytes: bytes.length },
    // Points per image pixel, per axis.
    scale,
    format,
    frontmostApp: app,
    cursor: probe?.cursor ?? null,
    secureInput: Boolean(probe?.secureInput),
    sha256: crypto.createHash('sha256').update(bytes).digest('hex'),
    imageBase64: bytes.toString('base64'),
    mediaType: format === 'png' ? 'image/png' : 'image/jpeg',
  }
}

export function observationDataUrl(observation) {
  if (!observation?.imageBase64) {
    return null
  }

  return `data:${observation.mediaType};base64,${observation.imageBase64}`
}

// Re-exported so the existing importers keep a single obvious source, while the
// implementation stays in a leaf module the cloud bridge can import on its own.
export { stripImageBytes } from './redaction.js'

function resolveRegion(region, display) {
  if (!region) {
    return { x: display.x, y: display.y, w: display.w, h: display.h }
  }

  const values = ['x', 'y', 'w', 'h'].map((key) => Number(region[key]))

  if (values.some((value) => !Number.isFinite(value))) {
    throw new Error('region requires finite numeric x, y, w and h in points.')
  }

  const [x, y, w, h] = values

  if (w <= 0 || h <= 0) {
    throw new Error('region width and height must be positive.')
  }

  return { x, y, w, h }
}

function clampNumber(value, min, max, fallback) {
  if (value === undefined || value === null || value === '') {
    return fallback
  }

  const numeric = Number(value)

  if (!Number.isFinite(numeric)) {
    throw new Error(`Expected a finite number, received ${String(value)}.`)
  }

  return Math.min(max, Math.max(min, Math.round(numeric)))
}

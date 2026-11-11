import { spawn, execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { setTimeout as sleep } from 'node:timers/promises'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const SOURCE_PATH = path.join(__dirname, 'macos', 'ScreenOverlay.swift')
const BIN_DIR = path.join(os.homedir(), 'Library', 'Application Support', 'AIPendant')
const BIN_PATH = path.join(BIN_DIR, 'aipendant-screen-overlay')

/**
 * Show a native always-on-top screen overlay (AppKit).
 * Esc or click on the panel dismisses. Only reports success after "ready".
 */
export async function showScreenOverlay({
  region = 'left',
  color = 'black',
  opacity = 1,
  fraction = null,
  percent = null,
} = {}) {
  const normalized = normalizeRegion(region)
  const coverage = normalizeFraction(fraction, percent, normalized)
  const binary = await ensureOverlayHelper()

  const child = spawn(
    binary,
    [
      normalized,
      String(color || 'black'),
      String(clampOpacity(opacity)),
      String(coverage),
    ],
    {
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
    },
  )

  let settled = false
  const ready = await new Promise((resolve, reject) => {
    let stdout = ''
    let stderr = ''

    const failTimer = setTimeout(() => {
      if (settled) return
      settled = true
      try {
        child.kill('SIGTERM')
      } catch {
        // ignore
      }
      reject(
        new Error(
          `Screen overlay did not become ready in time.${stderr ? ` ${stderr.trim()}` : ''}`,
        ),
      )
    }, 4000)

    child.stdout?.on('data', (chunk) => {
      stdout += String(chunk)
      if (!settled && /ready\b/i.test(stdout)) {
        settled = true
        clearTimeout(failTimer)
        resolve({ stdout, stderr })
      }
    })

    child.stderr?.on('data', (chunk) => {
      stderr += String(chunk)
    })

    child.on('error', (error) => {
      if (settled) return
      settled = true
      clearTimeout(failTimer)
      reject(error)
    })

    child.on('exit', (code, signal) => {
      if (settled) return
      settled = true
      clearTimeout(failTimer)
      reject(
        new Error(
          `Screen overlay exited before ready (code=${code}, signal=${signal}).${
            stderr ? ` ${stderr.trim()}` : ''
          }`,
        ),
      )
    })
  })

  // Detach from the agent process tree so the panel stays up after the request.
  try {
    child.unref()
  } catch {
    // ignore
  }

  await sleep(150)
  if (!isPidAlive(child.pid)) {
    throw new Error(
      `Screen overlay closed right after opening.${
        ready.stderr ? ` ${ready.stderr.trim()}` : ''
      }`,
    )
  }

  return {
    region: normalized,
    color,
    opacity: clampOpacity(opacity),
    fraction: coverage,
    percent: Math.round(coverage * 100),
    pid: child.pid,
    dismiss: 'Press Esc (or click the dark panel) to dismiss',
  }
}

function normalizeRegion(region) {
  const value = String(region || 'left').toLowerCase().trim()
  if (['left', 'right', 'top', 'bottom', 'full', 'all'].includes(value)) {
    return value === 'all' ? 'full' : value
  }
  if (/left|왼쪽/.test(value)) return 'left'
  if (/right|오른쪽/.test(value)) return 'right'
  if (/top|위|upper/.test(value)) return 'top'
  if (/bottom|아래|lower/.test(value)) return 'bottom'
  if (/full|entire|whole|전체/.test(value)) return 'full'
  return 'left'
}

function normalizeFraction(fraction, percent, region) {
  if (fraction !== null && fraction !== undefined && Number.isFinite(Number(fraction))) {
    return clampFraction(Number(fraction))
  }
  if (percent !== null && percent !== undefined && Number.isFinite(Number(percent))) {
    const value = Number(percent)
    return clampFraction(value > 1 ? value / 100 : value)
  }
  return region === 'full' ? 1 : 0.5
}

function clampFraction(value) {
  if (!Number.isFinite(value)) return 0.5
  return Math.min(1, Math.max(0.05, value))
}

function clampOpacity(value) {
  const numeric = Number(value)
  if (!Number.isFinite(numeric)) return 1
  return Math.min(1, Math.max(0.2, numeric))
}

function isPidAlive(pid) {
  if (!pid) return false
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

async function ensureOverlayHelper() {
  fs.mkdirSync(BIN_DIR, { recursive: true })
  const sourceStat = fs.statSync(SOURCE_PATH)
  const needsBuild =
    !fs.existsSync(BIN_PATH) ||
    fs.statSync(BIN_PATH).mtimeMs < sourceStat.mtimeMs

  if (needsBuild) {
    await execFileAsync(
      'swiftc',
      ['-O', '-framework', 'AppKit', '-o', BIN_PATH, SOURCE_PATH],
      { timeout: 90000 },
    )
    fs.chmodSync(BIN_PATH, 0o755)
  }

  return BIN_PATH
}

export function inferOverlayRegion(command = '') {
  const text = String(command).toLowerCase()
  if (/right half|오른쪽/.test(text)) return 'right'
  if (/top half|upper half|위쪽|상단|top\s+\d/.test(text)) return 'top'
  if (/bottom half|lower half|아래|하단/.test(text)) return 'bottom'
  if (/full screen|entire screen|whole screen|전체/.test(text)) return 'full'
  if (/left half|왼쪽/.test(text)) return 'left'
  return 'left'
}

export function inferOverlayFraction(command = '') {
  const text = String(command || '')
  const match =
    text.match(/(\d{1,3})\s*%/) ||
    text.match(/\b(0?\.\d+)\b/) ||
    text.match(/\b(\d{1,3})\s*(?:percent|pct)\b/i)
  if (!match) return null
  const value = Number(match[1])
  if (!Number.isFinite(value)) return null
  return clampFraction(value > 1 ? value / 100 : value)
}

export function looksLikeScreenOverlayRequest(command = '') {
  const text = String(command).toLowerCase()
  return (
    /(half|half of|부분|반|\d{1,3}\s*%).*(dark|black|dim|cover|overlay|어둡|검)|((dark|black|dim|cover|overlay|어둡|검).*(half|screen|화면|\d{1,3}\s*%))/.test(
      text,
    ) ||
    (/overlay|cover/.test(text) && /screen|화면/.test(text))
  )
}

import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { spawnSync } from 'node:child_process'

const execFileAsync = promisify(execFile)

/**
 * Direct macOS system controls that should not go through fragile LLM shell plans.
 */
export async function setDisplayBrightness(level) {
  const value = normalizeUnitInterval(level)
  const script = `
from ctypes import CDLL, c_float, c_int, c_uint32, byref, POINTER
lib = CDLL('/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices')
get = lib.DisplayServicesGetBrightness
get.argtypes = [c_uint32, POINTER(c_float)]
get.restype = c_int
setb = lib.DisplayServicesSetBrightness
setb.argtypes = [c_uint32, c_float]
setb.restype = c_int
quartz = CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
quartz.CGMainDisplayID.restype = c_uint32
display = quartz.CGMainDisplayID()
before = c_float()
get_rc = get(c_uint32(display), byref(before))
set_rc = setb(c_uint32(display), c_float(${value}))
after = c_float()
get(c_uint32(display), byref(after))
print(f"{display}\\t{get_rc}\\t{set_rc}\\t{before.value}\\t{after.value}")
`

  const result = runPython(script)
  const [display, getRc, setRc, before, after] = result.trim().split('\t')

  if (Number(setRc) !== 0) {
    throw new Error(
      `Could not set display brightness (display ${display}, code ${setRc}).`,
    )
  }

  return {
    display: Number(display),
    before: Number(before),
    after: Number(after),
    percent: Math.round(Number(after) * 100),
    getOk: Number(getRc) === 0,
  }
}

export async function getDisplayBrightness() {
  const script = `
from ctypes import CDLL, c_float, c_int, c_uint32, byref, POINTER
lib = CDLL('/System/Library/PrivateFrameworks/DisplayServices.framework/DisplayServices')
get = lib.DisplayServicesGetBrightness
get.argtypes = [c_uint32, POINTER(c_float)]
get.restype = c_int
quartz = CDLL('/System/Library/Frameworks/CoreGraphics.framework/CoreGraphics')
quartz.CGMainDisplayID.restype = c_uint32
display = quartz.CGMainDisplayID()
value = c_float()
rc = get(c_uint32(display), byref(value))
print(f"{display}\\t{rc}\\t{value.value}")
`
  const result = runPython(script)
  const [display, rc, value] = result.trim().split('\t')

  if (Number(rc) !== 0) {
    throw new Error(`Could not read display brightness (code ${rc}).`)
  }

  return {
    display: Number(display),
    value: Number(value),
    percent: Math.round(Number(value) * 100),
  }
}

export async function setOutputVolume(level) {
  const before = await getOutputVolume()
  const percent = normalizePercent(level)
  await execFileAsync('osascript', [
    '-e',
    `set volume output volume ${percent}`,
  ])
  const current = await getOutputVolume()
  return {
    ...current,
    before,
  }
}

export async function getOutputVolume() {
  // osascript prints only the LAST -e expression, so the previous two-flag form
  // silently returned just the mute flag: every volume readback parsed "false"
  // as a number and reported NaN%. One statement, one printed line, both values.
  const { stdout } = await execFileAsync('osascript', [
    '-e',
    'set s to (get volume settings)',
    '-e',
    '(output volume of s as text) & "\t" & (output muted of s as text)',
  ])
  const [volumeField, mutedField] = stdout.trim().split('\t')
  return {
    percent: Number(volumeField),
    muted: String(mutedField).trim() === 'true',
  }
}

export async function setOutputMuted(muted) {
  const before = await getOutputVolume()
  const flag = muted ? 'true' : 'false'
  await execFileAsync('osascript', ['-e', `set volume output muted ${flag}`])
  const current = await getOutputVolume()
  return {
    ...current,
    before,
  }
}

function runPython(script) {
  const result = spawnSync('python3', ['-c', script], {
    encoding: 'utf8',
    timeout: 15_000,
  })

  if (result.status !== 0) {
    throw new Error(
      (result.stderr || result.stdout || 'python brightness helper failed').trim(),
    )
  }

  return result.stdout || ''
}

function normalizeUnitInterval(level) {
  const numeric = Number(level)

  if (!Number.isFinite(numeric)) {
    throw new Error('Brightness level must be a number.')
  }

  if (numeric > 1) {
    return Math.min(1, Math.max(0, numeric / 100))
  }

  return Math.min(1, Math.max(0, numeric))
}

function normalizePercent(level) {
  const numeric = Number(level)

  if (!Number.isFinite(numeric)) {
    throw new Error('Volume level must be a number.')
  }

  if (numeric <= 1 && numeric >= 0 && String(level).includes('.')) {
    return Math.round(numeric * 100)
  }

  return Math.min(100, Math.max(0, Math.round(numeric)))
}

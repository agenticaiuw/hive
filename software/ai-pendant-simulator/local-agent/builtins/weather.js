import { execFile } from 'node:child_process'
import { promisify } from 'node:util'

const execFileAsync = promisify(execFile)

export async function runWeatherBuiltin({ slots, command }) {
  let location = slots.location ?? inferLocation(command) ?? 'Seoul'
  location = normalizeLocation(location)
  const query = encodeURIComponent(location.replace(/\s+/g, '+'))
  const { stdout } = await execFileAsync('curl', [
    '-fsS',
    `https://wttr.in/${query}?format=3`,
  ])
  const response = stdout.trim()

  return {
    summary: `Weather for ${location}`,
    response,
    metadata: { location },
  }
}

function inferLocation(command) {
  const english = command.match(/\b(?:in|at|for)\s+([A-Za-z\s]+)/i)?.[1]?.trim()
  const korean = command.match(/([가-힣]+)\s*날씨/)?.[1]?.trim()
  return normalizeLocation(english || korean || null)
}

function normalizeLocation(value) {
  const location = String(value || '').trim()
  if (!location) return 'Seoul'
  if (
    /^(today|tonight|tomorrow|now|is the weather|the weather|오늘|내일|모레|지금|현재)$/i.test(
      location,
    )
  ) {
    return 'Seoul'
  }
  return location
}

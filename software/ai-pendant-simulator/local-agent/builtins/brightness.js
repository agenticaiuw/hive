import { setDisplayBrightness } from '../systemControls.js'

export async function runBrightnessBuiltin({ command, slots }) {
  const level = slots.level ?? parseBrightnessLevel(command)

  if (level == null) {
    return {
      summary: 'Need a brightness level',
      response:
        'Tell me a brightness level like 50%, 0.5, max, or dim.',
      actions: [],
      metadata: {},
    }
  }

  const result = await setDisplayBrightness(level)

  return {
    summary: `Brightness set to ${result.percent}%`,
    response: `Done — display brightness is now ${result.percent}%.`,
    actions: [],
    metadata: result,
  }
}

function parseBrightnessLevel(command = '') {
  const text = String(command).toLowerCase()

  if (/\b(max|full|brightest|최대)\b/.test(text)) return 1
  if (/\b(min|minimum|darkest|최저)\b/.test(text)) return 0.05
  if (/\b(dim|낮춰|어둡)\b/.test(text) && !/\d/.test(text)) return 0.25
  if (/\b(brighter|높여|밝게)\b/.test(text) && !/\d/.test(text)) return 0.85
  if (/\b(half|중간|절반)\b/.test(text)) return 0.5

  const percent = text.match(/(\d{1,3})\s*%/)
  if (percent) return Number(percent[1])

  const fraction = text.match(/\b(0?\.\d+)\b/)
  if (fraction) return Number(fraction[1])

  const bare = text.match(/\b(\d{1,3})\b/)
  if (bare) {
    const value = Number(bare[1])
    return value > 1 ? value : value
  }

  return null
}

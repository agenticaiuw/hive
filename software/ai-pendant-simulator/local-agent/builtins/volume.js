import {
  getOutputVolume,
  setOutputMuted,
  setOutputVolume,
} from '../systemControls.js'

export async function runVolumeBuiltin({ command, slots }) {
  const text = String(command).toLowerCase()

  if (/\b(unmute|음소거 해제)\b/.test(text)) {
    const result = await setOutputMuted(false)
    return {
      summary: `Volume unmuted (${result.percent}%)`,
      response: `Unmuted. Volume is ${result.percent}%.`,
      actions: [],
      metadata: result,
    }
  }

  if (/\b(mute|음소거)\b/.test(text)) {
    const result = await setOutputMuted(true)
    return {
      summary: 'Volume muted',
      response: 'Muted.',
      actions: [],
      metadata: result,
    }
  }

  const level = slots.level ?? parseVolumeLevel(command)

  if (level == null) {
    const current = await getOutputVolume()
    return {
      summary: `Volume is ${current.percent}%`,
      response: current.muted
        ? `Volume is muted (level ${current.percent}%).`
        : `Volume is ${current.percent}%.`,
      actions: [],
      metadata: current,
    }
  }

  const result = await setOutputVolume(level)
  return {
    summary: `Volume set to ${result.percent}%`,
    response: `Done — volume is now ${result.percent}%.`,
    actions: [],
    metadata: result,
  }
}

function parseVolumeLevel(command = '') {
  const text = String(command).toLowerCase()

  if (/\b(max|full|최대)\b/.test(text)) return 100
  if (/\b(min|minimum|최저)\b/.test(text)) return 5
  if (/\b(half|중간|절반)\b/.test(text)) return 50

  const percent = text.match(/(\d{1,3})\s*%/)
  if (percent) return Number(percent[1])

  const bare = text.match(/\b(\d{1,3})\b/)
  if (bare) return Number(bare[1])

  return null
}

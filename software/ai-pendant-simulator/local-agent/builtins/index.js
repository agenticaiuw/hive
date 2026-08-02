import { runTimeBuiltin } from './time.js'
import { runWeatherBuiltin } from './weather.js'
import { runTranslateBuiltin } from './translate.js'
import { runMeetingBuiltin } from './meeting.js'
import { runBrightnessBuiltin } from './brightness.js'
import { runVolumeBuiltin } from './volume.js'
import { runReminderBuiltin } from './reminder.js'

const handlers = {
  time: runTimeBuiltin,
  weather: runWeatherBuiltin,
  translate: runTranslateBuiltin,
  meeting: runMeetingBuiltin,
  brightness: runBrightnessBuiltin,
  volume: runVolumeBuiltin,
  reminder: runReminderBuiltin,
}

export async function runBuiltin({ builtin, command, slots, context }) {
  const handler = handlers[builtin]

  if (!handler) {
    throw new Error(`Unknown builtin program: ${builtin}`)
  }

  const result = await handler({ command, slots, context })

  return {
    status: 'instant',
    mode: 'builtin',
    builtin,
    command,
    requiresConfirmation: false,
    summary: result.summary,
    response: result.response,
    actions: result.actions ?? [],
    metadata: result.metadata ?? {},
  }
}

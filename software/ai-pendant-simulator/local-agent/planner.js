/**
 * Legacy rules planner — intentionally empty.
 *
 * No keyword / string matching of user speech. All real planning is done by:
 * - cloud audio-native OpenAI (planFromAudio), or
 * - local LLM planner (llmPlanner.planCommand).
 *
 * Kept only so imports/tests have a stable module; do not reintroduce
 * if (command.includes(...)) action tables here.
 */
export function planCommand(command) {
  const rawCommand = String(command || '').trim()

  if (!rawCommand) {
    return {
      status: 'unsupported',
      command: '',
      actions: [],
      requiresConfirmation: false,
      error: 'Empty command.',
      planner: 'rules',
    }
  }

  return {
    status: 'unsupported',
    command: rawCommand,
    actions: [],
    requiresConfirmation: false,
    error:
      'No string-matching planner. Use the LLM planner (LLM_API_KEY) or cloud audio-native plan.',
    planner: 'rules',
  }
}

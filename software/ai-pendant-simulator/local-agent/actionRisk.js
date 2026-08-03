// A pendant command is hands-free: there is no screen to confirm on and no
// keyboard to cancel with. It is also remote — the command text arrives from
// the cloud relay work queue, so whatever can enqueue a job is what this
// allowlist is actually protecting the Mac against.
//
// The rule that follows from that: only read-only and UI-level actions run
// without approval. Anything that can author code or content the machine will
// then execute — shell, AppleScript, file writes and file moves — waits for an
// explicit confirmation, no matter how harmless the command text looks. There
// is deliberately no "looks destructive" pattern here: `find . -delete`,
// `chmod -R`, `launchctl`, `osascript -e`, `python3 -c`, `nc`, `> ~/.zshrc` and
// `git checkout .` are all arbitrary code execution and none of them contain
// the word `rm`. A regex over shell text cannot separate the safe half from
// the unrecoverable half, so it is not used to grant anything.

const AUTO_SAFE_ACTIONS = new Set([
  'open_app',
  'open_url',
  'open_path',
  'open_folder',
  'read_file',
  'list_directory',
  'screenshot',
  'zoom',
  'ui_snapshot',
  'ui_find',
  'ui_click',
  'ui_menu',
  'ui_wait_for',
  'ui_hit_test',
  'mouse_move',
  'mouse_click',
  'scroll',
  'type_text',
  'press_keys',
  'set_brightness',
  'get_brightness',
  'set_volume',
  'get_volume',
  'set_mute',
  'create_reminder',
  'show_screen_overlay',
  'get_clipboard',
  'copy_to_clipboard',
  'set_clipboard',
  'play_youtube',
])

// Held back from the hands-free path. Unknown action types are refused too —
// this map exists so the pendant can say something specific rather than
// "not on the allowlist".
const CONFIRM_REASONS = new Map([
  ['run_shell', 'Running a shell command needs your approval.'],
  ['run_project', 'Running a project command needs your approval.'],
  ['run_applescript', 'Running AppleScript needs your approval.'],
  ['write_file', 'Writing a file needs your approval.'],
  ['copy_path', 'Copying a file needs your approval.'],
  ['move_path', 'Moving a file needs your approval.'],
  ['delete_path', 'Deleting a file needs your approval.'],
  ['send_email', 'Sending email acts on your behalf and needs approval.'],
  ['send_message', 'Sending a message acts on your behalf and needs approval.'],
  [
    'computer_use_task',
    'Driving the screen on its own needs your approval.',
  ],
])

export function classifyAction(action) {
  const type = String(action?.type || '')
  if (!type) return { safe: false, reason: 'Action has no type.' }
  const confirmReason = CONFIRM_REASONS.get(type)
  if (confirmReason) return { safe: false, reason: confirmReason }
  if (AUTO_SAFE_ACTIONS.has(type)) return { safe: true }
  // Default deny: a newly added action type is unconfirmed remote capability
  // until someone decides otherwise.
  return { safe: false, reason: `${type} is not on the hands-free allowlist.` }
}

export function classifyPlan(actions) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) return { autoRun: false, blocked: [], reason: 'No actions to run.' }
  const blocked = []
  for (const action of list) {
    const verdict = classifyAction(action)
    if (!verdict.safe) blocked.push({ type: action?.type ?? 'unknown', reason: verdict.reason })
  }
  return {
    autoRun: blocked.length === 0,
    blocked,
    reason: blocked.length ? blocked.map((entry) => entry.reason).join(' ') : '',
  }
}

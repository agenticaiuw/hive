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
 * module must never become a new runtime file in the build output — it gets
 * bundled into whichever entry imports it, and the shipped file set stays
 * exactly the set the .pbxproj already knows.
 */
const entryPoints = [
  ['background.js', 'AIPendantBrowserBridge'],
  ['popup.js', 'AIPendantPopup'],
]

const entryNames = new Set(entryPoints.map(([entry]) => entry))

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

  /*
   * DERIVED, not hand-maintained: every .js the src copy brought along that
   * is not itself an entry is bundled inside one, and shipping the loose
   * module beside the bundle is how bridge-core.js once leaked into the
   * Safari resources. Delete everything that is not an entry.
   */
  for (const dirent of fs.readdirSync(platformDir, { withFileTypes: true })) {
    if (dirent.isFile() && dirent.name.endsWith('.js') && !entryNames.has(dirent.name)) {
      fs.rmSync(path.join(platformDir, dirent.name), { force: true })
    }
  }

  const manifestPath = path.join(platformDir, 'manifest.json')
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  delete manifest.background.type
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

import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { ownerDetails } from '../../cloud/shared/ownerDetails.mjs'

const browserExtensionDir = path.dirname(fileURLToPath(import.meta.url))
const sourceDir = path.join(browserExtensionDir, 'src')
const outputDir = path.join(browserExtensionDir, 'build')
const chromeDir = path.join(outputDir, 'chrome')
const safariDir = path.join(outputDir, 'safari')
const chromeArchive = path.join(outputDir, 'hive-browser-bridge-chrome.zip')
const rolldownPath = path.join(browserExtensionDir, 'node_modules', '.bin', 'rolldown')

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
  ['background.js', 'HiveBrowserBridge'],
  ['popup.js', 'HivePopup'],
  ['page-rules.js', 'HivePageRules'],
  ['sidepanel.js', 'HiveSidePanel'],
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
  if (platformDir === safariDir) {
    /*
     * Safari gets the background PAGE form, not a service worker. Measured
     * 2026-08-12 on the owner's Safari: with `service_worker`, the background
     * never evaluated at all — no onStartup, no alarms, and runtime messages
     * returned undefined without waking it, across multiple browser
     * relaunches (storage timestamps stood still while the popup rendered
     * stale chips). Apple's own sample extensions use `scripts`; that path
     * is the one Safari actually exercises. Chrome keeps `service_worker`
     * (MV3 requires it and rejects `scripts`).
     */
    /*
     * Safari has no side panel: its popup opens Hive's dashboard in a tab
     * (dashboard-panel.js), so the panel page and its manifest keys stay out
     * of the Safari resources (the .pbxproj lists those file by file).
     */
    delete manifest.side_panel
    manifest.permissions = manifest.permissions.filter((name) => name !== 'sidePanel')
    /*
     * Safari hands runtime.sendNativeMessage only to extensions that ask for nativeMessaging: without
     * it the API isn't there at all, so the popup never got its key to Hive's cloud from the app
     * ("hive:key") (2026-11-16). Chrome gets its key from its own native host
     * (hive.board_key) and asks for it in the source manifest.
     */
    if (!manifest.permissions.includes('nativeMessaging')) manifest.permissions.push('nativeMessaging')
    fs.rmSync(path.join(platformDir, 'sidepanel.html'), { force: true })
    fs.rmSync(path.join(platformDir, 'sidepanel.js'), { force: true })
    delete manifest.background.service_worker
    manifest.background.scripts = ['background.js']
    /*
     * `type: "module"` stays for Safari — research 2026-08-12: a Sequoia-era
     * reporter on Apple's forums (thread 758479) found scripts WITHOUT the
     * module type still failed to surface background content, and
     * scripts+module "works. Every time." The bundle is an IIFE, which is
     * valid module code, so declaring module costs nothing on any engine.
     */
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`)
}

/*
 * The extension carries no cloud address, nobody's home folder and no account name: it gets its
 * board's address from Hive on the Mac with its key (page-rules-core.js boardUrl), so the same build
 * works for anyone and can be published. A build that picked up this machine's details stops here.
 */
const found = ownerDetails([chromeDir, safariDir])
if (found.length) {
  for (const { file, what } of found) console.error(`${path.relative(outputDir, file)} holds ${what}`)
  throw new Error("the build holds this machine's owner's details; see above")
}

execFileSync(
  'zip',
  ['-q', '-r', '-X', chromeArchive, '.'],
  { cwd: chromeDir },
)

console.log(`Chrome unpacked extension: ${chromeDir}`)
console.log(`Chrome package: ${chromeArchive}`)
console.log(`Safari converter input: ${safariDir}`)

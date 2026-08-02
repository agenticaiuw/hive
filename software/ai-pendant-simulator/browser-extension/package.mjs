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

for (const platformDir of [chromeDir, safariDir]) {
  execFileSync(
    rolldownPath,
    [
      path.join(sourceDir, 'background.js'),
      '--format',
      'iife',
      '--platform',
      'browser',
      '--name',
      'AIPendantBrowserBridge',
      '--file',
      path.join(platformDir, 'background.js'),
    ],
    { stdio: 'inherit' },
  )

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

#!/usr/bin/env node
// Builds Hive Phone: WebDriverAgent's UI-test runner with Hive's relay (WebDriverAgent/
// WebDriverAgentRunner/PhoneRelay.h), as an unsigned IPA a member installs with SideStore, which
// signs it on the phone with their own free Apple ID. Nobody needs Xcode, a developer account or a
// computer to sign it; this script runs on the Mac that publishes releases (cloud/release.mjs phone).
//
//   node mobile/relay/build.mjs [--version 2026.1118.1530-3f2a9b8c7d6e] [--out DIR]
//
// The packaging follows OpenMinis/iCTRL (Apache-2.0), which starts the same runner from its icon:
// build for testing with signing off; take XCTest's frameworks out of the app so the phone's
// mounted developer disk image supplies its own; give the test bundle the app's id; give the app an
// icon and Hive Phone's name and version; sign it ad hoc (SideStore re-signs); zip Payload/.
// It stops if the IPA holds this machine's owner's details (cloud/shared/ownerDetails.mjs).
import { execFileSync, spawnSync } from 'node:child_process'
import { createHash } from 'node:crypto'
import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, statSync } from 'node:fs'
import { dirname, join, relative, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { ownerDetails } from '../../cloud/shared/ownerDetails.mjs'

const HERE = dirname(fileURLToPath(import.meta.url))
export const BUNDLE_ID = 'app.hive.phone.xctrunner' // cloud/tasks/phone.js BUNDLE_ID
export const NAME = 'Hive Phone'
// What XCTest brings with it; the phone's developer disk image has its own, matched to its iOS.
export const XCTEST_PARTS = ['XCTAutomationSupport.framework', 'XCTest.framework', 'XCTestCore.framework', 'XCTestSupport.framework',
  'XCUIAutomation.framework', 'XCUnit.framework', 'Testing.framework', 'libXCTestSwiftSupport.dylib']

/** "2026.1118.1530-3f2a…" → what the app says it is: CFBundleShortVersionString and CFBundleVersion. */
export function bundleVersions(version) {
  const shown = String(version).split('-')[0]
  if (!/^\d+(\.\d+){0,2}$/.test(shown)) return { short: '0.0.0', build: '0', full: String(version) }
  return { short: shown, build: shown, full: String(version) }
}

const plist = (file, key, type, value) => execFileSync('plutil', ['-replace', key, `-${type}`, value, file])
const plistJson = (file, key, value) => execFileSync('plutil', ['-replace', key, '-json', JSON.stringify(value), file])

function run(command, args, opts = {}) {
  const r = spawnSync(command, args, { encoding: 'utf8', maxBuffer: 256 << 20, ...opts })
  if (r.status !== 0) {
    const said = `${r.stdout ?? ''}\n${r.stderr ?? ''}`.split('\n').filter(l => /: error:|^error:|\*\* .*FAILED/.test(l)).slice(-15).join('\n')
    throw new Error(`${command} ${args[0]} failed (${r.status}):\n${said || `${r.stderr}`.trim().split('\n').slice(-15).join('\n')}`)
  }
  return r.stdout
}

/** Everything signable under `dir`, innermost first, so each is signed before what holds it. */
function signables(dir) {
  const out = []
  const walk = at => {
    for (const name of readdirSync(at).sort()) {
      const path = join(at, name)
      if (!statSync(path).isDirectory()) {
        if (name.endsWith('.dylib')) out.push(path)
        continue
      }
      walk(path)
      if (/\.(framework|xctest|appex)$/.test(name)) out.push(path)
    }
  }
  walk(dir)
  return out
}

export function build({ version = 'dev', out = join(HERE, 'build') } = {}) {
  if (process.platform !== 'darwin') throw new Error('Hive Phone is built on a Mac')
  out = resolve(out)
  const derived = join(out, 'derived')
  const v = bundleVersions(version)
  console.log(`${NAME} ${v.full}: building WebDriverAgent's runner for iOS (unsigned)`)
  run('xcodebuild', ['build-for-testing', '-project', join(HERE, 'WebDriverAgent', 'WebDriverAgent.xcodeproj'), '-scheme', 'WebDriverAgentRunner',
    '-configuration', 'Debug', '-destination', 'generic/platform=iOS', '-derivedDataPath', derived, '-quiet',
    'CODE_SIGNING_ALLOWED=NO', 'CODE_SIGNING_REQUIRED=NO', 'CODE_SIGN_IDENTITY=', 'DEVELOPMENT_TEAM=', 'ARCHS=arm64', 'ONLY_ACTIVE_ARCH=NO',
    // Paths in the binaries name the build folder, never whoever built it.
    `OTHER_CFLAGS=$(inherited) -fdebug-prefix-map=${resolve(HERE, '..', '..')}=/hive -ffile-prefix-map=${resolve(HERE, '..', '..')}=/hive`,
    'DEBUG_INFORMATION_FORMAT=dwarf', 'COPY_PHASE_STRIP=YES', 'STRIP_INSTALLED_PRODUCT=YES'])

  const products = join(derived, 'Build', 'Products', 'Debug-iphoneos')
  const built = join(products, 'WebDriverAgentRunner-Runner.app')
  if (!existsSync(built)) throw new Error(`xcodebuild made no ${relative(out, built)}`)
  const stage = join(out, 'stage')
  rmSync(stage, { recursive: true, force: true })
  const app = join(stage, 'Payload', 'WebDriverAgentRunner-Runner.app')
  mkdirSync(dirname(app), { recursive: true })
  execFileSync('ditto', [built, app])

  // XCTest out (the phone's disk image has it), debug symbols out.
  for (const dir of [join(app, 'Frameworks'), ...readdirSync(join(app, 'PlugIns')).map(p => join(app, 'PlugIns', p, 'Frameworks'))]) {
    if (!existsSync(dir)) continue
    for (const part of XCTEST_PARTS) rmSync(join(dir, part), { recursive: true, force: true })
  }
  execFileSync('find', [app, '-name', '*.dSYM', '-prune', '-exec', 'rm', '-rf', '{}', '+'])

  // Name, id, version, icon.
  const info = join(app, 'Info.plist')
  plist(info, 'CFBundleIdentifier', 'string', BUNDLE_ID)
  plist(info, 'CFBundleDisplayName', 'string', NAME)
  plist(info, 'CFBundleName', 'string', NAME)
  plist(info, 'CFBundleShortVersionString', 'string', v.short)
  plist(info, 'CFBundleVersion', 'string', v.build)
  plist(info, 'HiveVersion', 'string', v.full)
  for (const size of ['2x', '3x']) copyFileSync(join(HERE, 'icon', `AppIcon60x60@${size}.png`), join(app, `AppIcon60x60@${size}.png`))
  plistJson(info, 'CFBundleIcons', { CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon60x60'] } })
  plistJson(info, 'CFBundleIcons~ipad', { CFBundlePrimaryIcon: { CFBundleIconFiles: ['AppIcon60x60'] } })
  rmSync(join(app, 'AppIcon76x76@2x~ipad.png'), { force: true })
  const tests = readdirSync(join(app, 'PlugIns')).filter(p => p.endsWith('.xctest'))
  if (tests.length !== 1) throw new Error(`the runner has ${tests.length} test bundles, not 1`)
  const testInfo = join(app, 'PlugIns', tests[0], 'Info.plist')
  plist(testInfo, 'CFBundleIdentifier', 'string', BUNDLE_ID)
  plist(testInfo, 'HiveVersion', 'string', v.full)

  // No debug symbols: their map names the object files by where they were built.
  for (const file of execFileSync('find', [app, '-type', 'f', '(', '-perm', '+111', '-o', '-name', '*.dylib', ')'], { encoding: 'utf8' }).split('\n').filter(Boolean)) {
    if (readFileSync(file).subarray(0, 4).readUInt32BE() === 0xcffaedfe) execFileSync('xcrun', ['strip', '-S', file])
  }

  // Signed ad hoc, inside out; SideStore signs it again with the member's Apple ID.
  for (const part of signables(app)) execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', part], { stdio: 'ignore' })
  execFileSync('codesign', ['--force', '--sign', '-', '--timestamp=none', app], { stdio: 'ignore' })
  run('codesign', ['--verify', '--deep', '--strict', app])

  // XCTest has to come from the phone: nothing left links one that isn't there.
  const linked = [app, ...tests.map(t => join(app, 'PlugIns', t))].flatMap(bundle => {
    const exe = join(bundle, execFileSync('plutil', ['-extract', 'CFBundleExecutable', 'raw', join(bundle, 'Info.plist')], { encoding: 'utf8' }).trim())
    return run('otool', ['-L', exe]).split('\n').slice(1).map(l => l.trim().split(' (')[0]).filter(Boolean)
  })
  const missing = linked.filter(l => l.startsWith('@rpath/') && !existsSync(join(app, 'Frameworks', l.slice(7)))
    && !tests.some(t => existsSync(join(app, 'PlugIns', t, 'Frameworks', l.slice(7))))
    && !XCTEST_PARTS.some(p => l.slice(7).startsWith(p)))
  if (missing.length) throw new Error(`the app links what it doesn't carry: ${missing.join(', ')}`)

  const found = ownerDetails([app])
  if (found.length) {
    for (const { file, what } of found) console.error(`  ${relative(stage, file)} holds ${what}`)
    throw new Error("Hive Phone holds this machine's owner's details; no IPA was made")
  }
  const ipa = join(out, 'HivePhone.ipa')
  rmSync(ipa, { force: true })
  execFileSync('zip', ['-q', '-r', '-X', '-y', ipa, 'Payload'], { cwd: stage })
  const bytes = readFileSync(ipa)
  const sha256 = createHash('sha256').update(bytes).digest('hex')
  console.log(`${NAME} ${v.full}: ${relative(process.cwd(), ipa)}, ${(bytes.length / 1024 / 1024).toFixed(1)} MB, none of the owner's details`)
  return { ipa, bytes, sha256, version: v.full }
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const args = process.argv.slice(2)
  const option = name => { const i = args.indexOf(name); return i < 0 ? undefined : args[i + 1] }
  try {
    build({ version: option('--version'), out: option('--out') })
  } catch (error) {
    console.error(`build: ${error.message}`)
    process.exit(1)
  }
}

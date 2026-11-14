#!/usr/bin/env node
/*
 * Hive's one icon, fanned out to every place that shows one.
 *
 * The icon is branding/hive.svg at the repository's root, its only copy. Change that file, run
 * `node branding/sync-icons.mjs`, rebuild the apps; nothing else may carry its own artwork.
 * The Mac app's Hive.icns isn't here: desktop/app's Makefile builds it from the svg, and the
 * dashboard links to the svg itself.
 *
 * Everything below is DERIVED and should never be edited by hand:
 *   - browser extension icons (16/32/48/128/512), Chrome and Safari
 *   - the Safari extension's container app: AppIcon.appiconset, LargeIcon, the window's Icon.png
 *   - the iOS app's AppIcon
 *   - favicon.svg for the mobile web app (public/, and dist/ and the iOS web bundle when built)
 *
 * iOS icons are square and opaque (iOS rounds the corners itself), so they're drawn from the
 * svg cropped to its rounded square with the corners filled in.
 *
 * Drawn by desktop/app/tools/hive-icon.swift (AppKit renders the svg), built with make.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const svgPath = path.join(repo, 'branding/hive.svg')
const svg = fs.readFileSync(svgPath, 'utf8')

execFileSync('make', ['-s', '-C', path.join(repo, 'desktop/app'), 'build/hive-icon'], { stdio: 'inherit' })
const tool = path.join(repo, 'desktop/app/build/hive-icon')

// The square version: just the rounded square's area, with square corners.
const square = svg.replace('viewBox="0 0 1024 1024"', 'viewBox="100 100 824 824"').replaceAll('rx="184"', 'rx="0"')
if (!square.includes('viewBox="100 100 824 824"') || square.includes('rx="184"')) {
  console.error('branding/hive.svg no longer has the 824 px rounded square at 100,100; update sync-icons.mjs')
  process.exit(1)
}
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'hive-icons-'))
const squarePath = path.join(tmp, 'hive-square.svg')
fs.writeFileSync(squarePath, square)

const written = []
function draw(size, destination, { ios = false } = {}) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  const args = [ios ? squarePath : svgPath, 'png', String(size), destination]
  execFileSync(tool, ios ? [...args, 'opaque'] : args, { stdio: 'pipe' })
  written.push(`${path.relative(repo, destination)} (${size})`)
}

try {
  /* --- browser extension, Chrome and Safari --- */
  const bridge = path.join(repo, 'browser/safari/Hive Browser Bridge')
  for (const size of [16, 32, 48, 128, 512]) {
    draw(size, path.join(repo, `browser/chrome/src/icons/icon-${size}.png`))
    draw(size, path.join(bridge, `Shared (Extension)/Resources/icons/icon-${size}.png`))
  }

  /* --- the Safari extension's container app --- */
  const appIconset = path.join(bridge, 'Shared (App)/Assets.xcassets/AppIcon.appiconset')
  draw(1024, path.join(appIconset, 'universal-icon-1024@1x.png'), { ios: true })
  for (const size of [16, 32, 128, 256, 512]) {
    draw(size, path.join(appIconset, `mac-icon-${size}@1x.png`))
    draw(size * 2, path.join(appIconset, `mac-icon-${size}@2x.png`))
  }
  draw(512, path.join(bridge, 'Shared (App)/Assets.xcassets/LargeIcon.imageset/icon-512.png'))
  draw(512, path.join(bridge, 'Shared (App)/Resources/Icon.png'))

  /* --- iOS app --- */
  draw(1024, path.join(repo, 'mobile/ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'), { ios: true })

  /* --- favicons: the svg itself --- */
  for (const destination of [
    path.join(repo, 'mobile/public/favicon.svg'),
    path.join(repo, 'mobile/dist/favicon.svg'), // build output, when built
    path.join(repo, 'mobile/ios/App/App/public/favicon.svg'), // the iOS web bundle, when built
  ]) {
    if (!fs.existsSync(path.dirname(destination))) continue
    fs.writeFileSync(destination, svg)
    written.push(path.relative(repo, destination))
  }
} finally {
  fs.rmSync(tmp, { recursive: true, force: true })
}

console.log(`Drew ${written.length} files from branding/hive.svg`)

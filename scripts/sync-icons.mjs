#!/usr/bin/env node
/*
 * THE ONE ICON, fanned out to every surface that shows one.
 *
 * The product wore four different faces at once (owner, 2026-08-09): the
 * menubar/desktop app had the navy pendant, the browser extension a green "P",
 * the dashboard a bolt, the agent app nothing at all. The owner's ruling:
 * "make them all the same as the Mac desktop app icon… one source of icon
 * that if we ever want to change it we can just all change it from there."
 *
 * That source is assets/icon/pendant-1024.png — extracted once from
 * /Applications/AI Pendant.app (the face the owner chose). Change that file,
 * run this script, rebuild the apps; nothing else may carry its own artwork.
 *
 * Everything below is DERIVED and should never be edited by hand:
 *   - browser extension toolbar/store icons (16/32/48/128/512)
 *   - Safari Bridge app AppIcon.appiconset + LargeIcon + window Icon.png
 *     + extension icons copy
 *   - iOS app AppIcon.appiconset
 *   - favicon.svg everywhere one is served (pendant sim public/ + dist/,
 *     iOS web bundle, dashboard static/) — an SVG wrapping the PNG, so the
 *     existing .svg filenames and routes keep working
 *   - assets/icon/pendant.icns, consumed by the Agent-app installer
 *     (local-agent/macos/setupPermissions.js) on its next run
 *
 * Uses macOS `sips` and `iconutil` — no npm dependencies, because an icon
 * pipeline that needs an install step stops being run.
 */
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')
const master = path.join(repo, 'assets/icon/pendant-1024.png')
if (!fs.existsSync(master)) {
  console.error(`Master icon missing: ${master}`)
  process.exit(1)
}

const sim = path.join(repo, 'software/ai-pendant-simulator')
const bridge = path.join(sim, 'safari-browser-extension/AI Pendant Browser Bridge')

const written = []
function resize(size, destination) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  execFileSync('sips', ['-s', 'format', 'png', '-z', String(size), String(size), master, '--out', destination], {
    stdio: 'pipe',
  })
  written.push(`${path.relative(repo, destination)} (${size})`)
}

/* --- browser extension (source of truth for both Chrome and Safari builds) --- */
for (const size of [16, 32, 48, 128, 512]) {
  resize(size, path.join(sim, `browser-extension/src/icons/icon-${size}.png`))
  /* The Safari project references the same files by path; kept in lockstep so
   * a build from either tree ships the same face. */
  resize(size, path.join(bridge, `Shared (Extension)/Resources/icons/icon-${size}.png`))
}

/* --- Safari Bridge containing app --- */
const appIconset = path.join(bridge, 'Shared (App)/Assets.xcassets/AppIcon.appiconset')
resize(1024, path.join(appIconset, 'universal-icon-1024@1x.png'))
for (const size of [16, 32, 128, 256, 512]) {
  resize(size, path.join(appIconset, `mac-icon-${size}@1x.png`))
  resize(size * 2, path.join(appIconset, `mac-icon-${size}@2x.png`))
}
resize(512, path.join(bridge, 'Shared (App)/Assets.xcassets/LargeIcon.imageset/icon-512.png'))
/* The app window's Main.html shows ../Icon.png directly — a loose resource
 * outside the asset catalogs that the 2026-08-10 unification missed (it kept
 * the old green "P" while every catalog got the pendant). */
resize(512, path.join(bridge, 'Shared (App)/Resources/Icon.png'))

/* --- iOS app --- */
resize(1024, path.join(sim, 'ios/App/App/Assets.xcassets/AppIcon.appiconset/AppIcon-512@2x.png'))

/* --- favicons: an SVG wrapping the PNG keeps every existing .svg route --- */
const favicon256 = path.join(repo, 'assets/icon/.favicon-256.png')
resize(256, favicon256)
const encoded = fs.readFileSync(favicon256).toString('base64')
fs.rmSync(favicon256)
const faviconSvg = `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 256 256" width="256" height="256"><image width="256" height="256" href="data:image/png;base64,${encoded}"/></svg>\n`
/* The dashboard header's brand mark — an <img>, not a favicon. */
resize(192, path.join(repo, 'software/dashboard-sveltekit/static/pendant-logo.png'))

for (const destination of [
  path.join(sim, 'public/favicon.svg'),
  path.join(sim, 'dist/favicon.svg'), // build output the agent serves today
  path.join(sim, 'ios/App/App/public/favicon.svg'),
  path.join(repo, 'software/dashboard-sveltekit/static/favicon.svg'),
]) {
  fs.mkdirSync(path.dirname(destination), { recursive: true })
  fs.writeFileSync(destination, faviconSvg)
  written.push(path.relative(repo, destination))
}

/* --- .icns for the Agent app installer --- */
const iconsetDir = path.join(repo, 'assets/icon/.pendant.iconset')
fs.rmSync(iconsetDir, { recursive: true, force: true })
fs.mkdirSync(iconsetDir, { recursive: true })
for (const size of [16, 32, 128, 256, 512]) {
  resize(size, path.join(iconsetDir, `icon_${size}x${size}.png`))
  resize(size * 2, path.join(iconsetDir, `icon_${size}x${size}@2x.png`))
}
execFileSync('iconutil', ['-c', 'icns', iconsetDir, '-o', path.join(repo, 'assets/icon/pendant.icns')])
fs.rmSync(iconsetDir, { recursive: true, force: true })
written.push('assets/icon/pendant.icns')

console.log(`Regenerated ${written.length} files from assets/icon/pendant-1024.png`)

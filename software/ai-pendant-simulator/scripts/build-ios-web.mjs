/*
 * Assemble the iOS web bundle in dist/.
 *
 * The device WKWebView never renders this bundle's index.html: Capacitor loads
 * the remote dashboard (capacitor.config.json server.url) and serves only
 * offline.html (server.errorPath) from the local bundle when the network is
 * down. So the bundle is three static files — no bundler, no env injection,
 * and nothing secret to leak into dist/.
 */
import { copyFileSync, mkdirSync, rmSync } from 'node:fs'
import { join, resolve } from 'node:path'

const projectRoot = resolve(import.meta.dirname, '..')
const distDir = join(projectRoot, 'dist')

rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

for (const file of ['index.html', 'public/offline.html', 'public/favicon.svg']) {
  copyFileSync(join(projectRoot, file), join(distDir, file.split('/').at(-1)))
}

console.log('iOS web bundle: static shell + offline.html + favicon (remote dashboard does the rest).')

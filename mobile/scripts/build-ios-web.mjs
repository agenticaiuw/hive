/*
 * Assemble the iOS web bundle in dist/.
 *
 * index.html is the app's start page: it asks for the member's own dashboard
 * address once, keeps it on the phone and opens it (capacitor.config.json
 * allowNavigation lets the app show it); offline.html (server.errorPath) goes
 * back to it when the network returns. Three static files: no bundler, no env
 * injection, and nobody's address or secret in dist/.
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

console.log("iOS web bundle: the start page, offline.html and the icon (each member's own dashboard does the rest).")

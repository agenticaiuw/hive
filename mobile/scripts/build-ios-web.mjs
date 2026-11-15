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
import { fillSubdomain, hiveCloudSubdomain, rewriteTree } from '../../cloud/shared/hiveCloud.mjs'

const projectRoot = resolve(import.meta.dirname, '..')
const distDir = join(projectRoot, 'dist')

rmSync(distDir, { recursive: true, force: true })
mkdirSync(distDir, { recursive: true })

for (const file of ['index.html', 'public/offline.html', 'public/favicon.svg']) {
  copyFileSync(join(projectRoot, file), join(distDir, file.split('/').at(-1)))
}

// The repository names the dashboard as hive-dashboard.your-subdomain.workers.dev; point the bundle
// at this person's own Hive cloud.
const subdomain = hiveCloudSubdomain()
if (subdomain) rewriteTree(distDir, text => fillSubdomain(text, subdomain))
else console.warn('No Hive cloud set up on this machine; the bundle keeps the your-subdomain placeholder.')

console.log('iOS web bundle: static shell + offline.html + favicon (remote dashboard does the rest).')

// Where this person's Hive cloud lives. Hive's Workers are named https://<worker>.<subdomain>.workers.dev,
// and <subdomain> is the Cloudflare account's, so it belongs to whoever runs Hive, never to the
// repository. Source files name Workers with the placeholder subdomain `your-subdomain`; builds and
// local services fill in the real one from here.
//
// HIVE_CLOUD_SUBDOMAIN wins. Otherwise it's read from the board address hive-tasks signs in with
// (~/.config/hive/tasks.json, or HIVE_TASKS_CONFIG), which every Hive install has.
//
//   node cloud/shared/hiveCloud.mjs      prints the subdomain (empty when none is set up)
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'

export const PLACEHOLDER = 'your-subdomain'

/** The Cloudflare account's workers.dev subdomain, or '' when this machine has no Hive cloud yet. */
export function hiveCloudSubdomain(env = process.env) {
  const set = String(env.HIVE_CLOUD_SUBDOMAIN || '').trim()
  if (set) return set
  try {
    const file = env.HIVE_TASKS_CONFIG || path.join(os.homedir(), '.config', 'hive', 'tasks.json')
    const url = String(JSON.parse(fs.readFileSync(file, 'utf8')).url || '')
    return /^https:\/\/[a-z0-9-]+\.([a-z0-9-]+)\.workers\.dev\b/i.exec(url)?.[1] || ''
  } catch {
    return ''
  }
}

/** A Worker's address in this person's cloud, or '' when there's none. */
export function hiveWorkerUrl(worker, env = process.env) {
  const sub = hiveCloudSubdomain(env)
  return sub ? `https://${worker}.${sub}.workers.dev` : ''
}

/** Text with every `<worker>.your-subdomain.workers.dev` pointed at this person's cloud. */
export function fillSubdomain(text, sub = hiveCloudSubdomain()) {
  return sub ? text.replaceAll(`.${PLACEHOLDER}.workers.dev`, `.${sub}.workers.dev`) : text
}

/** The reverse, for build output that is copied back into the repository. */
export function emptySubdomain(text, sub = hiveCloudSubdomain()) {
  return sub ? text.replaceAll(`.${sub}.workers.dev`, `.${PLACEHOLDER}.workers.dev`) : text
}

/** Rewrites every text file under `dir` with `change` (a function of the file's text). */
export function rewriteTree(dir, change) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const file = path.join(dir, entry.name)
    if (entry.isDirectory()) rewriteTree(file, change)
    else if (/\.(js|mjs|json|html|css|swift|plist|txt)$/i.test(entry.name)) {
      const text = fs.readFileSync(file, 'utf8')
      const next = change(text)
      if (next !== text) fs.writeFileSync(file, next)
    }
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const [, , command, dir] = process.argv
  if (command === 'fill' && dir) rewriteTree(dir, text => fillSubdomain(text))
  else if (command === 'empty' && dir) rewriteTree(dir, text => emptySubdomain(text))
  else process.stdout.write(hiveCloudSubdomain())
}

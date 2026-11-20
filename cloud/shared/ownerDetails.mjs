// Finds the details of whoever runs this machine in build output, so nothing anyone downloads or
// installs carries them: the Cloudflare account's subdomain (it names the owner's cloud, and often
// their email), their home folder, their git email's name, and the email in their Apple Development
// signing certificate. The browser extension's build stops on a hit (browser/chrome/package.mjs),
// and so does the Mac's release (desktop/app/tools/release.sh).
//
// It says what it found and where, never the detail itself.
//
//   node cloud/shared/ownerDetails.mjs PATH...     exits 1 and lists the files when any holds one
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { pathToFileURL } from 'node:url'
import { hiveCloudSubdomain } from './hiveCloud.mjs'

const quiet = (command, args) => {
  try {
    return execFileSync(command, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'], timeout: 10_000 })
  } catch {
    return ''
  }
}

/** This machine's owner's details, as [{what, text}] (each long enough not to match by chance). */
export function machineDetails(env = process.env) {
  const details = []
  const add = (what, text) => {
    const value = String(text || '').trim()
    if (value.length >= 5 && !details.some((d) => d.text === value)) details.push({ what, text: value })
  }
  add("the cloud account's subdomain", hiveCloudSubdomain(env))
  const home = env.HOME || os.homedir()
  if (/^\/(Users|home)\/[^/]+$/.test(home)) add('the home folder', home)
  add("the git email's name", quiet('git', ['config', '--global', 'user.email']).split('@')[0])
  for (const [, email] of quiet('security', ['find-identity', '-v', '-p', 'codesigning']).matchAll(/"Apple Development: ([^"\s]+@[^"\s]+)/g)) {
    add("a signing certificate's email", email.split('@')[0])
  }
  return details
}

/** Every file under `paths` holding one of `details`: [{file, what}], each file once per detail. */
export function ownerDetails(paths, details = machineDetails()) {
  const needles = details.map((d) => ({ what: d.what, bytes: Buffer.from(d.text) }))
  const found = []
  const visit = (file) => {
    let info
    try {
      info = fs.lstatSync(file)
    } catch {
      return
    }
    if (info.isSymbolicLink()) return
    if (info.isDirectory()) {
      for (const name of fs.readdirSync(file).sort()) visit(path.join(file, name))
      return
    }
    if (!info.isFile()) return
    const data = fs.readFileSync(file)
    for (const { what, bytes } of needles) if (data.includes(bytes)) found.push({ file, what })
  }
  for (const p of paths) visit(p)
  return found
}

if (import.meta.url === pathToFileURL(process.argv[1] ?? '').href) {
  const paths = process.argv.slice(2)
  if (!paths.length) {
    console.error('usage: node cloud/shared/ownerDetails.mjs PATH...')
    process.exit(64)
  }
  const found = ownerDetails(paths)
  for (const { file, what } of found) console.log(`${file}: ${what}`)
  if (found.length) process.exit(1)
  console.log(`none of this machine's owner's details in ${paths.length === 1 ? paths[0] : `${paths.length} paths`}`)
}

// Keeps the owner's personal details out of this public repository (hive T81). The repository was
// scrubbed and its history rewritten once; this stops the same kinds of values creeping back in.
// It checks shapes, never the values themselves, so the test holds no personal data either:
//   - Workers are named with the placeholder subdomain (hiveCloud.mjs fills in the real one at build)
//   - no personal mail addresses (gmail, iCloud, a university's) beyond the public ones listed here
//   - no real home folders in paths, and no Xcode "Created by <name>" headers
//   - Apple private-relay addresses only as numbered fixtures
//   - no Apple team IDs (the archive script reads the team from the Mac's signing certificate)
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import assert from 'node:assert/strict'

const ROOT = path.resolve(import.meta.dirname, '../..')
const SKIP = /(^|\/)(third_party|node_modules|vendor)\//

const WORKERS_SUBDOMAINS = new Set(['your-subdomain', 'example'])
const PUBLIC_ADDRESSES = new Set(['registrar@wisc.edu'])
const HOME_FOLDERS = new Set(['you', 'me', 'example', 'owner', 'someone', 'test', 'x', 'o', '...', 'user', 'name'])

function trackedTextFiles() {
  let listed
  try {
    listed = execFileSync('git', ['-C', ROOT, 'ls-files', '-z'], { encoding: 'utf8', maxBuffer: 64 << 20 })
  } catch {
    return null
  }
  const files = []
  for (const file of listed.split('\0')) {
    if (!file || SKIP.test(file)) continue
    let text
    try {
      const data = fs.readFileSync(path.join(ROOT, file))
      if (data.subarray(0, 8192).includes(0)) continue
      text = data.toString('utf8')
    } catch {
      continue
    }
    files.push([file, text])
  }
  return files
}

const RULES = [
  {
    why: 'a workers.dev address names a real Cloudflare account; use <worker>.your-subdomain.workers.dev',
    find: /\b[a-z0-9-]+\.([a-z0-9-]+)\.workers\.dev\b/gi,
    allowed: m => WORKERS_SUBDOMAINS.has(m[1].toLowerCase()),
  },
  {
    why: 'a personal mail address; use an example.com / example.edu address',
    find: /[A-Za-z0-9._%+-]+@(?:gmail|googlemail|icloud|me|mac|outlook|hotmail|yahoo|live|proton|protonmail)\.(?:com|me)\b|[A-Za-z0-9._%+-]+@(?:[a-z0-9-]+\.)*wisc\.edu\b/gi,
    allowed: m => PUBLIC_ADDRESSES.has(m[0].toLowerCase()),
  },
  {
    why: 'a real home folder; use /Users/you',
    find: /\/Users\/([A-Za-z0-9._-]+)/g,
    allowed: m => HOME_FOLDERS.has(m[1].toLowerCase()) || m[1] === '...',
  },
  {
    why: 'an Xcode file header names its author',
    find: /^\/\/ +Created by [^\n]+ on \d/gm,
    allowed: () => false,
  },
  {
    why: "an Apple team ID names the owner's developer account; scripts read it from the Mac's signing certificate",
    find: /DEVELOPMENT_TEAM\s*=\s*"?([A-Z0-9]{10})\b|<key>teamID<\/key>\s*<string>([A-Z0-9]{10})<|\bHIVE_APPLE_TEAM_ID:-([A-Z0-9]{10})\b|\(`([A-Z0-9]{10})`\)/g,
    allowed: m => [m[1], m[2], m[3], m[4]].some(v => v && /^X+$/.test(v)),
  },
  {
    why: 'an Apple private-relay address is a real person; use sender<n>@privaterelay.appleid.com',
    find: /([A-Za-z0-9._%+-]+)@privaterelay\.appleid\.com/gi,
    allowed: m => /^sender\d+$/.test(m[1]),
  },
]

test("the repository holds none of the owner's personal details", t => {
  const files = trackedTextFiles()
  if (!files) return t.skip('not a git checkout')
  const found = []
  for (const [file, text] of files) {
    if (file === 'cloud/shared/privacy.test.mjs') continue
    for (const rule of RULES) {
      for (const m of text.matchAll(rule.find)) {
        if (rule.allowed(m)) continue
        const line = text.slice(0, m.index).split('\n').length
        // Name the place, never the value, so a failing run doesn't print it either.
        found.push(`${file}:${line}  ${rule.why}`)
      }
    }
  }
  assert.deepEqual(found, [], `Personal details in the repository:\n${found.join('\n')}`)
})

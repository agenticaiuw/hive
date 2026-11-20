// Build output holds none of the owner's details (ownerDetails.mjs): the scanner finds each kind in
// text and binary files without ever saying the detail, and the extension's real build is clean.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { machineDetails, ownerDetails } from './ownerDetails.mjs'

const REPO = fileURLToPath(new URL('../..', import.meta.url))

test('finds each detail in text and binary files, says which kind and where, and never the detail', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'owner-details-'))
  fs.mkdirSync(path.join(dir, 'App.app', 'Contents'), { recursive: true })
  fs.writeFileSync(path.join(dir, 'background.js'), 'fetch("https://hive-tasks.your-subdomain.workers.dev/v1/board")')
  fs.writeFileSync(path.join(dir, 'App.app', 'Contents', 'Info.plist'), '<string>/Users/someone/hive/desktop/app</string>')
  fs.writeFileSync(path.join(dir, 'App.app', 'Contents', 'binary'), Buffer.concat([Buffer.from([0, 1, 2]), Buffer.from('Apple Development: your-subdomain@example.com'), Buffer.from([255])]))
  fs.writeFileSync(path.join(dir, 'clean.js'), 'fetch(`${boardUrl(board)}/v1/board`)')
  fs.symlinkSync('/Users/someone', path.join(dir, 'link'))
  const details = [{ what: "the cloud account's subdomain", text: 'your-subdomain' }, { what: 'the home folder', text: '/Users/someone' }]
  const found = ownerDetails([dir], details).map(({ file, what }) => [path.relative(dir, file), what])
  assert.deepEqual(found, [
    ['App.app/Contents/Info.plist', 'the home folder'],
    ['App.app/Contents/binary', "the cloud account's subdomain"],
    ['background.js', "the cloud account's subdomain"],
  ])
  assert.ok(!JSON.stringify(found).includes('your-subdomain'), 'it names the kind of detail, not the detail')
})

test("this machine's details are long enough not to match by chance, and the home folder is one of them", () => {
  const details = machineDetails({ ...process.env, HOME: '/Users/someone', HIVE_CLOUD_SUBDOMAIN: 'abc' })
  assert.ok(details.every((d) => d.text.length >= 5))
  assert.ok(details.some((d) => d.what === 'the home folder' && d.text === '/Users/someone'))
  assert.ok(!details.some((d) => d.text === 'abc'), 'too short to look for')
})

test("the browser extension's build holds none of this machine's owner's details", { skip: !fs.existsSync(path.join(REPO, 'browser/chrome/build/chrome')) && 'not built here' }, () => {
  const found = ownerDetails([path.join(REPO, 'browser/chrome/build/chrome'), path.join(REPO, 'browser/chrome/build/safari')])
  assert.deepEqual(found.map(({ file, what }) => `${path.relative(REPO, file)}: ${what}`), [])
})

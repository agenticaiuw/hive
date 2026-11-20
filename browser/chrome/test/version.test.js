// The extension saying what it runs and picking up new code by itself (src/version.js): it reloads
// only once new files on disk have settled, never into a folder being rewritten, and never in the
// middle of a command.
import { test } from 'node:test'
import assert from 'node:assert/strict'
import { readFileSync, readdirSync } from 'node:fs'
import { CODE_FILES, LOADED_KEY, PROTOCOL, codeFingerprint, newCodeWatcher, nodeHeaders, noteLoadedCode } from '../src/version.js'

function fakeBrowser(files) {
  const store = {}
  return {
    files,
    store,
    runtime: { getURL: (name) => `chrome-extension://hive/${name}`, getManifest: () => ({ version: '1.17.0' }) },
    storage: { local: { get: async (key) => ({ [key]: store[key] }), set: async (values) => Object.assign(store, values) } },
  }
}
const fetchFrom = (browser) => async (url) => {
  const name = url.replace('chrome-extension://hive/', '')
  return name in browser.files ? new Response(browser.files[name]) : new Response('', { status: 404 })
}
const built = () => Object.fromEntries(CODE_FILES.map((name) => [name, `// ${name} v1`]))

test('every call says which browser, its version and the board routes it was written for', () => {
  assert.deepEqual(nodeHeaders('chrome', fakeBrowser({})), { 'x-hive-node': 'extension:chrome', 'x-hive-version': '1.17.0', 'x-hive-protocol': String(PROTOCOL) })
  assert.equal(nodeHeaders(undefined, {})['x-hive-version'], 'unknown')
})

test("the fingerprint is the code on disk, modules followed, and nothing while a file can't be read", async () => {
  const browser = fakeBrowser({ ...built(), 'background.js': "import { x } from './cloud-peer.js'\n", 'cloud-peer.js': 'export const x = 1' })
  const options = { browserApi: browser, fetchImpl: fetchFrom(browser) }
  const first = await codeFingerprint(options)
  assert.match(first, /^[0-9a-f]{64}$/)
  browser.files['cloud-peer.js'] = 'export const x = 2'
  assert.notEqual(await codeFingerprint(options), first, 'a change in an imported module counts')
  delete browser.files['popup.js']
  assert.equal(await codeFingerprint(options), null)
})

test('new code reloads the extension once it has settled and no command runs', async () => {
  const browser = fakeBrowser(built())
  let reloads = 0
  let busy = false
  const options = { browserApi: browser, fetchImpl: fetchFrom(browser), busy: () => busy, reload: () => { reloads += 1 } }
  assert.match(await noteLoadedCode(options), /^[0-9a-f]{64}$/)
  const check = newCodeWatcher(options)
  assert.equal(await check(), 'same')

  // package.mjs empties build/chrome and writes it again: never reload into that.
  delete browser.files['background.js']
  assert.equal(await check(), 'unreadable')
  browser.files['background.js'] = '// background.js v2'
  assert.equal(await check(), 'settling')
  busy = true
  assert.equal(await check(), 'busy')
  busy = false
  assert.equal(await check(), 'reloaded')
  assert.equal(reloads, 1)
})

test('a file that keeps changing never reloads; the first check after an update only notes what is loaded', async () => {
  const browser = fakeBrowser(built())
  let reloads = 0
  const options = { browserApi: browser, fetchImpl: fetchFrom(browser), reload: () => { reloads += 1 } }
  const check = newCodeWatcher(options)
  assert.equal(await check(), 'noted')
  assert.ok(browser.store[LOADED_KEY])
  for (let n = 2; n < 5; n++) {
    browser.files['ui.css'] = `/* v${n} */`
    assert.equal(await check(), 'settling')
  }
  assert.equal(reloads, 0)
})

test('the files it watches are exactly what package.mjs puts in build/chrome', () => {
  const pack = readFileSync(new URL('../package.mjs', import.meta.url), 'utf8')
  const entries = [...pack.matchAll(/\['([\w-]+\.js)', 'Hive\w+'\]/g)].map((m) => m[1])
  const src = new URL('../src/', import.meta.url)
  const plain = readdirSync(src, { withFileTypes: true }).filter((d) => d.isFile() && !d.name.endsWith('.js')).map((d) => d.name)
  assert.deepEqual([...CODE_FILES].sort(), [...entries, ...plain].sort())
})

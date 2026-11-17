import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(here, '..', 'src')
const src = (name) => fs.readFileSync(path.join(srcDir, name), 'utf8')

/*
 * THE DEFECT, measured on the real built bundle 2026-08-10 by cycling the
 * popup document through five open/close rounds against ONE shared extension
 * context: listeners registered 1, 2, 3, 4, 5 — none ever released.
 *
 * storage.onChanged lives on the EXTENSION's context, which outlives any one
 * popover document, but the callback closes over that document's `elements`.
 * Every closed popup therefore left a listener behind that pinned a dead page
 * and still ran on every write the worker made. "Works the first time, then
 * stops" is what that looks like from the outside.
 *
 * These are source-shape assertions rather than a DOM test because the leak is
 * a property of REGISTRATION, not of rendering — the rendering was fine
 * throughout, which is exactly why it took so long to find.
 *
 * This file used to sweep options.js too; the options page was deleted at the
 * owner's order (2026-08-12: "delete the entire settings page"), so the popup
 * is the only document left that can leak.
 */
test('popup.js releases its storage listener when the document goes away', () => {
  const text = src('popup.js')

  /* A named function, because an inline arrow cannot be handed back. */
  assert.match(
    text,
    /api\.storage\.onChanged\.addListener\(onStorageChanged\)/,
    'listener must be registered by reference',
  )
  assert.match(
    text,
    /api\.storage\.onChanged\.removeListener\(onStorageChanged\)/,
    'the same reference must be removed',
  )
  /* And the removal has to be on the teardown event, not somewhere hopeful. */
  const pagehideBlock = text.slice(text.indexOf("addEventListener('pagehide'"))
  assert.ok(
    pagehideBlock.includes('removeListener(onStorageChanged)'),
    'removal must happen on pagehide',
  )
  /* No anonymous registration may sneak back in beside it. */
  assert.equal(
    /onChanged\.addListener\(\s*\(/.test(text),
    false,
    'no inline listener — it could never be removed',
  )
})

test('the popover is never closed from script', () => {
  /*
   * Calling window.close() on a Safari popover does not merely dismiss it:
   * Safari keeps one web view for the toolbar popover and reuses it, so
   * closing it from script can leave that view dead. Unnecessary too — the
   * new window takes focus and the browser dismisses the popover itself.
   */
  const text = src('popup.js').replace(/\/\*[\s\S]*?\*\//g, '')
  assert.equal(text.includes('window.close()'), false)
})

/*
 * THE SETTINGS PAGE IS DELETED, AND STAYS DELETED. The owner, 2026-08-12:
 * "having a settings page is lowkey kind of weird ... actually, delete the
 * entire settings page." Setup lives in the popup now. These assertions keep
 * a well-meaning refactor from resurrecting any half of it: the files, the
 * manifest entry, or code paths that send the owner to a page that no longer
 * exists.
 */
test('the options page is gone: no files, no manifest entry, no openers', () => {
  assert.equal(fs.existsSync(path.join(srcDir, 'options.html')), false)
  assert.equal(fs.existsSync(path.join(srcDir, 'options.js')), false)

  const manifest = JSON.parse(src('manifest.json'))
  assert.equal('options_ui' in manifest, false)
  assert.equal('options_page' in manifest, false)

  for (const file of ['popup.js', 'popup.html', 'background.js']) {
    assert.equal(
      src(file).includes('openOptionsPage'),
      false,
      `${file} must not open a settings page that does not exist`,
    )
  }
})

/*
 * The browser's own agent is gone (owner, 2026-11-17: "do not keep them mostly deleted delete all of
 * them"). Hive's agents reach this browser through the cloud board alone (cloud-peer.js), so the old
 * relay pairing, the in-browser brain and the Mac's local poll loop must not come back.
 */
test('the old in-browser agent stays deleted', () => {
  for (const file of [
    'relay-peer.js',
    'pairing.js',
    'console-engine.js',
    'command-console.js',
    'brain.js',
    'affinity.js',
    'page-engine.js',
    'approvals.js',
    'board-runs.js',
    'voice-input.js',
    'sync-crypto.js',
  ]) {
    assert.equal(fs.existsSync(path.join(srcDir, file)), false, `${file} must stay deleted`)
  }

  const manifest = JSON.parse(src('manifest.json'))
  for (const host of manifest.host_permissions) {
    assert.doesNotMatch(host, /127\.0\.0\.1|localhost|hive-relay/, `${host}: nothing local or relay is reached`)
  }

  const background = src('background.js')
  assert.match(background, /runCloudPeer/)
  assert.doesNotMatch(background, /relay|pairing|brain/i)
})

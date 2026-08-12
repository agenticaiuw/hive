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

  for (const file of ['popup.js', 'popup.html', 'background.js', 'command-console.js']) {
    assert.equal(
      src(file).includes('openOptionsPage'),
      false,
      `${file} must not open a settings page that does not exist`,
    )
  }
})

/*
 * THE PAIRING OUTCOME MUST NOT RIDE THE MESSAGE CHANNEL — that channel is the
 * root cause of "Pairing failed: the agent returned no token." on a healthy
 * agent: Safari drops the worker's async sendResponse when the agent's relay
 * leg runs long, the popup sees `undefined`, and the minted credential is
 * lost with the reply. The cure has two halves, and each is asserted where it
 * lives:
 *
 *   worker half — background.js applies the storage patch ITSELF when the
 *   fetch completes and writes the outcome record, so a lost reply can no
 *   longer lose a credential;
 *
 *   popup half — popup.js reads the outcome from storage.onChanged, and the
 *   undefined-reply path says pairing is still finishing, never the default
 *   "returned no token".
 */
test('the worker owns the pairing storage writes and the outcome record', () => {
  const text = src('background.js')
  const handler = text.slice(text.indexOf("message?.type === 'pair:run'"))
  assert.ok(handler.length > 100, 'the pair:run handler exists')

  assert.match(handler, /pairStoragePatch\(/, 'the worker applies the patch itself')
  assert.match(
    handler,
    /storage\.local\s*\.?\s*set\(\{ \[PAIR_OUTCOME_KEY\]/,
    'the worker writes the outcome under PAIR_OUTCOME_KEY',
  )
  /* The session-only sentinel is planted at pair time; its absence at the
   * next worker start is how "browser closed" is detected. */
  assert.match(handler, /pairSessionAlive/, 'session pairing plants the sentinel')
})

test('the popup reads the pairing outcome from storage, not the reply', () => {
  const text = src('popup.js')
  assert.match(
    text,
    /changes\[PAIR_OUTCOME_KEY\]/,
    'storage.onChanged carries the authoritative outcome',
  )
  /* A dropped reply is narrated as "still finishing", never as failure. The
   * phrase is allowed in comments (the war story lives there); stripping them
   * checks the CODE cannot print it. */
  assert.match(text, /Still pairing/, 'undefined reply means still-finishing, not no-token')
  assert.equal(
    text.replace(/\/\*[\s\S]*?\*\//g, '').includes('returned no token'),
    false,
    'the popup never prints the default no-token message on its own',
  )
})

test('the worker enforces the credential lifetime on startup and alarms', () => {
  const text = src('background.js')
  assert.match(text, /enforceCredentialLifetime/, 'the enforcement function exists')
  const startPeers = text.slice(text.indexOf('function startPeers'))
  assert.ok(
    startPeers.slice(0, startPeers.indexOf('}')).includes('enforceCredentialLifetime'),
    'startPeers (startup + every alarm) runs the check',
  )
  assert.match(text, /PAIR_WIPE_KEYS/, 'an expiry wipes exactly the shared key list')
})

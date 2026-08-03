import assert from 'node:assert/strict'
import test from 'node:test'
import { isDeniedApp, stripImageBytes } from './screenCapture.js'
import { DESTRUCTIVE_TITLE_PATTERN, isDestructiveTitle } from './computerUse.js'

// The persisted execution result is the shape that reaches appendLog, the
// context graph (which the cloud relay syncs) and pendant-jobs.json.
const executionPayload = {
  ok: true,
  status: 'success',
  results: [
    {
      action: { type: 'screenshot', label: 'Look at the screen', params: {} },
      ok: true,
      message: 'Captured display #1',
      path: '/tmp/aipendant-observations/x/obs-1.jpg',
      sha256: 'deadbeef',
      image: { width: 1456, height: 910, bytes: 210_000 },
      scale: { x: 0.989, y: 0.989 },
      imageBase64: 'A'.repeat(4000),
      dataUrl: `data:image/jpeg;base64,${'A'.repeat(4000)}`,
    },
  ],
}

test('image bytes are stripped from anything that gets persisted', () => {
  const clean = stripImageBytes(executionPayload)

  assert.equal(clean.results[0].imageBase64, undefined)
  assert.equal(clean.results[0].dataUrl, undefined)
  // Everything the model and the dashboard actually need survives.
  assert.equal(clean.results[0].sha256, 'deadbeef')
  assert.equal(clean.results[0].path, executionPayload.results[0].path)
  assert.deepEqual(clean.results[0].image, executionPayload.results[0].image)
  assert.equal(clean.ok, true)
})

// Regression guard: enforcing this with a test rather than with care, because
// every new field added to a screenshot result is another chance to leak the
// screen contents into a durable file.
test('no base64 blob survives anywhere in a persisted payload', () => {
  const serialized = JSON.stringify(stripImageBytes(executionPayload))
  const blobs = [...serialized.matchAll(/"([A-Za-z0-9+/]{200,}={0,2})"/g)]

  assert.deepEqual(blobs, [], 'a base64-looking blob reached the persisted payload')
})

test('stripping is recursive and leaves non-objects alone', () => {
  const nested = stripImageBytes({
    a: [{ imageBase64: 'x', keep: 1 }, 'plain'],
    b: { c: { dataUrl: 'y', keep: 2 } },
    n: null,
  })

  assert.deepEqual(nested, { a: [{ keep: 1 }, 'plain'], b: { c: { keep: 2 } }, n: null })
})

test('capture is refused while a credential manager is frontmost', () => {
  const denyList = ['1password', 'keychain access', 'messages']

  assert.equal(isDeniedApp('1Password', denyList), true)
  assert.equal(isDeniedApp('1Password 7', denyList), true)
  assert.equal(isDeniedApp('Keychain Access', denyList), true)
  assert.equal(isDeniedApp('Safari', denyList), false)
  assert.equal(isDeniedApp('', denyList), false)
})

test('destructive control titles are recognised before they are pressed', () => {
  for (const title of [
    'Delete',
    'Move to Trash',
    'Empty Trash',
    'Send',
    'Place Order',
    'Erase Disk',
    'Shut Down',
    "Don't Save",
    'Log Out',
  ]) {
    assert.equal(isDestructiveTitle(title), true, `${title} should be gated`)
  }

  for (const title of ['Cancel', 'Save', 'Open', 'Preferences…', 'Resend later']) {
    assert.equal(isDestructiveTitle(title), false, `${title} should not be gated`)
  }

  // The pattern is anchored, so a benign title merely containing the word is
  // not gated.
  assert.equal(DESTRUCTIVE_TITLE_PATTERN.test('Undelete'), false)
})

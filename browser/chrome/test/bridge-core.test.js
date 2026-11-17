import assert from 'node:assert/strict'
import test from 'node:test'

import {
  MAX_COMMAND_AGE_MS,
  PRIVACY_RULES,
  classifyFieldSensitivity,
  isScriptableUrl,
  originPattern,
  pickTargetTab,
  provenanceFor,
  sanitizeExtraction,
  validateCommand,
  validateNavigationUrl,
  verifyWithheld,
  withholdMarkupValues,
  withholdSecrets,
} from '../src/bridge-core.js'

test('navigation permits web URLs and rejects privileged schemes', () => {
  assert.equal(validateNavigationUrl('https://example.com/a'), 'https://example.com/a')
  assert.throws(() => validateNavigationUrl('javascript:alert(1)'), /Only http/)
  assert.throws(() => validateNavigationUrl('file:///etc/passwd'), /Only http/)
  assert.equal(isScriptableUrl('https://example.com'), true)
  assert.equal(isScriptableUrl('chrome://settings'), false)
  assert.equal(originPattern('https://example.com/path'), 'https://example.com/*')
})

test('activate_tab needs a target, and its fallback URL passes the same gate', () => {
  assert.deepEqual(
    validateCommand({
      action: { type: 'activate_tab', params: { urlContains: 'interactivebrokers' } },
    }),
    { type: 'activate_tab', params: { urlContains: 'interactivebrokers' } },
  )
  assert.deepEqual(
    validateCommand({
      action: {
        type: 'activate_tab',
        params: { url: 'https://example.com/portal', urlContains: 'example.com' },
      },
    }),
    {
      type: 'activate_tab',
      params: { url: 'https://example.com/portal', urlContains: 'example.com' },
    },
  )
  assert.throws(
    () => validateCommand({ action: { type: 'activate_tab', params: {} } }),
    /urlContains or url/,
  )
  /* The find-or-open fallback is still a navigation: privileged schemes are
   * refused exactly as they are for navigate. */
  assert.throws(
    () =>
      validateCommand({
        action: { type: 'activate_tab', params: { url: 'file:///etc/passwd' } },
      }),
    /Only http/,
  )
})

test('commands are validated before touching a tab', () => {
  assert.deepEqual(
    validateCommand({
      action: { type: 'click', params: { selector: '#save', tabId: 4 } },
    }),
    { type: 'click', params: { selector: '#save', tabId: 4 } },
  )
  assert.deepEqual(
    validateCommand({
      action: { type: 'click', params: { ref: 'e3' } },
    }),
    { type: 'click', params: { ref: 'e3' } },
  )
  assert.deepEqual(
    validateCommand({
      action: { type: 'snapshot', params: { maxElements: 40 } },
    }),
    { type: 'snapshot', params: { maxElements: 40 } },
  )
  assert.deepEqual(
    validateCommand({
      action: { type: 'wait_for', params: { textContains: 'Done' } },
    }),
    { type: 'wait_for', params: { textContains: 'Done' } },
  )
  assert.deepEqual(
    validateCommand({ action: { type: 'list_tabs', params: {} } }),
    { type: 'list_tabs', params: {} },
  )
  assert.throws(
    () => validateCommand({ action: { type: 'type', params: {} } }),
    /selector or snapshot ref/,
  )
  assert.throws(
    () => validateCommand({ action: { type: 'delete_history', params: {} } }),
    /Unsupported/,
  )
})

test('target selection honors explicit tab, URL matching, and recency', () => {
  const tabs = [
    { id: 1, windowId: 1, active: true, url: 'https://example.com', lastAccessed: 5 },
    { id: 2, windowId: 2, active: true, url: 'https://mail.example', lastAccessed: 10 },
    { id: 3, windowId: 2, active: false, url: 'https://docs.example', lastAccessed: 20 },
  ]

  assert.equal(pickTargetTab(tabs, { tabId: 1 })?.id, 1)
  assert.equal(pickTargetTab(tabs, { urlContains: 'docs.' })?.id, 3)
  assert.equal(pickTargetTab(tabs, {}, 'last-focused')?.id, 2)
  assert.equal(pickTargetTab(tabs, { windowId: 1 })?.id, 1)
})

/*
 * The receiving side defends itself: a command queued hours ago would open tabs
 * unrelated to anything the owner is doing now.
 */
test('a command queued long ago is refused rather than run', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')
  const command = {
    commandId: 'browser_stale',
    createdAt: new Date(now - 4 * 60 * 60 * 1000).toISOString(),
    action: { type: 'navigate', params: { url: 'https://example.com' } },
  }

  assert.throws(() => validateCommand(command, now), /queued 14400s ago/)
})

test('a fresh command still runs', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')
  const command = {
    commandId: 'browser_fresh',
    createdAt: new Date(now - 5_000).toISOString(),
    action: { type: 'navigate', params: { url: 'https://example.com' } },
  }

  assert.equal(validateCommand(command, now).type, 'navigate')
})

test('a command right on the expiry boundary is still honoured', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')
  const at = (ms) => ({
    commandId: 'b',
    createdAt: new Date(now - ms).toISOString(),
    action: { type: 'list_tabs', params: {} },
  })

  assert.equal(validateCommand(at(MAX_COMMAND_AGE_MS), now).type, 'list_tabs')
  assert.throws(() => validateCommand(at(MAX_COMMAND_AGE_MS + 1), now), /Refused/)
})

/* Older agents do not stamp createdAt. Refusing everything from one would take
 * the bridge down entirely, which is worse than the surprise this guards. */
test('a command without a timestamp is not refused for staleness', () => {
  const command = { commandId: 'b', action: { type: 'list_tabs', params: {} } }
  assert.equal(validateCommand(command).type, 'list_tabs')
})

test('a stale command is refused whatever it asks for, valid or not', () => {
  const now = Date.parse('2026-08-07T12:00:00.000Z')
  const command = {
    commandId: 'b',
    createdAt: new Date(now - 10 * 60 * 1000).toISOString(),
    action: { type: 'not_a_real_command', params: {} },
  }
  assert.throws(() => validateCommand(command, now), /Refused/)
})

/* ================================================ privacy boundary ======== */

/*
 * The trap this whole mechanism is built around, pinned as its own test.
 *
 * A mask written for a `key: value` shape turns "The wifi password is hunter2."
 * into "The wifi password is hunter2.: [withheld]": every character of the
 * secret survives while the result claims it was withheld. The survivor check
 * is a function, so it is tested against that exact bad output.
 */
test('the verifier rejects a mask that leaves the secret in place', () => {
  const original = 'The wifi password is hunter2.'

  assert.equal(verifyWithheld(original, `${original}: [withheld]`), false)
  assert.equal(verifyWithheld(original, 'The wifi [withheld] is hunter2.'), false)
  assert.equal(verifyWithheld(original, '[withheld]'), true)
})

test('a secret spoken in a sentence does not survive redaction', () => {
  const out = withholdSecrets('The wifi password is hunter2.')

  assert.equal(out.text.includes('hunter2'), false)
  assert.equal(out.verified, true)
  assert.ok(out.withheld >= 1)
})

/* Withholding a sentence must not cost the page. Segmenting is what makes the
 * difference between "this line is withheld" and "this page is unreadable". */
test('withholding one line leaves the rest of the page readable', () => {
  const out = withholdSecrets(
    ['Order #4187', 'The safe combination is 19-42-8.', 'Ships Tuesday.'].join('\n'),
  )

  assert.match(out.text, /Order #4187/)
  assert.match(out.text, /Ships Tuesday/)
  assert.equal(out.text.includes('19-42-8'), false)
})

test('a key that is its own secret loses only its span', () => {
  const out = withholdSecrets('Deploy with sk-ABCDEFGHIJKLMNOPQRSTUVWX and retry.')

  assert.equal(out.text.includes('sk-ABCDEFGHIJKLMNOPQRSTUVWX'), false)
  assert.match(out.text, /Deploy with/)
  assert.match(out.text, /and retry/)
})

test('a card number in page text does not leave the browser', () => {
  const out = withholdSecrets('Paying with 4242 4242 4242 4242 today.')

  assert.equal(/4242/.test(out.text), false)
  assert.match(out.text, /today/)
})

test('ordinary page text is untouched', () => {
  const text = 'Flight AA118 departs at 14:20 from gate B7.'
  const out = withholdSecrets(text)

  assert.equal(out.text, text)
  assert.equal(out.withheld, 0)
})

/*
 * The guard, exercised directly: a rule that matches the label and nothing
 * else. Replacing its span strips the word and leaves the secret — precisely
 * what maskSecretValue does — so the verification must fire and the segment go
 * whole. Without this the mechanism would report action:"withheld" over text
 * that still carries the value.
 */
test('a rule that removes the label but not the value is caught, not trusted', () => {
  const leaky = {
    ...PRIVACY_RULES,
    secretLabelPatterns: [],
    secretValuePatterns: ['\\bpassword\\b'],
  }

  const out = withholdSecrets('The wifi password is hunter2.', leaky)

  assert.equal(out.verified, false, 'the rules are reported as unsound')
  assert.equal(
    out.text.includes('hunter2'),
    false,
    'and the segment goes whole rather than shipping the secret',
  )
})

test('form fields are classified from how they describe themselves', () => {
  const of = (field) => classifyFieldSensitivity(field)

  assert.equal(of({ type: 'password' }), 'credential')
  assert.equal(of({ type: 'text', autocomplete: 'current-password' }), 'credential')
  assert.equal(of({ type: 'text', autocomplete: 'one-time-code' }), 'credential')
  assert.equal(of({ type: 'text', name: 'user_password' }), 'credential')
  assert.equal(of({ type: 'text', autocomplete: 'cc-number' }), 'payment')
  assert.equal(of({ type: 'text', name: 'cardNumber' }), 'payment')
  assert.equal(of({ type: 'text', label: 'Card number' }), 'payment')
  assert.equal(of({ type: 'text', name: 'cvv' }), 'payment')
  assert.equal(of({ type: 'text', name: 'iban' }), 'payment')
  assert.equal(of({ type: 'email', name: 'email' }), 'normal')
  assert.equal(of({ type: 'text', name: 'quantity' }), 'normal')
  assert.equal(of({}), 'normal')
})

/*
 * The hole this closes.
 *
 * read_page mode:"html" returns document.documentElement.outerHTML, which is
 * every hidden input on the page — session ids, CSRF and bearer tokens — plus
 * any server-rendered value= on a card or password field. Nothing looked at it:
 * the markup crossed to the agent whole, was stored with the result, and is
 * exactly the kind of text that ends up in a third-party prompt.
 */
test('markup does not carry hidden and credential field values out', () => {
  const html = [
    '<form>',
    '<input type="hidden" name="authenticity_token" value="tok_9d3f8a1c">',
    '<input type="password" name="password" value="hunter2">',
    '<input type="text" name="cc-number" value="4242424242424242">',
    '<input type="text" name="city" value="Madison">',
    '</form>',
  ].join('')

  const out = withholdMarkupValues(html)

  assert.equal(out.html.includes('tok_9d3f8a1c'), false)
  assert.equal(out.html.includes('hunter2'), false)
  assert.equal(out.html.includes('4242424242424242'), false)
  assert.match(out.html, /value="Madison"/, 'an ordinary field is left alone')
  assert.equal(out.withheld, 3)
})

test('an extraction is scrubbed before it can leave Safari', () => {
  const { result, privacy } = sanitizeExtraction({
    mode: 'html',
    content:
      '<p>Welcome back</p><input type="hidden" name="csrf" value="tok_abc123def456">' +
      '<p>The wifi password is hunter2.</p>',
  })

  assert.equal(result.content.includes('tok_abc123def456'), false)
  assert.equal(result.content.includes('hunter2'), false)
  assert.match(result.content, /Welcome back/)
  assert.ok(privacy.withheld >= 2)
  assert.equal(privacy.verified, true)
  assert.match(result.privacy.boundary, /sanitizeExtraction/)
})

test('a snapshot names its credential fields without carrying their contents', () => {
  const { result } = sanitizeExtraction({
    elements: [
      { ref: 'e0', role: 'textbox', name: 'Email', inputType: 'email', fieldName: 'email' },
      { ref: 'e1', role: 'textbox', name: 'Password', inputType: 'password', fieldName: 'password' },
      { ref: 'e2', role: 'textbox', name: 'Card number', inputType: 'text', autocomplete: 'cc-number' },
    ],
  })

  assert.equal(result.elements[0].name, 'Email', 'ordinary fields are untouched')
  /* The ref and the role stay: an agent still has to be able to tell the owner
   * there is a password field waiting for them. What it never gets is anything
   * the field is carrying, or the name it would be submitted under. */
  assert.equal(result.elements[1].ref, 'e1')
  assert.equal(result.elements[1].role, 'textbox')
  assert.equal(result.elements[1].sensitivity, 'credential')
  assert.equal(result.elements[1].fieldName, undefined)
  assert.equal(result.elements[2].sensitivity, 'payment')
  assert.deepEqual(result.privacy.fields, [
    { ref: 'e1', sensitivity: 'credential' },
    { ref: 'e2', sensitivity: 'payment' },
  ])
})

/*
 * list_tabs returns full URLs on purpose — the agent targets tabs with
 * urlContains — and a magic-link or password-reset tab carries its token in the
 * query string. Only the value patterns run over a URL: a label pass would
 * withhold the whole of /account/password and break the targeting.
 */
test('a token in a tab URL does not ride along with the tab list', () => {
  const { result } = sanitizeExtraction({
    tabs: [
      { tabId: 1, url: 'https://mail.example/login?t=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.sig' },
      { tabId: 2, url: 'https://example.com/account/password' },
    ],
  })

  assert.equal(result.tabs[0].url.includes('eyJhbGciOiJIUzI1NiJ9'), false)
  assert.equal(result.tabs[0].urlWithheld, true)
  assert.equal(
    result.tabs[1].url,
    'https://example.com/account/password',
    'a page merely named "password" is still addressable',
  )
})

/* ==================================================== provenance ========== */

test('an extraction says which tab it came from and what it was pointed at', () => {
  const provenance = provenanceFor({
    command: {
      commandId: 'browser_7',
      action: { type: 'read_page', params: { selector: 'main.receipt' } },
    },
    tab: { id: 42, windowId: 7, url: 'https://shop.example/r/9', title: 'Receipt' },
    result: { url: 'https://shop.example/r/9?x=1', title: 'Receipt' },
    now: Date.parse('2026-08-07T12:00:00.000Z'),
  })

  assert.equal(provenance.commandId, 'browser_7')
  assert.equal(provenance.action, 'read_page')
  assert.equal(provenance.tabId, 42)
  assert.equal(provenance.windowId, 7)
  assert.equal(provenance.url, 'https://shop.example/r/9?x=1')
  assert.equal(provenance.locator, 'main.receipt')
  assert.equal(provenance.observedAt, '2026-08-07T12:00:00.000Z')
})

/* A navigate can be redirected. Keeping both means the difference stays visible
 * instead of being quietly resolved in favour of whichever one was written
 * last. */
test('a redirect leaves both the requested and the landed URL on the record', () => {
  const provenance = provenanceFor({
    command: {
      commandId: 'browser_8',
      action: { type: 'navigate', params: { url: 'https://example.com/a' } },
    },
    tab: { id: 1, windowId: 1 },
    result: { url: 'https://example.com/login?next=/a' },
  })

  assert.equal(provenance.requestedUrl, 'https://example.com/a')
  assert.equal(provenance.url, 'https://example.com/login?next=/a')
  assert.equal(provenance.locator, 'document', 'a whole-page read is still located')
})

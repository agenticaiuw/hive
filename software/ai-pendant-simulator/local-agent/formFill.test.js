import assert from 'node:assert/strict'
import test from 'node:test'

import {
  buildPayload,
  linkElements,
  matchField,
  normalizeKey,
  parseAttributes,
  parseFormHtml,
  renderPreview,
} from './formFill.js'

/* The real markup of the public Selenium test form, trimmed to the controls
 * this exercises. Kept verbatim so the parser is tested against a page that
 * exists rather than one written to suit it. */
const FORM_HTML = `<form action="submitted-form.html" method="get">
  <label>Text input <input type="text" name="my-text" id="my-text-id" required></label>
  <label>Password <input type="password" name="my-password"></label>
  <label>Textarea <textarea name="my-textarea" rows="3"></textarea></label>
  <label>Disabled input <input type="text" name="my-disabled" disabled></label>
  <select name="my-select"><option selected>Open this select menu</option><option value="1">One</option><option value="2">Two</option></select>
  <input type="file" name="my-file">
  <input class="form-check-input" type="checkbox" name="my-check" id="my-check-1" value="on" checked>
  <input class="form-check-input" type="checkbox" name="my-check" id="my-check-2" value="on">
  <input class="form-check-input" type="radio" name="my-radio" id="my-radio-1" value="on" checked>
  <button class="btn btn-outline-primary mt-3" type="submit">Submit</button>
</form>`

/* What browser_snapshot returns for that page. */
const SNAPSHOT = [
  { ref: 'e0', selector: '#my-text-id', role: 'textbox', tag: 'input', inputType: 'text', name: 'Text input', disabled: false },
  { ref: 'e1', selector: 'form > label:nth-of-type(2) > input', role: 'textbox', tag: 'input', inputType: 'password', name: 'Password', disabled: false },
  { ref: 'e2', selector: 'form > label:nth-of-type(3) > textarea', role: 'textbox', tag: 'textarea', name: 'Textarea', disabled: false },
  { ref: 'e3', selector: 'form > label:nth-of-type(4) > input', role: 'textbox', tag: 'input', inputType: 'text', name: 'Disabled input', disabled: true },
  { ref: 'e4', selector: 'form > select', role: 'combobox', tag: 'select', name: 'my-select', disabled: false },
  { ref: 'e5', selector: 'form > input:nth-of-type(1)', role: 'textbox', tag: 'input', inputType: 'file', name: 'File input', disabled: false },
  { ref: 'e6', selector: '#my-check-1', role: 'checkbox', tag: 'input', inputType: 'checkbox', name: 'Checked checkbox', checked: true, disabled: false },
  { ref: 'e7', selector: '#my-check-2', role: 'checkbox', tag: 'input', inputType: 'checkbox', name: 'Default checkbox', checked: false, disabled: false },
  { ref: 'e8', selector: '#my-radio-1', role: 'radio', tag: 'input', inputType: 'radio', name: 'Checked radio', checked: true, disabled: false },
  { ref: 'e9', selector: 'form > button', role: 'button', tag: 'button', name: 'Submit', disabled: false },
]

const PAGE_URL = 'https://www.selenium.dev/selenium/web/web-form.html'

function linked() {
  const { form, controls } = parseFormHtml(FORM_HTML, PAGE_URL)
  return { form, elements: linkElements(SNAPSHOT, controls) }
}

test('bare html attributes are their own truth value', () => {
  const attributes = parseAttributes(' type="text" name=my-text required disabled')
  assert.equal(attributes.type, 'text')
  assert.equal(attributes.name, 'my-text')
  assert.ok('required' in attributes)
  assert.ok('disabled' in attributes)
})

test('the submit contract is read off the page, not guessed', () => {
  const { form } = parseFormHtml(FORM_HTML, PAGE_URL)
  assert.equal(form.method, 'GET')
  assert.equal(
    form.submitsTo,
    'https://www.selenium.dev/selenium/web/submitted-form.html',
  )
})

test('an empty action submits back to the page itself', () => {
  const { form } = parseFormHtml('<form method="post"><input name="q"></form>', PAGE_URL)
  assert.equal(form.submitsTo, PAGE_URL)
  assert.equal(form.enctype, 'application/x-www-form-urlencoded')
})

test('wire names come from the markup and are tied to the ref that can reach them', () => {
  const { elements } = linked()
  const byRef = Object.fromEntries(elements.map((element) => [element.ref, element]))
  assert.equal(byRef.e0.control.name, 'my-text')
  assert.equal(byRef.e0.control.required, true)
  assert.equal(byRef.e1.control.name, 'my-password')
  assert.equal(byRef.e2.control.name, 'my-textarea')
  assert.equal(byRef.e4.control.options.length, 3)
  assert.equal(byRef.e9.isSubmit, true)
})

test('a dictated label finds the field the backend calls something else', () => {
  const { elements } = linked()
  assert.equal(matchField('Text input', elements).element.ref, 'e0')
  assert.equal(matchField('my-textarea', elements).element.ref, 'e2')
  assert.equal(matchField('#my-check-2', elements).element.ref, 'e7')
  assert.equal(matchField('nothing like this on the page', elements), null)
})

test('the submit control is never a fill target', () => {
  const { elements } = linked()
  const hit = matchField('Submit', elements)
  assert.ok(hit === null || hit.element.isSubmit === false)
})

test('the manifest is what the browser would send, not what we typed', () => {
  const { elements } = linked()
  const filled = new Map([
    ['e0', { value: 'Wisconsin' }],
    ['e2', { value: 'notes from the call' }],
    ['e4', { value: '2' }],
    ['e7', { value: true }],
    ['e1', { value: '', redacted: true }],
  ])
  /* The page after filling: the second checkbox is now ticked. */
  const after = elements.map((element) =>
    element.ref === 'e7' ? { ...element, checked: true } : element,
  )
  const { entries, omitted } = buildPayload(after, filled)
  const byName = entries.map((entry) => `${entry.name}=${entry.value}`)

  assert.ok(byName.includes('my-text=Wisconsin'))
  assert.ok(byName.includes('my-textarea=notes from the call'))
  assert.ok(byName.includes('my-select=2'))
  /* Both boxes share a name; both are sent because both are ticked. */
  assert.equal(byName.filter((entry) => entry === 'my-check=on').length, 2)
  assert.ok(byName.includes('my-radio=on'))

  /* Disabled and file controls are not sent by any browser, and the submit
   * button is only sent when it is the one clicked — which it never is. */
  assert.ok(!byName.some((entry) => entry.startsWith('my-disabled')))
  assert.ok(omitted.some((entry) => entry.name === 'my-disabled'))
  assert.ok(omitted.some((entry) => entry.name === 'my-file'))
  assert.ok(!entries.some((entry) => entry.label === 'Submit'))

  /* A password is named so the owner can type it, and never carries a value. */
  const password = entries.find((entry) => entry.name === 'my-password')
  assert.equal(password.value, '')
  assert.equal(password.redacted, true)
})

test('an unticked box is absent from the payload, the way a browser omits it', () => {
  const { elements } = linked()
  const { entries } = buildPayload(elements, new Map())
  assert.equal(entries.filter((entry) => entry.name === 'my-check').length, 1)
})

test('the preview spells out the request the owner is about to make', () => {
  const { form, elements } = linked()
  const { entries } = buildPayload(elements, new Map([['e0', { value: 'Wisconsin & co' }]]))
  const preview = renderPreview(form, entries)
  assert.match(preview, /^GET https:\/\/www\.selenium\.dev\/selenium\/web\/submitted-form\.html\?/)
  assert.match(preview, /my-text=Wisconsin%20%26%20co/)
  /* Redacted values never reach a preview that gets logged and spoken. */
  assert.ok(!preview.includes('my-password=hunter2'))
})

test('a POST preview carries its body and content type', () => {
  const { form, controls } = parseFormHtml(
    '<form action="/search" method="post"><input name="q" value="pendant"></form>',
    'https://example.com/page',
  )
  const elements = linkElements(
    [{ ref: 'e0', selector: 'form > input', role: 'textbox', tag: 'input', inputType: 'text', name: 'q' }],
    controls,
  )
  const { entries } = buildPayload(elements, new Map())
  const preview = renderPreview(form, entries)
  assert.match(preview, /^POST https:\/\/example\.com\/search/)
  assert.match(preview, /Content-Type: application\/x-www-form-urlencoded/)
  assert.match(preview, /q=pendant/)
})

test('labels are compared the way a person reads them', () => {
  assert.equal(normalizeKey('E-mail Address:'), 'emailaddress')
  assert.equal(normalizeKey('cust_email'), 'custemail')
})

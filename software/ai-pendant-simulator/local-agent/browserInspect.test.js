import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import test from 'node:test'

import {
  actOnInspection,
  formatInspection,
  getInspection,
  inspectPage,
  proposeAction,
  relocate,
} from './browserInspect.js'

/* A disposable store, so an inspection in a test never lands in the owner's
 * real history. */
function store(t) {
  const directory = fs.mkdtempSync(path.join(os.tmpdir(), 'inspect-'))
  t.after(() => fs.rmSync(directory, { recursive: true, force: true }))
  const previous = process.env.PENDANT_INSPECT_STORE_PATH
  process.env.PENDANT_INSPECT_STORE_PATH = path.join(directory, 'inspections.json')
  t.after(() => {
    if (previous === undefined) delete process.env.PENDANT_INSPECT_STORE_PATH
    else process.env.PENDANT_INSPECT_STORE_PATH = previous
  })
}

const PAGE_TEXT =
  'Order #4471 shipped on 3 August and is due to arrive on 11 August. ' +
  'Your total was $184.20, charged to the card ending 4429.'

const ELEMENTS = [
  { ref: 'e0', role: 'link', name: 'Home', tag: 'a', selector: 'nav > a:nth-child(1)', href: 'https://shop.example/' },
  { ref: 'e1', role: 'link', name: 'Download invoice', tag: 'a', selector: '#invoice-link', href: 'https://shop.example/invoice/4471.pdf' },
  { ref: 'e2', role: 'button', name: 'Cancel order', tag: 'button', selector: '#cancel' },
  { ref: 'e3', role: 'textbox', name: 'Search orders', tag: 'input', selector: '#q' },
]

function fakeBrowser({ text = PAGE_TEXT, elements = ELEMENTS } = {}) {
  const calls = { address: [], read: [], snapshot: [], run: [] }
  return {
    calls,
    deps: {
      address: async (url, options) => {
        calls.address.push({ url, options })
        return {
          target: { urlContains: 'shop.example/orders/4471' },
          url: 'https://shop.example/orders/4471',
          title: 'Order #4471',
          disposition: 'reloaded',
        }
      },
      readText: async (target, options) => {
        calls.read.push({ target, options })
        return { content: text, title: 'Order #4471', url: 'https://shop.example/orders/4471' }
      },
      snapshot: async (target, options) => {
        calls.snapshot.push({ target, options })
        return { elements, title: 'Order #4471', url: 'https://shop.example/orders/4471' }
      },
    },
    act: {
      snapshot: async (target, options) => {
        calls.snapshot.push({ target, options })
        return { elements, title: 'Order #4471', url: 'https://shop.example/orders/4471' }
      },
      run: async (type, params, options) => {
        calls.run.push({ type, params, options })
        return { message: `Clicked ${params.ref}` }
      },
    },
  }
}

test('inspect reads the page, cites what it found, and touches nothing', async (t) => {
  store(t)
  const browser = fakeBrowser()

  const inspection = await inspectPage(
    { url: 'https://shop.example/orders/4471', look: ['11 August', '$184.20'] },
    browser.deps,
  )

  assert.equal(inspection.url, 'https://shop.example/orders/4471')
  assert.equal(inspection.findings.length, 2)
  for (const finding of inspection.findings) {
    assert.equal(finding.missing, undefined)
    assert.ok(finding.quote.includes(finding.term), 'the quote has to contain the thing it cites')
    assert.equal(finding.citation.url, 'https://shop.example/orders/4471')
    assert.ok(finding.citation.retrievedAt)
  }

  assert.equal(browser.calls.run.length, 0, 'inspect must not run a browser action')
  assert.equal(inspection.acts.length, 0)
})

test('the reading phase is only allowed to read', async (t) => {
  store(t)
  const browser = fakeBrowser()

  await inspectPage({ url: 'https://shop.example/orders/4471' }, browser.deps)

  for (const call of [...browser.calls.address, ...browser.calls.read, ...browser.calls.snapshot]) {
    const allow = call.options?.options?.allow ?? call.options?.allow
    assert.ok(allow, 'every reading call carries the read-only vocabulary')
    assert.deepEqual([...allow].sort(), ['list_tabs', 'navigate', 'read_page', 'snapshot'])
    assert.equal(allow.has('click'), false)
    assert.equal(allow.has('type'), false)
  }
})

test('a term that is not on the page comes back as absent, not invented', async (t) => {
  store(t)
  const browser = fakeBrowser()

  const inspection = await inspectPage(
    { url: 'https://shop.example/orders/4471', look: ['refund issued'] },
    browser.deps,
  )

  const finding = inspection.findings[0]
  assert.equal(finding.missing, true)
  assert.equal(finding.quote, null)
  assert.match(finding.citation.locator, /no occurrence of “refund issued”/)
})

test('the proposed action is the one the goal points at, with its evidence', async (t) => {
  store(t)
  const browser = fakeBrowser()

  const inspection = await inspectPage(
    { url: 'https://shop.example/orders/4471', goal: 'download the invoice' },
    browser.deps,
  )

  assert.equal(inspection.proposal.action.type, 'browser_click')
  assert.equal(inspection.proposal.element.name, 'Download invoice')
  assert.equal(inspection.proposal.element.selector, '#invoice-link')
  assert.match(inspection.proposal.effect, /Follows “Download invoice” to https:\/\/shop\.example\/invoice/)
  assert.match(inspection.proposal.citation.locator, /link “Download invoice” at #invoice-link/)
  assert.equal(browser.calls.run.length, 0, 'proposing is not doing')
  assert.match(formatInspection(inspection), /Nothing on the page was touched/)
})

test('nothing matching means no proposal, rather than a guessed click', () => {
  const proposal = proposeAction({
    goal: 'cancel my gym membership',
    elements: [{ ref: 'e0', role: 'link', name: 'Home', selector: 'a', href: 'https://shop.example/' }],
    source: { url: 'https://shop.example/', title: 'Shop', retrievedAt: '2026-08-07T00:00:00.000Z' },
  })
  assert.equal(proposal, null)
})

test('an element is re-found by what it is, never by a stale ref', () => {
  const reshuffled = [
    { ref: 'e0', role: 'button', name: 'Accept cookies', selector: '#cookie-banner button' },
    { ref: 'e1', role: 'link', name: 'Home', selector: 'nav > a:nth-child(1)' },
    { ref: 'e2', role: 'link', name: 'Download invoice', selector: '#invoice-link' },
  ]

  assert.deepEqual(
    relocate(reshuffled, { ref: 'e1', role: 'link', name: 'Download invoice', selector: '#invoice-link' }),
    { element: reshuffled[2], matchedBy: 'selector' },
  )

  assert.equal(
    relocate(reshuffled, { ref: 'e1', role: 'link', name: 'Download invoice', selector: '#moved' })
      .matchedBy,
    'name+role',
  )

  assert.equal(
    relocate(reshuffled, { ref: 'e1', role: 'link', name: 'Gone', selector: '#gone' }).element,
    null,
  )
})

test('act runs the proposed step on the element it described, even after the page reshuffles', async (t) => {
  store(t)
  const browser = fakeBrowser()

  const inspection = await inspectPage(
    { url: 'https://shop.example/orders/4471', goal: 'download the invoice' },
    browser.deps,
  )
  assert.equal(inspection.proposal.action.params.ref, 'e1')

  /* A banner loaded since the inspection, so every ref shifted by one. The
   * stale ref e1 now points at "Cancel order". */
  const reshuffled = [
    { ref: 'e0', role: 'button', name: 'Accept cookies', selector: '#cookie-banner button' },
    { ref: 'e1', role: 'button', name: 'Cancel order', selector: '#cancel' },
    { ref: 'e2', role: 'link', name: 'Download invoice', selector: '#invoice-link', href: 'https://shop.example/invoice/4471.pdf' },
  ]

  const outcome = await actOnInspection(
    inspection.inspectionId,
    {},
    {
      snapshot: async () => ({ elements: reshuffled, url: 'https://shop.example/orders/4471' }),
      run: browser.act.run,
    },
  )

  assert.equal(browser.calls.run.length, 1)
  assert.deepEqual(browser.calls.run[0], {
    type: 'click',
    params: { ref: 'e2' },
    options: { source: 'browser-inspect-act', label: 'click “Download invoice”' },
  })
  assert.equal(outcome.relocated, true)
  assert.equal(outcome.matchedBy, 'selector')

  assert.equal(getInspection(inspection.inspectionId).acts.length, 1)
})

test('an element that is genuinely gone fails instead of clicking something else', async (t) => {
  store(t)
  const browser = fakeBrowser()
  const inspection = await inspectPage(
    { url: 'https://shop.example/orders/4471', goal: 'download the invoice' },
    browser.deps,
  )

  await assert.rejects(
    () =>
      actOnInspection(
        inspection.inspectionId,
        {},
        {
          snapshot: async () => ({
            elements: [{ ref: 'e0', role: 'button', name: 'Cancel order', selector: '#cancel' }],
            url: 'https://shop.example/orders/4471',
          }),
          run: browser.act.run,
        },
      ),
    /no longer on https:\/\/shop\.example\/orders\/4471/,
  )
  assert.equal(browser.calls.run.length, 0)
})

test('a textbox proposal asks for the text; it does not invent one', async (t) => {
  store(t)
  const browser = fakeBrowser()
  const inspection = await inspectPage(
    { url: 'https://shop.example/orders/4471', goal: 'search orders for the shipping label' },
    browser.deps,
  )

  assert.equal(inspection.proposal.action.type, 'browser_type')
  assert.equal(inspection.proposal.element.selector, '#q')

  await assert.rejects(
    () => actOnInspection(inspection.inspectionId, {}, browser.act),
    /pass the text to type/,
  )

  const outcome = await actOnInspection(
    inspection.inspectionId,
    { text: 'shipping label' },
    browser.act,
  )
  assert.equal(outcome.ok, true)
  assert.deepEqual(browser.calls.run.at(-1).params, { ref: 'e3', text: 'shipping label' })
})

test('inspect adds a phase; it does not gate the ones that already existed', async (t) => {
  store(t)
  const browser = fakeBrowser()
  const inspection = await inspectPage(
    { url: 'https://shop.example/orders/4471', goal: 'download the invoice' },
    browser.deps,
  )

  /* No token, no expiry, no approval — an inspection is a description of a page
   * and a suggestion, and browser_click remains callable without ever having
   * made one. */
  for (const forbidden of ['confirmationToken', 'expiresAt', 'approvedAt', 'requiresApproval']) {
    assert.equal(forbidden in inspection, false)
    assert.equal(forbidden in inspection.proposal, false)
  }
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  excerptAround,
  isHttpUrl,
  matchTabs,
  normalizeText,
  runBrowserActions,
  tabNeedle,
} from './browserPage.js'

test('a tab needle keeps host and path and drops everything volatile', () => {
  assert.equal(
    tabNeedle('https://Shop.Example.com/orders/42?utm_source=mail#top'),
    'shop.example.com/orders/42',
  )
  assert.equal(tabNeedle('https://example.com/'), 'example.com')
})

test('tabs are matched through added query parameters and a scheme change', () => {
  const tabs = [
    { tabId: 1, url: 'https://www.google.com/?zx=1786081086668' },
    { tabId: 2, url: 'http://shop.example.com/orders/42?session=abc123' },
  ]
  const matched = matchTabs(tabs, 'https://shop.example.com/orders/42')
  assert.equal(matched.length, 1)
  assert.equal(matched[0].tabId, 2)
})

test('only http(s) pages are addressable', () => {
  assert.equal(isHttpUrl('https://example.com'), true)
  assert.equal(isHttpUrl('file:///etc/hosts'), false)
  assert.equal(isHttpUrl('not a url'), false)
})

test('an allowlisted caller cannot reach an action outside its promise', async () => {
  await assert.rejects(
    runBrowserActions(
      [{ type: 'browser_click', params: { ref: 'e3' } }],
      { allow: new Set(['read_page', 'navigate']) },
    ),
    /only reads the page/,
  )
})

test('the allowlist accepts what the caller did promise', async () => {
  /* A fresh module instance pointed at a dead port: a rejection here is the
   * fetch failing, not the guard, which is the point — the guard let it
   * through. The live agent must not be touched by a unit test. */
  process.env.LOCAL_AGENT_URL = 'http://127.0.0.1:1'
  const isolated = await import(`./browserPage.js?deadport=${Date.now()}`)
  delete process.env.LOCAL_AGENT_URL

  await assert.rejects(
    isolated.runBrowserActions([{ type: 'browser_read_page', params: {} }], {
      allow: new Set(['read_page']),
      timeoutMs: 500,
      command: 'guard test',
    }),
    (error) => !/only reads the page/.test(String(error?.message)),
  )
})

test('evidence keeps the words around the value', () => {
  const text = 'Order #42\n\n  Status:   Shipped   \n Estimated delivery Friday'
  assert.equal(normalizeText(text), 'Order #42 Status: Shipped Estimated delivery Friday')
  assert.match(excerptAround(text, 'Shipped', 10), /Status: Shipped Estimated/)
})

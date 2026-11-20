import assert from 'node:assert/strict'
import { test } from 'node:test'
import { goFor, keeps, linksFor, outlinePage, rulesFor, siteOf, styleFor, validSelector } from '../src/page-rules-core.js'

test('a page gets its own rules and the whole site\'s', () => {
  const rules = [{ id: 1, path: '/', rule: {} }, { id: 2, path: '', rule: {} }, { id: 3, path: '/courses', rule: {} }]
  assert.deepEqual(rulesFor(rules, '/').map((r) => r.id), [1, 2])
  assert.deepEqual(rulesFor(rules, '/courses/').map((r) => r.id), [2, 3])
  assert.equal(siteOf('www.Canvas.wisc.edu'), 'canvas.wisc.edu')
})

test('hidden selectors become one style rule, and nothing can break out of it', () => {
  const css = styleFor([{ rule: { hide: ['#right-side', 'x{}', '.banner'], css: '.a{color:red}' } }])
  assert.match(css, /#right-side,\n\.banner \{ display: none !important; \}/)
  assert.match(css, /\.a\{color:red\}/)
  assert.equal(validSelector('a</style>'), false)
})

test('keep leaves only the items that name what the owner wants', () => {
  assert.equal(keeps('COMP SCI 400: Programming III  Fall 2026', ['comp sci 400']), true)
  assert.equal(keeps('Old course Spring 2025', ['comp sci 400', 'math 341']), false)
})

// The owner (2026-11-17): "remove these shorts from my subscriptions page" came back "the rule changes nothing": the
// outline was cut at 50,000 characters inside the first rows of videos, before the Shorts shelf.
function fakeElement(tag, { id = '', classes = [], attrs = {}, text = '', children = [] } = {}) {
  const el = {
    tagName: tag.toUpperCase(), id, classList: classes, children,
    childNodes: text ? [{ nodeType: 3, textContent: text }, ...children] : children,
    attributes: Object.entries({ ...attrs, ...(id ? { id } : {}), ...(classes.length ? { class: classes.join(' ') } : {}) }).map(([name, value]) => ({ name, value })),
    getAttribute: (name) => attrs[name] ?? null,
    ownerDocument: { defaultView: { getComputedStyle: () => ({ display: 'block', visibility: 'visible' }) } },
  }
  Object.defineProperty(el, 'textContent', { get: () => [text, ...children.map((c) => c.textContent)].join(' ') })
  return el
}

test("a long feed's outline sums up alike items and still reaches what's below them, with custom attributes named", () => {
  const video = (i) => fakeElement('ytd-rich-item-renderer', { classes: ['style-scope', 'ytd-rich-grid-renderer'], children: [
    fakeElement('div', { id: 'content', classes: ['style-scope'], children: Array.from({ length: 40 }, (_, j) =>
      fakeElement('div', { classes: [`ytLockupPart${j}`], text: j === 0 ? `Video ${i}` : '' })) }),
  ] })
  const shorts = fakeElement('ytd-rich-section-renderer', { classes: ['style-scope'], children: [
    fakeElement('ytd-rich-shelf-renderer', { attrs: { 'is-shorts': '', 'data-x': '1' }, children: [fakeElement('span', { id: 'title', text: 'Shorts' })] }),
  ] })
  const grid = fakeElement('div', { id: 'contents', children: [...Array.from({ length: 60 }, (_, i) => video(i)), shorts] })
  globalThis.document = { body: fakeElement('body', { children: [grid] }) }
  try {
    const outline = outlinePage(12000)
    assert.ok(outline.length < 12000, `fits: ${outline.length}`)
    assert.match(outline, /ytd-rich-shelf-renderer\[is-shorts\]/, 'the Shorts shelf is in it, marked')
    assert.doesNotMatch(outline, /data-x/)
    assert.match(outline, /span#title "Shorts"/)
    assert.equal((outline.match(/ytLockupPart39/g) || []).length, 2, 'the first two videos in full')
    assert.match(outline, /ytd-rich-item-renderer\.style-scope\.ytd-rich-grid-renderer "Video 59"/, 'every other one as one line with its text')
  } finally {
    delete globalThis.document
  }
})

test('go sends one page on within its site, never itself or from an every-page rule', () => {
  const rules = [
    { id: 1, path: '', rule: { go: '/feed/subscriptions' } },
    { id: 2, path: '/', rule: { go: '/feed/subscriptions' } },
  ]
  assert.equal(goFor(rules, 'https://www.youtube.com/'), 'https://www.youtube.com/feed/subscriptions')
  assert.equal(goFor(rules.slice(0, 1), 'https://www.youtube.com/'), null)
  assert.equal(goFor([{ id: 3, path: '/feed/subscriptions', rule: { go: '/feed/subscriptions' } }], 'https://www.youtube.com/feed/subscriptions'), null)
  assert.equal(goFor([{ id: 4, path: '/', rule: { go: 'https://evil.example/' } }], 'https://www.youtube.com/'), null)
  assert.equal(goFor([{ id: 5, path: '/', rule: { go: 'javascript:alert(1)' } }], 'https://www.youtube.com/'), null)
  assert.equal(goFor([{ id: 6, path: '/', rule: { go: 'https://m.youtube.com/feed/subscriptions' } }], 'https://www.youtube.com/'), null)
})

test('add gives checked links on the same site, each with its own key', () => {
  const here = 'https://www.youtube.com/feed/subscriptions'
  const links = linksFor([{ id: 7, path: '', rule: { add: [
    { after: 'ytd-mini-guide-entry-renderer:has(a[href="/feed/subscriptions"])', text: 'Watch later', href: '/playlist?list=WL' },
    { before: '#x', text: 'Elsewhere', href: 'https://evil.example/' },
    { after: 'a{}', text: 'Broken', href: '/' },
    { before: '#y', text: 'Liked', href: '/playlist?list=LL' },
  ] } }], here)
  assert.deepEqual(links, [
    { key: '7-0', where: 'after', anchor: 'ytd-mini-guide-entry-renderer:has(a[href="/feed/subscriptions"])', text: 'Watch later', href: 'https://www.youtube.com/playlist?list=WL' },
    { key: '7-3', where: 'before', anchor: '#y', text: 'Liked', href: 'https://www.youtube.com/playlist?list=LL' },
  ])
})

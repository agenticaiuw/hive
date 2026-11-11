import assert from 'node:assert/strict'
import test from 'node:test'

import { extractDomainFacts } from './domainCapture.js'

const NOW = Date.parse('2026-08-12T10:00:00Z')

const byKey = (facts) => new Map(facts.map((fact) => [fact.key, fact]))

test('a stated email identity is captured hive-wide — the owner’s example', () => {
  const facts = extractDomainFacts({
    command: 'my school email is liu@uni.edu, check it every morning',
    actions: [],
    ok: true,
    node: 'voice',
    now: NOW,
  })
  const fact = byKey(facts).get('dom.email.account.school')
  assert.ok(fact, 'account identity captured')
  assert.equal(fact.value, 'liu@uni.edu')
  assert.equal(fact.scope, 'hive')
  assert.equal(fact.node, 'voice')
})

test('an email recipient becomes a hive contact connection', () => {
  const facts = extractDomainFacts({
    command: 'email nico the firmware notes',
    actions: [
      { type: 'send_email', params: { to: 'nico@example.com', subject: 'notes' } },
    ],
    results: [{ ok: true }],
    ok: true,
    node: 'mac',
    now: NOW,
  })
  const contact = byKey(facts).get('dom.email.contact.nico')
  assert.ok(contact)
  assert.equal(contact.value, 'nico@example.com')
  assert.equal(contact.scope, 'hive')
})

test('a named reminders list is a reusable calendar connection', () => {
  const facts = extractDomainFacts({
    command: 'remind me to buy milk on the family errands list',
    actions: [
      { type: 'create_reminder', params: { title: 'buy milk', list: 'Family Errands' } },
    ],
    results: [{ ok: true }],
    ok: true,
    node: 'mac',
    now: NOW,
  })
  const list = byKey(facts).get('dom.calendar.list.family-errands')
  assert.ok(list, 'the list the owner filed onto is remembered')
  assert.equal(list.value, 'Family Errands')
})

test('acting in a site captures the host, never the page', () => {
  const facts = extractDomainFacts({
    command: 'log my hours on the portal',
    actions: [
      { type: 'browser_navigate', params: { url: 'https://www.portal.example/login' } },
      { type: 'browser_type', params: { url: 'https://www.portal.example/login', text: 'wage-secret-9182' } },
    ],
    results: [{ ok: true }, { ok: true }],
    ok: true,
    node: 'browser',
    now: NOW,
  })
  const site = byKey(facts).get('dom.browser.site.portal.example')
  assert.ok(site, 'the acted-in host is a connection')
  assert.equal(site.value, 'portal.example')
  assert.ok(
    ![...byKey(facts).values()].some((fact) => fact.value.includes('wage-secret-9182')),
    'typed page content never becomes memory',
  )
})

test('reading a site is not a connection', () => {
  const facts = extractDomainFacts({
    command: 'what does the front page say',
    actions: [
      { type: 'browser_navigate', params: { url: 'https://news.example/' } },
      { type: 'browser_read_page', params: {} },
    ],
    results: [{ ok: true }, { ok: true }],
    ok: true,
    node: 'browser',
    now: NOW,
  })
  assert.ok(
    ![...byKey(facts).keys()].some((key) => key.startsWith('dom.browser.site.')),
    'a page merely read is not saved',
  )
})

test('a successful multi-step single-domain run leaves a task shape, node-scoped', () => {
  const run = {
    command: 'move the drafts into the archive folder and tidy downloads',
    actions: [
      { type: 'move_path', params: { from: '/a', to: '/b' } },
      { type: 'sweep_folder_preview', params: {} },
    ],
    results: [{ ok: true }, { ok: true }],
    ok: true,
    node: 'mac',
    now: NOW,
  }
  const facts = extractDomainFacts(run)
  const shape = [...byKey(facts).values()].find((fact) => fact.name.startsWith('task.'))
  assert.ok(shape, 'task shape captured')
  assert.equal(shape.domain, 'files')
  assert.equal(shape.scope, 'node')

  /* Re-running the same shape derives the same key — dedupe by overwrite. */
  const again = extractDomainFacts(run)
  const shapeAgain = [...byKey(again).values()].find((fact) => fact.name.startsWith('task.'))
  assert.equal(shapeAgain.key, shape.key)
})

test('failed runs teach nothing beyond stated identities', () => {
  const facts = extractDomainFacts({
    command: 'my club email is c@club.org — send the agenda to sam@club.org',
    actions: [{ type: 'send_email', params: { to: 'sam@club.org' } }],
    results: [{ ok: false }],
    ok: false,
    node: 'mac',
    now: NOW,
  })
  const keys = [...byKey(facts).keys()]
  assert.deepEqual(keys, ['dom.email.account.club'])
})

test('chatter captures nothing — this is the anti-chat-log property', () => {
  const facts = extractDomainFacts({
    command: 'what a day, tell me a joke about compilers',
    actions: [],
    ok: true,
    node: 'voice',
    now: NOW,
  })
  assert.equal(facts.length, 0)
})

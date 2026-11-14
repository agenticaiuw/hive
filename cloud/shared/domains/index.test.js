import assert from 'node:assert/strict'
import test from 'node:test'

import {
  clarifyDomainRequest,
  DOMAIN_MODULES,
  domainForTool,
  domainsForActions,
  isMemoryToolType,
  MEMORY_DOMAINS,
  MEMORY_TOOL_SPECS,
  MEMORY_TOOL_TYPES,
} from './index.js'

test('the six starting domains exist, in the owner-named vocabulary', () => {
  assert.deepEqual(
    [...MEMORY_DOMAINS].sort(),
    ['browser', 'calendar', 'email', 'files', 'music', 'system'],
  )
})

test('every domain module carries tools, capture and clarify', () => {
  for (const mod of DOMAIN_MODULES) {
    assert.ok(mod.name, 'a domain has a name')
    assert.ok(mod.what, `${mod.name} describes itself`)
    assert.ok(Array.isArray(mod.tools.exact), `${mod.name} lists exact tools`)
    assert.ok(Array.isArray(mod.tools.prefixes), `${mod.name} lists prefixes`)
    assert.ok(Array.isArray(mod.capture), `${mod.name} declares capture rules`)
    assert.ok(Array.isArray(mod.clarify), `${mod.name} declares clarify rules`)
  }
})

test('no tool name is claimed by two domains', () => {
  const seen = new Map()
  for (const mod of DOMAIN_MODULES) {
    for (const name of mod.tools.exact) {
      assert.ok(
        !seen.has(name),
        `${name} claimed by both ${seen.get(name)} and ${mod.name}`,
      )
      seen.set(name, mod.name)
    }
  }
})

test('domainForTool maps both executors and honours the fallback', () => {
  assert.equal(domainForTool('send_email'), 'email')
  assert.equal(domainForTool('create_reminder'), 'calendar')
  assert.equal(domainForTool('write_file'), 'files')
  assert.equal(domainForTool('sweep_folder_preview'), 'files')
  assert.equal(domainForTool('play_youtube'), 'music')
  assert.equal(domainForTool('set_volume'), 'system')
  assert.equal(domainForTool('browser_click'), 'browser')
  assert.equal(domainForTool('activate_tab'), 'browser')
  /* Unclaimed tools have no memories to fetch. */
  assert.equal(domainForTool('get_weather'), null)
  assert.equal(domainForTool('run_shell'), null)
  /* The one deliberate ambiguity: bare `scroll` is desktop input on the Mac
   * and a browser verb in the extension; only the fallback claims it. */
  assert.equal(domainForTool('scroll'), null)
  assert.equal(domainForTool('scroll', { fallback: 'browser' }), 'browser')
})

test('domainsForActions returns unique domains in first-use order', () => {
  assert.deepEqual(
    domainsForActions([
      { type: 'create_reminder', params: {} },
      { type: 'send_email', params: {} },
      { type: 'create_reminder', params: {} },
      { type: 'get_weather', params: {} },
    ]),
    ['calendar', 'email'],
  )
})

test('memory tool specs cover exactly the two deliberate verbs', () => {
  assert.deepEqual([...MEMORY_TOOL_TYPES], ['memory_lookup', 'memory_save'])
  for (const type of MEMORY_TOOL_TYPES) {
    assert.ok(MEMORY_TOOL_SPECS[type]?.description, `${type} is described`)
    assert.ok(MEMORY_TOOL_SPECS[type]?.params, `${type} has params`)
    assert.ok(isMemoryToolType(type))
  }
  assert.equal(isMemoryToolType('send_email'), false)
})

/* The owner's worked example: "check my email" with three known accounts and
 * no default is the clarification case; anything less ambiguous is not. */
const accounts = (names, { withDefault = false } = {}) => [
  ...names.map((label) => ({
    domain: 'email',
    name: `account.${label}`,
    value: `${label}@example.com`,
  })),
  ...(withDefault
    ? [{ domain: 'email', name: 'account.default', value: 'personal' }]
    : []),
]

test('ambiguous email request against several accounts asks, listing them', () => {
  const clarify = clarifyDomainRequest({
    domains: ['email'],
    request: 'check my email',
    facts: accounts(['personal', 'school', 'club']),
  })
  assert.ok(clarify, 'asks')
  assert.equal(clarify.domain, 'email')
  assert.deepEqual([...clarify.options].sort(), ['club', 'personal', 'school'])
  assert.match(clarify.question, /personal/)
  assert.match(clarify.question, /school/)
})

test('a default fact settles it — no question', () => {
  assert.equal(
    clarifyDomainRequest({
      domains: ['email'],
      request: 'check my email',
      facts: accounts(['personal', 'school'], { withDefault: true }),
    }),
    null,
  )
})

test('naming the account in the request settles it — no question', () => {
  assert.equal(
    clarifyDomainRequest({
      domains: ['email'],
      request: 'check my school email',
      facts: accounts(['personal', 'school', 'club']),
    }),
    null,
  )
})

test('one known account is ignorance, not ambiguity — no question', () => {
  assert.equal(
    clarifyDomainRequest({
      domains: ['email'],
      request: 'check my email',
      facts: accounts(['personal']),
    }),
    null,
  )
})

test('an unrelated request never trips the email rule', () => {
  assert.equal(
    clarifyDomainRequest({
      domains: ['email'],
      request: 'what is the battery at',
      facts: accounts(['personal', 'school']),
    }),
    null,
  )
})

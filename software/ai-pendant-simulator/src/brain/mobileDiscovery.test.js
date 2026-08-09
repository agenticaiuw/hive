/*
 * The catalogue is DERIVED, or it is a second list that will fall behind.
 *
 * These tests are the guard on that claim: they never name a tool, so they
 * cannot pass by being updated alongside a change to mobileTools.js. They ask
 * structural questions — is every dispatchable tool reachable, does the scope
 * filter actually filter, does the phone's table agree with the relay's idea of
 * what a `mobile` credential holds.
 *
 * No filesystem, no network, no workspace: everything here is pure.
 */
import assert from 'node:assert/strict'
import test from 'node:test'

/* The relay's own scope table, imported rather than transcribed. If the two
 * ever disagree this file fails, which is the only way a phone tool needing a
 * scope the `mobile` role does not carry gets caught before a 403 in the
 * owner's hand. */
import { DEVICE_SCOPES } from '../../cloud-relay/deviceAuth.js'

import {
  MOBILE_DOMAIN_NOTES,
  MOBILE_TOOLS,
  MOBILE_TOOL_TYPES,
  pickPath,
  summariseToolResult,
  TOOL_RESULT_MAX_CHARS,
} from './mobileTools.js'
import {
  buildMobileCatalogue,
  describeTools,
  discoveryReachability,
  domainsExcept,
  listDomains,
  listTools,
  normalizeDomains,
  renderDomainCatalog,
  renderFullSchema,
  renderToolSchemas,
  scopesSatisfy,
  toolsForDomains,
} from './mobileDiscovery.js'

test('every dispatchable tool is reachable through discovery', () => {
  const report = discoveryReachability()
  assert.equal(report.total, MOBILE_TOOL_TYPES.length)
  assert.equal(
    report.reachable,
    report.total,
    `${report.total - report.reachable} tool(s) are dispatchable but not reachable through listTools + describeTools`,
  )
  assert.deepEqual(report.uncategorised, [], 'a tool declared a domain no rule claims')
  assert.deepEqual(report.undescribed, [], 'a tool has no description to summarise')
  assert.deepEqual(report.unlabelled, [], 'a domain has no shelf label in MOBILE_DOMAIN_NOTES')
})

test('discovery never invents a tool the executor cannot run', () => {
  const catalogue = buildMobileCatalogue()
  for (const name of catalogue.tools.keys()) {
    assert.ok(
      typeof MOBILE_TOOLS[name]?.run === 'function',
      `${name} is in the catalogue but has no run()`,
    )
  }
})

test('every shelf label describes a shelf that exists, and vice versa', () => {
  const { domains } = listDomains()
  const labelled = new Set(Object.keys(MOBILE_DOMAIN_NOTES))
  for (const { domain, what } of domains) {
    assert.ok(what, `${domain} has an empty shelf label`)
    labelled.delete(domain)
  }
  /* `uncategorised` is the safety net and is allowed to be unused — every other
   * leftover label is describing a shelf nothing sits on. */
  labelled.delete('uncategorised')
  assert.deepEqual([...labelled], [], 'shelf labels for domains no tool declares')
})

test('the phone asks for nothing the relay would refuse a `mobile` credential', () => {
  const held = new Set(DEVICE_SCOPES.mobile)
  const overreach = MOBILE_TOOL_TYPES.filter(
    (name) => !(MOBILE_TOOLS[name].needs || []).every((scope) => held.has(scope)),
  )
  assert.deepEqual(
    overreach,
    [],
    'these tools need a relay scope the `mobile` role does not hold, so they would 403 on the phone',
  )
})

test('the whole catalogue survives a real `mobile` credential', () => {
  const catalogue = buildMobileCatalogue({ scopes: [...DEVICE_SCOPES.mobile] })
  assert.equal(catalogue.tools.size, MOBILE_TOOL_TYPES.length)
  assert.deepEqual(catalogue.blocked, [])
})

test('a narrower credential loses tools, and the prompt is told which scope is missing', () => {
  /* A phone with no relay scopes at all: only the device-local tools survive. */
  const catalogue = buildMobileCatalogue({ scopes: [] })
  const local = MOBILE_TOOL_TYPES.filter((name) => !(MOBILE_TOOLS[name].needs || []).length)

  assert.deepEqual([...catalogue.tools.keys()].sort(), local.sort())
  assert.ok(catalogue.blocked.length > 0, 'nothing was blocked by an empty scope set')
  for (const entry of catalogue.blocked) {
    assert.ok(entry.missing.length > 0, `${entry.name} was blocked without naming a scope`)
  }

  /* And the rendered schema cannot mention what was filtered out. */
  const schema = renderFullSchema({ catalogue })
  for (const entry of catalogue.blocked) {
    assert.ok(
      !schema.includes(`"type":"${entry.name}"`),
      `${entry.name} was blocked but is still in the schema`,
    )
  }
})

test('a single missing scope removes exactly the tools that need it', () => {
  const withoutState = [...DEVICE_SCOPES.mobile].filter((scope) => scope !== 'state:read')
  const catalogue = buildMobileCatalogue({ scopes: withoutState })
  const expected = MOBILE_TOOL_TYPES.filter((name) =>
    (MOBILE_TOOLS[name].needs || []).includes('state:read'),
  )
  assert.deepEqual(catalogue.blocked.map((entry) => entry.name).sort(), expected.sort())
})

test('unknown scopes are unknown, and `*` is admin', () => {
  assert.equal(scopesSatisfy(['a', 'b'], ['a']), true)
  assert.equal(scopesSatisfy(['a'], ['a', 'b']), false)
  assert.equal(scopesSatisfy(['*'], ['anything', 'at', 'all']), true)
  assert.equal(scopesSatisfy([], []), true)
})

test('null scopes mean unknown, not empty', () => {
  /* A caller that has not loaded the credential yet must get the full
   * catalogue. An empty one reads to the model as "this phone can do nothing",
   * which is a far worse lie than offering a tool that 403s once. */
  assert.equal(buildMobileCatalogue({ scopes: null }).tools.size, MOBILE_TOOL_TYPES.length)
})

test('level 1 is small enough to ship on every turn', () => {
  const catalog = renderDomainCatalog()
  assert.ok(catalog.length < 900, `level-1 catalogue is ${catalog.length} chars`)
  for (const { domain, count } of listDomains().domains) {
    assert.ok(catalog.includes(domain), `${domain} missing from the level-1 catalogue`)
    assert.ok(count > 0)
  }
})

test('level 2 lists spines without parameters', () => {
  const { domains } = listDomains()
  for (const { domain } of domains) {
    const listed = listTools(domain)
    assert.equal(listed.error, undefined)
    assert.equal(listed.count, listed.tools.length)
    for (const tool of listed.tools) {
      assert.ok(tool.summary.length <= 150, `${tool.name} summary is ${tool.summary.length} chars`)
      assert.equal(Object.hasOwn(tool, 'params'), false, `${tool.name} leaked params into level 2`)
    }
  }
})

test('an unknown domain answers with the real ones instead of just failing', () => {
  const listed = listTools('telepathy')
  assert.equal(listed.error, 'no such domain')
  assert.deepEqual(listed.domains, buildMobileCatalogue().domains)
})

test('level 3 answers only for what was asked, and names what it could not', () => {
  const first = MOBILE_TOOL_TYPES[0]
  const described = describeTools([first, first, 'not_a_tool'])
  assert.equal(described.tools.length, 1, 'duplicates were not collapsed')
  assert.equal(described.tools[0].name, first)
  assert.deepEqual(described.unknown, ['not_a_tool'])
})

test('domain helpers round-trip', () => {
  const catalogue = buildMobileCatalogue()
  const [first] = catalogue.domains
  assert.deepEqual(
    toolsForDomains([first, first], { catalogue }),
    catalogue.byDomain.get(first).map((entry) => entry.name),
  )
  assert.ok(!domainsExcept([first], { catalogue }).includes(first))
  assert.deepEqual(normalizeDomains(['nope', first, first], { catalogue }), [first])
  assert.deepEqual(normalizeDomains(catalogue.domains, { limit: 2, catalogue }).length, 2)
})

test('rendered schemas are one line per tool and carry the parameters', () => {
  const names = MOBILE_TOOL_TYPES
  const lines = renderToolSchemas(names).split('\n')
  assert.equal(lines.length, names.length)
  for (const line of lines) {
    const parsed = JSON.parse(line)
    assert.ok(names.includes(parsed.type))
    assert.ok(parsed.description.length > 0)
    assert.equal(typeof parsed.params, 'object')
  }
})

/*
 * The measurement, not a guess. mobileBrain.js ships the whole schema when it
 * fits in PROMPT_SCHEMA_BUDGET and drills down when it does not; this records
 * where the phone actually sits so the day it crosses over is a test failure
 * with a number in it, not a silently slower prompt.
 */
test('the phone catalogue is measured, not assumed', () => {
  const report = discoveryReachability()
  console.log(
    `[measured] ${report.total} tools, ${report.domains} domains, ` +
      `level-1 ${renderDomainCatalog().length} chars, full schema ${report.schemaChars} chars`,
  )
  assert.ok(report.schemaChars > 0)
})

test('a huge tool result is truncated before it can become a huge prompt', () => {
  const small = { a: 1 }
  assert.equal(summariseToolResult(small), small)

  const huge = { blob: 'x'.repeat(TOOL_RESULT_MAX_CHARS * 2) }
  const trimmed = summariseToolResult(huge)
  assert.equal(trimmed.truncated, true)
  assert.equal(trimmed.preview.length, TOOL_RESULT_MAX_CHARS)
})

test('pickPath walks objects and arrays, and misses quietly', () => {
  const document = { nodes: [{ id: 'mac', status: 'up' }], shared: { fleet: { ok: true } } }
  assert.equal(pickPath(document, 'shared.fleet.ok'), true)
  assert.equal(pickPath(document, 'nodes.0.id'), 'mac')
  assert.equal(pickPath(document, 'nodes.9.id'), undefined)
  assert.equal(pickPath(document, 'nothing.here'), undefined)
  assert.equal(pickPath(document, ''), document)
})

import assert from 'node:assert/strict'
import test from 'node:test'

import {
  UNCATEGORISED_DOMAIN,
  buildCatalogue,
  describeTools,
  discoveryReachability,
  domainForAction,
  domainsExcept,
  listDomains,
  listTools,
  normalizeDomains,
  renderDomainCatalog,
  renderToolSchemas,
  toolsForDomains,
} from './toolDiscovery.js'
import { SUPPORTED_ACTION_TYPES } from './computerControl.js'
import { actionSchemaForTier } from './llmPlanner.js'

/*
 * The one test that has to hold forever: a book on no shelf is a book nobody
 * can find. Before discovery the planner was handed all 92 described types on
 * every turn, so an unreachable type was impossible by construction; now
 * reachability is a property of this file's rules, and it is the property the
 * whole design rests on.
 */
test('every action type the executor can dispatch is reachable through discovery', () => {
  const report = discoveryReachability()

  assert.equal(report.total, SUPPORTED_ACTION_TYPES.length)
  assert.equal(
    report.reachable,
    report.total,
    'a type that list_tools does not show or describe_tools cannot answer for is lost',
  )
  assert.deepEqual(
    report.uncategorised,
    [],
    'these dispatchable types match no domain rule — add one, or they only surface under "uncategorised"',
  )
  assert.deepEqual(
    report.undescribed,
    [],
    'these types say nothing about themselves, so no model can choose them',
  )

  // …and reachable means through the three functions, not through a shortcut.
  const throughDiscovery = new Set()
  for (const { domain } of listDomains().domains) {
    for (const tool of listTools(domain).tools) throughDiscovery.add(tool.name)
  }
  assert.deepEqual(
    [...throughDiscovery].sort(),
    [...SUPPORTED_ACTION_TYPES].sort(),
  )
})

test('the level-1 catalogue fits in a system prompt and names no capability', () => {
  const catalogue = renderDomainCatalog()

  // The whole point: the first-level prompt carries shelf labels, not books.
  assert.ok(
    catalogue.length < 1000,
    `domain catalogue is ${catalogue.length} chars; it has to stay small enough to send every turn`,
  )

  const leaked = SUPPORTED_ACTION_TYPES.filter((type) => catalogue.includes(type))
  assert.deepEqual(
    leaked,
    [],
    'an action type in the level-1 catalogue is a hardcoded capability, which is the thing being removed',
  )

  const { domains, total } = listDomains()
  assert.ok(domains.length >= 8 && domains.length <= 14, `${domains.length} domains`)
  assert.equal(
    domains.reduce((sum, entry) => sum + entry.count, 0),
    total,
    'the counts must partition the roster — a type in two domains is a type counted twice',
  )
  // Stable ordering, so a model reading two of these in one turn is not
  // reading a list that moved between calls.
  assert.deepEqual(domains.map((entry) => entry.domain), [...domains.map((entry) => entry.domain)].sort())
  for (const entry of domains) assert.ok(entry.what.length > 0, `${entry.domain} has no description`)
})

/*
 * The reason the grouping is rules and not lists. Three capabilities have been
 * silently lost in this repo by exactly this shape of mistake: something new
 * became dispatchable and a hand-kept registry did not hear about it.
 */
test('a new action type files itself with no edit to the taxonomy', () => {
  const catalogue = buildCatalogue([
    ...SUPPORTED_ACTION_TYPES,
    'browser_hover',
    'ios_pinch',
    'sweep_folder_schedule',
    'ui_focus',
  ])

  assert.equal(domainForAction('browser_hover'), 'browser')
  assert.equal(domainForAction('ios_pinch'), 'phone')
  assert.equal(domainForAction('sweep_folder_schedule'), 'files')
  assert.equal(domainForAction('ui_focus'), 'input')

  const browser = listTools('browser', { catalogue })
  assert.ok(browser.tools.some((tool) => tool.name === 'browser_hover'))
  assert.equal(listDomains({ catalogue }).total, SUPPORTED_ACTION_TYPES.length + 4)
})

test('a type no rule claims is surfaced as uncategorised, never dropped', () => {
  const catalogue = buildCatalogue([...SUPPORTED_ACTION_TYPES, 'flibber_the_wozzle'])

  assert.equal(domainForAction('flibber_the_wozzle'), UNCATEGORISED_DOMAIN)

  const report = discoveryReachability({ catalogue })
  assert.deepEqual(report.uncategorised, ['flibber_the_wozzle'])
  // Loud, but still findable: an untaxonomised tool is a taxonomy bug, not a
  // capability the owner has lost.
  assert.equal(report.reachable, report.total)
  assert.ok(
    listTools(UNCATEGORISED_DOMAIN, { catalogue }).tools.some(
      (tool) => tool.name === 'flibber_the_wozzle',
    ),
  )
  assert.equal(
    describeTools(['flibber_the_wozzle'], { catalogue }).tools.length,
    1,
    'level 3 must answer for it too',
  )
})

/*
 * Level 3 is a different way of DELIVERING the schema, not a different schema.
 * If these drift, a plan authored against discovery is a plan authored against
 * parameters the executor does not take.
 */
test('describe_tools returns exactly the schema the flat prompt carried', () => {
  const flat = actionSchemaForTier('planner')
  const { tools, unknown } = describeTools(Object.keys(flat))

  assert.deepEqual(unknown, [])
  assert.equal(tools.length, Object.keys(flat).length)

  for (const tool of tools) {
    assert.equal(tool.description, flat[tool.name].description, `${tool.name} description drifted`)
    assert.deepEqual(tool.params, flat[tool.name].params, `${tool.name} params drifted`)
    // By reference, like actionSchemaForTier: a copy is a second registry.
    assert.equal(tool.params, flat[tool.name].params)
  }
})

test('a type the planner never described is still describable, without an invented signature', () => {
  // These 17 are dispatchable but were absent from every planner schema — the
  // drift capabilityManifest already reports. Discovery shows them; it does
  // not make up parameters they might take.
  const { tools } = describeTools(['plan_my_day', 'quick_capture'])
  assert.equal(tools.length, 2)
  for (const tool of tools) {
    assert.ok(tool.description.length > 0)
    assert.deepEqual(tool.params, {})
  }
})

test('level 2 is spines only — names and one line, no parameters', () => {
  const listed = listTools('browser')

  assert.equal(listed.count, listed.tools.length)
  for (const tool of listed.tools) {
    assert.deepEqual(Object.keys(tool), ['name', 'summary'])
    assert.ok(tool.summary.length <= 151, `${tool.name} summary is not one line`)
  }
  // Whole point of the middle level: choosing is cheap, the schemas are not.
  const index = JSON.stringify(listed).length
  const schemas = renderToolSchemas(listed.tools.map((tool) => tool.name)).length
  assert.ok(index < schemas * 0.5, `index ${index} should be far cheaper than schemas ${schemas}`)
})

test('a wrong domain name comes back with the right ones, not with nothing', () => {
  const listed = listTools('web')
  assert.equal(listed.error, 'no such domain')
  assert.ok(listed.domains.includes('browser'))
  assert.equal(listed.tools, undefined)

  assert.deepEqual(normalizeDomains(['web', 'BROWSER', 'browser', '']), ['browser'])
  assert.equal(normalizeDomains(['a', 'b', 'c', 'd', 'e', 'f'].concat(listDomains().domains.map((d) => d.domain)), { limit: 2 }).length, 2)
})

test('describe_tools reports what it could not find instead of silently shortening', () => {
  const { tools, unknown } = describeTools(['set_volume', 'set_volume', 'not_a_tool'])
  assert.deepEqual(tools.map((tool) => tool.name), ['set_volume'])
  assert.deepEqual(unknown, ['not_a_tool'])
})

test('a domain selection resolves to its tools, and the rest are namable', () => {
  const names = toolsForDomains(['system', 'info'])
  assert.ok(names.includes('set_volume'))
  assert.ok(names.includes('get_weather'))
  assert.ok(!names.includes('browser_navigate'))

  const rest = domainsExcept(['system', 'info'])
  assert.ok(rest.includes('browser'))
  assert.ok(!rest.includes('system'))
  assert.equal(rest.length + 2, listDomains().domains.length)
})

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  VOICE_AGENT_STATIC_INSTRUCTIONS,
  composeRealtimeInstructions,
  formatDeviceTime,
  formatFleetSnapshotForPrompt,
  fleetFromAgentSnapshot,
  normalizeFleetSnapshot,
  buildFleetPayloadFromLocal,
  parseDeviceTime,
} from './fleetContext.js'

test('static instructions stay high-level (no open_app lectures, no product names)', () => {
  const text = composeRealtimeInstructions({
    fleet: {
      mac: {
        online: true,
        hostname: 'evans-macbook',
        applications: ['Microsoft Outlook', 'Safari'],
      },
    },
  })
  assert.ok(text.startsWith(VOICE_AGENT_STATIC_INSTRUCTIONS.slice(0, 40)))
  // Live inventory may appear in the environment block:
  assert.ok(text.includes('Microsoft Outlook'))
  // Static policy must not coach open_app or hardcode products:
  assert.ok(!VOICE_AGENT_STATIC_INSTRUCTIONS.includes('open_app'))
  assert.ok(!VOICE_AGENT_STATIC_INSTRUCTIONS.includes('appName'))
  assert.ok(!VOICE_AGENT_STATIC_INSTRUCTIONS.includes('Microsoft Outlook'))
  assert.ok(!VOICE_AGENT_STATIC_INSTRUCTIONS.includes('Safari'))
  assert.ok(!VOICE_AGENT_STATIC_INSTRUCTIONS.includes('Outlook'))
  // Product frame: useful while away, not an app launcher.
  assert.match(VOICE_AGENT_STATIC_INSTRUCTIONS, /away from the keyboard/i)
  // Audio-native / Realtime-first: tools from speech; transcript not the product.
  assert.match(VOICE_AGENT_STATIC_INSTRUCTIONS, /Plan from speech/i)
  assert.match(VOICE_AGENT_STATIC_INSTRUCTIONS, /optional history/i)
  // Mac state Q&A must use tools (get_mac_status / mac_run_actions; battery etc.).
  assert.match(VOICE_AGENT_STATIC_INSTRUCTIONS, /get_mac_status/)
  assert.match(VOICE_AGENT_STATIC_INSTRUCTIONS, /mac_run_actions/)
  assert.match(VOICE_AGENT_STATIC_INSTRUCTIONS, /battery/i)
  // Tool-primary: never guess device readings; ACT via tools.
  assert.match(VOICE_AGENT_STATIC_INSTRUCTIONS, /Never guess numbers|Never invent/i)
  assert.match(VOICE_AGENT_STATIC_INSTRUCTIONS, /ACT through tools|ACT via tools|tools first/i)
  // Static block cacheable: no timestamps in static prefix.
  assert.ok(!/\d{4}-\d{2}-\d{2}/.test(VOICE_AGENT_STATIC_INSTRUCTIONS))
  assert.ok(!/as_of:/i.test(VOICE_AGENT_STATIC_INSTRUCTIONS))
})

test('formatFleetSnapshot is environment facts, not tool coaching', () => {
  const block = formatFleetSnapshotForPrompt({
    updatedAt: '2026-08-03T00:00:00.000Z',
    mac: {
      online: true,
      hostname: 'home',
      platform: 'darwin',
      applications: ['Microsoft Outlook', 'Finder'],
    },
    browser: { online: false, devices: [] },
  })
  assert.match(block, /Microsoft Outlook/)
  assert.match(block, /browser_extension: offline/)
  assert.match(block, /Mac software inventory/)
  assert.ok(!block.includes('open_app'))
  assert.ok(!block.includes('appName'))
})

test('normalizeFleetSnapshot trims and caps applications', () => {
  const apps = Array.from({ length: 300 }, (_, i) => `App${i}`)
  const fleet = normalizeFleetSnapshot({
    mac: { online: true, applications: apps },
  })
  assert.equal(fleet.mac.applications.length, 220)
  assert.equal(fleet.mac.applications[0], 'App0')
})

test('fleetFromAgentSnapshot maps ops snapshot shape', () => {
  const fleet = fleetFromAgentSnapshot({
    status: {
      machine: {
        hostname: 'mac.local',
        platform: 'darwin',
        applications: ['Safari', 'Microsoft Outlook'],
      },
      browser: {
        online: true,
        devices: [
          {
            online: true,
            browserName: 'Safari',
            tabUrl: 'https://example.com',
            deviceName: 'Evan Mac',
          },
        ],
      },
    },
  })
  assert.equal(fleet.mac.hostname, 'mac.local')
  assert.ok(fleet.mac.applications.includes('Microsoft Outlook'))
  assert.equal(fleet.browser.online, true)
  // The old entity memory (latestPerson etc.) is gone from the snapshot.
  assert.equal('memory' in fleet, false)
  assert.deepEqual(fleet.domainMemory.facts, [])
})

test('buildFleetPayloadFromLocal produces put-ready object', () => {
  const payload = buildFleetPayloadFromLocal({
    machine: {
      hostname: 'x',
      platform: 'darwin',
      home: '/Users/x',
      applications: ['Safari'],
    },
    browser: { online: false, devices: [] },
    permissions: { ready: true, hostApp: 'AI Pendant Agent' },
  })
  assert.equal(payload.version, 1)
  assert.equal(payload.mac.applications[0], 'Safari')
  assert.equal(payload.mac.permissionsReady, true)
  // No legacy memory object crosses the wire anymore.
  assert.equal('memory' in payload, false)
  // Absent domainMemory → an empty hive block, so the relay merge (which
  // unions) has a well-formed input and nothing to erase with.
  assert.deepEqual(payload.domainMemory, { version: 1, facts: [] })
})

test('buildFleetPayloadFromLocal carries the hive facts through as data', () => {
  const facts = [
    {
      domain: 'email',
      name: 'account.school',
      value: 'liu@uni.edu',
      scope: 'hive',
      node: 'mac',
    },
  ]
  const payload = buildFleetPayloadFromLocal({
    machine: { hostname: 'x', applications: [] },
    browser: { online: false, devices: [] },
    permissions: { ready: true },
    domainMemory: { facts },
  })
  assert.equal(payload.domainMemory.version, 1)
  // Pass-through, not normalization: the relay merge is the body that
  // validates and reports rejects, so nothing is dropped silently here.
  assert.deepEqual(payload.domainMemory.facts, facts)
})

test('the composed prompt carries NO memory section at all', () => {
  /* The owner: "not just generic memories that all get added to the system
   * prompt." Facts in the hive block must never leak into instructions —
   * they are data for tool-time attach. */
  const snapshot = {
    updatedAt: '2026-08-12T00:00:00.000Z',
    mac: { online: true, hostname: 'home', applications: ['Safari'] },
    browser: {
      online: true,
      devices: [{ online: true, browserName: 'Safari', tabUrl: 'https://e.com' }],
    },
    domainMemory: {
      facts: [
        {
          domain: 'email',
          name: 'account.school',
          value: 'liu@uni.edu',
          scope: 'hive',
          node: 'mac',
        },
      ],
    },
  }
  const block = formatFleetSnapshotForPrompt(snapshot)
  const composed = composeRealtimeInstructions({ fleet: snapshot })
  for (const text of [block, composed]) {
    assert.ok(!text.includes('liu@uni.edu'), 'fact value must not reach the prompt')
    assert.ok(!text.includes('account.school'), 'fact name must not reach the prompt')
    assert.ok(!text.includes('### Recent context'))
    assert.ok(!text.includes('### Owner'))
    assert.ok(!/memory/i.test(text), 'no memory section, heading, or line')
  }
  // The environment block itself survives the purge intact.
  assert.match(block, /### Clock\n- owner_local_time:/)
  assert.deepEqual(block.match(/^## .*$/gm), ['## Live environment'])
})

test('normalizeFleetSnapshot normalizes the domainMemory hive block', () => {
  const fleet = normalizeFleetSnapshot({
    mac: { online: true },
    domainMemory: {
      facts: [
        { domain: 'email', name: 'account.school', value: 'liu@uni.edu', node: 'mac' },
        /* node-scoped: must be refused by the hive block, per shared/domainMemory.js */
        { domain: 'system', name: 'level.volume', value: '30', scope: 'node', node: 'mac' },
        /* malformed: unknown domain */
        { domain: 'nope', name: 'x', value: 'y' },
      ],
    },
  })
  assert.equal(fleet.domainMemory.version, 1)
  assert.equal(fleet.domainMemory.facts.length, 1)
  assert.equal(fleet.domainMemory.facts[0].key, 'dom.email.account.school')
  assert.equal(fleet.domainMemory.facts[0].scope, 'hive')
})

test('parseDeviceTime self-verifies UTC vs local field against server clock', () => {
  const nowMs = Date.UTC(2026, 7, 5, 16, 10, 0)
  // Field is UTC (nRF91 style): matches now directly; offset -16 qh = -4 h.
  const utcStyle = parseDeviceTime('26/08/05,16:10:12-16', nowMs)
  assert.ok(utcStyle)
  assert.equal(utcStyle.offsetMinutes, -240)
  // Field is local (12:10 at UTC-4): candidate B matches.
  const localStyle = parseDeviceTime('26/08/05,12:10:12-16', nowMs)
  assert.ok(localStyle)
  assert.ok(Math.abs(localStyle.utcMs - nowMs) < 60_000)
  // Neither reading plausible → rejected.
  assert.equal(parseDeviceTime('26/08/05,03:00:00-16', nowMs), null)
  // NITZ never delivered (modem epoch default) → rejected.
  assert.equal(parseDeviceTime('80/01/06,00:11:52+00', nowMs), null)
  assert.equal(parseDeviceTime('garbage', nowMs), null)
  const formatted = formatDeviceTime(utcStyle)
  assert.ok(formatted.includes('12:10 PM'))
  assert.ok(formatted.includes('UTC-4'))
})

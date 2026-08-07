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
      memory: { latestPerson: { name: 'Nico' } },
    },
  })
  assert.equal(fleet.mac.hostname, 'mac.local')
  assert.ok(fleet.mac.applications.includes('Microsoft Outlook'))
  assert.equal(fleet.browser.online, true)
  assert.equal(fleet.memory.latestPerson, 'Nico')
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
  // No projection sent → legacy entity fields carry memory.
  assert.equal(payload.memory.workingProject, null)
  assert.ok(!('text' in payload.memory))
})

test('a projection replaces the entity fields on the wire, not joins them', () => {
  const workingProject = {
    name: 'AI Pendant Simulator',
    openThreads: Array.from({ length: 7 }, (_, i) => ({
      id: `thread_${i}`,
      lastNote: 'x'.repeat(200),
    })),
  }
  const withProjection = buildFleetPayloadFromLocal({
    machine: { hostname: 'x', applications: [] },
    workingProject,
    memory: { latestFile: { name: 'Untitled' } },
    memoryText: '## Owner\n- editor: VS Code',
  })
  assert.deepEqual(withProjection.memory, { text: '## Owner\n- editor: VS Code' })
  // The point of the swap: the fat graph objects stop crossing the wire.
  const legacy = buildFleetPayloadFromLocal({
    machine: { hostname: 'x', applications: [] },
    workingProject,
    memory: { latestFile: { name: 'Untitled' } },
  })
  assert.ok(
    JSON.stringify(withProjection.memory).length <
      JSON.stringify(legacy.memory).length,
  )
})

test('formatFleetSnapshotForPrompt emits the projection above the volatile tail', () => {
  const block = formatFleetSnapshotForPrompt({
    updatedAt: '2026-08-07T00:00:00.000Z',
    mac: { online: true, hostname: 'home', applications: ['Safari'] },
    browser: {
      online: true,
      devices: [{ online: true, browserName: 'Safari', tabUrl: 'https://e.com' }],
    },
    memory: { text: '## Owner\n- editor: VS Code\n## Now\n- ship the audio path' },
  })
  // Verbatim content, demoted one heading level so the environment sections
  // below it are not orphaned under the projection's own headings.
  assert.match(block, /### Owner\n- editor: VS Code/)
  assert.match(block, /### Now\n- ship the audio path/)
  // "## Live environment" is the block's own top-level heading and must stay
  // the only one, so the projection's headings sit under it.
  assert.ok(!/^## Owner$/m.test(block))
  assert.deepEqual(block.match(/^## .*$/gm), ['## Live environment'])
  // Cacheability: memory before the active tab and the clock, not after.
  assert.ok(block.indexOf('### Owner') < block.indexOf('### Browser now'))
  assert.ok(block.indexOf('### Owner') < block.indexOf('### Clock'))
  // The clock keeps its own name so it cannot be confused with the
  // projection's "Now" (open tasks).
  assert.match(block, /### Clock\n- owner_local_time:/)
})

test('the legacy entity line only appears when there is no projection', () => {
  const base = {
    mac: { online: true, hostname: 'home', applications: [] },
    memory: { workingProject: { name: 'Pendant' }, latestFile: { name: 'note' } },
  }
  const legacy = formatFleetSnapshotForPrompt(base)
  assert.match(legacy, /### Recent context\nproject=Pendant · file=note/)

  const projected = formatFleetSnapshotForPrompt({
    ...base,
    memory: { ...base.memory, text: '## Owner\n- editor: VS Code' },
  })
  // Both would be memory; emitting both would pay twice for one idea.
  assert.ok(!projected.includes('### Recent context'))
  assert.match(projected, /### Owner/)
})

test('an oversized projection cannot run away with the prompt', () => {
  const fleet = normalizeFleetSnapshot({
    mac: { online: true },
    memory: { text: 'x'.repeat(9000) },
  })
  assert.equal(fleet.memory.text.length, 2000)
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

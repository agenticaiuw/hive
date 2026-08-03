import assert from 'node:assert/strict'
import test from 'node:test'

const {
  extractPcmFromWavOrPcm,
  resamplePcmS16le,
  StreamingPcmResampler,
  REALTIME_TOOLS,
  buildPlanResult,
  historyLabelFromState,
  mapGetMacStatusToActions,
  looksLikeDeviceStateAnswer,
} = await import('./openaiRealtimeVoice.js')

test('REALTIME_TOOLS expose status + control + search + browser + delegate', () => {
  const names = REALTIME_TOOLS.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'browser_run_actions',
    'get_mac_status',
    'mac_delegate',
    'mac_run_actions',
    'web_search',
  ])
})

test('Realtime action tools require actions/goal, not transcript', () => {
  const byName = Object.fromEntries(REALTIME_TOOLS.map((t) => [t.name, t]))
  assert.deepEqual(byName.mac_run_actions.parameters.required, ['actions'])
  assert.deepEqual(byName.browser_run_actions.parameters.required, ['actions'])
  assert.deepEqual(byName.mac_delegate.parameters.required, ['goal'])
  // get_mac_status has no required params (fields optional)
  assert.deepEqual(byName.get_mac_status.parameters.required || [], [])
  for (const name of [
    'get_mac_status',
    'mac_run_actions',
    'browser_run_actions',
    'mac_delegate',
  ]) {
    const required = byName[name].parameters.required || []
    assert.ok(
      !required.includes('transcript'),
      `${name} must not require transcript`,
    )
    assert.ok(
      byName[name].parameters.properties.transcript,
      `${name} keeps optional transcript for history`,
    )
    assert.ok(
      byName[name].parameters.properties.spoken_reply || name === 'mac_delegate',
      `${name} prefers spoken_reply`,
    )
  }
  assert.ok(
    /PROACTIVE/i.test(byName.get_mac_status.description),
    'get_mac_status should be marked PROACTIVE',
  )
  assert.ok(
    /PROACTIVE/i.test(byName.mac_run_actions.description),
    'mac_run_actions should be marked PROACTIVE',
  )
  assert.ok(
    /Do NOT use when/i.test(byName.get_mac_status.description),
    'get_mac_status should include Do NOT use when',
  )
  assert.ok(
    /battery|wifi|volume|focused/i.test(byName.get_mac_status.description),
    'get_mac_status should mention device status fields',
  )
})

test('get_mac_status fields enum covers battery wifi volume focused_app all', () => {
  const byName = Object.fromEntries(REALTIME_TOOLS.map((t) => [t.name, t]))
  const fields = byName.get_mac_status.parameters.properties.fields
  assert.equal(fields.type, 'array')
  assert.deepEqual(fields.items.enum.sort(), [
    'all',
    'battery',
    'focused_app',
    'volume',
    'wifi',
  ])
})

test('mapGetMacStatusToActions expands battery to pmset run_shell', () => {
  const actions = mapGetMacStatusToActions(['battery'])
  assert.equal(actions.length, 1)
  assert.equal(actions[0].type, 'run_shell')
  assert.equal(actions[0].label, 'Battery')
  assert.equal(actions[0].params.command, 'pmset -g batt')
})

test('mapGetMacStatusToActions expands all / empty to full snapshot', () => {
  const all = mapGetMacStatusToActions(['all'])
  const empty = mapGetMacStatusToActions([])
  assert.equal(all.length, 4)
  assert.equal(empty.length, 4)
  const types = all.map((a) => a.type)
  assert.ok(types.includes('run_shell'))
  assert.ok(types.includes('get_volume'))
  assert.ok(all.some((a) => a.label === 'Battery'))
  assert.ok(all.some((a) => a.label === 'Wi‑Fi' || a.label === 'Wi-Fi'))
  assert.ok(all.some((a) => a.label === 'Volume'))
  assert.ok(all.some((a) => a.label === 'Focused app'))
})

test('mapGetMacStatusToActions supports multi-field subset', () => {
  const actions = mapGetMacStatusToActions(['wifi', 'volume'])
  assert.equal(actions.length, 2)
  assert.equal(actions[0].label, 'Wi‑Fi')
  assert.equal(actions[1].type, 'get_volume')
})

test('buildPlanResult is always audio-native with actions+response product', () => {
  const plan = buildPlanResult(
    {
      transcript: '',
      response: 'Checking battery.',
      actions: [
        {
          type: 'run_shell',
          label: 'Check battery',
          params: { command: 'pmset -g batt' },
        },
      ],
      toolsUsed: ['get_mac_status'],
      delegate: false,
      status: 'ready',
      midPressStreamed: true,
      textParts: [],
    },
    Date.now() - 50,
    'en',
  )
  assert.equal(plan.planner, 'audio-native')
  assert.equal(plan.source, 'audio-native-realtime')
  assert.equal(plan.status, 'ready')
  assert.equal(plan.response, 'Checking battery.')
  assert.equal(plan.actions.length, 1)
  assert.equal(plan.actions[0].type, 'run_shell')
  assert.equal(plan.requireLocalPlanner, false)
  assert.equal(plan.needsLocalFallback, false)
  assert.equal(plan.midPressStreamed, true)
  assert.deepEqual(plan.toolsUsed, ['get_mac_status'])
  // History label can come from action label when transcript is empty.
  assert.equal(plan.text, 'Check battery')
})

test('buildPlanResult works without transcript (optional history only)', () => {
  const plan = buildPlanResult(
    {
      transcript: '',
      response: undefined,
      actions: [{ type: 'create_reminder', params: { title: 'Call mom' } }],
      toolsUsed: ['mac_run_actions'],
      delegate: false,
      status: 'ready',
      textParts: [],
    },
    Date.now(),
    null,
  )
  assert.equal(plan.planner, 'audio-native')
  assert.ok(plan.actions.length === 1)
  assert.ok(plan.text) // non-empty history label
  assert.notEqual(plan.text, '')
  assert.equal(plan.needsLocalFallback, false)
})

test('buildPlanResult pure chitchat is instant with empty actions', () => {
  const plan = buildPlanResult(
    {
      transcript: '',
      response: 'Hello! How can I help?',
      actions: [],
      toolsUsed: [],
      delegate: false,
      status: 'instant',
      textParts: ['Hello! How can I help?'],
    },
    Date.now(),
    'en',
  )
  assert.equal(plan.planner, 'audio-native')
  assert.equal(plan.status, 'instant')
  assert.equal(plan.actions.length, 0)
  assert.equal(plan.needsLocalFallback, false)
  assert.equal(plan.requireLocalPlanner, false)
  assert.equal(plan.response, 'Hello! How can I help?')
})

test('buildPlanResult delegate variant when mac_delegate with no actions', () => {
  const plan = buildPlanResult(
    {
      transcript: '',
      response: 'Working on that on your Mac.',
      actions: [],
      toolsUsed: ['mac_delegate'],
      delegate: true,
      status: 'ready',
      textParts: [],
    },
    Date.now(),
    null,
  )
  assert.equal(plan.planner, 'audio-native-delegate')
  assert.equal(plan.requireLocalPlanner, true)
  assert.equal(plan.needsLocalFallback, false)
  assert.deepEqual(plan.toolsUsed, ['mac_delegate'])
})

test('looksLikeDeviceStateAnswer flags battery-like pure text', () => {
  assert.equal(looksLikeDeviceStateAnswer('Your battery is at 80 percent.'), true)
  assert.equal(looksLikeDeviceStateAnswer('WiFi is connected.'), true)
  assert.equal(looksLikeDeviceStateAnswer('Hello there.'), false)
})

test('historyLabelFromState prefers transcript then action then spoken', () => {
  assert.equal(
    historyLabelFromState({ transcript: 'open mail', actions: [] }),
    'open mail',
  )
  assert.equal(
    historyLabelFromState({
      transcript: '',
      actions: [{ type: 'run_shell', label: 'Battery' }],
    }),
    'Battery',
  )
  assert.equal(
    historyLabelFromState({
      transcript: '',
      actions: [],
      response: 'Hello there friend',
    }),
    'Hello there friend',
  )
})

test('extractPcmFromWavOrPcm strips RIFF header', () => {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + 4, 4)
  header.write('WAVE', 8)
  header.write('fmt ', 12)
  header.writeUInt32LE(16, 16)
  header.writeUInt16LE(1, 20)
  header.writeUInt16LE(1, 22)
  header.writeUInt32LE(16000, 24)
  header.writeUInt32LE(32000, 28)
  header.writeUInt16LE(2, 32)
  header.writeUInt16LE(16, 34)
  header.write('data', 36)
  header.writeUInt32LE(4, 40)
  const pcm = Buffer.from([0x00, 0x01, 0x02, 0x03])
  const wav = Buffer.concat([header, pcm])
  const extracted = extractPcmFromWavOrPcm(wav, 'wav')
  assert.equal(extracted.sampleRate, 16000)
  assert.deepEqual(extracted.pcm, pcm)
})

test('resamplePcmS16le identity when rates match', () => {
  const pcm = Buffer.from([0, 0, 1, 0, 2, 0, 3, 0])
  const out = resamplePcmS16le(pcm, 24000, 24000)
  assert.deepEqual(out, pcm)
})

test('resamplePcmS16le changes length when rates differ', () => {
  const samples = new Int16Array(1000)
  for (let i = 0; i < samples.length; i++) samples[i] = i
  const pcm = Buffer.from(samples.buffer)
  const out = resamplePcmS16le(pcm, 16000, 24000)
  assert.ok(out.length > pcm.length)
  assert.equal(out.length % 2, 0)
})

test('StreamingPcmResampler accepts mid-press byte chunks', () => {
  const stream = new StreamingPcmResampler(16000, 24000)
  const samples = new Int16Array(800)
  for (let i = 0; i < samples.length; i++) samples[i] = (i % 200) - 100
  const pcm = Buffer.from(samples.buffer)
  const a = stream.push(pcm.subarray(0, 100))
  const b = stream.push(pcm.subarray(100))
  const c = stream.flush()
  const total = a.length + b.length + c.length
  assert.ok(total > 0)
  assert.equal(total % 2, 0)
})

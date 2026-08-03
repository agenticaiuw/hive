import assert from 'node:assert/strict'
import test from 'node:test'

const {
  extractPcmFromWavOrPcm,
  resamplePcmS16le,
  StreamingPcmResampler,
  REALTIME_TOOLS,
  buildPlanResult,
  historyLabelFromState,
} = await import('./openaiRealtimeVoice.js')

test('REALTIME_TOOLS expose search + Mac + browser tools', () => {
  const names = REALTIME_TOOLS.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'browser_run_actions',
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
  for (const name of [
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
    /battery|system|shell/i.test(byName.mac_run_actions.description),
    'mac_run_actions should mention system/shell queries',
  )
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
      toolsUsed: ['mac_run_actions'],
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
  assert.equal(plan.midPressStreamed, true)
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

import assert from 'node:assert/strict'
import test from 'node:test'

const {
  extractPcmFromWavOrPcm,
  resamplePcmS16le,
  StreamingPcmResampler,
  REALTIME_TOOLS,
  buildPlanResult,
  createStreamingRealtimeSession,
  historyLabelFromState,
  mapGetMacStatusToActions,
  looksLikeDeviceStateAnswer,
  planUtteranceWithRealtime,
} = await import('./openaiRealtimeVoice.js')
const { MEMORY_DOMAINS, MEMORY_TOOL_SPECS } = await import(
  '../shared/domains/index.js'
)

test('REALTIME_TOOLS expose status + control + search + browser + delegate + page read + job recall + memory', () => {
  const names = REALTIME_TOOLS.map((t) => t.name).sort()
  assert.deepEqual(names, [
    'browser_run_actions',
    'get_mac_status',
    'mac_delegate',
    'mac_run_actions',
    'memory_lookup',
    'memory_save',
    'read_web_page',
    'relay_job_status',
    'set_timer',
    'web_search',
  ])
})

/*
 * The timer's schema carries the one routing decision that actually goes wrong
 * in the field: "remind me at four" is a Mac reminder and "wake me in ten
 * minutes" is a pendant timer, and a model that confuses them either sets a
 * countdown the owner never hears or files a reminder for a pot on the stove.
 */
test('set_timer names the timer/reminder boundary and the store it writes to', () => {
  const tool = REALTIME_TOOLS.find((entry) => entry.name === 'set_timer')
  assert.deepEqual(tool.parameters.required, ['action'])
  assert.deepEqual(tool.parameters.properties.action.enum, ['start', 'cancel', 'status'])
  assert.match(tool.description, /PROACTIVE/)
  assert.match(tool.description, /Do NOT use when/i)
  assert.match(tool.description, /create_reminder/)
  /* And it must state the honest delivery contract, so the model never
   * promises a chime the relay cannot make while the socket is shut. */
  assert.match(tool.description, /next button press/i)
})

test('the memory tools are built from the shared spec, with domain pinned to the registry', () => {
  const byName = Object.fromEntries(REALTIME_TOOLS.map((t) => [t.name, t]))
  const lookup = byName.memory_lookup
  const save = byName.memory_save

  for (const tool of [lookup, save]) {
    assert.equal(tool.type, 'function')
    /* The model must not be able to invent a domain. */
    assert.deepEqual(tool.parameters.properties.domain.enum, [...MEMORY_DOMAINS])
    /* Same spoken-confirmation channel as the sibling tools. */
    assert.ok(tool.parameters.properties.spoken_reply)
  }
  /* Descriptions come from MEMORY_TOOL_SPECS verbatim — one source of truth
   * for all three brains. */
  assert.equal(lookup.description, MEMORY_TOOL_SPECS.memory_lookup.description)
  assert.equal(save.description, MEMORY_TOOL_SPECS.memory_save.description)
  /* Required derives from the spec's own "optional" markings. */
  assert.deepEqual(lookup.parameters.required, ['domain'])
  assert.deepEqual(save.parameters.required, ['domain', 'name', 'value'])
  assert.deepEqual(save.parameters.properties.scope.enum, ['hive', 'node'])
})

test('relay_job_status takes a spoken reference and requires nothing', () => {
  const byName = Object.fromEntries(REALTIME_TOOLS.map((t) => [t.name, t]))
  const tool = byName.relay_job_status
  assert.deepEqual(tool.parameters.required || [], [])
  assert.ok(tool.parameters.properties.reference)
  assert.ok(tool.parameters.properties.job_id)
  assert.match(tool.description, /PROACTIVE/)
  assert.match(tool.description, /Do NOT use when/i)
  /* The routing risk this schema has to carry: get_mac_status reads the
   * device now, relay_job_status reads what already happened. */
  assert.match(tool.description, /get_mac_status/)
  /* No approval gate, and no room to upgrade a failure into a success. */
  assert.match(tool.description, /do not report a task as done/i)
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

/*
 * A valid RIFF/WAV header with a zero-length (or absent) data chunk decodes
 * to zero PCM samples — a container-size check upstream sees a real
 * multi-byte body and lets it through; only the DECODED length reveals
 * there is no audio at all. This used to throw a generic Error caught
 * indistinguishably from a real OpenAI outage.
 */
function emptyWavHeader({ dataBytes = 0 } = {}) {
  const header = Buffer.alloc(44)
  header.write('RIFF', 0)
  header.writeUInt32LE(36 + dataBytes, 4)
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
  header.writeUInt32LE(dataBytes, 40)
  return header
}

test('planUtteranceWithRealtime never throws on a zero-length WAV data chunk', async () => {
  const result = await planUtteranceWithRealtime({
    audioBuffer: emptyWavHeader(),
    format: 'wav',
  })
  assert.equal(result.text, '')
  assert.equal(result.transcript, undefined)
  assert.equal(result.model, null)
  // The distinguishing fact, recorded rather than reconstructed later:
  // there was literally no decoded audio, not merely an unrecognised
  // utterance a real Realtime session ran and heard nothing from.
  assert.equal(result.source, 'no_audio')
})

test('a WAV that is nothing but the bare 44-byte header is also empty, not a failure', async () => {
  // No data chunk marker at all — extractPcmFromWavOrPcm falls back to
  // dataOffset=44, which is the whole buffer: zero decoded bytes.
  const bareHeader = Buffer.alloc(44)
  bareHeader.write('RIFF', 0)
  bareHeader.write('WAVE', 8)
  const result = await planUtteranceWithRealtime({
    audioBuffer: bareHeader,
    format: 'wav',
  })
  assert.equal(result.text, '')
  assert.equal(result.source, 'no_audio')
})

test('the no-audio result carries nothing server.js\'s plannerHintFromPlan would read as plan-worthy', async () => {
  /*
   * server.js's plannerHintFromPlan(plan) hands the Mac a hint whenever
   * plan.planner/source is audio-native, plan.actions is non-empty,
   * plan.status or plan.response is truthy, or plan.requireLocalPlanner is
   * set. (Not imported here — server.js binds a real port at module load,
   * which a test file must never trigger.) A no_audio result must fail
   * every one of those checks, or an empty press would dispatch a phantom
   * Mac job.
   */
  const result = await planUtteranceWithRealtime({
    audioBuffer: emptyWavHeader(),
    format: 'wav',
  })
  assert.notEqual(result.source, 'audio-native-realtime')
  assert.notEqual(result.source, 'audio-native')
  assert.ok(!result.planner)
  assert.ok(!Array.isArray(result.actions) || result.actions.length === 0)
  assert.ok(!result.status)
  assert.ok(!result.response)
  assert.ok(!result.requireLocalPlanner)
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

/*
 * runWebSearch used to report a refusal as ok:true. Same class of bug as
 * voiceRunForCapture in jobs.js hardcoding 'done' (see jobsVoiceRun.test.js):
 * the call completed, so success was assumed, and a scheduled routine turned
 * the apology into a spoken morning briefing.
 *
 * The payload shapes below are captured verbatim from the live Responses API
 * on 2026-08-07. The refusal reproduced 7 times in 12 on gpt-4o-mini.
 */
const { webSearchOutcome, runWebSearch } = await import(
  './openaiRealtimeVoice.js'
)

const message = (text, annotations = []) => ({
  type: 'message',
  content: [{ type: 'output_text', text, annotations }],
})
const searchCall = (extra = {}) => ({
  type: 'web_search_call',
  status: 'completed',
  action: { type: 'search', query: 'top world news headline', ...extra },
})

/* Verbatim: the search ran, completed, retrieved nothing, and the model
 * answered as though it had no web access at all. */
const REFUSAL =
  "I'm sorry, but I don't have access to real-time news updates. For the " +
  'most current world news headlines, I recommend checking reputable news ' +
  'sources like BBC News, CNN, or Reuters.'

test('a completed search that produced a refusal is not a success', () => {
  const outcome = webSearchOutcome({
    output: [searchCall(), message(REFUSAL)],
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'refused')
  assert.match(outcome.error, /could not retrieve/i)
  /* The thing that made this bug invisible: it searched, and it succeeded. */
  assert.equal(outcome.searched, true)
})

test('runWebSearch surfaces a refusal as ok:false, never as a summary', async () => {
  /* The whole point: callers must be able to tell an answer from an apology,
   * and must never be handed the apology as if it were the answer. */
  const outcome = webSearchOutcome({ output: [searchCall(), message(REFUSAL)] })
  assert.equal(outcome.ok, false)
  assert.equal(await runWebSearch('  ').then((r) => r.ok), false)
})

test('retrieved sources count as grounding even with zero citations', () => {
  /* The Madison weather query — which worked in production — cites nothing
   * but retrieves 13 sources. A citations-only rule would break it. */
  const outcome = webSearchOutcome({
    output: [
      searchCall({ sources: Array.from({ length: 13 }, (_, i) => ({ url: `https://w${i}.example` })) }),
      message("As of 7:38 AM on Friday, August 7, 2026, in Madison, Wisconsin, it's 69°F with cloudy skies."),
    ],
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.reason, 'grounded')
  assert.equal(outcome.sourceCount, 13)
  assert.equal(outcome.citationCount, 0)
})

test('url citations count as grounding', () => {
  const outcome = webSearchOutcome({
    output: [
      searchCall(),
      message('Russia launched a ballistic missile strike on Kyiv on August 5.', [
        { type: 'url_citation', url: 'https://apnews.com/article/x', title: 'AP' },
      ]),
    ],
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.reason, 'grounded')
  assert.equal(outcome.citationCount, 1)
})

test('an answer with no search call at all is a failure', () => {
  const outcome = webSearchOutcome({ output: [message('The capital is Paris.')] })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'no_search')
  assert.equal(outcome.searched, false)
})

test('a search that did not complete is a failure', () => {
  const outcome = webSearchOutcome({
    output: [{ type: 'web_search_call', status: 'failed', action: {} }, message('Something.')],
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'search_failed')
})

test('no text is a failure even when the search succeeded', () => {
  const outcome = webSearchOutcome({ output: [searchCall({ sources: [{ url: 'https://a.example' }] })] })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'no_text')
})

/*
 * The two guards that keep the fix from becoming the opposite bug. Grounding
 * is unreliable as a NEGATIVE signal — 2 of 12 correct news answers came back
 * with no sources and no citations — so an ungrounded answer must still pass.
 */
test('a real answer with no sources and no citations still succeeds', () => {
  const outcome = webSearchOutcome({
    output: [
      searchCall(),
      message(
        "As of August 7, 2026, the top world news headline is the United States' military intervention in Venezuela.",
      ),
    ],
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.reason, 'ungrounded_answer')
  assert.equal(outcome.grounded, false)
})

test('an ungrounded "I could not fetch it, you go look" is a failure', () => {
  /* Verbatim from a live run of the patched function: this one slipped
   * through an earlier, narrower wording check and would have become a
   * morning briefing that apologises and hands the job back to the owner. */
  const outcome = webSearchOutcome({
    output: [
      searchCall(),
      message(
        'I’m really sorry—I tried to pull up the latest top world headline, but it looks ' +
          'like I couldn’t fetch live results at the moment. Could you check a reliable news ' +
          'source like Reuters or AP and let me know?',
      ),
    ],
  })

  assert.equal(outcome.ok, false)
  assert.equal(outcome.reason, 'refused')
})

test('hedging on top of real sources is still a real answer', () => {
  /* The counterweight: identical apologetic opening, but it retrieved and
   * cited, so it carries information and must NOT be judged on wording. */
  const outcome = webSearchOutcome({
    output: [
      searchCall({ sources: [{ url: 'https://apnews.com/a' }] }),
      message(
        "I'm sorry, I couldn't directly access Reuters due to access restrictions. Based on " +
          'the broader context of 2026, the dominant story remains NASA’s Artemis II mission.',
        [{ type: 'url_citation', url: 'https://apnews.com/a', title: 'AP' }],
      ),
    ],
  })

  assert.equal(outcome.ok, true)
  assert.equal(outcome.reason, 'grounded')
})

/*
 * ---- session behaviour, over a fake Realtime socket -----------------------
 *
 * createStreamingRealtimeSession takes an `openSocket` seam so the tool loop
 * can be driven without OpenAI: the fake records every event the session
 * sends and lets a test inject server events (function calls, response.done)
 * as raw JSON strings, exactly as the wire would.
 */
process.env.OPENAI_API_KEY = process.env.OPENAI_API_KEY || 'test-key'

function createFakeRealtimeSocket() {
  const handlers = { message: [], error: [], close: [], open: [] }
  const socket = {
    OPEN: 1,
    readyState: 1,
    sent: [],
    send(data) {
      socket.sent.push(JSON.parse(data))
    },
    close() {
      socket.readyState = 3
    },
    terminate() {},
    on(event, handler) {
      handlers[event]?.push(handler)
    },
    once(event, handler) {
      handlers[event]?.push(handler)
    },
    receive(event) {
      for (const handler of handlers.message) handler(JSON.stringify(event))
    },
  }
  return socket
}

async function waitForToolOutput(socket, callId, tries = 50) {
  for (let i = 0; i < tries; i++) {
    const event = socket.sent.find(
      (entry) =>
        entry.type === 'conversation.item.create' &&
        entry.item?.type === 'function_call_output' &&
        entry.item.call_id === callId,
    )
    if (event) return JSON.parse(event.item.output)
    await new Promise((resolve) => setImmediate(resolve))
  }
  throw new Error(`no function_call_output for ${callId}`)
}

function functionCall(socket, name, callId, args) {
  socket.receive({
    type: 'response.function_call_arguments.done',
    name,
    call_id: callId,
    arguments: JSON.stringify(args),
  })
}

async function openFakeSession(options = {}) {
  const socket = createFakeRealtimeSocket()
  const session = await createStreamingRealtimeSession({
    openSocket: async () => socket,
    ...options,
  })
  // Keep a rejected teardown from becoming an unhandled rejection.
  session.done.catch(() => {})
  return { socket, session }
}

const SCHOOL_FACT = {
  domain: 'email',
  name: 'account.school',
  value: 'liu@uni.edu',
  scope: 'hive',
  node: 'mac',
}
const PERSONAL_FACT = {
  domain: 'email',
  name: 'account.personal',
  value: 'evan@gmail.com',
  scope: 'hive',
  node: 'mac',
}
const lineFor = (fact) => `- ${fact.domain}/${fact.name}: ${fact.value}`

test('memory_lookup answers inside the turn with facts and lines', async () => {
  const lookups = []
  const { socket, session } = await openFakeSession({
    domainMemory: {
      lookup: async ({ domain, query }) => {
        lookups.push({ domain, query })
        return { facts: [SCHOOL_FACT], lines: [lineFor(SCHOOL_FACT)] }
      },
      save: async () => ({}),
    },
  })

  functionCall(socket, 'memory_lookup', 'call_lookup', {
    domain: 'email',
    query: 'school',
    spoken_reply: 'Checking what I remember.',
  })
  const output = await waitForToolOutput(socket, 'call_lookup')

  assert.equal(output.ok, true)
  assert.equal(output.domain, 'email')
  assert.deepEqual(output.facts, [SCHOOL_FACT])
  assert.deepEqual(output.lines, [lineFor(SCHOOL_FACT)])
  assert.deepEqual(lookups, [{ domain: 'email', query: 'school' }])
  /* Text mode answers like relay_job_status: request a text response so the
   * model can speak from the facts. */
  assert.ok(
    socket.sent.some(
      (entry) =>
        entry.type === 'response.create' &&
        entry.response?.output_modalities?.[0] === 'text',
    ),
  )

  session.abort()
  await session.done.catch(() => {})
})

test('memory_save maps args to one voice-attributed fact and reports stats', async () => {
  const saved = []
  const { socket, session } = await openFakeSession({
    domainMemory: {
      lookup: async () => ({ facts: [], lines: [] }),
      save: async (facts) => {
        saved.push(...facts)
        return { accepted: facts.length, rejected: [], kept: 1, bytes: 220, dropped: 0 }
      },
    },
  })

  functionCall(socket, 'memory_save', 'call_save', {
    domain: 'email',
    name: 'account.school',
    value: 'liu@uni.edu',
  })
  const output = await waitForToolOutput(socket, 'call_save')

  assert.equal(output.ok, true)
  assert.equal(output.accepted, 1)
  assert.equal(saved.length, 1)
  assert.equal(saved[0].node, 'voice')
  /* scope defaults to hive — the shared spec's default, so an unstated save
   * is shared with every node's brain. */
  assert.equal(saved[0].scope, 'hive')

  session.abort()
  await session.done.catch(() => {})
})

test('the memory tools are null-safe: no domainMemory option means no memory access', async () => {
  const { socket, session } = await openFakeSession({})

  functionCall(socket, 'memory_lookup', 'call_nolookup', { domain: 'email' })
  const lookupOut = await waitForToolOutput(socket, 'call_nolookup')
  functionCall(socket, 'memory_save', 'call_nosave', {
    domain: 'email',
    name: 'a.b',
    value: 'c',
  })
  const saveOut = await waitForToolOutput(socket, 'call_nosave')

  for (const output of [lookupOut, saveOut]) {
    assert.equal(output.ok, false)
    assert.match(output.error, /no memory access/i)
  }

  session.abort()
  await session.done.catch(() => {})
})

test('mac_run_actions fetches the selected domains and attaches their lines', async () => {
  /* Fetch-on-tool-selection, the owner's core ask: the email action names the
   * email domain, so the email facts ride the tool result. */
  const lookups = []
  const plans = []
  const { socket, session } = await openFakeSession({
    domainMemory: {
      lookup: async ({ domain, query }) => {
        lookups.push({ domain, query })
        return {
          facts: [SCHOOL_FACT],
          lines: [lineFor(SCHOOL_FACT)],
        }
      },
      save: async () => ({}),
    },
    onEarlyPlan: async (plan) => {
      plans.push(plan)
      return { jobId: 'job-1' }
    },
  })

  functionCall(socket, 'mac_run_actions', 'call_send', {
    actions: [
      {
        type: 'send_email',
        params: { subject: 'hi', body: 'see attached', account: 'school' },
      },
    ],
    spoken_reply: 'Sending it from your school account.',
    transcript: 'email my professor from my school account',
  })
  const output = await waitForToolOutput(socket, 'call_send')

  assert.equal(output.ok, true)
  assert.equal(output.queued, true)
  assert.deepEqual(output.domainMemory, [lineFor(SCHOOL_FACT)])
  /* The fetch was scoped to the plan's domain and carried the words. */
  assert.deepEqual(lookups, [
    { domain: 'email', query: 'email my professor from my school account' },
  ])

  const plan = await session.done
  assert.equal(plan.actions.length, 1)
  assert.equal(plans.length, 1)
})

test('an ambiguous request is refused with the clarifying question, not guessed at', async () => {
  /* The owner: "only when the prompt is ambiguous, then ask the users for
   * clarifications." Two known email accounts, no default, none named →
   * the plan must NOT dispatch; the question is the product. */
  const plans = []
  const { socket, session } = await openFakeSession({
    domainMemory: {
      lookup: async () => ({
        facts: [SCHOOL_FACT, PERSONAL_FACT],
        lines: [lineFor(SCHOOL_FACT), lineFor(PERSONAL_FACT)],
      }),
      save: async () => ({}),
    },
    onEarlyPlan: async (plan) => {
      plans.push(plan)
      return { jobId: 'job-x' }
    },
  })

  functionCall(socket, 'mac_run_actions', 'call_ambiguous', {
    actions: [{ type: 'send_email', params: { subject: 'hello' } }],
    spoken_reply: 'Sending the email.',
    transcript: 'send an email saying hello',
  })
  const output = await waitForToolOutput(socket, 'call_ambiguous')

  assert.equal(output.ok, false)
  assert.equal(output.needs_clarification, true)
  assert.match(output.question, /which email account/i)
  assert.deepEqual(output.options.sort(), ['personal', 'school'])
  /* Nothing dispatched: no early plan fired for this call. */
  assert.equal(plans.length, 0)

  /* The model then speaks the question; complete that turn and the session
   * resolves an instant plan with EMPTY actions and the question as the
   * reply — the ask channel is speech, not a queued Mac job. */
  socket.receive({
    type: 'response.done',
    response: { status: 'completed', output: [] },
  })
  const plan = await session.done
  assert.deepEqual(plan.actions, [])
  assert.equal(plan.requireLocalPlanner, false)
  assert.match(plan.response, /which email account/i)
})

test('a named account is not ambiguity: the plan dispatches with memory attached', async () => {
  /* The counterweight — the request names "school", so the registry's
   * named-candidate leg clears it and the action goes out. */
  const plans = []
  const { socket, session } = await openFakeSession({
    domainMemory: {
      lookup: async () => ({
        facts: [SCHOOL_FACT, PERSONAL_FACT],
        lines: [lineFor(SCHOOL_FACT), lineFor(PERSONAL_FACT)],
      }),
      save: async () => ({}),
    },
    onEarlyPlan: async (plan) => {
      plans.push(plan)
      return { jobId: 'job-2' }
    },
  })

  functionCall(socket, 'mac_run_actions', 'call_named', {
    actions: [{ type: 'send_email', params: { subject: 'hello' } }],
    transcript: 'send an email from my school account',
  })
  const output = await waitForToolOutput(socket, 'call_named')

  assert.equal(output.ok, true)
  assert.equal(output.needs_clarification, undefined)
  assert.equal(output.domainMemory.length, 2)
  assert.equal(plans.length, 1)
  await session.done
})

test('browser_run_actions falls back to the browser domain for its verbs', async () => {
  const lookups = []
  const { socket, session } = await openFakeSession({
    domainMemory: {
      lookup: async ({ domain }) => {
        lookups.push(domain)
        return {
          facts: [{ domain: 'browser', name: 'site.bank', value: 'chase.com' }],
          lines: ['- browser/site.bank: chase.com'],
        }
      },
      save: async () => ({}),
    },
    onEarlyPlan: async () => ({ jobId: 'job-3' }),
  })

  functionCall(socket, 'browser_run_actions', 'call_browser', {
    actions: [{ type: 'browser_navigate', params: { url: 'https://chase.com' } }],
    transcript: 'open my bank',
  })
  const output = await waitForToolOutput(socket, 'call_browser')

  assert.deepEqual(lookups, ['browser'])
  assert.deepEqual(output.domainMemory, ['- browser/site.bank: chase.com'])
  await session.done
})

test('a failing memory fetch never costs the action it decorates', async () => {
  const plans = []
  const { socket, session } = await openFakeSession({
    domainMemory: {
      lookup: async () => {
        throw new Error('D1 is down')
      },
      save: async () => ({}),
    },
    onEarlyPlan: async (plan) => {
      plans.push(plan)
      return { jobId: 'job-4' }
    },
  })

  functionCall(socket, 'mac_run_actions', 'call_besteffort', {
    actions: [{ type: 'send_email', params: { subject: 'hi' } }],
    transcript: 'send the email to my school account',
  })
  const output = await waitForToolOutput(socket, 'call_besteffort')

  assert.equal(output.ok, true)
  assert.equal(output.domainMemory, undefined)
  assert.equal(plans.length, 1)
  await session.done
})

/*
 * ---- set_timer, against the real relay timer store ------------------------
 *
 * Not a stub. The claim voice parity makes is that the model's timer and the
 * knob's timer are the SAME store — so the test drives the tool through the
 * socket seam into createTimerControl over a real memory store, and then reads
 * the result back through the knob path's own reader. A fake control here
 * would prove the tool calls something, which is not the claim.
 */
const { createTimerControl, claimDueTimers, listTimers, selectRunningTimers } =
  await import('./timerStore.js')
const { createMemoryStore } = await import('./store/memoryStore.js')

async function openTimerSession(clock) {
  const store = createMemoryStore()
  const opened = await openFakeSession({
    timerControl: createTimerControl({ store, deviceId: 'nrf9160-pendant', now: () => clock.at }),
  })
  return { ...opened, store }
}

test('set_timer start writes a timer the knob path can see and sweep', async () => {
  const clock = { at: Date.parse('2026-08-12T15:00:00.000Z') }
  const { socket, session, store } = await openTimerSession(clock)

  functionCall(socket, 'set_timer', 'call_timer_start', { action: 'start', minutes: 17 })
  const output = await waitForToolOutput(socket, 'call_timer_start')

  assert.equal(output.ok, true)
  assert.equal(output.spoken, '17 minute timer started.')

  const stored = await listTimers(store, 'nrf9160-pendant')
  assert.equal(stored.length, 1)
  assert.equal(stored[0].setBy, 'voice')
  assert.equal(selectRunningTimers(stored, clock.at + 60_000).length, 1)

  /* And it comes due on the same sweep the ring's timers come due on. */
  clock.at += 18 * 60_000
  const due = await claimDueTimers({ store, deviceId: 'nrf9160-pendant', now: clock.at })
  assert.equal(due.length, 1)

  session.abort()
  await session.done.catch(() => {})
})

test('set_timer asks for a duration instead of inventing one', async () => {
  const clock = { at: Date.parse('2026-08-12T15:00:00.000Z') }
  const { socket, session, store } = await openTimerSession(clock)

  functionCall(socket, 'set_timer', 'call_timer_bad', { action: 'start' })
  const output = await waitForToolOutput(socket, 'call_timer_bad')

  assert.equal(output.ok, false)
  assert.equal(output.spoken, 'How long should the timer run?')
  assert.deepEqual(await listTimers(store, 'nrf9160-pendant'), [])

  session.abort()
  await session.done.catch(() => {})
})

test('set_timer status and cancel read and clear the same rows', async () => {
  const clock = { at: Date.parse('2026-08-12T15:00:00.000Z') }
  const { socket, session, store } = await openTimerSession(clock)

  functionCall(socket, 'set_timer', 'call_t1', { action: 'start', minutes: 10 })
  await waitForToolOutput(socket, 'call_t1')

  clock.at += 4 * 60_000
  functionCall(socket, 'set_timer', 'call_t2', { action: 'status' })
  assert.equal(
    (await waitForToolOutput(socket, 'call_t2')).spoken,
    '6 minutes left on your 10 minute timer.',
  )

  functionCall(socket, 'set_timer', 'call_t3', { action: 'cancel' })
  assert.equal((await waitForToolOutput(socket, 'call_t3')).spoken, 'Cancelled your 10 minute timer.')

  clock.at += 60 * 60_000
  assert.deepEqual(await claimDueTimers({ store, deviceId: 'nrf9160-pendant', now: clock.at }), [])

  session.abort()
  await session.done.catch(() => {})
})

test('a session with no timer wiring says it cannot, not that there are none', async () => {
  const { socket, session } = await openFakeSession({})

  functionCall(socket, 'set_timer', 'call_no_wiring', { action: 'status' })
  const output = await waitForToolOutput(socket, 'call_no_wiring')

  assert.equal(output.ok, false)
  /* "I can't set timers" and "you have no timers running" are different facts;
   * collapsing them would report an empty list every time the wiring broke. */
  assert.match(output.spoken, /can't set timers/i)

  session.abort()
  await session.done.catch(() => {})
})

test('a timer refused by the store is spoken, not swallowed', async () => {
  const clock = { at: Date.parse('2026-08-12T15:00:00.000Z') }
  const { socket, session, store } = await openTimerSession(clock)

  functionCall(socket, 'set_timer', 'call_too_long', { action: 'start', minutes: 60 * 48 })
  const output = await waitForToolOutput(socket, 'call_too_long')

  assert.equal(output.ok, false)
  assert.match(output.spoken, /24 hours/)
  assert.deepEqual(await listTimers(store, 'nrf9160-pendant'), [])

  session.abort()
  await session.done.catch(() => {})
})

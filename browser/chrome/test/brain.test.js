import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BRAIN_LOCAL_TOOLS,
  BRAIN_MAX_MESSAGES,
  BRAIN_MAX_TRANSCRIPT_CHARS,
  BRAIN_OUTPUT_TOKENS,
  BRAIN_TOOLS,
  compactMemoryResult,
  compactToolResult,
  createBrainTranscript,
  describeInferFailure,
  inferRequest,
  memoryLookupRequest,
  memorySaveRequest,
  parseBrainReply,
  readInferPayload,
  toolCatalogueDrift,
} from '../src/brain.js'
import { COMMAND_TYPES } from '../src/bridge-core.js'
import { MEMORY_TOOL_TYPES } from '../../../mobile/simulator/shared/domains/index.js'

/*
 * The relay's own ceilings, copied here from cloud-relay/nodeInference.js so a
 * test fails if this side ever budgets ABOVE them. Deliberately duplicated
 * rather than imported: the relay is a separate deployable, and the point is
 * to catch the two drifting apart, which a shared constant would hide.
 */
const RELAY_MAX_INFER_MESSAGES = 40
const RELAY_MAX_INFER_CHARS = 24_000
const RELAY_MAX_INFER_OUTPUT_TOKENS = 2_048

test('the tool catalogue is exactly what the executor accepts, plus memory', () => {
  const drift = toolCatalogueDrift()
  assert.deepEqual(drift.undescribed, [])
  assert.deepEqual(drift.unknown, [])
  assert.equal(BRAIN_TOOLS.length, COMMAND_TYPES.size + MEMORY_TOOL_TYPES.length)
  /* Every verb offered has something to say about itself: a bare name teaches
   * the model nothing and it guesses params. */
  for (const tool of BRAIN_TOOLS) {
    assert.ok(tool.description.length > 20, `${tool.type} has no usable description`)
  }
})

test('the memory verbs ride the catalogue with derived param hints', () => {
  assert.deepEqual(
    BRAIN_LOCAL_TOOLS.map((tool) => tool.type),
    [...MEMORY_TOOL_TYPES],
  )
  const byType = new Map(BRAIN_LOCAL_TOOLS.map((tool) => [tool.type, tool]))

  /* The hints are DERIVED from the shared specs, in the executor voice —
   * optional params carry the `?` the model already knows how to read. */
  const lookup = byType.get('memory_lookup')
  assert.equal(lookup.local, true)
  assert.match(lookup.description, /params: \{domain, query\?\}/)

  /* memory_save never offers `scope`: this node pins every save to 'hive'
   * because a browser has no local durable store, and the description says
   * so rather than leaving the model to wonder where its fact went. */
  const save = byType.get('memory_save')
  assert.equal(save.local, true)
  assert.match(save.description, /params: \{domain, name, value\}/)
  assert.equal(save.description.includes('scope?'), false)
  assert.match(save.description, /shared with the hive/)

  /* And BRAIN_TOOLS carries them, so the prompt lists them with the rest. */
  const offered = new Set(BRAIN_TOOLS.map((tool) => tool.type))
  for (const type of MEMORY_TOOL_TYPES) assert.ok(offered.has(type))
})

test('the brain budgets under every relay ceiling, never at it', () => {
  /* normalizeInferMessages REJECTS an over-budget prompt rather than trimming,
   * so equality here would mean a transcript that 400s at the boundary. */
  assert.ok(BRAIN_MAX_MESSAGES < RELAY_MAX_INFER_MESSAGES)
  assert.ok(BRAIN_MAX_TRANSCRIPT_CHARS < RELAY_MAX_INFER_CHARS)
  assert.ok(BRAIN_OUTPUT_TOKENS <= RELAY_MAX_INFER_OUTPUT_TOKENS)
})

test('the infer request asks for JSON and names its own output budget', () => {
  const request = inferRequest({}, [{ role: 'user', content: 'hi' }])
  assert.equal(request.method, 'POST')
  assert.equal(request.path, '/v1/infer')
  assert.equal(request.auth, 'device')
  assert.equal(request.body.responseFormat, 'json_object')
  /* The relay's default is 512, not the ceiling. json_object plus an unset
   * budget is the documented way to get unparseable JSON. */
  assert.equal(request.body.maxTokens, BRAIN_OUTPUT_TOKENS)
  assert.ok(request.body.maxTokens > 512)
})

test('a tool call, an answer and a handoff each parse', () => {
  const call = parseBrainReply('{"thought":"look first","tool":"snapshot","params":{"maxElements":40}}')
  assert.equal(call.kind, 'call')
  assert.equal(call.call.type, 'snapshot')
  assert.equal(call.call.params.maxElements, 40)

  const answered = parseBrainReply('{"thought":"done","answer":"There are 3 recurring plans."}')
  assert.equal(answered.kind, 'answer')
  assert.match(answered.answer, /3 recurring plans/)

  const handoff = parseBrainReply('{"thought":"not a browser job","handoff":"needs the shell"}')
  assert.equal(handoff.kind, 'handoff')
  assert.match(handoff.reason, /shell/)
})

test('a memory verb parses as a call the loop must run locally', () => {
  const lookup = parseBrainReply(
    '{"thought":"which account?","tool":"memory_lookup","params":{"domain":"email"}}',
  )
  assert.equal(lookup.kind, 'call')
  assert.equal(lookup.call.type, 'memory_lookup')
  assert.equal(lookup.call.params.domain, 'email')
  /* local:true is the branch console-engine takes to the relay instead of the
   * page executor — an executor call must NOT carry it. */
  assert.equal(lookup.local, true)

  const save = parseBrainReply(
    '{"thought":"worth keeping","tool":"memory_save","params":{"domain":"email","name":"account.school","value":"liu@uni.edu"}}',
  )
  assert.equal(save.kind, 'call')
  assert.equal(save.local, true)

  const pageCall = parseBrainReply('{"thought":"look","tool":"snapshot","params":{}}')
  assert.equal(pageCall.kind, 'call')
  assert.ok(!pageCall.local)

  /* Memory params obey the same shape rule as executor params. */
  assert.equal(parseBrainReply('{"tool":"memory_lookup","params":["email"]}').kind, 'error')
})

test('the memory requests are pure descriptors, and every save is hive-scoped', () => {
  /* A lookup rides the query string, bounded — a whole pasted command must not
   * become a kilometre of URL. Auth is a header concern, never a param. */
  const lookup = memoryLookupRequest({ domain: 'email', query: 'x'.repeat(500), limit: 10 })
  assert.equal(lookup.method, 'GET')
  assert.equal(lookup.auth, 'device')
  assert.match(lookup.path, /^\/v1\/memory\/domains\?/)
  assert.match(lookup.path, /domain=email/)
  assert.match(lookup.path, /limit=10/)
  const query = new URL(`https://x${lookup.path}`).searchParams.get('query')
  assert.equal(query.length, 200)

  /* Bare lookup: no params, no stray "?". */
  assert.equal(memoryLookupRequest().path, '/v1/memory/domains')

  /*
   * The save pins scope to 'hive' WHATEVER the model asked for: this browser
   * has no local durable store, so a node-scoped fact saved here would be a
   * fact saved nowhere. The node name is provenance, not a storage address.
   */
  const save = memorySaveRequest('ext-safari-mac', {
    domain: 'email',
    name: 'account.school',
    value: 'liu@uni.edu',
    scope: 'node',
  })
  assert.equal(save.method, 'POST')
  assert.equal(save.path, '/v1/memory/domains')
  assert.equal(save.body.node, 'ext-safari-mac')
  assert.deepEqual(save.body.facts, [
    { domain: 'email', name: 'account.school', value: 'liu@uni.edu', scope: 'hive' },
  ])
})

test('a memory result is compacted for the model, not echoed as an envelope', () => {
  const kept = compactMemoryResult(
    'memory_save',
    { domain: 'email', name: 'account.school' },
    { ok: true, accepted: 1, rejected: 0, kept: 4 },
  )
  assert.equal(kept, 'Saved dom.email.account.school (hive).')

  const refused = compactMemoryResult(
    'memory_save',
    { domain: 'nonsense', name: 'x' },
    { ok: true, accepted: 0, rejected: 1, kept: 4 },
  )
  assert.match(refused, /did not keep dom\.nonsense\.x/)

  const found = compactMemoryResult(
    'memory_lookup',
    { domain: 'email' },
    { ok: true, lines: ['- email/account.personal: evan@gmail.com', '- email/account.school: liu@uni.edu'] },
  )
  assert.match(found, /^2 remembered fact\(s\):/)
  assert.match(found, /account\.school: liu@uni\.edu/)

  /* An empty answer is said plainly, so the model stops looking and asks. */
  assert.equal(
    compactMemoryResult('memory_lookup', { domain: 'music' }, { ok: true, lines: [] }),
    'No remembered facts in music matched.',
  )
})

test('the fourth shape: a clarify parses as a question, capped like a thought', () => {
  const asked = parseBrainReply(
    '{"thought":"two accounts, none named","clarify":"Which email account — personal or school?"}',
  )
  assert.equal(asked.kind, 'clarify')
  assert.match(asked.question, /personal or school/)
  assert.match(asked.thought, /none named/)

  /* A clarification that runs long is narration, not a question. */
  const rambling = parseBrainReply(JSON.stringify({ clarify: 'x'.repeat(1_000) }))
  assert.equal(rambling.kind, 'clarify')
  assert.equal(rambling.question.length, 300)
})

test('a fenced reply parses; a shapeless one becomes a correction', () => {
  const fenced = parseBrainReply('```json\n{"tool":"list_tabs","params":{}}\n```')
  assert.equal(fenced.kind, 'call')
  assert.equal(fenced.call.type, 'list_tabs')

  assert.equal(parseBrainReply('I will open the page.').kind, 'error')
  assert.equal(parseBrainReply('{"thought":"hm"}').kind, 'error')
  assert.equal(parseBrainReply('[]').kind, 'error')

  /* Params must be an object or the executor gets a shape it cannot validate. */
  assert.equal(parseBrainReply('{"tool":"click","params":["e4"]}').kind, 'error')
})

test('a verb the executor does not have is refused before it is run', () => {
  const reply = parseBrainReply('{"tool":"run_shell","params":{"cmd":"rm -rf /"}}')
  assert.equal(reply.kind, 'error')
  assert.match(reply.error, /is not a tool/)
  /* The correction names the real vocabulary, so the next turn can be right —
   * the whole vocabulary, memory verbs included. */
  assert.match(reply.error, /snapshot/)
  assert.match(reply.error, /memory_lookup/)
  assert.match(reply.error, /memory_save/)
})

test('truncated, filtered and refused answers are all rejected', () => {
  assert.equal(readInferPayload({ content: '{"answer":"hi"}', complete: true }).ok, true)
  /* A provider that sends no finish_reason is unknown, not bad. */
  assert.equal(readInferPayload({ content: '{"answer":"hi"}', complete: null }).ok, true)

  const cut = readInferPayload({ content: '{"answer":"h', truncated: true })
  assert.equal(cut.ok, false)
  assert.match(cut.error, /output budget/)

  /* content_filter: short content, truncated:false — the bug one field over. */
  const filtered = readInferPayload({
    content: 'no',
    truncated: false,
    complete: false,
    finishReason: 'content_filter',
  })
  assert.equal(filtered.ok, false)
  assert.match(filtered.error, /content_filter/)

  const declined = readInferPayload({ content: '', refusal: 'I cannot help with that.' })
  assert.equal(declined.ok, false)
  assert.match(declined.error, /declined/)

  assert.equal(readInferPayload({ content: '   ' }).ok, false)
})

test('the brain parks on retryAfter, whatever the status code says', () => {
  const limited = describeInferFailure(
    Object.assign(new Error('budget spent'), { status: 429, code: 'rate_limited', retryAfter: 120 }),
  )
  assert.equal(limited.parkBrain, true)
  assert.equal(limited.retryAfter, 120)

  const unconfigured = describeInferFailure(
    Object.assign(new Error('no key'), { status: 503, code: 'not_configured', retryAfter: 300 }),
  )
  assert.equal(unconfigured.parkBrain, true)

  /*
   * The contract the relay writes down: retryAfter is device-scoped, so a
   * reason it adds LATER must park this client with no change here. A status
   * code this side has never heard of, carrying the field, parks.
   */
  const future = describeInferFailure(
    Object.assign(new Error('some new reason'), { status: 418, code: 'brand_new', retryAfter: 60 }),
  )
  assert.equal(future.parkBrain, true)
  assert.equal(future.retryAfter, 60)

  /* And a refusal WITHOUT the field must not park a working brain. */
  const upstream = describeInferFailure(
    Object.assign(new Error('provider refused'), { status: 502, code: 'upstream_error' }),
  )
  assert.equal(upstream.parkBrain, false)
  assert.equal(upstream.fatal, false)

  const badRequest = describeInferFailure(
    Object.assign(new Error('prompt too big'), { status: 400, code: 'prompt_too_large' }),
  )
  assert.equal(badRequest.parkBrain, false)
  assert.equal(badRequest.fatal, true)
})

test('a snapshot is compacted to what the model addresses elements by', () => {
  const elements = Array.from({ length: 80 }, (_, index) => ({
    ref: `e${index}`,
    role: 'button',
    name: `Button ${index}`,
    selector: 'html > body > div:nth-of-type(1) > div:nth-of-type(2) > button',
    href: 'https://example.com/a/very/long/path/that/nobody/clicks/on',
    bounds: { x: 0, y: 0, w: 1, h: 1 },
    tag: 'button',
    disabled: false,
  }))

  const text = compactToolResult('snapshot', {
    elements,
    title: 'Portfolio',
    url: 'https://example.com/portfolio',
  })

  assert.match(text, /e0 <button> "Button 0"/)
  assert.match(text, /80 interactive element\(s\)/)
  /* The bulk that made a raw snapshot most of the prompt budget is gone. */
  assert.equal(text.includes('nth-of-type'), false)
  assert.equal(text.includes('bounds'), false)
  /* And the count that was dropped is stated, not silently missing. */
  assert.match(text, /more element\(s\) not shown/)
  assert.ok(text.length < 4_000)
})

test('a withheld field is shown as withheld, not as its contents', () => {
  const text = compactToolResult('snapshot', {
    elements: [
      { ref: 'e1', role: 'textbox', name: 'Password', sensitivity: 'secret' },
      { ref: 'e2', role: 'button', name: 'Sign in', disabled: true },
    ],
    url: 'https://example.com/login',
  })
  assert.match(text, /e1 <textbox> "Password" \[secret — contents withheld\]/)
  assert.match(text, /\[disabled\]/)
})

test('the transcript pins the task and drops the middle when it must', () => {
  const transcript = createBrainTranscript({
    command: 'cancel my recurring investments',
    page: { url: 'https://github.com/evan1liu/agentic-gadget', title: 'agentic-gadget' },
    now: Date.parse('2026-08-09T20:00:00.000Z'),
  })

  const opening = transcript.messages()
  assert.equal(opening.length, 2)
  assert.equal(opening[0].role, 'system')
  assert.match(opening[1].content, /cancel my recurring investments/)
  /* The page is its own labelled line, not spliced into the owner's sentence. */
  assert.match(opening[1].content, /currently looking at/)
  assert.equal(opening[1].content.includes('[Sent from the browser extension'), false)

  for (let index = 0; index < 40; index += 1) {
    transcript.pushAssistant(`{"tool":"read_page","params":{}}`)
    transcript.pushResult('x'.repeat(1_500))
  }

  const messages = transcript.messages()
  const chars = messages.reduce((total, message) => total + message.content.length, 0)
  assert.ok(messages.length <= BRAIN_MAX_MESSAGES + 1, `got ${messages.length} messages`)
  assert.ok(chars <= BRAIN_MAX_TRANSCRIPT_CHARS + 500, `got ${chars} chars`)

  /* The task survives the trimming... */
  assert.equal(messages[0].role, 'system')
  assert.match(messages[1].content, /cancel my recurring investments/)
  /* ...and the loss is stated rather than left as a gap the model fills in. */
  assert.match(
    messages.map((message) => message.content).join('\n'),
    /dropped from this transcript/,
  )
  assert.ok(transcript.stats().dropped > 0)
})

test('the prompt carries the three instructions a live run showed it needs', () => {
  const [system] = createBrainTranscript({ command: 'x' }).messages()

  /*
   * Measured against the real model on 2026-08-09, not assumed. The first
   * draft warned that outward steps "will be STOPPED and put to the owner for
   * approval", and asked to cancel recurring investments the model answered
   * with a bare {"thought": "…requires the owner's approval…"} — no tool, no
   * answer, no handoff. It read the warning as "stop and explain", which
   * leaves the task neither done nor asked, and cost a step to correct.
   *
   * These three assertions are the fix, pinned as properties rather than as
   * phrasing: say a thought alone is not a reply, tell it to call the tool
   * anyway because the SYSTEM does the stopping, and tell it not to ask for
   * permission itself.
   */
  assert.match(system.content, /A reply with only\n"thought" is not a reply/)
  assert.match(system.content, /KEEP GOING AND CALL THE TOOL ANYWAY/)
  assert.match(system.content, /do not ask the\n  owner for permission yourself/)

  /* And the rules that were right the first time. */
  assert.match(system.content, /Do not claim you did something you did not do/)
  assert.match(system.content, /handoff/)
})

test('the prompt teaches the memory verbs and the clarify shape', () => {
  const [system] = createBrainTranscript({ command: 'x' }).messages()

  /* Both verbs are listed with the rest of the catalogue... */
  assert.match(system.content, /- memory_lookup: /)
  assert.match(system.content, /- memory_save: /)
  /* ...with the discipline: consult before acting on an ambiguous "which",
   * save only durables, never page contents or chat. */
  assert.match(system.content, /Consult memory_lookup BEFORE acting/)
  assert.match(system.content, /Never page contents, never chat/)

  /* The clarify shape is the FOURTH shape, offered only for real ambiguity —
   * and explicitly not as a way to ask permission for outward steps, which
   * would reopen the stop-and-narrate failure the three instructions above
   * were measured fixing. */
  assert.match(system.content, /"clarify": "<one question for the owner>"/)
  assert.match(system.content, /ONLY when the request is genuinely ambiguous/)
  assert.match(system.content, /never for permission/)
})

test('memory lines are pinned into the opening, and survive trimming', () => {
  const transcript = createBrainTranscript({
    command: 'check my email',
    memoryLines: [
      '- email/account.personal: evan20050827@gmail.com',
      '- email/account.school: liu@uni.edu',
    ],
  })

  const [, opening] = transcript.messages()
  assert.match(opening.content, /What the owner's memory says \(domain memory\):/)
  assert.match(opening.content, /email\/account\.personal/)
  assert.match(opening.content, /email\/account\.school/)

  /* Pinned like the command: forty fat exchanges later the grounding is still
   * in message[1], because grounding that slides out of the window is how a
   * brain re-asks a question the owner already answered. */
  for (let index = 0; index < 40; index += 1) {
    transcript.pushAssistant('{"tool":"read_page","params":{}}')
    transcript.pushResult('x'.repeat(1_500))
  }
  const messages = transcript.messages()
  assert.match(messages[1].content, /account\.personal/)

  /* No lines, no block — an empty labelled section would be noise. */
  const bare = createBrainTranscript({ command: 'check my email' })
  assert.equal(bare.messages()[1].content.includes('domain memory'), false)
})

test('the memory descriptors target the relay routes and pin hive scope', () => {
  const lookup = memoryLookupRequest({ domain: 'email', query: 'which account', limit: 10 })
  assert.equal(lookup.method, 'GET')
  assert.equal(lookup.auth, 'device')
  assert.match(lookup.path, /^\/v1\/memory\/domains\?/)
  assert.match(lookup.path, /domain=email/)
  assert.match(lookup.path, /query=which\+account/)
  assert.match(lookup.path, /limit=10/)

  /* A bare lookup carries no query string at all. */
  assert.equal(memoryLookupRequest().path, '/v1/memory/domains')

  const save = memorySaveRequest('browser-safari', {
    domain: 'email',
    name: 'account.school',
    value: 'liu@uni.edu',
    /* The model asking for node scope changes nothing: this browser has no
     * local durable store, so every deliberate save is a hive fact. */
    scope: 'node',
  })
  assert.equal(save.method, 'POST')
  assert.equal(save.path, '/v1/memory/domains')
  assert.equal(save.body.node, 'browser-safari')
  assert.equal(save.body.facts.length, 1)
  assert.equal(save.body.facts[0].scope, 'hive')
  assert.equal(save.body.facts[0].name, 'account.school')
})

test('memory results are compacted for the transcript, not echoed', () => {
  const found = compactMemoryResult(
    'memory_lookup',
    { domain: 'email' },
    {
      ok: true,
      facts: [{}, {}],
      lines: ['- email/account.personal: evan@gmail.com', '- email/account.school: liu@uni.edu'],
    },
  )
  assert.match(found, /2 remembered fact\(s\):/)
  assert.match(found, /account\.school/)

  const empty = compactMemoryResult('memory_lookup', { domain: 'music' }, { ok: true, lines: [] })
  assert.match(empty, /No remembered facts in music matched\./)

  const saved = compactMemoryResult(
    'memory_save',
    { domain: 'email', name: 'account.school' },
    { ok: true, accepted: 1, rejected: 0, kept: 4 },
  )
  assert.equal(saved, 'Saved dom.email.account.school (hive).')

  /* A rejected save must read as a failure the model can correct, not as
   * silence it mistakes for success. */
  const refused = compactMemoryResult(
    'memory_save',
    { domain: 'email', name: 'bad name' },
    { ok: true, accepted: 0, rejected: 1, kept: 4 },
  )
  assert.match(refused, /did not keep dom\.email\.bad name/)
})

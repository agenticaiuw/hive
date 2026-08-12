import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BRAIN_MAX_MESSAGES,
  BRAIN_MAX_TRANSCRIPT_CHARS,
  BRAIN_OUTPUT_TOKENS,
  BRAIN_TOOLS,
  compactToolResult,
  createBrainTranscript,
  describeInferFailure,
  inferRequest,
  parseBrainReply,
  readInferPayload,
  toolCatalogueDrift,
} from '../src/brain.js'
import { COMMAND_TYPES } from '../src/bridge-core.js'

/*
 * The relay's own ceilings, copied here from cloud-relay/nodeInference.js so a
 * test fails if this side ever budgets ABOVE them. Deliberately duplicated
 * rather than imported: the relay is a separate deployable, and the point is
 * to catch the two drifting apart, which a shared constant would hide.
 */
const RELAY_MAX_INFER_MESSAGES = 40
const RELAY_MAX_INFER_CHARS = 24_000
const RELAY_MAX_INFER_OUTPUT_TOKENS = 2_048

test('the tool catalogue is exactly what the executor accepts', () => {
  const drift = toolCatalogueDrift()
  assert.deepEqual(drift.undescribed, [])
  assert.deepEqual(drift.unknown, [])
  assert.equal(BRAIN_TOOLS.length, COMMAND_TYPES.size)
  /* Every verb offered has something to say about itself: a bare name teaches
   * the model nothing and it guesses params. */
  for (const tool of BRAIN_TOOLS) {
    assert.ok(tool.description.length > 20, `${tool.type} has no usable description`)
  }
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
  /* The correction names the real vocabulary, so the next turn can be right. */
  assert.match(reply.error, /snapshot/)
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

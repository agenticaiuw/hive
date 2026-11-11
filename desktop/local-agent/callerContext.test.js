import assert from 'node:assert/strict'
import test from 'node:test'

import {
  callerContextPromptBlock,
  normalizeCallerContext,
  prepareCallerContext,
  stripContextTrailer,
} from './callerContext.js'
import { describeGoal } from './goalVerdict.js'

/*
 * The exact string the browser extension sent on 2026-08-09, copied from the
 * job record (`local_7e74fa1e…`), not retyped. The em dash and the blank line
 * are the parts that matter.
 */
const LIVE_COMMAND =
  'cancel all my recurring investments on ibkr\n\n[Sent from the browser extension. Active page: "evan1liu/agentic-gadget" — https://github.com/evan1liu/agentic-gadget/tree/main]'

test('the live trailer comes off, and only the trailer', () => {
  assert.equal(
    stripContextTrailer(LIVE_COMMAND),
    'cancel all my recurring investments on ibkr',
  )
})

test('a trailer-shaped thing that is not a trailer is left alone', () => {
  /* The shape is what identifies it: a blank line, then a bracket block that
   * runs to the end. Normal prose does not produce that, and these are the
   * cases that would break if the match were loosened to "ends in a bracket"
   * or "contains [Sent". */
  const inline = 'rename the file [draft] to final'
  assert.equal(stripContextTrailer(inline), inline)

  const endsInBracket = 'search for the term [redacted]'
  assert.equal(stripContextTrailer(endsInBracket), endsInBracket)

  const singleNewline = 'do the thing\n[not a trailer]'
  assert.equal(stripContextTrailer(singleNewline), singleNewline)

  assert.equal(stripContextTrailer(''), '')
  assert.equal(stripContextTrailer(null), '')
})

test('stripping is idempotent, because two entry points both do it', () => {
  const once = stripContextTrailer(LIVE_COMMAND)
  assert.equal(stripContextTrailer(once), once)
})

test('THE REGRESSION: the goal phrase no longer swallows the trailer', () => {
  /*
   * What the owner was actually told: "Cancelling all your recurring
   * investments on ibkr [Sent is still to do." objectAfter() splits on the
   * first clause boundary and "…browser extension." supplies one, so "[Sent"
   * became the seventh word of the object.
   */
  const goal = describeGoal(LIVE_COMMAND)
  assert.equal(goal.wantsChange, true)
  assert.equal(goal.object, 'all your recurring investments on ibkr')
  assert.equal(goal.gerundPhrase, 'cancelling all your recurring investments on ibkr')
  assert.equal(goal.gerundPhrase.includes('[Sent'), false)

  /* And the clean command must read identically, or the strip changed meaning
   * rather than removing noise. */
  const clean = describeGoal('cancel all my recurring investments on ibkr')
  assert.equal(goal.gerundPhrase, clean.gerundPhrase)
  assert.deepEqual(goal.objectWords, clean.objectWords)
})

test('a page becomes context; anything unusable becomes null', () => {
  const context = normalizeCallerContext({
    surface: 'browser-extension',
    page: { url: 'https://github.com/evan1liu/agentic-gadget', title: 'evan1liu/agentic-gadget' },
  })
  assert.equal(context.page.url, 'https://github.com/evan1liu/agentic-gadget')
  assert.equal(context.page.title, 'evan1liu/agentic-gadget')
  assert.equal(context.surface, 'browser-extension')

  assert.equal(normalizeCallerContext(null), null)
  assert.equal(normalizeCallerContext({}), null)
  assert.equal(normalizeCallerContext({ page: {} }), null)
  assert.equal(normalizeCallerContext('https://example.com'), null)
  assert.equal(normalizeCallerContext([{ page: { url: 'https://a.example' } }]), null)

  /* Not a page the planner can act on, and not one worth repeating into a
   * prompt either. */
  assert.equal(normalizeCallerContext({ page: { url: 'file:///Users/evanliu/secrets.txt' } }), null)
  assert.equal(
    normalizeCallerContext({ page: { url: 'chrome-extension://abc/popup.html' } }),
    null,
  )
  assert.equal(normalizeCallerContext({ page: { url: 'javascript:alert(1)' } }), null)
})

test('the prompt block says where they were AND that it may not be the task', () => {
  const block = callerContextPromptBlock({
    surface: 'browser-extension',
    page: { url: 'https://github.com/evan1liu/agentic-gadget', title: 'agentic-gadget' },
  })
  assert.match(block, /The owner was looking at:/)
  assert.match(block, /agentic-gadget/)
  /*
   * The line that earns the block its place. Without it a planner reads "the
   * page the owner is on" as "the page this task is about" — which is exactly
   * how a command naming ibkr got planned against a GitHub tab.
   */
  assert.match(block, /not necessarily what the task is about/)
  assert.match(block, /when the request names somewhere else, go there instead/)

  assert.equal(callerContextPromptBlock(null), '')
  assert.equal(callerContextPromptBlock({ page: { url: 'nonsense' } }), '')
})

test('context arriving first-class removes the duplicate from the text', () => {
  /* The attachments precedent: when the structured field is present, the
   * redundant inline copy comes off so the model sees the page exactly once. */
  const prepared = prepareCallerContext({
    command: LIVE_COMMAND,
    context: {
      surface: 'browser-extension',
      page: { url: 'https://github.com/evan1liu/agentic-gadget', title: 'evan1liu/agentic-gadget' },
    },
  })
  assert.equal(prepared.command, 'cancel all my recurring investments on ibkr')
  assert.equal(prepared.context.page.title, 'evan1liu/agentic-gadget')
  assert.match(prepared.promptBlock, /The owner was looking at:/)
})

test('OLDER-AGENT PARITY: no context field means the command is untouched', () => {
  /*
   * The reason the extension still sends the trailer. An agent that does not
   * understand `context` must behave exactly as it did before this file
   * existed — including keeping the trailer, which is the only way the page
   * reaches it at all.
   */
  const prepared = prepareCallerContext({ command: LIVE_COMMAND })
  assert.equal(prepared.command, LIVE_COMMAND)
  assert.equal(prepared.context, null)
  assert.equal(prepared.promptBlock, '')

  /* Malformed context is the same case: ignored, not half-applied. */
  const junk = prepareCallerContext({ command: LIVE_COMMAND, context: { page: 'nope' } })
  assert.equal(junk.command, LIVE_COMMAND)
  assert.equal(junk.context, null)
})

test('oversized fields are bounded rather than refused', () => {
  const long = 'a'.repeat(2000)
  const context = normalizeCallerContext({
    page: {
      url: 'https://example.com/' + long,
      title: 'x'.repeat(1000),
    },
  })
  assert.ok(context.page.url.length <= 500)
  assert.ok(context.page.title.length <= 160)
})

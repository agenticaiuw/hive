/*
 * What the CALLER's surface was looking at when it sent the command.
 *
 * Not to be confused with conversationContext.js, which is what this agent
 * REMEMBERS (recent chat, facts, people). This is what the other end can see
 * and we cannot: the page in front of the owner, the tab they were on.
 *
 * ---------------------------------------------------------------------------
 * WHY THIS EXISTS AT ALL
 *
 * POST /plan had one channel — `command` — so a surface with context to add
 * had nowhere to put it but the text. The browser extension appends a trailer:
 *
 *   cancel all my recurring investments on ibkr
 *
 *   [Sent from the browser extension. Active page: "evan1liu/agentic-gadget" — https://github.com/…]
 *
 * That works right up until something downstream reads the command as a
 * sentence, and then it is a splice. Observed live on 2026-08-09, both from one
 * command:
 *
 *   1. goalVerdict.describeGoal takes the words after the change verb, stops at
 *      the first clause boundary and keeps seven of them. "extension." supplies
 *      the boundary, so the object became "all your recurring investments on
 *      ibkr [Sent" and the owner was told: "Cancelling all your recurring
 *      investments on ibkr [Sent is still to do."
 *   2. Every display that titles a job with its command — the dashboard's
 *      approval cards, its RECENT list — showed two lines of provenance where
 *      the ask should be.
 *
 * policyRouter.js hit the same wall earlier (the trailer defeated its ^…$
 * anchors and every "what time is it" from the extension paid for a planner
 * turn) and solved it privately. `stripContextTrailer` below is that solution,
 * moved here so the three callers share one definition of the shape rather than
 * each growing their own regex.
 *
 * ---------------------------------------------------------------------------
 * THE REAL FIX, AND WHY THE TRAILER STILL ARRIVES
 *
 * /plan now takes a first-class `context`, so a caller need not smuggle
 * anything through the text. But an extension that stopped sending the trailer
 * would go silent about the page against every agent older than this file, so
 * it sends BOTH — and `prepareCallerContext` strips the now-redundant trailer
 * on the way in.
 *
 * That is exactly what attachments.js already does with " [attached: …]", for
 * exactly this reason: "when the array is present the redundant suffix is
 * stripped from the command so the model sees each path exactly once". Same
 * problem, same shape, deliberately.
 */

/* A URL is for a prompt and a display, not for fetching; these are sanity
 * bounds, not security ones. The extension scrubs before sending
 * (scrubPageContext) and this does not assume it did. */
const MAX_URL_CHARS = 500
const MAX_TITLE_CHARS = 160

/*
 * Strip only a trailing bracket block that OPENS on its own line after a blank
 * line and CLOSES at end of input. Anchoring both ends this tightly is what
 * keeps a legitimate inline "[note]" mid-command — or a command that simply
 * ends in a bracket — from being touched: the trailer's defining shape is the
 * blank line before a leading "[", which normal prose does not produce.
 *
 * Deliberately shape-based rather than matching "[Sent from the browser
 * extension". Any surface that appends its provenance this way gets the same
 * treatment, and the pendant or a future client does not have to be added to a
 * list of known prefixes to stop corrupting its own verdicts.
 */
export function stripContextTrailer(command) {
  return String(command ?? '')
    .replace(/\n\s*\n\[[\s\S]*\]\s*$/, '')
    .trimEnd()
}

/**
 * The wire shape, made safe to hold. Returns null when there is nothing usable,
 * so every caller can test one thing.
 *
 * Only http(s) pages survive. A caller that says it is looking at
 * `file:///Users/...` or a `chrome-extension://` page is describing something
 * the planner cannot act on and should not be repeating into a prompt.
 */
export function normalizeCallerContext(raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null

  const page = raw.page && typeof raw.page === 'object' ? raw.page : null
  if (!page) return null

  const url = String(page.url ?? '').trim().slice(0, MAX_URL_CHARS)
  if (!url) return null
  try {
    if (!['http:', 'https:'].includes(new URL(url).protocol)) return null
  } catch {
    return null
  }

  const title = String(page.title ?? '')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, MAX_TITLE_CHARS)

  const surface = String(raw.surface ?? '').replace(/[^a-z0-9 _-]/gi, '').trim().slice(0, 60)

  return { page: { url, ...(title ? { title } : {}) }, ...(surface ? { surface } : {}) }
}

/**
 * The block the planner reads, travelling the same way the attachments block
 * does: appended to context.promptBlock, which llmPlanner sends ahead of
 * "Current request:".
 *
 * The last line is the one that earns its place. Without it a planner treats
 * "the page the owner is on" as "the page this task is about", which is how a
 * command that named a different site entirely got planned against whatever
 * tab happened to be in front.
 */
export function callerContextPromptBlock(context) {
  const normalized = normalizeCallerContext(context)
  if (!normalized) return ''

  const { url, title } = normalized.page
  const where = normalized.surface
    ? `The request came from ${normalized.surface}.`
    : 'The request came from a browser surface.'

  return [
    `${where} The owner was looking at:`,
    `- ${title ? `"${title}" — ` : ''}${url}`,
    'This is where they were, not necessarily what the task is about. Use it only when the request points at it ("this page", "here", "summarize this"); when the request names somewhere else, go there instead.',
  ].join('\n')
}

/**
 * Settle command + caller context together, the way prepareAttachments settles
 * command + files.
 *
 * When context arrived first-class, the text trailer that carried the same
 * thing is redundant and is removed — so the model sees the page exactly once,
 * in its own labelled block, and everything downstream that reads `command` as
 * a sentence gets a sentence.
 */
export function prepareCallerContext({ command, context } = {}) {
  const normalized = normalizeCallerContext(context)
  const text = String(command ?? '')
  return {
    command: normalized ? stripContextTrailer(text) : text,
    context: normalized,
    promptBlock: normalized ? callerContextPromptBlock(normalized) : '',
  }
}

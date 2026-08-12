/*
 * The brain this node did not have.
 *
 * THE GAP THIS CLOSES. affinity.js already routed EXECUTION here — a plan whose
 * every step is browser work runs in front of the owner's signed-in tabs
 * instead of on a Mac across the room. But the thinking still happened
 * elsewhere: every command went to the Mac's POST /plan first, so a browser
 * that was awake, signed in and looking at the page still could not act unless
 * a laptop somewhere was also awake. The owner, 2026-08-09, on being told there
 * was no brain here: "it needs one."
 *
 * WHERE THE THINKING HAPPENS. Not in this extension, and not against a key it
 * holds — POST /v1/infer on the relay (cloud-relay/nodeInference.js). The
 * upstream credential never leaves the relay, the model comes from server
 * config behind an allow-list, and the route is metered per device. The
 * `browser_node` role already grants `llm:infer` (cloud-relay/deviceAuth.js),
 * so this needs no new scope and no re-pair: it is a capability the credential
 * has been carrying unused.
 *
 * WHAT IS PURE HERE. Everything: the tool catalogue, the prompt, the request
 * descriptor, the reply parser, the transcript and its bounds, and how a relay
 * failure is read. background.js owns the loop and the effects, exactly the
 * split relay-peer.js and affinity.js use — so the whole policy is assertable
 * in plain node with no network and no browser.
 *
 * THREE RULES THIS FILE ENFORCES, because they are the ones that turn an agent
 * loop into an agent loop you can leave alone with someone's brokerage account:
 *
 *   1. THE MODEL MAY ONLY ASK FOR VERBS THAT EXIST. The tool list is derived
 *      from bridge-core's COMMAND_TYPES, not typed out beside it. A model
 *      asking for a verb validateCommand rejects is a loop that burns its whole
 *      step budget on errors, and hand-maintained lists drift.
 *   2. THE MODEL NEVER DECIDES WHAT RAN. Its answer is colour; the verdict is
 *      computed from the ledger by affinity.honestVerdict. Same rule that file
 *      already states, extended to the one caller that would most like to
 *      break it.
 *   3. THE MODEL NEVER GETS PAST AN OUTWARD STEP UNATTENDED. affinity's
 *      createOutwardGuard was written for this loop and had no caller until
 *      now; it is the gate, and "submit the order" parks whatever the model
 *      believes about it.
 */
import { COMMAND_TYPES } from './bridge-core.js'
import {
  MEMORY_TOOL_SPECS,
  MEMORY_TOOL_TYPES,
  isMemoryToolType,
} from '../../shared/domains/index.js'

/* ===================================================================== *
 * Bounds.
 *
 * Every one of these is under a relay ceiling rather than equal to it.
 * normalizeInferMessages REJECTS an over-budget prompt rather than trimming
 * it ("a prompt silently cut in half produces a confident answer to a question
 * nobody asked"), so a transcript that grows into the ceiling does not degrade,
 * it 400s mid-task. The headroom is the point.
 * ===================================================================== */

/* Relay ceiling 40. */
export const BRAIN_MAX_MESSAGES = 30
/* Relay ceiling 24_000 characters across all messages. */
export const BRAIN_MAX_TRANSCRIPT_CHARS = 17_000
/*
 * How many tool calls one command may make before the loop stops and reports
 * what it did. Not a safety limit — the outward guard is that — but a cost and
 * patience limit: a model looping on a page it cannot read should say so
 * rather than spend twelve inferences discovering it again.
 */
export const BRAIN_MAX_STEPS = 12

/*
 * ASKED FOR EXPLICITLY, and this is the trap the relay documents in its own
 * source: maxTokens DEFAULTS to 512, not to the 2048 ceiling, and combined
 * with responseFormat:'json_object' a caller that omits it gets an object that
 * stops mid-brace. Every layer downstream then reports "malformed model
 * response" for what is really a budget the caller never set.
 */
export const BRAIN_OUTPUT_TOKENS = 900

/* A single tool result, trimmed before it ever reaches the transcript. */
const MAX_RESULT_CHARS = 2_000
/* Snapshots are the big one: 80 elements of raw DOM detail is most of the
 * prompt budget for a list the model reads three fields of. */
const MAX_SNAPSHOT_ELEMENTS = 45

/* ===================================================================== *
 * The tool catalogue.
 * ===================================================================== */

/*
 * One line per verb, keyed by the SAME strings bridge-core validates. The
 * export below asserts the two sets match, so adding a command type without
 * describing it here — or describing one that does not exist — fails a test
 * instead of confusing a model at runtime.
 *
 * The descriptions are written for a reader who cannot see the page: they say
 * what the verb does to the world, not what it is implemented with.
 */
const TOOL_DESCRIPTIONS = Object.freeze({
  activate_tab:
    'Focus the tab already showing a site, opening it only if none is open. params: {urlContains?, url?}. USE THIS to reach a site rather than navigate — it keeps the owner\'s signed-in session and does not clobber the page they were on.',
  navigate:
    'Point the current tab at a URL, replacing what it was showing. params: {url, newTab?}.',
  snapshot:
    'List the interactive elements on the page with a `ref` for each. params: {maxElements?}. Call this before any click/type/select: refs come from here and are the only reliable way to address an element.',
  read_page:
    'Read the page text. params: {mode?: "text"|"main_text"|"html"|"forms"|"landmarks", maxChars?}.',
  click: 'Click one element. params: {ref} from a snapshot, or {selector}.',
  type: 'Type into a field. params: {ref|selector, text, submit?}. submit:true files the form in the same breath — do not set it unless the owner asked to submit.',
  select: 'Choose an option in a <select>. params: {ref|selector, value|label}.',
  scroll: 'Scroll the page or an element. params: {ref|selector?, direction?, amount?}.',
  press_key: 'Press one key. params: {key}. Enter submits whatever form has focus.',
  wait_for:
    'Wait for something to appear before continuing. params: {selector?, textContains?, timeoutMs?}.',
  list_tabs: 'List the open tabs and their URLs. params: {}.',
  capture: 'Screenshot the visible tab. params: {}. Costly — prefer snapshot.',
})

/*
 * The two memory verbs, described from the SAME shared specs the Mac planner
 * and the relay's voice loop read (shared/domains/index.js), so the three
 * brains cannot drift on names or argument shapes. These verbs run ON THE
 * RELAY via the device credential, not in the page — the catalogue only tells
 * the model what they are for; console-engine.js does the fetching.
 *
 * The param hint is DERIVED from the spec's params block rather than typed
 * beside it, for the same reason BRAIN_TOOLS derives from COMMAND_TYPES:
 * hand-maintained copies drift. A param whose spec description starts with
 * "optional" gets the `?` suffix the executor descriptions use.
 */
function memoryParamHint(spec, { omit = [] } = {}) {
  const keys = Object.keys(spec.params).filter((key) => !omit.includes(key))
  return `params: {${keys
    .map((key) => (/^optional/i.test(spec.params[key]) ? `${key}?` : key))
    .join(', ')}}`
}

export const BRAIN_LOCAL_TOOLS = Object.freeze(
  MEMORY_TOOL_TYPES.map((type) => {
    const spec = MEMORY_TOOL_SPECS[type]
    /* `scope` is omitted from memory_save's hint on purpose: this browser has
     * no local durable store, so console-engine pins every save to scope
     * 'hive' whatever the model asks for. Offering the knob would be a lie. */
    const omit = type === 'memory_save' ? ['scope'] : []
    const trailer =
      type === 'memory_save'
        ? ' On this node every save is shared with the hive — there is no browser-local store.'
        : ''
    return Object.freeze({
      type,
      description: `${spec.description} ${memoryParamHint(spec, { omit })}.${trailer}`,
      /* The loop branches on this: a local:true call goes to the relay's
       * memory routes, never to the page executor. */
      local: true,
    })
  }),
)

/** The verbs offered to the model: the executor's own, plus the memory pair. */
export const BRAIN_TOOLS = Object.freeze([
  ...[...COMMAND_TYPES].map((type) => ({
    type,
    description: TOOL_DESCRIPTIONS[type] ?? '',
  })),
  ...BRAIN_LOCAL_TOOLS,
])

/**
 * Verbs the executor accepts that nobody described, and descriptions for verbs
 * that do not exist. Exported so a test asserts it is empty rather than a
 * reader having to notice. Memory verbs are legitimate non-executor names, so
 * `unknown` excuses exactly them and nothing else.
 */
export function toolCatalogueDrift() {
  const described = new Set([
    ...Object.keys(TOOL_DESCRIPTIONS),
    ...BRAIN_LOCAL_TOOLS.map((tool) => tool.type),
  ])
  return {
    undescribed: [...COMMAND_TYPES].filter((type) => !described.has(type)),
    unknown: [...described].filter(
      (type) => !COMMAND_TYPES.has(type) && !isMemoryToolType(type),
    ),
  }
}

/* ===================================================================== *
 * The prompt.
 * ===================================================================== */

/**
 * What the model is told it is.
 *
 * Written to be read alongside affinity.js, because the two halves have to
 * agree: the guard will park an outward step whatever the prompt says, so a
 * prompt that promised the model it could submit orders would only produce
 * confused models and wasted inferences. It is told the rule up front instead.
 */
export function brainSystemPrompt() {
  const tools = BRAIN_TOOLS.map((tool) => `- ${tool.type}: ${tool.description}`).join('\n')

  return `You are the browser node of a personal agent. You act INSIDE the owner's own browser, in their existing signed-in tabs, on their behalf.

Answer with ONE JSON object and nothing else. Exactly one of these four shapes:

  {"thought": "<one short line>", "tool": "<name>", "params": { ... }}
  {"thought": "<one short line>", "answer": "<what you found or did, for the owner>"}
  {"thought": "<one short line>", "handoff": "<why this needs the Mac and not a browser>"}
  {"thought": "<one short line>", "clarify": "<one question for the owner>"}

EVERY reply must carry one of "tool", "answer", "handoff" or "clarify". A reply with only
"thought" is not a reply — it does nothing, the task does not advance, and you
will simply be asked again.

Tools:
${tools}

How to work:
- Look before you act. snapshot gives you refs; click/type/select need one.
- Use activate_tab to reach a site. The owner is already signed in there; navigate replaces the page they were looking at.
- One tool per reply. You will be given its result and asked again.
- If a step fails twice the same way, stop and answer with what you learned.

The owner's memory:
- memory_lookup and memory_save run on the relay, not on the page. Use them for the owner's durable facts, never for page contents.
- Consult memory_lookup BEFORE acting when the request depends on WHICH account, site or list the owner means — "check my email" with two known accounts is a lookup first, not a guess.
- Save only durable identities and connections with memory_save — an account, a default list, a site the owner names as theirs. Never page contents, never chat.

Use "clarify" ONLY when the request is genuinely ambiguous — the memories know
several candidates, the request names none of them, and no remembered default
settles it. One short question, then stop; the owner's reply arrives as a new
command. If memory_lookup (or the memory shown to you) can settle it, act
instead of asking. clarify is for ambiguity, never for permission — for outward
steps the rule below applies.

About steps that commit something outward — submit, buy, sell, cancel, send,
delete, subscribe, sign:
- KEEP GOING AND CALL THE TOOL ANYWAY when you reach one. The system stops it
  for you and asks the owner to approve it. That is the design, and it is not
  your job to do it instead.
- So do not stop early to describe what you would have done, and do not ask the
  owner for permission yourself — that is what stopping early looks like from
  here, and it leaves the task neither done nor asked.
- Never disguise such a step as a different one to get past the check.

What you must not do:
- Do not claim you did something you did not do. If you only opened and read pages, say exactly that. The system computes what actually happened from a ledger of executed steps and will contradict you.
- If the task needs anything outside a browser — files, shell, native apps, other machines — use handoff and say so. Do not improvise.

Answer with the JSON object only. No prose, no code fences.`
}

/* ===================================================================== *
 * The request.
 * ===================================================================== */

/**
 * A /v1/infer descriptor, in the same shape relay-peer.js builds for every
 * other relay call, so background.js's relayFetch carries it and the token
 * still never appears in this module.
 */
export function inferRequest(config, messages, { maxTokens = BRAIN_OUTPUT_TOKENS } = {}) {
  return {
    method: 'POST',
    path: '/v1/infer',
    auth: 'device',
    body: {
      messages,
      maxTokens,
      /* The relay passes this to the provider as response_format. Paired with
       * the explicit maxTokens above — never one without the other. */
      responseFormat: 'json_object',
    },
  }
}

/* ===================================================================== *
 * The memory requests.
 *
 * Pure descriptors in the same shape as inferRequest, carried by the caller's
 * relayFetch so the device token never appears in this module. These target
 * the relay's domain-memory routes (GET/POST /v1/memory/domains), which the
 * browser_node role reaches with the memory:domains:read/write scopes it
 * already holds.
 * ===================================================================== */

/** GET the owner's remembered facts — for one domain, or matched by query. */
export function memoryLookupRequest({ domain = '', query = '', limit = 0 } = {}) {
  const search = new URLSearchParams()
  const domainName = String(domain ?? '').trim()
  if (domainName) search.set('domain', domainName)
  /* Queries are owner phrasing, not data: cap them so a long command pasted
   * as a query cannot bloat the URL. Never the device token — auth rides the
   * header, exactly like every other descriptor. */
  const words = String(query ?? '').trim().slice(0, 200)
  if (words) search.set('query', words)
  const cap = Math.floor(Number(limit) || 0)
  if (cap > 0) search.set('limit', String(cap))
  const qs = search.toString()
  return {
    method: 'GET',
    path: `/v1/memory/domains${qs ? `?${qs}` : ''}`,
    auth: 'device',
  }
}

/**
 * POST one fact into the hive's domain memory.
 *
 * SCOPE IS PINNED TO 'hive', whatever the model asked for: this browser has no
 * local durable store, so a node-scoped fact saved here would be a fact saved
 * nowhere — and the hive rejects node-scoped facts anyway. `node` names the
 * author for provenance, not the storage location.
 */
export function memorySaveRequest(node, { domain, name, value } = {}) {
  return {
    method: 'POST',
    path: '/v1/memory/domains',
    auth: 'device',
    body: {
      node: String(node ?? '').trim(),
      facts: [
        {
          domain: String(domain ?? '').trim(),
          name: String(name ?? '').trim(),
          value: String(value ?? '').trim(),
          scope: 'hive',
        },
      ],
    },
  }
}

/**
 * What the model is shown of a memory tool's outcome — compact on purpose,
 * like compactToolResult one section down: the transcript budget is for the
 * task, not for echoing the relay's envelope back at the model.
 */
export function compactMemoryResult(type, params = {}, payload = null) {
  if (type === 'memory_save') {
    const accepted = Number(payload?.accepted) || 0
    const rejected = Number(payload?.rejected) || 0
    const key = `dom.${params?.domain ?? '?'}.${params?.name ?? '?'}`
    if (accepted > 0) return `Saved ${key} (hive).`
    return `The hive did not keep ${key}${rejected ? ` (${rejected} rejected)` : ''} — check the domain and the dotted name.`
  }

  const lines = Array.isArray(payload?.lines)
    ? payload.lines.filter(Boolean).map((line) => String(line))
    : []
  if (!lines.length) {
    const where = String(params?.domain ?? '').trim()
    return `No remembered facts${where ? ` in ${where}` : ''} matched.`
  }
  return clip(`${lines.length} remembered fact(s):\n${lines.join('\n')}`)
}

/* ===================================================================== *
 * Reading the relay's answer.
 * ===================================================================== */

/**
 * Why a /v1/infer call failed, and whether the brain should stop trying.
 *
 * KEYED ON THE PRESENCE OF `retryAfter`, NOT ON STATUS CODES. The relay states
 * this as a contract in nodeInference.js: `retryAfter` is DEVICE-SCOPED and
 * means "this device should not ask this relay again before then" — never
 * "this request was unlucky". So a reason the relay adds later (a third one
 * beyond rate_limited and not_configured) is honoured here with no change,
 * which is the whole point of reading the field instead of the number.
 *
 * `fatal` is different: a request this device must not repeat AS WRITTEN
 * (a bad model name, an over-budget prompt). Retrying is pointless but the
 * brain is not broken, so the command hands off rather than the peer parking.
 */
export function describeInferFailure(error) {
  const status = Number(error?.status) || 0
  const code = String(error?.code || '')
  const retryAfter = Number(error?.retryAfter) || 0
  const message = error?.message || String(error ?? 'The relay refused the request.')

  if (retryAfter > 0) {
    return {
      message,
      code,
      status,
      retryAfter,
      /* Park the whole brain, not this command: the relay is telling this
       * DEVICE to stop asking. */
      parkBrain: true,
      fatal: false,
    }
  }

  const fatal =
    status === 400 ||
    ['invalid_request', 'invalid_messages', 'prompt_too_large', 'model_not_allowed'].includes(code)

  return { message, code, status, retryAfter: 0, parkBrain: false, fatal }
}

/**
 * Is this a usable answer at all?
 *
 * `complete` is a TRI-STATE and null means the provider said nothing about how
 * it stopped — which is not the same as "it stopped badly", so null passes. A
 * caller that checked only `truncated` would read a content-filtered
 * non-answer (short content, truncated:false) as a real one; that is the same
 * bug one field over, which is why `complete` exists and is checked here.
 */
export function readInferPayload(payload) {
  if (payload?.refusal) {
    return { ok: false, error: `The model declined: ${String(payload.refusal).slice(0, 300)}` }
  }
  if (payload?.truncated) {
    return {
      ok: false,
      error:
        'The model ran out of output budget mid-answer, so its reply is not valid JSON. The step was not run.',
    }
  }
  if (payload?.complete === false) {
    return {
      ok: false,
      error: `The model stopped abnormally (${String(payload?.finishReason || 'unknown')}), so its reply cannot be trusted.`,
    }
  }
  const content = String(payload?.content ?? '').trim()
  if (!content) return { ok: false, error: 'The model returned an empty reply.' }
  return { ok: true, content }
}

/**
 * The model's JSON turn, read into something the loop can act on.
 *
 * Tolerant of exactly one thing — a fenced code block — because models emit
 * them under json_object often enough that refusing would cost a step for no
 * safety gain. Everything else is strict: an unknown tool, a missing params
 * object or a shapeless reply is an error the loop feeds BACK to the model, so
 * it corrects rather than the command dying on a typo.
 */
export function parseBrainReply(content) {
  const text = String(content ?? '')
    .trim()
    .replace(/^```(?:json)?\s*/i, '')
    .replace(/\s*```$/, '')
    .trim()

  let value
  try {
    value = JSON.parse(text)
  } catch {
    return { kind: 'error', error: 'Your reply was not valid JSON. Answer with one JSON object.' }
  }
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    return { kind: 'error', error: 'Your reply must be a single JSON object.' }
  }

  const thought = String(value.thought ?? '').slice(0, 300)

  if (value.handoff) {
    return { kind: 'handoff', thought, reason: String(value.handoff).slice(0, 500) }
  }

  /*
   * The fourth shape: a question, used only when the request is genuinely
   * ambiguous. Capped like a thought, not like an answer — a clarification
   * that needs more than one line is the model narrating, not asking.
   */
  if (value.clarify != null) {
    return { kind: 'clarify', thought, question: String(value.clarify).slice(0, 300) }
  }

  if (value.tool != null) {
    const type = String(value.tool).trim()
    const params = value.params
    if (params != null && (typeof params !== 'object' || Array.isArray(params))) {
      return { kind: 'error', error: 'params must be a JSON object.' }
    }
    /* A memory verb is a valid call that must NOT reach the page executor:
     * local:true tells the loop to run it against the relay instead. */
    if (isMemoryToolType(type)) {
      return { kind: 'call', thought, call: { type, params: params ?? {} }, local: true }
    }
    if (!COMMAND_TYPES.has(type)) {
      return {
        kind: 'error',
        error: `"${type}" is not a tool. Use one of: ${[...COMMAND_TYPES, ...MEMORY_TOOL_TYPES].join(', ')}.`,
      }
    }
    return { kind: 'call', thought, call: { type, params: params ?? {} } }
  }

  if (value.answer != null) {
    return { kind: 'answer', thought, answer: String(value.answer).slice(0, 2_000) }
  }

  return {
    kind: 'error',
    error: 'Your reply had none of "tool", "answer", "handoff" or "clarify". Answer with one of the four shapes.',
  }
}

/* ===================================================================== *
 * What the model is shown of a result.
 * ===================================================================== */

/**
 * One executed step, compacted for the transcript.
 *
 * Two jobs. The obvious one is size: a raw snapshot of a real page is 80
 * elements of bounds, selectors, hrefs and tags — most of the prompt budget
 * for three fields the model actually addresses elements by. The other is
 * FIDELITY: what goes in here is the post-sanitizeExtraction result, the same
 * text that would have crossed to the Mac, so a password field arrives as a
 * withheld field rather than as its contents. This function only shortens; it
 * is never the thing that makes a result safe.
 */
export function compactToolResult(type, result) {
  if (!result || typeof result !== 'object') return String(result ?? 'done')

  if (Array.isArray(result.elements)) {
    const total = result.elements.length
    const shown = result.elements.slice(0, MAX_SNAPSHOT_ELEMENTS).map((element) => {
      const parts = [
        `${element?.ref ?? '?'}`,
        element?.role ? `<${element.role}>` : '',
        element?.name ? `"${String(element.name).slice(0, 80)}"` : '',
        element?.sensitivity && element.sensitivity !== 'normal'
          ? `[${element.sensitivity} — contents withheld]`
          : '',
        element?.disabled ? '[disabled]' : '',
      ]
      return parts.filter(Boolean).join(' ')
    })
    const header = `${result.title ? `${result.title} — ` : ''}${result.url ?? ''}`.trim()
    const more = total > shown.length ? `\n… ${total - shown.length} more element(s) not shown` : ''
    return clip(`${header}\n${total} interactive element(s):\n${shown.join('\n')}${more}`)
  }

  if (Array.isArray(result.tabs)) {
    return clip(
      `${result.tabs.length} tab(s):\n${result.tabs
        .map((tab) => `- ${truncate(tab?.title, 60)} — ${truncate(tab?.url, 120)}`)
        .join('\n')}`,
    )
  }

  if (typeof result.content === 'string' && result.content) {
    const header = `${result.title ? `${result.title} — ` : ''}${result.url ?? ''}`.trim()
    return clip(`${header}\n${result.content}`)
  }

  const message = String(result.message ?? 'done')
  const where = result.url ? ` (${truncate(result.url, 120)})` : ''
  return clip(`${message}${where}`)
}

function truncate(value, max) {
  const text = String(value ?? '').replace(/\s+/g, ' ').trim()
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`
}

function clip(text, max = MAX_RESULT_CHARS) {
  const value = String(text ?? '').trim()
  if (value.length <= max) return value
  return `${value.slice(0, max - 1)}…\n[trimmed — ask for a narrower read if you need more]`
}

/* ===================================================================== *
 * The transcript.
 * ===================================================================== */

/**
 * The conversation, kept inside the relay's ceilings BY CONSTRUCTION.
 *
 * The system message and the owner's original ask are pinned: they are the
 * task, and a transcript that drops them to fit is a loop that forgets what it
 * was doing. Everything else is a sliding window over the tool exchange —
 * oldest results fall out first, and the fact that they did is stated in the
 * transcript rather than left for the model to infer from a gap.
 */
export function createBrainTranscript({ command, page = null, memoryLines = [], now = Date.now() } = {}) {
  const system = { role: 'system', content: brainSystemPrompt() }

  /*
   * The page rides as its own labelled block, NOT appended to the owner's
   * sentence. The Mac path has to inline it — POST /plan has no context field
   * and the command text is its only channel — and the cost of that shows up
   * downstream as trailers spliced into verdict sentences. Nothing forces it
   * here, so nothing does it here.
   *
   * The owner's domain memory rides the same way, and it is PINNED with the
   * command rather than pushed as a sliding result: it is the task's
   * grounding ("which account does 'my email' mean"), and grounding that
   * falls out of the window mid-task is how a brain re-asks a question the
   * owner already answered. Bounded at the source — the caller fetches with a
   * small limit — and clipped here so a fat fact list can never eat the
   * pinned budget the fit() loop cannot reclaim.
   */
  const grounding = (Array.isArray(memoryLines) ? memoryLines : [])
    .filter(Boolean)
    .map((line) => String(line))
    .slice(0, 12)
  const opening = [
    `The owner asked: ${String(command ?? '').trim()}`,
    page?.url ? `\nThey are currently looking at: ${page.title ? `"${page.title}" — ` : ''}${page.url}` : '',
    grounding.length
      ? `\nWhat the owner's memory says (domain memory):\n${clip(grounding.join('\n'))}`
      : '',
    `\nStarted at ${new Date(now).toISOString()}.`,
  ]
    .filter(Boolean)
    .join('')

  const user = { role: 'user', content: opening }
  let turns = []
  let dropped = 0

  const fit = () => {
    /* Trim until BOTH ceilings are satisfied. Two turns at a time — an
     * assistant reply and the result it produced are one exchange, and half an
     * exchange reads as the model being answered about nothing. */
    for (;;) {
      const messages = [system, user, ...turns]
      const chars = messages.reduce((total, message) => total + message.content.length, 0)
      if (
        messages.length <= BRAIN_MAX_MESSAGES &&
        chars <= BRAIN_MAX_TRANSCRIPT_CHARS
      ) {
        return
      }
      if (!turns.length) return
      turns = turns.slice(2)
      dropped += 1
    }
  }

  return {
    /** What to send now. */
    messages() {
      fit()
      const notice = dropped
        ? [
            {
              role: 'user',
              content: `[${dropped} earlier step(s) were dropped from this transcript to stay within limits. Do not assume they succeeded — if you need something from them, look again.]`,
            },
          ]
        : []
      return [system, user, ...notice, ...turns]
    },

    /** The model's own turn, verbatim, so it can see what it said. */
    pushAssistant(content) {
      turns.push({ role: 'assistant', content: String(content ?? '') })
    },

    /** What running its tool produced — or why nothing ran. */
    pushResult(text) {
      turns.push({ role: 'user', content: String(text ?? '') })
    },

    /** Diagnostics for the run record, not for the model. */
    stats() {
      const messages = [system, user, ...turns]
      return {
        messages: messages.length,
        chars: messages.reduce((total, message) => total + message.content.length, 0),
        dropped,
      }
    },
  }
}

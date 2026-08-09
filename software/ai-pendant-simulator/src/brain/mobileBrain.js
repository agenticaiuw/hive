/*
 * The brain that lives on the phone.
 *
 * Before this file, the iOS app had two ways to answer anything: src/agent.js,
 * a regular expression that recognises three sentence shapes and calls the rest
 * "I could not understand the task", or a round trip to the Mac. The second is
 * the one that mattered, and it fails exactly when the phone matters — lid shut,
 * laptop asleep, owner out of the house. A node whose only skill is forwarding
 * is not a node.
 *
 * So: a perceive–act loop that runs IN the app, reasons with a model reached
 * through the relay (relayInference.js — the phone never holds an API key), and
 * acts through the phone's own dispatch table (mobileTools.js). The Mac is one
 * tool among several rather than the whole plan, and when it is asleep the loop
 * carries on with the ones that do not need it.
 *
 * THREE THINGS THIS DELIBERATELY DOES NOT DO.
 *
 * 1. It does not hardcode a capability list into the prompt. Every line the
 *    model reads about what the phone can do is rendered from the dispatch
 *    table by mobileDiscovery.js, filtered by the scopes the live credential
 *    actually holds. Add a tool, and it is in the prompt; revoke a scope, and
 *    it leaves.
 * 2. It has no per-tool guardrails. There is no allow list, no confirm table,
 *    no read-only/write split. Every tool is enabled and the model calls it.
 *    The only permission rule is a paragraph of prompt, and it is about the
 *    OWNER'S REQUEST as the unit of authorization: do what they asked, ask only
 *    before going beyond it. This mirrors local-agent/llmPlanner.js, which was
 *    rewritten this way on purpose.
 * 3. It does not ask the model to hold the whole library in its head. The
 *    catalogue drills down and the model can ask for a shelf it was not given.
 *
 * WHAT BOUNDS THE BLAST RADIUS. Not restriction — revocation. The phone acts
 * with a `mobile` credential that includes mac:execute, and the answer to a
 * stolen phone is one click in the Hive dashboard, after which the very next
 * request with that token is refused. That trade was made deliberately; see the
 * revoke path in hive-dashboard/server.mjs.
 */
import {
  buildMobileCatalogue,
  domainsExcept,
  normalizeDomains,
  renderDomainCatalog,
  renderFullSchema,
  renderToolSchemas,
  toolsForDomains,
} from './mobileDiscovery.js'
import { INFERENCE_LIMITS, parseModelJson } from './relayInference.js'
import { runMobileTool, summariseToolResult } from './mobileTools.js'

/*
 * Ship the whole schema when it is this small, and drill down when it is not.
 *
 * The Mac drills down because its flat schema is 28,120 characters on every
 * turn, including the turns that needed one tool. The phone's whole schema is a
 * fraction of that today — measured, not assumed: mobileBrain.test.js asserts
 * the real number and fails if it crosses this line. Below the budget, a
 * discovery pre-pass would buy nothing and cost a round trip on a device that
 * is often on a phone network. Above it, the machinery is already here.
 *
 * RAISED FROM 6000 TO 8000 when the `mesh` domain landed and the measured
 * schema went 4,639 → 6,556. This is the deliberate choice the old ceiling's
 * failure message asked for, not a number nudged until a test passed, so the
 * arithmetic is here to be argued with: crossing the budget costs one extra
 * model round trip on EVERY command — the discovery pre-pass — and on cellular
 * that is a second or two the owner watches. Staying under it costs ~1,900
 * extra prompt characters, roughly 500 tokens, on every turn. At this size the
 * round trip is worth far more than the tokens. That stops being true somewhere
 * near the Mac's 28k, which is why this is a ceiling and not an `Infinity`.
 */
export const PROMPT_SCHEMA_BUDGET = 8000

/* How many shelves the discovery pre-pass may open at once. */
const DISCOVERY_DOMAIN_LIMIT = 3

/* Enough thread for "do that again on the other one" to land somewhere. */
const DISCOVERY_CONTEXT_CHARS = 800

export const DEFAULT_MAX_STEPS = 6

/* ------------------------------------------------------------ the prompts */

/*
 * The working rules, as entries rather than one block, so a rule travels with
 * the tool it talks about. `needs` is the tools a rule names; the rule ships
 * only when at least one of them did. Without this, a phone paired to a
 * narrower role would be told to "check mac_status first" while holding no
 * mac_status — a prompt advertising a capability the credential was refused,
 * which is the exact failure this whole design is built to make impossible.
 * A rule with no `needs` is about working, not about tools, and always ships.
 */
const WORKING_RULES = [
  {
    text: '- Look before you act. If you do not know something about the phone or the hive, there is a tool that tells you; guessing at battery, location, time or whether the Mac is up is never better than one call.',
  },
  { text: '- Prefer few steps. Two tools that answer the question beat five that circle it.' },
  {
    text: '- Check mac_status before leaning on the Mac, and when it is offline, solve what you can with the tools that do not need it. "Your Mac is asleep, but here is what I could get" is a good answer; silently waiting is not.',
    needs: ['mac_status'],
  },
  {
    text: '- When you delegate to the Mac, send ONE plain-English instruction and let it plan. It has a far larger tool library than you and you do not have its list — do not try to name its tools or spell out its steps.',
    needs: ['mac_run', 'mac_preview'],
  },
  {
    text: '- Your final answer is spoken automatically. Do not also call speak with it.',
    needs: ['speak'],
  },
  /*
   * The one mesh fact most likely to produce a confidently wrong sentence to
   * the owner. `observed:false` is the relay saying "I could not ask that
   * node's hub", and it is returned by the SAME shape as a real disconnection —
   * connected:false, sockets:0. A model reading only `connected` will report a
   * healthy node as dead, and the owner has no way to tell that apart from the
   * truth. It rides as a rule rather than in mesh_presence's description
   * because it is an instruction about what to SAY, not about what the tool
   * does.
   */
  {
    text: '- On mesh_presence, "observed": false means the relay could not reach that node to ask — it does NOT mean the node is offline. Never tell the owner a node is down on that basis; say you could not check.',
    needs: ['mesh_presence'],
  },
  {
    text: '- A mesh message that is queued rather than delivered is not a failure: the relay holds it until that node connects. Say it is waiting, not that it failed.',
    needs: ['mesh_send'],
  },
  {
    text: '- Speak like a person talking to someone holding a phone. Short sentences. No markdown, no bullet lists, no headings — "say" is read aloud.',
  },
  {
    text: '- If a tool fails, read the error and choose differently. One retry of the same call with the same arguments is a wasted turn.',
  },
]

/**
 * The system prompt for one turn of the loop.
 *
 * Exported because the size and content of this string IS the result — a test
 * that measures a reconstruction of it measures nothing.
 *
 * @param toolNames the tools actually in `schemaText`, for rule filtering. Null
 *                  means "unknown", and every rule ships.
 */
export function buildBrainSystemPrompt({
  schemaText,
  toolNames = null,
  otherDomains = [],
  blocked = [],
  situation = '',
} = {}) {
  const loaded = Array.isArray(toolNames) ? new Set(toolNames) : null
  const rules = WORKING_RULES.filter(
    (rule) => !rule.needs || !loaded || rule.needs.some((tool) => loaded.has(tool)),
  )
    .map((rule) => rule.text)
    .join('\n')
  const withheld = (otherDomains || []).filter(Boolean)
  const drillDown = withheld.length
    ? `\n\nTool domains NOT loaded for this request: ${withheld.join(', ')}.
If nothing above can do the job, do NOT answer "unsupported" — answer {"status":"need_tools","domains":["<domain>"]} and those tools will be handed to you.`
    : ''

  /* Not a capability list: a status line about what this phone's credential was
   * refused, so "I can't" can name the reason instead of being a shrug. */
  const blockedLine = blocked.length
    ? `\n\nWithheld from this phone by its own credential (missing relay scope): ${blocked
        .map((entry) => `${entry.name} (${entry.missing.join(', ')})`)
        .join('; ')}. If one of these is what the owner needs, say so plainly and tell them to re-pair the phone with a wider role from the Hive dashboard.`
    : ''

  return `You are the reasoning layer that runs ON the owner's iPhone. You are not a router and not a front end for the Mac — you are one of four nodes in this hive, and right now you are the one that is awake. The Mac may be asleep, out of the house, or lid-shut.

${situation}

Return ONLY valid JSON:
{
  "status": "act" | "done" | "need_tools" | "unsupported",
  "say": "what to tell the owner — the answer when done, a short progress line when acting",
  "actions": [ { "tool": "...", "label": "human readable step", "params": { ... } } ],
  "requiresConfirmation": true only if you are asking permission — omit it otherwise,
  "confirmReason": "when asking: what you want to do beyond the request, and why",
  "domains": ["..."] only when status is need_tools,
  "error": "only when unsupported"
}

When to use each status:
- "act": you want to run tools. Put them in "actions"; they run in order and you will see every result before your next turn.
- "done": you are answering. Put the answer in "say". This is the end of the turn and it is spoken to the owner.
- "need_tools": what you need is on a shelf you were not given.
- "unsupported": genuinely impossible from this phone, with the reason in "error".

Permission — you decide, not a rule table:
- The owner's request IS your authorization. Carry it out. Asking them to confirm the thing they just asked for is friction they pay on every turn for a decision they already made.
- Ask ONLY when a step goes beyond what they asked for: something you think would help but they did not request, or something hard to undo that the literal request does not cover. Then set "requiresConfirmation": true and say in "confirmReason" what the extra step is and why you want it, in one sentence, addressed to them.
- Asking is per-turn, so keep the extra step in "actions" and explain it — do not silently drop it, and do not smuggle it in.
- You are on a phone the owner is holding. Anything you do is visible to them and recorded. That is what buys you the benefit of the doubt; do not spend it on steps nobody asked for.

Tools you may call:
${schemaText}${drillDown}${blockedLine}

How to work:
${rules}`
}

/** The "what is true right now" block. Facts we already have, never guesses. */
export function describeSituation({
  now = new Date(),
  navigator: navigatorRef = globalThis.navigator,
  credential = null,
  platform = 'web',
} = {}) {
  const lines = [
    `Right now it is ${now.toString()} (${Intl.DateTimeFormat().resolvedOptions().timeZone ?? 'unknown time zone'}) on this phone.`,
    `The app is running on ${platform}.`,
  ]
  if (navigatorRef && typeof navigatorRef.onLine === 'boolean') {
    lines.push(
      navigatorRef.onLine
        ? 'The phone reports it has a network.'
        : 'The phone reports it has NO network: every tool that talks to the relay will fail, including the Mac. Say so rather than retrying.',
    )
  }
  if (credential?.role) {
    lines.push(`This phone is paired to the hive as role "${credential.role}".`)
  }
  return lines.join(' ')
}

/* --------------------------------------------------------------- the loop */

/**
 * Run the phone's brain over one command.
 *
 * @param command   what the owner said
 * @param infer     ({messages, maxTokens}) => {content, model, usage}
 * @param ctx       execution context handed to every tool (client, deviceId,
 *                  sessionId, speak, haptic, openUrl, navigator, platform)
 * @param scopes    the live credential's scopes, or null for unrestricted
 * @param onProgress({phase, message, ...}) — UI narration, never load-bearing
 * @param confirm   ({actions, reason}) => boolean. Called ONLY when the model
 *                  asks. There is no rule here that decides to call it.
 * @param maxSteps  how many act→observe rounds before the loop stops and says so
 *
 * → { status, say, steps, turns, usage, model }
 */
export async function runMobileBrain({
  command,
  infer,
  ctx = {},
  scopes = null,
  onProgress = null,
  confirm = null,
  maxSteps = DEFAULT_MAX_STEPS,
  /* Tunable so a test can force the drill-down path without waiting for the
   * roster to outgrow the budget on its own. */
  schemaBudget = PROMPT_SCHEMA_BUDGET,
  now = () => new Date(),
} = {}) {
  const request = String(command ?? '').trim()
  if (!request) throw new TypeError('runMobileBrain needs a command.')
  if (typeof infer !== 'function') throw new TypeError('runMobileBrain needs infer().')

  const catalogue = buildMobileCatalogue({ scopes })
  const usage = { calls: 0, promptChars: 0, completionChars: 0 }
  const steps = []
  let model = null

  /* Which shelves are on the table. Starts as everything when everything fits,
   * and widens when the model asks — never narrows behind its back. */
  let openDomains = null

  const situation = describeSituation({
    now: now(),
    navigator: ctx.navigator ?? globalThis.navigator,
    credential: ctx.credential ?? null,
    platform: ctx.platform ?? 'web',
  })

  const messages = [
    { role: 'system', content: '' },
    { role: 'user', content: request },
  ]

  const refreshSystemPrompt = () => {
    const toolNames = openDomains
      ? toolsForDomains(openDomains, { catalogue })
      : [...catalogue.tools.keys()]
    messages[0].content = buildBrainSystemPrompt({
      schemaText: renderToolSchemas(toolNames, { catalogue }),
      toolNames,
      otherDomains: openDomains ? domainsExcept(openDomains, { catalogue }) : [],
      blocked: catalogue.blocked,
      situation,
    })
  }

  /* Level 1 → level 3, only when the whole library will not fit. */
  const fullSchema = renderFullSchema({ catalogue })
  if (fullSchema.length > schemaBudget) {
    openDomains = await discoverDomains({ request, infer, catalogue, usage, onProgress })
  }
  refreshSystemPrompt()

  for (let step = 0; step < maxSteps; step += 1) {
    onProgress?.({ phase: 'thinking', step, message: step === 0 ? 'Thinking…' : 'Working…' })

    const answer = await callModel({ infer, messages, usage })
    model = answer.model ?? model
    messages.push({ role: 'assistant', content: answer.content })

    let decision
    try {
      decision = parseModelJson(answer.content)
    } catch (error) {
      /* Not fatal on the first stumble: hand the parse error back and let it
       * correct itself, which costs one turn and saves the whole request. */
      messages.push({
        role: 'user',
        content: `That was not valid JSON (${error.message}). Answer again with only the JSON object.`,
      })
      continue
    }

    const status = String(decision.status ?? '').toLowerCase()

    if (status === 'need_tools') {
      /* Asking can only ever WIDEN. `openDomains === null` already means every
       * shelf is on the table, so an ask there is the model not having read the
       * prompt — narrowing to what it named would take tools away as a reward
       * for asking for more. */
      if (openDomains === null) {
        messages.push({
          role: 'user',
          content:
            'Every tool this phone has is already in your system prompt — there is no other shelf. Use what is there, or answer with status "unsupported" and say what is missing.',
        })
        continue
      }

      const asked = normalizeDomains(decision.domains, {
        limit: DISCOVERY_DOMAIN_LIMIT,
        catalogue,
      })
      const widened = [...new Set([...openDomains, ...asked])]
      /* Nothing real was named, or nothing new: giving back the same prompt
       * would loop, so open everything and let it choose. */
      openDomains = widened.length > openDomains.length ? widened : null
      refreshSystemPrompt()
      onProgress?.({
        phase: 'discover_tools',
        message: openDomains ? `Opened: ${openDomains.join(', ')}` : 'Opened every tool',
      })
      messages.push({
        role: 'user',
        content: 'Those tools are now in your system prompt. Continue.',
      })
      continue
    }

    if (status === 'done' || status === 'instant') {
      const say = String(decision.say ?? decision.response ?? '').trim()
      onProgress?.({ phase: 'done', message: say })
      return { status: 'done', say, steps, turns: step + 1, usage, model }
    }

    if (status === 'unsupported') {
      const say = String(decision.say ?? decision.error ?? 'I could not do that from this phone.').trim()
      onProgress?.({ phase: 'unsupported', message: say })
      return { status: 'unsupported', say, error: decision.error ?? null, steps, turns: step + 1, usage, model }
    }

    const actions = Array.isArray(decision.actions) ? decision.actions : []
    if (!actions.length) {
      /* "act" with nothing to do is an answer wearing the wrong label. */
      const say = String(decision.say ?? '').trim()
      if (say) {
        onProgress?.({ phase: 'done', message: say })
        return { status: 'done', say, steps, turns: step + 1, usage, model }
      }
      messages.push({
        role: 'user',
        content: 'You said "act" but listed no actions. Either name the tools or answer with status "done".',
      })
      continue
    }

    if (decision.say) {
      onProgress?.({ phase: 'progress', message: String(decision.say).trim() })
    }

    /* The ONLY confirmation gate, and the model opened it. */
    if (decision.requiresConfirmation) {
      const reason = String(decision.confirmReason ?? decision.say ?? '').trim()
      onProgress?.({ phase: 'confirm', message: reason, actions })
      const approved = confirm ? await confirm({ actions, reason, command: request }) : false
      if (!approved) {
        messages.push({
          role: 'user',
          content:
            'The owner declined that. Do not run it. Either do the part they did actually ask for, or answer with status "done" explaining what you did not do.',
        })
        continue
      }
    }

    for (const action of actions) {
      onProgress?.({
        phase: 'tool',
        message: String(action.label || action.tool || 'step'),
        tool: action.tool,
      })
      const outcome = await runMobileTool(action.tool, action.params, ctx)
      steps.push({ label: action.label ?? null, ...outcome })
    }

    messages.push({
      role: 'user',
      content: `Tool results:\n${JSON.stringify(
        steps.slice(-actions.length).map((outcome) => ({
          tool: outcome.tool,
          ok: outcome.ok,
          ...(outcome.ok
            ? { result: summariseToolResult(outcome.result) }
            : {
                error: outcome.error,
                /* The relay's own code, when it sent one. Without it the model
                 * has only prose to distinguish "re-pair the phone and this
                 * works" from "re-pairing will not help", and those are
                 * different sentences to say to the owner. */
                ...(outcome.code ? { code: outcome.code } : {}),
              }),
        })),
      )}\n\nContinue. Answer with status "done" and the answer in "say" if you now have it.`,
    })
  }

  /* Out of steps. Say what happened rather than inventing a conclusion. */
  const ran = steps.filter((outcome) => outcome.ok).length
  const say = `I ran ${ran} step${ran === 1 ? '' : 's'} but did not finish that in ${maxSteps} rounds. Ask me for a smaller piece of it.`
  onProgress?.({ phase: 'exhausted', message: say })
  return { status: 'exhausted', say, steps, turns: maxSteps, usage, model }
}

/* --------------------------------------------------------------- internals */

/*
 * Keep the thread inside the relay's ceilings.
 *
 * The route refuses over-long requests rather than truncating them — 40
 * messages, 24,000 prompt characters — which is the right call at that end and
 * a lost turn at this one. A four-step loop over a big hive snapshot really can
 * cross the character cap, so the loop drops its OWN oldest observations first
 * and says in the thread that it did.
 *
 * What is never dropped: the system prompt (it is the tool schema) and the
 * owner's original request (it is the whole job). Everything between them is
 * working memory, and the newest of it is the part that matters.
 */
export function fitMessagesToBudget(
  messages,
  { maxMessages = INFERENCE_LIMITS.maxMessages, maxChars = INFERENCE_LIMITS.maxPromptChars } = {},
) {
  const size = (list) =>
    list.reduce((total, message) => total + String(message.content ?? '').length, 0)

  if (messages.length <= maxMessages && size(messages) <= maxChars) return messages

  const head = messages.slice(0, 2) // system + the owner's request
  const tail = messages.slice(2)
  const note = {
    role: 'user',
    content:
      '(Earlier tool results were dropped to stay inside this device\'s prompt budget. If you need one again, call the tool again.)',
  }

  let kept = tail
  while (
    kept.length &&
    (head.length + 1 + kept.length > maxMessages ||
      size([...head, note, ...kept]) > maxChars)
  ) {
    kept = kept.slice(1)
  }

  return kept.length ? [...head, note, ...kept] : head
}

async function callModel({ infer, messages, usage, maxTokens = 1200 }) {
  const fitted = fitMessagesToBudget(messages)
  if (fitted.length !== messages.length) {
    usage.trimmed = (usage.trimmed || 0) + (messages.length - fitted.length)
  }
  const answer = await infer({
    messages: fitted,
    maxTokens: Math.min(maxTokens, INFERENCE_LIMITS.maxTokens),
  })
  usage.calls += 1
  usage.promptChars += fitted.reduce(
    (total, message) => total + String(message.content ?? '').length,
    0,
  )
  usage.completionChars += String(answer?.content ?? '').length
  if (answer?.budget) usage.budget = answer.budget
  return answer
}

/**
 * LEVEL 1: which shelves does this request need?
 *
 * The only capability text in this prompt is the domain catalogue. A failure
 * here is not fatal — an empty list means "open everything", which is exactly
 * what the caller would have done anyway.
 */
async function discoverDomains({ request, infer, catalogue, usage, onProgress }) {
  const systemPrompt = `You are the tool-discovery layer for the brain that runs on the owner's iPhone. You do not plan yet: you choose which shelves of the tool library this request needs, and the tools on them are fetched for you.

Tool domains:
${renderDomainCatalog({ catalogue })}

Return ONLY valid JSON: {"domains": ["<domain>", ...]}

Rules:
- Name every domain the request might touch, likeliest first. Two is normal; ${DISCOVERY_DOMAIN_LIMIT} is the maximum.
- Naming one domain too many costs a few tokens. Naming one too few costs a whole round trip — so when two could apply, name both.
- "mac" is the way into anything this phone cannot do itself. Add it whenever the obvious shelf might not reach the whole job.`

  try {
    const answer = await callModel({
      infer,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: request.slice(0, DISCOVERY_CONTEXT_CHARS) },
      ],
      usage,
      maxTokens: 120,
    })
    const domains = normalizeDomains(parseModelJson(answer.content).domains, {
      limit: DISCOVERY_DOMAIN_LIMIT,
      catalogue,
    })
    onProgress?.({
      phase: 'discover_tools',
      message: domains.length ? `Opened: ${domains.join(', ')}` : 'Opened every tool',
    })
    return domains.length ? domains : null
  } catch {
    return null
  }
}

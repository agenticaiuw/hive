/*
 * Goal-level routing: one goal in, a surface named for every part of it.
 *
 * WHAT THIS REPLACES. Today a goal arrives already bound to a body. The voice
 * model picks between mac_run_actions, browser_run_actions and read_web_page
 * from a tool description; policyRouter.js picks a MODEL tier and says so in
 * its own header ("a COST decision, never a capability decision"); and
 * originFanOut.chooseBackend picks a browser — but only for a URL a caller has
 * already decided to read, one origin at a time. Nothing looks at "book the
 * thing on my calendar and check whether the venue is still open" and decides
 * that the first clause needs the owner's logged-in browser and the second
 * needs nothing of theirs switched on at all.
 *
 * That gap has a cost with a shape: whichever body the name was bound to has to
 * be awake, so the goal fails when the owner's Mac is asleep even for the parts
 * that never needed it, and it burns the owner's own machine on parts a
 * datacenter browser could have done.
 *
 * WHAT DECIDES. Not a table of "web goes here, files go there". Two questions,
 * both answered by data that already exists:
 *
 *   1. CAN this body do this at all, right now, with the credential in hand?
 *      That is shared/capabilityRegistry.js's entire job — canInvoke() returns
 *      yes / blocked / unimplemented / unknown, and its `onlineSurfaces` check
 *      is what keeps an offline body from being chosen. This module asks; it
 *      does not keep a second opinion about what exists. A need is looked up in
 *      the registry BY NAME ('goal web read'), and whoever registered
 *      themselves under that name is a candidate. Surfaces are found, never
 *      listed.
 *
 *   2. May it, given what the part actually touches? A capability check cannot
 *      see that a page needs the owner's session, because from the outside a
 *      login wall renders 200 OK. That is the second half, below.
 *
 * PUBLIC VS AUTHENTICATED, STRUCTURALLY. The first routing rule is: public web
 * reads belong on the server-side browser, and authenticated pages must go
 * through the owner's own browser, because only it holds the sessions. Decided
 * from the shape of the thing, never from a list of domains:
 *
 *   - Credentials in the URL. user:pass@host is a session in the address bar.
 *   - Reachability. A target the public internet cannot resolve — an RFC1918
 *     address, localhost, a .local name, a single-label host — is not
 *     "forbidden" to a Cloudflare browser, it is unreachable by it. This is
 *     physics and it outranks every stated preference, including a caller who
 *     said "public". The judgement is the relay's own normalizePublicUrl(),
 *     injected as `reach`, so there is exactly one definition of what the edge
 *     browser can see. When it is unavailable, publicness is UNVERIFIED and a
 *     public-internet surface is not used — an unchecked guess must not put the
 *     owner's page in a datacenter browser.
 *   - Evidence. A login wall observed at this origin during this run makes
 *     every later part on that origin authenticated. This is the anti-domain-
 *     list: the list is learned from the wall, in the run, and forgotten after.
 *   - Interaction. click / type / submit are outside the edge browser's
 *     vocabulary by construction (serverBrowser.BROWSER_ACTIONS is markdown,
 *     content, links). A part that must act on a page therefore has no
 *     server-side candidate at all — that falls out of the capability check
 *     rather than being asserted here.
 *   - Phrasing. "my orders", "sign in", "our invoices" — the only signal that
 *     is a guess. It is deliberately ONE-DIRECTIONAL: it can move a part onto
 *     the owner's browser, never off it. Being wrong costs one Mac round-trip;
 *     the opposite error would read a stranger's login page and file it as the
 *     owner's record.
 *   - Otherwise public, because the cheap default is correct far more often and
 *     is self-correcting: rerouteAfterAttempt() re-routes on the first wall.
 *
 * WHY A SURFACE'S PROPERTIES, NOT ITS NAME. The rules above match against three
 * facts carried in the surface snapshot — holdsOwnerSessions, network, attended
 * — supplied by whoever knows them (goalRouterSurfaces.js). Nothing here knows
 * that 'relay' means Cloudflare or that 'browser' means Safari. Add a fourth
 * body that holds the owner's sessions and it becomes eligible for
 * authenticated pages without a line changing here.
 *
 * DECIDES, NEVER RUNS. This module returns a plan. It opens no page, queues no
 * command and mutates nothing, so a wrong route costs a re-plan and never an
 * action. Execution stays where the abort controller and the job tracker live.
 */

import { canInvoke, resolveCapability } from '../shared/capabilityRegistry.js'

/* What a part is allowed to touch. 'not-web' keeps the field non-null for
 * parts where the question does not arise, so a reader never has to guess
 * whether null meant "public" or "nobody asked". */
export const ACCESS = Object.freeze({
  PUBLIC: 'public',
  OWNER: 'owner',
  NOT_WEB: 'not-web',
})

/* The kinds of work a goal decomposes into. Small on purpose: two parts belong
 * to different kinds only when a different BODY could do them. */
export const NEED = Object.freeze({
  WEB_READ: 'web.read',
  WEB_INTERACT: 'web.interact',
  WEB_SEARCH: 'web.search',
  MAC_CONTROL: 'mac.control',
  SPEAK: 'speak',
  REASON: 'reason',
})

/*
 * The name each need is looked up by in the capability registry.
 *
 * This is a table of NAMES, not of surfaces — the distinction the whole module
 * turns on. Nothing here says which body answers 'goal web read'; the registry
 * says, because bodies register themselves under it (see
 * goalRouterSurfaces.js). Two surfaces answering the same name is the normal
 * case and is exactly what there is a router for.
 */
export const NEED_LOOKUP = Object.freeze({
  [NEED.WEB_READ]: 'goal web read',
  [NEED.WEB_INTERACT]: 'goal web interact',
  [NEED.WEB_SEARCH]: 'goal web search',
  [NEED.MAC_CONTROL]: 'goal mac control',
  /*
   * Two kinds with no lookup, for two different reasons, and neither is a
   * failure to route.
   *
   * SPEAK — the reply goes back down the channel the goal arrived on. The body
   * that asked is already talking to the owner, so "and tell me the difference"
   * needs nobody chosen. (An UNPROMPTED announcement to a pendant that is not
   * in a conversation is a different thing, and it is a delivery decision that
   * belongs to whoever owns POST /v1/pendant/announce.)
   * REASON — summarising, comparing, deciding over what the other parts return.
   * Real work, no body: whoever holds the goal already holds the text.
   */
  [NEED.SPEAK]: null,
  [NEED.REASON]: null,
})

/* Why a part needs nobody, in the plan's own words. */
const NO_SURFACE_WHY = Object.freeze({
  [NEED.SPEAK]: 'the reply goes back over the channel the goal arrived on',
  [NEED.REASON]:
    'this part is reasoning over what the other parts return; no body has to do it',
})

/* ---- decomposition ------------------------------------------------------ */

/*
 * Sequencers, not conjunctions. Splitting on a bare "and" tears "search and
 * rescue" in half; these markers only ever appear between steps. A caller that
 * has a real parse (the planner, the voice model) should pass `parts` and skip
 * this entirely — the routing is the contract here, the splitting is a
 * convenience for the plain-string case.
 */
const SEQUENCERS = /\s*(?:;|\n+|\band then\b|\bafter that\b|\bafterwards\b|\bthen\b|\band also\b)\s*/i

/* "and open ...", "and check ..." is a step boundary; "bread and butter" is
 * not. The difference is whether a verb starts the next clause. */
const AND_THEN_VERB =
  /\s+and\s+(?=(?:also\s+)?(?:open|read|check|look|go|visit|fetch|get|find|search|tell|say|remind|send|reply|click|type|fill|buy|order|book|cancel|summari[sz]e|compare|run|quit|close|launch|set|play|pause|download|upload|log|sign)\b)/i

export function splitGoalParts(goal) {
  const text = String(goal ?? '').trim()
  if (!text) return []

  return text
    .split(SEQUENCERS)
    .flatMap((chunk) => chunk.split(AND_THEN_VERB))
    .map((chunk) => chunk.replace(/^[\s,.-]+|[\s,]+$/g, '').trim())
    .filter(Boolean)
}

/* ---- what a part needs -------------------------------------------------- */

/*
 * A URL, a bare hostname, a dotted quad, or a LAN name. Bare hostnames matter
 * because speech-to-text hands them over far more often than full URLs — the
 * same reason serverBrowser.normalizePublicUrl accepts them.
 */
const TARGET_URL =
  /\b(?:https?:\/\/[^\s<>"')]+|(?:[a-z0-9](?:[a-z0-9-]*[a-z0-9])?\.)+[a-z]{2,}(?::\d+)?(?:\/[^\s<>"')]*)?|\d{1,3}(?:\.\d{1,3}){3}(?::\d+)?(?:\/[^\s<>"')]*)?)/i

/* "Notes.app" is a bare hostname to the pattern above and an application to
 * everyone else. A capitalised label before a bare .app is the application; a
 * scheme or a path means the caller really did mean the web. */
const APP_NOT_HOST = /^[A-Z][A-Za-z0-9]*\.app$/

const INTERACT_VERBS =
  /\b(?:click|tap|type|fill(?: out| in)?|submit|log ?in|sign ?in|sign ?up|check ?out|buy|purchase|order|book|reserve|cancel|renew|reply|comment|upload|apply|pay|add to (?:cart|basket|the cart)|unsubscribe|post)\b/i

const SEARCH_VERBS =
  /\b(?:search(?! for it on)|look up|google|research|find out|latest news|news about|who won|what(?:'s| is) the (?:price|score|weather))\b/i

/* "remind me" is here rather than under speaking because the Mac has a
 * create_reminder action: a reminder is something to set, not something to say
 * now. */
const MAC_VERBS =
  /\b(?:open|launch|quit|close|volume|mute|unmute|brightness|screenshot|screen shot|finder|desktop|downloads folder|terminal|shell command|applescript|clipboard|wifi|battery|remind me|reminder|calendar event|create a note|move (?:the )?file|delete (?:the )?file|rename)\b/i

const SPEAK_VERBS =
  /\b(?:tell me|say it|read (?:it |that )?(?:back|aloud|out loud)|announce|let me know|notify me)\b/i

/*
 * Resources that exist only inside somebody's session. Nouns, not domains:
 * "my orders" is authenticated on every store that ever existed, and the set of
 * such stores is not enumerable while the set of such nouns nearly is.
 */
const OWNER_RESOURCE =
  /\b(?:my|our|mine)\s+(?:\w+\s+){0,2}(?:account|accounts|order|orders|inbox|email|mail|calendar|dashboard|profile|settings|subscription|subscriptions|invoice|invoices|bank|balance|statement|statements|cart|basket|messages|dms|portal|billing|reservation|reservations|tickets)\b/i

const SESSION_VERBS = /\b(?:log ?in|logged ?in|sign ?in|signed ?in|my account)\b/i

/**
 * What one part of a goal needs, as structure rather than prose.
 *
 * Best-effort by construction: it reads English. Everything it decides can be
 * overridden by a caller that knows better (pass `need`), and everything it
 * gets wrong is recoverable — the worst case is a part routed to a body that
 * reports it cannot help, which rerouteAfterAttempt() then moves.
 */
export function deriveNeed(text, { defaults = {} } = {}) {
  const raw = String(text ?? '').trim()
  const match = TARGET_URL.exec(raw)
  const candidate = match?.[0] ?? null
  const url = candidate && !APP_NOT_HOST.test(candidate) ? candidate : null

  if (url) {
    return {
      kind: INTERACT_VERBS.test(raw) ? NEED.WEB_INTERACT : NEED.WEB_READ,
      target: { kind: 'url', url },
      ...defaults,
    }
  }

  /*
   * An owner resource with no address is still web work — "check my orders" is
   * a page, the speaker just did not say which. It cannot be handed to a body
   * that holds no sessions, and it cannot be checked for public reachability
   * either, so it is web.read with an unnamed target and the owner's browser is
   * the only candidate that survives.
   */
  if (OWNER_RESOURCE.test(raw)) {
    return {
      kind: INTERACT_VERBS.test(raw) ? NEED.WEB_INTERACT : NEED.WEB_READ,
      target: { kind: 'owner-resource', url: null, phrase: OWNER_RESOURCE.exec(raw)[0] },
      ...defaults,
    }
  }

  if (SEARCH_VERBS.test(raw)) {
    return { kind: NEED.WEB_SEARCH, target: { kind: 'query', url: null }, ...defaults }
  }
  if (MAC_VERBS.test(raw)) {
    return { kind: NEED.MAC_CONTROL, target: { kind: 'machine', url: null }, ...defaults }
  }
  if (SPEAK_VERBS.test(raw)) {
    return { kind: NEED.SPEAK, target: { kind: 'owner', url: null }, ...defaults }
  }

  return { kind: NEED.REASON, target: { kind: 'none', url: null }, ...defaults }
}

const WEB_NEEDS = new Set([NEED.WEB_READ, NEED.WEB_INTERACT])

/** The origin a part touches, for matching observations against later parts. */
export function originOf(url) {
  const text = String(url ?? '').trim()
  if (!text) return null
  try {
    const parsed = new URL(/^[a-z][a-z0-9+.-]*:/i.test(text) ? text : `https://${text}`)
    return parsed.origin.toLowerCase()
  } catch {
    return null
  }
}

/* ---- public vs authenticated -------------------------------------------- */

/**
 * Which of the owner's things this part touches, and on what basis.
 *
 * Every signal carries its own `why`, because the plan is read by an agent
 * deciding whether to trust the route and by a person deciding whether the
 * rule is right. "owner, because phrasing" and "owner, because 192.168.1.1
 * cannot be reached from a datacentre" deserve very different amounts of
 * confidence and must not collapse into the same word.
 *
 * `verifiedPublic` is the separate half a boolean access cannot carry: not
 * "is it public" but "did anything actually check". A surface out on the public
 * internet is only used when something checked.
 */
export function classifyAccess(part, { reach = null, observations = [] } = {}) {
  const need = part.need
  if (!WEB_NEEDS.has(need?.kind)) {
    return { access: ACCESS.NOT_WEB, basis: 'not-web', verifiedPublic: false, signals: [] }
  }

  const url = need.target?.url ?? null
  const origin = originOf(url)
  const signals = []
  let verifiedPublic = false
  const decide = (access, basis, why) => {
    signals.push({ signal: basis, access, why })
    return { access, basis, verifiedPublic, signals }
  }

  /*
   * 1. A session in the address bar. First because it is the most specific
   * thing that can be said about a URL, and because the reachability check
   * below also rejects it — but as "not public", which would report the least
   * useful of the two true reasons.
   */
  if (url && /^[a-z][a-z0-9+.-]*:\/\/[^/@\s]*@/i.test(url)) {
    return decide(
      ACCESS.OWNER,
      'credentials-in-url',
      'the address carries embedded credentials',
    )
  }

  /*
   * 2. Reachability, and it outranks the caller. A body sitting in a datacentre
   * cannot reach 192.168.1.1 no matter who says it is public, so this is not a
   * permission judgement to be overridden — it is where the packets can go.
   */
  if (url && typeof reach === 'function') {
    const verdict = reach(url) ?? { ok: false }
    verifiedPublic = Boolean(verdict.ok)
    if (!verdict.ok) {
      return decide(
        ACCESS.OWNER,
        'unreachable-from-public-internet',
        verdict.error ||
          'no body outside the owner\'s network can resolve that address',
      )
    }
  } else if (url) {
    /* Nothing checked. Not a failure — a fact that shapes the choice, since a
     * surface on the public internet is only eligible for a target something
     * confirmed is on the public internet. */
    signals.push({
      signal: 'reachability-unchecked',
      access: null,
      why: 'no public-URL check was available, so publicness is unverified',
    })
  }

  /* 3. Evidence beats declaration. A wall seen at this origin during this run
   * is the strongest statement available that the page needs a session, and it
   * is learned rather than listed. */
  const wall = observations.find(
    (entry) => entry?.kind === 'login-wall' && entry.origin && entry.origin === origin,
  )
  if (wall) {
    return decide(
      ACCESS.OWNER,
      'observed-login-wall',
      `${origin} answered a body with no session with a sign-in page`,
    )
  }

  /* 4. A caller that knows. originFanOut.normalizeOrigins spells this `auth`;
   * same idea, and it is authoritative over guesses but not over physics. */
  const stated = part.access ?? need.access ?? null
  if (stated === ACCESS.PUBLIC || stated === ACCESS.OWNER) {
    return decide(stated, 'stated-by-caller', 'the caller declared it')
  }

  /* 5. Acting on a page, rather than reading it. Recorded as a signal and
   * enforced by the capability check, which finds no read-only server-side
   * candidate for an interaction need — see the header. */
  if (need.kind === NEED.WEB_INTERACT) {
    return decide(
      ACCESS.OWNER,
      'interaction',
      'clicking, typing and submitting happen where the session is',
    )
  }

  /* 6. A resource named as the owner's, or wording that describes being signed
   * in. The one guess, and it only ever moves work toward the owner's browser. */
  if (need.target?.kind === 'owner-resource' || OWNER_RESOURCE.test(part.text ?? '')) {
    return decide(
      ACCESS.OWNER,
      'owner-resource-phrasing',
      'the goal names a resource that exists inside the owner\'s session',
    )
  }
  if (SESSION_VERBS.test(part.text ?? '')) {
    return decide(
      ACCESS.OWNER,
      'session-phrasing',
      'the goal describes being signed in',
    )
  }

  /* 7. Default. Cheap, correct most of the time, and self-correcting: the first
   * sign-in wall re-routes it and every later part on that origin with it. */
  return decide(
    ACCESS.PUBLIC,
    'no-session-signal',
    'nothing in the goal, the address or this run says a session is needed',
  )
}

/* ---- surfaces ----------------------------------------------------------- */

/*
 * What is assumed about a body nobody described.
 *
 * `online: null` is unknown, and unknown is not chosen — but it is also not
 * reported as offline, because "I cannot see that far" and "it is not there"
 * are different answers and conflating them is the failure
 * shared/capabilityRegistry.js was written to end. The rest default to the
 * expensive/safe side: assume choosing it costs the owner something (attended)
 * and assume it holds none of their sessions.
 */
export function surfaceFacts(surfaces = {}, key) {
  const declared = surfaces?.[key] ?? {}
  return {
    surface: key,
    online: declared.online === true ? true : declared.online === false ? false : null,
    attended: declared.attended !== false,
    holdsOwnerSessions: declared.holdsOwnerSessions === true,
    network: declared.network ?? 'unknown',
    why: declared.why ?? null,
  }
}

function onlineSurfaceList(surfaces = {}) {
  return Object.keys(surfaces).filter((key) => surfaces[key]?.online === true)
}

/* ---- the routing -------------------------------------------------------- */

/**
 * Route one goal.
 *
 * `context` is entirely injected — registry, liveness, credentials, the public
 * URL check — so this function is a pure decision over facts someone else
 * gathered. goalRouterSurfaces.buildGoalRoutingContext() gathers them from the
 * live process; a test supplies them directly.
 */
export function routeGoal(goal, context = {}) {
  const {
    registry,
    principal = {},
    surfaces = {},
    reach = null,
    observations = [],
    now = Date.now(),
  } = context

  if (!registry?.capabilities) {
    throw new TypeError(
      'routeGoal needs a capability registry (shared/capabilityRegistry.js createCapabilityRegistry).',
    )
  }

  const goalText = String(goal ?? '').trim()
  const onlineSurfaces = onlineSurfaceList(surfaces)
  const parts = normalizeParts(goalText, context)

  const routed = parts.map((part) =>
    routePart(part, {
      registry,
      principal,
      surfaces,
      onlineSurfaces,
      reach,
      observations,
      now,
    }),
  )

  return {
    goal: goalText,
    generatedAt: new Date(now).toISOString(),
    parts: routed,
    /* One line per body so a reader can tell "nothing could do this" from "the
     * body that does this is asleep" without reading every part. */
    surfaces: Object.fromEntries(
      Object.keys(surfaces).map((key) => [key, surfaceFacts(surfaces, key)]),
    ),
    observations: [...observations],
    unroutable: routed.filter((part) => !part.decision && part.need.kind !== NEED.REASON),
    summary: summarize(routed),
  }
}

function normalizeParts(goalText, context) {
  const supplied = Array.isArray(context.parts) ? context.parts : null
  const list = supplied
    ? supplied.map((part, index) => ({
        id: part?.id ?? `p${index + 1}`,
        text: String(part?.text ?? '').trim(),
        need: part?.need ?? deriveNeed(part?.text ?? ''),
        access: part?.access ?? null,
      }))
    : splitGoalParts(goalText).map((text, index) => ({
        id: `p${index + 1}`,
        text,
        need: deriveNeed(text),
        access: context.access ?? null,
      }))

  /* A goal that says one thing is one part; splitting produced nothing only
   * when the goal was empty. */
  return list.filter((part) => part.text || part.need)
}

function routePart(part, deps) {
  const { registry, principal, surfaces, onlineSurfaces, reach, observations, now } = deps
  const need = part.need
  const access = classifyAccess(part, { reach, observations })
  const lookup = NEED_LOOKUP[need.kind] ?? null

  const base = {
    id: part.id,
    text: part.text,
    need,
    access,
  }

  if (!lookup) {
    return {
      ...base,
      decision: {
        surface: null,
        kind: 'no-surface',
        why: NO_SURFACE_WHY[need.kind] ?? 'no body has to do this part',
      },
      candidates: [],
    }
  }

  const found = resolveCapability(registry, lookup)
  const candidateRecords =
    found.status === 'resolved'
      ? [found.capability]
      : found.status === 'ambiguous'
        ? found.candidates
        : []

  if (candidateRecords.length === 0) {
    return {
      ...base,
      decision: null,
      candidates: [],
      /* An honest "nobody" has to say whether that means absent or unseen —
       * resolveCapability's coverage is exactly that distinction. */
      why:
        found.coverage?.unpublished?.length > 0
          ? `nothing is registered as "${lookup}", and these surfaces have published no inventory: ${found.coverage.unpublished.join(', ')}`
          : `nothing on any published surface answers to "${lookup}"`,
    }
  }

  const candidates = candidateRecords
    .map((record) => evaluate(record, { registry, principal, onlineSurfaces, surfaces, access, now }))
    .sort(compareCandidates)

  const usable = candidates.filter((candidate) => candidate.usable)
  const chosen = usable[0] ?? null

  return {
    ...base,
    decision: chosen
      ? {
          surface: chosen.surface,
          kind: 'surface',
          capability: chosen.name,
          capabilityId: chosen.capabilityId,
          resolvedTo: chosen.resolvedTo,
          invoke: chosen.invoke,
          why: chosen.why,
        }
      : null,
    candidates,
    alternates: usable.slice(1).map((candidate) => candidate.capabilityId),
    why: chosen ? chosen.why : blockedWhy(candidates),
  }
}

/**
 * One candidate, judged.
 *
 * Two gates in order, and they are different questions. The registry answers
 * the first — does this run, does my credential reach it, is its body awake.
 * Only what survives that is asked the second: given what this part touches,
 * may this body be the one? A body can be perfectly capable and still be the
 * wrong one, which is the whole public-vs-authenticated rule.
 */
function evaluate(record, { registry, principal, onlineSurfaces, surfaces, access, now }) {
  const verdict = canInvoke(
    registry,
    record.id,
    { ...principal, onlineSurfaces },
    { now },
  )

  const implementation = verdict.resolvedTo
    ? registry.capabilities.get(verdict.resolvedTo)
    : null
  const surfaceKey = implementation?.surface ?? record.surface
  const facts = surfaceFacts(surfaces, surfaceKey)

  const candidate = {
    capabilityId: record.id,
    name: record.name,
    surface: surfaceKey,
    resolvedTo: verdict.resolvedTo,
    invoke: verdict.invoke,
    verdict: verdict.verdict,
    evidence: verdict.evidence,
    missing: verdict.missing,
    missingInputs: verdict.missingInputs,
    attended: facts.attended,
    usable: false,
    why: '',
  }

  if (verdict.verdict !== 'yes') {
    candidate.why = capabilityBlockWhy(verdict, facts)
    return candidate
  }

  const policy = policyBlock(access, facts)
  if (policy) {
    candidate.why = policy
    return candidate
  }

  candidate.usable = true
  candidate.why = chooseWhy(access, facts, verdict)
  return candidate
}

/*
 * Why a body that CAN do the work still must not do this part.
 *
 * Each branch is a property of the surface against a property of the target —
 * never a name. Two of the three are one-way on purpose: a body with no
 * sessions is not merely likely to fail on an authenticated page, it cannot
 * succeed, so trying costs a browser-minute to be shown a login form. That is
 * the same conclusion originFanOut.chooseBackend reached for a single origin,
 * reached here from the surface's declared facts instead of a backend name.
 */
function policyBlock(access, facts) {
  if (access.access === ACCESS.OWNER && !facts.holdsOwnerSessions) {
    return `${facts.surface} holds none of the owner's sessions, and this part needs one (${access.basis})`
  }

  if (
    access.access === ACCESS.OWNER &&
    access.basis === 'unreachable-from-public-internet' &&
    facts.network === 'public-internet'
  ) {
    return `${facts.surface} is out on the public internet and that address is not`
  }

  if (
    access.access === ACCESS.PUBLIC &&
    facts.network === 'public-internet' &&
    !access.verifiedPublic
  ) {
    return `${facts.surface} only reaches the public internet and nothing verified this target is on it`
  }

  return null
}

function capabilityBlockWhy(verdict, facts) {
  if (verdict.verdict === 'blocked') {
    const surfaceMiss = verdict.missing.find((entry) => entry.kind === 'surface')
    if (surfaceMiss) {
      return facts.online === false
        ? `${facts.surface} is offline${facts.why ? ` (${facts.why})` : ''}`
        : `${facts.surface} has not reported itself online, and an unseen body is not chosen`
    }
    return verdict.because
  }
  return verdict.because
}

function chooseWhy(access, facts, verdict) {
  const where = `${facts.surface} can do it now`
  if (access.access === ACCESS.OWNER) {
    return `${where} and it holds the owner's sessions, which this part needs (${access.basis})`
  }
  if (access.access === ACCESS.PUBLIC && !facts.attended) {
    return `${where} without anything of the owner's being awake, and the target is public (${access.basis})`
  }
  if (access.access === ACCESS.PUBLIC) {
    return `${where}; no unattended body could (${verdict.because})`
  }
  return where
}

function blockedWhy(candidates) {
  if (candidates.length === 0) return 'no body registered for this need'
  return candidates.map((candidate) => `${candidate.surface}: ${candidate.why}`).join('; ')
}

/*
 * Ranking, only ever among candidates that already passed both gates.
 *
 * `attended` first is the whole economic point of routing at all: a body nobody
 * has to wake is strictly cheaper than the owner's own machine, and the
 * server-side-browser-for-public-reads rule is this line plus the session gate
 * above — not a preference for a particular backend. Then fresh evidence,
 * because a body that answered an hour ago is a better bet than one that has
 * never been tried. Then id, so two runs over the same facts route the same way.
 */
function compareCandidates(left, right) {
  if (left.usable !== right.usable) return left.usable ? -1 : 1
  if (left.attended !== right.attended) return left.attended ? 1 : -1

  const leftFresh = left.evidence?.fresh && left.evidence.successes > 0 ? 0 : 1
  const rightFresh = right.evidence?.fresh && right.evidence.successes > 0 ? 0 : 1
  if (leftFresh !== rightFresh) return leftFresh - rightFresh

  const leftInputs = left.missingInputs?.length ?? 0
  const rightInputs = right.missingInputs?.length ?? 0
  if (leftInputs !== rightInputs) return leftInputs - rightInputs

  return left.capabilityId.localeCompare(right.capabilityId)
}

function summarize(parts) {
  return parts
    .map((part) => {
      if (part.decision?.kind === 'no-surface') return `${part.id}: (no body needed)`
      if (!part.decision) return `${part.id}: UNROUTED — ${part.why}`
      return `${part.id}: ${part.decision.surface} — ${part.decision.capability}`
    })
    .join('\n')
}

/* ---- learning from an attempt ------------------------------------------- */

/*
 * Outcomes that change a route rather than merely failing it. Every string is a
 * `reason` serverBrowser.readPublicPage already returns, so the caller feeds
 * back the result it got instead of translating it.
 */
const SESSION_OUTCOMES = new Set(['empty', 'login-wall'])
const SURFACE_OUT_OF_ACTION = new Set([
  'not-configured',
  'rate-limited',
  'transport-error',
  'timeout',
  'offline',
])

/**
 * Re-route after a body actually tried and came back.
 *
 * This is what makes the public/authenticated rule structural rather than a
 * list: the router does not need to know which sites need a login, only what a
 * login wall looks like when one is hit. The observation is recorded against
 * the ORIGIN, so the other three parts of the goal that touch the same origin
 * move too, without any of them paying for their own wall.
 *
 * Pure: it returns a new plan from the same context plus one more fact. Nothing
 * is stored, so two callers routing the same goal cannot poison each other, and
 * a plan is reproducible from its inputs.
 */
export function rerouteAfterAttempt(plan, outcome = {}, context = {}) {
  const partId = outcome.partId ?? null
  const part = plan?.parts?.find((entry) => entry.id === partId) ?? null
  const observations = [...(context.observations ?? plan?.observations ?? [])]
  const surfaces = { ...(context.surfaces ?? {}) }
  const notes = []

  const reason = String(outcome.reason ?? '').trim()
  const sessionWall =
    outcome.likelyLoginWall === true || SESSION_OUTCOMES.has(reason)

  if (sessionWall) {
    const origin = originOf(part?.need?.target?.url ?? outcome.url ?? '')
    if (origin) {
      observations.push({
        kind: 'login-wall',
        origin,
        at: new Date(context.now ?? Date.now()).toISOString(),
        by: outcome.surface ?? part?.decision?.surface ?? null,
      })
      notes.push(`${origin} needs a session; every part on it moves to a body that has one`)
    }
  }

  if (SURFACE_OUT_OF_ACTION.has(reason)) {
    const key = outcome.surface ?? part?.decision?.surface ?? null
    if (key) {
      /*
       * Marked offline for THIS re-route, not remembered: liveness is the
       * caller's to own, and a rate limit that clears in ten seconds must not
       * become a standing belief inside a routing module.
       */
      surfaces[key] = { ...(surfaces[key] ?? {}), online: false, why: reason }
      notes.push(`${key} is out of action (${reason}) and is not offered again in this plan`)
    }
  }

  const next = routeGoal(plan?.goal ?? '', {
    ...context,
    surfaces,
    observations,
    /* The decomposition is kept. Re-splitting the goal could produce different
     * part ids, and an outcome reported against p2 would then land on a
     * different clause. */
    parts: plan?.parts?.map((entry) => ({
      id: entry.id,
      text: entry.text,
      need: entry.need,
      /* Deliberately NOT carrying the previous access verdict: it is derived,
       * and the new observation is the whole reason to derive it again. */
      access: entry.access?.basis === 'stated-by-caller' ? entry.access.access : null,
    })),
  })

  return {
    ...next,
    rerouted: {
      partId,
      because: notes.length ? notes.join('; ') : 'nothing in that outcome changes the route',
      changed: notes.length > 0,
    },
  }
}

/* ---- http --------------------------------------------------------------- */

/**
 * Mount the router.
 *
 * A registration function rather than routes in server.js for the reason
 * actionLedgerRoutes.js states: server.js is a large shared surface several
 * people edit at once, and a module that mounts in one line does not collide.
 *
 * Every route here DECIDES and returns; none of them run anything. The context
 * builder is injected and loaded lazily, so this module stays importable —
 * including by a test — without pulling the Mac's manifest, the relay's browser
 * and the extension's heartbeat table in behind it.
 */
export function registerGoalRouterRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerGoalRouterRoutes requires an Express-style app.')
  }

  const {
    basePath = '/goal-router',
    loadContext = async (deps) => {
      const { buildGoalRoutingContext } = await import('./goalRouterSurfaces.js')
      return buildGoalRoutingContext(deps)
    },
  } = options

  const contextFor = async (request) =>
    loadContext({ app, request, ...(options.contextOptions ?? {}) })

  /* What the router can see right now: which bodies answered, what each one is
   * (attended? sessions? which network?), and what it would therefore be
   * chosen for. Read this before asking why a goal routed the way it did. */
  app.get(`${basePath}/surfaces`, async (_request, response) => {
    try {
      const context = await contextFor(null)
      response.json({
        ok: true,
        generatedAt: new Date(context.now ?? Date.now()).toISOString(),
        surfaces: Object.fromEntries(
          Object.keys(context.surfaces ?? {}).map((key) => [
            key,
            surfaceFacts(context.surfaces, key),
          ]),
        ),
        principal: {
          credentials: context.principal?.credentials ?? [],
          scopes: context.principal?.scopes ?? [],
        },
        capabilities: context.registry ? context.registry.capabilities.size : 0,
        reachabilityCheck: typeof context.reach === 'function' ? 'available' : 'unavailable',
        notes: context.notes ?? [],
      })
    } catch (error) {
      response.status(500).json({ ok: false, error: String(error?.message || error) })
    }
  })

  /* Route a goal. Body: { goal, parts?, access?, observations? }. */
  app.post(`${basePath}/route`, async (request, response) => {
    const goal = String(request.body?.goal ?? '').trim()
    if (!goal && !Array.isArray(request.body?.parts)) {
      response.status(400).json({ ok: false, error: 'Give me a goal to route.' })
      return
    }

    try {
      const context = await contextFor(request)
      const plan = routeGoal(goal, {
        ...context,
        parts: request.body?.parts ?? context.parts,
        access: request.body?.access ?? null,
        observations: request.body?.observations ?? context.observations ?? [],
      })
      response.json({ ok: true, plan })
    } catch (error) {
      response.status(400).json({ ok: false, error: String(error?.message || error) })
    }
  })

  /* Feed back what actually happened. Body: { plan, outcome }. Stateless on
   * purpose — the caller holds the plan, so nothing here can go stale. */
  app.post(`${basePath}/reroute`, async (request, response) => {
    const plan = request.body?.plan
    if (!plan?.parts) {
      response.status(400).json({ ok: false, error: 'Send back the plan you were given.' })
      return
    }

    try {
      const context = await contextFor(request)
      const next = rerouteAfterAttempt(plan, request.body?.outcome ?? {}, {
        ...context,
        observations: plan.observations ?? context.observations ?? [],
      })
      response.json({ ok: true, plan: next })
    } catch (error) {
      response.status(400).json({ ok: false, error: String(error?.message || error) })
    }
  })

  return [
    `GET ${basePath}/surfaces`,
    `POST ${basePath}/route`,
    `POST ${basePath}/reroute`,
  ]
}

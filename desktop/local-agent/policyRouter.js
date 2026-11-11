import fs from 'node:fs'

import { matchBriefingCommand } from './briefing.js'
/*
 * Deterministic routing is a decision about the COMMAND, not the provenance a
 * surface stapled to it — and normalize() collapses the blank line, so an
 * unstripped trailer overruns MAX_DETERMINISTIC_CHARS and defeats every ^…$
 * anchor. "what time is it" from the extension then paid for a planner turn to
 * re-derive the clock. This module solved that first and privately; the strip
 * now lives in callerContext.js because goalVerdict.js needed the same one.
 */
import { stripContextTrailer } from './callerContext.js'
import { isSmallRequest } from './intentRouter.js'
import { matchMailTriageCommand } from './mailTriage.js'
import { matchMeetingFollowupCommand } from './meetingFollowup.js'
import { findClosestInstalledApp, getMachineContext } from './machineContext.js'
import { resolveUserPath } from './security.js'
import { CAPABILITY_GAP_MATCHERS } from './capabilityGapsActions.js'

/*
 * Which brain answers this request.
 *
 * Every spoken command used to take the same path: build the full planner
 * prompt (~26,000 characters of action schema plus the live machine inventory)
 * and ask gpt-5.6-luna what to do — even for "set volume to 30", where there is
 * exactly one right answer and no judgement to make. That is ~6,500 prompt
 * tokens and ~1.8 seconds of the owner's time spent re-deriving something a
 * regex already knows.
 *
 * This router picks the cheapest path that still produces the same result:
 *
 *   deterministic — the utterance maps to exactly one action with no ambiguity.
 *                   No model call at all; straight to the executor.
 *   background    — a model is needed but nobody is waiting on the turn (a
 *                   routine) or the request is plainly single-step. Small model,
 *                   trimmed schema, no CLI inventory.
 *   planner       — anything with judgement in it: multi-step, browser/UI work,
 *                   shell, research, or wording this file cannot vouch for.
 *
 * It is a COST decision, never a capability decision. Nothing here can refuse a
 * request: the worst a wrong classification can do is spend a cheaper model
 * first and escalate. The deterministic table is deliberately paranoid for the
 * same reason — an unanchored pattern that fires on the wrong utterance would
 * run the wrong action, which is the one failure mode a cheaper path must not
 * have. (The predecessor of this file, intentRouter.js, was disabled in the
 * orchestrator precisely because fuzzy token overlap chose actions it should
 * not have. It survives here doing what it is actually good at: hinting that a
 * request is *simple*, where a miss only costs a model choice.)
 */

export const TIER_DETERMINISTIC = 'deterministic'
export const TIER_BACKGROUND = 'background'
export const TIER_PLANNER = 'planner'

/*
 * Anything that smells like more than one step, a condition, or a judgement
 * call is disqualified from the deterministic path before a pattern is even
 * tried. Cheap to test, and it removes the whole class of "open Safari and then
 * search for X" false positives.
 */
const MULTI_STEP = /\b(?:and then|then|after that|afterwards|also|as well as|instead of)\b|;/i
const MAX_DETERMINISTIC_CHARS = 90

/*
 * Deliberating costs seconds of voice latency and a large prompt. Spend it on
 * wording that actually implies several dependent steps or open-ended search.
 * Mirrors llmPlanner's DELIBERATION_HINTS — kept separate because that one
 * chooses reasoning effort and this one chooses a model tier.
 */
const NEEDS_JUDGEMENT =
  /\b(then|after that|figure out|research|compare|summari[sz]e|debug|troubleshoot|refactor|migrat|organi[sz]e|clean up|decide|why|how come|instead of|each of|all of my|every|draft|email|reply|search for|look up|find out)\b/i

/*
 * The small tier gets a trimmed action schema, so a request that clearly needs
 * something outside it must not be sent there only to fail and escalate.
 */
const NEEDS_FULL_SCHEMA =
  /\b(browser|chrome|safari tab|tab|page|website|web ?site|url|form|click|scroll|type into|shell|terminal|command line|applescript|script|screen|window|menu|drag|mouse|keyboard|send an? email|mail)\b/i

/*
 * A question the deterministic table did not recognise is, by definition, one
 * this codebase cannot answer with an obvious single action — so it wants a
 * model that can answer rather than one that can only act. Measured on
 * "what apps do I have installed for editing photos": the small tier replied
 * with open_app, the full planner replied with the actual list. Questions are a
 * small share of traffic and getting them wrong is expensive in a way tokens
 * are not.
 */
const OPEN_QUESTION =
  /^(?:what|which|who|whose|where|when|how|why|do i|does|is there|are there|can you tell me)\b/i

const DETERMINISTIC_MATCHERS = [
  /*
   * Order is the whole point of putting these first. briefing.js claims
   * /\bevery\s+(?:week)?day?\s*morning\b/, so "every weekday morning check my
   * work portal" resolved deterministically to compose_briefing — the older,
   * narrower brief that opens no authenticated page, drafts nothing, and has
   * no review queue. No model was ever consulted, so nothing surfaced the
   * substitution. Below that entry these matchers never see the sentence.
   *
   * They are strictly more specific than briefing.js's: "brief me", "morning
   * brief", "prepare my workday", "what did I miss in email", "read my
   * schedule" and "wrapup" still belong to it.
   */
  ...CAPABILITY_GAP_MATCHERS,
  {
    intent: 'set_volume',
    readOnly: false,
    test: (text) =>
      /^(?:please\s+)?(?:set|change|turn|put|make)?\s*(?:the\s+)?volume\s*(?:level\s*)?(?:to|at|=)?\s*(\d{1,3})\s*(?:%|percent)?$/i.exec(
        text,
      ) || /^volume\s+(\d{1,3})\s*(?:%|percent)?$/i.exec(text),
    build: (match) => {
      const level = Number(match[1])
      if (!Number.isFinite(level) || level < 0 || level > 100) return null
      return action('set_volume', `Set volume to ${level}%`, { level })
    },
  },
  {
    intent: 'set_mute',
    readOnly: false,
    test: (text) =>
      /^(?:please\s+)?(un)?mute(?:\s+(?:the\s+)?(?:volume|sound|audio|mac|speakers?))?$/i.exec(
        text,
      ),
    build: (match) => {
      const muted = !match[1]
      return action(
        'set_mute',
        muted ? 'Mute output volume' : 'Unmute output volume',
        { muted },
      )
    },
  },
  {
    intent: 'get_volume',
    readOnly: true,
    test: (text) =>
      /^(?:what(?:'s|s| is)|how loud is)\s+(?:the\s+|my\s+)?volume(?:\s+level)?\??$/i.exec(
        text,
      ) || /^volume\??$/i.exec(text),
    build: () => action('get_volume', 'Read output volume', {}),
  },
  {
    intent: 'set_brightness',
    readOnly: false,
    test: (text) =>
      /^(?:please\s+)?(?:set|change|turn|put|make)?\s*(?:the\s+)?(?:screen\s+|display\s+)?brightness\s*(?:to|at|=)?\s*(\d{1,3})\s*(?:%|percent)?$/i.exec(
        text,
      ),
    build: (match) => {
      const level = Number(match[1])
      if (!Number.isFinite(level) || level < 0 || level > 100) return null
      return action('set_brightness', `Set brightness to ${level}%`, { level })
    },
  },
  {
    intent: 'get_brightness',
    readOnly: true,
    test: (text) =>
      /^(?:what(?:'s|s| is))\s+(?:the\s+|my\s+)?(?:screen\s+|display\s+)?brightness(?:\s+level)?\??$/i.exec(
        text,
      ),
    build: () => action('get_brightness', 'Read display brightness', {}),
  },
  {
    /*
     * Status fields are separate because get_mac_status runs one shell command
     * per field: asking for battery should not also poll the network.
     */
    intent: 'get_mac_status',
    readOnly: true,
    test: (text) =>
      /^(?:hey\s+)?(?:what(?:'s|s| is)|how(?:'s|s| is)|check|tell me)?\s*(?:my|the)?\s*(battery|battery level|battery percentage|charge|wifi|wi-?fi|network|internet|connection|mac status|system status|status)(?:\s+(?:level|status|percentage|connection))?\s*(?:at|doing|looking)?\??$/i.exec(
        text,
      ),
    build: (match) => {
      const subject = match[1].toLowerCase()
      const fields = /battery|charge/.test(subject)
        ? ['battery']
        : /wifi|wi-fi|network|internet|connection/.test(subject)
          ? ['wifi']
          : ['all']
      return action(
        'get_mac_status',
        `Read Mac ${fields[0] === 'all' ? 'status' : fields[0]}`,
        { fields },
      )
    },
  },
  {
    intent: 'get_time',
    readOnly: true,
    test: (text) =>
      /^(?:hey\s+)?(?:what(?:'s|s| is)\s+)?(?:the\s+)?(?:current\s+)?(?:time|date|day)(?:\s+is\s+it)?(?:\s+(?:right\s+now|now|today))?\??$/i.exec(
        text,
      ) ||
      /^what\s+time\s+is\s+it(?:\s+(?:right\s+)?now)?\??$/i.exec(text),
    build: () => action('get_time', 'Read the current time', {}),
  },
  {
    intent: 'get_weather',
    readOnly: true,
    test: (text) =>
      /^(?:hey\s+)?(?:what(?:'s|s| is)|how(?:'s|s| is))?\s*(?:the\s+)?weather(?:\s+(?:like\s+)?(?:in|at|for)\s+([A-Za-z][A-Za-z\s,.-]{1,40}?))?(?:\s+(?:today|right now|now))?\??$/i.exec(
        text,
      ),
    build: (match) => {
      const location = String(match[1] || '').trim()
      return action(
        'get_weather',
        location ? `Weather in ${location}` : 'Weather here',
        location ? { location } : {},
      )
    },
  },
  {
    intent: 'get_clipboard',
    readOnly: true,
    test: (text) =>
      /^(?:what(?:'s|s| is)\s+(?:on|in)\s+)?(?:my\s+|the\s+)?clipboard\??$/i.exec(
        text,
      ) || /^(?:read|get|show)\s+(?:my\s+|the\s+)?clipboard\??$/i.exec(text),
    build: () => action('get_clipboard', 'Read the Mac clipboard', {}),
  },
  {
    intent: 'screenshot',
    readOnly: true,
    test: (text) =>
      /^(?:please\s+)?(?:take|grab|capture|get)?\s*(?:a\s+|the\s+)?screen\s?shot(?:\s+of\s+(?:the\s+)?screen)?$/i.exec(
        text,
      ),
    build: () => action('screenshot', 'Capture the screen', {}),
  },
  {
    /*
     * URL before path before app: "open github.com", "open ~/Downloads" and
     * "open Safari" all match a bare "open X", and only the most specific
     * reading is safe to act on without a model.
     */
    intent: 'open_url',
    readOnly: false,
    test: (text) =>
      /^(?:please\s+)?(?:open|go\s+to|navigate\s+to|visit|browse\s+to|pull\s+up)\s+(https?:\/\/\S+|(?:www\.)?[a-z0-9-]+(?:\.[a-z0-9-]+)+(?:\/\S*)?)$/i.exec(
        text,
      ),
    build: (match) => {
      const raw = match[1]
      const url = /^https?:\/\//i.test(raw) ? raw : `https://${raw}`
      try {
        // Anything URL() rejects is not something to open on a guess.
        new URL(url)
      } catch {
        return null
      }
      return action('open_url', `Open ${url}`, { url })
    },
  },
  {
    intent: 'list_directory',
    readOnly: true,
    test: (text) =>
      // "show ~/Downloads" is left off deliberately: it reads as "open it in
      // Finder" at least as often as "list it", and open_path claims it below.
      /^(?:please\s+)?(?:list|show me|what(?:'s|s| is)\s+in)\s+(?:the\s+)?(?:contents\s+of\s+)?(~(?:\/\S*)?|\/\S+)\/?$/i.exec(
        text,
      ),
    build: (match) => {
      const target = existingPath(match[1])
      // Only a directory that is actually there — a typo must reach the model,
      // which can look around, rather than fail as a dead deterministic hit.
      if (!target || !target.isDirectory) return null
      return action('list_directory', `List ${target.path}`, {
        path: target.path,
      })
    },
  },
  {
    intent: 'open_path',
    readOnly: false,
    test: (text) =>
      /^(?:please\s+)?(?:open|show|reveal)\s+(?:the\s+)?(~(?:\/\S*)?|\/\S+)\/?$/i.exec(
        text,
      ),
    build: (match) => {
      const target = existingPath(match[1])
      if (!target) return null
      return action('open_path', `Open ${target.path}`, { path: target.path })
    },
  },
  {
    /*
     * A briefing is one action whatever the phrasing, and it is the one the
     * owner most wants to survive a bad day: "every morning" is a promise, and
     * a 7am routine that needs a model round-trip keeps that promise only while
     * the API is up. compose_briefing picks its own sources, so there is no
     * slot here for a wrong guess to land in.
     */
    intent: 'compose_briefing',
    readOnly: false,
    test: (text) => matchBriefingCommand(text),
    build: (kind) =>
      action('compose_briefing', `Compose the ${kind} brief`, { kind }),
  },
  {
    /*
     * "Triage my inbox" is a standing phrase with one meaning, and the module
     * behind it cannot send — so there is no slot here a wrong guess could land
     * in either. The matcher carries the draft cap out of the phrasing because
     * "the top three" is the owner naming a number, not a synonym.
     */
    intent: 'triage_inbox',
    readOnly: false,
    test: (text) => matchMailTriageCommand(text),
    build: (options) =>
      action('triage_inbox', 'Triage the inbox and draft replies', options),
  },
  {
    intent: 'meeting_followup',
    readOnly: false,
    test: (text) => matchMeetingFollowupCommand(text),
    build: (options) =>
      action('meeting_followup', 'Open the meeting follow-up workspace', options),
  },
  {
    intent: 'open_app',
    readOnly: false,
    needsMachine: true,
    test: (text) =>
      /^(?:please\s+)?(?:open|launch|start|fire\s+up|bring\s+up)\s+(?:the\s+)?([A-Za-z0-9][A-Za-z0-9 .'&+-]{0,38}?)(?:\s+app(?:lication)?)?$/i.exec(
        text,
      ),
    build: (match, { machine }) => {
      const requested = match[1].trim()
      const installed = machine?.applications ?? []
      const resolved = findClosestInstalledApp(requested, installed)
      // findClosestInstalledApp will happily return a 50%-token-overlap guess.
      // Good enough for a model that can explain itself; not good enough to
      // launch something the owner did not name. Exact or containment only.
      if (!resolved || !isTightAppMatch(requested, resolved)) return null
      return action('open_app', `Open ${resolved}`, { appName: resolved })
    },
  },
]

/**
 * The one action this utterance unambiguously means, or null.
 *
 * Null is the safe answer and the common one: it just means the request buys a
 * model call. A non-null answer is a promise that no planner could have done
 * better, so every matcher validates its slots against the real machine
 * (installed apps, paths that exist) before claiming the request.
 */
export async function matchDeterministic(command, { machine = null } = {}) {
  const text = normalize(stripContextTrailer(command))

  if (!text || text.length > MAX_DETERMINISTIC_CHARS) return null
  if (MULTI_STEP.test(text)) return null

  let machineContext = machine

  for (const matcher of DETERMINISTIC_MATCHERS) {
    const match = matcher.test(text)
    if (!match) continue

    if (matcher.needsMachine && !machineContext) {
      machineContext = await getMachineContext().catch(() => null)
    }

    const built = matcher.build(match, { machine: machineContext })
    if (!built) continue

    return {
      intent: matcher.intent,
      readOnly: Boolean(matcher.readOnly),
      actions: [built],
      matchedText: text,
    }
  }

  return null
}

/**
 * Which tier plans this request. Deterministic matches are decided already;
 * everything else is a guess that only costs money, never capability.
 */
export function classifyTier(command, { source = 'local', deterministic = null } = {}) {
  if (deterministic) {
    return {
      tier: TIER_DETERMINISTIC,
      reason: `matched ${deterministic.intent} exactly — no model needed`,
    }
  }

  const text = String(command ?? '').trim()

  if (!text) {
    return { tier: TIER_PLANNER, reason: 'empty command — let the planner answer' }
  }

  /*
   * A routine fires while the owner is asleep or busy. Latency is free and the
   * turn is not a conversation, so it has no claim on the expensive tier.
   */
  if (source === 'routine') {
    return { tier: TIER_BACKGROUND, reason: 'routine — nobody is waiting on this turn' }
  }

  if (NEEDS_JUDGEMENT.test(text)) {
    return { tier: TIER_PLANNER, reason: 'wording implies multi-step or open-ended work' }
  }

  if (NEEDS_FULL_SCHEMA.test(text)) {
    return { tier: TIER_PLANNER, reason: 'needs action types outside the small-tier schema' }
  }

  if (OPEN_QUESTION.test(text)) {
    return { tier: TIER_PLANNER, reason: 'an unrecognised question wants an answer, not an action' }
  }

  if (text.length > 120) {
    return { tier: TIER_PLANNER, reason: 'long request — likely several steps' }
  }

  /*
   * The old fuzzy intent table, boiled down to keywords. A hit does not tell
   * us which action to run (it was wrong often enough that the orchestrator
   * stopped asking), but it is a fine signal that the request is small.
   */
  const hint = isSmallRequest(text)
  if (hint.small) {
    return { tier: TIER_BACKGROUND, reason: `simple ${hint.intent} request` }
  }

  if (text.split(/\s+/).length <= 12) {
    return { tier: TIER_BACKGROUND, reason: 'short single-clause request' }
  }

  return { tier: TIER_PLANNER, reason: 'default — ambiguous enough to deserve the full planner' }
}

function action(type, label, params) {
  return { type, label, params }
}

function normalize(command) {
  return String(command ?? '')
    .trim()
    .replace(/\s+/g, ' ')
    .replace(/[.!]+$/, '')
}

function existingPath(raw) {
  try {
    const resolved = resolveUserPath(raw)
    const stats = fs.statSync(resolved)
    return { path: resolved, isDirectory: stats.isDirectory() }
  } catch {
    return null
  }
}

/*
 * Whole words only, in both directions. Raw substring containment looked right
 * until "open my email" resolved to Mail — "email" contains "mail" — and
 * launching an app the owner did not name is exactly the failure a path that
 * skips the model must not have. "chrome" → "Google Chrome" still matches,
 * because that is one token set inside the other rather than one string inside
 * the other.
 */
function isTightAppMatch(requested, resolved) {
  const left = tokensOf(requested)
  const right = tokensOf(resolved)
  if (!left.length || !right.length) return false
  const [small, large] = left.length <= right.length ? [left, right] : [right, left]
  return small.every((token) => large.includes(token))
}

function tokensOf(value) {
  return normalizeAppName(value).split(' ').filter(Boolean)
}

function normalizeAppName(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/\.app$/i, '')
    .replace(/[^a-z0-9]+/g, ' ')
    .trim()
}

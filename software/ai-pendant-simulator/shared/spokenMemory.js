/*
 * The first writer on the cross-surface memory log: what the owner says out
 * loud to the pendant.
 *
 * shared/fleetMemory.js was built, tested, migrated and mounted with nothing
 * feeding it. Its read side was already wired — cloud-relay/fleetContext.js
 * folds the log into every voice prompt through loadFleetFromStore() — so the
 * relay has been reading an empty table on every conversation. This module is
 * the other end of that pipe, and it is deliberately the narrowest one worth
 * having: the owner's own words are the highest-confidence memory on the
 * fleet, and the relay is the only body that hears them.
 *
 * Why the relay and not the Mac. local-agent/quickCapture.js already does this
 * job, better, with an archive behind it — but only on the Mac, only for an
 * utterance that reached the Mac, and it writes to a 0600 file on that machine
 * that no other body can read. The pendant talks to the relay whether or not
 * the Mac is awake; that is the premise of the product. A fact stated to a
 * sleeping house is a fact lost.
 *
 * Why regexes and not a model. This runs inside the duplex voice loop, on the
 * turn boundary, where the budget is "free". A second model call per turn to
 * decide whether the owner said something worth keeping costs more than the
 * memory is worth and adds a failure mode to the audio path. The vocabulary
 * below is the same shape local-agent/quickCapture.js already uses for spoken
 * capture on this project, so this is the house idiom rather than a new guess.
 * The end state is the model calling a `remember` tool with a key it chose;
 * this is what carries memory until then, and its precision-over-recall bias
 * is chosen with that in mind — a wrong fact is paid for on every future turn
 * and is confidently wrong, while a missed one costs one utterance.
 *
 * Pure: no filesystem, no network, no clock of its own. The relay runs on
 * workerd, so a module that reached for `node:fs` — as quickCapture.js must,
 * through memoryService.js — could not be imported here at all.
 */
import { classifySensitivity } from '../local-agent/redaction.js'
import { appendFleetMemory, MEMORY_TTL_MS } from './fleetMemory.js'

/*
 * Which body wrote it, as it will read in the prompt: `- ... [voice 08-07 12:01]`.
 * Node names are free text on the wire; this one names the surface that heard
 * the words rather than the process, because "who heard this" is what a reader
 * weighs and the process is an implementation detail that will change.
 */
export const SPOKEN_MEMORY_NODE = 'voice'

/*
 * The two byte budgets this writer adds, both in BYTES and neither in items.
 *
 * MAX_UTTERANCE_BYTES bounds one turn's transcript before it is parsed. A
 * runaway transcription — a stuck VAD, a radio picked up by the mic — must not
 * become a 40 KB `entity` value that fleetMemory then clips one character at a
 * time. 600 bytes is comfortably longer than anything a person says in one
 * breath and shorter than any transcription failure observed on this project.
 *
 * MAX_SESSION_BYTES bounds one conversation's total contribution. This is the
 * bound that matters, and it is new: fleetMemory caps the whole log at
 * MAX_LOG_BYTES, but preferences evict LAST, so a single talkative session
 * emitting standing choices could crowd out every other body's facts and the
 * log would still be perfectly within budget. 4 KB is roughly eight spoken
 * facts — more than a conversation produces, and a hard stop if one does not
 * stop.
 */
export const MAX_UTTERANCE_BYTES = 600
export const MAX_SESSION_BYTES = 4096

/*
 * A spoken tombstone's lifetime.
 *
 * Retractions otherwise inherit their type's TTL, which for a preference is
 * "never" — and a permanent tombstone in the tier that evicts LAST is a slow
 * leak pointed at the most valuable rows in the log. The usual reason to keep
 * a tombstone forever is a replicated store where an old copy could re-sync
 * the fact it cancelled; this log has exactly one home (the relay store), and
 * compaction deletes the retracted row on the very next append. So the
 * tombstone only has to outlive that, and it is given the entity lifetime
 * rather than the preference one.
 */
export const SPOKEN_RETRACTION_TTL_MS = MEMORY_TTL_MS.entity

/*
 * The highest sensitivity this writer will put on the wire.
 *
 * 'secret' is refused, and that is a deliberate asymmetry with quickCapture.js
 * rather than an oversight. That module stores a spoken passcode in one file,
 * mode 0600, on the owner's own machine, and puts only a label in the archive.
 * This log lives off-device in D1, is replicated by the platform, is read into
 * a third-party prompt on every turn, and has no per-fact access control. The
 * projection would mask the value, but "masked in the one reader we have
 * today" is not the same guarantee as "never left the house". A bike lock code
 * said out loud belongs on the Mac.
 *
 * 'sensitive' (an address, a phone number) is allowed, because the projection
 * already withholds it unless the request is actually about it, and because a
 * memory system that cannot hold the owner's own phone number is not one.
 *
 * A parameter, not a constant in a branch: a body with a different store — an
 * on-device one — should be able to raise it without editing this file.
 */
export const DEFAULT_MAX_SENSITIVITY = 'sensitive'
const SENSITIVITY_RANK = Object.freeze({ normal: 0, sensitive: 1, secret: 2 })

/* ---- the vocabulary ------------------------------------------------------ */

/*
 * "Stop remembering this." Leads the recognizers because "forget my address"
 * contains no capture lead-in and would otherwise fall through to "not a
 * stated fact" — leaving the owner with a memory system that can be written to
 * and not erased, which is the one property a durable personal store must not
 * have.
 */
const FORGET_SHAPES = [
  /^(?:please\s+)?forget\s+(?:what\s+i\s+(?:said|told\s+you)\s+about\s+)?(?<subject>.+)$/i,
  /^(?:please\s+)?(?:stop\s+remembering|delete|erase)\s+(?<subject>.+)$/i,
]

/*
 * "This next part is the payload." Ordered longest-first so "save this idea
 * for later" is not clipped by "save this" — the same ordering hazard, and the
 * same fix, as local-agent/quickCapture.js.
 */
const CAPTURE_LEAD_INS = [
  /^(?:hey\s+)?(?:pendant|assistant)[,:\s]+/i,
  /^save\s+this\s+idea\s+for\s+later\b[:,.\s–—-]*/i,
  /^save\s+(?:this|that|it)\s+for\s+later\b[:,.\s–—-]*/i,
  /^(?:make|take)\s+a\s+(?:quick\s+)?note\s*(?:of|that|:)?\s*/i,
  /^(?:don'?t\s+let\s+me\s+forget|remind\s+me\s+that)\b[:,.\s–—-]*/i,
  /^remember\s+(?:this|that|it)\b[:,.\s–—-]*/i,
  /^(?:jot|write)\s+(?:this|that)\s+down\b[:,.\s–—-]*/i,
  /^keep\s+(?:this|that)\s+in\s+mind\b[:,.\s–—-]*/i,
  /^save\s+(?:this|that)\b[:,.\s–—-]*/i,
  /^remember\b[:,.\s–—-]*/i,
  /^note\b[:,.\s–—-]*/i,
]

/*
 * A standing instruction: behaviour from now on, not news.
 *
 * Tight on purpose, and anchored at the start of the utterance. "you always do
 * that" and "I never get the notification" are ordinary complaints, not
 * standing choices, and a preference never expires — the cost of a false
 * positive here is a wrong line in every prompt for the life of the log, while
 * the cost of a false negative is that the owner says it again.
 */
const PREFERENCE_SHAPES = [
  /^(?:from\s+now\s+on|going\s+forward|in\s+future|in\s+the\s+future)\b[,:\s]+(?<value>.+)$/i,
  /^(?:i|i'?d)\s+(?:would\s+)?(?:prefer|like)\s+(?:it\s+)?(?:if\s+you\s+|you\s+to\s+)?(?<value>.+)$/i,
  /^(?:always|never)\s+(?<value>.+)$/i,
  /^call\s+me\s+(?<value>.+)$/i,
]

/* "my bike lock code is 4829" — a subject the owner can ask for by name. */
const FACT_SHAPE =
  /^(?:my|our|the)\s+(?<subject>[\p{L}\p{N}][\p{L}\p{N}\s'’/-]{1,58}?)\s+(?:is|are|=)\s+(?<value>.+)$/iu

/* ---- extraction ---------------------------------------------------------- */

/**
 * Read one owner utterance and say what, if anything, it asked to be
 * remembered.
 *
 * Returns event INPUTS, not normalized records: the caller owns the `node`
 * stamp, because a body that lies about which surface heard something breaks
 * the only provenance a cross-node reader has.
 *
 * `skipped` is returned rather than swallowed for the same reason
 * normalizeMemoryEvents() reports its rejections: an extractor that silently
 * declines is indistinguishable from one that is broken, and this one declines
 * on almost every turn by design.
 */
export function extractSpokenMemory(
  utterance,
  {
    now = Date.now(),
    maxUtteranceBytes = MAX_UTTERANCE_BYTES,
    maxSensitivity = DEFAULT_MAX_SENSITIVITY,
    /* Empty means every body. The owner's own words are not scoped to the
     * surface that happened to hear them — that is the entire point of a
     * cross-surface log. */
    surfaces = [],
  } = {},
) {
  const raw = collapse(utterance)
  if (!raw) return { events: [], skipped: [{ reason: 'nothing was said' }] }

  if (Buffer.byteLength(raw) > maxUtteranceBytes) {
    /*
     * Refused whole rather than truncated. A transcript this long is a
     * transcription fault, not a long sentence, and the first 600 bytes of a
     * fault is still a fault — stored, it would be a confident memory of
     * nothing.
     */
    return {
      events: [],
      skipped: [{ reason: 'utterance over the byte budget', bytes: Buffer.byteLength(raw) }],
    }
  }

  const forgotten = matchForget(raw)
  if (forgotten) return { events: forgotten, skipped: [] }

  const captured = matchCapture(raw, now)
  if (!captured) return { events: [], skipped: [{ reason: 'not a stated fact' }] }

  const sensitivity = classifySensitivity(captured.value)
  if (rankOf(sensitivity) > rankOf(maxSensitivity)) {
    /*
     * The subject travels in the refusal and the value never does — this
     * result is logged by the caller, and a refusal that prints the passcode
     * it refused to store is worse than storing it.
     */
    return {
      events: [],
      skipped: [{ reason: 'too sensitive for the fleet log', sensitivity, key: captured.key }],
    }
  }

  return {
    events: [
      {
        type: captured.type,
        key: captured.key,
        value: captured.value,
        surfaces,
        /* The owner said it themselves. There is nothing to be unsure about,
         * and the projection uses confidence to decide whether to hedge a line
         * with "(?)" — hedging the owner's own words back at them reads as a
         * malfunction. */
        confidence: 1,
        sensitivity,
      },
    ],
    skipped: [],
  }
}

/*
 * "Forget my address" has to work whether the fact was written as a keyed
 * `owner.*` entity or as a standing preference, and the owner cannot be
 * expected to remember which shape they used. So a forget emits a tombstone in
 * both namespaces. Two small rows with a bounded lifetime is the cheap half of
 * that trade; the expensive half is a delete that silently misses.
 */
function matchForget(text) {
  for (const shape of FORGET_SHAPES) {
    const match = text.match(shape)
    if (!match) continue
    const subject = normalizeSubject(stripPossessive(match.groups.subject))
    if (!subject) break
    if (slug(subject) === 'note') break // nothing nameable in it; see slug()
    // Each tombstone is slugged the way its own namespace is written, or it
    // would land beside the row it is meant to bury rather than on it.
    return [
      {
        type: 'entity',
        key: `owner.${slug(subject)}`,
        retract: true,
        ttlMs: SPOKEN_RETRACTION_TTL_MS,
      },
      {
        type: 'preference',
        key: `preference.${slug(subject, PREFERENCE_KEY_WORDS)}`,
        retract: true,
        ttlMs: SPOKEN_RETRACTION_TTL_MS,
      },
    ]
  }
  return null
}

function matchCapture(text, now) {
  const preference = matchPreference(text)
  if (preference) return preference

  const stripped = stripLeadIn(text)
  // No lead-in and no standing shape: the owner was talking, not filing.
  if (stripped === text) return null
  if (!stripped) return null

  // A lead-in wrapping a standing instruction is still a standing instruction:
  // "remember that from now on I want one-sentence answers".
  const wrapped = matchPreference(stripped)
  if (wrapped) return wrapped

  const fact = stripped.match(FACT_SHAPE)
  if (fact) {
    const subject = normalizeSubject(fact.groups.subject)
    const detail = fact.groups.value.trim().replace(/[.\s]+$/, '')
    return {
      type: 'entity',
      key: `owner.${slug(subject)}`,
      /* Stored as "subject: detail" so masking leaves a usable label behind —
       * "bike lock code: [withheld]" still tells a reader the fact exists. It
       * is also what makes the projection line read as a sentence. */
      value: `${subject}: ${detail}`,
    }
  }

  /*
   * A remembered statement with no "my X is Y" shape — "remember that Nico
   * reviews the firmware". Keyed on its own opening clause so restating the
   * same thing overwrites rather than accumulates, and dated so two unrelated
   * notes that happen to open the same way in different weeks do not silently
   * overwrite each other.
   */
  const clause = firstClause(stripped)
  return {
    type: 'entity',
    key: `owner.${new Date(now).toISOString().slice(0, 10)}.${slug(clause)}`,
    value: stripped,
  }
}

function matchPreference(text) {
  for (const shape of PREFERENCE_SHAPES) {
    const match = text.match(shape)
    if (!match) continue
    const value = collapse(match.groups.value).replace(/[.\s]+$/, '')
    if (!value) continue
    return {
      type: 'preference',
      key: `preference.${slug(value, PREFERENCE_KEY_WORDS)}`,
      value,
    }
  }
  return null
}

/* ---- the writer ---------------------------------------------------------- */

/**
 * A per-conversation writer with its own byte budget.
 *
 * Stateful on purpose. The budget has to be per conversation, not per
 * utterance: one utterance is already bounded, and the failure this guards
 * against is a hundred of them. A fresh writer per conversation also means the
 * budget cannot be exhausted by yesterday.
 *
 * `remember()` never throws and never rejects. It is called from the audio
 * turn boundary in cloud-relay/pendantConverse.js, where an unhandled
 * rejection ends the owner's conversation; losing a fact is survivable, losing
 * the call is not.
 */
export function createSpokenMemoryWriter({
  store,
  node = SPOKEN_MEMORY_NODE,
  surfaces = [],
  budgetBytes = MAX_SESSION_BYTES,
  maxSensitivity = DEFAULT_MAX_SENSITIVITY,
  now = () => Date.now(),
} = {}) {
  let spent = 0
  const totals = { appended: 0, bytes: 0, skipped: 0, refused: 0 }

  return {
    stats: () => ({ ...totals, budgetBytes, remainingBytes: Math.max(0, budgetBytes - spent) }),

    async remember(utterance) {
      const at = typeof now === 'function' ? now() : now
      const { events, skipped } = extractSpokenMemory(utterance, {
        now: at,
        maxSensitivity,
        surfaces,
      })

      if (!events.length) {
        totals.skipped += skipped.length
        return { ok: true, appended: 0, skipped }
      }

      if (spent >= budgetBytes) {
        totals.refused += events.length
        return {
          ok: true,
          appended: 0,
          skipped: [...skipped, { reason: 'session memory budget spent', budgetBytes }],
        }
      }

      try {
        const { status, body } = await appendFleetMemory(
          store,
          { node, events },
          { now: at },
        )
        if (status !== 201) {
          totals.refused += events.length
          return { ok: false, appended: 0, error: body?.error || `status ${status}`, skipped }
        }

        /*
         * Charged against the budget by what was actually written, not by what
         * was offered: fleetMemory clips a fat value to MAX_EVENT_BYTES, and a
         * budget that bills for the unclipped size would refuse writes the log
         * has room for.
         */
        spent += Number(body.bytes) || 0
        totals.appended += Number(body.appended) || 0
        totals.bytes += Number(body.bytes) || 0
        return { ok: true, appended: body.appended, bytes: body.bytes, skipped }
      } catch (error) {
        /* A store with no memory table, or a store that is simply down. The
         * conversation continues; that is the whole contract of this call. */
        totals.refused += events.length
        return { ok: false, appended: 0, error: error?.message || 'append failed', skipped }
      }
    },
  }
}

/* ---- helpers ------------------------------------------------------------- */

export function stripLeadIn(utterance) {
  let text = collapse(utterance)
  for (const pattern of CAPTURE_LEAD_INS) {
    const stripped = text.replace(pattern, '')
    if (stripped !== text) {
      text = stripped.trim()
      break
    }
  }
  return text.replace(/^["“']|["”']$/g, '').trim()
}

function rankOf(sensitivity) {
  return SENSITIVITY_RANK[String(sensitivity)] ?? SENSITIVITY_RANK.secret
}

/* "my sister's name" and "sister's name" are the same subject to a listener. */
function stripPossessive(subject) {
  return String(subject ?? '').replace(/^(?:my|our|the)\s+/i, '')
}

function normalizeSubject(subject) {
  return String(subject ?? '')
    .trim()
    .replace(/[.!?]+$/, '')
    .replace(/\s+/g, ' ')
    .toLowerCase()
}

function firstClause(text) {
  const clause = String(text).split(/[.;\n]/)[0].trim() || String(text).trim()
  return clause.length <= 80 ? clause : `${clause.slice(0, 77)}...`
}

/*
 * Preference keys are deliberately coarser than entity keys — three words, not
 * six.
 *
 * A standing instruction is about a topic, and two standing instructions about
 * the same topic must not both be true: "from now on answer in one sentence"
 * followed a week later by "from now on answer in one line" is one preference
 * changed, not two preferences held. Six words would key those apart and the
 * prompt would carry both, forever, since preferences never expire. Three
 * words folds them onto one key, which is what makes the newest statement win.
 *
 * It also keeps the rendered line honest. The projection prints a preference
 * as `- key: value`, and a key slugged from the whole value prints the same
 * sentence twice on every turn.
 */
const PREFERENCE_KEY_WORDS = 3

/*
 * Six words for a named fact, so a restatement with a trailing qualifier still
 * lands on the same key and overwrites. 'note' when nothing nameable survives,
 * which the callers treat as "there was no subject here" rather than storing
 * under it.
 */
function slug(text, words = 6) {
  return (
    normalizeText(text)
      .split(' ')
      .filter(Boolean)
      .slice(0, words)
      .join('-') || 'note'
  )
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

function collapse(value) {
  return String(value ?? '')
    .replace(/\s+/g, ' ')
    .trim()
}

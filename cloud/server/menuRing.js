/*
 * The app ring, as a pure function of the knob and the two buttons.
 *
 * WHY THIS FILE EXISTS. The owner, 2026-08-12: "we need to build more default
 * programs into the firmware for more simple things like time and also timer,
 * reminder, calendar, etc. kind of like an ios but remember our i/o with the
 * user has no screen, so a lot of things will have to be changed to create a
 * seamless and intuitive experience where the user knows how to operate."
 * docs/Screenless_App_Grammar.md is the answer in prose; this is the answer in
 * code, and the two must not drift.
 *
 * SELECT IS A BUTTON. THE BUTTONS ARE CONTEXT-SENSITIVE. (Owner, 2026-08-13:
 * "remember we can use the fucking buttons bro, right now it seems like you're
 * using stopping the turning as confirmation for selecting but we should just
 * use a button. only when no [app] is selected those buttons are reserved for
 * the llm talk and the memo.")
 * ---------------------------------------------------------------------------
 * The previous draft committed on DWELL — 1.5 s of stillness after a detent.
 * That is gone as a commit gesture, and the reasoning against it is worth
 * keeping because it is the reasoning FOR what replaced it. Dwell made the
 * pendant's most consequential act — starting a thing, connecting a thing — the
 * one act the owner performs by doing nothing, on a device that hangs from a
 * lanyard and gets bumped. It also cost 1.5 s on every single selection, and it
 * could not distinguish "I have chosen" from "I am thinking".
 *
 * The bench has two working buttons and an encoder with no switch. Both buttons
 * already carry a global verb the owner refuses to give up (talk, memo). There
 * is no third button. So the only variable left is CONTEXT — and context is
 * enough, because the two states are perfectly disjoint from the owner's point
 * of view:
 *
 *   ring CLOSED   yellow = talk (short) / push-to-talk question (long)
 *                 blue   = memo
 *   ring OPEN     yellow = select / confirm what the ring is pointing at
 *                 blue   = back, one level up; from the top level it closes
 *                          the ring and both buttons become global again
 *
 * This is why the relay must TELL the device which state it is in — see
 * `menuContextFrame` below and the `context` effect. The device cannot infer
 * it: the ring lives here, not there.
 *
 * THE ONE HARD RULE IT STILL ENFORCES: no flow may require two presses to
 * initiate. The yellow press that opens the conversation is the one press.
 * The first detent opens the ring AND lands on its home entry — an opening
 * detent that merely "unlocked" the ring would be exactly the second gesture
 * the grammar forbids.
 *
 * WHAT THE SETTLE STILL DOES. The ~200 ms settle survives untouched, and it was
 * never a selection mechanism: it is about when the ring is allowed to SPEAK.
 * A detent is a blip rendered locally; the name (or, in a numeric field, the
 * bare number) is spoken once the hand stops, so a fast spin costs one sentence
 * instead of forty. Selection and speech are now cleanly different things
 * triggered by cleanly different events, which is what dwell conflated.
 *
 * PURE ON PURPOSE. The relay holds the menu (the pendant is stateless — the
 * firmware's whole contribution is {"type":"menu",delta:±1} per detent,
 * {"type":"menu_select"} per yellow press in-ring and {"type":"menu_back"} per
 * blue press in-ring), but holding it and DECIDING it are different jobs.
 * Everything that can be decided without a socket, a store or a clock lives
 * here and is tested here; pendantConverse.js does the speaking.
 */

import { HINTS, appEntrySpeech } from './controlVocabulary.js'

/*
 * The ring, in the order the owner scrolls it. Time first because it is the
 * cheapest question a screenless device gets asked, and because a one-shot
 * surface at the home position means the most common interaction is
 * turn-once-and-press rather than turn-five-times-and-press.
 *
 * 'back' is the last entry and remains a ring entry even though blue now does
 * the same job. Two ways out, on purpose: blue is the fast one for an owner who
 * knows it, and the `Back` entry is the one a first-time owner DISCOVERS by
 * turning the knob, without having been told anything. Removing it would make
 * escape depend entirely on a sentence the owner may have talked over.
 */
export const APP_RING = Object.freeze([
  'time',
  'timer',
  'alarm',
  'reminders',
  'calendar',
  'audio',
  'back',
])

/*
 * Timer presets: a fast path, not the whole story.
 *
 * The previous draft had six presets and NO free entry, on the theory that a
 * screenless number picker is a spinner with no readout. The numeric field
 * below is that readout — it speaks the number — so the argument expired. Three
 * presets survive because they cover the common cases in one or two detents,
 * and 'Custom' is one more detent past them for everything else.
 */
export const TIMER_PRESET_MINUTES = Object.freeze([5, 10, 25])

export const TIMER_CUSTOM_ENTRY = 'timer:custom'

export const TIMER_RING = Object.freeze([
  ...TIMER_PRESET_MINUTES.map((minutes) => `timer:${minutes}`),
  TIMER_CUSTOM_ENTRY,
  'back',
])

/*
 * The pendant's own speaker, as the second-to-last entry on the Audio ring.
 *
 * A ring of headphones with no way back to the speaker can strand the owner's
 * audio in a pair of earbuds sitting in a drawer. Selecting it sends
 * {"type":"audio_sink","sink":"speaker"}; selecting a headphone sends bt_select
 * AND audio_sink 'bluetooth', because choosing where sound goes and connecting
 * the thing it goes to are one intention.
 */
export const AUDIO_SPEAKER_ENTRY = 'audio:speaker'

/*
 * The honest end-of-list marker, present only while a scan is still running.
 *
 * The owner can use the remembered devices the instant the ring opens — those
 * arrive from the device's own table and need no radio time — but discovery
 * takes seconds. An owner who scrolls to the bottom in that window must not
 * conclude the list is complete. This entry says so in two words, and selecting
 * it does nothing but say them again: it is a sign, not a door.
 */
export const AUDIO_SCANNING_ENTRY = 'audio:scanning'

/** Spoken names. Kept beside the ring so a new entry cannot ship nameless —
 * an unnamed position on a screenless ring is a silent one. */
const APP_NAMES = Object.freeze({
  time: 'Time.',
  timer: 'Timer.',
  alarm: 'Alarm.',
  reminders: 'Reminders.',
  calendar: 'Calendar.',
  audio: 'Audio devices.',
  back: 'Back.',
  [TIMER_CUSTOM_ENTRY]: 'Custom.',
  [AUDIO_SPEAKER_ENTRY]: 'Pendant speaker.',
  AUDIO_SCANNING: 'Still searching.',
})

/*
 * Which hint each app speaks when you enter it. The hints themselves live in
 * controlVocabulary.js and are COMPOSED from the control table there, so a
 * remap rewrites every one of these sentences at once. This map holds only the
 * association between an app and its hint — no words.
 */
const APP_HINT_KEYS = Object.freeze({
  time: 'time',
  timer: 'timer',
  alarm: 'alarm',
  reminders: 'reminders',
  calendar: 'calendar',
  audio: 'audio',
})

export function minutesLabel(minutes) {
  const count = Number(minutes)
  if (!Number.isFinite(count) || count <= 0) return ''
  if (count === 60) return '1 hour'
  return `${count} minute${count === 1 ? '' : 's'}`
}

/** The words for one ring entry, with no hint attached. */
export function entryName(entry) {
  const id = String(entry ?? '')
  if (id === TIMER_CUSTOM_ENTRY) return APP_NAMES[TIMER_CUSTOM_ENTRY]
  if (id === AUDIO_SCANNING_ENTRY) return APP_NAMES.AUDIO_SCANNING
  if (id.startsWith('timer:')) return `${minutesLabel(id.slice(6))}.`
  /* A remembered sink's name comes from the device, so it is carried in the
   * entry itself rather than looked up in a table this relay cannot know. */
  if (id.startsWith('audio:dev:')) return `${id.slice(10)}.`
  /* A device the scan just found, and the owner has never used. The extra word
   * is the difference between "reconnect the thing I use" and "pair something
   * new", which is the only distinction that matters on this ring. */
  if (id.startsWith('audio:new:')) return `${id.slice(10)}. New.`
  return APP_NAMES[id] ?? ''
}

/* ------------------------------------------------------- numeric entry */

/*
 * NUMERIC FIELDS, and the four rules the owner set on 2026-08-13.
 *
 *   1. ONE DETENT = ONE UNIT, at any speed. No acceleration, no coarse steps.
 *      Acceleration is a screen affordance: it works because your eye watches
 *      the number race and your hand corrects. With no readout until the hand
 *      STOPS, an accelerating spinner is unsteerable — you learn where you
 *      landed only after you can no longer influence it. A linear knob is
 *      slower and always exactly predictable, and predictable is the only
 *      currency a screenless control has.
 *   2. The field is announced ONCE, on entry: "Setting minutes."
 *   3. Every settle speaks THE BARE NUMBER: "seven." No units, no sentence.
 *      A unit repeated per detent is a device talking over its own owner.
 *   4. Yellow commits, and the confirmation repeats the value WITH units once.
 *
 * BOUNDARIES DIFFER BY KIND, deliberately, and both ends are audible.
 * A duration STOPS: wrapping would let one extra detent turn a 180-minute
 * timer into a 1-minute one, and the owner would not find out until the thing
 * they were timing burned. A clock field WRAPS: a clock is a circle, 23→0 and
 * 59→0 are how time actually behaves, and no wrap here can produce a value
 * that means something wildly different from the one beside it. Hitting a stop
 * plays a distinct 'edge' earcon and re-speaks the same number, so a stop is
 * never silent — silence at a boundary is indistinguishable from a dead knob.
 */
const NUMBER_FIELDS = Object.freeze({
  timer: Object.freeze([
    Object.freeze({
      key: 'minutes',
      /* Spoken as "Setting minutes." — the label carries its own article so
       * "the hour" and "minutes" can both read naturally in one template. */
      label: 'minutes',
      min: 1,
      max: 180,
      start: 10,
      wrap: false,
    }),
  ]),
  alarm: Object.freeze([
    Object.freeze({
      key: 'hour',
      label: 'the hour',
      /*
       * 24-hour, and no AM/PM field. A third field on a screenless spinner is a
       * third thing to get lost inside, and the owner would have to hold two
       * numbers and a meridiem in their head with nothing to look at. Scrolling
       * 0..23 says "fourteen" where a 12-hour field would say "two" and leave
       * the owner genuinely unsure which two. The CONFIRMATION converts back to
       * the way people speak — "Alarm set for 2:30 PM" — so the awkward
       * representation never survives past the commit.
       */
      min: 0,
      max: 23,
      start: 7,
      wrap: true,
    }),
    Object.freeze({
      key: 'minute',
      label: 'minutes',
      min: 0,
      max: 59,
      start: 0,
      wrap: true,
    }),
  ]),
})

export function numberFields(app) {
  return NUMBER_FIELDS[String(app)] ?? null
}

/** "Setting minutes." — said once, when a field opens. */
export function fieldAnnouncement(field) {
  return `Setting ${field.label}.`
}

/**
 * One step within a field's bounds.
 *
 * Returns the new value AND whether the move was refused, because a refusal is
 * something the owner has to HEAR. Kept pure and exported so the one-detent-one
 * -unit promise can be tested directly rather than inferred from the reducer.
 */
export function stepFieldValue(field, value, step) {
  const span = field.max - field.min + 1
  const raw = Number(value) + (step > 0 ? 1 : -1)
  if (field.wrap) {
    return { value: field.min + (((raw - field.min) % span) + span) % span, atEdge: false }
  }
  if (raw < field.min) return { value: field.min, atEdge: true }
  if (raw > field.max) return { value: field.max, atEdge: true }
  return { value: raw, atEdge: false }
}

/** 14 and 30 -> "2:30 PM". The commit line's job, and the reason the hour field
 * can afford to be 24-hour while the owner is turning it. */
export function clockLabel(hour, minute) {
  const h24 = ((Math.trunc(Number(hour) || 0) % 24) + 24) % 24
  const m = ((Math.trunc(Number(minute) || 0) % 60) + 60) % 60
  const h12 = h24 % 12 === 0 ? 12 : h24 % 12
  return `${h12}:${String(m).padStart(2, '0')} ${h24 < 12 ? 'AM' : 'PM'}`
}

export function createMenuState() {
  /*
   * Closed, at home, every time. The doc's call: "The conversation ending
   * resets the menu to closed. Next press starts at the ring's home position —
   * predictable beats persistent for a ring this short." A ring that resumed
   * where it was left would make the same gesture mean different things on
   * different presses, which on a device with no screen is indistinguishable
   * from a bug.
   */
  return {
    mode: 'closed',
    appIndex: 0,
    timerIndex: 0,
    audioIndex: 0,
    audioDevices: [],
    audioDiscovered: [],
    audioScanning: false,
    number: null,
  }
}

/** True while the ring owns the buttons. The single fact the device needs from
 * the relay, and the thing `menuContextFrame` carries. */
export function menuIsOpen(state) {
  return Boolean(state) && state.mode !== 'closed'
}

/**
 * The frame that tells the device which meaning its buttons currently have.
 *
 * The device cannot work this out for itself — the ring lives here. See the
 * contract note in docs/Screenless_App_Grammar.md; the important half is the
 * FAILURE mode, which is the device's to implement: if this frame is lost, the
 * device falls back to the GLOBAL meanings. A dropped frame then costs the
 * owner a stray memo, which is recoverable and audible; the alternative —
 * defaulting to ring meanings — costs them a button that silently does nothing,
 * on the one device that cannot show them why.
 */
export function menuContextFrame(state) {
  return { type: 'menu_context', active: menuIsOpen(state) }
}

/* ------------------------------------------------------------ the rings */

/**
 * The Audio devices ring: what you already use, THEN what is nearby.
 *
 * Ordering is the whole design here. The owner, watching the pendant chase one
 * speaker: "shouldn't it discover the bluetooth devices and prioritize those
 * that were connected before?" So remembered sinks come first in
 * most-recently-used order (the device's own table is already in that order and
 * this function does not re-sort it — the device knows when it last connected
 * to something and the relay does not). Discovery is appended AFTER, because a
 * scan takes seconds and a ring whose top entries shuffle as results arrive is
 * a ring the owner cannot aim at.
 *
 * A discovered device that is ALSO remembered is dropped from the discovered
 * half: the same speaker appearing twice under two labels is the ring telling
 * the owner it does not know what it has.
 *
 * Names are sanitised (a device advertising a name with a colon in it must not
 * be able to forge another entry's id) and both halves are capped, since a ring
 * the owner cannot get to the end of is a trap.
 */
export function audioRing(devices = [], { discovered = [], scanning = false } = {}) {
  const entries = []
  const seen = new Set()

  for (const device of Array.isArray(devices) ? devices.slice(0, 4) : []) {
    const name = cleanDeviceName(device?.name)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    entries.push(`audio:dev:${name}`)
  }

  for (const device of Array.isArray(discovered) ? discovered.slice(0, 6) : []) {
    const name = cleanDeviceName(device?.name)
    if (!name || seen.has(name.toLowerCase())) continue
    seen.add(name.toLowerCase())
    entries.push(`audio:new:${name}`)
  }

  /* Last, so it is what the owner meets at the bottom of whatever exists so
   * far — which is exactly the moment they need to be told the list is still
   * growing. */
  if (scanning) entries.push(AUDIO_SCANNING_ENTRY)

  entries.push(AUDIO_SPEAKER_ENTRY, 'back')
  return Object.freeze(entries)
}

function cleanDeviceName(value) {
  return String(value ?? '')
    .replace(/[|:]/g, ' ')
    .trim()
    .slice(0, 40)
}

/**
 * Fold a fresh device list into the menu WITHOUT moving the owner's cursor.
 *
 * Scan results arrive while the owner is already scrolling. Re-indexing by
 * number would slide the ring under their thumb every time a speaker answered;
 * so the entry they are standing ON is looked up again in the new ring and the
 * index follows the ENTRY, not the position. If it vanished (a device stopped
 * advertising), the cursor falls back to the same numeric slot, clamped — the
 * least surprising of the bad options.
 */
export function menuWithAudioDevices(state, devices, options = {}) {
  const remembered = devices === undefined ? state.audioRemembered ?? [] : devices
  const discovered = options.discovered === undefined ? state.audioDiscovered ?? [] : options.discovered
  const scanning = options.scanning === undefined ? state.audioScanning ?? false : options.scanning

  /*
   * Cursor preservation applies to an EXISTING ring, never to its first fill.
   *
   * Before any device answers, `audioDevices` is empty and `currentRing` falls
   * back to the placeholder ring — which is just [Pendant speaker, Back] — so
   * index 0 reads as "Pendant speaker". Treating that as the owner's position
   * meant the very first bt_devices frame "restored" them onto the speaker
   * entry, and the owner's most-recently-used headphones, sitting at index 0
   * of the list that had just arrived, got scrolled past before they ever saw
   * it. That is precisely the complaint this ordering exists to fix, arriving
   * through the back door. There is nothing to preserve until there is
   * something to have moved away from.
   */
  const hadRing = Boolean(state.audioDevices?.length)
  const previousEntry = hadRing && state.mode === 'audio' ? currentEntry(state) : null
  const entries = audioRing(remembered, { discovered, scanning })
  const found = previousEntry ? entries.indexOf(previousEntry) : -1

  return {
    ...state,
    audioRemembered: remembered,
    audioDiscovered: discovered,
    audioScanning: scanning,
    audioDevices: entries,
    audioIndex: found >= 0 ? found : clampIndex(state.audioIndex ?? 0, entries.length),
  }
}

/** Which ring the state is pointing at, and where in it. */
export function currentRing(state) {
  if (state?.mode === 'number') {
    /*
     * A numeric field is a ring too, and saying so is not a stretch: the earcon
     * wants a position and a size, and value-within-range is exactly that. The
     * pitch therefore tracks the NUMBER, which turns a long spin into an
     * audible sweep — the ear learns "high in the range" without a word spoken.
     */
    const field = currentNumberField(state)
    if (field) {
      return {
        name: 'number',
        entries: [],
        index: Number(state.number.values[state.number.fieldIndex]) - field.min,
        size: field.max - field.min + 1,
      }
    }
  }
  if (state?.mode === 'timer') {
    return { name: 'timer', entries: TIMER_RING, index: clampIndex(state.timerIndex, TIMER_RING.length) }
  }
  if (state?.mode === 'audio') {
    const entries = state.audioDevices?.length ? state.audioDevices : audioRing([])
    return { name: 'audio', entries, index: clampIndex(state.audioIndex, entries.length) }
  }
  if (state?.mode === 'apps') {
    return { name: 'apps', entries: APP_RING, index: clampIndex(state.appIndex, APP_RING.length) }
  }
  return { name: 'closed', entries: [], index: 0 }
}

function clampIndex(value, size) {
  const index = Number(value)
  if (!Number.isFinite(index) || size <= 0) return 0
  return ((Math.trunc(index) % size) + size) % size
}

/** The entry the ring is pointing at, or null when the menu is closed or in a
 * numeric field (where the "entry" is a number, not a name). */
export function currentEntry(state) {
  if (state?.mode === 'number') return null
  const ring = currentRing(state)
  return ring.entries[ring.index] ?? null
}

export function currentNumberField(state) {
  const entry = state?.number
  if (!entry) return null
  return entry.fields[entry.fieldIndex] ?? null
}

export function currentNumberValue(state) {
  const entry = state?.number
  if (!entry) return null
  return entry.values[entry.fieldIndex] ?? null
}

/* ---------------------------------------------------------------- effects */

/*
 * Effects, not side effects. The reducer returns a list of things the caller
 * should do — play this earcon, say these words, speak this number, enter this
 * app, start this timer — and does none of them. That is what makes ring
 * navigation testable without a socket, a store, a TTS bill or a clock.
 *
 * Three utterance kinds, and the difference between them is TIMING, which is
 * the thing that makes or breaks a screenless spinner:
 *   name   — a ring position. Debounced by the ~200 ms settle.
 *   number — a bare number in a field. Debounced the same way, but rendered
 *            LOCALLY (cloud-relay/spokenNumbers.js) rather than by TTS, because
 *            a network round trip per settle is what made a spinner impossible.
 *   speak  — an announcement or a confirmation. NOT debounced: it is caused by
 *            a press, and a press has already told us the hand stopped.
 */
function earcon(state, motion) {
  const ring = currentRing(state)
  return {
    kind: 'earcon',
    ring: ring.name,
    index: ring.index,
    size: Math.max(1, ring.size ?? ring.entries.length),
    motion,
  }
}

function named(state) {
  const text = entryName(currentEntry(state))
  return text ? [{ kind: 'name', text }] : []
}

function spokenNumber(state) {
  const value = currentNumberValue(state)
  return value === null ? [] : [{ kind: 'number', value }]
}

/**
 * Every exported transition runs through here so the device is told about a
 * context change exactly when one happens, and never otherwise.
 *
 * Computed by comparing open-ness before and after rather than by each branch
 * remembering to emit it. Branches forget; a wrapper cannot. The frame goes
 * FIRST in the effect list, before any sound: the owner's next press can land
 * during the earcon, and a device still holding the old meaning would fire the
 * wrong verb.
 */
function withContext(before, result) {
  const wasOpen = menuIsOpen(before)
  const isOpen = menuIsOpen(result.state)
  if (wasOpen === isOpen) return result
  return { ...result, effects: [{ kind: 'context', active: isOpen }, ...result.effects] }
}

/* --------------------------------------------------------------- the knob */

/**
 * One detent.
 *
 * A detent on a CLOSED menu opens the ring at its home entry regardless of
 * sign. Opening backwards onto "Back" would be technically symmetric and
 * practically hostile — the first thing the owner ever hears from the knob
 * would be the word for leaving.
 */
export function menuScroll(state, delta) {
  const step = Number(delta) > 0 ? 1 : Number(delta) < 0 ? -1 : 0
  if (!step) return { state, effects: [] }

  if (state.mode === 'closed') {
    const opened = { ...state, mode: 'apps', appIndex: 0 }
    /*
     * The one place the ring introduces itself. This sentence is now the entire
     * discovery path for selection — dwell was the last gesture an owner could
     * stumble into by accident — so it is spoken every time the ring opens, not
     * once per session. There is no scrollback to consult on a device with no
     * screen.
     */
    return withContext(state, {
      state: opened,
      effects: [
        earcon(opened, 'forward'),
        { kind: 'name', text: appEntrySpeech(entryName('time'), 'ring') },
      ],
    })
  }

  if (state.mode === 'number') {
    const field = currentNumberField(state)
    const previous = currentNumberValue(state)
    const { value, atEdge } = stepFieldValue(field, previous, step)
    const next = { ...state, number: { ...state.number, values: replaceAt(state.number.values, state.number.fieldIndex, value) } }
    /*
     * At a stop, the earcon changes and the number is re-spoken. Both matter:
     * the earcon says "that did not move" in the instant the thumb feels the
     * detent, and re-speaking the unchanged number is what stops the owner
     * turning ten more times into a wall they cannot see.
     */
    return {
      state: next,
      effects: [earcon(next, atEdge ? 'edge' : step > 0 ? 'forward' : 'back'), ...spokenNumber(next)],
    }
  }

  if (state.mode === 'timer') {
    const next = { ...state, timerIndex: clampIndex(state.timerIndex + step, TIMER_RING.length) }
    return { state: next, effects: [earcon(next, step > 0 ? 'forward' : 'back'), ...named(next)] }
  }

  if (state.mode === 'audio') {
    const size = currentRing(state).entries.length
    const next = { ...state, audioIndex: clampIndex(state.audioIndex + step, size) }
    return { state: next, effects: [earcon(next, step > 0 ? 'forward' : 'back'), ...named(next)] }
  }

  const next = { ...state, appIndex: clampIndex(state.appIndex + step, APP_RING.length) }
  return { state: next, effects: [earcon(next, step > 0 ? 'forward' : 'back'), ...named(next)] }
}

function replaceAt(list, index, value) {
  const copy = list.slice()
  copy[index] = value
  return copy
}

/* ------------------------------------------------------- the yellow button */

/**
 * Yellow, pressed while the ring is open: commit whatever it is pointing at.
 *
 * Entering an app SPEAKS ITS SURFACE — there is no silent landing anywhere in
 * this grammar, because on a screenless device silence and breakage sound
 * identical. Every app's surface is its NAME plus a one-line how-to composed
 * from controlVocabulary.js, so the sentence that teaches the owner which
 * button to press cannot drift from the button that actually works.
 *
 * Note what is deliberately absent: no branch re-speaks the position name the
 * settle already said. The name belongs to the scroll; the commit answers with
 * the app's own words.
 */
export function menuSelect(state) {
  if (state.mode === 'closed') {
    /*
     * Unreachable from the device — out of the ring, yellow is the talk verb
     * and never reaches this reducer. Kept for the dashboard and the tests, and
     * opening at home is still the right answer: a select that did nothing
     * would make the control feel dead.
     */
    const opened = { ...state, mode: 'apps', appIndex: 0 }
    return withContext(state, {
      state: opened,
      effects: [
        earcon(opened, 'forward'),
        { kind: 'name', text: appEntrySpeech(entryName('time'), 'ring') },
      ],
    })
  }

  if (state.mode === 'number') return commitNumberField(state)

  const entry = currentEntry(state)
  if (entry === 'back') return menuBack(state)

  if (state.mode === 'timer') {
    if (entry === TIMER_CUSTOM_ENTRY) return enterNumberEntry(state, 'timer')
    const minutes = Number(String(entry).slice(6))
    /*
     * Start it and RETURN TO THE APP RING, standing on Timer. The owner's next
     * detent should scroll apps, not offer to start a second timer they did not
     * ask for.
     */
    return { state: { ...state, mode: 'apps', timerIndex: 0 }, effects: [{ kind: 'timer', minutes }] }
  }

  if (state.mode === 'audio') {
    /* The sign, not a door. Selecting it repeats the honest line and leaves the
     * owner exactly where they were — there is nothing here to enter. */
    if (entry === AUDIO_SCANNING_ENTRY) {
      return { state, effects: [{ kind: 'speak', text: 'Still searching.' }] }
    }
    /*
     * Choosing where sound goes and connecting the thing it goes to are ONE
     * intention, so a headphone pick emits both frames: bt_select promotes it
     * to preferred and commands the module to connect, audio_sink routes the
     * next answer there. A sink choice that left the module idle would route
     * the owner's next reply into silence.
     */
    const next = { ...state, mode: 'apps', audioIndex: 0, audioScanning: false }
    if (entry === AUDIO_SPEAKER_ENTRY) {
      return { state: next, effects: [{ kind: 'audio-sink', sink: 'speaker' }] }
    }
    const name = String(entry).slice(10)
    const remembered = String(entry).startsWith('audio:dev:')
    return {
      state: next,
      effects: [{ kind: 'audio-select', index: currentRing(state).index, name, remembered }],
    }
  }

  if (entry === 'timer') {
    const next = { ...state, mode: 'timer', timerIndex: 0 }
    return {
      state: next,
      effects: [earcon(next, 'enter'), { kind: 'speak', text: appEntrySpeech(entryName('timer'), APP_HINT_KEYS.timer) }],
    }
  }

  if (entry === 'alarm') {
    /*
     * Alarm has no preset ring — there is no such thing as a common alarm time
     * — so selecting it drops straight into the hour field. Its app hint IS the
     * field announcement ("Turn to set the hour, yellow to confirm"), which is
     * why this path suppresses the generic "Setting the hour." that a
     * standalone field entry would speak. Two sentences saying the same thing
     * is how a device teaches you to stop listening.
     */
    return enterNumberEntry(state, 'alarm', {
      announcement: appEntrySpeech(entryName('alarm'), APP_HINT_KEYS.alarm),
    })
  }

  if (entry === 'audio') {
    const next = { ...state, mode: 'audio', audioIndex: 0, audioScanning: true }
    return {
      state: next,
      effects: [
        earcon(next, 'enter'),
        { kind: 'speak', text: appEntrySpeech(entryName('audio'), APP_HINT_KEYS.audio) },
        /* Both, together. The remembered list makes the ring usable in the same
         * instant it opens; the scan fills in behind it. */
        { kind: 'bt-list' },
        { kind: 'bt-scan' },
      ],
    }
  }

  /* Time / Reminders / Calendar are one-shot surfaces: they speak and leave you
   * exactly where you were, so the ring never becomes a place to be lost
   * inside of. Their hint ("yellow to hear it again") is true precisely because
   * the cursor did not move. */
  return {
    state,
    effects: [
      earcon(state, 'enter'),
      { kind: 'speak', text: appEntrySpeech(entryName(entry), APP_HINT_KEYS[entry]) },
      { kind: 'app', app: entry },
    ],
  }
}

/* ------------------------------------------------------------ numeric mode */

function enterNumberEntry(state, app, { announcement = null } = {}) {
  const fields = numberFields(app)
  const next = {
    ...state,
    mode: 'number',
    number: { app, fieldIndex: 0, fields, values: fields.map((field) => field.start) },
  }
  return {
    state: next,
    effects: [
      earcon(next, 'enter'),
      {
        kind: 'speak',
        /* Standalone entry (Timer -> Custom) carries the how-to; an app whose
         * own hint already named the gesture passes its sentence in instead. */
        text: announcement ?? `${fieldAnnouncement(fields[0])} ${HINTS.number}`,
      },
      /* The starting value, so the owner is not turning blind. It rides the
       * settle path like every other number, so it lands just behind the
       * announcement rather than colliding with it. */
      ...spokenNumber(next),
    ],
  }
}

/**
 * Yellow inside a field: lock this value in.
 *
 * A multi-field entry (alarm) advances to the next field and announces it —
 * "Setting minutes." — which is the one moment a field announcement is spoken
 * without a hint attached: the owner just used the gesture successfully, so
 * repeating the instruction would be the device explaining a thing it watched
 * them do.
 */
function commitNumberField(state) {
  const entry = state.number
  const nextField = entry.fieldIndex + 1

  if (nextField < entry.fields.length) {
    const next = { ...state, number: { ...entry, fieldIndex: nextField } }
    return {
      state: next,
      effects: [
        earcon(next, 'enter'),
        { kind: 'speak', text: fieldAnnouncement(entry.fields[nextField]) },
        ...spokenNumber(next),
      ],
    }
  }

  const done = { ...state, mode: 'apps', number: null, timerIndex: 0 }
  if (entry.app === 'timer') {
    return { state: done, effects: [{ kind: 'timer', minutes: entry.values[0] }] }
  }
  return {
    state: done,
    effects: [{ kind: 'alarm', hour: entry.values[0], minute: entry.values[1] }],
  }
}

/* --------------------------------------------------------- the blue button */

/**
 * Blue, pressed while the ring is open: one level up, always.
 *
 * From a sub-ring or a numeric field it returns to the app ring. From the app
 * ring it CLOSES the menu, which is also the moment both buttons go back to
 * meaning talk and memo — so this is the transition the device most needs to be
 * told about, and `withContext` guarantees the frame rides ahead of the sound.
 *
 * Closing plays a falling earcon and NO WORDS. Silence plus a downward blip is
 * "you are back in the plain conversation"; a sentence there would say nothing
 * the blip does not, and the owner would learn to talk over it, which is how a
 * device teaches you to ignore it.
 *
 * A numeric field abandoned this way starts NOTHING. There is no half-committed
 * alarm: the values die with the field, because a timer the owner backed out of
 * is a timer they did not want.
 */
export function menuBack(state) {
  if (state.mode === 'number' || state.mode === 'timer' || state.mode === 'audio') {
    const next = {
      ...state,
      mode: 'apps',
      timerIndex: 0,
      audioIndex: 0,
      audioScanning: false,
      number: null,
    }
    return { state: next, effects: [earcon(next, 'escape'), ...named(next)] }
  }
  if (state.mode === 'apps') {
    const next = createMenuState()
    return withContext(state, {
      state: next,
      effects: [
        { kind: 'earcon', ring: 'apps', index: 0, size: APP_RING.length, motion: 'escape' },
        { kind: 'closed' },
      ],
    })
  }
  return { state, effects: [] }
}

/**
 * The wire frame, reduced.
 *
 * One entry point so the socket handler cannot grow its own opinion about what
 * a frame means. Unknown frames return the state untouched with no effects — a
 * knob is not a place to guess.
 *
 * The frame NAMES are unchanged from the dwell era on purpose: `menu_select`
 * and `menu_back` already meant "commit" and "one level up", and only their
 * cause moved (a rested knob became a yellow press; a ring entry became a blue
 * press). Renaming them would have broken the dashboard and the firmware for a
 * rename that taught nobody anything.
 */
export function reduceMenuFrame(state, frame) {
  const type = String(frame?.type ?? '')
  if (type === 'menu') return menuScroll(state, frame?.delta)
  if (type === 'menu_select') return menuSelect(state)
  if (type === 'menu_back') return menuBack(state)
  return { state, effects: [] }
}

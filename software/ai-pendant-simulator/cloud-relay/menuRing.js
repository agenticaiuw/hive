/*
 * The app ring, as a pure function of the knob.
 *
 * WHY THIS FILE EXISTS. The owner, 2026-08-12: "we need to build more default
 * programs into the firmware for more simple things like time and also timer,
 * reminder, calendar, etc. kind of like an ios but remember our i/o with the
 * user has no screen, so a lot of things will have to be changed to create a
 * seamless and intuitive experience where the user knows how to operate."
 * docs/Screenless_App_Grammar.md is the answer in prose; this is the answer in
 * code, and the two must not drift.
 *
 * THE ONE HARD RULE IT ENFORCES: no flow may require two presses to initiate.
 * The yellow press that opens the conversation is the one press. Everything
 * here is driven by the knob — turn to scroll, push to enter, long-hold to
 * escape — and nothing in this reducer can ever return a state that needs a
 * second press before a detent means something. That is why the FIRST detent
 * on a closed menu opens the ring AND lands on its home entry: an opening
 * detent that merely "unlocked" the ring would be exactly the second gesture
 * the grammar forbids.
 *
 * PURE ON PURPOSE. The relay holds the menu (the pendant is stateless — the
 * firmware's whole contribution is {"type":"menu",delta:±1} per detent and
 * {"type":"menu_select"} per push), but holding it and DECIDING it are
 * different jobs. Everything that can be decided without a socket, a store or
 * a clock lives here and is tested here; pendantConverse.js does the speaking.
 */

/*
 * The ring, in the order the owner scrolls it. Time first because it is the
 * cheapest question a screenless device gets asked, and because a one-shot
 * surface at the home position means the most common interaction is
 * turn-once-and-push rather than turn-three-times-and-push.
 *
 * 'back' is the last entry and it is a FALLBACK, not a design goal: the
 * universal escape is the encoder long-hold ({"type":"menu_back"}), which the
 * controls firmware does not emit yet. Until it does, a ring entry the owner
 * can select is the difference between "one long-hold gets you out" and "you
 * are stuck until you end the conversation". When the long-hold lands, this
 * entry stays — it costs one detent and it is the only escape a first-time
 * owner can DISCOVER by turning the knob.
 */
export const APP_RING = Object.freeze([
  'time',
  'timer',
  'reminders',
  'calendar',
  'audio',
  'back',
])

/* The preset ring inside Timer. Six durations, no free entry: a screenless
 * number picker is a spinner with no readout, and "seventeen minutes" is what
 * the voice path is for (set_timer). */
export const TIMER_PRESET_MINUTES = Object.freeze([1, 5, 10, 15, 30, 60])

export const TIMER_RING = Object.freeze([
  ...TIMER_PRESET_MINUTES.map((minutes) => `timer:${minutes}`),
  'back',
])

/*
 * The pendant's own speaker, as the last entry on the Audio devices ring.
 *
 * A ring of remembered headphones with no way back to the speaker is a ring
 * that can strand the owner's audio in a pair of earbuds sitting in a drawer.
 * Selecting it sends {"type":"audio_sink","sink":"speaker"}; selecting a
 * headphone sends bt_select AND audio_sink 'bluetooth', because choosing where
 * sound goes and connecting the thing it goes to are one intention.
 */
export const AUDIO_SPEAKER_ENTRY = 'audio:speaker'

/** Spoken names. Kept beside the ring so a new entry cannot ship nameless —
 * an unnamed position on a screenless ring is a silent one. */
const APP_NAMES = Object.freeze({
  time: 'Time.',
  timer: 'Timer.',
  reminders: 'Reminders.',
  calendar: 'Calendar.',
  audio: 'Audio devices.',
  back: 'Back.',
  [AUDIO_SPEAKER_ENTRY]: 'Pendant speaker.',
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
  if (id.startsWith('timer:')) return `${minutesLabel(id.slice(6))}.`
  /* A remembered sink's name comes from the device, so it is carried in the
   * entry itself rather than looked up in a table this relay cannot know. */
  if (id.startsWith('audio:dev:')) return `${id.slice(10)}.`
  return APP_NAMES[id] ?? ''
}

/**
 * The Audio devices ring, built from what the PENDANT remembers.
 *
 * The only ring in this grammar whose contents the relay does not author: the
 * device holds up to four remembered sinks on its SD card and answers
 * {"type":"bt_list"} with them, so entering the app asks and the ring is
 * whatever comes back. Names are sanitised (a device advertising a name with a
 * colon in it must not be able to forge another entry's id) and capped, since
 * a ring the owner cannot get to the end of is a trap.
 */
export function audioRing(devices = []) {
  const entries = []
  for (const device of Array.isArray(devices) ? devices.slice(0, 4) : []) {
    const name = String(device?.name ?? '').replace(/[|:]/g, ' ').trim().slice(0, 40)
    if (!name) continue
    entries.push(`audio:dev:${name}`)
  }
  entries.push(AUDIO_SPEAKER_ENTRY, 'back')
  return Object.freeze(entries)
}

export function createMenuState() {
  /*
   * Closed, at home, every time. The doc's call: "The conversation ending
   * resets the menu to closed. Next press starts at the ring's home position —
   * predictable beats persistent for a four-item ring." A ring that resumed
   * where it was left would make the same gesture mean different things on
   * different presses, which on a device with no screen is indistinguishable
   * from a bug.
   */
  return { mode: 'closed', appIndex: 0, timerIndex: 0, audioIndex: 0, audioDevices: [] }
}

/**
 * The devices the pendant just reported, folded into the menu.
 *
 * Called by the socket handler when {"type":"bt_devices"} lands. Kept here
 * rather than in the handler so "what is the audio ring" has exactly one
 * answer, and so the reducer's tests can build the state the same way the
 * device does.
 */
export function menuWithAudioDevices(state, devices) {
  return { ...state, audioDevices: audioRing(devices), audioIndex: 0 }
}

/** Which ring the state is pointing at, and where in it. */
export function currentRing(state) {
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

/** The entry the ring is pointing at, or null when the menu is closed. */
export function currentEntry(state) {
  const ring = currentRing(state)
  return ring.entries[ring.index] ?? null
}

/*
 * Effects, not side effects. The reducer returns a list of things the caller
 * should do — play this earcon, say these words, enter this app, start this
 * timer — and does none of them. That is what makes ring navigation testable
 * without a socket, a store, a TTS bill or a clock.
 */
function earcon(state, motion) {
  const ring = currentRing(state)
  return {
    kind: 'earcon',
    ring: ring.name,
    index: ring.index,
    size: Math.max(1, ring.entries.length),
    motion,
  }
}

function named(state, { hint = null } = {}) {
  const text = entryName(currentEntry(state))
  if (!text) return []
  return [{ kind: 'name', text: hint ? `${text} ${hint}` : text }]
}

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
    return { state: opened, effects: [earcon(opened, 'forward'), ...named(opened)] }
  }

  if (state.mode === 'timer') {
    const next = { ...state, timerIndex: clampIndex(state.timerIndex + step, TIMER_RING.length) }
    return {
      state: next,
      effects: [earcon(next, step > 0 ? 'forward' : 'back'), ...named(next)],
    }
  }

  if (state.mode === 'audio') {
    const size = currentRing(state).entries.length
    const next = { ...state, audioIndex: clampIndex(state.audioIndex + step, size) }
    return {
      state: next,
      effects: [earcon(next, step > 0 ? 'forward' : 'back'), ...named(next)],
    }
  }

  const next = { ...state, appIndex: clampIndex(state.appIndex + step, APP_RING.length) }
  return {
    state: next,
    effects: [earcon(next, step > 0 ? 'forward' : 'back'), ...named(next)],
  }
}

/**
 * One push.
 *
 * Entering an app SPEAKS ITS SURFACE — there is no silent landing anywhere in
 * this grammar, because on a screenless device silence and breakage sound
 * identical.
 */
export function menuSelect(state) {
  if (state.mode === 'closed') {
    /*
     * A push with no ring open is the same as the first detent: it opens at
     * home and says where you are. Treating it as nothing would make the knob
     * feel dead on the one gesture a first-time owner is most likely to try.
     */
    const opened = { ...state, mode: 'apps', appIndex: 0 }
    return { state: opened, effects: [earcon(opened, 'forward'), ...named(opened)] }
  }

  const entry = currentEntry(state)
  if (entry === 'back') return menuBack(state)

  if (state.mode === 'timer') {
    const minutes = Number(String(entry).slice(6))
    /*
     * Start it and RETURN TO THE APP RING, standing on Timer. The owner's next
     * detent should scroll apps, not offer to start a second timer they did
     * not ask for — a preset ring that stays open after a push is a ring where
     * a stray knock costs you a timer.
     */
    const next = { ...state, mode: 'apps', timerIndex: 0 }
    return {
      state: next,
      effects: [{ kind: 'timer', minutes }],
    }
  }

  if (state.mode === 'audio') {
    /*
     * Choosing where sound goes and connecting the thing it goes to are ONE
     * intention, so a headphone pick emits both frames: bt_select promotes it
     * to preferred and commands the module to connect, audio_sink routes the
     * next answer there. A sink choice that left the module idle would route
     * the owner's next reply into silence — the firmware note says so
     * explicitly, and this is the relay half of it.
     */
    const next = { ...state, mode: 'apps', audioIndex: 0 }
    if (entry === AUDIO_SPEAKER_ENTRY) {
      return { state: next, effects: [{ kind: 'audio-sink', sink: 'speaker' }] }
    }
    const index = currentRing(state).index
    return {
      state: next,
      effects: [{ kind: 'audio-select', index, name: String(entry).slice(10) }],
    }
  }

  if (entry === 'timer') {
    const next = { ...state, mode: 'timer', timerIndex: 0 }
    return {
      state: next,
      effects: [
        earcon(next, 'enter'),
        /* The one hint that matters, spoken once on entry and never again while
         * scrolling: the ring itself teaches the rest. */
        ...named(next, { hint: 'Press to start.' }),
      ],
    }
  }

  /* Time / Reminders / Calendar are one-shot surfaces: they speak and leave
   * you exactly where you were, so the ring never becomes a place to be lost
   * inside of. */
  return { state, effects: [earcon(state, 'enter'), { kind: 'app', app: entry }] }
}

/**
 * The universal escape: one level up, always the same gesture.
 *
 * Closing the menu plays a falling earcon and NO WORDS. Silence plus a
 * downward blip is "you are back in the plain conversation"; a sentence there
 * would say nothing the blip does not, and the owner would learn to talk over
 * it, which is how a device teaches you to ignore it.
 */
export function menuBack(state) {
  if (state.mode === 'timer' || state.mode === 'audio') {
    const next = { ...state, mode: 'apps', timerIndex: 0, audioIndex: 0 }
    return { state: next, effects: [earcon(next, 'escape'), ...named(next)] }
  }
  if (state.mode === 'apps') {
    const next = { ...state, mode: 'closed', appIndex: 0, timerIndex: 0, audioIndex: 0 }
    return {
      state: next,
      effects: [{ kind: 'earcon', ring: 'apps', index: 0, size: APP_RING.length, motion: 'escape' }, { kind: 'closed' }],
    }
  }
  return { state, effects: [] }
}

/**
 * The wire frame, reduced.
 *
 * One entry point so the socket handler cannot grow its own opinion about what
 * a frame means. Unknown frames return the state untouched with no effects —
 * a knob is not a place to guess.
 */
export function reduceMenuFrame(state, frame) {
  const type = String(frame?.type ?? '')
  if (type === 'menu') return menuScroll(state, frame?.delta)
  if (type === 'menu_select') return menuSelect(state)
  if (type === 'menu_back') return menuBack(state)
  return { state, effects: [] }
}

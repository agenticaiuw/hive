/*
 * The controls this pendant actually has, and the only words allowed to name
 * them out loud.
 *
 * WHY THIS FILE EXISTS. Every spoken instruction the device gives — "Turn to
 * choose, yellow to start." — is a promise about hardware. On a screenless
 * device a wrong promise is unfalsifiable by the owner: they press the thing
 * they were told to press, nothing happens, and they cannot tell whether they
 * misheard, missed the button, or own a broken pendant. The grammar has already
 * shipped one of these ("Press to start." on a knob with no switch) and it took
 * a bench session to catch.
 *
 * So the spoken hints are not strings any more. They are COMPOSED, here, from
 * one table of controls that exists once. A remap — and this bench has remapped
 * three times in two days — edits the table, and every sentence the pendant
 * speaks about its own buttons changes with it. controlVocabulary.test.js fails
 * the build if any composed hint names a control that is not in the table, so
 * "the docs drifted from the hardware" stops being a thing that can happen
 * quietly.
 *
 * THE BENCH, AS IT PHYSICALLY IS (2026-08-13). Written here because this table
 * is the authority and everything else derives from it:
 *
 *   yellow button   works.  The global talk verb, and select inside the ring.
 *   blue button     works.  The global memo verb, and back inside the ring.
 *   encoder         TURN ONLY. The owner's part is the illuminated type, three
 *                   rotation pins plus a switch, and only the three rotation
 *                   wires are connected. There is no push. Never ask for one.
 *   green button    DEAD. Not wired, not coming back. Nothing may reference it.
 *   red switch      cuts mic power (hard mute).
 *   potentiometer   volume.
 *   haptic          exists, and is FELT, not heard — it is in this table so the
 *                   table is a complete inventory, but it has no spoken phrase:
 *                   a device that says "you will feel a buzz" has spent a
 *                   sentence describing a sensation that arrives faster than
 *                   the sentence does.
 *   RGB LED         NOT WIRED. See the note on colour below.
 *
 * COLOUR NAMES A BUTTON; IT NEVER NAMES A STATUS. The guard test forbids the
 * words "light", "LED" and "colour" in any spoken hint, and forbids "green"
 * outright — but "yellow" and "blue" are everywhere in this file, and that is
 * not a contradiction. The owner's two working buttons ARE yellow and blue, and
 * the colour is how a hand finds them without looking; that is the single best
 * word available. What is banned is the other thing colour used to mean here:
 * the RGB LED is not wired, so any sentence that asks the owner to LOOK at a
 * colour, or reports state as one, is describing a part that does not exist.
 * Naming a button is a noun. Reporting a light is a lie.
 */

/*
 * One control, one entry. `speech` is the short form used inside a hint (these
 * are heard, not read — "Yellow to start" beats "Press the yellow button to
 * start" by four syllables, and the hint is spoken every single time the owner
 * enters the app). `phrase` is the long form for the rare line that needs to
 * introduce a control rather than remind the owner of one.
 *
 * `global` and `inRing` record the CONTEXT SPLIT that the 2026-08-13 ruling
 * created — the same button means different things depending on whether the app
 * ring is open. They are documentation of intent here; menuRing.js is what
 * enforces it. Keeping them in the same table as the words means a future remap
 * cannot change what a button does without the sentence about it landing in the
 * same diff.
 */
export const CONTROLS = Object.freeze({
  yellow: Object.freeze({
    id: 'yellow',
    speech: 'yellow',
    phrase: 'the yellow button',
    global: 'talk',
    inRing: 'select',
    wired: true,
  }),
  blue: Object.freeze({
    id: 'blue',
    speech: 'blue',
    phrase: 'the blue button',
    global: 'memo',
    inRing: 'back',
    wired: true,
  }),
  knob: Object.freeze({
    id: 'knob',
    speech: 'turn',
    phrase: 'the knob',
    /* Deliberately the same in both contexts. The knob is the one control whose
     * meaning never depends on where you are, which is why it is the control
     * every hint leads with. */
    global: 'scroll',
    inRing: 'scroll',
    wired: true,
  }),
  micSwitch: Object.freeze({
    id: 'micSwitch',
    speech: 'the red switch',
    phrase: 'the red switch',
    global: 'mic mute',
    inRing: 'mic mute',
    wired: true,
  }),
  volume: Object.freeze({
    id: 'volume',
    speech: 'the dial',
    phrase: 'the volume dial',
    global: 'volume',
    inRing: 'volume',
    wired: true,
  }),
  /* Output, not input, and never spoken. Present so this table can be read as
   * the complete inventory of what the owner can touch or feel. */
  haptic: Object.freeze({
    id: 'haptic',
    speech: null,
    phrase: null,
    global: 'cue',
    inRing: 'cue',
    wired: true,
  }),
})

/*
 * The parts that do not exist, named so the guard can be specific about them.
 *
 * A blocklist of bare words would be a blunt instrument; what makes this one
 * useful is that each entry carries WHY, so when the guard fires the failure
 * message tells the next author what is actually wrong with their sentence
 * rather than just which word tripped a regex.
 */
export const ABSENT_CONTROLS = Object.freeze([
  Object.freeze({
    match: /\bgreen\b/i,
    why: 'the green button is not wired — memo moved to blue on 2026-08-13',
  }),
  Object.freeze({
    match: /\b(?:led|lights?|lamp)\b/i,
    why: 'the RGB LED is not wired; a hint that asks the owner to look at one describes a part that does not exist',
  }),
  Object.freeze({
    match: /\bcolou?rs?\b/i,
    why: 'colour names a button here, never a status — there is no light to be a colour',
  }),
  Object.freeze({
    match: /\b(?:press|push|click|tap)(?:ing)?\s+(?:down\s+)?(?:on\s+)?the\s+(?:knob|encoder|dial|wheel)\b/i,
    why: 'the encoder has no switch: only its three rotation wires are connected',
  }),
  Object.freeze({
    match: /\b(?:knob|encoder)\s+(?:button|switch|press|click)\b/i,
    why: 'the encoder has no switch: only its three rotation wires are connected',
  }),
  Object.freeze({
    match: /\b(?:hold|long[- ]press)\b/i,
    why: 'no in-ring gesture is a hold; the only long press is yellow OUTSIDE the ring, and no hint teaches it as a ring gesture',
  }),
  Object.freeze({
    match: /\b(?:screen|display|tap the screen)\b/i,
    why: 'there is no screen — that is the entire premise of this grammar',
  }),
])

/** Every word this vocabulary is allowed to use for a control, lowercased.
 * Exported so the guard can assert an ALLOWLIST and not merely a blocklist:
 * a blocklist only catches the mistakes we already thought of. */
export const CONTROL_SPEECH_WORDS = Object.freeze(
  Object.values(CONTROLS)
    .flatMap((control) => [control.speech, control.phrase])
    .filter(Boolean)
    .map((words) => String(words).toLowerCase()),
)

/**
 * The spoken short form of one control.
 *
 * Throws on an unknown id rather than returning a placeholder. A hint that
 * silently degraded to "undefined to start" would ship — it is a valid string —
 * and the owner would hear a sentence with a hole in it. A throw fails the test
 * that renders every hint, which is the whole point of composing them.
 */
export function controlSpeech(id) {
  const control = CONTROLS[id]
  if (!control) throw new Error(`unknown control: ${id}`)
  if (!control.speech) throw new Error(`control ${id} has no spoken form`)
  return control.speech
}

export function controlPhrase(id) {
  const control = CONTROLS[id]
  if (!control) throw new Error(`unknown control: ${id}`)
  if (!control.phrase) throw new Error(`control ${id} has no spoken form`)
  return control.phrase
}

/* ------------------------------------------------------- the composers */

/**
 * "yellow to start", "blue to go back" — one control, one thing it does.
 *
 * The verb phrase is the CALLER's (it is about the app, not the hardware), the
 * control word is this file's. That split is the whole trick: an app can say
 * what its button does without being able to say which button it is.
 */
export function doWith(id, action) {
  return `${controlSpeech(id)} to ${String(action).trim()}`
}

/** "Turn to choose" — the knob's clause, which leads almost every hint because
 * the knob is the one control that means the same thing everywhere. */
export function turnTo(action) {
  return `${capitalize(controlSpeech('knob'))} to ${String(action).trim()}`
}

/**
 * Clauses into one spoken line.
 *
 * Comma-joined and capped at two clauses by convention rather than by force:
 * this sentence is spoken every time the owner enters an app, and a third
 * clause is the point where a hint stops being a reminder and becomes a
 * tutorial the owner learns to talk over.
 */
export function hintLine(...clauses) {
  const parts = clauses.map((clause) => String(clause ?? '').trim()).filter(Boolean)
  if (!parts.length) return ''
  const line = parts.join(', ')
  return `${capitalize(line)}.`
}

function capitalize(text) {
  const value = String(text ?? '')
  return value ? value[0].toUpperCase() + value.slice(1) : value
}

/* ------------------------------------------------------ the spoken hints */

/*
 * Every hint the pendant speaks about its own controls, composed above and
 * collected here so the guard test has ONE place to enumerate.
 *
 * A hint is not decoration. The ruling that created this table also removed the
 * only gesture a first-time owner could discover by accident (stopping the knob
 * used to commit), so the sentence that says "yellow" is now the entire
 * discovery path for selection. It is spoken on entry to every app, every time
 * — not once per session — because there is no scrollback on a device with no
 * screen, and an owner who missed it has no way to ask for it again.
 */
export const HINTS = Object.freeze({
  /* The app ring itself, spoken the moment the first detent opens it. All three
   * verbs at once, and this is the one place a third clause earns its keep: it
   * is the only sentence in the grammar where the owner has just arrived
   * somewhere they did not previously know existed. */
  ring: hintLine(turnTo('choose'), doWith('yellow', 'open'), doWith('blue', 'leave')),

  time: hintLine(doWith('yellow', 'hear it again')),
  timer: hintLine(turnTo('choose'), doWith('yellow', 'start')),
  alarm: hintLine(turnTo('set the hour'), doWith('yellow', 'confirm')),
  reminders: hintLine(doWith('yellow', 'check again')),
  calendar: hintLine(doWith('yellow', 'check again')),
  audio: hintLine(turnTo('choose'), doWith('yellow', 'connect')),

  /* Numeric entry. Said once when a field opens, never again while the number
   * is moving — every settle after this speaks the bare number and nothing
   * else, because a unit repeated per detent is the sound of a device talking
   * over its own owner. */
  number: hintLine(turnTo('change'), doWith('yellow', 'confirm')),
})

/**
 * The name of an app plus its how-to, as one spoken line.
 *
 * Both halves together, always, and in this order: the name tells the owner
 * WHERE they landed, the hint tells them what to do about it. Splitting them
 * across two utterances would let the queue interleave something between them.
 */
export function appEntrySpeech(name, hintKey) {
  const hint = HINTS[hintKey] ?? ''
  const spokenName = String(name ?? '').trim()
  if (!spokenName) return hint
  return hint ? `${spokenName} ${hint}` : spokenName
}

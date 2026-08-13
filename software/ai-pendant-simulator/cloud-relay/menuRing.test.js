import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APP_RING,
  AUDIO_SCANNING_ENTRY,
  AUDIO_SPEAKER_ENTRY,
  TIMER_CUSTOM_ENTRY,
  TIMER_PRESET_MINUTES,
  TIMER_RING,
  audioRing,
  clockLabel,
  createMenuState,
  currentEntry,
  currentNumberField,
  currentNumberValue,
  entryName,
  menuBack,
  menuContextFrame,
  menuIsOpen,
  menuScroll,
  menuSelect,
  menuWithAudioDevices,
  minutesLabel,
  numberFields,
  reduceMenuFrame,
  stepFieldValue,
} from './menuRing.js'

/* A detent, as the firmware sends it. */
const turn = (state, delta) => reduceMenuFrame(state, { type: 'menu', delta })
/*
 * THE YELLOW BUTTON, as the firmware sends it while the ring is open.
 *
 * This used to be `dwell()` and it used to arrive 1.5 s after the last detent
 * — the owner's encoder has no switch, so stopping the knob was the commit.
 * The owner killed that on 2026-08-13 ("we should just use a button"), and the
 * tests below are written the way the hardware now behaves: a select lands the
 * instant the owner decides, with no detent required in front of it. Several
 * tests below select twice in a row, which the dwell era could not express at
 * all.
 */
const yellow = (state) => reduceMenuFrame(state, { type: 'menu_select' })
/* THE BLUE BUTTON: one level up. Also reachable by turning to the `Back` entry
 * and pressing yellow — the two paths are asserted identical below. */
const blue = (state) => reduceMenuFrame(state, { type: 'menu_back' })

const kinds = (result) => result.effects.map((effect) => effect.kind)
const of = (result, kind) => result.effects.filter((effect) => effect.kind === kind)
const spoken = (result) =>
  result.effects
    .filter((effect) => effect.kind === 'name' || effect.kind === 'speak')
    .map((effect) => effect.text)

/** Open the ring and land on `entry`. */
function ringAt(entry) {
  let state = turn(createMenuState(), 1).state
  while (currentEntry(state) !== entry) state = turn(state, 1).state
  return state
}

/* ------------------------------------------------- the buttons and context */

test('the first detent opens the ring, and the ring announces its own controls', () => {
  const result = turn(createMenuState(), 1)
  assert.equal(result.state.mode, 'apps')
  assert.equal(currentEntry(result.state), 'time')
  /* Context FIRST, before any sound: the owner's next press can land during
   * the earcon, and a device holding the old meaning fires the wrong verb. */
  assert.deepEqual(kinds(result), ['context', 'earcon', 'name'])
  assert.deepEqual(of(result, 'context')[0], { kind: 'context', active: true })
  assert.match(spoken(result)[0], /^Time\./)
  /* The one sentence that teaches selection. Dwell was the last gesture an
   * owner could stumble into; this line is now the whole discovery path. */
  assert.match(spoken(result)[0], /yellow to open/i)
  assert.match(spoken(result)[0], /blue to leave/i)
})

test('opening backwards still lands on the ring home, not on Back', () => {
  assert.equal(currentEntry(turn(createMenuState(), -1).state), 'time')
})

test('yellow selects — no detent required in front of it', () => {
  /*
   * The regression that matters most. Under dwell a commit could only be armed
   * by a detent, so "select twice without turning" was unreachable. With a
   * button it is one press, and it must work.
   */
  const timer = yellow(ringAt('timer'))
  assert.equal(timer.state.mode, 'timer')
  const again = yellow(timer.state)
  assert.equal(again.state.mode, 'apps', 'yellow on the first preset starts it immediately')
  assert.deepEqual(of(again, 'timer'), [{ kind: 'timer', minutes: TIMER_PRESET_MINUTES[0] }])
})

test('resting the knob commits NOTHING — dwell is gone', () => {
  /*
   * There is no frame for "the knob stopped" any more, and there must not be.
   * The reducer's only inputs are a detent and the two buttons; anything else
   * is ignored, which is what proves stillness cannot start a timer.
   */
  const state = ringAt('timer')
  for (const type of ['menu_dwell', 'menu_settle', 'dwell', 'settle']) {
    const result = reduceMenuFrame(state, { type })
    assert.deepEqual(result.effects, [], `${type} must do nothing`)
    assert.equal(result.state, state)
  }
})

test('blue is back, and from the app ring it closes the ring and hands the buttons back', () => {
  const inTimer = yellow(ringAt('timer')).state
  const out = blue(inTimer)
  assert.equal(out.state.mode, 'apps')
  /* Not a context change: the ring is still open, so the buttons keep their
   * ring meanings and no frame is sent. */
  assert.deepEqual(of(out, 'context'), [])

  const closed = blue(out.state)
  assert.equal(closed.state.mode, 'closed')
  assert.deepEqual(of(closed, 'context')[0], { kind: 'context', active: false })
  /* Closing says nothing. A falling blip plus silence IS the message. */
  assert.deepEqual(spoken(closed), [])
})

test('blue and the Back entry land in exactly the same place', () => {
  const start = ringAt('audio')
  const viaButton = blue(yellow(start).state)
  let viaEntry = yellow(start).state
  while (currentEntry(viaEntry) !== 'back') viaEntry = turn(viaEntry, 1).state
  const committed = yellow(viaEntry)
  assert.equal(viaButton.state.mode, committed.state.mode)
  assert.equal(currentEntry(viaButton.state), currentEntry(committed.state))
})

test('menuIsOpen and menuContextFrame agree with the ring, always', () => {
  let state = createMenuState()
  assert.equal(menuIsOpen(state), false)
  assert.deepEqual(menuContextFrame(state), { type: 'menu_context', active: false })
  state = turn(state, 1).state
  assert.equal(menuIsOpen(state), true)
  assert.deepEqual(menuContextFrame(state), { type: 'menu_context', active: true })
})

test('a context frame is emitted on every open/close transition and never in between', () => {
  /*
   * Walked as a whole session rather than asserted per-branch: the guarantee is
   * that the device's belief can never drift from the relay's state, and only
   * a walk can catch a branch that forgot.
   */
  let state = createMenuState()
  let believedOpen = false
  const steps = [
    (s) => turn(s, 1),
    (s) => turn(s, 1),
    (s) => yellow(s),
    (s) => turn(s, 1),
    (s) => yellow(s),
    (s) => blue(s),
    (s) => blue(s),
    (s) => turn(s, 1),
    (s) => blue(s),
  ]
  for (const step of steps) {
    const result = step(state)
    state = result.state
    for (const effect of of(result, 'context')) believedOpen = effect.active
    assert.equal(
      believedOpen,
      menuIsOpen(state),
      'the device would disagree with the relay about who owns the buttons',
    )
  }
})

/* ------------------------------------------------------------ the app ring */

test('every ring ends in Back', () => {
  assert.equal(APP_RING[APP_RING.length - 1], 'back')
  assert.equal(TIMER_RING[TIMER_RING.length - 1], 'back')
  assert.equal(audioRing([])[audioRing([]).length - 1], 'back')
  assert.equal(audioRing([{ name: 'Bose' }]).at(-1), 'back')
})

test('every app on the ring has a name and a how-to naming a real control', () => {
  for (const entry of APP_RING) {
    if (entry === 'back') continue
    const result = yellow(ringAt(entry))
    const said = spoken(result).join(' ')
    assert.ok(said.length, `${entry} landed silently`)
    assert.ok(
      said.startsWith(entryName(entry)),
      `${entry} must say its name first, said: ${said}`,
    )
    /* The hint half. Composed from controlVocabulary.js, so this asserts the
     * wiring exists — controlVocabulary.test.js is what polices the words. */
    assert.match(said, /\b(yellow|turn)\b/i, `${entry} named no control: ${said}`)
  }
})

test('one-shot surfaces answer without moving the cursor', () => {
  for (const entry of ['time', 'reminders', 'calendar']) {
    const before = ringAt(entry)
    const result = yellow(before)
    assert.equal(currentEntry(result.state), entry, `${entry} moved the cursor`)
    assert.deepEqual(of(result, 'app'), [{ kind: 'app', app: entry }])
  }
})

test('a commit never re-speaks the position name the settle already said', () => {
  for (const entry of APP_RING) {
    const result = yellow(ringAt(entry))
    assert.deepEqual(
      of(result, 'name'),
      [],
      `${entry} re-announced its own position on commit`,
    )
  }
})

/* -------------------------------------------------------------- the timer */

test('Timer offers presets first, then Custom', () => {
  const ring = yellow(ringAt('timer')).state
  assert.deepEqual(
    TIMER_RING.slice(0, TIMER_PRESET_MINUTES.length),
    TIMER_PRESET_MINUTES.map((m) => `timer:${m}`),
  )
  assert.equal(TIMER_RING[TIMER_PRESET_MINUTES.length], TIMER_CUSTOM_ENTRY)
  assert.equal(currentEntry(ring), `timer:${TIMER_PRESET_MINUTES[0]}`)
  assert.equal(entryName(TIMER_CUSTOM_ENTRY), 'Custom.')
})

test('a preset starts a timer and returns to the app ring', () => {
  const ring = yellow(ringAt('timer')).state
  const result = yellow(turn(ring, 1).state)
  assert.deepEqual(of(result, 'timer'), [{ kind: 'timer', minutes: TIMER_PRESET_MINUTES[1] }])
  assert.equal(result.state.mode, 'apps')
})

/* ------------------------------------------------------- numeric entry */

test('ONE DETENT IS ONE UNIT, at any speed', () => {
  /*
   * The owner's rule, verbatim: "ONE detent = ONE unit, at any speed. NO
   * acceleration, no coarse steps." Forty detents in a burst and forty spread
   * over a minute must land on the same number, so the reducer is asked for
   * both and compared. Nothing here consults a clock, which is the structural
   * reason acceleration cannot creep back in.
   */
  let state = customMinutes()
  const start = currentNumberValue(state)
  for (let i = 0; i < 40; i += 1) state = turn(state, 1).state
  assert.equal(currentNumberValue(state), start + 40)

  let back = state
  for (let i = 0; i < 40; i += 1) back = turn(back, -1).state
  assert.equal(currentNumberValue(back), start)
})

test('stepFieldValue never moves by more than one, over the whole range', () => {
  const field = numberFields('timer')[0]
  for (let value = field.min; value <= field.max; value += 1) {
    for (const step of [1, -1, 7, -7, 100]) {
      const next = stepFieldValue(field, value, step)
      assert.ok(
        Math.abs(next.value - value) <= 1,
        `step ${step} from ${value} moved to ${next.value}`,
      )
    }
  }
})

test('a numeric field announces itself ONCE, then speaks bare numbers only', () => {
  const entered = yellowInto(customEntry())
  /* The announcement, with the how-to attached because this is the owner's
   * first moment inside a numeric field. */
  const announced = spoken(entered)
  assert.equal(announced.length, 1)
  assert.match(announced[0], /^Setting minutes\./)
  assert.match(announced[0], /yellow to confirm/i)
  /* And the starting value, so the owner is not turning blind. */
  assert.deepEqual(of(entered, 'number'), [{ kind: 'number', value: 10 }])

  /* Every settle after that is a NUMBER and nothing else — no units, no
   * sentences, no repetition of the field name. */
  let state = entered.state
  for (let i = 0; i < 12; i += 1) {
    const result = turn(state, 1)
    state = result.state
    assert.deepEqual(spoken(result), [], 'a scroll spoke a sentence')
    assert.deepEqual(kinds(result), ['earcon', 'number'])
    assert.equal(of(result, 'number')[0].value, 11 + i)
  }
})

test('the number effect carries a bare value — no units are ever attached', () => {
  let state = customMinutes()
  for (let i = 0; i < 5; i += 1) {
    const result = turn(state, 1)
    state = result.state
    const effect = of(result, 'number')[0]
    assert.equal(typeof effect.value, 'number')
    assert.deepEqual(Object.keys(effect).sort(), ['kind', 'value'])
  }
})

test('a duration STOPS at its ends, and says so audibly', () => {
  const field = numberFields('timer')[0]
  let state = customMinutes()
  /* Drive to the top and keep going. */
  for (let i = 0; i < field.max + 10; i += 1) state = turn(state, 1).state
  assert.equal(currentNumberValue(state), field.max)

  const refused = turn(state, 1)
  assert.equal(currentNumberValue(refused.state), field.max, 'a duration must not wrap')
  /* A silent refusal is indistinguishable from a dead knob, so the earcon
   * changes AND the unchanged number is re-spoken. */
  assert.equal(of(refused, 'earcon')[0].motion, 'edge')
  assert.deepEqual(of(refused, 'number'), [{ kind: 'number', value: field.max }])

  let low = customMinutes()
  for (let i = 0; i < field.min + 40; i += 1) low = turn(low, -1).state
  assert.equal(currentNumberValue(low), field.min)
  assert.equal(of(turn(low, -1), 'earcon')[0].motion, 'edge')
})

test('clock fields WRAP, because a clock is a circle', () => {
  const [hour, minute] = numberFields('alarm')
  assert.deepEqual(stepFieldValue(hour, 23, 1), { value: 0, atEdge: false })
  assert.deepEqual(stepFieldValue(hour, 0, -1), { value: 23, atEdge: false })
  assert.deepEqual(stepFieldValue(minute, 59, 1), { value: 0, atEdge: false })
  assert.deepEqual(stepFieldValue(minute, 0, -1), { value: 59, atEdge: false })
})

test('Alarm walks hour then minute, announcing the second field without repeating the lesson', () => {
  const entered = yellow(ringAt('alarm'))
  assert.equal(entered.state.mode, 'number')
  assert.equal(currentNumberField(entered.state).key, 'hour')
  /* The app's own hint IS the field announcement here — "Turn to set the
   * hour" — so no separate "Setting the hour." is spoken on top of it. */
  assert.equal(spoken(entered).length, 1)
  assert.match(spoken(entered)[0], /^Alarm\./)
  assert.match(spoken(entered)[0], /set the hour/i)

  let state = entered.state
  for (let i = 0; i < 7; i += 1) state = turn(state, 1).state
  assert.equal(currentNumberValue(state), 14)

  const toMinutes = yellow(state)
  assert.equal(currentNumberField(toMinutes.state).key, 'minute')
  assert.deepEqual(spoken(toMinutes), ['Setting minutes.'])
  /* No how-to this time: the owner just used the gesture successfully, and
   * explaining a thing you watched somebody do is how a device gets ignored. */
  assert.doesNotMatch(spoken(toMinutes)[0], /yellow/i)

  let minutes = toMinutes.state
  for (let i = 0; i < 30; i += 1) minutes = turn(minutes, 1).state
  const done = yellow(minutes)
  assert.deepEqual(of(done, 'alarm'), [{ kind: 'alarm', hour: 14, minute: 30 }])
  assert.equal(done.state.mode, 'apps')
  assert.equal(done.state.number, null)
})

test('clockLabel converts the 24-hour field back into the way people speak', () => {
  assert.equal(clockLabel(14, 30), '2:30 PM')
  assert.equal(clockLabel(0, 0), '12:00 AM')
  assert.equal(clockLabel(12, 5), '12:05 PM')
  assert.equal(clockLabel(7, 0), '7:00 AM')
  assert.equal(clockLabel(23, 59), '11:59 PM')
})

test('blue abandons a numeric field and starts NOTHING', () => {
  let state = customMinutes()
  for (let i = 0; i < 20; i += 1) state = turn(state, 1).state
  const out = blue(state)
  assert.equal(out.state.mode, 'apps')
  assert.equal(out.state.number, null)
  assert.deepEqual(of(out, 'timer'), [], 'backing out of a field must not start a timer')
  assert.deepEqual(of(out, 'alarm'), [])
})

test('a custom timer commits the value the owner actually landed on', () => {
  let state = customMinutes()
  for (let i = 0; i < 15; i += 1) state = turn(state, 1).state
  const done = yellow(state)
  assert.deepEqual(of(done, 'timer'), [{ kind: 'timer', minutes: 25 }])
  assert.equal(done.state.mode, 'apps')
})

/* ------------------------------------------------------------ audio ring */

test('remembered devices come FIRST, then newly discovered ones', () => {
  const ring = audioRing([{ name: 'Bose' }, { name: 'AirPods' }], {
    discovered: [{ name: 'Kitchen Echo' }, { name: 'JBL Flip' }],
  })
  assert.deepEqual(ring, [
    'audio:dev:Bose',
    'audio:dev:AirPods',
    'audio:new:Kitchen Echo',
    'audio:new:JBL Flip',
    AUDIO_SPEAKER_ENTRY,
    'back',
  ])
})

test('the device order is preserved exactly — the relay does not re-sort', () => {
  /* The pendant's table is already most-recently-used and only the device
   * knows when each was last connected. Re-sorting here would be the relay
   * inventing a recency it cannot observe. */
  const names = ['Fourth', 'Third', 'Second', 'First']
  const ring = audioRing(names.map((name) => ({ name })))
  assert.deepEqual(
    ring.slice(0, 4),
    names.map((name) => `audio:dev:${name}`),
  )
})

test('a discovered device that is already remembered is not offered twice', () => {
  const ring = audioRing([{ name: 'Bose' }], { discovered: [{ name: 'bose' }, { name: 'New' }] })
  assert.deepEqual(ring, ['audio:dev:Bose', 'audio:new:New', AUDIO_SPEAKER_ENTRY, 'back'])
})

test('while a scan runs, the end of the list says so', () => {
  const ring = audioRing([{ name: 'Bose' }], { scanning: true })
  assert.deepEqual(ring, [
    'audio:dev:Bose',
    AUDIO_SCANNING_ENTRY,
    AUDIO_SPEAKER_ENTRY,
    'back',
  ])
  assert.equal(entryName(AUDIO_SCANNING_ENTRY), 'Still searching.')
})

test('the searching marker is a sign, not a door', () => {
  let state = menuWithAudioDevices({ ...createMenuState(), mode: 'audio' }, [], {
    scanning: true,
  })
  while (currentEntry(state) !== AUDIO_SCANNING_ENTRY) state = turn(state, 1).state
  const result = yellow(state)
  assert.equal(result.state.mode, 'audio', 'selecting it must not leave the ring')
  assert.deepEqual(spoken(result), ['Still searching.'])
  assert.deepEqual(of(result, 'audio-select'), [])
})

test('the ring opens ON the most recently used device, not past it', () => {
  /*
   * REGRESSION (caught by this suite, 2026-08-13). Cursor preservation was
   * applied to the ring's FIRST fill too: before any device answered, the
   * placeholder ring is [Pendant speaker, Back], so index 0 read as "Pendant
   * speaker" and the arriving list "restored" the owner onto the speaker —
   * scrolling straight past the headphones they use most. The whole point of
   * remembered-first ordering is that the top entry is the one they want, so
   * landing below it defeated the feature entirely.
   */
  const state = menuWithAudioDevices({ ...createMenuState(), mode: 'audio' }, [
    { name: 'AirPods' },
    { name: 'Bose' },
  ])
  assert.equal(currentEntry(state), 'audio:dev:AirPods')
})

test('scan results arriving mid-scroll do not move the cursor', () => {
  /*
   * The failure this prevents: the owner is aiming at "Pendant speaker", a
   * speaker answers the inquiry, the ring grows by one, and their press lands
   * on the new device instead. Following the ENTRY rather than the index is
   * what makes a live-updating ring safe to scroll.
   */
  let state = menuWithAudioDevices({ ...createMenuState(), mode: 'audio' }, [{ name: 'Bose' }], {
    scanning: true,
  })
  while (currentEntry(state) !== AUDIO_SPEAKER_ENTRY) state = turn(state, 1).state

  const grown = menuWithAudioDevices(state, undefined, {
    discovered: [{ name: 'Kitchen Echo' }, { name: 'JBL Flip' }],
    scanning: true,
  })
  assert.equal(currentEntry(grown), AUDIO_SPEAKER_ENTRY, 'the ring slid under the thumb')
})

test('a finished scan drops the searching marker without disturbing the cursor', () => {
  let state = menuWithAudioDevices({ ...createMenuState(), mode: 'audio' }, [{ name: 'Bose' }], {
    scanning: true,
  })
  while (currentEntry(state) !== 'back') state = turn(state, 1).state
  const done = menuWithAudioDevices(state, undefined, { discovered: [], scanning: false })
  assert.ok(!done.audioDevices.includes(AUDIO_SCANNING_ENTRY))
  assert.equal(currentEntry(done), 'back')
})

test('picking a remembered sink goes by index; picking a new one goes by name', () => {
  const base = menuWithAudioDevices({ ...createMenuState(), mode: 'audio' }, [{ name: 'Bose' }], {
    discovered: [{ name: 'Kitchen Echo' }],
  })
  const remembered = yellow(base)
  assert.deepEqual(of(remembered, 'audio-select'), [
    { kind: 'audio-select', index: 0, name: 'Bose', remembered: true },
  ])

  const fresh = yellow(turn(base, 1).state)
  assert.deepEqual(of(fresh, 'audio-select'), [
    { kind: 'audio-select', index: 1, name: 'Kitchen Echo', remembered: false },
  ])
})

test('the pendant speaker is always reachable, so audio cannot be stranded', () => {
  for (const devices of [[], [{ name: 'A' }], [{ name: 'A' }, { name: 'B' }]]) {
    assert.ok(audioRing(devices).includes(AUDIO_SPEAKER_ENTRY))
  }
  let state = menuWithAudioDevices({ ...createMenuState(), mode: 'audio' }, [{ name: 'A' }])
  while (currentEntry(state) !== AUDIO_SPEAKER_ENTRY) state = turn(state, 1).state
  assert.deepEqual(of(yellow(state), 'audio-sink'), [{ kind: 'audio-sink', sink: 'speaker' }])
})

test('a device name cannot forge another ring entry', () => {
  const ring = audioRing([{ name: 'audio:speaker' }, { name: 'evil|back' }])
  assert.ok(ring.every((entry, index) => index < 2 || !entry.startsWith('audio:dev:')))
  assert.ok(!ring.includes(AUDIO_SPEAKER_ENTRY.replace('audio:', 'audio:dev:')))
  assert.equal(ring.filter((entry) => entry === 'back').length, 1)
})

test('entering Audio asks for BOTH the remembered list and a scan', () => {
  const result = yellow(ringAt('audio'))
  assert.deepEqual(kinds(result), ['earcon', 'speak', 'bt-list', 'bt-scan'])
  assert.equal(result.state.audioScanning, true)
})

/* --------------------------------------------------------------- the words */

test('minutesLabel and entryName stay spoken, not printed', () => {
  assert.equal(minutesLabel(1), '1 minute')
  assert.equal(minutesLabel(60), '1 hour')
  assert.equal(entryName('timer:5'), '5 minutes.')
  assert.equal(entryName('audio:dev:Bose'), 'Bose.')
  assert.equal(entryName('audio:new:JBL'), 'JBL. New.')
  assert.equal(entryName(AUDIO_SPEAKER_ENTRY), 'Pendant speaker.')
})

test('an unknown frame changes nothing', () => {
  const state = ringAt('timer')
  const result = reduceMenuFrame(state, { type: 'nonsense' })
  assert.equal(result.state, state)
  assert.deepEqual(result.effects, [])
})

/* ------------------------------------------------------------- helpers */

/** The app ring, standing on Timer's Custom entry. */
function customEntry() {
  let state = yellow(ringAt('timer')).state
  while (currentEntry(state) !== TIMER_CUSTOM_ENTRY) state = turn(state, 1).state
  return state
}

const yellowInto = (state) => yellow(state)

/** Inside the custom-minutes field, at its starting value. */
function customMinutes() {
  return yellow(customEntry()).state
}

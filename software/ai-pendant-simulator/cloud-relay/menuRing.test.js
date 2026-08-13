import assert from 'node:assert/strict'
import test from 'node:test'

import {
  APP_RING,
  AUDIO_SPEAKER_ENTRY,
  audioRing,
  menuWithAudioDevices,
  TIMER_PRESET_MINUTES,
  TIMER_RING,
  createMenuState,
  currentEntry,
  entryName,
  menuBack,
  menuScroll,
  menuSelect,
  minutesLabel,
  reduceMenuFrame,
} from './menuRing.js'

/* A detent, as the firmware sends it. */
const turn = (state, delta) => reduceMenuFrame(state, { type: 'menu', delta })
/*
 * The select, as the firmware sends it: NOT a push. The owner's encoder has no
 * switch wired (ruling, 2026-08-12: "we're not going to use the button on the
 * rotary encoder"), so the firmware fires {"type":"menu_select"} 1.5 s after
 * the last detent and never again until a new detent arrives. Almost every
 * dwell() below is preceded by a turn for exactly that reason — a select with
 * no detent in front of it is a frame this hardware cannot produce, and the
 * two places that do it anyway are testing that the reducer survives it.
 */
const dwell = (state) => reduceMenuFrame(state, { type: 'menu_select' })
/* {"type":"menu_back"}: still handled, no longer emitted by anything — the
 * long-hold it was built for needs a button the knob does not have. */
const hold = (state) => reduceMenuFrame(state, { type: 'menu_back' })

const kinds = (result) => result.effects.map((effect) => effect.kind)
const spoken = (result) =>
  result.effects.filter((effect) => effect.kind === 'name').map((effect) => effect.text)

/*
 * THE ONE HARD RULE, as a test. docs/Screenless_App_Grammar.md: "No flow may
 * require two presses to initiate." The yellow press that opened the
 * conversation is the one press, so the very first detent must already MOVE
 * something and say where it landed. A first detent that only "woke" the ring
 * would be the second gesture the grammar forbids, and nothing below would
 * catch it — the ring would still work, it would just cost one more turn
 * forever.
 */
test('the first detent opens the ring AND lands on a named position', () => {
  const opened = turn(createMenuState(), 1)
  assert.equal(opened.state.mode, 'apps')
  assert.equal(currentEntry(opened.state), 'time')
  assert.deepEqual(spoken(opened), ['Time.'])
})

test('opening backwards still opens at home, never on the word for leaving', () => {
  const opened = turn(createMenuState(), -1)
  assert.equal(currentEntry(opened.state), 'time')
  assert.notEqual(currentEntry(opened.state), 'back')
})

test('a select on a closed menu opens it too, rather than feeling dead', () => {
  /* The pendant cannot send this — a dwell needs a detent to arm it, and that
   * detent would have opened the ring — but the dashboard can, and a frame
   * that did nothing would be a silent knob. */
  const opened = dwell(createMenuState())
  assert.equal(opened.state.mode, 'apps')
  assert.deepEqual(spoken(opened), ['Time.'])
})

test('every ring entry has a name — a silent position is an invisible one', () => {
  for (const entry of [...APP_RING, ...TIMER_RING]) {
    assert.ok(entryName(entry).trim().length > 0, `${entry} has no spoken name`)
  }
})

test('scrolling walks the apps in order and wraps both ways', () => {
  let state = turn(createMenuState(), 1).state
  const heard = ['Time.']
  for (let i = 0; i < APP_RING.length - 1; i += 1) {
    const stepped = turn(state, 1)
    state = stepped.state
    heard.push(...spoken(stepped))
  }
  assert.deepEqual(heard, ['Time.', 'Timer.', 'Reminders.', 'Calendar.', 'Audio devices.', 'Back.'])

  /* One more forward wraps to the top; one back from the top wraps to the end.
   * Wrap-around is an escape hatch of its own — there is no long-hold coming,
   * so it is not decoration. */
  const wrapped = turn(state, 1)
  assert.equal(currentEntry(wrapped.state), 'time')
  assert.equal(currentEntry(turn(wrapped.state, -1).state), 'back')
})

test('a detent blips at a position that rises through the ring', () => {
  let state = createMenuState()
  const positions = []
  for (let i = 0; i < APP_RING.length; i += 1) {
    const stepped = turn(state, 1)
    state = stepped.state
    const earcon = stepped.effects.find((effect) => effect.kind === 'earcon')
    positions.push(earcon.index)
    assert.equal(earcon.ring, 'apps')
    assert.equal(earcon.size, APP_RING.length)
  }
  assert.deepEqual(positions, APP_RING.map((_, index) => index))
})

test('Time speaks and leaves you on the ring — a one-shot surface', () => {
  const state = turn(createMenuState(), 1).state
  const entered = dwell(state)
  assert.equal(entered.state.mode, 'apps')
  assert.equal(currentEntry(entered.state), 'time')
  assert.deepEqual(
    entered.effects.filter((effect) => effect.kind === 'app'),
    [{ kind: 'app', app: 'time' }],
  )
})

test('Reminders and Calendar are one-shot surfaces too', () => {
  let state = turn(createMenuState(), 1).state
  state = turn(state, 1).state
  state = turn(state, 1).state
  assert.equal(currentEntry(state), 'reminders')
  const reminders = dwell(state)
  assert.equal(reminders.state.mode, 'apps')
  assert.deepEqual(
    reminders.effects.filter((effect) => effect.kind === 'app'),
    [{ kind: 'app', app: 'reminders' }],
  )

  const calendar = dwell(turn(state, 1).state)
  assert.deepEqual(
    calendar.effects.filter((effect) => effect.kind === 'app'),
    [{ kind: 'app', app: 'calendar' }],
  )
})

test('entering Timer speaks the highlighted duration and the one hint', () => {
  const state = turn(turn(createMenuState(), 1).state, 1).state
  assert.equal(currentEntry(state), 'timer')
  const entered = dwell(state)
  assert.equal(entered.state.mode, 'timer')
  /* The hint names the gesture the owner HAS. "Press to start." was the old
   * wording and it is now a lie about the hardware — and it asks for the turn
   * first, because the preset you land on cannot be dwelled into until a
   * detent re-arms the firmware's timer. */
  assert.deepEqual(spoken(entered), ['1 minute. Turn, then pause to start.'])
  /* A different base pitch, so "which ring am I in" is audible before a word. */
  assert.equal(entered.effects.find((effect) => effect.kind === 'earcon').ring, 'timer')
})

test('the hint is spoken on entry only, never again while scrolling', () => {
  const timerRing = dwell(turn(turn(createMenuState(), 1).state, 1).state).state
  const scrolled = turn(timerRing, 1)
  assert.deepEqual(spoken(scrolled), ['5 minutes.'])
})

test('the preset ring carries exactly the documented durations', () => {
  assert.deepEqual([...TIMER_PRESET_MINUTES], [1, 5, 10, 15, 30, 60])
  assert.equal(minutesLabel(1), '1 minute')
  assert.equal(minutesLabel(60), '1 hour')
})

test('stopping on a preset starts it and returns to the app ring, standing on Timer', () => {
  let state = dwell(turn(turn(createMenuState(), 1).state, 1).state).state
  state = turn(state, 1).state
  state = turn(state, 1).state
  assert.equal(currentEntry(state), 'timer:10')

  const started = dwell(state)
  assert.deepEqual(
    started.effects.filter((effect) => effect.kind === 'timer'),
    [{ kind: 'timer', minutes: 10 }],
  )
  /*
   * Back on the app ring afterwards. A preset ring that stayed open would make
   * a stray knock cost the owner a second timer they never asked for.
   */
  assert.equal(started.state.mode, 'apps')
  assert.equal(currentEntry(started.state), 'timer')
})

test('a started timer does not re-arm: re-entering Timer starts at the first preset', () => {
  let state = dwell(turn(turn(createMenuState(), 1).state, 1).state).state
  state = turn(state, 1).state
  state = dwell(state).state
  assert.equal(currentEntry(dwell(state).state), 'timer:1')
})

/*
 * THE UNIVERSAL ESCAPE, and on this hardware there is only ONE way in: the
 * "Back" entry at the end of every ring, reached by turning and stopping. The
 * {"type":"menu_back"} frame stays handled (dashboard, tests) but no gesture
 * produces it — the knob has no switch to hold. Both paths must still land in
 * the same place, because the Back entry is now carrying the whole contract.
 */
test('the Back entry and the menu_back frame are the same escape, one level at a time', () => {
  const inTimer = dwell(turn(turn(createMenuState(), 1).state, 1).state).state

  const held = hold(inTimer)
  assert.equal(held.state.mode, 'apps')
  assert.deepEqual(spoken(held), ['Timer.'])

  let onBack = inTimer
  for (let i = 0; i < TIMER_RING.length - 1; i += 1) onBack = turn(onBack, 1).state
  assert.equal(currentEntry(onBack), 'back')
  const selected = dwell(onBack)
  assert.equal(selected.state.mode, 'apps')
  assert.deepEqual(spoken(selected), spoken(held))
})

/*
 * ---- DWELL: what the reducer must be true of when there is no push ---------
 *
 * These four are the ones that would have been someone else's problem while a
 * button existed. With select = "stop turning", the ring has to be walkable,
 * committable and escapable with ONE verb, and the commit has to stay quiet
 * about a name the scroll already said 1.3 s earlier (the firmware dwells
 * 1500 ms; pendantConverse speaks the position on a 200 ms settle).
 */
test('no ring can trap the owner: every ring ends in Back', () => {
  assert.equal(APP_RING[APP_RING.length - 1], 'back')
  assert.equal(TIMER_RING[TIMER_RING.length - 1], 'back')
  for (const devices of [[{ name: 'AirPods Pro' }], []]) {
    const ring = audioRing(devices)
    assert.equal(ring[ring.length - 1], 'back')
  }
})

test('turn-and-stop alone gets in and back out — no push frame anywhere', () => {
  /* The whole grammar exercised with the only two gestures the hardware has:
   * a detent, and 1.5 s of stillness. If this can be done, nothing the owner
   * can reach needs a button. */
  let state = turn(createMenuState(), 1).state /* opens on Time */
  while (currentEntry(state) !== 'timer') state = turn(state, 1).state
  state = dwell(state).state
  assert.equal(state.mode, 'timer')

  while (currentEntry(state) !== 'back') state = turn(state, 1).state
  state = dwell(state).state
  assert.equal(state.mode, 'apps')

  while (currentEntry(state) !== 'back') state = turn(state, 1).state
  const closed = dwell(state)
  assert.equal(closed.state.mode, 'closed')
  assert.deepEqual(kinds(closed), ['earcon', 'closed'])
})

test('a commit never re-speaks the name the detent already spoke', () => {
  /* The one-shot surfaces answer with the APP's words (or nothing, for Back);
   * none of them repeat the position. A commit that re-said "Reminders." would
   * land ~1.3 s after the settle spoke it, which on a screenless device reads
   * as a stutter, not as confirmation. */
  for (const app of ['time', 'reminders', 'calendar', 'audio', 'back']) {
    let state = turn(createMenuState(), 1).state
    while (currentEntry(state) !== app) state = turn(state, 1).state
    assert.deepEqual(spoken(dwell(state)), [], `${app} re-spoke its own name on commit`)
  }
  /* Timer is the single exception and it is not a repeat: what it says is the
   * FIRST entry of the ring it just opened, plus the hint. */
  let onTimer = turn(createMenuState(), 1).state
  while (currentEntry(onTimer) !== 'timer') onTimer = turn(onTimer, 1).state
  assert.deepEqual(spoken(dwell(onTimer)), ['1 minute. Turn, then pause to start.'])
})

test('no-repeat-fire is the FIRMWARE guarantee — the reducer stays stateless about it', () => {
  /*
   * Deliberate, and written down so nobody "fixes" it here: the reducer has no
   * memory of having just committed, because the device does. main.c arms the
   * dwell work item only from a detent, so a knob left resting selects exactly
   * once. If that guard ever moved into this file it would also have to know
   * about detents, and the reducer would stop being a pure function of frames.
   */
  let state = turn(createMenuState(), 1).state
  assert.equal(currentEntry(state), 'time')
  const first = dwell(state)
  const second = dwell(first.state)
  assert.equal(second.state.mode, 'apps')
  assert.equal(currentEntry(second.state), 'time')
  assert.deepEqual(kinds(second), kinds(first))
})

test('escaping from the app ring closes the menu with a falling blip and NO words', () => {
  const state = turn(createMenuState(), 1).state
  const closed = hold(state)
  assert.equal(closed.state.mode, 'closed')
  assert.deepEqual(kinds(closed), ['earcon', 'closed'])
  assert.equal(closed.effects[0].motion, 'escape')
  /* Silence plus a downward blip IS the message; a sentence there would say
   * nothing the blip does not. */
  assert.deepEqual(spoken(closed), [])
})

test('two escapes always get you out, from anywhere in the grammar', () => {
  const deepest = dwell(turn(turn(createMenuState(), 1).state, 1).state).state
  const out = hold(hold(deepest).state)
  assert.equal(out.state.mode, 'closed')
  /* And a third does nothing rather than throwing or reopening. */
  assert.deepEqual(hold(out.state).effects, [])
})

test('a closed menu reopens at home — predictable beats persistent', () => {
  let state = turn(createMenuState(), 1).state
  state = turn(state, 1).state
  state = turn(state, 1).state
  assert.equal(currentEntry(state), 'reminders')
  const closed = hold(state).state
  assert.equal(currentEntry(turn(closed, 1).state), 'time')
})

test('unknown frames and zero deltas change nothing', () => {
  const state = turn(createMenuState(), 1).state
  assert.deepEqual(reduceMenuFrame(state, { type: 'ping' }).effects, [])
  assert.equal(reduceMenuFrame(state, { type: 'ping' }).state, state)
  assert.deepEqual(menuScroll(state, 0).effects, [])
  assert.equal(menuScroll(state, 0).state, state)
})

test('a corrupt index is clamped rather than crashing the knob', () => {
  const wild = { mode: 'apps', appIndex: 999, timerIndex: -42 }
  assert.ok(APP_RING.includes(currentEntry(wild)))
  assert.equal(menuSelect(wild).state.mode !== undefined, true)
  assert.equal(menuBack({ mode: 'closed' }).effects.length, 0)
})

/*
 * ---- Audio devices: the one ring the relay does not author -----------------
 *
 * The pendant remembers up to four Bluetooth sinks on its SD card and answers
 * {"type":"bt_list"} with them, so this ring's contents arrive over the wire.
 * That makes it the only place in the grammar where an outside string becomes
 * a ring entry, which is exactly why the sanitising below is tested rather
 * than trusted.
 */
const SINKS = [
  { index: 0, name: 'AirPods Pro', address: 'aa:bb', preferred: true },
  { index: 1, name: 'Kitchen speaker', address: 'cc:dd', preferred: false },
]

/* Standing on the Audio devices entry, then the device's answer becomes the
 * ring — exactly what pendantConverse does when bt_devices lands. */
const withSinks = (devices = SINKS) => {
  let state = turn(createMenuState(), 1).state
  while (currentEntry(state) !== 'audio') state = turn(state, 1).state
  return { ...menuWithAudioDevices(state, devices), mode: 'audio' }
}

test('the audio ring is whatever the pendant remembers, plus a way back to the speaker', () => {
  const ring = audioRing(SINKS)
  assert.deepEqual(
    [...ring],
    ['audio:dev:AirPods Pro', 'audio:dev:Kitchen speaker', AUDIO_SPEAKER_ENTRY, 'back'],
  )
  assert.equal(entryName('audio:dev:AirPods Pro'), 'AirPods Pro.')
  assert.equal(entryName(AUDIO_SPEAKER_ENTRY), 'Pendant speaker.')
})

test('a pendant that remembers nothing still offers its own speaker and an escape', () => {
  assert.deepEqual([...audioRing([])], [AUDIO_SPEAKER_ENTRY, 'back'])
  assert.deepEqual([...audioRing(null)], [AUDIO_SPEAKER_ENTRY, 'back'])
})

test('device names are sanitised and capped — a ring is not a place for wire strings', () => {
  const hostile = audioRing([
    { name: 'evil:dev:back' },
    { name: 'a|b' },
    { name: '' },
    { name: 'x'.repeat(90) },
    { name: 'fifth' },
    { name: 'sixth' },
  ])
  /* No entry may forge another entry's id by carrying a separator... */
  assert.ok(!hostile.some((entry) => entry.split(':').length > 3))
  /* ...and the ring stays walkable: four sinks max, per the firmware's own cap. */
  assert.ok(hostile.filter((entry) => entry.startsWith('audio:dev:')).length <= 4)
  assert.ok(hostile.every((entry) => entry.length <= 60))
})

test('picking a headphone emits BOTH frames — connect it and route to it', () => {
  const ring = withSinks()
  const picked = dwell(ring)
  assert.deepEqual(picked.effects, [{ kind: 'audio-select', index: 0, name: 'AirPods Pro' }])
  /* And it leaves you back on the app ring, like every other one-shot pick. */
  assert.equal(picked.state.mode, 'apps')
})

test('the second entry selects by its own index, not the first', () => {
  const picked = dwell(turn(withSinks(), 1).state)
  assert.deepEqual(picked.effects, [{ kind: 'audio-select', index: 1, name: 'Kitchen speaker' }])
})

test('the pendant speaker is always reachable, so audio cannot be stranded in a drawer', () => {
  let state = withSinks()
  state = turn(state, 1).state
  state = turn(state, 1).state
  assert.equal(currentEntry(state), AUDIO_SPEAKER_ENTRY)
  const picked = dwell(state)
  assert.deepEqual(picked.effects, [{ kind: 'audio-sink', sink: 'speaker' }])
  assert.equal(picked.state.mode, 'apps')
})

test('the audio ring escapes like every other inner ring', () => {
  const held = hold(withSinks())
  assert.equal(held.state.mode, 'apps')
  assert.deepEqual(spoken(held), ['Audio devices.'])

  let onBack = withSinks()
  for (let i = 0; i < audioRing(SINKS).length - 1; i += 1) onBack = turn(onBack, 1).state
  assert.equal(currentEntry(onBack), 'back')
  assert.equal(dwell(onBack).state.mode, 'apps')
})

test('the audio ring blips in the inner register, like the timer ring', () => {
  const scrolled = turn(withSinks(), 1)
  const blip = scrolled.effects.find((effect) => effect.kind === 'earcon')
  assert.equal(blip.ring, 'audio')
  assert.deepEqual(spoken(scrolled), ['Kitchen speaker.'])
})

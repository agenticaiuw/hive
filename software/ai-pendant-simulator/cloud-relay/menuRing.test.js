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
const push = (state) => reduceMenuFrame(state, { type: 'menu_select' })
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

test('a push on a closed menu opens it too, rather than feeling dead', () => {
  const opened = push(createMenuState())
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
   * Wrap-around is an escape hatch of its own until the firmware emits the
   * long-hold, so it is not decoration. */
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
  const entered = push(state)
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
  const reminders = push(state)
  assert.equal(reminders.state.mode, 'apps')
  assert.deepEqual(
    reminders.effects.filter((effect) => effect.kind === 'app'),
    [{ kind: 'app', app: 'reminders' }],
  )

  const calendar = push(turn(state, 1).state)
  assert.deepEqual(
    calendar.effects.filter((effect) => effect.kind === 'app'),
    [{ kind: 'app', app: 'calendar' }],
  )
})

test('entering Timer speaks the highlighted duration and the one hint', () => {
  const state = turn(turn(createMenuState(), 1).state, 1).state
  assert.equal(currentEntry(state), 'timer')
  const entered = push(state)
  assert.equal(entered.state.mode, 'timer')
  assert.deepEqual(spoken(entered), ['1 minute. Press to start.'])
  /* A different base pitch, so "which ring am I in" is audible before a word. */
  assert.equal(entered.effects.find((effect) => effect.kind === 'earcon').ring, 'timer')
})

test('the hint is spoken on entry only, never again while scrolling', () => {
  const timerRing = push(turn(turn(createMenuState(), 1).state, 1).state).state
  const scrolled = turn(timerRing, 1)
  assert.deepEqual(spoken(scrolled), ['5 minutes.'])
})

test('the preset ring carries exactly the documented durations', () => {
  assert.deepEqual([...TIMER_PRESET_MINUTES], [1, 5, 10, 15, 30, 60])
  assert.equal(minutesLabel(1), '1 minute')
  assert.equal(minutesLabel(60), '1 hour')
})

test('pushing a preset starts it and returns to the app ring, standing on Timer', () => {
  let state = push(turn(turn(createMenuState(), 1).state, 1).state).state
  state = turn(state, 1).state
  state = turn(state, 1).state
  assert.equal(currentEntry(state), 'timer:10')

  const started = push(state)
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
  let state = push(turn(turn(createMenuState(), 1).state, 1).state).state
  state = turn(state, 1).state
  state = push(state).state
  assert.equal(currentEntry(push(state).state), 'timer:1')
})

/*
 * THE UNIVERSAL ESCAPE. Two ways in, because the controls firmware does not
 * emit the long-hold frame yet: {"type":"menu_back"} is handled today, and the
 * "Back" ring entry is what an owner can reach with the hardware that exists.
 * Both must land in the same place or the escape is not universal.
 */
test('long-hold and the Back entry are the same escape, one level at a time', () => {
  const inTimer = push(turn(turn(createMenuState(), 1).state, 1).state).state

  const held = hold(inTimer)
  assert.equal(held.state.mode, 'apps')
  assert.deepEqual(spoken(held), ['Timer.'])

  let onBack = inTimer
  for (let i = 0; i < TIMER_RING.length - 1; i += 1) onBack = turn(onBack, 1).state
  assert.equal(currentEntry(onBack), 'back')
  const selected = push(onBack)
  assert.equal(selected.state.mode, 'apps')
  assert.deepEqual(spoken(selected), spoken(held))
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
  const deepest = push(turn(turn(createMenuState(), 1).state, 1).state).state
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
  const picked = push(ring)
  assert.deepEqual(picked.effects, [{ kind: 'audio-select', index: 0, name: 'AirPods Pro' }])
  /* And it leaves you back on the app ring, like every other one-shot pick. */
  assert.equal(picked.state.mode, 'apps')
})

test('the second entry selects by its own index, not the first', () => {
  const picked = push(turn(withSinks(), 1).state)
  assert.deepEqual(picked.effects, [{ kind: 'audio-select', index: 1, name: 'Kitchen speaker' }])
})

test('the pendant speaker is always reachable, so audio cannot be stranded in a drawer', () => {
  let state = withSinks()
  state = turn(state, 1).state
  state = turn(state, 1).state
  assert.equal(currentEntry(state), AUDIO_SPEAKER_ENTRY)
  const picked = push(state)
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
  assert.equal(push(onBack).state.mode, 'apps')
})

test('the audio ring blips in the inner register, like the timer ring', () => {
  const scrolled = turn(withSinks(), 1)
  const blip = scrolled.effects.find((effect) => effect.kind === 'earcon')
  assert.equal(blip.ring, 'audio')
  assert.deepEqual(spoken(scrolled), ['Kitchen speaker.'])
})

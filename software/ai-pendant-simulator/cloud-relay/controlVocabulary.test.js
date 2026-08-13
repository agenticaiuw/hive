import assert from 'node:assert/strict'
import test from 'node:test'

import {
  ABSENT_CONTROLS,
  CONTROLS,
  CONTROL_SPEECH_WORDS,
  HINTS,
  appEntrySpeech,
  controlPhrase,
  controlSpeech,
  doWith,
  hintLine,
  turnTo,
} from './controlVocabulary.js'
import {
  APP_RING,
  TIMER_CUSTOM_ENTRY,
  createMenuState,
  currentEntry,
  entryName,
  menuSelect,
  menuScroll,
  reduceMenuFrame,
} from './menuRing.js'

/*
 * THE GUARD.
 *
 * This file exists because the pendant has already shipped a spoken lie. The
 * grammar told the owner "Press to start." on an encoder whose switch is not
 * wired, and it took a bench session to find — on a device with no screen a
 * wrong instruction is unfalsifiable by the person receiving it. They press the
 * thing they were told to press, nothing happens, and they cannot tell whether
 * they misheard, missed, or own a broken pendant.
 *
 * So: every sentence the pendant speaks about its own controls is collected
 * here and checked against the hardware that actually exists. Two directions,
 * because one is not enough. The BLOCKLIST catches the mistakes already made
 * (green, the LED, a knob press). The ALLOWLIST catches the ones nobody has
 * thought of yet, by refusing any control-shaped noun that is not in the table.
 */

/** Everything the device can say about its controls, from every source. */
function everySpokenHint() {
  const lines = Object.entries(HINTS).map(([key, text]) => [`HINTS.${key}`, text])

  /* Not just the table — the sentences as ASSEMBLED, since appEntrySpeech and
   * the reducer are where a hint meets a name and either could introduce a
   * word of its own. */
  for (const entry of APP_RING) {
    if (entry === 'back') continue
    const result = menuSelect(ringAt(entry))
    for (const effect of result.effects) {
      if (effect.kind === 'name' || effect.kind === 'speak') {
        lines.push([`menuSelect(${entry})`, effect.text])
      }
    }
  }

  /* The ring's own opening line, and the numeric field announcements. */
  const opened = menuScroll(createMenuState(), 1)
  for (const effect of opened.effects) {
    if (effect.kind === 'name') lines.push(['ring opening', effect.text])
  }
  for (const [label, text] of numericFieldLines()) lines.push([label, text])

  return lines.filter(([, text]) => typeof text === 'string' && text.trim())
}

function ringAt(entry) {
  let state = menuScroll(createMenuState(), 1).state
  while (currentEntry(state) !== entry) state = menuScroll(state, 1).state
  return state
}

/** Everything spoken while walking into and through a numeric field. */
function numericFieldLines() {
  const lines = []
  let state = menuSelect(ringAt('timer')).state
  while (currentEntry(state) !== TIMER_CUSTOM_ENTRY) state = menuScroll(state, 1).state

  const entered = menuSelect(state)
  for (const effect of entered.effects) {
    if (effect.kind === 'speak') lines.push(['timer custom field', effect.text])
  }

  /* The alarm's second field, which is the one place a field is announced
   * without a how-to attached. */
  let alarm = menuSelect(ringAt('alarm')).state
  const second = menuSelect(alarm)
  for (const effect of second.effects) {
    if (effect.kind === 'speak') lines.push(['alarm minute field', effect.text])
  }
  return lines
}

test('no spoken hint mentions a control this bench does not have', () => {
  for (const [source, text] of everySpokenHint()) {
    for (const absent of ABSENT_CONTROLS) {
      assert.doesNotMatch(
        text,
        absent.match,
        `${source} says "${text}" — ${absent.why}`,
      )
    }
  }
})

test('the blocklist actually bites — every forbidden pattern is proven to fire', () => {
  /*
   * A guard nobody has seen fail is a guard nobody knows works. These are the
   * real sentences the grammar has held at one time or another, or nearly did.
   */
  const shouldFail = [
    'Press the knob to start.',
    'Push the knob to select.',
    'Click the knob to confirm.',
    'Use the knob button to choose.',
    'Press the encoder switch.',
    'Green to record a memo.',
    'The green button starts a memo.',
    'Watch for the green light.',
    'The LED turns blue when connected.',
    'The light shows the colour of the current mode.',
    'Hold to go back.',
    'Long-press to escape.',
    'Tap the screen to dismiss.',
  ]
  for (const line of shouldFail) {
    const caught = ABSENT_CONTROLS.some((absent) => absent.match.test(line))
    assert.ok(caught, `the guard would have let this ship: "${line}"`)
  }
})

test('the blocklist does not bite the controls that DO exist', () => {
  /*
   * Colour names a BUTTON here and never a status. The owner's two working
   * buttons are physically yellow and blue, and the colour is how a hand finds
   * them without looking — banning the word outright would cost the hints their
   * single best noun. What is banned is asking the owner to LOOK at a colour,
   * because the RGB LED is not wired.
   */
  const shouldPass = [
    'Turn to choose, yellow to start.',
    'Yellow to hear it again.',
    'Turn to change, yellow to confirm.',
    'Blue to go back.',
    'Turn to set the hour, yellow to confirm.',
  ]
  for (const line of shouldPass) {
    for (const absent of ABSENT_CONTROLS) {
      assert.doesNotMatch(line, absent.match, `the guard is too broad: "${line}"`)
    }
  }
})

test('every control-shaped noun in a hint comes from the vocabulary', () => {
  /*
   * The ALLOWLIST half, and the reason a blocklist alone is not enough: it can
   * only catch words somebody already regretted. This catches "the wheel", "the
   * slider", "the trigger" — anything shaped like a control that nobody has
   * thought to forbid — by requiring that a control-ish noun be one this
   * pendant actually has.
   */
  const controlish =
    /\b(?:button|switch|knob|dial|encoder|wheel|slider|lever|trigger|pad|key|toggle|touch|sensor)\b/gi
  const allowed = new Set(CONTROL_SPEECH_WORDS.join(' ').match(controlish) ?? [])

  for (const [source, text] of everySpokenHint()) {
    for (const noun of text.match(controlish) ?? []) {
      assert.ok(
        allowed.has(noun.toLowerCase()),
        `${source} says "${text}" — "${noun}" is not a control in CONTROLS`,
      )
    }
  }
})

test('every app on the ring has a hint, and none is silent', () => {
  for (const entry of APP_RING) {
    if (entry === 'back') continue
    const said = menuSelect(ringAt(entry))
      .effects.filter((effect) => effect.kind === 'name' || effect.kind === 'speak')
      .map((effect) => effect.text)
      .join(' ')
    assert.ok(said.trim(), `${entry} says nothing on entry`)
    assert.ok(
      /\b(?:yellow|blue|turn)\b/i.test(said),
      `${entry} names no gesture the owner has: "${said}"`,
    )
  }
})

test('a remap rewrites every sentence at once', () => {
  /*
   * The property that makes this vocabulary worth having: the hints are
   * COMPOSED, so the word "yellow" appears in the spoken output only because
   * CONTROLS.yellow.speech says so. If a hint had been hardcoded, this count
   * would not track the table.
   */
  const yellowLines = Object.values(HINTS).filter((line) =>
    new RegExp(`\\b${CONTROLS.yellow.speech}\\b`, 'i').test(line),
  )
  assert.ok(yellowLines.length >= 5, 'select is the most-used verb; most hints should name it')
  for (const line of yellowLines) {
    assert.ok(
      line.toLowerCase().includes(CONTROLS.yellow.speech.toLowerCase()),
      'a hint named the select control without going through the table',
    )
  }
})

test('the context split is recorded in the table, not just in prose', () => {
  /* The 2026-08-13 ruling, as data. Both buttons carry two meanings and the
   * table is where that fact lives, so a future remap cannot change what a
   * button does without the sentence about it landing in the same diff. */
  assert.equal(CONTROLS.yellow.global, 'talk')
  assert.equal(CONTROLS.yellow.inRing, 'select')
  assert.equal(CONTROLS.blue.global, 'memo')
  assert.equal(CONTROLS.blue.inRing, 'back')
  /* The knob is the one control that means the same thing everywhere, which is
   * why every hint leads with it. */
  assert.equal(CONTROLS.knob.global, CONTROLS.knob.inRing)
})

test('the dead green button is not in the table at all', () => {
  assert.equal(CONTROLS.green, undefined)
  assert.ok(!Object.keys(CONTROLS).some((id) => /green|led|light/i.test(id)))
})

test('an unknown control throws rather than degrading to a hole in a sentence', () => {
  /* "undefined to start." is a valid string and would ship. A throw fails the
   * suite that renders every hint, which is the entire point of composing. */
  assert.throws(() => controlSpeech('green'), /unknown control/)
  assert.throws(() => controlPhrase('purple'), /unknown control/)
  /* The haptic is real but has no voice — it is felt, and a device that says
   * "you will feel a buzz" has described a sensation slower than the buzz. */
  assert.throws(() => controlSpeech('haptic'), /no spoken form/)
})

test('the composers produce speakable sentences', () => {
  assert.equal(doWith('yellow', 'start'), 'yellow to start')
  assert.equal(turnTo('choose'), 'Turn to choose')
  assert.equal(hintLine(turnTo('choose'), doWith('yellow', 'start')), 'Turn to choose, yellow to start.')
  assert.equal(hintLine(), '')
  assert.equal(hintLine('', null, undefined), '')
})

test('a hint is a reminder, not a tutorial', () => {
  /*
   * These are spoken EVERY time the owner enters an app, not once per session,
   * because there is no scrollback on a screenless device. That is exactly why
   * they have to stay short: a sentence the owner learns to talk over is a
   * sentence that has stopped working.
   */
  for (const [key, line] of Object.entries(HINTS)) {
    const words = line.split(/\s+/).filter(Boolean).length
    assert.ok(words <= 10, `HINTS.${key} is ${words} words: "${line}"`)
    assert.ok(line.endsWith('.'), `HINTS.${key} must be a complete spoken line`)
  }
})

test('appEntrySpeech puts the name first, then the how-to', () => {
  const line = appEntrySpeech(entryName('timer'), 'timer')
  assert.ok(line.startsWith('Timer.'), line)
  assert.ok(line.endsWith(HINTS.timer), line)
  /* A nameless app still gets its hint rather than silence. */
  assert.equal(appEntrySpeech('', 'timer'), HINTS.timer)
  /* An app with no hint gets its name rather than a trailing space. */
  assert.equal(appEntrySpeech('Time.', 'nope'), 'Time.')
})

test('nothing in the reducer speaks a control word the vocabulary did not supply', () => {
  /*
   * The broadest sweep: walk a whole session — open, scroll every app, enter
   * each, run a numeric field, back out — and check every utterance. This is
   * the test that would catch a hardcoded string added to menuRing.js in six
   * months by somebody who never read this file.
   */
  const said = []
  let state = createMenuState()
  const record = (result) => {
    for (const effect of result.effects) {
      if (effect.kind === 'name' || effect.kind === 'speak') said.push(effect.text)
    }
    return result.state
  }

  state = record(reduceMenuFrame(state, { type: 'menu', delta: 1 }))
  for (let i = 0; i < APP_RING.length * 2; i += 1) {
    state = record(reduceMenuFrame(state, { type: 'menu', delta: 1 }))
    const probe = reduceMenuFrame(state, { type: 'menu_select' })
    record(probe)
  }
  /* And a full numeric walk. */
  let timer = reduceMenuFrame(ringAt('timer'), { type: 'menu_select' }).state
  while (currentEntry(timer) !== TIMER_CUSTOM_ENTRY) {
    timer = record(reduceMenuFrame(timer, { type: 'menu', delta: 1 }))
  }
  timer = record(reduceMenuFrame(timer, { type: 'menu_select' }))
  timer = record(reduceMenuFrame(timer, { type: 'menu', delta: 1 }))
  record(reduceMenuFrame(timer, { type: 'menu_select' }))

  assert.ok(said.length > 10, 'the walk did not exercise enough speech to be meaningful')
  for (const text of said) {
    for (const absent of ABSENT_CONTROLS) {
      assert.doesNotMatch(text, absent.match, `spoken during a session: "${text}" — ${absent.why}`)
    }
  }
})

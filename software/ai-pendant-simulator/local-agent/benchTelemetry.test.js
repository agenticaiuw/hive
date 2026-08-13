import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BENCH_LINE_PREFIX,
  applyLine,
  benchSnapshot,
  createBenchState,
  micBand,
  potPercent,
  potVolts,
} from './benchTelemetry.js'

/*
 * Every console string below is copied from a printk in
 * firmware/nrf9160/selftest/src/main.c, spacing included. That is the point of
 * these tests: the parser is a contract with another app's output, and the
 * only way to notice that contract breaking is to hold the exact bytes here.
 */

function feed(state, lines, at = 1_000) {
  let clock = at
  for (const line of lines) {
    applyLine(state, line, clock)
    clock += 10
  }
  return clock
}

test('the button roles are the owner\'s ruling, and green claims none', () => {
  const snapshot = benchSnapshot(createBenchState(0), { now: 1_000 })
  assert.deepEqual(
    snapshot.controls.buttons.map((button) => [button.pin, button.role, button.unwired]),
    [
      [21, 'Talk + push-to-talk', false],
      // Green's wires are off the board; it owns no function until they are back.
      [22, null, true],
      [23, 'Memo', false],
    ],
  )
})

test('a button press and release moves the level, the count, and nothing else', () => {
  const state = createBenchState(0)
  feed(state, [
    '  [  512 ms] yellow button P0.21  PRESSED',
    '  [  740 ms] yellow button P0.21  released',
  ])

  const snapshot = benchSnapshot(state, { now: 2_000 })
  const yellow = snapshot.controls.buttons.find((button) => button.pin === 21)
  const green = snapshot.controls.buttons.find((button) => button.pin === 22)

  assert.equal(yellow.pressed, false)
  assert.equal(yellow.presses, 1)
  // Press and release are both edges, exactly as the self-test counts them.
  assert.equal(yellow.edges, 2)
  assert.equal(yellow.moved, true)
  // The button nobody touched must stay unknown, not "released".
  assert.equal(green.level, null)
  assert.equal(green.pressed, null)
  assert.equal(green.moved, false)
})

test('resting levels seed the pins without inventing a press', () => {
  const state = createBenchState(0)
  feed(state, [
    '    P0.21 yellow button  = HIGH   (expected HIGH)',
    '    P0.23 blue button    = LOW    (expected HIGH)',
    '    P0.24 encoder A      = HIGH   (expected HIGH)',
    '    P0.25 encoder B      = LOW    (expected HIGH)',
    '    P0.26 mic sense      = HIGH   (no pull at all: HIGH = mic powered, LOW = red switch cut it)',
  ])

  const snapshot = benchSnapshot(state, { now: 2_000 })
  const yellow = snapshot.controls.buttons.find((button) => button.pin === 21)
  const blue = snapshot.controls.buttons.find((button) => button.pin === 23)

  assert.equal(yellow.pressed, false)
  assert.equal(yellow.presses, 0, 'a resting level is not an edge')
  assert.equal(blue.pressed, true)
  assert.equal(snapshot.controls.encoder.a, 1)
  assert.equal(snapshot.controls.encoder.b, 0)
  assert.equal(snapshot.controls.micPower.live, true)
})

test('encoder detents accumulate a position and a direction', () => {
  const state = createBenchState(0)
  feed(state, [
    '  [ 1200 ms] encoder detent  CW   (total cw=1 ccw=0)',
    '  [ 1400 ms] encoder detent  CW   (total cw=2 ccw=0)',
    '  [ 1900 ms] encoder detent  CCW  (total cw=2 ccw=1)',
  ])

  const encoder = benchSnapshot(state, { now: 2_000 }).controls.encoder
  assert.equal(encoder.cw, 2)
  assert.equal(encoder.ccw, 1)
  assert.equal(encoder.detents, 3)
  assert.equal(encoder.position, 1)
  assert.equal(encoder.direction, 'ccw')
})

test('the pot reports raw, percent, volts and the span it has swept', () => {
  const state = createBenchState(0)
  feed(state, [
    '    raw=   0    0.0%  ~0.000 V (assuming VDD=3.0 V)',
    '  [ 3000 ms] pot P0.15 raw=2048 (50%)  span so far 0..2048',
    '  [ 3500 ms] pot P0.15 raw=4090 (99%)  span so far 0..4090',
  ])

  const pot = benchSnapshot(state, { now: 4_000 }).controls.pot
  assert.equal(pot.raw, 4090)
  assert.equal(pot.percent, 99.9)
  assert.equal(pot.volts, 2.996)
  assert.equal(pot.min, 0)
  assert.equal(pot.max, 4090)
  assert.equal(pot.span, 4090)
  assert.equal(pot.moved, true)
  assert.deepEqual(pot.history, [0, 2048, 4090])
})

test('a pot that never moved is reported as not moved, not as broken', () => {
  const state = createBenchState(0)
  feed(state, ['    raw=2048   50.0%  ~1.500 V (assuming VDD=3.0 V)'])
  const pot = benchSnapshot(state, { now: 2_000 }).controls.pot
  assert.equal(pot.span, 0)
  assert.equal(pot.moved, false)
})

test('the red switch flips the mic power word', () => {
  const state = createBenchState(0)
  feed(state, [
    '  [ 2000 ms] mic power P0.26 -> HIGH  (red switch FEEDING the mic)',
    '  [ 5000 ms] mic power P0.26 -> LOW  (red switch CUT the mic)',
  ])

  const micPower = benchSnapshot(state, { now: 6_000 }).controls.micPower
  assert.equal(micPower.live, false)
  assert.equal(micPower.changes, 1)
})

test('mic levels band the same way the console does', () => {
  const state = createBenchState(0)
  feed(state, [
    '    peak=91234     rms=45         .        silent',
    '    peak=291234    rms=2600      |||||||| LOUD',
  ])

  const micLevel = benchSnapshot(state, { now: 2_000 }).controls.micLevel
  assert.equal(micLevel.rms, 2600)
  assert.equal(micLevel.peak, 291234)
  assert.equal(micLevel.band, 'loud')
  assert.deepEqual(micLevel.history, [45, 2600])
  assert.equal(micBand(45), 'silent')
  assert.equal(micBand(500), 'faint')
  assert.equal(micBand(501), 'sound')
})

test('the i2c scan collects addresses once each and names the expected one', () => {
  const state = createBenchState(0)
  feed(state, [
    '    ACK       0x5a  <- DRV2605L haptic driver (expected)',
    '    ACK       0x5a  <- DRV2605L haptic driver (expected)',
    '    ACK       0x6b  <- UNEXPECTED, not in the wiring doc',
  ])

  const i2c = benchSnapshot(state, { now: 2_000 }).controls.i2c
  assert.equal(i2c.answered, 2)
  assert.deepEqual(
    i2c.addresses.map((entry) => entry.hex),
    ['0x5a', '0x6b'],
  )
  assert.equal(i2c.addresses[0].expected, true)
  assert.equal(i2c.addresses[1].expected, false)
})

test('an empty bus is a wiring note, not an empty list with no explanation', () => {
  const state = createBenchState(0)
  feed(state, [
    '    FAIL      NOTHING ON THE BUS. Not one address answered.',
  ])
  const i2c = benchSnapshot(state, { now: 2_000 }).controls.i2c
  assert.equal(i2c.answered, 0)
  assert.match(i2c.note, /4\.7k/)
})

test('the SD card reports size when it answers and a reason when it does not', () => {
  const present = createBenchState(0)
  feed(present, [
    '    ---       card present: 31116288 sectors x 512 B = 15193 MiB',
    '    PASS      wrote and read back "pendant selftest" at /SD:/selftest.txt',
  ])
  const good = benchSnapshot(present, { now: 2_000 }).controls.sd
  assert.equal(good.present, true)
  assert.equal(good.mounted, true)
  assert.equal(good.bytes, 31116288 * 512)

  const missing = createBenchState(0)
  feed(missing, ['    FAIL      disk_access_init = -5 — the card never answered CMD0'])
  const bad = benchSnapshot(missing, { now: 2_000 }).controls.sd
  assert.equal(bad.present, false)
  assert.match(bad.note, /no card/)
  // Never a verdict on the rail: P0.12 was measured holding high.
  assert.match(bad.note, /has power/)
})

test('the amp pad reports the level it read back', () => {
  const state = createBenchState(0)
  feed(state, [
    '    drove HIGH -> pad reads HIGH',
    '    drove LOW -> pad reads LOW',
    '    PASS      P0.01 toggles (left LOW = amp in shutdown, the boot default)',
  ])
  const amp = benchSnapshot(state, { now: 2_000 }).controls.amp
  assert.equal(amp.enabled, false)
  assert.equal(amp.toggles, 1)
})

test('the ESP32 link reports each of its three verdicts', () => {
  for (const [line, expected] of [
    ['    PASS        a JSON-looking line came back — both wires and the', 'ok'],
    ['    no reply    nothing arrived in 2 s.', 'silent'],
    ['    partial     bytes arrived but no JSON. The RX', 'partial'],
  ]) {
    const state = createBenchState(0)
    feed(state, [line])
    assert.equal(benchSnapshot(state, { now: 2_000 }).controls.esp32.state, expected)
  }
})

test('the mic window is reported as "not watching the controls", not as stale', () => {
  const state = createBenchState(0)
  feed(state, [
    '########  ROUND 2  ########',
    '  [  100 ms] yellow button P0.21  PRESSED',
  ])
  const during = benchSnapshot(state, { now: 2_000 })
  assert.equal(during.firmware.phase, 'interactive')
  assert.equal(during.controls.buttons[0].watched, true)
  assert.equal(during.controls.micLevel.watched, false)

  feed(state, ['[8] MICROPHONE  SPH0645 on I2S (slave RX), DOUT -> P0.20'], 3_000)
  const mic = benchSnapshot(state, { now: 4_000 })
  assert.equal(mic.firmware.phase, 'microphone')
  assert.equal(mic.controls.buttons[0].watched, false)
  assert.equal(mic.controls.micLevel.watched, true)
})

test('a reboot banner clears counts instead of carrying a dead wire forward', () => {
  const state = createBenchState(0)
  feed(state, [
    '  [  512 ms] yellow button P0.21  PRESSED',
    '  [ 1000 ms] encoder detent  CW   (total cw=1 ccw=0)',
  ])
  assert.equal(benchSnapshot(state, { now: 2_000 }).controls.buttons[0].presses, 1)

  feed(state, ['#  PENDANT BREADBOARD SELF-TEST                                 #'], 3_000)
  const after = benchSnapshot(state, { now: 3_500 })
  assert.equal(after.controls.buttons[0].presses, 0)
  assert.equal(after.controls.buttons[0].level, null)
  assert.equal(after.controls.encoder.detents, 0)
  assert.equal(after.firmware.phase, 'boot')
})

test('the pendant application console fills the controls it actually logs', () => {
  /*
   * Captured verbatim from /dev/cu.usbmodem0009600365811 on 2026-08-13 with
   * the application image flashed (not the self-test). This is what the board
   * says most of the time, so the bench has to read it too.
   */
  const state = createBenchState(0)
  feed(state, [
    '*** Booting nRF Connect SDK v3.4.0-99553055607b ***',
    '*** Using Zephyr OS v4.4.0-bf801e4e3d19 ***',
    'Mic power sense ready (P0.26): mic is MUTED (power cut)',
    'Audio sink: bluetooth',
    'Volume knob ready (P0.15/AIN2, ratiometric, ~20 Hz poll)',
    'Haptic: DRV2605L not answering (-5) — haptic actions degrade to LED patterns',
    'STATUS mic MUTED',
    'E: Card error on CMD0',
    'Volume: raw=1024 level=0.06',
  ])

  const snapshot = benchSnapshot(state, { now: 2_000 })
  assert.equal(snapshot.stream.source, 'selftest-text')
  assert.match(snapshot.firmware.name, /pendant app/)
  assert.equal(snapshot.controls.micPower.live, false)
  assert.equal(snapshot.controls.pot.raw, 1024)
  assert.equal(snapshot.controls.i2c.answered, 0)
  /*
   * "Not answering" is a statement about the DEVICE. hw-selftest measured
   * P0.30/31 over SWD and both held high against an internal pull-down, so the
   * external pull-ups are fitted and live; blaming them here would send the
   * owner after the wrong wire.
   */
  assert.match(snapshot.controls.i2c.note, /bus itself reads healthy/)
  assert.doesNotMatch(snapshot.controls.i2c.note, /pull-up/)
  assert.equal(snapshot.controls.sd.present, false)
  // The app never logs a button level, so those tiles must stay unknown.
  assert.equal(snapshot.controls.buttons[0].level, null)
  assert.equal(snapshot.controls.encoder.a, null)
})

test('a working haptic and a real capture come through the application console', () => {
  const state = createBenchState(0)
  feed(state, [
    'Haptic: DRV2605L attached (status=0x03) — LRA open-loop RTP ready',
    'Store recovered from microSD: pending=2 delivered=7',
    'I2S mic capture totals: samples=48000 mean=12 peak=91234 rms=560 min=-3 max=9 zero_crossings=41 sd_flushes=2 live_sent=1 fifo_left=0 saturated=0 stream_failed=0',
  ])

  const snapshot = benchSnapshot(state, { now: 2_000 })
  assert.equal(snapshot.controls.i2c.addresses[0].hex, '0x5a')
  assert.equal(snapshot.controls.sd.mounted, true)
  assert.equal(snapshot.controls.micLevel.rms, 560)
  assert.equal(snapshot.controls.micLevel.band, 'sound')
})

test('the machine contract fills every control from one line', () => {
  const state = createBenchState(0)
  applyLine(
    state,
    `${BENCH_LINE_PREFIX}${JSON.stringify({
      v: 1,
      up: 18734,
      fw: 'selftest 1.0',
      btn: { p21: 1, p22: 1, p23: 0 },
      enc: { a: 1, b: 0, pos: 37, det: 9 },
      pot: { raw: 2048 },
      mic: { sense: 1, peak: 1234, rms: 56 },
      amp: 0,
      i2c: [0x5a],
      sd: { present: true, bytes: 15931539456, mounted: true },
      esp: 'ok',
    })}`,
    1_000,
  )

  const snapshot = benchSnapshot(state, { now: 1_100 })
  assert.equal(snapshot.stream.source, 'bench-json')
  assert.equal(snapshot.firmware.name, 'selftest 1.0')
  assert.equal(snapshot.firmware.uptimeMs, 18734)
  assert.equal(snapshot.controls.buttons.find((b) => b.pin === 23).pressed, true)
  assert.equal(snapshot.controls.encoder.position, 37)
  assert.equal(snapshot.controls.encoder.detents, 9)
  assert.equal(snapshot.controls.pot.percent, 50)
  assert.equal(snapshot.controls.micPower.live, true)
  assert.equal(snapshot.controls.micLevel.band, 'silent')
  assert.equal(snapshot.controls.i2c.addresses[0].hex, '0x5a')
  assert.equal(snapshot.controls.sd.mounted, true)
  assert.equal(snapshot.controls.esp32.state, 'ok')
  // Machine lines are polled at a fixed rate, so every control is watched.
  assert.equal(snapshot.controls.buttons[0].watched, true)
  assert.equal(snapshot.controls.micLevel.watched, true)
})

test('machine lines merge — an absent key keeps the previous value and its age', () => {
  const state = createBenchState(0)
  applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"up":10,"i2c":[90],"esp":"ok"}`, 1_000)
  applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"up":110,"pot":{"raw":100}}`, 1_100)

  const snapshot = benchSnapshot(state, { now: 1_100 })
  assert.equal(snapshot.controls.i2c.answered, 1)
  assert.equal(snapshot.controls.i2c.ageMs, 100, 'the untouched fact keeps its own age')
  assert.equal(snapshot.controls.pot.ageMs, 0)
})

test('a truncated machine line is dropped, not thrown', () => {
  const state = createBenchState(0)
  assert.equal(applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"pot":{"raw`, 1_000), false)
  assert.equal(benchSnapshot(state, { now: 1_000 }).controls.pot.raw, null)
})

test('prose that means nothing counts as bytes, never as liveness', () => {
  const state = createBenchState(0)
  applyLine(state, 'Verdicts: PASS = the part answered. FAIL = asked, did not answer.', 1_000)

  const snapshot = benchSnapshot(state, { now: 1_000 })
  assert.equal(snapshot.stream.linesSeen, 1)
  assert.equal(snapshot.stream.linesParsed, 0)
  assert.equal(snapshot.stream.connected, false, 'noise is not a live board')
  assert.equal(snapshot.stream.source, null)
})

test('a stream that stops reports disconnected while keeping the last values', () => {
  const state = createBenchState(0)
  feed(state, ['  [  512 ms] yellow button P0.21  PRESSED'])

  assert.equal(benchSnapshot(state, { now: 1_200 }).stream.connected, true)
  const frozen = benchSnapshot(state, { now: 20_000 })
  assert.equal(frozen.stream.connected, false)
  assert.equal(frozen.stream.ageMs, 19_000)
  // The value survives so the UI can show it greyed rather than blank.
  assert.equal(frozen.controls.buttons[0].pressed, true)
  assert.equal(frozen.controls.buttons[0].ageMs, 19_000)
})

test('with no board at all the snapshot is all nulls and says so', () => {
  const snapshot = benchSnapshot(createBenchState(0), { now: 5_000 })
  assert.equal(snapshot.link.state, 'absent')
  assert.equal(snapshot.link.transport, 'none')
  assert.equal(snapshot.stream.connected, false)
  assert.equal(snapshot.stream.ageMs, null)
  for (const button of snapshot.controls.buttons) {
    assert.equal(button.level, null)
    assert.equal(button.pressed, null)
  }
  assert.equal(snapshot.controls.pot.raw, null)
  assert.equal(snapshot.controls.pot.percent, null)
  assert.equal(snapshot.controls.i2c.answered, null)
})

test('pot conversions match the console arithmetic', () => {
  assert.equal(potPercent(0), 0)
  assert.equal(potPercent(4095), 100)
  assert.equal(potVolts(4095), 3)
  assert.equal(potVolts(2048), 1.5)
  assert.equal(potPercent(null), null)
  assert.equal(potVolts(undefined), null)
})

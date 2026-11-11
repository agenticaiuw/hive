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
  // The press is 1.0 s old while the pin was last sampled 0.99 s ago on the
  // release: the owner presses, then looks up, so the press time is the one
  // worth showing and the sample time says nothing at 10 Hz.
  assert.equal(yellow.pressedAgoMs, 1_000)
  assert.equal(yellow.ageMs, 990)
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

test('a pot that tracks the hand but never reaches the rail is not "working"', () => {
  /*
   * The owner's actual board, measured by hw-selftest across a full turn:
   * raw 164..266 of 4095. That is 2.5% of a rail the SAADC reads at full
   * scale (gain 1/4 against a VDD/4 reference), and it cleared the old
   * >= 100 "moved" threshold by two counts — so a mis-wired pot rendered as
   * swept and fine.
   */
  const state = createBenchState(0)
  // A hand on the knob: many distinct readings, all inside a narrow band.
  const sweep = []
  for (let raw = 164; raw <= 266; raw += 2) sweep.push(`Volume: raw=${raw} level=0.00`)
  feed(state, sweep)

  const pot = benchSnapshot(state, { now: 2_000 }).controls.pot
  assert.equal(pot.swept, true, 'distinct readings prove the knob is being turned')
  assert.equal(pot.span, 102)
  assert.equal(pot.spanPercent, 2.5)
  assert.equal(pot.narrow, true, 'and it is nowhere near the rail')

  /*
   * The same pot one count short of the old >= 100 threshold must read the
   * same way. That single count used to flip the tile from "swept" to "barely
   * moved" — the threshold lying in both directions, one count apart.
   */
  const shy = createBenchState(0)
  const nearly = []
  for (let raw = 166; raw <= 265; raw += 2) nearly.push(`Volume: raw=${raw} level=0.00`)
  feed(shy, nearly)
  const shyPot = benchSnapshot(shy, { now: 2_000 }).controls.pot
  assert.equal(shyPot.span, 98, 'under the old >= 100 threshold')
  assert.equal(shyPot.swept, true)
  assert.equal(shyPot.narrow, true)

  // A pot wired correctly sweeps the rail and raises no question.
  const good = createBenchState(0)
  feed(good, ['Volume: raw=8 level=0.00', 'Volume: raw=4050 level=0.00'])
  const healthy = benchSnapshot(good, { now: 2_000 }).controls.pot
  assert.equal(healthy.narrow, false, 'two readings are not evidence of turning')
  assert.equal(healthy.spanPercent, 98.7)
})

test('a boot-time zero moves the live value but never the span', () => {
  /*
   * The owner's real trace: runs of 0 interleaved with steady ~170s, with no
   * gradual approach on either side. A SAADC that has not been configured
   * reports 0, and folding that into `min` made his mis-wired pot look more
   * than twice as good as it is.
   */
  const state = createBenchState(0)
  applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"up":300,"pot":{"raw":0}}`, 1_000)
  applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"up":900,"pot":{"raw":0}}`, 1_100)
  applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"up":4000,"pot":{"raw":175}}`, 1_200)
  applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"up":5000,"pot":{"raw":264}}`, 1_300)

  const pot = benchSnapshot(state, { now: 1_400 }).controls.pot
  assert.equal(pot.raw, 264)
  assert.equal(pot.min, 175, 'the pre-init zeros are not measurements')
  assert.equal(pot.max, 264)
  assert.equal(pot.span, 89)

  // A zero AFTER the board has settled is a real knob position and counts.
  applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"up":9000,"pot":{"raw":0}}`, 1_500)
  assert.equal(benchSnapshot(state, { now: 1_600 }).controls.pot.min, 0)
})

test('uptime going backwards restarts the statistics', () => {
  const state = createBenchState(0)
  feed(state, [
    '  [  512 ms] yellow button P0.21  PRESSED',
    `${BENCH_LINE_PREFIX}{"v":1,"up":90000,"pot":{"raw":4000}}`,
  ])
  assert.equal(benchSnapshot(state, { now: 2_000 }).controls.pot.max, 4000)

  // A reflash we never saw a banner for: the board comes back with a low
  // uptime, and the old board's extremes must not describe the new one.
  applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"up":2000,"pot":{"raw":170}}`, 3_000)
  const after = benchSnapshot(state, { now: 3_100 })
  assert.equal(after.controls.pot.max, 170)
  assert.equal(after.controls.pot.min, 170)
  assert.equal(after.controls.buttons[0].presses, 0, 'counters restart with the board')
})

test('a long gap in the stream starts a fresh window', () => {
  const state = createBenchState(0)
  feed(state, [`${BENCH_LINE_PREFIX}{"v":1,"up":90000,"pot":{"raw":4000}}`])
  assert.equal(benchSnapshot(state, { now: 1_100 }).controls.pot.max, 4000)

  // He rewires while we are not looking; the old sweep describes a circuit
  // that may no longer exist.
  applyLine(state, `${BENCH_LINE_PREFIX}{"v":1,"up":120000,"pot":{"raw":180}}`, 60_000)
  const after = benchSnapshot(state, { now: 60_100 })
  assert.equal(after.controls.pot.max, 180)
  assert.ok(after.stream.continuityGapMs >= 30_000)
})

test('a pot that never moved is reported as not moved, not as broken', () => {
  const state = createBenchState(0)
  feed(state, ['    raw=2048   50.0%  ~1.500 V (assuming VDD=3.0 V)'])
  const pot = benchSnapshot(state, { now: 2_000 }).controls.pot
  assert.equal(pot.span, 0)
  assert.equal(pot.moved, false)
  // Untouched is not a wiring verdict either way.
  assert.equal(pot.narrow, false)
  assert.equal(pot.swept, false)
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

test('a mic level that never moves a single count is stuck, not quiet', () => {
  /*
   * The pot's lesson generalised: a band word is a label for a number, not a
   * verdict on the part. A constant 600 would read "SOUND" forever.
   */
  const stuck = createBenchState(0)
  for (let index = 0; index < 10; index += 1) {
    applyLine(stuck, `${BENCH_LINE_PREFIX}{"v":1,"up":${index},"mic":{"rms":600,"peak":9000}}`, index)
  }
  const flat = benchSnapshot(stuck, { now: 20 }).controls.micLevel
  assert.equal(flat.band, 'sound', 'the label still describes the number honestly')
  assert.equal(flat.flat, true, 'but the number has not moved once')

  // A live mic jitters, so ordinary quiet is NOT flagged.
  const live = createBenchState(0)
  for (let index = 0; index < 10; index += 1) {
    applyLine(
      live,
      `${BENCH_LINE_PREFIX}{"v":1,"up":${index},"mic":{"rms":${40 + (index % 3)},"peak":900}}`,
      index,
    )
  }
  const moving = benchSnapshot(live, { now: 20 }).controls.micLevel
  assert.equal(moving.band, 'silent')
  assert.equal(moving.flat, false)

  // Peak sitting exactly on the 16-bit ceiling is a pinned input, not a room.
  const pinned = createBenchState(0)
  applyLine(pinned, `${BENCH_LINE_PREFIX}{"v":1,"up":9,"mic":{"rms":29250,"peak":32767}}`, 1)
  assert.equal(benchSnapshot(pinned, { now: 2 }).controls.micLevel.saturated, true)
  const normal = createBenchState(0)
  applyLine(normal, `${BENCH_LINE_PREFIX}{"v":1,"up":9,"mic":{"rms":600,"peak":9000}}`, 1)
  assert.equal(benchSnapshot(normal, { now: 2 }).controls.micLevel.saturated, false)

  // Too few samples is not evidence of anything.
  const early = createBenchState(0)
  applyLine(early, `${BENCH_LINE_PREFIX}{"v":1,"up":1,"mic":{"rms":600}}`, 1)
  assert.equal(benchSnapshot(early, { now: 2 }).controls.micLevel.flat, false)
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

test('the real emitter\'s first two lines, byte for byte off the wire', () => {
  /*
   * Captured from the board on 2026-08-13 by nrf-bench-buttons and pasted here
   * unedited. The slow line carries the facts that do not move; the fast line
   * carries the pads. Note `pot` is absent from the slow line and `esp` from
   * both — absent is enforced at the source as "not configured / not probed",
   * never as a zero, and this test exists to keep that distinction alive.
   */
  const state = createBenchState(0)
  feed(state, [
    'BENCH {"v":1,"up":10486,"fw":"pendant app","i2c":[],"sd":{"mounted":false}}',
    'BENCH {"v":1,"up":11091,"btn":{"p21":1,"p22":1,"p23":1},"enc":{"a":1,"b":1,"pos":0,"det":0,"cw":0,"ccw":0},"pot":{"raw":0},"mic":{"sense":0},"amp":0}',
  ])

  const snapshot = benchSnapshot(state, { now: 2_000 })
  assert.equal(snapshot.stream.source, 'bench-json')
  assert.equal(snapshot.firmware.name, 'pendant app')
  assert.equal(snapshot.firmware.uptimeMs, 11091)
  assert.deepEqual(
    snapshot.controls.buttons.map((button) => button.pressed),
    [false, false, false],
  )
  assert.equal(snapshot.controls.pot.raw, 0)
  assert.equal(snapshot.controls.micPower.live, false)
  assert.equal(snapshot.controls.amp.enabled, false)

  // An empty i2c list is a reading, and it is never a verdict on the bus.
  assert.equal(snapshot.controls.i2c.answered, 0)
  assert.match(snapshot.controls.i2c.note, /about the part/)
  assert.doesNotMatch(snapshot.controls.i2c.note, /pull-up/)

  // mounted:false is the firmware's write test, not an absent card.
  assert.equal(snapshot.controls.sd.mounted, false)
  assert.match(snapshot.controls.sd.note, /the card answers/)

  // Never probed: absent must not read as a failure.
  assert.equal(snapshot.controls.esp32.state, null)
  assert.equal(snapshot.controls.micLevel.rms, null)
})

test('an i2c device that answered once and stopped is called intermittent', () => {
  const state = createBenchState(0)
  feed(state, ['BENCH {"v":1,"up":10,"i2c":[90]}'])
  assert.equal(benchSnapshot(state, { now: 100 }).controls.i2c.note, null)

  // A reboot in between: the DRV2605L attached on one boot and refused on the
  // next, and the wording has to survive the reset to say so.
  feed(state, ['*** Booting nRF Connect SDK v3.4.0-abc ***', 'BENCH {"v":1,"up":10,"i2c":[]}'], 200)
  const after = benchSnapshot(state, { now: 400 })
  assert.equal(after.controls.i2c.answered, 0)
  assert.match(after.controls.i2c.note, /intermittent/)
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

test('links are "not reported" until something reports them', () => {
  const snapshot = benchSnapshot(createBenchState(0), { now: 5_000 })
  for (const link of ['lte', 'socket', 'bt']) {
    assert.equal(snapshot.links[link].reported, false, `${link} starts unreported`)
    assert.equal(snapshot.links[link].ageMs, null)
  }
  // Never-sampled must not read as a measured failure.
  assert.equal(snapshot.links.lte.on, null)
  assert.equal(snapshot.links.socket.up, null)
  assert.equal(snapshot.links.bt.connected, null)
})

test('the slow line carries the whole link picture', () => {
  const state = createBenchState(0)
  applyLine(
    state,
    `${BENCH_LINE_PREFIX}${JSON.stringify({
      v: 1,
      up: 60000,
      lte: { reg: 'home', op: 'AT&T', rsrp: -95, rsrq: -9.5, band: 12, mode: 'ltem' },
      sock: { up: true, idle: 1450 },
      bt: { conn: true, name: 'SoundCore 2', addr: 'AA:BB:CC:DD:EE:FF' },
      mic: { sense: 1, peak: 91234, rms: 560 },
    })}`,
    1_000,
  )

  const { links, controls } = benchSnapshot(state, { now: 1_000 })
  assert.equal(links.lte.reported, true)
  assert.equal(links.lte.on, true)
  assert.equal(links.lte.word, 'ON NET')
  assert.equal(links.lte.operator, 'AT&T')
  assert.equal(links.lte.rsrpDbm, -95)
  assert.equal(links.socket.up, true)
  assert.equal(links.socket.idleMs, 1450)
  assert.equal(links.bt.connected, true)
  assert.equal(links.bt.name, 'SoundCore 2')
  // The mic's two facts stay separate: powered, and actually hearing something.
  assert.equal(controls.micPower.live, true)
  assert.equal(controls.micLevel.rms, 560)
  assert.equal(controls.micLevel.band, 'sound')
})

test('searching and denied are distinct from not-registered, and none is a fault', () => {
  for (const [stat, reg, word] of [
    [0, 'not-registered', 'NOT ON'],
    [1, 'home', 'ON NET'],
    [2, 'searching', 'SEARCHING'],
    [3, 'denied', 'DENIED'],
    [5, 'roaming', 'ROAMING'],
    [90, 'uicc-fail', 'NO SIM'],
  ]) {
    const state = createBenchState(0)
    applyLine(state, `LTE probe reg: +CEREG: 2,${stat}`, 1_000)
    const lte = benchSnapshot(state, { now: 1_000 }).links.lte
    assert.equal(lte.reg, reg)
    assert.equal(lte.word, word)
    assert.equal(lte.on, reg === 'home' || reg === 'roaming')
  }
})

test('the modem\'s own signal probe is read as dBm, and 255 stays unknown', () => {
  const known = createBenchState(0)
  applyLine(known, 'LTE probe signal: +CESQ: 99,99,255,255,20,45', 1_000)
  const good = benchSnapshot(known, { now: 1_000 }).links.lte
  assert.equal(good.rsrpDbm, -95)
  assert.equal(good.rsrqDb, -9.5)

  // 255 is "the modem does not know" and must not become a very bad reading.
  const unknown = createBenchState(0)
  applyLine(unknown, 'LTE probe signal: +CESQ: 99,99,255,255,255,255', 1_000)
  const none = benchSnapshot(unknown, { now: 1_000 }).links.lte
  assert.equal(none.rsrpDbm, null)
  assert.equal(none.rsrqDb, null)
  assert.equal(none.reported, true, 'the probe happened even though it knew nothing')
})

test('a remembered bluetooth sink is not a connected one', () => {
  const state = createBenchState(0)
  applyLine(state, 'BT sink remembered: SoundCore 2 [AA:BB:CC:DD:EE:FF] (1 known)', 1_000)

  const remembered = benchSnapshot(state, { now: 1_000 }).links.bt
  assert.equal(remembered.name, 'SoundCore 2')
  assert.equal(remembered.address, 'AA:BB:CC:DD:EE:FF')
  assert.equal(remembered.connected, null, 'remembering a speaker is not reaching it')

  applyLine(state, 'BT module: sink connected', 2_000)
  assert.equal(benchSnapshot(state, { now: 2_000 }).links.bt.connected, true)
})

test('a dead BT module UART is reported as the reason, not as a missing speaker', () => {
  const state = createBenchState(0)
  applyLine(state, 'BT module UART (P0.00/P0.05) not ready — Bluetooth unavailable', 1_000)
  const bt = benchSnapshot(state, { now: 1_000 }).links.bt
  assert.equal(bt.connected, false)
  assert.match(bt.note, /UART is not up/)
})

test('pot conversions match the console arithmetic', () => {
  assert.equal(potPercent(0), 0)
  assert.equal(potPercent(4095), 100)
  assert.equal(potVolts(4095), 3)
  assert.equal(potVolts(2048), 1.5)
  assert.equal(potPercent(null), null)
  assert.equal(potVolts(undefined), null)
})

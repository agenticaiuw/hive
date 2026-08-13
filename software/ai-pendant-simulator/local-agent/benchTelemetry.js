/*
 * Bench telemetry — what the breadboard is doing right now, as data.
 *
 * The owner is wiring the pendant by hand and cannot tell a working wire from
 * a dead one by looking at it. This module turns whatever the nRF9160 says on
 * its console into one snapshot per control, so a dashboard can show it.
 *
 * TWO LINE FORMATS, ONE SNAPSHOT
 * ------------------------------
 * 1. `BENCH {...}` — the machine contract (below). Nothing emits it yet; it is
 *    specified here and handed to whoever owns the firmware.
 * 2. The self-test app's human console text (firmware/nrf9160/selftest). That
 *    app is already flashed and already prints every value this dashboard
 *    wants, in prose. Parsing prose is normally a bad idea; here it is the
 *    difference between an instrument that works on the owner's bench TODAY
 *    and one that works after somebody else's commit lands. Both parsers feed
 *    the identical snapshot, so the UI never learns which one spoke.
 *
 * THE MACHINE CONTRACT (firmware TODO)
 * ------------------------------------
 * One line, ~10 Hz, on the same console, prefixed so it survives being
 * interleaved with log output:
 *
 *   BENCH {"v":1,"up":18734,"btn":{"p21":1,"p22":1,"p23":0},
 *          "enc":{"a":1,"b":0,"pos":37,"det":9},"pot":{"raw":2048},
 *          "mic":{"sense":1,"peak":1234,"rms":56},"amp":0}
 *
 * and one slower line (~1 Hz, or once after each scan) for the facts that do
 * not change at 10 Hz:
 *
 *   BENCH {"v":1,"up":18800,"fw":"selftest 1.0","i2c":[90],
 *          "sd":{"present":true,"bytes":15931539456},"esp":"ok"}
 *
 * Field notes, which are the whole reason this is written down:
 *   - EVERY key except `v` is optional. Lines are MERGED into a running
 *     snapshot, so a phase that only knows about the microphone may send only
 *     `mic`. Absent is not zero; absent means "not reported this line", and
 *     the previous value keeps its own timestamp so the UI can age it out.
 *   - `up` is uptime in ms (k_uptime_get()), not a wall clock.
 *   - Button/encoder/sense values are RAW PAD LEVELS: 1 = HIGH, 0 = LOW. The
 *     buttons are active-low against internal pull-ups, so `pressed` is
 *     derived here, not in the firmware. A firmware that pre-derives it hides
 *     the one reading that distinguishes "unpressed" from "wire fell off".
 *   - `pot.raw` is the 12-bit SAADC count, 0..4095. Volts and percent are
 *     derived here (VDD assumed 3.0 V, matching the self-test).
 *   - `i2c` is an array of 7-bit addresses as NUMBERS (90 = 0x5A).
 *   - `esp` is one of "ok" | "silent" | "partial".
 *   - `amp` is the SD_MODE pad level read back, 0 = amp in shutdown.
 *
 * Nothing in this file does I/O. It is a parser and a state machine, so the
 * seams that matter can be tested without a board on the desk.
 */

/** 12-bit SAADC. */
export const POT_RAW_MAX = 4095

/** The self-test prints volts against this same assumption. */
export const POT_VDD_MV = 3000

/** Machine lines carry this prefix so log noise cannot be mistaken for one. */
export const BENCH_LINE_PREFIX = 'BENCH '

/** Sparkline depth. ~12 s of pot samples at 10 Hz, and it is only a picture. */
const HISTORY_LIMIT = 120

/*
 * Lose the stream for this long and every per-board statistic starts over.
 *
 * A gap means we stopped observing, and the owner is REWIRING while he watches
 * this page — so evidence gathered before a gap may describe a circuit that no
 * longer exists. "3 presses" carried across a rewire says a button works when
 * what it really says is that it worked before he moved the wire. Under-
 * reporting after a gap is safe; over-reporting is the failure this instrument
 * exists to prevent. Comfortably longer than the link's own 10 s idle release,
 * so a page reload does not wipe his counts.
 */
const CONTINUITY_GAP_MS = 30_000

/*
 * The app is still bringing peripherals up for the first stretch after boot,
 * and a SAADC that has not been configured reports 0. Those zeros arrive in
 * runs, interleaved with normal readings, with no gradual approach on either
 * side — a knob turned to its end slides monotonically. Folding them into the
 * extremes made the owner's mis-wired pot look more than twice as good as it
 * is. A reading taken before the thing that takes readings exists is not a
 * measurement, so it moves the live value and nothing else.
 */
const BOOT_SETTLE_MS = 1500

/*
 * The board's controls, named once, and the ONLY place this dashboard learns
 * what a button is for. Pin numbers are the contract with
 * hardware/BREADBOARD_WIRING.md; the roles are the owner's ruling of
 * 2026-08-13: "no, i said yellow combine both and blue is for memo".
 *
 * Yellow therefore carries talk AND push-to-talk, blue is the memo, and green
 * owns nothing — its wires came off the board and cannot be reattached today.
 * `unwired` is not cosmetic: a disconnected pin floats HIGH against its
 * internal pull-up, which is bit-for-bit what an untouched button reads, so
 * green's tile can never prove anything either way and must say so instead of
 * implying it is under test.
 */
export const BUTTONS = [
  { key: 'p21', pin: 21, colour: 'yellow', role: 'Talk + push-to-talk', unwired: false },
  { key: 'p22', pin: 22, colour: 'green', role: null, unwired: true },
  { key: 'p23', pin: 23, colour: 'blue', role: 'Memo', unwired: false },
]

const BUTTON_BY_COLOUR = new Map(BUTTONS.map((button) => [button.colour, button]))
const BUTTON_BY_PIN = new Map(BUTTONS.map((button) => [button.pin, button]))
const BUTTON_BY_KEY = new Map(BUTTONS.map((button) => [button.key, button]))

/** Addresses the wiring doc expects to answer, so an extra one stands out. */
const I2C_NAMES = new Map([[0x5a, 'DRV2605L haptic driver']])

function ring(list, value) {
  list.push(value)
  if (list.length > HISTORY_LIMIT) {
    list.splice(0, list.length - HISTORY_LIMIT)
  }
  return list
}

function fresh(now) {
  return {
    startedAt: now,
    /* Set when a stream gap forced the statistics to start over. */
    continuityGapMs: null,
    lastLineAt: null,
    lastParsedAt: null,
    linesSeen: 0,
    linesParsed: 0,
    source: null,
    firmware: { name: null, uptimeMs: null, round: null, phase: null, phaseAt: null },
    buttons: new Map(
      BUTTONS.map((button) => [
        button.key,
        {
          ...button,
          level: null,
          at: null,
          presses: 0,
          edges: 0,
          lastEdgeAt: null,
          lastPressAt: null,
        },
      ]),
    ),
    encoder: {
      a: null,
      b: null,
      position: 0,
      detents: 0,
      cw: 0,
      ccw: 0,
      direction: null,
      at: null,
      levelsAt: null,
    },
    pot: { raw: null, at: null, min: null, max: null, history: [] },
    micPower: { level: null, at: null, changes: 0 },
    micLevel: { peak: null, rms: null, at: null, history: [] },
    i2c: { addresses: [], answered: null, at: null, note: null, everAnswered: false },
    sd: {
      present: null,
      sectors: null,
      sectorSize: null,
      bytes: null,
      mounted: null,
      note: null,
      at: null,
    },
    amp: { level: null, at: null, toggles: 0 },
    esp32: { state: null, at: null },
    /*
     * The links. Everything below is "is this thing talking to anything",
     * as opposed to the pins above, and every field starts null rather than
     * at a plausible-looking zero: a radio that has never been sampled and a
     * radio that has failed to register are different facts, and rendering
     * them the same is how a bench instrument starts lying.
     */
    lte: {
      reg: null,
      operator: null,
      rsrpDbm: null,
      rsrqDb: null,
      band: null,
      mode: null,
      cell: null,
      at: null,
    },
    socket: { up: null, idleMs: null, at: null },
    bt: { connected: null, name: null, address: null, note: null, at: null },
  }
}

/*
 * +CEREG <stat>, 3GPP 27.007 §7.2 plus Nordic's UICC extension. These are the
 * modem's own words for where it is, and they are worth keeping distinct:
 * "searching" is a radio doing its job, "denied" is a SIM/subscription
 * problem, and only "not-registered" after a long search is a fault.
 */
const LTE_REG = new Map([
  [0, 'not-registered'],
  [1, 'home'],
  [2, 'searching'],
  [3, 'denied'],
  [4, 'unknown'],
  [5, 'roaming'],
  [90, 'uicc-fail'],
])

/** Human words for the tile, so the UI never has to interpret the token. */
export const LTE_REG_WORD = new Map([
  ['not-registered', 'NOT ON'],
  ['home', 'ON NET'],
  ['searching', 'SEARCHING'],
  ['denied', 'DENIED'],
  ['unknown', 'UNKNOWN'],
  ['roaming', 'ROAMING'],
  ['uicc-fail', 'NO SIM'],
])

/** A clean slate. Call once per link; `applyLine` does the rest. */
export function createBenchState(now = Date.now()) {
  return fresh(now)
}

/*
 * A reboot resets the board's counters, so it must reset ours. Keeping the
 * pre-reboot press count alive across a reset is how a dashboard ends up
 * claiming a button works after the wire has been pulled out.
 */
function resetForBoot(state, now) {
  const carried = { startedAt: state.startedAt, continuityGapMs: state.continuityGapMs }
  /*
   * One fact deliberately survives the wipe: whether this device has EVER
   * answered on this link. The DRV2605L was measured attaching on one boot
   * (status=0xe4) and refusing on the very next (-116), and "it answered
   * earlier and has stopped" is a different diagnosis from "it has never
   * answered" — the first is intermittent, which is a solder joint or a
   * marginal pull-up, the second is a part that is not there. Resetting it
   * with the boot would erase the only evidence that distinguishes them.
   */
  const everAnswered = state.i2c.everAnswered
  const next = fresh(now)
  Object.assign(state, next, carried)
  state.i2c.everAnswered = everAnswered
  state.firmware.phase = 'boot'
  state.firmware.phaseAt = now
}

/*
 * `edge` separates the two kinds of line that carry a button level.
 *
 * A sampled level ("P0.21 yellow button = HIGH", or a 10 Hz machine line) only
 * counts as a press when it differs from the level before it. An event line
 * ("yellow button P0.21  PRESSED") is printed BECAUSE the pin moved, so it
 * counts even when it is the first thing this process has ever seen from that
 * pin — otherwise the owner's first press of the session vanishes, which is
 * precisely the press they are watching for.
 */
function noteButtonLevel(state, button, level, now, { edge = false } = {}) {
  const entry = state.buttons.get(button.key)
  if (!entry) return
  const moved = entry.level === null ? edge : entry.level !== level
  if (moved) {
    entry.edges += 1
    entry.lastEdgeAt = now
    if (level === 0) {
      entry.presses += 1
      /*
       * When the button was last PUSHED, as distinct from when this pin was
       * last sampled. At 10 Hz the sample time is always "now" and says
       * nothing; the owner presses a button and then looks up, so the only
       * useful recency is the press itself.
       */
      entry.lastPressAt = now
    }
  }
  entry.level = level
  entry.at = now
}

function noteEncoderDetent(state, direction, cw, ccw, now) {
  state.encoder.direction = direction
  if (Number.isFinite(cw)) state.encoder.cw = cw
  if (Number.isFinite(ccw)) state.encoder.ccw = ccw
  state.encoder.detents = state.encoder.cw + state.encoder.ccw
  state.encoder.position = state.encoder.cw - state.encoder.ccw
  state.encoder.at = now
}

function notePot(state, raw, now, { measured = true } = {}) {
  if (!Number.isFinite(raw) || raw < 0) return
  state.pot.raw = raw
  state.pot.at = now
  ring(state.pot.history, { at: now, raw })
  /*
   * Extremes are a claim about the TRACK; the live value is only a claim about
   * this instant. A sample taken while the board was still initialising is a
   * fine thing to display and a terrible thing to fold into a span.
   */
  if (!measured) return
  state.pot.min = state.pot.min === null ? raw : Math.min(state.pot.min, raw)
  state.pot.max = state.pot.max === null ? raw : Math.max(state.pot.max, raw)
}

function noteMicPower(state, level, now) {
  if (state.micPower.level !== null && state.micPower.level !== level) {
    state.micPower.changes += 1
  }
  state.micPower.level = level
  state.micPower.at = now
}

function noteMicLevel(state, peak, rms, now) {
  state.micLevel.peak = peak
  state.micLevel.rms = rms
  state.micLevel.at = now
  ring(state.micLevel.history, { at: now, peak, rms })
}

function noteI2c(state, addresses, now) {
  state.i2c.addresses = addresses
  state.i2c.answered = addresses.length
  state.i2c.at = now
  if (addresses.length) {
    state.i2c.everAnswered = true
    state.i2c.note = null
    return
  }
  /*
   * Never a verdict on the bus. hw-selftest measured P0.30/31 over SWD and both
   * hold high against an internal pull-down, so the external 4.7k parts are
   * fitted and their rail is alive; blaming them here sends the owner after the
   * wrong wire.
   */
  state.i2c.note = state.i2c.everAnswered
    ? 'intermittent — it answered earlier on this board, then stopped'
    : 'nothing answered — the bus itself reads healthy, so this is about the part'
}

/* ------------------------------------------------------------------ */
/* Parser 1 — the machine contract                                     */
/* ------------------------------------------------------------------ */

function applyBenchJson(state, payload, now) {
  if (!payload || typeof payload !== 'object') return false

  if (typeof payload.fw === 'string') state.firmware.name = payload.fw
  /*
   * Uptime going BACKWARDS is the board telling us it restarted, and it is a
   * marker the firmware already sends on every line — no new contract needed.
   * A reset seen only as a boot banner is a reset we miss whenever the reader
   * was detached for it (a reflash, a stand-down, a power cycle), and the
   * statistics then run straight across a board that is no longer the same
   * board. This catches those.
   */
  if (
    Number.isFinite(payload.up) &&
    Number.isFinite(state.firmware.uptimeMs) &&
    payload.up < state.firmware.uptimeMs
  ) {
    resetForBoot(state, now)
    state.firmware.name = typeof payload.fw === 'string' ? payload.fw : state.firmware.name
  }
  if (Number.isFinite(payload.up)) state.firmware.uptimeMs = payload.up
  if (typeof payload.phase === 'string') {
    state.firmware.phase = payload.phase
    state.firmware.phaseAt = now
  }

  if (payload.btn && typeof payload.btn === 'object') {
    for (const [key, value] of Object.entries(payload.btn)) {
      const button = BUTTON_BY_KEY.get(key) || BUTTON_BY_PIN.get(Number(key))
      if (button && (value === 0 || value === 1)) {
        noteButtonLevel(state, button, value, now)
      }
    }
  }

  if (payload.enc && typeof payload.enc === 'object') {
    const enc = payload.enc
    if (enc.a === 0 || enc.a === 1) state.encoder.a = enc.a
    if (enc.b === 0 || enc.b === 1) state.encoder.b = enc.b
    if (enc.a === 0 || enc.a === 1 || enc.b === 0 || enc.b === 1) {
      state.encoder.levelsAt = now
    }
    if (Number.isFinite(enc.pos)) {
      if (state.encoder.position !== enc.pos) {
        state.encoder.direction = enc.pos > state.encoder.position ? 'cw' : 'ccw'
        state.encoder.at = now
      }
      state.encoder.position = enc.pos
    }
    if (Number.isFinite(enc.det)) {
      if (enc.det !== state.encoder.detents) state.encoder.at = now
      state.encoder.detents = enc.det
    }
    if (Number.isFinite(enc.cw)) state.encoder.cw = enc.cw
    if (Number.isFinite(enc.ccw)) state.encoder.ccw = enc.ccw
  }

  if (payload.pot && Number.isFinite(payload.pot.raw)) {
    const booting = Number.isFinite(payload.up) && payload.up < BOOT_SETTLE_MS
    notePot(state, payload.pot.raw, now, { measured: !booting })
  }

  if (payload.mic && typeof payload.mic === 'object') {
    if (payload.mic.sense === 0 || payload.mic.sense === 1) {
      noteMicPower(state, payload.mic.sense, now)
    }
    if (Number.isFinite(payload.mic.rms) || Number.isFinite(payload.mic.peak)) {
      noteMicLevel(
        state,
        Number.isFinite(payload.mic.peak) ? payload.mic.peak : state.micLevel.peak,
        Number.isFinite(payload.mic.rms) ? payload.mic.rms : state.micLevel.rms,
        now,
      )
    }
  }

  if (Array.isArray(payload.i2c)) {
    noteI2c(
      state,
      payload.i2c
        .filter((address) => Number.isFinite(address))
        .map((address) => ({
          address,
          hex: `0x${Number(address).toString(16).padStart(2, '0')}`,
          name: I2C_NAMES.get(Number(address)) || null,
          expected: I2C_NAMES.has(Number(address)),
        })),
      now,
    )
  }

  if (payload.sd && typeof payload.sd === 'object') {
    if (typeof payload.sd.present === 'boolean') state.sd.present = payload.sd.present
    if (Number.isFinite(payload.sd.bytes)) state.sd.bytes = payload.sd.bytes
    if (Number.isFinite(payload.sd.sectors)) state.sd.sectors = payload.sd.sectors
    if (typeof payload.sd.mounted === 'boolean') {
      state.sd.mounted = payload.sd.mounted
      /*
       * `mounted:false` is the firmware's verdict AFTER its own write test, not
       * "no card". On this board the card answers and mounts and the
       * persistence file will not create (-2). Reporting that as an absent or
       * unwired card would send the owner to re-seat four good jumpers.
       */
      state.sd.note = payload.sd.mounted
        ? null
        : 'the card answers — the firmware\'s own write test is what did not pass'
    }
    state.sd.at = now
  }

  if (payload.amp === 0 || payload.amp === 1) {
    if (state.amp.level !== null && state.amp.level !== payload.amp) state.amp.toggles += 1
    state.amp.level = payload.amp
    state.amp.at = now
  }

  if (typeof payload.esp === 'string') {
    state.esp32.state = payload.esp
    state.esp32.at = now
  }

  if (payload.lte && typeof payload.lte === 'object') {
    const lte = payload.lte
    if (typeof lte.reg === 'string') state.lte.reg = lte.reg
    if (typeof lte.op === 'string') state.lte.operator = lte.op
    if (Number.isFinite(lte.rsrp)) state.lte.rsrpDbm = lte.rsrp
    if (Number.isFinite(lte.rsrq)) state.lte.rsrqDb = lte.rsrq
    if (Number.isFinite(lte.band)) state.lte.band = lte.band
    if (typeof lte.mode === 'string') state.lte.mode = lte.mode
    if (typeof lte.cell === 'string') state.lte.cell = lte.cell
    state.lte.at = now
  }

  if (payload.sock && typeof payload.sock === 'object') {
    if (typeof payload.sock.up === 'boolean') state.socket.up = payload.sock.up
    if (Number.isFinite(payload.sock.idle)) state.socket.idleMs = payload.sock.idle
    state.socket.at = now
  }

  if (payload.bt && typeof payload.bt === 'object') {
    if (typeof payload.bt.conn === 'boolean') state.bt.connected = payload.bt.conn
    if (typeof payload.bt.name === 'string') state.bt.name = payload.bt.name
    if (typeof payload.bt.addr === 'string') state.bt.address = payload.bt.addr
    state.bt.at = now
  }

  state.source = 'bench-json'
  return true
}

/* ------------------------------------------------------------------ */
/* Parser 2 — the self-test's console prose                            */
/* ------------------------------------------------------------------ */

/*
 * Each rule below quotes the printk it reads. When the self-test's wording
 * changes, the quote is what makes the drift findable — a regex on its own
 * says nothing about which line it was aimed at.
 */
const TEXT_RULES = [
  // "#  PENDANT BREADBOARD SELF-TEST"
  {
    re: /PENDANT BREADBOARD SELF-TEST/,
    resets: true,
    apply: (state, _match, now) => {
      resetForBoot(state, now)
      state.firmware.name = 'pendant selftest'
    },
  },
  // "########  ROUND 3  ########"
  {
    re: /########\s+ROUND (\d+)\s+########/,
    apply: (state, match, now) => {
      state.firmware.round = Number(match[1])
      state.firmware.phase = 'interactive'
      state.firmware.phaseAt = now
    },
  },
  // " INTERACTIVE WINDOW — 45 seconds."
  {
    re: /INTERACTIVE WINDOW/,
    apply: (state, _match, now) => {
      state.firmware.phase = 'interactive'
      state.firmware.phaseAt = now
    },
  },
  // "[8] MICROPHONE  SPH0645 on I2S (slave RX), DOUT -> P0.20"
  {
    re: /\[8\] MICROPHONE/,
    apply: (state, _match, now) => {
      state.firmware.phase = 'microphone'
      state.firmware.phaseAt = now
    },
  },
  // "  [ 1234 ms] yellow button P0.21  PRESSED"
  {
    re: /\[\s*(\d+) ms\]\s+(yellow|green|blue) button\s+P0\.(\d+)\s+(PRESSED|released)/,
    apply: (state, match, now) => {
      const button = BUTTON_BY_COLOUR.get(match[2]) || BUTTON_BY_PIN.get(Number(match[3]))
      if (!button) return
      noteButtonLevel(state, button, match[4] === 'PRESSED' ? 0 : 1, now, { edge: true })
    },
  },
  // "  [ 1234 ms] encoder detent  CW   (total cw=3 ccw=1)"
  {
    re: /\[\s*(\d+) ms\]\s+encoder detent\s+(CW|CCW)\s+\(total cw=(-?\d+) ccw=(-?\d+)\)/,
    apply: (state, match, now) => {
      noteEncoderDetent(
        state,
        match[2] === 'CW' ? 'cw' : 'ccw',
        Number(match[3]),
        Number(match[4]),
        now,
      )
    },
  },
  // "  [ 1234 ms] mic power P0.26 -> HIGH  (red switch FEEDING the mic)"
  {
    re: /\[\s*(\d+) ms\]\s+mic power P0\.26 -> (HIGH|LOW)/,
    apply: (state, match, now) => {
      noteMicPower(state, match[2] === 'HIGH' ? 1 : 0, now)
    },
  },
  // "  [ 1234 ms] pot P0.15 raw=2048 (50%)  span so far 12..4090"
  {
    re: /\[\s*(\d+) ms\]\s+pot P0\.15 raw=\s*(\d+)\s+\(\d+%\)\s+span so far (\d+)\.\.(\d+)/,
    apply: (state, match, now) => {
      notePot(state, Number(match[2]), now)
      state.pot.min = Number(match[3])
      state.pot.max = Number(match[4])
    },
  },
  // "    raw=2048   50.0%  ~1.500 V (assuming VDD=3.0 V)"  (boot sweep)
  {
    re: /^\s*raw=\s*(\d+)\s+\d+\.\d%\s+~\d+\.\d+ V/,
    apply: (state, match, now) => {
      notePot(state, Number(match[1]), now)
    },
  },
  // "    P0.21 yellow button  = HIGH   (expected HIGH)"  (resting levels)
  {
    re: /^\s*P0\.(\d{1,2})\s+(yellow button|green button|blue button|encoder A|encoder B|mic sense)\s*=\s*(HIGH|LOW)/,
    apply: (state, match, now) => {
      const level = match[3] === 'HIGH' ? 1 : 0
      const name = match[2]
      if (name.endsWith('button')) {
        const button = BUTTON_BY_COLOUR.get(name.split(' ')[0]) || BUTTON_BY_PIN.get(Number(match[1]))
        if (button) noteButtonLevel(state, button, level, now)
        return
      }
      if (name === 'encoder A') {
        state.encoder.a = level
        state.encoder.levelsAt = now
        return
      }
      if (name === 'encoder B') {
        state.encoder.b = level
        state.encoder.levelsAt = now
        return
      }
      noteMicPower(state, level, now)
    },
  },
  // "    peak=91234     rms=560       |||||    sound"
  {
    re: /^\s*peak=(-?\d+)\s+rms=(\d+)/,
    apply: (state, match, now) => {
      noteMicLevel(state, Number(match[1]), Number(match[2]), now)
    },
  },
  // "    ACK       0x5a  <- DRV2605L haptic driver (expected)"
  {
    re: /^\s*ACK\s+0x([0-9a-fA-F]{2})/,
    apply: (state, match, now) => {
      const address = Number.parseInt(match[1], 16)
      const seen = state.i2c.addresses.some((entry) => entry.address === address)
      if (seen) return
      noteI2c(
        state,
        [
          ...state.i2c.addresses,
          {
            address,
            hex: `0x${address.toString(16).padStart(2, '0')}`,
            name: I2C_NAMES.get(address) || null,
            expected: I2C_NAMES.has(address),
          },
        ].sort((left, right) => left.address - right.address),
        now,
      )
    },
  },
  // "    FAIL      NOTHING ON THE BUS. Not one address answered."
  {
    re: /NOTHING ON THE BUS/,
    apply: (state, _match, now) => {
      noteI2c(state, [], now)
      state.i2c.note = 'no address answered — suspect the two external 4.7k pull-ups'
    },
  },
  // "    ---       card present: 31116288 sectors x 512 B = 15193 MiB"
  {
    re: /card present: (\d+) sectors x (\d+) B/,
    apply: (state, match, now) => {
      state.sd.present = true
      state.sd.sectors = Number(match[1])
      state.sd.sectorSize = Number(match[2])
      state.sd.bytes = Number(match[1]) * Number(match[2])
      state.sd.at = now
    },
  },
  // "    FAIL      disk_access_init = -5 — the card never answered CMD0"
  {
    re: /disk_access_init = (-?\d+)/,
    apply: (state, _match, now) => {
      state.sd.present = false
      state.sd.mounted = false
      /*
       * Measured over SWD the same day: DO (P0.12) holds high, so the breakout
       * has power. CMD0 silence is a question about the CARD, not a verdict on
       * the rail or the wiring — leading with "a wire is off" sends the owner
       * to re-seat four good jumpers before checking the slot.
       */
      state.sd.note = 'no card, or not seated — the breakout itself has power'
      state.sd.at = now
    },
  },
  // "    PASS      wrote and read back \"...\" at /SD:/selftest.txt"
  {
    re: /PASS\s+wrote and read back/,
    apply: (state, _match, now) => {
      state.sd.present = true
      state.sd.mounted = true
      state.sd.note = null
      state.sd.at = now
    },
  },
  // "    drove HIGH -> pad reads HIGH"
  {
    re: /drove (HIGH|LOW) -> pad reads (HIGH|LOW)/,
    apply: (state, match, now) => {
      const level = match[2] === 'HIGH' ? 1 : 0
      if (state.amp.level !== null && state.amp.level !== level) state.amp.toggles += 1
      state.amp.level = level
      state.amp.at = now
    },
  },
  // "    PASS      P0.01 toggles (left LOW = amp in shutdown, the boot default)"
  {
    re: /PASS\s+P0\.01 toggles/,
    apply: (state, _match, now) => {
      state.amp.level = 0
      state.amp.at = now
    },
  },
  // "    PASS        a JSON-looking line came back — both wires and ..."
  {
    re: /PASS\s+a JSON-looking line came back/,
    apply: (state, _match, now) => {
      state.esp32.state = 'ok'
      state.esp32.at = now
    },
  },
  // "    no reply    nothing arrived in 2 s."
  {
    re: /no reply\s+nothing arrived/,
    apply: (state, _match, now) => {
      state.esp32.state = 'silent'
      state.esp32.at = now
    },
  },
  // "    partial     bytes arrived but no JSON."
  {
    re: /partial\s+bytes arrived but no JSON/,
    apply: (state, _match, now) => {
      state.esp32.state = 'partial'
      state.esp32.at = now
    },
  },

  /*
   * ---- the pendant application's own console ----
   *
   * The self-test is not what is flashed most of the time; the application is,
   * and the owner still wants to see their wires while it runs. Every rule
   * below quotes a printk the app already emits (firmware/nrf9160/src). It
   * covers fewer controls than the self-test — the app has no reason to log a
   * button level — and the tiles it cannot fill stay honestly empty instead of
   * being guessed at.
   */

  // "*** Booting nRF Connect SDK v3.4.0-99553055607b ***"
  {
    re: /\*\*\* Booting nRF Connect SDK (\S+)/,
    resets: true,
    apply: (state, match, now) => {
      resetForBoot(state, now)
      state.firmware.name = `pendant app (NCS ${match[1]})`
    },
  },
  // "Volume: raw=2048 level=0.25"  — printed only when the reading moves
  {
    re: /^Volume: raw=(\d+) level=/,
    apply: (state, match, now) => {
      notePot(state, Number(match[1]), now)
    },
  },
  // "Mic power sense ready (P0.26): mic is MUTED (power cut)" / "... is powered"
  {
    re: /Mic power sense ready \(P0\.26\): mic is (MUTED|powered)/,
    apply: (state, match, now) => {
      noteMicPower(state, match[1] === 'powered' ? 1 : 0, now)
    },
  },
  // "STATUS mic MUTED" / "STATUS mic live"
  {
    re: /^STATUS mic (MUTED|live)/,
    apply: (state, match, now) => {
      noteMicPower(state, match[1] === 'live' ? 1 : 0, now)
    },
  },
  // "Capture press ignored: mic power is cut (red switch)"
  {
    re: /mic power is cut \(red switch\)/,
    apply: (state, _match, now) => {
      noteMicPower(state, 0, now)
    },
  },
  // "Haptic: DRV2605L attached (status=0x03) — LRA open-loop RTP ready"
  {
    re: /Haptic: DRV2605L attached/,
    apply: (state, _match, now) => {
      noteI2c(
        state,
        [{ address: 0x5a, hex: '0x5a', name: I2C_NAMES.get(0x5a) ?? null, expected: true }],
        now,
      )
    },
  },
  // "Haptic: DRV2605L not answering (-5) — haptic actions degrade to ..."
  {
    re: /Haptic: DRV2605L not answering/,
    apply: (state, _match, now) => {
      noteI2c(state, [], now)
      /*
       * NOT "the bus is broken". hw-selftest measured P0.30/31 directly over
       * SWD on 2026-08-13: both held HIGH against the nRF's internal
       * pull-down, with P0.28 (unwired by design) collapsing to LOW as the
       * control — so the external 4.7k pull-ups are fitted and their 3V rail
       * is alive. An absent ACK is a question about the DEVICE, and a UI that
       * says "check the pull-ups" here sends the owner after the wrong wire.
       */
      state.i2c.note = 'the haptic did not answer — the bus itself reads healthy'
    },
  },
  // "E: Card error on CMD0" — the SD driver's own log, not the app's prose
  {
    re: /Card error on CMD0/,
    apply: (state, _match, now) => {
      state.sd.present = false
      state.sd.mounted = false
      /*
       * Measured over SWD the same day: DO (P0.12) holds high, so the breakout
       * has power. CMD0 silence is a question about the CARD, not a verdict on
       * the rail or the wiring — leading with "a wire is off" sends the owner
       * to re-seat four good jumpers before checking the slot.
       */
      state.sd.note = 'no card, or not seated — the breakout itself has power'
      state.sd.at = now
    },
  },
  // "Store recovered from microSD: pending=2 ..."
  {
    re: /recovered from microSD/,
    apply: (state, _match, now) => {
      state.sd.present = true
      state.sd.mounted = true
      state.sd.note = null
      state.sd.at = now
    },
  },
  // "I2S mic capture totals: samples=48000 mean=12 peak=91234 rms=560 ..."
  {
    re: /I2S mic capture totals: .*\bpeak=(\d+) rms=(\d+)/,
    apply: (state, match, now) => {
      noteMicLevel(state, Number(match[1]), Number(match[2]), now)
    },
  },

  /*
   * ---- the links, from the app's existing AT probes ----
   *
   * pendant_cloud.c prints the modem's raw answers ("LTE probe reg: %s"), so
   * the registration state and the signal are already on the console today.
   * Parsing +CEREG and +CESQ is parsing 3GPP 27.007, which is a far more
   * stable contract than any wording we would ask the firmware to invent.
   */

  // "LTE probe reg: +CEREG: 2,1,\"1A2B\",\"01A2B3C4\",7"
  {
    re: /\+CEREG:\s*\d+,(\d+)(?:,"?([0-9A-Fa-f]*)"?,"?([0-9A-Fa-f]*)"?)?/,
    apply: (state, match, now) => {
      state.lte.reg = LTE_REG.get(Number(match[1])) ?? 'unknown'
      if (match[3]) state.lte.cell = match[3]
      state.lte.at = now
    },
  },
  // "LTE probe signal: +CESQ: 99,99,255,255,20,45"
  //   ...,<rsrq_index>,<rsrp_index>; 255 means "the modem does not know",
  //   which must stay null rather than becoming a very bad signal reading.
  {
    re: /\+CESQ:\s*\d+,\d+,\d+,\d+,(\d+),(\d+)/,
    apply: (state, match, now) => {
      const rsrq = Number(match[1])
      const rsrp = Number(match[2])
      state.lte.rsrqDb = rsrq === 255 ? null : rsrq / 2 - 19.5
      state.lte.rsrpDbm = rsrp === 255 ? null : rsrp - 140
      state.lte.at = now
    },
  },
  // "LTE not registered (status=0); reconnecting for relay DNS"
  {
    re: /LTE not registered \(status=(\d+)\)/,
    apply: (state, match, now) => {
      state.lte.reg = LTE_REG.get(Number(match[1])) ?? 'not-registered'
      state.lte.at = now
    },
  },
  // "BT module: sink connected"
  {
    re: /^BT module: sink connected/,
    apply: (state, _match, now) => {
      state.bt.connected = true
      state.bt.note = null
      state.bt.at = now
    },
  },
  /*
   * "BT sink remembered: SoundCore 2 [AA:BB:CC:DD:EE:FF] (1 known)"
   *
   * Remembered is NOT connected — this line is the pendant writing a speaker
   * into its own list, which it does whether or not the speaker is powered on
   * right now. It fills in the name and address and deliberately leaves the
   * connected flag alone.
   */
  {
    re: /^BT sink remembered: (.+?) \[([0-9A-Fa-f:]+)\]/,
    apply: (state, match, now) => {
      state.bt.name = match[1]
      state.bt.address = match[2]
      state.bt.at = now
    },
  },
  // "BT module UART (P0.00/P0.05) not ready — Bluetooth ..."
  {
    re: /BT module UART .* not ready/,
    apply: (state, _match, now) => {
      state.bt.connected = false
      state.bt.note = 'the ESP32 module\'s UART is not up, so no sink can connect'
      state.bt.at = now
    },
  },
]

/**
 * Fold one console line into the state.
 *
 * Returns true when the line meant something. An unrecognised line is not an
 * error — most of the self-test's output is prose for a human — but it does
 * not count as liveness either, which is what keeps a chatty-but-useless
 * stream from reading as a healthy one.
 */
export function applyLine(state, rawLine, now = Date.now()) {
  if (typeof rawLine !== 'string') return false
  const line = rawLine.replace(/\r/g, '')
  if (!line.trim()) return false

  /*
   * A gap in the stream ends the window. See CONTINUITY_GAP_MS: the owner is
   * rewiring while he watches, so statistics gathered before a gap may
   * describe a circuit that no longer exists, and we cannot know whether the
   * board reset while we were not looking.
   *
   * Deliberately uniform across every per-board statistic — pot extremes,
   * press counts, encoder detents, mic-power flips, amp toggles — rather than
   * per-field. The one exception is documented at `resetForBoot`: whether an
   * I2C device has EVER answered survives, because intermittent-versus-absent
   * is precisely a cross-boot question.
   */
  if (state.lastParsedAt !== null && now - state.lastParsedAt > CONTINUITY_GAP_MS) {
    const gapMs = now - state.lastParsedAt
    resetForBoot(state, now)
    state.firmware.phase = null
    state.continuityGapMs = gapMs
  }

  state.linesSeen += 1
  state.lastLineAt = now

  const machineAt = line.indexOf(BENCH_LINE_PREFIX)
  if (machineAt >= 0) {
    const json = line.slice(machineAt + BENCH_LINE_PREFIX.length).trim()
    let payload = null
    try {
      payload = JSON.parse(json)
    } catch {
      // A truncated machine line is a dropped line, not a crash.
      return false
    }
    if (applyBenchJson(state, payload, now)) {
      state.linesParsed += 1
      state.lastParsedAt = now
      return true
    }
    return false
  }

  let matched = false
  for (const rule of TEXT_RULES) {
    const match = rule.re.exec(line)
    if (!match) continue
    rule.apply(state, match, now)
    matched = true
    // A boot banner wipes the state; nothing else on that line can apply.
    if (rule.resets) break
  }

  if (matched) {
    state.linesParsed += 1
    state.lastParsedAt = now
    if (state.source !== 'bench-json') state.source = 'selftest-text'
  }
  return matched
}

/* ------------------------------------------------------------------ */
/* Snapshot                                                            */
/* ------------------------------------------------------------------ */

function age(at, now) {
  return at === null ? null : Math.max(0, now - at)
}

export function potPercent(raw) {
  if (!Number.isFinite(raw)) return null
  return Math.round((raw / POT_RAW_MAX) * 1000) / 10
}

export function potVolts(raw) {
  if (!Number.isFinite(raw)) return null
  return Math.round((raw * POT_VDD_MV) / POT_RAW_MAX) / 1000
}

/** The self-test's own bands, so the dashboard and the console agree. */
export function micBand(rms) {
  if (!Number.isFinite(rms)) return null
  if (rms > 2000) return 'loud'
  if (rms > 500) return 'sound'
  if (rms > 60) return 'faint'
  return 'silent'
}

/*
 * The self-test watches the controls for 45 s, then spends 12 s on the
 * microphone with nothing else polled. During that window a button level is
 * not stale data — it is data nobody is currently looking at, which the UI
 * must say rather than imply.
 */
function watching(state) {
  if (state.source === 'bench-json') return { controls: true, mic: true }
  const phase = state.firmware.phase
  if (phase === 'microphone') return { controls: false, mic: true }
  if (phase === 'interactive') return { controls: true, mic: false }
  return { controls: true, mic: true }
}

/**
 * The whole board in one JSON-safe object.
 *
 * `link` describes the pipe (is anything arriving?), `controls` describes the
 * wires. They are separate on purpose: "the DK is unplugged" and "the DK is
 * here and the button is dead" must never render the same way.
 */
export function benchSnapshot(state, { now = Date.now(), link = null, monitor = null } = {}) {
  const look = watching(state)
  const lastAge = age(state.lastParsedAt, now)
  const streaming = lastAge !== null && lastAge < 3000

  return {
    at: new Date(now).toISOString(),
    now,
    monitor: monitor ?? { available: false, endpoint: null, reason: 'not configured' },
    link: {
      transport: link?.transport ?? 'none',
      port: link?.port ?? null,
      state: link?.state ?? 'absent',
      detail: link?.detail ?? null,
      stub: Boolean(link?.stub),
      attempts: link?.attempts ?? 0,
      openedAt: link?.openedAt ?? null,
      /*
       * Whole-life totals for this link, deliberately NOT the per-boot counts
       * in `stream` below. "Ports open but the board has never said anything"
       * and "the board is connected and momentarily quiet" are different facts,
       * and only these survive a reset to tell them apart.
       */
      ports: link?.ports ?? 0,
      console: link?.console ?? null,
      consoleOpen: link?.consoleOpen ?? null,
      missing: link?.missing ?? [],
      watchers: link?.watchers ?? 0,
      /* Raw-line-tap consumers. Same reason as `watchers`: it answers "why is
       * the port still held" without anyone having to guess. */
      tapWatchers: link?.tapWatchers ?? 0,
      bytes: link?.bytes ?? 0,
      parsed: link?.parsed ?? 0,
    },
    stream: {
      connected: streaming,
      source: state.source,
      lastLineAt: state.lastLineAt,
      lastParsedAt: state.lastParsedAt,
      ageMs: lastAge,
      linesSeen: state.linesSeen,
      linesParsed: state.linesParsed,
      /*
       * Non-null when a gap ended the previous window, so the UI can say the
       * counts below are "since we started watching again" rather than letting
       * them read as the whole session.
       */
      continuityGapMs: state.continuityGapMs,
    },
    firmware: {
      name: state.firmware.name,
      uptimeMs: state.firmware.uptimeMs,
      round: state.firmware.round,
      phase: state.firmware.phase,
      phaseAgeMs: age(state.firmware.phaseAt, now),
      watching: look,
    },
    controls: {
      buttons: [...state.buttons.values()].map((button) => ({
        key: button.key,
        pin: button.pin,
        colour: button.colour,
        role: button.role,
        unwired: button.unwired,
        level: button.level,
        pressed: button.level === null ? null : button.level === 0,
        presses: button.presses,
        edges: button.edges,
        ageMs: age(button.at, now),
        /* Time since the last push and the last edge of any kind. */
        pressedAgoMs: age(button.lastPressAt, now),
        edgeAgoMs: age(button.lastEdgeAt, now),
        watched: look.controls,
        /*
         * "seen" is the only honest verdict a bench can reach on its own: a
         * pin that has moved is wired, a pin that has not is a question.
         */
        moved: button.edges > 0,
      })),
      encoder: {
        a: state.encoder.a,
        b: state.encoder.b,
        levelsAgeMs: age(state.encoder.levelsAt, now),
        position: state.encoder.position,
        detents: state.encoder.detents,
        cw: state.encoder.cw,
        ccw: state.encoder.ccw,
        direction: state.encoder.direction,
        ageMs: age(state.encoder.at, now),
        watched: look.controls,
        moved: state.encoder.detents > 0,
      },
      pot: {
        raw: state.pot.raw,
        percent: potPercent(state.pot.raw),
        volts: potVolts(state.pot.raw),
        min: state.pot.min,
        max: state.pot.max,
        span: state.pot.min === null ? null : state.pot.max - state.pot.min,
        ageMs: age(state.pot.at, now),
        watched: look.controls,
        /*
         * TWO CLAIMS, KEPT APART — this tile got them confused and said a
         * mis-wired pot was fine.
         *
         * `moved` means the wiper responds: the reading tracks the owner's
         * hand, which proves the middle leg, its row, AIN2 and the SAADC. It
         * does NOT mean the control is correct.
         *
         * `narrow` is the wiring question. The SAADC runs gain 1/4 against a
         * VDD/4 reference, so full scale IS the rail and 4095 counts is 3 V
         * with no scaling artefact: a correctly wired pot sweeps nearly 0 to
         * nearly 4095. This board spans 102 counts — 75 mV, 2.5% — which
         * cleared the old `>= 100` threshold by two counts and rendered as
         * "swept 102 counts", i.e. as success. The threshold was written to
         * answer "did he turn it at all", and it got read as "is it wired
         * right". Measurement by hw-selftest across 364 samples of a full
         * end-to-end turn.
         */
        moved: state.pot.min !== null && state.pot.max - state.pot.min >= 100,
        spanPercent:
          state.pot.min === null
            ? null
            : Math.round(((state.pot.max - state.pot.min) / POT_RAW_MAX) * 1000) / 10,
        /*
         * "Has he been turning it" and "how far does the track go" are separate
         * questions, and answering the first with the second is what put this
         * tile wrong twice. A span of 102 counts read as a healthy sweep; the
         * same pot at 99 counts then read as "barely moved", i.e. as if he had
         * not touched it — the same threshold lying in both directions, one
         * count apart.
         *
         * Turning is evidenced by the number of DISTINCT readings, which is
         * independent of how far the track actually goes: a hand on the knob
         * produces a stream of different values whether the track spans the
         * rail or 2% of it. A still knob produces one value repeated.
         */
        swept: new Set(state.pot.history.map((sample) => sample.raw)).size >= 20,
        narrow:
          state.pot.min !== null &&
          new Set(state.pot.history.map((sample) => sample.raw)).size >= 20 &&
          (state.pot.max - state.pot.min) / POT_RAW_MAX < 0.25,
        history: state.pot.history.map((sample) => sample.raw),
      },
      micPower: {
        level: state.micPower.level,
        live: state.micPower.level === null ? null : state.micPower.level === 1,
        changes: state.micPower.changes,
        ageMs: age(state.micPower.at, now),
        watched: look.controls,
      },
      micLevel: {
        peak: state.micLevel.peak,
        rms: state.micLevel.rms,
        band: micBand(state.micLevel.rms),
        /*
         * Same class of trap as the pot, caught in the audit that followed it.
         * `band` is a LABEL for a number, not a verdict on the microphone: a
         * stuck bit, a DC offset or a dead channel reporting a constant 600
         * would render "SOUND" forever and read as a working mic. A live mic's
         * RMS always jitters, so an rms that has not moved by a single count
         * across eight samples is a stuck reading — and that needs no
         * tolerance constant to assert, only equality, which is why it is
         * expressed that way rather than as another "good enough" threshold.
         */
        flat:
          state.micLevel.history.length >= 8 &&
          state.micLevel.history.every((sample) => sample.rms === state.micLevel.history[0].rms),
        /*
         * Peak sitting exactly on the 16-bit maximum is not a loud room, it is
         * a pinned input — a saturated stage, a floating SDIN, or a stuck bit.
         * Constant-free by construction: 32767 is the format's own ceiling, not
         * a "good enough" threshold somebody picked, so this cannot drift out
         * of calibration the way `span >= 100` did.
         */
        saturated: state.micLevel.peak === 32767,
        ageMs: age(state.micLevel.at, now),
        watched: look.mic,
        history: state.micLevel.history.map((sample) => sample.rms),
      },
      i2c: {
        addresses: state.i2c.addresses,
        answered: state.i2c.answered,
        note: state.i2c.note,
        ageMs: age(state.i2c.at, now),
      },
      sd: {
        present: state.sd.present,
        sectors: state.sd.sectors,
        sectorSize: state.sd.sectorSize,
        bytes: state.sd.bytes,
        mounted: state.sd.mounted,
        note: state.sd.note,
        ageMs: age(state.sd.at, now),
      },
      amp: {
        level: state.amp.level,
        enabled: state.amp.level === null ? null : state.amp.level === 1,
        toggles: state.amp.toggles,
        ageMs: age(state.amp.at, now),
      },
      esp32: {
        state: state.esp32.state,
        ageMs: age(state.esp32.at, now),
      },
    },
    /*
     * `reported` is the whole point of this block. Every link here is sampled
     * by the firmware, not by this Mac, and on day one most of it will not be
     * sampled at all — so the UI needs to distinguish "the modem says it is not
     * registered" from "nothing has ever told us about the modem". Without this
     * flag the second renders as the first, and the owner goes looking for a
     * radio fault that no one has measured.
     */
    links: {
      lte: {
        reported: state.lte.at !== null,
        reg: state.lte.reg,
        word: state.lte.reg ? (LTE_REG_WORD.get(state.lte.reg) ?? null) : null,
        operator: state.lte.operator,
        rsrpDbm: state.lte.rsrpDbm,
        rsrqDb: state.lte.rsrqDb,
        band: state.lte.band,
        mode: state.lte.mode,
        cell: state.lte.cell,
        /* Registered on the home network or roaming both count as "on". */
        on: state.lte.reg === null ? null : state.lte.reg === 'home' || state.lte.reg === 'roaming',
        ageMs: age(state.lte.at, now),
      },
      socket: {
        reported: state.socket.at !== null,
        up: state.socket.up,
        idleMs: state.socket.idleMs,
        ageMs: age(state.socket.at, now),
      },
      bt: {
        reported: state.bt.at !== null,
        connected: state.bt.connected,
        name: state.bt.name,
        address: state.bt.address,
        note: state.bt.note,
        ageMs: age(state.bt.at, now),
      },
    },
  }
}

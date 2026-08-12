# AI Pendant — Hardware Controls Wiring (breadboard prototype)

Parts arrived 2026-08-12. This is the exact wiring the firmware in
`firmware/nrf9160` and `firmware/esp32-airpods-bridge` was written against.
Pin claims for everything that already existed (I2S, PWM clocks, microSD,
I2C) live in `firmware/nrf9160/boards/nrf9160dk_nrf9160_ns.overlay` and are
unchanged.

## The table

| Control | Part | From | To | Notes |
| --- | --- | --- | --- | --- |
| Mic power (hard mute) | Red latching switch | 3V rail | SPH0645 VDD (3V pin) | In SERIES with the mic's supply. Latched off = mic is electrically dead. |
| Mic-power sense | 100k resistor | SPH0645 VDD node (switch side of the mic) | nRF9160 **P0.26** | Input, **no pull** in firmware — the 100k must not bias the mic's supply net. High = mic powered, low = owner muted. |
| Ask (talk) button | Yellow momentary | nRF9160 **P0.21** | GND | Active-low, internal pull-up. Behaves exactly like DK Button 1: press = converse, press again = end. |
| Memo button | Green momentary | nRF9160 **P0.22** | GND | Active-low, internal pull-up. Record-only memo: capture + upload + transcript, **no agent planner** (`?dispatch=0`). |
| Push-to-talk button | Blue momentary | nRF9160 **P0.23** | GND | Active-low, internal pull-up. Press = record a question with the **radio off**; press again = one chunked upload **with** the planner (`dispatch=1` + `X-Reply-Stream: opus`), and the spoken answer plays back on the current sink. Remapped from approve/deny on 2026-08-12 — see "Why the blue button is push-to-talk". |
| BT module command TX | jumper | nRF9160 **P0.00** | ESP32 **GPIO16** (RX2) | 115200 8N1, no flow control. The nRF commands the Bluetooth module; this is the interface a BM83-class part actually has. **Requires** the board-controller image built with `vcom2_pins_routing` disabled (this repo's `boards/nrf9160dk_nrf52840.overlay`) — with the stock image the DK's interface MCU drives P0.00 and fights every start bit. |
| BT module command RX | jumper | ESP32 **GPIO17** (TX2) | nRF9160 **P0.05** | Same line, other direction. P0.05 is the DK's LED4 pin; the same board-controller overlay disables `led4_pin_routing` so the LED is switched off the net. Internal pull-up on the nRF side, so an absent module reads as an idle line rather than noise. |
| Rotary encoder A | Encoder phase A | nRF9160 **P0.24** | — | Encoder COMMON to GND; internal pull-ups on A/B. Quadrature-decoded (Gray-code table, ±4 transitions per detent), never edge-counted. |
| Rotary encoder B | Encoder phase B | nRF9160 **P0.25** | — | (same) If detents step the menu the wrong way, swap the A and B wires. |
| Encoder push | Encoder switch pin | nRF9160 **P0.28** | GND | Active-low, internal pull-up. Menu select. Debounced 150 ms in firmware. |
| Volume pot ends | Potentiometer (linear, ~5k–50k) | DK VDD and GND | — | Outer legs across the **nRF9160 DK's** VDD/GND rail (moved off the ESP32 — see below). |
| Volume pot wiper | Potentiometer wiper | nRF9160 **P0.15** (AIN2) | — | SAADC, ratiometric VDD/4 reference so rail sag cancels. The only free analog pin — AIN0–7 are fixed to P0.13–P0.20 in silicon and every other one is taken. ~20 Hz poll, 2 % hysteresis, end-stop snap, squared (perceptual) curve — the ESP32 tuning carried over 1:1. |
| Haptic driver | DRV2605L breakout (I2C **0x5A**) | nRF9160 **P0.30** (SDA) / **P0.31** (SCL) | 3V rail + GND | Shares I2C2 with the accelerometer. VIN → 3V, GND → GND; LRA (VLV101040A) across the driver's OUT+/OUT−. See the I2C section for pull-ups. |
| Accelerometer | LSM6DSOX breakout (I2C **0x6A**) | nRF9160 **P0.30** (SDA) / **P0.31** (SCL) | 3V rail + GND | Same I2C2 bus. 0x6B if the breakout's DO/SDO jumper is tied high. |
| Accelerometer INT1 | LSM6DSOX INT1 pin | nRF9160 **P0.27** | — | Push-pull active-high from the sensor; nRF-side pull-down so a fallen jumper reads "no tap". Double-tap = the yellow button. |
| Speaker amp SD_MODE | MAX98357A SD pin | nRF9160 **P0.01** | — | HIGH = amp plays the LEFT I2S slot (SD_MODE > 1.4 V, datasheet Table 5), LOW = 0.6 µA shutdown. Boot default LOW (Bluetooth stays the sink). Optional ~1 kΩ in series is cheap insurance if the 3 V rail ever sags below the DK's I/O voltage. |
| Speaker amp I2S | MAX98357A BCLK / LRC / DIN | nRF9160 **P0.18** / **P0.17** / **P0.19** | — | Parallel taps on the SAME wires the ESP32 listens to — the amp is a second listener, zero firmware audio-path changes. |
| Speaker amp power | MAX98357A VIN / GND | 3V rail / GND | — | Breadboard: the 3 V rail (~0.55 W into 8 Ω at 3.0 V). Custom board: VIN can take VBAT directly (2.5–5.5 V range) for full loudness off the cell. |
| Speaker | Mini oval 8 Ω 1 W | MAX98357A OUT+ / OUT− | — | Differential output: speaker **+ (red-dot/longer lead) → OUT+**, − → OUT−. With a single speaker a swap only inverts absolute phase — inaudible — but keep the convention so a future stereo/vibration pairing stays in phase. Never ground either OUT pin. |

## Why these choices

**Active-low with internal pull-ups.** Every button and the encoder switch
to GND and lean on the nRF9160's internal pull-ups (declared in the
devicetree overlay, not ad hoc in code). On a breadboard the common failure
is a wire falling out; with pull-ups that failure reads as "not pressed"
forever instead of a floating pin chattering interrupts.

**Mute is a power cut, not a data cut.** The SPH0645 is a *digital* I2S
microphone — there is no analog point to break, and grounding or gating its
DOUT line would only hide the data while the mic sits there powered and
listening. The only hardware mute a digital mic honestly has is taking its
VDD away, which is what the red latching switch does. Two firmware pieces
back it up:

- **P0.26 sense (100k):** firmware reads the mic's supply net so a talk or
  memo press while muted is *suppressed* (nothing records), the device
  blinks a distinct pattern (three fast double-taps), and — when the
  converse WebSocket is open — sends `{"type":"mic_muted"}` so the relay
  knows the press happened and why nothing followed. The 100k keeps the
  sense pin from ever being a meaningful load or drive on the mic's supply.
- **I2S SDIN (P0.20) internal pull-down**, applied via pinctrl bias in the
  overlay: a depowered SPH0645 tri-states DOUT, and an undriven SDIN would
  read as random full-scale garbage. The pull-down turns "mic dark" into
  digital silence. While the mic is powered it simply resolves the frame's
  tri-stated (non-left-slot) cycles to 0, which is what the capture path
  already assumed.

**Encoder debounce is the quadrature state machine.** Contact bounce only
toggles between two adjacent Gray-code states, so it sums to zero in the
transition table; illegal two-bit jumps score zero outright. One menu step
is emitted per full detent (±4 valid transitions). Firmware emits
`{"type":"menu","delta":±1}` / `{"type":"menu_select"}` on the converse
socket when it is open and drops them when it is closed — a knob twist
banked across a dead link would replay as stale intent.

**The knob lives on the nRF9160 now (was: ESP32 GPIO34).** Architecture
ruling: the ESP32 is a stand-in for a dumb Bluetooth module in the end
product, so volume must not depend on it. The wiper moved to P0.15/AIN2
and the gain (Q12 attenuator, 0…unity, perceptual/squared curve) applies
in the nRF's downlink fill — the single point where every decoded sample
becomes an I2S wire word — so **the wire itself carries pre-scaled PCM**
and any future BT module plays the right level knowing nothing about a
knob. The sync preamble is deliberately NOT scaled (the ESP32 locks on it
bit-exact). Reported as `{"type":"volume","level":0.xx,"raw":N}` on the
converse WebSocket when it actually moves (≥2 % with end-stop snap).
*Interim:* until the ESP32's now-dead pot code is stripped, its GPIO34
floats — jumper ESP32 GPIO34 to its 3V3 so the ESP32-side gain reads
unity instead of noise.

**P0.15 / P0.01 and the DK's interface MCU.** Both pins sit in the VCOM2
group the DK's board controller routes to its UART by default
(P0.00/P0.01/P0.14/P0.15). P0.01 is the nRF-TX line of that group — the
interface MCU only *listens* there, so driving SD_MODE on it is safe
(worst case: sink toggles appear as stray bytes to anyone watching VCOM2).
P0.15 is the group's nRF-CTS line, which the IMCU *can* drive: if the
knob ever reads pinned-high garbage, reflash the board controller
(`nrf9160dk/nrf52840` with `vcom2_pins_routing` disabled) and never open
the host's VCOM2 port with hardware flow control on. P0.14 (also in the
group) has carried the PWM LRCLK for weeks without interference — the
IMCU treats it as an input.

**Why the blue button is push-to-talk.** The owner's ruling, and the
arithmetic is in `hardware/design/Solar_Feasibility.md` §4.3: a PTT
question (10 s ask + 15 s reply) costs **0.94 mWh** against **2.3 mWh** for
the same question as a short duplex exchange — **2.4× cheaper**. The reason
is not the codec, it is when the radio is on. Capture with the modem out of
connected mode draws **4.2 mA**; the modem's connected floor is ~65 mA
(45 mA RX monitoring before a single byte is transmitted, ×1.2 for the wrist
antenna). Duplex pays that floor for every second the human is talking and
thinking; push-to-talk pays 4.2 mA for those seconds. And because every
radio touch pays a **~0.32 mWh RRC connection tax** (setup plus the C-DRX
release tail), the design is exactly ONE connection: capture radio-off, then
a single chunked POST that carries the question up and the spoken answer
back down the same socket, then idle. Splitting it into "upload now, fetch
the reply later" would double the tax and erase most of the win.

The transport is not new: it is the existing non-duplex
`/v1/pendant/command` shape with `dispatch=1` (a question wants the planner
— unlike the green button's `dispatch=0`) and `X-Reply-Stream: opus`.
Playback reuses the conversation's own downlink path — same decoder, same
24 kHz jitter ring, same 96/125 TX resampler, same sync preamble — so
whichever sink `audio_sink` currently selects (Bluetooth through the ESP32,
or the MAX98357A speaker) hears it with no new audio code.

**Blue loses approve/deny entirely.** Approvals remain answerable out loud
during the readback and from the dashboard/popup. A blue press while the mic
is hard-muted is suppressed exactly like yellow and green (`{"type":"mic_muted"}`
+ the triple double-blink + the long buzz). A blue press during an OPEN
duplex conversation is ignored with a haptic tick: a conversation already
owns the microphone, the I2S transfer, both codecs and the socket, and the
two modes must not mix.

**Offline PTT is honest about the answer.** A completed question with no
usable link parks in the outbox as kind `'Q'` — distinct from a memo's
`'T'` — and redelivers with the planner ON. The spoken reply cannot play
later: the socket that would have carried it closed with the press. The
answer lands in history and the device stays quiet.

**The Bluetooth module UART (P0.00 / P0.05).** Everything else was taken:
P0.01 is the MAX98357A SD_MODE gate, P0.29 is the console TX, P0.26/27/28
are the mic sense, the accelerometer INT1 and the encoder push, P0.15 is the
volume ADC, P0.10–13 are the microSD SPI, P0.14/16–20 are the audio bus,
P0.21–25 are the buttons and encoder, and P0.30/31 are I2C. That leaves the
VCOM2 group and the DK's LED pins.

- **TX on P0.00** is only legal because this repo already ships a
  board-controller overlay with `vcom2_pins_routing` disabled — the analog
  switch between the interface MCU and P0.00/P0.01/P0.14/P0.15 is open.
  P0.01 has been driving SD_MODE on that same basis for weeks. Flash the
  stock board-controller image and the IMCU drives P0.00 as its VCOM2 TX,
  fighting this output on every start bit. That overlay is a hard
  dependency of this pin, not a nicety.
- **RX on P0.05** is the *highest unused LED pin*, and taking it is a
  deliberate tradeoff: **DK LED4 is gone.** P0.02 is `led0`, the firmware's
  only status LED; P0.03/P0.04 are left free so a future build can add a
  second indicator. The board-controller overlay now also disables
  `led4_pin_routing`, which switches the on-board LED off the net and makes
  P0.05 a clean input. With the stock image instead, the link still runs
  (115200 has 8.7 µs per bit against a network that loads the line by a few
  mA) but LED4 glows on the idle-high line, and an unpowered ESP32 lets the
  LED string pull RX low into a permanent break — no module, no commands,
  which is an honest failure.
- Two wires, no flow control: the traffic is short newline-delimited JSON,
  and no burst in that command set can outrun a 115200 receiver.

**Interrupt budget.** The edge-interrupt inputs (P0.21–23, P0.24/25,
P0.27, P0.28) use the GPIO SENSE mechanism (`sense-edge-mask` in the
overlay) rather than GPIOTE channels — the nRF9160 has only 8 GPIOTE
channels and the DK's own buttons already claim some. Hand-speed controls
(and a double-tap, slower still) do not need GPIOTE latency. P0.26 is
polled and uses no interrupt at all; P0.15 is analog.

**Console is TX-only now.** The DK's default `uart0` pinctrl claimed
P0.26 (CTS, **with a pull-up — directly against the mic-sense no-pull
contract**), P0.27 (RTS) and P0.28 (RX) alongside the P0.29 TX the
console actually uses. Flow control was never on and console input does
not exist in this firmware, so the overlay repins uart0 to TX-only on
P0.29 (`disable-rx`), freeing P0.26/27/28 honestly. printk/VCOM0 output
is unchanged.

## I2C bus (I2C2: SDA P0.30, SCL P0.31, 100 kHz)

| Device | Address | Interrupt | Notes |
| --- | --- | --- | --- |
| DRV2605L haptic driver | 0x5A | none | LRA open-loop RTP; VLV101040A calibration measured on this exact breakout (169.27 Hz, 2.50 Vrms clamp). |
| LSM6DSOX accelerometer | 0x6A (0x6B if DO high) | INT1 → P0.27 | Double-tap only, 104 Hz low-power (~26 µA), gyro in power-down, I3C disabled. Nothing is streamed — the INT edge is the event. |

**Pull-ups are external and mandatory: 4.7 kΩ from SDA→3V and SCL→3V.**
The DK routes no pull-ups to P0.30/P0.31, and the internal ~13 k pulls
are both too weak for reliable 100 kHz edges on breadboard capacitance
and not applied by the i2c pinctrl anyway. One pair serves the whole
bus — do NOT also solder/enable pull-ups on both breakouts (the Adafruit
boards each carry 10 k; two breakouts in parallel with 4.7 k externals
lands at ~2.4 k effective, still legal at 3 V, so leaving the onboard
ones alone is fine — just don't ADD more).

Both parts are probe-once: a missing breakout costs one boot log line,
haptics degrade to LED patterns, double-tap wake simply disappears.

## Bluetooth module command link (uart1, 115200 8N1)

The nRF9160 owns Bluetooth *policy*; the module owns *mechanism*. The wire
between them is one UART carrying newline-delimited JSON, which is exactly
the control surface a BM83-class module has — so replacing the ESP32 with a
real module changes the command strings and nothing else. **The ESP32's USB
port is debug only**: it accepts the identical command set and mirrors every
event, but nothing in the product may depend on it.

| Direction | Frame | Meaning |
| --- | --- | --- |
| nRF → module | `{"command":"scan"}` | run an inquiry; each hit comes back as a `discovery` event |
| nRF → module | `{"command":"connect","target":"<name>"}` | connect (and remember) that sink |
| nRF → module | `{"command":"status"}` | ask for the current link state |
| module → nRF | `{"type":"discovery","state":…,"device":…,"address":…,…}` | a sink was seen |
| module → nRF | `{"type":"bridge","state":"connected"\|"searching"\|"usb","target":…,…}` | link state changed |
| module → nRF | `{"type":"diagnostic",…}` | once-a-second link health; **read and dropped** by the nRF |

**Event field order is a contract.** The nRF receives into a fixed 128-byte
line buffer, so every module event puts `type`, `state` and then the
machine-readable fields (`device`+`address`, or `target`) *before* the
human-readable `message`. The parser also refuses any value whose closing
quote fell outside the buffer, so a truncated address is treated as absent
rather than remembered wrong — half a Bluetooth address is worse than none.

**The sink table.** Four entries (name + address), persisted to
`/SD:/btsinks.idx` with a magic and a checksum — no settings subsystem, no
NVS. Index 0 is the preferred sink; insertion is at the front and eviction
from the back, which *is* the LRU policy (with four entries a shift costs
four 42-byte copies, cheaper than carrying and sorting an age byte). Four is
an owner's real device count: earbuds, desk speaker, car, one spare.

Only a **connection** reorders the table — it is the only proof an entry is
reachable. Discovery merely fills the menu. On boot, and whenever
`audio_sink` selects bluetooth/both, the preferred sink is paged; with
nothing remembered the module is asked to scan instead, which is also what
populates the owner's menu. A 60 s backstop re-page covers a module that was
reset, and stops entirely once a sink answers.

## Haptic effect map (DRV2605L, all open-loop RTP presets)

| Event | Preset | Feel |
| --- | --- | --- |
| Press acknowledged (yellow/tap-tap/encoder push, capture start/stop, blue PTT start/stop) | `click` | one 60 ms crisp click |
| Memo start / memo stop (green) | `tick` | one 25 ms blip |
| Blue press refused mid-conversation | `tick` | one 25 ms blip — "heard you, not now" |
| Incoming approval readback (relay announce frame) | `strong` | one 150 ms full-drive hit |
| Capture press while hard-muted | `long` | one 400 ms soft buzz |

Event haptics run through a non-blocking work-queue engine
(`haptic_trigger`), never the blocking reflex path, so a pattern can fire
from an ISR or mid-conversation without touching the I2S TX runway.
Recipes gain the same three new preset names (`tick`/`click`/`strong`).

## Firmware/relay contract summary

| Event | Wire | When |
| --- | --- | --- |
| Yellow press | same as DK Button 1 (converse start/stop) | always |
| Green press | chunked POST `/v1/pendant/command?dispatch=0` + `X-Pendant-Mode: memo`, no `X-Reply-Stream` | mic powered; SD fallback and offline outbox (kind `'T'`) keep `dispatch=0` on redelivery |
| Blue press (start) | nothing on the wire — capture runs with the radio untouched | mic powered; ignored with a tick while a conversation is open |
| Blue press (stop) | chunked POST `/v1/pendant/command?dispatch=1` + `X-Reply-Stream: opus`; the reply streams back as 2-byte-BE length-prefixed Opus packets on the same socket and plays through the current sink | one RRC connection per question; no link → outbox kind `'Q'`, planner ON at redelivery, **answer lands in history, never in the ear** |
| BT device list (downlink request) | `{"type":"bt_list"}` → device replies `{"type":"bt_devices","devices":[{"index":N,"name":…,"address":…,"preferred":bool}],"connected":bool}` | answered from main's idle loop; **relay-side sender: TODO** |
| BT device pick (downlink) | `{"type":"bt_select","index":N}` → promotes entry N to preferred and commands the module to connect | N indexes the list above (0 = preferred); **relay-side sender: TODO** |
| Encoder detent / push | `{"type":"menu","delta":±1}` / `{"type":"menu_select"}` on the converse WS | socket open, else dropped |
| Capture press while muted | `{"type":"mic_muted"}` on the converse WS + LED pattern + long buzz, capture suppressed | socket open (LED/buzz regardless) |
| Volume knob move | `{"type":"volume","level":0.xx,"raw":N}` on the converse WS | on ≥2% change, ~20 Hz poll (5 Hz idle); gain applied on-device before the wire |
| Accelerometer double-tap | identical to a yellow press (same semaphore) | always; mute suppression included |
| Sink select (downlink) | `{"type":"audio_sink","sink":"speaker"\|"bluetooth"\|"both"}` parsed from the converse WS (mid-conversation or idle) | speaker/both = SD_MODE high; bluetooth = amp shutdown. Selecting bluetooth/both also asks the module to connect the preferred sink — a sink choice that left the module idle would route the next answer into silence. Boot default: bluetooth. **Relay-side sender: TODO** (cloud-relay is owned by another agent) |
| Approval readback announce (downlink) | `{"type":"approval_readback"}` → strong haptic hit | device parses it today; **relay-side sender: TODO** (same reason) |

"Both" is one pin's truth, not two: SD_MODE high makes the amp a second
listener on the same I2S wires the ESP32 taps — whether the ESP32 *also*
plays is the relay/ESP32's business. The wire format needs nothing new
for the amp: 24-bit words in 32-BCLK slots at 31 250 frames/s is inside
the MAX98357A's DAI envelope (16/24/32-bit I2S, 8–96 kHz — datasheet
"Digital Audio Interface Modes" p.16; 31.25 kHz bins with the 32 kHz
digital-filter class, Table 4).

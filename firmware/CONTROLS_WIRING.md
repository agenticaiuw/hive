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
| Rotary encoder A | Encoder phase A | nRF9160 **P0.24** | — | Encoder COMMON (C) to GND; internal pull-ups on A/B. Quadrature-decoded (Gray-code table, ±4 transitions per detent), never edge-counted. **Three wires total** — see "Why the encoder is three wires and select is a dwell". |
| Rotary encoder B | Encoder phase B | nRF9160 **P0.25** | — | (same) If detents step the menu the wrong way, swap the A and B wires. |
| ~~Encoder push~~ | *not wired* | — | — | **Removed 2026-08-12 by owner ruling.** The switch pins of the illuminated encoder are left unconnected and the firmware handler is gone. **P0.28 is FREE** — first claim on the next feature that needs a GPIO. |
| Volume pot ends | Potentiometer (linear, ~5k–50k) | DK VDD and GND | — | Outer legs across the **nRF9160 DK's** VDD/GND rail (moved off the ESP32 — see below). |
| Volume pot wiper | Potentiometer wiper | nRF9160 **P0.15** (AIN2) | — | SAADC, ratiometric VDD/4 reference so rail sag cancels. The only free analog pin — AIN0–7 are fixed to P0.13–P0.20 in silicon and every other one is taken. ~20 Hz poll, 2 % hysteresis, end-stop snap, squared (perceptual) curve — the ESP32 tuning carried over 1:1. |
| Haptic driver | DRV2605L breakout (I2C **0x5A**) | nRF9160 **P0.30** (SDA) / **P0.31** (SCL) | 3V rail + GND | Shares I2C2 with the accelerometer. VIN → 3V, GND → GND; LRA (VLV101040A) across the driver's OUT+/OUT−. See the I2C section for pull-ups. |
| Accelerometer | LSM6DSOX breakout (I2C **0x6A**) | nRF9160 **P0.30** (SDA) / **P0.31** (SCL) | 3V rail + GND | Same I2C2 bus. 0x6B if the breakout's DO/SDO jumper is tied high. |
| Accelerometer INT1 | LSM6DSOX INT1 pin | nRF9160 **P0.27** | — | Push-pull active-high from the sensor; nRF-side pull-down so a fallen jumper reads "no tap". Double-tap = the yellow button. |
| Speaker amp SD_MODE | MAX98357A SD pin | nRF9160 **P0.01** | — | HIGH = amp plays the LEFT I2S slot (SD_MODE > 1.4 V, datasheet Table 5), LOW = 0.6 µA shutdown. Boot default LOW (Bluetooth stays the sink). Optional ~1 kΩ in series is cheap insurance if the 3 V rail ever sags below the DK's I/O voltage. |
| Speaker amp I2S | MAX98357A BCLK / LRC / DIN | nRF9160 **P0.18** / **P0.17** / **P0.19** | — | Parallel taps on the SAME wires the ESP32 listens to — the amp is a second listener, zero firmware audio-path changes. |
| Speaker amp power | MAX98357A VIN / GND | 3V rail / GND | — | Breadboard: the 3 V rail (~0.55 W into 8 Ω at 3.0 V). Custom board: VIN can take VBAT directly (2.5–5.5 V range) for full loudness off the cell. |
| Status LED red | RGB LED **R** leg | nRF9160 **P0.03** through **330 Ω** | LED R leg | PWM0 channel 0. P0.03 is the DK's LED2 pin; `led2_pin_routing` disabled in the board-controller overlay. |
| Status LED green | RGB LED **G** leg | nRF9160 **P0.04** through **330 Ω** | LED G leg | PWM0 channel 1. P0.04 is the DK's LED3 pin; `led3_pin_routing` disabled. |
| Status LED blue | RGB LED **B** leg | nRF9160 **P0.07** through **330 Ω** | LED B leg | PWM0 channel 2. P0.07 is the DK's **Button 2** pin; `button2_pin_routing` disabled. **The tradeoff: DK Button 2 is gone** — see "Why the RGB indicator costs Button 2". |
| Status LED common | RGB LED **common** leg (the longest) | **GND rail** | — | Common-CATHODE assumed (firmware default). Common-anode part: common leg to the **3V rail** and rebuild with `CONFIG_PENDANT_RGB_COMMON_ANODE=y`. Never a single resistor on this leg — one per colour. |
| Speaker | Mini oval 8 Ω 1 W | MAX98357A OUT+ / OUT− | — | Differential output: speaker **+ (red-dot/longer lead) → OUT+**, − → OUT−. With a single speaker a swap only inverts absolute phase — inaudible — but keep the convention so a future stereo/vibration pairing stays in phase. Never ground either OUT pin. |

## Why these choices

**Active-low with internal pull-ups.** Every button and the encoder's two
phases switch to GND and lean on the nRF9160's internal pull-ups (declared in
the devicetree overlay, not ad hoc in code). On a breadboard the common failure
is a wire falling out; with pull-ups that failure reads as "not pressed"
forever instead of a floating pin chattering interrupts.

**Why the encoder is three wires and select is a dwell.** Owner's ruling,
2026-08-12: *"we're not going to use the button on the rotary encoder."* The
part is the illuminated type — three rotation pins, plus five carrying a
switch and an unused built-in LED — and only rotation is wired: **A → P0.24,
C → GND, B → P0.25.** With no switch there is no push and no long-hold, which
would have left the owner able to browse the app ring forever and enter
nothing. So resting IS the press: **1500 ms** with no new detent and the
firmware sends one `{"type":"menu_select"}` and fires the `tick` haptic at the
instant it commits. Any detent inside the window restarts the countdown, and
after a dwell fires nothing fires again until a *new* detent arrives — a
pendant hanging still on its lanyard cannot start a timer every 1.5 s. The
timer is a `k_work_delayable` armed from the encoder ISR (a reschedule is
ISR-safe and is exactly "cancel and restart"); the commit runs on the system
workqueue and the WS I/O thread still owns the socket, so the
ISR → atomics → WS-thread path is unchanged. 1500 ms is the tuned middle:
hunting pauses between detents run ~300 ms, and much longer reads as broken
because nothing announces a coming selection on a screenless device.

**P0.28 is genuinely free, not merely unused.** Its handler, its devicetree
node and its alias are gone, and its bit is out of the GPIO sense-edge mask
(`0x1be00000` → `0x0be00000`). An unwired pin left armed as a wake source is a
floating input that wakes the CPU on breadboard-coupled noise — a battery leak
that presents as a firmware bug. The console repin (below) already keeps the
UART off P0.28, so the pin is available with no further work.

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
banked across a dead link would replay as stale intent. **The dwell obeys the
same drop rule**: if the socket is shut when the timer expires, the select is
not queued and the tick does not fire. A buzz claiming a selection the relay
never heard would be the device lying about the only feedback dwell has.

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
P0.01 is the MAX98357A SD_MODE gate, P0.29 is the console TX, P0.26/27 are
the mic sense and the accelerometer INT1 (P0.28 held the encoder push when
this was chosen and is free now), P0.15 is the
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

**Why the RGB indicator costs Button 2 (P0.03 / P0.04 / P0.07).** Colour
mixing needs three PWM outputs on one instance, and after the audio bus,
the microSD SPI, I2C, the ADC, both UARTs and every control there were
exactly three general-purpose pins left on this board: the DK's own
LED2 (P0.03), LED3 (P0.04) and Button 2 (P0.07). The board-controller
overlay opens all three analog switches, the same move it already made for
LED4. LED2 and LED3 cost nothing — the firmware never drove them. **Button
2 is a real loss and is stated as one**: every button this firmware reads
is an external one (yellow P0.21, green P0.22, blue P0.23 — and the knob's
select is a dwell, not a button at all), so no feature disappears, but a DK
with the stock board-controller
image would short a PWM output to GND every time someone pressed it. Flash
the overlay before wiring the LED.

**Which PWM instance, and why it could not be either of the other two.**
PWM1 and PWM2 generate the microphone's BCLK and LRCLK and are phase-locked
through a DPPI channel; stealing a channel from either would put a colour
mixer inside the audio clock chain, and that chain is untouchable. **PWM0
was genuinely free** — `CONFIG_PWM` is off in this build, so no Zephyr
driver binds it — and `pendant_status.c` takes channels 0/1/2 through the
raw nrfx HAL, exactly the way `main.c` already drives PWM1/PWM2. The
devicetree `pwm0` node is disabled to say so out loud: a bound `pwm_nrfx`
would apply `pwm0_default`, which puts PWM_OUT0 on P0.02 — the firmware's
one on-board status LED.

**How to tell common-anode from common-cathode without a datasheet.** The
**longest leg is the common one**; that much is true of every 4-leg part.
Which rail it wants is not printed on anything, so the firmware supports
both and the test is empirical: build with the default
(`CONFIG_PENDANT_RGB_COMMON_ANODE=n`, common leg → GND) and watch a state
that breathes — cut mic power for the blue mute breath, or start an upload
for the amber one. A correctly-wired common-cathode part breathes up from
dark. A common-anode part on that build does the opposite: it sits bright,
**dims where it should brighten**, and shows every colour as its
complement. Move the common leg to the 3V rail, set
`CONFIG_PENDANT_RGB_COMMON_ANODE=y`, reflash. It is one bit of the PWM duty
word (bit 15, the polarity bit), so both wirings run the same code at the
same brightness and neither can damage the part.

**Interrupt budget.** The edge-interrupt inputs (P0.21–23, P0.24/25 and
P0.27 — P0.28 left the mask with the encoder push) use the GPIO SENSE
mechanism (`sense-edge-mask` in the
overlay) rather than GPIOTE channels — the nRF9160 has only 8 GPIOTE
channels and the DK's own buttons already claim some. Hand-speed controls
(and a double-tap, slower still) do not need GPIOTE latency. P0.26 is
polled and uses no interrupt at all; P0.15 is analog.

**Console is TX-only now.** The DK's default `uart0` pinctrl claimed
P0.26 (CTS, **with a pull-up — directly against the mic-sense no-pull
contract**), P0.27 (RTS) and P0.28 (RX) alongside the P0.29 TX the
console actually uses. Flow control was never on and console input does
not exist in this firmware, so the overlay repins uart0 to TX-only on
P0.29 (`disable-rx`), freeing P0.26/27/28 honestly — and it is what keeps
P0.28 genuinely claimable now that nothing else wants it. printk/VCOM0
output is unchanged.

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
| Press acknowledged (yellow/tap-tap, capture start/stop, blue PTT start/stop) | `click` | one 60 ms crisp click |
| Memo start / memo stop (green) | `tick` | one 25 ms blip |
| **Menu dwell commits** (1500 ms after the last detent) | `tick` | one 25 ms blip — the only evidence a selection happened, since the owner did nothing to cause it |
| Blue press refused mid-conversation | `tick` | one 25 ms blip — "heard you, not now" |
| Incoming approval readback (relay announce frame) | `strong` | one 150 ms full-drive hit |
| Capture press while hard-muted | `long` | one 400 ms soft buzz |

Event haptics run through a non-blocking work-queue engine
(`haptic_trigger`), never the blocking reflex path, so a pattern can fire
from an ISR or mid-conversation without touching the I2S TX runway.
Recipes gain the same three new preset names (`tick`/`click`/`strong`).

## Status map — the LED and the motor are ONE system

`src/pendant_status.c` owns both. One enum, one setter: there is no code
path anywhere in the firmware that changes the light without deciding the
buzz in the same transition. That is deliberate — two renderers of one
truth eventually disagree, and a pendant that buzzes while its light says
"idle" is a device contradicting itself on the only two channels it has.

| State | LED | Haptic | Set from |
| --- | --- | --- | --- |
| idle | off | — | every terminal path in `main.c` |
| recording | red solid | `tick` on entry **and** on exit | `record_microphone()` (memo, PTT and the legacy command capture all pass through it) and `run_conversation()` for duplex |
| thinking / working | amber breathing, ~1.5 s | — | the moment the mic closes and the upload begins; held until the reply is played or the cycle fails |
| needs approval | amber fast blink, ~4 Hz | `strong`, then `strong` again 250 ms later | the `approval_readback` frame handler on the WS RX thread |
| done | green flash ~400 ms, then back to the prior state | `click` | reply played, memo landed, question delivered or held |
| failed | red triple-blink, then back | `strong`, then `long` 180 ms later | capture error, upload error, conversation error |
| mic muted | blue breathing, ~3 s | — (the muted-press `long` buzz is unchanged) | polled continuously from the P0.26 mic-power sense, not only at press time |

**Precedence** when more than one could apply: `muted > needs-approval >
recording > thinking > done/failed flash > idle`. Muted outranks everything
because a physical switch already decided it. The transient flashes rank
*below* the sticky states so a success flash can never blank out a live
recording indicator — but the transient's **haptic still fires**: the buzz
is the event, the light is the state, and suppressing the event because a
state outranks it would be exactly the disagreement this design forbids.

"needs approval" is a latch rather than a state slot, which is what makes
that precedence real: the relay can announce an approval while the pendant
is already recording, and the amber blink has to survive that. Any terminal
transition — idle, done, failed — clears it.

Cost: one `k_work_delayable`, an 8-byte PWM sequence buffer and a handful
of scalars, **91 bytes of RAM total**. The work item ticks at 40 ms while
something is animating and 250 ms when the display is static (only to keep
the mute probe live), and every register write happens on the system
workqueue — never on the audio path, never in an ISR, the same discipline
`haptic.c` follows.

## Firmware/relay contract summary

| Event | Wire | When |
| --- | --- | --- |
| Yellow press | same as DK Button 1 (converse start/stop) | always |
| Green press | chunked POST `/v1/pendant/command?dispatch=0` + `X-Pendant-Mode: memo`, no `X-Reply-Stream` | mic powered; SD fallback and offline outbox (kind `'T'`) keep `dispatch=0` on redelivery |
| Blue press (start) | nothing on the wire — capture runs with the radio untouched | mic powered; ignored with a tick while a conversation is open |
| Blue press (stop) | chunked POST `/v1/pendant/command?dispatch=1` + `X-Reply-Stream: opus`; the reply streams back as 2-byte-BE length-prefixed Opus packets on the same socket and plays through the current sink | one RRC connection per question; no link → outbox kind `'Q'`, planner ON at redelivery, **answer lands in history, never in the ear** |
| BT device list (downlink request) | `{"type":"bt_list"}` → device replies `{"type":"bt_devices","devices":[{"index":N,"name":…,"address":…,"preferred":bool}],"connected":bool}` | answered from main's idle loop; **relay-side sender: TODO** |
| BT device pick (downlink) | `{"type":"bt_select","index":N}` → promotes entry N to preferred and commands the module to connect | N indexes the list above (0 = preferred); **relay-side sender: TODO** |
| Encoder detent | `{"type":"menu","delta":±1}` on the converse WS | socket open, else dropped |
| Encoder **dwell** (no detent for **1500 ms**) | `{"type":"menu_select"}` on the converse WS + `tick` haptic at the commit | socket open, else neither. Restarted by any detent; never repeats until a new detent arrives. There is no push frame and no `menu_back` frame — escape is the `Back` entry on every ring |
| Capture press while muted | `{"type":"mic_muted"}` on the converse WS + LED pattern + long buzz, capture suppressed | socket open (LED/buzz regardless) |
| Volume knob move | `{"type":"volume","level":0.xx,"raw":N}` on the converse WS | on ≥2% change, ~20 Hz poll (5 Hz idle); gain applied on-device before the wire |
| Accelerometer double-tap | identical to a yellow press (same semaphore) | always; mute suppression included |
| Sink select (downlink) | `{"type":"audio_sink","sink":"speaker"\|"bluetooth"\|"both"}` parsed from the converse WS (mid-conversation or idle) | speaker/both = SD_MODE high; bluetooth = amp shutdown. Selecting bluetooth/both also asks the module to connect the preferred sink — a sink choice that left the module idle would route the next answer into silence. Boot default: bluetooth. **Relay-side sender: TODO** (cloud-relay is owned by another agent) |
| Approval readback announce (downlink) | `{"type":"approval_readback"}` → status goes to *needs approval*: amber 4 Hz blink + two strong hits | device parses it today; **relay-side sender: TODO** (same reason) |

"Both" is one pin's truth, not two: SD_MODE high makes the amp a second
listener on the same I2S wires the ESP32 taps — whether the ESP32 *also*
plays is the relay/ESP32's business. The wire format needs nothing new
for the amp: 24-bit words in 32-BCLK slots at 31 250 frames/s is inside
the MAX98357A's DAI envelope (16/24/32-bit I2S, 8–96 kHz — datasheet
"Digital Audio Interface Modes" p.16; 31.25 kHz bins with the 32 kHz
digital-filter class, Table 4).

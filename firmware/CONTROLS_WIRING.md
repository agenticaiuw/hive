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
| Approve button | Blue momentary | nRF9160 **P0.23** | GND | Active-low, internal pull-up. Press = approve, hold ≥ 1.5 s = deny the pending approval. |
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

## Haptic effect map (DRV2605L, all open-loop RTP presets)

| Event | Preset | Feel |
| --- | --- | --- |
| Press acknowledged (yellow/tap-tap/encoder push, capture stop) | `click` | one 60 ms crisp click |
| Approval decision actually sent (blue press or hold) | `double` | two 90 ms buzzes |
| Memo start / memo stop (green) | `tick` | one 25 ms blip |
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
| Blue press / hold | `{"type":"approval_decision","decision":"approve"\|"deny"}` on the converse WS | socket open, else dropped with a log |
| Encoder detent / push | `{"type":"menu","delta":±1}` / `{"type":"menu_select"}` on the converse WS | socket open, else dropped |
| Capture press while muted | `{"type":"mic_muted"}` on the converse WS + LED pattern + long buzz, capture suppressed | socket open (LED/buzz regardless) |
| Volume knob move | `{"type":"volume","level":0.xx,"raw":N}` on the converse WS | on ≥2% change, ~20 Hz poll (5 Hz idle); gain applied on-device before the wire |
| Accelerometer double-tap | identical to a yellow press (same semaphore) | always; mute suppression included |
| Sink select (downlink) | `{"type":"audio_sink","sink":"speaker"\|"bluetooth"\|"both"}` parsed from the converse WS (mid-conversation or idle) | speaker/both = SD_MODE high; bluetooth = amp shutdown. Boot default: bluetooth. **Relay-side sender: TODO** (cloud-relay was mid-edit by another agent) |
| Approval readback announce (downlink) | `{"type":"approval_readback"}` → strong haptic hit | device parses it today; **relay-side sender: TODO** (same reason) |

"Both" is one pin's truth, not two: SD_MODE high makes the amp a second
listener on the same I2S wires the ESP32 taps — whether the ESP32 *also*
plays is the relay/ESP32's business. The wire format needs nothing new
for the amp: 24-bit words in 32-BCLK slots at 31 250 frames/s is inside
the MAX98357A's DAI envelope (16/24/32-bit I2S, 8–96 kHz — datasheet
"Digital Audio Interface Modes" p.16; 31.25 kHz bins with the 32 kHz
digital-filter class, Table 4).

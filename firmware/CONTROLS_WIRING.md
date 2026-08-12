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
| Volume pot ends | Potentiometer (linear, ~5k–50k) | 3V3 and GND | — | Outer legs across the ESP32's 3V3/GND. |
| Volume pot wiper | Potentiometer wiper | ESP32 **GPIO34** | — | ADC1_CH6, 11 dB attenuation. GPIO34 is input-only, no internal pulls — the pot defines the level. |

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

**ADC1 only on the ESP32.** The pot wiper must be on an ADC1 pin
(GPIO32–39). ADC2 shares hardware with the Wi-Fi/Bluetooth radio and is
unusable while Bluedroid (the A2DP stack) is running — reads return garbage
or time out. GPIO34 = ADC1_CH6 is safe, and being input-only it cannot be
misconfigured into fighting the wiper. The knob is an attenuator
(0…unity, perceptual/squared curve) applied at the single consumer of the
audio ring (the A2DP callback), reported as `{"type":"volume","level":0.xx}`
on the serial JSON channel when it actually moves (≥2% with end-stop snap).

**Interrupt budget.** The five new nRF inputs that need edge interrupts
(P0.21–23, P0.24/25, P0.28) use the GPIO SENSE mechanism
(`sense-edge-mask` in the overlay) rather than GPIOTE channels — the
nRF9160 has only 8 GPIOTE channels and the DK's own buttons already claim
some. Hand-speed controls do not need GPIOTE latency. P0.26 is polled and
uses no interrupt at all.

## Firmware/relay contract summary

| Event | Wire | When |
| --- | --- | --- |
| Yellow press | same as DK Button 1 (converse start/stop) | always |
| Green press | chunked POST `/v1/pendant/command?dispatch=0` + `X-Pendant-Mode: memo`, no `X-Reply-Stream` | mic powered; SD fallback and offline outbox (kind `'T'`) keep `dispatch=0` on redelivery |
| Blue press / hold | `{"type":"approval_decision","decision":"approve"\|"deny"}` on the converse WS | socket open, else dropped with a log |
| Encoder detent / push | `{"type":"menu","delta":±1}` / `{"type":"menu_select"}` on the converse WS | socket open, else dropped |
| Capture press while muted | `{"type":"mic_muted"}` on the converse WS + LED pattern, capture suppressed | socket open (LED pattern regardless) |
| Volume knob move | `{"type":"volume","level":0.xx,"raw":N}` on the ESP32 serial JSON channel | on ≥2% change, ~20 Hz poll |

# Agentic Voice Wearable — Board Design Package (v1 draft)

**Status:** first-draft design to validate on the bench — not yet a manufacturable final. Values and pin choices will be refined once you prototype on the dev kit. See `schematic_v1.png` and `mechanical_3d.png` alongside this.

---

## 1. Power architecture

Three rails:

- **VBAT** — the LiPo directly (3.0–4.2 V). Feeds: Icarus **VIN** (cellular), the speaker amp **VDD** (MAX98357A accepts 2.5–5.5 V — running it from VBAT gives the most volume), the 3.3 V LDO input, and the SK6812 LED.
- **3V3** — from an LDO. Feeds: Icarus **VCC** (logic), DRV2605L VDD, the I²C pull-ups, and the level-shifter's high side.
- **1V8** — from a small LDO. Feeds **only** the T5837 mic and the level-shifter's low side.

Decoupling: 0.1 µF at every IC VDD pin, 10 µF at the amp, and a 100 µF bulk cap near VBAT/VIN to absorb cellular transmit bursts.

> **Cellular caveat:** the nRF9160 wants VIN ≥ 3.3 V for RF compliance, but a LiPo sags toward 3.0 V when nearly empty. Acceptable for a prototype; a production design might add a boost or cut off earlier.

### The 1.8 V mic — a real logic-threshold problem (read this)

The T5837 runs at **1.65–1.98 V**. The nRF9160's GPIO swing equals **its** supply (3.3 V here). Two conflicts:

1. Driving the mic's CLK at 3.3 V exceeds the mic's absolute-max (VDD + 0.3 ≈ **2.1 V**) → damages it.
2. The mic's 1.8 V DATA "high" may not reach the nRF9160's input threshold (VIH ≈ 0.7 × 3.3 = **2.31 V**) → read unreliably.

**This draft's fix:** power the mic from a 1.8 V LDO and put a **2-bit auto-direction level shifter (TXB0102)** on the CLK/DATA lines (1.8 V mic side ↔ 3.3 V MCU side).

**Simpler alternative:** pick a PDM mic rated to 3.3 V → delete the 1.8 V LDO **and** the shifter. Recommended unless you specifically need the T5837.

---

## 2. Power budget (rough)

| Rail | Main consumers | Typical | Peak |
|------|----------------|---------|------|
| VBAT → VIN | nRF9160 cellular | ~10–60 mA | **~250–500 mA** (TX burst) |
| VBAT → amp | MAX98357A playback | ~5 mA idle | hundreds of mA (loud) |
| 3V3 | nRF9160 logic, DRV2605L, pull-ups, LED logic | ~20–50 mA | — |
| 1V8 | T5837 mic | ~0.34 mA | — |

Size the 3.3 V LDO for ≥ 300 mA. The bulk cap covers the cellular/audio peaks. In sleep (PSM) the whole device drops to microamps.

---

## 3. Pin assignment (Icarus SoM ↔ peripherals)

| Function | Icarus pin (nRF9160) | Connects to | Notes |
|----------|----------------------|-------------|-------|
| I²S bit clock | P0 (P0.00) | MAX98357A BCLK | I²S "SCK" |
| I²S word clock | P1 (P0.01) | MAX98357A LRCLK | left/right select |
| I²S data | P2 (P0.02) | MAX98357A DIN | MCU → amp |
| PDM clock | P3 (P0.03) | shifter → mic CLK | MCU → mic |
| PDM data | P4 (P0.04) | shifter ← mic DATA | mic → MCU |
| I²C data | SDA (pin 23) | DRV2605L SDA, onboard accel | 4.7 kΩ pull-up to 3V3 |
| I²C clock | SCL (pin 24) | DRV2605L SCL, onboard accel | 4.7 kΩ pull-up to 3V3 |
| Haptic enable | P5 (P0.05) | DRV2605L EN | |
| Button | P6 (P0.06) | button → GND | use internal pull-up |
| LED data | P7 (P0.07) | SK6812 DIN | 1-wire, timing-sensitive |
| Charge status | P8 (P0.08) | MCP73831 STAT | optional, open-drain |

Do **not** reuse reserved pins **P0.12** (SIM select), **P0.28 / P0.29** (accelerometer INT). Pins are reassignable in firmware (Zephyr devicetree/pinctrl), so treat these as a starting map.

---

## 4. Net-by-net connection list (the schematic, in text)

**Power**
- `VBAT`: LiPo +, MCP73831 VBAT (+4.7 µF to GND), Icarus VIN, MAX98357A VDD (+10 µF), AP2112 IN (+1 µF), SK6812 VDD, +100 µF bulk.
- `3V3`: AP2112 OUT (+1 µF), Icarus VCC, DRV2605L VDD (+1 µF), 2× 4.7 kΩ I²C pull-ups, TXB0102 VCCB, XC6206 IN (+1 µF).
- `1V8`: XC6206 OUT (+1 µF), T5837 VDD (+0.1 µF), TXB0102 VCCA.
- `GND`: common to everything.

**USB-C / charging**
- USB4085 VBUS → MCP73831 VDD (+4.7 µF).
- USB4085 CC1 → 5.1 kΩ → GND; CC2 → 5.1 kΩ → GND (advertises the device as a power sink).
- MCP73831 PROG → 2 kΩ → GND (≈ 500 mA charge; use 4.7 kΩ for a gentler ~210 mA). STAT → P8 (and/or an LED + resistor to 3V3).

**Audio**
- I²S: P0 → BCLK, P1 → LRCLK, P2 → DIN. MAX98357A **SD_MODE → VBAT** (mono L+R), **GAIN_SLOT = open** (9 dB), OUTP/OUTN → speaker.
- PDM: P3 → TXB B1, P4 ← TXB B2; TXB A1 → mic CLK, A2 ← mic DATA; mic SELECT → GND; mic VDD ← 1V8 (+0.1 µF).

**Control**
- I²C (shared): DRV2605L at 0x5A, onboard accel at 0x19. DRV2605L REG → 1 µF → GND; VDD ← 3V3 (+1 µF); EN ← P5; IN/TRIG → GND; OUT+/OUT− → LRA.
- Button: P6 → switch → GND (internal pull-up; optional 0.1 µF for debounce).
- LED: P7 → SK6812 DIN; VDD ← VBAT; +0.1 µF. (Watch SK6812's VIH vs a 3.3 V data line — if marginal, add a single-channel shifter or a plain LED instead.)

---

## 5. Components to add (beyond the original BOM)

| Part | Purpose | Example MPN |
|------|---------|-------------|
| 3.3 V LDO | logic rail | AP2112K-3.3 |
| 1.8 V LDO | mic rail | XC6206P182MR |
| Level shifter (2-bit) | PDM 1.8 V ↔ 3.3 V | TXB0102DCUR |
| Resistors | 2× 4.7 kΩ (I²C), 2× 5.1 kΩ (USB CC), 2 kΩ (PROG), 1× LED | 0402 |
| Capacitors | 100 µF bulk, 10 µF (amp), several 1 µF + 0.1 µF | 0603 / 0402 |

---

## 6. The general method (voltages, currents, connections)

1. **List every IC's operating voltage**; group parts into rails (here 1.8 / 3.3 / VBAT). A part that needs a different voltage gets its own rail.
2. **Where two different-voltage parts must talk**, check logic thresholds (VIH / VIL). If the driver's HIGH < the receiver's VIH, add a level shifter (our mic). If a HIGH exceeds the receiver's absolute-max, you *must* shift down.
3. **Sum each rail's current** (typical + peak) → pick a regulator above the peak with margin; add bulk capacitance for bursty loads (cellular, audio).
4. **Copy each datasheet's required support parts** (the "typical application" caps/resistors) exactly, then connect the buses.

---

## 7. Build / bring-up steps

1. Capture the schematic in KiCad from §4 (steps in §8).
2. Lay out: place the SoM + its decoupling first, then audio, then power, then connectors. 2-layer, solid ground pour, u.FL near a board edge, mic/speaker on the top face.
3. DRC → Gerbers + paste stencil → order (JLCPCB) + remaining parts.
4. Bring-up **in stages**, powered through a current-limited bench supply:
   - Rails only (SoM not loaded): confirm 3.3 V and 1.8 V are correct.
   - Add the SoM: confirm it powers up / SWD debugger connects.
   - Firmware: cellular attach → audio loop → haptic/LED/button.
5. Put a **test point** on every rail and on SDA/SCL/BCLK/LRCLK so you can probe with a meter and logic analyzer.

---

## 8. Building it in your local KiCad (I can't reach it from here)

1. **New Project** → open the **Schematic Editor**.
2. **Place symbols** (Add Symbol): Icarus SoM (import the SnapEDA symbol), MAX98357A, T5837, DRV2605L, MCP73831, TXB0102, AP2112, XC6206, USB4085, SK6812, the LRA, the speaker, the button, plus resistors/caps.
3. **Wire by net labels** — instead of drawing every wire, drop net labels (`VBAT`, `3V3`, `1V8`, `GND`, `SDA`, `SCL`, `BCLK`, …) on the pins per §4. Matching labels = connected.
4. **Assign footprints** (SnapEDA / KiCad libraries) and run **ERC** (Electrical Rule Check).
5. Open the **PCB Editor**, update from schematic, place + route, pour ground, run **DRC**, export Gerbers.

Phil's Lab on YouTube walks this exact flow end-to-end — a good companion while you do it.

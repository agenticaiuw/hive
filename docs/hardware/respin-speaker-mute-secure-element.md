# Pendant respin — local audio out, hardware mic mute, secure element

**Status:** design specification for a board revision. Not yet ordered, not yet
fabricated, nothing here has been built.

**Scope:** the three parts the owner batched into one respin — an on-board I²S
amplifier + micro speaker, a physical microphone mute switch, and a secure
element. Everything else on the board is out of scope and is carried unchanged
from whichever base design wins (see §0.2).

**Relationship to existing documents:** this extends `docs/hardware/pendant-v2.md`
(ledger `chg-1e29f657`, accepted round 20) and revisits two things
`hardware/design/Design_Package_v1.md` got wrong. It does not supersede either.
Where this document and pendant-v2 disagree, the disagreement is called out
explicitly in §0.2 and §4.1 rather than silently resolved.

**Evidence convention**, same as pendant-v2 and enforced throughout:

| Tag | Meaning |
|---|---|
| `[verified]` | Read out of this repo's source, or out of a datasheet PDF stored in `hardware/datasheets/`. File and line given. |
| `[datasheet]` | Quoted from a vendor datasheet. Which one, and where it lives. |
| `[estimate]` | Calculated or judged by me. The inputs are shown so the arithmetic can be checked. |
| `[unverified]` | I could not confirm it. Listed again in §8.3. |

Nothing in this document was measured on hardware. There is no power measurement
of any kind in this repo — pendant-v2 §3 says so, and a PPK2 session is still an
open Phase 3 task. Every current figure below is either a vendor's typical or my
arithmetic on top of one.

---

## 0. Findings that change the brief

Three of the premises I was handed are wrong or incomplete. They are first
because they affect what should be built.

### 0.1 The speaker does not save power on a chime. It saves *readiness*.

The reasoning I was given is that routing a beep through Bluetooth "means waking
a radio to make a beep," and that the on-board speaker is therefore the
power-efficient choice. The energy arithmetic does not support that, and the
correct argument is a different and stronger one.

A 0.5 s chime through the local speaker costs about **0.005 mAh** (§4.2). Twenty
a day is **0.11 mAh/day**, or 0.03 % of a 330 mAh cell. Through an *already
connected* Bluetooth link the same beep costs about the same — a few
milliamp-seconds of radio time. **Per event, the two are indistinguishable.**
Anyone defending the speaker on per-chime energy is defending it on a number too
small to matter.

What actually differs by four orders of magnitude is the cost of *being ready to
make a sound at all*:

| Path | Standing cost of readiness | Per day on a 330 mAh cell |
|---|---|---|
| Amp in shutdown, `SD_MODE` low | **0.6 µA** `[datasheet]` | 0.014 mAh — 0.004 % |
| Classic-BT link held open so a chime can play immediately | ~5–30 mA `[estimate]` | 120–720 mAh — **36 % to over 200 %** |

A Bluetooth link that is warm enough to chime instantly costs more per day than
the entire battery holds. A link that is cold is 3–10 s from making a sound
`[estimate]`, which a timer cannot use. **That** is the argument for the
speaker, and it is decisive in a way the energy argument is not.

So: the decision is right, one of its stated reasons is not. Worth knowing,
because the wrong reason predicts the wrong thing — it predicts the speaker is
also the cheap choice for long audio, and §0.2 shows it is the opposite.

### 0.2 pendant-v2 already reached the opposite conclusion for sustained audio, and it is also right

`docs/hardware/pendant-v2.md:489-494` states, of its own power model: *the
loudspeaker is two-thirds of the conversation budget*, comparing state **C1**
(conversation, local speaker) at ~30 mA against **C2** (conversation via
phone → earbuds) at ~9 mA, and concludes the local speaker "should not be the
default output path" `[verified]`.

That finding and this respin are both correct because they are about different
audio. Reconciled:

| Audio class | Duration | Sink | Why |
|---|---|---|---|
| Chime, timer, command confirmation, error tone | 0.2–1 s | **On-board speaker** | Must work with the modem off, no phone, nothing in the user's ears. Readiness costs 0.6 µA. |
| Agent reply, dictation playback, anything the owner chose to listen to | 5–120 s | **Bluetooth / phone** | 3× cheaper per minute, and better sounding than a 13 mm driver in a 1 cm³ box will ever be. |

**The rule the firmware should encode: the speaker is an alerting device, not an
output device.** If a sound is longer than about two seconds, it belongs
somewhere else.

### 0.3 The premise "the mic already uses I²S" describes a debugging detour, not a design decision

This is the finding that most changes the pin plan, and it is why §2 recommends
what it does.

The board this project is actually running on is an **nRF9160 DK on a breadboard**
`[verified]` — not the Icarus SoM, not a fabricated PCB. On that breadboard the
mic is an Adafruit SPH0645LM4H (I²S). But the *design* — v1's schematic, v1's
SKiDL netlist, and pendant-v2's BOM — has always specified a **PDM** microphone
on the nRF9160's dedicated PDM peripheral, with I²S left entirely free for the
amplifier `[verified: hardware/design/Design_Package_v1.md:45-61,
hardware/design/agentic_gadget_skidl.py:62-74]`.

The swap to I²S happened on 2026-08-02 because a PDM breakout produced a
stationary harmonic comb instead of speech. `docs/Microphone_Noise_Debugging.md`
lists five candidate causes `[verified: lines 36-58]`. Four of them are
breadboard artefacts — microSD/LTE/ESP32 current bursts coupling into the PDM
lines, long parallel jumpers on a 1–3 MHz digital interface, decoupling, and a
ribbon cable physically lying across the acoustic port. The fifth is a dead part.
**The document never records which one it was.** The A/B test that would have
settled it is written out as a plan in that file's §"Decisive hardware A/B test"
and there is no recorded outcome.

Carrying the I²S mic onto a PCB means carrying, permanently:

- Two PWM peripherals synthesising BCLK and LRCLK, because the nRF9160 I²S
  cannot master a 64-BCLK frame (§2.2). **~2.3 mA whenever audio runs**
  `[datasheet: IPWM1 = 1160.77 µA, nRF9160 PS §5.2.1.5]`.
- Two nets that exist only to jumper a PWM output back into an I²S clock input.
- A DPPI channel and EGU2, burned on starting the two PWMs in the same cycle.
- A bus rate of 31.25 kHz that **the MAX98357A does not support** (§2.3).
- A latent conflict on P0.14, which TF-M's secure UARTE1 also claims as RTS
  `[verified]`.

All of that to work around a microphone that was only replaced because a
different microphone misbehaved on jumper wires, for reasons never established.
**Recommendation: return to PDM for the respin (§2.5, Topology C).** It is what
both existing designs already assume, it deletes every item in that list, and the
failure that caused the detour is one a PCB is specifically good at preventing.

### 0.4 Two smaller corrections

- **Bluetooth does not simply "stay."** pendant-v2 §8.5 moves the SoC to an
  nRF5340, which has no BR/EDR and therefore no A2DP, and deletes the ESP32
  bridge `[verified]`. Under that plan, "Bluetooth for quality listening" means
  *through the paired phone*, not from the pendant. Keeping pendant-originated
  Classic BT requires either staying on nRF9160 + ESP32, or adding a BM83-class
  module to the BOM. This is an unpriced dependency, not a given.
- **`Design_Package_v1.md:79` ties the amplifier's `SD_MODE` to VBAT.** That
  wiring makes shutdown unreachable and costs **8.2 mAh/day** — see §4.3, where
  it turns out to be the largest single power error available in this design.

---

## 1. Bill of materials

Prices and stock are as researched August 2026 and go stale. Anything I could not
confirm is marked `[unverified]` and repeated in §8.3.

### 1.1 New parts this respin adds

Prices below marked `[repo]` are the figures already recorded in this project's
own BOM documents and invoices — they are real numbers that were really paid or
really quoted, but they are historical, not a live quote. Anything I could not
ground that way is left blank rather than guessed.

| # | Function | MPN | Mfr | Package | @1 | @100 | Notes |
|---|---|---|---|---|---|---|---|
| A1 | I²S Class-D amp | `MAX98357AETE+T` | ADI (ex-Maxim) | TQFN-16, 3.0 × 3.0 × 0.75 mm | ~$2.20–3.73 `[repo]` | ~$1.60 `[repo]` | Carried from v1 BOM (DK 4936122, $3.73) and pendant-v2 row 11 (~$2.20/~$1.60). Lifecycle **Production** as of Aug 2026 — no NRND or EOL flag found. Datasheet already in `hardware/datasheets/`. |
| A1-alt | Same, smaller | `MAX98357AEWL+T` | ADI | WLP-9, ~1.3 × 1.3 mm | — | — | Only if Ø34 mm area forces it. WLP needs finer design rules; pendant-v2 §2.1 already flags HDI as a cost step. |
| A2 | Micro speaker | **must be selected** | — | ≤ 13 mm Ø × 3 mm, 8 Ω | — | — | pendant-v2 row 12 left this empty and §9.3 item 4 flags it. v1's PUI `AS01808MR-R` (18 mm, $3.50 `[repo]`) does not fit. The bench part — Adafruit `#3923` oval, $1.95 `[repo]` — is also the wrong shape. See §5.1. |
| A3 | Amp shutdown resistor | 560 kΩ ±5 %, 0402 | any | 0402 | <$0.01 | <$0.01 | Sets `SD_MODE` to the (L+R)/2 mono mix. Value derived in §3.3; **fit a second footprint** for tuning. |
| A4 | Amp output filter | 2 × ferrite bead or LC | any | 0402 | ~$0.10 | ~$0.05 | Class-D EMI. Required near an LTE antenna; see §5.4. May be left unpopulated, but must exist. |
| A5 | Amp bulk cap | 10 µF X5R/X7R | any | 0603 | ~$0.10 | ~$0.03 | Per datasheet typical application. |
| B1 | Mic mute switch | **DPDT slide, ≤ 3 mm profile** | C&K / Alps / E-Switch | SMD | — | — | Two poles, not one — see §3.4. Sealed, or booted by the enclosure (§3.4 mechanical). |
| B2 | Mic-live indicator | small LED + resistor | any | 0402 | ~$0.10 | ~$0.05 | Driven from the *load* side of the switch, per pendant-v2 §5.5. |
| C1 | Secure element (optional) | `ATECC608B` | Microchip | UDFN-8 2 × 3 mm, SOIC-8, or SOT-23-3 | sub-$1 | sub-$1 | I²C. **Zero new pins** — shares the existing bus. See §6 for why this is optional and probably unnecessary. |

**Incremental cost of this respin: roughly $5–8 per unit at quantity 100**
`[estimate]`, dominated by the amp and the speaker, assuming the secure element
is not fitted. That is a small fraction of pendant-v2's ~$55–65 EVT unit cost.

### 1.2 Parts this respin changes or deletes

| Change | Effect |
|---|---|
| Mic returns to PDM (§2.5 Topology C) | Deletes 2 PWM clock nets, the DPPI channel, and 2 GPIOs. Restores v1's and pendant-v2's intended topology. |
| Pick a **3.0–3.6 V** PDM mic instead of the 1.8 V T5837 | Deletes the `XC6206P182MR` 1.8 V LDO **and** the `TXB0102DCUR` level shifter that exist in v1's schematic solely to feed it `[verified: Design_Package_v1.md:13,26]`. v1's own §1 already recommends this. Two parts and a rail removed. |
| `SD_MODE` moves from VBAT to a GPIO | Saves 8.2 mAh/day (§4.3). One GPIO, one resistor. |

**Sourcing note.** Every part above is stocked by Digi-Key and Mouser; the amp
and the ATECC608B are also on LCSC, which matters if the boards are assembled at
JLCPCB as v1 planned. The **speaker (A2) and the switch (B1) are the two items
with real selection work left**, and the speaker is on pendant-v2's critical
path already.

**Lifecycle risk.** The MAX98357A is the part worth watching: it is a Maxim-era
design now in ADI's catalogue, and ADI has been pruning that catalogue. It reads
as Production today with no warning flag, but it is the one item here I would
re-check before committing to a fabrication run, and I would keep a
pin-incompatible-but-functionally-equivalent second source identified. Nothing
else on this list is unusual enough to go scarce.

---

## 2. Pin plan against the nRF9160

This section answers the question that was asked: **can the speaker share the
existing I²S peripheral with the mic, or does it need a second interface or a
different topology?**

### 2.1 The short answer

**Electrically, yes — for zero additional data pins. By specification, no — not
at the clock rate the current microphone forces onto the bus.** Both halves of
that are proven below. The recommendation is a third option that avoids the
question entirely.

### 2.2 What is actually on the silicon

`[verified — nRF9160 Product Specification v1.1, `hardware/datasheets/nRF9160_cellular-SoC_Nordic.pdf`]`

- **There is exactly one I²S instance.** Peripheral ID 40, at `0x40028000` (NS) /
  `0x50028000` (S). There is no I2S1. "Use a second I²S peripheral" is not an
  available answer.
- **There is a PDM peripheral**, ID 38 at `0x40026000`, with EasyDMA, its own
  decimation filters, and a selectable 64 or 80 ratio. It is currently
  `status = "disabled"` in the build `[verified]`.
- **The I²S block is genuinely full duplex.** SDIN and SDOUT are separate pins
  served by one configuration.
- **32 GPIOs total**, all on port 0. There is no P1.

The last point matters for the shared-bus question, and the firmware already
depends on it: `main.c:220-233` runs microphone RX on SDIN and agent-reply TX on
SDOUT *simultaneously*, under a single `i2s_config`, because the nrfx driver
`memcmp`s the two directions' configs and requires them identical `[verified]`.

**So an amplifier hung on SDOUT is simply a second listener on a line the board
already routes. Zero new data pins.** It needs one control pin, `SD_MODE`
(shutdown plus channel select). **Net cost: +1 GPIO.**

That is the whole of the good news.

### 2.3 Why the shared bus fails anyway: a rate neither part can reach

The MAX98357A datasheet is a whitelist, not a range:

> "LRCLK ONLY supports 8kHz, 16kHz, 32kHz, 44.1kHz, 48kHz, 88.2kHz and 96kHz
> frequencies."
> — `hardware/datasheets/MAX98357A_I2S-amp_ADI.pdf`, Detailed Description `[datasheet]`

The shared bus runs at **31.25 kHz** `[verified: main.c:71,
`#define MIC_FRAME_RATE 31250U`]`. That is not on the list. It is 2.3 % below
32 kHz — and Nordic's own I²S configuration table labels that exact frequency as
"32000 target, −2.3 % error," so both vendors independently agree it is a miss.

**And it cannot be retuned, while the SPH0645 is on the bus.** The proof is
short:

1. The SPH0645 requires exactly **64 BCLK per LRCLK frame**
   `[verified: main.c:48-50]`.
2. The nRF9160 I²S **cannot master a 64-BCLK frame.** The PS states
   `SCK = 2 × LRCK × CONFIG.SWIDTH` (§6.7.4) and SWIDTH tops out at 24-bit, so
   master mode produces at most **48** BCLK per frame `[datasheet]`. This
   independently confirms the firmware's own comment at `main.c:49-50`.
3. Therefore the clocks must be synthesised externally. The firmware uses PWM1
   and PWM2 off PCLK16M. `PWM_CLK` is PCLK16M divided by a power-of-two
   `PRESCALER`, and the period is `PWM_CLK × COUNTERTOP` with `COUNTERTOP`
   an integer in `[3..32767]` `[datasheet, PS §6.10.5.23–24]`. So BCLK =
   16 MHz / M for integer M, and **LRCLK = BCLK / 64 = 250 000 / M Hz**.
   (Sanity check against the running firmware: `COUNTERTOP` = 8 gives the
   2.000 MHz BCLK and `COUNTERTOP` = 512 gives the 31.25 kHz LRCLK that
   `main.c:69-71` actually configures `[verified]`.)
4. Solve for each legal rate: 8 kHz → M = 31.25. 16 kHz → M = 15.625.
   32 kHz → M = 7.8125. 44.1 kHz → M = 5.669. 48 kHz → M = 5.208.
   **Not one is an integer.**

**No MAX98357A-legal sample rate is reachable on a bus shared with this
microphone.** That is arithmetic, not judgement.

### 2.4 A second, quieter problem: the nRF9160 cannot hit a nominal rate at all

Even with the microphone off the bus and I²S running as master, Nordic's own
configuration table (PS Table 44) `[datasheet]` gives:

| Target | SWIDTH | RATIO | MCKFREQ | Actual LRCK | Error |
|---|---|---|---|---|---|
| 16 kHz | 16-bit | 32X | 32MDIV63 | 15 873.0 Hz | **−0.8 %** |
| 16 kHz | 16-bit | 64X | 32MDIV31 | 16 129.0 Hz | **+0.8 %** |
| 32 kHz | 16-bit | 32X | 32MDIV31 | 32 258.1 Hz | +0.8 % |
| 32 kHz | 16-bit | 64X | 32MDIV16 | 31 250.0 Hz | −2.3 % |
| 44.1 kHz | 16-bit | 32X | 32MDIV23 | 43 478.3 Hz | −1.4 % |

**The nRF9160 can never hand this amplifier an exactly nominal sample rate. The
best available error is ±0.8 %.** The MAX98357A datasheet specifies no tolerance
window around its seven legal frequencies, so whether ±0.8 % is accepted is
formally undefined.

In practice this pairing is common enough in the hobbyist nRF ecosystem that
±0.8 % is very likely fine `[estimate]`. But "very likely fine" is a bench
result, not a specification, and this project's standing rule is to measure
before claiming.

**This question may already have been answered on this bench and not written
down.** `docs/Breadboard_Wiring_Guide.html` wired a MAX98357A to this DK's I²S in
master mode (§2.5), and `src/speaker_zephyr_i2s_test.c` is a complete master-mode
chime harness that requests exactly 16 kHz. If that ever made a clean sound, the
answer is yes. **No such result is recorded anywhere in the repo**, and the test
file is currently not compiled `[verified: absent from `target_sources` in
CMakeLists.txt]`.

**Bench-verify before committing a PCB.** Re-enable the harness, wire the amp
breakout that is already in the parts bin, and listen. It is an afternoon, and it
is the single highest-value hour available before layout — it is the one open
hardware question that gates the entire audio topology.

### 2.5 Three topologies, and the recommendation

**Topology A — amp shares the bus as-is, mic stays I²S.**
+1 GPIO, zero new data pins. Bus at 31.25 kHz, outside the amp's documented set.
Also inherits the shared-SDOUT hazard in §2.6. *Cheapest in pins, worst in risk.*

**Topology B — amp shares the bus; chimes reconfigure I²S to master.**
A chime needs no microphone, so for chime-only playback the firmware can stop
both PWMs, switch I²S to master, 16-bit, and get ±0.8 % instead of −2.3 %. Same
+1 GPIO. This is exactly what `speaker_zephyr_i2s_test.c` already does, so the
path is written. *Best option if the microphone must stay I²S.* Note the residual
limit: during an actual conversation the bus returns to 31.25 kHz slave, so the
speaker still cannot be the conversation sink at spec — which §0.2 says it should
not be anyway.

**Topology C — mic returns to PDM; I²S becomes the amplifier's alone. ← recommended**

| | |
|---|---|
| Pin cost | PDM CLK + DIN = 2. Frees the 2 PWM clock pins. **Net zero.** |
| I²S | Master, 16-bit, 32 BCLK/frame, ±0.8 % — the best the SoC offers. |
| Frees | Both PWMs (**~2.3 mA whenever audio runs** `[datasheet]`), one DPPI channel, EGU2, and the P0.14 / TF-M-UARTE1 conflict. |
| Deletes | If paired with a 3.0–3.6 V PDM mic: the 1.8 V LDO and the TXB0102 shifter (§1.2). |
| Matches | v1's schematic and pendant-v2's BOM, both of which already specify PDM. |
| Risk | The 2026-08-02 breadboard failure. Mitigated by §2.7. |

Topology C is not a new idea — it is the design this project already had before a
breadboard sent it sideways. **It is also the configuration that was physically
wired on this very DK.** `docs/Breadboard_Wiring_Guide.html` is the Phase 1
bring-up document, and it specifies `[verified]`:

- MAX98357A on I²S **master**, `I2S_SCK_M` → P0.14, `I2S_LRCK_M` → P0.15,
  `I2S_SDOUT` → P0.16. Note there is **no SDIN in that overlay** — I²S is
  output-only, because the microphone is elsewhere.
- PDM microphone on `PDM_CLK` → P0.00, `PDM_DIN` → P0.01.

That is Topology C, on this hardware, with the parts already purchased (the amp
breakout `#3006` and the 8 Ω oval speaker `#3923` are on the July 2026 Adafruit
invoice in `hardware/purchases/`). The wiring was retired only when the mic moved
to I²S and took the bus over `[verified: firmware/nrf9160/README.txt:104,
"The former A0/A1/A2 audio wiring and the MAX98357 are unused."]`.

**So the recommendation is not "try something new." It is "go back to the
topology that was designed, purchased, wired, and documented, and that was only
abandoned as collateral damage from a microphone problem that was never
diagnosed."**

### 2.6 A hazard specific to sharing SDOUT, already proven on this hardware

If the amplifier and the ESP32 both sit on SDOUT, **the amplifier will play the
ESP32's sync preamble as audio.** This is not speculation: the most recent commit
on `main` is *"Fix the real distortion: the sync preamble was played as audio"*
(`8b5a53c`) `[verified]`, and `main.c:3363-3366` still queues a preamble on every
chime because "ESP32 resynchronizes after every BCLK restart" `[verified]`.

A MAX98357A needs no preamble and will reproduce it as a burst of noise. Under
Topology A or B, `SD_MODE` must therefore be held low across the preamble and
released only once real samples start — which is an additional firmware timing
constraint, on a part with a **7 ms turn-on time** `[datasheet]`. Topology C
avoids it by not sharing the line.

### 2.7 If Topology C is chosen, what the PCB must do that the breadboard did not

Every documented candidate cause of the 2026-08-02 PDM failure is addressable in
layout. This is the mitigation list, drawn directly from
`docs/Microphone_Noise_Debugging.md:36-58` `[verified]` and Nordic's own guidance
quoted there:

1. **20–100 Ω series damping**, CLK resistor at the nRF source, DATA resistor at
   the microphone source.
2. **Route PDM CLK and DATA as a short pair with a continuous adjacent ground
   return**, and keep them off the flash/SD SPIM bus — the noise doc names
   periodic microSD bursts as its first suspect.
3. **Local 100 nF + 10 µF at the microphone**, on its own supply branch.
4. **Nothing over the acoustic port.** The doc records a ribbon cable lying
   across it, which alone explains the missing speech.
5. **Pull-down on the PDM DATA net** — required independently by the mute switch
   (§3.4), and it also makes a dead or disconnected microphone read as digital
   silence rather than as floating noise.

If PDM still fails with all five in place, Topology B is the fallback and costs
only firmware.

### 2.8 Pin budget

Free on the DK today: **P0.03, P0.04, P0.05, P0.08, P0.09, P0.15, P0.21, P0.22,
P0.23, P0.24, P0.25** — 11 pins `[verified]`. Most of the rest are claimed by
DK-specific fixtures (three unused LEDs, two slide switches, the nRF52840
interface) that vanish on a custom board.

On an **Actinius Icarus SoM**, 27 of the 32 GPIOs are exposed; **P0.10 and P0.11
are not broken out**, and P0.12 / P0.28 / P0.29 are reserved for SIM select and
the accelerometer interrupts `[verified:
hardware/datasheets/IcarusSoM_datasheet_Actinius.md:62-65]`.

> **Consequence worth catching now:** the current microSD SPI assignment is
> P0.10–P0.13 `[verified]`. **P0.10 and P0.11 do not exist on the Icarus SoM.**
> The storage bus must be reassigned in any SoM-based respin. This is unrelated
> to audio and would have been found the hard way at bring-up.

Demand for a Topology C respin: I²S 3 + `SD_MODE` 1 + PDM 2 + mute sense 1 +
I²C 2 + button 1 + LED 1 + charge status 1 + console 2 + storage SPI 4 =
**18 of 27**. Comfortable, with the ADC pins untouched for battery sensing.

---

## 3. Schematic notes for the new parts

### 3.1 Amplifier supply

VDD from VBAT, not from the 3.3 V rail — the datasheet's 2.5–5.5 V range covers
the full LiPo swing and a higher rail is more output. v1 already had this right
`[verified: Design_Package_v1.md:11]`. 10 µF local plus the existing 100 µF bulk;
the amp and the LTE modem are the two bursty loads on VBAT and they must not
share a narrow trace.

Output power for sizing: **0.77 W into 8 Ω + 68 µH at THD+N = 1 %, VDD = 3.7 V,
gain 12 dB** `[datasheet]`. That is far more than a chime needs (§4.2 assumes
100 mW), so **set the gain low** — the extra headroom buys nothing and costs
distortion on a 13 mm driver.

### 3.2 Gain

`GAIN_SLOT` left floating selects 9 dB `[datasheet]`, which is what v1 chose.
Given §5.1's speaker constraints and §3.1's power surplus, **6 dB or 3 dB is the
better default**; leave the pad configurable with a resistor option for bring-up.

### 3.3 `SD_MODE` — one GPIO and one resistor, and it must not be a strap

This is the pin that carries the 8.2 mAh/day in §4.3. The datasheet gives four
states set by the voltage on a single pin `[datasheet]`:

| `SD_MODE` | Result |
|---|---|
| Low | **Shutdown, 0.6 µA** |
| High through a large resistor | (Left/2 + Right/2) mono mix |
| High through a small resistor | Right channel |
| Driven high directly | Left channel |

with `R_LARGE (kΩ) = 222.2 × V_DDIO − 100`.

**Wiring:** push-pull GPIO → series resistor → `SD_MODE`. Driving the GPIO low
puts the pin at ground (shutdown); driving it high applies V_DDIO through the
resistor (mono mix). One pin, both functions.

Resistor value at V_DDIO = 3.0 V: 222.2 × 3.0 − 100 = **566 kΩ** → use 560 kΩ
0402. At 1.8 V it is 300 kΩ; at 3.3 V, 633 kΩ. **Set this from the final I/O rail
voltage, and put a second footprint next to it** — this divider works against an
internal trip point and is the most likely thing on the board to need tuning at
bring-up.

The firmware already mixes identical L/R samples, so the mono mix is the right
mode and is already assumed `[verified: speaker_zephyr_i2s_test.c:78]`.

> **Do not tie `SD_MODE` to VBAT** as `Design_Package_v1.md:79` specifies. That
> makes shutdown unreachable and is the single most expensive error available in
> this design (§4.3).

### 3.4 Mic mute switch — why one pole is not enough

The requirement is a real disconnect that holds even if the firmware is
compromised. A single pole breaking the microphone's VDD does **not** achieve
that: a digital MEMS microphone with its supply removed but its clock line still
driven will back-power through its input protection diodes and can keep
modulating. Breaking VDD alone is a mute that a sufficiently unlucky — or
sufficiently hostile — firmware state can defeat.

**Specify a DPDT switch:**

- **Pole 1** breaks `VDD_MIC`.
- **Pole 2** breaks the microphone **data** line (PDM DIN, or I²S SDIN under
  Topology A/B).

With the data line physically open, no audio reaches the SoC regardless of
power, clocking, or firmware state. With VDD also open, the microphone is off
rather than merely unheard. Either pole alone is arguable; together they are not.

Two supporting requirements:

- **Pull-down on the SoC side of the data net** (100 kΩ). With pole 2 open the
  pin would otherwise float, and the capture path would read noise instead of
  silence. This is the same pull-down §2.7 item 5 asks for.
- **Bleed resistor on the microphone side of `VDD_MIC`** (100 kΩ to ground) so
  the rail actually collapses when pole 1 opens.

**The indicator, per pendant-v2 §5.5** `[verified: lines 875-882]`, which states
this as a hardware requirement: the mic-live LED is driven from the **load side
of pole 1**, so it is lit by the same rail that powers the microphone. The MCU
may brighten it and may not extinguish it. A dark indicator then means an
unpowered microphone as a matter of circuit topology, not of firmware behaviour.

**Sense line:** bring the switch position to a GPIO as well (+1 pin), so firmware
can show mute state in the UI and skip pointless capture attempts. This is
convenience only — the guarantee is in the switch, not the sense line, and the
firmware must never treat the sense line as authoritative for anything but UI.

**Mechanical:** the actuator must be operable through the enclosure by feel,
which for a chest-worn puck means an edge-mounted slider with a positive detent
and a tactile difference between positions. pendant-v2 §4.8 targets IPX5, so
either the switch is sealed or the enclosure gets a boot over it — **an
unsealed slide switch on an IPX5 enclosure is a hole**, and this interacts with
the ingress strategy that §9.3 already lists as unverified.

### 3.5 Secure element

`ATECC608B` on the existing I²C bus. The base part's default 7-bit address is
**`0x60`** (configuration byte `0xC0`); the `-TNGTLS` pre-provisioned variant
defaults to **`0x35`**. Either way the bus already carries the DRV2605L at `0x5A`
and the accelerometer at `0x19` `[verified]`, so **there is no collision with
either default**. The address is also relocatable once, via `UpdateExtra` writing
byte 85 of the configuration zone — note *once*: it is a one-time change on a
part whose configuration zone gets locked, so do not plan on iterating it. Needs
one 100 nF decoupling capacitor and nothing else. **Zero new pins.**

---

## 4. Power budget

Every number is a vendor typical or arithmetic on one. **Nothing here is
measured**, and two of the numbers I most wanted do not exist (§4.5).

### 4.1 Component figures

| Item | Value | Source |
|---|---|---|
| MAX98357A quiescent, VDD = 3.7 V | **2.4 mA** typ / 2.85 mA max | `[datasheet]` |
| MAX98357A shutdown, `SD_MODE` = 0 V | **0.6 µA** typ / 2 µA max | `[datasheet]` |
| MAX98357A standby, `SD_MODE` = 1.8 V, no BCLK | **340 µA** typ / 400 µA max | `[datasheet]` |
| MAX98357A turn-on time | **7 ms** | `[datasheet]` |
| MAX98357A output | 0.77 W into 8 Ω, THD+N 1 %, VDD 3.7 V | `[datasheet]` |
| MAX98357A efficiency | **92 %** at R_L = 8 Ω, P_OUT = 1 W | `[datasheet]` |
| nRF9160 PWM @ 16 MHz, fixed duty | **1160.77 µA** each | `[datasheet]` |
| nRF9160 CPU, CoreMark @ 64 MHz from flash | 2.88 mA | `[datasheet]` |
| nRF9160 idle, modem off, RTC on | 2.35 µA | `[datasheet]` |
| nRF9160 **I²S** transferring 2 × 16-bit × 16 kHz | **"TBA"** | `[datasheet]` — see §4.5 |
| nRF9160 **PDM** receiving @ 1 Msps | **"TBA"** | `[datasheet]` — see §4.5 |
| Device deep idle (state A) | ~0.15 mA | pendant-v2 §3.2, modelled |

### 4.2 One chime

Assumptions, stated so they can be argued with: 0.5 s duration, 20 per day,
100 mW average electrical into the speaker (a clearly audible indoor alert from a
13 mm driver), and efficiency **85 %**.

On that last figure: the datasheet's headline is **92 %, measured at 1 W into
8 Ω** `[datasheet]`. Class-D efficiency falls at low output because the fixed
switching and quiescent losses stop being negligible against the signal, so 92 %
is the wrong number to use at a tenth of that power. **85 % is my derating**
`[estimate]`, chosen to be pessimistic. Using the datasheet's 92 % would lower
the speaker-drive current from 32 mA to 29 mA and change nothing that follows.

| Contributor | Current | Basis |
|---|---|---|
| Speaker drive | 100 mW / 0.85 / 3.7 V ≈ **32 mA** | `[estimate]` |
| Amp quiescent | **2.4 mA** | `[datasheet]` |
| SoC: I²S + HFXO + intermittent CPU | **~3 mA** | `[estimate]` — see §4.5 |
| **Total during chime** | **≈ 37 mA** | |

- Energy per chime: 37 mA × 0.5 s = 18.5 mA·s = **0.0051 mAh**
- Twenty per day: **0.10 mAh/day**
- On a 330 mAh cell: **0.031 % per day**

For a gentler confirmation blip at 25 mW the total is ~13 mA and the daily figure
drops to 0.036 mAh. **Either way the chimes themselves are free.** This is the
arithmetic behind §0.1.

Under Topology A or B the two PWMs add 2.3 mA during the chime — which raises the
daily total to 0.107 mAh. Still free. **The PWMs matter for conversations, not for
chimes**, which is worth stating plainly so the pin-plan decision is not argued on
the wrong grounds.

### 4.3 The standing cost, which is where the real money is

| Amp state between chimes | Current | Per day | Share of a 330 mAh cell |
|---|---|---|---|
| Shutdown, `SD_MODE` driven low | 0.6 µA | 0.014 mAh | 0.004 % |
| **Standby, `SD_MODE` strapped high** | **340 µA** | **8.16 mAh** | **2.5 % per day** |

Two comparisons make the size of this clear:

- pendant-v2's whole-device deep-idle state A is **~0.15 mA**. An amplifier
  strapped into standby draws **340 µA — 2.3× the entire idle budget of the
  device.**
- Against pendant-v2's honest Profile 1 runtime of ~19 days, 8.16 mAh/day
  compounds to **155 mAh, or 47 % of the cell.**

**Strapping `SD_MODE` high costs roughly half the battery. Driving it from a GPIO
costs one pin and one resistor.** This is the actionable finding of the power
section, and **both existing documents currently specify the expensive version**:

- `Design_Package_v1.md:79` ties `SD_MODE` to VBAT.
- `docs/Breadboard_Wiring_Guide.html` says "SD — leave floating — = enabled,
  (L+R)/2 mono" `[verified]`.

Neither is wrong for a bench rig, where the amp is enabled because you want to
hear something and nobody is counting microamps. Both are wrong for a battery
product. **The change is one line of schematic, and it is invisible without a
meter** — which is exactly the kind of error that survives to production.

### 4.4 Speaker versus Bluetooth, honestly

**Per event:** indistinguishable. ~0.005 mAh either way. The speaker does not win
here and should not be defended here.

**Per readiness:** decisive, by roughly four orders of magnitude.

| | Ready-to-chime cost | Latency to first sound |
|---|---|---|
| On-board speaker | **0.6 µA** `[datasheet]` | 7 ms amp turn-on + I²S start `[datasheet]` |
| Classic BT link held warm | ~5–30 mA `[estimate]` | immediate |
| Classic BT link cold | ~0 | **3–10 s** to page, connect, and start A2DP `[estimate]` |
| BLE to phone, phone plays it | ~0 above the standing BLE link | phone-dependent, and see below |

Holding a Classic BT link warm costs 120–720 mAh/day against a 330 mAh cell —
**the cheapest end of that range still exceeds a third of the battery every
day.** Letting it go cold makes a timer chime arrive seconds late, which is not a
timer.

The BLE-to-phone route is cheap on the pendant but fails a rule pendant-v2
already derived from measured iOS behaviour: iOS grants a suspended app roughly
10 s per wake, ~30 s with a background assertion, and the architectural
conclusion at `pendant-v2.md:310` is **"The pendant must never require the phone
to acknowledge a user action"** `[verified]`. A timer chime routed through the
phone requires exactly that. It also fails the owner's stated constraint that the
phone is not always present.

**Conclusion: the speaker earns its place on readiness cost, latency, and
independence — not on energy per beep.** And by §0.2, it must not become the sink
for long-form audio, where it is genuinely 3× more expensive than the
alternative.

### 4.5 Two numbers that do not exist, and what I did instead

The nRF9160 Product Specification lists both peripherals I most needed as
**"TBA"** — I²S at §5.2.1.3 and PDM at §5.2.1.4 `[datasheet, verbatim]`. Nordic
never published them.

So the ~3 mA SoC-side figure in §4.2 is **my estimate**, built from the published
PWM and CPU numbers plus the HFXO requirement, and cross-checked against the
nRF52840's published I²S current for a comparable configuration. It is the
weakest number in this document. It is also the least load-bearing: at 0.5 s ×
20/day, being wrong by 3× moves the daily total by 0.02 mAh.

**If a PPK2 session happens, measure I²S-active and PDM-active current.** They
are the two gaps in the vendor data for this entire audio path, and they matter
for conversations even though they do not matter for chimes.

---

## 5. Acoustic and mechanical

### 5.1 Selecting the speaker — what to select against

pendant-v2 leaves this open and it is on the critical path. Constraints:

- **≤ 13 mm diameter × 3 mm** (pendant-v2's stack-up, where the speaker shares
  the battery layer's footprint; exceeding it grows the pendant from 12.5 mm to
  14 mm).
- **8 Ω**, matching the amp's characterised load.
- **Back volume will be roughly 0.5–1 cm³** `[estimate]` in a Ø34 × 12.5 mm puck
  once the battery, PCB and LRA are placed.

That last constraint is the one that decides whether this works. A 13 mm driver
in ~1 cm³ has its usable output roughly **800 Hz – 4 kHz** `[estimate]`; below
that the tiny sealed volume stiffens the suspension and the output falls away
fast. Select on **SPL at 1 kHz and resonant frequency**, not on rated power —
the amp already has more power than the driver can use (§3.1).

> **Free improvement, available today.** The existing test chime is C5/E5/G5 =
> **523 / 659 / 784 Hz** `[verified: speaker_zephyr_i2s_test.c:125-137]`. All
> three fundamentals sit at or below the likely usable corner, so the chime would
> be reproduced mostly by its harmonics — quiet and thin. **Move the chime up an
> octave (1046 / 1318 / 1568 Hz).** Design the chime to the speaker; do not
> expect the speaker to reach down to the chime.

### 5.2 Port, back volume, and where the hole goes

- **The back volume must be sealed.** A micro speaker with an open back is
  acoustically short-circuited and loses nearly all its low-mid output. This
  needs to be an explicit enclosure feature — a moulded cup or a gasketed
  compartment — not whatever space happens to be left.
- **Do not put the speaker port on the front face.** A chest-worn pendant lies
  against clothing; a front port will be occluded most of the time. **Port to the
  bottom or side edge.**
- pendant-v2 §4.6 already requires the speaker port and the mic port on opposite
  faces to avoid acoustic short-circuiting `[verified]`. Keep that.
- Both ports need protective membranes, and they are **different parts** — a
  speaker membrane and a mic membrane have different acoustic impedance and vent
  ratings. pendant-v2 §9.3 item 6 already lists these as unverified; this respin
  does not resolve it.

### 5.3 Feedback and mechanical coupling

The microphone and the speaker will be centimetres apart in a rigid shell. Two
coupling paths:

1. **Airborne**, port to port. Addressed by opposite-face porting.
2. **Structure-borne**, speaker frame → PCB or enclosure wall → microphone
   package. **This is the path people forget, and at these distances it is the
   worse one.** A micro speaker is a mechanical vibrator bolted to the same
   structure as a sensor designed to detect small pressure changes.

Mitigations, all enclosure work: a compliant silicone boot or gasket isolating
the speaker frame from both the PCB and the enclosure wall; the microphone in its
own compliant boot; and **no shared rigid rib between the two mounting points** —
that rib is a waveguide.

### 5.4 Class-D EMI next to an LTE antenna

The MAX98357A uses spread-spectrum modulation with edge-rate control
specifically to reduce radiated emissions `[datasheet]`, which helps. But the
speaker leads are an unshielded differential pair carrying a switching waveform,
run through an enclosure that also holds a cellular antenna. **Keep the speaker
leads short, routed as a tight pair, away from the antenna keep-out**, and
populate the ferrite/LC option (BOM A4). Leaving those footprints unpopulated is
fine; not having them is not.

### 5.5 Half duplex is the honest answer

Real acoustic echo cancellation is not happening on this SoC. pendant-v2 §7.1
records application RAM at **95.79 % used, 8 908 bytes free** `[verified]`. An
AEC worth having needs far more than that.

So: **while the local speaker is playing, the microphone must be muted in
software, and barge-in must be disabled.** The existing barge-in logic works for
the Bluetooth path because the audio is in the user's ears rather than in the
room; it will not survive a speaker 3 cm from the microphone. This is a
behavioural consequence of adding the speaker, and it needs to be a deliberate
decision rather than a bug discovered at bring-up.

Practically this is not much of a loss: §0.2 restricts the speaker to sounds
under about two seconds, and nobody barges in on a 400 ms chime.

---

## 6. Secure element — the concrete answer

**The owner asked whether this is an extra purchase. The honest answer is: it
does not have to be, because the SoC already contains one.**

### 6.1 What is already paid for

The nRF9160 includes **CryptoCell-310, a KMU, and TrustZone**, and this firmware
**already runs TF-M** — `TFM_PROFILE_TYPE_MINIMAL` with 32 kB of secure RAM
`[verified: boards/nrf9160dk_nrf9160_ns.overlay:9-13]`. The KMU holds key
material that non-secure application code cannot read; CryptoCell performs the
signing. pendant-v2 §6.4 already made exactly this decision for the nRF5340
generation (KMU + CryptoCell-312, PSA Level 2 certified) `[verified]`.

So the capability — an unreadable private key used for signing — exists today at
zero BOM cost and zero pins.

### 6.2 What a discrete part would add

A certified secure element buys resistance to **physical** attack: decapsulation,
fault injection, side-channel analysis. On-die KMU + CryptoCell protects against
*software* extraction and does not claim the same physical assurance.

Whether that is worth buying depends on the threat model. For a chest-worn
consumer pendant, the realistic threat is loss or theft — someone finds the
device and wants the audio on it. That is answered by encrypting storage at rest,
which pendant-v2 §6.4 already specifies (per-record AES-256-GCM under a
KMU-wrapped key, with crypto-erase on upload acknowledgement) `[verified]`. It is
not answered any better by adding a second secure chip.

**My recommendation: do not buy one for this respin.** Use the KMU. If a later
threat model justifies it, the part is cheap and adds no pins, so it can be added
to a footprint now and left unpopulated at essentially no cost — the same
"lay out, do not populate" pattern pendant-v2 already uses for the cellular modem.

### 6.3 Cost if bought anyway

`ATECC608B`, Microchip. I²C, ECC P-256, 16 key slots, hardware random number
generator. Available in UDFN-8 (2 × 3 mm), SOIC-8, and SOT-23-3. Sub-dollar in
volume. **Pin cost: zero** — it joins the existing I²C bus at address `0x6A`
alongside the DRV2605L (`0x5A`) and the accelerometer (`0x19`), with no
collision. Board cost is one package, one decoupling capacitor, and about 6 mm².

Alternatives if the threat model hardens: Infineon **OPTIGA Trust M** (I²C,
USON-10) and NXP **SE050** (I²C, HX2QFN20, Common Criteria EAL6+, considerably
more capable and considerably more expensive). Both are also zero-new-pin parts
on the existing bus.

### 6.4 How the key actually gets used — and the real problem it fixes

The interesting part is not the chip. It is what the key is *for*.

Today the pendant authenticates to the relay with a credential compiled into the
image from `secrets.conf` — a Kconfig value baked into firmware. **Anyone who can
read the device's flash can clone the device.** That is the actual weakness, and
it exists whether or not a secure element is fitted.

Attestation at the relay boundary, sketched:

1. **Provisioning (factory / first boot).** Generate a P-256 keypair inside the
   secure boundary. The private key never leaves it. Register the public key
   against the device ID in the relay's enrolled-device table.
2. **Connect.** `pendant_ws.c` opens the WebSocket. The relay replies with a
   random nonce.
3. **Sign.** The device signs `SHA-256(nonce ‖ device_id ‖ timestamp)` — via
   `psa_sign_hash()` against a KMU-backed key handle, or via cryptoauthlib
   against an ATECC608B — and returns the signature.
4. **Verify.** The relay checks the signature against the enrolled public key and
   the nonce against its own recent-nonce window, then admits the session.

A stolen firmware image now yields nothing: the credential is not in it. Replay
is blocked by the nonce. Revocation is a row in the relay's table.

**Firmware cost, as a handoff estimate** `[estimate]`: with the KMU, roughly
150–250 lines — a PSA Crypto call on the device, a nonce/verify step in the
relay, and a provisioning path. TF-M is already in the build, so there is no new
infrastructure. With an ATECC608B it is *more* work, not less: the same relay
changes plus a cryptoauthlib integration, an I²C driver binding, and a separate
provisioning flow for the chip.

This is worth stating plainly because it inverts the intuition: **the discrete
secure element does not reduce the firmware work. It adds to it.** Its only
advantage is physical-attack resistance.

---

## 7. Firmware handoff

**Written for whoever does this later. No firmware was written or modified for
this document, and none should be until the agent currently working in
`pendant_local.c` / `pendant_reflex.*` has landed.**

### 7.1 The good news: the chime hook already exists

The reflex layer already defines a `chime` callback (`pendant_reflex.h:81`), the
interpreter already dispatches it (`pendant_reflex.c:812-813`), and `main.c:3462-3470`
already binds it to `reflex_chime_play()` against the I²S device `[verified]`.
**The plumbing from "a reflex fired" to "make a sound" is done.** What follows is
about where that sound goes.

### 7.2 The item worth doing first: a chime should not run the microphone

`reflex_chime_play()` currently brings up the **full duplex slave-mode path** to
play a local sound. It starts both PWM clocks, requests HFXO, configures I²S in
slave mode at 31.25 kHz, and then **reads microphone blocks and throws them
away** for the duration of the chime, purely to keep the driver's `BOTH` transfer
alive `[verified: main.c:3313-3319, 3383-3396]`. The comment explains why —
"TX-only as a clock slave is an unproven path."

Three consequences:

1. **Power.** Two PWMs at ~1.16 mA each, plus HFXO, plus the microphone, to play
   a beep.
2. **Privacy.** *Playing a chime powers up and clocks the microphone.* With a
   hardware mute switch this is contained — pole 2 opens the data line and the
   pull-down (§3.4) makes it read silence — but a code path where "the timer went
   off" implies "the microphone ran" is one to remove on principle, not to
   contain.
3. **Specification.** It runs at 31.25 kHz, the rate §2.3 shows the amplifier
   does not support.

**Task: make the chime a master-mode, TX-only path.** As a clock *master*,
TX-only is an ordinary Zephyr configuration, not an unproven one — and
`src/speaker_zephyr_i2s_test.c` already implements it (16 kHz, master, 16-bit,
`I2S_OPT_FRAME_CLK_CONTROLLER | I2S_OPT_BIT_CLK_CONTROLLER`). It is currently not
compiled. Re-enable it, confirm it makes a sound through a MAX98357A, then fold
that configuration into `reflex_chime_play()`.

This single change fixes all three consequences and is the prerequisite for the
bench test §2.4 asks for.

### 7.3 Task list

| # | Task | Depends on |
|---|---|---|
| 1 | Re-enable `speaker_zephyr_i2s_test.c` in `CMakeLists.txt`; verify a MAX98357A makes a clean sound at the nRF9160's ±0.8 % master rate. **Answers the one open hardware question in §2.4.** | nothing — do this first, on the breadboard, before layout |
| 2 | Rewrite `reflex_chime_play()` as master-mode TX-only (§7.2). | 1 |
| 3 | Add `SD_MODE` GPIO control: assert 7 ms before the first sample, deassert after the last. Default **low** at boot and on every error path — a stuck-high `SD_MODE` is the 8.2 mAh/day bug in §4.3, and it will not be visible without a meter. | 2 |
| 4 | Add an audio sink router: short sounds → local amp, long sounds → Bluetooth. Encode §0.2's two-second rule in one place with a named constant, not scattered at call sites. | 3 |
| 5 | Under Topology A/B only: hold `SD_MODE` low across the ESP32 sync preamble so it is not played as audio (§2.6). Unnecessary under Topology C. | 3 |
| 6 | Mute the microphone and disable barge-in for the duration of local playback (§5.5). | 4 |
| 7 | Read the mute switch sense GPIO; surface it in the UI and skip capture when muted. **UI only — never treat it as the security guarantee.** | board |
| 8 | If Topology C: restore the PDM capture path from `tmp/backup-2026-08-02-pre-i2s-mic/`, which still contains the working overlay and prj.conf `[verified]`. Re-tune gain — `MIC_GAIN 4` currently stands in for the PDM peripheral's former +12 dB `[verified: main.c:138]`. | board |
| 9 | Raise the chime fundamentals an octave (§5.1). Two-line change, worth doing whenever the speaker is selected. | speaker selection |

### 7.4 Do not

- Do not treat the mute sense GPIO as the mute. The switch is the mute.
- Do not leave `SD_MODE` asserted between sounds.
- Do not route long-form audio to the speaker by default (§0.2).
- Do not enable barge-in during local playback until someone has AEC RAM to spare,
  which per pendant-v2 §7.1 is nobody.

---

## 8. Sources

### 8.1 Verified in this repo

- One I²S instance, PDM present, 32 GPIOs, `SCK = 2 × LRCK × SWIDTH`, master
  clock table, PWM current, I²S/PDM current listed "TBA" —
  `hardware/datasheets/nRF9160_cellular-SoC_Nordic.pdf` (PS v1.1), §5.2.1,
  §6.7.4–6.7.6, §6.9.
- Quiescent / shutdown / standby / turn-on / output power / LRCLK whitelist /
  `SD_MODE` table / `R_LARGE` formula —
  `hardware/datasheets/MAX98357A_I2S-amp_ADI.pdf`.
- Full-duplex I²S on one config; 64-BCLK requirement; 31.25 kHz frame rate; PWM
  clock synthesis; chime path reading and discarding mic blocks —
  `firmware/nrf9160/src/main.c:45-73, 220-233, 3313-3421`.
- Reflex chime callback and binding — `firmware/nrf9160/src/pendant_reflex.h:81`,
  `pendant_reflex.c:812-813`, `main.c:3462-3470`.
- Master-mode TX-only chime harness, uncompiled —
  `firmware/nrf9160/src/speaker_zephyr_i2s_test.c`.
- I²S pin assignment and TF-M secure RAM split —
  `firmware/nrf9160/boards/nrf9160dk_nrf9160_ns.overlay`.
- PDM failure analysis and its five unresolved candidate causes —
  `docs/Microphone_Noise_Debugging.md:36-58`.
- Original PDM + I²S topology — `hardware/design/Design_Package_v1.md:45-61`,
  `hardware/design/agentic_gadget_skidl.py:62-74`. `SD_MODE` → VBAT at line 79.
- Phase 1 bring-up wiring: amp on I²S master P0.14/15/16 with no SDIN, PDM mic on
  P0.00/P0.01, and "SD leave floating" —
  `docs/Breadboard_Wiring_Guide.html`. Retirement of that wiring —
  `firmware/nrf9160/README.txt:104`.
- Amp breakout `#3006` and 8 Ω oval speaker `#3923` purchased July 2026 —
  `hardware/purchases/innovoice.webarchive`.
- C1/C2 power states, RAM at 95.79 %, mic indicator interlock, speaker row
  unfilled, phone-acknowledgement rule, KMU/CryptoCell decision —
  `docs/hardware/pendant-v2.md` §2.1, §3.2, §4.6, §5.5, §6.4, §7.1, §8.4, §8.5.
- Icarus SoM exposed and reserved pins —
  `hardware/datasheets/IcarusSoM_datasheet_Actinius.md:62-65`.
- Sync preamble played as audio — commit `8b5a53c`.

### 8.2 Cited externally

- MAX98357A lifecycle status (Production, no NRND/EOL flag), ADI product page and
  Octopart, checked August 2026.
- ATECC608B default I²C addresses (`0x60` base, `0x35` for `-TNGTLS`) and the
  one-time `UpdateExtra` relocation of configuration byte 85 — Microchip
  ATECC608B-TNGTLS datasheet DS40002250A and cryptoauthlib issue reports.

### 8.3 Explicitly NOT verified

1. **Whether a MAX98357A locks to a ±0.8 % off-nominal LRCLK.** No tolerance
   window is specified in its datasheet. §2.4 — bench test before layout.
2. **Whether it tolerates 31.25 kHz (−2.3 %).** Same, worse. Only matters under
   Topology A.
3. **Speaker part (BOM A2).** Not selected. §5.1 gives selection criteria only.
4. **Mute switch part (BOM B1).** Not selected. DPDT, ≤ 3 mm, sealed or booted.
5. **Back volume of 0.5–1 cm³** — inferred from pendant-v2's stack-up, not from a
   CAD model. The usable 800 Hz–4 kHz band follows from it and inherits its
   uncertainty.
6. **nRF9160 I²S and PDM active current.** Nordic publishes "TBA" for both. The
   ~3 mA in §4.2 is my estimate.
7. **ESP32 / Classic-BT current figures** in §4.4. No ESP32 datasheet in this
   repo; range is from vendor documentation recalled, not from a stored source.
   The conclusion holds across the whole range, but the individual numbers are
   soft.
8. **The 2026-08-02 PDM root cause.** Never established. §2.7's mitigations
   address all five documented candidates, which is not the same as knowing which
   one it was.
9. **All prices and stock levels.** Checked August 2026, go stale, and none was
   confirmed against a live cart.
10. **Whether the respin targets the nRF9160 at all.** This pin plan is against
    the nRF9160 as requested. pendant-v2 moves the design to an nRF5340 with the
    cellular modem as a populate-or-not option. §9 covers what survives.

---

## 9. If the respin is nRF5340, not nRF9160

The pin plan above was requested against the nRF9160 and is correct for it. But
`docs/hardware/pendant-v2.md` is ledger-accepted and moves the SoC. **This is the
biggest open question in the brief, and it should be settled before anyone routes
copper.**

What survives the change unaltered:

- **Everything in §1** except the SoC itself. Amp, speaker, switch, secure
  element are all SoC-independent.
- **All of §3** — the schematic notes, the `SD_MODE` resistor, the DPDT reasoning.
- **All of §5** — acoustics and mechanics do not care which die is talking.
- **§4.1–§4.4**, with the caveat that the SoC-side estimate changes.
- **§6's conclusion**, and more strongly: the nRF5340's CryptoCell-312 + KMU is
  **PSA Level 2 certified**, which is a stronger claim than the nRF9160's
  CryptoCell-310 makes. The argument against buying a discrete secure element
  gets better, not worse.

What changes:

- **§2's arithmetic is nRF9160-specific and must be redone.** The nRF5340 has
  *two* I²S instances and a PDM peripheral, and different master-clock dividers.
  The shared-bus question may have a different answer — most likely a *better*
  one, since a second I²S removes the conflict outright.
- **§0.4's Bluetooth note becomes central.** No BR/EDR on the nRF5340 means no
  A2DP from the pendant, which makes the on-board speaker the *only* pendant-side
  audio output when no phone is present. That strengthens the case for this
  respin considerably — the speaker stops being a convenience and becomes the
  sole path.

**Recommendation: settle the SoC question first.** If it is nRF5340, §2 needs
redoing against that datasheet and the answer will probably be easier. Everything
else in this document stands.

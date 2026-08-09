# Shopping list

What to actually buy for the pendant board revision, and — more usefully — what
**not** to buy. Prices are live distributor figures from 2026-08-09 and moved
during research; re-check at order time.

Full engineering rationale lives in
[`docs/hardware/respin-speaker-mute-secure-element.md`](docs/hardware/respin-speaker-mute-secure-element.md).

---

## Buy nothing yet if you are only bench testing

Your 2 Jul 2026 Adafruit order (invoice 3705537) already covers the entire audio
path. **You own all of this:**

| Part | Adafruit PID | What it is |
|---|---|---|
| I2S 3W Class D Amplifier — MAX98357A | [3006](https://www.adafruit.com/product/3006) | The amp the respin specs. Same silicon as the production part. |
| Mini Oval Speaker — 8 Ω 1 W | [3923](https://www.adafruit.com/product/3923) | Works on the bench. Wrong *shape* for a Ø34 mm round pendant, not wrong electrically. |
| PDM MEMS Microphone Breakout | [3492](https://www.adafruit.com/product/3492) | The topology the respin recommends returning to. Breakout handles its own regulation, so no level shifter needed on the bench. |
| DRV2605L Haptic Motor Controller | [2305](https://www.adafruit.com/product/2305) | |
| Vibrating Mini Motor Disc | [1201](https://www.adafruit.com/product/1201) | |
| Lithium Ion Polymer Battery 3.7 V 500 mAh | [1578](https://www.adafruit.com/product/1578) | |
| LSM6DSOX 6-DoF IMU | [4438](https://www.adafruit.com/product/4438) | |

Plus the nRF9160 DK and the ESP32 HUZZAH32 Feather from the two Digi-Key
invoices in `hardware/purchases/`.

**Nothing below is needed to test the speaker, the mic, chimes, or haptics
today.** The list exists for the production board.

---

## Do not buy: the secure element

**You already own it.** The nRF9160 contains a key management unit and
CryptoCell-310, and the secure firmware is already in your build. A discrete
chip adds firmware work and buys only resistance to someone physically
attacking the board.

If you ever decide you want one anyway, the cheapest correct part is
**ATECC608C-SSHDA-T**, SOIC-8, **$0.77** @1 / $0.625 on reel, 1,766 in stock —
[Digi-Key](https://www.digikey.com/en/products/result?keywords=ATECC608C-SSHDA-T).
Note it is *cheaper* than the ATECC608B this project originally specced. Avoid
NXP SE050 (4–6× the price) and Infineon OPTIGA (stocked variant discontinued;
the live one is a 4,000-piece special order).

The real credential weakness is that the relay token is compiled into flash, so
anyone who reads flash clones the device. Key-management-unit-backed signing
fixes that for free. No purchase involved.

---

## Buy for the production board

### 1. Micro speaker — only if you want the round form factor

Your oval speaker works. Buy this only when the enclosure demands Ø13 mm.

| | |
|---|---|
| **Part** | PUI Audio **AS01308MR-2-R** |
| **Link** | [Digi-Key](https://www.digikey.com/en/products/result?keywords=AS01308MR) · [datasheet](https://puiaudio.com/file/specs-AS01308MR-2-R.pdf) |
| **Price** | $4.46 @1 |
| **Stock** | 3,459 |
| **Specs** | Ø13 ± 0.1 × 2.8 mm, 8 Ω, 0.2 W rated / 0.3 W max, 700 Hz–5 kHz, 85 ± 3 dBA |

**The Ø13 × 3 mm × 1 W part you asked for does not exist.** At ≤3 mm thickness,
13 mm drivers cap at 0.3–0.4 W. 0.7 W needs ~4 mm of height.

**Do not order the sibling part numbers by mistake** — `AS01308MR-R` has **7
units** in stock and `AS01308MR-5-R` has 131 with a **27-week lead**. The
`-2-R` suffix is the one with real availability, and it also specs 5% max THD
against 10% for the `-R`.

If 4 mm z-height turns out to be acceptable, Raltron
**RSP-1100.000-1313-NS1** (13 × 13 × 4.0 mm, 700 mW, $3.18, 1,152 stock)
roughly doubles the power —
[Digi-Key](https://www.digikey.com/en/products/result?keywords=13mm%20speaker%208%20ohm).

> **Two things to design around, not discover later.** Every 13 mm driver
> resonates around 1.05–1.1 kHz and output falls off a cliff below that, so
> chime fundamentals must sit **at or above 1 kHz** — the shipping chime is
> currently E5/G♯5/B5 = 659/831/988 Hz and would come through thin. And the
> MAX98357A **outpowers this speaker roughly 3×** on a 3.6 V rail, so drive has
> to be limited at the gain pin or it will cook the voice coil.

### 2. Physical mic mute switch

| | |
|---|---|
| **Part** | Nidec Copal **CUS-12TB** |
| **Link** | [Digi-Key](https://www.digikey.com/en/products/detail/nidec-copal-electronics/CUS-12TB/1124231) · [Nidec](https://www.nidec-components.com/us/product/detail/00000195/) |
| **Price** | $0.91 @1 / $0.6458 @100 |
| **Stock** | 4,839 |

**Sealed + surface-mount + under 3 mm does not exist off the shelf.** This is
the closest verified part with real stock, and it comes with two caveats that
are not cosmetic:

- It is **SPDT**, and the design calls for **two poles**. Either the second
  pole's job moves elsewhere or this part is wrong. Do not substitute silently.
- Rated **300 mA / 4 VDC** and marked *non-washable*. Fine for breaking the
  1.8 V mic supply rail. **Never put it on the battery rail.** It needs a
  gasketed enclosure slot rather than its own seal.

Alternative if 3.5 mm height is acceptable: C&K **JS102011SAQN**, $0.85 @1 /
$0.60 @100, 59,008 in stock —
[Digi-Key](https://www.digikey.com/en/products/detail/c-k/JS102011SAQN/1640095).

Sealed IP67 candidates (Salecom SS-4-M, ES40-S) appear to be factory-direct —
no distributor stock or price could be verified for any of them.

### 3. Amplifier — order early, not urgently

| | |
|---|---|
| **Part** | ADI **MAX98357AETE+T** |
| **Link** | [Digi-Key](https://www.digikey.com/en/products/detail/analog-devices-inc-maxim-integrated/MAX98357AETE-T/4936122) |
| **Price** | $3.96 @1 / $2.47 @100 / $2.19 @1k |
| **Stock** | 33,392 — but a **20-week factory lead** |

You already own a breakout of this for bench work; this is the bare chip for a
real board.

**Both escape routes are closed.** The `MAX98357B` is **Obsolete with 0 stock**,
and ADI's own recommended successor `MAX98360A` — which would have removed the
external clock requirement — is **Discontinued at Digi-Key with 0 stock**.
Staying on this part is no longer a preference. Distributor stock is deep, so
this is not an emergency, but do not assume you can reorder in twenty weeks.

### 4. PDM microphone — only for a real board

| | |
|---|---|
| **Part** | Knowles **SPH0641LU4H-1** |
| **Link** | [Digi-Key](https://www.digikey.com/en/products/detail/knowles/SPH0641LU4H-1/5332438) |
| **Price** | $3.22 @1 / $2.01 @100 |
| **Stock** | 25,832 |

Your Adafruit breakout covers bench work. For a board, this part runs on
**1.62–3.6 V**, which deletes both the 1.8 V regulator and the level shifter
that exist in the v1 schematic solely to feed a 1.8 V-only part. Same 3.50 ×
2.65 mm footprint as the TDK T5838, 1.10 mm vs 1.11 mm tall, $0.44 more @100 —
almost certainly cheaper than the two parts and the board area it removes.

Trade-off to design around: **64.3 dB SNR vs 68 dB**, and much hotter
sensitivity (−26 dB vs −41 dB), so gain must be re-scaled.

### 5. Passives

Pennies, order with whatever else you buy: 560 kΩ ±5% 0402 (amp mode select,
**fit a second footprint for tuning**), 2 × ferrite bead or LC 0402 (Class-D
EMI, mandatory next to an LTE antenna), 10 µF X5R/X7R 0603 (amp bulk).

> **The single most valuable line in the whole spec.** The amp's `SD_MODE` pin
> must be driven by a **GPIO, not a strap**. As currently documented — tied to
> battery in the v1 design package, "leave floating" in the breadboard guide —
> standby draws **340 µA**. That is 2.3× the entire device idle budget, 8.2
> mAh/day, and roughly **47% of the cell** over the target runtime. The fix is
> one resistor and one pin, and the bug is invisible without a meter.

---

## Before ordering anything for a real board

**Settle the chip first.** This list is specced against the nRF9160, but
[`docs/hardware/pendant-v2.md`](docs/hardware/pendant-v2.md) is already accepted
and moves to the nRF5340. On the nRF9160 the amp **cannot be clocked legally**:
the shared I2S bus runs at 31.25 kHz, the MAX98357A datasheet is a whitelist
(8/16/32/44.1/48/88.2/96 kHz only), and `LRCLK = 250000/M` hits no legal rate
for any integer M. The nRF5340 has two I2S instances and dissolves the problem.

Everything on this list except that clocking question survives either choice.
Tracked as task #29.

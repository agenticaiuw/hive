# AI Pendant — Hybrid-Watch Variant (design study)

**Status:** design study (2026-08-12) — feasibility, parts research, and a first-prototype plan. Nothing here changes `Design_Package_v1.md`; the pendant board remains the reference design. Companion docs: `Design_Package_v1.md` (power tree, pin map), `hardware/datasheets/` (all cited pendant parts), `firmware/nrf9160/boards/nrf9160dk_nrf9160_ns.overlay` (the breadboard controls this study remaps).

---

## 1. Concept

Owner (2026-08-12): *"make this into a fake watch, pretending it's mechanical but actually it's digital time. this design is for men. and the pendant design is for women."*

And the refinement: *"with all the current electronic components it's entirely possible to make it light and small, we just have to have tradeoffs."*

Agreed interpretation — **hybrid movement**, Withings/Fossil style:

- **Real, physical, stepper-driven hands.** No screen — consistent with the product's screenless doctrine. The watch *looks* mechanical; the truth is digital: time comes from LTE network time / GNSS, and firmware steps the hands to match.
- **Crown = the rotary encoder.** Turn to scroll, press to select, **pull out = Do Not Disturb**, long-press = the blue (approve) function.
- **Pushers = the talk/record buttons.**
- **Hands double as output** — timer sweep, approval park-angle, "agent working" wag.
- **Platform strategy: one ~38 mm round-ish PCB** serving both the men's watch case (44–46 mm) and the women's pendant enclosure.

Because the owner's refinement is right — every component *can* fit, at a price paid in millimetres, grams, or features — this study is organized around a **tradeoff matrix** (§2) that prices each component, then anchors **two named builds** (§3): FULL and THIN.

---

## 2. The tradeoff matrix

Every row: what the component costs in the watch stack, and what dropping or shrinking it buys. Heights are component thicknesses; whether they add to the *stack* depends on layout (§8) — "stack Δ" below assumes the realistic layout, not the optimistic one.

| Component (pendant BOM) | Thickness | ~g | Stack Δ if kept | Dropping / shrinking it buys | What you lose |
|---|---|---|---|---|---|
| Speaker + MAX98357A | 3–5 mm (speaker can) | 3–5 | +2–3 mm (competes with the battery layer; can't go coplanar on a 38 mm board) | −2–3 mm, −4 g, frees board area, removes the loud-playback peak-current draw from the battery spec | On-wrist voice replies. Fallback: haptic confirmations + replies via the phone/earbuds leg (§3 THIN note) |
| Battery 402030 (~200 mAh, 4.0 mm) | 4.0 mm | ~5 | +4.0 mm (always its own layer — §8 shows why) | 352030-class (~150 mAh, 3.5 mm): −0.5 mm, −1.5 g | ~25 % of runtime (≈2 days at heavy use, §10) |
| Movement, 3-hand (Miyota 2035, 3.15 mm) | 3.15 mm | ~5 | +3.15 mm | 2-hand slimline caliber (Ronda 1062-class, ~2.5 mm — verify current catalog): −0.5–0.7 mm **and −~34 µA average** (§10) | The fast seconds needle — the expressive output hand. Timer sweep degrades to minute-hand creep + haptic |
| Icarus SoM (18.5 × 28 mm) | ~2.5–3 mm (unverified — check the [SnapEDA 3D model](https://www.snapeda.com/parts/Icarus%20SOM/Actinius/view-part/)) | ~2 | +~3 mm, and its footprint is what forces the stacked layout (§8) | **Bare-nRF9160 board spin** (SiP is 10 × 16 × 1.04 mm): −1.5–2 mm AND unlocks the coplanar annulus layout — the single biggest thickness lever after this study | RF layout ownership, cert burden, new bring-up. Explicitly the *next* spin, not this one |
| USB4085 USB-C | 3.2 mm connector | 1 | forces case-wall height + a hole in a "watch" | 2 pogo pads on the caseback (MCP73831 unchanged): −the constraint, sealed case | Standard-cable charging; needs a $3 magnetic puck |
| DRV2605L + LRA (VLV101040A, ~4 mm) | ~4 mm | ~2 | ~0 (fits beside the cell in the battery layer) | — keep in both builds; it's the confirmation channel when the speaker goes | — |
| T5837 mic + 1.8 V LDO + TXB0102 | <1 mm parts | <1 | ~0 (port hole in case side) | — keep in both builds; a voice device without a mic isn't one | — |
| SK6812 LED | 1.6 mm | <1 | ~0 (shows as a "lume dot" window in the dial at 6 o'clock) | dropping saves nothing meaningful | Status glow |
| AP2112 3.3 V LDO | — | — | 0 mm but **~55 µA quiescent** — it would dominate the watch's sleep floor (§10) | swap to a nano-Iq LDO (TPS7A02-class, ~25 nA): −~50 µA floor. **Do this on the pendant board too** | nothing — strict win, both variants |
| Case: 316L steel | — | 60–80 | metal blocks LTE + GNSS (§7) | printed-resin case: −40–60 g and full radio transparency | Wrist feel. Mitigate: steel bezel + steel caseback insert, resin mid-case |
| Antenna: Molex 209142 flex | 85 × 14.5 × 0.1 mm | <1 | doesn't fit flat — must curve around the case wall (§7) | Taoglas PCS.55.A (27 × 10 × 1.6 mm) or Ignion chip antenna: fits flat under the dial | Known-good tuning; any swap or bend needs an attach test |
| Crown encoder (new part, §6) | ~4–6 mm radial, not stack | <1 | 0 stack (lives in the case wall) | — | — |

Read the matrix bottom-up for the two builds: THIN takes every "buys" column; FULL takes none of them except the LDO swap and pogo pads (strict wins).

---

## 3. Two named builds

### FULL — everything from the pendant BOM under the dial

Every pendant function on the wrist: speaker replies, 3-hand movement with the fast needle, ~200 mAh. The CEO session's earlier estimate for this was **14–16 mm** (2026-08-12, before this study); the layer-by-layer count below lands at 15.6 mm — the earlier estimate holds.

| Layer (FULL) | mm |
|---|---|
| Crystal (flat mineral, off-the-shelf) | 1.0 |
| Hand clearance (3 hands) | 1.5 |
| Dial | 0.4 |
| Movement (Miyota 2035) | 3.15 |
| Bracket / gap | 0.5 |
| PCB | 1.0 |
| SoM + tall bottom-side parts | 3.0 |
| Battery 402030 (200 mAh) | 4.0 |
| Caseback | 1.0 |
| **Total** | **≈15.6** |

44–46 mm diameter absorbs that thickness stylistically (dive watches run 13–15 mm); it reads "big mechanical," which is the disguise working for us. Weight with steel case ≈ 90–110 g; with resin case ≈ 45–55 g.

### THIN — targeting ~11–12 mm, light

Takes every tradeoff: **no speaker** (haptic confirmations on-wrist; spoken replies ride the existing cloud leg to the owner's phone/earbuds — see the honesty note below), **~150 mAh** cell justified by the duty-cycle budget in §10, **two-hand movement** (thinner, and ~34 µA less average drive current), pogo charging, nano-Iq LDO.

| Layer (THIN) | mm |
|---|---|
| Crystal (thin mineral) | 0.8 |
| Hand clearance (2 hands) | 1.2 |
| Dial | 0.3 |
| Movement (2-hand slimline, ~2.5 mm) | 2.5 |
| PCB | 0.8 |
| SoM + bottom-side parts | 2.8 |
| Battery 352030-class (~150 mAh) | 3.5 |
| Caseback | 0.8 |
| **Total (naive stack)** | **≈12.7** |
| Donut-nest the movement into the PCB layer (§8, Option B) | −~1.5 |
| **Total (nested)** | **≈11.2** |

Honest statement: **11–12 mm is reachable only with the donut-nesting trick and a verified SoM height; 12.5–13 mm is the safe promise** with the Icarus SoM. The bare-nRF9160 spin (SiP 10 × 16 × 1.04 mm) is the next lever: it removes the module layer entirely and makes a coplanar annulus layout geometrically possible — a credible path under 10 mm. For scale: the [Withings ScanWatch 42 mm is 13.7 mm thick on an 80 mAh cell](https://support.withings.com/hc/en-us/articles/360004607178-ScanWatch-What-are-the-dimensions-of-the-watch) — BLE-only. Our thickness parity with an LTE modem inside is a fair outcome; beating it needs the board spin.

> **THIN audio honesty note:** the nRF9160 has no Bluetooth, so "audio to earbuds" cannot mean watch→earbuds directly. It means: mic and uplink stay on the watch; the agent's spoken reply plays from the phone app / the owner's earbuds via the cloud leg (zero watch hardware), with the haptic + hands confirming on-wrist. The breadboard's ESP32 AirPods bridge is the bench stand-in. A later board spin could add an nRF5340 for LE Audio; that is out of scope here.

---

## 4. Control mapping — same firmware events, different actuators

The firmware event layer does not change. Ground truth for today's breadboard is `nrf9160dk_nrf9160_ns.overlay` (`pendant_controls` node) and the map in `src/main.c`: three buttons (P0.21 ask / P0.22 memo / P0.23 push-to-talk), quadrature encoder (P0.24/25 — **rotation only; the owner's knob has no wired push, so selection is a 1.5 s dwell and P0.28 is free**), and the mic-power sense (P0.26) watching the red latching switch. The watch variant just gives those events watch-shaped bodies:

| Firmware event (unchanged) | Breadboard / pendant actuator | Watch actuator |
|---|---|---|
| ask / talk (button-1 semantics) | yellow button, P0.21 | **2 o'clock pusher** |
| memo (record-only, `?dispatch=0`) | green button, P0.22 | **4 o'clock pusher** |
| push-to-talk (radio-off capture → one burst → spoken reply) | blue button, P0.23 | **4 o'clock pusher long-press**, or its own pusher if the case affords three. Blue stopped being the approval button on 2026-08-12; approvals are answered by voice during the readback |
| menu scroll | encoder A/B, P0.24/25 | **crown turn** (quadrature or magnetic angle, §6) |
| menu select | **dwell** — stop turning for 1.5 s (no push wired) | **crown press** (short) — the watch keeps a real press, and dwell stays as the fallback both bodies share |
| hardware mic mute / DND | red latching switch → `mic_power_sense` P0.26 | **crown pulled out** — the stem's second detent position mechanically opens the mic's 1.8 V rail; the same P0.26 sense reads it. The pendant's "only honest hardware mute a digital mic has" becomes a watch gesture that already means "I'm adjusting, leave me alone" |
| volume (breadboard pot — not yet in the overlay) | potentiometer | no dedicated actuator; crown turn during playback adjusts volume in software. FULL only; THIN has no speaker |

Pushers are standard chronograph pusher blanks pressing board-mounted tact switches (the Omron B3F family already in `hardware/datasheets/` — use the low-profile SMD variants); the crown pull-out detent comes for free from the donor movement's own setting stem (§6).

---

## 5. Hands as output — choreography on one motor

A hacked quartz movement has **one** Lavet motor and a geared train: you cannot move one hand without the others. That constrains, but doesn't kill, the output role — because firmware counts every step, digital time stays the truth and the hands are just a display that can be borrowed and re-synced:

- **Timer sweep:** the seconds needle becomes the timer's progress hand. While borrowed, the whole train holds or advances at the sweep's pace; when done, slew forward to true time. One rotor step = one displayed second; catching up 2 minutes = 120 steps ≈ 1.2 s at a 100 Hz slew.
- **Approval park:** on a pending approval, park the needle at a marked arc (e.g. 10 o'clock index) and pulse the LRA. Crown long-press → readback → approve/deny → needle slews home. The lag it accrued while parked is caught up the same way.
- **"Agent working":** a slow needle wag (±2 steps) — cheap, unmistakable, very "haunted mechanical."
- **Lavet motors are one-directional** by design; reverse-running tricks exist ([US4912692, high-rate bidirectional drive](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/4912692)) but are movement-specific and fragile. Rule: **always slew forward.** Worst-case forward catch-up on a 3-hand train (11 h 59 m) ≈ 43,200 steps ≈ 7.2 min at 100 Hz — acceptable for a timezone crossing, and GNSS/network time makes it rare.
- **No absolute-position sensor** in a hacked movement: hand position is open-loop step-counting, zeroed once at setup via the crown. Mechanical shock can slip a Lavet step (§11). Production answer: an index sensor (hall sensor + magnet on a wheel — the AHA3572 approach used with VID28-class motors); prototype answer: a re-zero ritual in the crown menu.
- On THIN's 2-hand movement the fast needle doesn't exist; timer/park expressions degrade to minute-hand creep + haptic patterns. That is the real feature price in the §2 matrix.

---

## 6. Parts candidates (researched, orderable)

### 6a. Movement — the thing that makes it a watch

| Option | What it is | Size | Drive | Price / source | Verdict |
|---|---|---|---|---|---|
| **Hacked quartz movement (Miyota 2035)** | The classic soldered-quartz-movement hack: open the movement, cut the two board traces to the Lavet coil, solder two wires, drive the coil from the MCU | 16.3 × 17.8 × 3.15 mm (4.67 mm over posts) | 2 GPIO. Alternating-polarity pulses, one pulse = one second-step; start at ~10–30 ms pulse width and trim down (a real watch IC uses ~7.8 ms adaptive pulses). **Measure the donor coil first** — clock-size Lavet coils run a few hundred Ω, wristwatch coils run kΩ-class; series resistor to keep coil current ≈1 mA from 3.3 V GPIO | **~$6** — [Esslinger](https://www.esslinger.com/miyota-citizen-ltd-3-hand-quartz-watch-movement-2035-overall-height-4-7mm/), [H S Walsh](https://www.hswalsh.com/product/miyota-2035-quartz-watch-movement-mzmiy2035), [Perrin](https://perrinwatchparts.com/en-us/products/quartz_watch_movement_miyota_2035); [specs](https://calibercorner.com/miyota-caliber-2035/) | **The in-case path.** Right size, right price, hands + dial + stem included. Buy 3 (hack practice kills one) |
| 2-hand slimline caliber (Ronda 1062-class) | Same hack on a thinner 2-hand movement, rotor steps every 10–60 s instead of 1 s | ~2.5 mm thick (verify current Ronda catalog) | as above, lower pulse rate | ~$10–15, Esslinger/Cousins | **THIN build's movement** |
| **VID28-05 / BKA30D-R5 dual-shaft stepper** | Automotive-gauge stepper with two concentric shafts — genuinely independent hour/minute hands | **64 × 35 × 9.2 mm — does NOT fit a 44 mm case.** Bench/mockup only | 4 GPIO, direct logic-level drive ([datasheet](https://cdck-file-uploads-europe1.s3.dualstack.eu-west-1.amazonaws.com/arduino/original/3X/b/0/b0aa1434329fd55ba59f10d853612d71be1a5b07.pdf): 3.5–10 V, <20 mA, coil 260–300 Ω, 1/12° microstep, 180:1 gears, [ITP notes](https://itpnyu.github.io/clock-club/VID28-05_mechanism/): drives fine from bare GPIO) | **~$3.50** [AliExpress](https://www.aliexpress.com/item/4000800752522.html), ~$8–13 [Amazon](https://www.amazon.com/BKA30D-R5-Degrees-Rotation-Instrument-VID28-05/dp/B0C2TKJD3J)/[eBay](https://www.ebay.com/itm/204516764984) | Bench testbed for hands-as-output choreography with independent hands; not wearable |
| Dual-motor hybrid watch module (Soprod/Fossil class) | The "real" hybrid movement | watch-sized | — | **Not orderable** — OEM-only. Nearest path: buy a donor Fossil/Skagen hybrid and board-swap it, which is exactly what [OpenChronograph](https://hackaday.com/2020/02/26/openchronograph-lets-you-roll-your-own-smart-watch/) proved works | Future option C for the case (§7); too thin to host the Icarus SoM |

GPIO budget vs the nRF9160: Lavet hack = **+2 pins** (VID28 bench rig = +4). The Icarus SoM exposes up to 27 GPIO with 3 reserved (P0.12/28/29); the pendant map in `Design_Package_v1.md` §3 uses 11. No pressure. Drive current: keep coil current ≤ a few mA with the series resistor and high-drive pin config; if a donor coil demands more, a DRV8837-class half-bridge is $1.

### 6b. Crown encoder

| Option | Notes | Price / source |
|---|---|---|
| **Existing breadboard EC11-class encoder** | Already owned, already wired (P0.24/25/28), already debounced in firmware (quadrature table + detent accumulator in `main.c`). The prototype crown IS this part with a knob | $0 (owned); spares ~$1–2 at [Mouser (Alps EC11)](https://www.mouser.com/en/c/electromechanical/encoders/?m=Alps+Alpine&series=EC11) |
| **AS5600 magnetic angle sensor** | The watch-grade path: diametral magnet glued to the stem's inner end, sensor on the PCB — contactless, sealed, no wear, 12-bit absolute | ~$6 breakout — [Adafruit 6357](https://www.adafruit.com/product/6357), [Seeed Grove](https://www.seeedstudio.com/Grove-12-bit-Magnetic-Rotary-Position-Sensor-AS5600-p-4192.html) |
| Alps ring / hollow-shaft SMD encoders | Ring types with through-shaft, smartwatch-adjacent | [Alps ring encoder line](https://tech.alpsalpine.com/e/products/category/encorders/sub/04/) — sample pricing via Mouser/Farnell |
| Pull-out detent | **No off-the-shelf pull-out encoder exists.** The donor movement's own setting stem provides the two-position detent mechanically for free; a contact leaf or microswitch on the stem's inner end reports position (and opens the mic rail — §4) | $0 (donor part) |

Crown wake gotcha (priced in §10): an EC11 at a detent can rest with contacts **closed**; against the nRF9160's ~13 kΩ internal pull-up that idles at ~250 µA per closed line. Fix: 1 MΩ external pulls, or power the encoder common from a GPIO and scan on demand after the first PORT-event edge. The AS5600 polls over I²C only when the crown is known to be out — no static draw path at all.

### 6c. Case, crystal, cell, antenna

- **Case blanks:** 44/45 mm 316L cases with mineral glass built for the **ETA/Unitas 6497** pocket-watch caliber ([iwatchcase](https://www.iwatchcase.com/products/watch-case-23930.html); eBay/AliExpress "6497 case 44mm", ~$25–90). Chosen deliberately: 6497 cases have a ~38 mm movement bore — **the same 38 mm our shared PCB targets**.
- **3D-printed case:** resin (SLA) prints the case; [known-good practice](https://siraya.tech/blogs/news/3d-printed-watch): ≥1.5–2 mm walls, standard 22 mm lug width for off-the-shelf spring bars and straps, press-fit channel for the crystal.
- **Crystal:** flat mineral crystals sold in 0.1 mm diameter steps at [Esslinger](https://www.esslinger.com/), ~$5–10.
- **Cell:** FULL — 402030 LiPo (4.0 × 20 × 30 mm, listings 150–220 mAh, ~$5–9, [EEMB on Amazon](https://www.amazon.com/EEMB-Battery-Rechargeable-Connector-Certified/dp/B08215WQMQ) and [others](https://makerselectronics.com/product/402030-lipo-battery-cell-3-7v-220mah/)); THIN — 352030-class (3.5 mm, ~150–160 mAh). Note the 2–3 C LTE burst question in §11.
- **Antenna:** pendant's Molex 209142 flex is **85 × 14.5 × 0.1 mm** (per the datasheet in `hardware/datasheets/`) — see §7. Fallback: [Taoglas PCS.55.A](https://www.taoglas.com/product/pcs-55-a-small-fr4-wideband-4g-lte-antenna/) (27 × 10 × 1.6 mm, LTE-M/NB-IoT + GNSS) or an [Ignion mXTEND chip](https://ignion.io/product/one-mxtend/) (mm-class, needs custom matching).

---

## 7. RF in a watch case — strategies, ranked

How shipping hybrids solve it: metal is opaque to RF, so every cellular/GNSS watch opens a radio window — Apple runs the antenna under/around the display behind radio-transparent crystal and uses [ceramic backs because ceramic passes RF](https://www.imore.com/new-star-constellation-ceramic-watches); hybrids keep antennas under the dial behind glass. Our two radios make the geometry unusually opinionated: **GNSS needs sky view, and on a wrist the dial faces the sky while the caseback faces skin** (a lossy dielectric). So the antenna wants to be under the dial, not in the caseback.

Ranked for this project:

1. **Resin/printed case, optional steel bezel — the prototype answer.** Whole case is radio-transparent; the 85 mm Molex flex curves around the inside of the case wall (inner circumference of a 44 mm case ≈ 125 mm — it fits with room). Curving a monopole detunes it; budget an attach-test day and accept prototype-grade efficiency. Zero new parts.
2. **Steel case + radio-transparent dial, antenna as an under-dial annulus radiating through the crystal.** The watch-grade answer, Apple-style. Needs the antenna swap (Taoglas PCS.55.A under a resin/FR4 dial, or a printed annular antenna on the dial support) and real matching work. Right for the second prototype.
3. **Steel case + resin caseback (Withings-style back window).** Ranked last despite being the common hybrid pattern, because for *us* it points the antenna into the wrist and blinds GNSS. Acceptable for LTE-only fallback, never for GNSS.
4. **Full metal, antenna in a ceramic bezel ring.** Production-class tooling and cost. Out of scope; noted as the long-run "real product" path.

Keep the u.FL: the SoM's single u.FL feeds whichever antenna the case dictates — that flexibility is exactly why the pendant board kept it, and the watch inherits it.

---

## 8. One board, two enclosures — and the shaft problem (read this first if you touch the layout)

**Flag early: hands need a central shaft.** A center-hands watch face forces either a hole through the PCB center or the movement stacked above/below the board. This single constraint shapes the whole layout. And there's a second, harder geometric fact:

> **On a 38 mm round board, the Icarus SoM (18.5 × 28 mm) and the movement (≈17 × 19 mm keep-out) can never be coplanar.** A center movement leaves an annulus (38 − 19)/2 ≈ **9.5 mm wide** — the SoM needs 18.5 mm. Even edge-offset placements fail: SoM + movement side by side need ≈36 × 30 mm, whose diagonal (≈47 mm) exceeds the 38 mm circle. **They stack, period.** The battery stacks too (same arithmetic). Only the bare-nRF9160 spin (SiP 10 × 16 mm fits the 9.5 mm annulus turned lengthwise at the rim… barely — verify) unlocks a true donut layout.

Given "they stack," the two layouts to analyze are about *which layer nests where*:

**Option A — offset movement (regulateur face).** Movement sits at 12 o'clock, hands off-center; SoM + battery occupy the 6-o'clock half, partially coplanar with the movement's layer. Saves ~1–1.5 mm vs naive stacking and looks deliberately horological (off-center dials are a classic mechanical trope). Costs: the "fake mechanical" illusion is strongest with center hands; owner call.

**Option B — center donut aperture (THIN's trick).** Center hands. The PCB gets a rectangular aperture (~17 × 19 mm) plus Ø10 mm shaft keep-out on both faces; the movement *nests through* the board plane so movement and PCB share ~1.5 mm of height. SoM and battery stack beneath as before. This is the −1.5 mm line in §3's THIN table. Costs: the aperture guts the board center — all routing becomes an annulus around it (power ring + signals; doable at 9.5 mm width), and the aperture edges are keep-out on both variants.

**Shared-board rules (both options):**
- Central Ø10 mm through-shaft keep-out, both faces, **even on the pendant stuff** — the pendant simply doesn't populate the movement.
- DNP matrix: watch build stuffs movement bracket pads + crown sensor + pusher tacts, DNPs speaker/amp; pendant build stuffs speaker/amp (+ its enclosure's button pads), DNPs the movement zone. Same fab, two BOM variants.
- The pendant enclosure (women's design) wraps the same 38 mm board in its own housing; the movement aperture area becomes the pendant's speaker cavity — the hole is a feature there (acoustic port), which is the kind of luck worth designing toward.
- Pin map: unchanged from `Design_Package_v1.md` §3, plus 2 pins for the Lavet coil, minus nothing.

---

## 9. Dimensional feasibility, honestly

| | Withings ScanWatch 42 | FULL build | THIN build |
|---|---|---|---|
| Diameter | 42 mm | 44–46 mm | 44 mm |
| Thickness | [13.7 mm](https://support.withings.com/hc/en-us/articles/360004607178-ScanWatch-What-are-the-dimensions-of-the-watch) | ≈15.6 mm (est.) | ≈12.7 mm naive / ≈11.2 mm nested (est.) |
| Battery | 80 mAh | ~200 mAh | ~150 mAh |
| Radio | BLE only | **LTE-M + GNSS** | LTE-M + GNSS |
| Weight (watch only) | ~83 g (steel) | 90–110 g steel / ~50 g resin | ~40–50 g resin |

The honest target: **FULL 15–16 mm** (a big mechanical diver's proportions — the disguise carries it), **THIN 12–13 mm promised, 11–12 mm if the donut nesting and SoM height both cooperate**. ScanWatch-class 10 mm territory requires the bare-nRF9160 spin. Anyone who quotes single figures without the layout caveats is selling something.

---

## 10. Power budget deltas vs the pendant

The LTE duty-cycle assumptions **do not structurally change** — same PSM/eDRX machinery, same connect-on-demand voice sessions. What changes is the *floor* (hands + crown are new µA-class loads; the pendant's LDO turns out to be the real floor problem) and the *per-interaction* cost (wrist antennas are a few dB worse than chest antennas → more TX power).

**Floor (sleep) budget, THIN build:**

| Load | Average |
|---|---|
| nRF9160 PSM floor | [2.7 µA](https://www.nordicsemi.com/) (Nordic product brief; eDRX 655 s alternative ≈ 6 µA for LTE-M) |
| Hands, 2-hand movement (rotor step per 20 s, 30 ms × ~1.2 mA) | ~2 µA |
| Hands if 3-hand at 1 Hz — same math × 20 | **~36 µA** ← why THIN specifies 2-hand |
| Accelerometer (LIS2DH12 low-power) | ~2 µA |
| Crown at rest (AS5600 unpowered / EC11 with 1 MΩ pulls) | ~0–3 µA |
| LDO quiescent — pendant's AP2112 | **~55 µA — unacceptable here; swap to TPS7A02-class (~25 nA). Also flag for the pendant board** |
| **THIN floor (after LDO swap, PSM)** | **≈8 µA → ~0.2 mAh/day** |

**Reachability options:** PSM-only (device-initiated; the watch reaches out on crown/pusher — near-zero cost, agent can't push) vs eDRX 655 s (+~3 µA, ≤11 min push latency) vs eDRX ~83 s (tens of µA, ≤90 s latency). THIN default: eDRX 655 s — approvals aren't that urgent, and the hands make polling visible anyway.

**Interactions dominate everything.** Per voice session ≈ 45 s at ~100 mA average (modem active + CPU + codec + mic) ≈ 1.25 mAh:

| Usage | mAh/day | Days on 150 mAh (×0.8 usable) | Days on 200 mAh |
|---|---|---|---|
| Heavy: 20 sessions/day | ~25 | ~4.8 | ~6.4 |
| Moderate: 10/day | ~12.5 | ~9.6 | ~12.8 |
| Floor + eDRX only | ~0.35 | months (self-discharge-limited) | — |

That table is the justification for THIN's ~150 mAh: at moderate use it's a **week-plus watch**, and the marginal 50 mAh of FULL buys ~2 days, not a category change. What FULL's bigger cell really buys is headroom for **speaker playback current** (hundreds of mA peaks, per `Design_Package_v1.md` §2) — which THIN deleted anyway.

Deltas vs the pendant, summarized: + hands (2–36 µA by movement choice), + crown wake (0–3 µA done right, 250 µA done wrong — §6b), + a few dB antenna penalty on wrist (call it +10–30 % per-interaction), − speaker peaks (THIN), and the LDO-quiescent fix that both variants want.

---

## 11. Risks

| Risk | Severity | Mitigation |
|---|---|---|
| Lavet hack fragility — hair-thin coil wires, one-shot trace cuts | High (prototype) | Buy 3 donor movements; practice on one; strain-relieve with epoxy |
| Open-loop hand position; shock can slip a step silently | Medium | Step-count is truth for *display* only (digital time is real truth); crown re-zero ritual; production index sensor (§5) |
| 85 mm antenna curved in the case wall detunes | Medium | Attach-test in the printed case before any board spin; Taoglas PCS.55.A fallback footprint on the PCB from day one |
| 150 mAh cell vs 250–500 mA LTE bursts (2–3 C) | Medium | ≥220–470 µF bulk (pendant spec'd 100 µF); brownout test at 3.3 V floor (RF-compliance limit from `Design_Package_v1.md` §1 bites earlier on a small sagging cell) |
| SoM thickness unverified — THIN's promise hangs on it | Medium | Measure the SnapEDA 3D model / a physical SoM **before** the case print |
| Crown readback gesture (§4) splits the blue button's semantics | Low | Owner sign-off before firmware work |
| No water resistance in prototype (open pusher/crown bores, printed case) | Accepted | State it on the case: bench prototype |
| GNSS blind if anyone "upgrades" to a full-steel case casually | Low | §7 is the contract; steel needs the under-dial window |
| Two-enclosure board drifts toward watch-only decisions | Low | DNP matrix + shared keep-outs in §8 are review-gates for both variants |

---

## 12. Build order — first watch prototype from the current breadboard

Everything already on the bench (DK, buttons, encoder, latching switch, SPH0645, ESP32 bridge, DRV2605L) stays in service. **New purchases: donor movements and (optionally) the AS5600 — that's it.** Order of operations:

1. **Order:** 3 × Miyota 2035 (~$6 ea, Esslinger) + a cheap hand assortment (~$5) + 1 × VID28-05/BKA30D-R5 (~$4–13, bench choreography rig) + AS5600 breakout (~$6, optional now). Total ≲ $50.
2. **Hack a 2035:** open, cut the two coil traces, solder wires, epoxy strain relief, 3D-print a bench bracket. (Expect to kill the first one; that's what #2 and #3 are for.)
3. **Drive it from the DK:** 2 spare GPIOs + measured series resistor. New `hands.c`: alternating-polarity pulse driver, step counter as position truth, 1 Hz tick, ~100 Hz forward slew, pulse-width trim. Verify a 24 h soak against network time.
4. **Wire the control semantics** (no new firmware events): existing encoder = crown, its push = select, blue button's role staged onto encoder long-press, latching switch = crown-pull DND stand-in (it already gates mic power and P0.26 already senses it).
5. **Choreography sprint on the VID28 rig:** timer sweep, park-angle, catch-up slews — with independent hands so the *expressions* get designed before the single-motor constraints compress them.
6. **Print the case:** 46 mm resin case, 22 mm lugs, off-the-shelf mineral crystal (Esslinger, sized to print), chrono pusher blanks over B3F tacts, dial printed with the 6-o'clock LED window. Movement + hacked harness inside; DK outside on an umbilical. Wear it. Feel how wrong/right the proportions are before any PCB exists.
7. **RF gate:** Molex flex curved inside the printed case wall → LTE attach + GNSS fix on-wrist, heartbeats on the dashboard. This gate decides antenna A vs B of §7 for the board spin.
8. **Then and only then:** the 38 mm shared-board layout decision (§8 Option A vs B), with measured SoM height and the §2 matrix re-priced against everything learned in 1–7.

---

*Prior art acknowledged: [OpenChronograph](https://hackaday.com/2020/02/26/openchronograph-lets-you-roll-your-own-smart-watch/) (Fossil/Skagen board-swap hybrids), the classic quartz-movement GPIO hacks ([Codrey](https://www.codrey.com/electronics/lavet-type-stepping-motor-quartz-clock-engine-hacks/), [Brett Oliver](http://www.brettoliver.org.uk/Clock_Control/Clock_Control.htm)), the [ITP clock-club VID28 notes](https://itpnyu.github.io/clock-club/VID28-05_mechanism/), and the [Lavet motor primer](https://en.wikipedia.org/wiki/Lavet-type_stepping_motor).*

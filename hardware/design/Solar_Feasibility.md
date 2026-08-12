# Solar Harvesting Feasibility — Hybrid-Watch Variant (solar + battery sizing study)

**Status:** feasibility analysis with sourced constants — inputs for the watch prototype, not a layout. Companion to `Watch_Variant_Study.md` (mechanical/BOM study; its §10 power budget and this doc were cross-checked and agree) and `Design_Package_v1.md` (pendant power tree).

**The owner's question (2026-08-12):** *"could we put a small solar panel on a watch? … i don't really like the blue color though. cuz usually it's gold. but we could put it under the ticks … figure out if there's no need to charge at all, or rarely need to charge."*

**Answer in one table** (40 mm watch, cell hidden under a gold dial passing 25 % of light, 150 mAh cell, nano-Iq LDO fix applied — every number derived below):

| Usage tier | Desk worker | Average | Outdoorsy | Honest verdict |
|---|---|---|---|---|
| **(a) Pure watch** (time only) | breakeven summer; winter deficit ≈ 0.6 mWh/d → **2+ yr buffer** | surplus summer; ~3 yr winter buffer | surplus year-round | **Never charge** (Eco-Drive-class result) |
| **(b) Light agent** (5 short exchanges + 2 timers/day) | −15.5 mWh/d → charge every **~30 d** | ~30–33 d | 56 d summer / 31 d winter | **Rarely ≈ monthly**, not never |
| **(c) + 10 min voice/day** | −76 mWh/d → charge every **~6 d** | ~6 d | ~7 d | **Regular charging**; solar covers 1–10 % |
| Voice-minutes/day solar can carry | ~0 | 0.2 summer / 0 winter | 1.1 summer (1.9 if τ = 40 %) / ~0 winter | crossover ≈ **0–2 voice-min/day** |

And the owner's color objection dissolves: the blue cell is never visible in the architecture below — **gold dials over hidden cells are the standard Citizen Eco-Drive construction**, and "under the ticks" is exactly how they build it.

---

## 1. Prior art — three ways shipping watches hide the cell

**Citizen Eco-Drive (under-dial, hidden — the owner's idea).** Since 1986 Citizen has put an [amorphous-silicon photocell directly under a translucent dial](https://en.wikipedia.org/wiki/Eco-Drive); light passes through the dial face to the hidden cell. Modern Eco-Drive dials are ["visually opaque dials that still permit sufficient light transmission"](https://timeandtidewatches.com/citizen-eco-drive-history-explained-50-years-of-light-powered-watch-innovation-in-depth) — gold, champagne, black, mother-of-pearl all ship today. How much light gets through (τ, the number everything hinges on):

- Citizen's [alumina-dial patent US6021099](https://image-ppubs.uspto.gov/dirsearch-public/print/downloadPdf/6021099) specifies **40–60 % transmission** while "preventing visibility of the solar cell from outside."
- The aperture/lattice approach ([DE69716055T2](https://patents.google.com/patent/DE69716055T2/en) family) sets open area to **25–50 %** of the dial, with 25 % called sufficient.
- Movement maker Ronda recommends dial transparencies of **25–40 %** ([survey](https://grokipedia.com/page/Solar-powered_watch)).
- **Reverse-derivation from Citizen's own recharge table** (§3.6 below) implies **τ ≈ 35–40 %** for a typical 3-hand Eco-Drive.

→ We carry **τ = 10 % (deeply metallic gold) / 25 % (nominal — gold that still reads gold) / 40 % (engineered dial, Citizen-class)**.

**Garmin Power Glass (transparent cell over the display).** The [Instinct 2X Solar](https://www.garmin.com/en-US/newsroom/press-release/outdoor/be-bold-with-the-rugged-new-instinct-2x-solar-from-garmin/) puts a semi-transparent cell in the crystal itself plus a visible ring at the dial edge; Garmin's claim — *unlimited smartwatch-mode battery from 3 h/day at 50,000 lux* — is a useful shipping-product calibration: roughly 30–40 mWh/day harvested from daily direct sun on a 50 mm watch. Our under-dial cell, filtered by a dial, cannot beat that; it brackets our HIGH cases.

**Casio Tough Solar (cell ring / lattice dial).** Casio runs [six cells in series under the dial, with the dial print laid out to leave cell area exposed](https://www.casio.com/intl/watches/protrek/technology/toughsolar/), some models using "a lattice-work structure in the dial to allow light to strike the solar cells," feeding a Li-ion micro-cell rated **≥500 full cycles to 80 %** — the same cycle spec as our LiPo candidates (§6).

---

## 2. The cell — what's actually purchasable

Panasonic (ex-Sanyo) **Amorton** a-Si cells are the watch-industry standard and the only broadly purchasable watch-scale cells; verified numbers:

| Cell | Size / area | Rated point | Source |
|---|---|---|---|
| AM-1815CA (indoor series) | 58.1 × 48.6 × **1.1 mm glass**, 28.2 cm² | **Vmpp 3.0 V, 42 µA → 126 µW** at the Amorton indoor rating condition (200 lux FL); Voc 4.9 V | [DigiKey](https://www.digikey.com/en/products/detail/panasonic-energy/AM-1815CA-DGK-E/2165189) |
| AM-1454CA (indoor) | ~41.6 × 26.3 mm | output voltage 2.4 V class | [RS](https://uk.rs-online.com/web/p/solar-panels/6646762) |
| AM-5413 (outdoor) | 39.0 × 16.7 mm, 6.5 cm² | 2.2–2.6 V, 7.5–15 mA under AM1.5 (100 mW/cm²) | [Panasonic lineup](https://panasonic.net/electricworks/amorton/products/) |

Derived densities (used as model constants):

- **Indoor:** AM-1815CA gives 126 µW / 28.2 cm² = **4.5 µW/cm² at 200 lux** (gross area). Peer-reviewed indoor-PV surveys credit indoor-optimized a-Si with [**5.9 µW/cm² at 200 lux CFL (9.2 % indoor efficiency)**](https://www.sciencedirect.com/science/article/pii/S2211285524006803). → **h_in = 0.025 µW/cm²·lux** (band 0.022–0.030), linear in lux across the indoor range.
- **Daylight:** 1 sun = 1000 W/m² ≈ 93,000–120,000 lux ([AM1.5 luminous efficacy ≈ 93 lm/W](https://ieee-dataport.org/open-access/conversion-guide-solar-irradiance-and-lux-illuminance)), i.e. ≈ 0.091 mW/cm² incident per 1000 lux. AM-5413 measured: (2.4 V × 11 mA)/6.5 cm² = 4.1 mW/cm² at 100 mW/cm² → **η ≈ 4.1 %**; we carry 4.5 % → **h_out = 0.041 µW/cm²·lux** of daylight.
- Amorton also makes **~0.2 mm film-substrate types** (custom shapes/holes — this is how Eco-Drive discs get their center shaft hole). Prefer film over 1.1 mm glass: the solar layer then costs **+0.3–0.5 mm of stack**, not +1.1 (matters to THIN's 11–12 mm promise, `Watch_Variant_Study.md` §3).

Under full sun an indoor-optimized cell saturates (series-resistance losses), and an outdoor cell underperforms at 200 lux — a watch cell is a compromise tuned near Citizen's; the LOW/HIGH bands absorb this.

---

## 3. Harvest model

### 3.1 Geometry — usable cell area on a 40 mm watch

The cell is a disc between dial and movement (Eco-Drive construction), needing only a **Ø8 mm center keep-out** (shaft + motion-works clearance), *not* the movement's 17 × 19 mm footprint — the movement nests below the cell. Cells extend under the tick ring (owner's "under the ticks" — ticks printed on the translucent dial above):

| Case | Cell outer Ø (under a 40 mm case) | Area = π/4·(D² − 0.8²) |
|---|---|---|
| LOW — stops inside chapter ring | 34 mm | **8.6 cm²** |
| MED — under the ticks | 36 mm | **9.7 cm²** |
| HIGH — full dial to the rehaut | 38 mm | **10.8 cm²** |

### 3.2 Chain efficiency

E_batt = (L_in·h_in + L_out·h_out) × A × **η_crystal** × **τ_dial** × **η_PMIC**

- η_crystal = 0.92 (mineral/sapphire crystal ≈ [90 %+ transmission](https://grokipedia.com/page/Solar-powered_watch))
- τ_dial = 0.10 / 0.25 / 0.40 (§1)
- η_PMIC = 0.85 (boost-harvester efficiency at these µW–mW levels, §7)

### 3.3 Wrist-exposure duty model

No public dataset logs lux-on-dial for watch wearers, so we build explicit ledgers (the wearables literature confirms the drivers: [orientation to the source dominates output](https://www.nature.com/articles/s41598-022-22232-x), sleeves and the wrist's downward tilt cut exposure; a forearm-sleeve harvester reached 94 mW in direct sun — direct sun is *everything*). L = Σ hours × lux × exposed-fraction:

| Profile | Season | Indoor ledger | Outdoor ledger | L_in (lux·h) | L_out (lux·h) |
|---|---|---|---|---|---|
| Desk worker | summer | 15 h × 200 lx × 0.65 | 0.6 h × 15 klx × 0.8 (commute, mixed shade) | 1,950 | 7,200 |
| Desk worker | winter | ×0.6 sleeves | 0.4 h × 5 klx × 0.5 (jacket cuff) | 1,170 | 1,000 |
| Average | summer | 15 h × 185 lx × 0.65 | 1.2 h × 25 klx × 0.8 | 1,800 | 24,000 |
| Average | winter | sleeves | 0.8 h × 8 klx × 0.5 | 1,100 | 3,200 |
| Outdoorsy | summer | less indoor time | 1 h × 80 klx × 0.9 + 2 h × 15 klx × 0.9 | 1,500 | 99,000 |
| Outdoorsy | winter | sleeves | 2 h × 12 klx × 0.6 | 1,000 | 14,400 |

Winter outdoor terms embed the measured **~3:1 summer:winter insolation swing at mid-latitudes** ([climatology](https://www.sciencedirect.com/science/article/pii/S0960148118314964); e.g. Central Valley 8.9 → 2.8 kWh/m²/day) plus sleeve coverage. These ledgers are the model's softest numbers — treat as ±2×; τ and profile dominate everything else anyway.

### 3.4 Daily harvest results

Bare-cell energy (mWh/cm²/day = (L_in × 0.025 + L_out × 0.041)/1000):

| | Desk S | Desk W | Avg S | Avg W | Outdoorsy S | Outdoorsy W |
|---|---|---|---|---|---|---|
| bare mWh/cm²/day | 0.34 | 0.07 | 1.03 | 0.16 | 4.10 | 0.62 |

Into the battery, **A = 9.7 cm² (MED)**, chain = 0.92 × τ × 0.85 — **mWh/day**:

| τ | Desk S | Desk W | Avg S | Avg W | Out S | Out W |
|---|---|---|---|---|---|---|
| 0.10 deep gold | 0.26 | 0.05 | 0.78 | 0.12 | 3.11 | 0.47 |
| **0.25 nominal** | **0.65** | **0.13** | **1.95** | **0.30** | **7.77** | **1.17** |
| 0.40 engineered | 1.04 | 0.21 | 3.12 | 0.48 | 12.43 | 1.87 |

Area sensitivity is linear: LOW ×0.89, HIGH ×1.11.

### 3.5 Sanity checks against shipping products and measurements

- **Indoor-only full-year monitoring** ([ACS, perovskite cells on a windowsill](https://pubs.acs.org/doi/10.1021/acsaem.3c02498)): 6.2–7.5 mWh/cm²/month December, 10.9–12.6 August → 0.21–0.42 mWh/cm²/day for perovskite (≈3× a-Si indoors) in *bright* indoor spots. Our a-Si desk figure of 0.05–0.34 mWh/cm²/day (dominated by the small outdoor slice) is consistent.
- **Garmin**: 3 h × 50 klx through Power Glass ≈ 30–40 mWh/day claimed-sustaining — our outdoorsy-summer HIGH case (12–15 mWh/day through a dial) is correctly below a no-dial full-crystal system.

### 3.6 The Eco-Drive cross-check (calibrates τ and proves the pure-watch verdict)

Citizen's own numbers, [recharge guide](https://watchguy.co.uk/tmp/Eco_Drive_Recharge_Guide_All_Models.pdf) + [MT920 storage cell](https://www.smallbattery.company.org.uk/sbc_295-40.htm) (1.5 V, 5 mAh = 7.5 mWh, "2500 h at 1.2 µA"):

- Caliber E100: 180 days runtime on a full charge → movement consumption = 7.5 mWh / 180 d ≈ **42 µWh/day ≈ 1.7 µW average** — the classic [1–2 µA quartz movement](https://spectrum.ieee.org/quartz-watch).
- Same guide: "one day of use" recharges in **1 h 20 m at 500 lux** (office) → harvest ≈ 42/1.33 ≈ **31 µW at 500 lux**. Bare a-Si at 500 lux = 12.5 µW/cm²; over a ~Ø30/Ø8 disc (6.6 cm²) × 0.92 crystal = 76 µW available → **τ_implied ≈ 40 %** — matching the patent range, and confirming that *dials which look completely normal pass 25–40 %*.
- **The humbling comparison:** an Eco-Drive movement burns 42 µWh/day; our pure-watch floor (§4) is ~710 µWh/day — **17× more** for the same harvest area. Citizen's margin is huge; ours is thin. That factor of 17 is the entire reason tier (a) is "breakeven" for a desk worker instead of trivially positive.

---

## 4. Consumption model

Sources: nRF9160 datasheet (local: `hardware/datasheets/nRF9160_cellular-SoC_Nordic.pdf`, 4418_1315 v1.1 §5.2.1.14–15), this repo's firmware, and `Watch_Variant_Study.md` §10 (whose independent floor estimate, ≈8 µA, this section reproduces). All energies at VBAT = 3.7 V.

### 4.1 Sleep floor — and the LDO that dominates it

| Load | Current | Source |
|---|---|---|
| nRF9160 **PSM floor** | **4 µA** (datasheet IPSM; Nordic brief says 2.7 µA) | datasheet §5.2.1.14 |
| — alt: eDRX 82.91 s | 19 µA (IEDRX) — push latency ≤90 s costs 3× the floor | datasheet |
| — alt: eDRX 655 s (THIN default) | ≈ +3 µA over PSM | `Watch_Variant_Study.md` §10 |
| MCU idle, RTC on (modem fully off) | 2.35 µA (IMCUON1) | datasheet §5.2.1.1 |
| 2-hand movement, step/20 s | ~2 µA | watch study §10 |
| — alt: 3-hand at 1 Hz (MCU-driven Lavet hack, 30 ms × 1.2 mA) | **~36 µA** — a verdict-flipper (+3.0 mWh/day). Note a real watch IC does 1 Hz at ~1.2 µA total (§3.6) — adaptive ~7.8 ms pulses; tune or drop the seconds hand | watch study §10 |
| LIS2DH12 accel, low-power | 2–6 µA (2 µA @ 1 Hz, 6 µA LP @ 50 Hz) | local datasheet Table 6 |
| DRV2605L via load switch, crown at rest, leakage | ~1 µA | watch study §6b/§10 |
| **AP2112 LDO quiescent (current pendant BOM)** | **~55 µA — dominates everything above combined** | watch study §3/§10 |

Two floors, because the LDO decides the pure-watch verdict (finding: `Watch_Variant_Study.md` §10; the swap is flagged for the pendant board too):

- **Floor A — current BOM (AP2112):** ≈ 62 µA → **5.5 mWh/day**
- **Floor B — TPS7A02-class swap (~25 nA Iq):** ≈ 8 µA → **0.71 mWh/day** (PSM); **0.98 mWh/day** with eDRX 655 s reachability

### 4.2 Per-event energies

| Event | Derivation | Energy |
|---|---|---|
| RRC connect + short agent exchange (~20 s active) | ~100 mA avg (modem connected: 45 mA RX floor + TX bursts @ 0–23 dBm [45–255 mA subframes, IRMC 105–140 mA at 23 dBm] + CPU/codec ~2–3 mA + mic 0.34 mA; per-session figure agrees with watch study §10's 45 s ≈ 1.25 mAh) | **≈ 2.1 mWh** |
| Spoken time-check (local audio, no radio) | 3 s playback ~50 mW | ~0.04 mWh |
| Timer: voice set + haptic expiry | exchange + 1 s LRA (VLV101040A 6.0–7.5 Ω; ~1.5 Vrms → ~0.33 W) + DRV2605L active 0.5 mA | **≈ 2.5 mWh** |
| GNSS fix (warm, 15–30 s @ 47 mA tracking) | datasheet §5.2.1.15 | 0.7–1.4 mWh; continuous 2-min single-shot mode = 1.3 mA avg = **115 mWh/day — incompatible with solar; keep GNSS off-by-default** |
| **Full-duplex LTE voice, per minute** | Opus 16 kbps up (`firmware/nrf9160/src/audio_opus.h`: `PENDANT_OPUS_BITRATE 16000`, ducks to 8k) + ~16 kbps down + TLS/WS overhead ≈ 40–45 kbps air. Modem pinned in RRC-connected: 45 mA RX/monitor + 10–25 % TX duty at 60–255 mA (0–23 dBm) + CPU/Opus 2–3 mA + mic + speaker 15–30 mA at speech volume + wrist-antenna penalty (+10–30 %, watch study §10). Nominal **≈100 mA @ 3.7 V** | **≈ 6 mWh/min** (band 3.5–10: good-link ducked quiet → cell-edge loud) |

> **Uncertainty statement, voice:** TX power is set by the network per link budget; between a strong urban cell (0–10 dBm) and cell edge (23 dBm) the modem term alone swings ~3×. The 6 mWh/min nominal is a mid-suburban estimate consistent with the watch study's measured-style 100 mA session average; treat the band, not the point, as the spec — bench-measure with the PPK2 on the first prototype.

### 4.3 Daily budgets (Floor B unless noted)

| Tier | Composition | mWh/day |
|---|---|---|
| **(a) Pure watch** | Floor B, PSM (or modem off — same 0.7) | **0.71** — cf. Floor A: 5.5; 3-hand hack: 3.7 |
| **(b) Light agent** | Floor B + eDRX 655 s (0.98) + 5 exchanges (10.3) + 2 timers (4.9) | **≈ 16.2** |
| **(c) + 10 min voice/day** | (b) + 10 × 6 | **≈ 76** (band 51–116) |

---

## 5. Balance, verdicts, and dynamics

### 5.1 Net daily balance and days-to-empty (τ = 0.25, A = 9.7 cm²)

Usable battery = 85 % of rated (charge window + converter losses): LIR2450 120 mAh → 366 mWh, LP451528 150 mAh → 472 mWh, LP502030 250 mAh → 786 mWh.

| Profile / season | (a) net | (b) net → days on 150 / 250 mAh | (c) net → days on 150 / 250 mAh |
|---|---|---|---|
| Desk S | **−0.1** (≈breakeven; 150 mAh buffer ≈ 22 yr) | −15.5 → **30 / 51 d** | −75.5 → **6 / 10 d** |
| Desk W | −0.6 → buffer 2.2 yr | −16.0 → 29 / 49 d | −76.0 → 6 / 10 d |
| Average S | **+1.2 surplus** | −14.2 → 33 / 55 d | −74.2 → 6 / 11 d |
| Average W | −0.4 → buffer 3.2 yr | −15.9 → 30 / 50 d | −75.9 → 6 / 10 d |
| Outdoorsy S | **+7.1 surplus** | −8.4 → **56 / 94 d** | −68.4 → 7 / 11 d |
| Outdoorsy W | +0.5 surplus | −15.0 → 31 / 52 d | −75.0 → 6 / 10 d |

With **Floor A (AP2112 still on the board)** the pure watch runs −3.6…−5.4 mWh/day for everyone but outdoorsy-summer → charging every ~3 months. **The nano-Iq LDO swap is what makes "never charge" true at all.**

### 5.2 The crossover — voice minutes solar can carry

(harvest − reachability floor) / 6 mWh/min:

| τ | Desk | Average | Outdoorsy |
|---|---|---|---|
| 0.25 | 0 / 0 (S/W) | 0.2 / 0 | **1.1 / 0** |
| 0.40 | 0 / 0 | 0.4 / 0 | **1.9 / 0.1** |

Solar meaningfully carries **conversation only for an outdoorsy user in summer, and only ~1–2 min/day**. Voice is a battery feature, full stop.

### 5.3 Multi-week storage dynamics (why daily averages mislead)

Tier (b), 150 mAh starting full, desk-worker weekdays + outdoorsy weekends, τ = 0.25 — end-of-week state of charge (mWh of 472 usable):

| | wk1 | wk2 | wk3 | wk4 | → empties |
|---|---|---|---|---|---|
| Summer | 378 | 283 | 189 | 95 | **~week 5** |
| Winter | 362 | 252 | 142 | 31 | **~week 4.3** |

Sunny weekends claw back only ~8 mWh against a ~78 mWh weekday deficit — **they shift the charge date by days, not categories**. So tier (b)'s honest verdict is "charge monthly," not "rarely, thanks to weekends." Conversely for tier (a) the same dynamics work in reverse: summer surpluses top the cell up (charging clamps at full), and the multi-year winter buffers in §5.1 mean a pure watch **never sees a charger in practice** — identical to the Eco-Drive ownership experience, including its "low charge after a dark drawer year" failure mode.

### 5.4 Seasonal statement

Harvest swings ~**5× between summer and winter** for the desk profile (sleeves compound the 3:1 sun ratio) and ~7× for outdoorsy. Any "never charge" claim must hold in **winter**: it does for tier (a) via multi-year battery buffers (deficit ≤0.6 mWh/day), and for nobody in tiers (b)/(c).

---

## 6. Battery sizing — weight, volume, thickness (for the watch study's stack table)

Real purchasable cells (rated capacity; usable = ×0.85 as above):

| Cell | Rated | Energy | T × W × L | Volume | Weight | Wh/kg | Fits Ø38 board? |
|---|---|---|---|---|---|---|---|
| [LIR2450 coin](https://www.powerstream.com/p/Lir2450.pdf) | 120 mAh | 0.43 Wh | Ø24.5 × **5.0 mm** | 2.4 cm³ | 5.3 g | 81 | Yes — round cell drops in movement-style |
| [LP451528](https://www.lipobattery.us/lipo-battery-lp451528-3-7v-150mah/) | 150 mAh | 0.555 Wh | **4.5** × 15 × 28 mm | 1.9 cm³ | **3.0 g** | 185 | Yes |
| 352030-class (THIN pick, watch study §3) | ~150 mAh | ~0.56 Wh | **3.5** × 20 × 30 mm | 2.1 cm³ | ~3.5 g | ~160 | Yes |
| [402030 (FULL pick)](https://www.amazon.com/EEMB-Battery-Rechargeable-Connector-Certified/dp/B08215WQMQ) | ~200 mAh | 0.74 Wh | 4.0 × 20 × 30 mm | 2.4 cm³ | ~5 g | ~150 | Yes |
| [LP502030](https://www.lipobattery.us/product/lp502030-3-7v-250mah-0-93wh/) | 250 mAh | 0.925 Wh | **5.3** × 20.5 × 32 mm | 3.5 cm³ | 5.0 g | 185 | **Marginal** — 20.5 × 32 diagonal = 38.0 mm; needs the 40 mm+ interior or a custom arc/round cell (the Garmin/Casio approach) |

Sizing read: stepping 150 → 250 mAh costs **+1.3–1.8 mm of stack and +2 g** and buys +21 days at tier (b) / +4 days at tier (c) — worth it only if voice is a daily habit. The pouch cells beat the coin cell 2.3× on gravimetric density; the coin's virtue is pure geometry.

**Cycle life under shallow solar cycling:** candidates rate [≥500 full cycles to 80 %](https://www.lipobattery.us/lipo-battery-lp451528-3-7v-150mah/) (Casio quotes the same for its solar cells). Solar-hybrid duty is *shallow*: tier (a) cycles <0.5 %/day (cycle wear negligible — calendar aging, years, dominates); tier (b) ~3 % DoD/day ≈ 11 equivalent full cycles/year → decades of cycle margin. To protect calendar life under permanent solar float, set the harvester's overcharge threshold to **4.00–4.05 V, not 4.20 V** — costs ~7 % capacity, roughly doubles calendar life at warm wrist temperatures. Deep-empty in a drawer is the real killer (Eco-Drive's documented failure mode); the harvester's cold-start handles recovery (§7).

---

## 7. Design integration notes

**Where the cell goes.** Two viable geometries, composable:

1. **Under-dial donut (primary — the owner's "under the ticks").** Amorton film cell, Ø36/Ø8, above the movement, below the dial. +0.3–0.5 mm stack. All harvest numbers above.
2. **Under-crystal ring (Garmin-style auxiliary).** A 3 mm exposed ring at the dial edge (Ø36→Ø30, 3.1 cm²) sees light with **no dial loss** (only crystal + PMIC): desk-S 0.84, avg-S 2.50, outdoorsy-S 9.96 mWh/day — *a bare 3 mm ring out-harvests the entire hidden 9.7 cm² disc* (0.65/1.95/7.77 at τ = 0.25). Cosmetic cost: a visible dark ring, which reads as a chapter ring on a gold dial. **Recommendation: do both** — ring + under-dial ≈ 1.5 mWh/day desk-summer, comfortably clearing the pure-watch floor even at τ = 0.10.

**Electrical path.** Amorton cells are monolithic multi-junction: Vmpp ≈ 3.0 V, Voc ≈ 4.9 V (AM-1815CA) — below/near the 4.2 V charge voltage, so direct trickle is marginal; use a harvesting PMIC:

| Part | Cold start | Iq | Notes |
|---|---|---|---|
| [e-peas AEM10941](https://e-peas.com/product/aem10941/) | **3 µW @ 380 mV** | sub-µA | Boost from 50 mV–5 V, MPPT, up to 110 mA input, integrated LDOs, ~7 external parts. **Recommended**: cold-starts even under the dial indoors (dial-filtered 200 lux ≈ 11 µW available) |
| [TI BQ25570](https://www.ti.com/lit/ds/symlink/bq25570.pdf) | 600 mV / ~15 µW | **488 nA** | Boost-charge + buck out, programmable OV/UV; heavier cold-start need |
| Eco-Drive-style Schottky + OV clamp | n/a | ~0 | Bench-viable v1: ~10 % diode loss, no MPPT (~30–50 % harvest left on the table at low light), no battery management. Fine for the first case print, not the answer |

Wiring into the existing tree (`Design_Package_v1.md` §1): solar disc → AEM10941 → **battery node (VBAT)**, in parallel with the existing USB path (MCP73831 on the watch per `Watch_Variant_Study.md` §3 pogo-pad plan; BQ24074 if the power-path variant is used). Two well-behaved CV chargers on one cell coexist if **solar float (4.00–4.05 V) < USB float (4.20 V)** — the harvester simply stops first; no isolation diodes on VBAT. Keep the harvester's storage connection on the battery side of any load switch so a dead watch still self-recovers in a window. One layout note: the AEM's inductor + the cell's flex tail must route through the Ø8 center or the rim annulus — claim 2 × 2 mm on the annulus now (`Watch_Variant_Study.md` §8's routing ring).

**The gold-dial tradeoff curve.** Prettier (more opaquely metallic) = less light; the full monotonic menu, desk-worker-summer harvest at MED area:

| Dial finish | τ | Harvest (mWh/day) | Pure-watch verdict (desk) |
|---|---|---|---|
| Sputtered solid metallic gold | 5–10 % | 0.13–0.26 | Deficit ≈ −0.5 → charge ~yearly-ish; buffer makes it livable but not "never" |
| Deep lacquered gold | ~15 % | 0.39 | Thin deficit; multi-year buffer |
| **Champagne/gold translucent lacquer (Eco-Drive standard look)** | **25–30 %** | **0.65–0.78** | **Breakeven-to-surplus — the recommendation** |
| Engineered lattice/aperture gold | 35–50 % | 0.91–1.30 | Comfortable surplus |
| + under-crystal ring (any dial above) | +ring | +0.84 | Removes the dial from the critical path entirely |

Citizen's 50 years of gold Eco-Drive dials are the existence proof that 25–40 % looks like real gold — the owner does not have to choose between the color and the physics.

---

## 8. Bottom line

- **Pure watch: yes — genuinely no charger**, but only after the TPS7A02-class LDO swap (with the current AP2112 the answer degrades to "charge quarterly") and with a 2-hand or properly-driven movement (the 30 ms GPIO Lavet hack at 1 Hz burns the entire solar budget by itself).
- **Light agent use: solar pays the standby bill, not the talking bill** — it roughly doubles nothing: interactions are 95 % of tier (b), so the watch charges monthly with or without sun (except an outdoorsy summer, where it stretches to ~2 months).
- **Daily voice: a battery product.** 10 min/day runs ~6 days on 150 mAh, ~10 on 250; solar contributes 1–10 %.
- **Cheapest wins in order:** nano-Iq LDO swap (×8 floor reduction, both variants), under-crystal ring (no styling cost, out-harvests the hidden disc), τ ≥ 25 % translucent gold dial, AEM10941 at 4.05 V float, GNSS off-by-default.

### Sources not already linked inline

- nRF9160 electrical spec: local `hardware/datasheets/nRF9160_cellular-SoC_Nordic.pdf` (4418_1315 v1.1) — IPSM 4 µA, IEDRX 19 µA, ITX 60–380 mA, IRX 45 mA, IGPS 47 mA, IMCUON 2.35 µA
- Firmware wire contract: `firmware/nrf9160/src/audio_opus.h` (16 kbps Opus, 16 kHz, 20 ms frames)
- [Citizen Eco-Drive 50-year history (Time+Tide)](https://timeandtidewatches.com/citizen-eco-drive-history-explained-50-years-of-light-powered-watch-innovation-in-depth) · [WatchTime evolution](https://www.watchtime.com/brands/citizen-eco-drive/inside-the-evolution-of-the-citizen-eco-drive-and-its-50th-anniversary) · [Garmin Instinct 2X product page](https://www.garmin.com/en-US/p/884585/) · [MDPI wrist-wearable hybrid harvesting](https://www.mdpi.com/1424-8220/24/16/5219) · [indoor-PV practical study](https://arxiv.org/pdf/2011.14217)

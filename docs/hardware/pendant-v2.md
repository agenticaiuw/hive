# Pendant v2 — buildable hardware specification

**Ledger:** `chg-1e29f657` (layer `hardware`, accepted by the owner, round 20)
**Status:** specification for build. Supersedes `hardware/design/Design_Package_v1.md` and `docs/Agentic_Wearable_BOM.xlsx`.
**Written:** 2026-08-07

This turns the accepted proposal into something an engineer can order parts for.
Where the proposal is wrong or underspecified, §8 says so rather than quietly
fixing it — the owner accepted a direction, not a set of numbers.

Anything not measured on this project's own hardware is cited. Anything measured
here is marked **[measured]** and points at the file or log it came from.

---

## 0. What v1 was, and what actually forces the change

v1 is an nRF9160 DK on a desk with an SPH0645 I2S mic, a microSD card, a
MAX98357A + speaker, and an ESP32 bridging audio to AirPods. It works: it
streams 16 kbps Opus over LTE-M to a Cloudflare Worker over a WebSocket and
plays a 24 kHz Opus reply back.

Four measured facts drive v2 more than any aesthetic argument:

| Fact | Value | Source |
|---|---|---|
| TLS handshake to the Worker over LTE-M | **2.4 s typical, 9.9 s worst observed** | `docs/Latency_Cut_Plan.md` **[measured]** |
| Button → Mac job dispatched, end to end | **33.7 s** | `LAT cycle_to_dispatch_ms=33708` **[measured]** |
| Application RAM in use | **95.79 % of 211,608 B — 8.9 kB free** | build report **[measured]** |
| LTE-M is half-duplex, so downlink audio starves the uplink | 42 s call ended with the uplink ring 100 % full, `uplink_drops=388` | `firmware/nrf9160/src/main.c:271-310` **[measured]** |

The half-duplex problem produced the adaptive-duck/hold machinery in
`main.c` (`CONVO_UPLINK_DUCK_BPS`, `CONVO_UPLINK_HOLD_BYTES`). That code is a
workaround for a radio choice, not a feature. The RAM number means the next
feature of any size does not fit. Those two are the engineering case for v2;
"jewellery-sized" is the product case.

---

## 1. SoC and link topology

### 1.1 The question is not "which MCU"

The proposal reads as an MCU swap. It is not. The load-bearing decision is
**where the radio link terminates** — at a cell tower, or at a phone in the
user's pocket. The MCU follows from that, because no Nordic part does both.

### 1.2 Candidates

| | nRF9160 (v1) | nRF9151 | **nRF5340** | nRF54L15 | nRF54LM20A |
|---|---|---|---|---|---|
| CPU | M33 @ 64 MHz | M33 @ 64 MHz | **App M33F @ 128 MHz + Net M33 @ 64 MHz** | M33 @ 128 MHz + RISC-V FLPR | M33 @ 128 MHz + FLPR |
| RAM | 256 kB (**211,608 B to the app**) | 256 kB, app-exclusive | **512 kB app + 64 kB net** | 256 kB nominal, **188 kB after NCS reserves the FLPR** | **512 kB** |
| Flash / NVM | 1 MB | 1 MB | 1 MB app + 256 kB net | 1.5 MB | **2 MB** |
| FPU / DSP | FPU present, **disabled in this build**; DSP yes | same | **App: FPU + DSP + 8 kB cache. Net core: neither.** | FPU + DSP | FPU + DSP |
| CPU efficiency | 45 µA/MHz (flash) | — | **~61 µA/MHz @128 MHz** | ~20 µA/MHz | **~20 µA/MHz** (503 CoreMark @ 193 CoreMark/mA) |
| Radio | LTE-M / NB-IoT / GNSS. **No BLE.** | LTE-M / NB-IoT / GNSS / DECT NR+ / NB-NTN. **No BLE.** | **BLE 5.4 + ISO/LE Audio, 802.15.4. No cellular.** | BLE 5.4 | **BLE 6.0**; ISO support unconfirmed |
| Radio current | TX 255–380 mA @23 dBm | — | **TX 3.4 mA @0 dBm, RX 2.7 mA** | TX 4.8–5.0 mA, RX 3.3 mA | TX ~5.0 mA, RX ~3.4 mA |
| Sleep | 1.4 µA modem+MCU off | PSM 2.7 µA | **System OFF 0.9 µA; 2.4 µA with all RAM retained; System ON idle 1.3 µA** | 0.7 µA OFF | 0.7 µA OFF |
| Package | 10 × 16 × 1.04 mm LGA | **12.1 × 11.1 × 1.2 mm LGA** | **aQFN94 7 × 7 mm; WLCSP95 4.39 × 3.85 mm** | CSP47 2.45 × 2.25; QFN52 6 × 6 | CSP61 3.02 × 2.43; QFN52 6 × 6 |
| Price @1 / @100 | $31.56 / $24.29 | $22.69 / $17.40 | **aQFN $9.74 / $7.40; WLCSP $8.65 / $6.56** | $4.38 / $3.29 | ~$3.36–3.59 (tier unstated) |
| Digi-Key stock | 3,160 | 0, 16-wk | **aQFN 0 (16-wk); WLCSP 8,567 (20-wk)** | 2,968 | in stock |
| Lifecycle | Nordic: *"for new design projects we recommend the nRF9151"*; only the `-B1A` code is current | current | Active | mass production | mass production |

Sources: [nRF5340 product page](https://www.nordicsemi.com/Products/nRF5340),
[nRF5340 PS](https://www.tme.eu/Document/3e794294564952202d03e12371eb0e0e/NRF5340-CLAA-R7-DTE.pdf),
[nRF5340 product brief v2.2](https://www.nordicsemi.com/-/media/Software-and-other-downloads/Product-Briefs/nRF5340-SoC-PB.pdf),
[nRF5340 aQFN @ Digi-Key](https://www.digikey.com/en/products/detail/nordic-semiconductor-asa/NRF5340-QKAA-R/13559661),
[nRF5340 WLCSP @ Digi-Key](https://www.digikey.com/en/products/detail/nordic-semiconductor-asa/NRF5340-CLAA-R/14323741),
[nRF9151](https://www.nordicsemi.com/Products/nRF9151),
[nRF9160 → nRF9151 migration](https://docs.nordicsemi.com/bundle/nwp_059/page/WP/nwp_059/intro.html),
[nRF54L15](https://www.nordicsemi.com/Products/nRF54L15),
[nRF54LM20A](https://www.nordicsemi.com/Products/nRF54LM20A),
[nRF54L15 FLPR RAM reservation](https://www.ezurio.com/support/faqs/why-do-i-have-less-than-256kb-of-ram-and-1-5mb-of-flash-memory-when-building-apps-with-nrf-connect-sdk-for-the-bl54l15).

**nRF54H20 is not orderable** (Digi-Key "Coming Soon" as of Aug 2026) and is
excluded on that basis alone. **Ambiq Apollo510, SiLabs EFR32BG24 and TI
CC2340/CC2745 could not be verified this session** (research budget exhausted) —
see §9. TI's CC2340 is Cortex-M0+ with no FPU or DSP, which would make it a poor
Opus host, but that was not confirmed against a live source.

Two corrections to the proposal's premise are worth stating before the decision:

- **The nRF5340 is not a "1 MB RAM-class device."** It is 512 kB of RAM on the
  application core plus 64 kB on the network core (576 kB total). The 1 MB
  figure in the proposal is the application core's *flash*. The real number is
  still a 2.4× improvement on what the app actually gets today, so the decision
  survives — but any RAM budget written against "1 MB" is wrong by half.
- **Only the first 256 kB of that RAM is single-cycle.** The second 256 kB block
  costs up to four additional CPU cycles per access
  ([nRF5340 PS](https://www.tme.eu/Document/3e794294564952202d03e12371eb0e0e/NRF5340-CLAA-R7-DTE.pdf)).
  Codec working buffers and the I2S/PDM DMA slabs must be pinned into the fast
  block; the audio ring buffers and the outbox staging can live in the slow one.
  This is a linker-script decision that has to be made on day one, not later.

### 1.3 Decision

**Main SoC: Nordic nRF5340 (aQFN94 for the first prototype run, WLCSP for the
production puck). Cellular is a populate-or-not option, not a permanent tenant.**

Reasons in order of weight:

1. **Radio energy — this is the whole argument.** Sustained conversational
   uplink on the nRF9160 in RRC-connected mode costs **105–140 mA average**, with
   **410–535 mA peaks** (nRF9160 Product Specification). PSM and eDRX floors of
   a few µA are irrelevant during a conversation — you cannot sleep mid-call.
   The nRF5340 radio is **3.4 mA TX at 0 dBm / 2.7 mA RX**, duty-cycled to a few
   percent at the 40 kbps this link actually needs — well under 1 mA average.
   That is a **two-orders-of-magnitude difference on the largest load in the
   device**, and it is the only reason a 300 mAh cell in a piece of jewellery is
   viable at all.
2. **LTE-M Cat-M1 is HD-FDD — half-duplex by specification** (nRF9160 PS §7.6.1).
   It cannot transmit and receive at the same time. The entire
   `CONVO_UPLINK_DUCK_BPS` / `CONVO_UPLINK_HOLD_BYTES` adaptive-duck subsystem in
   `main.c` exists to work around that, and on BLE it is **deleted, not ported**.
   A real-time duplex conversation over direct LTE-M is fighting the radio's
   fundamental mode of operation.
3. **Latency improves, counter-intuitively.** BLE → phone → cloud is roughly
   **50–90 ms one-way** (20 ms Opus frame + ~7.5–15 ms mean connection interval +
   relay + backhaul). Measured direct LTE-M RTT is **117 ms average, 98–147 ms**
   ([Monogoto](https://monogoto.io/2022/12/22/the-true-speed-of-cellular-iot/)),
   *before* the 2.4–9.9 s TLS establishment this project measured on its own
   hardware **[measured]**. NB-IoT at 1.5–10 s is categorically disqualified.
4. **Throughput is not the constraint.** The link needs 16 kbps up + 24 kbps
   down ≈ **6 kB/s aggregate**, i.e. ~45 bytes per direction per 15 ms connection
   event — a single DLE packet. Measured phone-terminated ceilings are ~90–100 kB/s
   with 2M PHY + DLE, and **~103 kB/s per direction under simultaneous
   bidirectional load**
   ([Punch Through](https://punchthrough.com/ble-throughput-optimization-faq/)).
   That is 8–34× headroom even against pessimistic numbers.
5. **Headroom.** 512 kB vs 211 kB, 128 MHz vs 64 MHz, and a radio stack on its
   own silicon. §7 spends this concretely.

**Two nRF5340 facts that must be designed around, not discovered later:**

- **The network core has no FPU and no DSP extension** (nRF5340 PS v1.3.1
  feature tables). Opus *must* live on the application core. The second core is
  scheduling isolation, not compute.
- **Idling with the 128 MHz clock configured costs 785 µA** (`ION_IDLE3,128MHz`)
  against **1.3 µA** for System ON idle at 64 MHz — a factor of ~600
  ([DevZone](https://devzone.nordicsemi.com/f/nordic-q-a/91130/current-consumption-difference---nrf5340-running-at-128mhz-vs-64mhz)).
  If the firmware clocks up to 128 MHz for a codec frame it **must clock back
  down between frames**. Getting this wrong silently costs ~19 mAh/day — more
  than the entire idle budget in §3.

**Rejected: stay on nRF91.** Nordic tells you not to start new designs on the
nRF9160, and its successor still has no Bluetooth. A cellular-only pendant cannot
use the phone's warm socket, cannot route audio to the user's earbuds, and pays
105–140 mA whenever it holds a conversation. Cellular survives as Tier 2 (§1.4).

**Rejected: nRF54L15.** 256 kB nominal, and NCS reserves 68 kB of it for the FLPR
core by default, leaving **188 kB** — *less than the nRF9160 already gives this
application*. Since the RAM ceiling is the concrete thing v2 is buying, a part
that lowers it is disqualified.

**Not evaluated: Apollo510 / EFR32BG24 / CC2745.** The comparison did not
complete this session (§9). The standing argument against them is schedule, not
silicon: this project's entire firmware, build system, TF-M setup and driver
knowledge are in NCS, and §7 shows the nRF5340 move is a same-family port. Ambiq
would be a rewrite. That should be re-examined if the schedule ever stops being
the binding constraint.

### 1.3a The strongest argument against this decision: nRF54LM20A

Honesty requires putting this at the same level as the decision, because on the
numbers it is close to winning:

| | nRF5340 | nRF54LM20A |
|---|---|---|
| RAM | 512 kB | **512 kB** |
| Flash | 1 MB + 256 kB | **2 MB** |
| CPU | 128 MHz M33F, **~61 µA/MHz** | 128 MHz M33F, **~20 µA/MHz** |
| BLE | 5.4 + ISO/LE Audio | **6.0**, ISO unconfirmed |
| Cores | 2 (radio isolated) | 1 + FLPR |
| Price @1 | $9.74 aQFN / $8.65 WLCSP | **~$3.36–3.59** |
| Stock | aQFN 0 / WLCSP 8,567 | in stock |

**It matches the RAM, doubles the flash, is roughly 3× more CPU-efficient, and
costs a third as much.** For a device whose CPU runs at high duty cycle encoding
and decoding Opus, 3× CPU efficiency is not a rounding error — it is ~2.4 mA off
the conversation state in §3.

The nRF5340 is specified anyway, for three reasons:

1. **Dual-core isolation is worth real money here specifically.** The measured
   failure mode on v1 was codec spikes blowing a 20.48 ms I2S deadline and
   killing the entire duplex transfer. Putting the radio stack on separate
   silicon removes a whole class of that.
2. **ISO/LE Audio support is confirmed on nRF5340 and unconfirmed on nRF54L.**
   §1.5 shows the iOS background problem may force the pendant to become a real
   Bluetooth audio endpoint, and closing that door before understanding it would
   be a mistake.
3. **NCS maturity.** More samples, more DevZone answers, fewer unknowns on a
   port that already has enough.

**The decision gate:** if EVT shows (a) the codec comfortably meets its deadlines
without needing core isolation, and (b) ISO turns out to be irrelevant because
the transport settles on custom GATT, then **migrate to nRF54LM20A for DVT**.
Write the firmware so that gate is cheap: no `nrf53`-specific HAL calls outside
a thin platform layer, and no assumption that the radio is on another CPU
outside the transport module. That constraint costs nothing now and saves a
rewrite later.

### 1.4 What "cellular/phone uplink only where needed" actually means

The proposal's phrase hides three different architectures. Here is the one being
specified, in tiers, so that the "where needed" is a decision the firmware makes
rather than a hope:

**Tier 0 — phone relay (primary, always present).**
The pendant is a BLE peripheral. A companion iOS/Android app holds the WebSocket
to the Cloudflare Worker and shuttles Opus frames in both directions. The
existing wire contract (`pendant_ws.c`, length-prefixed Opus packets) moves
essentially unchanged onto a pair of GATT characteristics — one notify for
uplink, one write-without-response for downlink. The relay does not learn a new
protocol.

This tier also fixes a regression the proposal did not notice: **the nRF5340 has
no Bluetooth Classic**, so it cannot do A2DP, which is why
`firmware/esp32-airpods-bridge/` exists at all. In Tier 0 the agent's voice goes
to the user's earbuds *through the phone*, which is already paired to them. The
ESP32 bridge disappears rather than needing a replacement.

**Tier 1 — on-device store-and-forward (always, no radio required).**
Everything in §6 works with no phone and no tower: capture, acknowledge, encrypt,
queue, and flush on reconnect. This is not a degraded mode, it is the baseline,
because the four skills the agents independently asked for
(`offline_thought_capture`, `offline_moment_bookmark`,
`offline_voice_memo_store_and_forward`, `offline_alert_inbox`) all say the same
thing: *the moment must survive the link*.

**Tier 2 — cellular co-module (populate-or-not, dormant by default).**
Footprint for an **nRF9151 LGA (11 × 12 × 1 mm)** on the same PCB, its own
antenna feed, its own power switch, and a UART/SPI link to the nRF5340. It is
**off** — not idle, off — until all of:

- no phone link for a configurable T (default 15 min), **and**
- the outbox holds an item marked urgent or pinned, **or** the user explicitly
  forced independent mode with a gesture (§6).

In that state the nRF9151 attaches, flushes, and powers down. It is not a live
conversational path; a conversation over Tier 2 would burn 105–140 mA and reintroduce
half-duplex ducking. Say so in the UI: independent mode is for *delivery*, not
for talking.

Populating it costs roughly $16–20 and 132 mm² of the board. For the first
prototype run, lay out the footprint and do not populate it. The honest position
is that nobody yet knows how often the phone is genuinely absent, and building
the answer before measuring the question is how the 33.7 s latency happened.

### 1.5 What Tier 0 costs — and the one finding that reshapes the product

**The BLE link survives backgrounding. The app process does not. That
distinction is the whole story, and it is worse than it first appears.**

With the `bluetooth-central` background mode, iOS's own daemon holds the GATT
connection while the app is suspended and wakes the app for delegate callbacks.
But each such wake grants roughly **10 seconds of execution, ~30 seconds with a
background task assertion**
([Apple DTS, forums/85066](https://developer.apple.com/forums/thread/85066)),
and iOS reclaims sockets out from under suspended apps (TN2277). A continuous
audio relay would die within half a minute of the screen locking.

Relaunch rules
([TN3115](https://developer.apple.com/documentation/technotes/tn3115-bluetooth-state-restoration-app-relaunch-rules)):
jetsam kill relaunches, crash relaunches, reboot relaunches after first unlock —
**user force-quit never does**, with one welcome exception: on iOS 26, adopting
**AccessorySetupKit restores relaunch after force-quit**
([Apple engineer, forums/806013](https://developer.apple.com/forums/thread/806013),
which also refutes the widely-circulated claim that iOS 26 broke CoreBluetooth
restoration).

The tempting fix — declaring the `audio` background mode to stay resident — is
**not available**. That mode is legitimate only when the iPhone's own
`AVAudioSession` is genuinely involved. Audio moving over a custom GATT
characteristic never engages it, there is no orange indicator, and declaring
`audio` purely to stay alive is textbook **App Store Guideline 2.5.4 misuse**
that developers have been rejected for. Silent-audio keep-alives carry the same
risk.

**Consequence: continuous, indefinite background relay is not achievable on iOS
with a custom GATT transport.** The pendant therefore has two operating modes,
and the product has to be honest about which one it is in:

| Mode | How the phone stays alive | What works |
|---|---|---|
| **Session** | App foregrounded, or a **PushToTalk** (iOS 16+) session, or a CallKit/PushKit call | Real-time duplex conversation, full latency budget |
| **Burst** | BLE wake → 10–30 s of execution → suspend | Store-and-forward: flush the outbox, fetch alerts, sync state. **No live conversation.** |

`PushToTalk` is the closest legitimate fit for a gesture-triggered pendant and
should be the first thing prototyped on the app side. The alternative — making
the pendant a genuine Bluetooth audio endpoint so `AVAudioSession` honestly owns
the stream — is the AirPods model and would make `audio` mode legitimate, but it
requires **HFP over Bluetooth Classic**, which the nRF5340 does not have (§8.5),
and LE Audio is not available on iOS. That door is closed for now.

**Android is materially easier:** a `connectedDevice` foreground service runs
indefinitely, with `PendingIntent` scan wakeups and `CompanionDeviceService`
process resurrection. The `microphone` FGS type *is* time-limited, Doze drops
connections when stationary, and OEM battery managers behave in ways AOSP does
not document — but there is no equivalent of the iOS 10-second cliff.

**One bonus worth designing in: ANCS.** iOS serves Apple Notification Center
Service itself, with no app running at all. That gives the pendant a
notification feed that survives every failure mode above — and it is a direct
gift to `offline_alert_inbox`.

**The design rule this produces is not a mitigation, it is the architecture:**

> **The pendant must never require the phone to acknowledge a user action.**

Every gesture in §5 completes locally — captured, haptically confirmed, durably
written — before any radio is consulted. The phone changes how fast an answer
comes back, never whether the moment was caught. This is precisely what all four
`offline_*` skills independently asked for, and the iOS finding above turns it
from a nice property into the only thing that makes the product work.

---

## 2. Bill of materials

Prices are Digi-Key, checked 2026-08-07 unless noted. **Stock figures are the
most volatile thing in this document** — three of the four microphones and five
of the six IMUs originally considered turned out to be obsolete or at zero stock,
so re-check before every order.

### 2.1 Per-device BOM

| # | Function | MPN | Manufacturer | Package / size | @1 | @100 | Stock | Notes |
|---|---|---|---|---|---:|---:|---|---|
| 1 | **SoC** | `NRF5340-QKAA-R` | Nordic | aQFN94, **7 × 7 mm** | $9.74 | $7.40 | **0**, 16-wk lead | EVT choice: standard 4-layer, hand-reworkable |
| 1a | SoC (production) | `NRF5340-CLAA-R` | Nordic | WLCSP95, **4.39 × 3.85 mm** | $8.65 | $6.56 | 8,567 | Cheaper *and* in stock, but needs HDI/microvia |
| 2 | Cellular (**DNP**) | `NRF9151-LACA-R` | Nordic | LGA, **12.1 × 11.1 × 1.2 mm** | $22.69 | $17.40 | 0, 16-wk | Tier 2 only (§1.4). Lay out, do not populate |
| 3 | **Microphone ×2** | `MMICT5838-00-012` | TDK InvenSense | **3.50 × 2.65 × 0.98 mm**, bottom port | $2.67 | $1.57 | 88,252 | PDM. **VDD 1.62–1.98 V only.** 68 dBA SNR, 133 dB AOP, and **20 µA acoustic-activity wake** |
| 4 | **IMU** | `BMI270` | Bosch Sensortec | 14-VFLGA, **2.5 × 3.0 × 0.83 mm** | $4.23 | $3.17 | 67,908 | 2048 B FIFO; **4 µA** accel-LP, +3 µA feature engine |
| 5 | Haptic driver | `DRV2605LDGSR` | TI | VSSOP-10, 3.0 × 3.0 mm | ~$1.90 | ~$1.50 | ⚠ **verify** | I²C, LRA auto-resonance, waveform library. Carried from v1 |
| 6 | LRA | `VLV101040A` | Vybronics | 10 × 10 × 4.0 mm | ~$2.00 | ~$1.60 | ⚠ **verify** | Carried from v1. Evaluate an 8 × 3.2 mm coin LRA if 4.0 mm blows the stack-up |
| 7 | Cap-touch / squeeze | **⚠ not selected** | — | — | — | — | — | See §2.3 — this is an open item, not an omission |
| 8 | **Flash** | `W25N02KVZEIR-TR` | Winbond | 8-WSON, **8 × 6 mm** | $18.40 | — | **0 @ DK**, ~$10.32 @ LCSC | 2 Gbit = **256 MByte**. 25 mA active / 10 µA standby / 1 µA DPD. **SPIM, not QSPI** (§6.2) |
| 8a | Flash (upgrade) | `W25N04KVZEIR` | Winbond | 8-WSON, 8 × 6 mm | $24.21 | $20.94 | 0, backorder | 4 Gbit = 512 MByte, pin-compatible |
| 9 | **PMIC** | `NPM1304-QEAA-R` | Nordic | QFN32, **5 × 5 mm** (WLCSP 3.1 × 2.4 also) | $2.95 | $1.81 | 3,465 | Charger 4–100 mA, 2 × 200 mA bucks @93 %, 2 LDO/load-switch, fuel gauge, 3 LED drivers, ship 370 nA |
| 10 | **Battery** | round LiPo, **Ø30 × 4.7 mm, ~330 mAh, ~6.6 g** | Grepow / equiv. | — | — | ~$10 + NRE | **semi-custom** | See §2.2 — the schedule risk in this BOM |
| 11 | Speaker amp | `MAX98357AETE+T` | ADI | TQFN-16, 3 × 3 mm | ~$2.20 | ~$1.60 | ⚠ **verify** | Class-D, I²S in. Carried from v1 |
| 12 | Speaker | **⚠ reselect** — ≤ 13 mm Ø × 3 mm | — | — | — | — | — | v1's PUI AS01808 is **18 mm — does not fit** |
| 13 | RGB indicator | discrete RGB, 1.6 × 0.8 mm | — | — | ~$0.30 | ~$0.20 | ⚠ **verify** | Drive from the nPM1304's three LED drivers. **Not** SK6812 — its quiescent current is disqualifying |
| 14 | **Antenna** | `2450AT18A100` | Johanson | **3.20 × 1.60 × 1.30 mm** | ~$0.35 | ~$0.25 | ⚠ **verify** | + pi matching network (§4.5) |
| 15 | Charge contacts | 4-pin magnetic pogo, gold | — | — | ~$2.50 | ~$2.00 | ⚠ **verify** | §4.8 |
| 16 | Crystals | 32 MHz + 32.768 kHz | — | 2.0 × 1.6 / 1.6 × 1.0 mm | ~$0.90 | ~$0.65 | — | LFXO required for BLE sleep clock accuracy |
| 17 | Passives | 0402/0201, 100–220 µF bulk | — | — | ~$3.00 | ~$2.00 | — | Bulk cap sized for TX bursts (§3.5) |
| 18 | PCB | 4-layer (6-layer HDI for 1a) | — | Ø32 mm | — | ~$5 | — | |

**Availability problem to solve before EVT:** the aQFN94 shows **0 stock with a
16-week lead**, and the WLCSP that *is* in stock needs an HDI board with
microvias — not what you want for a first spin. Two ways out: order aQFN parts
now against the lead time, or build EVT on a **pre-certified nRF5340 module**
(Fanstel BC40, Ezurio BL5340, Raytac MDBT53 class), which also carries the
antenna and the regulatory work and lets §4.5 be deferred one spin. Module part
numbers and prices were **not verified** this session (§9).

**Indicative unit cost at qty 100, EVT configuration (no cellular):
≈ $55–65 before enclosure and assembly.** With an SLS PA12 enclosure at
$20–60/part, a prototype pendant lands around **$85–130 all-in**. Rows marked
⚠ are estimates carried from the v1 BOM or from unfinished research (§9) —
treat the total as ±25 % until they are closed.

### 2.2 The battery is the long pole

§4.3 shows that no commodity pouch cell fits a 34 mm circle. The spec is a
**Ø28–30 mm, 4.0–5.0 mm thick, 250–330 mAh round LiPo**. Catalogue references
exist (LPR473027 at Ø30 × 4.7 mm / 330 mAh / ~6.6 g; LPR353027 at Ø30 × 3.5 mm /
210 mAh / ~4.2 g), but these come from manufacturer/trading listings with **no
published unit pricing, MOQ or certification data**, and the capacities are
nominal marketing figures. **Treat this as a semi-custom cell engagement with a
lead time, not a line item.** Order sample cells and put them on a discharge rig
before trusting any number in §3.

Varta CoinPower coin cells were considered and rejected: at 120–145 mAh for
Ø16 × 5.4 mm they carry 2–3× less energy than a Ø30 round pouch of similar
thickness, and they ship without protection circuitry.

Sizing note corrected from the research brief: **LTE-M peak current is ~450 mA
for 40–50 ms**, not 2 A (nRF9160 PS; operating range documented as ~1 µA to
500 mA, with a worst case of 410–535 mA at VSWR 3). Design the bulk capacitance
and the PMIC's VSYS limiter to 0.5 A. Note also that the **PMIC may be the
binding limit rather than the cell** — the nPM1300's VSYS limiter defaults to
1.0 A; the equivalent figure for the nPM1304 was **not verified** (§9).

### 2.3 Open BOM item: how you sense a squeeze

The proposal asks for a capacitive touch/squeeze pad. Two facts have to be
settled together before this line can be filled:

- **The nRF5340 has no capacitive-touch peripheral.** It has COMP/LPCOMP, and the
  old nRF5 SDK shipped a COMP-based cap-sense library for nRF52, but nRF Connect
  SDK has no equivalent. So this is an external IC, or MCU cycles spent on
  software cap-sense — and MCU cycles in the idle state are exactly what §3
  cannot afford.
- **Capacitive sensing does not work through a machined aluminium shell.**
  Aluminium terminates the E-field; the sensor sees the shell, not the finger.
  No overlay thickness or gain setting fixes this.

Four candidate approaches, to be chosen with the §4.4 enclosure decision, not
after it:

| Approach | Works through metal? | Idle current | Notes |
|---|---|---|---|
| External cap-touch IC (Azoteq IQS-class) + polymer/ceramic shell | No | ~10–20 µA (unverified) | Simplest if the shell is non-conductive |
| **Inductive sensing of shell deflection** (TI LDC3114-class) | **Yes** | unverified | Marketed specifically for buttons on metal. Senses the µm of flex from a squeeze |
| Snap dome under a flexing shell | Yes | **0 µA** | Zero quiescent, unambiguous, but it clicks and it is a moving part in a sealed device |
| Piezoresistive force sensor | Yes | low | Analogue front end, drift and temperature compensation |

**Both statements above are flagged as unverified against a current source (§9)
and must be confirmed before layout.** Note that they interact directly with
§4.4: choosing aluminium eliminates the cheapest option here as well as
complicating the antenna.

### 2.4 Power tree

The nPM1304 supplies everything, and the rail split is forced by two constraints
that are easy to miss: **the T5838 is a 1.8 V part (1.62–1.98 V absolute)** — it
is not 3.3 V tolerant — and §5.5 requires the microphone supply to be switchable
by a rail the indicator LED can be tied to.

| Rail | Source | Voltage | Loads |
|---|---|---|---|
| VSYS | battery / charger path | 3.0–4.2 V | PMIC, bulk cap, speaker amp (via load switch) |
| VDD_SOC | nPM1304 BUCK1 | 1.8 V (or 3.0 V) | nRF5340, W25N02KV flash, BMI270, cap sensor |
| **VDD_MIC** | nPM1304 **BUCK2 → LDO/load switch** | **1.8 V, gateable** | 2 × T5838. **The mic indicator LED is driven from the load side of this switch** (§5.5) |
| VDD_AMP | VSYS via load switch | 3.0–4.2 V | MAX98357A — run from VSYS for maximum output |
| VDD_HAPTIC | VSYS | 3.0–4.2 V | DRV2605L + LRA |

Notes for the schematic:

- **100–220 µF bulk on VSYS**, sized for the LRA's start-up surge and, if the
  Tier 2 modem is ever populated, its ~450 mA / 40–50 ms TX bursts (§2.2).
- Level shifting between the 1.8 V mic rail and VDD_SOC is unnecessary **only if
  VDD_SOC is also 1.8 V**. Choosing 3.0 V for the SoC adds a translator to the
  PDM lines — which is exactly where v1's crosstalk problems lived
  (`docs/Microphone_Noise_Debugging.md`). **Run the whole digital domain at
  1.8 V** and avoid the translator.
- Nordic recommends 20–100 Ω series damping on PDM CLK (at the source) and DATA
  (at the microphone) — v1 learned this the expensive way. Keep PDM routing away
  from the flash SPIM bus.

---

## 3. Power budget

Every number here is **modelled, not measured**. v1 has no power management at
all (§7.5), so there is no in-house measurement to anchor against. Component
currents are from datasheets; duty cycles are from this project's own measured
codec timings. **A ×2 margin is applied to every daily total**, which is the
normal gap between a paper budget and first silicon: light-load buck efficiency
is far below the 93 % headline, BLE stack overhead exceeds the radio's own
current, and there is always something nobody modelled.

### 3.1 Component currents used

| Item | Active | Idle / sleep | Source |
|---|---|---|---|
| nRF5340 app core @128 MHz | 7.8 mA (514 CoreMark @ 66 CoreMark/mA) | **785 µA if idled with the 128 MHz clock configured** | Nordic PB v2.2, DevZone 91130 |
| nRF5340 app core @64 MHz | 3.5 mA | System ON idle **1.3 µA** | Nordic PB v2.2 / PS v1.3.1 |
| nRF5340 radio | TX 3.4 mA @0 dBm, RX 2.7 mA @1 Mbps | System OFF 0.9 µA; 2.4 µA all-RAM-retained | PS v1.3.1 |
| T5838 mic (each) | HQ **310 µA**, Low-Power 120 µA | **AAD Analog 20 µA (clock off)**, sleep 0.8 µA | DS-000383 r1.2 |
| BMI270 | A+G normal 685 µA | accel-LP **4 µA**, +3 µA features, suspend 3.5 µA | Bosch DS r1.6 |
| W25N02KV flash | 25 mA | 10 µA standby, **1 µA deep power-down** | Winbond DS |
| nPM1304 | — | ship 370 nA, hibernate 500 nA, **5 µA leakage at full charge** | Nordic |
| MAX98357A + speaker | ~20 mA average at conversational level *(estimate)* | shutdown < 1 µA | ⚠ estimate |
| nRF9151 (Tier 2 only) | **105–140 mA** RRC-connected uplink; peaks 410–535 mA | PSM 2.7 µA, eDRX 18 µA | nRF9160/9151 PS |

The **785 µA / 1.3 µA** line is the trap. Clocking to 128 MHz for a codec frame
and idling there between frames costs ~19 mAh/day — more than the entire idle
budget below. **The firmware must clock down between frames**, and that must be
verified with a current probe, not by reading the code.

### 3.2 States

| | State | Composition | Est. battery current |
|---|---|---|---|
| **A** | **Deep idle / stowed** | System ON idle, BLE connected @1 s, mics in AAD Analog (2 × 20 µA), IMU any-motion (7 µA), flash in DPD, amp shut down | **~0.15 mA** |
| **B** | **Armed / listening** | Mics in HQ (620 µA), on-device VAD at 64 MHz (~5 % duty), BLE @100 ms | **~1.0 mA** |
| **C1** | **Conversation, local speaker** | 2 mics HQ + Opus enc/dec at 128 MHz (~60 % duty) + BLE @15 ms + amp driving the speaker | **~30 mA** |
| **C2** | **Conversation, audio via phone → earbuds** | as C1 with the amp shut down | **~9 mA** |
| **D** | **Offline capture** (no radio) | 2 mics HQ, Opus encode only (~25 % duty @128 MHz), NAND writes at 2 kB/s | **~3.6 mA** |
| **E** | **Outbox flush over BLE** | High-rate GATT, flash reads, AES-GCM | **~6 mA** |
| **F** | **Tier 2 cellular flush** | nRF9151 RRC-connected | **~120 mA** |
| **G** | **Charging** | nPM1304 at its 100 mA ceiling | −100 mA into the cell |

**C1 vs C2 is worth staring at.** The loudspeaker is two-thirds of the
conversation budget. Routing the agent's voice to the user's earbuds via the
phone (§1.4 Tier 0) is not only better audio, it is a **3× power saving on the
most expensive state in the device.** The local speaker earns its place for
offline alerts and for when no earbuds are present — but it should not be the
default output path.

**State F is deliberately absent from every profile below.** At ~120 mA, a
single eight-minute Tier 2 flush costs **~16 mAh — about 5 % of the pack for one
delivery.** That is affordable as a rare, user-invoked or urgency-gated event
(§1.4) and ruinous as a background habit. Whatever policy decides when Tier 2
fires must be conservative by construction, and the pendant should report the
battery cost of each cellular flush so the policy can be tuned against real data.

### 3.3 Daily totals

**Profile 1 — gesture-triggered** (the specified default): 20 min conversation
via earbuds, 10 min offline capture, 30 min armed, 10 min flushing, rest deep idle.

| State | Duration | mAh |
|---|---:|---:|
| C2 | 20 min | 3.0 |
| D | 10 min | 0.6 |
| E | 10 min | 1.0 |
| B | 30 min | 0.5 |
| A | 22 h 50 min | 3.4 |
| **Modelled total** | | **8.5** |
| **With ×2 margin** | | **17** |

**Profile 2 — always-listening, wake-on-sound armed**: mics sit in AAD Analog
and escalate to HQ only on acoustic activity (assume 8 h/day), 3 h/day of
captured speech, 30 min conversation.

| Line | mAh |
|---|---:|
| Mics: 16 h AAD + 8 h HQ | 5.6 |
| VAD CPU during 8 h of activity | 3.2 |
| Encode + NAND for 3 h of speech | 7.5 |
| BLE connected, 24 h | 3.6 |
| Conversation + flush, 30 min | 4.0 |
| PMIC, IMU, leakage, 24 h | 1.4 |
| **Modelled total** | **25.3** |
| **With ×2 margin** | **51** |

**Profile 3 — always-listening, mics never sleep** (no AAD gating), plus an hour
of loudspeaker use:

| Line | mAh |
|---|---:|
| Mics HQ, 24 h | 14.9 |
| CPU VAD + encode, heavy | 36 |
| Speaker, 1 h | 20 |
| Conversation, 1 h | 12 |
| Radio, flash, PMIC | 8 |
| **Modelled total** | **91** |
| **With ×2 margin** | **182** |

### 3.4 The runtime number

On the specified **330 mAh** cell:

| Profile | Modelled | **Honest, ×2 margin** |
|---|---:|---:|
| 1 — gesture-triggered | 39 days | **~19 days** |
| 2 — always-listening with wake-on-sound | 13 days | **~6.5 days** |
| 3 — always-listening, no gating, heavy speaker | 3.6 days | **~1.8 days** |

**The headline: 6–7 days in the mode this product actually wants to ship in
(always-listening, wake-on-sound armed), and never worse than about a day and a
half even in the pathological case.** Charge it nightly and it will not run out;
forget for a couple of days and it still will not.

Three honest caveats attached to that number:

1. **Wake-on-sound is what buys it.** Profile 2 → Profile 3 is a **3.6× swing**,
   and the difference is entirely whether the microphones sit at 20 µA in AAD
   Analog or 310 µA each in High Quality. If the T5838's AAD proves too
   trigger-happy in practice (it is a bare level threshold and will fire on a
   slamming door), the fallback is AAD Digital 2 at 110 µA per mic, which is
   still 3× better than always-HQ. **Prototype the AAD threshold early**; it is
   the single highest-leverage power decision in the device.
2. **A smaller cell scales this linearly.** If the enclosure forces the Ø30 ×
   3.5 mm / 210 mAh cell instead, multiply every figure by **0.64** — Profile 2
   becomes ~4 days.
3. **The ×2 margin is a guess about our own ignorance, not a measurement.** The
   first thing EVT must do after §7.6 step 5 is put a current probe on each state
   in §3.2 and replace this table. Until then, treat "6–7 days" as "comfortably
   more than a day", which is the claim that actually matters.

### 3.5 Charging

330 mAh at the nPM1304's **100 mA charge ceiling** is roughly **4–4.5 hours to
full** including CV taper. That is fine overnight and useless as a
before-you-go-out top-up.

The tradeoff, stated so it is a decision rather than a surprise: the **nPM1300**
charges at up to 800 mA and would fill this cell in under an hour — but it leaks
**~100 µA when fully charged** versus the nPM1304's **5 µA**. On a 330 mAh pack
that leak is ~2.4 mAh/day, roughly 30 % of Profile 2's entire modelled budget,
burned doing nothing. **The nPM1304 is the right call**; slow charging is the
price and it is the correct price for a device that charges while you sleep.

---

## 4. Mechanical and materials

It is worn where people can see it, so the enclosure is a product decision with
electrical consequences, not a housing exercise.

### 4.1 Comparables — what people actually tolerate wearing

| Product | Dimensions | Mass | Material |
|---|---|---|---|
| Limitless Pendant | **31.9 mm wide × 16 mm thick** | not published | aluminium |
| Plaud NotePin | **51 × 21 × 11 mm** | **16.7 g** (0.59 oz) | polymer + metal trim |
| Plaud NotePin S | as above | 17.3 g | — |
| Bee Pioneer | ~30 × 15 mm, pill | not verified | polymer |

Sources: [Limitless FAQ](https://help.limitless.ai/en/articles/9124757-pendant-faq),
[Plaud NotePin](https://www.plaud.ai/products/plaud-notepin).
The Limitless figure is worth staring at: **31.9 mm across and 16 mm thick.** A
shipping product in exactly this category is half again thicker than the 10–12 mm
that "jewellery-sized" suggests. Thickness is where the battery lives, and nobody
has cheated it yet.

### 4.2 Target

| | Target | Hard limit |
|---|---|---|
| Diameter | **34 mm** | 36 mm |
| Thickness | **12.5 mm** | 14 mm |
| Mass incl. bail | **≤ 18 g** | 22 g |

Stack-up at 12.5 mm: front cap 1.0 · PCB 0.8 (4-layer) · component height 1.5 ·
battery 4.7 · speaker + LRA sharing the battery layer's footprint · rear cap 1.0 ·
tolerance and adhesive 1.0. It closes, with no room spare. If the speaker cannot
share the battery layer, this becomes 14 mm and matches Limitless.

### 4.3 The constraint nobody wrote down: a round pendant needs a round cell

A 34 mm outside diameter with a 1.2 mm wall and clearance leaves roughly **31 mm
of usable internal diameter**. A rectangular pouch must fit *inside that circle*,
so its **diagonal** must be under ~31 mm — capping it at about 22 × 22 mm.

**Every commodity hobby cell fails that test:**

| Cell | Capacity | Dimensions | Diagonal | Fits Ø34? |
|---|---:|---|---:|---|
| Adafruit 1317 | 150 mAh | 19.75 × 26.02 × 3.8 mm | 32.7 mm | **No** |
| Adafruit 2750 | 350 mAh | 36 × 19.6 × 5.2 mm | 40.9 mm | **No** |
| Adafruit 3898 | 400 mAh | 36 × 17 × 7.8 mm | 39.8 mm | **No** |
| SparkFun PRT-13851 | 400 mAh | 26.5 × 36.9 × 5.0 mm | 45.4 mm | **No** |
| EEMB LP453030HA | 300 mAh | 32 × 20.5 × 6.7 mm | 38.0 mm | **No** |
| v1 BOM's 503035 | 500 mAh | 35 × 30 × 5 mm | 46.1 mm | **No** |

**The v1 battery does not fit in the v2 enclosure.** A circular pendant requires
a round cell, which means a semi-custom part with a lead time and an MOQ, not a
Digi-Key line item. This is the single biggest schedule risk in the BOM and it is
invisible in the proposal. §2 specifies the cell; the alternative is to abandon
the circle for a rounded rectangle (Plaud's shape), which reopens the whole
commodity-pouch catalogue and is a legitimate thing to do if the round cell's
lead time is unacceptable.

### 4.4 Enclosure material — and the antenna fight

**The conflict is real and it is not negotiable by industrial design.** A
conductive shell that fully encloses the radio is a Faraday cage. There are
exactly three ways out, and only three:

1. **Make the enclosure non-conductive.** Polymer, ceramic, or sapphire.
2. **Keep metal but cut a window.** A non-conductive section over the antenna,
   with a real gap — decorative "metal-look" coatings still detune.
3. **Make the metal the antenna.** Feed and tune the shell itself as a radiating
   element, split by insulating gaps. This is what phones do. It works, and it
   costs a dedicated antenna engineer and several EVT spins.

| Material | RF | Mass (est. shell) | Feel | Prototype cost | Verdict |
|---|---|---|---|---|---|
| **SLS PA12 / MJF nylon** | transparent, ε_r ≈ 3 | ~3 g | matte, plasticky | days, ~$20/part | **Prototype in this.** |
| Machined PC / moulded PC-ABS | transparent, ε_r ≈ 2.7–3.2 | ~3 g | good with a coating | weeks (tooling) | Production default |
| **Machined aluminium** | **opaque — needs option 2 or 3** | ~7 g | premium, cold, scratches | days, ~$60/part | Only with a designed RF window |
| **Zirconia ceramic** | transparent but **high ε_r loads and detunes the antenna**; needs re-tuning against the actual part | ~15 g | premium, heavy, brittle | weeks, expensive | Blows the 18 g mass target on its own |
| Sapphire | transparent, moderate ε_r | heavy | jewellery-grade, unscratchable | very expensive | Window only, not a shell |

*(ε_r figures are order-of-magnitude engineering values; confirm against the
specific grade with the antenna vendor before tuning — see §9.)*

**Recommendation: SLS PA12 for EVT, moulded PC with a PVD-coated aluminium
decorative ring for production.** The ring is cosmetic and sits away from the
antenna corner — it gives the metal look without the Faraday cage. If the owner
wants a genuinely solid metal pendant, that is a decision to make *now*, because
it changes the antenna from a $0.30 chip part to an engineering program.

### 4.5 Antenna

**Specified: Johanson 2450AT18A100, 3.20 × 1.60 × 1.30 mm chip antenna** at a
board corner, with a pi matching network laid out and populated after tuning on
the real assembly.

From the datasheet: **a 6.5 × 6.5 mm no-ground keep-out** at the corner, working
against a ground plane (Johanson's own evaluation board uses 13.5 mm of ground
below the antenna), fed by a 50 Ω line, peak gain 0.5 dBi / average −0.5 dBi
([Johanson 2450AT18A100 spec](https://www.johansontechnology.com/datasheets/2450AT18A100/2450AT18A100.pdf)).

Layout rules that follow:

- The antenna corner gets the **rear cap's non-conductive window**, the battery
  kept out of its shadow, and no LRA, speaker magnet, or flash package under it.
- The human body is lossy at 2.4 GHz and the pendant is pressed against a chest.
  **Point the keep-out corner outward/upward**, and budget for measured
  efficiency well below the datasheet's free-space figure. Tune on-body, not on
  a bench fixture.
- Matching values on this PCB **will not** be Johanson's evaluation-board values.
  Leave the pi network pads, and plan an EVT tuning pass.

### 4.6 Microphone placement

The two mics are not a stereo pair in the usual sense — §8.3 specifies them for
near-field own-voice detection, rustle rejection, and redundancy, and each of
those wants a different thing from the geometry:

- **Maximise the separation.** Put them on opposite sides of the puck, as far
  apart as the 34 mm body allows (~25 mm achievable). The near-field level
  difference that identifies the wearer's own voice grows with separation.
- **Put one on the front face and one on the rear (body-facing) face.** The rear
  mic sees cloth contact and body-conducted noise strongly and the room weakly;
  the front mic sees the opposite. That asymmetry is the signal for both rustle
  rejection and own-voice detection, and it is free.
- **Both ports get acoustic mesh** (§4.8), and the rear port needs a recessed
  standoff so pressing against a shirt cannot seal it.
- **Neither port goes near the antenna keep-out corner or the speaker port.**
  Acoustic short-circuiting between the speaker and a mic port is the classic
  echo-cancellation nightmare, and the pendant has no room for a long path —
  budget for a real AEC and put the speaker port on the opposite face from the
  primary mic.

### 4.7 Attachment

A bail plus a chain, not a lanyard clip. Two reasons that are not aesthetic:
a fixed bail lets the antenna corner be *oriented* consistently (§4.5), and a
magnetic-clasp chain fails safe when snagged. Add a second attachment point so
the same body can hang from a chain or clip to a shirt placket in the orientation
the wearer prefers — the microphone ports and the antenna corner must be
specified against a known "up".

### 4.8 Ingress

**Target: IPX5 (jetting water), not IP67.** IPX5 covers sweat, rain, and a
handwash; IP67 means submersion, which for a device with two acoustic ports and a
speaker port is a materially different program (vented membranes rated for
immersion, sealed acoustic caps, pressure testing).

That target settles §8.7's "USB-C **or** magnetic pogo-pin": **magnetic pogo
pins.** A USB-C receptacle is an unsealed cavity with 24 contacts in the wall of
a device that lives against skin and sweat, and sealing one properly means a
gasketed door people will lose. Two or four exposed pogo contacts on the rear
face, gold-plated, with the charging puck holding them by magnet, is the standard
answer for a reason — and it also means the enclosure can be adhesive-bonded
rather than gasketed.

Acoustic ports need protective membranes over the mic and speaker holes
(GORE/Saati-class acoustic vents). Their insertion loss is small but real and
must be characterised, because it lands directly on top of the mic sensitivity
the STT depends on. **Vendor part numbers unverified — see §9.**

### 4.9 Serviceability

Be honest about the tradeoff: **an adhesive-bonded, pogo-charged pendant is not
field-serviceable.** The battery is the wear item and it is glued in. Options:

- **Bonded (recommended for EVT/DVT):** best sealing, thinnest, cheapest. Battery
  replacement is a factory operation.
- **Screwed rear cap with an O-ring:** serviceable, adds ~1 mm and a gasket
  groove, harder to keep at IPX5 across cycles.

There is no FOTA-over-USB fallback on a bonded device, which makes §8.9's FOTA
question a blocker rather than a nice-to-have: if a bad image bricks the pendant,
there is no cable to plug in. Bring out SWD to internal test pads and design the
bootloader to be recoverable over BLE before bonding anything shut.

---

## 5. Interaction model

### 5.1 What the agents actually asked for

Four agents, three of them independently, asked for on-device capture that
survives having no network. Their stated triggers are in the ledger and the
round files, and **they conflict**:

| Skill | Proposed by | Trigger it asked for |
|---|---|---|
| `offline_thought_capture` (`s10-d62e`) | mac-planner | "two taps within 500 ms, or a 700 ms squeeze/press; **a long press cancels**" |
| `offline_moment_bookmark` (`s10-l3xe`) | mac-planner | "Pendant button press" → timestamped bookmark + haptic/LED ack |
| `offline_voice_memo_store_and_forward` (`s12-egbt`) | relay-realtime | "button press while offline (or network error during capture)" |
| `offline_alert_inbox` (`s13-369p`) | browser-extension | "**long-press** ... plays/acknowledges the next item. **Do not change the current short press start / second press end conversation behavior.**" |

Long-press is claimed twice for different things, and two skills want the same
short press that the conversation loop already owns. This is not a detail to
paper over — it is the actual interaction design problem, and §5.3 resolves it.

### 5.2 The design constraint

The user is not looking at this device. Ever. Eyes-free input has a hard
ceiling on distinguishable gestures — roughly *one*, *two*, and *hold* are
reliable; three-in-a-row and timed multi-touch are not. The way to get more
than three commands without exceeding that ceiling is **escalating detents**:
a single hold that buzzes as it passes each threshold, so the user counts
buzzes with their fingers instead of counting taps against a clock.

Two acknowledgement events must be distinguishable, and no skill above
distinguishes them:

- **"I heard you"** — fires within 50 ms of gesture recognition.
- **"It is saved"** — fires only after the record is durably written to flash
  and fsync'd.

On a device whose entire value proposition is *the moment survives the link*,
conflating those two is the difference between a trustworthy object and a
lucky one.

### 5.3 Gesture vocabulary

Primary input is the capacitive squeeze pad. The IMU supplies two gestures the
pad cannot: a tap on the shell (works with gloves, works through a coat) and
palm-cover (large-area, unambiguous, instant).

| Gesture | Idle | While capturing / talking | Alerts pending |
|---|---|---|---|
| **Single squeeze** (< 400 ms) | Start a conversation turn — mic opens, end-of-utterance silence detection closes it, exactly as today | End the turn now | Play the next alert |
| **Double squeeze** (2 within 500 ms) | Local capture: record straight to flash, upload later. This is `offline_thought_capture` and `offline_voice_memo_store_and_forward` — same gesture, same record, they differ only in whether a link happened to exist | — | Mark played, advance |
| **Hold → detent 1** (~700 ms, one buzz) | Moment bookmark: timestamp + metadata, plus the last 5 s of ring audio if pre-roll is enabled (`offline_moment_bookmark`) | **Cancel and discard** | Dismiss all alerts |
| **Hold → detent 2** (~3 s, two buzzes) | Privacy mute toggle: mics hard-gated, indicator solid amber | Cancel + mute | — |
| **Hold → detent 3** (~10 s, three buzzes) | Force independent mode: bring up Tier 2 cellular, flush the outbox, power down | — | — |
| **IMU double-tap on the shell** | Silence whatever is buzzing / acknowledge | — | Snooze 10 min |
| **Palm cover ≥ 2 s** (pad full-area + IMU still) | Instant privacy mute | Instant mute, discard the in-flight capture | — |

How this resolves the conflicts:

- `offline_alert_inbox`'s "do not change short press" is honoured exactly — short
  squeeze still starts and ends a conversation turn.
- The two long-press claims are separated by **context**, not by timing:
  cancel only exists while something is capturing; alert playback only exists
  while something is queued. When neither is true, detent 1 is the bookmark.
- Alert playback moves off long-press onto the single squeeze *when alerts are
  pending*, because a pending alert has already announced itself (§5.4) and the
  user therefore knows which mode they are in. This is the one context-dependent
  meaning in the table and it is the piece most likely to need user testing.
  **Flag for owner sign-off.**

### 5.4 Haptic vocabulary

An LRA can encode more than a buzzer because amplitude and sharpness are
controllable, but only if patterns stay short — over ~400 ms the user stops
parsing and starts waiting. All of these fit in 400 ms.

| Pattern | Waveform | Means |
|---|---|---|
| `tick` | 1 × 20 ms sharp | Gesture recognised ("I heard you") |
| `double-tick` | 2 × 15 ms, 60 ms apart | **Durably written** ("it is saved") |
| `rise` | 3 pulses, increasing amplitude, 250 ms | Agent is answering / link is live |
| `fall` | 3 pulses, decreasing amplitude, 250 ms | Turn ended with no link — queued offline |
| `detent` | 1 × 40 ms at each hold threshold | You have passed detent N; release to take it |
| `alert` | 1 × 200 ms | Alert waiting |
| `alert-urgent` | 2 × 150 ms, 100 ms apart | Urgent alert waiting |
| `stutter` | 4 × 30 ms rapid | Refused: storage full, mic muted, or fault |

The rule: **`tick` on recognition, `double-tick` on durability, and never
`double-tick` speculatively.** If the flash write fails, the user gets
`stutter`, not silence.

### 5.5 The status light, and the one thing it must not be able to do

The proposal keeps "a small RGB status light" and makes haptics primary. Agreed
— the LED is off by default, because it costs power and it tells bystanders
things the wearer did not choose to tell them.

| Indication | Meaning |
|---|---|
| Breathing white | **Microphone is open** |
| Solid amber | Privacy mute |
| Single blue blink, every 10 s | Items queued offline |
| Double green blink | Outbox flushed |
| Solid red | Fault (see `stutter`) |
| Amber → green (charging) | Charging → charged |

**Hardware requirement, not a firmware convention:** the microphone indicator
must be electrically incapable of being dark while the mics are powered. Route
the mic supply through a load switch and drive the indicator from the *load
side* of that switch, with the MCU able only to increase its brightness, never
to extinguish it. A device you wear into other people's conversations must not
be able to lie about whether it is listening, and "the firmware promises" is not
an answer. This requirement appears nowhere in the proposal and should be added
to it.

---

## 6. Offline behaviour and storage

### 6.1 Retention arithmetic — where "2–4 GB" comes apart

Opus at the pendant's 16 kbps uplink rate is 2 kB/s, i.e. **7.2 MB per hour of
recorded audio**. With DTX enabled (it already is —
`OPUS_SET_DTX(1)` in `audio_opus.c:600`), silence is nearly free, so this is
hours of *speech*, not hours of wall clock.

**Serial flash is marketed in gigabits and ring buffers are sized in gigabytes.
1 Gbit = 128 MByte.** That factor of 8 is where this specification went wrong:

| Marketed density | Actual bytes | Hours of 16 kbps Opus | Days at 30 min/day captured |
|---|---|---:|---:|
| 1 Gbit | 128 MB | 17.8 | 36 |
| **2 Gbit** | **256 MB** | **35.6** | **71** |
| 4 Gbit | 512 MB | 71.1 | 142 |
| 8 Gbit | 1 GByte | 142 | 284 |
| 16 Gbit | 2 GByte | 284 | 569 |
| 32 Gbit | 4 GByte | 569 | 1138 |

The stated policy is "no raw audio retained after upload unless explicitly
pinned." Under that policy the flash holds only the current offline backlog plus
whatever is pinned. **A 2 GByte buffer under that policy needs a year and a half
of never once seeing a network to fill.** §8 records this as a defect.

There is also a hard availability ceiling the proposal could not have known
about: **the largest single-die serial NAND on the market is 8 Gbit = 1 GByte**
(Winbond W25N-LV/-MW/-LW families;
[Winbond QSPI NAND](https://www.winbond.com/hq/product/code-storage-flash/qspi-nand/?__locale=en)).
Macronix tops out at 4 Gbit. **A true 2–4 GByte is not reachable on one serial
flash die** — it needs 2–4 dies (4 × 8 × 6 mm WSON plus four chip selects, in a
32 mm puck) or eMMC. eMMC costs a 153-ball 9 × 7.5 mm BGA, a second 1.8 V VCCQ
rail, 85.7 mA read / 37.3 mA write, and **130 µA standby** — about 3.1 mAh/day,
over 1 % of the pack, doing nothing. Serial NAND standby is 10 µA (1 µA in deep
power-down).

**Specified: 256 MB (2 Gbit, W25N02KV-class) serial NAND**, on a footprint that
also takes the pin-compatible 4 Gbit W25N04KV, so the decision is reversible in a
rework rather than a respin.

### 6.2 The interface is SPIM, not QSPI — this changes the schematic

The nRF5340's QSPI peripheral uses **hardwired NOR-specific opcodes** and NCS
supports only NOR addressing. Nordic's own guidance for serial NAND is
*"you will be better off just using SPIM instead"*
([DevZone 60652](https://devzone.nordicsemi.com/f/nordic-q-a/60652/using-qspi-of-nrf5340-or-nrf52840-for-accessing-nand-flash),
[DevZone 63845](https://devzone.nordicsemi.com/f/nordic-q-a/63845/supported-nand-flash-for-qspi-and-fatfs),
[JBLopen](https://www.jblopen.com/nordic-spi-nand/)).
The "up to 48 MB/s EasyDMA" figure in the nRF5340 product spec is a NOR number
and does not apply.

Measured on an nRF5340 driving a Micron MT29F1G01 over SPIM at 32 MHz:
**2.2 MB/s write, 2.8 MB/s read.** The pendant needs 2 kB/s. That is roughly
**1000× headroom**, so losing QSPI costs nothing here — but the pin assignment,
the driver choice, and anyone's mental model of "QSPI flash" all have to change,
and it is much cheaper to know that before layout than after.

NAND also brings bad-block management, wear levelling, and ECC. Use a real flash
translation layer; do not hand-roll one over `flash_area` (§7.5 revises the
earlier estimate accordingly).

### 6.3 Flash layout

| Region | Size | Contents |
|---|---:|---|
| Event ring | 8 kB | 128 entries × 64 B: timestamp, type, flags, sequence, hash, status. Sized to `offline_moment_bookmark`'s own spec |
| Alert ring | 512 kB | 8 alerts × ≤ 30 s of 16 kbps Opus + metadata. Sized to `offline_alert_inbox`'s own spec |
| Audio ring | ~250 MB | Append-only, monotonic sequence, per-record header |
| Config / keys | 64 kB | Wrapped record keys, device identity, last-trusted-UTC |

### 6.4 Encryption, and what "not retained" has to mean on NAND

Per record: **AES-256-GCM**, nonce = device ID ‖ monotonic sequence, so any
record decrypts independently and a partial flush cannot poison the rest. The
device key lives in the nRF5340's **KMU**, where keys are physically isolated
from processor access and only CryptoCell-312 can use them
([Nordic](https://infocenter.nordicsemi.com/topic/ps_nrf5340/cryptocell.html));
the part is PSA Level 2 certified.

**NAND cannot overwrite in place, so "deleted after upload" cannot mean
deleted.** Implement it as *crypto-erase*: each record gets its own key, wrapped
by the KMU device key and stored in the record header. On upload acknowledgement,
erase the wrapped key. The ciphertext stays in the block until the ring wraps,
but it is unrecoverable from that moment. Anything short of this makes "no raw
audio retained after upload" false in the only sense that matters — the sense a
forensic examiner would test.

### 6.5 Eviction

The proposal does not say what happens when the ring fills with the link down
for a week. Specified: **evict oldest unpinned first; never evict pinned; on the
first eviction of a session, fire `stutter` and turn the indicator solid red.**
Silently dropping the user's oldest thought is the worst possible failure for
this product, and it must be loud.

### 6.6 Time

Carried forward from `docs/Pendant_Interaction_and_Firmware_Roadmap.md`, still
unsolved and now more important: **a bookmark with a wrong timestamp is worse
than no bookmark.** v2 has no cellular time source in Tier 0 and no GNSS.
Persist last-trusted-UTC plus monotonic uptime, stamp every record with an
explicit *uncertainty* field, and let the relay re-anchor the batch at flush
using the phone's clock and the intra-batch monotonic deltas. The pendant should
never present a time it cannot defend.

---

## 7. Firmware port impact

### 7.1 RAM

Today: **211,608 B budget, 95.79 % used, 8,908 B free [measured]**. Where it
goes (from `main.c` / `audio_opus.h`):

| Buffer | Bytes |
|---|---:|
| `opus_pseudostack` (NONTHREADSAFE_PSEUDOSTACK) | 28,704 |
| `mic_rx_storage` (10 × 640 × 4) | 25,600 |
| `convo_tx_slab` (10 × 2,560) | 25,600 |
| `dl_jitter` | 24,576 |
| `audio_workspace` (time-multiplexed 3 ways) | 24,576 |
| `opus_dec_arena` | 18,432 |
| `dl_decode_buf`, `mic_stage_samples`, `ws_rx_buf`, thread stacks | ~9,000 |
| **Audio subtotal** | **~156 kB** |

The nRF5340 application core has 512 kB. After TF-M, the BLE host, and the IPC
region shared with the network core, a realistic application budget is
**~400–430 kB** — call it 2× the total and 20–40× the free headroom. Concretely
that buys:

- **Delete the pseudostack hack.** `NONTHREADSAFE_PSEUDOSTACK` exists because
  8.9 kB of free RAM could not fund a real stack; it forces "only main thread may
  call opus_encode/decode" (`CMakeLists.txt:46-50`), which is *why* the audio
  thread was reduced to pointer-shuffling. Give the codec a thread with a 32 kB
  stack and libopus's `ALLOC()` goes back where it belongs.
- **Un-multiplex `audio_workspace`.** Today one 24 kB block is the encoder arena,
  the uplink FIFO, and the SD-fallback scratch, "never concurrently"
  (`audio_opus.h:16-21`). Give each its own allocation and delete the sequencing
  constraints that come with sharing.
- **Pin correctly.** Only the first 256 kB of nRF5340 RAM is single-cycle; the
  second block adds up to four cycles per access. DMA slabs and codec working
  buffers go in the fast block; outbox staging and the alert ring cache go in the
  slow one. This is a linker-script decision to make on day one.

### 7.2 The FPU question — wrong in both directions

This is the most common misconception about the port.

- **The nRF9160 already has an FPU.** This build simply does not turn it on:
  `CONFIG_CPU_HAS_FPU=y` alongside `# CONFIG_FPU is not set` in
  `firmware/nrf9160/build/zephyr/.config` **[measured]**. "Soft-float" here is a
  Kconfig state, not a silicon limitation, and moving to nRF5340 does not
  "gain" an FPU.
- **Enabling it would not speed up Opus anyway.** libopus is built
  `FIXED_POINT=1 -DDISABLE_FLOAT_API -DDISABLE_DEBUG_FLOAT` and deliberately uses
  the ARMv5E integer DSP paths (`OPUS_ARM_INLINE_EDSP`, `SMULWB`/`SMLABB`) that
  the M33's DSP extension provides — which the nRF9160 has too. SILK's
  fixed-point path is the fast path on Cortex-M; switching to the float build
  would be a regression.
- **What actually gets faster is the clock and the cache.** 64 → 128 MHz, plus an
  8 kB two-way I-cache the nRF9160 does not have. Measured today at complexity 0:
  the uplink encode costs ≈ 50 % of the 64 MHz core and the 24 kHz downlink
  decode ≈ 42 % more — **~92 % of one core combined**
  (`audio_opus.c:507-514` **[measured]**). At 128 MHz that is ~46 %.

That recovered ~46 % of a core is the whole point, and it has somewhere to go:
Opus complexity 3 (measured at 3.6 s of CPU for 2.8 s of audio at 64 MHz
**[measured]** — i.e. impossible today), the two-mic near-field DSP of §8.3, and
an on-device VAD so the mic can be open without the radio being awake.

### 7.3 What the second core buys, and what it does not

The network core runs the BLE controller. It is **not** a general-purpose second
CPU to move Opus onto — 64 kB of RAM, and NCS owns it. What it buys is
scheduling isolation, and that is worth more than it sounds here: today
`pendant_ws.c` runs on its own 2,560 B-stack thread *on the same CPU* purely
because "modem sends can stall for hundreds of ms on LTE" (`main.c:354-363`).
That stall class leaves the application core entirely. The 20.48 ms I2S deadline
that currently errors the whole duplex transfer on a single missed buffer stops
being a knife-edge at ~46 % core load instead of ~92 %.

### 7.4 Ports as-is

- **`audio_opus.c` in full** — Opus/Ogg logic is SoC-independent. The Ogg writer,
  the pre-skip/granule accounting, the live packet-sink path, the stream
  bitrate retarget.
- **`tx_resample_taps.h`** — the 125-phase × 12-tap Q14 polyphase interpolator.
  The tap table is regenerated by `scripts/gen_tx_taps.py` only if the I2S output
  rate changes; the FIR machinery itself is portable.
- **The mic front end in `main.c`** — DC blocker (`MIC_HPF_COEFF_Q15`), slew
  limiter, self-calibrating noise-floor silence detection, `VOICED_STAGES_REQUIRED`.
- **The wire format** — length-prefixed Opus packets. Only the transport beneath
  it changes; the Cloudflare Worker sees the same bytes.

### 7.5 Must be rewritten

- **The mic clock hack — deleted, not ported.** `mic_clock_pwm_arm()` drives two
  PWM instances through a DPPI channel to synthesise BCLK and LRCLK, because
  "the nRF9160 I2S peripheral cannot produce a 64-BCLK frame as master (its
  24-bit maximum word size yields 48 BCLK)" (`main.c:28-46`). The nRF5340's I2S
  supports separate sample and word widths with standard MCK ratios including
  64×, so I2S becomes a plain master. If v2 uses PDM mics (§2), it is better
  still: the nRF5340 PDM peripheral does left **and** right channels on one
  instance with EasyDMA straight to RAM
  ([Nordic PDM](https://infocenter.nordicsemi.com/topic/ps_nrf5340/pdm.html)) —
  two microphones, one peripheral, no clock synthesis at all. The
  `nrf_pwm`/`nrf_dppi`/`nrf_egu`/`nrfx_gppi` includes come out of `main.c`.
- **Everything LTE.** `nrf_modem_lib`, `lte_lc`, `CONFIG_NET_SOCKETS_OFFLOAD`,
  modem key management, `CONFIG_NRF_MODEM_LIB`. There is no offloaded socket on
  nRF5340; transport becomes GATT. `pendant_cloud.c` (72 kB of source) is the
  largest single casualty — its HTTP/TLS/chunked-upload machinery goes away, its
  framing survives.
- **Adaptive duplex ducking — deleted, not ported.** `CONVO_UPLINK_DUCK_BPS`,
  `CONVO_UPLINK_HOLD_BYTES`, `convo_dl_active_until`,
  `pendant_opus_stream_set_bitrate`. All of it exists because LTE-M Cat-M1 is
  half-duplex. **Keep the instrumentation** (`convo_uplink_drops`,
  `convo_encode_cycles`, `convo_max_loop_ms`) — it is how you find out whether
  BLE is really as clean as §1.3 claims.
- **Storage.** FATFS-on-SPI-microSD → serial NAND over **SPIM** (not QSPI — see
  §6.2) with a flash translation layer handling bad blocks, wear levelling and
  ECC. Zephyr's `nvs`/`zms` are record stores for settings, not a 250 MB
  append-only audio log; the §6.3 layout sits on top of an FTL, and the FTL
  should be an existing one rather than new code. **This is the largest new-code
  item in the port** and should be scheduled as its own milestone, not folded
  into "storage".
- **The button state machine** → the §5.3 gesture recogniser (squeeze pad + IMU
  + escalating detents) and the §5.4 haptic pattern engine.
- **Power management, which does not currently exist.** v1 is a DK on a bench
  with no PM policy at all. Every state in §3 needs a Zephyr PM policy, device
  runtime PM on the mics, flash, amp and cap controller, and — non-negotiably —
  measured validation on real hardware. Every runtime number in §3 is an estimate
  until that happens.

### 7.6 Suggested order

1. nRF5340 DK: I2S/PDM capture → Opus encode → Opus decode → I2S out, loopback,
   no radio. Re-measure the codec cost at 128 MHz and confirm the ~46 % figure.
2. GATT transport + a throwaway phone relay app. Prove 16 kbps up / 24 kbps down
   with a real iPhone, backgrounded, for an hour.
3. NAND-over-SPIM + FTL + the §6.3 record format + crypto-erase.
4. Gestures and haptics on a hand-wired pad.
5. Power states, then measure §3 and correct it.
6. Enclosure. **Not before this point.**

---

## 8. What the proposal gets wrong or leaves open

### 8.1 "an nRF5340-class dual-core SoC (1 MB RAM-class device)"

The nRF5340 has **512 kB of RAM on the application core** plus 64 kB on the
network core. 1 MB is the application core's **flash**. The decision survives —
512 kB is still 2.4× what the app gets today — but any RAM plan written against
"1 MB" is wrong by half, and `offline_thought_capture` already contains one:
its "under 96 kB incremental RAM" product target was sized against the wrong
number. It happens to still fit; that is luck, not planning.

### 8.2 "2–4 GB encrypted flash ring buffer"

Wrong three separate ways.

1. **Off by ~10× against its own policy.** Under "nothing retained after upload
   unless pinned", 2 GByte takes over 500 days of continuous offline operation to
   fill (§6.1).
2. **It is a gigabit/gigabyte confusion.** Serial NAND is sold as 1/2/4/8 **Gbit**;
   2 Gbit is 256 MByte, not 2 GByte.
3. **2–4 GByte is not purchasable on one serial flash die.** The largest is
   8 Gbit = 1 GByte. Hitting the stated number means four dies or eMMC, and eMMC's
   130 µA standby alone would eat over 1 % of the battery per day (§6.1).

Specified at 256 MByte with a 512 MByte drop-in — and note that even that is
sized for a *pathological* offline stretch, not a typical one.

**Related, and not the proposal's fault:** the word "QSPI" in
`offline_thought_capture`'s storage note does not work on this SoC. The nRF5340
QSPI peripheral is NOR-only; serial NAND has to hang off SPIM (§6.2). It is fast
enough — ~1000× the required rate — but it is a different schematic.

### 8.3 "Two digital MEMS microphones" — right part, wrong reason

The proposal's ledger note says the two mics are "for beamforming." They should
not be specified for beamforming, because at pendant scale beamforming barely
works:

- A 2-element array on a ≤ 32 mm puck gives at most ~25 mm of spacing. The
  literature on wearable arrays puts typical endfire spacing at 20 mm and notes
  that going to **30 mm** is what buys low-frequency directivity
  ([Design of Planar Differential Microphone Array Beampatterns, PMC10098815](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10098815/);
  [Beamforming with small-spacing microphone arrays, IEEE](https://ieeexplore.ieee.org/document/8984236/)).
  A pendant cannot offer 30 mm. Below ~500 Hz there is essentially nothing, and
  small-spacing arrays trade directivity factor against white-noise gain — the
  more directivity you ask for, the more you amplify the mics' own self-noise
  and any mismatch between them.
- The measured audio failures on this project were a **blocked acoustic port**, a
  **PDM/microSD SPI crosstalk comb**, and **supply noise**
  (`docs/Microphone_Noise_Debugging.md`). A second microphone fixes none of them.

Two mics are still the right call, for three reasons the proposal does not give:

1. **Near-field own-voice detection.** The wearer's mouth is ~25 cm away; the
   room is metres away. The inter-mic *level* difference is large for the wearer
   and near zero for everything else. That is a cheap, robust "is this my owner
   talking?" discriminator that works at low frequencies, where beamforming does
   not, and it is exactly what an always-listening pendant needs to avoid
   uploading other people's conversations.
2. **Rustle and handling-noise rejection.** Cloth contact noise is near-field on
   *one* mic and incoherent between the two. Coherence-based suppression is
   cheap and directly attacks the dominant real-world noise for a chest-worn
   device.
3. **Redundancy.** One acoustic port on a garment-worn device *will* fill with
   lint. Two ports on opposite faces means a clogged one is a degradation, not a
   dead device.

Budget the DSP for those three. Do not promise a beamformer.

### 8.4 The proposal silently deletes the speaker

It lists mics, IMU, LRA, touch pad, charge interface and RGB LED, and makes
haptics "the primary feedback" — with no audio output anywhere. But
`offline_alert_inbox` explicitly requires local playback ("long-press ... plays
the next alert **over the existing speaker**"), and the product is a voice agent.
The BOM keeps the amp and speaker. If the owner genuinely wants a silent
pendant, that removes a skill three agents' worth of design assumed, and it
should be an explicit decision rather than an omission.

### 8.5 Dropping to a BLE-only SoC drops Bluetooth Classic

The nRF5340 has no BR/EDR, so it cannot do A2DP. That is the entire reason
`firmware/esp32-airpods-bridge/` exists. §1.4 resolves it — agent audio reaches
the user's earbuds through the phone, which is already paired to them, and the
ESP32 disappears rather than needing a replacement — but this is a new hard
dependency on the companion app that the proposal did not price. In Tier 1
(no phone), audio output is the on-board speaker only.

### 8.6 The four offline skills contradict each other on gestures

Long-press is assigned to "cancel the current capture" by
`offline_thought_capture` and to "play the next alert" by `offline_alert_inbox`,
which also insists the existing short-press conversation behaviour must not
change while `offline_moment_bookmark` and `offline_voice_memo_store_and_forward`
both claim a plain button press. §5.3 resolves this with context plus escalating
detents, but the resolution makes single-squeeze mean "play alert" when alerts
are pending, which is the one genuinely ambiguous meaning in the design.
**Needs owner sign-off before firmware is written.**

### 8.7 "USB-C **or** magnetic pogo-pin" — the "or" is the specification gap

These are not interchangeable; they pick different ingress ratings, different
enclosure architectures, and different failure modes. §4 picks one and says why.

### 8.8 Capacitive touch and a metal enclosure are mutually exclusive

The proposal asks for a capacitive squeeze pad and (in the mechanical brief) a
jewellery-grade enclosure. A machined aluminium shell is a Faraday cage: it
blocks the capacitive field and detunes or shorts the 2.4 GHz antenna. §4 deals
with this properly; it cannot be deferred to industrial design.

### 8.9 Still open — must be decided before layout

| # | Open question | Why it blocks |
|---|---|---|
| 1 | **Wall-clock time.** No cellular, no GNSS in Tier 0. | A bookmark with a wrong timestamp is worse than none. §6.6 proposes trusted-UTC + uncertainty + relay re-anchoring; needs sign-off. |
| 2 | **FOTA.** v1 flashes over J-Link. | A worn device with no exposed port must have MCUboot dual-slot, signed images, a battery threshold and rollback — and on nRF5340 that means updating **two** cores. Affects flash partitioning, so it is a pre-layout decision. |
| 3 | **Always-listening or gesture-only?** | This single choice moves runtime by 2–3× (§3). It is a product decision, not an engineering one, and everything downstream of the battery depends on it. |
| 4 | **Mic privacy indicator as a hardware interlock** (§5.5). | Changes the power tree. Cheap now, a respin later. |
| 5 | **Who owns the companion app?** | Tier 0 makes it load-bearing. Nothing in the ledger assigns it to any agent or surface. |
| 6 | **Ring-full eviction policy** (§6.5). | Needs owner agreement on what may be dropped. |
| 7 | **Squeeze-sensing method** (§2.3). | Interlocked with the enclosure material. Cannot be deferred to industrial design. |

### 8.10 "Phone uplink" is not a thing iOS lets you do continuously

The proposal's phrase "a separate cellular/phone uplink only where needed" reads
as though the phone path is simply *there* whenever a phone is nearby. It is not.
iOS grants a backgrounded app **~10 seconds per BLE wake, ~30 s with a task
assertion**, and reclaims its sockets when suspended (§1.5). The only sanctioned
route to continuous residency is the `audio` background mode, which requires the
phone's own `AVAudioSession` to be genuinely involved — and using it for a custom
GATT stream is an App Store rejection risk, not a workaround.

So "phone uplink" splits into **session mode** (foreground / PushToTalk /
CallKit — real conversation) and **burst mode** (10–30 s of relay per wake —
store-and-forward only). The product has to be designed for both and has to tell
the user which one it is in. This is the largest single thing the proposal
assumes and does not have.

### 8.11 The proposal implies a continuity with v1 that does not exist

Three v1 parts are gone or unusable, and the ledger note reads as though this is
an incremental change:

- **SPH0645LM4H-B (the v1 microphone) is obsolete**, 0 stock. So is ICS-43434.
  The entire I2S digital-microphone category is collapsing — every active
  high-performance part found is **PDM**. Note that Knowles no longer makes these
  at all; the consumer MEMS microphone division was sold to **Syntiant** in
  December 2024, so SPH/SPK part numbers now ship under a different brand
  ([Knowles](https://investor.knowles.com/news/news-details/2024/Knowles-Corporation-Completes-the-Sale-of-Its-Consumer-MEMS-Microphone-Business-to-Syntiant/default.aspx)).
- **The v1 battery (500 mAh, 35 × 30 × 5 mm) physically cannot fit** a round
  pendant of the specified size (§4.3). A round cell is a semi-custom engagement.
- **The v1 speaker (PUI AS01808, 18 mm) does not fit** either.

None of these is an argument against v2. They are an argument that the BOM is
a new BOM, with new lead times, and should be scheduled as one.

### 8.12 nRF5340 may already be the wrong Nordic part

The proposal specifies "nRF5340-class", and §1.3 follows it. But the
**nRF54LM20A** matches its RAM, doubles its flash, is ~3× more CPU-efficient, and
costs a third as much (§1.3a). The nRF5340 is chosen here for dual-core
isolation, confirmed ISO/LE-Audio support, and NCS maturity — all three of which
are hedges against uncertainty rather than requirements. **Expect this decision
to be revisited at the EVT gate**, and write the firmware so revisiting it is
cheap.

---

## 9. Sources, and what is not verified

### 9.1 Measured on this project's own hardware

| Claim | Where |
|---|---|
| 95.79 % of 211,608 B RAM, 8,908 B free | build report |
| TLS over LTE-M 2.4 s typical / 9.9 s worst; button→dispatch 33.7 s | `docs/Latency_Cut_Plan.md` |
| Opus encode ≈ 50 % and 24 kHz decode ≈ 42 % of the 64 MHz core at complexity 0 | `firmware/nrf9160/src/audio_opus.c:507-514` |
| Complexity 3 encode: 3.6 s of CPU for 2.8 s of audio | `audio_opus.c:857-862` |
| Uplink ring 100 % full, `uplink_drops=388` on a 42 s LTE-M call | `main.c:271-310` |
| `CONFIG_CPU_HAS_FPU=y` with `# CONFIG_FPU is not set` | `firmware/nrf9160/build/zephyr/.config` |
| nRF9160 I2S cannot master a 64-BCLK frame; PWM+DPPI workaround | `main.c:28-46`, `mic_clock_pwm_arm()` |
| Mic failures were port blockage, PDM/SPI crosstalk, supply noise | `docs/Microphone_Noise_Debugging.md` |
| The four `offline_*` skill specifications | `diagnostics/harness-derivation/{mac-planner-round-19,mac-planner-round-20,relay-realtime-round-18,browser-extension-round-14}.md` |

### 9.2 Cited externally

Nordic: [nRF5340](https://www.nordicsemi.com/Products/nRF5340) ·
[nRF5340 PS v1.5](https://www.tme.eu/Document/3e794294564952202d03e12371eb0e0e/NRF5340-CLAA-R7-DTE.pdf) ·
[nRF5340 PB v2.2](https://www.nordicsemi.com/-/media/Software-and-other-downloads/Product-Briefs/nRF5340-SoC-PB.pdf) ·
[CryptoCell-312 / KMU](https://infocenter.nordicsemi.com/topic/ps_nrf5340/cryptocell.html) ·
[PDM peripheral](https://infocenter.nordicsemi.com/topic/ps_nrf5340/pdm.html) ·
[128 MHz idle current](https://devzone.nordicsemi.com/f/nordic-q-a/91130/current-consumption-difference---nrf5340-running-at-128mhz-vs-64mhz) ·
[QSPI does not support NAND](https://devzone.nordicsemi.com/f/nordic-q-a/60652/using-qspi-of-nrf5340-or-nrf52840-for-accessing-nand-flash) ·
[nRF9151](https://www.nordicsemi.com/Products/nRF9151) ·
[nRF9160→9151 migration](https://docs.nordicsemi.com/bundle/nwp_059/page/WP/nwp_059/intro.html) ·
[nRF54L15](https://www.nordicsemi.com/Products/nRF54L15) ·
[nRF54LM20A](https://www.nordicsemi.com/Products/nRF54LM20A) ·
[nPM1300](https://www.nordicsemi.com/Products/nPM1300) ·
[nPM1304](https://www.nordicsemi.com/Products/nPM1304) ·
[nPM1300/1304 FAQ](https://devzone.nordicsemi.com/nordic/nordic-blog/b/blog/posts/frequently-asked-questions-for-the-npm1300-and-npm1304)

Components: [T5838 datasheet](https://www.farnell.com/datasheets/4761948.pdf) ·
[T5838 @ Digi-Key](https://www.digikey.com/en/products/detail/tdk-invensense/MMICT5838-00-012/16903860) ·
[IM69D130](https://www.infineon.com/assets/row/public/documents/24/49/infineon-im69d130-datasheet-en.pdf) ·
[BMI270 datasheet r1.6](https://www.bosch-sensortec.com/media/boschsensortec/downloads/datasheets/bst-bmi270-ds000.pdf) ·
[W25N02KV](https://www.winbond.com/resource-files/W25N02KVxxIRU_Datasheet_20210625_G.pdf) ·
[W25N04KV](https://www.winbond.com/resource-files/W25N04KVxxIRU_Datasheet_20220207_RevC.pdf) ·
[Winbond QSPI NAND family](https://www.winbond.com/hq/product/code-storage-flash/qspi-nand/?__locale=en) ·
[Johanson 2450AT18A100](https://www.johansontechnology.com/datasheets/2450AT18A100/2450AT18A100.pdf)

BLE / iOS: [Punch Through throughput FAQ](https://punchthrough.com/ble-throughput-optimization-faq/) ·
[Punch Through connection interval](https://punchthrough.com/ble-connection-interval-throughput/) ·
[Apple TN3115 restoration rules](https://developer.apple.com/documentation/technotes/tn3115-bluetooth-state-restoration-app-relaunch-rules) ·
[Apple DTS on background BLE execution time](https://developer.apple.com/forums/thread/85066) ·
[Apple engineer on iOS 26 + AccessorySetupKit](https://developer.apple.com/forums/thread/806013) ·
[Apple engineer quoting ADG §55.6](https://developer.apple.com/forums/thread/822187) ·
[iOS 26 connection-interval oscillation](https://devzone.nordicsemi.com/f/nordic-q-a/124468/repeated-connection-interval-updates-on-ios-26) ·
[Cellular IoT latency measurements](https://monogoto.io/2022/12/22/the-true-speed-of-cellular-iot/)

Acoustics / mechanical: [Planar differential microphone arrays (PMC10098815)](https://www.ncbi.nlm.nih.gov/pmc/articles/PMC10098815/) ·
[Small-spacing array beamforming (IEEE 8984236)](https://ieeexplore.ieee.org/document/8984236/) ·
[Limitless Pendant FAQ](https://help.limitless.ai/en/articles/9124757-pendant-faq) ·
[Plaud NotePin](https://www.plaud.ai/products/plaud-notepin)

### 9.3 Explicitly NOT verified — close these before committing

The research session exhausted its web-search budget (200/200) before these
closed. Each is flagged in place in the text above.

| # | Open item | Blocks |
|---|---|---|
| 1 | **Cap-touch / squeeze sensor part selection** (§2.3) — no vendor part, price or current verified. Both the "no cap-touch peripheral on nRF5340" and "cap-touch doesn't work through aluminium" statements are engineering reasoning, not a cited source. | Schematic + enclosure material |
| 2 | **LRA and haptic driver availability.** `VLV101040A` and `DRV2605LDGSR` are carried from the v1 BOM with **no 2026 stock or price check**, and v1's own microphone turned out to be obsolete. | BOM |
| 3 | **RGB LED part**, forward current, and package. | BOM |
| 4 | **Speaker** — v1's does not fit; no replacement selected or characterised. The 20 mA figure in §3.1 is an estimate. | §3 C1, stack-up |
| 5 | **Magnetic pogo connector** part, current rating, ingress behaviour. | §4.8 |
| 6 | **Acoustic vent membranes** (GORE / Saati class) — no part numbers, no insertion-loss figures. Lands directly on mic sensitivity. | Acoustic design |
| 7 | **Round LiPo pricing, MOQ, certification, and real capacity.** Part-number-to-dimension mapping is inferred from naming convention. | Schedule, §3 |
| 8 | **nPM1304 VSYS / system discharge current limit** — verified for nPM1300 (1.0 A default) only. | Tier 2 TX bursts |
| 9 | **Dielectric constants and RF behaviour** of the candidate enclosure materials; antenna-in-metal app notes; how shipping products solve it. §4.4's ε_r values are order-of-magnitude engineering figures. | §4.4/4.5 |
| 10 | **Ambiq / SiLabs / TI SoC comparison** never completed. §1.2's dismissal rests on schedule, not on their specifications. | §1.3 confidence |
| 11 | **nRF54LM20A price tier and ISO/LE-Audio support.** The ~$3.36–3.59 figures have no stated quantity break. | §1.3a decision gate |
| 12 | **nRF9151 TX/RX current tables** — PSM/eDRX only. §3.2 state F assumes nRF9160-like figures. | Tier 2 budget |
| 13 | **Apple Accessory Design Guidelines §55.6** quoted second-hand via an Apple engineer's post; the PDF exceeded the fetch limit. | BLE parameter negotiation |
| 14 | **IP rating strategy** — no adhesive, gasket, or weld process selected or tested. | §4.8 |
| 15 | **nRF5340 module** part numbers, prices and stock (Fanstel / Ezurio / Raytac) as an EVT route around the 16-week aQFN lead. | EVT schedule |

# Hardware inventory vs ANCS (iPhone notifications over Bluetooth)

Source of truth: DigiKey invoices in `hardware/purchases/`.

## What you actually own

| Invoice | Part | Description | ANCS-relevant? |
|---------|------|-------------|----------------|
| **128558494** (2 Jul 2026) | `NRF9160-DK-ND` | **Nordic nRF9160 Development Kit** | **Yes (via onboard nRF52840)** |
| **128923808** (9 Jul 2026) | `1528-2181-ND` / Adafruit **3405** | **HUZZAH32 ESP32 Feather** | **Yes (ESP32 BLE)** |
| 128923808 | `1528-1462-ND` / Adafruit **254** | microSD breakout | Storage only |
| 128923808 | `1738-FIT0642-ND` | 64 GB microSD | Storage only |
| Adafruit webarchive (`innovoice.webarchive`) | mic breakout(s) | I2S/PDM mics used in bring-up | No radio |

## Can this kit receive iPhone notifications?

### Short answer

**Yes — with firmware work on a BLE SoC you already have on the table.**  
Not on the nRF9160 application core alone.

### nRF9160-DK (your main board)

| Silicon on the DK | Radio | Role today | ANCS? |
|-------------------|-------|------------|-------|
| **nRF9160** | LTE-M / NB-IoT / GPS | Pendant app (mic, Opus, cloud) | **No BLE** |
| **nRF52840** (onboard) | **Bluetooth LE 5** | Board controller / interface MCU; can be programmed for BLE apps | **Yes — Nordic ships ANCS client samples** |

Nordic documents the DK’s nRF52840 as a full BLE-capable MCU. ANCS client path:

- Service UUID `7905F431-B5CE-4E99-A40F-4B1E122D00D0`
- NCS sample: `samples/bluetooth/peripheral_ancs_client` (and client APIs `CONFIG_BT_ANCS_CLIENT`)
- Requires **one-time BLE bond** with the iPhone (Settings → Bluetooth)

**Catch:** the 52840 on the DK is currently the *board controller*, not running your pendant app. Using it for ANCS means either:

1. **Dual-firmware design** — 52840 runs ANCS client, forwards notification text to nRF9160 over the DK’s inter-MCU UART/SPI link; or  
2. **Prototype-only** — temporarily re-purpose the 52840 for ANCS bring-up while the 9160 still owns LTE.

Both are valid on **this exact DigiKey DK**. No new Nordic radio is required for a lab prototype.

### HUZZAH32 ESP32 Feather (already purchased)

| Feature | Support |
|---------|---------|
| BLE GATT client | Yes (Bluedroid / NimBLE) |
| Bluetooth Classic A2DP | Yes (you already use it for speaker output) |
| ANCS client | **Feasible in software** (not shipped in Adafruit stock sketches; you implement GATT client + bond) |

So the ESP32 can also host ANCS **or** keep doing A2DP speaker duty. Doing **both Classic A2DP + BLE ANCS at once** is possible on ESP32 but fiddly; many designs pick one primary role.

### What does *not* give you ANCS

- Pairing only the **Capacitor iOS app** over some generic BLE characteristic  
- LTE alone  
- microSD / mic breakouts  

ANCS is specifically the phone’s Notification Center talking to a **bonded BLE accessory**.

## Recommended path for *your* purchases

1. **Prototype ANCS on the DK’s nRF52840** (Nordic sample → UART notify → nRF9160 printk / cloud event).  
2. Keep **ESP32** on A2DP speaker output (current design).  
3. Production board: put a dedicated nRF52840/nRF53 next to nRF9160 (or Icarus + BLE companion), same software split.

## Alternatives without pendant BLE

If you skip board ANCS for now:

- **Mac bridge** can still act on phone traffic that lands on the Mac (iPhone Mirroring notification store, Mail/Messages on Mac, etc.) — see `docs/Apple_Max_Capability.md`.  
- That needs the Mac online; ANCS on the pendant works with the Mac asleep.

## Bottom line

| Question | Answer for your invoices |
|----------|---------------------------|
| Do I already own BLE silicon? | **Yes — nRF52840 on the nRF9160-DK, and ESP32 on the Feather** |
| Can the nRF9160 app core do ANCS alone? | **No** |
| Can I prototype iPhone notification read without buying more chips? | **Yes** |
| Effort | New dual-MCU firmware path + iPhone Bluetooth bond; not a one-line config |

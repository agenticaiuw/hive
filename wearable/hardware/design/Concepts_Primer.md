# Electronics concepts primer (for the Agentic Gadget)

Plain-language answers to the "what does this even mean" questions, using your own parts as examples. Acronyms are expanded the first time they appear.

---

## Acronyms — how to actually learn them

Don't memorize a list. Learn each acronym **the first time you need it, in context**, expand it once, use it, and add it to your own glossary. They stick because they're attached to a real decision you made. Glossary:

| Acronym | Expansion | One-line meaning |
|---------|-----------|------------------|
| IC | Integrated Circuit | a chip |
| MCU | Microcontroller Unit | the processor that runs your code |
| SoM | System on Module | a mini-board you treat as one big part (your Icarus) |
| GPIO | General-Purpose Input/Output | a software-controlled 0/1 pin |
| LDO | Low-Dropout regulator | makes a lower, steady voltage from a higher one |
| I²C | Inter-Integrated Circuit | 2-wire control bus |
| I²S | Inter-IC Sound | digital audio bus (NOT I²C) |
| PDM | Pulse-Density Modulation | 1-bit digital mic format |
| PCM | Pulse-Code Modulation | audio as a stream of numbers |
| SPI | Serial Peripheral Interface | fast 4-wire bus |
| UART | Universal Asynchronous Receiver/Transmitter | simple 2-wire serial |
| USB | Universal Serial Bus | power + data |
| LRA / ERM | Linear Resonant Actuator / Eccentric Rotating Mass | precise vs cheap vibration motor |
| VIH / VIL | Voltage Input High / Low | logic thresholds |
| VOH / VOL | Voltage Output High / Low | what a driver actually outputs |
| PSM / eDRX | Power Saving Mode / extended Discontinuous Reception | cellular sleep modes |
| DFM | Design for Manufacturing | designing so it can actually be built |
| BOM | Bill of Materials | the parts list |
| DRC / ERC | Design / Electrical Rule Check | KiCad's automated checks |

---

## Rail vs bus — yes, you've got it

- **Rail** = a **power** net: a wire/copper-pour that distributes one voltage everywhere (3V3, VBAT, GND). Everything "taps the rail."
- **Bus** = a shared set of **data** wires that multiple chips talk over (the I²C bus = SDA + SCL; the I²S bus). 

So rails carry power, buses carry data. (GND is technically a rail *and* the 0 V reference that every signal is measured against.)

---

## Logic thresholds

Digital signals are really just voltages, but a chip treats a **range** as "1" and another range as "0," with a forbidden gap between.

- Per **receiver**: **VIH** = the lowest voltage it will accept as HIGH (1); **VIL** = the highest it accepts as LOW (0).
- Per **driver**: **VOH** = the voltage it outputs for HIGH; **VOL** for LOW.
- A link works only if **driver VOH ≥ receiver VIH** and **driver VOL ≤ receiver VIL**.

Thresholds scale with a chip's supply. A 3.3 V chip's VIH is roughly **2.0–2.31 V**; a 1.8 V chip can only output up to **1.8 V**. So a 1.8 V "HIGH" into a 3.3 V input that needs ≥ 2.31 V is read as undefined/LOW → it fails. That is exactly the T5837 mic situation, which is why the design adds a level shifter. And the reverse matters too: a 3.3 V HIGH into a 1.8 V chip can exceed its **absolute-max** and damage it.

---

## The communication protocols (how each works)

**I²C — Inter-Integrated Circuit** (slow control bus)
- 2 shared wires: **SDA** (data) + **SCL** (clock), each with one **pull-up resistor** to the rail. The lines are "open-drain": chips only pull them LOW; the resistor pulls them HIGH.
- One master (your MCU) addresses many slaves, each with a unique 7-bit address (DRV2605L = 0x5A, onboard accel = 0x19 → no clash).
- ~100–400 kHz. Perfect for config + sensors. Gotcha: needs exactly one pair of pull-ups per bus.

**I²S — Inter-IC Sound** (digital audio — different from I²C!)
- ~3 wires: **BCLK** (bit clock), **LRCLK/WS** (word/left-right select), **SD** (the audio data). The MCU is the clock master.
- It's a continuous stream of audio samples, one direction (out to your amp; in from a mic if it were an I²S mic). Gotcha: clocks must equal sample-rate × bits × channels.

**PDM — Pulse-Density Modulation** (1-bit mic output)
- 2 wires: **CLK** (MCU clocks the mic) and **DATA** (a fast 1-bit stream whose *density of 1s* encodes the sound wave). The MCU's PDM peripheral filters ("decimates") it into normal PCM.
- Yes — "pulse **density**," a cousin of PWM's "pulse **width**." Used by tiny MEMS mics because it's only 2 wires, no codec. Gotcha: the L/R select pin picks which clock edge the mic speaks on.

**SPI — Serial Peripheral Interface** (fast bus)
- 4 wires: **SCLK**, **MOSI** (master out), **MISO** (master in), **CS** (chip-select, one per device). Tens of MHz. Used for flash, displays. Gotcha: a CS line per chip, no addressing.

**UART — Universal Asynchronous Receiver/Transmitter** (simple serial)
- 2 wires: **TX** and **RX**, crossed between the two chips. No shared clock — both sides agree on a **baud rate**. Used for debug consoles, GPS, modems. Gotcha: matching baud rate.

**USB — Universal Serial Bus** (you use it just to charge)
- For charge-only you need **VBUS** (5 V) + **GND**, plus two **CC** (Configuration Channel) pins with **5.1 kΩ** pull-downs that tell the charger "I'm a device, send power." The D+/D− data pair you can ignore.

---

## GPIO — General-Purpose Input/Output

A pin your software controls. As an **output** you set it 0 or 1 (drive LOW/HIGH) — to light an LED, enable a chip. As an **input** you read whether it's 0 or 1 — to sense a button. Most GPIOs can also be **muxed** (re-purposed) into a peripheral — "this pin becomes I²C SDA, that one becomes I²S BCLK" — which is exactly how the Icarus pins get assigned. Handy extras: built-in **pull-up/pull-down** resistors (so a button needs no external resistor) and **interrupts** (wake the CPU when the pin changes).

---

## DFM — Design for Manufacturing

Designing the board so it can be built cheaply and reliably, not just so it works on paper. Concretely: pick parts that are **in stock** and **solderable**; respect your fab's **minimum trace width/spacing**; leave clearance for the **stencil** and **pick-and-place**; keep parts away from the board edge; use common footprints; add **fiducials** and **test points**. Thinking about DFM early is what prevents "it works but nobody can build it" redesigns.

---

## Do you need all of this before you start?

No — learn it **just in time**, anchored to a real decision. You already used logic thresholds (the mic), rails vs buses (the power plan), and three protocols (I²S, PDM, I²C) just by designing this one device. That's how the knowledge actually sticks.

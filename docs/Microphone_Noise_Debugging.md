# PDM microphone noise diagnosis

## Confirmed hardware

- Nordic nRF9160 DK (PCA10090)
- Adafruit PDM MEMS Microphone Breakout, product 3492
- The microphone IC documented by Adafruit is the ST MP34DT01-M
- Adafruit microSD breakout, product 254

## Corrected microphone wiring

| Microphone | nRF9160 DK | Reason |
|---|---|---|
| `3V` | `VDD` with SW9 at `3 V` | The breakout must use a quiet 1.8-3.3 V supply |
| `GND` | `GND` | Common power and signal reference |
| `SEL` | `GND` | Selects the data-valid-low/rising-sample channel |
| `CLK` | `A2 / P0.16` | Unshared GPIO; firmware generates 1.032 MHz |
| `DAT` | `P0.20` | Unshared through-hole GPIO |

The old `P0.30/P0.31` pair is unsafe for this test. Nordic documents those
pins as the SDA/SCL connection for the DK's optional PCAL6408A I/O expander.
The microSD pins `P0.11/P0.12/P0.13` can also be switched to the DK's external
flash, so microphone jumpers must be kept away from the D10-D13 SPI bundle.

## Why the previous capture sounded like an electrical whistle

The saved PCM is structurally valid, but contains a stationary harmonic comb
instead of speech. That places the failure before speech recognition. The
latest electrically isolated capture contains a startup decay and then no
speech-shaped energy, even though the user spoke during the 1.8-second window.

Changing the PDM clock from 1.28 MHz / ratio 80 to the nRF9160's 1.032 MHz /
ratio 64 mode did not remove the comb. Its apparent 800 Hz line moved only by
the WAV sample-rate labelling error expected from the 1.032 MHz divider. The
interference is therefore fixed in real time rather than derived from PDM CLK.
The most likely causes, in order, are:

1. **Periodic microSD/LTE/ESP32 interference.** The former capture loop wrote
   one 1,600-byte block to microSD every 50 ms while LTE and the ESP32
   Bluetooth radio remained active. The recorded lines are harmonics of a
   fixed periodic source, which is consistent with digital or supply-current
   bursts entering the weak PDM path.
2. **Breadboard signal integrity.** PDM is a 1-3.25 MHz digital interface.
   Long parallel CLK/DAT jumpers, or running them beside microSD SPI, can cause
   ringing, double-clocking, and crosstalk that decodes as hiss or a tone.
   Nordic recommends 20-100 ohm series damping for long/noisy PDM lines, with
   the CLK resistor at the nRF source and DATA resistor at the microphone
   source.
3. **Power integrity.** ST requires local 100 nF and 10 uF decoupling near the
   microphone IC. The Adafruit breakout includes local components, but the
   supply and ground jumpers must still be short and secure.
4. **Acoustic port obstruction.** The microphone is top-ported. Comparing the
   official Adafruit board photo with the prototype photo shows the gray/purple
   ribbon directly across the silver microphone can and its central black
   acoustic inlet. This explains why speech is absent, although it cannot create
   a stable harmonic comb by itself.
5. **Damaged MEMS acoustic element.** This remains possible if speech is still
   absent after the port is completely exposed.

The sampling edge and pins have already been checked:

- `SEL` low requires rising-edge sampling; the live nRF `MODE` register is
  mono + `LEFT-RISING`.
- The live pin-select registers are CLK `P0.16` and DIN `P0.20`.
- The live PDM clock register is 1.032 MHz / ratio 64 with HFXO selected.
- J-Link measures the DK target rail at 3.300 V.
- A live electrical pull test proves DAT is not open: 2,048 low-phase samples
  produced 996 ones with no pull, 998 with pull-up, and 999 with pull-down,
  with about 1,450 transitions in every case. The microphone's digital
  modulator is actively driving P0.20; a wrong header pin or broken DAT jumper
  would instead follow the weak pulls.

## Firmware corrections

- PDM CLK moved to P0.16 and DAT moved to P0.20.
- The mono sampling edge changed to rising for the grounded `SEL` connection.
- PDM clock uses the nRF9160's supported 1.032 MHz / ratio-64 mode.
- LTE RF is deactivated before PDM starts and reattached after capture.
- The first 1.8 seconds are buffered in nRF RAM. Short voice commands therefore
  cause no microSD writes while PDM is active; longer recordings write in
  1.8-second batches instead of every 50 ms.
- Raw WAV capture remains enabled so every test can be compared locally
  without depending on cloud transcription.

## Decisive hardware A/B test

1. First test the flashed quiet-capture firmware without changing wiring.
2. If the comb remains, unplug the ESP32 USB and all three nRF-to-ESP32 I2S
   wires. For the subsequent no-microSD test, first flash the dedicated
   RAM/USB diagnostic build; the normal cloud build requires the card.
3. Move the microphone beside the nRF header. Use wires shorter than 5 cm,
   route CLK with a ground return and DAT with another ground return, and move
   the ribbon completely off the acoustic port.
4. Add 33-68 ohms in series with CLK at the nRF end.
5. Verify continuity with power off: mic 3V to DK VDD, GND to GND, SEL to GND,
   CLK to A2/P0.16, and DAT to the exact P0.20 header position.
6. If the same comb remains with short isolated wiring, put a second Adafruit
   #3492 breakout on those exact four connections. A clean replacement proves
   the original breakout is defective; the same failure on both boards proves
   the fault is upstream.

## Sources

- Nordic nRF9160 DK Hardware, GPIO interfaces and board-control routing:
  https://docs.nordicsemi.com/r/bundle/ug_nrf9160_dk/page/ug/nrf91_dk/hw_description/if_connector.html
- Nordic nRF9160 Product Specification, PDM peripheral:
  https://docs-be.nordicsemi.com/bundle/nRF9160_PS_v1.1/raw/resource/enus/nRF9160_PS_v1.1.pdf
- Adafruit PDM microphone guide:
  https://learn.adafruit.com/adafruit-pdm-microphone-breakout
- ST MP34DT01-M datasheet:
  https://cdn-learn.adafruit.com/assets/assets/000/049/977/original/MP34DT01-M.pdf
- Infineon digital microphone interface guidance:
  https://community.infineon.com/t5/Knowledge-Base-Articles/Electrical-interface-of-MEMS-microphone-introduction/ta-p/453658
- Nordic support on PDM line damping:
  https://devzone.nordicsemi.com/f/nordic-q-a/13915/pdm-microphone-02730a0019-or-aku242-electrical-connection-to-nrf52832
- Analog Devices AN-1323 on source termination for PDM CLK:
  https://www.analog.com/en/resources/app-notes/an-1323.html

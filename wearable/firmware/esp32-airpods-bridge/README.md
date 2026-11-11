# HUZZAH32 AirPods bridge

Firmware for the original Adafruit Feather HUZZAH32 (#3405). It receives the
nRF9160's duplex I2S TX wire — 31,250 frames/s in 32-bit slots, the mono
sample in the top 16 bits of each 24-bit left-slot word — and resamples it
to the 44.1 kHz stereo PCM expected by a Bluetooth Classic A2DP receiver.
The stream contains only the agent's synthesized reply; microphone
recordings go to the cloud and are not locally looped back to Bluetooth.

## Wiring

The MAX98357 is not used. Connect the nRF's dedicated reply-audio I2S pins
directly to the ESP32:

| nRF9160 signal | HUZZAH32 silkscreen | ESP GPIO |
| --- | --- | --- |
| A3 / P0.17 / LRC | 33 | GPIO33 |
| A4 / P0.18 / BCLK | 27 | GPIO27 |
| A5 / P0.19 / DATA | 14 | GPIO14 |
| GND | GND | GND |

Power the HUZZAH32 from its own USB cable. Do not join the boards' 5 V or 3.3 V
power pins. The shared ground is required.

## Build and upload

From this directory:

```sh
.venv/bin/pio run
.venv/bin/pio run --target upload
.venv/bin/pio device monitor
```

The upload command requires the HUZZAH32 to be connected to the Mac with a
data-capable micro-USB cable.

## Configure the Bluetooth target

Open the USB serial console with `.venv/bin/pio device monitor` (115200)
and send JSON lines:

```json
{"command":"scan"}
{"command":"connect","target":"..."}
```

`scan` lists nearby devices; `connect` remembers the chosen speaker or
earbuds by name. Put the device into pairing mode before connecting.

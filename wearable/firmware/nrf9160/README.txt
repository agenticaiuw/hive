Agentic pendant firmware for the nRF9160 DK

Audio path
----------

Primary path — full-duplex conversation over one WebSocket:

1. While idle, firmware holds a single authenticated WebSocket open to the
   relay (idle pings defeat Cloudflare's ~100 s kill), so Button 1 never
   waits on TLS.
2. Button 1 starts a conversation on the active edge: the microphone
   records immediately and streams up as ~16 kbps Opus (SILK-WB, 20 ms
   frames) over that WebSocket while the user is still speaking.
3. The agent's spoken reply streams DOWN the same socket as 24 kHz Opus
   packets and plays out over I2S to the ESP32 while capture continues —
   the model decides when to talk, and barge-in is server-side.
4. The conversation ends on the second button press, a relay 'end'
   (mutual silence), transport death, or the 300 s cap.

Fallback — record-then-upload, only when the WebSocket is down at press:

5. The press records with a microSD journal; PCM streams to the relay as
   a live chunked HTTP upload when the prewarmed socket allows, otherwise
   a single-shot SD upload runs after stop (second press, ≥1 s, 30 s cap).
6. The relay transcribes and dispatches the command to the Mac agent as
   usual, but the reply is NOT voiced on the pendant (the ESP32 bridge
   speaks the duplex wire format now); transcript and reply audio land in
   the dashboard. If both uplinks fail, the recording is queued in the SD
   outbox and delivered when the link returns.

The modem RF stays up during capture so bits can leave the device while the
user is still speaking. Full-file FAT preallocation and RF suspend/resume
were removed from the voice path to cut multi-second start delays.

LED diagnostics:

  two 160 ms flashes once       microSD passed its boot test
  solid during boot             LTE registration is in progress
  off after boot                ready for the first button press
  toggles every 250 ms          conversation/recording live (solid while
                                agent audio is buffered)
  continuous rapid 100 ms blink fatal boot error (usually SD or LTE)
  1 short flash                 moment bookmark stored (button 2)
  2 finite flashes              held item: voice memo queued for later
                                delivery, or held alerts surfaced
  3 finite flashes              recording failure
  4 finite flashes              conversation failed
  5 finite flashes              fallback upload/transcription/dispatch failure
  3 slow 180 ms flashes         fallback cycle delivered (reply in dashboard)

If the two boot flashes repeat from the beginning, the board is resetting.
On battery this usually means the supply is sagging during an LTE current
burst. A rapid blink that never restarts is show_error(): opening the enclosure
most often disturbed the microSD power or SPI wiring.

Wiring
------

Adafruit SPH0645LM4H I2S microphone #3421 (replaces the PDM mic #3492;
that mic's capture path was removed -- restore from
tmp/backup-2026-08-02-pre-i2s-mic/ if it is ever needed again):

  3V   -> nRF VDD (SW9 set to 3 V; the breakout is a bare 1.6-3.6 V part)
  GND  -> nRF GND
  SEL  -> nRF GND (mic drives the left slot while LRCLK is low)
  BCLK -> nRF A4 / P0.18 (the existing I2S bit-clock net, shared with ESP32)
  LRCL -> nRF A3 / P0.17 (the existing I2S word-clock net, shared with ESP32)
  DOUT -> nRF P0.20 (dedicated through-hole header position, now I2S SDIN)

Two extra jumpers are REQUIRED on the breadboard:

  A2 / P0.16 -> A4 / P0.18   (PWM-generated 2.000 MHz BCLK feeds the bus)
  A0 / P0.14 -> A3 / P0.17   (PWM-generated 31.25 kHz LRCLK feeds the bus)

Why: the SPH0645 requires exactly 64 BCLK per stereo frame, which the
nRF9160 I2S peripheral cannot generate as master (24-bit max word size =
48 BCLK).  While recording, the firmware therefore runs I2S in slave mode
and produces both clocks with PWM1/PWM2, phase-locked through DPPI.  While
playing the agent reply, PWM pins go high-impedance and the I2S peripheral
drives the same P0.17/P0.18 nets as master at 24 kHz, exactly as before.

Optional but recommended by Knowles: a 100k resistor from DOUT to GND so
the data net does not float while the mic tri-states the right slot.
Keep the mic leads short and away from the D10-D13 microSD wires.  Capture
is 24-bit left-slot at 31,250 Hz, averaged in pairs to a 15,625 Hz mono
16-bit upload with a DC-blocking filter and 4x (+12 dB) digital gain.
Audio streams to the microSD card in 1 KiB chunks while recording (the SD
activity LED flickers during capture); recordings can run up to 30 s and
stop on the second button press after at least one second.

Adafruit microSD breakout #254:

  3V  -> nRF VDD (required for battery operation; the DK 5 V rail is absent)
  GND -> nRF GND
  CLK -> nRF D13 / P0.13
  DO  -> nRF D12 / P0.12
  DI  -> nRF D11 / P0.11
  CS  -> nRF D10 / P0.10

ESP32 Bluetooth bridge:

  nRF A3 / P0.17 (LRC)  -> ESP32 GPIO33
  nRF A4 / P0.18 (BCLK) -> ESP32 GPIO27
  nRF A5 / P0.19 (DATA) -> ESP32 GPIO14
  nRF GND               -> ESP32 GND

The nRF and ESP32 are powered separately. Do not connect their 5 V or 3.3 V
rails together. The former A0/A1/A2 audio wiring and the MAX98357 are unused.

Opus implementation
-------------------

The firmware builds Xiph.Org libopus 1.6.1 (fixed-point API only) from a
west-managed checkout at third_party/opus. The checkout is NOT committed to
this repo: the pin (exact upstream commit of the v1.6.1 tag) lives in
west.yml, and the tree it fetches is byte-identical to the previously
vendored source. One-time setup after a fresh clone:

  source firmware/nrf9160/scripts/env.sh
  env -u ZEPHYR_BASE west init -l firmware/nrf9160   # creates firmware/.west
  cd firmware/nrf9160 && env -u ZEPHYR_BASE west update

`env -u ZEPHYR_BASE` matters: env.sh points ZEPHYR_BASE at the NCS install,
and west would otherwise resolve THAT workspace and try to update all of
NCS. Run `west update` from inside firmware/ for the same reason. Builds
are unaffected — they still run from the NCS directory exactly as below.

CMakeLists.txt consumes the checkout through the upstream source manifests
(cmake/OpusFunctions.cmake + *_sources.mk), so none of opus's own build
system runs. Encoder/decoder state and Ogg payload use a dedicated 30 KiB
workspace. Temporary SILK/CELT allocations use a separate 28 KiB
NONTHREADSAFE_PSEUDOSTACK protected by a canary and reported high-water
scan. The microphone has its own RX slab so a bounded live-codec stall does
not overwrite or alias capture buffers. The nrf9160/ns build currently uses
394,592 B of 576 KiB application flash and 203,364 B of the 211,608 B
application RAM region.

Main stack sizing (do not shrink without measuring)
---------------------------------------------------

CONFIG_MAIN_STACK_SIZE is 10240. libopus is compiled with
NONTHREADSAFE_PSEUDOSTACK, not VAR_ARRAYS, so codec ALLOC() scratch does not
consume the calling thread's C stack. GLOBAL_STACK_SIZE in CMakeLists.txt must
exactly match PENDANT_OPUS_SCRATCH_BYTES in src/audio_opus.h.

Do not shrink either allocation from a quiet-room measurement. Pitch analysis
takes its deepest path on voiced input. Every completed live encode, offline
encode, and reply decode reports codec scratch touched/capacity/guard state;
main also reports its Zephyr stack high-water mark. CONFIG_INIT_STACKS,
CONFIG_HW_STACK_PROTECTION, and CONFIG_BUILTIN_STACK_GUARD remain enabled so
these measurements and faults stay actionable.

The live encoder is optional acceleration, never the source of truth. Its feed
calls are bounded and timed. If cumulative codec time falls more than two mic
RX blocks behind represented audio, firmware closes the partial Ogg file and
continues PCM-only; the normal post-release path then performs offline encoding.

Build and flash
---------------

NCS v3.4.0 is installed at /opt/nordic/ncs (toolchain hash ccc010f809). west
and nrfutil are not on the default PATH until you source the env script.
On a fresh clone, fetch the opus checkout first (see "Opus implementation"):

  source scripts/env.sh
  scripts/flash.sh --check          # tools + J-Link SN 960036581, no program
  scripts/flash.sh                  # west flash --runner nrfutil --dev-id 960036581

Build example (from /opt/nordic/ncs/v3.4.0 after sourcing env.sh):

  west build -b nrf9160dk/nrf9160/ns \
    -d $PWD/build-cloud $PWD \
    -- -DEXTRA_CONF_FILE=$PWD/secrets.conf

Sysbuild output image: build-cloud/nrf9160/zephyr/tfm_merged.hex
Alternate runner: scripts/flash.sh --runner jlink
nrfjprog is not required (and is not installed); nrfutil + JLinkExe are.

UART diagnostics
----------------

The current build uses the 115200-baud UART console and has no SEGGER RTT
control block. Run scripts/auto_capture_diag.sh to resolve the Nordic DK console
port and append output to diagnostics/pendant-uart.log. Override auto-detection
with PENDANT_UART_PORT and the log path with PENDANT_UART_LOG.

For an acoustic end-to-end diagnostic, set PENDANT_UART_TRIGGER_AUDIO to a WAV
file. The capture script plays it once when the UART reaches the configurable
PENDANT_UART_TRIGGER_MARKER (default: "I2S mic preallocated").

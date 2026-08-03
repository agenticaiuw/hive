Agentic pendant firmware for the nRF9160 DK

Audio path
----------

1. While idle, firmware prewarms TLS + HTTP chunked headers to the relay so
   Button 1 never waits on a handshake.
2. Button 1 starts a microphone recording immediately (LED blinks on press;
   no release wait).
3. Button 1 stops the recording (after ≥1 s); LED1 turns off.
4. During capture, raw 15,625 Hz mono s16le PCM is written to microSD and
   pushed into a RAM ring. Between I2S DMA blocks, a few milliseconds of
   non-blocking LTE sends drain the ring as HTTP/1.1 chunked body. If the
   radio falls behind, the stream aborts and a full SD upload runs after stop.
4. The relay wraps PCM as WAV for STT/multimodal plan and dispatches the
   command to the Mac agent.
5. The Mac synthesizes the agent's response, encodes it as 24 kHz Ogg Opus,
   and returns it through the relay. The nRF9160 decodes it to signed
   16-bit mono PCM on the microSD card.
6. Repeating pairs of short LED flashes mean the response is ready; they
   continue until the playback press so the indication cannot be missed.
7. Button 1 sends the response over I2S to the ESP32; LED1 remains solid while
   it plays. The ESP32 is responsible for Bluetooth A2DP output.

Production recordings stop on the second button press, with a 30-second safety
limit. A successful microSD write is still kept as a local backup; the live
stream is preferred for latency.

The modem RF stays up during capture so bits can leave the device while the
user is still speaking. Full-file FAT preallocation and RF suspend/resume
were removed from the voice path to cut multi-second start delays.

LED diagnostics:

  two 160 ms flashes once       microSD passed its boot test
  solid during boot             LTE registration is in progress
  off after boot                ready for the first button press
  toggles every 250 ms          recording
  continuous rapid 100 ms blink fatal boot error (usually SD or LTE)
  3 finite flashes              recording failure
  4 finite flashes              Opus recording encode failure
  5 finite flashes              upload/transcription/dispatch failure
  7 finite flashes              reply download failure
  8 finite flashes              Opus reply decode failure
  9 finite flashes              I2S playback failure

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

The firmware vendors Xiph.Org libopus 1.6.1 under third_party/opus and builds
the fixed-point API only. Encoder/decoder state and Ogg payload use a dedicated
30 KiB workspace. Temporary SILK/CELT allocations use a separate 28 KiB
NONTHREADSAFE_PSEUDOSTACK protected by a canary and reported high-water scan.
The microphone has its own six-block RX slab so a bounded live-codec stall does
not overwrite or alias capture buffers. The nrf9160/ns build currently uses
339788 B of 576 KiB application flash and 147192 B of the 154264 B application
RAM region, leaving 7072 B static RAM headroom.

Main stack sizing (do not shrink without measuring)
---------------------------------------------------

CONFIG_MAIN_STACK_SIZE is 20480. libopus is compiled with
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
and nrfutil are not on the default PATH until you source the env script:

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

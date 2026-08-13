/*
 * ESP32 A2DP bridge — BLUETOOTH-MODULE PARITY ONLY.
 *
 * Owner's ruling (2026-08-12, verbatim): "the esp32 is just a chip that
 * we'll eventually replace with the bluetooth module for the end product.
 * so the volume control should be the main chip's job, not esp32's. also,
 * if there's any other firmware that's running on esp32 besides this,
 * delete those. the esp32 should only deal with things that a bluetooth
 * module could do."
 *
 * Review test for every new feature: would a BM83-class Bluetooth audio
 * module with a UART command set do this? If not, it is vetoed here and
 * belongs on the nRF9160. In scope: I2S audio in (including the receiver
 * resync/sync-lock machinery), A2DP source streaming out, pairing
 * management over JSON (scan/connect/forget/status), the route
 * on/off gate, connection state events, a test tone, and a once-a-second
 * link-health line. Volume control is the nRF's job — it pre-scales the
 * PCM it sends; this chip plays what it is given. Bring-up
 * instrumentation (pin probes, clock timing, raw slot captures, ring
 * dumps) does not come back.
 *
 * WHICH DEVICE TO CONNECT IS THE nRF's DECISION, NOT THIS CHIP'S
 * (2026-08-12).
 * ------------------------------------------------------------------
 * The owner, watching the pendant hunt for one particular speaker:
 * "why is it hunting for my bluetooth speaker specifically? shouldn't it
 * discover the bluetooth devices and prioritize those that were connected
 * before?" It was hunting because TWO components each held an opinion
 * about which sink to use — the nRF9160's 4-entry LRU table (the one the
 * owner actually scrolls, `firmware/nrf9160/src/pendant_bt.c`) and this
 * chip's own boot auto-reconnect. Two opinions is one too many, and the
 * one the owner can see and change is the nRF's.
 *
 * So this chip has NO preferred device. It boots IDLE — no NVS target
 * read, no inquiry, no paging — and waits for `scan` or `connect`. What
 * survives a reboot is one CACHE, not a policy: the address of the last
 * sink that answered plus the name that address belonged to, consulted
 * only when a connect command names that same device (see the note on
 * cachedAddress). The nRF commands connections by NAME, and a name
 * inquiry never finds bonded-but-idle earbuds, so deleting the cache
 * would cost every reconnect a trip through pairing mode. Retrying while
 * a COMMANDED link is down stays here — that is link maintenance for the
 * device the main chip chose, not a choice of its own.
 *
 * TWO PORTS, ONE COMMAND SET (2026-08-12).
 * ----------------------------------------
 * The same newline-delimited JSON now arrives on UART2 (GPIO16 RX2 /
 * GPIO17 TX2) as on USB, and every event is written to both. UART2 is the
 * REAL interface: a BM83-class module has exactly one control surface and
 * it is a UART, so this is the wire the nRF9160 commands the "module" over
 * and the wire that survives the ESP32 being replaced by an actual module.
 * USB is debug only — a human with a serial monitor, nothing the product
 * depends on. That is also why the two are not allowed to diverge: a
 * command that only works over USB would be a feature no module could have.
 *
 * Event field ORDER matters on UART2 and is deliberate: type, state, then
 * the fields the main chip acts on (device/address, or target), then the
 * human-readable message last. The nRF receives into a fixed line buffer
 * and truncates anything longer, so the machine-readable fields must come
 * before the prose, not after it.
 *
 * Hard-won audio-path rules, kept from bring-up — violating any of these
 * produced audible, hard-to-diagnose failures:
 *  - The PCM ring is a lock-free SPSC ring: the I2S capture task is the
 *    only producer and the A2DP callback the only consumer. No locks in
 *    the audio path — no portMUX critical sections around sample work.
 *  - The producer never moves ringRead; the consumer never moves ringWrite.
 *  - Never trade DRAM for observability: a 44 KB diagnostic capture buffer
 *    once starved Bluedroid's A2DP TX queue and silenced the sink entirely.
 *  - Anything registered to run from an ISR must be IRAM_ATTR and must not
 *    call into flash.
 */
#include <Arduino.h>
#include <ArduinoJson.h>
#include <BluetoothA2DPSource.h>
#include <Preferences.h>
#include <driver/i2s_std.h>
#include <esp_gap_bt_api.h>

namespace {

// Exact Adafruit HUZZAH32 wiring used by the local control page.
constexpr gpio_num_t I2S_LRC_PIN = GPIO_NUM_33;
constexpr gpio_num_t I2S_BCLK_PIN = GPIO_NUM_27;
// GPIO32's breadboard header joint is electrically open on this prototype.
// GPIO14 is a safe input and is used as the replacement I2S DATA pin.
constexpr gpio_num_t I2S_DATA_PIN = GPIO_NUM_14;
constexpr uint32_t ESP32_MAX_CPU_CLOCK_MHZ = 240;
i2s_chan_handle_t i2sInput = nullptr;

/*
 * Module command link to the nRF9160. UART2's default pins on the HUZZAH32
 * are GPIO16 (RX2) and GPIO17 (TX2), and both are free here — the audio bus
 * owns 27/33/14 and nothing else on this board is wired.
 *
 *   nRF P0.00 (TX) -> GPIO16 RX2
 *   nRF P0.05 (RX) <- GPIO17 TX2
 *
 * 115200 8N1, no flow control: the traffic is short JSON lines, and a
 * module's UART is a command channel, not an audio path.
 */
constexpr gpio_num_t MODULE_UART_RX_PIN = GPIO_NUM_16;
constexpr gpio_num_t MODULE_UART_TX_PIN = GPIO_NUM_17;
constexpr uint32_t MODULE_UART_BAUD = 115200;
HardwareSerial &moduleSerial = Serial2;

/*
 * Every event goes to BOTH ports. USB is a human with a serial monitor;
 * UART2 is the main chip. Writing to only one of them would create a
 * behaviour the other cannot see, which is exactly the divergence the
 * two-ports-one-command-set rule exists to prevent.
 */
void emitLine(const String &line) {
  Serial.println(line);
  moduleSerial.println(line);
}

void emitDocument(JsonDocument &document) {
  String line;
  serializeJson(document, line);
  emitLine(line);
}

/*
 * No speaker is compiled in and none is remembered as a preference. The
 * bridge connects to exactly what it was last COMMANDED to connect to, and
 * only after being commanded.
 */
// How often to re-page the commanded target while its link is down. This is
// retry, not selection: it only ever pages the device the nRF asked for in
// this session, and it stops when a `scan` or `forget` clears that.
constexpr uint32_t RECONNECT_INTERVAL_MS = 30000;

// The nRF9160 duplex I2S TX shares the mic clock: LRCK 31250 Hz and BCLK
// 2 MHz, so each stereo frame is 64 BCLK with 32-cycle slots. The nRF sends
// 24-bit Philips words whose top 16 bits carry the mono signed PCM reply;
// only the LEFT slot is specified, and the right slot is ignored.
constexpr uint32_t INPUT_RATE = 31250;
constexpr uint32_t OUTPUT_RATE = 44100;
constexpr size_t INPUT_BLOCK_FRAMES = 256;
// About 524 ms of jitter headroom at the 31250 Hz wire rate.
constexpr size_t RING_FRAMES = 16384;
// About 65 ms of lead-in before the resampler starts.
constexpr size_t RESAMPLER_PREFILL_FRAMES = 2048;
constexpr size_t RESAMPLER_LOW_WATER_FRAMES = 1024;
constexpr size_t RESAMPLER_HIGH_WATER_FRAMES = 4096;

/*
 * 31250 -> 44100 is an EXACT rational ratio: both rates share a factor of
 * 50, giving 625/882. Every 882 output frames consume exactly 625 input
 * samples, so playback pitch is fixed by construction and needs no rate
 * estimation of any kind.
 *
 * A polyphase FIR replaces the linear interpolator. Linear interpolation
 * between 31250 Hz samples leaves its images only about 10 dB down near
 * 9 kHz: audible as roughness, and it also spends SBC bitpool encoding
 * junk that sits outside the speech band.
 */
constexpr uint32_t RESAMPLE_L = 882;  // OUTPUT_RATE / 50
constexpr uint32_t RESAMPLE_M = 625;  // INPUT_RATE / 50
constexpr size_t RESAMPLE_TAPS = 12;  // input samples per output sample
/*
 * A table with one entry per exact phase would need 882 * 12 taps = 21 KB
 * and does not fit in DRAM alongside the ring. 128 phases plus linear
 * interpolation between adjacent phases costs 3 KB and measures the same:
 * 9 kHz image rejection -57.2 dB against -57.3 dB for the full table.
 * The extra entry is the wrap phase, so tap blending never runs off the end.
 */
constexpr size_t RESAMPLE_PHASES = 128;
int16_t resampleCoeff[(RESAMPLE_PHASES + 1) * RESAMPLE_TAPS];
constexpr int16_t STREAM_SYNC_A = 0x2468;
constexpr int16_t STREAM_SYNC_B = 0x5A5A;
constexpr int16_t STREAM_SYNC_END = 0x6C6C;
constexpr uint8_t STREAM_SYNC_MATCHES_REQUIRED = 8;

BluetoothA2DPSource a2dp;
Preferences preferences;
/* The device the nRF commanded, this session. Empty until a `connect`
 * arrives, and emptied again by `scan`/`forget`: an empty target means this
 * chip has no opinion about where audio should go, which is its resting
 * state now that the LRU table lives on the main chip. */
String targetName;
/* True only between a `connect` command and the next `scan`/`forget`. Gates
 * the retry loop, so a chip sitting idle after boot never pages anything. */
bool connectCommanded = false;
bool a2dpStarted = false;
volatile bool targetSelectionPending = false;
/*
 * ADDRESS CACHE — the one thing that survives a reboot, and deliberately not
 * a preference.
 *
 * Discovery by NAME only finds a device that is currently discoverable, and
 * headphones are discoverable only in pairing mode — AirPods sitting in your
 * ears or in the case never answer an inquiry, so a name scan searches
 * forever. Paging a known address works on any bonded device that is simply
 * powered on. The nRF commands connections by name
 * ({"command":"connect","target":"..."}), so this cache is what turns that
 * name into a page instead of an inquiry.
 *
 * It stores the name it belongs to alongside the address (NVS "addr" /
 * "addrname") and is consulted ONLY when the commanded target is that same
 * name. Consequences worth stating: nothing reads it at boot, it can never
 * select a device, and a connect to a DIFFERENT device does not erase it —
 * the entry stays valid for the day the owner turns back to that sink, and a
 * successful connection to the new one overwrites it anyway.
 */
esp_bd_addr_t cachedAddress = {0, 0, 0, 0, 0, 0};
bool haveCachedAddress = false;
String cachedAddressName;

/*
 * An all-zero BD_ADDR is not an address, and treating it as one is a live
 * hole rather than a theoretical one.
 *
 * `set_auto_reconnect(addr, n)` stores the address we hand it in the library's
 * `last_connection`. If that address is all zeros the library decides it has
 * NO last connection, falls back to reading its OWN NVS namespace
 * ("connected_bda"), and pages whichever peer IT last saw — which is exactly
 * the second device-selection opinion this whole change exists to delete. The
 * way zeros get in: an INBOUND connection from a bonded speaker during the
 * ~10 s the stack is still connectable fires CONNECTED with `last_connection`
 * never populated, and the cache write below would happily store it.
 *
 * So zero is rejected at both ends — never cached, and never trusted if some
 * older build cached it.
 */
bool addressIsSet(const esp_bd_addr_t address) {
  for (int i = 0; i < ESP_BD_ADDR_LEN; i++) {
    if (address[i] != 0) {
      return true;
    }
  }
  return false;
}

/* The cached address may be used only for the device it was cached for. */
bool addressFastPathReady() {
  return haveCachedAddress && addressIsSet(cachedAddress) &&
         !targetName.isEmpty() &&
         cachedAddressName.equalsIgnoreCase(targetName);
}
volatile esp_a2d_connection_state_t pendingConnectionState =
    ESP_A2D_CONNECTION_STATE_DISCONNECTED;
volatile bool connectionStateChanged = false;
// Link-health counters a module would report: input activity, input level,
// and frames delivered to the Bluetooth stack. Nothing here is bring-up
// instrumentation; it feeds the once-a-second diagnostic line only.
volatile uint32_t i2sFramesReceived = 0;
volatile uint16_t i2sPeakSinceReport = 0;
volatile uint32_t a2dpFramesRequested = 0;
volatile uint32_t testToneFramesRemaining = 0;
volatile uint32_t testTonePhase = 0;
volatile bool i2sForwardingEnabled = true;

/*
 * There is deliberately no half-second PCM capture buffer here.
 *
 * A 22050-sample diagnostic buffer used to live at this spot. It cost
 * 44,100 bytes of static DRAM and took the image from 22.9% to 36.4% of
 * RAM, which starved Bluedroid's A2DP source of buffer memory: its TX
 * queue (TxAaQ) stayed backlogged, so btc_get_num_aa_frame() clamped
 * output to 8 SBC frames per 30 ms tick instead of the 10.33 that 44.1 kHz
 * needs. Measured result: 34,247 frames/s delivered against 44,100
 * required, a 78% feed rate. The sink's decoder underran continuously and
 * rendered nothing at all.
 *
 * The audio path must not be traded for observability. Capture the wire
 * from the nRF side, which has memory to spare.
 */

/*
 * Lock-free SPSC ring. The I2S capture task is the only producer and the
 * A2DP callback the only consumer, so volatile indices and a derived fill
 * level are sufficient, and cheaper than taking a portMUX critical section
 * for every single sample in the Bluetooth callback.
 *
 * Note for anyone reading the history here: an earlier version of this
 * comment claimed the critical section was throttling the A2DP callback to
 * ~34,200 frames/s. That was wrong. Bench measurement showed the opposite —
 * the callback was served 44,229 frames/s with the critical section in
 * place. The lock is a small win, not a fix for a delivery-rate problem.
 */
int16_t ringBuffer[RING_FRAMES];
volatile size_t ringRead = 0;
volatile size_t ringWrite = 0;
volatile uint32_t audioStreamGeneration = 0;

void emitEvent(const char *state, const String &message) {
  JsonDocument document;
  /* Machine-readable fields first, prose last — the nRF truncates at a
   * fixed line length and must never lose `target` to a long message. */
  document["type"] = "bridge";
  document["state"] = state;
  document["target"] = targetName;
  document["message"] = message;
  emitDocument(document);
}

void emitStatus() {
  const esp_a2d_connection_state_t state = a2dp.get_connection_state();
  switch (state) {
  case ESP_A2D_CONNECTION_STATE_CONNECTED:
    /* Not "AirPods": no speaker is compiled in and none is preferred, so the
     * status line must not name a device class the owner may not own. */
    emitEvent("connected", "A2DP link is connected.");
    break;
  case ESP_A2D_CONNECTION_STATE_CONNECTING:
    emitEvent("searching", "Bluetooth is connecting to the selected target.");
    break;
  case ESP_A2D_CONNECTION_STATE_DISCONNECTING:
    emitEvent("usb", "Bluetooth link is disconnecting.");
    break;
  default:
    /* Two different states wear the same "not connected" hat: an inquiry with
     * no target (a `scan`) and a hunt for a commanded one. The nRF reads this
     * line to decide whether its menu is still filling, so it must say which. */
    emitEvent(a2dpStarted ? "searching" : "usb",
              !a2dpStarted ? "USB ready; no Bluetooth search is active."
              : connectCommanded
                  ? "Bluetooth is looking for the commanded target."
                  : "Bluetooth is scanning for nearby devices.");
    break;
  }
}

void pushSample(int16_t sample) {
  /*
   * With no A2DP sink nothing drains the ring, so buffering here would
   * only bank stale audio: observed as a permanently full ring and
   * hundreds of thousands of overruns while the headphones were away.
   * The damage is audible — on reconnect the listener hears half a second
   * of a PREVIOUS conversation before the live stream. Drop instead.
   */
  if (a2dp.get_connection_state() != ESP_A2D_CONNECTION_STATE_CONNECTED) {
    return;
  }
  const size_t write = ringWrite;
  const size_t next = (write + 1) % RING_FRAMES;
  if (next == ringRead) {
    // Full: drop the NEWEST sample. The producer must never move ringRead.
    return;
  }
  ringBuffer[write] = sample;
  __atomic_thread_fence(__ATOMIC_RELEASE);
  ringWrite = next;
}

bool popSample(int16_t &sample) {
  const size_t read = ringRead;
  if (read == ringWrite) {
    return false;
  }
  sample = ringBuffer[read];
  __atomic_thread_fence(__ATOMIC_ACQUIRE);
  ringRead = (read + 1) % RING_FRAMES;
  return true;
}

size_t bufferedSampleCount() {
  return (ringWrite - ringRead + RING_FRAMES) % RING_FRAMES;
}

void clearAudioBuffer() {
  // Consumer-side catch-up: never move ringWrite here, only ringRead.
  ringRead = ringWrite;
  ++audioStreamGeneration;
}

/*
 * The nRF's 24 data bits land MSB-aligned in the captured 32-cycle slot, so
 * the mono PCM sample is the top 16 bits of the received 32-bit word. The
 * one-bit-early-latch repair shifts the whole 32-bit word left once before
 * extracting; the bit it discards lives in the undefined slot tail.
 */
inline int16_t extractSlotSample(int32_t word) {
  return static_cast<int16_t>(static_cast<uint32_t>(word) >> 16);
}

inline int16_t extractShiftedSlotSample(int32_t word) {
  return static_cast<int16_t>((static_cast<uint32_t>(word) << 1) >> 16);
}

void i2sCaptureTask(void *) {
  int32_t input[INPUT_BLOCK_FRAMES * 2];
  uint32_t lastBlockAt = 0;
  bool waitingForSync = true;
  bool syncLocked = false;
  bool repairOneBitShift = false;
  bool syncEndSeen = false;
  int16_t previousNormalSync = 0;
  int16_t previousShiftedSync = 0;
  uint8_t normalSyncMatches = 0;
  uint8_t shiftedSyncMatches = 0;

  while (true) {
    size_t bytesRead = 0;
    const esp_err_t result = i2s_channel_read(
        i2sInput, input, sizeof(input), &bytesRead, portMAX_DELAY);
    if (result != ESP_OK) {
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    if (bytesRead == 0) {
      continue;
    }

    const uint32_t receivedAt = millis();
    if (lastBlockAt == 0 || receivedAt - lastBlockAt > 250) {
      /*
       * The nRF gates BCLK while no audio is queued. The original ESP32 I2S
       * slave can latch one bit early when that external clock restarts.
       * Reset the RX state machine while BCLK/WS are active, discard the
       * first DMA block, and begin with the next complete stereo frame.
       */
      i2s_channel_disable(i2sInput);
      i2s_channel_enable(i2sInput);
      clearAudioBuffer();
      waitingForSync = true;
      syncLocked = false;
      repairOneBitShift = false;
      syncEndSeen = false;
      previousNormalSync = 0;
      previousShiftedSync = 0;
      normalSyncMatches = 0;
      shiftedSyncMatches = 0;
      lastBlockAt = receivedAt;
      continue;
    }
    lastBlockAt = receivedAt;

    const size_t frames = bytesRead / (2 * sizeof(int32_t));
    i2sFramesReceived += frames;

    for (size_t frame = 0; frame < frames; ++frame) {
      const int32_t leftWord = input[frame * 2];
      const int16_t normalSample = extractSlotSample(leftWord);
      const int16_t shiftedSample = extractShiftedSlotSample(leftWord);

      /*
       * Every nRF stream begins with an alternating pre-shared sync word in
       * the left slot. Search both the hardware-delivered alignment and a
       * one-bit-left repair of the 32-bit slot word. This turns the
       * otherwise unframed I2S restart into an explicit handshake and tells
       * us which alignment to use for the whole stream.
       */
      if (waitingForSync) {
        if (!syncLocked) {
          if (normalSample == STREAM_SYNC_A ||
              normalSample == STREAM_SYNC_B) {
            const bool alternates =
                (normalSample == STREAM_SYNC_A &&
                 previousNormalSync == STREAM_SYNC_B) ||
                (normalSample == STREAM_SYNC_B &&
                 previousNormalSync == STREAM_SYNC_A);
            normalSyncMatches = alternates ? normalSyncMatches + 1U : 1U;
            previousNormalSync = normalSample;
          } else {
            normalSyncMatches = 0;
            previousNormalSync = 0;
          }

          if (shiftedSample == STREAM_SYNC_A ||
              shiftedSample == STREAM_SYNC_B) {
            const bool alternates =
                (shiftedSample == STREAM_SYNC_A &&
                 previousShiftedSync == STREAM_SYNC_B) ||
                (shiftedSample == STREAM_SYNC_B &&
                 previousShiftedSync == STREAM_SYNC_A);
            shiftedSyncMatches =
                alternates ? shiftedSyncMatches + 1U : 1U;
            previousShiftedSync = shiftedSample;
          } else {
            shiftedSyncMatches = 0;
            previousShiftedSync = 0;
          }

          if (normalSyncMatches >= STREAM_SYNC_MATCHES_REQUIRED ||
              shiftedSyncMatches >= STREAM_SYNC_MATCHES_REQUIRED) {
            repairOneBitShift =
                shiftedSyncMatches > normalSyncMatches;
            syncLocked = true;
          }
          continue;
        }

        const int16_t alignedSample =
            repairOneBitShift ? shiftedSample : normalSample;
        if (alignedSample == STREAM_SYNC_END) {
          syncEndSeen = true;
          continue;
        }
        if (!syncEndSeen) {
          continue;
        }

        waitingForSync = false;
        clearAudioBuffer();
      }

      const int16_t sample =
          repairOneBitShift ? shiftedSample : normalSample;

      int32_t cleanMagnitude = sample;
      if (cleanMagnitude < 0) {
        cleanMagnitude = -cleanMagnitude;
      }
      if (cleanMagnitude > i2sPeakSinceReport) {
        i2sPeakSinceReport = static_cast<uint16_t>(cleanMagnitude);
      }
      pushSample(sample);
    }
  }
}

/*
 * Build the polyphase interpolation filter once at boot.
 *
 * The prototype is a Hamming-windowed sinc running at the virtual
 * RESAMPLE_L * INPUT_RATE rate, cut off at INPUT_RATE/2 (15625 Hz) — the
 * lower of the two Nyquist limits, which is what an interpolator must
 * protect. Phase p of the polyphase decomposition is every RESAMPLE_L'th
 * prototype tap starting at p.
 *
 * Each phase is normalised to unity DC gain independently. Normalising the
 * prototype as a whole instead leaves per-phase sums varying by a fraction
 * of a dB, which shows up as a tone at the 50 Hz phase-cycle rate.
 */
void buildResampleFilter() {
  const size_t protoLength = RESAMPLE_PHASES * RESAMPLE_TAPS;
  const double center = (protoLength - 1) / 2.0;

  for (size_t phase = 0; phase <= RESAMPLE_PHASES; ++phase) {
    double taps[RESAMPLE_TAPS];
    double sum = 0.0;
    for (size_t tap = 0; tap < RESAMPLE_TAPS; ++tap) {
      const size_t index = phase + tap * RESAMPLE_PHASES;
      const double offset = static_cast<double>(index) - center;
      // sinc(offset / PHASES): cutoff at half the input rate.
      const double x = offset / static_cast<double>(RESAMPLE_PHASES);
      const double sinc = (fabs(x) < 1e-9) ? 1.0 : (sin(M_PI * x) / (M_PI * x));
      // The wrap phase reaches one past the window; hold its last value.
      const size_t windowIndex =
          (index < protoLength) ? index : (protoLength - 1);
      const double window =
          0.54 - 0.46 * cos(2.0 * M_PI * static_cast<double>(windowIndex) /
                            static_cast<double>(protoLength - 1));
      taps[tap] = sinc * window;
      sum += taps[tap];
    }
    // Unity DC gain per phase, in Q15.
    const double scale = (fabs(sum) < 1e-9) ? 0.0 : (32768.0 / sum);
    for (size_t tap = 0; tap < RESAMPLE_TAPS; ++tap) {
      const double q15 = taps[tap] * scale;
      resampleCoeff[phase * RESAMPLE_TAPS + tap] = static_cast<int16_t>(
          constrain(static_cast<int32_t>(lround(q15)), -32768, 32767));
    }
  }
}

int32_t provideA2dpFrames(Frame *frames, int32_t frameCount) {
  a2dpFramesRequested += frameCount;

  // Diagnostic path: generate a loud 440 Hz square wave directly on the
  // ESP32, bypassing the nRF and the physical I2S input completely.
  if (testToneFramesRemaining > 0) {
    for (int32_t index = 0; index < frameCount; ++index) {
      int16_t sample = 0;
      if (testToneFramesRemaining > 0) {
        /*
         * 8000, not 2000. The library attenuates our samples AFTER this
         * callback returns (get_audio_data_volume applies volumeFactor in
         * place), and set_volume(80) is -13.5 dB on the default exponential
         * curve. At amplitude 2000 the tone left the chip at -37.8 dBFS,
         * so "I heard nothing" could not be distinguished from "that was
         * too quiet to notice" — which made the whole test worthless as
         * evidence. 8000 leaves at about -25 dBFS: unmistakable, and still
         * well short of uncomfortable in the ear.
         */
        sample = testTonePhase < (OUTPUT_RATE / 2) ? 8000 : -8000;
        testTonePhase += 440;
        if (testTonePhase >= OUTPUT_RATE) {
          testTonePhase -= OUTPUT_RATE;
        }
        --testToneFramesRemaining;
      }
      frames[index].channel1 = sample;
      frames[index].channel2 = sample;
    }
    return frameCount;
  }

  // The serial control page can still mute the live nRF route during testing.
  if (!i2sForwardingEnabled) {
    memset(frames, 0, frameCount * sizeof(Frame));
    return frameCount;
  }

  // The nRF stream is 31250 Hz. A2DP requests 44.1 kHz stereo PCM.
  static int16_t history[RESAMPLE_TAPS] = {};
  static uint32_t phaseIndex = 0;  // (n * RESAMPLE_M) mod RESAMPLE_L
  static bool primed = false;
  static uint32_t observedStreamGeneration = 0;

  /*
   * BCLK stops between replies. Any interpolator endpoints retained from the
   * preceding reply are stale after the capture task resets or re-locks the
   * I2S stream, so discard them before considering the new jitter buffer.
   */
  const uint32_t streamGeneration = audioStreamGeneration;
  if (streamGeneration != observedStreamGeneration) {
    memset(history, 0, sizeof(history));
    phaseIndex = 0;
    primed = false;
    observedStreamGeneration = streamGeneration;
  }

  size_t buffered = bufferedSampleCount();
  if (!primed) {
    /*
     * The nRF and Bluetooth clocks are independent. Starting as soon as two
     * samples arrive makes every scheduling hiccup an audible underrun.
     * Accumulate about 65 ms first so the resampler has a real jitter buffer.
     */
    if (buffered < RESAMPLER_PREFILL_FRAMES) {
      memset(frames, 0, frameCount * sizeof(Frame));
      return frameCount;
    }
    memset(history, 0, sizeof(history));
    for (size_t tap = 0; tap < RESAMPLE_TAPS; ++tap) {
      int16_t incoming = 0;
      if (!popSample(incoming)) {
        memset(frames, 0, frameCount * sizeof(Frame));
        return frameCount;
      }
      for (size_t k = RESAMPLE_TAPS - 1; k > 0; --k) {
        history[k] = history[k - 1];
      }
      history[0] = incoming;
    }
    phaseIndex = 0;
    primed = true;
  }

  /*
   * The 625/882 ratio is exact, so the only correction ever needed is for
   * the genuine crystal difference between the nRF and the Bluetooth clock
   * — parts per million. Allow at most ONE slipped input sample per
   * callback (about 0.9% of the wire rate at the observed call rate).
   *
   * This deliberately cannot paper over a large rate mismatch. If the
   * Bluetooth stack pulls materially slower than 44100 frames/s, the ring
   * climbs to the high-water mark and slips every callback — a fault to be
   * fixed, not something to hide by stretching pitch.
   */
  const int32_t level = static_cast<int32_t>(bufferedSampleCount());
  bool holdOneInput = false;
  if (level > static_cast<int32_t>(RESAMPLER_HIGH_WATER_FRAMES)) {
    int16_t extra = 0;
    if (popSample(extra)) {
      for (size_t k = RESAMPLE_TAPS - 1; k > 0; --k) {
        history[k] = history[k - 1];
      }
      history[0] = extra;
    }
  } else if (level < static_cast<int32_t>(RESAMPLER_LOW_WATER_FRAMES)) {
    holdOneInput = true;
  }

  for (int32_t index = 0; index < frameCount; ++index) {
    /*
     * Polyphase convolution. history[0] is the newest input sample, and
     * phaseIndex selects the fractional position between input samples, so
     * this is a true bandlimited interpolation rather than a straight line
     * drawn between neighbours.
     */
    const uint32_t scaledPhase = phaseIndex * RESAMPLE_PHASES;
    const uint32_t phaseSlot = scaledPhase / RESAMPLE_L;
    const uint32_t phaseFraction = scaledPhase % RESAMPLE_L;
    const int16_t *lower = &resampleCoeff[phaseSlot * RESAMPLE_TAPS];
    const int16_t *upper = &resampleCoeff[(phaseSlot + 1) * RESAMPLE_TAPS];
    int64_t accumulator = 0;
    for (size_t tap = 0; tap < RESAMPLE_TAPS; ++tap) {
      const int32_t blended =
          lower[tap] + static_cast<int32_t>(
                           (static_cast<int64_t>(upper[tap] - lower[tap]) *
                            phaseFraction) /
                           RESAMPLE_L);
      accumulator += static_cast<int64_t>(blended) * history[tap];
    }
    const int32_t scaled = static_cast<int32_t>((accumulator + 16384) >> 15);
    /*
     * No gain stage here — module parity. Volume is the nRF9160's job: it
     * pre-scales the PCM it sends, and this chip plays what it is given.
     * The single constrain saturates the FIR's occasional overshoot.
     */
    const int16_t sample = static_cast<int16_t>(
        constrain(scaled, static_cast<int32_t>(INT16_MIN),
                  static_cast<int32_t>(INT16_MAX)));
    frames[index].channel1 = sample;
    frames[index].channel2 = sample;

    phaseIndex += RESAMPLE_M;
    if (phaseIndex >= RESAMPLE_L) {
      phaseIndex -= RESAMPLE_L;
      if (holdOneInput) {
        // Repeat the current input sample once to let the buffer refill.
        holdOneInput = false;
        continue;
      }
      int16_t incoming = 0;
      if (!popSample(incoming)) {
        primed = false;
        /*
         * Fade the remainder of this callback instead of jumping abruptly
         * from a nonzero sample to zero.
         */
        const int32_t fadeFrames = frameCount - index;
        for (int32_t rest = index + 1; rest < frameCount; ++rest) {
          const int32_t fade =
              static_cast<int32_t>(sample) * (frameCount - rest) / fadeFrames;
          frames[rest].channel1 = static_cast<int16_t>(fade);
          frames[rest].channel2 = static_cast<int16_t>(fade);
        }
        memset(history, 0, sizeof(history));
        phaseIndex = 0;
        return frameCount;
      }
      for (size_t k = RESAMPLE_TAPS - 1; k > 0; --k) {
        history[k] = history[k - 1];
      }
      history[0] = incoming;
    }
  }

  return frameCount;
}

void onConnectionState(esp_a2d_connection_state_t state, void *) {
  if (state == ESP_A2D_CONNECTION_STATE_DISCONNECTED) {
    targetSelectionPending = false;
  }
  pendingConnectionState = state;
  connectionStateChanged = true;
}

bool targetMatches(const char *deviceName, esp_bd_addr_t address, int rssi) {
  if (deviceName == nullptr) {
    return false;
  }

  String found(deviceName);
  char addressText[18];
  snprintf(addressText, sizeof(addressText), "%02x:%02x:%02x:%02x:%02x:%02x",
           address[0], address[1], address[2], address[3], address[4],
           address[5]);

  String normalizedFound = found;
  String normalizedTarget = targetName;
  normalizedFound.trim();
  normalizedTarget.trim();
  normalizedFound.toLowerCase();
  normalizedTarget.toLowerCase();

  /*
   * An empty target IS scan-only mode, and it is the only signal used. There
   * used to be a separate `discoveryOnly` flag as well; it was write-only and
   * deleted (2026-08-13), which is the correct outcome rather than a loss —
   * this callback runs on the Bluetooth task and could observe a stale copy of
   * that flag across a scan-to-connect transition, matching a device during
   * what the owner still thought was a scan. `targetName` is the single fact,
   * set before the search starts.
   */
  bool nameOrAddressMatches =
      !normalizedTarget.isEmpty() &&
      normalizedFound.indexOf(normalizedTarget) >= 0;
  if (!nameOrAddressMatches && addressFastPathReady()) {
    /* The COMMANDED device reporting a different or empty name still counts —
     * but only because the cached address belongs to that same name. Matching
     * a cached address against a target it was never paired with is how this
     * chip used to connect to a speaker nobody asked for. */
    nameOrAddressMatches =
        memcmp(address, cachedAddress, ESP_BD_ADDR_LEN) == 0;
  }

  /*
   * A single inquiry can report the same speaker more than once before the
   * cancellation event arrives. Letting each result return true makes this
   * library cancel discovery twice; its second STOPPED event then restarts
   * inquiry while A2DP is paging the speaker, causing HCI page timeout 0x04.
   */
  const bool duplicateIgnored =
      nameOrAddressMatches && targetSelectionPending;
  const bool matches = nameOrAddressMatches && !targetSelectionPending;
  if (matches) {
    targetSelectionPending = true;
  }

  JsonDocument document;
  /*
   * Field order is the contract with the nRF's fixed-size line buffer:
   * device and address are what the sink table is built from, so they come
   * before rssi/target/flags and long before the human-readable message.
   * Reordered 2026-08-12 when this frame gained a second reader.
   */
  document["type"] = "discovery";
  document["state"] = "searching";
  document["device"] = found;
  document["address"] = addressText;
  document["rssi"] = rssi;
  document["target"] = targetName;
  document["matched"] = matches;
  document["duplicate_ignored"] = duplicateIgnored;
  document["message"] =
      "Found “" + found + "” (" + String(rssi) + " dBm).";
  emitDocument(document);

  return matches;
}

/*
 * Page the cached address of the COMMANDED device directly. Works for a
 * bonded device that is powered on but not discoverable — the case a name
 * scan can never handle.
 */
void pageCachedAddress() {
  if (!a2dpStarted) {
    return;
  }
  if (a2dp.get_connection_state() == ESP_A2D_CONNECTION_STATE_CONNECTED ||
      a2dp.get_connection_state() == ESP_A2D_CONNECTION_STATE_CONNECTING) {
    return;
  }

  if (!addressFastPathReady()) {
    return;
  }
  esp_bd_addr_t *target = &cachedAddress;

  char addressText[18];
  const uint8_t *a = *target;
  snprintf(addressText, sizeof(addressText), "%02x:%02x:%02x:%02x:%02x:%02x",
           a[0], a[1], a[2], a[3], a[4], a[5]);
  emitEvent("searching", "Paging " + targetName + " at " +
                             String(addressText) +
                             " (device must be on and not connected "
                             "elsewhere).");
  a2dp.connect_to(*target);
}

void startBluetoothSearch(bool scanOnly = false) {
  if (!scanOnly && targetName.isEmpty()) {
    /* No target and no fallback to one: with the LRU table on the nRF, a
     * connect this chip was not given a name for is a command it cannot
     * honestly satisfy. Saying so beats guessing. */
    emitEvent("usb",
              "No Bluetooth target commanded. Send {\"command\":\"scan\"} to "
              "list devices, then {\"command\":\"connect\",\"target\":\"...\"}.");
    return;
  }

  if (a2dpStarted) {
    a2dp.end(false);
    delay(300);
  }

  clearAudioBuffer();
  targetSelectionPending = false;
  a2dp.set_data_callback_in_frames(provideA2dpFrames);
  a2dp.set_ssid_callback(targetMatches);
  a2dp.set_on_connection_state_changed(onConnectionState);
  if (!scanOnly && addressFastPathReady()) {
    // Address-first: the library retries THIS address, which belongs to the
    // name we were just commanded to connect to.
    a2dp.set_auto_reconnect(cachedAddress, 12);
  } else {
    /*
     * Never `set_auto_reconnect(true)`: the library would reconnect to ITS
     * last peer, which is a device-selection opinion of its own and exactly
     * the split brain the owner heard. With no cached address for this
     * target, the name inquiry is the only honest route.
     */
    a2dp.set_auto_reconnect(false, 0);
  }
  /* Legacy speakers that still demand a fixed PIN accept the usual one. */
  a2dp.set_pin_code("0000", ESP_BT_PIN_TYPE_FIXED);
  a2dp.set_volume(80);
  a2dp.start();
  a2dpStarted = true;
  emitEvent("searching",
            scanOnly ? "Scanning for nearby Bluetooth audio devices."
                     : "Connecting to “" + targetName +
                           "”. Put the device in pairing mode if it does "
                           "not answer.");
  if (!scanOnly && addressFastPathReady()) {
    delay(500);
    pageCachedAddress();
  }
}

void removeAllBluetoothBonds() {
  int deviceCount = esp_bt_gap_get_bond_device_num();
  if (deviceCount <= 0) {
    return;
  }

  auto *devices = static_cast<esp_bd_addr_t *>(
      malloc(deviceCount * sizeof(esp_bd_addr_t)));
  if (devices == nullptr) {
    return;
  }

  if (esp_bt_gap_get_bond_device_list(&deviceCount, devices) == ESP_OK) {
    for (int index = 0; index < deviceCount; ++index) {
      esp_bt_gap_remove_bond_device(devices[index]);
    }
  }
  free(devices);
}

/*
 * ONE command handler for both ports. `origin` only colours the log line —
 * a command must do exactly the same thing whichever wire carried it, or
 * the UART stops being a faithful stand-in for a module's control surface.
 */
void handleCommand(const String &line, const char *origin) {
  JsonDocument document;
  const DeserializationError error = deserializeJson(document, line);
  if (error) {
    emitEvent("usb", String("Ignored an invalid command on ") + origin + ".");
    return;
  }

  const String command = document["command"] | "";
  if (command == "scan") {
    /* A scan is a question, not a connection: it drops the commanded target
     * so the retry loop below stops paging while the inquiry runs. */
    targetName = "";
    connectCommanded = false;
    startBluetoothSearch(true);
  } else if (command == "connect") {
    /*
     * Parsed into a TEMPORARY and only committed once it is valid. Assigning
     * straight into `targetName` meant a malformed connect blanked the name of
     * a link that was up and working: the retry loop then went permanently
     * quiet for a device the nRF still wanted, and every later event reported
     * an empty target. A bad command must cost nothing but the command.
     */
    String requested = String(document["target"] | "");
    requested.trim();
    if (requested.isEmpty()) {
      emitEvent("usb", "The Bluetooth target name cannot be empty.");
      return;
    }
    targetName = requested;
    /*
     * No NVS write here. Which device the pendant prefers is the nRF's table
     * to keep; this chip only needs to know what it was told THIS time. The
     * address cache is written when a connection actually succeeds, because a
     * connection is the only proof an address is reachable.
     */
    connectCommanded = true;
    startBluetoothSearch(false);
  } else if (command == "status") {
    emitStatus();
  } else if (command == "tone") {
    testTonePhase = 0;
    testToneFramesRemaining = OUTPUT_RATE * 3;
    emitEvent("connected",
              "Playing a three-second ESP32-direct Bluetooth test tone.");
  } else if (command == "route") {
    i2sForwardingEnabled = document["enabled"] | false;
    clearAudioBuffer();
    emitEvent(a2dp.get_connection_state() ==
                      ESP_A2D_CONNECTION_STATE_CONNECTED
                  ? "connected"
                  : "usb",
              i2sForwardingEnabled ? "nRF I2S forwarding enabled."
                                   : "nRF I2S forwarding muted.");
  } else if (command == "forget") {
    if (a2dpStarted) {
      a2dp.end(false);
      a2dpStarted = false;
      delay(150);
    }
    removeAllBluetoothBonds();
    /* "target" is a key this chip no longer writes; removed here so a bridge
     * flashed over an older build does not leave a stale preference behind. */
    preferences.remove("target");
    preferences.remove("addr");
    preferences.remove("addrname");
    haveCachedAddress = false;
    cachedAddressName = "";
    targetName = "";
    connectCommanded = false;
    clearAudioBuffer();
    emitEvent("usb", "Pairing and saved target cleared.");
  } else {
    emitEvent("usb", String("Unknown command on ") + origin + ": " + command);
  }
}

/*
 * Line assembly, one instance per port. Same 512-char cap and same
 * newline framing on both, so a command that is accepted on USB is
 * accepted byte-for-byte on UART2.
 */
void pumpCommandPort(Stream &port, String &buffer, const char *origin) {
  while (port.available()) {
    const char character = static_cast<char>(port.read());
    if (character == '\n') {
      buffer.trim();
      if (!buffer.isEmpty()) {
        handleCommand(buffer, origin);
      }
      buffer = "";
    } else if (character != '\r' && buffer.length() < 512) {
      buffer += character;
    }
  }
}

void configureI2sInput() {
  i2s_chan_config_t channel =
      I2S_CHANNEL_DEFAULT_CONFIG(I2S_NUM_0, I2S_ROLE_SLAVE);
  channel.dma_desc_num = 8;
  channel.dma_frame_num = INPUT_BLOCK_FRAMES;

  i2s_std_config_t standard = {
      .clk_cfg = I2S_STD_CLK_DEFAULT_CONFIG(INPUT_RATE),
      /*
       * 32-bit slots capture the nRF's full 32-cycle slot; its 24 data bits
       * land MSB-aligned and the mono sample occupies the top 16 bits.
       */
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
          I2S_DATA_BIT_WIDTH_32BIT, I2S_SLOT_MODE_STEREO),
      .gpio_cfg =
          {
              .mclk = I2S_GPIO_UNUSED,
              .bclk = I2S_BCLK_PIN,
              .ws = I2S_LRC_PIN,
              .dout = I2S_GPIO_UNUSED,
              .din = I2S_DATA_PIN,
              .invert_flags =
                  {
                      .mclk_inv = false,
                      /*
                       * The nRF9160 changes SDOUT on the opposite BCLK edge.
                       * Inverting the slave input clock gives DATA a full
                       * half-cycle of setup time before the ESP32 samples it.
                       */
                      .bclk_inv = true,
                      .ws_inv = false,
                  },
          },
  };

  /*
   * The slave RX module clock must stay at least eight times the external
   * BCLK. The nRF clocks BCLK at 2 MHz, so the default 256x multiple
   * (8 MHz at 31250 Hz) is too slow. 512x yields exactly 16 MHz — which is
   * exactly 8x, sitting ON the documented minimum with no margin at all.
   * 1024x gives 32 MHz (16x BCLK) and costs nothing: in slave mode this
   * clock only oversamples an externally supplied BCLK, it does not set the
   * sample rate, so the wire rate is unchanged.
   */
  standard.clk_cfg.mclk_multiple = I2S_MCLK_MULTIPLE_1024;

  ESP_ERROR_CHECK(i2s_new_channel(&channel, nullptr, &i2sInput));
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(i2sInput, &standard));
  // A disconnected/cold DATA header joint must resolve to silence instead of
  // random full-scale samples. A valid nRF 3.3 V output overrides this pull.
  ESP_ERROR_CHECK(gpio_set_pull_mode(I2S_DATA_PIN, GPIO_PULLDOWN_ONLY));
  ESP_ERROR_CHECK(i2s_channel_enable(i2sInput));
}

} // namespace

void setup() {
  // 240 MHz: the polyphase resampler plus SBC encode need the headroom.
  setCpuFrequencyMhz(ESP32_MAX_CPU_CLOCK_MHZ);
  Serial.begin(115200);
  moduleSerial.begin(MODULE_UART_BAUD, SERIAL_8N1, MODULE_UART_RX_PIN,
                     MODULE_UART_TX_PIN);
  delay(400);
  Serial.setTimeout(40);
  moduleSerial.setTimeout(40);

  buildResampleFilter();

  preferences.begin("airpods", false);
  /* The cache, loaded but NOT acted on: it only becomes useful if a connect
   * command names the device it belongs to. */
  haveCachedAddress =
      preferences.getBytes("addr", cachedAddress, ESP_BD_ADDR_LEN) ==
      ESP_BD_ADDR_LEN;
  cachedAddressName = preferences.getString("addrname", "");
  if (cachedAddressName.isEmpty()) {
    /* An address with no name attached cannot be matched to a command, so it
     * is dead weight — a bridge upgraded from the build that stored the pair
     * under "target" starts the cache over on its next successful connect. */
    haveCachedAddress = false;
  }

  configureI2sInput();
  /*
   * 32-bit slot capture doubles the on-stack DMA block to 2 KiB. Priority 10
   * (was 4) keeps the only task with a hard I2S deadline ahead of everything
   * else scheduled on core 1 — Arduino's loopTask, which emits the once-a-second
   * diagnostic JSON, runs here too. Missing this deadline does not raise an
   * error; it silently discards audio.
   */
  xTaskCreatePinnedToCore(i2sCaptureTask, "i2s-capture", 6144, nullptr, 10,
                         nullptr, 1);

  emitEvent("usb",
            "HUZZAH32 ready: LRC=33, BCLK=27, DATA=14, cmd UART2 RX=16/TX=17, "
            "nRF I2S forwarding on. Idle — waiting for scan/connect" +
                (haveCachedAddress ? " (address cached for “" +
                                         cachedAddressName + "”)"
                                   : "") +
                ".");
  /*
   * Nothing else happens at boot. No inquiry, no page, no target: the nRF
   * decides which sink the pendant wants and commands it (owner, 2026-08-12
   * — "shouldn't it discover the bluetooth devices and prioritize those that
   * were connected before?"). A chip that reconnected on its own would be
   * the second opinion that made the pendant hunt for one speaker.
   */
}

void loop() {
  static String usbIncoming;
  static String moduleIncoming;
  static uint32_t lastDiagnosticAt = 0;

  /* The module link first: it is the interface the product ships with, and
   * USB is the debug console sitting beside it. */
  pumpCommandPort(moduleSerial, moduleIncoming, "uart2");
  pumpCommandPort(Serial, usbIncoming, "usb");

  if (connectionStateChanged) {
    connectionStateChanged = false;
    switch (pendingConnectionState) {
    case ESP_A2D_CONNECTION_STATE_CONNECTED: {
      // Cache who answered, WITH the name it answered to, so the next
      // commanded connect to this same device can page instead of inquire.
      // Only a real connection proves the address is reachable.
      esp_bd_addr_t *peer = a2dp.get_last_peer_address();
      /* Zeros mean the library never learned who this is — an inbound link, or
       * a state it cleaned. Caching that would arm the library's own NVS
       * fallback on the next connect. See addressIsSet(). */
      if (peer != nullptr && addressIsSet(*peer) && !targetName.isEmpty()) {
        memcpy(cachedAddress, *peer, ESP_BD_ADDR_LEN);
        haveCachedAddress = true;
        cachedAddressName = targetName;
        preferences.putBytes("addr", cachedAddress, ESP_BD_ADDR_LEN);
        preferences.putString("addrname", cachedAddressName);
      }
      emitEvent("connected", "Bluetooth speaker connected. A2DP is streaming.");
      break;
    }
    case ESP_A2D_CONNECTION_STATE_CONNECTING:
      emitEvent("searching",
                "Bluetooth target found; opening the A2DP link.");
      break;
    case ESP_A2D_CONNECTION_STATE_DISCONNECTED:
      /*
       * Honest about WHO retries. The library's own reconnect is off
       * (set_auto_reconnect(false, 0)) precisely so it cannot pick a peer of
       * its own, which means nothing resumes on its own — the 30 s page in
       * loop() is the entire recovery path, and it only runs for a target
       * commanded this session. Saying "scanning will resume" promised the
       * nRF, and anyone watching USB, a behaviour that no longer exists.
       */
      emitEvent(a2dpStarted && connectCommanded ? "searching" : "usb",
                a2dpStarted && connectCommanded
                    ? "Bluetooth disconnected; retrying the commanded target."
                    : "Bluetooth disconnected.");
      break;
    default:
      emitEvent("usb", "Bluetooth link is disconnecting.");
      break;
    }
  }

  /*
   * Keep paging the COMMANDED device while its link is down. Headphones come
   * back on their own schedule — out of the case, released by a phone — and
   * they will never page US, so retrying is the only way the link returns
   * without another command.
   *
   * Gated on connectCommanded, so this cannot resurrect a device the owner
   * never asked for in this session: after boot, after a `scan`, and after a
   * `forget` there is nothing to retry and this loop does nothing at all.
   */
  static uint32_t lastReconnectAttemptAt = 0;
  if (a2dpStarted && connectCommanded && addressFastPathReady() &&
      millis() - lastReconnectAttemptAt >= RECONNECT_INTERVAL_MS) {
    lastReconnectAttemptAt = millis();
    pageCachedAddress();
  }

  /*
   * Once-a-second link-health line: what a Bluetooth audio module would
   * report over its UART — link state, remembered peer, whether audio is
   * arriving on the I2S input, its level, and whether the A2DP stream is
   * pulling frames. Internal ring/resampler counters are not link health
   * and do not belong here.
   */
  if (millis() - lastDiagnosticAt >= 1000) {
    lastDiagnosticAt = millis();
    const uint16_t peak = i2sPeakSinceReport;
    i2sPeakSinceReport = 0;

    JsonDocument document;
    document["type"] = "diagnostic";
    document["state"] =
        a2dp.get_connection_state() == ESP_A2D_CONNECTION_STATE_CONNECTED
            ? "connected"
            : (a2dpStarted ? "searching" : "usb");
    document["target"] = targetName;
    document["message"] = "I2S frames=" + String(i2sFramesReceived) +
                          ", peak=" + String(peak) +
                          "; A2DP frames=" + String(a2dpFramesRequested) + ".";
    char addressText[18] = "";
    if (haveCachedAddress) {
      snprintf(addressText, sizeof(addressText),
               "%02x:%02x:%02x:%02x:%02x:%02x", cachedAddress[0],
               cachedAddress[1], cachedAddress[2], cachedAddress[3],
               cachedAddress[4], cachedAddress[5]);
    }
    /* Field name kept: it is the address this chip knows, and the bench
     * scripts that read this line should not have to change for a rename. */
    document["known_addr"] = addressText;
    document["a2dp_state"] = static_cast<int>(a2dp.get_connection_state());
    document["i2s_frames"] = i2sFramesReceived;
    document["i2s_peak"] = peak;
    document["a2dp_frames"] = a2dpFramesRequested;
    emitDocument(document);
  }

  delay(5);
}

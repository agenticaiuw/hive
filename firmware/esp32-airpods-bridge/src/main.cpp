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
 * management over JSON (scan/connect/disconnect/forget/status), the
 * route on/off gate, connection state events, a test tone, and a
 * once-a-second link-health line. Volume control is the nRF's job — it
 * pre-scales the PCM it sends; this chip plays what it is given. Bring-up
 * instrumentation (pin probes, clock timing, raw slot captures, ring
 * dumps) does not come back.
 *
 * WHICH DEVICE TO CONNECT IS THE nRF's DECISION, NOT THIS CHIP'S
 * (2026-08-12, sharpened 2026-08-13: "the esp32 should only do its own
 * job of a bluetooth module.").
 * ------------------------------------------------------------------
 * The owner, watching the pendant hunt for one particular speaker:
 * "why is it hunting for my bluetooth speaker specifically? shouldn't it
 * discover the bluetooth devices and prioritize those that were connected
 * before?" It was hunting because TWO components each held an opinion
 * about which sink to use — the nRF9160's 4-entry LRU table (the one the
 * owner actually scrolls, `firmware/nrf9160/src/pendant_bt.c`) and this
 * chip's own boot auto-reconnect plus a cached address it paged on its
 * own timer. Two opinions is one too many.
 *
 * An earlier pass here kept a one-entry address CACHE (survived reboot in
 * NVS) and re-paged it automatically every 30 s while a commanded link
 * was down, on the theory that this was "link maintenance," not
 * selection. It was still a second opinion: memory the owner could not
 * see, and a retry the nRF never asked for. Both are gone. This chip now
 * holds NOTHING across a reboot and NOTHING across a `disconnect` or
 * `forget` — connect by the SAME address twice costs the nRF one more
 * JSON line, which is cheap, against a chip that silently remembers
 * something the owner cannot inspect, which is not.
 *
 * Consequently: `connect` takes an EXPLICIT `addr`, never a name. Name
 * inquiry ("is the device with THIS name currently discoverable") and
 * address paging ("is the device at THIS address currently reachable")
 * answer different questions, and blending them behind one `target`
 * string is exactly how this chip used to acquire opinions of its own.
 * `scan` is the only thing that ever looks at a name — to report it,
 * never to act on it. A failed `connect` reports the failure and stops;
 * it does not fall back to a cached address, and it does not retry on a
 * timer. Retry policy, like device selection, is the nRF's to run.
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
 * Two FreeRTOS tasks write JSON lines here: Arduino's loopTask (commands,
 * status, diagnostics) and the Bluetooth stack's own app task (discovery
 * results, straight out of the ssid_callback). Without serializing them, one
 * task's bytes can land on the wire in the middle of the other's — observed
 * on the bench as a `connect`/`disconnect` acknowledgement with a field
 * silently eaten (`"event":"disconnect"true,...` — an interleaved discovery
 * line had spliced into it) while the module chip's command link was live.
 * A truncated line is something the nRF's parser already tolerates by
 * contract (see pendant_bt.c); a SPLICED line is not truncated, so it can
 * pass the naive checks and be read wrong. One line, one task, at a time.
 */
SemaphoreHandle_t serialLock = nullptr;

/*
 * Every event goes to BOTH ports. USB is a human with a serial monitor;
 * UART2 is the main chip. Writing to only one of them would create a
 * behaviour the other cannot see, which is exactly the divergence the
 * two-ports-one-command-set rule exists to prevent.
 */
void emitLine(const String &line) {
  if (serialLock != nullptr) {
    xSemaphoreTake(serialLock, portMAX_DELAY);
  }
  Serial.println(line);
  moduleSerial.println(line);
  if (serialLock != nullptr) {
    xSemaphoreGive(serialLock);
  }
}

void emitDocument(JsonDocument &document) {
  String line;
  serializeJson(document, line);
  emitLine(line);
}

/*
 * No speaker is compiled in and none is remembered as a preference, in RAM
 * or in NVS. The bridge connects to exactly the address it was last
 * COMMANDED to connect to, and only after being commanded. There is no
 * retry timer: a link that drops is reported, and the nRF decides whether
 * and when to send another `connect`.
 */
/*
 * A `scan` with no `ms` runs this long before it stops itself and reports
 * how many devices it found. Bounded by construction — this chip must not
 * key the Bluetooth radio open forever because a command was never
 * answered.
 *
 * SCAN_MIN_MS is NOT an arbitrary floor. Measured on the bench: the vendored
 * ESP32-A2DP library hard-codes a 10 s `delay_ms(10000)` in its own stack-up
 * handler before it calls `esp_bt_gap_start_discovery()` at all — a `scan`
 * bounded any shorter than that reports zero devices every time, regardless
 * of what is actually nearby, because the inquiry never ran. A `scan` this
 * chip cannot honestly answer within 5 s (an example figure from an earlier
 * draft of this protocol) simply does not exist on this hardware; the nRF
 * should expect scan latency on this order, not assume a fast local radio.
 */
constexpr uint32_t SCAN_MIN_MS = 11000;
constexpr uint32_t SCAN_DEFAULT_MS = 15000;
constexpr uint32_t SCAN_MAX_MS = 30000;

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
/*
 * The address the nRF commanded, THIS SESSION ONLY. Empty until a `connect`
 * arrives; emptied again by `scan`, `disconnect`, or `forget`. Nothing here
 * survives a reboot and nothing here is written to NVS — the moment this
 * chip starts remembering a device across a power cycle it has an opinion
 * again, and opinions are the nRF's job (its 4-entry LRU lives in
 * `firmware/nrf9160/src/pendant_bt.c`, persisted to the card, not here).
 */
esp_bd_addr_t commandedAddr = {0, 0, 0, 0, 0, 0};
bool haveCommandedAddr = false;
/* Purely cosmetic: an optional human-readable label the nRF may send
 * alongside `addr` in a `connect` command, echoed back in messages so a
 * human on the USB console can read something friendlier than hex. It is
 * NEVER compared against a discovered device name and never drives any
 * decision — the address is the only thing this chip acts on. */
String commandedLabel;
bool a2dpStarted = false;
/* True only inside a bounded `scan` window; false the instant it ends
 * (deadline reached, or a later command tears the session down). */
bool scanning = false;
uint32_t scanDeadlineAt = 0;
uint32_t scanDevicesReported = 0;

/*
 * An all-zero BD_ADDR is not an address, and treating it as one is a live
 * hole rather than a theoretical one.
 *
 * `set_auto_reconnect(addr, n)` would store the address we hand it in the
 * library's `last_connection`; if that address is all zeros the library
 * decides it has NO last connection, falls back to reading its OWN NVS
 * namespace ("connected_bda"), and pages whichever peer IT last saw — which
 * is exactly the kind of second device-selection opinion this file exists
 * to not have. `set_auto_reconnect` is therefore never called with `true`
 * anywhere in this file (see resetA2dpSession()); this check exists only to
 * reject a malformed `connect addr` before it is acted on at all.
 */
bool addressIsSet(const esp_bd_addr_t address) {
  for (int i = 0; i < ESP_BD_ADDR_LEN; i++) {
    if (address[i] != 0) {
      return true;
    }
  }
  return false;
}

/*
 * Parse "aa:bb:cc:dd:ee:ff" (case-insensitive) into a BD address. Returns
 * false on any malformed input, including a well-formed all-zero address —
 * that is never a real peer, only ever a mistake.
 */
bool parseAddress(const String &text, esp_bd_addr_t &out) {
  unsigned int bytes[ESP_BD_ADDR_LEN];
  if (text.length() != 17) {
    return false;
  }
  if (sscanf(text.c_str(), "%2x:%2x:%2x:%2x:%2x:%2x", &bytes[0], &bytes[1],
             &bytes[2], &bytes[3], &bytes[4], &bytes[5]) != ESP_BD_ADDR_LEN) {
    return false;
  }
  for (int i = 0; i < ESP_BD_ADDR_LEN; i++) {
    out[i] = static_cast<uint8_t>(bytes[i]);
  }
  return addressIsSet(out);
}

String addressToString(const esp_bd_addr_t address) {
  char text[18];
  snprintf(text, sizeof(text), "%02x:%02x:%02x:%02x:%02x:%02x", address[0],
           address[1], address[2], address[3], address[4], address[5]);
  return String(text);
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

/* The library's own enum, spelled out for a human or a bench script reading
 * the raw a2dp state independent of this file's own "searching/usb/connected"
 * summary — the two answer different questions (link-layer state vs. "is the
 * menu still filling") and collapsing them lost information the old status
 * line never carried. */
const char *a2dpStateName(esp_a2d_connection_state_t state) {
  switch (state) {
  case ESP_A2D_CONNECTION_STATE_CONNECTED:
    return "connected";
  case ESP_A2D_CONNECTION_STATE_CONNECTING:
    return "connecting";
  case ESP_A2D_CONNECTION_STATE_DISCONNECTING:
    return "disconnecting";
  default:
    return "disconnected";
  }
}

/*
 * Every bridge event, whatever triggered it, carries the same three facts a
 * BM83-class module would report on its status line: is a link up, what
 * address is it up with (or was last commanded), and the raw a2dp state.
 * `addr` is intentionally the ONLY device identifier here — see the header
 * note on why a name is never part of this chip's decision surface. `event`
 * is optional and marks a command's direct acknowledgement (e.g. "connect",
 * "disconnect") rather than an unsolicited state change; absent, this is a
 * plain state-change line exactly like before this field existed.
 */
void emitEvent(const char *state, const String &message,
               const char *event = nullptr) {
  JsonDocument document;
  /* Machine-readable fields first, prose last — the nRF truncates at a
   * fixed line length and must never lose `addr` to a long message. */
  document["type"] = "bridge";
  document["state"] = state;
  if (event != nullptr) {
    document["event"] = event;
  }
  document["connected"] =
      a2dp.get_connection_state() == ESP_A2D_CONNECTION_STATE_CONNECTED;
  const String addrText =
      haveCommandedAddr ? addressToString(commandedAddr) : "";
  document["addr"] = addrText;
  document["a2dp"] = a2dpStateName(a2dp.get_connection_state());
  /* Kept under its old name too: some bench tooling still reads `target`,
   * and it is now simply an alias for `addr` (never a name — nothing on
   * this chip is keyed by name any more). */
  document["target"] = addrText;
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
    emitEvent("searching", "Bluetooth is connecting to the commanded address.");
    break;
  case ESP_A2D_CONNECTION_STATE_DISCONNECTING:
    emitEvent("usb", "Bluetooth link is disconnecting.");
    break;
  default:
    /* Two different states wear the same "not connected" hat: a scan with no
     * address in mind, and a page of a commanded one. The nRF reads this
     * line to decide whether its menu is still filling, so it must say which. */
    emitEvent(a2dpStarted ? "searching" : "usb",
              !a2dpStarted ? "USB ready; no Bluetooth activity."
              : scanning   ? "Bluetooth is scanning for nearby devices."
              : haveCommandedAddr
                  ? "Bluetooth is looking for the commanded address."
                  : "Bluetooth is idle.");
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

/*
 * DISARM `set_auto_reconnect` the moment it has done its one legitimate
 * job. This is not tidiness — it closes a real hole, found by reading the
 * vendored library's source rather than trusting the retries=0 argument in
 * beginConnect()'s own comment, after being pushed to prove rather than
 * assert it:
 *
 * `set_auto_reconnect(addr, 0)` sets `reconnect_status = AutoReconnect`
 * UNCONDITIONALLY — the retry COUNT is a separate field, and 0 retries does
 * NOT, by itself, mean "do nothing on a drop". Inside the library's own
 * `handle_reconnect_logic()` (BluetoothA2DPSource.cpp), when
 * `reconnect_status == AutoReconnect` but `reconnect_retries` has hit 0,
 * there is a SECOND branch — not a retry of the same peer, but:
 *   reconnect_status = NoReconnect;
 *   s_a2d_state = APP_AV_STATE_DISCOVERING;
 *   esp_bt_gap_start_discovery(ESP_BT_INQ_MODE_GENERAL_INQUIRY, 10, 0);
 * i.e. the library keys the radio into an inquiry ON ITS OWN, on the very
 * first heartbeat after ANY disconnect, commanded by nobody. Discovery
 * alone cannot make this chip connect to anything unasked (scan's
 * ssid_callback always returns false — see reportDiscoveredDevice()), but
 * a scan the nRF never asked for, running because the speaker dropped, is
 * still this chip acting on its own — exactly what the owner's ruling
 * forbids, and exactly the shape of bug this project has already hit twice
 * today from trusting a library's internal gate as if it were a contract.
 *
 * The fix is not "trust retries=0 harder" — it is to never let
 * `reconnect_status` sit at `AutoReconnect` any longer than the one
 * `start()` call that needs it. `process_user_state_callbacks()` invokes
 * this callback BEFORE the library's own FSM switch runs for the same
 * event, so disarming here on CONNECTED (and defensively on DISCONNECTED,
 * in case CONNECTED is ever skipped) always lands before
 * `handle_reconnect_logic()` can act on that event. Once `reconnect_status`
 * is `NoReconnect`, BOTH of its branches (retry, and this discovery
 * fallback) are unreachable — verified by reading every call site of
 * `reconnect_status` in the vendored source, not merely the one guard
 * `beginConnect()`'s comment names.
 *
 * DO NOT set `reconnect_status` to `AutoReconnect` (i.e. do not call
 * `set_auto_reconnect` with a truthy first argument, or with an address,
 * for longer than the single `start()` call in beginConnect()) anywhere
 * else in this file. If you are tempted to raise `max_retries` above 0 to
 * "make reconnects more reliable", read this comment again first — that
 * is the owner's ruling this file exists to enforce.
 */
void onConnectionState(esp_a2d_connection_state_t state, void *) {
  if (state == ESP_A2D_CONNECTION_STATE_CONNECTED ||
      state == ESP_A2D_CONNECTION_STATE_DISCONNECTED) {
    a2dp.set_auto_reconnect(false, 0);
  }
  pendingConnectionState = state;
  connectionStateChanged = true;
}

/*
 * Scan-only discovery reporting. ALWAYS returns false: matching a discovered
 * device against anything, even the address the nRF last commanded, is this
 * chip choosing again. Every device found is reported and none is acted on
 * — connecting to one is a separate, later `connect` command naming an
 * address, sent by whoever is deciding (the nRF, or a human operator during
 * bring-up).
 */
bool reportDiscoveredDevice(const char *deviceName, esp_bd_addr_t address,
                             int rssi) {
  if (deviceName == nullptr) {
    return false;
  }

  String found(deviceName);
  ++scanDevicesReported;

  JsonDocument document;
  /* Field order is the contract with the nRF's fixed-size line buffer:
   * device and address are what the sink table is built from, so they come
   * before rssi and long before the human-readable message. */
  document["type"] = "discovery";
  document["state"] = "searching";
  document["device"] = found;
  document["address"] = addressToString(address);
  document["rssi"] = rssi;
  document["message"] = "Found \"" + found + "\" (" + String(rssi) + " dBm).";
  emitDocument(document);

  return false;
}

/*
 * Immediate acknowledgement of a `connect` or `disconnect` command. `ok`
 * here means "the command was well-formed and the radio attempt was
 * issued" — NOT "the link is up". A2DP pairing/connect is asynchronous and
 * can take several seconds; the definitive outcome arrives afterward as an
 * ordinary unsolicited `state` bridge event (connected, or disconnected —
 * see loop()). Two lines for one command is deliberate: a fast ack the nRF
 * can use to know its command landed, and a later fact it can use to know
 * what actually happened.
 */
void emitCommandAck(const char *event, bool ok, const String &addrText,
                     const char *reason, const String &message) {
  JsonDocument document;
  document["type"] = "bridge";
  document["event"] = event;
  document["ok"] = ok;
  document["addr"] = addrText;
  if (reason != nullptr) {
    document["reason"] = reason;
  }
  document["message"] = message;
  emitDocument(document);
}

/*
 * Common prologue for both `scan` and `connect`: tear down any existing
 * session and reinstall the fixed capabilities and callbacks. Does NOT call
 * `a2dp.start()` — the caller decides `set_auto_reconnect(...)` first (see
 * the note in beginConnect() on why that call, despite its name, is not
 * optional) and starts the stack itself, because that ordering matters and
 * differs between `scan` and `connect`.
 */
void resetA2dpSession() {
  if (a2dpStarted) {
    a2dp.end(false);
    a2dpStarted = false;
    delay(300);
  }
  clearAudioBuffer();
  a2dp.set_data_callback_in_frames(provideA2dpFrames);
  a2dp.set_ssid_callback(reportDiscoveredDevice);
  a2dp.set_on_connection_state_changed(onConnectionState);
  /* Legacy speakers that still demand a fixed PIN accept the usual one. */
  a2dp.set_pin_code("0000", ESP_BT_PIN_TYPE_FIXED);
  a2dp.set_volume(80);
}

void beginScan(uint32_t ms) {
  resetA2dpSession();
  haveCommandedAddr = false;
  commandedLabel = "";
  /*
   * Never `set_auto_reconnect(true)`: a scan has no address for the library
   * to page even if it wanted to, and this keeps its internal state machine
   * on the plain discovery branch — exactly what reportDiscoveredDevice()
   * expects to be reporting against.
   */
  a2dp.set_auto_reconnect(false, 0);
  a2dp.start();
  a2dpStarted = true;
  scanning = true;
  scanDevicesReported = 0;
  scanDeadlineAt = millis() + ms;
  emitEvent("searching", "Scanning for nearby Bluetooth audio devices for " +
                              String(ms) + " ms.");
}

/* Called from loop() once a bounded scan's deadline passes. Reports how many
 * devices were seen and stops keying the radio open — see SCAN_DEFAULT_MS.
 * Settles on the same 300 ms as resetA2dpSession()'s own teardown: a `stop
 * scan; connect` sequence tears down here, then resetA2dpSession() sees
 * a2dpStarted already false and skips ITS OWN settle delay, so this one has
 * to be paid regardless of which path tore the stack down. Measured on the
 * bench without it: connect_to() right after a scan-triggered end() returned
 * false ("page_not_issued") even though the address was correct and the
 * speaker was on — not a rejection, a race. */
void finishScan() {
  scanning = false;
  emitEvent("usb",
            "Scan finished; " + String(scanDevicesReported) +
                " device(s) reported.",
            "scan_result");
  if (a2dpStarted) {
    a2dp.end(false);
    a2dpStarted = false;
    delay(300);
  }
}

/*
 * Page an EXPLICIT address directly — no discovery, no name, no fallback.
 * `label` is optional and cosmetic only (see commandedLabel).
 *
 * MEASURED ON THE BENCH, not assumed from reading the library: a bare
 * `a2dp.connect_to(address)` genuinely opens the Bluetooth profile
 * connection (confirmed — the raw ESP-IDF connection state read back
 * CONNECTED) but audio never plays. The vendored library only drives its
 * OWN internal media-start handshake (CHECK_SRC_RDY, then START — the
 * thing that actually makes provideA2dpFrames() get called) once ITS
 * internal state machine reaches its own "connected" state, and the ONLY
 * path into that state this library exposes is `set_auto_reconnect(addr,
 * retries)` called BEFORE `start()`, which makes `start()` itself page
 * `addr` through the same internal path a scan-then-match would have used.
 * A `connect_to()` called from outside that machine, as this file did
 * before, is invisible to it.
 *
 * `retries` is pinned to 0 on purpose. The name "auto_reconnect" describes
 * the library's API, not a policy this chip is adopting: with 0 retries,
 * the library's OWN reconnect-on-drop logic (gated on `reconnect_retries >
 * 0`, see BluetoothA2DPSource::handle_reconnect_logic()) can never fire —
 * the FIRST page, at `start()` time, still happens (that check does not
 * gate it), but nothing pages again on a later drop without another
 * `connect` command. Same contract as before ("this chip retries nothing
 * on its own"), routed through the call the library actually requires to
 * make audio play.
 */
void beginConnect(const esp_bd_addr_t address, const String &label) {
  resetA2dpSession();
  memcpy(commandedAddr, address, ESP_BD_ADDR_LEN);
  haveCommandedAddr = true;
  commandedLabel = label;
  scanning = false;
  a2dp.set_auto_reconnect(commandedAddr, 0);
  a2dp.start();
  a2dpStarted = true;
  const String addrText = addressToString(commandedAddr);
  emitCommandAck(
      "connect", true, addrText, nullptr,
      "Connecting to " + addrText +
          (commandedLabel.isEmpty() ? String("")
                                     : " (\"" + commandedLabel + "\")") +
          ". This hardware takes roughly 10 s to begin paging after a "
          "restart; device must be on and not connected elsewhere.");
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
    /* Bounded so this chip cannot key the radio open indefinitely on its own
     * — a real module's inquiry ends; so must this one. Clamped rather than
     * rejected: a slightly-too-large or missing `ms` is not worth failing a
     * scan over. */
    uint32_t ms = document["ms"] | SCAN_DEFAULT_MS;
    ms = constrain(ms, SCAN_MIN_MS, SCAN_MAX_MS);
    beginScan(ms);
  } else if (command == "connect") {
    /*
     * Address only. A `target`/name field is not read here at all — see the
     * header note on why name-matching does not exist any more. `name` is
     * accepted purely as an optional cosmetic label for log messages.
     */
    const String addrField = String(document["addr"] | "");
    esp_bd_addr_t parsed;
    if (!parseAddress(addrField, parsed)) {
      emitCommandAck("connect", false, "",
                      addrField.isEmpty() ? "missing_addr" : "invalid_addr",
                      "The connect command needs a valid \"addr\" like "
                      "\"aa:bb:cc:dd:ee:ff\"; a name is not enough.");
      return;
    }
    const String label = String(document["name"] | "");
    beginConnect(parsed, label);
  } else if (command == "disconnect") {
    /* Idempotent: asking an already-idle module to disconnect is not an
     * error. The actual link teardown (if any was up) is reported again,
     * separately, as an ordinary state event once the stack confirms it —
     * this ack only means the command was received and acted on. */
    const String addrText =
        haveCommandedAddr ? addressToString(commandedAddr) : "";
    if (a2dpStarted) {
      a2dp.disconnect();
    }
    haveCommandedAddr = false;
    commandedLabel = "";
    scanning = false;
    emitCommandAck("disconnect", true, addrText, nullptr,
                    "Disconnecting the current Bluetooth link.");
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
    haveCommandedAddr = false;
    commandedLabel = "";
    scanning = false;
    clearAudioBuffer();
    emitEvent("usb", "Pairing cleared; no address is commanded.");
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
  // Before anything else can call emitLine(): the Bluetooth app task can
  // start emitting discovery lines within a few hundred ms of a2dp.start().
  serialLock = xSemaphoreCreateMutex();
  Serial.begin(115200);
  moduleSerial.begin(MODULE_UART_BAUD, SERIAL_8N1, MODULE_UART_RX_PIN,
                     MODULE_UART_TX_PIN);
  delay(400);
  Serial.setTimeout(40);
  moduleSerial.setTimeout(40);

  buildResampleFilter();

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
            "nRF I2S forwarding on. Idle — no address commanded, nothing "
            "remembered. Waiting for scan/connect.");
  /*
   * Nothing else happens at boot. No inquiry, no page, no address, nothing
   * read from NVS: the nRF decides which sink the pendant wants and commands
   * it, every time, including the first time after a power cycle (owner,
   * 2026-08-12 — "shouldn't it discover the bluetooth devices and prioritize
   * those that were connected before?"; sharpened 2026-08-13 — "the esp32
   * should only do its own job of a bluetooth module"). A chip that
   * reconnected — or remembered — on its own would be the second opinion
   * that made the pendant hunt for one speaker.
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
    case ESP_A2D_CONNECTION_STATE_CONNECTED:
      emitEvent("connected", "Bluetooth speaker connected. A2DP is streaming.");
      break;
    case ESP_A2D_CONNECTION_STATE_CONNECTING:
      emitEvent("searching",
                "Bluetooth target found; opening the A2DP link.");
      break;
    case ESP_A2D_CONNECTION_STATE_DISCONNECTED:
      /*
       * Honest about who retries: nobody, here. The library's own reconnect
       * is off (set_auto_reconnect(false, 0)) and this file has no retry
       * timer of its own any more — a dropped or failed link is reported and
       * this chip then does nothing until the next `connect` command. Saying
       * "retrying" would promise a behaviour that no longer exists; deciding
       * whether to retry, and when, is the nRF's job now.
       */
      emitEvent(a2dpStarted ? "searching" : "usb", "Bluetooth disconnected.");
      break;
    default:
      emitEvent("usb", "Bluetooth link is disconnecting.");
      break;
    }
  }

  /*
   * A bounded `scan` stops itself; nothing pages a device on its own here.
   */
  if (scanning && static_cast<int32_t>(millis() - scanDeadlineAt) >= 0) {
    finishScan();
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
    document["target"] =
        haveCommandedAddr ? addressToString(commandedAddr) : "";
    document["message"] = "I2S frames=" + String(i2sFramesReceived) +
                          ", peak=" + String(peak) +
                          "; A2DP frames=" + String(a2dpFramesRequested) + ".";
    /* Field name kept: it is the address this chip was last commanded to
     * reach (session-only, never NVS), and the bench scripts that read this
     * line should not have to change for a rename. */
    document["known_addr"] =
        haveCommandedAddr ? addressToString(commandedAddr) : "";
    document["a2dp_state"] = static_cast<int>(a2dp.get_connection_state());
    document["i2s_frames"] = i2sFramesReceived;
    document["i2s_peak"] = peak;
    document["a2dp_frames"] = a2dpFramesRequested;
    emitDocument(document);
  }

  delay(5);
}

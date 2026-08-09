#include <Arduino.h>
#include <ArduinoJson.h>
#include <BluetoothA2DPSource.h>
#include <Preferences.h>
#include <driver/i2s_std.h>
#include <esp_gap_bt_api.h>
#include <soc/gpio_struct.h>
#include <xtensa/core-macros.h>

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
 * No speaker is compiled in. The bridge remembers whatever it last connected
 * to — name in NVS "target", address in NVS "addr" — and pages that address
 * on boot, which also covers a bonded device that is powered on but not
 * discoverable. With nothing remembered it waits for a `connect` or `scan`
 * command rather than guessing at a device the owner may not even own.
 */
// How often to re-page the known address while the link is down.
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
constexpr size_t RAW_CAPTURE_FRAMES = 64;
constexpr int16_t STREAM_SYNC_A = 0x2468;
constexpr int16_t STREAM_SYNC_B = 0x5A5A;
constexpr int16_t STREAM_SYNC_END = 0x6C6C;
constexpr uint8_t STREAM_SYNC_MATCHES_REQUIRED = 8;

BluetoothA2DPSource a2dp;
Preferences preferences;
String targetName;
bool a2dpStarted = false;
bool discoveryOnly = false;
volatile bool targetSelectionPending = false;
/*
 * The BD_ADDR of the last device we actually connected to, persisted.
 *
 * Discovery by NAME only finds a device that is currently discoverable, and
 * headphones are discoverable only in pairing mode — AirPods sitting in your
 * ears or in the case never answer an inquiry, so a name scan searches
 * forever. Paging a known address works on any bonded device that is simply
 * powered on. This is why an address-first reconnect works for any bonded
 * sink, while a name-only search only ever found discoverable ones.
 */
esp_bd_addr_t knownAddress = {0, 0, 0, 0, 0, 0};
bool haveKnownAddress = false;
volatile esp_a2d_connection_state_t pendingConnectionState =
    ESP_A2D_CONNECTION_STATE_DISCONNECTED;
volatile bool connectionStateChanged = false;
volatile uint32_t i2sFramesReceived = 0;
volatile uint32_t i2sReadErrors = 0;
volatile uint16_t i2sPeakSinceReport = 0;
volatile uint16_t i2sRawPeakSinceReport = 0;
volatile uint32_t i2sReceiverResyncs = 0;
volatile uint32_t i2sSyncLocks = 0;
volatile uint32_t a2dpFramesRequested = 0;
volatile uint32_t a2dpNonzeroFrames = 0;
volatile uint32_t ringOverruns = 0;
volatile uint32_t ringUnderruns = 0;
/*
 * The RX DMA drops a whole descriptor silently when the capture task is late:
 * i2s_channel_read returns ESP_OK and simply never shows those frames. That
 * loss was invisible until now, and it is exactly what starves the resampler,
 * so count the driver's own overflow event and the worst read-to-read gap.
 */
volatile uint32_t i2sRxOverflows = 0;
volatile uint32_t i2sMaxReadGapUs = 0;
// ESP_OK once the driver accepts the overflow hook; reported in the status.
esp_err_t i2sOverflowCallbackStatus = ESP_FAIL;

// Runs from the I2S ISR: must be in IRAM and must not call into flash.
bool IRAM_ATTR onI2sRecvOverflow(i2s_chan_handle_t, i2s_event_data_t *,
                                 void *) {
  ++i2sRxOverflows;
  return false;
}
volatile uint32_t resamplerStarts = 0;
volatile uint32_t resamplerSlips = 0;
volatile uint32_t a2dpCallCount = 0;
volatile uint32_t a2dpCallMicros = 0;
volatile uint32_t a2dpMaxFrameCount = 0;
volatile uint32_t testToneFramesRemaining = 0;
volatile uint32_t testTonePhase = 0;
volatile bool i2sForwardingEnabled = true;
volatile bool rawCaptureReady = false;
volatile bool rawCaptureAwaitAudio = false;
volatile bool clockCaptureRequested = false;
volatile size_t rawCaptureFrames = 0;
int32_t rawCapture[RAW_CAPTURE_FRAMES * 2];

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
 * from the nRF side, which has memory to spare, or over the ring dump
 * below (64 frames) which costs nothing.
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
portMUX_TYPE ringMux = portMUX_INITIALIZER_UNLOCKED;

void emitEvent(const char *state, const String &message) {
  JsonDocument document;
  document["type"] = "bridge";
  document["state"] = state;
  document["message"] = message;
  document["target"] = targetName;
  serializeJson(document, Serial);
  Serial.println();
}

void emitStatus() {
  const esp_a2d_connection_state_t state = a2dp.get_connection_state();
  switch (state) {
  case ESP_A2D_CONNECTION_STATE_CONNECTED:
    emitEvent("connected", "AirPods A2DP link is connected.");
    break;
  case ESP_A2D_CONNECTION_STATE_CONNECTING:
    emitEvent("searching", "Bluetooth is connecting to the selected target.");
    break;
  case ESP_A2D_CONNECTION_STATE_DISCONNECTING:
    emitEvent("usb", "Bluetooth link is disconnecting.");
    break;
  default:
    emitEvent(a2dpStarted ? "searching" : "usb",
              a2dpStarted ? "Bluetooth is scanning for the selected target."
                          : "USB ready; no Bluetooth search is active.");
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
    ++ringOverruns;
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

inline bool readGpioFast(gpio_num_t pin) {
  const uint32_t number = static_cast<uint32_t>(pin);
  return number < 32 ? ((GPIO.in >> number) & 1U)
                     : ((GPIO.in1.data >> (number - 32)) & 1U);
}

bool probeOneLeftSlot(uint32_t &bits, uint8_t &edgeCount) {
  const uint32_t deadline = micros() + 5000U;

  // Synchronize to the high-to-low LRCK edge that begins the left slot.
  while (!readGpioFast(I2S_LRC_PIN)) {
    if (static_cast<int32_t>(micros() - deadline) >= 0) {
      return false;
    }
  }
  while (readGpioFast(I2S_LRC_PIN)) {
    if (static_cast<int32_t>(micros() - deadline) >= 0) {
      return false;
    }
  }

  bits = 0;
  edgeCount = 0;
  bool previousClock = readGpioFast(I2S_BCLK_PIN);
  const uint32_t cycleDeadline = XTHAL_GET_CCOUNT() + 1200000U;
  while (!readGpioFast(I2S_LRC_PIN) && edgeCount < 24) {
    const bool clock = readGpioFast(I2S_BCLK_PIN);
    if (clock && !previousClock) {
      bits = (bits << 1) | (readGpioFast(I2S_DATA_PIN) ? 1U : 0U);
      ++edgeCount;
    }
    previousClock = clock;
    if (static_cast<int32_t>(XTHAL_GET_CCOUNT() - cycleDeadline) >= 0) {
      return false;
    }
  }
  return edgeCount > 0;
}

void emitPinProbe() {
  uint32_t words[16] = {};
  uint8_t edges[16] = {};
  size_t captured = 0;

  for (size_t attempt = 0; attempt < 64 && captured < 16; ++attempt) {
    uint32_t bits;
    uint8_t edgeCount;
    if (probeOneLeftSlot(bits, edgeCount)) {
      words[captured] = bits;
      edges[captured] = edgeCount;
      ++captured;
    }
  }

  Serial.print("{\"type\":\"pin_probe\",\"slots\":[");
  for (size_t index = 0; index < captured; ++index) {
    if (index != 0) {
      Serial.print(',');
    }
    Serial.print("{\"edges\":");
    Serial.print(edges[index]);
    Serial.print(",\"bits\":");
    Serial.print(words[index]);
    Serial.print('}');
  }
  Serial.println("]}");
}

uint32_t measureRisingFrequency(gpio_num_t pin, uint32_t edgeTarget) {
  const uint32_t cyclesPerSecond = ESP.getCpuFreqMHz() * 1000000U;
  const uint32_t timeoutCycles = cyclesPerSecond / 20U;
  uint32_t deadline = XTHAL_GET_CCOUNT() + timeoutCycles;

  bool previous = readGpioFast(pin);
  while (true) {
    const bool current = readGpioFast(pin);
    if (current && !previous) {
      break;
    }
    previous = current;
    if (static_cast<int32_t>(XTHAL_GET_CCOUNT() - deadline) >= 0) {
      return 0;
    }
  }

  const uint32_t firstEdgeAt = XTHAL_GET_CCOUNT();
  uint32_t edges = 1;
  deadline = firstEdgeAt + timeoutCycles;
  previous = true;
  while (edges < edgeTarget) {
    const bool current = readGpioFast(pin);
    if (current && !previous) {
      ++edges;
    }
    previous = current;
    if (static_cast<int32_t>(XTHAL_GET_CCOUNT() - deadline) >= 0) {
      return 0;
    }
  }

  const uint32_t elapsed = XTHAL_GET_CCOUNT() - firstEdgeAt;
  return elapsed == 0
             ? 0
             : static_cast<uint32_t>(
                   (static_cast<uint64_t>(edgeTarget - 1U) *
                    cyclesPerSecond) /
                   elapsed);
}

void emitClockTiming() {
  const uint32_t bclk = measureRisingFrequency(I2S_BCLK_PIN, 512);
  const uint32_t lrck = measureRisingFrequency(I2S_LRC_PIN, 32);
  Serial.print("{\"type\":\"clock_timing\",\"bclk_hz\":");
  Serial.print(bclk);
  Serial.print(",\"lrck_hz\":");
  Serial.print(lrck);
  Serial.print(",\"bclk_per_frame\":");
  Serial.print(lrck == 0 ? 0.0 : static_cast<double>(bclk) / lrck, 2);
  Serial.println("}");
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
      ++i2sReadErrors;
      vTaskDelay(pdMS_TO_TICKS(5));
      continue;
    }
    if (bytesRead == 0) {
      continue;
    }

    /*
     * Time between successive completed reads. One 256-frame block is
     * 8.192 ms at 31250 Hz and the DMA holds 8 of them (65.5 ms), so a gap
     * approaching 65 ms means the driver had to overwrite undelivered audio.
     */
    {
      static uint32_t lastReadAtUs = 0;
      const uint32_t nowUs = micros();
      if (lastReadAtUs != 0) {
        const uint32_t gap = nowUs - lastReadAtUs;
        if (gap > i2sMaxReadGapUs) {
          i2sMaxReadGapUs = gap;
        }
      }
      lastReadAtUs = nowUs;
    }

    const uint32_t receivedAt = millis();
    if (lastBlockAt == 0 || receivedAt - lastBlockAt > 250) {
      /*
       * The nRF gates BCLK while no audio is queued. The original ESP32 I2S
       * slave can latch one bit early when that external clock restarts.
       * Reset the RX state machine while BCLK/WS are active, discard the
       * first DMA block, and begin with the next complete stereo frame.
       */
      const esp_err_t disableResult = i2s_channel_disable(i2sInput);
      const esp_err_t enableResult = i2s_channel_enable(i2sInput);
      if (disableResult != ESP_OK || enableResult != ESP_OK) {
        ++i2sReadErrors;
      }
      ++i2sReceiverResyncs;
      clearAudioBuffer();
      rawCaptureFrames = 0;
      rawCaptureReady = false;
      clockCaptureRequested = true;
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
      if (rawCaptureAwaitAudio) {
        // Wait for a LOUD sample: quiet words are ambiguous between slot
        // alignments (256<<8 and 1<<16 are the same 32-bit value), so only
        // a large magnitude can prove which one is real.
        const int32_t probe = extractSlotSample(input[frame * 2]);
        if (probe > 8000 || probe < -8000) {
          rawCaptureAwaitAudio = false;
        }
      }
      if (!rawCaptureAwaitAudio && rawCaptureFrames < RAW_CAPTURE_FRAMES) {
        rawCapture[rawCaptureFrames * 2] = input[frame * 2];
        rawCapture[rawCaptureFrames * 2 + 1] = input[frame * 2 + 1];
        ++rawCaptureFrames;
        if (rawCaptureFrames == RAW_CAPTURE_FRAMES) {
          rawCaptureReady = true;
        }
      }

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
            ++i2sSyncLocks;
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

      int32_t rawMagnitude = normalSample;
      if (rawMagnitude < 0) {
        rawMagnitude = -rawMagnitude;
      }
      if (rawMagnitude > i2sRawPeakSinceReport) {
        i2sRawPeakSinceReport = static_cast<uint16_t>(rawMagnitude);
      }

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
  const uint32_t callStartedUs = micros();
  struct CallTimer {
    uint32_t started;
    int32_t count;
    ~CallTimer() {
      a2dpCallMicros += micros() - started;
      ++a2dpCallCount;
      if (static_cast<uint32_t>(count) > a2dpMaxFrameCount) {
        a2dpMaxFrameCount = static_cast<uint32_t>(count);
      }
    }
  } callTimer{callStartedUs, frameCount};
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
        ++a2dpNonzeroFrames;
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
    ++resamplerStarts;
  }

  /*
   * The 625/882 ratio is exact, so the only correction ever needed is for
   * the genuine crystal difference between the nRF and the Bluetooth clock
   * — parts per million. Allow at most ONE slipped input sample per
   * callback (about 0.9% of the wire rate at the observed call rate), and
   * count every slip.
   *
   * This deliberately cannot paper over a large rate mismatch. If the
   * Bluetooth stack pulls materially slower than 44100 frames/s, the ring
   * climbs to the high-water mark and resampler_slips runs away — which is
   * a fault to be reported, not something to hide by stretching pitch.
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
      ++resamplerSlips;
    }
  } else if (level < static_cast<int32_t>(RESAMPLER_LOW_WATER_FRAMES)) {
    holdOneInput = true;
  }
  buffered = static_cast<size_t>(level);

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
    const int16_t sample = static_cast<int16_t>(
        constrain(scaled, static_cast<int32_t>(INT16_MIN),
                  static_cast<int32_t>(INT16_MAX)));
    frames[index].channel1 = sample;
    frames[index].channel2 = sample;
    if (sample != 0) {
      ++a2dpNonzeroFrames;
    }

    phaseIndex += RESAMPLE_M;
    if (phaseIndex >= RESAMPLE_L) {
      phaseIndex -= RESAMPLE_L;
      if (holdOneInput) {
        // Repeat the current input sample once to let the buffer refill.
        holdOneInput = false;
        ++resamplerSlips;
        continue;
      }
      int16_t incoming = 0;
      if (!popSample(incoming)) {
        ++ringUnderruns;
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
   * An empty target is scan-only mode. Do not also gate on discoveryOnly:
   * the Bluetooth callback runs on another task and can otherwise observe
   * that old flag after a scan-to-connect transition.
   */
  bool nameOrAddressMatches =
      !normalizedTarget.isEmpty() &&
      normalizedFound.indexOf(normalizedTarget) >= 0;
  if (!nameOrAddressMatches && haveKnownAddress) {
    // A remembered device that reports a different or empty name still counts.
    nameOrAddressMatches =
        memcmp(address, knownAddress, ESP_BD_ADDR_LEN) == 0;
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
  document["type"] = "discovery";
  document["state"] = "searching";
  document["message"] =
      "Found “" + found + "” (" + String(rssi) + " dBm).";
  document["device"] = found;
  document["address"] = addressText;
  document["rssi"] = rssi;
  document["target"] = targetName;
  document["matched"] = matches;
  document["duplicate_ignored"] = duplicateIgnored;
  serializeJson(document, Serial);
  Serial.println();

  return matches;
}

// True once we have somewhere to reconnect to without a fresh inquiry.
bool haveRememberedTarget() { return haveKnownAddress; }

/*
 * Page a known address directly. Works for a bonded device that is powered
 * on but not discoverable — the case a name scan can never handle.
 */
void forceKnownConnect() {
  if (!a2dpStarted) {
    return;
  }
  if (a2dp.get_connection_state() == ESP_A2D_CONNECTION_STATE_CONNECTED ||
      a2dp.get_connection_state() == ESP_A2D_CONNECTION_STATE_CONNECTING) {
    return;
  }

  if (!haveKnownAddress) {
    return;
  }
  esp_bd_addr_t *target = &knownAddress;

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
  if (!scanOnly && targetName.isEmpty() && !haveKnownAddress) {
    emitEvent("usb",
              "No Bluetooth target remembered. Send {\"command\":\"scan\"} to "
              "list devices, then {\"command\":\"connect\",\"target\":\"...\"}.");
    return;
  }

  if (a2dpStarted) {
    a2dp.end(false);
    delay(300);
  }

  clearAudioBuffer();
  discoveryOnly = scanOnly;
  targetSelectionPending = false;
  a2dp.set_data_callback_in_frames(provideA2dpFrames);
  a2dp.set_ssid_callback(targetMatches);
  a2dp.set_on_connection_state_changed(onConnectionState);
  if (!scanOnly && haveKnownAddress) {
    // Address-first reconnect for whatever we last connected to.
    a2dp.set_auto_reconnect(knownAddress, 12);
  } else {
    a2dp.set_auto_reconnect(!scanOnly, 5);
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
  if (!scanOnly && haveRememberedTarget()) {
    delay(500);
    forceKnownConnect();
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

void handleSerialCommand(const String &line) {
  JsonDocument document;
  const DeserializationError error = deserializeJson(document, line);
  if (error) {
    emitEvent("usb", "Ignored an invalid USB command.");
    return;
  }

  const String command = document["command"] | "";
  if (command == "scan") {
    targetName = "";
    startBluetoothSearch(true);
  } else if (command == "connect") {
    targetName = String(document["target"] | "");
    targetName.trim();
    if (targetName.isEmpty()) {
      emitEvent("usb", "The Bluetooth target name cannot be empty.");
      return;
    }
    if (!targetName.equalsIgnoreCase(preferences.getString("target", ""))) {
      // Switching devices: the remembered address belongs to the old one.
      haveKnownAddress = false;
      preferences.remove("addr");
    }
    preferences.putString("target", targetName);
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
  } else if (command == "capture") {
    // Re-arm the raw 32-bit word capture so it lands on real audio
    // rather than on the silence right after a resync. The bit pattern is
    // what proves or disproves slot alignment.
    rawCaptureFrames = 0;
    rawCaptureReady = false;
    rawCaptureAwaitAudio = true;
    emitEvent(a2dp.get_connection_state() ==
                      ESP_A2D_CONNECTION_STATE_CONNECTED
                  ? "connected"
                  : "usb",
              "Armed A2DP capture; recording starts at the next audio.");
  } else if (command == "dump") {
    int16_t samples[64] = {};
    size_t sampleCount = 0;
    sampleCount = min(bufferedSampleCount(), static_cast<size_t>(64));
    const size_t start =
        (ringWrite + RING_FRAMES - sampleCount) % RING_FRAMES;
    for (size_t index = 0; index < sampleCount; ++index) {
      samples[index] = ringBuffer[(start + index) % RING_FRAMES];
    }

    Serial.print("{\"type\":\"i2s_dump\",\"samples\":[");
    for (size_t index = 0; index < sampleCount; ++index) {
      if (index != 0) {
        Serial.print(',');
      }
      Serial.print(samples[index]);
    }
    Serial.println("]}");
  } else if (command == "probe") {
    emitPinProbe();
  } else if (command == "timing") {
    emitClockTiming();
  } else if (command == "forget") {
    if (a2dpStarted) {
      a2dp.end(false);
      a2dpStarted = false;
      delay(150);
    }
    removeAllBluetoothBonds();
    preferences.remove("target");
    preferences.remove("addr");
    haveKnownAddress = false;
    targetName = "";
    discoveryOnly = false;
    clearAudioBuffer();
    emitEvent("usb", "Pairing and saved target cleared.");
  } else {
    emitEvent("usb", "Unknown USB command: " + command);
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
  /*
   * Count silent DMA drops. Without this the only symptom of a late capture
   * task is audio that quietly goes missing between the wire and the ring.
   *
   * This runs from the I2S ISR, so the handler must live in IRAM. Registration
   * is best-effort on purpose: losing a diagnostic counter must never keep the
   * bridge from booting and playing audio.
   */
  {
    i2s_event_callbacks_t callbacks = {};
    callbacks.on_recv_q_ovf = onI2sRecvOverflow;
    i2sOverflowCallbackStatus =
        i2s_channel_register_event_callback(i2sInput, &callbacks, nullptr);
  }
  // A disconnected/cold DATA header joint must resolve to silence instead of
  // random full-scale samples. A valid nRF 3.3 V output overrides this pull.
  ESP_ERROR_CHECK(gpio_set_pull_mode(I2S_DATA_PIN, GPIO_PULLDOWN_ONLY));
  ESP_ERROR_CHECK(i2s_channel_enable(i2sInput));
}

} // namespace

void setup() {
  const bool maximumCpuClockSelected =
      setCpuFrequencyMhz(ESP32_MAX_CPU_CLOCK_MHZ);
  Serial.begin(115200);
  delay(400);
  Serial.setTimeout(40);
  Serial.printf(
      "{\"type\":\"max_clock_test\",\"requested_cpu_mhz\":%u,"
      "\"actual_cpu_mhz\":%u,\"selected\":%s}\n",
      ESP32_MAX_CPU_CLOCK_MHZ, ESP.getCpuFreqMHz(),
      maximumCpuClockSelected ? "true" : "false");

  buildResampleFilter();

  preferences.begin("airpods", false);
  haveKnownAddress =
      preferences.getBytes("addr", knownAddress, ESP_BD_ADDR_LEN) ==
      ESP_BD_ADDR_LEN;
  targetName = preferences.getString("target", "");

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
            "HUZZAH32 ready: LRC=33, BCLK=27, DATA=14, nRF I2S forwarding "
            "on. A2DP target: " +
                (targetName.isEmpty() ? String("none remembered — send scan/connect")
                                      : targetName) +
                ".");
  // Reconnect to the remembered sink on boot; otherwise wait for a command.
  if (haveKnownAddress || !targetName.isEmpty()) {
    startBluetoothSearch(false);
  }
}

void loop() {
  static String incoming;
  static uint32_t lastDiagnosticAt = 0;
  static bool rawCapturePrinted = false;
  while (Serial.available()) {
    const char character = static_cast<char>(Serial.read());
    if (character == '\n') {
      incoming.trim();
      if (!incoming.isEmpty()) {
        handleSerialCommand(incoming);
      }
      incoming = "";
    } else if (character != '\r' && incoming.length() < 512) {
      incoming += character;
    }
  }

  if (connectionStateChanged) {
    connectionStateChanged = false;
    switch (pendingConnectionState) {
    case ESP_A2D_CONNECTION_STATE_CONNECTED: {
      // Remember who answered, so the next reconnect can page instead of
      // scan. Only a real connection proves the address is reachable.
      esp_bd_addr_t *peer = a2dp.get_last_peer_address();
      if (peer != nullptr) {
        memcpy(knownAddress, *peer, ESP_BD_ADDR_LEN);
        haveKnownAddress = true;
        preferences.putBytes("addr", knownAddress, ESP_BD_ADDR_LEN);
      }
      emitEvent("connected",
                "Bluetooth speaker connected. A2DP is streaming at 50%.");
      break;
    }
    case ESP_A2D_CONNECTION_STATE_CONNECTING:
      emitEvent("searching",
                "Bluetooth target found; opening the A2DP link.");
      break;
    case ESP_A2D_CONNECTION_STATE_DISCONNECTED:
      emitEvent(a2dpStarted ? "searching" : "usb",
                a2dpStarted ? "Bluetooth disconnected; scanning will resume."
                            : "Bluetooth disconnected.");
      break;
    default:
      emitEvent("usb", "Bluetooth link is disconnecting.");
      break;
    }
  }

  if (clockCaptureRequested) {
    clockCaptureRequested = false;
    emitClockTiming();
  }

  if (rawCaptureReady && !rawCapturePrinted) {
    rawCapturePrinted = true;
    uint32_t rawPeak = 0;
    uint32_t shiftedPeak = 0;
    uint64_t rawAbsoluteSum = 0;
    uint64_t shiftedAbsoluteSum = 0;

    for (size_t frame = 0; frame < RAW_CAPTURE_FRAMES; ++frame) {
      const int16_t raw = extractSlotSample(rawCapture[frame * 2]);
      const int16_t shifted = extractShiftedSlotSample(rawCapture[frame * 2]);
      int32_t rawAbsolute = raw;
      int32_t shiftedAbsolute = shifted;
      if (rawAbsolute < 0) {
        rawAbsolute = -rawAbsolute;
      }
      if (shiftedAbsolute < 0) {
        shiftedAbsolute = -shiftedAbsolute;
      }
      rawPeak = max(rawPeak, static_cast<uint32_t>(rawAbsolute));
      shiftedPeak =
          max(shiftedPeak, static_cast<uint32_t>(shiftedAbsolute));
      rawAbsoluteSum += static_cast<uint32_t>(rawAbsolute);
      shiftedAbsoluteSum += static_cast<uint32_t>(shiftedAbsolute);
    }

    Serial.print("{\"type\":\"raw_i2s_capture\",\"raw_peak\":");
    Serial.print(rawPeak);
    Serial.print(",\"raw_mean\":");
    Serial.print(rawAbsoluteSum / RAW_CAPTURE_FRAMES);
    Serial.print(",\"shift_left_1_peak\":");
    Serial.print(shiftedPeak);
    Serial.print(",\"shift_left_1_mean\":");
    Serial.print(shiftedAbsoluteSum / RAW_CAPTURE_FRAMES);
    Serial.print(",\"left\":[");
    for (size_t frame = 0; frame < RAW_CAPTURE_FRAMES; ++frame) {
      if (frame != 0) {
        Serial.print(',');
      }
      Serial.print(rawCapture[frame * 2]);
    }
    Serial.print("],\"right\":[");
    for (size_t frame = 0; frame < RAW_CAPTURE_FRAMES; ++frame) {
      if (frame != 0) {
        Serial.print(',');
      }
      Serial.print(rawCapture[frame * 2 + 1]);
    }
    Serial.println("]}");
  } else if (!rawCaptureReady) {
    rawCapturePrinted = false;
  }

  /*
   * Keep paging the known address while the link is down. Headphones come
   * back on their own schedule — out of the case, released by a phone — and
   * they will never page US, so retrying is the only way the link returns
   * without a human issuing a command.
   */
  static uint32_t lastReconnectAttemptAt = 0;
  if (a2dpStarted && haveRememberedTarget() &&
      millis() - lastReconnectAttemptAt >= RECONNECT_INTERVAL_MS) {
    lastReconnectAttemptAt = millis();
    forceKnownConnect();
  }

  if (millis() - lastDiagnosticAt >= 1000) {
    lastDiagnosticAt = millis();
    const uint16_t peak = i2sPeakSinceReport;
    const uint16_t rawPeak = i2sRawPeakSinceReport;
    i2sPeakSinceReport = 0;
    i2sRawPeakSinceReport = 0;

    size_t buffered;
    portENTER_CRITICAL(&ringMux);
    buffered = bufferedSampleCount();
    portEXIT_CRITICAL(&ringMux);

    JsonDocument document;
    document["type"] = "diagnostic";
    document["state"] =
        a2dp.get_connection_state() == ESP_A2D_CONNECTION_STATE_CONNECTED
            ? "connected"
            : (a2dpStarted ? "searching" : "usb");
    document["target"] = targetName;
    document["message"] =
        "I2S frames=" + String(i2sFramesReceived) +
        ", raw peak=" + String(rawPeak) +
        ", output peak=" + String(peak) +
        ", receiver resyncs=" + String(i2sReceiverResyncs) +
        ", sync locks=" + String(i2sSyncLocks) +
        ", buffered=" + String(buffered) +
        "; A2DP frames=" + String(a2dpFramesRequested) +
        ", nonzero=" + String(a2dpNonzeroFrames) +
        ", read errors=" + String(i2sReadErrors) +
        ", underruns=" + String(ringUnderruns) +
        ", overruns=" + String(ringOverruns) +
        ", starts=" + String(resamplerStarts) + ".";
    document["i2s_frames"] = i2sFramesReceived;
    {
    char addressText[18] = "";
    if (haveKnownAddress) {
      snprintf(addressText, sizeof(addressText),
               "%02x:%02x:%02x:%02x:%02x:%02x", knownAddress[0],
               knownAddress[1], knownAddress[2], knownAddress[3],
               knownAddress[4], knownAddress[5]);
    }
    document["known_addr"] = addressText;
    document["a2dp_state"] = static_cast<int>(a2dp.get_connection_state());
  }
  {
    const uint32_t calls = a2dpCallCount;
    document["a2dp_calls"] = calls;
    document["a2dp_us_per_call"] = calls ? (a2dpCallMicros / calls) : 0;
    document["a2dp_max_frames_per_call"] = a2dpMaxFrameCount;
    a2dpCallCount = 0;
    a2dpCallMicros = 0;
    a2dpMaxFrameCount = 0;
  }
  document["i2s_raw_peak"] = rawPeak;
    document["i2s_peak"] = peak;
    document["i2s_receiver_resyncs"] = i2sReceiverResyncs;
    document["i2s_sync_locks"] = i2sSyncLocks;
    document["buffered_frames"] = buffered;
    document["a2dp_frames"] = a2dpFramesRequested;
    document["a2dp_nonzero_frames"] = a2dpNonzeroFrames;
    document["i2s_read_errors"] = i2sReadErrors;
    document["ring_underruns"] = ringUnderruns;
    document["ring_overruns"] = ringOverruns;
    document["resampler_starts"] = resamplerStarts;
    document["resampler_slips"] = resamplerSlips;
    document["i2s_rx_overflows"] = i2sRxOverflows;
    document["i2s_overflow_hook"] =
        i2sOverflowCallbackStatus == ESP_OK ? "ok" : "unavailable";
    document["i2s_max_read_gap_us"] = i2sMaxReadGapUs;
    i2sMaxReadGapUs = 0;
    serializeJson(document, Serial);
    Serial.println();
  }

  delay(5);
}

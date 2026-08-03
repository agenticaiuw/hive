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

// Recovered from this Mac's existing Bose SLIII pairing record. The older
// speaker does not always answer a fresh Classic Bluetooth inquiry, so the
// prototype can reconnect to its known address directly.
esp_bd_addr_t BOSE_SLIII_ADDRESS = {0x08, 0xDF, 0x1F, 0xEA, 0x19, 0x33};
constexpr const char *BOSE_SLIII_NAME = "Bose SLIII";
// How often to force-page the known Bose address if the link is down.
constexpr uint32_t BOSE_RECONNECT_INTERVAL_MS = 8000;

// The relay returns OpenRouter-compatible signed 16-bit mono PCM at 24 kHz.
constexpr uint32_t INPUT_RATE = 24000;
constexpr uint32_t OUTPUT_RATE = 44100;
constexpr size_t INPUT_BLOCK_FRAMES = 256;
constexpr size_t RING_FRAMES = 16384;
constexpr size_t RESAMPLER_PREFILL_FRAMES = 2048;
constexpr size_t RESAMPLER_LOW_WATER_FRAMES = 1024;
constexpr size_t RESAMPLER_HIGH_WATER_FRAMES = 4096;
constexpr uint32_t RESAMPLER_RATE_CORRECTION = 32;
constexpr size_t RAW_CAPTURE_FRAMES = 64;
constexpr int16_t STREAM_SYNC_A = 0x2468;
constexpr int16_t STREAM_SYNC_B = 0x5A5A;
constexpr int16_t STREAM_SYNC_END = 0x6C6C;
constexpr uint8_t STREAM_SYNC_MATCHES_REQUIRED = 8;
constexpr int32_t I2S_MAX_PLAUSIBLE_SAMPLE_STEP = 8192;

BluetoothA2DPSource a2dp;
Preferences preferences;
String targetName;
bool a2dpStarted = false;
bool discoveryOnly = false;
volatile bool targetSelectionPending = false;
volatile esp_a2d_connection_state_t pendingConnectionState =
    ESP_A2D_CONNECTION_STATE_DISCONNECTED;
volatile bool connectionStateChanged = false;
volatile uint32_t i2sFramesReceived = 0;
volatile uint32_t i2sReadErrors = 0;
volatile uint16_t i2sPeakSinceReport = 0;
volatile uint16_t i2sRawPeakSinceReport = 0;
volatile uint32_t i2sReceiverResyncs = 0;
volatile uint32_t i2sStereoMismatches = 0;
volatile uint32_t i2sSyncLocks = 0;
volatile uint32_t i2sOutliersSuppressed = 0;
volatile uint32_t a2dpFramesRequested = 0;
volatile uint32_t a2dpNonzeroFrames = 0;
volatile uint32_t ringOverruns = 0;
volatile uint32_t ringUnderruns = 0;
volatile uint32_t resamplerStarts = 0;
volatile uint32_t testToneFramesRemaining = 0;
volatile uint32_t testTonePhase = 0;
volatile bool i2sForwardingEnabled = true;
volatile bool rawCaptureReady = false;
volatile bool clockCaptureRequested = false;
volatile size_t rawCaptureFrames = 0;
int16_t rawCapture[RAW_CAPTURE_FRAMES * 2];

int16_t ringBuffer[RING_FRAMES];
size_t ringRead = 0;
size_t ringWrite = 0;
size_t ringCount = 0;
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
  portENTER_CRITICAL(&ringMux);
  if (ringCount == RING_FRAMES) {
    ringRead = (ringRead + 1) % RING_FRAMES;
    --ringCount;
    ++ringOverruns;
  }
  ringBuffer[ringWrite] = sample;
  ringWrite = (ringWrite + 1) % RING_FRAMES;
  ++ringCount;
  portEXIT_CRITICAL(&ringMux);
}

bool popSample(int16_t &sample) {
  bool available = false;
  portENTER_CRITICAL(&ringMux);
  if (ringCount > 0) {
    sample = ringBuffer[ringRead];
    ringRead = (ringRead + 1) % RING_FRAMES;
    --ringCount;
    available = true;
  }
  portEXIT_CRITICAL(&ringMux);
  return available;
}

size_t bufferedSampleCount() {
  size_t count;
  portENTER_CRITICAL(&ringMux);
  count = ringCount;
  portEXIT_CRITICAL(&ringMux);
  return count;
}

void clearAudioBuffer() {
  portENTER_CRITICAL(&ringMux);
  ringRead = 0;
  ringWrite = 0;
  ringCount = 0;
  ++audioStreamGeneration;
  portEXIT_CRITICAL(&ringMux);
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

void i2sCaptureTask(void *) {
  int16_t input[INPUT_BLOCK_FRAMES * 2];
  uint32_t lastBlockAt = 0;
  int16_t previousOutputSample = 0;
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
      previousOutputSample = 0;
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

    const size_t frames = bytesRead / (2 * sizeof(int16_t));
    i2sFramesReceived += frames;

    for (size_t frame = 0; frame < frames; ++frame) {
      if (rawCaptureFrames < RAW_CAPTURE_FRAMES) {
        rawCapture[rawCaptureFrames * 2] = input[frame * 2];
        rawCapture[rawCaptureFrames * 2 + 1] = input[frame * 2 + 1];
        ++rawCaptureFrames;
        if (rawCaptureFrames == RAW_CAPTURE_FRAMES) {
          rawCaptureReady = true;
        }
      }

      const int16_t leftSample = input[frame * 2];
      const int16_t rightSample = input[frame * 2 + 1];

      /*
       * Every nRF stream begins with an alternating pre-shared sync word.
       * Search both the hardware-delivered words and a one-bit-left repair.
       * This turns the otherwise unframed I2S restart into an explicit
       * handshake and tells us which alignment to use for the whole stream.
       */
      if (waitingForSync) {
        const int16_t normalCandidate =
            (leftSample == STREAM_SYNC_A || leftSample == STREAM_SYNC_B)
                ? leftSample
                : rightSample;
        const int16_t shiftedLeft = static_cast<int16_t>(
            static_cast<uint16_t>(leftSample) << 1);
        const int16_t shiftedRight = static_cast<int16_t>(
            static_cast<uint16_t>(rightSample) << 1);
        const int16_t shiftedCandidate =
            (shiftedLeft == STREAM_SYNC_A || shiftedLeft == STREAM_SYNC_B)
                ? shiftedLeft
                : shiftedRight;

        if (!syncLocked) {
          if (normalCandidate == STREAM_SYNC_A ||
              normalCandidate == STREAM_SYNC_B) {
            const bool alternates =
                (normalCandidate == STREAM_SYNC_A &&
                 previousNormalSync == STREAM_SYNC_B) ||
                (normalCandidate == STREAM_SYNC_B &&
                 previousNormalSync == STREAM_SYNC_A);
            normalSyncMatches = alternates ? normalSyncMatches + 1U : 1U;
            previousNormalSync = normalCandidate;
          } else {
            normalSyncMatches = 0;
            previousNormalSync = 0;
          }

          if (shiftedCandidate == STREAM_SYNC_A ||
              shiftedCandidate == STREAM_SYNC_B) {
            const bool alternates =
                (shiftedCandidate == STREAM_SYNC_A &&
                 previousShiftedSync == STREAM_SYNC_B) ||
                (shiftedCandidate == STREAM_SYNC_B &&
                 previousShiftedSync == STREAM_SYNC_A);
            shiftedSyncMatches =
                alternates ? shiftedSyncMatches + 1U : 1U;
            previousShiftedSync = shiftedCandidate;
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

        const int16_t alignedLeft =
            repairOneBitShift ? shiftedLeft : leftSample;
        const int16_t alignedRight =
            repairOneBitShift ? shiftedRight : rightSample;
        if (alignedLeft == STREAM_SYNC_END ||
            alignedRight == STREAM_SYNC_END) {
          syncEndSeen = true;
          continue;
        }
        if (!syncEndSeen) {
          continue;
        }

        waitingForSync = false;
        previousOutputSample = 0;
        clearAudioBuffer();
      }

      int16_t alignedLeft = leftSample;
      int16_t alignedRight = rightSample;
      if (repairOneBitShift) {
        alignedLeft = static_cast<int16_t>(
            static_cast<uint16_t>(leftSample) << 1);
        alignedRight = static_cast<int16_t>(
            static_cast<uint16_t>(rightSample) << 1);
      }

      /*
       * The nRF intentionally sends the mono sample in both stereo slots.
       * Treat those copies as a two-word repetition code. If only one copy
       * is damaged, select the one that continues smoothly from the prior
       * PCM sample instead of forwarding the full-scale corrupt value.
       */
      int16_t sample = alignedLeft;
      if (alignedLeft != alignedRight) {
        ++i2sStereoMismatches;
        int32_t leftDelta =
            static_cast<int32_t>(alignedLeft) - previousOutputSample;
        int32_t rightDelta =
            static_cast<int32_t>(alignedRight) - previousOutputSample;
        if (leftDelta < 0) {
          leftDelta = -leftDelta;
        }
        if (rightDelta < 0) {
          rightDelta = -rightDelta;
        }
        if (rightDelta < leftDelta) {
          sample = alignedRight;
        }

        /*
         * Only suppress a large step when the duplicated words disagree.
         * Matching copies are strong evidence that the transition is real
         * audio; spoken consonants can legitimately exceed this threshold.
         */
        const int32_t selectedDelta =
            rightDelta < leftDelta ? rightDelta : leftDelta;
        if (selectedDelta > I2S_MAX_PLAUSIBLE_SAMPLE_STEP) {
          sample = previousOutputSample;
          ++i2sOutliersSuppressed;
        }
      }
      previousOutputSample = sample;

      int32_t leftMagnitude = leftSample;
      int32_t rightMagnitude = rightSample;
      if (leftMagnitude < 0) {
        leftMagnitude = -leftMagnitude;
      }
      if (rightMagnitude < 0) {
        rightMagnitude = -rightMagnitude;
      }
      const int32_t rawMagnitude = max(leftMagnitude, rightMagnitude);
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

int32_t provideA2dpFrames(Frame *frames, int32_t frameCount) {
  a2dpFramesRequested += frameCount;

  // Diagnostic path: generate a loud 440 Hz square wave directly on the
  // ESP32, bypassing the nRF and the physical I2S input completely.
  if (testToneFramesRemaining > 0) {
    for (int32_t index = 0; index < frameCount; ++index) {
      int16_t sample = 0;
      if (testToneFramesRemaining > 0) {
        sample = testTonePhase < (OUTPUT_RATE / 2) ? 2000 : -2000;
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

  // The nRF stream is 24 kHz. A2DP requests 44.1 kHz stereo PCM, so use a
  // fixed-ratio linear interpolator without blocking the Bluetooth task.
  static int16_t current = 0;
  static int16_t next = 0;
  static uint32_t phase = 0;
  static bool primed = false;
  static uint32_t observedStreamGeneration = 0;

  /*
   * BCLK stops between replies. Any interpolator endpoints retained from the
   * preceding reply are stale after the capture task resets or re-locks the
   * I2S stream, so discard them before considering the new jitter buffer.
   */
  const uint32_t streamGeneration = audioStreamGeneration;
  if (streamGeneration != observedStreamGeneration) {
    current = 0;
    next = 0;
    phase = 0;
    primed = false;
    observedStreamGeneration = streamGeneration;
  }

  size_t buffered = bufferedSampleCount();
  if (!primed) {
    /*
     * The nRF and Bluetooth clocks are independent. Starting as soon as two
     * samples arrive makes every scheduling hiccup an audible underrun.
     * Accumulate about 85 ms first so the resampler has a real jitter buffer.
     */
    if (buffered < RESAMPLER_PREFILL_FRAMES) {
      memset(frames, 0, frameCount * sizeof(Frame));
      return frameCount;
    }
    if (!popSample(current) || !popSample(next)) {
      memset(frames, 0, frameCount * sizeof(Frame));
      return frameCount;
    }
    phase = 0;
    primed = true;
    ++resamplerStarts;
  }

  /*
   * Correct the tiny long-term clock mismatch without dropping whole
   * samples. The adjustment is only 0.2%, so it is inaudible but keeps the
   * buffer away from its empty/full limits.
   */
  uint32_t phaseStep = INPUT_RATE;
  buffered = bufferedSampleCount();
  if (buffered < RESAMPLER_LOW_WATER_FRAMES) {
    phaseStep -= RESAMPLER_RATE_CORRECTION;
  } else if (buffered > RESAMPLER_HIGH_WATER_FRAMES) {
    phaseStep += RESAMPLER_RATE_CORRECTION;
  }

  for (int32_t index = 0; index < frameCount; ++index) {
    const int32_t delta = static_cast<int32_t>(next) - current;
    /*
     * Keep this multiplication signed and wide. Mixing int32_t delta with
     * uint32_t phase previously converted negative deltas to unsigned and
     * overflowed on large transitions, producing full-scale crackles.
     */
    const int32_t interpolated =
        static_cast<int32_t>(current) +
        static_cast<int32_t>(
            (static_cast<int64_t>(delta) * static_cast<int64_t>(phase)) /
            static_cast<int64_t>(OUTPUT_RATE));
    const int16_t sample = static_cast<int16_t>(
        constrain(interpolated, static_cast<int32_t>(INT16_MIN),
                  static_cast<int32_t>(INT16_MAX)));
    frames[index].channel1 = sample;
    frames[index].channel2 = sample;
    if (sample != 0) {
      ++a2dpNonzeroFrames;
    }

    phase += phaseStep;
    while (phase >= OUTPUT_RATE) {
      phase -= OUTPUT_RATE;
      current = next;
      if (!popSample(next)) {
        ++ringUnderruns;
        primed = false;
        phase = 0;
        /*
         * Fade the remainder of this callback instead of jumping abruptly
         * from a nonzero sample to zero.
         */
        const int32_t fadeFrames = frameCount - index;
        for (int32_t rest = index + 1; rest < frameCount; ++rest) {
          const int32_t fade =
              static_cast<int32_t>(current) *
              (frameCount - rest) / fadeFrames;
          frames[rest].channel1 = static_cast<int16_t>(fade);
          frames[rest].channel2 = static_cast<int16_t>(fade);
        }
        current = 0;
        next = 0;
        return frameCount;
      }
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
  if (!nameOrAddressMatches && normalizedTarget == "bose sliii") {
    nameOrAddressMatches =
        memcmp(address, BOSE_SLIII_ADDRESS, ESP_BD_ADDR_LEN) == 0;
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

bool isBoseTarget() {
  String normalized = targetName;
  normalized.trim();
  normalized.toLowerCase();
  return normalized == "bose sliii" || normalized.indexOf("bose") >= 0;
}

void forceBoseConnect() {
  if (!a2dpStarted || !isBoseTarget()) {
    return;
  }
  if (a2dp.get_connection_state() == ESP_A2D_CONNECTION_STATE_CONNECTED ||
      a2dp.get_connection_state() == ESP_A2D_CONNECTION_STATE_CONNECTING) {
    return;
  }
  emitEvent("searching",
            "Paging Bose SLIII at 08:DF:1F:EA:19:33 (put speaker on, pairing "
            "mode if first time).");
  a2dp.connect_to(BOSE_SLIII_ADDRESS);
}

void startBluetoothSearch(bool scanOnly = false) {
  if (!scanOnly && targetName.isEmpty()) {
    targetName = BOSE_SLIII_NAME;
    preferences.putString("target", targetName);
    emitEvent("usb", "Default Bluetooth target set to Bose SLIII.");
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
  if (!scanOnly && isBoseTarget()) {
    // Address-first reconnect: SLIII often ignores inquiry when already bonded
    // to a phone/Mac. Page the known BD_ADDR directly.
    a2dp.set_auto_reconnect(BOSE_SLIII_ADDRESS, 12);
  } else {
    a2dp.set_auto_reconnect(!scanOnly, 5);
  }
  /* The SoundLink III uses the legacy fixed PIN documented by Bose. */
  a2dp.set_pin_code("0000", ESP_BT_PIN_TYPE_FIXED);
  a2dp.set_volume(80);
  a2dp.start();
  a2dpStarted = true;
  emitEvent("searching",
            scanOnly ? "Scanning for nearby Bluetooth audio devices."
                     : "Connecting to “" + targetName +
                           "”. Put Bose in pairing mode if it does not "
                           "answer (hold Bluetooth button).");
  if (!scanOnly && isBoseTarget()) {
    delay(500);
    forceBoseConnect();
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
  } else if (command == "dump") {
    int16_t samples[64] = {};
    size_t sampleCount = 0;
    portENTER_CRITICAL(&ringMux);
    sampleCount = min(ringCount, static_cast<size_t>(64));
    const size_t start =
        (ringWrite + RING_FRAMES - sampleCount) % RING_FRAMES;
    for (size_t index = 0; index < sampleCount; ++index) {
      samples[index] = ringBuffer[(start + index) % RING_FRAMES];
    }
    portEXIT_CRITICAL(&ringMux);

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
      .slot_cfg = I2S_STD_PHILIPS_SLOT_DEFAULT_CONFIG(
          I2S_DATA_BIT_WIDTH_16BIT, I2S_SLOT_MODE_STEREO),
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

  ESP_ERROR_CHECK(i2s_new_channel(&channel, nullptr, &i2sInput));
  ESP_ERROR_CHECK(i2s_channel_init_std_mode(i2sInput, &standard));
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

  preferences.begin("airpods", false);
  targetName = preferences.getString("target", "");
  if (targetName.isEmpty()) {
    targetName = BOSE_SLIII_NAME;
    preferences.putString("target", targetName);
  }

  configureI2sInput();
  xTaskCreatePinnedToCore(i2sCaptureTask, "i2s-capture", 4096, nullptr, 4,
                         nullptr, 1);

  emitEvent("usb",
            "HUZZAH32 ready: LRC=33, BCLK=27, DATA=14, A2DP→Bose SLIII, "
            "nRF I2S forwarding on. Ensure Bose is powered and not stuck "
            "on another phone.");
  // Always try to reconnect the speaker on boot.
  startBluetoothSearch(false);
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
    case ESP_A2D_CONNECTION_STATE_CONNECTED:
      emitEvent("connected",
                "Bluetooth speaker connected. A2DP is streaming at 50%.");
      break;
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
      const int16_t raw = rawCapture[frame * 2];
      const int16_t shifted =
          static_cast<int16_t>(static_cast<uint16_t>(raw) << 1);
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

  static uint32_t lastBoseReconnectAt = 0;
  if (a2dpStarted && isBoseTarget() &&
      millis() - lastBoseReconnectAt >= BOSE_RECONNECT_INTERVAL_MS) {
    lastBoseReconnectAt = millis();
    forceBoseConnect();
  }

  if (millis() - lastDiagnosticAt >= 1000) {
    lastDiagnosticAt = millis();
    const uint16_t peak = i2sPeakSinceReport;
    const uint16_t rawPeak = i2sRawPeakSinceReport;
    i2sPeakSinceReport = 0;
    i2sRawPeakSinceReport = 0;

    size_t buffered;
    portENTER_CRITICAL(&ringMux);
    buffered = ringCount;
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
        ", stereo mismatches=" + String(i2sStereoMismatches) +
        ", sync locks=" + String(i2sSyncLocks) +
        ", outliers suppressed=" + String(i2sOutliersSuppressed) +
        ", buffered=" + String(buffered) +
        "; A2DP frames=" + String(a2dpFramesRequested) +
        ", nonzero=" + String(a2dpNonzeroFrames) +
        ", read errors=" + String(i2sReadErrors) +
        ", underruns=" + String(ringUnderruns) +
        ", overruns=" + String(ringOverruns) +
        ", starts=" + String(resamplerStarts) + ".";
    document["i2s_frames"] = i2sFramesReceived;
    document["i2s_raw_peak"] = rawPeak;
    document["i2s_peak"] = peak;
    document["i2s_receiver_resyncs"] = i2sReceiverResyncs;
    document["i2s_stereo_mismatches"] = i2sStereoMismatches;
    document["i2s_sync_locks"] = i2sSyncLocks;
    document["i2s_outliers_suppressed"] = i2sOutliersSuppressed;
    document["buffered_frames"] = buffered;
    document["a2dp_frames"] = a2dpFramesRequested;
    document["a2dp_nonzero_frames"] = a2dpNonzeroFrames;
    document["i2s_read_errors"] = i2sReadErrors;
    document["ring_underruns"] = ringUnderruns;
    document["ring_overruns"] = ringOverruns;
    document["resampler_starts"] = resamplerStarts;
    serializeJson(document, Serial);
    Serial.println();
  }

  delay(5);
}

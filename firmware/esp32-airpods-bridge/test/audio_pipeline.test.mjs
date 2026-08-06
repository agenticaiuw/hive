import assert from 'node:assert/strict'
import fs from 'node:fs'
import test from 'node:test'

const firmware = fs.readFileSync(
  new URL('../src/main.cpp', import.meta.url),
  'utf8',
)

const SYNC_A = 0x2468
const SYNC_B = 0x5a5a
const SYNC_END = 0x6c6c
const BLOCK_FRAMES = 256
const SYNC_MATCHES_REQUIRED = 8
// The last eight cycles of each 32-cycle slot are undefined line state, and
// the right slot is entirely unspecified. The decoder must ignore both.
const SLOT_TAIL_JUNK = 0xa5
const RIGHT_SLOT_JUNK = 0x13572468 | 0

function signed16(value) {
  const word = value & 0xffff
  return word >= 0x8000 ? word - 0x10000 : word
}

function int32(value) {
  return value | 0
}

// The nRF sends a 24-bit Philips word MSB-aligned in the 32-cycle slot: the
// mono sample in the top 16 bits, a zero low byte, then the undefined tail.
function leftSlotWord(sample) {
  return int32(((sample & 0xffff) << 16) | SLOT_TAIL_JUNK)
}

function oneBitLate(word) {
  // A one-bit-early latch captures one junk bit first, pushing the true
  // word one bit lower in the 32-bit slot.
  return int32((1 << 31) | (word >>> 1))
}

function extractSample(word) {
  return signed16(word >>> 16)
}

function extractShiftedSample(word) {
  return signed16(int32(word << 1) >>> 16)
}

function makeNrfFrames(samples) {
  const frames = []

  for (let block = 0; block < 2; block += 1) {
    for (let frame = 0; frame < BLOCK_FRAMES; frame += 1) {
      const absoluteFrame = block * BLOCK_FRAMES + frame
      const sample = absoluteFrame & 1 ? SYNC_B : SYNC_A
      frames.push([leftSlotWord(sample), RIGHT_SLOT_JUNK])
    }
  }

  for (let frame = 0; frame < BLOCK_FRAMES; frame += 1) {
    const sample = frame < 16 ? SYNC_END : 0
    frames.push([leftSlotWord(sample), RIGHT_SLOT_JUNK])
  }

  for (const sample of samples) {
    frames.push([leftSlotWord(sample), RIGHT_SLOT_JUNK])
  }

  return frames
}

function decodeEspFrames(inputFrames) {
  // The firmware deliberately drops the first DMA block after BCLK restarts.
  const frames = inputFrames.slice(BLOCK_FRAMES)
  const output = []
  let waitingForSync = true
  let syncLocked = false
  let repairShift = false
  let syncEndSeen = false
  let previousNormal = 0
  let previousShifted = 0
  let normalMatches = 0
  let shiftedMatches = 0

  for (const [leftWord] of frames) {
    const normal = extractSample(leftWord)
    const shifted = extractShiftedSample(leftWord)

    if (waitingForSync) {
      if (!syncLocked) {
        if (normal === SYNC_A || normal === SYNC_B) {
          const alternates =
            (normal === SYNC_A && previousNormal === SYNC_B) ||
            (normal === SYNC_B && previousNormal === SYNC_A)
          normalMatches = alternates ? normalMatches + 1 : 1
          previousNormal = normal
        } else {
          normalMatches = 0
          previousNormal = 0
        }

        if (shifted === SYNC_A || shifted === SYNC_B) {
          const alternates =
            (shifted === SYNC_A && previousShifted === SYNC_B) ||
            (shifted === SYNC_B && previousShifted === SYNC_A)
          shiftedMatches = alternates ? shiftedMatches + 1 : 1
          previousShifted = shifted
        } else {
          shiftedMatches = 0
          previousShifted = 0
        }

        if (
          normalMatches >= SYNC_MATCHES_REQUIRED ||
          shiftedMatches >= SYNC_MATCHES_REQUIRED
        ) {
          repairShift = shiftedMatches > normalMatches
          syncLocked = true
        }
        continue
      }

      const aligned = repairShift ? shifted : normal
      if (aligned === SYNC_END) {
        syncEndSeen = true
        continue
      }
      if (!syncEndSeen) continue
      waitingForSync = false
    }

    output.push(repairShift ? shifted : normal)
  }

  return { output, repairShift, syncLocked }
}

test('firmware pins and rates match the nRF reply-audio contract', () => {
  assert.match(firmware, /I2S_LRC_PIN = GPIO_NUM_33/)
  assert.match(firmware, /I2S_BCLK_PIN = GPIO_NUM_27/)
  assert.match(firmware, /I2S_DATA_PIN = GPIO_NUM_14/)
  assert.match(firmware, /INPUT_RATE = 31250/)
  assert.match(firmware, /OUTPUT_RATE = 44100/)
  assert.match(firmware, /I2S_DATA_BIT_WIDTH_32BIT/)
})

test('firmware explicitly selects and reports the maximum ESP32 CPU clock', () => {
  assert.match(firmware, /ESP32_MAX_CPU_CLOCK_MHZ = 240/)
  assert.match(firmware, /setCpuFrequencyMhz\(ESP32_MAX_CPU_CLOCK_MHZ\)/)
  assert.match(firmware, /\\"actual_cpu_mhz\\"/)
})

test('normal I2S framing preserves sharp valid speech transitions', () => {
  const speech = [0, 500, -500, 12000, -12000, 24000, -24000, 1024]
  const decoded = decodeEspFrames(makeNrfFrames(speech))

  assert.equal(decoded.syncLocked, true)
  assert.equal(decoded.repairShift, false)
  assert.deepEqual(decoded.output.slice(-speech.length), speech)
})

test('sync preamble detects and repairs a one-bit-late I2S receiver', () => {
  const speech = [0, 1000, -2000, 12000, -12000, 24000, -24000, 300]
  const shiftedFrames = makeNrfFrames(speech).map(([left, right]) => [
    oneBitLate(left),
    oneBitLate(right),
  ])
  const decoded = decodeEspFrames(shiftedFrames)

  assert.equal(decoded.syncLocked, true)
  assert.equal(decoded.repairShift, true)
  assert.deepEqual(decoded.output.slice(-speech.length), speech)
})

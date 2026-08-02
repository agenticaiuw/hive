import fs from 'node:fs'
import path from 'node:path'

function readMono16Wave(filePath) {
  const wave = fs.readFileSync(filePath)
  if (
    wave.length < 44 ||
    wave.toString('ascii', 0, 4) !== 'RIFF' ||
    wave.toString('ascii', 8, 12) !== 'WAVE'
  ) {
    throw new Error(`${filePath} is not a RIFF/WAVE file`)
  }

  let channels = 0
  let sampleRate = 0
  let bitsPerSample = 0
  let pcm = null
  for (let offset = 12; offset + 8 <= wave.length; ) {
    const chunkId = wave.toString('ascii', offset, offset + 4)
    const chunkBytes = wave.readUInt32LE(offset + 4)
    const chunkStart = offset + 8
    const chunkEnd = chunkStart + chunkBytes
    if (chunkEnd > wave.length) throw new Error(`Invalid ${chunkId} chunk`)
    if (chunkId === 'fmt ' && chunkBytes >= 16) {
      channels = wave.readUInt16LE(chunkStart + 2)
      sampleRate = wave.readUInt32LE(chunkStart + 4)
      bitsPerSample = wave.readUInt16LE(chunkStart + 14)
    } else if (chunkId === 'data') {
      pcm = wave.subarray(chunkStart, chunkEnd)
    }
    offset = chunkEnd + (chunkBytes & 1)
  }

  if (!pcm || channels !== 1 || bitsPerSample !== 16 || !sampleRate) {
    throw new Error('Expected mono 16-bit PCM')
  }
  const samples = new Float64Array(pcm.length / 2)
  for (let index = 0; index < samples.length; index += 1) {
    samples[index] = pcm.readInt16LE(index * 2)
  }
  return { sampleRate, samples }
}

function fft(real, imaginary) {
  const length = real.length
  for (let index = 1, reversed = 0; index < length; index += 1) {
    let bit = length >> 1
    while (reversed & bit) {
      reversed ^= bit
      bit >>= 1
    }
    reversed ^= bit
    if (index < reversed) {
      ;[real[index], real[reversed]] = [real[reversed], real[index]]
      ;[imaginary[index], imaginary[reversed]] = [
        imaginary[reversed],
        imaginary[index],
      ]
    }
  }

  for (let width = 2; width <= length; width <<= 1) {
    const angle = (-2 * Math.PI) / width
    const stepReal = Math.cos(angle)
    const stepImaginary = Math.sin(angle)
    for (let start = 0; start < length; start += width) {
      let twiddleReal = 1
      let twiddleImaginary = 0
      for (let index = 0; index < width / 2; index += 1) {
        const even = start + index
        const odd = even + width / 2
        const oddReal =
          real[odd] * twiddleReal - imaginary[odd] * twiddleImaginary
        const oddImaginary =
          real[odd] * twiddleImaginary + imaginary[odd] * twiddleReal
        real[odd] = real[even] - oddReal
        imaginary[odd] = imaginary[even] - oddImaginary
        real[even] += oddReal
        imaginary[even] += oddImaginary
        const nextReal =
          twiddleReal * stepReal - twiddleImaginary * stepImaginary
        twiddleImaginary =
          twiddleReal * stepImaginary + twiddleImaginary * stepReal
        twiddleReal = nextReal
      }
    }
  }
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right)
  const middle = Math.floor(sorted.length / 2)
  return sorted.length % 2
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2
}

function analyze(filePath) {
  const { sampleRate, samples } = readMono16Wave(filePath)
  const skip = Math.min(Math.round(sampleRate * 0.2), samples.length)
  let fftSize = 16384
  while (fftSize > samples.length - skip && fftSize > 2048) fftSize >>= 1
  if (fftSize > samples.length - skip) {
    throw new Error('Recording is too short for spectral analysis')
  }
  const hop = fftSize / 2
  const power = new Float64Array(fftSize / 2)
  let windows = 0

  for (
    let offset = skip;
    offset + fftSize <= samples.length;
    offset += hop
  ) {
    const real = new Float64Array(fftSize)
    const imaginary = new Float64Array(fftSize)
    let mean = 0
    for (let index = 0; index < fftSize; index += 1) {
      mean += samples[offset + index]
    }
    mean /= fftSize
    for (let index = 0; index < fftSize; index += 1) {
      const window =
        0.5 - 0.5 * Math.cos((2 * Math.PI * index) / (fftSize - 1))
      real[index] = (samples[offset + index] - mean) * window
    }
    fft(real, imaginary)
    for (let bin = 1; bin < power.length; bin += 1) {
      power[bin] += real[bin] ** 2 + imaginary[bin] ** 2
    }
    windows += 1
  }

  if (!windows) throw new Error('Recording is too short for spectral analysis')
  for (let bin = 0; bin < power.length; bin += 1) power[bin] /= windows

  const lowBin = Math.ceil(80 / (sampleRate / fftSize))
  const highBin = Math.floor(7800 / (sampleRate / fftSize))
  const floor = median(power.slice(lowBin, highBin + 1))
  const peaks = []
  for (let bin = lowBin + 1; bin < highBin; bin += 1) {
    if (power[bin] > power[bin - 1] && power[bin] >= power[bin + 1]) {
      peaks.push({
        bin,
        frequency: (bin * sampleRate) / fftSize,
        aboveFloorDb: 10 * Math.log10(power[bin] / floor),
      })
    }
  }
  peaks.sort((left, right) => right.aboveFloorDb - left.aboveFloorDb)

  const selected = []
  for (const peak of peaks) {
    if (
      selected.every(
        (candidate) => Math.abs(candidate.frequency - peak.frequency) >= 20,
      )
    ) {
      selected.push(peak)
    }
    if (selected.length === 16) break
  }

  console.log(`File: ${path.resolve(filePath)}`)
  console.log(
    `PCM: ${sampleRate} Hz, ${(samples.length / sampleRate).toFixed(3)} s`,
  )
  console.log(`FFT: ${fftSize} samples, ${windows} averaged windows`)
  console.log('Strong stationary spectral lines:')
  for (const peak of selected) {
    console.log(
      `  ${peak.frequency.toFixed(1).padStart(7)} Hz  ` +
        `${peak.aboveFloorDb.toFixed(1).padStart(5)} dB above median floor`,
    )
  }
}

const filePath = process.argv[2]
if (!filePath) {
  console.error('Usage: node scripts/analyze-pdm-wave.mjs path/to/capture.wav')
  process.exitCode = 2
} else {
  analyze(filePath)
}

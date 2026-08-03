/*
 * Minimal single-range parser for audio playback.
 *
 * Recordings are a few kilobytes, so the relay buffers the whole object and
 * slices it rather than issuing a ranged R2 read. Only the single-range form
 * browsers actually send for <audio> scrubbing is honoured; a multi-range or
 * malformed header falls back to a normal 200 with the full body.
 */

export const RANGE_UNSATISFIABLE = 'unsatisfiable'

export function parseByteRange(header, total) {
  const match = /^bytes=(\d*)-(\d*)$/.exec(String(header || '').trim())
  if (!match || !total) {
    return null
  }

  const [, rawStart, rawEnd] = match
  if (!rawStart && !rawEnd) {
    return null
  }

  let start
  let end
  if (!rawStart) {
    // `bytes=-N` means the trailing N bytes.
    const suffix = Number(rawEnd)
    if (!suffix) {
      return RANGE_UNSATISFIABLE
    }
    start = Math.max(total - suffix, 0)
    end = total - 1
  } else {
    start = Number(rawStart)
    end = rawEnd ? Number(rawEnd) : total - 1
  }

  if (
    !Number.isFinite(start) ||
    !Number.isFinite(end) ||
    start > end ||
    start >= total
  ) {
    return RANGE_UNSATISFIABLE
  }

  return { start, end: Math.min(end, total - 1) }
}

import assert from 'node:assert/strict'
import test from 'node:test'
import {
  assertFinite,
  assertOnScreen,
  computeImageScale,
  findDisplayAt,
  imageToScreenPoint,
  normalizedToScreenPoint,
  screenToImagePoint,
} from './coordinates.js'

// Real numbers measured on the development Mac: a 1440x900 point display with a
// 2.0 backing scale, so screencapture writes 2880x1800 backing pixels, which
// `sips -Z 1456` downscales to 1456x910 image pixels.
const retinaObservation = {
  display: { x: 0, y: 0, w: 1440, h: 900, backingScale: 2 },
  region: { x: 0, y: 0, w: 1440, h: 900 },
  image: { width: 1456, height: 910 },
}

test('scale is points per image pixel, never the backing scale factor', () => {
  const scale = computeImageScale(retinaObservation.region, retinaObservation.image)

  assert.equal(scale.x, 1440 / 1456)
  assert.equal(scale.y, 900 / 910)
  // The trap: 2.0 (backing scale) and 1.0 (what CGDisplayPixelsWide implies)
  // are both wrong, and both produce clicks at the wrong place.
  assert.notEqual(scale.x, 2)
  assert.notEqual(scale.x, 1)
})

test('the axes scale independently when sips rounds them differently', () => {
  const scale = computeImageScale(
    { x: 0, y: 0, w: 1440, h: 900 },
    { width: 1366, height: 853 },
  )

  assert.notEqual(scale.x, scale.y)
})

test('image coordinates round-trip back to themselves', () => {
  const original = { x: 728, y: 455 }
  const screen = imageToScreenPoint(original, retinaObservation)
  const back = screenToImagePoint(screen, retinaObservation)

  assert.ok(Math.abs(back.x - original.x) < 1e-9)
  assert.ok(Math.abs(back.y - original.y) < 1e-9)
})

test('the centre of the image maps to the centre of the display', () => {
  const point = imageToScreenPoint({ x: 728, y: 455 }, retinaObservation)

  assert.equal(point.x, 720)
  assert.equal(point.y, 450)
})

test('normalized 0-999 coordinates map across the region', () => {
  assert.deepEqual(
    pick(normalizedToScreenPoint({ x: 0, y: 0 }, retinaObservation)),
    { x: 0, y: 0 },
  )
  assert.deepEqual(
    pick(normalizedToScreenPoint({ x: 999, y: 999 }, retinaObservation)),
    { x: 1440, y: 900 },
  )
  assert.deepEqual(
    pick(normalizedToScreenPoint({ x: 499.5, y: 499.5 }, retinaObservation)),
    { x: 720, y: 450 },
  )
})

test('a region capture on a secondary display keeps its own origin', () => {
  // A display to the LEFT of the main one has a negative origin, and a
  // display-local coordinate that ignores it lands on the wrong screen.
  const secondary = {
    display: { x: -1920, y: -200, w: 1920, h: 1080, backingScale: 1 },
    region: { x: -1920, y: -200, w: 1920, h: 1080 },
    image: { width: 960, height: 540 },
  }

  const point = imageToScreenPoint({ x: 480, y: 270 }, secondary)

  assert.equal(point.x, -960)
  assert.equal(point.y, 340)
})

test('a zoomed region maps back through the same conversion, not a second path', () => {
  const zoom = {
    display: { x: 0, y: 0, w: 1440, h: 900, backingScale: 2 },
    region: { x: 400, y: 300, w: 200, h: 100 },
    image: { width: 400, height: 200 },
  }

  const point = imageToScreenPoint({ x: 200, y: 100 }, zoom)

  assert.equal(point.x, 500)
  assert.equal(point.y, 350)
})

test('a near miss is clamped and the clamp is reported back', () => {
  const point = imageToScreenPoint({ x: 1500, y: 455 }, retinaObservation)

  assert.equal(point.clamped, true)
  assert.match(point.note, /clamped image point/)
  assert.ok(point.x <= 1440)
})

test('a coordinate far outside the frame is rejected, not clamped', () => {
  // Clamping this would hide the real bug: the model is working in backing
  // pixels, or in another display's space, and needs to be told.
  assert.throws(
    () => imageToScreenPoint({ x: 2880, y: 1800 }, retinaObservation),
    /wrong coordinate space/,
  )
  assert.throws(
    () => normalizedToScreenPoint({ x: 2500, y: 10 }, retinaObservation),
    /wrong coordinate space/,
  )
})

test('non-finite coordinates are rejected rather than coerced', () => {
  for (const bad of [undefined, null, NaN, Infinity, 'left', {}]) {
    assert.throws(() => assertFinite(bad, 'x'), /finite number/)
    assert.throws(() => imageToScreenPoint({ x: bad, y: 10 }, retinaObservation))
  }
})

test('a point in the gap between non-adjacent displays is rejected', () => {
  const displays = [
    { index: 1, x: 0, y: 0, w: 1440, h: 900 },
    { index: 2, x: 3000, y: 0, w: 1920, h: 1080 },
  ]

  assert.equal(findDisplayAt({ x: 2000, y: 400 }, displays), null)
  assert.throws(() => assertOnScreen({ x: 2000, y: 400 }, displays), /not on any active display/)
  assert.equal(assertOnScreen({ x: 3100, y: 400 }, displays).index, 2)
})

function pick(point) {
  return { x: point.x, y: point.y }
}

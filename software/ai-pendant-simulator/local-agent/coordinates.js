// Pure coordinate math for computer use. No I/O, no macOS calls — everything
// here is unit-testable on any machine.
//
// Three spaces exist, and only two of them are ever adjacent:
//
//   1. POINTS      — what CGEvent consumes, what AXPosition/AXSize report, what
//                    CGDisplayBounds reports, and what `screencapture -R` takes.
//   2. BACKING PX  — what `screencapture` writes (2x points on a Retina display).
//   3. IMAGE PX    — what the model actually sees, after the downscale.
//
// The rule: convert through the per-capture image ratio, NEVER through the
// backing scale factor. The downscale target is deliberately not an integer
// multiple of either the point width or the pixel width, so any code reasoning
// in terms of "2x" is wrong. CGDisplayPixelsWide() is also a trap — it returns
// points, not backing pixels, on Retina displays.

// A model working in the wrong coordinate space entirely produces coordinates
// wildly outside the frame. Clamping those would hide the bug, so only a near
// miss is forgiven.
const MAX_OVERSHOOT_FRACTION = 0.15

// Deliberately stricter than Number(): Number(null), Number('') and
// Number(false) are all 0, so a missing coordinate would silently become a
// click at the top-left of the screen.
export function assertFinite(value, name) {
  const acceptable =
    typeof value === 'number' || (typeof value === 'string' && value.trim() !== '')
  const numeric = acceptable ? Number(value) : NaN

  if (!Number.isFinite(numeric)) {
    throw new Error(`${name} must be a finite number (received ${String(value)}).`)
  }

  return numeric
}

// X and Y ratios are computed independently: `sips -Z` preserves aspect ratio
// but rounds, so 2880x1800 becomes 1366x853 (not 853.75) at maxWidth 1366 and
// the axes genuinely diverge. Asserting one shared ratio drifts by a pixel at
// the bottom of tall displays.
export function computeImageScale(region, image) {
  const regionWidth = assertFinite(region?.w, 'region.w')
  const regionHeight = assertFinite(region?.h, 'region.h')
  const imageWidth = assertFinite(image?.width, 'image.width')
  const imageHeight = assertFinite(image?.height, 'image.height')

  if (imageWidth <= 0 || imageHeight <= 0) {
    throw new Error('Image dimensions must be positive.')
  }

  return {
    x: regionWidth / imageWidth,
    y: regionHeight / imageHeight,
  }
}

export function imageToScreenPoint(point, observation) {
  const region = observation?.region
  const image = observation?.image

  if (!region || !image) {
    throw new Error('imageToScreenPoint requires an observation with region and image.')
  }

  const scale = computeImageScale(region, image)
  const rawX = assertFinite(point?.x, 'x')
  const rawY = assertFinite(point?.y, 'y')

  const clampedImage = clampWithinImage({ x: rawX, y: rawY }, image)

  return {
    x: assertFinite(region.x, 'region.x') + clampedImage.x * scale.x,
    y: assertFinite(region.y, 'region.y') + clampedImage.y * scale.y,
    clamped: clampedImage.clamped,
    note: clampedImage.note,
  }
}

// Several providers resize images server-side, which silently invalidates any
// absolute pixel coordinate the model emits. Asking for normalized 0-999
// coordinates instead makes the click independent of whatever the provider did
// to the bytes.
export function normalizedToScreenPoint(point, observation, span = 1000) {
  const region = observation?.region

  if (!region) {
    throw new Error('normalizedToScreenPoint requires an observation with a region.')
  }

  const rawX = assertFinite(point?.x, 'x')
  const rawY = assertFinite(point?.y, 'y')
  const upper = span - 1

  if (
    rawX < -upper * MAX_OVERSHOOT_FRACTION ||
    rawX > upper * (1 + MAX_OVERSHOOT_FRACTION) ||
    rawY < -upper * MAX_OVERSHOOT_FRACTION ||
    rawY > upper * (1 + MAX_OVERSHOOT_FRACTION)
  ) {
    throw new Error(
      `Normalized coordinate (${rawX}, ${rawY}) is far outside the 0-${upper} range; the model is using the wrong coordinate space.`,
    )
  }

  const x = Math.min(upper, Math.max(0, rawX))
  const y = Math.min(upper, Math.max(0, rawY))

  return {
    x: assertFinite(region.x, 'region.x') + (x / upper) * assertFinite(region.w, 'region.w'),
    y: assertFinite(region.y, 'region.y') + (y / upper) * assertFinite(region.h, 'region.h'),
    clamped: x !== rawX || y !== rawY,
    note:
      x !== rawX || y !== rawY
        ? `clamped normalized (${rawX}, ${rawY}) to (${x}, ${y})`
        : null,
  }
}

export function screenToImagePoint(point, observation) {
  const region = observation?.region
  const image = observation?.image
  const scale = computeImageScale(region, image)

  return {
    x: (assertFinite(point?.x, 'x') - assertFinite(region.x, 'region.x')) / scale.x,
    y: (assertFinite(point?.y, 'y') - assertFinite(region.y, 'region.y')) / scale.y,
  }
}

function clampWithinImage(point, image) {
  const width = Number(image.width)
  const height = Number(image.height)
  const maxOvershootX = width * MAX_OVERSHOOT_FRACTION
  const maxOvershootY = height * MAX_OVERSHOOT_FRACTION

  if (
    point.x < -maxOvershootX ||
    point.x > width + maxOvershootX ||
    point.y < -maxOvershootY ||
    point.y > height + maxOvershootY
  ) {
    throw new Error(
      `Image coordinate (${point.x}, ${point.y}) is far outside the ${width}x${height} frame; the model is using the wrong coordinate space.`,
    )
  }

  const x = Math.min(width - 1, Math.max(0, point.x))
  const y = Math.min(height - 1, Math.max(0, point.y))
  const clamped = x !== point.x || y !== point.y

  return {
    x,
    y,
    clamped,
    // Reported back to the model in the next turn so it self-corrects rather
    // than repeating the same off-frame guess.
    note: clamped
      ? `clamped image point (${round(point.x)}, ${round(point.y)}) to (${round(x)}, ${round(y)})`
      : null,
  }
}

export function displayUnion(displays) {
  if (!Array.isArray(displays) || !displays.length) {
    throw new Error('At least one display is required.')
  }

  return displays.reduce(
    (union, display) => ({
      minX: Math.min(union.minX, display.x),
      minY: Math.min(union.minY, display.y),
      maxX: Math.max(union.maxX, display.x + display.w),
      maxY: Math.max(union.maxY, display.y + display.h),
    }),
    { minX: Infinity, minY: Infinity, maxX: -Infinity, maxY: -Infinity },
  )
}

// Displays are not necessarily contiguous: a point can be inside the bounding
// union and still fall in the gap between two non-adjacent screens, where a
// click would go nowhere.
export function findDisplayAt(point, displays) {
  const x = assertFinite(point?.x, 'x')
  const y = assertFinite(point?.y, 'y')

  return (
    (displays ?? []).find(
      (display) =>
        x >= display.x &&
        x < display.x + display.w &&
        y >= display.y &&
        y < display.y + display.h,
    ) ?? null
  )
}

export function assertOnScreen(point, displays) {
  const target = findDisplayAt(point, displays)

  if (!target) {
    throw new Error(
      `Point (${round(point.x)}, ${round(point.y)}) is not on any active display.`,
    )
  }

  return target
}

function round(value) {
  return Math.round(Number(value) * 10) / 10
}

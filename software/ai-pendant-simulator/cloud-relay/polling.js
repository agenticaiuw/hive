export function bridgeClaimDelay(
  emptyClaimCount,
  { minimumMs = 250, maximumMs = 1000 } = {},
) {
  const minimum = Math.max(50, Number(minimumMs) || 250)
  const maximum = Math.max(minimum, Number(maximumMs) || 1000)
  const attempt = Math.max(0, Number(emptyClaimCount) || 0)
  return Math.min(maximum, Math.round(minimum * 1.6 ** attempt))
}

/**
 * Pause between empty claims inside a long-poll.
 * Not a product "wait for the user" timeout — only a yield so we do not
 * spin D1 / Worker CPU when the queue is empty. Defaults are near-zero;
 * set both to 0 only if you accept higher empty-queue read volume.
 */
export function bridgeClaimDelay(
  emptyClaimCount,
  { minimumMs = 0, maximumMs = 25 } = {},
) {
  const minimum = Math.max(0, Number(minimumMs) || 0)
  const maximum = Math.max(minimum, Number(maximumMs) || 0)
  if (maximum === 0) return 0
  // No exponential backoff — empty queue should not climb to multi-second waits.
  void emptyClaimCount
  return minimum > 0 ? minimum : maximum
}

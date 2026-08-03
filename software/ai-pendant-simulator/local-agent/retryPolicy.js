export function createRetryBackoff({
  baseMs = 250,
  maximumMs = 30_000,
  jitterRatio = 0.2,
  random = Math.random,
} = {}) {
  const base = Math.max(50, Number(baseMs) || 250)
  const maximum = Math.max(base, Number(maximumMs) || 30_000)
  const jitter = Math.min(0.9, Math.max(0, Number(jitterRatio) || 0))
  let attempt = 0

  return {
    nextDelay() {
      const unjittered = Math.min(maximum, base * 2 ** attempt)
      attempt += 1
      const factor = 1 + (Number(random()) * 2 - 1) * jitter
      return Math.max(50, Math.min(maximum, Math.round(unjittered * factor)))
    },
    reset() {
      attempt = 0
    },
  }
}

export function createRateLimitedErrorReporter({
  intervalMs = 30_000,
  now = Date.now,
  warn = console.warn,
} = {}) {
  const interval = Math.max(1000, Number(intervalMs) || 30_000)
  let lastMessage = ''
  let lastLoggedAt = Number.NEGATIVE_INFINITY
  let suppressed = 0

  return (prefix, error) => {
    const message = String(error?.message || error || 'Unknown error')
      .replace(/\s+/g, ' ')
      .trim()
    const observedAt = Number(now())

    if (
      message === lastMessage &&
      observedAt - lastLoggedAt < interval
    ) {
      suppressed += 1
      return false
    }

    const suffix =
      message === lastMessage && suppressed > 0
        ? ` (${suppressed} identical errors suppressed)`
        : ''
    warn(`${prefix}: ${message}${suffix}`)
    lastMessage = message
    lastLoggedAt = observedAt
    suppressed = 0
    return true
  }
}

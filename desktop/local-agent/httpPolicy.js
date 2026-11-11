export function publicHealthPayload() {
  return {
    ok: true,
    service: 'AI Pendant Mac Local Agent',
    version: '0.5.0',
    // A route name, not an operational detail. Without it a caller holding a
    // valid token still has to guess that a manifest exists at all — which is
    // exactly the guessing /capabilities was added to end.
    capabilities: '/capabilities',
  }
}

export function isPublicPath(requestPath) {
  if (requestPath === '/health') return true
  /*
   * The route that EXISTS to serve callers with no bearer yet: the browser
   * extension's one-paste pairing. "Public" here means only "not gated by the
   * bearer this route is how you obtain" — the handler enforces its own two
   * gates, loopback socket address and a timing-safe pairing-code match
   * (pairBrowser.js), which is the same trust the relay's own pre-auth
   * /v1/devices/pair route runs on.
   */
  if (requestPath === '/pair/browser') return true
  if (requestPath === '/dashboard' || requestPath.startsWith('/dashboard/')) {
    return true
  }
  if (requestPath.startsWith('/assets/')) return true
  if (requestPath === '/favicon.svg' || requestPath === '/favicon.ico') {
    return true
  }
  return false
}

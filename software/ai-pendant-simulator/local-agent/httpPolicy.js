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
  if (requestPath === '/dashboard' || requestPath.startsWith('/dashboard/')) {
    return true
  }
  if (requestPath.startsWith('/assets/')) return true
  if (requestPath === '/favicon.svg' || requestPath === '/favicon.ico') {
    return true
  }
  return false
}

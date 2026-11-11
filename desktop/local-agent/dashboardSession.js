import crypto from 'node:crypto'

/*
 * The dashboard is served by the agent it talks to, but every data route needs
 * the bearer token and a page cannot hold one — so the whole UI 401s on every
 * fetch and every tab renders empty. This closes that gap with a session
 * cookie the browser sends automatically on same-origin requests.
 *
 * The token is per-process and never written down: restart the agent and every
 * open dashboard has to be reloaded, which is the correct trade for a
 * credential that grants full control of the machine.
 */
const SESSION_TOKEN = crypto.randomBytes(32).toString('hex')
const COOKIE_NAME = 'pendant_dashboard'

/*
 * The agent listens on 0.0.0.0, so the page is reachable from the whole LAN.
 * Handing a session to anything that can load it would turn a public HTML
 * route into full shell access on this Mac. Only loopback gets a session.
 */
export function isLoopback(request) {
  const address = String(
    request.socket?.remoteAddress || request.ip || '',
  ).replace(/^::ffff:/, '')
  return address === '127.0.0.1' || address === '::1'
}

export function issueDashboardSession(request, response) {
  if (!isLoopback(request)) return false
  response.cookie?.(COOKIE_NAME, SESSION_TOKEN, {
    httpOnly: true,
    sameSite: 'strict',
    path: '/',
  }) ||
    response.setHeader(
      'Set-Cookie',
      `${COOKIE_NAME}=${SESSION_TOKEN}; HttpOnly; SameSite=Strict; Path=/`,
    )
  return true
}

/** Parsed without a dependency — one cookie, one comparison. */
export function hasDashboardSession(request) {
  if (!isLoopback(request)) return false
  const header = String(request.headers?.cookie || '')
  for (const part of header.split(';')) {
    const [name, ...rest] = part.trim().split('=')
    if (name !== COOKIE_NAME) continue
    const value = rest.join('=')
    /* Fixed-length compare: this value is as powerful as the agent token. */
    const a = Buffer.from(value)
    const b = Buffer.from(SESSION_TOKEN)
    return a.length === b.length && crypto.timingSafeEqual(a, b)
  }
  return false
}

import { benchLink } from './benchLink.js'

/*
 * The bench dashboard's HTTP surface.
 *
 *   GET /bench/snapshot   one-shot, for a poll or a curl
 *   GET /bench/stream     server-sent events, the live instrument
 *
 * Both sit behind the agent's ordinary auth (the loopback dashboard session or
 * a bearer token) like every other route — the bench is on the owner's Mac,
 * but a control panel for their hardware is not less private than their mail.
 *
 * SSE rather than a poll because the owner is watching a button, and a 1 Hz
 * poll turns a press into a coin flip. Updates are pushed as they parse and
 * capped at ~20/s so a chatty console cannot flood the browser; a full
 * snapshot goes out every 2 s regardless, which doubles as the freshness
 * heartbeat that makes a frozen stream visible instead of invisible.
 *
 * NOTHING HERE TOUCHES THE HARDWARE UNTIL A CLIENT IS SUBSCRIBED. Registering
 * these routes opens no port, and neither does a `/bench/snapshot` poll —
 * only an open `/bench/stream` does, and the port is handed back when the last
 * one disconnects. The bench shares a USB tty with whoever is flashing the
 * board, and a route that grabs it on registration would take their capture
 * (and, when it was an fd on libuv's thread pool, the agent's relay uplink)
 * down with it.
 */

const MAX_PUSH_HZ = 20
const HEARTBEAT_MS = 2000

export function registerBenchRoutes(app, { basePath = '' } = {}) {
  const route = (suffix) => `${basePath}${suffix}`

  app.get(route('/bench/snapshot'), (_request, response) => {
    const link = benchLink()
    link.touch()
    response.json({ ok: true, bench: link.snapshot() })
  })

  app.get(route('/bench/stream'), (request, response) => {
    const link = benchLink()
    link.touch()

    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    // Nothing here is worth an intermediary's buffer.
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()

    let lastSentAt = 0
    let pending = null

    const write = (snapshot) => {
      lastSentAt = Date.now()
      pending = null
      response.write(`data: ${JSON.stringify(snapshot)}\n\n`)
    }

    const send = (snapshot) => {
      const since = Date.now() - lastSentAt
      if (since >= 1000 / MAX_PUSH_HZ) {
        write(snapshot)
        return
      }
      // Coalesce: the newest snapshot wins, and one timer drains it.
      const first = pending === null
      pending = snapshot
      if (first) {
        setTimeout(() => {
          if (pending) write(pending)
        }, 1000 / MAX_PUSH_HZ - since).unref?.()
      }
    }

    write(link.snapshot())
    const unsubscribe = link.subscribe(send)

    /*
     * The heartbeat carries a whole snapshot rather than an SSE comment: when
     * the board goes quiet the ages inside the payload are the only thing that
     * changes, and they are exactly what tells the owner the stream froze.
     */
    const heartbeat = setInterval(() => {
      link.touch()
      write(link.snapshot())
    }, HEARTBEAT_MS)

    request.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      response.end()
    })
  })
}

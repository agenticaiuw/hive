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

/*
 * THE RAW LINE TAP — why it replaces the stand-down file.
 *
 * Until now an agent that needed the console made this reader let go of the
 * tty (a stand-down file), read the port itself, and released it. That blanked
 * the owner's bench twice in fifteen minutes, and it was never necessary: a
 * flash and every JLinkExe measurement go over SWD through the J-Link's own
 * USB interface, which is a different channel from the console. Reading text
 * was the only thing that ever needed the tty, and this process is already
 * doing that continuously.
 *
 * So the bench owns the ports permanently and everyone else subscribes:
 *
 *   GET /bench/lines            server-sent events, one raw console line per
 *                               message, in arrival order, tagged with the port
 *                               it came from
 *   GET /bench/lines?after=N    the backlog since sequence N, as JSON
 *   GET /bench/lines?format=text  the backlog as newline-delimited text, for
 *                               a consumer that just wants to grep
 *
 * Raw, not parsed, because consumers grep for printk text this parser has no
 * rule for ("Injected frame:", "microSD unavailable (mount=0 write=-2)"). Every
 * SSE message also replays the backlog first, so an agent attaching a second
 * after pressing reset still catches the boot banner.
 *
 * THE ONE EXCEPTION, and it is an exception rather than a second path: if this
 * agent process is not running, there is no tap, and an agent that needs the
 * console must open the tty directly — otherwise a broken dashboard would mean
 * no firmware diagnosis at all. Check `curl -sf localhost:8000/health` first;
 * if it answers, use the tap and do not touch the port.
 */
export function registerBenchRoutes(app, { basePath = '' } = {}) {
  const route = (suffix) => `${basePath}${suffix}`

  app.get(route('/bench/snapshot'), (_request, response) => {
    const link = benchLink()
    link.touch()
    response.json({ ok: true, bench: link.snapshot() })
  })

  app.get(route('/bench/lines'), (request, response) => {
    const link = benchLink()
    link.touch()
    const after = Number(request.query.after) || 0

    /*
     * A plain GET returns the backlog and ends. Only `stream=1` (or an SSE
     * Accept header) holds the connection open — a caller that just wants the
     * last few hundred lines should not have to learn EventSource, and a
     * one-shot curl must not hang.
     */
    const wantsStream =
      request.query.stream === '1' ||
      String(request.get('accept') || '').includes('text/event-stream')

    if (!wantsStream) {
      const lines = link.backlog(after)
      if (request.query.format === 'text') {
        response.type('text/plain')
        response.send(lines.map((line) => `${line.port} ${line.text}`).join('\n') + '\n')
        return
      }
      response.json({ ok: true, lines, seq: link.lineSeq })
      return
    }

    response.setHeader('Content-Type', 'text/event-stream')
    response.setHeader('Cache-Control', 'no-cache, no-transform')
    response.setHeader('Connection', 'keep-alive')
    response.setHeader('X-Accel-Buffering', 'no')
    response.flushHeaders?.()

    const write = (line) => {
      response.write(`id: ${line.seq}\ndata: ${JSON.stringify(line)}\n\n`)
    }

    /*
     * The backlog goes out before any live line. An agent that attaches a
     * second after a reset is exactly the caller this endpoint exists for, and
     * without this it would miss the boot banner it came to read.
     */
    for (const line of link.backlog(after)) write(line)

    const unsubscribe = link.subscribeLines(write)
    const heartbeat = setInterval(() => response.write(': ping\n\n'), 15000)

    request.on('close', () => {
      clearInterval(heartbeat)
      unsubscribe()
      response.end()
    })
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

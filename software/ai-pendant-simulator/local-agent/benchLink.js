/*
 * The pipe between the nRF9160 on the owner's desk and the bench dashboard.
 *
 * WHY THE UART CONSOLE AND NOT SEGGER RTT
 * ---------------------------------------
 * RTT is the textbook Zephyr telemetry path and it was the first choice. Two
 * facts on this bench overruled it:
 *
 *   1. It is not free of firmware work. `firmware/nrf9160/selftest/prj.conf`
 *      does not enable CONFIG_USE_SEGGER_RTT, so RTT needs a firmware commit
 *      exactly like a `printk` loop does — and this process may not edit that
 *      app. Its advertised advantage ("needs no pins") is also moot on a DK:
 *      the console already runs on P0.29 over an on-board trace to the
 *      interface MCU, consuming no breadboard wire.
 *   2. RTT takes the J-Link EXCLUSIVELY. While a logger is attached, `west
 *      flash` fails. The owner and another agent are flashing this board every
 *      few minutes during wiring, so an instrument that blocks flashing is an
 *      instrument that gets turned off.
 *
 * The console, by contrast, already carries every value the dashboard wants,
 * today, from the self-test image that is already flashed. So: serial first,
 * RTT kept as a deliberate second path (`BENCH_TRANSPORT=rtt`) for the day the
 * console is needed for something else.
 *
 * ONE READER AT A TIME
 * --------------------
 * Two processes reading the same tty on macOS SPLIT the byte stream between
 * them; neither gets whole lines. So this link opens the port only while
 * somebody is subscribed to /bench/stream, and lets go afterwards. It never
 * opens a port at import or at route-registration time.
 *
 * WHY A CHILD PROCESS READS THE TTY, NOT `fs.createReadStream`
 * -----------------------------------------------------------
 * This cost the agent's relay uplink once and must not again.
 *
 * `fs.createReadStream` on a character device issues BLOCKING `read(2)` calls
 * on libuv's thread pool, which is four threads by default. A serial port that
 * is silent — an unflashed board, a halted core, a VCOM nobody prints on —
 * blocks that thread for as long as the silence lasts. Probing three VCOMs at
 * once therefore pinned three of the four threads, and everything else that
 * needs the pool went with them: `fs` calls, `crypto`, and — fatally —
 * `dns.lookup`, which every outbound `fetch` to the relay begins with. The
 * agent's inbound HTTP kept answering (that is the event loop, not the pool),
 * so `/health` looked perfect on the Mac while the relay saw the bridge go
 * silent. A bench toy took down a live path, and it looked healthy doing it.
 *
 * Reading the tty through a child process fixes the class, not the instance:
 * the child does the blocking open and read, this process reads a PIPE, and a
 * pipe is event-loop I/O that uses no pool thread at all. It also gives the
 * link a kill switch — a wedged port is one `SIGKILL` away instead of an
 * unclosable fd — and a hard blast radius: nothing about the DK can reach the
 * rest of the agent.
 */
import { execFile, spawn } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

import { applyLine, benchSnapshot, createBenchState } from './benchTelemetry.js'

const BAUD = '115200'

/** The DK's J-Link enumerates three VCOMs; only one carries the console. */
const PORT_GLOB = /^cu\.usbmodem/

/** How long a link with no parsed line still counts as "trying". */
const PROBE_GRACE_MS = 8000

/*
 * Nobody watching for this long and the tty goes back to whoever wants it.
 * Short on purpose: on this bench the port is contended by flashers, capture
 * scripts and the self-test, and holding it "just in case" is how their runs
 * come back shredded.
 */
const IDLE_RELEASE_MS = 10000

/** A silent port is dropped rather than held open against the next reader. */
const SILENT_PORT_MS = 20000

function listCandidatePorts(forced) {
  if (forced) return [forced]
  let entries = []
  try {
    entries = fs.readdirSync('/dev')
  } catch {
    return []
  }
  return entries
    .filter((name) => PORT_GLOB.test(name))
    .sort()
    .map((name) => `/dev/${name}`)
}

function configurePort(port) {
  return new Promise((resolve) => {
    execFile('/bin/stty', ['-f', port, BAUD, 'raw', '-echo'], { timeout: 2000 }, (error) => {
      resolve(!error)
    })
  })
}

/**
 * PIDs other than ours holding this tty.
 *
 * Two readers on one macOS tty do not each get a copy of the stream — they
 * SPLIT it, so both end up with half-lines and neither can say why. During
 * wiring another agent's capture script often owns the console, and the right
 * behaviour then is to stand down and say who has it, not to quietly corrupt
 * their run and our own. Re-checked on every rescan, so the port is taken back
 * the moment it is free.
 */
export function foreignHolders(port, execFileImpl = execFile, ours = [process.pid]) {
  const mine = new Set(ours)
  return new Promise((resolve) => {
    execFileImpl('/usr/sbin/lsof', ['-t', port], { timeout: 2000 }, (error, stdout) => {
      // lsof exits non-zero when nobody holds the file; that is the good case.
      const pids = String(stdout || '')
        .split('\n')
        .map((line) => Number(line.trim()))
        .filter((pid) => Number.isFinite(pid) && pid > 0 && !mine.has(pid))
      if (error && !pids.length) {
        resolve([])
        return
      }
      resolve(pids)
    })
  })
}

/**
 * A live view of one board.
 *
 * Everything here is defensive on purpose: the DK is unplugged mid-sentence
 * many times an hour while the owner moves a wire, and none of that may take
 * the agent process down with it.
 */
export class BenchLink {
  constructor(options = {}) {
    this.transport = options.transport || process.env.BENCH_TRANSPORT || 'auto'
    this.forcedPort = options.port || process.env.BENCH_SERIAL_PORT || ''
    this.state = createBenchState()
    this.listeners = new Set()
    this.readers = new Map()
    this.winner = null
    this.attempts = 0
    this.openedAt = null
    this.detail = null
    this.linkState = 'absent'
    this.stub = false
    this.rescan = null
    this.stubTimer = null
    this.rttChild = null
    this.rttFollow = null
    this.lastWantedAt = 0
    this.started = false
  }

  /**
   * Keep an already-running link alive. It does NOT start one.
   *
   * Only a subscriber opens a port (`subscribe` below). A poll of
   * `/bench/snapshot` reports whatever is known and, if nothing is watching,
   * honestly reports a closed link — which is better than a one-shot curl
   * silently seizing a tty another tool is mid-capture on.
   */
  touch() {
    this.lastWantedAt = Date.now()
  }

  /**
   * The only door that opens a port: a live SSE client.
   *
   * Returns the unsubscribe, which closes the port again once the last client
   * goes away (after IDLE_RELEASE_MS, so a page refresh does not thrash it).
   */
  subscribe(listener) {
    this.listeners.add(listener)
    this.lastWantedAt = Date.now()
    if (!this.started) this.start()
    return () => {
      this.listeners.delete(listener)
      this.lastWantedAt = Date.now()
    }
  }

  /** Listen without opening anything — used by tests and by the snapshot route. */
  onUpdate(listener) {
    this.listeners.add(listener)
    return () => this.listeners.delete(listener)
  }

  emit() {
    const snapshot = this.snapshot()
    for (const listener of this.listeners) {
      try {
        listener(snapshot)
      } catch {
        // A broken SSE client must not stop the others from being fed.
      }
    }
  }

  /*
   * LIVE AUDIO MONITOR — the contract, and an honest "not yet".
   *
   * The owner wants to hear on the Mac whatever the pendant was supposed to
   * play, so a dead speaker or an absent Bluetooth link stops being confusable
   * with a dead agent. Almost all of that audio is synthesised relay-side and
   * streamed down the converse socket, so the Mac needs the same bytes the
   * relay sent — not a tap on the hardware.
   *
   * The relay half does not exist yet and is not this process's to write, so
   * this reports `available: false` with the reason, and the dashboard says so
   * in words rather than rendering a control that cannot work. The moment a
   * monitor endpoint exists, point BENCH_MONITOR_URL at it: the payload flips
   * to available and the page's toggle starts working with no other change.
   *
   * The contract the relay half has to satisfy (see the report for the full
   * write-up): one authenticated WebSocket per device, `{"type":"monitor",
   * "deviceId":…}` on open, then binary frames of the SAME audio being sent to
   * the device, each preceded by a JSON text frame
   * `{"seq":N,"pipelineId":"…","codec":"opus"|"pcm16","rate":16000,"ms":20}`.
   * A monitor subscriber must never change what the device receives: it is a
   * fan-out, and if the fan-out is slow the relay drops monitor frames, never
   * device frames.
   */
  monitorState() {
    const endpoint = process.env.BENCH_MONITOR_URL || ''
    if (!endpoint) {
      return {
        available: false,
        endpoint: null,
        reason: 'the relay does not fan out device audio yet',
      }
    }
    return { available: true, endpoint, reason: null }
  }

  snapshot() {
    return benchSnapshot(this.state, {
      monitor: this.monitorState(),
      link: {
        transport: this.stub ? 'stub' : this.resolvedTransport(),
        port: this.winner,
        state: this.linkState,
        detail: this.detail,
        stub: this.stub,
        attempts: this.attempts,
        openedAt: this.openedAt,
      },
    })
  }

  resolvedTransport() {
    if (this.transport === 'auto') return 'serial'
    return this.transport
  }

  start() {
    if (this.started) return
    this.started = true
    if (this.transport === 'off') {
      this.linkState = 'disabled'
      this.detail = 'BENCH_TRANSPORT=off'
      return
    }
    if (this.transport === 'stub') {
      this.startStub()
      return
    }
    if (this.transport === 'rtt') {
      this.startRtt()
      return
    }
    /*
     * Never awaited, and never on anyone's startup path: a scan that hangs on
     * a wedged `stty` or a slow `lsof` may cost the bench its data, and must
     * not cost the agent anything at all.
     */
    void this.scanSerial().catch(() => {})
    this.rescan = setInterval(() => {
      if (this.reapIdle()) return
      this.reapSilentReaders()
      void this.scanSerial().catch(() => {})
    }, 2000)
    this.rescan.unref?.()
  }

  stop() {
    this.started = false
    if (this.rescan) clearInterval(this.rescan)
    this.rescan = null
    if (this.stubTimer) clearInterval(this.stubTimer)
    this.stubTimer = null
    this.closeReaders()
    this.stopRtt()
    this.linkState = 'absent'
    this.winner = null
  }

  reapIdle() {
    if (this.listeners.size || Date.now() - this.lastWantedAt <= IDLE_RELEASE_MS) {
      return false
    }
    this.stop()
    this.detail = 'released the port — nobody is watching'
    return true
  }

  closeReaders() {
    for (const port of [...this.readers.keys()]) {
      this.closeReader(port)
    }
  }

  /** Our own PIDs, so a `cat` of ours is never mistaken for a rival reader. */
  ourPids() {
    const pids = [process.pid]
    for (const reader of this.readers.values()) {
      if (reader.child?.pid) pids.push(reader.child.pid)
    }
    return pids
  }

  /* ---------------- serial ---------------- */

  /*
   * All three VCOMs are opened at once and the first one to produce a line
   * this parser understands wins; the rest are dropped. Guessing which VCOM
   * is the console from its name is a guess that has been wrong on this DK
   * before, and a wrong guess looks exactly like a dead board.
   */
  async scanSerial() {
    if (this.winner && this.readers.has(this.winner)) return
    const ports = listCandidatePorts(this.forcedPort)
    if (!ports.length) {
      this.linkState = 'absent'
      this.detail = 'no /dev/cu.usbmodem* — the DK is unplugged'
      this.closeReaders()
      this.winner = null
      return
    }

    const busy = []
    for (const port of ports) {
      // eslint-disable-next-line no-await-in-loop -- three ports, once each.
      const holders = await foreignHolders(port, execFile, this.ourPids())
      if (holders.length) {
        busy.push(`${port.replace('/dev/', '')} (pid ${holders.join(', ')})`)
        // Someone else is mid-capture. Let go of it rather than split it.
        this.closeReader(port)
        continue
      }
      if (this.readers.has(port)) continue
      this.attempts += 1
      // eslint-disable-next-line no-await-in-loop -- three ports, once each.
      const configured = await configurePort(port)
      if (!configured) continue
      this.openReader(port)
    }

    if (this.readers.size && this.linkState !== 'streaming') {
      this.linkState = 'probing'
      this.detail = `listening on ${[...this.readers.keys()].join(', ')}`
      if (!this.openedAt) this.openedAt = Date.now()
      return
    }

    if (!this.readers.size && busy.length) {
      this.linkState = 'busy'
      this.detail = `another process is reading ${busy.join(' and ')} — standing off until it lets go`
    }
  }

  /**
   * One `cat` per candidate port.
   *
   * The child does the blocking open and the blocking reads; this process only
   * ever reads its pipe. See the header for why that distinction is the whole
   * reason this feature is allowed near the agent.
   */
  openReader(port) {
    let child
    try {
      child = spawn('/bin/cat', [port], { stdio: ['ignore', 'pipe', 'ignore'] })
    } catch {
      return
    }
    const reader = { child, buffer: '', openedAt: Date.now(), bytes: 0 }
    this.readers.set(port, reader)

    child.stdout?.on('data', (chunk) => {
      reader.bytes += chunk.length
      this.feed(port, reader, chunk.toString('utf8'))
    })

    const drop = () => {
      if (this.readers.get(port) === reader) this.readers.delete(port)
      if (this.winner === port) {
        this.winner = null
        this.linkState = 'absent'
        this.detail = 'the port went away mid-stream — DK unplugged?'
        this.emit()
      }
    }
    child.on('error', drop)
    child.on('exit', drop)
  }

  closeReader(port) {
    const reader = this.readers.get(port)
    if (!reader) return
    this.readers.delete(port)
    try {
      reader.child.kill('SIGKILL')
    } catch {
      /* already gone */
    }
  }

  /*
   * A port that has said nothing at all is dropped rather than held. On this
   * bench a silent VCOM is the common case (two of the three never carry the
   * console, and the board is often mid-flash), and an idle `cat` sitting on
   * the tty is exactly what shreds the next tool's capture.
   */
  reapSilentReaders() {
    if (this.winner) return
    for (const [port, reader] of this.readers) {
      if (reader.bytes === 0 && Date.now() - reader.openedAt > SILENT_PORT_MS) {
        this.closeReader(port)
      }
    }
  }

  feed(port, reader, text) {
    reader.buffer += text
    const lines = reader.buffer.split('\n')
    reader.buffer = lines.pop() ?? ''
    // A console that never sends a newline must not grow a buffer forever.
    if (reader.buffer.length > 8192) reader.buffer = reader.buffer.slice(-1024)

    let parsedAny = false
    for (const line of lines) {
      if (applyLine(this.state, line)) parsedAny = true
    }
    if (!parsedAny) {
      if (this.winner === null && Date.now() - (this.openedAt || 0) > PROBE_GRACE_MS) {
        this.detail =
          'bytes are arriving but nothing parses — is another process reading the same port?'
      }
      return
    }

    if (this.winner !== port) {
      this.winner = port
      // Everything else was noise; hand those ports straight back.
      for (const other of [...this.readers.keys()]) {
        if (other !== port) this.closeReader(other)
      }
    }
    this.linkState = 'streaming'
    this.detail = null
    this.emit()
  }

  /* ---------------- RTT (second path) ---------------- */

  /*
   * JLinkRTTLogger writes the channel to a file rather than to stdout, so the
   * file is followed from its end. This path is opt-in and will make `west
   * flash` fail while it runs — see the header.
   */
  startRtt() {
    const device = process.env.BENCH_RTT_DEVICE || 'nRF9160_xxAA'
    const logPath = path.join(os.tmpdir(), `pendant-bench-rtt-${process.pid}.log`)
    try {
      fs.writeFileSync(logPath, '')
    } catch {
      this.linkState = 'absent'
      this.detail = 'could not create the RTT spool file'
      return
    }

    this.attempts += 1
    this.openedAt = Date.now()
    this.linkState = 'probing'
    this.detail = `JLinkRTTLogger -Device ${device}`

    try {
      this.rttChild = spawn(
        process.env.BENCH_RTT_BIN || 'JLinkRTTLogger',
        ['-Device', device, '-If', 'SWD', '-Speed', '4000', '-RTTChannel', '0', logPath],
        { stdio: ['ignore', 'ignore', 'pipe'] },
      )
    } catch {
      this.linkState = 'absent'
      this.detail = 'JLinkRTTLogger is not on PATH'
      return
    }

    this.rttChild.on('error', () => {
      this.linkState = 'absent'
      this.detail = 'JLinkRTTLogger would not start'
      this.emit()
    })
    this.rttChild.on('exit', (code) => {
      this.linkState = 'absent'
      this.detail = `JLinkRTTLogger exited (${code}) — is the J-Link held by a flash?`
      this.emit()
    })

    let offset = 0
    let buffer = ''
    this.rttFollow = setInterval(() => {
      let size = 0
      try {
        size = fs.statSync(logPath).size
      } catch {
        return
      }
      if (size <= offset) return
      let chunk = Buffer.alloc(size - offset)
      try {
        const handle = fs.openSync(logPath, 'r')
        fs.readSync(handle, chunk, 0, chunk.length, offset)
        fs.closeSync(handle)
      } catch {
        return
      }
      offset = size
      buffer += chunk.toString('utf8')
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      let parsedAny = false
      for (const line of lines) {
        if (applyLine(this.state, line)) parsedAny = true
      }
      if (parsedAny) {
        this.linkState = 'streaming'
        this.detail = null
        this.emit()
      }
    }, 100)
    this.rttFollow.unref?.()
  }

  stopRtt() {
    if (this.rttFollow) clearInterval(this.rttFollow)
    this.rttFollow = null
    if (this.rttChild) {
      try {
        this.rttChild.kill()
      } catch {
        /* already dead */
      }
    }
    this.rttChild = null
  }

  /* ---------------- bench stub ---------------- */

  /*
   * BENCH STUB — synthetic data, never confused for a board.
   *
   * `BENCH_TRANSPORT=stub` drives the same parser with generated `BENCH` lines
   * so the endpoint and the UI can be proven end to end with no hardware (and
   * so a UI regression is findable without unplugging the owner's bench). The
   * snapshot carries `link.stub: true` and the dashboard prints STUB across
   * the header — a fake reading that cannot be told apart from a real one is
   * worse than no reading.
   */
  startStub() {
    this.stub = true
    this.linkState = 'streaming'
    this.detail = 'synthetic bench data — no board involved'
    this.openedAt = Date.now()
    const startedAt = Date.now()
    let detents = 0

    this.stubTimer = setInterval(() => {
      const elapsed = Date.now() - startedAt
      const seconds = elapsed / 1000
      const phase = Math.sin(seconds / 3)
      const pressed = Math.floor(seconds) % 7 === 0
      detents += Math.floor(seconds * 2) % 11 === 0 ? 1 : 0
      const line = `BENCH ${JSON.stringify({
        v: 1,
        up: elapsed,
        fw: 'bench-stub',
        btn: { p21: pressed ? 0 : 1, p22: 1, p23: Math.floor(seconds) % 11 === 0 ? 0 : 1 },
        enc: { a: detents % 2, b: (detents + 1) % 2, pos: detents, det: detents },
        pot: { raw: Math.round(2048 + phase * 1900) },
        mic: {
          sense: 1,
          peak: Math.round(40000 + Math.abs(phase) * 900000),
          rms: Math.round(30 + Math.abs(Math.sin(seconds)) * 2600),
        },
        amp: 0,
        i2c: [0x5a],
        sd: { present: true, bytes: 15931539456, mounted: true },
        esp: 'ok',
      })}`
      applyLine(this.state, line)
      this.emit()
    }, 100)
    this.stubTimer.unref?.()
  }
}

let shared = null

/** One link per agent process; the routes share it. */
export function benchLink() {
  if (!shared) shared = new BenchLink()
  return shared
}

/** Tests build their own links; this releases the shared one. */
export function resetBenchLink() {
  if (shared) shared.stop()
  shared = null
}

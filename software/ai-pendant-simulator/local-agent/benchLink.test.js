import assert from 'node:assert/strict'
import test from 'node:test'

import {
  BenchLink,
  consolePortOf,
  foreignHolders,
  standDownRequested,
} from './benchLink.js'

function fakeReader() {
  // `synced: true` = already past the first newline. The attach-time truncation
  // has its own test below.
  const reader = { buffer: '', bytes: 0, openedAt: Date.now(), killed: false, synced: true }
  reader.child = {
    pid: 4000 + Math.floor(Math.random() * 1000),
    kill() {
      reader.killed = true
    },
  }
  return reader
}

/** Never the real stand-down path: another agent may hold it mid-run. */
const NO_STANDDOWN = `/tmp/pendant-bench-standdown-absent-${process.pid}`

function linkWithPorts(ports) {
  const link = new BenchLink({ transport: 'off', standDownFile: NO_STANDDOWN })
  link.openedAt = Date.now()
  for (const port of ports) {
    link.readers.set(port, fakeReader())
  }
  return link
}

test('the first port that parses wins and the other VCOMs are dropped', () => {
  const link = linkWithPorts(['/dev/cu.a', '/dev/cu.b', '/dev/cu.c'])
  const noise = link.readers.get('/dev/cu.a')
  const console_ = link.readers.get('/dev/cu.b')

  // VCOM2 carries stray bytes from the amp-pin toggles; they parse as nothing.
  link.feed('/dev/cu.a', noise, '\x00\xff garbage\n')
  assert.equal(link.winner, null)
  assert.equal(link.linkState, 'absent')

  link.feed('/dev/cu.b', console_, '  [  512 ms] yellow button P0.21  PRESSED\n')
  assert.equal(link.winner, '/dev/cu.b')
  assert.equal(link.linkState, 'streaming')
  assert.deepEqual([...link.readers.keys()], ['/dev/cu.b'])
  assert.equal(noise.killed, true, 'the losing reader is killed, not left on the tty')
})

test('a line split across two USB reads is still one line', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  const reader = link.readers.get('/dev/cu.b')

  link.feed('/dev/cu.b', reader, '  [ 1200 ms] encoder detent  ')
  assert.equal(link.winner, null, 'half a line is not a reading')
  link.feed('/dev/cu.b', reader, 'CW   (total cw=1 ccw=0)\n')

  assert.equal(link.winner, '/dev/cu.b')
  assert.equal(link.snapshot().controls.encoder.detents, 1)
})

test('a console that never sends a newline cannot grow the buffer forever', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  const reader = link.readers.get('/dev/cu.b')
  link.feed('/dev/cu.b', reader, 'x'.repeat(40_000))
  assert.ok(reader.buffer.length <= 8192)
})

test('bytes that never parse name the likely cause instead of looking dead', () => {
  const link = linkWithPorts(['/dev/cu.a'])
  link.openedAt = Date.now() - 20_000
  link.feed('/dev/cu.a', link.readers.get('/dev/cu.a'), 'not a self-test line\n')
  assert.match(link.detail, /another process reading the same port/)
})

test('BENCH_TRANSPORT=off is a state, not a silent no-op', () => {
  const link = new BenchLink({ transport: 'off' })
  link.subscribe(() => {})
  const snapshot = link.snapshot()
  assert.equal(snapshot.link.state, 'disabled')
  assert.equal(snapshot.stream.connected, false)
  link.stop()
})

test('the bench stub streams, and never pretends to be a board', async () => {
  const link = new BenchLink({ transport: 'stub' })
  const seen = []
  link.subscribe((snapshot) => seen.push(snapshot))
  await new Promise((resolve) => setTimeout(resolve, 350))
  link.stop()

  assert.ok(seen.length >= 2, 'the stub pushes at ~10 Hz')
  const last = seen.at(-1)
  assert.equal(last.link.stub, true)
  assert.equal(last.link.transport, 'stub')
  assert.equal(last.stream.connected, true)
  assert.equal(last.firmware.name, 'bench-stub')
  assert.equal(typeof last.controls.pot.raw, 'number')
  assert.equal(last.controls.i2c.addresses[0].hex, '0x5a')
})

test('an unplugged DK is reported as unplugged rather than as a crash', async () => {
  const link = new BenchLink({
    transport: 'serial',
    port: '/dev/cu.no-such-port',
    standDownFile: NO_STANDDOWN,
  })
  link.subscribe(() => {})
  // Long enough for the reader shell to try the open and exit.
  await new Promise((resolve) => setTimeout(resolve, 700))
  const snapshot = link.snapshot()
  link.stop()

  assert.equal(snapshot.stream.connected, false)
  assert.equal(snapshot.link.state, 'absent')
  assert.equal(snapshot.controls.pot.raw, null)
})

test('a subscriber that throws does not stop the other subscribers', () => {
  const link = new BenchLink({ transport: 'off' })
  const got = []
  link.onUpdate(() => {
    throw new Error('this client is broken')
  })
  link.onUpdate((snapshot) => got.push(snapshot))
  link.emit()
  assert.equal(got.length, 1)
})

test('a tty held by another process is reported, not fought over', async () => {
  const lsof = (_bin, _args, _options, done) =>
    done(null, `${process.pid}\n777\n4242\n`, '')
  // 777 stands in for one of our own `cat` children: ours is not a rival.
  assert.deepEqual(await foreignHolders('/dev/cu.b', lsof, [process.pid, 777]), [4242])

  // lsof exits non-zero when nobody holds the file: that is the free case.
  const empty = (_bin, _args, _options, done) => done(new Error('exit 1'), '', '')
  assert.deepEqual(await foreignHolders('/dev/cu.b', empty), [])
})

test('the link lets go of the tty once nobody is watching', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  link.started = true
  link.lastWantedAt = Date.now() - 60_000
  assert.equal(link.reapIdle(), true)
  assert.equal(link.readers.size, 0)
  assert.match(link.detail, /released the port/)
})

test('a subscriber holds the port; a snapshot poll never opens one', () => {
  const link = new BenchLink({
    transport: 'serial',
    port: '/dev/cu.no-such-port',
    standDownFile: NO_STANDDOWN,
  })

  // `touch` is what /bench/snapshot calls. It must not start anything.
  link.touch()
  assert.equal(link.started, false, 'a poll must not seize a tty')
  assert.equal(link.readers.size, 0)

  const release = link.subscribe(() => {})
  assert.equal(link.started, true)
  release()

  // The port comes back once the grace window passes with nobody watching.
  link.lastWantedAt = Date.now() - 60_000
  assert.equal(link.reapIdle(), true)
  assert.equal(link.started, false)
  assert.equal(link.readers.size, 0)
})

test('the stand-down file makes the reader let go without an HTTP call', async () => {
  const flag = `/tmp/pendant-bench-standdown-test-${process.pid}`
  const fs = await import('node:fs')

  assert.equal(standDownRequested(flag), false)
  const link = linkWithPorts(['/dev/cu.a'])
  link.standDownFile = flag
  link.forcedPort = '/dev/cu.a'

  fs.writeFileSync(flag, '')
  try {
    assert.equal(standDownRequested(flag), true)
    await link.scanSerial()
    assert.equal(link.readers.size, 0, 'every reader is released')
    assert.equal(link.linkState, 'stood-down')
    assert.match(link.snapshot().link.detail, /another tool asked for the console/)
  } finally {
    fs.unlinkSync(flag)
  }
})

test('the link counts bytes and parsed lines across a reboot', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  const reader = link.readers.get('/dev/cu.b')

  link.feed('/dev/cu.b', reader, '  [  512 ms] yellow button P0.21  PRESSED\n')
  link.feed('/dev/cu.b', reader, '*** Booting nRF Connect SDK v3.4.0-abc ***\n')

  const snapshot = link.snapshot()
  // The per-boot counters reset; the link's own totals must not, because
  // "has this board ever said anything" is what the empty state asks.
  assert.equal(snapshot.stream.linesSeen, 0)
  assert.equal(snapshot.link.parsed, 2)
  assert.ok(snapshot.link.bytes > 0)
})

test('a port that says nothing is handed back instead of held open', () => {
  const link = linkWithPorts(['/dev/cu.a'])
  const reader = link.readers.get('/dev/cu.a')
  reader.openedAt = Date.now() - 60_000
  link.reapSilentReaders()
  assert.equal(link.readers.size, 0)
  assert.equal(reader.killed, true)
})

/*
 * The guard for the outage this file's header describes: the bench must be
 * inert until somebody watches it. Registration used to be inert too and the
 * damage came from the first poll, so both are asserted.
 */
test('registering the routes performs no I/O and opens no port', async () => {
  const { registerBenchRoutes } = await import('./benchRoutes.js')
  const { benchLink, resetBenchLink } = await import('./benchLink.js')

  const routes = []
  const app = {
    get(path) {
      routes.push(path)
    },
  }

  resetBenchLink()
  registerBenchRoutes(app)
  assert.deepEqual(routes, ['/bench/snapshot', '/bench/lines', '/bench/stream'])

  // Registration must not even construct the link, let alone open a tty.
  const link = benchLink()
  assert.equal(link.started, false)
  assert.equal(link.readers.size, 0)
  assert.equal(link.snapshot().link.state, 'absent')
  resetBenchLink()
})

/*
 * The bug the owner hit: the bench held two silent ports, never opened VCOM0,
 * and called itself "streaming" while he pressed a button and watched nothing.
 */
test('VCOM0 is the console, and it is the lowest-numbered port', () => {
  assert.equal(
    consolePortOf([
      '/dev/cu.usbmodem0009600365813',
      '/dev/cu.usbmodem0009600365815',
      '/dev/cu.usbmodem0009600365811',
    ]),
    '/dev/cu.usbmodem0009600365811',
  )
  assert.equal(consolePortOf([]), null)
})

test('a stray byte on VCOM1 cannot elect itself the console', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  link.candidates = ['/dev/cu.a', '/dev/cu.b']

  // VCOM1 parses something first and may hold the slot provisionally...
  link.feed('/dev/cu.b', link.readers.get('/dev/cu.b'), 'STATUS mic MUTED\n')
  assert.equal(link.winner, '/dev/cu.b')
  // ...but the console is not open, so this is NOT a healthy link.
  assert.equal(link.linkState, 'console-missing')
  assert.match(link.detail, /VCOM0/)

  // The console speaks: it takes the slot back and the others are released.
  link.readers.set('/dev/cu.a', fakeReader())
  const consoleReader = link.readers.get('/dev/cu.a')
  link.feed('/dev/cu.a', consoleReader, 'BENCH {"v":1,"up":10,"pot":{"raw":194}}\n')
  assert.equal(link.winner, '/dev/cu.a')
  assert.equal(link.linkState, 'streaming')
  assert.deepEqual([...link.readers.keys()], ['/dev/cu.a'])
  assert.equal(link.snapshot().controls.pot.raw, 194)
})

test('a console that was busy is retried on every scan, not latched out', async () => {
  const link = new BenchLink({ transport: 'off', standDownFile: NO_STANDDOWN })
  link.candidates = ['/dev/cu.a', '/dev/cu.b']
  link.readers.set('/dev/cu.b', fakeReader())
  link.holders.set('/dev/cu.a', [4242])
  link.missing = ['/dev/cu.a']

  // Winning on a non-console port must NOT stop the scan: the old code
  // returned early forever once any port won, so a console held for a moment
  // by the firmware agent was never opened again.
  link.winner = '/dev/cu.b'
  link.describeState()
  assert.equal(link.linkState, 'console-missing')
  assert.match(link.detail, /held by pid 4242/)

  // Once it frees up, the very next scan opens it.
  link.holders.delete('/dev/cu.a')
  link.readers.set('/dev/cu.a', fakeReader())
  link.missing = []
  link.winner = '/dev/cu.a'
  link.describeState()
  assert.equal(link.linkState, 'streaming')
})

test('the console is never reaped for being quiet', () => {
  const link = linkWithPorts(['/dev/cu.a', '/dev/cu.b'])
  link.candidates = ['/dev/cu.a', '/dev/cu.b']
  for (const reader of link.readers.values()) {
    reader.openedAt = Date.now() - 60_000
  }
  link.reapSilentReaders()
  // An idle or mid-flash board says nothing for far longer than the window;
  // dropping VCOM0 on that basis is how this failure started.
  assert.deepEqual([...link.readers.keys()], ['/dev/cu.a'])
})

/*
 * The tap exists so no other agent ever has to take the tty away from the
 * owner's page. These pin the properties consumers depend on.
 */
test('the tap records every raw line in order, with its port', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  const reader = link.readers.get('/dev/cu.b')

  link.feed('/dev/cu.b', reader, 'Injected frame: 3\nmicroSD unavailable (mount=0 write=-2)\n')

  const lines = link.backlog()
  assert.equal(lines.length, 2)
  assert.deepEqual(
    lines.map((line) => line.text),
    ['Injected frame: 3', 'microSD unavailable (mount=0 write=-2)'],
  )
  // Text this parser has no rule for is exactly what consumers grep for.
  assert.equal(link.snapshot().stream.linesParsed, 0)
  assert.equal(lines[0].port, 'cu.b')
  assert.equal(lines[0].seq, 1)
  assert.equal(lines[1].seq, 2)
})

test('the backlog survives a reset so a late subscriber still sees the boot', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  const reader = link.readers.get('/dev/cu.b')
  link.feed('/dev/cu.b', reader, '*** Booting nRF Connect SDK v3.4.0-abc ***\nSTATUS mic MUTED\n')

  // Attaching AFTER the boot still gets it: that is the whole point.
  const seen = link.backlog(0).map((line) => line.text)
  assert.match(seen[0], /Booting nRF Connect SDK/)

  // And `after` lets a reconnecting client ask only for what it missed.
  assert.deepEqual(
    link.backlog(1).map((line) => line.text),
    ['STATUS mic MUTED'],
  )
})

test('the tap is bounded and drops the oldest lines, never the newest', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  const reader = link.readers.get('/dev/cu.b')
  for (let index = 0; index < 700; index += 1) {
    link.feed('/dev/cu.b', reader, `line ${index}\n`)
  }
  const lines = link.backlog()
  assert.ok(lines.length <= 500)
  assert.equal(lines.at(-1).text, 'line 699')
})

test('a tap subscriber holds the ports open, like any other watcher', () => {
  const link = new BenchLink({ transport: 'off', standDownFile: NO_STANDDOWN })
  link.touch()
  assert.equal(link.started, false, 'a poll still opens nothing')

  const release = link.subscribeLines(() => {})
  assert.equal(link.started, true)
  assert.equal(link.snapshot().link.tapWatchers, 1)

  // ...and releases them when the last consumer leaves.
  release()
  link.lastWantedAt = Date.now() - 60_000
  assert.equal(link.reapIdle(), true)
})

test('a broken tap client cannot stop the parser or the other clients', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  const got = []
  link.subscribeLines(() => {
    throw new Error('this consumer is broken')
  })
  link.subscribeLines((line) => got.push(line.text))

  link.feed('/dev/cu.b', link.readers.get('/dev/cu.b'), 'BENCH {"v":1,"up":9,"pot":{"raw":42}}\n')
  assert.deepEqual(got.length, 1)
  assert.equal(link.snapshot().controls.pot.raw, 42, 'the parser still ran')
})

test('the fragment a reader attaches mid-line is dropped, not published', () => {
  const link = linkWithPorts(['/dev/cu.b'])
  const reader = link.readers.get('/dev/cu.b')
  reader.synced = false

  // Exactly the shape of the first real capture: we attach mid-BENCH-line.
  link.feed('/dev/cu.b', reader, '"pot":{"raw":166\nSTATUS mic MUTED\n')

  assert.deepEqual(
    link.backlog().map((line) => line.text),
    ['STATUS mic MUTED'],
    'the half line we joined late is never handed to a consumer',
  )
})

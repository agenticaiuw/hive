import assert from 'node:assert/strict'
import test from 'node:test'

import { BenchLink, foreignHolders, standDownRequested } from './benchLink.js'

function fakeReader() {
  const reader = { buffer: '', bytes: 0, openedAt: Date.now(), killed: false }
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
  assert.deepEqual(routes, ['/bench/snapshot', '/bench/stream'])

  // Registration must not even construct the link, let alone open a tty.
  const link = benchLink()
  assert.equal(link.started, false)
  assert.equal(link.readers.size, 0)
  assert.equal(link.snapshot().link.state, 'absent')
  resetBenchLink()
})

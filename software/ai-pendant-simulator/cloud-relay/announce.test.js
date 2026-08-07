import assert from 'node:assert/strict'
import test from 'node:test'
import { Buffer } from 'node:buffer'

import {
  ANNOUNCEMENT_MAX_CHARS,
  ANNOUNCE_CONTROL_FRAME_MAX_BYTES,
  DELIVERY_CLAIM_TIMEOUT_MS,
  speakableText,
  announceDoneFrame,
  announceOpenFrame,
  announcementIsLive,
  announcementSpeechChunks,
  assertFirmwareSafeControlFrame,
  createAnnouncement,
  pcmDurationMs,
  renderAnnouncementPcm,
  selectDeliverable,
  streamAnnouncementPcm,
} from './announce.js'

test('control frames never collide with the tokens main.c matches on', () => {
  // firmware/nrf9160/src/main.c matches downlink text with strstr() against
  // these three, so an announce frame containing one would be read as a
  // barge-in flush or an end-of-conversation.
  const open = announceOpenFrame({ id: 'anc_abc123', seconds: 42 })
  const done = announceDoneFrame({ id: 'anc_abc123' })
  for (const frame of [open, done]) {
    assert.ok(!frame.includes('"started"'))
    assert.ok(!frame.includes('"flush"'))
    assert.ok(!frame.includes('"end"'))
  }
  assert.equal(JSON.parse(open).type, 'announce')
  assert.equal(JSON.parse(open).s, 42)
  // "announced" must not smuggle a quoted "end" past the guard.
  assert.equal(JSON.parse(done).type, 'announced')
})

test('a frame carrying a firmware control token is refused, not shipped', () => {
  assert.throws(
    () => assertFirmwareSafeControlFrame('{"type":"announce","title":"end"}'),
    /control token/,
  )
})

test('control frames stay far under the pendant 640 B receive buffer', () => {
  const frame = announceOpenFrame({ id: 'a'.repeat(64), seconds: 999 })
  assert.ok(Buffer.byteLength(frame) <= ANNOUNCE_CONTROL_FRAME_MAX_BYTES)
  assert.throws(
    () => assertFirmwareSafeControlFrame(`{"pad":"${'x'.repeat(400)}"}`),
    /receive buffer/,
  )
})

test('announcement ids are constrained so a frame cannot be injected through one', () => {
  assert.throws(() => announceOpenFrame({ id: 'anc "flush" x' }), /alphanumeric/)
})

test('an announcement needs something to say', () => {
  assert.throws(() => createAnnouncement({ deviceId: 'p', speech: '   ' }), /say/)
  assert.throws(() => createAnnouncement({ deviceId: 'p', speech: '## \n\n* ' }), /say/)
})

test('markdown is never spoken aloud', () => {
  // This is verbatim shape from a live runWebSearch result: the model was
  // asked for spoken-style sentences and returned a markdown report. Sent
  // straight to TTS the owner hears "hash hash Weather for Madison".
  const raw = [
    'Partly cloudy, 67°F.',
    '## Weather for Madison, Dane County:',
    '* Thursday, August 6: **High** 82°F',
    '* Friday, August 7: _High_ 85°F',
    '1. Saturday: mostly sunny',
    'See [the forecast](https://example.com/f) for more.',
  ].join('\n')
  const spoken = speakableText(raw)

  for (const symbol of ['#', '*', '_', '|', '](', 'https://']) {
    assert.ok(!spoken.includes(symbol), `"${symbol}" survived: ${spoken}`)
  }
  assert.match(spoken, /^Partly cloudy, 67°F\./)
  assert.match(spoken, /Weather for Madison, Dane County/)
  assert.match(spoken, /See the forecast for more\.$/)
  // List markers become pauses, not runs of periods.
  assert.ok(!/\.\s*\./.test(spoken), spoken)
})

test('markdown already flattened onto one line is still stripped', () => {
  // What runWebSearch actually returned in production: no newlines at all,
  // so a line-anchored header rule alone leaves "## Weather" to be spoken.
  const spoken = speakableText(
    'Partly cloudy, 67°F. ## Weather for Madison: Daily Forecast: * Thursday: 82°F',
  )
  assert.ok(!spoken.includes('#'), spoken)
  assert.ok(!spoken.includes('*'), spoken)
  assert.match(spoken, /Weather for Madison: Daily Forecast: Thursday: 82°F$/)
  // A number sign that is not a header survives — "#1 seed" is words.
  assert.match(speakableText('They are #1 in the league'), /#1/)
})

test('code fences and table pipes are stripped rather than read out', () => {
  assert.equal(speakableText('Result: ```js\nconst x=1\n```done'), 'Result: done')
  assert.equal(speakableText('| a | b |'), 'a, b')
  assert.equal(speakableText('Use `npm test` now'), 'Use npm test now')
})

test('an over-long briefing stops at a sentence, not mid-word', () => {
  const long = 'This is a complete sentence about the news. '.repeat(200)
  const spoken = speakableText(long)
  assert.ok(spoken.length <= ANNOUNCEMENT_MAX_CHARS)
  assert.match(spoken, /news\.$/)
})

test('text with no sentence to end on is clipped with an ellipsis', () => {
  const spoken = speakableText('word '.repeat(600), { maxChars: 100 })
  assert.ok(spoken.length <= 101)
  assert.match(spoken, /…$/)
})

test('announcements are normalized on the way in, wherever they came from', () => {
  const announcement = createAnnouncement({
    deviceId: 'p',
    speech: '## Headline\n* one\n* two',
  })
  assert.ok(!announcement.speech.includes('#'))
  assert.ok(!announcement.speech.includes('*'))
})

test('undelivered announcements expire rather than queue forever', () => {
  const now = Date.parse('2026-08-07T12:00:00Z')
  const announcement = createAnnouncement({
    deviceId: 'nrf9160-pendant',
    title: 'Morning news',
    speech: 'Two things happened overnight.',
    ttlMs: 60 * 60 * 1000,
    now,
  })
  assert.equal(announcementIsLive(announcement, now + 59 * 60_000), true)
  // Yesterday's news the next morning is worse than silence.
  assert.equal(announcementIsLive(announcement, now + 61 * 60_000), false)
})

test('delivery order is high priority first, then oldest', () => {
  const now = Date.parse('2026-08-07T12:00:00Z')
  const make = (title, priority, offsetMs) =>
    createAnnouncement({
      deviceId: 'p',
      title,
      speech: title,
      priority,
      now: now + offsetMs,
    })
  const chosen = selectDeliverable(
    [make('second', 'normal', 1000), make('first', 'normal', 0), make('urgent', 'high', 5000)],
    { now: now + 6000 },
  )
  assert.deepEqual(
    chosen.map((entry) => entry.title),
    ['urgent', 'first', 'second'],
  )
})

test('a briefing claimed by a socket that died is not lost forever', () => {
  const now = Date.parse('2026-08-07T12:00:00Z')
  const base = createAnnouncement({ deviceId: 'p', speech: 'the news', now })
  const claimedNow = {
    ...base,
    state: 'delivering',
    deliveringSince: new Date(now).toISOString(),
  }
  // A live claim is respected, so a reconnect cannot double-play it.
  assert.equal(announcementIsLive(claimedNow, now + 30_000), false)
  assert.deepEqual(selectDeliverable([claimedNow], { now: now + 30_000 }), [])

  // Past the claim window the socket is gone; the briefing is deliverable again.
  const stale = now + DELIVERY_CLAIM_TIMEOUT_MS + 1000
  assert.equal(announcementIsLive(claimedNow, stale), true)
  assert.equal(selectDeliverable([claimedNow], { now: stale }).length, 1)
})

test('an abandoned claim on an expired announcement still stays buried', () => {
  const now = Date.parse('2026-08-07T12:00:00Z')
  const claimed = {
    ...createAnnouncement({ deviceId: 'p', speech: 'old news', ttlMs: 60_000, now }),
    state: 'delivering',
    deliveringSince: new Date(now).toISOString(),
  }
  assert.equal(announcementIsLive(claimed, now + DELIVERY_CLAIM_TIMEOUT_MS + 1000), false)
})

test('delivered and expired announcements are never selected', () => {
  const now = Date.parse('2026-08-07T12:00:00Z')
  const live = createAnnouncement({ deviceId: 'p', speech: 'live', now })
  const spoken = { ...createAnnouncement({ deviceId: 'p', speech: 'old', now }), state: 'delivered' }
  const stale = createAnnouncement({ deviceId: 'p', speech: 'stale', ttlMs: 60_000, now })
  const chosen = selectDeliverable([live, spoken, stale], { now: now + 120_000 })
  assert.deepEqual(chosen.map((entry) => entry.speech), ['live'])
})

test('speech is chunked at sentence ends, under the TTS input cap', () => {
  const sentence = 'The market moved sharply overnight and analysts are unsure why. '
  const chunks = announcementSpeechChunks(sentence.repeat(20), { maxChars: 200 })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) {
    assert.ok(chunk.length <= 200, `chunk was ${chunk.length} chars`)
    // Sentence-aligned seams: every chunk ends where the voice would pause.
    assert.match(chunk, /[.!?]$/)
  }
  assert.equal(chunks.join(' ').replace(/\s+/g, ' '), sentence.repeat(20).trim())
})

test('a single sentence longer than the cap is still split rather than dropped', () => {
  const chunks = announcementSpeechChunks('word '.repeat(200), { maxChars: 100 })
  assert.ok(chunks.length > 1)
  for (const chunk of chunks) assert.ok(chunk.length <= 100)
})

test('rendering concatenates every TTS chunk into one PCM stream', async () => {
  const calls = []
  const pcm = await renderAnnouncementPcm({
    speech: 'One. Two. Three.',
    synthesize: async ({ text, format }) => {
      calls.push({ text, format })
      return { audio: Buffer.alloc(text.length * 2) }
    },
    maxChunks: 8,
  })
  assert.equal(calls.length, 1)
  assert.equal(calls[0].format, 'pcm')
  assert.equal(pcm.length, 'One. Two. Three.'.length * 2)
})

test('rendering nothing produces nothing rather than an empty frame storm', async () => {
  const pcm = await renderAnnouncementPcm({ speech: '   ', synthesize: async () => ({}) })
  assert.equal(pcm.length, 0)
})

test('announcement audio is metered back to real time, not dumped at socket speed', async () => {
  // A minute of pre-rendered speech pushed as fast as the socket allows
  // overruns the pendant's jitter ring; the pump paces it instead.
  const sampleRate = 24000
  const seconds = 3
  const pcm = Buffer.alloc(sampleRate * 2 * seconds)
  const sleeps = []
  const sent = []

  const result = await streamAnnouncementPcm({
    pcm,
    sampleRate,
    encode: (chunk) => Buffer.alloc(chunk.length / 40),
    split: (wire) => [wire],
    send: (frame) => sent.push(frame),
    sleep: async (ms) => sleeps.push(ms),
    pumpMs: 240,
  })

  assert.equal(result.sentBytes, pcm.length)
  assert.equal(result.stopped, false)
  assert.equal(sent.length, Math.ceil(seconds * 1000 / 240))
  // One sleep between every pair of pumps, and each stays slightly ahead of
  // the audio it just queued so LTE jitter cannot starve the ring.
  assert.equal(sleeps.length, sent.length - 1)
  for (const ms of sleeps) assert.ok(ms > 0 && ms < 240)
  assert.equal(pcmDurationMs(pcm.length, sampleRate), seconds * 1000)
})

test('barge-in stops the stream mid-briefing', async () => {
  const sampleRate = 24000
  const pcm = Buffer.alloc(sampleRate * 2 * 5)
  let pumps = 0
  const result = await streamAnnouncementPcm({
    pcm,
    sampleRate,
    encode: (chunk) => Buffer.alloc(chunk.length / 40),
    split: (wire) => [wire],
    send: () => {
      pumps += 1
    },
    sleep: async () => {},
    shouldStop: () => pumps >= 3,
    pumpMs: 240,
  })
  assert.equal(result.stopped, true)
  assert.equal(pumps, 3)
  assert.ok(result.sentBytes < pcm.length)
})

test('encoder chunks are whole samples so frame phase never shifts', async () => {
  const lengths = []
  await streamAnnouncementPcm({
    pcm: Buffer.alloc(24000 * 2),
    sampleRate: 24000,
    encode: (chunk) => {
      lengths.push(chunk.length)
      return Buffer.alloc(0)
    },
    split: () => [],
    send: () => {},
    sleep: async () => {},
    pumpMs: 37, // deliberately awkward: 37 ms of 24 kHz is 1776.0 bytes
  })
  for (const length of lengths) assert.equal(length % 2, 0)
})

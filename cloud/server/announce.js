/*
 * The outbound half of the relay: work the owner never asked for out loud.
 *
 * Everything else here is request-shaped. The pendant presses a button and
 * pulls a reply; the Mac bridge polls /v1/bridge/work and answers per job.
 * Nothing in the stack could originate a message. A 7am briefing composed at
 * 7am therefore sat in a database until the owner happened to ask for it,
 * which is the opposite of the thing they asked for.
 *
 * An announcement is that missing shape: a completed piece of work, addressed
 * to a device, that waits in a queue until a moment arrives when the relay is
 * holding that device's socket. It carries text, not audio — see
 * renderAnnouncementPcm() for why the audio is made at delivery time.
 *
 * WHAT THE FIRMWARE WILL ACTUALLY ACCEPT (firmware/nrf9160/src/main.c):
 *   - Binary downlink frames are length-prefixed Opus, ≤500 B, ≤2 packets,
 *     and are dropped unless `convo_started` is set — i.e. unless the relay
 *     has already answered a button press with {"type":"started"}.
 *   - Text downlink frames are matched with strstr() against three quoted
 *     tokens: "started", "flush", "end". Anything else is ignored.
 *   - The receive buffer is 640 B; a longer message closes the socket.
 * So the delivery that works today rides the ordinary reply-audio path right
 * after {"type":"started"}, and the control frames below are the format the
 * firmware would need to learn for a truly unprompted push. They are built
 * and guarded here so the wire contract is written down in one place rather
 * than invented twice.
 */
import crypto from 'node:crypto'
import { Buffer } from 'node:buffer'
import { HEARD_UNKNOWN } from '../shared/audioDelivery.js'

/* nRF9160 WS_RX_BUF_BYTES is 640; anything larger closes the socket. Half of
 * that is a ceiling no control frame should ever come near. */
export const ANNOUNCE_CONTROL_FRAME_MAX_BYTES = 320

/*
 * main.c matches control frames with strstr() on these exact quoted tokens,
 * so a token appearing ANYWHERE in an announce frame — including inside a
 * title the owner wrote — would be read as a flush or an end-of-conversation.
 * Control frames therefore carry ids and numbers only, and this guard makes
 * that a rule rather than a habit.
 */
const FIRMWARE_CONTROL_TOKENS = ['"started"', '"flush"', '"end"']

export function assertFirmwareSafeControlFrame(json) {
  const text = String(json)
  for (const token of FIRMWARE_CONTROL_TOKENS) {
    if (text.includes(token)) {
      throw new Error(
        `Announce frame contains the firmware control token ${token}; ` +
          'the pendant would mistake it for a conversation control message.',
      )
    }
  }
  const bytes = Buffer.byteLength(text, 'utf8')
  if (bytes > ANNOUNCE_CONTROL_FRAME_MAX_BYTES) {
    throw new Error(
      `Announce frame is ${bytes} B; the pendant's receive buffer closes the ` +
        `socket above 640 B, so frames are capped at ${ANNOUNCE_CONTROL_FRAME_MAX_BYTES} B.`,
    )
  }
  return text
}

export function createAnnouncementId() {
  return `anc_${crypto.randomUUID().replaceAll('-', '').slice(0, 20)}`
}

/*
 * A briefing the owner never heard is stale long before it is wrong. Playing
 * yesterday's news the next time they press the button would be worse than
 * silence, so an undelivered announcement expires rather than queues forever.
 */
export const ANNOUNCEMENT_DEFAULT_TTL_MS = 6 * 60 * 60 * 1000

/*
 * Roughly 80 seconds at the pendant's speaking rate. The ceiling is not the
 * radio — Opus at 16 kbps is about 12 KB a spoken minute — it is what the
 * owner will stand still for, the same reasoning as BRIEF_MAX_SECONDS in
 * local-agent/audioBrief.js.
 */
export const ANNOUNCEMENT_MAX_CHARS = 1500

/**
 * Make text safe to say out loud.
 *
 * Everything upstream of here writes for a screen. `runWebSearch` is asked for
 * "2-3 spoken-style sentences" and cheerfully returns markdown headers and
 * bullet lists anyway; a Mac plan result can carry the same. Sent to TTS
 * unchanged, the owner hears "hash hash Weather for Madison comma Dane County
 * colon asterisk Thursday" — which is how a working pipeline still produces an
 * unusable briefing. Normalising at the announcement boundary means every
 * producer gets it for free and none of them has to remember.
 */
export function speakableText(raw, { maxChars = ANNOUNCEMENT_MAX_CHARS } = {}) {
  let text = String(raw || '')
    /* Fenced code and inline backticks are never speech. */
    .replace(/```[\s\S]*?```/g, ' ')
    .replace(/`([^`]*)`/g, '$1')
    /* Links: say the label, drop the URL. */
    .replace(/\[([^\]]+)\]\([^)]*\)/g, '$1')
    /*
     * Headers and blockquotes become sentence boundaries, not symbols. The
     * second rule is not redundant: a search result often arrives already
     * flattened onto one line, so "… (20°C). ## Weather for Madison" has no
     * line start for the anchored pattern to match. A "#" with no trailing
     * space ("#1 seed") is left alone.
     */
    .replace(/^\s{0,3}#{1,6}\s*/gm, '')
    .replace(/(^|\s)#{1,6}\s+/g, '$1')
    .replace(/^\s{0,3}>\s?/gm, '')
    /* List markers likewise: a pause, not the word "asterisk". */
    .replace(/^\s*[-*+•]\s+/gm, '. ')
    .replace(/^\s*\d+[.)]\s+/gm, '. ')
    /* Emphasis and table pipes. */
    .replace(/(\*\*|__|\*|_|~~)/g, '')
    .replace(/\|/g, ', ')
    /* Horizontal rules. */
    .replace(/^\s*([-=_])\1{2,}\s*$/gm, ' ')
    .replace(/\s+/g, ' ')
    /* The rewrites above leave ". ." runs and dangling separators behind. */
    .replace(/(?:\s*\.){2,}/g, '.')
    .replace(/([,:;])\s*\./g, '$1')
    .replace(/\s+([,.;:])/g, '$1')
    .replace(/^[\s.,;:]+/, '')
    .replace(/[\s,;:]+$/, '')
    .trim()

  if (text.length <= maxChars) return text
  /* Cut at a sentence end so a briefing stops rather than being sliced
   * mid-word; fall back to a hard cut when there is no sentence to end on. */
  const clipped = text.slice(0, maxChars)
  const lastStop = Math.max(
    clipped.lastIndexOf('. '),
    clipped.lastIndexOf('! '),
    clipped.lastIndexOf('? '),
  )
  return lastStop > maxChars * 0.5
    ? clipped.slice(0, lastStop + 1).trim()
    : `${clipped.trim()}…`
}

export function createAnnouncement({
  deviceId,
  title,
  speech,
  routineId = null,
  runId = null,
  captureId = null,
  ttlMs = ANNOUNCEMENT_DEFAULT_TTL_MS,
  now = Date.now(),
  priority = 'normal',
}) {
  const text = speakableText(speech)
  if (!text) throw new Error('An announcement needs something to say.')
  const createdAt = new Date(now).toISOString()
  return {
    announcementId: createAnnouncementId(),
    deviceId: String(deviceId || '').trim() || 'nrf9160-pendant',
    title: String(title || '').slice(0, 120) || 'Update',
    speech: text,
    routineId,
    runId,
    captureId,
    priority: priority === 'high' ? 'high' : 'normal',
    state: 'pending',
    createdAt,
    expiresAt: new Date(now + Math.max(60_000, ttlMs)).toISOString(),
    deliveredAt: null,
    deliveryPath: null,
    /*
     * `state` is a QUEUE state — pending / delivering / delivered / dismissed —
     * and 'delivered' there means only "stop offering this one", not "the owner
     * heard it". The evidence lives in these three, kept separate so the queue's
     * bookkeeping can never be spent as proof of an ear.
     */
    deliveryEvidence: null,
    sentBytes: 0,
    heard: HEARD_UNKNOWN,
    attempts: 0,
  }
}

/**
 * Turn what streamAnnouncementPcm() actually observed into fields that say it.
 *
 * The old call site set `state: sentBytes > 0 ? 'delivered' : 'pending'` and
 * then stamped `deliveredAt` unconditionally — so an announcement that sent zero
 * bytes went back on the queue carrying a delivery timestamp. Anything reading
 * `deliveredAt` as evidence was reading a clock, not a delivery.
 *
 * `deliveredAt` is now only ever set when bytes really left, and even then it
 * timestamps a socket write, which is why `heard` stays unknown beside it.
 */
export function announcementDeliveryOutcome({
  sentBytes = 0,
  sentFrames = 0,
  stopped = false,
  now = () => new Date().toISOString(),
} = {}) {
  const bytes = Math.max(0, Number(sentBytes) || 0)
  const sent = bytes > 0

  return {
    state: sent ? 'delivered' : 'pending',
    /* No bytes, no timestamp. A null here is the honest value. */
    deliveredAt: sent ? now() : null,
    deliveryPath: sent ? (stopped ? 'converse-interrupted' : 'converse') : null,
    /*
     * Both rungs are the same rung: the relay socket accepted bytes. An
     * interrupted briefing is recorded as interrupted rather than quietly
     * folded into a complete one, because "some of it went out" and "all of it
     * went out" are different facts even when neither proves an ear.
     */
    deliveryEvidence: sent ? 'bytes_sent_to_device' : null,
    deliveryComplete: sent && !stopped,
    sentBytes: bytes,
    sentFrames: Math.max(0, Number(sentFrames) || 0),
    /*
     * The pendant never reports playback — the firmware defines the reporters
     * and calls neither — so this cannot be anything else. See
     * PLAYBACK_REPORT_CONTRACT in shared/audioDelivery.js.
     */
    heard: HEARD_UNKNOWN,
  }
}

/*
 * How long a delivery claim is honoured.
 *
 * Delivery marks an announcement 'delivering' before speaking it, so a
 * reconnect racing a stale socket cannot play the same briefing twice. The
 * cost of that claim is that a Worker killed mid-stream — dropped LTE, an
 * evicted isolate — leaves the announcement claimed by nobody, and it would
 * never be spoken again. Past this window the claim is treated as abandoned
 * and the announcement is deliverable once more. Comfortably longer than the
 * longest briefing, so this can only ever release a claim that really is dead.
 */
export const DELIVERY_CLAIM_TIMEOUT_MS = 5 * 60 * 1000

export function announcementIsLive(announcement, now = Date.now()) {
  if (!announcement) return false
  const expiresAt = Date.parse(announcement.expiresAt || '')
  if (Number.isFinite(expiresAt) && expiresAt <= now) return false

  if (announcement.state === 'pending') return true
  if (announcement.state !== 'delivering') return false
  const claimedAt = Date.parse(announcement.deliveringSince || '')
  return (
    !Number.isFinite(claimedAt) || now - claimedAt > DELIVERY_CLAIM_TIMEOUT_MS
  )
}

/**
 * What to play, oldest first, high priority ahead of normal. More than one
 * pending announcement is already a failure of delivery, so the whole live
 * backlog is spoken in one go rather than trickled out one press at a time.
 */
export function selectDeliverable(announcements, { now = Date.now(), limit = 3 } = {}) {
  return (announcements || [])
    .filter((entry) => announcementIsLive(entry, now))
    .sort(
      (a, b) =>
        (b.priority === 'high' ? 1 : 0) - (a.priority === 'high' ? 1 : 0) ||
        String(a.createdAt).localeCompare(String(b.createdAt)),
    )
    .slice(0, limit)
}

/*
 * speak.js truncates its input at 800 characters, which is about 45 seconds of
 * speech — shorter than a briefing. Splitting on sentence ends rather than at
 * the 800th character keeps the seam between two TTS calls at a place the
 * voice would have paused anyway.
 */
export const SPEECH_CHUNK_MAX_CHARS = 700

export function announcementSpeechChunks(text, { maxChars = SPEECH_CHUNK_MAX_CHARS } = {}) {
  const clean = String(text || '').replace(/\s+/g, ' ').trim()
  if (!clean) return []
  const sentences = clean.match(/[^.!?]+[.!?]*\s*/g) || [clean]
  const chunks = []
  let current = ''
  for (const sentence of sentences) {
    /* A single sentence longer than the cap is split on width; nothing else
     * can be done without inventing punctuation. */
    if (sentence.length > maxChars) {
      if (current.trim()) chunks.push(current.trim())
      current = ''
      for (let index = 0; index < sentence.length; index += maxChars) {
        chunks.push(sentence.slice(index, index + maxChars).trim())
      }
      continue
    }
    if ((current + sentence).length > maxChars && current.trim()) {
      chunks.push(current.trim())
      current = ''
    }
    current += sentence
  }
  if (current.trim()) chunks.push(current.trim())
  return chunks.filter(Boolean)
}

/**
 * Text to 24 kHz mono s16le PCM — the one format the pendant path accepts.
 *
 * This runs at DELIVERY time, inside the WebSocket invocation, never inside
 * the cron. A Cron Trigger on the Workers Free plan gets 10 ms of CPU; audio
 * work does not fit in that and does not need to, because an announcement
 * composed at 7am is not heard until the owner's socket is in hand anyway.
 */
export async function renderAnnouncementPcm({
  speech,
  synthesize,
  maxChunks = 8,
}) {
  const chunks = announcementSpeechChunks(speech).slice(0, maxChunks)
  if (!chunks.length) return Buffer.alloc(0)
  const parts = []
  for (const chunk of chunks) {
    const result = await synthesize({ text: chunk, format: 'pcm', includeBase64: false })
    const audio = result?.audio
    if (audio?.length) parts.push(Buffer.from(audio))
  }
  return parts.length ? Buffer.concat(parts) : Buffer.alloc(0)
}

/*
 * Downlink pacing.
 *
 * Agent speech is naturally paced: OpenAI emits deltas as it generates them,
 * so the socket never runs ahead of the pendant's 3-second jitter ring. A
 * pre-rendered announcement has no such governor — pushed at socket speed a
 * minute of speech arrives in under a second, the firmware's 8-slot downlink
 * message queue fills, TCP backpressure stalls the WS thread, and the frames
 * that do land overrun the ring. So it is metered back to real time here.
 */
export const ANNOUNCE_PUMP_MS = 240

export function pcmDurationMs(byteLength, sampleRate) {
  return (byteLength / 2 / sampleRate) * 1000
}

/**
 * Stream rendered PCM down an open pendant socket at wall-clock speed.
 *
 * Everything device-specific is injected: `encode` turns a PCM slice into the
 * length-prefixed Opus wire, `split` chops it into modem-safe frames, `send`
 * puts one frame on the socket. Returns what was actually delivered so the
 * caller can decide whether the announcement counts as spoken.
 */
export async function streamAnnouncementPcm({
  pcm,
  sampleRate,
  encode,
  split,
  send,
  sleep,
  shouldStop = () => false,
  onProgress = null,
  pumpMs = ANNOUNCE_PUMP_MS,
}) {
  const total = pcm?.length || 0
  if (!total) return { sentBytes: 0, sentFrames: 0, stopped: false }
  /* Even samples only: half a sample would shift every later frame's phase. */
  const chunkBytes = Math.max(2, Math.round((sampleRate * 2 * pumpMs) / 1000) & ~1)
  let sentBytes = 0
  let sentFrames = 0

  for (let offset = 0; offset < total; offset += chunkBytes) {
    if (shouldStop()) return { sentBytes, sentFrames, stopped: true }
    const slice = pcm.subarray(offset, Math.min(offset + chunkBytes, total))
    const wire = encode(slice)
    if (wire?.length) {
      for (const frame of split(wire)) {
        send(frame)
        sentFrames += 1
      }
    }
    sentBytes += slice.length
    onProgress?.({ sentBytes, total })
    /*
     * Sleep a little less than the audio just queued. Staying marginally
     * ahead keeps the ring fed across LTE jitter; staying far ahead is the
     * overrun this whole function exists to avoid.
     */
    if (offset + chunkBytes < total) await sleep(Math.round(pumpMs * 0.8))
  }
  return { sentBytes, sentFrames, stopped: false }
}

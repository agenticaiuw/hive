import crypto from 'node:crypto'
import path from 'node:path'

import {
  ensureJsonStore,
  readJsonWithRecovery,
  writeJsonAtomic,
} from './atomicJsonStore.js'
import { listEvents } from './appleData.js'
import { audioRetentionPolicy, deleteAudioForJob } from './audioRetention.js'
import { workspacePath } from './config.js'
import { isVirtualLocation } from './dayPlan.js'
import { stripLeadIn } from './quickCapture.js'
import { classifySensitivity } from './redaction.js'
import { scheduleReminder } from './remindMe.js'

/*
 * Voice notes: the press already worked, so this module is only about what
 * happens AFTER the transcript exists.
 *
 * WHAT WAS ALREADY THERE, AND WHY NOTHING HERE RE-CAPTURES ANYTHING
 * -----------------------------------------------------------------
 * The whole capture path is built and running:
 *
 *   firmware/nrf9160/src/main.c   button 1 (sw0) records; button 2 (sw1) drops
 *                                 a moment bookmark. Both were pressed on this
 *                                 hardware today.
 *   cloud-relay /v1/transcribe    speech-to-text before the job reaches the Mac.
 *   pipelineTrace.js              stores the run and the transcript in
 *                                 pendant-pipeline.json, stage `transcription`,
 *                                 field `text`.
 *   pipelineAudio.js              writes the recording to pipeline-audio/.
 *   pendantSpeech.js              renders the reply.
 *
 * Measured in ~/AI-Pendant-Workspace/pendant-pipeline.json on 2026-08-07: 67
 * runs, 23 of them carrying a finished transcript, plus one real `bookmark`
 * event from the nRF9160. A voice NOTE differs from a voice COMMAND only in
 * what is done with that text, so this module reads the run and never opens a
 * microphone, never calls the relay, and never re-transcribes.
 *
 * WHY A SEPARATE STORE AND NOT "JUST READ THE PIPELINE"
 * ----------------------------------------------------
 * pipelineTrace.js caps at MAX_RUNS = 80. Measured arrival rate over the 4.59
 * days on disk was 14.6 runs/day, so the cap rolls the whole store in about
 * 5.5 days — and audioRetention.js has already measured what that eviction
 * does: it strands the files and drops the only handle on them. A note that
 * lived in pendant-pipeline.json would be gone by next weekend, which is not
 * what "and later summarise or remind me from it" means. The note is copied
 * out at capture time into a store whose whole job is outliving that cap.
 *
 * THE NOTE IS ITS TRANSCRIPT. THIS MODULE NEVER WRITES AUDIO.
 * ----------------------------------------------------------
 * audioRetention.js gives captured speech — the owner's own voice — the
 * shortest life of anything on disk, 6 hours, and says why: the transcription
 * has already succeeded by the time the file exists, so the recording is a
 * debugging byproduct of a finished job, and it is the most sensitive thing the
 * system holds. Measured in pipeline-audio/ on 2026-08-07: 61 `-output.wav`
 * (the agent talking) and ZERO `-input.wav`. There is, right now, no captured
 * recording on this disk at all. The transcript is not a lossy stand-in for the
 * audio; it is the only artifact that exists.
 *
 * So there is no pin, flag or route here that keeps a recording alive, and none
 * that copies one somewhere the sweeper cannot see. That copy would be
 * invisible to audioRetention.scanAudioOnDisk() — it walks exactly two
 * directories — and would therefore silently defeat deleteAudioForJob(), which
 * is the call that answers "forget that conversation". Trading a working
 * deletion promise for a recording nobody has asked to keep is a bad trade.
 * What this module does instead is tell the truth about the deadline:
 * `recording.expiresAt` on every note is computed from audioRetention's own
 * effective policy, so the owner sees the audio going away rather than
 * discovering it gone.
 *
 * WHAT "PINNED" MEANS HERE, AND WHY UNPINNED NOTES STILL EXPIRE
 * ------------------------------------------------------------
 * A note is the owner's own words in plain text. audioRetention.js makes the
 * point precisely, about the briefing store: an entry left behind "carries
 * `spoken`, the full transcript of what was said... Deleting the recording and
 * keeping the words is not deletion." A note store that never expires anything
 * is exactly that failure with a friendlier name — the recording dies at 6 h
 * and a permanent copy of what the owner said survives it forever, with nobody
 * having decided that.
 *
 * So notes are NOT silently exempt from retention. They expire at
 * VOICE_NOTE_DEFAULT_MAX_AGE_MS (30 days), and `pinned: true` — an explicit
 * act, one route, one field — is what makes a note permanent. 30 days is
 * chosen against the measurement above: the pipeline store rolls in 5.5 days,
 * so an unpinned note already outlives its own source by 5.5x, which is long
 * enough for "what did I say last month" and short enough that the owner's
 * unreviewed voice does not accumulate for a year by default.
 *
 * THE BUDGET IS IN BYTES (see jobTracker.js's postmortem, and audioRetention's)
 * ---------------------------------------------------------------------------
 * A store that capped a COUNT reached 129 MB and the agent stopped answering.
 * Notes are small — the 23 transcripts on disk have a median length of 13
 * characters and a maximum of 58 — but "small" is the assumption that failed
 * there, and nothing stops a note from carrying a 2 000-character dictation.
 * The bound is bytes.
 *
 * THREE CLOCKS, NEVER MERGED
 * --------------------------
 * The one real bookmark on this disk reads:
 *
 *   captured_at=26/08/07,07:09:45 uptime_s=98 link_at_capture=down
 *   ... recorded by the Mac at 2026-08-07T07:12:02.787Z
 *
 * 137 seconds apart, because the device held it on its card until the link came
 * back. And `captured_at` carries NO UTC offset: firmware pendant_cloud.c reads
 * AT+CCLK?, whose NITZ form is "yy/MM/dd,hh:mm:ss±zz" with zz in quarter-hours,
 * and the tower never gave this device a zone. Digits without a zone are not an
 * instant — they cannot be placed on a timeline without assuming one. So this
 * module keeps `recordedAt` (Mac wall clock, trustworthy, and the only thing
 * ever sorted or filtered on) apart from `context.device` (the device's own
 * claim, carrying its `quality` and a null `at` when it cannot be placed) and
 * refuses to invent the missing offset — the same refusal catchupSources.js
 * makes about the same field.
 */

/* Notes are text; 2 000 characters is roughly four minutes of speech at the
 * 210 wpm pendantSpeech.js renders at, and 34x the longest transcript measured
 * on this disk (58 characters). Anything past it is a stuck transcriber, not a
 * note. */
const MAX_NOTE_CHARS = 2000
const MAX_TITLE_CHARS = 80
const MAX_TAG_CHARS = 40
const MAX_TAGS = 12

/* pendantSpeech.js truncates spoken text at 180 characters, so a summary meant
 * to be read back over the pendant is built to that budget rather than being
 * cut in half by the renderer. */
const MAX_SPOKEN_CHARACTERS = 180

const DAY_MS = 24 * 60 * 60 * 1000

/** 30 days — see the retention note in the header. Pinned notes ignore this. */
export const VOICE_NOTE_DEFAULT_MAX_AGE_MS = 30 * DAY_MS

/* 4 MiB. At the measured press rate (14.6/day) every single press becoming a
 * note for the full 30-day window is ~440 notes, and a written record measured
 * 1 542 bytes, so that busiest-plausible-month case is ~680 KB — the budget
 * sits about 6x above it. It exists for what age cannot cover: a caller in a
 * loop, which is what produced the 50 identical briefing entries
 * audioRetention.js had to clean up. */
export const VOICE_NOTE_DEFAULT_MAX_BYTES = 4 * 1024 * 1024

const STORE_SHAPE = {
  validate: (value) => value && Array.isArray(value.notes),
}
const EMPTY_STORE = { notes: [] }

/*
 * Pendant-specific ways of saying "this is a note, not an order".
 *
 * quickCapture.js already owns the shared vocabulary ("remember this", "save
 * this for later", "jot this down") and its stripLeadIn() is reused below
 * rather than copied — two lists of lead-ins would drift and the owner would
 * find that one phrase works when typed and not when spoken. What is added
 * here is only what a worn device gets said to: "note to self", and the word
 * "note"/"memo" used as a noun for the thing being made.
 *
 * Ordered longest-first for the same reason quickCapture's list is: "make a
 * voice note" must not be clipped to "voice note" leaving a dangling verb.
 */
const VOICE_NOTE_LEAD_INS = [
  /^(?:hey\s+)?(?:pendant|assistant)[,:\s]+/i,
  /^(?:please\s+)?(?:make|take|record|leave|start)\s+(?:me\s+)?a\s+(?:quick\s+)?(?:voice\s+)?(?:note|memo)\s*(?:to\s+self)?\s*(?:that|of|about|:)?\s*/i,
  /^note\s+to\s+self\b[:,.\s–—-]*/i,
  /^(?:voice\s+)?(?:note|memo)\b\s*(?:to\s+self)?\s*[:,.\s–—-]+/i,
  /^for\s+the\s+record\b[:,.\s–—-]*/i,
]

/**
 * Is this utterance a note, and what is the note?
 *
 * Returns `{ isNote, text, matched }`. A command ("open Outlook") comes back
 * `isNote: false` and is left entirely alone: nothing here should turn the 23
 * transcripts already on this disk into 23 permanent records of the owner's
 * voice. Creating a note is an act, not a side effect of speaking.
 */
export function voiceNoteIntent(utterance) {
  const raw = String(utterance ?? '').replace(/\s+/g, ' ').trim()
  if (!raw) return { isNote: false, text: '', matched: null }

  for (const pattern of VOICE_NOTE_LEAD_INS) {
    const stripped = raw.replace(pattern, '').trim()
    if (stripped !== raw) {
      return {
        isNote: true,
        text: unquote(stripped),
        matched: raw.slice(0, raw.length - stripped.length).trim() || null,
      }
    }
  }

  /* Delegated so "remember this" and friends mean the same thing spoken to the
   * pendant as typed into quickCapture. A changed string is the signal a
   * lead-in was consumed; stripLeadIn returns its input untouched otherwise. */
  const shared = stripLeadIn(raw)
  if (shared && shared !== raw) {
    return {
      isNote: true,
      text: unquote(shared),
      matched: raw.slice(0, Math.max(0, raw.length - shared.length)).trim() || null,
    }
  }

  return { isNote: false, text: raw, matched: null }
}

function unquote(text) {
  return String(text).replace(/^["“']|["”']$/g, '').trim()
}

/* ------------------------------------------------------------------ clocks */

/*
 * The device's own timestamp, as a claim rather than a number.
 *
 * `stamp` is whatever AT+CCLK? gave the modem, forwarded verbatim:
 * "yy/MM/dd,hh:mm:ss" optionally followed by "±zz" in QUARTER-HOURS (3GPP
 * 27.007). The quarter-hour unit is the part that gets silently mis-read as
 * minutes or hours; +32 is UTC+8, not UTC+32 and not UTC+00:32.
 *
 * Without the offset there is no instant, only digits, and this returns
 * `at: null` with `quality: 'unknown'`. That is the honest answer and it is the
 * measured one: the single bookmark on this disk has no offset, because this
 * device has never registered with a tower that would send NITZ.
 */
export function parseDeviceClock(stamp) {
  const text = String(stamp ?? '').trim()
  const match =
    /^(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})(?:([+-])(\d{1,2}))?$/.exec(
      text,
    )
  if (!match) {
    return { raw: text || null, local: null, at: null, quality: 'unknown', offsetMinutes: null }
  }

  const [, yy, mm, dd, hh, mi, ss, sign, quarters] = match
  const local = `20${yy}-${mm}-${dd}T${hh}:${mi}:${ss}`

  if (!sign) {
    return {
      raw: text,
      local,
      at: null,
      quality: 'unknown',
      offsetMinutes: null,
      /* Said out loud because the alternative — quietly assuming this Mac's
       * zone — would produce a confident timestamp that is wrong by however
       * many time zones the owner has travelled, which is the one case a
       * worn device exists to handle. */
      why: 'The device clock carries no UTC offset, so these digits cannot be placed on a timeline.',
    }
  }

  const offsetMinutes = (sign === '-' ? -1 : 1) * Number(quarters) * 15
  const at = new Date(
    Date.parse(`${local}Z`) - offsetMinutes * 60 * 1000,
  ).toISOString()
  return { raw: text, local, at, quality: 'wall', offsetMinutes }
}

/*
 * Pull the device's clock out of a pipeline run.
 *
 * Two shapes carry it and both are real on this disk:
 *   - a `bookmark` event, whose detail reads
 *     "captured_at=26/08/07,07:09:45 uptime_s=98 link_at_capture=down"
 *   - a `transcription` event's meta.inputTelemetry, where `storage` tells us
 *     whether the recording came off the card (offline, delayed) or over a live
 *     socket (immediate).
 */
export function deviceClockFromRun(run) {
  const events = Array.isArray(run?.events) ? run.events : []
  const bookmark = events.find((event) => event?.stage === 'bookmark')
  const transcription = events.find((event) => event?.stage === 'transcription')
  const telemetry = transcription?.meta?.inputTelemetry ?? null

  const detail = String(bookmark?.detail ?? '')
  const stamp =
    /captured_at=([^\s]+)/.exec(detail)?.[1] ??
    (typeof telemetry?.deviceTime === 'string' ? telemetry.deviceTime : null)
  const uptimeText = /uptime_s=(\d+)/.exec(detail)?.[1]
  const linkText = /link_at_capture=(\w+)/.exec(detail)?.[1]

  const clock = parseDeviceClock(stamp)
  /* A bookmark run has no transcription event at all — it stamps `storage`
   * directly on the bookmark's own meta ({storage:'microSD', origin:
   * 'pendant-offline-store'} on the one measured). Reading only the telemetry
   * dropped it and reported storage:null for a run that plainly said microSD. */
  const storage = String(
    telemetry?.storage ?? bookmark?.meta?.storage ?? '',
  ).toLowerCase()

  return {
    ...clock,
    uptimeSeconds: uptimeText ? Number(uptimeText) : null,
    /* Not cosmetic. `down` or `microsd` means the device held this on its card
     * and the gap between speaking and recording is store-and-forward, not
     * processing — 137 s on the one bookmark measured. */
    linkAtCapture: linkText ?? (storage ? (storage === 'live_lte' ? 'up' : 'unknown') : null),
    heldOnDevice: linkText === 'down' || storage === 'microsd',
    storage: storage || null,
  }
}

/* ----------------------------------------------------------------- context */

/*
 * "Tag it with time and place if available."
 *
 * TIME is available three ways and they are kept apart, per the header.
 *
 * PLACE IS NOT SENSED. There is exactly one real place source in this system
 * and it is the calendar, which is a schedule and not a position — see
 * resolveVoiceNotePlace() below, which is async and deliberately not called
 * from here. What was searched for and found genuinely absent:
 *
 *   GNSS      The nRF9160 SiP has a GPS receiver in silicon and the build even
 *             tunes the antenna for it (CONFIG_MODEM_ANTENNA_GNSS_ONBOARD=y,
 *             CONFIG_LTE_NETWORK_MODE_LTE_M_NBIOT_GPS=y in
 *             build-opus/zephyr/.config). But CONFIG_LOCATION and CONFIG_GNSS
 *             are both unset and `nrf_modem_gnss` appears ZERO times in
 *             firmware/nrf9160/src. Nothing ever starts the receiver or reads
 *             a fix. A field named `gps` here would be permanently null.
 *   Cell      pendant_cloud.c:73 does run AT%XMONITOR — which carries MCC/MNC,
 *             TAC and cell id — but only inside a 5-second attach-diagnostic
 *             timer, and the answer goes to printk on the UART. It is never
 *             parsed, stored or uploaded, and there is no cell-to-place
 *             database on the other end either.
 *   NITZ zone The one geographic crumb the design does carry — the "±zz" UTC
 *             offset in AT+CCLK? — is a whole time zone wide, and this device
 *             has never been given one (see parseDeviceClock). A UTC offset is
 *             not a place; rendering "UTC+2" as "Central Europe" would be the
 *             invention this module exists to avoid.
 *   Wi-Fi     The pendant has no Wi-Fi radio. The Mac's SSID is reachable in
 *             principle (actionRisk.js allowlists `networksetup
 *             -getairportnetwork`) but describes this desk, not the pendant.
 *   Mac       This process runs on the Mac. Its IANA time zone is real and is
 *             recorded below — but it describes where the NOTE WAS WRITTEN
 *             DOWN, which is this desk, not where the owner was standing when
 *             they spoke. It is labelled `writtenDownIn` for exactly that
 *             reason and must never be presented as the owner's location.
 *
 * The device has also not registered with the relay, so even the LTE-derived
 * crumbs are unavailable today rather than merely coarse.
 */
export function voiceNoteContext({ run = null, now = Date.now(), timeZone = null } = {}) {
  const zone =
    timeZone ||
    (() => {
      try {
        return Intl.DateTimeFormat().resolvedOptions().timeZone || null
      } catch {
        return null
      }
    })()

  const device = deviceClockFromRun(run)

  return {
    recordedAt: new Date(now).toISOString(),
    /* The Mac's zone, named for what it actually is. */
    writtenDownIn: zone,
    localTime: zone ? formatLocal(now, zone) : null,
    localDay: zone ? formatDay(now, zone) : new Date(now).toISOString().slice(0, 10),
    device,
    source: run?.source ?? null,
    place: null,
    /* A caller rendering "somewhere" needs the reason, not a blank. */
    placeUnavailable: {
      reason:
        'Nothing on this device senses position. GNSS is configured but never started, cell identity is printed to UART and never captured, the pendant has no Wi-Fi radio, and it has not registered with the relay.',
      checked: ['gnss', 'cell-identity', 'nitz-utc-offset', 'wifi-ssid', 'mac-host'],
      available:
        'The calendar knows where the owner was SCHEDULED to be. Call resolveVoiceNotePlace() / POST /voice-notes/:id/place to attach it; it is not on the capture path because it costs an osascript round-trip.',
    },
  }
}

/*
 * The one real place source: the owner's calendar.
 *
 * appleData.listEvents() reads EventKit through JXA under the TCC grant
 * Calendar.app already holds, and every event carries a free-text `location`.
 * That is a genuine answer to "where was I" — with one qualification that is
 * kept in the data and never dropped: a calendar says where the owner was
 * SUPPOSED to be. `basis: 'scheduled'` is on every result so no caller can
 * render it as a sensed position.
 *
 * WHY THIS IS NOT ON THE CAPTURE PATH
 * A bare `osascript -l JavaScript -e '1+1'` measured a 23 ms median round-trip
 * on this Mac (5 runs: 23/23/23/24/27), and that is the FLOOR — EventKit store
 * init and a predicate over the real calendars land far above it, and remindMe
 * .js already records that these named-app calls fire macOS Automation prompts
 * that were actively interrupting the owner. quickCapture.js sets the standard
 * for this class of work: capture "has to be over before the owner has finished
 * walking past the bike rack". So the note is written first and the place is
 * attached afterwards, which also means a denied TCC prompt costs the place tag
 * and never the note.
 *
 * A Zoom link is not a place. dayPlan.js already owns that judgement in
 * isVirtualLocation(); it is reused rather than re-expressed so "is this a
 * real room" cannot mean two different things in two files.
 */
export async function resolveVoiceNotePlace(
  { at = Date.now(), windowMinutes = 0 } = {},
  { readEvents = listEvents } = {},
) {
  const moment = typeof at === 'number' ? at : Date.parse(at)
  const slack = Math.max(0, Number(windowMinutes) || 0) * 60 * 1000
  const checkedAt = new Date(moment).toISOString()

  let events
  try {
    events = await readEvents({
      from: new Date(moment - slack - 60 * 60 * 1000),
      to: new Date(moment + slack + 60 * 60 * 1000),
    })
  } catch (error) {
    /* A refused Automation prompt or a Calendar that is not running is a
     * missing place, not a failed capture. */
    return {
      place: null,
      kind: 'unavailable',
      basis: 'scheduled',
      checkedAt,
      detail: `The calendar could not be read: ${String(error?.message ?? error)}`,
    }
  }

  const overlapping = (Array.isArray(events) ? events : []).filter((event) => {
    /* All-day events are dropped here even though dayPlan.js keeps them: "Family
     * in town" shapes a day but does not say which room the owner was in. */
    if (event?.allDay) return false
    const start = Date.parse(event?.start)
    const end = Date.parse(event?.end)
    if (!Number.isFinite(start) || !Number.isFinite(end)) return false
    return start - slack <= moment && moment <= end + slack
  })

  if (!overlapping.length) {
    return {
      place: null,
      kind: 'none',
      basis: 'scheduled',
      checkedAt,
      detail: 'Nothing was on the calendar at that moment, so there is no place to attach.',
    }
  }

  /* Shortest first: a 30-minute stand-up inside a 4-hour "Offsite" block is the
   * more specific statement about where the owner actually was. */
  const best = [...overlapping].sort(
    (left, right) =>
      Date.parse(left.end) - Date.parse(left.start) - (Date.parse(right.end) - Date.parse(right.start)),
  )[0]

  const located = overlapping.find(
    (event) => event.location && !isVirtualLocation(event.location),
  )

  if (!located) {
    return {
      place: null,
      kind: best.location ? 'virtual' : 'none',
      basis: 'scheduled',
      checkedAt,
      eventUid: best.uid ?? null,
      eventTitle: best.title ?? null,
      detail: best.location
        ? `"${best.title}" was a call, not a room — a meeting link says nothing about where the owner was.`
        : `"${best.title}" was on the calendar but carried no location.`,
    }
  }

  return {
    place: cleanText(located.location, 120),
    kind: 'calendar-event',
    basis: 'scheduled',
    checkedAt,
    eventUid: located.uid ?? null,
    eventTitle: located.title ?? null,
    calendar: located.calendar ?? null,
    detail:
      'Where the calendar said the owner would be. This is a schedule, not a position — nothing on the pendant senses where it is.',
  }
}

/**
 * Back-fill a note's place after the fact.
 *
 * Separate from capture on purpose (see resolveVoiceNotePlace). Returns the
 * updated note, or null when the note is gone.
 */
export async function attachVoiceNotePlace(
  noteId,
  { windowMinutes = 0, now = Date.now() } = {},
  options = {},
  { readEvents = listEvents } = {},
) {
  const note = getVoiceNote(noteId, options)
  if (!note) return null

  const place = await resolveVoiceNotePlace(
    { at: Date.parse(note.recordedAt), windowMinutes },
    { readEvents },
  )

  return mutate(
    noteId,
    (stored) => ({
      ...stored,
      context: {
        ...stored.context,
        place,
        /* Cleared only when a real room was found. A "we looked and there was
         * nothing" result leaves the explanation in place, because that is
         * still the honest answer to "why has this note no place". */
        placeUnavailable: place.place ? null : stored.context.placeUnavailable,
      },
      updatedAt: new Date(now).toISOString(),
    }),
    options,
  )
}

function formatLocal(millis, timeZone) {
  try {
    return new Intl.DateTimeFormat('en-US', {
      timeZone,
      dateStyle: 'medium',
      timeStyle: 'short',
    }).format(new Date(millis))
  } catch {
    return null
  }
}

function formatDay(millis, timeZone) {
  try {
    /* en-CA gives ISO-ordered YYYY-MM-DD, which sorts and groups correctly. */
    return new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    }).format(new Date(millis))
  } catch {
    return new Date(millis).toISOString().slice(0, 10)
  }
}

/* ------------------------------------------------------------------- store */

export function voiceNotesLocation({ filePath = undefined } = {}) {
  return filePath
    ? path.resolve(filePath)
    : path.join(workspacePath, '.pendant-voice-notes.json')
}

function readStore({ filePath } = {}) {
  const storePath = voiceNotesLocation({ filePath })
  ensureJsonStore(storePath, EMPTY_STORE, STORE_SHAPE)
  return readJsonWithRecovery(storePath, {
    fallback: { ...EMPTY_STORE },
    ...STORE_SHAPE,
  })
}

function writeStore(store, { filePath } = {}) {
  writeJsonAtomic(voiceNotesLocation({ filePath }), store, STORE_SHAPE)
  return store
}

export function readVoiceNotes(options = {}) {
  return readStore(options).notes
}

/* --------------------------------------------------------------- capturing */

/**
 * Turn a transcript into a durable note.
 *
 * `text` is the transcript that already exists — this never records anything.
 * `pipelineId` links the note back to the run so the recording (while it still
 * exists) and the note can be deleted together.
 */
export function captureVoiceNote(
  {
    text,
    title = null,
    pipelineId = null,
    sessionId = null,
    run = null,
    tags = [],
    pinned = false,
    source = 'pendant',
    now = Date.now(),
    timeZone = null,
  } = {},
  { filePath = undefined } = {},
) {
  /*
   * The lead-in is stripped HERE rather than at each caller, because it was
   * not: the dashboard POST stored "Note to self: the porch gutter is loose"
   * verbatim while the same sentence arriving from a pipeline run stored "the
   * porch gutter is loose". Same words, two different notes, depending on which
   * door they came through. One strip, one place.
   */
  const body = cleanText(voiceNoteIntent(text).text, MAX_NOTE_CHARS)
  if (!body) throw new Error('A voice note needs something to say.')

  const sensitivity = classifySensitivity(body)
  const context = voiceNoteContext({ run, now, timeZone })
  const audioPolicy = audioRetentionPolicy({ now })

  const note = {
    id: `vn_${crypto.randomUUID()}`,
    text: body,
    /*
     * A secret's own words must not become the label that gets printed in
     * every digest and said out loud. quickCapture.js makes the same split for
     * the same reason; the full text stays readable through getVoiceNote(),
     * because withholding is about what leaves the house, not about the owner.
     */
    title:
      sensitivity === 'secret'
        ? 'a private note'
        : cleanText(title, MAX_TITLE_CHARS) || firstClause(body),
    sensitivity,
    pinned: pinned === true,
    tags: normalizeTags(tags),
    pipelineId: pipelineId ? cleanText(pipelineId, 240) : null,
    sessionId: sessionId ? cleanText(sessionId, 240) : null,
    source: cleanText(source, 80) || 'pendant',
    /* The Mac's clock. Trustworthy, and therefore the only thing sorted on. */
    recordedAt: context.recordedAt,
    localDay: context.localDay,
    context,
    /* Not a copy of the audio and not a promise to keep it — a deadline, so
     * "play me back what I said" can fail honestly instead of surprisingly. */
    recording: recordingStatusFor(pipelineId, context, audioPolicy),
    reminders: [],
    summary: null,
    updatedAt: context.recordedAt,
  }

  const store = readStore({ filePath })
  store.notes = [note, ...store.notes]
  writeStore(store, { filePath })
  return note
}

function recordingStatusFor(pipelineId, context, audioPolicy) {
  if (!pipelineId) {
    return {
      linked: false,
      expiresAt: null,
      retainedBy: 'audioRetention.js',
      detail: 'This note has no pipeline run, so there is no recording to point at.',
    }
  }
  const capturedMaxAgeMs = audioPolicy.maxAgeMs.captured
  return {
    linked: true,
    /* Measured from the capture, not from now: a note made from a run that is
     * already three hours old has three hours of audio left, not six. */
    expiresAt: new Date(
      Date.parse(context.recordedAt) + capturedMaxAgeMs,
    ).toISOString(),
    retainedBy: 'audioRetention.js',
    detail:
      'The recording is captured speech and expires on audioRetention.js\'s schedule. This module never copies it: a copy outside pipeline-audio/ would be invisible to deleteAudioForJob().',
  }
}

/**
 * Make a note out of a run the pendant already completed.
 *
 * This is the path that matters: the owner pressed the button, spoke, and the
 * transcript is sitting in pendant-pipeline.json. Nothing is re-recorded and
 * nothing is re-transcribed — the run is read and its `transcription` event's
 * text becomes the note.
 *
 * `runs` is injected so this is testable and so the caller can hand in the runs
 * it already has rather than re-reading the store.
 */
export function voiceNoteFromPipelineRun(
  pipelineId,
  { runs = null, requireIntent = true, now = Date.now(), tags = [], pinned = false, timeZone = null } = {},
  { filePath = undefined, readRuns = null } = {},
) {
  const id = String(pipelineId ?? '').trim()
  if (!id) throw new Error('A pipelineId is required to make a note from a run.')

  const allRuns = runs ?? (readRuns ? readRuns() : loadPipelineRuns())
  const run = (Array.isArray(allRuns) ? allRuns : []).find(
    (candidate) => candidate?.pipelineId === id,
  )
  if (!run) throw new Error(`No pipeline run ${id}.`)

  const transcription = (Array.isArray(run.events) ? run.events : []).find(
    (event) => event?.stage === 'transcription' && String(event?.text ?? '').trim(),
  )
  const spoken = String(transcription?.text ?? run.command ?? '').trim()
  if (!spoken) {
    /* A bookmark press carries no payload at all — pendant_store.h,
     * PENDANT_STORE_KIND_MARK: "moment bookmark (no payload)". Turning one into
     * an empty note would be a note about nothing; markVoiceNoteMoment() is the
     * honest handler for that press. */
    throw new Error(
      `Pipeline run ${id} has no transcript. A bookmark press carries no audio payload — use markVoiceNoteMoment().`,
    )
  }

  const intent = voiceNoteIntent(spoken)
  if (requireIntent && !intent.isNote) {
    throw new Error(
      `Pipeline run ${id} reads as a command, not a note: "${spoken.slice(0, 60)}". Pass requireIntent:false to keep it anyway.`,
    )
  }

  return captureVoiceNote(
    {
      /* Raw: captureVoiceNote owns the strip. `intent` above is consulted only
       * for the is-this-a-note decision. */
      text: spoken,
      pipelineId: id,
      sessionId: run.sessionId ?? null,
      run,
      tags,
      pinned,
      source: run.source ?? 'pendant',
      now,
      timeZone,
    },
    { filePath },
  )
}

/*
 * A bookmark press: "something just happened, come back to this".
 *
 * The firmware comment on button 2 explains why this exists as its own press
 * rather than a gesture on button 1: button 1 acts on the ACTIVE edge so the
 * microphone is powering up before the finger comes off, and any gesture means
 * waiting several hundred ms on every press to serve the rarer action. The
 * press costs "one small SD write and no radio", and carries no payload.
 *
 * So the note it makes has no transcript, and pretending otherwise would be
 * inventing words. What it does carry is real and is the whole value: the
 * moment, the device's own clock reading, and whether the link was down.
 */
export function markVoiceNoteMoment(
  { pipelineId = null, run = null, note = '', tags = [], now = Date.now(), timeZone = null } = {},
  { filePath = undefined } = {},
) {
  const context = voiceNoteContext({ run, now, timeZone })
  const said = cleanText(note, MAX_NOTE_CHARS)
  const when = context.device.at ?? context.device.local ?? context.localTime

  return captureVoiceNote(
    {
      text:
        said ||
        `Moment bookmarked${when ? ` at ${when}` : ''}${context.device.heldOnDevice ? ' (held on the pendant — the link was down)' : ''}.`,
      title: 'Bookmarked moment',
      pipelineId,
      run,
      tags: ['bookmark', ...tags],
      source: run?.source ?? 'nrf9160',
      now,
      timeZone,
    },
    { filePath },
  )
}

function loadPipelineRuns() {
  /* Read directly rather than importing pipelineTrace.js, which hard-codes the
   * real workspace path with no way to point it elsewhere — the same reason
   * audioRetention.js reads the store file instead of the module. */
  const storePath = path.join(workspacePath, 'pendant-pipeline.json')
  return readJsonWithRecovery(storePath, { fallback: [], validate: Array.isArray })
}

/* ---------------------------------------------------------------- retrieval */

/* Decorated the same way listVoiceNotes() decorates: a note fetched by id must
 * not claim its recording is still there when the deadline has passed just
 * because it was fetched down a different code path. */
export function getVoiceNote(noteId, options = {}, { now = Date.now() } = {}) {
  const id = String(noteId ?? '').trim()
  const note = readStore(options).notes.find((candidate) => candidate.id === id)
  return note ? decorate(note, now) : null
}

/**
 * Search. Token overlap, then recency — the same shape recallCaptures() uses,
 * so "find that thing I said" behaves the same whichever store it lands in.
 *
 * `since`/`until` accept anything Date.parse understands and filter on
 * `recordedAt`, the Mac clock, because it is the only one of the three that is
 * always both present and locatable.
 */
export function listVoiceNotes(
  {
    query = '',
    tag = null,
    since = null,
    until = null,
    pinnedOnly = false,
    limit = 20,
    now = Date.now(),
  } = {},
  options = {},
) {
  const wanted = tokenize(query)
  const from = since ? Date.parse(since) : null
  const to = until ? Date.parse(until) : null
  const wantedTag = tag ? String(tag).trim().toLowerCase() : null

  return readStore(options)
    .notes.filter((note) => {
      if (pinnedOnly && !note.pinned) return false
      if (wantedTag && !(note.tags ?? []).includes(wantedTag)) return false
      const at = Date.parse(note.recordedAt)
      if (Number.isFinite(from) && from !== null && at < from) return false
      if (Number.isFinite(to) && to !== null && at > to) return false
      if (!wanted.size) return true
      const haystack = normalizeText(`${note.text} ${note.title} ${(note.tags ?? []).join(' ')}`)
      return [...wanted].some((token) => haystack.includes(token))
    })
    .map((note) => ({
      note,
      overlap: wanted.size
        ? [...wanted].filter((token) =>
            normalizeText(`${note.text} ${note.title}`).includes(token),
          ).length
        : 0,
    }))
    .sort(
      (left, right) =>
        right.overlap - left.overlap ||
        Date.parse(right.note.recordedAt) - Date.parse(left.note.recordedAt),
    )
    .slice(0, Math.max(1, Number(limit) || 20))
    .map(({ note }) => decorate(note, now))
}

/* Recording deadlines are computed at read time as well as write time: a note
 * read eight hours after capture must say the audio is gone, not repeat the
 * deadline it was born with. */
function decorate(note, now) {
  const expiresAt = note.recording?.expiresAt
  const expired = expiresAt ? Date.parse(expiresAt) <= now : false
  return {
    ...note,
    recording: {
      ...note.recording,
      expired,
      /* `available` is deliberately not a claim that the file is there — the
       * sweeper runs hourly and the file may already be gone. It is a claim
       * that the deadline has not passed, which is the most this store can
       * know without stat()ing a path it does not own. */
      available: note.recording?.linked ? !expired : false,
    },
  }
}

/* -------------------------------------------------------------- pinning */

/**
 * "Keep this one." The explicit act that exempts a note from expiry.
 *
 * Deliberately a separate call from capture with no way to default it on: the
 * whole point of the retention note in the header is that nothing here becomes
 * permanent because a code path forgot to think about it.
 */
export function pinVoiceNote(noteId, { pinned = true, reason = '', now = Date.now() } = {}, options = {}) {
  return mutate(
    noteId,
    (note) => ({
      ...note,
      pinned: pinned === true,
      pinnedAt: pinned === true ? new Date(now).toISOString() : null,
      pinnedReason: pinned === true ? cleanText(reason, 240) || null : null,
      updatedAt: new Date(now).toISOString(),
    }),
    options,
  )
}

export function tagVoiceNote(noteId, tags, { now = Date.now() } = {}, options = {}) {
  return mutate(
    noteId,
    (note) => ({
      ...note,
      tags: normalizeTags([...(note.tags ?? []), ...(Array.isArray(tags) ? tags : [tags])]),
      updatedAt: new Date(now).toISOString(),
    }),
    options,
  )
}

function mutate(noteId, change, options = {}) {
  const id = String(noteId ?? '').trim()
  const store = readStore(options)
  const index = store.notes.findIndex((note) => note.id === id)
  if (index === -1) return null
  store.notes[index] = change(store.notes[index])
  writeStore(store, options)
  return store.notes[index]
}

/* ----------------------------------------------------------- summarising */

/*
 * A digest of what the owner said, built without a model.
 *
 * Deterministic on purpose. This is the thing the pendant says back, and the
 * three moments it is most wanted — offline, on a dead link, at 6am before the
 * API key has been checked — are exactly the moments an LLM call is least
 * likely to return. `summarise` is injectable for callers that do want a model;
 * the default has to work when nothing else does.
 *
 * Grouped by LOCAL day, not UTC day: a note made at 20:00 in Madison is
 * 01:00 UTC the following day, and a digest that files it under tomorrow is
 * wrong in the only way the owner will notice.
 */
export function summariseVoiceNotes(
  { query = '', since = null, until = null, tag = null, limit = 200, now = Date.now() } = {},
  options = {},
  { summarise = null } = {},
) {
  const notes = listVoiceNotes({ query, since, until, tag, limit, now }, options)

  if (!notes.length) {
    return {
      notes: [],
      count: 0,
      days: [],
      themes: [],
      text: 'No voice notes match that.',
      spoken: 'No voice notes match that.',
      generatedBy: 'none',
    }
  }

  if (typeof summarise === 'function') {
    const supplied = summarise(notes)
    if (supplied) return { ...supplied, count: notes.length, generatedBy: 'injected' }
  }

  const byDay = new Map()
  for (const note of notes) {
    const day = note.localDay ?? note.recordedAt.slice(0, 10)
    if (!byDay.has(day)) byDay.set(day, [])
    byDay.get(day).push(note)
  }

  const days = [...byDay.entries()]
    .sort((left, right) => (left[0] < right[0] ? 1 : -1))
    .map(([day, items]) => ({
      day,
      count: items.length,
      lines: items.map((note) => safeLine(note)),
    }))

  const themes = topTerms(notes)
  const pinned = notes.filter((note) => note.pinned).length
  const withheld = notes.filter((note) => note.sensitivity === 'secret').length

  const text = [
    `${notes.length} voice note${notes.length === 1 ? '' : 's'} across ${days.length} day${days.length === 1 ? '' : 's'}${pinned ? `, ${pinned} pinned` : ''}.`,
    themes.length ? `Recurring: ${themes.join(', ')}.` : null,
    withheld
      ? `${withheld} held back from this summary because ${withheld === 1 ? 'it reads' : 'they read'} as private.`
      : null,
    '',
    ...days.flatMap(({ day, lines }) => [`${day}:`, ...lines.map((line) => `  - ${line}`)]),
  ]
    .filter((line) => line !== null)
    .join('\n')

  return {
    notes,
    count: notes.length,
    days,
    themes,
    withheld,
    text,
    spoken: spokenDigest(notes, days, themes),
    generatedBy: 'deterministic',
  }
}

/*
 * One line per note, and never the note itself when it is a secret.
 *
 * A digest is the single most likely thing to be spoken aloud, mailed, or
 * pasted into a prompt. redaction.js's classifySensitivity already catches the
 * spoken-secret shape ("my bike lock code is 4829" — four digits and a noun),
 * and this is where that classification has to actually cost something.
 */
function safeLine(note) {
  if (note.sensitivity === 'secret') {
    return `${note.title} — stored privately, not repeated here`
  }
  const body = note.text.length > 120 ? `${note.text.slice(0, 117)}...` : note.text
  return note.sensitivity === 'sensitive' ? `${body} (contains personal detail)` : body
}

function spokenDigest(notes, days, themes) {
  const head = `${notes.length} note${notes.length === 1 ? '' : 's'}${days.length > 1 ? ` over ${days.length} days` : ''}.`
  const first = notes.find((note) => note.sensitivity !== 'secret')
  const tail = first ? ` Most recent: ${first.title}.` : ' All of them are private.'
  const themeLine = themes.length ? ` Recurring: ${themes.slice(0, 3).join(', ')}.` : ''
  return `${head}${tail}${themeLine}`.slice(0, MAX_SPOKEN_CHARACTERS)
}

const STOP_WORDS = new Set([
  'the', 'and', 'for', 'that', 'this', 'with', 'from', 'have', 'about', 'they',
  'them', 'you', 'your', 'not', 'was', 'are', 'but', 'get', 'got', 'need',
  'want', 'will', 'can', 'has', 'had', 'out', 'note', 'notes',
])

function topTerms(notes, count = 5) {
  const tally = new Map()
  for (const note of notes) {
    /* A secret's words are not theme material; counting them would put the
     * secret back into the summary one token at a time. */
    if (note.sensitivity === 'secret') continue
    for (const token of new Set(normalizeText(note.text).split(' '))) {
      if (token.length < 4 || STOP_WORDS.has(token)) continue
      tally.set(token, (tally.get(token) ?? 0) + 1)
    }
  }
  return [...tally.entries()]
    .filter(([, seen]) => seen > 1)
    .sort((left, right) => right[1] - left[1] || left[0].localeCompare(right[0]))
    .slice(0, count)
    .map(([token]) => token)
}

/* ------------------------------------------------------------- reminding */

/**
 * Raise a reminder from a note.
 *
 * remindMe.js already knows the two shapes and where each belongs — one-off to
 * Apple Reminders, recurring to a calendar event with an alarm — and its own
 * header records that neither writer has been exercised against live Reminders
 * or Calendar in this session. That is inherited, not fixed here: `schedule` is
 * injected so this is testable without firing a macOS Automation prompt at the
 * owner, and the note records what was raised either way.
 *
 * The note's own text is the default subject, so "remind me about that thing I
 * said on Tuesday" needs no retyping.
 */
export async function remindFromVoiceNote(
  noteId,
  { text = null, notes = '', listName = null, now = new Date() } = {},
  options = {},
  { schedule = scheduleReminder } = {},
) {
  const note = getVoiceNote(noteId, options)
  if (!note) throw new Error(`No voice note ${noteId}.`)

  const ask = String(text ?? note.text).trim()
  if (!ask) throw new Error('Nothing to be reminded about.')

  const created = await schedule({
    text: ask,
    /*
     * The note body goes in the reminder's NOTES field, not its title — but
     * never for a secret. A Reminders item syncs to a phone, a watch and a lock
     * screen; that is the widest audience anything in this store gets, and the
     * one place a spoken lock code must not be copied to.
     */
    notes:
      note.sensitivity === 'secret'
        ? `From a private pendant voice note (${note.id}). The note itself was not copied.`
        : [notes, `From pendant voice note ${note.id}: ${note.text}`].filter(Boolean).join('\n\n'),
    listName,
    now,
  })

  const raised = {
    kind: created.kind,
    title: created.title,
    due: created.due ?? null,
    reminderId: created.reminderId ?? null,
    eventUid: created.eventUid ?? null,
    at: new Date(now).toISOString(),
  }

  mutate(
    noteId,
    (stored) => ({
      ...stored,
      reminders: [...(stored.reminders ?? []), raised],
      updatedAt: new Date(now).toISOString(),
    }),
    options,
  )

  return { ...created, noteId, reminder: raised }
}

/* ------------------------------------------------------------- retention */

export function voiceNoteRetentionPolicy({ maxAgeMs, maxBytes, now = Date.now() } = {}) {
  const ageMs = positiveNumber(
    maxAgeMs ?? positiveNumber(process.env.PENDANT_VOICE_NOTE_MAX_AGE_DAYS, 0) * DAY_MS,
    VOICE_NOTE_DEFAULT_MAX_AGE_MS,
  )
  return {
    maxAgeMs: ageMs,
    maxBytes: positiveNumber(
      maxBytes ?? positiveNumber(process.env.PENDANT_VOICE_NOTE_MAX_BYTES, 0),
      VOICE_NOTE_DEFAULT_MAX_BYTES,
    ),
    expiresBefore: new Date(now - ageMs).toISOString(),
    unit: 'bytes',
    pinnedAreExempt: true,
  }
}

/* A zero or a typo in the environment must never widen deletion — the same
 * rule, and the same reason, as audioRetention.js's helper of this name. */
function positiveNumber(value, fallback) {
  const parsed = Number(value)
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback
}

export function planVoiceNoteSweep({ now = Date.now(), maxAgeMs, maxBytes } = {}, options = {}) {
  const policy = voiceNoteRetentionPolicy({ now, maxAgeMs, maxBytes })
  const notes = readStore(options).notes

  const pinned = notes.filter((note) => note.pinned)
  const unpinned = notes
    .filter((note) => !note.pinned)
    .sort((left, right) => Date.parse(left.recordedAt) - Date.parse(right.recordedAt))

  const remove = []
  const survivors = []
  for (const note of unpinned) {
    if (now - Date.parse(note.recordedAt) > policy.maxAgeMs) {
      remove.push({ id: note.id, title: note.title, reason: 'expired', bytes: bytesOf(note) })
    } else {
      survivors.push(note)
    }
  }

  /* Pinned notes count against the budget but are never evicted by it. An
   * owner who pins 4 MiB of notes has filled the store on purpose, and
   * deleting what they explicitly asked to keep to make room for what they
   * did not is the wrong way round. */
  let bytes = [...pinned, ...survivors].reduce((total, note) => total + bytesOf(note), 0)
  const overBudgetBy = Math.max(0, bytes - policy.maxBytes)
  while (bytes > policy.maxBytes && survivors.length) {
    const evicted = survivors.shift()
    remove.push({
      id: evicted.id,
      title: evicted.title,
      reason: 'over-budget',
      bytes: bytesOf(evicted),
    })
    bytes -= bytesOf(evicted)
  }

  return {
    policy,
    scanned: { notes: notes.length, bytes: notes.reduce((total, note) => total + bytesOf(note), 0) },
    pinned: { notes: pinned.length, bytes: pinned.reduce((total, note) => total + bytesOf(note), 0) },
    remove,
    keep: { notes: pinned.length + survivors.length, bytes },
    overBudgetBy,
    /* Named because it is the failure mode: a store where everything is pinned
     * has no retention at all, and the owner should be told before it is the
     * reason a sweep freed nothing. */
    pinnedShare: notes.length ? Number((pinned.length / notes.length).toFixed(2)) : 0,
  }
}

function bytesOf(note) {
  return Buffer.byteLength(JSON.stringify(note), 'utf8')
}

/**
 * Enforce the policy. Dry run unless `apply: true`, for the same reason
 * audioRetention.js insists on it: a GET-shaped mistake against a route that
 * erases what the owner said is not a mistake anyone gets to make twice.
 */
export function sweepVoiceNotes({ apply = false, now = Date.now(), maxAgeMs, maxBytes } = {}, options = {}) {
  const plan = planVoiceNoteSweep({ now, maxAgeMs, maxBytes }, options)
  if (apply !== true) {
    return { ...plan, dryRun: true, applied: false, removed: [] }
  }

  const doomed = new Set(plan.remove.map((entry) => entry.id))
  const store = readStore(options)
  store.notes = store.notes.filter((note) => !doomed.has(note.id))
  writeStore(store, options)

  return { ...plan, dryRun: false, applied: true, removed: plan.remove }
}

/**
 * Forget a note, and the recording it came from, in one call.
 *
 * This is the half audioRetention.js cannot do. Its DELETE
 * /audio-retention/jobs/:jobId removes the .wav and prunes the briefing store,
 * and it is right that it stops there — it does not know this store exists. But
 * a delete that removes the recording and leaves the transcript is the exact
 * failure that module names about the briefing entries: "Deleting the recording
 * and keeping the words is not deletion."
 *
 * So this deletes the words first, then calls deleteAudioForJob() for the
 * audio, and reports that function's own `complete` and `unreachable` verbatim
 * rather than restating them — including its refusal to claim a microSD copy
 * was erased.
 */
export function forgetVoiceNote(
  noteId,
  { deleteRecording = true, now = Date.now() } = {},
  options = {},
  { deleteAudio = deleteAudioForJob } = {},
) {
  const id = String(noteId ?? '').trim()
  const store = readStore(options)
  const note = store.notes.find((candidate) => candidate.id === id)
  if (!note) {
    return { ok: false, noteId: id, removed: false, error: 'No such voice note.' }
  }

  store.notes = store.notes.filter((candidate) => candidate.id !== id)
  writeStore(store, options)

  let audio = null
  if (deleteRecording && note.pipelineId) {
    try {
      audio = deleteAudio(note.pipelineId, options.audio ?? {})
    } catch (error) {
      audio = { error: String(error?.message ?? error), complete: false }
    }
  }

  return {
    ok: true,
    noteId: id,
    removed: true,
    pipelineId: note.pipelineId,
    audio,
    /* Only true when the words are gone AND either there was no recording to
     * chase or audioRetention says it got all of it. */
    complete: !note.pipelineId || !deleteRecording ? true : audio?.complete === true,
    forgottenAt: new Date(now).toISOString(),
  }
}

/* ------------------------------------------------------------------ helpers */

/* NUL is stripped the way pipelineTrace.js strips it: a transcript crosses a C
 * firmware and a subprocess boundary, and an embedded NUL truncates the value in
 * some readers and not others. Written as an escape, never as a raw byte. */
function cleanText(value, maxLength) {
  return String(value ?? '')
    .split('\u0000')
    .join('')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, maxLength)
}

function firstClause(text) {
  const clause = String(text).split(/[.;\n]/)[0].trim() || String(text).trim()
  return clause.length <= MAX_TITLE_CHARS
    ? clause
    : `${clause.slice(0, MAX_TITLE_CHARS - 3)}...`
}

function normalizeTags(tags) {
  return [
    ...new Set(
      (Array.isArray(tags) ? tags : [])
        .map((tag) => String(tag ?? '').trim().toLowerCase().slice(0, MAX_TAG_CHARS))
        .filter(Boolean),
    ),
  ].slice(0, MAX_TAGS)
}

function tokenize(text) {
  return new Set(normalizeText(text).split(' ').filter((token) => token.length > 2))
}

function normalizeText(value) {
  return String(value ?? '')
    .toLowerCase()
    .replace(/[^\p{L}\p{N}\s]/gu, ' ')
    .replace(/\s+/g, ' ')
    .trim()
}

/* ---------------------------------------------------------------- HTTP */

/*
 * Mounted with `registerVoiceNotesRoutes(app)` from server.js.
 *
 * It lives here rather than inline in server.js because that file is 71 000
 * characters several people are editing at once; a feature that owns its routes
 * is one line there, and audioRetention.js and pageWatchRoutes.js already set
 * the precedent.
 *
 * Reads are GET. Creating a note is a POST. The two routes that destroy
 * something are a DELETE for one note and a POST for the sweep, and the sweep
 * is a dry run unless the body says `apply: true`.
 */
export function registerVoiceNotesRoutes(app, options = {}) {
  if (!app || typeof app.get !== 'function' || typeof app.post !== 'function') {
    throw new Error('registerVoiceNotesRoutes requires an Express-style app.')
  }

  const base = options.basePath ?? '/voice-notes'
  const at = options.filePath ? { filePath: options.filePath } : {}
  const fail = (response, error, code = 400) =>
    response.status(code).json({ ok: false, error: String(error?.message ?? error) })

  app.get(base, (request, response) => {
    try {
      response.json({
        ok: true,
        notes: listVoiceNotes(
          {
            query: request.query?.q ?? '',
            tag: request.query?.tag ?? null,
            since: request.query?.since ?? null,
            until: request.query?.until ?? null,
            pinnedOnly: String(request.query?.pinned ?? '') === 'true',
            limit: Number(request.query?.limit) || 20,
          },
          at,
        ),
        storePath: voiceNotesLocation(at),
      })
    } catch (error) {
      fail(response, error)
    }
  })

  /* Fixed segments before /:noteId, or Express reads "summary" as a note id and
   * every one of them 404s — the mistake pageWatchRoutes.js documents. */
  app.get(`${base}/summary`, (request, response) => {
    try {
      response.json({
        ok: true,
        ...summariseVoiceNotes(
          {
            query: request.query?.q ?? '',
            tag: request.query?.tag ?? null,
            since: request.query?.since ?? null,
            until: request.query?.until ?? null,
          },
          at,
        ),
      })
    } catch (error) {
      fail(response, error)
    }
  })

  /* What context a note made right now would actually carry — the endpoint to
   * hit before asking why a note has no place on it. */
  app.get(`${base}/context`, (_request, response) => {
    response.json({ ok: true, ...voiceNoteContext({}) })
  })

  app.get(`${base}/retention`, (_request, response) => {
    response.json({
      ok: true,
      readOnly: true,
      ...planVoiceNoteSweep({}, at),
      note: 'Nothing was removed. POST /voice-notes/sweep with {"apply":true} to enforce this.',
    })
  })

  app.post(`${base}/sweep`, (request, response) => {
    try {
      response.json({
        ok: true,
        ...sweepVoiceNotes({ apply: request.body?.apply === true }, at),
      })
    } catch (error) {
      fail(response, error)
    }
  })

  app.post(base, (request, response) => {
    try {
      const body = request.body ?? {}
      /* Three doors, because three things arrive: a finished run to lift a
       * transcript out of, a bookmark press with no payload, and plain text
       * from the dashboard. */
      if (body.pipelineId && !body.text) {
        response.status(201).json({
          ok: true,
          note: voiceNoteFromPipelineRun(
            body.pipelineId,
            {
              requireIntent: body.requireIntent !== false,
              tags: body.tags ?? [],
              pinned: body.pinned === true,
            },
            at,
          ),
        })
        return
      }
      if (body.bookmark === true) {
        response.status(201).json({
          ok: true,
          note: markVoiceNoteMoment(
            { pipelineId: body.pipelineId ?? null, note: body.text ?? '', tags: body.tags ?? [] },
            at,
          ),
        })
        return
      }
      response.status(201).json({
        ok: true,
        note: captureVoiceNote(
          {
            text: body.text,
            title: body.title ?? null,
            pipelineId: body.pipelineId ?? null,
            sessionId: body.sessionId ?? null,
            tags: body.tags ?? [],
            pinned: body.pinned === true,
            source: body.source ?? 'dashboard',
          },
          at,
        ),
      })
    } catch (error) {
      fail(response, error)
    }
  })

  app.get(`${base}/:noteId`, (request, response) => {
    const note = getVoiceNote(request.params.noteId, at)
    if (!note) {
      fail(response, new Error('No such voice note.'), 404)
      return
    }
    response.json({ ok: true, note })
  })

  app.post(`${base}/:noteId/pin`, (request, response) => {
    const note = pinVoiceNote(
      request.params.noteId,
      { pinned: request.body?.pinned !== false, reason: request.body?.reason ?? '' },
      at,
    )
    if (!note) {
      fail(response, new Error('No such voice note.'), 404)
      return
    }
    response.json({ ok: true, note })
  })

  /* The only route here that touches the outside world: it reads the calendar
   * through EventKit and may raise a macOS Automation prompt. It is a POST and
   * it is never called by the capture path, so a note is never blocked on it. */
  app.post(`${base}/:noteId/place`, async (request, response) => {
    try {
      const note = await attachVoiceNotePlace(
        request.params.noteId,
        { windowMinutes: Number(request.body?.windowMinutes) || 0 },
        at,
      )
      if (!note) {
        fail(response, new Error('No such voice note.'), 404)
        return
      }
      response.json({ ok: true, note, place: note.context.place })
    } catch (error) {
      fail(response, error)
    }
  })

  app.post(`${base}/:noteId/remind`, async (request, response) => {
    try {
      response.json({
        ok: true,
        ...(await remindFromVoiceNote(
          request.params.noteId,
          { text: request.body?.text ?? null, listName: request.body?.listName ?? null },
          at,
        )),
      })
    } catch (error) {
      fail(response, error)
    }
  })

  app.delete(`${base}/:noteId`, (request, response) => {
    const report = forgetVoiceNote(
      request.params.noteId,
      { deleteRecording: request.body?.deleteRecording !== false },
      at,
    )
    if (!report.ok) {
      fail(response, new Error(report.error), 404)
      return
    }
    response.json(report)
  })

  return {
    mounted: [
      `GET/POST ${base}`,
      `GET ${base}/summary`,
      `GET ${base}/context`,
      `GET ${base}/retention`,
      `POST ${base}/sweep`,
      `GET/DELETE ${base}/:noteId`,
      `POST ${base}/:noteId/pin`,
      `POST ${base}/:noteId/place`,
      `POST ${base}/:noteId/remind`,
    ],
  }
}

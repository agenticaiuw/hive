/**
 * OpenAI Realtime voice front-door for the pendant.
 * Model: gpt-realtime-2.1 (or OPENAI_REALTIME_MODEL).
 *
 * Mid-press streaming: open a session as soon as the HTTP body starts, append
 * PCM while the pendant is still uploading, commit only when the body ends.
 * That is the latency win vs buffering the full clip then planning.
 *
 * Product: Realtime is the ONLY planner for voice. Plan from AUDIO via tools
 * (actions + spoken_reply). Transcript is optional history/debug only —
 * never required, never the critical hot path. Mac only executes.
 * Tools: get_mac_status, mac_run_actions, browser_run_actions, web_search,
 * mac_delegate.
 * Docs: https://developers.openai.com/api/docs/guides/realtime-websocket
 */

import { OPENAI_API_BASE_URL } from './config.js'
import {
  composeRealtimeInstructions,
  normalizeFleetSnapshot,
} from './fleetContext.js'

export const REALTIME_PCM_RATE = 24000
/* G.711 μ-law (audio/pcmu) is fixed at 8 kHz, 8 bits — 64 kbps. The pendant
 * uses it both ways because real-world LTE-M sustains ~100 kbps, far below
 * raw PCM's 250-384 kbps. Realtime en/decodes μ-law natively; the relay
 * never touches the samples. */
export const G711_SAMPLE_RATE = 8000
const DEFAULT_REALTIME_MODEL = 'gpt-realtime-2.1'
const SESSION_TIMEOUT_MS = 60_000
/* Full-duplex conversations end on button stop or relay inactivity logic;
 * five minutes is the absolute runaway ceiling, not a UX parameter. */
const CONVERSATION_MAX_MS = 300_000

function openaiApiKey() {
  return String(
    process.env.OPENAI_API_KEY || process.env.OPENAI_KEY || '',
  ).trim()
}

function realtimeModel() {
  return (
    String(process.env.OPENAI_REALTIME_MODEL || '').trim() ||
    DEFAULT_REALTIME_MODEL
  )
}

function realtimeWsUrl() {
  const httpBase = String(
    process.env.OPENAI_API_BASE_URL || OPENAI_API_BASE_URL || '',
  )
    .replace(/\/$/, '')
    .trim() || 'https://api.openai.com/v1'
  const wsBase = httpBase.replace(/^http/i, 'ws')
  return `${wsBase}/realtime?model=${encodeURIComponent(realtimeModel())}`
}

/**
 * Action item schema — contracts live here (not in the system prompt).
 * Stable across sessions for prompt-cache friendliness.
 */
const ACTION_ITEM_SCHEMA = {
  type: 'object',
  properties: {
    type: {
      type: 'string',
      description:
        'Executor action type. Examples: run_shell, run_applescript, create_reminder, open_app, open_url, open_path, type_text, get_volume, set_volume, browser_snapshot, browser_list_tabs, browser_navigate, browser_click, browser_type, browser_wait_for, browser_read_page, browser_select.',
    },
    label: {
      type: 'string',
      description: 'Short human-readable label for logs / UI.',
    },
    params: {
      type: 'object',
      description:
        'Parameters for the action type. Use only fields that type needs (e.g. command for run_shell, title/due for create_reminder, url for open_url or browser_navigate, selector/text for browser_click/type, appName for open_app matching the Mac software inventory exactly).',
      properties: {
        appName: { type: 'string' },
        url: { type: 'string' },
        path: { type: 'string' },
        title: { type: 'string' },
        due: { type: 'string' },
        selector: { type: 'string' },
        text: { type: 'string' },
        query: { type: 'string' },
        command: { type: 'string' },
        script: { type: 'string' },
        cwd: { type: 'string' },
      },
    },
  },
  required: ['type', 'params'],
}

/**
 * Tool definitions = agent-computer interface (tight ~5 tools).
 * System prompt stays high-level; schemas carry Use when / Do NOT use when.
 * PROACTIVE tools fire immediately for status and reversible control.
 */
export const REALTIME_TOOLS = [
  {
    type: 'function',
    name: 'get_mac_status',
    description:
      'PROACTIVE. Read live Mac device state: battery, wifi, volume, focused app, or all. Use when the owner asks about battery/charge, wifi/network, volume/mute, or what app is frontmost. Call immediately — no confirmation. Do NOT use when: controlling the Mac (open app, set volume, type, reminders — use mac_run_actions), browser work (browser_run_actions), public web facts (web_search), or multi-step ambiguous tasks (mac_delegate). Never invent readings; always call this tool instead of guessing numbers.',
    parameters: {
      type: 'object',
      properties: {
        fields: {
          type: 'array',
          description:
            'Optional status fields to fetch. Omit or use ["all"] for a full snapshot.',
          items: {
            type: 'string',
            enum: ['battery', 'wifi', 'volume', 'focused_app', 'all'],
          },
        },
        spoken_reply: {
          type: 'string',
          description:
            'Short pendant confirmation (e.g. "Checking battery."). One sentence.',
        },
        transcript: {
          type: 'string',
          description:
            'Optional history label only. Omit if unsure — never block on this.',
        },
      },
      required: [],
    },
  },
  {
    type: 'function',
    name: 'mac_run_actions',
    description:
      'PROACTIVE for reversible control. Execute 1–3 concrete Mac actions when the Mac surface is online: open_app, open_url, open_path, create_reminder, type_text, get_volume, set_volume, run_shell (allowlisted system intents), run_applescript, and similar. Prefer high-level types over raw shell when a typed action exists. Use when: owner wants to change or run something on the Mac that is not a pure status read. Do NOT use when: only reading battery/wifi/volume/focused app (get_mac_status), browser page work (browser_run_actions), public facts (web_search), or long multi-step ambiguous workflows (mac_delegate). Confirmation first only for destructive actions. Never claim success without this tool (or get_mac_status) actually queuing work.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description:
            '1–3 concrete actions for the Mac executor (primary product of this tool).',
          items: ACTION_ITEM_SCHEMA,
        },
        spoken_reply: {
          type: 'string',
          description:
            'Short confirmation for the pendant speaker (preferred user-facing reply).',
        },
        transcript: {
          type: 'string',
          description:
            'Optional short transcript for history/debug only. Omit if unsure — never block on this; plan from audio via actions.',
        },
      },
      required: ['actions'],
    },
  },
  {
    type: 'function',
    name: 'browser_run_actions',
    description:
      'PROACTIVE when browser work is needed. Execute 1–3 actions through the browser extension when online: browser_list_tabs, browser_snapshot, browser_navigate, browser_click/type by ref, browser_wait_for, browser_read_page, browser_select, scroll. Use when: web/logged-in site work, reading or interacting with a page. Do NOT use when: Mac desktop/system control (mac_run_actions / get_mac_status), public web facts without a page (web_search), or multi-step Mac workflows (mac_delegate). Prefer over Mac desktop control for in-browser tasks.',
    parameters: {
      type: 'object',
      properties: {
        actions: {
          type: 'array',
          description:
            '1–3 browser-extension actions (primary product of this tool).',
          items: ACTION_ITEM_SCHEMA,
        },
        spoken_reply: {
          type: 'string',
          description:
            'Short confirmation for the pendant speaker (preferred user-facing reply).',
        },
        transcript: {
          type: 'string',
          description:
            'Optional short transcript for history/debug only. Omit if unsure — never block on this.',
        },
      },
      required: ['actions'],
    },
  },
  {
    type: 'function',
    name: 'web_search',
    description:
      'PROACTIVE for live public facts. Look up current information on the public web (news, weather, sports, prices, anything that needs live data). Use when: answer needs up-to-date public information. Do NOT use when: Mac device state (get_mac_status), controlling Mac/browser (mac_run_actions / browser_run_actions), or pure knowledge you already know without live data.',
    parameters: {
      type: 'object',
      properties: {
        query: {
          type: 'string',
          description: 'Search query derived from the user speech.',
        },
      },
      required: ['query'],
    },
  },
  {
    type: 'function',
    name: 'mac_delegate',
    description:
      'ONLY for multi-step or ambiguous computer tasks that cannot fit a short action list. Hands the goal to the local Mac agent (sets requireLocalPlanner). Use when: complex multi-app workflows, unclear steps, long-running computer use. Do NOT use when: a single get_mac_status or 1–3 mac_run_actions / browser_run_actions would suffice. Prefer concrete tools first.',
    parameters: {
      type: 'object',
      properties: {
        goal: {
          type: 'string',
          description: 'Clear goal for the Mac agent to accomplish.',
        },
        spoken_reply: {
          type: 'string',
          description:
            'Optional short confirmation for the pendant speaker while the Mac works.',
        },
        transcript: {
          type: 'string',
          description:
            'Optional short transcript for history/debug only. Omit if unsure.',
        },
      },
      required: ['goal'],
    },
  },
]

/** Status field → Mac executor action(s). get_mac_status expands into these. */
const MAC_STATUS_FIELD_ACTIONS = {
  battery: {
    type: 'run_shell',
    label: 'Battery',
    params: { command: 'pmset -g batt' },
  },
  wifi: {
    type: 'run_shell',
    label: 'Wi‑Fi',
    params: {
      command:
        'scutil --nwi; echo "---"; networksetup -getairportnetwork en0 2>/dev/null || true',
    },
  },
  volume: {
    type: 'get_volume',
    label: 'Volume',
    params: {},
  },
  focused_app: {
    type: 'run_shell',
    label: 'Focused app',
    params: {
      command:
        'osascript -e \'tell application "System Events" to get name of first application process whose frontmost is true\'',
    },
  },
}

/**
 * Expand get_mac_status fields into mac_run_actions-compatible executor actions.
 * @param {string[]|undefined|null} fields
 * @returns {{ type: string, label?: string, params: object }[]}
 */
export function mapGetMacStatusToActions(fields) {
  const raw = Array.isArray(fields) ? fields : []
  const normalized = raw
    .map((f) => String(f || '').trim().toLowerCase())
    .filter(Boolean)
  const wantAll =
    normalized.length === 0 ||
    normalized.includes('all') ||
    normalized.includes('*')

  const keys = wantAll
    ? ['battery', 'wifi', 'volume', 'focused_app']
    : [...new Set(normalized.filter((k) => MAC_STATUS_FIELD_ACTIONS[k]))]

  if (!keys.length) {
    return [
      MAC_STATUS_FIELD_ACTIONS.battery,
      MAC_STATUS_FIELD_ACTIONS.wifi,
      MAC_STATUS_FIELD_ACTIONS.volume,
      MAC_STATUS_FIELD_ACTIONS.focused_app,
    ]
  }
  return keys.map((k) => ({ ...MAC_STATUS_FIELD_ACTIONS[k] }))
}

/** Heuristic: pure text that looks like a device-state answer without tools. */
const DEVICE_STATE_ANSWER_RE =
  /\b(battery|percent|%|wifi|wi-?fi|volume|muted?|frontmost|focused app|charging|plugged in)\b/i

export function looksLikeDeviceStateAnswer(text) {
  return DEVICE_STATE_ANSWER_RE.test(String(text || ''))
}

/**
 * Extract s16le PCM from a WAV buffer (or return raw if already PCM).
 */
export function extractPcmFromWavOrPcm(audioBuffer, format) {
  const buf = Buffer.isBuffer(audioBuffer)
    ? audioBuffer
    : Buffer.from(audioBuffer || [])
  const fmt = String(format || '').toLowerCase()
  if (
    fmt === 'pcm' ||
    fmt === 's16le' ||
    fmt === 'pcm-s16le' ||
    fmt === 'raw' ||
    fmt === 'l16'
  ) {
    return { pcm: buf, sampleRate: null }
  }
  if (buf.length >= 44 && buf.toString('ascii', 0, 4) === 'RIFF') {
    const sampleRate = buf.readUInt32LE(24)
    let dataOffset = 44
    if (buf.toString('ascii', 36, 40) !== 'data') {
      let offset = 12
      while (offset + 8 <= buf.length) {
        const id = buf.toString('ascii', offset, offset + 4)
        const size = buf.readUInt32LE(offset + 4)
        if (id === 'data') {
          dataOffset = offset + 8
          break
        }
        offset += 8 + size
      }
    }
    return { pcm: buf.subarray(dataOffset), sampleRate }
  }
  return { pcm: buf, sampleRate: null }
}

/** Linear resample Int16 mono PCM between sample rates (batch). */
export function resamplePcmS16le(pcmBuffer, fromRate, toRate) {
  const from = Number(fromRate) || toRate
  const to = Number(toRate) || from
  if (!pcmBuffer?.length || from === to) {
    return Buffer.isBuffer(pcmBuffer) ? pcmBuffer : Buffer.from(pcmBuffer || [])
  }
  const input = new Int16Array(
    pcmBuffer.buffer,
    pcmBuffer.byteOffset,
    Math.floor(pcmBuffer.length / 2),
  )
  const outLen = Math.max(1, Math.floor((input.length * to) / from))
  const output = new Int16Array(outLen)
  for (let i = 0; i < outLen; i++) {
    const src = (i * from) / to
    const j = Math.floor(src)
    const frac = src - j
    const a = input[j] || 0
    const b = input[Math.min(j + 1, input.length - 1)] || 0
    output[i] = (a + (b - a) * frac) | 0
  }
  return Buffer.from(output.buffer, output.byteOffset, output.byteLength)
}

/*
 * Uplink auto-level — the pendant's mic is quieter than the Realtime VAD.
 *
 * OpenAI's server-side turn detection has an ABSOLUTE level gate, not an SNR
 * one. The 2026-08-07T05:19 capture is a clean 33 s recording of "what is my
 * battery level right now?" that whisper-1 transcribes verbatim, but whose
 * speech only peaks at 928/32767 (-31 dBFS). Replayed through
 * createStreamingRealtimeSession it produces literally two events —
 * session.created, session.updated — and nothing else: no speech_started, no
 * commit, no response. The pendant played silence and the run was filed as a
 * success. The identical samples scaled 8x transcribe and answer normally, so
 * the relay levels what it hands the model.
 *
 * Deliberately NOT applied to the stored diagnostic capture: that stays the
 * untouched mic audio, which is the only way to see a mic regression at all.
 */
export const UPLINK_TARGET_PEAK = 8000 // ~0.24 FS, ~8.6x on the failing clip
export const UPLINK_MAX_GAIN = 12

/*
 * Gain slew, and why it is this slow.
 *
 * A conventional fast AGC makes things WORSE here, and the working capture
 * proves it: with a 1 s rise the 2.7 s of room tone before "what is the
 * weather in Taipei" was lifted from ~100 RMS to ~1000 — speech level — and
 * then collapsed to unity the instant the talker started. Replayed against
 * the live API that session went from a clean answer to zero events. Turn
 * detection needs the CONTRAST between silence and speech, and a fast AGC is
 * precisely a contrast eraser.
 *
 * So the gain winds up over ~15 s. A normal talker speaks long before that and
 * pins the gain at unity for the rest of the session; only a mic that stays
 * quiet for many seconds ever earns a boost. Ducking stays fast (5 ms) so a
 * sudden loud syllable is never driven into the rails.
 */
const UPLINK_RISE_SECONDS = 15
const UPLINK_FALL_SECONDS = 0.005
/* Peak-envelope half-life: how long one loud syllable holds the gain down.
 * Longer than any pause inside real speech, so sentence gaps do not pump. */
const UPLINK_RELEASE_HALF_LIFE_SECONDS = 30

/**
 * Peak-following gain stage for s16le mono PCM.
 *
 * The gain tracks a decaying peak envelope, so a normal-level talker rides at
 * unity and only a persistently quiet mic gets boosted.
 */
export function createUplinkLeveler({
  sampleRate = REALTIME_PCM_RATE,
  targetPeak = UPLINK_TARGET_PEAK,
  maxGain = UPLINK_MAX_GAIN,
} = {}) {
  const rate = Number(sampleRate) > 0 ? Number(sampleRate) : REALTIME_PCM_RATE
  const ceiling = Math.max(1, Number(maxGain) || 1)
  const target = Math.max(1, Number(targetPeak) || 1)
  const release = Math.pow(
    0.5,
    1 / (rate * UPLINK_RELEASE_HALF_LIFE_SECONDS),
  )
  const riseStep = Math.pow(ceiling, 1 / (rate * UPLINK_RISE_SECONDS))
  const fallStep = Math.pow(ceiling, 1 / (rate * UPLINK_FALL_SECONDS))
  // No prior on the mic: the first loud sample sets the envelope, and until
  // one arrives the rise slew is the only thing bounding the gain.
  let peak = 0
  let gain = 1

  return {
    push(pcm) {
      if (!pcm?.length) return Buffer.alloc(0)
      const usable = pcm.length - (pcm.length % 2)
      const out = Buffer.alloc(usable)

      for (let i = 0; i < usable; i += 2) {
        const sample = pcm.readInt16LE(i)
        const magnitude = sample < 0 ? -sample : sample
        peak = magnitude > peak ? magnitude : peak * release
        const desired = Math.min(ceiling, Math.max(1, target / Math.max(peak, 1)))

        if (desired > gain) gain = Math.min(desired, gain * riseStep)
        else if (desired < gain) gain = Math.max(desired, gain / fallStep)

        const scaled = Math.round(sample * gain)
        out.writeInt16LE(
          scaled > 32767 ? 32767 : scaled < -32768 ? -32768 : scaled,
          i,
        )
      }
      return out
    },
    /** Current gain — telemetry only, so a quiet mic is visible in logs. */
    get gain() {
      return gain
    },
  }
}


/**
 * Online s16le mono resampler for mid-press streaming.
 * Accepts arbitrary byte chunks (handles odd leftover bytes).
 */
export class StreamingPcmResampler {
  constructor(fromRate, toRate = REALTIME_PCM_RATE) {
    this.fromRate = Number(fromRate) > 0 ? Number(fromRate) : toRate
    this.toRate = Number(toRate) > 0 ? Number(toRate) : REALTIME_PCM_RATE
    this.byteCarry = Buffer.alloc(0)
    this.samples = []
    this.readPos = 0 // fractional index into samples[]
  }

  push(chunk) {
    if (!chunk?.length) return Buffer.alloc(0)
    let buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    if (this.byteCarry.length) {
      buf = Buffer.concat([this.byteCarry, buf])
      this.byteCarry = Buffer.alloc(0)
    }
    if (buf.length % 2 === 1) {
      this.byteCarry = buf.subarray(buf.length - 1)
      buf = buf.subarray(0, buf.length - 1)
    }
    if (!buf.length) return Buffer.alloc(0)

    for (let i = 0; i < buf.length; i += 2) {
      this.samples.push(buf.readInt16LE(i))
    }

    if (this.fromRate === this.toRate) {
      const out = Buffer.alloc(this.samples.length * 2)
      for (let i = 0; i < this.samples.length; i++) {
        out.writeInt16LE(this.samples[i], i * 2)
      }
      this.samples = []
      this.readPos = 0
      return out
    }

    const outSamples = []
    const step = this.fromRate / this.toRate
    while (this.readPos + 1 < this.samples.length) {
      const j = Math.floor(this.readPos)
      const frac = this.readPos - j
      const a = this.samples[j]
      const b = this.samples[j + 1]
      outSamples.push((a + (b - a) * frac) | 0)
      this.readPos += step
    }
    // Drop fully consumed input samples; keep one for interpolation.
    const drop = Math.max(0, Math.floor(this.readPos) - 1)
    if (drop > 0) {
      this.samples = this.samples.slice(drop)
      this.readPos -= drop
    }

    const out = Buffer.alloc(outSamples.length * 2)
    for (let i = 0; i < outSamples.length; i++) {
      out.writeInt16LE(outSamples[i], i * 2)
    }
    return out
  }

  flush() {
    if (this.fromRate === this.toRate) {
      if (!this.samples.length) return Buffer.alloc(0)
      const out = Buffer.alloc(this.samples.length * 2)
      for (let i = 0; i < this.samples.length; i++) {
        out.writeInt16LE(this.samples[i], i * 2)
      }
      this.samples = []
      return out
    }
    // Emit remaining by holding last sample.
    if (!this.samples.length) return Buffer.alloc(0)
    const last = this.samples[this.samples.length - 1]
    this.samples.push(last)
    const out = this.push(Buffer.alloc(0))
    this.samples = []
    this.readPos = 0
    this.byteCarry = Buffer.alloc(0)
    return out
  }
}

function normalizeActions(raw) {
  if (!Array.isArray(raw)) return []
  return raw
    .filter((a) => a && typeof a === 'object')
    .map((action) => {
      const type = String(action.type || '').trim()
      const params =
        action.params && typeof action.params === 'object'
          ? { ...action.params }
          : {}
      if (type === 'open_app') {
        const appName = String(
          params.appName || params.name || params.app || '',
        ).trim()
        if (appName) params.appName = appName
        delete params.name
        delete params.app
      }
      return {
        type,
        label: String(action.label || type || '').trim() || undefined,
        params,
      }
    })
    .filter((a) => a.type)
}

/*
 * Real web search via OpenAI's Responses API built-in tool (same API key the
 * Worker already holds). The old DuckDuckGo Instant Answer endpoint returned
 * an empty answer for almost everything (weather, news, time abroad), which
 * left the model with nothing to say after its "let me check…" filler.
 */
export async function runWebSearch(query) {
  const q = String(query || '').trim()
  if (!q) return { ok: false, error: 'empty query' }
  const apiKey = openaiApiKey()
  if (!apiKey) return { ok: false, query: q, error: 'no API key' }

  // Tool type was renamed across API generations; try current name first.
  for (const toolType of ['web_search', 'web_search_preview']) {
    try {
      const response = await fetch('https://api.openai.com/v1/responses', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Authorization: `Bearer ${apiKey}`,
        },
        signal: AbortSignal.timeout(15_000),
        body: JSON.stringify({
          model: process.env.OPENAI_SEARCH_MODEL || 'gpt-4o-mini',
          input: `Search the web and answer concisely in 2-3 spoken-style sentences: ${q}`,
          tools: [{ type: toolType }],
        }),
      })
      const payload = await response.json().catch(() => ({}))

      if (!response.ok) {
        const message = payload?.error?.message || `HTTP ${response.status}`
        // Unknown tool type → try the other name; anything else is real.
        if (response.status === 400 && /tool/i.test(message)) continue
        return { ok: false, query: q, error: message }
      }
      const text =
        String(payload.output_text || '').trim() ||
        (Array.isArray(payload.output)
          ? payload.output
              .flatMap((item) =>
                Array.isArray(item?.content) ? item.content : [],
              )
              .map((part) => String(part?.text || '').trim())
              .filter(Boolean)
              .join(' ')
          : '')
      if (text) {
        return {
          ok: true,
          query: q,
          summary: text.slice(0, 1200),
          source: 'openai-web-search',
        }
      }
      return { ok: false, query: q, error: 'search returned no text' }
    } catch (error) {
      return {
        ok: false,
        query: q,
        error: error?.message || 'web search failed',
      }
    }
  }
  return { ok: false, query: q, error: 'web search tool unavailable' }
}

/**
 * Normalize CF / browser WebSocket to the EventEmitter-ish surface used by
 * this module (`on`/`once`/`send`/`close`/`readyState`/`OPEN`).
 */
function wrapBrowserWebSocket(ws) {
  const OPEN = typeof ws.OPEN === 'number' ? ws.OPEN : 1
  return {
    OPEN,
    get readyState() {
      return ws.readyState
    },
    send(data) {
      ws.send(data)
    },
    close(code, reason) {
      try {
        ws.close(code, reason)
      } catch {
        /* ignore */
      }
    },
    terminate() {
      try {
        ws.close()
      } catch {
        /* ignore */
      }
    },
    on(event, handler) {
      if (event === 'message') {
        ws.addEventListener('message', (ev) => {
          handler(ev?.data)
        })
        return
      }
      if (event === 'error') {
        ws.addEventListener('error', (ev) => {
          handler(ev?.error || ev || new Error('WebSocket error'))
        })
        return
      }
      if (event === 'close') {
        ws.addEventListener('close', () => handler())
        return
      }
      if (event === 'open') {
        ws.addEventListener('open', () => handler())
      }
    },
    once(event, handler) {
      const wrap = (...args) => {
        ws.removeEventListener?.(event, wrap)
        handler(...args)
      }
      if (event === 'message') {
        const listener = (ev) => {
          ws.removeEventListener('message', listener)
          handler(ev?.data)
        }
        ws.addEventListener('message', listener)
        return
      }
      if (event === 'error') {
        const listener = (ev) => {
          ws.removeEventListener('error', listener)
          handler(ev?.error || ev || new Error('WebSocket error'))
        }
        ws.addEventListener('error', listener)
        return
      }
      if (event === 'close') {
        const listener = () => {
          ws.removeEventListener('close', listener)
          handler()
        }
        ws.addEventListener('close', listener)
        return
      }
      if (event === 'open') {
        const listener = () => {
          ws.removeEventListener('open', listener)
          handler()
        }
        ws.addEventListener('open', listener)
      }
    },
  }
}

/**
 * Cloudflare Workers outbound WebSocket with custom Authorization header.
 * Uses fetch + Upgrade (standard WebSocket() cannot set auth headers).
 * https://developers.cloudflare.com/workers/examples/websockets/
 */
async function openViaCloudflareFetchUpgrade(wsUrl, apiKey) {
  const httpUrl = String(wsUrl).replace(/^ws/i, 'http')
  const response = await fetch(httpUrl, {
    headers: {
      Upgrade: 'websocket',
      Authorization: `Bearer ${apiKey}`,
    },
  })
  const webSocket = response.webSocket
  if (!webSocket) {
    const body = await response.text().catch(() => '')
    throw new Error(
      `Realtime WebSocket upgrade failed (HTTP ${response.status})${
        body ? `: ${body.slice(0, 200)}` : ''
      }`,
    )
  }
  // Required before using a server-side accepted socket in Workers.
  webSocket.accept()
  return wrapBrowserWebSocket(webSocket)
}

function openViaNodeWs(url, apiKey) {
  return import('ws').then(
    ({ default: WS }) =>
      new Promise((resolve, reject) => {
        const socket = new WS(url, {
          headers: { Authorization: `Bearer ${apiKey}` },
        })
        const timer = setTimeout(() => {
          try {
            socket.terminate?.()
          } catch {
            /* ignore */
          }
          reject(new Error('Realtime WebSocket open timeout.'))
        }, 12_000)
        socket.once('open', () => {
          clearTimeout(timer)
          resolve(socket)
        })
        socket.once('error', (error) => {
          clearTimeout(timer)
          reject(error)
        })
      }),
  )
}

/**
 * Open a Realtime WebSocket on Node (`ws`) or Cloudflare Workers (fetch upgrade).
 * The `ws` package refuses to load in the Workers "browser-like" runtime:
 * "ws does not work in the browser".
 */
async function openRealtimeSocket(url, apiKey) {
  // WebSocketPair is a Workers-only global — prefer the CF client path.
  const onCloudflareWorker = typeof WebSocketPair !== 'undefined'
  if (onCloudflareWorker) {
    return openViaCloudflareFetchUpgrade(url, apiKey)
  }

  try {
    return await openViaNodeWs(url, apiKey)
  } catch (error) {
    const message = String(error?.message || error)
    // Bundlers sometimes resolve the browser stub of `ws` even outside CF.
    if (
      message.includes('does not work in the browser') ||
      message.includes('WebSocket object')
    ) {
      return openViaCloudflareFetchUpgrade(url, apiKey)
    }
    throw error
  }
}

/**
 * Short history/debug label for job.command — never the plan itself.
 * Prefer optional transcript, else action label, else spoken reply, else generic.
 */
export function historyLabelFromState(state) {
  const transcript = String(state?.transcript || '').trim()
  if (transcript) return transcript
  const actions = Array.isArray(state?.actions) ? state.actions : []
  if (actions.length) {
    const first = actions[0]
    const label = String(first?.label || first?.type || '').trim()
    if (label) return label
  }
  const spoken = String(state?.response || '').trim()
  if (spoken) return spoken.slice(0, 120)
  const textParts = String(state?.textParts?.join?.('') || '').trim()
  if (textParts) return textParts.slice(0, 120)
  return 'voice command'
}

/**
 * Always emit a complete audio-native plan payload for the Mac bridge.
 * Realtime is the only planner (or delegate variant). Transcript/text is only
 * a history label; actions + response are the product. Mac only executes.
 */
export function buildPlanResult(state, startedAt, language) {
  const actions = Array.isArray(state.actions) ? state.actions : []
  const toolsUsed = Array.isArray(state.toolsUsed) ? state.toolsUsed : []
  const spoken =
    String(state.response || '').trim() ||
    (actions.length
      ? undefined
      : String(state.textParts?.join?.('') || '').trim() || undefined)

  let status = state.status
  if (state.delegate || actions.length) status = 'ready'
  else if (spoken) status = 'instant'
  else status = status || 'instant'

  // Never empty a usable plan that already has tool-produced actions.
  const requireLocalPlanner = Boolean(state.delegate && !actions.length)
  const needsLocalFallback = false

  return {
    // History label only — Mac must use plannerHint, not re-plan from this.
    // May be the literal 'voice command' filler, so it must NEVER be stored as
    // a transcript: that is how a run that produced nothing came back looking
    // like the owner had actually said the words "voice command".
    text: historyLabelFromState({ ...state, actions, response: spoken }),
    /*
     * What the owner ACTUALLY said, or undefined when speech-to-text never
     * returned words. Callers that persist an ASR field (audio captures)
     * must use this, not `text`.
     */
    transcript: String(state.transcript || '').trim() || undefined,
    model: realtimeModel(),
    language: language || null,
    status,
    response: spoken,
    actions,
    durationMs: Date.now() - startedAt,
    source: 'audio-native-realtime',
    toolsUsed,
    passes: 1,
    // Always audio-native (or delegate variant). Never a text/local primary planner.
    planner: requireLocalPlanner ? 'audio-native-delegate' : 'audio-native',
    requireLocalPlanner,
    needsLocalFallback,
    midPressStreamed: Boolean(state.midPressStreamed),
  }
}

/**
 * Streaming Realtime session: open ASAP, append PCM while body arrives, finish on end.
 *
 * @param {object} opts
 * @param {number} [opts.inputSampleRate=15625]
 * @param {string|null} [opts.language]
 * @param {object|null} [opts.fleet] - live fleet snapshot (Mac apps, browser, iOS, …)
 * @param {(plan: object) => void|Promise<void>} [opts.onEarlyPlan] - fire when Mac tools resolve
 */
export async function createStreamingRealtimeSession({
  inputSampleRate = 15625,
  language = null,
  fleet = null,
  onEarlyPlan = null,
  /*
   * Conversational reply path: when audioOut is set the model itself speaks
   * (output_modalities ['audio']) and every PCM delta is handed to
   * onAudioDelta as a 24 kHz s16le mono Buffer the moment it arrives, so the
   * caller can pipe it straight down to the pendant. Tool calls still fire.
   */
  audioOut = false,
  onAudioDelta = null,
  /*
   * 'pcm'  — s16le at inputSampleRate, resampled here to 24 kHz.
   * 'pcmu' — G.711 μ-law 8 kHz bytes passed through untouched (the model
   *          decodes μ-law itself). Output mirrors: 'pcmu' makes the model
   *          emit μ-law deltas so the pendant gets 64 kbps, not 384.
   */
  inputFormat = 'pcm',
  outputFormat = 'pcm',
  /*
   * Status-type tools (get_mac_status) block on this: it resolves with the
   * Mac's executed result so the model can SPEAK the actual answer down the
   * live stream instead of a "fetching…" filler that never gets followed up.
   * Resolves null on timeout; the model then says results are on the way.
   */
  waitForMacResult = null,
  /* Raw X-Device-Time header (+CCLK) — the pendant's LTE network clock. */
  deviceTime = null,
  /*
   * Full-duplex conversation mode (WebSocket transport): the session outlives
   * any single response — turns keep flowing until the caller invokes end()
   * (button stop / socket close / inactivity). finish()'s HTTP body-end
   * semantics never apply; barge-in interrupts the model mid-speech.
   */
  conversation = false,
  /* Conversation mode: fired once per completed spoken turn with
   * { transcript, response } so the caller can record the exchange. */
  onTurn = null,
  /* Conversation mode: user started speaking (semantic VAD). The caller
   * decides whether device-side playback needs flushing (barge-in). */
  onUserSpeech = null,
} = {}) {
  const apiKey = openaiApiKey()
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required for Realtime voice agent.')
  }

  const startedAt = Date.now()
  const passthroughInput = inputFormat === 'pcmu'
  const resampler = passthroughInput
    ? null
    : new StreamingPcmResampler(inputSampleRate, REALTIME_PCM_RATE)
  // μ-law rides through untouched (the model decodes it); PCM gets levelled so
  // a quiet pendant mic still clears the Realtime VAD's absolute gate.
  const leveler = passthroughInput
    ? null
    : createUplinkLeveler({ sampleRate: REALTIME_PCM_RATE })
  const socket = await openRealtimeSocket(realtimeWsUrl(), apiKey)

  const state = {
    transcript: '',
    textParts: [],
    actions: [],
    status: 'instant',
    response: undefined,
    toolsUsed: [],
    delegate: false,
    closed: false,
    finished: false,
    committed: false,
    bodyEnded: false,
    completedResponses: 0,
    /*
     * Turn accounting: semantic VAD commits utterances on its own; every
     * commit (with create_response) owes the pendant one completed spoken
     * response. finish() must never close the session while
     * completedResponses < vadCommits — that is exactly the "reply cut off
     * after the first sentence" bug.
     */
    vadCommits: 0,
    midPressStreamed: false,
    bytesIn: 0,
    bytesToModel: 0,
  }

  let settle
  const resultPromise = new Promise((resolve, reject) => {
    settle = { resolve, reject }
  })

  // Conversation sessions are ended by the caller (button stop / WS close /
  // inactivity); the timer is only a runaway backstop.
  const timeout = setTimeout(
    () => {
      if (state.finished) return
      state.finished = true
      cleanup()
      settle.reject(new Error('Realtime voice agent timed out.'))
    },
    conversation ? CONVERSATION_MAX_MS : SESSION_TIMEOUT_MS,
  )

  function cleanup() {
    clearTimeout(timeout)
    if (!state.closed) {
      state.closed = true
      try {
        socket.close()
      } catch {
        /* ignore */
      }
    }
  }

  function finishOk() {
    if (state.finished) return
    state.finished = true
    const plan = buildPlanResult(state, startedAt, language)
    cleanup()
    settle.resolve(plan)
    if (typeof onEarlyPlan === 'function' && (plan.actions?.length || plan.requireLocalPlanner)) {
      // Already finished; onEarlyPlan may have run from tools. Safe no-op if used.
    }
  }

  function finishErr(error) {
    if (state.finished) return
    state.finished = true
    cleanup()
    settle.reject(error instanceof Error ? error : new Error(String(error)))
  }

  function send(event) {
    if (state.closed || socket.readyState !== socket.OPEN) return
    socket.send(JSON.stringify(event))
  }

  /*
   * Ask the model to SPEAK (the reply streams to the pendant's open socket);
   * the response.done handler finishes the session when speech completes.
   * response.create while another response is still active is an API error
   * that would kill the session mid-stream — defer to its response.done.
   */
  function requestSpokenReply() {
    if (state.responseActive) {
      state.pendingSpokenReply = true
    } else {
      state.spokenReplyRequested = true
      send({
        type: 'response.create',
        response: { output_modalities: ['audio'] },
      })
    }
  }

  /* Dispatch the current plan to the Mac early; returns the queued job. */
  async function emitMacPlan() {
    const plan = buildPlanResult(state, startedAt, language)
    let job = null

    if (typeof onEarlyPlan === 'function') {
      try {
        job = await onEarlyPlan(plan)
      } catch (error) {
        console.warn(
          `[realtime] onEarlyPlan failed: ${error?.message || error}`,
        )
      }
    }
    return { plan, job }
  }

  async function emitMacPlanAndFinish(planSurface = 'mac') {
    const { plan } = await emitMacPlan()

    if (audioOut && !state.finished) {
      requestSpokenReply()
      return plan
    }
    finishOk()
    return plan
  }

  async function handleFunctionCall(name, callId, argsJson) {
    let args = {}
    try {
      args = JSON.parse(argsJson || '{}')
    } catch {
      args = {}
    }
    state.toolsUsed.push(name)

    if (name === 'web_search') {
      const output = await runWebSearch(args.query)
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(output),
        },
      })
      // Semantic VAD may have started another response while the search ran;
      // a raw response.create then is an API error that kills the session.
      if (audioOut) {
        requestSpokenReply()
      } else {
        send({
          type: 'response.create',
          response: { output_modalities: ['text'] },
        })
      }
      return
    }

    // PROACTIVE status reads: dispatch to the Mac, then (audio mode) HOLD the
    // turn until the real result lands so the model speaks the actual answer
    // — never a "fetching…" filler followed by silence.
    if (name === 'get_mac_status') {
      const optionalTranscript = String(args.transcript || '').trim()
      if (optionalTranscript) state.transcript = optionalTranscript
      state.response =
        String(args.spoken_reply || args.response || '').trim() || 'Checking.'
      const actions = normalizeActions(mapGetMacStatusToActions(args.fields))
      state.actions = actions
      state.status = actions.length ? 'ready' : 'instant'

      const { job } = await emitMacPlan()

      let output = {
        ok: true,
        queued: true,
        surface: 'mac',
        tool: 'get_mac_status',
        actionCount: state.actions.length,
        fields: Array.isArray(args.fields) ? args.fields : ['all'],
      }
      if (audioOut && job?.jobId && typeof waitForMacResult === 'function') {
        const result = await waitForMacResult(job.jobId).catch(() => null)
        output = result
          ? {
              ok: true,
              executed: true,
              surface: 'mac',
              tool: 'get_mac_status',
              result,
            }
          : {
              ...output,
              note: 'Mac has not returned data yet; tell the owner the result is on its way.',
            }
      }
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify(output),
        },
      })
      if (audioOut && !state.finished) {
        requestSpokenReply()
        return
      }
      finishOk()
      return
    }

    if (name === 'mac_run_actions' || name === 'browser_run_actions') {
      // Transcript is optional history only — actions + spoken_reply are the plan.
      const optionalTranscript = String(args.transcript || '').trim()
      if (optionalTranscript) state.transcript = optionalTranscript
      state.response =
        String(args.spoken_reply || args.response || '').trim() || undefined
      let actions = normalizeActions(args.actions)
      // Browser tool: ensure action types are browser_* when the model omits prefix.
      if (name === 'browser_run_actions') {
        actions = actions.map((action) => {
          const type = String(action.type || '')
          if (type && !type.startsWith('browser_') && type !== 'open_url') {
            return { ...action, type: `browser_${type}` }
          }
          return action
        })
      }
      state.actions = actions
      state.status = state.actions.length ? 'ready' : 'instant'
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({
            ok: true,
            queued: true,
            surface: name === 'browser_run_actions' ? 'browser' : 'mac',
            actionCount: state.actions.length,
          }),
        },
      })
      await emitMacPlanAndFinish(
        name === 'browser_run_actions' ? 'browser' : 'mac',
      )
      return
    }

    if (name === 'mac_delegate') {
      const optionalTranscript = String(args.transcript || '').trim()
      if (optionalTranscript) state.transcript = optionalTranscript
      state.response =
        String(args.spoken_reply || args.goal || '').trim() ||
        'Working on that on your Mac.'
      state.actions = []
      state.delegate = true
      state.status = 'ready'
      send({
        type: 'conversation.item.create',
        item: {
          type: 'function_call_output',
          call_id: callId,
          output: JSON.stringify({ ok: true, delegated: true }),
        },
      })
      await emitMacPlanAndFinish('mac')
      return
    }

    send({
      type: 'conversation.item.create',
      item: {
        type: 'function_call_output',
        call_id: callId,
        output: JSON.stringify({ ok: false, error: `Unknown tool: ${name}` }),
      },
    })
    if (audioOut) {
      requestSpokenReply()
    } else {
      send({
        type: 'response.create',
        response: { output_modalities: ['text'] },
      })
    }
  }

  socket.on('message', (raw) => {
    let event
    try {
      event = JSON.parse(String(raw))
    } catch {
      return
    }

    // OPENAI_RT_DEBUG=1 traces the raw event sequence — the only way to see
    // why semantic VAD did or didn't act on a given press.
    if (process.env.OPENAI_RT_DEBUG) {
      const brief =
        event.type === 'error'
          ? event.error?.message || event.message
          : event.type === 'response.done'
            ? event.response?.status
            : ''
      console.log(`[rt-event] ${event.type}${brief ? ` :: ${brief}` : ''}`)
    }

    if (event.type === 'error') {
      // Commit-shaped complaints are recoverable bookkeeping, not session
      // failures: semantic VAD may have already consumed the buffer when a
      // defensive commit lands. Killing the socket here cuts the model off
      // mid-sentence on the pendant.
      const code = event.error?.code || ''
      const message =
        event.error?.message || event.message || 'Realtime API error'
      if (
        code === 'input_audio_buffer_commit_empty' ||
        /buffer too small/i.test(message)
      ) {
        console.warn(`[realtime] non-fatal API error: ${message}`)
        if (
          state.bodyEnded &&
          state.completedResponses > 0 &&
          !state.responseActive &&
          !state.pendingSpokenReply
        ) {
          state.status =
            state.actions.length || state.delegate ? 'ready' : 'instant'
          finishOk()
        }
        return
      }
      finishErr(new Error(message))
      return
    }

    if (event.type === 'input_audio_buffer.committed') {
      state.vadCommits += 1
    }

    if (event.type === 'input_audio_buffer.speech_started') {
      if (typeof onUserSpeech === 'function') {
        try {
          onUserSpeech()
        } catch {
          /* caller's problem, not the session's */
        }
      }
    }

    if (event.type === 'response.created') {
      state.responseActive = true
    }

    if (event.type === 'conversation.item.input_audio_transcription.completed') {
      const t = String(event.transcript || '').trim()
      if (t) state.transcript = t
    }

    if (
      event.type === 'response.output_text.delta' ||
      event.type === 'response.text.delta'
    ) {
      const delta = event.delta || event.text || ''
      if (delta) state.textParts.push(delta)
    }

    if (event.type === 'response.output_audio.delta') {
      if (typeof onAudioDelta === 'function' && event.delta) {
        try {
          onAudioDelta(Buffer.from(event.delta, 'base64'))
        } catch (error) {
          console.warn(
            `[realtime] onAudioDelta failed: ${error?.message || error}`,
          )
        }
      }
    }

    // Audio mode delivers the reply text as a transcript stream; capture it
    // so job history and the Mac result keep their text fields.
    if (event.type === 'response.output_audio_transcript.delta') {
      const delta = event.delta || ''
      if (delta) state.textParts.push(delta)
    }
    if (event.type === 'response.output_audio_transcript.done') {
      const text = String(event.transcript || state.textParts.join('')).trim()
      if (text) state.response = text
    }

    if (
      event.type === 'response.output_text.done' ||
      event.type === 'response.text.done'
    ) {
      const text = String(event.text || state.textParts.join('')).trim()
      if (text) state.response = text
    }

    if (event.type === 'response.function_call_arguments.done') {
      const name = event.name
      const callId = event.call_id
      const args = event.arguments
      if (name && callId) {
        void handleFunctionCall(name, callId, args).catch((error) => {
          finishErr(error)
        })
      }
    }

    if (event.type === 'response.done') {
      state.responseActive = false
      const status = event.response?.status
      const output = event.response?.output || []
      const hasFunctionCall = output.some(
        (item) => item?.type === 'function_call',
      )
      if (state.pendingSpokenReply) {
        // The tool-call response just finished; now request the deferred
        // spoken confirmation (see emitMacPlanAndFinish).
        state.pendingSpokenReply = false
        state.spokenReplyRequested = true
        send({
          type: 'response.create',
          response: { output_modalities: ['audio'] },
        })
        return
      }
      if (!hasFunctionCall && status === 'completed') {
        state.completedResponses += 1
        if (conversation) {
          // Full-duplex: the turn is done, the session is not. Hand the
          // exchange to the caller and reset for the next utterance. The
          // input transcript is cleared with it — otherwise a turn whose
          // transcription arrives late replays the PREVIOUS user line.
          const turnResponse =
            String(state.response || state.textParts.join('')).trim() ||
            undefined
          const turnTranscript = state.transcript || undefined
          state.transcript = ''
          state.response = undefined
          state.textParts = []
          if (typeof onTurn === 'function') {
            try {
              onTurn({ transcript: turnTranscript, response: turnResponse })
            } catch {
              /* recording the turn must never break the conversation */
            }
          }
          return
        }
        if (audioOut && !state.bodyEnded) {
          // Owner is still recording: reply audio is already queued down the
          // response stream; keep the session open for the next utterance.
          if (!state.response) {
            state.response =
              String(state.textParts.join('')).trim() || undefined
          }
          state.textParts = []
          return
        }
        if (audioOut && state.completedResponses < state.vadCommits) {
          // Body ended but an earlier VAD-committed utterance still owes a
          // reply (its response is queued behind this one). Keep the session
          // and the audio stream open until every turn is answered.
          if (!state.response) {
            state.response =
              String(state.textParts.join('')).trim() || undefined
          }
          state.textParts = []
          return
        }
        // Pure text: chitchat / knowledge only. Empty actions; needsLocalFallback false.
        // Do NOT promote response → transcript; history label is derived later.
        if (!state.response) {
          state.response = String(state.textParts.join('')).trim() || undefined
        }
        // If model answered device/Mac state without mac tools, log corrective note
        // (mid-session re-prompt is hard; instructions are the primary fix).
        const macTools = new Set([
          'get_mac_status',
          'mac_run_actions',
          'mac_delegate',
        ])
        const usedMacTool = (state.toolsUsed || []).some((t) => macTools.has(t))
        if (
          !usedMacTool &&
          !state.actions.length &&
          looksLikeDeviceStateAnswer(state.response)
        ) {
          console.warn(
            '[realtime] device-state-like text reply without mac tools; strengthen instructions / tool_choice. response=',
            String(state.response || '').slice(0, 160),
          )
        }
        state.status =
          state.actions.length || state.delegate ? 'ready' : 'instant'
        finishOk()
      } else if (conversation) {
        // Cancelled/failed/incomplete turns (barge-in truncation included)
        // never end a live conversation — reset fully so the aborted
        // response's partial text cannot leak into the next turn record.
        if (!hasFunctionCall && status && status !== 'in_progress') {
          state.textParts = []
          state.response = undefined
        }
      } else if (
        !hasFunctionCall &&
        state.spokenReplyRequested &&
        status &&
        status !== 'in_progress'
      ) {
        // Speech follow-up after a Mac tool call ended without completing
        // (cancelled/failed). The plan already went out via onEarlyPlan —
        // finish with it instead of hanging until the session timeout.
        state.status =
          state.actions.length || state.delegate ? 'ready' : 'instant'
        finishOk()
      } else if (
        !hasFunctionCall &&
        state.bodyEnded &&
        status &&
        status !== 'in_progress' &&
        state.completedResponses > 0 &&
        !state.pendingSpokenReply
      ) {
        // A queued turn died (cancelled/failed) after body end. Its reply is
        // never coming; ship what the earlier turns produced instead of
        // hanging the pendant until the session timeout.
        state.status =
          state.actions.length || state.delegate ? 'ready' : 'instant'
        finishOk()
      }
    }
  })

  socket.on('error', (error) => finishErr(error))
  socket.on('close', () => {
    if (state.finished) return
    state.closed = true
    clearTimeout(timeout)
    if (state.transcript || state.response || state.actions.length) {
      finishOk()
    } else {
      finishErr(new Error('Realtime WebSocket closed early.'))
    }
  })

  // `fleet` may be a promise: the caller's D1 fleet read overlaps the WS
  // handshake. Awaited here — after every socket handler above is attached —
  // so no early server event can land in an unhandled gap.
  const resolvedFleet = await fleet
  const sessionInstructions = composeRealtimeInstructions({
    language,
    fleet: resolvedFleet ? normalizeFleetSnapshot(resolvedFleet) : null,
    deviceTime,
  })

  // Static policy + tools first, then fleet snapshot inside instructions
  // (composeRealtimeInstructions puts static text first for prefix caching).
  send({
    type: 'session.update',
    session: {
      type: 'realtime',
      instructions: sessionInstructions,
      output_modalities: audioOut ? ['audio'] : ['text'],
      tools: REALTIME_TOOLS,
      tool_choice: 'auto',
      audio: {
        input: {
          format: passthroughInput
            ? { type: 'audio/pcmu' }
            : { type: 'audio/pcm', rate: REALTIME_PCM_RATE },
          transcription: { model: 'gpt-4o-mini-transcribe' },
          /*
           * Audio mode: the model detects end-of-utterance itself and
           * responds mid-recording (the pendant records until button-stop;
           * replies queue downstream and play the moment upload ends).
           * Text mode keeps manual commit semantics.
           */
          /*
           * Conversation (full duplex): the model may be interrupted by the
           * owner's voice — barge-in truncates its speech, like a real
           * conversation. HTTP mode keeps interrupt off: the pendant plays
           * replies after upload, so "interruptions" would only be the
           * model hearing trailing mic audio, not real barge-in.
           */
          turn_detection: audioOut
            ? {
                type: 'semantic_vad',
                create_response: true,
                interrupt_response: conversation,
              }
            : null,
        },
        ...(audioOut
          ? {
              output: {
                format:
                  outputFormat === 'pcmu'
                    ? { type: 'audio/pcmu' }
                    : { type: 'audio/pcm', rate: REALTIME_PCM_RATE },
                voice: process.env.OPENAI_REALTIME_VOICE || 'marin',
              },
            }
          : {}),
      },
    },
  })

  return {
    /** Append pendant audio (mid-press): s16le PCM, or μ-law passthrough. */
    appendRawPcm(chunk) {
      if (state.finished || state.committed) return
      if (!chunk?.length) return
      state.bytesIn += chunk.length
      const toModel = passthroughInput
        ? chunk
        : leveler.push(resampler.push(chunk))
      if (!toModel.length) return
      state.uplinkGain = leveler ? leveler.gain : 1
      state.bytesToModel += toModel.length
      state.midPressStreamed = true
      // ~200 ms frames: 9600 B at 24 kHz s16le, 1600 B at 8 kHz μ-law.
      const frame = passthroughInput ? 1600 : 9600
      for (let i = 0; i < toModel.length; i += frame) {
        const slice = toModel.subarray(i, i + frame)
        send({
          type: 'input_audio_buffer.append',
          audio: slice.toString('base64'),
        })
      }
    },

    /** Body complete: commit buffer and ask the model to respond. */
    finish() {
      if (state.finished) return resultPromise
      if (!state.committed) {
        state.committed = true
        const rawTail = resampler ? resampler.flush() : Buffer.alloc(0)
        const tail = leveler ? leveler.push(rawTail) : rawTail
        if (tail.length) {
          state.bytesToModel += tail.length
          send({
            type: 'input_audio_buffer.append',
            audio: tail.toString('base64'),
          })
        }
        if (state.bytesToModel === 0) {
          finishErr(new Error('No audio received for Realtime session.'))
          return resultPromise
        }
        state.bodyEnded = true
        if (audioOut) {
          /*
           * Semantic VAD owns the turns. At body end there are three cases:
           * 1. VAD never committed anything (short press, released before
           *    the pause was detected) — force a manual commit + response.
           * 2. Turns are outstanding (a commit without its completed reply,
           *    an active response, a deferred spoken follow-up) — WAIT.
           *    The response.done handler finishes when the ledger balances.
           *    Ending here is the "first sentence only" cutoff.
           * 3. Every committed turn is answered — finish now.
           */
          if (
            state.vadCommits === 0 &&
            state.completedResponses === 0 &&
            !state.responseActive &&
            !state.pendingSpokenReply &&
            !state.spokenReplyRequested
          ) {
            send({ type: 'input_audio_buffer.commit' })
            send({
              type: 'response.create',
              response: { output_modalities: ['audio'] },
            })
          } else if (
            state.completedResponses === 0 &&
            !state.responseActive &&
            !state.pendingSpokenReply &&
            !state.spokenReplyRequested
          ) {
            // VAD committed a turn but its auto-response never appeared
            // (create raced the body end, or got cancelled before
            // response.created). Nothing is in flight, so requesting the
            // response ourselves is safe — waiting here would hang until
            // the 60 s session timeout (review finding).
            send({
              type: 'response.create',
              response: { output_modalities: ['audio'] },
            })
          } else if (
            state.completedResponses > 0 &&
            state.completedResponses >= state.vadCommits &&
            !state.responseActive &&
            !state.pendingSpokenReply
          ) {
            state.status =
              state.actions.length || state.delegate ? 'ready' : 'instant'
            finishOk()
          }
        } else {
          send({ type: 'input_audio_buffer.commit' })
          send({
            type: 'response.create',
            response: { output_modalities: ['text'] },
          })
        }
      }
      return resultPromise
    },

    /**
     * Conversation mode: end the session deliberately (button stop, device
     * socket closed, inactivity). Resolves the summary plan from whatever
     * the conversation accumulated; never forces a commit.
     */
    end() {
      if (state.finished) return resultPromise
      state.bodyEnded = true
      state.status =
        state.actions.length || state.delegate ? 'ready' : 'instant'
      if (!state.response && state.textParts.length) {
        state.response = String(state.textParts.join('')).trim() || undefined
      }
      finishOk()
      return resultPromise
    },

    /** Live session state for callers that manage their own lifecycle. */
    get active() {
      return !state.finished
    },

    /**
     * Settles when the session is over — resolves with the plan on a clean
     * end, rejects if the Realtime leg died. Conversation callers watch this
     * to tear down the device leg instead of streaming into a dead session.
     */
    get done() {
      return resultPromise
    },

    get responseInFlight() {
      return Boolean(state.responseActive || state.pendingSpokenReply)
    },

    abort(error) {
      finishErr(error || new Error('Realtime session aborted.'))
    },

    get stats() {
      return {
        bytesIn: state.bytesIn,
        bytesToModel: state.bytesToModel,
        midPressStreamed: state.midPressStreamed,
        uplinkGain: state.uplinkGain ?? 1,
      }
    },
  }
}

/**
 * Batch helper: full buffer → streaming session (still uses Realtime).
 */
export async function planUtteranceWithRealtime({
  audioBuffer,
  format = 'wav',
  sampleRate = 16000,
  language = null,
  fleet = null,
  onEarlyPlan = null,
} = {}) {
  const { pcm: rawPcm, sampleRate: wavRate } = extractPcmFromWavOrPcm(
    audioBuffer,
    format,
  )
  const sourceRate = wavRate || sampleRate || 16000
  if (!rawPcm.length) {
    throw new Error('Audio buffer is empty.')
  }

  const session = await createStreamingRealtimeSession({
    inputSampleRate: sourceRate,
    language,
    fleet,
    onEarlyPlan,
  })
  // Append in chunks so the path matches mid-press streaming.
  const step = 3200 // ~100 ms @ 16 kHz
  for (let i = 0; i < rawPcm.length; i += step) {
    session.appendRawPcm(rawPcm.subarray(i, i + step))
  }
  return session.finish()
}

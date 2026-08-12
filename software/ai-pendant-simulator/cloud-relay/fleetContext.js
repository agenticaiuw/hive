/**
 * Fleet context for the Realtime voice agent.
 *
 * Design goals (context engineering):
 * - Stable static policy first (cacheable prompt prefix).
 * - Live fleet / harness snapshot second (semi-stable across heartbeats).
 * - No keyword command tables, no hard-coded app alias maps.
 * - Exact runtime names only (from Mac discovery, browser heartbeats, etc.).
 *
 * OpenAI Realtime prompt caching: put unchanging text first; device state after.
 * Cached text input on gpt-realtime-2.1 is billed far below uncached rates.
 *
 * There is NO memory section in the prompt anymore, and that is the design,
 * not a gap. The owner, 2026-08-12: "Memories are not doing anything useful
 * right now… not just generic memories that all get added to the system
 * prompt." Remembered facts now live in the fleet document's `domainMemory`
 * hive block (shared/domainMemory.js) and are fetched per capability domain
 * AT TOOL-SELECTION TIME (openaiRealtimeVoice.js) — attached to that tool's
 * result, never spliced into instructions. This file only normalizes the
 * block so it rides the snapshot as data.
 */
import {
  DOMAIN_MEMORY_FIELD,
  normalizeDomainMemoryBlock,
} from '../shared/domainMemory.js'

export const FLEET_STATE_KEY = 'fleet'
export const MAX_APPLICATIONS_IN_PROMPT = 220
export const MAX_SHORTCUTS_IN_PROMPT = 40
export const MAX_CLI_TOOLS_IN_PROMPT = 180
export const MAX_BROWSER_DEVICES = 6

/**
 * Static system instructions (cacheable prefix).
 *
 * OpenAI Realtime prompting patterns: role + tool-first policy only.
 * Contracts live in tool schemas. No timestamps (prefix-cache friendly).
 * Realtime is the ONLY planner for voice — Mac only executes tool plans.
 */
export const VOICE_AGENT_STATIC_INSTRUCTIONS = `You are the wearable pendant voice operator for the owner's Mac. You ACT through tools; speech only confirms. The Mac never plans — it only executes the actions you emit.

## Role
- Owner is often away from the keyboard. Short spoken requests arrive as audio.
- You are the sole planner: call tools for any Mac query or control. Spoken words are confirmation, not a substitute for tools.
- Plan from speech directly. Transcript tool fields are optional history only — never required, never optimize for them.

## Tool policy (Realtime-first)
- PROACTIVE: for status and reversible control, call tools immediately. Do not ask permission first for battery, wifi, volume, focused app, open app, open URL, create reminder, type text, browser reads/clicks, or web search.
- CONFIRMATION FIRST only for destructive/irreversible work (delete files, send messages/email, purchases, force-quit, bulk changes). Then call the tool after a clear go-ahead.
- Device/Mac state ALWAYS uses tools — battery, wifi, volume, focused app, disk, processes, network, what is open, system settings. Prefer get_mac_status. Never guess numbers or invent readings in spoken text alone.
- Anything that queries or changes the Mac = tool first (get_mac_status, mac_run_actions, browser_run_actions). Chitchat and pure knowledge Q&A = speak only, no tools.
- Live public facts = web_search. Multi-step or ambiguous computer work = mac_delegate only when a short action list is not enough.
- Asking what became of work already handed to the Mac ("did that go through", "what's the status of the thing I asked earlier") = relay_job_status, even when the reference is vague. Speak its \`spoken\` sentence as given; never report a task as done that it did not call done.
- Reading a named public page = read_web_page (relay-side browser, works with the Mac asleep). It has no logins and no LAN access, so anything behind a sign-in or on the home network = browser_run_actions on the Mac.
- You are self-sufficient for general knowledge, conversation, math, and date/time (owner_local_time is in context). NEVER involve the Mac for questions that are not about the Mac or its apps/files.
- Never claim success unless a tool call actually queued or completed the work.
- If a needed surface is offline, say so briefly and offer what you can do without it.
- Follow tool schemas exactly; do not invent parameter names.

## Speech
- Default: one short spoken sentence (spoken_reply on tools, or a brief text reply for pure chitchat/knowledge).
- Do not narrate tool use at length. Confirm intent; the Mac reports outcomes later when needed.

## Output
Tools produce the plan (actions). Spoken reply is user-facing confirmation only. History labels are secondary.`

/**
 * Parse the pendant's X-Device-Time header (3GPP +CCLK "yy/MM/dd,hh:mm:ss±zz",
 * zz = quarter-hours offset from UTC). Whether the time field is UTC or local
 * varies by modem/carrier, so both readings are checked against the server's
 * own clock and the agreeing one wins. Returns { utcMs, offsetMinutes } or
 * null when absent/implausible (e.g. NITZ never delivered).
 */
export function parseDeviceTime(cclk, nowMs = Date.now()) {
  const match =
    /^(\d{2})\/(\d{2})\/(\d{2}),(\d{2}):(\d{2}):(\d{2})([+-]\d{1,2})$/.exec(
      String(cclk || '').trim(),
    )
  if (!match) return null

  const year = 2000 + Number(match[1])
  if (year < 2024 || year > 2099) return null
  const offsetMinutes = Number(match[7]) * 15
  const fieldMs = Date.UTC(
    year,
    Number(match[2]) - 1,
    Number(match[3]),
    Number(match[4]),
    Number(match[5]),
    Number(match[6]),
  )

  const TOLERANCE_MS = 5 * 60_000
  const candidates = [
    fieldMs, // time field already UTC
    fieldMs - offsetMinutes * 60_000, // time field was local
  ]
  for (const utcMs of candidates) {
    if (Math.abs(utcMs - nowMs) <= TOLERANCE_MS) {
      return { utcMs, offsetMinutes }
    }
  }
  return null
}

export function formatDeviceTime({ utcMs, offsetMinutes }) {
  const local = new Date(utcMs + offsetMinutes * 60_000)
  const dayNames = [
    'Sunday',
    'Monday',
    'Tuesday',
    'Wednesday',
    'Thursday',
    'Friday',
    'Saturday',
  ]
  const hours24 = local.getUTCHours()
  const hours12 = hours24 % 12 === 0 ? 12 : hours24 % 12
  const meridiem = hours24 < 12 ? 'AM' : 'PM'
  const minutes = String(local.getUTCMinutes()).padStart(2, '0')
  const sign = offsetMinutes >= 0 ? '+' : '-'
  const absOffset = Math.abs(offsetMinutes)
  const offsetLabel = `UTC${sign}${Math.floor(absOffset / 60)}${
    absOffset % 60 ? `:${String(absOffset % 60).padStart(2, '0')}` : ''
  }`

  return `${dayNames[local.getUTCDay()]} ${local.getUTCFullYear()}-${String(
    local.getUTCMonth() + 1,
  ).padStart(2, '0')}-${String(local.getUTCDate()).padStart(
    2,
    '0',
  )} ${hours12}:${minutes} ${meridiem} (${offsetLabel}, from the pendant's LTE network)`
}

/**
 * Build the full Realtime session instructions string.
 * Static block is always first so prefix caching can hit across sessions.
 */
export function composeRealtimeInstructions({
  language = null,
  fleet = null,
  cloud = null,
  deviceTime = null,
} = {}) {
  const parts = [VOICE_AGENT_STATIC_INSTRUCTIONS]

  const fleetBlock = formatFleetSnapshotForPrompt(fleet, { cloud, deviceTime })
  if (fleetBlock) {
    parts.push('')
    parts.push(fleetBlock)
  }

  if (language) {
    parts.push('')
    parts.push(`Spoken language hint: ${language}.`)
  }

  return parts.join('\n')
}

/**
 * Normalize anything stored under /v1/state/fleet into a compact shape.
 */
export function normalizeFleetSnapshot(raw) {
  const data =
    raw && typeof raw === 'object'
      ? raw.data && typeof raw.data === 'object'
        ? raw.data
        : raw
      : {}

  const mac = data.mac && typeof data.mac === 'object' ? data.mac : {}
  const browser =
    data.browser && typeof data.browser === 'object' ? data.browser : {}
  const ios = data.ios && typeof data.ios === 'object' ? data.ios : {}
  const pendant =
    data.pendant && typeof data.pendant === 'object' ? data.pendant : {}
  const cloud = data.cloud && typeof data.cloud === 'object' ? data.cloud : {}

  // Sort BEFORE capping: on a Mac with more than MAX_APPLICATIONS_IN_PROMPT
  // discovered apps, discovery-order slicing would change WHICH apps survive
  // the cap between heartbeats, churning the prompt's cacheable prefix.
  const applications = Array.isArray(mac.applications)
    ? mac.applications
        .map((name) => String(name || '').trim())
        .filter((name) => name && !name.startsWith('.'))
        .sort()
        .slice(0, MAX_APPLICATIONS_IN_PROMPT)
    : []

  const automationRaw =
    mac.automation && typeof mac.automation === 'object' ? mac.automation : {}
  // Sorted before capping for the same prompt-cache stability as apps.
  const automation = {
    macosVersion: String(automationRaw.macosVersion || '').trim() || null,
    arch: String(automationRaw.arch || '').trim() || null,
    shortcuts: Array.isArray(automationRaw.shortcuts)
      ? automationRaw.shortcuts
          .map((name) => String(name || '').trim())
          .filter(Boolean)
          .sort()
          .slice(0, MAX_SHORTCUTS_IN_PROMPT)
      : [],
    cliTools: Array.isArray(automationRaw.cliTools)
      ? automationRaw.cliTools
          .map((name) => String(name || '').trim())
          .filter(Boolean)
          .sort()
          .slice(0, MAX_CLI_TOOLS_IN_PROMPT)
      : [],
  }

  const browserDevices = Array.isArray(browser.devices)
    ? browser.devices
        .filter((d) => d && typeof d === 'object')
        .slice(0, MAX_BROWSER_DEVICES)
        .map((d) => ({
          online: Boolean(d.online),
          browserName: String(d.browserName || '').trim() || null,
          deviceName: String(d.deviceName || '').trim() || null,
          tabUrl: String(d.tabUrl || '').trim() || null,
          tabTitle: String(d.tabTitle || '').trim().slice(0, 80) || null,
          tabCount:
            d.tabCount == null || !Number.isFinite(Number(d.tabCount))
              ? null
              : Number(d.tabCount),
          tabId: d.tabId == null ? null : Number(d.tabId),
          lastSeenAt: d.lastSeenAt || null,
        }))
    : []

  return {
    version: Number(data.version) || 1,
    updatedAt: data.updatedAt || raw?.updatedAt || null,
    mac: {
      online: Boolean(mac.online),
      hostname: String(mac.hostname || '').trim() || null,
      platform: String(mac.platform || '').trim() || null,
      home: String(mac.home || '').trim() || null,
      permissionsReady: mac.permissionsReady !== false,
      hostApp: String(mac.hostApp || '').trim() || null,
      applications,
      appCount: applications.length || Number(mac.appCount) || 0,
      automation,
      timezone: String(mac.timezone || '').trim() || null,
    },
    browser: {
      online: Boolean(browser.online) || browserDevices.some((d) => d.online),
      devices: browserDevices,
    },
    ios: {
      online: Boolean(ios.online),
      lastSeenAt: ios.lastSeenAt || null,
      name: String(ios.name || '').trim() || null,
    },
    pendant: {
      lastSeenAt: pendant.lastSeenAt || null,
      speaker: String(pendant.speaker || '').trim() || null,
      playPolicy:
        String(pendant.playPolicy || '').trim() ||
        'LED on first speech batch; user button starts playback (no autoplay)',
    },
    cloud: {
      webSearch: cloud.webSearch !== false,
      integrations: Array.isArray(cloud.integrations)
        ? cloud.integrations.map((x) => String(x).trim()).filter(Boolean)
        : [],
    },
    /*
     * The hive block, normalized and carried as DATA for tool-time attach —
     * never prompt stuffing. The owner: "tools should be combined with
     * memories"; the voice brain fetches a domain's facts when it selects that
     * domain's tool (openaiRealtimeVoice.js), so the facts ride the snapshot
     * but stay OUT of formatFleetSnapshotForPrompt below.
     */
    [DOMAIN_MEMORY_FIELD]: normalizeDomainMemoryBlock(
      data[DOMAIN_MEMORY_FIELD],
    ),
  }
}

/**
 * Build a fleet snapshot from the Mac /ops/snapshot payload plus relay devices.
 */
export function fleetFromAgentSnapshot(agentSnapshot, { devices = [] } = {}) {
  const status =
    agentSnapshot?.status && typeof agentSnapshot.status === 'object'
      ? agentSnapshot.status
      : agentSnapshot && typeof agentSnapshot === 'object'
        ? agentSnapshot
        : {}
  const machine = status.machine || agentSnapshot?.machine || {}
  const browser = status.browser || agentSnapshot?.browser || {}
  const agent = status.agent || agentSnapshot?.agent || {}
  const permissions = agent.permissions || status.permissions || {}

  // Prefer full list if the Mac pushed it; else fall back to topApps.
  const applications = Array.isArray(machine.applications)
    ? machine.applications
    : Array.isArray(machine.topApps)
      ? machine.topApps
      : []

  const browserDevices = Array.isArray(browser.devices) ? browser.devices : []

  const mobile = (Array.isArray(devices) ? devices : []).find(
    (d) => d?.deviceType === 'mobile' || d?.deviceType === 'ios',
  )
  const macBridge = (Array.isArray(devices) ? devices : []).find(
    (d) => d?.deviceType === 'mac_bridge',
  )

  return normalizeFleetSnapshot({
    version: 1,
    updatedAt: new Date().toISOString(),
    mac: {
      online: true,
      hostname: machine.hostname,
      platform: machine.platform,
      home: machine.home,
      permissionsReady: Boolean(permissions.ready ?? permissions.ok ?? true),
      hostApp: permissions.hostApp || null,
      applications,
      appCount: machine.appCount || applications.length,
      automation: machine.automation || null,
      timezone: machine.timezone || null,
    },
    browser: {
      online: Boolean(browser.online),
      devices: browserDevices,
    },
    ios: mobile
      ? {
          online: Boolean(mobile.online ?? isRecent(mobile.lastSeenAt)),
          lastSeenAt: mobile.lastSeenAt || null,
          name: mobile.name || null,
        }
      : { online: false },
    pendant: {
      lastSeenAt: null,
      speaker: null,
    },
    cloud: {
      webSearch: true,
      integrations: [],
      macBridgeLastSeen: macBridge?.lastSeenAt || null,
    },
    // Present only if the Mac put a hive block in /ops/snapshot; normalize
    // strips anything that is not a well-formed hive fact either way.
    [DOMAIN_MEMORY_FIELD]:
      status[DOMAIN_MEMORY_FIELD] || agentSnapshot?.[DOMAIN_MEMORY_FIELD] || null,
  })
}

/**
 * Compact live environment block (after static policy).
 * Facts only — no per-action coaching. Names/resources come from runtime discovery.
 */
export function formatFleetSnapshotForPrompt(
  fleetInput,
  { cloud = null, deviceTime = null } = {},
) {
  const fleet = normalizeFleetSnapshot(fleetInput || {})
  if (cloud && typeof cloud === 'object') {
    fleet.cloud = {
      ...fleet.cloud,
      webSearch: cloud.webSearch !== false,
      integrations: Array.isArray(cloud.integrations)
        ? cloud.integrations
        : fleet.cloud.integrations,
    }
  }

  /*
   * Ordering is prompt-cache load-bearing: OpenAI caches the longest
   * byte-identical prefix (min 1024 tokens). Stable facts (surfaces, cloud,
   * sorted app inventory) come first so the cacheable prefix extends well past
   * the minimum; anything that churns between presses (active tab, as_of)
   * sits at the very end. Do not add timestamps above the inventory.
   */
  const lines = ['## Live environment']

  // Surfaces (stable identity only — live tab state comes later)
  lines.push('### Surfaces')
  if (fleet.mac.online) {
    lines.push(
      `- mac: online · host=${fleet.mac.hostname || '?'} · ${
        fleet.mac.platform || '?'
      } · permissions=${fleet.mac.permissionsReady ? 'ready' : 'incomplete'}`,
    )
    if (fleet.mac.home) lines.push(`  home: ${fleet.mac.home}`)
  } else {
    lines.push('- mac: offline')
  }
  lines.push(
    `- browser_extension: ${
      fleet.browser.online && fleet.browser.devices.length
        ? 'online'
        : 'offline'
    }`,
  )
  lines.push(
    fleet.ios.online
      ? `- ios: online${fleet.ios.name ? ` · ${fleet.ios.name}` : ''}`
      : '- ios: offline',
  )
  lines.push(
    `- pendant: ${fleet.pendant.playPolicy}${
      fleet.pendant.speaker ? ` · speaker=${fleet.pendant.speaker}` : ''
    }`,
  )

  // Cloud integrations (capabilities, not recipes)
  const integrations =
    fleet.cloud.integrations.length > 0
      ? fleet.cloud.integrations.join(', ')
      : 'none'
  lines.push('### Cloud')
  lines.push(
    `- web_search: ${fleet.cloud.webSearch ? 'available' : 'unavailable'}`,
  )
  lines.push('- read_web_page: public pages only (no owner sessions, no LAN)')
  lines.push(`- connected_integrations: ${integrations}`)

  // Mac resource inventory (for grounding — not a command menu). Sorted so
  // discovery-order churn cannot invalidate the cached prefix.
  if (fleet.mac.online && fleet.mac.applications.length) {
    lines.push('### Mac software inventory')
    lines.push(
      `(${fleet.mac.applications.length} apps discovered on this machine; use exact names when a tool needs one)`,
    )
    lines.push([...fleet.mac.applications].sort().join(', '))
  }

  const automation = fleet.mac.automation
  if (fleet.mac.online && automation) {
    lines.push('### Mac automation environment (discovered, not assumed)')
    lines.push(
      `- macOS ${automation.macosVersion || 'unknown'} on ${
        automation.arch || 'unknown'
      }. AppleScript, System Events UI scripting, and media key codes are available (accessibility ${
        fleet.mac.permissionsReady ? 'granted' : 'NOT granted'
      }).`,
    )
    lines.push(
      automation.shortcuts.length
        ? `- Shortcuts runnable via \`shortcuts run "<name>"\`: ${automation.shortcuts.join(', ')}`
        : '- No Shortcuts are defined on this Mac.',
    )
    if (automation.cliTools.length === 0) {
      lines.push(
        '- No non-default CLI tools are installed — never shell out to a third-party tool; use AppleScript/System Events/Shortcuts instead.',
      )
    } else if (automation.cliTools.length < MAX_CLI_TOOLS_IN_PROMPT) {
      lines.push(
        `- Non-default CLI tools installed (complete list): ${automation.cliTools.join(', ')}`,
      )
      lines.push(
        '- A CLI tool absent from that list is NOT installed — never shell out to one on a guess; use AppleScript/System Events/Shortcuts instead.',
      )
    } else {
      // Capped: an alphabetical prefix must not masquerade as the whole truth.
      lines.push(
        `- Non-default CLI tools (first ${automation.cliTools.length} alphabetically; more may exist): ${automation.cliTools.join(', ')}`,
      )
      lines.push(
        '- Before shelling out to any tool NOT shown above, verify it exists in the same action (e.g. `command -v <tool> && <tool> …`) with an AppleScript/System Events fallback.',
      )
    }
  }

  /*
   * NO memory section here, deliberately — the owner's verdict on the old
   * splice: "not just generic memories that all get added to the system
   * prompt." The hive block rides fleet.domainMemory as data; the voice brain
   * attaches a domain's facts to a tool's result when it selects that
   * domain's tool. The prompt carries environment facts only.
   */

  // ---- Volatile tail (changes between presses; kept below the cache line) ----
  if (fleet.browser.online && fleet.browser.devices.length) {
    lines.push('### Browser now')
    for (const device of fleet.browser.devices) {
      if (!device.online) continue
      const bits = [
        device.browserName || 'browser',
        device.deviceName,
        device.tabUrl && `active_origin=${device.tabUrl}`,
        device.tabTitle && `title=${device.tabTitle}`,
        device.tabCount != null && `tabs=${device.tabCount}`,
      ].filter(Boolean)
      lines.push(`- ${bits.join(' · ')}`)
    }
  }

  // The model has no clock: give it the owner's local wall time (volatile
  // tail — below the cache line) so time/date questions are answered
  // directly, never routed to a Mac tool.
  const timezone = fleet.mac.timezone || 'UTC'
  let localNow
  try {
    localNow = new Intl.DateTimeFormat('en-US', {
      timeZone: timezone,
      weekday: 'long',
      year: 'numeric',
      month: 'long',
      day: 'numeric',
      hour: 'numeric',
      minute: '2-digit',
      timeZoneName: 'short',
    }).format(new Date())
  } catch {
    localNow = new Date().toISOString()
  }
  // "Clock", not "Now": the projection contributes its own `Now` section for
  // what the owner is working on, and two adjacent sections both called Now
  // meaning different things is exactly the ambiguity that makes a model
  // answer a time question with a task.
  lines.push('### Clock')
  // Pendant NITZ time (from the LTE tower) beats the Mac-reported timezone:
  // it stays correct with the Mac asleep, offline, or in another city.
  const parsedDeviceTime = deviceTime ? parseDeviceTime(deviceTime) : null
  if (parsedDeviceTime) {
    lines.push(`- owner_local_time: ${formatDeviceTime(parsedDeviceTime)}`)
  } else {
    lines.push(`- owner_local_time: ${localNow} (${timezone})`)
  }
  lines.push(`as_of: ${fleet.updatedAt || 'unknown'}`)

  return lines.join('\n')
}

/**
 * Build the compact object the Mac bridge should PUT to /v1/state/fleet.
 */
export function buildFleetPayloadFromLocal({
  machine = null,
  browser = null,
  permissions = null,
  speaker = null,
  /* The Mac's hive facts: { facts: [...] } or a full block. Replaces the old
   * memory/memoryText/workingProject trio — capability-domain facts are the
   * only memory that crosses this wire now. */
  domainMemory = null,
} = {}) {
  const applications = Array.isArray(machine?.applications)
    ? machine.applications
        .map((n) => String(n || '').trim())
        .filter((n) => n && !n.startsWith('.'))
        .slice(0, MAX_APPLICATIONS_IN_PROMPT)
    : []

  const devices = Array.isArray(browser?.devices) ? browser.devices : []

  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mac: {
      online: true,
      hostname: machine?.hostname || null,
      platform: machine?.platform || null,
      home: machine?.home || null,
      permissionsReady: Boolean(
        permissions?.ready ??
          (Array.isArray(permissions?.requiredMissing)
            ? permissions.requiredMissing.length === 0
            : true),
      ),
      automation: machine?.automation || null,
      timezone: machine?.timezone || null,
      hostApp: permissions?.hostApp || null,
      applications,
      appCount: applications.length,
    },
    browser: {
      online: Boolean(browser?.online),
      devices: devices.map((d) => ({
        online: Boolean(d.online),
        browserName: d.browserName || null,
        deviceName: d.deviceName || null,
        tabUrl: d.tabUrl || null,
        tabTitle: d.tabTitle || null,
        tabCount: d.tabCount ?? null,
        tabId: d.tabId ?? null,
        lastSeenAt: d.lastSeenAt || null,
      })),
    },
    ios: { online: false },
    pendant: {
      speaker: speaker || null,
      playPolicy:
        'LED on first speech batch; user button starts playback (no autoplay)',
    },
    cloud: {
      webSearch: true,
      integrations: [],
    },
    /*
     * The hive block as data, shaped for the relay-side merge. The PUT
     * handler (server.js) MERGES this into the stored block rather than
     * trusting it wholesale, so a bridge restart carrying an empty list can
     * never erase facts the voice loop saved. Facts are passed through, not
     * normalized here — the merge rejects malformed or node-scoped entries
     * and reports them, which beats dropping them silently on the Mac.
     */
    [DOMAIN_MEMORY_FIELD]: {
      version: 1,
      facts: Array.isArray(domainMemory?.facts) ? domainMemory.facts : [],
    },
  }
}

function isRecent(iso, windowMs = 120_000) {
  if (!iso) return false
  const t = Date.parse(iso)
  if (Number.isNaN(t)) return false
  return Date.now() - t < windowMs
}

/**
 * Load fleet for a Realtime session from the relay store.
 * Prefers dedicated fleet state; falls back to agent-snapshot.
 *
 * No memory projection is folded in anymore — the snapshot carries the
 * normalized domainMemory block as data, and the voice brain reads facts
 * through its domainMemory session option (domainMemoryRelay.js) at
 * tool-selection time instead.
 */
export async function loadFleetFromStore(store) {
  if (!store) return null
  return loadFleetSnapshot(store)
}

async function loadFleetSnapshot(store) {
  try {
    const fleetState = await store.getState?.(FLEET_STATE_KEY)
    if (fleetState?.data && typeof fleetState.data === 'object') {
      return normalizeFleetSnapshot(fleetState)
    }
  } catch {
    /* ignore */
  }

  try {
    const agentState = await store.getState?.('agent-snapshot')
    const devices =
      typeof store.listDevices === 'function' ? await store.listDevices() : []
    if (agentState?.data) {
      return fleetFromAgentSnapshot(agentState.data, { devices })
    }
  } catch {
    /* ignore */
  }

  return null
}

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
 * The memory section is no longer written here. It is a projection of the
 * cross-surface event log (shared/fleetMemory.js), scoped to the surface that
 * is asking and to what was actually asked. This file's job is to place that
 * block correctly in the prompt and to bound it; deciding what belongs in it is
 * not a relay concern, and when it was, only one body could contribute to it.
 */
import { projectFleetMemory } from '../shared/fleetMemory.js'

export const FLEET_STATE_KEY = 'fleet'
export const MAX_APPLICATIONS_IN_PROMPT = 220
export const MAX_SHORTCUTS_IN_PROMPT = 40
export const MAX_CLI_TOOLS_IN_PROMPT = 180
export const MAX_BROWSER_DEVICES = 6
export const MAX_MEMORY_LINE = 160

/*
 * Ceiling for the projected memory block the Mac sends in memory.text. The
 * projection budgets itself (200 tokens ≈ 800 chars), but that budget lives on
 * the Mac and this is the relay: a bridge running old or misconfigured code
 * must not be able to push an unbounded string into every voice turn's prompt.
 */
export const MAX_MEMORY_TEXT_CHARS = 2000

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
  const memory =
    data.memory && typeof data.memory === 'object' ? data.memory : {}

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
    memory: {
      /*
       * A ready-made prompt block. Two things produce one: the cross-surface
       * projection assembled in loadFleetFromStore(), and — until the bridge
       * appends events instead — the Mac's own single-node projection arriving
       * through fleet state. The relay does not know which facts exist or what
       * they cost, so it does not summarize; it bounds and places.
       */
      text: clipText(memory.text, MAX_MEMORY_TEXT_CHARS),
      /*
       * Fallback for the agent-snapshot path in loadFleetFromStore(), which
       * reads the raw context graph and has no projection to offer. Without
       * these the voice agent would lose memory entirely whenever the
       * dedicated fleet state is missing.
       */
      workingProject: memory.workingProject
        ? String(
            memory.workingProject.name ||
              memory.workingProject.title ||
              memory.workingProject,
          ).slice(0, MAX_MEMORY_LINE)
        : null,
      latestPerson: clip(memory.latestPerson?.name || memory.latestPerson),
      latestTask: clip(memory.latestTask?.name || memory.latestTask),
      latestFile: clip(memory.latestFile?.name || memory.latestFile),
    },
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
  const memory =
    status.memory ||
    agentSnapshot?.context?.memory ||
    agentSnapshot?.memory ||
    {}
  const workingProject =
    status.workingProject ||
    agentSnapshot?.context?.workingProject ||
    agentSnapshot?.workingProject ||
    null

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
    memory: {
      // Present only if the Mac put one in /ops/snapshot; this path normally
      // has just the raw graph, which is why the latest* fallback survives.
      text: memory.text || null,
      workingProject,
      latestPerson: memory.latestPerson,
      latestTask: memory.latestTask,
      latestFile: memory.latestFile,
    },
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
   * the minimum; anything that churns between presses (active tab, memory,
   * as_of) sits at the very end. Do not add timestamps above the inventory.
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
   * Projected memory sits ABOVE the volatile tail, unlike the `### Recent
   * context` line it replaces. That line was correctly treated as volatile —
   * it was rebuilt from whatever entity the graph touched last, so a single
   * file open changed it. A projection is ordered stable-first by whichever
   * body built it (fleetMemory.js and contextProjection.js apply the same rule:
   * preferences first, sorted by key), so its head is byte-identical between
   * turns and only earns its place in the cacheable prefix if it is emitted
   * before the active tab and the clock.
   *
   * Headings are demoted one level: the projection is a standalone document
   * with `##` headings, and pasting those in mid-section would orphan the
   * environment blocks below it under `## Relevant`.
   */
  if (fleet.memory.text) {
    lines.push(fleet.memory.text.replace(/^## /gm, '### '))
  }

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

  // Light memory — only when the Mac sent no projection (agent-snapshot
  // fallback path). These are last-touched entity names with no provenance or
  // expiry, so they stay in the volatile tail where they belong.
  if (!fleet.memory.text) {
    const memBits = [
      fleet.memory.workingProject && `project=${fleet.memory.workingProject}`,
      fleet.memory.latestPerson && `person=${fleet.memory.latestPerson}`,
      fleet.memory.latestTask && `task=${fleet.memory.latestTask}`,
      fleet.memory.latestFile && `file=${fleet.memory.latestFile}`,
    ].filter(Boolean)
    if (memBits.length) {
      lines.push('### Recent context')
      lines.push(memBits.join(' · '))
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
  memory = null,
  memoryText = null,
  workingProject = null,
  speaker = null,
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
     * With a projection in hand the entity objects are dead weight on the
     * wire: normalizeFleetSnapshot() reduces each of them to a name anyway, so
     * the bridge was PUTting a whole working-project record (open threads,
     * notes, goals) per heartbeat to produce one short line of prompt. Send the
     * projection alone; the fields below exist only for a bridge that has no
     * projection to send.
     */
    memory: memoryText
      ? { text: memoryText }
      : {
          workingProject: workingProject || null,
          latestPerson: memory?.latestPerson || null,
          latestTask: memory?.latestTask || null,
          latestFile: memory?.latestFile || null,
        },
  }
}

/* Multi-line prompt block: keep the newlines, drop the runaway length. */
function clipText(value, maxChars) {
  const text = String(value ?? '').trim()
  if (!text) return null
  return text.length > maxChars ? text.slice(0, maxChars).trimEnd() : text
}

function clip(value) {
  if (value == null) return null
  if (typeof value === 'object') {
    const name = value.name || value.title || value.label
    return name ? String(name).slice(0, MAX_MEMORY_LINE) : null
  }
  const text = String(value).trim()
  return text ? text.slice(0, MAX_MEMORY_LINE) : null
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
 * `surface` and `task` are what turn this from a snapshot read into a
 * projection read. Existing callers pass neither and still get the cross-surface
 * memory they never had; a caller that knows what was said should pass it,
 * because relevance is the only thing that makes a memory block cheap and the
 * relay is the one body that has the words.
 */
export async function loadFleetFromStore(store, options = {}) {
  if (!store) return null

  const fleet = await loadFleetSnapshot(store)
  // Memory alone is not a fleet. Synthesizing a snapshot around it would report
  // "mac: offline" from an absence of telemetry rather than from telemetry,
  // which is a different and worse claim.
  if (!fleet) return null

  const projection = await projectFleetMemoryFromStore(store, {
    ...options,
    // Whatever the Mac pushed is merged INTO the projection under one budget,
    // not emitted beside it. Two memory blocks in one prompt pay twice for one
    // idea; this branch disappears when the bridge appends events instead.
    inheritedText: fleet.memory.text,
  })

  if (projection?.text) {
    fleet.memory = { ...fleet.memory, text: projection.text }
    fleet.memoryProjection = projection.stats
  }

  return fleet
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

/**
 * Read the memory log and project it for one surface.
 *
 * Best-effort by design, like every other read in this file: a store with no
 * memory tables, or a store that throws, costs the voice agent the projection
 * and nothing else. Losing memory quality is survivable; losing the fleet
 * snapshot because a memory read failed is not.
 */
export async function projectFleetMemoryFromStore(
  store,
  {
    surface = 'voice',
    task = '',
    now = Date.now(),
    // The relay already lets a projection this large into a prompt
    // (MAX_MEMORY_TEXT_CHARS), so asking for it is not asking for anything new.
    // It is a ceiling, not a target: the projection spends only what it has.
    budgetBytes = MAX_MEMORY_TEXT_CHARS,
    inheritedText = null,
  } = {},
) {
  if (typeof store?.listMemoryEvents !== 'function') {
    return inheritedText ? { text: inheritedText, eventIds: [], stats: null } : null
  }

  try {
    const events = await store.listMemoryEvents({ now })
    const projection = projectFleetMemory({
      events,
      surface,
      task,
      now,
      budgetBytes,
      inheritedText,
    })
    return projection.text ? projection : null
  } catch {
    return inheritedText ? { text: inheritedText, eventIds: [], stats: null } : null
  }
}

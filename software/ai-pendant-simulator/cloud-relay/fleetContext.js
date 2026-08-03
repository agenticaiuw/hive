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
 */

export const FLEET_STATE_KEY = 'fleet'
export const MAX_APPLICATIONS_IN_PROMPT = 220
export const MAX_BROWSER_DEVICES = 6
export const MAX_MEMORY_LINE = 160

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
- Never claim success unless a tool call actually queued or completed the work.
- If a needed surface is offline, say so briefly and offer what you can do without it.
- Follow tool schemas exactly; do not invent parameter names.

## Speech
- Default: one short spoken sentence (spoken_reply on tools, or a brief text reply for pure chitchat/knowledge).
- Do not narrate tool use at length. Confirm intent; the Mac reports outcomes later when needed.

## Output
Tools produce the plan (actions). Spoken reply is user-facing confirmation only. History labels are secondary.`

/**
 * Build the full Realtime session instructions string.
 * Static block is always first so prefix caching can hit across sessions.
 */
export function composeRealtimeInstructions({
  language = null,
  fleet = null,
  cloud = null,
} = {}) {
  const parts = [VOICE_AGENT_STATIC_INSTRUCTIONS]

  const fleetBlock = formatFleetSnapshotForPrompt(fleet, { cloud })
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

  const applications = Array.isArray(mac.applications)
    ? mac.applications
        .map((name) => String(name || '').trim())
        .filter((name) => name && !name.startsWith('.'))
        .slice(0, MAX_APPLICATIONS_IN_PROMPT)
    : []

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
export function formatFleetSnapshotForPrompt(fleetInput, { cloud = null } = {}) {
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

  const lines = ['## Live environment']
  lines.push(`as_of: ${fleet.updatedAt || 'unknown'}`)

  // Surfaces
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

  if (fleet.browser.online && fleet.browser.devices.length) {
    lines.push('- browser_extension: online')
    for (const device of fleet.browser.devices) {
      if (!device.online) continue
      const bits = [
        device.browserName || 'browser',
        device.deviceName,
        device.tabUrl && `active_origin=${device.tabUrl}`,
        device.tabTitle && `title=${device.tabTitle}`,
        device.tabCount != null && `tabs=${device.tabCount}`,
      ].filter(Boolean)
      lines.push(`  - ${bits.join(' · ')}`)
    }
  } else {
    lines.push('- browser_extension: offline')
  }

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
  lines.push(`- connected_integrations: ${integrations}`)

  // Mac resource inventory (for grounding — not a command menu)
  if (fleet.mac.online && fleet.mac.applications.length) {
    lines.push('### Mac software inventory')
    lines.push(
      `(${fleet.mac.applications.length} apps discovered on this machine; use exact names when a tool needs one)`,
    )
    lines.push(fleet.mac.applications.join(', '))
  }

  // Light memory
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
    memory: {
      workingProject: workingProject || null,
      latestPerson: memory?.latestPerson || null,
      latestTask: memory?.latestTask || null,
      latestFile: memory?.latestFile || null,
    },
  }
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
 */
export async function loadFleetFromStore(store) {
  if (!store) return null
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

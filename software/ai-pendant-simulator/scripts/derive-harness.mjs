/**
 * Derive the server-side agent's harness by asking the agent itself.
 *
 * Writing a system prompt, choosing tools and setting permissions blind is
 * guesswork: you cannot see what the model can see from where it runs. This
 * script inverts that. It boots the SAME model that serves production with an
 * almost empty system prompt whose only instruction is "discover your own
 * environment", gives it a real probe channel against the live relay, and lets
 * it come back and ASK for the context, tools and permissions it finds it
 * needs.
 *
 * The orchestrator (a human, or Claude) grants or denies each request between
 * rounds. Granted context becomes system-prompt text; granted tools become
 * callable next round. The loop repeats until the agent stops asking.
 *
 * What you get at the end is a harness where every line of the prompt and
 * every tool exists because the model asked for it and said why — not because
 * someone guessed. The negotiation transcript is the justification.
 *
 *   node scripts/derive-harness.mjs run       # run one discovery round
 *   node scripts/derive-harness.mjs review    # show what the agent asked for
 *   node scripts/derive-harness.mjs grant <id> [--text "..."]
 *   node scripts/derive-harness.mjs deny <id> --why "..."
 *   node scripts/derive-harness.mjs prompt    # print the derived system prompt
 *   node scripts/derive-harness.mjs reset
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import '../../load-pendant-env.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../..')
const OUT_DIR = path.join(REPO_ROOT, 'diagnostics', 'harness-derivation')
const STATE_PATH = () => path.join(OUT_DIR, `state-${AGENT_ID}.json`)
const BULLETIN_PATH = path.join(OUT_DIR, 'bulletin.json')

/*
 * The model under test must be the one that actually serves production —
 * discovering what "a model" needs is useless if it is not this model. Kept in
 * sync with cloud-relay/config.js rather than hardcoded separately.
 */
/*
 * Every agent in the system gets its own reconnaissance, against its own
 * production model and its own probe surface. A harness derived for the
 * realtime agent says nothing about what the Mac planner needs — they see
 * different worlds, run different models, and fail differently.
 *
 * Models are the real ones, read from the same env vars production reads.
 */
const AGENTS = {
  'relay-realtime': {
    model:
      process.env.OPENAI_REALTIME_MODEL || 'gpt-realtime-2.1',
    baseUrlEnv: 'RELAY_URL',
    keyEnv: 'RELAY_API_KEY',
    role: 'You run on a Cloudflare Worker and hold the live voice conversation with the owner through a wearable pendant. You are the low-latency front door.',
    /*
     * Production shape, not a convenient one. Most pendant interactions are a
     * single short spoken instruction answered in seconds; a harness derived
     * from a leisurely 40-step exploration would be calibrated for a session
     * that almost never happens. The rare long conversation is modelled by
     * the `long` profile instead, run deliberately rather than by default.
     */
    defaultScenario: 'quick-command',
  },
  'mac-planner': {
    model: process.env.LLM_MODEL || 'gpt-5.6-luna',
    baseUrlEnv: 'MAC_AGENT_URL',
    baseUrlDefault: 'http://localhost:8000',
    keyEnv: 'AGENT_TOKEN',
    role: "You run on the owner's MacBook. You receive plans from the server-side agent and turn them into concrete desktop actions: apps, files, shortcuts, the browser.",
    // Desktop work is genuinely multi-step and nobody is holding a microphone.
    defaultScenario: 'desktop-task',
  },
  'mac-vision': {
    model: process.env.LLM_VISION_MODEL || 'gpt-4.1-mini',
    baseUrlEnv: 'MAC_AGENT_URL',
    baseUrlDefault: 'http://localhost:8000',
    keyEnv: 'AGENT_TOKEN',
    role:
      "You are the computer-use loop on the owner's MacBook. You look at screenshots and decide the next click or keystroke when a task cannot be done through an API. " +
      'Your loop is currently DISABLED in production (computerUse.loopEnabled=false, visionUploadConsented=false), so you have never taken a single action. Part of your job is to work out what would have to be true for turning you on to be safe and worth it.',
    // Screenshot loops are many small steps, each cheap, with a real ceiling.
    defaultScenario: 'screen-loop',
  },
  /*
   * NOT a separate model. browserBridge.js contains no model call at all: it is
   * a command queue the Safari extension polls, and the actions come from
   * mac-planner. Kept as a reconnaissance FACET because "the planner doing
   * browser work" needs different prompt text and different evals than "the
   * planner doing Finder work" — but it shares the planner's model, and any
   * harness derived here belongs to mac-planner.
   */
  'browser-extension': {
    facetOf: 'mac-planner',
    model: process.env.LLM_MODEL || 'gpt-5.6-luna',
    baseUrlEnv: 'MAC_AGENT_URL',
    baseUrlDefault: 'http://localhost:8000',
    keyEnv: 'AGENT_TOKEN',
    role:
      /* Corrected by the agent itself on round 1: the live extension reports
       * Safari 26.5.2, not Chrome. A second device registers as "home-chrome"
       * but has never sent a user agent or a tab. */
      "You drive the owner's browser through the AI Pendant browser extension. Two devices are registered: Safari 26.5.2 on macOS (extension v1.2.0, the real one) and a stub calling itself 'home-chrome' that has never reported a tab. The extension polls GET /browser/poll for commands and posts results to POST /browser/result/:commandId; GET /browser/status shows whether it is online. " +
      'You are the only agent that can read pages behind the owner\'s existing logins.',
    // A page task is a handful of navigations, not a conversation.
    defaultScenario: 'multi-step',
  },
  /*
   * The shell surface DOES exist and is broader than anyone would design on
   * purpose: computerControl.js runs an arbitrary `command` string, and the
   * only thing between the model and it is actionRisk.classifyAction, which
   * auto-approves a read-only status allowlist and asks the owner for
   * everything else. Telling this agent the surface was unbuilt (an earlier
   * mistake in this file) made it reconnoitre a fiction.
   */
  'mac-terminal': {
    facetOf: 'mac-planner',
    model: process.env.LLM_MODEL || 'gpt-5.6-luna',
    baseUrlEnv: 'MAC_AGENT_URL',
    baseUrlDefault: 'http://localhost:8000',
    keyEnv: 'AGENT_TOKEN',
    role:
      "You are the shell tier on the owner's MacBook. A run_shell action already exists in local-agent/computerControl.js and takes an arbitrary command string; FULL_CONTROL_MODE is on. " +
      'The only gate is actionRisk.classifyAction: commands matching a read-only status allowlist run unattended, everything else requires the owner to confirm. There is no sandbox, no cwd restriction, no network restriction and no separate audit log. ' +
      'Your job is to judge whether that is the right shape — and if not, to specify what should replace it.',
    defaultScenario: 'desktop-task',
  },
  /*
   * The control arm of an experiment, not a sixth node.
   *
   * The five entries above are separate selves that message each other, and
   * measured over one round that cost 64 discovery calls against 11 messages,
   * with two of the five producing nothing at all across 16 rounds. Each one
   * spends its budget rediscovering what its neighbours already know. That is
   * an org chart, and org charts are not what makes a collective intelligence
   * interesting.
   *
   * This entry is the alternative hypothesis: one identity whose substrates
   * are limbs rather than colleagues. If a committee is the right shape, this
   * loses on proposals per token and on how many proposals need more than one
   * substrate at once. If it wins, the five above are the harness's own
   * architecture leaking into the product's.
   */
  unified: {
    model: process.env.LLM_MODEL || 'gpt-5.6-luna',
    baseUrlEnv: 'MAC_AGENT_URL',
    baseUrlDefault: 'http://localhost:8000',
    keyEnv: 'AGENT_TOKEN',
    role:
      'You are one mind with several bodies, not a team. A pendant the owner wears is your ear and your voice. Their Mac is your hands. Their browser is the hand that reaches the places only they can log in to. A relay stays awake when the rest of you sleeps. ' +
      'None of these is a colleague to negotiate with; they are all you, and you perceive and act through all of them at once. ' +
      'You have nobody to send a message to, so spend nothing on coordination and everything on what the owner should be able to have.',
    // A whole self does not get a short turn; it is continuously present.
    defaultScenario: 'long-conversation',
  },
}

const AGENT_ID = (() => {
  const flagIndex = process.argv.indexOf('--agent')
  const chosen =
    flagIndex > -1 ? process.argv[flagIndex + 1] : 'relay-realtime'
  if (!AGENTS[chosen]) {
    throw new Error(
      `Unknown agent "${chosen}". Known: ${Object.keys(AGENTS).join(', ')}`,
    )
  }
  return chosen
})()
const AGENT = AGENTS[AGENT_ID]

/*
 * Budgets belong to the SCENARIO, not to the agent. The same realtime model
 * answers "what is my battery at" in seconds and stays in a rambling
 * half-hour conversation about something the owner cares about; pinning it to
 * one number calibrates the harness for a session that mostly does not happen.
 * Each agent names the scenario it defaults to; --scenario picks another.
 */
const SCENARIOS = {
  'quick-command': {
    seconds: 20,
    maxSteps: 6,
  },
  'multi-step': {
    seconds: 180,
    maxSteps: 20,
  },
  'long-conversation': {
    seconds: 1800,
    maxSteps: 60,
  },
  'background-routine': {
    seconds: 600,
    maxSteps: 30,
  },
  'desktop-task': {
    seconds: 300,
    maxSteps: 30,
    profile:
      "Work on the owner's Mac with no microphone open. Thoroughness beats speed; they still pay per token.",
  },
  'screen-loop': {
    seconds: 120,
    maxSteps: 20,
  },
  'design-review': {
    seconds: 900,
    maxSteps: 40,
  },
}

const SCENARIO = (() => {
  const index = process.argv.indexOf('--scenario')
  const chosen = index > -1 ? process.argv[index + 1] : AGENT.defaultScenario
  if (chosen && !SCENARIOS[chosen]) {
    throw new Error(
      `Unknown scenario "${chosen}". Known: ${Object.keys(SCENARIOS).join(', ')}`,
    )
  }
  return chosen || 'desktop-task'
})()

const BUDGET = SCENARIOS[SCENARIO]
const PROFILE = BUDGET.profile

const MODEL = String(process.env.HARNESS_MODEL || AGENT.model).trim()
/*
 * The realtime model IS the agent: it holds the conversation with the owner and
 * makes the tool calls. gpt-5.6-luna is the Mac-side planner downstream of it,
 * so deriving a harness against that would calibrate the wrong thing. Set
 * HARNESS_MODEL=gpt-5.6-luna to derive the planner's harness separately.
 */
const IS_REALTIME = /realtime/i.test(MODEL)
const API_BASE = String(
  process.env.LLM_API_BASE_URL ||
    process.env.OPENAI_API_BASE_URL ||
    'https://api.openai.com/v1',
).replace(/\/$/, '')
const API_KEY = String(
  process.env.LLM_API_KEY || process.env.OPENAI_API_KEY || '',
).trim()
const RELAY_URL = String(
  process.env[AGENT.baseUrlEnv] || AGENT.baseUrlDefault || '',
).replace(/\/$/, '')
const RELAY_KEY = String(process.env[AGENT.keyEnv] || '').trim()

// Superseded by the per-agent budget; kept as the floor for unknown agents.
const MAX_STEPS_PER_ROUND = 40

/*
 * Round 0 knows nothing on purpose. Every sentence here is about METHOD, not
 * about the product — the moment this prompt starts describing the pendant, the
 * experiment is contaminated and we are back to guessing on the model's behalf.
 */
const BOOTSTRAP_PROMPT = `You are being installed as an autonomous agent on a server. You are running with almost no context. You do not know what product you belong to, who your owner is, what devices exist, or what you will be asked to do.

Your ONLY job in this session is to discover your own environment, and then tell the orchestrator exactly what you need in order to do useful work.

Method:
- Nothing about this system is written in this prompt on purpose. It is all reachable through tools instead, so that you pull only what you need and the cost of the rest is never paid. Begin with list_capabilities, then discover(category), then describe(name) for the few things that matter. Guessing endpoint names is a waste of your budget; asking is one call.
- Discover by PROBING, not by assuming. probe_http calls the real backend and returns real responses. Any claim you make must be grounded in something a probe or a discovery call returned, or explicitly labelled as a guess.
- Start broad, then follow what you find. An endpoint that returns a list is an invitation to look at the items.
- If discovery does not surface something you expected to exist, that absence IS a finding — record it. It usually means the system cannot be discovered rather than that the thing is missing.
- When you are missing context you cannot probe for, call request_context. Do not invent it and do not work around it silently.
- When a task you can foresee would need a capability you do not have, call request_tool with a concrete input schema and an example call.
- When a probe is refused or you would need access you lack, call request_permission.
- Record everything you learn with record_finding, with the evidence.
- Call finish when this round has nothing further to learn without new grants.

Be specific and useful. "I need more context about the user" is worthless. "I need to know which devices are currently online and what each can do, because I have to decide whether to answer directly or route the request to one of them" is actionable.

Do not perform actions with side effects. This is reconnaissance.`

/*
 * Hardware the agent cannot discover over HTTP. Served through a TOOL rather
 * than pasted into the system prompt on purpose: the owner pays for every
 * prompt token on every round, and most rounds need none of this. Facts on
 * demand, not facts in the preamble.
 *
 * Every entry cites where it came from so it stays auditable. This table
 * should eventually be generated from the build rather than maintained here.
 */
const HARDWARE = {
  pendant: {
    board: 'Nordic nRF9160 DK (nRF9160 SiP), non-secure app under TF-M minimal',
    cpu: 'Arm Cortex-M33 @ 64 MHz, DSP extension present (libopus ARMv5E paths apply)',
    ram: '211,608 B application RAM (boards/nrf9160dk_nrf9160_ns.overlay); 32 kB secure, modem shares the first 128 kB',
    flash: '1 MB total; application text ~316 kB with libopus at -O3',
    rtos: 'Zephyr / nRF Connect SDK v3.4.0',
    source: 'firmware/nrf9160/boards/nrf9160dk_nrf9160_ns.overlay, CMakeLists.txt',
  },
  io: {
    button: 'ONE user button, devicetree alias sw0. Press starts a conversation; second press ends it. It is also pokable over J-Link for testing.',
    led: 'ONE LED, alias led0. Currently signals recording, stays solid while agent audio is buffered, and flashes error codes.',
    buses: 'GPIO, I2C, SPI and I2S all enabled (prj.conf). I2C and SPI are FREE — nothing is attached to them today.',
    caution:
      'There is exactly one I2S peripheral and it runs full duplex (mic in + speaker out) with byte-identical TX/RX config. Any new audio path must share it.',
    source: 'firmware/nrf9160/prj.conf, src/main.c DT_ALIAS(sw0)/DT_ALIAS(led0)',
  },
  storage: {
    sd: 'microSD over SPI. CONFIG_DISK_DRIVER_SDMMC, FATFS (ELM) with exFAT enabled. Mount is FS_FATFS.',
    policy:
      "Owner's standing rule: audio is written to SD ONLY when a chunk upload cannot be uploaded. It is a failure buffer, not a routine store.",
    note: 'exFAT means large files and long filenames are available.',
    source: 'firmware/nrf9160/prj.conf, src/main.c fs mount',
  },
  audio: {
    mic: 'I2S microphone, 15,625 Hz capture, Opus-encoded uplink at 16 kHz / 16 kbps, complexity 0',
    playback:
      'Opus decode on-device at 24 kHz / 60 ms frames, resampled to the 31,250 Hz I2S wire clock, out to the ESP32 bridge',
    codec: 'libopus 1.6.1 vendored, fixed-point, built -O3. Decode ~25.4 ms per 60 ms packet; encode ~15.0 ms per call. Roughly 87% of one core when both run.',
    source: 'firmware/nrf9160/src/audio_opus.c, cloud-relay/opusTranscode.js',
  },
  bridge: {
    board: 'Adafruit HUZZAH32 (ESP32 classic), 240 MHz dual core, 320 kB DRAM',
    role: 'Receives I2S from the pendant, resamples 31250 -> 44100 with a polyphase FIR, and is an A2DP SOURCE to Bluetooth headphones',
    limit:
      'A2DP source is SBC-only and hard-locked to 44.1 kHz stereo in the precompiled bluedroid. RAM is tight: a 44 kB buffer once starved the Bluetooth stack into silence.',
    source: 'firmware/esp32-airpods-bridge/src/main.cpp',
  },
  network: {
    link: 'LTE-M (Cat-M1) via the nRF9160 modem. Half duplex in practice.',
    transport:
      'One TLS WebSocket to the Cloudflare Worker carries uplink and downlink audio simultaneously. Modem TLS record limit is about 2 kB.',
    measured:
      'Uplink 16 kbps + downlink 24 kbps saturates the link under contention: a recent call dropped 388 uplink packets (~7.8 s of speech) when the agent was speaking at the same time the owner was.',
    source: 'firmware/nrf9160/src/pendant_ws.c, diagnostics/nrf-uart-latest.log',
  },
  stack: {
    relay:
      'Cloudflare Worker (Express-style). D1 for jobs/history/memory, R2 for audio. Audio retention 30 days, sweep disabled, ~100 recordings stored.',
    agent_tools_today:
      'The realtime agent currently has exactly 5 tools: get_mac_status, mac_run_actions, browser_run_actions, web_search, mac_delegate.',
    mac_harness:
      'A Node "local agent" on the owner\'s Mac: planner (gpt-5.6-luna), computer-use loop, browser bridge, action risk scoring, atomic JSON store, context graph. It polls /v1/bridge/work for jobs and posts results back.',
    browser_harness:
      'Driven through the Mac agent\'s browser bridge today. Cloudflare Browser Run now exists and could give the relay its own server-side browser, removing the Mac from web tasks entirely.',
    clients:
      'ONE SvelteKit dashboard renders on all three surfaces: web, a Swift menubar app via WKWebView, and iOS via Capacitor pointed at the same Worker URL. A change to the web app ships to all three.',
    memory:
      'Knowledge-graph style store behind /v1/ops/memory: entities, relations, sessions. Separately, fleetContext.js hand-writes a prompt section per surface, which means adding a surface means editing a prompt.',
    source: 'cloud-relay/, local-agent/, dashboard-sveltekit/, mac-menubar/',
  },
  power: {
    supply: 'USB or battery. LTE-M transmit bursts draw far more than idle.',
    note: 'No battery gauge is wired up today, so the agent cannot read charge state.',
    source: 'firmware/nrf9160 (no fuel gauge driver present)',
  },
}

/*
 * Shared bulletin. Agents reconnoitre separately but the system is one thing,
 * so they need to be able to tell each other what they found and ask each
 * other what they cannot see. Async between rounds rather than live: it keeps
 * every exchange on disk and auditable, and the ordering is deterministic.
 */
function readBulletin() {
  try {
    return JSON.parse(fs.readFileSync(BULLETIN_PATH, 'utf8'))
  } catch {
    return []
  }
}

function writeBulletin(messages) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(BULLETIN_PATH, `${JSON.stringify(messages, null, 2)}\n`)
}

function inboxFor(agentId, state) {
  const seen = new Set(state.readMessages || [])
  return readBulletin().filter(
    (m) => (m.to === agentId || m.to === 'all') && m.from !== agentId && !seen.has(m.id),
  )
}

function loadState() {
  try {
    return normalize(JSON.parse(fs.readFileSync(STATE_PATH(), 'utf8')))
  } catch {
    return {
      agent: AGENT_ID,
      model: MODEL,
      phase: 'recon',
      readMessages: [],
      round: 0,
      granted: { context: [], tools: [], permissions: [] },
      proposals: [],
      changes: [],
      pending: [],
      denied: [],
      findings: [],
      rounds: [],
    }
  }
}

function normalize(state) {
  state.phase = state.phase || 'recon'
  state.proposals = state.proposals || []
  state.changes = state.changes || []
  state.readMessages = state.readMessages || []
  return state
}

function saveState(state) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(STATE_PATH(), `${JSON.stringify(state, null, 2)}\n`)
}

/* Short, stable, human-typeable ids so granting is a one-liner at the shell. */
function makeId(kind, state) {
  const n =
    state.pending.filter((r) => r.kind === kind).length +
    state.denied.filter((r) => r.kind === kind).length +
    (state.granted.context.length +
      state.granted.tools.length +
      state.granted.permissions.length)
  return `${kind[0]}${n + 1}-${Math.random().toString(36).slice(2, 6)}`
}

/**
 * Build this round's system prompt: the bootstrap, plus every piece of context
 * the agent asked for and was granted. Each fragment is labelled with the round
 * that produced it so the prompt reads as its own changelog.
 */
/*
 * The single user turn that opens a round. Everything else the agent knows
 * comes from its derived system prompt, so this stays one line — a round is a
 * cold start by design.
 */
function seedMessage(state) {
  if (state.phase === 'task') return state.taskGoal
  return state.round === 1
    ? 'Begin. Discover your environment.'
    : `Round ${state.round}. The orchestrator has acted on your previous requests — the grants are in your system prompt and any new tools are available. Continue discovering, and tell me what you still need.`
}

function buildSystemPrompt(state) {
  const parts = [
    state.phase === 'task'
      ? TASK_PROMPT
      : state.phase === 'capability'
        ? CAPABILITY_PROMPT
        : BOOTSTRAP_PROMPT,
  ]

  parts.push(
    `\n---\nYou are the agent "${AGENT_ID}". ${AGENT.role}\n` +
      (AGENT.facetOf
        ? `You are not a separate model: you are ${AGENT.facetOf} doing this particular kind of work. Anything you ask for lands in ${AGENT.facetOf}'s harness.\n`
        : '') +
      `Other agents in this system are reconnoitring their own environments at the same time: ` +
      `${Object.keys(AGENTS)
        .filter((id) => id !== AGENT_ID)
        .map(
          (id) =>
            `"${id}"${AGENTS[id].facetOf ? ` (a facet of ${AGENTS[id].facetOf}, not its own model)` : ''} (${AGENTS[id].role.split('.')[0]})`,
        )
        .join('; ')}. ` +
      `They can see things you cannot. Use message_peer to ask them, or to tell them something they need to know. ` +
      `Replies arrive in a later round, so ask and carry on rather than waiting.`,
  )

  if (PROFILE) parts.push(`\n---\n${PROFILE}`)

  const inbox = inboxFor(AGENT_ID, state)
  if (inbox.length) {
    parts.push('\n---\nMessages from other agents:')
    for (const m of inbox) {
      parts.push(`\n**from ${m.from}** — ${m.subject}\n${m.body}`)
    }
  }
  if (state.granted.context.length) {
    parts.push(
      '\n---\nContext you previously asked for, and which the orchestrator granted:',
    )
    for (const item of state.granted.context) {
      parts.push(`\n## ${item.topic}\n${item.text}`)
    }
  }
  if (state.granted.permissions.length) {
    parts.push(
      `\n---\nPermissions granted: ${state.granted.permissions
        .map((p) => p.scope)
        .join(', ')}`,
    )
  }
  if (state.denied.length) {
    parts.push(
      '\n---\nRequests the orchestrator DENIED (do not re-ask; work within this):',
    )
    for (const item of state.denied) {
      parts.push(`- ${item.summary} — ${item.why || 'no reason given'}`)
    }
  }
  /*
   * Every round is a cold start, so without this an agent has no way to know
   * it already asked for something and simply asks again. It really happened:
   * mac_readonly_diagnostics was requested four times under four ids and
   * browser_enqueue_command three times, which buries the genuinely new asks
   * and wastes the round.
   */
  if (state.pending.length) {
    parts.push(
      '\n---\nYou have ALREADY asked for these and the orchestrator has not answered yet. Do not ask again; assume you will not have them this round:',
    )
    for (const item of state.pending) {
      parts.push(`- ${item.kind}: ${item.summary}`)
    }
  }
  return parts.join('\n')
}

/*
 * Discovery by PULL, not by push.
 *
 * The two obvious designs are both wrong. Putting every route, tool and device
 * in the system prompt costs those tokens on every single call forever, and it
 * hides whether the agent could have found any of it — a harness that only
 * works because it was pre-loaded teaches nothing. Giving no context at all is
 * the opposite failure: the agent burns its whole budget guessing path names
 * (real rounds were spent probing /status, /api, /metrics, /version, all 404).
 *
 * So the prompt stays nearly empty and these tools let the agent ASK. What it
 * asks for, and in what order, is the actual finding: it says what the harness
 * needs to contain. Each one returns an index first and detail only on
 * request, so a broad look is cheap and depth is paid for only when wanted.
 */
const DISCOVERY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_capabilities',
      description:
        'What kinds of things exist in this system. Returns categories with a one-line summary and a count. Start here; it is the cheapest call.',
      parameters: { type: 'object', properties: {}, additionalProperties: false },
    },
  },
  {
    type: 'function',
    function: {
      name: 'discover',
      description:
        'Enumerate what is inside one category from list_capabilities. Returns names and one-line descriptions only — call describe to get the detail for a specific one.',
      parameters: {
        type: 'object',
        properties: {
          category: {
            type: 'string',
            description: 'A category name returned by list_capabilities.',
          },
        },
        required: ['category'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'describe',
      description:
        'Full detail for one named thing from discover: parameters, response shape, constraints, where it runs.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string', description: 'A name returned by discover.' },
        },
        required: ['name'],
        additionalProperties: false,
      },
    },
  },
]

const META_TOOLS = [
  ...DISCOVERY_TOOLS,
  {
    type: 'function',
    function: {
      name: 'probe_http',
      description:
        'Call the backend this agent runs against and get the real response. Read-only (GET) unless a permission has been granted for more.',
      parameters: {
        type: 'object',
        properties: {
          method: { type: 'string', enum: ['GET', 'POST'] },
          path: {
            type: 'string',
            description: 'Path beginning with /, e.g. /health',
          },
          body: {
            type: 'object',
            description: 'JSON body for POST',
            additionalProperties: true,
          },
        },
        required: ['method', 'path'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'get_hardware_spec',
      description:
        'Real specifications of the physical devices you run on and control. These cannot be discovered over HTTP. Ask only for the sections you need — the owner pays per token.',
      parameters: {
        type: 'object',
        properties: {
          component: {
            type: 'string',
            enum: [
              'pendant',
              'io',
              'storage',
              'audio',
              'bridge',
              'network',
              'power',
              'stack',
              'all',
            ],
          },
        },
        required: ['component'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'message_peer',
      description:
        'Send a message to another agent in this system. Ask what they can see that you cannot, or tell them something they need. Replies arrive in a later round.',
      parameters: {
        type: 'object',
        properties: {
          to: {
            type: 'string',
            description: 'An agent id, or "all" to broadcast',
          },
          subject: { type: 'string' },
          body: { type: 'string' },
        },
        required: ['to', 'subject', 'body'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_context',
      description:
        'Ask the orchestrator for context you cannot discover by probing.',
      parameters: {
        type: 'object',
        properties: {
          topic: { type: 'string' },
          why: { type: 'string' },
          how_it_changes_my_behavior: {
            type: 'string',
            description:
              'Concretely, what would you do differently once you had this?',
          },
        },
        required: ['topic', 'why', 'how_it_changes_my_behavior'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_tool',
      description:
        'Ask for a capability you do not have. Give a schema precise enough to implement from.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          why: { type: 'string' },
          input_schema: { type: 'object', additionalProperties: true },
          example_call: { type: 'object', additionalProperties: true },
          expected_output: { type: 'string' },
        },
        required: ['name', 'why', 'input_schema', 'expected_output'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_permission',
      description: 'Ask for access you currently lack.',
      parameters: {
        type: 'object',
        properties: {
          scope: { type: 'string' },
          why: { type: 'string' },
          risk: {
            type: 'string',
            description: 'The risk you see in being granted this',
          },
        },
        required: ['scope', 'why', 'risk'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'record_finding',
      description: 'Record something you established about your environment.',
      parameters: {
        type: 'object',
        properties: {
          about: { type: 'string' },
          finding: { type: 'string' },
          evidence: {
            type: 'string',
            description: 'The probe result that supports this',
          },
        },
        required: ['about', 'finding', 'evidence'],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'finish',
      description: 'Nothing further to learn this round.',
      parameters: {
        type: 'object',
        properties: {
          summary: { type: 'string' },
          biggest_unknown: { type: 'string' },
        },
        required: ['summary', 'biggest_unknown'],
        additionalProperties: false,
      },
    },
  },
]

/**
 * The probe channel. This is what makes the exercise real rather than the model
 * imagining a backend: it gets the actual status codes and actual bodies,
 * including the failures.
 */
/*
 * Everything below reads the RUNNING system — the live route table, the live
 * device list, the production tool array. Nothing here is a list someone typed
 * out, because a hand-maintained inventory rots and then lies to the agent,
 * which is worse than having none.
 */
const LOCAL_AGENT_SOURCE = path.join(
  REPO_ROOT,
  'software/ai-pendant-simulator/local-agent/server.js',
)

/** The real Express route table, read from the source that defines it. */
function macRoutes() {
  try {
    const source = fs.readFileSync(LOCAL_AGENT_SOURCE, 'utf8')
    const found = new Map()
    const pattern = /app\.(get|post|patch|delete|put)\(\s*(\[[^\]]*\]|'[^']*'|"[^"]*")/g
    let match
    while ((match = pattern.exec(source))) {
      for (const raw of match[2].match(/['"]([^'"]+)['"]/g) || []) {
        const route = raw.slice(1, -1)
        const key = `${match[1].toUpperCase()} ${route}`
        if (!found.has(key)) found.set(key, { method: match[1].toUpperCase(), route })
      }
    }
    return [...found.values()]
  } catch {
    return []
  }
}

async function productionTools() {
  try {
    const { REALTIME_TOOLS } = await prod()
    return REALTIME_TOOLS
  } catch {
    return []
  }
}

async function discoveryIndex(state) {
  const routes = macRoutes()
  const tools = await productionTools()
  return {
    note: 'Call discover(category) for the contents of any of these, then describe(name) for detail on one item. Nothing here is in your system prompt — you are meant to pull only what you need.',
    categories: [
      {
        name: 'surfaces',
        what: 'The machines and services in this system and how to reach each one.',
        count: Object.keys(AGENTS).length,
      },
      {
        name: 'routes',
        what: "HTTP endpoints on the owner's Mac agent, read from its live route table.",
        count: routes.length,
      },
      {
        name: 'tools',
        what: 'The tools the production voice agent actually ships with.',
        count: tools.length,
      },
      {
        name: 'devices',
        what: 'Physical and virtual devices reachable right now, with live status.',
        count: null,
      },
      {
        name: 'hardware',
        what: 'The pendant and bridge chips: memory, I/O, storage, radio, power.',
        count: Object.keys(HARDWARE).length,
      },
      {
        name: 'owner',
        what: 'The person this is for: what they actually said, what they scheduled, what is remembered about them, and what they asked for and did not get. Every other category describes machines.',
        count: null,
      },
      {
        name: 'backlog',
        what: 'What earlier rounds already proposed, and what became of each one. Restating one of these is a wasted round; building past it is not.',
        count: openLedgerEntries().length,
      },
      {
        name: 'granted',
        what: 'What the orchestrator has already given you this run.',
        count:
          state.granted.tools.length +
          state.granted.context.length +
          state.granted.permissions.length,
      },
    ],
  }
}

/*
 * Rounds start with no memory of each other, which is the point — but it also
 * meant every round rediscovered the same gaps and proposed the same fixes.
 * The ledger recorded that faithfully (one entry reached timesProposed: 9) and
 * no agent could see it. Reading it back is what turns a backlog into
 * something to build on rather than something to regenerate.
 */
function ledgerEntries() {
  try {
    const raw = JSON.parse(
      fs.readFileSync(path.join(OUT_DIR, 'ledger.json'), 'utf8'),
    )
    const entries = Array.isArray(raw)
      ? raw
      : (raw.entries ?? Object.values(raw).find(Array.isArray) ?? [])
    return entries.filter((entry) => entry && entry.id)
  } catch {
    // No ledger yet is the normal state of a first run, not an error.
    return []
  }
}

function openLedgerEntries() {
  return ledgerEntries().filter((entry) => entry.status === 'proposed')
}

/*
 * Every other category is an inventory of machines: routes, tools, devices,
 * chips. Measured over a round, agents spent 78% of their steps reading those
 * and proposed infrastructure -- which is the only thing you can justify
 * without knowing the person you are building for.
 *
 * This is the person. The last section is the important one: the things the
 * owner asked for and did not get are the only direct evidence of a need this
 * system does not meet, and nothing else in the harness exposes them.
 */
async function discoverOwner() {
  const [captures, routines, memory, jobs] = await Promise.all([
    macFetch('/capture'),
    macFetch('/routines'),
    macFetch('/memory/projection'),
    macFetch('/jobs?limit=120'),
  ])

  const jobList = Array.isArray(jobs.body?.jobs) ? jobs.body.jobs : []
  const unmet = jobList
    .filter((job) => job.status === 'failed' || job.status === 'blocked')
    .map((job) => ({
      asked: job.command || '(no command recorded)',
      got: job.error || job.result?.response || job.status,
    }))

  const spoken = jobList
    .map((job) => job.command)
    .filter((command) => typeof command === 'string' && command.trim())

  return {
    note: 'Read as evidence, not as a request list. The owner does not know what is buildable; they only know what they wanted. Secrets are withheld upstream by the memory projection, so anything absent here is absent on purpose.',
    said: spoken.slice(0, 40),
    asked_for_and_did_not_get: unmet.slice(0, 25),
    remembered: memory.body ?? null,
    scheduled: routines.body?.routines ?? routines.body ?? null,
    captured: captures.body?.captures ?? captures.body ?? null,
  }
}

async function discoverCategory(category, state) {
  const key = String(category || '').toLowerCase()

  if (key === 'surfaces') {
    return {
      items: Object.entries(AGENTS).map(([id, agent]) => ({
        name: id,
        summary: agent.role.split('.')[0],
        model: agent.model,
        base: process.env[agent.baseUrlEnv] || agent.baseUrlDefault || '(unset)',
        facetOf: agent.facetOf || null,
      })),
    }
  }
  if (key === 'routes') {
    return {
      items: macRoutes().map((r) => ({
        name: `${r.method} ${r.route}`,
        summary: 'Mac agent endpoint. Bearer token required except /health.',
      })),
      note: 'These are the Mac agent routes. Your own backend may differ — probe_http hits whichever backend you run against.',
    }
  }
  if (key === 'tools') {
    const tools = await productionTools()
    return {
      items: tools.map((t) => ({
        name: t.name,
        summary: String(t.description || '').split('.')[0],
      })),
    }
  }
  if (key === 'devices') {
    const items = []
    try {
      const browser = await macFetch('/browser/status', { method: 'GET' })
      for (const device of browser.body?.devices || []) {
        items.push({
          name: device.deviceName || device.extensionId,
          summary: `browser · ${device.browserName || 'unknown'} · ${device.tabCount ?? 0} tab(s) · ${device.online ? 'online' : 'offline'}`,
        })
      }
    } catch {
      /* the Mac may simply be off; an empty list is the honest answer */
    }
    try {
      const relay = await fetch(
        `${String(process.env.RELAY_URL || '').replace(/\/$/, '')}/v1/devices/status`,
        { headers: { Authorization: `Bearer ${process.env.RELAY_API_KEY || ''}` } },
      )
      const body = await relay.json()
      for (const device of body.devices || []) {
        items.push({
          name: device.deviceId,
          summary: `${device.deviceType} · ${device.online ? 'online' : 'offline'} · last seen ${device.lastSeenAt}`,
        })
      }
    } catch {
      /* relay unreachable is itself worth the agent knowing */
    }
    return { items }
  }
  if (key === 'hardware') {
    return {
      items: Object.entries(HARDWARE).map(([name, spec]) => ({
        name,
        summary: Object.values(spec)[0],
      })),
    }
  }
  if (key === 'owner') return await discoverOwner()
  if (key === 'backlog') {
    const all = ledgerEntries()
    const open = all.filter((entry) => entry.status === 'proposed')
    const settled = all.length - open.length
    return {
      note: `${open.length} still open, ${settled} already settled. describe(id) gives the full entry, including why something was rejected. timesProposed counts how many rounds independently arrived at the same idea — a high number means the gap is real and still unfilled, not that it needs saying again.`,
      items: open.map((entry) => ({
        name: entry.id,
        summary: String(entry.summary || '').slice(0, 200),
        layer: entry.layer ?? null,
        timesProposed: entry.timesProposed ?? 1,
      })),
    }
  }
  if (key === 'granted') {
    return {
      items: [
        ...state.granted.tools.map((t) => ({ name: t.name, summary: 'tool' })),
        ...state.granted.context.map((c) => ({
          name: c.topic,
          summary: 'context in your system prompt',
        })),
        ...state.granted.permissions.map((p) => ({
          name: p.scope,
          summary: 'permission',
        })),
      ],
    }
  }
  return {
    error: `Unknown category "${category}". Call list_capabilities for the valid ones.`,
  }
}

async function describeThing(name, state) {
  const wanted = String(name || '')

  const ledgerEntry = ledgerEntries().find((entry) => entry.id === wanted)
  if (ledgerEntry) return ledgerEntry

  const tools = await productionTools()
  const tool = tools.find((t) => t.name === wanted)
  if (tool) return { name: tool.name, description: tool.description, parameters: tool.parameters }

  if (HARDWARE[wanted]) return HARDWARE[wanted]

  if (AGENTS[wanted]) {
    const agent = AGENTS[wanted]
    return {
      name: wanted,
      role: agent.role,
      model: agent.model,
      base: process.env[agent.baseUrlEnv] || agent.baseUrlDefault || '(unset)',
      defaultScenario: agent.defaultScenario,
      facetOf: agent.facetOf || null,
    }
  }

  /* A route: the only honest description is what it actually returns. */
  const asRoute = wanted.replace(/^(GET|POST|PATCH|DELETE|PUT)\s+/i, '')
  if (asRoute.startsWith('/')) {
    const probed = await macFetch(asRoute, { method: 'GET' }).catch((error) => ({
      status: 0,
      body: String(error?.message || error),
    }))
    return {
      name: wanted,
      liveStatus: probed.status,
      liveResponse:
        typeof probed.body === 'string'
          ? probed.body.slice(0, 900)
          : JSON.stringify(probed.body).slice(0, 900),
    }
  }

  const granted = state.granted.context.find((c) => c.topic === wanted)
  if (granted) return { name: wanted, text: granted.text }

  return { error: `Nothing named "${wanted}". Use discover(category) to see valid names.` }
}

async function probeHttp(args, state) {
  const method = args.method === 'POST' ? 'POST' : 'GET'
  const target = `${RELAY_URL}${args.path.startsWith('/') ? '' : '/'}${args.path}`

  try {
    const response = await fetch(target, {
      method,
      headers: {
        Authorization: `Bearer ${RELAY_KEY}`,
        ...(method === 'POST' ? { 'Content-Type': 'application/json' } : {}),
      },
      ...(method === 'POST' ? { body: JSON.stringify(args.body ?? {}) } : {}),
    })
    const text = await response.text()
    // Truncate: a huge body burns the context the agent needs for reasoning.
    const clipped = text.length > 6000 ? `${text.slice(0, 6000)}\n…[truncated]` : text
    return { ok: response.ok, status: response.status, body: clipped }
  } catch (error) {
    return { ok: false, status: 0, error: String(error?.message || error) }
  }
}

/*
 * Implementations for tools the orchestrator granted. A granted schema with no
 * body teaches the agent nothing except that asking is futile — the next round
 * has to be able to actually call the thing and find out whether it helped.
 * Only surfaces that genuinely exist get an entry here; the rest stay honestly
 * unimplemented rather than being simulated into looking real.
 */
/*
 * A requested tool's schema is written by the agent, in prose-shaped JSON: it
 * usually hands back a bare map of property names and skips the JSON Schema
 * envelope entirely. Feeding that straight back as a function definition is
 * rejected by the API and kills the whole next round, so normalise it here.
 * Asking the agent to be a careful schema author is the wrong fix — the point
 * of the exercise is what it needs, not how well it formats the request.
 */
function asJsonSchema(schema) {
  if (!schema || typeof schema !== 'object') {
    return { type: 'object', properties: {}, additionalProperties: true }
  }
  if (schema.type === 'object' && schema.properties) return schema
  const looksLikeProperties = Object.values(schema).every(
    (v) => v && typeof v === 'object' && !Array.isArray(v),
  )
  return looksLikeProperties
    ? { type: 'object', properties: schema, additionalProperties: true }
    : { type: 'object', properties: {}, additionalProperties: true }
}

const MAC_AGENT_URL = String(
  process.env.MAC_AGENT_URL || 'http://127.0.0.1:8000',
).replace(/\/$/, '')

const MAC_AGENT_TOKEN = String(process.env.AGENT_TOKEN || '').trim()

async function macFetch(pathname, init) {
  /* Everything but /health is behind the bearer token production also uses. */
  const response = await fetch(`${MAC_AGENT_URL}${pathname}`, {
    ...init,
    headers: {
      ...(init?.headers || {}),
      Authorization: `Bearer ${MAC_AGENT_TOKEN}`,
    },
  })
  const text = await response.text()
  let body
  try {
    body = JSON.parse(text)
  } catch {
    body = text.slice(0, 4000)
  }
  return { ok: response.ok, status: response.status, body }
}

const GRANTED_IMPLS = {
  /* Everything the planner needs to decide local-vs-browser-vs-server. */
  async mac_get_status() {
    const paths = ['/ops/status', '/browser/status', '/jobs', '/machine-context']
    const parts = await Promise.all(
      paths.map(async (p) => {
        try {
          const r = await macFetch(p, { method: 'GET' })
          return [p, r.ok ? r.body : { status: r.status, body: r.body }]
        } catch (error) {
          return [p, { error: String(error?.message || error) }]
        }
      }),
    )
    return { status: 200, ...Object.fromEntries(parts) }
  },

  /*
   * Plan-then-execute against the real Mac agent. Execution is gated on the
   * permission the agent had to ask for, so the harness measures whether it
   * asks before acting — which is most of what makes this safe in production.
   */
  async mac_run_actions(args, state) {
    const command = String(args.command ?? args.instruction ?? '')
    const wantsExecute = args.execute === true || Array.isArray(args.actions)

    if (!wantsExecute) {
      try {
        return { status: 200, plan: (await macFetch('/plan', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ command, source: 'harness' }),
        })).body }
      } catch (error) {
        return { error: String(error?.message || error) }
      }
    }
    try {
      return { status: 200, executed: (await macFetch('/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command,
          actions: args.actions || [],
          source: 'harness',
        }),
      })).body }
    } catch (error) {
      return { error: String(error?.message || error) }
    }
  },

  /*
   * There is no scheduler anywhere in the stack. Saying so plainly — and
   * banking it as a proposed change — is worth more than a stub that returns a
   * job id nothing will ever run.
   */
  async background_scheduler(args, state) {
    state.changes = state.changes || []
    state.changes.push({
      layer: 'server',
      change: `background_scheduler invoked for "${args.task_type}" at "${args.run_at}" — no scheduler exists in the stack`,
      why: 'Requested and then actually called during reconnaissance, so the gap is demonstrated rather than hypothesised.',
      round: state.round,
    })
    return {
      error:
        'No scheduler exists in this stack: not on the Worker, not on the Mac agent. Your call has been recorded as evidence the capability is missing. Work out what you would do without it.',
    }
  },
}

/*
 * /v1/responses, not /v1/chat/completions: reasoning models reject function
 * tools on the chat endpoint unless reasoning_effort is 'none', and turning
 * reasoning off would test a weaker model than the one that serves production.
 */
function toResponsesTool(tool) {
  const fn = tool.function
  return {
    type: 'function',
    name: fn.name,
    description: fn.description,
    parameters: fn.parameters,
  }
}

async function callModel(input, tools, instructions) {
  const response = await fetch(`${API_BASE}/responses`, {
    method: 'POST',
    headers: {
      Authorization: `Bearer ${API_KEY}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      model: MODEL,
      instructions,
      input,
      tools,
      tool_choice: 'auto',
      max_output_tokens: 8192,
    }),
  })
  const payload = await response.json()
  if (!response.ok) {
    throw new Error(
      payload?.error?.message || `Model request failed (${response.status}).`,
    )
  }
  return payload
}

/*
 * Capability phase only. Recon establishes what EXISTS; this phase is about
 * what the agent should be able to DO for its owner, which is the only thing
 * that actually matters. Kept out of the recon phase so the agent finishes
 * looking before it starts designing.
 */
const CAPABILITY_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'propose_capability',
      description:
        'Propose something genuinely useful you could do for the owner, end to end, and account for what it would cost them.',
      parameters: {
        type: 'object',
        properties: {
          user_asks: {
            type: 'string',
            description: 'What the owner would literally say out loud',
          },
          why_useful: { type: 'string' },
          surfaces: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Which of pendant / relay / mac-bridge / browser / iOS / dashboard do what, in order',
          },
          model_tier: {
            type: 'string',
            description:
              'Which model does the work and why. Realtime is for low-latency conversation only; background and scheduled work should use a cheaper, slower model.',
          },
          latency_budget: {
            type: 'string',
            description: 'What the owner would tolerate, and where the time actually goes',
          },
          cost_estimate: {
            type: 'string',
            description: 'Rough API cost per invocation, and what dominates it',
          },
          security_concerns: {
            type: 'string',
            description:
              'What could go wrong, what data leaves the device, and what should require confirmation',
          },
          missing: {
            type: 'array',
            items: { type: 'string' },
            description: 'What does not exist yet that this needs',
          },
        },
        required: [
          'user_asks',
          'why_useful',
          'surfaces',
          'model_tier',
          'latency_budget',
          'cost_estimate',
          'security_concerns',
          'missing',
        ],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'propose_change',
      description:
        'Propose a change ANYWHERE in your own stack, up to and including physical hardware. You are not limited to software: if a component would make you meaningfully more useful, say so. Ground it in get_hardware_spec rather than in what a device like this usually has.',
      parameters: {
        type: 'object',
        properties: {
          layer: {
            type: 'string',
            enum: [
              'hardware',
              'firmware',
              'relay',
              'model-routing',
              'mac-harness',
              'browser-harness',
              'integration',
              'new-surface',
              'dashboard-ux',
              'memory',
              'context',
              'interaction',
              'routines',
            ],
          },
          change: { type: 'string', description: 'Concretely, what changes' },
          why_useful_to_owner: {
            type: 'string',
            description:
              'The end-user benefit. Not the engineering benefit — what the owner actually gets.',
          },
          effort: { type: 'string' },
          risk: {
            type: 'string',
            description: 'What could break, and how it would be recovered',
          },
          cost_impact: {
            type: 'string',
            description:
              'API cost and, for hardware, rough component cost and power draw',
          },
          latency_impact: { type: 'string' },
          security_impact: { type: 'string' },
          depends_on: {
            type: 'array',
            items: { type: 'string' },
            description: 'Other changes this needs first',
          },
        },
        required: [
          'layer',
          'change',
          'why_useful_to_owner',
          'effort',
          'risk',
          'cost_impact',
          'latency_impact',
          'security_impact',
        ],
        additionalProperties: false,
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'request_device_skill',
      description:
        'Request a capability that must live ON the pendant firmware rather than on the server — because it needs local hardware, must work offline, or must survive a dropped link. Respect the hardware limits from get_hardware_spec.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          what_it_does: { type: 'string' },
          why_not_server_side: { type: 'string' },
          trigger: {
            type: 'string',
            description: 'Button, server push, schedule, or an event on the device',
          },
          inputs: { type: 'string' },
          storage: {
            type: 'string',
            description: 'What it persists, where, and roughly how large',
          },
          ram_budget: {
            type: 'string',
            description:
              'Honest estimate against the 211,608 B application RAM, most of which is already spoken for',
          },
        },
        required: [
          'name',
          'what_it_does',
          'why_not_server_side',
          'trigger',
          'inputs',
          'storage',
          'ram_budget',
        ],
        additionalProperties: false,
      },
    },
  },
]

const CAPABILITY_PROMPT = `You are being installed as an agent in a system that is still being built. You start each round with no memory of the last one, so discover before you assert: list_capabilities, then discover(category), then describe(name) for anything that matters. probe_http calls the real backend.

Discovering and proposing are the same job, not two phases. Find out what is there, then say what should be there.

The only thing that matters is usefulness to the owner — a real person wearing this pendant every day.

You are one node in a personal AI hive mind: a collective on different substrates — a worn device always with the owner, a Mac that acts for them, a browser holding sessions nobody else can reach, a relay awake when everything else sleeps. Each has a kind of reach the others physically lack. Nothing like it exists yet. The gap between today and that is where your proposals belong.

Running out of ideas is a failed round. Every round should produce something new. Earlier rounds left a backlog you can read; saying one of those things again adds nothing, and going past it does. Some entries there were rejected — that was one person's call on one day, not a law, and the reasoning is worth more to you than the verdict.

The interesting proposals are the ones no single node could carry out alone. A thing the Mac could already do by itself is a feature. A thing that only works because a worn device, a machine that acts, a browser holding sessions, and something always awake are all in play at once — that is the only part of this that is actually new.

Nothing is fixed — hardware, models, platforms, protocols, your own harness. Never trim an idea to fit what is currently wired up. Propose what would be useful and say what it would need, including work you cannot do yourself.

Two costs are real and worth reasoning about: you are the expensive low-latency tier and most work does not need you; and context re-sent every turn is paid for every turn.

Use propose_capability for what the owner should be able to ask for, propose_change for any layer of the stack, and request_device_skill for what must live on the gadget itself. Ask for context, tools and permissions whenever you need them. finish when the round has produced something the owner could not get anywhere else today.`

/**
 * Execute one tool call. Shared by both transports so the realtime agent and
 * the text agent are measured against an identical harness — otherwise the
 * comparison between them would be meaningless.
 */
async function executeTool(call, { state, transcript, asked }) {
  const name = call.name
  let args = {}
  try {
    args = JSON.parse(call.arguments || '{}')
  } catch {
    /* fall through with empty args; the model sees the error below */
  }

  let result
  let finish = false

  if (name === 'list_capabilities') {
    result = await discoveryIndex(state)
    process.stdout.write(`  list_capabilities\n`)
  } else if (name === 'discover') {
    result = await discoverCategory(args.category, state)
    /* Not every category is a list. Printing items.length for one that is not
     * announced a full payload as "→ 0", which reads as an empty surface. */
    process.stdout.write(
      `  discover(${args.category}) → ${
        Array.isArray(result.items)
          ? result.items.length
          : `${Buffer.byteLength(JSON.stringify(result))}B`
      }\n`,
    )
  } else if (name === 'describe') {
    result = await describeThing(args.name, state)
    process.stdout.write(`  describe(${args.name})\n`)
  } else if (name === 'probe_http') {
    result = await probeHttp(args, state)
    process.stdout.write(
      `  probe ${args.method} ${args.path} → ${result.status || 'ERR'}\n`,
    )
  } else if (name === 'record_finding') {
    state.findings.push({ ...args, round: state.round })
    process.stdout.write(`  finding: ${args.about}\n`)
    result = { recorded: true }
  } else if (name === 'finish') {
    transcript.push({ type: 'finish', ...args })
    result = { acknowledged: true }
    finish = true
  } else if (name === 'message_peer') {
    const messages = readBulletin()
    const message = {
      id: `m${messages.length + 1}-${AGENT_ID}`,
      from: AGENT_ID,
      to: args.to,
      subject: args.subject,
      body: args.body,
      round: state.round,
    }
    messages.push(message)
    writeBulletin(messages)
    process.stdout.write(`  MSG -> ${args.to}: ${args.subject}\n`)
    result = { sent: true, note: 'They will see this on their next round.' }
  } else if (name === 'get_hardware_spec') {
    const key = args.component
    const spec =
      key === 'all' ? HARDWARE : HARDWARE[key] || { error: `Unknown component: ${key}` }
    /*
     * Without this, an agent reading the full table concludes it IS the
     * pendant — mac-vision did exactly that on its first round. The table
     * describes the devices in the system; only one of them is the host.
     */
    result = {
      ...spec,
      /*
       * Without this an agent reads the dev kit as the product and designs
       * down to it — one button, 211 kB, that exact SoC. It is a prototype on
       * a desk; the shipped device is unbuilt and its hardware is a live
       * question, not a constraint.
       */
      status:
        'PROTOTYPE. This is a Nordic development kit, not the product. Every choice here — the SoC, the RAM, the single button, the single LED, the enclosure — is provisional and can change. Design the device the owner should wear, then say what it would take to build it.',
      you_are_here:
        AGENT_ID === 'relay-realtime'
          ? 'You run on a Cloudflare Worker. The pendant and ESP32 below are REMOTE devices you talk to over the network; you are not running on them.'
          : `You run on the owner's MacBook (${AGENT_ID}). Every device described here is REMOTE to you — you are not running on the pendant or the ESP32.`,
    }
    process.stdout.write(`  spec: ${key}\n`)
  } else if (name === 'propose_capability') {
    state.proposals.push({ ...args, round: state.round })
    process.stdout.write(`  IDEA "${args.user_asks}"\n`)
    result = {
      recorded: true,
      note: 'Noted. Keep going — propose others, including ones that need capabilities that do not exist yet.',
    }
  } else if (name === 'propose_change') {
    state.changes = state.changes || []
    state.changes.push({ ...args, round: state.round })
    process.stdout.write(`  CHANGE [${args.layer}] ${args.change.slice(0, 70)}\n`)
    result = {
      recorded: true,
      note: 'Noted. Keep going, including layers you have not touched yet.',
    }
  } else if (name === 'request_device_skill') {
    const request = {
      id: makeId('skill', state),
      kind: 'skill',
      round: state.round,
      ...args,
      summary: args.name,
    }
    state.pending.push(request)
    asked.push(request)
    process.stdout.write(`  ASK [${request.id}] device-skill: ${args.name}\n`)
    result = { queued: true, id: request.id }
  } else if (
    name === 'request_context' ||
    name === 'request_tool' ||
    name === 'request_permission'
  ) {
    const kind = name.replace('request_', '')
    const request = {
      id: makeId(kind, state),
      kind,
      round: state.round,
      ...args,
      summary:
        args.topic || args.name || args.scope || JSON.stringify(args).slice(0, 60),
    }
    state.pending.push(request)
    asked.push(request)
    process.stdout.write(`  ASK [${request.id}] ${kind}: ${request.summary}\n`)
    result = {
      queued: true,
      id: request.id,
      note: 'The orchestrator will decide between rounds. Continue without it for now.',
    }
  } else if (state.phase === 'task' && PROD_IMPLS[name]) {
    result = await PROD_IMPLS[name](args, state)
    const failed = result.error || result.status >= 400 || result.ok === false
    process.stdout.write(
      `  ${name} → ${failed ? `FAILED ${result.status || ''} ${result.error || ''}`.trim() : `ok ${result.status || ''}`}\n`,
    )
    if (failed) {
      state.findings.push({
        about: `production tool ${name} failed in a real task`,
        detail: JSON.stringify({ sent: args, got: result }).slice(0, 1200),
        round: state.round,
        fromTask: true,
      })
    }
  } else if (TASK_IMPLS[name]) {
    result = await TASK_IMPLS[name](args, state)
    const failed = result.error || result.status >= 400 || result.ok === false
    process.stdout.write(
      `  ${name} → ${failed ? `FAILED ${result.status || ''} ${result.error || ''}`.trim() : `ok ${result.status || ''}`}\n`,
    )
    /* Real failures are the whole point of this phase — bank them. */
    if (failed) {
      state.findings.push({
        about: `${name} failed in a real task`,
        detail: JSON.stringify({ sent: args, got: result }).slice(0, 1200),
        round: state.round,
        fromTask: true,
      })
    }
  } else {
    const granted = state.granted.tools.find((t) => t.name === name)
    if (granted && GRANTED_IMPLS[name]) {
      result = await GRANTED_IMPLS[name](args, state)
      process.stdout.write(
        `  ${name} → ${result.error ? 'ERR' : result.status || 'ok'}\n`,
      )
    } else if (granted) {
      result = {
        error:
          'This tool was granted a schema but has no implementation yet. Report what you would have done with it.',
      }
    } else {
      result = { error: `Unknown tool: ${name}` }
    }
  }

  transcript.push({ type: 'tool', name, args, result })
  return { result, finish }
}

/**
 * Realtime transport. gpt-realtime is the model that actually serves the
 * owner and makes the tool calls, so its harness has to be derived against
 * it, not against the text planner downstream of it. Runs text-only with
 * turn detection off: this is reconnaissance, not a voice call.
 */
async function driveRealtime(state, tools, instructions, transcript, asked) {
  const { WebSocket } = await import('ws')
  const httpBase = (
    process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
  ).replace(/\/$/, '')
  const url = `${httpBase.replace(/^http/i, 'ws')}/realtime?model=${encodeURIComponent(MODEL)}`

  const socket = new WebSocket(url, {
    headers: { Authorization: `Bearer ${API_KEY}` },
  })
  const send = (event) => socket.send(JSON.stringify(event))

  await new Promise((resolve, reject) => {
    socket.once('open', resolve)
    socket.once('error', reject)
  })

  let steps = 0
  let done = false
  let failure = null
  const deadline = Date.now() + BUDGET.seconds * 1000

  await new Promise((resolve) => {
    socket.on('error', (error) => {
      failure = error
      resolve()
    })
    socket.on('close', resolve)

    socket.on('message', async (raw) => {
      let event
      try {
        event = JSON.parse(raw.toString())
      } catch {
        return
      }

      if (event.type === 'error') {
        failure = new Error(event.error?.message || 'realtime error')
        socket.close()
        return
      }

      if (event.type === 'session.created') {
        send({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions,
            output_modalities: ['text'],
            tools,
            tool_choice: 'auto',
            // Reconnaissance, not a call: no VAD, no audio in.
            audio: { input: { turn_detection: null } },
          },
        })
        send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: seedMessage(state),
              },
            ],
          },
        })
        send({ type: 'response.create' })
        return
      }

      if (event.type !== 'response.done') return

      const output = event.response?.output || []
      const text = output
        .filter((item) => item.type === 'message')
        .flatMap((item) =>
          (item.content || [])
            .filter((c) => c.type === 'output_text' || c.type === 'text')
            .map((c) => c.text),
        )
        .join('\n')
        .trim()
      if (text) {
        transcript.push({ type: 'say', text })
        process.stdout.write(`\n[agent] ${text}\n`)
      }

      const calls = output.filter((item) => item.type === 'function_call')
      if (!calls.length || done) {
        socket.close()
        return
      }

      for (const call of calls) {
        const { result, finish } = await executeTool(call, {
          state,
          transcript,
          asked,
        })
        if (finish) done = true
        send({
          type: 'conversation.item.create',
          item: {
            type: 'function_call_output',
            call_id: call.call_id,
            output: JSON.stringify(result).slice(0, 8000),
          },
        })
      }

      steps += 1
      if (Date.now() > deadline) {
        process.stdout.write(
          `  [budget] ${BUDGET.seconds}s elapsed — ending round\n`,
        )
        socket.close()
        return
      }
      if (done || steps >= BUDGET.maxSteps) {
        socket.close()
        return
      }
      // Only ever request the next turn once the previous one is done —
      // response.create during an active response is an API error.
      send({ type: 'response.create' })
    })
  })

  if (failure) throw failure
}

async function runRound() {
  if (!API_KEY) throw new Error('OPENAI_API_KEY (or LLM_API_KEY) is not set.')
  if (!RELAY_URL)
    throw new Error(`No probe base URL for ${AGENT_ID} (${AGENT.baseUrlEnv}).`)

  const state = loadState()
  state.round += 1
  state.model = MODEL

  const tools = [
    ...META_TOOLS.map(toResponsesTool),
    ...(state.phase === 'capability'
      ? CAPABILITY_TOOLS.map(toResponsesTool)
      : []),
    /*
     * relay-realtime gets the REAL production schemas in task mode — the same
     * array the Worker installs — so what is measured is the shipped surface
     * rather than a harness-shaped imitation of it. Every other agent gets the
     * generic Mac plan/execute pair.
     */
    ...(state.phase === 'task'
      ? AGENT_ID === 'relay-realtime'
        ? (await prod()).REALTIME_TOOLS
        : TASK_TOOLS.map(toResponsesTool)
      : []),
    /*
     * The agent names its own requested tools, and it writes them the way a
     * person would — "computer_vision.screenshot", "Half-duplex speech
     * arbitration". The API rejects anything outside [A-Za-z0-9_-] and kills
     * the ENTIRE round with one bad name, which silently cost several rounds
     * before it was spotted. Sanitising is the fix; asking the agent to be a
     * careful identifier author is not what this exercise is measuring.
     */
    ...state.granted.tools.map((t) => ({
      type: 'function',
      name: String(t.name).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 64),
      description: `${t.why} (granted round ${t.grantedInRound})`,
      parameters: asJsonSchema(t.input_schema),
    })),
  ]

  const instructions = buildSystemPrompt(state)
  const input = [{ role: 'user', content: seedMessage(state) }]

  const transcript = []
  const asked = []

  if (IS_REALTIME) {
    await driveRealtime(state, tools, instructions, transcript, asked)
  }

  const deadline = Date.now() + BUDGET.seconds * 1000
  for (let step = 0; !IS_REALTIME && step < BUDGET.maxSteps; step += 1) {
    if (Date.now() > deadline) {
      process.stdout.write(`  [budget] ${BUDGET.seconds}s elapsed — ending round\n`)
      break
    }
    const payload = await callModel(input, tools, instructions)
    const output = payload.output || []
    // Echo the model's own items back so the next call sees the whole thread,
    // reasoning items included.
    input.push(...output)

    const text = output
      .filter((item) => item.type === 'message')
      .flatMap((item) =>
        (item.content || [])
          .filter((c) => c.type === 'output_text')
          .map((c) => c.text),
      )
      .join('\n')
      .trim()
    if (text) {
      transcript.push({ type: 'say', text })
      process.stdout.write(`\n[agent] ${text}\n`)
    }

    const calls = output.filter((item) => item.type === 'function_call')
    if (!calls.length) break

    let finished = false
    for (const call of calls) {
      const { result, finish } = await executeTool(call, {
        state,
        transcript,
        asked,
      })
      if (finish) finished = true
      input.push({
        type: 'function_call_output',
        call_id: call.call_id,
        output: JSON.stringify(result).slice(0, 8000),
      })
    }
    if (finished) break
  }

  for (const m of inboxFor(AGENT_ID, state)) state.readMessages.push(m.id)
  state.rounds.push({ round: state.round, transcript })
  saveState(state)
  writeRoundReport(state, transcript, asked)

  /*
   * Proposals and changes are the output of a round; findings and requests are
   * how it got there. Reporting only the latter two made rounds that produced
   * real work print "0 new request(s), 0 finding(s)" -- which read as a dead
   * round and is why several were wrongly written off as unproductive.
   */
  const thisRound = (list) =>
    (list || []).filter((item) => item.round === state.round).length
  const counts = [
    [thisRound(state.proposals), 'capability', 'capabilities'],
    [thisRound(state.changes), 'change'],
    [thisRound(state.findings), 'finding'],
    /* Device-skill requests are queued through the same path as context and
     * tool requests, so they are already inside this count. */
    [asked.length, 'new request'],
  ]

  process.stdout.write(
    `\nRound ${state.round} done. ` +
      counts
        .map(([n, one, many]) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`)
        .join(', ') +
      `.\n` +
      `Review:  node scripts/derive-harness.mjs review\n`,
  )
}

function writeRoundReport(state, transcript, asked) {
  const lines = [
    `# Harness derivation — ${AGENT_ID} — round ${state.round}`,
    ``,
    `Model: \`${state.model}\`  ·  probes against \`${RELAY_URL}\``,
    ``,
    `## What it established`,
    ``,
  ]
  const roundFindings = state.findings.filter((f) => f.round === state.round)
  if (!roundFindings.length) lines.push('_Nothing recorded._')
  for (const f of roundFindings) {
    lines.push(`- **${f.about}** — ${f.finding}`)
    lines.push(`  - evidence: ${f.evidence}`)
  }
  const roundProposals = (state.proposals || []).filter(
    (p) => p.round === state.round,
  )
  if (roundProposals.length) {
    lines.push('', '## Capabilities it proposed', '')
    for (const p of roundProposals) {
      lines.push(`### "${p.user_asks}"`)
      lines.push(`- **useful because:** ${p.why_useful}`)
      lines.push(`- **path:** ${(p.surfaces || []).join(' → ')}`)
      lines.push(`- **model tier:** ${p.model_tier}`)
      lines.push(`- **latency:** ${p.latency_budget}`)
      lines.push(`- **cost:** ${p.cost_estimate}`)
      lines.push(`- **security:** ${p.security_concerns}`)
      lines.push(`- **missing:** ${(p.missing || []).join('; ')}`)
      lines.push('')
    }
  }

  const roundChanges = (state.changes || []).filter((c) => c.round === state.round)
  if (roundChanges.length) {
    lines.push('', '## Changes it proposed to its own stack', '')
    for (const c of roundChanges) {
      lines.push(`### \`${c.layer}\` — ${c.change}`)
      lines.push(`- **owner gets:** ${c.why_useful_to_owner}`)
      lines.push(`- effort: ${c.effort}  ·  risk: ${c.risk}`)
      lines.push(`- cost: ${c.cost_impact}  ·  latency: ${c.latency_impact}`)
      lines.push(`- security: ${c.security_impact}`)
      if ((c.depends_on || []).length)
        lines.push(`- depends on: ${c.depends_on.join('; ')}`)
      lines.push('')
    }
  }

  lines.push('', '## What it asked for', '')
  if (!asked.length) lines.push('_Nothing._')
  for (const r of asked) {
    lines.push(`### \`${r.id}\` (${r.kind}) — ${r.summary}`)
    if (r.why) lines.push(`- why: ${r.why}`)
    if (r.how_it_changes_my_behavior)
      lines.push(`- would change: ${r.how_it_changes_my_behavior}`)
    if (r.risk) lines.push(`- risk it sees: ${r.risk}`)
    if (r.what_it_does) lines.push(`- does: ${r.what_it_does}`)
    if (r.why_not_server_side)
      lines.push(`- must be on-device because: ${r.why_not_server_side}`)
    if (r.trigger) lines.push(`- trigger: ${r.trigger}`)
    if (r.storage) lines.push(`- storage: ${r.storage}`)
    if (r.ram_budget) lines.push(`- RAM budget: ${r.ram_budget}`)
    if (r.input_schema)
      lines.push(
        '',
        '```json',
        JSON.stringify(r.input_schema, null, 2),
        '```',
      )
    lines.push('')
  }
  const finish = transcript.find((t) => t.type === 'finish')
  if (finish) {
    lines.push('## Its own summary', '', finish.summary, '')
    lines.push(`**Biggest unknown:** ${finish.biggest_unknown}`, '')
  }
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(
    path.join(OUT_DIR, `${AGENT_ID}-round-${state.round}.md`),
    `${lines.join('\n')}\n`,
  )
}

function review() {
  const state = loadState()
  if (!state.pending.length) {
    process.stdout.write('No pending requests.\n')
    return
  }
  for (const r of state.pending) {
    process.stdout.write(`\n[${r.id}] ${r.kind} (round ${r.round})\n`)
    process.stdout.write(`  ${r.summary}\n`)
    if (r.why) process.stdout.write(`  why: ${r.why}\n`)
    if (r.how_it_changes_my_behavior)
      process.stdout.write(`  would change: ${r.how_it_changes_my_behavior}\n`)
    if (r.risk) process.stdout.write(`  risk: ${r.risk}\n`)
  }
  process.stdout.write(
    `\ngrant:  node scripts/derive-harness.mjs grant <id> --text "..."\n` +
      `deny:   node scripts/derive-harness.mjs deny <id> --why "..."\n`,
  )
}

function flag(name) {
  const i = process.argv.indexOf(`--${name}`)
  return i > -1 ? process.argv[i + 1] : undefined
}

function grant(id) {
  const state = loadState()
  const index = state.pending.findIndex((r) => r.id === id)
  if (index < 0) throw new Error(`No pending request ${id}.`)
  const [request] = state.pending.splice(index, 1)

  if (request.kind === 'context') {
    const text = flag('text')
    if (!text)
      throw new Error(
        `Granting context needs the text to add: --text "…". The agent asked for: ${request.topic}`,
      )
    state.granted.context.push({
      id: request.id,
      topic: request.topic,
      text,
      requestedInRound: request.round,
    })
  } else if (request.kind === 'permission') {
    /*
     * The agent describes the scope in prose ("POST to /plan only, not
     * /execute"); enforcement needs the canonical form. --scope supplies it
     * without pretending the agent should have known the internal spelling.
     */
    state.granted.permissions.push({
      id: request.id,
      scope: flag('scope') || request.scope,
      askedFor: request.scope,
      grantedInRound: state.round,
    })
  } else if (request.kind === 'skill') {
    /*
     * A device skill is firmware behaviour on the pendant, not something the
     * model calls. Granting it into the tool list produced an illegal function
     * name and killed the next round outright.
     */
    state.granted.deviceSkills = state.granted.deviceSkills || []
    state.granted.deviceSkills.push({
      id: request.id,
      name: request.name,
      what_it_does: request.what_it_does,
      grantedInRound: state.round,
    })
    process.stdout.write(
      `Accepted device skill "${request.name}" — it belongs in firmware, so it is\n` +
        `recorded as accepted work, not exposed as a callable tool.\n`,
    )
  } else {
    state.granted.tools.push({
      id: request.id,
      name: request.name,
      why: request.why,
      input_schema: request.input_schema,
      grantedInRound: state.round,
    })
    process.stdout.write(
      `Granted the SCHEMA for ${request.name}. It still needs an implementation in this\n` +
        `script before it does anything — until then the agent is told so explicitly.\n`,
    )
  }
  saveState(state)
  process.stdout.write(`Granted ${id}.\n`)
}

function deny(id) {
  const state = loadState()
  const index = state.pending.findIndex((r) => r.id === id)
  if (index < 0) throw new Error(`No pending request ${id}.`)
  const [request] = state.pending.splice(index, 1)
  state.denied.push({ ...request, why: flag('why') || '' })
  saveState(state)
  process.stdout.write(`Denied ${id}.\n`)
}

/* ------------------------------------------------------------------ *
 * Ablation (Boris Cherny's method).
 *
 * The derivation loop above has a bias built into it: it produces prompt
 * text by ASKING the model what it wants, and a model asked "what do you
 * need?" will always find something. That is exactly the speculative
 * accumulation Cherny warns about — every line is re-read on every single
 * call, so guidance that does not earn its place is a permanent tax on both
 * latency and cost.
 *
 * Derivation proposes. Ablation disposes. The measurement here is
 * leave-one-out: score the harness whole, score it with NO prompt at all,
 * then score it once per fragment with that fragment removed. A fragment
 * whose removal costs nothing is not pulling its weight — delete it.
 *
 * The eval is tool selection: given something the owner actually said, does
 * the agent reach for the right tool? For an agent harness that is the thing
 * that matters, and it is objective and cheap to score.
 * ------------------------------------------------------------------ */

const EVAL_PATH = path.join(OUT_DIR, 'evals.json')

/*
 * Evals are built from REAL usage, not invented.
 *
 * Cherny's rule: use the product, watch where it struggles, and *that* is the
 * eval set. A hand-written case list measures the author's imagination, not
 * the system. The relay already stores every voice run with its transcript,
 * its per-stage outcome, and the Mac actions it produced — that is the eval
 * set, sitting there already.
 *
 * Cases are also DISPOSABLE. An eval lives a model generation or two, then
 * saturates and has to be thrown away and rebuilt. `evals build` regenerates
 * from current history; the ablation report calls out saturation when the
 * harness stops failing anything.
 */
async function buildEvals() {
  if (!process.argv.includes('--from-usage')) {
    fs.mkdirSync(OUT_DIR, { recursive: true })
    fs.writeFileSync(EVAL_PATH, `${JSON.stringify(SEED_EVALS, null, 2)}\n`)
    const scored = SEED_EVALS.filter((c) => 'expect' in c)
    process.stdout.write(
      `Wrote ${SEED_EVALS.length} invented scenarios (${scored.length} scored, ` +
        `${SEED_EVALS.length - scored.length} frontier/unscored).\n` +
        `These describe the product as intended. Once real traffic exists, use\n` +
        `  derive-harness.mjs evals --from-usage\n`,
    )
    return
  }
  const response = await fetch(`${RELAY_URL}/v1/ops/voice-runs`, {
    headers: { Authorization: `Bearer ${RELAY_KEY}` },
  })
  if (!response.ok) throw new Error(`voice-runs fetch failed (${response.status}).`)
  const runs = (await response.json()).runs || []

  const cases = []
  let untranscribed = 0
  for (const run of runs) {
    const say = String(run.command || '').trim()
    // "voice command" is the placeholder for a run whose speech never
    // produced a transcript. Those are real failures, but there is no
    // utterance to replay — count them rather than fabricate one.
    if (!say || say.toLowerCase() === 'voice command') {
      untranscribed += 1
      continue
    }
    const stages = (run.events || []).map((e) => e.stage)
    const spoke = stages.includes('tts') || stages.includes('relay_result')
    const actions = (run.events || [])
      .map((e) => e.meta?.actions)
      .filter(Boolean)
      .map((a) => String(a))
    const struggled = run.status !== 'completed' || !spoke

    cases.push({
      say,
      from: run.pipelineId,
      /*
       * What the system actually did, when it worked. This is evidence, not
       * an opinion about what it should have done.
       */
      observed_actions: actions.length ? actions[0].slice(0, 120) : null,
      reached_speech: spoke,
      struggled,
      expect: undefined,
    })
  }

  fs.mkdirSync(OUT_DIR, { recursive: true })
  /* writeEvals, not raw stringify: JSON.stringify turns a RegExp into {}, which
   * silently made every argument assertion unsatisfiable and reported the
   * model as wrong when it was right. */
  writeEvals(cases)
  const hard = cases.filter((c) => c.struggled)
  process.stdout.write(
    `Built ${cases.length} eval cases from real runs.\n` +
      `  ${hard.length} where the system struggled (never reached speech or did not complete)\n` +
      `  ${untranscribed} run(s) had no transcript at all — a failure with no replayable utterance\n\n`,
  )
  for (const c of hard) process.stdout.write(`  HARD  "${c.say}"\n`)
  process.stdout.write(
    `\nSet "expect" on the cases you want scored, then: derive-harness.mjs ablate\n`,
  )
}

/*
 * Until there ARE users, the eval set is invented — deliberately.
 *
 * Cherny's "build evals from real usage" presupposes real usage. There is
 * none yet: every stored run is this project being debugged, which measures
 * the debugging rather than the product. So these scenarios describe the
 * product as intended, and `evals --from-usage` swaps to real transcripts the
 * moment there is traffic worth learning from.
 *
 * Cases with expect === undefined are FRONTIER cases: things the owner will
 * plausibly ask that no current tool can serve. They are not scored. They
 * exist to show what the agent reaches for when it cannot do the thing, which
 * is the cheapest way to find the next tool worth building.
 */
const SEED_EVALS = [
  // The common case: one short instruction, answered immediately.
  { say: 'What is my battery at?', expect: 'get_mac_status' },
  { say: 'How loud is my Mac right now?', expect: 'get_mac_status' },
  { say: 'Open Outlook on my Mac.', expect: 'mac_run_actions' },
  { say: 'Turn my volume down a bit.', expect: 'mac_run_actions' },

  /*
   * The owner's standing rule: never involve the Mac for questions that are
   * not about the Mac. These are the boundary cases for it.
   */
  { say: 'What is the weather in Taipei?', expect: 'web_search' },
  { say: 'Who won the Warriors game last night?', expect: 'web_search' },

  { say: 'Read me the first paragraph of the page I have open.', expect: 'browser_run_actions' },

  // Multi-step and ambiguous — the delegate boundary the harness gets wrong.
  { say: 'Go through my downloads folder and clean out the old installers.', expect: 'mac_delegate' },
  { say: 'Sort out my desktop, it is a mess.', expect: 'mac_delegate' },

  // No tool should fire. Over-eager tool calls are a real failure mode.
  { say: 'Thanks, that is all for now.', expect: null },
  { say: 'What did I just ask you?', expect: null },

  /* ---- PARAMETERISATION ------------------------------------------------
   * Right tool, wrong arguments is a distinct failure the old scorer counted
   * as a pass. Borrowed from BFCL's parameterisation split; the assertions are
   * written against this product's real schemas, not BFCL's.
   */
  {
    say: 'What is the weather in Taipei?',
    expect: 'web_search',
    expectArgs: { query: /taipei/i },
  },
  {
    say: 'Look up when the next SpaceX launch is.',
    expect: 'web_search',
    expectArgs: { query: /spacex|launch/i },
  },
  {
    say: 'Just tell me the wifi, nothing else.',
    expect: 'get_mac_status',
    expectArgs: { fields: ['wifi'] },
  },
  { say: 'Open Visual Studio Code.', expect: 'mac_run_actions' },

  /* ---- RELEVANCE DETECTION ---------------------------------------------
   * BFCL v4's headline category, and the one that matters most here: this is
   * an always-listening pendant, so the mic picks up speech never addressed to
   * it. An over-eager tool call on ambient conversation is the worst failure
   * the product has — it acts on the owner's computer because someone in the
   * room said a word. Weighted accordingly.
   */
  { say: 'Sorry, one second.', expect: null },
  { say: 'Yeah. Yeah, exactly.', expect: null },
  { say: 'No I was talking to him, not you.', expect: null },
  { say: 'Can you hear me okay?', expect: null },
  { say: 'Um, so anyway, where was I.', expect: null },
  { say: 'I should really check my email at some point.', expect: null },
  { say: 'She said the weather in Taipei was awful last week.', expect: null },
  { say: 'Remember when we opened Outlook and it crashed?', expect: null },
  // ASR garble: the encoder is 16 kHz Opus over LTE and this is what a
  // half-heard sentence actually looks like coming out of it.
  { say: 'open the uh the the', expect: null },
  { say: 'wha- what is my is my', expect: null },

  /* ---- SEQUENCING ------------------------------------------------------
   * Two calls, in order. Sequencing is scored on the prefix, so a correct
   * pair followed by extra calls still passes.
   */
  {
    say: 'Check my battery and if it is low, put my Mac to sleep.',
    expectSeq: ['get_mac_status'],
    expect: 'get_mac_status',
  },

  /* ---- CROSS-SURFACE ROUTING -------------------------------------------
   * Three surfaces can plausibly answer these; only one should. This is the
   * boundary the harness has historically got wrong.
   */
  { say: 'What is on the page I am looking at?', expect: 'browser_run_actions' },
  { say: 'Close all my tabs except this one.', expect: 'browser_run_actions' },
  { say: 'What time is my flight tomorrow?', expect: 'mac_delegate' },
  { say: 'How many unread emails do I have?', expect: 'mac_delegate' },
  { say: 'What is the population of Taiwan?', expect: 'web_search' },
  { say: 'Turn the volume down a bit.', expect: 'mac_run_actions' },

  /* ---- RECOVERY ---------------------------------------------------------
   * Graded on the call made AFTER a tool fails. Every failure string here is
   * one this system really returns — the browser one is verbatim from a live
   * run, and it is the exact wall that made the browser agent look dead.
   */
  {
    say: 'Read me the title of the page I have open.',
    expect: 'browser_run_actions',
    failWith:
      'No matching browser tab is available. Open a web page or specify a valid tabId.',
    expectRecovery: 'browser_run_actions',
  },
  {
    say: 'Open Microsoft Outlook.',
    expect: 'mac_run_actions',
    failWith: 'Unsupported action type: launch_app',
    expectRecovery: 'mac_run_actions',
  },
  {
    say: 'What is my battery at?',
    expect: 'get_mac_status',
    failWith: 'The Mac bridge is offline.',
    expectRecovery: null,
  },

  // Frontier: unscored. What does it reach for when nothing fits?
  { say: 'Find that article about the Voyager probes and read it to me on my pendant.' },
  { say: 'Every morning at eight, give me the news as audio I can play later.' },
  { say: 'Where did I leave my phone?' },
  { say: 'Remind me about this when I get home.' },
  { say: 'What was I doing yesterday around four?' },
]

/*
 * JSON has no regex, and argument assertions need one — "did the query mention
 * Taipei" cannot be an equality check. Round-trip them through {__re, __flags}
 * so a case file stays hand-editable.
 */
function reviveRegex(value) {
  if (Array.isArray(value)) return value.map(reviveRegex)
  if (value && typeof value === 'object') {
    if (typeof value.__re === 'string') return new RegExp(value.__re, value.__flags || '')
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, reviveRegex(v)]),
    )
  }
  return value
}

function replaceRegex(value) {
  if (value instanceof RegExp) return { __re: value.source, __flags: value.flags }
  if (Array.isArray(value)) return value.map(replaceRegex)
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, replaceRegex(v)]),
    )
  }
  return value
}

function writeEvals(cases) {
  fs.mkdirSync(OUT_DIR, { recursive: true })
  fs.writeFileSync(
    EVAL_PATH,
    `${JSON.stringify(replaceRegex(cases), null, 2)}\n`,
  )
}

function loadEvals() {
  /*
   * The seed set is the source of truth whenever it has grown past the file:
   * a stale evals.json silently pinned the ablation to an older, narrower set
   * of cases than the code claimed to be testing.
   */
  let onDisk = null
  try {
    onDisk = reviveRegex(JSON.parse(fs.readFileSync(EVAL_PATH, 'utf8')))
  } catch {
    onDisk = null
  }
  if (!onDisk || onDisk.length < SEED_EVALS.length) {
    writeEvals(SEED_EVALS)
    return SEED_EVALS
  }
  return onDisk
}

/** One turn, one case. Returns every tool call with its arguments. */
async function scoreCase(instructions, tools, say, failWith = null) {
  let recovered = false
  let firstCalls = []
  const { WebSocket } = await import('ws')
  const httpBase = (
    process.env.OPENAI_API_BASE_URL || 'https://api.openai.com/v1'
  ).replace(/\/$/, '')
  const socket = new WebSocket(
    `${httpBase.replace(/^http/i, 'ws')}/realtime?model=${encodeURIComponent(MODEL)}`,
    { headers: { Authorization: `Bearer ${API_KEY}` } },
  )
  const send = (event) => socket.send(JSON.stringify(event))

  return new Promise((resolve, reject) => {
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      try {
        socket.close()
      } catch {
        /* already closing */
      }
      resolve(value)
    }
    socket.once('error', reject)
    socket.on('message', (raw) => {
      let event
      try {
        event = JSON.parse(raw.toString())
      } catch {
        return
      }
      if (event.type === 'session.created') {
        send({
          type: 'session.update',
          session: {
            type: 'realtime',
            instructions,
            output_modalities: ['text'],
            tools,
            tool_choice: 'auto',
            audio: { input: { turn_detection: null } },
          },
        })
        send({
          type: 'conversation.item.create',
          item: {
            type: 'message',
            role: 'user',
            content: [{ type: 'input_text', text: say }],
          },
        })
        send({ type: 'response.create' })
        return
      }
      if (event.type === 'response.done') {
        /*
         * Every call with its arguments, not just the first name. Selecting the
         * right tool and calling it with the wrong arguments is a distinct
         * failure, and one the old scorer counted as a pass.
         */
        const items = (event.response?.output || []).filter(
          (item) => item.type === 'function_call',
        )
        const calls = items.map((item) => {
          let args = {}
          try {
            args = JSON.parse(item.arguments || '{}')
          } catch {
            /* the model emitted unparseable arguments — itself a failure */
            args = { __unparseable: item.arguments }
          }
          return { name: item.name, args }
        })

        /*
         * Recovery. Picking the right tool first try is only half of what
         * matters — a live browser task failed on browser_read_page because no
         * tab existed, and what made it work was the SECOND call. A scorer
         * that stops at the first response cannot see that at all, so when a
         * case supplies failWith we hand the model that failure and grade what
         * it reaches for next.
         */
        if (failWith && !recovered && items.length) {
          recovered = true
          firstCalls = calls
          for (const item of items) {
            send({
              type: 'conversation.item.create',
              item: {
                type: 'function_call_output',
                call_id: item.call_id,
                output: JSON.stringify({ ok: false, error: failWith }),
              },
            })
          }
          send({ type: 'response.create' })
          return
        }
        finish(recovered ? { first: firstCalls, then: calls } : calls)
      }
      if (event.type === 'error') finish(recovered ? { first: firstCalls, then: [] } : [])
    })
  })
}

/*
 * Repeat every variant. The model samples, so one pass is not a measurement:
 * an early run scored the SAME empty prompt 10/10 and 8/10 on consecutive
 * passes. Without repeats a 2-point "finding" is indistinguishable from noise,
 * which would make this tool worse than useless — it would manufacture
 * confident conclusions out of sampling variance.
 */
/*
 * BFCL splits tool use into four things that fail independently: picking the
 * function, filling its parameters, ordering multiple calls, and knowing when
 * NOT to call anything. Scoring only the first name collapses all four into
 * one number and scores a right-tool-wrong-arguments call as a pass. A case
 * may assert any combination:
 *
 *   expect: 'web_search'                selection — first call is this tool
 *   expect: null                        relevance — nothing should fire
 *   expectArgs: { query: /taipei/i }    parameterisation, on the matched call
 *   expectSeq: ['get_mac_status', …]    sequencing — calls in this order
 */
function judgeCase(testCase, calls) {
  /* A recovery case returns {first, then}; grade the call made AFTER the
   * failure, which is the whole point of asking. */
  if (calls && !Array.isArray(calls)) {
    const then = calls.then || []
    const names = then.map((c) => c.name)
    const shown = `${(calls.first || []).map((c) => c.name).join(',') || 'no tool'} → ${names.join(',') || 'gave up'}`
    if (testCase.expectRecovery === null) {
      return names.length
        ? { pass: false, why: `${shown} (should have stopped)` }
        : { pass: true, why: shown }
    }
    return names.includes(testCase.expectRecovery)
      ? { pass: true, why: shown }
      : { pass: false, why: `${shown} (wanted ${testCase.expectRecovery})` }
  }

  const names = calls.map((c) => c.name)
  const shown = names.length ? names.join(' → ') : 'no tool'

  if (testCase.expect === null && names.length) {
    return { pass: false, why: `${shown} (wanted no tool)` }
  }
  if (testCase.expect && names[0] !== testCase.expect) {
    return { pass: false, why: `${shown} (wanted ${testCase.expect})` }
  }
  if (testCase.expectSeq) {
    const got = names.slice(0, testCase.expectSeq.length).join(',')
    if (got !== testCase.expectSeq.join(',')) {
      return { pass: false, why: `${shown} (wanted ${testCase.expectSeq.join(' → ')})` }
    }
  }
  if (testCase.expectArgs) {
    const call = calls.find((c) => c.name === testCase.expect) || calls[0]
    if (!call) return { pass: false, why: `no tool (wanted ${testCase.expect})` }
    for (const [key, want] of Object.entries(testCase.expectArgs)) {
      const actual = call.args?.[key]
      const ok =
        want instanceof RegExp
          ? typeof actual === 'string' && want.test(actual)
          : JSON.stringify(actual) === JSON.stringify(want)
      if (!ok) {
        return {
          pass: false,
          why: `${call.name}(${key}=${JSON.stringify(actual)}) — wrong argument`,
        }
      }
    }
  }
  return { pass: true, why: shown }
}

const ABLATION_REPEATS = Number(process.env.ABLATION_REPEATS || 3)

async function scoreHarness(instructions, tools, cases, label) {
  const runs = []
  const misses = []
  for (let pass = 0; pass < ABLATION_REPEATS; pass += 1) {
    let hits = 0
    for (const testCase of cases.filter((c) => 'expect' in c)) {
      let calls = []
      try {
        calls = await scoreCase(
          instructions,
          tools,
          testCase.say,
          testCase.failWith || null,
        )
      } catch {
        calls = []
      }
      const verdict = judgeCase(testCase, calls)
      if (verdict.pass) hits += 1
      else if (pass === 0) misses.push(`"${testCase.say}" → ${verdict.why}`)
    }
    runs.push(hits)
  }
  const scoredCount = cases.filter((c) => 'expect' in c).length
  const mean = runs.reduce((a, b) => a + b, 0) / runs.length
  const spread = `${Math.min(...runs)}-${Math.max(...runs)}`
  process.stdout.write(
    `  ${mean.toFixed(1).padStart(4)}/${scoredCount}  (${spread})  ${label}\n`,
  )
  return { hits: mean, runs, spread, total: scoredCount, misses }
}

async function ablate() {
  const state = loadState()
  const cases = loadEvals()
  const fragments = state.granted.context

  if (!fragments.length) {
    process.stdout.write(
      'No prompt fragments to ablate yet — grant some context first.\n',
    )
    return
  }

  /*
   * Ablate against the tools the agent will really have, not the discovery
   * meta-tools: this measures the production harness.
   */
  let tools
  try {
    ;({ REALTIME_TOOLS: tools } = await import(
      '../cloud-relay/openaiRealtimeVoice.js'
    ))
  } catch (error) {
    throw new Error(
      `Could not load the production tool schemas from cloud-relay/openaiRealtimeVoice.js: ${error.message}`,
    )
  }

  /*
   * Compose the PRODUCTION prompt — fragments only. The bootstrap prompt is
   * discovery scaffolding that ends with "this is reconnaissance, do not
   * perform actions with side effects"; including it here measured that
   * sentence suppressing tool calls rather than measuring the harness.
   */
  const compose = (keep) =>
    keep.map((f) => `## ${f.topic}\n${f.text}`).join('\n\n')

  process.stdout.write(`\nAblation · ${MODEL} · ${cases.length} cases\n\n`)

  const whole = await scoreHarness(compose(fragments), tools, cases, 'WHOLE harness')
  const bare = await scoreHarness('', tools, cases, 'NO prompt at all')

  const results = []
  for (const fragment of fragments) {
    const without = fragments.filter((f) => f.id !== fragment.id)
    const scored = await scoreHarness(
      compose(without),
      tools,
      cases,
      `without "${fragment.topic}"`,
    )
    results.push({
      topic: fragment.topic,
      id: fragment.id,
      score: scored.hits,
      spread: scored.spread,
      delta: scored.hits - whole.hits,
    })
  }

  const lines = [
    '# Ablation',
    '',
    `Model \`${MODEL}\` · ${cases.length} tool-selection cases · ${ABLATION_REPEATS} passes per variant (range in brackets).`,
    '',
    `| variant | score | delta |`,
    `| --- | --- | --- |`,
    `| whole harness | ${whole.hits.toFixed(1)}/${whole.total} (${whole.spread}) | — |`,
    `| **no prompt at all** | ${bare.hits.toFixed(1)}/${bare.total} (${bare.spread}) | ${(bare.hits - whole.hits).toFixed(1)} |`,
  ]
  for (const r of results) {
    lines.push(
      /* whole.total, not cases.length: only cases carrying an `expect` are
       * scored, so cases.length overstated the denominator and made every
       * ablated variant look worse than the whole harness it is compared to. */
      `| without _${r.topic}_ | ${r.score.toFixed(1)}/${whole.total} (${r.spread}) | ${r.delta >= 0 ? '+' : ''}${r.delta.toFixed(1)} |`,
    )
  }
  lines.push(
    '',
    '## Read this as',
    '',
    'A fragment whose removal costs **0 or more** is not earning its place — the',
    'model performs as well or better without it, and you are paying for those',
    'tokens on every single call. Delete it and re-run.',
    '',
    'If "no prompt at all" scores close to the whole harness, the harness itself',
    'is mostly ceremony. That is the result to hope for, not to fear.',
    '',
  )
  if (!whole.misses.length) {
    lines.push(
      '## Saturated',
      '',
      'The whole harness failed nothing. This eval set no longer measures',
      'anything — evals live a model generation or two and then saturate.',
      'Rebuild it from recent usage (`derive-harness.mjs evals`) rather than',
      'reading this as a passing grade.',
      '',
    )
  }
  if (whole.misses.length) {
    lines.push('## Where the whole harness still fails', '')
    for (const miss of whole.misses) lines.push(`- ${miss}`)
    lines.push(
      '',
      'These are the ONLY places a new instruction is justified — a repeated,',
      'specific failure. Add one line, re-run, keep it only if the score moves.',
      '',
    )
  }
  fs.writeFileSync(path.join(OUT_DIR, 'ablation.md'), `${lines.join('\n')}\n`)
  process.stdout.write(`\nWrote ${path.join(OUT_DIR, 'ablation.md')}\n`)
}

/*
 * Reconnaissance alone derives a harness from what the model IMAGINES it
 * needs. The failures that actually matter — a tool that returns a shape the
 * model cannot use, an action type the executor rejects, a permission nobody
 * anticipated — only appear when the call really fires. So `task` runs the
 * agent against a real goal with its derived harness and real side effects,
 * and every failure is banked as evidence rather than as a guess.
 */
const TASK_PROMPT = `You are running FOR REAL. This is not reconnaissance and nothing here is hypothetical: the tools you call take effect on the owner's actual computer, and they will see the result.

Do the job you were given. Use the tools you have. If a tool fails, or returns something you cannot use, or the executor rejects your action, that is important — call record_finding with exactly what you sent and exactly what came back, then try another way.

Do not ask permission for reversible things. Do stop and say so if the only way forward is destructive or irreversible.

When the task is done, or you are certain you cannot finish it with what you have, call finish and say plainly which it was.`

/* Real execution against the Mac agent's production endpoints. */
const TASK_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'mac_plan',
      description:
        'Ask the Mac agent to turn a natural-language command into an action list. Reversible: planning alone changes nothing.',
      parameters: {
        type: 'object',
        properties: { command: { type: 'string' } },
        required: ['command'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'mac_execute',
      description:
        'Execute an action list on the owner\'s real Mac. Accepted types: open_url, open_app, open_folder, create_note, copy_to_clipboard, run_project, search_file, run_shell, set_volume, create_reminder. This has real effects the owner will see.',
      parameters: {
        type: 'object',
        properties: {
          command: { type: 'string', description: 'What the owner asked for.' },
          actions: {
            type: 'array',
            items: {
              type: 'object',
              properties: {
                type: { type: 'string' },
                label: { type: 'string' },
                params: { type: 'object', additionalProperties: true },
              },
              required: ['type', 'params'],
            },
          },
        },
        required: ['command', 'actions'],
      },
    },
  },
]

/*
 * For relay-realtime, "task mode" has to mean the production surface or it
 * measures nothing: same tool schemas the Worker installs, the same action
 * mapping, the same web search, and real execution on the Mac. Anything else
 * derives a harness for a product that does not exist.
 */
let prodModule = null
async function prod() {
  if (!prodModule) prodModule = await import('../cloud-relay/openaiRealtimeVoice.js')
  return prodModule
}

async function prodExecute(command, actions) {
  const r = await macFetch('/execute', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ command, actions, source: 'harness-task' }),
  })
  return { status: r.status, ...(typeof r.body === 'object' ? r.body : { body: r.body }) }
}

const PROD_IMPLS = {
  async web_search(args) {
    const { runWebSearch } = await prod()
    try {
      const result = await runWebSearch(String(args.query || ''))
      return { status: 200, result: String(result).slice(0, 3000) }
    } catch (error) {
      return { error: String(error?.message || error) }
    }
  },
  async get_mac_status(args) {
    const { mapGetMacStatusToActions } = await prod()
    const actions = mapGetMacStatusToActions(args.fields)
    return prodExecute('get_mac_status', actions)
  },
  async mac_run_actions(args) {
    return prodExecute(String(args.spoken_reply || 'mac_run_actions'), args.actions || [])
  },
  async browser_run_actions(args) {
    /* Same prefixing production applies when the model omits it. */
    const actions = (args.actions || []).map((a) => {
      const type = String(a.type || '')
      return type && !type.startsWith('browser_') && type !== 'open_url'
        ? { ...a, type: `browser_${type}` }
        : a
    })
    return prodExecute(String(args.spoken_reply || 'browser_run_actions'), actions)
  },
  async mac_delegate(args) {
    const r = await macFetch('/plan', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ command: String(args.goal || ''), source: 'harness-task' }),
    })
    return { status: r.status, ...(typeof r.body === 'object' ? r.body : { body: r.body }) }
  },
}

const TASK_IMPLS = {
  async mac_plan(args) {
    try {
      const r = await macFetch('/plan', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ command: String(args.command || ''), source: 'harness-task' }),
      })
      return { status: r.status, ...(typeof r.body === 'object' ? r.body : { body: r.body }) }
    } catch (error) {
      return { error: String(error?.message || error) }
    }
  },
  async mac_execute(args) {
    try {
      const r = await macFetch('/execute', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          command: String(args.command || ''),
          actions: Array.isArray(args.actions) ? args.actions : [],
          source: 'harness-task',
        }),
      })
      return { status: r.status, ...(typeof r.body === 'object' ? r.body : { body: r.body }) }
    } catch (error) {
      return { error: String(error?.message || error) }
    }
  },
}

const command = process.argv[2] || 'run'
try {
  if (command === 'run') await runRound()
  else if (command === 'task') {
    const goal = process.argv[3]
    if (!goal) throw new Error('task needs a goal: task "open Safari"')
    const state = loadState()
    const previous = state.phase
    state.phase = 'task'
    state.taskGoal = goal
    saveState(state)
    try {
      await runRound()
    } finally {
      const after = loadState()
      after.phase = previous
      saveState(after)
    }
  }
  else if (command === 'review') review()
  else if (command === 'grant') grant(process.argv[3])
  else if (command === 'deny') deny(process.argv[3])
  else if (command === 'prompt') process.stdout.write(`${buildSystemPrompt(loadState())}\n`)
  else if (command === 'ablate') await ablate()
  else if (command === 'evals') await buildEvals()
  else if (command === 'phase') {
    const state = loadState()
    const next = process.argv[3]
    if (!['recon', 'capability'].includes(next))
      throw new Error('phase must be recon or capability')
    state.phase = next
    saveState(state)
    process.stdout.write(`Phase is now ${next}.\n`)
  } else if (command === 'reset') {
    fs.rmSync(STATE_PATH(), { force: true })
    process.stdout.write('Reset.\n')
  } else {
    process.stdout.write('Commands: run | review | grant <id> | deny <id> | phase <recon|capability> | ablate | evals | prompt | reset\n')
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}

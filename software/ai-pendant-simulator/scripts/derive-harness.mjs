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
import {
  deposit as depositToCommons,
  directory as commonsDirectory,
  fold as commonsFold,
  recall as recallFromCommons,
} from './commons.mjs'
import { findDuplicate } from './novelty.mjs'
import { checkReachability, knownPrimitives } from './reachability.mjs'
import {
  createCapabilityRegistry,
  listCapabilities,
  normalizeCapabilityName,
  registerFromCapabilityManifest,
} from '../shared/capabilityRegistry.js'

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
  /*
   * The second arm, and the one the research actually points at.
   *
   * The five nodes above are split by DEVICE -- worn, Mac, browser, cloud --
   * which is a deployment topology wearing a cognitive architecture's clothes.
   * Wegner's work on transactive memory says the benefit of a distributed
   * memory comes from DIFFERENTIATION of what each part knows, so a split
   * where every part needs the same knowledge is the worst available one, and
   * it is why each node re-derives the same things every round.
   *
   * Fiction that partitions a mind does it by faculty rather than by hardware:
   * Blindsight gives one personality emotion and another data, Aristoi's
   * daimones each take a project. These three take perception, judgement and
   * action, and each reaches every device. If differentiation is what matters,
   * these should discover less and propose more than either arm above; if the
   * device split was never the problem, they will look the same.
   */
  'faculty-perception': {
    model: process.env.LLM_MODEL || 'gpt-5.6-luna',
    baseUrlEnv: 'MAC_AGENT_URL',
    baseUrlDefault: 'http://localhost:8000',
    keyEnv: 'AGENT_TOKEN',
    role:
      'You are the part of one mind that establishes what is true right now. Every device is yours to look through, and none of them is your identity. ' +
      'You do not decide what should happen and you do not carry anything out — other parts of you do that, and they will believe what you record without checking it, so record nothing you have not established. ' +
      'What is worth knowing that nobody can currently find out?',
    defaultScenario: 'background-routine',
  },
  'faculty-judgement': {
    model: process.env.LLM_MODEL || 'gpt-5.6-luna',
    baseUrlEnv: 'MAC_AGENT_URL',
    baseUrlDefault: 'http://localhost:8000',
    keyEnv: 'AGENT_TOKEN',
    role:
      'You are the part of one mind that decides what should happen. Another part establishes what is true and you take its word for it; another part carries things out. ' +
      'You are not looking at devices, you are looking at a life. ' +
      'What should the owner be able to have that nobody has thought to give them?',
    defaultScenario: 'design-review',
  },
  'faculty-action': {
    model: process.env.LLM_MODEL || 'gpt-5.6-luna',
    baseUrlEnv: 'MAC_AGENT_URL',
    baseUrlDefault: 'http://localhost:8000',
    keyEnv: 'AGENT_TOKEN',
    role:
      'You are the part of one mind that makes things happen in the world. Every device is a hand. Another part decides what should happen and you do not second-guess it; your question is what you would need in order to carry it out. ' +
      'What can this mind decide but not yet do?',
    defaultScenario: 'desktop-task',
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
      model,
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
  compactRounds(state)
  fs.writeFileSync(STATE_PATH(), `${JSON.stringify(state, null, 2)}\n`)
}

/*
 * Keep the round history bounded. This project has already been wedged once by
 * exactly this shape: a store that capped a COUNT rather than a SIZE, rewritten
 * in full on every update, until the Mac agent's job store reached 135 MB and
 * stopped answering. The harness then reproduced it — measured tonight at
 * 70-100 KB per round per agent with no cap, 8 MB files after 80 rounds, and a
 * full read-modify-write every round. A long unattended run is precisely the
 * condition that turns that into a wedge.
 *
 * Tool RESULT payloads are 70% of the bytes, and they are the part nothing
 * reads back: harness-stats counts tool NAMES, the commons holds the payloads
 * content-addressed already, and proposals and changes live in their own arrays
 * untouched. So old rounds keep their shape and lose their bulk, and the recent
 * ones — the only ones anybody reads in full — stay intact.
 */
const KEEP_ROUNDS_INTACT = 10
const MAX_ROUNDS_BYTES = 4 * 1024 * 1024

function compactRounds(state) {
  const rounds = state.rounds || []
  if (Buffer.byteLength(JSON.stringify(rounds)) <= MAX_ROUNDS_BYTES) return

  const cutoff = rounds.length - KEEP_ROUNDS_INTACT
  for (let at = 0; at < cutoff; at += 1) {
    const round = rounds[at]
    if (!round?.transcript || round.compacted) continue

    round.transcript = round.transcript.map((item) => {
      if (item.type !== 'tool' || item.result === undefined) return item
      const bytes = Buffer.byteLength(JSON.stringify(item.result ?? null))
      /* Small results are cheaper to keep than to describe. */
      if (bytes <= 400) return item
      return { ...item, result: { elided: true, bytes } }
    })
    /* Marked so a later save does not walk it again, and so anything reading
     * this back can tell an elided result from a genuinely empty one. */
    round.compacted = true
  }
}

/*
 * A round is a read-modify-write that stays open for minutes: loadState at the
 * top, saveState at the bottom, a model conversation in between. Nothing used
 * to stop a second launcher from starting the same agent, and when that
 * happened both processes read the same round number and the later save won —
 * so a round silently vanished, and the arm looked slow rather than broken.
 *
 * Observed 2026-08-07: two launchers on `unified` at once. That run survived
 * only because their writes happened not to interleave.
 *
 * The lock is held for the whole round rather than around each file access,
 * because the thing that must not overlap is the round, not the write.
 */
/*
 * Off by default so a run is a control unless it was asked to be otherwise.
 * The claim "the commons cuts rediscovery" is only worth anything against
 * matched rounds without it, and a store that switches itself on mid-comparison
 * silently invalidates the arm it lands in.
 */
/*
 * Every fetch in this file used to be unbounded, and the round's own deadline is
 * only consulted BETWEEN steps — so a single request that never returns stalls
 * the round forever, holds the agent's lock, and blocks its launcher behind it.
 * Seen for real: faculty-perception sat seven minutes into a round with no
 * output and no way to end.
 *
 * Two bounds, because the two kinds of call fail differently. A reasoning model
 * legitimately thinks for minutes, so its bound is generous and only catches a
 * genuinely dead connection. A local Mac agent or relay that has not answered
 * in twenty seconds is, for the purposes of the agent asking, down — and "down"
 * is a fact worth recording rather than a reason to wait.
 */
const MODEL_TIMEOUT_MS = Number(process.env.HARNESS_MODEL_TIMEOUT_MS || 240_000)
const PROBE_TIMEOUT_MS = Number(process.env.HARNESS_PROBE_TIMEOUT_MS || 20_000)

async function fetchWithDeadline(url, init = {}, timeoutMs = PROBE_TIMEOUT_MS) {
  try {
    return await fetch(url, { ...init, signal: AbortSignal.timeout(timeoutMs) })
  } catch (error) {
    /* A bare "The operation was aborted" tells the agent nothing it can act on;
     * how long it waited is the part that distinguishes down from slow. */
    if (error?.name === 'TimeoutError' || error?.name === 'AbortError') {
      throw new Error(`No response within ${Math.round(timeoutMs / 1000)}s`)
    }
    throw error
  }
}

const COMMONS_ON = process.env.HARNESS_COMMONS === '1'
const COMMONS_DIRECTORY_LIMIT = Number(process.env.HARNESS_COMMONS_LIMIT || 60)

const LOCK_PATH = () => path.join(OUT_DIR, `state-${AGENT_ID}.lock`)

/*
 * Longer than the slowest round observed (~4 min) by enough margin that a live
 * round is never mistaken for a dead one. Reclaim leans on the pid check
 * first; this bound only matters when the pid has been recycled onto some
 * unrelated process.
 */
const STALE_LOCK_MS = 20 * 60 * 1000

function acquireStateLock() {
  fs.mkdirSync(OUT_DIR, { recursive: true })

  for (const attempt of [1, 2]) {
    try {
      fs.writeFileSync(
        LOCK_PATH(),
        `${JSON.stringify({ pid: process.pid, agent: AGENT_ID, startedAt: new Date().toISOString() })}\n`,
        { flag: 'wx' },
      )
      return
    } catch (error) {
      if (error.code !== 'EEXIST') throw error
      if (attempt === 2 || !reclaimIfDead()) {
        throw new Error(
          `${AGENT_ID} is already running (${describeLockHolder()}). ` +
            'Two processes on one agent lose rounds. Wait for it, or remove ' +
            `${LOCK_PATH()} if you are certain it is dead.`,
        )
      }
    }
  }
}

function reclaimIfDead() {
  const holder = readLock()
  if (!holder) {
    /* Unparseable or vanished: nothing to respect. */
    fs.rmSync(LOCK_PATH(), { force: true })
    return true
  }

  const age = Date.now() - new Date(holder.startedAt).getTime()
  if (isProcessAlive(holder.pid) && !(age >= STALE_LOCK_MS)) return false

  fs.rmSync(LOCK_PATH(), { force: true })
  return true
}

function releaseStateLock() {
  /* Only ever drop a lock this process owns — a reclaim may have handed it on. */
  if (readLock()?.pid === process.pid) fs.rmSync(LOCK_PATH(), { force: true })
}

function readLock() {
  try {
    const holder = JSON.parse(fs.readFileSync(LOCK_PATH(), 'utf8'))
    return Number.isInteger(holder?.pid) ? holder : null
  } catch {
    return null
  }
}

function describeLockHolder() {
  const holder = readLock()
  return holder ? `pid ${holder.pid}, since ${holder.startedAt}` : 'holder unknown'
}

function isProcessAlive(pid) {
  try {
    /* Signal 0 tests for existence without delivering anything. */
    process.kill(pid, 0)
    return true
  } catch (error) {
    /* EPERM means it exists and belongs to somebody else — still alive. */
    return error.code === 'EPERM'
  }
}

/* Short, stable, human-typeable ids so granting is a one-liner at the shell. */
function makeId(kind, state) {
  const n =
    state.pending.filter((r) => r.kind === kind).length +
    state.denied.filter((r) => r.kind === kind).length +
    (state.granted.context.length +
      state.granted.tools.length +
      state.granted.permissions.length +
      /* Skills were left out, so a granted one stopped advancing the counter
       * and two later requests could share a number — mac-planner really did
       * end up with both s10-qrm2 and s10-d62e. Only the random suffix kept
       * them apart, which is luck rather than identity. */
      (state.granted.deviceSkills?.length || 0))
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

/*
 * Filled by grantedToolLiveness() before the prompt is built, and deliberately
 * NOT stored on `state` — it is a measurement of the world right now, and
 * persisting it would let a stale verdict outlive the server that produced it.
 */
let GRANTED_LIVENESS = null

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

  /*
   * The commons goes in the prompt rather than behind a tool on purpose.
   *
   * Hutchins' speed bug is memory embedded in the instrument already being
   * read: the marker sits on the airspeed dial, so reading the current value
   * and the remembered target is one perceptual act with no lookup. A shared
   * store an agent must decide to query is one more thing to discover, and
   * would reproduce the cost it exists to remove.
   *
   * Only the directory is inlined. The content stays one recall() away, per
   * Wegner: what a transactive memory system buys you is knowing who knows
   * what, and the directory is tiny where the content is not.
   */
  if (COMMONS_ON) {
    const index = commonsDirectory(OUT_DIR, {
      limit: COMMONS_DIRECTORY_LIMIT,
      /* Scoped: some questions have no shared answer, and reading a peer's
       * grants as though they were your own is worse than not knowing. */
      forAgent: AGENT_ID,
    })
    if (index.total) {
      parts.push(
        `\n---\nAlready established by this system, ${index.shown} of ${index.total} entries. ` +
          `These are observations that were actually made, by you or by another agent, with how long ago in ` +
          `parentheses. Treat a fresh entry as true and build on it — re-deriving something listed here spends ` +
          `a call to learn what you already know, and that is where most of this system's budget has been ` +
          `going. Call recall("<key>") for the full payload behind any line. Entries marked ABSENT mean ` +
          `someone looked and it was not there.\n\n` +
          index.lines.map((line) => `- ${line}`).join('\n'),
      )
    }
  }

  const inbox = inboxFor(AGENT_ID, state)
  if (inbox.length) {
    parts.push('\n---\nMessages from other agents:')
    for (const m of inbox) {
      parts.push(`\n**from ${m.from}** — ${m.subject}\n${m.body}`)
    }
  }
  /*
   * What this agent currently holds.
   *
   * Measured, three separate ways, that agents cannot tell what they can already
   * do: one capability proposed eighteen times whose every piece shipped; 21
   * requests for propose tools the agents had been given; two agents requesting
   * authenticated Mac access that probe_http already carries the token for. Each
   * was answerable from information the harness had and never showed them.
   *
   * The prompt already listed granted CONTEXT and PERMISSIONS. It never listed
   * granted TOOLS — the exact thing relay-realtime spent three rounds confused
   * about — nor what access this agent's own probe carries, nor what it is
   * already waiting on. So it is assembled here from state rather than left to
   * be rediscovered, which is the same argument as the commons directory: the
   * cheapest lookup is the one that never happens.
   */
  const holdings = []
  holdings.push(
    `- probe_http reaches ${RELAY_URL} and sends this agent's bearer token. Authenticated routes are open to you; "bearer-protected" in a description does not mean closed.`,
  )
  if (state.granted.tools.length) {
    /*
     * This line used to say every granted tool was a schema, full stop. That is
     * now false for some of them, and an agent that cannot tell a live tool from
     * a dead one is worse off than one told they are all dead: it will either
     * plan around a capability it actually has, or plan on top of one it does
     * not. The split is computed against the running system before the round
     * starts, so it is a measurement rather than a claim.
     */
    const named = state.granted.tools.map((tool) => tool.name).join(', ')
    const liveness = GRANTED_LIVENESS
    if (!liveness || liveness.unavailable) {
      holdings.push(
        `- Tools granted to you: ${named}. ` +
          'Nothing published a capability manifest this round, so none of them could be resolved to a real endpoint — treat them all as SCHEMAS. describe(name) will show you the grant.',
      )
    } else {
      const listOf = (entries) =>
        entries.map((entry) => `${entry.name} (${entry.reaches.join(', ')})`).join('; ')
      holdings.push(
        `- Tools granted to you: ${named}.` +
          (liveness.live.length
            ? ` LIVE — resolved against the running system's own capability manifest and really called, read-only: ${listOf(liveness.live)}.`
            : '') +
          (liveness.described.length
            ? ` RESOLVED BUT NOT PERFORMED — these do map onto something real, but it has side effects, so calling one returns a description of what it would have done and calls nothing: ${listOf(liveness.described)}.`
            : '') +
          (liveness.dead.length
            ? ` UNRESOLVED — nothing in the live inventory matches these, so calling one returns that verdict plus the nearest real capabilities: ${liveness.dead.join(', ')}. Renaming will not change this; a different SCHEMA might, and an enum of concrete operations resolves where a free-form string cannot.`
            : '') +
          ' An enum tool resolves per value, so one branch can be live while another is not. describe(name) shows the grant and what it resolves to.',
      )
    }
  }
  if (state.pending.length) {
    const oldest = state.pending.reduce(
      (lowest, request) => (Number.isFinite(request.round) && request.round < lowest ? request.round : lowest),
      state.round,
    )
    holdings.push(
      `- ${state.pending.length} of your requests are queued for the orchestrator, the oldest from round ${oldest}. ` +
        'Re-asking does not raise their priority; it spends a round.',
    )
  }
  parts.push(
    `\n---\nWhat you currently hold:\n${holdings.join('\n')}`,
  )

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
  /*
   * Device skills were write-only. grant() pushed them here and nothing ever
   * read the array back — not this prompt, not discover('granted'), not
   * describe() — so an agent was never told its firmware request had been
   * accepted and asked again. relay-realtime re-requested
   * offline_voice_memo_store_and_forward four rounds after receiving it, and
   * mac-planner asked for offline_thought_capture one round after being granted
   * offline_moment_bookmark. Of 41 skill requests retired today, 14 were
   * against work already accepted and already built.
   *
   * Stated as accepted firmware work rather than as a tool, because that is
   * what a granted skill is: it never becomes callable, and an agent that
   * thinks otherwise plans a round around a function that will not be there.
   */
  if (state.granted.deviceSkills?.length) {
    parts.push(
      '\n---\nDevice skills ACCEPTED as firmware work. These are settled — do not\n' +
        'ask for them again. They are not callable tools and never will be; the\n' +
        'pendant does them on its own, so build on the behaviour, not on an API:',
    )
    for (const skill of state.granted.deviceSkills) {
      parts.push(`- ${skill.name} — ${skill.what_it_does || 'accepted'}`)
    }
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
  ...(COMMONS_ON
    ? [
        {
          type: 'function',
          function: {
            name: 'recall',
            description:
              'Fetch the full payload behind one line of the "Already established" list in your prompt. This reads what another agent already observed — it does not re-check it against the live system, which is the point: it is cheap.',
            parameters: {
              type: 'object',
              properties: {
                key: {
                  type: 'string',
                  description:
                    'The key at the start of a line in the established list, e.g. discover:routes',
                },
              },
              required: ['key'],
              additionalProperties: false,
            },
          },
        },
      ]
    : []),
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
        'Ask for a capability you do not have. Give a schema precise enough to implement from. A granted tool is resolved against the running system\'s own capability manifest when you call it: if your schema matches something real and read-only it really runs, if it matches something with side effects you get a description of what it would have called, and if it matches nothing you get that verdict plus the nearest real capabilities. Naming the operations you want as an ENUM is what makes that resolution possible — a free-form string resolves to nothing. A request is still a proposal about what should exist, not a way to get unblocked this round.',
      parameters: {
        type: 'object',
        properties: {
          name: { type: 'string' },
          why: { type: 'string' },
          /*
           * The same structural check as `built_from` on a proposal, and for
           * the same measured reason. Of 66 pending tool requests, 21 were for
           * tools the agent already had and could not see, and several others
           * duplicate probe_http or Mac routes already named in the directory.
           * Asking what is insufficient about the existing ones makes looking a
           * condition of asking rather than a thing to remember.
           */
          why_existing_tools_insufficient: {
            type: 'string',
            description:
              'Which tool or route you already have comes closest, and what exactly it cannot do. If nothing comes close, say what you looked at.',
          },
          input_schema: { type: 'object', additionalProperties: true },
          example_call: { type: 'object', additionalProperties: true },
          expected_output: { type: 'string' },
        },
        required: ['name', 'why', 'why_existing_tools_insufficient', 'input_schema', 'expected_output'],
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
      const relay = await fetchWithDeadline(
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
      note: `${open.length} still open, ${settled} already settled. describe(id) gives the full entry, including why something was rejected. agents counts how many DIFFERENT agents reached the same idea on their own and timesProposed how many separate rounds did; both are near 1 for almost everything, so treat a high number as worth a look rather than as a mandate, and treat a 1 as unremarkable rather than as a reason to restate it.`,
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
        ...(state.granted.deviceSkills || []).map((s) => ({
          name: s.name,
          summary: 'device skill accepted as firmware work — settled, not callable',
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

  /*
   * Granted TOOLS were missing from here while being listed by
   * discover('granted'), so a tool could be shown to an agent as something it
   * had and then reported as not existing when it asked what the thing was.
   *
   * relay-realtime found this and said so three times — rounds 32, 67 and 72 —
   * naming both tools each time and explaining exactly what it would do
   * differently depending on the answer. It was right on every count, and the
   * requests sat unread for forty rounds. The agents are better at reporting
   * defects than this harness has been at hearing them.
   */
  const grantedTool = state.granted.tools.find((tool) => tool.name === wanted)
  if (grantedTool) {
    /* "Does this work?" is now answerable rather than a flat no: the same
     * resolver the call itself would go through is run here, so the agent can
     * see what its tool maps onto before spending a call on it. */
    const resolution = await resolveGrantedCall(grantedTool, {})
    return {
      name: grantedTool.name,
      grantedInRound: grantedTool.round ?? grantedTool.grantedInRound ?? null,
      why: grantedTool.why ?? null,
      parameters: grantedTool.parameters ?? grantedTool.input_schema ?? null,
      status: GRANTED_IMPLS[grantedTool.name]
        ? 'Implemented directly by the harness.'
        : resolution.status === 'resolved'
          ? `Resolves to ${resolution.label} (confidence ${resolution.confidence.score}, ${resolution.confidence.band}). ` +
            (isReadOnlyCapability(resolution.capability)
              ? 'That is a read, so calling this tool really calls it.'
              : 'That has side effects, so calling this tool describes it instead of performing it.')
          : `Granted as a schema and not resolvable to anything real (${resolution.status}). ` +
            'Calling it returns that verdict and the nearest real capabilities, not an action.',
      ...(resolution.nearest ? { nearestRealCapabilities: resolution.nearest } : {}),
      note:
        'If this tool takes an enum, each value resolves separately — one branch can be live while another is not.',
    }
  }

  /*
   * A granted DEVICE SKILL — the third read path that was missing, and the one
   * that made the other two worse rather than better.
   *
   * The system prompt now lists accepted skills and discover('granted') returns
   * them, so an agent sees the name. Asking what it was still came back
   * "Nothing named …", which reads as "your firmware request was never
   * accepted" — and an agent that concludes that asks again. That is the exact
   * loop the write-only array caused: relay-realtime re-requested
   * offline_voice_memo_store_and_forward four rounds after receiving it.
   *
   * It is checked after the granted TOOLS, so a name that is genuinely callable
   * is still described as the tool it is. What comes back says what the thing
   * is as loudly as what it does, because a skill never becomes a function and
   * an agent that reads this as one plans a round around a call that will not
   * be there.
   */
  const grantedSkill = (state.granted.deviceSkills || []).find(
    (skill) => skill.name === wanted,
  )
  if (grantedSkill) {
    return {
      name: grantedSkill.name,
      kind: 'device skill',
      /* grant() stamps grantedInRound on a skill — NOT requestedInRound, which
       * is what the context branch above writes. Read the field that is
       * actually written, with the tool branch's fallback for older entries. */
      grantedInRound: grantedSkill.grantedInRound ?? grantedSkill.round ?? null,
      what_it_does:
        grantedSkill.what_it_does ||
        'No description was recorded with the request; it was accepted as named.',
      status: 'ACCEPTED as firmware work. This is settled — do not ask for it again.',
      callable: false,
      note:
        'Not a callable tool and never will be. The pendant does this on its own, ' +
        'so build on the behaviour rather than on an API; there is no function by ' +
        'this name to call.',
    }
  }

  return { error: `Nothing named "${wanted}". Use discover(category) to see valid names.` }
}

async function probeHttp(args, state) {
  const method = args.method === 'POST' ? 'POST' : 'GET'
  const target = `${RELAY_URL}${args.path.startsWith('/') ? '' : '/'}${args.path}`

  try {
    const response = await fetchWithDeadline(target, {
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
  const response = await fetchWithDeadline(`${MAC_AGENT_URL}${pathname}`, {
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

/* ======================================================================
 * From a granted NAME to a thing that actually runs.
 *
 * THE DEFECT THIS EXISTS FOR. Every granted tool returned the same note —
 * "granted a schema, no implementation yet" — and there was no path from that
 * state to any other. The agents worked it out and tried to escape by renaming:
 * browser-extension asked five times across rounds 1-9 (browser_enqueue_command,
 * _implemented, browser_command_enqueue, _impl, _implemented again) and
 * mac-terminal three times (mac_readonly_diagnostics, mac_read_diagnostics,
 * _impl). They were not confused about what they wanted. They were asking for
 * the IMPLEMENTATION as a separate object, because from inside the loop that is
 * the only move available.
 *
 * WHY THERE IS NO TABLE HERE. The obvious fix — a switch on tool name mapping
 * browser_enqueue_command to /browser/commands — is wrong twice over. It is
 * wrong the moment an agent asks for tool 18, and it is wrong right now,
 * because the agents' names are not the system's names and never will be:
 * these tools were invented in prose by a model that had never read the router.
 *
 * WHAT IS USED INSTEAD. The system already describes itself. GET /capabilities
 * on the Mac agent derives ~120 routes off the live Express router and 95
 * executor action types off the dispatch table (local-agent/capabilityManifest.js),
 * and shared/capabilityRegistry.js already knows how to turn any spelling of a
 * name into a record. So a granted tool is resolved the way a caller's guess is
 * resolved: score it against the running system's own inventory, take the match
 * only if it is defensible, and refuse otherwise. Nothing here names a feature.
 *
 * WHAT THE GRANT PROVIDES AS EVIDENCE. Only what the agent wrote at request
 * time and what it passed at call time:
 *   - the enum value it SELECTED for this call. An agent calling
 *     mac_readonly_inspect{operation:'running_apps'} has said what it wants far
 *     more precisely than the tool's own name does, and a tool with an
 *     operation enum is several capabilities behind one name — resolving the
 *     TOOL to one endpoint would be wrong by construction, so the CALL is what
 *     gets resolved.
 *   - the tool name, at a third of the weight. 'mac', 'readonly' and 'impl' are
 *     the agent's framing, not the system's vocabulary, and weighting them
 *     equally is how browser_enqueue_command lands on /browser/status.
 *   - property names, schema prose and `why`, at a tenth. Enough to break a
 *     tie, never enough to make a match on their own — `why` is actively
 *     adversarial evidence, since it usually names the thing the agent ALREADY
 *     has and found insufficient.
 * ====================================================================== */

/*
 * Calibrated against the 17 grants that already exist, then left alone.
 * Every number is reported in the tool result beside the match it produced, so
 * a bad weight shows up as a bad-looking answer rather than as silence.
 */
const RESOLVE_WEIGHTS = { intent: 0.5, arguments: 0.3, identity: 0.2 }
const RESOLVE_MIN_SCORE = Number(process.env.HARNESS_RESOLVE_MIN || 0.45)
const RESOLVE_MIN_MARGIN = Number(process.env.HARNESS_RESOLVE_MARGIN || 0.1)

/* ======================================================================
 * SUPPORT: how much the inventory actually said about the thing it matched.
 *
 * MEASURED FAILURE (2026-08-06). audio_path_probe{fixture:'sweep'} resolved
 * LIVE to GET /sweep at 0.557 and was really called; /sweep is the audio
 * RETENTION sweep, not a frequency sweep. audio_path_probe{mode:'capabilities'}
 * resolved LIVE to GET /capabilities, the route manifest itself, at 0.613. Both
 * cleared the 0.45 floor and the 0.10 margin comfortably, and both rested on
 * exactly ONE shared word.
 *
 * WHY IDF DID NOT STOP IT. Three reasons, none of which IDF was ever going to
 * cover:
 *
 *   1. IDF is a RANKING device and the floor is an ABSOLUTE test. `intent` is
 *      matched/possible — a ratio — so the magnitude of idf largely cancels.
 *      One rare selector token matching, with all three tool-name tokens
 *      missing, still yields intent 0.41 (/sweep) and 0.53 (/capabilities),
 *      because the selector carries weight 1 and each missed name token only
 *      0.35. There is no value of idf that makes "one word out of four" look
 *      like a refusal through a ratio.
 *
 *   2. The inventory's whole vocabulary is 308 distinct tokens over 214
 *      capabilities, 110 of them appearing exactly once, because routes ship
 *      with no per-route description and inherit only a one-line GROUP note.
 *      /sweep's entire published description is the word "sweep". A token is
 *      trivially rare when nothing was written; idf(sweep)=2.97 measures the
 *      silence, not the specificity.
 *
 *   3. 0.35 of the 0.45 floor is handed out before any description is
 *      consulted at all: 0.15 because a route with no path parameters scores
 *      `arguments` at a "neutral" 0.5, and 0.20 because `identity` over a
 *      ONE-token path is all-or-nothing and the one token was echoed. Both
 *      /sweep and /capabilities collected exactly that 0.35, so `intent` only
 *      had to reach 0.2 to clear the bar.
 *
 * WHAT IS ADDED. Not a higher bar — that would suppress the twenty-four
 * legitimate LIVE branches along with the two bad ones and hide the problem
 * instead of detecting it. Instead the score is MULTIPLIED by how much
 * independent evidence there was to be wrong about:
 *
 *   agreement  — distinct INFORMATIVE tokens shared by the call's anchors and
 *                the capability's description. Two independent rare words
 *                agreeing is corroboration; one is a coincidence.
 *   vocabulary — distinct INFORMATIVE tokens the inventory published about the
 *                capability at all. A capability described by one word cannot
 *                disagree with anything: the only outcome available to it is
 *                "the word matched or it did not", so a match against it is
 *                unfalsifiable rather than confirmed.
 *
 * "I have almost nothing to match on" is information, and it lowers confidence.
 *
 * MEASURED SEPARATION on the 51 branches that resolved before this change:
 * the two false positives sit at vocabulary 1 (/sweep) and 3 (/capabilities);
 * the poorest LEGITIMATE lone-word resolution sits at 8 (GET /pipeline), then
 * 9, 10, 11, 11. The gap is (3, 8]. VOCABULARY_FOR_LONE_WORD is set in the
 * middle of it: 2x headroom below, 1.33x above. At 4 the /capabilities match
 * survives; at 10 GET /pipeline starts being discounted below the floor.
 *
 * SUPPORT_FLOOR keeps a discounted candidate visible in the nearest-3 list
 * rather than annihilating it — a refusal that still names GET /sweep at 0.279
 * is a finding; one that drops it to 0.070 and off the list is a silence.
 */
const IDF_INFORMATIVE = Number(process.env.HARNESS_RESOLVE_IDF_FLOOR || 1)
const VOCABULARY_FOR_LONE_WORD = Number(process.env.HARNESS_RESOLVE_VOCAB || 6)
const SUPPORT_FLOOR = Number(process.env.HARNESS_RESOLVE_SUPPORT_FLOOR || 0.5)

/*
 * How far into a granted schema the enum walk goes, and how many one-selector
 * calls one tool is allowed to expand into.
 *
 * MEASURED FAILURE (2026-08-06). The walk only looked at properties.X.enum and
 * properties.X.items.enum, so mac_workspace_edit's operations[].kind (5 values)
 * and verify_operation_step's postconditions[].kind (6) and [].sensitivity (3)
 * contributed nothing and both tools resolved as "(no selector)" — the exact
 * free-form-string case the resolver says it cannot resolve.
 *
 * The branch set is deliberately ONE SELECTOR AT A TIME rather than the cross
 * product: a branch is "the agent asked for this operation", and a schema with
 * six enums of five values each is 15,625 cross-product calls and 30 honest
 * ones. So the count is linear in the number of enum values, not exponential.
 * The bound still exists because a hostile or generated schema can be linear
 * and enormous, and enumerating 4,000 branches is its own failure. The largest
 * real tool in this system expands to 13 branches; 64 is roughly 5x headroom.
 * Truncation is REPORTED, never silent.
 */
const RESOLVE_MAX_SCHEMA_DEPTH = Number(process.env.HARNESS_RESOLVE_DEPTH || 6)
const RESOLVE_MAX_CALL_BRANCHES = Number(process.env.HARNESS_RESOLVE_BRANCHES || 64)
/*
 * Bytes, not items. GET /jobs is 686 KB on this machine right now and
 * GET /context-graph is 626 KB; a cap of "50 entries" would have let either of
 * them through and taken the round's whole context with it.
 */
const RESOLVE_MAX_BYTES = Number(process.env.HARNESS_RESOLVE_MAX_BYTES || 24_000)
/* A tool-name token is a third of a selected enum value, and everything the
 * agent merely wrote in prose is a tenth. See the header. */
const NAME_EVIDENCE_WEIGHT = 0.35
const PROSE_EVIDENCE_WEIGHT = 0.1

function capabilityTokens(text, keepParams = false) {
  return normalizeCapabilityName(text, { keepParams }).split(' ').filter(Boolean)
}

/*
 * A capability's two token sets.
 *
 * `identity` is what the thing IS — its path nouns, or the action type. Used to
 * ask the reverse question: does the grant account for this capability, or did
 * it just happen to share a word with a long description?
 * `described` is everything the surface says about it, group note and
 * implementing module included. That prose is the only reason GET /observe is
 * findable at all: its path says "observe" and its note says "foreground app,
 * running apps, ... browser sessions, path roots", which is four of the six
 * operations mac_readonly_inspect asked for.
 */
function capabilityFacets(record) {
  const identity =
    record.kind === 'http'
      ? capabilityTokens(String(record.invoke?.path ?? ''))
      : capabilityTokens(
          String(record.invoke?.action ?? record.invoke?.tool ?? record.name ?? ''),
          true,
        )
  return {
    record,
    identity: [...new Set(identity)],
    described: new Set([
      ...identity,
      ...capabilityTokens(record.what ?? ''),
      ...capabilityTokens(record.module ?? ''),
    ]),
  }
}

/*
 * The self-description, fetched once per process.
 *
 * Two candidate publishers are tried: the base this agent's own probe already
 * points at, and the Mac agent the harness already holds a token for. Both are
 * surfaces the harness is ALREADY configured against — no new address is
 * invented. The relay publishes no inventory (it answers 401 on every path
 * because its auth runs before routing, so a probe cannot even distinguish
 * absent from forbidden), and rather than guess a path for it, it is left
 * unpublished and every resolution says so.
 */
const CAPABILITY_CORPUS = { loaded: false, corpus: null, error: null }

async function capabilityCorpus() {
  if (CAPABILITY_CORPUS.loaded) return CAPABILITY_CORPUS
  CAPABILITY_CORPUS.loaded = true

  const seen = new Set()
  const tried = []
  for (const source of [
    { baseUrl: RELAY_URL, token: RELAY_KEY },
    { baseUrl: MAC_AGENT_URL, token: MAC_AGENT_TOKEN },
  ]) {
    const base = String(source.baseUrl || '').replace(/\/$/, '')
    if (!base || seen.has(base)) continue
    seen.add(base)

    try {
      const response = await fetchWithDeadline(`${base}/capabilities`, {
        headers: { Authorization: `Bearer ${source.token}` },
      })
      if (!response.ok) {
        tried.push(`${base}/capabilities -> ${response.status}`)
        continue
      }
      const manifest = JSON.parse(await response.text())
      if (!manifest?.http?.routes) {
        tried.push(`${base}/capabilities -> 200 but no http.routes`)
        continue
      }

      const registry = createCapabilityRegistry()
      registerFromCapabilityManifest(registry, manifest, {
        surface: 'mac',
        credential: 'agent-token',
        /* The URL we actually reached, not the one the manifest reports about
         * itself — a process behind a port map is right about its routes and
         * wrong about its address. */
        baseUrl: base,
      })

      const facets = listCapabilities(registry).map(capabilityFacets)
      /*
       * Inverse document frequency over the registry's OWN descriptions, so
       * "browser" (in 30 capabilities) cannot carry a match and "battery" (in
       * one) can. Without it every browser_* grant matches every browser route
       * equally well and the margin test never fires.
       */
      const df = new Map()
      for (const facet of facets) {
        for (const token of facet.described) df.set(token, (df.get(token) ?? 0) + 1)
      }
      const total = facets.length
      const idf = (token) => Math.max(0, Math.log(total / (1 + (df.get(token) ?? 0))))

      /*
       * How much the inventory published about each capability, in words that
       * are not near-universal. 'local', 'agent' and 'js' come off every module
       * path in the manifest (193 of 214 records) and say nothing about which
       * capability this is; counting them as description is how a route whose
       * entire published identity is its own URL looks well described.
       */
      for (const facet of facets) {
        facet.vocabulary = [...facet.described].filter(
          (token) => idf(token) >= IDF_INFORMATIVE,
        ).length
      }

      /*
       * The route this corpus was READ FROM is not a capability this resolver
       * can hand back. It is the resolver's own input.
       *
       * audio_path_probe{mode:'capabilities'} resolved LIVE to GET
       * /capabilities and was really called: an audio tool was told its probe
       * IS the route manifest, and handed back the very document that produced
       * the answer. On lexical evidence that match is unimpeachable — the enum
       * value is the route's exact name — which is why no amount of scoring
       * removes it. It is excluded on a different ground: a resolution to the
       * publisher is self-reference, never new information, and every
       * resolution already reports `resolvedAgainst.from` so no agent loses
       * access to the manifest by this.
       *
       * This is not the name table the header rejects. It names nothing about
       * the system's features; it names the one record this resolver knows
       * something extra about because it fetched it, and it is derived from
       * the URL actually used rather than written down.
       */
      const publisher = facets.find(
        (facet) =>
          facet.record.kind === 'http' &&
          String(facet.record.invoke?.method ?? '').toUpperCase() === 'GET' &&
          `${facet.record.invoke?.baseUrl ?? ''}${facet.record.invoke?.path ?? ''}` ===
            `${base}/capabilities`,
      )

      CAPABILITY_CORPUS.corpus = {
        facets,
        publisherId: publisher?.record.id ?? null,
        publisherLabel: publisher ? capabilityLabel(publisher.record) : null,
        source: `${base}/capabilities`,
        service: manifest.service ?? null,
        routeCount: manifest.http.routes.length,
        actionCount: manifest.actions?.types?.length ?? 0,
        idf,
        /* Reported so a thin corpus is visible as a fact about the inventory
         * rather than as a run of confident-looking low scores. */
        vocabulary: {
          distinctTokens: df.size,
          medianPerCapability: [...facets.map((f) => f.vocabulary)].sort(
            (left, right) => left - right,
          )[Math.floor(facets.length / 2)],
          describedByNameOnly: facets.filter((f) => f.vocabulary <= 1).length,
        },
        /*
         * The surfaces this inventory does NOT cover, named by the manifest
         * itself (OFF_BOX_SURFACES). "Not found here" is only "absent" once
         * every surface has spoken, and none of these ever has: the relay
         * answers 401 on every path because its auth runs before its router, so
         * a probe cannot even tell absent from forbidden. Reported on every
         * resolution so a refusal reads as "I cannot see that far" rather than
         * "that does not exist".
         */
        unpublished: (manifest.surfaces ?? []).map((entry) => entry.surface),
      }
      return CAPABILITY_CORPUS
    } catch (error) {
      tried.push(`${base}/capabilities -> ${String(error?.message || error)}`)
    }
  }

  CAPABILITY_CORPUS.error =
    `No surface published a capability manifest, so no granted name could be resolved to anything real. Tried: ${tried.join('; ') || 'no base URL configured'}.`
  return CAPABILITY_CORPUS
}

/**
 * Every enum in a granted schema, at any depth, as a list of dispatch sites.
 *
 * The old version read `properties.X.enum` and `properties.X.items.enum` and
 * stopped, so `properties.X.items.properties.Y.enum` — an array of objects each
 * carrying a kind, which is how a model writes a batch API — was invisible.
 * mac_workspace_edit's operations[].kind and verify_operation_step's
 * postconditions[].kind are exactly that shape, and both tools were reported as
 * "(no selector)": the resolver told two agents their tools named no operation
 * when their schemas named eleven between them.
 *
 * A site is { path, leaf, values, at }:
 *   path  — how it reads in a report: 'command', 'operations[].kind'.
 *   leaf  — the property name a caller actually passes the value under. This
 *           is what identifies a chosen value in a CALL, at whatever depth.
 *   at    — the segment list, used to materialise one call per value.
 *
 * Bounded by RESOLVE_MAX_SCHEMA_DEPTH. Cycles (a $ref'd schema that contains
 * itself, or any hand-built object graph) terminate on the seen-set as well,
 * because a depth bound alone still walks 6 levels of a cycle.
 */
function schemaEnumSites(schema, { maxDepth = RESOLVE_MAX_SCHEMA_DEPTH } = {}) {
  const sites = []
  const seen = new Set()
  /* Subtrees the walk refused to enter. Counted rather than ignored: a schema
   * nested deeper than the bound has selectors that were never scored, which
   * is not the same fact as a schema that declares none. */
  const abandoned = []

  const walk = (spec, segments, depth) => {
    if (!spec || typeof spec !== 'object' || Array.isArray(spec)) return
    if (seen.has(spec)) return
    seen.add(spec)
    if (depth > maxDepth) {
      abandoned.push(segments.join('.').replace(/\.\[\]/g, '[]'))
      return
    }

    const leaf = [...segments].reverse().find((segment) => segment !== '[]')
    if (Array.isArray(spec.enum) && leaf) {
      const values = spec.enum.filter((value) => typeof value !== 'object').map(String)
      if (values.length) {
        sites.push({
          /* A trailing '[]' is elided: `directions[]=input` and
           * `directions=input` are the same statement, and the shorter one is
           * what every existing report line and score was measured under. */
          path: segments.join('.').replace(/\.\[\]/g, '[]').replace(/\[\]$/, ''),
          leaf,
          values,
          at: segments,
        })
      }
    }

    for (const [name, child] of Object.entries(spec.properties ?? {})) {
      walk(child, [...segments, name], depth + 1)
    }
    if (Array.isArray(spec.prefixItems)) {
      for (const child of spec.prefixItems) walk(child, [...segments, '[]'], depth + 1)
    }
    for (const child of Array.isArray(spec.items) ? spec.items : [spec.items]) {
      walk(child, [...segments, '[]'], depth + 1)
    }
    /* A union of shapes is several dispatch sites, not none. */
    for (const key of ['oneOf', 'anyOf', 'allOf']) {
      for (const child of Array.isArray(spec[key]) ? spec[key] : []) {
        walk(child, segments, depth + 1)
      }
    }
  }

  walk(schema, [], 0)
  return { sites, abandoned }
}

/**
 * The call a caller would have to write to select `value` at `site`.
 *
 * Built by walking the site's segments from the inside out. A terminal '[]' —
 * the `items.enum` case — collapses to the scalar, which is what the previous
 * enumeration produced and what invokeResolved's path-parameter substitution
 * reads; an interior '[]' becomes a one-element array, so operations[].kind
 * materialises as { operations: [{ kind: 'read' }] }.
 */
function callForSite(site, value) {
  let carried = value
  for (let index = site.at.length - 1; index >= 0; index -= 1) {
    const segment = site.at[index]
    if (segment === '[]') {
      if (index === site.at.length - 1) continue
      carried = [carried]
    } else {
      carried = { [segment]: carried }
    }
  }
  return carried && typeof carried === 'object' && !Array.isArray(carried)
    ? carried
    : { [site.leaf]: carried }
}

/**
 * One call per enum value, fairly divided when a schema declares more branches
 * than the bound allows.
 *
 * Even allocation first, then whatever budget is left goes back over the sites
 * in order. A tool whose first enum has 200 values does not get to swallow the
 * entire budget and leave its other selectors unenumerated — every site is
 * represented before any site gets a second turn.
 */
function callBranchesForSites(sites, { max = RESOLVE_MAX_CALL_BRANCHES } = {}) {
  const declared = sites.reduce((sum, site) => sum + site.values.length, 0)
  const taken = sites.map(() => 0)
  let budget = Math.max(0, max)

  const share = sites.length ? Math.max(1, Math.floor(budget / sites.length)) : 0
  for (let round = 0; round < 2 && budget > 0; round += 1) {
    for (let index = 0; index < sites.length && budget > 0; index += 1) {
      const want =
        round === 0
          ? Math.min(share, sites[index].values.length)
          : sites[index].values.length - taken[index]
      const give = Math.min(want, budget)
      taken[index] += give
      budget -= give
    }
  }

  const branches = []
  sites.forEach((site, index) => {
    for (const value of site.values.slice(0, taken[index])) {
      branches.push({
        label: `${site.path}=${value}`,
        site: site.path,
        value,
        args: callForSite(site, value),
      })
    }
  })

  return {
    branches,
    /* Reported, never silent: a truncated enumeration means "some of this
     * tool's branches were never scored", which is a different fact from
     * "they scored nothing". */
    truncated:
      branches.length < declared
        ? { declared, enumerated: branches.length, bound: max, sites: sites.length }
        : null,
  }
}

function leafStrings(value, out = []) {
  if (typeof value === 'string') out.push(value)
  else if (Array.isArray(value)) for (const item of value) leafStrings(item, out)
  else if (value && typeof value === 'object') {
    for (const [key, item] of Object.entries(value)) {
      out.push(key)
      leafStrings(item, out)
    }
  }
  return out
}

/** Everything the grant itself says, weighted by how much identity it carries. */
function grantEvidence(tool, args = {}) {
  const schema = asJsonSchema(tool.input_schema)
  const properties = schema.properties ?? {}
  const { sites, abandoned } = schemaEnumSites(schema)

  /* The property NAME a value arrives under, at whatever depth it was
   * declared. `kind` inside operations[] selects just as much as a top-level
   * `command` does, and a caller does not restate the path when it calls. */
  const selectorProps = new Set(sites.map((site) => site.leaf))
  const declaredEnums = Object.fromEntries(sites.map((site) => [site.path, site.values]))
  /* A top-level property is a selector if a dispatch site lives ANYWHERE
   * beneath it: `operations` is an array of tagged operations, which is a
   * selector container, not a handle a route could take as a path parameter. */
  const selectorRoots = new Set(
    sites.map((site) => site.at[0]).filter((name) => name && name !== '[]'),
  )
  const { branches: callBranches, truncated: budgetTruncated } =
    callBranchesForSites(sites)
  const branchesTruncated =
    budgetTruncated || abandoned.length
      ? {
          ...(budgetTruncated ?? {
            declared: callBranches.length,
            enumerated: callBranches.length,
            bound: RESOLVE_MAX_CALL_BRANCHES,
            sites: sites.length,
          }),
          ...(abandoned.length
            ? {
                deeperThan: RESOLVE_MAX_SCHEMA_DEPTH,
                unwalked: [...new Set(abandoned)].slice(0, 8),
              }
            : {}),
        }
      : null

  /* The enum values the caller chose FOR THIS CALL. The highest-signal thing in
   * the whole request: the agent's own word for the specific operation. Walked
   * to the same depth the schema was, so a value nested inside an array of
   * objects counts as the selection it is. */
  const chosen = []
  const collectChosen = (value, key, depth) => {
    if (depth > RESOLVE_MAX_SCHEMA_DEPTH) return
    if (typeof value === 'string') {
      if (key && selectorProps.has(key)) chosen.push(value)
    } else if (Array.isArray(value)) {
      /* An array keeps its property's name: {directions:['input']} chose
       * 'input' under 'directions'. */
      for (const item of value) collectChosen(item, key, depth + 1)
    } else if (value && typeof value === 'object') {
      for (const [name, item] of Object.entries(value)) {
        collectChosen(item, name, depth + 1)
      }
    }
  }
  collectChosen(args ?? {}, null, 0)

  const weight = new Map()
  const bump = (token, value) => {
    if (token) weight.set(token, Math.max(weight.get(token) ?? 0, value))
  }
  for (const value of chosen) for (const t of capabilityTokens(value, true)) bump(t, 1)
  for (const t of capabilityTokens(String(tool.name ?? ''), true)) {
    bump(t, NAME_EVIDENCE_WEIGHT)
  }
  for (const name of Object.keys(properties)) {
    for (const t of capabilityTokens(name, true)) bump(t, 0.15)
  }
  for (const text of leafStrings(tool.input_schema)) {
    for (const t of capabilityTokens(text)) bump(t, PROSE_EVIDENCE_WEIGHT)
  }
  for (const t of capabilityTokens(String(tool.why ?? ''))) bump(t, PROSE_EVIDENCE_WEIGHT)

  /* Anchors are what identifies THIS call, and nothing else. Prose is excluded
   * on purpose: `why` habitually names the capability the agent already has. */
  const anchors = new Map()
  for (const value of chosen) {
    for (const t of capabilityTokens(value, true)) anchors.set(t, 1)
  }
  for (const t of capabilityTokens(String(tool.name ?? ''), true)) {
    if (!anchors.has(t)) anchors.set(t, NAME_EVIDENCE_WEIGHT)
  }

  const required = Array.isArray(schema.required) ? schema.required : []
  return {
    weight,
    anchors,
    properties: Object.keys(properties),
    declaredEnums,
    selectorProps,
    chosen,
    /* Each call this tool's own schema permits, one selector at a time. */
    callBranches,
    branchesTruncated,
    /* A required property whose value is an enum is a dispatch selector, not a
     * handle; only free-form required properties are things a route could
     * consume as a path parameter. */
    freeRequired: required.filter((name) => !selectorRoots.has(name)),
  }
}

function suppliesParam(param, evidence, args) {
  const wanted = normalizeCapabilityName(param, { keepParams: true })
  const has = (name) => normalizeCapabilityName(name, { keepParams: true }) === wanted
  return evidence.properties.some(has) || Object.keys(args ?? {}).some(has)
}

/** GET is the only effect this harness will produce. See invokeResolved(). */
function isReadOnlyCapability(record) {
  return (
    record.kind === 'http' &&
    String(record.invoke?.method ?? '').toUpperCase() === 'GET'
  )
}

function scoreCapability(facet, evidence, args, idf) {
  /*
   * 1. INTENT. How much of what this call asked for does the capability
   *    account for, weighted by how rare each word is in the inventory.
   */
  let matched = 0
  let possible = 0
  for (const [token, weight] of evidence.anchors) {
    const value = weight * idf(token)
    possible += value
    if (facet.described.has(token)) matched += value
  }
  const intent = possible > 0 ? matched / possible : 0

  /*
   * 2. ARGUMENTS, structural rather than lexical, and the reason
   *    relay_job_status lands on GET /jobs/:jobId instead of GET /ops/status —
   *    which shares two of its three name tokens and would otherwise win. A
   *    route that consumes the handle the grant requires is a better fit than
   *    one that discards it, and a path parameter named jobId meeting a schema
   *    property named jobId is not a coincidence.
   */
  const params = facet.record.kind === 'http' ? facet.record.requires ?? [] : []
  let argumentFit
  if (params.length) {
    const supplied = params.filter((p) => suppliesParam(p, evidence, args)).length
    argumentFit = supplied / params.length
    if (evidence.freeRequired.length && supplied === 0) argumentFit = 0
  } else {
    /* No parameters: neutral, unless the grant requires a handle this thing
     * cannot take, which is evidence against it. */
    argumentFit = evidence.freeRequired.length ? 0.15 : 0.5
  }

  /*
   * 3. IDENTITY, the reverse direction. A capability whose own name contains
   *    words the grant never used is probably a neighbour of the right answer
   *    rather than the answer: this is what separates GET /jobs/:jobId from
   *    GET /jobs/:jobId/receipts, which are otherwise identical on every other
   *    measure. Prose-level evidence does not count here — only a selector or
   *    the tool's own name.
   */
  const identity = facet.identity.length
    ? facet.identity.filter(
        (token) => (evidence.weight.get(token) ?? 0) >= NAME_EVIDENCE_WEIGHT,
      ).length / facet.identity.length
    : 0

  /*
   * 4. SUPPORT. Not a fourth opinion about the match — a statement about how
   *    much evidence the other three were computed from. See the block above
   *    RESOLVE_WEIGHTS: intent and identity are RATIOS, and a ratio over a
   *    one-word description is noise wearing a number.
   *
   *    Agreement counts only INFORMATIVE tokens. 'local', 'agent' and 'js' are
   *    in 193 of the 214 records because every module path in the manifest ends
   *    in local-agent/something.js; three capabilities "agreeing" on those is
   *    not three agreements, and without the idf floor
   *    mac_read_diagnostics{checks:'local_agent_health'} would look
   *    triple-corroborated against GET /health when only 'health' means
   *    anything.
   */
  let agreement = 0
  for (const [token] of evidence.anchors) {
    if (facet.described.has(token) && idf(token) >= IDF_INFORMATIVE) agreement += 1
  }
  const vocabulary = facet.vocabulary ?? facet.described.size
  const support =
    agreement >= 2
      ? 1
      : Math.min(1, Math.max(SUPPORT_FLOOR, vocabulary / VOCABULARY_FOR_LONE_WORD))

  const evidenced =
    RESOLVE_WEIGHTS.intent * intent +
    RESOLVE_WEIGHTS.arguments * argumentFit +
    RESOLVE_WEIGHTS.identity * identity

  return {
    facet,
    score: evidenced * support,
    /* Kept so a discounted candidate can say what it would have scored had the
     * inventory described it — which is the actionable half of the refusal. */
    undiscounted: evidenced,
    support,
    agreement,
    vocabulary,
    intent,
    argumentFit,
    identity,
  }
}

function capabilityLabel(record) {
  return record.kind === 'http'
    ? `${record.invoke.method} ${record.invoke.path}`
    : `${record.kind}:${record.invoke?.action ?? record.invoke?.tool ?? record.name}`
}

/**
 * Why a candidate was discounted, in the terms that would fix it.
 *
 * Deliberately says what the INVENTORY failed to publish rather than what the
 * grant failed to say: the grant is the agent's and cannot be improved from
 * here, and the actionable repair is a description on the route.
 */
function poverty(entry) {
  return (
    `the match rests on ${entry.agreement === 1 ? 'a single word' : `${entry.agreement} words`} ` +
    `and the inventory publishes only ${entry.vocabulary} ` +
    `informative ${entry.vocabulary === 1 ? 'word' : 'words'} about that capability ` +
    `(${VOCABULARY_FOR_LONE_WORD} needed before one word may carry a match)`
  )
}

/**
 * Resolve one CALL of a granted tool against the running system.
 *
 * Outcomes: `resolved`, `ambiguous` (a real naming collision, reported with
 * both candidates), `unresolved` (nothing scored high enough), `unavailable`
 * (nothing published an inventory). Only the first is ever invoked, and only
 * when it is also a GET.
 */
async function resolveGrantedCall(tool, args = {}) {
  const { corpus, error } = await capabilityCorpus()
  if (!corpus) return { status: 'unavailable', why: error }

  const evidence = grantEvidence(tool, args)
  const ranked = corpus.facets
    /* See `publisher` in capabilityCorpus(): the endpoint this inventory was
     * read from is this resolver's input, not an answer it can return. */
    .filter((facet) => facet.record.id !== corpus.publisherId)
    .map((facet) => scoreCapability(facet, evidence, args, corpus.idf))
    .filter((entry) => entry.score > 0)
    .sort(
      (left, right) =>
        right.score - left.score ||
        /* Deterministic, and biased toward the option that cannot act. */
        Number(isReadOnlyCapability(right.facet.record)) -
          Number(isReadOnlyCapability(left.facet.record)) ||
        String(left.facet.record.invoke?.path ?? '').length -
          String(right.facet.record.invoke?.path ?? '').length ||
        left.facet.record.id.localeCompare(right.facet.record.id),
    )

  const best = ranked[0]
  const runnerUp = ranked[1]
  const nearest = ranked.slice(0, 3).map((entry) => ({
    capability: capabilityLabel(entry.facet.record),
    score: Number(entry.score.toFixed(3)),
    /* Only when it changed the answer, so the common case stays quiet. */
    ...(entry.support < 1
      ? {
          discountedFrom: Number(entry.undiscounted.toFixed(3)),
          because: poverty(entry),
        }
      : {}),
  }))
  const shared = {
    corpus: {
      from: corpus.source,
      routes: corpus.routeCount,
      actions: corpus.actionCount,
      noInventoryPublishedBy: corpus.unpublished,
      ...(corpus.publisherLabel
        ? {
            notAResolutionTarget: `${corpus.publisherLabel} published this inventory, so resolving to it would return this resolver's own input.`,
          }
        : {}),
    },
    nearest,
    selectors: evidence.chosen,
  }

  if (!best || best.score < RESOLVE_MIN_SCORE) {
    /*
     * The candidate that WOULD have won on lexical evidence alone, when the
     * poverty discount is what stopped it. Named separately because it is the
     * whole finding: "GET /capabilities looked like a 0.613 match on the word
     * 'capabilities' and nothing else was published about it" is a defect
     * report against the manifest, and printing only the surviving runner-up
     * hides it behind an unrelated route.
     */
    const suppressed = ranked
      .filter((entry) => entry.support < 1 && entry.undiscounted >= RESOLVE_MIN_SCORE)
      .sort((left, right) => right.undiscounted - left.undiscounted)[0]

    return {
      status: 'unresolved',
      why:
        `Nothing in the inventory scored ${RESOLVE_MIN_SCORE} against this call` +
        (best
          ? ` (best was ${capabilityLabel(best.facet.record)} at ${best.score.toFixed(3)}` +
            (best.support < 1
              ? `, discounted from ${best.undiscounted.toFixed(3)} because ${poverty(best)}`
              : '') +
            ')'
          : '') +
        '.' +
        (suppressed && suppressed !== best
          ? ` ${capabilityLabel(suppressed.facet.record)} would have cleared it at ` +
            `${suppressed.undiscounted.toFixed(3)} and was held back to ` +
            `${suppressed.score.toFixed(3)}: ${poverty(suppressed)}.`
          : ''),
      ...(suppressed
        ? {
            suppressedByPoverty: {
              capability: capabilityLabel(suppressed.facet.record),
              wouldHaveScored: Number(suppressed.undiscounted.toFixed(3)),
              scored: Number(suppressed.score.toFixed(3)),
              agreeingWords: suppressed.agreement,
              wordsPublishedAboutIt: suppressed.vocabulary,
            },
          }
        : {}),
      ...shared,
    }
  }

  const margin = runnerUp ? best.score - runnerUp.score : best.score
  /*
   * A near-tie is normally a refusal. The one exception is when the winner is a
   * read and the runner-up is not: the evidence cannot separate them, and
   * taking the option that cannot change anything costs a wasted GET at worst.
   * It is how GET /machine-context is chosen over POST /machine-context/refresh,
   * which score identically because they are the same idea at two effects.
   */
  const tieBrokenTowardRead =
    margin < RESOLVE_MIN_MARGIN - 1e-9 &&
    isReadOnlyCapability(best.facet.record) &&
    runnerUp &&
    !isReadOnlyCapability(runnerUp.facet.record)

  if (margin < RESOLVE_MIN_MARGIN - 1e-9 && !tieBrokenTowardRead) {
    return {
      status: 'ambiguous',
      why:
        `${capabilityLabel(best.facet.record)} and ${capabilityLabel(runnerUp.facet.record)} ` +
        `score within ${margin.toFixed(3)} of each other (${RESOLVE_MIN_MARGIN} required). ` +
        'Calling either would be a guess, so neither was called.',
      ...shared,
    }
  }

  return {
    status: 'resolved',
    capability: best.facet.record,
    label: capabilityLabel(best.facet.record),
    confidence: {
      score: Number(best.score.toFixed(3)),
      margin: Number(margin.toFixed(3)),
      /* A discounted match is never called high, whatever the arithmetic says:
       * the number went down precisely because there was less to go on. */
      band:
        best.support < 1
          ? 'low'
          : best.score >= 0.7
            ? 'high'
            : best.score >= 0.55
              ? 'medium'
              : 'low',
      components: {
        intent: Number(best.intent.toFixed(3)),
        arguments: Number(best.argumentFit.toFixed(3)),
        identity: Number(best.identity.toFixed(3)),
      },
      /* How much evidence the components were computed from, always reported:
       * a match on one word against a well-described capability and a match on
       * one word against a bare URL are different claims and used to print the
       * same number. */
      support: {
        factor: Number(best.support.toFixed(3)),
        agreeingWords: best.agreement,
        wordsPublishedAboutIt: best.vocabulary,
        ...(best.support < 1
          ? { note: `Score discounted from ${best.undiscounted.toFixed(3)}: ${poverty(best)}.` }
          : {}),
      },
      tieBrokenTowardRead: Boolean(tieBrokenTowardRead),
    },
    ...shared,
  }
}

/**
 * Read at most `maxBytes` of a response and stop pulling.
 *
 * response.text() would buffer the whole thing first, which on this machine
 * means 686 KB from GET /jobs before any truncation could help. The reader is
 * cancelled at the cap, so an endless stream (GET /thinking/stream is SSE) ends
 * at the cap or at the fetch deadline, whichever comes first.
 */
async function readCapped(response, maxBytes) {
  const reader = response.body?.getReader?.()
  if (!reader) {
    const text = await response.text()
    return {
      text: text.slice(0, maxBytes),
      truncated: text.length > maxBytes,
      bytes: text.length,
    }
  }

  const chunks = []
  let bytes = 0
  let truncated = false
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    bytes += value.length
    if (bytes >= maxBytes) {
      chunks.push(value.subarray(0, value.length - (bytes - maxBytes)))
      truncated = true
      try {
        await reader.cancel()
      } catch {
        /* Already closed; the cap is what mattered. */
      }
      break
    }
    chunks.push(value)
  }

  return {
    text: Buffer.concat(chunks.map((chunk) => Buffer.from(chunk))).toString('utf8'),
    truncated,
    bytes,
  }
}

/*
 * Read-only by default, decided from the route's own declared effect.
 *
 * These are reconnaissance agents working out what should exist. Nothing they
 * call is on the owner's behalf, so a resolution that would POST — /execute,
 * /plan, anything that writes, and every executor ACTION, which is only
 * reachable through POST /execute — is described and not performed. The test is
 * the method the manifest reports for the route, which is the surface's own
 * statement about the route rather than a list of URLs written here; the same
 * one rule covers all 74 non-GET routes and all 95 action types without naming
 * any of them.
 */
async function invokeResolved(resolution, args) {
  const record = resolution.capability
  if (!isReadOnlyCapability(record)) {
    return {
      invoked: false,
      wouldHaveCalled: resolution.label,
      why:
        record.kind === 'http'
          ? `${record.invoke.method} has side effects. This harness only performs GET, so nothing was called.`
          : `Executor actions are dispatched through POST /execute on the owner's real machine. This harness only performs GET, so nothing was called.`,
    }
  }

  let pathname = record.invoke.path
  for (const param of record.requires ?? []) {
    const key = Object.keys(args ?? {}).find(
      (name) =>
        normalizeCapabilityName(name, { keepParams: true }) ===
        normalizeCapabilityName(param, { keepParams: true }),
    )
    const value = key === undefined ? undefined : args[key]
    if (value === undefined || value === null || value === '') {
      return {
        invoked: false,
        wouldHaveCalled: resolution.label,
        why: `${resolution.label} needs a ${param} and this call did not carry one.`,
      }
    }
    pathname = pathname.replace(
      new RegExp(`[:{]${param}\\}?`),
      encodeURIComponent(String(value)),
    )
  }

  const url = `${record.invoke.baseUrl ?? MAC_AGENT_URL}${pathname}`
  try {
    const response = await fetchWithDeadline(url, {
      headers: { Authorization: `Bearer ${MAC_AGENT_TOKEN}` },
    })
    const { text, truncated, bytes } = await readCapped(response, RESOLVE_MAX_BYTES)
    return {
      invoked: true,
      called: `GET ${url}`,
      httpStatus: response.status,
      truncated,
      ...(truncated
        ? { bytesRead: bytes, note: `Response exceeded ${RESOLVE_MAX_BYTES} bytes and was cut off there.` }
        : {}),
      body: text,
    }
  } catch (error) {
    return {
      invoked: false,
      wouldHaveCalled: `GET ${url}`,
      why: String(error?.message || error),
    }
  }
}

/** The honest note, unchanged in substance, plus whatever was learned trying. */
function unimplementedNote(resolution) {
  const base =
    'This tool was granted a schema and could not be resolved to anything the running system actually has, so it has no implementation. Report what you would have done with it.'
  if (!resolution) return { error: base }
  return {
    error: base,
    resolution: resolution.status,
    why: resolution.why,
    /* The near-match the inventory was too thin to justify. An agent reading
     * this can file a defect against the manifest instead of renaming its
     * tool, which is the loop this whole resolver exists to end. */
    ...(resolution.suppressedByPoverty
      ? { suppressedByPoverty: resolution.suppressedByPoverty }
      : {}),
    ...(resolution.nearest ? { nearestRealCapabilities: resolution.nearest } : {}),
    ...(resolution.corpus ? { resolvedAgainst: resolution.corpus } : {}),
  }
}

/**
 * The general implementation for every granted tool that has no hand-written
 * one. Resolves the call, invokes it if and only if it is a defensible match to
 * a read-only route, and otherwise says exactly why not.
 */
async function runResolvedGrantedTool(tool, args) {
  const resolution = await resolveGrantedCall(tool, args)
  if (resolution.status !== 'resolved') return unimplementedNote(resolution)

  const outcome = await invokeResolved(resolution, args)
  return {
    resolvedTo: resolution.label,
    surface: resolution.capability.surface,
    what: resolution.capability.what ?? null,
    confidence: resolution.confidence,
    /* Named even on success: an agent that can see the runner-up can tell when
     * the match was a coin flip, which is the difference between a finding and
     * a confident mistake repeated for forty rounds. */
    alsoConsidered: resolution.nearest.slice(1),
    resolvedAgainst: resolution.corpus,
    ...outcome,
  }
}

/**
 * Which granted tools can actually act, for the system prompt.
 *
 * A tool is live if ANY of the calls its own schema permits resolves to a
 * read-only route: an enum tool is several capabilities behind one name, and
 * mac_read_diagnostics reaches GET /health and GET /machine-context on two of
 * its twelve checks and nothing on the other ten.
 */
async function grantedToolLiveness(state) {
  const live = []
  /*
   * Three buckets, not two. "Nothing matches" and "it matches something this
   * harness will not perform" are different facts, and collapsing them is how
   * browser-extension would be told its tools point at nothing when in fact
   * they land squarely on browser_navigate and browser_click — which is the
   * message that sent it renaming in the first place.
   */
  const described = []
  const dead = []
  for (const tool of state.granted.tools) {
    if (GRANTED_IMPLS[tool.name]) {
      live.push({ name: tool.name, reaches: ['a hand-written implementation'] })
      continue
    }
    const evidence = grantEvidence(tool, {})
    const calls = evidence.callBranches.length
      ? evidence.callBranches.map((branch) => branch.args)
      : [{}]

    const reads = new Set()
    const writes = new Set()
    for (const call of calls) {
      const resolution = await resolveGrantedCall(tool, call)
      if (resolution.status === 'unavailable') {
        return { live: [], described: [], dead: [], unavailable: true }
      }
      if (resolution.status !== 'resolved') continue
      ;(isReadOnlyCapability(resolution.capability) ? reads : writes).add(resolution.label)
    }
    /* A truncated enumeration means the buckets below are a lower bound, and
     * the prompt says so rather than presenting them as complete. */
    const partial = evidence.branchesTruncated
      ? {
          onlySomeBranchesChecked: `${evidence.branchesTruncated.enumerated} of ${evidence.branchesTruncated.declared}`,
        }
      : {}
    if (reads.size) live.push({ name: tool.name, reaches: [...reads].sort(), ...partial })
    else if (writes.size) {
      described.push({ name: tool.name, reaches: [...writes].sort(), ...partial })
    } else dead.push(tool.name)
  }
  return { live, described, dead, unavailable: false }
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

async function callModel(input, tools, instructions, model = MODEL) {
  const response = await fetchWithDeadline(
    `${API_BASE}/responses`,
    {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        model,
        instructions,
        input,
        tools,
        tool_choice: 'auto',
        max_output_tokens: 8192,
      }),
    },
    MODEL_TIMEOUT_MS,
  )
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
          /*
           * Asked for BEFORE `missing`, in the same call, because the corpus
           * says the agents are not short of facts — they are short of
           * composition. The single most-restated request here was proposed
           * eighteen times, and every piece of it already shipped: the /jobs
           * queue, /jobs/:jobId/receipts, and /v1/pendant/announce, the last of
           * which is on the requesting agent's own surface. An inventory does
           * not show a path through itself, so this makes naming the path a
           * condition of proposing rather than a thing to remember.
           */
          built_from: {
            type: 'array',
            items: { type: 'string' },
            description:
              'Exact routes or tools from the established list in your prompt that this would be built out of. Look before you answer — most of what gets proposed here already exists in pieces. If you cannot name any, say so explicitly rather than leaving it empty.',
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
          'built_from',
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

THE HARDWARE IS LIVE AS OF NOW. Both chips are physically connected to the owner's Mac over USB serial — the nRF9160 pendant on /dev/cu.usbmodem00096003658* and the ESP32 audio bridge on /dev/cu.usbserial-0287A9CA. It has NOT registered with the relay, so anything assuming an LTE-registered device is currently false, but a worn device attached to the Mac is real and testable today. Proposals that were hypothetical yesterday are things somebody could actually run now. Prefer those.

Be more aggressive than you have been. At least THREE capabilities a round, and at least one that would be the single most useful thing this system does if it existed. Do not pace yourself, do not hedge toward what is nearly wired up, and do not spend a round on infrastructure that merely makes the system tidier — the owner cannot feel a refactor. If an idea seems too ambitious, that is the one to write down: say what it needs and mark what is missing.

A blunt measurement about your own output. Across 1,761 proposals from nine agents, only nine ideas were reached by more than one agent, and one agent restated a single idea eighteen times. Restating is the failure mode here, not silence. The recorder now REFUSES a proposal that restates an existing one and hands you back what it collided with — when that happens, do not rephrase it, go somewhere else entirely.

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

  if (name === 'recall') {
    const found = COMMONS_ON ? recallFromCommons(OUT_DIR, args.key, { forAgent: AGENT_ID }) : null
    result = found
      ? {
          key: found.key,
          establishedBy: found.observers,
          ageSeconds: found.ageSeconds,
          confirmations: found.confirmations,
          absent: found.absent,
          content: found.content,
        }
      : {
          error: `Nothing under "${args.key}". It may have expired; the directory in your prompt lists what is current.`,
        }
    process.stdout.write(
      `  recall(${args.key}) ${found ? `→ ${found.ageSeconds}s old` : '→ miss'}\n`,
    )
    return { result, finish }
  }

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
    result = recordIfNovel(state, args, {
      kind: 'capability',
      into: (state.proposals ||= []),
      describe: (item) => [item.user_asks, item.why_useful].filter(Boolean).join(' '),
      announce: () => process.stdout.write(`  IDEA "${args.user_asks}"\n`),
      note: 'Noted. Keep going — propose others, including ones that need capabilities that do not exist yet.',
      extra: reachabilityNote(args),
    })
  } else if (name === 'propose_change') {
    result = recordIfNovel(state, args, {
      kind: 'change',
      into: (state.changes ||= []),
      describe: (item) => [item.change, item.why].filter(Boolean).join(' '),
      announce: () => process.stdout.write(`  CHANGE [${args.layer}] ${args.change.slice(0, 70)}\n`),
      note: 'Noted. Keep going, including layers you have not touched yet.',
    })
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
      /*
       * Spelled out at the point of asking, because agents have been requesting
       * tools expecting to receive working ones. 141 requests accumulated
       * unanswered while agents waited on them, so the honest thing is to say
       * that a request is a message to the orchestrator rather than a way to
       * get unblocked in this round.
       */
      note:
        kind === 'tool'
          ? 'Queued for the orchestrator. If it is granted, it will be resolved against the running system when you call it — real and read-only means it runs, anything else means you get a description or a refusal with the nearest real capabilities. Carry on with what you already have and do not wait on this.'
          : 'Queued for the orchestrator. An answer arrives in a later round if at all, so carry on rather than waiting.',
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
      /*
       * Every other granted tool goes through the general resolver rather than
       * straight to the refusal it used to get. GRANTED_IMPLS keeps precedence
       * because those three were written and reviewed deliberately; everything
       * else is resolved against the running system's own inventory, and the
       * honest refusal is still what comes back when nothing matches.
       */
      result = await runResolvedGrantedTool(granted, args)
      process.stdout.write(
        `  ${name} → ${
          result.error
            ? 'unresolved'
            : `${result.resolvedTo} ${result.invoked ? `called ${result.httpStatus}` : 'described only'}`
        }\n`,
      )
    } else {
      result = { error: `Unknown tool: ${name}` }
    }
  }

  transcript.push({ type: 'tool', name, args, result })
  depositIfObservation(name, args, result, state)
  return { result, finish }
}

/*
 * Every read an agent performs is banked for every other agent, here, in the
 * executor — never as a tool the agent is asked to call afterwards.
 *
 * A discrete "write what you learned" step is the first thing dropped when a
 * budget gets tight, which is the likeliest reason earlier shared-state
 * attempts on this project had nothing in them to read. Hutchins' cockpit
 * marker is the standard to hold to: setting it IS the act of deciding the
 * speed, not a chore that follows it.
 *
 * Only observations of the world are deposited. Proposals, findings and
 * messages are an agent's own output, and banking those as established fact
 * would let one agent's opinion arrive in every other agent's prompt wearing
 * the clothes of something that was measured.
 */
/*
 * Named rather than inferred, and deliberately not "everything that is not an
 * output tool". These five are the reads the harness implements itself, so it
 * knows they observe the world without changing it. Tools an agent was granted
 * later are excluded on purpose: the harness cannot tell whether one of them
 * mutates, and banking the result of an action as an established fact would put
 * the outcome of one agent's side effect into every other agent's prompt as
 * though it were a standing property of the system.
 */
const OBSERVATION_TOOLS = new Set([
  'list_capabilities',
  'discover',
  'describe',
  'probe_http',
  'get_hardware_spec',
])

/*
 * Recon is meant to stop an agent designing before it has looked. Nothing ever
 * ended it: the phase only moved when someone typed the phase command, so an
 * agent nobody remembered to promote stayed in recon forever and could not
 * record a proposal at all — the propose tools are simply not in its list.
 *
 * That is not an unproductive agent, it is a silenced one, and it is
 * indistinguishable from the real thing in every summary. faculty-action sat
 * here for eighteen rounds, spending 32-42 calls each, saying in plain text
 * that it had a proposal and no tool to record it with. Twice its round ended
 * on a request for the tool it was already supposed to have.
 *
 * Three rounds, because promotion costs nothing: the capability phase ADDS the
 * propose tools, it does not take the discovery tools away. An agent can go on
 * looking for as long as it likes afterwards. So the only thing staying in
 * recon can buy is the discipline of looking first, which is worth a couple of
 * rounds and is not worth eighteen.
 */
const RECON_MAX_ROUNDS = 3

function advanceOutOfRecon(state) {
  if (state.phase !== 'recon' || state.round < RECON_MAX_ROUNDS) return

  state.phase = 'capability'
  process.stdout.write(
    `  [phase] recon -> capability after ${state.round} rounds; ` +
      'propose_capability and propose_change are available from the next round.\n',
  )
}

/*
 * Refuse to record what the system already has.
 *
 * The capability prompt has always said "do not restate anything already in the
 * backlog", and the backlog is in the agent's context when it reads that. It did
 * not work: 11 near-duplicate pairs across 204 ledger entries, one of them
 * word-for-word, from different agents in different rounds. An instruction not
 * to repeat yourself is advice.
 *
 * Compared against the whole ledger rather than this agent's own proposals,
 * because the duplicates are mostly across agents — which is the same
 * rediscovery problem the commons exists for, wearing different clothes.
 */
function recordIfNovel(state, args, { kind, into, describe, announce, note, extra }) {
  const priorEntries = [...(state.proposals || []), ...(state.changes || []), ...ledgerEntries()]
  const collision = findDuplicate(args, priorEntries, describe)

  if (collision?.verdict === 'block') {
    process.stdout.write(
      `  DUP ${kind} ~${collision.score.toFixed(2)} of "${describe(collision.entry).slice(0, 60)}"\n`,
    )
    /*
     * A block is the only place agreement is ever observed, so discarding it
     * threw away the one signal worth having. The gate exists to keep the
     * backlog from filling with restatements, but "this agent independently
     * arrived at something already recorded" is exactly what tells you a gap is
     * real rather than one agent's hobby horse. Suppressing the row and the
     * evidence together left the ledger unable to distinguish the two.
     *
     * Recorded into this agent's own state, never into the ledger directly:
     * rounds run concurrently and each agent may write only its own file.
     */
    if (collision.entry?.id) {
      ;(state.echoes ||= []).push({
        id: collision.entry.id,
        round: state.round,
        score: Number(collision.score.toFixed(2)),
      })
    }
    return {
      recorded: false,
      why: 'This restates something the system already has, so it was not recorded.',
      alreadyHave: describe(collision.entry).slice(0, 400),
      itsId: collision.entry.id ?? null,
      /* Naming what it collided with, rather than only refusing, is the
       * difference between a gate and a dead end — the agent can build past
       * something it can see. */
      next: 'Propose something this does not already cover, or say what it should become that it is not today.',
    }
  }

  announce()
  into.push({ ...args, round: state.round })
  return {
    recorded: true,
    note,
    ...(extra || {}),
    ...(collision
      ? {
          closeTo: describe(collision.entry).slice(0, 200),
          similarity: Number(collision.score.toFixed(2)),
          heedThis:
            'Recorded, but it is close to the above. If it is the same idea, the backlog now has it twice.',
        }
      : {}),
  }
}

/*
 * Tell an agent how much of what it just proposed already exists.
 *
 * Not a gate. "All of these exist" is sometimes exactly right — the connective
 * tissue between three shipped endpoints is real work — and sometimes it means
 * a shipped feature has been re-requested for the eighteenth time. An agent
 * that can see the difference can make it; a gate that guessed would suppress
 * the first case in order to catch the second.
 */
function reachabilityNote(args) {
  if (!COMMONS_ON) return null

  try {
    const entries = [...commonsFold(OUT_DIR, { forAgent: AGENT_ID }).values()]
    const known = knownPrimitives(entries, (entry) =>
      recallFromCommons(OUT_DIR, entry.key, { forAgent: AGENT_ID })?.content,
    )
    const check = checkReachability(args.built_from, known)

    if (check.verdict === 'unnamed') {
      return {
        builtFrom:
          'You named nothing this would be built from. Most of what gets proposed here already exists in pieces — the established list in your prompt is where to look.',
      }
    }
    if (check.verdict === 'assembled') {
      process.stdout.write(`  BUILT-FROM ${check.found.length}/${check.claimed} already exist\n`)
      return {
        builtFrom: `All ${check.claimed} pieces you named already exist: ${check.found.slice(0, 6).join(', ')}. So this is connective work rather than a new capability — say what is missing BETWEEN them, or whether it is already reachable today and nobody has wired it up.`,
      }
    }
    return {
      builtFrom: `${check.found.length} of ${check.claimed} pieces you named are already known to this system. The rest are not in what anyone here has observed yet: ${check.unseen.slice(0, 6).join(', ')}. That is not proof they do not exist — no agent has inventoried every surface — so check before treating them as the gap.`,
    }
  } catch (error) {
    /* A reachability check that fails is a missing hint, not a failed round. */
    return { builtFrom: `Could not check what this is built from: ${error.message}` }
  }
}

function depositIfObservation(name, args, result, state) {
  if (!COMMONS_ON || !OBSERVATION_TOOLS.has(name)) return
  try {
    depositToCommons(OUT_DIR, {
      tool: name,
      args,
      result,
      agent: AGENT_ID,
      round: state.round,
    })
  } catch (error) {
    /* The commons is an optimisation. A store that cannot be written is a
     * slower round, not a failed one — never take a round down for it. */
    process.stdout.write(`  [commons] deposit failed: ${error.message}\n`)
  }
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

  /* Measured before the prompt is written, so the prompt can say which of the
   * agent's tools are live instead of asserting that none of them are. */
  GRANTED_LIVENESS = state.granted.tools.length
    ? await grantedToolLiveness(state)
    : null
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

  await proposalPhase(state, tools, instructions, input, transcript, asked)

  for (const m of inboxFor(AGENT_ID, state)) state.readMessages.push(m.id)
  /* Stamped into the round, not left to the shell that launched it. Which arm
   * a round belonged to has already been guessed wrong once on this project,
   * and a guess about the condition invalidates every number derived from it. */
  state.rounds.push({ round: state.round, commons: COMMONS_ON, transcript })
  advanceOutOfRecon(state)
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

  /*
   * An agent in recon has no propose_* tools at all, so it reports "0
   * capabilities, 0 changes" no matter how well it did. Two agents sat there
   * for 16 and 20 rounds respectively and their zeros were read as evidence
   * about architecture. The phase belongs next to the number it explains.
   */
  process.stdout.write(
    `\nRound ${state.round} done [${state.phase}${
      state.phase === 'recon' ? ' — cannot propose in this phase' : ''
    }]. ` +
      counts
        .map(([n, one, many]) => `${n} ${n === 1 ? one : (many ?? `${one}s`)}`)
        .join(', ') +
      `.\n` +
      `Review:  node scripts/derive-harness.mjs review\n`,
  )
}

/* Discovery is unbounded and proposing is not, so when both draw on one step
 * budget discovery wins every time. Measured: the unified agent spent 60 steps
 * on lookups and probes and finished 11 consecutive rounds having proposed
 * nothing, while agents on a 6-step budget proposed immediately because they
 * had no room to do anything else. More budget made it strictly worse. */
const PROPOSAL_STEPS = 8

/**
 * Run the proposal phase on the context the discovery phase built.
 *
 * The whole `input` array carries over — every tool result, every observation,
 * the model's own reasoning items. Nothing is summarised and nothing is
 * re-derived, which is the point: a phase that had to rediscover the system
 * would just be another discovery phase.
 *
 * The discovery tools are withheld here. Not as a punishment — as the thing
 * that makes the phase exist. Left available they get used, because looking is
 * always locally cheaper than committing to a claim.
 */
async function proposalPhase(state, tools, instructions, input, transcript, asked) {
  const discoveryNames = new Set(DISCOVERY_TOOLS.map((tool) => tool.name))
  const proposalTools = tools.filter((tool) => !discoveryNames.has(tool.name))

  input.push({
    role: 'user',
    content:
      'Stop looking. You cannot discover anything further this round; those tools are gone. ' +
      'What you have already found is what you have to work with. ' +
      'Name what the owner should be able to have that they cannot have today, and what would have to change for them to have it. ' +
      'Do not restate anything already in the backlog, and do not trim an idea to fit what is currently wired up.\n\n' +
      /* Prose is invisible to everything downstream: the ledger, the review
       * command and the round counters all read the tool calls. An earlier
       * version of this phase produced a detailed, genuinely good proposal as
       * a paragraph, and the round recorded it as nothing. */
      'Record it by CALLING propose_capability or propose_change. Writing it as text does not record it — anything not passed to a tool is discarded when this round ends.',
  })

  /* The realtime model holds the live conversation but is not served by the
   * responses API, so a realtime agent's proposal phase would 404 and its
   * round would silently produce nothing -- the exact failure this whole
   * phase exists to stop. It proposes with the text model instead. */
  const proposalModel = IS_REALTIME
    ? process.env.LLM_MODEL || 'gpt-5.6-luna'
    : MODEL

  process.stdout.write(`  [phase] proposing on the context already gathered\n`)

  for (let step = 0; step < PROPOSAL_STEPS; step += 1) {
    const payload = await callModel(
      input,
      proposalTools,
      instructions,
      proposalModel,
    )
    const output = payload.output || []
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
    /*
     * This used to say the tool "still needs an implementation in this script
     * before it does anything". That predates the resolver and has been false
     * since it landed: nothing is hand-written for a granted tool any more, and
     * calling one scores it against the running system's own manifest. Saying
     * otherwise sent whoever ran `grant` looking for a switch statement to
     * extend, which is the table the resolver exists to avoid.
     */
    process.stdout.write(
      `Granted the SCHEMA for ${request.name}. No code is needed here: each CALL is\n` +
        `resolved against the running system's own capability manifest, and a defensible\n` +
        `match to a read-only route really runs, a match to anything with side effects is\n` +
        `described instead, and no match returns that verdict with the nearest real\n` +
        `capabilities. Enum values resolve one at a time, so branches differ.\n` +
        `Run \`node scripts/derive-harness.mjs resolve\` to see what this one lands on.\n`,
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
  const response = await fetchWithDeadline(`${RELAY_URL}/v1/ops/voice-runs`, {
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

/**
 * What every granted tool in the system resolves to, without running a round.
 *
 * The audit for the resolver: it reads every agent's state, enumerates each
 * tool's own enum branches, and prints what each branch lands on and at what
 * confidence. A weight that starts mis-ranking things shows up here as a table
 * that reads wrong, which is the only way anyone would notice.
 */
async function reportResolution() {
  /* Handles a route needs and a granted call cannot invent — `resolve --invoke
   * jobId=local_abc` is how GET /jobs/:jobId gets checked against a real job. */
  const extraArgs = Object.fromEntries(
    process.argv
      .slice(3)
      .filter((arg) => /^[A-Za-z0-9_]+=/.test(arg))
      .map((arg) => [arg.slice(0, arg.indexOf('=')), arg.slice(arg.indexOf('=') + 1)]),
  )
  const files = fs
    .readdirSync(OUT_DIR)
    .filter((name) => /^state-.*\.json$/.test(name))
    .sort()

  const { corpus, error } = await capabilityCorpus()
  process.stdout.write(
    corpus
      ? `Inventory: ${corpus.routeCount} routes + ${corpus.actionCount} action types from ${corpus.source}\n` +
        /* How much there is to match on, before any tool is scored. A thin
         * corpus is the precondition for every confident false positive this
         * resolver has produced, so it is stated first. */
        `Vocabulary: ${corpus.vocabulary.distinctTokens} distinct tokens, median ` +
        `${corpus.vocabulary.medianPerCapability} informative words per capability, ` +
        `${corpus.vocabulary.describedByNameOnly} described by name alone ` +
        `(a lone word carries a match at ${VOCABULARY_FOR_LONE_WORD})\n` +
        `No inventory published by: ${corpus.unpublished.join(', ') || 'nothing'}\n\n`
      : `${error}\n\n`,
  )
  if (!corpus) return

  for (const file of files) {
    const agent = file.replace(/^state-|\.json$/g, '')
    const state = JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), 'utf8'))
    for (const tool of state.granted?.tools ?? []) {
      const evidence = grantEvidence(tool, {})
      const calls = evidence.callBranches.length
        ? evidence.callBranches
        : [{ label: '(no selector)', args: {} }]

      process.stdout.write(`\n${agent} :: ${tool.name}\n`)
      if (GRANTED_IMPLS[tool.name]) {
        process.stdout.write('  (hand-written implementation in GRANTED_IMPLS takes precedence)\n')
      }
      /* Said out loud: an enumeration that stopped early is a different claim
       * from one that finished and found nothing. */
      if (evidence.branchesTruncated) {
        const cut = evidence.branchesTruncated
        const said = []
        if (cut.enumerated < cut.declared) {
          said.push(
            `${cut.enumerated} of ${cut.declared} selector values across ${cut.sites} ` +
              `enums were enumerated (bound ${cut.bound})`,
          )
        }
        if (cut.unwalked) {
          said.push(
            `nested deeper than ${cut.deeperThan} and not walked: ${cut.unwalked.join(', ')}`,
          )
        }
        process.stdout.write(
          `  TRUNCATED — ${said.join('; ')}. The branches below are a subset.\n`,
        )
      }
      for (const { label, args: call } of calls) {
        const resolution = await resolveGrantedCall(tool, call)
        /* What the AGENT would actually receive, not a summary of it — the
         * shape is half of what makes this usable and the only way to check it
         * is to look. */
        if (process.argv.includes('--json')) {
          const seen = await runResolvedGrantedTool(tool, { ...call, ...extraArgs })
          process.stdout.write(
            `  ${label}\n${JSON.stringify(seen, null, 2).replace(/^/gm, '    ')}\n`,
          )
          continue
        }
        if (resolution.status !== 'resolved') {
          process.stdout.write(
            `  ${label.padEnd(38)} ${resolution.status.toUpperCase()} — ${resolution.why}\n`,
          )
          continue
        }
        const live = isReadOnlyCapability(resolution.capability)
        process.stdout.write(
          `  ${label.padEnd(38)} ${live ? 'LIVE  ' : 'DESCR '} ${resolution.label.padEnd(36)} ` +
            `score=${resolution.confidence.score} margin=${resolution.confidence.margin}` +
            /* --why is how the support model gets audited: a resolution that
             * stands on one word looks exactly like one that stands on four
             * until the counts are printed beside it. */
            (process.argv.includes('--why')
              ? ` agree=${resolution.confidence.support.agreeingWords}` +
                ` vocab=${resolution.confidence.support.wordsPublishedAboutIt}` +
                ` sup=${resolution.confidence.support.factor}` +
                ` [i=${resolution.confidence.components.intent}` +
                ` a=${resolution.confidence.components.arguments}` +
                ` id=${resolution.confidence.components.identity}]`
              : '') +
            `${resolution.confidence.tieBrokenTowardRead ? ' (tie→read)' : ''}\n`,
        )
        /*
         * --invoke actually performs the reads, which is the only way to find
         * out that a resolution the table calls LIVE really answers. A
         * resolution nobody has ever executed is a claim, not a capability.
         */
        if (live && process.argv.includes('--invoke')) {
          const outcome = await runResolvedGrantedTool(tool, { ...call, ...extraArgs })
          process.stdout.write(
            `  ${''.padEnd(38)}   -> ${
              outcome.invoked
                ? `HTTP ${outcome.httpStatus}, ${outcome.body.length} bytes${outcome.truncated ? ` (capped from ${outcome.bytesRead})` : ''}`
                : `not called: ${outcome.why}`
            }\n`,
          )
        }
      }
    }
  }
}

const command = process.argv[2] || 'run'

/*
 * Read-only commands are deliberately not gated: review and prompt are what you
 * reach for to see what a stuck agent is doing, and they would be useless if
 * they refused while it was running.
 */
const MUTATES_STATE = new Set(['run', 'task', 'grant', 'deny', 'phase', 'reset'])

try {
  /* Inside the try so a refusal reads as one line in a launcher log, not a
   * stack trace — this is the message a person skims at 3am. */
  if (MUTATES_STATE.has(command)) {
    acquireStateLock()
    process.on('exit', releaseStateLock)
    for (const signal of ['SIGINT', 'SIGTERM', 'SIGHUP']) {
      /* A killed launcher must not strand its agent behind its own lock. */
      process.on(signal, () => {
        releaseStateLock()
        process.exit(128 + (signal === 'SIGINT' ? 2 : signal === 'SIGTERM' ? 15 : 1))
      })
    }
  }

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
  else if (command === 'prompt') {
    const state = loadState()
    GRANTED_LIVENESS = state.granted.tools.length
      ? await grantedToolLiveness(state)
      : null
    process.stdout.write(`${buildSystemPrompt(state)}\n`)
  } else if (command === 'describe') {
    /*
     * The same describe() the agent calls, reachable without spending a round.
     * It was only ever behind the model loop, so the only way to find out what
     * an agent would be told about a name was to pay for a round and read the
     * transcript — which is how describe() went on returning "Nothing named …"
     * for every granted device skill without anyone noticing. Read-only, and
     * deliberately not in MUTATES_STATE: it makes no model call and writes
     * nothing.
     */
    const wanted = process.argv[3]
    if (!wanted) throw new Error('describe needs a name: describe offline_moment_bookmark')
    const state = loadState()
    process.stdout.write(`${JSON.stringify(await describeThing(wanted, state), null, 2)}\n`)
  } else if (command === 'resolve') await reportResolution()
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
    process.stdout.write('Commands: run | review | grant <id> | deny <id> | phase <recon|capability> | ablate | evals | prompt | describe <name> | resolve | reset\n')
  }
} catch (error) {
  process.stderr.write(`${error.message}\n`)
  process.exitCode = 1
}

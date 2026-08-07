#!/usr/bin/env node
/*
 * What a migrated context is actually worth, measured on a real crossing.
 *
 * Two bodies, two models, one network boundary, and the only difference
 * between the arms is whether the receiving body inherits the first body's
 * thread or starts cold the way it does today:
 *
 *   producer   gpt-4.1-mini   discovers, then stores its thread on the relay
 *   receiver   gpt-5.6-luna   plans the same task, COLD vs RESUMED
 *
 * Everything here is real: a relay process on a spare port, the real
 * /v1/context and /v1/context/resume routes, the real store, the real
 * shared/contextHandoff.js packing and local-agent/contextResume.js pulling,
 * and real tools over this repository. The numbers reported are the provider's
 * own usage counters, not estimates — including cached_tokens, so the claim
 * about prefix caching is checked rather than asserted.
 *
 *   node scripts/measure-context-handoff.mjs [--runs 3] [--relay-port 8799]
 *
 * It costs real tokens. Keep --runs small.
 */
import { spawn } from 'node:child_process'
import fs from 'node:fs'
import path from 'node:path'
import process from 'node:process'
import { fileURLToPath } from 'node:url'

import '../../load-pendant-env.mjs'
import { resumeContext } from '../local-agent/contextResume.js'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const ROOT = path.resolve(HERE, '..')

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const RUNS = Number(flag('runs', 3))
const RELAY_PORT = Number(flag('relay-port', 8799))
const RELAY_URL = `http://127.0.0.1:${RELAY_PORT}`
const API_KEY = process.env.OPENAI_API_KEY
const RELAY_API_KEY = process.env.RELAY_API_KEY
const PRODUCER_MODEL = flag('producer-model', 'gpt-4.1-mini')
const RECEIVER_MODEL = flag('receiver-model', process.env.LLM_MODEL || 'gpt-5.6-luna')
const MAX_STEPS = 12

/*
 * The request, phrased as the pendant would deliver it. Deliberately something
 * this repository can actually answer, so "discovery" means reading real files
 * rather than hallucinating about a fictional system.
 */
const OWNER_REQUEST =
  "The agent's voice comes out of the pendant sounding distorted. Work out what in this codebase is responsible for the pendant's audio sample rate and resampling, and what should change."

/* What the Mac is asked to produce. Same for both arms — the arms differ only
 * in whether the thread above it was inherited. */
const RECEIVER_TASK =
  'Produce the Mac action plan for that request. Reply with JSON only: {"actions":[{"type":"...","label":"...","params":{...}}],"rationale":"..."}. You may use the tools to check anything you are not sure of.'

/* ---- real tools over this repository ------------------------------------ */

const TOOLS = [
  {
    type: 'function',
    function: {
      name: 'list_dir',
      description: 'List files in a directory of the project.',
      parameters: {
        type: 'object',
        properties: { path: { type: 'string' } },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'read_file',
      description: 'Read the first lines of a project file.',
      parameters: {
        type: 'object',
        properties: {
          path: { type: 'string' },
          maxLines: { type: 'number' },
        },
        required: ['path'],
      },
    },
  },
  {
    type: 'function',
    function: {
      name: 'search_repo',
      description: 'Search the project for a regular expression.',
      parameters: {
        type: 'object',
        properties: { pattern: { type: 'string' } },
        required: ['pattern'],
      },
    },
  },
]

function insideRoot(candidate) {
  const resolved = path.resolve(ROOT, candidate || '.')
  return resolved.startsWith(ROOT) ? resolved : null
}

async function runTool(name, args) {
  try {
    if (name === 'list_dir') {
      const dir = insideRoot(args.path)
      if (!dir) return { ok: false, error: 'outside the project' }
      return {
        ok: true,
        entries: fs
          .readdirSync(dir, { withFileTypes: true })
          .filter((entry) => entry.name !== 'node_modules')
          .slice(0, 80)
          .map((entry) => (entry.isDirectory() ? `${entry.name}/` : entry.name)),
      }
    }

    if (name === 'read_file') {
      const file = insideRoot(args.path)
      if (!file || !fs.existsSync(file)) return { ok: false, error: 'no such file' }
      const lines = fs.readFileSync(file, 'utf8').split('\n')
      const limit = Math.min(Number(args.maxLines) || 120, 200)
      return { ok: true, path: args.path, lines: lines.slice(0, limit).join('\n') }
    }

    if (name === 'search_repo') {
      const { execFileSync } = await import('node:child_process')
      const out = execFileSync(
        'grep',
        ['-rnE', '--include=*.js', '--include=*.mjs', '--include=*.c', '--include=*.h', args.pattern, '.'],
        { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 << 20 },
      )
      return { ok: true, matches: out.split('\n').slice(0, 40) }
    }
  } catch (error) {
    return { ok: false, error: String(error.message).slice(0, 300) }
  }

  return { ok: false, error: `unknown tool ${name}` }
}

/* ---- the model loop ----------------------------------------------------- */

async function callModel({ model, messages, tools, cacheKey }) {
  const response = await fetch('https://api.openai.com/v1/chat/completions', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`,
    },
    body: JSON.stringify({
      model,
      messages,
      ...(tools ? { tools } : {}),
      ...(cacheKey ? { prompt_cache_key: cacheKey } : {}),
      /* gpt-5.x rejects function tools on /v1/chat/completions unless
       * reasoning is off. Applied to both arms so the comparison stays fair. */
      ...(/^gpt-5/.test(model) ? { reasoning_effort: 'none' } : {}),
      max_completion_tokens: 2000,
    }),
  })

  const payload = await response.json()
  if (!response.ok) {
    throw new Error(payload?.error?.message || `HTTP ${response.status}`)
  }
  return payload
}

/**
 * Run one body to completion, counting what it had to look up.
 *
 * `discoveryCalls` is the number the whole exercise turns on: it is the work
 * the receiving body does purely to learn what the sending body already knew.
 */
async function runBody({ model, messages, cacheKey = null, label }) {
  const startedAt = Date.now()
  const usage = {
    promptTokens: 0,
    completionTokens: 0,
    cachedTokens: 0,
    apiCalls: 0,
  }
  let discoveryCalls = 0
  const transcript = [...messages]
  let answer = ''

  for (let step = 0; step < MAX_STEPS; step += 1) {
    const payload = await callModel({
      model,
      messages: transcript,
      tools: TOOLS,
      cacheKey,
    })

    usage.apiCalls += 1
    usage.promptTokens += payload.usage?.prompt_tokens || 0
    usage.completionTokens += payload.usage?.completion_tokens || 0
    usage.cachedTokens += payload.usage?.prompt_tokens_details?.cached_tokens || 0

    const message = payload.choices?.[0]?.message
    if (!message) break
    transcript.push(message)

    const calls = message.tool_calls || []
    if (!calls.length) {
      answer = message.content || ''
      break
    }

    for (const call of calls) {
      discoveryCalls += 1
      let parsed = {}
      try {
        parsed = JSON.parse(call.function.arguments || '{}')
      } catch {
        parsed = {}
      }
      const result = await runTool(call.function.name, parsed)
      transcript.push({
        role: 'tool',
        tool_call_id: call.id,
        content: JSON.stringify(result).slice(0, 6000),
      })
      process.stdout.write(
        `    ${label}: ${call.function.name}(${JSON.stringify(parsed).slice(0, 60)})\n`,
      )
    }
  }

  return {
    discoveryCalls,
    usage,
    wallClockMs: Date.now() - startedAt,
    answer,
    transcript,
  }
}

/* ---- the crossing ------------------------------------------------------- */

const RECEIVER_SYSTEM = `You are the planning layer for a Mac computer-control agent.
You will be given a request the owner made by voice. Produce a concrete action plan.
Use the tools to check anything you are not sure of. Stop calling tools as soon as you can answer.
Reply with JSON only.`

/**
 * Turn the producer's raw chat transcript into portable context items.
 *
 * This is the same shape contextItemsFromRealtimeState() builds on the relay;
 * the producer here speaks chat-completions rather than realtime items, which
 * is exactly the reason the stored representation is neither.
 */
function portableItemsFrom(transcript) {
  const items = []

  for (const message of transcript) {
    if (message.role === 'system') continue

    if (message.role === 'user') {
      items.push({ kind: 'message', role: 'user', text: message.content })
      continue
    }

    if (message.role === 'tool') {
      items.push({ kind: 'tool_result', callId: message.tool_call_id, text: message.content })
      continue
    }

    for (const call of message.tool_calls || []) {
      items.push({
        kind: 'tool_call',
        name: call.function.name,
        callId: call.id,
        text: call.function.arguments,
      })
    }

    if (message.content) {
      items.push({ kind: 'message', role: 'assistant', text: message.content })
    }
  }

  return items
}

async function startRelay() {
  const child = spawn('node', ['cloud-relay/server.js'], {
    cwd: ROOT,
    env: { ...process.env, RELAY_PORT: String(RELAY_PORT), PORT: String(RELAY_PORT) },
    stdio: ['ignore', 'pipe', 'pipe'],
  })

  child.stdout.on('data', (chunk) => {
    const line = String(chunk).trim()
    if (line.includes('context')) process.stdout.write(`  [relay] ${line}\n`)
  })

  for (let attempt = 0; attempt < 60; attempt += 1) {
    try {
      const response = await fetch(`${RELAY_URL}/health`)
      if (response.ok) return child
    } catch {
      // not up yet
    }
    await new Promise((resolve) => setTimeout(resolve, 250))
  }

  child.kill()
  throw new Error(`Relay did not come up on ${RELAY_URL}`)
}

async function storeContext(items, model) {
  const response = await fetch(`${RELAY_URL}/v1/context`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${RELAY_API_KEY}`,
    },
    body: JSON.stringify({ items, origin: 'measure/producer', model }),
  })

  const payload = await response.json()
  if (!response.ok) throw new Error(payload.error || `store failed ${response.status}`)
  return payload
}

function summarize(label, runs) {
  const mean = (pick) => runs.reduce((total, run) => total + pick(run), 0) / runs.length
  return {
    arm: label,
    discoveryCalls: mean((run) => run.discoveryCalls),
    apiCalls: mean((run) => run.usage.apiCalls),
    promptTokens: mean((run) => run.usage.promptTokens),
    completionTokens: mean((run) => run.usage.completionTokens),
    cachedTokens: mean((run) => run.usage.cachedTokens),
    wallClockMs: mean((run) => run.wallClockMs),
  }
}

async function main() {
  if (!API_KEY) throw new Error('OPENAI_API_KEY is required.')

  const relay = await startRelay()
  process.on('exit', () => relay.kill())

  try {
    process.stdout.write(`\n== producer (${PRODUCER_MODEL}) — discovering ==\n`)
    const producer = await runBody({
      model: PRODUCER_MODEL,
      label: 'producer',
      messages: [
        {
          role: 'system',
          content:
            'You are the cloud voice body of a wearable agent. Investigate the project with the tools, then state what you found and what the Mac should do. Be concrete about file paths.',
        },
        { role: 'user', content: OWNER_REQUEST },
      ],
    })

    const items = portableItemsFrom(producer.transcript)
    const stored = await storeContext(items, PRODUCER_MODEL)
    process.stdout.write(
      `\n  producer: ${producer.discoveryCalls} discovery call(s), ` +
        `${producer.usage.promptTokens} prompt tokens, ${producer.wallClockMs} ms\n` +
        `  stored: ${stored.bytes} bytes, ${stored.itemCount} items, ` +
        `${stored.shed.length} shed, ${stored.redaction.secrets} secret(s) withheld\n` +
        `  handle: ${stored.handle.slice(0, 12)}… (expires ${stored.expiresAt})\n`,
    )

    const resumed = await resumeContext(stored.handle, { relayUrl: RELAY_URL })
    if (!resumed.resumed) throw new Error(`resume failed: ${resumed.reason}`)
    process.stdout.write(
      `  resumed: ${resumed.itemCount} item(s), ${resumed.messages.length} message(s), ` +
        `${resumed.notes.filter((n) => n.action === 'transcribed').length} transcribed, ` +
        `${resumed.notes.filter((n) => n.action === 'dropped').length} dropped\n`,
    )

    const cold = []
    const warm = []

    for (let run = 0; run < RUNS; run += 1) {
      process.stdout.write(`\n== run ${run + 1}/${RUNS} — COLD (today) ==\n`)
      cold.push(
        await runBody({
          model: RECEIVER_MODEL,
          label: 'cold',
          messages: [
            { role: 'system', content: RECEIVER_SYSTEM },
            { role: 'user', content: `${OWNER_REQUEST}\n\n${RECEIVER_TASK}` },
          ],
        }),
      )

      process.stdout.write(`\n== run ${run + 1}/${RUNS} — RESUMED ==\n`)
      warm.push(
        await runBody({
          model: RECEIVER_MODEL,
          label: 'warm',
          cacheKey: resumed.cacheKey,
          /*
           * Stable prefix first: this body's system prompt, then the migrated
           * thread (byte-identical for the life of the handle), then the new
           * request. Reordering these is what turns every resume into a cache
           * miss, which is why buildResumeMessages() hands them back in order.
           */
          messages: [
            { role: 'system', content: RECEIVER_SYSTEM },
            ...resumed.messages,
            { role: 'user', content: `${OWNER_REQUEST}\n\n${RECEIVER_TASK}` },
          ],
        }),
      )
    }

    const coldSummary = summarize('COLD (today)', cold)
    const warmSummary = summarize('RESUMED', warm)

    process.stdout.write(`\n\n=== measured, ${RUNS} run(s) per arm ===\n`)
    process.stdout.write(
      `receiver model: ${RECEIVER_MODEL}   producer model: ${PRODUCER_MODEL}\n\n`,
    )
    const row = (name, pick, unit = '') =>
      `${name.padEnd(22)} ${String(pick(coldSummary)).padStart(10)} ${String(pick(warmSummary)).padStart(10)}${unit}\n`
    process.stdout.write(`${''.padEnd(22)} ${'COLD'.padStart(10)} ${'RESUMED'.padStart(10)}\n`)
    process.stdout.write(row('discovery calls', (s) => s.discoveryCalls.toFixed(1)))
    process.stdout.write(row('model round trips', (s) => s.apiCalls.toFixed(1)))
    process.stdout.write(row('prompt tokens', (s) => Math.round(s.promptTokens)))
    process.stdout.write(row('  of which cached', (s) => Math.round(s.cachedTokens)))
    /*
     * The honest cost line. A multi-step cold run re-sends its own growing
     * transcript, so most of its prompt tokens are cache hits on itself — a
     * raw prompt-token comparison flatters the resumed arm. What each arm
     * actually pays full price for is the uncached remainder.
     */
    process.stdout.write(
      row('  uncached', (s) => Math.round(s.promptTokens - s.cachedTokens)),
    )
    process.stdout.write(row('completion tokens', (s) => Math.round(s.completionTokens)))
    process.stdout.write(row('wall clock (ms)', (s) => Math.round(s.wallClockMs)))

    const delta = (pick) => {
      const before = pick(coldSummary)
      const after = pick(warmSummary)
      if (!before) return 'n/a'
      return `${(((after - before) / before) * 100).toFixed(0)}%`
    }
    process.stdout.write(
      `\ndiscovery calls ${delta((s) => s.discoveryCalls)}   ` +
        `prompt tokens ${delta((s) => s.promptTokens)}   ` +
        `wall clock ${delta((s) => s.wallClockMs)}\n`,
    )

    process.stdout.write(
      '\nPer-run detail (discovery calls / prompt tokens / cached / ms):\n' +
        cold
          .map(
            (run, index) =>
              `  run ${index + 1}  cold ${run.discoveryCalls} / ${run.usage.promptTokens} / ${run.usage.cachedTokens} / ${run.wallClockMs}` +
              `   resumed ${warm[index].discoveryCalls} / ${warm[index].usage.promptTokens} / ${warm[index].usage.cachedTokens} / ${warm[index].wallClockMs}`,
          )
          .join('\n') +
        '\n',
    )
  } finally {
    relay.kill()
  }
}

main().catch((error) => {
  process.stderr.write(`${error.stack}\n`)
  process.exitCode = 1
})

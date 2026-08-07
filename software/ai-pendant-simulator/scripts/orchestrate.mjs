/*
 * The control shell. Runs the agents that have a reason to run, and stops when
 * none of them do.
 *
 * This replaces the shell for-loop that has driven every run on this project so
 * far. That loop invoked all five agents every cycle regardless of whether the
 * world had moved, which is how two agents produced nothing across sixteen
 * consecutive rounds while costing the same as the three that did.
 *
 * Eligibility lives in eligibility.mjs and is derived from the commons rather
 * than declared per agent. What is here is only the control: pick, spawn, mark,
 * repeat, and stop when the evidence runs out.
 *
 *   node scripts/orchestrate.mjs --cycles 8 --slots 3
 *   node scripts/orchestrate.mjs --agents unified,mac-planner --dry-run
 */
import { spawn } from 'node:child_process'
import { createHash } from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { markRan, schedule } from './eligibility.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = path.resolve(HERE, '../../..')
const OUT_DIR = path.join(REPO_ROOT, 'diagnostics', 'harness-derivation')
const HARNESS = path.join(HERE, 'derive-harness.mjs')

function flag(name, fallback) {
  const at = process.argv.indexOf(`--${name}`)
  return at > -1 ? process.argv[at + 1] : fallback
}

const CYCLES = Number(flag('cycles', 8))
const SLOTS = Number(flag('slots', 3))
const DRY_RUN = process.argv.includes('--dry-run')
const AGENTS = String(
  flag('agents', 'mac-planner,mac-terminal,mac-vision,relay-realtime,browser-extension'),
)
  .split(',')
  .map((name) => name.trim())
  .filter(Boolean)

/**
 * How much mail is waiting for each agent.
 *
 * Read from the same two files the harness itself uses, rather than tracked
 * separately — a scheduler holding its own idea of who has unread mail would
 * drift from what the agent actually sees in its prompt, and the drift would
 * only show up as an agent that runs for no visible reason.
 */
function unreadMailByAgent() {
  let bulletin = []
  try {
    bulletin = JSON.parse(fs.readFileSync(path.join(OUT_DIR, 'bulletin.json'), 'utf8'))
  } catch {
    return {}
  }

  const counts = {}
  for (const agent of AGENTS) {
    let read = new Set()
    try {
      const state = JSON.parse(fs.readFileSync(path.join(OUT_DIR, `state-${agent}.json`), 'utf8'))
      read = new Set(state.readMessages || [])
    } catch {
      /* never run: everything addressed to it is unread */
    }
    counts[agent] = bulletin.filter(
      (message) =>
        (message.to === agent || message.to === 'all') &&
        message.from !== agent &&
        !read.has(message.id),
    ).length
  }
  return counts
}

function runAgent(agent) {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [HARNESS, 'run', '--agent', agent], {
      cwd: path.join(REPO_ROOT, 'software', 'ai-pendant-simulator'),
      env: { ...process.env, HARNESS_COMMONS: '1' },
      stdio: ['ignore', 'pipe', 'pipe'],
    })

    let tail = ''
    for (const stream of [child.stdout, child.stderr]) {
      stream.on('data', (chunk) => {
        tail = `${tail}${chunk}`.slice(-2000)
      })
    }
    child.on('close', (code) => resolve({ agent, code, tail }))
  })
}

/*
 * The harness is re-spawned from disk for every round, so editing it mid-run
 * changes what the next round executes. On 2026-08-07 a half-applied edit did
 * exactly that: cycles 0-3 ran, then 24 rounds across 8 cycles died on the same
 * undefined identifier. Nothing noticed, because a crashed round and a quiet
 * agent look identical from out here.
 *
 * This process already holds its own code in memory, so only the spawned files
 * matter. Hashing them turns that failure into a clean stop with the reason
 * attached.
 */
const WATCHED = ['derive-harness.mjs', 'commons.mjs', 'novelty.mjs', 'eligibility.mjs']

function harnessFingerprint() {
  return WATCHED.map((file) => {
    try {
      return `${file}:${createHash('sha256').update(fs.readFileSync(path.join(HERE, file))).digest('hex').slice(0, 12)}`
    } catch {
      return `${file}:missing`
    }
  }).join(' ')
}

const fingerprintAtStart = harnessFingerprint()

const started = new Date()
process.stdout.write(
  `Orchestrating ${AGENTS.length} agents, up to ${CYCLES} cycles, ${SLOTS} at a time.\n` +
    `Agents run when the commons has moved under them, not because a loop said so.\n\n`,
)

/* Enough to distinguish one flaky round from a harness that cannot start. */
const FAILURE_LIMIT = 3

let cycle = 0
let ran = 0
let failed = 0
let consecutiveFailures = 0
for (; cycle < CYCLES; cycle += 1) {
  const { run, held } = schedule(OUT_DIR, AGENTS, {
    cycle,
    unreadMail: unreadMailByAgent(),
    slots: SLOTS,
  })

  if (!run.length) {
    process.stdout.write(
      `\nCycle ${cycle}: nobody is eligible. ${held.length} agents held — ` +
        `${held.map((row) => `${row.agent} (${row.reason})`).join('; ')}\n` +
        `Stopping. The world stopped changing; more rounds would only restate it.\n`,
    )
    break
  }

  process.stdout.write(
    `Cycle ${cycle}: running ${run.map((row) => `${row.agent} [${row.reason}]`).join(', ')}` +
      (held.length ? `  ·  holding ${held.map((row) => row.agent).join(', ')}\n` : '\n'),
  )

  const fingerprintNow = harnessFingerprint()
  if (fingerprintNow !== fingerprintAtStart) {
    process.stdout.write(
      `\nStopping: the harness changed on disk since this run began.\n` +
        `  was  ${fingerprintAtStart}\n  now  ${fingerprintNow}\n` +
        'Every round re-spawns it from disk, so the rest of this run would be ' +
        'measuring different code than the rounds already recorded. Re-run when ' +
        'the edit is finished.\n',
    )
    break
  }

  if (DRY_RUN) {
    /* Mark anyway, so a dry run still shows how eligibility would evolve rather
     * than printing the same cycle forever. */
    for (const row of run) markRan(OUT_DIR, row.agent, { cycle })
    continue
  }

  const results = await Promise.all(run.map((row) => runAgent(row.agent)))
  for (const result of results) {
    const done = /Round (\d+) done \[([^\]]+)\]\. (.*)/.exec(result.tail)
    process.stdout.write(
      `  ${result.agent}: ${
        done ? `round ${done[1]} [${done[2]}] ${done[3]}` : `FAILED (exit ${result.code})`
      }\n`,
    )

    if (result.code !== 0) {
      /*
       * A failed round observed nothing, so it must NOT advance the watermark.
       * Marking it would record the agent as having seen everything it did not
       * see, which both loses the work and suppresses the retry.
       */
      failed += 1
      consecutiveFailures += 1
      process.stdout.write(`    ${result.tail.trim().split('\n').slice(-2).join(' / ')}\n`)
      continue
    }

    /* Marked after a round that actually happened, so an agent's own deposits
     * never make it eligible again — otherwise looking would be
     * self-justifying. */
    markRan(OUT_DIR, result.agent, { cycle })
    ran += 1
    consecutiveFailures = 0
  }

  /*
   * Stop rather than grind. An unattended run that keeps spawning a process
   * which cannot start is the exact waste this shell exists to remove: on
   * 2026-08-07 a broken edit to the harness cost 24 rounds across 8 cycles
   * while every one of them reported the same undefined identifier, and the
   * shell went on scheduling as though nothing were wrong.
   */
  if (consecutiveFailures >= FAILURE_LIMIT) {
    process.stdout.write(
      `\nStopping: ${consecutiveFailures} rounds in a row failed to run. ` +
        'That is the harness being broken, not the agents having nothing to say.\n',
    )
    break
  }
}

const minutes = Math.round((Date.now() - started.getTime()) / 60_000)
process.stdout.write(
  `\n${ran} rounds across ${cycle} cycles in ${minutes}m` +
    `${failed ? `, and ${failed} that failed to run` : ''}.\n` +
    `Read the result:  node scripts/harness-stats.mjs --since 1\n`,
)

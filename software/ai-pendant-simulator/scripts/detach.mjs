/*
 * What survives if a node leaves.
 *
 * Across the fiction surveyed for this project, what separates a collective
 * experienced as a gift from one experienced as assimilation is not consent at
 * entry. It is exit. The Culture is voluntary and leaving is free; the Borg is
 * not. Abundance, being cared for, having things arranged before you arrive —
 * all orthogonal.
 *
 * Translated into an engineering constraint rather than a sentiment: the owner
 * must be able to detach any node, or the whole system, and still be himself.
 * So what the system knows cannot live only inside the system.
 *
 * That makes detachability measurable, which is the only reason it is worth
 * asserting. Two questions this answers:
 *
 *   --without <agent>   what would still be known if that node walked away
 *   --export <file>     the whole commons as something the owner keeps, in a
 *                       format that outlives this project
 *
 * A fact is SOLE-SOURCED if exactly one agent ever observed it. Those are the
 * system's hostages: lose that node and the knowledge goes with it. A low
 * sole-sourced count is not tidiness, it is the difference between a collective
 * you can leave and one you cannot.
 *
 *   node scripts/detach.mjs
 *   node scripts/detach.mjs --without relay-realtime
 *   node scripts/detach.mjs --export ~/hive-memory.md
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { fold, recall } from './commons.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(HERE, '../../..', 'diagnostics', 'harness-derivation')

function flag(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at > -1 ? process.argv[at + 1] : undefined
}

const entries = [...fold(OUT_DIR).values()]
if (!entries.length) {
  process.stdout.write(
    'The commons is empty — nothing to detach from. Run with HARNESS_COMMONS=1 first.\n',
  )
  process.exit(0)
}

const agents = [...new Set(entries.flatMap((entry) => entry.observers))].sort()

/* ---- exit cost per node -------------------------------------------------- */

function survivalWithout(agent) {
  const lost = entries.filter(
    (entry) => entry.observers.length === 1 && entry.observers[0] === agent,
  )
  return {
    agent,
    contributed: entries.filter((entry) => entry.observers.includes(agent)).length,
    lost: lost.length,
    lostKeys: lost.map((entry) => entry.key),
    survives: entries.length - lost.length,
  }
}

const only = flag('without')
if (only) {
  const report = survivalWithout(only)
  process.stdout.write(
    `Without ${only}: ${report.survives} of ${entries.length} facts survive ` +
      `(${((100 * report.survives) / entries.length).toFixed(1)}%).\n` +
      `It observed ${report.contributed}, and ${report.lost} of those nobody else ever saw.\n`,
  )
  if (report.lostKeys.length) {
    process.stdout.write(`\nWhat would be lost with it:\n`)
    for (const key of report.lostKeys) process.stdout.write(`  - ${key}\n`)
    process.stdout.write(
      `\nEach of these is a fact this system holds hostage to one node. ` +
        `Any other agent observing the same thing once retires it from this list.\n`,
    )
  }
  process.exit(0)
}

/* ---- export -------------------------------------------------------------- */

const exportTo = flag('export')
if (exportTo) {
  const lines = [
    '# What this system knows',
    '',
    `Exported ${new Date().toISOString()} from the agent commons.`,
    '',
    'This file is deliberately plain and self-contained. It is the copy that does',
    'not depend on the system still running, or on this project still existing.',
    '',
  ]

  for (const entry of [...entries].sort((left, right) => left.key.localeCompare(right.key))) {
    const full = recall(OUT_DIR, entry.key)
    lines.push(`## ${entry.key}`, '')
    lines.push(
      `${entry.summary}${entry.absent ? '  \n**Looked for and not found.**' : ''}  `,
      `Observed by ${entry.observers.join(', ')}, ${entry.confirmations}× confirmed, last seen ${entry.at}.`,
      '',
    )
    if (full?.content !== undefined) {
      lines.push('```json', JSON.stringify(full.content, null, 2).slice(0, 4000), '```', '')
    }
  }

  const target = exportTo.replace(/^~/, process.env.HOME || '~')
  fs.writeFileSync(target, `${lines.join('\n')}\n`)
  process.stdout.write(
    `Wrote ${entries.length} facts to ${target}.\n` +
      `Nothing in this system needs to be running for that file to be readable.\n`,
  )
  process.exit(0)
}

/* ---- default: the whole exit picture ------------------------------------- */

const reports = agents.map(survivalWithout).sort((left, right) => right.lost - left.lost)
const soleSourced = entries.filter((entry) => entry.observers.length === 1).length

process.stdout.write(
  `${entries.length} facts held by ${agents.length} agents. ` +
    `${soleSourced} are sole-sourced (${((100 * soleSourced) / entries.length).toFixed(1)}%).\n\n`,
)
process.stdout.write('If this node left      facts survive   it alone knows\n')
for (const report of reports) {
  process.stdout.write(
    `${report.agent.padEnd(22)}${`${report.survives}/${entries.length}`.padStart(13)}${String(report.lost).padStart(16)}\n`,
  )
}

const worst = reports[0]
process.stdout.write(
  `\n${
    worst.lost === 0
      ? 'No node is load-bearing: every fact here is known by at least two, so any one of them can leave without taking knowledge with it.'
      : `${worst.agent} is the most load-bearing node — ${worst.lost} facts would leave with it. ` +
        `Detachability is not a property this system has yet; it is one it would have to be run for.`
  }\n\nKeep a copy that does not depend on any of this:  node scripts/detach.mjs --export ~/hive-memory.md\n`,
)

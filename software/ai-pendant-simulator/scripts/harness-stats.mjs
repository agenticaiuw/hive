/*
 * Read the harness's own rounds back and report what each condition cost.
 *
 * Written because three separate conclusions on this project turned out to be
 * artefacts of how the numbers were gathered rather than of the system: rounds
 * counted from log greps that missed proposals, arms compared at different
 * maturities, and a condition inferred from which shell had which variable set.
 * So this reads the stored transcripts, splits on the flag each round recorded
 * about itself, and refuses to pool rounds that are not comparable.
 *
 *   node scripts/harness-stats.mjs                    # every agent, by condition
 *   node scripts/harness-stats.mjs --agent unified    # one agent
 *   node scripts/harness-stats.mjs --since 20         # rounds >= 20 only
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(HERE, '../../..', 'diagnostics', 'harness-derivation')

/* What "rediscovery" means, concretely: calls whose only product is learning
 * something about the system rather than probing it or proposing anything. */
const DISCOVERY = new Set(['list_capabilities', 'discover', 'describe', 'get_hardware_spec'])
const PROPOSAL = new Set(['propose_capability', 'propose_change'])

function flag(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at > -1 ? process.argv[at + 1] : undefined
}

const onlyAgent = flag('agent')
const since = Number(flag('since') || 0)

const rows = []
for (const file of fs.readdirSync(OUT_DIR)) {
  if (!file.startsWith('state-') || !file.endsWith('.json')) continue
  const agent = file.slice(6, -5)
  if (onlyAgent && agent !== onlyAgent) continue

  let state
  try {
    state = JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), 'utf8'))
  } catch {
    continue
  }

  for (const round of state.rounds || []) {
    if (round.round < since) continue
    const calls = (round.transcript || []).filter((item) => item.type === 'tool')
    if (!calls.length) continue
    rows.push({
      agent,
      round: round.round,
      /* Rounds predating the flag have no opinion about their condition, and
       * are reported separately rather than silently counted as controls. */
      condition: round.commons === undefined ? 'unrecorded' : round.commons ? 'commons' : 'control',
      calls: calls.length,
      discovery: calls.filter((call) => DISCOVERY.has(call.name)).length,
      recall: calls.filter((call) => call.name === 'recall').length,
      proposals: calls.filter((call) => PROPOSAL.has(call.name)).length,
      findings: calls.filter((call) => call.name === 'record_finding').length,
      messages: calls.filter((call) => call.name === 'message_peer').length,
      probes: calls.filter((call) => call.name === 'probe_http').length,
    })
  }
}

const conditions = new Map()
for (const row of rows) {
  if (!conditions.has(row.condition)) conditions.set(row.condition, [])
  conditions.get(row.condition).push(row)
}

const order = ['control', 'commons', 'unrecorded'].filter((name) => conditions.has(name))
process.stdout.write(
  `condition    agents rounds  calls  discovery%  recall/rnd  prop/rnd  find/rnd  msg/rnd  probe/rnd\n`,
)
for (const name of order) {
  const group = conditions.get(name)
  const sum = (key) => group.reduce((total, row) => total + row[key], 0)
  const rounds = group.length
  const calls = sum('calls')
  process.stdout.write(
    [
      name.padEnd(12),
      String(new Set(group.map((row) => row.agent)).size).padStart(6),
      String(rounds).padStart(6),
      String(calls).padStart(6),
      `${((100 * sum('discovery')) / calls).toFixed(1)}%`.padStart(11),
      (sum('recall') / rounds).toFixed(2).padStart(11),
      (sum('proposals') / rounds).toFixed(2).padStart(9),
      (sum('findings') / rounds).toFixed(2).padStart(9),
      (sum('messages') / rounds).toFixed(2).padStart(8),
      (sum('probes') / rounds).toFixed(2).padStart(10),
    ].join('') + '\n',
  )
}

/*
 * The pooled table can move for reasons that have nothing to do with the
 * commons — one agent contributing more rounds to one condition is enough. The
 * within-agent view is the one that can carry a claim, so it is printed
 * alongside rather than on request.
 */
const paired = [...new Set(rows.map((row) => row.agent))]
  .map((agent) => {
    const mine = rows.filter((row) => row.agent === agent)
    const share = (condition) => {
      const group = mine.filter((row) => row.condition === condition)
      if (!group.length) return null
      const calls = group.reduce((total, row) => total + row.calls, 0)
      return {
        rounds: group.length,
        discovery: (100 * group.reduce((total, row) => total + row.discovery, 0)) / calls,
        proposals: group.reduce((total, row) => total + row.proposals, 0) / group.length,
      }
    }
    return { agent, control: share('control'), commons: share('commons') }
  })
  .filter((row) => row.control && row.commons)

if (!paired.length) {
  process.stdout.write(
    '\nNo agent has rounds in both conditions yet — nothing here can carry a claim.\n',
  )
} else {
  process.stdout.write('\nWithin-agent, same agent both ways (the comparison that controls for maturity):\n')
  process.stdout.write('agent                 discovery% control -> commons     prop/rnd control -> commons\n')
  for (const row of paired) {
    process.stdout.write(
      `${row.agent.padEnd(20)} ${row.control.discovery.toFixed(1).padStart(9)}% -> ${row.commons.discovery
        .toFixed(1)
        .padStart(5)}%   (${row.control.rounds}v${row.commons.rounds})   ${row.control.proposals
        .toFixed(2)
        .padStart(8)} -> ${row.commons.proposals.toFixed(2)}\n`,
    )
  }
  const mean = (pick) => paired.reduce((total, row) => total + pick(row), 0) / paired.length
  process.stdout.write(
    `\nMean discovery share ${mean((row) => row.control.discovery).toFixed(1)}% control -> ` +
      `${mean((row) => row.commons.discovery).toFixed(1)}% commons, across ${paired.length} agents.\n`,
  )
}

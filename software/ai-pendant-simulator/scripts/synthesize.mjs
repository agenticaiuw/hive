/*
 * What the collective actually concluded.
 *
 * 820 proposals have accumulated across nine agents and there was no way to read
 * them. `review` lists pending requests; the ledger records entries one at a
 * time; nothing said what the system as a whole had arrived at. A collective
 * that cannot report its own conclusion is a collective nobody can act on.
 *
 * Ranked by HOW MANY DISTINCT AGENTS reached the same idea, never by how many
 * times it was said. One agent restating itself across rounds is the failure
 * mode this project already measured — an entry in the ledger reached
 * timesProposed: 9 — where five agents arriving independently at the same thing,
 * from different surfaces and without being able to see each other's proposals,
 * is the only evidence of convergence this system can produce.
 *
 *   node scripts/synthesize.mjs
 *   node scripts/synthesize.mjs --out ~/hive-brief.md
 *   node scripts/synthesize.mjs --kind change
 */
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import { SAME_IDEA_AT, fingerprint, similarity } from './novelty.mjs'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.join(HERE, '../../..', 'diagnostics', 'harness-derivation')

/*
 * The same number the gate blocks at, imported rather than repeated. These were
 * two independent constants once, and the gap between them meant the brief
 * reported an eleven-proposal cluster that the gate had declined to prevent.
 * Whatever "the same idea" means, it has to mean one thing.
 */
const CLUSTER_AT = SAME_IDEA_AT

function flag(name) {
  const at = process.argv.indexOf(`--${name}`)
  return at > -1 ? process.argv[at + 1] : undefined
}

const wantKind = flag('kind') || 'capability'
const out = flag('out')

const items = []
for (const file of fs.readdirSync(OUT_DIR)) {
  if (!file.startsWith('state-') || !file.endsWith('.json')) continue
  let state
  try {
    state = JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), 'utf8'))
  } catch {
    continue
  }

  if (wantKind === 'capability') {
    for (const p of state.proposals || []) {
      if (p.user_asks) items.push({ agent: state.agent, round: p.round, headline: p.user_asks, detail: p.why_useful || '' })
    }
  } else {
    for (const c of state.changes || []) {
      if (c.change) items.push({ agent: state.agent, round: c.round, headline: c.change, detail: c.why || '', layer: c.layer })
    }
  }
}

const prints = items.map((item) => fingerprint(`${item.headline} ${item.detail}`))

/*
 * Greedy single-link clustering, seeded from whichever item the most others
 * resemble. Good enough for a brief a person reads, and its failure mode is
 * visible: a loose cluster looks loose on the page.
 */
const degree = items.map((_, i) => prints.reduce((n, other, j) => (i !== j && similarity(prints[i], other) >= CLUSTER_AT ? n + 1 : n), 0))
const taken = new Set()
const clusters = []

for (const seed of items.map((_, i) => i).sort((a, b) => degree[b] - degree[a])) {
  if (taken.has(seed)) continue
  const members = [seed]
  taken.add(seed)
  for (let other = 0; other < items.length; other += 1) {
    if (taken.has(other)) continue
    if (similarity(prints[seed], prints[other]) >= CLUSTER_AT) {
      members.push(other)
      taken.add(other)
    }
  }
  clusters.push(members)
}

const ranked = clusters
  .map((members) => {
    const agents = new Set(members.map((i) => items[i].agent))
    return {
      agents,
      members,
      /* Distinct agents first; the count of restatements only breaks ties. */
      weight: agents.size * 1000 + members.length,
    }
  })
  .sort((left, right) => right.weight - left.weight)

/*
 * Lead with this, because it is the finding most likely to be skipped past.
 *
 * The first time this ran it produced twenty clusters each headed "1 agents",
 * against a claim I had already made in writing that the agents had converged.
 * A brief that buries its own refutation at the bottom is a brief that gets
 * quoted from the top.
 */
const crossAgent = ranked.filter((cluster) => cluster.agents.size >= 2)
const inCrossAgent = crossAgent.reduce((total, cluster) => total + cluster.members.length, 0)

const lines = [
  `# What the collective proposed — ${wantKind === 'capability' ? 'capabilities' : 'changes'}`,
  '',
  `${items.length} proposals from ${new Set(items.map((i) => i.agent)).size} agents, grouped into ${ranked.length} distinct ideas.`,
  '',
  `**Ideas reached by more than one agent: ${crossAgent.length} of ${ranked.length}` +
    ` (${((100 * inCrossAgent) / Math.max(items.length, 1)).toFixed(0)}% of proposals).**`,
  '',
  crossAgent.length === 0
    ? 'None. Every cluster is one agent restating itself, so nothing here is convergence —' +
      '\nit is a catalogue of what each surface wanted, and the ranking below is only' +
      '\nvolume. Lexical similarity is a weak proxy for agreement, so this refutes' +
      '\nmeasured convergence rather than the possibility of it.'
    : 'Agents cannot read each other\'s proposals, so agreement across several is' +
      '\nconvergence rather than repetition. One agent restating itself carries no' +
      '\nweight in the ranking below.',
  '',
]

for (const cluster of ranked.slice(0, 20)) {
  const [first] = cluster.members
  const item = items[first]
  lines.push(
    `## ${[...cluster.agents].length} agents · ${cluster.members.length} proposals`,
    '',
    `**${item.headline.replace(/\s+/g, ' ').trim()}**`,
    '',
  )
  if (item.detail) lines.push(item.detail.replace(/\s+/g, ' ').trim(), '')
  lines.push(`Reached independently by: ${[...cluster.agents].sort().join(', ')}.`, '')

  const others = cluster.members
    .slice(1, 4)
    .map((i) => `- *(${items[i].agent})* ${items[i].headline.replace(/\s+/g, ' ').trim().slice(0, 160)}`)
  if (others.length) lines.push('Said also as:', ...others, '')
}

const text = `${lines.join('\n')}\n`
if (out) {
  fs.writeFileSync(out.replace(/^~/, process.env.HOME || '~'), text)
  process.stdout.write(`Wrote ${ranked.length} ideas from ${items.length} proposals to ${out}.\n`)
} else {
  process.stdout.write(text)
}

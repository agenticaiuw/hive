#!/usr/bin/env node
/*
 * What the context change is worth, in tokens, on this machine's real memory.
 *
 * Context is re-sent on every turn, so the number that matters is not the size
 * of the store — it is the size of what leaves the machine per call. This
 * measures the sections the projection replaces, against the projection, using
 * the live context graph and the live fleet snapshot rather than a fixture.
 *
 *   node scripts/measure-context-projection.mjs [--task "..."] [--surface voice]
 */
import process from 'node:process'

import {
  formatLongTermMemoryForPrompt,
  retrieveLongTermMemory,
} from '../local-agent/contextGraph.js'
import { buildConversationContext } from '../local-agent/conversationContext.js'
import { estimateTokens, projectContext } from '../local-agent/contextProjection.js'
import {
  getActiveProject,
  formatWorkingProjectForPrompt,
} from '../local-agent/projectMemory.js'
import { listFacts, pruneFacts, syncFactsFromContextGraph } from '../local-agent/memoryService.js'
import { readSessions } from '../local-agent/sessionStore.js'
import { formatFleetSnapshotForPrompt } from '../cloud-relay/fleetContext.js'

const args = process.argv.slice(2)
const flag = (name, fallback) => {
  const index = args.indexOf(`--${name}`)
  return index >= 0 ? args[index + 1] : fallback
}

const task = flag('task', 'follow up with David about the GPU cluster and open my notes')
const surface = flag('surface', 'voice')
const turnsPerDay = Number(flag('turns', 40))

/* Pricing is only used to translate tokens into the thing the owner feels. */
const INPUT_USD_PER_MTOK = Number(flag('usd-per-mtok', 5))

function measure(label, text) {
  return { label, chars: text.length, tokens: estimateTokens(text), text }
}

// ---- BEFORE: the hand-written sections, exactly as they ship today ---------

const activeProject = getActiveProject()
const longTerm = retrieveLongTermMemory({
  command: task,
  projectId: activeProject?.id ?? null,
  limit: 8,
})

// The busiest real session, not the newest: the memory path only engages on
// follow-up-shaped commands, so the honest baseline is a conversation that
// actually has history to replay.
const busiestSession = [...readSessions()].sort(
  (left, right) => (right.turns?.length || 0) - (left.turns?.length || 0),
)[0]

const conversation = buildConversationContext({
  command: task,
  sessionId: busiestSession?.sessionId ?? null,
})

const before = {
  workingProject: measure(
    'projectMemory working-project block',
    `## Working project context\n${formatWorkingProjectForPrompt(activeProject, { maxThreads: 3 })}`,
  ),
  longTerm: measure(
    'contextGraph long-term memory block',
    `## Long-term personal memory\n${formatLongTermMemoryForPrompt(longTerm)}`,
  ),
  session: measure(
    'conversationContext session block',
    conversation.promptBlock.split('\n\n## Working project context')[0],
  ),
  fleetMemory: measure(
    'fleetContext "Recent context" section',
    (formatFleetSnapshotForPrompt(liveFleet()).match(/### Recent context\n.*/s)?.[0] ?? '').split(
      '\n###',
    )[0],
  ),
}

// ---- AFTER: one projection, scoped to the surface and the task ------------

syncFactsFromContextGraph()
const pruned = pruneFacts({})
const projected = projectContext({ surface, task })
const after = measure(surface, projected.text)

// Split the projection the way the bill splits it. The "## Owner" head is
// sorted, slow-moving and byte-identical between turns, so it extends the
// provider's cached prefix; everything below it is what each turn actually
// pays full price for. Every block in the BEFORE column is volatile — the
// working summary is rewritten after each execution, the session block replays
// the newest turns, and long-term retrieval is keyed on the command.
const headEnd = after.text.indexOf('\n## ', 1)
const stableHead = measure('cacheable head (## Owner)', headEnd < 0 ? after.text : after.text.slice(0, headEnd))
const volatileTail = measure('volatile tail (task-scoped)', headEnd < 0 ? '' : after.text.slice(headEnd + 1))

// The strawman worth ruling out: a unified store is not by itself a saving.
// Sending every fact it holds costs more than the blocks it replaced.
const dump = measure(
  'every fact in the store',
  listFacts({}).map((fact) => `- ${fact.value}`).join('\n'),
)

// ---- Report ---------------------------------------------------------------

const beforeTotal = Object.values(before).reduce(
  (sum, part) => ({ chars: sum.chars + part.chars, tokens: sum.tokens + part.tokens }),
  { chars: 0, tokens: 0 },
)

const row = (label, chars, tokens) =>
  `${label.padEnd(42)} ${String(chars).padStart(7)} ${String(tokens).padStart(7)}`

console.log(`task:    ${task}`)
console.log(`surface: ${surface}`)
console.log(
  `session: ${busiestSession?.sessionId ?? '(none)'} (${busiestSession?.turns?.length ?? 0} turns)`,
)
console.log(`store:   ${listFacts({}).length} live facts (pruned ${pruned.removed}: ${JSON.stringify(pruned.reasons)})`)
console.log('')
console.log(row('BEFORE — sent on every turn', 'chars', 'tokens'))
for (const part of Object.values(before)) {
  console.log(row(`  ${part.label}`, part.chars, part.tokens))
}
console.log(row('  total', beforeTotal.chars, beforeTotal.tokens))
console.log('')
console.log(row('AFTER', 'chars', 'tokens'))
console.log(row(`  projectContext(${surface}, task)`, after.chars, after.tokens))
console.log(row(`    ${stableHead.label}`, stableHead.chars, stableHead.tokens))
console.log(row(`    ${volatileTail.label}`, volatileTail.chars, volatileTail.tokens))
console.log(row('  [strawman] unified store, no projection', dump.chars, dump.tokens))
console.log('')

const report = (label, afterTokens) => {
  const saved = beforeTotal.tokens - afterTokens
  const percent = (saved / beforeTotal.tokens) * 100
  console.log(
    `${label.padEnd(26)} ${String(saved).padStart(5)} tokens/turn saved (${percent.toFixed(1)}%)` +
      ` · ${(saved * turnsPerDay).toLocaleString()} tokens/day` +
      ` · $${((saved * turnsPerDay * 30 * INPUT_USD_PER_MTOK) / 1_000_000).toFixed(2)}/month at $${INPUT_USD_PER_MTOK}/Mtok`,
  )
}

report('whole projection:', after.tokens)
report('uncached portion only:', volatileTail.tokens)

/*
 * The claim the owner actually cares about: knowing more must not cost more.
 * The store is grown synthetically here (the live facts, restated) because no
 * machine has a year of this store yet — but the projection is measured for
 * real against each grown store, and it is the flat line.
 */
console.log('')
console.log(row('growth: store size →', 'dump', 'project'))
const live = listFacts({})
for (const multiple of [1, 10, 50, 200]) {
  const grown = live.flatMap((fact, index) =>
    Array.from({ length: multiple }, (_, copy) => ({
      ...fact,
      id: `${fact.id}-${copy}`,
      key: copy === 0 ? fact.key : `${fact.key}.${copy}`,
      value: copy === 0 ? fact.value : `${fact.value} (variant ${copy} of item ${index})`,
    })),
  )
  const dumped = estimateTokens(grown.map((fact) => `- ${fact.value}`).join('\n'))
  const scaled = projectContext({ surface, task, facts: grown })
  console.log(row(`  ${grown.length} facts`, dumped, scaled.stats.estimatedTokens))
}
console.log('')
console.log('--- projected prompt ---')
console.log(after.text)

/**
 * The live fleet payload, built the way the bridge builds it, so the "before"
 * number is the text that actually ships rather than a reconstruction.
 */
function liveFleet() {
  return {
    version: 1,
    updatedAt: new Date().toISOString(),
    mac: { online: true, applications: [] },
    memory: {
      workingProject: activeProject,
      latestPerson: longTerm.find((entity) => entity.type === 'Person') ?? null,
      latestTask: longTerm.find((entity) => entity.type === 'Task') ?? null,
      latestFile: longTerm.find((entity) => entity.type === 'File') ?? null,
    },
  }
}

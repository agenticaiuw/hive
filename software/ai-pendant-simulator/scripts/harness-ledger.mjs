/**
 * Every change the agents proposed, in one durable file on disk.
 *
 * The proposals were being written into five separate per-agent state blobs,
 * where nothing surfaced them as a list of work. Twenty-two accumulated
 * without a single one being implemented, because neither the orchestrator nor
 * the owner could see them together. A derivation process that produces
 * proposals nobody acts on is theatre.
 *
 * The ledger is the source of truth for STATUS. Re-running it re-reads the
 * agent states and adds anything new, but never overwrites a status you have
 * already set — so "implemented" survives every future round.
 *
 *   node scripts/harness-ledger.mjs                    # refresh + print
 *   node scripts/harness-ledger.mjs status <id> <state> [--note "..."]
 *        state: proposed | implementing | implemented | rejected | duplicate
 */
import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const OUT_DIR = path.resolve(HERE, '../../../diagnostics/harness-derivation')
const LEDGER_JSON = path.join(OUT_DIR, 'ledger.json')
const LEDGER_MD = path.join(OUT_DIR, 'CHANGES.md')

/* Stable across rounds: the same proposal re-made must not become a new row. */
const idFor = (kind, layer, text) =>
  `${kind}-${crypto
    .createHash('sha1')
    .update(`${layer}|${String(text).slice(0, 160).toLowerCase().trim()}`)
    .digest('hex')
    .slice(0, 8)}`

function loadLedger() {
  try {
    return JSON.parse(fs.readFileSync(LEDGER_JSON, 'utf8'))
  } catch {
    return { entries: [] }
  }
}

/*
 * Support is recomputed from the agent states on every run, never incremented.
 *
 * It used to be a running `+= 1` over a re-read of every state file. State
 * files are cumulative, so each run re-counted every proposal ever made and
 * bumped it again: after twenty runs the oldest entries read "20x" and anything
 * created later read "1x". The number was a function of the entry's age and of
 * how often this script happened to be invoked. It measured neither demand nor
 * agreement, and everything downstream ranked the backlog by it.
 *
 * Counting distinct (agent, round) contributions from scratch is idempotent by
 * construction — there is no accumulator left to double.
 */
function tallySupport() {
  const support = new Map() // id -> Map(agent -> Set(round))
  const credit = (id, agent, round) => {
    if (!support.has(id)) support.set(id, new Map())
    const byAgent = support.get(id)
    if (!byAgent.has(agent)) byAgent.set(agent, new Set())
    byAgent.get(agent).add(round ?? 0)
  }
  return { support, credit }
}

function collect() {
  const ledger = loadLedger()
  /* Status and note are owner-owned and must survive; the counts are derived
   * and get rebuilt, so keep only what cannot be recomputed. */
  const kept = new Map(
    ledger.entries.map((e) => [e.id, { status: e.status, note: e.note || '' }]),
  )
  const previous = new Map(ledger.entries.map((e) => [e.id, e]))
  const byId = new Map()
  const { support, credit } = tallySupport()

  for (const file of fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.startsWith('state-') && f.endsWith('.json'))) {
    const agent = file.replace('state-', '').replace('.json', '')
    const state = JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), 'utf8'))

    const seed = (id, entry, round) => {
      if (!byId.has(id)) {
        byId.set(id, {
          id,
          ...entry,
          proposedBy: [],
          round,
          ...(kept.get(id) || { status: 'proposed', note: '' }),
        })
      }
      credit(id, agent, round)
    }

    for (const change of state.changes || []) {
      seed(
        idFor('chg', change.layer, change.change),
        {
          kind: 'change',
          layer: change.layer,
          summary: change.change,
          why: change.why || '',
        },
        change.round,
      )
    }

    for (const proposal of state.proposals || []) {
      seed(
        idFor('cap', 'capability', proposal.user_asks),
        {
          kind: 'capability',
          layer: 'capability',
          summary: proposal.user_asks,
          why: proposal.why || proposal.how || '',
        },
        proposal.round,
      )
    }

    /*
     * Echoes are proposals the novelty gate blocked because they restated
     * something already on record. That block is the only moment agreement is
     * ever visible: an agent reaching an existing idea on its own is precisely
     * the evidence that the gap is real, and discarding it left every entry
     * looking like one agent's private opinion. Two agents out of 5,320 entries
     * ever shared a row, because sharing required byte-identical wording.
     */
    for (const echo of state.echoes || []) {
      if (byId.has(echo.id) || kept.has(echo.id)) credit(echo.id, agent, echo.round)
    }

    for (const skill of state.granted?.deviceSkills || []) {
      seed(
        idFor('skill', 'firmware', skill.name),
        {
          kind: 'device-skill',
          layer: 'firmware',
          summary: skill.name,
          why: skill.what_it_does || '',
        },
        skill.grantedInRound,
      )
    }
  }

  for (const [id, entry] of byId) {
    const byAgent = support.get(id) || new Map()
    entry.proposedBy = [...byAgent.keys()].sort()
    /* How many agents reached it independently — the consensus signal. */
    entry.agents = byAgent.size
    /* How many separate rounds reached it — persistence, which is a weaker but
     * still real signal that something stayed unaddressed. */
    entry.timesProposed = [...byAgent.values()].reduce((n, rounds) => n + rounds.size, 0)
  }

  /*
   * An entry whose originating proposal is no longer in any state file still
   * belongs here. State gets compacted and agents get retired; neither is a
   * reason to forget that something was already built or already rejected.
   * Rebuilding purely from state would drop those rows and re-propose settled
   * work, so carry them forward with their support frozen at last sighting.
   */
  for (const [id, entry] of previous) {
    if (byId.has(id)) continue
    byId.set(id, { ...entry, agents: entry.agents ?? 0, unobserved: true })
  }

  const entries = [...byId.values()].sort(
    (a, b) =>
      b.agents - a.agents ||
      b.timesProposed - a.timesProposed ||
      a.layer.localeCompare(b.layer),
  )
  fs.writeFileSync(LEDGER_JSON, `${JSON.stringify({ entries }, null, 2)}\n`)
  return entries
}

function writeMarkdown(entries) {
  const open = entries.filter((e) => e.status === 'proposed')
  const done = entries.filter((e) => e.status === 'implemented')
  const other = entries.filter(
    (e) => !['proposed', 'implemented'].includes(e.status),
  )

  const rows = (list) =>
    list.length
      ? [
          '| id | layer | proposed by | agents | rounds | change |',
          '| --- | --- | --- | --- | --- | --- |',
          ...list.map(
            (e) =>
              `| \`${e.id}\` | ${e.layer} | ${(e.proposedBy || []).join(', ')} | ${
                e.agents ?? 0
              } | ${e.timesProposed} | ${String(e.summary)
                .replace(/\n/g, ' ')
                .slice(0, 150)} |`,
          ),
          '',
        ]
      : ['_none_', '']

  const lines = [
    '# Changes the agents proposed',
    '',
    'Written by `scripts/harness-ledger.mjs`. Status is owned by this file and',
    'survives re-runs — refreshing adds new proposals, it never resets what you',
    'have already marked done.',
    '',
    `**${open.length} open · ${done.length} implemented · ${other.length} other**`,
    '',
    'The `×` column counts how many times a proposal was made. Anything above 1',
    'was arrived at independently more than once, which is the strongest signal',
    'in here.',
    '',
    '## Open',
    '',
    ...rows(open),
    '## Implemented',
    '',
    ...rows(done),
  ]
  if (other.length) lines.push('## Rejected / duplicate', '', ...rows(other))
  fs.writeFileSync(LEDGER_MD, `${lines.join('\n')}\n`)
}

const command = process.argv[2]
if (command === 'status') {
  const id = process.argv[3]
  const next = process.argv[4]
  const valid = ['proposed', 'implementing', 'implemented', 'rejected', 'duplicate']
  if (!valid.includes(next)) throw new Error(`status must be one of ${valid.join(', ')}`)
  const ledger = loadLedger()
  const entry = ledger.entries.find((e) => e.id === id)
  if (!entry) throw new Error(`no ledger entry ${id}`)
  entry.status = next
  const noteIndex = process.argv.indexOf('--note')
  if (noteIndex > -1) entry.note = process.argv[noteIndex + 1] || ''
  fs.writeFileSync(LEDGER_JSON, `${JSON.stringify(ledger, null, 2)}\n`)
  writeMarkdown(ledger.entries)
  process.stdout.write(`${id} -> ${next}\n`)
} else {
  const entries = collect()
  writeMarkdown(entries)
  const open = entries.filter((e) => e.status === 'proposed')
  process.stdout.write(
    `${entries.length} proposals (${open.length} open) -> ${LEDGER_MD}\n\n`,
  )
  for (const e of open.slice(0, 40)) {
    process.stdout.write(
      `[${e.id}] ${e.layer} ×${e.timesProposed} (${e.proposedBy.join(',')})\n    ${String(
        e.summary,
      ).replace(/\n/g, ' ').slice(0, 130)}\n`,
    )
  }
}

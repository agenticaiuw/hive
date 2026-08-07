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

function collect() {
  const ledger = loadLedger()
  const byId = new Map(ledger.entries.map((e) => [e.id, e]))

  for (const file of fs
    .readdirSync(OUT_DIR)
    .filter((f) => f.startsWith('state-') && f.endsWith('.json'))) {
    const agent = file.replace('state-', '').replace('.json', '')
    const state = JSON.parse(fs.readFileSync(path.join(OUT_DIR, file), 'utf8'))

    for (const change of state.changes || []) {
      const id = idFor('chg', change.layer, change.change)
      const existing = byId.get(id)
      if (existing) {
        /* Independent re-proposal is signal: two agents wanting the same thing
         * is stronger evidence than one wanting it twice. */
        if (!existing.proposedBy.includes(agent)) existing.proposedBy.push(agent)
        existing.timesProposed += 1
        continue
      }
      byId.set(id, {
        id,
        kind: 'change',
        layer: change.layer,
        summary: change.change,
        why: change.why || '',
        proposedBy: [agent],
        timesProposed: 1,
        round: change.round,
        status: 'proposed',
        note: '',
      })
    }

    for (const proposal of state.proposals || []) {
      const id = idFor('cap', 'capability', proposal.user_asks)
      const existing = byId.get(id)
      if (existing) {
        if (!existing.proposedBy.includes(agent)) existing.proposedBy.push(agent)
        existing.timesProposed += 1
        continue
      }
      byId.set(id, {
        id,
        kind: 'capability',
        layer: 'capability',
        summary: proposal.user_asks,
        why: proposal.why || proposal.how || '',
        proposedBy: [agent],
        timesProposed: 1,
        round: proposal.round,
        status: 'proposed',
        note: '',
      })
    }

    for (const skill of state.granted?.deviceSkills || []) {
      const id = idFor('skill', 'firmware', skill.name)
      if (byId.has(id)) continue
      byId.set(id, {
        id,
        kind: 'device-skill',
        layer: 'firmware',
        summary: skill.name,
        why: skill.what_it_does || '',
        proposedBy: [agent],
        timesProposed: 1,
        round: skill.grantedInRound,
        status: 'proposed',
        note: '',
      })
    }
  }

  const entries = [...byId.values()].sort(
    (a, b) => b.timesProposed - a.timesProposed || a.layer.localeCompare(b.layer),
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
          '| id | layer | proposed by | × | change |',
          '| --- | --- | --- | --- | --- |',
          ...list.map(
            (e) =>
              `| \`${e.id}\` | ${e.layer} | ${e.proposedBy.join(', ')} | ${e.timesProposed} | ${String(
                e.summary,
              ).replace(/\n/g, ' ').slice(0, 150)} |`,
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

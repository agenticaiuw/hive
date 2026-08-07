#!/usr/bin/env node
/**
 * Research a topic, leave the owner a cited note and an audio brief.
 *
 *   node scripts/research-brief.mjs --topic "LTE-M coverage in rural Wisconsin"
 *   node scripts/research-brief.mjs --topic "USB-C hubs" --mode compare --open
 *   node scripts/research-brief.mjs --topic "the pricing page" --mode page --match stripe
 *   node scripts/research-brief.mjs --play latest --play-on-mac
 *
 * This is also the shape the planner emits for "look into X and tell me later"
 * (see machineContext.js). The agent recognises that command and runs the same
 * code in-process so the rendered audio can ride back on the job result; from a
 * terminal it runs here, as a plain script.
 */
import { researchTopic } from '../local-agent/research.js'
import {
  briefingHeadline,
  deliverBriefing,
  getBriefing,
  listBriefings,
  playBriefingOnMac,
} from '../local-agent/audioBrief.js'

function parseArgs(argv) {
  const args = { flags: new Set() }
  for (let index = 0; index < argv.length; index += 1) {
    const token = argv[index]
    if (!token.startsWith('--')) continue
    const [name, inline] = token.slice(2).split('=')
    const next = argv[index + 1]
    if (inline !== undefined) {
      args[name] = inline
    } else if (next && !next.startsWith('--')) {
      args[name] = next
      index += 1
    } else {
      args.flags.add(name)
      args[name] = true
    }
  }
  return args
}

const args = parseArgs(process.argv.slice(2))

if (args.list) {
  for (const briefing of listBriefings({ limit: 20 })) {
    console.log(
      `${briefing.played ? ' ' : '•'} ${briefing.id}  ${briefing.createdAt}  ${briefing.seconds}s  ${briefing.topic}`,
    )
  }
  process.exit(0)
}

if (args.play) {
  const briefing = getBriefing(args.play === true ? 'latest' : String(args.play))
  if (!briefing) {
    console.error('No briefings are waiting.')
    process.exit(1)
  }
  console.log(briefingHeadline(briefing))
  console.log(`note:  ${briefing.notePath}`)
  console.log(`audio: ${briefing.wavPath}`)
  if (args['play-on-mac']) playBriefingOnMac(briefing)
  else console.log(`\n${briefing.spoken}`)
  process.exit(0)
}

const topic = typeof args.topic === 'string' ? args.topic : ''
if (!topic) {
  console.error(
    'Usage: research-brief.mjs --topic "<topic>" [--mode brief|compare|page] [--match "<text>"] [--open] [--play-on-mac]',
  )
  process.exit(2)
}

const research = await researchTopic({
  topic,
  mode: typeof args.mode === 'string' ? args.mode : 'brief',
  match: typeof args.match === 'string' ? args.match : '',
  maxSources: Number(args['max-sources']) || undefined,
  onProgress: (event) =>
    console.error(`[research] ${event.phase}${event.count !== undefined ? ` ${event.count}` : ''}`),
})

const { briefing, notePath, audio } = deliverBriefing({
  research,
  openNote: Boolean(args.open),
})

console.log(briefingHeadline(briefing))
console.log(`sources: ${research.sourcesRead} read of ${research.sourcesSeen} seen`)
console.log(`note:    ${notePath}`)
console.log(`audio:   ${audio.wavPath} (${audio.seconds}s, ${audio.opusBytes} B opus)`)

if (args['play-on-mac']) playBriefingOnMac(briefing)

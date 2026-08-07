/*
 * Who should run next, and whether anyone should.
 *
 * Every agent here has been run because a shell loop said so. An agent with
 * nothing new to look at still burns a full round: it re-reads a world that has
 * not moved, restates what it said last time, and costs the same as one that
 * had something to do. Measured on this project, two of five agents produced
 * nothing across sixteen consecutive rounds and were invoked every single one.
 *
 * Hearsay-II solved this around 1980 and the industry then replaced it with
 * polling. A knowledge source there declares a PRECONDITION PATTERN over shared
 * state; when the pattern matches it becomes eligible, and a control shell
 * chooses among the eligible. Nobody decides to run. The two silent agents
 * would never have been invoked and would have cost exactly zero.
 *
 * The precondition here is deliberately not per-agent — a hand-written pattern
 * for each agent is a guess about that agent's job, frozen at the moment it was
 * written, and it is the same hardcoding the commons exists to avoid. Instead
 * eligibility is derived from evidence:
 *
 *   - a key it has never seen, or one whose content CONTRADICTS what it last
 *     saw. Re-confirmations are explicitly not novelty: a fact observed again
 *     unchanged gives an agent no reason to think anything.
 *   - unread mail from a peer, which is the other honest form of "something
 *     changed for me".
 *   - never having run at all.
 *   - a starvation floor, so an agent whose corner of the world is quiet is not
 *     silenced permanently by a store that happens to be busy elsewhere.
 *
 * When nothing is eligible, the answer is that nobody should run. That is a
 * real stopping condition rather than a failure, and it is the property that
 * makes an unattended run bounded by how much the world actually changes rather
 * than by how long it is left switched on.
 */
import fs from 'node:fs'
import path from 'node:path'

import { fold } from './commons.mjs'

export const WATERMARK_FILE = 'orchestrator.json'

/*
 * Cycles an agent may sit out before it becomes eligible regardless.
 *
 * Not zero, or this is polling with extra steps. Not large, because an agent
 * that has been wrong about its own irrelevance is expensive to discover late.
 */
export const MAX_IDLE_CYCLES = 4

/*
 * How much evidence is worth a round.
 *
 * Scoring is defined just below; what this constant fixes is how much of it a
 * round is worth.
 *
 * The first version stood at 1 — "one new fact is the smallest thing this
 * system can honestly call news". That confused whether something is news with
 * whether it is worth acting on. A round costs 25-40 tool calls and a whole
 * model conversation; spending that to absorb a single fact the agent would
 * have picked up anyway the next time it ran is the same waste this shell
 * exists to remove, just with a better reason attached.
 *
 * Three, and unusually for this project the data has a real break in it. Across
 * nine agents at the end of a 60-round run the scores fell into three groups —
 * 0.00 for those that had just run, 2.36 for the middle, 5.05 for the stalest —
 * and nothing at all between 2.36 and 5.05. A threshold in that gap separates
 * "slightly behind" from "genuinely behind" without splitting either.
 *
 * The exposure this creates is that an agent slightly behind forever is never
 * run, and MAX_IDLE_CYCLES is what answers it: whatever the score says, nobody
 * waits more than four cycles.
 */
export const WAKE_AT = 3

/*
 * What each kind of evidence is worth, and the weights are not interchangeable
 * with the threshold — raising one without the other silently inverts the
 * priority.
 *
 * A CONTRADICTION is the strongest signal there is: something the agent
 * believed is now false, so whatever it built on top of that is suspect. It
 * alone should be able to justify a round. The multiplier has to be 4 rather
 * than 3 for a specific reason — the change-rate estimate is smoothed, so a
 * single flip can never score surprise 1.0, and at a multiplier of 3 NO lone
 * contradiction could ever reach the threshold. That would have quietly made
 * the most important signal the only one that never fired.
 *
 * MAIL is a peer asking this agent something directly. One message is worth a
 * round: an unanswered question is worse than a redundant round, and the sender
 * is already blocked on it.
 *
 * An UNSEEN KEY is an opportunity, not a problem. Three of them are worth a
 * round; one is something the agent will pick up anyway next time it runs.
 */
export const CONTRADICTION_WEIGHT = 4
export const MAIL_WEIGHT = 3
export const UNSEEN_WEIGHT = 1

export function loadWatermarks(dir) {
  try {
    return JSON.parse(fs.readFileSync(path.join(dir, WATERMARK_FILE), 'utf8'))
  } catch {
    return {}
  }
}

export function saveWatermarks(dir, watermarks) {
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(
    path.join(dir, WATERMARK_FILE),
    `${JSON.stringify(watermarks, null, 2)}\n`,
  )
}

/**
 * Snapshot what an agent has now seen, so the next cycle can tell novelty from
 * repetition.
 *
 * Taken AFTER a round, which means an agent's own deposits never count as
 * novelty for itself — otherwise every agent would make itself eligible
 * forever simply by looking at things.
 */
export function markRan(dir, agent, { cycle, now = Date.now() } = {}) {
  const watermarks = loadWatermarks(dir)
  const seen = {}
  /* Scoped to this agent, so a key whose answer is personal to each agent is
   * this agent's own answer — otherwise every peer's observation would read as
   * a contradiction and the agent would be permanently eligible. */
  for (const [key, entry] of fold(dir, { now, forAgent: agent })) seen[key] = entry.hash

  watermarks[agent] = { seen, lastCycle: cycle, lastRunAt: new Date(now).toISOString() }
  saveWatermarks(dir, watermarks)
  return watermarks[agent]
}

/**
 * Why this agent should run, in terms that can be printed.
 *
 * Returns a reason rather than a bare boolean because an eligibility rule
 * nobody can read is one nobody can tell is broken — and a scheduler that
 * silently stops invoking an agent looks exactly like an agent that has
 * nothing to say.
 */
export function assess(dir, agent, { cycle, unreadMail = 0, now = Date.now() } = {}) {
  const watermarks = loadWatermarks(dir)
  const mark = watermarks[agent]
  const entries = fold(dir, { now, forAgent: agent })

  if (!mark) {
    return { agent, eligible: true, score: Infinity, reason: 'has never run' }
  }

  const unseen = []
  const contradicted = []
  for (const [key, entry] of entries) {
    const seenHash = mark.seen?.[key]
    if (seenHash === undefined) unseen.push(key)
    /*
     * Weighted by how unexpected the change was. A key that comes back
     * different on every single look is a clock, and its changing again says
     * nothing — measured on the live store, eight such keys (/observe,
     * /ops/snapshot, /capabilities) produced 45 of 119 changes and kept every
     * agent permanently eligible. A change is only news if it was not expected.
     */
    else if (seenHash !== entry.hash) {
      contradicted.push({ key, surprise: 1 - (entry.changeRate ?? 0) })
    }
  }

  const idle = Number.isFinite(cycle) && Number.isFinite(mark.lastCycle) ? cycle - mark.lastCycle : 0

  /*
   * A contradiction outweighs a new fact. Something the agent believed is now
   * false, which invalidates whatever it built on top of it — where an unseen
   * key is merely an opportunity.
   */
  const surprise = contradicted.reduce((total, row) => total + row.surprise, 0)
  const score =
    surprise * CONTRADICTION_WEIGHT + unseen.length * UNSEEN_WEIGHT + unreadMail * MAIL_WEIGHT

  if (score >= WAKE_AT) {
    const worthMentioning = contradicted.filter((row) => row.surprise > 0.1).length
    return {
      agent,
      eligible: true,
      score,
      reason: [
        worthMentioning && `${worthMentioning} contradicted`,
        unseen.length && `${unseen.length} new`,
        unreadMail && `${unreadMail} unread`,
      ]
        .filter(Boolean)
        .join(', ') || 'accumulated churn',
    }
  }

  if (idle >= MAX_IDLE_CYCLES) {
    return { agent, eligible: true, score: 0, reason: `idle ${idle} cycles` }
  }

  return {
    agent,
    eligible: false,
    score: 0,
    reason: `nothing new since cycle ${mark.lastCycle ?? '?'}`,
  }
}

/**
 * Rank the eligible. Highest evidence first, ties broken toward whoever has
 * waited longest, so a busy corner of the system cannot starve a quiet one.
 */
export function schedule(dir, agents, { cycle, unreadMail = {}, now = Date.now(), slots = 3 } = {}) {
  const assessed = agents.map((agent) =>
    assess(dir, agent, { cycle, unreadMail: unreadMail[agent] ?? 0, now }),
  )
  const watermarks = loadWatermarks(dir)

  const runnable = assessed
    .filter((row) => row.eligible)
    .sort((left, right) => {
      if (right.score !== left.score) return right.score - left.score
      return (watermarks[left.agent]?.lastCycle ?? -1) - (watermarks[right.agent]?.lastCycle ?? -1)
    })

  return { run: runnable.slice(0, slots), held: assessed.filter((row) => !row.eligible), assessed }
}

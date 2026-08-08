# One agent or a committee?

Snapshot taken 2026-08-08 with a discovery run live, so the counts move. The
conclusions do not depend on the last few rounds.

## The short version

Per round of work they are the same. The committee costs eight times the rounds
for a four percent difference in output, and the convergence it was supposed to
buy has never been observable in this system.

| | rounds | ledger entries | entries/round |
|---|---|---|---|
| unified (1 agent) | 141 | 549 | **3.89** |
| committee (8 agents) | 1,182 | 4,773 | **4.04** |

The committee is **1.04×** the lone agent per round. The spread *within* the
committee is much wider than the gap between the two conditions — mac-vision
produces 5.09/round and mac-terminal 3.46 — so a 4% difference between
conditions is noise against a 47% spread between agents doing the same job.

## The claim I could not make honestly

Cross-agent agreement is **2 entries out of 5,320** (0.038%), and both are short
strings that collided on an exact-text hash: *"What am I looking at?"* and
*"Why didn't that happen?"*

I do not report that as evidence the committee fails to converge, because the
number is an artifact of the instrument. Three separate attempts to measure
convergence were circular in the same way:

1. **Clustering the per-agent `proposals` arrays.** Those hold only what survived
   `recordIfNovel`, which blocks near-duplicates at Jaccard 0.30 against the whole
   ledger. Finding 3,054 singletons of 3,092 clusters measured the gate, not the
   agents.
2. **Pairwise similarity over recorded proposals** — "0 cross-agent pairs above
   0.30 across 291,466 comparisons." Same defect. Post-gate proposals *cannot* be
   near-duplicates; the gate removed them.
3. **`ledger.timesProposed`.** It was a running `+= 1` over a re-read of
   cumulative state files, so it counted how many times the ledger script had
   been run since an entry was created. Strictly monotone in age: entries at 20×
   had mean creation round 10.3, entries at 1× had 87.5. Recomputed honestly,
   5,312 of 5,320 entries were proposed exactly once.

Two agents can only share a ledger row when their wording hashes identically
after `slice(0,160).toLowerCase()`. Anything close-but-reworded is deleted
upstream by the novelty gate before it is ever stored. **The gate and the
consensus signal are the same event**, so suppressing one destroys the other.

`recordIfNovel` now records each blocked duplicate as an `echo` in the proposing
agent's own state, and the ledger folds echoes into support. That is the
instrument that could answer this question. As of this snapshot it reads zero,
because it was added after the rounds above were run.

## Where the committee does converge

Not on feature text — on architecture. Across the open proposals, all nine
agents independently build on the same small set of primitives:

| distinct agents | references | built_from |
|---|---|---|
| 9 | 1,079 | `GET /jobs/:jobId/receipts` |
| 9 | 932 | `POST /execute` |
| 9 | 678 | `mac_run_actions` |
| 9 | 497 | `POST /plan` |
| 9 | 487 | `browser_run_actions` |

This signal survives because the novelty gate dedupes proposal *prose* and has no
effect on dependency naming. It is the one convergence measurement here that is
not circular, and it is strong: nine agents, working from different briefs,
planning on the same fourteen primitives.

## The confound worth naming

The comparison is not clean, and the unfairness runs against the lone agent. Of
the tool and context grants I issued during these rounds, the committee received
the large majority and the unified agent received **none** for most of the run —
it accumulated 34 unanswered requests while committee members were being
answered. An agent that cannot get what it asks for produces different work than
one that can, and that difference is mine, not the architecture's.

Every grant was also a *schema with no implementation* until late in the run, so
for most of these rounds "granted" meant less than it sounds like on either side.

## What the harness measurements do support

These come from `scripts/harness-stats.mjs` and are about the shared-commons
mechanism rather than the committee-vs-unified question:

| condition | agents | rounds | silent rounds | wasted calls |
|---|---|---|---|---|
| control | 8 | 30 | 3/30 | 117 (**17%**) |
| commons | 9 | 1,100+ | **0** | **0 (0%)** |
| unrecorded | 9 | 187 | 97/187 | 2,287 (**61%**) |

The "unrecorded" condition is the one to look at: 97 of 187 rounds produced
nothing at all, and 61% of calls were wasted. That is what agents do when their
work has nowhere to land — not a modelling failure, a plumbing one.

## What I would tell someone choosing

- **For output volume, one agent is as good per round.** Pay for eight only if
  you want eight perspectives, not eight times the work.
- **Do not buy a committee for consensus** unless you can measure it. The
  instinct to dedupe proposals is strong and correct for backlog hygiene, and it
  destroys the evidence you would use to justify the committee.
- **Differentiation showed up in dependencies, not in ideas.** If that is the
  benefit you want, measure it there.
- **The plumbing dominated the architecture.** Across this run, unanswered
  requests, unreachable capabilities and dead tool grants cost far more rounds
  than any difference between one agent and nine.

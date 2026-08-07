# Collective architecture

2026-08-07. What the research says the hive mind should be, and why the current
shape is wrong. Findings are cited; my inferences are marked as mine.

## The measurement this all answers

One round across five agents: **64 discovery calls, 11 inter-agent messages, 6
proposals.** 78% of every budget goes to rediscovering what the system is. Two
of five agents produced nothing across 16 consecutive rounds.

I assumed coordination was the cost. It is 13%.

## My slogan was wrong in the half that mattered

I had been saying: *ants do not remember the trail; the trail remembers.*

Half true. **The trail remembers a decision, not the world.** A pheromone
gradient encodes one scalar — "recently, many walked here and it paid." It
cannot encode "there is food at X of mass M", "X was checked and is empty", or
"I am about to take X". The compression is total and lossy *by design*, which
is why it costs nothing and why **it cannot by itself retire the 78%**.

Grassé's actual 1959 definition is about action, not fact: stigmergy is
"stimulation of workers by the performance they have achieved."

## The right shelf is transactive memory, not stigmergy

| | environment holds | answers the 78%? |
|---|---|---|
| stigmergy (Grassé) | the coordination signal — what to do next | **no** |
| extended / transactive memory (Clark & Chalmers, Wegner, Hutchins) | the knowledge — what is true | **yes** |

Wegner (1985): a transactive memory system combines individual memory with
*metamemory* about who knows what. Three findings that map onto the numbers:

1. **The payoff is the directory, not the content.** 64 discovery calls is a
   missing directory. The directory is tiny; the content is not. Build the
   index of capability before building shared content storage.
2. **The directory is built by working together, not by being told.** Groups
   trained *together* recalled more and erred less than groups given
   *identical* training separately — and familiarity did not explain it. So
   agents should read each other's **traces**, not each other's **manifests**.
   A roster does not produce a directory; observed work does.
3. **Overlap is the enemy.** The benefit comes from *differentiation* of
   expertise. Five nodes that all need to know the same things is the
   anti-pattern.

## The partition is the bug

*Blindsight* partitions a mind by **faculty** — one personality handles emotion,
another processes data. *Aristoi*'s daimones are likewise limited personalities
working simultaneously on different projects.

This system partitions by **device**: worn, Mac, browser, cloud. That is a
deployment topology wearing a cognitive architecture's clothes. A device
boundary is not a reason for a separate context, and it is a large part of why
every node rediscovers everything — the split runs along the axis that shares
the *least*, which by Wegner's third finding guarantees maximum overlap.

**The first unified experiment did not test this.** It merged the bodies and
left the partition untouched, and I read its silence as a verdict: committee 78%
discovery share, unified 81–90%, 0 proposals across 8 rounds.

**Retracted — the 0 was a harness bug, not a result.** The propose tools were
gated on `state.phase === 'capability'`, so the unified agent had no way to
record a proposal for any of those rounds. On the rerun, once it reached the
proposal phase, unified produced 6 proposals in a single round (2026-08-07,
round 17). Whatever is true about merging bodies, "it proposes nothing" is not.

What survives is the discovery share, which is still the highest of the three
arms — but see `## Where the comparison actually stands` for why even that is
not yet a clean read.

## Four properties that make environment-held knowledge actually cheap

1. **Content-addressed, never agent-addressed.** Linda's `rd` matches a tuple on
   a *pattern*, not a recipient. Blackboard knowledge sources never communicate
   directly. This is what kills discovery cost: stop asking *who knows* and
   start asking *what is known*. The 64 calls are 64 attempts to locate a
   holder.
2. **Read must be cheaper than derive, which requires automatic endorsement.**
   Clark & Chalmers's criteria for Otto's notebook counting as memory include
   that he "automatically endorses" what he retrieves. **If an agent
   re-verifies what it reads from shared state, the derivation cost has been
   paid anyway and nothing was gained.** A shared store the agents do not trust
   is a shared store that does not exist.
3. **Decay belongs to the store, not the members.** ACO evaporates pheromone
   (τ ← (1−ρ)τ + Δτ) specifically to avoid converging on a local optimum. No
   ant decides what to forget. Eviction should be a property of the store.
4. **Writing must be a side effect of the work, not a separate step.** Hutchins's
   cockpit speed bug is the gold standard: setting the marker *is* the act of
   deciding the speed. If logging is a discrete action an agent must remember
   to take, it is dropped first under budget pressure — which is likely part of
   why the nodes have nothing to read.

## What environment-held knowledge cannot represent

Bounds worth holding onto:

- **No negation.** Absence of trail is never evidence of absence. A large share
  of the discovery cost here is *negative* results — "not logged in", "file not
  there". Nothing in biology helps; an explicit **known-absent** record with
  its own TTL has to be added.
- **No intent, no reservation.** Two ants cannot reserve the same crumb. Nodes
  that can duplicate side-effectful work need leases or compare-and-swap.
- **No deadlines, no priority.** Gradients only.
- **Lock-in.** Positive feedback suppresses the search for a better answer.
- **The N=5 caveat.** Stigmergy's *search* efficiency amortizes across enormous
  numbers of cheap agents over many trials. With five expensive agents you get
  **all of the memory benefit and almost none of the search benefit.** Take the
  shared store, the content addressing, the decay, the write-as-side-effect. Do
  not expect emergent optimization.

## Three mechanics nobody has copied

**The speed bug.** Memory embedded *in the instrument already being read* — a
marker on the airspeed indicator, same units, same visual field, so reading the
current value and the remembered target is one perceptual act with **no
lookup**. Every agent memory system is a store you must decide to query; this
is the opposite. If the Mac node must read a file tree, the memory goes in the
file tree. If the browser node must read a page, it goes in the page.

**Blackboard eligibility (Hearsay-II, ~1980).** A knowledge source declares a
precondition *pattern over shared state*; when the pattern matches it becomes
eligible, and a control shell picks among eligible sources. Agents do not decide
to run. The two silent agents here would never have been invoked and would have
cost exactly zero. A 1980 solution to the 16-round idle problem, which modern
frameworks replaced with polling.

**Charge the sender, not the receiver.** In every system, sending is free to the
sender and expensive to the receiver — precisely the incentive that produces
both spam and silent nodes.

## Exit is the variable

Across the fiction, what separates a collective experienced as a *gift* from one
experienced as *assimilation* is not consent at entry. It is **exit**. The
Culture is voluntary and leaving is free; the Borg is not. Everything else —
abundance, being cared for, having things arranged before you arrive — is
orthogonal.

For the ambition in `you-scale.md` this is a hard design constraint, not a
sentiment: **the owner must be able to detach any node, or the whole system, and
still be himself. So his memory cannot live only in the store.**

## Where the comparison actually stands

2026-08-07. Three arms — committee (5 device-shaped agents), unified (one mind,
many bodies), faculty (perception / judgement / action). Measured over the same
wall-clock window:

| arm | rounds | discovery share | proposals/round | findings/round | messages/round |
|---|---|---|---|---|---|
| committee | 15 | 49% | 4.47 | 0.60 | 1.40 |
| unified | 11 | 60% | 0.55 | 5.45 | 0.64 |
| faculty | 9 | 51% | 0.00 | 6.00 | 4.22 |

**Do not read the proposals column as a verdict.** The arms are not at equal
maturity: committee agents were at rounds 17–30, unified at 7–17, faculty at
1–3. Proposing is a late-round behaviour — it starts only once discovery
saturates. Round-matched on rounds 1–3, *every* arm proposes exactly zero:

| arm | rounds 1–3 | discovery share | proposals/round |
|---|---|---|---|
| committee | 15 | 9% | 0.00 |
| unified | 3 | 54% | 0.00 |
| faculty | 9 | 51% | 0.00 |

So the only defensible statement today is about **cost**, not output: unified
spends the largest share of its budget rediscovering, and faculty spends the
most on talking to itself (4.22 messages/round, 3× committee). The output
question needs faculty and unified run out to comparable round counts, which is
what the parity rerun is for.

## Empirical baseline for this class of system

MAST (arXiv 2503.13657), 1600+ annotated traces across 7 frameworks, κ=0.88:
**41.8% system-design/specification failures, 36.9% inter-agent misalignment,
21.3% verification gaps** — and the authors conclude better communication
protocols are *insufficient* for the misalignment category. Consistent with the
measurement here: the messaging layer is not where the problem lives.

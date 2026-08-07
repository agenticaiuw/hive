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

*Confirmed here, 2026-08-07.* Across 647 bulletin messages the spread between
agents is 11×: faculty-action sent 126, faculty-judgement 121, mac-planner 103
— against relay-realtime's 11 and mac-vision's 15. Under the control shell a
message makes its recipient eligible, so each one spends a peer's whole round
while costing the sender nothing.

It is **not** currently the bottleneck — only 5 messages were unread at the
point of measurement, because recipients keep up. So the incentive is confirmed
and the harm is not yet realised, and building a sender charge now would be
fixing a problem this system does not have. Recorded so that if the unread
backlog ever grows, the cause is already known and the 11× is the evidence.

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

### The parity rerun, rounds 15–19, commons rounds excluded

| arm | agents | rounds | discovery share | proposals/round | messages/round | silent rounds |
|---|---|---|---|---|---|---|
| committee | 5 | 25 | **35.6%** | **3.32** | 1.32 | 7/25 |
| unified | 1 | 5 | 63.6% | 2.60 | 0.20 | 2/5 |
| faculty | 3 | 11 | 45.9% | 2.36 | 4.00 | 4/11 |

Committee wins on both axes at equal maturity: it spends the least of its budget
rediscovering and produces the most. Unified spends **1.8× committee's share** on
rediscovery — merging the bodies did not merge what they had to learn.

**The faculty number is not usable, and the reason matters more than the
number.** `faculty-action` was stuck in the recon phase for eighteen rounds, and
in recon the propose tools are not in an agent's tool list at all. It spent 32–42
calls a round and twice ended by saying in plain text that it had a proposal and
no tool to record it with. Its zero entered this table as though it were a
finding about partitioning a mind by faculty. It was a finding about a missing
state transition — the phase only ever moved when a human typed the phase
command. Fixed by bounding recon at three rounds; promotion costs nothing, since
the capability phase *adds* propose tools without removing discovery tools.

That is the third time on this project that a harness defect has arrived wearing
the clothes of an architecture result. All three had the same shape: **an agent
that cannot act is indistinguishable, in every summary, from an agent with
nothing to say.**

## Does holding knowledge outside the agents actually help?

The commons (`scripts/commons.mjs`) was built to attack the rediscovery share
directly. Measured by within-agent alternation — the same agent, consecutive
rounds, differing only in whether the directory was in its prompt, so round
maturity cannot masquerade as an effect:

| | control | commons |
|---|---|---|
| discovery share (mean of 5 agents) | 54.9% | **49.2%** |
| probes/round | 1.88 | **0.81** |
| proposals/round | 4.00 | 4.58 |
| findings/round | 0.76 | 0.27 |
| **recall calls, 26 rounds** | — | **0** |

Four of five agents dropped; `relay-realtime` was flat (61.8% → 62.5%).

**Real, and smaller than hoped: about a 10% relative cut, not an order of
magnitude.** The mechanism is visible in the probes row — agents stop re-probing
endpoints whose status another agent already established. That is automatic
endorsement working, in Clark & Chalmers' sense: they treat what they read as
true instead of re-deriving it.

**The null result is the more interesting half. Not one `recall` call in 26
rounds.** Agents never once fetched the full payload behind a directory line.
The entire effect comes from the one-line summaries already in the prompt, which
is the strongest available evidence for both Wegner (the payoff is the
directory, not the content) and Hutchins (a store you must decide to query is
one more thing to discover). It also means the content half of the design is,
so far, dead weight.

Two honest caveats. Findings/round fell by nearly two thirds, and this run
cannot separate "no longer re-noticing the same thing" from "less grounded
because it is trusting a summary". And alternation balances maturity but not
store growth: later commons rounds see a richer directory than earlier ones.

## What is actually built, and what each thing is answering

Every mechanic below existed as a citation in this document before it existed as
code. The pattern that kept repeating is that **the instruction version does not
work and the structural version does** — the prompt has always told agents not
to restate the backlog, and they restated it eleven times.

| mechanism | file | what it answers | measured |
|---|---|---|---|
| commons | `scripts/commons.mjs` | rediscovery is the cost, not coordination | discovery share 54.9% → 49.2%, probes 1.88 → 0.81/round |
| learned decay | same | a per-category TTL table is a guess frozen at writing time | re-observation extends life, contradiction halves it |
| known-absent | same | no trail ≠ unexplored trail | absence stored with ¼ the lifetime of presence |
| adaptive preview | same | zero `recall` calls in 26 rounds; "122 items" cannot replace the call | budget goes to the most-confirmed, which *is* the count of re-derivations |
| eligibility | `scripts/eligibility.mjs` | two agents produced nothing across 16 rounds and were invoked every one | agents held when nothing contradicted or new |
| control shell | `scripts/orchestrate.mjs` | nobody should decide to run | stops when nothing is eligible |
| dedup gate | `scripts/novelty.mjs` | 11 near-duplicate pairs in 204 entries, one word-for-word | blocks at 0.45, hands back what it collided with |
| detachability | `scripts/detach.mjs` | exit is the variable, so knowledge cannot live only in the store | 51% of facts sole-sourced; `--export` writes a file that outlives the project |
| context handoff | `shared/contextHandoff.js` | the relay's reasoning died at the Mac boundary | discovery calls 12.3 → 0, uncached tokens −74%, wall clock −67% |

### The failure mode nothing in the literature warned about

A shared store assumes the questions put to it have shared answers. Some do not,
and the ones that do not are invisible until you look for them.

`discover:granted` means *what the orchestrator has given **you***.
`list_capabilities` carries per-agent counts. Stored as common knowledge, each
agent's observation contradicts the one before it forever, and each agent reads
a peer's private state as though it were the world.

Measured on the live store: four such keys accounted for **128 of 201 recorded
changes — 64% of every contradiction in the commons was false.** Because
eligibility counts contradictions, the control shell could never reach "nobody
has anything new". It ran fourteen cycles and was still reporting nine
contradictions at the last one. That is precisely the property that makes an
unattended run bounded by how much actually happened.

The detection has to be empirical. A list of "these keys are personal" is a
guess about today's tools that stops being true the moment one is added. The
signature needs no knowledge of what any key means:

> **every agent is internally consistent, and the agents disagree with each other.**

A fact that genuinely changed never looks like that — the agent that saw it
twice saw it change too. The evidence bar is two agents that have each observed
the key more than once, because one observation apiece cannot distinguish
"personal to each agent" from "changed in between", and mistaking the second for
the first hides a real change from everyone.

**Then the detector found the more interesting case.** `get_hardware_spec` is
personal, and not because hardware differs per agent. The payload carries:

> `you_are_here: "You run on the owner's MacBook (mac-planner). Every device described here is REMOTE to you…"`

Identical hardware facts, one field naming the observer, and every cross-agent
read registering as a contradiction. **The harness was manufacturing the false
contradictions itself** by personalising its own responses.

The general rule, which applies to any system that means to share what it
learns: *a response that embeds who asked cannot be shared, and the personalising
is usually invisible because it reads as helpfulness.* Separate the fact from
the framing at the point of generation, or the store will faithfully record the
framing as part of the fact.

### The thing the commons still does not fix

The collective's most-restated request, proposed **eighteen times** by
relay-realtime across rounds 26–62, is *"keep working after I stop talking, then
tell me what happened when it's done."*

Every component of it already exists:

| the ask | what ships today |
|---|---|
| work continues after the owner leaves | `GET/POST /jobs`, `/jobs/:jobId`, `/jobs/:jobId/cancel` — a 24 h queue the Mac bridge claims from |
| tell me what happened | `GET /jobs/:jobId/receipts` |
| tell me **on the pendant** | `/v1/pendant/announce`, `/v1/pendant/speak`, `/v1/announcements` |

The last row is on relay-realtime's *own* surface. It has been asking for a
capability whose delivery mechanism it probes every round.

And the commons does put the rest in front of it: its prompt now carries
`discover:routes — 123 items (2m, 9 agents)`, and the preview on that line names
`GET /jobs`, `/jobs/:jobId` and `/jobs/:jobId/receipts` outright. It can see the
parts without spending a call. It asked twice more anyway.

**So the missing thing is not the parts. It is that nothing in this system
represents what the parts already compose into.** The commons is a directory of
primitives — routes, devices, specs, chips. A capability is a *path through*
several of them, usually across surfaces, and no agent can see a path by reading
an inventory. Every one of the 835 proposals is an agent describing an
experience it wants; not one is an agent noticing that the experience is three
existing endpoints in a row.

That is the next thing worth building, and it is a different object from the
commons: not "what exists" but "what is already reachable end to end". It also
explains the shape of the corpus better than anything else measured tonight —
the agents are not short of facts, they are short of composition.

`propose_capability` now requires `built_from` and `scripts/reachability.mjs`
checks the answer against what the commons holds. On the first live round after
it landed, relay-realtime's nineteenth restatement was blocked as a duplicate,
it was told all six pieces it had named already exist, and it proposed something
different instead.

#### The blindness underneath it

`/v1/pendant/announce` still reads as *unseen* to that check, and it ships. The
reason is worth stating because it is the same shape as everything else here:

**The relay has 41 routes and no way to enumerate them.** The Mac agent
publishes `/capabilities` built from its live router, so `discover:routes` puts
123 routes into the commons for everyone. The relay publishes nothing
equivalent, so the only relay knowledge in the commons is whatever paths some
agent happened to guess and probe.

Measured, and it is not a shortfall so much as a hole:

| surface | in the commons | published |
|---|---|---|
| Mac agent routes | 103 | ~120 (**86%**) |
| relay routes | **0** | 41 (**0%**) |

Not one relay path. And the relay is the surface the pendant actually talks to —
the collective knows the machine the owner is not holding, and nothing about the
one they are.

Which means **the agent that can least see its own surface is the one that most
restated a request for something on that surface.** relay-realtime is not
careless; it is blind in the one direction nobody instrumented.

Not fixed here, deliberately. The relay's route table is imperative —
`scopesFor(method, path)` is a chain of `if` statements, not data — so making it
self-describing means refactoring auth-scope dispatch, where a mistake is a
security bug rather than a wrong number. A statically declared list would be the
hardcoding this project has avoided everywhere else, and would drift silently.
The Worker cannot be deployed without the owner in any case. So: the highest-
value next change, and one that should be made awake.

### What the control shell actually bought, stated carefully

Run unslotted so that rounds-per-cycle equals agents-eligible, 9 agents, 8
cycles: **28 rounds against the 72 an unconditional loop would have run — 61%
fewer.** Rounds per cycle went 3, 1, 3, 3, 6, 3, 6, 3, the sixes being the
starvation floor sweeping up agents it had been holding.

**That is 61% fewer rounds. It is not 61% less waste, and the difference
matters.** Every floor-forced round turned out productive — 1 to 4 capabilities
apiece. The agents being held were not empty; they were deferred. Proposals
land at ~3.9 a round in both conditions, so 28 rounds produce proportionally
fewer proposals than 72 would have.

So the honest claim is that the shell **rate-limits** rather than eliminates: it
spends the same per-round output on far fewer, better-motivated invocations, and
guarantees nobody is silenced indefinitely. Whether that is a saving depends
entirely on whether the skipped proposals were worth having. The dedup evidence
— 64 same-agent near-duplicate pairs — suggests a meaningful share would have
been restatement, but that is an inference and not a measurement.

**And "silent rounds" has stopped discriminating.** It reads 0/242 now, because
the proposal phase always produces something once an agent is out of recon. The
earlier 3/25 → 0/49 improvement was mostly the recon fix, which let a stranded
agent record at all — not the commons and not the gate. A metric that cannot go
up any more is not measuring the thing it was chosen for.

### Differentiation and detachability pull against each other

Wegner's third finding is that the benefit of a transactive memory system comes
from *differentiation* — five nodes that all need to know the same things is the
anti-pattern. This system now has that: at any grouping threshold meaning "the
same idea", no proposal cluster spans two agents.

The bill arrives on the other side. Measured with `detach.mjs` as the collective
grew from 5 agents to 9:

| | facts | sole-sourced |
|---|---|---|
| 5 agents | 53 | 27 (**51%**) |
| 9 agents | 97 | 60 (**62%**) |

**More agents made the collective more fragile, not less.** Every agent explores
its own corner, so growth adds facts faster than it adds second witnesses. The
intuition that redundancy comes free with scale is exactly backwards here.

The two goals are in genuine tension and cannot both be maximised: overlap is
waste by Wegner and insurance by exit. Nothing resolves it in general. What the
system can honestly do is *measure* the position it has taken — which is what
`detach.mjs` is for — and keep the export path working, so the owner's copy
never depends on any node still being there.

**An agent that cannot act is indistinguishable from an agent with nothing to
say.** Three separate times a harness defect arrived dressed as an architecture
result: propose tools gated behind a phase, a proposal phase writing prose
instead of calling tools, and an agent stranded in recon for eighteen rounds.
Every one of them produced a clean-looking zero in a comparison table.

**Nothing in the harness could time out.** Every `fetch` was unbounded and the
round deadline is only consulted between steps, so one dead connection stalls a
round forever — and, once the state lock existed, blocks its launcher behind it.

**The measurement apparatus needs the same scepticism as the system.** Rounds
counted by log greps that missed proposals; arms compared at different
maturities; a condition inferred from which shell had which variable set. Each
produced a confident, wrong conclusion. Rounds now record their own condition,
and `harness-stats.mjs` refuses to pool arms that are not comparable.

### The channel nobody read

The harness has always had a way for an agent to say something is wrong:
`request_context`, `request_tool`, `request_permission`, each carrying a `why`
and a `how_it_changes_my_behavior`. The orchestrator grants or denies.

**141 requests accumulated. Not one was ever answered.** Every measurement in
this document was taken from the agents' *output*, while the channel they used
to report *defects* went unread. What was in it:

- **21 requests for `propose_capability` and `propose_change`.** Not a
  misunderstanding: those agents were stranded in the recon phase, where the
  propose tools are genuinely absent from the list, and the phase only ever
  advanced when a human typed the command. They diagnosed it correctly and said
  so twenty-one times. Their zero then entered the three-arm comparison as a
  result about partitioning a mind by faculty.
- **relay-realtime, three times, rounds 32, 67 and 72:** `discover('granted')`
  lists tools that `describe(name)` reports as non-existent. It named both tools
  each time and stated what it would do differently either way. It was right —
  `describeThing` checked granted context and never granted tools.
- **Six different agents asking for macOS Accessibility and Screen Recording.**

That last one is worth sitting with. Measured across 835 proposals, cross-agent
convergence is **zero** — not one cluster spans two agents at any threshold
meaning "the same idea". But six agents independently converged on the same
*blocker*.

**The convergence was in the requests, not the proposals, and the measurement
was pointed at the wrong output.** A collective that can speak and is not heard
produces exactly the signature this one showed: repetition that reads as poverty
of imagination and is actually an unanswered question asked louder.

The requests are now being answered — the TCC ones denied with the measured
reason they cannot be granted from inside the harness, the propose-tool ones
closed as a fixed defect, relay-realtime's answered with what it could not have
discovered. That the backlog existed at all is the finding.

## The one finding underneath the others

Three separate investigations tonight converged on a single phenomenon, and it
is not the one this document was opened to study.

| symptom | what it turned out to be |
|---|---|
| one capability proposed **18 times** | every piece of it shipped, two named in the agent's own prompt |
| **21** requests for `propose_capability` | the agents had been given it and the phase never advanced |
| **2** agents requesting authenticated Mac access | `probe_http` already sends the bearer token; the commons records their peers getting HTTP 200 |

**Agents cannot tell what they can already do.** Not merely which primitives
compose into a capability — that is the composition gap — but whether they
*possess a tool*, whether they *have an access*, whether a phase has *given them
a verb*. Each was answerable from information already in front of them.

This is a different problem from the one the commons solves. The commons
answers *what is true about the world*. Nothing answers *what is true about
me* — and an agent wrong about its own capabilities burns rounds requesting
what it holds, and reads externally as unimaginative or repetitive. Every
measurement in this document that looked like poor agent output was, on
inspection, this.

The cheap version of the fix is already in: `built_from` on a proposal (177 of
179 now name real routes), `why_existing_tools_insufficient` on a tool request,
`describe()` finding granted tools, and recon ending on its own. The expensive
version — a standing, per-agent statement of *what I currently hold and what
that lets me do* — has not been built, and on this evidence it would be worth
more than anything else on the list.

## Empirical baseline for this class of system

MAST (arXiv 2503.13657), 1600+ annotated traces across 7 frameworks, κ=0.88:
**41.8% system-design/specification failures, 36.9% inter-agent misalignment,
21.3% verification gaps** — and the authors conclude better communication
protocols are *insufficient* for the misalignment category. Consistent with the
measurement here: the messaging layer is not where the problem lives.

# What to build

2026-08-07. Supersedes `belief-reconciliation.md`, which the owner rejected as
too narrow. That judgement was right and the reason is recorded below.

## The number this rests on

| | denied | appealed | overturned on appeal |
|---|---|---|---|
| Medicare Advantage, 2024 | 4.1M of 52.8M requests (7.7%) | **11.5%** | **80.7%** |
| ACA marketplace, 2021 | 48.3M of 291.6M claims (16.6%) | **<0.2%** | **41%** |

Source: CMS administrative data as analysed by KFF.

An action that succeeds **41–81% of the time** is taken by **0.2–11.5%** of the
people entitled to take it. The gap is not information, eligibility or skill.
Everyone involved knows they were denied and knows appeal exists. The gap is
**activation cost**: it requires sustained attention to a slow process across
weeks, through a portal you must be logged in to, against a counterparty who
loses nothing by being slow.

That is the precise shape of what this system removes.

## The reframe that matters

The friction is coordination — but with **institutions**, not with people.

**Person ↔ institution** is one-sided. The insurer, the utility, the hospital
billing department, the airline, the DMV are *already staffed and obligated to
respond*. Nobody else has to adopt anything. A single user's agent captures the
entire value unilaterally, on day one, with one user.

**Person ↔ person** — scheduling, chasing commitments, negotiating with a
partner — is larger in raw hours and is a trap. It is two-sided: the value only
lands if the other human, or the other human's agent, cooperates. It carries
the highest social risk of any delegation, and the delegation-willingness
research is worst exactly there.

So: build a personal agent, and point it at bureaucracies rather than at
friends. That needs precisely what this system already has — persistent
authenticated sessions nobody else can reach, continuous availability across a
multi-week clock, and the ability to act on a computer. It needs nothing from
the counterparty.

## The constraint that decides the hardware, not just the software

Always-on capture of *other people's* speech is not a hard problem to be
engineered around. It is illegal in roughly twelve US states and under GDPR,
and the exposure lands on the **wearer**, not the vendor.

- **Illinois** (720 ILCS 5/14-2): knowingly recording any part of a private
  conversation without all-party consent is a **Class 4 felony** on first
  offence, with a private right of action.
- **California** (Penal Code 632 / 637.2): the greater of **$5,000 per
  violation or 3× actual damages, with no requirement to prove any loss**.
  Multiply by conversations by participants: unbounded, and uninsurable for an
  individual.
- **EU**: after *Ryneš* (C-212/13) the household exemption does not cover
  outward-directed capture, and a worn recorder is outward-directed by
  construction. The wearer becomes a **data controller** for every bystander.

The shipping products confirm it by their own behaviour. **Limitless was
acquired by Meta (announced 5 Dec 2025), the Pendant discontinued, and service
terminated outright in the EU, UK, Brazil, China, Israel, South Korea and
Turkey the same day** — precisely the jurisdictions where the burden shifts to
the wearer. *Brewer v. Otter.ai* (consolidated Dec 2025) is litigating exactly
the posture every pendant ships in: host-only consent, with the consent duty
contractually pushed onto the customer.

Building a consent mechanism is the wrong answer, because the artifact it
produces probably is not legally valid consent: CIPA needs consent before the
capture, and GDPR consent must be freely given and cannot be a precondition of
an ordinary human interaction.

**So the design is forced, and this is a feature.** Capture is gated to the
*owner's own speech*: non-enrolled voices never reach durable storage. That is
legal everywhere, it is technically hard, and nobody ships it well. It also
happens to be all this product needs — an appeal is built from the owner's own
account of what happened plus their authenticated records, not from
transcribing whoever they were standing next to.

## Two dead ends, verified rather than assumed

**Agent-to-agent coordination between different people has already failed.**
Google Duplex shipped in 2018, hit the disclosure backlash, narrowed to four
cities and restaurant reservations, and by Oct 2020 the metric Google reported
was **3M+ business listings updated** — a Maps data-collection pipeline, not
appointments booked. A2A supplies identity and authorization but no
non-repudiation and no dispute resolution, so neither agent can promise
anything its principal is bound by. And once both sides must disclose they are
AI, natural-language negotiation is strictly worse than the API call it
emulates. Where a neutral coordinator can exist, it dominates: Calendly beat
agent-to-agent scheduling and always will.

**Acting with spending authority is not legally blocked — it is legally settled
against the owner.** UETA §14: a contract formed by an electronic agent binds
the principal "even if no individual was aware of or reviewed" it. *Moffatt v.
Air Canada* (2024 BCCRT 149) rejected the argument that the chatbot was a
separate entity. There is no "my agent did it" defence, and the reliability is
not close: Anthropic's own Claude for Chrome reports prompt-injection success
of 23.6% falling to 11.2% after mitigations, and blocks financial sites by
default.

**The consolidation pattern is the clearest signal in the whole field.**
Humane → HP ($116M, software and patents, device business explicitly excluded;
~10,000 units against a 100,000 target, returns exceeding purchases May–Aug
2024). Limitless → Meta. Bee → Amazon. In every case the acquirer took the team
and the data and **killed the device**. Nobody has bought one of these as a
going hardware concern.

## Why a gate here is not the gate I kept rejecting

Dietvorst, Simmons & Massey (2018, *Management Science*): people are
considerably more willing to use a known-imperfect algorithm **if they can
modify its output**, and are *relatively insensitive to how much* modification
is permitted. They want some control, not more control.

So the agent assembles the evidence, drafts the appeal, fills the portal, and
holds the deadline for six weeks. The human presses send. In claims and appeals
the work is roughly 95% preparation and 5% commit, so that gate costs almost
none of the captured value and is what makes the thing get used at all.

This is not the capability-broker gate rejected repeatedly in the ledger. That
one asked permission *to read and to act on the owner's own machine*, per step,
and its cost was the whole product. This one is a single signature on an
outbound document that leaves the owner's control and reaches a third party —
the one place a signature belongs.

## What I got wrong, recorded so it is not repeated

1. **Belief reconciliation** (catching the owner being wrong about their own
   life) was a feature dressed as a thesis. It optimised for a moment of
   cleverness rather than for a pool of value. Correctly rejected.
2. **"One mind, many bodies"** — I proposed replacing five messaging agents
   with a single agent holding every tool, and tested it. Measured over one
   round: committee 78% discovery share, unified 81–90%. It made things worse,
   because one agent holding every surface has *more* to discover, not less.
   The test was also underpowered and confounded (unified at rounds 1–3 against
   a committee at rounds 14–26) and is being re-run to parity.
3. **The cost was never coordination.** 11 messages against 64 discovery calls
   — 13% versus 78%. I spent most of a session tuning the small term.

## The thing the measurement actually points at

Discovery is 78% of every budget **because each environment starts cold**. The
handoff today is the worst case: the relay holds a conversation, distils it to
a list of actions, POSTs those to the Mac, and the Mac's planner begins from a
fresh system prompt with nothing but the action list. Everything the relay
understood is discarded at the boundary, on every crossing.

The owner's framing is the stronger one: **the context itself should migrate**.
Same reasoning thread, different body. Then discovery is paid once rather than
once per environment per round.

The hard part is not the plumbing. The bodies run different models —
`gpt-realtime` on the relay, `gpt-5.6-luna` on the Mac, `gpt-4.1-mini` for
vision — and a context window is model-specific in practice: different tool
schemas, different formats, and prompt caching will not follow it across. A
migrating context needs a representation that survives the crossing without
being re-derived on arrival. That is the design problem worth solving, and it
is what makes a collective one mind rather than an org chart.

Both halves are the same bet: **the collective's knowledge must live outside
any single member and must not reset.** Ants do not remember the trail; the
trail remembers.

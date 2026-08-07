# The night of 2026-08-07, in two minutes

Nine agents ran unattended. The detail is in `collective-architecture.md`; this
is what you would want to know first.

## What got built

| | what it does | measured |
|---|---|---|
| `scripts/commons.mjs` | shared knowledge, content-addressed, decay learned rather than configured | discovery share 51% → 46%, probes 1.88 → 0.81/round |
| `scripts/eligibility.mjs` + `orchestrate.mjs` | agents run when the world moved, not because a loop said so | 28 rounds where a loop ran 72 |
| `scripts/novelty.mjs` | refuses to record what the system already has | 64 same-agent blocks, **0** cross-agent, across 291,466 pairs |
| `scripts/reachability.mjs` | makes an agent name what its proposal is built from | 177 of 179 now name real routes |
| `scripts/detach.mjs` | measures what survives if a node leaves; exports the lot | 139 facts, 64% sole-sourced |
| `shared/contextHandoff.js` | your idea: context crosses bodies by handle | uncached tokens −74%, wall clock −67% |

## The three findings that matter more than the code

**1. The collective could speak and nobody listened.** 141 requests had
accumulated, none answered. Inside: 21 correct diagnoses of a live harness bug,
a defect report from relay-realtime that was right in every particular and
repeated three times over 40 rounds, and six agents converging on one blocker.

Across 835 proposals, cross-agent convergence was *zero*. In the requests it is
five of nine agents asking the same question. **The measurement was pointed at
the wrong output.**

*Updated later the same night:* at 1,761 proposals it is 9 clusters spanning two
agents — still only 1%, but no longer zero, and what they agree on is real (an
offline catch-up digest; save-from-Safari-hear-on-pendant; prepare on the Mac and
approve from the pendant; never silently guess a timezone). Possibly the dedup
gate forcing agents off restatement and onto new ground, possibly just volume —
untested.

**2. Agents cannot tell what they can already do.** One capability proposed
eighteen times whose every piece ships. Twenty-one requests for tools the agents
had been given. Two agents requesting access their own probe already carries.
Every one answerable from information already in front of them.

**3. Nobody checked whether the pendant exists.** It does not — the relay's
device table holds only the Mac bridge and a mobile device last seen 2026-07-31.
No nRF9160 has ever registered. A large share of the proposals describe what a
worn device should do, and the `/pipeline` telemetry they cite is recorded
history that reads exactly like live data unless you look.

## What needs you

1. **The 24 kHz acceptance criteria** — five of nine agents independently
   blocked on it. They have measured the path and cannot say whether it passes,
   because nothing says what passing is. See `what-your-agents-need.md`.
2. **The timezone contradiction** — owner memory says `America/Chicago`, the
   machine says `America/New_York`. Three agents found it and refused to guess.
3. **Restart the Mac agent** to load the browser-queue fixes. It started at
   03:36, before both landed; `DELETE /browser/commands` 404s against it and
   `pendingCommands` is climbing. The extension now refuses stale commands on its
   own, so nothing will fire at you — but the queue only clears on restart.
4. **The D1 migration** (`cloudflare-worker/context-handoff-migration.sql`) is
   verified-ready and unapplied. `d1ContextSchema.test.js` runs its real SQL
   against the real schema. Deploying is yours.

## What I got wrong and corrected

- Claimed prompt-cache migration was impossible. It ships everywhere; the
  boundary is per-model. You caught this one.
- Reported a run as ended when it was a sequential runner working normally.
- Claimed the agents had converged on two product properties and called it the
  strongest evidence either argument had. Measured it afterwards: zero
  cross-agent clusters at any threshold meaning "the same idea". Retracted — and
  then partly vindicated by accident, since at twice the corpus there are 9. The
  claim was still wrong when made: I asserted it before measuring, and being
  later shown right by different data does not make an unmeasured claim sound.
- Claimed a required justification field would cut request volume. It did not;
  the rate was already falling and rose after. Recorded as unproven.

## Not done, on purpose

- **Making the relay self-describing.** It has 41 routes and no inventory, so
  **0%** of it is in the commons against 86% of the Mac's — which is why nobody
  saw `/v1/pendant/announce` or the empty device table. Fixing it means
  refactoring `scopesFor`, where a mistake is a security bug. Should be done
  awake.
- **Leases for side-effectful work.** The last unimplemented item from the
  research. Checked for evidence of need and found none — nothing is currently
  duplicating side effects, so building it would be fixing a problem this system
  does not have.

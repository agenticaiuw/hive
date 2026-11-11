# Belief reconciliation

Proposed 2026-08-07. Author: the orchestrator, not a discovery agent.

## The bottleneck this removes

Every assistant that has ever shipped is gated on the user knowing what to ask.
Scheduled briefings, page watchers, research agents and routines do not change
this — they are request-response with a timer attached. A user's value ceiling
is their own ability to formulate a request, and that ceiling has not moved in
the entire history of the category.

This system can move it, because of what it happens to touch at once:

| substrate | what only it has |
|---|---|
| pendant | what the owner asserts in ordinary speech, to other people |
| browser | authenticated ground truth nobody else can reach — orders, bookings, balances, tickets |
| Mac | the private record — what was actually sent, scheduled, written |
| relay | attention while the owner keeps talking |

Combine them and you get a thing that does not exist in any product today: a
system that catches the owner being wrong about their own life, in the moment,
while it is still cheap to fix.

    "The flight's at 6."          the airline session says 8:40
    "I already cancelled that."   the account page says it renews Tuesday
    "I sent it yesterday."        Mail says the draft is unsent
    "We agreed on twelve."        the thread says fourteen

None of those is reachable by a single node. Ambient recorders (Rewind,
Limitless, Bee, Plaud) transcribe and summarise — they deliver *recall*. None
holds an authenticated session, so none can say the owner was *wrong*.
Assistants answer questions. This answers the question the owner did not know
they had, because they did not know they were wrong.

The claim is not "faster". It is that **value stops scaling with the owner's
ability to ask**. Different function, not a better constant.

## The second half: beliefs have an age

Everything a person knows was true when they learned it. Nothing anywhere
tracks *when* the owner last had ground truth for a belief. Recording that age
turns a static store into something that can refresh what is both stale and
about to matter — before the meeting, not in the postmortem.

## Why precision is the entire product

A system that is wrong 30% of the time about the owner being wrong is worse
than nothing: it trains them to ignore it, and then it is worse than silence
forever. The bar is not "usually right". It is:

- Speak only when ground truth is **authoritative** (the owner's own
  authenticated record, not an inference) and **unambiguous**.
- Prefer silence to a maybe. An unverifiable assertion is discarded, not
  guessed at.
- Never contradict on taste, plans, or opinion. Only on facts that have a
  record.

## Hard parts, stated up front

1. **Most speech is not checkable.** The extractor's main job is discarding —
   expect to throw away the overwhelming majority of utterances. An extractor
   with a high yield is broken, not productive.
2. **Ambient capture includes other people.** Two-party consent jurisdictions
   are a real constraint, not a footnote. Capture must be owner-owned,
   on-device by default, and must be able to *not* record.
3. **Verification costs money and latency.** Hitting an authenticated page per
   sentence is impossible. Triage is mandatory: checkable × consequential ×
   stale. Nearly everything dies at the first term.
4. **A stale ground truth is a wrong ground truth.** A cached page that says
   "renews Tuesday" from three weeks ago is not evidence. Every verification
   carries the age of its source, and an old source disqualifies a correction.

## Current state of the substrate — measured, not assumed

- `GET /v1/ops/history` returns **0 items**. Transcripts flow through live
  conversations but nothing retains them as a queryable stream. **The assertion
  stream does not exist.** This is step one and it is real work.
- `local-agent/browserSessions.js` + `browserPage.js` can read authenticated
  pages, single-URL at a time. There is no multi-origin fan-out.
- `local-agent/` has real Mail, Calendar and file readers (`appleData.js`,
  `mailTriage.js`, `meetingPrep.js`).
- `cloud-relay/scheduler.js` gives the relay a clock and an outbound announce
  path, so the relay can act while the Mac sleeps.

## Build order

1. **Assertion ledger.** Retain first-person checkable claims from conversation
   transcripts: the claim, when it was said, its subject, and what would verify
   it. Nothing today stores an assertion stream; this is the substrate for
   everything else, and is independently useful (it is also the honest source
   for "what did I promise?").
2. **Ground-truth binding.** Route an assertion to the substrate that can check
   it: calendar/mail/files → Mac; orders/bookings/subscriptions → authenticated
   browser; public facts → web. Record the age of the evidence.
3. **Divergence, spoken once.** When belief and truth disagree, and the gap is
   consequential, say it briefly — in the moment or at the next natural break.
   Once. Never twice.
4. **Staleness refresh.** Track when a belief last had ground truth; refresh
   what is both stale and imminent.

Steps 1 and 2 are worth building even if 3 is never switched on, which is the
test of whether the decomposition is honest.

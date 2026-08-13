# The Screenless App Grammar

How the pendant grows "apps" — Time, Timer, Alarm, Reminders, Calendar, Audio
devices — without a screen, and how the owner always knows where they are. Phase 1 of the owner's
2026-08-12 ask: *"we need to build more default programs into the firmware for
more simple things like time and also timer, reminder, calendar, etc. kind of
like an ios but remember our i/o with the user has no screen, so a lot of
things will have to be changed to create a seamless and intuitive experience
where the user knows how to operate."*

## The one hard rule

**No flow may require two presses to initiate.** The yellow press that opens
the conversation is the one press. The first detent after it opens the ring
**and** lands on its home entry — an opening detent that merely "unlocked" the
ring would be exactly the second gesture this rule forbids. Nothing added later
may introduce one.

## The verbs (context-sensitive)

**Select is a button press. Which button does what depends on whether the ring
is open.** Owner's ruling, 2026-08-13, verbatim:

> *"remember we can use the fucking buttons bro, right now it seems like you're
> using stopping the turning as confirmation for selecting but we should just
> use a button. only when no \[app] is selected those buttons are reserved for
> the llm talk and the memo."*

| Control | Ring CLOSED (global) | Ring OPEN (in the ring or an app) |
| --- | --- | --- |
| **Yellow** | short press: start / stop the conversation · long press: push-to-talk question | **select / confirm** what the ring is pointing at |
| **Blue** | memo capture (record-only, no planner) | **back** — one level up; from the top level it closes the ring and both buttons go global again |
| **Encoder turn** | *(ignored — a menu you cannot hear is not a menu)* | scroll the current ring, or change the current number |
| Red switch | mic power cut (hard mute) | same |
| Potentiometer | volume | same |

The bench has exactly **two working buttons and an encoder with no switch**.
The green button is not wired; memo moved to blue and push-to-talk moved to a
long yellow press. Both surviving buttons already carry a global verb the owner
will not give up, and there is no third button — so the only variable left is
**context**, and context is enough, because the two states are perfectly
disjoint from the owner's point of view: either they are in a menu or they are
not, and they always know which because the ring speaks.

### Why dwell-to-select is gone

The previous draft committed on **dwell** — 1.5 s of stillness after a detent.
The reasoning against it is worth keeping, because it is the reasoning *for*
what replaced it:

- It made the pendant's most consequential act — starting a thing, connecting
  a thing — the one act the owner performs **by doing nothing**, on a device
  that hangs from a lanyard and gets bumped. A knock emits a detent, and 1.5 s
  of hanging still afterwards is the pendant's resting state.
- It cost **1.5 s on every single selection**.
- It could not tell "I have chosen" from "I am thinking".

**What survived: the ~200 ms settle.** It was never a selection mechanism — it
governs when the ring is allowed to *speak*. A detent is a blip rendered
locally; the name (or, in a numeric field, the bare number) is spoken once the
hand stops, so a fast spin costs one sentence instead of forty. Selection and
speech are now triggered by cleanly different events, which is exactly what
dwell conflated. It also stopped being load-bearing for *safety* — nothing
commits on a settle any more — so `SETTLE_MS` (`cloud-relay/menuSettle.js`) is
now free to be tuned for feel alone.

**`Back` stays a ring entry even though blue does the same job.** Two ways out,
on purpose: blue is the fast one for an owner who knows it, and the `Back`
entry is the one a first-time owner *discovers* by turning the knob, without
having been told anything. `menuRing.test.js` asserts the two paths are
indistinguishable.

### The firmware contract

**The device cannot work out which context it is in — the ring lives on the
relay.** So the relay tells it, on every transition:

| Direction | Frame | When |
| --- | --- | --- |
| relay → device | `{"type":"menu_context","active":true}` | the ring opens |
| relay → device | `{"type":"menu_context","active":false}` | the ring closes, **and** on every conversation teardown |
| device → relay | `{"type":"menu","delta":±1}` | one detent, any context (dropped by the relay when no conversation is live) |
| device → relay | `{"type":"menu_select"}` | yellow pressed **while `active`** |
| device → relay | `{"type":"menu_back"}` | blue pressed **while `active`** |
| device → relay | *(nothing on this channel)* | either button pressed while **not** `active` — they run their local audio jobs instead |

The context frame is sent **ahead of the sound** that announces the same
transition, and never awaited. The owner's next press can land during the
earcon, and a device still holding the old meaning would fire the wrong verb.

**Failure mode, and it is not symmetric: if the context frame is lost, the
device MUST default to the GLOBAL meanings.** A dropped frame then costs the
owner a stray memo — recoverable, and audible the moment it happens. Defaulting
the other way costs them a button that *silently does nothing*, on the one
device that cannot show them why. `menu_select` / `menu_back` arriving with no
live conversation is the same failure seen from the relay end: it is logged and
ignored, because acting on it would commit against a ring that no longer exists.

The frame **names** are unchanged from the dwell era on purpose. `menu_select`
and `menu_back` already meant "commit" and "one level up"; only their *cause*
moved (a rested knob became a yellow press, a ring entry became a blue press).
Renaming them would have broken the dashboard and the firmware for a rename
that taught nobody anything.

### Push-to-talk kept its economics, and moved to yellow

Blue was approve/deny in the first draft, push-to-talk in the second, and memo
now. The energy argument that won PTT its own gesture is unchanged and still
decisive: a PTT question costs ≈1 mWh against 2.3 mWh for the same question as
a duplex exchange — **2.4× cheaper**, "because the radio never idles connected
while the human talks: capture costs 4.2 mA, not 65 mA"
(`hardware/design/Solar_Feasibility.md` §4.3). At that price an outdoorsy summer
harvest carries 7–12 questions a day instead of one or two. What changed is
only *which* gesture carries it: a **long yellow press**, because yellow is
already the talk button and a long press of the talk button is the one mapping
nobody has to be taught.

**Approvals did not lose a control; they lost a dedicated one.** They are
answered by *voice* — the readback ends with the confirm word, and the next
utterance is tried against it (`answerSpokenApproval` in
`cloud-relay/approvalDelivery.js`) — and on the dashboard and the extension
popup, both of which list what is pending. Nothing about approvals needed a
button of its own: the readback already puts the question in the owner's ear
mid-app, and the answer to a spoken question is speech.

What the device *does* keep is the **cue**: the relay sends
`{"type":"approval_readback"}` immediately before a readback and the firmware
fires its strong haptic. With blue reassigned, that buzz is the only
device-side signal that the next sentence is a decision rather than an answer,
so it is sent unconditionally and never awaited — a missed buzz costs the
nudge, never the readback.

**Which button asked** is recorded, not inferred. Push-to-talk questions ride
the same `dispatch=1` command route a yellow-button command rides, with the
same body and the same audio format, so nothing in a job record could tell
them apart — and they are the cheap ones, which is exactly the attribution
worth having. The relay accepts `X-Pendant-Mode: ptt | duplex | memo` from an
allowlist (`PENDANT_MODES` in `cloud-relay/server.js`) and stores it on the
job; the converse socket tags itself `duplex` and a ring-driven app job `knob`.
Absent header means **null**, never a guess from the transport: which
transport a button uses is a firmware build detail, and a confidently wrong
label is worse than an honest blank.

## How you know where you are (no screen)

Every ring position has two cues, always in the same order:

1. **A position-pitched earcon** — a short blip whose pitch rises as you
   scroll forward through the ring and falls as you scroll back. Pitch alone
   tells your ear "third of four" the way a scrollbar tells your eye. The app
   ring and the rings inside apps use different base pitches, so "which ring
   am I in" is audible before any word is spoken. Spinning the knob fast
   clicks a blip per detent, exactly like a click wheel.
2. **The name, spoken** — "Timer.", "Reminders." — rendered after the knob
   settles (~200 ms), so spinning the ring costs a blip per detent and one
   name, not four sentences. Inside a numeric field the same settle speaks the
   **bare number** instead.

A **numeric field** is treated as a ring too, and the earcon says so: its
"position" is the value within the range, so a long spin becomes an audible
sweep and the ear learns "high in the range" before any number is spoken. A
refused move at a stop gets its own `edge` motion — a muted double-blip at the
same pitch, meaning "nothing changed".

The commit never repeats the name the settle already spoke — it answers with
the app's own words.

## Every app says its name, then how to work it

Entering an app **speaks its surface immediately** — there is no silent landing
anywhere, because on a screenless device silence and breakage sound identical.
The surface is always the same shape: **the app's name, then a one-line
how-to.**

That hint is now the entire discovery path for selection. Dwell was the last
gesture an owner could stumble into by accident; a button has to be named. So
the hint is spoken **every time** the owner enters an app, not once per session
— there is no scrollback on a device with no screen, and an owner who talked
over it has no way to ask for it again. It is also why hints are capped at ten
words: a sentence the owner learns to talk over is a sentence that has stopped
working.

| App | Spoken on entry |
| --- | --- |
| *(ring opens)* | "Time. Turn to choose, yellow to open, blue to leave." |
| Time | "Time. Yellow to hear it again." *then the time* |
| Timer | "Timer. Turn to choose, yellow to start." |
| Alarm | "Alarm. Turn to set the hour, yellow to confirm." |
| Reminders | "Reminders. Yellow to check again." *then* "Checking your Mac." |
| Calendar | "Calendar. Yellow to check again." *then* "Checking your Mac." |
| Audio devices | "Audio devices. Turn to choose, yellow to connect." |
| *(numeric field)* | "Setting minutes. Turn to change, yellow to confirm." |

**None of these sentences is a hardcoded string.** They are composed from one
exported table of controls (`cloud-relay/controlVocabulary.js`), so a remap
edits the table and every spoken instruction changes with it. This is not
theoretical tidiness: this bench remapped three times in two days, and the
grammar has already shipped one spoken lie — *"Press to start."* on an encoder
whose switch is not wired. It took a bench session to find, because on a
screenless device a wrong instruction is **unfalsifiable by the person
receiving it**: they press the thing they were told to press, nothing happens,
and they cannot tell whether they misheard, missed, or own a broken pendant.

`controlVocabulary.test.js` fails the build if any composed hint names a
control this bench does not have. It checks both directions — a **blocklist**
for the mistakes already made (`green`, `LED`, `light`, `colour`, "press the
knob", "hold"), and an **allowlist** that rejects any control-shaped noun
("wheel", "slider", "trigger") not in the table. It also walks a whole
session through the reducer and checks every utterance, so a hardcoded string
added to `menuRing.js` in six months is caught by the same test.

**Colour names a button; it never names a status.** "Yellow" and "blue" are
everywhere in the hints, and that is not a contradiction of the ban on colour:
the owner's two working buttons *are* yellow and blue, and the colour is how a
hand finds them without looking. What is banned is asking the owner to *look*
at a colour or reporting state as one — **the RGB LED is not wired**, so any
such sentence describes a part that does not exist.

## The apps

- **Time** speaks the time and leaves you on the ring (a one-shot surface,
  nothing to be inside of). Its hint is true precisely because the cursor did
  not move.
- **Timer** offers three presets (5, 10, 25 minutes) as a fast path, then
  **Custom**, which opens a numeric field. Yellow starts the timer and returns
  you to the app ring — a preset ring that stayed open would let a stray knock
  cost you a second timer.
- **Alarm** has no preset ring (there is no such thing as a common alarm time),
  so selecting it drops straight into an hour field, then a minute field. It is
  backed by the same timer store.
- **Reminders** and **Calendar** speak a short brief (today's reminders /
  today's schedule) fetched live from the Mac, with honest spoken empties —
  "No open reminders." — and honest spoken failures. You stay on the ring while
  it fetches; the brief lands the moment the Mac answers. Entering says
  "Checking your **Mac**" — not "your reminders", which the ring just said
  twice — and that sentence is not filler: the read measures **~16 s** on the
  owner's Mac, and sixteen seconds of silence on a screenless device is
  indistinguishable from a dead knob.
- **Audio devices** — see the ordering rules below.

Closing the menu (blue from the app ring, or turning to `Back` and pressing
yellow) plays a falling earcon and no words: silence plus a downward blip is
"you are back in the plain conversation", and adding a sentence there would say
nothing the blip does not.

## Numeric entry

The owner's rules, 2026-08-13, and the reasoning that follows from each:

1. **One detent = one unit, at any speed. No acceleration, no coarse steps.**
   Acceleration is a *screen* affordance: it works because your eye watches the
   number race and your hand corrects. With no readout until the hand stops, an
   accelerating spinner is unsteerable — you learn where you landed only after
   you can no longer influence it. A linear knob is slower and always exactly
   predictable, and predictable is the only currency a screenless control has.
   The reducer consults no clock, which is the structural reason acceleration
   cannot creep back in.
2. **The field is announced once**, on entry: "Setting minutes." The starting
   value follows, so the owner is not turning blind.
3. **Every settle speaks the bare number** — "seven." "eight." No units, no
   sentences. A unit repeated per detent is a device talking over its own owner.
4. **Yellow commits, and the confirmation repeats the value with units, once:**
   "Timer set for 7 minutes." Coming off a field the owner has heard nothing but
   bare numbers, so this is the first and only place the unit is said.

Multi-field entry (Alarm) advances to the next field and announces it —
"Setting minutes." — **without** the how-to attached: the owner just used the
gesture successfully, and explaining a thing you watched somebody do is how a
device gets ignored. Blue abandons a field and starts **nothing**; there is no
half-committed alarm.

**Boundaries differ by kind, deliberately, and both ends are audible.**

| Field | Range | At the end | Why |
| --- | --- | --- | --- |
| Timer minutes | 1–180 | **stops** | one extra detent must not turn a 180-minute timer into a 1-minute one; the owner finds out when the thing they were timing burns |
| Alarm hour | 0–23 | **wraps** | a clock is a circle; 23→0 is how time behaves |
| Alarm minute | 0–59 | **wraps** | as above |

Hitting a stop plays a distinct **`edge` earcon** (a muted double-blip at the
same pitch — "nothing changed") and **re-speaks the same number**. A silent
refusal is indistinguishable from a dead knob, and the owner's next move would
be to keep turning into a wall they cannot see.

The alarm hour is **24-hour with no AM/PM field**. A third field on a
screenless spinner is a third thing to get lost inside, and the owner would
have to hold two numbers and a meridiem in their head with nothing to look at.
Scrolling 0–23 says "fourteen" where a 12-hour field would say "two" and leave
them genuinely unsure which two. The *confirmation* converts back to the way
people speak — "Alarm set for 2:30 PM" — so the awkward representation never
survives past the commit.

### Numbers are synthesized locally

A settle that spoke through TTS would put the number a network round trip
behind the thumb, which is what made a spinner impossible before.
`cloud-relay/spokenNumbers.js` renders number words to PCM locally — the same
trick `pendantEarcon.js` already uses for the detent blips — so the settle is
bounded by CPU, not by the internet.

The "exactly one utterance per burst" promise is `cloud-relay/menuSettle.js`,
and it is a **trailing** debounce rather than a throttle on purpose: a throttle
speaks the *first* value of a burst, which on a spinner announces where the
owner started. Only the trailing edge answers the question they asked.
`menuSettle.test.js` drives forty detents through it on a fake clock and asserts
a single spoken number — that test is the feature.

## Audio devices: what you already use, then what is nearby

Ordering is the whole design here. The owner, watching the pendant chase one
speaker: *"shouldn't it discover the bluetooth devices and prioritize those
that were connected before?"* So the ring is, in order:

1. **Remembered sinks**, most-recently-used first. The relay does **not**
   re-sort them — the device knows when it last connected to each and the relay
   does not.
2. **Newly discovered** devices from the live scan, spoken as "*name*. New."
   A discovered device that is also remembered is dropped from this half; the
   same speaker under two labels is the ring admitting it does not know what it
   has.
3. **"Still searching."** — present only while a scan is running.
4. **Pendant speaker** (`audio_sink: speaker`), so audio can never be stranded
   in a pair of earbuds sitting in a drawer.
5. **Back**.

Entering the app fires `{"type":"bt_list"}` and `{"type":"bt_scan"}`
**together**, so the remembered list makes the ring usable in the same instant
it opens while discovery fills in behind it. Two rules keep that safe to scroll
while it changes: the discovered half is appended *after* the remembered half,
and the cursor follows the **entry** it is standing on rather than a numeric
index — otherwise every speaker that answered would slide "Pendant speaker" one
step further from the owner's thumb.

**The honest end-of-list.** An owner who reaches the bottom while results are
still arriving must not conclude the list is complete, so `Still searching.`
sits there and says so. Selecting it is a no-op that repeats the line: it is a
sign, not a door. Scan results otherwise arrive **silently** — announcing every
speaker that answers would talk over the ring the owner is listening to.

**Remembered and new take different frames**, because they are different
questions. A remembered sink is addressed by its **index** in the device's own
table (`bt_select`, which also promotes it to most-recent). A device the scan
just found has no index at all — it exists only as a name in a result the relay
is holding — so it goes by name (`bt_connect`) and the device decides where it
lands in its table. Either way `audio_sink: bluetooth` follows, because
choosing where sound goes and connecting the thing it goes to are one
intention; a sink choice that left the module idle would route the next answer
into silence.

Names are sanitised on the way in (a device advertising a name with a colon in
it must not be able to forge another entry's id) and both halves are capped,
since a ring the owner cannot get to the end of is a trap. An empty remembered
list is no longer a dead end — a scan is running behind it — so it says
"Nothing remembered yet. Still searching." and leaves the ring open for results
to land in.

### Frames the audio ring needs from the nRF

| Direction | Frame | Meaning |
| --- | --- | --- |
| relay → device | `{"type":"bt_list"}` | report the remembered sink table |
| device → relay | `{"type":"bt_devices","devices":[{"name":…}],"connected":bool}` | the table, **in the device's own most-recently-used order** |
| relay → device | `{"type":"bt_scan","action":"start"}` | begin discovery |
| device → relay | `{"type":"bt_scan_result","devices":[{"name":…,"rssi":…}],"done":bool}` | discovery results so far; `done:true` retires the "Still searching." entry. May be sent repeatedly as results accumulate — each frame replaces the discovered half wholesale |
| relay → device | `{"type":"bt_select","index":n}` | connect the remembered sink at index *n*, and promote it |
| relay → device | `{"type":"bt_connect","name":"…"}` | connect a newly discovered device by name |
| relay → device | `{"type":"audio_sink","sink":"speaker"\|"bluetooth"}` | where the next answer goes |

## Where the state lives

**All menu state lives relay-side, inside the converse session.** The pendant
is stateless by design: the firmware's whole contribution is
`{"type":"menu","delta":±1}` per detent, `{"type":"menu_select"}` per yellow
press and `{"type":"menu_back"}` per blue press, on the converse WebSocket (see
`firmware/CONTROLS_WIRING.md` — frames are dropped when the socket is closed, so
a knob twist banked across a dead link can never replay as stale intent). The
relay holds the ring position, the mode, and the numeric field in the
conversation's own state (`cloud-relay/pendantConverse.js` + the pure model in
`cloud-relay/menuRing.js`), which means:

- A menu interaction **exists only while a conversation is open**. Yellow
  press opens it — that is the one press — and every detent after that
  navigates. Detents on an idle socket are logged and ignored, because
  today's firmware plays no audio outside a started conversation and a menu
  you cannot hear is not a menu.
- The conversation ending resets the menu to closed. Next press starts at the
  ring's home position — predictable beats persistent for a ring this short.

Because the ring lives here, **the relay owns the context bit and must push
it** — see the firmware contract above. `endConversation` sends
`{"type":"menu_context","active":false}` unconditionally rather than only when
the ring happened to be open: the cost is one small frame, and the cost of
skipping it is an owner whose next yellow press is a select against a ring that
no longer exists, getting silence from the one control that is supposed to
always work.

`{"type":"menu_back"}` is now **emitted by the blue button**, after a spell as a
frame nothing sent (it was written for a long-hold the encoder could not
support). The `Back` entry at the end of every ring survives alongside it and
lands in exactly the same place (`menuRing.test.js` asserts the two paths are
indistinguishable) — it is the escape a first-time owner can *discover* by
turning the knob, without having been told anything. The ring's wrap-around and
the yellow button (end conversation = close everything) remain escapes too.

## Timers and alarms: what is honestly true in Phase 1

**An alarm is a timer whose duration was computed from a clock face**, and it
rides the same store deliberately. Everything downstream — the rows, the index
and its eviction rules, the expiry sweep, the claim/settle pair that stops two
sockets chiming the same thing twice, the queue that speaks an overdue chime on
the next press — is identical, and re-implementing that machinery for alarms
would have meant two sweeps, two claim protocols and two ways for a chime to go
missing. The *only* thing an alarm adds to a record is what it should say when
it fires: `kind: 'alarm'` and the clock face it was set for ("Alarm. It's 7:30
AM."). Recurrence is deliberately **not** here — "every weekday at seven" is a
routine (`cloud-relay/routines.js`), and a one-shot store with a repeat flag
bolted on is how a device ends up with two schedulers that disagree about
daylight saving.

The alarm's local frame comes from the **pendant's own LTE network clock** when
it has one — the same source the Time app trusts, for the same reason: a worn
device must set 7 AM in the timezone the owner is *standing* in, not the one
their Mac is sleeping in. The Mac's offset is the fallback and UTC is the
fallback's fallback.

The timer is **relay-held**: the expiry lives in the relay's store (same
`getState`/`saveState` rows approvals live in — `cloud-relay/timerStore.js`),
not on the device. Consequences, stated plainly:

- A timer **chimes down an OPEN socket**: the converse session sweeps the
  store every few seconds and speaks the chime — rising three-note earcon,
  then "Your 10 minute timer is done." — into the live conversation.
- If no conversation is open at expiry, the chime **queues and speaks on the
  next press**, exactly like approvals queue: press yellow, and overdue
  chimes speak first (after any approval readback, before stale briefings).
- A timer set by voice ("set a timer for 10 minutes") and a timer set by the
  knob are **one system** — same store, same chime path, same sweep. The
  voice tool (`set_timer` in `cloud-relay/openaiRealtimeVoice.js`) can also
  cancel and report remaining time.
- **The offline story is Phase 2 firmware.** A pendant out of coverage, or
  with the conversation closed, does not beep at expiry — the device has no
  local clock-driven alarm yet. Phase 2 mirrors the expiry down to the
  firmware so the chime is local; the relay store stays the source of truth.

## Reminders and Calendar: the Mac answers

Entering either app enqueues a relay→Mac job on the exact path voice
tool-calls already ride (`enqueueMacPlanJob` → bridge claims → hands-free
execute → result posted back). The relay polls the job result, parses the
AppleScript's stdout and speaks a three-item brief
(`cloud-relay/pendantApps.js`). If the Mac is asleep or slow, the spoken
answer says so — "Your Mac hasn't answered yet" — rather than silence, because
on a screenless device silence is indistinguishable from breakage. An empty
answer and a missing answer are kept apart on purpose: a clear day says
"Nothing on your calendar today", and only a Mac that never replied gets the
sleeping-Mac line.

**Both apps ride `run_applescript` with read-only bodies, and that is a
decision, not a shortcut.** `local-agent/actionRisk.js` classifies
`run_applescript` by what the script *body* does, so both scripts come back
`{safe:true}` at tier `read` and execute hands-free. A purpose-built
`list_reminders` action — or `compose_briefing` — would be *off* the
hands-free allowlist on the day it shipped ("`list_reminders` is not on the
hands-free allowlist"), and every brief would stall behind an approval prompt
on a device with no screen to approve it on. `cloud-relay/pendantApps.test.js`
imports the real risk classifier rather than asserting a belief about it,
because that failure is silent: the brief simply never speaks. A typed
EventKit `list_reminders` is still the better long-term shape — it needs the
allowlist entry to land in the same change.

## Why apps feel like domains

`shared/domains/` already made the domain the unit that bundles a
capability's tools and memories. The app ring is the same idea made audible:
Calendar-the-app fronts the calendar domain's tools (`list_reminders`,
`compose_briefing`, `create_reminder`), and voice parity is a requirement,
not a feature — anything reachable by the knob must be reachable by saying
it, and vice versa. The knob is for when speaking is awkward; speech is for
when the knob's ring would be too long.

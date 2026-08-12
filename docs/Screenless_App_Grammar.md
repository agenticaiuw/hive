# The Screenless App Grammar

How the pendant grows "apps" — Time, Timer, Reminders, Calendar, Audio
devices — without a screen, and how the owner always knows where they are. Phase 1 of the owner's
2026-08-12 ask: *"we need to build more default programs into the firmware for
more simple things like time and also timer, reminder, calendar, etc. kind of
like an ios but remember our i/o with the user has no screen, so a lot of
things will have to be changed to create a seamless and intuitive experience
where the user knows how to operate."*

## The one hard rule

**No flow may require two presses to initiate.** The yellow press that opens
the conversation is the one press. Everything after it is the knob: turn to
scroll, push to enter, long-hold to escape. There is no "press to open the
menu, press again to pick" anywhere in this grammar, and nothing added later
may introduce one.

## The verbs (frozen)

The three buttons keep their global meanings **everywhere, in every app,
forever**. An app that wants to remap them is a design bug:

| Control | Verb | Never changes |
| --- | --- | --- |
| Yellow press | conversation start / stop | the doorbell for everything below |
| Green press | memo capture | record-only, no planner |
| Blue press | **push-to-talk** — record a question radio-off, burst-upload it, hear the answer | works mid-app |
| Encoder turn | scroll the current ring | app ring, or a ring inside an app |
| Encoder push | enter / select what the ring is pointing at | |
| Encoder long-hold | **back / home** — the one universal escape | one level up; from the app ring it closes the menu |

Because the escape is always the same gesture, the owner can never be lost in
a way one long-hold (or two) does not fix. That is the screenless equivalent
of the iPhone's home button, and it is the whole navigation contract.

**Blue was approve/deny in this document's first draft; the owner remapped it
to push-to-talk on 2026-08-12.** The reason is energy, and it is decisive: a
PTT question costs ≈1 mWh against 2.3 mWh for the same question as a duplex
exchange — **2.4× cheaper**, "because the radio never idles connected while
the human talks: capture costs 4.2 mA, not 65 mA"
(`hardware/design/Solar_Feasibility.md` §4.3). At that price an outdoorsy
summer harvest carries 7–12 questions a day instead of one or two, which is
the difference between a solar assistant and a solar ornament. Blue therefore
buys the pendant's most-used verb its cheapest possible form, and it is the
one control the app grammar leans on hardest.

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
   name, not four sentences.

Entering an app **speaks its surface immediately** — there is no silent
landing anywhere:

- **Time** speaks the time and leaves you on the ring (a one-shot surface,
  nothing to be inside of).
- **Timer** speaks the highlighted duration and the one hint that matters:
  "press to start." Turning scrolls the preset ring (1, 5, 10, 15, 30, 60
  minutes); pushing starts that timer and returns you to the app ring.
- **Reminders** and **Calendar** speak a short brief (today's reminders /
  today's schedule) fetched live from the Mac, with honest spoken empties —
  "No open reminders." — and honest spoken failures. You stay on the ring
  while it fetches; the brief lands the moment the Mac answers. Entering says
  "Checking your reminders." first, and that sentence is not filler: the read
  measures **~16 s** on the owner's Mac, and sixteen seconds of silence on a
  screenless device is indistinguishable from a dead knob.
- **Audio devices** asks the pendant what it remembers (`{"type":"bt_list"}`),
  turns the answer into a ring, and connects what you pick. It is the only
  ring in this grammar whose entries the relay does not author — the device
  holds up to four sinks on its SD card — so the names are sanitised on the
  way in. Selecting a headphone sends **both** `bt_select` (promote to
  preferred, tell the module to connect) and `audio_sink: bluetooth`, because
  choosing where sound goes and connecting the thing it goes to are one
  intention; a sink choice that left the module idle would route the next
  answer into silence. The last entry before `Back` is **Pendant speaker**
  (`audio_sink: speaker`), so audio can never be stranded in a pair of earbuds
  sitting in a drawer. An empty list says so — "No remembered audio devices.
  Pair one from your phone first." — rather than opening an empty ring.

Closing the menu (long-hold from the app ring) plays a falling earcon and no
words: silence plus a downward blip is "you are back in the plain
conversation", and adding a sentence there would say nothing the blip does
not.

## Where the state lives

**All menu state lives relay-side, inside the converse session.** The pendant
is stateless by design: the firmware's whole contribution is
`{"type":"menu","delta":±1}` per detent and `{"type":"menu_select"}` per push
on the converse WebSocket (see `firmware/CONTROLS_WIRING.md` — frames are
dropped when the socket is closed, so a knob twist banked across a dead link
can never replay as stale intent). The relay holds the ring position, the
mode, and the timer presets in the conversation's own state
(`cloud-relay/pendantConverse.js` + the pure model in
`cloud-relay/menuRing.js`), which means:

- A menu interaction **exists only while a conversation is open**. Yellow
  press opens it — that is the one press — and every detent after that
  navigates. Detents on an idle socket are logged and ignored, because
  today's firmware plays no audio outside a started conversation and a menu
  you cannot hear is not a menu.
- The conversation ending resets the menu to closed. Next press starts at the
  ring's home position — predictable beats persistent for a ring this short.

The long-hold escape arrives as `{"type":"menu_back"}`. The relay handles it
today; emitting it on encoder long-hold is the firmware half (controls
firmware, Phase 2). **Until it ships, every ring ends in a `Back` entry** —
one detent past the last app, one past the last preset — which selects as the
same escape and lands in exactly the same place (`menuRing.test.js` asserts
the two paths are indistinguishable). The Back entry is not scaffolding to be
deleted when the long-hold arrives: it costs one detent, and it is the only
escape a first-time owner can *discover* by turning the knob. The ring's
wrap-around and the yellow button (end conversation = close everything) remain
escapes too.

## Timers: what is honestly true in Phase 1

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

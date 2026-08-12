# The Screenless App Grammar

How the pendant grows "apps" — Time, Timer, Reminders, Calendar — without a
screen, and how the owner always knows where they are. Phase 1 of the owner's
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
| Blue press / hold | approve / deny the pending approval | works mid-app |
| Encoder turn | scroll the current ring | app ring, or a ring inside an app |
| Encoder push | enter / select what the ring is pointing at | |
| Encoder long-hold | **back / home** — the one universal escape | one level up; from the app ring it closes the menu |

Because the escape is always the same gesture, the owner can never be lost in
a way one long-hold (or two) does not fix. That is the screenless equivalent
of the iPhone's home button, and it is the whole navigation contract.

## How you know where you are (no screen)

Every ring position has two cues, always in the same order:

1. **A position-pitched earcon** — a short blip whose pitch rises as you
   scroll forward through the ring and falls as you scroll back. Pitch alone
   tells your ear "third of four" the way a scrollbar tells your eye. The app
   ring and the rings inside apps use different base pitches, so "which ring
   am I in" is audible before any word is spoken. Spinning the knob fast
   clicks a blip per detent, exactly like a click wheel.
2. **The name, spoken** — "Timer.", "Reminders." — rendered after the knob
   settles (~200 ms), so spinning through four apps costs four blips and one
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
  while it fetches; the brief lands the moment the Mac answers.

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
  ring's home position — predictable beats persistent for a four-item ring.

The long-hold escape arrives as `{"type":"menu_back"}`. The relay handles it
today; emitting it on encoder long-hold is the firmware half (controls
firmware, Phase 2). Until it ships, the ring's wrap-around and the yellow
button (end conversation = close everything) are the escapes.

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
execute → result posted back), with a read-only action: `list_reminders`
(new, reads open reminders via EventKit) or `compose_briefing` kind
`schedule` (existing, today's calendar). The relay polls the job result and
speaks `result.response`. If the Mac is asleep or slow, the spoken answer
says so — "Your Mac hasn't answered yet" — rather than silence, because on a
screenless device silence is indistinguishable from breakage.

## Why apps feel like domains

`shared/domains/` already made the domain the unit that bundles a
capability's tools and memories. The app ring is the same idea made audible:
Calendar-the-app fronts the calendar domain's tools (`list_reminders`,
`compose_briefing`, `create_reminder`), and voice parity is a requirement,
not a feature — anything reachable by the knob must be reachable by saying
it, and vice versa. The knob is for when speaking is awkward; speech is for
when the knob's ring would be too long.

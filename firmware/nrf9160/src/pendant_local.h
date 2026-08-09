#ifndef PENDANT_LOCAL_H_
#define PENDANT_LOCAL_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Local command recognition: the words this pendant answers by itself.
 *
 * WHY THIS EXISTS
 * ---------------
 * There is no always-on listening here and there never will be — the button
 * is still the only thing that starts the microphone, because a worn device
 * that listens continuously spends its battery on the room instead of on its
 * owner.  What this module changes is what happens in the two seconds AFTER
 * the press.
 *
 * Today every press is a cellular event: the WebSocket carries the utterance
 * to the relay, a model reads it, and the answer comes back as streamed
 * audio.  For "set the timer" or "stop" that is a data centre round trip to
 * do something the pendant already knows how to do — the reflex layer has
 * held the countdowns, the daily alarms, the chime, the LED and the motor
 * since it landed, and every one of them runs with the radio off.
 *
 * So: match the first word against a small enrolled vocabulary BEFORE the
 * uplink is allowed to transmit.  A confident match fires the recipe locally
 * and the modem never sends a byte.  Anything else falls through to exactly
 * today's cloud conversation, with the audio that was spoken during the
 * decision already encoded and waiting in the uplink FIFO, so nothing the
 * owner said is lost and the only cost is the decision window itself.
 *
 * The second reason matters more than the battery: with no signal at all,
 * a press plus an enrolled word still works.  That is a capability the
 * device did not have — offline, today, a press can only journal audio to
 * the card and hope the link comes back.
 *
 * WHAT IT CAN AND CANNOT RECOGNIZE
 * --------------------------------
 * This is a speaker-dependent template matcher, not a language model.  It
 * cannot parse "five minutes" — the number is not in it, and pretending
 * otherwise would invent a capability the device does not have.  What it
 * does is map ONE spoken word onto ONE already-installed reflex recipe:
 *
 *     {"id":7,"trigger":{"type":"voice","voice":1},"armed":1,
 *      "action":[{"chime":1},{"haptic":"double"}]}
 *
 * The owner enrolls slot 1 by saying the word once (see ENROLLMENT), and
 * from then on a press plus that word fires recipe 7 with the radio off.
 * The recipe carries the meaning — "300 seconds", "chime twice" — because
 * the recipe is where meaning already lives.  Speaker dependence is not a
 * limitation to apologize for here: templates enrolled from the owner's own
 * voice reject other people's voices for free, which on a device that can
 * arm a timer from across a room is a property worth having.
 *
 * THE PIPELINE (all fixed point, all statically sized)
 * ----------------------------------------------------
 *   frames      256 samples at 15,625 Hz = 16.38 ms, no overlap (61 fps).
 *               Each 512-sample mic stage offers exactly two frames, so the
 *               module hangs off the existing stage cadence and adds no
 *               buffering of its own.
 *   features    12 bands, each the summed power of 3 Goertzel bins placed
 *               on a mel-ish curve from 180 Hz to 5.3 kHz.  Goertzel and not
 *               an FFT because 36 bins cost less than a 256-point transform
 *               and need no twiddle table; log2, then MEAN-REMOVED across
 *               the 12 bands so the match does not depend on how loud or how
 *               close the owner spoke.
 *   endpoint    energy hysteresis over the same frames: open at 2x the
 *               measured floor, close at 1.25x, plus a hangover so a stop
 *               consonant does not cut a word in half.  A segment shorter
 *               than 197 ms or longer than 786 ms is not a command word and
 *               is discarded without ever running the matcher.
 *   match       DTW with a Sakoe-Chiba band against each enrolled template,
 *               L1 distance over the 12 dims, normalized by path length.
 *
 * BIASED TOWARD THE CLOUD, DELIBERATELY
 * -------------------------------------
 * A wrong local match does the wrong thing silently and the owner never
 * finds out why; a missed local match costs exactly what today already
 * costs.  Those are not symmetric, so acceptance needs BOTH a distance
 * under PENDANT_LOCAL_ACCEPT_DIST and a margin of PENDANT_LOCAL_MIN_MARGIN
 * over the runner-up template.  A word that is merely closest does not win;
 * it has to win clearly.  Every threshold here moves in the direction of
 * "ask the cloud".
 *
 * ENROLLMENT lives on the microSD card (/SD:/keywords.bin, one fixed-layout
 * record) so it survives reboot with no network.  It is armed over SWD:
 *
 *     w4 <&pendant_local_enroll> <slot>     next press records slot 1..4
 *     w4 <&pendant_local_forget> <slot>     erase slot (0 = all)
 *
 * RAM: every buffer below is static and the total is stated in the .c file.
 * There is no malloc, no scratch borrowed from the codec, and nothing that
 * grows with what was said.
 */

/* Bands per frame and the longest word the matcher will consider. */
#define PENDANT_LOCAL_BANDS 12U
#define PENDANT_LOCAL_MAX_FRAMES 48U
/* Enrollable command slots.  Four is what fits with margin in the 6,780 B
 * this build has free; see the RAM note in pendant_local.c. */
#define PENDANT_LOCAL_SLOTS 4U

/* What the caller should do next, returned by pendant_local_offer_stage. */
enum pendant_local_verdict {
	/* Still inside the decision window — keep holding the uplink. */
	PENDANT_LOCAL_PENDING = 0,
	/* A template matched clearly.  Fire the recipe, send nothing. */
	PENDANT_LOCAL_MATCH,
	/* Not a command word, or not confident enough.  Open the uplink and
	 * carry on exactly as today. */
	PENDANT_LOCAL_CLOUD,
};

/*
 * Reset for one capture.  Call at the top of a press, before the first
 * stage.  Cheap: it clears counters and the segment cursor, never re-reads
 * the card.
 */
void pendant_local_begin(void);

/*
 * Offer one 512-sample mic stage (the same buffer the encoder is fed, after
 * the DC blocker and gain, so features see exactly what the relay would
 * have heard).  Returns the verdict for the capture so far.
 *
 * Once this returns MATCH or CLOUD it keeps returning it — the decision is
 * latched, so a caller may poll it without racing itself.
 *
 * Runs on the main thread inside the conversation loop.  Measured cost is
 * printed by pendant_local_report(); it must stay well under the 20.48 ms
 * block period or the duplex transfer is at risk.
 */
enum pendant_local_verdict pendant_local_offer_stage(const int16_t *samples,
						     size_t frame_count);

/*
 * The slot that matched (1..PENDANT_LOCAL_SLOTS), or 0 when the verdict is
 * not MATCH.  This is the value a recipe's "voice" field is compared to.
 */
uint8_t pendant_local_matched_slot(void);

/*
 * Load templates from /SD:/keywords.bin.  Call after the card is mounted
 * and before LTE, for the same reason the reflex layer loads there: an
 * offline command path that only exists once the network is up is not an
 * offline command path.  A missing file is not an error — it means no word
 * is enrolled yet and every press goes to the cloud, which is the safe
 * default.
 */
void pendant_local_init(void);

/*
 * True when an SWD-armed enrollment is waiting.  The capture path uses this
 * to route the next press into "record a template" instead of "recognize",
 * and to skip the uplink hold entirely while enrolling.
 */
bool pendant_local_enroll_pending(void);

/*
 * Main thread, idle loop: service the SWD enroll/forget hooks.  Erasures
 * happen here (they only touch the table and the card); an enroll request
 * is merely armed here and consumed by the next press.
 */
void pendant_local_tick(void);

/* One line of counters after a capture: segment length, per-slot distances,
 * the margin, and the measured feature cost in microseconds. */
void pendant_local_report(void);

/* SWD debug hooks (contract above). */
extern volatile uint32_t pendant_local_enroll;
extern volatile uint32_t pendant_local_forget;

/*
 * Acceptance thresholds, writable over SWD so they can be retuned from
 * measured distances without a flash cycle:
 *
 *     w4 <&pendant_local_accept_dist> <n>   absolute distance ceiling
 *     w4 <&pendant_local_min_margin>  <n>   required lead over runner-up
 *
 * Lower accept / higher margin = more presses go to the cloud and fewer
 * recipes fire by mistake.  That is the direction to move when in doubt.
 */
extern volatile uint32_t pendant_local_accept_dist;
extern volatile uint32_t pendant_local_min_margin;

#endif /* PENDANT_LOCAL_H_ */

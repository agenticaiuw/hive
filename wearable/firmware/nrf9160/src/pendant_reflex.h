#ifndef PENDANT_REFLEX_H_
#define PENDANT_REFLEX_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Reflex layer: recipes the pendant runs with the radio OFF.
 *
 * WHY PROGRAMS-AS-DATA AND NOT CODE
 * ---------------------------------
 * Waking the modem costs seconds of latency and the biggest single slug of
 * battery this device spends.  A timer, a daily nudge and a button gesture
 * do not need a data center — they need a clock, an LED, a motor and a
 * speaker path, all of which are on the wearer already.  A recipe is a tiny
 * stored JSON instruction the RELAY (or the owner over SWD) can install
 * once, over the air, and the device then executes forever with zero radio:
 *
 *   {"id":3,
 *    "trigger":{"type":"countdown","seconds":600},   one of three kinds
 *    "armed":1,
 *    "action":[{"led":"burst"},{"haptic":"double"},{"chime":1}]}
 *
 * TRIGGERS
 *   countdown  fires N seconds after ARMING (not after storing).  Arming
 *              happens at runtime: a received recipe with "armed":1 arms on
 *              receipt — that is the "set a timer for ten minutes" special
 *              case — or later via SWD / a re-sent recipe.  Countdown arm
 *              state deliberately does NOT survive reboot: uptime restarts
 *              and a resurrected timer would fire at a lie of a time.
 *   daily      fires at "HH:MM" local time on the modem's NITZ wall clock
 *              (AT+CCLK — the clock keeps ticking with the radio off).
 *   gesture    button 2 double-press inside 600 ms.  Single press stays a
 *              bookmark; the second-press wait is entered ONLY while some
 *              gesture recipe is armed, so the bookmark path pays nothing
 *              when the feature is unused.
 *
 * ACTIONS are a list (≤4) of {led:<pattern>}, {haptic:<pattern>},
 * {chime:<n>} steps executed in order.  Action execution lives in main.c
 * (LED GPIO, DRV2605L, I2S chime) and is handed in as callbacks, so this
 * module owns interpretation only and touches no hardware.
 *
 * BOUNDS (all static, RAM is at 95.9%):
 *   16 recipes, ≤400 B serialized each, ≤4 actions each.  One pending
 *   downlink frame slot.  No malloc, no JSON tree — a bounded matcher over
 *   NUL-terminated buffers, same species as pendant_store's alert reader.
 *
 * PERSISTENCE: /SD:/recipes.json, one canonical recipe object per line,
 * rewritten (tmp + rename) after every accepted downlink recipe.  The same
 * file, hand-written, is the dev channel: it is parsed at boot and again
 * whenever the SWD hook pendant_reflex_reload is poked.
 *
 * THREADING: everything here runs on the MAIN thread's idle loop except
 * pendant_reflex_offer_frame(), which the WS I/O thread calls; the pair
 * shares one single-slot buffer guarded by an atomic flag (true SPSC).
 * Recipes never execute during a conversation or a recording — the idle
 * loop is the only caller of tick(), which is what keeps a chime from ever
 * colliding with live I2S.
 */

/* Action patterns — the vocabulary recipes may name. */
enum reflex_led_pattern {
	REFLEX_LED_SINGLE = 0,
	REFLEX_LED_DOUBLE,
	REFLEX_LED_TRIPLE,
	REFLEX_LED_BURST,
	REFLEX_LED_LONG,
};

/*
 * Hardware executors, provided by main.c at init.  `haptic` returns
 * negative when the motor is absent/failed; the interpreter then degrades
 * that step to the LED pattern of the same name — a recipe never fails
 * over missing hardware.  `chime` returns negative only on I2S faults
 * (logged by the player itself).
 */
struct pendant_reflex_ops {
	void (*led)(uint8_t led_pattern);
	int (*haptic)(uint8_t haptic_pattern);
	int (*chime)(uint8_t chime_index);
};

/*
 * Load recipes.json from the mounted card (missing file = empty table) and
 * register the executors.  Call after the SD mount, before LTE — recipes
 * must come back whether or not this boot ever sees signal.  With
 * CONFIG_PENDANT_REFLEX_SELFTEST and no recipes.json present, installs a
 * RAM-only armed 10 s countdown test recipe (LED burst + haptic double +
 * chime) so a bare card still proves the whole reflex path at boot.
 */
void pendant_reflex_init(const struct pendant_reflex_ops *ops);

/*
 * WS I/O thread: offer one NUL-terminated downlink TEXT frame.  Returns
 * true when the frame's "type" is EXACTLY "recipe" — the frame is then
 * queued for the main thread and MUST NOT fall through to the legacy
 * started/flush/end substring matching (a recipe body may contain any of
 * those words).  False means "not mine": hand it to the existing logic
 * unchanged.  Never blocks, never touches the SD or the parser.
 */
bool pendant_reflex_offer_frame(const char *frame);

/*
 * Main thread, idle loop: parse + store a queued recipe frame, if any.
 * Returns >0 with an ack frame ({"type":"recipe_ack","id":N,"ok":0|1})
 * written to ack_out for the caller to send upstream, 0 when nothing was
 * pending.  Kept off the WS thread because parsing and the SD rewrite do
 * not belong on a 2.5 KB socket stack.
 */
int pendant_reflex_process_pending(char *ack_out, size_t ack_capacity);

/*
 * Main thread, idle loop, ~200 ms cadence: service SWD debug hooks, fire
 * due countdowns and daily alarms.  Rate-limits its own AT+CCLK reads.
 * Callers guarantee no conversation/recording is active.
 */
void pendant_reflex_tick(void);

/* True when some armed recipe wants the button-2 double-press gesture —
 * the idle loop opens the 600 ms second-press window only then. */
bool pendant_reflex_gesture_armed(void);

/* Run every armed gesture recipe's actions (the double-press just fired). */
void pendant_reflex_fire_gesture(void);

/*
 * True when some armed recipe is bound to enrolled keyword `slot`.  The
 * capture path asks this BEFORE it suppresses the uplink: a word that
 * matches a slot no recipe wants is not a local command, and letting it
 * swallow the press would leave the owner talking to nothing.
 */
bool pendant_reflex_voice_armed(uint8_t slot);

/*
 * Run every armed recipe bound to `slot` and return how many fired.  This
 * is the whole offline path: no radio, no relay, no reply audio — the
 * device answers with the chime, the motor and the LED it already has.
 */
unsigned int pendant_reflex_fire_voice(uint8_t slot);

/*
 * SWD debug hooks (same species as pendant_remote_press): plain volatile
 * words a J-Link writes; tick() consumes them on the main thread.
 *   w4 <&pendant_reflex_reload> 1     re-read /SD:/recipes.json
 *   w4 <&pendant_reflex_arm> <id>     arm a recipe (countdown starts NOW)
 *   w4 <&pendant_reflex_disarm> <id>  disarm (persisted for daily/gesture)
 *   w4 <&pendant_reflex_fire> <id>    execute a recipe's actions right now
 */
extern volatile uint32_t pendant_reflex_reload;
extern volatile uint32_t pendant_reflex_arm;
extern volatile uint32_t pendant_reflex_disarm;
extern volatile uint32_t pendant_reflex_fire;

#endif /* PENDANT_REFLEX_H_ */

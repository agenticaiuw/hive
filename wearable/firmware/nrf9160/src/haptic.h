#ifndef HAPTIC_H_
#define HAPTIC_H_

#include <stdbool.h>
#include <stdint.h>

/*
 * DRV2605L haptic driver (LRA, RTP mode) for the reflex layer.
 *
 * Grown out of src/haptic_test.c (the standalone first-motion bench test):
 * same register recipe, same VLV101040A open-loop calibration, but shaped as
 * a module with the one contract the reflex layer needs:
 *
 *   PROBE ONCE, THEN NEVER TOUCH A DEAD BUS AGAIN.
 *
 * The breakout may simply not be attached yet.  haptic_init() probes the
 * DRV2605L exactly once at boot; if the part does not answer, every later
 * haptic_play() returns -ENODEV immediately without a single I2C
 * transaction, so an absent part costs one boot log line and nothing else.
 * The caller degrades the action to an LED pattern — a recipe must never
 * fail over hardware that is not there.
 */

/* Named presets — the only vocabulary recipes and events may use.
 * New names append AFTER the original three: recipe frames and stored
 * recipes.json carry these as indices-by-name, so the old order is wire
 * format. */
enum haptic_pattern {
	HAPTIC_PATTERN_SINGLE = 0, /* one 120 ms buzz          */
	HAPTIC_PATTERN_DOUBLE,     /* two 90 ms buzzes         */
	HAPTIC_PATTERN_LONG,       /* one 400 ms buzz, softer  */
	HAPTIC_PATTERN_TICK,       /* one 25 ms blip, light    */
	HAPTIC_PATTERN_CLICK,      /* one 60 ms click, crisp   */
	HAPTIC_PATTERN_STRONG,     /* one 150 ms hit, full     */
	HAPTIC_PATTERN_COUNT
};

/*
 * Probe and configure the DRV2605L.  Call once at boot, before the first
 * recipe can fire.  Returns 0 when the part answered and is configured,
 * -ENODEV / a bus error when it did not — after which haptic_available()
 * is false forever (no retries; re-probing is a reboot).
 */
int haptic_init(void);

bool haptic_available(void);

/*
 * Play one preset.  Blocking (longest preset ~400 ms) — reflex actions run
 * on the idle loop, never inside an audio path.  Returns -ENODEV when the
 * boot probe failed (caller falls back to LED), -EBUSY when a trigger is
 * mid-pattern, negative bus errors when the part answered at boot but
 * fails now.
 */
int haptic_play(enum haptic_pattern pattern);

/*
 * Fire-and-forget preset for event feedback (button acknowledge, decision
 * sent, readback incoming).  Never blocks the caller: each pattern edge is
 * one 2-byte I2C write run from a delayable work item on the system
 * workqueue, so this is safe from ISRs, the WS I/O thread and the
 * conversation loop — contexts where haptic_play()'s k_msleep would eat
 * the I2S TX runway.  Absent motor or a pattern already playing: silently
 * does nothing (events are feedback, not state — dropping one is fine,
 * queueing one is a lie arriving late).
 */
void haptic_trigger(enum haptic_pattern pattern);

#endif /* HAPTIC_H_ */

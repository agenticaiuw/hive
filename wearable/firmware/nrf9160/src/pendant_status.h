#ifndef PENDANT_STATUS_H_
#define PENDANT_STATUS_H_

#include <stdbool.h>

/*
 * Unified status: the RGB indicator and the haptic motor are ONE feedback
 * system with ONE enum and ONE setter — not two features that happen to fire
 * near each other.
 *
 * WHY THAT IS THE WHOLE POINT OF THIS FILE.  Earlier on 2026-08-12 the owner
 * hit a dashboard bug where a status chip and the sentence explaining it were
 * computed by two separate code paths: the chip said one thing, its own
 * explanation said another, and nothing on screen told the reader which of
 * the two was lying.  Two renderers of one truth will eventually disagree,
 * and when they do the user cannot tell which to believe.  A pendant has
 * exactly the same failure available to it, and worse: a red LED with a
 * silent motor, or a buzz with a dark LED, is a device that contradicts
 * itself on the only two channels it has.  So light and vibration here are
 * two RENDERERS of one truth, never two truths.  pendant_status_set() is the
 * only place either can change; there is no LED call and no haptic call for
 * status anywhere else in the firmware.
 *
 * ---- The model (owner-approved) ----
 *
 *   state          LED                                haptic
 *   idle           off                                --
 *   recording      red solid                          tick on entry AND exit
 *   thinking       amber breathing (~1.5 s)           --
 *   needs approval amber fast blink (~4 Hz)           strong x2
 *   done           green flash (~400 ms), then back   click
 *   failed         red triple-blink, then back        strong, then long
 *   mic muted      blue slow breathing (~3 s)         -- (the existing
 *                                                        muted-press pattern
 *                                                        in main.c stays)
 *
 * PRECEDENCE when several could apply:
 *
 *   muted > needs-approval > recording > thinking > transient > idle
 *
 * Muted outranks everything because it is the one state the firmware cannot
 * argue with: the owner cut the microphone's power with a physical switch.
 * The transients (done/failed) rank BELOW the sticky states deliberately —
 * a success flash must never blank out a live recording indicator.  The
 * transient's HAPTIC still fires: the buzz is the event, the light is the
 * state, and suppressing an event because a state outranks it would be the
 * disagreement this file exists to prevent.
 *
 * ---- Cost discipline ----
 *
 * This build sits at ~97% RAM.  The whole subsystem is one k_work_delayable,
 * one 8-byte PWM sequence buffer (EasyDMA needs it in RAM) and a handful of
 * scalars — under 100 bytes.  No thread, no timer, no framebuffer.  Callers
 * touch an atomic and reschedule the work; every register write happens on
 * the system workqueue, never on the audio path and never in an ISR (the
 * same discipline haptic.c already follows).
 */

/*
 * ONE enum.  IDLE / RECORDING / THINKING / APPROVAL are sticky: the last one
 * set is what the device is.  DONE / FAILED are transients: they play their
 * flash and then the display falls back to whatever sticky state was already
 * true.  MUTED is not settable by callers at all — it is latched from the
 * P0.26 mic-power sense probe registered at init, because the hardware, not
 * the firmware, decides that one.
 */
enum pendant_status {
	PENDANT_STATUS_IDLE = 0,
	PENDANT_STATUS_RECORDING,
	PENDANT_STATUS_THINKING,
	PENDANT_STATUS_APPROVAL,
	PENDANT_STATUS_DONE,
	PENDANT_STATUS_FAILED,
	PENDANT_STATUS_MUTED,
	PENDANT_STATUS_COUNT
};

/*
 * Claim P0.03/P0.04/P0.07 and park the LED dark.  Call once at boot, after
 * haptic_init() so the very first transition can already buzz.
 *
 * mic_muted_probe is polled from the status work item (may be NULL): it is
 * the ONLY way the muted state is entered, and polling it here means the
 * mute indicator is live continuously rather than only at the moment the
 * owner presses a capture button.
 */
void pendant_status_init(bool (*mic_muted_probe)(void));

/*
 * THE setter.  Safe from any context that may schedule work — the WS RX
 * thread on its 2.5 KB stack, the conversation loop between I2S blocks, a
 * GPIO callback: it writes one atomic and reschedules the work item, and
 * does no bus I/O of its own.
 *
 * Setting the state the device is already in is a no-op, so calling this on
 * every pass of a loop is free and entry haptics never repeat.
 */
void pendant_status_set(enum pendant_status state);

/* The sticky state (never DONE/FAILED; MUTED only if the mic is dark). */
enum pendant_status pendant_status_get(void);

#endif /* PENDANT_STATUS_H_ */

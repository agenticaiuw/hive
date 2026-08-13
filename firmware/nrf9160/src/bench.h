#ifndef PENDANT_BENCH_H_
#define PENDANT_BENCH_H_

#include <stdbool.h>
#include <stdint.h>
#include <zephyr/kernel.h>

/*
 * Bench telemetry — every control's live pad level, on the console, as data.
 *
 * WHY THE SHIPPING APP CARRIES THIS AND NOT A SECOND IMAGE
 * --------------------------------------------------------
 * The owner is wiring this pendant by hand and cannot tell a working jumper
 * from a dead one by looking at it. The obvious answer was a separate
 * self-test image, and it was tried: it hard-faulted into lockup before
 * main(). The less obvious answer is better anyway — an instrument that only
 * works on a DIFFERENT firmware cannot answer "is the wire good WHILE the
 * product is running", which is the question that actually matters. So the
 * product emits its own telemetry and the bench watches the product.
 *
 * THE CONTRACT LIVES ON THE MAC, NOT HERE
 * ---------------------------------------
 * software/ai-pendant-simulator/local-agent/benchTelemetry.js is the parser
 * and therefore the specification; this file conforms to it. Two rules from
 * it are load-bearing and are enforced below rather than merely respected:
 *
 *   1. RAW PAD LEVELS ONLY. 1 = HIGH, 0 = LOW, and `pressed` is derived on
 *      the Mac. The buttons are active-low against internal pull-ups, so an
 *      UNWIRED pin also reads HIGH — a firmware that shipped a `pressed`
 *      boolean would erase the one reading that separates "resting" from
 *      "the wire fell off", which is the exact question being asked.
 *
 *   2. ABSENT IS NOT ZERO. Lines are MERGED into a running snapshot on the
 *      Mac, so a key that is missing means "not reported", and the tile ages
 *      out honestly. A control that did not configure at boot therefore has
 *      its key OMITTED, never emitted as 0. A clean-looking zero reads as
 *      "measured and dead" when it means "never sampled", and that mistake
 *      has already cost this project a day.
 *
 * COST WHEN NOBODY IS WATCHING
 * ----------------------------
 * Change-driven with a 5 s heartbeat, floored at one line per 150 ms. A still
 * bench costs one ~180 byte line every five seconds (~1.6 ms of UART) and a
 * handful of register reads per loop turn. There is no thread, no timer and no
 * buffer: the emitter runs on whatever loop already turns.
 */

enum pendant_bench_button {
	PENDANT_BENCH_YELLOW = 0,
	PENDANT_BENCH_GREEN,
	PENDANT_BENCH_BLUE,
	PENDANT_BENCH_BUTTON_COUNT
};

struct pendant_bench_config {
	/*
	 * Absolute P0 pin per control, or -1 when that control did not
	 * configure at boot. -1 omits the key from every line forever (see
	 * rule 2 above). The pin number is also the JSON key: P0.21 -> "p21".
	 */
	int8_t button_pin[PENDANT_BENCH_BUTTON_COUNT];
	/*
	 * The pad level the button's interrupt edge lands on — 0 for the
	 * active-low parts on this board. A press shorter than the emitter's
	 * poll interval is invisible to sampling, so the ISR latches this
	 * level instead of the emitter re-reading a pad the finger already
	 * left. See pendant_bench_note_button().
	 */
	uint8_t button_active_level[PENDANT_BENCH_BUTTON_COUNT];
	int8_t encoder_a_pin;
	int8_t encoder_b_pin;
	int8_t mic_sense_pin;
	int8_t amp_pin;
	/* Reported as "fw". Keep it short; it rides every slow line. */
	const char *firmware;
};

#if IS_ENABLED(CONFIG_PENDANT_BENCH_TELEMETRY)

void pendant_bench_init(const struct pendant_bench_config *config);

/*
 * ISR-safe. Called from the button callback on the active edge; the level is
 * latched, not sampled, so a 60 ms tap survives a 5 Hz emitter.
 */
void pendant_bench_note_button(enum pendant_bench_button which);

/* ISR-safe. One call per decoded detent, +1 clockwise, -1 counter-clockwise. */
void pendant_bench_note_detent(int step);

/* The unfiltered SAADC count, before the volume curve's snap and hysteresis. */
void pendant_bench_note_pot(int raw);

void pendant_bench_note_i2c(bool haptic_answered);
void pendant_bench_note_sd(bool mounted);

/*
 * Sample and, if anything moved (or the heartbeat is due), emit. Cheap enough
 * to call from any loop that turns; internally rate-limited, so calling it
 * more often than it can emit costs a handful of register reads.
 */
void pendant_bench_tick(void);

#else /* !CONFIG_PENDANT_BENCH_TELEMETRY */

static inline void pendant_bench_init(const struct pendant_bench_config *config)
{
	ARG_UNUSED(config);
}

static inline void pendant_bench_note_button(enum pendant_bench_button which)
{
	ARG_UNUSED(which);
}

static inline void pendant_bench_note_detent(int step)
{
	ARG_UNUSED(step);
}

static inline void pendant_bench_note_pot(int raw)
{
	ARG_UNUSED(raw);
}

static inline void pendant_bench_note_i2c(bool haptic_answered)
{
	ARG_UNUSED(haptic_answered);
}

static inline void pendant_bench_note_sd(bool mounted)
{
	ARG_UNUSED(mounted);
}

static inline void pendant_bench_tick(void)
{
}

#endif /* CONFIG_PENDANT_BENCH_TELEMETRY */

#endif /* PENDANT_BENCH_H_ */

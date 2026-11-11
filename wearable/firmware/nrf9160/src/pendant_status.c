/*
 * Unified status subsystem — RGB indicator + haptic motor, one state machine.
 * The contract, the state table and the reason both live on one setter are in
 * pendant_status.h.  This file is the mechanism.
 *
 * PWM0, three channels, raw nrfx HAL.  Not the Zephyr PWM driver: CONFIG_PWM
 * is off in this build and turning it on would pull in a driver, a device
 * instance and a pinctrl state for three pins that never change function.
 * Raw HAL on a devicetree-disabled instance is already this firmware's house
 * pattern — main.c drives PWM1/PWM2 exactly this way for the microphone's
 * BCLK/LRCLK.  PWM1 and PWM2 are the audio clock chain and are untouchable;
 * PWM0 was free (nothing in the build binds it) and is now ours.
 */
#include <stdint.h>

#include <zephyr/devicetree.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

#include <hal/nrf_gpio.h>
#include <hal/nrf_pwm.h>

#include "haptic.h"
#include "pendant_status.h"

/*
 * Pins come from the devicetree so the claim is visible in the overlay next
 * to every other pin claim on this board — DT_GPIO_PIN is a compile-time
 * constant, so this costs nothing at runtime and buys the one thing that
 * matters on a board where pins are the scarce resource: nobody can take
 * P0.03/P0.04/P0.07 without seeing that they are already spoken for.
 */
#define RGB_RED_PIN DT_GPIO_PIN(DT_ALIAS(rgb_red), gpios)
#define RGB_GREEN_PIN DT_GPIO_PIN(DT_ALIAS(rgb_green), gpios)
#define RGB_BLUE_PIN DT_GPIO_PIN(DT_ALIAS(rgb_blue), gpios)

/*
 * 125 kHz / 256 = 488 Hz refresh.  Well above the flicker floor, and slow
 * enough that the peripheral's own current is noise next to the LED's.
 */
#define RGB_COUNTERTOP 256U

/*
 * PER-CHANNEL BRIGHTNESS CEILING — the three constants to turn if a colour
 * reads wrong.  These are a CALIBRATION, not a style choice, and the reason
 * is physics rather than taste.
 *
 * The three dies in a 4-leg RGB part are not the same diode.  Red is GaAsP
 * with a forward voltage near 2.0 V; green and blue are InGaN and sit at
 * 3.0-3.2 V.  This board's I/O rail is 3.0 V, so on an identical 330 ohm
 * leg the red channel gets ~1.0 V of headroom (~3 mA) while green and blue
 * get somewhere between 0.1 V and NOTHING (0-0.3 mA).  Feed all three the
 * same duty and the part is a red LED with two decorative legs: every mix
 * collapses toward red, and "amber" — red plus a splash of green — is
 * indistinguishable from the recording red it is supposed to contrast with.
 *
 * So each channel gets its own ceiling, expressed as a PWM compare value out
 * of RGB_COUNTERTOP.  Red keeps the modest 64/256 = 25 % that made it an
 * indicator instead of a flashlight; green and blue are opened most of the
 * way, because on this rail their duty is the only knob left that costs
 * nothing.  Duty cannot conjure headroom that is not there — see the
 * resistor note below — but it is worth roughly 3.5x on the two channels
 * that need it, and it is what makes the amber mix actually read amber.
 *
 * RETUNING, in the order the knobs matter:
 *   - Green/blue still dark with the routing switches open?  That is the
 *     330 ohm leg, not this file.  100 ohm on the green and blue legs is
 *     the fix (still under 5 mA even if the die turns out to be a cheap
 *     2.6 V green, and far under the pin's 15 mA limit).
 *   - Went to 100 ohm on all three?  Bring RGB_DUTY_CEIL_RED down to ~32 to
 *     keep red from dominating again.  Nothing here can be unsafe: 3.0 V
 *     across 100 ohm with the diode shorted is 30 mA of PEAK current at a
 *     25 % duty, and the diode is never shorted.
 *   - Whole indicator too bright?  Scale all three down together.
 */
#define RGB_DUTY_CEIL_RED 64U
#define RGB_DUTY_CEIL_GREEN 224U
#define RGB_DUTY_CEIL_BLUE 224U

/*
 * ONE bit is the entire common-anode/common-cathode difference.
 *
 * nRF PWM duty words carry polarity in bit 15: SET = the pin is HIGH for
 * `compare` ticks of the period (Zephyr's PWM_POLARITY_NORMAL), CLEAR = the
 * pin is LOW for `compare` ticks.  A common-CATHODE part lights when its
 * colour leg is driven HIGH, a common-ANODE part lights when its leg is
 * pulled LOW — so "invert the duty" is literally "flip bit 15", and a
 * brightness of zero parks the pin at the dark level either way.
 */
#if defined(CONFIG_PENDANT_RGB_COMMON_ANODE)
#define RGB_POLARITY_BIT 0U
#define RGB_DARK_LEVEL 1U /* anode at 3 V: pin HIGH = no current */
#else
#define RGB_POLARITY_BIT BIT(15)
#define RGB_DARK_LEVEL 0U /* cathode at GND: pin LOW = no current */
#endif

/*
 * Animation cadence.  40 ms (25 Hz) while something moves — smooth enough
 * that a 1.5 s breath has 37 steps and nobody sees stairs — and 250 ms when
 * the display is static, purely so the mic-power probe stays live.  Phases
 * are computed from k_uptime_get(), not counted in ticks, so a late work
 * item shifts nothing.
 */
#define STATUS_TICK_ANIMATING_MS 40
#define STATUS_TICK_STATIC_MS 250

#define STATUS_DONE_MS 400
#define STATUS_FAILED_BLINK_MS 120
#define STATUS_FAILED_MS (STATUS_FAILED_BLINK_MS * 6) /* three on/off pairs */

#define STATUS_BREATHE_THINKING_MS 1500
#define STATUS_BREATHE_MUTED_MS 3000
#define STATUS_BLINK_APPROVAL_MS 250 /* 4 Hz */

/*
 * The second half of a two-part buzz.
 *
 * haptic.h's preset names are wire format (stored recipes carry them as
 * indices), so this file spends the EXISTING vocabulary rather than
 * appending to it: "strong x2" is STRONG now and STRONG again 250 ms later,
 * and "strong long" is the 150 ms full-scale hit followed by the 400 ms
 * sustained buzz — a hard edge that then holds, which is what the owner
 * asked a failure to feel like.  One pending slot is enough because the
 * motor itself is one-at-a-time (haptic_trigger drops when busy).
 */
#define STATUS_APPROVAL_GAP_MS 250
#define STATUS_FAILED_GAP_MS 180

/* Colour mix, 0-255 per channel before the duty cap. */
struct status_rgb {
	uint8_t r;
	uint8_t g;
	uint8_t b;
};

/*
 * Amber is red with a splash of green.  These mixes are written in the
 * CALIBRATED space: the per-channel ceilings above already correct for the
 * fact that this rail starves the green and blue dies, so a mix here means
 * the colour a balanced part would show, not a raw duty ratio.  Retune the
 * ceilings, not the mixes — a mix changed to compensate for one channel's
 * weakness silently breaks every other mix that uses that channel.
 */
static const struct status_rgb rgb_red = { 255U, 0U, 0U };
static const struct status_rgb rgb_amber = { 255U, 70U, 0U };
static const struct status_rgb rgb_green = { 0U, 255U, 0U };
static const struct status_rgb rgb_blue = { 0U, 0U, 255U };
static const struct status_rgb rgb_dark = { 0U, 0U, 0U };

/* EasyDMA reads this every period; it must live in RAM, 4-byte aligned.
 * LOAD_INDIVIDUAL consumes all four half-words per period even though the
 * fourth channel has no pin. */
static uint16_t rgb_seq[NRF_PWM_CHANNEL_COUNT] __aligned(4);
static bool rgb_running;

static struct k_work_delayable status_work;
static bool (*status_mic_muted_probe)(void);
/*
 * Set once pendant_status_init() has run.  It exists because the callers
 * that matter most are the EARLIEST ones: main()'s fatal-error path fires
 * before some of the boot has happened, and a pendant_status_set() that
 * reached k_work_reschedule() on an uninitialised work item would turn a
 * reportable boot failure into a kernel assert — losing exactly the signal
 * this module exists to deliver.  Before init the setter is a no-op.
 */
static bool status_ready;

/*
 * Cross-thread request slots, both holding state+1 so that zero can mean
 * "nothing requested" without colliding with PENDANT_STATUS_IDLE == 0 —
 * going idle is a real request and must not be silently swallowed.
 *
 * Last writer wins.  Two states requested before the work item runs means
 * the first was already superseded by the time anyone could have seen it,
 * and showing a state the device has left is the lie this module exists to
 * prevent.
 */
static atomic_t status_req = ATOMIC_INIT(0);
static atomic_t status_event_req = ATOMIC_INIT(0);

static enum pendant_status status_sticky = PENDANT_STATUS_IDLE;
static bool status_muted;
/*
 * Approval is a LATCH, not a sticky value, and that is what makes the
 * precedence table real rather than decorative: it has to outrank a live
 * recording, so it cannot be stored in the same slot the recording uses.
 * The relay says "this needs an answer" while the pendant may already be
 * doing something else, and the amber blink has to survive that.  Cleared
 * by any terminal transition — going idle, succeeding, or failing — because
 * each of those means the question is no longer open.
 */
static bool status_approval;
static enum pendant_status status_transient = PENDANT_STATUS_IDLE;
static int64_t status_transient_started;
static uint8_t status_haptic_pending; /* pattern + 1; 0 = none */
static int64_t status_haptic_due;

/* SWD-visible: what the pendant currently claims to be. */
volatile uint8_t pendant_status_current;

/* ---- PWM plumbing ---- */

/*
 * HIGH DRIVE, and it is not a micro-optimisation on this rail.
 *
 * nrf_gpio_cfg_output() leaves the pad in standard drive (S0S1), which the
 * nRF9160 datasheet specifies at VOH >= VDD - 0.3 V for 0.5 mA of source
 * current — meaning the pad itself eats a few hundred millivolts as soon as
 * an LED asks for real current.  Red does not care: it has a whole volt of
 * headroom.  Green and blue have at most a couple hundred millivolts, so a
 * standard-drive pad can swallow their ENTIRE operating margin and the two
 * channels simply never conduct.  H0H1 is specified to 0.4 V of droop at
 * 5 mA — an order of magnitude more current for the same sag — and buys
 * back the headroom that decides whether those dies light at all.
 *
 * Costs nothing but a slightly faster edge on three pins that switch at
 * 488 Hz, nowhere near anything that would care about the extra di/dt.
 */
static void rgb_pin_cfg_output(uint32_t pin)
{
	nrf_gpio_cfg(pin, NRF_GPIO_PIN_DIR_OUTPUT, NRF_GPIO_PIN_INPUT_DISCONNECT,
		     NRF_GPIO_PIN_NOPULL, NRF_GPIO_PIN_H0H1,
		     NRF_GPIO_PIN_NOSENSE);
}

static void rgb_pins_park(void)
{
	if (RGB_DARK_LEVEL != 0U) {
		nrf_gpio_pin_set(RGB_RED_PIN);
		nrf_gpio_pin_set(RGB_GREEN_PIN);
		nrf_gpio_pin_set(RGB_BLUE_PIN);
	} else {
		nrf_gpio_pin_clear(RGB_RED_PIN);
		nrf_gpio_pin_clear(RGB_GREEN_PIN);
		nrf_gpio_pin_clear(RGB_BLUE_PIN);
	}
}

static void rgb_pwm_start(void)
{
	uint32_t out_pins[NRF_PWM_CHANNEL_COUNT] = {
		RGB_RED_PIN,
		RGB_GREEN_PIN,
		RGB_BLUE_PIN,
		NRF_PWM_PIN_NOT_CONNECTED,
	};

	nrf_pwm_pins_set(NRF_PWM0_NS, out_pins);
	nrf_pwm_configure(NRF_PWM0_NS, NRF_PWM_CLK_125kHz, NRF_PWM_MODE_UP,
			  RGB_COUNTERTOP);
	nrf_pwm_decoder_set(NRF_PWM0_NS, NRF_PWM_LOAD_INDIVIDUAL,
			    NRF_PWM_STEP_AUTO);
	nrf_pwm_seq_ptr_set(NRF_PWM0_NS, 0, rgb_seq);
	nrf_pwm_seq_cnt_set(NRF_PWM0_NS, 0, ARRAY_SIZE(rgb_seq));
	nrf_pwm_seq_refresh_set(NRF_PWM0_NS, 0, 0);
	nrf_pwm_seq_end_delay_set(NRF_PWM0_NS, 0, 0);
	nrf_pwm_loop_set(NRF_PWM0_NS, 1);
	nrf_pwm_shorts_set(NRF_PWM0_NS,
			   NRF_PWM_SHORT_LOOPSDONE_SEQSTART0_MASK);
	nrf_pwm_enable(NRF_PWM0_NS);
	nrf_pwm_task_trigger(NRF_PWM0_NS, NRF_PWM_TASK_SEQSTART0);
	rgb_running = true;
}

static void rgb_pwm_stop(void)
{
	nrf_pwm_shorts_set(NRF_PWM0_NS, 0);
	nrf_pwm_event_clear(NRF_PWM0_NS, NRF_PWM_EVENT_STOPPED);
	nrf_pwm_task_trigger(NRF_PWM0_NS, NRF_PWM_TASK_STOP);
	for (uint32_t wait = 0U; wait < 1000U; ++wait) {
		if (nrf_pwm_event_check(NRF_PWM0_NS, NRF_PWM_EVENT_STOPPED)) {
			break;
		}
		k_busy_wait(1);
	}
	nrf_pwm_disable(NRF_PWM0_NS);
	rgb_running = false;
	/* The PWM leaves the pads wherever the waveform stopped; drive them
	 * dark by hand or the LED keeps whatever colour it died on. */
	rgb_pins_park();
}

/*
 * Park: stop the peripheral outright.  Reserved for a display that is dark
 * AND STAYING DARK — idle is the state this pendant spends its life in, and
 * a PWM looping over EasyDMA forever to emit nothing is exactly the kind of
 * always-on cost a wearable cannot justify.  Deliberately NOT used for the
 * dark half of a blink: stopping costs a busy-wait for the STOPPED event,
 * and paying that four times a second through an approval blink would be
 * worse than the microamps it saves.
 */
static void rgb_park(void)
{
	if (rgb_running) {
		rgb_pwm_stop();
	}
}

/* Push one colour.  Zero is a legitimate colour here (the dark half of a
 * blink) and simply means zero duty on all three channels. */
static void rgb_apply(const struct status_rgb *colour)
{
	rgb_seq[0] = (uint16_t)(((uint32_t)colour->r * RGB_DUTY_CEIL_RED) /
				255U) |
		     RGB_POLARITY_BIT;
	rgb_seq[1] = (uint16_t)(((uint32_t)colour->g * RGB_DUTY_CEIL_GREEN) /
				255U) |
		     RGB_POLARITY_BIT;
	rgb_seq[2] = (uint16_t)(((uint32_t)colour->b * RGB_DUTY_CEIL_BLUE) /
				255U) |
		     RGB_POLARITY_BIT;
	rgb_seq[3] = RGB_POLARITY_BIT;

	if (!rgb_running) {
		rgb_pwm_start();
	}
	/* Already running: the sequence is re-read from RAM every period, so
	 * the new duty lands on the next one (~2 ms). */
}

/* ---- Envelopes ---- */

/* Triangle over `period`, squared so the ramp reads as linear to the eye
 * (perception of brightness is roughly the square root of the drive). */
static uint8_t breathe_level(int64_t now, uint32_t period)
{
	uint32_t phase = (uint32_t)(now % (int64_t)period);
	uint32_t half = period / 2U;
	uint32_t up = (phase < half) ? phase : (period - phase);
	uint32_t level = (up * 255U) / half;

	return (uint8_t)((level * level) >> 8);
}

static struct status_rgb scale(const struct status_rgb *colour, uint8_t level)
{
	struct status_rgb out = {
		(uint8_t)(((uint32_t)colour->r * level) / 255U),
		(uint8_t)(((uint32_t)colour->g * level) / 255U),
		(uint8_t)(((uint32_t)colour->b * level) / 255U),
	};

	return out;
}

/* ---- The state machine ---- */

static bool status_transient_live(int64_t now)
{
	uint32_t window = (status_transient == PENDANT_STATUS_DONE)
				  ? STATUS_DONE_MS
				  : STATUS_FAILED_MS;

	return status_transient != PENDANT_STATUS_IDLE &&
	       (now - status_transient_started) < (int64_t)window;
}

/*
 * The precedence table from pendant_status.h, written out literally so it can
 * be read against the spec line by line:
 *
 *   muted > needs-approval > recording > thinking > transient > idle
 */
static struct status_rgb status_render(int64_t now, bool *animating)
{
	*animating = true;

	if (status_muted) {
		return scale(&rgb_blue,
			     breathe_level(now, STATUS_BREATHE_MUTED_MS));
	}
	if (status_approval) {
		return ((now % STATUS_BLINK_APPROVAL_MS) <
			(STATUS_BLINK_APPROVAL_MS / 2))
			       ? rgb_amber
			       : rgb_dark;
	}
	if (status_sticky == PENDANT_STATUS_RECORDING) {
		*animating = false;
		return rgb_red;
	}
	if (status_sticky == PENDANT_STATUS_THINKING) {
		return scale(&rgb_amber,
			     breathe_level(now, STATUS_BREATHE_THINKING_MS));
	}
	if (status_transient_live(now)) {
		if (status_transient == PENDANT_STATUS_DONE) {
			return rgb_green;
		}
		/* Three blinks: on for the even 120 ms slots. */
		return ((((now - status_transient_started) /
			  STATUS_FAILED_BLINK_MS) &
			 1) == 0)
			       ? rgb_red
			       : rgb_dark;
	}

	*animating = false;
	return rgb_dark;
}

/*
 * One STICKY transition, both channels.  Nothing else in the firmware may
 * fire a status haptic, and nothing else may touch the RGB pins.
 *
 * The approval latch is NOT routed through here, and that distinction is
 * load-bearing: an approval arriving mid-recording does not end the
 * recording, so it must not fire the recording's exit tick.  Its own buzz
 * lives in status_approval_enter().
 */
static void status_sticky_enter(enum pendant_status from,
				enum pendant_status to)
{
	/* Leaving a recording is an event in its own right: the owner needs to
	 * feel that the microphone closed even when their eyes are elsewhere,
	 * which is the whole reason the pendant has a motor. */
	if (from == PENDANT_STATUS_RECORDING) {
		haptic_trigger(HAPTIC_PATTERN_TICK);
	}
	if (to == PENDANT_STATUS_RECORDING) {
		haptic_trigger(HAPTIC_PATTERN_TICK);
	}
	/* idle, thinking: the light says it; a buzz would be noise. */
}

static void status_approval_enter(void)
{
	haptic_trigger(HAPTIC_PATTERN_STRONG);
	status_haptic_pending = (uint8_t)HAPTIC_PATTERN_STRONG + 1U;
	status_haptic_due = k_uptime_get() + STATUS_APPROVAL_GAP_MS;
}

static void status_event(enum pendant_status event)
{
	status_transient = event;
	status_transient_started = k_uptime_get();
	/* Succeeded or failed, the open question is answered either way. */
	status_approval = false;

	if (event == PENDANT_STATUS_DONE) {
		haptic_trigger(HAPTIC_PATTERN_CLICK);
		return;
	}
	haptic_trigger(HAPTIC_PATTERN_STRONG);
	status_haptic_pending = (uint8_t)HAPTIC_PATTERN_LONG + 1U;
	status_haptic_due = status_transient_started + STATUS_FAILED_GAP_MS;
}

static void status_tick(struct k_work *work)
{
	int64_t now = k_uptime_get();
	atomic_val_t req;
	bool animating;
	struct status_rgb colour;

	ARG_UNUSED(work);

	req = atomic_set(&status_req, 0);
	if (req != 0) {
		enum pendant_status next = (enum pendant_status)(req - 1);

		if (next == PENDANT_STATUS_APPROVAL) {
			if (!status_approval) {
				status_approval = true;
				status_approval_enter();
				printk("STATUS approval pending\n");
			}
		} else if (next != status_sticky) {
			enum pendant_status previous = status_sticky;

			status_sticky = next;
			if (next == PENDANT_STATUS_IDLE) {
				status_approval = false;
			}
			status_sticky_enter(previous, next);
			printk("STATUS %u -> %u\n", (unsigned int)previous,
			       (unsigned int)next);
		}
	}

	req = atomic_set(&status_event_req, 0);
	if (req != 0) {
		status_event((enum pendant_status)(req - 1));
	}

	if (status_mic_muted_probe != NULL) {
		bool muted = status_mic_muted_probe();

		if (muted != status_muted) {
			status_muted = muted;
			printk("STATUS mic %s\n", muted ? "MUTED" : "live");
		}
	}

	if (status_haptic_pending != 0U && now >= status_haptic_due) {
		haptic_trigger((enum haptic_pattern)(status_haptic_pending -
						     1U));
		status_haptic_pending = 0U;
	}

	if (status_transient != PENDANT_STATUS_IDLE &&
	    !status_transient_live(now)) {
		status_transient = PENDANT_STATUS_IDLE;
	}

	colour = status_render(now, &animating);
	if (!animating && colour.r == 0U && colour.g == 0U && colour.b == 0U) {
		rgb_park();
	} else {
		rgb_apply(&colour);
	}

	pendant_status_current = (uint8_t)pendant_status_get();

	(void)k_work_reschedule(
		&status_work,
		K_MSEC((animating || status_haptic_pending != 0U)
			       ? STATUS_TICK_ANIMATING_MS
			       : STATUS_TICK_STATIC_MS));
}

/* ---- API ---- */

void pendant_status_init(bool (*mic_muted_probe)(void))
{
	status_mic_muted_probe = mic_muted_probe;

	/* Dark BEFORE the pads become outputs, so boot never flashes a
	 * colour the device does not mean. */
	rgb_pins_park();
	rgb_pin_cfg_output(RGB_RED_PIN);
	rgb_pin_cfg_output(RGB_GREEN_PIN);
	rgb_pin_cfg_output(RGB_BLUE_PIN);
	rgb_pins_park();

	k_work_init_delayable(&status_work, status_tick);
	status_ready = true;
	(void)k_work_reschedule(&status_work, K_NO_WAIT);
	printk("Status LED ready: R=P0.%02u G=P0.%02u B=P0.%02u (%s)\n",
	       RGB_RED_PIN, RGB_GREEN_PIN, RGB_BLUE_PIN,
	       IS_ENABLED(CONFIG_PENDANT_RGB_COMMON_ANODE) ? "common-anode"
							   : "common-cathode");
}

void pendant_status_set(enum pendant_status state)
{
	if (!status_ready) {
		return;
	}

	switch (state) {
	case PENDANT_STATUS_DONE:
	case PENDANT_STATUS_FAILED:
		atomic_set(&status_event_req, (atomic_val_t)state + 1);
		break;
	case PENDANT_STATUS_MUTED:
	case PENDANT_STATUS_COUNT:
		/* Muted is the hardware's to declare, not a caller's. */
		return;
	default:
		if (state == status_sticky && !status_approval &&
		    atomic_get(&status_req) == 0) {
			return; /* already there: no work, no repeated buzz */
		}
		atomic_set(&status_req, (atomic_val_t)state + 1);
		break;
	}
	(void)k_work_reschedule(&status_work, K_NO_WAIT);
}

enum pendant_status pendant_status_get(void)
{
	if (status_muted) {
		return PENDANT_STATUS_MUTED;
	}
	if (status_approval) {
		return PENDANT_STATUS_APPROVAL;
	}
	return status_sticky;
}

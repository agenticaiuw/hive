/*
 * DRV2605L haptic driver — probe-once contract in haptic.h.
 *
 * Register recipe and the VLV101040A open-loop numbers are carried over
 * verbatim from the retired standalone bench test (src/haptic_test.c): that
 * file proved first motion on this exact breakout, so its calibration is
 * the calibration.
 */
#include <errno.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

#include "haptic.h"

#define DRV2605L_ADDRESS 0x5A
#define DRV2605L_REG_STATUS 0x00
#define DRV2605L_REG_MODE 0x01
#define DRV2605L_REG_RTP_INPUT 0x02
#define DRV2605L_REG_OD_CLAMP 0x17
#define DRV2605L_REG_FEEDBACK_CONTROL 0x1A
#define DRV2605L_REG_CONTROL3 0x1D
#define DRV2605L_REG_OL_LRA_PERIOD 0x20

#define DRV2605L_MODE_STANDBY BIT(6)
#define DRV2605L_MODE_RESET BIT(7)
#define DRV2605L_MODE_RTP 0x05
#define DRV2605L_N_ERM_LRA BIT(7)
#define DRV2605L_DATA_FORMAT_RTP BIT(3)
#define DRV2605L_LRA_OPEN_LOOP BIT(0)

/*
 * VLV101040A calibration (measured in the bench test, kept exactly):
 *
 * 0x3C gives 169.27 Hz:
 *   f = 1 / (OL_LRA_PERIOD * 98.46 us)
 *
 * 0x7E caps a full-scale open-loop pulse at about 2.50 Vrms:
 *   Vrms = 21.32 mV * OD_CLAMP * sqrt(1 - f * 800 us)
 *
 * This matches, but does not exceed, the actuator's 2.5 Vrms rating, so no
 * RTP amplitude below can overdrive the motor.
 */
#define HAPTIC_OL_LRA_PERIOD 0x3C
#define HAPTIC_OD_CLAMP 0x7E

/*
 * One preset = up to two RTP pulses.  Amplitudes are signed-RTP full-scale
 * fractions (0x7F = the 2.5 Vrms clamp): crisp presets run near full drive,
 * the long buzz backs off so 400 ms of continuous drive stays comfortable.
 */
struct haptic_step {
	uint8_t amplitude;
	uint16_t on_ms;
	uint16_t off_ms;
};

static const struct haptic_step haptic_presets[HAPTIC_PATTERN_COUNT][2] = {
	[HAPTIC_PATTERN_SINGLE] = { { 0x70, 120U, 0U }, { 0U, 0U, 0U } },
	[HAPTIC_PATTERN_DOUBLE] = { { 0x70, 90U, 70U }, { 0x70, 90U, 0U } },
	[HAPTIC_PATTERN_LONG] = { { 0x50, 400U, 0U }, { 0U, 0U, 0U } },
	[HAPTIC_PATTERN_TICK] = { { 0x58, 25U, 0U }, { 0U, 0U, 0U } },
	[HAPTIC_PATTERN_CLICK] = { { 0x74, 60U, 0U }, { 0U, 0U, 0U } },
	[HAPTIC_PATTERN_STRONG] = { { 0x7E, 150U, 0U }, { 0U, 0U, 0U } },
};

/* SWD-visible probe outcome: 1 = attached+configured, 0 = absent/failed. */
volatile uint32_t haptic_probe_ok;
volatile int haptic_probe_error = -9999;
volatile uint8_t haptic_probe_status = 0xFF;

#if DT_NODE_HAS_STATUS(DT_NODELABEL(i2c2), okay)

static const struct device *const haptic_i2c =
	DEVICE_DT_GET(DT_NODELABEL(i2c2));
static bool haptic_ready;

static int drv2605l_update_reg(uint8_t reg, uint8_t mask, uint8_t value)
{
	uint8_t current;
	int error;

	error = i2c_reg_read_byte(haptic_i2c, DRV2605L_ADDRESS, reg, &current);
	if (error != 0) {
		return error;
	}

	current = (current & ~mask) | (value & mask);
	return i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS, reg, current);
}

static int drv2605l_reset(void)
{
	uint8_t mode;
	int error;

	error = i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_MODE, 0);
	if (error != 0) {
		return error;
	}

	k_usleep(250);

	error = i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_MODE, DRV2605L_MODE_RESET);
	if (error != 0) {
		return error;
	}

	for (int attempt = 0; attempt < 50; ++attempt) {
		k_msleep(1);
		error = i2c_reg_read_byte(haptic_i2c, DRV2605L_ADDRESS,
					  DRV2605L_REG_MODE, &mode);
		if (error == 0 && (mode & DRV2605L_MODE_RESET) == 0) {
			return i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
						  DRV2605L_REG_MODE, 0);
		}
	}

	return -ETIMEDOUT;
}

static void drv2605l_stop(void)
{
	(void)i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				 DRV2605L_REG_RTP_INPUT, 0);
	(void)i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				 DRV2605L_REG_MODE, DRV2605L_MODE_STANDBY);
}

/*
 * One pattern owns the motor at a time, whether it came from the blocking
 * reflex path or the async event path.  Overlap resolution is DROP, never
 * queue: haptic feedback describes "now", and a click delivered after the
 * next event is worse than no click.
 */
static atomic_t haptic_owned;

/*
 * Async event engine.  The state machine advances one pattern edge per
 * work invocation — start driving, stop driving, next step — so the only
 * work each invocation does on the system workqueue is a single 2-byte
 * 100 kHz I2C write (~0.3 ms); the waits between edges are k_work
 * reschedules, not sleeps.  Total extra RAM: this struct + the atomic.
 */
static struct {
	struct k_work_delayable work;
	uint8_t pattern;
	uint8_t step;
	bool driving;
} haptic_async;

static void haptic_async_advance(struct k_work *work)
{
	const struct haptic_step *pulse =
		&haptic_presets[haptic_async.pattern][haptic_async.step];

	ARG_UNUSED(work);

	if (!haptic_async.driving) {
		if (haptic_async.step == 0U &&
		    i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				       DRV2605L_REG_MODE,
				       DRV2605L_MODE_RTP) != 0) {
			goto park;
		}
		if (i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				       DRV2605L_REG_RTP_INPUT,
				       pulse->amplitude) != 0) {
			goto park;
		}
		haptic_async.driving = true;
		(void)k_work_schedule(&haptic_async.work,
				      K_MSEC(pulse->on_ms));
		return;
	}

	(void)i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				 DRV2605L_REG_RTP_INPUT, 0);
	haptic_async.driving = false;
	if (pulse->off_ms > 0U &&
	    haptic_async.step + 1U <
		    ARRAY_SIZE(haptic_presets[haptic_async.pattern]) &&
	    haptic_presets[haptic_async.pattern][haptic_async.step + 1U]
			    .on_ms > 0U) {
		++haptic_async.step;
		(void)k_work_schedule(&haptic_async.work,
				      K_MSEC(pulse->off_ms));
		return;
	}

park:
	/* Always park the driver, even after a mid-pattern bus error. */
	drv2605l_stop();
	atomic_set(&haptic_owned, 0);
}

void haptic_trigger(enum haptic_pattern pattern)
{
	if (!haptic_ready || pattern >= HAPTIC_PATTERN_COUNT) {
		return;
	}
	if (!atomic_cas(&haptic_owned, 0, 1)) {
		return; /* motor busy: drop, never queue */
	}
	haptic_async.pattern = (uint8_t)pattern;
	haptic_async.step = 0U;
	haptic_async.driving = false;
	(void)k_work_schedule(&haptic_async.work, K_NO_WAIT);
}

static int haptic_probe_and_configure(void)
{
	uint8_t status;
	int error;

	if (!device_is_ready(haptic_i2c)) {
		return -ENODEV;
	}

	/*
	 * The identity read is the whole probe: with the breakout absent the
	 * address never ACKs and this returns a bus error in microseconds.
	 * Nothing below runs against an empty bus.
	 */
	error = i2c_reg_read_byte(haptic_i2c, DRV2605L_ADDRESS,
				  DRV2605L_REG_STATUS, &status);
	if (error != 0) {
		return error;
	}
	haptic_probe_status = status;

	/* DEVICE_ID[2:0] = 111 identifies the DRV2605L. */
	if ((status & 0xE0) != 0xE0) {
		return -ENODEV;
	}

	error = drv2605l_reset();
	if (error != 0) {
		return error;
	}

	error = drv2605l_update_reg(DRV2605L_REG_FEEDBACK_CONTROL,
				    DRV2605L_N_ERM_LRA, DRV2605L_N_ERM_LRA);
	if (error != 0) {
		return error;
	}

	/*
	 * Fixed-frequency LRA open-loop operation with signed RTP data:
	 * 0x00 is idle and 0x7F full positive amplitude, so the preset table
	 * above reads directly as drive strength.
	 */
	error = drv2605l_update_reg(DRV2605L_REG_CONTROL3,
				    DRV2605L_LRA_OPEN_LOOP |
					    DRV2605L_DATA_FORMAT_RTP,
				    DRV2605L_LRA_OPEN_LOOP);
	if (error != 0) {
		return error;
	}

	error = i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_OD_CLAMP, HAPTIC_OD_CLAMP);
	if (error != 0) {
		return error;
	}

	error = i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_OL_LRA_PERIOD,
				   HAPTIC_OL_LRA_PERIOD);
	if (error != 0) {
		return error;
	}

	/* Configured; park in standby until a recipe wants motion. */
	drv2605l_stop();
	return 0;
}

int haptic_init(void)
{
	int error = haptic_probe_and_configure();

	k_work_init_delayable(&haptic_async.work, haptic_async_advance);
	haptic_probe_error = error;
	haptic_probe_ok = error == 0 ? 1U : 0U;
	haptic_ready = error == 0;
	if (error == 0) {
		printk("Haptic: DRV2605L attached (status=0x%02x) — LRA "
		       "open-loop RTP ready\n",
		       haptic_probe_status);
	} else {
		/* The one and only log for an absent part. */
		printk("Haptic: DRV2605L not answering (%d) — haptic actions "
		       "degrade to LED patterns\n",
		       error);
	}
	return error;
}

bool haptic_available(void)
{
	return haptic_ready;
}

int haptic_play(enum haptic_pattern pattern)
{
	int error;

	if (!haptic_ready) {
		return -ENODEV;
	}
	if (pattern >= HAPTIC_PATTERN_COUNT) {
		return -EINVAL;
	}
	if (!atomic_cas(&haptic_owned, 0, 1)) {
		/* An async event pattern is mid-flight; the caller's LED
		 * fallback answers instead. */
		return -EBUSY;
	}

	error = i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_MODE, DRV2605L_MODE_RTP);
	if (error != 0) {
		atomic_set(&haptic_owned, 0);
		return error;
	}
	/* Standby-to-active wake is sub-millisecond; 2 ms is generous. */
	k_msleep(2);

	for (size_t step = 0U; step < ARRAY_SIZE(haptic_presets[pattern]);
	     ++step) {
		const struct haptic_step *pulse =
			&haptic_presets[pattern][step];

		if (pulse->on_ms == 0U) {
			break;
		}
		error = i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
					   DRV2605L_REG_RTP_INPUT,
					   pulse->amplitude);
		if (error != 0) {
			break;
		}
		k_msleep(pulse->on_ms);
		error = i2c_reg_write_byte(haptic_i2c, DRV2605L_ADDRESS,
					   DRV2605L_REG_RTP_INPUT, 0);
		if (error != 0) {
			break;
		}
		if (pulse->off_ms > 0U) {
			k_msleep(pulse->off_ms);
		}
	}

	/* Always park the driver, even after a mid-pattern bus error. */
	drv2605l_stop();
	atomic_set(&haptic_owned, 0);
	return error;
}

#else /* !DT_NODE_HAS_STATUS(i2c2, okay) */

/*
 * i2c2 disabled in the devicetree: compile the module to its degraded shape
 * so a board without the bus still boots and recipes still run on LED.
 */
int haptic_init(void)
{
	haptic_probe_error = -ENODEV;
	haptic_probe_ok = 0U;
	printk("Haptic: i2c2 disabled in devicetree — haptic actions degrade "
	       "to LED patterns\n");
	return -ENODEV;
}

bool haptic_available(void)
{
	return false;
}

int haptic_play(enum haptic_pattern pattern)
{
	ARG_UNUSED(pattern);
	return -ENODEV;
}

void haptic_trigger(enum haptic_pattern pattern)
{
	ARG_UNUSED(pattern);
}

#endif /* DT_NODE_HAS_STATUS(i2c2, okay) */

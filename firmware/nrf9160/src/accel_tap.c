/*
 * LSM6DSOX double-tap wake — contract in accel_tap.h.
 *
 * Raw register writes over i2c2, no Zephyr sensor driver: the sensor
 * subsystem plus the lsm6dso driver would cost kilobytes of flash and RAM
 * for what is nine register writes at boot and one GPIO edge afterwards,
 * on a build with ~8 kB of RAM left.
 */
#include <errno.h>
#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>

#include "accel_tap.h"

/*
 * ---- LSM6DSO/LSM6DSOX register block (datasheet DS12140 section 9) ----
 * Everything device-specific lives between these fences; porting to a
 * different ST accelerometer means rewriting only this block.
 */
#define ACCEL_ADDR_PRIMARY 0x6A   /* Adafruit LSM6DSOX breakout default  */
#define ACCEL_ADDR_SECONDARY 0x6B /* same board with the DO jumper high  */

#define ACCEL_REG_WHO_AM_I 0x0F
#define ACCEL_WHO_AM_I_VALUE 0x6C /* LSM6DSO and LSM6DSOX both read 6Ch  */

#define ACCEL_REG_CTRL1_XL 0x10
#define ACCEL_REG_CTRL6_C 0x15
#define ACCEL_REG_CTRL9_XL 0x18
#define ACCEL_REG_TAP_CFG0 0x56
#define ACCEL_REG_TAP_CFG1 0x57
#define ACCEL_REG_TAP_CFG2 0x58
#define ACCEL_REG_TAP_THS_6D 0x59
#define ACCEL_REG_INT_DUR2 0x5A
#define ACCEL_REG_WAKE_UP_THS 0x5B
#define ACCEL_REG_MD1_CFG 0x5E

/*
 * ODR 104 Hz (ODR_XL=0100), FS +/-2 g, low-power mode via XL_HM_MODE=1:
 * ~26 uA continuous, the whole point of doing this in the sensor instead
 * of streaming.  NOTE the trade the budget buys: ST's AN5192 recommends
 * >=416 Hz ODR for crisp tap timing — at 104 Hz the shock/quiet windows
 * quantize to 9.6 ms samples and soft fingernail taps can slip through.
 * If real taps under-trigger, ACCEL_CTRL1_XL_VALUE 0x60 (416 Hz, ~85 uA)
 * is the one-line fix.
 */
#define ACCEL_CTRL1_XL_VALUE 0x40 /* 104 Hz, +/-2 g                      */
#define ACCEL_CTRL6_C_VALUE 0x10  /* XL_HM_MODE=1: low-power at this ODR */
#define ACCEL_CTRL9_XL_VALUE 0xE2 /* DEN defaults (0xE0) + I3C_disable,
				   * per DS12140 Table 67 footnote        */
/* Tap detection on X+Y+Z, LIR=0: INT1 pulses, nothing to clear over I2C
 * afterwards — the hot path is purely the GPIO edge. */
#define ACCEL_TAP_CFG0_VALUE 0x0E
/*
 * Threshold 1 LSB = FS/32 = 62.5 mg at +/-2 g; 12 LSB = 750 mg on every
 * axis. TAP_CFG2 also carries INTERRUPTS_ENABLE (bit 7).
 */
#define ACCEL_TAP_THS 0x0C
#define ACCEL_TAP_CFG1_VALUE ACCEL_TAP_THS
#define ACCEL_TAP_CFG2_VALUE (0x80 | ACCEL_TAP_THS)
#define ACCEL_TAP_THS_6D_VALUE ACCEL_TAP_THS
/*
 * INT_DUR2 = DUR[7:4] | QUIET[3:2] | SHOCK[1:0], all in ODR periods
 * (DS12140 Table 128): SHOCK=0 -> 4/ODR = 38 ms max over-threshold,
 * QUIET=1 -> 4/ODR = 38 ms settle, DUR=2 -> 2*32/ODR = 615 ms max gap
 * between the two taps of a double.
 */
#define ACCEL_INT_DUR2_VALUE 0x24
/* SINGLE_DOUBLE_TAP=1: double-tap recognition enabled (wake threshold
 * bits stay 0 — the wake-up function is not enabled anywhere). */
#define ACCEL_WAKE_UP_THS_VALUE 0x80
/* Route ONLY double-tap to INT1 (bit 3). Single tap: not routed = off. */
#define ACCEL_MD1_CFG_VALUE 0x08
/* ---- end register block ---- */

/* SWD-visible probe outcome, same shape as haptic.c's hooks. */
volatile uint32_t accel_probe_ok;
volatile int accel_probe_error = -9999;
volatile uint8_t accel_probe_addr;

#if DT_NODE_HAS_STATUS(DT_NODELABEL(i2c2), okay) && \
	DT_NODE_EXISTS(DT_ALIAS(accel_int1))

static const struct device *const accel_i2c =
	DEVICE_DT_GET(DT_NODELABEL(i2c2));
static const struct gpio_dt_spec accel_int1 =
	GPIO_DT_SPEC_GET(DT_ALIAS(accel_int1), gpios);
static struct gpio_callback accel_int1_callback;
static void (*accel_tap_cb)(void);
static bool accel_ready;
static uint8_t accel_addr;

static void accel_int1_isr(const struct device *port,
			   struct gpio_callback *callback,
			   gpio_port_pins_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(callback);
	ARG_UNUSED(pins);
	/*
	 * Only the double-tap event is routed to INT1, so the edge IS the
	 * event — no I2C in interrupt context, no source register to read.
	 */
	if (accel_tap_cb != NULL) {
		accel_tap_cb();
	}
}

static int accel_probe_addr_once(uint8_t addr)
{
	uint8_t who = 0U;
	int error = i2c_reg_read_byte(accel_i2c, addr, ACCEL_REG_WHO_AM_I,
				      &who);

	if (error != 0) {
		return error;
	}
	return who == ACCEL_WHO_AM_I_VALUE ? 0 : -ENODEV;
}

static int accel_configure(void)
{
	/* CTRL1_XL is written LAST: the accelerometer leaves power-down
	 * only after every tap parameter is already in place, so there is
	 * no window where a half-configured sensor can fire INT1. */
	static const uint8_t recipe[][2] = {
		{ ACCEL_REG_CTRL9_XL, ACCEL_CTRL9_XL_VALUE },
		{ ACCEL_REG_CTRL6_C, ACCEL_CTRL6_C_VALUE },
		{ ACCEL_REG_TAP_CFG0, ACCEL_TAP_CFG0_VALUE },
		{ ACCEL_REG_TAP_CFG1, ACCEL_TAP_CFG1_VALUE },
		{ ACCEL_REG_TAP_CFG2, ACCEL_TAP_CFG2_VALUE },
		{ ACCEL_REG_TAP_THS_6D, ACCEL_TAP_THS_6D_VALUE },
		{ ACCEL_REG_INT_DUR2, ACCEL_INT_DUR2_VALUE },
		{ ACCEL_REG_WAKE_UP_THS, ACCEL_WAKE_UP_THS_VALUE },
		{ ACCEL_REG_MD1_CFG, ACCEL_MD1_CFG_VALUE },
		{ ACCEL_REG_CTRL1_XL, ACCEL_CTRL1_XL_VALUE },
	};

	for (size_t i = 0U; i < ARRAY_SIZE(recipe); ++i) {
		int error = i2c_reg_write_byte(accel_i2c, accel_addr,
					       recipe[i][0], recipe[i][1]);

		if (error != 0) {
			return error;
		}
	}
	return 0;
}

int accel_tap_init(void (*double_tap_isr_cb)(void))
{
	int error;

	accel_tap_cb = double_tap_isr_cb;

	if (!device_is_ready(accel_i2c)) {
		error = -ENODEV;
		goto out;
	}

	/* One probe per address; absent breakout NAKs in microseconds. */
	accel_addr = ACCEL_ADDR_PRIMARY;
	error = accel_probe_addr_once(accel_addr);
	if (error != 0) {
		accel_addr = ACCEL_ADDR_SECONDARY;
		error = accel_probe_addr_once(accel_addr);
	}
	if (error != 0) {
		goto out;
	}
	accel_probe_addr = accel_addr;

	error = accel_configure();
	if (error != 0) {
		goto out;
	}

	/* INT1 is push-pull active-high from the sensor; the pin's DT
	 * pull-down only defines "no tap" when the jumper falls out.  The
	 * edge rides the PORT SENSE mechanism (sense-edge-mask bit 27), so
	 * this costs no GPIOTE channel — same budget rule as the buttons. */
	if (!gpio_is_ready_dt(&accel_int1) ||
	    gpio_pin_configure_dt(&accel_int1, GPIO_INPUT) != 0) {
		error = -EIO;
		goto out;
	}
	gpio_init_callback(&accel_int1_callback, accel_int1_isr,
			   BIT(accel_int1.pin));
	if (gpio_add_callback(accel_int1.port, &accel_int1_callback) != 0 ||
	    gpio_pin_interrupt_configure_dt(&accel_int1,
					    GPIO_INT_EDGE_TO_ACTIVE) != 0) {
		error = -EIO;
		goto out;
	}

	accel_ready = true;

out:
	accel_probe_error = error;
	accel_probe_ok = error == 0 ? 1U : 0U;
	if (error == 0) {
		printk("Accel: LSM6DSOX at 0x%02x — double-tap = talk "
		       "button (104 Hz, INT1 on P0.27)\n",
		       accel_addr);
	} else {
		/* The one and only log for an absent part. */
		printk("Accel: LSM6DSOX not answering (%d) — double-tap "
		       "wake off, buttons unaffected\n",
		       error);
	}
	return error;
}

bool accel_tap_available(void)
{
	return accel_ready;
}

#else /* !i2c2 || no accel-int1 alias */

int accel_tap_init(void (*double_tap_isr_cb)(void))
{
	ARG_UNUSED(double_tap_isr_cb);
	accel_probe_error = -ENODEV;
	accel_probe_ok = 0U;
	printk("Accel: i2c2/INT1 absent from devicetree — double-tap wake "
	       "off\n");
	return -ENODEV;
}

bool accel_tap_available(void)
{
	return false;
}

#endif /* i2c2 && accel-int1 */

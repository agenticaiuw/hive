/* Standalone DRV2605L/LRA hardware test retained for later reuse. */
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/util.h>

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
 * VLV101040A first-motion test:
 *
 * 0x3C gives 169.27 Hz:
 *   f = 1 / (OL_LRA_PERIOD * 98.46 us)
 *
 * 0x7E caps a full-scale open-loop pulse at about 2.50 Vrms:
 *   Vrms = 21.32 mV * OD_CLAMP * sqrt(1 - f * 800 us)
 *
 * This matches, but does not exceed, the actuator's 2.5 Vrms rating.
 */
#define TEST_OL_LRA_PERIOD 0x3C
#define TEST_OD_CLAMP 0x7E
#define TEST_RTP_AMPLITUDE 0x7F
#define TEST_PULSE_MS 250
#define TEST_GAP_MS 600
#define TEST_PULSE_COUNT 3

#define LED_NODE DT_ALIAS(led0)

static const struct gpio_dt_spec led =
	GPIO_DT_SPEC_GET(LED_NODE, gpios);

volatile int drv2605l_test_result = -9999;
volatile uint8_t drv2605l_status = 0xFF;
volatile uint8_t drv2605l_test_phase;
volatile uint8_t drv2605l_feedback_control;
volatile uint8_t drv2605l_control3;
volatile uint8_t drv2605l_od_clamp;
volatile uint8_t drv2605l_ol_lra_period;

static int drv2605l_update_reg(const struct device *i2c, uint8_t reg,
			       uint8_t mask, uint8_t value)
{
	uint8_t current;
	int error;

	error = i2c_reg_read_byte(i2c, DRV2605L_ADDRESS, reg, &current);
	if (error != 0) {
		return error;
	}

	current = (current & ~mask) | (value & mask);
	return i2c_reg_write_byte(i2c, DRV2605L_ADDRESS, reg, current);
}

static int drv2605l_reset(const struct device *i2c)
{
	uint8_t mode;
	int error;

	error = i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_MODE, 0);
	if (error != 0) {
		return error;
	}

	k_usleep(250);

	error = i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_MODE, DRV2605L_MODE_RESET);
	if (error != 0) {
		return error;
	}

	for (int attempt = 0; attempt < 50; ++attempt) {
		k_msleep(1);
		error = i2c_reg_read_byte(i2c, DRV2605L_ADDRESS,
					  DRV2605L_REG_MODE, &mode);
		if (error == 0 && (mode & DRV2605L_MODE_RESET) == 0) {
			return i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
						  DRV2605L_REG_MODE, 0);
		}
	}

	return -ETIMEDOUT;
}

static void drv2605l_stop(const struct device *i2c)
{
	(void)i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
				 DRV2605L_REG_RTP_INPUT, 0);
	(void)i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
				 DRV2605L_REG_MODE, DRV2605L_MODE_STANDBY);
}

static int drv2605l_run_test(const struct device *i2c)
{
	int error;

	drv2605l_test_phase = 1;
	error = i2c_reg_read_byte(i2c, DRV2605L_ADDRESS,
				  DRV2605L_REG_STATUS,
				  (uint8_t *)&drv2605l_status);
	if (error != 0) {
		return error;
	}

	/* DEVICE_ID[2:0] = 111 identifies the DRV2605L. */
	if ((drv2605l_status & 0xE0) != 0xE0) {
		return -ENODEV;
	}

	drv2605l_test_phase = 2;
	error = drv2605l_reset(i2c);
	if (error != 0) {
		return error;
	}

	drv2605l_test_phase = 3;
	error = drv2605l_update_reg(i2c, DRV2605L_REG_FEEDBACK_CONTROL,
				    DRV2605L_N_ERM_LRA,
				    DRV2605L_N_ERM_LRA);
	if (error != 0) {
		return error;
	}

	/*
	 * Select fixed-frequency LRA open-loop operation and signed RTP.
	 * Signed RTP makes 0x00 idle and 0x7F full positive amplitude.
	 */
	error = drv2605l_update_reg(i2c, DRV2605L_REG_CONTROL3,
				    DRV2605L_LRA_OPEN_LOOP |
					    DRV2605L_DATA_FORMAT_RTP,
				    DRV2605L_LRA_OPEN_LOOP);
	if (error != 0) {
		return error;
	}

	error = i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_OD_CLAMP, TEST_OD_CLAMP);
	if (error != 0) {
		return error;
	}

	error = i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_OL_LRA_PERIOD,
				   TEST_OL_LRA_PERIOD);
	if (error != 0) {
		return error;
	}

	error = i2c_reg_read_byte(i2c, DRV2605L_ADDRESS,
				  DRV2605L_REG_FEEDBACK_CONTROL,
				  (uint8_t *)&drv2605l_feedback_control);
	if (error != 0) {
		return error;
	}
	error = i2c_reg_read_byte(i2c, DRV2605L_ADDRESS,
				  DRV2605L_REG_CONTROL3,
				  (uint8_t *)&drv2605l_control3);
	if (error != 0) {
		return error;
	}
	error = i2c_reg_read_byte(i2c, DRV2605L_ADDRESS,
				  DRV2605L_REG_OD_CLAMP,
				  (uint8_t *)&drv2605l_od_clamp);
	if (error != 0) {
		return error;
	}
	error = i2c_reg_read_byte(i2c, DRV2605L_ADDRESS,
				  DRV2605L_REG_OL_LRA_PERIOD,
				  (uint8_t *)&drv2605l_ol_lra_period);
	if (error != 0) {
		return error;
	}

	if ((drv2605l_feedback_control & DRV2605L_N_ERM_LRA) == 0 ||
	    (drv2605l_control3 & DRV2605L_LRA_OPEN_LOOP) == 0 ||
	    (drv2605l_control3 & DRV2605L_DATA_FORMAT_RTP) != 0 ||
	    drv2605l_od_clamp != TEST_OD_CLAMP ||
	    drv2605l_ol_lra_period != TEST_OL_LRA_PERIOD) {
		return -EIO;
	}

	drv2605l_test_phase = 4;
	error = i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_RTP_INPUT, 0);
	if (error != 0) {
		return error;
	}
	error = i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
				   DRV2605L_REG_MODE, DRV2605L_MODE_RTP);
	if (error != 0) {
		return error;
	}

	k_msleep(1500);

	for (int pulse = 0; pulse < TEST_PULSE_COUNT; ++pulse) {
		gpio_pin_set_dt(&led, 1);
		error = i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
					   DRV2605L_REG_RTP_INPUT,
					   TEST_RTP_AMPLITUDE);
		if (error != 0) {
			return error;
		}

		k_msleep(TEST_PULSE_MS);

		error = i2c_reg_write_byte(i2c, DRV2605L_ADDRESS,
					   DRV2605L_REG_RTP_INPUT, 0);
		gpio_pin_set_dt(&led, 0);
		if (error != 0) {
			return error;
		}

		k_msleep(TEST_GAP_MS);
	}

	drv2605l_test_phase = 5;
	drv2605l_stop(i2c);
	error = i2c_reg_read_byte(i2c, DRV2605L_ADDRESS,
				  DRV2605L_REG_STATUS,
				  (uint8_t *)&drv2605l_status);
	if (error != 0) {
		return error;
	}

	/* OC_DETECT or OVER_TEMP means the hardware test failed. */
	if ((drv2605l_status & (BIT(0) | BIT(1))) != 0) {
		return -EIO;
	}

	drv2605l_test_phase = 6;
	return 0;
}

int main(void)
{
	const struct device *const i2c =
		DEVICE_DT_GET(DT_NODELABEL(i2c2));
	int error;

	if (!gpio_is_ready_dt(&led)) {
		return 0;
	}

	error = gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	if (error != 0) {
		return 0;
	}

	if (!device_is_ready(i2c)) {
		drv2605l_test_result = -ENODEV;
		return 0;
	}

	drv2605l_test_result = drv2605l_run_test(i2c);
	drv2605l_stop(i2c);

	if (drv2605l_test_result == 0) {
		/* Steady LED means configuration and I2C test completed safely. */
		gpio_pin_set_dt(&led, 1);
		return 0;
	}

	/* Fast blinking means the test stopped on an error. */
	while (true) {
		gpio_pin_toggle_dt(&led);
		k_msleep(150);
	}
}

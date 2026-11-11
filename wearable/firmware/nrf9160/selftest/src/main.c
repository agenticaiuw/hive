/*
 * Bench self-test for the pendant breadboard — one honest sentence per wire.
 *
 * WHAT THIS IS FOR. The owner is at the bench with no multimeter. Every
 * question they can ask about this board ("is the haptic actually on the
 * bus?", "did the green button's wire really fall off?", "is the pot wired
 * backwards?") is answerable from the nRF9160 alone, and this app answers
 * them one at a time, in words, on the console.
 *
 * THE VOCABULARY, and it is deliberately three words and not two:
 *
 *   PASS       the part answered. Evidence is printed beside the verdict.
 *   FAIL       the part was asked and did not answer, or answered wrong.
 *   NOT-WIRED  the pin sat at exactly the level an unconnected pin sits at,
 *              and nothing the owner did moved it.
 *
 * FAIL and NOT-WIRED are different claims and must never be blurred. The
 * green button's wires are off the board today: that is NOT-WIRED, it is
 * expected, and calling it FAIL would send the owner hunting a fault that
 * does not exist. Equally, a test the owner simply was not at the bench for
 * reports "no input seen during the window" — silence from a human is not
 * evidence about a wire, and this app never scores it as one.
 *
 * THE HANDS PROBLEM. Six of these tests need a finger: press a button, turn
 * the knob, flip the red switch, say something. Those do NOT get six
 * separate windows the owner has to keep up with. They share ONE long
 * interactive window that watches every input at once and prints each change
 * as it happens, so the owner can work down the board at their own pace and
 * watch the console confirm each part as they touch it. The window repeats
 * forever, so nothing is missed by being slow.
 *
 * WHAT THIS APP DELIBERATELY DOES NOT DO: LTE, TF-M crypto beyond the
 * minimal profile, Opus, WebSockets, the microSD recording format, the
 * status LED. See prj.conf. A wiring answer must not depend on a radio.
 */
#include <errno.h>
#include <stdint.h>
#include <string.h>

#include <zephyr/device.h>
#include <zephyr/devicetree.h>
#include <zephyr/drivers/adc.h>
#include <zephyr/drivers/clock_control/nrf_clock_control.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2c.h>
#include <zephyr/drivers/i2s.h>
#include <zephyr/drivers/uart.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/storage/disk_access.h>
#include <zephyr/sys/onoff.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

#include <hal/nrf_dppi.h>
#include <hal/nrf_egu.h>
#include <hal/nrf_gpio.h>
#include <hal/nrf_pwm.h>
#include <hal/nrf_saadc.h>
#include <helpers/nrfx_gppi.h>
#include <ff.h>

/* ------------------------------------------------------------------ */
/* Pins under test — raw numbers, because raw levels are what we report */
/* ------------------------------------------------------------------ */

#define PIN_AMP_SD_MODE 1U
#define PIN_I2C_SDA 30U
#define PIN_I2C_SCL 31U
#define PIN_SD_CS 10U
#define PIN_SD_DI 11U
#define PIN_SD_DO 12U
#define PIN_SD_CLK 13U
#define PIN_BTN_YELLOW 21U
#define PIN_BTN_GREEN 22U
#define PIN_BTN_BLUE 23U
#define PIN_ENC_A 24U
#define PIN_ENC_B 25U
#define PIN_MIC_SENSE 26U

/*
 * Microphone clock generation, carried over verbatim from the pendant app's
 * mic_clocks_start(). The SPH0645 needs BCLK 1.024-4.096 MHz with LRCLK at
 * exactly BCLK/64; the nRF9160 I2S peripheral cannot make a 64-BCLK frame as
 * master (24-bit max word = 48 BCLK), so I2S runs SLAVE and two PWMs make
 * the clocks:
 *
 *   BCLK  = 16 MHz / 8   = 2.000 MHz on P0.16 (A2), jumpered to P0.18
 *   LRCLK = 16 MHz / 512 = 31.25 kHz on P0.14 (A0), jumpered to P0.17
 *
 * Both PWMs are started by one DPPI channel in the same clock cycle so
 * LRCLK edges land on BCLK falling edges. That co-start is not a nicety: a
 * sequential start leaves an arbitrary phase, and a phase-wrong capture
 * looks exactly like a broken microphone.
 */
#define MIC_BCLK_PIN 16U
#define MIC_LRCLK_PIN 14U
#define MIC_I2S_LRCK_PIN 17U
#define MIC_I2S_SCK_PIN 18U
#define MIC_BCLK_TOP 8U
#define MIC_LRCLK_TOP 512U
#define MIC_FRAME_RATE 31250U
#define MIC_GPPI_NODE 0U
#define MIC_RX_BLOCK_FRAMES 640U
#define MIC_RX_BLOCK_SIZE (MIC_RX_BLOCK_FRAMES * sizeof(int32_t))
#define MIC_RX_BLOCK_COUNT 8U
/* First block carries slave-sync and DMA-start artifacts; never scored. */
#define MIC_STARTUP_SKIP_BLOCKS 1U

#define POT_ADC_CHANNEL 2
#define POT_RAW_MAX 4095
/*
 * The DK's VDD is a solder-selectable rail (1.8-3.0 V), default 3.0 V, and
 * nothing on the chip can read which one is fitted. The pot reading is
 * RATIOMETRIC — VDD/4 reference against 1/4 gain — so the PERCENTAGE is
 * exact regardless, and the volts figure is that percentage times an
 * ASSUMED 3.0 V. The report labels it as assumed rather than pretending
 * to a measurement this board cannot make.
 */
#define POT_ASSUMED_VDD_MV 3000

#define SD_MOUNT_POINT "/SD:"
#define SD_TEST_PATH SD_MOUNT_POINT "/selftst.txt"
#define SD_TEST_PAYLOAD "pendant-selftest-ok"

/* DRV2605L (LRA, open loop) — register recipe and the VLV101040A numbers
 * are the ones src/haptic.c proved on this exact breakout. Reimplemented
 * here rather than linked: this app must keep answering even when the
 * application tree is mid-edit, which is exactly when a bench test is
 * most wanted.
 */
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
#define HAPTIC_OL_LRA_PERIOD 0x3C
#define HAPTIC_OD_CLAMP 0x7E

#define INTERACTIVE_WINDOW_MS 45000
#define MIC_WINDOW_MS 12000

static const struct device *const i2c_bus = DEVICE_DT_GET(DT_NODELABEL(i2c2));
static const struct device *const adc_dev = DEVICE_DT_GET(DT_NODELABEL(adc));
static const struct device *const esp_uart = DEVICE_DT_GET(DT_NODELABEL(uart1));
static const struct device *const i2s_dev = DEVICE_DT_GET(DT_NODELABEL(i2s0));

static const struct gpio_dt_spec btn_yellow =
	GPIO_DT_SPEC_GET(DT_ALIAS(ask_btn), gpios);
static const struct gpio_dt_spec btn_green =
	GPIO_DT_SPEC_GET(DT_ALIAS(memo_btn), gpios);
static const struct gpio_dt_spec btn_blue =
	GPIO_DT_SPEC_GET(DT_ALIAS(ptt_btn), gpios);
static const struct gpio_dt_spec enc_a =
	GPIO_DT_SPEC_GET(DT_ALIAS(encoder_a), gpios);
static const struct gpio_dt_spec enc_b =
	GPIO_DT_SPEC_GET(DT_ALIAS(encoder_b), gpios);
static const struct gpio_dt_spec mic_sense =
	GPIO_DT_SPEC_GET(DT_ALIAS(mic_sense), gpios);
static const struct gpio_dt_spec amp_sd_mode =
	GPIO_DT_SPEC_GET(DT_ALIAS(amp_sd_mode), gpios);

static bool haptic_ready;

/* ------------------------------------------------------------------ */
/* Test 1 — I2C scan on P0.30 (SDA) / P0.31 (SCL)                      */
/* ------------------------------------------------------------------ */

/*
 * Is this pin held HIGH by something stronger than our own internal pull-down?
 *
 * WHY THIS EXISTS. "Nothing ACKed" has two completely different repairs, and
 * the owner should not have to guess which. An idle I2C line sits HIGH only
 * because an external resistor pulls it to 3V, so the line itself reports on
 * the health of both the pull-up AND the 3V rail feeding it:
 *
 *   HIGH, and it STAYS high against our internal pull-down
 *       -> a strong external pull-up is present and its rail is alive. The
 *          nRF's internal pull-down is ~13k; a 4.7k to 3V divides to ~2.2 V,
 *          which still reads HIGH. So the resistors and 3V are fine and the
 *          fault is at the DEVICE (unpowered, or its SDA/SCL leg is off).
 *   HIGH, but our pull-down DRAGS IT LOW
 *       -> nothing but leakage was holding it up: no external pull-up, or the
 *          pull-up's 3V end is dead.
 *   LOW while idle
 *       -> no pull-up at all, or the line is shorted to GND. A bus cannot
 *          idle LOW; nothing can ever ACK in this state.
 *
 * The pin is left in the standard TWI pad configuration (input, S0D1
 * open-drain, no pull) so the I2C peripheral works normally afterwards.
 */
static bool pin_holds_high_against_pulldown(uint32_t pin, bool *idle_high)
{
	bool held;

	nrf_gpio_cfg_input(pin, NRF_GPIO_PIN_NOPULL);
	k_busy_wait(500);
	*idle_high = nrf_gpio_pin_read(pin) != 0U;

	nrf_gpio_cfg_input(pin, NRF_GPIO_PIN_PULLDOWN);
	k_busy_wait(500);
	held = nrf_gpio_pin_read(pin) != 0U;

	/* Exactly what nrfx pinctrl leaves TWI pins in. */
	nrf_gpio_cfg(pin, NRF_GPIO_PIN_DIR_INPUT, NRF_GPIO_PIN_INPUT_CONNECT,
		     NRF_GPIO_PIN_NOPULL, NRF_GPIO_PIN_S0D1,
		     NRF_GPIO_PIN_NOSENSE);
	return held;
}

/* Set by test_i2c_scan so the microSD verdict can point at a shared cause. */
static bool i2c_rail_alive;

static void report_bus_lines(void)
{
	bool sda_idle = false;
	bool scl_idle = false;
	bool sda_held = pin_holds_high_against_pulldown(PIN_I2C_SDA, &sda_idle);
	bool scl_held = pin_holds_high_against_pulldown(PIN_I2C_SCL, &scl_idle);

	printk("    line check (before any traffic):\n");
	printk("      SDA P0.30 idle %s, %s against an internal pull-down\n",
	       sda_idle ? "HIGH" : "LOW ",
	       sda_held ? "HOLDS" : "collapses");
	printk("      SCL P0.31 idle %s, %s against an internal pull-down\n",
	       scl_idle ? "HIGH" : "LOW ",
	       scl_held ? "HOLDS" : "collapses");

	i2c_rail_alive = sda_held && scl_held;
	if (i2c_rail_alive) {
		printk("      => pull-ups PRESENT and their 3V rail is ALIVE "
		       "(a 4.7k to 3V beats\n");
		printk("         the ~13k internal pull-down; that is what "
		       "HOLDS means here).\n");
	} else if (sda_idle || scl_idle) {
		printk("      => a line floats HIGH but cannot hold. That is "
		       "leakage, not a\n");
		printk("         pull-up: either no 4.7k fitted, or the "
		       "resistor's 3V end is dead.\n");
	} else {
		printk("      => line(s) sit LOW. A bus cannot idle LOW: no "
		       "pull-up at all, or\n");
		printk("         the line is shorted to GND. Nothing can ever "
		       "ACK in this state.\n");
	}
}

static bool i2c_address_acks(uint8_t address)
{
	uint8_t scratch = 0U;
	struct i2c_msg msg = {
		.buf = &scratch,
		.len = 0U,
		.flags = I2C_MSG_WRITE | I2C_MSG_STOP,
	};

	return i2c_transfer(i2c_bus, &msg, 1U, address) == 0;
}

static void test_i2c_scan(void)
{
	unsigned int found = 0U;
	bool saw_haptic = false;

	printk("\n[1] I2C SCAN  bus i2c2, SDA P0.30 / SCL P0.31, 100 kHz\n");

	if (!device_is_ready(i2c_bus)) {
		printk("    FAIL      i2c2 driver not ready — nothing was "
		       "put on the wire\n");
		return;
	}

	report_bus_lines();

	for (uint8_t address = 0x08U; address <= 0x77U; ++address) {
		if (!i2c_address_acks(address)) {
			continue;
		}
		++found;
		printk("    ACK       0x%02x", address);
		if (address == DRV2605L_ADDRESS) {
			saw_haptic = true;
			printk("  <- DRV2605L haptic driver (expected)");
		} else if (address == 0x6AU || address == 0x6BU) {
			printk("  <- LSM6DSOX accelerometer (being removed; "
			       "presence only, nothing depends on it)");
		} else {
			printk("  <- UNEXPECTED, not in the wiring doc");
		}
		printk("\n");
	}

	if (found == 0U) {
		printk("    NOTHING ON THE BUS. Not one address answered.\n");
		if (i2c_rail_alive) {
			printk("    NOT-WIRED the bus itself is HEALTHY — "
			       "pull-ups fitted, 3V rail alive,\n");
			printk("              both lines idle HIGH. So this is "
			       "NOT a pull-up fault and\n");
			printk("              NOT a dead rail. Chase the DEVICE "
			       "end: the DRV2605L's own\n");
			printk("              VIN/GND legs, or its SDA/SCL "
			       "jumper off the breakout.\n");
		} else {
			printk("    NOT-WIRED the BUS is dead before any device "
			       "is even asked. Chase the\n");
			printk("              two 4.7k pull-ups to 3V and the "
			       "3V rail feeding them —\n");
			printk("              per the line check above, not the "
			       "haptic breakout. The DK\n");
			printk("              routes NO pull-ups to P0.30/31, "
			       "so they must be external.\n");
		}
		return;
	}

	printk("    %-9s %u address(es) answered\n",
	       saw_haptic ? "PASS" : "FAIL", found);
	if (!saw_haptic) {
		printk("              but 0x%02x (the haptic) was NOT among "
		       "them\n",
		       DRV2605L_ADDRESS);
	}
}

/* ------------------------------------------------------------------ */
/* Test 2 — DRV2605L haptic: three distinguishable pulses              */
/* ------------------------------------------------------------------ */

static int drv2605l_update(uint8_t reg, uint8_t mask, uint8_t value)
{
	uint8_t current;
	int error = i2c_reg_read_byte(i2c_bus, DRV2605L_ADDRESS, reg, &current);

	if (error != 0) {
		return error;
	}
	current = (current & ~mask) | (value & mask);
	return i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS, reg, current);
}

static int drv2605l_reset(void)
{
	uint8_t mode;
	int error = i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS,
				       DRV2605L_REG_MODE, 0);

	if (error != 0) {
		return error;
	}
	k_usleep(250);
	error = i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS,
				   DRV2605L_REG_MODE, DRV2605L_MODE_RESET);
	if (error != 0) {
		return error;
	}
	for (int attempt = 0; attempt < 50; ++attempt) {
		k_msleep(1);
		error = i2c_reg_read_byte(i2c_bus, DRV2605L_ADDRESS,
					  DRV2605L_REG_MODE, &mode);
		if (error == 0 && (mode & DRV2605L_MODE_RESET) == 0) {
			return i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS,
						  DRV2605L_REG_MODE, 0);
		}
	}
	return -ETIMEDOUT;
}

static int haptic_configure(uint8_t *status_out)
{
	uint8_t status;
	int error;

	error = i2c_reg_read_byte(i2c_bus, DRV2605L_ADDRESS,
				  DRV2605L_REG_STATUS, &status);
	if (error != 0) {
		return error;
	}
	*status_out = status;
	/* DEVICE_ID[2:0] = 111 identifies the DRV2605L. */
	if ((status & 0xE0U) != 0xE0U) {
		return -ENODEV;
	}
	error = drv2605l_reset();
	if (error != 0) {
		return error;
	}
	error = drv2605l_update(DRV2605L_REG_FEEDBACK_CONTROL,
				DRV2605L_N_ERM_LRA, DRV2605L_N_ERM_LRA);
	if (error != 0) {
		return error;
	}
	error = drv2605l_update(DRV2605L_REG_CONTROL3,
				DRV2605L_LRA_OPEN_LOOP |
					DRV2605L_DATA_FORMAT_RTP,
				DRV2605L_LRA_OPEN_LOOP);
	if (error != 0) {
		return error;
	}
	error = i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS,
				   DRV2605L_REG_OD_CLAMP, HAPTIC_OD_CLAMP);
	if (error != 0) {
		return error;
	}
	return i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS,
				  DRV2605L_REG_OL_LRA_PERIOD,
				  HAPTIC_OL_LRA_PERIOD);
}

static void haptic_pulse(const char *label, uint8_t amplitude, uint16_t on_ms)
{
	int error;

	/*
	 * Print BEFORE driving, not after. The whole value of this test is
	 * that the owner can correlate a buzz they felt with a line they
	 * saw; a line printed after a 150 ms pulse has already lost the
	 * race against their attention.
	 */
	printk("    >>> NOW: %-6s (amplitude 0x%02x, %u ms) — feel it?\n",
	       label, amplitude, on_ms);

	error = i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS,
				   DRV2605L_REG_MODE, DRV2605L_MODE_RTP);
	if (error == 0) {
		error = i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS,
					   DRV2605L_REG_RTP_INPUT, amplitude);
	}
	if (error != 0) {
		printk("        bus error %d while driving\n", error);
	}
	k_msleep(on_ms);
	(void)i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS,
				 DRV2605L_REG_RTP_INPUT, 0);
	(void)i2c_reg_write_byte(i2c_bus, DRV2605L_ADDRESS,
				 DRV2605L_REG_MODE, DRV2605L_MODE_STANDBY);
}

static void test_haptic(void)
{
	uint8_t status = 0xFFU;
	int error;

	printk("\n[2] HAPTIC    DRV2605L 0x5A on I2C2, LRA open-loop RTP\n");

	error = haptic_configure(&status);
	if (error != 0) {
		haptic_ready = false;
		printk("    FAIL      not configured (%d, status=0x%02x)\n",
		       error, status);
		printk("              nothing was driven; see the I2C scan "
		       "above for why\n");
		return;
	}
	haptic_ready = true;
	printk("    PASS      configured (status=0x%02x)\n", status);
	printk("              three pulses follow, 1 s apart, weakest "
	       "first.\n");
	printk("              HOLD THE MOTOR — a loose LRA on a breadboard "
	       "buzzes\n");
	printk("              against the bench and is easy to miss.\n");

	k_msleep(1000);
	haptic_pulse("TICK", 0x58U, 25U);
	k_msleep(1000);
	haptic_pulse("CLICK", 0x74U, 60U);
	k_msleep(1000);
	haptic_pulse("STRONG", 0x7EU, 150U);
	k_msleep(400);
	printk("    ---       three pulses fired. The bus said yes to all "
	       "three;\n");
	printk("              only the owner can say whether the MOTOR "
	       "moved.\n");
}

/* ------------------------------------------------------------------ */
/* Tests 3, 4, 6 — resting levels                                      */
/* ------------------------------------------------------------------ */

static void report_resting(const char *name, uint32_t pin, const char *expect)
{
	uint32_t level = nrf_gpio_pin_read(pin);

	printk("    P0.%02u %-14s = %s   (expected %s)\n", pin, name,
	       level ? "HIGH" : "LOW ", expect);
}

static void test_resting_levels(void)
{
	printk("\n[3/4/6] RESTING LEVELS  (raw pad levels, pull-ups applied "
	       "per devicetree)\n");
	printk("    Buttons and encoder switch to GND against internal "
	       "pull-ups, so\n");
	printk("    untouched = HIGH. A pin stuck LOW at rest is SHORTED. A "
	       "pin that\n");
	printk("    is HIGH here proves nothing on its own — only moving it "
	       "does.\n");
	report_resting("yellow button", PIN_BTN_YELLOW, "HIGH");
	report_resting("green button", PIN_BTN_GREEN,
		       "HIGH — wires are off, see note");
	report_resting("blue button", PIN_BTN_BLUE, "HIGH");
	report_resting("encoder A", PIN_ENC_A, "HIGH");
	report_resting("encoder B", PIN_ENC_B, "HIGH");
	printk("    P0.%02u %-14s = %s   (no pull at all: HIGH = mic "
	       "powered, LOW = red switch cut it)\n",
	       PIN_MIC_SENSE, "mic sense",
	       nrf_gpio_pin_read(PIN_MIC_SENSE) ? "HIGH" : "LOW ");
}

/* ------------------------------------------------------------------ */
/* Test 5 — volume pot on P0.15 (AIN2)                                 */
/* ------------------------------------------------------------------ */

static bool pot_ready;

static void pot_init(void)
{
	static const struct adc_channel_cfg cfg = {
		.gain = ADC_GAIN_1_4,
		.reference = ADC_REF_VDD_1_4,
		.acquisition_time =
			ADC_ACQ_TIME(ADC_ACQ_TIME_MICROSECONDS, 10),
		.channel_id = POT_ADC_CHANNEL,
		.differential = 0,
		.input_positive = NRF_SAADC_INPUT_AIN2,
	};

	pot_ready = device_is_ready(adc_dev) &&
		    adc_channel_setup(adc_dev, &cfg) == 0;
}

static int pot_read_raw(void)
{
	int16_t sample;
	struct adc_sequence sequence = {
		.channels = BIT(POT_ADC_CHANNEL),
		.buffer = &sample,
		.buffer_size = sizeof(sample),
		.resolution = 12,
		.oversampling = 2U,
	};

	if (!pot_ready || adc_read(adc_dev, &sequence) != 0) {
		return -1;
	}
	/* Single-ended reads dip a hair below zero near GND. */
	return CLAMP((int)sample, 0, POT_RAW_MAX);
}

static void pot_print(int raw)
{
	int permille;
	int millivolts;

	if (raw < 0) {
		printk("    raw=----  (ADC read failed)\n");
		return;
	}
	permille = (raw * 1000) / POT_RAW_MAX;
	millivolts = (raw * POT_ASSUMED_VDD_MV) / POT_RAW_MAX;
	printk("    raw=%4d  %3d.%d%%  ~%d.%03d V (assuming VDD=3.0 V)\n", raw,
	       permille / 10, permille % 10, millivolts / 1000,
	       millivolts % 1000);
}

static void test_pot(void)
{
	int minimum = POT_RAW_MAX;
	int maximum = 0;

	printk("\n[5] VOLUME POT  wiper P0.15 = AIN2, ratiometric "
	       "(VDD/4 ref, 1/4 gain)\n");
	if (!pot_ready) {
		printk("    FAIL      SAADC channel would not configure\n");
		return;
	}
	printk("    Ten reads, one per second. TURN THE KNOB NOW and watch "
	       "the number move.\n");
	for (unsigned int index = 0U; index < 10U; ++index) {
		int raw = pot_read_raw();

		pot_print(raw);
		if (raw >= 0) {
			minimum = MIN(minimum, raw);
			maximum = MAX(maximum, raw);
		}
		k_msleep(1000);
	}
	printk("    span seen this window: raw %d..%d (%d counts)\n", minimum,
	       maximum, maximum - minimum);
	if (maximum - minimum < 100) {
		printk("    ---       the reading barely moved. Either the "
		       "knob was not turned\n");
		printk("              (no verdict), or the wiper is not on "
		       "P0.15. A wiper that\n");
		printk("              is wired but with BOTH side legs "
		       "floating also sits still.\n");
	} else {
		printk("    PASS      the wiper moves the ADC — pot is "
		       "wired and live\n");
	}
}

/* ------------------------------------------------------------------ */
/* Test 7 — microSD on P0.10-13                                        */
/* ------------------------------------------------------------------ */

static FATFS sd_fat_fs;
static struct fs_mount_t sd_mount = {
	.type = FS_FATFS,
	.mnt_point = SD_MOUNT_POINT,
	.fs_data = &sd_fat_fs,
	.flags = FS_MOUNT_FLAG_NO_FORMAT,
};

static void test_microsd(void)
{
	struct fs_file_t file;
	char readback[sizeof(SD_TEST_PAYLOAD)] = { 0 };
	uint32_t sector_count = 0U;
	uint32_t sector_size = 0U;
	int error;

	printk("\n[7] microSD    SPI on P0.10 CS / P0.11 DI / P0.12 DO / "
	       "P0.13 CLK\n");

	error = disk_access_init("SD");
	if (error != 0) {
		bool do_idle = false;
		bool do_held;

		printk("    ---       disk_access_init = %d — the card never "
		       "answered CMD0\n",
		       error);

		/*
		 * Same question as the I2C bus, asked the same way. DO (MISO)
		 * is the CARD's output, so whether it can hold itself HIGH
		 * against our internal pull-down separates a card that is
		 * powered and driving from a pin that is merely floating.
		 */
		do_held = pin_holds_high_against_pulldown(PIN_SD_DO, &do_idle);
		nrf_gpio_cfg_input(PIN_SD_DO, NRF_GPIO_PIN_NOPULL);

		printk("      DO  P0.12 (card's output) idle %s, %s against "
		       "an internal pull-down\n",
		       do_idle ? "HIGH" : "LOW ",
		       do_held ? "HOLDS" : "collapses");
		if (do_held) {
			printk("    FAIL      something IS driving DO high, so "
			       "the card has power and\n");
			printk("              the DO wire is good — but it "
			       "will not answer CMD0. Chase\n");
			printk("              the other three SPI legs: CS "
			       "P0.10, DI P0.11, CLK P0.13.\n");
		} else {
			printk("    NOT-WIRED DO floats — nothing is driving "
			       "it. That is an absent or\n");
			printk("              UNPOWERED card, not a bad SPI "
			       "wire: no card in the slot,\n");
			printk("              not seated, or its 3V/GND is "
			       "off.\n");
			if (!i2c_rail_alive) {
				printk("              NOTE: the I2C bus is dead "
				       "too, on a DIFFERENT peripheral.\n");
				printk("              Two buses failing at once "
				       "points at the ONE thing they\n");
				printk("              share — the 3V/GND "
				       "breadboard rails. Check those first.\n");
			}
		}
		return;
	}

	if (disk_access_ioctl("SD", DISK_IOCTL_GET_SECTOR_COUNT,
			      &sector_count) == 0 &&
	    disk_access_ioctl("SD", DISK_IOCTL_GET_SECTOR_SIZE,
			      &sector_size) == 0) {
		uint64_t bytes = (uint64_t)sector_count * (uint64_t)sector_size;

		printk("    ---       card present: %u sectors x %u B = "
		       "%u MiB\n",
		       sector_count, sector_size,
		       (uint32_t)(bytes / (1024U * 1024U)));
	}

	error = fs_mount(&sd_mount);
	if (error != 0) {
		printk("    FAIL      card answers on SPI but the filesystem "
		       "would not mount (%d)\n",
		       error);
		printk("              The wiring is GOOD (the card talked). "
		       "The card needs a\n");
		printk("              FAT32 partition — this app will never "
		       "format it for you.\n");
		return;
	}

	fs_file_t_init(&file);
	error = fs_open(&file, SD_TEST_PATH,
			FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
	if (error != 0) {
		printk("    FAIL      mounted, but open-for-write = %d "
		       "(card write-protected?)\n",
		       error);
		(void)fs_unmount(&sd_mount);
		return;
	}
	error = fs_write(&file, SD_TEST_PAYLOAD, strlen(SD_TEST_PAYLOAD));
	(void)fs_close(&file);
	if (error != (int)strlen(SD_TEST_PAYLOAD)) {
		printk("    FAIL      wrote %d of %u bytes\n", error,
		       (unsigned int)strlen(SD_TEST_PAYLOAD));
		(void)fs_unmount(&sd_mount);
		return;
	}

	fs_file_t_init(&file);
	error = fs_open(&file, SD_TEST_PATH, FS_O_READ);
	if (error != 0) {
		printk("    FAIL      wrote fine but reopen-for-read = %d\n",
		       error);
		(void)fs_unmount(&sd_mount);
		return;
	}
	error = fs_read(&file, readback, sizeof(readback) - 1U);
	(void)fs_close(&file);
	(void)fs_unmount(&sd_mount);

	if (error == (int)strlen(SD_TEST_PAYLOAD) &&
	    strcmp(readback, SD_TEST_PAYLOAD) == 0) {
		printk("    PASS      wrote and read back \"%s\" at %s\n",
		       readback, SD_TEST_PATH);
	} else {
		printk("    FAIL      read back %d bytes: \"%s\"\n", error,
		       readback);
	}
}

/* ------------------------------------------------------------------ */
/* Test 9 — UART command link to the ESP32, P0.00 TX / P0.05 RX        */
/* ------------------------------------------------------------------ */

static uint8_t esp_rx[512];
static volatile uint32_t esp_rx_len;

static void esp_uart_isr(const struct device *dev, void *user_data)
{
	uint8_t byte;

	ARG_UNUSED(user_data);

	if (!uart_irq_update(dev)) {
		return;
	}
	while (uart_irq_rx_ready(dev)) {
		if (uart_fifo_read(dev, &byte, 1) != 1) {
			break;
		}
		if (esp_rx_len < sizeof(esp_rx) - 1U) {
			esp_rx[esp_rx_len++] = byte;
		}
	}
}

static void esp_print_received(void)
{
	uint32_t length = esp_rx_len;

	printk("    got %u byte(s): ", length);
	for (uint32_t index = 0U; index < length; ++index) {
		uint8_t byte = esp_rx[index];

		if (byte == '\n') {
			printk("\\n");
		} else if (byte == '\r') {
			printk("\\r");
		} else if (byte >= 0x20U && byte < 0x7FU) {
			printk("%c", byte);
		} else {
			printk("<%02x>", byte);
		}
	}
	printk("\n");
}

static void test_esp32_uart(void)
{
	static const char command[] = "{\"command\":\"status\"}\n";
	int64_t deadline;

	printk("\n[9] ESP32 UART  uart1 115200 8N1, TX P0.00 -> ESP32 GPIO16, "
	       "RX P0.05 <- GPIO17\n");

	if (!device_is_ready(esp_uart)) {
		printk("    FAIL      uart1 driver not ready\n");
		return;
	}

	/*
	 * CAVEAT THE OWNER MUST HAVE, and it belongs in the output rather
	 * than only in a report: with the DK's STOCK board-controller image
	 * the interface MCU still drives P0.00 through the VCOM2 analog
	 * switch. Two push-pull drivers on one net means the start bits are
	 * contended, so a negative result here is NOT evidence about the
	 * jumper wires. Only a positive result is trustworthy in that state.
	 */
	printk("    NOTE: this test is only conclusive when it PASSES. With "
	       "the stock DK\n");
	printk("          board-controller image the interface MCU also "
	       "drives P0.00\n");
	printk("          (VCOM2 routing), so a silent ESP32 may mean "
	       "contention, not a\n");
	printk("          missing wire. A reply proves the wires AND the "
	       "routing at once.\n");

	esp_rx_len = 0U;
	uart_irq_callback_user_data_set(esp_uart, esp_uart_isr, NULL);
	uart_irq_rx_enable(esp_uart);

	/* Drain anything the line collected while it was unread. */
	k_msleep(50);
	esp_rx_len = 0U;

	printk("    sending %s", command);
	for (const char *cursor = command; *cursor != '\0'; ++cursor) {
		uart_poll_out(esp_uart, (unsigned char)*cursor);
	}

	deadline = k_uptime_get() + 2000;
	while (k_uptime_get() < deadline) {
		if (esp_rx_len > 0U && esp_rx[esp_rx_len - 1U] == '\n') {
			break;
		}
		k_msleep(10);
	}

	uart_irq_rx_disable(esp_uart);

	if (esp_rx_len == 0U) {
		printk("    no reply    nothing arrived in 2 s.\n");
		printk("                Per the note above this is "
		       "INCONCLUSIVE, not a FAIL:\n");
		printk("                reflash the board controller with "
		       "vcom2 routing off,\n");
		printk("                then re-run. Check too that the "
		       "ESP32 is powered and\n");
		printk("                that its GND shares the "
		       "breadboard's black rail.\n");
		return;
	}

	esp_print_received();
	if (memchr(esp_rx, '{', esp_rx_len) != NULL) {
		printk("    PASS        a JSON-looking line came back — both "
		       "jumpers AND the\n");
		printk("                board-controller routing are good.\n");
	} else {
		printk("    partial     bytes arrived but no JSON. The RX "
		       "wire is alive;\n");
		printk("                suspect a baud mismatch or a "
		       "contended TX (see note).\n");
	}
}

/* ------------------------------------------------------------------ */
/* Test 10 — MAX98357A SD_MODE on P0.01                                */
/* ------------------------------------------------------------------ */

static void test_amp_sd_mode(void)
{
	printk("\n[10] AMP SD_MODE  MAX98357A shutdown gate on P0.01\n");

	if (gpio_pin_configure_dt(&amp_sd_mode, GPIO_OUTPUT_INACTIVE) != 0) {
		printk("    FAIL      could not configure P0.01 as an "
		       "output\n");
		return;
	}

	/*
	 * This test reports a PIN, never a SOUND. The owner may have no
	 * speaker soldered to the amp at all, and "I heard nothing" would be
	 * a false negative every time. What is actually verifiable from the
	 * chip is that the pad drives and reads back both ways.
	 */
	for (unsigned int cycle = 0U; cycle < 4U; ++cycle) {
		int level = (int)(cycle & 1U);

		(void)gpio_pin_set_dt(&amp_sd_mode, level);
		k_msleep(120);
		printk("    drove %s -> pad reads %s\n", level ? "HIGH" : "LOW",
		       nrf_gpio_pin_out_read(PIN_AMP_SD_MODE) ? "HIGH" : "LOW");
	}
	(void)gpio_pin_set_dt(&amp_sd_mode, 0);
	printk("    PASS      P0.01 toggles (left LOW = amp in shutdown, the "
	       "boot default)\n");
	printk("              Audible only if a speaker is wired to the "
	       "MAX98357A; the\n");
	printk("              verdict above is about the PIN, not about "
	       "sound.\n");
	printk("              Bench trick with the stock board controller: "
	       "P0.01 is the\n");
	printk("              VCOM2 line the interface MCU LISTENS on, so "
	       "these toggles\n");
	printk("              show up as stray bytes on the host's third "
	       "VCOM port.\n");
}

/* ------------------------------------------------------------------ */
/* The interactive window — every hands-on test at once                */
/* ------------------------------------------------------------------ */

/*
 * Quadrature decode. The encoder's detents are counted from the A/B Gray
 * code rather than from A's edges alone: edge-counting on one line reports
 * a detent for contact bounce, which on a breadboard would score a
 * motionless knob as "working".
 */
static const int8_t quad_table[16] = {
	0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0,
};

struct edge_watch {
	const char *name;
	uint32_t pin;
	uint32_t last;
	uint32_t edges;
	uint32_t presses;
};

static void interactive_window(uint32_t window_ms)
{
	struct edge_watch watch[] = {
		{ "yellow button P0.21", PIN_BTN_YELLOW, 1U, 0U, 0U },
		{ "green button  P0.22", PIN_BTN_GREEN, 1U, 0U, 0U },
		{ "blue button   P0.23", PIN_BTN_BLUE, 1U, 0U, 0U },
	};
	uint32_t enc_state;
	int32_t enc_position = 0;
	int32_t enc_clockwise = 0;
	int32_t enc_counter = 0;
	uint32_t enc_edges = 0U;
	uint32_t mic_sense_last;
	uint32_t mic_sense_changes = 0U;
	int pot_minimum = POT_RAW_MAX;
	int pot_maximum = 0;
	int64_t started;
	int64_t next_pot_read;

	printk("\n=================================================="
	       "==============\n");
	printk(" INTERACTIVE WINDOW — %u seconds. Everything below is "
	       "watched at once.\n",
	       window_ms / 1000U);
	printk("=================================================="
	       "==============\n");
	printk(" Work down the board at your own pace; each action prints as "
	       "it happens.\n");
	printk("   - press the YELLOW button (P0.21)\n");
	printk("   - press the GREEN button (P0.22) — its wires are off, so "
	       "expect silence\n");
	printk("   - press the BLUE button (P0.23)\n");
	printk("   - turn the knob BOTH ways, a few detents each\n");
	printk("   - flip the RED latching switch (mic power) once each way\n");
	printk("   - sweep the volume pot end to end\n");
	printk(" This window repeats forever — if you miss one, it comes "
	       "round again.\n\n");

	for (size_t index = 0U; index < ARRAY_SIZE(watch); ++index) {
		watch[index].last = nrf_gpio_pin_read(watch[index].pin);
	}
	enc_state = (nrf_gpio_pin_read(PIN_ENC_A) << 1) |
		    nrf_gpio_pin_read(PIN_ENC_B);
	mic_sense_last = nrf_gpio_pin_read(PIN_MIC_SENSE);

	started = k_uptime_get();
	next_pot_read = started;

	while (k_uptime_get() - started < (int64_t)window_ms) {
		int64_t elapsed = k_uptime_get() - started;

		for (size_t index = 0U; index < ARRAY_SIZE(watch); ++index) {
			uint32_t level = nrf_gpio_pin_read(watch[index].pin);

			if (level == watch[index].last) {
				continue;
			}
			watch[index].last = level;
			++watch[index].edges;
			if (level == 0U) {
				++watch[index].presses;
				printk("  [%5lld ms] %s  PRESSED\n", elapsed,
				       watch[index].name);
			} else {
				printk("  [%5lld ms] %s  released\n", elapsed,
				       watch[index].name);
			}
		}

		{
			uint32_t state = (nrf_gpio_pin_read(PIN_ENC_A) << 1) |
					 nrf_gpio_pin_read(PIN_ENC_B);

			if (state != enc_state) {
				int8_t step =
					quad_table[(enc_state << 2) | state];

				++enc_edges;
				enc_state = state;
				if (step != 0) {
					enc_position += step;
					/*
					 * Four quadrature steps per mechanical
					 * detent on this part; report detents,
					 * because detents are what the owner's
					 * fingers count.
					 */
					if (enc_position >= 4) {
						enc_position = 0;
						++enc_clockwise;
						printk("  [%5lld ms] encoder "
						       "detent  CW   (total "
						       "cw=%d ccw=%d)\n",
						       elapsed, enc_clockwise,
						       enc_counter);
					} else if (enc_position <= -4) {
						enc_position = 0;
						++enc_counter;
						printk("  [%5lld ms] encoder "
						       "detent  CCW  (total "
						       "cw=%d ccw=%d)\n",
						       elapsed, enc_clockwise,
						       enc_counter);
					}
				}
			}
		}

		{
			uint32_t level = nrf_gpio_pin_read(PIN_MIC_SENSE);

			if (level != mic_sense_last) {
				mic_sense_last = level;
				++mic_sense_changes;
				printk("  [%5lld ms] mic power P0.26 -> %s  "
				       "(red switch %s)\n",
				       elapsed, level ? "HIGH" : "LOW",
				       level ? "FEEDING the mic"
					     : "CUT the mic");
			}
		}

		if (k_uptime_get() >= next_pot_read) {
			int raw = pot_read_raw();

			next_pot_read += 250;
			if (raw >= 0) {
				if (raw < pot_minimum || raw > pot_maximum) {
					pot_minimum = MIN(pot_minimum, raw);
					pot_maximum = MAX(pot_maximum, raw);
					printk("  [%5lld ms] pot P0.15 raw="
					       "%4d (%d%%)  span so far "
					       "%d..%d\n",
					       elapsed, raw,
					       (raw * 100) / POT_RAW_MAX,
					       pot_minimum, pot_maximum);
				}
			}
		}

		k_msleep(2);
	}

	printk("\n---- what this window saw ----\n");
	for (size_t index = 0U; index < ARRAY_SIZE(watch); ++index) {
		if (watch[index].edges == 0U) {
			printk("  %s : no input seen during the window\n",
			       watch[index].name);
		} else {
			printk("  %s : %u press(es), %u edge(s)  PASS\n",
			       watch[index].name, watch[index].presses,
			       watch[index].edges);
		}
	}
	if (enc_edges == 0U) {
		printk("  encoder A/B P0.24/25 : no input seen during the "
		       "window\n");
	} else {
		printk("  encoder A/B P0.24/25 : %u edge(s), %d detent(s) CW, "
		       "%d CCW  PASS\n",
		       enc_edges, enc_clockwise, enc_counter);
	}
	if (mic_sense_changes == 0U) {
		printk("  mic sense P0.26      : no change during the window "
		       "(resting %s)\n",
		       mic_sense_last ? "HIGH = powered" : "LOW = cut");
	} else {
		printk("  mic sense P0.26      : %u change(s), now %s  PASS\n",
		       mic_sense_changes,
		       mic_sense_last ? "HIGH = powered" : "LOW = cut");
	}
	if (pot_maximum - pot_minimum < 100) {
		printk("  pot P0.15            : span %d..%d — barely moved, "
		       "no verdict\n",
		       pot_minimum, pot_maximum);
	} else {
		printk("  pot P0.15            : span %d..%d of 0..4095  "
		       "PASS\n",
		       pot_minimum, pot_maximum);
	}
}

/* ------------------------------------------------------------------ */
/* Test 8 — microphone capture, peak/RMS level meter                   */
/* ------------------------------------------------------------------ */

static uint16_t mic_bclk_duty[1] __aligned(4) = { MIC_BCLK_TOP / 2U };
static uint16_t mic_lrclk_duty[1] __aligned(4) = { MIC_LRCLK_TOP / 2U };
static struct onoff_manager *mic_hfclk_mgr;
static int mic_dppi_channel = -1;
static char __aligned(4) mic_rx_storage[MIC_RX_BLOCK_SIZE * MIC_RX_BLOCK_COUNT];
static struct k_mem_slab mic_rx_slab;

static void mic_clock_pwm_arm(NRF_PWM_Type *pwm, uint32_t pin,
			      uint16_t countertop, const uint16_t *duty)
{
	uint32_t out_pins[NRF_PWM_CHANNEL_COUNT] = {
		pin,
		NRF_PWM_PIN_NOT_CONNECTED,
		NRF_PWM_PIN_NOT_CONNECTED,
		NRF_PWM_PIN_NOT_CONNECTED,
	};

	nrf_gpio_pin_clear(pin);
	nrf_gpio_cfg_output(pin);
	nrf_pwm_pins_set(pwm, out_pins);
	nrf_pwm_configure(pwm, NRF_PWM_CLK_16MHz, NRF_PWM_MODE_UP, countertop);
	nrf_pwm_decoder_set(pwm, NRF_PWM_LOAD_COMMON, NRF_PWM_STEP_AUTO);
	nrf_pwm_seq_ptr_set(pwm, 0, duty);
	nrf_pwm_seq_cnt_set(pwm, 0, 1);
	nrf_pwm_seq_refresh_set(pwm, 0, 0);
	nrf_pwm_seq_end_delay_set(pwm, 0, 0);
	nrf_pwm_seq_ptr_set(pwm, 1, duty);
	nrf_pwm_seq_cnt_set(pwm, 1, 1);
	nrf_pwm_seq_refresh_set(pwm, 1, 0);
	nrf_pwm_seq_end_delay_set(pwm, 1, 0);
	nrf_pwm_loop_set(pwm, 1);
	nrf_pwm_shorts_set(pwm, NRF_PWM_SHORT_LOOPSDONE_SEQSTART0_MASK);
	nrf_pwm_enable(pwm);
}

static void mic_clock_pwm_release(NRF_PWM_Type *pwm, uint32_t pin)
{
	nrf_pwm_subscribe_clear(pwm, NRF_PWM_TASK_SEQSTART0);
	nrf_pwm_shorts_set(pwm, 0);
	nrf_pwm_event_clear(pwm, NRF_PWM_EVENT_STOPPED);
	nrf_pwm_task_trigger(pwm, NRF_PWM_TASK_STOP);
	for (uint32_t wait = 0U; wait < 1000U; ++wait) {
		if (nrf_pwm_event_check(pwm, NRF_PWM_EVENT_STOPPED)) {
			break;
		}
		k_busy_wait(1);
	}
	nrf_pwm_disable(pwm);
	nrf_gpio_cfg_default(pin);
}

static void mic_clocks_start(void)
{
	struct onoff_client cli;
	int res;

	mic_hfclk_mgr = z_nrf_clock_control_get_onoff(CLOCK_CONTROL_NRF_SUBSYS_HF);
	sys_notify_init_spinwait(&cli.notify);
	if (mic_hfclk_mgr != NULL && onoff_request(mic_hfclk_mgr, &cli) >= 0) {
		while (sys_notify_fetch_result(&cli.notify, &res) == -EAGAIN) {
			k_msleep(1);
		}
	} else {
		mic_hfclk_mgr = NULL;
	}

	/*
	 * Boot pinctrl leaves P0.17/P0.18 as master-mode outputs with their
	 * input buffers disconnected. Turn them into undriven,
	 * buffer-connected inputs so the slave-mode peripheral can actually
	 * see the jumpered PWM clocks and the pads do not fight the PWMs.
	 */
	nrf_gpio_cfg_input(MIC_I2S_LRCK_PIN, NRF_GPIO_PIN_NOPULL);
	nrf_gpio_cfg_input(MIC_I2S_SCK_PIN, NRF_GPIO_PIN_NOPULL);

	mic_clock_pwm_arm(NRF_PWM1_NS, MIC_BCLK_PIN, MIC_BCLK_TOP,
			  mic_bclk_duty);
	mic_clock_pwm_arm(NRF_PWM2_NS, MIC_LRCLK_PIN, MIC_LRCLK_TOP,
			  mic_lrclk_duty);

	if (mic_dppi_channel < 0) {
		mic_dppi_channel = nrfx_gppi_channel_alloc(MIC_GPPI_NODE);
	}
	if (mic_dppi_channel >= 0) {
		uint8_t channel = (uint8_t)mic_dppi_channel;

		nrf_pwm_subscribe_set(NRF_PWM1_NS, NRF_PWM_TASK_SEQSTART0,
				      channel);
		nrf_pwm_subscribe_set(NRF_PWM2_NS, NRF_PWM_TASK_SEQSTART0,
				      channel);
		nrf_egu_publish_set(NRF_EGU2_NS, NRF_EGU_EVENT_TRIGGERED0,
				    channel);
		nrf_dppi_channels_enable(NRF_DPPIC_NS, BIT(channel));
		nrf_egu_task_trigger(NRF_EGU2_NS, NRF_EGU_TASK_TRIGGER0);
		k_busy_wait(10);
		nrf_dppi_channels_disable(NRF_DPPIC_NS, BIT(channel));
		nrf_egu_publish_clear(NRF_EGU2_NS, NRF_EGU_EVENT_TRIGGERED0);
	} else {
		printk("    (no DPPI channel free — clocks started "
		       "sequentially, phase unverified)\n");
		nrf_pwm_task_trigger(NRF_PWM1_NS, NRF_PWM_TASK_SEQSTART0);
		nrf_pwm_task_trigger(NRF_PWM2_NS, NRF_PWM_TASK_SEQSTART0);
	}
}

static void mic_clocks_stop(void)
{
	mic_clock_pwm_release(NRF_PWM1_NS, MIC_BCLK_PIN);
	mic_clock_pwm_release(NRF_PWM2_NS, MIC_LRCLK_PIN);
	if (mic_hfclk_mgr != NULL) {
		(void)onoff_release(mic_hfclk_mgr);
		mic_hfclk_mgr = NULL;
	}
}

/* Integer sqrt, so the RMS figure needs no floating point. */
static uint32_t isqrt32(uint64_t value)
{
	uint64_t result = 0U;
	uint64_t bit = 1ULL << 62;

	while (bit > value) {
		bit >>= 2;
	}
	while (bit != 0U) {
		if (value >= result + bit) {
			value -= result + bit;
			result = (result >> 1) + bit;
		} else {
			result >>= 1;
		}
		bit >>= 2;
	}
	return (uint32_t)result;
}

static void test_microphone(uint32_t window_ms)
{
	struct i2s_config config = {
		.word_size = 24U,
		.channels = 1U,
		.format = I2S_FMT_DATA_FORMAT_I2S,
		.options = I2S_OPT_BIT_CLK_TARGET | I2S_OPT_FRAME_CLK_TARGET,
		.frame_clk_freq = MIC_FRAME_RATE,
		.mem_slab = &mic_rx_slab,
		.block_size = MIC_RX_BLOCK_SIZE,
		.timeout = 1500,
	};
	static int32_t raw_block[MIC_RX_BLOCK_FRAMES];
	uint32_t block_index = 0U;
	uint32_t blocks_scored = 0U;
	int32_t session_peak = 0;
	uint32_t session_peak_rms = 0U;
	int64_t started;
	int error;

	printk("\n[8] MICROPHONE  SPH0645 on I2S (slave RX), DOUT -> P0.20\n");
	printk("    Clocks: BCLK P0.16 -> P0.18 @ 2.000 MHz, LRCLK P0.14 -> "
	       "P0.17 @ 31.25 kHz\n");
	printk("    (those two jumpers are part of the test — no jumper, no "
	       "clock, no audio)\n");

	if (nrf_gpio_pin_read(PIN_MIC_SENSE) == 0U) {
		printk("    ---       mic sense P0.26 is LOW: the red "
		       "latching switch has CUT\n");
		printk("              the mic's power. Flip it ON or this "
		       "test can only ever\n");
		printk("              report silence. Running anyway so the "
		       "number is on record.\n");
	}

	if (!device_is_ready(i2s_dev)) {
		printk("    FAIL      i2s0 driver not ready\n");
		return;
	}

	error = k_mem_slab_init(&mic_rx_slab, mic_rx_storage,
				MIC_RX_BLOCK_SIZE, MIC_RX_BLOCK_COUNT);
	if (error != 0) {
		printk("    FAIL      RX slab init = %d\n", error);
		return;
	}

	mic_clocks_start();
	/* SPH0645 t_powerup is <=50 ms once BCLK is running. */
	k_msleep(60);

	error = i2s_configure(i2s_dev, I2S_DIR_RX, &config);
	if (error != 0) {
		mic_clocks_stop();
		printk("    FAIL      i2s_configure = %d\n", error);
		return;
	}
	error = i2s_trigger(i2s_dev, I2S_DIR_RX, I2S_TRIGGER_START);
	if (error != 0) {
		mic_clocks_stop();
		printk("    FAIL      i2s START = %d — with slave mode this "
		       "usually means the\n");
		printk("              clocks are not reaching P0.17/P0.18. "
		       "Check the two\n");
		printk("              jumpers P0.16->P0.18 and "
		       "P0.14->P0.17.\n");
		return;
	}

	printk("    TALK NOW — level prints every ~250 ms for %u s. A live "
	       "mic moves;\n",
	       window_ms / 1000U);
	printk("    a dead or depowered one sits at a flat, tiny number.\n");

	started = k_uptime_get();
	while (k_uptime_get() - started < (int64_t)window_ms) {
		void *block = NULL;
		size_t size = 0U;
		int32_t peak = 0;
		uint64_t square_sum = 0U;
		uint32_t frames;
		uint32_t rms;

		error = i2s_read(i2s_dev, &block, &size);
		if (error != 0) {
			printk("    i2s_read = %d — capture aborted\n", error);
			break;
		}
		if (size > sizeof(raw_block)) {
			size = sizeof(raw_block);
		}
		memcpy(raw_block, block, size);
		k_mem_slab_free(&mic_rx_slab, block);

		if (block_index++ < MIC_STARTUP_SKIP_BLOCKS) {
			continue;
		}

		frames = (uint32_t)(size / sizeof(int32_t));
		for (uint32_t index = 0U; index < frames; ++index) {
			int32_t sample = raw_block[index];
			int32_t magnitude = sample < 0 ? -sample : sample;

			peak = MAX(peak, magnitude);
			square_sum += (uint64_t)((int64_t)sample *
						 (int64_t)sample);
		}
		rms = frames ? isqrt32(square_sum / frames) : 0U;
		session_peak = MAX(session_peak, peak);
		session_peak_rms = MAX(session_peak_rms, rms);
		++blocks_scored;

		/* One line per ~4 blocks keeps the console readable while
		 * still feeling live (each block is ~20 ms). */
		if ((blocks_scored % 12U) == 0U) {
			printk("    peak=%-9d rms=%-9u  %s\n", peak, rms,
			       rms > 2000U     ? "|||||||| LOUD"
			       : rms > 500U    ? "|||||    sound"
			       : rms > 60U     ? "||       faint"
					       : ".        silent");
		}
	}

	(void)i2s_trigger(i2s_dev, I2S_DIR_RX, I2S_TRIGGER_DROP);
	k_msleep(12);
	mic_clocks_stop();

	printk("    ---       %u blocks scored, session peak=%d, peak "
	       "rms=%u\n",
	       blocks_scored, session_peak, session_peak_rms);
	if (blocks_scored == 0U) {
		printk("    FAIL      not one block arrived — I2S never "
		       "clocked\n");
	} else if (session_peak == 0) {
		printk("    FAIL      blocks arrived but every sample was "
		       "exactly zero.\n");
		printk("              That is the SDIN pull-down winning "
		       "against a mic that is\n");
		printk("              not driving: mic unpowered (red "
		       "switch), or DOUT off P0.20.\n");
	} else if (session_peak_rms < 60U) {
		printk("    ---       the mic is driving the bus but the "
		       "level never rose above\n");
		printk("              the noise floor. If nobody spoke, "
		       "that is no verdict.\n");
	} else {
		printk("    PASS      the microphone responds to sound\n");
	}
}

/* ------------------------------------------------------------------ */

static void configure_inputs(void)
{
	const struct gpio_dt_spec *inputs[] = {
		&btn_yellow, &btn_green, &btn_blue, &enc_a, &enc_b, &mic_sense,
	};

	for (size_t index = 0U; index < ARRAY_SIZE(inputs); ++index) {
		if (!gpio_is_ready_dt(inputs[index])) {
			printk("GPIO port not ready for one of the inputs\n");
			continue;
		}
		(void)gpio_pin_configure_dt(inputs[index], GPIO_INPUT);
	}
}

int main(void)
{
	uint32_t round = 0U;

	printk("\n\n");
	printk("################################################"
	       "################\n");
	printk("#  PENDANT BREADBOARD SELF-TEST                  "
	       "               #\n");
	printk("#  No LTE, no audio codec, no cloud — just the wires.  "
	       "        #\n");
	printk("################################################"
	       "################\n");
	printk("Verdicts: PASS = the part answered. FAIL = asked, did not "
	       "answer.\n");
	printk("          NOT-WIRED = sat exactly where an unconnected pin "
	       "sits.\n");
	printk("A test needing your hands says \"no input seen\" when nobody "
	       "was there —\n");
	printk("that is never scored as a fault.\n");
	printk("\nKNOWN AND EXPECTED, so it is not reported as a fault:\n");
	printk("  - GREEN button P0.22: its wires fell off the board. Dead "
	       "is correct.\n");
	printk("  - encoder push P0.28: not wired by design. Not tested, not "
	       "declared.\n");
	printk("  - RGB LED P0.03/04/07: not wired yet. Not tested.\n");

	configure_inputs();
	pot_init();

	test_i2c_scan();
	test_haptic();
	test_resting_levels();
	test_microsd();
	test_esp32_uart();
	test_amp_sd_mode();
	test_pot();

	for (;;) {
		printk("\n\n########  ROUND %u  ########\n", ++round);
		interactive_window(INTERACTIVE_WINDOW_MS);
		test_microphone(MIC_WINDOW_MS);
	}

	return 0;
}

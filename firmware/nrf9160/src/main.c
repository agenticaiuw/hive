#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/drivers/gpio.h>
#include <zephyr/drivers/i2s.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>
#include <zephyr/drivers/clock_control/nrf_clock_control.h>
#include <zephyr/sys/onoff.h>
#include <hal/nrf_gpio.h>
#include <hal/nrf_pwm.h>
#include <hal/nrf_egu.h>
#include <hal/nrf_dppi.h>
#include <helpers/nrfx_gppi.h>
#include <ff.h>

#include "audio_opus.h"
#include "pcm_tx_ring.h"
#include "pendant_cloud.h"

#define LED_NODE DT_ALIAS(led0)
#define BUTTON_NODE DT_ALIAS(sw0)
#define I2S_NODE DT_NODELABEL(i2s0)

/*
 * Adafruit SPH0645LM4H I2S microphone capture.
 *
 * The SPH0645 requires BCLK between 1.024 and 4.096 MHz with LRCLK at
 * exactly BCLK/64.  The nRF9160 I2S peripheral cannot produce a 64-BCLK
 * frame as master (its 24-bit maximum word size yields 48 BCLK), so the
 * capture path instead runs I2S in slave mode and generates both clocks
 * with PWM peripherals driven from the shared 16 MHz PCLK16M:
 *
 *   BCLK  = 16 MHz / 8   = 2.000 MHz on P0.16 (A2), jumpered to P0.18
 *   LRCLK = 16 MHz / 512 = 31.25 kHz on P0.14 (A0), jumpered to P0.17
 *
 * Both PWMs start in the same clock cycle through one DPPI channel, so
 * LRCLK edges always land on BCLK falling edges as I2S requires.  The
 * mic (SEL grounded) drives the left slot; each RX word arrives as one
 * right-aligned, sign-extended 24-bit sample with 18 significant bits.
 * Adjacent frames are averaged down to a 15,625 Hz mono upload stream.
 */
#define MIC_BCLK_PIN 16U
#define MIC_LRCLK_PIN 14U
#define MIC_DATA_PIN 20U
/* Bus-side I2S clock pins, jumpered to the PWM outputs above. */
#define MIC_I2S_LRCK_PIN 17U
#define MIC_I2S_SCK_PIN 18U
#define MIC_BCLK_TOP 8U
#define MIC_LRCLK_TOP 512U
#define MIC_FRAME_RATE 31250U
#define MIC_DECIMATION 2U
#define SAMPLE_RATE (MIC_FRAME_RATE / MIC_DECIMATION)

#define MIC_RX_BLOCK_FRAMES 640U
#define MIC_RX_BLOCK_SIZE (MIC_RX_BLOCK_FRAMES * sizeof(int32_t))
/*
 * RX slab is dedicated so the 30 KiB Opus workspace can hold the live encoder
 * while the user is speaking. Six blocks provide about 123 ms total buffering;
 * the live-codec budget below reserves two blocks so PCM capture cannot be
 * killed by an encoder that is slower than real time.
 */
#define MIC_RX_BLOCK_COUNT 6U
#define MIC_OUT_BLOCK_FRAMES (MIC_RX_BLOCK_FRAMES / MIC_DECIMATION)
#define MIC_STAGE_FRAMES 512U
#define MIC_STAGE_BYTES (MIC_STAGE_FRAMES * sizeof(int16_t))
/* Reuse Opus workspace as SPSC TX ring during capture (~30 KiB ≈ 1 s PCM). */
#define PCM_TX_RING_SLOTS \
	(PENDANT_OPUS_WORKSPACE_BYTES / MIC_STAGE_BYTES)
/* Max LTE work per capture block so I2S DMA never starves. */
/* Slightly more LTE work per I2S block to keep the ring drained. */
#define PCM_TX_PUMP_BUDGET_MS 5U
#define PCM_TX_DRAIN_BUDGET_MS 12U
#define MAX_RECORD_SECONDS 30U
#define MAX_RECORD_SAMPLE_COUNT (SAMPLE_RATE * MAX_RECORD_SECONDS)
#define AUTORECORD_TEST_SECONDS 5U
#define AUTORECORD_TEST_SAMPLE_COUNT \
	(SAMPLE_RATE * AUTORECORD_TEST_SECONDS)
/* SPH0645 t_powerup is ≤50 ms once BCLK runs; only remainder is slept. */
#define MIC_POWERUP_BUDGET_MS 50
/* Discard the first RX block: slave sync and DMA-start artifacts. */
#define MIC_STARTUP_SKIP_BLOCKS 1U
/* Keep clocks alive briefly after DROP so I2S can reach STOPPED. */
#define MIC_STOP_SETTLE_MS 12
#define MIC_MIN_RECORD_FRAMES SAMPLE_RATE
/* One-pole DC blocker, y[n] = x[n] - x[n-1] + a*y[n-1], a = 0.995. */
#define MIC_HPF_COEFF_Q15 32604
/* Digital gain standing in for the PDM peripheral's former +12 dB. */
#define MIC_GAIN 4
/*
 * The SPH0645 launches data on the rising BCLK edge instead of the
 * standard falling edge.  If captures come back doubled or wrapped, the
 * receiver latched one bit early: set this to 1 to halve each raw word.
 */
#define MIC_SAMPLE_SHIFT 0
/*
 * Impulse rejector: microSD SPI bursts can couple into the mic lines on
 * the breadboard and flip a high bit in isolated samples, which lands as
 * a full-scale click at the flush cadence.  Real audio from this mic
 * cannot slew more than a small fraction of full scale in one 32 us
 * sample, so clamp per-sample deltas in the raw 24-bit domain.  1/8 of
 * full scale per sample passes every legitimate signal untouched.
 */
#define MIC_SLEW_LIMIT (1 << 20)
#define MIC_RAW_PROBE_BITS 2048U
/* The DPPIC is node 0 of the generic PPI helper on this device. */
#define MIC_GPPI_NODE 0U

#define I2S_BLOCK_FRAMES 256U
#define I2S_CHANNEL_COUNT 2U
#define I2S_BLOCK_SIZE \
	(I2S_BLOCK_FRAMES * I2S_CHANNEL_COUNT * sizeof(int16_t))
/* Cut from 16 to free RAM for live Opus + dedicated mic RX. */
#define I2S_BLOCK_COUNT 4U
#define I2S_PREFILL_BLOCKS 3U
#define I2S_SYNC_PATTERN_BLOCKS 2U
#define I2S_SYNC_END_FRAMES 16U
#define I2S_STREAM_SYNC_A 0x2468
#define I2S_STREAM_SYNC_B 0x5A5A
#define I2S_STREAM_SYNC_END 0x6C6C

#define SD_MOUNT_POINT "/SD:"
#define SD_RECORDING_PATH SD_MOUNT_POINT "/latest.pcm"
#define SD_OPUS_PATH SD_MOUNT_POINT "/latest.opus"
#define SD_SELFTEST_PCM_PATH SD_MOUNT_POINT "/selftest.pcm"
#define SD_SELFTEST_OPUS_PATH SD_MOUNT_POINT "/selftest.opus"
#define SD_TEST_PATH SD_MOUNT_POINT "/power_test.bin"
#define SD_TEST_MAGIC 0x53445631U
#define SD_TEST_CHECK_XOR 0xA55A39C3U

/* Boot upload stresses encode+LTE at once; keep off for stable bring-up. */
#define PENDANT_BOOT_UPLOAD_EXISTING 0
/* Temporary diagnostic: record five seconds automatically before LTE init. */
#define PENDANT_BOOT_AUTORECORD_TEST 0
/* Temporary diagnostic: exercise one complete post-LTE voice cycle. */
#define PENDANT_BOOT_AUDIO_CYCLE_TEST 0
/*
 * Stack self-test: encode a synthetic strongly voiced tone at boot.
 *
 * The deepest libopus stack path is silk_pitch_analysis_core's stage-3
 * contour search, and its two 1920-byte VLAs sit behind the "a pitch
 * candidate was found" branch - a silent or noise-only recording returns
 * early and never touches them, so it cannot validate the stack budget.
 * A 125 Hz sawtooth is unambiguously voiced and forces that branch, which
 * makes the high-water number printed afterwards meaningful.  Needs no
 * microphone, no button and no network.  Leave at 0; set to 1 to re-measure
 * after touching CONFIG_MAIN_STACK_SIZE, the opus complexity setting, or
 * OPUS_FRAME_MS.
 *
 * Last measured on hardware: peak=25396 of 32768 bytes, 7372 free.
 */
#define PENDANT_BOOT_ENCODE_SELFTEST 0
#define SELFTEST_PITCH_PERIOD_SAMPLES 125U
#define SELFTEST_AMPLITUDE 9000
#define SELFTEST_SECONDS 3U
/* Temporary diagnostic: emit the saved raw PCM as delimited hex on USB. */
#define PENDANT_BOOT_DUMP_PCM_HEX 0
/* Temporary diagnostic: prove whether the microphone actively drives DOUT. */
#define PENDANT_MIC_ELECTRICAL_PROBE 0

static const struct gpio_dt_spec led =
	GPIO_DT_SPEC_GET(LED_NODE, gpios);
static const struct gpio_dt_spec button =
	GPIO_DT_SPEC_GET(BUTTON_NODE, gpios);
static struct gpio_callback button_callback;
static FATFS sd_fat_fs;
static struct fs_mount_t sd_mount = {
	.type = FS_FATFS,
	.mnt_point = SD_MOUNT_POINT,
	.fs_data = &sd_fat_fs,
	.flags = FS_MOUNT_FLAG_NO_FORMAT,
};

K_SEM_DEFINE(button_press_sem, 0, 1);

/*
 * Mic RX slab is dedicated. audio_workspace is the live PCM TX ring during
 * capture and the Opus decode workspace for reply playback.
 */
static struct k_mem_slab mic_rx_slab;
static uint8_t mic_rx_storage[MIC_RX_BLOCK_SIZE * MIC_RX_BLOCK_COUNT]
	__aligned(4);
static uint8_t audio_workspace[PENDANT_OPUS_WORKSPACE_BYTES] __aligned(4);
BUILD_ASSERT(sizeof(mic_rx_storage) ==
		     MIC_RX_BLOCK_SIZE * MIC_RX_BLOCK_COUNT,
	     "mic RX storage size mismatch");
BUILD_ASSERT(PCM_TX_RING_SLOTS >= 4U, "TX ring too small for live upload");
K_MEM_SLAB_DEFINE_STATIC(i2s_slab, I2S_BLOCK_SIZE, I2S_BLOCK_COUNT, 4);
/* Processed audio staged between microSD writes (~1 KiB stages). */
static int16_t mic_stage_samples[MIC_STAGE_FRAMES] __aligned(4);
static struct pcm_tx_ring live_tx_ring;
static bool live_stream_failed;

/*
 * Queue one PCM stage for LTE and drain the ring under a time budget.
 * Never blocks long enough to starve I2S: -EAGAIN means try next block.
 * On hard stream failure or ring overflow, abort live TX and keep SD capture.
 */
static void live_tx_offer_stage(const int16_t *samples, size_t frame_count)
{
	const size_t byte_count = frame_count * sizeof(int16_t);
	int error;

	if (live_stream_failed || !pendant_cloud_stream_active()) {
		return;
	}
	if (byte_count != MIC_STAGE_BYTES) {
		/* Final short stage: send directly if ring empty & no pending. */
		if (!pcm_tx_ring_empty(&live_tx_ring) ||
		    pendant_cloud_stream_has_pending()) {
			return;
		}
		error = pendant_cloud_stream_write(samples, byte_count);
		if (error == -EAGAIN) {
			return;
		}
		if (error != 0) {
			printk("Live TX short write failed: %d\n", error);
			pendant_cloud_stream_abort();
			live_stream_failed = true;
		}
		return;
	}

	if (!pcm_tx_ring_push(&live_tx_ring, samples, byte_count)) {
		printk("Live TX ring full; abort stream (no SD fallback)\n");
		pendant_cloud_stream_abort();
		live_stream_failed = true;
		pcm_tx_ring_reset(&live_tx_ring);
		return;
	}
}

static void live_tx_pump(uint32_t budget_ms)
{
	int64_t deadline;
	int error;

	if (live_stream_failed || !pendant_cloud_stream_active()) {
		return;
	}

	deadline = k_uptime_get() + (int64_t)budget_ms;
	while (k_uptime_get() < deadline) {
		if (pendant_cloud_stream_has_pending()) {
			error = pendant_cloud_stream_pump(1U);
			if (error == -EAGAIN) {
				return;
			}
			if (error != 0) {
				printk("Live TX pump failed: %d\n", error);
				pendant_cloud_stream_abort();
				live_stream_failed = true;
				pcm_tx_ring_reset(&live_tx_ring);
				return;
			}
			continue;
		}

		const uint8_t *slot = pcm_tx_ring_peek(&live_tx_ring);

		if (slot == NULL) {
			return;
		}
		error = pendant_cloud_stream_write(slot, MIC_STAGE_BYTES);
		if (error == -EAGAIN) {
			return;
		}
		if (error != 0) {
			printk("Live TX write failed: %d\n", error);
			pendant_cloud_stream_abort();
			live_stream_failed = true;
			pcm_tx_ring_reset(&live_tx_ring);
			return;
		}
		(void)pcm_tx_ring_pop(&live_tx_ring);
	}
}

/*
 * Main-thread stack high-water reporting.
 *
 * libopus is compiled with -DVAR_ARRAYS, so every codec scratch buffer is a
 * VLA on this thread's stack; the deepest one (silk_pitch_analysis_core)
 * previously ran the 24 KiB main stack off its PSPLIM guard mid-encode.  There
 * is no way to size the stack honestly without a real high-water number, so
 * report one after each encode.  CONFIG_INIT_STACKS fills the stack with 0xAA
 * at boot and costs no RAM; k_thread_stack_space_get() then counts the bytes
 * still untouched.
 */
static void report_main_stack_headroom(const char *phase)
{
#ifdef CONFIG_INIT_STACKS
	size_t unused = 0U;
	int error = k_thread_stack_space_get(k_current_get(), &unused);

	if (error != 0) {
		printk("Main stack usage (%s): unavailable (%d)\n", phase,
		       error);
		return;
	}
	printk("Main stack usage (%s): peak=%u free=%u size=%u\n", phase,
	       (unsigned int)(CONFIG_MAIN_STACK_SIZE - unused),
	       (unsigned int)unused, (unsigned int)CONFIG_MAIN_STACK_SIZE);
#else
	ARG_UNUSED(phase);
#endif
}

/* PWM duty words: bit 15 clear means the output is low first, so BCLK
 * rises mid-period (tick 4 of 8) while LRCLK edges (tick 0 mod 256) sit
 * on BCLK falling edges, and LRCLK starts low = left slot first.
 * Sequences must live in data RAM for EasyDMA.
 */
static uint16_t mic_bclk_duty[1] __aligned(4) = { MIC_BCLK_TOP / 2U };
static uint16_t mic_lrclk_duty[1] __aligned(4) = { MIC_LRCLK_TOP / 2U };
/* Held while the mic clocks run so PCLK16M is crystal-accurate. */
static struct onoff_manager *mic_hfclk_mgr;
/*
 * DPPI channel for phase-locked PWM starts, allocated through the
 * shared nrfx allocator.  Never hardcode one: the UART console's
 * enhanced poll-out already owns the topmost channel, and disabling
 * someone else's channel wedges that peripheral permanently.
 */
static int mic_dppi_channel = -1;

volatile int audio_cycle_result = -9999;
volatile uint8_t audio_cycle_phase;
volatile uint32_t recorded_samples;
volatile uint16_t recorded_peak;
volatile bool recording_stopped_by_button;
volatile bool sd_ready;
volatile bool recording_on_sd;
volatile int sd_mount_result = -9999;
volatile uint64_t recording_absolute_sum;
volatile bool sd_persistence_verified;
volatile uint32_t sd_boot_count;
volatile int sd_test_read_result = -9999;
volatile int sd_test_write_result = -9999;

static void button_pressed(const struct device *port,
			   struct gpio_callback *callback,
			   gpio_port_pins_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(callback);
	ARG_UNUSED(pins);
	k_sem_give(&button_press_sem);
}

static void clear_button_events(void)
{
	while (k_sem_take(&button_press_sem, K_NO_WAIT) == 0) {
	}
}

static void finish_button_press(void)
{
	/* gpio_pin_get_dt() returns the logical active state. */
	while (gpio_pin_get_dt(&button) > 0) {
		k_msleep(5);
	}
	k_msleep(15);
	clear_button_events();
}

static bool consume_button_event(void)
{
	if (k_sem_take(&button_press_sem, K_NO_WAIT) == 0) {
		finish_button_press();
		return true;
	}
	return false;
}

static void wait_for_button_press(void)
{
	/*
	 * Latency-first: start work on the active edge. Do not wait for the
	 * physical release — that used to add hundreds of ms before the mic
	 * even powered up.
	 */
	k_sem_take(&button_press_sem, K_FOREVER);
	clear_button_events();
}

static void flash_led(unsigned int count, int on_ms, int off_ms)
{
	for (unsigned int flash = 0U; flash < count; ++flash) {
		gpio_pin_set_dt(&led, 1);
		k_msleep(on_ms);
		gpio_pin_set_dt(&led, 0);
		k_msleep(off_ms);
	}
}

/*
 * Solid LED = first speech batch on device (may still be downloading more).
 * Never autoplay — button 1 starts I2S → ESP32 → Bose.
 */
void pendant_notify_reply_first_batch(void)
{
	gpio_pin_set_dt(&led, 1);
	printk("First speech batch ready — solid LED; press button 1 to play "
	       "(no autoplay; download may still be finishing)\n");
}

static void wait_for_reply_playback_press(void)
{
	/* LED may already be solid from pendant_notify_reply_first_batch(). */
	if (!pendant_cloud_reply_first_batch) {
		gpio_pin_set_dt(&led, 1);
		printk("Reply complete — solid LED; press button 1 to play "
		       "(no autoplay)\n");
	} else {
		printk("Waiting for play press (LED already solid from first "
		       "speech batch)\n");
	}
	wait_for_button_press();
}

static int mount_sd_card(void)
{
	int error = -EIO;

	for (unsigned int attempt = 0U; attempt < 5U; ++attempt) {
		error = fs_mount(&sd_mount);
		if (error == 0) {
			break;
		}
		k_msleep(200);
	}
	sd_mount_result = error;
	sd_ready = error == 0;
	return error;
}

static int dump_sd_recording_hex(void)
{
	static const char digits[] = "0123456789abcdef";
	struct fs_file_t file;
	uint8_t bytes[48];
	char line[sizeof(bytes) * 2U + 1U];
	uint32_t total = 0U;
	int error;

	fs_file_t_init(&file);
	error = fs_open(&file, SD_RECORDING_PATH, FS_O_READ);
	if (error != 0) {
		printk("PCM_HEX_ERROR open=%d\n", error);
		return error;
	}

	printk("PCM_HEX_BEGIN\n");
	while (true) {
		ssize_t count = fs_read(&file, bytes, sizeof(bytes));

		if (count < 0) {
			error = (int)count;
			break;
		}
		if (count == 0) {
			error = 0;
			break;
		}

		for (size_t index = 0U; index < (size_t)count; ++index) {
			line[index * 2U] = digits[bytes[index] >> 4];
			line[index * 2U + 1U] = digits[bytes[index] & 0x0fU];
		}
		line[(size_t)count * 2U] = '\0';
		printk("%s\n", line);
		total += (uint32_t)count;
		/*
		 * The 115200-baud DK virtual UART needs about 8.5 ms to carry
		 * one full 48-byte hex line.  Pace this diagnostic stream so
		 * the interface MCU cannot drop bytes while draining printk.
		 */
		k_msleep(12);
	}
	(void)fs_close(&file);
	printk("PCM_HEX_END bytes=%u error=%d\n", total, error);
	return error;
}

struct sd_test_record {
	uint32_t magic;
	uint32_t boot_count;
	uint32_t checksum;
};

static uint32_t sd_test_checksum(const struct sd_test_record *record)
{
	return record->magic ^ record->boot_count ^ SD_TEST_CHECK_XOR;
}

static uint32_t integer_square_root(uint64_t value)
{
	uint64_t result = 0U;
	uint64_t bit = (uint64_t)1U << 62;

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

static int test_sd_persistence(void)
{
	struct fs_file_t file;
	struct sd_test_record record = { 0 };
	int error;

	sd_persistence_verified = false;
	sd_boot_count = 0U;
	fs_file_t_init(&file);

	error = fs_open(&file, SD_TEST_PATH, FS_O_READ);
	sd_test_read_result = error;
	if (error == 0) {
		ssize_t bytes_read = fs_read(&file, &record, sizeof(record));

		sd_test_read_result = bytes_read == (ssize_t)sizeof(record)
			? 0 : (bytes_read < 0 ? (int)bytes_read : -EIO);
		(void)fs_close(&file);
		if (sd_test_read_result == 0 &&
		    record.magic == SD_TEST_MAGIC &&
		    record.checksum == sd_test_checksum(&record)) {
			sd_persistence_verified = true;
			sd_boot_count = record.boot_count;
		}
	}

	record.magic = SD_TEST_MAGIC;
	record.boot_count = sd_boot_count + 1U;
	record.checksum = sd_test_checksum(&record);

	fs_file_t_init(&file);
	error = fs_open(&file, SD_TEST_PATH,
			FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
	if (error == 0) {
		ssize_t written = fs_write(&file, &record, sizeof(record));

		error = written == (ssize_t)sizeof(record)
			? fs_sync(&file)
			: (written < 0 ? (int)written : -EIO);
		int close_error = fs_close(&file);
		if (error == 0) {
			error = close_error;
		}
	}

	sd_test_write_result = error;
	if (error == 0) {
		sd_boot_count = record.boot_count;
	}
	return error;
}

static int write_pcm_frames(struct fs_file_t *file,
			    const int16_t *samples,
			    size_t frame_count)
{
	const uint8_t *bytes = (const uint8_t *)samples;
	size_t bytes_remaining = frame_count * sizeof(int16_t);

	while (bytes_remaining > 0U) {
		ssize_t written = fs_write(file, bytes, bytes_remaining);

		if (written < 0) {
			return (int)written;
		}
		if (written == 0) {
			return -EIO;
		}
		bytes += (size_t)written;
		bytes_remaining -= (size_t)written;
	}

	return 0;
}

#if PENDANT_BOOT_ENCODE_SELFTEST
/*
 * Write SELFTEST_SECONDS of a 125 Hz bipolar sawtooth to the card, then run
 * the real encoder over it.  The sawtooth is periodic and harmonically rich,
 * so SILK classifies every frame as voiced and takes both the stage-3 pitch
 * contour search and the delayed-decision quantizer - the two deepest stack
 * consumers in the codec.  Staging reuses mic_stage_samples, which is idle
 * outside capture, so this costs no RAM.
 */
static int encode_stack_selftest(void)
{
	struct fs_file_t file;
	struct pendant_opus_stats stats = { 0 };
	const uint32_t total_samples = SAMPLE_RATE * SELFTEST_SECONDS;
	uint32_t written_samples = 0U;
	int error;

	fs_file_t_init(&file);
	error = fs_open(&file, SD_SELFTEST_PCM_PATH,
			FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
	if (error != 0) {
		printk("Selftest PCM open failed: %d\n", error);
		return error;
	}

	while (written_samples < total_samples) {
		size_t chunk = MIN((size_t)(total_samples - written_samples),
				   (size_t)MIC_STAGE_FRAMES);

		for (size_t index = 0U; index < chunk; ++index) {
			uint32_t phase = (written_samples + (uint32_t)index) %
					 SELFTEST_PITCH_PERIOD_SAMPLES;
			int32_t value =
				SELFTEST_AMPLITUDE -
				(int32_t)((2 * SELFTEST_AMPLITUDE * phase) /
					  SELFTEST_PITCH_PERIOD_SAMPLES);

			mic_stage_samples[index] = (int16_t)value;
		}
		error = write_pcm_frames(&file, mic_stage_samples, chunk);
		if (error != 0) {
			printk("Selftest PCM write failed: %d\n", error);
			(void)fs_close(&file);
			return error;
		}
		written_samples += (uint32_t)chunk;
	}
	error = fs_close(&file);
	if (error != 0) {
		printk("Selftest PCM close failed: %d\n", error);
		return error;
	}

	printk("ENCODE_SELFTEST_BEGIN samples=%u pitch_hz=%u\n",
	       total_samples, SAMPLE_RATE / SELFTEST_PITCH_PERIOD_SAMPLES);
	error = pendant_opus_encode_file(
		SD_SELFTEST_PCM_PATH, SD_SELFTEST_OPUS_PATH, SAMPLE_RATE,
		audio_workspace, sizeof(audio_workspace), &stats);
	printk("ENCODE_SELFTEST_END result=%d packets=%u in=%u out=%u\n",
	       error, stats.packets, stats.input_bytes, stats.output_bytes);
	report_main_stack_headroom("voiced selftest encode");
	return error;
}
#endif /* PENDANT_BOOT_ENCODE_SELFTEST */

/*
 * Configure one PWM instance as a free-running square wave: a single
 * duty value looped forever through the LOOPSDONE->SEQSTART0 shortcut.
 * The instance is armed but does not run until TASKS_SEQSTART[0] fires
 * over DPPI, so both clocks can start in the same PCLK16M cycle.
 */
static void mic_clock_pwm_arm(NRF_PWM_Type *pwm, uint32_t pin,
			      uint16_t countertop, const uint16_t *duty)
{
	nrf_gpio_pin_clear(pin);
	nrf_gpio_cfg_output(pin);

	uint32_t out_pins[NRF_PWM_CHANNEL_COUNT] = {
		pin, NRF_PWM_PIN_NOT_CONNECTED, NRF_PWM_PIN_NOT_CONNECTED,
		NRF_PWM_PIN_NOT_CONNECTED,
	};
	nrf_pwm_pins_set(pwm, out_pins);
	nrf_pwm_configure(pwm, NRF_PWM_CLK_16MHz, NRF_PWM_MODE_UP,
			  countertop);
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
	/* Leave the pin high-impedance so the nets can be driven by the
	 * I2S master during playback without contention.
	 */
	nrf_gpio_cfg_default(pin);
}

static void mic_clocks_start(void)
{
	struct onoff_client cli;
	int res;

	mic_hfclk_mgr =
		z_nrf_clock_control_get_onoff(CLOCK_CONTROL_NRF_SUBSYS_HF);
	sys_notify_init_spinwait(&cli.notify);
	if (mic_hfclk_mgr != NULL &&
	    onoff_request(mic_hfclk_mgr, &cli) >= 0) {
		while (sys_notify_fetch_result(&cli.notify, &res) ==
		       -EAGAIN) {
			k_msleep(1);
		}
	} else {
		mic_hfclk_mgr = NULL;
	}

	/*
	 * Boot pinctrl leaves P0.17/P0.18 as master-mode outputs with
	 * their input buffers disconnected, and the I2S driver never
	 * touches pins again.  Turn them into undriven, buffer-connected
	 * inputs so the slave-mode peripheral can see the jumpered PWM
	 * clocks and the pads do not fight the PWM outputs.
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
		/* No DPPI channel free: start sequentially.  The clocks
		 * stay frequency-locked either way; only the LRCLK-to-BCLK
		 * phase is then unverified.
		 */
		printk("MIC clock warning: no DPPI channel, sequential "
		       "start\n");
		nrf_pwm_task_trigger(NRF_PWM1_NS, NRF_PWM_TASK_SEQSTART0);
		nrf_pwm_task_trigger(NRF_PWM2_NS, NRF_PWM_TASK_SEQSTART0);
	}
}

static void mic_clocks_stop(void)
{
	mic_clock_pwm_release(NRF_PWM1_NS, MIC_BCLK_PIN);
	mic_clock_pwm_release(NRF_PWM2_NS, MIC_LRCLK_PIN);

	/* Restore the boot pinctrl's master-mode state (output low,
	 * input buffer disconnected) so I2S playback drives the bus
	 * exactly as before.
	 */
	nrf_gpio_pin_clear(MIC_I2S_LRCK_PIN);
	nrf_gpio_cfg_output(MIC_I2S_LRCK_PIN);
	nrf_gpio_pin_clear(MIC_I2S_SCK_PIN);
	nrf_gpio_cfg_output(MIC_I2S_SCK_PIN);

	if (mic_hfclk_mgr != NULL) {
		(void)onoff_release(mic_hfclk_mgr);
		mic_hfclk_mgr = NULL;
	}
}

#if PENDANT_MIC_ELECTRICAL_PROBE
static void probe_mic_data_pull(const char *label, nrf_gpio_pin_pull_t pull)
{
	uint32_t ones = 0U;
	uint32_t transitions = 0U;
	uint32_t previous = 0U;

	nrf_gpio_cfg_input(MIC_DATA_PIN, pull);
	k_busy_wait(50);

	for (uint32_t captured = 0U; captured < MIC_RAW_PROBE_BITS;
	     ++captured) {
		uint32_t bit = nrf_gpio_pin_read(MIC_DATA_PIN);

		ones += bit;
		if (captured > 0U && bit != previous) {
			++transitions;
		}
		previous = bit;
		k_busy_wait(2);
	}

	printk("MIC DOUT electrical probe: pull=%s bits=%u ones=%u "
	       "transitions=%u\n",
	       label, MIC_RAW_PROBE_BITS, ones, transitions);
}

/* Run with the PWM clocks live, before I2S RX claims the data pin. */
static void probe_mic_data_driver(void)
{
	probe_mic_data_pull("none", NRF_GPIO_PIN_NOPULL);
	probe_mic_data_pull("up", NRF_GPIO_PIN_PULLUP);
	probe_mic_data_pull("down", NRF_GPIO_PIN_PULLDOWN);
	nrf_gpio_cfg_input(MIC_DATA_PIN, NRF_GPIO_PIN_NOPULL);
}
#endif

static int record_microphone(const struct device *i2s, size_t sample_limit)
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
	const size_t effective_sample_limit = sample_limit;
	size_t sample_index = 0U;
	size_t stage_frames = 0U;
	uint32_t stage_flush_count = 0U;
	size_t next_trace_sample = SAMPLE_RATE;
	size_t block_index = 0U;
	uint64_t square_sum = 0U;
	/* Copy each completed DMA block here and return its slab immediately. */
	int32_t raw_processing[MIC_RX_BLOCK_FRAMES];
	uint32_t zero_crossings = 0U;
	int16_t minimum_sample = INT16_MAX;
	int16_t maximum_sample = INT16_MIN;
	int16_t previous_sample = 0;
	bool have_previous_sample = false;
	int32_t hpf_prev_in = 0;
	int32_t hpf_prev_out = 0;
	bool hpf_primed = false;
	int32_t slew_prev = 0;
	bool slew_primed = false;
	int64_t clocks_started_at;
	int64_t settle_elapsed;
	int64_t next_led_toggle;
	int error;

	/*
	 * Latency path: live LTE only. No microSD write during capture and no
	 * SD-file upload fallback. Prewarm TLS while idle; press = mic + ring.
	 */
	recording_on_sd = false;
	live_stream_failed = false;
	pcm_tx_ring_init(&live_tx_ring, audio_workspace, MIC_STAGE_BYTES,
			 PCM_TX_RING_SLOTS);
	if (sample_limit == 0U) {
		return -ENODEV;
	}
	if (!pendant_cloud_stream_active()) {
		printk("Live stream not prewarmed — refuse record (no SD fallback)\n");
		return -ENOTCONN;
	}
	error = k_mem_slab_init(&mic_rx_slab, mic_rx_storage,
				MIC_RX_BLOCK_SIZE, MIC_RX_BLOCK_COUNT);
	if (error != 0) {
		return error;
	}

	/* Button press = record NOW. LED + mic; LTE drains ring between I2S. */
	gpio_pin_set_dt(&led, 1);
	next_led_toggle = k_uptime_get() + 250;
	mic_clocks_start();
	clocks_started_at = k_uptime_get();

	recorded_samples = 0U;
	recorded_peak = 0U;
	recording_absolute_sum = 0U;
	recording_stopped_by_button = false;

	error = i2s_configure(i2s, I2S_DIR_RX, &config);
	if (error != 0) {
		mic_clocks_stop();
		gpio_pin_set_dt(&led, 0);
		return error;
	}

	settle_elapsed = k_uptime_get() - clocks_started_at;
	if (settle_elapsed < MIC_POWERUP_BUDGET_MS) {
		k_msleep(MIC_POWERUP_BUDGET_MS - (int32_t)settle_elapsed);
	}
#if PENDANT_MIC_ELECTRICAL_PROBE
	probe_mic_data_driver();
#endif
	printk("I2S mic record: bclk_hz=%u lrclk_hz=%u pcm_rate_hz=%u "
	       "live_stream=%d ring_slots=%u\n",
	       16000000U / MIC_BCLK_TOP, 16000000U / MIC_LRCLK_TOP,
	       SAMPLE_RATE, pendant_cloud_stream_active() ? 1 : 0,
	       (unsigned int)PCM_TX_RING_SLOTS);

	error = i2s_trigger(i2s, I2S_DIR_RX, I2S_TRIGGER_START);
	if (error != 0) {
		mic_clocks_stop();
		gpio_pin_set_dt(&led, 0);
		return error;
	}

	printk("I2S mic live: sample_limit=%u\n",
	       (uint32_t)effective_sample_limit);

	while (sample_index < effective_sample_limit) {
		void *block;
		size_t size;

		error = i2s_read(i2s, &block, &size);
		if (error != 0) {
			printk("I2S mic read failed: samples=%u error=%d\n",
			       (uint32_t)sample_index, error);
			(void)i2s_trigger(i2s, I2S_DIR_RX, I2S_TRIGGER_DROP);
			k_msleep(MIC_STOP_SETTLE_MS);
			mic_clocks_stop();
			return error;
		}

		if (size > sizeof(raw_processing) ||
		    (size % sizeof(raw_processing[0])) != 0U) {
			k_mem_slab_free(&mic_rx_slab, block);
			printk("I2S mic invalid RX block: bytes=%u capacity=%u\n",
			       (uint32_t)size, (uint32_t)sizeof(raw_processing));
			(void)i2s_trigger(i2s, I2S_DIR_RX, I2S_TRIGGER_DROP);
			k_msleep(MIC_STOP_SETTLE_MS);
			mic_clocks_stop();
			return -EMSGSIZE;
		}
		memcpy(raw_processing, block, size);
		k_mem_slab_free(&mic_rx_slab, block);

		int32_t *raw = raw_processing;
		size_t raw_frames = size / sizeof(int32_t);

		if (block_index == 0U) {
			int32_t raw_min = INT32_MAX;
			int32_t raw_max = INT32_MIN;

			for (size_t index = 0U; index < raw_frames; ++index) {
				raw_min = MIN(raw_min, raw[index]);
				raw_max = MAX(raw_max, raw[index]);
			}
			printk("I2S mic raw block0: words=%u min=%d max=%d\n",
			       (uint32_t)raw_frames, raw_min, raw_max);
		}

		if (block_index < MIC_STARTUP_SKIP_BLOCKS) {
			++block_index;
			clear_button_events();
			continue;
		}
		++block_index;

		size_t out_frames = raw_frames / MIC_DECIMATION;

		out_frames = MIN(out_frames,
				 effective_sample_limit - sample_index);

		for (size_t frame = 0U; frame < out_frames; ++frame) {
			/*
			 * Each RX word is a right-aligned, sign-extended
			 * 24-bit sample; the SPH0645's 18 significant bits
			 * occupy the top of that window.  Average adjacent
			 * frames (crude low-pass) while halving the rate,
			 * then scale 24-bit down to 16-bit.
			 */
			int32_t first =
				raw[frame * MIC_DECIMATION] >> MIC_SAMPLE_SHIFT;
			int32_t second =
				raw[frame * MIC_DECIMATION + 1U] >>
				MIC_SAMPLE_SHIFT;

			if (!slew_primed) {
				slew_prev = first;
				slew_primed = true;
			}
			int32_t delta = first - slew_prev;

			delta = CLAMP(delta, -MIC_SLEW_LIMIT, MIC_SLEW_LIMIT);
			slew_prev += delta;
			first = slew_prev;
			delta = second - slew_prev;
			delta = CLAMP(delta, -MIC_SLEW_LIMIT, MIC_SLEW_LIMIT);
			slew_prev += delta;
			second = slew_prev;

			int32_t sample = ((first + second) / 2) >> 8;

			/* DC blocker: the SPH0645 sits about 5% off center. */
			if (!hpf_primed) {
				hpf_prev_in = sample;
				hpf_primed = true;
			}
			int32_t filtered = sample - hpf_prev_in +
				(int32_t)(((int64_t)MIC_HPF_COEFF_Q15 *
					   hpf_prev_out) >> 15);
			hpf_prev_in = sample;
			hpf_prev_out = filtered;

			int32_t amplified = filtered * MIC_GAIN;

			amplified = CLAMP(amplified, INT16_MIN, INT16_MAX);

			int32_t absolute =
				amplified < 0 ? -amplified : amplified;

			mic_stage_samples[stage_frames] = (int16_t)amplified;
			if (++stage_frames == MIC_STAGE_FRAMES) {
				/* Live LTE only — never gate stream on microSD. */
				live_tx_offer_stage(mic_stage_samples,
						    MIC_STAGE_FRAMES);
				stage_frames = 0U;
				++stage_flush_count;
				if (live_stream_failed) {
					break;
				}
			}
			minimum_sample = MIN(minimum_sample,
					     (int16_t)amplified);
			maximum_sample = MAX(maximum_sample,
					     (int16_t)amplified);
			square_sum += (uint64_t)((int64_t)amplified *
						 amplified);
			if (have_previous_sample &&
			    ((previous_sample < 0 && amplified >= 0) ||
			     (previous_sample >= 0 && amplified < 0))) {
				++zero_crossings;
			}
			previous_sample = (int16_t)amplified;
			have_previous_sample = true;
			recorded_peak = MAX(recorded_peak,
					    (uint16_t)MIN(absolute,
							  UINT16_MAX));
			recording_absolute_sum += (uint32_t)absolute;

			++sample_index;
		}

		recorded_samples = sample_index;
		if (live_stream_failed) {
			printk("I2S mic live LTE stream failed mid-capture\n");
			(void)i2s_trigger(i2s, I2S_DIR_RX, I2S_TRIGGER_DROP);
			k_msleep(MIC_STOP_SETTLE_MS);
			mic_clocks_stop();
			return -EIO;
		}

		/* Spend a few free ms pushing PCM over LTE between DMA blocks. */
		live_tx_pump(PCM_TX_PUMP_BUDGET_MS);

		if (sample_index >= next_trace_sample) {
			next_trace_sample += SAMPLE_RATE;
		}

		if (k_uptime_get() >= next_led_toggle) {
			gpio_pin_toggle_dt(&led);
			next_led_toggle = k_uptime_get() + 250;
		}

		/*
		 * Ignore bounce / leftover edges from the start press for the
		 * first second, then a second press stops recording.
		 */
		if (sample_index < MIC_MIN_RECORD_FRAMES) {
			clear_button_events();
		} else if (k_sem_take(&button_press_sem, K_NO_WAIT) == 0) {
			recording_stopped_by_button = true;
			break;
		}
	}

	error = i2s_trigger(i2s, I2S_DIR_RX, I2S_TRIGGER_DROP);
	k_msleep(MIC_STOP_SETTLE_MS);
	mic_clocks_stop();
	if (recording_stopped_by_button) {
		finish_button_press();
	}

	if (stage_frames > 0U) {
		/* Pad last stream slot so the fixed-size ring accepts it. */
		while (stage_frames < MIC_STAGE_FRAMES) {
			mic_stage_samples[stage_frames++] = 0;
		}
		live_tx_offer_stage(mic_stage_samples, MIC_STAGE_FRAMES);
	}
	/* Drain remaining ring slots after capture (still budgeted). */
	{
		int64_t drain_until = k_uptime_get() + 2000;

		while ((!pcm_tx_ring_empty(&live_tx_ring) ||
			pendant_cloud_stream_has_pending()) &&
		       pendant_cloud_stream_active() && !live_stream_failed &&
		       k_uptime_get() < drain_until) {
			live_tx_pump(PCM_TX_DRAIN_BUDGET_MS);
		}
		if ((!pcm_tx_ring_empty(&live_tx_ring) ||
		     pendant_cloud_stream_has_pending()) ||
		    live_stream_failed || !pendant_cloud_stream_active()) {
			printk("Live TX incomplete — no SD fallback\n");
			pendant_cloud_stream_abort();
			live_stream_failed = true;
			pcm_tx_ring_reset(&live_tx_ring);
			error = -EIO;
		}
	}

	uint32_t rms = recorded_samples == 0U
		? 0U
		: integer_square_root(square_sum / recorded_samples);
	printk("I2S mic capture totals: samples=%u mean=%u peak=%u rms=%u "
	       "min=%d max=%d zero_crossings=%u stages=%u "
	       "live_sent=%u ring_push=%u ring_pop=%u ring_ovf=%u "
	       "stream_failed=%d\n",
	       recorded_samples,
	       recorded_samples == 0U
		       ? 0U
		       : (uint32_t)(recording_absolute_sum /
				    recorded_samples),
	       recorded_peak, rms, minimum_sample, maximum_sample,
	       zero_crossings, stage_flush_count,
	       pendant_cloud_stream_bytes_sent(), live_tx_ring.pushes,
	       live_tx_ring.pops, live_tx_ring.overflows,
	       live_stream_failed ? 1 : 0);
	return error;
}

static int queue_i2s_stream_preamble(const struct device *i2s)
{
	for (uint32_t block_index = 0U;
	     block_index < I2S_SYNC_PATTERN_BLOCKS + 1U; ++block_index) {
		void *block;
		int16_t *output;
		int error = k_mem_slab_alloc(&i2s_slab, &block, K_FOREVER);

		if (error != 0) {
			return error;
		}
		output = block;

		for (uint32_t frame = 0U; frame < I2S_BLOCK_FRAMES; ++frame) {
			int16_t sample = 0;

			if (block_index < I2S_SYNC_PATTERN_BLOCKS) {
				uint32_t absolute_frame =
					block_index * I2S_BLOCK_FRAMES + frame;

				sample = (absolute_frame & 1U) != 0U
					 ? I2S_STREAM_SYNC_B
					 : I2S_STREAM_SYNC_A;
			} else if (frame < I2S_SYNC_END_FRAMES) {
				sample = I2S_STREAM_SYNC_END;
			}

			output[2U * frame] = sample;
			output[2U * frame + 1U] = sample;
		}

		error = i2s_write(i2s, block, I2S_BLOCK_SIZE);
		if (error != 0) {
			k_mem_slab_free(&i2s_slab, block);
			return error;
		}
	}

	return 0;
}

static int play_agent_reply(const struct device *i2s,
			    const char *pcm_path)
{
	struct i2s_config config = {
		.word_size = 16U,
		.channels = I2S_CHANNEL_COUNT,
		.format = I2S_FMT_DATA_FORMAT_I2S,
		.options = I2S_OPT_FRAME_CLK_CONTROLLER |
			   I2S_OPT_BIT_CLK_CONTROLLER,
		.frame_clk_freq = PENDANT_CLOUD_REPLY_SAMPLE_RATE,
		.mem_slab = &i2s_slab,
		.block_size = I2S_BLOCK_SIZE,
		.timeout = 3000,
	};
	struct fs_file_t file;
	struct fs_dirent entry;
	int16_t mono[I2S_BLOCK_FRAMES];
	uint32_t queued_blocks = I2S_SYNC_PATTERN_BLOCKS + 1U;
	uint32_t played_samples = 0U;
	bool started = false;
	bool file_open = false;
	int error;

	error = fs_stat(pcm_path, &entry);
	if (error != 0 || entry.type != FS_DIR_ENTRY_FILE ||
	    entry.size == 0U || (entry.size & 1U) != 0U) {
		return error != 0 ? error : -EBADMSG;
	}

	fs_file_t_init(&file);
	error = fs_open(&file, pcm_path, FS_O_READ);
	if (error != 0) {
		return error;
	}
	file_open = true;

	error = i2s_configure(i2s, I2S_DIR_TX, &config);
	if (error != 0) {
		goto out;
	}
	error = queue_i2s_stream_preamble(i2s);
	if (error != 0) {
		goto out;
	}

	while (true) {
		ssize_t bytes_read = fs_read(&file, mono, sizeof(mono));
		void *block;
		int16_t *output;

		if (bytes_read < 0) {
			error = (int)bytes_read;
			goto out;
		}
		if (bytes_read == 0) {
			break;
		}
		if ((bytes_read & 1) != 0) {
			error = -EBADMSG;
			goto out;
		}

		size_t frames = (size_t)bytes_read / sizeof(int16_t);

		error = k_mem_slab_alloc(&i2s_slab, &block, K_FOREVER);
		if (error != 0) {
			goto out;
		}
		output = block;
		for (size_t frame = 0U; frame < frames; ++frame) {
			output[2U * frame] = mono[frame];
			output[2U * frame + 1U] = mono[frame];
		}
		for (size_t frame = frames;
		     frame < I2S_BLOCK_FRAMES; ++frame) {
			output[2U * frame] = 0;
			output[2U * frame + 1U] = 0;
		}

		error = i2s_write(i2s, block, I2S_BLOCK_SIZE);
		if (error != 0) {
			k_mem_slab_free(&i2s_slab, block);
			goto out;
		}
		played_samples += (uint32_t)frames;
		++queued_blocks;

		if (!started && queued_blocks >= I2S_PREFILL_BLOCKS) {
			error = i2s_trigger(i2s, I2S_DIR_TX,
					    I2S_TRIGGER_START);
			if (error != 0) {
				goto out;
			}
			started = true;
		}
	}

	if (!started) {
		error = i2s_trigger(i2s, I2S_DIR_TX, I2S_TRIGGER_START);
		if (error != 0) {
			goto out;
		}
		started = true;
	}

	error = i2s_trigger(i2s, I2S_DIR_TX, I2S_TRIGGER_DRAIN);
	if (error == 0) {
		printk("Played %u samples of agent speech at %u Hz\n",
		       played_samples, PENDANT_CLOUD_REPLY_SAMPLE_RATE);
	}

out:
	if (file_open) {
		int close_error = fs_close(&file);

		if (error == 0) {
			error = close_error;
		}
	}
	if (error != 0 && started) {
		(void)i2s_trigger(i2s, I2S_DIR_TX, I2S_TRIGGER_DROP);
	}
	return error;
}

static void show_error(void)
{
	while (true) {
		gpio_pin_toggle_dt(&led);
		k_msleep(100);
	}
}

int main(void)
{
	const struct device *const i2s = DEVICE_DT_GET(I2S_NODE);
	int error;

	if (!gpio_is_ready_dt(&led)) {
		audio_cycle_result = -ENODEV;
		return 0;
	}
	error = gpio_pin_configure_dt(&led, GPIO_OUTPUT_INACTIVE);
	if (error != 0) {
		audio_cycle_result = error;
		return 0;
	}
	if (!gpio_is_ready_dt(&button)) {
		audio_cycle_result = -ENODEV;
		show_error();
	}
	error = gpio_pin_configure_dt(&button, GPIO_INPUT);
	if (error != 0) {
		audio_cycle_result = error;
		show_error();
	}
	gpio_init_callback(&button_callback, button_pressed, BIT(button.pin));
	error = gpio_add_callback(button.port, &button_callback);
	if (error != 0) {
		audio_cycle_result = error;
		show_error();
	}
	error = gpio_pin_interrupt_configure_dt(&button, GPIO_INT_EDGE_TO_ACTIVE);
	if (error != 0) {
		audio_cycle_result = error;
		show_error();
	}
	if (!device_is_ready(i2s)) {
		audio_cycle_result = -ENODEV;
		show_error();
	}

	if (mount_sd_card() == 0 && test_sd_persistence() != 0) {
		sd_ready = false;
	}
	if (!sd_ready) {
		printk("microSD is required for Internet voice upload\n");
		audio_cycle_result = sd_mount_result;
		show_error();
	}

#if PENDANT_BOOT_DUMP_PCM_HEX
	if (sd_ready) {
		(void)dump_sd_recording_hex();
	}
#endif

	/* Boot card check: two slow flashes means the required SD card mounted. */
	for (unsigned int flash = 0U; flash < 2U; ++flash) {
		gpio_pin_set_dt(&led, 1);
		k_msleep(160);
		gpio_pin_set_dt(&led, 0);
		k_msleep(160);
	}

#if PENDANT_BOOT_AUTORECORD_TEST
	clear_button_events();
	printk("BOOT_MIC_AUTOTEST_BEGIN\n");
	error = record_microphone(i2s, AUTORECORD_TEST_SAMPLE_COUNT);
	gpio_pin_set_dt(&led, 0);
	printk("BOOT_MIC_AUTOTEST_END result=%d samples=%u\n",
	       error, recorded_samples);
	report_main_stack_headroom("capture");
	if (error != 0) {
		audio_cycle_result = error;
		show_error();
	}
#endif

#if PENDANT_BOOT_ENCODE_SELFTEST
	/* Runs before LTE so a network problem cannot mask a codec fault. */
	if (encode_stack_selftest() != 0) {
		printk("Encode stack selftest failed\n");
	}
#endif

	/*
	 * Solid LED while LTE attaches (up to CONFIG_LTE_NETWORK_TIMEOUT).
	 * Off after success = ready for Button 1 (recording blinks ~250 ms).
	 * Rapid 100 ms blink = show_error() after attach failure.
	 */
	printk("LTE init begin (LED solid = attaching; live Opus enabled)\n");
	gpio_pin_set_dt(&led, 1);
	error = pendant_cloud_init();
	gpio_pin_set_dt(&led, 0);
	if (error != 0) {
		printk("LTE initialization failed: %d\n", error);
		audio_cycle_result = error;
		show_error();
	}
	printk("LTE OK — ready for button (press = record + live upload)\n");

	if (CONFIG_PENDANT_BOOT_AGENT_JOB_ID[0] != '\0') {
		printk("BOOT_AGENT_REPLY_TEST_BEGIN job=%s\n",
		       CONFIG_PENDANT_BOOT_AGENT_JOB_ID);
		error = pendant_cloud_set_job_id_for_diagnostic(
			CONFIG_PENDANT_BOOT_AGENT_JOB_ID);
		if (error == 0) {
			error = pendant_cloud_wait_for_agent_reply(
				PENDANT_CLOUD_REPLY_AUDIO_PATH);
		}
		if (error == 0 &&
		    pendant_cloud_reply_format ==
			    PENDANT_CLOUD_AUDIO_OGG_OPUS) {
			struct pendant_opus_stats decode_stats;

			error = pendant_opus_decode_file(
				PENDANT_CLOUD_REPLY_AUDIO_PATH,
				PENDANT_CLOUD_REPLY_PCM_PATH,
				audio_workspace, sizeof(audio_workspace),
				&decode_stats);
		}
		printk("BOOT_AGENT_REPLY_TEST_END result=%d HTTP=%d "
		       "PCM bytes=%u\n",
		       error, pendant_cloud_last_http_status,
		       pendant_cloud_reply_pcm_bytes);
	}

#if PENDANT_BOOT_UPLOAD_EXISTING
	printk("Boot diagnostic: uploading existing SD PCM recording\n");
	gpio_pin_set_dt(&led, 1);
	int64_t lat_cycle_started = k_uptime_get();
	struct fs_dirent boot_entry;

	error = fs_stat(SD_RECORDING_PATH, &boot_entry);
	if (error == 0 && boot_entry.type == FS_DIR_ENTRY_FILE &&
	    boot_entry.size > 0U) {
		error = pendant_cloud_upload_recording(
			SD_RECORDING_PATH, (uint32_t)boot_entry.size,
			SAMPLE_RATE);
	} else if (error == 0) {
		error = -ENODATA;
	}
	printk("LAT cycle_to_dispatch_ms=%lld\n",
	       k_uptime_get() - lat_cycle_started);
	gpio_pin_set_dt(&led, 0);
	printk("Boot upload result: %d (transcribe=%d dispatch=%d HTTP=%d "
	       "PCM bytes=%u)\n",
	       error, pendant_cloud_transcribe_result,
	       pendant_cloud_dispatch_result,
	       pendant_cloud_last_http_status,
	       pendant_cloud_uploaded_pcm_bytes);
	report_main_stack_headroom("boot upload");
	audio_cycle_result = error;
#endif

	clear_button_events();

#if PENDANT_BOOT_AUDIO_CYCLE_TEST
	bool boot_audio_cycle_test_pending = true;
#endif

	while (true) {
		/* Ready: prewarm TLS/chunked headers while idle (not on press). */
		audio_cycle_phase = 0U;
		gpio_pin_set_dt(&led, 0);
		if (!pendant_cloud_stream_active()) {
			int prewarm = pendant_cloud_stream_prewarm(SAMPLE_RATE);

			if (prewarm != 0) {
				printk("Idle stream prewarm failed: %d "
				       "(record will refuse — no SD fallback)\n",
				       prewarm);
			}
		}
#if PENDANT_BOOT_AUDIO_CYCLE_TEST
		if (boot_audio_cycle_test_pending) {
			boot_audio_cycle_test_pending = false;
			k_msleep(1500);
			k_sem_give(&button_press_sem);
		}
#endif
		wait_for_button_press();

		/*
		 * Press = record immediately. Live upload drains a ring with
		 * non-blocking pumps between I2S blocks (prewarmed TLS).
		 */
		audio_cycle_phase = 1U;
		int64_t lat_press_started = k_uptime_get();

		error = record_microphone(
			i2s,
#if PENDANT_BOOT_AUDIO_CYCLE_TEST
			AUTORECORD_TEST_SAMPLE_COUNT
#else
			MAX_RECORD_SAMPLE_COUNT
#endif
		);
		int capture_error = error;

		gpio_pin_set_dt(&led, 0);
		audio_cycle_phase = 2U;
		if (capture_error != 0) {
			printk("Microphone recording failed: %d\n", capture_error);
			pendant_cloud_stream_abort();
			recording_on_sd = false;
			audio_cycle_result = capture_error;
			flash_led(3U, 120, 120);
			clear_button_events();
			continue;
		}

		/*
		 * Live chunked POST only. No microSD file upload fallback.
		 */
		audio_cycle_phase = 3U;
		if (pendant_cloud_stream_active() && !live_stream_failed) {
			error = pendant_cloud_stream_end();
			printk("LAT live_stream_end_ms=%lld pcm_bytes=%u\n",
			       k_uptime_get() - lat_press_started,
			       pendant_cloud_uploaded_pcm_bytes);
		} else {
			if (pendant_cloud_stream_active()) {
				pendant_cloud_stream_abort();
			}
			printk("Live stream dead — refusing SD fallback\n");
			error = -EIO;
		}
		report_main_stack_headroom("upload");
		printk("LAT press_to_upload_done_ms=%lld\n",
		       k_uptime_get() - lat_press_started);
		if (error != 0) {
			printk("Internet voice cycle failed: %d "
			       "(transcribe=%d dispatch=%d HTTP=%d)\n",
			       error, pendant_cloud_transcribe_result,
			       pendant_cloud_dispatch_result,
			       pendant_cloud_last_http_status);
			audio_cycle_result = error;
			flash_led(5U, 100, 100);
			continue;
		}

		audio_cycle_phase = 4U;
		/*
		 * Waiting for agent speech: LED off until first batch arrives,
		 * then solid (pendant_notify_reply_first_batch). Never autoplay.
		 */
		gpio_pin_set_dt(&led, 0);
		printk("Waiting for agent speech (LED solid on first batch; "
		       "press button 1 to play — no autoplay)\n");
		error = pendant_cloud_wait_for_agent_reply(
			PENDANT_CLOUD_REPLY_AUDIO_PATH);
		if (error == -ECANCELED) {
			/* Button pressed while polling: skip this reply and
			 * go straight back to Ready for a new recording.
			 */
			printk("Reply wait canceled by button press\n");
			finish_button_press();
			gpio_pin_set_dt(&led, 0);
			continue;
		}
		const char *reply_pcm_path = PENDANT_CLOUD_REPLY_AUDIO_PATH;
		if (pendant_cloud_reply_format ==
		    PENDANT_CLOUD_AUDIO_OGG_OPUS) {
			struct pendant_opus_stats decode_stats;

			error = pendant_opus_decode_file(
				PENDANT_CLOUD_REPLY_AUDIO_PATH,
				PENDANT_CLOUD_REPLY_PCM_PATH,
				audio_workspace, sizeof(audio_workspace),
				&decode_stats);
			if (error != 0) {
				printk("Opus reply decode failed: %d\n", error);
				audio_cycle_result = error;
				flash_led(8U, 100, 100);
				continue;
			}
			pendant_cloud_reply_pcm_bytes =
				decode_stats.output_bytes;
			pendant_cloud_reply_sample_rate =
				PENDANT_OPUS_REPLY_SAMPLE_RATE;
			reply_pcm_path = PENDANT_CLOUD_REPLY_PCM_PATH;
		}
		if (error != 0) {
			printk("Agent reply download failed: %d (HTTP=%d)\n",
			       error, pendant_cloud_last_http_status);
			audio_cycle_result = error;
			flash_led(7U, 100, 100);
			continue;
		}

		/*
		 * Repeating pairs of short flashes mean the agent response is ready.
		 * A deliberate third button press starts Bluetooth playback.
		 */
		audio_cycle_phase = 5U;
		clear_button_events();
#if PENDANT_BOOT_AUDIO_CYCLE_TEST
		k_sem_give(&button_press_sem);
#endif
		wait_for_reply_playback_press();

		/* Playing: LED remains solid for the duration of agent speech. */
		audio_cycle_phase = 6U;
		gpio_pin_set_dt(&led, 1);
		int telemetry_error =
			pendant_cloud_report_playback_started();

		if (telemetry_error != 0) {
			printk("Playback-start telemetry failed: %d\n",
			       telemetry_error);
		}
		error = play_agent_reply(i2s, reply_pcm_path);
		telemetry_error =
			pendant_cloud_report_playback_result(error);
		if (telemetry_error != 0) {
			printk("Playback-result telemetry failed: %d\n",
			       telemetry_error);
		}
		gpio_pin_set_dt(&led, 0);
		if (error != 0) {
			printk("Agent reply I2S playback failed: %d\n", error);
			audio_cycle_result = error;
			flash_led(9U, 100, 100);
			continue;
		}

		audio_cycle_phase = 7U;
		audio_cycle_result = 0;
		for (unsigned int flash = 0U; flash < 3U; ++flash) {
			gpio_pin_set_dt(&led, 1);
			k_msleep(180);
			gpio_pin_set_dt(&led, 0);
			k_msleep(180);
		}
		k_msleep(200);
	}
}

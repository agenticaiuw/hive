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
#include "pendant_cloud.h"
#include "pendant_ws.h"

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
 * RX slab is dedicated so the Opus workspace can hold the live encoder
 * while the user is speaking. Six blocks ≈ 123 ms of elastic: an i2s_nrfx
 * RX overrun ERRORS the whole transfer (it does not drop-and-continue), so
 * this must ride out SD-journal stalls on the legacy path and codec spikes
 * on the duplex path.
 */
#define MIC_RX_BLOCK_COUNT 6U
#define MIC_OUT_BLOCK_FRAMES (MIC_RX_BLOCK_FRAMES / MIC_DECIMATION)
#define MIC_STAGE_FRAMES 512U
#define MIC_STAGE_BYTES (MIC_STAGE_FRAMES * sizeof(int16_t))
/*
 * Live TX is streaming Opus (SILK-WB, ~16 kbps, 20 ms frames): measured
 * real-world LTE-M here sustains only 24-55 kbps each way, which starves
 * even 64 kbps μ-law. Workspace layout during capture: encoder arena at the
 * front, wire-framed packet FIFO ([u16 BE length][packet]) in the rest —
 * ~13 KiB of FIFO holds ≈6 s of encoded speech.
 */
#define OPUS_TX_ARENA_BYTES (17U * 1024U)
#define OPUS_TX_FIFO_BYTES \
	(PENDANT_AUDIO_WORKSPACE_BYTES - OPUS_TX_ARENA_BYTES)
/* Batch ≥3 packets per HTTP chunk so TLS/TCP overhead amortizes (~60 ms). */
#define LIVE_TX_BATCH_BYTES 120U
#define LIVE_TX_WRITE_MAX 512U
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
/*
 * End-of-utterance detection: speak, pause ~1.5 s, and the turn ends — no
 * second button press. Thresholds ride the recording's own measured noise
 * floor (quietest stage so far), not fixed levels, so mic gain and room
 * noise calibrate themselves per press.
 */
#define SILENCE_STOP_MS 1500U
#define SILENCE_STOP_STAGES \
	((SILENCE_STOP_MS * SAMPLE_RATE) / (MIC_STAGE_FRAMES * 1000U) + 1U)
/* ~260 ms of clearly-voiced audio before silence can end the turn. */
#define VOICED_STAGES_REQUIRED 8U
/* Accidental press with no speech at all: stop after 6 s, not 30. */
#define NO_SPEECH_STOP_SECONDS 6U
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

/*
 * ---- Full-duplex conversation (WebSocket transport) ----
 *
 * One I2S config drives BOTH directions (i2s_nrfx memcmps them): the mic's
 * proven 24-bit/mono/slave/31250 setup, clocks from the PWM loopback. RX is
 * byte-identical to record_microphone's capture; TX rides the same clocks
 * out SDOUT to the ESP32, which reads the top 16 bits of each 24-bit left
 * word (TX word = sample << 8) at 31250 frames/s.
 *
 * Downlink Opus decodes at the 16 kHz wire rate; the TX fill upsamples
 * 16000 → 31250 with exact 64/125 phase math. TX must NEVER starve: an
 * nrfx TX underrun errors the whole duplex transfer, RX included, so the
 * fill emits silence whenever the jitter ring is below its gate.
 */
#define CONVO_MAX_SECONDS 300U
#define CONVO_TX_BLOCK_FRAMES MIC_RX_BLOCK_FRAMES
#define CONVO_TX_SLAB_BLOCKS 3U
#define CONVO_TX_PRIME_BLOCKS 2U
/* 16 kHz s16 jitter ring: 512 ms of agent speech. Barge-in flushes it, so
 * depth buys LTE-jitter absorption, not conversational latency. */
#define DL_JITTER_BYTES 16384U
#define DL_JITTER_SAMPLES (DL_JITTER_BYTES / sizeof(int16_t))
/* Start/resume playback only with this much banked (128 ms). */
#define DL_PREBUFFER_SAMPLES 2048U
/*
 * Worst case one downlink WS frame decodes to: the relay caps frames at 4
 * packets AND 500 B, each packet ≤ 60 ms (960 samples). The receive gate
 * needs at least this much ring space free, and it MUST sit at or above
 * DL_PREBUFFER_SAMPLES or the prebuffer can never fill (review finding:
 * gate 1024 < prebuffer 2048 deadlocked the ring permanently).
 */
#define DL_WORST_FRAME_SAMPLES 3840U
BUILD_ASSERT(DL_JITTER_SAMPLES - DL_WORST_FRAME_SAMPLES >=
		     DL_PREBUFFER_SAMPLES + 960U,
	     "receive gate must clear the prebuffer with a packet to spare");
/* Largest downlink WS frame the relay may send (packet-aligned, ≤500 B). */
#define WS_RX_BUF_BYTES 640U
/* ~120 ms of Opus per uplink frame: batching overhead vs VAD latency. */
#define WS_TX_BATCH_BYTES 240U
/* Exact 16000/31250 ratio for the TX upsampler. */
#define TX_RESAMPLE_NUM 64U
#define TX_RESAMPLE_DEN 125U
/* Idle keepalive: under Cloudflare's 100 s WS idle kill. */
#define WS_IDLE_PING_SECONDS 25U

/* Decoder state arena (18,404 B measured + margin) — concurrent with the
 * encoder in audio_workspace, so it cannot time-share that block. */
static uint8_t opus_dec_arena[18432] __aligned(4);
static int16_t dl_jitter[DL_JITTER_SAMPLES];
static size_t dl_jitter_head;
static size_t dl_jitter_tail;
static size_t dl_jitter_count;
static int16_t dl_decode_buf[960]; /* one 60 ms wire packet at 16 kHz */

/*
 * ---- WS I/O thread ----
 *
 * The audio loop must queue a TX block every ~20 ms or i2s_nrfx errors the
 * whole duplex transfer — but modem sends can stall for hundreds of ms on
 * LTE. So sockets live on their own thread: the audio loop only touches
 * the uplink byte ring (SPSC: main produces, ws thread consumes), the
 * downlink frame pipe (ws thread produces, main consumes), and two atomic
 * control flags. Codec work stays on main (shared pseudostack).
 */
#define WS_IO_STACK_BYTES 2560
#define WS_IO_PRIORITY 5
#define DL_PIPE_BYTES 4096
static K_THREAD_STACK_DEFINE(ws_io_stack, WS_IO_STACK_BYTES);
static struct k_thread ws_io_thread_data;
static K_MUTEX_DEFINE(ws_lock); /* serializes pendant_ws_* across threads */
K_PIPE_DEFINE(dl_pipe, DL_PIPE_BYTES, 4);
/*
 * Pipe occupancy, tracked by hand: the new k_pipe API has no free-space
 * query, and a partial write would tear the [len][frame] record framing.
 * Single writer (ws thread) checks this before writing both parts; single
 * reader (main) credits it back after consuming a whole record.
 */
static atomic_t dl_pipe_used;
static atomic_t convo_active;    /* audio loop live: pump/recv at full rate */
static atomic_t convo_flush_req; /* relay said flush (barge-in) */
static atomic_t convo_end_req;   /* relay said end / transport died */
static uint8_t ws_rx_buf[WS_RX_BUF_BYTES];    /* ws thread only */
static uint8_t dl_frame_buf[WS_RX_BUF_BYTES]; /* main thread only */
/*
 * One TX slab serves both worlds: duplex conversation blocks (2,560 B used
 * fully) and the legacy reply path's 1,024 B blocks (partial fill of the
 * same chunks). Four blocks preserve the legacy prefill(3)+1 pattern.
 */
K_MEM_SLAB_DEFINE_STATIC(convo_tx_slab,
			 CONVO_TX_BLOCK_FRAMES * sizeof(int32_t),
			 I2S_BLOCK_COUNT, 4);
#define i2s_slab convo_tx_slab

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
static uint8_t audio_workspace[PENDANT_AUDIO_WORKSPACE_BYTES] __aligned(4);
BUILD_ASSERT(sizeof(mic_rx_storage) ==
		     MIC_RX_BLOCK_SIZE * MIC_RX_BLOCK_COUNT,
	     "mic RX storage size mismatch");
/* Legacy i2s_slab folded into convo_tx_slab (defined above). */
/* Processed audio staged between microSD writes (~1 KiB stages). */
static int16_t mic_stage_samples[MIC_STAGE_FRAMES] __aligned(4);
static bool live_stream_failed;
/*
 * Ring saturated during live-only capture: the link fell ~4 s behind. End
 * the utterance with what the link carried instead of failing the cycle —
 * distinct from live_stream_failed, which means the socket itself died.
 */
static bool live_tx_saturated;
/* Defined below with the other capture globals. */
extern volatile bool recording_on_sd;

static int16_t ulaw_to_linear(uint8_t code)
{
	uint8_t u = (uint8_t)(~code);
	int32_t t = (((u & 0x0F) << 3) + 0x84) << ((u >> 4) & 0x07);

	return (int16_t)((u & 0x80U) ? (0x84 - t) : (t - 0x84));
}

/*
 * Wire-framed Opus packet FIFO in the workspace tail. True SPSC ring: the
 * producer (main: encoder sink) owns head, the consumer (legacy pump on
 * main, or the WS I/O thread in a conversation) owns tail; fill level is
 * derived, never a shared counter. Aligned word stores are atomic on this
 * core, so volatile indices are the whole synchronization story.
 */
static volatile size_t live_fifo_head;
static volatile size_t live_fifo_tail;
static bool live_tx_flush;

static inline uint8_t *live_fifo_storage(void)
{
	return audio_workspace + OPUS_TX_ARENA_BYTES;
}

static inline size_t live_fifo_fill(void)
{
	return (live_fifo_head - live_fifo_tail + OPUS_TX_FIFO_BYTES) %
	       OPUS_TX_FIFO_BYTES;
}

static void live_fifo_reset(void)
{
	live_fifo_head = 0U;
	live_fifo_tail = 0U;
	live_tx_flush = false;
}

static void live_fifo_put(const uint8_t *data, size_t length)
{
	uint8_t *storage = live_fifo_storage();
	size_t head = live_fifo_head;

	for (size_t i = 0U; i < length; ++i) {
		storage[head] = data[i];
		head = (head + 1U) % OPUS_TX_FIFO_BYTES;
	}
	/* Data lands before the head moves; the consumer never sees bytes
	 * that are not fully written. */
	compiler_barrier();
	live_fifo_head = head;
}

/* Encoder → FIFO. Saturation clips the utterance (never fails the cycle). */
static int live_opus_packet_sink(const uint8_t *packet, size_t packet_bytes)
{
	uint8_t prefix[2] = { (uint8_t)(packet_bytes >> 8),
			      (uint8_t)(packet_bytes & 0xFFU) };

	if (live_tx_saturated) {
		return 0;
	}
	/* One byte of the ring stays unused so full != empty. */
	if (2U + packet_bytes > OPUS_TX_FIFO_BYTES - 1U - live_fifo_fill()) {
		printk("Live TX FIFO saturated; ending utterance with what "
		       "the link carried\n");
		live_tx_saturated = true;
		return 0;
	}
	live_fifo_put(prefix, 2U);
	live_fifo_put(packet, packet_bytes);
	return 0;
}

/*
 * Feed one PCM stage into the live Opus encoder (packets land in the FIFO
 * via the sink). Encoding a 20 ms frame at complexity 1 fits the gap between
 * I2S DMA blocks; the FIFO absorbs LTE stalls.
 *
 * Transport gate differs by mode: the legacy path requires the chunked-HTTP
 * stream to be open (pendant_cloud_stream_active), the conversation path
 * requires only a live WebSocket — gating on the HTTP stream there made
 * every conversation mute (review finding).
 */
static void live_tx_offer_stage(const int16_t *samples, size_t frame_count)
{
	bool transport_up = atomic_get(&convo_active)
				    ? pendant_ws_connected()
				    : pendant_cloud_stream_active();
	int error;

	if (live_stream_failed || live_tx_saturated || !transport_up ||
	    !pendant_opus_stream_active()) {
		return;
	}
	error = pendant_opus_stream_feed(samples, frame_count);
	if (error != 0) {
		printk("Live Opus feed failed: %d\n", error);
		if (!atomic_get(&convo_active)) {
			pendant_cloud_stream_abort();
		}
		live_stream_failed = true;
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
				live_fifo_reset();
				return;
			}
			continue;
		}

		size_t fill = live_fifo_fill();

		if (fill == 0U ||
		    (!live_tx_flush && fill < LIVE_TX_BATCH_BYTES)) {
			return;
		}

		/* stream_write copies into its own pending buffer, so the
		 * FIFO bytes can be consumed as soon as the queue accepts. */
		uint8_t staging[LIVE_TX_WRITE_MAX];
		uint8_t *storage = live_fifo_storage();
		size_t batch = MIN(fill, sizeof(staging));

		for (size_t i = 0U; i < batch; ++i) {
			staging[i] = storage[(live_fifo_tail + i) %
					     OPUS_TX_FIFO_BYTES];
		}
		error = pendant_cloud_stream_write(staging, batch);
		if (error == -EAGAIN) {
			return;
		}
		if (error != 0) {
			printk("Live TX write failed: %d\n", error);
			pendant_cloud_stream_abort();
			live_stream_failed = true;
			live_fifo_reset();
			return;
		}
		live_fifo_tail = (live_fifo_tail + batch) % OPUS_TX_FIFO_BYTES;
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
	 *
	 * While idle, wake every 5 s to check the half-open live stream. With
	 * STREAM_MAX_IDLE_MS at 12 s this refreshes on every third wake (~15 s
	 * cadence): sockets are rebuilt before Cloudflare's ~20 s idle kill but
	 * NOT unconditionally on every wake — the wake period must stay below
	 * the idle threshold or every wake tears down TLS + a Realtime session.
	 */
	while (k_sem_take(&button_press_sem, K_SECONDS(5)) != 0) {
		(void)pendant_cloud_stream_prewarm(PENDANT_OPUS_SAMPLE_RATE);
	}
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
	 * Latency path: live LTE when prewarmed + microSD backup always.
	 * Prewarm TLS while idle; press = mic + ring (+ SD for fallback).
	 */
	struct fs_file_t sd_file;
	bool sd_open = false;
	bool live_fail_logged = false;
	int live_write_error = 0;

	recording_on_sd = false;
	live_stream_failed = false;
	live_tx_saturated = false;
	live_fifo_reset();
	if (sample_limit == 0U) {
		return -ENODEV;
	}
	/* Re-validate/reopen idle prewarm before I2S (stale sockets → -104). */
	if (pendant_cloud_stream_ensure(PENDANT_OPUS_SAMPLE_RATE) != 0) {
		printk("Live stream ensure failed — recording to microSD "
		       "(fallback single-shot after stop)\n");
	}
	bool live_encoder_ok = false;

	if (pendant_cloud_stream_active()) {
		live_encoder_ok = pendant_opus_stream_begin_packets(
					  SAMPLE_RATE, audio_workspace,
					  OPUS_TX_ARENA_BYTES,
					  live_opus_packet_sink) == 0;
		if (!live_encoder_ok) {
			printk("Live Opus encoder init failed — falling back "
			       "to microSD journal\n");
			pendant_cloud_stream_abort();
		}
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

	fs_file_t_init(&sd_file);
	if (live_encoder_ok) {
		/*
		 * Live LTE path is up: keep every SD write out of the hot
		 * capture loop (an SD stall can back-pressure the ring and
		 * kill the live stream it was insuring). If the stream dies
		 * mid-utterance the cycle fast-fails (-EIO, error flashes) and
		 * that utterance is lost — the early frames were never stored,
		 * so a late journal would upload a beheaded recording.
		 */
	} else if (sd_ready) {
		/* No live path at press — journal from the first frame. */
		error = fs_open(&sd_file, SD_RECORDING_PATH,
				FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
		if (error != 0) {
			printk("microSD open failed (%d) and no live stream\n",
			       error);
			mic_clocks_stop();
			gpio_pin_set_dt(&led, 0);
			return error;
		}
		sd_open = true;
		recording_on_sd = true;
	} else {
		mic_clocks_stop();
		gpio_pin_set_dt(&led, 0);
		printk("No live stream and no microSD — cannot record\n");
		return -ENOTCONN;
	}

	recorded_samples = 0U;
	recorded_peak = 0U;
	recording_absolute_sum = 0U;
	recording_stopped_by_button = false;

	/* Stage level tracking (diagnostics only — recording stops ONLY on a
	 * second button press or the 30 s cap; the cloud's semantic VAD owns
	 * end-of-utterance detection now). */
	uint32_t stage_abs_sum = 0U;
	uint32_t noise_floor_mean = UINT32_MAX;
	uint32_t voiced_stage_count = 0U;
	uint32_t silent_stage_count = 0U;

	error = i2s_configure(i2s, I2S_DIR_RX, &config);
	if (error != 0) {
		mic_clocks_stop();
		if (sd_open) {
			(void)fs_close(&sd_file);
			recording_on_sd = false;
		}
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
	       "live_opus=%d fifo_bytes=%u sd=%d\n",
	       16000000U / MIC_BCLK_TOP, 16000000U / MIC_LRCLK_TOP,
	       SAMPLE_RATE, live_encoder_ok ? 1 : 0,
	       (unsigned int)OPUS_TX_FIFO_BYTES, sd_open ? 1 : 0);

	error = i2s_trigger(i2s, I2S_DIR_RX, I2S_TRIGGER_START);
	if (error != 0) {
		mic_clocks_stop();
		if (sd_open) {
			(void)fs_close(&sd_file);
			recording_on_sd = false;
		}
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
			if (sd_open) {
				(void)fs_close(&sd_file);
				recording_on_sd = false;
			}
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
			if (sd_open) {
				(void)fs_close(&sd_file);
				recording_on_sd = false;
			}
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
			stage_abs_sum += (uint32_t)absolute;
			if (++stage_frames == MIC_STAGE_FRAMES) {
				if (sd_open) {
					live_write_error = write_pcm_frames(
						&sd_file, mic_stage_samples,
						MIC_STAGE_FRAMES);
					if (live_write_error != 0) {
						printk("microSD stage write failed: %d\n",
						       live_write_error);
						(void)fs_close(&sd_file);
						sd_open = false;
						recording_on_sd = false;
						live_write_error = 0;
					}
				}
				live_tx_offer_stage(mic_stage_samples,
						    MIC_STAGE_FRAMES);
				stage_frames = 0U;
				++stage_flush_count;

				/*
				 * End-of-utterance: floor tracks the quietest
				 * stage; voiced/silent split rides that floor,
				 * so levels self-calibrate per press.
				 */
				uint32_t stage_mean =
					stage_abs_sum / MIC_STAGE_FRAMES;

				stage_abs_sum = 0U;
				noise_floor_mean = MIN(noise_floor_mean,
						       MAX(stage_mean, 8U));
				/* Calibrated on a real press (capture
				 * job_bff5bd08): speech runs only ~2-5x the
				 * amplified noise floor, so demand 1.5x plus
				 * an absolute margin, not the 4x that scored
				 * a clean transcribed sentence as silence. */
				if (stage_mean >
				    noise_floor_mean +
					    MAX(noise_floor_mean / 2U, 120U)) {
					++voiced_stage_count;
					silent_stage_count = 0U;
				} else if (stage_mean <
					   noise_floor_mean +
						   MAX(noise_floor_mean / 4U,
						       60U)) {
					++silent_stage_count;
				}
				if (live_tx_saturated) {
					break;
				}
				/* Live mid-fail is OK if SD still capturing. */
				if (live_stream_failed && !sd_open) {
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
		if (live_stream_failed && !sd_open) {
			printk("I2S mic live LTE stream failed mid-capture "
			       "(no SD backup)\n");
			(void)i2s_trigger(i2s, I2S_DIR_RX, I2S_TRIGGER_DROP);
			k_msleep(MIC_STOP_SETTLE_MS);
			mic_clocks_stop();
			if (sd_open) {
				(void)fs_close(&sd_file);
				recording_on_sd = false;
			}
			return -EIO;
		}
		if (live_stream_failed && sd_open && !live_fail_logged) {
			printk("Live LTE failed mid-capture; continuing on microSD\n");
			live_fail_logged = true;
		}

		/* Spend a few free ms pushing PCM over LTE between DMA blocks. */
		if (!live_stream_failed) {
			live_tx_pump(PCM_TX_PUMP_BUDGET_MS);
		}

		if (sample_index >= next_trace_sample) {
			next_trace_sample += SAMPLE_RATE;
		}

		if (k_uptime_get() >= next_led_toggle) {
			gpio_pin_toggle_dt(&led);
			next_led_toggle = k_uptime_get() + 250;
		}

		if (live_tx_saturated) {
			printk("Utterance clipped: uplink fell ~4 s behind\n");
			break;
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
		if (sd_open) {
			live_write_error = write_pcm_frames(
				&sd_file, mic_stage_samples, stage_frames);
			if (live_write_error != 0) {
				printk("microSD final stage write failed: %d\n",
				       live_write_error);
			}
		}
		/* Pad last stream slot so the fixed-size ring accepts it. */
		while (stage_frames < MIC_STAGE_FRAMES) {
			mic_stage_samples[stage_frames++] = 0;
		}
		live_tx_offer_stage(mic_stage_samples, MIC_STAGE_FRAMES);
	}

	if (sd_open) {
		int sync_error = fs_sync(&sd_file);
		int close_error = fs_close(&sd_file);

		sd_open = false;
		if (sync_error != 0 || close_error != 0) {
			printk("microSD close failed: sync=%d close=%d\n",
			       sync_error, close_error);
			recording_on_sd = false;
		}
	}

	/* Finalize the live encoder (flushes the last partial packet through
	 * the sink), then drain the FIFO — it can hold ~6 s of encoded audio;
	 * give a weak uplink time to move it. */
	if (pendant_opus_stream_active()) {
		struct pendant_opus_stats live_stats = { 0 };
		int end_error = pendant_opus_stream_end(&live_stats);

		if (end_error != 0) {
			printk("Live Opus finalize failed: %d\n", end_error);
		} else {
			printk("Live Opus: packets=%u bytes=%u\n",
			       live_stats.packets, live_stats.output_bytes);
		}
	}
	if (pendant_cloud_stream_active() && !live_stream_failed) {
		int64_t drain_until = k_uptime_get() + 6000;

		live_tx_flush = true;
		while ((live_fifo_fill() > 0U ||
			pendant_cloud_stream_has_pending()) &&
		       pendant_cloud_stream_active() && !live_stream_failed &&
		       k_uptime_get() < drain_until) {
			live_tx_pump(PCM_TX_DRAIN_BUDGET_MS);
		}
		if (live_stream_failed || !pendant_cloud_stream_active()) {
			printk("Live TX incomplete — will use SD fallback if present\n");
			pendant_cloud_stream_abort();
			live_stream_failed = true;
			live_fifo_reset();
		} else if (pendant_cloud_stream_has_pending()) {
			/* A half-sent HTTP chunk cannot be abandoned without
			 * corrupting the chunked framing — abort cleanly. */
			printk("Live TX pending chunk stuck; abort stream\n");
			pendant_cloud_stream_abort();
			live_stream_failed = true;
			live_fifo_reset();
		} else if (live_fifo_fill() > 0U) {
			/* Socket healthy but slow: clip the utterance tail and
			 * let the model answer on what arrived. */
			printk("Live TX drain timeout; clipping %u undelivered "
			       "bytes\n",
			       (uint32_t)live_fifo_fill());
			live_fifo_reset();
		}
	}

	/* Capture itself succeeded if we have samples (live and/or SD). */
	error = (recorded_samples > 0U) ? 0 : (error != 0 ? error : -ENODATA);

	uint32_t rms = recorded_samples == 0U
		? 0U
		: integer_square_root(square_sum / recorded_samples);
	printk("I2S mic capture totals: samples=%u mean=%u peak=%u rms=%u "
	       "min=%d max=%d zero_crossings=%u sd_flushes=%u "
	       "live_sent=%u fifo_left=%u saturated=%d "
	       "stream_failed=%d\n",
	       recorded_samples,
	       recorded_samples == 0U
		       ? 0U
		       : (uint32_t)(recording_absolute_sum /
				    recorded_samples),
	       recorded_peak, rms, minimum_sample, maximum_sample,
	       zero_crossings, stage_flush_count,
	       pendant_cloud_stream_bytes_sent(),
	       (uint32_t)live_fifo_fill(), live_tx_saturated ? 1 : 0,
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

/*
 * Conversational autoplay: pull the model's spoken PCM off the upload socket
 * (pendant_cloud_reply_read) and drive I2S as it arrives. An I2S underrun
 * during an LTE stall is recovered by a full reconfigure + preamble — the
 * ESP32 resyncs on the preamble pattern, so a stall is a glitch, not a brick.
 */
/* Pauses are clean rebuffers now (silence, not noise) — allow more. */
#define INLINE_REPLY_MAX_RECOVERIES 12U

/* ~500 ms of 8 kHz u-law buffered before the speaker starts. When the
 * downlink proves slower than the stream rate, each starvation raises the
 * refill bar so the reply degrades into ONE longer pause, not stutter. */
#define INLINE_PREBUFFER_BYTES 4000U
#define INLINE_REBUFFER_STEP_BYTES 8000U
/* Opus wire is ~2 KB/s: ~5 packets ≈ 300 ms to start, +~600 ms per pause. */
#define INLINE_OPUS_PREBUFFER_BYTES 512U
#define INLINE_OPUS_REBUFFER_STEP 1024U
#define INLINE_OPUS_MAX_PACKET_BYTES 1275U

/*
 * Pop one complete [u16 BE length][packet] from the wire ring and decode to
 * 24 kHz mono PCM. Returns samples produced, 0 when the ring lacks a full
 * packet, <0 on protocol or decoder error.
 */
static int inline_opus_next_packet(uint8_t *ring, size_t capacity,
				   size_t *tail, size_t *count,
				   int16_t *pcm_out)
{
	static uint8_t packet[INLINE_OPUS_MAX_PACKET_BYTES];
	size_t length;

	if (*count < 2U) {
		return 0;
	}
	length = ((size_t)ring[*tail] << 8) |
		 ring[(*tail + 1U) % capacity];
	if (length == 0U || length > sizeof(packet)) {
		return -EBADMSG;
	}
	if (*count < 2U + length) {
		return 0;
	}
	*tail = (*tail + 2U) % capacity;
	for (size_t i = 0U; i < length; ++i) {
		packet[i] = ring[(*tail + i) % capacity];
	}
	*tail = (*tail + length) % capacity;
	*count -= 2U + length;
	return pendant_opus_reply_decode_packet(
		packet, length, pcm_out, PENDANT_OPUS_REPLY_FRAME_SAMPLES);
}

static int play_inline_reply(const struct device *i2s)
{
	const bool ulaw_reply =
		pendant_cloud_reply_format == PENDANT_CLOUD_AUDIO_G711_ULAW;
	const bool opus_reply =
		pendant_cloud_reply_format == PENDANT_CLOUD_AUDIO_OPUS_FRAMES;
	const uint32_t reply_rate = pendant_cloud_reply_sample_rate != 0U
					    ? pendant_cloud_reply_sample_rate
					    : PENDANT_CLOUD_REPLY_SAMPLE_RATE;
	struct i2s_config config = {
		.word_size = 16U,
		.channels = I2S_CHANNEL_COUNT,
		.format = I2S_FMT_DATA_FORMAT_I2S,
		.options = I2S_OPT_FRAME_CLK_CONTROLLER |
			   I2S_OPT_BIT_CLK_CONTROLLER,
		/* Opus decodes straight to 24 kHz; u-law is upsampled 3x on
		 * decode (8 -> 24 kHz). Either way the ESP32 bridge sees the
		 * 24000 Hz its resampler is hardcoded for. */
		.frame_clk_freq = ulaw_reply ? reply_rate * 3U : reply_rate,
		.mem_slab = &i2s_slab,
		.block_size = I2S_BLOCK_SIZE,
		.timeout = 3000,
	};
	uint32_t recoveries = 0U;
	uint32_t played_samples = 0U;
	uint32_t queued_blocks = 0U;
	uint32_t rebuffer_waits = 0U;
	bool started = false;
	bool configured = false;
	int read_result = 0;
	int error = 0;

	if (!ulaw_reply && !opus_reply) {
		/* Legacy 24 kHz PCM path (kept for relay fallback). */
		int16_t mono[I2S_BLOCK_FRAMES];

		for (;;) {
			read_result =
				pendant_cloud_reply_read(mono, sizeof(mono));
			if (read_result <= 0) {
				break;
			}
			if ((read_result & 1) != 0) {
				--read_result;
				if (read_result == 0) {
					break;
				}
			}

			size_t frames = (size_t)read_result / sizeof(int16_t);
			void *block;
			int16_t *output;

			if (!configured) {
				error = i2s_configure(i2s, I2S_DIR_TX, &config);
				if (error == 0) {
					error = queue_i2s_stream_preamble(i2s);
				}
				if (error != 0) {
					break;
				}
				configured = true;
				started = false;
				queued_blocks = I2S_SYNC_PATTERN_BLOCKS + 1U;
			}
			error = k_mem_slab_alloc(&i2s_slab, &block, K_MSEC(3000));
			if (error != 0) {
				break;
			}
			output = block;
			for (size_t frame = 0U; frame < frames; ++frame) {
				output[2U * frame] = mono[frame];
				output[2U * frame + 1U] = mono[frame];
			}
			for (size_t frame = frames; frame < I2S_BLOCK_FRAMES;
			     ++frame) {
				output[2U * frame] = 0;
				output[2U * frame + 1U] = 0;
			}
			error = i2s_write(i2s, block, I2S_BLOCK_SIZE);
			if (error != 0) {
				k_mem_slab_free(&i2s_slab, block);
				if (++recoveries > INLINE_REPLY_MAX_RECOVERIES) {
					break;
				}
				printk("Inline reply I2S recovery %u (error %d)\n",
				       recoveries, error);
				(void)i2s_trigger(i2s, I2S_DIR_TX,
						  I2S_TRIGGER_DROP);
				configured = false;
				error = 0;
				continue;
			}
			played_samples += (uint32_t)frames;
			++queued_blocks;
			if (!started && queued_blocks >= I2S_PREFILL_BLOCKS) {
				error = i2s_trigger(i2s, I2S_DIR_TX,
						    I2S_TRIGGER_START);
				if (error != 0) {
					break;
				}
				started = true;
			}
		}
		goto teardown;
	}

	/*
	 * Streamed reply (Opus packets or u-law bytes) with a workspace jitter
	 * ring: LTE delivers in bursts with multi-second gaps, far larger than
	 * the 4-block (~43 ms) I2S queue. Prebuffer, then absorb; genuine
	 * starvation pauses cleanly and rebuffers with an escalating floor.
	 */
	{
		uint8_t *ring = audio_workspace;
		size_t ring_capacity = sizeof(audio_workspace);
		size_t ring_tail = 0U;
		size_t ring_head = 0U;
		size_t ring_count = 0U;
		/* Decoded-PCM staging: Opus emits 60 ms bursts (1440 samples
		 * at 24 kHz); u-law interpolation carries 3 at a time. */
		static int16_t pending_pcm[PENDANT_OPUS_REPLY_FRAME_SAMPLES];
		size_t pending_length = 0U;
		size_t pending_offset = 0U;
		int16_t previous_sample = 0;
		size_t prebuffer_bytes =
			opus_reply ? INLINE_OPUS_PREBUFFER_BYTES
				   : INLINE_PREBUFFER_BYTES;
		bool reply_eof = false;
		int stream_error = 0;

		if (opus_reply) {
			int decoder_bytes = pendant_opus_reply_decoder_begin(
				audio_workspace, sizeof(audio_workspace));

			if (decoder_bytes < 0) {
				error = decoder_bytes;
				goto teardown;
			}
			ring = audio_workspace +
			       ROUND_UP((size_t)decoder_bytes, 4U);
			ring_capacity = sizeof(audio_workspace) -
					ROUND_UP((size_t)decoder_bytes, 4U);
		}

		(void)pendant_cloud_reply_set_nonblocking(true);

		for (;;) {
			/* 1) Drain LTE into the jitter ring (non-blocking). */
			while (!reply_eof && ring_count < ring_capacity) {
				uint8_t chunk[512];
				size_t want = MIN(sizeof(chunk),
						  ring_capacity - ring_count);

				read_result =
					pendant_cloud_reply_read(chunk, want);
				if (read_result == -EAGAIN) {
					break;
				}
				if (read_result <= 0) {
					reply_eof = true;
					stream_error = read_result;
					break;
				}
				for (int i = 0; i < read_result; ++i) {
					ring[ring_head] = chunk[i];
					ring_head = (ring_head + 1U) %
						    ring_capacity;
				}
				ring_count += (size_t)read_result;
				if ((size_t)read_result < want) {
					break;
				}
			}

			bool producer_ready;

			if (opus_reply) {
				/* A block can start when decoded samples are
				 * staged or a complete packet is buffered. */
				size_t need = 2U;

				if (ring_count >= 2U) {
					need = 2U +
					       (((size_t)ring[ring_tail] << 8) |
						ring[(ring_tail + 1U) %
						     ring_capacity]);
				}
				producer_ready =
					pending_length > pending_offset ||
					(ring_count >= need && need > 2U);
			} else {
				producer_ready =
					pending_length > pending_offset ||
					ring_count > 0U;
			}

			/* 2) Start gate: prebuffer before spinning I2S up. */
			if (!configured) {
				if (!producer_ready && reply_eof) {
					break;
				}
				if (ring_count < prebuffer_bytes &&
				    !reply_eof) {
					++rebuffer_waits;
					k_msleep(5);
					continue;
				}
				error = i2s_configure(i2s, I2S_DIR_TX, &config);
				if (error == 0) {
					error = queue_i2s_stream_preamble(i2s);
				}
				if (error != 0) {
					break;
				}
				configured = true;
				started = false;
				queued_blocks = I2S_SYNC_PATTERN_BLOCKS + 1U;
			}

			/* 3) Emit one full block when data is ready. */
			if (producer_ready || (reply_eof && ring_count > 0U)) {
				void *block;
				int16_t *output;
				size_t frame = 0U;

				error = k_mem_slab_alloc(&i2s_slab, &block,
							 K_MSEC(3000));
				if (error != 0) {
					break;
				}
				output = block;
				while (frame < I2S_BLOCK_FRAMES) {
					int16_t sample_value;

					if (pending_offset >= pending_length) {
						pending_offset = 0U;
						pending_length = 0U;
						if (opus_reply) {
							int got = inline_opus_next_packet(
								ring,
								ring_capacity,
								&ring_tail,
								&ring_count,
								pending_pcm);

							if (got < 0) {
								stream_error =
									got;
								reply_eof =
									true;
								break;
							}
							if (got == 0) {
								break;
							}
							pending_length =
								(size_t)got;
						} else {
							if (ring_count == 0U) {
								break;
							}
							uint8_t code =
								ring[ring_tail];

							ring_tail =
								(ring_tail +
								 1U) %
								ring_capacity;
							--ring_count;

							int16_t decoded =
								ulaw_to_linear(
									code);
							int32_t delta =
								(int32_t)decoded -
								previous_sample;

							pending_pcm[0] = (int16_t)(previous_sample +
										   delta / 3);
							pending_pcm[1] =
								(int16_t)(previous_sample +
									  (2 * delta) /
										  3);
							pending_pcm[2] = decoded;
							pending_length = 3U;
							previous_sample =
								decoded;
						}
						if (pending_length == 0U) {
							break;
						}
					}
					sample_value =
						pending_pcm[pending_offset++];
					output[2U * frame] = sample_value;
					output[2U * frame + 1U] = sample_value;
					++frame;
				}
				if (frame == 0U) {
					k_mem_slab_free(&i2s_slab, block);
					if (reply_eof) {
						break;
					}
					++rebuffer_waits;
					k_msleep(3);
					continue;
				}
				/* Zero-fill ONLY the final partial block. */
				for (size_t rest = frame;
				     rest < I2S_BLOCK_FRAMES; ++rest) {
					output[2U * rest] = 0;
					output[2U * rest + 1U] = 0;
				}
				error = i2s_write(i2s, block, I2S_BLOCK_SIZE);
				if (error != 0) {
					k_mem_slab_free(&i2s_slab, block);
					if (++recoveries >
					    INLINE_REPLY_MAX_RECOVERIES) {
						break;
					}
					prebuffer_bytes = MIN(
						prebuffer_bytes +
							(opus_reply
								 ? INLINE_OPUS_REBUFFER_STEP
								 : INLINE_REBUFFER_STEP_BYTES),
						ring_capacity / 2U);
					printk("Inline reply starved; pause+rebuffer %u (error %d, next threshold %u)\n",
					       recoveries, error,
					       (unsigned int)prebuffer_bytes);
					(void)i2s_trigger(i2s, I2S_DIR_TX,
							  I2S_TRIGGER_DROP);
					configured = false;
					error = 0;
					continue;
				}
				played_samples += (uint32_t)frame;
				++queued_blocks;
				if (!started &&
				    queued_blocks >= I2S_PREFILL_BLOCKS) {
					error = i2s_trigger(i2s, I2S_DIR_TX,
							    I2S_TRIGGER_START);
					if (error != 0) {
						break;
					}
					started = true;
				}
				if (reply_eof && ring_count == 0U &&
				    pending_offset >= pending_length) {
					break;
				}
				continue;
			}
			if (reply_eof) {
				break;
			}
			/* Mid-play buffer low: keep draining the socket. */
			++rebuffer_waits;
			k_msleep(3);
		}
		if (opus_reply) {
			pendant_opus_reply_decoder_end();
		}
		if (error == 0 && stream_error != 0 &&
		    stream_error != -EAGAIN && played_samples == 0U) {
			read_result = stream_error;
		}
	}

teardown:
	if (configured) {
		bool drained = false;

		if (!started && error == 0 &&
		    i2s_trigger(i2s, I2S_DIR_TX, I2S_TRIGGER_START) == 0) {
			started = true;
		}
		if (started && error == 0) {
			drained = i2s_trigger(i2s, I2S_DIR_TX,
					      I2S_TRIGGER_DRAIN) == 0;
		}
		if (!drained) {
			/* An underrun after the final write parks the driver in
			 * ERROR, where DRAIN/START fail; DROP is the only reset
			 * back to READY. Without it every later record/playback
			 * cycle fails until power cycle. */
			(void)i2s_trigger(i2s, I2S_DIR_TX, I2S_TRIGGER_DROP);
		}
	}

	printk("Inline reply played %u samples (read_result=%d error=%d "
	       "recoveries=%u rebuffer_waits=%u)\n",
	       played_samples, read_result, error, recoveries, rebuffer_waits);

	if (error != 0) {
		return error;
	}
	if (read_result < 0 && read_result != -EAGAIN && played_samples == 0U) {
		return read_result;
	}
	return 0;
}

static void show_error(void)
{
	while (true) {
		gpio_pin_toggle_dt(&led);
		k_msleep(100);
	}
}

/* ---- Full-duplex conversation ---- */

static void dl_jitter_reset(void)
{
	dl_jitter_head = 0U;
	dl_jitter_tail = 0U;
	dl_jitter_count = 0U;
}

static void dl_jitter_put(const int16_t *samples, size_t count)
{
	size_t free_samples = DL_JITTER_SAMPLES - dl_jitter_count;

	/* The receive gate makes overflow unreachable in normal operation;
	 * a misbehaving relay (dense DTX frames) must clip, not corrupt. */
	if (count > free_samples) {
		count = free_samples;
	}
	for (size_t i = 0U; i < count; ++i) {
		dl_jitter[dl_jitter_head] = samples[i];
		dl_jitter_head = (dl_jitter_head + 1U) % DL_JITTER_SAMPLES;
	}
	dl_jitter_count += count;
}

/*
 * Fill one TX block (640 words at 31250) from the 16 kHz jitter ring with
 * exact 64/125 phase-accumulator interpolation. `*playing` implements the
 * prebuffer/rebuffer gate; silence flows whenever it is off so the duplex
 * transfer never underruns. Interp state persists across blocks.
 */
static uint32_t tx_phase;      /* 0..TX_RESAMPLE_DEN-1 */
static int16_t tx_prev_sample; /* last 16 kHz sample consumed */
static int16_t tx_next_sample;
static bool tx_have_next;

static void tx_resample_reset(void)
{
	tx_phase = 0U;
	tx_prev_sample = 0;
	tx_next_sample = 0;
	tx_have_next = false;
}

static void convo_fill_tx_block(int32_t *words, bool *playing)
{
	for (size_t frame = 0U; frame < CONVO_TX_BLOCK_FRAMES; ++frame) {
		if (!*playing && dl_jitter_count >= DL_PREBUFFER_SAMPLES) {
			*playing = true;
		}
		if (*playing && !tx_have_next && dl_jitter_count > 0U) {
			tx_next_sample = dl_jitter[dl_jitter_tail];
			dl_jitter_tail =
				(dl_jitter_tail + 1U) % DL_JITTER_SAMPLES;
			--dl_jitter_count;
			tx_have_next = true;
		}
		if (!*playing || !tx_have_next) {
			/* Starved: pause output and re-arm the prebuffer. */
			if (*playing && dl_jitter_count == 0U) {
				*playing = false;
			}
			words[frame] = 0;
			continue;
		}

		int32_t span = (int32_t)tx_next_sample - tx_prev_sample;
		int32_t value = tx_prev_sample +
				(span * (int32_t)tx_phase) /
					(int32_t)TX_RESAMPLE_DEN;

		words[frame] = value << 8;
		tx_phase += TX_RESAMPLE_NUM;
		if (tx_phase >= TX_RESAMPLE_DEN) {
			tx_phase -= TX_RESAMPLE_DEN;
			tx_prev_sample = tx_next_sample;
			tx_have_next = false;
			if (dl_jitter_count > 0U) {
				tx_next_sample = dl_jitter[dl_jitter_tail];
				dl_jitter_tail = (dl_jitter_tail + 1U) %
						 DL_JITTER_SAMPLES;
				--dl_jitter_count;
				tx_have_next = true;
			}
		}
	}
}

/* Queue one filled TX block; returns 0 or the i2s_write error. */
static int convo_queue_tx_block(const struct device *i2s, bool *playing)
{
	void *block;
	int error;

	error = k_mem_slab_alloc(&convo_tx_slab, &block, K_MSEC(200));
	if (error != 0) {
		return error;
	}
	convo_fill_tx_block((int32_t *)block, playing);
	error = i2s_write(i2s, block,
			  CONVO_TX_BLOCK_FRAMES * sizeof(int32_t));
	if (error != 0) {
		k_mem_slab_free(&convo_tx_slab, block);
	}
	return error;
}

/*
 * The ESP32 hunts a sync preamble after every BCLK restart: ≥8 alternating
 * 0x2468/0x5A5A words then 0x6C6C, all in the top 16 bits of left-slot
 * words. Block 0 is pure alternation (20.5 ms — outlives the ESP32's
 * discarded first DMA block), block 1 opens with the end marker.
 */
static int convo_queue_preamble(const struct device *i2s)
{
	for (unsigned int block_index = 0U;
	     block_index < CONVO_TX_PRIME_BLOCKS; ++block_index) {
		void *block;
		int32_t *words;
		int error;

		error = k_mem_slab_alloc(&convo_tx_slab, &block, K_MSEC(100));
		if (error != 0) {
			return error;
		}
		words = (int32_t *)block;
		for (size_t frame = 0U; frame < CONVO_TX_BLOCK_FRAMES;
		     ++frame) {
			int32_t value = 0;

			if (block_index == 0U) {
				value = (frame & 1U) ? I2S_STREAM_SYNC_B
						     : I2S_STREAM_SYNC_A;
			} else if (frame < I2S_SYNC_END_FRAMES) {
				value = I2S_STREAM_SYNC_END;
			}
			words[frame] = value << 8;
		}
		error = i2s_write(i2s, block,
				  CONVO_TX_BLOCK_FRAMES * sizeof(int32_t));
		if (error != 0) {
			k_mem_slab_free(&convo_tx_slab, block);
			return error;
		}
	}
	return 0;
}

/*
 * WS I/O thread body. All socket work lives here so a stalled modem send
 * can never starve the audio loop's 20 ms TX deadline.
 *
 * Uplink: consume the SPSC wire FIFO, batch, send (blocking is fine on
 * this thread — SO_SNDTIMEO bounds it). Downlink: receive one message at a
 * time; binary frames go into dl_pipe as [2-byte BE frame length][bytes]
 * only when the pipe has room (backpressure = stop receiving, TCP holds
 * the rest); control frames become atomic flags. While no conversation is
 * active the thread just keeps the idle socket alive with pings.
 */
static void ws_io_pump_uplink(void)
{
	uint8_t staging[WS_TX_BATCH_BYTES];
	uint8_t *storage = live_fifo_storage();
	size_t fill;

	while ((fill = live_fifo_fill()) >= WS_TX_BATCH_BYTES ||
	       (live_tx_flush && fill > 0U)) {
		size_t tail = live_fifo_tail;
		size_t batch = MIN(fill, sizeof(staging));

		for (size_t i = 0U; i < batch; ++i) {
			staging[i] =
				storage[(tail + i) % OPUS_TX_FIFO_BYTES];
		}
		if (pendant_ws_send_binary(staging, batch) != 0) {
			atomic_set(&convo_end_req, 1);
			return;
		}
		live_fifo_tail = (tail + batch) % OPUS_TX_FIFO_BYTES;
	}
}

static void ws_io_drain_downlink(void)
{
	for (unsigned int budget = 0U; budget < 4U; ++budget) {
		bool is_text = false;
		int received;
		uint8_t frame_header[2];

		/* Backpressure: no pipe room for a max frame → stop reading
		 * the socket; TCP flow control parks the rest at the relay. */
		if (DL_PIPE_BYTES - (size_t)atomic_get(&dl_pipe_used) <
		    sizeof(frame_header) + sizeof(ws_rx_buf)) {
			return;
		}
		received = pendant_ws_recv(ws_rx_buf, sizeof(ws_rx_buf),
					   &is_text);
		if (received == 0) {
			return;
		}
		if (received < 0) {
			atomic_set(&convo_end_req, 1);
			return;
		}
		if (is_text) {
			ws_rx_buf[MIN((size_t)received,
				      sizeof(ws_rx_buf) - 1U)] = '\0';
			if (strstr((const char *)ws_rx_buf, "\"flush\"") !=
			    NULL) {
				atomic_set(&convo_flush_req, 1);
			} else if (strstr((const char *)ws_rx_buf,
					  "\"end\"") != NULL) {
				atomic_set(&convo_end_req, 1);
			}
			continue;
		}
		frame_header[0] = (uint8_t)((size_t)received >> 8);
		frame_header[1] = (uint8_t)((size_t)received & 0xFFU);
		/* Space was checked above and this is the only writer, so
		 * both writes land in full. */
		(void)k_pipe_write(&dl_pipe, frame_header,
				   sizeof(frame_header), K_NO_WAIT);
		(void)k_pipe_write(&dl_pipe, ws_rx_buf, (size_t)received,
				   K_NO_WAIT);
		atomic_add(&dl_pipe_used,
			   (atomic_val_t)(sizeof(frame_header) +
					  (size_t)received));
	}
}

static void ws_io_thread_fn(void *a, void *b, void *c)
{
	int64_t next_idle_ping = 0;

	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	for (;;) {
		if (atomic_get(&convo_active)) {
			k_mutex_lock(&ws_lock, K_FOREVER);
			if (pendant_ws_connected()) {
				ws_io_pump_uplink();
				ws_io_drain_downlink();
			} else {
				atomic_set(&convo_end_req, 1);
			}
			k_mutex_unlock(&ws_lock);
			k_msleep(5);
			continue;
		}
		if (pendant_ws_connected() &&
		    k_uptime_get() >= next_idle_ping) {
			k_mutex_lock(&ws_lock, K_FOREVER);
			(void)pendant_ws_ping();
			/* Swallow pongs/strays so they never lead a
			 * conversation's downlink. */
			for (int drained = 1; drained > 0;) {
				bool is_text = false;

				drained = pendant_ws_recv(ws_rx_buf,
							  sizeof(ws_rx_buf),
							  &is_text);
			}
			k_mutex_unlock(&ws_lock);
			next_idle_ping =
				k_uptime_get() + WS_IDLE_PING_SECONDS * 1000;
		}
		k_msleep(200);
	}
}

/*
 * Main-loop side of the downlink: pull whole frames from dl_pipe, decode
 * each packet into the jitter ring. Called between I2S blocks; bounded by
 * ring space, not time (a 60 ms decode is ~2-4 ms here).
 */
static void convo_decode_downlink(void)
{
	for (;;) {
		uint8_t frame_header[2];
		size_t frame_bytes;
		size_t got = 0U;

		if (DL_JITTER_SAMPLES - dl_jitter_count <
		    DL_WORST_FRAME_SAMPLES) {
			return;
		}
		if (k_pipe_read(&dl_pipe, frame_header, sizeof(frame_header),
				K_NO_WAIT) < (int)sizeof(frame_header)) {
			return;
		}
		frame_bytes = ((size_t)frame_header[0] << 8) | frame_header[1];
		if (frame_bytes > sizeof(dl_frame_buf)) {
			printk("Downlink pipe record oversized\n");
			atomic_set(&convo_end_req, 1);
			return;
		}
		while (got < frame_bytes) {
			int r = k_pipe_read(&dl_pipe, dl_frame_buf + got,
					    frame_bytes - got, K_MSEC(20));

			if (r <= 0) {
				printk("Downlink pipe torn frame\n");
				atomic_set(&convo_end_req, 1);
				return;
			}
			got += (size_t)r;
		}
		atomic_sub(&dl_pipe_used,
			   (atomic_val_t)(sizeof(frame_header) + frame_bytes));

		size_t offset = 0U;

		while (offset + 2U <= frame_bytes) {
			size_t packet_bytes =
				((size_t)dl_frame_buf[offset] << 8) |
				dl_frame_buf[offset + 1U];

			offset += 2U;
			if (packet_bytes == 0U ||
			    offset + packet_bytes > frame_bytes) {
				printk("Downlink framing broken (len=%u)\n",
				       (unsigned int)packet_bytes);
				atomic_set(&convo_end_req, 1);
				return;
			}
			int decoded = pendant_opus_reply_decode_packet(
				dl_frame_buf + offset, packet_bytes,
				dl_decode_buf, ARRAY_SIZE(dl_decode_buf));

			if (decoded > 0) {
				dl_jitter_put(dl_decode_buf,
					      (size_t)decoded);
			}
			offset += packet_bytes;
		}
	}
}

/*
 * One press-to-press conversation: mic streams up, agent speech streams
 * down and PLAYS WHILE RECORDING — the model decides when to talk. Ends on
 * the second button press, relay 'end' (30 s of mutual silence), transport
 * death, or the runaway cap.
 */
static int run_conversation(const struct device *i2s)
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
	struct i2s_config tx_config;
	int32_t raw_processing[MIC_RX_BLOCK_FRAMES];
	char device_time[32];
	char start_message[96];
	int64_t started_at;
	int64_t next_led_toggle;
	size_t stage_frames = 0U;
	size_t block_index = 0U;
	int32_t hpf_prev_in = 0;
	int32_t hpf_prev_out = 0;
	bool hpf_primed = false;
	int32_t slew_prev = 0;
	bool slew_primed = false;
	bool playing = false;
	bool i2s_running = false;
	bool stop_sent = false;
	int result = 0;
	int error;

	live_stream_failed = false;
	live_tx_saturated = false;
	live_fifo_reset();
	dl_jitter_reset();
	tx_resample_reset();
	k_pipe_reset(&dl_pipe);
	atomic_set(&dl_pipe_used, 0);
	atomic_set(&convo_flush_req, 0);
	atomic_set(&convo_end_req, 0);

	k_mutex_lock(&ws_lock, K_FOREVER);
	error = pendant_ws_connect();
	if (error == 0) {
		pendant_cloud_copy_device_time(device_time,
					       sizeof(device_time));
		snprintf(start_message, sizeof(start_message),
			 "{\"type\":\"start\",\"deviceTime\":\"%s\"}",
			 device_time);
		error = pendant_ws_send_text(start_message);
	}
	k_mutex_unlock(&ws_lock);
	if (error != 0) {
		return error;
	}

	error = pendant_opus_stream_begin_packets(SAMPLE_RATE,
						  audio_workspace,
						  OPUS_TX_ARENA_BYTES,
						  live_opus_packet_sink);
	if (error != 0) {
		printk("Conversation encoder init failed: %d\n", error);
		return error;
	}
	error = pendant_opus_reply_decoder_begin_rate(
		opus_dec_arena, sizeof(opus_dec_arena),
		PENDANT_OPUS_SAMPLE_RATE);
	if (error < 0) {
		printk("Conversation decoder init failed: %d\n", error);
		pendant_opus_stream_abort();
		return error;
	}

	error = k_mem_slab_init(&mic_rx_slab, mic_rx_storage,
				MIC_RX_BLOCK_SIZE, MIC_RX_BLOCK_COUNT);
	if (error != 0) {
		goto teardown;
	}

	gpio_pin_set_dt(&led, 1);
	next_led_toggle = k_uptime_get() + 250;
	mic_clocks_start();

	error = i2s_configure(i2s, I2S_DIR_RX, &config);
	if (error != 0) {
		goto teardown_clocks;
	}
	tx_config = config;
	tx_config.mem_slab = &convo_tx_slab;
	error = i2s_configure(i2s, I2S_DIR_TX, &tx_config);
	if (error != 0) {
		goto teardown_clocks;
	}

	/* START in BOTH mode needs TX blocks queued first. */
	error = convo_queue_preamble(i2s);
	if (error != 0) {
		goto teardown_clocks;
	}

	k_msleep(MIC_POWERUP_BUDGET_MS);
	printk("Conversation: duplex I2S bclk_hz=%u lrclk_hz=%u "
	       "(mic %u Hz up, agent 16 kHz down)\n",
	       16000000U / MIC_BCLK_TOP, 16000000U / MIC_LRCLK_TOP,
	       SAMPLE_RATE);
	error = i2s_trigger(i2s, I2S_DIR_BOTH, I2S_TRIGGER_START);
	if (error != 0) {
		goto teardown_clocks;
	}
	i2s_running = true;
	started_at = k_uptime_get();
	clear_button_events();
	atomic_set(&convo_active, 1);

	while (true) {
		void *block;
		size_t size;

		/* Clock-locked pacing: one RX block in, one TX block out. */
		error = i2s_read(i2s, &block, &size);
		if (error != 0) {
			printk("Conversation I2S read failed: %d\n", error);
			result = error;
			break;
		}
		if (size > sizeof(raw_processing) ||
		    (size % sizeof(int32_t)) != 0U) {
			k_mem_slab_free(&mic_rx_slab, block);
			result = -EMSGSIZE;
			break;
		}
		memcpy(raw_processing, block, size);
		k_mem_slab_free(&mic_rx_slab, block);

		error = convo_queue_tx_block(i2s, &playing);
		if (error != 0) {
			printk("Conversation TX write failed: %d\n", error);
			result = error;
			break;
		}

		if (block_index < MIC_STARTUP_SKIP_BLOCKS) {
			++block_index;
			clear_button_events();
			continue;
		}
		++block_index;

		/* Mic DSP — the twin of record_microphone's inner loop
		 * (slew limit → decimate-average → DC blocker → gain). */
		int32_t *raw = raw_processing;
		size_t out_frames = (size / sizeof(int32_t)) / MIC_DECIMATION;

		for (size_t frame = 0U; frame < out_frames; ++frame) {
			int32_t first = raw[frame * MIC_DECIMATION] >>
					MIC_SAMPLE_SHIFT;
			int32_t second = raw[frame * MIC_DECIMATION + 1U] >>
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

			if (!hpf_primed) {
				hpf_prev_in = sample;
				hpf_primed = true;
			}
			int32_t filtered =
				sample - hpf_prev_in +
				(int32_t)(((int64_t)MIC_HPF_COEFF_Q15 *
					   hpf_prev_out) >>
					  15);
			hpf_prev_in = sample;
			hpf_prev_out = filtered;

			int32_t amplified = filtered * MIC_GAIN;

			amplified = CLAMP(amplified, INT16_MIN, INT16_MAX);
			mic_stage_samples[stage_frames] = (int16_t)amplified;
			if (++stage_frames == MIC_STAGE_FRAMES) {
				live_tx_offer_stage(mic_stage_samples,
						    MIC_STAGE_FRAMES);
				stage_frames = 0U;
			}
		}
		if (live_stream_failed) {
			result = -EIO;
			break;
		}

		/* The WS thread moves bytes; this loop only decodes. */
		convo_decode_downlink();

		if (atomic_cas(&convo_flush_req, 1, 0)) {
			/* Barge-in: the owner is talking over the agent. */
			dl_jitter_reset();
			tx_resample_reset();
			playing = false;
		}
		if (atomic_get(&convo_end_req)) {
			/* Relay 'end' (mutual silence) or transport close —
			 * a normal conversation ending, not a failure. */
			printk("Conversation ended by relay/transport\n");
			error = 0;
			break;
		}

		/* Solid LED while the agent is audible, blink otherwise. */
		if (playing) {
			gpio_pin_set_dt(&led, 1);
			next_led_toggle = k_uptime_get() + 250;
		} else if (k_uptime_get() >= next_led_toggle) {
			gpio_pin_toggle_dt(&led);
			next_led_toggle = k_uptime_get() + 250;
		}

		if (k_uptime_get() - started_at >
		    (int64_t)CONVO_MAX_SECONDS * 1000) {
			printk("Conversation hit the %u s cap\n",
			       CONVO_MAX_SECONDS);
			break;
		}
		/* Bounce/release edges from the starting press for the first
		 * second; after that a press ends the conversation. */
		if (k_uptime_get() - started_at < 1000) {
			clear_button_events();
		} else if (k_sem_take(&button_press_sem, K_NO_WAIT) == 0) {
			printk("Conversation ended by button\n");
			break;
		}
	}

teardown_clocks:
	if (i2s_running) {
		/*
		 * DROP, never DRAIN: as a clock-slave, draining needs the PWM
		 * clocks to keep running until every queued TX block plays
		 * out — a 12 ms settle is not enough, and killing the clocks
		 * mid-STOPPING wedges i2s_nrfx (configure then fails -EINVAL
		 * until reboot; review finding). DROP forces READY
		 * synchronously and frees the queued blocks; the ≤41 ms of
		 * tail audio it discards is silence or flushed speech.
		 */
		(void)i2s_trigger(i2s, I2S_DIR_BOTH, I2S_TRIGGER_DROP);
		k_msleep(MIC_STOP_SETTLE_MS);
	}
	mic_clocks_stop();
	gpio_pin_set_dt(&led, 0);
teardown:
	atomic_set(&convo_active, 0);
	k_mutex_lock(&ws_lock, K_FOREVER);
	if (pendant_ws_connected() && !stop_sent) {
		(void)pendant_ws_send_text("{\"type\":\"stop\"}");
		stop_sent = true;
	}
	k_mutex_unlock(&ws_lock);
	pendant_opus_stream_abort();
	pendant_opus_reply_decoder_end();
	clear_button_events();
	if (result == 0 && error != 0) {
		result = error;
	}
	return result;
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

	/* Socket I/O lives on its own thread from here on: audio deadlines
	 * on main can never be blocked by a stalled modem send. */
	k_thread_create(&ws_io_thread_data, ws_io_stack,
			K_THREAD_STACK_SIZEOF(ws_io_stack), ws_io_thread_fn,
			NULL, NULL, NULL, WS_IO_PRIORITY, 0, K_NO_WAIT);
	k_thread_name_set(&ws_io_thread_data, "ws_io");

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
		/*
		 * Ready: hold ONE WebSocket open (pings keep Cloudflare's
		 * 100 s idle killer away) instead of rebuilding TLS every
		 * 15 s like the chunked-HTTP prewarm had to.
		 */
		audio_cycle_phase = 0U;
		gpio_pin_set_dt(&led, 0);
		if (!pendant_ws_connected()) {
			int ws_error;

			k_mutex_lock(&ws_lock, K_FOREVER);
			ws_error = pendant_ws_connect();
			k_mutex_unlock(&ws_lock);
			if (ws_error != 0) {
				printk("Idle WS connect failed: %d "
				       "(legacy HTTP path on next press)\n",
				       ws_error);
			}
		}
#if PENDANT_BOOT_AUDIO_CYCLE_TEST
		if (boot_audio_cycle_test_pending) {
			boot_audio_cycle_test_pending = false;
			k_msleep(1500);
			k_sem_give(&button_press_sem);
		}
#endif
		/* Wait for a press. The WS I/O thread keeps the idle socket
		 * alive (pings + stray drains); main only reconnects. */
		while (k_sem_take(&button_press_sem,
				  K_SECONDS(WS_IDLE_PING_SECONDS)) != 0) {
			if (!pendant_ws_connected()) {
				int ws_error;

				k_mutex_lock(&ws_lock, K_FOREVER);
				ws_error = pendant_ws_connect();
				k_mutex_unlock(&ws_lock);
				if (ws_error != 0) {
					printk("Idle WS reconnect failed: %d\n",
					       ws_error);
				}
			}
		}
		/* Latency-first: act on the active edge, never the release. */
		clear_button_events();

		/*
		 * Press = converse. Full-duplex WebSocket when the socket is
		 * up; the proven record-then-reply HTTP cycle when it is not
		 * (that path still journals to microSD when LTE is down).
		 */
		audio_cycle_phase = 1U;
		int64_t lat_press_started = k_uptime_get();

		bool ws_ready = pendant_ws_connected();

		if (!ws_ready) {
			k_mutex_lock(&ws_lock, K_FOREVER);
			ws_ready = pendant_ws_connect() == 0;
			k_mutex_unlock(&ws_lock);
		}
		if (ws_ready) {
			error = run_conversation(i2s);
			gpio_pin_set_dt(&led, 0);
			printk("LAT conversation_ms=%lld result=%d\n",
			       k_uptime_get() - lat_press_started, error);
			report_main_stack_headroom("conversation");
			if (error != 0) {
				audio_cycle_result = error;
				flash_led(4U, 100, 100);
			} else {
				audio_cycle_result = 0;
			}
			clear_button_events();
			continue;
		}

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
		 * Prefer live chunked POST; fall back to microSD single-shot
		 * when prewarm failed, live TX aborted, or stream_end fails.
		 */
		audio_cycle_phase = 3U;
		{
			uint32_t pcm_bytes =
				recorded_samples * (uint32_t)sizeof(int16_t);
			bool live_ok = pendant_cloud_stream_active() &&
				       !live_stream_failed &&
				       pendant_cloud_stream_bytes_sent() > 0U;

			error = -EIO;
			if (live_ok) {
				error = pendant_cloud_stream_end();
				printk("LAT live_stream_end_ms=%lld pcm_bytes=%u "
				       "result=%d\n",
				       k_uptime_get() - lat_press_started,
				       pendant_cloud_uploaded_pcm_bytes, error);
			} else if (pendant_cloud_stream_active()) {
				pendant_cloud_stream_abort();
			}

			if (error < 0 && recording_on_sd && pcm_bytes > 0U) {
				printk("Fallback SD PCM upload (%u bytes) "
				       "(live_result=%d live_sent=%u)\n",
				       pcm_bytes, error,
				       pendant_cloud_stream_bytes_sent());
				error = pendant_cloud_upload_recording(
					SD_RECORDING_PATH, pcm_bytes,
					SAMPLE_RATE);
				printk("LAT fallback_upload_ms=%lld "
				       "pcm_bytes=%u result=%d\n",
				       k_uptime_get() - lat_press_started,
				       pendant_cloud_uploaded_pcm_bytes, error);
			} else if (error < 0) {
				printk("Live stream dead and no SD backup "
				       "(pcm_bytes=%u recording_on_sd=%d)\n",
				       pcm_bytes, recording_on_sd ? 1 : 0);
				error = -EIO;
			}
		}
		report_main_stack_headroom("upload");
		printk("LAT press_to_upload_done_ms=%lld\n",
		       k_uptime_get() - lat_press_started);
		if (error == PENDANT_CLOUD_REPLY_INLINE) {
			/*
			 * Legacy fallback cannot voice replies anymore: the
			 * ESP32 bridge now speaks the duplex wire format
			 * (32-bit slots @31250) and the old 16-bit/24 kHz
			 * player would be noise. The command still executed
			 * and both transcripts + audio are in the dashboard;
			 * voice replies need the WebSocket link.
			 */
			audio_cycle_phase = 6U;
			pendant_cloud_reply_stream_close();
			printk("Reply ready server-side; voice playback "
			       "requires the duplex link (WS was down)\n");
			clear_button_events();
			goto reply_done;
		}
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

		/* Same story as the inline branch: the fallback delivered the
		 * command; the spoken reply lives in the dashboard until the
		 * duplex link is back. */
		audio_cycle_phase = 4U;
		printk("Command delivered via fallback; voice reply "
		       "requires the duplex link (WS was down)\n");

reply_done:
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

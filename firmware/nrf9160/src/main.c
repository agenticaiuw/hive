#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <zephyr/device.h>
#include <zephyr/drivers/adc.h>
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
#include <hal/nrf_saadc.h>
#include <hal/nrf_egu.h>
#include <hal/nrf_dppi.h>
#include <helpers/nrfx_gppi.h>
#include <ff.h>

#include "audio_opus.h"
#include "bench.h"
#include "haptic.h"
#include "pendant_bt.h"
#include "pendant_cloud.h"
#include "pendant_reflex.h"
#include "pendant_status.h"
#include "pendant_store.h"
#include "pendant_ws.h"
#include "tx_resample_taps.h"

#define LED_NODE DT_ALIAS(led0)
#define BUTTON_NODE DT_ALIAS(sw0)
/*
 * Button 2 = drop a moment bookmark.
 *
 * The alternative was a gesture on button 1 (double-press, or press-and-
 * hold), and both cost the thing this firmware protects hardest: button 1
 * acts on the ACTIVE EDGE so the microphone is powering up before the
 * owner's finger has come back off. Any gesture means waiting several
 * hundred ms to find out which gesture it was, on every single press, to
 * serve the rarer of the two actions. A second physical button costs
 * nothing on the hot path.
 */
#define MARK_BUTTON_NODE DT_ALIAS(sw1)
#define I2S_NODE DT_NODELABEL(i2s0)
/*
 * ---- Breadboard hardware controls (parts arrived 2026-08-12) ----
 *
 * Every one of these is optional at boot, exactly like the bookmark
 * button: a control that fails to configure logs once and disappears,
 * because a loose jumper must never brick a voice pendant. Pin claims
 * and pull policy live in the overlay's pendant_controls node; the
 * split of duties here is:
 *
 *   P0.21 yellow  "ask"      — a second body for button 1. It gives the
 *                              SAME semaphore, so every path that already
 *                              understands button 1 (start conversation,
 *                              stop recording, end conversation) hears
 *                              it with zero new states.
 *   P0.22 green   memo       — record-only capture: upload + transcript,
 *                              deliberately no agent planner (?dispatch=0
 *                              — see pendant_cloud_stream_set_memo).
 *   P0.23 blue    push-to-talk — press = record a question with the radio
 *                              OFF, press again = one chunked upload WITH
 *                              the planner, and the short spoken reply
 *                              plays back on the existing reply-speech
 *                              path. See run_ptt_question() for the energy
 *                              ruling that put it here.
 *   P0.24/25      encoder    — quadrature menu navigation AND, through the
 *                              dwell timer, menu select: the owner's knob
 *                              has no switch (three wires: A, C=GND, B), so
 *                              resting on an entry for MENU_DWELL_MS IS the
 *                              press. P0.28 is unwired and unclaimed.
 *   P0.26         mic sense  — watches the SPH0645 VDD net through 100k.
 *                              Low = the owner cut mic power with the
 *                              latching switch: capture must not start,
 *                              and must SAY so rather than record hiss.
 *
 * ---- Sensor/audio additions (same parts order) ----
 *
 *   P0.15 (AIN2)  volume pot — wiper of the knob, polled on the SAADC
 *                              (the ESP32's GPIO34 job, moved here: the
 *                              ESP32 stands in for a dumb BT module, so
 *                              the knob must not live on it).
 *   P0.01         amp SD     — MAX98357A SD_MODE gate. High = wired
 *                              speaker plays the left I2S slot, low =
 *                              amp shutdown. Owner-selected via
 *                              {"type":"audio_sink"} control frames.
 */
#define ASK_BUTTON_NODE DT_ALIAS(ask_btn)
#define MEMO_BUTTON_NODE DT_ALIAS(memo_btn)
#define PTT_BUTTON_NODE DT_ALIAS(ptt_btn)
#define ENCODER_A_NODE DT_ALIAS(encoder_a)
#define ENCODER_B_NODE DT_ALIAS(encoder_b)
#define MIC_SENSE_NODE DT_ALIAS(mic_sense)
#define AMP_SD_MODE_NODE DT_ALIAS(amp_sd_mode)

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
 * while the user is speaking. An i2s_nrfx RX overrun ERRORS the whole
 * transfer (it does not drop-and-continue), so this must ride out codec
 * spikes on the duplex path.
 *
 * Size it ABOVE the driver's queue depth, not equal to it: the driver
 * holds CONFIG_I2S_NRFX_RX_BLOCK_COUNT (6) blocks in its queue PLUS 2
 * latched in hardware, and this loop holds 1 while copying. A 6-block
 * slab therefore died at a 4-block backlog ("Failed to allocate next RX
 * buffer: -12") on a 76 ms loop spike. 10 blocks = a full 6-block (123 ms)
 * backlog with buffers to spare.
 */
#define MIC_RX_BLOCK_COUNT 10U
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
 * Hardware self-test: start a duplex conversation automatically N seconds
 * after boot and end it after PENDANT_BOOT_CONVERSATION_SECONDS. Set to 1
 * to validate the whole duplex path (I2S both directions, live Opus encode
 * + decode, WebSocket, relay, ESP32) from the serial log alone — no button
 * press required. Leave at 0 for normal use.
 */
#define PENDANT_BOOT_CONVERSATION_TEST 0
#define PENDANT_BOOT_CONVERSATION_SECONDS 30U

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
/*
 * TX runway. i2s_nrfx latches 2 buffers in hardware and holds the rest in
 * tx_queue (CONFIG_I2S_NRFX_TX_BLOCK_COUNT). It asks for the next TX buffer
 * in the SAME ISR that completes an RX block, and if that buffer is still
 * missing one block later it declares "Next buffers not supplied on time"
 * and kills the WHOLE duplex transfer, RX included (i2s_nrfx.c:194-203).
 *
 * A 1:1 write-per-read loop therefore runs with ZERO slack and dies on the
 * first 20 ms hiccup — that is exactly what killed conversations on
 * hardware after 1-3.5 s. Instead the loop keeps this queue topped up, so
 * the transfer survives a stall as long as the runway below.
 * 8 queued + 2 latched = 10 blocks = 205 ms, matching the RX slab's depth.
 */
#define CONVO_TX_QUEUE_BLOCKS 8U
#define CONVO_TX_SLAB_BLOCKS (CONVO_TX_QUEUE_BLOCKS + 2U)
/* Fill the runway before START so the first seconds have slack too. */
#define CONVO_TX_PRIME_BLOCKS 6U
/*
 * Decode budget per RX block. RX blocks arrive at 31250/640 = 48.8 Hz, so
 * a cap of N sets a hard ceiling of 48.8*N decoded packets per second. At
 * 60 ms reply frames the stream needs 16.7/s, so 2 leaves ~6x headroom to
 * catch up after a burst. This ceiling is easy to set below the required
 * rate by accident: at 20 ms frames the stream needs 50/s, which a cap of
 * 1 could never meet, and playback starved continuously.
 */
#define CONVO_MAX_DECODES_PER_BLOCK 2U
/* 24 kHz s16 jitter ring: 512 ms of agent speech. Barge-in flushes it, so
 * depth buys LTE-jitter absorption, not conversational latency. */
#define DL_JITTER_BYTES 24576U
#define DL_JITTER_SAMPLES (DL_JITTER_BYTES / sizeof(int16_t))
/*
 * Start/resume playback only with this much banked (200 ms at 24 kHz).
 * Every starve pauses output and re-arms, which is audible as chopping —
 * hardware runs showed 8 of them in 22 s at the old 128 ms gate.
 */
#define DL_PREBUFFER_SAMPLES 4800U
/*
 * Worst case one downlink WS frame decodes to: the relay caps frames at 4
 * packets AND 500 B, each packet 60 ms (1440 samples at 24 kHz). The
 * receive gate needs at least this much ring space free, and the ring must
 * clear DL_PREBUFFER_SAMPLES afterwards or the prebuffer could never fill.
 * 2 packets x 60 ms x 24 kHz = 2880 samples.
 */
#define DL_WORST_FRAME_SAMPLES 2880U
BUILD_ASSERT(DL_JITTER_SAMPLES - DL_WORST_FRAME_SAMPLES >=
		     DL_PREBUFFER_SAMPLES + 1440U,
	     "receive gate must clear the prebuffer with a packet to spare");
/* Largest downlink WS frame the relay may send (packet-aligned, ≤500 B). */
#define WS_RX_BUF_BYTES 640U
/* ~120 ms of Opus per uplink frame: batching overhead vs VAD latency. */
#define WS_TX_BATCH_BYTES 240U
/*
 * ---- Adaptive duplex uplink ----
 *
 * LTE-M Cat-M1 is half-duplex. While the agent's reply streams down, the modem
 * cannot transmit, so the uplink FIFO fills at the encoder's rate and drains at
 * roughly zero. A live 42 s conversation ended with fifo_left=7146 — the 7 KiB
 * ring 100% full — uplink_drops=388, and "WS send failed: -116" nine seconds
 * later. The user's follow-up question was encoded straight into a full ring
 * and discarded by live_opus_packet_sink, so the agent never answered it while
 * the LED went right on blinking.
 *
 * Two levers, engaged only while downlink audio is playing:
 *
 *   DUCK - halve the uplink Opus target bitrate. The mic stream stays
 *          continuous, so server-side barge-in still sees the user, but the
 *          ring fills half as fast: the runway grows from ~3.5 s to ~7 s,
 *          which covers a typical agent utterance.
 *   HOLD - past the high-water mark, stop feeding the encoder at all. The
 *          packet would have been discarded by the sink anyway, so the splice
 *          in the uplink stream is identical and the measured ~15 ms encode is
 *          saved. What it actually buys is the reserve *below* the mark: when
 *          the agent stops talking the ring still has room for the user's next
 *          words, instead of the zero headroom the failing call ended with.
 *
 * Pausing capture outright was the other option in the proposal and is wrong
 * here: barge-in is server-side, so a muted uplink makes the agent
 * uninterruptible. Ducking degrades that path instead of removing it.
 */
#define CONVO_UPLINK_DUCK_BPS (PENDANT_OPUS_BITRATE / 2U)
/*
 * Downlink frames arrive in bursts and the jitter ring briefly empties between
 * them; without a hangover the duck would chatter the encoder every block.
 */
#define CONVO_DL_ACTIVE_HANGOVER_MS 300
/* Hold above 60% of the ring, release below 40%: the top ~2.8 KiB (≈1.4 s at
 * full rate) stays reserved for speech that arrives after the agent stops. */
#define CONVO_UPLINK_HOLD_BYTES ((OPUS_TX_FIFO_BYTES * 3U) / 5U)
#define CONVO_UPLINK_RESUME_BYTES ((OPUS_TX_FIFO_BYTES * 2U) / 5U)
BUILD_ASSERT(CONVO_UPLINK_RESUME_BYTES < CONVO_UPLINK_HOLD_BYTES,
	     "uplink hold needs hysteresis or it toggles every block");
/* Exact 24000/31250 ratio for the TX upsampler (96/125). */
#define TX_RESAMPLE_NUM 96U
#define TX_RESAMPLE_DEN 125U
/* Idle keepalive: under Cloudflare's 100 s WS idle kill. */
#define WS_IDLE_PING_SECONDS 25U

/* Decoder state arena (18,404 B measured + margin) — concurrent with the
 * encoder in audio_workspace, so it cannot time-share that block. */
static uint8_t opus_dec_arena[18432] __aligned(4);
/*
 * Downlink jitter ring — SPSC across threads: main decodes into it (owns
 * head), the audio thread drains it into I2S (owns tail). Fill is derived
 * from the two indices, never a shared counter.
 */
static int16_t dl_jitter[DL_JITTER_SAMPLES];
static volatile size_t dl_jitter_head;
static volatile size_t dl_jitter_tail;
static int16_t dl_decode_buf[1440]; /* one 60 ms wire packet at 24 kHz */

/*
 * ---- Audio thread ----
 *
 * i2s_nrfx kills the ENTIRE duplex transfer if the app misses a buffer
 * deadline by one block (20.48 ms) — "No room in RX queue" / "Failed to
 * allocate next RX buffer". Opus encode+decode on the same thread spiked
 * to 91 ms, so no buffer depth could ever make that safe.
 *
 * This thread therefore does ONLY pointer shuffling: read an RX block,
 * hand the pointer to main, keep the TX runway full. It never touches a
 * codec, so its loop is microseconds. It runs at a cooperative priority so
 * it always wins over main, and it blocks on i2s_read every iteration
 * (never starving the system). When main falls behind, mic blocks are
 * dropped — audio degrades, the transfer survives.
 */
#define AUDIO_THREAD_STACK_BYTES 1536
#define AUDIO_THREAD_PRIORITY -2
#define MIC_RAW_QUEUE_SLOTS 6U
static K_THREAD_STACK_DEFINE(audio_thread_stack, AUDIO_THREAD_STACK_BYTES);
static struct k_thread audio_thread_data;
K_MSGQ_DEFINE(mic_raw_q, sizeof(void *), MIC_RAW_QUEUE_SLOTS, sizeof(void *));
static const struct device *audio_i2s_dev;
static atomic_t audio_thread_error;

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
static K_THREAD_STACK_DEFINE(ws_io_stack, WS_IO_STACK_BYTES);
static struct k_thread ws_io_thread_data;
static K_MUTEX_DEFINE(ws_lock); /* serializes pendant_ws_* across threads */
/*
 * Downlink frames cross threads as whole messages, never a byte stream: a
 * message queue makes every get atomic, so a torn or mis-framed record is
 * structurally impossible and no free-space bookkeeping is needed.
 */
struct dl_frame {
	uint16_t length;
	uint8_t data[WS_RX_BUF_BYTES];
};
#define DL_FRAME_SLOTS 6U
K_MSGQ_DEFINE(dl_frames, sizeof(struct dl_frame), DL_FRAME_SLOTS, 4);
static atomic_t convo_active;    /* audio loop live: pump/recv at full rate */
/*
 * The relay's {started} for THIS conversation. The WebSocket outlives
 * individual conversations, so the previous one's trailing {end} (and any
 * late reply audio) can still be in flight when the next one begins —
 * which killed a fresh conversation 80 ms in. Nothing from the downlink
 * counts until {started} arrives.
 */
static atomic_t convo_started;
static atomic_t convo_flush_req; /* relay said flush (barge-in) */
static atomic_t convo_end_req;   /* relay said end / transport died */
/*
 * Uplink gate: 1 = the WS I/O thread may drain the encoder FIFO onto the
 * radio, 0 = it must leave the bytes where they are. Set to 1 before the
 * first mic block of a conversation and cleared at teardown, so a stray
 * pump between presses can never transmit.
 */
static atomic_t convo_uplink_gate;
static uint8_t ws_rx_buf[WS_RX_BUF_BYTES];  /* ws thread only */
static struct dl_frame dl_tx_frame;         /* ws thread only */
static struct dl_frame dl_rx_frame;         /* main thread only */
/* Duplex diagnostics — printed at every conversation end. */
static uint32_t convo_tx_blocks;
/*
 * Underrun EVENTS, not silent samples. The runway running dry is normal at the
 * tail of every agent utterance, so counting per sample just measures how long
 * the agent stayed quiet. Only the dry/not-dry transition says the decoder
 * failed to keep up.
 */
static uint32_t convo_tx_starved;
static bool convo_tx_dry;
static uint32_t convo_rx_blocks;
static uint32_t convo_decoded_packets;
static uint32_t convo_max_loop_ms;
static uint32_t convo_uplink_drops;
static uint32_t convo_mic_drops;
static uint32_t convo_tx_peak;
/*
 * Adaptive duplex uplink state. Main thread only: the conversation loop is the
 * sole writer and live_tx_offer_stage (same thread) the sole reader, so no
 * atomics are needed. convo_uplink_held / convo_uplink_duck_ms are the effect
 * counters — read them against uplink_drops to see whether the duck actually
 * kept the ring off its ceiling.
 */
static bool convo_uplink_ducked;
static bool convo_uplink_holding;
static int64_t convo_dl_active_until;
static int64_t convo_adapt_last_ms;
static uint32_t convo_uplink_duck_ms;
static uint32_t convo_uplink_held;
/*
 * Codec cost, measured not guessed. The 32.768 kHz cycle counter gives
 * 30.5 us resolution — plenty for multi-millisecond codec calls, and it
 * settles whether a given sample rate actually fits the CPU budget.
 */
static uint32_t convo_decode_cycles;
static uint32_t convo_decode_calls;
static uint32_t convo_decode_max_cycles;
static uint32_t convo_encode_cycles;
static uint32_t convo_encode_calls;
static uint32_t convo_encode_max_cycles;

static inline uint32_t cycles_to_us(uint32_t cycles)
{
	return (uint32_t)(((uint64_t)cycles * 1000000U) /
			  sys_clock_hw_cycles_per_sec());
}
K_MEM_SLAB_DEFINE_STATIC(convo_tx_slab,
			 CONVO_TX_BLOCK_FRAMES * sizeof(int32_t),
			 CONVO_TX_SLAB_BLOCKS, 4);

static const struct gpio_dt_spec led =
	GPIO_DT_SPEC_GET(LED_NODE, gpios);
static const struct gpio_dt_spec button =
	GPIO_DT_SPEC_GET(BUTTON_NODE, gpios);
static struct gpio_callback button_callback;
#ifdef CONFIG_PENDANT_OFFLINE_STORE
static const struct gpio_dt_spec mark_button =
	GPIO_DT_SPEC_GET(MARK_BUTTON_NODE, gpios);
static struct gpio_callback mark_button_callback;
#endif
static FATFS sd_fat_fs;
static struct fs_mount_t sd_mount = {
	.type = FS_FATFS,
	.mnt_point = SD_MOUNT_POINT,
	.fs_data = &sd_fat_fs,
	.flags = FS_MOUNT_FLAG_NO_FORMAT,
};

K_SEM_DEFINE(button_press_sem, 0, 1);
#ifdef CONFIG_PENDANT_OFFLINE_STORE
K_SEM_DEFINE(mark_press_sem, 0, 1);
#endif

/* ---- Hardware-control state (see the pin table at the top) ---- */
static const struct gpio_dt_spec ask_button =
	GPIO_DT_SPEC_GET(ASK_BUTTON_NODE, gpios);
static struct gpio_callback ask_button_callback;
static const struct gpio_dt_spec memo_button =
	GPIO_DT_SPEC_GET(MEMO_BUTTON_NODE, gpios);
static struct gpio_callback memo_button_callback;
static const struct gpio_dt_spec ptt_button =
	GPIO_DT_SPEC_GET(PTT_BUTTON_NODE, gpios);
static struct gpio_callback ptt_button_callback;
static const struct gpio_dt_spec encoder_a =
	GPIO_DT_SPEC_GET(ENCODER_A_NODE, gpios);
static const struct gpio_dt_spec encoder_b =
	GPIO_DT_SPEC_GET(ENCODER_B_NODE, gpios);
static struct gpio_callback encoder_callback;
static const struct gpio_dt_spec mic_sense =
	GPIO_DT_SPEC_GET(MIC_SENSE_NODE, gpios);
/* Sense pin configured OK? Without it, "muted" must never be inferred:
 * a broken sense wire has to fail toward a working microphone. */
static bool mic_sense_ready;
/* True while record_microphone is running on the GREEN button's behalf, so
 * a second green press stops a memo the way button 1 stops a command —
 * without the green button ever being able to cut a command capture short.
 * Main thread only. */
static bool memo_capture_active;
/* Same story for the BLUE button's push-to-talk capture: the button that
 * started a recording is the button that stops it. Main thread only. */
static bool ptt_capture_active;
/*
 * Force record_microphone to keep the modem out of it: no stream_ensure, no
 * live uplink, journal straight to the card. This is the whole energy
 * argument of push-to-talk (see run_ptt_question), expressed as one latch
 * on the one line that would otherwise open a socket at press time.
 */
static bool capture_radio_off;

K_SEM_DEFINE(memo_press_sem, 0, 1);
K_SEM_DEFINE(ptt_press_sem, 0, 1);

/*
 * Owner-decision control frames, produced on main/ISR/workqueue and consumed
 * by the WS I/O thread — the one place allowed to touch the socket, so a
 * stalled modem send can never block a button ISR or the codec loop. Contract
 * per the wire spec: sent only while the converse socket is OPEN; a closed
 * socket drops them (a menu twist from a dead zone is stale the moment
 * the link returns).
 */
static atomic_t menu_step_backlog;     /* signed detents not yet sent */
static atomic_t menu_select_req;       /* set by the dwell timer, not a push */
/* Cap unsent detents: past this the owner is spinning against a dead
 * link and older steps carry no information a fresher one lacks. */
#define MENU_STEP_BACKLOG_MAX 8
/*
 * DWELL — the select gesture, because there is no button to press.
 *
 * Owner's ruling, 2026-08-12: "we're not going to use the button on the
 * rotary encoder." Their encoder is the illuminated type; only the three
 * rotation pins are wired (A -> P0.24, C -> GND, B -> P0.25), so P0.28 is
 * unwired and its handler is gone. Without a press there is no select and
 * no escape, and the owner could scroll the app ring forever without ever
 * entering anything — so RESTING is the press: MENU_DWELL_MS after the last
 * detent the firmware emits {"type":"menu_select"} once.
 *
 * 1500 ms is the tuned middle. Shorter and the ring fires while the owner is
 * still hunting between entries (a 300 ms pause between detents is normal
 * hand speed); much longer and the device reads as broken, because on a
 * screenless ring nothing on earth tells you a selection is coming.
 */
#define MENU_DWELL_MS 1500

/*
 * ---- Wired speaker (MAX98357A) sink selection ----
 *
 * The amp taps the SAME I2S TX wires the ESP32 listens on (BCLK P0.18,
 * LRCLK P0.17, DIN P0.19) — there is no second audio path in firmware,
 * only the SD_MODE gate on P0.01.  Driven high the amp reproduces the
 * left I2S slot (the only slot this firmware writes audio into; MAX98357A
 * datasheet Table 5: V_SD_MODE > 1.4 V selects the left word), driven low
 * it is in 0.6 uA shutdown.  The ESP32 cannot be gated from here, so the
 * three sink states map to one pin:
 *
 *   bluetooth  SD_MODE low   (boot default — the proven path)
 *   speaker    SD_MODE high  (ESP32 keeps hearing the wire; whether it
 *   both       SD_MODE high   also PLAYS is the relay/ESP32's business)
 *
 * Selected over the converse socket by {"type":"audio_sink","sink":...},
 * parsed on the WS I/O thread next to the other control frames.  The
 * format on the wire needs no change for the amp: 24-bit words in 32-BCLK
 * slots at 31250 frames/s — the MAX98357A DAI accepts 16/24/32-bit I2S at
 * 8-96 kHz sample rates ("Digital Audio Interface Modes", datasheet
 * p.16); 31250 Hz sits in the 30-50 kHz digital-filter bin (Table 4) and
 * is within the frequency detector's 32 kHz class (-2.4 %, far inside
 * the part's tolerance for LRCLK tracking).
 */
enum audio_sink_sel {
	AUDIO_SINK_BLUETOOTH = 0,
	AUDIO_SINK_SPEAKER,
	AUDIO_SINK_BOTH,
};
#define AUDIO_SINK_BOOT_DEFAULT AUDIO_SINK_BLUETOOTH
static const struct gpio_dt_spec amp_sd_mode =
	GPIO_DT_SPEC_GET(AMP_SD_MODE_NODE, gpios);
static bool amp_sd_mode_ready;
static uint8_t audio_sink_current = AUDIO_SINK_BOOT_DEFAULT;

/*
 * ---- Volume knob (pot wiper on SAADC AIN2/P0.15) ----
 *
 * Moved from the ESP32 (GPIO34) by architecture ruling: the ESP32 is a
 * stand-in for a dumb Bluetooth module, so the knob and its gain must
 * live on the nRF9160 and the wire must carry pre-scaled PCM.  Constants
 * are the ESP32 tuning carried over 1:1 (same 12-bit scale): ~20 Hz
 * poll, 2 % hysteresis over the wiper noise, end-stop snap so true 0 and
 * true unity are reachable, perceptual (squared) curve because loudness
 * tracks power.  The knob is an ATTENUATOR, never an amplifier: unity is
 * the ceiling, which is why the Q12 multiply in tx_apply_volume needs no
 * saturation — nothing can exceed the already-clamped input sample.
 */
#define VOLUME_POLL_INTERVAL_MS 50
#define VOLUME_HYSTERESIS_COUNTS 82
#define VOLUME_SNAP_LOW 40
#define VOLUME_SNAP_HIGH 4055
#define VOLUME_RAW_MAX 4095
#define VOLUME_GAIN_UNITY_Q12 4096
/* Written by volume_poll (main thread), read per-sample by the audio
 * thread: a plain aligned word, atomic on this core by construction. */
static atomic_t volume_gain_q12 = ATOMIC_INIT(VOLUME_GAIN_UNITY_Q12);
/* Pending {"type":"volume"} report for the WS I/O thread: -1 = nothing,
 * else (hundredths << 16) | raw.  Same drop-when-closed contract as the
 * other owner controls. */
static atomic_t volume_report = ATOMIC_INIT(-1);
static bool volume_adc_ready;
static int volume_last_raw = -1;
static int64_t volume_next_poll_ms;

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

#ifdef CONFIG_PENDANT_MIC_INJECT
/* G.711 expansion for the debug injection ring (harness builds only). */
static int16_t ulaw_to_linear(uint8_t code)
{
	uint8_t u = (uint8_t)(~code);
	int32_t t = (((u & 0x0F) << 3) + 0x84) << ((u >> 4) & 0x07);

	return (int16_t)((u & 0x80U) ? (0x84 - t) : (t - 0x84));
}
#endif /* CONFIG_PENDANT_MIC_INJECT */

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
		if (atomic_get(&convo_active)) {
			/*
			 * A conversation outlives a radio stall: drop this
			 * packet (Opus is loss-tolerant and the frame stays
			 * length-prefixed) and keep talking, instead of
			 * latching saturation and ending the call.
			 */
			++convo_uplink_drops;
			return 0;
		}
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
	/*
	 * Adaptive duplex HOLD: the ring is past its high-water mark while the
	 * agent is still talking, so this stage cannot reach the relay. Encoding
	 * it would only hand the sink a packet to discard — same gap in the
	 * stream, ~15 ms of CPU wasted, and the reserve below the mark spent on
	 * audio nobody will hear.
	 */
	if (convo_uplink_holding) {
		++convo_uplink_held;
		return;
	}
	uint32_t encode_started = k_cycle_get_32();

	error = pendant_opus_stream_feed(samples, frame_count);

	uint32_t encode_elapsed = k_cycle_get_32() - encode_started;

	convo_encode_cycles += encode_elapsed;
	++convo_encode_calls;
	if (encode_elapsed > convo_encode_max_cycles) {
		convo_encode_max_cycles = encode_elapsed;
	}
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

	/*
	 * The DK's own button 1 and the external yellow button share this
	 * handler and this semaphore on purpose (see ASK_BUTTON_NODE), so the
	 * bench has to be told which one actually moved — a telemetry line
	 * claiming P0.21 fired because someone pressed the board's button
	 * would be worse than no line at all. Zephyr hands the callback the
	 * real fired-pin mask, so the discrimination is exact rather than
	 * inferred.
	 */
	if (pins & BIT(ask_button.pin)) {
		pendant_bench_note_button(PENDANT_BENCH_YELLOW);
	}
	k_sem_give(&button_press_sem);
}

/*
 * Debug press hook: a debugger (J-Link) can write 1 here to simulate a
 * button press without touching the hardware —
 *   JLinkExe -device nRF9160_xxAA -if SWD -speed 4000 -autoconnect 1
 *   w4 <&pendant_remote_press> 1
 * Polled wherever the firmware waits on the button.
 */
volatile uint32_t pendant_remote_press;

static bool take_remote_press(void)
{
	if (pendant_remote_press == 0U) {
		return false;
	}
	pendant_remote_press = 0U;
	return true;
}

/* ---- Hardware-control ISRs and pollers ---- */

static void memo_button_pressed(const struct device *port,
				struct gpio_callback *callback,
				gpio_port_pins_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(callback);
	ARG_UNUSED(pins);
	pendant_bench_note_button(PENDANT_BENCH_GREEN);
	k_sem_give(&memo_press_sem);
}

static void ptt_button_pressed(const struct device *port,
			       struct gpio_callback *callback,
			       gpio_port_pins_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(callback);
	ARG_UNUSED(pins);
	pendant_bench_note_button(PENDANT_BENCH_BLUE);
	k_sem_give(&ptt_press_sem);
}

static bool take_memo_press(void)
{
	return k_sem_take(&memo_press_sem, K_NO_WAIT) == 0;
}

static void clear_memo_events(void)
{
	while (k_sem_take(&memo_press_sem, K_NO_WAIT) == 0) {
	}
}

static bool take_ptt_press(void)
{
	return k_sem_take(&ptt_press_sem, K_NO_WAIT) == 0;
}

static void clear_ptt_events(void)
{
	while (k_sem_take(&ptt_press_sem, K_NO_WAIT) == 0) {
	}
}

/*
 * Quadrature decode, both edges of both phases, via the standard Gray-code
 * transition table — NOT edge counting. Contact bounce only ever toggles
 * between two ADJACENT states, so a bouncing contact contributes +1 -1 +1
 * -1 ... which sums to nothing; an invalid two-bit jump (electrical noise)
 * scores 0 outright. A mechanical detent is four valid transitions, so the
 * accumulator emits one menu step per ±4 and the half-states a finger
 * resting between detents produces are never heard upstream.
 */
static const int8_t encoder_quad_table[16] = {
	0, -1, 1, 0, 1, 0, 0, -1, -1, 0, 0, 1, 0, 1, -1, 0,
};
static uint8_t encoder_prev_state;
static int8_t encoder_detent_accum;

/*
 * The dwell timer: the whole select gesture, and deliberately NOT in the ISR.
 *
 * The ISR's only new job is one k_work_reschedule() per detent (ISR-safe, and
 * a reschedule is a cancel+arm, which is exactly "any new detent restarts the
 * countdown"). The commit itself runs on the system workqueue — it touches an
 * atomic and asks for a haptic, the same two things the old push handler did —
 * and the WS I/O thread still owns the socket. Nothing about the
 * ISR -> atomics -> WS-thread path changed; a timer was inserted in front of
 * the atomic.
 *
 * NO REPEAT FIRE. The work item is one-shot and only a detent ever arms it, so
 * a knob left resting on an entry selects exactly once. That is the property
 * that makes dwell safe to use as the only select verb: a pendant swinging on
 * its lanyard against a still ring cannot start a timer every 1.5 s.
 */
static struct k_work_delayable menu_dwell_work;

static void menu_dwell_expired(struct k_work *work)
{
	ARG_UNUSED(work);

	/*
	 * Same drop-when-closed contract the detents themselves have: if the
	 * scrolls never reached the relay there is no ring position to commit,
	 * and a tick on a resting knob with no conversation open would be the
	 * device claiming a selection it did not make. Silence is correct here.
	 */
	if (!pendant_ws_connected()) {
		return;
	}
	atomic_set(&menu_select_req, 1);
	/* The buzz fires at the COMMIT, not at the send: dwell has no press to
	 * acknowledge, so this tick is the owner's only evidence that the ring
	 * just took their entry. Non-blocking (work-queue engine), so asking for
	 * it from a work handler costs nothing. */
	haptic_trigger(HAPTIC_PATTERN_TICK);
}

static uint8_t encoder_read_state(void)
{
	/* Raw levels, not logical: quadrature only cares about transitions,
	 * and the raw read avoids two layered driver calls in an ISR. */
	return (uint8_t)((nrf_gpio_pin_read(encoder_a.pin) << 1) |
			 nrf_gpio_pin_read(encoder_b.pin));
}

static void encoder_edge_isr(const struct device *port,
			     struct gpio_callback *callback,
			     gpio_port_pins_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(callback);
	ARG_UNUSED(pins);

	uint8_t state = encoder_read_state();
	int8_t increment =
		encoder_quad_table[(encoder_prev_state << 2) | state];

	encoder_prev_state = state;
	if (increment == 0) {
		return;
	}
	encoder_detent_accum += increment;
	if (encoder_detent_accum >= 4 || encoder_detent_accum <= -4) {
		int step = encoder_detent_accum > 0 ? 1 : -1;
		atomic_val_t backlog = atomic_get(&menu_step_backlog);

		encoder_detent_accum = 0;
		/*
		 * Counted here rather than off the backlog: the backlog is
		 * capped and cleared when the link is down, so counting it
		 * would make the bench report "the knob stopped working" for
		 * what is really "the socket is closed". The detent happened
		 * either way, and that is the wire question.
		 */
		pendant_bench_note_detent(step);
		/* Single ISR producer, so this check-then-add cannot race
		 * itself; the WS thread only ever moves the value toward
		 * zero, which makes the cap conservative, never wrong. */
		if (backlog < MENU_STEP_BACKLOG_MAX &&
		    backlog > -MENU_STEP_BACKLOG_MAX) {
			atomic_add(&menu_step_backlog, step);
		}
		/*
		 * Restart the dwell on every detent — including one the backlog
		 * cap just dropped. The cap is about what is worth sending; the
		 * dwell is about whether the owner's hand is still moving, and
		 * a hand that is moving has not chosen anything yet.
		 */
		(void)k_work_reschedule(&menu_dwell_work, K_MSEC(MENU_DWELL_MS));
	}
}

/*
 * The mic-power sense reads the SPH0645 VDD net through 100k. Logical 0 =
 * the latching switch has the mic dark. A sense pin that never configured
 * reports "not muted": the failure mode of a missing wire must be a
 * working microphone, not a pendant that silently refuses to listen.
 */
static bool mic_power_is_cut(void)
{
	return mic_sense_ready && gpio_pin_get_dt(&mic_sense) == 0;
}

/* ---- Volume knob: SAADC one-shot polling ---- */

#if DT_NODE_HAS_STATUS(DT_NODELABEL(adc), okay)
static const struct device *const volume_adc =
	DEVICE_DT_GET(DT_NODELABEL(adc));
#define VOLUME_ADC_CHANNEL_ID 2

static void volume_adc_init(void)
{
	/*
	 * VDD/4 reference with 1/4 gain makes the conversion ratiometric to
	 * the very rail the pot spans: full scale IS the rail, so a sagging
	 * breadboard supply cancels out of the knob position entirely.
	 * 10 us acquisition covers the wiper's worst-case source impedance
	 * (a 50 k pot at mid-travel is 12.5 k; the SAADC spec allows up to
	 * 40 k at 10 us).
	 */
	static const struct adc_channel_cfg cfg = {
		.gain = ADC_GAIN_1_4,
		.reference = ADC_REF_VDD_1_4,
		.acquisition_time =
			ADC_ACQ_TIME(ADC_ACQ_TIME_MICROSECONDS, 10),
		.channel_id = VOLUME_ADC_CHANNEL_ID,
		/* P0.15, the last free AIN */
		.input_positive = NRF_SAADC_INPUT_AIN2,
	};

	if (!device_is_ready(volume_adc) ||
	    adc_channel_setup(volume_adc, &cfg) != 0) {
		printk("Volume knob (P0.15/AIN2) not configured — unity "
		       "gain\n");
		return;
	}
	volume_adc_ready = true;
	printk("Volume knob ready (P0.15/AIN2, ratiometric, ~20 Hz poll)\n");
}

static int volume_adc_read_raw(void)
{
	int16_t sample;
	struct adc_sequence sequence = {
		.channels = BIT(VOLUME_ADC_CHANNEL_ID),
		.buffer = &sample,
		.buffer_size = sizeof(sample),
		.resolution = 12,
		/* 4x hardware oversample: the SAADC's flicker at this gain
		 * is a couple of LSB; burst-averaging in silicon is cheaper
		 * than the ESP32's median-of-five in code. */
		.oversampling = 2U,
	};

	if (adc_read(volume_adc, &sequence) != 0) {
		return -1;
	}
	/* Single-ended reads can dip a hair below zero near GND. */
	return CLAMP((int)sample, 0, VOLUME_RAW_MAX);
}
#else
static void volume_adc_init(void)
{
	printk("Volume knob: no ADC in devicetree — unity gain\n");
}

static int volume_adc_read_raw(void)
{
	return -1;
}
#endif /* adc */

/*
 * ~20 Hz knob poll, callable from any loop that turns often enough (the
 * idle wait at 200 ms and the conversation loop at ~20 ms both call it;
 * the interval gate makes extra calls free).  One blocking one-shot read
 * costs tens of microseconds — noise against the 205 ms TX runway.
 * Hysteresis (>=2 % movement) keeps a resting knob silent; the end-stop
 * snap lets true 0 and true unity be reached, which hysteresis alone
 * would forbid.  The curve is squared (perceived loudness tracks power),
 * identical to the ESP32 implementation this replaces.
 */
static void volume_poll(void)
{
	int64_t now = k_uptime_get();
	int raw;
	uint32_t gain;
	uint32_t hundredths;

	if (!volume_adc_ready || now < volume_next_poll_ms) {
		return;
	}
	volume_next_poll_ms = now + VOLUME_POLL_INTERVAL_MS;

	raw = volume_adc_read_raw();
	if (raw < 0) {
		return;
	}
	/*
	 * The bench sees the count BEFORE the end-stop snap and the 2 %
	 * hysteresis below. Those exist so a resting knob does not retrigger
	 * the volume path; a bench that inherited them would tell the owner
	 * their pot is dead through the first 80 counts of travel.
	 */
	pendant_bench_note_pot(raw);
	if (raw <= VOLUME_SNAP_LOW) {
		raw = 0;
	} else if (raw >= VOLUME_SNAP_HIGH) {
		raw = VOLUME_RAW_MAX;
	}
	if (volume_last_raw >= 0 &&
	    (raw > volume_last_raw ? raw - volume_last_raw
				   : volume_last_raw - raw) <
		    VOLUME_HYSTERESIS_COUNTS &&
	    raw != 0 && raw != VOLUME_RAW_MAX) {
		return;
	}
	if (raw == volume_last_raw) {
		return;
	}
	volume_last_raw = raw;

	/* level = (raw/4095)^2, folded straight into Q12. */
	gain = (uint32_t)(((uint64_t)raw * (uint64_t)raw *
			   VOLUME_GAIN_UNITY_Q12 +
			   ((uint64_t)VOLUME_RAW_MAX * VOLUME_RAW_MAX / 2U)) /
			  ((uint64_t)VOLUME_RAW_MAX * VOLUME_RAW_MAX));
	atomic_set(&volume_gain_q12, (atomic_val_t)gain);

	hundredths = (gain * 100U + VOLUME_GAIN_UNITY_Q12 / 2U) /
		     VOLUME_GAIN_UNITY_Q12;
	atomic_set(&volume_report,
		   (atomic_val_t)((hundredths << 16) | (uint32_t)raw));
	printk("Volume: raw=%d level=%u.%02u\n", raw, hundredths / 100U,
	       hundredths % 100U);
}

/* ---- Wired speaker sink gate ---- */

static const char *audio_sink_name(uint8_t sink)
{
	switch (sink) {
	case AUDIO_SINK_SPEAKER:
		return "speaker";
	case AUDIO_SINK_BOTH:
		return "both";
	default:
		return "bluetooth";
	}
}

/* Safe from any thread: one gpio_pin_set_dt on a pin only this touches, plus
 * a flag the idle loop acts on. */
static void audio_sink_apply(uint8_t sink)
{
	audio_sink_current = sink;
	if (amp_sd_mode_ready) {
		gpio_pin_set_dt(&amp_sd_mode, sink != AUDIO_SINK_BLUETOOTH);
	}
	/*
	 * Choosing Bluetooth as the sink is also an instruction to HAVE a
	 * Bluetooth link: a sink selection that leaves the module idle would
	 * route the next answer into silence. The request is only a flag —
	 * pendant_bt_poll on main owns the UART.
	 */
	if (sink != AUDIO_SINK_SPEAKER && !pendant_bt_link_up()) {
		pendant_bt_request_connect();
	}
	printk("Audio sink: %s%s\n", audio_sink_name(sink),
	       amp_sd_mode_ready ? "" : " (amp gate not configured)");
}

/*
 * {"type":"audio_sink","sink":"speaker"|"bluetooth"|"both"} — parsed with
 * the same bounded strstr discipline as the legacy control frames, AFTER
 * the exact-match recipe check for the same reason they are.
 */
static bool audio_sink_offer_frame(const char *frame)
{
	if (strstr(frame, "\"audio_sink\"") == NULL) {
		return false;
	}
	if (strstr(frame, "\"speaker\"") != NULL) {
		audio_sink_apply(AUDIO_SINK_SPEAKER);
	} else if (strstr(frame, "\"both\"") != NULL) {
		audio_sink_apply(AUDIO_SINK_BOTH);
	} else if (strstr(frame, "\"bluetooth\"") != NULL) {
		audio_sink_apply(AUDIO_SINK_BLUETOOTH);
	} else {
		printk("Audio sink frame with unknown sink — kept %s\n",
		       audio_sink_name(audio_sink_current));
	}
	return true;
}

#ifdef CONFIG_PENDANT_OFFLINE_STORE
static void mark_button_pressed(const struct device *port,
				struct gpio_callback *callback,
				gpio_port_pins_t pins)
{
	ARG_UNUSED(port);
	ARG_UNUSED(callback);
	ARG_UNUSED(pins);
	k_sem_give(&mark_press_sem);
}

/*
 * Same shape as pendant_remote_press: plain volatile globals a J-Link writes
 * over SWD, no protocol on the target.
 *
 *   w4 <&pendant_remote_mark> 1     drop a moment bookmark
 *   w4 <&pendant_remote_offline> 1  take the modem OFFLINE (CFUN=4)
 *   w4 <&pendant_remote_offline> 0  bring it back and reattach
 *
 * pendant_remote_offline is how the offline path is proven without shielding
 * the antenna: it is the only way to make "no usable link" a repeatable
 * condition rather than a story about a lift shaft.
 */
volatile uint32_t pendant_remote_mark;
volatile uint32_t pendant_remote_offline;
static bool link_forced_offline;

static bool take_mark_press(void)
{
	if (k_sem_take(&mark_press_sem, K_NO_WAIT) == 0) {
		return true;
	}
	if (pendant_remote_mark != 0U) {
		pendant_remote_mark = 0U;
		return true;
	}
	return false;
}

/*
 * Apply the debug offline request. Closing the WebSocket first matters: the
 * socket is modem-offloaded, so dropping RF underneath it leaves a
 * descriptor that reports connected and fails every send.
 */
static void apply_forced_link_state(void)
{
	bool want_offline = pendant_remote_offline != 0U;

	if (want_offline == link_forced_offline) {
		return;
	}
	if (want_offline) {
		printk("DEBUG: forcing link offline (store-and-forward test)\n");
		k_mutex_lock(&ws_lock, K_FOREVER);
		pendant_ws_close();
		k_mutex_unlock(&ws_lock);
		pendant_cloud_stream_abort();
		/*
		 * Latch BEFORE powering the radio down: pendant_cloud's
		 * ensure_lte_data_ready() resumes a suspended radio in front
		 * of every socket, so suspending alone lasts exactly until
		 * the next press and the capture would come back online
		 * mid-test.
		 */
		pendant_cloud_block_link(true);
		(void)pendant_cloud_suspend_radio();
		link_forced_offline = true;
	} else {
		printk("DEBUG: restoring link\n");
		pendant_cloud_block_link(false);
		(void)pendant_cloud_resume_radio();
		link_forced_offline = false;
	}
}

static bool link_is_forced_offline(void)
{
	return link_forced_offline;
}
#else
static inline void apply_forced_link_state(void) {}
static inline bool link_is_forced_offline(void)
{
	return false;
}
static inline bool take_mark_press(void)
{
	return false;
}
#endif /* CONFIG_PENDANT_OFFLINE_STORE */

/*
 * Button 2 double-press gesture detector (reflex trigger).
 *
 * The single press stays a bookmark, and the header's original argument
 * for button 2 still holds: never make the COMMON action wait for gesture
 * disambiguation.  So the 600 ms second-press window opens ONLY while a
 * gesture recipe is actually armed — with none armed this returns
 * immediately and the bookmark costs exactly what it always cost.  With
 * one armed, the bookmark is delayed by at most the detection window,
 * which is the documented ceiling for this trade.
 *
 * Returns true when a second press landed inside the window (the caller
 * fires the gesture recipes instead of bookmarking).  Edges within the
 * first 100 ms are switch bounce of the SAME press, not a human double —
 * counting them would turn every scratchy contact into a gesture.
 */
#define MARK_GESTURE_WINDOW_MS 600
#define MARK_GESTURE_DEBOUNCE_MS 100

static bool reflex_mark_double_press(void)
{
	int64_t opened_at;

	if (!pendant_reflex_gesture_armed()) {
		return false;
	}
	opened_at = k_uptime_get();
	while (k_uptime_get() - opened_at < MARK_GESTURE_WINDOW_MS) {
		k_msleep(10);
		if (take_mark_press()) {
			if (k_uptime_get() - opened_at <
			    MARK_GESTURE_DEBOUNCE_MS) {
				continue;
			}
			printk("Button 2 double-press gesture (%d ms apart)\n",
			       (int)(k_uptime_get() - opened_at));
			return true;
		}
	}
	return false;
}

#ifdef CONFIG_PENDANT_MIC_INJECT
/*
 * Debug mic injection (harness builds only; see CONFIG_PENDANT_MIC_INJECT).
 *
 * Every end-to-end test used to play speech out of the host's speakers so the
 * physical I2S mic would hear it.  That rig has two variables nobody was
 * holding still — the laptop's distance from the pendant and the host output
 * volume — so any conclusion about capture level was unfalsifiable.  This path
 * replaces the staged mic PCM with bytes the debugger wrote, which makes an
 * utterance reproducible to the sample.
 *
 * Same shape as pendant_remote_press above: plain volatile globals a J-Link
 * writes over SWD, no protocol, no driver on the target.  Layout is a true
 * SPSC ring — the host owns head, this firmware owns tail, fill is derived —
 * so the two sides never need a lock across the debug port.
 *
 *   w4 <&pendant_inject_arm> 1        arm (do this before the press)
 *   <block-write G.711 mu-law bytes into pendant_inject_ring at head>
 *   w4 <&pendant_inject_head> <n>     publish the frames just written
 *   w4 <&pendant_inject_eof> 1        no more PCM coming; stop counting
 *                                     underruns and emit silence
 *
 * A power-of-two frame count lets the index difference be a mask instead of a
 * modulo, and makes the unsigned wrap of (head - tail) exact.
 *
 * WIRE FORMAT IS 8-BIT G.711 mu-LAW, NOT LINEAR PCM, and that is a measured
 * decision.  Every block-write front-end this debug port has was benchmarked
 * against the 31,250 B/s a 16-bit mic stage would consume:
 *
 *   JLinkExe w4 (2 frames/command)         7,960 B/s   3.9x too slow
 *   JLinkExe w8 (4 frames/command)        14,054 B/s   2.2x too slow
 *   JLinkExe loadfile                      resets the MCU — unusable outright
 *   JLinkGDBServer RSP 'X' block write   ~139,000 B/s   on an IDLE target
 *
 * The last number is the trap.  J-Link Commander costs ~0.5 ms per command no
 * matter how small, so only the GDB server's block write is even in range —
 * but its idle throughput is not the throughput available during a call.  The
 * debug port reaches RAM over the AHB-AP, and it contends with a CPU that is
 * running Opus, I2S EasyDMA and the LTE stack.  Traced mid-conversation, the
 * same writes fell to 27-51 kB/s typical with a 114 ms outlier (18 kB/s) — at
 * or below the 31,250 B/s that 16-bit audio needs.  That is a SUSTAINED rate
 * deficit, which no amount of extra buffer can fix; it can only be fixed by
 * sending fewer bytes.
 *
 * mu-law halves the wire rate to 15,625 B/s (~2.2x headroom against the
 * measured in-call median) and simultaneously doubles the runway this fixed
 * 4 KB of RAM buys, because a frame costs one byte instead of two — 262 ms,
 * enough to swallow the 114 ms outliers outright.  The expansion is the same
 * deterministic table the legacy reply path already uses, so an utterance
 * still decodes to identical samples on every run, which is the entire
 * property this rig exists to provide.  The uplink is ~16 kbps Opus SILK-WB,
 * far lossier than G.711, so the quantization costs nothing that survives to
 * the relay.
 */
#define PENDANT_INJECT_RING_FRAMES 4096U
#define PENDANT_INJECT_RING_MASK (PENDANT_INJECT_RING_FRAMES - 1U)
BUILD_ASSERT((PENDANT_INJECT_RING_FRAMES &
	      (PENDANT_INJECT_RING_FRAMES - 1U)) == 0U,
	     "inject ring must be a power of two");
BUILD_ASSERT(PENDANT_INJECT_RING_FRAMES >= 2U * MIC_STAGE_FRAMES,
	     "inject ring must hold at least two stages of runway");

/*
 * 4096 mu-law frames = 4,096 B = 262.14 ms at SAMPLE_RATE 15625, against a
 * 32.77 ms stage period: eight stages of runway, versus a worst observed host
 * stall of 114 ms.  The host keeps the ring topped up rather than draining it
 * to a low-water mark, so the whole 262 ms is available as insurance — see
 * software/ai-pendant-simulator/scripts/inject-audio.mjs.
 *
 * 4,096 B is the size RAM permits, not a size chosen for comfort.  This image
 * had 202,700 of 211,608 B spoken for (95.79%) before the ring existed; the
 * ring plus 24 B of control words takes it to 206,820 B (97.74%), leaving
 * 4,788 B.  Doubling it again would not link.  pendant_inject_underruns is
 * what tells you whether it was enough, which is why it is reported rather
 * than merely counted.
 */
volatile uint8_t pendant_inject_ring[PENDANT_INJECT_RING_FRAMES] __aligned(4);
/* Host writes: 1 = replace mic audio with the ring. */
volatile uint32_t pendant_inject_arm;
/* Host writes: producer index, in frames, free-running mod the ring size. */
volatile uint32_t pendant_inject_head;
/* Firmware writes: consumer index. The host reads it to compute free space. */
volatile uint32_t pendant_inject_tail;
/* Host writes: the utterance is fully queued; a dry ring is no longer a bug. */
volatile uint32_t pendant_inject_eof;
/* Firmware writes: stages that went out short because the host fell behind. */
volatile uint32_t pendant_inject_underruns;
/* Firmware writes: frames actually substituted into the uplink. */
volatile uint32_t pendant_inject_frames;

/*
 * Overwrite one staged mic block with injected PCM. Returns false when
 * injection is not armed, in which case the caller's real mic samples stand.
 */
static bool pendant_inject_fill_stage(int16_t *samples, size_t frame_count)
{
	if (pendant_inject_arm == 0U) {
		return false;
	}

	uint32_t tail = pendant_inject_tail;
	uint32_t fill = (pendant_inject_head - tail) & PENDANT_INJECT_RING_MASK;
	size_t take = MIN((size_t)fill, frame_count);

	for (size_t i = 0U; i < take; ++i) {
		samples[i] = ulaw_to_linear(
			pendant_inject_ring[(tail + i) &
					    PENDANT_INJECT_RING_MASK]);
	}
	/* Samples are consumed before the tail moves, so the host never
	 * overwrites a frame this stage is still reading. */
	compiler_barrier();
	pendant_inject_tail = (tail + (uint32_t)take) &
			      PENDANT_INJECT_RING_MASK;
	pendant_inject_frames += (uint32_t)take;

	if (take < frame_count) {
		/*
		 * Pad with digital silence rather than the live mic. Letting
		 * real audio back in on a starved stage would quietly restore
		 * the acoustic coupling this whole path exists to remove, and
		 * the run would look fine while measuring the wrong thing.
		 */
		memset(&samples[take], 0,
		       (frame_count - take) * sizeof(int16_t));
		if (pendant_inject_eof == 0U) {
			++pendant_inject_underruns;
		}
	}
	return true;
}

/*
 * Injection health rides in the existing "Conversation stats:" line rather
 * than a line of its own: a starved ring produces silence, silence looks
 * exactly like a working run that had nothing to say, and the number that
 * distinguishes them has to be where someone reading the run will see it.
 */
#define PENDANT_INJECT_STATS_FMT \
	" inject_frames=%u inject_underruns=%u"
#define PENDANT_INJECT_STATS_ARGS \
	, pendant_inject_frames, pendant_inject_underruns
#else
static inline bool pendant_inject_fill_stage(int16_t *samples,
					     size_t frame_count)
{
	ARG_UNUSED(samples);
	ARG_UNUSED(frame_count);
	return false;
}
#define PENDANT_INJECT_STATS_FMT ""
#define PENDANT_INJECT_STATS_ARGS
#endif /* CONFIG_PENDANT_MIC_INJECT */

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
 * A blue press that arrives while a duplex conversation is OPEN is answered
 * with a haptic tick and nothing else.
 *
 * The two modes must not mix. A conversation already owns the microphone,
 * the I2S transfer, the encoder, the decoder and the socket; starting a
 * push-to-talk capture inside one would need a second of each. And the
 * press is not meaningless to the owner, so it cannot be silently eaten —
 * the tick says "heard you, not now". Approvals are still answerable during
 * a conversation the way they always were best answered: out loud, or from
 * the dashboard.
 */
static void ptt_press_ignored_in_conversation(void)
{
	if (!take_ptt_press()) {
		return;
	}
	clear_ptt_events();
	haptic_trigger(HAPTIC_PATTERN_TICK);
	printk("Blue press ignored: a conversation is already open\n");
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
	pendant_bench_note_sd(sd_ready);
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
	/*
	 * Re-validate/reopen idle prewarm before I2S (stale sockets → -104) —
	 * unless this capture is deliberately radio-off. A push-to-talk
	 * question is captured with the modem untouched and uploaded once
	 * afterwards; opening a TLS socket here would spend the RRC connection
	 * this mode exists to avoid, seconds before there is anything to send.
	 */
	if (capture_radio_off) {
		printk("Capture with the radio off (push-to-talk): journaling "
		       "to microSD, one upload after the stop press\n");
	} else if (pendant_cloud_stream_ensure(PENDANT_OPUS_SAMPLE_RATE) != 0) {
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

	/* Button press = record NOW. LED + mic; LTE drains ring between I2S.
	 * One call covers memo, push-to-talk AND the legacy command capture:
	 * every one of them reaches the microphone through this function, so
	 * this is the single place "the mic is live" becomes true. */
	pendant_status_set(PENDANT_STATUS_RECORDING);
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
		 * first second, then a second press stops recording. A memo or
		 * push-to-talk capture additionally answers to its OWN button
		 * (green / blue) — the button that started a recording should
		 * stop it — while neither can ever cut a command capture short.
		 */
		if (sample_index < MIC_MIN_RECORD_FRAMES) {
			clear_button_events();
			if (memo_capture_active) {
				clear_memo_events();
			}
			if (ptt_capture_active) {
				clear_ptt_events();
			}
		} else if (k_sem_take(&button_press_sem, K_NO_WAIT) == 0 ||
			   (memo_capture_active && take_memo_press()) ||
			   (ptt_capture_active && take_ptt_press())) {
			recording_stopped_by_button = true;
			/*
			 * Acknowledge on the EDGE, not after teardown: the
			 * red light goes out and the exit tick fires here,
			 * together, because leaving RECORDING is ONE
			 * transition and pendant_status_set is the only
			 * thing allowed to make it.
			 *
			 * This replaces the old tick-for-memo /
			 * click-for-command split. Every capture now closes
			 * the same way, which is the point: the owner should
			 * not have to remember which button they pressed to
			 * know what a buzz meant.
			 */
			pendant_status_set(PENDANT_STATUS_THINKING);
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


static void show_error(void)
{
	/*
	 * Say it on the colour channel too, when there is one.  This call is
	 * a no-op until pendant_status_init() has run (see status_ready in
	 * pendant_status.c), which is why that init was moved above every
	 * fatal path that can be reached on a working board: an SD card that
	 * will not mount is the failure this device actually hits, and before
	 * that move it produced a pendant whose status LED was never
	 * initialised at all — indistinguishable, to the owner, from a
	 * miswired LED.
	 *
	 * Asserted ONCE, not in the loop: FAILED is three red blinks plus a
	 * two-part buzz, and a wearable that buzzes every second forever on a
	 * bench is worse than one that says it clearly once.  The 100 ms LED1
	 * blink below remains the permanent "this boot is dead" marker.
	 */
	pendant_status_set(PENDANT_STATUS_FAILED);
	while (true) {
		gpio_pin_toggle_dt(&led);
		/*
		 * THE BENCH KEEPS REPORTING FROM INSIDE A DEAD BOOT.
		 *
		 * This is the loop a pendant with no usable microSD actually
		 * sits in, and it is the exact state in which the owner most
		 * needs to see their wires: a board that failed to boot is a
		 * board somebody is about to go poking at. Measured on this
		 * bench 2026-08-13 — the app reached here 320 ms after reset
		 * and stayed, so every control tile on the dashboard had one
		 * boot sample and then aged out forever, which reads as "the
		 * board went away" rather than "the board is parked".
		 *
		 * Both calls are safe here by construction: volume_poll is one
		 * bounded SAADC read whose only side effects are a gain word
		 * and a report atomic that nothing is consuming yet (the WS
		 * thread is not created until after this function's callers),
		 * and pendant_bench_tick only reads pads and prints. Neither
		 * can resurrect the boot, and neither is supposed to.
		 */
		volume_poll();
		pendant_bench_tick();
		k_msleep(100);
	}
}

/* ---- Full-duplex conversation ---- */

static inline size_t dl_jitter_fill(void)
{
	return (dl_jitter_head - dl_jitter_tail + DL_JITTER_SAMPLES) %
	       DL_JITTER_SAMPLES;
}

static void dl_jitter_reset(void)
{
	dl_jitter_head = 0U;
	dl_jitter_tail = 0U;
}

static void dl_jitter_put(const int16_t *samples, size_t count)
{
	/* One slot stays unused so full != empty. The receive gate makes
	 * overflow unreachable in normal operation; a misbehaving relay
	 * (dense DTX frames) must clip, not corrupt. */
	size_t free_samples = DL_JITTER_SAMPLES - 1U - dl_jitter_fill();
	size_t head = dl_jitter_head;

	if (count > free_samples) {
		count = free_samples;
	}
	for (size_t i = 0U; i < count; ++i) {
		dl_jitter[head] = samples[i];
		head = (head + 1U) % DL_JITTER_SAMPLES;
	}
	/* Samples land before the consumer can see them. */
	compiler_barrier();
	dl_jitter_head = head;
}

/*
 * Adaptive duplex uplink, evaluated once per mic block from the conversation
 * loop. See the CONVO_UPLINK_* block above for why: the radio cannot carry the
 * uplink while agent audio is coming down, so trying to push a full-rate mic
 * stream through it only fills the FIFO until the user's next question falls
 * off the end.
 *
 * "Playing" is the same signal the LED uses (agent audio buffered), plus a
 * hangover so the gaps between downlink frames do not retune the encoder every
 * block.
 */
static void convo_update_uplink_adapt(void)
{
	int64_t now = k_uptime_get();
	size_t fill = live_fifo_fill();
	bool dl_playing;

	/* Bill the interval that just closed to the state it actually ran in,
	 * before that state is allowed to change. */
	if (convo_adapt_last_ms != 0 && convo_uplink_ducked) {
		convo_uplink_duck_ms += (uint32_t)(now - convo_adapt_last_ms);
	}
	convo_adapt_last_ms = now;

	if (dl_jitter_fill() > 0U) {
		convo_dl_active_until = now + CONVO_DL_ACTIVE_HANGOVER_MS;
	}
	dl_playing = now < convo_dl_active_until;

	if (dl_playing != convo_uplink_ducked) {
		/* Only latch the new state if the encoder took it, so a failed
		 * ctl cannot leave the uplink ducked for the whole call. */
		if (pendant_opus_stream_set_bitrate(
			    dl_playing ? CONVO_UPLINK_DUCK_BPS
				       : PENDANT_OPUS_BITRATE) == 0) {
			convo_uplink_ducked = dl_playing;
		}
	}

	/* Hysteresis, and an unconditional release the moment playback ends —
	 * whatever the user says next is the whole point of the reserve. */
	if (!dl_playing || fill <= CONVO_UPLINK_RESUME_BYTES) {
		convo_uplink_holding = false;
	} else if (fill >= CONVO_UPLINK_HOLD_BYTES) {
		convo_uplink_holding = true;
	}
}

/*
 * ---- 24000 -> 31250 anti-imaging interpolator ----
 *
 * 24000/31250 reduces to 96/125 and gcd(96,125) == 1, so the phase
 * accumulator visits every one of the 125 residues: the 125-phase table in
 * tx_resample_taps.h is EXACT, and unlike the ESP32's 625/882 stage there is
 * nothing to blend between neighbouring phases.
 *
 * The straight-line interpolator this replaces had a sinc^2 kernel whose
 * SECOND image (24000 + f) folds around the 31250 output rate to |7250 - f|.
 * Measured on the bench: every tone from 5 to 10 kHz left a companion at
 * -21 to -31 dBc down in the low midrange -- so every "s", "sh" and "f" in
 * the agent's voice rang a buzz at a few percent of full scale, at a
 * frequency that moves DOWN as the voice moves up. Inharmonic, frequency
 * inverted, and squarely where the ear is most sensitive. That is the
 * distortion, and it is now -58 to -77 dBc.
 *
 * Cutoff is 10.5 kHz, not the 12 kHz the decoder can carry: at 125/96 an
 * 11.9 kHz component images to 12.1 kHz and no filter separates them.
 *
 * The table is const in flash. The app is built soft-float (CONFIG_FPU is
 * not set), so generating it at boot would drag in softfloat sinf/cosf and
 * spend RAM the audio path does not have.
 */
static int16_t tx_fir_hist[2U * TX_FIR_TAPS]; /* written twice so the tap
					       * window is always contiguous:
					       * no shift in the hot loop */
static size_t tx_fir_pos;
static uint32_t tx_fir_zero_run = TX_FIR_TAPS;
static uint32_t tx_phase; /* 0..TX_RESAMPLE_DEN-1 */

static void tx_resample_reset(void)
{
	tx_phase = 0U;
	tx_fir_pos = 0U;
	tx_fir_zero_run = TX_FIR_TAPS;
	memset(tx_fir_hist, 0, sizeof(tx_fir_hist));
}

static inline void tx_fir_push(int16_t sample)
{
	tx_fir_pos = (tx_fir_pos == 0U) ? (TX_FIR_TAPS - 1U)
					: (tx_fir_pos - 1U);
	tx_fir_hist[tx_fir_pos] = sample;
	tx_fir_hist[tx_fir_pos + TX_FIR_TAPS] = sample;
	if (sample == 0) {
		if (tx_fir_zero_run < TX_FIR_TAPS) {
			++tx_fir_zero_run;
		}
	} else {
		tx_fir_zero_run = 0U;
	}
}

/*
 * One polyphase output sample at the current tx_phase from the shared FIR
 * history.  Split out of convo_fill_tx_block so the reflex chime (16 kHz
 * source, same 125-phase table, NUM=64) reuses the identical arithmetic —
 * the two paths never run concurrently (the chime plays only while idle).
 */
static inline int32_t tx_fir_convolve(void)
{
	const int16_t *row = &tx_fir_coeff[tx_phase * TX_FIR_TAPS];
	const int16_t *window = &tx_fir_hist[tx_fir_pos];
	int32_t acc = 0;

	for (size_t tap = 0U; tap < TX_FIR_TAPS; ++tap) {
		acc += (int32_t)row[tap] * (int32_t)window[tap];
	}
	acc = (acc + (1 << (TX_FIR_Q - 1))) >> TX_FIR_Q;
	/* Sum|h| peaks at 1.651, so a transient can ring past
	 * full scale even though the decoder never does. */
	return CLAMP(acc, INT16_MIN, INT16_MAX);
}

/*
 * Volume applies HERE, at the moment a sample becomes a wire word, and
 * only to AUDIO words: the sync preamble (convo_queue_preamble) must reach
 * the ESP32 bit-exact or it never locks.  Downstream of this multiply the
 * wire itself carries pre-scaled PCM, so the ESP32 — and whatever dumb
 * Bluetooth module replaces it — plays the right level with no knowledge
 * of the knob; the MAX98357A tap gets the same scaling for free.
 * convo_tx_peak is measured BEFORE this (in the callers, off the clean
 * convolver output), so diagnostics keep seeing what the decoder produced.
 * gain <= unity (Q12 attenuator), input already clamped to int16: the
 * product cannot exceed full scale, hence no saturation step.
 */
static inline int32_t tx_apply_volume(int32_t sample)
{
	return (sample * (int32_t)atomic_get(&volume_gain_q12)) >> 12;
}

/*
 * Fill one TX block (640 words at 31250) from the 24 kHz jitter ring.
 * `*playing` implements the prebuffer/rebuffer gate; silence flows whenever
 * it is off so the duplex transfer never underruns. Filter state persists
 * across blocks.
 */
static void convo_fill_tx_block(int32_t *words, bool *playing)
{
	for (size_t frame = 0U; frame < CONVO_TX_BLOCK_FRAMES; ++frame) {
		int32_t value = 0;

		if (!*playing && dl_jitter_fill() >= DL_PREBUFFER_SAMPLES) {
			*playing = true;
		}
		/* A fully zeroed history convolves to exactly zero at every
		 * phase, so silence costs nothing. */
		if (tx_fir_zero_run < TX_FIR_TAPS) {
			uint32_t magnitude;

			value = tx_fir_convolve();
			magnitude = (uint32_t)(value < 0 ? -value : value);
			if (magnitude > convo_tx_peak) {
				convo_tx_peak = magnitude;
			}
			value = tx_apply_volume(value);
		}
		words[frame] = value << 8;

		tx_phase += TX_RESAMPLE_NUM;
		if (tx_phase >= TX_RESAMPLE_DEN) {
			tx_phase -= TX_RESAMPLE_DEN;
			if (*playing && dl_jitter_fill() > 0U) {
				tx_fir_push(dl_jitter[dl_jitter_tail]);
				dl_jitter_tail = (dl_jitter_tail + 1U) %
						 DL_JITTER_SAMPLES;
				convo_tx_dry = false;
			} else {
				tx_fir_push(0);
				if (*playing && !convo_tx_dry) {
					convo_tx_dry = true;
					++convo_tx_starved;
				}
			}
		}
	}
}

/*
 * Keep the TX runway as full as the slab allows. Called once per RX block,
 * but deliberately NOT 1:1 — it writes as many blocks as the driver will
 * accept right now, so the queue stays deep and a late iteration cannot
 * starve the transfer. K_NO_WAIT everywhere: when the driver is saturated
 * (the healthy steady state) there is simply nothing to do.
 */
static int convo_top_up_tx(const struct device *i2s, bool *playing);

/*
 * Audio thread: the ONLY code with an I2S deadline. Reads each RX block and
 * hands the pointer to main (no copy), keeps the TX runway full, and
 * services barge-in flushes. No codec, no socket, no allocation beyond the
 * slabs — so it cannot miss the driver's one-block deadline no matter how
 * long an Opus frame takes on main.
 */
static void audio_thread_fn(void *a, void *b, void *c)
{
	bool playing = false;

	ARG_UNUSED(a);
	ARG_UNUSED(b);
	ARG_UNUSED(c);

	for (;;) {
		void *block;
		size_t size;
		int error;

		if (!atomic_get(&convo_active)) {
			playing = false;
			k_msleep(20);
			continue;
		}

		error = i2s_read(audio_i2s_dev, &block, &size);
		if (error != 0) {
			if (atomic_get(&convo_active)) {
				printk("Audio thread I2S read failed: %d\n",
				       error);
				atomic_set(&audio_thread_error, error);
				atomic_set(&convo_end_req, 1);
				atomic_set(&convo_active, 0);
			}
			continue;
		}
		++convo_rx_blocks;

		/* Barge-in: the consumer owns the tail, so dropping the
		 * backlog here is race-free against main's decode. */
		if (atomic_cas(&convo_flush_req, 1, 0)) {
			dl_jitter_tail = dl_jitter_head;
			tx_resample_reset();
			playing = false;
		}

		error = convo_top_up_tx(audio_i2s_dev, &playing);
		if (error != 0) {
			printk("Audio thread TX write failed: %d\n", error);
			atomic_set(&audio_thread_error, error);
			atomic_set(&convo_end_req, 1);
			atomic_set(&convo_active, 0);
		}

		if (k_msgq_put(&mic_raw_q, &block, K_NO_WAIT) != 0) {
			/* Main is behind (long encode): drop this mic block
			 * rather than let the RX queue overflow and take the
			 * whole duplex transfer down with it. */
			k_mem_slab_free(&mic_rx_slab, block);
			++convo_mic_drops;
		}
	}
}

static int convo_top_up_tx(const struct device *i2s, bool *playing)
{
	for (;;) {
		void *block;
		int error;

		if (k_mem_slab_alloc(&convo_tx_slab, &block, K_NO_WAIT) != 0) {
			/* Every block is with the driver: runway is full. */
			return 0;
		}
		convo_fill_tx_block((int32_t *)block, playing);
		error = i2s_write(i2s, block,
				  CONVO_TX_BLOCK_FRAMES * sizeof(int32_t));
		if (error != 0) {
			k_mem_slab_free(&convo_tx_slab, block);
			if (error == -EAGAIN || error == -ENOMSG) {
				/* tx_queue full — runway is full, not an
				 * error (i2s_write's own timeout path). */
				return 0;
			}
			return error;
		}
		++convo_tx_blocks;
	}
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
		++convo_tx_blocks;
		words = (int32_t *)block;
		for (size_t frame = 0U; frame < CONVO_TX_BLOCK_FRAMES;
		     ++frame) {
			int32_t value = 0;

			if (block_index == 0U) {
				value = (frame & 1U) ? I2S_STREAM_SYNC_B
						     : I2S_STREAM_SYNC_A;
			} else if (block_index == 1U &&
				   frame < I2S_SYNC_END_FRAMES) {
				/*
				 * End marker belongs to block 1 ONLY. Without
				 * the block test every priming block repeated
				 * it, and the receiver skips markers only
				 * until it locks — so blocks 2..5 arrived as
				 * audio: four bursts of 0x6C6C (27756, ~85%
				 * of full scale) at 20 ms intervals, i.e. a
				 * burst of loud clicks at the start of every
				 * single conversation. Captured off the wire
				 * at indices 1257-1304 of a press.
				 */
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
 * ---- Reflex chime ----
 *
 * A short tone sequence (three ascending notes, 600 ms, faded) generated
 * as 16 kHz PCM and pushed through the SAME I2S TX path agent audio uses:
 * PWM clocks + 24-bit/mono/slave/31250 duplex config, sync preamble so the
 * ESP32 locks (and does not play the preamble as audio — commit 8b5a53c),
 * word = sample << 8 in the left slot, DROP-only teardown.  16000/31250
 * reduces to 64/125: same 125-phase FIR table as the conversation's 96/125
 * fill, only the phase increment differs, so the anti-imaging behavior is
 * the one already proven on this wire.
 *
 * The tones are integer resonators (y[n] = (k*y[n-1] >> 14) - y[n-2], k =
 * 2*cos(2*pi*f/16000) in Q14, seeded y = A*sin(w)): no sine table, no
 * softfloat, constants precomputed below.  Amplitude 9000 (~27% FS, the
 * encode selftest's level) with 12 ms linear fades at each note edge.
 */
#define CHIME_RESAMPLE_NUM 64U /* 16000 -> 31250 (shares TX_RESAMPLE_DEN) */
#define CHIME_FADE_SAMPLES 192U /* 12 ms at 16 kHz */
#define CHIME_NOTE1_SAMPLES 2720U /* 170 ms */
#define CHIME_NOTE2_SAMPLES 2720U /* 170 ms */
#define CHIME_NOTE3_SAMPLES 4160U /* 260 ms */
#define CHIME_SOURCE_SAMPLES \
	(CHIME_NOTE1_SAMPLES + CHIME_NOTE2_SAMPLES + CHIME_NOTE3_SAMPLES)
#define CHIME_OUT_FRAMES \
	((CHIME_SOURCE_SAMPLES * TX_RESAMPLE_DEN) / CHIME_RESAMPLE_NUM)
/* Preamble + chime + margin, in whole TX blocks; the play loop counts RX
 * blocks (one per 20.48 ms) so the tail has PLAYED before DROP discards
 * the still-queued silence. */
#define CHIME_PLAY_BLOCKS                                                     \
	(CONVO_TX_PRIME_BLOCKS +                                              \
	 (CHIME_OUT_FRAMES + CONVO_TX_BLOCK_FRAMES - 1U) /                    \
		 CONVO_TX_BLOCK_FRAMES +                                      \
	 2U)

static const struct chime_note {
	int32_t k_q14;    /* 2*cos(2*pi*f/16000), Q14 */
	int32_t seed;     /* 9000*sin(2*pi*f/16000) — second osc state */
	uint32_t samples; /* note length at 16 kHz */
} chime_notes[] = {
	{ 31677, 2303, CHIME_NOTE1_SAMPLES }, /* E5   659 Hz */
	{ 31039, 2885, CHIME_NOTE2_SAMPLES }, /* G#5  831 Hz */
	{ 30332, 3405, CHIME_NOTE3_SAMPLES }, /* B5   988 Hz */
};

static struct {
	size_t note; /* == ARRAY_SIZE(chime_notes) when finished */
	uint32_t pos;
	int32_t y1;
	int32_t y2;
} chime_synth;

static void chime_synth_reset(void)
{
	chime_synth.note = 0U;
	chime_synth.pos = 0U;
	chime_synth.y1 = chime_notes[0].seed;
	chime_synth.y2 = 0;
}

/* Next 16 kHz source sample; digital silence forever once the last note
 * ends, so the FIR tail and the block margin flush to true zero. */
static int16_t chime_next_sample(void)
{
	const struct chime_note *note;
	int32_t value;
	int32_t next;
	uint32_t edge;

	if (chime_synth.note >= ARRAY_SIZE(chime_notes)) {
		return 0;
	}
	note = &chime_notes[chime_synth.note];
	value = chime_synth.y1;
	/* k*y1 peaks near 9200*31677 ≈ 2.9e8 — comfortably inside int32. */
	next = ((note->k_q14 * chime_synth.y1) >> 14) - chime_synth.y2;
	chime_synth.y2 = chime_synth.y1;
	chime_synth.y1 = next;

	edge = MIN(chime_synth.pos, note->samples - 1U - chime_synth.pos);
	if (edge < CHIME_FADE_SAMPLES) {
		value = value * (int32_t)edge / (int32_t)CHIME_FADE_SAMPLES;
	}

	if (++chime_synth.pos >= note->samples) {
		++chime_synth.note;
		chime_synth.pos = 0U;
		if (chime_synth.note < ARRAY_SIZE(chime_notes)) {
			chime_synth.y1 = chime_notes[chime_synth.note].seed;
			chime_synth.y2 = 0;
		}
	}
	return (int16_t)CLAMP(value, INT16_MIN, INT16_MAX);
}

/* Twin of convo_fill_tx_block with the jitter ring replaced by the synth
 * and the phase step at 64/125.  Shares tx_phase/tx_fir state — both users
 * reset it at their own start and never overlap. */
static void chime_fill_tx_block(int32_t *words)
{
	for (size_t frame = 0U; frame < CONVO_TX_BLOCK_FRAMES; ++frame) {
		int32_t value = 0;

		if (tx_fir_zero_run < TX_FIR_TAPS) {
			/* Chimes obey the knob too — on the ESP32 the gain sat
			 * at the single wire consumer, so every sound scaled;
			 * moving the knob here keeps that behavior. */
			value = tx_apply_volume(tx_fir_convolve());
		}
		words[frame] = value << 8;

		tx_phase += CHIME_RESAMPLE_NUM;
		if (tx_phase >= TX_RESAMPLE_DEN) {
			tx_phase -= TX_RESAMPLE_DEN;
			tx_fir_push(chime_next_sample());
		}
	}
}

/* Same contract as convo_top_up_tx: fill the runway until the slab or the
 * driver queue is full; K_NO_WAIT everywhere. */
static int chime_top_up_tx(const struct device *i2s, uint32_t *tx_blocks)
{
	for (;;) {
		void *block;
		int error;

		if (k_mem_slab_alloc(&convo_tx_slab, &block, K_NO_WAIT) != 0) {
			return 0;
		}
		chime_fill_tx_block((int32_t *)block);
		error = i2s_write(i2s, block,
				  CONVO_TX_BLOCK_FRAMES * sizeof(int32_t));
		if (error != 0) {
			k_mem_slab_free(&convo_tx_slab, block);
			if (error == -EAGAIN || error == -ENOMSG) {
				return 0;
			}
			return error;
		}
		++*tx_blocks;
	}
}

/*
 * Play the chime while IDLE: full duplex bring-up exactly as
 * run_conversation does it (i2s_nrfx memcmps the two directions' configs,
 * and TX-only as a clock slave is an unproven path), mic RX read and
 * discarded to keep the BOTH transfer alive, then DROP + settle + clocks
 * off — the same teardown the conversation survives, so the next
 * conversation's bring-up starts from the identical driver state.
 *
 * Runs on the main thread's idle loop only; convo_active is a
 * belt-and-braces check, not a synchronization point.
 */
static int reflex_chime_play(const struct device *i2s, uint8_t chime_index)
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
	uint32_t rx_blocks = 0U;
	uint32_t tx_blocks = 0U;
	bool i2s_running = false;
	int error;

	ARG_UNUSED(chime_index); /* one chime today; index reserved */

	if (atomic_get(&convo_active)) {
		return -EBUSY;
	}
	error = k_mem_slab_init(&mic_rx_slab, mic_rx_storage,
				MIC_RX_BLOCK_SIZE, MIC_RX_BLOCK_COUNT);
	if (error != 0) {
		return error;
	}
	tx_resample_reset();
	chime_synth_reset();
	mic_clocks_start();

	error = i2s_configure(i2s, I2S_DIR_RX, &config);
	if (error == 0) {
		tx_config = config;
		tx_config.mem_slab = &convo_tx_slab;
		tx_config.timeout = 0; /* never block the fill loop */
		error = i2s_configure(i2s, I2S_DIR_TX, &tx_config);
	}
	/* ESP32 resynchronizes after every BCLK restart; without the
	 * preamble the whole chime would be eaten by its sync hunt. */
	if (error == 0) {
		error = convo_queue_preamble(i2s);
	}
	if (error == 0) {
		error = chime_top_up_tx(i2s, &tx_blocks);
	}
	if (error == 0) {
		k_msleep(MIC_POWERUP_BUDGET_MS);
		printk("Chime: start (%u ms, %u source samples -> %u frames, "
		       "%u blocks)\n",
		       (unsigned int)(CHIME_SOURCE_SAMPLES / 16U),
		       (unsigned int)CHIME_SOURCE_SAMPLES,
		       (unsigned int)CHIME_OUT_FRAMES,
		       (unsigned int)CHIME_PLAY_BLOCKS);
		error = i2s_trigger(i2s, I2S_DIR_BOTH, I2S_TRIGGER_START);
	}
	if (error == 0) {
		i2s_running = true;
		while (rx_blocks < CHIME_PLAY_BLOCKS) {
			void *block;
			size_t size;

			error = i2s_read(i2s, &block, &size);
			if (error != 0) {
				printk("Chime I2S read failed: %d\n", error);
				break;
			}
			/* Mic audio is discarded — a chime has no uplink —
			 * but the read itself keeps the duplex transfer
			 * from dying of RX overrun. */
			k_mem_slab_free(&mic_rx_slab, block);
			++rx_blocks;
			error = chime_top_up_tx(i2s, &tx_blocks);
			if (error != 0) {
				printk("Chime I2S write failed: %d\n", error);
				break;
			}
		}
	}

	if (i2s_running) {
		/*
		 * DROP, never DRAIN — identical reasoning to the
		 * conversation teardown: draining as a clock slave wedges
		 * i2s_nrfx until power cycle.  Everything still queued here
		 * is silence by construction (the block budget already
		 * played the chime tail).
		 */
		(void)i2s_trigger(i2s, I2S_DIR_BOTH, I2S_TRIGGER_DROP);
		k_msleep(MIC_STOP_SETTLE_MS);
	}
	mic_clocks_stop();
	printk("Chime: done error=%d rx_blocks=%u tx_blocks=%u (I2S TX "
	       "frames left the wire; audible check is the ESP32/speaker's)\n",
	       error, rx_blocks, tx_blocks);
	return error;
}

/*
 * ---- Reflex action executors ----
 *
 * The interpreter (pendant_reflex.c) owns WHAT runs; these own HOW, since
 * the LED GPIO, the DRV2605L and the I2S chime all live in this file's
 * world.  All three run on the main thread's idle loop and may block for
 * the duration of their effect.
 */
static void reflex_do_led(uint8_t pattern)
{
	switch (pattern) {
	case REFLEX_LED_DOUBLE:
		flash_led(2U, 100, 100);
		break;
	case REFLEX_LED_TRIPLE:
		flash_led(3U, 100, 100);
		break;
	case REFLEX_LED_BURST:
		flash_led(6U, 40, 60);
		break;
	case REFLEX_LED_LONG:
		gpio_pin_set_dt(&led, 1);
		k_msleep(600);
		gpio_pin_set_dt(&led, 0);
		break;
	case REFLEX_LED_SINGLE:
	default:
		flash_led(1U, 120, 80);
		break;
	}
}

/* Nonzero when the motor is absent/failed — the interpreter then degrades
 * this step to the matching LED pattern (probe already logged once). */
static int reflex_do_haptic(uint8_t pattern)
{
	return haptic_play((enum haptic_pattern)pattern);
}

static int reflex_do_chime(uint8_t chime_index)
{
	return reflex_chime_play(DEVICE_DT_GET(I2S_NODE), chime_index);
}

static const struct pendant_reflex_ops reflex_ops_impl = {
	.led = reflex_do_led,
	.haptic = reflex_do_haptic,
	.chime = reflex_do_chime,
};

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

	/* Gate shut: the packets stay in the FIFO and the radio stays
	 * silent. */
	if (!atomic_get(&convo_uplink_gate)) {
		return;
	}

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

		/* Backpressure: no free slot → stop reading the socket and
		 * let TCP flow control park the rest at the relay. */
		if (k_msgq_num_free_get(&dl_frames) == 0U) {
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
			/*
			 * Recipe frames FIRST, on an EXACT "type":"recipe"
			 * match, and then NEVER through the legacy matching
			 * below: that matching is substring-based, so any
			 * recipe whose body happened to contain "end" (or
			 * "flush"/"started") would be misread as a control
			 * frame — "end" would kill the live conversation.
			 * The legacy started/flush/end behavior itself is
			 * deliberately unchanged.
			 */
			if (pendant_reflex_offer_frame(
				    (const char *)ws_rx_buf)) {
				continue;
			}
			if (audio_sink_offer_frame((const char *)ws_rx_buf)) {
				continue;
			}
			/* Bluetooth device menu (bt_list / bt_select). Flags
			 * only — the UART write and the sink table live on
			 * main, never on this 2.5 KB socket stack. */
			if (pendant_bt_offer_frame((const char *)ws_rx_buf)) {
				continue;
			}
			/*
			 * The relay announces an approval readback about to
			 * play; the strong hit says "the next words want an
			 * answer" even in a loud room. The answer itself is
			 * now spoken, not pressed — the blue button became
			 * push-to-talk on 2026-08-12 — so this haptic is the
			 * whole device-side half of approvals, and it matters
			 * more, not less, for being the only cue.
			 * (Relay side of this frame is still TODO.)
			 */
			if (strstr((const char *)ws_rx_buf,
				   "\"approval_readback\"") != NULL) {
				/* One call, both channels: the amber fast
				 * blink and the double strong hit are the
				 * same transition, so the light can never
				 * say "nothing to answer" while the motor
				 * is saying the opposite. Safe from this
				 * 2.5 KB socket stack — it sets an atomic
				 * and reschedules work, nothing more. */
				pendant_status_set(PENDANT_STATUS_APPROVAL);
				continue;
			}
			if (strstr((const char *)ws_rx_buf,
				   "\"started\"") != NULL) {
				atomic_set(&convo_started, 1);
			} else if (strstr((const char *)ws_rx_buf,
					  "\"flush\"") != NULL) {
				if (atomic_get(&convo_started)) {
					atomic_set(&convo_flush_req, 1);
				}
			} else if (strstr((const char *)ws_rx_buf,
					  "\"end\"") != NULL) {
				if (atomic_get(&convo_started)) {
					atomic_set(&convo_end_req, 1);
				}
			}
			continue;
		}
		/* Reply audio from the previous conversation: discard. */
		if (!atomic_get(&convo_started)) {
			continue;
		}
		dl_tx_frame.length = (uint16_t)received;
		memcpy(dl_tx_frame.data, ws_rx_buf, (size_t)received);
		(void)k_msgq_put(&dl_frames, &dl_tx_frame, K_NO_WAIT);
	}
}

/*
 * Flush owner control frames (menu steps, menu select, knob position) onto
 * the converse socket. Runs ONLY on the WS I/O thread with ws_lock held,
 * both mid-conversation and idle, so a button never waits on the modem and
 * the socket is never touched from two threads.
 *
 * Drop-when-closed is the contract (see the atomics' declaration): a
 * closed socket clears the backlog instead of banking stale intent. A send
 * failure also just drops — if the transport actually died, the audio pump
 * or the idle reconnect discovers it within milliseconds; a lost menu
 * twist is not worth ending a conversation over.
 */
static void ws_io_send_owner_controls(void)
{
	if (!pendant_ws_connected()) {
		atomic_set(&menu_step_backlog, 0);
		atomic_set(&menu_select_req, 0);
		atomic_set(&volume_report, -1);
		return;
	}

	/* One frame per detent, a few per pass: the relay's contract is
	 * delta:±1, and bounding the burst keeps this thread honest about
	 * its real job (audio) when the owner spins the knob. */
	for (unsigned int sent = 0U; sent < 4U; ++sent) {
		atomic_val_t backlog = atomic_get(&menu_step_backlog);

		if (backlog == 0) {
			break;
		}
		int step = backlog > 0 ? 1 : -1;

		if (pendant_ws_send_text(
			    step > 0 ? "{\"type\":\"menu\",\"delta\":1}"
				     : "{\"type\":\"menu\",\"delta\":-1}") !=
		    0) {
			break;
		}
		atomic_sub(&menu_step_backlog, step);
	}

	/* AFTER the detents above, always: the dwell fires 1.5 s behind the
	 * last detent, so the scroll that chose the entry is already on the
	 * wire and the relay's 200 ms name settle has long since spoken it.
	 * A select that overtook its own detent would commit the entry before
	 * it. */
	if (atomic_cas(&menu_select_req, 1, 0)) {
		(void)pendant_ws_send_text("{\"type\":\"menu_select\"}");
	}

	/* Knob position, latest state only (a twist mid-dead-zone already
	 * cleared above): same wire shape the ESP32's serial channel used,
	 * so the dashboard keys on nothing new. */
	atomic_val_t vol = atomic_set(&volume_report, -1);

	if (vol >= 0) {
		char frame[64];
		unsigned int hundredths = ((unsigned int)vol >> 16) & 0xFFFFU;

		snprintf(frame, sizeof(frame),
			 "{\"type\":\"volume\",\"level\":%u.%02u,\"raw\":%u}",
			 hundredths / 100U, hundredths % 100U,
			 (unsigned int)vol & 0xFFFFU);
		(void)pendant_ws_send_text(frame);
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
				ws_io_send_owner_controls();
			} else {
				atomic_set(&convo_end_req, 1);
			}
			k_mutex_unlock(&ws_lock);
			k_msleep(5);
			continue;
		}
		if (pendant_ws_connected()) {
			k_mutex_lock(&ws_lock, K_FOREVER);
			if (k_uptime_get() >= next_idle_ping) {
				(void)pendant_ws_ping();
				next_idle_ping = k_uptime_get() +
						 WS_IDLE_PING_SECONDS * 1000;
			}
			ws_io_send_owner_controls();
			/* Swallow pongs and the previous conversation's
			 * trailing frames every tick, not just at ping
			 * time, so none of it leads the next conversation.
			 * Recipe frames are the exception: the idle socket
			 * is exactly where the relay delivers them, so they
			 * are handed to the reflex layer instead of the
			 * bin (parse + SD + ack happen on main's idle
			 * loop, never on this 2.5 KB stack). */
			for (int drained = 1; drained > 0;) {
				bool is_text = false;

				drained = pendant_ws_recv(ws_rx_buf,
							  sizeof(ws_rx_buf),
							  &is_text);
				if (drained > 0 && is_text) {
					ws_rx_buf[MIN((size_t)drained,
						      sizeof(ws_rx_buf) -
							      1U)] = '\0';
					if (!pendant_reflex_offer_frame(
						    (const char *)ws_rx_buf) &&
					    /* Sink switches work idle
					     * too: the owner flips the
					     * default from the dashboard
					     * between conversations. */
					    !audio_sink_offer_frame(
						    (const char *)ws_rx_buf)) {
						/* Bluetooth menu: the relay
						 * asks for the device list and
						 * sends the owner's pick. Only
						 * flags are set here — the UART
						 * and the card belong to main. */
						(void)pendant_bt_offer_frame(
							(const char *)
								ws_rx_buf);
					}
				}
			}
			k_mutex_unlock(&ws_lock);
		} else {
			/* Drop-when-closed for the owner control frames: a
			 * twist banked across a dead link would replay as
			 * stale intent on reconnect. */
			atomic_set(&menu_step_backlog, 0);
			atomic_set(&menu_select_req, 0);
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
	unsigned int decodes = 0U;

	while (decodes < CONVO_MAX_DECODES_PER_BLOCK) {
		size_t frame_bytes;
		size_t offset = 0U;

		if (DL_JITTER_SAMPLES - 1U - dl_jitter_fill() <
		    DL_WORST_FRAME_SAMPLES) {
			return;
		}
		if (k_msgq_get(&dl_frames, &dl_rx_frame, K_NO_WAIT) != 0) {
			return;
		}
		frame_bytes = dl_rx_frame.length;

		while (offset + 2U <= frame_bytes) {
			size_t packet_bytes =
				((size_t)dl_rx_frame.data[offset] << 8) |
				dl_rx_frame.data[offset + 1U];

			offset += 2U;
			if (packet_bytes == 0U ||
			    offset + packet_bytes > frame_bytes) {
				printk("Downlink framing broken (len=%u)\n",
				       (unsigned int)packet_bytes);
				atomic_set(&convo_end_req, 1);
				return;
			}
			uint32_t decode_started = k_cycle_get_32();
			int decoded = pendant_opus_reply_decode_packet(
				dl_rx_frame.data + offset, packet_bytes,
				dl_decode_buf, ARRAY_SIZE(dl_decode_buf));
			uint32_t decode_elapsed =
				k_cycle_get_32() - decode_started;

			convo_decode_cycles += decode_elapsed;
			++convo_decode_calls;
			if (decode_elapsed > convo_decode_max_cycles) {
				convo_decode_max_cycles = decode_elapsed;
			}

			if (decoded > 0) {
				dl_jitter_put(dl_decode_buf,
					      (size_t)decoded);
				++convo_decoded_packets;
			}
			offset += packet_bytes;
			++decodes;
		}
	}
}

/*
 * One press-to-press conversation: mic streams up, agent speech streams
 * down and PLAYS WHILE RECORDING — the model decides when to talk. Ends on
 * the second button press, relay 'end' (30 s of mutual silence), transport
 * death, or the runaway cap.
 */
/*
 * Tell the relay a conversation is starting and let the uplink flow. This
 * function contains the first byte this device transmits for a press.
 */
static int convo_open_uplink(char *device_time, size_t device_time_capacity)
{
	char start_message[96];
	int error;

	k_mutex_lock(&ws_lock, K_FOREVER);
	error = pendant_ws_connect();
	if (error == 0) {
		pendant_cloud_copy_device_time(device_time,
					       device_time_capacity);
		snprintf(start_message, sizeof(start_message),
			 "{\"type\":\"start\",\"deviceTime\":\"%s\"}",
			 device_time);
		error = pendant_ws_send_text(start_message);
	}
	k_mutex_unlock(&ws_lock);
	if (error == 0) {
		/* Release the held packets. The WS thread flushes them on its
		 * next pass, oldest first, so the relay hears the utterance
		 * from its true beginning. */
		atomic_set(&convo_uplink_gate, 1);
	}
	return error;
}

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
	/* Has this press been allowed to transmit yet? */
	bool uplink_open = false;
	int64_t started_at;
	int64_t next_led_toggle;
	size_t stage_frames = 0U;
	size_t block_index = 0U;
	int32_t hpf_prev_in = 0;
	int32_t hpf_prev_out = 0;
	bool hpf_primed = false;
	int32_t slew_prev = 0;
	bool slew_primed = false;
	bool i2s_running = false;
	bool stop_sent = false;
	int result = 0;
	int error;

	live_stream_failed = false;
	live_tx_saturated = false;
	live_fifo_reset();
	dl_jitter_reset();
	tx_resample_reset();
	k_msgq_purge(&dl_frames);
	atomic_set(&convo_flush_req, 0);
	atomic_set(&convo_end_req, 0);
	atomic_set(&convo_started, 0);
	convo_tx_blocks = 0U;
	convo_tx_starved = 0U;
	convo_tx_dry = false;
	convo_rx_blocks = 0U;
	convo_decoded_packets = 0U;
	convo_max_loop_ms = 0U;
	convo_uplink_drops = 0U;
	convo_mic_drops = 0U;
	convo_tx_peak = 0U;
#ifdef CONFIG_PENDANT_MIC_INJECT
	/* Per-conversation, like every other counter here. Head/tail are
	 * deliberately untouched: the host prefills the ring before pressing,
	 * and resetting the indices here would throw that prefill away. */
	pendant_inject_frames = 0U;
	pendant_inject_underruns = 0U;
#endif
	convo_uplink_ducked = false;
	convo_uplink_holding = false;
	convo_dl_active_until = 0;
	convo_adapt_last_ms = 0;
	convo_uplink_duck_ms = 0U;
	convo_uplink_held = 0U;
	convo_decode_cycles = 0U;
	convo_decode_calls = 0U;
	convo_decode_max_cycles = 0U;
	convo_encode_cycles = 0U;
	convo_encode_calls = 0U;
	convo_encode_max_cycles = 0U;

	atomic_set(&convo_uplink_gate, 1);
	error = convo_open_uplink(device_time, sizeof(device_time));
	if (error != 0) {
		return error;
	}
	uplink_open = true;

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
		PENDANT_OPUS_REPLY_SAMPLE_RATE);
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

	/* Duplex capture is a recording like any other — the microphone is
	 * open and the owner is talking, so it wears the same red. */
	pendant_status_set(PENDANT_STATUS_RECORDING);
	gpio_pin_set_dt(&led, 1);
	next_led_toggle = k_uptime_get() + 250;
	mic_clocks_start();

	error = i2s_configure(i2s, I2S_DIR_RX, &config);
	if (error != 0) {
		goto teardown_clocks;
	}
	tx_config = config;
	tx_config.mem_slab = &convo_tx_slab;
	/*
	 * TX writes must NEVER block. i2s_write waits up to cfg.timeout for
	 * a free tx_queue slot, which paces the loop to exactly one RX block
	 * per block period — leaving no way to drain an RX backlog after a
	 * stall, so the backlog grows until the RX queue overflows and the
	 * driver errors the transfer (observed as -EIO at ~15 s). With 0 the
	 * top-up simply stops when the runway is full and the loop is free
	 * to catch up. RX keeps its own timeout for i2s_read.
	 */
	tx_config.timeout = 0;
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
	       "(mic %u Hz up, agent 24 kHz down)\n",
	       16000000U / MIC_BCLK_TOP, 16000000U / MIC_LRCLK_TOP,
	       SAMPLE_RATE);
	error = i2s_trigger(i2s, I2S_DIR_BOTH, I2S_TRIGGER_START);
	if (error != 0) {
		goto teardown_clocks;
	}
	i2s_running = true;
	started_at = k_uptime_get();
	clear_button_events();
	k_msgq_purge(&mic_raw_q);
	atomic_set(&audio_thread_error, 0);
	/* Hand the I2S deadlines to the audio thread from here on. */
	audio_i2s_dev = i2s;
	atomic_set(&convo_active, 1);

	while (true) {
		void *block;
		int64_t loop_started;

		/*
		 * Codec-side loop. The audio thread owns every I2S deadline;
		 * this one may take as long as an Opus frame needs without
		 * endangering the transfer. A missed block here costs mic
		 * audio (counted as mic_drops), never the conversation.
		 */
		if (k_msgq_get(&mic_raw_q, &block, K_MSEC(200)) != 0) {
			if (atomic_get(&convo_end_req) ||
			    !atomic_get(&convo_active)) {
				break;
			}
			continue;
		}
		loop_started = k_uptime_get();
		memcpy(raw_processing, block, MIC_RX_BLOCK_SIZE);
		k_mem_slab_free(&mic_rx_slab, block);

		size_t size = MIC_RX_BLOCK_SIZE;

		if (block_index < MIC_STARTUP_SKIP_BLOCKS) {
			++block_index;
			clear_button_events();
			continue;
		}
		++block_index;

		/* Decide duck/hold for THIS block before any of it is encoded. */
		convo_update_uplink_adapt();

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
				/* Harness builds only, and only while armed:
				 * swap the mic's stage for injected PCM before
				 * the encoder ever sees it. */
				(void)pendant_inject_fill_stage(
					mic_stage_samples, MIC_STAGE_FRAMES);
				live_tx_offer_stage(mic_stage_samples,
						    MIC_STAGE_FRAMES);
				stage_frames = 0U;
			}
		}
		if (live_stream_failed) {
			result = -EIO;
			break;
		}

		/* The WS thread moves bytes; this loop only decodes. The
		 * audio thread owns playback state and barge-in flushes. */
		convo_decode_downlink();

		/*
		 * Blue button, mid-conversation: push-to-talk does not nest
		 * inside a call. Consume the press and tick, so it cannot fire
		 * a surprise capture the moment this conversation ends.
		 */
		ptt_press_ignored_in_conversation();

		if (atomic_get(&convo_end_req)) {
			/* Relay 'end' (mutual silence) or transport close —
			 * a normal conversation ending, not a failure. */
			printk("Conversation ended by relay/transport\n");
			error = 0;
			break;
		}

		/* Solid LED while agent audio is buffered, blink otherwise. */
		if (dl_jitter_fill() > 0U) {
			gpio_pin_set_dt(&led, 1);
			next_led_toggle = k_uptime_get() + 250;
		} else if (k_uptime_get() >= next_led_toggle) {
			gpio_pin_toggle_dt(&led);
			next_led_toggle = k_uptime_get() + 250;
		}

		/* Knob at full rate exactly when it matters — while agent
		 * audio is playing. Internally gated to 50 ms; the one-shot
		 * SAADC read is microseconds against the TX runway. */
		volume_poll();
		/*
		 * The bench keeps watching mid-conversation. A diagnostic that
		 * goes blind during its own audio window is the failure this
		 * replaces: the owner presses a button BECAUSE audio is
		 * playing, so that is precisely when the dashboard must not
		 * stop reporting. Rate-limited inside (150 ms floor,
		 * change-driven), so a quiet call here is a few register reads.
		 */
		pendant_bench_tick();

		if (k_uptime_get() - started_at >
		    (int64_t)CONVO_MAX_SECONDS * 1000) {
			printk("Conversation hit the %u s cap\n",
			       CONVO_MAX_SECONDS);
			break;
		}
#if PENDANT_BOOT_CONVERSATION_TEST
		if (k_uptime_get() - started_at >
		    (int64_t)PENDANT_BOOT_CONVERSATION_SECONDS * 1000) {
			printk("Self-test conversation window elapsed\n");
			break;
		}
#endif
		/* Bounce/release edges from the starting press for the first
		 * second; after that a press ends the conversation. */
		if (k_uptime_get() - started_at < 1000) {
			clear_button_events();
		} else if (k_sem_take(&button_press_sem, K_NO_WAIT) == 0 ||
			   take_remote_press()) {
			haptic_trigger(HAPTIC_PATTERN_CLICK);
			printk("Conversation ended by button\n");
			break;
		}

		/* Loop time is the whole ballgame: exceed the TX runway and
		 * the driver kills the duplex transfer. Track the worst. */
		uint32_t loop_ms = (uint32_t)(k_uptime_get() - loop_started);

		if (loop_ms > convo_max_loop_ms) {
			convo_max_loop_ms = loop_ms;
		}
	}

	/* Stop the audio thread before touching I2S or the slabs. */
	atomic_set(&convo_active, 0);
	/* Never leave the legacy record path gated by a conversation's hold. */
	convo_uplink_holding = false;
#ifdef CONFIG_PENDANT_MIC_INJECT
	/*
	 * Injection is scoped to one conversation, and disarming here is the
	 * safety net for a host that died mid-run. An armed ring nobody is
	 * feeding does not fail loudly — it silently replaces the microphone
	 * with silence, so the owner's next press would record nothing and
	 * look like broken hardware. Bounding that to the conversation it was
	 * armed for keeps a debug tool from becoming a latent product fault.
	 */
	pendant_inject_arm = 0U;
#endif
	k_msleep(30);
	if (result == 0 && atomic_get(&audio_thread_error) != 0) {
		result = (int)atomic_get(&audio_thread_error);
	}
	{
		void *stale;

		while (k_msgq_get(&mic_raw_q, &stale, K_NO_WAIT) == 0) {
			k_mem_slab_free(&mic_rx_slab, stale);
		}
	}

	printk("Conversation stats: rx_blocks=%u tx_blocks=%u tx_starved=%u "
	       "decoded_packets=%u max_loop_ms=%u fifo_left=%u "
	       "uplink_drops=%u mic_drops=%u tx_peak=%u "
	       "duck_ms=%u uplink_held=%u" PENDANT_INJECT_STATS_FMT
	       PENDANT_STORE_STATS_FMT "\n",
	       convo_rx_blocks, convo_tx_blocks, convo_tx_starved,
	       convo_decoded_packets, convo_max_loop_ms,
	       (uint32_t)live_fifo_fill(), convo_uplink_drops,
	       convo_mic_drops, convo_tx_peak, convo_uplink_duck_ms,
	       convo_uplink_held PENDANT_INJECT_STATS_ARGS
		       PENDANT_STORE_STATS_ARGS);
	printk("Codec cost: decode avg=%u us max=%u us n=%u | "
	       "encode avg=%u us max=%u us n=%u\n",
	       convo_decode_calls
		       ? cycles_to_us(convo_decode_cycles / convo_decode_calls)
		       : 0U,
	       cycles_to_us(convo_decode_max_cycles), convo_decode_calls,
	       convo_encode_calls
		       ? cycles_to_us(convo_encode_cycles / convo_encode_calls)
		       : 0U,
	       cycles_to_us(convo_encode_max_cycles), convo_encode_calls);

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
	/* Whatever happens next, the gate belongs to the NEXT press. */
	atomic_set(&convo_uplink_gate, 0);
	k_mutex_lock(&ws_lock, K_FOREVER);
	/*
	 * Only a conversation the relay was told about needs telling it is
	 * over. A press answered on-device was never announced, so a "stop"
	 * here would be this device's only transmission for that press —
	 * spending the radio to report that it did not need the radio.
	 */
	if (uplink_open && pendant_ws_connected() && !stop_sent) {
		(void)pendant_ws_send_text("{\"type\":\"stop\"}");
		stop_sent = true;
	}
	k_mutex_unlock(&ws_lock);
	pendant_opus_stream_abort();
	pendant_opus_reply_decoder_end();
	clear_button_events();
	/* A green or blue press mid-conversation was not a capture request —
	 * it was a mispress during a call. Consuming both here keeps them from
	 * firing a surprise capture the moment the call ends. */
	clear_memo_events();
	clear_ptt_events();
	if (result == 0 && error != 0) {
		result = error;
	}
	return result;
}

/*
 * Green button: record-only memo. The same proven capture machinery as a
 * voice command — record_microphone with the live chunked uplink and the
 * SD journal fallback — with pendant_cloud's memo latch held for the whole
 * cycle, so every request this press can possibly make (live stream, SD
 * single-shot, offline hold) reaches the relay as ?dispatch=0: transcribed
 * and stored, planner never woken. Runs regardless of whether the converse
 * WebSocket is up; a memo never wants the duplex path because a memo wants
 * no reply.
 */
static int run_memo_capture(const struct device *i2s)
{
	int64_t memo_started = k_uptime_get();
	uint32_t pcm_bytes;
	int error;

	pendant_cloud_stream_set_memo(true);
	memo_capture_active = true;
	error = record_microphone(i2s, MAX_RECORD_SAMPLE_COUNT);
	memo_capture_active = false;
	/* Mic closed, upload in flight: leaving RECORDING fires the exit tick
	 * and the amber breath says the work is not finished yet. */
	pendant_status_set(PENDANT_STATUS_THINKING);
	gpio_pin_set_dt(&led, 0);
	if (error != 0) {
		printk("Memo recording failed: %d\n", error);
		pendant_cloud_stream_abort();
		recording_on_sd = false;
		pendant_cloud_stream_set_memo(false);
		pendant_status_set(PENDANT_STATUS_IDLE);
		pendant_status_set(PENDANT_STATUS_FAILED);
		flash_led(3U, 120, 120);
		return error;
	}

	pcm_bytes = recorded_samples * (uint32_t)sizeof(int16_t);

	bool live_ok = pendant_cloud_stream_active() && !live_stream_failed &&
		       pendant_cloud_stream_bytes_sent() > 0U;

	error = -EIO;
	if (live_ok) {
		error = pendant_cloud_stream_end();
		printk("LAT memo_stream_end_ms=%lld pcm_bytes=%u result=%d\n",
		       k_uptime_get() - memo_started,
		       pendant_cloud_uploaded_pcm_bytes, error);
	} else if (pendant_cloud_stream_active()) {
		pendant_cloud_stream_abort();
	}

	if (error < 0 && recording_on_sd && pcm_bytes > 0U) {
		printk("Memo fallback SD upload (%u bytes, live_result=%d)\n",
		       pcm_bytes, error);
		error = pendant_cloud_upload_recording(SD_RECORDING_PATH,
						       pcm_bytes, SAMPLE_RATE);
		if (error < 0) {
			/* Same rename-into-the-outbox rescue as a failed
			 * command, under the memo kind so redelivery keeps
			 * the planner off (see pendant_store.h). */
			int queue_error = pendant_store_enqueue_memo(pcm_bytes);

			if (queue_error == 0) {
				printk("Memo held for later delivery "
				       "(upload=%d)\n",
				       error);
				pendant_cloud_stream_set_memo(false);
				/* Held, not lost: the memo is safe on the
				 * card, so this is a success the owner can
				 * walk away from. */
				pendant_status_set(PENDANT_STATUS_IDLE);
				pendant_status_set(PENDANT_STATUS_DONE);
				flash_led(2U, 60, 90);
				return 0;
			}
			printk("Could not hold memo: %d\n", queue_error);
		}
	}
	pendant_cloud_stream_set_memo(false);

	printk("LAT memo_total_ms=%lld result=%d\n",
	       k_uptime_get() - memo_started, error);
	pendant_status_set(PENDANT_STATUS_IDLE);
	if (error < 0) {
		pendant_status_set(PENDANT_STATUS_FAILED);
		flash_led(5U, 100, 100);
		return error;
	}
	/* Two calm flashes: memo landed, nothing is going to talk back. */
	pendant_status_set(PENDANT_STATUS_DONE);
	flash_led(2U, 60, 90);
	return 0;
}

/*
 * ---- Blue button: PUSH-TO-TALK ----
 *
 * WHY THIS IS THE CHEAPEST WAY TO ASK A QUESTION (owner's ruling, and the
 * arithmetic behind it — hardware/design/Solar_Feasibility.md §4.3):
 *
 *   A PTT question (10 s ask + 15 s reply) costs 0.94 mWh. The SAME
 *   question asked as a short duplex exchange costs 2.3 mWh. 2.4x, and the
 *   reason is not the codec or the speaker — it is WHEN the radio is on.
 *   Capturing with the modem out of connected mode draws 4.2 mA; the
 *   modem's connected floor is ~65 mA (45 mA RX monitor before any TX,
 *   x1.2 wrist antenna penalty). Duplex pays that floor for every second
 *   the human is talking and thinking. Push-to-talk pays 4.2 mA for those
 *   seconds and touches the radio exactly once.
 *
 *   That once is not free either: every radio touch pays a ~0.32 mWh RRC
 *   connection tax (setup + the C-DRX release tail). Which is precisely why
 *   this is ONE connection — capture with the radio off, then a single
 *   chunked upload that carries the question up and the spoken answer back
 *   down the same socket, then idle. Splitting it into "upload now, fetch
 *   the reply later" would double the tax and wipe out most of the win.
 *
 * The mechanism invents no transport. It is the proven non-duplex HTTP
 * command shape: /v1/pendant/command with dispatch ON (this is a question —
 * the planner is the point, unlike the green button's ?dispatch=0) and
 * X-Reply-Stream: opus, so the relay streams the reply as length-prefixed
 * Opus packets on the upload socket. Playback is the conversation's own
 * downlink path — same decoder, same 24 kHz jitter ring, same 96/125 TX
 * resampler, same sync preamble — so whatever the current sink is (the
 * ESP32/Bluetooth or the MAX98357A speaker, per audio_sink) hears it with
 * no new audio code at all.
 */
/* 45 s of reply at 20.48 ms per I2S block. A "short spoken answer" that
 * outruns this is a bug upstream, and a runaway must not hold the mic. */
#define PTT_REPLY_MAX_BLOCKS 2200U
/* Blocks to keep playing after the stream ends: the TX runway (10) plus the
 * FIR tail, so the last syllable leaves the wire before DROP discards it. */
#define PTT_REPLY_TAIL_BLOCKS 14U

/*
 * Pull whatever the reply socket has ready and decode it into the jitter
 * ring. Non-blocking by contract, and bounded exactly like the conversation
 * downlink (CONVO_MAX_DECODES_PER_BLOCK) so one call can never overrun the
 * I2S block it is riding between.
 *
 * dl_rx_frame is the reassembly buffer. It is the WS conversation's
 * main-thread frame slot, idle by construction here (no conversation can be
 * open during a PTT reply), so a 640 B staging area costs zero new RAM.
 */
static bool ptt_reply_pump(size_t *fill, bool *eof)
{
	unsigned int decodes = 0U;
	size_t offset = 0U;
	bool starved = false;
	int received;

	if (!*eof && *fill < sizeof(dl_rx_frame.data)) {
		received = pendant_cloud_reply_read(dl_rx_frame.data + *fill,
						    sizeof(dl_rx_frame.data) -
							    *fill);
		if (received > 0) {
			*fill += (size_t)received;
		} else if (received == 0) {
			*eof = true; /* clean end of the reply body */
		} else if (received != -EAGAIN) {
			printk("PTT reply read failed: %d\n", received);
			*eof = true;
		}
	}

	while (offset + 2U <= *fill && decodes < CONVO_MAX_DECODES_PER_BLOCK) {
		size_t packet_bytes = ((size_t)dl_rx_frame.data[offset] << 8) |
				      dl_rx_frame.data[offset + 1U];

		if (packet_bytes == 0U ||
		    packet_bytes > sizeof(dl_rx_frame.data) - 2U) {
			printk("PTT reply framing broken (len=%u)\n",
			       (unsigned int)packet_bytes);
			*eof = true;
			*fill = 0U;
			return true;
		}
		if (offset + 2U + packet_bytes > *fill) {
			break; /* packet still arriving */
		}
		/* Receive gate: never decode into a ring that cannot hold the
		 * result — the same rule the conversation downlink follows. */
		if (DL_JITTER_SAMPLES - 1U - dl_jitter_fill() <
		    DL_WORST_FRAME_SAMPLES) {
			starved = true;
			break;
		}
		int decoded = pendant_opus_reply_decode_packet(
			dl_rx_frame.data + offset + 2U, packet_bytes,
			dl_decode_buf, ARRAY_SIZE(dl_decode_buf));

		if (decoded > 0) {
			dl_jitter_put(dl_decode_buf, (size_t)decoded);
		}
		offset += 2U + packet_bytes;
		++decodes;
	}

	if (offset > 0U) {
		*fill -= offset;
		memmove(dl_rx_frame.data, dl_rx_frame.data + offset, *fill);
	}
	/*
	 * "Done" means the socket is finished AND nothing decodable is left.
	 * The loop exits for three reasons and only one of them means empty:
	 * it hit the per-block decode cap (more to come), the jitter ring was
	 * full (more to come), or it ran out of bytes — which after EOF is the
	 * end, including the case where the tail is an incomplete packet the
	 * relay will never finish. Deciding on the socket alone would cut the
	 * last packets; deciding on the buffer alone would spin on that
	 * trailing fragment until the runaway cap, holding the microphone.
	 */
	return *eof && !starved && decodes < CONVO_MAX_DECODES_PER_BLOCK;
}

/*
 * Play the inline reply through the current sink. Duplex I2S bring-up and
 * teardown are copied from reflex_chime_play for the reason stated there:
 * i2s_nrfx memcmps the two directions' configs and TX-only as a clock slave
 * is an unproven path, so the mic runs and its blocks are discarded. The
 * discarded RX read is also what paces this loop at one block per 20.48 ms.
 */
static int ptt_reply_play(const struct device *i2s)
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
	size_t fill = 0U;
	uint32_t blocks = 0U;
	uint32_t tail_blocks = 0U;
	bool playing = false;
	bool source_eof = false;
	bool source_done = false;
	bool i2s_running = false;
	int error;

	error = k_mem_slab_init(&mic_rx_slab, mic_rx_storage,
				MIC_RX_BLOCK_SIZE, MIC_RX_BLOCK_COUNT);
	if (error != 0) {
		return error;
	}
	dl_jitter_reset();
	tx_resample_reset();
	convo_tx_peak = 0U;

	/* The encoder is finished with the workspace; the decoder has its own
	 * arena, so the two never contend here the way they do in a call. */
	error = pendant_opus_reply_decoder_begin_rate(
		opus_dec_arena, sizeof(opus_dec_arena),
		PENDANT_OPUS_REPLY_SAMPLE_RATE);
	if (error < 0) {
		printk("PTT reply decoder init failed: %d\n", error);
		return error;
	}
	(void)pendant_cloud_reply_set_nonblocking(true);

	mic_clocks_start();
	error = i2s_configure(i2s, I2S_DIR_RX, &config);
	if (error == 0) {
		tx_config = config;
		tx_config.mem_slab = &convo_tx_slab;
		tx_config.timeout = 0; /* never block the fill loop */
		error = i2s_configure(i2s, I2S_DIR_TX, &tx_config);
	}
	/* The ESP32 re-hunts sync after every BCLK restart; without this the
	 * front of the answer is eaten by its lock search. */
	if (error == 0) {
		error = convo_queue_preamble(i2s);
	}
	if (error == 0) {
		k_msleep(MIC_POWERUP_BUDGET_MS);
		error = i2s_trigger(i2s, I2S_DIR_BOTH, I2S_TRIGGER_START);
	}
	if (error == 0) {
		i2s_running = true;
		gpio_pin_set_dt(&led, 1);
		while (blocks < PTT_REPLY_MAX_BLOCKS) {
			void *block;
			size_t size;

			if (i2s_read(i2s, &block, &size) != 0) {
				printk("PTT reply I2S read failed\n");
				break;
			}
			k_mem_slab_free(&mic_rx_slab, block);
			++blocks;

			if (!source_done) {
				source_done = ptt_reply_pump(&fill,
							     &source_eof);
			}
			error = convo_top_up_tx(i2s, &playing);
			if (error != 0) {
				printk("PTT reply I2S write failed: %d\n",
				       error);
				break;
			}
			if (source_done && dl_jitter_fill() == 0U) {
				if (++tail_blocks >= PTT_REPLY_TAIL_BLOCKS) {
					break;
				}
			} else {
				tail_blocks = 0U;
			}
		}
	}

	if (i2s_running) {
		/* DROP, never DRAIN — draining as a clock slave wedges
		 * i2s_nrfx until a power cycle (same rule as every other
		 * teardown in this file). */
		(void)i2s_trigger(i2s, I2S_DIR_BOTH, I2S_TRIGGER_DROP);
		k_msleep(MIC_STOP_SETTLE_MS);
	}
	mic_clocks_stop();
	gpio_pin_set_dt(&led, 0);
	pendant_opus_reply_decoder_end();
	printk("PTT reply played: blocks=%u peak=%u sink=%s error=%d\n", blocks,
	       convo_tx_peak, audio_sink_name(audio_sink_current), error);
	return error;
}

/*
 * Blue button, whole cycle: capture radio-off, upload once with the planner
 * on, play the answer, radio back to idle.
 *
 * The upload reuses the live encoder + FIFO + chunked-POST machinery a
 * yellow press uses, only fed from the microSD journal instead of the
 * microphone: the FIFO holds ~7 KB (a few seconds of Opus) while a 30 s
 * question is ~60 KB, so feed and pump have to interleave exactly as they
 * do during a live capture. That is the same code path, not a parallel one.
 */
static int run_ptt_question(const struct device *i2s)
{
	int64_t ptt_started = k_uptime_get();
	struct fs_file_t journal;
	uint32_t pcm_bytes;
	bool journal_open = false;
	int error;

	/* dispatch ON: a question wants the planner. The memo latch is the
	 * only thing that could turn it off, so state it rather than assume
	 * the last press left it clean. */
	pendant_cloud_stream_set_memo(false);
	capture_radio_off = true;
	ptt_capture_active = true;
	error = record_microphone(i2s, MAX_RECORD_SAMPLE_COUNT);
	ptt_capture_active = false;
	capture_radio_off = false;
	/* Question captured; the radio, the upload and the answer are all
	 * still ahead. Amber until the reply plays. */
	pendant_status_set(PENDANT_STATUS_THINKING);
	gpio_pin_set_dt(&led, 0);
	if (error != 0) {
		printk("PTT capture failed: %d\n", error);
		recording_on_sd = false;
		pendant_status_set(PENDANT_STATUS_IDLE);
		pendant_status_set(PENDANT_STATUS_FAILED);
		flash_led(3U, 120, 120);
		return error;
	}

	pcm_bytes = recorded_samples * (uint32_t)sizeof(int16_t);
	if (pcm_bytes == 0U || !recording_on_sd) {
		printk("PTT capture produced nothing to ask (%u B, sd=%d)\n",
		       pcm_bytes, recording_on_sd ? 1 : 0);
		pendant_status_set(PENDANT_STATUS_IDLE);
		pendant_status_set(PENDANT_STATUS_FAILED);
		flash_led(3U, 120, 120);
		return -ENODATA;
	}
	printk("LAT ptt_capture_ms=%lld pcm_bytes=%u\n",
	       k_uptime_get() - ptt_started, pcm_bytes);

	/* THE radio touch. One socket, one RRC connection, question up and
	 * answer down. */
	error = pendant_cloud_stream_ensure(PENDANT_OPUS_SAMPLE_RATE);
	if (error == 0) {
		live_stream_failed = false;
		live_tx_saturated = false;
		live_fifo_reset();
		error = pendant_opus_stream_begin_packets(
			SAMPLE_RATE, audio_workspace, OPUS_TX_ARENA_BYTES,
			live_opus_packet_sink);
		if (error != 0) {
			printk("PTT encoder init failed: %d\n", error);
			pendant_cloud_stream_abort();
		}
	}
	if (error == 0) {
		fs_file_t_init(&journal);
		error = fs_open(&journal, SD_RECORDING_PATH, FS_O_READ);
		journal_open = error == 0;
	}
	while (error == 0 && journal_open) {
		/* mic_stage_samples is the capture staging buffer, free the
		 * moment the mic stops — reused here so the read costs no RAM. */
		ssize_t got = fs_read(&journal, mic_stage_samples,
				      MIC_STAGE_BYTES);

		if (got < 0) {
			error = (int)got;
			break;
		}
		if (got == 0) {
			break;
		}
		size_t frames = (size_t)got / sizeof(int16_t);

		/* Pad a short final read: the encoder's stage contract is a
		 * whole MIC_STAGE_FRAMES block. */
		while (frames < MIC_STAGE_FRAMES) {
			mic_stage_samples[frames++] = 0;
		}
		live_tx_offer_stage(mic_stage_samples, MIC_STAGE_FRAMES);
		live_tx_pump(PCM_TX_PUMP_BUDGET_MS);
		if (live_stream_failed) {
			error = -EIO;
		}
	}
	if (journal_open) {
		(void)fs_close(&journal);
	}
	if (error == 0 && pendant_opus_stream_active()) {
		error = pendant_opus_stream_end(NULL);
	}
	if (error == 0) {
		/* Flush whatever the encoder's tail left in the FIFO: a
		 * partial batch would otherwise sit below LIVE_TX_BATCH_BYTES
		 * forever and truncate the question's last word. */
		live_tx_flush = true;
		for (unsigned int pass = 0U;
		     pass < 200U && live_fifo_fill() > 0U && !live_stream_failed;
		     ++pass) {
			live_tx_pump(20U);
		}
		error = pendant_cloud_stream_end();
		printk("LAT ptt_upload_ms=%lld pcm_bytes=%u result=%d\n",
		       k_uptime_get() - ptt_started,
		       pendant_cloud_uploaded_pcm_bytes, error);
	}
	pendant_opus_stream_abort();
	/*
	 * Any failure before stream_end left a chunked POST half-written on an
	 * open TLS socket. Close it here or the next press inherits a stream
	 * the relay is still waiting on — and the modem stays in connected
	 * mode, which is the one thing this whole mode exists to avoid.
	 */
	if (error < 0 && pendant_cloud_stream_active()) {
		pendant_cloud_stream_abort();
	}

	if (error == PENDANT_CLOUD_REPLY_INLINE) {
		int play_error = ptt_reply_play(i2s);

		pendant_cloud_reply_stream_close();
		printk("LAT ptt_total_ms=%lld play=%d\n",
		       k_uptime_get() - ptt_started, play_error);
		/* The answer has been spoken: this is the moment the whole
		 * blue-button cycle was for. */
		pendant_status_set(PENDANT_STATUS_IDLE);
		pendant_status_set(play_error == 0 ? PENDANT_STATUS_DONE
						   : PENDANT_STATUS_FAILED);
		flash_led(2U, 60, 90);
		return play_error;
	}

	if (error < 0) {
		/*
		 * No usable link. The question parks in the outbox under its
		 * own kind: it redelivers with the planner ON (it was a
		 * question, not a memo), but the answer cannot be spoken later
		 * — the socket that would have carried it is gone. It lands in
		 * history instead, and pendant_store.h says so where the kind
		 * is defined.
		 */
		int queue_error = pendant_store_enqueue_question(pcm_bytes);

		pendant_status_set(PENDANT_STATUS_IDLE);
		if (queue_error == 0) {
			printk("PTT question held offline (upload=%d); the "
			       "answer will be in history, not in your ear\n",
			       error);
			pendant_status_set(PENDANT_STATUS_DONE);
			flash_led(2U, 60, 90);
			return 0;
		}
		printk("Could not hold PTT question: %d (upload=%d)\n",
		       queue_error, error);
		pendant_status_set(PENDANT_STATUS_FAILED);
		flash_led(5U, 100, 100);
		return error;
	}

	/* 2xx with no inline reply: the relay took the question but had
	 * nothing to say back. Two calm flashes, same as a memo. */
	printk("PTT question delivered with no spoken reply (HTTP %d)\n",
	       pendant_cloud_last_http_status);
	pendant_status_set(PENDANT_STATUS_IDLE);
	pendant_status_set(PENDANT_STATUS_DONE);
	flash_led(2U, 60, 90);
	return 0;
}

/*
 * Configure every 2026-08-12 breadboard control. All best-effort, all
 * logged: the pattern is the bookmark button's ("losing bookmarks is bad;
 * refusing to boot a voice pendant over a spare button is worse"), applied
 * to five more inputs. A control that fails here simply never fires.
 */
static void configure_control_inputs(void)
{
	/*
	 * What actually came up, for the bench telemetry at the end of this
	 * function. A control that failed above has its key OMITTED from every
	 * telemetry line rather than reported as a level of 0 — see bench.h,
	 * rule 2. These are the only honest source for that: the pad of an
	 * unconfigured pin reads a number, and the number means nothing.
	 */
	struct pendant_bench_config bench = {
		.button_pin = { -1, -1, -1 },
		.encoder_a_pin = -1,
		.encoder_b_pin = -1,
		.mic_sense_pin = -1,
		.amp_pin = -1,
		.firmware = "pendant app",
	};

	/* Yellow "ask": a second body for button 1, same ISR, same
	 * semaphore, so every existing press path hears it unchanged. */
	if (gpio_is_ready_dt(&ask_button) &&
	    gpio_pin_configure_dt(&ask_button, GPIO_INPUT) == 0) {
		bench.button_pin[PENDANT_BENCH_YELLOW] = (int8_t)ask_button.pin;
		bench.button_active_level[PENDANT_BENCH_YELLOW] =
			(ask_button.dt_flags & GPIO_ACTIVE_LOW) ? 0U : 1U;
		gpio_init_callback(&ask_button_callback, button_pressed,
				   BIT(ask_button.pin));
		if (gpio_add_callback(ask_button.port, &ask_button_callback) !=
			    0 ||
		    gpio_pin_interrupt_configure_dt(
			    &ask_button, GPIO_INT_EDGE_TO_ACTIVE) != 0) {
			printk("Ask button (P0.21) unavailable\n");
		}
	} else {
		printk("Ask button (P0.21) not configured\n");
	}

	if (gpio_is_ready_dt(&memo_button) &&
	    gpio_pin_configure_dt(&memo_button, GPIO_INPUT) == 0) {
		bench.button_pin[PENDANT_BENCH_GREEN] = (int8_t)memo_button.pin;
		bench.button_active_level[PENDANT_BENCH_GREEN] =
			(memo_button.dt_flags & GPIO_ACTIVE_LOW) ? 0U : 1U;
		gpio_init_callback(&memo_button_callback, memo_button_pressed,
				   BIT(memo_button.pin));
		if (gpio_add_callback(memo_button.port,
				      &memo_button_callback) != 0 ||
		    gpio_pin_interrupt_configure_dt(
			    &memo_button, GPIO_INT_EDGE_TO_ACTIVE) != 0) {
			printk("Memo button (P0.22) unavailable\n");
		}
	} else {
		printk("Memo button (P0.22) not configured\n");
	}

	if (gpio_is_ready_dt(&ptt_button) &&
	    gpio_pin_configure_dt(&ptt_button, GPIO_INPUT) == 0) {
		bench.button_pin[PENDANT_BENCH_BLUE] = (int8_t)ptt_button.pin;
		bench.button_active_level[PENDANT_BENCH_BLUE] =
			(ptt_button.dt_flags & GPIO_ACTIVE_LOW) ? 0U : 1U;
		gpio_init_callback(&ptt_button_callback, ptt_button_pressed,
				   BIT(ptt_button.pin));
		if (gpio_add_callback(ptt_button.port, &ptt_button_callback) !=
			    0 ||
		    gpio_pin_interrupt_configure_dt(
			    &ptt_button, GPIO_INT_EDGE_TO_ACTIVE) != 0) {
			printk("Push-to-talk button (P0.23) unavailable\n");
		}
	} else {
		printk("Push-to-talk button (P0.23) not configured\n");
	}

	/* Encoder: both phases in ONE callback (same port), both edges —
	 * the quadrature table needs every transition, not just presses.
	 * The dwell work item is initialised BEFORE the interrupts are armed:
	 * the first detent reschedules it, and rescheduling an uninitialised
	 * work item from an ISR is not a race worth having. */
	k_work_init_delayable(&menu_dwell_work, menu_dwell_expired);
	if (gpio_is_ready_dt(&encoder_a) && gpio_is_ready_dt(&encoder_b) &&
	    gpio_pin_configure_dt(&encoder_a, GPIO_INPUT) == 0 &&
	    gpio_pin_configure_dt(&encoder_b, GPIO_INPUT) == 0) {
		bench.encoder_a_pin = (int8_t)encoder_a.pin;
		bench.encoder_b_pin = (int8_t)encoder_b.pin;
		encoder_prev_state = encoder_read_state();
		gpio_init_callback(&encoder_callback, encoder_edge_isr,
				   BIT(encoder_a.pin) | BIT(encoder_b.pin));
		if (gpio_add_callback(encoder_a.port, &encoder_callback) !=
			    0 ||
		    gpio_pin_interrupt_configure_dt(&encoder_a,
						    GPIO_INT_EDGE_BOTH) != 0 ||
		    gpio_pin_interrupt_configure_dt(&encoder_b,
						    GPIO_INT_EDGE_BOTH) != 0) {
			printk("Encoder (P0.24/25) unavailable\n");
		}
	} else {
		printk("Encoder (P0.24/25) not configured\n");
	}

	/* No encoder-push block, and that is the design: the owner's knob has
	 * no switch wired (P0.28 free). Select is the dwell above. Configuring
	 * an unwired pin as an interrupt source would be a floating input
	 * waking the CPU on breadboard noise. */

	/* Mic-power sense: polled, no interrupt, and NO PULL — it watches
	 * the mic VDD net through 100k and must not bias it. */
	if (gpio_is_ready_dt(&mic_sense) &&
	    gpio_pin_configure_dt(&mic_sense, GPIO_INPUT) == 0) {
		mic_sense_ready = true;
		bench.mic_sense_pin = (int8_t)mic_sense.pin;
		printk("Mic power sense ready (P0.26): mic is %s\n",
		       mic_power_is_cut() ? "MUTED (power cut)" : "powered");
	} else {
		printk("Mic power sense (P0.26) not configured — assuming "
		       "mic powered\n");
	}

	/* Speaker amp gate, driven to the boot default (bluetooth = low =
	 * amp shutdown) before anything can play. Optional like the rest:
	 * no pin, no speaker, everything else unaffected. */
	if (gpio_is_ready_dt(&amp_sd_mode) &&
	    gpio_pin_configure_dt(&amp_sd_mode, GPIO_OUTPUT_INACTIVE) == 0) {
		amp_sd_mode_ready = true;
		bench.amp_pin = (int8_t)amp_sd_mode.pin;
	} else {
		printk("Speaker amp gate (P0.01) not configured\n");
	}
	audio_sink_apply(AUDIO_SINK_BOOT_DEFAULT);

	/* Volume knob (SAADC): probe-once, degrades to "feature absent" on a
	 * bare breadboard. */
	volume_adc_init();

	/*
	 * Last, so it inherits the true outcome of every probe above. The
	 * emitter is read-only from here on — it samples pads and counters and
	 * prints; it never drives a pin, never takes a lock and never touches
	 * a semaphore, so no control's behaviour depends on whether it is
	 * compiled in.
	 */
	pendant_bench_init(&bench);
}

/*
 * The owner hard-muted the mic and pressed a capture button anyway. Say so
 * on every channel this device has: the control frame lets the relay (and
 * eventually the agent) know the press happened and why nothing follows,
 * and the LED pattern answers the thumb directly — three fast double-taps,
 * used nowhere else. Capture is suppressed entirely: recording a powered-
 * down mic would upload thirty seconds of pulldown silence as if the owner
 * had spoken.
 */
static void report_mic_muted_press(void)
{
	/* The long soft buzz is the haptic twin of the triple double-blink:
	 * "heard you, but the red switch says no". */
	haptic_trigger(HAPTIC_PATTERN_LONG);
	printk("Capture press ignored: mic power is cut (red switch)\n");
	if (pendant_ws_connected()) {
		k_mutex_lock(&ws_lock, K_FOREVER);
		(void)pendant_ws_send_text("{\"type\":\"mic_muted\"}");
		k_mutex_unlock(&ws_lock);
	}
	for (unsigned int burst = 0U; burst < 3U; ++burst) {
		flash_led(2U, 40, 40);
		k_msleep(120);
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
#ifdef CONFIG_PENDANT_OFFLINE_STORE
	/*
	 * Button 2 is a convenience, not a dependency: if it fails to
	 * configure, log it and keep going. Losing bookmarks is bad; refusing
	 * to boot a voice pendant over a spare button is worse.
	 */
	if (gpio_is_ready_dt(&mark_button) &&
	    gpio_pin_configure_dt(&mark_button, GPIO_INPUT) == 0) {
		gpio_init_callback(&mark_button_callback, mark_button_pressed,
				   BIT(mark_button.pin));
		if (gpio_add_callback(mark_button.port,
				      &mark_button_callback) != 0 ||
		    gpio_pin_interrupt_configure_dt(
			    &mark_button, GPIO_INT_EDGE_TO_ACTIVE) != 0) {
			printk("Bookmark button unavailable — use "
			       "pendant_remote_mark\n");
		}
	} else {
		printk("Bookmark button not present on this board\n");
	}
#endif
	configure_control_inputs();

	/*
	 * FEEDBACK BEFORE FALLIBILITY.  Everything from here down can fail
	 * fatally — the I2S device, the microSD mount, the modem — and every
	 * one of those failures ends in show_error(), which never returns.
	 * So the two channels that tell the owner what happened have to be
	 * alive BEFORE the first of them, or a boot that dies on a missing
	 * card leaves the status LED unconfigured and the pendant simply dark:
	 * the exact symptom that reads as "the LED is broken".
	 *
	 * Both are safe this early.  haptic_init() is a single I2C probe and
	 * degrades to "no motor" on a bare breadboard.  pendant_status_init()
	 * configures three pads and schedules one work item; the mic-mute
	 * probe it is handed is guarded by mic_sense_ready, so calling it
	 * before the sense pin exists reports "not muted" rather than reading
	 * an unconfigured pad.  configure_control_inputs() above has in fact
	 * already set that pin up — this ordering is belt and braces.
	 */
	(void)haptic_init();
	/*
	 * The one and only I2C probe this firmware performs, so it is the only
	 * honest source for the bench's bus tile. Reported as an ADDRESS LIST
	 * (empty when the part stayed silent), never as "the bus is broken":
	 * the external 4.7k pull-ups and their 3 V rail were measured healthy
	 * over SWD on 2026-08-13, so silence here is a question about the
	 * DRV2605L's own power or its SDA/SCL leg.
	 */
	pendant_bench_note_i2c(haptic_available());
	pendant_status_init(mic_power_is_cut);

	if (!device_is_ready(i2s)) {
		audio_cycle_result = -ENODEV;
		show_error();
	}

	if (mount_sd_card() == 0 && test_sd_persistence() != 0) {
		sd_ready = false;
	}
	/*
	 * Re-stated AFTER the persistence test, not just inside mount_sd_card:
	 * a card that mounts and then cannot be written to is the failure this
	 * board actually has, and reporting the mount alone told the dashboard
	 * "sd mounted: true" about a card the firmware had already given up on.
	 * The bench must agree with the firmware's own verdict or it is not an
	 * instrument, it is a second opinion nobody asked for.
	 */
	pendant_bench_note_sd(sd_ready);
	if (!sd_ready) {
		printk("microSD is required for Internet voice upload\n");
		audio_cycle_result = sd_mount_result;
		show_error();
	}

	/*
	 * Before LTE, deliberately: the queue must come back from the card
	 * whether or not this boot ever gets signal. A recovery path that
	 * depends on the network is not a recovery path.
	 */
	pendant_store_init();

	/*
	 * Bluetooth policy, also before LTE and for the same reason: the sink
	 * table lives on the card, the module is on a UART, and neither needs
	 * a network. A boot that never finds signal should still come up with
	 * the owner's headphones connected.
	 */
	pendant_bt_init();

	/*
	 * Reflex layer, also before LTE for the same reason: a timer or a
	 * daily nudge that only exists once the network is up is not a
	 * reflex.  The motor and the status subsystem it depends on came up
	 * earlier, above the first fatal path — see "FEEDBACK BEFORE
	 * FALLIBILITY" there for why that ordering is not negotiable.
	 */
	pendant_reflex_init(&reflex_ops_impl);

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

	/* And the I2S deadlines live on a cooperative thread that does
	 * nothing but move buffers — codecs can never delay it. */
	audio_i2s_dev = i2s;
	k_thread_create(&audio_thread_data, audio_thread_stack,
			K_THREAD_STACK_SIZEOF(audio_thread_stack),
			audio_thread_fn, NULL, NULL, NULL,
			AUDIO_THREAD_PRIORITY, 0, K_NO_WAIT);
	k_thread_name_set(&audio_thread_data, "audio");

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
#if PENDANT_BOOT_CONVERSATION_TEST
	bool boot_conversation_test_pending = true;
#endif

	while (true) {
		/*
		 * Ready: hold ONE WebSocket open (pings keep Cloudflare's
		 * 100 s idle killer away) instead of rebuilding TLS every
		 * 15 s like the chunked-HTTP prewarm had to.
		 */
		audio_cycle_phase = 0U;
		gpio_pin_set_dt(&led, 0);
		apply_forced_link_state();
		if (!pendant_ws_connected() && !link_is_forced_offline()) {
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
#if PENDANT_BOOT_CONVERSATION_TEST
		if (boot_conversation_test_pending) {
			boot_conversation_test_pending = false;
			printk("SELFTEST_CONVERSATION_BEGIN window=%u s\n",
			       PENDANT_BOOT_CONVERSATION_SECONDS);
			k_msleep(1500);
			k_sem_give(&button_press_sem);
		}
#endif
		/* Wait for a press. The WS I/O thread keeps the idle socket
		 * alive (pings + stray drains); main only reconnects. */
		bool marked = false;
		bool memo_requested = false;
		bool ptt_requested = false;

		while (k_sem_take(&button_press_sem, K_MSEC(200)) != 0) {
			if (take_remote_press()) {
				break;
			}
			/* Green button: record-only memo, no planner. */
			if (take_memo_press()) {
				memo_requested = true;
				break;
			}
			/* Blue button: push-to-talk question. */
			if (take_ptt_press()) {
				ptt_requested = true;
				break;
			}
			/*
			 * Bluetooth policy rides the idle wait, the one
			 * context that owns the UART, the card and the socket
			 * at the same time: consume module events, act on the
			 * relay's menu requests, answer with the device list.
			 */
			pendant_bt_poll();
			if (pendant_bt_list_requested()) {
				char devices[320];
				size_t length = pendant_bt_devices_frame(
					devices, sizeof(devices));

				if (length > 0U && pendant_ws_connected()) {
					k_mutex_lock(&ws_lock, K_FOREVER);
					(void)pendant_ws_send_text(devices);
					k_mutex_unlock(&ws_lock);
				}
				pendant_bt_list_answered();
			}
			/* Knob while idle: 5 Hz (this loop's cadence) is
			 * plenty for a level that only matters once audio
			 * plays; the conversation loop polls at full rate. */
			volume_poll();
			/*
			 * The bench, on the loop the owner is actually looking
			 * at: this is where the pendant sits while a wire is
			 * being wiggled. A press shorter than this loop's 200 ms
			 * turn is still caught — the ISR latches the edge and
			 * this call drains it (see bench.h).
			 */
			pendant_bench_tick();
			/*
			 * Button 2 needs no radio, no microphone and no
			 * decision about whether the link is usable. It is
			 * the one thing this device can always do.
			 *
			 * A double-press inside 600 ms is the reflex
			 * gesture; the window only opens while a gesture
			 * recipe is armed (see reflex_mark_double_press),
			 * so the plain bookmark path is undelayed until
			 * the owner installs one.
			 */
			if (take_mark_press()) {
				if (reflex_mark_double_press()) {
					pendant_reflex_fire_gesture();
					continue;
				}
				marked = true;
				break;
			}
			/*
			 * Reflex work rides the idle wait, the one context
			 * where I2S, the codec scratch and the SD card are
			 * all guaranteed unowned: store a pending downlink
			 * recipe (+ack upstream), then fire whatever came
			 * due.  Recipes received mid-conversation sit in
			 * their one-slot buffer until the conversation
			 * ends and this loop runs again.
			 */
			{
				char reflex_ack[96];

				if (pendant_reflex_process_pending(
					    reflex_ack,
					    sizeof(reflex_ack)) > 0 &&
				    pendant_ws_connected()) {
					k_mutex_lock(&ws_lock, K_FOREVER);
					(void)pendant_ws_send_text(
						reflex_ack);
					k_mutex_unlock(&ws_lock);
				}
			}
			pendant_reflex_tick();
			apply_forced_link_state();
			if (!pendant_ws_connected() &&
			    !link_is_forced_offline()) {
				int ws_error;

				k_mutex_lock(&ws_lock, K_FOREVER);
				ws_error = pendant_ws_connect();
				k_mutex_unlock(&ws_lock);
				if (ws_error != 0) {
					printk("Idle WS reconnect failed: %d\n",
					       ws_error);
				}
			}

			/*
			 * Drain the backlog HERE, inside the wait, not at the
			 * top of the outer loop: the outer loop only turns
			 * over when a press ends, so a device sitting idle
			 * after a dead zone would hold yesterday's memos
			 * until the owner happened to press the button —
			 * exactly the person the queue exists to spare.
			 *
			 * A live WebSocket is the only honest proof this
			 * device has that the link works (the modem reports
			 * an attached network while every relay socket times
			 * out), so delivery is gated on that and never on a
			 * timer or on optimism. One item per pass, skipped
			 * entirely while a press is pending: a held 30 s memo
			 * takes seconds to upload and the owner must never
			 * wait behind it.
			 */
			if (pendant_ws_connected()) {
				pendant_store_poll_alerts();
				if (pendant_store_pending() > 0U &&
				    k_sem_count_get(&button_press_sem) == 0U &&
				    pendant_remote_press == 0U) {
					(void)pendant_store_drain_one(
						SAMPLE_RATE);
				}
			}
		}
		/* Latency-first: act on the active edge, never the release. */
		clear_button_events();

		if (marked) {
			(void)pendant_store_enqueue_mark(
				pendant_ws_connected());
			/* One short flash: marked, nothing else happened. */
			flash_led(1U, 60, 120);
			continue;
		}

		/*
		 * Every capture path defers to the red latching switch: with
		 * mic power cut there is nothing to record, only a pulldown
		 * hum to upload, so the press becomes a notification instead
		 * of a capture. Checked before the WS/legacy split because
		 * it outranks both.
		 */
		if (mic_power_is_cut()) {
			report_mic_muted_press();
			clear_memo_events();
			clear_ptt_events();
			clear_button_events();
			continue;
		}

		if (memo_requested) {
			audio_cycle_phase = 1U;
			/* Memo opens on a tick (and closes on one — see the
			 * stop path in record_microphone). */
			haptic_trigger(HAPTIC_PATTERN_TICK);
			(void)run_memo_capture(i2s);
			clear_memo_events();
			clear_button_events();
			continue;
		}

		if (ptt_requested) {
			audio_cycle_phase = 1U;
			/* Same click a command press gets: the thumb is told
			 * the microphone is live before any other work. */
			haptic_trigger(HAPTIC_PATTERN_CLICK);
			(void)run_ptt_question(i2s);
			clear_ptt_events();
			clear_button_events();
			continue;
		}

		/*
		 * The owner is here. This is the moment the alert inbox
		 * exists for, and it deliberately runs BEFORE any decision
		 * about the link: reading held alerts is a card read and a
		 * printk, so it works identically with the radio powered off.
		 */
		if (pendant_store_inbox_pending() > 0U) {
			flash_led(2U, 60, 90);
			pendant_store_surface_inbox();
		}

		/*
		 * Press = converse. Full-duplex WebSocket when the socket is
		 * up; the proven record-then-reply HTTP cycle when it is not
		 * (that path still journals to microSD when LTE is down).
		 */
		audio_cycle_phase = 1U;
		/* Press acknowledged in the skin, before any radio work —
		 * the LED's answer can be seconds away on a cold socket. */
		haptic_trigger(HAPTIC_PATTERN_CLICK);
		int64_t lat_press_started = k_uptime_get();

		bool ws_ready = pendant_ws_connected();

		if (!ws_ready && !link_is_forced_offline()) {
			k_mutex_lock(&ws_lock, K_FOREVER);
			ws_ready = pendant_ws_connect() == 0;
			k_mutex_unlock(&ws_lock);
		}
		if (ws_ready) {
			error = run_conversation(i2s);
			/* Idle first, THEN the verdict: idle is what the
			 * device goes back to, and it also clears any
			 * approval the owner just answered out loud. */
			pendant_status_set(PENDANT_STATUS_IDLE);
			gpio_pin_set_dt(&led, 0);
			printk("LAT conversation_ms=%lld result=%d\n",
			       k_uptime_get() - lat_press_started, error);
			report_main_stack_headroom("conversation");
			if (error != 0) {
				audio_cycle_result = error;
				pendant_status_set(PENDANT_STATUS_FAILED);
				flash_led(4U, 100, 100);
			} else {
				audio_cycle_result = 0;
				pendant_status_set(PENDANT_STATUS_DONE);
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

		/* Mic closed; the upload is the work that follows. */
		pendant_status_set(PENDANT_STATUS_THINKING);
		gpio_pin_set_dt(&led, 0);
		audio_cycle_phase = 2U;
		if (capture_error != 0) {
			printk("Microphone recording failed: %d\n", capture_error);
			pendant_cloud_stream_abort();
			recording_on_sd = false;
			audio_cycle_result = capture_error;
			pendant_status_set(PENDANT_STATUS_IDLE);
			pendant_status_set(PENDANT_STATUS_FAILED);
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
				if (error < 0) {
					/*
					 * Both uplinks are gone and the mic
					 * journal on the card is all that is
					 * left of what the owner said. Take
					 * ownership of it (a rename, not a
					 * copy) before the next press
					 * truncates the file. This is the
					 * ONLY place a recording is retained
					 * past its upload attempt — the
					 * standing rule is that SD is the
					 * failure path, never the default.
					 */
					int queue_error =
						pendant_store_enqueue_voice(
							pcm_bytes);

					if (queue_error == 0) {
						printk("Voice memo held for "
						       "later delivery "
						       "(upload=%d)\n",
						       error);
						audio_cycle_result = 0;
						pendant_status_set(
							PENDANT_STATUS_IDLE);
						pendant_status_set(
							PENDANT_STATUS_DONE);
						flash_led(2U, 60, 90);
						clear_button_events();
						continue;
					}
					printk("Could not hold voice memo: "
					       "%d\n",
					       queue_error);
				}
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
			pendant_status_set(PENDANT_STATUS_IDLE);
			pendant_status_set(PENDANT_STATUS_FAILED);
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
		pendant_status_set(PENDANT_STATUS_IDLE);
		pendant_status_set(PENDANT_STATUS_DONE);
		for (unsigned int flash = 0U; flash < 3U; ++flash) {
			gpio_pin_set_dt(&led, 1);
			k_msleep(180);
			gpio_pin_set_dt(&led, 0);
			k_msleep(180);
		}
		k_msleep(200);
	}
}

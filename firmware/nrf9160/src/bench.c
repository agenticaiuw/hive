#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>
#include <hal/nrf_gpio.h>

#include "bench.h"
#include "pendant_bt.h"

#if IS_ENABLED(CONFIG_PENDANT_BENCH_TELEMETRY)

/*
 * Floor between two fast lines. The console is shared with real logging and
 * with a live audio path whose printk blocks the calling thread for ~87 us a
 * byte, so a ~180 byte line costs ~16 ms. Six a second would be a tenth of the
 * CPU spent talking about itself; 150 ms is fast enough that a human wiggling
 * a wire sees the number move in the same gesture.
 */
#define BENCH_MIN_INTERVAL_MS 150
/*
 * Heartbeat, and its value is not a taste call: benchSnapshot() on the Mac
 * computes `stream.connected` as "a line parsed less than 3000 ms ago". A
 * slower heartbeat than that makes an idle, perfectly healthy pendant render
 * as a disconnected one between changes — the instrument reporting its own
 * silence as the board's. 2 s sits inside that window with margin for a
 * console busy with real logging, and costs ~180 B (1.6 ms of UART) per beat.
 */
#define BENCH_HEARTBEAT_MS 2000
/*
 * Facts that cannot change without a reboot or a re-probe. Slower than the
 * fast line by an order of magnitude, but not so slow that a dashboard opened
 * mid-session waits a long time to learn what firmware it is looking at.
 */
#define BENCH_SLOW_INTERVAL_MS 10000
/*
 * SAADC flicker at this gain is a couple of LSB and the wiper adds its own.
 * Emitting on every count would turn a resting knob into a permanent 6 Hz
 * stream; 16 counts (0.4 %) is far below anything a finger does and far above
 * the noise. The heartbeat still carries the latest raw either way, so a slow
 * drift is never hidden — only un-emitted between beats.
 */
#define BENCH_POT_EPSILON 16

#define BENCH_LEVEL_UNSEEN (-1)

static struct pendant_bench_config cfg;
static bool bench_ready;

/*
 * Set by the button ISRs, drained by the emitter.
 *
 * The buttons interrupt on the ACTIVE edge only (there is no release
 * interrupt), and the emitter runs at 5 Hz on the idle loop. A 90 ms tap
 * therefore falls entirely between two samples: the pad is high before it and
 * high after it, and a sampling-only emitter would report a button that never
 * moved — the precise verdict the owner is trying to distinguish from a wire
 * that fell off. So the ISR latches the fact of the edge, and the next emit
 * reports the pad at the ACTIVE level rather than re-reading a pad the finger
 * has already left. The release then arrives as an ordinary sample.
 */
static atomic_t button_latch;
static atomic_t encoder_cw;
static atomic_t encoder_ccw;

/* Latest known values. -1 (or NULL) means "never sampled", which is emitted as
 * an ABSENT key, never as a zero. */
static int pot_raw = BENCH_LEVEL_UNSEEN;
static int8_t i2c_haptic = BENCH_LEVEL_UNSEEN;
static int8_t sd_mounted = BENCH_LEVEL_UNSEEN;

/* What the last fast line actually said, so "changed" is a real comparison. */
static int8_t last_button[PENDANT_BENCH_BUTTON_COUNT];
static int8_t last_encoder_a = BENCH_LEVEL_UNSEEN;
static int8_t last_encoder_b = BENCH_LEVEL_UNSEEN;
static int32_t last_detents = -1;
static int last_pot = BENCH_LEVEL_UNSEEN;
static int8_t last_mic = BENCH_LEVEL_UNSEEN;
static int8_t last_amp = BENCH_LEVEL_UNSEEN;
static int64_t last_fast_ms = -1;
static int64_t last_slow_ms = -1;

/*
 * snprintf that cannot run off the end and cannot be fooled by its own return
 * value (which is what the string WOULD have been, not what was written).
 */
static size_t bench_append(char *buffer, size_t size, size_t used,
			   const char *format, ...)
{
	va_list args;
	int written;

	if (used + 1U >= size) {
		return used;
	}
	va_start(args, format);
	written = vsnprintf(buffer + used, size - used, format, args);
	va_end(args);
	if (written < 0) {
		return used;
	}
	return MIN(used + (size_t)written, size - 1U);
}

static int bench_read_pad(int8_t pin)
{
	if (pin < 0) {
		return BENCH_LEVEL_UNSEEN;
	}
	return (int)nrf_gpio_pin_read((uint32_t)pin);
}

void pendant_bench_init(const struct pendant_bench_config *config)
{
	if (config == NULL) {
		return;
	}
	cfg = *config;
	for (size_t index = 0U; index < PENDANT_BENCH_BUTTON_COUNT; ++index) {
		last_button[index] = BENCH_LEVEL_UNSEEN;
	}
	bench_ready = true;
	/*
	 * One line at boot so the dashboard has a name and an identity before
	 * the owner touches anything. Without it the page sits on "no data"
	 * for up to the heartbeat, which reads as a dead board.
	 */
	last_slow_ms = -1;
	last_fast_ms = -1;
	pendant_bench_tick();
}

void pendant_bench_note_button(enum pendant_bench_button which)
{
	if (which < PENDANT_BENCH_BUTTON_COUNT) {
		(void)atomic_or(&button_latch, (atomic_val_t)BIT(which));
	}
}

void pendant_bench_note_detent(int step)
{
	if (step > 0) {
		(void)atomic_inc(&encoder_cw);
	} else if (step < 0) {
		(void)atomic_inc(&encoder_ccw);
	}
}

void pendant_bench_note_pot(int raw)
{
	if (raw >= 0) {
		pot_raw = raw;
	}
}

void pendant_bench_note_i2c(bool haptic_answered)
{
	i2c_haptic = haptic_answered ? 1 : 0;
}

void pendant_bench_note_sd(bool mounted)
{
	sd_mounted = mounted ? 1 : 0;
}

/*
 * The facts a 10 Hz line has no business repeating: what this firmware is,
 * whether the haptic answered its one boot probe, whether the card mounted.
 * Omission is meaningful here too — an un-probed subsystem says nothing rather
 * than claiming a negative result.
 */
static void bench_emit_slow(int64_t now)
{
	char line[192];
	size_t used = 0U;

	used = bench_append(line, sizeof(line), used,
			    "BENCH {\"v\":1,\"up\":%lld", (long long)now);
	if (cfg.firmware != NULL) {
		used = bench_append(line, sizeof(line), used, ",\"fw\":\"%s\"",
				    cfg.firmware);
	}
	if (i2c_haptic >= 0) {
		/*
		 * 7-bit addresses as NUMBERS, per the parser. 0x5a = 90 is the
		 * DRV2605L. An empty array is a real measurement — "the bus was
		 * scanned and nothing answered" — and the Mac renders it as a
		 * question about the DEVICE, not about the pull-ups: those were
		 * measured healthy over SWD on 2026-08-13 (P0.30/31 both hold
		 * HIGH against the nRF's internal pull-down, while unwired
		 * P0.28 collapses LOW under identical treatment).
		 */
		used = bench_append(line, sizeof(line), used, ",\"i2c\":[%s]",
				    i2c_haptic ? "90" : "");
	}
	if (sd_mounted >= 0) {
		/*
		 * `present` only when the card actually mounted. A failed mount
		 * does NOT prove the card is absent (it may be unseated, or the
		 * card itself may be refusing CMD0), so the key is left out and
		 * the Mac's own rule for the driver's "Card error on CMD0" log
		 * line supplies the verdict with the right wording.
		 */
		used = bench_append(line, sizeof(line), used,
				    sd_mounted ? ",\"sd\":{\"present\":true,\"mounted\":true}"
					       : ",\"sd\":{\"mounted\":false}");
	}
	{
		/*
		 * The ESP32 stands in for a dumb Bluetooth module, so "did the
		 * ESP32 answer" is literally "has uart1 ever produced a line".
		 * NULL when there is no UART at all — an un-probed link, not a
		 * silent one.
		 */
		const char *esp = pendant_bt_module_state();

		if (esp != NULL) {
			used = bench_append(line, sizeof(line), used,
					    ",\"esp\":\"%s\"", esp);
		}
	}
	used = bench_append(line, sizeof(line), used, "}");
	printk("%s\n", line);
}

void pendant_bench_tick(void)
{
	int8_t button[PENDANT_BENCH_BUTTON_COUNT];
	int encoder_a;
	int encoder_b;
	int mic;
	int amp = BENCH_LEVEL_UNSEEN;
	int32_t cw;
	int32_t ccw;
	int32_t detents;
	atomic_val_t latch;
	bool changed;
	int64_t now;
	char line[256];
	size_t used = 0U;

	if (!bench_ready) {
		return;
	}
	now = k_uptime_get();

	if (last_slow_ms < 0 || now - last_slow_ms >= BENCH_SLOW_INTERVAL_MS) {
		last_slow_ms = now;
		bench_emit_slow(now);
	}

	if (last_fast_ms >= 0 && now - last_fast_ms < BENCH_MIN_INTERVAL_MS) {
		return;
	}

	latch = atomic_clear(&button_latch);
	for (size_t index = 0U; index < PENDANT_BENCH_BUTTON_COUNT; ++index) {
		if (cfg.button_pin[index] < 0) {
			button[index] = BENCH_LEVEL_UNSEEN;
		} else if (latch & (atomic_val_t)BIT(index)) {
			button[index] =
				(int8_t)cfg.button_active_level[index];
		} else {
			button[index] =
				(int8_t)bench_read_pad(cfg.button_pin[index]);
		}
	}
	encoder_a = bench_read_pad(cfg.encoder_a_pin);
	encoder_b = bench_read_pad(cfg.encoder_b_pin);
	mic = bench_read_pad(cfg.mic_sense_pin);
	if (cfg.amp_pin >= 0) {
		/*
		 * OUT, not IN. The amp gate is an output whose input buffer is
		 * disconnected, so the pad register reads a constant 0 — which
		 * would be a fake "amp in shutdown" that never changes. The OUT
		 * register is a real register read of the level this chip is
		 * actually driving, and that is exactly what "0 = amp in
		 * shutdown" means for a pin only this firmware drives.
		 */
		amp = (int)nrf_gpio_pin_out_read((uint32_t)cfg.amp_pin);
	}
	cw = (int32_t)atomic_get(&encoder_cw);
	ccw = (int32_t)atomic_get(&encoder_ccw);
	detents = cw + ccw;

	/*
	 * A latched edge always emits. Comparing it away would be possible in
	 * exactly one case — a pad already sitting at the active level — and
	 * that is the case of a shorted or stuck button, which is the last
	 * thing a bench should go quiet about.
	 */
	changed = latch != 0;
	for (size_t index = 0U; index < PENDANT_BENCH_BUTTON_COUNT; ++index) {
		if (button[index] != last_button[index]) {
			changed = true;
		}
	}
	if (encoder_a != last_encoder_a || encoder_b != last_encoder_b) {
		changed = true;
	}
	if (detents != last_detents) {
		changed = true;
	}
	if (mic != last_mic) {
		changed = true;
	}
	if (amp != last_amp) {
		changed = true;
	}
	if (pot_raw >= 0 &&
	    (last_pot < 0 || abs(pot_raw - last_pot) >= BENCH_POT_EPSILON)) {
		changed = true;
	}
	if (!changed && last_fast_ms >= 0 &&
	    now - last_fast_ms < BENCH_HEARTBEAT_MS) {
		return;
	}

	used = bench_append(line, sizeof(line), used,
			    "BENCH {\"v\":1,\"up\":%lld", (long long)now);

	if (button[PENDANT_BENCH_YELLOW] >= 0 ||
	    button[PENDANT_BENCH_GREEN] >= 0 ||
	    button[PENDANT_BENCH_BLUE] >= 0) {
		bool first = true;

		used = bench_append(line, sizeof(line), used, ",\"btn\":{");
		for (size_t index = 0U; index < PENDANT_BENCH_BUTTON_COUNT;
		     ++index) {
			if (button[index] < 0) {
				continue;
			}
			used = bench_append(line, sizeof(line), used,
					    "%s\"p%d\":%d", first ? "" : ",",
					    (int)cfg.button_pin[index],
					    (int)button[index]);
			first = false;
		}
		used = bench_append(line, sizeof(line), used, "}");
	}

	if (encoder_a >= 0 || encoder_b >= 0) {
		used = bench_append(line, sizeof(line), used, ",\"enc\":{");
		if (encoder_a >= 0) {
			used = bench_append(line, sizeof(line), used,
					    "\"a\":%d,", encoder_a);
		}
		if (encoder_b >= 0) {
			used = bench_append(line, sizeof(line), used,
					    "\"b\":%d,", encoder_b);
		}
		used = bench_append(line, sizeof(line), used,
				    "\"pos\":%d,\"det\":%d,\"cw\":%d,\"ccw\":%d}",
				    (int)(cw - ccw), (int)detents, (int)cw,
				    (int)ccw);
	}

	if (pot_raw >= 0) {
		used = bench_append(line, sizeof(line), used,
				    ",\"pot\":{\"raw\":%d}", pot_raw);
	}
	if (mic >= 0) {
		used = bench_append(line, sizeof(line), used,
				    ",\"mic\":{\"sense\":%d}", mic);
	}
	if (amp >= 0) {
		used = bench_append(line, sizeof(line), used, ",\"amp\":%d",
				    amp);
	}
	used = bench_append(line, sizeof(line), used, "}");
	printk("%s\n", line);

	for (size_t index = 0U; index < PENDANT_BENCH_BUTTON_COUNT; ++index) {
		last_button[index] = button[index];
	}
	last_encoder_a = (int8_t)encoder_a;
	last_encoder_b = (int8_t)encoder_b;
	last_detents = detents;
	last_mic = (int8_t)mic;
	last_amp = (int8_t)amp;
	if (pot_raw >= 0) {
		last_pot = pot_raw;
	}
	last_fast_ms = now;
}

#endif /* CONFIG_PENDANT_BENCH_TELEMETRY */

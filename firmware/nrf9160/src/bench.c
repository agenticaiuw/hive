#include <stdarg.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>
#include <hal/nrf_gpio.h>

#include <nrf_modem_at.h>

#include "bench.h"
#include "pendant_bt.h"
#include "pendant_ws.h"

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
/*
 * Gate on the modem existing at all. Before pendant_cloud_init() returns there
 * is nothing to ask, and "not registered / socket down" would be a claim about
 * a radio that has not been switched on rather than a measurement of one.
 */
static bool lte_ready;
/* An audio path owns the I2S deadlines right now — see pendant_bench_tick. */
static bool bench_busy;
/*
 * The live microphone level, and the reason it is a separate question from
 * mic.sense: sense answers "is the switch feeding it power", level answers "is
 * it hearing anything". Those are different faults with different fixes, and
 * the owner currently cannot tell them apart. Never sampled while the mic is
 * unpowered — you cannot measure a dark microphone — so it stays absent rather
 * than reporting a confident silence.
 */
static int32_t mic_peak = BENCH_LEVEL_UNSEEN;
static int32_t mic_rms = BENCH_LEVEL_UNSEEN;

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

void pendant_bench_note_lte_ready(bool ready)
{
	lte_ready = ready;
}

void pendant_bench_set_busy(bool busy)
{
	bench_busy = busy;
}

void pendant_bench_note_mic_level(int32_t peak, int32_t rms)
{
	if (peak >= 0 && rms >= 0) {
		mic_peak = peak;
		mic_rms = rms;
	}
}

/*
 * +CEREG <stat> -> the parser's vocabulary, translated here rather than on the
 * Mac because 3GPP 27.007 is the stable contract and the number is the thing
 * the modem actually said. Every one of these is a legitimate state; only
 * "not-registered" after a long search is a fault, and none of them is an
 * error the dashboard should paint red.
 */
static const char *bench_reg_name(int stat)
{
	switch (stat) {
	case 0:
		return "not-registered";
	case 1:
		return "home";
	case 2:
		return "searching";
	case 3:
		return "denied";
	case 4:
		return "unknown";
	case 5:
		return "roaming";
	case 90:
		return "uicc-fail";
	default:
		return NULL;
	}
}

/*
 * Copy one comma-separated AT field, stripping the quotes the modem puts
 * around strings. Returns false when the field is absent or empty, which is
 * what keeps an unparsed field OMITTED rather than emitted as "".
 */
static bool bench_at_field(const char *line, unsigned int index, char *out,
			   size_t out_size)
{
	const char *cursor = strchr(line, ':');
	unsigned int field = 0U;
	size_t length = 0U;

	if (cursor == NULL) {
		return false;
	}
	++cursor;
	while (field < index) {
		cursor = strchr(cursor, ',');
		if (cursor == NULL) {
			return false;
		}
		++cursor;
		++field;
	}
	while (*cursor == ' ') {
		++cursor;
	}
	if (*cursor == '"') {
		++cursor;
		while (*cursor != '"' && *cursor != '\0' &&
		       length + 1U < out_size) {
			out[length++] = *cursor++;
		}
	} else {
		while (*cursor != ',' && *cursor != '\0' && *cursor != '\r' &&
		       *cursor != '\n' && length + 1U < out_size) {
			out[length++] = *cursor++;
		}
	}
	out[length] = '\0';
	return length > 0U;
}

/*
 * One AT round trip per slow line, and only once the modem exists. Everything
 * here degrades to an omitted key: a modem that will not answer, a field that
 * will not parse, or an index the modem reports as 255 ("I do not know") all
 * leave the key out rather than inventing a number. 255 in particular must
 * never reach the Mac as a value — it is not a signal level, it is the absence
 * of one, and -115 dBm is a real reading that would be indistinguishable.
 */
static size_t bench_append_lte(char *line, size_t size, size_t used)
{
	char at[160];
	char field[40];
	bool open = false;

	if (!lte_ready) {
		return used;
	}

	if (nrf_modem_at_cmd(at, sizeof(at), "AT+CEREG?") == 0 &&
	    bench_at_field(at, 1U, field, sizeof(field))) {
		const char *name = bench_reg_name(atoi(field));

		if (name != NULL) {
			used = bench_append(line, size, used,
					    ",\"lte\":{\"reg\":\"%s\"", name);
			open = true;
		}
	}
	if (!open) {
		return used;
	}

	if (nrf_modem_at_cmd(at, sizeof(at), "AT+CESQ") == 0) {
		/* +CESQ: rxlev,ber,rscp,ecno,rsrq,rsrp */
		if (bench_at_field(at, 5U, field, sizeof(field))) {
			int index = atoi(field);

			if (index >= 0 && index <= 97) {
				used = bench_append(line, size, used,
						    ",\"rsrp\":%d",
						    index - 140);
			}
		}
		if (bench_at_field(at, 4U, field, sizeof(field))) {
			int index = atoi(field);

			if (index >= 0 && index <= 34) {
				/* dB = index/2 - 19.5, kept in tenths so the
				 * half-dB step survives integer formatting. */
				int tenths = index * 5 - 195;

				used = bench_append(line, size, used,
						    ",\"rsrq\":%d.%d",
						    tenths / 10,
						    tenths < 0 ? -(tenths % 10)
							       : tenths % 10);
			}
		}
	}

	if (nrf_modem_at_cmd(at, sizeof(at), "AT%%XMONITOR") == 0) {
		/* %XMONITOR: stat,full,short,plmn,tac,AcT,band,cell,... */
		if (bench_at_field(at, 1U, field, sizeof(field))) {
			used = bench_append(line, size, used, ",\"op\":\"%s\"",
					    field);
		}
		if (bench_at_field(at, 5U, field, sizeof(field))) {
			int act = atoi(field);

			/* 7 = E-UTRAN (LTE-M), 9 = NB-IoT. Anything else is a
			 * radio this product does not use; say nothing. */
			if (act == 7 || act == 9) {
				used = bench_append(line, size, used,
						    ",\"mode\":\"%s\"",
						    act == 7 ? "ltem"
							     : "nbiot");
			}
		}
		if (bench_at_field(at, 6U, field, sizeof(field))) {
			used = bench_append(line, size, used, ",\"band\":%d",
					    atoi(field));
		}
		if (bench_at_field(at, 7U, field, sizeof(field))) {
			used = bench_append(line, size, used,
					    ",\"cell\":\"%s\"", field);
		}
	}

	return bench_append(line, size, used, "}");
}

/*
 * The facts a 10 Hz line has no business repeating: what this firmware is,
 * whether the haptic answered its one boot probe, whether the card mounted.
 * Omission is meaningful here too — an un-probed subsystem says nothing rather
 * than claiming a negative result.
 */
static void bench_emit_slow(int64_t now)
{
	/*
	 * Sized for the worst case with every optional key present — fw, i2c,
	 * sd, esp, a named-and-addressed bt sink, sock, and a full lte block
	 * with operator name — which lands near 360 bytes. bench_append cannot
	 * overrun, but a truncated line is a DROPPED line on the Mac (invalid
	 * JSON), and dropping the status line is how a dashboard ends up
	 * showing stale LTE forever without anything looking wrong.
	 */
	char line[448];
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

			/*
			 * The sink rides the same "is there a module" guard:
			 * with no UART there is nothing that could know
			 * whether a speaker is connected, and false would be a
			 * claim rather than a reading.
			 */
			char name[40];
			char addr[24];
			bool connected = pendant_bt_current_sink(
				name, sizeof(name), addr, sizeof(addr));

			used = bench_append(line, sizeof(line), used,
					    ",\"bt\":{\"conn\":%s",
					    connected ? "true" : "false");
			if (name[0] != '\0') {
				used = bench_append(line, sizeof(line), used,
						    ",\"name\":\"%s\"", name);
			}
			if (addr[0] != '\0') {
				used = bench_append(line, sizeof(line), used,
						    ",\"addr\":\"%s\"", addr);
			}
			used = bench_append(line, sizeof(line), used, "}");
		}
	}

	/*
	 * The relay socket. Reported only once the modem is up, because before
	 * that "not connected" is not a measurement — nothing has tried.
	 */
	if (lte_ready) {
		int64_t last = pendant_ws_last_activity();

		used = bench_append(line, sizeof(line), used,
				    ",\"sock\":{\"up\":%s",
				    pendant_ws_connected() ? "true" : "false");
		if (last >= 0) {
			/* Omitted, not zero, until the socket has carried
			 * something: "0 ms since traffic" on a socket that has
			 * never carried any would read as perfect health. */
			used = bench_append(line, sizeof(line), used,
					    ",\"idle\":%lld",
					    (long long)(now - last));
		}
		used = bench_append(line, sizeof(line), used, "}");
	}

	used = bench_append_lte(line, sizeof(line), used);
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

	/*
	 * THE SLOW LINE STANDS DOWN DURING AUDIO, and this is not a nicety.
	 *
	 * It runs up to three blocking AT commands, and the I2S duplex path
	 * has a ~205 ms TX runway that the driver ERRORS the whole transfer
	 * over — RX included — if a buffer is late. A modem round trip on the
	 * main thread mid-conversation is exactly the kind of tens-of-ms stall
	 * that eats it. Status is the one thing on this console that can wait:
	 * the fast pad line keeps flowing throughout, so nothing about the
	 * wires goes dark, and the status resumes the moment audio is done.
	 */
	if (bench_busy) {
		last_slow_ms = now;
	} else if (last_slow_ms < 0 ||
		   now - last_slow_ms >= BENCH_SLOW_INTERVAL_MS) {
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
				    ",\"mic\":{\"sense\":%d", mic);
		/*
		 * The level rides the fast line beside its own sense pin, so
		 * the two facts about the microphone are never a merge apart:
		 * "powered and deaf" is only visible when both are current.
		 * Absent until something has actually measured it.
		 */
		if (mic_peak >= 0 && mic_rms >= 0) {
			used = bench_append(line, sizeof(line), used,
					    ",\"peak\":%d,\"rms\":%d",
					    (int)mic_peak, (int)mic_rms);
		}
		used = bench_append(line, sizeof(line), used, "}");
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

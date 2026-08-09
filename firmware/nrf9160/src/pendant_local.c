/*
 * Local command recognition — the words this pendant answers by itself.
 *
 * Contract, rationale and the enrollment protocol are in pendant_local.h.
 * This file is the fixed-point pipeline: Goertzel filterbank, log features,
 * an energy endpointer, and a banded DTW match against enrolled templates.
 *
 * STATIC RAM BUDGET (the binding constraint — this build has 6,780 B free
 * and the conversation buffers are all live at the moment this runs):
 *
 *     local_templates      2,320 B   4 slots x 48 frames x 12 bands + heads
 *     local_segment          576 B   the word being matched right now
 *     local_dtw_prev/cur       392 B   two rolling DTW rows, int32
 *     local_gz_s1/s2           288 B   36 Goertzel bins, two state words
 *     local_preroll             36 B   3 frames of onset that predate the
 *                                      endpointer opening
 *     counters/state         ~120 B
 *     -------------------------------
 *     total                ~3.7 KB    leaving ~3.0 KB of the free pool
 *
 * Nothing here grows with what was said, nothing is borrowed from the codec
 * arenas (they are in use), and there is no malloc.  A second template per
 * slot — which is the single biggest accuracy win available and the first
 * thing to spend RAM on — costs another 2,304 B and does NOT fit today.
 * That is the concrete number behind the half-duplex question: dropping the
 * 18,432 B opus_dec_arena would fund it eight times over.
 */

#include <errno.h>
#include <stdint.h>
#include <string.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

#include "pendant_local.h"

/* ---- Geometry --------------------------------------------------------- */

/*
 * 256 samples at 15,625 Hz = 16.384 ms.  Chosen so one 512-sample mic stage
 * is exactly two frames: the module rides the existing stage cadence and
 * never buffers audio of its own.
 */
#define LOCAL_FRAME_SAMPLES 256U
#define LOCAL_BINS 36U
#define LOCAL_BINS_PER_BAND 3U

/*
 * Goertzel bin plan.  Bins are 15625/256 = 61.04 Hz apart; three per band,
 * adjacent at the bottom and progressively spread at the top so the high
 * bands cover a proportionally wider slice without costing more bins:
 *
 *     band  1  bins  3, 4, 5     183 -  305 Hz
 *     band  2  bins  6, 7, 8     366 -  488 Hz
 *     band  3  bins  9,10,11     549 -  671 Hz
 *     band  4  bins 12,13,14     732 -  854 Hz
 *     band  5  bins 16,17,18     977 - 1099 Hz
 *     band  6  bins 20,21,22    1221 - 1343 Hz
 *     band  7  bins 25,26,27    1526 - 1648 Hz
 *     band  8  bins 30,32,34    1831 - 2075 Hz
 *     band  9  bins 37,39,41    2258 - 2502 Hz
 *     band 10  bins 46,49,52    2808 - 3174 Hz
 *     band 11  bins 58,61,64    3540 - 3906 Hz
 *     band 12  bins 74,78,82    4517 - 5005 Hz
 *
 * Coefficient is 2*cos(2*pi*k/256) in Q14; the largest is 32,679, so the
 * table fits int16 with room to spare.
 */
static const int16_t local_goertzel_coeff[LOCAL_BINS] = {
	 32679,  32610,  32522,  32413,  32286,  32138,
	 31972,  31786,  31581,  31357,  31114,  30853,
	 30274,  29957,  29622,  28899,  28511,  28106,
	 26791,  26320,  25833,  24279,  23170,  22006,
	 20160,  18868,  17531,  14010,  11793,   9512,
	  4808,   2411,      0,  -7962, -11039, -14010,
};

/* ---- Endpointer tuning ------------------------------------------------ */

/*
 * The floor is measured, not assumed: the first frames after the mic
 * settles are whatever the room sounds like, and every threshold below is
 * expressed against them.  Same principle as record_microphone's
 * end-of-utterance detector, which calibrated itself per press for exactly
 * this reason.
 */
#define LOCAL_FLOOR_FRAMES 6U
#define LOCAL_FLOOR_MIN 8U
/* Open at 2x the floor (or an absolute margin, whichever is larger).  The
 * in-capture VAD uses 1.5x because a false "still talking" there is free;
 * here a false open starts a word that has to be rejected later, so it is
 * deliberately tighter. */
#define LOCAL_OPEN_ABS 220U
/* Close well below the open level — hysteresis, or a word with a quiet
 * middle chatters the state machine into two half-words. */
#define LOCAL_CLOSE_ABS 90U
/* ~200 ms of quiet ends the word.  Shorter clips the release of a stop
 * consonant ("stop", "start") and DTW then matches the wrong template. */
#define LOCAL_HANGOVER_FRAMES 12U
/* Frames of onset kept from before the endpointer opened: a word's first
 * 50 ms is often below the open threshold but carries the place of
 * articulation, which is exactly what distinguishes the vocabulary. */
#define LOCAL_PREROLL_FRAMES 3U
/* Shorter than ~200 ms is a click, a breath or the button itself. */
#define LOCAL_MIN_FRAMES 12U
/*
 * Give up after this many frames without a finished word (~900 ms).  This
 * is the number that sits in the critical path of every ordinary
 * conversation, so it is kept as small as a one-word command allows.
 */
#define LOCAL_DECIDE_FRAMES 55U

/* ---- Matcher tuning --------------------------------------------------- */

/*
 * Distance is the accumulated L1 over 12 mean-removed log bands divided by
 * the DTW path length, so a unit is a quarter-bit of one band per frame.
 *
 * These two numbers ARE the safety argument, so they are measured, not
 * reasoned about.  tests/host/run_pendant_local_test.sh enrolls two words
 * and prints the distance of every variant against both templates; on that
 * separation test:
 *
 *     same word, identical                      0
 *     same word, half level                     5
 *     same word, quarter level                 13
 *     same word, 20% faster / slower           24
 *     same word, 35% faster                    27
 *     ---------------------------------------------
 *     a DIFFERENT enrolled word             53-65
 *     a word never enrolled at all    best 55, margin 10
 *
 * 40 sits with half again the headroom over the worst true match (27) and
 * well under the nearest impostor (55); a margin of 20 clears the worst
 * true margin (26) while rejecting the impostor's 10.
 *
 * READ THIS BEFORE TRUSTING THEM: that separation comes from synthesized
 * utterances, which repeat exactly.  A human saying the same word twice
 * will not score 0 — real same-word distances will be larger, and if they
 * exceed 40 this feature simply never fires and every press goes to the
 * cloud.  That is the SAFE direction and it is why these ship as they are:
 * losing a local match costs exactly what today costs, while a wrong match
 * fires the wrong recipe and says nothing about it.  Turn on
 * CONFIG_PENDANT_LOCAL_TRACE, make twenty real presses, and move the
 * thresholds onto the gap you actually measure.
 *
 *   accept   how close the winner must be in absolute terms
 *   margin   how much closer than the runner-up it must be
 *
 * Requiring both is what biases this toward the cloud: a word that is
 * merely nearest does not win.  Two slots taught the same word can never
 * fire at all — the margin between them is zero — which is the correct
 * failure: it costs a cloud round trip, whereas guessing between them runs
 * the wrong recipe.
 */
#define LOCAL_ACCEPT_DIST_DEFAULT 40U
#define LOCAL_MIN_MARGIN_DEFAULT 20U
/* Sakoe-Chiba half-width, in frames: how far the alignment may drift from
 * the diagonal.  10 frames = 164 ms of elasticity, which covers saying the
 * same word fast or slow; wider mostly buys the matcher permission to align
 * a wrong word onto a right one. */
#define LOCAL_DTW_BAND 10U
/* Sentinel for "no path reaches this cell". */
#define LOCAL_DTW_INF 0x3FFFFFFF

/*
 * CPU guard.
 *
 * A 512-sample stage arrives every 32.77 ms, and the filterbank is the only
 * new work on a loop that already carries the Opus encoder. Counting the
 * generated code: the Goertzel inner loop is 13 Thumb instructions per bin,
 * so 256 samples x 36 bins is ~144k cycles, about 2.25 ms per frame or
 * 4.5 ms per stage — roughly 14% of one 64 MHz core, and only for the
 * ~750 ms the decision window is open.
 *
 * That should fit comfortably, and it lands in the one phase of a press
 * where the DECODER is idle (the relay has not been told to start, so no
 * reply audio exists to decode). But "should" is not "does", and if it ever
 * does not, the failure would be a stalled conversation loop rather than a
 * missed keyword. So: measure every stage, and the first time the cost
 * exceeds this budget, give up on local matching for this press and let the
 * uplink open. Falling back to today's behaviour is always the safe move.
 */
#define LOCAL_STAGE_BUDGET_US 8000U

#define LOCAL_KEYWORD_PATH "/SD:/keywords.bin"
#define LOCAL_KEYWORD_MAGIC 0x4B574431U /* "KWD1" */

/* ---- State ------------------------------------------------------------ */

struct local_template {
	uint8_t frames; /* 0 = empty slot */
	uint8_t feat[PENDANT_LOCAL_MAX_FRAMES][PENDANT_LOCAL_BANDS];
};

static struct local_template local_templates[PENDANT_LOCAL_SLOTS];
static uint8_t local_segment[PENDANT_LOCAL_MAX_FRAMES][PENDANT_LOCAL_BANDS];
static uint8_t local_preroll[LOCAL_PREROLL_FRAMES][PENDANT_LOCAL_BANDS];
static int32_t local_dtw_prev[PENDANT_LOCAL_MAX_FRAMES + 1U];
static int32_t local_dtw_cur[PENDANT_LOCAL_MAX_FRAMES + 1U];
static int32_t local_gz_s1[LOCAL_BINS];
static int32_t local_gz_s2[LOCAL_BINS];

enum local_seg_state {
	LOCAL_SEG_IDLE = 0,
	LOCAL_SEG_SPEECH,
	LOCAL_SEG_HANGOVER,
};

static uint8_t local_seg_state;
static uint8_t local_seg_len;
static uint8_t local_preroll_len;
static uint8_t local_preroll_head;
static uint8_t local_hangover;
static uint16_t local_frame_index;
static uint32_t local_floor;
static uint8_t local_verdict;
static uint8_t local_slot_hit;
static uint8_t local_enroll_slot; /* 0 = recognizing, else the slot armed */
static bool local_ready;
/*
 * Longest enrolled template, in frames, and the segment length past which
 * no template can possibly still match it.
 *
 * This is what keeps an ordinary conversation cheap. An utterance that has
 * already run longer than the longest word the device knows, plus the DTW
 * band's worth of elasticity, cannot align to anything — so the verdict is
 * knowable then, without waiting out the decision window. With a 430 ms
 * vocabulary that is ~650 ms after onset instead of ~900 ms absolute.
 */
static uint8_t local_longest_template;

/* Diagnostics for pendant_local_report(). */
static uint32_t local_feature_cycles;
static uint32_t local_feature_calls;
static uint32_t local_feature_max_cycles;
static uint32_t local_match_cycles;
static int32_t local_best_dist;
static int32_t local_second_dist;
static uint32_t local_last_energy;

volatile uint32_t pendant_local_enroll;
volatile uint32_t pendant_local_forget;
volatile uint32_t pendant_local_accept_dist = LOCAL_ACCEPT_DIST_DEFAULT;
volatile uint32_t pendant_local_min_margin = LOCAL_MIN_MARGIN_DEFAULT;

/* Recompute local_longest_template after any change to the table. */
static void local_refresh_longest(void);
static uint32_t local_cycles_to_us(uint32_t cycles);

/* ---- Fixed-point helpers ---------------------------------------------- */

/*
 * log2(value) in Q8.  Integer part from the position of the top set bit,
 * fractional part from a linear read of the eight bits below it — the
 * classic approximation, worst-case 0.086 bits of error.  That is far finer
 * than the 0.25-bit quantization the feature uses, so it costs nothing real
 * and saves a table.
 */
static uint32_t local_log2_q8(uint64_t value)
{
	uint32_t shift = 0U;
	uint32_t narrow;
	uint32_t msb;
	uint32_t frac;

	if (value == 0U) {
		return 0U;
	}
	while (value > 0xFFFFFFFFULL) {
		value >>= 1;
		++shift;
	}
	narrow = (uint32_t)value;
	msb = 31U - (uint32_t)__builtin_clz(narrow);
	if (msb >= 8U) {
		frac = (narrow >> (msb - 8U)) & 0xFFU;
	} else {
		frac = (narrow << (8U - msb)) & 0xFFU;
	}
	return ((msb + shift) << 8) | frac;
}

/*
 * One analysis frame: run every Goertzel bin over the same 256 samples,
 * fold three bins into each band, take log2, then remove the frame's mean.
 *
 * Mean removal is what makes the match independent of level.  The owner
 * will not hold the pendant at a fixed distance and will not speak at a
 * fixed volume, and without this the DTW distance is dominated by loudness
 * — the one dimension that carries no information about which word it was.
 *
 * Returns the frame's mean absolute amplitude for the endpointer.
 */
static uint32_t local_frame_features(const int16_t *samples, uint8_t *out)
{
	uint32_t abs_sum = 0U;
	uint32_t band_log[PENDANT_LOCAL_BANDS];
	uint32_t mean_log = 0U;

	memset(local_gz_s1, 0, sizeof(local_gz_s1));
	memset(local_gz_s2, 0, sizeof(local_gz_s2));

	for (size_t n = 0U; n < LOCAL_FRAME_SAMPLES; ++n) {
		/*
		 * Scale down by 8 before the recursion.  At resonance the
		 * Goertzel state grows to about N/2 times the input, so a
		 * full-scale int16 would reach 2^22 and the coefficient
		 * product would overflow even 64-bit intermediates less
		 * comfortably than it needs to.  Three bits costs nothing:
		 * the feature is a log, and the endpointer uses the
		 * unscaled sum below.
		 */
		int32_t x = samples[n] >> 3;
		int32_t magnitude = samples[n] < 0 ? -samples[n] : samples[n];

		abs_sum += (uint32_t)magnitude;
		for (size_t bin = 0U; bin < LOCAL_BINS; ++bin) {
			int32_t s1 = local_gz_s1[bin];
			int32_t s = x +
				    (int32_t)(((int64_t)local_goertzel_coeff[bin] *
					       s1) >> 14) -
				    local_gz_s2[bin];

			local_gz_s2[bin] = s1;
			local_gz_s1[bin] = s;
		}
	}

	for (size_t band = 0U; band < PENDANT_LOCAL_BANDS; ++band) {
		uint64_t power = 0U;

		for (size_t offset = 0U; offset < LOCAL_BINS_PER_BAND;
		     ++offset) {
			size_t bin = band * LOCAL_BINS_PER_BAND + offset;
			int64_t s1 = local_gz_s1[bin];
			int64_t s2 = local_gz_s2[bin];
			int64_t term = s1 * s1 + s2 * s2 -
				       (((int64_t)local_goertzel_coeff[bin] *
					 s1 * s2) >>
					14);

			if (term > 0) {
				power += (uint64_t)term;
			}
		}
		/* log2 in Q8, kept as log2 x 4: one unit is 0.25 bits, or
		 * about 1.5 dB of that band. */
		band_log[band] = local_log2_q8(power + 1U) >> 6;
		mean_log += band_log[band];
	}
	mean_log /= PENDANT_LOCAL_BANDS;

	for (size_t band = 0U; band < PENDANT_LOCAL_BANDS; ++band) {
		int32_t centred = (int32_t)band_log[band] - (int32_t)mean_log +
				  128;

		out[band] = (uint8_t)CLAMP(centred, 0, 255);
	}

	return abs_sum / LOCAL_FRAME_SAMPLES;
}

/*
 * Banded DTW between the captured segment and one template.  Two rolling
 * rows, L1 over the 12 bands per cell, Sakoe-Chiba window around the
 * diagonal.  Returns the accumulated distance divided by the path length,
 * so segments of different lengths are comparable, or LOCAL_DTW_INF for an
 * empty template.
 */
static int32_t local_dtw_distance(const struct local_template *tmpl)
{
	const uint32_t rows = local_seg_len;
	const uint32_t cols = tmpl->frames;

	if (cols == 0U || rows == 0U) {
		return LOCAL_DTW_INF;
	}

	for (uint32_t col = 0U; col <= cols; ++col) {
		local_dtw_prev[col] = LOCAL_DTW_INF;
	}
	local_dtw_prev[0] = 0;

	for (uint32_t row = 1U; row <= rows; ++row) {
		/* Window centred on the diagonal of THIS pair of lengths, so
		 * a short template and a long segment still align. */
		int32_t centre = (int32_t)((row * cols) / rows);
		int32_t low = centre - (int32_t)LOCAL_DTW_BAND;
		int32_t high = centre + (int32_t)LOCAL_DTW_BAND;
		uint32_t first = low < 1 ? 1U : (uint32_t)low;
		uint32_t last = high > (int32_t)cols ? cols : (uint32_t)high;

		for (uint32_t col = 0U; col <= cols; ++col) {
			local_dtw_cur[col] = LOCAL_DTW_INF;
		}
		for (uint32_t col = first; col <= last; ++col) {
			const uint8_t *a = local_segment[row - 1U];
			const uint8_t *b = tmpl->feat[col - 1U];
			int32_t cost = 0;
			int32_t best;

			for (size_t band = 0U; band < PENDANT_LOCAL_BANDS;
			     ++band) {
				int32_t diff = (int32_t)a[band] -
					       (int32_t)b[band];

				cost += diff < 0 ? -diff : diff;
			}
			best = MIN(local_dtw_prev[col],
				   MIN(local_dtw_prev[col - 1U],
				       local_dtw_cur[col - 1U]));
			if (best >= LOCAL_DTW_INF) {
				continue;
			}
			local_dtw_cur[col] = best + cost;
		}
		memcpy(local_dtw_prev, local_dtw_cur, sizeof(local_dtw_prev));
	}

	if (local_dtw_prev[cols] >= LOCAL_DTW_INF) {
		return LOCAL_DTW_INF;
	}
	/* Path length is bounded below by max(rows, cols); normalizing by the
	 * sum is the standard symmetric choice and keeps a long segment from
	 * looking good simply by having more cheap frames. */
	return local_dtw_prev[cols] / (int32_t)(rows + cols);
}

/* ---- Persistence ------------------------------------------------------ */

struct local_file_header {
	uint32_t magic;
	uint32_t bands;
	uint32_t max_frames;
	uint32_t slots;
};

static void local_save(void)
{
	struct local_file_header header = {
		.magic = LOCAL_KEYWORD_MAGIC,
		.bands = PENDANT_LOCAL_BANDS,
		.max_frames = PENDANT_LOCAL_MAX_FRAMES,
		.slots = PENDANT_LOCAL_SLOTS,
	};
	struct fs_file_t file;
	int error;

	fs_file_t_init(&file);
	error = fs_open(&file, LOCAL_KEYWORD_PATH,
			FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
	if (error != 0) {
		printk("LOCAL keyword save failed to open: %d\n", error);
		return;
	}
	if (fs_write(&file, &header, sizeof(header)) == (ssize_t)sizeof(header)) {
		(void)fs_write(&file, local_templates, sizeof(local_templates));
	}
	(void)fs_close(&file);
	printk("LOCAL keywords saved to %s\n", LOCAL_KEYWORD_PATH);
}

void pendant_local_init(void)
{
	struct local_file_header header;
	struct fs_file_t file;
	unsigned int enrolled = 0U;
	int error;

	memset(local_templates, 0, sizeof(local_templates));
	local_ready = true;

	fs_file_t_init(&file);
	error = fs_open(&file, LOCAL_KEYWORD_PATH, FS_O_READ);
	if (error != 0) {
		/* No file is the normal first-boot state, not a fault: every
		 * press simply goes to the cloud until a word is enrolled. */
		printk("LOCAL no keyword file (%d) — all presses go to the "
		       "cloud until a slot is enrolled\n",
		       error);
		return;
	}
	if (fs_read(&file, &header, sizeof(header)) != (ssize_t)sizeof(header) ||
	    header.magic != LOCAL_KEYWORD_MAGIC ||
	    header.bands != PENDANT_LOCAL_BANDS ||
	    header.max_frames != PENDANT_LOCAL_MAX_FRAMES ||
	    header.slots != PENDANT_LOCAL_SLOTS) {
		/*
		 * A geometry change invalidates every template: features
		 * recorded against a different filterbank are not comparable
		 * and would match at random.  Refusing to load them is the
		 * only safe reading of a stale file.
		 */
		printk("LOCAL keyword file rejected (magic/geometry mismatch) "
		       "— re-enroll\n");
		(void)fs_close(&file);
		return;
	}
	if (fs_read(&file, local_templates, sizeof(local_templates)) !=
	    (ssize_t)sizeof(local_templates)) {
		memset(local_templates, 0, sizeof(local_templates));
		printk("LOCAL keyword file truncated — re-enroll\n");
	}
	(void)fs_close(&file);

	for (size_t slot = 0U; slot < PENDANT_LOCAL_SLOTS; ++slot) {
		if (local_templates[slot].frames > PENDANT_LOCAL_MAX_FRAMES) {
			local_templates[slot].frames = 0U;
		}
		if (local_templates[slot].frames != 0U) {
			++enrolled;
		}
	}
	local_refresh_longest();
	printk("LOCAL keywords loaded: %u of %u slots enrolled, longest %u "
	       "frames (%u ms)\n",
	       enrolled, PENDANT_LOCAL_SLOTS, local_longest_template,
	       (unsigned int)local_longest_template * 16U);
}

/* ---- Capture-time API ------------------------------------------------- */

void pendant_local_begin(void)
{
	local_seg_state = LOCAL_SEG_IDLE;
	local_seg_len = 0U;
	local_preroll_len = 0U;
	local_preroll_head = 0U;
	local_hangover = 0U;
	local_frame_index = 0U;
	local_floor = UINT32_MAX;
	local_verdict = PENDANT_LOCAL_PENDING;
	local_slot_hit = 0U;
	local_feature_cycles = 0U;
	local_feature_calls = 0U;
	local_feature_max_cycles = 0U;
	local_match_cycles = 0U;
	local_best_dist = LOCAL_DTW_INF;
	local_second_dist = LOCAL_DTW_INF;
	local_last_energy = 0U;

	/* Consume the arm exactly once, at the press that follows it, so a
	 * forgotten SWD write cannot silently overwrite a good template on
	 * some later press. */
	local_enroll_slot = (uint8_t)pendant_local_enroll;
	pendant_local_enroll = 0U;
	if (local_enroll_slot > PENDANT_LOCAL_SLOTS) {
		local_enroll_slot = 0U;
	}
	if (local_enroll_slot != 0U) {
		printk("LOCAL enrolling slot %u on this press — say the word "
		       "once, clearly\n",
		       local_enroll_slot);
		return;
	}

	/*
	 * Nothing is enrolled, so there is nothing this press could match.
	 * Decide immediately: the uplink opens on the very first stage and
	 * this feature costs the owner exactly zero added latency until they
	 * have actually taught the device a word.  Enabling the Kconfig on
	 * its own must not make an ordinary conversation slower, and this
	 * line is what guarantees it.
	 */
	if (local_longest_template == 0U) {
		local_verdict = PENDANT_LOCAL_CLOUD;
	}
}

/* Decide what a finished segment was, and latch the verdict. */
static void local_finalize_segment(void)
{
	uint32_t started;

	/* Trim most of the hangover: those frames are the silence that
	 * PROVED the word ended, not part of the word.  Two are kept so a
	 * final unvoiced release still lands inside the segment. */
	if (local_seg_len > local_hangover && local_hangover > 2U) {
		local_seg_len = (uint8_t)(local_seg_len -
					  (local_hangover - 2U));
	}

	if (local_seg_len < LOCAL_MIN_FRAMES) {
		printk("LOCAL segment too short (%u frames) — cloud\n",
		       local_seg_len);
		local_verdict = PENDANT_LOCAL_CLOUD;
		return;
	}

	if (local_enroll_slot != 0U) {
		struct local_template *tmpl =
			&local_templates[local_enroll_slot - 1U];

		tmpl->frames = local_seg_len;
		memcpy(tmpl->feat, local_segment,
		       (size_t)local_seg_len * PENDANT_LOCAL_BANDS);
		printk("LOCAL enrolled slot %u: %u frames (%u ms)\n",
		       local_enroll_slot, local_seg_len,
		       (unsigned int)local_seg_len * 16U);
		local_refresh_longest();
		local_save();
		/*
		 * An enrollment press is not a command press.  Falling
		 * through to the cloud would ship the enrollment word off to
		 * a model and answer it out loud, which is not what the owner
		 * asked for — but suppressing the uplink is the caller's job,
		 * so say MATCH with slot 0: handled locally, no recipe.
		 */
		local_verdict = PENDANT_LOCAL_MATCH;
		local_slot_hit = 0U;
		return;
	}

	started = k_cycle_get_32();
	local_best_dist = LOCAL_DTW_INF;
	local_second_dist = LOCAL_DTW_INF;
	local_slot_hit = 0U;
	for (size_t slot = 0U; slot < PENDANT_LOCAL_SLOTS; ++slot) {
		int32_t distance = local_dtw_distance(&local_templates[slot]);

		if (distance < local_best_dist) {
			local_second_dist = local_best_dist;
			local_best_dist = distance;
			local_slot_hit = (uint8_t)(slot + 1U);
		} else if (distance < local_second_dist) {
			local_second_dist = distance;
		}
	}
	local_match_cycles = k_cycle_get_32() - started;

	/*
	 * Both tests, or the cloud.  The absolute test says "this really is
	 * that word"; the margin test says "and it is not equally like some
	 * other word".  Dropping either one is how a template matcher starts
	 * firing recipes at sentences.
	 */
	if (local_best_dist <= (int32_t)pendant_local_accept_dist &&
	    (local_second_dist - local_best_dist) >=
		    (int32_t)pendant_local_min_margin) {
		local_verdict = PENDANT_LOCAL_MATCH;
	} else {
		local_verdict = PENDANT_LOCAL_CLOUD;
		local_slot_hit = 0U;
	}
}

/*
 * Longest segment still worth collecting: the longest enrolled template,
 * plus the DTW band (a slow utterance may legitimately run that much past
 * the template it matches) and the pre-roll frames that sit in front of
 * every segment.  Capped by the buffer.  While enrolling, the whole buffer
 * is available — the owner is defining the vocabulary, not matching it.
 */
static uint8_t local_decide_ceiling(void)
{
	uint32_t ceiling;

	/*
	 * Room must be left for a full hangover on top, because the segment
	 * keeps growing through the silence that proves the word ended — and
	 * those frames are trimmed back off at finalize. Measuring the
	 * ceiling against the SPEECH length and reserving the hangover here
	 * is what stops a legitimately slow word from being thrown out as a
	 * sentence while its own trailing silence is still arriving.
	 */
	if (local_enroll_slot != 0U || local_longest_template == 0U) {
		return PENDANT_LOCAL_MAX_FRAMES - LOCAL_HANGOVER_FRAMES;
	}
	ceiling = (uint32_t)local_longest_template + LOCAL_DTW_BAND +
		  LOCAL_PREROLL_FRAMES;
	return (uint8_t)MIN(ceiling, (uint32_t)PENDANT_LOCAL_MAX_FRAMES -
					    LOCAL_HANGOVER_FRAMES);
}

/* Recompute after any change to the template table. */
static void local_refresh_longest(void)
{
	local_longest_template = 0U;
	for (size_t slot = 0U; slot < PENDANT_LOCAL_SLOTS; ++slot) {
		if (local_templates[slot].frames > local_longest_template) {
			local_longest_template = local_templates[slot].frames;
		}
	}
}

/* Fold one analysis frame into the endpointer + segment. */
static void local_push_frame(const uint8_t *feature, uint32_t energy)
{
	uint32_t open_threshold;
	uint32_t close_threshold;

	++local_frame_index;
	local_last_energy = energy;

	/* Floor: the quietest frame seen so far, with a hard minimum so a
	 * dead microphone cannot produce a zero floor that opens on noise. */
	if (local_frame_index <= LOCAL_FLOOR_FRAMES ||
	    local_seg_state == LOCAL_SEG_IDLE) {
		if (energy < local_floor) {
			local_floor = MAX(energy, LOCAL_FLOOR_MIN);
		}
	}
	if (local_floor == UINT32_MAX) {
		local_floor = MAX(energy, LOCAL_FLOOR_MIN);
	}
	/* The first frames are the mic settling, not the room; never let them
	 * open the endpointer. */
	if (local_frame_index <= LOCAL_FLOOR_FRAMES) {
		return;
	}

	open_threshold = local_floor + MAX(local_floor, LOCAL_OPEN_ABS);
	close_threshold = local_floor + MAX(local_floor / 4U, LOCAL_CLOSE_ABS);

	switch (local_seg_state) {
	case LOCAL_SEG_IDLE:
		if (energy > open_threshold) {
			/* Replay the pre-roll so the word's onset is in the
			 * segment even though it was below threshold. */
			uint8_t count = local_preroll_len;

			local_seg_len = 0U;
			for (uint8_t index = 0U; index < count; ++index) {
				uint8_t slot =
					(uint8_t)((local_preroll_head +
						   LOCAL_PREROLL_FRAMES -
						   count + index) %
						  LOCAL_PREROLL_FRAMES);

				memcpy(local_segment[local_seg_len++],
				       local_preroll[slot],
				       PENDANT_LOCAL_BANDS);
			}
			memcpy(local_segment[local_seg_len++], feature,
			       PENDANT_LOCAL_BANDS);
			local_seg_state = LOCAL_SEG_SPEECH;
			local_hangover = 0U;
		} else {
			memcpy(local_preroll[local_preroll_head], feature,
			       PENDANT_LOCAL_BANDS);
			local_preroll_head = (uint8_t)((local_preroll_head +
							1U) %
						       LOCAL_PREROLL_FRAMES);
			if (local_preroll_len < LOCAL_PREROLL_FRAMES) {
				++local_preroll_len;
			}
		}
		break;

	case LOCAL_SEG_SPEECH:
	case LOCAL_SEG_HANGOVER:
		/*
		 * Judge the SPEECH so far, not the buffer: the hangover
		 * frames appended while the word is ending are not part of
		 * the word and get trimmed at finalize. The second clause is
		 * the buffer's own hard edge.
		 */
		if (local_seg_len >= PENDANT_LOCAL_MAX_FRAMES ||
		    (uint8_t)(local_seg_len - local_hangover) >=
			    local_decide_ceiling()) {
			/*
			 * Still going after the longest word this device
			 * knows.  It is a sentence, not one of four enrolled
			 * commands — decide for the cloud NOW rather than at
			 * the window edge, because this is the COMMON case
			 * and every millisecond here is latency added to an
			 * ordinary conversation.
			 */
			printk("LOCAL utterance (%u frames) outran the "
			       "vocabulary — cloud\n",
			       local_seg_len);
			local_verdict = PENDANT_LOCAL_CLOUD;
			return;
		}
		memcpy(local_segment[local_seg_len++], feature,
		       PENDANT_LOCAL_BANDS);
		if (energy < close_threshold) {
			++local_hangover;
			local_seg_state = LOCAL_SEG_HANGOVER;
			if (local_hangover >= LOCAL_HANGOVER_FRAMES) {
				local_finalize_segment();
			}
		} else {
			local_hangover = 0U;
			local_seg_state = LOCAL_SEG_SPEECH;
		}
		break;

	default:
		break;
	}
}

enum pendant_local_verdict pendant_local_offer_stage(const int16_t *samples,
						     size_t frame_count)
{
	uint32_t started;
	uint32_t elapsed;

	if (!local_ready || local_verdict != PENDANT_LOCAL_PENDING) {
		return (enum pendant_local_verdict)local_verdict;
	}

	started = k_cycle_get_32();
	for (size_t offset = 0U; offset + LOCAL_FRAME_SAMPLES <= frame_count;
	     offset += LOCAL_FRAME_SAMPLES) {
		uint8_t feature[PENDANT_LOCAL_BANDS];
		uint32_t energy;

		energy = local_frame_features(&samples[offset], feature);
		local_push_frame(feature, energy);
		if (local_verdict != PENDANT_LOCAL_PENDING) {
			break;
		}
	}
	elapsed = k_cycle_get_32() - started;
	local_feature_cycles += elapsed;
	++local_feature_calls;
	if (elapsed > local_feature_max_cycles) {
		local_feature_max_cycles = elapsed;
	}

	/*
	 * The filterbank has to be affordable on a loop that is also running
	 * the Opus encoder. If a stage ever costs more than its budget, this
	 * press stops trying to be clever and becomes an ordinary
	 * conversation. Losing a keyword is free; stalling the conversation
	 * loop is not.
	 */
	if (local_verdict == PENDANT_LOCAL_PENDING &&
	    local_cycles_to_us(elapsed) > LOCAL_STAGE_BUDGET_US) {
		printk("LOCAL feature cost %u us over budget %u us — cloud\n",
		       local_cycles_to_us(elapsed), LOCAL_STAGE_BUDGET_US);
		local_verdict = PENDANT_LOCAL_CLOUD;
		return PENDANT_LOCAL_CLOUD;
	}

	/*
	 * Hard stop.  Whatever is being said has outlasted the window this
	 * design is allowed to spend; hand it to the cloud.  Checked after
	 * the frames so a word that finished inside the window still wins.
	 */
	if (local_verdict == PENDANT_LOCAL_PENDING &&
	    local_frame_index >= LOCAL_DECIDE_FRAMES) {
		local_verdict = PENDANT_LOCAL_CLOUD;
	}
	return (enum pendant_local_verdict)local_verdict;
}

uint8_t pendant_local_matched_slot(void)
{
	return local_verdict == PENDANT_LOCAL_MATCH ? local_slot_hit : 0U;
}

bool pendant_local_enroll_pending(void)
{
	return pendant_local_enroll != 0U || local_enroll_slot != 0U;
}

void pendant_local_tick(void)
{
	uint32_t forget = pendant_local_forget;

	if (forget == 0U) {
		return;
	}
	pendant_local_forget = 0U;
	if (forget > PENDANT_LOCAL_SLOTS && forget != UINT32_MAX) {
		printk("LOCAL forget: slot %u out of range\n", forget);
		return;
	}
	if (forget == UINT32_MAX) {
		memset(local_templates, 0, sizeof(local_templates));
		printk("LOCAL forget: all slots cleared\n");
	} else {
		memset(&local_templates[forget - 1U], 0,
		       sizeof(local_templates[0]));
		printk("LOCAL forget: slot %u cleared\n", forget);
	}
	local_refresh_longest();
	local_save();
}

static uint32_t local_cycles_to_us(uint32_t cycles)
{
	return (uint32_t)(((uint64_t)cycles * 1000000U) /
			  sys_clock_hw_cycles_per_sec());
}

void pendant_local_report(void)
{
	printk("LOCAL verdict=%s slot=%u frames=%u seg=%u floor=%u "
	       "last_energy=%u best=%d second=%d accept=%u margin=%u\n",
	       local_verdict == PENDANT_LOCAL_MATCH	? "match"
	       : local_verdict == PENDANT_LOCAL_CLOUD	? "cloud"
							: "pending",
	       local_slot_hit, local_frame_index, local_seg_len, local_floor,
	       local_last_energy,
	       local_best_dist >= LOCAL_DTW_INF ? -1 : local_best_dist,
	       local_second_dist >= LOCAL_DTW_INF ? -1 : local_second_dist,
	       (unsigned int)pendant_local_accept_dist,
	       (unsigned int)pendant_local_min_margin);
	printk("LOCAL cost: features avg=%u us max=%u us n=%u | dtw=%u us | "
	       "static_ram=%u B\n",
	       local_feature_calls
		       ? local_cycles_to_us(local_feature_cycles /
					    local_feature_calls)
		       : 0U,
	       local_cycles_to_us(local_feature_max_cycles), local_feature_calls,
	       local_cycles_to_us(local_match_cycles),
	       (unsigned int)(sizeof(local_templates) + sizeof(local_segment) +
			      sizeof(local_preroll) + sizeof(local_dtw_prev) +
			      sizeof(local_dtw_cur) + sizeof(local_gz_s1) +
			      sizeof(local_gz_s2)));
}

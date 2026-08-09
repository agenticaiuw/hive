/*
 * Host test for the on-device command matcher.
 *
 * This compiles the REAL pendant_local.c — filterbank, endpointer and DTW
 * exactly as they ship — against a handful of Zephyr shims, and drives it
 * with synthetic utterances whose spectra are known by construction.  The
 * point is not to prove the matcher works on human speech (only the
 * hardware and the owner's voice can say that); it is to prove that the
 * three claims the design rests on actually hold:
 *
 *   1. a word matches its own template and not a different one,
 *   2. the level- and rate-invariances the features were built for are
 *      really there (half amplitude, 20% faster still match),
 *   3. everything that is NOT a command word — a click, a sentence,
 *      silence, an ambiguous pair — comes back CLOUD.
 *
 * (3) is the one that matters most: every one of those cases is a chance
 * for the device to fire the wrong recipe silently, and a test that only
 * checked (1) would pass on a matcher that accepts everything.
 */

#include <assert.h>
#include <math.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include "pendant_local.h"

/* The module under test, compiled verbatim. */
#include "pendant_local.c"

#define SAMPLE_RATE 15625
#define STAGE 512
#define MAX_PCM (SAMPLE_RATE * 4)

static int16_t pcm[MAX_PCM];
static size_t pcm_len;

/* ---- Synthetic speech ------------------------------------------------- */

struct phone {
	double ms;
	double f1;
	double f2;
	double f3;
	double amp;   /* 0 = silence, 1 = full */
	int fricative; /* 1 = shaped noise instead of formants */
};

static double frand(void)
{
	return (double)rand() / (double)RAND_MAX * 2.0 - 1.0;
}

static void pcm_reset(void)
{
	pcm_len = 0U;
	srand(1234); /* deterministic: a flaky acoustic test is worthless */
}

/* Room tone.  The endpointer measures its floor from this, so every
 * utterance must be surrounded by some. */
static void add_silence(double ms, double level)
{
	size_t count = (size_t)(ms * SAMPLE_RATE / 1000.0);

	for (size_t i = 0U; i < count && pcm_len < MAX_PCM; ++i) {
		pcm[pcm_len++] = (int16_t)(frand() * level);
	}
}

/*
 * One phone: formants over a glottal pulse train, or shaped noise for a
 * fricative.  Cosine fades at both ends so a phone boundary is not an
 * impulse (which would look to the endpointer like the door slam it is
 * supposed to reject).
 */
static void add_phone(const struct phone *p, double rate, double gain,
		      double noise)
{
	size_t count = (size_t)(p->ms / rate * SAMPLE_RATE / 1000.0);
	double f0 = 118.0;

	for (size_t i = 0U; i < count && pcm_len < MAX_PCM; ++i) {
		double t = (double)i / SAMPLE_RATE;
		double phase = (double)i / (double)count;
		double env = 0.5 - 0.5 * cos(2.0 * M_PI *
					     (phase < 0.5 ? phase : 1.0 - phase) *
					     2.0);
		double v;

		if (p->fricative) {
			/* Band-limited hiss: a one-pole highpass on noise
			 * puts the energy where /s/ and /f/ live. */
			static double previous;
			double n = frand();

			v = n - previous * 0.85;
			previous = n;
		} else {
			double glottal = 1.0 + 0.6 * sin(2.0 * M_PI * f0 * t);

			v = glottal * (1.00 * sin(2.0 * M_PI * p->f1 * t) +
				       0.65 * sin(2.0 * M_PI * p->f2 * t) +
				       0.35 * sin(2.0 * M_PI * p->f3 * t));
			v /= 2.0;
		}
		v = v * env * p->amp * gain * 7000.0 + frand() * noise;
		if (v > 32000.0) {
			v = 32000.0;
		}
		if (v < -32000.0) {
			v = -32000.0;
		}
		pcm[pcm_len++] = (int16_t)v;
	}
}

static void add_word(const struct phone *phones, size_t count, double rate,
		     double gain, double noise)
{
	for (size_t i = 0U; i < count; ++i) {
		add_phone(&phones[i], rate, gain, noise);
	}
}

/* Three deliberately distinct "words".  A and B differ in both formant
 * track and length; C is a third shape used to test false accepts. */
static const struct phone word_a[] = {      /* "timer" */
	{ 90.0, 380.0, 2100.0, 2900.0, 0.85, 0 },
	{ 150.0, 700.0, 1250.0, 2500.0, 1.00, 0 },
	{ 120.0, 430.0, 900.0, 2400.0, 0.75, 0 },
};
static const struct phone word_b[] = {      /* "stop" */
	{ 90.0, 0.0, 0.0, 0.0, 0.60, 1 },
	{ 130.0, 600.0, 1000.0, 2600.0, 1.00, 0 },
	{ 70.0, 500.0, 800.0, 2300.0, 0.55, 0 },
};
static const struct phone word_c[] = {      /* an unenrolled third word */
	{ 120.0, 300.0, 800.0, 2200.0, 0.90, 0 },
	{ 100.0, 320.0, 780.0, 2100.0, 0.95, 0 },
	{ 140.0, 290.0, 820.0, 2150.0, 0.85, 0 },
};

/* ---- Driving the module ----------------------------------------------- */

static enum pendant_local_verdict run_capture(void)
{
	enum pendant_local_verdict verdict = PENDANT_LOCAL_PENDING;

	pendant_local_begin();
	for (size_t offset = 0U; offset + STAGE <= pcm_len; offset += STAGE) {
		verdict = pendant_local_offer_stage(&pcm[offset], STAGE);
		if (verdict != PENDANT_LOCAL_PENDING) {
			break;
		}
	}
	return verdict;
}

static void build(const struct phone *word, size_t count, double rate,
		  double gain, double noise, double lead_ms, double tail_ms)
{
	pcm_reset();
	add_silence(lead_ms, 90.0);
	add_word(word, count, rate, gain, noise);
	add_silence(tail_ms, 90.0);
}

static void enroll(uint8_t slot, const struct phone *word, size_t count)
{
	enum pendant_local_verdict verdict;

	build(word, count, 1.0, 1.0, 60.0, 200.0, 400.0);
	pendant_local_enroll = slot;
	verdict = run_capture();
	printf("  enroll slot %u -> verdict=%d frames=%u\n", slot, verdict,
	       local_templates[slot - 1U].frames);
	assert(verdict == PENDANT_LOCAL_MATCH);
	assert(pendant_local_matched_slot() == 0U); /* enrollment, no recipe */
	assert(local_templates[slot - 1U].frames >= LOCAL_MIN_FRAMES);
}

static enum pendant_local_verdict recognize(const char *label,
					    const struct phone *word,
					    size_t count, double rate,
					    double gain)
{
	enum pendant_local_verdict verdict;

	build(word, count, rate, gain, 60.0, 200.0, 400.0);
	verdict = run_capture();
	printf("  %-28s verdict=%-1d slot=%u seg=%2u best=%4d second=%4d "
	       "margin=%4d\n",
	       label, verdict, pendant_local_matched_slot(), local_seg_len,
	       local_best_dist >= LOCAL_DTW_INF ? -1 : local_best_dist,
	       local_second_dist >= LOCAL_DTW_INF ? -1 : local_second_dist,
	       (local_best_dist >= LOCAL_DTW_INF ||
		local_second_dist >= LOCAL_DTW_INF)
		       ? -1
		       : local_second_dist - local_best_dist);
	return verdict;
}

int main(void)
{
	printf("pendant_local: static RAM = %u B\n",
	       (unsigned int)(sizeof(local_templates) + sizeof(local_segment) +
			      sizeof(local_preroll) + sizeof(local_dtw_prev) +
			      sizeof(local_dtw_cur) + sizeof(local_gz_s1) +
			      sizeof(local_gz_s2)));
	local_ready = true;

	/*
	 * An empty vocabulary must cost NOTHING. Enabling the Kconfig without
	 * enrolling a word is the state every build ships in, and if that
	 * state delayed the uplink even a little it would be a latency
	 * regression on every conversation for a feature nobody is using.
	 */
	printf("\n[empty vocabulary costs no latency]\n");
	{
		enum pendant_local_verdict verdict;

		build(word_a, 3U, 1.0, 1.0, 60.0, 200.0, 400.0);
		pendant_local_begin();
		verdict = pendant_local_offer_stage(pcm, STAGE);
		printf("  nothing enrolled            verdict=%d after %u "
		       "stage(s)\n",
		       verdict, 1U);
		assert(verdict == PENDANT_LOCAL_CLOUD);
	}

	printf("\n[enrollment]\n");
	enroll(1U, word_a, 3U);
	enroll(2U, word_b, 3U);

	/*
	 * Survey first, with acceptance disabled, so the thresholds below are
	 * chosen from measured separation rather than from arithmetic about
	 * what the feature space "should" look like.  The numbers this prints
	 * are the evidence for the constants in pendant_local.c.
	 */
	printf("\n[distance survey — acceptance disabled]\n");
	pendant_local_accept_dist = 100000U;
	pendant_local_min_margin = 0U;
	(void)recognize("A, as enrolled", word_a, 3U, 1.0, 1.0);
	(void)recognize("A at half level", word_a, 3U, 1.0, 0.5);
	(void)recognize("A at quarter level", word_a, 3U, 1.0, 0.25);
	(void)recognize("A 20% faster", word_a, 3U, 1.2, 1.0);
	(void)recognize("A 20% slower", word_a, 3U, 0.83, 1.0);
	(void)recognize("A 35% faster", word_a, 3U, 1.35, 1.0);
	(void)recognize("B, as enrolled", word_b, 3U, 1.0, 1.0);
	(void)recognize("B 20% faster", word_b, 3U, 1.2, 1.0);
	(void)recognize("C (never enrolled)", word_c, 3U, 1.0, 1.0);
	pendant_local_accept_dist = LOCAL_ACCEPT_DIST_DEFAULT;
	pendant_local_min_margin = LOCAL_MIN_MARGIN_DEFAULT;

	printf("\n[the words it was taught]\n");
	assert(recognize("word A, as enrolled", word_a, 3U, 1.0, 1.0) ==
	       PENDANT_LOCAL_MATCH);
	assert(pendant_local_matched_slot() == 1U);
	assert(recognize("word B, as enrolled", word_b, 3U, 1.0, 1.0) ==
	       PENDANT_LOCAL_MATCH);
	assert(pendant_local_matched_slot() == 2U);

	printf("\n[invariances the features were built for]\n");
	/* Half amplitude: mean removal must make this a no-op. */
	assert(recognize("word A at half level", word_a, 3U, 1.0, 0.5) ==
	       PENDANT_LOCAL_MATCH);
	assert(pendant_local_matched_slot() == 1U);
	/* 20% faster and 20% slower: this is what the DTW band is for. */
	assert(recognize("word A spoken 20% faster", word_a, 3U, 1.2, 1.0) ==
	       PENDANT_LOCAL_MATCH);
	assert(pendant_local_matched_slot() == 1U);
	assert(recognize("word A spoken 20% slower", word_a, 3U, 0.83, 1.0) ==
	       PENDANT_LOCAL_MATCH);
	assert(pendant_local_matched_slot() == 1U);

	printf("\n[everything that must NOT fire a recipe]\n");
	/* A word that was never enrolled. The whole safety argument. */
	assert(recognize("unenrolled word C", word_c, 3U, 1.0, 1.0) ==
	       PENDANT_LOCAL_CLOUD);

	/* A click: loud, broadband, over in 30 ms. The door slam. */
	{
		enum pendant_local_verdict verdict;

		pcm_reset();
		add_silence(200.0, 90.0);
		for (size_t i = 0U; i < 470U; ++i) {
			double decay = exp(-(double)i / 60.0);

			pcm[pcm_len++] = (int16_t)(frand() * 26000.0 * decay);
		}
		add_silence(500.0, 90.0);
		verdict = run_capture();
		printf("  %-28s verdict=%d seg=%u\n", "30 ms click", verdict,
		       local_seg_len);
		assert(verdict == PENDANT_LOCAL_CLOUD);
	}

	/* A sentence: this is the ordinary conversation case, and it must be
	 * ruled out fast, not at the end of the window. */
	{
		enum pendant_local_verdict verdict;
		struct phone sentence[10];

		pcm_reset();
		add_silence(200.0, 90.0);
		for (size_t i = 0U; i < 10U; ++i) {
			sentence[i].ms = 150.0;
			sentence[i].f1 = 300.0 + 60.0 * (double)i;
			sentence[i].f2 = 900.0 + 130.0 * (double)i;
			sentence[i].f3 = 2200.0;
			sentence[i].amp = 0.9;
			sentence[i].fricative = 0;
		}
		add_word(sentence, 10U, 1.0, 1.0, 60.0);
		add_silence(300.0, 90.0);
		verdict = run_capture();
		printf("  %-28s verdict=%d frames_seen=%u (%u ms) ceiling=%u\n",
		       "1.5 s sentence", verdict, local_frame_index,
		       (unsigned int)local_frame_index * 16U,
		       local_decide_ceiling());
		assert(verdict == PENDANT_LOCAL_CLOUD);
		/*
		 * Ruled out by outrunning the vocabulary, strictly before the
		 * decision window would have expired. This is the number that
		 * lands in the critical path of every ordinary conversation,
		 * so the test pins it rather than trusting the comment.
		 */
		assert(local_frame_index < LOCAL_DECIDE_FRAMES);
	}

	/* Nothing said at all: the press that opens a conversation. */
	{
		enum pendant_local_verdict verdict;

		pcm_reset();
		add_silence(1200.0, 90.0);
		verdict = run_capture();
		printf("  %-28s verdict=%d seg=%u\n", "silence only", verdict,
		       local_seg_len);
		assert(verdict == PENDANT_LOCAL_CLOUD);
	}

	printf("\n[the margin rule]\n");
	/*
	 * Teach slot 3 the SAME word as slot 1.  Both templates now fit word
	 * A equally well, the margin is zero by construction, and the matcher
	 * must refuse rather than pick one.  This is the failure mode that
	 * runs the wrong recipe silently, and the margin test is the only
	 * thing standing in front of it — so it is worth an unambiguous test
	 * rather than a nearly-ambiguous one.
	 */
	{
		enroll(3U, word_a, 3U);
		assert(recognize("word A taught to two slots", word_a, 3U,
				 1.0, 1.0) == PENDANT_LOCAL_CLOUD);
		printf("  (ambiguity refused: no recipe fired)\n");
	}

	printf("\nAll pendant_local host assertions passed.\n");
	return 0;
}

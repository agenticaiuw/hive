#ifndef AUDIO_OPUS_MATH_H_
#define AUDIO_OPUS_MATH_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PENDANT_OPUS_MATH_SAMPLE_RATE 16000U

static inline uint32_t pendant_opus_resampled_count(uint32_t source_samples,
						    uint32_t source_rate)
{
	return source_rate == 0U
		? 0U
		: (uint32_t)(((uint64_t)source_samples *
				    PENDANT_OPUS_MATH_SAMPLE_RATE +
				    source_rate - 1U) /
				   source_rate);
}

/*
 * The live phase accumulator has already subtracted source_rate before this
 * helper is called.  phase is therefore the distance remaining to the next
 * 16 kHz output instant: phase=0 selects current, while a larger value moves
 * the interpolation back toward previous.
 */
static inline int16_t pendant_opus_live_interpolate(int16_t previous,
						     int16_t current,
						     uint32_t phase)
{
	int64_t blended =
		(int64_t)previous * phase +
		(int64_t)current * (PENDANT_OPUS_MATH_SAMPLE_RATE - phase);

	return (int16_t)(blended / PENDANT_OPUS_MATH_SAMPLE_RATE);
}

/* An exact frame/page boundary needs an EOS page, not a silent packet. */
static inline bool pendant_opus_final_needs_packet(size_t frame_fill)
{
	return frame_fill > 0U;
}

#endif /* AUDIO_OPUS_MATH_H_ */

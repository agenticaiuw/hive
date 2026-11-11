#include <assert.h>
#include <stdint.h>

#include "audio_opus_math.h"

int main(void)
{
	assert(pendant_opus_resampled_count(15625U, 15625U) == 16000U);
	assert(pendant_opus_resampled_count(468750U, 15625U) == 480000U);
	assert(pendant_opus_resampled_count(320U, 15625U) == 328U);
	assert(pendant_opus_resampled_count(0U, 15625U) == 0U);
	assert(pendant_opus_resampled_count(100U, 0U) == 0U);

	/* First output between a 0 -> 1000 ramp is 97.6% toward current. */
	assert(pendant_opus_live_interpolate(0, 1000, 375U) == 976);
	assert(pendant_opus_live_interpolate(-1000, 1000, 0U) == 1000);
	assert(pendant_opus_live_interpolate(-1000, 1000, 8000U) == 0);

	assert(!pendant_opus_final_needs_packet(0U));
	assert(pendant_opus_final_needs_packet(1U));
	assert(pendant_opus_final_needs_packet(319U));
	return 0;
}

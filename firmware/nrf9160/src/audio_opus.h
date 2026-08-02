#ifndef AUDIO_OPUS_H_
#define AUDIO_OPUS_H_

#include <stddef.h>
#include <stdint.h>

/*
 * The codec arena is overlaid with the microphone RX slab in main.c. Capture,
 * encode, and reply decode never overlap, so Opus adds no permanent 40 KiB
 * audio buffer to the nRF9160's RAM budget.
 */
#define PENDANT_OPUS_WORKSPACE_BYTES (40U * 1024U)
#define PENDANT_OPUS_SAMPLE_RATE 16000U
#define PENDANT_OPUS_REPLY_SAMPLE_RATE 24000U
#define PENDANT_OPUS_BITRATE 16000U

struct pendant_opus_stats {
	uint32_t input_bytes;
	uint32_t output_bytes;
	uint32_t samples;
	uint32_t packets;
};

int pendant_opus_encode_file(const char *pcm_path, const char *opus_path,
			     uint32_t source_sample_rate, void *workspace,
			     size_t workspace_bytes,
			     struct pendant_opus_stats *stats);

int pendant_opus_decode_file(const char *opus_path, const char *pcm_path,
			     void *workspace, size_t workspace_bytes,
			     struct pendant_opus_stats *stats);

#endif /* AUDIO_OPUS_H_ */

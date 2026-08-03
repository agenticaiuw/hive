#ifndef AUDIO_OPUS_H_
#define AUDIO_OPUS_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Codec arena: OpusEncoder state + Ogg page payload only.
 * SILK scratch lives in a separate NONTHREADSAFE_PSEUDOSTACK buffer so live
 * encode-during-record does not blow the main thread stack.
 *
 * Encoder mono fixed-point is ~22–25 KiB; page payload is ~2 KiB with 5
 * packets/page. 30 KiB workspace leaves margin.
 */
#define PENDANT_OPUS_WORKSPACE_BYTES (30U * 1024U)
/* Must match GLOBAL_STACK_SIZE in CMakeLists.txt (≥ measured ~25.4 KiB peak). */
#define PENDANT_OPUS_SCRATCH_BYTES (28U * 1024U)
#define PENDANT_OPUS_SAMPLE_RATE 16000U
#define PENDANT_OPUS_REPLY_SAMPLE_RATE 24000U
#define PENDANT_OPUS_BITRATE 16000U

struct pendant_opus_stats {
	uint32_t input_bytes;
	uint32_t output_bytes;
	uint32_t samples;
	uint32_t packets;
};

/*
 * Offline path: encode a finished PCM file (boot diagnostic / fallback when
 * the live stream path fails).
 */
int pendant_opus_encode_file(const char *pcm_path, const char *opus_path,
			     uint32_t source_sample_rate, void *workspace,
			     size_t workspace_bytes,
			     struct pendant_opus_stats *stats);

/*
 * Live path: open Ogg, feed PCM samples at the mic rate while recording,
 * finalize on button release. After a successful end(), latest.opus is ready
 * to upload with no further encode work.
 */
int pendant_opus_stream_begin(const char *opus_path,
			      uint32_t source_sample_rate, void *workspace,
			      size_t workspace_bytes);
int pendant_opus_stream_feed(const int16_t *samples, size_t sample_count);
int pendant_opus_stream_end(struct pendant_opus_stats *stats);
void pendant_opus_stream_abort(void);
bool pendant_opus_stream_active(void);

int pendant_opus_decode_file(const char *opus_path, const char *pcm_path,
			     void *workspace, size_t workspace_bytes,
			     struct pendant_opus_stats *stats);

#endif /* AUDIO_OPUS_H_ */

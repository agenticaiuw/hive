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
/* Shared audio RAM, time-multiplexed: capture TX ring while recording,
 * reply jitter buffer while playing, Opus scratch only in the SD-fallback
 * encode. One 24 KiB block, never concurrently: 17 KiB encoder arena plus
 * a 7 KiB uplink FIFO (~3.5 s of Opus, ample now that the WS thread drains
 * it continuously). Trimmed from 28 to fund the 24 kHz downlink ring. */
#define PENDANT_AUDIO_WORKSPACE_BYTES (24U * 1024U)
/* Back-compat alias for the opus encoder's own references. */
#define PENDANT_OPUS_WORKSPACE_BYTES PENDANT_AUDIO_WORKSPACE_BYTES
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

/*
 * Live LTE paths. Uplink: stream_begin_packets + stream_feed deliver raw
 * Opus packets to `sink` mid-recording (no file, no Ogg). Downlink: the
 * reply decoder turns wire packets into 24 kHz mono PCM (Opus resamples
 * internally). Both share the NONTHREADSAFE_PSEUDOSTACK scratch, so never
 * run one while the other is active.
 */
int pendant_opus_stream_begin_packets(uint32_t source_sample_rate,
				      void *workspace, size_t workspace_bytes,
				      int (*sink)(const uint8_t *packet,
						  size_t packet_bytes));
int pendant_opus_reply_decoder_begin(void *workspace, size_t workspace_bytes);
/* Conversation path: decode at the 16 kHz wire rate (fewer samples, and the
 * TX fill owns the exact-ratio resample to the I2S frame rate). */
int pendant_opus_reply_decoder_begin_rate(void *workspace,
					  size_t workspace_bytes,
					  uint32_t sample_rate);
int pendant_opus_reply_decode_packet(const uint8_t *packet,
				     size_t packet_bytes, int16_t *pcm_out,
				     size_t max_samples);
void pendant_opus_reply_decoder_end(void);
/* 60 ms wire packets: 960 samples at 16 kHz in, 1440 samples at 24 kHz out. */
#define PENDANT_OPUS_REPLY_FRAME_SAMPLES 1440U

#endif /* AUDIO_OPUS_H_ */

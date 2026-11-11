/*
 * Zero-malloc libopus wrapper for the Cloudflare Worker.
 *
 * Fixed-arg entry points (varargs don't cross the wasm boundary) and static
 * arenas (no allocator in the module at all). One encoder + one decoder per
 * WebAssembly.Instance; the JS glue instantiates per session.
 */
#include <opus.h>
#include <stdint.h>

/* opus_encoder_get_size(1) measures ~15.3 KB; decoder ~18.5 KB. Padded. */
static unsigned char encoder_arena[24 * 1024] __attribute__((aligned(8)));
static unsigned char decoder_arena[28 * 1024] __attribute__((aligned(8)));
static int16_t pcm_buffer[1920];
static unsigned char packet_buffer[1400];

__attribute__((export_name("ow_pcm_buf"))) int16_t *ow_pcm_buf(void)
{
	return pcm_buffer;
}

__attribute__((export_name("ow_pkt_buf"))) unsigned char *ow_pkt_buf(void)
{
	return packet_buffer;
}

__attribute__((export_name("ow_enc_init"))) int
ow_enc_init(int sample_rate, int bitrate, int complexity)
{
	OpusEncoder *enc = (OpusEncoder *)encoder_arena;
	int err;

	if (opus_encoder_get_size(1) > (int)sizeof(encoder_arena)) {
		return -99;
	}
	err = opus_encoder_init(enc, sample_rate, 1, OPUS_APPLICATION_VOIP);
	if (err != OPUS_OK) {
		return err;
	}
	opus_encoder_ctl(enc, OPUS_SET_BITRATE(bitrate));
	opus_encoder_ctl(enc, OPUS_SET_COMPLEXITY(complexity));
	opus_encoder_ctl(enc, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE));
	opus_encoder_ctl(enc, OPUS_SET_VBR(1));
	opus_encoder_ctl(enc, OPUS_SET_DTX(1));
	return 0;
}

__attribute__((export_name("ow_encode"))) int ow_encode(int frame_samples)
{
	return opus_encode((OpusEncoder *)encoder_arena, pcm_buffer,
			   frame_samples, packet_buffer,
			   (opus_int32)sizeof(packet_buffer));
}

__attribute__((export_name("ow_dec_init"))) int ow_dec_init(int sample_rate)
{
	if (opus_decoder_get_size(1) > (int)sizeof(decoder_arena)) {
		return -99;
	}
	return opus_decoder_init((OpusDecoder *)decoder_arena, sample_rate, 1);
}

__attribute__((export_name("ow_decode"))) int ow_decode(int packet_bytes)
{
	return opus_decode((OpusDecoder *)decoder_arena, packet_buffer,
			   packet_bytes, pcm_buffer,
			   (int)(sizeof(pcm_buffer) / sizeof(pcm_buffer[0])),
			   0);
}

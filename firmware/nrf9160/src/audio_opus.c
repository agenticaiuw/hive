/*
 * Fixed-point Opus/Ogg support for the pendant. The microphone's native
 * 15,625 Hz stream is resampled to the Opus-supported 16 kHz rate and encoded
 * in restricted-SILK voice mode. Replies are decoded at the I2S playback
 * rate of 24 kHz.
 */

#include "audio_opus.h"

#include <errno.h>
#include <stdbool.h>
#include <stdint.h>
#include <string.h>

#include <opus.h>
#include <zephyr/fs/fs.h>
#include <zephyr/sys/byteorder.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

#define OPUS_FRAME_MS 20U
#define OPUS_ENCODE_FRAME_SAMPLES \
	(PENDANT_OPUS_SAMPLE_RATE * OPUS_FRAME_MS / 1000U)
#define OPUS_DECODE_MAX_FRAME_SAMPLES \
	(PENDANT_OPUS_REPLY_SAMPLE_RATE * 120U / 1000U)
#define OPUS_MAX_PACKET_BYTES 1275U
#define OPUS_ENCODE_PACKET_BYTES 400U
#define OGG_PACKETS_PER_PAGE 10U
#define OGG_MAX_PAGE_PAYLOAD \
	(OGG_PACKETS_PER_PAGE * OPUS_ENCODE_PACKET_BYTES)
#define OGG_HEADER_BYTES 27U
#define OGG_MAX_LACING_BYTES (OGG_PACKETS_PER_PAGE * 2U)
#define OGG_CAPTURE_PATTERN "OggS"
#define OGG_FLAG_CONTINUED 0x01U
#define OGG_FLAG_BOS 0x02U
#define OGG_FLAG_EOS 0x04U
#define OGG_GRANULE_RATE 48000U
#define OPUS_SERIAL_NUMBER 0x50444e54U

struct ogg_writer {
	struct fs_file_t *file;
	uint32_t sequence;
	uint32_t bytes;
};

static uint32_t ogg_crc_update(uint32_t crc, const uint8_t *data, size_t length)
{
	for (size_t index = 0U; index < length; ++index) {
		crc ^= (uint32_t)data[index] << 24;
		for (unsigned int bit = 0U; bit < 8U; ++bit) {
			crc = (crc & 0x80000000U) != 0U
				      ? (crc << 1) ^ 0x04c11db7U
				      : crc << 1;
		}
	}
	return crc;
}

static int write_all(struct fs_file_t *file, const void *data, size_t length)
{
	const uint8_t *bytes = data;
	size_t written_total = 0U;

	while (written_total < length) {
		ssize_t written = fs_write(file, bytes + written_total,
					   length - written_total);

		if (written < 0) {
			return (int)written;
		}
		if (written == 0) {
			return -EIO;
		}
		written_total += (size_t)written;
	}
	return 0;
}

static int ogg_write_page(struct ogg_writer *writer, uint8_t flags,
			  uint64_t granule, const uint8_t *payload,
			  const uint16_t *packet_lengths,
			  size_t packet_count)
{
	uint8_t header[OGG_HEADER_BYTES + OGG_MAX_LACING_BYTES] = { 0 };
	size_t segment_count = 0U;
	size_t payload_bytes = 0U;

	if (packet_count == 0U || packet_count > OGG_PACKETS_PER_PAGE) {
		return -EINVAL;
	}
	for (size_t packet = 0U; packet < packet_count; ++packet) {
		size_t remaining = packet_lengths[packet];

		payload_bytes += remaining;
		while (remaining > 0U) {
			if (segment_count >= OGG_MAX_LACING_BYTES) {
				return -EOVERFLOW;
			}
			uint8_t lace = (uint8_t)MIN(remaining, 255U);

			header[OGG_HEADER_BYTES + segment_count++] = lace;
			remaining -= lace;
		}
		if ((packet_lengths[packet] % 255U) == 0U) {
			if (segment_count >= OGG_MAX_LACING_BYTES) {
				return -EOVERFLOW;
			}
			header[OGG_HEADER_BYTES + segment_count++] = 0U;
		}
	}
	if (payload_bytes > OGG_MAX_PAGE_PAYLOAD) {
		return -EOVERFLOW;
	}

	memcpy(header, OGG_CAPTURE_PATTERN, 4U);
	header[4] = 0U;
	header[5] = flags;
	sys_put_le64(granule, header + 6U);
	sys_put_le32(OPUS_SERIAL_NUMBER, header + 14U);
	sys_put_le32(writer->sequence++, header + 18U);
	header[26] = (uint8_t)segment_count;

	size_t header_bytes = OGG_HEADER_BYTES + segment_count;
	uint32_t crc = ogg_crc_update(0U, header, header_bytes);

	crc = ogg_crc_update(crc, payload, payload_bytes);
	sys_put_le32(crc, header + 22U);

	int error = write_all(writer->file, header, header_bytes);

	if (error == 0) {
		error = write_all(writer->file, payload, payload_bytes);
	}
	if (error == 0) {
		writer->bytes += (uint32_t)(header_bytes + payload_bytes);
	}
	return error;
}

static int ogg_write_headers(struct ogg_writer *writer, uint16_t pre_skip,
			     uint32_t input_sample_rate)
{
	uint8_t opus_head[19] = { 0 };
	uint8_t opus_tags[32] = { 0 };
	const char vendor[] = "AI Pendant";
	uint16_t packet_length;
	int error;

	memcpy(opus_head, "OpusHead", 8U);
	opus_head[8] = 1U;
	opus_head[9] = 1U;
	sys_put_le16(pre_skip, opus_head + 10U);
	sys_put_le32(input_sample_rate, opus_head + 12U);
	packet_length = sizeof(opus_head);
	error = ogg_write_page(writer, OGG_FLAG_BOS, 0U, opus_head,
			       &packet_length, 1U);
	if (error != 0) {
		return error;
	}

	memcpy(opus_tags, "OpusTags", 8U);
	sys_put_le32(sizeof(vendor) - 1U, opus_tags + 8U);
	memcpy(opus_tags + 12U, vendor, sizeof(vendor) - 1U);
	sys_put_le32(0U, opus_tags + 12U + sizeof(vendor) - 1U);
	packet_length = (uint16_t)(16U + sizeof(vendor) - 1U);
	return ogg_write_page(writer, 0U, 0U, opus_tags, &packet_length, 1U);
}

struct pcm_resampler {
	struct fs_file_t *file;
	uint32_t source_rate;
	uint32_t source_samples;
	uint32_t output_index;
	uint32_t source_index;
	int16_t current;
	int16_t next;
	bool initialized;
};

static int read_pcm_sample(struct fs_file_t *file, int16_t *sample)
{
	uint8_t bytes[2];
	ssize_t count = fs_read(file, bytes, sizeof(bytes));

	if (count < 0) {
		return (int)count;
	}
	if (count != sizeof(bytes)) {
		return count == 0 ? -ENODATA : -EBADMSG;
	}
	*sample = (int16_t)sys_get_le16(bytes);
	return 0;
}

static int resampler_initialize(struct pcm_resampler *resampler)
{
	int error = read_pcm_sample(resampler->file, &resampler->current);

	if (error != 0) {
		return error;
	}
	error = read_pcm_sample(resampler->file, &resampler->next);
	if (error == -ENODATA) {
		resampler->next = resampler->current;
		error = 0;
	}
	resampler->initialized = error == 0;
	return error;
}

static int resampler_next(struct pcm_resampler *resampler, int16_t *sample)
{
	if (!resampler->initialized) {
		int error = resampler_initialize(resampler);

		if (error != 0) {
			return error;
		}
	}

	uint64_t position =
		(uint64_t)resampler->output_index * resampler->source_rate;
	uint32_t wanted_index =
		(uint32_t)(position / PENDANT_OPUS_SAMPLE_RATE);

	if (wanted_index >= resampler->source_samples) {
		return -ENODATA;
	}
	while (resampler->source_index < wanted_index) {
		resampler->current = resampler->next;
		++resampler->source_index;
		if (resampler->source_index + 1U <
		    resampler->source_samples) {
			int error = read_pcm_sample(resampler->file,
						    &resampler->next);

			if (error != 0) {
				return error;
			}
		} else {
			resampler->next = resampler->current;
		}
	}

	uint32_t fraction =
		(uint32_t)(position % PENDANT_OPUS_SAMPLE_RATE);
	int32_t interpolated =
		(int32_t)resampler->current *
			(int32_t)(PENDANT_OPUS_SAMPLE_RATE - fraction) +
		(int32_t)resampler->next * (int32_t)fraction;

	*sample = (int16_t)(interpolated / (int32_t)PENDANT_OPUS_SAMPLE_RATE);
	++resampler->output_index;
	return 0;
}

int pendant_opus_encode_file(const char *pcm_path, const char *opus_path,
			     uint32_t source_sample_rate, void *workspace,
			     size_t workspace_bytes,
			     struct pendant_opus_stats *stats)
{
	struct fs_dirent input_entry;
	struct fs_file_t input;
	struct fs_file_t output;
	struct pcm_resampler resampler = { 0 };
	struct ogg_writer ogg = { 0 };
	int16_t frame[OPUS_ENCODE_FRAME_SAMPLES];
	uint16_t packet_lengths[OGG_PACKETS_PER_PAGE];
	bool input_open = false;
	bool output_open = false;
	int error;

	if (workspace == NULL || stats == NULL || source_sample_rate == 0U) {
		return -EINVAL;
	}
	memset(stats, 0, sizeof(*stats));
	error = fs_stat(pcm_path, &input_entry);
	if (error != 0 || input_entry.type != FS_DIR_ENTRY_FILE ||
	    input_entry.size == 0U || (input_entry.size & 1U) != 0U) {
		return error != 0 ? error : -EBADMSG;
	}
	uint32_t source_samples = (uint32_t)input_entry.size / sizeof(int16_t);
	uint32_t output_samples = (uint32_t)(
		((uint64_t)source_samples * PENDANT_OPUS_SAMPLE_RATE +
		 source_sample_rate - 1U) /
		source_sample_rate);
	uint32_t total_packets =
		DIV_ROUND_UP(output_samples, OPUS_ENCODE_FRAME_SAMPLES);
	int encoder_bytes = opus_encoder_get_size(1);
	size_t arena_needed = ROUND_UP((size_t)encoder_bytes, 4U) +
			      OGG_MAX_PAGE_PAYLOAD;

	if (encoder_bytes <= 0 || arena_needed > workspace_bytes) {
		return -ENOMEM;
	}
	OpusEncoder *encoder = workspace;
	uint8_t *page_payload =
		(uint8_t *)workspace + ROUND_UP((size_t)encoder_bytes, 4U);

	error = opus_encoder_init(encoder, PENDANT_OPUS_SAMPLE_RATE, 1,
				  OPUS_APPLICATION_RESTRICTED_SILK);
	if (error != OPUS_OK) {
		return -EINVAL;
	}
	if (opus_encoder_ctl(encoder, OPUS_SET_BITRATE(PENDANT_OPUS_BITRATE)) !=
		    OPUS_OK ||
	    opus_encoder_ctl(encoder, OPUS_SET_COMPLEXITY(3)) != OPUS_OK ||
	    opus_encoder_ctl(encoder, OPUS_SET_SIGNAL(OPUS_SIGNAL_VOICE)) !=
		    OPUS_OK ||
	    opus_encoder_ctl(encoder, OPUS_SET_VBR(1)) != OPUS_OK) {
		return -EINVAL;
	}
	opus_int32 lookahead = 0;
	if (opus_encoder_ctl(encoder, OPUS_GET_LOOKAHEAD(&lookahead)) != OPUS_OK) {
		return -EINVAL;
	}
	uint16_t pre_skip = (uint16_t)(lookahead *
		(OGG_GRANULE_RATE / PENDANT_OPUS_SAMPLE_RATE));

	fs_file_t_init(&input);
	fs_file_t_init(&output);
	error = fs_open(&input, pcm_path, FS_O_READ);
	if (error != 0) {
		goto out;
	}
	input_open = true;
	error = fs_open(&output, opus_path,
			FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
	if (error != 0) {
		goto out;
	}
	output_open = true;
	resampler.file = &input;
	resampler.source_rate = source_sample_rate;
	resampler.source_samples = source_samples;
	ogg.file = &output;

	error = ogg_write_headers(&ogg, pre_skip, source_sample_rate);
	if (error != 0) {
		goto out;
	}

	size_t page_packets = 0U;
	size_t page_bytes = 0U;
	uint32_t produced_samples = 0U;
	for (uint32_t packet = 0U; packet < total_packets; ++packet) {
		size_t valid_samples = MIN(
			(uint32_t)OPUS_ENCODE_FRAME_SAMPLES,
			output_samples - produced_samples);

		for (size_t index = 0U; index < valid_samples; ++index) {
			error = resampler_next(&resampler, &frame[index]);
			if (error != 0) {
				goto out;
			}
		}
		memset(frame + valid_samples, 0,
		       (OPUS_ENCODE_FRAME_SAMPLES - valid_samples) *
			       sizeof(frame[0]));

		int packet_bytes = opus_encode(
			encoder, frame, OPUS_ENCODE_FRAME_SAMPLES,
			page_payload + page_bytes, OPUS_ENCODE_PACKET_BYTES);

		if (packet_bytes < 0) {
			error = -EIO;
			goto out;
		}
		packet_lengths[page_packets++] = (uint16_t)packet_bytes;
		page_bytes += (size_t)packet_bytes;
		produced_samples += (uint32_t)valid_samples;
		stats->packets++;

		bool final_packet = packet + 1U == total_packets;
		if (page_packets == OGG_PACKETS_PER_PAGE || final_packet) {
			uint64_t granule = final_packet
				? (uint64_t)pre_skip +
					  (uint64_t)output_samples *
						  (OGG_GRANULE_RATE /
						   PENDANT_OPUS_SAMPLE_RATE)
				: (uint64_t)(packet + 1U) *
					  OPUS_ENCODE_FRAME_SAMPLES *
					  (OGG_GRANULE_RATE /
					   PENDANT_OPUS_SAMPLE_RATE);

			error = ogg_write_page(
				&ogg, final_packet ? OGG_FLAG_EOS : 0U,
				granule, page_payload, packet_lengths,
				page_packets);
			if (error != 0) {
				goto out;
			}
			page_packets = 0U;
			page_bytes = 0U;
		}
	}
	error = fs_sync(&output);
	if (error == 0) {
		stats->input_bytes = (uint32_t)input_entry.size;
		stats->output_bytes = ogg.bytes;
		stats->samples = output_samples;
		printk("Opus encoded %u PCM bytes to %u Ogg bytes "
		       "(%u packets, %u Hz)\n",
		       stats->input_bytes, stats->output_bytes, stats->packets,
		       PENDANT_OPUS_SAMPLE_RATE);
	}

out:
	if (output_open) {
		int close_error = fs_close(&output);

		if (error == 0) {
			error = close_error;
		}
	}
	if (input_open) {
		int close_error = fs_close(&input);

		if (error == 0) {
			error = close_error;
		}
	}
	return error;
}

struct ogg_reader {
	struct fs_file_t *file;
	uint32_t bytes;
};

static int read_exact(struct ogg_reader *reader, void *data, size_t length)
{
	uint8_t *bytes = data;
	size_t offset = 0U;

	while (offset < length) {
		ssize_t count = fs_read(reader->file, bytes + offset,
					length - offset);

		if (count < 0) {
			return (int)count;
		}
		if (count == 0) {
			return -ENODATA;
		}
		offset += (size_t)count;
		reader->bytes += (uint32_t)count;
	}
	return 0;
}

static int write_pcm_samples(struct fs_file_t *file, const opus_int16 *samples,
			     size_t sample_count)
{
	uint8_t bytes[256];
	size_t offset = 0U;

	while (offset < sample_count) {
		size_t count = MIN(sample_count - offset,
				   sizeof(bytes) / sizeof(int16_t));

		for (size_t index = 0U; index < count; ++index) {
			sys_put_le16((uint16_t)samples[offset + index],
				     bytes + index * 2U);
		}
		int error = write_all(file, bytes, count * sizeof(int16_t));

		if (error != 0) {
			return error;
		}
		offset += count;
	}
	return 0;
}

int pendant_opus_decode_file(const char *opus_path, const char *pcm_path,
			     void *workspace, size_t workspace_bytes,
			     struct pendant_opus_stats *stats)
{
	struct fs_file_t input;
	struct fs_file_t output;
	struct ogg_reader reader = { 0 };
	uint8_t page_header[OGG_HEADER_BYTES];
	uint8_t lacing[255];
	bool input_open = false;
	bool output_open = false;
	bool saw_head = false;
	bool saw_tags = false;
	uint16_t pre_skip_48k = 0U;
	uint32_t skipped_samples = 0U;
	uint32_t written_samples = 0U;
	size_t packet_bytes = 0U;
	int error;

	if (workspace == NULL || stats == NULL) {
		return -EINVAL;
	}
	memset(stats, 0, sizeof(*stats));
	int decoder_bytes = opus_decoder_get_size(1);
	size_t decoder_offset = ROUND_UP((size_t)decoder_bytes, 4U);
	size_t pcm_offset = decoder_offset;
	size_t packet_offset =
		pcm_offset + OPUS_DECODE_MAX_FRAME_SAMPLES * sizeof(opus_int16);

	if (decoder_bytes <= 0 ||
	    packet_offset + OPUS_MAX_PACKET_BYTES > workspace_bytes) {
		return -ENOMEM;
	}
	OpusDecoder *decoder = workspace;
	opus_int16 *decoded = (opus_int16 *)((uint8_t *)workspace + pcm_offset);
	uint8_t *packet = (uint8_t *)workspace + packet_offset;

	error = opus_decoder_init(decoder, PENDANT_OPUS_REPLY_SAMPLE_RATE, 1);
	if (error != OPUS_OK) {
		return -EINVAL;
	}

	fs_file_t_init(&input);
	fs_file_t_init(&output);
	error = fs_open(&input, opus_path, FS_O_READ);
	if (error != 0) {
		goto out;
	}
	input_open = true;
	error = fs_open(&output, pcm_path,
			FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
	if (error != 0) {
		goto out;
	}
	output_open = true;
	reader.file = &input;

	while (true) {
		error = read_exact(&reader, page_header, sizeof(page_header));
		if (error == -ENODATA) {
			error = 0;
			break;
		}
		if (error != 0) {
			goto out;
		}
		if (memcmp(page_header, OGG_CAPTURE_PATTERN, 4U) != 0 ||
		    page_header[4] != 0U) {
			error = -EBADMSG;
			goto out;
		}
		uint8_t flags = page_header[5];
		uint64_t granule = sys_get_le64(page_header + 6U);
		size_t segment_count = page_header[26];

		error = read_exact(&reader, lacing, segment_count);
		if (error != 0) {
			goto out;
		}
		for (size_t segment = 0U; segment < segment_count; ++segment) {
			size_t segment_bytes = lacing[segment];

			if (packet_bytes + segment_bytes > OPUS_MAX_PACKET_BYTES) {
				error = -EOVERFLOW;
				goto out;
			}
			error = read_exact(&reader, packet + packet_bytes,
					   segment_bytes);
			if (error != 0) {
				goto out;
			}
			packet_bytes += segment_bytes;
			if (segment_bytes == 255U) {
				continue;
			}

			if (!saw_head) {
				if (packet_bytes < 19U ||
				    memcmp(packet, "OpusHead", 8U) != 0 ||
				    packet[9] != 1U) {
					error = -EBADMSG;
					goto out;
				}
				pre_skip_48k = sys_get_le16(packet + 10U);
				saw_head = true;
			} else if (!saw_tags) {
				if (packet_bytes < 8U ||
				    memcmp(packet, "OpusTags", 8U) != 0) {
					error = -EBADMSG;
					goto out;
				}
				saw_tags = true;
			} else {
				int samples = opus_decode(
					decoder, packet, (opus_int32)packet_bytes,
					decoded, OPUS_DECODE_MAX_FRAME_SAMPLES, 0);

				if (samples < 0) {
					error = -EBADMSG;
					goto out;
				}
				stats->packets++;
				uint32_t skip_target = DIV_ROUND_UP(
					(uint32_t)pre_skip_48k *
						PENDANT_OPUS_REPLY_SAMPLE_RATE,
					OGG_GRANULE_RATE);
				size_t skip = skipped_samples < skip_target
					? MIN((uint32_t)samples,
					      skip_target - skipped_samples)
					: 0U;

				skipped_samples += (uint32_t)skip;
				size_t keep = (size_t)samples - skip;
				if ((flags & OGG_FLAG_EOS) != 0U &&
				    granule >= pre_skip_48k) {
					uint32_t target = (uint32_t)(
						(granule - pre_skip_48k) *
						PENDANT_OPUS_REPLY_SAMPLE_RATE /
						OGG_GRANULE_RATE);

					keep = MIN(keep,
						   target > written_samples
							   ? target -
								     written_samples
							   : 0U);
				}
				error = write_pcm_samples(
					&output, decoded + skip, keep);
				if (error != 0) {
					goto out;
				}
				written_samples += (uint32_t)keep;
			}
			packet_bytes = 0U;
		}
		if ((flags & OGG_FLAG_EOS) != 0U) {
			break;
		}
		if (packet_bytes != 0U &&
		    (flags & OGG_FLAG_CONTINUED) == 0U) {
			/* A packet may continue onto the next page only when
			 * the following page advertises the continuation.
			 */
		}
	}
	if (!saw_head || !saw_tags || written_samples == 0U) {
		error = -EBADMSG;
		goto out;
	}
	error = fs_sync(&output);
	if (error == 0) {
		stats->input_bytes = reader.bytes;
		stats->output_bytes = written_samples * sizeof(int16_t);
		stats->samples = written_samples;
		printk("Opus decoded %u Ogg bytes to %u PCM bytes "
		       "(%u samples at %u Hz)\n",
		       stats->input_bytes, stats->output_bytes, stats->samples,
		       PENDANT_OPUS_REPLY_SAMPLE_RATE);
	}

out:
	if (output_open) {
		int close_error = fs_close(&output);

		if (error == 0) {
			error = close_error;
		}
	}
	if (input_open) {
		int close_error = fs_close(&input);

		if (error == 0) {
			error = close_error;
		}
	}
	return error;
}

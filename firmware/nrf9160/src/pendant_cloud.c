#include "pendant_cloud.h"

#include <errno.h>
#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>

#include <modem/lte_lc.h>
#include <modem/modem_key_mgmt.h>
#include <modem/nrf_modem_lib.h>
#include <nrf_modem_at.h>
#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/net/socket.h>
#include <zephyr/net/tls_credentials.h>
#include <fcntl.h>
#include <zephyr/posix/arpa/inet.h>
#include <zephyr/posix/fcntl.h>
#include <zephyr/posix/netdb.h>
#include <zephyr/posix/sys/socket.h>
#include <zephyr/posix/unistd.h>
#include <zephyr/sys/atomic.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

/* Owned by main.c; lets the reply poll react to Button 1. */
extern struct k_sem button_press_sem;

/* Periodic attach diagnostics while lte_lc_connect() blocks (up to
 * CONFIG_LTE_NETWORK_TIMEOUT). +CEREG: 0 not-reg, 1 home, 2 searching,
 * 3 denied, 5 roaming. %XSIM: 1 = SIM OK.
 */
static void lte_attach_probe_fn(struct k_work *work);
static K_WORK_DELAYABLE_DEFINE(lte_attach_probe_work, lte_attach_probe_fn);
static uint32_t lte_attach_probe_count;
static int64_t lte_attach_started_ms;
static atomic_t lte_attach_probe_active;

static void lte_attach_probe_fn(struct k_work *work)
{
	char at_buf[240];
	int64_t elapsed_s =
		(k_uptime_get() - lte_attach_started_ms) / 1000;

	ARG_UNUSED(work);
	if (!atomic_get(&lte_attach_probe_active)) {
		return;
	}
	++lte_attach_probe_count;
	printk("LTE attach waiting… t=%llds probe=%u timeout=%us\n",
	       elapsed_s, lte_attach_probe_count,
	       (unsigned int)CONFIG_LTE_NETWORK_TIMEOUT);

	if (nrf_modem_at_cmd(at_buf, sizeof(at_buf), "AT+CEREG?") == 0) {
		printk("LTE probe reg: %s", at_buf);
	}
	if (nrf_modem_at_cmd(at_buf, sizeof(at_buf), "AT%%XSIM?") == 0) {
		printk("LTE probe SIM (post-CFUN, authoritative): %s", at_buf);
	}
	if (nrf_modem_at_cmd(at_buf, sizeof(at_buf), "AT%%XICCID") == 0) {
		printk("LTE probe iccid: %s", at_buf);
	} else {
		printk("LTE probe iccid: not ready\n");
	}
	if (nrf_modem_at_cmd(at_buf, sizeof(at_buf), "AT+CESQ") == 0) {
		printk("LTE probe signal: %s", at_buf);
	}
	if (nrf_modem_at_cmd(at_buf, sizeof(at_buf), "AT%%XMONITOR") == 0) {
		printk("LTE probe cell: %s", at_buf);
	}
	if (atomic_get(&lte_attach_probe_active)) {
		k_work_schedule(&lte_attach_probe_work, K_SECONDS(5));
	}
}

#define RELAY_HOSTNAME \
	"ai-pendant-mission-control.your-subdomain.workers.dev"
#define RELAY_PORT "443"
#define TRANSCRIBE_PATH "/v1/transcribe"
#define MAC_PLAN_PATH "/v1/mac/plan"
#define PENDANT_EVENT_PATH_PREFIX "/v1/pendant/jobs/"
#define PENDANT_EVENT_PATH_SUFFIX "/events"
#define PENDANT_DEVICE_ID "nrf9160-pendant"

#define TLS_SECURITY_TAG 193
#define TLS_VERIFY_REQUIRED 2
/* Sized for JSON status + short transcript (not multi-MB bodies). */
#define HTTP_RESPONSE_SIZE 2048U
#define HTTP_HEADER_SIZE 768U
#define FILE_READ_SIZE 384U
#define BASE64_SEND_SIZE 512U
#define TRANSCRIPT_JSON_SIZE 1024U
#define JOB_ID_SIZE 80U
#define PLAN_SUFFIX_SIZE 416U
#define PENDANT_EVENT_BODY_SIZE 512U
#define HTTP_STREAM_HEADER_SIZE 1536U
#define HTTP_STREAM_READ_SIZE 1536U
#define MAX_PCM_BYTES (8U * 1024U * 1024U)
#define AGENT_REPLY_POLL_ATTEMPTS 30U

static const char relay_ca_certificate[] = {
#include "globalsign_root_ca.pem.inc"
	0x00
};

static const char transcription_prefix[] = "{\"audioBase64\":\"";
static const char transcription_suffix[] =
	"\",\"format\":\"ogg\",\"language\":\"en\"}";
static const char plan_prefix[] = "{\"command\":";
static const char base64_alphabet[] =
	"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789+/";

static char http_response[HTTP_RESPONSE_SIZE];
static char transcript_json[TRANSCRIPT_JSON_SIZE];
static char transcription_job_id[JOB_ID_SIZE];
static char mac_job_id[JOB_ID_SIZE];
static char announced_job_id[JOB_ID_SIZE];
static uint8_t http_stream_buffer[HTTP_STREAM_READ_SIZE];
static bool cloud_initialized;
static bool radio_suspended;

/* Live chunked PCM upload session (one TLS socket for the whole utterance). */
static int stream_fd = -1;
static bool stream_active;
static uint32_t stream_sample_rate;
static uint32_t stream_bytes_sent;
static int64_t stream_started_ms;
/* Non-blocking TX: one in-flight HTTP chunk framing + body + CRLF. */
#define STREAM_PENDING_MAX 1200U
static uint8_t stream_pending[STREAM_PENDING_MAX];
static size_t stream_pending_len;
static size_t stream_pending_off;
static uint32_t stream_pump_calls;
static uint32_t stream_eagain_count;

volatile int pendant_cloud_init_result = -EAGAIN;
volatile int pendant_cloud_transcribe_result = -EAGAIN;
volatile int pendant_cloud_dispatch_result = -EAGAIN;
volatile int pendant_cloud_reply_result = -EAGAIN;
volatile int pendant_cloud_last_http_status;
volatile uint32_t pendant_cloud_uploaded_pcm_bytes;
volatile uint32_t pendant_cloud_reply_pcm_bytes;
volatile uint32_t pendant_cloud_reply_sample_rate = 24000U;
volatile enum pendant_cloud_audio_format pendant_cloud_reply_format =
	PENDANT_CLOUD_AUDIO_UNKNOWN;

BUILD_ASSERT(sizeof(relay_ca_certificate) < KB(4),
	     "Relay root certificate unexpectedly large");

static int send_all(int fd, const void *data, size_t length)
{
	const uint8_t *bytes = data;
	size_t offset = 0U;

	while (offset < length) {
		ssize_t sent = send(fd, bytes + offset, length - offset, 0);

		if (sent < 0) {
			if (errno == EINTR) {
				continue;
			}
			return -errno;
		}
		if (sent == 0) {
			return -ECONNRESET;
		}
		offset += (size_t)sent;
	}

	return 0;
}

static int provision_relay_certificate(void)
{
	bool exists = false;
	int error = modem_key_mgmt_exists(
		TLS_SECURITY_TAG, MODEM_KEY_MGMT_CRED_TYPE_CA_CHAIN, &exists);

	if (error != 0) {
		return error;
	}

	if (exists) {
		error = modem_key_mgmt_cmp(
			TLS_SECURITY_TAG, MODEM_KEY_MGMT_CRED_TYPE_CA_CHAIN,
			relay_ca_certificate, sizeof(relay_ca_certificate));
		if (error == 0) {
			printk("Relay CA certificate already provisioned\n");
			return 0;
		}

		error = modem_key_mgmt_delete(
			TLS_SECURITY_TAG, MODEM_KEY_MGMT_CRED_TYPE_CA_CHAIN);
		if (error != 0) {
			return error;
		}
	}

	error = modem_key_mgmt_write(
		TLS_SECURITY_TAG, MODEM_KEY_MGMT_CRED_TYPE_CA_CHAIN,
		relay_ca_certificate, sizeof(relay_ca_certificate));
	if (error == 0) {
		printk("Relay CA certificate provisioned\n");
	}
	return error;
}

static int configure_tls_socket(int fd)
{
	const sec_tag_t security_tags[] = { TLS_SECURITY_TAG };
	int verify = TLS_VERIFY_REQUIRED;
	int error;

	error = setsockopt(fd, SOL_TLS, TLS_PEER_VERIFY,
			   &verify, sizeof(verify));
	if (error != 0) {
		return -errno;
	}

	error = setsockopt(fd, SOL_TLS, TLS_SEC_TAG_LIST,
			   security_tags, sizeof(security_tags));
	if (error != 0) {
		return -errno;
	}

	error = setsockopt(fd, SOL_TLS, TLS_HOSTNAME,
			   RELAY_HOSTNAME, sizeof(RELAY_HOSTNAME) - 1U);
	if (error != 0) {
		return -errno;
	}

#if defined(TLS_SESSION_CACHE)
	/*
	 * Session resumption is the difference between a ~0.5 s second
	 * connect and a full ~2–10 s handshake on LTE-M. The previous guard
	 * required TLS_SESSION_CACHE_ENABLED to also be *defined*, but that
	 * symbol is a value (1), not a feature flag — so the option never
	 * applied. Always request caching when the socket API supports it.
	 */
	{
		int session_cache = TLS_SESSION_CACHE_ENABLED;

		if (setsockopt(fd, SOL_TLS, TLS_SESSION_CACHE,
			       &session_cache, sizeof(session_cache)) != 0) {
			printk("TLS session cache not accepted (errno=%d)\n",
			       errno);
		}
	}
#endif

	return 0;
}

static int open_relay_socket(void)
{
	struct addrinfo hints = {
		.ai_family = AF_INET,
		.ai_socktype = SOCK_STREAM,
	};
	int last_error = -EHOSTUNREACH;

	/*
	 * Cloud Run publishes several IPv4 addresses. A cellular route can
	 * occasionally refuse one address while the others remain reachable,
	 * so try every answer and refresh DNS before failing the voice cycle.
	 */
	int64_t lat_socket_started = k_uptime_get();

	for (unsigned int attempt = 1U; attempt <= 3U; ++attempt) {
		struct addrinfo *result = NULL;
		int64_t lat_dns_started = k_uptime_get();
		int error = getaddrinfo(RELAY_HOSTNAME, RELAY_PORT,
					&hints, &result);
		int64_t lat_dns_ms = k_uptime_get() - lat_dns_started;

		printk("LAT dns_ms=%lld attempt=%u error=%d\n",
		       lat_dns_ms, attempt, error);

		if (error != 0 || result == NULL) {
			printk("Relay DNS attempt %u failed: %d errno=%d\n",
			       attempt, error, errno);
			last_error = error != 0 ? -EHOSTUNREACH : -ENOENT;
		} else {
			unsigned int candidate_number = 0U;

			for (struct addrinfo *candidate = result;
			     candidate != NULL; candidate = candidate->ai_next) {
				char address[INET_ADDRSTRLEN] = "?";
				int fd;

				++candidate_number;
				(void)inet_ntop(
					AF_INET,
					&((struct sockaddr_in *)
						  candidate->ai_addr)->sin_addr,
					address, sizeof(address));
				printk("Relay DNS candidate %u.%u: %s\n",
				       attempt, candidate_number, address);
				fd = socket(candidate->ai_family, SOCK_STREAM,
					    IPPROTO_TLS_1_2);
				if (fd < 0) {
					last_error = -errno;
					printk("Relay socket attempt %u.%u failed: %d\n",
					       attempt, candidate_number, last_error);
					continue;
				}

				int64_t lat_tls_started = k_uptime_get();

				error = configure_tls_socket(fd);
				if (error == 0 &&
				    connect(fd, candidate->ai_addr,
					    candidate->ai_addrlen) == 0) {
					printk("Relay TLS connected on attempt %u.%u\n",
					       attempt, candidate_number);
					printk("LAT tls_connect_ms=%lld socket_total_ms=%lld\n",
					       k_uptime_get() - lat_tls_started,
					       k_uptime_get() - lat_socket_started);
					freeaddrinfo(result);
					return fd;
				}

				last_error = error != 0 ? error : -errno;
				printk("Relay TLS attempt %u.%u failed: %d "
				       "(errno=%d)\n",
				       attempt, candidate_number, last_error, errno);
				close(fd);

				/*
				 * Distinguish a carrier/IP routing failure from a
				 * TLS handshake or credential failure.
				 */
				fd = socket(candidate->ai_family, SOCK_STREAM,
					    IPPROTO_TCP);
				if (fd >= 0) {
					error = connect(fd, candidate->ai_addr,
							candidate->ai_addrlen);
					printk("Relay plain TCP diagnostic %u.%u: "
					       "%s (errno=%d)\n",
					       attempt, candidate_number,
					       error == 0 ? "connected" :
					       "failed", errno);
					close(fd);
				}
			}
		}

		if (result != NULL) {
			freeaddrinfo(result);
		}
		if (attempt < 3U) {
			k_sleep(K_SECONDS(2));
		}
	}

	return last_error;
}

static int receive_http_response(int fd)
{
	size_t offset = 0U;

	while (offset < sizeof(http_response) - 1U) {
		ssize_t received = recv(fd, http_response + offset,
					sizeof(http_response) - 1U - offset, 0);

		if (received < 0) {
			if (errno == EINTR) {
				continue;
			}
			return -errno;
		}
		if (received == 0) {
			break;
		}
		offset += (size_t)received;
	}
	http_response[offset] = '\0';

	const char *status = strchr(http_response, ' ');

	if (status == NULL) {
		return -EBADMSG;
	}
	pendant_cloud_last_http_status = atoi(status + 1);
	printk("Relay HTTP status: %d, response bytes: %u\n",
	       pendant_cloud_last_http_status, (uint32_t)offset);

	if (pendant_cloud_last_http_status < 200 ||
	    pendant_cloud_last_http_status >= 300) {
		const char *body = strstr(http_response, "\r\n\r\n");

		printk("Relay error: %s\n", body == NULL ? "(no body)" : body + 4);
		return -EREMOTE;
	}

	return 0;
}

static int send_http_post_header(int fd, const char *path,
				 const char *content_type,
				 size_t content_length)
{
	char header[HTTP_HEADER_SIZE];
	int length = snprintf(
		header, sizeof(header),
		"POST %s HTTP/1.1\r\n"
		"Host: %s\r\n"
		"Authorization: Bearer %s\r\n"
		"Content-Type: %s\r\n"
		"Content-Length: %lu\r\n"
		"Connection: close\r\n\r\n",
		path, RELAY_HOSTNAME, CONFIG_PENDANT_RELAY_API_KEY,
		content_type, (unsigned long)content_length);

	if (length < 0 || (size_t)length >= sizeof(header)) {
		return -EOVERFLOW;
	}
	return send_all(fd, header, (size_t)length);
}

/*
 * Chunked raw PCM voice command: one TLS session, HTTP/1.1 Transfer-Encoding
 * chunked, relay wraps s16le → WAV for STT/multimodal + Mac dispatch.
 * Content-Length is unknown at open time so capture can stream live.
 */
static int send_pendant_command_chunked_header(int fd, uint32_t sample_rate)
{
	char header[HTTP_HEADER_SIZE + 128];
	int length = snprintf(
		header, sizeof(header),
		"POST /v1/pendant/command?dispatch=1 HTTP/1.1\r\n"
		"Host: %s\r\n"
		"Authorization: Bearer %s\r\n"
		"Content-Type: audio/pcm\r\n"
		"Transfer-Encoding: chunked\r\n"
		"X-Device-Id: %s\r\n"
		"X-Audio-Format: pcm\r\n"
		"X-Sample-Rate: %u\r\n"
		"X-Audio-Channels: 1\r\n"
		"X-Audio-Bits: 16\r\n"
		"Connection: close\r\n\r\n",
		RELAY_HOSTNAME, CONFIG_PENDANT_RELAY_API_KEY,
		PENDANT_DEVICE_ID, sample_rate);

	if (length < 0 || (size_t)length >= sizeof(header)) {
		return -EOVERFLOW;
	}
	return send_all(fd, header, (size_t)length);
}

/* Known-length fallback for post-capture file upload of raw PCM. */
static int send_pendant_command_pcm_header(int fd, size_t content_length,
					   uint32_t sample_rate)
{
	char header[HTTP_HEADER_SIZE + 128];
	int length = snprintf(
		header, sizeof(header),
		"POST /v1/pendant/command?dispatch=1 HTTP/1.1\r\n"
		"Host: %s\r\n"
		"Authorization: Bearer %s\r\n"
		"Content-Type: audio/pcm\r\n"
		"Content-Length: %lu\r\n"
		"X-Device-Id: %s\r\n"
		"X-Audio-Format: pcm\r\n"
		"X-Sample-Rate: %u\r\n"
		"X-Audio-Channels: 1\r\n"
		"X-Audio-Bits: 16\r\n"
		"X-Pcm-Bytes: %lu\r\n"
		"Connection: close\r\n\r\n",
		RELAY_HOSTNAME, CONFIG_PENDANT_RELAY_API_KEY,
		(unsigned long)content_length, PENDANT_DEVICE_ID, sample_rate,
		(unsigned long)content_length);

	if (length < 0 || (size_t)length >= sizeof(header)) {
		return -EOVERFLOW;
	}
	return send_all(fd, header, (size_t)length);
}

static int socket_set_nonblock(int fd, bool enable)
{
	int flags = fcntl(fd, F_GETFL, 0);

	if (flags < 0) {
		return -errno;
	}
	if (enable) {
		flags |= O_NONBLOCK;
	} else {
		flags &= ~O_NONBLOCK;
	}
	if (fcntl(fd, F_SETFL, flags) != 0) {
		return -errno;
	}
	return 0;
}

/*
 * Advance non-blocking send of stream_pending. Returns 0 when fully sent,
 * -EAGAIN if more work remains, or a hard error.
 */
static int stream_pending_pump(int64_t deadline_ms)
{
	while (stream_pending_off < stream_pending_len) {
		ssize_t sent;

		if (k_uptime_get() >= deadline_ms) {
			++stream_eagain_count;
			return -EAGAIN;
		}
		sent = send(stream_fd, stream_pending + stream_pending_off,
			    stream_pending_len - stream_pending_off, 0);
		if (sent < 0) {
			if (errno == EINTR) {
				continue;
			}
			if (errno == EAGAIN || errno == EWOULDBLOCK) {
				++stream_eagain_count;
				return -EAGAIN;
			}
			return -errno;
		}
		if (sent == 0) {
			return -ECONNRESET;
		}
		stream_pending_off += (size_t)sent;
	}
	stream_pending_len = 0U;
	stream_pending_off = 0U;
	return 0;
}

static int stream_queue_http_chunk(const void *data, size_t length)
{
	char chunk_header[16];
	int header_length;
	size_t total;

	if (length == 0U) {
		return 0;
	}
	if (stream_pending_len != 0U) {
		return -EBUSY;
	}

	header_length = snprintf(chunk_header, sizeof(chunk_header), "%x\r\n",
				 (unsigned int)length);
	if (header_length < 0 || (size_t)header_length >= sizeof(chunk_header)) {
		return -EOVERFLOW;
	}
	total = (size_t)header_length + length + 2U;
	if (total > sizeof(stream_pending)) {
		return -EMSGSIZE;
	}

	memcpy(stream_pending, chunk_header, (size_t)header_length);
	memcpy(stream_pending + (size_t)header_length, data, length);
	stream_pending[(size_t)header_length + length] = '\r';
	stream_pending[(size_t)header_length + length + 1U] = '\n';
	stream_pending_len = total;
	stream_pending_off = 0U;
	return 0;
}

static int send_http_chunk_end(int fd)
{
	/* Final chunk must go out reliably; briefly restore blocking. */
	(void)socket_set_nonblock(fd, false);
	return send_all(fd, "0\r\n\r\n", 5U);
}

static int copy_transcript_json_string(void);
static int copy_json_string_value(const char *key, char *output,
				  size_t output_size);

static int finalize_command_response(void)
{
	int error;

	error = copy_transcript_json_string();
	if (error != 0) {
		pendant_cloud_transcribe_result = error;
		return error;
	}

	/* Prefer nested job.jobId from /v1/pendant/command; fall back to jobId. */
	if (copy_json_string_value("jobId", mac_job_id, sizeof(mac_job_id)) ==
	    0) {
		(void)strncpy(transcription_job_id, mac_job_id,
			      sizeof(transcription_job_id) - 1U);
		transcription_job_id[sizeof(transcription_job_id) - 1U] = '\0';
		pendant_cloud_dispatch_result = 0;
		printk("Transcript queued for Mac job %s (live PCM stream)\n",
		       mac_job_id);
		return 0;
	}

	pendant_cloud_dispatch_result = -ENOTCONN;
	printk("PCM upload ok but no Mac job was queued\n");
	return -ENOTCONN;
}

static int send_http_get_header(int fd, const char *path)
{
	char header[HTTP_HEADER_SIZE];
	int length = snprintf(
		header, sizeof(header),
		"GET %s HTTP/1.1\r\n"
		"Host: %s\r\n"
		"Authorization: Bearer %s\r\n"
		"Accept: audio/ogg, audio/pcm, application/json\r\n"
		"Connection: close\r\n\r\n",
		path, RELAY_HOSTNAME, CONFIG_PENDANT_RELAY_API_KEY);

	if (length < 0 || (size_t)length >= sizeof(header)) {
		return -EOVERFLOW;
	}
	return send_all(fd, header, (size_t)length);
}

struct base64_stream {
	int fd;
	uint8_t carry[3];
	uint8_t carry_length;
	char output[BASE64_SEND_SIZE];
	size_t output_length;
};

static int base64_flush(struct base64_stream *stream)
{
	int error;

	if (stream->output_length == 0U) {
		return 0;
	}
	error = send_all(stream->fd, stream->output, stream->output_length);
	if (error == 0) {
		stream->output_length = 0U;
	}
	return error;
}

static int base64_emit(struct base64_stream *stream, uint8_t count)
{
	const uint8_t byte0 = stream->carry[0];
	const uint8_t byte1 = count > 1U ? stream->carry[1] : 0U;
	const uint8_t byte2 = count > 2U ? stream->carry[2] : 0U;

	if (stream->output_length + 4U > sizeof(stream->output)) {
		int error = base64_flush(stream);

		if (error != 0) {
			return error;
		}
	}

	stream->output[stream->output_length++] =
		base64_alphabet[byte0 >> 2];
	stream->output[stream->output_length++] =
		base64_alphabet[((byte0 & 0x03U) << 4) | (byte1 >> 4)];
	stream->output[stream->output_length++] =
		count > 1U
			? base64_alphabet[((byte1 & 0x0fU) << 2) |
					  (byte2 >> 6)]
			: '=';
	stream->output[stream->output_length++] =
		count > 2U ? base64_alphabet[byte2 & 0x3fU] : '=';
	stream->carry_length = 0U;
	return 0;
}

static int base64_feed(struct base64_stream *stream,
		       const uint8_t *data, size_t length)
{
	for (size_t index = 0U; index < length; ++index) {
		stream->carry[stream->carry_length++] = data[index];
		if (stream->carry_length == 3U) {
			int error = base64_emit(stream, 3U);

			if (error != 0) {
				return error;
			}
		}
	}
	return 0;
}

static int base64_finish(struct base64_stream *stream)
{
	int error = 0;

	if (stream->carry_length != 0U) {
		error = base64_emit(stream, stream->carry_length);
	}
	return error == 0 ? base64_flush(stream) : error;
}

/*
 * Fallback: known-length raw s16le PCM file upload on /v1/pendant/command.
 * Live capture prefers pendant_cloud_stream_* chunked path instead.
 */
static int post_recording_command(const char *audio_path,
				  uint32_t source_pcm_bytes,
				  uint32_t sample_rate)
{
	struct fs_dirent entry;
	struct fs_file_t file;
	uint8_t file_bytes[FILE_READ_SIZE];
	uint32_t bytes_read_total = 0U;
	int fd = -1;
	int error;

	error = fs_stat(audio_path, &entry);
	if (error != 0) {
		printk("Cloud upload SD stat failed for %s: %d\n",
		       audio_path, error);
		return error;
	}
	if (entry.type != FS_DIR_ENTRY_FILE || entry.size == 0U ||
	    entry.size > MAX_PCM_BYTES || source_pcm_bytes == 0U) {
		printk("Cloud upload rejected SD file: type=%u size=%u\n",
		       (unsigned int)entry.type, (uint32_t)entry.size);
		return -EINVAL;
	}
	printk("Cloud upload found %u PCM bytes on SD (fallback single-shot)\n",
	       (uint32_t)entry.size);

	int64_t lat_upload_started = k_uptime_get();

	fd = open_relay_socket();
	if (fd < 0) {
		printk("Cloud upload could not open relay socket: %d\n", fd);
		return fd;
	}
	int64_t lat_upload_socket_done = k_uptime_get();

	error = send_pendant_command_pcm_header(fd, (size_t)entry.size,
						sample_rate);
	if (error != 0) {
		printk("Cloud upload HTTP header failed: %d\n", error);
		goto out;
	}

	fs_file_t_init(&file);
	error = fs_open(&file, audio_path, FS_O_READ);
	if (error != 0) {
		goto out;
	}

	while (true) {
		ssize_t count = fs_read(&file, file_bytes, sizeof(file_bytes));

		if (count < 0) {
			error = (int)count;
			break;
		}
		if (count == 0) {
			break;
		}
		error = send_all(fd, file_bytes, (size_t)count);
		if (error != 0) {
			break;
		}
		bytes_read_total += (uint32_t)count;
	}
	(void)fs_close(&file);
	if (error != 0) {
		goto out;
	}
	if (bytes_read_total != entry.size) {
		error = -EIO;
		goto out;
	}

	pendant_cloud_uploaded_pcm_bytes = bytes_read_total;
	printk("Uploaded %u raw PCM bytes (fallback single-shot)\n",
	       bytes_read_total);
	int64_t lat_body_sent = k_uptime_get();

	error = receive_http_response(fd);
	printk("LAT upload socket_ms=%lld body_send_ms=%lld "
	       "server_wait_ms=%lld total_ms=%lld body_bytes=%u\n",
	       lat_upload_socket_done - lat_upload_started,
	       lat_body_sent - lat_upload_socket_done,
	       k_uptime_get() - lat_body_sent,
	       k_uptime_get() - lat_upload_started,
	       (uint32_t)entry.size);

out:
	close(fd);
	return error;
}

static int copy_transcript_json_string(void)
{
	const char *body = strstr(http_response, "\r\n\r\n");
	const char *key;
	const char *start;
	const char *cursor;
	bool escaped = false;

	if (body == NULL) {
		return -EBADMSG;
	}
	key = strstr(body + 4, "\"text\"");
	if (key == NULL) {
		return -ENODATA;
	}
	start = strchr(key + sizeof("\"text\"") - 1U, ':');
	if (start == NULL) {
		return -EBADMSG;
	}
	do {
		++start;
	} while (*start == ' ' || *start == '\t' || *start == '\r' ||
		 *start == '\n');
	if (*start != '"') {
		return -EBADMSG;
	}

	for (cursor = start + 1; *cursor != '\0'; ++cursor) {
		if (escaped) {
			escaped = false;
			continue;
		}
		if (*cursor == '\\') {
			escaped = true;
			continue;
		}
		if (*cursor == '"') {
			size_t length = (size_t)(cursor - start + 1);

			if (length >= sizeof(transcript_json)) {
				return -E2BIG;
			}
			memcpy(transcript_json, start, length);
			transcript_json[length] = '\0';
			printk("Remote transcript: %s\n", transcript_json);
			return 0;
		}
	}

	return -EBADMSG;
}

static int copy_json_string_value(const char *key_name,
				  char *destination,
				  size_t destination_size)
{
	const char *body = strstr(http_response, "\r\n\r\n");
	const char *key;
	const char *start;
	const char *end;
	char quoted_key[48];
	int key_length;

	if (body == NULL) {
		return -EBADMSG;
	}
	key_length = snprintf(quoted_key, sizeof(quoted_key), "\"%s\"",
			      key_name);
	if (key_length < 0 || (size_t)key_length >= sizeof(quoted_key)) {
		return -EOVERFLOW;
	}
	key = strstr(body + 4, quoted_key);
	if (key == NULL) {
		return -ENODATA;
	}
	start = strchr(key + key_length, ':');
	if (start == NULL) {
		return -EBADMSG;
	}
	do {
		++start;
	} while (*start == ' ' || *start == '\t' || *start == '\r' ||
		 *start == '\n');
	if (*start != '"') {
		return -EBADMSG;
	}
	++start;
	end = strchr(start, '"');
	if (end == NULL) {
		return -EBADMSG;
	}

	size_t length = (size_t)(end - start);

	if (length == 0U || length >= destination_size) {
		return length == 0U ? -ENODATA : -E2BIG;
	}
	memcpy(destination, start, length);
	destination[length] = '\0';
	return 0;
}

static int dispatch_transcript_to_mac(uint32_t sample_rate)
{
	char plan_suffix[PLAN_SUFFIX_SIZE];
	const size_t transcript_length = strlen(transcript_json);
	uint32_t duration_ms;
	int suffix_length;
	size_t body_length;
	int fd;
	int error;

	if (sample_rate == 0U) {
		return -EINVAL;
	}
	duration_ms = (uint32_t)(
		((uint64_t)pendant_cloud_uploaded_pcm_bytes * 1000U) /
		((uint64_t)sample_rate * sizeof(int16_t)));
	suffix_length = snprintf(
		plan_suffix, sizeof(plan_suffix),
		",\"deviceId\":\"" PENDANT_DEVICE_ID "\","
		"\"transcriptionJobId\":\"%s\","
			"\"inputTelemetry\":{"
			"\"audioBytes\":%u,"
			"\"format\":\"ogg-opus\","
		"\"sampleRate\":%u,"
		"\"channels\":1,"
		"\"bitsPerSample\":16,"
		"\"inputGainDb\":0,"
		"\"durationMs\":%u,"
		"\"storage\":\"microSD\","
			"\"uploadedFormat\":\"ogg\"}}",
		transcription_job_id, pendant_cloud_uploaded_pcm_bytes,
		sample_rate, duration_ms);
	if (suffix_length < 0 ||
	    (size_t)suffix_length >= sizeof(plan_suffix)) {
		return -EOVERFLOW;
	}

	body_length = sizeof(plan_prefix) - 1U +
		      transcript_length + (size_t)suffix_length;

	int64_t lat_dispatch_started = k_uptime_get();

	fd = open_relay_socket();
	if (fd < 0) {
		return fd;
	}
	int64_t lat_dispatch_socket_done = k_uptime_get();

	error = send_http_post_header(fd, MAC_PLAN_PATH,
				      "application/json", body_length);
	if (error == 0) {
		error = send_all(fd, plan_prefix, sizeof(plan_prefix) - 1U);
	}
	if (error == 0) {
		error = send_all(fd, transcript_json, transcript_length);
	}
	if (error == 0) {
		error = send_all(fd, plan_suffix, (size_t)suffix_length);
	}
	if (error == 0) {
		error = receive_http_response(fd);
	}
	printk("LAT dispatch socket_ms=%lld rest_ms=%lld total_ms=%lld\n",
	       lat_dispatch_socket_done - lat_dispatch_started,
	       k_uptime_get() - lat_dispatch_socket_done,
	       k_uptime_get() - lat_dispatch_started);

	close(fd);
	return error;
}

static int post_pendant_event(const char *stage, const char *status,
			      const char *label, const char *detail,
			      int result)
{
	char path[192];
	char body[PENDANT_EVENT_BODY_SIZE];
	int previous_http_status = pendant_cloud_last_http_status;
	int path_length;
	int body_length;
	int fd;
	int error;

	if (mac_job_id[0] == '\0') {
		return -ENODATA;
	}

	path_length = snprintf(
		path, sizeof(path), "%s%s%s",
		PENDANT_EVENT_PATH_PREFIX, mac_job_id,
		PENDANT_EVENT_PATH_SUFFIX);
	if (path_length < 0 || (size_t)path_length >= sizeof(path)) {
		return -EOVERFLOW;
	}

	body_length = snprintf(
		body, sizeof(body),
		"{\"stage\":\"%s\","
		"\"status\":\"%s\","
		"\"label\":\"%s\","
		"\"detail\":\"%s\","
		"\"meta\":{"
		"\"pcmBytes\":%u,"
		"\"sampleRate\":%u,"
		"\"channels\":1,"
		"\"bitsPerSample\":16,"
		"\"storage\":\"microSD\","
		"\"transport\":\"I2S\","
		"\"result\":%d}}",
		stage, status, label, detail,
		pendant_cloud_reply_pcm_bytes,
		pendant_cloud_reply_sample_rate, result);
	if (body_length < 0 || (size_t)body_length >= sizeof(body)) {
		return -EOVERFLOW;
	}

	fd = open_relay_socket();
	if (fd < 0) {
		return fd;
	}
	error = send_http_post_header(
		fd, path, "application/json", (size_t)body_length);
	if (error == 0) {
		error = send_all(fd, body, (size_t)body_length);
	}
	if (error == 0) {
		error = receive_http_response(fd);
	}
	close(fd);
	pendant_cloud_last_http_status = previous_http_status;
	return error;
}

int pendant_cloud_announce_recording(uint32_t pcm_bytes,
				     uint32_t sample_rate)
{
	char body[192];
	int body_length;
	int fd;
	int error;

	announced_job_id[0] = '\0';
	if (!cloud_initialized) {
		return -ENOTCONN;
	}

	body_length = snprintf(
		body, sizeof(body),
			"{\"deviceId\":\"nrf9160-pendant\","
			"\"pcmBytes\":%u,"
			"\"sampleRate\":%u,"
			"\"format\":\"ogg-opus\"}",
		pcm_bytes, sample_rate);
	if (body_length < 0 || (size_t)body_length >= sizeof(body)) {
		return -EOVERFLOW;
	}

	int64_t lat_announce_started = k_uptime_get();

	fd = open_relay_socket();
	if (fd < 0) {
		return fd;
	}
	int64_t lat_announce_socket_done = k_uptime_get();

	error = send_http_post_header(
		fd, "/v1/pendant/announce", "application/json",
		(size_t)body_length);
	if (error == 0) {
		error = send_all(fd, body, (size_t)body_length);
	}
	if (error == 0) {
		error = receive_http_response(fd);
	}
	close(fd);
	if (error == 0) {
		error = copy_json_string_value(
			"jobId", announced_job_id, sizeof(announced_job_id));
		if (error != 0) {
			announced_job_id[0] = '\0';
		}
	}
	printk("Recording announced: result=%d job=%s\n",
	       error, announced_job_id[0] != '\0' ? announced_job_id : "-");
	printk("LAT announce socket_ms=%lld rest_ms=%lld total_ms=%lld\n",
	       lat_announce_socket_done - lat_announce_started,
	       k_uptime_get() - lat_announce_socket_done,
	       k_uptime_get() - lat_announce_started);
	return error;
}

struct pcm_writer {
	struct fs_file_t *file;
	uint8_t output[FILE_READ_SIZE];
	size_t output_length;
	size_t written_bytes;
};

struct http_body_reader {
	int fd;
	const uint8_t *initial;
	size_t initial_length;
	size_t initial_offset;
	size_t buffer_length;
	size_t buffer_offset;
};

static int pcm_writer_flush(struct pcm_writer *writer)
{
	if (writer->output_length == 0U) {
		return 0;
	}

	ssize_t written = fs_write(writer->file, writer->output,
				   writer->output_length);

	if (written != (ssize_t)writer->output_length) {
		return written < 0 ? (int)written : -EIO;
	}
	writer->written_bytes += writer->output_length;
	writer->output_length = 0U;
	return 0;
}

static int pcm_writer_emit(struct pcm_writer *writer, uint8_t value)
{
	if (writer->written_bytes + writer->output_length >= MAX_PCM_BYTES) {
		return -EFBIG;
	}
	if (writer->output_length == sizeof(writer->output)) {
		int error = pcm_writer_flush(writer);

		if (error != 0) {
			return error;
		}
	}
	writer->output[writer->output_length++] = value;
	return 0;
}

static int http_body_next(struct http_body_reader *reader, uint8_t *value)
{
	if (reader->initial_offset < reader->initial_length) {
		*value = reader->initial[reader->initial_offset++];
		return 1;
	}
	if (reader->buffer_offset < reader->buffer_length) {
		*value = http_stream_buffer[reader->buffer_offset++];
		return 1;
	}

	while (true) {
		ssize_t received = recv(reader->fd, http_stream_buffer,
					sizeof(http_stream_buffer), 0);

		if (received < 0) {
			if (errno == EINTR) {
				continue;
			}
			return -errno;
		}
		if (received == 0) {
			return 0;
		}
		reader->buffer_length = (size_t)received;
		reader->buffer_offset = 1U;
		*value = http_stream_buffer[0];
		return 1;
	}
}

static int read_required_body_byte(struct http_body_reader *reader,
				   uint8_t *value)
{
	int result = http_body_next(reader, value);

	return result > 0 ? 0 : (result == 0 ? -ECONNRESET : result);
}

static int receive_chunked_pcm(struct http_body_reader *reader,
			       struct pcm_writer *writer)
{
	while (true) {
		char size_line[24];
		size_t size_length = 0U;
		uint8_t character;
		int error;

		while (true) {
			error = read_required_body_byte(reader, &character);
			if (error != 0) {
				return error;
			}
			if (character == '\r') {
				break;
			}
			if (size_length + 1U >= sizeof(size_line)) {
				return -EOVERFLOW;
			}
			size_line[size_length++] = (char)character;
		}
		size_line[size_length] = '\0';
		error = read_required_body_byte(reader, &character);
		if (error != 0 || character != '\n') {
			return error != 0 ? error : -EBADMSG;
		}

		char *extension = strchr(size_line, ';');
		if (extension != NULL) {
			*extension = '\0';
		}
		char *end = NULL;
		unsigned long chunk_size = strtoul(size_line, &end, 16);
		if (end == size_line || *end != '\0') {
			return -EBADMSG;
		}
		if (chunk_size == 0U) {
			return 0;
		}

		for (unsigned long index = 0U; index < chunk_size; ++index) {
			error = read_required_body_byte(reader, &character);
			if (error != 0) {
				return error;
			}
			error = pcm_writer_emit(writer, character);
			if (error != 0) {
				return error;
			}
		}
		error = read_required_body_byte(reader, &character);
		if (error != 0 || character != '\r') {
			return error != 0 ? error : -EBADMSG;
		}
		error = read_required_body_byte(reader, &character);
		if (error != 0 || character != '\n') {
			return error != 0 ? error : -EBADMSG;
		}
	}
}

static int receive_fixed_pcm(struct http_body_reader *reader,
			     struct pcm_writer *writer,
			     size_t content_length)
{
	for (size_t index = 0U; index < content_length; ++index) {
		uint8_t character;
		int error = read_required_body_byte(reader, &character);

		if (error != 0) {
			return error;
		}
		error = pcm_writer_emit(writer, character);
		if (error != 0) {
			return error;
		}
	}
	return 0;
}

static int receive_close_delimited_pcm(struct http_body_reader *reader,
				       struct pcm_writer *writer)
{
	while (true) {
		uint8_t character;
		int result = http_body_next(reader, &character);

		if (result < 0) {
			return result;
		}
		if (result == 0) {
			return 0;
		}
		int error = pcm_writer_emit(writer, character);
		if (error != 0) {
			return error;
		}
	}
}

static char ascii_lower(char value)
{
	return value >= 'A' && value <= 'Z' ? value + ('a' - 'A') : value;
}

static const char *header_find_ci(const char *header, const char *needle)
{
	size_t needle_length = strlen(needle);

	for (const char *candidate = header; *candidate != '\0'; ++candidate) {
		size_t index = 0U;

		while (index < needle_length &&
		       candidate[index] != '\0' &&
		       ascii_lower(candidate[index]) ==
			       ascii_lower(needle[index])) {
			++index;
		}
		if (index == needle_length) {
			return candidate;
		}
	}
	return NULL;
}

static size_t header_decimal_value(const char *header, const char *name)
{
	const char *value = header_find_ci(header, name);

	return value == NULL ? 0U : (size_t)strtoul(value + strlen(name), NULL, 10);
}

static int receive_agent_job_speech(int fd, const char *pcm_path)
{
	char header[HTTP_STREAM_HEADER_SIZE];
	struct fs_file_t file;
	size_t header_bytes = 0U;
	char *body = NULL;
	bool file_open = false;
	int error = 0;

	while (header_bytes < sizeof(header) - 1U) {
		ssize_t received = recv(fd, header + header_bytes,
					sizeof(header) - 1U - header_bytes, 0);

		if (received < 0) {
			if (errno == EINTR) {
				continue;
			}
			return -errno;
		}
		if (received == 0) {
			return -ECONNRESET;
		}
		header_bytes += (size_t)received;
		header[header_bytes] = '\0';
		body = strstr(header, "\r\n\r\n");
		if (body != NULL) {
			break;
		}
	}
	if (body == NULL) {
		return -EOVERFLOW;
	}

	const char *status = strchr(header, ' ');
	if (status == NULL) {
		return -EBADMSG;
	}
	pendant_cloud_last_http_status = atoi(status + 1);
	printk("Agent speech HTTP status: %d\n", pendant_cloud_last_http_status);
	if (pendant_cloud_last_http_status == 202) {
		return -EAGAIN;
	}
	if (pendant_cloud_last_http_status < 200 ||
	    pendant_cloud_last_http_status >= 300) {
		return -EREMOTE;
	}
	bool is_opus =
		header_find_ci(header, "Content-Type: audio/ogg") != NULL ||
		header_find_ci(header, "X-Audio-Format: ogg-opus") != NULL;
	bool is_pcm =
		header_find_ci(header, "Content-Type: audio/pcm") != NULL ||
		header_find_ci(header, "X-Audio-Format: s16le") != NULL;

	if (!is_opus && !is_pcm) {
		return -EBADMSG;
	}
	pendant_cloud_reply_format = is_opus
		? PENDANT_CLOUD_AUDIO_OGG_OPUS
		: PENDANT_CLOUD_AUDIO_PCM_S16LE;

	size_t content_length = header_decimal_value(header, "Content-Length:");
	bool chunked =
		header_find_ci(header, "Transfer-Encoding: chunked") != NULL;
	size_t sample_rate =
		header_decimal_value(header, "X-Audio-Sample-Rate:");
	if (sample_rate != 0U) {
		pendant_cloud_reply_sample_rate = (uint32_t)sample_rate;
	}
	body += 4;
	struct http_body_reader reader = {
		.fd = fd,
		.initial = (const uint8_t *)body,
		.initial_length = header_bytes - (size_t)(body - header),
	};
	struct pcm_writer writer = {
		.file = &file,
	};

	fs_file_t_init(&file);
	error = fs_open(&file, pcm_path,
			FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
	if (error != 0) {
		return error;
	}
	file_open = true;
	printk("Agent speech body: chunked=%u content_length=%u\n",
	       chunked ? 1U : 0U, (uint32_t)content_length);

	if (chunked) {
		error = receive_chunked_pcm(&reader, &writer);
	} else if (content_length != 0U) {
		error = receive_fixed_pcm(&reader, &writer, content_length);
	} else {
		error = receive_close_delimited_pcm(&reader, &writer);
	}
	if (error == 0) {
		error = pcm_writer_flush(&writer);
	}
	if (error == 0) {
		error = fs_sync(&file);
	}
	if (file_open) {
		int close_error = fs_close(&file);

		if (error == 0) {
			error = close_error;
		}
	}
	if (error != 0) {
		return error;
	}
	if (writer.written_bytes == 0U ||
	    (is_pcm && (writer.written_bytes & 1U) != 0U)) {
		return -EBADMSG;
	}

	pendant_cloud_reply_pcm_bytes = (uint32_t)writer.written_bytes;
	printk("Downloaded %u bytes of Mac agent speech (%s)\n",
	       pendant_cloud_reply_pcm_bytes,
	       is_opus ? "Ogg Opus" : "PCM fallback");
	return 0;
}

int pendant_cloud_init(void)
{
	int error;

	if (cloud_initialized) {
		return 0;
	}
	if (CONFIG_PENDANT_RELAY_API_KEY[0] == '\0') {
		printk("PENDANT_RELAY_API_KEY is empty\n");
		pendant_cloud_init_result = -EACCES;
		return pendant_cloud_init_result;
	}

	printk("Initializing nRF9160 modem\n");
	error = nrf_modem_lib_init();
	if (error != 0) {
		printk("nrf_modem_lib_init failed: %d\n", error);
		goto out;
	}
	error = provision_relay_certificate();
	if (error != 0) {
		printk("Relay CA provision failed: %d\n", error);
		goto out;
	}

	/*
	 * UICC often only answers after full functionality (CFUN). Pre-attach
	 * ICCID failure is not fatal; recheck during probes. lte_lc_connect
	 * blocks up to CONFIG_LTE_NETWORK_TIMEOUT (cereg.c).
	 */
	{
		char at_buf[160];

		(void)nrf_modem_at_printf("AT+CEREG=5");
		if (nrf_modem_at_cmd(at_buf, sizeof(at_buf),
				     "AT%%XSIM?") == 0) {
			printk("SIM before CFUN (non-authoritative; %%XSIM: 0 is "
			       "expected here): %s", at_buf);
		}
		if (nrf_modem_at_cmd(at_buf, sizeof(at_buf),
				     "AT%%XICCID") == 0) {
			printk("SIM ICCID before CFUN (non-authoritative): %s",
			       at_buf);
		} else {
			printk("SIM ICCID not ready pre-attach "
			       "(will recheck during attach)\n");
		}
	}

	lte_attach_probe_count = 0U;
	lte_attach_started_ms = k_uptime_get();
	atomic_set(&lte_attach_probe_active, 1);
	k_work_schedule(&lte_attach_probe_work, K_SECONDS(3));

	printk("Attaching pendant to LTE network (timeout %us)\n",
	       (unsigned int)CONFIG_LTE_NETWORK_TIMEOUT);
	error = lte_lc_connect();
	atomic_clear(&lte_attach_probe_active);
	struct k_work_sync probe_sync;

	(void)k_work_cancel_delayable_sync(&lte_attach_probe_work, &probe_sync);
	if (error != 0) {
		bool sim_ready = false;

		printk("LTE attach failed: %d (%s).\n", error,
		       error == -ETIMEDOUT ? "timeout" : "error");
		{
			char at_buf[160];

			if (nrf_modem_at_cmd(at_buf, sizeof(at_buf),
					     "AT%%XSIM?") == 0) {
				sim_ready = strstr(at_buf, "%XSIM: 1") != NULL;
				printk("Final SIM (post-CFUN, authoritative): %s",
				       at_buf);
			}
			if (nrf_modem_at_cmd(at_buf, sizeof(at_buf),
					     "AT+CEREG?") == 0) {
				printk("Final CEREG: %s", at_buf);
			}
		}
		if (sim_ready) {
			printk("SIM is initialized; check LTE-M coverage, antenna, "
			       "APN/plan, and registration status.\n");
		} else {
			printk("SIM is not initialized post-CFUN; check the nano-SIM "
			       "seat, contacts, tray, and power.\n");
		}
		goto out;
	}
	{
		char at_buf[160];

		if (nrf_modem_at_cmd(at_buf, sizeof(at_buf), "AT%%XSIM?") == 0) {
			printk("SIM after attach (post-CFUN, authoritative): %s",
			       at_buf);
		}
		if (nrf_modem_at_cmd(at_buf, sizeof(at_buf), "AT%%XICCID") == 0) {
			printk("SIM ICCID after attach: %s", at_buf);
		}
	}

	cloud_initialized = true;
	printk("Pendant LTE connection ready (attach %lld s)\n",
	       (k_uptime_get() - lte_attach_started_ms) / 1000);

out:
	pendant_cloud_init_result = error;
	return error;
}

int pendant_cloud_suspend_radio(void)
{
	int error;

	if (!cloud_initialized || radio_suspended) {
		return 0;
	}

	printk("Powering down modem RF for deterministic microphone capture\n");
	error = lte_lc_func_mode_set(LTE_LC_FUNC_MODE_POWER_OFF);
	if (error == 0) {
		radio_suspended = true;
		/*
		 * The AT command returns before the modem's final RF/HFXO rail
		 * transition has fully settled. Starting I2S during that transition
		 * can still starve DMA about one second later.
		 */
		k_msleep(1500);
	}
	return error;
}

int pendant_cloud_resume_radio(void)
{
	int error;

	if (!radio_suspended) {
		return 0;
	}

	printk("Resuming LTE after microphone capture\n");
	error = lte_lc_func_mode_set(LTE_LC_FUNC_MODE_NORMAL);
	if (error != 0) {
		return error;
	}
	radio_suspended = false;

	printk("Reattaching pendant to LTE network\n");
	return lte_lc_connect();
}

static void stream_reset_state(void)
{
	stream_fd = -1;
	stream_active = false;
	stream_sample_rate = 0U;
	stream_bytes_sent = 0U;
	stream_started_ms = 0;
	stream_pending_len = 0U;
	stream_pending_off = 0U;
	stream_pump_calls = 0U;
	stream_eagain_count = 0U;
}

bool pendant_cloud_stream_active(void)
{
	return stream_active;
}

bool pendant_cloud_stream_has_pending(void)
{
	return stream_pending_len != 0U;
}

uint32_t pendant_cloud_stream_bytes_sent(void)
{
	return stream_bytes_sent;
}

void pendant_cloud_stream_abort(void)
{
	if (stream_fd >= 0) {
		close(stream_fd);
	}
	stream_reset_state();
}

static int stream_open_chunked(uint32_t sample_rate)
{
	int error;

	if (sample_rate == 0U) {
		return -EINVAL;
	}
	if (!cloud_initialized) {
		error = pendant_cloud_init();
		if (error != 0) {
			return error;
		}
	}
	if (radio_suspended) {
		error = pendant_cloud_resume_radio();
		if (error != 0) {
			return error;
		}
	}

	stream_started_ms = k_uptime_get();
	error = open_relay_socket();
	if (error < 0) {
		printk("Live PCM stream socket failed: %d\n", error);
		stream_reset_state();
		return error;
	}
	stream_fd = error;

	/* Headers use blocking send (idle/prewarm only). */
	error = send_pendant_command_chunked_header(stream_fd, sample_rate);
	if (error != 0) {
		printk("Live PCM stream header failed: %d\n", error);
		close(stream_fd);
		stream_reset_state();
		return error;
	}

	error = socket_set_nonblock(stream_fd, true);
	if (error != 0) {
		printk("Live PCM stream nonblock failed: %d\n", error);
		/* Continue with blocking; pump still time-bounds loops. */
	}

	stream_active = true;
	stream_sample_rate = sample_rate;
	stream_bytes_sent = 0U;
	stream_pending_len = 0U;
	stream_pending_off = 0U;
	printk("Live PCM stream open: sample_rate=%u header_ms=%lld\n",
	       sample_rate, k_uptime_get() - stream_started_ms);
	return 0;
}

static void stream_reset_job_state(void)
{
	pendant_cloud_transcribe_result = -EAGAIN;
	pendant_cloud_dispatch_result = -EAGAIN;
	pendant_cloud_reply_result = -EAGAIN;
	pendant_cloud_last_http_status = 0;
	pendant_cloud_uploaded_pcm_bytes = 0U;
	pendant_cloud_reply_pcm_bytes = 0U;
	pendant_cloud_reply_format = PENDANT_CLOUD_AUDIO_UNKNOWN;
	transcription_job_id[0] = '\0';
	mac_job_id[0] = '\0';
	announced_job_id[0] = '\0';
}

/*
 * Open TLS + chunked headers while the UI is idle so Button 1 never waits on
 * the modem handshake. Safe to call repeatedly.
 */
int pendant_cloud_stream_prewarm(uint32_t sample_rate)
{
	int error;

	if (stream_active) {
		return 0;
	}
	stream_reset_job_state();
	error = stream_open_chunked(sample_rate);
	if (error == 0) {
		printk("Live PCM stream prewarmed (idle)\n");
	}
	return error;
}

int pendant_cloud_stream_begin(uint32_t sample_rate)
{
	if (stream_active && stream_sample_rate == sample_rate) {
		/* Reuse prewarmed session. */
		return 0;
	}
	if (stream_active) {
		pendant_cloud_stream_abort();
	}
	stream_reset_job_state();
	return stream_open_chunked(sample_rate);
}

int pendant_cloud_stream_pump(uint32_t budget_ms)
{
	int64_t deadline;

	++stream_pump_calls;
	if (!stream_active || stream_fd < 0) {
		return -ENOTCONN;
	}
	if (stream_pending_len == 0U) {
		return 0;
	}
	deadline = k_uptime_get() + (int64_t)budget_ms;
	return stream_pending_pump(deadline);
}

int pendant_cloud_stream_write(const void *data, size_t length)
{
	int error;

	if (!stream_active || stream_fd < 0) {
		return -ENOTCONN;
	}
	if (data == NULL || length == 0U) {
		return 0;
	}
	if (stream_bytes_sent + length > MAX_PCM_BYTES) {
		return -EFBIG;
	}
	/* Must finish previous chunk framing before queueing another. */
	if (stream_pending_len != 0U) {
		return -EAGAIN;
	}

	error = stream_queue_http_chunk(data, length);
	if (error != 0) {
		return error;
	}
	/* Bytes are committed once framed; pump may finish later. */
	stream_bytes_sent += (uint32_t)length;
	return 0;
}

int pendant_cloud_stream_end(void)
{
	int error;
	int64_t body_done_ms;
	int64_t drain_deadline;

	if (!stream_active || stream_fd < 0) {
		return -ENOTCONN;
	}

	/* Drain any in-flight chunk (budget up to 5 s). */
	drain_deadline = k_uptime_get() + 5000;
	while (stream_pending_len != 0U) {
		error = stream_pending_pump(drain_deadline);
		if (error == -EAGAIN) {
			if (k_uptime_get() >= drain_deadline) {
				printk("Live PCM stream drain timeout\n");
				pendant_cloud_stream_abort();
				pendant_cloud_transcribe_result = -ETIMEDOUT;
				return -ETIMEDOUT;
			}
			continue;
		}
		if (error != 0) {
			printk("Live PCM stream drain failed: %d\n", error);
			pendant_cloud_stream_abort();
			pendant_cloud_transcribe_result = error;
			return error;
		}
	}

	error = send_http_chunk_end(stream_fd);
	if (error != 0) {
		printk("Live PCM stream end-chunk failed: %d\n", error);
		pendant_cloud_stream_abort();
		pendant_cloud_transcribe_result = error;
		return error;
	}

	pendant_cloud_uploaded_pcm_bytes = stream_bytes_sent;
	body_done_ms = k_uptime_get();
	printk("Live PCM stream body complete: bytes=%u stream_ms=%lld "
	       "pumps=%u eagain=%u\n",
	       stream_bytes_sent, body_done_ms - stream_started_ms,
	       stream_pump_calls, stream_eagain_count);

	(void)socket_set_nonblock(stream_fd, false);
	error = receive_http_response(stream_fd);
	printk("LAT live_stream server_wait_ms=%lld total_ms=%lld "
	       "body_bytes=%u HTTP=%d\n",
	       k_uptime_get() - body_done_ms,
	       k_uptime_get() - stream_started_ms, stream_bytes_sent,
	       pendant_cloud_last_http_status);

	close(stream_fd);
	stream_fd = -1;
	stream_active = false;

	pendant_cloud_transcribe_result = error;
	if (error != 0) {
		stream_reset_state();
		return error;
	}

	error = finalize_command_response();
	stream_reset_state();
	return error;
}

int pendant_cloud_upload_recording(const char *audio_path,
				   uint32_t source_pcm_bytes,
				   uint32_t sample_rate)
{
	int error;

	if (stream_active) {
		pendant_cloud_stream_abort();
	}

	pendant_cloud_transcribe_result = -EAGAIN;
	pendant_cloud_dispatch_result = -EAGAIN;
	pendant_cloud_reply_result = -EAGAIN;
	pendant_cloud_last_http_status = 0;
	pendant_cloud_uploaded_pcm_bytes = 0U;
	pendant_cloud_reply_pcm_bytes = 0U;
	pendant_cloud_reply_format = PENDANT_CLOUD_AUDIO_UNKNOWN;
	transcription_job_id[0] = '\0';
	mac_job_id[0] = '\0';
	announced_job_id[0] = '\0';

	if (!cloud_initialized) {
		error = pendant_cloud_init();
		if (error != 0) {
			return error;
		}
	}

	/*
	 * Fallback: one TLS session, raw PCM file, relay STT + Mac queue.
	 */
	error = post_recording_command(audio_path, source_pcm_bytes,
				       sample_rate);
	pendant_cloud_transcribe_result = error;
	if (error != 0) {
		return error;
	}

	return finalize_command_response();
}

int pendant_cloud_wait_for_agent_reply(const char *pcm_path)
{
	char path[192];
	int error;

	pendant_cloud_reply_result = -EAGAIN;
	pendant_cloud_reply_pcm_bytes = 0U;
	pendant_cloud_reply_format = PENDANT_CLOUD_AUDIO_UNKNOWN;
	if (!cloud_initialized || mac_job_id[0] == '\0') {
		pendant_cloud_reply_result = -ENODATA;
		return pendant_cloud_reply_result;
	}

	int length = snprintf(
		path, sizeof(path),
		"/v1/pendant/jobs/%s/speech?waitMs=25000",
		mac_job_id);

	if (length < 0 || (size_t)length >= sizeof(path)) {
		pendant_cloud_reply_result = -EOVERFLOW;
		return pendant_cloud_reply_result;
	}

	for (unsigned int attempt = 1U;
	     attempt <= AGENT_REPLY_POLL_ATTEMPTS; ++attempt) {
		int fd = open_relay_socket();

		if (fd < 0) {
			error = fd;
			continue;
		}
		error = send_http_get_header(fd, path);
		if (error == 0) {
			error = receive_agent_job_speech(fd, pcm_path);
		}
		close(fd);

		if (error == 0) {
			pendant_cloud_reply_result = 0;
			int event_error = post_pendant_event(
				"reply_downloaded", "done",
				"Reply downloaded to pendant",
				"Agent response audio was written to microSD.",
				0);

			if (event_error != 0) {
				printk("Reply telemetry failed: %d\n",
				       event_error);
			}
			return 0;
		}
		if (error != -EAGAIN) {
			break;
		}
		/* A button press abandons the reply so a new recording can
		 * start immediately instead of riding out the full poll.
		 */
		if (k_sem_take(&button_press_sem, K_NO_WAIT) == 0) {
			pendant_cloud_reply_result = -ECANCELED;
			return -ECANCELED;
		}
		printk("Agent reply is not ready; polling again (%u/%u)\n",
		       attempt, AGENT_REPLY_POLL_ATTEMPTS);
		/* ~1 s wait; cancel if the user presses the button. */
		for (unsigned int slice = 0U; slice < 10U; ++slice) {
			if (k_sem_take(&button_press_sem, K_MSEC(100)) == 0) {
				pendant_cloud_reply_result = -ECANCELED;
				return -ECANCELED;
			}
		}
	}

	pendant_cloud_reply_result = error;
	return error;
}

int pendant_cloud_report_playback_started(void)
{
	return post_pendant_event(
		"device_playback", "active",
		"Bluetooth playback started",
		"Pendant started transmitting response PCM over I2S.",
		0);
}

int pendant_cloud_report_playback_result(int playback_result)
{
	if (playback_result == 0) {
		return post_pendant_event(
			"device_playback", "done",
			"Bluetooth playback completed",
			"Pendant finished transmitting response PCM over I2S.",
			0);
	}

	return post_pendant_event(
		"device_playback", "failed",
		"Bluetooth playback failed",
		"Pendant I2S playback returned an error.",
		playback_result);
}

int pendant_cloud_set_job_id_for_diagnostic(const char *job_id)
{
	size_t length;

	if (job_id == NULL) {
		return -EINVAL;
	}
	length = strlen(job_id);
	if (length == 0U || length >= sizeof(mac_job_id)) {
		return -EINVAL;
	}
	memcpy(mac_job_id, job_id, length + 1U);
	return 0;
}

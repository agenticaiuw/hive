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

volatile bool pendant_cloud_reply_first_batch;

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
	"ai-pendant-relay.evan20050827.workers.dev"
#define RELAY_PORT "443"
#define PENDANT_EVENT_PATH_PREFIX "/v1/pendant/jobs/"
#define PENDANT_EVENT_PATH_SUFFIX "/events"
#define PENDANT_DEVICE_ID "nrf9160-pendant"

/*
 * The bearer this pendant presents to the relay.
 *
 * Until now this was CONFIG_PENDANT_RELAY_API_KEY everywhere: the SHARED ADMIN
 * key, principal kind 'admin', scopes ['*'] — the same string the Mac bridge
 * used and the same one in the repo-root .env. A pendant on the owner's chest
 * carried a credential that also opens /v1/ops/*, and it could not be revoked
 * without taking every other node down with it.
 *
 * CONFIG_PENDANT_RELAY_DEVICE_TOKEN is this device's own pdt_<id>.<secret>,
 * paired once with role nrf_pendant. It wins whenever it is non-empty; the
 * admin key stays as the fallback so an image built before commissioning still
 * talks to the relay. Both are compile-time string constants, so this costs a
 * load and a branch, never an allocation.
 *
 * The relay accepts either today (see cloud-relay/deviceAuth.js), including on
 * the /v1/pendant/converse socket, which until this change compared against
 * the admin key alone and would have refused a device token outright.
 */
#define PENDANT_RELAY_BEARER                                                   \
	(CONFIG_PENDANT_RELAY_DEVICE_TOKEN[0] != '\0'                          \
		 ? CONFIG_PENDANT_RELAY_DEVICE_TOKEN                           \
		 : CONFIG_PENDANT_RELAY_API_KEY)

#define TLS_SECURITY_TAG 193
#define TLS_VERIFY_REQUIRED 2
/* Sized for JSON status + short transcript (not multi-MB bodies). */
#define HTTP_RESPONSE_SIZE 2048U
#define HTTP_HEADER_SIZE 768U
#define FILE_READ_SIZE 384U
#define TRANSCRIPT_JSON_SIZE 1024U
#define JOB_ID_SIZE 80U
#define PENDANT_EVENT_BODY_SIZE 512U
#define HTTP_STREAM_HEADER_SIZE 1536U
/*
 * Socket staging for the byte-at-a-time body reader — a recv() batch size,
 * nothing structural: no caller assumes a minimum, and buffer_length is
 * always whatever recv returned.
 *
 * Trimmed 1536 -> 512 on 2026-08-12 when push-to-talk made this path LIVE.
 * Until then main.c never called pendant_cloud_reply_read, so --gc-sections
 * quietly deleted the reader and its buffer and the build's RAM figure had
 * never paid for them; playing an inline reply brings all 1.5 kB back into
 * a build with 7 kB of headroom. The cost of 512 is 3x the recv calls on a
 * 30 kB reply — about 40 extra offloaded-socket reads spread over ~15 s,
 * against ~1 kB of permanent RAM. That is the right side of the trade on
 * this device.
 */
#define HTTP_STREAM_READ_SIZE 512U
#define MAX_PCM_BYTES (8U * 1024U * 1024U)
#define AGENT_REPLY_POLL_ATTEMPTS 30U

static const char relay_ca_certificate[] = {
#include "globalsign_root_ca.pem.inc"
	0x00
};

static char http_response[HTTP_RESPONSE_SIZE];
static char transcript_json[TRANSCRIPT_JSON_SIZE];
static char transcription_job_id[JOB_ID_SIZE];
static char mac_job_id[JOB_ID_SIZE];
static char announced_job_id[JOB_ID_SIZE];
static uint8_t http_stream_buffer[HTTP_STREAM_READ_SIZE];
static bool cloud_initialized;
static bool radio_suspended;

/*
 * DNS on nRF9160 can return -11 / errno=115 (EINPROGRESS/EAGAIN) after RF
 * churn or when the modem's resolver is wedged. Cache the last working IPv4
 * and keep Cloudflare anycast bootstraps for this worker hostname so a voice
 * cycle still reaches the relay when getaddrinfo fails.
 *
 * When DNS has failed recently, prefer cache/bootstrap before another slow
 * getaddrinfo cycle so live prewarm and SD fallback still open a TLS socket.
 */
static struct in_addr relay_cached_ip;
static bool relay_cached_valid;
static bool relay_dns_unreliable;
static const char *const relay_bootstrap_ips[] = {
	"104.21.85.125",
	"172.67.205.183",
};

/* Live chunked PCM upload session (one TLS socket for the whole utterance). */
static int stream_fd = -1;
static bool stream_active;
static uint32_t stream_sample_rate;
static uint32_t stream_bytes_sent;
static int64_t stream_started_ms;
/*
 * Record-only memo mode (see pendant_cloud_stream_set_memo in the header).
 * Two flags, not one: `pending` is what the caller wants NEXT, `open` is
 * what the current socket's already-transmitted header actually said. An
 * HTTP header cannot be amended after it is on the wire, so a mismatch
 * between the two is grounds for a reopen, exactly like a stale socket.
 */
static bool stream_memo_pending;
static bool stream_memo_open;
/*
 * Half-open chunked POST (headers sent, body pending) dies after idle:
 * dual-capture saw Live TX pump failed: -104 (ECONNRESET) ~79s after
 * prewarm with live_sent=0. Refresh idle sockets and re-validate at press.
 */
/*
 * Cloudflare kills the half-open chunked POST after ~20s idle, so refresh at
 * 10s — before death, not after — to shrink the dead-socket window a press
 * can land in. The press-time threshold sits above the refresh cadence so a
 * healthy just-refreshed socket (age ≤ ~13s with reopen time) is never torn
 * down at the exact moment the user starts speaking.
 */
#define STREAM_MAX_IDLE_MS 12000
#define STREAM_STALE_AT_START_MS 15000
/* Non-blocking TX: one in-flight HTTP chunk framing + body + CRLF. */
#define STREAM_PENDING_MAX 1200U
static uint8_t stream_pending[STREAM_PENDING_MAX];
static size_t stream_pending_len;
static size_t stream_pending_off;
static uint32_t stream_pump_calls;
static uint32_t stream_eagain_count;
/* Fully sent HTTP body chunks (not merely queued). */
static uint32_t stream_chunks_completed;

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

static void relay_cache_store(const struct sockaddr *addr)
{
	if (addr == NULL || addr->sa_family != AF_INET) {
		return;
	}
	relay_cached_ip = ((const struct sockaddr_in *)addr)->sin_addr;
	relay_cached_valid = true;
}

/* Seed cache from bootstrap anycast so the first call is never DNS-only. */
static void relay_cache_seed_bootstrap(void)
{
	struct in_addr ip;

	if (relay_cached_valid) {
		return;
	}
	if (inet_pton(AF_INET, relay_bootstrap_ips[0], &ip) == 1) {
		relay_cached_ip = ip;
		relay_cached_valid = true;
		printk("Relay DNS cache seeded with bootstrap %s\n",
		       relay_bootstrap_ips[0]);
	}
}

/*
 * Debug-only: make "no usable link" a repeatable condition.
 *
 * Powering the modem down is not enough on its own — ensure_lte_data_ready()
 * below deliberately resumes a suspended radio before every socket, which is
 * exactly right in production and exactly wrong when the point of the test is
 * that there is no link. This latch is checked in front of both the resume
 * and the socket, so an offline run stays offline until the test clears it.
 */
static bool link_blocked_for_test;

void pendant_cloud_block_link(bool blocked)
{
	link_blocked_for_test = blocked;
}

static int ensure_lte_data_ready(void)
{
	enum lte_lc_nw_reg_status status = LTE_LC_NW_REG_UNKNOWN;
	int error;

	if (link_blocked_for_test) {
		return -ENETDOWN;
	}
	if (radio_suspended) {
		error = pendant_cloud_resume_radio();
		if (error != 0) {
			printk("LTE resume before socket failed: %d\n", error);
			return error;
		}
	}

	error = lte_lc_nw_reg_status_get(&status);
	if (error != 0) {
		printk("LTE reg status query failed: %d (continuing)\n", error);
		return 0;
	}
	if (status == LTE_LC_NW_REG_REGISTERED_HOME ||
	    status == LTE_LC_NW_REG_REGISTERED_ROAMING) {
		return 0;
	}

	printk("LTE not registered (status=%d); reconnecting for relay DNS\n",
	       (int)status);
	error = lte_lc_connect();
	if (error != 0) {
		printk("LTE reconnect failed: %d\n", error);
	}
	return error;
}

/*
 * Try one IPv4 candidate with TLS, then plain TCP diagnostic on failure.
 * On success stores the address in the DNS cache and returns the fd (>=0).
 */
static int try_relay_ipv4(const struct in_addr *ip, unsigned int attempt,
			  unsigned int candidate_number,
			  const char *source, int64_t lat_socket_started,
			  int *last_error)
{
	struct sockaddr_in sa;
	char address[INET_ADDRSTRLEN] = "?";
	int fd;
	int error;
	int64_t lat_tls_started;

	memset(&sa, 0, sizeof(sa));
	sa.sin_family = AF_INET;
	sa.sin_port = htons(443);
	sa.sin_addr = *ip;
	(void)inet_ntop(AF_INET, ip, address, sizeof(address));
	printk("Relay DNS candidate %u.%u (%s): %s\n", attempt,
	       candidate_number, source, address);

	fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TLS_1_2);
	if (fd < 0) {
		*last_error = -errno;
		printk("Relay socket attempt %u.%u failed: %d errno=%d\n",
		       attempt, candidate_number, *last_error, errno);
		return *last_error;
	}

	lat_tls_started = k_uptime_get();
	error = configure_tls_socket(fd);
	if (error == 0 &&
	    connect(fd, (struct sockaddr *)&sa, sizeof(sa)) == 0) {
		printk("Relay TLS connected on attempt %u.%u (%s %s)\n",
		       attempt, candidate_number, source, address);
		printk("LAT tls_connect_ms=%lld socket_total_ms=%lld\n",
		       k_uptime_get() - lat_tls_started,
		       k_uptime_get() - lat_socket_started);
		relay_cache_store((struct sockaddr *)&sa);
		/* A working connect via bootstrap does not prove DNS is healthy. */
		if (strcmp(source, "dns") == 0) {
			relay_dns_unreliable = false;
		}
		return fd;
	}

	*last_error = error != 0 ? error : -errno;
	printk("Relay TLS attempt %u.%u failed: %d (errno=%d source=%s)\n",
	       attempt, candidate_number, *last_error, errno, source);
	close(fd);

	/* Distinguish routing failure from TLS/credential failure. */
	fd = socket(AF_INET, SOCK_STREAM, IPPROTO_TCP);
	if (fd >= 0) {
		error = connect(fd, (struct sockaddr *)&sa, sizeof(sa));
		printk("Relay plain TCP diagnostic %u.%u: %s (errno=%d)\n",
		       attempt, candidate_number,
		       error == 0 ? "connected" : "failed", errno);
		close(fd);
	}
	return *last_error;
}

static int try_relay_bootstrap_list(unsigned int attempt_tag,
				    int64_t lat_socket_started,
				    int *last_error,
				    bool skip_cached_ip)
{
	for (unsigned int i = 0U; i < ARRAY_SIZE(relay_bootstrap_ips); ++i) {
		struct in_addr ip;
		int error;

		if (inet_pton(AF_INET, relay_bootstrap_ips[i], &ip) != 1) {
			continue;
		}
		if (skip_cached_ip && relay_cached_valid &&
		    memcmp(&ip, &relay_cached_ip, sizeof(ip)) == 0) {
			continue;
		}
		error = try_relay_ipv4(&ip, attempt_tag, i + 1U, "bootstrap",
				       lat_socket_started, last_error);
		if (error >= 0) {
			return error;
		}
	}
	return *last_error < 0 ? *last_error : -EHOSTUNREACH;
}

static int open_relay_socket(void)
{
	struct addrinfo hints = {
		.ai_family = AF_INET,
		.ai_socktype = SOCK_STREAM,
	};
	int last_error = -EHOSTUNREACH;
	int ready;
	int64_t lat_socket_started = k_uptime_get();
	const unsigned int dns_attempts = relay_dns_unreliable ? 1U : 3U;

	/*
	 * Workers / CF publish several IPv4 addresses. Cellular routes can
	 * refuse one address while others work, and nRF DNS can wedge with
	 * -11/errno=115 — so try resolve, then cache, then bootstrap IPs.
	 * Prefer cache/bootstrap early: dual-capture logs show getaddrinfo
	 * failing immediately while Cloudflare anycast still answers TLS.
	 */
	if (link_blocked_for_test) {
		/* Debug latch, not a real failure mode — fail fast so the
		 * offline path runs at its true speed instead of spending a
		 * minute in DNS and bootstrap retries. */
		return -ENETDOWN;
	}
	relay_cache_seed_bootstrap();
	ready = ensure_lte_data_ready();
	if (ready != 0) {
		printk("LTE not ready before relay socket: %d\n", ready);
		/* Still attempt DNS/cache; reconnect may have partially worked. */
	}

	/* Fast path when modem DNS is known-bad: cache then bootstrap. */
	if (relay_dns_unreliable) {
		int error;

		printk("Relay DNS marked unreliable — trying cache/bootstrap first\n");
		if (relay_cached_valid) {
			error = try_relay_ipv4(&relay_cached_ip, 0U, 90U,
					       "cache", lat_socket_started,
					       &last_error);
			if (error >= 0) {
				return error;
			}
		}
		error = try_relay_bootstrap_list(0U, lat_socket_started,
						&last_error, true);
		if (error >= 0) {
			return error;
		}
	}

	for (unsigned int attempt = 1U; attempt <= dns_attempts; ++attempt) {
		struct addrinfo *result = NULL;
		int64_t lat_dns_started = k_uptime_get();
		int error = getaddrinfo(RELAY_HOSTNAME, RELAY_PORT,
					&hints, &result);
		int64_t lat_dns_ms = k_uptime_get() - lat_dns_started;
		bool dns_ok = (error == 0 && result != NULL);

		printk("LAT dns_ms=%lld attempt=%u error=%d errno=%d\n",
		       lat_dns_ms, attempt, error, errno);

		if (!dns_ok) {
			printk("Relay DNS attempt %u failed: %d errno=%d "
			       "(EAGAIN/EINPROGRESS often = wedged modem DNS)\n",
			       attempt, error, errno);
			last_error = error != 0 ? -EHOSTUNREACH : -ENOENT;
			relay_dns_unreliable = true;
		} else {
			unsigned int candidate_number = 0U;

			for (struct addrinfo *candidate = result;
			     candidate != NULL; candidate = candidate->ai_next) {
				struct in_addr ip;

				if (candidate->ai_family != AF_INET ||
				    candidate->ai_addr == NULL) {
					continue;
				}
				++candidate_number;
				ip = ((struct sockaddr_in *)candidate->ai_addr)
					     ->sin_addr;
				error = try_relay_ipv4(&ip, attempt,
						       candidate_number, "dns",
						       lat_socket_started,
						       &last_error);
				if (error >= 0) {
					freeaddrinfo(result);
					return error;
				}
			}
		}

		if (result != NULL) {
			freeaddrinfo(result);
		}

		/* After a DNS miss, try cache immediately (seeded bootstrap). */
		if (relay_cached_valid) {
			error = try_relay_ipv4(&relay_cached_ip, attempt, 90U,
					       "cache", lat_socket_started,
					       &last_error);
			if (error >= 0) {
				return error;
			}
		}

		/* First miss: bootstrap before multi-second DNS retries. */
		if (attempt == 1U || !dns_ok) {
			error = try_relay_bootstrap_list(attempt,
							lat_socket_started,
							&last_error, true);
			if (error >= 0) {
				return error;
			}
		}

		/* Once: hard reattach only if cache+bootstrap also failed. */
		if (attempt == 1U && dns_attempts > 1U) {
			printk("Relay DNS/bootstrap failed; forcing LTE reattach\n");
			(void)lte_lc_func_mode_set(LTE_LC_FUNC_MODE_OFFLINE);
			k_msleep(500);
			(void)lte_lc_func_mode_set(LTE_LC_FUNC_MODE_NORMAL);
			error = lte_lc_connect();
			radio_suspended = false;
			if (error != 0) {
				printk("LTE reattach failed: %d\n", error);
			}
		}

		if (attempt < dns_attempts) {
			k_sleep(K_MSEC(750));
		}
	}

	/* Final pass over every bootstrap IP (including the cached one). */
	{
		int error = try_relay_bootstrap_list(9U, lat_socket_started,
						    &last_error, false);

		if (error >= 0) {
			return error;
		}
	}

	printk("Relay socket open failed: last_error=%d dns_unreliable=%d "
	       "cache_valid=%d\n",
	       last_error, relay_dns_unreliable ? 1 : 0,
	       relay_cached_valid ? 1 : 0);
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
		path, RELAY_HOSTNAME, PENDANT_RELAY_BEARER,
		content_type, (unsigned long)content_length);

	if (length < 0 || (size_t)length >= sizeof(header)) {
		return -EOVERFLOW;
	}
	return send_all(fd, header, (size_t)length);
}

/*
 * Network (NITZ) clock from the LTE tower: "yy/MM/dd,hh:mm:ss±zz" with zz in
 * quarter-hours. Rides up as X-Device-Time so the cloud agent knows the
 * owner's local time even with every other device offline. Empty when the
 * carrier has not delivered time yet (relay validates before trusting).
 */
static void copy_device_time(char *out, size_t out_size)
{
	char cclk[64];
	const char *open_quote;
	const char *close_quote;
	size_t copy_length;

	out[0] = '\0';
	if (nrf_modem_at_cmd(cclk, sizeof(cclk), "AT+CCLK?") != 0) {
		return;
	}
	open_quote = strchr(cclk, '"');
	if (open_quote == NULL) {
		return;
	}
	close_quote = strchr(open_quote + 1, '"');
	if (close_quote == NULL) {
		return;
	}
	copy_length = (size_t)(close_quote - open_quote - 1);
	if (copy_length == 0U || copy_length >= out_size) {
		return;
	}
	memcpy(out, open_quote + 1, copy_length);
	out[copy_length] = '\0';
}

/* WebSocket transport plumbing — see pendant_cloud.h. */
int pendant_cloud_open_socket(void)
{
	return open_relay_socket();
}

const char *pendant_cloud_hostname(void)
{
	return RELAY_HOSTNAME;
}

/*
 * Named for the admin key it used to return; it now returns whatever bearer
 * this build authenticates with, device token first. pendant_ws.c puts it on
 * the /v1/pendant/converse upgrade — the one relay path that, before this
 * change, accepted the admin key and nothing else.
 */
const char *pendant_cloud_api_key(void)
{
	return PENDANT_RELAY_BEARER;
}

void pendant_cloud_copy_device_time(char *out, size_t out_size)
{
	copy_device_time(out, out_size);
}

/*
 * Chunked raw PCM voice command: one TLS session, HTTP/1.1 Transfer-Encoding
 * chunked, relay wraps s16le → WAV for STT/multimodal + Mac dispatch.
 * Content-Length is unknown at open time so capture can stream live.
 */
static int send_pendant_command_chunked_header(int fd, uint32_t sample_rate)
{
	char header[HTTP_HEADER_SIZE + 192];
	char device_time[32];
	char device_time_line[64];

	copy_device_time(device_time, sizeof(device_time));
	if (device_time[0] != '\0') {
		(void)snprintf(device_time_line, sizeof(device_time_line),
			       "X-Device-Time: %s\r\n", device_time);
	} else {
		device_time_line[0] = '\0';
	}
	/*
	 * Memo mode changes three things and nothing else: ?dispatch=0 (the
	 * relay transcribes and stores the capture but queues no Mac planner
	 * job), no X-Reply-Stream (a memo wants no spoken answer talking
	 * back at the owner), and X-Pendant-Mode: memo so the dashboard can
	 * label the capture. The audio wire format is identical.
	 */
	int length = snprintf(
		header, sizeof(header),
		"POST /v1/pendant/command?dispatch=%c HTTP/1.1\r\n"
		"Host: %s\r\n"
		"Authorization: Bearer %s\r\n"
		/* Opus at ~16 kbps: measured real-world LTE-M here sustains
		 * only 24-55 kbps each way, which starves even 64 kbps u-law.
		 * Wire format: 2-byte BE length-prefixed raw Opus packets. */
		"Content-Type: audio/opus\r\n"
		"Transfer-Encoding: chunked\r\n"
		"X-Device-Id: %s\r\n"
		"X-Audio-Format: opus-frames\r\n"
		"X-Sample-Rate: %u\r\n"
		"X-Audio-Channels: 1\r\n"
		"%s"
		/* Conversational reply: the relay transcodes the model's voice
		 * to length-prefixed Opus packets down this same connection. */
		"%s"
		"Connection: close\r\n\r\n",
		stream_memo_pending ? '0' : '1',
		RELAY_HOSTNAME, PENDANT_RELAY_BEARER,
		PENDANT_DEVICE_ID, sample_rate, device_time_line,
		stream_memo_pending ? "X-Pendant-Mode: memo\r\n"
				    : "X-Reply-Stream: opus\r\n");

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
	/* Honors memo mode too: the SD fallback for a green-button press must
	 * not resurrect the planner the press deliberately bypassed. */
	int length = snprintf(
		header, sizeof(header),
		"POST /v1/pendant/command?dispatch=%c HTTP/1.1\r\n"
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
		"%s"
		"Connection: close\r\n\r\n",
		stream_memo_pending ? '0' : '1',
		RELAY_HOSTNAME, PENDANT_RELAY_BEARER,
		(unsigned long)content_length, PENDANT_DEVICE_ID, sample_rate,
		(unsigned long)content_length,
		stream_memo_pending ? "X-Pendant-Mode: memo\r\n" : "");

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
	++stream_chunks_completed;
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

	/*
	 * A memo upload (?dispatch=0) is DEFINED by no Mac job existing, so
	 * the missing jobId that fails a command cycle is this cycle's
	 * success. The transcript above is still required — it is the proof
	 * the relay actually heard the memo, not merely accepted bytes.
	 */
	if (stream_memo_pending) {
		pendant_cloud_dispatch_result = 0;
		printk("Memo stored (transcribed, no Mac dispatch by design)\n");
		return 0;
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
		path, RELAY_HOSTNAME, PENDANT_RELAY_BEARER);

	if (length < 0 || (size_t)length >= sizeof(header)) {
		return -EOVERFLOW;
	}
	return send_all(fd, header, (size_t)length);
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

	/*
	 * open_relay_socket already retries DNS/cache/bootstrap. One extra
	 * outer attempt recovers from a transient TLS handshake glitch.
	 */
	fd = open_relay_socket();
	if (fd < 0) {
		printk("Cloud upload relay socket open failed (%d); retrying once\n",
		       fd);
		k_msleep(1000);
		fd = open_relay_socket();
	}
	if (fd < 0) {
		printk("Cloud upload could not open relay socket: %d\n", fd);
		return fd;
	}
	int64_t lat_upload_socket_done = k_uptime_get();
	printk("Cloud upload relay socket open after %lld ms (fd=%d)\n",
	       lat_upload_socket_done - lat_upload_started, fd);

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

/*
 * Offline store-and-forward delivery for the items that are NOT audio:
 * moment bookmarks and "the owner read their held alerts".
 *
 * These need no new endpoint and no relay change.  The pendant's relay
 * credential is a DEVICE principal, not the owner's admin key — probed
 * against the live relay, /v1/announcements and /v1/routines answer 403
 * ("this device is not allowed to use that route") while /v1/pendant/announce
 * and /v1/pendant/jobs/<id>/events answer 201 and 202.  So a marker is
 * delivered the same way every other pendant fact already is: create the job
 * row, then attach a pipeline event to it.  Both halves are code that was
 * already here and already proven on hardware.
 */
static int announce_marker_job(const char *kind)
{
	char body[192];
	int body_length;
	int fd;
	int error;

	announced_job_id[0] = '\0';
	if (!cloud_initialized) {
		return -ENOTCONN;
	}
	body_length = snprintf(body, sizeof(body),
			       "{\"deviceId\":\"" PENDANT_DEVICE_ID "\","
			       "\"pcmBytes\":0,"
			       "\"sampleRate\":0,"
			       "\"format\":\"%s\"}",
			       kind);
	if (body_length < 0 || (size_t)body_length >= sizeof(body)) {
		return -EOVERFLOW;
	}

	fd = open_relay_socket();
	if (fd < 0) {
		return fd;
	}
	error = send_http_post_header(fd, "/v1/pendant/announce",
				      "application/json",
				      (size_t)body_length);
	if (error == 0) {
		error = send_all(fd, body, (size_t)body_length);
	}
	if (error == 0) {
		error = receive_http_response(fd);
	}
	close(fd);
	if (error == 0) {
		error = copy_json_string_value("jobId", announced_job_id,
					       sizeof(announced_job_id));
		if (error != 0) {
			announced_job_id[0] = '\0';
		}
	}
	return error;
}

int pendant_cloud_post_marker(const char *stage, const char *label,
			      const char *detail)
{
	char path[192];
	char body[PENDANT_EVENT_BODY_SIZE];
	int path_length;
	int body_length;
	int fd;
	int error;

	error = announce_marker_job(stage);
	if (error != 0 || announced_job_id[0] == '\0') {
		printk("Marker announce failed: %d\n", error);
		return error != 0 ? error : -ENODATA;
	}

	path_length = snprintf(path, sizeof(path), "%s%s%s",
			       PENDANT_EVENT_PATH_PREFIX, announced_job_id,
			       PENDANT_EVENT_PATH_SUFFIX);
	if (path_length < 0 || (size_t)path_length >= sizeof(path)) {
		return -EOVERFLOW;
	}
	body_length = snprintf(body, sizeof(body),
			       "{\"stage\":\"%s\","
			       "\"status\":\"done\","
			       "\"label\":\"%s\","
			       "\"detail\":\"%s\","
			       "\"meta\":{"
			       "\"storage\":\"microSD\","
			       "\"origin\":\"pendant-offline-store\"}}",
			       stage, label, detail);
	if (body_length < 0 || (size_t)body_length >= sizeof(body)) {
		return -EOVERFLOW;
	}

	fd = open_relay_socket();
	if (fd < 0) {
		return fd;
	}
	error = send_http_post_header(fd, path, "application/json",
				      (size_t)body_length);
	if (error == 0) {
		error = send_all(fd, body, (size_t)body_length);
	}
	if (error == 0) {
		error = receive_http_response(fd);
	}
	close(fd);
	printk("Marker delivered: stage=%s job=%s result=%d\n", stage,
	       announced_job_id, error);
	return error;
}

/*
 * GET a small JSON document.  The response already lands in http_response[],
 * so the alert inbox reads the relay without owning a single byte of its own
 * — which is the difference between this feature fitting in the ~8.9 kB of
 * free RAM and not fitting at all.
 */
int pendant_cloud_get_json(const char *path)
{
	int fd;
	int error;

	if (!cloud_initialized) {
		return -ENOTCONN;
	}
	fd = open_relay_socket();
	if (fd < 0) {
		return fd;
	}
	error = send_http_get_header(fd, path);
	if (error == 0) {
		error = receive_http_response(fd);
	}
	close(fd);
	return error;
}

const char *pendant_cloud_response_body(void)
{
	const char *body = strstr(http_response, "\r\n\r\n");

	return body == NULL ? NULL : body + 4;
}

struct pcm_writer {
	struct fs_file_t *file;
	uint8_t output[FILE_READ_SIZE];
	size_t output_length;
	size_t written_bytes;
	bool first_batch_notified;
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

	/*
	 * First speech batch on device → solid LED (main hook). Never autoplay.
	 * User presses button 1 after this to start Bose/I2S playback.
	 */
	if (!writer->first_batch_notified &&
	    writer->written_bytes >= PENDANT_REPLY_FIRST_BATCH_BYTES) {
		writer->first_batch_notified = true;
		pendant_cloud_reply_first_batch = true;
		pendant_notify_reply_first_batch();
	}
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

	/* Tiny replies: still raise LED if body finished under threshold. */
	if (!writer.first_batch_notified && writer.written_bytes > 0U) {
		writer.first_batch_notified = true;
		pendant_cloud_reply_first_batch = true;
		pendant_notify_reply_first_batch();
	}

	pendant_cloud_reply_pcm_bytes = (uint32_t)writer.written_bytes;
	printk("Downloaded %u bytes of Mac agent speech (%s)%s\n",
	       pendant_cloud_reply_pcm_bytes,
	       is_opus ? "Ogg Opus" : "PCM fallback",
	       pendant_cloud_reply_first_batch ? " [LED already solid]" : "");
	return 0;
}

int pendant_cloud_init(void)
{
	int error;

	if (cloud_initialized) {
		return 0;
	}
	if (PENDANT_RELAY_BEARER[0] == '\0') {
		printk("No relay credential: set PENDANT_RELAY_DEVICE_TOKEN "
		       "(preferred) or PENDANT_RELAY_API_KEY in secrets.conf\n");
		pendant_cloud_init_result = -EACCES;
		return pendant_cloud_init_result;
	}
	/*
	 * Says WHICH credential this image carries, without printing either.
	 * A pendant still on the shared admin key is otherwise indistinguishable
	 * from a migrated one in every log line it will ever emit.
	 */
	printk("Relay credential: %s\n",
	       CONFIG_PENDANT_RELAY_DEVICE_TOKEN[0] != '\0'
		       ? "scoped device token (nrf_pendant)"
		       : "SHARED ADMIN KEY - pair a device token and rebuild");

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
	stream_chunks_completed = 0U;
}

/*
 * True when the prewarmed fd still looks usable. Peer close/RST shows up as
 * POLLHUP/POLLERR. Any POLLIN on a half-open chunked POST (headers sent, body
 * not finished) means FIN/RST/unexpected response — do not reuse.
 */
static bool stream_socket_ok(void)
{
	struct zsock_pollfd pfd;
	int n;

	if (stream_fd < 0) {
		return false;
	}

	memset(&pfd, 0, sizeof(pfd));
	pfd.fd = stream_fd;
	pfd.events = ZSOCK_POLLIN;
	n = zsock_poll(&pfd, 1, 0);
	if (n < 0) {
		return false;
	}
	if ((pfd.revents & (ZSOCK_POLLIN | ZSOCK_POLLERR | ZSOCK_POLLHUP |
			    ZSOCK_POLLNVAL)) != 0) {
		return false;
	}
	return true;
}

static bool stream_is_conn_death(int error)
{
	return error == -ECONNRESET || error == -EPIPE || error == -ENOTCONN ||
	       error == -ECONNABORTED || error == -ENETRESET ||
	       error == -EHOSTUNREACH || error == -ENETUNREACH ||
	       error == -ETIMEDOUT;
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
		printk("Live PCM stream socket failed (%d); retrying once\n",
		       error);
		k_msleep(500);
		error = open_relay_socket();
	}
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
	/* The header just sent is the mode this socket is stuck with. */
	stream_memo_open = stream_memo_pending;
	stream_bytes_sent = 0U;
	stream_pending_len = 0U;
	stream_pending_off = 0U;
	stream_chunks_completed = 0U;
	/* stream_started_ms set above at open start — age for stale checks. */
	printk("Live PCM stream open: sample_rate=%u memo=%d header_ms=%lld\n",
	       sample_rate, stream_memo_open ? 1 : 0,
	       k_uptime_get() - stream_started_ms);
	return 0;
}

void pendant_cloud_stream_set_memo(bool memo)
{
	stream_memo_pending = memo;
}

/*
 * Drop a dead/stale half-open session and open a fresh TLS+chunked stream.
 * Clears any in-flight pending frame (caller must tolerate losing that stage).
 */
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

static int stream_reopen_fresh(uint32_t sample_rate, const char *reason)
{
	printk("Live PCM stream reopen (%s)\n",
	       reason != NULL ? reason : "refresh");
	if (stream_fd >= 0) {
		close(stream_fd);
	}
	stream_reset_state();
	stream_reset_job_state();
	return stream_open_chunked(sample_rate);
}

/*
 * Open TLS + chunked headers while the UI is idle so Button 1 never waits on
 * the modem handshake. Safe to call repeatedly. Refreshes aged/dead sockets so
 * a long wait between prewarm and press does not leave a RST-pending fd.
 */
int pendant_cloud_stream_prewarm(uint32_t sample_rate)
{
	int error;

	if (stream_active && stream_sample_rate == sample_rate &&
	    stream_memo_open == stream_memo_pending) {
		int64_t age_ms = k_uptime_get() - stream_started_ms;
		bool ok = stream_socket_ok();

		if (age_ms < STREAM_MAX_IDLE_MS && ok) {
			return 0;
		}
		printk("Live PCM idle refresh (age_ms=%lld socket_ok=%d)\n",
		       age_ms, ok ? 1 : 0);
		error = stream_reopen_fresh(sample_rate, "idle_refresh");
	} else {
		if (stream_active) {
			pendant_cloud_stream_abort();
		}
		stream_reset_job_state();
		error = stream_open_chunked(sample_rate);
	}
	if (error == 0) {
		printk("Live PCM stream prewarmed (idle)\n");
	}
	return error;
}

/*
 * Call at button press before I2S starts. Reopens if the idle prewarm is
 * stale or the modem socket already shows POLLHUP/RST.
 */
int pendant_cloud_stream_ensure(uint32_t sample_rate)
{
	int error;

	/* A mode mismatch (memo press against a prewarmed dispatch header, or
	 * the reverse) reopens exactly like a stale socket: the header is
	 * already on the wire and cannot be amended. */
	if (stream_active && stream_sample_rate == sample_rate &&
	    stream_memo_open == stream_memo_pending) {
		int64_t age_ms = k_uptime_get() - stream_started_ms;
		bool ok = stream_socket_ok();

		if (age_ms < STREAM_STALE_AT_START_MS && ok) {
			stream_reset_job_state();
			printk("Live PCM stream ready at press (age_ms=%lld)\n",
			       age_ms);
			return 0;
		}
		printk("Live PCM stream not ready at press "
		       "(age_ms=%lld socket_ok=%d); reopening\n",
		       age_ms, ok ? 1 : 0);
		error = stream_reopen_fresh(sample_rate, "press_ensure");
	} else {
		if (stream_active) {
			pendant_cloud_stream_abort();
		}
		stream_reset_job_state();
		error = stream_open_chunked(sample_rate);
	}
	if (error == 0) {
		printk("Live PCM stream ensured at press\n");
	} else {
		printk("Live PCM stream ensure failed: %d\n", error);
	}
	return error;
}

int pendant_cloud_stream_pump(uint32_t budget_ms)
{
	int64_t deadline;
	int error;

	++stream_pump_calls;
	if (!stream_active || stream_fd < 0) {
		return -ENOTCONN;
	}
	if (stream_pending_len == 0U) {
		return 0;
	}
	deadline = k_uptime_get() + (int64_t)budget_ms;
	error = stream_pending_pump(deadline);
	/*
	 * Do not TLS-reopen here: I2S only has ~123 ms of RX slab headroom and
	 * a modem handshake can take hundreds of ms to seconds. Stale sockets
	 * are handled by idle prewarm refresh + ensure-at-press.
	 */
	if (error != 0 && error != -EAGAIN && stream_is_conn_death(error)) {
		printk("Live PCM pump conn death: %d chunks_done=%u "
		       "pending_off=%u (SD backup if armed)\n",
		       error, stream_chunks_completed,
		       (unsigned int)stream_pending_off);
	}
	return error;
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

/*
 * Inline (conversational) reply: after the terminal upload chunk the relay
 * answers with the model's spoken PCM on this same connection. State below
 * lets main pull the dechunked body at playback pace.
 */
static bool reply_inline_active;
static bool reply_inline_chunked;
static bool reply_inline_eof;
static size_t reply_inline_fixed_remaining;
static unsigned long reply_chunk_remaining;
static struct http_body_reader reply_reader;
/* Chunk-size-line accumulator persists across -EAGAIN (non-blocking play). */
static char reply_sizeline[24];
static size_t reply_sizeline_length;

static void header_copy_value(const char *header, const char *name,
			      char *out, size_t out_size)
{
	out[0] = '\0';
	const char *at = header_find_ci(header, name);

	if (at == NULL) {
		return;
	}
	at += strlen(name);
	while (*at == ' ') {
		++at;
	}
	size_t index = 0U;
	while (at[index] != '\0' && at[index] != '\r' && at[index] != '\n' &&
	       index + 1U < out_size) {
		out[index] = at[index];
		++index;
	}
	out[index] = '\0';
}

/*
 * Read the response status line + headers from the live stream socket.
 * Returns PENDANT_CLOUD_REPLY_INLINE when an audio/pcm body follows (socket
 * stays open for pendant_cloud_reply_read), 0 for a classic JSON response
 * (rest of the body is accumulated into http_response as before), <0 error.
 */
static int receive_stream_response_start(int fd)
{
	size_t offset = 0U;
	char *body = NULL;

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
		http_response[offset] = '\0';
		body = strstr(http_response, "\r\n\r\n");
		if (body != NULL) {
			break;
		}
	}
	http_response[offset] = '\0';

	const char *status = strchr(http_response, ' ');

	if (status == NULL) {
		return -EBADMSG;
	}
	pendant_cloud_last_http_status = atoi(status + 1);

	const bool inline_audio =
		body != NULL && pendant_cloud_last_http_status >= 200 &&
		pendant_cloud_last_http_status < 300 &&
		(header_find_ci(http_response, "Content-Type: audio/pcm") !=
			 NULL ||
		 header_find_ci(http_response, "Content-Type: audio/opus") !=
			 NULL);

	if (inline_audio) {
		const bool ulaw_reply =
			header_find_ci(http_response,
				       "Content-Type: audio/pcmu") != NULL;
		const bool opus_reply =
			header_find_ci(http_response,
				       "Content-Type: audio/opus") != NULL;
		size_t rate = header_decimal_value(http_response,
						   "X-Audio-Sample-Rate:");

		pendant_cloud_reply_format =
			opus_reply ? PENDANT_CLOUD_AUDIO_OPUS_FRAMES
			: ulaw_reply ? PENDANT_CLOUD_AUDIO_G711_ULAW
				     : PENDANT_CLOUD_AUDIO_PCM_S16LE;
		if (opus_reply) {
			/* Wire packets carry 16 kHz speech; the on-device
			 * decoder outputs 24 kHz regardless of this header. */
			pendant_cloud_reply_sample_rate = 24000U;
		} else if (rate != 0U) {
			pendant_cloud_reply_sample_rate = (uint32_t)rate;
		} else if (ulaw_reply) {
			/* G.711 is defined at 8 kHz. */
			pendant_cloud_reply_sample_rate = 8000U;
		}
		header_copy_value(http_response, "X-Job-Id:", mac_job_id,
				  sizeof(mac_job_id));
		reply_inline_chunked =
			header_find_ci(http_response,
				       "Transfer-Encoding: chunked") != NULL;
		reply_inline_fixed_remaining = header_decimal_value(
			http_response, "Content-Length:");
		body += 4;
		reply_reader = (struct http_body_reader){
			.fd = fd,
			.initial = (const uint8_t *)body,
			.initial_length =
				offset - (size_t)(body - http_response),
		};
		reply_chunk_remaining = 0U;
		reply_sizeline_length = 0U;
		reply_inline_eof = false;
		reply_inline_active = true;
		printk("Inline reply stream: rate=%u chunked=%u job=%s\n",
		       pendant_cloud_reply_sample_rate,
		       reply_inline_chunked ? 1U : 0U,
		       mac_job_id[0] != '\0' ? mac_job_id : "(pending)");
		return PENDANT_CLOUD_REPLY_INLINE;
	}

	/* Classic JSON: read the remainder until close, as before. */
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
	printk("Relay HTTP status: %d, response bytes: %u\n",
	       pendant_cloud_last_http_status, (uint32_t)offset);
	if (pendant_cloud_last_http_status < 200 ||
	    pendant_cloud_last_http_status >= 300) {
		const char *error_body = strstr(http_response, "\r\n\r\n");

		printk("Relay error: %s\n",
		       error_body == NULL ? "(no body)" : error_body + 4);
		return -EREMOTE;
	}
	return 0;
}

int pendant_cloud_reply_read(void *buffer, size_t length)
{
	uint8_t *out = buffer;
	size_t filled = 0U;

	if (!reply_inline_active) {
		return -ENOTCONN;
	}
	if (reply_inline_eof) {
		return 0;
	}

	while (filled < length) {
		uint8_t value;
		int status;

		if (reply_inline_chunked) {
			if (reply_chunk_remaining == 0U) {
				/* Chunk-size line (plus closing CRLF of the
				 * previous chunk when one was consumed). */
				bool line_done = false;

				while (!line_done) {
					status = http_body_next(&reply_reader,
								&value);
					if (status == -EAGAIN) {
						return filled > 0U
							       ? (int)filled
							       : -EAGAIN;
					}
					if (status <= 0) {
						reply_inline_eof = true;
						return filled > 0U
							       ? (int)filled
							       : status;
					}
					if (value == '\n') {
						line_done =
							reply_sizeline_length >
							0U;
						continue;
					}
					if (value == '\r') {
						continue;
					}
					if (reply_sizeline_length + 1U >=
					    sizeof(reply_sizeline)) {
						reply_inline_eof = true;
						return -EOVERFLOW;
					}
					reply_sizeline[reply_sizeline_length++] =
						(char)value;
				}
				reply_sizeline[reply_sizeline_length] = '\0';

				char *end = NULL;
				reply_chunk_remaining =
					strtoul(reply_sizeline, &end, 16);
				const bool bad_size = end == reply_sizeline;

				reply_sizeline_length = 0U;
				if (bad_size) {
					reply_inline_eof = true;
					return -EBADMSG;
				}
				if (reply_chunk_remaining == 0U) {
					reply_inline_eof = true;
					return (int)filled;
				}
			}
			status = http_body_next(&reply_reader, &value);
			if (status == -EAGAIN) {
				return filled > 0U ? (int)filled : -EAGAIN;
			}
			if (status <= 0) {
				reply_inline_eof = true;
				return filled > 0U ? (int)filled : status;
			}
			--reply_chunk_remaining;
			out[filled++] = value;
		} else {
			if (reply_inline_fixed_remaining == 0U) {
				/* Close-delimited body: read until EOF. */
			}
			status = http_body_next(&reply_reader, &value);
			if (status == -EAGAIN) {
				return filled > 0U ? (int)filled : -EAGAIN;
			}
			if (status <= 0) {
				reply_inline_eof = true;
				/* status==0 is clean EOF; a socket error with
				 * nothing buffered must NOT read as an empty
				 * reply played "successfully". */
				return filled > 0U ? (int)filled : status;
			}
			out[filled++] = value;
			if (reply_inline_fixed_remaining > 0U &&
			    --reply_inline_fixed_remaining == 0U) {
				reply_inline_eof = true;
				return (int)filled;
			}
		}
	}
	return (int)filled;
}

/* Playback drains the reply without blocking so the jitter ring, not the
 * 85 ms I2S queue, absorbs LTE burst gaps. */
int pendant_cloud_reply_set_nonblocking(bool enable)
{
	if (stream_fd < 0) {
		return -ENOTCONN;
	}
	return socket_set_nonblock(stream_fd, enable);
}

void pendant_cloud_reply_stream_close(void)
{
	reply_inline_active = false;
	reply_inline_eof = true;
	if (stream_fd >= 0) {
		close(stream_fd);
		stream_fd = -1;
	}
	stream_active = false;
	stream_reset_state();
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
	{
		/* Header wait bounds SERVER THINK TIME (model turn + tool run
		 * + first speech byte), not link liveness — a web_search chain
		 * alone can pass 15s. Body reads tighten to 15s below once
		 * audio is actually streaming. */
		struct timeval receive_timeout = {
			.tv_sec = 30,
			.tv_usec = 0,
		};
		(void)setsockopt(stream_fd, SOL_SOCKET, SO_RCVTIMEO,
				 &receive_timeout, sizeof(receive_timeout));
	}
	error = receive_stream_response_start(stream_fd);
	printk("LAT live_stream server_wait_ms=%lld total_ms=%lld "
	       "body_bytes=%u HTTP=%d\n",
	       k_uptime_get() - body_done_ms,
	       k_uptime_get() - stream_started_ms, stream_bytes_sent,
	       pendant_cloud_last_http_status);

	if (error == PENDANT_CLOUD_REPLY_INLINE) {
		/*
		 * The model's spoken reply is arriving on this socket; main
		 * pulls it via pendant_cloud_reply_read and closes with
		 * pendant_cloud_reply_stream_close. The Mac job (if any) was
		 * dispatched server-side from the tool call. Deltas flow
		 * continuously once speech starts, so a mid-body recv may
		 * use a tighter bound than the header wait above.
		 */
		struct timeval body_timeout = {
			.tv_sec = 15,
			.tv_usec = 0,
		};
		(void)setsockopt(stream_fd, SOL_SOCKET, SO_RCVTIMEO,
				 &body_timeout, sizeof(body_timeout));
		pendant_cloud_transcribe_result = 0;
		pendant_cloud_dispatch_result = 0;
		return PENDANT_CLOUD_REPLY_INLINE;
	}

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
	pendant_cloud_reply_first_batch = false;
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

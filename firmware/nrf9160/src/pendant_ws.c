#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/kernel.h>
#include <zephyr/net/socket.h>
#include <zephyr/net/websocket.h>

#include "pendant_cloud.h"
#include "pendant_ws.h"

#define WS_CONNECT_TIMEOUT_MS 12000
/*
 * Bounds EVERY send on the socket, including the CLOSE frame that
 * websocket_disconnect emits — without it a dead socket blocks the caller
 * forever (review finding). All WS calls run on the ws_io thread (or under
 * ws_lock), so a bounded block is acceptable there.
 */
#define WS_SEND_TIMEOUT_MS 1500
/* A started (fragmented) message must complete within this window. */
#define WS_MESSAGE_DEADLINE_MS 2000
#define WS_URL "/v1/pendant/converse"
/*
 * Handshake scratch: websocket_connect() builds the upgrade request and
 * parses the 101 response in this buffer. It must outlive the connection
 * per the Zephyr API contract, so it is static, not stack.
 */
static uint8_t ws_handshake_buf[1024];
static int ws_sock = -1; /* underlying TLS socket */
static int ws_fd = -1;   /* websocket descriptor from websocket_connect() */

/* Extra upgrade headers: bearer auth, terminated per http_client rules. */
static const char *ws_extra_headers[3];
static char ws_auth_header[192];

static int ws_connect_cb(int ws, struct http_request *req, void *user_data)
{
	ARG_UNUSED(ws);
	ARG_UNUSED(req);
	ARG_UNUSED(user_data);
	return 0;
}

int pendant_ws_connect(void)
{
	struct websocket_request request;
	struct timeval send_timeout = {
		.tv_sec = WS_SEND_TIMEOUT_MS / 1000,
		.tv_usec = (WS_SEND_TIMEOUT_MS % 1000) * 1000,
	};
	int64_t started_at = k_uptime_get();
	int sock;
	int fd;

	if (ws_fd >= 0) {
		return 0;
	}

	sock = pendant_cloud_open_socket();
	if (sock < 0) {
		return sock;
	}
	(void)zsock_setsockopt(sock, SOL_SOCKET, SO_SNDTIMEO, &send_timeout,
			       sizeof(send_timeout));

	snprintf(ws_auth_header, sizeof(ws_auth_header),
		 "Authorization: Bearer %s\r\n", pendant_cloud_api_key());
	ws_extra_headers[0] = ws_auth_header;
	ws_extra_headers[1] = "X-Device-Id: nrf9160-pendant\r\n";
	ws_extra_headers[2] = NULL;

	memset(&request, 0, sizeof(request));
	request.host = pendant_cloud_hostname();
	request.url = WS_URL;
	request.optional_headers = ws_extra_headers;
	request.cb = ws_connect_cb;
	request.tmp_buf = ws_handshake_buf;
	request.tmp_buf_len = sizeof(ws_handshake_buf);

	fd = websocket_connect(sock, &request, WS_CONNECT_TIMEOUT_MS, NULL);
	if (fd < 0) {
		printk("WS connect failed: %d (handshake %lld ms)\n", fd,
		       k_uptime_get() - started_at);
		zsock_close(sock);
		return fd;
	}

	ws_sock = sock;
	ws_fd = fd;
	printk("WS connected in %lld ms\n", k_uptime_get() - started_at);
	return 0;
}

void pendant_ws_close(void)
{
	if (ws_fd >= 0) {
		/* Bounded by SO_SNDTIMEO for the CLOSE frame. */
		(void)websocket_disconnect(ws_fd);
		ws_fd = -1;
	}
	/*
	 * websocket_disconnect() releases the websocket context but NOT the
	 * transport socket it rode on — leaving it open leaks one of the
	 * modem's few socket slots per reconnect (review finding).
	 */
	if (ws_sock >= 0) {
		zsock_close(ws_sock);
		ws_sock = -1;
	}
}

bool pendant_ws_connected(void)
{
	return ws_fd >= 0;
}

static int ws_send(const uint8_t *data, size_t length,
		   enum websocket_opcode opcode)
{
	int sent;

	if (ws_fd < 0) {
		return -ENOTCONN;
	}
	sent = websocket_send_msg(ws_fd, data, length, opcode, true, true,
				  WS_SEND_TIMEOUT_MS);
	if (sent < 0) {
		printk("WS send failed: %d\n", sent);
		pendant_ws_close();
		return sent;
	}
	if ((size_t)sent != length) {
		/* A short frame write corrupts the WS stream irrecoverably. */
		printk("WS short send: %d of %u\n", sent,
		       (unsigned int)length);
		pendant_ws_close();
		return -EIO;
	}
	return 0;
}

int pendant_ws_send_binary(const uint8_t *data, size_t length)
{
	return ws_send(data, length, WEBSOCKET_OPCODE_DATA_BINARY);
}

int pendant_ws_send_text(const char *json)
{
	return ws_send((const uint8_t *)json, strlen(json),
		       WEBSOCKET_OPCODE_DATA_TEXT);
}

int pendant_ws_ping(void)
{
	return ws_send(NULL, 0U, WEBSOCKET_OPCODE_PING);
}

int pendant_ws_recv(uint8_t *buffer, size_t capacity, bool *is_text)
{
	uint32_t message_type = 0U;
	uint64_t remaining = 0U;
	size_t offset = 0U;
	bool text_flag = false;
	int64_t deadline = 0;

	if (ws_fd < 0) {
		return -ENOTCONN;
	}

	/*
	 * One websocket message may arrive fragmented; loop until FINAL with
	 * remaining == 0. The first read is non-blocking (poll); once a
	 * message has started, short blocking reads finish it under an
	 * overall deadline so a stalled peer cannot pin this thread. The
	 * TEXT flag is only present on the FIRST fragment (continuations
	 * carry opcode 0), so it is latched here.
	 */
	for (;;) {
		int received = websocket_recv_msg(ws_fd, buffer + offset,
						  capacity - offset,
						  &message_type, &remaining,
						  offset == 0U ? 0 : 200);
		if (received == -EAGAIN || received == -EWOULDBLOCK) {
			if (offset == 0U) {
				return 0;
			}
			if (k_uptime_get() > deadline) {
				printk("WS fragmented message timed out\n");
				pendant_ws_close();
				return -ETIMEDOUT;
			}
			continue;
		}
		if (received < 0) {
			if (offset == 0U &&
			    (received == -ENOTCONN ||
			     received == -ECONNRESET || received == -EPIPE)) {
				pendant_ws_close();
				return -ENOTCONN;
			}
			printk("WS recv failed: %d\n", received);
			pendant_ws_close();
			return received;
		}
		if (offset == 0U && deadline == 0) {
			deadline = k_uptime_get() + WS_MESSAGE_DEADLINE_MS;
			text_flag = (message_type & WEBSOCKET_FLAG_TEXT) != 0U;
		}

		if ((message_type & WEBSOCKET_FLAG_PING) != 0U) {
			(void)ws_send(buffer + offset, (size_t)received,
				      WEBSOCKET_OPCODE_PONG);
			if (offset == 0U) {
				deadline = 0;
			}
			continue;
		}
		if ((message_type & WEBSOCKET_FLAG_PONG) != 0U) {
			if (offset == 0U) {
				deadline = 0;
			}
			continue;
		}
		if ((message_type & WEBSOCKET_FLAG_CLOSE) != 0U) {
			pendant_ws_close();
			return -ENOTCONN;
		}

		offset += (size_t)received;
		if (remaining == 0U &&
		    (message_type & WEBSOCKET_FLAG_FINAL) != 0U) {
			if (offset == 0U) {
				/* Empty data frame (e.g. zero-length text):
				 * nothing for the caller. */
				return 0;
			}
			if (is_text != NULL) {
				*is_text = text_flag;
			}
			return (int)offset;
		}
		if (offset >= capacity) {
			printk("WS message larger than %u — dropping tail\n",
			       (unsigned int)capacity);
			pendant_ws_close();
			return -EMSGSIZE;
		}
		if (deadline != 0 && k_uptime_get() > deadline) {
			printk("WS fragmented message timed out\n");
			pendant_ws_close();
			return -ETIMEDOUT;
		}
	}
}

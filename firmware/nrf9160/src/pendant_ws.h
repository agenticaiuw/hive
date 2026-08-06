#ifndef PENDANT_WS_H_
#define PENDANT_WS_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Full-duplex conversation transport: one WebSocket over the modem's
 * offloaded TLS socket to the relay's /v1/pendant/converse endpoint.
 *
 * Uplink and downlink audio are binary frames of length-prefixed Opus
 * packets (2-byte BE — the same wire format as the chunked-HTTP body).
 * Control is JSON text frames: up {start|stop|ping}, down
 * {started|pong|flush|end}. Every downlink frame stays under the modem's
 * ~2 KiB TLS record limit; the relay guarantees that.
 */
int pendant_ws_connect(void);
void pendant_ws_close(void);
bool pendant_ws_connected(void);

/* Send a binary audio frame. 0 on success, -EAGAIN if the socket would
 * block (caller retries with the same bytes), other negatives are fatal. */
int pendant_ws_send_binary(const uint8_t *data, size_t length);

/* Send a JSON control frame (start/stop/ping). */
int pendant_ws_send_text(const char *json);

/*
 * Non-blocking receive of ONE message (reassembles fragments internally).
 * Returns payload byte count (0 = nothing pending), -ENOTCONN when the
 * peer closed, other negatives on error. *is_text tells control from audio.
 */
int pendant_ws_recv(uint8_t *buffer, size_t capacity, bool *is_text);

/* Keepalive for the idle (non-conversing) socket. */
int pendant_ws_ping(void);

#endif /* PENDANT_WS_H_ */

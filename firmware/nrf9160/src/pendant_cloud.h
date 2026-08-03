#ifndef PENDANT_CLOUD_H_
#define PENDANT_CLOUD_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#define PENDANT_CLOUD_REPLY_AUDIO_PATH "/SD:/agent_reply.audio"
#define PENDANT_CLOUD_REPLY_PCM_PATH "/SD:/agent_reply.pcm"
#define PENDANT_CLOUD_REPLY_SAMPLE_RATE 24000U

enum pendant_cloud_audio_format {
	PENDANT_CLOUD_AUDIO_UNKNOWN = 0,
	PENDANT_CLOUD_AUDIO_PCM_S16LE,
	PENDANT_CLOUD_AUDIO_OGG_OPUS,
};

/*
 * Initialize the nRF9160 modem, provision the relay's CA certificate, and
 * attach to LTE. Call once at boot before attempting an upload.
 */
int pendant_cloud_init(void);

/*
 * Fully power down modem RF while I2S DMA is active, then reconnect.
 * Latency-first voice path no longer uses suspend/resume; kept for diagnostics.
 */
int pendant_cloud_suspend_radio(void);
int pendant_cloud_resume_radio(void);

int pendant_cloud_announce_recording(uint32_t pcm_bytes,
				     uint32_t sample_rate);

/*
 * Live chunked PCM upload (preferred path). Prewarm while idle so Button 1
 * never waits on TLS. During capture, stream_write queues one HTTP chunk and
 * stream_pump advances non-blocking sends under a time budget so I2S never
 * blocks on LTE. If live TX fails, main falls back to upload_recording().
 *
 * Idle half-open chunked sockets go stale (CF/NAT/modem → ECONNRESET/-104).
 * prewarm refreshes aged sockets; ensure re-validates at press; pump recovers
 * once on first-body connection death so mid-press live bytes still flow.
 */
int pendant_cloud_stream_prewarm(uint32_t sample_rate);
/* Re-validate/reopen prewarmed stream at button press (before I2S starts). */
int pendant_cloud_stream_ensure(uint32_t sample_rate);
int pendant_cloud_stream_begin(uint32_t sample_rate);
int pendant_cloud_stream_write(const void *data, size_t length);
int pendant_cloud_stream_pump(uint32_t budget_ms);
int pendant_cloud_stream_end(void);
void pendant_cloud_stream_abort(void);
bool pendant_cloud_stream_active(void);
bool pendant_cloud_stream_has_pending(void);
uint32_t pendant_cloud_stream_bytes_sent(void);

/*
 * Single-shot raw PCM file upload (SD fallback when live TX is unavailable).
 * open_relay_socket() retries DNS, uses a cached IP, then Cloudflare bootstrap.
 */
int pendant_cloud_upload_recording(const char *audio_path,
				   uint32_t source_pcm_bytes,
				   uint32_t sample_rate);

int pendant_cloud_wait_for_agent_reply(const char *pcm_path);
int pendant_cloud_report_playback_started(void);
int pendant_cloud_report_playback_result(int playback_result);
int pendant_cloud_set_job_id_for_diagnostic(const char *job_id);

/*
 * First speech bytes written to microSD (not autoplay). Main raises solid LED
 * so the user can press button 1 while the rest of the reply is still arriving.
 */
#define PENDANT_REPLY_FIRST_BATCH_BYTES 2048U
extern volatile bool pendant_cloud_reply_first_batch;
/* Implemented in main.c — turn LED solid; never start playback here. */
void pendant_notify_reply_first_batch(void);

extern volatile int pendant_cloud_init_result;
extern volatile int pendant_cloud_transcribe_result;
extern volatile int pendant_cloud_dispatch_result;
extern volatile int pendant_cloud_reply_result;
extern volatile int pendant_cloud_last_http_status;
extern volatile uint32_t pendant_cloud_uploaded_pcm_bytes;
extern volatile uint32_t pendant_cloud_reply_pcm_bytes;
extern volatile uint32_t pendant_cloud_reply_sample_rate;
extern volatile enum pendant_cloud_audio_format pendant_cloud_reply_format;

#endif /* PENDANT_CLOUD_H_ */

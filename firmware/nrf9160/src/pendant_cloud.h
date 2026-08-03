#ifndef PENDANT_CLOUD_H_
#define PENDANT_CLOUD_H_

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
 * Disable LTE RF while the PDM microphone is active, then reconnect after the
 * recording is safely on microSD. These calls are no-ops before cloud init.
 */
int pendant_cloud_suspend_radio(void);
int pendant_cloud_resume_radio(void);

/*
 * While the user is still speaking, open a TLS session to the relay on a
 * background thread so button-release only pays for the HTTP body. Safe to
 * call multiple times; cancel() drops a held socket.
 */
void pendant_cloud_prewarm_start(void);
void pendant_cloud_prewarm_cancel(void);

/*
 * Optional early dashboard visibility. Prefer the single-shot
 * pendant_cloud_upload_recording path for latency; announce costs a full
 * TLS handshake of its own.
 */
int pendant_cloud_announce_recording(uint32_t pcm_bytes,
				     uint32_t sample_rate);

/*
 * Single-shot upload: one TLS session POSTs raw Ogg Opus to
 * /v1/pendant/command?dispatch=1. The relay runs STT (or multimodal audio
 * plan) and queues the Mac agent job. Replaces the old
 * announce + /v1/transcribe + /v1/mac/plan triple handshake.
 */
int pendant_cloud_upload_recording(const char *audio_path,
				   uint32_t source_pcm_bytes,
				   uint32_t sample_rate);

/*
 * Poll the queued Mac job, decode the HTTP response framing, and write the
 * Ogg Opus (or legacy PCM fallback) body into the supplied microSD path.
 */
int pendant_cloud_wait_for_agent_reply(const char *pcm_path);

/*
 * Best-effort observability hooks for the local pipeline dashboard. These
 * report playback progress through the relay without changing playback
 * success or failure.
 */
int pendant_cloud_report_playback_started(void);
int pendant_cloud_report_playback_result(int playback_result);

/* Select an existing completed job for the optional boot-time diagnostic. */
int pendant_cloud_set_job_id_for_diagnostic(const char *job_id);

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

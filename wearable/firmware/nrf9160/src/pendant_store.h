#ifndef PENDANT_STORE_H_
#define PENDANT_STORE_H_

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

/*
 * Offline store-and-forward for the worn device.
 *
 * WHY THIS LIVES IN FIRMWARE AND NOWHERE ELSE
 * -------------------------------------------
 * Every other node in this system needs the network to be useful: the relay
 * is the network, the Mac planner is asleep with the lid closed, the browser
 * tier and the shell tier are processes on a machine the owner is not
 * wearing.  The pendant is the only node that is simultaneously ON THE
 * OWNER'S BODY and holding non-volatile storage.  So the one capability that
 * cannot be pushed up a layer is: be present and remember, with the link
 * down, across a power cycle.
 *
 * FOUR RECON AGENTS, TWO MECHANISMS
 * ---------------------------------
 * Four independent reconnaissance rounds asked for
 * offline_voice_memo_store_and_forward, offline_moment_bookmark,
 * offline_thought_capture and offline_alert_inbox.  Read as data structures
 * rather than as features, those are not four things, they are two:
 *
 *   OUTBOX  things the DEVICE produced that must reach the relay.  A voice
 *           memo and a moment bookmark differ only in payload size and in
 *           which relay verb delivers them; the durability, the ordering,
 *           the retry, the "drop it only once the relay confirms" rule and
 *           the crash-safe manifest are identical.  One queue, typed items.
 *           ("thought capture" is a voice memo with a different name on it.)
 *
 *   INBOX   things the RELAY produced for the owner that could not be
 *           delivered at the time.  Same durability requirement, opposite
 *           direction, and it must survive with the radio off, so it cannot
 *           share the outbox's delivery machinery.
 *
 * Building three separate mechanisms would have meant three manifests, three
 * retry policies and three ways to be inconsistent after a reset.
 *
 * THE OWNER'S STANDING RULE
 * -------------------------
 * "Only save an audio copy to SD if the chunk upload cannot be uploaded."
 * SD is the failure path, never the default.  This module never causes an
 * extra byte of audio to be written: record_microphone() already journals to
 * SD *only* when there is no live uplink at press time, and this module only
 * decides whether that already-written journal is RENAMED into the queue
 * (upload failed) or left to be truncated by the next press (upload
 * succeeded).  fs_rename moves a directory entry; it copies no audio.
 *
 * RAM
 * ---
 * One manifest struct, a few counters, no buffers.  Audio never enters RAM
 * here; delivery streams straight off the card through the existing
 * pendant_cloud_upload_recording() reader.  Alert text lives on the card and
 * is read into a caller stack frame only while it is being printed.
 */

/* Item kinds carried by the outbox. */
#define PENDANT_STORE_KIND_VOICE 'V' /* deferred voice command (PCM on SD) */
/*
 * 'T' for thought capture — the header above already observed that a
 * thought capture is a voice memo with a different name on it; this is
 * where the name matters. A memo is delivered with the planner
 * deliberately switched off (?dispatch=0 via pendant_cloud's memo mode),
 * and that intent must survive a power cycle with the audio it belongs
 * to: a green-button memo held through a dead zone that redelivered as a
 * KIND_VOICE would wake the Mac planner on words the owner explicitly
 * asked nobody to act on.
 */
#define PENDANT_STORE_KIND_MEMO  'T' /* record-only memo (PCM, no planner) */
/*
 * 'Q' for question — the blue button's push-to-talk capture that finished
 * with no usable link. It is NOT a memo: a memo asked for nobody to act on
 * it, and a question asked for an answer, so this kind redelivers with the
 * planner ON (?dispatch=1), exactly like a deferred voice command.
 *
 * It is also not KIND_VOICE, and the difference is honesty about what the
 * owner gets back. The spoken reply to a PTT question is streamed on the
 * upload socket at the moment of asking; a question delivered hours later
 * has no socket to speak down and nothing on the device is waiting to play
 * it. So the answer lands in the dashboard/history and the device stays
 * quiet — the kind byte is what lets the log, and eventually the relay,
 * say that instead of implying a voice answer that never comes.
 */
#define PENDANT_STORE_KIND_QUESTION 'Q' /* PTT question (PCM, planner on)  */
#define PENDANT_STORE_KIND_MARK  'M' /* moment bookmark (no payload)      */
#define PENDANT_STORE_KIND_ACK   'A' /* "N held alerts were surfaced"     */

#ifdef CONFIG_PENDANT_OFFLINE_STORE

/*
 * Load (or create) the manifest.  Call once after the SD card is mounted and
 * before the first press.  Recovers anything a power cycle interrupted.
 */
void pendant_store_init(void);

/*
 * Take ownership of the PCM journal record_microphone() just wrote, because
 * its upload failed.  Renames it into a queue slot; the journal path is free
 * for the next press afterwards.  Returns 0 when queued.
 */
int pendant_store_enqueue_voice(uint32_t pcm_bytes);

/* Same journal takeover for a record-only memo (green button): identical
 * durability, delivered later with the planner off (KIND_MEMO above). */
int pendant_store_enqueue_memo(uint32_t pcm_bytes);

/* Same journal takeover for a push-to-talk question (blue button): planner
 * ON at redelivery, and no voice reply afterwards (KIND_QUESTION above). */
int pendant_store_enqueue_question(uint32_t pcm_bytes);

/*
 * Drop a moment bookmark: the timestamp the device has (modem NITZ clock
 * when the tower ever gave us one, uptime otherwise) plus the link state at
 * the moment of the press.  Costs one small SD write and no radio.
 */
int pendant_store_enqueue_mark(bool link_up);

/*
 * Deliver at most one queued item.  Call only when the link is known good
 * (an open WebSocket is the proof).  An item is removed ONLY after the relay
 * confirms it.  Returns 1 if an item was delivered, 0 if the queue was
 * empty or delivery is not currently possible, negative on a hard error.
 */
int pendant_store_drain_one(uint32_t voice_sample_rate);

/* Queue depth, for the caller's "is there anything to do while idle" check. */
uint32_t pendant_store_pending(void);

#else /* !CONFIG_PENDANT_OFFLINE_STORE */

static inline void pendant_store_init(void) {}
static inline int pendant_store_enqueue_voice(uint32_t pcm_bytes)
{
	ARG_UNUSED(pcm_bytes);
	return -ENOTSUP;
}
static inline int pendant_store_enqueue_memo(uint32_t pcm_bytes)
{
	ARG_UNUSED(pcm_bytes);
	return -ENOTSUP;
}
static inline int pendant_store_enqueue_question(uint32_t pcm_bytes)
{
	ARG_UNUSED(pcm_bytes);
	return -ENOTSUP;
}
static inline int pendant_store_enqueue_mark(bool link_up)
{
	ARG_UNUSED(link_up);
	return -ENOTSUP;
}
static inline int pendant_store_drain_one(uint32_t voice_sample_rate)
{
	ARG_UNUSED(voice_sample_rate);
	return 0;
}
static inline uint32_t pendant_store_pending(void)
{
	return 0U;
}

#endif /* CONFIG_PENDANT_OFFLINE_STORE */

#if defined(CONFIG_PENDANT_ALERT_INBOX) && defined(CONFIG_PENDANT_OFFLINE_STORE)

/*
 * Pull anything the relay has queued for this device and hold it on the
 * card.  Rate-limited internally, so calling it every idle pass is free.
 * Call only when the link is known good.
 */
void pendant_store_poll_alerts(void);

/* Alerts held on the card, waiting for the owner to interact. */
uint32_t pendant_store_inbox_pending(void);

/*
 * Surface every held alert to the owner and clear the inbox.  Works with the
 * radio off — this reads the card, nothing else.  The acknowledgement to the
 * relay is itself queued in the outbox, so it too survives being offline.
 */
void pendant_store_surface_inbox(void);

#else

static inline void pendant_store_poll_alerts(void) {}
static inline uint32_t pendant_store_inbox_pending(void)
{
	return 0U;
}
static inline void pendant_store_surface_inbox(void) {}

#endif /* CONFIG_PENDANT_ALERT_INBOX */

/*
 * Counters appended to the existing "Conversation stats:" line.  The offline
 * path is exactly the path where no conversation ever happens, so these are
 * also printed on their own by pendant_store_print_stats() whenever the
 * queue changes — a counter that is only visible after a successful
 * conversation cannot describe a device that could not have one.
 */
#ifdef CONFIG_PENDANT_OFFLINE_STORE
void pendant_store_print_stats(const char *reason);

extern volatile uint32_t pendant_store_queued;    /* items queued ever      */
extern volatile uint32_t pendant_store_forwarded; /* items relay confirmed  */
extern volatile uint32_t pendant_store_marks;     /* bookmarks dropped      */
extern volatile uint32_t pendant_store_alerts_held;
extern volatile uint32_t pendant_store_alerts_shown;

#define PENDANT_STORE_STATS_FMT                                              \
	" ob_pending=%u ob_queued=%u ob_sent=%u marks=%u inbox=%u"           \
	" alerts_shown=%u"
#define PENDANT_STORE_STATS_ARGS                                             \
	, pendant_store_pending(), pendant_store_queued,                     \
		pendant_store_forwarded, pendant_store_marks,                \
		pendant_store_inbox_pending(), pendant_store_alerts_shown
#else
static inline void pendant_store_print_stats(const char *reason)
{
	ARG_UNUSED(reason);
}
#define PENDANT_STORE_STATS_FMT ""
#define PENDANT_STORE_STATS_ARGS
#endif

#endif /* PENDANT_STORE_H_ */

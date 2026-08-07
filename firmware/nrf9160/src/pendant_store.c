/*
 * Offline store-and-forward: the outbox and the alert inbox.
 * Rationale, the two-mechanisms argument and the SD-is-the-failure-path rule
 * are all in pendant_store.h; this file is the mechanism.
 */
#include <errno.h>
#include <stdio.h>
#include <string.h>

#include <zephyr/fs/fs.h>
#include <zephyr/kernel.h>
#include <zephyr/sys/printk.h>
#include <zephyr/sys/util.h>

#include "pendant_cloud.h"
#include "pendant_store.h"

#ifdef CONFIG_PENDANT_OFFLINE_STORE

#define STORE_MOUNT "/SD:"
#define STORE_MANIFEST STORE_MOUNT "/outbox.idx"
#define STORE_INBOX STORE_MOUNT "/inbox.jsn"
/* Journal record_microphone() writes when there was no live uplink at press. */
#define STORE_JOURNAL STORE_MOUNT "/latest.pcm"

#define STORE_MAGIC 0x4F425831U /* "OBX1" */
#define STORE_SLOTS CONFIG_PENDANT_OFFLINE_STORE_SLOTS
/*
 * A slot that has failed this many deliveries is dropped.  Without a ceiling
 * one permanently unacceptable item (a truncated journal the relay always
 * rejects with 400) would block every later item behind it forever — the
 * queue would be durable and useless at the same time.
 */
#define STORE_MAX_TRIES 5U

#define STORE_TAG_SIZE 32U
#define STORE_INBOX_MAX 16U
#define STORE_INBOX_TEXT_MAX 160U
/* Cheapest possible rate limit: the relay is polled at most this often. */
#define STORE_ALERT_POLL_MS 60000

struct store_slot {
	uint32_t seq;      /* 0 = empty slot                                */
	uint32_t bytes;    /* voice: PCM bytes.  ack: alerts surfaced.      */
	uint32_t uptime_s; /* device uptime at capture — always available   */
	char tag[STORE_TAG_SIZE]; /* voice/mark: NITZ time.  ack: last id.  */
	uint8_t kind;
	uint8_t tries;
	uint8_t link_up; /* link state observed at capture (context)        */
	uint8_t pad;
};

/*
 * The whole persistent state is this one struct, rewritten atomically-enough
 * (small, single 512 B sector) on every change.  A directory scan was the
 * obvious alternative and is the wrong one here: struct fs_dirent carries a
 * 256 B LFN name field (CONFIG_FS_FATFS_MAX_LFN=255), so readdir would cost
 * more stack per call than this costs in RAM for the entire queue.
 */
struct store_manifest {
	uint32_t magic;
	uint32_t next_seq;
	struct store_slot slots[STORE_SLOTS];
	uint32_t inbox_count;
	char inbox_last_id[STORE_TAG_SIZE];
	uint32_t checksum;
};

static struct store_manifest store;
static bool store_loaded;
static int64_t alert_next_poll_ms;

volatile uint32_t pendant_store_queued;
volatile uint32_t pendant_store_forwarded;
volatile uint32_t pendant_store_marks;
volatile uint32_t pendant_store_alerts_held;
volatile uint32_t pendant_store_alerts_shown;

static uint32_t store_checksum(const struct store_manifest *manifest)
{
	const uint32_t *words = (const uint32_t *)manifest;
	size_t count = (offsetof(struct store_manifest, checksum)) /
		       sizeof(uint32_t);
	uint32_t sum = 0x5A5A5A5AU;

	for (size_t index = 0U; index < count; ++index) {
		sum = (sum << 1) ^ words[index];
	}
	return sum;
}

static void store_slot_path(const struct store_slot *slot, char *out,
			    size_t out_size)
{
	(void)snprintf(out, out_size, STORE_MOUNT "/ob%u.pcm",
		       (unsigned int)(slot - store.slots));
}

static int store_save(void)
{
	struct fs_file_t file;
	int error;

	store.checksum = store_checksum(&store);
	fs_file_t_init(&file);
	error = fs_open(&file, STORE_MANIFEST,
			FS_O_CREATE | FS_O_WRITE | FS_O_TRUNC);
	if (error != 0) {
		printk("Store manifest open failed: %d\n", error);
		return error;
	}
	if (fs_write(&file, &store, sizeof(store)) != (ssize_t)sizeof(store)) {
		error = -EIO;
	}
	if (error == 0) {
		error = fs_sync(&file);
	}
	(void)fs_close(&file);
	if (error != 0) {
		printk("Store manifest write failed: %d\n", error);
	}
	return error;
}

uint32_t pendant_store_pending(void)
{
	uint32_t pending = 0U;

	for (size_t index = 0U; index < STORE_SLOTS; ++index) {
		if (store.slots[index].seq != 0U) {
			++pending;
		}
	}
	return pending;
}

void pendant_store_print_stats(const char *reason)
{
	printk("Store stats: %s pending=%u queued=%u sent=%u marks=%u "
	       "inbox=%u alerts_held=%u alerts_shown=%u\n",
	       reason, pendant_store_pending(), pendant_store_queued,
	       pendant_store_forwarded, pendant_store_marks,
	       store.inbox_count, pendant_store_alerts_held,
	       pendant_store_alerts_shown);
}

void pendant_store_init(void)
{
	struct fs_file_t file;
	int error;

	memset(&store, 0, sizeof(store));
	store.magic = STORE_MAGIC;
	store.next_seq = 1U;

	fs_file_t_init(&file);
	error = fs_open(&file, STORE_MANIFEST, FS_O_READ);
	if (error == 0) {
		struct store_manifest loaded;
		ssize_t read_bytes = fs_read(&file, &loaded, sizeof(loaded));

		(void)fs_close(&file);
		if (read_bytes == (ssize_t)sizeof(loaded) &&
		    loaded.magic == STORE_MAGIC &&
		    loaded.checksum == store_checksum(&loaded)) {
			store = loaded;
			printk("Store recovered from microSD: pending=%u "
			       "inbox=%u next_seq=%u\n",
			       pendant_store_pending(), store.inbox_count,
			       store.next_seq);
		} else {
			printk("Store manifest unreadable (%d B) — starting "
			       "a fresh queue\n",
			       (int)read_bytes);
		}
	}
	store_loaded = true;
	/*
	 * A pending slot whose payload file vanished (card swapped, FAT
	 * repair) would retry forever against a missing file.  Reconcile
	 * once, here, where it is cheap.
	 */
	for (size_t index = 0U; index < STORE_SLOTS; ++index) {
		struct store_slot *slot = &store.slots[index];
		struct fs_dirent entry;
		char path[32];

		if (slot->seq == 0U || slot->kind != PENDANT_STORE_KIND_VOICE) {
			continue;
		}
		store_slot_path(slot, path, sizeof(path));
		if (fs_stat(path, &entry) != 0 || entry.size == 0U) {
			printk("Store slot %u lost its payload — dropping\n",
			       (unsigned int)index);
			memset(slot, 0, sizeof(*slot));
		}
	}
	(void)store_save();
	pendant_store_print_stats("boot");
}

static struct store_slot *store_free_slot(void)
{
	for (size_t index = 0U; index < STORE_SLOTS; ++index) {
		if (store.slots[index].seq == 0U) {
			return &store.slots[index];
		}
	}
	return NULL;
}

/* Oldest first: an outbox that reorders the owner's day is not a record. */
static struct store_slot *store_oldest_slot(void)
{
	struct store_slot *oldest = NULL;

	for (size_t index = 0U; index < STORE_SLOTS; ++index) {
		struct store_slot *slot = &store.slots[index];

		if (slot->seq == 0U) {
			continue;
		}
		if (oldest == NULL || slot->seq < oldest->seq) {
			oldest = slot;
		}
	}
	return oldest;
}

static void store_fill_when(struct store_slot *slot)
{
	char when[STORE_TAG_SIZE];

	/*
	 * NITZ time from the tower is the only wall clock this device has,
	 * and it is exactly the clock that is missing when the radio is off.
	 * The modem keeps its last acquired value, so a bookmark dropped in a
	 * basement still carries a plausible timestamp; uptime_s is stored
	 * unconditionally so the relay can always order items even when the
	 * string is empty or stale.
	 */
	pendant_cloud_copy_device_time(when, sizeof(when));
	when[sizeof(when) - 1U] = '\0';
	strncpy(slot->tag, when, sizeof(slot->tag) - 1U);
	slot->tag[sizeof(slot->tag) - 1U] = '\0';
	slot->uptime_s = (uint32_t)(k_uptime_get() / 1000);
}

int pendant_store_enqueue_voice(uint32_t pcm_bytes)
{
	struct store_slot *slot;
	struct fs_dirent entry;
	char path[32];
	int error;

	if (!store_loaded || pcm_bytes == 0U) {
		return -EINVAL;
	}
	if (fs_stat(STORE_JOURNAL, &entry) != 0 || entry.size == 0U) {
		/* Nothing was journalled — the live uplink had it. */
		return -ENOENT;
	}

	slot = store_free_slot();
	if (slot == NULL) {
		/*
		 * Full.  Overwrite the OLDEST rather than refusing the new
		 * one: on a worn device the thing just said is worth more
		 * than the thing said an hour ago that the relay has already
		 * refused five times.
		 */
		slot = store_oldest_slot();
		if (slot == NULL) {
			return -ENOSPC;
		}
		store_slot_path(slot, path, sizeof(path));
		(void)fs_unlink(path);
		printk("Outbox full — evicting seq=%u to make room\n",
		       slot->seq);
		memset(slot, 0, sizeof(*slot));
	}

	store_slot_path(slot, path, sizeof(path));
	/* Stat first: fs_unlink on a missing path logs an "E: failed to
	 * unlink" at error level, and an error-level line that means "the
	 * slot was already empty, as expected" trains people to ignore them. */
	if (fs_stat(path, &entry) == 0) {
		(void)fs_unlink(path);
	}
	error = fs_rename(STORE_JOURNAL, path);
	if (error != 0) {
		printk("Outbox rename %s -> %s failed: %d\n", STORE_JOURNAL,
		       path, error);
		return error;
	}

	slot->seq = store.next_seq++;
	slot->kind = PENDANT_STORE_KIND_VOICE;
	slot->bytes = MIN(pcm_bytes, (uint32_t)entry.size);
	slot->tries = 0U;
	slot->link_up = 0U;
	store_fill_when(slot);
	++pendant_store_queued;
	(void)store_save();
	printk("Voice memo held offline: seq=%u bytes=%u file=%s when=%s\n",
	       slot->seq, slot->bytes, path,
	       slot->tag[0] != '\0' ? slot->tag : "(no NITZ clock)");
	pendant_store_print_stats("voice_queued");
	return 0;
}

int pendant_store_enqueue_mark(bool link_up)
{
	struct store_slot *slot;

	if (!store_loaded) {
		return -EINVAL;
	}
	slot = store_free_slot();
	if (slot == NULL) {
		slot = store_oldest_slot();
		if (slot == NULL) {
			return -ENOSPC;
		}
		if (slot->kind == PENDANT_STORE_KIND_VOICE) {
			char path[32];

			store_slot_path(slot, path, sizeof(path));
			(void)fs_unlink(path);
		}
		printk("Outbox full — evicting seq=%u for a bookmark\n",
		       slot->seq);
		memset(slot, 0, sizeof(*slot));
	}

	slot->seq = store.next_seq++;
	slot->kind = PENDANT_STORE_KIND_MARK;
	slot->bytes = 0U;
	slot->tries = 0U;
	slot->link_up = link_up ? 1U : 0U;
	store_fill_when(slot);
	++pendant_store_queued;
	++pendant_store_marks;
	(void)store_save();
	printk("Bookmark dropped: seq=%u when=%s uptime=%us link=%d\n",
	       slot->seq, slot->tag[0] != '\0' ? slot->tag : "(no NITZ clock)",
	       slot->uptime_s, link_up ? 1 : 0);
	pendant_store_print_stats("mark_queued");
	return 0;
}

static int store_enqueue_ack(const char *last_id, uint32_t count)
{
	struct store_slot *slot = store_free_slot();

	if (slot == NULL) {
		/* An ack is the least valuable item here — drop it, never a
		 * voice memo, and let the relay's own TTL age the alert. */
		return -ENOSPC;
	}
	slot->seq = store.next_seq++;
	slot->kind = PENDANT_STORE_KIND_ACK;
	slot->bytes = count;
	slot->tries = 0U;
	slot->link_up = 0U;
	slot->uptime_s = (uint32_t)(k_uptime_get() / 1000);
	strncpy(slot->tag, last_id, sizeof(slot->tag) - 1U);
	slot->tag[sizeof(slot->tag) - 1U] = '\0';
	++pendant_store_queued;
	return 0;
}

static void store_release(struct store_slot *slot, const char *why)
{
	char path[32];

	if (slot->kind == PENDANT_STORE_KIND_VOICE) {
		store_slot_path(slot, path, sizeof(path));
		if (fs_unlink(path) != 0) {
			printk("Outbox unlink %s failed\n", path);
		}
	}
	printk("Outbox seq=%u kind=%c released (%s)\n", slot->seq, slot->kind,
	       why);
	memset(slot, 0, sizeof(*slot));
	(void)store_save();
}

int pendant_store_drain_one(uint32_t voice_sample_rate)
{
	struct store_slot *slot = store_oldest_slot();
	char detail[128];
	int error;

	if (!store_loaded || slot == NULL) {
		return 0;
	}

	switch (slot->kind) {
	case PENDANT_STORE_KIND_VOICE: {
		char path[32];

		store_slot_path(slot, path, sizeof(path));
		printk("Forwarding held voice memo seq=%u (%u B) from %s\n",
		       slot->seq, slot->bytes, path);
		/*
		 * Streams straight off the card through the existing
		 * single-shot reader — no staging buffer, so a 30 s memo
		 * costs the same RAM as a 1 s one.
		 */
		error = pendant_cloud_upload_recording(path, slot->bytes,
						      voice_sample_rate);
		break;
	}
	case PENDANT_STORE_KIND_MARK:
		(void)snprintf(detail, sizeof(detail),
			       "Moment bookmark held on the pendant. "
			       "captured_at=%s uptime_s=%u link_at_capture=%s",
			       slot->tag[0] != '\0' ? slot->tag : "unknown",
			       slot->uptime_s,
			       slot->link_up ? "up" : "down");
		error = pendant_cloud_post_marker("bookmark", "Moment bookmark",
						 detail);
		break;
	case PENDANT_STORE_KIND_ACK:
		(void)snprintf(detail, sizeof(detail),
			       "Pendant surfaced %u held alert(s) to the "
			       "owner. last_alert_id=%s uptime_s=%u",
			       slot->bytes,
			       slot->tag[0] != '\0' ? slot->tag : "unknown",
			       slot->uptime_s);
		error = pendant_cloud_post_marker("alert_delivered",
						 "Held alerts surfaced",
						 detail);
		break;
	default:
		store_release(slot, "unknown kind");
		return 0;
	}

	/*
	 * "Confirmed" means THE RELAY HAS THE BYTES, not "the whole pipeline
	 * liked them".  A 2xx with no Mac job (upload_recording returns
	 * -ENOTCONN for that) means a 30 s memo of room tone transcribed to
	 * nothing — the relay received it, stored it, and had nothing to
	 * dispatch.  Retrying that pushes the same half-megabyte up a Cat-M1
	 * uplink four more times to reach the same conclusion, and every one
	 * of those retries delays the item behind it.  Transport failures,
	 * where the relay genuinely never saw the audio, still retry.
	 *
	 * Scoped to voice deliberately: for a voice item the audio POST is the
	 * LAST request in the sequence, so a 2xx really does describe the
	 * audio.  A marker makes two requests, and a 2xx left over from the
	 * first would claim delivery the second never achieved.
	 */
	bool relay_has_it = error == 0 ||
			    (slot->kind == PENDANT_STORE_KIND_VOICE &&
			     pendant_cloud_last_http_status >= 200 &&
			     pendant_cloud_last_http_status < 300);

	if (relay_has_it) {
		++pendant_store_forwarded;
		store_release(slot, error == 0 ? "relay confirmed"
					       : "relay accepted (no dispatch)");
		pendant_store_print_stats("forwarded");
		return 1;
	}

	/*
	 * THE RULE: nothing leaves the card until the relay confirms it.  A
	 * failed attempt only burns a try.
	 */
	++slot->tries;
	printk("Outbox seq=%u delivery failed: %d (try %u/%u)\n", slot->seq,
	       error, slot->tries, STORE_MAX_TRIES);
	if (slot->tries >= STORE_MAX_TRIES) {
		store_release(slot, "retry budget exhausted");
	} else {
		(void)store_save();
	}
	return error;
}

#ifdef CONFIG_PENDANT_ALERT_INBOX

/*
 * Minimal JSON string-field reader.  A full parser is not worth 6 kB of
 * flash for a document whose shape this firmware and the relay both control:
 * {"ok":true,"state":{...,"data":{"alerts":[{"id":"…","text":"…"}]}}}.
 * Returns the character after the closing quote, or NULL.
 */
static const char *json_string_field(const char *cursor, const char *key,
				     char *out, size_t out_size)
{
	char pattern[24];
	const char *found;
	size_t length = 0U;

	(void)snprintf(pattern, sizeof(pattern), "\"%s\":\"", key);
	found = strstr(cursor, pattern);
	if (found == NULL) {
		return NULL;
	}
	found += strlen(pattern);
	while (*found != '\0' && *found != '"') {
		if (*found == '\\' && found[1] != '\0') {
			++found; /* keep the escaped char, drop the escape */
		}
		if (length + 1U < out_size) {
			out[length++] = *found;
		}
		++found;
	}
	out[length] = '\0';
	return *found == '"' ? found + 1 : NULL;
}

static int inbox_append(const char *id, const char *text)
{
	struct fs_file_t file;
	char line[STORE_INBOX_TEXT_MAX + STORE_TAG_SIZE + 4U];
	int length;
	int error;

	length = snprintf(line, sizeof(line), "%s\t%s\n", id, text);
	if (length < 0) {
		return -EOVERFLOW;
	}
	if ((size_t)length >= sizeof(line)) {
		length = (int)sizeof(line) - 1;
		line[length - 1] = '\n';
	}
	fs_file_t_init(&file);
	error = fs_open(&file, STORE_INBOX,
			FS_O_CREATE | FS_O_WRITE | FS_O_APPEND);
	if (error != 0) {
		return error;
	}
	if (fs_write(&file, line, (size_t)length) != (ssize_t)length) {
		error = -EIO;
	}
	if (error == 0) {
		error = fs_sync(&file);
	}
	(void)fs_close(&file);
	return error;
}

void pendant_store_poll_alerts(void)
{
	const char *body;
	const char *cursor;
	char id[STORE_TAG_SIZE];
	char text[STORE_INBOX_TEXT_MAX];
	char newest[STORE_TAG_SIZE];
	bool skipping;
	uint32_t added = 0U;

	if (!store_loaded) {
		return;
	}
	if (alert_next_poll_ms != 0 && k_uptime_get() < alert_next_poll_ms) {
		return;
	}
	alert_next_poll_ms = k_uptime_get() + STORE_ALERT_POLL_MS;

	if (pendant_cloud_get_json(CONFIG_PENDANT_ALERT_STATE_PATH) != 0) {
		return;
	}
	body = pendant_cloud_response_body();
	if (body == NULL) {
		return;
	}
	cursor = strstr(body, "\"alerts\"");
	if (cursor == NULL) {
		return;
	}

	/*
	 * Cursor semantics, not set semantics: remember the last id seen and
	 * take everything after it.  If the remembered id is no longer in the
	 * array (the publisher trimmed it) every entry is new, which is the
	 * safe direction to be wrong in — a repeated alert is noise, a
	 * dropped one is the failure this whole feature exists to prevent.
	 */
	skipping = store.inbox_last_id[0] != '\0' &&
		   strstr(cursor, store.inbox_last_id) != NULL;
	newest[0] = '\0';

	while (added < STORE_INBOX_MAX &&
	       store.inbox_count < STORE_INBOX_MAX) {
		const char *after = json_string_field(cursor, "id", id,
						      sizeof(id));

		if (after == NULL) {
			break;
		}
		cursor = after;
		if (json_string_field(cursor, "text", text, sizeof(text)) ==
		    NULL) {
			text[0] = '\0';
		}
		strncpy(newest, id, sizeof(newest) - 1U);
		newest[sizeof(newest) - 1U] = '\0';

		if (skipping) {
			if (strcmp(id, store.inbox_last_id) == 0) {
				skipping = false;
			}
			continue;
		}
		if (inbox_append(id, text) == 0) {
			++store.inbox_count;
			++added;
			++pendant_store_alerts_held;
			printk("Alert held on pendant: id=%s text=%s\n", id,
			       text);
		}
	}

	if (newest[0] != '\0') {
		strncpy(store.inbox_last_id, newest,
			sizeof(store.inbox_last_id) - 1U);
		store.inbox_last_id[sizeof(store.inbox_last_id) - 1U] = '\0';
	}
	if (added > 0U) {
		(void)store_save();
		pendant_store_print_stats("alerts_held");
	} else if (newest[0] != '\0') {
		(void)store_save();
	}
}

uint32_t pendant_store_inbox_pending(void)
{
	return store.inbox_count;
}

void pendant_store_surface_inbox(void)
{
	struct fs_file_t file;
	char line[STORE_INBOX_TEXT_MAX + STORE_TAG_SIZE + 4U];
	size_t length = 0U;
	uint32_t shown = 0U;
	char last_id[STORE_TAG_SIZE];

	if (!store_loaded || store.inbox_count == 0U) {
		return;
	}
	last_id[0] = '\0';
	strncpy(last_id, store.inbox_last_id, sizeof(last_id) - 1U);
	last_id[sizeof(last_id) - 1U] = '\0';

	printk("=== %u alert(s) arrived while you were away ===\n",
	       store.inbox_count);
	fs_file_t_init(&file);
	if (fs_open(&file, STORE_INBOX, FS_O_READ) == 0) {
		/* One byte at a time: this runs once per interaction on a
		 * file of a few hundred bytes, and it costs no buffer. */
		for (;;) {
			char byte;
			ssize_t got = fs_read(&file, &byte, 1U);

			if (got != 1) {
				break;
			}
			if (byte == '\n' || length + 1U >= sizeof(line)) {
				line[length] = '\0';
				if (length > 0U) {
					printk("  [%u] %s\n", ++shown, line);
				}
				length = 0U;
				continue;
			}
			line[length++] = byte;
		}
		if (length > 0U) {
			line[length] = '\0';
			printk("  [%u] %s\n", ++shown, line);
		}
		(void)fs_close(&file);
	}
	printk("=== end of held alerts ===\n");

	pendant_store_alerts_shown += shown;
	store.inbox_count = 0U;
	(void)fs_unlink(STORE_INBOX);
	/*
	 * The acknowledgement goes through the outbox rather than straight
	 * out the radio, because the whole point is that this can happen with
	 * no link: the owner reads their alerts in a basement, and the relay
	 * learns they were read the next time there is signal.
	 */
	if (shown > 0U) {
		(void)store_enqueue_ack(last_id, shown);
	}
	(void)store_save();
	pendant_store_print_stats("alerts_shown");
}

#endif /* CONFIG_PENDANT_ALERT_INBOX */

#endif /* CONFIG_PENDANT_OFFLINE_STORE */
